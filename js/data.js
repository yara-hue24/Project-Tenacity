// Everything that arrives after the first paint: the elevation grid and the analyses made from it
// (slope, shadow, line of sight, walk-home time), the baked picture layers, the along-track science
// tables and the space-weather snapshot. Each becomes a map layer, a probe read-out, or a rule input.
import { S, C, RAMP, esc, emit, on, log, parseClock, distM, localM, MARS_HOUR_S, MARS_R } from './state.js';
import * as P from './plan.js';
import * as MV from './mapview.js';
import * as SIM from './sim.js';   // also: speed tables for the terrain engine
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
    prov: 'Fastest walk back to the refuge from every cell at emergency pace, slower on slopes, never across ground steeper than the slope limit and never through a keep-out zone. Computed out to 3 hours. From the elevation grid; real ground will be slower.',
    ramp: () => { const m = limMin(); return [[RAMP[0], `under ${m / 4} min`], [RAMP[1], `${m / 4} to ${m / 2}`], [RAMP[2], `${m / 2} to ${(3 * m) / 4}`], [RAMP[4], `${(3 * m) / 4} to ${m} min`]]; },
    make: () => { const q = (limMin() * 60) / 4; const t = S.home.time;
      return MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => (t[i] <= 4 * q ? classColour(t[i] <= q ? 0 : t[i] <= 2 * q ? 1 : t[i] <= 3 * q ? 2 : 4) : null)), b); } });

  // What the path finder weighs: ground it cannot cross (red) and ground that is slow (yellow).
  // Red and yellow are used here on purpose: this is hazard, not data.
  MV.addLayer({ id: 'pace', title: 'Walking difficulty (why routes go where they go)', group: 'Reach', kind: 'fill', cat: 'standard', avail: has('slope'), tag: 'DERIVED',
    prov: 'How the path finder sees the ground. Red: steeper than the slope limit or inside a keep-out zone, never crossed. Yellow: slopes where walking drops below half the level pace. Clear: easy ground.',
    ramp: () => [['rgba(255,214,10,0.45)', 'slow: 6° to 10°'], ['rgba(255,214,10,0.85)', `very slow: 10° to ${S.params.slopeLimitDeg ?? 20}°`], ['#e0362c', 'cannot cross']],
    make: () => { const lim = S.params.slopeLimitDeg ?? 20; const koz = kozMask();
      return MV.fillLayer(MV.gridCanvas(g.w, g.h, (i) => { const v = S.slope[i]; return (koz && koz[i]) || v > lim ? [224, 54, 44, 190] : v > 10 ? [255, 214, 10, 165] : v > 6 ? [255, 214, 10, 80] : null; }), b, { opacity: 0.8 }); } });

  MV.addLayer({ id: 'limit', title: 'Suit-failure return limit', group: 'Reach', kind: 'pattern', cat: 'standard', avail: has('home'), tag: 'DERIVED', minZoom: 10, swatch: 'limit',
    prov: 'The edge of the ground from which the refuge can be reached on foot within the emergency return time (FR-01), walking around ground steeper than the slope limit. Inside the line you can get home on the backup supply.',
    make: () => MV.patternLayer(() => {
      // A one-cell line close in, a thicker one from far away so it does not vanish.
      S.limitMask = S.limitMask || { thin: MV.maskCanvas(boundary(S.home.time, limMin() * 60, g.w, g.h, false), g.w, g.h), thick: MV.maskCanvas(boundary(S.home.time, limMin() * 60, g.w, g.h, true), g.w, g.h) };
      return MV.map.getZoom() >= 14.5 ? S.limitMask.thin : S.limitMask.thick;
    }, b, 'limit', true) });
}

// The edge of the region where value <= limit, two to three cells wide so it survives zooming out.
function boundary(value, limit, w, h, thick = true) {
  const edge = new Uint8Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    for (let c = 1; c < w - 1; c++) {
      const i = r * w + c;
      if (value[i] <= limit && (value[i - 1] > limit || value[i + 1] > limit || value[i - w] > limit || value[i + w] > limit)) edge[i] = 1;
    }
  }
  if (!thick) return edge;
  const out = new Uint8Array(w * h);
  for (let i = w; i < w * h - w; i++) if (edge[i] || edge[i - 1] || edge[i + 1] || edge[i - w] || edge[i + w]) out[i] = 1;
  return out;
}

// Keep-out zones as a blocked-cell mask for route finding. Null when there are none.
// A cell is blocked if any part of it can lie inside a zone: distance from the zone's true centre
// to the cell centre, less than the radius plus half a cell diagonal.
function kozMask() {
  const zones = S.plan.koz || [];
  if (!zones.length || !S.grid) return null;
  const g = S.grid;
  const mask = new Uint8Array(g.w * g.h);
  const pad = Math.hypot(g.dx, g.dy) / 2;
  for (const z of zones) {
    const c = S.T.cellOf(g, z.lat, z.lon);
    const rx = Math.ceil((z.r + pad) / g.dx) + 1;
    const ry = Math.ceil((z.r + pad) / g.dy) + 1;
    for (let r = Math.max(0, c.row - ry); r <= Math.min(g.h - 1, c.row + ry); r++) {
      for (let col = Math.max(0, c.col - rx); col <= Math.min(g.w - 1, c.col + rx); col++) {
        if (distM(z, S.T.latLonOf(g, col, r)) <= z.r + pad) mask[r * g.w + col] = 1;
      }
    }
  }
  return mask;
}

// Everything a route may not enter: keep-out zones, and ground whose own slope is over the suit
// limit whichever way it is walked (up, down or across).
function blockedMask() {
  if (!S.grid || !S.slope) return kozMask();
  const lim = S.params.slopeLimitDeg ?? 20;
  const koz = kozMask();
  const mask = new Uint8Array(S.slope.length);
  for (let i = 0; i < mask.length; i++) mask[i] = (koz && koz[i]) || S.slope[i] > lim ? 1 : 0;
  return mask;
}

// The fastest walk between two points over the terrain, never across ground steeper than the slope
// limit and never through a keep-out zone. Paths turn in 45 degree steps, so they read up to 8 % long.
function findPaths(render) {
  on('needpath', async ({ key, a, b }) => {
    const params = { blockSlopeDeg: S.params.slopeLimitDeg ?? 20 };
    if (Number.isFinite(S.params.speedKmh)) params.speedKmh = S.params.speedKmh;
    const direct = distM(a, b);
    const opts = { speedBySlope: SIM.speedTable(params, false), toward: false, maxTimeS: P.SEARCH_MAX_S };
    const blocked = blockedMask();
    if (blocked) opts.blocked = blocked;
    try {
      const res = await call('costDistance', [{ lat: a.lat, lon: a.lon }], opts);
      const cells = S.T.pathFrom(S.grid, res.prev, b.lat, b.lon).reverse();
      if (cells.length < 2) {
        S.auto.set(key, { failed: true });
        log('W', `No walkable path under the ${params.blockSlopeDeg}° slope limit was found within ${Math.round(P.SEARCH_MAX_S / 60)} min of walking for a leg of ${Math.round(direct)} m. The straight line shown is not a validated route.`);
      } else {
        const pts = [{ lat: a.lat, lon: a.lon }, ...cells.slice(1, -1), { lat: b.lat, lon: b.lon }];
        let d = 0;
        const path = pts.map((p, i) => {
          if (i) d += distM(pts[i - 1], p);
          return { lat: p.lat, lon: p.lon, elev: S.T.elevAt(S.grid, p.lat, p.lon), distM: d };
        });
        S.auto.set(key, { path, line: path.map((p) => [p.lat, p.lon]), explain: explain(a, b, path, res, params, blocked) });
        log('status', `Path found over terrain: ${Math.round(d)} m against ${Math.round(direct)} m in a straight line`);
      }
    } catch (err) {
      S.auto.set(key, { failed: true });
      log('C', `Path search failed: ${err.message}`);
    }
    render();
  });
}

// Numbers behind a found path: what the straight line would have crossed, and what each costs in time.
function explain(a, b, path, res, params, blocked) {
  const g = S.grid;
  const limitDeg = params.blockSlopeDeg;
  const line = S.T.sampleLine(g, a, b, Math.min(g.dx, g.dy));
  let over = 0;
  let koz = 0;
  let time = 0;
  const bad = [];        // stretches of the straight line that cannot be walked, for the map
  let run = null;
  for (let i = 1; i < line.length; i++) {
    const seg = line[i].distM - line[i - 1].distM;
    const c = S.T.cellOf(g, line[i].lat, line[i].lon);
    const idx = c.row * g.w + c.col;
    const steep = c.inside && S.slope[idx] > limitDeg;
    const inKoz = !!(blocked && c.inside && blocked[idx]);
    if (steep) over += seg;
    if (inKoz) koz += seg;
    if (steep || inKoz) { if (!run) { run = [[line[i - 1].lat, line[i - 1].lon]]; bad.push(run); } run.push([line[i].lat, line[i].lon]); } else run = null;
    const deg = (Math.atan2(line[i].elev - line[i - 1].elev, seg || 1) * 180) / Math.PI;
    const v = SIM.paceAndPower(deg, params).speedMs;
    time += v > 0 ? seg / v : Infinity;
  }
  const end = S.T.cellOf(g, b.lat, b.lon);
  let maxDeg = 0;
  for (let i = 1; i < path.length; i++) {
    const seg = path[i].distM - path[i - 1].distM;
    if (seg > 0) maxDeg = Math.max(maxDeg, Math.abs((Math.atan2(path[i].elev - path[i - 1].elev, seg) * 180) / Math.PI));
  }
  return { limitDeg, directM: line[line.length - 1].distM, directOverM: over, directKozM: koz, directTimeS: over || koz || !Number.isFinite(time) ? null : time,
    pathM: path[path.length - 1].distM, pathTimeS: res.time[end.row * g.w + end.col], pathMaxDeg: maxDeg, bad, straight: [[a.lat, a.lon], [b.lat, b.lon]] };
}

// The walk-home field and the line-of-sight map both depend on where the refuge is.
let homeRun = 0;
async function refugeAnalyses(render) {
  if (!S.grid) return;
  const run = ++homeRun;
  const ref = P.refugePt();
  const params = {};
  for (const k of ['speedKmh', 'emergencySpeedKmh', 'slopeLimitDeg']) if (Number.isFinite(S.params[k])) params[k] = S.params[k];
  const t0 = performance.now();
  const homeOpts = { speedBySlope: SIM.speedTable(params, true), toward: true, maxTimeS: HOME_MAX_S };
  const blocked = blockedMask();
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
    MV.addLayer({ id: group, title, group: 'Minerals from orbit', kind: 'fill', cat: 'other', avail: () => true, tag: 'DERIVED',
      prov: `MRO CRISM map-projected browse products, 18 m per pixel, moved 150 to 250 m by us to line up with the base map (30 to 60 m of error remains; seams between scenes are not geology), scenes from ${scenes.map((s) => s.acquired.slice(0, 4)).sort().filter((y, i, a) => a.indexOf(y) === i).join(' and ')}. Colour shows which absorption bands are strong, a guide to minerals, not a measurement of amount.`,
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
  const [dan, chemcam, apxs, sw, regions, geology] = await Promise.all(['dan', 'chemcam', 'apxs', 'spaceweather', 'regions', 'geology'].map((n) => getJSON(`data/layers/${n}.json`)));
  S.probeRows = [];
  const IB = (key) => `<button class="ib" data-info="${key}" aria-label="What is this?">i</button>`;

  // Named science regions along the rover's route up Mount Sharp, from NASA's own route map and mission papers.
  if (regions) {
    const PAL = ['#c9b458', '#8fb3d9', '#b48ad4', '#7fc8a9', '#d9a07a', '#b0b6bd', '#e08fb0', '#9ad0d6'];
    const list = regions.regions.filter((r) => r.chain_range_m).map((r, i) => ({ ...r, col: r.colour && r.colour !== 'none' ? r.colour : PAL[i % PAL.length], len: r.chain_range_m[1] - r.chain_range_m[0] }));
    S.science.regions = { raw: regions, list };
    // The most specific region at a distance along the track (short ones sit inside long ones).
    S.regionAt = (chain) => list.filter((r) => chain >= r.chain_range_m[0] && chain <= r.chain_range_m[1]).sort((a, b) => a.len - b.len)[0] || null;
    S.chainNear = (pt, maxM) => {
      let best = null;
      let bd = maxM;
      for (let i = 0; i < S.site.route.length; i += 3) {
        const r = S.site.route[i];
        if (Math.abs(r[1] - pt.lat) > 0.01) continue;
        const d = distM(pt, { lat: r[1], lon: r[0] });
        if (d < bd) { bd = d; best = r[3]; }
      }
      return best;
    };
    MV.GROUPS.includes('Science regions') || MV.GROUPS.splice(5, 0, 'Science regions');
    MV.addLayer({ id: 'regions', title: 'Science regions on the route up Mount Sharp', group: 'Science regions', kind: 'line', cat: 'standard', avail: () => true, tag: 'DERIVED',
      prov: 'The named regions Curiosity\'s team set out to explore, placed on the rover track from published sol ranges. Four colours are NASA\'s own from its route map; the rest are ours. Hover a stretch for its name; probe it for what there is to see.',
      ramp: () => list.map((r) => [r.col, r.name.replace(/ \(.*/, '')]),
      make: () => L.layerGroup([...list].sort((a, b) => b.len - a.len).map((r) => {
        const pts = S.site.route.filter((q) => q[3] >= r.chain_range_m[0] && q[3] <= r.chain_range_m[1]).map((q) => [q[1], q[0]]);
        return L.polyline(pts, { pane: 'lines', color: r.col, weight: 14, opacity: 0.9, lineCap: 'butt' }).bindTooltip(r.name, { sticky: true })
          .on('click', (e) => { L.DomEvent.stopPropagation(e); emit('pick', { lat: e.latlng.lat, lon: e.latlng.lng }); });
      })) });
    S.probeRows.push((pt, s) => {
      const chain = s ? s.chain_m : S.chainNear(pt, 150);
      const r = chain === null ? null : S.regionAt(chain);
      if (!r) return '';
      const src = (r.sources && r.sources[0]) || null;
      return `<div class="sub">Science region${IB('regions')}</div>${pr('Region', `<span class="t"><i style="display:inline-block;width:10px;height:10px;background:${r.col};margin-right:6px"></i>${esc(r.name)}</span>`)}
        <div class="note" style="color:var(--text)"><b>What you would see.</b> ${esc(r.what_to_see)}<br><b>Why it matters.</b> ${esc(r.why_it_matters)}
        <br><span class="dim">Extent on the track: ${esc(r.confidence)}.</span> ${src ? `<a href="${src.url}" target="_blank" rel="noopener">${esc(src.title)} ↗</a>` : ''}</div>`;
    });
  }

  // The USGS global geologic map: which great unit the area belongs to. Far too coarse to guide a walk.
  if (geology) {
    S.science.geology = geology;
    const inRing = (ring, lon, lat) => {
      let inside = false;
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
      }
      return inside;
    };
    const unitAt = (pt) => geology.units.find((u) => u.rings.reduce((n, ring) => n + (inRing(ring, pt.lon, pt.lat) ? 1 : 0), 0) % 2 === 1) || null;
    MV.GROUPS.includes('Science regions') || MV.GROUPS.splice(5, 0, 'Science regions');
    MV.addLayer({ id: 'geology', title: 'Geologic unit (USGS global map, 1:20,000,000)', group: 'Science regions', kind: 'line', cat: 'other', avail: () => true, tag: 'MEASURED',
      prov: 'USGS Geologic Map of Mars (Tanaka and others, 2014). It says which great unit the region belongs to and how old it is. A boundary on this map can be kilometres from where the rock really changes: not for planning a step.',
      ramp: () => geology.units.map((u) => [u.colour, `${u.code}: ${u.name}`]),
      make: () => L.layerGroup(geology.units.map((u) => L.polygon(u.rings.map((ring) => ring.map(([lon, lat]) => [lat, lon])), { pane: 'lines', color: '#fff', weight: 1.5, dashArray: '6 5', fillColor: u.colour, fillOpacity: 0.16, fillRule: 'evenodd', interactive: false }))) });
    S.probeRows.push((pt) => {
      const u = unitAt(pt);
      if (!u) return '';
      return `<div class="sub">Geologic unit · USGS global map${IB('geology')}</div>${pr('Unit', `<span class="t">${esc(u.code)} · ${esc(u.name)}</span>`, 'MEASURED')}${pr('Age', `<span class="t">${esc(u.age)}</span>`)}
        <div class="note">${esc(u.interpretation)} <span class="dim">Mapped at 1:20,000,000: a guide to the region, not to this spot.</span></div>`;
    });
  }

  if (dan) {
    const F = Object.fromEntries(dan.fields.map((f, i) => [f, i]));
    const pts = dan.points.map((p) => ({ lat: p[F.lat], lon: p[F.lon], water: p[F.water_wt_pct], waterErr: p[F.water_err], cl: p[F.cl_wt_pct], clErr: p[F.cl_err], member: dan.members[p[F.member_index]], chain: p[F.chain_m] }));
    S.science.dan = { pts, meta: dan };
    const endLat = pts[pts.length - 1].lat;
    MV.addLayer({ id: 'dan', title: 'Subsurface water (DAN neutron instrument)', group: 'Measured by Curiosity', kind: 'point', cat: 'standard', avail: () => true, tag: 'MEASURED', minZoom: 14, swatch: 'dots',
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
      const head = '<div class="sub">Under the surface · DAN<button class="ib" data-info="dan" aria-label="What is this?">i</button></div>';
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
      return `<div class="sub">Chemistry · APXS${TAG('MEASURED')}<button class="ib" data-info="apxs" aria-label="What is this?">i</button></div>${pr(esc(sp.target || `Sol ${sp.sol}`), `${vals} wt%`)}${spots.length > 1 ? `<div class="note">${spots.length} spots measured here; the first is shown.</div>` : ''}`;
    });
  }

  if (chemcam) {
    S.science.chemcam = chemcam;
    S.probeRows.push((pt, s) => {
      const c = s ? chemcam.stops[s.id] : null;
      if (!c) return '';
      const names = c.targets.map(([name]) => esc(String(name).replace(/_/g, ' '))).join(', ');
      return `<div class="sub">Laser targets · ChemCam${TAG('MEASURED')}<button class="ib" data-info="chemcam" aria-label="What is this?">i</button></div><div class="note">${c.n} rock and soil target${c.n === 1 ? '' : 's'} examined from here: ${names}${c.n > c.targets.length ? ', …' : ''}.</div>`;
    });
  }

  if (sw) {
    const now = Date.now();
    const snapshot = { fetched: Date.parse(sw.fetched_utc), live: false,
      events: (sw.mars_impacts || []).map((m) => ({ t: Date.parse(m.arrival_utc.replace('Z', ':00Z')), glancing: !!m.glancing_blow })) };
    S.science.spaceweather = { raw: sw, env: spaceWeatherEnv(snapshot) };
    liveSpaceWeather().then((live) => { if (live) { S.science.spaceweather.env = spaceWeatherEnv(live); log('status', `Space weather: live NASA DONKI forecasts read, ${live.events.length} model runs reaching Mars in the last 12 days`); emit('data'); } });
  }
}

// Forecast data older than this cannot say what is on its way to Mars: the rule becomes "not evaluated".
const FORECAST_MAX_AGE_H = 48;
const DAY = 86400000;
function spaceWeatherEnv({ fetched, events, live }) {
  const now = Date.now();
  // An eruption that arrived within the last day is still passing; later ones count down in days.
  const ahead = events.filter((m) => Number.isFinite(m.t) && m.t >= now - DAY).sort((a, b) => a.t - b.t);
  const next = ahead[0];
  const soon = ahead.filter((m) => m.t <= (next ? next.t : 0) + DAY);
  const ageH = (now - fetched) / 3600000;
  const stale = !(ageH <= FORECAST_MAX_AGE_H);
  const age = ageH < 2 ? 'read just now' : ageH < 48 ? `${Math.round(ageH)} h old` : `${Math.round(ageH / 24)} days old`;
  return {
    marsImpactWithinDays: next ? Math.max(0, Math.round(((next.t - now) / DAY) * 10) / 10) : null,
    glancing: soon.length > 0 && soon.every((m) => m.glancing),
    stale,
    note: `NASA DONKI WSA-Enlil model forecasts, ${live ? 'live feed' : 'stored snapshot'}, ${age}${stale ? `; older than ${FORECAST_MAX_AGE_H} h, so not usable` : ''}.`,
  };
}
// Ask NASA's DONKI service for the latest forecasts. The public demonstration key allows only a few
// requests an hour, so an answer is kept for three hours. Returns null if NASA cannot be reached.
async function liveSpaceWeather() {
  const KEY = 'tenacity.donki';
  try {
    const kept = JSON.parse(localStorage.getItem(KEY) || 'null');
    if (kept && Date.now() - kept.fetched < 3 * 3600000) return { ...kept, live: true };
  } catch { /* fetch again */ }
  try {
    const d = (offset) => new Date(Date.now() + offset * DAY).toISOString().slice(0, 10);
    const res = await fetch(`https://api.nasa.gov/DONKI/WSAEnlilSimulations?startDate=${d(-12)}&endDate=${d(1)}&api_key=DEMO_KEY`, { signal: AbortSignal.timeout(12000) });
    if (!res.ok) return null;
    const sims = await res.json();
    if (!Array.isArray(sims)) return null;
    const events = sims.flatMap((sim) => (sim.impactList || []).filter((i) => i.location === 'Mars').map((i) => ({ t: Date.parse(i.arrivalTime), glancing: !!i.isGlancingBlow }))).filter((m) => Number.isFinite(m.t));
    const out = { fetched: Date.now(), events };
    try { localStorage.setItem(KEY, JSON.stringify(out)); } catch { /* storage may be blocked */ }
    return { ...out, live: true };
  } catch { return null; }
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
  ['Whole-planet basemap', 'MEASURED', 'OpenPlanetaryMap, from NASA/USGS data', 'https://github.com/openplanetary/opm'],
];

// Loads everything and returns the function to call when the refuge or the walking pace changes.
export async function initData({ render, mark = () => {} }) {
  S.dataSources = DATA_SOURCES;
  await Promise.all([initScience().then(render), initRasters().then(() => emit('layers'))]);
  log('status', `Science layers loaded: ${Object.keys(S.science).join(', ') || 'none'}; ${S.rasters.length} picture layers`);
  mark('science', 'ok');
  mark('terrain', 'on');
  await initTerrain(render);
  mark('terrain', 'ok');
  return () => refugeAnalyses(render);
}
