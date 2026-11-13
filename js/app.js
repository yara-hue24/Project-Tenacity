import * as M from './model.js';

const TILES = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/';
const STORE = 'tenacity.v1';
const LOW_MARGIN_H = 0.5;

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const ll = (pt) => [pt.lat, pt.lon];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const S = {
  site: null, cfg: null, byId: new Map(), slopes: [],
  p: { ...M.DEFAULTS }, plan: null, t: 0, selected: null,
  show: { muted: true, hirise: true, names: false, ground: true, dots: true, reach: true },
};
let D = null;      // derived from plan + params on every full render
let map = null;
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
const planIndex = (id) => S.plan.stops.findIndex((s) => s.id === id);

// ---------- map ----------

function initMap() {
  const crs = L.extend({}, L.CRS.EPSG3857, { R: S.site.meta.mars_radius_m });
  map = L.map('map', { crs, zoomControl: false, minZoom: 11, maxZoom: 20, zoomSnap: 0.5 });
  map.attributionControl.setPrefix(false);
  L.control.zoom({ position: 'bottomright' }).addTo(map);
  L.control.scale({ imperial: false, position: 'bottomleft' }).addTo(map);
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
    L.polyline(all, { pane: 'ground', color: '#111', weight: 5, opacity: 0.7, interactive: false }),
    L.polyline(all, { pane: 'ground', color: '#cfd3d8', weight: 2, interactive: false }),
  ]);
  G.dots = L.layerGroup(S.site.stops.flatMap((s) => [
    L.circleMarker(ll(s), { pane: 'dots', radius: 4, color: '#111', weight: 1.5, fillColor: '#fff', fillOpacity: 1, interactive: false }),
    L.circleMarker(ll(s), { pane: 'dots', radius: 13, stroke: false, fillOpacity: 0 }).on('click', () => select(s.id)),
  ]));
  G.dyn = L.layerGroup().addTo(map);

  const b = L.latLngBounds(all);
  map.fitBounds(b.pad(0.15));
  map.setMaxBounds(b.pad(3));
}

const icon = (cls, text, size = 26) => L.divIcon({
  className: '', iconSize: [size, size], iconAnchor: [size / 2, size / 2],
  html: `<div class="mk ${cls}" style="width:${size}px;height:${size}px">${text}</div>`,
});
const labelIcon = (cls, text, below = false) => L.divIcon({
  className: '', iconSize: null, iconAnchor: [-16, below ? -6 : 26], html: `<div class="mk-label ${cls}">${esc(text)}</div>`,
});
const cased = (pts, color, weight, extra = {}) => [
  L.polyline(pts, { pane: 'route', color: '#111', weight: weight + 3, opacity: 0.85, interactive: false }),
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
  add(cased(slice(Math.min(...chains), Math.max(...chains)), '#ff5fdc', 4));
  const [wlo, whi] = walkedRange();
  if (whi - wlo > 0.5) add(cased(slice(wlo, whi), '#ffffff', 4));

  // Walk-back limit right now: ground beyond it is out of reach.
  const clock = M.clockAt(S.p, S.t);
  if (S.show.reach) {
    const reach = M.reachAt(S.p, S.t);
    for (const [edge, end] of [[base - reach, first], [base + reach, last]]) {
      if ((end - edge) * (end - base) <= 0) continue;
      add(cased(slice(edge, end), '#ffb62e', 4, { dashArray: '2 9', lineCap: 'round' }));
      add(L.marker(ll(M.pointAtChain(route, edge)), { icon: labelIcon('caution', `▲ WALK-BACK LIMIT ${clock}`), interactive: false }));
    }
  }

  add(L.marker(ll(D.base), { icon: icon('mk-refuge', 'R', 28), zIndexOffset: 500 }).on('click', () => select(D.base.id)));
  D.stops.forEach((s, i) => {
    add(L.marker(ll(s.stop), { icon: icon('mk-stop', i + 1), zIndexOffset: 400 }).on('click', () => select(s.id)));
    if (target(s.stop)) add(L.marker(ll(s.stop), { icon: labelIcon('name', stopName(s.stop), i % 2 === 1), interactive: false }));
  });

  if (!D.res.ok) {
    const b = D.res.breakAt;
    add(L.marker(ll(M.pointAtChain(route, b.chain)), {
      icon: labelIcon('warning', `✕ PLAN BREAKS ${M.clockAt(S.p, b.t)}`), interactive: false, zIndexOffset: 800,
    }));
  }

  if (S.selected) {
    add(L.circleMarker(ll(S.byId.get(S.selected)), { pane: 'dots', radius: 17, color: '#55d6ff', weight: 3, fill: false, interactive: false }));
  }

  if (S.t > 0) {
    const you = M.pointAtChain(route, M.positionAt(D.tl, S.t).chain);
    add(L.marker(ll(you), { icon: icon('mk-you', '', 20), zIndexOffset: 900, interactive: false }));
  }
}

// ---------- status strip ----------

function renderStrip() {
  const { res, tl, base } = D;
  const v = $('#verdict');
  if (res.ok) {
    const tt = res.tight;
    const where = tt.seg.kind === 'work' ? `when you leave stop ${tt.seg.stop + 1}` : `on the way to stop ${tt.seg.stop + 1}`;
    v.className = '';
    v.innerHTML = D.stops.length
      ? `Plan holds. Tightest moment is ${where} at <b>${M.clockAt(S.p, tt.t)}</b>, with <b>${M.fmtDur(tt.m.h)}</b> to spare on ${tt.m.limiting}.`
      : 'No stops yet. Select a dot on the map to add one.';
  } else {
    const b = res.breakAt;
    const where = b.seg.kind === 'work'
      ? `you have stayed too long at stop ${b.seg.stop + 1}`
      : `${M.fmtDist(Math.abs(b.seg.c1 - b.chain))} before stop ${b.seg.stop + 1}`;
    v.className = 'bad';
    v.innerHTML = `<span class="mark">✕</span>Plan breaks at <b>${M.clockAt(S.p, b.t)}</b>: ${where}. ${cap(b.limiting)} no longer covers the walk home.`;
  }

  const pos = M.positionAt(tl, S.t);
  const m = M.marginAt(S.p, base.chain_m, S.t, pos.chain);
  const set = (id, cls, val, sub) => {
    const n = $(id);
    n.className = `num ${cls}`;
    n.querySelector('.v').textContent = val;
    n.querySelector('.s').textContent = sub;
  };

  if (m.h < 0) {
    set('#num-turn', 'warning', '✕ PAST LIMIT', `${M.fmtDur(-m.h)} over · go home now`);
  } else if (pos.seg.kind === 'return') {
    const done = S.t >= tl.endT;
    set('#num-turn', '', done ? 'Home' : 'Heading home', done ? `arrived ${M.clockAt(S.p, tl.endT)}` : `arrive ${M.clockAt(S.p, tl.endT)} · ${M.fmtDur(m.h)} spare`);
  } else {
    const low = m.h < LOW_MARGIN_H;
    set('#num-turn', low ? 'caution' : '', `${low ? '▲ ' : ''}${M.fmtDur(m.h)}`, `start home by ${M.clockAt(S.p, S.t + m.h)} from here`);
  }

  set('#num-home', '', M.fmtDist(m.homeM), m.homeM < 1 ? 'at the refuge' : `${M.fmtWalkRange(S.p, m.homeM)} on foot`);

  if (m.limiting === 'oxygen') {
    set('#num-limit', '', 'Oxygen', `${Math.max(0, m.o2LeftKg).toFixed(2)} kg left · ${M.fmtDur(m.o2LeftKg / M.NASA.o2WorkKgH)} of work`);
  } else {
    set('#num-limit', '', 'Daylight', `sunset ${S.p.sunsetClock} · ${M.fmtDur(m.daylightH)} of light`);
  }
}

// ---------- walk tab ----------

function renderWalk() {
  const { base, stops } = D;
  let prev = base.chain_m;
  const items = stops.map((s, i) => {
    const leg = M.legStats(S.site.route, S.slopes, prev, s.chain);
    prev = s.chain;
    const lb = M.leaveByAt(S.p, base.chain_m, s.chain);
    const steep = leg.maxSlopeDeg > M.NASA.suitSlopeDeg
      ? `<span class="flag">slope ${leg.maxSlopeDeg.toFixed(0)}° exceeds ${M.NASA.suitSlopeDeg}° suit limit</span>`
      : `steepest ${leg.maxSlopeDeg.toFixed(0)}° over ${M.SLOPE_BASE_M} m`;
    return `<li>
      <div class="head"><span class="badge">${i + 1}</span>
        <button class="name" data-act="select" data-id="${s.id}">${esc(stopName(s.stop))}</button></div>
      <div class="facts">Leg: <b>${M.fmtDist(leg.distM)}</b> · climb <b>${leg.climbM.toFixed(0)} m</b> · <b>${M.fmtWalkRange(S.p, leg.distM)}</b> · ${steep}</div>
      <div class="row"><label>Work here <input type="number" min="0" max="600" step="5" value="${s.dwellMin}" data-dwell="${i}"> min</label>
        <button data-act="remove" data-id="${s.id}">Remove</button></div>
      <div class="facts">Start home from here by <b>${M.clockAt(S.p, lb.t)}</b> (${lb.limiting})</div>
    </li>`;
  }).join('');

  const hours = D.tl.endT;
  const assume = (label, key, step, tag, tagText) => `
    <label for="p-${key}">${label} <span class="tag ${tag}">${tagText}</span></label>
    <input id="p-${key}" ${key.endsWith('Clock') ? 'type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM"' : `type="number" step="${step}" min="0"`} value="${S.p[key]}" data-param="${key}">`;

  $('#tab-walk').innerHTML = `
    <h2>Science goal</h2>
    <p class="goal">${esc(S.cfg.goal)}</p>
    <p class="small">${esc(S.cfg.goal_note)}</p>

    <h2>Walk plan</h2>
    <ul class="plan">
      <li><div class="head"><span class="badge refuge">R</span>
        <button class="name" data-act="select" data-id="${base.id}">Refuge: ${esc(stopName(base))}</button></div>
        <div class="facts">Pressurised rover parked here. Leave at <b>${S.p.startClock}</b>, back at <b>${M.clockAt(S.p, hours)}</b> · ${M.fmtDur(hours)} outside.</div></li>
      ${items}
    </ul>
    <p class="small" style="margin-top:8px">Select any dot on the map to add a stop or move the refuge.</p>

    <h2>Assumptions you can change</h2>
    <div class="assume">
      ${assume('Leave refuge, Mars local time', 'startClock', 0, 'assumed', 'ASSUMED')}
      ${assume('Sunset, Mars local time', 'sunsetClock', 0, 'measured', 'MEASURED')}
      ${assume('Walking speed, km/h', 'speedKmh', 0.1, 'assumed', 'ASSUMED')}
      ${assume('Slow-walk factor for the way home', 'slowFactor', 0.1, 'assumed', 'ASSUMED')}
      ${assume('Oxygen at start, kg', 'o2StartKg', 0.01, 'derived', 'DERIVED')}
      ${assume('Reserve kept, min', 'reserveMin', 5, 'assumed', 'ASSUMED')}
    </div>
    <p class="small" style="margin-top:10px">Rule: keep enough oxygen to walk home at ${M.WALKBACK_FACTOR.toFixed(1)}× working effort, at the slow pace, plus the reserve. Be home one reserve before sunset.</p>

    <div class="actions">
      <button class="primary" data-act="cuff">Cuff card</button>
      <button data-act="reset">Reset plan</button>
    </div>`;
}

// ---------- layers tab ----------

function renderLayers() {
  const w = S.site.weather;
  const ageDays = Math.round((Date.now() - Date.parse(w.earth_date)) / 86400000);
  const check = (key, label) => `<label><input type="checkbox" data-show="${key}" ${S.show[key] ? 'checked' : ''}> ${label}</label>`;
  const hours = D.tl.endT;
  const line = (color, dash = '') => `<svg width="34" height="14"><line x1="2" y1="7" x2="32" y2="7" stroke="#111" stroke-width="7"/><line x1="2" y1="7" x2="32" y2="7" stroke="${color}" stroke-width="4" ${dash}/></svg>`;

  $('#tab-layers').innerHTML = `
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
      ${line('#ff5fdc')}<span>Planned route</span>
      ${line('#ffffff')}<span>Ground already walked</span>
      ${line('#cfd3d8')}<span>Ground Curiosity has driven</span>
      ${line('#ffb62e', 'stroke-dasharray="2 7" stroke-linecap="round"')}<span>▲ Beyond the walk-back limit right now</span>
      <svg width="34" height="22"><circle cx="17" cy="11" r="8" fill="none" stroke="#55d6ff" stroke-width="3"/></svg><span>Selected</span>
    </div>

    <h2>Weather at Gale</h2>
    <p class="stale">Latest record is sol ${w.sol} (${w.earth_date}), ${ageDays} days old. Not live.</p>
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

// ---------- sources tab ----------

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
  ['Slow-walk factor', '1.5×', 'assumed', 'ASSUMED', 'Our choice. Analog crews found planned walk times too optimistic.', 'https://pmc.ncbi.nlm.nih.gov/articles/PMC6442304'],
  ['Stop names and science notes', 'Curiosity mission blog', 'measured', 'MEASURED', 'NASA Science', 'https://science.nasa.gov/mission/msl-curiosity/'],
];

function renderSources() {
  $('#tab-sources').innerHTML = `
    <h2>Where every number comes from</h2>
    <table class="src">${SOURCES.map(([what, val, cls, tag, src, url]) => `
      <tr><td><b>${what}</b><br><span class="val">${val}</span><br><a href="${url}" target="_blank" rel="noopener">${src}</a></td>
      <td><span class="tag ${cls}">${tag}</span></td></tr>`).join('')}
    </table>
    <h2>What this map cannot see</h2>
    <p class="small">Rocks and sand off the rover's track. Live weather or solar storms. Suit power, cooling water and CO₂ removal. How fast a suited person really walks on Mars. The route stays on ground Curiosity drove because that is the only ground measured at walking scale.</p>
    <p class="small">Data snapshot ${S.site.meta.snapshot_utc}. Not affiliated with or endorsed by NASA.</p>`;
}

// ---------- stop card ----------

function renderStopCard() {
  const card = $('#stopcard');
  if (!S.selected) { card.hidden = true; return; }
  const s = S.byId.get(S.selected);
  const t = target(s);
  const isRefuge = s.id === S.plan.refuge;
  const inPlan = planIndex(s.id) >= 0;
  const photo = s.photo
    ? `<img src="${s.photo.file}" alt="Curiosity Navcam view from this stop">
       <p class="credit">Curiosity Navcam, sol ${s.photo.sol} · ${esc(s.photo.credit)} · <a href="${s.photo.page}" target="_blank" rel="noopener">NASA raw image</a></p>`
    : '<p class="credit">No Navcam frame found for this stop.</p>';
  card.hidden = false;
  card.innerHTML = `
    <button class="close" data-act="close" aria-label="Close">✕</button>
    ${photo}
    <div class="body">
      <h3>${esc(stopName(s))}</h3>
      <div class="kind">${esc(t ? t.kind : 'Curiosity stop')} · sol ${s.sol}</div>
      ${t ? `<p>${esc(t.note)} <a href="${t.source}" target="_blank" rel="noopener">NASA mission blog</a></p>` : ''}
      <div class="trio">
        <div><b>${M.fmtDist(Math.abs(s.chain_m - D.base.chain_m))}</b><span>from refuge</span></div>
        <div><b>${s.elev_m.toFixed(0)} m</b><span>elevation</span></div>
        <div><b>${s.tilt_deg.toFixed(0)}°</b><span>rover tilt</span></div>
      </div>
      <p class="small"><span class="tag measured">MEASURED</span> Position, elevation and tilt from Curiosity's own localisation.</p>
      <div class="actions">
        ${isRefuge ? '<span class="small">This is the refuge.</span>' : `
          <button class="primary" data-act="${inPlan ? 'remove' : 'add'}" data-id="${s.id}">${inPlan ? 'Remove from walk' : 'Add to walk'}</button>
          <button data-act="refuge" data-id="${s.id}">Park refuge here</button>`}
      </div>
    </div>`;
}

// ---------- timeline + profile ----------

function stepLabel() {
  const { tl, stops } = D;
  if (S.t >= tl.endT) return 'Back at the refuge';
  if (S.t <= 0) return 'At the refuge, ready to leave';
  const seg = M.positionAt(tl, S.t).seg;
  if (seg.kind === 'return') return 'Walking home to the refuge';
  const name = stopName(stops[seg.stop].stop);
  return seg.kind === 'walk' ? `Walking to stop ${seg.stop + 1}: ${name}` : `Working at stop ${seg.stop + 1}: ${name}`;
}

function renderTimeline() {
  const scrub = $('#scrub');
  scrub.max = Math.ceil(D.tl.endT * 60);
  scrub.value = Math.round(S.t * 60);
  $('#tl-label').innerHTML = `<b>${M.clockAt(S.p, S.t)}</b> · ${M.fmtDur(S.t)} outside · ${esc(stepLabel())}`;
}

function renderProfile() {
  const box = $('#profile');
  const W = Math.max(320, box.clientWidth);
  const H = 96;
  const pad = { l: 52, r: 12, t: 16, b: 18 };
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

  const step = Math.max(1, Math.floor(route.length / (W / 2)));
  const pts = route.filter((_, i) => i % step === 0 || i === route.length - 1);
  const line = pts.map((r) => `${x(r[3]).toFixed(1)},${y(r[2]).toFixed(1)}`).join(' ');

  let steep = '';
  route.forEach((r, i) => {
    if (i && S.slopes[i] > M.NASA.suitSlopeDeg) {
      const q = route[i - 1];
      steep += `<line x1="${x(q[3])}" y1="${y(q[2])}" x2="${x(r[3])}" y2="${y(r[2])}" stroke="#ffb62e" stroke-width="4"/>`;
    }
  });

  let beyond = '';
  if (S.show.reach) {
    const reach = M.reachAt(S.p, S.t);
    for (const [a, b] of [[c0, base - reach], [base + reach, c1]]) {
      if (b > a) beyond += `<rect x="${x(a)}" y="${pad.t}" width="${x(b) - x(a)}" height="${floor - pad.t}" fill="url(#hatch)"/>`;
    }
  }

  const chains = [base, ...D.stops.map((s) => s.chain)];
  const plo = Math.min(...chains);
  const phi = Math.max(...chains);
  const planned = route.filter((r) => r[3] >= plo && r[3] <= phi).map((r) => `${x(r[3]).toFixed(1)},${y(r[2]).toFixed(1)}`).join(' ');

  const mark = (c, label, fill, square) => {
    const px = x(c);
    const shape = square
      ? `<rect x="${px - 7}" y="1" width="14" height="14" rx="2" fill="${fill}" stroke="#111"/>`
      : `<circle cx="${px}" cy="8" r="7.5" fill="${fill}" stroke="#111"/>`;
    return `<line x1="${px}" y1="15" x2="${px}" y2="${floor}" stroke="${fill}" stroke-width="1" opacity="0.7"/>${shape}
      <text x="${px}" y="12" text-anchor="middle" style="fill:#111;font-weight:700">${label}</text>`;
  };
  let marks = mark(base, 'R', '#62d394', true);
  D.stops.forEach((s, i) => { marks += mark(s.chain, i + 1, '#ff5fdc', false); });

  let brk = '';
  if (!D.res.ok) {
    const bx = x(D.res.breakAt.chain);
    brk = `<line x1="${bx}" y1="${pad.t}" x2="${bx}" y2="${floor}" stroke="#ff5a52" stroke-width="3" stroke-dasharray="5 3"/>`;
  }

  const you = M.pointAtChain(route, M.positionAt(D.tl, S.t).chain);
  const youMark = `<line x1="${x(you.chain)}" y1="${pad.t}" x2="${x(you.chain)}" y2="${floor}" stroke="#fff" stroke-width="1.5"/>
    <circle cx="${x(you.chain)}" cy="${y(you.elev)}" r="5" fill="#fff" stroke="#111" stroke-width="2.5"/>`;

  box.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Elevation along the route">
    <defs><pattern id="hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
      <rect width="8" height="8" fill="#ffb62e" opacity="0.10"/><line x1="0" y1="0" x2="0" y2="8" stroke="#ffb62e" stroke-width="2" opacity="0.55"/></pattern></defs>
    <polygon points="${x(c0)},${floor} ${line} ${x(c1)},${floor}" fill="#1d232c"/>
    ${beyond}
    <polyline points="${line}" fill="none" stroke="#cfd3d8" stroke-width="1.5"/>
    <polyline points="${planned}" fill="none" stroke="#ff5fdc" stroke-width="2.5"/>
    ${steep}${marks}${brk}${youMark}
    <text x="4" y="${y(e1) + 4}">${e1.toFixed(0)} m</text>
    <text x="4" y="${floor}">${e0.toFixed(0)} m</text>
    <text x="${pad.l}" y="${H - 4}">0</text>
    <text x="${W - pad.r}" y="${H - 4}" text-anchor="end">${M.fmtDist(c1 - c0)} along Curiosity's track · elevation measured by the rover</text>
  </svg>`;
}

// ---------- cuff card ----------

function renderCuff() {
  const { base, stops, tl } = D;
  const R = S.site.meta.mars_radius_m;
  const route = S.site.route;
  const chains = [base.chain_m, ...stops.map((s) => s.chain)];
  const lo = Math.min(...chains);
  const hi = Math.max(...chains);
  const path = M.sliceRoute(route, lo, hi).map((pt) => M.toLocalM(base, pt, R));
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
  const px = (q) => `${(ox + q.x * k).toFixed(1)},${(oy - q.y * k).toFixed(1)}`;
  const barM = [1000, 500, 200, 100, 50].find((b) => b * k <= 110) || 20;

  const sketch = `<svg viewBox="0 0 ${size} ${size}">
    <polyline points="${path.map(px).join(' ')}" fill="none" stroke="#000" stroke-width="3"/>
    ${marks.map((m) => {
      const [cx, cy] = px(m).split(',').map(Number);
      const shape = m.sq ? `<rect x="${cx - 11}" y="${cy - 11}" width="22" height="22" fill="#fff" stroke="#000" stroke-width="2.5"/>`
        : `<circle cx="${cx}" cy="${cy}" r="11" fill="#fff" stroke="#000" stroke-width="2.5"/>`;
      return `${shape}<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">${m.label}</text>`;
    }).join('')}
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
      <td><b>${esc(stopName(s.stop))}</b><div class="leg">bearing ${String(brg).padStart(3, '0')}° · ${M.fmtDist(leg.distM)} · climb ${leg.climbM.toFixed(0)} m · ${M.fmtWalkRange(S.p, leg.distM)} · work ${s.dwellMin} min</div></td>
      <td class="by">${M.clockAt(S.p, lb.t)}</td></tr>`;
  }).join('');

  const last = stops[stops.length - 1];
  const homeM = last ? Math.abs(last.chain - base.chain_m) : 0;
  const verdict = D.res.ok
    ? `<div class="big">LEAVE LAST STOP BY<b>${M.clockAt(S.p, tl.turnT)}</b>Plan time. Hard limit in the right column.</div>`
    : `<div class="big">✕ PLAN DOES NOT FIT<b>${M.clockAt(S.p, D.res.breakAt.t)}</b>${cap(D.res.breakAt.limiting)} runs short. Shorten the walk.</div>`;

  $('#cuff').innerHTML = `
    <h1>TENACITY · MARSWALK CARD</h1>
    <p class="sub">${esc(S.site.meta.name)} · leave ${S.p.startClock} · sunset ${S.p.sunsetClock}</p>
    ${sketch}
    <table>
      <tr><th></th><th>Stop</th><th style="text-align:right">Start home by</th></tr>
      ${rows}
      <tr><td class="n">R</td><td><b>Home: ${esc(stopName(base))}</b><div class="leg">${M.fmtDist(homeM)} from last stop · ${M.fmtWalkRange(S.p, homeM)} · planned back ${M.clockAt(S.p, tl.endT)}</div></td>
        <td class="by"></td></tr>
    </table>
    ${verdict}
    <p class="rule"><b>Rule.</b> Keep oxygen for the walk home at ${M.WALKBACK_FACTOR.toFixed(1)}× working effort and ${S.p.slowFactor}× the planned time, plus ${S.p.reserveMin} min. Be home ${S.p.reserveMin} min before sunset.</p>
    <p class="fine">Assumed: ${S.p.speedKmh} km/h walking, ${S.p.o2StartKg} kg oxygen at start. Bearings are straight lines between stops; follow the rover track. Route and elevation: Curiosity, NASA/JPL-Caltech. Snapshot ${S.site.meta.snapshot_utc}.</p>`;
}

// ---------- render + events ----------

function renderLive() {
  renderStrip();
  renderMap();
  renderTimeline();
  renderProfile();
}

function render() {
  D = derive();
  S.t = Math.min(S.t, D.tl.endT);
  renderWalk();
  renderLayers();
  renderStopCard();
  renderLive();
}

function select(id) {
  S.selected = id;
  renderStopCard();
  renderMap();
}

function act(action, id) {
  if (action === 'select') return select(id);
  if (action === 'close') S.selected = null;
  if (action === 'add') S.plan.stops.push({ id, dwellMin: 30 });
  if (action === 'remove') S.plan.stops = S.plan.stops.filter((s) => s.id !== id);
  if (action === 'refuge') {
    S.plan.stops = S.plan.stops.filter((s) => s.id !== id);
    S.plan.refuge = id;
  }
  if (action === 'reset') { defaultPlan(); S.t = 0; }
  if (action === 'cuff') { renderCuff(); $('#cuff-sheet').hidden = false; return; }
  save();
  render();
}

function wire() {
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b) act(b.dataset.act, b.dataset.id);
  });

  $('.tabs').addEventListener('click', (e) => {
    const tab = e.target.dataset.tab;
    if (!tab) return;
    document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab));
    document.querySelectorAll('.tab').forEach((s) => { s.hidden = s.id !== `tab-${tab}`; });
  });

  $('#tab-walk').addEventListener('change', (e) => {
    const el = e.target;
    if (el.dataset.dwell !== undefined) {
      S.plan.stops[Number(el.dataset.dwell)].dwellMin = Math.max(0, Number(el.value) || 0);
    } else if (el.dataset.param) {
      const key = el.dataset.param;
      if (key.endsWith('Clock')) { if (/^([01]\d|2[0-3]):[0-5]\d$/.test(el.value)) S.p[key] = el.value; }
      else if (Number(el.value) > 0 || key === 'reserveMin') S.p[key] = Math.max(0, Number(el.value) || 0);
    } else return;
    save();
    render();
  });

  $('#tab-layers').addEventListener('change', (e) => {
    const key = e.target.dataset.show;
    if (!key) return;
    S.show[key] = e.target.checked;
    renderLive();
  });

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
  window.addEventListener('resize', renderProfile);
}

async function main() {
  const [site, cfg] = await Promise.all(['data/site.json', 'data/targets.json'].map((u) => fetch(u).then((r) => r.json())));
  S.site = site;
  S.cfg = cfg;
  site.stops.forEach((s) => S.byId.set(s.id, s));
  S.slopes = M.routeSlopes(site.route);
  defaultPlan();
  loadSaved();
  initMap();
  wire();
  renderSources();
  render();
}

main();
