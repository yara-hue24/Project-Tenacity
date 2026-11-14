// Everything that arrives after the first paint: the elevation grid and the analyses made from it
// (slope, shadow, line of sight, walk-home time), the baked picture layers, the along-track science
// tables and the space-weather snapshot. Each becomes a map layer, a probe read-out, or a rule input.
import { S, C, RAMP, esc, emit, on, log, parseClock, distM, localM, MARS_HOUR_S, MARS_R } from './state.js';
import * as P from './plan.js';
import * as MV from './mapview.js';
import * as SIM from './sim.js';
import * as SUN from './sun.js';

const OBSERVER_M = 3;        // height of the refuge antenna above ground, for line of sight (assumed)
const TARGET_M = 1.8;        // helmet height (assumed)
const HOME_MAX_S = 3 * 3600; // the walk-home field is not computed further out than this
const DAN_NEAR_M = 25;
const TAG = (t) => `<span class="tag">${t}</span>`;
const pr = (k, v, tag = '') => `<div class="pr"><span class="k">${k}</span><span class="v">${v}${tag ? TAG(tag) : ''}</span></div>`;
const missing = (why) => `<b class="f fS">M</b> <span class="t">${why}</span>`;
const getJSON = (url) => fetch(url).then((r) => (r.ok ? r.json() : null)).catch(() => null);

// ---------- worker ----------

let worker = null;
let seq = 0;
const waiting = new Map();
function call(fn, ...args) {
  return new Promise((ok, fail) => {
    const id = ++seq;
    waiting.set(id, { ok, fail });
    worker.postMessage({ id, fn, args });
  });
}

// ---------- sun at the playhead ----------

// Where the Sun is at the plan time under the playhead, for today's season at the refuge.
export function sunAtPlayhead() {
  const egress = parseClock(S.params.egress) ?? 9;
  const lmst = egress + S.tS / MARS_HOUR_S;
  const ltst = lmst + S.sun.eotMin / 60;
  const ref = P.refugePt();
  return { ...SUN.sunAt(((ltst % 24) + 24) % 24, S.sun.declDeg, ref.lat), lmst };
}

// ---------- terrain ----------

const lerp = (a, b, f) => a + (b - a) * f;
function rampColour(f, alpha = 215) {
  const x = Math.max(0, Math.min(0.9999, f)) * (MV.RAMP_RGB.length - 1);
  const i = Math.floor(x);
  const a = MV.RAMP_RGB[i];
  const b = MV.RAMP_RGB[i + 1];
  return [lerp(a[0], b[0], x - i), lerp(a[1], b[1], x - i), lerp(a[2], b[2], x - i), alpha];
}
const classColour = (k) => [...MV.RAMP_RGB[k], 215];

function terrainLayers() {
  const g = S.grid;
  const b = g.bounds;
  const { min_m: lo, max_m: hi } = S.gridMeta;
  const has = (key) => () => !!S[key];
  const limMin = () => S.params.emergencyReturnMin ?? 60;

  MV.addLayer({ id: 'elev', title: 'Elevation', group: 'Terrain', kind: 'fill', cat: 'other', avail: () => true, tag: 'MEASURED',
    prov: `MRO HiRISE 1 m elevation model from NASA Mars Trek, on ${S.gridMeta.cell_m.toFixed(1)} m cells. Good for relative height; it sits a few metres to about 20 m off the rover's own elevations.`,
    ramp: () => [[RAMP[0], `${Math.round(lo)} m`], [RAMP[2], `${Math.round((lo + hi) / 2)} m`], [RAMP[4], `${Math.round(hi)} m`]],
    make: () => MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => rampColour((g.elev[i] - lo) / (hi - lo))), b) });

  MV.addLayer({ id: 'rough', title: 'Roughness', group: 'Terrain', kind: 'fill', cat: 'other', avail: () => true, tag: 'DERIVED',
    prov: 'Terrain ruggedness index (Riley): mean height difference between a cell and its eight neighbours. Rough ground at this scale means ledges and blocks, not pebbles.',
    ramp: () => [[RAMP[0], '0.3 to 0.6 m'], [RAMP[1], '0.6 to 1 m'], [RAMP[3], '1 to 2 m'], [RAMP[4], 'over 2 m']],
    make: () => MV.lazy(async () => {
      S.rough = S.rough || await call('roughness');
      return MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => { const v = S.rough[i]; return v > 2 ? classColour(4) : v > 1 ? classColour(3) : v > 0.6 ? classColour(1) : v > 0.3 ? classColour(0) : null; }), b);
    }) });

  MV.addLayer({ id: 'shade', title: 'Sunlit and shaded slopes at plan time', group: 'Light and comms', kind: 'fill', cat: 'standard', avail: () => true, tag: 'DERIVED', timed: true,
    prov: 'Hillshade for the Sun\'s position at the plan time under the playhead (today\'s season). Bright faces the Sun.',
    ramp: () => [['#111', 'facing away'], ['#888', ''], ['#fff', 'facing the Sun']],
    make: () => MV.lazy(async () => {
      const sun = sunAtPlayhead();
      const shade = await call('hillshade', sun.azDeg, Math.max(sun.elevDeg, 1));
      return MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => [shade[i], shade[i], shade[i], 225]), b, { opacity: 0.85 });
    }) });

  MV.addLayer({ id: 'shadow', title: 'Cast shadow at plan time', group: 'Light and comms', kind: 'pattern', cat: 'standard', avail: () => true, tag: 'DERIVED', timed: true, minZoom: 11, swatch: 'dark',
    prov: 'Ground the terrain itself shades at the plan time under the playhead. Shadowed ground is colder and harder to read.',
    make: () => { let mask = null; const layer = MV.patternLayer(() => mask, b, 'dark');
      const sun = sunAtPlayhead();
      call('castShadow', sun.azDeg, sun.elevDeg).then((sh) => { mask = MV.maskCanvas(sh, g.w, g.h); if (MV.map.hasLayer(layer)) layer.redraw(); });
      return layer; } });

  MV.addLayer({ id: 'nolos', title: 'No line of sight to the refuge', group: 'Light and comms', kind: 'pattern', cat: 'standard', avail: has('vis'), tag: 'DERIVED', minZoom: 11, swatch: 'bars',
    prov: `Ground from which a ${TARGET_M} m high helmet cannot see a ${OBSERVER_M} m antenna at the refuge. Direct radio needs line of sight; both heights are assumptions.`,
    make: () => MV.patternLayer(() => (S.visMask = S.visMask || MV.gridCanvas(g.w, g.h, (i) => (S.vis[i] ? null : [255, 255, 255, 255]))), b, 'bars') });

  MV.addLayer({ id: 'home', title: 'Walk-home time to the refuge', group: 'Reach', kind: 'fill', cat: 'standard', avail: has('home'), tag: 'DERIVED',
    prov: 'Fastest walk back to the refuge from every cell at emergency pace, slower on slopes, never across ground steeper than the block slope. From the elevation grid; real ground will be slower.',
    ramp: () => { const m = limMin(); return [[RAMP[0], `under ${m / 4} min`], [RAMP[1], `${m / 4} to ${m / 2}`], [RAMP[2], `${m / 2} to ${(3 * m) / 4}`], [RAMP[4], `${(3 * m) / 4} to ${m} min`]]; },
    make: () => { const q = (limMin() * 60) / 4; const t = S.home.time;
      return MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => (t[i] <= 4 * q ? classColour(t[i] <= q ? 0 : t[i] <= 2 * q ? 1 : t[i] <= 3 * q ? 2 : 4) : null)), b); } });

  MV.addLayer({ id: 'limit', title: 'Suit-failure return limit', group: 'Reach', kind: 'pattern', cat: 'standard', avail: has('home'), tag: 'DERIVED', minZoom: 10, swatch: 'limit',
    prov: 'The edge of the ground from which the refuge can be reached on foot within the emergency return time (FR-01), walking around ground steeper than the block slope. Inside the line you can get home on the backup supply.',
    make: () => MV.patternLayer(() => (S.limitMask = S.limitMask || MV.maskCanvas(boundary(S.home.time, limMin() * 60, g.w, g.h), g.w, g.h)), b, 'limit') });
}

// The edge of the region where value <= limit, two to three cells wide so it survives zooming out.
function boundary(value, limit, w, h) {
  const edge = new Uint8Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (value[i] <= limit && (value[i - 1] > limit || value[i + 1] > limit || value[i - w] > limit || value[i + w] > limit)) edge[i] = 1;
    }
  }
  const out = new Uint8Array(w * h);
  for (let i = w; i < w * h - w; i++) if (edge[i] || edge[i - 1] || edge[i + 1] || edge[i - w] || edge[i + w]) out[i] = 1;
  return out;
}

// Keep-out zones as a blocked-cell mask for route finding. Null when there are none.
function kozMask() {
  const zones = S.plan.koz || [];
  if (!zones.length || !S.grid) return null;
  const g = S.grid;
  const mask = new Uint8Array(g.w * g.h);
  for (const z of zones) {
    const c = S.T.cellOf(g, z.lat, z.lon);
    const rx = Math.ceil(z.r / g.dx);
    const ry = Math.ceil(z.r / g.dy);
    for (let r = Math.max(0, c.row - ry); r <= Math.min(g.h - 1, c.row + ry); r++) {
      for (let col = Math.max(0, c.col - rx); col <= Math.min(g.w - 1, c.col + rx); col++) {
        if (Math.hypot((col - c.col) * g.dx, (r - c.row) * g.dy) <= z.r) mask[r * g.w + col] = 1;
      }
    }
  }
  return mask;
}

// The fastest walk between two points over the terrain, never across ground steeper than the slope
// limit and never through a keep-out zone. Paths turn in 45 degree steps, so they read up to 8 % long.
function findPaths(render) {
  on('needpath', async ({ key, a, b }) => {
    const params = { blockSlopeDeg: S.params.slopeLimitDeg ?? 20 };
    if (Number.isFinite(S.params.speedKmh)) params.speedKmh = S.params.speedKmh;
    const direct = distM(a, b);
    const opts = { speedBySlope: SIM.speedTable(params, false), toward: false, maxTimeS: Math.max(2400, direct / 0.12) };
    const blocked = kozMask();
    if (blocked) opts.blocked = blocked;
    try {
      const res = await call('costDistance', [{ lat: a.lat, lon: a.lon }], opts);
      const cells = S.T.pathFrom(S.grid, res.prev, b.lat, b.lon).reverse();
      if (cells.length < 2) {
        S.auto.set(key, { failed: true });
        log('C', `No path under the ${params.blockSlopeDeg}° slope limit was found for a leg of ${Math.round(direct)} m; the straight line is shown instead`);
      } else {
        const pts = [{ lat: a.lat, lon: a.lon }, ...cells.slice(1, -1), { lat: b.lat, lon: b.lon }];
        let d = 0;
        const path = pts.map((p, i) => {
          if (i) d += distM(pts[i - 1], p);
          return { lat: p.lat, lon: p.lon, elev: S.T.elevAt(S.grid, p.lat, p.lon), distM: d };
        });
        S.auto.set(key, { path, line: path.map((p) => [p.lat, p.lon]) });
        log('status', `Path found over terrain: ${Math.round(d)} m against ${Math.round(direct)} m in a straight line`);
      }
    } catch (err) {
      S.auto.set(key, { failed: true });
      log('C', `Path search failed: ${err.message}`);
    }
    render();
  });
}

// The walk-home field and the line-of-sight map both depend on where the refuge is.
let homeRun = 0;
async function refugeAnalyses(render) {
  if (!S.grid) return;
  const run = ++homeRun;
  const ref = P.refugePt();
  const params = {};
  for (const k of ['speedKmh', 'slopeLimitDeg']) if (Number.isFinite(S.params[k])) params[k] = S.params[k];
  const t0 = performance.now();
  const homeOpts = { speedBySlope: SIM.speedTable(params, true), toward: true, maxTimeS: HOME_MAX_S };
  const blocked = kozMask();
  if (blocked) homeOpts.blocked = blocked;
  const [home, vis] = await Promise.all([
    call('costDistance', [{ lat: ref.lat, lon: ref.lon }], homeOpts),
    call('viewshed', ref.lat, ref.lon, OBSERVER_M, TARGET_M),
  ]);
  if (run !== homeRun) return;           // the refuge moved again while this was running
  S.home = home;
  S.vis = vis;
  S.visMask = S.limitMask = null;
  log('status', `Terrain engine: walk-home field and line of sight from ${ref.name} ready in ${Math.round(performance.now() - t0)} ms`);
  MV.invalidate('home', 'limit', 'nolos');
  render();
}

async function initTerrain(render) {
  try {
    S.T = await import('./terrain.js');
    worker = new Worker(new URL('./terrain.worker.js', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const w = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (w) (e.data.ok ? w.ok(e.data.result) : w.fail(new Error(e.data.error)));
    };
    const metaUrl = new URL('../data/terrain/dem.json', import.meta.url).href;
    const t0 = performance.now();
    const [meta, grid] = await Promise.all([getJSON(metaUrl), call('load', metaUrl)]);
    S.gridMeta = meta;
    S.grid = grid;
    log('status', `Elevation grid loaded: ${grid.w} × ${grid.h} cells of ${meta.cell_m.toFixed(1)} m in ${Math.round(performance.now() - t0)} ms`);
    const sa = await call('slopeAspect');
    S.slope = sa.slope;
    S.aspect = sa.aspect;
    terrainLayers();
    findPaths(render);
    MV.invalidate('nogo', 'slope');
    render();
    await refugeAnalyses(render);
  } catch (err) {
    log('C', `Terrain engine not available: ${err.message}. Slope comes from the shipped picture; walk-home time follows the path walked.`);
  }
}

// Time-dependent layers follow the playhead, a moment after it stops moving.
let sunTimer = 0;
let sunShown = null;
export function playheadMoved() {
  if (!S.grid) return;
  const timed = MV.LAYERS.filter((l) => l.timed && (l.kind === 'fill' ? S.fill === l.id : S.on.has(l.id)));
  if (!timed.length) return;
  clearTimeout(sunTimer);
  sunTimer = setTimeout(() => {
    const key = Math.round(S.tS / 300);
    if (key === sunShown) return;
    sunShown = key;
    MV.invalidate(...timed.map((l) => l.id));
  }, 260);
}

// ---------- picture layers ----------

const loadImage = (url) => new Promise((ok, fail) => { const im = new Image(); im.onload = () => ok(im); im.onerror = fail; im.src = url; });

async function initRasters() {
  const list = await getJSON('data/layers/rasters.json');
  if (!list) return;
  S.rasters = list;
  // CRISM: three scenes per product, shown together as one layer.
  const crism = { crism_hyd: 'Hydrated minerals from orbit (CRISM)', crism_phy: 'Clays from orbit (CRISM)', crism_fm2: 'Iron minerals from orbit (CRISM)' };
  for (const [group, title] of Object.entries(crism)) {
    const scenes = list.filter((r) => r.group === group);
    if (!scenes.length) continue;
    const legend = scenes[0].legend || [];
    MV.addLayer({ id: group, title, group: 'Minerals from orbit', kind: 'fill', cat: 'other', avail: () => true, tag: 'MEASURED',
      prov: `MRO CRISM map-projected browse products, 18 m per pixel, scenes from ${scenes.map((s) => s.acquired.slice(0, 4)).sort().filter((y, i, a) => a.indexOf(y) === i).join(' and ')}. Colour shows which absorption bands are strong, a guide to minerals, not a measurement of amount.`,
      ramp: () => legend.map((l) => [`rgb(${l.rgb.join(',')})`, l.label]),
      make: () => L.layerGroup(scenes.map((s) => MV.fillLayer(s.file, s.bounds, { smooth: true, opacity: 0.8 }))) });
  }
  const night = list.find((r) => r.id === 'themis_day_night_ir');
  if (night) {
    MV.addLayer({ id: 'nightir', title: 'Night-time warmth (THEMIS)', group: 'Ground', kind: 'fill', cat: 'other', avail: () => true, tag: 'MEASURED',
      prov: 'Mars Odyssey THEMIS, 100 m. Brightness is daytime infrared (landforms); colour is night-time infrared: ground that stays warm at night is rock, ground that cools fast is sand or dust.',
      ramp: () => [['#2a3a8c', 'cold at night: loose'], ['#3ea05a', ''], ['#d8452e', 'warm at night: rocky']],
      make: () => MV.fillLayer(night.file, night.bounds, { smooth: true, opacity: 0.8 }) });
  }
  const ti = list.find((r) => r.id === 'thermal_inertia');
  if (ti) {
    const im = await loadImage(ti.file);
    const c = document.createElement('canvas');
    c.width = im.width;
    c.height = im.height;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(im, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    const value = (i) => ti.value_min + (px[i * 4] * (ti.value_max - ti.value_min)) / 255;
    const [[south, west], [north, east]] = ti.bounds;
    S.tiAt = (lat, lon) => {
      const col = Math.floor(((lon - west) / (east - west)) * c.width);
      const row = Math.floor(((north - lat) / (north - south)) * c.height);
      return col < 0 || row < 0 || col >= c.width || row >= c.height ? null : value(row * c.width + col);
    };
    MV.addLayer({ id: 'ti', title: 'Thermal inertia (THEMIS)', group: 'Ground', kind: 'fill', cat: 'other', avail: () => true, tag: 'MEASURED',
      prov: 'Mars Odyssey THEMIS quantitative thermal inertia, 100 m. Low values mean loose, fine material; high values mean rock or cemented ground.',
      ramp: () => [[RAMP[0], `${ti.value_min} TIU`], [RAMP[2], ''], [RAMP[4], `${ti.value_max} TIU`]],
      make: () => MV.fillLayer(MV.gridCanvas(c.width, c.height, (i) => rampColour((value(i) - ti.value_min) / (ti.value_max - ti.value_min))), ti.bounds, { smooth: true }) });
  }
}

// ---------- along-track science ----------

async function initScience() {
  const [dan, chemcam, apxs, sw] = await Promise.all(['dan', 'chemcam', 'apxs', 'spaceweather'].map((n) => getJSON(`data/layers/${n}.json`)));
  S.probeRows = [];

  if (dan) {
    const F = Object.fromEntries(dan.fields.map((f, i) => [f, i]));
    const pts = dan.points.map((p) => ({ lat: p[F.lat], lon: p[F.lon], water: p[F.water_wt_pct], waterErr: p[F.water_err], cl: p[F.cl_wt_pct], clErr: p[F.cl_err], member: dan.members[p[F.member_index]], chain: p[F.chain_m] }));
    S.science.dan = { pts, meta: dan };
    const endLat = pts[pts.length - 1].lat;
    MV.addLayer({ id: 'dan', title: 'Subsurface water (DAN neutron instrument)', group: 'Measured by Curiosity', kind: 'point', cat: 'standard', avail: () => true, tag: 'MEASURED', minZoom: 12.5, swatch: 'dots',
      prov: `Water-equivalent hydrogen in roughly the top metre of ground, ${pts.length.toLocaleString('en-GB')} points along the track up to sol 3333. Nikiforov et al. 2022, Zenodo, CC BY 4.0. No values south of ${endLat.toFixed(2)}°.`,
      ramp: () => [[RAMP[0], 'under 2 wt%'], [RAMP[1], '2 to 3'], [RAMP[2], '3 to 4'], [RAMP[3], '4 to 5'], [RAMP[4], 'over 5 wt%']],
      make: () => MV.trackPointsLayer(pts, (p) => p.water, [2, 3, 4, 5], (p) => emit('pick', { lat: p.lat, lon: p.lon })) });
    S.probeRows.push((pt) => {
      let best = null;
      let bd = DAN_NEAR_M;
      for (const p of pts) {
        if (Math.abs(p.lat - pt.lat) > 0.001) continue;
        const d = distM(pt, p);
        if (d < bd) { bd = d; best = p; }
      }
      const head = '<div class="sub">Under the surface · DAN</div>';
      if (!best) return head + pr('Water, top metre', missing(pt.lat < endLat ? 'no DAN data here: the table ends at sol 3333' : `no DAN point within ${DAN_NEAR_M} m`));
      return head + pr('Water, top metre', `${best.water.toFixed(1)} ± ${best.waterErr.toFixed(1)} wt%`, 'MEASURED')
        + (best.cl !== null ? pr('Chlorine', `${best.cl.toFixed(2)} ± ${best.clErr.toFixed(2)} wt%`, 'MEASURED') : '')
        + pr('Rock unit', `<span class="t">${esc(best.member)}</span>`);
    });
  }

  if (apxs) {
    S.science.apxs = apxs;
    const ids = Object.keys(apxs.stops).filter((id) => S.byId.has(id));
    MV.addLayer({ id: 'apxs', title: 'Chemistry spots (APXS)', group: 'Measured by Curiosity', kind: 'point', cat: 'standard', avail: () => true, tag: 'MEASURED', minZoom: 13, swatch: 'ring',
      prov: `Elemental chemistry measured by the APXS on Curiosity's arm at ${ids.length.toLocaleString('en-GB')} stops. NASA PDS Geosciences Node.`,
      make: () => L.layerGroup(ids.map((id) => { const s = S.byId.get(id);
        return L.circleMarker([s.lat, s.lon], { pane: 'science', radius: 5, color: '#000', weight: 3.5, fill: false, interactive: false }); })
        .concat(ids.map((id) => { const s = S.byId.get(id);
          return L.circleMarker([s.lat, s.lon], { pane: 'science', radius: 5, color: C.text, weight: 1.5, fillOpacity: 0 }).on('click', (e) => { L.DomEvent.stopPropagation(e); emit('pick', { stop: id, lat: s.lat, lon: s.lon }); }); }))) });
    const OX = ['SiO2', 'FeO', 'SO3', 'Cl', 'MgO', 'CaO', 'Al2O3'];
    S.probeRows.push((pt, s) => {
      const spots = s ? apxs.stops[s.id] : null;
      if (!spots || !spots.length) return '';
      const sp = spots[0];
      const vals = OX.filter((k) => typeof sp[k] === 'number').map((k) => `${k.replace(/(\d)/g, '<sub>$1</sub>')} ${sp[k].toFixed(k === 'Cl' ? 2 : 1)}`).join(' · ');
      return `<div class="sub">Chemistry · APXS${TAG('MEASURED')}</div>${pr(esc(sp.target || `Sol ${sp.sol}`), `${vals} wt%`)}${spots.length > 1 ? `<div class="note">${spots.length} spots measured here; the first is shown.</div>` : ''}`;
    });
  }

  if (chemcam) {
    S.science.chemcam = chemcam;
    S.probeRows.push((pt, s) => {
      const c = s ? chemcam.stops[s.id] : null;
      if (!c) return '';
      const names = c.targets.map(([name]) => esc(String(name).replace(/_/g, ' '))).join(', ');
      return `<div class="sub">Laser targets · ChemCam${TAG('MEASURED')}</div><div class="note">${c.n} rock and soil target${c.n === 1 ? '' : 's'} examined from here: ${names}${c.n > c.targets.length ? ', …' : ''}.</div>`;
    });
  }

  if (sw) {
    const now = Date.now();
    // An eruption that arrived within the last day is still passing; later ones count down in days.
    const DAY = 86400000;
    const events = (sw.mars_impacts || []).map((m) => ({ t: Date.parse(m.arrival_utc.replace('Z', ':00Z')), glancing: !!m.glancing_blow }))
      .filter((m) => Number.isFinite(m.t) && m.t >= now - DAY).sort((a, b) => a.t - b.t);
    const next = events[0];
    const soon = events.filter((m) => m.t <= (next ? next.t : 0) + DAY);
    const ageDays = Math.round((now - Date.parse(sw.fetched_utc)) / DAY);
    S.science.spaceweather = { raw: sw, env: {
      marsImpactWithinDays: next ? Math.max(0, Math.round(((next.t - now) / DAY) * 10) / 10) : null,
      glancing: soon.length > 0 && soon.every((m) => m.glancing),
      note: `NASA DONKI WSA-Enlil forecasts, snapshot ${sw.fetched_utc.slice(0, 10)}${ageDays > 3 ? `, ${ageDays} days old` : ''}: ${sw.count_mars} of ${sw.count_all} model runs in 60 days reached Mars.`,
    } };
  }
}

// What is drawn on the map and where it came from, for the Sources tab.
const DATA_SOURCES = [
  ['Rover track, stop positions, elevation, tilt', 'MEASURED', 'NASA/JPL-Caltech Curiosity location map feeds', 'https://science.nasa.gov/mission/msl-curiosity/location-map/'],
  ['Orbital imagery: HiRISE 25 cm, CTX 6 m', 'MEASURED', 'NASA/JPL-Caltech/Univ. of Arizona/MSSS', 'https://science.nasa.gov/mission/msl-curiosity/location-map/'],
  ['Elevation grid, slope, relief lines, shadow, line of sight, walk-home time', 'DERIVED', 'MRO HiRISE 1 m elevation model, NASA Mars Trek (Gale_DEM_SMG_1m)', 'https://trek.nasa.gov/mars/'],
  ['Thermal inertia, loose ground, night-time warmth', 'MEASURED', 'Mars Odyssey THEMIS, ASU JMARS', 'https://jmars.asu.edu/'],
  ['Hydrated minerals, clays, iron minerals from orbit', 'MEASURED', 'MRO CRISM MTRDR browse products, NASA PDS Geosciences Node', 'https://pds-geosciences.wustl.edu/missions/mro/crism.htm'],
  ['Subsurface water and chlorine', 'MEASURED', 'Curiosity DAN, Nikiforov et al. 2022, Zenodo (CC BY 4.0)', 'https://doi.org/10.5281/zenodo.6974535'],
  ['Minerals at drill and scoop sites', 'MEASURED', 'Curiosity CheMin, NASA PDS Geosciences Node', 'https://pds-geosciences.wustl.edu/missions/msl/chemin.htm'],
  ['Chemistry spots', 'MEASURED', 'Curiosity APXS, NASA PDS Geosciences Node', 'https://pds-geosciences.wustl.edu/missions/msl/apxs.htm'],
  ['Laser target names', 'MEASURED', 'Curiosity ChemCam observation list, NASA PDS Geosciences Node', 'https://pds-geosciences.wustl.edu/missions/msl/chemcam.htm'],
  ['Photos at rover stops', 'MEASURED', 'Curiosity Navcam raw images, NASA/JPL-Caltech', 'https://mars.nasa.gov/msl/multimedia/raw-images/'],
  ['Solar storm forecasts', 'NASA VALUE', 'NASA CCMC DONKI, WSA-Enlil model runs (forecasts, not measurements at Mars)', 'https://ccmc.gsfc.nasa.gov/tools/DONKI/'],
  ['Mars time, season, sunrise and sunset', 'DERIVED', 'Mars24 algorithm, Allison and McEwen 2000, NASA GISS', 'https://www.giss.nasa.gov/tools/mars24/help/algorithm.html'],
  ['Where the rovers are now', 'MEASURED', 'NASA/JPL-Caltech rover position feeds, read when the page loads', 'https://science.nasa.gov/mission/mars-2020-perseverance/location-map/'],
  ['Whole-planet basemap', 'MEASURED', 'OpenPlanetaryMap, from NASA/USGS data', 'https://www.openplanetary.org/opm'],
];

// Loads everything and returns the function to call when the refuge or the walking pace changes.
export async function initData({ render }) {
  S.dataSources = DATA_SOURCES;
  await Promise.all([initScience().then(render), initRasters().then(() => emit('layers'))]);
  log('status', `Science layers loaded: ${Object.keys(S.science).join(', ') || 'none'}; ${S.rasters.length} picture layers`);
  await initTerrain(render);
  return () => refugeAnalyses(render);
}
