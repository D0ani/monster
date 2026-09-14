# Monster-Angebote Singen

Statische Website (GitHub Pages), die zeigt, wo **Monster Energy** in der Großen Kreisstadt
**Singen (Hohentwiel)** mit allen Ortsteilen (Beuren an der Aach, Bohlingen, Friedingen, Hausen an der Aach,
Schlatt unter Krähen, Überlingen am Ried) und in **Rielasingen-Worblingen** gerade im Angebot ist – Supermärkte, Discounter und Getränkemärkte inkl. Einzeldose
vs. Multipack, Preis pro Dose, Rabatt und Gültigkeit. Look: „Ultra White“ im Dark Mode – weiße Dose
auf schwarzem Grund, Silber-Akzente, Eisblau wie der ENERGY-Schriftzug.
Die Daten werden **täglich automatisch** per GitHub Actions aus Prospekt-Aggregatoren gescrapt.

- Kein Backend, kein Framework: `index.html` + `style.css` + `app.js` lesen `data/deals.json`
- Filter nach Kette, Packungsgröße (Einzeln/4er/6er/10er/…), Sorten-Suche, Sortierung (Preis/Dose, Gesamtpreis, Rabatt)
- Filter stehen in der URL (`?kette=Rewe&packung=pack4`) → Links teilbar
- Optionale Karte (Leaflet + OpenStreetMap), synchron zu den Filtern. Lädt erst nach Klick → keine
  Drittanbieter-Requests beim Seitenaufruf, keine Google Fonts (DSGVO-freundlich)

## Ordnerstruktur

```
.
├── .github/workflows/
│   ├── update-deals.yml     # täglich 06:00 + manuell: Scraper → commit data/deals.json → Deployment
│   └── deploy-pages.yml     # Pages-Deployment (Push auf main, manuell, oder Aufruf durch update-deals)
├── assets/
│   ├── can-ultra-white.webp # Dosenfoto im Header (CC0, Wikimedia Commons, freigestellt)
│   ├── favicon-32.png, icon-192.png, apple-touch-icon.png
│   └── og-image.jpg         # Vorschaubild beim Teilen des Links (1200×630)
├── data/
│   ├── deals.json           # Angebote (vom Scraper überschrieben/gemergt)
│   └── stores.json          # Filialverzeichnis Singen + Rielasingen (aus OpenStreetMap)
├── scripts/
│   ├── update_deals.py      # Scraper: marktguru, kaufDA, prospektangebote
│   ├── update_stores.py     # baut data/stores.json aus OpenStreetMap neu
│   └── requirements.txt
├── index.html
├── style.css
├── app.js
└── README.md
```

## Setup auf GitHub

1. Repository pushen (Branch `main`).
2. **Settings → Pages → Build and deployment → Source: „GitHub Actions“** auswählen.
3. **Actions → „Angebote aktualisieren“ → „Run workflow“** einmal manuell starten (siehe unten).
   Danach läuft der Workflow jeden Morgen von selbst.
4. Die Seite ist unter `https://<user>.github.io/<repo>/` erreichbar.

Die Workflows setzen ihre Rechte selbst (`contents: write` für den Daten-Commit, `pages`/`id-token` fürs Deployment).
Falls eine Organisation das einschränkt: *Settings → Actions → General → Workflow permissions → Read and write*.

## Lokal testen

```bash
python -m venv .venv
source .venv/bin/activate            # Windows: .venv\Scripts\activate
pip install -r scripts/requirements.txt
python -m playwright install chromium   # nur für prospektangebote.de nötig

# Probelauf: nichts schreiben, alles loggen
python scripts/update_deals.py --dry-run -v

# einzelne Quellen
python scripts/update_deals.py --only marktguru,kaufda

# Rohantworten der Quellen zum Debuggen speichern (landet in debug/, ist in .gitignore)
python scripts/update_deals.py --dry-run --debug-dir debug

# echter Lauf → schreibt data/deals.json
python scripts/update_deals.py
```

Frontend lokal ansehen – über einen Webserver, weil Browser `fetch()` bei `file://` blockieren:

```bash
python -m http.server 8000
# → http://localhost:8000
```

## So läuft die tägliche Aktualisierung

`update-deals.yml` wird per `schedule: cron: "0 4 * * *"` gestartet. GitHub-Cron läuft in **UTC**, das
entspricht **06:00 Uhr MESZ** im Sommer bzw. 05:00 Uhr MEZ im Winter. Bei hoher Last startet GitHub geplante
Läufe oft 5–30 Minuten später.

1. Python + Abhängigkeiten installieren, Chromium für Playwright (gecacht).
2. `scripts/update_deals.py` fragt jede Quelle ab:
   | Quelle | Technik | Standort |
   |---|---|---|
   | marktguru.de | JSON-API (öffentliche Web-Keys aus dem HTML) | PLZ 78224 + 78239 |
   | kaufda.de | `__NEXT_DATA__` der Seite `/Angebote/Monster` | Cookie `location` = Singen |
   | prospektangebote.de | Playwright (AWS-WAF-JS-Challenge), JSON-LD | bundesweit → nur Ketten mit Filiale in Singen |
3. Filter auf Monster Energy (Spielzeug, „Monster Munch“ usw. fliegen raus), Erkennung der Packungsgröße
   per Regex (`4er-Pack`, `12ER-TRAY`, `4 x 0,5 l`, `6x`, `Tray mit 12 Dosen` …) inkl. Plausibilitätsprüfung
   (z. B. „12er-Tray 0,88 €“ = Dosenpreis → Gesamtpreis 10,56 €) und Zusatzangeboten wie
   „auch als 4er-Pack für 3,96 €“.
4. Prospekte gelten pro Kette und Region → jedes Angebot wird auf alle Filialen der Kette aus
   `data/stores.json` verteilt (mit Adresse und Koordinaten).
5. **Merge** mit der bestehenden `deals.json`:
   - abgelaufene Angebote (`validTo` < heute) fliegen raus,
   - Einträge einer **erfolgreichen** Quelle werden durch die frischen Daten ersetzt (`lastUpdated` = jetzt),
   - Einträge einer **ausgefallenen** Quelle bleiben bis zum Ablauf erhalten,
   - manuelle Einträge (deren `source` zu keiner Scraper-Quelle gehört) bleiben bis zum Ablauf erhalten,
   - Dubletten (gleiche Filiale, Packung, Preis, Startdatum aus mehreren Quellen) werden zusammengeführt.
6. **Fehlerbehandlung:** Ist eine Quelle nicht erreichbar oder hat sich ihre Struktur geändert, wird nur diese
   übersprungen, im Log und als ⚠️-Annotation im Actions-Lauf gemeldet. Der Lauf endet trotzdem erfolgreich.
   Jeder Lauf schreibt eine Übersichtstabelle in die Job-Summary.
7. `git diff --quiet -- data/deals.json` → nur bei Änderungen wird committet und gepusht (mit `GITHUB_TOKEN`).
8. Danach ruft der Workflow `deploy-pages.yml` direkt auf. Das ist nötig, weil Pushes mit `GITHUB_TOKEN`
   bewusst **keine** weiteren Workflows auslösen.

> Da `lastUpdated` bei jedem erfolgreichen Lauf neu gesetzt wird, entsteht normalerweise ein Commit pro Tag.
> Das hält die Anzeige „Daten zuletzt aktualisiert“ ehrlich und verhindert nebenbei, dass GitHub geplante
> Workflows nach 60 Tagen ohne Repo-Aktivität deaktiviert.

## Manuell auslösen

- **GitHub-Oberfläche:** Actions → „Angebote aktualisieren“ → *Run workflow*. Optional im Feld „only“ z. B.
  `marktguru,kaufda` eintragen, um nur bestimmte Quellen abzufragen.
- **CLI:** `gh workflow run update-deals.yml` bzw. `gh workflow run update-deals.yml -f only=marktguru`
- **Nur neu deployen:** Actions → „GitHub Pages deployen“ → *Run workflow*.

## Datenmodell `data/deals.json`

Array von Angeboten. Pflichtfelder wie spezifiziert, dazu einige optionale Zusatzfelder:

```json
{
  "id": "rewe-rewe-forststrasse-14-pack4-2026-09-14-3-96",
  "store": "Rewe Forststraße",
  "chain": "Rewe",
  "address": "Forststraße 14, 78224 Singen (Hohentwiel)",
  "lat": 47.754263, "lon": 8.861043,
  "product": "Monster Energy (versch. Sorten)",
  "packType": "pack4",
  "unitCount": 4,
  "volumeLiters": 0.5,
  "price": 3.96,
  "pricePerUnit": 0.99,
  "regularPrice": null,
  "validFrom": "2026-09-14",
  "validTo": "2026-09-19",
  "note": "4er-Pack laut Prospekt",
  "source": "https://www.marktguru.de/b/monster-energy",
  "sourceName": "marktguru",
  "lastUpdated": "2026-09-14T04:03:12Z"
}
```

| Feld | Bedeutung |
|---|---|
| `packType` | `single`, `pack4`, `pack6`, `pack10`, `pack12`, `pack24` … oder `multipack` (Größe unbekannt) |
| `pricePerUnit` | Preis pro Dose (bei `multipack` `null`) |
| `regularPrice` | Streich-/Normalpreis, nur wenn die Quelle einen nennt – sonst `null` (kein Rabatt-Chip) |
| `validFrom`/`validTo` | Kalendertage in Europe/Berlin, jeweils inklusive |
| `lat`/`lon` | optional; fehlen sie, sucht das Frontend die Filiale in `stores.json` |
| `note` | optional: App-Rabatte, Pfand, „Preis je Dose beim Kauf im 12er-Pack“ … |

**Manuelle Angebote** (z. B. Aushang im Markt) kann man direkt in `deals.json` eintragen. Solange `source`
nicht auf marktguru/kaufda/prospektangebote zeigt, lässt der Scraper sie bis zum Ablauf in Ruhe.

## Supermärkte und Quellen ergänzen

**Neue Filiale / fehlende Kette in Singen**
- Automatisch: `python scripts/update_stores.py` holt alle Supermärkte, Discounter und Getränkemärkte im
  Raum Singen aus OpenStreetMap (Overpass) und ergänzt fehlende Adressen per Nominatim.
- Von Hand: Eintrag in `data/stores.json` mit `"manual": true` anlegen, dann bleibt er auch beim nächsten
  `update_stores.py`-Lauf erhalten:
  ```json
  { "id": "globus-singen", "chain": "Globus", "name": "Globus Singen", "address": "Musterstraße 1, 78224 Singen (Hohentwiel)",
    "city": "Singen (Hohentwiel)", "lat": 47.76, "lon": 8.84, "manual": true }
  ```
- Neue Kette: Regex in `CHAIN_ALIASES` (`scripts/update_deals.py`) und `CHAIN_PATTERNS`
  (`scripts/update_stores.py`) ergänzen. Die Hausfarbe fürs Icon kommt in `CHAINS` in `app.js`, ohne
  Eintrag gibt es automatisch eine Farbe.

**Neue Quelle (weiterer Aggregator)**
1. In `update_deals.py` eine Funktion `fetch_xyz(session) -> list[Offer]` schreiben. Sie wirft bei Problemen
   `SourceError`, alles andere (Filial-Verteilung, Pack-Erkennung, Merge) passiert automatisch.
2. In `SOURCES` eintragen: `Source("xyz", "Xyz", "xyz.de", regional=True, fetch=fetch_xyz)`.
   `regional=False` heißt, die Quelle filtert nicht nach Standort. Dann werden nur Ketten mit Filiale in Singen
   übernommen.
3. Mit `python scripts/update_deals.py --only xyz --dry-run -v --debug-dir debug` testen.

Anderer Ort? `REGION` in `update_deals.py` sowie `BBOX`/`ALLOWED_POSTCODES`/`SINGEN_PARTS` in
`update_stores.py` anpassen. Die Box ist bewusst großzügig, eingegrenzt wird über die Postleitzahl.
Filialen in Singener Ortsteilen bekommen den Ortsteil in die Adresse, z. B. „78224 Singen-Bohlingen“.

## Grenzen & Hinweise

- Prospektpreise gelten für die Region. Ob eine einzelne Filiale mitmacht, kann abweichen,
  besonders bei selbstständigen Edeka- und Rewe-Kaufleuten.
- Preise sind in der Regel **zzgl. 0,25 € Pfand** pro Dose.
- Die Seiten der Aggregatoren können sich jederzeit ändern. Dann wird die Quelle übersprungen und im
  Actions-Log gewarnt, bis der Parser angepasst ist. prospektangebote.de nutzt einen Bot-Schutz, der von
  Rechenzentrums-IPs aus (GitHub-Runner) auch mal nicht durchkommt.
- Bitte die Nutzungsbedingungen der Quellen respektieren. Der Scraper läuft bewusst nur 1× täglich mit
  wenigen Requests und ist für private, nicht-kommerzielle Nutzung gedacht.
- Kein offizielles Angebot von Monster Energy. Filialdaten © OpenStreetMap-Mitwirkende (ODbL).
