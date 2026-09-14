#!/usr/bin/env python3
"""
Baut das Filialverzeichnis (data/stores.json) und die Städteliste (data/cities.json) aus OpenStreetMap.

Gebiet: alle Gemeinden im Landkreis Konstanz (weitere Kreise über AGS_PREFIXES ergänzbar).
Jede Gemeinde mit mindestens einer Ketten-Filiale wird eine auf der Website suchbare Stadt.
Sonderfall "singen" (Startseite): Große Kreisstadt Singen (Hohentwiel) mit allen Ortsteilen
– Beuren an der Aach, Bohlingen, Friedingen, Hausen an der Aach, Schlatt unter Krähen,
Überlingen am Ried – plus Rielasingen-Worblingen.

    python scripts/update_stores.py            # neu erzeugen
    python scripts/update_stores.py --dry-run  # nur anzeigen

Einträge mit "manual": true in data/stores.json bleiben immer erhalten – so kann man Filialen
ergänzen, die (noch) nicht in OpenStreetMap stehen. Sie brauchen ein Feld "cities": ["singen", …].
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
import time
from collections import Counter
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STORES_FILE = ROOT / "data" / "stores.json"
CITIES_FILE = ROOT / "data" / "cities.json"

# Amtliche Gemeindeschlüssel-Präfixe der Kreise, deren Gemeinden aufgenommen werden:
# 08335 = Landkreis Konstanz. Weitere z. B. "08327" (Landkreis Tuttlingen), "08435" (Bodenseekreis)
# – dann auch BBOX (süd, west, nord, ost) entsprechend vergrößern.
AGS_PREFIXES = ["08335"]
REGION_NAMES = {"08335": "Landkreis Konstanz"}  # Anzeige im Header ("Energy-Deals · Landkreis Konstanz")
BBOX = (47.60, 8.55, 47.95, 9.30)
# Einzelne Städte außerhalb dieser Kreise (amtlicher Gemeindeschlüssel, egal welche Verwaltungsebene):
# 08111000 = Stuttgart (Stadtkreis)
EXTRA_AGS = ["08111000"]

# Zusammengefasste Städte (zusätzlich zu den einzelnen Gemeinden)
COMBINED_CITIES = {
    "singen": {
        "name": "Singen",
        "label": "Singen (Hohentwiel) mit allen Ortsteilen & Rielasingen-Worblingen",
        "municipalities": ["Singen (Hohentwiel)", "Rielasingen-Worblingen"],
        "default": True,
    },
}
# Gemeinden, die nur als Teil einer zusammengefassten Stadt auftauchen (nicht zusätzlich einzeln)
MERGED_ONLY = {"Singen (Hohentwiel)"}

# Ortsteile von Singen: Filialen bekommen den nächstgelegenen Ortskern in die Adresse ("Singen-Bohlingen").
# Koordinaten werden aus OSM-"place"-Knoten aktualisiert, die Werte hier sind nur der Fallback.
SINGEN_MUNI = "Singen (Hohentwiel)"
SINGEN_PARTS: dict[str, tuple[float, float]] = {
    SINGEN_MUNI: (47.7597, 8.8403),
    "Beuren an der Aach": (47.7997, 8.8756),
    "Bohlingen": (47.7192, 8.8953),
    "Friedingen": (47.7867, 8.8769),
    "Hausen an der Aach": (47.7922, 8.8404),
    "Schlatt unter Krähen": (47.8051, 8.8360),
    "Überlingen am Ried": (47.7382, 8.8971),
}

OVERPASS_ENDPOINTS = [
    "https://overpass-api.de/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]
NOMINATIM = "https://nominatim.openstreetmap.org/reverse"
USER_AGENT = "monster-deals-singen/1.0 (+https://github.com/D0ani/monster; Filialverzeichnis)"

# Muss zu CHAIN_ALIASES in update_deals.py passen (gleiche kanonischen Namen). Reihenfolge zählt:
# "Getränke Müller" muss vor der Drogerie "Müller" stehen.
CHAIN_PATTERNS: list[tuple[str, str]] = [
    (r"\baldi\b", "Aldi Süd"),
    (r"\bnahkauf\b", "Nahkauf"),
    (r"\bedeka\b|\be[- ]?center\b", "Edeka"),
    (r"\brewe\b", "Rewe"),
    (r"\blidl\b", "Lidl"),
    (r"\bkaufland\b", "Kaufland"),
    (r"\bnetto\b", "Netto"),
    (r"\bpenny\b", "Penny"),
    (r"\bnorma\b", "Norma"),
    (r"\bglobus\b", "Globus"),
    (r"\btegut\b", "tegut"),
    (r"\bmarktkauf\b", "Marktkauf"),
    (r"\btrinkgut\b", "Trinkgut"),
    (r"\bfristo\b", "Fristo"),
    (r"getr(ä|ae)nke hoffmann", "Getränke Hoffmann"),
    (r"getr(ä|ae)nke m(ü|ue)ller", "Getränke Müller"),
    (r"\brossmann\b", "Rossmann"),
    (r"(^|\s)dm(\s|-|$)|\bdm-drogerie", "dm"),
    (r"\bm(ü|ue)ller\b", "Müller"),
]
# Ketten, die als Getränkemarkt/Drogerie/Kaufhaus (statt shop=supermarket) übernommen werden
NON_FOOD_OK = {"Trinkgut", "Fristo", "Getränke Hoffmann", "Getränke Müller", "Rossmann", "dm", "Müller"}

log = logging.getLogger("stores")


def chain_for(tags: dict) -> str | None:
    text = f"{tags.get('brand', '')} {tags.get('name', '')}".lower().strip()
    for pattern, chain in CHAIN_PATTERNS:
        if re.search(pattern, text):
            return chain
    return None


def slug(text: str) -> str:
    text = text.lower().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def short_name(municipality: str) -> str:
    return re.sub(r"\s*\(.*\)$", "", municipality).strip()


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111.2, (a[1] - b[1]) * 111.2 * math.cos(lat))


def overpass(session: requests.Session, query: str) -> list[dict]:
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                r = session.post(endpoint, data={"data": query}, timeout=360)
                r.raise_for_status()
                return r.json()["elements"]
            except Exception as exc:  # noqa: BLE001 – nächster Versuch/Mirror
                last_error = exc
                log.warning("Overpass %s (Versuch %d) fehlgeschlagen: %s", endpoint, attempt + 1, exc)
                time.sleep(5)
    raise RuntimeError(f"Alle Overpass-Endpunkte fehlgeschlagen: {last_error}")


def fetch_municipalities(session: requests.Session) -> dict[str, dict]:
    """Alle Gemeinden der Kreise mit ihren Läden und Orts-Knoten – in einer einzigen Overpass-Abfrage."""
    s, w, n, e = BBOX
    extra = (f'rel["boundary"="administrative"]["de:amtlicher_gemeindeschluessel"~"^({"|".join(EXTRA_AGS)})$"];'
             if EXTRA_AGS else "")
    query = f"""
    [out:json][timeout:300];
    (
      rel["boundary"="administrative"]["admin_level"="8"]["de:amtlicher_gemeindeschluessel"~"^({'|'.join(AGS_PREFIXES)})"]({s},{w},{n},{e});
      {extra}
    );
    map_to_area -> .areas;
    foreach.areas -> .a (
      .a out tags;
      (
        nwr["shop"~"^(supermarket|beverages|chemist|department_store)$"](area.a);
        node["place"~"^(city|town|village|suburb|hamlet)$"](area.a);
      );
      out center tags;
    );
    """
    municipalities: dict[str, dict] = {}
    current = None
    for el in overpass(session, query):
        tags = el.get("tags", {})
        if el["type"] == "area":
            # Stadtkreise wie Stuttgart können als Kreis- und Gemeindegrenze doppelt auftauchen → zusammenführen
            current = municipalities.setdefault(tags.get("name", f"area-{el['id']}"),
                                                {"shops": [], "places": [], "seen": set(),
                                                 "ags": tags.get("de:amtlicher_gemeindeschluessel", "")})
        elif current is not None and (el["type"], el["id"]) not in current["seen"]:
            current["seen"].add((el["type"], el["id"]))
            (current["places"] if "place" in tags else current["shops"]).append(el)
    return municipalities


def reverse_geocode(session: requests.Session, lat: float, lon: float) -> dict:
    r = session.get(NOMINATIM, params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18,
                                       "addressdetails": 1}, timeout=30)
    r.raise_for_status()
    time.sleep(1.1)  # Nominatim-Nutzungsrichtlinie: max. 1 Anfrage/Sekunde
    return r.json().get("address", {})


def coords(el: dict) -> tuple[float, float]:
    return (el.get("lat") or el.get("center", {}).get("lat"), el.get("lon") or el.get("center", {}).get("lon"))


def build_store(session: requests.Session, el: dict, municipality: str,
                singen_parts: dict[str, tuple[float, float]]) -> dict | None:
    tags = el.get("tags", {})
    chain = chain_for(tags)
    if not chain:
        return None
    # z. B. "Nahkauf Getränkemarkt" nicht als zweite Nahkauf-Filiale zählen
    if tags.get("shop") in {"beverages", "chemist", "department_store"} and chain not in NON_FOOD_OK:
        return None
    lat, lon = coords(el)
    street, number, postcode = tags.get("addr:street"), tags.get("addr:housenumber"), tags.get("addr:postcode")
    approx = False
    if not street or not postcode:
        try:
            addr = reverse_geocode(session, lat, lon)
            street = street or addr.get("road")
            number = number or addr.get("house_number")
            postcode = postcode or addr.get("postcode")
            approx = True
        except Exception as exc:  # noqa: BLE001
            log.warning("Reverse-Geocoding für %s fehlgeschlagen: %s", tags.get("name"), exc)
    town = municipality
    if municipality == SINGEN_MUNI:  # Ortsteil in die Adresse: "Singen-Bohlingen"
        nearest = min(singen_parts, key=lambda p: distance_km(singen_parts[p], (lat, lon)))
        town = SINGEN_MUNI if nearest == SINGEN_MUNI else f"Singen-{nearest}"
    name = tags.get("name") or chain
    # "Edeka Münchow Rielasingen" behalten, generisches "REWE" → "Rewe Forststraße"
    generic = slug(name) in {slug(chain), slug(tags.get("brand", "")), slug(chain.split()[0]), "drogerie-mueller"}
    store_name = f"{chain} {street}" if generic and street else name
    address = f"{street or ''} {number or ''}".strip() + f", {postcode or ''} {town}".replace(",  ", ", ")
    return {
        "id": slug(f"{chain}-{street or name}-{number or ''}-{short_name(municipality)}"),
        "chain": chain,
        "name": store_name,
        "address": address,
        "municipality": municipality,
        "cities": [],
        "lat": round(lat, 6),
        "lon": round(lon, 6),
        "postcode": postcode,
        "addressApprox": approx,
        "osm": f"{el['type']}/{el['id']}",
    }


def city_record(slug_: str, name: str, label: str, stores: list[dict], places: list[dict], region: str,
                default: bool = False) -> dict:
    zips = [z for z, _ in Counter(s["postcode"] for s in stores if re.fullmatch(r"\d{5}", s.get("postcode") or "")).most_common(3)]
    center = next(((p["lat"], p["lon"]) for p in places
                   if p.get("tags", {}).get("name") in (name, label) and p["tags"].get("place") in ("city", "town", "village")),
                  None)
    if center is None:
        center = (sum(s["lat"] for s in stores) / len(stores), sum(s["lon"] for s in stores) / len(stores))
    aliases = sorted({p["tags"]["name"] for p in places if p.get("tags", {}).get("name")} - {name, label})
    record = {"slug": slug_, "name": name, "label": label, "region": region, "zips": zips,
              "lat": round(center[0], 5), "lon": round(center[1], 5), "stores": len(stores), "aliases": aliases}
    if default:
        record["default"] = True
    return record


def build(session: requests.Session) -> tuple[list[dict], list[dict]]:
    municipalities = fetch_municipalities(session)
    log.info("%d Gemeinden gefunden", len(municipalities))

    singen_parts = dict(SINGEN_PARTS)
    for place in municipalities.get(SINGEN_MUNI, {}).get("places", []):
        if place.get("tags", {}).get("name") in singen_parts:
            singen_parts[place["tags"]["name"]] = (place["lat"], place["lon"])

    stores_by_muni: dict[str, list[dict]] = {}
    for municipality, data in sorted(municipalities.items()):
        built = [s for el in data["shops"] if (s := build_store(session, el, municipality, singen_parts))]
        if built:
            stores_by_muni[municipality] = built
            log.info("  %-32s %3d Filialen", municipality, len(built))

    cities: list[dict] = []
    for slug_, cfg in COMBINED_CITIES.items():
        members = [s for m in cfg["municipalities"] for s in stores_by_muni.get(m, [])]
        places = [p for m in cfg["municipalities"] for p in municipalities.get(m, {}).get("places", [])]
        if not members:
            continue
        for store in members:
            store["cities"].append(slug_)
        record = city_record(slug_, cfg["name"], cfg["label"], members, places,
                             cfg.get("region", "Landkreis Konstanz"), cfg.get("default", False))
        record["aliases"] = sorted(set(record["aliases"]) | set(cfg["municipalities"]))
        cities.append(record)
    for municipality, members in stores_by_muni.items():
        if municipality in MERGED_ONLY:
            continue
        slug_ = slug(short_name(municipality))
        for store in members:
            store["cities"].append(slug_)
        ags = municipalities[municipality]["ags"]
        region = next((REGION_NAMES.get(p, "") for p in AGS_PREFIXES if ags.startswith(p)), "") or short_name(municipality)
        cities.append(city_record(slug_, short_name(municipality), municipality, members,
                                  municipalities[municipality]["places"], region))

    stores = [s for members in stores_by_muni.values() for s in members if s["cities"]]
    seen: set[str] = set()
    for store in stores:  # IDs eindeutig machen
        if store["id"] in seen:
            store["id"] += "-" + store["osm"].split("/")[1]
        seen.add(store["id"])
    cities.sort(key=lambda c: (not c.get("default"), slug(c["name"])))
    return stores, cities


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="nichts schreiben, nur ausgeben")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    session = requests.Session()
    session.headers["User-Agent"] = USER_AGENT
    fresh, cities = build(session)

    manual = []
    if STORES_FILE.exists():
        manual = [s for s in json.loads(STORES_FILE.read_text(encoding="utf-8")) if s.get("manual")]
    for store in manual:
        store.setdefault("cities", ["singen"])
    known = {s["id"] for s in manual}
    stores = manual + [s for s in fresh if s["id"] not in known]
    stores.sort(key=lambda s: (s["cities"][0], s["chain"].lower(), s["name"].lower()))

    for city in cities:
        log.info("%-24s %3d Filialen · PLZ %s", city["name"], city["stores"], ", ".join(city["zips"]) or "–")
    singen = [s for s in stores if "singen" in s["cities"]]
    for s in singen:
        log.info("  singen: %-18s %-34s %s", s["chain"], s["name"], s["address"])
    log.info("%d Filialen (%d manuell) in %d Städten", len(stores), len(manual), len(cities))
    if not args.dry_run:
        STORES_FILE.parent.mkdir(parents=True, exist_ok=True)
        STORES_FILE.write_text(json.dumps(stores, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        CITIES_FILE.write_text(json.dumps(cities, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log.info("geschrieben: %s, %s", STORES_FILE.relative_to(ROOT), CITIES_FILE.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
