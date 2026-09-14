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
  // Fallback, falls data/cities.json fehlt
  const DEFAULT_CITY = {
    slug: 'singen', name: 'Singen', label: 'Singen (Hohentwiel) mit allen Ortsteilen & Rielasingen-Worblingen',
    lat: 47.7597, lon: 8.8403, zips: ['78224', '78239'], aliases: [],
  };
  const STALE_AFTER_H = 36;
  const LEAFLET_JS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.js';
  const LEAFLET_CSS = 'https://cdn.jsdelivr.net/npm/leaflet@1.9.4/dist/leaflet.css';

  // Ketten-Icons: Monogramm in Hausfarben (keine Markenlogos eingebunden)
  const CHAINS = {
    'Aldi Süd': { bg: '#1c2f7c', fg: '#ffffff', abbr: 'A' },
    'Edeka': { bg: '#ffe500', fg: '#1a4696', abbr: 'E' },
    'Rewe': { bg: '#cc071e', fg: '#ffffff', abbr: 'R' },
    'Nahkauf': { bg: '#2f8a2f', fg: '#ffffff', abbr: 'nk' },
    'Lidl': { bg: '#0050aa', fg: '#fff000', abbr: 'L' },
    'Kaufland': { bg: '#e10915', fg: '#ffffff', abbr: 'K' },
    'Netto': { bg: '#ffe500', fg: '#e30613', abbr: 'N' },
    'Penny': { bg: '#cd1414', fg: '#ffffff', abbr: 'P' },
    'Norma': { bg: '#004f9f', fg: '#ffffff', abbr: 'No' },
    'Globus': { bg: '#e2231a', fg: '#ffffff', abbr: 'G' },
    'tegut': { bg: '#ef7d00', fg: '#ffffff', abbr: 't' },
    'Marktkauf': { bg: '#005ca9', fg: '#ffe500', abbr: 'M' },
    'Trinkgut': { bg: '#e3000b', fg: '#ffffff', abbr: 'T' },
    'Fristo': { bg: '#009640', fg: '#ffffff', abbr: 'F' },
    'Getränke Hoffmann': { bg: '#003c7e', fg: '#ffffff', abbr: 'GH' },
    'Getränke Müller': { bg: '#264653', fg: '#ffffff', abbr: 'GM' },
    'Rossmann': { bg: '#c3002d', fg: '#ffffff', abbr: 'Ro' },
    'dm': { bg: '#0d3a78', fg: '#ffd500', abbr: 'dm' },
    'Müller': { bg: '#f18700', fg: '#ffffff', abbr: 'Mü' },
  };

  const BASE_PACKS = [
    { key: 'all', label: 'Alle' },
    { key: 'single', label: 'Einzeln' },
    { key: 'pack4', label: '4er' },
    { key: 'pack6', label: '6er' },
    { key: 'pack10', label: '10er' },
  ];

  const DEFAULT_STATE = { city: 'singen', chain: 'all', pack: 'all', sort: 'unit', onlyValid: false, showAll: false };
  const URL_KEYS = { city: 'stadt', chain: 'kette', pack: 'packung', sort: 'sort', onlyValid: 'gueltig', showAll: 'alle' };

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
    onlyValid: $('#only-valid'),
    showAll: $('#show-all'),
    cityInput: $('#city'),
    cityList: $('#city-list'),
    cityHint: $('#city-hint'),
    cityName: $('#city-name'),
    citySub: $('#city-sub'),
    cityRegion: $('#city-region'),
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
  let everyStore = [];   // Filialen aller Städte
  let allDeals = [];     // Angebote aller Städte (normalisiert, inkl. abgelaufene)
  let cities = [DEFAULT_CITY];
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
    if (CHAINS[chain]) return CHAINS[chain];
    let hash = 0;
    for (const ch of String(chain)) hash = (hash * 31 + ch.charCodeAt(0)) % 360;
    return { bg: `hsl(${hash} 55% 38%)`, fg: '#ffffff', abbr: String(chain).slice(0, 2) };
  }

  const styleVars = (s) => `--bg-c:${s.bg};--fg-c:${s.fg}`;

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
    let rawDeals;
    try {
      rawDeals = await fetchJSON(DATA_URL);
    } catch (err) {
      renderError(err);
      return;
    }
    const [stores, prices, cityList] = await Promise.all([
      fetchJSON(STORES_URL).catch(() => []),   // Filialverzeichnis ist optional
      fetchJSON(PRICES_URL).catch(() => ({})), // Normalpreise sind optional
      fetchJSON(CITIES_URL).catch(() => []),   // Städteliste ist optional
    ]);
    everyStore = Array.isArray(stores) ? stores : [];
    if (Array.isArray(cityList) && cityList.length) cities = cityList;
    if (!cities.some((c) => c.slug === state.city)) state.city = (cities.find((c) => c.default) || cities[0]).slug;
    regularPrices = prices && typeof prices === 'object' ? prices : {};

    const list = Array.isArray(rawDeals) ? rawDeals : rawDeals.deals || [];
    const storesByKey = new Map(stores.map((s) => [fold(`${s.name}|${s.address}`), s]));
    allDeals = list.map((d) => normalize(d, storesByKey)).filter(Boolean);

    renderCityOptions();
    renderUpdated(list);
    applyCity();
  }

  /* ---------------- Städte ---------------- */

  const cityOf = (item) => item.city || DEFAULT_CITY.slug; // alte Einträge ohne "city" gehören zu Singen
  const currentCity = () => cities.find((c) => c.slug === state.city) || cities[0] || DEFAULT_CITY;

  // Angebote + Filialen der gewählten Stadt übernehmen und alles neu zeichnen
  function applyCity() {
    const city = currentCity();
    allStores = everyStore.filter((s) => (s.cities || [DEFAULT_CITY.slug]).includes(city.slug));
    knownChains = [...new Set(allStores.map((s) => s.chain))];
    const cityDeals = allDeals.filter((d) => cityOf(d) === city.slug);
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
    renderSummary();
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
    if (state.onlyValid && d.status !== 'active') return false;
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
        `<span class="chip-dot" style="${styleVars(chainStyle(c))}" aria-hidden="true"></span>`,
        state.showAll && knownChains.includes(c))).join(''); // mit "Alle Filialen" auch Ketten ohne Angebot wählbar

    const packCounts = countBy(deals.filter((d) => matches(d, 'pack')), (d) => d.packType);
    const extraPacks = [...packCounts.keys()]
      .filter((k) => !BASE_PACKS.some((p) => p.key === k))
      .sort((a, b) => unitsOf(a) - unitsOf(b));
    const packTotal = [...packCounts.values()].reduce((s, n) => s + n, 0);
    el.packChips.innerHTML = [...BASE_PACKS.map((p) => p.key), ...extraPacks]
      .map((k) => chip(k, packChipLabel(k), k === 'all' ? packTotal : packCounts.get(k) || 0, state.pack === k))
      .join('');
  }

  function renderUpdated(list) {
    const stamps = list.map((d) => Date.parse(d.lastUpdated)).filter(Number.isFinite);
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
    const active = deals.filter((d) => d.status === 'active' && d.pricePerUnit != null);
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
        <p class="stat-label">Günstigste Dose heute</p>
        <p class="stat-value">${best ? eur.format(best.pricePerUnit) : '–'}</p>
        <p class="stat-sub">${best ? `${esc(best.chain)} · ${esc(packLabel(best))}${best.appRequired ? ' · nur mit App' : ''}` : 'aktuell kein gültiges Angebot'}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Angebote</p>
        <p class="stat-value">${deals.length}</p>
        <p class="stat-sub">in ${stores.size} ${stores.size === 1 ? 'Filiale' : 'Filialen'}</p>
      </div>
      <div class="stat">
        <p class="stat-label">Ketten</p>
        <p class="stat-value">${chains.size}</p>
        <p class="stat-sub">${esc([...chains].sort((a, b) => a.localeCompare(b, 'de')).join(', '))}</p>
      </div>`;
  }

  const CAL_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>';
  const PHONE_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="2" width="12" height="20" rx="3"/><path d="M11 18h2"/></svg>';

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
    const cs = chainStyle(d.chain);
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
          <span class="chain-badge" style="${styleVars(cs)}" title="${esc(d.chain)}" aria-hidden="true">${esc(cs.abbr)}</span>
          <div class="store">
            <h3>${esc(d.store)}</h3>
            <p class="addr"><a href="${esc(osm)}" target="_blank" rel="noopener">${esc(d.address || 'Adresse unbekannt')}</a></p>
          </div>
          <span class="status status--${statusCls}">${esc(statusText)}</span>
        </header>

        <p class="product">${esc(productMain)}${productSub ? `<small>${esc(productSub)}</small>` : ''}</p>
        <div class="tags"><span class="tag tag--pack">${esc(packLabel(d))}</span>${volume}</div>

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
    const cs = chainStyle(s.chain);
    const known = regularPrices[s.chain];
    const osm = `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lon}#map=18/${s.lat}/${s.lon}`;
    const price = known && known.pricePerUnit
      ? `<p class="store-price">${known.manual ? 'Normalpreis (eigene Angabe)' : 'Normalpreis zuletzt laut Prospekt'}: `
        + `<b>${eur.format(known.pricePerUnit)}</b> pro Dose${known.seen ? ` · Stand ${esc(fmtDay(known.seen))}` : ''}</p>`
      : '<p class="store-price">Kein Monster-Angebot im aktuellen Prospekt · Normalpreis nicht bekannt</p>';
    return `
      <article class="card card--store">
        <header class="card-head">
          <span class="chain-badge" style="${styleVars(cs)}" title="${esc(s.chain)}" aria-hidden="true">${esc(cs.abbr)}</span>
          <div class="store">
            <h3>${esc(s.name)}</h3>
            <p class="addr"><a href="${esc(osm)}" target="_blank" rel="noopener">${esc(s.address)}</a></p>
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
    const priced = visible.filter((d) => d.status === 'active' && d.pricePerUnit != null && !d.appRequired);
    const bestUnit = Math.min(...priced.map((d) => d.pricePerUnit));
    // "Bestpreis" nur zeigen, wenn es überhaupt teurere Alternativen gibt – sonst sagt das Label nichts aus
    const showBest = priced.some((d) => d.pricePerUnit - bestUnit >= 0.005);

    // "Alle Filialen zeigen": Filialen ohne irgendein Angebot ergänzen (Packungs-Filter spielt hier keine Rolle)
    const withDeals = new Set(deals.map(storeKey));
    noDealStores = state.showAll
      ? allStores
        .filter((s) => !withDeals.has(storeKeyOf(s)) && (state.chain === 'all' || s.chain === state.chain))
        .sort((a, b) => chainRank(a.chain) - chainRank(b.chain) || a.name.localeCompare(b.name, 'de'))
      : [];

    el.list.innerHTML = visible
      .map((d) => cardHTML(d, showBest && d.status === 'active' && !d.appRequired && Math.abs(d.pricePerUnit - bestUnit) < 0.005))
      .join('')
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
    renderChips();
    renderList();
    renderMap();
    writeURL();
  }

  /* ---------------- URL-Status (teilbare Filter) ---------------- */

  function readURL() {
    const p = new URLSearchParams(location.search);
    if (p.has(URL_KEYS.chain)) state.chain = p.get(URL_KEYS.chain);
    if (p.has(URL_KEYS.pack)) state.pack = p.get(URL_KEYS.pack);
    if (SORTERS[p.get(URL_KEYS.sort)]) state.sort = p.get(URL_KEYS.sort);
    state.onlyValid = p.get(URL_KEYS.onlyValid) === '1';
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
    el.onlyValid.checked = state.onlyValid;
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
      const cs = chainStyle(first.chain);
      const icon = L.divIcon({
        className: '',
        html: `<span class="pin" style="--pin-bg:${cs.bg};--pin-fg:${cs.fg}">${esc(cs.abbr)}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -16],
      });
      const rows = items.map((d) => `<li>${esc(packLabel(d))}: <b>${eur.format(d.price)}</b>`
        + `${d.packType !== 'single' && d.pricePerUnit != null ? ` (${eur.format(d.pricePerUnit)}/Dose)` : ''}`
        + `${d.app ? `<br><small>📱 ${esc(appText(d.app))}</small>` : ''}</li>`).join('');
      const marker = L.marker([first.lat, first.lon], { icon, title: first.store })
        .bindPopup(`<p class="popup-title">${esc(first.store)}</p><p class="popup-addr">${esc(first.address)}</p><ul class="popup-list">${rows}</ul>`);
      marker.addTo(mapState.layer);
      mapState.markers.set(key, marker);
    }

    // Filialen ohne Angebot: graue, gedimmte Pins (liegen unter den Angebots-Pins)
    const noDealPoints = [];
    for (const s of noDealStores) {
      if (s.lat == null || s.lon == null) continue;
      const cs = chainStyle(s.chain);
      const known = regularPrices[s.chain];
      const icon = L.divIcon({
        className: '',
        html: `<span class="pin pin--none" style="--pin-bg:${cs.bg};--pin-fg:${cs.fg}">${esc(cs.abbr)}</span>`,
        iconSize: [34, 34],
        iconAnchor: [17, 17],
        popupAnchor: [0, -16],
      });
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
    el.onlyValid.addEventListener('change', () => {
      state.onlyValid = el.onlyValid.checked;
      update();
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
  load();
})();
