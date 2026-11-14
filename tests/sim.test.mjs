import test from 'node:test';
import assert from 'node:assert/strict';
import { marsLocalHours } from '../js/model.js';
import { marsSun, marsOrbit, sunAt, daylight, SOL_LENGTH_S, MARS_HOUR_S } from '../js/sun.js';
import {
  SUIT, DEFAULT_PARAMS, paceAndPower, speedTable, ratesAt, simulate, lmstClock,
} from '../js/sim.js';

const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b} (eps ${eps})`);
const P = DEFAULT_PARAMS;

// ---------------------------------------------------------------- sun.js

const GALE = { lat: -4.59, lon: 137.44 };
const LANDING_MS = Date.UTC(2012, 7, 6, 5, 17, 57);

test('sun: Curiosity landed at about 15:00 local mean solar time', () => {
  const s = marsSun(LANDING_MS, GALE.lat, GALE.lon);
  assert.ok(s.lmstH > 14.8 && s.lmstH < 15.3, `lmst ${s.lmstH}`);
  near(s.lmstH, marsLocalHours(LANDING_MS, GALE.lon), 1e-12);
  assert.ok(s.elevDeg > 0, 'afternoon sun is up');
  assert.ok(s.azDeg > 180 && s.azDeg < 360, 'afternoon sun is in the west');
});

test('sun: lmstH agrees with model.js marsLocalHours at other instants and longitudes', () => {
  for (const [ms, lon] of [[Date.UTC(2026, 10, 14, 12), 137.44], [Date.UTC(2031, 2, 3, 1, 2, 3), 0], [Date.UTC(2020, 1, 18), 77.45]]) {
    near(marsSun(ms, 0, lon).lmstH, marsLocalHours(ms, lon), 1e-12);
  }
});

test('sun: reproduces the two worked examples on the NASA GISS Mars24 page', () => {
  // The page uses TT - UTC = 64.184 s for these dates; this code uses the current 69.184 s,
  // so the instants are shifted by 5 s to compare like with like.
  const a = marsSun(947116800000 - 5000, 0, 0);          // 2000-01-06 00:00 UTC, 0 N 0 E
  near(a.lsDeg, 277.18758, 1e-4);
  near(a.eotMin / 4, -5.18774, 1e-4);                    // degrees
  near(a.lmstH, 23.99425, 1e-4);
  near(a.ltstH, 23.64840, 1e-4);
  near(a.declDeg, -25.22825, 1e-3);
  near(90 - a.elevDeg, 154.26182, 1e-3);
  near(a.azDeg, 191.03905, 1e-3);
  const b = marsSun(1073137591000 - 5000, -14.640, 360 - 184.702);   // Spirit, local true midnight
  near(b.lsDeg, 327.32416, 1e-4);
  near(b.lmstH, 0.85190, 1e-4);
  assert.ok(b.ltstH < 0.001 || b.ltstH > 23.999, `ltst ${b.ltstH}`);
  near(b.azDeg, 180, 0.01);
});

test('sun: overhead at local true noon when declination equals latitude', () => {
  const s = sunAt(12, GALE.lat, GALE.lat);
  near(s.elevDeg, 90, 1e-4);
  near(sunAt(12, 0, GALE.lat).elevDeg, 90 - Math.abs(GALE.lat), 1e-9);
  near(sunAt(12, 0, GALE.lat).azDeg, 0, 1e-9);           // sun to the north of a southern site
});

test('sun: day length is half a sol at the equator and close to it at Gale all year', () => {
  near(marsSun(LANDING_MS, 0, GALE.lon).dayLengthH, 12, 1e-9);
  for (let d = 0; d < 687; d += 7) {
    const s = marsSun(LANDING_MS + d * 86400000, GALE.lat, GALE.lon);
    assert.ok(s.dayLengthH > 11.6 && s.dayLengthH < 12.4, `day ${d}: ${s.dayLengthH}`);
    near(s.sunsetLtstH - s.sunriseLtstH, s.dayLengthH, 1e-9);
    near(s.sunriseLtstH + s.sunsetLtstH, 24, 1e-9);
    // LMST and LTST differ by the equation of time
    near(((s.sunsetLtstH - s.sunsetLmstH) * 60 + 720) % 1440 - 720, s.eotMin, 1e-6);
  }
  near(sunAt(daylight(10, -30).sunsetLtstH, 10, -30).elevDeg, 0, 1e-9);
  assert.equal(daylight(25, 80).dayLengthH, 24);
  assert.equal(daylight(25, -80).sunriseLtstH, null);
});

test('sun: east in the morning, west in the afternoon, up by day, down by night', () => {
  const decl = marsOrbit(LANDING_MS).declDeg;
  const am = sunAt(8, decl, GALE.lat);
  const pm = sunAt(16, decl, GALE.lat);
  assert.ok(am.azDeg > 0 && am.azDeg < 180, `morning azimuth ${am.azDeg}`);
  assert.ok(pm.azDeg > 180 && pm.azDeg < 360, `afternoon azimuth ${pm.azDeg}`);
  near(am.elevDeg, pm.elevDeg, 1e-9);
  assert.ok(am.elevDeg > 0 && sunAt(0, decl, GALE.lat).elevDeg < 0);
});

test('sun: equation of time stays within the published range over a Mars year', () => {
  // Allison & McEwen 2000: about -51 to +40 minutes. The Mars24 page shows -00:51:06 at Ls 327.
  let lo = Infinity;
  let hi = -Infinity;
  for (let d = 0; d < 700; d += 0.5) {
    const m = marsOrbit(LANDING_MS + d * 86400000).eotMin;
    lo = Math.min(lo, m);
    hi = Math.max(hi, m);
  }
  assert.ok(lo > -52 && lo < -50, `min ${lo}`);
  assert.ok(hi > 39 && hi < 41, `max ${hi}`);
});

test('sun: a Mars hour is one twenty-fourth of a sol, not an SI hour', () => {
  near(SOL_LENGTH_S, 88775.244, 1e-3);
  near(MARS_HOUR_S, 3698.9685, 1e-3);
  assert.equal(marsSun(LANDING_MS, 0, 0).solLengthS, SOL_LENGTH_S);
});

// ---------------------------------------------------------------- sim.js helpers

const REFUGE = { lat: -4.59, lon: 137.44, elev: -4400, name: 'Refuge' };
const M_PER_DEG = (Math.PI / 180) * 3396190;

// Straight path heading north from `from`, `lengthM` long, points every `stepM`, constant slope.
function leg(from, lengthM, slopeDeg = 0, stepM = 10) {
  const n = Math.round(lengthM / stepM);
  const rise = Math.tan(slopeDeg * Math.PI / 180) * stepM;
  return Array.from({ length: n + 1 }, (_, i) => ({
    lat: from.lat + (i * stepM) / M_PER_DEG, lon: from.lon, elev: from.elev + i * rise, distM: i * stepM,
  }));
}
const reversed = (path) => {
  const end = path[path.length - 1].distM;
  return path.slice().reverse().map((pt) => ({ ...pt, distM: end - pt.distM }));
};
const walk = (id, path, proven = true) => ({ type: 'walk', id, to: id, proven, path });
const work = (durMin, effort = 'moderate') => ({ type: 'work', id: 'W', name: 'Station work', durMin, effort });

function outAndBack(lengthM, { slopeDeg = 0, workMin = 0, effort = 'moderate', proven = true, egressLmstH = 9 } = {}) {
  const out = leg(REFUGE, lengthM, slopeDeg);
  const steps = [walk('A', out, proven)];
  if (workMin) steps.push(work(workMin, effort));
  steps.push(walk('RETURN', reversed(out)));
  return { name: 'test walk', egressLmstH, refuge: REFUGE, steps };
}
const ruleOf = (r, id) => r.rules.find((x) => x.id === id);
const SUN = { sun: { sunriseLmstH: 6.2, sunsetLmstH: 18.2 } };

// ---------------------------------------------------------------- constants and pace

test('every suit constant has a value, units, a tag and a source', () => {
  const tags = new Set(['NASA VALUE', 'MEASURED', 'DERIVED', 'ASSUMED']);
  for (const [name, k] of Object.entries(SUIT)) {
    assert.equal(typeof k.value, 'number', name);
    assert.ok(Number.isFinite(k.value), name);
    assert.ok(typeof k.units === 'string' && k.units.length > 0, name);
    assert.ok(tags.has(k.tag), `${name}: ${k.tag}`);
    assert.ok(typeof k.source === 'string' && k.source.length > 10, name);
    assert.ok(k.url === null || k.url.startsWith('https://'), name);
    assert.equal(DEFAULT_PARAMS[name], k.value);
  }
  for (const name of ['o2StartKg', 'o2KgPerWh', 'o2LeakKgH', 'co2PerO2', 'waterStartKg', 'battStartWh', 'battLoadW',
    'speedKmh', 'emergencyReturnMin', 'emergencyReturnHighFlowMin', 'emergencySpeedKmh', 'emergencyWatts',
    'reserveMin', 'slopeLimitDeg', 'maxEvaH', 'workLightW', 'workModerateW', 'workHeavyW']) {
    assert.ok(SUIT[name], name);
  }
  assert.equal(SUIT.emergencyReturnMin.value, 60);
  assert.equal(SUIT.emergencyReturnHighFlowMin.value, 30);
  assert.equal(SUIT.slopeLimitDeg.value, 20);
  assert.equal(SUIT.maxEvaH.value, 8);
  assert.equal(SUIT.battLoadW.tag, 'ASSUMED');
});

test('pace: level ground gives the planned speed and the NASA design rate', () => {
  const a = paceAndPower(0, {});
  near(a.speedMs, 3.3 / 3.6, 1e-12);
  near(a.watts, 352, 1e-9);
  const b = paceAndPower(0, { speedKmh: 2, levelWatts: 300 });
  near(b.speedMs, 2 / 3.6, 1e-12);
  near(b.watts, 300, 1e-9);
});

test('pace: steeper uphill is slower and costs more per metre', () => {
  let prev = paceAndPower(0, {});
  for (let s = 1; s <= 30; s++) {
    const cur = paceAndPower(s, {});
    assert.ok(cur.speedMs <= prev.speedMs, `speed at ${s}`);
    assert.ok(cur.watts / cur.speedMs >= prev.watts / prev.speedMs, `J/m at ${s}`);
    if (s <= 15) assert.ok(cur.speedMs < prev.speedMs, `strictly slower at ${s}`);
    prev = cur;
  }
  const up = paceAndPower(10, {});
  const down = paceAndPower(-10, {});
  assert.ok(up.speedMs < down.speedMs);
  assert.ok(up.watts / up.speedMs > down.watts / down.speedMs);
  // gentle downhill is cheaper per metre than level ground
  assert.ok(paceAndPower(-5, {}).watts / paceAndPower(-5, {}).speedMs < 352 / (3.3 / 3.6));
});

test('pace: beyond the slope limit the answer is still finite and slow', () => {
  for (const s of [-90, -45, -25, 21, 35, 90, NaN]) {
    const r = paceAndPower(s, {});
    assert.ok(Number.isFinite(r.speedMs) && r.speedMs > 0, `speed at ${s}`);
    assert.ok(Number.isFinite(r.watts) && r.watts >= SUIT.restWatts.value, `watts at ${s}`);
  }
  assert.ok(paceAndPower(25, {}).speedMs < 0.05);
});

test('pace: emergency mode uses the emergency speed and the flat emergency rate', () => {
  const r = paceAndPower(0, { emergencySpeedKmh: 4 }, true);
  near(r.speedMs, 4 / 3.6, 1e-12);
  assert.equal(r.watts, 422);
  assert.equal(paceAndPower(8, {}, true).watts, 422);
  assert.ok(paceAndPower(8, {}, true).speedMs < paceAndPower(0, {}, true).speedMs);
});

test('speed table: 181 whole degrees, zero where impassable', () => {
  const t = speedTable({});
  assert.ok(t instanceof Float32Array);
  assert.equal(t.length, 181);
  near(t[90], 3.3 / 3.6, 1e-6);
  near(t[90 + 5], paceAndPower(5, {}).speedMs, 1e-6);
  near(t[90 - 12], paceAndPower(-12, {}).speedMs, 1e-6);
  assert.ok(t[90 + 30] > 0 && t[90 - 30] > 0);
  assert.equal(t[90 + 31], 0);
  assert.equal(t[90 - 31], 0);
  assert.equal(t[0], 0);
  assert.equal(t[180], 0);
  const tight = speedTable({ blockSlopeDeg: 15 });
  assert.equal(tight[90 + 16], 0);
  assert.ok(tight[90 + 15] > 0);
  near(speedTable({ emergencySpeedKmh: 5 }, true)[90], 5 / 3.6, 1e-6);
});

// ---------------------------------------------------------------- simulate

test('level out-and-back matches hand arithmetic for time and oxygen', () => {
  const r = simulate(outAndBack(1000), {}, SUN);
  const hours = 2 / 3.3;                                        // 2 km at 3.3 km/h
  near(r.totals.durS, hours * 3600, 1e-6);
  near(r.totals.distM, 2000, 1e-9);
  const o2Used = hours * (352 * 2.56e-4 + 0.005);               // metabolic + leak, kg
  const o2 = r.consumables.find((x) => x.id === 'o2');
  near(o2.used, o2Used, 1e-9);
  near(o2.end, 0.771 - o2Used, 1e-9);
  near(r.consumables.find((x) => x.id === 'co2').end, hours * 352 * 2.56e-4 * 1.2375, 1e-9);
  near(r.consumables.find((x) => x.id === 'battery').used, hours * 80, 1e-6);
  near(r.consumables.find((x) => x.id === 'water').used, hours * 3600 * (352 + 92.9) / 2.45e6, 1e-9);
  // steps
  assert.deepEqual(r.steps.map((s) => s.id), ['A', 'RETURN']);
  near(r.steps[0].t1S, 1000 / (3.3 / 3.6), 1e-6);
  near(r.steps[0].meanWatts, 352, 1e-6);
  near(r.steps[0].headingDeg, 0, 1e-6);
  near(r.steps[1].headingDeg, 180, 1e-6);
  near(r.steps[0].homeEndS, 1000 / (3.3 / 3.6), 1e-6);
  near(r.steps[1].homeEndS, 0, 1e-6);
  assert.equal(r.steps[0].lmst0, '09:00');
  // Mars clock: the walk takes hours * 3600 SI seconds, which is fewer Mars minutes
  const marsMin = (hours * 3600) / MARS_HOUR_S * 60;
  assert.equal(r.totals.backLmst, lmstClock(9 + marsMin / 60));
  assert.equal(r.totals.backLmst, '09:35');                     // 36.4 SI min = 35.4 Mars min
  assert.equal(r.samples.length, 202);
  assert.ok(r.verdict.go);
  assert.ok(r.assumptions.length > 5 && r.assumptions.every((a) => typeof a === 'string'));
});

test('samples: one per path point plus two per work step, cumulative distance, falling oxygen', () => {
  const r = simulate(outAndBack(500, { workMin: 20 }), {}, SUN);
  assert.equal(r.samples.length, 51 + 2 + 51);
  for (let k = 1; k < r.samples.length; k++) {
    assert.ok(r.samples[k].tS >= r.samples[k - 1].tS);
    assert.ok(r.samples[k].distM >= r.samples[k - 1].distM);
    assert.ok(r.samples[k].o2Kg <= r.samples[k - 1].o2Kg);
    assert.ok(r.samples[k].stepIndex >= r.samples[k - 1].stepIndex);
  }
  near(r.samples[r.samples.length - 1].distM, 1000, 1e-9);
  const w = r.samples.filter((s) => s.stepIndex === 1);
  assert.equal(w.length, 2);
  near(w[1].tS - w[0].tS, 20 * 60, 1e-9);
  assert.equal(w[0].speedMs, 0);
  assert.equal(w[0].watts, 286);
  near(r.steps[1].meanWatts, 286, 1e-9);
  near(r.totals.durS, 1000 / (3.3 / 3.6) + 1200, 1e-6);
});

test('a 5 km out-and-back fails the suit-failure rule and passes with a longer emergency supply', () => {
  const plan = outAndBack(5000);
  const r = simulate(plan, {}, SUN);
  const fr1 = ruleOf(r, 'FR-01');
  assert.equal(fr1.level, 'warning');
  near(fr1.value, 5000 / (3.3 / 3.6) / 60, 1e-6);               // 90.9 min at the far point
  assert.equal(fr1.limit, 60);
  near(fr1.marginMin, 60 - 5000 / (3.3 / 3.6) / 60, 1e-6);
  assert.equal(r.verdict.go, false);
  assert.ok(r.verdict.blocking.includes('FR-01'));
  // the stretch beyond 3.3 km on the way out and on the way back is flagged
  assert.equal(fr1.segments.length, 2);
  near(fr1.segments[0].fromDistM, 3300, 10.001);
  near(fr1.segments[0].toDistM, 5000, 1e-6);
  near(fr1.segments[1].toDistM, 6700, 10.001);
  assert.ok(r.steps[0].flags.includes('FR-01') && r.steps[1].flags.includes('FR-01'));
  assert.equal(fr1.sensitivity.pass, false);

  const ok = simulate(plan, { emergencyReturnMin: 120 }, SUN);
  assert.equal(ruleOf(ok, 'FR-01').level, 'pass');
  assert.equal(ruleOf(ok, 'FR-01').segments.length, 0);

  // a 1.5 km walk passes at 60 min and fails the 30 min high-flow sensitivity case
  const short = ruleOf(simulate(outAndBack(1500), {}, SUN), 'FR-01');
  assert.equal(short.level, 'pass');
  assert.equal(short.sensitivity.limitMin, 30);
  assert.equal(short.sensitivity.pass, true);
  assert.equal(ruleOf(simulate(outAndBack(2000), {}, SUN), 'FR-01').sensitivity.pass, false);
});

test('an uphill leg takes longer and burns more than the same leg downhill', () => {
  const up = simulate({ refuge: REFUGE, egressLmstH: 9, steps: [walk('UP', leg(REFUGE, 500, 5))] }, {}, {});
  const down = simulate({ refuge: REFUGE, egressLmstH: 9, steps: [walk('DOWN', leg(REFUGE, 500, -5))] }, {}, {});
  assert.ok(up.totals.durS > down.totals.durS * 1.5);
  const used = (r) => r.consumables.find((x) => x.id === 'o2').used;
  assert.ok(used(up) > used(down) * 1.5);
  near(up.steps[0].maxSlopeDeg, 5, 1e-6);
  near(up.steps[0].climbM, 500 * Math.tan(5 * Math.PI / 180), 1e-6);
  near(down.steps[0].dropM, 500 * Math.tan(5 * Math.PI / 180), 1e-6);
  assert.equal(down.steps[0].climbM, 0);
  // and the numbers are the pace model's
  near(up.totals.durS, 500 / paceAndPower(5, {}).speedMs, 1e-6);
  near(down.totals.durS, 500 / paceAndPower(-5, {}).speedMs, 1e-6);
  near(up.steps[0].meanWatts, paceAndPower(5, {}).watts, 1e-6);
  // walking home from the top of a climb is downhill, so it is quicker than the climb was
  near(up.steps[0].homeEndS, 500 / paceAndPower(-5, {}, true).speedMs, 1e-6);
  near(down.steps[0].homeEndS, 500 / paceAndPower(5, {}, true).speedMs, 1e-6);
});

test('slope rule: caution within 3 degrees of the limit, warning above it', () => {
  const run = (deg) => ruleOf(simulate({ refuge: REFUGE, egressLmstH: 9, steps: [walk('S', leg(REFUGE, 60, deg))] }, {}, {}), 'FR-04');
  assert.equal(run(10).level, 'pass');
  assert.equal(run(16.9).level, 'pass');
  assert.equal(run(18).level, 'caution');
  assert.equal(run(-18).level, 'caution');
  assert.equal(run(22).level, 'warning');
  near(run(22).value, 22, 1e-6);
  assert.equal(run(22).limit, 20);
  near(run(22).segments[0].toDistM - run(22).segments[0].fromDistM, 60, 1e-6);
  assert.equal(run(12, {}).level, 'pass');
  const strict = ruleOf(simulate({ refuge: REFUGE, steps: [walk('S', leg(REFUGE, 60, 12))] }, { slopeLimitDeg: 10 }, {}), 'FR-04');
  assert.equal(strict.level, 'warning');
});

test('an unproven leg raises the rover-ground caution and nothing else', () => {
  const proven = simulate(outAndBack(800), {}, SUN);
  const unproven = simulate(outAndBack(800, { proven: false }), {}, SUN);
  assert.equal(ruleOf(proven, 'FR-05').level, 'pass');
  const fr5 = ruleOf(unproven, 'FR-05');
  assert.equal(fr5.level, 'caution');
  near(fr5.value, 800, 1e-9);
  assert.deepEqual(fr5.segments.map((s) => [s.stepIndex, s.fromDistM, s.toDistM]), [[0, 0, 800]]);
  assert.deepEqual(unproven.steps[0].flags, ['FR-05']);
  assert.deepEqual(unproven.steps[1].flags, []);
  assert.ok(unproven.verdict.go, 'a caution does not block the walk');
  for (const r of unproven.rules) {
    if (r.id !== 'FR-05') assert.equal(r.level, ruleOf(proven, r.id).level, r.id);
  }
  near(unproven.totals.durS, proven.totals.durS, 1e-9);
});

test('a late start fails the daylight rule; no sun data gives an advisory', () => {
  const sun = { sun: { sunriseLmstH: 6, sunsetLmstH: 18 } };
  const early = ruleOf(simulate(outAndBack(1000, { workMin: 60, egressLmstH: 9 }), {}, sun), 'FR-03');
  assert.equal(early.level, 'pass');
  const lateRun = simulate(outAndBack(1000, { workMin: 60, egressLmstH: 16.5 }), {}, sun);
  const late = ruleOf(lateRun, 'FR-03');
  assert.equal(late.level, 'warning');
  assert.equal(lateRun.verdict.go, false);
  // margin in SI minutes: Mars hours to sunset converted exactly, minus walk, minus reserve
  const durS = 2000 / (3.3 / 3.6) + 3600;
  near(late.marginMin, ((18 - 16.5) * MARS_HOUR_S - durS - 30 * 60) / 60, 1e-6);
  near(late.marginMin, -33.9, 0.1);                             // 92.5 min of daylight, 96.4 min walk, 30 min reserve
  // treating the 1.5 Mars hours to sunset as SI hours would be 2.5 min out
  near(late.marginMin - ((18 - 16.5) * 3600 - durS - 1800) / 60, 1.5 * (MARS_HOUR_S - 3600) / 60, 1e-6);
  assert.ok(1.5 * (MARS_HOUR_S - 3600) / 60 > 2.4);

  const before = ruleOf(simulate(outAndBack(1000, { egressLmstH: 5 }), {}, sun), 'FR-03');
  assert.equal(before.level, 'warning');
  assert.match(before.text, /before sunrise/);

  const none = ruleOf(simulate(outAndBack(1000), {}, {}), 'FR-03');
  assert.equal(none.level, 'advisory');
  assert.match(none.text, /no sun data/);
  assert.equal(none.marginMin, null);
  assert.ok(simulate(outAndBack(1000), {}, {}).verdict.go);
});

test('a very long work step fails oxygen or duration exactly as arithmetic predicts', () => {
  const emergO2 = (422 * 2.56e-4 + 0.005) / 60;                 // kg per minute at the emergency rate
  // 7.5 h of heavy work at the refuge: inside 8 h, but the tank runs dry
  const heavy = simulate({ refuge: REFUGE, egressLmstH: 8, steps: [work(450, 'heavy')] }, {}, {});
  const o2Left = 0.771 - 7.5 * (530 * 2.56e-4 + 0.005);
  assert.ok(o2Left < 0);
  near(heavy.consumables.find((x) => x.id === 'o2').end, o2Left, 1e-9);
  assert.equal(ruleOf(heavy, 'FR-02').level, 'warning');
  near(ruleOf(heavy, 'FR-02').marginMin, o2Left / emergO2 - 30, 1e-6);
  assert.equal(ruleOf(heavy, 'FR-07').level, 'pass');
  near(ruleOf(heavy, 'FR-07').marginMin, 30, 1e-9);
  assert.equal(heavy.consumables.find((x) => x.id === 'o2').state, 'warning');
  assert.equal(heavy.verdict.go, false);

  // 8.5 h of light work: oxygen is fine, the suit's 8 h limit is not
  const light = simulate({ refuge: REFUGE, egressLmstH: 8, steps: [work(510, 'light')] }, {}, {});
  const left = 0.771 - 8.5 * (144 * 2.56e-4 + 0.005);
  near(ruleOf(light, 'FR-02').marginMin, left / emergO2 - 30, 1e-6);
  assert.equal(ruleOf(light, 'FR-02').level, 'pass');
  assert.equal(ruleOf(light, 'FR-07').level, 'warning');
  near(ruleOf(light, 'FR-07').marginMin, -30, 1e-9);
  near(ruleOf(light, 'FR-07').value, 8.5, 1e-9);

  // water and battery follow the same arithmetic
  const waterLeft = 4.536 - 8.5 * 3600 * (144 + 92.9) / 2.45e6;
  near(ruleOf(light, 'FR-09').marginMin, waterLeft / ((422 + 92.9) / 2.45e6 * 60) - 30, 1e-6);
  near(ruleOf(light, 'FR-08').marginMin, (756 - 8.5 * 80) / 80 * 60 - 30, 1e-6);
});

test('oxygen rule is checked at every point: the far end of the walk is the tightest', () => {
  const r = simulate(outAndBack(3000, { workMin: 240, effort: 'heavy' }), {}, SUN);
  const fr2 = ruleOf(r, 'FR-02');
  const far = r.samples.filter((s) => s.stepIndex === 1)[1];    // end of the work step, 3 km out
  const emerg = ratesAt(422, {});
  near(fr2.marginMin, (far.o2Kg / emerg.o2KgS - far.homeS - 1800) / 60, 1e-9);
  near(fr2.marginMin, Math.min(...r.samples.map((s) => s.o2MarginMin)), 1e-9);
  assert.equal(fr2.stepIndex, 1);
  // hand arithmetic for that point
  const o2Far = 0.771 - (3 / 3.3) * (352 * 2.56e-4 + 0.005) - 4 * (530 * 2.56e-4 + 0.005);
  near(far.o2Kg, o2Far, 1e-9);
  const homeMin = 3000 / (3.3 / 3.6) / 60;
  near(fr2.marginMin, o2Far / ((422 * 2.56e-4 + 0.005) / 60) - homeMin - 30, 1e-6);
});

test('verdict names the rule with the smallest margin', () => {
  for (const plan of [outAndBack(1000), outAndBack(2500, { workMin: 200 }), outAndBack(5000), outAndBack(600, { workMin: 420, effort: 'heavy' })]) {
    const r = simulate(plan, {}, SUN);
    const withMargin = r.rules.filter((x) => typeof x.marginMin === 'number');
    assert.ok(withMargin.length >= 6);
    const smallest = withMargin.reduce((a, b) => (b.marginMin < a.marginMin ? b : a));
    assert.equal(r.verdict.limiting, smallest.id);
    near(r.verdict.marginMin, smallest.marginMin, 1e-12);
    assert.equal(r.verdict.go, !r.rules.some((x) => x.level === 'warning'));
    assert.deepEqual(r.verdict.blocking, r.rules.filter((x) => x.level === 'warning').map((x) => x.id));
    assert.equal(typeof r.verdict.text, 'string');
  }
  assert.equal(simulate(outAndBack(1000), {}, SUN).verdict.limiting, 'FR-01');
  assert.equal(simulate(outAndBack(5000), {}, SUN).verdict.limiting, 'FR-01');
});

test('env.homeTimeS overrides the default walk-home estimate', () => {
  const plan = outAndBack(1000, { workMin: 10 });
  const base = simulate(plan, {}, SUN);
  near(ruleOf(base, 'FR-01').value, 1000 / (3.3 / 3.6) / 60, 1e-6);
  const calls = [];
  const env = { ...SUN, homeTimeS: (lat, lon) => { calls.push([lat, lon]); return 4000; } };
  const r = simulate(plan, {}, env);
  assert.equal(calls.length, r.samples.length);
  assert.ok(r.samples.every((s) => s.homeS === 4000));
  near(ruleOf(r, 'FR-01').value, 4000 / 60, 1e-9);
  assert.equal(ruleOf(r, 'FR-01').level, 'warning');
  assert.equal(r.steps[2].homeEndS, 4000);
  // oxygen margin moves by exactly the extra home time
  const k = 60;
  near(base.samples[k].o2MarginMin - r.samples[k].o2MarginMin, (4000 - base.samples[k].homeS) / 60, 1e-9);
  // a place the terrain model cannot get home from is a failure, not a crash
  const lost = simulate(plan, {}, { homeTimeS: () => Infinity });
  assert.equal(ruleOf(lost, 'FR-01').level, 'warning');
  assert.equal(ruleOf(lost, 'FR-02').level, 'warning');
  assert.equal(lost.verdict.go, false);
});

test('default walk-home time: retrace on the way out, carry on along the plan on the way back', () => {
  const r = simulate(outAndBack(1000), {}, {});
  const v = 3.3 / 3.6;
  near(r.samples[50].homeS, 500 / v, 1e-6);                     // 500 m out
  near(r.samples[100].homeS, 1000 / v, 1e-6);                   // far end
  near(r.samples[101 + 70].homeS, 300 / v, 1e-6);               // 700 m into the return, 300 m to go
  near(r.samples[r.samples.length - 1].homeS, 0, 1e-6);
  // a plan that stops away from the refuge can only retrace
  const oneWay = simulate({ refuge: REFUGE, steps: [walk('A', leg(REFUGE, 1000))] }, {}, {});
  near(oneWay.samples[100].homeS, 1000 / v, 1e-6);
});

test('optional rules appear only when their data is supplied', () => {
  const plan = outAndBack(1000);
  const bare = simulate(plan, {}, {});
  assert.deepEqual(bare.rules.map((x) => x.id), ['FR-01', 'FR-02', 'FR-03', 'FR-04', 'FR-05', 'FR-07', 'FR-08', 'FR-09']);

  const farLat = REFUGE.lat + 600 / M_PER_DEG;
  const env = {
    ...SUN,
    visibleFromRefuge: (lat) => lat < farLat,                   // hidden beyond 600 m
    looseAt: (lat) => lat > REFUGE.lat + 895 / M_PER_DEG,       // loose beyond 900 m
    spaceWeather: { marsImpactWithinDays: null, note: 'Quiet sun.' },
  };
  const full = simulate(plan, {}, env);
  assert.deepEqual(full.rules.map((x) => x.id),
    ['FR-01', 'FR-02', 'FR-03', 'FR-04', 'FR-05', 'FR-06', 'FR-07', 'FR-08', 'FR-09', 'FR-10', 'FR-11']);
  const fr6 = ruleOf(full, 'FR-06');
  assert.equal(fr6.level, 'advisory');
  near(fr6.value, 800, 20.001);                                 // 400 m out of sight each way
  assert.match(fr6.text, /out of sight/);
  assert.equal(ruleOf(full, 'FR-11').level, 'advisory');
  near(ruleOf(full, 'FR-11').value, 200, 20.001);
  assert.equal(ruleOf(full, 'FR-10').level, 'pass');
  assert.ok(full.verdict.go, 'advisories do not block the walk');

  const storm = (days) => ruleOf(simulate(plan, {}, { spaceWeather: { marsImpactWithinDays: days, note: '' } }), 'FR-10').level;
  assert.equal(storm(1), 'warning');
  assert.equal(storm(2), 'warning');
  assert.equal(storm(3), 'pass');
  assert.equal(storm(null), 'pass');
  assert.equal(simulate(plan, {}, { spaceWeather: { marsImpactWithinDays: 0.5 } }).verdict.go, false);

  const clear = simulate(plan, {}, { visibleFromRefuge: () => true, looseAt: () => false });
  assert.equal(ruleOf(clear, 'FR-06').level, 'pass');
  assert.equal(ruleOf(clear, 'FR-11').level, 'pass');
});

test('every rule has the documented shape and a plain sentence', () => {
  const r = simulate(outAndBack(2000, { workMin: 30, proven: false }), {}, {
    ...SUN, visibleFromRefuge: () => false, looseAt: () => true, spaceWeather: { marsImpactWithinDays: 1, note: 'CME on the way.' },
  });
  const levels = new Set(['pass', 'advisory', 'caution', 'warning']);
  for (const x of r.rules) {
    assert.match(x.id, /^FR-\d\d$/);
    assert.ok(x.title.length > 3);
    assert.ok(levels.has(x.level), x.id);
    assert.ok(x.text.length > 10 && /\.$/.test(x.text) && !/undefined|NaN/.test(x.text), `${x.id}: ${x.text}`);
    assert.ok(x.stepIndex === null || Number.isInteger(x.stepIndex));
    assert.ok(Array.isArray(x.segments));
    for (const s of x.segments) {
      assert.ok(Number.isInteger(s.stepIndex) && s.toDistM >= s.fromDistM, x.id);
    }
    assert.equal(typeof x.units, 'string');
  }
  for (const s of r.steps) {
    assert.match(s.lmst0, /^\d\d:\d\d$/);
    assert.match(s.lmst1, /^\d\d:\d\d$/);
    assert.ok(s.t1S >= s.t0S);
  }
  assert.ok(r.steps[0].flags.includes('FR-05') && r.steps[0].flags.includes('FR-06') && r.steps[0].flags.includes('FR-11'));
});

test('consumables add up and the result is deterministic', () => {
  const plan = outAndBack(2400, { slopeDeg: 3, workMin: 95, effort: 'heavy' });
  const a = simulate(plan, { speedKmh: 3.0, o2StartKg: 0.7 }, SUN);
  const b = simulate(plan, { speedKmh: 3.0, o2StartKg: 0.7 }, SUN);
  assert.deepEqual(a, b);
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.deepEqual(a.consumables.map((x) => x.id), ['o2', 'co2', 'water', 'battery']);
  for (const x of a.consumables) {
    near(x.start - x.used, x.end, 1e-9);
    assert.ok(['ok', 'caution', 'warning'].includes(x.state));
    assert.ok(x.title && x.units && x.reserve >= 0);
  }
  assert.equal(a.consumables[0].start, 0.7);
  // step ends chain to the totals
  const last = a.steps[a.steps.length - 1];
  near(last.o2EndKg, a.consumables[0].end, 1e-12);
  near(last.co2Kg, a.consumables[1].end, 1e-12);
  near(last.waterEndKg, a.consumables[2].end, 1e-12);
  near(last.battEndWh, a.consumables[3].end, 1e-12);
  near(last.t1S, a.totals.durS, 1e-9);
  near(a.steps.reduce((s, x) => s + x.distM, 0), a.totals.distM, 1e-9);
  // carbon dioxide tracks metabolic oxygen at RQ 0.90
  const leak = (a.totals.durS / 3600) * 0.005;
  near(a.consumables[1].produced, (a.consumables[0].used - leak) * 1.2375, 1e-9);
  // duration range: low is the plan, high slows walking only
  const walkS = a.steps.filter((s) => s.type === 'walk').reduce((s, x) => s + (x.t1S - x.t0S), 0);
  assert.equal(a.totals.durLowS, a.totals.durS);
  near(a.totals.durHighS, a.totals.durS + walkS * 0.375, 1e-6);
  assert.ok(a.totals.rangeBasis.length > 20);
});

test('user parameters change the answer in the expected direction', () => {
  const plan = outAndBack(2000, { workMin: 60 });
  const base = simulate(plan, {}, SUN);
  const slow = simulate(plan, { speedKmh: 2 }, SUN);
  assert.ok(slow.totals.durS > base.totals.durS);
  near(slow.totals.durS, 4000 / (2 / 3.6) + 3600, 1e-6);
  const bigReserve = simulate(plan, { reserveMin: 60 }, SUN);
  near(ruleOf(base, 'FR-02').marginMin - ruleOf(bigReserve, 'FR-02').marginMin, 30, 1e-9);
  near(ruleOf(base, 'FR-03').marginMin - ruleOf(bigReserve, 'FR-03').marginMin, 30, 1e-9);
  assert.equal(ruleOf(simulate(plan, { emergencyReturnMin: 30 }, SUN), 'FR-01').level, 'warning');
  // junk overrides are ignored rather than poisoning the run
  near(simulate(plan, { speedKmh: NaN, reserveMin: undefined }, SUN).totals.durS, base.totals.durS, 1e-9);
});
