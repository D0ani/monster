#!/usr/bin/env python3
"""Preisverlauf aus Archiv-Quellen nachtragen (einmalig bzw. bei Bedarf von Hand).

Quellen für vergangene Monster-Angebote:
  - energy-angebote.de  frühere Aktionszeiträume je Händler (Preis pro 0,5-l-Dose)
  - mydealz.de          Community-Deals mit Gültigkeitszeitraum
  - marktguru.de        abgelaufene Angebote auf der Markenseite („Verpasst!“)

Archiv-Quellen verraten nicht, für welche Region ein Prospekt galt. Übernommen werden daher nur Ketten mit
bundesweit einheitlichem Prospekt (update_deals.ARCHIVE_CHAINS) und nur in Städten mit Filiale der Kette;
App-, Coupon-, Lokal- und Online-Deals werden ausgelassen. Die Tage landen als "b": 1 (nachgetragen) in
data/history.json – live erfasste Tage werden nie überschrieben, danach werden die Stadt-Pakete neu geschrieben.

    python scripts/import_history.py            # nachtragen
    python scripts/import_history.py --dry-run  # nur anzeigen
    python scripts/import_history.py --rebuild  # alle Nachträge verwerfen und neu aufbauen
"""
from __future__ import annotations

import argparse
import html
import json
import logging
import re
import sys
import time
from collections import Counter
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import update_deals as u  # noqa: E402

log = logging.getLogger("import_history")

EA_BASE = "https://energy-angebote.de/monster-energy-0-5l/"
# Händler-Slug → Kette. Nicht übernommen: rewe/edeka/nahkauf (regionale Prospekte, Region unbekannt) und
# netto (= Netto mit dem Hund, in Baden-Württemberg nicht vertreten)
EA_SLUGS = {"kaufland": "Kaufland", "lidl": "Lidl", "aldi-sued": "Aldi Süd", "penny": "Penny",
            "netto-marken-discount": "Netto", "norma": "Norma", "mueller": "Müller"}

MYDEALZ_URL = "https://www.mydealz.de/search"
MYDEALZ_PAGES = 5
MYDEALZ_SKIP_RE = re.compile(r"lokal|regional|\bapp\b|coupon|gutschein|payback|bonus|pfandfehler|sparabo|prime", re.I)
MAX_OFFER_PRICE = 1.49  # UVP Monster 0,5 l – was nicht darunter liegt, ist kein Angebot (z. B. Staffelpreise)


def nuxt_payload(text: str):
    """__NUXT_DATA__ (devalue-Format: flaches Array mit Index-Verweisen) in normale Objekte auflösen."""
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', text, re.S)
    if not m:
        raise u.SourceError("kein __NUXT_DATA__ – Seitenstruktur geändert?")
    data, memo = json.loads(m.group(1)), {}
    wrappers = {"Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef"}

    def resolve(i):
        if not isinstance(i, int) or not 0 <= i < len(data):
            return None
        if i in memo:
            return memo[i]
        value = data[i]
        if isinstance(value, list):
            if value and isinstance(value[0], str) and value[0] in wrappers:
                out = resolve(value[1]) if len(value) > 1 else None
            elif value and value[0] == "Date":
                out = value[1]
            else:
                out = []
                memo[i] = out
                out.extend(resolve(x) for x in value)
        elif isinstance(value, dict):
            out = {}
            memo[i] = out
            out.update({k: resolve(x) for k, x in value.items()})
        else:
            out = value
        memo[i] = out
        return out

    return resolve(0)


def find_key(obj, key: str):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if k == key:
                yield v
            else:
                yield from find_key(v, key)
    elif isinstance(obj, list):
        for v in obj:
            yield from find_key(v, key)


def fetch_energy_angebote(session) -> list[dict]:
    periods = []
    for slug, chain in EA_SLUGS.items():
        try:
            root = nuxt_payload(u.http_get(session, EA_BASE + slug).text)
        except Exception as exc:  # bewusst breit: ein Händler darf den Rest nicht aufhalten
            log.warning("energy-angebote %s übersprungen: %s", slug, exc)
            continue
        for history in find_key(root, "priceHistory"):
            for entry in history or []:
                if not isinstance(entry, dict) or not entry.get("price") or entry.get("name"):
                    continue  # Einträge mit "name" sind Vergleichsangebote anderer Händler
                start, end = str(entry.get("validFrom") or "")[:10], str(entry.get("validUntil") or "")[:10]
                if start and end and start <= end:
                    periods.append({"chain": chain, "from": start, "to": end, "price": round(float(entry["price"]), 3),
                                    "source": "energy-angebote.de"})
        time.sleep(1)
    return periods


def local_day(timestamp: int, *, end: bool = False):
    moment = datetime.fromtimestamp(timestamp, u.TZ)
    if end and moment.hour < 6:  # Enddatum "bis 23:59" landet je nach Zeitzone kurz nach Mitternacht
        moment -= timedelta(hours=6)
    return moment.date().isoformat()


def fetch_mydealz(session) -> list[dict]:
    threads = {}
    for page in range(1, MYDEALZ_PAGES + 1):
        text = u.http_get(session, MYDEALZ_URL, params={"q": "monster energy", "page": page}).text
        for a, b in re.findall(r'data-vue3=\'([^\']+)\'|data-vue3="([^"]+)"', text):
            try:
                thread = (json.loads(html.unescape(a or b)).get("props") or {}).get("thread")
            except ValueError:
                continue
            if thread:
                threads[thread.get("threadId")] = thread
        time.sleep(1.5)
    periods = []
    for thread in threads.values():
        title = thread.get("title") or ""
        merchant = (thread.get("merchant") or {}).get("merchantName") or ""
        start, end = (thread.get("startDate") or {}).get("timestamp"), (thread.get("endDate") or {}).get("timestamp")
        chain = u.normalize_chain(merchant, regional=False)
        if (not u.is_monster_energy(title) or MYDEALZ_SKIP_RE.search(title) or chain not in u.ARCHIVE_CHAINS
                or not (start and end and thread.get("price"))):
            continue
        pack = u.detect_pack(title, float(thread["price"]))
        low, high = u.CAN_PRICE_RANGE
        if not pack["pricePerUnit"] or not low <= pack["pricePerUnit"] <= high:
            continue
        periods.append({"chain": chain, "from": local_day(start), "to": local_day(end, end=True),
                        "price": pack["pricePerUnit"], "source": "mydealz.de"})
    return periods


def city_records(periods: list[dict], stores_by_city: dict, cities: list[dict]) -> list[dict]:
    """Zeitraum einer Kette → Eintrag je Stadt mit Filiale der Kette (Format wie ein Angebot in deals.json)."""
    return [{"city": city["slug"], "chain": p["chain"], "pricePerUnit": p["price"],
             "validFrom": p["from"], "validTo": p["to"]}
            for p in periods for city in cities if p["chain"] in stores_by_city.get(city["slug"], {})]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--dry-run", action="store_true", help="nichts schreiben, nur anzeigen")
    parser.add_argument("--rebuild", action="store_true",
                        help="vorher alle nachgetragenen Tage entfernen und komplett neu aufbauen")
    args = parser.parse_args()
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.INFO, format="%(levelname)-7s %(message)s")

    today = datetime.now(u.TZ).date()
    session = u.make_session()
    cities, stores_by_city = u.load_cities(), u.load_stores()
    periods: list[dict] = []
    for name, fetch in (("energy-angebote.de", fetch_energy_angebote), ("mydealz.de", fetch_mydealz)):
        try:
            found = [p for p in fetch(session) if p["from"] < today.isoformat() and p["price"] < MAX_OFFER_PRICE]
        except Exception as exc:  # bewusst breit
            log.warning("%s übersprungen: %s", name, exc)
            continue
        log.info("%s: %d Aktionszeiträume (%s)", name, len(found),
                 ", ".join(f"{c} {n}" for c, n in Counter(p["chain"] for p in found).most_common()))
        periods += found
    for p in sorted(periods, key=lambda p: (p["from"], p["chain"])):
        log.info("  %s – %s  %-9s %.2f €  (%s)", p["from"], p["to"], p["chain"], p["price"], p["source"])

    archive = city_records(periods, stores_by_city, cities)
    try:
        archive += u.archive_deals(u.fetch_marktguru_expired(session, today), stores_by_city, cities, "")
    except Exception as exc:  # bewusst breit
        log.warning("marktguru „Verpasst!“ übersprungen: %s", exc)

    if args.rebuild and not args.dry_run and u.HISTORY_FILE.exists():  # live erfasste Tage bleiben erhalten
        history = json.loads(u.HISTORY_FILE.read_text(encoding="utf-8"))
        removed = sum(1 for days in history.values() for v in days.values() if v.get("b"))
        history = {c: {d: v for d, v in days.items() if not v.get("b")} for c, days in history.items()}
        u.HISTORY_FILE.write_text(json.dumps(history, ensure_ascii=False), encoding="utf-8")
        log.info("--rebuild: %d nachgetragene Tage entfernt", removed)
    deals = json.loads(u.DEALS_FILE.read_text(encoding="utf-8")) if u.DEALS_FILE.exists() else []
    u.update_history(deals, cities, today, args.dry_run, archive)
    if not args.dry_run:  # Stadt-Pakete neu schreiben, Stand der Angebote bleibt unverändert
        updated = max((d.get("lastUpdated") or "" for d in deals), default="") or \
            datetime.now(u.timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
        u.write_city_bundles(deals, cities, updated, False, prune=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
