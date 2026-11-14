// Walk simulation: predicts time, consumables and rule violations for a planned walk before it
// happens. Pure functions, no DOM. SI units inside (seconds, metres, watts, kilograms); Mars clock
// time appears only in display fields (lmst0, lmst1, backLmst) and in the daylight rule, converted
// with the exact sol length (1 Mars hour = sol length / 24 = 3698.97 s).
//
// Every constant is in SUIT with its units, a tag and a source:
//   NASA VALUE  a number printed in a NASA (or NASA contractor) document, quoted in `source`
//   MEASURED    a measured physical quantity
//   DERIVED     arithmetic on NASA values, shown in `source`
//   ASSUMED     no source; a planning assumption the user can change
// Nothing here has been measured on a suited person in Mars gravity. See result.assumptions.

import { bearingDeg } from './model.js';
import { SOL_LENGTH_S } from './sun.js';

const BVAD2 = 'https://ntrs.nasa.gov/citations/20210024855';
const BVAD1 = 'https://ntrs.nasa.gov/api/citations/20180001338/downloads/20180001338.pdf';
const XEMU = 'https://ntrs.nasa.gov/api/citations/20170009505/downloads/20170009505.pdf';
const SCOVILLE = 'https://ntrs.nasa.gov/api/citations/20210026296/downloads/Scoville%20Final%20presentation%20-%20compressed.pptx.pdf';
const A15 = 'https://web.archive.org/web/2id_/http://www.hq.nasa.gov/alsj/19790073512_1979073512.pdf';
const MARS_PLSS = 'https://ntrs.nasa.gov/api/citations/20260002884/downloads/ICES2026_Mars_Schematic_Study_FINAL.pdf';
const PEXTANT = 'https://github.com/norheim/pextant/blob/master/pextant/explorers.py';
const MARS24 = 'https://www.giss.nasa.gov/tools/mars24/help/algorithm.html';

const c = (value, units, tag, source, url = null) => ({ value, units, tag, source, url });

export const SUIT = {
  // ---- Oxygen ----
  o2StartKg: c(0.771, 'kg', 'NASA VALUE',
    'xEMU Primary Oxygen Vessel "stores ~1.7 lbm of usable oxygen" (Campbell 2017, xEMU PLSS schematic description, PDF p. 13). 1.7 lbm = 0.771 kg.', XEMU),
  o2KgPerWh: c(2.56e-4, 'kg per watt-hour of metabolic energy', 'DERIVED',
    '0.075 kg/CM-h oxygen at 293 W and respiratory quotient 0.9 (BVAD Rev 1, Table 4-76, PDF p. 157): 0.075 / 293. BVAD Rev 2 Table 4-70 prints 0.086 kg/CM-h and still says 295 W; that pair would mean 17.6 kJ per litre of oxygen, below what any food fuel gives, so it is not used as a per-watt factor. At the 352 W xEMU design rate this factor gives 0.090 kg/h, close to the Rev 2 figure.', BVAD1),
  o2LeakKgH: c(0.005, 'kg/h', 'NASA VALUE',
    '"Oxygen leakage alone accounts for a loss rate of 0.02 kg per 4-hour EVA sortie, or 0.005 kg/h" (BVAD Rev 2, section 4.6.2, p. 134).', BVAD2),
  co2PerO2: c(1.2375, 'kg CO2 per kg O2 breathed', 'DERIVED',
    'Respiratory quotient 0.90 (BVAD Rev 2, p. 134) times the molar mass ratio 44/32.', BVAD2),

  // ---- Cooling water ----
  waterStartKg: c(3.856, 'kg', 'DERIVED',
    'The xEMU feedwater assembly FSA-431 is labelled "10 lbs H2O" in the PLSS schematic (Campbell 2017, PDF p. 7), drawn as an 8.5 lb bladder plus a 1.5 lb bladder, and the check valves signal "with ~ 1 lb of feedwater remaining" (p. 16). Usable water is therefore about 8.5 to 9 lb; the model uses 8.5 lb = 3.856 kg.', XEMU),
  coolingWaterKgHAt295W: c(0.57, 'kg/h at 295 W', 'NASA VALUE',
    'Cooling water "0.57 kg/h, which is a typical value when a radiator is not used. The calculation here assumes a human metabolic rate of 1.06 MJ/CM-h (295 W)" (BVAD Rev 2, section 4.6.2, p. 133). Kept for reference; the model uses the two entries below, which reproduce it.', BVAD2),
  coolingExtraHeatW: c(92.9, 'W', 'DERIVED',
    'Heat the evaporator rejects on top of metabolism (electronics, environment): 0.57 kg/h x 2.45 MJ/kg / 3600 s = 387.9 W, minus 295 W. Assumed constant. Cold Mars surroundings would lower it, so this is conservative.', BVAD2),
  waterLatentJKg: c(2.45e6, 'J/kg', 'MEASURED',
    'Latent heat of evaporation of water near 20 C (standard physical property). Cross-check: the Apollo 15 planning memo rates 9.8 lb of feedwater at 10,065 BTU, which is 2.39 MJ/kg.'),

  // ---- Battery ----
  battStartWh: c(756, 'Wh', 'NASA VALUE',
    'xEMU primary PLSS battery BATT-690, 8S-8P, 756 Wh (Campbell 2017, section 2.8 table, PDF p. 18).', XEMU),
  battLoadW: c(80, 'W', 'ASSUMED',
    'No published xEMU power budget was found. 80 W drains the 756 Wh battery in 9.45 h, i.e. an 8 h walk plus margin.'),

  // ---- Walking ----
  speedKmh: c(3.3, 'km/h on level ground', 'ASSUMED',
    '"The metabolic rate for planned walking traverses is 1200 BTU/hr at a speed of 3.3 km/hr" (Bellcomm memo B70-10028, Apollo 15 EVA Capability and Constraints Envelopes, 1970). A lunar planning value; using it on Mars is an assumption. Artemis III plans 2 km/h.', A15),
  levelWatts: c(352, 'W on level ground at the planned speed', 'NASA VALUE',
    '"The xEMU average design metabolic rate is 1.27 MJ/CM-h (352 W)" (BVAD Rev 2, p. 134). Equal to the Apollo 15 planning rate for walking, 1200 BTU/hr = 352 W at 3.3 km/h.', BVAD2),
  restWatts: c(144, 'W', 'ASSUMED',
    'Floor on walking power so that very slow walking on steep ground never costs less than the lowest suited rate on record: Apollo lunar surface EVA minimum 517 kJ/h = 144 W (BVAD Rev 2, Table 4-71, p. 136). Using it as a floor is an assumption.', BVAD2),
  bodyMassKg: c(82, 'kg', 'NASA VALUE',
    'Crew member mass used in BVAD Rev 2, Table 4-68 (p. 132).', BVAD2),
  suitMassKg: c(121, 'kg', 'ASSUMED',
    'Mass of the Mark III test suit used in NASA\'s Integrated Suit Tests (per the project research notes; not re-opened). The mass of a Mars suit is not known.', 'https://ntrs.nasa.gov/api/citations/20090007828/downloads/20090007828.pdf'),
  gravityMs2: c(3.71, 'm/s^2', 'NASA VALUE',
    'Mars mean acceleration due to gravity (BVAD Rev 2, Table 4-66, p. 132).', BVAD2),
  slowWalkFactor: c(1.375, 'ratio', 'DERIVED',
    'Planned 3.3 km/h divided by the 2.4 km/h average of an Apollo walking traverse (Waligora and Horrigan, NTRS 19750006325, per the project research notes; not re-opened). Used only for the high end of the duration range.', 'https://ntrs.nasa.gov/citations/19750006325'),
  slopeBaseM: c(20, 'm', 'ASSUMED',
    'Distance along the path over which slope is measured. js/model.js reports 20 m as the shortest baseline that agrees with the tilt the rover recorded.'),

  // ---- Emergency return (suit failure, or walking home on what is left) ----
  emergencyReturnMin: c(60, 'min', 'NASA VALUE',
    'xEMU Auxiliary Thermal Control Loop is "designed to support an EVA abort to the vehicle safe haven for 60 minutes" (Campbell 2017, section 2.6, PDF p. 16). Artemis III: "1 hour of contingency capability to protect suit system failures" (Scoville 2021, slide 4).', XEMU),
  emergencyReturnHighFlowMin: c(30, 'min', 'NASA VALUE',
    'Sensitivity case: the suit purge valve "would offer the 30 minute abort time at the higher flow rate" (Campbell 2017, PDF p. 15).', XEMU),
  emergencySpeedKmh: c(3.3, 'km/h on level ground', 'ASSUMED',
    '"A 20% pad is required for emergency walkback, making the metabolic rate 1440 BTU/hr at a speed of 3.3 km/hr" (Bellcomm memo B70-10028, 1970). Lunar planning value, assumed for Mars.', A15),
  emergencyWatts: c(422, 'W', 'NASA VALUE',
    '1440 BTU/hr = 422 W for emergency walkback (Bellcomm memo B70-10028, 1970). Lunar planning value, assumed for Mars.', A15),
  reserveMin: c(30, 'min', 'NASA VALUE',
    'Apollo 15 PLSS capacities "are defined after allowance for a 30 minute consumables reserve" (Bellcomm memo B70-10028, 1970).', A15),

  // ---- Limits ----
  slopeLimitDeg: c(20, 'deg', 'NASA VALUE',
    '"Astronaut in suit must be able to walk up, down, across a 20-degree slope" (Scoville 2021, Artemis III landing site presentation, slide 4). Applied to Mars by assumption.', SCOVILLE),
  slopeCautionBandDeg: c(3, 'deg', 'ASSUMED',
    'Slopes within this many degrees below the limit raise a caution. About the slope error of the terrain model.'),
  blockSlopeDeg: c(30, 'deg', 'ASSUMED',
    'Slopes steeper than this are impassable in the speed table handed to route finding. SEXTANT masks terrain above 35 deg.', PEXTANT),
  maxEvaH: c(8, 'h', 'NASA VALUE',
    'The xEVA suit shall operate "for a minimum of 8 hours of EVA operation" (Scoville 2021, slide 4).', SCOVILLE),
  cautionMarginMin: c(10, 'min', 'ASSUMED',
    'A time, oxygen, water or battery margin smaller than this raises a caution.'),
  spaceWeatherWarnDays: c(2, 'days', 'ASSUMED',
    'A Mars-directed solar event expected within this many days blocks the walk.'),

  // ---- Work at a station ----
  workLightW: c(144, 'W', 'NASA VALUE',
    'Apollo lunar surface EVA minimum, 517 kJ/h, "minimum for low-activity EVA durations" (BVAD Rev 2, Table 4-71, p. 136). Calling this "light" work is an assumption.', BVAD2),
  workModerateW: c(286, 'W', 'NASA VALUE',
    'Apollo lunar surface EVA average, 1030 kJ/h (BVAD Rev 2, Table 4-71, p. 136). Calling this "moderate" work is an assumption.', BVAD2),
  workHeavyW: c(530, 'W', 'NASA VALUE',
    'Maximum metabolic rate used to size the primary Mars PLSS, "530 W (1810 BTU/hr)" (Oliver et al., ICES-2026-158, PDF p. 3). Calling this "heavy" work is an assumption.', MARS_PLSS),

  // ---- Time ----
  solLengthS: c(SOL_LENGTH_S, 's', 'NASA VALUE',
    'One sol = 1.0274912517 Earth days (Mars24 algorithm, eq. C-2).', MARS24),
};

// Plain {name: value} view of SUIT. `params` passed to the functions below override these.
export const DEFAULT_PARAMS = Object.freeze(
  Object.fromEntries(Object.entries(SUIT).map(([k, v]) => [k, v.value])),
);

const resolved = new WeakSet();
export function resolveParams(params) {
  if (params && resolved.has(params)) return params;
  const p = { ...DEFAULT_PARAMS };
  for (const [k, v] of Object.entries(params || {})) {
    if (typeof v === 'number' && Number.isFinite(v)) p[k] = v;
  }
  resolved.add(p);
  return p;
}

const RAD = Math.PI / 180;
const MARS_RADIUS_M = 3396190;

// ---- Pace and power -------------------------------------------------------------------------
//
// Speed shape: the walking-speed-versus-slope function in MIT/NASA's SEXTANT planner (pextant
// explorers.py, credited there to Marquez 2008; lunar, said to be built from Apollo data).
// It gives 1.6 m/s on the level; the whole curve is scaled so the level speed is params.speedKmh.
// Slope in degrees along the direction of travel, positive uphill.
const MARQUEZ_LEVEL_MS = 1.6;
function marquezMs(s) {
  if (s <= -20) return 0.05;
  if (s <= -10) return 0.095 * s + 1.95;
  if (s <= 0) return 0.06 * s + 1.6;
  if (s <= 6) return -0.2 * s + 1.6;
  if (s <= 15) return Math.max(0.05, -0.039 * s + 0.634);
  return 0.05;
}

// Power shape: Santee et al. 2001 as coded in SEXTANT.
//   level term     (3.28 m + 71.1) (0.661 v cos a + 0.115)       [no gravity in it]
//   uphill term    3.5 m g v sin a
//   downhill term  2.4 m g v sin a 0.3^(|a| / 7.65 deg)          [a credit that fades when steep]
// Santee is an unsuited, Earth-gravity treadmill model at one speed and gentle grades. Fed a suited
// mass it gives about 530 W for level walking, far above NASA's design rate, so the level term is
// multiplied by k, chosen so that level walking at the planned speed costs params.levelWatts.
// The slope terms keep their physical form with Mars gravity. All of this is ASSUMED for Mars.
function santeeWatts(slopeDeg, v, p) {
  const m = p.bodyMassKg + p.suitMassKg;
  const a = slopeDeg * RAD;
  const coef = 3.28 * m + 71.1;
  const k = p.levelWatts / (coef * (0.661 * (p.speedKmh / 3.6) + 0.115));
  const level = k * coef * (0.661 * v * Math.cos(a) + 0.115);
  const climb = slopeDeg >= 0
    ? 3.5 * m * p.gravityMs2 * v * Math.sin(a)
    : 2.4 * m * p.gravityMs2 * v * Math.sin(a) * Math.pow(0.3, Math.abs(slopeDeg) / 7.65);
  return Math.max(p.restWatts, level + climb);
}

// Suited walking speed (m/s over the map) and metabolic power (W) on a slope.
// Emergency mode: the same speed shape scaled to params.emergencySpeedKmh, charged at the flat
// emergency rate params.emergencyWatts whatever the slope (the Apollo walk-back convention).
// Steeper than the slope limit still returns a finite, very slow value; the rule engine flags it.
export function paceAndPower(slopeDeg, params, emergency = false) {
  const p = resolveParams(params);
  const s = Number.isFinite(slopeDeg) ? slopeDeg : 0;
  const levelMs = (emergency ? p.emergencySpeedKmh : p.speedKmh) / 3.6;
  const speedMs = marquezMs(s) * (levelMs / MARQUEZ_LEVEL_MS);
  // The speed curve slows a climb so much that the raw formula would make it cheaper than level
  // walking. Apollo crews recorded their highest rates on climbs, so a climb never costs less than level ground.
  let watts = emergency ? p.emergencyWatts : santeeWatts(s, speedMs, p);
  if (!emergency && s > 0) watts = Math.max(watts, santeeWatts(0, levelMs, p));
  return { speedMs, watts };
}

// Walking speed in m/s for whole signed slope degrees -90..+90 (index = degrees + 90).
// 0 means impassable (steeper than params.blockSlopeDeg). Time for a map distance d is d / speed.
export function speedTable(params, emergency = false) {
  const p = resolveParams(params);
  const table = new Float32Array(181);
  for (let deg = -90; deg <= 90; deg++) {
    table[deg + 90] = Math.abs(deg) > p.blockSlopeDeg ? 0 : paceAndPower(deg, p, emergency).speedMs;
  }
  return table;
}

// Consumable use per second at a metabolic rate. Oxygen and water scale with effort, battery with time.
export function ratesAt(watts, params) {
  const p = resolveParams(params);
  const o2Met = (watts * p.o2KgPerWh) / 3600;
  return {
    o2KgS: o2Met + p.o2LeakKgH / 3600,
    co2KgS: o2Met * p.co2PerO2,
    waterKgS: (watts + p.coolingExtraHeatW) / p.waterLatentJKg,
    battWhS: p.battLoadW / 3600,
  };
}

// ---- Small helpers --------------------------------------------------------------------------

// 'HH:MM' on a Mars clock for decimal Mars hours, rounded to the minute.
export function lmstClock(hours) {
  const mins = ((Math.round(hours * 60) % 1440) + 1440) % 1440;
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function groundDistM(a, b) {
  const lat = ((a.lat + b.lat) / 2) * RAD;
  const dx = (b.lon - a.lon) * RAD * Math.cos(lat) * MARS_RADIUS_M;
  const dy = (b.lat - a.lat) * RAD * MARS_RADIUS_M;
  return Math.hypot(dx, dy);
}

// Path with a trustworthy cumulative distance: uses distM when present, lat/lon otherwise.
function cleanPath(path) {
  const out = [];
  let d = 0;
  (path || []).forEach((pt, i) => {
    if (i > 0) {
      const prev = path[i - 1];
      const step = Number.isFinite(pt.distM) && Number.isFinite(prev.distM)
        ? pt.distM - prev.distM : groundDistM(prev, pt);
      d += Math.max(0, step);
    }
    out.push({ lat: pt.lat, lon: pt.lon, elev: Number.isFinite(pt.elev) ? pt.elev : 0, distM: d });
  });
  return out;
}

// Slope of each path segment in degrees, positive uphill in the direction walked, measured over
// a window of at least baseM centred on the segment (single-post slopes are mostly terrain noise).
function segmentSlopes(pts, baseM) {
  const n = pts.length;
  const out = new Array(Math.max(0, n - 1)).fill(0);
  if (n < 2) return out;
  const first = pts[0].distM;
  const last = pts[n - 1].distM;
  for (let j = 0; j < n - 1; j++) {
    const mid = (pts[j].distM + pts[j + 1].distM) / 2;
    let lo = mid - baseM / 2;
    let hi = mid + baseM / 2;
    if (lo < first) { hi += first - lo; lo = first; }
    if (hi > last) { lo = Math.max(first, lo - (hi - last)); hi = last; }
    let a = j;
    while (a > 0 && pts[a].distM > lo) a--;
    let b = j + 1;
    while (b < n - 1 && pts[b].distM < hi) b++;
    const run = pts[b].distM - pts[a].distM;
    out[j] = run > 0 ? Math.atan2(pts[b].elev - pts[a].elev, run) / RAD : 0;
  }
  return out;
}

const CLIMB_NOISE_M = 1;   // same dead band as js/model.js: ignore ups and downs smaller than this
function climbAndDrop(pts) {
  let up = 0;
  let down = 0;
  if (!pts.length) return { climbM: 0, dropM: 0 };
  let ref = pts[0].elev;
  pts.forEach((pt, i) => {
    const d = pt.elev - ref;
    if (i < pts.length - 1 && Math.abs(d) < CLIMB_NOISE_M) return;
    if (d > 0) up += d; else down -= d;
    ref = pt.elev;
  });
  return { climbM: up, dropM: down };
}

const fmtMin = (m) => (Number.isFinite(m) ? `${Math.round(m)} min` : 'no walkable route');
const fmtKm = (m) => (m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`);
const fmtH = (s) => `${Math.floor(Math.round(s / 60) / 60)} h ${String(Math.round(s / 60) % 60).padStart(2, '0')} min`;

// Stretches of the walk where test(sample) is truthy, as [{stepIndex, fromDistM, toDistM, level}].
// test returns a level string or a falsy value. A flagged sample covers the ground walked to reach it.
function stretches(samples, test) {
  const out = [];
  let cur = null;
  samples.forEach((s, k) => {
    const level = test(s, k);
    if (!level) { cur = null; return; }
    const prev = k > 0 && samples[k - 1].stepIndex === s.stepIndex ? samples[k - 1] : s;
    if (cur && cur.stepIndex === s.stepIndex && cur.level === level) {
      cur.toDistM = s.distM;
    } else {
      cur = { stepIndex: s.stepIndex, fromDistM: prev.distM, toDistM: s.distM, level };
      out.push(cur);
    }
  });
  return out;
}

const stretchLengthM = (list) => list.reduce((sum, s) => sum + (s.toDistM - s.fromDistM), 0);

function levelForMargin(marginMin, p) {
  if (!(marginMin >= 0)) return 'warning';
  return marginMin < p.cautionMarginMin ? 'caution' : 'pass';
}

// ---- The simulation -------------------------------------------------------------------------

// plan   = { name, egressLmstH, refuge: {lat, lon, elev, name}, steps: [walk | work ...] }
//   walk = { type: 'walk', id, to, proven, path: [{lat, lon, elev, distM}] }   distM from the step start
//   work = { type: 'work', id, name, durMin, effort: 'light' | 'moderate' | 'heavy' }
// params = overrides of DEFAULT_PARAMS (same names as SUIT)
// env    = { sun: {sunriseLmstH, sunsetLmstH}, homeTimeS(lat, lon), visibleFromRefuge(lat, lon),
//            looseAt(lat, lon), spaceWeather: {marsImpactWithinDays, note} }   all optional
// The walk is assumed to start at the refuge. Consumables are not clamped at zero: a negative
// amount is how much the plan is short.
export function simulate(plan, params = {}, env = {}) {
  const p = resolveParams(params);
  const e = env || {};
  const marsHourS = p.solLengthS / 24;
  const egressH = Number.isFinite(plan.egressLmstH) ? plan.egressLmstH : 0;
  const clockAt = (tS) => lmstClock(egressH + tS / marsHourS);
  const reserveS = p.reserveMin * 60;
  const emergency = ratesAt(p.emergencyWatts, p);
  const planSteps = plan.steps || [];

  let tS = 0;
  let distM = 0;
  let o2Kg = p.o2StartKg;
  let co2Kg = 0;
  let waterKg = p.waterStartKg;
  let battWh = p.battStartWh;
  let backS = 0;      // emergency time to retrace everything walked so far
  let aheadS = 0;     // emergency time along the plan from the start to here
  let walkS = 0;
  let pos = plan.refuge
    ? { lat: plan.refuge.lat, lon: plan.refuge.lon, elev: plan.refuge.elev ?? 0 }
    : { lat: 0, lon: 0, elev: 0 };

  const samples = [];
  const steps = [];
  // The slope of the ground itself where the crew stands, whichever way it faces, when the app can
  // supply it. Walking along a steep hillside has little slope along the path but is still steep ground.
  const groundAt = typeof e.groundSlopeAt === 'function' ? e.groundSlopeAt : null;
  const sample = (stepIndex, slopeDeg, speedMs, watts) => {
    const g = groundAt ? groundAt(pos.lat, pos.lon) : null;
    samples.push({
      tS, lat: pos.lat, lon: pos.lon, elev: pos.elev, distM, slopeDeg, groundDeg: Number.isFinite(g) ? g : null, speedMs, watts,
      o2Kg, waterKg, battWh, homeS: 0, stepIndex, backS, aheadS,
    });
  };
  const spend = (watts, dt) => {
    const r = ratesAt(watts, p);
    tS += dt;
    o2Kg -= r.o2KgS * dt;
    co2Kg += r.co2KgS * dt;
    waterKg -= r.waterKgS * dt;
    battWh -= r.battWhS * dt;
  };

  planSteps.forEach((step, i) => {
    const t0S = tS;
    const dist0M = distM;
    let energyJ = 0;
    let out;
    if (step.type === 'walk') {
      const pts = cleanPath(step.path);
      const slopes = segmentSlopes(pts, p.slopeBaseM);
      let maxSlopeDeg = 0;
      if (pts.length) {
        pos = pts[0];
        const first = paceAndPower(slopes[0] ?? 0, p);
        sample(i, slopes[0] ?? 0, first.speedMs, first.watts);
      }
      for (let j = 0; j < pts.length - 1; j++) {
        const run = pts[j + 1].distM - pts[j].distM;
        const slope = slopes[j];
        const { speedMs, watts } = paceAndPower(slope, p);
        const dt = run / speedMs;
        spend(watts, dt);
        energyJ += watts * dt;
        walkS += dt;
        distM += run;
        backS += run / paceAndPower(-slope, p, true).speedMs;
        aheadS += run / paceAndPower(slope, p, true).speedMs;
        if (Math.abs(slope) > maxSlopeDeg) maxSlopeDeg = Math.abs(slope);
        pos = pts[j + 1];
        sample(i, slope, speedMs, watts);
      }
      const to = step.to && typeof step.to === 'object' ? step.to.name : step.to;
      out = {
        i, type: 'walk', id: step.id, name: to ?? step.id,
        headingDeg: pts.length > 1 && distM > dist0M ? bearingDeg(pts[0], pts[pts.length - 1]) : null,
        ...climbAndDrop(pts), maxSlopeDeg,
        proven: step.proven !== false,
      };
    } else {
      const watts = { light: p.workLightW, moderate: p.workModerateW, heavy: p.workHeavyW }[step.effort]
        ?? p.workModerateW;
      const dt = Math.max(0, Number(step.durMin) || 0) * 60;
      sample(i, 0, 0, watts);
      spend(watts, dt);
      energyJ += watts * dt;
      sample(i, 0, 0, watts);
      out = {
        i, type: 'work', id: step.id, name: step.name ?? step.id,
        headingDeg: null, climbM: 0, dropM: 0, maxSlopeDeg: 0, effort: step.effort ?? 'moderate',
      };
    }
    steps.push({
      ...out,
      t0S, t1S: tS, lmst0: clockAt(t0S), lmst1: clockAt(tS),
      dist0M, distM: distM - dist0M,
      meanWatts: tS > t0S ? energyJ / (tS - t0S) : 0,
      o2EndKg: o2Kg, co2Kg, waterEndKg: waterKg, battEndWh: battWh,
      homeEndS: 0, flags: [],
    });
  });

  // Time to walk home from every sample at emergency pace.
  // With a terrain routine: its answer. Without: the shorter of retracing the path walked so far
  // and carrying on along the plan, when the plan ends at the refuge.
  const lastStep = planSteps[planSteps.length - 1];
  const endsAtRefuge = !!lastStep && lastStep.type === 'walk' && (
    lastStep.id === 'RETURN' || (!!plan.refuge && groundDistM(pos, plan.refuge) <= 50)
  );
  const homeFromTerrain = typeof e.homeTimeS === 'function';
  for (const s of samples) {
    let h;
    if (homeFromTerrain) {
      h = e.homeTimeS(s.lat, s.lon);
      if (!(h >= 0)) h = Infinity;
    } else {
      h = endsAtRefuge ? Math.min(s.backS, aheadS - s.aheadS) : s.backS;
    }
    s.homeS = h;
    // Minutes of slack after the emergency walk home plus the reserve, for each consumable.
    s.o2MarginMin = (s.o2Kg / emergency.o2KgS - h - reserveS) / 60;
    s.waterMarginMin = (s.waterKg / emergency.waterKgS - h - reserveS) / 60;
    s.battMarginMin = (s.battWh / emergency.battWhS - h - reserveS) / 60;
    delete s.backS;
    delete s.aheadS;
  }
  steps.forEach((st) => {
    for (let k = samples.length - 1; k >= 0; k--) {
      if (samples[k].stepIndex === st.i) { st.homeEndS = samples[k].homeS; break; }
    }
  });

  const durS = tS;
  const backLmstH = egressH + durS / marsHourS;
  // Worst sample for a field (sign +1: largest, -1: smallest). Ties go to the earlier sample.
  const worstBy = (key, sign) => samples.reduce(
    (w, s) => (w === null || sign * s[key] > sign * w[key] + 1e-9 ? s : w), null,
  );

  // ---- Rules ----
  const rules = [];
  const rule = (id, title, level, fields) => rules.push({
    id, title, level, value: null, limit: null, units: '', text: '', stepIndex: null, segments: [],
    marginMin: null, ...fields,
  });

  // FR-01 suit failure: can the crew reach the refuge on the emergency supply from everywhere?
  {
    const limitS = p.emergencyReturnMin * 60;
    const worst = worstBy('homeS', 1);
    const homeMin = worst ? worst.homeS / 60 : 0;
    const marginMin = p.emergencyReturnMin - homeMin;
    const level = levelForMargin(marginMin, p);
    rule('FR-01', 'Suit-failure return time', level, {
      value: homeMin, limit: p.emergencyReturnMin, units: 'min', marginMin,
      stepIndex: worst ? worst.stepIndex : null,
      segments: stretches(samples, (s) => (s.homeS > limitS ? 'warning' : null)),
      sensitivity: { limitMin: p.emergencyReturnHighFlowMin, pass: homeMin <= p.emergencyReturnHighFlowMin },
      text: Number.isFinite(homeMin)
        ? `The farthest point is ${fmtMin(homeMin)} from the refuge at emergency pace, against the suit's ${p.emergencyReturnMin} min emergency supply.`
        : 'Part of the walk has no walkable route back to the refuge in the terrain model.',
    });
  }

  // FR-02, FR-08, FR-09: what is left must cover the emergency walk home plus the reserve, everywhere.
  const supplyRule = (id, title, key, noun, amount, units, digits, need) => {
    const worst = worstBy(key, -1);
    const marginMin = worst ? worst[key] : Infinity;
    const level = levelForMargin(marginMin, p);
    const left = worst ? amount(worst) : 0;
    rule(id, title, level, {
      value: marginMin, limit: 0, units: 'min', marginMin,
      stepIndex: worst ? worst.stepIndex : null,
      segments: stretches(samples, (s) => (s[key] < 0 ? 'warning' : null)),
      text: !worst ? `No walk to check for ${noun}.`
        : !Number.isFinite(worst.homeS) ? `There is no walkable route home to budget ${noun} for.`
          : `At the tightest point, ${fmtKm(worst.distM)} into the walk, ${left.toFixed(digits)} ${units} of ${noun} is left against ${need(worst).toFixed(digits)} ${units} needed for the ${fmtMin(worst.homeS / 60)} emergency walk home plus the ${p.reserveMin} min reserve, a margin of ${Math.round(marginMin)} min.`,
    });
  };
  supplyRule('FR-02', 'Oxygen for the walk home', 'o2MarginMin', 'oxygen', (s) => s.o2Kg, 'kg', 2,
    (s) => (s.homeS + reserveS) * emergency.o2KgS);

  // FR-03 daylight: back before sunset less the reserve, and not out before sunrise.
  if (!e.sun || !Number.isFinite(e.sun.sunsetLmstH)) {
    rule('FR-03', 'Daylight', 'advisory', { text: 'Daylight was not checked: no sun data.' });
  } else {
    const latestBackH = e.sun.sunsetLmstH - reserveS / marsHourS;
    const beforeSunrise = Number.isFinite(e.sun.sunriseLmstH) && egressH < e.sun.sunriseLmstH;
    const marginMin = beforeSunrise
      ? ((egressH - e.sun.sunriseLmstH) * marsHourS) / 60
      : ((latestBackH - backLmstH) * marsHourS) / 60;
    rule('FR-03', 'Daylight', levelForMargin(marginMin, p), {
      value: backLmstH, limit: latestBackH, units: 'h LMST', marginMin,
      stepIndex: steps.length ? steps.length - 1 : null,
      text: beforeSunrise
        ? `The walk starts at ${lmstClock(egressH)}, ${Math.round(-marginMin)} min before sunrise at ${lmstClock(e.sun.sunriseLmstH)}.`
        : `Back at ${lmstClock(backLmstH)}; sunset is ${lmstClock(e.sun.sunsetLmstH)}, so with the ${p.reserveMin} min reserve the latest return is ${lmstClock(latestBackH)}, a margin of ${Math.round(marginMin)} min.`,
    });
  }

  // FR-04 slope: up, down or across. The steeper of the slope along the path and the slope of the
  // ground itself is judged, at every point including the stations and the refuge.
  {
    const cautionAt = p.slopeLimitDeg - p.slopeCautionBandDeg;
    const steep = (s) => Math.max(Math.abs(s.slopeDeg), s.groundDeg ?? 0);
    for (const st of steps) for (const s of samples) if (s.stepIndex === st.i && steep(s) > st.maxSlopeDeg) st.maxSlopeDeg = steep(s);
    const worst = samples.reduce((w, s) => (w === null || steep(s) > steep(w) ? s : w), null);
    const maxDeg = worst ? steep(worst) : 0;
    const level = maxDeg > p.slopeLimitDeg ? 'warning' : maxDeg > cautionAt ? 'caution' : 'pass';
    const segs = stretches(samples, (s) => {
      const a = steep(s);
      return a > p.slopeLimitDeg ? 'warning' : a > cautionAt ? 'caution' : null;
    });
    const over = stretchLengthM(segs.filter((s) => s.level === 'warning'));
    rule('FR-04', 'Slope on route', level, {
      value: maxDeg, limit: p.slopeLimitDeg, units: 'deg',
      stepIndex: worst && level !== 'pass' ? worst.stepIndex : null, segments: segs,
      text: level === 'warning'
        ? `The steepest ground on the route is ${maxDeg.toFixed(1)} deg, over the ${p.slopeLimitDeg} deg suit limit for ${fmtKm(over)}${groundAt ? ' (slope of the ground, along or across the path)' : ''}.`
        : `The steepest ground on the route is ${maxDeg.toFixed(1)} deg against the ${p.slopeLimitDeg} deg suit limit${groundAt ? ', along or across the path' : '; slope across the path was not checked'}.`,
    });
  }

  // FR-05 ground a rover has driven.
  {
    const unproven = steps.filter((st) => st.type === 'walk' && !st.proven);
    const m = unproven.reduce((sum, st) => sum + st.distM, 0);
    rule('FR-05', 'Ground driven by a rover', unproven.length ? 'caution' : 'pass', {
      value: m, limit: 0, units: 'm', stepIndex: unproven.length ? unproven[0].i : null,
      segments: unproven.map((st) => ({ stepIndex: st.i, fromDistM: st.dist0M, toDistM: st.dist0M + st.distM, level: 'caution' })),
      text: unproven.length
        ? `${fmtKm(m)} of the walk in ${unproven.length} leg${unproven.length > 1 ? 's' : ''} is on ground no rover has driven.`
        : 'Every leg follows ground a rover has driven.',
    });
  }

  // FR-06 line of sight to the refuge.
  if (typeof e.visibleFromRefuge === 'function') {
    const segs = stretches(samples, (s) => (e.visibleFromRefuge(s.lat, s.lon) ? null : 'advisory'));
    const m = stretchLengthM(segs);
    rule('FR-06', 'Line of sight to refuge', segs.length ? 'advisory' : 'pass', {
      value: m, limit: 0, units: 'm', stepIndex: segs.length ? segs[0].stepIndex : null, segments: segs,
      text: segs.length
        ? `The refuge is out of sight for ${fmtKm(m)} of the walk.`
        : 'The refuge is in sight for the whole walk.',
    });
  }

  // FR-07 total time outside.
  {
    const marginMin = p.maxEvaH * 60 - durS / 60;
    rule('FR-07', 'EVA duration', levelForMargin(marginMin, p), {
      value: durS / 3600, limit: p.maxEvaH, units: 'h', marginMin,
      stepIndex: marginMin < 0 && steps.length ? steps.length - 1 : null,
      text: `The walk lasts ${fmtH(durS)} against the ${p.maxEvaH} h suit limit.`,
    });
  }

  supplyRule('FR-08', 'Battery', 'battMarginMin', 'battery energy', (s) => s.battWh, 'Wh', 0,
    (s) => (s.homeS + reserveS) * emergency.battWhS);
  supplyRule('FR-09', 'Cooling water', 'waterMarginMin', 'cooling water', (s) => s.waterKg, 'kg', 2,
    (s) => (s.homeS + reserveS) * emergency.waterKgS);

  // FR-10 space weather.
  if (e.spaceWeather) {
    const days = e.spaceWeather.marsImpactWithinDays;
    const bad = typeof days === 'number' && days <= p.spaceWeatherWarnDays;
    const stale = !!e.spaceWeather.stale;
    const note = e.spaceWeather.note ? ` ${e.spaceWeather.note}` : '';
    // A forecast direct hit blocks the walk; a glancing blow is a caution.
    const glancing = !!e.spaceWeather.glancing;
    const when = days === 0 ? 'now or within the last day' : `within ${days} day${days === 1 ? '' : 's'}`;
    rule('FR-10', 'Space weather', bad ? (glancing ? 'caution' : 'warning') : stale ? 'unknown' : 'pass', {
      value: typeof days === 'number' ? days : null, limit: p.spaceWeatherWarnDays, units: 'days',
      text: (bad
        ? `A solar eruption is forecast to ${glancing ? 'graze' : 'reach'} Mars ${when}, inside the ${p.spaceWeatherWarnDays} day limit.`
        : typeof days === 'number'
          ? `The next Mars-directed solar event is ${days} days away, outside the ${p.spaceWeatherWarnDays} day limit.`
          : stale ? 'Not evaluated: the forecast data are too old to say whether a solar eruption is on its way to Mars.'
            : 'No Mars-directed solar event is forecast.') + note,
    });
  }

  // FR-11 loose ground.
  if (typeof e.looseAt === 'function') {
    const segs = stretches(samples, (s) => (e.looseAt(s.lat, s.lon) ? 'advisory' : null));
    const m = stretchLengthM(segs);
    rule('FR-11', 'Loose ground', segs.length ? 'advisory' : 'pass', {
      value: m, limit: 0, units: 'm', stepIndex: segs.length ? segs[0].stepIndex : null, segments: segs,
      text: segs.length
        ? `${fmtKm(m)} of the walk crosses loose ground, which is slower and harder than the model assumes.`
        : 'No loose ground on the route.',
    });
  }

  rules.sort((a, b) => a.id.localeCompare(b.id));
  for (const r of rules) {
    if (r.level === 'pass') continue;
    const hit = r.segments.length ? r.segments.map((s) => s.stepIndex) : (r.stepIndex === null ? [] : [r.stepIndex]);
    for (const i of new Set(hit)) if (steps[i] && !steps[i].flags.includes(r.id)) steps[i].flags.push(r.id);
  }

  // ---- Consumables ----
  const levelOf = (id) => rules.find((r) => r.id === id).level;
  const state = (id) => (levelOf(id) === 'warning' ? 'warning' : levelOf(id) === 'caution' ? 'caution' : 'ok');
  const consumables = [
    { id: 'o2', title: 'Oxygen', units: 'kg', start: p.o2StartKg, end: o2Kg, used: p.o2StartKg - o2Kg, reserve: reserveS * emergency.o2KgS, state: state('FR-02') },
    // Carbon dioxide is produced, not drawn down, so `used` is negative. The amine swing bed vents it
    // continuously, so it never limits the walk.
    { id: 'co2', title: 'Carbon dioxide produced', units: 'kg', start: 0, end: co2Kg, used: -co2Kg, produced: co2Kg, reserve: 0, state: 'ok' },
    { id: 'water', title: 'Cooling water', units: 'kg', start: p.waterStartKg, end: waterKg, used: p.waterStartKg - waterKg, reserve: reserveS * emergency.waterKgS, state: state('FR-09') },
    { id: 'battery', title: 'Battery', units: 'Wh', start: p.battStartWh, end: battWh, used: p.battStartWh - battWh, reserve: reserveS * emergency.battWhS, state: state('FR-08') },
  ];

  // ---- Verdict ----
  const warnings = rules.filter((r) => r.level === 'warning');
  const withMargin = rules.filter((r) => typeof r.marginMin === 'number' && !Number.isNaN(r.marginMin));
  const limiting = withMargin.reduce((w, r) => (w === null || r.marginMin < w.marginMin ? r : w), null);
  const marginText = limiting
    ? (Number.isFinite(limiting.marginMin)
      ? `${limiting.id} ${limiting.title.toLowerCase()}, ${limiting.marginMin >= 0 ? `with ${Math.round(limiting.marginMin)} min to spare` : `short by ${Math.round(-limiting.marginMin)} min`}`
      : `${limiting.id} ${limiting.title.toLowerCase()}`)
    : 'none';
  const verdict = {
    go: warnings.length === 0,
    limiting: limiting ? limiting.id : null,
    marginMin: limiting ? limiting.marginMin : null,
    blocking: warnings.map((r) => r.id),
    text: warnings.length === 0
      ? `Go: every rule holds and the tightest is ${marginText}.`
      : `No-go: ${warnings.map((r) => `${r.id} ${r.title.toLowerCase()}`).join(', ')} ${warnings.length > 1 ? 'fail' : 'fails'}; the tightest margin is ${marginText}.`,
  };

  const durHighS = durS + walkS * (p.slowWalkFactor - 1);
  const totals = {
    distM, durS, durLowS: durS, durHighS,
    backLmst: lmstClock(backLmstH),
    rangeBasis: `Low is the plan as modelled. High slows every walking leg by ${p.slowWalkFactor} (planned 3.3 km/h against the 2.4 km/h an Apollo crew averaged on foot); work time is unchanged.`,
  };

  const assumptions = [
    'No suited walking data exist for Mars gravity; every time and effort number here is extrapolated from Earth and Moon data.',
    `Walking speed against slope follows the SEXTANT (Marquez) lunar curve, scaled so level ground is ${p.speedKmh} km/h. It is slow on climbs (about a quarter of level speed at +6 deg) and nearly stopped above +15 deg or below -20 deg.`,
    `Walking power follows Santee 2001 (unsuited, Earth gravity, gentle grades), with its level term scaled so level walking costs ${p.levelWatts} W and its climbing terms using Mars gravity and ${p.bodyMassKg + p.suitMassKg} kg of person plus suit; never less than ${p.restWatts} W.`,
    `The emergency walk home is at ${p.emergencySpeedKmh} km/h on the level (same slope curve) and is charged ${p.emergencyWatts} W whatever the slope; these are Apollo 15 planning values.`,
    homeFromTerrain
      ? 'Time to walk home comes from the terrain model supplied by the app.'
      : `Time to walk home is the shorter of retracing the path walked so far and ${endsAtRefuge ? 'carrying on along the plan' : 'nothing else, because the plan does not end at the refuge'}; a more direct route is not considered.`,
    `The reserve is ${p.reserveMin} min at the emergency rate, for oxygen, cooling water and battery alike.`,
    `Oxygen use is ${(p.o2KgPerWh * 1000).toFixed(3)} g per watt-hour of effort plus ${(p.o2LeakKgH * 1000).toFixed(0)} g/h leakage; purge, pre-breathe and swing-bed losses are not counted.`,
    `Cooling water carries away all body heat plus a constant ${p.coolingExtraHeatW} W by evaporation, with no radiator and no heat lost to the cold surroundings; real use on Mars should be lower.`,
    `The battery load is an assumed constant ${p.battLoadW} W.`,
    groundAt
      ? `Slope is judged two ways: along the direction of travel over ${p.slopeBaseM} m of path, and as the slope of the ground itself from the terrain model, so walking across a steep hillside is caught.`
      : `Slope is measured along the direction of travel over ${p.slopeBaseM} m of path only; walking across a steep hillside is not detected without the terrain model.`,
    'Loose ground and rocks are flagged where the app supplies them but add no time or effort.',
    'The walk is assumed to start at the refuge; time in the airlock and suit checks are not counted.',
    'Daylight uses the sunrise and sunset the app supplies; a flat horizon ignores crater walls and dust.',
    totals.rangeBasis,
  ];

  return { name: plan.name ?? null, steps, samples, consumables, rules, verdict, totals, assumptions };
}
