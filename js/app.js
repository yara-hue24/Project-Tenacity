import * as M from './model.js';

const TILES = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/';
const STORE = 'tenacity.v1';
const LOW_MARGIN_H = 0.5;
const BAND_PAD = 12;

// Colours used inside SVG and Leaflet, mirrored from css/style.css.
const C = { bg: '#0f0d0b', bone: '#f2eadd', ground: '#d8cfc0', hair: '#2a241f', raise: '#221d18',
  route: '#ff5fdc', walked: '#ffffff', select: '#5cd9ff', refuge: '#6fdc9c', caution: '#ffb62e', warning: '#ff5d55' };

const ICO = {
  caution: `<svg class="ico" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.6 15.2 14H.8z" fill="currentColor"/><path d="M8 6.2v3.9M8 12v.3" stroke="${C.bg}" stroke-width="1.7" stroke-linecap="round"/></svg>`,
  cross: '<svg class="ico ico-line" viewBox="0 0 16 16" aria-hidden="true"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9"/></svg>',
  check: '<svg class="ico ico-line" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6.3"/><path d="M5 8.3l2.1 2.1L11 6"/></svg>',
};

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ll = (pt) => [pt.lat, pt.lon];
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const pct = (f) => `${(Math.max(0, Math.min(1, f)) * 100).toFixed(1)}%`;

const S = {
  site: null, cfg: null, byId: new Map(), slopes: [],
  p: { ...M.DEFAULTS }, plan: null, t: 0, selected: null,
  show: { muted: true, hirise: true, names: false, ground: true, dots: true, reach: true },
};
// What is open. The default screen shows the answer, the stop list and the map; the rest opens on request.
const UI = { more: false, walk: true, drawer: null, profile: false, meas: false };
let D = null;      // derived from plan + params on every full render
let map = null;
let shownCard = null;
let shownDrawer = false;
const G = {};      // map layers

// ---------- state ----------

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ plan: S.plan, p: S.p })); } catch { /* storage may be blocked */ }
}

function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!raw || !S.byId.has(raw.plan.refuge) || !raw.plan.stops.every((s) => S.byId.has(s.id))) return false;
    S.plan = raw.plan;
    S.p = { ...S.p, ...raw.p };
    return true;
  } catch { return false; }
}

function defaultPlan() {
  S.plan = { refuge: S.cfg.refuge, stops: S.cfg.plan.map((s) => ({ ...s })) };
  S.p = { ...M.DEFAULTS, sunsetClock: S.site.weather.sunset };
}

function derive() {
  const base = S.byId.get(S.plan.refuge);
  const stops = S.plan.stops.map((s) => {
    const stop = S.byId.get(s.id);
    return { ...s, stop, chain: stop.chain_m };
  });
  const res = M.analyse({ baseChain: base.chain_m, stops }, S.p);
  return { base, stops, res, tl: res.tl };
}

const target = (stop) => S.cfg.targets[stop.id];
const stopName = (stop) => (target(stop) ? target(stop).name : `Sol ${stop.sol} stop`);
const stopKind = (stop) => (target(stop) ? target(stop).kind : `Curiosity stop · sol ${stop.sol}`);
const planIndex = (id) => S.plan.stops.findIndex((s) => s.id === id);

// ---------- map ----------

function initMap() {
  const crs = L.extend({}, L.CRS.EPSG3857, { R: S.site.meta.mars_radius_m });
  map = L.map('map', { crs, zoomControl: false, minZoom: 11, maxZoom: 20, zoomSnap: 0.5 });
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft', maxWidth: 140 }).addTo(map);
  map.createPane('names').style.zIndex = 350;
  map.getPane('names').style.pointerEvents = 'none';
  [['ground', 410], ['route', 420], ['dots', 430]].forEach(([name, z]) => { map.createPane(name).style.zIndex = z; });

  G.ctx = L.tileLayer(`${TILES}MSL_CTX_ortho_mosaic_6m/{z}/{x}/{y}.png`, {
    tms: true, minZoom: 6, maxNativeZoom: 13, maxZoom: 20, attribution: 'CTX: NASA/JPL-Caltech/MSSS',
  }).addTo(map);
  G.hirise = L.tileLayer(`${TILES}MSL_Gale_HiRISE-LRGB_78quads/{z}/{x}/{y}.png`, {
    tms: true, minNativeZoom: 10, maxNativeZoom: 18, maxZoom: 20,
    bounds: [[-4.8756, 137.3267], [-4.5551, 137.4786]],
    attribution: 'HiRISE: NASA/JPL-Caltech/Univ. of Arizona',
  });
  G.names = L.tileLayer(`${TILES}MSL_WebGIS_PlaceText/{z}/{x}/{y}.png`, {
    tms: true, pane: 'names', minZoom: 4, maxNativeZoom: 17, maxZoom: 20, attribution: 'Place names: NASA/JPL-Caltech',
  });

  const all = S.site.route.map((r) => [r[1], r[0]]);
  G.ground = L.layerGroup([
    L.polyline(all, { pane: 'ground', color: C.bg, weight: 5, opacity: 0.75, interactive: false }),
    L.polyline(all, { pane: 'ground', color: C.ground, weight: 1.75, interactive: false }),
  ]);
  G.dots = L.layerGroup(S.site.stops.flatMap((s) => [
    L.circleMarker(ll(s), { pane: 'dots', radius: 3.5, color: C.bg, weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }),
    L.circleMarker(ll(s), { pane: 'dots', radius: 13, stroke: false, fillOpacity: 0 }).on('click', () => select(s.id)),
  ]));
  G.dyn = L.layerGroup().addTo(map);

  map.on('mousemove', (e) => {
    const { lat, lng } = e.latlng;
    $('#cursor-pos').textContent = `${Math.abs(lat).toFixed(4)}°${lat < 0 ? 'S' : 'N'}  ${lng.toFixed(4)}°E`;
  });
  map.on('mouseout', () => { $('#cursor-pos').textContent = ''; });

  const b = L.latLngBounds(all);
  // Leave room for the cards that float over the map.
  const wide = window.innerWidth > 900;
  map.fitBounds(b, { paddingTopLeft: wide ? [330, 100] : [30, 150], paddingBottomRight: wide ? [60, 30] : [30, 30] });
  map.setMaxBounds(b.pad(3));
}

const icon = (cls, text, size = 26) => L.divIcon({
  className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div class="mk ${cls}" style="width:${size}px;height:${size}px">${text}</div>`,
});

// A label set off from its point and joined to it by a hairline.
function flag(cls, html, dx, dy) {
  const w = Math.abs(dx);
  const h = Math.max(Math.abs(dy), 1);
  const y1 = dy < 0 ? h : 0;
  return L.divIcon({
    className: 'flag-wrap', iconSize: [0, 0], iconAnchor: [0, 0],
    html: `<svg class="leader ${cls}" width="${w}" height="${h}" style="left:0;top:${Math.min(dy, 0)}px"><line x1="0" y1="${y1}" x2="${w}" y2="${h - y1}"/></svg>
      <div class="mk-label ${cls}" style="left:${dx}px;top:${dy}px">${html}</div>`,
  });
}

const cased = (pts, color, weight, extra = {}) => [
  L.polyline(pts, { pane: 'route', color: C.bg, weight: weight + 3.5, opacity: 0.9, interactive: false }),
  L.polyline(pts, { pane: 'route', color, weight, interactive: false, ...extra }),
];

function walkedRange() {
  let lo = D.base.chain_m;
  let hi = lo;
  for (const s of D.tl.segs) {
    if (s.t0 >= S.t) break;
    const end = S.t >= s.t1 ? s.c1 : M.positionAt(D.tl, S.t).chain;
    lo = Math.min(lo, s.c0, end);
    hi = Math.max(hi, s.c0, end);
  }
  return [lo, hi];
}

function renderMap() {
  const route = S.site.route;
  const base = D.base.chain_m;
  const first = route[0][3];
  const last = route[route.length - 1][3];
  const slice = (a, b) => M.sliceRoute(route, a, b).map(ll);

  $('#map').classList.toggle('muted-terrain', S.show.muted);
  for (const k of ['hirise', 'names', 'ground', 'dots']) {
    if (S.show[k] && !map.hasLayer(G[k])) map.addLayer(G[k]);
    if (!S.show[k] && map.hasLayer(G[k])) map.removeLayer(G[k]);
  }

  G.dyn.clearLayers();
  const add = (layers) => [].concat(layers).forEach((l) => G.dyn.addLayer(l));

  // Planned route, then ground already walked on top.
  const chains = [base, ...D.stops.map((s) => s.chain)];
  add(cased(slice(Math.min(...chains), Math.max(...chains)), C.route, 4));
  const [wlo, whi] = walkedRange();
  if (whi - wlo > 0.5) add(cased(slice(wlo, whi), C.walked, 4));

  // Walk-back limit right now: ground beyond it is out of reach.
  if (S.show.reach) {
    const reach = M.reachAt(S.p, S.t);
    for (const [edge, end] of [[base - reach, first], [base + reach, last]]) {
      if ((end - edge) * (end - base) <= 0) continue;
      add(cased(slice(edge, end), C.caution, 4, { dashArray: '1 9', lineCap: 'round' }));
      add(L.marker(ll(M.pointAtChain(route, edge)), {
        icon: flag('caution', `${ICO.caution}WALK-BACK LIMIT ${M.clockAt(S.p, S.t)}`, 30, -30), interactive: false, zIndexOffset: 700,
      }));
    }
  }

  add(L.marker(ll(D.base), { icon: icon('mk-refuge', 'R', 26), zIndexOffset: 500 }).on('click', () => select(D.base.id)));
  D.stops.forEach((s, i) => {
    add(L.marker(ll(s.stop), { icon: flag('', esc(stopName(s.stop)), 30, i % 2 ? 24 : -24), interactive: false, zIndexOffset: 300 }));
    add(L.marker(ll(s.stop), { icon: icon('mk-stop', i + 1), zIndexOffset: 400 }).on('click', () => select(s.id)));
  });

  if (!D.res.ok) {
    const b = D.res.breakAt;
    add(L.marker(ll(M.pointAtChain(route, b.chain)), {
      icon: flag('warning', `${ICO.cross}PLAN BREAKS ${M.clockAt(S.p, b.t)}`, 30, 44), interactive: false, zIndexOffset: 800,
    }));
  }

  if (S.selected) {
    add(L.circleMarker(ll(S.byId.get(S.selected)), { pane: 'dots', radius: 19, color: C.select, weight: 2.5, fill: false, interactive: false }));
  }

  if (S.t > 0) {
    const you = M.pointAtChain(route, M.positionAt(D.tl, S.t).chain);
    add(L.marker(ll(you), { icon: icon('mk-you', '', 14), zIndexOffset: 900, interactive: false }));
  }
}

// ---------- the answer ----------

function renderAnswer() {
  const { res, tl, base } = D;
  const pos = M.positionAt(tl, S.t);
  const m = M.marginAt(S.p, base.chain_m, S.t, pos.chain);
  const over = m.h < 0;
  const returning = pos.seg.kind === 'return';
  const done = S.t >= tl.endT;

  // One line that says whether the plan works, one that says why, and a longer one behind the click.
  let head;
  let sub;
  let long = '';
  if (!D.stops.length) {
    head = 'No stops yet';
    sub = 'Select a dot on the map to add one.';
  } else if (res.ok) {
    const tt = res.tight;
    const where = tt.seg.kind === 'work' ? `when you leave stop ${tt.seg.stop + 1}` : `on the way to stop ${tt.seg.stop + 1}`;
    head = 'Plan holds';
    sub = `${M.fmtDur(tt.m.h)} to spare at the tightest moment`;
    long = `The tightest moment is ${where} at <b>${M.clockAt(S.p, tt.t)}</b>, with <b>${M.fmtDur(tt.m.h)}</b> to spare on ${tt.m.limiting}. Back at the refuge at <b>${M.clockAt(S.p, tl.endT)}</b>.`;
  } else {
    const b = res.breakAt;
    const where = b.seg.kind === 'work'
      ? `Too long at stop ${b.seg.stop + 1}`
      : `${M.fmtDist(Math.abs(b.seg.c1 - b.chain))} short of stop ${b.seg.stop + 1}`;
    head = `Plan breaks at ${M.clockAt(S.p, b.t)}`;
    sub = `${where}. ${cap(b.limiting)} cannot cover the walk home.`;
    long = `From <b>${M.clockAt(S.p, b.t)}</b> there is not enough ${b.limiting} left to walk home at emergency effort and still keep the reserve. Cut work time or drop a stop.`;
  }
  $('#answer').className = res.ok ? '' : 'bad';
  $('#verdict').innerHTML = `${res.ok ? ICO.check : ICO.cross}<span>${head}</span>`;
  $('#verdict-sub').textContent = sub;
  $('#verdict-long').innerHTML = long;
  $('#verdict-long').hidden = !long;
  $('#answer-main').setAttribute('aria-expanded', UI.more);
  $('#answer-more').hidden = !UI.more;

  // The one number that matters right now.
  const hero = $('#hero');
  const setHero = (cls, k, v) => {
    hero.className = `hero ${cls}`;
    hero.querySelector('.k').textContent = k;
    hero.querySelector('.v').innerHTML = v;
  };
  const low = m.h < LOW_MARGIN_H;
  if (over) setHero('warning', 'Turn back', `${ICO.cross}Past limit`);
  else if (done) setHero('', 'Walk complete', 'Home');
  else if (returning) setHero('', 'Home at', M.clockAt(S.p, tl.endT));
  else setHero(low ? 'caution' : '', 'Turn back in', `${low ? ICO.caution : ''}${M.fmtDur(m.h)}`);

  // Behind the click: the three numbers the answer is made of.
  const set = (id, cls, k, v, s) => {
    const n = $(id);
    n.className = `num ${cls}`;
    if (k) n.querySelector('.k').textContent = k;
    n.querySelector('.v').textContent = v;
    n.querySelector('.s').textContent = s;
  };
  if (over) set('#num-turn', 'warning', 'Start home', 'Now', `${M.fmtDur(-m.h)} past the limit`);
  else if (returning) set('#num-turn', '', 'Margin now', M.fmtDur(m.h), 'while walking home');
  else set('#num-turn', '', 'Start home by', M.clockAt(S.p, S.t + m.h), 'if you stay where you are');

  set('#num-home', '', null, M.fmtDist(m.homeM), m.homeM < 1 ? 'at the refuge' : `${M.fmtWalkRange(S.p, m.homeM)} on foot`);

  // Gauge: the bar is what is left; the hatched part is already kept for the walk home.
  const oxygen = m.limiting === 'oxygen';
  const left = oxygen ? m.o2LeftKg / S.p.o2StartKg : m.daylightH / m.dayTotalH;
  const kept = oxygen ? m.o2KeptKg / S.p.o2StartKg : m.dayKeptH / m.dayTotalH;
  set('#num-limit', over ? 'warning' : '', null, oxygen ? 'Oxygen' : 'Daylight', oxygen
    ? `${Math.max(0, m.o2LeftKg).toFixed(2)} kg left · ${m.o2KeptKg.toFixed(2)} kg kept for home`
    : `${M.fmtDur(m.daylightH)} of light · ${M.fmtDur(m.dayKeptH)} kept for home`);
  $('#num-limit .left').style.width = pct(left);
  $('#num-limit .kept').style.width = pct(kept);
}

// ---------- walk card + assumptions ----------

const CHEV = '<svg class="chev" viewBox="0 0 16 16" aria-hidden="true"><path d="m3 6 5 5 5-5"/></svg>';
const arriveAt = (i) => D.tl.segs.find((g) => g.kind === 'walk' && g.stop === i).t1;

// The default view of the plan: names and times only. Details live on each stop's card.
function renderWalkCard() {
  const el = $('#walk');
  const { base, stops, tl } = D;
  el.className = UI.walk ? '' : 'closed';
  if (!UI.walk) {
    el.innerHTML = `<button class="pill" data-act="walk-toggle" aria-expanded="false">Walk · ${stops.length} stop${stops.length === 1 ? '' : 's'}${CHEV}</button>`;
    return;
  }
  const row = (id, badge, cls, name, time) => `<li><button class="row${S.selected === id ? ' on' : ''}" data-act="select" data-id="${id}">
    <span class="badge ${cls}">${badge}</span><span class="name">${esc(name)}</span><time>${time}</time></button></li>`;
  el.innerHTML = `
    <div class="card-head"><span class="k">Walk</span>
      <button class="icon-btn quiet" data-act="walk-toggle" aria-expanded="true" aria-label="Hide the walk list"><svg viewBox="0 0 16 16"><path d="M10 3 5 8l5 5"/></svg></button></div>
    <p class="goal">${esc(S.cfg.goal_short)}</p>
    <ol class="rows">
      ${row(base.id, 'R', 'refuge', stopName(base), S.p.startClock)}
      ${stops.map((s, i) => row(s.id, i + 1, '', stopName(s.stop), M.clockAt(S.p, arriveAt(i)))).join('')}
      <li><div class="row"><span class="badge refuge">R</span><span class="name">Back</span><time>${M.clockAt(S.p, tl.endT)}</time></div></li>
    </ol>
    <p class="hint">Select a dot on the map to add a stop.</p>
    <div class="actions">
      <button class="primary" data-act="cuff">Cuff card</button>
      <button data-act="drawer" data-id="assume">Advanced</button>
    </div>`;
}

function legFacts(c0, c1) {
  const leg = M.legStats(S.site.route, S.slopes, c0, c1);
  const deg = leg.maxSlopeDeg.toFixed(0);
  const limit = M.NASA.suitSlopeDeg;
  const steep = leg.maxSlopeDeg > limit
    ? `<span class="flag">${ICO.caution}${deg}° slope, above the ${limit}° suit limit</span>`
    : ` · steepest ${deg}° over ${M.SLOPE_BASE_M} m`;
  return `${M.fmtDist(leg.distM)} · ↑${leg.climbM.toFixed(0)} m · ${M.fmtWalkRange(S.p, leg.distM)}${steep}`;
}

function assumeHTML() {
  const assume = (label, key, step, tag, tagText) => `
    <label for="p-${key}">${label} <span class="tag ${tag}">${tagText}</span></label>
    <input id="p-${key}" ${key.endsWith('Clock') ? 'type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM"' : `type="number" step="${step}" min="0"`} value="${S.p[key]}" data-param="${key}">`;
  return `
    <h2>Science goal</h2>
    <p>${esc(S.cfg.goal)}</p>
    <p class="small">${esc(S.cfg.goal_note)}</p>
    <h2>Assumptions you can change</h2>
    <div class="assume">
      ${assume('Leave refuge', 'startClock', 0, 'assumed', 'ASSUMED')}
      ${assume('Sunset', 'sunsetClock', 0, 'measured', 'MEASURED')}
      ${assume('Walking speed, km/h', 'speedKmh', 0.1, 'assumed', 'ASSUMED')}
      ${assume('Slow factor for the way home', 'slowFactor', 0.1, 'assumed', 'ASSUMED')}
      ${assume('Oxygen at start, kg', 'o2StartKg', 0.01, 'derived', 'DERIVED')}
      ${assume('Reserve kept, min', 'reserveMin', 5, 'assumed', 'ASSUMED')}
    </div>
    <p class="rule">Keep enough oxygen to walk home at <b>${M.WALKBACK_FACTOR.toFixed(1)}×</b> working effort, at the slow pace, plus the reserve. Be home one reserve before sunset.</p>
    <div class="actions"><button data-act="reset">Reset plan and assumptions</button></div>`;
}

// ---------- layers (drawer) ----------

function layersHTML() {
  const w = S.site.weather;
  const ageDays = Math.round((Date.now() - Date.parse(w.earth_date)) / 86400000);
  const check = (key, label) => `<label><input type="checkbox" data-show="${key}" ${S.show[key] ? 'checked' : ''}> ${label}</label>`;
  const hours = D.tl.endT;
  const line = (color, dash = '') => `<svg width="36" height="14"><line x1="2" y1="7" x2="34" y2="7" stroke="${C.bg}" stroke-width="7.5"/><line x1="2" y1="7" x2="34" y2="7" stroke="${color}" stroke-width="4" ${dash}/></svg>`;

  return `
    <h2>Map layers</h2>
    <div class="layer-list">
      ${check('hirise', 'HiRISE orbital image, 25 cm per pixel')}
      ${check('muted', 'Mute terrain colour so alerts stand out')}
      ${check('ground', 'Ground Curiosity has driven')}
      ${check('dots', 'Curiosity stops, with photos')}
      ${check('reach', 'Walk-back limit')}
      ${check('names', 'NASA place names')}
    </div>

    <h2>Legend</h2>
    <div class="legend">
      <span class="badge refuge">R</span><span>Refuge (pressurised rover)</span>
      <span class="badge">1</span><span>Planned stop, in visiting order</span>
      ${line(C.route)}<span>Planned route</span>
      ${line(C.walked)}<span>Ground already walked</span>
      ${line(C.ground)}<span>Ground Curiosity has driven</span>
      ${line(C.caution, 'stroke-dasharray="1 8" stroke-linecap="round"')}<span>Beyond the walk-back limit right now</span>
      <svg width="36" height="24"><circle cx="18" cy="12" r="9" fill="none" stroke="${C.select}" stroke-width="2.5"/></svg><span>Selected</span>
    </div>

    <h2>Weather at Gale</h2>
    <p class="stale">${ICO.caution}<span>Stale. Latest record is sol ${w.sol} (${w.earth_date}), ${ageDays} days old. Not live.</span></p>
    <dl class="cond">
      <dt>Air temperature</dt><dd>${w.air_min_c} to ${w.air_max_c} °C</dd>
      <dt>Ground temperature</dt><dd>${w.ground_min_c} to ${w.ground_max_c} °C</dd>
      <dt>Pressure</dt><dd>${w.pressure_pa} Pa</dd>
      <dt>Sky</dt><dd>${esc(w.sky)}</dd>
      <dt>UV index</dt><dd>${esc(w.uv)}</dd>
      <dt>Sunrise / sunset</dt><dd>${w.sunrise} / ${w.sunset}</dd>
      <dt>Season</dt><dd>Ls ${w.ls_deg}°</dd>
    </dl>
    <p class="small"><span class="tag measured">MEASURED</span> Curiosity REMS weather station.</p>

    <h2>Radiation on this walk</h2>
    <dl class="cond">
      <dt>Dose for ${M.fmtDur(hours)} outside</dt><dd>${M.doseMsv(hours).toFixed(2)} mSv</dd>
      <dt>NASA career limit</dt><dd>${M.NASA.careerLimitMsv} mSv</dd>
    </dl>
    <p class="small"><span class="tag derived">DERIVED</span> From ${M.NASA.radMsvPerDay} mSv per day measured by Curiosity RAD at Gale. Routine dose does not decide one walk. A solar storm would, and no storm feed is connected.</p>`;
}

// ---------- sources (drawer) ----------

const SOURCES = [
  ['Route, stop positions, elevation, rover tilt', 'Curiosity localisation', 'measured', 'MEASURED', 'NASA/JPL-Caltech location map feeds', 'https://science.nasa.gov/mission/msl-curiosity/location-map/'],
  ['Photos at each stop', 'Curiosity Navcam', 'measured', 'MEASURED', 'NASA/JPL-Caltech raw images', 'https://mars.nasa.gov/msl/multimedia/raw-images/'],
  ['Orbital imagery', 'HiRISE 25 cm, CTX 6 m', 'measured', 'MEASURED', 'NASA/JPL-Caltech/Univ. of Arizona/MSSS', 'https://science.nasa.gov/mission/msl-curiosity/location-map/'],
  ['Weather and sunset', 'REMS, latest sol', 'measured', 'MEASURED', 'NASA/JPL-Caltech/CAB', 'https://mars.nasa.gov/msl/weather/'],
  ['Surface radiation', '0.67 mSv per day', 'measured', 'MEASURED', 'Curiosity RAD, Hassler et al. 2014', 'https://www.swri.org/press-release/swri-scientists-publish-first-radiation-measurements-surface-mars'],
  ['Oxygen use while working', '0.086 kg/h at 295 W', 'nasa', 'NASA VALUE', 'NASA BVAD Rev 2 (2022)', 'https://ntrs.nasa.gov/citations/20210024855'],
  ['Emergency walk home effort', '2505 / 1030 kJ/h = 2.4×', 'derived', 'DERIVED', 'NASA walk-back test in simulated lunar gravity, 6 people (BVAD Rev 2)', 'https://ntrs.nasa.gov/citations/20210024855'],
  ['Oxygen at start', '0.69 kg = 8 h of work', 'derived', 'DERIVED', 'NASA BVAD Rev 2 working rate', 'https://ntrs.nasa.gov/citations/20210024855'],
  ['Suit slope limit', '20°', 'nasa', 'NASA VALUE', 'NASA Exploration EVA Testing and Analogs', 'https://ntrs.nasa.gov/citations/20210000827'],
  ['Reserve', '30 min', 'assumed', 'ASSUMED', 'Practice in BASALT Mars-analog missions (Marquez et al. 2019)', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6442304'],
  ['Walking speed', '3.3 km/h', 'assumed', 'ASSUMED', 'Apollo 15 traverse planning. No suited Mars walking speed has been measured.', 'https://www.nasa.gov/history/alsj/'],
  ['Slow factor', '1.5×', 'assumed', 'ASSUMED', 'Our choice. Analog crews found planned walk times too optimistic.', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6442304'],
  ['Stop names and science notes', 'Curiosity mission blog', 'measured', 'MEASURED', 'NASA Science', 'https://science.nasa.gov/mission/msl-curiosity/'],
];

function sourcesHTML() {
  return `
    <h2>Where every number comes from</h2>
    <table class="src">${SOURCES.map(([what, val, cls, tag, src, url]) => `
      <tr><td><b>${what}</b><br><span class="val">${val}</span><br><a href="${url}" target="_blank" rel="noopener">${src}</a></td>
      <td><span class="tag ${cls}">${tag}</span></td></tr>`).join('')}
    </table>
    <h2>What this map cannot see</h2>
    <p class="small">Rocks and sand off the rover's track. Live weather or solar storms. Suit power, cooling water and CO<sub>2</sub> removal. How fast a suited person really walks on Mars. The route stays on ground Curiosity drove because that is the only ground measured at walking scale.</p>
    <p class="small">Data snapshot ${S.site.meta.snapshot_utc}. Not affiliated with or endorsed by NASA.</p>`;
}

function renderDrawer() {
  const el = $('#drawer');
  if (!UI.drawer) { el.hidden = true; shownDrawer = false; return; }
  const tab = (id, label) => `<button role="tab" data-act="drawer" data-id="${id}" aria-selected="${UI.drawer === id}">${label}</button>`;
  el.hidden = false;
  el.innerHTML = `
    <div class="drawer-head">
      <nav class="tabs" role="tablist">${tab('assume', 'Assumptions')}${tab('layers', 'Layers')}${tab('sources', 'Sources')}</nav>
      <button class="icon-btn quiet" data-act="drawer" data-id="" aria-label="Close advanced">${ICO.cross}</button>
    </div>
    <div class="tab">${UI.drawer === 'assume' ? assumeHTML() : UI.drawer === 'layers' ? layersHTML() : sourcesHTML()}</div>`;
  if (!shownDrawer) { el.classList.remove('enter'); void el.offsetWidth; el.classList.add('enter'); shownDrawer = true; }
}

// ---------- stop card ----------

function renderStopCard() {
  const card = $('#stopcard');
  if (!S.selected || UI.drawer) { card.hidden = true; shownCard = null; return; }
  const s = S.byId.get(S.selected);
  const t = target(s);
  const isRefuge = s.id === S.plan.refuge;
  const i = planIndex(s.id);
  const base = D.base.chain_m;

  const photo = s.photo
    ? `<figure><img src="${s.photo.file}" alt="Curiosity Navcam view from this stop">
        <figcaption><span>Navcam · sol ${s.photo.sol}</span><a href="${s.photo.page}" target="_blank" rel="noopener" title="Open the raw image on NASA's site">${esc(s.photo.credit)}</a></figcaption></figure>`
    : '';
  const pair = (k1, v1, k2, v2, note = '') => `<div class="pair"><div><span class="k">${k1}</span><b>${v1}</b></div>
    <div><span class="k">${k2}</span><b>${v2}</b>${note ? `<i>${note}</i>` : ''}</div></div>`;

  // What the plan says about this stop, and the one thing to adjust: work time.
  let plan = '';
  let leg = '';
  if (isRefuge) {
    plan = pair('Leave', S.p.startClock, 'Back', M.clockAt(S.p, D.tl.endT));
  } else if (i >= 0) {
    const lb = M.leaveByAt(S.p, base, s.chain_m);
    plan = `${pair('Arrive', M.clockAt(S.p, arriveAt(i)), 'Start home by', M.clockAt(S.p, lb.t), lb.limiting)}
      <div class="stepper"><span class="lab">Work here</span><span class="ctl">
        <button data-act="dwell" data-id="${s.id}" data-delta="-15" aria-label="15 minutes less work">−</button>
        <output>${D.stops[i].dwellMin} min</output>
        <button data-act="dwell" data-id="${s.id}" data-delta="15" aria-label="15 minutes more work">+</button>
      </span></div>`;
    leg = `<p class="legfacts">Leg from ${i ? `stop ${i}` : 'the refuge'}: ${legFacts(i ? D.stops[i - 1].chain : base, s.chain_m)}</p>`;
  }

  card.hidden = false;
  card.innerHTML = `
    <button class="close icon-btn" data-act="close" aria-label="Close">${ICO.cross}</button>
    ${photo}
    <div class="body">
      <div class="kicker">${isRefuge ? 'Refuge · pressurised rover parked here' : esc(stopKind(s))}</div>
      <h3>${esc(stopName(s))}</h3>
      ${plan}
      ${t ? `<p class="note">${esc(t.note)} <a href="${t.source}" target="_blank" rel="noopener">NASA mission blog</a></p>` : ''}
      <details class="more" ${UI.meas ? 'open' : ''}>
        <summary>Measurements${CHEV}</summary>
        <dl class="trio">
          <div><dt>From refuge</dt><dd>${M.fmtDist(Math.abs(s.chain_m - base))}</dd></div>
          <div><dt>Elevation</dt><dd>${s.elev_m.toFixed(0)} m</dd></div>
          <div><dt>Rover tilt</dt><dd>${s.tilt_deg.toFixed(0)}°</dd></div>
        </dl>
        ${leg}
        <p class="small"><span class="tag measured">MEASURED</span> Position, elevation and tilt from Curiosity's own localisation, sol ${s.sol}.</p>
      </details>
      ${isRefuge ? '' : `<div class="actions">
        ${i >= 0 ? `<button data-act="remove" data-id="${s.id}">Remove from walk</button>` : `<button class="primary" data-act="add" data-id="${s.id}">Add to walk</button>`}
        <button data-act="refuge" data-id="${s.id}">Park refuge here</button>
      </div>`}
    </div>`;
  card.classList.remove('enter');
  if (shownCard !== s.id) {
    void card.offsetWidth;
    card.classList.add('enter');
    shownCard = s.id;
  }
}

// ---------- timeline: clock band + ground profile ----------

function stepLabel() {
  const { tl, stops } = D;
  if (S.t >= tl.endT) return 'Back at the refuge';
  if (S.t <= 0) return 'Ready to leave';
  const seg = M.positionAt(tl, S.t).seg;
  if (seg.kind === 'return') return 'Walking home';
  const name = stopName(stops[seg.stop].stop);
  return seg.kind === 'walk' ? `Walking to ${name}` : `Working at ${name}`;
}

function renderTimeline() {
  const scrub = $('#scrub');
  scrub.max = Math.ceil(D.tl.endT * 60);
  scrub.value = Math.round(S.t * 60);
  $('#tl-label').innerHTML = `<b>${M.clockAt(S.p, S.t)}</b><span title="${M.fmtDur(S.t)} outside">${esc(stepLabel())}</span>`;
  $('#profile-toggle').setAttribute('aria-expanded', UI.profile);
  $('#profile-row').hidden = !UI.profile;
}

function renderBand() {
  const box = $('#band-svg');
  const W = Math.max(300, box.clientWidth);
  const H = 46;
  const mid = 30;
  const { tl } = D;
  const x = (t) => BAND_PAD + (tl.endT > 0 ? t / tl.endT : 0) * (W - 2 * BAND_PAD);

  const startH = M.clockToHours(S.p.startClock);
  const spanH = tl.endT / M.MARS_HOUR;
  const stepH = spanH > 6 ? 1 : spanH > 2.5 ? 0.5 : 0.25;
  // The limit label takes priority over hour labels that would sit under it.
  const bx = D.res.ok ? null : x(D.res.breakAt.t);
  const limitRight = bx !== null && bx > W - 120;
  const clear = bx === null ? [0, -1] : (limitRight ? [bx - 150, bx + 26] : [bx - 26, bx + 150]);

  let ticks = '';
  let lastLabel = -99;
  for (let i = Math.ceil(startH / stepH - 1e-9); i * stepH <= startH + spanH + 1e-9; i++) {
    const h = i * stepH;
    const px = x((h - startH) * M.MARS_HOUR);
    ticks += `<line x1="${px}" y1="16" x2="${px}" y2="${H - 4}" stroke="${C.hair}"/>`;
    if (px - lastLabel < 48 || (px > clear[0] && px < clear[1])) continue;
    lastLabel = px;
    const mins = Math.round(h * 60);
    const anchor = px < 24 ? 'start' : px > W - 24 ? 'end' : 'middle';
    ticks += `<text x="${anchor === 'middle' ? px : px + (anchor === 'start' ? -BAND_PAD : BAND_PAD)}" y="11" text-anchor="${anchor}">${String(Math.floor(mins / 60) % 24).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}</text>`;
  }

  let segs = '';
  let badges = '';
  for (const s of tl.segs) {
    const a = x(s.t0);
    const w = Math.max(x(s.t1) - a, 0);
    if (s.kind === 'walk') segs += `<rect x="${a}" y="${mid - 2}" width="${w}" height="4" fill="${C.route}"/>`;
    if (s.kind === 'return') segs += `<line x1="${a}" y1="${mid}" x2="${a + w}" y2="${mid}" stroke="${C.route}" stroke-width="4" stroke-dasharray="7 4"/>`;
    if (s.kind === 'work') {
      segs += `<rect x="${a}" y="${mid - 9}" width="${w}" height="18" rx="2" fill="${C.raise}" stroke="${C.bone}" stroke-width="1.25"/>`;
      badges += `<circle cx="${a}" cy="${mid}" r="9.5" fill="${C.route}" stroke="${C.bg}" stroke-width="2"/><text class="num-t" x="${a}" y="${mid + 4}" text-anchor="middle">${s.stop + 1}</text>`;
    }
  }
  const home = (px) => `<rect x="${px - 6}" y="${mid - 6}" width="12" height="12" rx="2" fill="${C.refuge}" stroke="${C.bg}" stroke-width="2"/>`;

  let limit = '';
  if (bx !== null) {
    const right = limitRight;
    limit = `<rect x="${bx}" y="16" width="${x(tl.endT) - bx}" height="${H - 20}" fill="url(#band-hatch)"/>
      <line x1="${bx}" y1="2" x2="${bx}" y2="${H - 2}" stroke="${C.warning}" stroke-width="2"/>
      <text x="${bx + (right ? -6 : 6)}" y="11" text-anchor="${right ? 'end' : 'start'}" style="fill:${C.warning};font-weight:700">LIMIT ${M.clockAt(S.p, D.res.breakAt.t)}</text>`;
  }

  const now = x(S.t);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="The plan against the clock">
    <defs><pattern id="band-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="7" height="7" fill="${C.warning}" opacity="0.14"/><line x1="0" y1="0" x2="0" y2="7" stroke="${C.warning}" stroke-width="2" opacity="0.6"/></pattern></defs>
    ${ticks}${limit}${segs}${home(x(0))}${home(x(tl.endT))}${badges}
    <rect x="${BAND_PAD}" y="${H - 3}" width="${Math.max(now - BAND_PAD, 0)}" height="2" fill="#fff"/>
    <line x1="${now}" y1="14" x2="${now}" y2="${H - 1}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="${now}" cy="${mid}" r="6.5" fill="#fff" stroke="${C.bg}" stroke-width="3"/>
  </svg>`;
}

function renderProfile() {
  if (!UI.profile) return;
  const box = $('#profile');
  const W = Math.max(300, box.clientWidth);
  const H = 96;
  const pad = { l: BAND_PAD, r: BAND_PAD, t: 26, b: 16 };
  const route = S.site.route;
  const c0 = route[0][3];
  const c1 = route[route.length - 1][3];
  const elevs = route.map((r) => r[2]);
  const e0 = Math.min(...elevs);
  const e1 = Math.max(...elevs);
  const x = (c) => pad.l + ((c - c0) / (c1 - c0)) * (W - pad.l - pad.r);
  const y = (e) => H - pad.b - ((e - e0) / (e1 - e0)) * (H - pad.t - pad.b);
  const base = D.base.chain_m;
  const floor = H - pad.b;
  const xy = (r) => `${x(r[3]).toFixed(1)},${y(r[2]).toFixed(1)}`;
  const between = (lo, hi) => M.sliceRoute(route, lo, hi).map((q) => `${x(q.chain).toFixed(1)},${y(q.elev).toFixed(1)}`).join(' ');

  $('#profile-cap').textContent = `Elevation along Curiosity's track, measured by the rover. ${e0.toFixed(0)} to ${e1.toFixed(0)} m.`;

  const step = Math.max(1, Math.floor(route.length / (W / 2)));
  const line = route.filter((_, i) => i % step === 0 || i === route.length - 1).map(xy).join(' ');

  let scale = '';
  for (let d = 0; d <= c1 - c0; d += 250) {
    const px = x(c0 + d);
    scale += `<line x1="${px}" y1="${floor}" x2="${px}" y2="${floor + 4}" stroke="${C.bone}" opacity="0.5"/>`;
    if (d && d % 500 === 0) scale += `<text x="${px}" y="${H - 1}" text-anchor="middle">${(d / 1000).toFixed(1)} km</text>`;
  }

  let steep = '';
  route.forEach((r, i) => {
    if (i && S.slopes[i] > M.NASA.suitSlopeDeg) {
      const q = route[i - 1];
      steep += `<line x1="${x(q[3])}" y1="${y(q[2])}" x2="${x(r[3])}" y2="${y(r[2])}" stroke="${C.caution}" stroke-width="4"/>`;
    }
  });

  let beyond = '';
  if (S.show.reach) {
    const reach = M.reachAt(S.p, S.t);
    for (const [a, b] of [[c0, base - reach], [base + reach, c1]]) {
      if (b > a) beyond += `<rect x="${x(a)}" y="${pad.t}" width="${x(b) - x(a)}" height="${floor - pad.t}" fill="url(#prof-hatch)"/>`;
    }
  }

  const chains = [base, ...D.stops.map((s) => s.chain)];
  const planned = between(Math.min(...chains), Math.max(...chains));
  const [wlo, whi] = walkedRange();
  const walked = whi - wlo > 0.5 ? `<polyline points="${between(wlo, whi)}" fill="none" stroke="#fff" stroke-width="2.5"/>` : '';

  // Badges sit above the ground line; close neighbours are nudged apart and keep a leader to the true spot.
  let lastX = -99;
  const marks = [{ c: base, label: 'R', fill: C.refuge, sq: true }, ...D.stops.map((s, i) => ({ c: s.chain, label: i + 1, fill: C.route }))]
    .sort((a, b) => a.c - b.c)
    .map((m) => {
      const px = x(m.c);
      const bx = Math.max(px, lastX + 21);
      lastX = bx;
      const shape = m.sq
        ? `<rect x="${bx - 8}" y="2" width="16" height="16" rx="2" fill="${m.fill}"/>`
        : `<circle cx="${bx}" cy="10" r="9" fill="${m.fill}"/>`;
      return `<line x1="${bx}" y1="19" x2="${px}" y2="${y(M.pointAtChain(route, m.c).elev)}" stroke="${m.fill}" stroke-width="1"/>${shape}
        <text class="num-t" x="${bx}" y="14" text-anchor="middle">${m.label}</text>`;
    }).join('');

  const brk = D.res.ok ? '' : `<line x1="${x(D.res.breakAt.chain)}" y1="${pad.t - 4}" x2="${x(D.res.breakAt.chain)}" y2="${floor}" stroke="${C.warning}" stroke-width="2" stroke-dasharray="5 3"/>`;

  const you = M.pointAtChain(route, M.positionAt(D.tl, S.t).chain);
  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" height="${H}" role="img" aria-label="Elevation along the route, measured by the rover">
    <defs>
      <linearGradient id="prof-fill" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.bone}" stop-opacity="0.22"/><stop offset="1" stop-color="${C.bone}" stop-opacity="0.02"/></linearGradient>
      <pattern id="prof-hatch" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
        <rect width="7" height="7" fill="${C.caution}" opacity="0.08"/><line x1="0" y1="0" x2="0" y2="7" stroke="${C.caution}" stroke-width="1.5" opacity="0.55"/></pattern>
    </defs>
    <polygon points="${x(c0)},${floor} ${line} ${x(c1)},${floor}" fill="url(#prof-fill)"/>
    <line x1="${x(c0)}" y1="${floor}" x2="${x(c1)}" y2="${floor}" stroke="${C.bone}" opacity="0.5"/>
    ${scale}${beyond}
    <polyline points="${line}" fill="none" stroke="${C.ground}" stroke-width="1.25"/>
    <polyline points="${planned}" fill="none" stroke="${C.route}" stroke-width="2.5"/>
    ${walked}${steep}${marks}${brk}
    <line x1="${x(you.chain)}" y1="${pad.t - 4}" x2="${x(you.chain)}" y2="${floor}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="${x(you.chain)}" cy="${y(you.elev)}" r="5" fill="#fff" stroke="${C.bg}" stroke-width="2.5"/>
  </svg>`;
}

// ---------- cuff card ----------

function renderCuff() {
  const { base, stops, tl } = D;
  const R = S.site.meta.mars_radius_m;
  const route = S.site.route;
  const chains = [base.chain_m, ...stops.map((s) => s.chain)];
  const path = M.sliceRoute(route, Math.min(...chains), Math.max(...chains)).map((pt) => M.toLocalM(base, pt, R));
  const marks = [{ ...M.toLocalM(base, base, R), label: 'R', sq: true },
    ...stops.map((s, i) => ({ ...M.toLocalM(base, s.stop, R), label: i + 1 }))];

  const xs = path.map((q) => q.x);
  const ys = path.map((q) => q.y);
  const size = 300;
  const padPx = 34;
  const spanX = Math.max(...xs) - Math.min(...xs);
  const spanY = Math.max(...ys) - Math.min(...ys);
  const k = (size - 2 * padPx) / Math.max(spanX, spanY, 1);
  const ox = (size - spanX * k) / 2 - Math.min(...xs) * k;
  const oy = (size - spanY * k) / 2 + Math.max(...ys) * k;
  const px = (q) => [ox + q.x * k, oy - q.y * k];
  const barM = [1000, 500, 200, 100, 50].find((b) => b * k <= 110) || 20;

  // Markers that would overlap are pushed apart along the direction between them.
  const placed = [];
  const shapes = marks.map((m) => {
    let [cx, cy] = px(m);
    for (const p of placed) {
      const d = Math.hypot(cx - p[0], cy - p[1]);
      if (d < 24) { const a = d > 0.5 ? Math.atan2(cy - p[1], cx - p[0]) : 0; cx = p[0] + 24 * Math.cos(a); cy = p[1] + 24 * Math.sin(a); }
    }
    placed.push([cx, cy]);
    const shape = m.sq ? `<rect x="${cx - 11}" y="${cy - 11}" width="22" height="22" fill="#fff" stroke="#000" stroke-width="2.5"/>`
      : `<circle cx="${cx}" cy="${cy}" r="11" fill="#fff" stroke="#000" stroke-width="2.5"/>`;
    return `${shape}<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">${m.label}</text>`;
  }).join('');

  const sketch = `<svg viewBox="0 0 ${size} ${size}">
    <polyline points="${path.map((q) => px(q).map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#000" stroke-width="3"/>
    ${shapes}
    <path d="M22 44 L22 14 M15 23 L22 12 L29 23" fill="none" stroke="#000" stroke-width="2.5"/>
    <text x="22" y="58" text-anchor="middle" font-size="12" font-weight="700" font-family="monospace">N</text>
    <line x1="${size - 16 - barM * k}" y1="${size - 14}" x2="${size - 16}" y2="${size - 14}" stroke="#000" stroke-width="4"/>
    <text x="${size - 16}" y="${size - 22}" text-anchor="end" font-size="12" font-family="monospace">${barM} m</text>
  </svg>`;

  let prev = base;
  let prevChain = base.chain_m;
  const rows = stops.map((s, i) => {
    const leg = M.legStats(route, S.slopes, prevChain, s.chain);
    const brg = Math.round(M.bearingDeg(prev, s.stop));
    const lb = M.leaveByAt(S.p, base.chain_m, s.chain);
    prev = s.stop;
    prevChain = s.chain;
    return `<tr><td class="n">${i + 1}</td>
      <td><b>${esc(stopName(s.stop))}</b><div class="legline">bearing ${String(brg).padStart(3, '0')}° · ${M.fmtDist(leg.distM)} · climb ${leg.climbM.toFixed(0)} m · ${M.fmtWalkRange(S.p, leg.distM)} · work ${s.dwellMin} min</div></td>
      <td class="by">${M.clockAt(S.p, lb.t)}</td></tr>`;
  }).join('');

  const last = stops[stops.length - 1];
  const homeM = last ? Math.abs(last.chain - base.chain_m) : 0;
  const verdict = D.res.ok
    ? `<div class="big">LEAVE LAST STOP BY<b>${M.clockAt(S.p, tl.turnT)}</b>Plan time. Hard limit in the right column.</div>`
    : `<div class="big">PLAN DOES NOT FIT<b>${M.clockAt(S.p, D.res.breakAt.t)}</b>${cap(D.res.breakAt.limiting)} runs short. Shorten the walk.</div>`;

  $('#cuff').innerHTML = `
    <h1>TENACITY · MARSWALK CARD</h1>
    <p class="sub">${esc(S.site.meta.name)} · leave ${S.p.startClock} · sunset ${S.p.sunsetClock}</p>
    ${sketch}
    <table>
      <tr><th></th><th>Stop</th><th style="text-align:right">Start home by</th></tr>
      ${rows}
      <tr><td class="n">R</td><td><b>Home: ${esc(stopName(base))}</b><div class="legline">${M.fmtDist(homeM)} from last stop · ${M.fmtWalkRange(S.p, homeM)} · planned back ${M.clockAt(S.p, tl.endT)}</div></td>
        <td class="by"></td></tr>
    </table>
    ${verdict}
    <p class="rule"><b>Rule.</b> Keep oxygen for the walk home at ${M.WALKBACK_FACTOR.toFixed(1)}× working effort and ${S.p.slowFactor}× the planned time, plus ${S.p.reserveMin} min. Be home ${S.p.reserveMin} min before sunset.</p>
    <p class="fine">Assumed: ${S.p.speedKmh} km/h walking, ${S.p.o2StartKg} kg oxygen at start. Bearings are straight lines between stops; follow the rover track. Route and elevation: Curiosity, NASA/JPL-Caltech. Snapshot ${S.site.meta.snapshot_utc}.</p>`;
}

// ---------- render + events ----------

function renderLive() {
  renderAnswer();
  renderMap();
  renderTimeline();
  renderBand();
  renderProfile();
}

function render() {
  D = derive();
  S.t = Math.min(S.t, D.tl.endT);
  renderWalkCard();
  renderDrawer();
  renderStopCard();
  renderLive();
}

function select(id) {
  S.selected = id;
  UI.drawer = null;
  renderDrawer();
  renderWalkCard();
  renderStopCard();
  renderMap();
}

function act(action, el) {
  const id = el.dataset.id;
  // Opening and closing things never changes the plan.
  if (action === 'select') return select(id);
  if (action === 'more') { UI.more = !UI.more; return renderAnswer(); }
  if (action === 'walk-toggle') { UI.walk = !UI.walk; return renderWalkCard(); }
  if (action === 'profile') { UI.profile = !UI.profile; renderTimeline(); renderProfile(); return map.invalidateSize(); }
  if (action === 'cuff') { renderCuff(); $('#cuff-sheet').hidden = false; return; }
  if (action === 'drawer') {
    UI.drawer = id || null;
    if (UI.drawer) S.selected = null;
    renderDrawer(); renderWalkCard(); renderStopCard();
    return renderMap();
  }

  if (action === 'close') S.selected = null;
  if (action === 'add') S.plan.stops.push({ id, dwellMin: 30 });
  if (action === 'remove') S.plan.stops = S.plan.stops.filter((s) => s.id !== id);
  if (action === 'refuge') {
    S.plan.stops = S.plan.stops.filter((s) => s.id !== id);
    S.plan.refuge = id;
  }
  if (action === 'dwell') {
    const stop = S.plan.stops.find((s) => s.id === id);
    stop.dwellMin = Math.max(0, Math.min(600, stop.dwellMin + Number(el.dataset.delta)));
  }
  if (action === 'reset') { defaultPlan(); S.t = 0; }
  save();
  render();
}

function wire() {
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act, b);
  });

  // Advanced drawer: typed assumptions and layer switches.
  $('#drawer').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.show) {
      S.show[el.dataset.show] = el.checked;
      return renderLive();
    }
    const key = el.dataset.param;
    if (!key) return;
    if (key.endsWith('Clock')) { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) S.p[key] = el.value; }
    else if (Number(el.value) > 0 || key === 'reserveMin') S.p[key] = Math.max(0, Number(el.value) || 0);
    save();
    render();
  });

  // Remember whether the measurements fold is open while moving between stops.
  $('#stopcard').addEventListener('toggle', (e) => { if (e.target.matches('details.more')) UI.meas = e.target.open; }, true);

  // The clock band is the scrubber. The hidden range input keeps it usable from the keyboard.
  const band = $('#band');
  const seek = (e) => {
    const r = $('#band-svg').getBoundingClientRect();
    const f = (e.clientX - r.left - BAND_PAD) / (r.width - 2 * BAND_PAD);
    S.t = Math.max(0, Math.min(1, f)) * D.tl.endT;
    renderLive();
  };
  band.addEventListener('pointerdown', (e) => { band.setPointerCapture(e.pointerId); seek(e); });
  band.addEventListener('pointermove', (e) => { if (band.hasPointerCapture(e.pointerId)) seek(e); });
  $('#scrub').addEventListener('input', (e) => {
    S.t = Math.min(Number(e.target.value) / 60, D.tl.endT);
    renderLive();
  });

  const steps = () => [0, ...D.tl.segs.map((s) => s.t1)];
  $('#leg-next').addEventListener('click', () => {
    S.t = steps().find((t) => t > S.t + 1e-6) ?? D.tl.endT;
    renderLive();
  });
  $('#leg-prev').addEventListener('click', () => {
    S.t = steps().reverse().find((t) => t < S.t - 1e-6) ?? 0;
    renderLive();
  });

  $('#cuff-print').addEventListener('click', () => window.print());
  $('#cuff-close').addEventListener('click', () => { $('#cuff-sheet').hidden = true; });
  window.addEventListener('resize', () => { renderBand(); renderProfile(); });
}

async function main() {
  const [site, cfg] = await Promise.all(['data/site.json', 'data/targets.json'].map((u) => fetch(u).then((r) => r.json())));
  S.site = site;
  S.cfg = cfg;
  site.stops.forEach((s) => S.byId.set(s.id, s));
  S.slopes = M.routeSlopes(site.route);
  UI.walk = window.innerWidth > 900;
  defaultPlan();
  loadSaved();
  initMap();
  wire();
  render();
  if (document.fonts) document.fonts.ready.then(() => { renderBand(); renderProfile(); });
}

main();
