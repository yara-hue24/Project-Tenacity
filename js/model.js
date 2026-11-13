// Walk model: pure functions, no DOM. Every constant says where it comes from.
// Time is in Earth hours since leaving the refuge. Distance along the route is "chain" in metres.

export const NASA = {
  o2WorkKgH: 0.086,     // EVA oxygen use at 295 W metabolic rate (NASA BVAD Rev 2, 2022)
  apolloKJh: 1030,      // mean Apollo lunar surface EVA metabolic rate (BVAD Rev 2)
  walkbackKJh: 2505,    // mean rate in NASA's 10 km Advanced Walkback Test, n = 6 (BVAD Rev 2)
  radMsvPerDay: 0.67,   // Curiosity RAD surface dose rate at Gale (Hassler et al. 2014)
  careerLimitMsv: 600,  // NASA career radiation limit
  suitSlopeDeg: 20,     // slope NASA's exploration suit is meant to walk on
  solHours: 24.6597,    // length of a Mars sol in Earth hours
};

// Emergency walk home costs this many times the working effort. Derived, not measured on Mars.
export const WALKBACK_FACTOR = NASA.walkbackKJh / NASA.apolloKJh;

// Earth hours in one hour of Mars local clock time.
export const MARS_HOUR = NASA.solHours / 24;

export const DEFAULTS = {
  speedKmh: 3.3,     // Apollo 15 traverse planning speed. Assumed for Mars.
  slowFactor: 1.5,   // pessimism: the walk home may take this much longer than planned. Assumed.
  o2StartKg: 0.69,   // 8 h at the NASA working rate. Derived.
  reserveMin: 30,    // margin kept by the BASALT Mars-analog missions. Analog practice.
  startClock: '09:00',
  sunsetClock: '18:51',
};

// Local mean solar time on Mars at an east longitude, in hours 0-24, for an Earth instant.
// Mars24 algorithm (Allison & McEwen 2000, NASA GISS): Mars Sol Date from Terrestrial Time.
const TT_MINUS_UTC_S = 69.184;   // 37 leap seconds + 32.184 s; unchanged since 2017
export function marsLocalHours(epochMs, lonEastDeg) {
  const jdTT = epochMs / 86400000 + 2440587.5 + TT_MINUS_UTC_S / 86400;
  const msd = (jdTT - 2451545.0 - 4.5) / 1.0274912517 + 44796.0 - 0.0009626;
  const mtc = ((msd % 1) + 1) % 1 * 24;           // mean solar time at Mars' prime meridian
  return (mtc + lonEastDeg / 15 + 24) % 24;
}

export function hoursToClock(hours) {
  const mins = Math.floor(((hours % 24) + 24) % 24 * 60);
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

export function clockToHours(clock) {
  const [h, m] = clock.split(':').map(Number);
  return h + m / 60;
}

// Mars local clock reading at t Earth hours after departure.
export function clockAt(p, t) {
  const mars = clockToHours(p.startClock) + t / MARS_HOUR;
  const mins = Math.round(mars * 60);
  const hh = Math.floor(mins / 60) % 24;
  return `${String(hh).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

const walkHours = (p, metres) => metres / 1000 / p.speedKmh;

// plan = { baseChain, stops: [{ chain, dwellMin }] }  ->  ordered segments of the day.
export function buildTimeline(plan, p) {
  const segs = [];
  let t = 0;
  let c = plan.baseChain;
  plan.stops.forEach((s, i) => {
    const dt = walkHours(p, Math.abs(s.chain - c));
    segs.push({ kind: 'walk', stop: i, t0: t, t1: t + dt, c0: c, c1: s.chain });
    t += dt;
    c = s.chain;
    segs.push({ kind: 'work', stop: i, t0: t, t1: t + s.dwellMin / 60, c0: c, c1: c });
    t += s.dwellMin / 60;
  });
  const back = walkHours(p, Math.abs(c - plan.baseChain));
  segs.push({ kind: 'return', stop: -1, t0: t, t1: t + back, c0: c, c1: plan.baseChain });
  return { segs, turnT: t, endT: t + back };
}

export function positionAt(tl, t) {
  const tt = Math.max(0, Math.min(t, tl.endT));
  const seg = tl.segs.find((s) => tt <= s.t1) || tl.segs[tl.segs.length - 1];
  const f = seg.t1 > seg.t0 ? (tt - seg.t0) / (seg.t1 - seg.t0) : 0;
  return { seg, chain: seg.c0 + (seg.c1 - seg.c0) * f };
}

// How much longer the crew could stay at this spot before the walk home no longer fits.
// Oxygen: what is left, minus an emergency-effort walk home at the slow pace, minus the reserve.
// Daylight: time to sunset, minus the slow walk home, minus the reserve.
export function marginAt(p, baseChain, t, chain) {
  const homeM = Math.abs(chain - baseChain);
  const homeFastH = walkHours(p, homeM);
  const homeSlowH = homeFastH * p.slowFactor;
  const reserveH = p.reserveMin / 60;

  const o2LeftKg = p.o2StartKg - NASA.o2WorkKgH * t;
  const o2HomeKg = homeSlowH * NASA.o2WorkKgH * WALKBACK_FACTOR;
  const o2H = (o2LeftKg - o2HomeKg) / NASA.o2WorkKgH - reserveH;

  const daylightH = (clockToHours(p.sunsetClock) - clockToHours(p.startClock)) * MARS_HOUR - t;
  const dayH = daylightH - homeSlowH - reserveH;

  const limiting = o2H <= dayH ? 'oxygen' : 'daylight';
  return {
    h: Math.min(o2H, dayH), o2H, dayH, limiting, homeM, homeFastH, homeSlowH, o2LeftKg, daylightH,
    o2KeptKg: o2HomeKg + reserveH * NASA.o2WorkKgH,   // locked for the walk home plus reserve
    dayKeptH: homeSlowH + reserveH,
    dayTotalH: daylightH + t,
  };
}

// Furthest distance from the refuge that is still recoverable at time t (the walk-back limit).
export function reachAt(p, t) {
  const reserveH = p.reserveMin / 60;
  const slowHPerM = p.slowFactor / (p.speedKmh * 1000);
  const o2M = (p.o2StartKg / NASA.o2WorkKgH - t - reserveH) / (slowHPerM * WALKBACK_FACTOR);
  const daylightH = (clockToHours(p.sunsetClock) - clockToHours(p.startClock)) * MARS_HOUR - t;
  const dayM = (daylightH - reserveH) / slowHPerM;
  return Math.max(0, Math.min(o2M, dayM));
}

// Latest time (Earth hours after departure) the crew can start home from a given spot.
export function leaveByAt(p, baseChain, chain) {
  const m0 = marginAt(p, baseChain, 0, chain);
  return { t: m0.h, limiting: m0.limiting };
}

// Does the plan hold? Walks the outbound part of the day in 20-second steps.
export function analyse(plan, p) {
  const tl = buildTimeline(plan, p);
  const step = 20 / 3600;
  let tight = null;
  for (let t = 0; t <= tl.turnT + 1e-9; t += step) {
    const { seg, chain } = positionAt(tl, t);
    const m = marginAt(p, plan.baseChain, t, chain);
    if (m.h < 0) return { ok: false, tl, breakAt: { t, chain, seg, limiting: m.limiting } };
    if (!tight || m.h < tight.m.h) tight = { t, chain, seg, m };
  }
  return { ok: true, tl, tight };
}

export function doseMsv(hours) {
  return (NASA.radMsvPerDay * hours) / 24;
}

// ---- Route geometry. route = [[lon, lat, elev_m, chain_m], ...] sorted by chain. ----

export function pointAtChain(route, chain) {
  const c = Math.max(route[0][3], Math.min(chain, route[route.length - 1][3]));
  let lo = 0;
  let hi = route.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (route[mid][3] <= c) lo = mid;
    else hi = mid;
  }
  const a = route[lo];
  const b = route[hi];
  const f = b[3] > a[3] ? (c - a[3]) / (b[3] - a[3]) : 0;
  return { lon: a[0] + (b[0] - a[0]) * f, lat: a[1] + (b[1] - a[1]) * f, elev: a[2] + (b[2] - a[2]) * f, chain: c };
}

// Index of the last route point at or before `chain`.
export function indexAtChain(route, chain) {
  let lo = 0;
  let hi = route.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (route[mid][3] <= chain) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

export function sliceRoute(route, c0, c1) {
  const lo = Math.min(c0, c1);
  const hi = Math.max(c0, c1);
  const pts = [pointAtChain(route, lo)];
  for (let i = indexAtChain(route, lo); i < route.length && route[i][3] < hi; i++) {
    const r = route[i];
    if (r[3] > lo) pts.push({ lon: r[0], lat: r[1], elev: r[2], chain: r[3] });
  }
  pts.push(pointAtChain(route, hi));
  return pts;
}

// Slope at each route point, measured over at least `baseM` metres of path.
// 20 m is the shortest baseline where the result agrees with the tilt the rover itself recorded.
export const SLOPE_BASE_M = 20;
const CLIMB_NOISE_M = 1;   // ignore ups and downs smaller than this when adding up climb

export function routeSlopes(route, baseM = SLOPE_BASE_M) {
  const out = new Array(route.length).fill(0);
  let j = 0;
  for (let i = 0; i < route.length; i++) {
    if (j <= i) j = i + 1;
    while (j < route.length - 1 && route[j][3] - route[i][3] < baseM) j++;
    if (j >= route.length) { out[i] = out[i - 1] || 0; continue; }
    const run = route[j][3] - route[i][3];
    const rise = route[j][2] - route[i][2];
    const flat = Math.sqrt(Math.max(run * run - rise * rise, 1e-6));
    out[i] = run < baseM / 2 ? (out[i - 1] || 0) : (Math.atan2(Math.abs(rise), flat) * 180) / Math.PI;
  }
  return out;
}

export function legStats(route, slopes, c0, c1) {
  const lo = Math.min(c0, c1);
  const hi = Math.max(c0, c1);
  let up = 0;
  let down = 0;
  let maxSlope = 0;
  let ref = pointAtChain(route, lo).elev;
  const step = (e, final) => {
    const d = e - ref;
    if (!final && Math.abs(d) < CLIMB_NOISE_M) return;
    if (d > 0) up += d; else down -= d;
    ref = e;
  };
  for (let i = indexAtChain(route, lo); i < route.length && route[i][3] < hi; i++) {
    const r = route[i];
    if (r[3] <= lo) continue;
    step(r[2], false);
    if (slopes[i] > maxSlope) maxSlope = slopes[i];
  }
  step(pointAtChain(route, hi).elev, true);
  const fwd = c1 >= c0;
  return { distM: hi - lo, climbM: fwd ? up : down, dropM: fwd ? down : up, maxSlopeDeg: maxSlope };
}

// Compass bearing from a to b, degrees clockwise from north.
export function bearingDeg(a, b) {
  const lat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lon - a.lon) * Math.cos(lat);
  const dy = b.lat - a.lat;
  return (Math.atan2(dx, dy) * 180 / Math.PI + 360) % 360;
}

// Local east/north metres from an origin, for sketches.
export function toLocalM(origin, pt, radiusM) {
  const k = (Math.PI / 180) * radiusM;
  return { x: (pt.lon - origin.lon) * Math.cos(origin.lat * Math.PI / 180) * k, y: (pt.lat - origin.lat) * k };
}

export function fmtDur(hours) {
  const mins = Math.max(0, Math.round(hours * 60));
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return h ? `${h} h ${String(m).padStart(2, '0')} min` : `${m} min`;
}

// "20–30 min" for a walk of `metres`, planned pace to slow pace.
export function fmtWalkRange(p, metres) {
  const fast = (metres / 1000 / p.speedKmh) * 60;
  const slow = fast * p.slowFactor;
  return slow < 1 ? 'under 1 min' : `${Math.round(fast)}–${Math.round(slow)} min`;
}

export function fmtDist(m) {
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}
