#!/usr/bin/env python3
"""
Baut das Filialverzeichnis data/stores.json aus OpenStreetMap neu auf.

Gebiet: die Große Kreisstadt Singen (Hohentwiel) mit allen Ortsteilen – Beuren an der Aach,
Bohlingen, Friedingen, Hausen an der Aach, Schlatt unter Krähen, Überlingen am Ried – sowie
Rielasingen-Worblingen.

Das Verzeichnis wird von update_deals.py benutzt, um Ketten-Angebote aus den Prospekten (die für
eine ganze Region gelten) den einzelnen Filialen zuzuordnen (Adresse + Koordinaten für die Karte).

    python scripts/update_stores.py            # neu erzeugen
    python scripts/update_stores.py --dry-run  # nur anzeigen

Einträge mit "manual": true in data/stores.json bleiben immer erhalten –
so kann man Filialen ergänzen, die (noch) nicht in OpenStreetMap stehen.
"""
from __future__ import annotations

import argparse
import json
import logging
import math
import re
import sys
import time
from pathlib import Path

import requests

ROOT = Path(__file__).resolve().parent.parent
STORES_FILE = ROOT / "data" / "stores.json"

# Bewusst großzügige Box um Singen samt Ortsteilen und Rielasingen-Worblingen (süd, west, nord, ost).
# Exakt eingegrenzt wird danach über die Postleitzahl – Nachbargemeinden haben andere PLZ.
BBOX = (47.705, 8.765, 47.825, 8.955)
ALLOWED_POSTCODES = {"78224", "78239"}
CITY_BY_POSTCODE = {"78224": "Singen (Hohentwiel)", "78239": "Rielasingen-Worblingen"}

# Ortskerne von Singen (alle PLZ 78224). Werden per OSM-"place"-Knoten aktualisiert,
# die Koordinaten hier sind nur der Fallback. Jede Filiale bekommt den nächstgelegenen Ortskern.
SINGEN_CORE = "Singen (Hohentwiel)"
SINGEN_PARTS: dict[str, tuple[float, float]] = {
    SINGEN_CORE: (47.7597, 8.8403),
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
USER_AGENT = "monster-deals-singen/1.0 (+https://github.com/; Filialverzeichnis)"

# Muss zu CHAIN_ALIASES in update_deals.py passen (gleiche kanonischen Namen).
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
]
# Ketten, die als Getränkemarkt/Drogerie (statt shop=supermarket) übernommen werden
NON_FOOD_OK = {"Trinkgut", "Fristo", "Getränke Hoffmann", "Getränke Müller", "Rossmann"}

log = logging.getLogger("stores")


def chain_for(tags: dict) -> str | None:
    text = f"{tags.get('brand', '')} {tags.get('name', '')}".lower()
    for pattern, chain in CHAIN_PATTERNS:
        if re.search(pattern, text):
            return chain
    return None


def overpass(session: requests.Session) -> list[dict]:
    s, w, n, e = BBOX
    place_names = "|".join(re.escape(p) for p in SINGEN_PARTS if p != SINGEN_CORE)
    query = f"""
    [out:json][timeout:60];
    (
      nwr["shop"~"^(supermarket|beverages|chemist|department_store)$"]({s},{w},{n},{e});
      node["place"~"^(village|suburb|hamlet|town)$"]["name"~"^({place_names})$"]({s},{w},{n},{e});
    );
    out center tags;
    """
    last_error: Exception | None = None
    for endpoint in OVERPASS_ENDPOINTS:
        for attempt in range(2):
            try:
                r = session.post(endpoint, data={"data": query}, timeout=90)
                r.raise_for_status()
                return r.json()["elements"]
            except Exception as exc:  # noqa: BLE001 – nächster Mirror
                last_error = exc
                log.warning("Overpass %s (Versuch %d) fehlgeschlagen: %s", endpoint, attempt + 1, exc)
                time.sleep(3)
    raise RuntimeError(f"Alle Overpass-Endpunkte fehlgeschlagen: {last_error}")


def reverse_geocode(session: requests.Session, lat: float, lon: float) -> dict:
    r = session.get(NOMINATIM, params={"lat": lat, "lon": lon, "format": "jsonv2", "zoom": 18,
                                       "addressdetails": 1}, timeout=30)
    r.raise_for_status()
    time.sleep(1.1)  # Nominatim-Nutzungsrichtlinie: max. 1 Anfrage/Sekunde
    return r.json().get("address", {})


def distance_km(a: tuple[float, float], b: tuple[float, float]) -> float:
    lat = math.radians((a[0] + b[0]) / 2)
    return math.hypot((a[0] - b[0]) * 111.2, (a[1] - b[1]) * 111.2 * math.cos(lat))


def city_for(postcode: str, lat: float, lon: float, parts: dict[str, tuple[float, float]]) -> str:
    if postcode != "78224":
        return CITY_BY_POSTCODE[postcode]
    nearest = min(parts, key=lambda name: distance_km(parts[name], (lat, lon)))
    return SINGEN_CORE if nearest == SINGEN_CORE else f"Singen-{nearest}"


def slug(text: str) -> str:
    text = text.lower().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss"}))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def build(session: requests.Session) -> list[dict]:
    elements = overpass(session)
    parts = dict(SINGEN_PARTS)
    for el in elements:
        name = el.get("tags", {}).get("name")
        if "place" in el.get("tags", {}) and name in parts:
            parts[name] = (el["lat"], el["lon"])
    log.info("Ortskerne: %s", ", ".join(f"{k} ({v[0]:.4f}, {v[1]:.4f})" for k, v in parts.items()))

    stores = []
    for el in elements:
        tags = el.get("tags", {})
        if "shop" not in tags:
            continue
        chain = chain_for(tags)
        if not chain:
            continue
        # z. B. "Nahkauf Getränkemarkt" nicht als zweite Nahkauf-Filiale zählen
        if tags.get("shop") in {"beverages", "chemist", "department_store"} and chain not in NON_FOOD_OK:
            continue
        lat = el.get("lat") or el.get("center", {}).get("lat")
        lon = el.get("lon") or el.get("center", {}).get("lon")
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
        if postcode not in ALLOWED_POSTCODES:
            continue
        city = city_for(postcode, lat, lon, parts)
        name = tags.get("name") or chain
        # "Edeka Münchow Rielasingen" behalten, generisches "REWE" → "Rewe Forststraße"
        generic = slug(name) in {slug(chain), slug(tags.get("brand", "")), slug(chain.split()[0])}
        store_name = f"{chain} {street}" if generic and street else name
        address = f"{street or ''} {number or ''}".strip() + f", {postcode} {city}"
        stores.append({
            "id": slug(f"{chain}-{street or name}-{number or ''}"),
            "chain": chain,
            "name": store_name,
            "address": address,
            "city": city,
            "lat": round(lat, 6),
            "lon": round(lon, 6),
            "addressApprox": approx,
            "osm": f"{el['type']}/{el['id']}",
        })
    return stores


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
    fresh = build(session)

    manual = []
    if STORES_FILE.exists():
        manual = [s for s in json.loads(STORES_FILE.read_text(encoding="utf-8")) if s.get("manual")]
    known = {s["id"] for s in manual}
    stores = manual + [s for s in fresh if s["id"] not in known]
    stores.sort(key=lambda s: (s["chain"].lower(), s["name"].lower()))

    for s in stores:
        log.info("%-10s %-32s %s%s", s["chain"], s["name"], s["address"], " (ca.)" if s.get("addressApprox") else "")
    log.info("%d Filialen (%d manuell)", len(stores), len(manual))
    if not args.dry_run:
        STORES_FILE.parent.mkdir(parents=True, exist_ok=True)
        STORES_FILE.write_text(json.dumps(stores, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        log.info("geschrieben: %s", STORES_FILE.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
