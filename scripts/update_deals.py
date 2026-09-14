#!/usr/bin/env python3
"""
Sammelt aktuelle Monster-Energy-Angebote für Singen (Hohentwiel) und Rielasingen-Worblingen
und schreibt data/deals.json.

Quellen (jede läuft isoliert – fällt eine aus, wird sie übersprungen und geloggt):
  * marktguru        Web-API von marktguru.de (Schlüssel stehen öffentlich im HTML), PLZ 78224 + 78239
  * kaufda           Next.js-Seite kaufda.de/Angebote/Monster, Standort über "location"-Cookie
  * prospektangebote AWS-WAF-geschützt → Playwright (headless Chromium), Daten aus JSON-LD.
                     Nicht standortbezogen → nur Ketten mit Filiale im Verzeichnis werden übernommen.

Ablauf: Angebote holen → Monster-Energy filtern → Packungsgröße erkennen → Ketten-Angebot auf die
Filialen aus data/stores.json verteilen → mit bestehender deals.json mergen → schreiben.

    python scripts/update_deals.py                      # alle Quellen, schreibt data/deals.json
    python scripts/update_deals.py --dry-run -v         # nichts schreiben, ausführlich loggen
    python scripts/update_deals.py --only marktguru,kaufda
    python scripts/update_deals.py --debug-dir debug    # Rohantworten der Quellen speichern
"""
from __future__ import annotations

import argparse
import json
import logging
import os
import re
import sys
import time as _time
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from pathlib import Path
from typing import Callable
from urllib.parse import quote, urlparse
from zoneinfo import ZoneInfo

import requests
from bs4 import BeautifulSoup
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

ROOT = Path(__file__).resolve().parent.parent
DEALS_FILE = ROOT / "data" / "deals.json"
STORES_FILE = ROOT / "data" / "stores.json"

# --------------------------------------------------------------------------- Konfiguration

REGION = {
    "label": "Singen (Hohentwiel) inkl. Ortsteile / Rielasingen-Worblingen",
    "area": "Singen/Rielasingen",   # für Angebote ohne bekannte Filiale: "Filiale im Raum …"
    "zip": "78224",                 # Hauptstandort (kaufDA-Cookie)
    "zips": ["78224", "78239"],     # Singen + Rielasingen-Worblingen (marktguru)
    "city": "Singen",
    "lat": 47.7597,
    "lng": 8.8403,
}
SEARCH_TERMS = ["monster energy", "monster"]
TZ = ZoneInfo("Europe/Berlin")
HTTP_TIMEOUT = 25
BROWSER_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
              "(KHTML, like Gecko) Chrome/128.0 Safari/537.36")
CAN_PRICE_RANGE = (0.40, 3.50)  # plausibler Preis pro Dose in €
MAX_PACK = 48

# Händlername laut Quelle → kanonischer Kettenname (muss zu data/stores.json passen).
# Dritter Wert: Alias nur bei standortgenauen Quellen verwenden (bundesweit mehrdeutig).
CHAIN_ALIASES: list[tuple[str, str, bool]] = [
    (r"\baldi\b(?!\s*nord)", "Aldi Süd", False),
    (r"\bnahkauf\b", "Nahkauf", False),
    (r"\bedeka\b|\be[- ]?center\b", "Edeka", False),
    (r"\brewe\b", "Rewe", False),
    (r"\blidl\b", "Lidl", False),
    (r"\bkaufland\b", "Kaufland", False),
    (r"\bnetto\s*(marken|md)\b", "Netto", False),
    (r"^\s*netto\s*$", "Netto", True),  # "Netto" ohne Zusatz = evtl. Netto (Scottie), in BW nicht vertreten
    (r"\bpenny\b", "Penny", False),
    (r"\bnorma\b", "Norma", False),
    (r"\bglobus\b", "Globus", False),
    (r"\btegut\b", "tegut", False),
    (r"\bmarktkauf\b", "Marktkauf", False),
    (r"\btrinkgut\b", "Trinkgut", False),
    (r"\bfristo\b", "Fristo", False),
    (r"getr(ä|ae)nke[\s-]*hoffmann", "Getränke Hoffmann", False),
    (r"\brossmann\b", "Rossmann", False),
]

# Bekannte Sorten (längste zuerst prüfen, damit "Ultra Paradise" vor "Ultra" greift)
FLAVORS = sorted([
    "Ultra White", "Ultra Paradise", "Ultra Fiesta", "Ultra Rosá", "Ultra Watermelon", "Ultra Gold",
    "Ultra Blue", "Ultra Red", "Ultra Peachy Keen", "Ultra Strawberry Dreams", "Ultra Violet",
    "Ultra Black", "Ultra Citron", "Zero Ultra", "Ultra", "Mango Loco", "Pipeline Punch",
    "Pacific Punch", "Rio Punch", "Monarch", "Khaotic", "Aussie Style Lemonade", "Bad Apple",
    "Juiced", "Rehab", "Nitro", "Reserve", "Lewis Hamilton", "Absolutely Zero", "Assault",
    "Viking Berry", "Papillon", "Ripper", "VR46", "Zero Sugar",
], key=len, reverse=True)

log = logging.getLogger("deals")
DEBUG_DIR: Path | None = None


class SourceError(RuntimeError):
    """Quelle nicht nutzbar (nicht erreichbar, Struktur geändert, Bot-Schutz …)."""


@dataclass
class Offer:
    """Ein Rohangebot einer Quelle – gilt für eine ganze Kette, noch ohne Filialzuordnung."""
    source: str
    source_url: str
    retailer: str
    title: str
    description: str
    price: float | None
    regular_price: float | None
    valid_from: date | None
    valid_to: date | None
    volume: float | None = None
    quantity: float | None = None
    retailer_hint: str = ""  # zusätzlicher Text für die Kettenerkennung, z. B. URL-Slug "netto marken discount"
    regional: bool = True  # False = Quelle ist bundesweit, nicht auf Singen gefiltert

    @property
    def text(self) -> str:
        return f"{self.title} {self.description}".strip()


# --------------------------------------------------------------------------- Hilfsfunktionen

def make_session() -> requests.Session:
    session = requests.Session()
    retry = Retry(total=3, backoff_factor=1.5, status_forcelist=(429, 500, 502, 503, 504),
                  allowed_methods=frozenset({"GET"}))
    session.mount("https://", HTTPAdapter(max_retries=retry))
    session.headers.update({"User-Agent": BROWSER_UA, "Accept-Language": "de-DE,de;q=0.9,en;q=0.5"})
    return session


def http_get(session: requests.Session, url: str, **kwargs) -> requests.Response:
    kwargs.setdefault("timeout", HTTP_TIMEOUT)
    try:
        resp = session.get(url, **kwargs)
    except requests.RequestException as exc:
        raise SourceError(f"{url} nicht erreichbar: {exc}") from exc
    if resp.status_code != 200:
        raise SourceError(f"{url} antwortet mit HTTP {resp.status_code}")
    return resp


def debug_dump(name: str, content: str) -> None:
    if DEBUG_DIR:
        DEBUG_DIR.mkdir(parents=True, exist_ok=True)
        (DEBUG_DIR / name).write_text(content, encoding="utf-8")


def slug(text: str) -> str:
    text = text.lower().translate(str.maketrans({"ä": "ae", "ö": "oe", "ü": "ue", "ß": "ss", "á": "a"}))
    return re.sub(r"[^a-z0-9]+", "-", text).strip("-")


def parse_price(value) -> float | None:
    """'€1,59' / '0.99' / 0.99 → 1.59 / 0.99; 0 oder leer → None."""
    if value is None or value == "":
        return None
    if isinstance(value, (int, float)):
        return round(float(value), 2) if value > 0 else None
    m = re.search(r"(\d{1,4})[.,](\d{2})(?!\d)", str(value))
    if m:
        return float(f"{m.group(1)}.{m.group(2)}")
    m = re.search(r"\d+", str(value))
    return float(m.group()) if m and int(m.group()) > 0 else None


def to_local_date(value, *, end: bool = False) -> date | None:
    """ISO-Zeitstempel (UTC oder mit Offset) → Kalenderdatum in Europe/Berlin."""
    if not value:
        return None
    text = str(value).strip()
    if re.fullmatch(r"\d{4}-\d{2}-\d{2}", text):
        return date.fromisoformat(text)
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", text.replace("Z", "+00:00"))
    try:
        dt = datetime.fromisoformat(text)
    except ValueError:
        log.debug("Unbekanntes Datumsformat: %r", value)
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=TZ)
    dt = dt.astimezone(TZ)
    if end and dt.time() == time(0, 0):  # exklusives Ende (00:00 des Folgetags)
        dt -= timedelta(seconds=1)
    return dt.date()


def gh_annotation(level: str, title: str, message: str) -> None:
    """Warnung/Fehler direkt im GitHub-Actions-Log hervorheben."""
    if os.environ.get("GITHUB_ACTIONS") == "true":
        msg = message.replace("%", "%25").replace("\r", "").replace("\n", "%0A")
        print(f"::{level} title={title}::{msg}", flush=True)


# --------------------------------------------------------------------------- Erkennung

MONSTER_RE = re.compile(r"\bmonster\b", re.I)
EXCLUDE_RE = re.compile(
    r"sirup|alarm|truck|\bjam\b|\bhigh\b|munch|spielzeug|figur|lego|wheels|pl(ü|ue)sch|kr(ü|ue)mel|"
    r"cookie|rally|ideenwelt|kost(ü|ue)m|puzzle|kabel|kopfh(ö|oe)rer|reifen|sticker|shirt|hoodie|socken|"
    r"monsters?\s*(ag|inc)|spiel\b|buch\b|dvd|blu-?ray", re.I)
ENERGY_HINT_RE = re.compile(
    r"energy|dose|\b0[,.]5\s*-?\s*l|500\s*ml|koffein|tray|" + "|".join(re.escape(f) for f in FLAVORS), re.I)


def is_monster_energy(title: str, description: str = "") -> bool:
    text = f"{title} {description}"
    return bool(MONSTER_RE.search(text) and ENERGY_HINT_RE.search(text) and not EXCLUDE_RE.search(text))


# "4er-Pack", "12ER-TRAY", "4 x 0,5 l", "4 x 250 ml", "Tray mit 12 Dosen", "6 Dosen", "6x"
PACK_PATTERNS = [
    re.compile(r"(\d{1,2})\s*er[-\s]?(?:pack(?:ung)?|tray|karton|kiste|box|multipack|tr(?:ä|ae)ger)", re.I),
    re.compile(r"(\d{1,2})\s*[x×]\s*(?:je\s*)?(?:\d[,.]\d{1,3}\s*-?\s*(?:l|liter)\b|\d{3}\s*ml)", re.I),
    re.compile(r"(?:tray|pack(?:ung)?|karton)\s*(?:mit|à|a|zu)?\s*(\d{1,2})\s*(?:dosen|stück|stk)", re.I),
    re.compile(r"\b(\d{1,2})\s*(?:dosen|stück|stk\.?)(?!\w)", re.I),
    re.compile(r"\b(\d{1,2})\s*[x×](?!\w)", re.I),
]
# Zusatzangebot im Fließtext, z. B. "auch als 4er-Pack für 3.96 €"
BUNDLE_RE = re.compile(
    r"(\d{1,2})\s*er[-\s]?(?:pack(?:ung)?|tray|karton|kiste)\w*\s*(?:für|zu|nur|:|à)?\s*(?:je\s*)?"
    r"(\d{1,3}[.,]\d{2})\s*€?", re.I)
VOLUME_L_RE = re.compile(r"(\d[,.]\d{1,3})\s*-?\s*(?:l|liter)\b", re.I)
VOLUME_ML_RE = re.compile(r"(\d{3})\s*ml\b", re.I)


def detect_pack(text: str, price: float, quantity: float | None = None) -> dict:
    """Packungsgröße + Preis pro Dose aus Freitext bestimmen (inkl. Plausibilitätsprüfung)."""
    count = None
    for pattern in PACK_PATTERNS:
        m = pattern.search(text)
        if m and 2 <= int(m.group(1)) <= MAX_PACK:
            count = int(m.group(1))
            break
    if count is None and quantity and float(quantity).is_integer() and 2 <= quantity <= MAX_PACK:
        count = int(quantity)

    low, high = CAN_PRICE_RANGE
    if count is None:
        if price > high:  # zu teuer für eine Dose, aber keine Mengenangabe gefunden
            return {"packType": "multipack", "unitCount": None, "price": price, "pricePerUnit": None,
                    "perCanPricing": False}
        return {"packType": "single", "unitCount": 1, "price": price, "pricePerUnit": price,
                "perCanPricing": False}

    per_unit = price / count
    if per_unit < low and low <= price <= high:
        # Preis ist ein Dosenpreis beim Kauf der ganzen Packung ("12er-Tray … je 0,88 €")
        return {"packType": f"pack{count}", "unitCount": count, "price": round(price * count, 2),
                "pricePerUnit": price, "perCanPricing": True}
    return {"packType": f"pack{count}", "unitCount": count, "price": price,
            "pricePerUnit": round(per_unit, 3), "perCanPricing": False}


def offer_variants(offer: Offer) -> list[dict]:
    """Hauptangebot + im Text genannte Zusatz-Packs ("auch als 4er-Pack für 3,96 €")."""
    bundles = [(int(n), parse_price(p)) for n, p in BUNDLE_RE.findall(offer.text)]
    primary = detect_pack(BUNDLE_RE.sub(" ", offer.text), offer.price, offer.quantity)
    variants = [primary]
    low, high = CAN_PRICE_RANGE
    for count, total in bundles:
        if not total or not 2 <= count <= MAX_PACK or low > total / count or total / count > high:
            continue
        if any(v["packType"] == f"pack{count}" and abs(v["price"] - total) < 0.01 for v in variants):
            continue
        variants.append({"packType": f"pack{count}", "unitCount": count, "price": total,
                         "pricePerUnit": round(total / count, 3), "perCanPricing": False, "bundle": True})
    return variants


def volume_liters(offer: Offer) -> float | None:
    m = VOLUME_L_RE.search(offer.text)
    if m:
        value = float(m.group(1).replace(",", "."))
    elif m := VOLUME_ML_RE.search(offer.text):
        value = int(m.group(1)) / 1000
    else:
        value = offer.volume
    return round(value, 3) if value and 0.1 <= value <= 1.0 else None


def product_name(offer: Offer) -> str:
    flavor = next((f for f in FLAVORS if re.search(rf"\b{re.escape(f)}\b", offer.text, re.I)), None)
    name = f"Monster Energy {flavor}" if flavor else "Monster Energy"
    if re.search(r"versch(\.|iedene)?\s*sorten|sortiert", offer.text, re.I):
        name += " (versch. Sorten)"
    return name


KEEP_UPPER = {"REWE", "PENNY", "NETTO", "LIDL", "EDEKA", "ALDI", "PAYBACK", "DEUTSCHLANDCARD", "KAUFLAND"}
TITLE_WORDS = {"APP", "BONUS", "PLUS", "COUPON"}


def build_note(offer: Offer, variant: dict) -> str | None:
    parts = []
    # marktguru: "HINWEIS: MIT APP 0,10 € REWE BONUS versch. Sorten …" → "Mit App 0,10 € REWE Bonus"
    hint = re.search(r"HINWEIS:\s*(.+?)(?=\s+\S*[a-zäöü]|\s{2,}|$)", offer.description)
    if hint:
        words = [w if w in KEEP_UPPER or not w.isalpha() else w.capitalize() if w in TITLE_WORDS else w.lower()
                 for w in hint.group(1).split()]
        sentence = re.sub(r"(\d)\.(\d{2})", r"\1,\2", " ".join(words))
        parts.append(sentence[:1].upper() + sentence[1:])
    if variant.get("perCanPricing"):
        parts.append(f"Preis je Dose beim Kauf im {variant['unitCount']}er-Pack")
    if variant.get("bundle"):
        parts.append(f"{variant['unitCount']}er-Pack laut Prospekt")
    pfand = re.search(r"(\d[.,]\d{2})\s*(?:€|euro)?\s*pfand|pfand\s*(?:von\s*)?(\d[.,]\d{2})", offer.description, re.I)
    if pfand and not variant.get("bundle") and not variant.get("perCanPricing"):
        amount = (pfand.group(1) or pfand.group(2)).replace(".", ",")
        parts.append(f"zzgl. {amount} € Pfand")
    elif re.search(r"pfand", offer.description, re.I):
        parts.append("zzgl. Pfand")
    return " · ".join(parts) or None


def normalize_chain(retailer: str, *, regional: bool) -> str | None:
    name = retailer.replace("-", " ").strip()
    for pattern, chain, regional_only in CHAIN_ALIASES:
        if re.search(pattern, name, re.I) and (regional or not regional_only):
            return chain
    return name.title() if regional and name else None


# --------------------------------------------------------------------------- Quellen

MARKTGURU_HOME = "https://www.marktguru.de/"
MARKTGURU_API = "https://api.marktguru.de/api/v1/offers/search"


def fetch_marktguru(session: requests.Session) -> list[Offer]:
    home = http_get(session, MARKTGURU_HOME).text
    api_key = re.search(r'"apiKey"\s*:\s*"([^"]+)"', home)
    client_key = re.search(r'"clientKey"\s*:\s*"([^"]+)"', home)
    if not (api_key and client_key):
        raise SourceError("API-Schlüssel nicht im HTML gefunden – Seitenstruktur geändert?")
    headers = {"x-apikey": api_key.group(1), "x-clientkey": client_key.group(1), "Accept": "application/json"}

    raw: dict = {}  # nach Angebots-ID dedupliziert (PLZs/Suchbegriffe überschneiden sich)
    for zip_code in REGION["zips"]:
        for term in SEARCH_TERMS:
            offset = 0
            while offset < 500:
                params = {"as": "web", "q": term, "zipCode": zip_code, "limit": 100, "offset": offset}
                resp = http_get(session, MARKTGURU_API, headers=headers, params=params)
                debug_dump(f"marktguru_{zip_code}_{slug(term)}_{offset}.json", resp.text)
                payload = resp.json()
                results = payload.get("results") or []
                raw.update({item.get("id"): item for item in results})
                offset += len(results)
                if not results or offset >= (payload.get("totalResults") or 0):
                    break
                _time.sleep(1)

    offers = []
    for item in raw.values():
        brand = item.get("brand") or {}
        title = f"{brand.get('name', '')} {(item.get('product') or {}).get('name', '')}".strip()
        description = item.get("description") or ""
        if not is_monster_energy(title, description):
            continue
        dates = item.get("validityDates") or [{}]
        valid_from = min(filter(None, (to_local_date(d.get("from")) for d in dates)), default=None)
        valid_to = max(filter(None, (to_local_date(d.get("to"), end=True) for d in dates)), default=None)
        url = f"https://www.marktguru.de/b/{brand['uniqueName']}" if brand.get("uniqueName") else MARKTGURU_HOME
        is_liter = (item.get("unit") or {}).get("shortName") == "l"
        for advertiser in item.get("advertisers") or []:
            offers.append(Offer(
                source="marktguru", source_url=url, retailer=advertiser.get("name") or "",
                title=title, description=description,
                price=parse_price(item.get("price")), regular_price=parse_price(item.get("oldPrice")),
                valid_from=valid_from, valid_to=valid_to,
                volume=item.get("volume") if is_liter else None, quantity=item.get("quantity"),
            ))
    return offers


KAUFDA_URL = "https://www.kaufda.de/Angebote/Monster"


def fetch_kaufda(session: requests.Session) -> list[Offer]:
    # kaufDA bestimmt den Standort per IP – der "location"-Cookie überschreibt das (wichtig auf GitHub-Runnern).
    location = {"lat": REGION["lat"], "lng": REGION["lng"], "city": REGION["city"],
                "zip": REGION["zip"], "countryCode": "DE"}
    resp = http_get(session, KAUFDA_URL, cookies={"location": quote(json.dumps(location, separators=(",", ":")))})
    debug_dump("kaufda.html", resp.text)
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', resp.text, re.S)
    if not m:
        raise SourceError("__NEXT_DATA__ nicht gefunden – Seitenstruktur geändert?")
    info = json.loads(m.group(1)).get("props", {}).get("pageProps", {}).get("pageInformation") or {}
    loc = info.get("location") or {}
    if loc.get("zip") and loc["zip"] != REGION["zip"]:
        raise SourceError(f"Standort {loc.get('city')} {loc.get('zip')} statt {REGION['zip']} – Cookie ignoriert?")

    items, seen = [], set()
    for group in (info.get("offers") or {}).values():
        if isinstance(group, dict):
            items.extend(group.get("items") or [])
    offers = []
    for item in items:
        if item.get("type", "OFFER") != "OFFER" or item.get("id") in seen:
            continue
        seen.add(item.get("id"))
        title = " ".join(filter(None, [item.get("brand"), item.get("title")]))
        description = item.get("description") or ""
        if not is_monster_energy(f"{title} {' '.join(item.get('categories') or [])}", description):
            continue
        prices = item.get("prices") or {}
        offers.append(Offer(
            source="kaufda", source_url=KAUFDA_URL, retailer=item.get("publisherName") or "",
            title=title, description=description,
            price=parse_price(prices.get("mainPrice")), regular_price=parse_price(prices.get("secondaryPrice")),
            valid_from=to_local_date(item.get("validFrom")), valid_to=to_local_date(item.get("validUntil"), end=True),
        ))
    return offers


PA_URL = "https://www.prospektangebote.de/angebote/monster"


def fetch_prospektangebote(_session: requests.Session) -> list[Offer]:
    try:
        from playwright.sync_api import Error as PlaywrightError, sync_playwright
    except ImportError as exc:
        raise SourceError("Playwright nicht installiert (pip install playwright && "
                          "python -m playwright install chromium)") from exc
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=True)
            try:
                page = browser.new_page(locale="de-DE")
                page.goto(PA_URL, wait_until="networkidle", timeout=60_000)
                # Die AWS-WAF-Challenge löst sich per JavaScript und lädt die eigentliche Seite nach
                page.wait_for_selector("a.js-offer-link-item", state="attached", timeout=30_000)
                html = page.content()
            finally:
                browser.close()
    except PlaywrightError as exc:
        raise SourceError(f"Seite nicht renderbar (Bot-Schutz/Timeout?): {str(exc).splitlines()[0]}") from exc
    debug_dump("prospektangebote.html", html)
    soup = BeautifulSoup(html, "html.parser")

    organisations: dict[str, str] = {}
    ld_offers: list[dict] = []
    for script in soup.find_all("script", type="application/ld+json"):
        try:
            data = json.loads(script.string or "")
        except json.JSONDecodeError:
            continue
        nodes = data.get("@graph", [data]) if isinstance(data, dict) else data
        for node in nodes if isinstance(nodes, list) else []:
            if not isinstance(node, dict):
                continue
            types = node.get("@type") if isinstance(node.get("@type"), list) else [node.get("@type")]
            if "Organization" in types and node.get("@id"):
                organisations[node["@id"]] = node.get("name") or ""
            if "Product" in types:
                found = node.get("offers") or []
                ld_offers.extend(found if isinstance(found, list) else [found])
            elif "Offer" in types:
                ld_offers.append(node)
    if not ld_offers:
        raise SourceError("Keine JSON-LD-Angebote gefunden – Seitenstruktur geändert?")

    # Streichpreis + Händlerlogo stehen nur in den Karten → per Angebots-ID zuordnen
    cards: dict[str, dict] = {}
    for link in soup.select("a.js-offer-link-item[href]"):
        m = re.search(r"-(\d+)/?$", link["href"])
        if m:
            normal = link.select_one(".product__price-normal")
            logo = link.select_one(".store-image img[alt]")
            cards[m.group(1)] = {"regular": parse_price(normal.get_text()) if normal else None,
                                 "retailer": logo["alt"] if logo else None}

    offers = []
    for item in ld_offers:
        url = item.get("url") or PA_URL
        id_match = re.search(r"-(\d+)/?$", url)
        card = cards.get(id_match.group(1), {}) if id_match else {}
        seller = (item.get("seller") or item.get("offeredBy") or {}).get("@id")
        slug_match = re.search(r"/geschaefte/([^/]+)/", url)
        retailer = organisations.get(seller) or card.get("retailer") or (slug_match.group(1) if slug_match else "")
        title, description = item.get("name") or "", item.get("description") or ""
        if not is_monster_energy(title, description):
            continue
        offers.append(Offer(
            source="prospektangebote", source_url=url, retailer=retailer,
            retailer_hint=slug_match.group(1).replace("-", " ") if slug_match else "",
            title=title, description=description,
            price=parse_price(item.get("price")), regular_price=card.get("regular"),
            valid_from=to_local_date(item.get("validFrom") or item.get("availabilityStarts")),
            valid_to=to_local_date(item.get("validThrough") or item.get("priceValidUntil"), end=True),
        ))
    return offers


@dataclass
class Source:
    key: str
    label: str
    domain: str
    regional: bool  # liefert die Quelle bereits nur Angebote für Singen?
    fetch: Callable[[requests.Session], list[Offer]]


SOURCES = [  # Reihenfolge = Priorität bei Dubletten
    Source("marktguru", "marktguru", "marktguru.de", True, fetch_marktguru),
    Source("kaufda", "kaufDA", "kaufda.de", True, fetch_kaufda),
    Source("prospektangebote", "prospektangebote", "prospektangebote.de", False, fetch_prospektangebote),
]


# --------------------------------------------------------------------------- Filialen & Deals

def load_stores() -> dict[str, list[dict]]:
    if not STORES_FILE.exists():
        log.warning("%s fehlt – Angebote werden ohne Filialadresse gespeichert "
                    "(python scripts/update_stores.py)", STORES_FILE.relative_to(ROOT))
        return {}
    by_chain: dict[str, list[dict]] = {}
    for store in json.loads(STORES_FILE.read_text(encoding="utf-8")):
        by_chain.setdefault(store["chain"], []).append(store)
    return by_chain


def build_deals(offers: list[Offer], stores_by_chain: dict, today: date, now_iso: str) -> list[dict]:
    deals = []
    for offer in offers:
        if not offer.price:
            log.debug("ohne Preis übersprungen: %s", offer.text)
            continue
        if not offer.valid_to or offer.valid_to < today:
            log.debug("abgelaufen/ohne Enddatum übersprungen: %s %s", offer.retailer, offer.text)
            continue
        chain = normalize_chain(f"{offer.retailer} {offer.retailer_hint}".strip(), regional=offer.regional)
        branches = stores_by_chain.get(chain, []) if chain else []
        if not chain or (not branches and not offer.regional):
            log.info("  - %s: keine Filiale in %s, übersprungen", offer.retailer or "?", REGION["label"])
            continue

        valid_from = offer.valid_from or today
        product, volume = product_name(offer), volume_liters(offer)
        for variant in offer_variants(offer):
            regular = offer.regular_price if not variant.get("bundle") else None
            if regular and variant["perCanPricing"]:
                regular = round(regular * variant["unitCount"], 2)
            if regular and regular <= variant["price"]:
                regular = None
            for store in branches or [None]:
                deal = {
                    "id": slug("-".join([chain, store["id"] if store else "region", variant["packType"],
                                         valid_from.isoformat(), f"{variant['price']:.2f}"])),
                    "store": store["name"] if store else chain,
                    "chain": chain,
                    "address": store["address"] if store else f"Filiale im Raum {REGION['area']}",
                }
                if store:
                    deal.update(lat=store["lat"], lon=store["lon"])
                deal.update({
                    "product": product,
                    "packType": variant["packType"],
                    "unitCount": variant["unitCount"],
                })
                if volume:
                    deal["volumeLiters"] = volume
                deal.update({
                    "price": variant["price"],
                    "pricePerUnit": variant["pricePerUnit"],
                    "regularPrice": regular,
                    "validFrom": valid_from.isoformat(),
                    "validTo": offer.valid_to.isoformat(),
                })
                note = build_note(offer, variant)
                if note:
                    deal["note"] = note
                deal.update({
                    "source": offer.source_url,
                    "sourceName": next(s.label for s in SOURCES if s.key == offer.source),
                    "lastUpdated": now_iso,
                })
                deals.append(deal)
    return deals


def merge_duplicates(deals: list[dict]) -> list[dict]:
    """Gleiche id = gleiches Angebot aus mehreren Quellen → erstes behalten, Lücken auffüllen."""
    merged: dict[str, dict] = {}
    for deal in deals:
        current = merged.get(deal["id"])
        if current is None:
            merged[deal["id"]] = deal
            continue
        for key in ("regularPrice", "volumeLiters", "note", "lat", "lon"):
            if current.get(key) in (None, "") and deal.get(key) not in (None, ""):
                current[key] = deal[key]
    return list(merged.values())


def origin_of(deal: dict) -> str | None:
    host = urlparse(deal.get("source") or "").hostname or ""
    return next((s.key for s in SOURCES if host.endswith(s.domain)), None)


def merge_with_existing(existing: list[dict], fresh: list[dict], ok_sources: set[str],
                        today: date) -> tuple[list[dict], dict]:
    """Abgelaufenes raus; Einträge erfolgreicher Quellen werden ersetzt; Einträge ausgefallener
    Quellen und manuelle Einträge (fremde source) bleiben bis zum Ablauf erhalten."""
    today_s = today.isoformat()
    kept, expired = [], 0
    for deal in existing:
        if (deal.get("validTo") or "9999-12-31") < today_s:
            expired += 1
        elif origin_of(deal) not in ok_sources:
            kept.append(deal)
    merged = merge_duplicates(fresh + kept)
    merged.sort(key=lambda d: (d.get("chain", ""), d.get("store", ""), d.get("validFrom", ""),
                               d.get("unitCount") or 999, d.get("price", 0)))
    old_ids = {d.get("id") for d in existing}
    stats = {"expired": expired, "kept": len(kept), "new": sum(d["id"] not in old_ids for d in merged)}
    return merged, stats


def write_step_summary(report: list[tuple], deals: list[dict], stats: dict, dry_run: bool) -> None:
    path = os.environ.get("GITHUB_STEP_SUMMARY")
    if not path:
        return
    lines = ["## Monster-Angebote Singen", "", "| Quelle | Status | Monster-Angebote | Filial-Einträge |",
             "|---|---|---:|---:|"]
    lines += [f"| {name} | {status} | {raw if raw is not None else '–'} | {n if n is not None else '–'} |"
              for name, status, raw, n in report]
    lines += ["", f"**{len(deals)} Angebote** in `data/deals.json` · {stats['new']} neu · "
                  f"{stats['expired']} abgelaufen entfernt · {stats['kept']} aus ausgefallenen/manuellen Quellen behalten"
                  + (" · *Dry-Run, nichts geschrieben*" if dry_run else "")]
    with open(path, "a", encoding="utf-8") as fh:
        fh.write("\n".join(lines) + "\n")


# --------------------------------------------------------------------------- Main

def main() -> int:
    global DEBUG_DIR
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--only", help="kommagetrennte Quellen: " + ",".join(s.key for s in SOURCES))
    parser.add_argument("--dry-run", action="store_true", help="nichts schreiben, Ergebnis ausgeben")
    parser.add_argument("--output", type=Path, default=DEALS_FILE, help="Zieldatei (Standard: data/deals.json)")
    parser.add_argument("--debug-dir", type=Path, help="Rohantworten der Quellen hier speichern")
    parser.add_argument("--strict", action="store_true", help="Exit-Code 1, wenn keine Quelle erfolgreich war")
    parser.add_argument("-v", "--verbose", action="store_true")
    args = parser.parse_args()

    for stream in (sys.stdout, sys.stderr):  # Windows-Konsolen vertragen sonst kein €/Umlaute
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO,
                        format="%(asctime)s %(levelname)-7s %(message)s", datefmt="%H:%M:%S")
    logging.getLogger("urllib3").setLevel(logging.WARNING)
    DEBUG_DIR = args.debug_dir

    selected = SOURCES
    if args.only:
        wanted = {k.strip().lower() for k in args.only.split(",") if k.strip()}
        unknown = wanted - {s.key for s in SOURCES}
        if unknown:
            parser.error(f"unbekannte Quelle(n): {', '.join(sorted(unknown))}")
        selected = [s for s in SOURCES if s.key in wanted]

    today = datetime.now(TZ).date()
    now_iso = datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")
    stores_by_chain = load_stores()
    existing = json.loads(args.output.read_text(encoding="utf-8")) if args.output.exists() else []
    session = make_session()

    fresh: list[dict] = []
    ok_sources: set[str] = set()
    report: list[tuple] = []
    for source in selected:
        started = _time.monotonic()
        log.info("Quelle %s …", source.label)
        try:
            offers = source.fetch(session)
        except Exception as exc:  # bewusst breit: eine kaputte Quelle darf den Lauf nicht abbrechen
            log.error("Quelle %s übersprungen: %s", source.label, exc)
            log.debug("Details", exc_info=True)
            gh_annotation("warning", f"Quelle {source.label} übersprungen", str(exc))
            report.append((source.label, f"übersprungen: {exc}", None, None))
            continue
        for offer in offers:
            offer.regional = source.regional
            log.debug("  %s | %s | %s | %.2f €", offer.retailer, offer.title, offer.description[:70], offer.price or 0)
        deals = build_deals(offers, stores_by_chain, today, now_iso)
        ok_sources.add(source.key)
        fresh.extend(deals)
        report.append((source.label, "ok", len(offers), len(deals)))
        log.info("Quelle %s: %d Monster-Angebote -> %d Filial-Einträge (%.1f s)",
                 source.label, len(offers), len(deals), _time.monotonic() - started)

    if not ok_sources:
        log.warning("Keine Quelle erfolgreich – bestehende Angebote bleiben (nur Abgelaufenes wird entfernt).")
        gh_annotation("error", "Keine Quelle erfolgreich", "deals.json wurde nur um abgelaufene Angebote bereinigt.")

    merged, stats = merge_with_existing(existing, fresh, ok_sources, today)
    log.info("Ergebnis: %d Angebote (%d neu, %d abgelaufen entfernt, %d behalten aus ausgefallenen/manuellen Quellen)",
             len(merged), stats["new"], stats["expired"], stats["kept"])

    output = json.dumps(merged, ensure_ascii=False, indent=2) + "\n"
    if args.dry_run:
        print(output)
    else:
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(output, encoding="utf-8")
        log.info("geschrieben: %s", args.output)
    write_step_summary(report, merged, stats, args.dry_run)
    return 1 if args.strict and not ok_sources else 0


if __name__ == "__main__":
    sys.exit(main())
