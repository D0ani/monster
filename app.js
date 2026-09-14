/* ==========================================================================
   Monster-Angebote Singen – Frontend (Vanilla JS, ohne Framework)
   Lädt data/deals.json (+ optional data/stores.json) und rendert Filter,
   Angebotskarten und eine optionale Leaflet-Karte.
   ========================================================================== */
(() => {
  'use strict';

  const DATA_URL = 'data/deals.json';
  const STORES_URL = 'data/stores.json';
  const PRICES_URL = 'data/regular-prices.json';
  const TZ = 'Europe/Berlin';
  const CITIES_URL = 'data/cities.json';
  const HISTORY_URL = 'data/history.json';
  // Fallback, falls data/cities.json fehlt
  const DEFAULT_CITY = {
    slug: 'singen', name: 'Singen', label: 'Singen (Hohentwiel) mit allen Ortsteilen & Rielasingen-Worblingen',
    lat: 47.7597, lon: 8.8403, zips: ['78224', '78239'], aliases: [],
  };
  const STALE_AFTER_H = 36;
  const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
  const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';
  // Datensparmodus des Handys/Browsers ("Save-Data") → keine Logo-Bilder, nur Kürzel
  const SAVE_DATA = Boolean(navigator.connection && navigator.connection.saveData);
  // Kompaktes Datenpaket je Stadt (Angebote, Filialen, Verlauf) – statt alle Städte auf einmal
  const CITY_DATA_URL = (slug) => `data/city/${encodeURIComponent(slug)}.json`;

  // Ketten: echtes Logo (Wikimedia Commons, gemeinfrei – Nachweise in assets/logos/CREDITS.md),
  // Farben + Kürzel als Rückfall, falls es kein Logo gibt oder es nicht lädt
  const LOGO = (file) => `assets/logos/${file}.webp`;
  const CHAINS = {
    'Aldi Süd': { bg: '#1c2f7c', fg: '#ffffff', abbr: 'A', logo: LOGO('aldi-sued') },
    'Edeka': { bg: '#ffe500', fg: '#1a4696', abbr: 'E', logo: LOGO('edeka') },
    'Rewe': { bg: '#cc071e', fg: '#ffffff', abbr: 'R', logo: LOGO('rewe') },
    'Nahkauf': { bg: '#2f8a2f', fg: '#ffffff', abbr: 'nk', logo: LOGO('nahkauf') },
    'Lidl': { bg: '#0050aa', fg: '#fff000', abbr: 'L', logo: LOGO('lidl') },
    'Kaufland': { bg: '#e10915', fg: '#ffffff', abbr: 'K', logo: LOGO('kaufland') },
    'Netto': { bg: '#ffe500', fg: '#e30613', abbr: 'N', logo: LOGO('netto') },
    'Penny': { bg: '#cd1414', fg: '#ffffff', abbr: 'P', logo: LOGO('penny') },
    'Norma': { bg: '#004f9f', fg: '#ffffff', abbr: 'No', logo: LOGO('norma') },
    'Globus': { bg: '#e2231a', fg: '#ffffff', abbr: 'G', logo: LOGO('globus') },
    'tegut': { bg: '#ef7d00', fg: '#ffffff', abbr: 't', logo: LOGO('tegut') },
    'Marktkauf': { bg: '#005ca9', fg: '#ffe500', abbr: 'M', logo: LOGO('marktkauf') },
    'Trinkgut': { bg: '#e3000b', fg: '#ffffff', abbr: 'T', logo: LOGO('trinkgut') },
    'Fristo': { bg: '#009640', fg: '#ffffff', abbr: 'F', logo: LOGO('fristo') },
    'Getränke Hoffmann': { bg: '#003c7e', fg: '#ffffff', abbr: 'GH', logo: LOGO('getraenke-hoffmann') },
    'Getränke Müller': { bg: '#264653', fg: '#ffffff', abbr: 'GM' },
    'Rossmann': { bg: '#c3002d', fg: '#ffffff', abbr: 'Ro', logo: LOGO('rossmann') },
    'dm': { bg: '#0d3a78', fg: '#ffd500', abbr: 'dm', logo: LOGO('dm') },
    'Müller': { bg: '#f18700', fg: '#ffffff', abbr: 'Mü', logo: LOGO('mueller') },
  };

  const BASE_PACKS = [
    { key: 'all', label: 'Alle' },
    { key: 'single', label: 'Einzeln' },
    { key: 'pack4', label: '4er' },
    { key: 'pack6', label: '6er' },
    { key: 'pack10', label: '10er' },
  ];

  // when: 'all' | 'now' (jetzt gültig) | 'next' (ab nächster Woche / demnächst)
  const DEFAULT_STATE = { city: 'singen', chain: 'all', pack: 'all', sort: 'unit', when: 'all', showAll: false };
  const URL_KEYS = { city: 'stadt', chain: 'kette', pack: 'packung', sort: 'sort', when: 'zeitraum', showAll: 'alle' };

  const eur = new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' });
  const liters = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 3 });
  const dayFmt = new Intl.DateTimeFormat('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const stampFmt = new Intl.DateTimeFormat('de-DE', {
    day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: TZ,
  });
  const rtf = new Intl.RelativeTimeFormat('de', { numeric: 'auto', style: 'short' });

  const $ = (sel) => document.querySelector(sel);
  const el = {
    updated: $('#updated'),
    updatedText: $('#updated-text'),
    summary: $('#summary'),
    sort: $('#sort'),
    chainChips: $('#chain-chips'),
    packChips: $('#pack-chips'),
    whenChips: $('#when-chips'),
    upcomingBanner: $('#upcoming-banner'),
    showAll: $('#show-all'),
    cityInput: $('#city'),
    cityList: $('#city-list'),
    cityHint: $('#city-hint'),
    cityName: $('#city-name'),
    citySub: $('#city-sub'),
    cityRegion: $('#city-region'),
    nearBtn: $('#near-btn'),
    nearHint: $('#near-hint'),
    sortDistance: $('#sort option[value="distance"]'),
    historyPanel: $('#history-panel'),
    historyTitle: $('#history-title'),
    historySub: $('#history-sub'),
    historyChart: $('#history-chart'),
    historyTable: $('#history-table'),
    weeklyTitle: $('#weekly-title'),
    weeklySub: $('#weekly-sub'),
    weeklyChart: $('#weekly-chart'),
    appDownload: $('#app-download'),
    reset: $('#reset'),
    count: $('#result-count'),
    list: $('#deals'),
    empty: $('#empty'),
    mapToggle: $('#map-toggle'),
    mapWrap: $('#map-wrap'),
    map: $('#map'),
  };

  const state = { ...DEFAULT_STATE };
  let deals = [];        // normalisiert, ohne abgelaufene
  let knownChains = [];  // Ketten aus dem Filialverzeichnis
  let allStores = [];    // komplettes Filialverzeichnis (für "Alle Filialen zeigen")
  let regularPrices = {}; // zuletzt gesehener Normalpreis pro Dose je Kette
  let noDealStores = []; // aktuell angezeigte Filialen ohne Angebot
  const cityBundles = new Map(); // bereits geladene Stadt-Pakete (Stadtwechsel zurück kostet nichts)
  let cities = [DEFAULT_CITY];
  let priceHistory = {}; // Preisverlauf je Stadt: { slug: { "YYYY-MM-DD": { p, c } } }
  let userPos = null;    // Standort für "In meiner Nähe" – nur im Speicher, wird nirgends abgelegt
  let expiredCount = 0;
  let today = todayISO();
  let visible = [];
  const mapState = { map: null, layer: null, markers: new Map(), loading: null };

  /* ---------------- Hilfsfunktionen ---------------- */

  function esc(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function fold(value) {
    return String(value ?? '')
      .toLowerCase()
      .replace(/ß/g, 'ss')
      .normalize('NFD')
      .replace(/[̀-ͯ]/g, '');
  }

  function todayISO() {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
  }

  const fmtDay = (iso) => dayFmt.format(new Date(`${iso}T00:00:00Z`));

  function relTime(date) {
    const diff = (date.getTime() - Date.now()) / 1000;
    const abs = Math.abs(diff);
    if (abs < 60) return 'gerade eben';
    if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
    if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
    return rtf.format(Math.round(diff / 86400), 'day');
  }

  function chainStyle(chain) {
    if (CHAINS[chain]) return SAVE_DATA ? { ...CHAINS[chain], logo: null } : CHAINS[chain];
    let hash = 0;
    for (const ch of String(chain)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return { bg: `hsl(${hash} 55% 38%)`, fg: '#ffffff', abbr: String(chain).slice(0, 2) };
  }

  const styleVars = (s) => `--bg-c:${s.bg};--fg-c:${s.fg}`;

  // Ketten-Kachel für Karten: Logo auf weißer Kachel, sonst farbiges Kürzel
  function chainBadge(chain) {
    const cs = chainStyle(chain);
    if (!cs.logo) {
      return `<span class="chain-badge" style="${styleVars(cs)}" title="${esc(chain)}" aria-hidden="true">${esc(cs.abbr)}</span>`;
    }
    return `<span class="chain-badge has-logo" title="${esc(chain)}">`
      + `<img src="${esc(cs.logo)}" alt="${esc(chain)}" loading="lazy" decoding="async"></span>`;
  }

  // Kleines Logo in den Markt-Chips (statt Farbpunkt)
  function chipMark(chain) {
    const cs = chainStyle(chain);
    return cs.logo
      ? `<span class="chip-logo" aria-hidden="true"><img src="${esc(cs.logo)}" alt="" loading="lazy" decoding="async"></span>`
      : `<span class="chip-dot" style="${styleVars(cs)}" aria-hidden="true"></span>`;
  }

  // Karten-Pin: Logo auf weißem Schild, sonst runder Kürzel-Pin
  function pinIcon(chain, extraClass = '') {
    const cs = chainStyle(chain);
    const html = cs.logo
      ? `<span class="pin pin--logo ${extraClass}"><img src="${esc(cs.logo)}" alt=""></span>`
      : `<span class="pin ${extraClass}" style="--pin-bg:${cs.bg};--pin-fg:${cs.fg}">${esc(cs.abbr)}</span>`;
    const size = cs.logo ? [48, 32] : [34, 34];
    return window.L.divIcon({
      className: '', html, iconSize: size, iconAnchor: [size[0] / 2, size[1] / 2], popupAnchor: [0, -size[1] / 2],
    });
  }

  function unitsOf(packType) {
    const m = /^pack(\d+)$/.exec(packType);
    return m ? Number(m[1]) : packType === 'single' ? 1 : 999;
  }

  function packLabel(d) {
    if (d.packType === 'single') return 'Einzeldose';
    if (/^pack\d+$/.test(d.packType)) return `${unitsOf(d.packType)}er-Pack`;
    return 'Multipack';
  }

  function packChipLabel(key) {
    const base = BASE_PACKS.find((p) => p.key === key);
    if (base) return base.label;
    return /^pack\d+$/.test(key) ? `${unitsOf(key)}er` : 'Sonstige';
  }

  function splitProduct(name) {
    const m = /^(.*?)\s*\((.+)\)\s*$/.exec(name || '');
    return m ? [m[1], m[2]] : [name || 'Monster Energy', ''];
  }

  function sourceName(d) {
    if (d.sourceName) return d.sourceName;
    try {
      return new URL(d.source).hostname.replace(/^www\./, '');
    } catch {
      return d.source || '';
    }
  }

  const storeKey = (d) => `${d.store}|${d.address}`;

  /* ---------------- Daten ---------------- */

  function normalize(raw, storesByKey) {
    const price = Number(raw.price);
    if (!raw || !raw.chain || !Number.isFinite(price)) return null;
    const unitCount = Number(raw.unitCount) || (raw.packType === 'single' ? 1 : null);
    const packType = raw.packType || (unitCount > 1 ? `pack${unitCount}` : 'single');
    const perUnit = raw.pricePerUnit != null ? Number(raw.pricePerUnit) : unitCount ? price / unitCount : null;
    const regular = Number(raw.regularPrice) > price ? Number(raw.regularPrice) : null;
    const discount = regular ? Math.round((1 - price / regular) * 100) : null;

    let status = 'active';
    if (raw.validTo && raw.validTo < today) status = 'expired';
    else if (raw.validFrom && raw.validFrom > today) status = 'upcoming';

    // Koordinaten aus dem Filialverzeichnis ergänzen, falls im Angebot nicht enthalten
    let { lat, lon } = raw;
    if ((lat == null || lon == null) && storesByKey) {
      const s = storesByKey.get(fold(`${raw.store}|${raw.address}`));
      if (s) ({ lat, lon } = s);
    }

    return {
      ...raw,
      price,
      unitCount,
      packType,
      pricePerUnit: Number.isFinite(perUnit) ? perUnit : null,
      regularPrice: regular,
      discount,
      status,
      lat: lat != null ? Number(lat) : null,
      lon: lon != null ? Number(lon) : null,
      sourceLabel: sourceName(raw),
      updatedAt: raw.lastUpdated ? new Date(raw.lastUpdated) : null,
      appRequired: Boolean(raw.app && raw.app.required),
    };
  }

  async function fetchJSON(url) {
    const res = await fetch(url, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
    return res.json();
  }

  async function load() {
    renderSkeleton();
    const cityList = await fetchJSON(CITIES_URL).catch(() => []); // Städteliste ist optional
    if (Array.isArray(cityList) && cityList.length) cities = cityList;
    if (!cities.some((c) => c.slug === state.city)) state.city = (cities.find((c) => c.default) || cities[0]).slug;
    renderCityOptions();
    await applyCity();
  }

  // Lädt nur die Daten EINER Stadt (wenige KB). Fehlt das Paket (älterer Datenstand),
  // wird auf die großen Gesamtdateien zurückgegriffen.
  async function loadCityData(slug) {
    if (cityBundles.has(slug)) return cityBundles.get(slug);
    let bundle;
    try {
      bundle = await fetchJSON(CITY_DATA_URL(slug));
    } catch {
      const [rawDeals, stores, prices, history] = await Promise.all([
        fetchJSON(DATA_URL),
        fetchJSON(STORES_URL).catch(() => []),
        fetchJSON(PRICES_URL).catch(() => ({})),
        fetchJSON(HISTORY_URL).catch(() => ({})),
      ]);
      const list = Array.isArray(rawDeals) ? rawDeals : rawDeals.deals || [];
      bundle = {
        deals: list.filter((d) => cityOf(d) === slug),
        stores: stores.filter((s) => (s.cities || [DEFAULT_CITY.slug]).includes(slug)),
        history: history[slug] || {},
        prices,
      };
    }
    cityBundles.set(slug, bundle);
    return bundle;
  }

  /* ---------------- Städte ---------------- */

  const cityOf = (item) => item.city || DEFAULT_CITY.slug; // alte Einträge ohne "city" gehören zu Singen
  const currentCity = () => cities.find((c) => c.slug === state.city) || cities[0] || DEFAULT_CITY;

  // Datenpaket der gewählten Stadt laden, übernehmen und alles neu zeichnen
  async function applyCity() {
    const city = currentCity();
    document.body.classList.add('is-loading');
    let bundle;
    try {
      bundle = await loadCityData(city.slug);
    } catch (err) {
      renderError(err);
      return;
    } finally {
      document.body.classList.remove('is-loading');
    }
    if (city.slug !== currentCity().slug) return; // inzwischen wurde eine andere Stadt gewählt
    allStores = bundle.stores || [];
    regularPrices = bundle.prices || {};
    priceHistory = { [city.slug]: bundle.history || {} };
    knownChains = [...new Set(allStores.map((s) => s.chain))];
    const storesByKey = new Map(allStores.map((s) => [fold(`${s.name}|${s.address}`), s]));
    const cityDeals = (bundle.deals || []).map((d) => normalize({ ...d, city: city.slug }, storesByKey)).filter(Boolean);
    renderUpdated(bundle.deals || [], bundle.updated);
    expiredCount = cityDeals.filter((d) => d.status === 'expired').length;
    deals = cityDeals.filter((d) => d.status !== 'expired');
    if (state.chain !== 'all' && !knownChains.includes(state.chain) && !deals.some((d) => d.chain === state.chain)) {
      state.chain = 'all';
    }
    el.cityName.textContent = city.name;
    el.citySub.textContent = `${city.label} · täglich aktualisiert`;
    el.cityRegion.textContent = `Energy-Deals · ${city.region || 'Landkreis Konstanz'}`;
    el.cityInput.value = '';
    el.cityInput.placeholder = `${city.name} · andere Stadt oder PLZ suchen …`;
    document.title = `Monster-Angebote ${city.name}`;
    update();
  }

  function renderCityOptions() {
    el.cityList.innerHTML = cities
      .map((c) => `<option value="${esc(c.name)}">${c.label !== c.name ? esc(c.label) : ''}</option>`).join('');
  }

  // Suche nach Stadtname, Gemeinde, Ortsteil (aliases) oder PLZ:
  // exakt → Wortanfang (auch Ortsteile) → "enthält" nur im Stadtnamen (sonst findet "Berlin" z. B. "Berliner Hof")
  function findCity(query) {
    const q = fold(query.trim());
    if (!q) return null;
    const own = (c) => [c.name, c.label, c.slug].map(fold);
    const aliases = (c) => (c.aliases || []).map(fold);
    const wordStart = (n) => n.startsWith(q) || n.split(/[\s(-]+/).some((w) => w.startsWith(q));
    // Städtenamen schlagen Ortsteile: "Mühlhausen" → Mühlhausen-Ehingen, nicht Stuttgart-Mühlhausen
    return cities.find((c) => own(c).includes(q) || (c.zips || []).includes(q))
      || cities.find((c) => own(c).some(wordStart))
      || cities.find((c) => aliases(c).includes(q))
      || cities.find((c) => aliases(c).some(wordStart) || (c.zips || []).some((z) => z.startsWith(q)))
      || cities.find((c) => own(c).some((n) => n.includes(q)));
  }

  function selectCity(query, { exactOnly = false } = {}) {
    if (!query.trim()) {
      el.cityHint.hidden = true;
      return;
    }
    const city = findCity(query);
    if (!city || (exactOnly && fold(city.name) !== fold(query.trim()))) {
      if (!exactOnly) {
        el.cityHint.textContent = `Für „${query.trim()}“ gibt es noch keine Daten. Verfügbar: ${cities.map((c) => c.name).join(', ')}.`;
        el.cityHint.hidden = false;
      }
      return;
    }
    el.cityHint.hidden = true;
    el.cityInput.blur();
    if (city.slug !== state.city) {
      state.city = city.slug;
      applyCity();
    } else {
      el.cityInput.value = '';
    }
  }

  /* ---------------- Filtern & Sortieren ---------------- */

  function matches(d, ignore) {
    if (ignore !== 'chain' && state.chain !== 'all' && d.chain !== state.chain) return false;
    if (ignore !== 'pack' && state.pack !== 'all' && d.packType !== state.pack) return false;
    if (ignore !== 'when' && state.when === 'now' && d.status !== 'active') return false;
    if (ignore !== 'when' && state.when === 'next' && d.status !== 'upcoming') return false;
    return true;
  }

  // Kettengröße: bei gleichem Preis stehen große Ketten vor kleinen (Index = Rang, nicht gelistet = ganz hinten)
  const CHAIN_RANK = ['Edeka', 'Rewe', 'Lidl', 'Aldi Süd', 'Kaufland', 'Netto', 'Penny', 'dm', 'Rossmann', 'Globus',
    'Norma', 'Müller', 'Marktkauf', 'tegut', 'Nahkauf', 'Trinkgut', 'Getränke Hoffmann', 'Fristo', 'Getränke Müller'];
  const chainRank = (chain) => {
    const i = CHAIN_RANK.indexOf(chain);
    return i === -1 ? CHAIN_RANK.length : i;
  };

  // Preise centgenau vergleichen (0.99 vs. 0.9900000001 gilt als gleich)
  const byCents = (a, b) => Math.round((a ?? 1e6) * 100) - Math.round((b ?? 1e6) * 100);
  // main = gewählte Sortierung; bei Gleichstand entscheidet die Kettengröße, danach tie
  const SORTERS = {
    unit: { main: (a, b) => byCents(a.pricePerUnit, b.pricePerUnit), tie: (a, b) => byCents(a.price, b.price) },
    total: { main: (a, b) => byCents(a.price, b.price), tie: (a, b) => byCents(a.pricePerUnit, b.pricePerUnit) },
    discount: {
      main: (a, b) => (b.discount ?? -1) - (a.discount ?? -1) || byCents(a.pricePerUnit, b.pricePerUnit),
      tie: (a, b) => byCents(a.price, b.price),
    },
    // nur mit freigegebenem Standort wählbar ("In meiner Nähe")
    distance: {
      main: (a, b) => (distanceKm(a.lat, a.lon) ?? 1e6) - (distanceKm(b.lat, b.lon) ?? 1e6),
      tie: (a, b) => byCents(a.pricePerUnit, b.pricePerUnit),
    },
  };

  function compareDeals(a, b, sortKey = state.sort) {
    const sorter = SORTERS[sortKey] || SORTERS.unit;
    return Number(a.appRequired) - Number(b.appRequired)                  // 1. ohne App-Pflicht zuerst
      || (a.status === 'active' ? 0 : 1) - (b.status === 'active' ? 0 : 1) // 2. aktuell vor demnächst
      || sorter.main(a, b)                                                 // 3. gewählte Sortierung
      || chainRank(a.chain) - chainRank(b.chain)                           // 4. gleicher Preis: große Kette zuerst
      || sorter.tie(a, b)
      || a.store.localeCompare(b.store, 'de');
  }

  const sortDeals = (list) => list.sort((a, b) => compareDeals(a, b));

  function countBy(list, fn) {
    const counts = new Map();
    for (const d of list) counts.set(fn(d), (counts.get(fn(d)) || 0) + 1);
    return counts;
  }

  /* ---------------- Rendering ---------------- */

  function chip(value, label, count, pressed, extra = '', enabled = false) {
    const disabled = !enabled && !pressed && count === 0 && value !== 'all';
    return `<button type="button" class="chip" data-value="${esc(value)}" aria-pressed="${pressed}"${disabled ? ' disabled' : ''}>`
      + `${extra}<span>${esc(label)}</span><span class="chip-count">${count}</span></button>`;
  }

  function renderChips() {
    const chainCounts = countBy(deals.filter((d) => matches(d, 'chain')), (d) => d.chain);
    const chains = [...new Set([...knownChains, ...deals.map((d) => d.chain)])]
      .sort((a, b) => (chainCounts.get(b) || 0) - (chainCounts.get(a) || 0) || chainRank(a) - chainRank(b));
    const chainTotal = [...chainCounts.values()].reduce((s, n) => s + n, 0);
    el.chainChips.innerHTML = chip('all', 'Alle', chainTotal, state.chain === 'all')
      + chains.map((c) => chip(c, c, chainCounts.get(c) || 0, state.chain === c,
        chipMark(c),
        state.showAll && knownChains.includes(c))).join(''); // mit "Alle Filialen" auch Ketten ohne Angebot wählbar

    const packCounts = countBy(deals.filter((d) => matches(d, 'pack')), (d) => d.packType);
    const extraPacks = [...packCounts.keys()]
      .filter((k) => !BASE_PACKS.some((p) => p.key === k))
      .sort((a, b) => unitsOf(a) - unitsOf(b));
    const packTotal = [...packCounts.values()].reduce((s, n) => s + n, 0);
    el.packChips.innerHTML = [...BASE_PACKS.map((p) => p.key), ...extraPacks]
      .map((k) => chip(k, packChipLabel(k), k === 'all' ? packTotal : packCounts.get(k) || 0, state.pack === k))
      .join('');

    // Zeitraum: Alle · Jetzt gültig · Nächste Woche (bzw. "Demnächst", wenn der Start noch in dieser Woche liegt)
    const whenBase = deals.filter((d) => matches(d, 'when'));
    const upcoming = whenBase.filter((d) => d.status === 'upcoming');
    el.whenChips.innerHTML = chip('all', 'Alle', whenBase.length, state.when === 'all')
      + chip('now', 'Jetzt gültig', whenBase.length - upcoming.length, state.when === 'now')
      + chip('next', upcoming.length ? upcomingLabel(upcoming, true) : 'Nächste Woche', upcoming.length, state.when === 'next');
  }

  // Montag der kommenden Woche (YYYY-MM-DD)
  function nextMondayISO() {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 7 - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  }

  // "Nächste Woche · ab Mo., 21.09." bzw. "Demnächst · ab Do., 17.09." (short = nur der erste Teil)
  function upcomingLabel(list, short = false) {
    const first = list.map((d) => d.validFrom).filter(Boolean).sort()[0];
    const label = first && first >= nextMondayISO() ? 'Nächste Woche' : 'Demnächst';
    return short || !first ? label : `${label} · ab ${fmtDay(first)}`;
  }

  // generated = Zeitpunkt des Scraper-Laufs (aus dem Stadt-Paket), sonst neuester lastUpdated-Wert
  function renderUpdated(list, generated) {
    const stamps = (generated ? [generated] : list.map((d) => d.lastUpdated)).map((s) => Date.parse(s)).filter(Number.isFinite);
    if (!stamps.length) {
      el.updatedText.textContent = 'Noch keine Daten vorhanden';
      return;
    }
    const newest = new Date(Math.max(...stamps));
    const [date, time] = stampFmt.format(newest).split(', ');
    el.updatedText.textContent = `Daten zuletzt aktualisiert am ${date} um ${time} Uhr (${relTime(newest)})`;
    el.updated.classList.toggle('is-stale', Date.now() - newest.getTime() > STALE_AFTER_H * 3600e3);
  }

  function renderSummary() {
    // In der Ansicht "Nächste Woche" zeigt die Kachel den günstigsten kommenden Preis
    const wantNext = state.when === 'next';
    const upcomingAll = deals.filter((d) => d.status === 'upcoming');
    const active = deals.filter((d) => d.status === (wantNext ? 'upcoming' : 'active') && d.pricePerUnit != null);
    if (!deals.length) {
      el.summary.innerHTML = '';
      return;
    }
    // App-Preise zählen nur, wenn es gar kein Angebot ohne App gibt
    const withoutApp = active.filter((d) => !d.appRequired);
    const best = (withoutApp.length ? withoutApp : active).slice().sort((a, b) => compareDeals(a, b, 'unit'))[0];
    const chains = new Set(deals.map((d) => d.chain));
    const stores = new Set(deals.map(storeKey));
    el.summary.innerHTML = `
      <div class="stat stat--hero">
        <p class="stat-label">${wantNext && upcomingAll.length ? `Günstigste Dose · ${esc(upcomingLabel(upcomingAll))}` : 'Günstigste Dose heute'}</p>
        <p class="stat-value">${best ? eur.format(best.pricePerUnit) : '–'}</p>
        <p class="stat-sub">${best ? `${esc(best.chain)} · ${esc(packLabel(best))}${best.appRequired ? ' · nur mit App' : ''}` : 'aktuell kein gültiges Angebot'}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Angebote</p>
        <p class="stat-value">${deals.length}</p>
        <p class="stat-sub">in ${stores.size} ${stores.size === 1 ? 'Filiale' : 'Filialen'}${upcomingAll.length ? ` · ${upcomingAll.length} demnächst` : ''}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Ketten</p>
        <p class="stat-value">${chains.size}</p>
        <p class="stat-sub">${esc([...chains].sort((a, b) => a.localeCompare(b, 'de')).join(', '))}</p>
      </div>`;
  }

  const CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>';
  const LOCATE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><circle cx="12" cy="12" r="7.5"/><path d="M12 1.8v2.7M12 19.5v2.7M1.8 12h2.7M19.5 12h2.7"/></svg>';
  const PIN_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/></svg>';

  // Text für die App-Pille: Preis nur mit App / mit App günstiger / Bonus mit App
  function appText(app) {
    const name = app.name || 'App';
    if (app.required) return `Preis nur mit ${name}`;
    if (app.price) return `Mit ${name} nur ${eur.format(app.price)}`;
    if (app.bonus) return `Mit ${name} +${eur.format(app.bonus)} Bonus`;
    return app.text || `Extra-Rabatt mit ${name}`;
  }

  const appPill = (app) => `<p class="app-pill${app.required ? ' app-pill--required' : ''}">${PHONE_ICON}<span>${esc(appText(app))}</span></p>`;

  function cardHTML(d, isBest) {
    const [productMain, productSub] = splitProduct(d.product);

    let statusText = 'aktuell gültig';
    let statusCls = 'active';
    if (d.status === 'upcoming') {
      statusText = `ab ${fmtDay(d.validFrom)}`;
      statusCls = 'upcoming';
    } else if (d.validTo === today) {
      statusText = 'nur noch heute';
      statusCls = 'last';
    }

    const osm = d.lat != null
      ? `https://www.openstreetmap.org/?mlat=${d.lat}&mlon=${d.lon}#map=18/${d.lat}/${d.lon}`
      : `https://www.openstreetmap.org/search?query=${encodeURIComponent(d.address || d.store)}`;

    const volume = d.volumeLiters
      ? `<span class="tag">${d.unitCount > 1 ? `${d.unitCount} × ` : ''}${liters.format(d.volumeLiters)} l</span>`
      : '';

    const isSingle = d.packType === 'single';
    const unitLine = !isSingle && d.pricePerUnit != null
      ? `<span class="unit"><b>${eur.format(d.pricePerUnit)}</b> pro Dose</span>`
      : isSingle ? '<span class="unit">pro Dose</span>' : '';

    const validity = d.validFrom && d.validTo
      ? `${fmtDay(d.validFrom)} – ${fmtDay(d.validTo)}`
      : d.validTo ? `bis ${fmtDay(d.validTo)}` : 'Zeitraum unbekannt';

    const fresh = d.updatedAt && !Number.isNaN(d.updatedAt.getTime())
      ? `zuletzt aktualisiert: ${relTime(d.updatedAt)}`
      : '';
    const src = d.source && /^https?:/.test(d.source)
      ? `<a href="${esc(d.source)}" target="_blank" rel="noopener">${esc(d.sourceLabel)}</a>`
      : esc(d.sourceLabel);

    return `
      <article class="card${isBest ? ' is-best' : ''}${d.status === 'upcoming' ? ' is-upcoming' : ''}">
        ${isBest ? '<span class="best-flag">Bestpreis</span>' : ''}
        <header class="card-head">
          ${chainBadge(d.chain)}
          <div class="store">
            <h3>${esc(d.store)}</h3>
            <p class="addr"><a href="${esc(osm)}" target="_blank" rel="noopener">${esc(d.address || 'Adresse unbekannt')}</a></p>
            ${distLine(d.lat, d.lon)}
          </div>
          <span class="status status--${statusCls}">${esc(statusText)}</span>
        </header>

        <p class="product">${esc(productMain)}${productSub ? `<small>${esc(productSub)}</small>` : ''}</p>
        <div class="tags"><span class="tag tag--pack">${esc(packLabel(d))}</span>${volume}${lowBadge(d)}</div>

        <div class="price-row">
          <span class="price"><strong>${eur.format(d.price)}</strong>${d.regularPrice ? `<s aria-label="statt">${eur.format(d.regularPrice)}</s>` : ''}</span>
          ${unitLine}
          ${d.discount ? `<span class="discount">−${d.discount}&nbsp;%</span>` : ''}
        </div>
        ${d.app ? appPill(d.app) : ''}
        ${d.note ? `<p class="note">${esc(d.note)}</p>` : ''}

        <footer class="card-foot">
          <span class="validity">${CAL_ICON}${esc(validity)}</span>
          ${d.lat != null ? `<button type="button" class="map-link" data-store="${esc(storeKey(d))}">Auf Karte zeigen</button>` : ''}
          <span class="fresh">${esc(fresh)}${fresh && src ? ' · ' : ''}${src}</span>
        </footer>
      </article>`;
  }

  const storeKeyOf = (s) => `${s.name}|${s.address}`;

  // Karte für eine Filiale ohne Angebot – mit zuletzt gesehenem Normalpreis der Kette, falls bekannt
  function storeCardHTML(s) {
    const known = regularPrices[s.chain];
    const osm =`https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}`;
    const price = known && known.pricePerUnit
      ? `<p class="store-price">${known.manual ? 'Normalpreis (eigene Angabe)' : 'Normalpreis zuletzt laut Prospekt'}: `
        + `<b>${eur.format(known.pricePerUnit)}</b> pro Dose${known.seen ? ` · Stand ${esc(fmtDay(known.seen))}` : ''}</p>`
      : '<p class="store-price">Kein Monster-Angebot im aktuellen Prospekt · Normalpreis nicht bekannt</p>';
    return `
      <article class="card card--store">
        <header class="card-head">
          ${chainBadge(s.chain)}
          <div class="store">
            <h3>${esc(s.name)}</h3>
            <p class="addr"><a href="${esc(osm)}" target="_blank" rel="noopener">${esc(s.address)}</a></p>
            ${distLine(s.lat, s.lon)}
          </div>
          <span class="status status--none">kein Angebot</span>
        </header>
        ${price}
        <footer class="card-foot">
          ${s.lat != null ? `<button type="button" class="map-link" data-store="${esc(storeKeyOf(s))}">Auf Karte zeigen</button>` : ''}
        </footer>
      </article>`;
  }

  function renderList() {
    visible = sortDeals(deals.filter((d) => matches(d)));
    // Aktuelle und kommende Angebote getrennt – kommende bekommen einen eigenen Abschnitt
    const nowDeals = visible.filter((d) => d.status !== 'upcoming');
    const nextDeals = visible.filter((d) => d.status === 'upcoming');
    const cards = (list) => {
      const priced = list.filter((d) => d.pricePerUnit != null && !d.appRequired);
      const bestUnit = Math.min(...priced.map((d) => d.pricePerUnit));
      // "Bestpreis" nur zeigen, wenn es überhaupt teurere Alternativen gibt – sonst sagt das Label nichts aus
      const showBest = priced.some((d) => d.pricePerUnit - bestUnit >= 0.005);
      return list.map((d) => cardHTML(d, showBest && !d.appRequired && Math.abs(d.pricePerUnit - bestUnit) < 0.005)).join('');
    };
    const nextHeading = nextDeals.length && nowDeals.length
      ? `<h2 class="grid-heading grid-heading--next">${esc(upcomingLabel(nextDeals))} (${nextDeals.length})</h2>` : '';

    // Hinweis-Leiste, sobald Angebote für nächste Woche online sind
    const upcomingHere = deals.filter((d) => d.status === 'upcoming' && matches(d, 'when'));
    el.upcomingBanner.hidden = state.when === 'next' || !upcomingHere.length;
    if (upcomingHere.length) {
      const n = upcomingHere.length;
      el.upcomingBanner.innerHTML = `${CAL_ICON}<span>${esc(`Schon da: ${n} ${n === 1 ? 'Angebot' : 'Angebote'} · ${upcomingLabel(upcomingHere)} – jetzt ansehen`)}</span>`;
    }

    // "Alle Filialen zeigen": Filialen ohne irgendein Angebot ergänzen (Packungs-Filter spielt hier keine Rolle)
    const withDeals = new Set(deals.map(storeKey));
    noDealStores = state.showAll
      ? allStores
        .filter((s) => !withDeals.has(storeKeyOf(s)) && (state.chain === 'all' || s.chain === state.chain))
        .sort((a, b) => (state.sort === 'distance' && userPos
          ? distanceKm(a.lat, a.lon) - distanceKm(b.lat, b.lon)
          : chainRank(a.chain) - chainRank(b.chain)) || a.name.localeCompare(b.name, 'de'))
      : [];

    el.list.innerHTML = cards(nowDeals) + nextHeading + cards(nextDeals)
      + (noDealStores.length
        ? `<h2 class="grid-heading">Filialen ohne Monster-Angebot (${noDealStores.length})</h2>${noDealStores.map(storeCardHTML).join('')}`
        : '');
    el.empty.hidden = visible.length > 0 || noDealStores.length > 0;

    const noDeal = noDealStores.length ? ` · ${noDealStores.length} Filialen ohne Angebot` : '';
    const hiddenExpired = expiredCount ? ` · ${expiredCount} abgelaufene ausgeblendet` : '';
    el.count.innerHTML = `<strong>${visible.length}</strong> von ${deals.length} Angeboten${noDeal}${hiddenExpired}`;
  }

  function renderSkeleton() {
    el.list.innerHTML = Array.from({ length: 3 }, () => `
      <div class="card skeleton" aria-hidden="true">
        <div class="sk" style="height:44px;width:60%"></div>
        <div class="sk" style="height:18px;width:80%;margin-top:18px"></div>
        <div class="sk" style="height:40px;width:45%;margin-top:22px"></div>
      </div>`).join('');
  }

  function renderError(err) {
    el.updated.classList.add('is-error');
    el.updatedText.textContent = 'Daten konnten nicht geladen werden';
    const local = location.protocol === 'file:'
      ? '<p>Die Seite wurde direkt als Datei geöffnet. Browser blockieren dann <code>fetch()</code> – starte lokal einen Webserver, z. B. <code>python -m http.server</code>, und öffne <code>http://localhost:8000</code>.</p>'
      : '';
    el.list.innerHTML = `
      <div class="panel empty error-box">
        <p class="empty-title">Fehler beim Laden der Angebote</p>
        <p>${esc(err.message)}</p>${local}
      </div>`;
    el.count.textContent = '';
  }

  function update() {
    today = todayISO();
    renderSummary();
    renderChips();
    renderList();
    renderMap();
    renderHistory();
    writeURL();
  }

  /* ---------------- URL-Status (teilbare Filter) ---------------- */

  function readURL() {
    const p = new URLSearchParams(location.search);
    if (p.has(URL_KEYS.chain)) state.chain = p.get(URL_KEYS.chain);
    if (p.has(URL_KEYS.pack)) state.pack = p.get(URL_KEYS.pack);
    if (SORTERS[p.get(URL_KEYS.sort)]) state.sort = p.get(URL_KEYS.sort);
    if (state.sort === 'distance') state.sort = 'unit'; // Standort wird bewusst nicht gespeichert
    const when = p.get(URL_KEYS.when);
    if (when === 'now' || when === 'next') state.when = when;
    else if (p.get('gueltig') === '1') state.when = 'now'; // alte Links ("Nur heute gültige")
    state.showAll = p.get(URL_KEYS.showAll) === '1';
    if (p.has(URL_KEYS.city)) state.city = p.get(URL_KEYS.city);
  }

  function writeURL() {
    const p = new URLSearchParams();
    for (const [key, param] of Object.entries(URL_KEYS)) {
      if (state[key] === DEFAULT_STATE[key]) continue;
      p.set(param, typeof state[key] === 'boolean' ? '1' : state[key]);
    }
    const qs = p.toString();
    history.replaceState(null, '', qs ? `?${qs}` : location.pathname);
  }

  function syncControls() {
    el.sort.value = state.sort;
    el.showAll.checked = state.showAll;
  }

  /* ---------------- Karte (Leaflet, lazy) ---------------- */

  function loadLeaflet() {
    if (window.L) return Promise.resolve(window.L);
    if (mapState.loading) return mapState.loading;
    mapState.loading = new Promise((resolve, reject) => {
      const css = document.createElement('link');
      css.rel = 'stylesheet';
      css.href = LEAFLET_CSS;
      document.head.append(css);
      const js = document.createElement('script');
      js.src = LEAFLET_JS;
      js.onload = () => resolve(window.L);
      js.onerror = () => reject(new Error('Leaflet konnte nicht geladen werden.'));
      document.head.append(js);
    });
    return mapState.loading;
  }

  async function showMap() {
    el.mapWrap.hidden = false;
    el.mapToggle.textContent = 'Karte ausblenden';
    el.mapToggle.setAttribute('aria-expanded', 'true');
    if (!mapState.map) {
      try {
        const L = await loadLeaflet();
        mapState.map = L.map(el.map, { scrollWheelZoom: false }).setView([currentCity().lat, currentCity().lon], 13);
        L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
          maxZoom: 19,
          attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
        }).addTo(mapState.map);
        mapState.layer = L.layerGroup().addTo(mapState.map);
      } catch (err) {
        el.map.innerHTML = `<p class="map-error">${esc(err.message)}</p>`;
        return;
      }
    }
    mapState.map.invalidateSize();
    renderMap(true);
  }

  function hideMap() {
    el.mapWrap.hidden = true;
    el.mapToggle.textContent = 'Karte anzeigen';
    el.mapToggle.setAttribute('aria-expanded', 'false');
  }

  function renderMap(fit = true) {
    if (!mapState.map || el.mapWrap.hidden) return;
    const { L } = window;
    mapState.layer.clearLayers();
    mapState.markers.clear();

    const groups = new Map();
    for (const d of visible) {
      if (d.lat == null || d.lon == null) continue;
      const key = storeKey(d);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(d);
    }

    for (const [key, items] of groups) {
      const first = items[0];
      const icon = pinIcon(first.chain);
      const rows = items.map((d) => `<li>${esc(packLabel(d))}: <b>${eur.format(d.price)}</b>`
        + `${d.packType !== 'single' && d.pricePerUnit != null ? ` (${eur.format(d.pricePerUnit)}/Dose)` : ''}`
        + `${d.app ? `<br><small>${esc(appText(d.app))}</small>` : ''}</li>`).join('');
      const marker = L.marker([first.lat, first.lon], { icon, title: first.store })
        .bindPopup(`<p class="popup-title">${esc(first.store)}</p><p class="popup-addr">${esc(first.address)}</p><ul class="popup-list">${rows}</ul>`);
      marker.addTo(mapState.layer);
      mapState.markers.set(key, marker);
    }

    // Filialen ohne Angebot: graue, gedimmte Pins (liegen unter den Angebots-Pins)
    const noDealPoints = [];
    for (const s of noDealStores) {
      if (s.lat == null || s.lon == null) continue;
      const known = regularPrices[s.chain];
      const icon = pinIcon(s.chain, 'pin--none');
      const info = known && known.pricePerUnit
        ? `<br><small>Normalpreis zuletzt: ${eur.format(known.pricePerUnit)}/Dose</small>` : '';
      const marker = L.marker([s.lat, s.lon], { icon, title: s.name, zIndexOffset: -500 })
        .bindPopup(`<p class="popup-title">${esc(s.name)}</p><p class="popup-addr">${esc(s.address)}</p>`
          + `<ul class="popup-list"><li>Kein Monster-Angebot${info}</li></ul>`);
      marker.addTo(mapState.layer);
      mapState.markers.set(storeKeyOf(s), marker);
      noDealPoints.push([s.lat, s.lon]);
    }

    const points = [...[...groups.values()].map((g) => [g[0].lat, g[0].lon]), ...noDealPoints];
    // Eigener Standort ("In meiner Nähe") als Punkt – nur in den Kartenausschnitt, wenn er in der Stadt liegt
    if (userPos) {
      L.circleMarker([userPos.lat, userPos.lon], { radius: 8, weight: 3, color: '#0a0b0d', fillColor: '#7cc9e8', fillOpacity: 1 })
        .bindTooltip('Du bist hier').addTo(mapState.layer);
      if (distanceKm(currentCity().lat, currentCity().lon) <= 25) points.push([userPos.lat, userPos.lon]);
    }
    if (fit && points.length) {
      mapState.map.fitBounds(L.latLngBounds(points), { padding: [40, 40], maxZoom: 15 });
    } else if (fit) {
      mapState.map.setView([currentCity().lat, currentCity().lon], 13);
    }
  }

  async function focusStore(key) {
    if (el.mapWrap.hidden) await showMap();
    const marker = mapState.markers.get(key);
    if (!marker) return;
    el.mapWrap.scrollIntoView({ behavior: 'smooth', block: 'center' });
    mapState.map.setView(marker.getLatLng(), 16);
    marker.openPopup();
  }

  /* ---------------- In meiner Nähe ---------------- */

  // Luftlinie in km (Haversine); null ohne Standort oder Koordinaten
  function distanceKm(lat, lon) {
    if (!userPos || lat == null || lon == null) return null;
    const rad = (x) => (x * Math.PI) / 180;
    const dLat = rad(lat - userPos.lat);
    const dLon = rad(lon - userPos.lon);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(userPos.lat)) * Math.cos(rad(lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * 6371 * Math.asin(Math.sqrt(a));
  }

  const kmFmt = new Intl.NumberFormat('de-DE', { maximumFractionDigits: 1 });
  const fmtKm = (km) => (km < 1 ? `${Math.max(10, Math.round(km * 100) * 10)} m` : `${kmFmt.format(km)} km`);
  const distLine = (lat, lon) => {
    const km = distanceKm(lat, lon);
    return km == null ? '' : `<p class="dist">${PIN_ICON}<span><b>${fmtKm(km)}</b> entfernt</span></p>`;
  };

  function showNearHint(text, isError) {
    el.nearHint.textContent = text;
    el.nearHint.classList.toggle('is-error', Boolean(isError));
    el.nearHint.hidden = false;
  }

  function setNearUI() {
    el.nearBtn.disabled = false;
    el.nearBtn.setAttribute('aria-pressed', String(Boolean(userPos)));
    el.nearBtn.removeAttribute('aria-busy');
    el.nearBtn.innerHTML = `${LOCATE_ICON}<span>${userPos ? 'Standort aktiv' : 'In meiner Nähe'}</span>`;
    el.sortDistance.disabled = !userPos;
  }

  // Standort einmal abfragen → nächste Stadt wählen, nach Entfernung sortieren. Zweiter Klick: wieder aus.
  function locate() {
    if (userPos) {
      userPos = null;
      if (state.sort === 'distance') state.sort = 'unit';
      el.nearHint.hidden = true;
      setNearUI();
      syncControls();
      update();
      return;
    }
    if (!navigator.geolocation) {
      showNearHint('Dein Browser kann den Standort nicht bestimmen.', true);
      return;
    }
    el.nearBtn.disabled = true;
    el.nearBtn.setAttribute('aria-busy', 'true');
    el.nearBtn.innerHTML = `${LOCATE_ICON}<span>Standort wird gesucht …</span>`;
    navigator.geolocation.getCurrentPosition((pos) => {
      userPos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
      state.sort = 'distance';
      const nearest = cities
        .filter((c) => c.lat != null)
        .map((c) => ({ city: c, km: distanceKm(c.lat, c.lon) }))
        .sort((a, b) => a.km - b.km)[0];
      let message = 'Standort erkannt – sortiert nach Entfernung.';
      if (nearest && nearest.km <= 25) {
        if (nearest.city.slug !== state.city) message = `Standort erkannt – ${nearest.city.name} ausgewählt, sortiert nach Entfernung.`;
        state.city = nearest.city.slug;
      } else if (nearest) {
        message = `Standort erkannt – für deine Umgebung gibt es noch keine Daten (nächste Stadt: ${nearest.city.name}, ${fmtKm(nearest.km)}).`;
      }
      setNearUI();
      syncControls();
      applyCity();
      showNearHint(message, false);
    }, (err) => {
      setNearUI();
      showNearHint(err.code === 1
        ? 'Standortfreigabe verweigert – bitte in den Browser- bzw. App-Einstellungen erlauben.'
        : 'Standort konnte nicht ermittelt werden. Bitte später erneut versuchen.', true);
    }, { enableHighAccuracy: false, timeout: 12000, maximumAge: 300000 });
  }

  /* ---------------- Preisverlauf ---------------- */

  const HISTORY_DAYS_SHOWN = 84; // 12 Wochen
  const shortDateFmt = new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: '2-digit', timeZone: 'UTC' });
  const fmtShort = (iso) => shortDateFmt.format(new Date(`${iso}T00:00:00Z`));
  const fmtRange = (from, to) => (from === to ? fmtShort(from) : `${fmtShort(from)}–${fmtShort(to)}`);
  function addDays(iso, n) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  }

  // Tageswerte im Anzeigezeitraum: p = Preis, null = kein Angebot, undefined = an dem Tag nicht erfasst
  // chains = günstigste Kette(n) des Tages (größte zuerst), b = nachgetragen (nicht live erfasst)
  function historySeries(slug) {
    const days = priceHistory[slug] || {};
    const recorded = Object.keys(days).sort();
    if (!recorded.length) return [];
    const windowStart = addDays(today, -(HISTORY_DAYS_SHOWN - 1));
    const out = [];
    for (let day = recorded[0] > windowStart ? recorded[0] : windowStart; day <= today; day = addDays(day, 1)) {
      const v = days[day];
      out.push({ day, p: v ? v.p : undefined, chains: v && v.c ? [v.c, ...(v.o || [])] : [], b: Boolean(v && v.b) });
    }
    return out;
  }

  // Seit wie vielen Wochen gab es in dieser Stadt keinen niedrigeren Dosenpreis? (null = zu wenig Verlauf)
  function lowestSinceWeeks(d) {
    if (d.status !== 'active' || d.pricePerUnit == null || d.appRequired) return null;
    const past = Object.entries(priceHistory[cityOf(d)] || {})
      .filter(([day]) => day < today)
      .sort((a, b) => b[0].localeCompare(a[0]));
    if (!past.length) return null;
    const cheaper = past.find(([, v]) => v && v.p != null && v.p < d.pricePerUnit - 0.005);
    const since = cheaper ? cheaper[0] : past[past.length - 1][0];
    const weeks = Math.floor((Date.parse(today) - Date.parse(since)) / (7 * 86400e3));
    return weeks >= 2 ? { weeks, sinceStart: !cheaper } : null;
  }

  function lowBadge(d) {
    const low = lowestSinceWeeks(d);
    if (!low) return '';
    const title = low.sinceStart ? 'Günstigster Preis seit Beginn der Aufzeichnung' : `Kein günstigerer Monster-Preis hier seit ${low.weeks} Wochen`;
    return `<span class="tag tag--low" title="${esc(title)}">↓ Tiefstpreis seit ${low.weeks} Wochen</span>`;
  }

  function renderHistory() {
    const city = currentCity();
    const series = historySeries(city.slug);
    el.historyPanel.hidden = !series.length;
    if (!series.length) return;
    el.historyTitle.textContent = `Preisverlauf · günstigste Dose in ${city.name}`;

    // 1) Tagesverlauf der letzten 12 Wochen
    const recorded = series.filter((s) => s.p !== undefined);
    const priced = series.filter((s) => s.p != null);
    el.historyChart.hidden = !(recorded.length >= 2 && priced.length > 0);
    if (recorded.length < 2) {
      el.historySub.textContent = `Wird seit ${fmtDay(series[0].day)} täglich gesammelt – ab morgen siehst du hier den Tagesverlauf.`;
    } else if (!priced.length) {
      el.historySub.textContent = `Seit ${fmtDay(series[0].day)} gab es hier kein Monster-Angebot.`;
    } else {
      el.historySub.textContent = `Tagesbestpreis pro Dose (ohne App-Pflicht) · ${series.length >= HISTORY_DAYS_SHOWN
        ? 'letzte 12 Wochen' : `seit ${fmtDay(series[0].day)}`}${series.some((s) => s.b) ? ' · gestrichelt = nachgetragen' : ''}`;
      drawHistoryChart(series, city);
    }

    // 2) Tiefstpreis je Kalenderwoche seit Beginn der Aufzeichnung (ganz unten) + Tabelle
    const weeks = weeklySeries(city.slug);
    renderWeekly(weeks, city);
    renderHistoryTable(weeks);
  }

  // Stufenlinie (Preise gelten tageweise), eine Reihe, 2px, Fadenkreuz + Tooltip, Tastatur (←/→)
  function drawHistoryChart(series, city) {
    const wrap = el.historyChart;
    const W = Math.max(280, Math.round(wrap.clientWidth || 600));
    const H = 196;
    const m = { top: 28, right: 18, bottom: 26, left: 50 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const vals = series.filter((s) => s.p != null).map((s) => s.p);
    const { lo, hi, step } = priceScale(vals);
    const n = series.length;
    const bw = pw / n;
    const x = (i) => m.left + i * bw;
    const y = (p) => m.top + ph - ((p - lo) / (hi - lo)) * ph;

    const grid = gridMarkup(lo, hi, step, y, m, W);
    let xTicks = '';
    let lastX = -1e9;
    series.forEach((s, i) => {
      const monday = new Date(`${s.day}T00:00:00Z`).getUTCDay() === 1;
      const xx = x(i) + bw / 2;
      if ((!monday && i !== 0) || xx - lastX < 64) return;
      lastX = xx;
      xTicks += `<text class="hist-tick" x="${xx.toFixed(1)}" y="${H - 6}" text-anchor="${i === 0 ? 'start' : 'middle'}">${fmtShort(s.day)}</text>`;
    });

    // Nachgetragene Tage gestrichelt: eigener Pfad, nahtlos an die live erfasste Linie angeschlossen
    const paths = { live: '', partial: '' };
    let prev = null; // Linienende des Vortags { type, y } – null = Lücke
    series.forEach((s, i) => {
      if (s.p == null) { prev = null; return; }
      const type = s.b ? 'partial' : 'live';
      const yy = y(s.p).toFixed(1);
      if (prev && prev.type === type) paths[type] += `V${yy}`;
      else paths[type] += `M${x(i).toFixed(1)},${prev ? `${prev.y}V${yy}` : yy}`;
      paths[type] += `H${x(i + 1).toFixed(1)}`;
      prev = { type, y: yy };
    });
    const lines = (paths.live ? `<path class="hist-line" d="${paths.live}"/>` : '')
      + (paths.partial ? `<path class="hist-line hist-line--partial" d="${paths.partial}"/>` : '');

    // Selektive Direkt-Labels: aktueller Preis am Ende, Tiefstpreis (falls niedriger als heute)
    const lastIdx = series.map((s) => s.p != null).lastIndexOf(true);
    const last = series[lastIdx];
    const minVal = Math.min(...vals);
    const minIdx = series.map((s) => s.p != null && Math.abs(s.p - minVal) < 0.005).lastIndexOf(true);
    const endX = x(lastIdx + 1);
    // End-Label unter den Punkt, wenn kurz davor ein höherer Preis war – sonst kreuzt es die Stufe
    let endRun = lastIdx;
    while (endRun > 0 && series[endRun - 1].p != null && Math.abs(series[endRun - 1].p - last.p) < 0.005) endRun -= 1;
    const before = series[endRun - 1];
    const endBelow = Boolean(before && before.p != null && before.p > last.p && endX - x(endRun) < 70);
    let marks = `<circle class="hist-dot" cx="${endX.toFixed(1)}" cy="${y(last.p).toFixed(1)}" r="5"/>`
      + `<text class="hist-label" x="${(endX - 8).toFixed(1)}" y="${(y(last.p) + (endBelow ? 20 : -12)).toFixed(1)}" text-anchor="end">${esc(eur.format(last.p))}</text>`;
    if (minVal < last.p - 0.005) {
      // Marker mittig in den Tiefstpreis-Abschnitt setzen – nicht an den Sprung zum nächsten Preis
      let runStart = minIdx;
      while (runStart > 0 && series[runStart - 1].p != null && Math.abs(series[runStart - 1].p - minVal) < 0.005) runStart -= 1;
      const mx = (x(runStart) + x(minIdx + 1)) / 2;
      // Schmale Diagramme (Handy): kurze Beschriftung, damit sie nicht über den nächsten Preissprung ragt
      const minText = W < 480 ? `↓ ${eur.format(minVal)}` : `Tiefstpreis ${eur.format(minVal)}`;
      const half = (minText.length * 6.6) / 2; // ~Textbreite bei 12px
      const lx = Math.min(Math.max(mx, m.left + half), W - m.right - half);
      marks += `<circle class="hist-dot" cx="${mx.toFixed(1)}" cy="${y(minVal).toFixed(1)}" r="5"/>`
        + `<text class="hist-label" x="${lx.toFixed(1)}" y="${(y(minVal) - 12).toFixed(1)}" text-anchor="middle">${esc(minText)}</text>`;
    }

    const summary = `Preisverlauf ${city.name}: heute ${eur.format(last.p)}, Tiefstpreis ${eur.format(minVal)} am ${fmtDay(series[minIdx].day)}. Mit Pfeiltasten durch die Tage.`;
    wrap.innerHTML = `<svg class="hist-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(summary)}">`
      + `${grid}${xTicks}${lines}${marks}`
      + `<line class="hist-cross" x1="0" x2="0" y1="${m.top}" y2="${m.top + ph}" visibility="hidden"/>`
      // Tippfläche über die volle Breite (auch über den Achsen-Rändern) – am Rand wird auf den ersten/letzten Tag geklemmt
      + `<rect class="hist-hit" x="0" y="${m.top}" width="${W}" height="${ph}"/></svg>`
      + '<div class="hist-tip" hidden></div>';

    bindChartTip(wrap, {
      W, H, n, start: lastIdx,
      xAt: (i) => x(i) + bw / 2,
      yAt: y,
      indexAt: (px) => Math.floor((px - m.left) / bw),
      info: (i) => ({ p: series[i].p, chains: series[i].chains, when: fmtDay(series[i].day), partial: series[i].b, city }),
    });
  }

  // Filialen einer Kette in der gewählten Stadt: bis zu 2 Adressen, sonst die Anzahl
  function storesLine(chain, city) {
    const place = (s) => {
      const [street, rest = ''] = String(s.address || '').split(',').map((t) => t.trim());
      const town = rest.replace(/^\d{5}\s*/, '');
      return town && !town.startsWith(city.name) ? `${street}, ${town}` : street;
    };
    const places = [...new Set(allStores.filter((s) => s.chain === chain).map(place).filter(Boolean))];
    if (!places.length) return '';
    return places.length <= 2 ? places.join('\n') : `${places.length} Filialen in ${city.name}`;
  }

  // Tooltip-Inhalt: Preis, Zeitpunkt, günstigste Kette(n) mit Logo und ihren Filialen in der Stadt
  function fillTip(tip, { p, chains, when, partial, city }) {
    const row = (cls, text) => {
      const span = document.createElement('span');
      span.className = cls;
      span.textContent = text;
      return span;
    };
    const value = document.createElement('strong');
    value.textContent = p != null ? eur.format(p) : p === null ? 'kein Angebot' : 'nicht erfasst';
    const rows = [value, row('tip-when', when)];
    if (p != null) {
      for (const chain of chains.slice(0, 3)) {
        const shop = document.createElement('span');
        shop.className = 'tip-shop';
        shop.innerHTML = `${chipMark(chain)}${esc(chain)}`;
        rows.push(shop);
        const where = storesLine(chain, city);
        if (where) rows.push(row('tip-store', where));
      }
      if (chains.length > 3) rows.push(row('tip-store', `+ ${chains.length - 3} weitere zum selben Preis`));
    }
    if (partial) rows.push(row('tip-note', 'Nachgetragen aus Angeboten, die noch liefen – ältere sind nicht mehr abrufbar'));
    tip.replaceChildren(...rows);
  }

  // Fadenkreuz + Tooltip für beide Diagramme: Maus (Hover), Finger (Tippen/Wischen) und Tastatur (←/→)
  function bindChartTip(wrap, { W, H, n, start, xAt, yAt, indexAt, info }) {
    const svg = wrap.querySelector('svg');
    const cross = svg.querySelector('.hist-cross');
    const tip = wrap.querySelector('.hist-tip');
    let idx = start;
    const show = (i) => {
      idx = Math.max(0, Math.min(n - 1, i));
      const d = info(idx);
      const cx = xAt(idx);
      cross.setAttribute('x1', cx);
      cross.setAttribute('x2', cx);
      cross.setAttribute('visibility', 'visible');
      fillTip(tip, d);
      // Neben das Fadenkreuz auf die Seite mit mehr Platz (Text bricht dort um), damit der Punkt frei bleibt;
      // ist auf keiner Seite genug Platz, darüber bzw. darunter
      const roomRight = W - cx - 14;
      const roomLeft = cx - 14;
      const room = Math.max(roomRight, roomLeft);
      const beside = room >= 150;
      tip.style.maxWidth = beside ? `${Math.floor(Math.min(250, room))}px` : '';
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      const py = d.p != null ? yAt(d.p) : H / 2;
      let left = roomRight >= roomLeft ? cx + 14 : cx - 14 - tw;
      let top = py - th / 2;
      if (!beside) {
        left = cx - tw / 2;
        top = py - th - 14 >= 0 ? py - th - 14 : py + 14;
      }
      tip.style.left = `${Math.min(Math.max(left, 0), Math.max(0, W - tw))}px`;
      tip.style.top = `${Math.min(Math.max(top, 0), Math.max(0, H - th))}px`;
    };
    const hide = () => {
      cross.setAttribute('visibility', 'hidden');
      tip.hidden = true;
    };
    const hit = svg.querySelector('.hist-hit');
    const fromPointer = (e) => {
      const r = svg.getBoundingClientRect();
      show(indexAt((e.clientX - r.left) * (W / r.width)));
    };
    hit.addEventListener('pointermove', fromPointer);
    hit.addEventListener('pointerdown', fromPointer);
    // Maus: beim Verlassen weg. Finger: bleibt nach dem Tippen stehen, bis woanders hingetippt wird
    hit.addEventListener('pointerleave', (e) => { if (e.pointerType === 'mouse') hide(); });
    svg.addEventListener('focus', () => show(idx));
    svg.addEventListener('blur', hide);
    svg.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      show(idx + (e.key === 'ArrowRight' ? 1 : -1));
    });
  }

  // Gemeinsamer Preis-Maßstab beider Diagramme: glatte Stufen (0,10 / 0,20 / 0,25 / 0,50 €), max. 4 Linien
  function priceScale(vals) {
    let lo = Math.floor((Math.min(...vals) - 0.05) * 10) / 10;
    let hi = Math.ceil((Math.max(...vals) + 0.05) * 10) / 10;
    if (hi - lo < 0.2) { lo = Math.max(0, lo - 0.1); hi += 0.1; }
    const step = [0.1, 0.2, 0.25, 0.5, 1].find((s) => (hi - lo) / s <= 4) || 1;
    return { lo: Math.max(0, Math.floor(lo / step + 1e-9) * step), hi: Math.ceil(hi / step - 1e-9) * step, step };
  }

  // Waagerechte Haarlinien + €-Beschriftung links
  function gridMarkup(lo, hi, step, y, m, W) {
    let grid = '';
    for (let v = lo; v <= hi + 1e-9; v += step) {
      const yy = y(v).toFixed(1);
      grid += `<line class="hist-grid" x1="${m.left}" x2="${W - m.right}" y1="${yy}" y2="${yy}"/>`
        + `<text class="hist-tick" x="${m.left - 8}" y="${yy}" dy="0.32em" text-anchor="end">${eur.format(v)}</text>`;
    }
    return grid;
  }

  // ISO-Kalenderwoche (KW) eines Datums
  function isoWeek(iso) {
    const d = new Date(`${iso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 3 - ((d.getUTCDay() + 6) % 7)); // Donnerstag dieser Woche
    const jan4 = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
    return 1 + Math.round(((d - jan4) / 86400e3 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  }

  // Tiefstpreis je Kalenderwoche seit Beginn der Aufzeichnung: p = Preis, null = kein Angebot, undefined = nicht erfasst
  // chains = alle Ketten, die in der Woche diesen Tiefstpreis hatten; partial = Woche enthält nachgetragene Tage
  function weeklySeries(slug) {
    const days = priceHistory[slug] || {};
    const recorded = Object.keys(days).sort();
    if (!recorded.length) return [];
    const mondayOf = (iso) => addDays(iso, -((new Date(`${iso}T00:00:00Z`).getUTCDay() + 6) % 7));
    const weeks = new Map();
    for (let monday = mondayOf(recorded[0]); monday <= mondayOf(recorded[recorded.length - 1]); monday = addDays(monday, 7)) {
      weeks.set(monday, { monday, from: monday, to: addDays(monday, 6), p: undefined, chains: [], partial: false });
    }
    for (const day of recorded) {
      const w = weeks.get(mondayOf(day));
      if (w.p === undefined) { w.p = null; w.from = day; }
      w.to = day;
      const v = days[day];
      if (!v) continue;
      if (v.b) w.partial = true;
      if (v.p == null) continue;
      const chains = v.c ? [v.c, ...(v.o || [])] : [];
      if (w.p == null || v.p < w.p - 0.005) { w.p = v.p; w.chains = chains; }
      else if (Math.abs(v.p - w.p) < 0.005) w.chains = [...new Set([...w.chains, ...chains])];
    }
    for (const w of weeks.values()) w.chains.sort((a, b) => chainRank(a) - chainRank(b));
    return [...weeks.values()];
  }

  function renderWeekly(weeks, city) {
    const priced = weeks.filter((w) => w.p != null);
    el.weeklyTitle.textContent = weeks.length ? `Tiefstpreis pro Woche · seit KW ${isoWeek(weeks[0].monday)}` : 'Tiefstpreis pro Woche';
    el.weeklyChart.hidden = priced.length < 2;
    if (priced.length < 2) {
      const cur = priced[priced.length - 1];
      el.weeklySub.textContent = cur
        ? `KW ${isoWeek(cur.monday)}: ${eur.format(cur.p)}${cur.chains.length ? ` (${cur.chains.join(', ')})` : ''} – ab der nächsten Woche entsteht hier die Kurve.`
        : 'Noch kein Monster-Angebot erfasst – die Kurve entsteht, sobald es hier Angebote gibt.';
      return;
    }
    el.weeklySub.textContent = `Günstigster Dosenpreis je Kalenderwoche in ${city.name} (ohne App-Pflicht) · ${weeks.length} Wochen`
      + (weeks.some((w) => w.partial && w.p != null) ? ' · hohler Punkt = nachgetragen' : '');
    drawWeeklyChart(weeks, city);
  }

  // Linie mit einem Punkt pro Woche (Lücke = Woche ohne Angebot) + Fadenkreuz, Tooltip, Tastatur (←/→)
  function drawWeeklyChart(weeks, city) {
    const wrap = el.weeklyChart;
    const W = Math.max(280, Math.round(wrap.clientWidth || 600));
    const H = 196;
    const m = { top: 28, right: 18, bottom: 26, left: 50 };
    const pw = W - m.left - m.right;
    const ph = H - m.top - m.bottom;
    const vals = weeks.filter((w) => w.p != null).map((w) => w.p);
    const { lo, hi, step } = priceScale(vals);
    const n = weeks.length;
    const bw = pw / n;
    const x = (i) => m.left + (i + 0.5) * bw;
    const y = (p) => m.top + ph - ((p - lo) / (hi - lo)) * ph;

    const every = Math.max(1, Math.ceil(58 / bw)); // KW-Beschriftung ausdünnen, letzte Woche immer
    const xTicks = weeks.map((w, i) => ((n - 1 - i) % every ? '' : `<text class="hist-tick" x="${x(i).toFixed(1)}" y="${H - 6}" text-anchor="middle">KW ${isoWeek(w.monday)}</text>`)).join('');
    let path = '';
    let open = false;
    weeks.forEach((w, i) => {
      if (w.p == null) { open = false; return; }
      path += `${open ? 'L' : 'M'}${x(i).toFixed(1)},${y(w.p).toFixed(1)}`;
      open = true;
    });
    const dots = weeks.map((w, i) => (w.p == null ? ''
      : `<circle class="hist-dot${w.partial ? ' hist-dot--partial' : ''}" cx="${x(i).toFixed(1)}" cy="${y(w.p).toFixed(1)}" r="4"/>`)).join('');

    // Selektive Direkt-Labels: aktuelle Woche + Tiefstpreis seit Beginn (falls niedriger)
    const lastIdx = weeks.map((w) => w.p != null).lastIndexOf(true);
    const last = weeks[lastIdx];
    const minVal = Math.min(...vals);
    const minIdx = weeks.map((w) => w.p != null && Math.abs(w.p - minVal) < 0.005).lastIndexOf(true);
    // End-Label unter den Punkt, wenn die Vorwoche teurer war (die Linie kommt dann von oben links)
    const prevHigher = lastIdx > 0 && weeks[lastIdx - 1].p != null && weeks[lastIdx - 1].p > last.p + 0.005;
    let labels = `<text class="hist-label" x="${x(lastIdx).toFixed(1)}" y="${(y(last.p) + (prevHigher ? 20 : -12)).toFixed(1)}" text-anchor="end">${esc(eur.format(last.p))}</text>`;
    if (minVal < last.p - 0.005) {
      // Tiefstpreis unter den Punkt: darunter verläuft nie eine Linie
      const text = W < 480 ? `↓ ${eur.format(minVal)}` : `Tiefstpreis ${eur.format(minVal)}`;
      const half = (text.length * 6.6) / 2;
      const lx = Math.min(Math.max(x(minIdx), m.left + half), W - m.right - half);
      labels += `<text class="hist-label" x="${lx.toFixed(1)}" y="${(y(minVal) + 20).toFixed(1)}" text-anchor="middle">${esc(text)}</text>`;
    }

    const summary = `Wöchentlicher Tiefstpreis ${city.name}: diese Woche ${eur.format(last.p)}, Tiefstpreis seit Beginn ${eur.format(minVal)} in KW ${isoWeek(weeks[minIdx].monday)}. Mit Pfeiltasten durch die Wochen.`;
    wrap.innerHTML = `<svg class="hist-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" tabindex="0" aria-label="${esc(summary)}">`
      + `${gridMarkup(lo, hi, step, y, m, W)}${xTicks}<path class="hist-line" d="${path}"/>${dots}${labels}`
      + `<line class="hist-cross" x1="0" x2="0" y1="${m.top}" y2="${m.top + ph}" visibility="hidden"/>`
      + `<rect class="hist-hit" x="0" y="${m.top}" width="${W}" height="${ph}"/></svg>`
      + '<div class="hist-tip" hidden></div>';

    bindChartTip(wrap, {
      W, H, n, start: lastIdx,
      xAt: x,
      yAt: y,
      indexAt: (px) => Math.round((px - m.left) / bw - 0.5),
      info: (i) => ({
        p: weeks[i].p,
        chains: weeks[i].chains,
        when: `KW ${isoWeek(weeks[i].monday)} · ${fmtRange(weeks[i].from, weeks[i].to)}`,
        partial: weeks[i].partial,
        city,
      }),
    });
  }

  // Tabellen-Ansicht (Wochen-Tiefstpreise seit Beginn) – macht jeden Wert auch ohne Hover lesbar
  function renderHistoryTable(weeks) {
    el.historyTable.hidden = !weeks.length;
    const rows = weeks.slice().reverse().map((w) => `<tr><td>KW ${isoWeek(w.monday)}</td><td>${fmtRange(w.from, w.to)}</td>`
      + `<td class="num">${w.p != null ? `${eur.format(w.p)}${w.partial ? '*' : ''}` : '–'}</td>`
      + `<td>${w.p != null ? esc(w.chains.join(', ')) : w.p === null ? 'kein Angebot' : 'nicht erfasst'}</td></tr>`).join('');
    const note = weeks.some((w) => w.partial && w.p != null)
      ? '<p class="history-note">* nachgetragen aus Angeboten, die noch liefen – der echte Tiefstpreis kann niedriger gewesen sein.</p>' : '';
    el.historyTable.innerHTML = '<summary>Als Tabelle anzeigen</summary><table><thead><tr><th>KW</th><th>Zeitraum</th>'
      + `<th class="num">Tiefstpreis</th><th>Günstigster Laden</th></tr></thead><tbody>${rows}</tbody></table>${note}`;
  }

  /* ---------------- Events ---------------- */

  function resetFilters() {
    Object.assign(state, DEFAULT_STATE, { city: state.city }); // Stadt bleibt beim Zurücksetzen erhalten
    syncControls();
    update();
  }

  function bindEvents() {
    el.sort.addEventListener('change', () => {
      state.sort = el.sort.value;
      update();
    });
    el.whenChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn || btn.disabled) return;
      state.when = btn.dataset.value === state.when ? 'all' : btn.dataset.value;
      update();
    });
    el.upcomingBanner.addEventListener('click', () => {
      state.when = 'next';
      update();
      el.list.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    el.showAll.addEventListener('change', () => {
      state.showAll = el.showAll.checked;
      if (!state.showAll && state.chain !== 'all' && !deals.some((d) => d.chain === state.chain)) state.chain = 'all';
      update();
    });
    // Städte-Suche: Vorschlag aus der Liste gewählt → sofort wechseln; Enter → auch Teiltreffer/PLZ/Ortsteil
    el.cityInput.addEventListener('input', () => selectCity(el.cityInput.value, { exactOnly: true }));
    el.cityInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        selectCity(el.cityInput.value);
      }
    });
    el.chainChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn || btn.disabled) return;
      state.chain = btn.dataset.value === state.chain ? 'all' : btn.dataset.value;
      update();
    });
    el.packChips.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn || btn.disabled) return;
      state.pack = btn.dataset.value === state.pack ? 'all' : btn.dataset.value;
      update();
    });
    el.nearBtn.addEventListener('click', locate);
    // Preisverlauf bei geänderter Breite neu zeichnen (nur Breite zählt – vermeidet Endlosschleifen)
    if ('ResizeObserver' in window) {
      let lastWidth = 0;
      let timer;
      new ResizeObserver((entries) => {
        const width = Math.round(entries[0].contentRect.width);
        if (width === lastWidth) return;
        lastWidth = width;
        clearTimeout(timer);
        timer = setTimeout(() => { if (!el.historyPanel.hidden) renderHistory(); }, 150);
      }).observe(el.historyPanel);
    }
    el.reset.addEventListener('click', resetFilters);
    el.empty.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="reset"]')) resetFilters();
    });
    el.mapToggle.addEventListener('click', () => (el.mapWrap.hidden ? showMap() : hideMap()));
    el.list.addEventListener('click', (e) => {
      const btn = e.target.closest('.map-link');
      if (btn) focusStore(btn.dataset.store);
    });
    // Relative Zeitangaben ("vor 3 Std.") aktuell halten
    setInterval(() => deals.length && renderList(), 60_000);
  }

  readURL();
  syncControls();
  bindEvents();
  // In der Android-App den APK-Download ausblenden (die App hängt eine eigene Kennung an den User-Agent)
  if (/MonsterAngeboteApp/.test(navigator.userAgent)) el.appDownload.hidden = true;
  // Service Worker: macht die Seite installierbar (Chrome-Menü ⋮ → "App installieren") und offline nutzbar
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* ohne Service Worker läuft alles normal weiter */ });
  }
  load();
})();
