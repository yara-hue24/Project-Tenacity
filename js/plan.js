// The plan: a refuge, an ordered list of stations, and how each leg between them is walked.
// This file turns that plan into walkable paths and into the step list the simulation reads.
import * as M from './model.js';
import { S, distM, headingDeg, localM, emit } from './state.js';

const TRACK_STEP_M = 8;        // spacing of path points along the rover track when the elevation grid is loaded
const TRACK_STEP_COARSE_M = 20; // without the grid, rover elevations are too noisy for a shorter baseline
const LINE_STEP_M = 6;

// ---------- names ----------

export const target = (stop) => S.cfg.targets[stop.id];
export const samplesAt = (stop) => S.minerals.stops[stop.id] || [];
// A stop is named by its hand-written entry, else by the sample NASA analysed there, else by its sol.
export function stopName(stop) {
  if (target(stop)) return target(stop).name;
  const sm = samplesAt(stop);
  if (sm.length === 1) return sm[0].sample;
  if (sm.length) return sm[0].sample.replace(/ (scoop )?\d$/, '');
  return `Sol ${stop.sol} stop`;
}
export function stopKind(stop) {
  if (target(stop)) return target(stop).kind;
  const sm = samplesAt(stop);
  if (sm.length) return `${sm[0].kind === 'scoop' ? 'Sand scooped' : 'Rock drilled'} and analysed here · sol ${stop.sol}`;
  return `Curiosity stop · sol ${stop.sol}`;
}

// ---------- plan ----------

// A ready-made trip from data/targets.json becomes a plan that follows the rover track.
export function fromTrip(trip) {
  return {
    name: trip.name,
    refuge: { stop: trip.refuge },
    stations: trip.plan.map((s) => ({ at: { stop: s.id }, dwellMin: s.dwellMin, effort: 'moderate', leg: 'track' })),
    ret: 'track',
  };
}

export function valid(plan) {
  const ok = (at) => at && (at.stop ? S.byId.has(at.stop) : Number.isFinite(at.lat) && Number.isFinite(at.lon));
  return !!plan && ok(plan.refuge) && Array.isArray(plan.stations) && plan.stations.every((s) => ok(s.at));
}

const gridElev = (lat, lon) => {
  if (!S.grid || !S.T) return NaN;
  return S.T.elevAt(S.grid, lat, lon);
};

// Where a plan entry is: a rover stop (known position, on the track) or a free point on the map.
export function pointOf(at) {
  if (at.stop) {
    const s = S.byId.get(at.stop);
    return { lat: s.lat, lon: s.lon, elev: s.elev_m, chain: s.chain_m, stop: s, name: stopName(s) };
  }
  const e = gridElev(at.lat, at.lon);
  return { lat: at.lat, lon: at.lon, elev: Number.isFinite(e) ? e : null, chain: null, stop: null, name: at.name || 'Map point' };
}
export const refugePt = () => pointOf(S.plan.refuge);
export const stationId = (i) => `STN_${String(i + 1).padStart(2, '0')}`;
export const legId = (i) => `LEG_${String(i + 1).padStart(2, '0')}`;

// Elevation used for slope along a path. The orbital grid is used for every leg when it is loaded, so
// all legs share one height reference. Without it, the rover's own elevations are the fallback.
function withElev(pts) {
  let last = null;
  return pts.map((p) => {
    const g = gridElev(p.lat, p.lon);
    const elev = Number.isFinite(g) ? g : (p.elev ?? last ?? 0);
    last = elev;
    return { lat: p.lat, lon: p.lon, elev, distM: p.distM };
  });
}

function trackPath(a, b) {
  const step = S.grid ? TRACK_STEP_M : TRACK_STEP_COARSE_M;
  const dir = b.chain >= a.chain ? 1 : -1;
  const len = Math.abs(b.chain - a.chain);
  const pts = [];
  for (let d = 0; d < len; d += step) pts.push({ ...M.pointAtChain(S.site.route, a.chain + dir * d), distM: d });
  pts.push({ ...M.pointAtChain(S.site.route, b.chain), distM: len });
  const line = M.sliceRoute(S.site.route, a.chain, b.chain).map((q) => [q.lat, q.lon]);
  if (dir < 0) line.reverse();
  return { path: withElev(pts), line };
}

function directPath(a, b) {
  const len = distM(a, b);
  const n = Math.max(1, Math.ceil(len / LINE_STEP_M));
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const f = i / n;
    const ea = a.elev ?? b.elev ?? 0;
    const eb = b.elev ?? a.elev ?? 0;
    pts.push({ lat: a.lat + (b.lat - a.lat) * f, lon: a.lon + (b.lon - a.lon) * f, elev: ea + (eb - ea) * f, distM: len * f });
  }
  return { path: withElev(pts), line: [[a.lat, a.lon], [b.lat, b.lon]] };
}

// The easiest path over the terrain between two points, found by the terrain engine (see data.js).
// The first request starts the search and returns null; the plan is rebuilt when the answer arrives.
export const autoKey = (a, b) => `${a.lat.toFixed(6)},${a.lon.toFixed(6)}>${b.lat.toFixed(6)},${b.lon.toFixed(6)}|${S.params.speedKmh}|${S.params.slopeLimitDeg}|${JSON.stringify(S.plan.koz || [])}`;
function autoPath(a, b) {
  const key = autoKey(a, b);
  const hit = S.auto.get(key);
  if (hit && hit !== 'pending') return hit;
  if (!hit) { S.auto.set(key, 'pending'); emit('needpath', { key, a, b }); }
  return null;
}

// A leg mode the two ends can actually support. Following the track needs both ends on it;
// finding a path over the terrain needs the elevation grid.
export function legMode(a, b, wanted) {
  if (wanted === 'track' && a.chain !== null && b.chain !== null) return 'track';
  if (wanted === 'auto' && S.grid) return 'auto';
  return 'direct';
}

// Every leg of the walk in order, the last one being the return to the refuge.
export function buildLegs() {
  const ref = refugePt();
  const pts = S.plan.stations.map((s) => pointOf(s.at));
  const legs = [];
  let prev = ref;
  const add = (id, to, toName, b, wanted, station) => {
    const mode = legMode(prev, b, wanted);
    const found = mode === 'auto' ? autoPath(prev, b) : null;
    const noRoute = !!(found && found.failed);
    const { path, line } = mode === 'track' ? trackPath(prev, b) : found && !noRoute ? found : directPath(prev, b);
    legs.push({ id, to, toName, from: prev, dest: b, mode, proven: mode === 'track', path, line, station, noRoute, searching: mode === 'auto' && !found,
      lengthM: path[path.length - 1].distM, headingDeg: headingDeg(prev, b), goal: localM(ref, b) });
    prev = b;
  };
  pts.forEach((b, i) => add(legId(i), stationId(i), b.name, b, S.plan.stations[i].leg, i));
  add('RETURN', 'REFUGE', ref.name, ref, S.plan.ret, null);
  return legs;
}

// The step list the simulation reads: walk, work, walk, work, ..., walk home.
export function buildSimPlan(legs, egressLmstH) {
  const ref = refugePt();
  const steps = [];
  legs.forEach((leg) => {
    steps.push({ type: 'walk', id: leg.id, to: leg.to, name: leg.toName, proven: leg.proven, path: leg.path });
    if (leg.station !== null) {
      const st = S.plan.stations[leg.station];
      steps.push({ type: 'work', id: leg.to, name: leg.toName, durMin: st.dwellMin, effort: st.effort || 'moderate' });
    }
  });
  return { name: S.plan.name, egressLmstH, refuge: { lat: ref.lat, lon: ref.lon, elev: ref.elev ?? 0, name: ref.name }, steps };
}

// Where the crew is at a given time, read off the simulated samples.
export function positionAt(sim, tS) {
  const a = sim.samples;
  if (!a.length) return null;
  if (tS <= a[0].tS) return { ...a[0], index: 0 };
  let lo = 0;
  let hi = a.length - 1;
  if (tS >= a[hi].tS) return { ...a[hi], index: hi };
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (a[mid].tS <= tS) lo = mid; else hi = mid;
  }
  const p = a[lo];
  const q = a[hi];
  const f = q.tS > p.tS ? (tS - p.tS) / (q.tS - p.tS) : 0;
  const mix = (k) => p[k] + (q[k] - p[k]) * f;
  return { ...p, lat: mix('lat'), lon: mix('lon'), elev: mix('elev'), distM: mix('distM'), o2Kg: mix('o2Kg'), homeS: mix('homeS'), tS, index: lo };
}

export const stepAt = (sim, tS) => sim.steps.find((s) => tS < s.t1S) || sim.steps[sim.steps.length - 1];
