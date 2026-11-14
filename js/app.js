// Tenacity EVA planner. Panels, events and the plan/simulate/validate loop.
// The plan lives in plan.js, the walk simulation in sim.js, the map and its layers in mapview.js.
import * as M from './model.js';
import { pickLandscape, compass } from './photo.js';
import { S, C, RAMP, $, esc, ll, clamp, on, log, fmtM, fmtMin, fmtHM, pet, clockH, parseClock, fmtLat, fmtLon, localM, distM, headingDeg, MARS_HOUR_S } from './state.js';
import * as P from './plan.js';
import * as MV from './mapview.js';
import * as SIM from './sim.js';
import * as SUN from './sun.js';
import { initData, playheadMoved } from './data.js';

const STORE = 'tenacity.v3';
const PHOTO_FEED = 'https://mars.nasa.gov/rss/api/?feed=raw_images&category=msl&feedtype=json&num=500&sol=';
const LETTER = { warning: 'W', caution: 'C', advisory: 'A' };
const RANK = { pass: 0, advisory: 1, caution: 2, warning: 3 };
const TABS = [['sequence', 'Sequence'], ['timeline', 'Timeline'], ['profile', 'Profile'], ['layers', 'Layers'], ['rovers', 'Rovers'], ['sources', 'Sources']];
const TAG = (t) => `<span class="tag">${t}</span>`;
const CONS = { o2: 'Oxygen', co2: 'CO₂ made', water: 'Cooling water', battery: 'Battery' };
const field = (level) => (LETTER[level] ? `<b class="f f${LETTER[level]}">${LETTER[level]}</b>` : '');

// What the crew can change before a walk (INCONS: initial conditions). Defaults come from sim.js.
const PARAMS = [
  ['egress', 'Leave refuge', 'LMST', 'clock'],
  ['sunset', 'Sunset', 'LMST', 'clock'],
  ['speedKmh', 'Walking speed, level ground', 'km/h', 0.1],
  ['o2StartKg', 'Oxygen at egress', 'kg', 0.01],
  ['reserveMin', 'Reserve kept', 'min', 5],
  ['emergencyReturnMin', 'Suit-failure return limit', 'min', 5],
  ['slopeLimitDeg', 'Slope limit', '°', 1],
  ['maxEvaH', 'Longest EVA', 'h', 0.5],
];

// ---------- state ----------

function save() {
  try { localStorage.setItem(STORE, JSON.stringify({ trip: S.trip, plan: S.plan, params: S.params })); } catch { /* storage may be blocked */ }
}

function loadSaved() {
  try {
    const raw = JSON.parse(localStorage.getItem(STORE) || 'null');
    if (!raw || !P.valid(raw.plan)) return false;
    S.trip = raw.trip;
    S.plan = raw.plan;
    S.params = { ...S.params, ...raw.params };
    return true;
  } catch { return false; }
}

const trip = () => S.cfg.trips.find((t) => t.id === S.trip);

function defaultParams() {
  const p = { egress: '09:00', sunset: '' };
  for (const [key] of PARAMS) if (SIM.SUIT[key]) p[key] = SIM.SUIT[key].value;
  return p;
}

function loadTrip(id, resetParams = false) {
  S.trip = id;
  S.plan = P.fromTrip(trip());
  S.tS = 0;
  S.sel = null;
  S.probe = null;
  if (resetParams) S.params = defaultParams();
}

// ---------- plan, simulate, validate ----------

function environment() {
  const ref = P.refugePt();
  S.sun = SUN.marsSun(Date.now(), ref.lat, ref.lon);
  const sunset = parseClock(S.params.sunset) ?? S.sun.sunsetLmstH;
  const env = { sun: { sunsetLmstH: sunset, sunriseLmstH: S.sun.sunriseLmstH }, looseAt: (lat, lon) => looseClass(lat, lon) === 2 };
  if (S.home && S.grid) {
    env.homeTimeS = (lat, lon) => {
      const c = S.T.cellOf(S.grid, lat, lon);
      const t = c.inside ? S.home.time[c.row * S.grid.w + c.col] : Infinity;
      return Number.isFinite(t) ? t : undefined;
    };
  }
  if (S.vis && S.grid) {
    env.visibleFromRefuge = (lat, lon) => {
      const c = S.T.cellOf(S.grid, lat, lon);
      return c.inside ? S.vis[c.row * S.grid.w + c.col] === 1 : false;
    };
  }
  if (S.science.spaceweather) env.spaceWeather = S.science.spaceweather.env;
  return env;
}

function simParams() {
  const p = {};
  for (const [key, , , kind] of PARAMS) if (kind !== 'clock' && Number.isFinite(S.params[key])) p[key] = S.params[key];
  return p;
}

let lastVerdict = '';
function recompute() {
  S.legs = P.buildLegs();
  const egress = parseClock(S.params.egress) ?? 9;
  S.sim = SIM.simulate(P.buildSimPlan(S.legs, egress), simParams(), environment());
  S.tS = clamp(S.tS, 0, S.sim.totals.durS);
  keepOutRule();
  const v = S.sim.verdict;
  const line = `Simulation: ${v.go ? 'GO' : 'NO-GO'}, limiting rule ${v.limiting}, margin ${signedMin(v.marginMin)}`;
  if (line !== lastVerdict) { log('status', line); lastVerdict = line; }
}

// FR-12: no part of the walk may pass through a keep-out zone.
function keepOutRule() {
  const zones = S.plan.koz || [];
  if (!zones.length) return;
  const sim = S.sim;
  const inside = (q) => zones.some((z) => distM(z, q) <= z.r);
  const segments = [];
  let open = null;
  for (const q of sim.samples) {
    if (sim.steps[q.stepIndex].type === 'walk' && inside(q)) {
      if (open && open.stepIndex === q.stepIndex) open.toDistM = q.distM;
      else { open = { stepIndex: q.stepIndex, fromDistM: q.distM, toDistM: q.distM, level: 'warning' }; segments.push(open); }
    } else open = null;
  }
  const bad = segments.length > 0;
  sim.rules.push({ id: 'FR-12', title: 'Keep-out zones', level: bad ? 'warning' : 'pass', value: segments.length, limit: 0, units: 'crossings',
    text: bad ? `The walk passes through a keep-out zone on ${[...new Set(segments.map((s) => sim.steps[s.stepIndex].id))].join(', ')}.` : `The walk stays clear of ${zones.length} keep-out zone${zones.length === 1 ? '' : 's'}.`,
    stepIndex: bad ? segments[0].stepIndex : null, segments });
  if (bad) {
    sim.verdict.go = false;
    segments.forEach((s) => { const st = sim.steps[s.stepIndex]; (st.flags ||= []).includes('FR-12') || st.flags.push('FR-12'); });
  }
}

const signedMin = (m) => (Number.isFinite(m) ? `${m >= 0 ? '+' : '−'}${Math.abs(Math.round(m))} min` : 'n/a');
const ruleOf = (id) => S.sim.rules.find((r) => r.id === id);
const stepLevel = (step) => (step.flags || []).reduce((best, id) => {
  const r = ruleOf(id);
  return r && RANK[r.level] > RANK[best] ? r.level : best;
}, 'pass');

// ---------- probes: what the layers say at a point ----------

function looseClass(lat, lon) {
  const { grid, width, height } = S.overlays.loose;
  const [[south, west], [north, east]] = S.overlays.bounds;
  const col = Math.floor(((lon - west) / (east - west)) * width);
  const row = Math.floor(((north - lat) / (north - south)) * height);
  if (col < 0 || row < 0 || col >= width || row >= height) return 0;
  return Number(grid[row][col]);
}

function gridValue(arr, lat, lon) {
  if (!arr || !S.grid) return null;
  const c = S.T.cellOf(S.grid, lat, lon);
  return c.inside ? arr[c.row * S.grid.w + c.col] : null;
}

// ---------- title bar ----------

function renderTitle() {
  const v = S.sim.verdict;
  const t = S.sim.totals;
  $('#trip').innerHTML = S.cfg.trips.map((x) => `<option value="${x.id}" ${x.id === S.trip ? 'selected' : ''}>${esc(x.name)}</option>`).join('');
  $('#mode').innerHTML = [['sketch', 'Sketch', 'Each click on the map adds a station'], ['edit', 'Edit', 'Select, probe and adjust'], ['lock', 'Lock', 'Read-only, for following the walk']]
    .map(([id, label, tip]) => `<button data-act="mode" data-id="${id}" class="${S.mode === id ? 'on' : ''}" title="${tip}" aria-pressed="${S.mode === id}">${label}</button>`).join('');
  const lim = ruleOf(v.limiting);
  const blockers = S.sim.rules.filter((r) => r.level === 'warning');
  $('#verdict').innerHTML = `<span class="${v.go ? 'go' : 'nogo'}">${v.go ? 'GO' : 'NO-GO'}</span>
    ${blockers.length ? `<span class="k">Blocked by</span><span class="t">${blockers.map((r) => `${r.id} ${esc(r.title)}`).join(', ')}</span>` : ''}
    <span class="k">Margin</span><span class="v">${signedMin(v.marginMin)}</span>
    <span class="k${blockers.length ? ' opt' : ''}">Limiting rule</span><span class="t${blockers.length ? ' opt' : ''}">${esc(v.limiting || '')} ${lim ? esc(lim.title) : ''}</span>
    <span class="k opt">EVA</span><span class="v opt">${fmtHM(t.durS)}</span>
    <span class="k opt">Back</span><span class="v opt">${esc(t.backLmst || '')} LMST</span>`;
  const count = (level) => S.sim.rules.filter((r) => r.level === level).length;
  $('#alerts').innerHTML = `<span class="k">Alerts</span>${['warning', 'caution', 'advisory'].map((lv) => {
    const n = count(lv);
    return `<span class="f ${n ? `f${LETTER[lv]}` : 'f0'}" title="${n} ${lv}${n === 1 ? '' : 's'}">${LETTER[lv]} ${n}</span>`;
  }).join('')}`;
}

// ---------- activity list ----------

const isSel = (type, i) => S.sel && S.sel.type === type && (i === undefined || S.sel.i === i);
const locked = () => S.mode === 'lock';
const dis = () => (locked() ? 'disabled' : '');

function inconsCard() {
  const rows = PARAMS.map(([key, label, unit, kind]) => {
    const suit = SIM.SUIT[key];
    const tag = key === 'sunset' ? 'DERIVED' : suit ? suit.tag : 'ASSUMED';
    const val = key === 'sunset' && !S.params.sunset ? clockH(S.sun.sunsetLmstH) : S.params[key];
    const input = kind === 'clock'
      ? `<input type="text" inputmode="numeric" maxlength="5" placeholder="HH:MM" value="${esc(val ?? '')}" data-param="${key}" aria-label="${label}" ${dis()}>`
      : `<input type="number" step="${kind}" min="0" value="${val ?? ''}" data-param="${key}" aria-label="${label}" ${dis()}>`;
    return `<span class="k">${label}</span><span class="v">${input} ${unit}${TAG(tag)}</span>`;
  }).join('');
  const ref = P.refugePt();
  return `<div class="card">
    <span class="k">Refuge</span><span>${esc(ref.name)}</span>
    <span class="k">Position</span><span class="v">${fmtLat(ref.lat)}, ${fmtLon(ref.lon)}</span>
    ${rows}
    <span class="wide dim">Sunset is worked out for today's season at the refuge unless you type one. The refuge is a pressurised rover: probe a point on the map to park it elsewhere.</span>
    <div class="acts"><button class="btn pl" data-act="reset" ${dis()}>Reset plan and INCONS</button></div>
  </div>`;
}

function legCard(leg, step, isReturn) {
  const canTrack = leg.from.chain !== null && leg.dest.chain !== null;
  const which = isReturn ? 'ret' : leg.station;
  return `<div class="card">
    <span class="k">Goal x, y</span><span class="v">${leg.goal.x.toFixed(1)}, ${leg.goal.y.toFixed(1)} m</span>
    <span class="k">Frame</span><span>SITE, origin at the refuge</span>
    <span class="k">Heading</span><span class="v">${String(Math.round(leg.headingDeg)).padStart(3, '0')}° true</span>
    <span class="k">Length</span><span class="v">${fmtM(leg.lengthM)}</span>
    <span class="k">Climb / drop</span><span class="v">↑${Math.round(step.climbM)} m ↓${Math.round(step.dropM)} m</span>
    <span class="k">Steepest</span><span class="v">${step.maxSlopeDeg.toFixed(0)}° ${step.maxSlopeDeg > (S.params.slopeLimitDeg ?? 20) ? field('warning') : ''}</span>
    <span class="k">Walk time</span><span class="v">${fmtMin(step.t1S - step.t0S)}</span>
    <span class="k">Path</span><span><select data-legmode="${which}" aria-label="How this leg is walked" ${dis()}>
      <option value="track" ${leg.mode === 'track' ? 'selected' : ''} ${canTrack ? '' : 'disabled'}>Follow rover track</option>
      <option value="auto" ${leg.mode === 'auto' ? 'selected' : ''} ${S.grid ? '' : 'disabled'}>Easiest path over terrain</option>
      <option value="direct" ${leg.mode === 'direct' ? 'selected' : ''}>Straight line</option></select></span>
    <span class="k">Ground</span><span>${leg.proven ? 'Driven by a rover' : `Known from orbit only ${field('caution')}`}</span>
    ${leg.searching ? '<span class="wide dim">Searching for a path over the terrain…</span>' : ''}
    ${leg.noRoute ? `<span class="wide">${field('caution')} No path under the slope limit; straight line shown.</span>` : ''}
  </div>`;
}

function stationCard(i, step) {
  const st = S.plan.stations[i];
  const p = P.pointOf(st.at);
  return `<div class="card">
    <span class="k">Position</span><span class="v">${fmtLat(p.lat)}, ${fmtLon(p.lon)}</span>
    <span class="k">Arrive / leave</span><span class="v">${step.lmst0} / ${step.lmst1} LMST</span>
    <span class="k">Work here</span><span class="step"><button data-act="dwell" data-i="${i}" data-delta="-15" aria-label="15 minutes less" ${dis()}>−</button><output>${st.dwellMin} min</output><button data-act="dwell" data-i="${i}" data-delta="15" aria-label="15 minutes more" ${dis()}>+</button></span>
    <span class="k">Effort</span><span><select data-effort="${i}" aria-label="Work effort" ${dis()}>${['light', 'moderate', 'heavy'].map((e) => `<option ${st.effort === e ? 'selected' : ''}>${e}</option>`).join('')}</select></span>
    <span class="k">Oxygen on leaving</span><span class="v">${step.o2EndKg.toFixed(2)} kg</span>
    <span class="k">Walk home from here</span><span class="v">${fmtMin(step.homeEndS)}</span>
    <div class="acts">
      <button class="btn pl" data-act="move" data-i="${i}" data-delta="-1" ${i === 0 ? 'disabled' : dis()}>Earlier</button>
      <button class="btn pl" data-act="move" data-i="${i}" data-delta="1" ${i === S.plan.stations.length - 1 ? 'disabled' : dis()}>Later</button>
      <button class="btn pl" data-act="remove" data-i="${i}" ${dis()}>Remove</button>
    </div>
  </div>`;
}

function renderActivity() {
  const sim = S.sim;
  const cur = P.stepAt(sim, S.tS);
  const walk = (id) => sim.steps.find((s) => s.type === 'walk' && s.id === id);
  const work = (id) => sim.steps.find((s) => s.type === 'work' && s.id === id);
  const row = (type, i, dot, id, desc, n, step) => `<button class="row${isSel(type, i) ? ' sel' : ''}${step && cur === step && S.tS > 0 ? ' cur' : ''}" data-act="sel" data-type="${type}" ${i === undefined ? '' : `data-i="${i}"`}>
    <i class="dot ${dot}"></i><span class="id">${id}</span><span class="d">${desc}</span><span class="n">${step ? field(stepLevel(step)) : ''} ${n}</span></button>`;

  let html = row('incons', undefined, 'rf', 'INCONS', `${esc(S.params.egress)} LMST · O<sub>2</sub> ${S.params.o2StartKg} kg`, '');
  if (isSel('incons')) html += inconsCard();
  S.legs.forEach((leg) => {
    const ws = walk(leg.id);
    const ret = leg.station === null;
    html += row(ret ? 'return' : 'leg', ret ? undefined : leg.station, leg.proven ? '' : 'dash', leg.id, { track: 'Follow rover track', auto: leg.searching ? 'Finding path…' : 'Path over terrain', direct: 'Straight line' }[leg.mode], fmtM(leg.lengthM), ws);
    if (isSel(ret ? 'return' : 'leg', ret ? undefined : leg.station)) html += legCard(leg, ws, ret);
    if (!ret) {
      const st = work(leg.to);
      html += row('station', leg.station, 'st', leg.to, esc(leg.toName), `${S.plan.stations[leg.station].dwellMin} min`, st);
      if (isSel('station', leg.station)) html += stationCard(leg.station, st);
    }
  });
  (S.plan.koz || []).forEach((z, k) => {
    html += `<div class="row"><i class="dot kz"></i><span class="id">KOZ_${String(k + 1).padStart(2, '0')}</span><span class="d">Keep-out circle, r ${z.r} m</span><span class="n">${locked() ? '' : `<button class="btn pl" data-act="unkoz" data-i="${k}" style="min-height:20px;padding:0 6px">Remove</button>`}</span></div>`;
  });
  html += `<div class="note">${S.mode === 'sketch' ? 'Sketch mode: each click on the map adds a station at that point.'
    : S.mode === 'lock' ? 'Locked. Switch to Edit to change the plan.'
    : 'Click the map to probe a point, then add it as a station from the Probe panel.'}</div>`;
  $('#activity').innerHTML = html;
  $('#act-sum').textContent = `${S.plan.stations.length} station${S.plan.stations.length === 1 ? '' : 's'} · ${fmtM(sim.totals.distM)}`;
}

// ---------- cursor ----------

let cursorRaf = 0;
function renderCursor(pt) {
  cancelAnimationFrame(cursorRaf);
  cursorRaf = requestAnimationFrame(() => {
    const row = (k, v) => `<div class="pr"><span class="k">${k}</span><span class="v">${v}</span></div>`;
    if (!pt) { $('#cursor').innerHTML = row('Lat (planetocentric)', '<span class="na">off map</span>') + row('Lon (east)', '') + row('SITE x, y', '') + row('Elevation', ''); return; }
    const ref = P.refugePt();
    const xy = localM(ref, pt);
    const e = S.grid ? S.T.elevAt(S.grid, pt.lat, pt.lon) : NaN;
    const sl = gridValue(S.slope, pt.lat, pt.lon);
    $('#cursor').innerHTML = row('Lat (planetocentric)', fmtLat(pt.lat)) + row('Lon (east)', fmtLon(pt.lon))
      + row('SITE x, y', `${xy.x.toFixed(0)}, ${xy.y.toFixed(0)} m`)
      + row('Elevation', Number.isFinite(e) ? `${e.toFixed(1)} m${sl !== null && Number.isFinite(sl) ? ` · slope ${sl.toFixed(0)}°` : ''}` : '<span class="na">grid not loaded</span>');
  });
}

// ---------- simulation and rules ----------

function renderSim() {
  const sim = S.sim;
  const fmt = (c, v) => (v === null || v === undefined || !Number.isFinite(v) ? '<span class="na">n/a</span>' : c.units === 'Wh' ? v.toFixed(0) : v.toFixed(2));
  const state = (s) => (s === 'ok' ? '<span class="ok">OK</span>' : field(s));
  const w = S.site.weather;
  const age = Math.round((Date.now() - Date.parse(w.earth_date)) / 86400000);
  $('#sim').innerHTML = `<div class="hd">Simulation <small>${sim.steps.length} steps · ${sim.samples.length} points</small></div>
    <table><tr><th class="l">Consumable</th><th>Start</th><th>End</th><th>Change</th><th>State</th></tr>
    ${sim.consumables.map((c) => `<tr><td class="t">${esc(CONS[c.id] || c.title)}, ${esc(c.units)}</td><td>${fmt(c, c.start)}</td><td>${fmt(c, c.end)}</td><td>${fmt(c, Math.abs(c.used))}</td><td>${state(c.state)}</td></tr>`).join('')}</table>
    <div class="pr"><span class="k">Distance walked</span><span class="v">${fmtM(sim.totals.distM)}</span></div>
    <div class="pr"><span class="k">EVA duration</span><span class="v">${fmtHM(sim.totals.durS)}</span></div>
    <div class="pr"><span class="k">Likely range</span><span class="v">${fmtHM(sim.totals.durLowS)} to ${fmtHM(sim.totals.durHighS)}${TAG('DERIVED')}</span></div>
    <div class="pr"><span class="k">Back at refuge</span><span class="v">${esc(sim.totals.backLmst)} LMST · sunset ${clockH(parseClock(S.params.sunset) ?? S.sun.sunsetLmstH)}</span></div>
    <div class="sub">Environment</div>
    ${pr('Radiation, this walk', `${M.doseMsv(sim.totals.durS / 3600).toFixed(2)} mSv`, 'DERIVED')}
    ${pr('Air temperature', `<b class="f fS" title="Stale data">S</b> ${w.air_min_c} to ${w.air_max_c} °C <span class="t dim">sol ${w.sol}, ${age} days old</span>`, 'MEASURED')}
    ${pr('Season', `L<sub>s</sub> ${S.sun.lsDeg.toFixed(0)}° · daylight ${S.sun.dayLengthH.toFixed(1)} Mars h`, 'DERIVED')}`;
}

function renderRules() {
  const sim = S.sim;
  $('#rules').innerHTML = `<div class="hd">Validation · flight rules <small>${sim.rules.filter((r) => r.level === 'pass').length} of ${sim.rules.length} pass</small></div>
    ${sim.rules.map((r) => `<button class="rule" data-act="rule" data-id="${r.id}" title="Show where on the map">
      <span class="id">${r.id}</span><span>${esc(r.title)}<small class="${r.level === 'pass' ? 'one' : ''}" title="${esc(r.text)}">${esc(r.text)}</small></span>
      <span class="st">${r.level === 'pass' ? '<span class="ok">PASS</span>' : field(r.level)}</span></button>`).join('')}`;
}

// ---------- probe ----------

// Photos are bundled for the boxwork stops. Every other stop asks NASA's raw-image feed for the
// Navcam frames taken at that rover position and keeps the one that looks along the track with
// the horizon in view and no rover deck (see photo.js).
async function loadPhoto(s) {
  s.photoState = 'loading';
  const [site, drive] = s.id.split('_').map(Number);
  const next = S.site.stops[S.site.stops.indexOf(s) + 1];
  const lastSol = Math.min(next ? Math.max(next.sol - 1, s.sol) : s.sol, s.sol + 2);
  const bearing = next ? M.bearingDeg(s, next) : null;
  try {
    let best = null;
    for (let sol = s.sol; sol <= lastSol && !(best && best.tier === 0); sol++) {
      const feed = await fetch(PHOTO_FEED + sol).then((r) => r.json());
      const pick = pickLandscape(feed.images || [], site, drive, bearing);
      if (pick && (!best || pick.score < best.score)) best = pick;
    }
    if (best) {
      s.photo = { url: best.im.image_files.medium.replace(/^http:/, 'https:'), sol: best.im.sol, page: best.im.link, credit: best.im.credit, looking: compass(best.pointing.az) };
    }
    s.photoState = best ? 'ok' : 'none';
  } catch { s.photoState = 'offline'; }
  if (S.probe && S.probe.stop === s.id) renderProbe();
}

const pr = (k, v, tag = '') => `<div class="pr"><span class="k">${k}</span><span class="v">${v}${tag ? TAG(tag) : ''}</span></div>`;
const missing = (why) => `<b class="f fS">M</b> <span class="t">${why}</span>`;

function mineralsHTML(s) {
  return P.samplesAt(s).map((sm) => {
    const whole = [sm.clay_pct !== null ? `clay ${sm.clay_pct}%` : '', sm.amorphous_pct !== null ? `non-crystalline ${sm.amorphous_pct}%` : ''].filter(Boolean).join(', ');
    return `<div class="sub">Minerals in ${esc(sm.sample)} · CheMin, sol ${sm.sol}${TAG('MEASURED')}</div>
      <div class="bars">${sm.minerals.slice(0, 5).map(([name, pct]) => `<div><span>${esc(name)}</span><i><b style="width:${Math.min(100, pct)}%"></b></i><em>${pct}%</em></div>`).join('')}</div>
      <div class="note">Shares of the crystalline part.${whole ? ` Of the whole sample: ${whole}.` : ''} <a href="${S.minerals.source_url}${sm.product}.lbl" target="_blank" rel="noopener">NASA PDS record</a></div>`;
  }).join('');
}

function renderProbe() {
  const el = $('#probe');
  const pt = S.probe;
  if (!pt) {
    el.innerHTML = '<div class="hd">Probe</div><div class="note">Click anywhere on the map to read every layer at that point. Click a rover stop (tick on the track) for its photo and measurements.</div>';
    return;
  }
  const s = pt.stop ? S.byId.get(pt.stop) : null;
  const ref = P.refugePt();
  const xy = localM(ref, pt);
  const stationIndex = S.plan.stations.findIndex((st) => (s ? st.at.stop === s.id : st.at.lat === pt.lat && st.at.lon === pt.lon));
  const isRefuge = s ? S.plan.refuge.stop === s.id : false;

  let head = '';
  if (s) {
    if (!s.photo && !s.photoState) loadPhoto(s);
    const waiting = { loading: "Loading Curiosity's view from NASA", none: 'No Navcam frame found for this stop', offline: 'The photo needs a connection to NASA' }[s.photoState];
    head = s.photo
      ? `<figure><img src="${s.photo.file || s.photo.url}" alt="Curiosity Navcam view from this stop"><figcaption><span>Navcam · sol ${s.photo.sol}${s.photo.looking ? ` · looking ${s.photo.looking}` : ''}</span><a href="${s.photo.page}" target="_blank" rel="noopener">${esc(s.photo.credit)}</a></figcaption></figure>`
      : `<div class="note">${waiting}</div>`;
    const t = P.target(s);
    head += `<h3>${esc(P.stopName(s))}</h3><div class="kick">${esc(P.stopKind(s))}</div>`;
    if (t) head += `<div class="note">${esc(t.note)} <a href="${t.source}" target="_blank" rel="noopener">${esc(t.source_label)}</a></div>`;
  }

  // Every layer read at this point, shown or not.
  const e = S.grid ? S.T.elevAt(S.grid, pt.lat, pt.lon) : NaN;
  const slope = gridValue(S.slope, pt.lat, pt.lon);
  const orbit = s ? S.overlays.stops[s.id] : null;
  const loose = looseClass(pt.lat, pt.lon);
  const homeS = gridValue(S.home && S.home.time, pt.lat, pt.lon);
  const vis = gridValue(S.vis, pt.lat, pt.lon);
  const lim = S.params.slopeLimitDeg ?? 20;
  const slopeV = slope !== null && Number.isFinite(slope) ? slope : orbit ? orbit[0] : null;
  let rows = pr('Position', `${fmtLat(pt.lat)}, ${fmtLon(pt.lon)}`) + pr('SITE x, y', `${xy.x.toFixed(0)}, ${xy.y.toFixed(0)} m · ${fmtM(distM(ref, pt))} from refuge`);
  rows += '<div class="sub">Terrain</div>';
  if (s) rows += pr('Elevation (rover)', `${s.elev_m.toFixed(1)} m`, 'MEASURED') + pr('Rover tilt here', `${s.tilt_deg.toFixed(1)}°`, 'MEASURED');
  rows += pr('Elevation (orbit)', Number.isFinite(e) ? `${e.toFixed(1)} m` : missing('elevation grid not loaded'), Number.isFinite(e) ? 'MEASURED' : '');
  rows += pr('Slope, 6 m cells', slopeV === null ? missing('not available here') : `${slopeV.toFixed(1)}° ${slopeV > lim ? field('warning') : ''}`, slopeV === null ? '' : 'DERIVED');
  rows += pr('Ground', `<span class="t">${loose === 2 ? 'Loose sand or dust likely' : loose === 1 ? 'Mixed ground' : 'Firm or rocky'}</span>`, 'DERIVED');
  if (orbit && orbit[1] !== null) rows += pr('Thermal inertia', `${orbit[1]} TIU`, 'MEASURED');
  rows += '<div class="sub">Getting home</div>';
  rows += pr('Walk to refuge', homeS === null ? missing('terrain engine not ready') : Number.isFinite(homeS) ? `${fmtMin(homeS)} at emergency pace` : `no route under the block slope ${field('warning')}`, homeS === null ? '' : 'DERIVED');
  rows += pr('Line of sight to refuge', vis === null ? missing('terrain engine not ready') : vis ? 'Yes' : `No ${field('advisory')}`, vis === null ? '' : 'DERIVED');
  for (const extra of S.probeRows || []) rows += extra(pt, s) || '';

  const acts = locked() ? '' : `<div class="pad">
    ${stationIndex >= 0 ? `<button class="btn pl" data-act="remove" data-i="${stationIndex}">Remove from walk</button>` : isRefuge ? '' : '<button class="btn" data-act="add">Add as station</button>'}
    ${isRefuge ? '' : '<button class="btn pl" data-act="refuge">Park refuge here</button>'}
    <button class="btn pl" data-act="koz" title="Mark a 30 m circle that routes must avoid">Add keep-out</button>
    <button class="btn pl" data-act="unprobe">Clear</button></div>`;

  el.innerHTML = `<div class="hd">Probe <small>${s ? `rover stop · sol ${s.sol}` : 'map point'}</small></div>${head}${acts}${rows}${s ? mineralsHTML(s) : ''}`;
}

// ---------- clocks and playback ----------

function buildClock() {
  $('#clock').innerHTML = `
    <div><span class="k">UTC</span><span class="v" id="ck-utc"></span></div>
    <div><span class="k">LMST now</span><span class="v" id="ck-lmst"></span></div>
    <div class="opt"><span class="k">LTST now</span><span class="v" id="ck-ltst"></span></div>
    <div class="opt"><span class="k">Sol</span><span class="v" id="ck-sol"></span></div>
    <div><span class="k">PET</span><span class="v" id="ck-pet"></span></div>
    <div><span class="k">Plan LMST</span><span class="v" id="ck-plan"></span></div>
    <div class="opt"><span class="k">Sunset</span><span class="v" id="ck-sun"></span></div>
    <div><div class="tp" role="group" aria-label="Playback">
      <button data-act="step" data-delta="-1" title="Previous step" aria-label="Previous step">◀◀</button>
      <button data-act="play" id="ck-play" title="Play or pause" aria-label="Play or pause">▶</button>
      <button data-act="stop" title="Back to the start" aria-label="Back to the start">■</button>
      <button data-act="step" data-delta="1" title="Next step" aria-label="Next step">▶▶</button>
      <button data-act="rate" id="ck-rate" title="Playback speed">×60</button></div></div>
    <div id="scrubwrap"><div id="ticks"></div><input id="scrub" type="range" min="0" max="100" step="1" value="0" aria-label="Time in the plan, seconds after egress"></div>`;
  $('#scrub').addEventListener('input', (e) => { S.tS = Number(e.target.value); renderLive(); });
}

function renderClock() {
  const now = Date.now();
  const ref = P.refugePt();
  const sun = SUN.marsSun(now, ref.lat, ref.lon);
  const curiosity = S.rovers.find((r) => r.id === 'curiosity') || S.rovers[0];
  const d = new Date(now);
  const doy = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 0)) / 86400000);
  $('#ck-utc').textContent = `${d.getUTCFullYear()}-${String(doy).padStart(3, '0')}T${d.toISOString().slice(11, 19)}`;
  $('#ck-lmst').textContent = clockH(sun.lmstH, true);
  $('#ck-ltst').textContent = clockH(sun.ltstH, true);
  $('#ck-sol').textContent = curiosity ? Math.floor((now - Date.parse(curiosity.landed_utc)) / (SUN.SOL_LENGTH_S * 1000)) : '';
  renderPlayhead();
}

function renderPlayhead() {
  const egress = parseClock(S.params.egress) ?? 9;
  const planH = egress + S.tS / MARS_HOUR_S;
  const sunset = parseClock(S.params.sunset) ?? S.sun.sunsetLmstH;
  const toSunsetS = (sunset - planH) * MARS_HOUR_S;
  $('#ck-pet').textContent = pet(S.tS);
  $('#ck-plan').textContent = clockH(planH, true);
  $('#ck-sun').textContent = `${toSunsetS >= 0 ? '−' : '+'}${pet(Math.abs(toSunsetS)).slice(2)}`;
  $('#ck-play').textContent = S.playing ? '❚❚' : '▶';
  $('#ck-play').classList.toggle('on', S.playing);
  $('#ck-rate').textContent = `×${S.rate}`;
  const scrub = $('#scrub');
  scrub.max = Math.ceil(S.sim.totals.durS);
  if (document.activeElement !== scrub || S.playing) scrub.value = Math.round(S.tS);
}

function renderTicks() {
  const dur = S.sim.totals.durS || 1;
  $('#ticks').innerHTML = [0, ...S.sim.steps.map((s) => s.t1S)].map((t) => `<i style="left:${(t / dur) * 100}%"></i>`).join('');
}

let playTimer = 0;
function setPlaying(onNow) {
  S.playing = onNow;
  clearInterval(playTimer);
  if (onNow) {
    if (S.tS >= S.sim.totals.durS) S.tS = 0;
    let last = performance.now();
    playTimer = setInterval(() => {
      const now = performance.now();
      S.tS = Math.min(S.sim.totals.durS, S.tS + ((now - last) / 1000) * S.rate);
      last = now;
      if (S.tS >= S.sim.totals.durS) setPlaying(false);
      renderLive();
    }, 100);
  }
  renderPlayhead();
}

// ---------- bottom dock ----------

function sequenceHTML() {
  const sim = S.sim;
  const cur = P.stepAt(sim, S.tS);
  const args = (s) => (s.type === 'walk'
    ? `${fmtM(s.distM)}, hdg ${String(Math.round(s.headingDeg)).padStart(3, '0')}°, ↑${Math.round(s.climbM)} m, max ${s.maxSlopeDeg.toFixed(0)}°`
    : `${Math.round((s.t1S - s.t0S) / 60)} min, ${esc(S.plan.stations.find((_, i) => P.stationId(i) === s.id)?.effort || 'moderate')} work`);
  return `<table><tr><th>#</th><th>PET start</th><th>PET end</th><th>LMST</th><th class="l">Command</th><th class="l">Target</th><th class="l">Arguments</th><th>Power, W</th><th>O<sub>2</sub> left, kg</th><th>Walk home, min</th><th>Flag</th></tr>
    <tr data-act="seek" data-t="0"><td>0</td><td>${pet(0)}</td><td>${pet(0)}</td><td>${esc(S.params.egress)}</td><td class="l">INCONS</td><td class="l">REFUGE</td><td class="t">egress, O<sub>2</sub> ${S.params.o2StartKg} kg, speed ${S.params.speedKmh} km/h</td><td></td><td>${Number(S.params.o2StartKg).toFixed(2)}</td><td>0</td><td></td></tr>
    ${sim.steps.map((s) => `<tr class="${cur === s && S.tS > 0 ? 'cur' : ''}" data-act="seek" data-t="${s.t0S}" data-step="${s.i}">
      <td>${s.i + 1}</td><td>${pet(s.t0S)}</td><td>${pet(s.t1S)}</td><td>${s.lmst0}</td>
      <td class="l">${s.type === 'walk' ? (s.id === 'RETURN' ? 'RETURN' : 'WALK_TO') : 'WORK'}</td><td class="l">${s.type === 'walk' ? (s.id === 'RETURN' ? 'REFUGE' : esc(S.legs.find((l) => l.id === s.id)?.to || '')) : s.id}</td>
      <td class="t">${args(s)}</td><td>${Math.round(s.meanWatts)}</td><td>${s.o2EndKg.toFixed(2)}</td><td>${Math.round(s.homeEndS / 60)}</td><td>${(s.flags || []).map((id) => { const r = ruleOf(id); return r && r.level !== 'pass' ? `<b class="f f${LETTER[r.level]}" title="${esc(r.id)} ${esc(r.title)}">${LETTER[r.level]}</b>` : ''; }).join(' ')}</td></tr>`).join('')}</table>`;
}

// The plan against the clock, with two strips under it: walk-home time against its limit, and oxygen left.
function timelineHTML(W) {
  const sim = S.sim;
  const dur = sim.totals.durS || 1;
  const padL = 96;
  const padR = 14;
  const x = (t) => padL + (t / dur) * (W - padL - padR);
  const egress = parseClock(S.params.egress) ?? 9;
  const H = 150;
  let g = '';
  // Hour marks on the Mars clock.
  const spanH = dur / MARS_HOUR_S;
  const stepH = spanH > 6 ? 1 : spanH > 2.5 ? 0.5 : 0.25;
  for (let h = Math.ceil(egress / stepH) * stepH; h <= egress + spanH + 1e-9; h += stepH) {
    const px = x((h - egress) * MARS_HOUR_S);
    g += `<line x1="${px}" y1="16" x2="${px}" y2="${H - 4}" stroke="${C.hair}"/><text x="${px}" y="11" text-anchor="middle">${clockH(h)}</text>`;
  }
  g += `<text x="6" y="11">LMST</text><text x="6" y="38">Plan</text><text x="6" y="82">Walk home, min</text><text x="6" y="126">O₂ left, kg</text>`;
  for (const s of sim.steps) {
    const a = x(s.t0S);
    const w = Math.max(x(s.t1S) - a, 1);
    const lv = stepLevel(s);
    if (lv === 'warning' || lv === 'caution') g += `<rect x="${a}" y="22" width="${w}" height="24" fill="${lv === 'warning' ? C.warnfill : C.caut}" opacity="0.5"/>`;
    if (s.type === 'walk') {
      const leg = S.legs.find((l) => l.id === s.id);
      g += `<line x1="${a}" y1="34" x2="${a + w}" y2="34" stroke="${C.route}" stroke-width="4" ${leg && !leg.proven ? 'stroke-dasharray="7 5"' : ''}/>`;
    } else {
      g += `<rect x="${a}" y="26" width="${w}" height="16" fill="${C.bg2}" stroke="${C.text}"/>${w > 44 ? `<text x="${a + 4}" y="38" style="fill:${C.text}">${s.id}</text>` : ''}`;
    }
  }
  // Strip charts read off the simulated samples.
  const strip = (y0, h, value, max, limit, limitLabel) => {
    const y = (v) => y0 + h - (clamp(v, 0, max) / max) * h;
    const pts = sim.samples.map((q) => `${x(q.tS).toFixed(1)},${y(value(q)).toFixed(1)}`).join(' ');
    let out = `<line x1="${padL}" y1="${y0 + h}" x2="${W - padR}" y2="${y0 + h}" stroke="${C.line}"/><polyline points="${pts}" fill="none" stroke="${C.text}" stroke-width="1.5"/>`;
    if (limit !== null) out += `<line x1="${padL}" y1="${y(limit)}" x2="${W - padR}" y2="${y(limit)}" stroke="${C.warn}" stroke-dasharray="4 3"/><text x="${W - padR}" y="${y(limit) - 3}" text-anchor="end" style="fill:${C.warn}">${limitLabel}</text>`;
    return out;
  };
  const fr1 = ruleOf('FR-01');
  const limMin = fr1 ? fr1.limit : 60;
  const maxHome = Math.max(limMin * 1.15, ...sim.samples.map((q) => q.homeS / 60));
  g += strip(60, 34, (q) => q.homeS / 60, maxHome, limMin, `limit ${limMin} min`);
  const o2Start = Number(S.params.o2StartKg) || 1;
  g += strip(104, 34, (q) => q.o2Kg, o2Start, null, '');
  const px = x(S.tS);
  g += `<line x1="${px}" y1="14" x2="${px}" y2="${H - 2}" stroke="${C.route}" stroke-width="2"/>`;
  return `<svg id="tl-svg" data-seekbar="1" data-pad-l="${padL}" data-pad-r="${padR}" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="The plan against the clock">${g}</svg>
    <div class="note">Solid magenta: walking on rover-proven ground. Dashed: ground known from orbit only. Boxes: work at a station. Click or drag to move the playhead.</div>`;
}

// Height along the whole walk, out and back, with slope classes underneath.
function profileHTML(W) {
  const sim = S.sim;
  const pts = sim.samples.filter((q) => sim.steps[q.stepIndex].type === 'walk');
  if (pts.length < 2) return '<div class="note">Add a station to see the ground profile.</div>';
  const padL = 96;
  const padR = 14;
  const H = 150;
  const top = 18;
  const floor = 108;
  const d1 = pts[pts.length - 1].distM || 1;
  const e0 = Math.min(...pts.map((q) => q.elev));
  const e1 = Math.max(...pts.map((q) => q.elev));
  const x = (d) => padL + (d / d1) * (W - padL - padR);
  const y = (e) => floor - ((e - e0) / Math.max(e1 - e0, 1)) * (floor - top);
  const lim = S.params.slopeLimitDeg ?? 20;
  let g = `<text x="6" y="14">Elevation, m</text><text x="6" y="${y(e1) + 14}">${e1.toFixed(0)}</text><text x="6" y="${floor}">${e0.toFixed(0)}</text><text x="6" y="128">Slope class</text><text x="6" y="146">Distance</text>`;
  g += `<polyline points="${pts.map((q) => `${x(q.distM).toFixed(1)},${y(q.elev).toFixed(1)}`).join(' ')}" fill="none" stroke="${C.text}" stroke-width="1.5"/>`;
  g += `<line x1="${padL}" y1="${floor}" x2="${W - padR}" y2="${floor}" stroke="${C.line}"/>`;
  // Slope along the path, classed like the map layer; over the limit is drawn in the warning colour.
  for (let i = 1; i < pts.length; i++) {
    const s = Math.abs(pts[i].slopeDeg);
    const a = x(pts[i - 1].distM);
    const w = Math.max(x(pts[i].distM) - a, 0.6);
    const fill = s > lim ? C.warn : s > 15 ? RAMP[3] : s > 10 ? RAMP[1] : s > 5 ? RAMP[0] : null;
    if (fill) g += `<rect x="${a}" y="116" width="${w}" height="14" fill="${fill}"/>`;
    if (s > lim) g += `<line x1="${a}" y1="${y(pts[i - 1].elev)}" x2="${a + w}" y2="${y(pts[i].elev)}" stroke="${C.warn}" stroke-width="4"/>`;
  }
  g += `<rect x="${padL}" y="116" width="${W - padL - padR}" height="14" fill="none" stroke="${C.line}"/>`;
  const tick = d1 > 6000 ? 1000 : d1 > 2500 ? 500 : 250;
  for (let d = 0; d <= d1; d += tick) g += `<line x1="${x(d)}" y1="${floor}" x2="${x(d)}" y2="${floor + 4}" stroke="${C.label}"/><text x="${x(d)}" y="146" text-anchor="middle">${d >= 1000 ? `${d / 1000} km` : `${d} m`}</text>`;
  // Stations and the return leg.
  sim.steps.filter((s) => s.type === 'work').forEach((s) => {
    const q = sim.samples.find((z) => z.stepIndex === s.i);
    if (q) g += `<line x1="${x(q.distM)}" y1="${top - 4}" x2="${x(q.distM)}" y2="${floor}" stroke="${C.route}"/><text x="${x(q.distM) + 3}" y="${top + 6}" style="fill:${C.route}">${s.id}</text>`;
  });
  const here = P.positionAt(sim, S.tS);
  g += `<line x1="${x(here.distM)}" y1="${top - 6}" x2="${x(here.distM)}" y2="132" stroke="${C.route}" stroke-width="2"/>`;
  return `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="Elevation along the walk">${g}</svg>
    <div class="note">Height along the whole walk, out and back, read from ${S.grid ? 'the HiRISE elevation grid (about 6 m cells)' : "the rover's own elevations"}. Slope classes: ${[[RAMP[0], '5 to 10°'], [RAMP[1], '10 to 15°'], [RAMP[3], `15 to ${lim}°`], [C.warn, `over ${lim}°`]].map(([c, l]) => `<span class="ramp" style="display:inline-flex"><i style="background:${c}"></i>${l}</span>`).join(' ')}</div>`;
}

function layersHTML() {
  const z = MV.map.getZoom();
  const cols = MV.GROUPS.map((group) => {
    const defs = MV.LAYERS.filter((l) => l.group === group);
    if (!defs.length) return '';
    return `<div><div class="sub">${group}</div>${defs.map((d) => {
      const avail = d.avail();
      const onNow = d.kind === 'fill' ? S.fill === d.id : d.cat === 'base' || S.on.has(d.id);
      const input = d.cat === 'base' ? '<input type="checkbox" checked disabled title="Always shown">'
        : `<input type="${d.kind === 'fill' ? 'radio' : 'checkbox'}" name="${d.kind === 'fill' ? 'fill' : d.id}" data-layer="${d.id}" ${onNow ? 'checked' : ''} ${avail ? '' : 'disabled'}>`;
      const ramp = d.ramp && avail ? `<span class="ramp">${d.ramp().map(([c, l]) => `<i style="background:${c}"></i>${l}`).join(' ')}</span>` : '';
      const why = !avail ? ' · not loaded' : d.minZoom && z < d.minZoom ? ' · zoom in to see it' : d.cat === 'base' ? ' · always shown' : '';
      return `<label class="lay${avail ? '' : ' off'}">${input}<span>${esc(d.title)}${TAG(d.tag)}<small>${esc(d.prov)}${why}</small>${ramp}</span></label>`;
    }).join('')}</div>`;
  }).join('');
  return `<div class="pad"><span class="k">Colour fill</span><label><input type="radio" name="fill" data-layer="none" ${S.fill === 'none' ? 'checked' : ''}> None</label>
    <span class="dim">One colour fill at a time; patterns, lines and points stack on top. ${S.custom ? `Custom set, from ${MV.PRESETS.find((p) => p.id === S.preset).title}.` : ''}</span>
    ${S.custom ? `<button class="btn pl" data-act="preset" data-id="${S.preset}">Reset to preset</button>` : ''}</div><div class="cols">${cols}</div>`;
}

function roversHTML() {
  const SOL = SUN.SOL_LENGTH_S * 1000;
  const date = (r, sol) => new Date(Date.parse(r.landed_utc) + sol * SOL).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
  const card = (r) => {
    const today = Math.floor((Date.now() - Date.parse(r.landed_utc)) / SOL);
    return `<div><div class="sub">${esc(r.name)} · ${esc(r.place)}</div>
      ${pr('Position', `${fmtLat(r.now.lat)}, ${fmtLon(r.now.lon)}`, 'MEASURED')}
      ${pr('Elevation', `${r.now.elev_m.toFixed(0)} m`)}
      ${pr('Last drive ended', `sol ${r.now.sol} · about ${date(r, r.now.sol)}`)}
      ${pr('Today is', `sol ${today}${today > r.now.sol ? ` · parked ${today - r.now.sol} sols` : ''}`, 'DERIVED')}
      ${pr('Driven since landing', `${(r.now.dist_total_m / 1000).toFixed(2)} km`)}
      <div class="note">${r.live ? `Read from NASA's position feed at ${S.roversAt.toISOString().slice(11, 16)} UTC.` : `NASA's feed was not reached. Showing the snapshot from ${esc(S.roversSnapshot)}.`} <a href="${r.map}" target="_blank" rel="noopener">NASA location map</a></div>
      <div class="pad"><button class="btn pl" data-act="rover" data-id="${r.id}">Show on map</button></div></div>`;
  };
  const [a, b] = S.rovers;
  const rad = Math.PI / 180;
  const h = Math.sin(((b.now.lat - a.now.lat) * rad) / 2) ** 2 + Math.cos(a.now.lat * rad) * Math.cos(b.now.lat * rad) * Math.sin(((b.now.lon - a.now.lon) * rad) / 2) ** 2;
  const km = (2 * S.site.meta.mars_radius_m * Math.asin(Math.sqrt(h))) / 1000;
  return `<div class="cols">${card(a)}${card(b)}<div><div class="sub">Between them</div>${pr('Across Mars', `${Math.round(km).toLocaleString('en-GB')} km`, 'DERIVED')}
    <div class="note">A position is where the rover stopped after its last drive, not a live fix. Planning is on Curiosity's ground at Gale; Perseverance is shown for context.</div>
    <div class="pad"><button class="btn pl" data-act="rover" data-id="both">Show both</button><button class="btn pl" data-act="rover" data-id="walk">Back to the walk</button></div></div></div>`;
}

function sourcesHTML() {
  const suit = Object.entries(SIM.SUIT).map(([key, c]) => `<tr><td class="t">${esc(c.title || key)}</td><td>${typeof c.value === 'number' ? Number(c.value.toPrecision(4)) : esc(c.value)}</td><td class="l">${esc(c.units || '')}</td><td class="l">${esc(c.tag)}</td><td class="t">${c.url ? `<a href="${c.url}" target="_blank" rel="noopener">${esc(c.source)}</a>` : esc(c.source || '')}</td></tr>`).join('');
  const data = (S.dataSources || []).map(([what, tag, src, url]) => `<tr><td class="t">${esc(what)}</td><td class="l">${tag}</td><td class="t">${url ? `<a href="${url}" target="_blank" rel="noopener">${esc(src)}</a>` : esc(src)}</td></tr>`).join('');
  return `<table><tr><th class="l">Model constant</th><th>Value</th><th class="l">Units</th><th class="l">Basis</th><th class="l">Source</th></tr>${suit}</table>
    <table><tr><th class="l">Data on the map</th><th class="l">Basis</th><th class="l">Source</th></tr>${data}</table>
    <div class="note">${(S.sim.assumptions || []).map(esc).join(' ')}</div>
    <div class="note">What this tool cannot see: rocks and sand at footstep scale away from the rover's track, live weather, and how fast a suited person really walks on Mars. MEASURED: read by an instrument. NASA VALUE: a published NASA design or planning number. DERIVED: computed here from measured data. ASSUMED: our choice, stated. Data snapshot ${esc(S.site.meta.snapshot_utc)}. Not affiliated with or endorsed by NASA.</div>`;
}

function renderTabs() {
  $('#tabs').innerHTML = TABS.map(([id, label]) => `<button role="tab" data-act="tab" data-id="${id}" aria-selected="${S.tab === id}">${label}${id === 'layers' ? ` (${MV.LAYERS.filter((l) => l.avail()).length})` : ''}</button>`).join('');
}

function renderTab() {
  const body = $('#tabbody');
  const W = Math.max(520, body.clientWidth - 2);
  body.innerHTML = { sequence: sequenceHTML, timeline: () => timelineHTML(W), profile: () => profileHTML(W), layers: layersHTML, rovers: roversHTML, sources: sourcesHTML }[S.tab]();
}

function renderConsole() {
  const el = $('#conbody');
  const line = (at, level, text) => `<p><span>[${at.toISOString().slice(11, 19)}]</span>${level === 'status' ? '<i>Status</i>' : `<b class="f f${level}">${level}</b>`}<span style="color:inherit;flex:1">${esc(text)}</span></p>`;
  const now = new Date();
  const current = S.sim ? S.sim.rules.filter((r) => r.level !== 'pass').map((r) => line(now, LETTER[r.level], `${r.id} ${r.text}`)).join('') : '';
  el.innerHTML = `${S.log.map((l) => line(l.at, l.level, l.text)).join('')}<p class="div">Current plan: ${S.sim ? S.sim.rules.filter((r) => r.level !== 'pass').length : 0} open flags</p>${current}`;
  el.scrollTop = el.scrollHeight;
}

function renderStatus() {
  const bits = [
    S.grid ? `Elevation: HiRISE 1 m model on a ${S.grid.w} × ${S.grid.h} grid, ${S.gridMeta.cell_m.toFixed(1)} m cells` : 'Elevation grid: loading',
    'Latitude planetocentric, longitude east; grid heights as served by NASA Mars Trek (datum not stated)',
    `Data snapshot ${S.site.meta.snapshot_utc}`,
  ];
  $('#status-text').textContent = bits.join(' · ');
}

function renderPreset() {
  $('#preset').innerHTML = `<span class="k">Layer preset</span>${MV.PRESETS.map((p) => {
    const ready = !p.needs || (p.needs === 'grid' ? !!S.grid : !!S.home);
    return `<button data-act="preset" data-id="${p.id}" class="${S.preset === p.id && !S.custom ? 'on' : ''}" ${ready ? '' : 'disabled title="Needs the terrain engine"'} style="${ready ? '' : `color:${C.off}`}">${p.title}</button>`;
  }).join('')}<span class="state">${S.custom ? 'Custom · ' : ''}Fill: ${S.fill === 'none' ? 'none' : esc(MV.LAYERS.find((l) => l.id === S.fill)?.title || '')}</span>`;
  $('#legend-body').innerHTML = MV.legendHTML();
}

// ---------- cuff card ----------

function renderCuff() {
  const sim = S.sim;
  const ref = P.refugePt();
  const path = S.legs.flatMap((l) => l.line.map(([lat, lon]) => localM(ref, { lat, lon })));
  const marks = [{ x: 0, y: 0, label: 'R', sq: true }, ...S.plan.stations.map((st, i) => ({ ...localM(ref, P.pointOf(st.at)), label: i + 1 }))];
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
  const placed = [];
  const shapes = marks.map((m) => {
    let [cx, cy] = px(m);
    for (const p of placed) {
      const d = Math.hypot(cx - p[0], cy - p[1]);
      if (d < 24) { const a = d > 0.5 ? Math.atan2(cy - p[1], cx - p[0]) : 0; cx = p[0] + 24 * Math.cos(a); cy = p[1] + 24 * Math.sin(a); }
    }
    placed.push([cx, cy]);
    const shape = m.sq ? `<rect x="${cx - 11}" y="${cy - 11}" width="22" height="22" fill="#fff" stroke="#000" stroke-width="2.5"/>` : `<circle cx="${cx}" cy="${cy}" r="11" fill="#fff" stroke="#000" stroke-width="2.5"/>`;
    return `${shape}<text x="${cx}" y="${cy + 5}" text-anchor="middle" font-size="14" font-weight="700" font-family="monospace">${m.label}</text>`;
  }).join('');
  const sketch = `<svg viewBox="0 0 ${size} ${size}">
    ${S.legs.map((l) => `<polyline points="${l.line.map(([lat, lon]) => px(localM(ref, { lat, lon })).map((n) => n.toFixed(1)).join(',')).join(' ')}" fill="none" stroke="#000" stroke-width="3" ${l.proven ? '' : 'stroke-dasharray="7 5"'}/>`).join('')}
    ${shapes}
    <path d="M22 44 L22 14 M15 23 L22 12 L29 23" fill="none" stroke="#000" stroke-width="2.5"/>
    <text x="22" y="58" text-anchor="middle" font-size="12" font-weight="700" font-family="monospace">N</text>
    <line x1="${size - 16 - barM * k}" y1="${size - 14}" x2="${size - 16}" y2="${size - 14}" stroke="#000" stroke-width="4"/>
    <text x="${size - 16}" y="${size - 22}" text-anchor="end" font-size="12" font-family="monospace">${barM} m</text></svg>`;
  const rows = S.legs.filter((l) => l.station !== null).map((leg) => {
    const walk = sim.steps.find((s) => s.type === 'walk' && s.id === leg.id);
    const work = sim.steps.find((s) => s.type === 'work' && s.id === leg.to);
    return `<tr><td class="n">${leg.station + 1}</td>
      <td><b>${esc(leg.toName)}</b><div class="legline">bearing ${String(Math.round(leg.headingDeg)).padStart(3, '0')}° · ${fmtM(leg.lengthM)} · climb ${Math.round(walk.climbM)} m · ${fmtMin(walk.t1S - walk.t0S)}${leg.proven ? '' : ' · UNPROVEN GROUND'} · work ${S.plan.stations[leg.station].dwellMin} min · home in ${fmtMin(work.homeEndS)}</div></td>
      <td class="by">${work.lmst1}</td></tr>`;
  }).join('');
  const v = sim.verdict;
  const ret = S.legs[S.legs.length - 1];
  const open = sim.rules.filter((r) => r.level !== 'pass');
  $('#cuff').innerHTML = `
    <h1>TENACITY · EVA CUFF CARD</h1>
    <p class="csub">${esc(S.plan.name)}, Gale Crater · leave ${esc(S.params.egress)} LMST · sunset ${clockH(parseClock(S.params.sunset) ?? S.sun.sunsetLmstH)}</p>
    ${sketch}
    <table><tr><th></th><th>Station</th><th style="text-align:right">Leave by</th></tr>${rows}
      <tr><td class="n">R</td><td><b>Home: ${esc(ref.name)}</b><div class="legline">${fmtM(ret.lengthM)} from the last station · back ${esc(sim.totals.backLmst)} LMST</div></td><td class="by"></td></tr></table>
    <div class="big">${v.go ? 'PLAN IS GO · MARGIN' : 'PLAN IS NO-GO'}<b>${v.go ? signedMin(v.marginMin) : esc(v.limiting)}</b>Tightest rule: ${esc(v.limiting)} ${esc(ruleOf(v.limiting)?.title || '')}.</div>
    <p class="crule"><b>Rules.</b> Stay within ${S.params.emergencyReturnMin} min of the refuge at emergency pace. Keep oxygen for the walk home plus ${S.params.reserveMin} min. Be home ${S.params.reserveMin} min before sunset.</p>
    ${open.length ? `<p class="crule"><b>Open flags.</b> ${open.map((r) => `[${LETTER[r.level]}] ${esc(r.id)} ${esc(r.text)}`).join(' ')}</p>` : ''}
    <p class="fine">Assumed ${S.params.speedKmh} km/h on level ground, ${S.params.o2StartKg} kg oxygen at egress. Bearings are straight lines between stations. Route and imagery: NASA/JPL-Caltech. Data snapshot ${esc(S.site.meta.snapshot_utc)}.</p>`;
}

// ---------- render ----------

// What changes while the playhead moves.
function renderLive() {
  renderPlayhead();
  playheadMoved();
  MV.drawPlan();
  if (S.tab === 'sequence' || S.tab === 'timeline' || S.tab === 'profile') renderTab();
  const cur = P.stepAt(S.sim, S.tS);
  document.querySelectorAll('#activity .row.cur').forEach((r) => r.classList.remove('cur'));
  if (S.tS > 0 && cur) {
    const sel = cur.type === 'work' ? `[data-type="station"][data-i="${Number(cur.id.slice(4)) - 1}"]` : cur.id === 'RETURN' ? '[data-type="return"]' : `[data-type="leg"][data-i="${Number(cur.id.slice(4)) - 1}"]`;
    const row = document.querySelector(`#activity .row${sel}`);
    if (row) row.classList.add('cur');
  }
}

// Everything, after the plan or its inputs changed.
function render() {
  recompute();
  renderTitle();
  renderActivity();
  renderSim();
  renderRules();
  renderProbe();
  renderTicks();
  renderPlayhead();
  renderTabs();
  renderTab();
  renderConsole();
  renderStatus();
  MV.drawPlan();
  renderPreset();
}

// ---------- actions ----------

function select(sel) {
  S.sel = sel;
  if (sel && sel.type === 'station') {
    const st = S.plan.stations[sel.i];
    const p = P.pointOf(st.at);
    S.probe = { lat: p.lat, lon: p.lon, stop: st.at.stop };
    MV.panTo(p);
  }
  renderActivity();
  renderProbe();
  MV.drawPlan();
}

function pick(pt) {
  if (S.mode === 'sketch' && !pt.stop) {
    S.plan.stations.push({ at: { lat: pt.lat, lon: pt.lon, name: `Point ${S.plan.stations.length + 1}` }, dwellMin: 20, effort: 'moderate', leg: S.grid ? 'auto' : 'direct' });
    if (S.plan.ret === 'track') S.plan.ret = S.grid ? 'auto' : 'direct';
    S.sel = { type: 'station', i: S.plan.stations.length - 1 };
    S.probe = { lat: pt.lat, lon: pt.lon };
    log('status', `Station ${P.stationId(S.plan.stations.length - 1)} added at ${fmtLat(pt.lat)}, ${fmtLon(pt.lon)}`);
    save();
    return render();
  }
  if (pt.stop) { const s = S.byId.get(pt.stop); if (s.photoState === 'offline') s.photoState = null; }
  S.probe = pt;
  S.sel = null;
  renderActivity();
  renderProbe();
  MV.drawPlan();
}

function act(action, el) {
  const d = el.dataset;
  const i = d.i === undefined ? undefined : Number(d.i);
  // Looking never changes the plan.
  if (action === 'sel') return select(isSel(d.type, i) ? null : { type: d.type, i });
  if (action === 'tab') { S.tab = d.id; renderTabs(); return renderTab(); }
  if (action === 'preset') { MV.applyPreset(d.id); renderPreset(); return S.tab === 'layers' && renderTab(); }
  if (action === 'mode') { S.mode = d.id; log('status', `Mode: ${d.id}`); MV.map.getContainer().style.cursor = d.id === 'sketch' ? 'crosshair' : ''; return render(); }
  if (action === 'cuff') { renderCuff(); $('#cuff-sheet').hidden = false; return; }
  if (action === 'seek') { S.tS = Number(d.t); setPlaying(false); return renderLive(); }
  if (action === 'play') return setPlaying(!S.playing);
  if (action === 'stop') { S.tS = 0; setPlaying(false); return renderLive(); }
  if (action === 'rate') { S.rate = { 60: 600, 600: 10, 10: 60 }[S.rate]; return renderPlayhead(); }
  if (action === 'step') {
    const marks = [0, ...S.sim.steps.map((s) => s.t1S)];
    S.tS = Number(d.delta) > 0 ? (marks.find((t) => t > S.tS + 0.5) ?? S.sim.totals.durS) : ([...marks].reverse().find((t) => t < S.tS - 0.5) ?? 0);
    setPlaying(false);
    return renderLive();
  }
  if (action === 'rule') {
    const r = ruleOf(d.id);
    if (r && r.stepIndex !== null && r.stepIndex !== undefined) {
      const step = S.sim.steps[r.stepIndex];
      S.tS = (r.segments && r.segments.length) ? (S.sim.samples.find((q) => q.stepIndex === r.segments[0].stepIndex && q.distM >= r.segments[0].fromDistM)?.tS ?? step.t0S) : step.t1S;
      setPlaying(false);
      const here = P.positionAt(S.sim, S.tS);
      if (here) MV.panTo(here);
      return renderLive();
    }
    return;
  }
  if (action === 'rover') {
    if (d.id === 'walk') return MV.fitPlan();
    if (d.id === 'both') return MV.map.fitBounds(S.rovers.map((r) => [r.now.lat, r.now.lon]), { padding: [80, 80], animate: false });
    const r = S.rovers.find((x) => x.id === d.id);
    return MV.map.setView([r.now.lat, r.now.lon], 16, { animate: false });
  }
  if (action === 'unprobe') { S.probe = null; renderProbe(); return MV.drawPlan(); }
  if (locked()) return;

  // From here on the plan changes.
  if (action === 'add' && S.probe) {
    const at = S.probe.stop ? { stop: S.probe.stop } : { lat: S.probe.lat, lon: S.probe.lon, name: `Point ${S.plan.stations.length + 1}` };
    S.plan.stations.push({ at, dwellMin: 30, effort: 'moderate', leg: S.probe.stop ? 'track' : S.grid ? 'auto' : 'direct' });
    S.sel = { type: 'station', i: S.plan.stations.length - 1 };
    log('status', `Station ${P.stationId(S.plan.stations.length - 1)} added`);
  }
  if (action === 'remove') { S.plan.stations.splice(i, 1); S.sel = null; log('status', `Station ${P.stationId(i)} removed`); }
  if (action === 'move') {
    const j = i + Number(d.delta);
    [S.plan.stations[i], S.plan.stations[j]] = [S.plan.stations[j], S.plan.stations[i]];
    S.sel = { type: 'station', i: j };
  }
  if (action === 'refuge' && S.probe) {
    S.plan.refuge = S.probe.stop ? { stop: S.probe.stop } : { lat: S.probe.lat, lon: S.probe.lon, name: 'Refuge' };
    S.plan.stations = S.plan.stations.filter((st) => !(S.probe.stop && st.at.stop === S.probe.stop));
    log('status', 'Refuge moved');
    emitRefugeMoved();
  }
  if (action === 'dwell') S.plan.stations[i].dwellMin = clamp(S.plan.stations[i].dwellMin + Number(d.delta), 0, 600);
  if (action === 'koz' && S.probe) {
    (S.plan.koz ||= []).push({ lat: S.probe.lat, lon: S.probe.lon, r: 30 });
    log('status', `Keep-out zone KOZ_${String(S.plan.koz.length).padStart(2, '0')} added, radius 30 m`);
    emitRefugeMoved();
  }
  if (action === 'unkoz') { S.plan.koz.splice(i, 1); log('status', 'Keep-out zone removed'); emitRefugeMoved(); }
  if (action === 'reset') { loadTrip(S.trip, true); log('status', 'Plan and INCONS reset'); emitRefugeMoved(); }
  save();
  render();
}

// The cost field and line-of-sight map depend on where the refuge is.
let refugeMoved = () => {};
const emitRefugeMoved = () => refugeMoved();

function wire() {
  document.body.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (b && !b.disabled) act(b.dataset.act, b);
  });
  document.body.addEventListener('change', (e) => {
    const el = e.target;
    if (el.id === 'trip') { loadTrip(el.value); save(); emitRefugeMoved(); render(); return MV.fitPlan(); }
    if (el.dataset.layer !== undefined) {
      if (el.dataset.layer === 'none') MV.toggleLayer(S.fill, false); else MV.toggleLayer(el.dataset.layer, el.checked);
      renderPreset();
      return renderTab();
    }
    if (locked()) return;
    if (el.dataset.param) {
      const key = el.dataset.param;
      const kind = PARAMS.find((p) => p[0] === key)[3];
      if (kind === 'clock') { if (parseClock(el.value) !== null || (key === 'sunset' && el.value === '')) S.params[key] = el.value; }
      else if (Number(el.value) > 0 || key === 'reserveMin') S.params[key] = Math.max(0, Number(el.value) || 0);
      if (key === 'slopeLimitDeg') MV.invalidate('nogo', 'slope');
      if (key === 'speedKmh' || key === 'slopeLimitDeg') emitRefugeMoved();
      if (key === 'emergencyReturnMin') { S.limitMask = null; MV.invalidate('limit', 'home'); }
    } else if (el.dataset.legmode !== undefined) {
      if (el.dataset.legmode === 'ret') S.plan.ret = el.value; else S.plan.stations[Number(el.dataset.legmode)].leg = el.value;
    } else if (el.dataset.effort !== undefined) {
      S.plan.stations[Number(el.dataset.effort)].effort = el.value;
    } else return;
    save();
    render();
  });

  // Timeline: click or drag to move the playhead.
  const seek = (e) => {
    const svg = e.target.closest('[data-seekbar]');
    if (!svg) return;
    const r = svg.getBoundingClientRect();
    const padL = Number(svg.dataset.padL);
    const padR = Number(svg.dataset.padR);
    S.tS = clamp((e.clientX - r.left - padL) / (r.width - padL - padR), 0, 1) * S.sim.totals.durS;
    setPlaying(false);
    renderLive();
  };
  let seeking = false;
  $('#tabbody').addEventListener('pointerdown', (e) => { if (e.target.closest('[data-seekbar]')) { seeking = true; seek(e); } });
  window.addEventListener('pointermove', (e) => { if (seeking) seek(e); });
  window.addEventListener('pointerup', () => { seeking = false; });

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, select, textarea')) return;
    if (e.key === ' ') { e.preventDefault(); setPlaying(!S.playing); }
    if (e.key === 'Escape') { $('#cuff-sheet').hidden = true; }
  });
  $('#cuff-print').addEventListener('click', () => window.print());
  $('#cuff-close').addEventListener('click', () => { $('#cuff-sheet').hidden = true; });
  let resize = 0;
  window.addEventListener('resize', () => { clearTimeout(resize); resize = setTimeout(renderTab, 120); });

  on('pick', pick);
  on('select', select);
  on('cursor', renderCursor);
  on('tab', (id) => { S.tab = id; renderTabs(); renderTab(); });
  on('log', renderConsole);
  on('layers', () => { renderPreset(); if (S.tab === 'layers') renderTab(); renderTabs(); });
  on('data', () => render());
}

// Ask NASA where each rover is right now. If a feed cannot be reached, the bundled snapshot stays.
async function refreshRovers() {
  await Promise.all(S.rovers.map(async (r) => {
    try {
      const feed = await fetch(r.feed, { cache: 'no-store', signal: AbortSignal.timeout(10000) }).then((x) => x.json());
      const p = feed.features[feed.features.length - 1].properties;
      r.now = { sol: p.sol, lat: p.lat, lon: p.lon, elev_m: p.elev_geoid, dist_total_m: p.dist_total_m };
      r.live = true;
    } catch { r.live = false; }
  }));
  S.roversAt = new Date();
  const live = S.rovers.filter((r) => r.live).map((r) => `${r.name} sol ${r.now.sol}`);
  log('status', live.length ? `Rover positions read from NASA: ${live.join(', ')}` : 'Rover position feeds not reached; showing the bundled snapshot');
  MV.refreshRovers();
  if (S.tab === 'rovers') renderTab();
}

async function main() {
  const [site, cfg, rovers, minerals, overlays, contours] = await Promise.all(
    ['data/site.json', 'data/targets.json', 'data/rovers.json', 'data/minerals.json', 'data/overlays/overlays.json', 'data/overlays/contours.json'].map((u) => fetch(u).then((r) => r.json())));
  Object.assign(S, { site, cfg, minerals, overlays, contours, rovers: rovers.rovers, roversSnapshot: rovers.snapshot_utc });
  site.stops.forEach((s) => S.byId.set(s.id, s));
  S.params = defaultParams();
  loadTrip(cfg.trips[0].id);
  loadSaved();
  S.sun = SUN.marsSun(Date.now(), P.refugePt().lat, P.refugePt().lon);
  MV.initMap();
  buildClock();
  wire();
  log('status', `Loaded ${site.stops.length.toLocaleString('en-GB')} rover stops and ${(site.route[site.route.length - 1][3] / 1000).toFixed(1)} km of track`);
  recompute();
  MV.fitPlan();
  MV.applyPreset('plan');
  render();
  renderCursor(null);
  renderClock();
  setInterval(renderClock, 1000);
  refreshRovers();
  // Terrain grid, baked science layers and the analyses that need them arrive after the first paint.
  window.tenacity = { S, map: () => MV.map };   // for inspection from the browser console
  refugeMoved = await initData({ render, renderProbe });
}

main();
