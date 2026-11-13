import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NASA, WALKBACK_FACTOR, DEFAULTS, MARS_HOUR,
  buildTimeline, positionAt, marginAt, reachAt, leaveByAt, analyse,
  pointAtChain, routeSlopes, legStats, bearingDeg, clockAt, doseMsv, marsLocalHours, hoursToClock, indexAtChain, sliceRoute,
} from '../js/model.js';

const p = { ...DEFAULTS };
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

test('walk-back factor comes from the two NASA metabolic rates', () => {
  near(WALKBACK_FACTOR, 2505 / 1030);
  assert.ok(WALKBACK_FACTOR > 2.4 && WALKBACK_FACTOR < 2.5);
});

test('timeline: out, work, back', () => {
  const tl = buildTimeline({ baseChain: 0, stops: [{ chain: 3300, dwellMin: 60 }] }, p);
  near(tl.turnT, 2);   // 1 h walk at 3.3 km/h + 1 h work
  near(tl.endT, 3);
  assert.deepEqual(tl.segs.map((s) => s.kind), ['walk', 'work', 'return']);
  near(positionAt(tl, 0.5).chain, 1650);
  near(positionAt(tl, 1.5).chain, 3300);
  near(positionAt(tl, 2.5).chain, 1650);
});

test('at the refuge with a full tank, oxygen margin is supply minus reserve', () => {
  const m = marginAt(p, 0, 0, 0);
  near(m.o2H, p.o2StartKg / NASA.o2WorkKgH - 0.5);
  assert.equal(m.homeM, 0);
});

test('margin shrinks with distance at the emergency rate', () => {
  const a = marginAt(p, 0, 1, 0);
  const b = marginAt(p, 0, 1, 3300);
  // 1 h nominal walk -> 1.5 h slow walk, charged at the walk-back factor
  near(a.o2H - b.o2H, 1.5 * WALKBACK_FACTOR);
  near(a.dayH - b.dayH, 1.5);
});

test('reach is the distance where margin hits zero', () => {
  for (const t of [0, 2, 5]) {
    const r = reachAt(p, t);
    near(marginAt(p, 0, t, r).h, 0, 1e-6);
  }
  assert.equal(reachAt(p, 100), 0);
});

test('leave-by is the time where margin at that spot hits zero', () => {
  const lb = leaveByAt(p, 0, 1500);
  near(marginAt(p, 0, lb.t, 1500).h, 0);
});

test('daylight becomes the limit with a late start', () => {
  const late = { ...p, startClock: '16:00' };
  assert.equal(marginAt(late, 0, 0, 1000).limiting, 'daylight');
  near(marginAt(late, 0, 0, 0).dayH, (18 + 51 / 60 - 16) * MARS_HOUR - 0.5);
});

test('a short plan holds and a far-too-long one breaks', () => {
  const ok = analyse({ baseChain: 0, stops: [{ chain: 1000, dwellMin: 30 }] }, p);
  assert.equal(ok.ok, true);
  assert.ok(ok.tight.m.h > 0);
  const bad = analyse({ baseChain: 0, stops: [{ chain: 1000, dwellMin: 600 }] }, p);
  assert.equal(bad.ok, false);
  assert.equal(bad.breakAt.seg.kind, 'work');
  assert.ok(Math.abs(marginAt(p, 0, bad.breakAt.t, bad.breakAt.chain).h) < 0.01);
});

test('route helpers', () => {
  const route = [[0, 0, 0, 0], [0.001, 0, 0, 10], [0.002, 0, 10, 24.142], [0.003, 0, 10, 34.142]];
  near(pointAtChain(route, 5).lon, 0.0005);
  near(pointAtChain(route, 999).chain, 34.142);
  const s = routeSlopes(route, 10);
  near(s[0], 0);
  near(s[1], 45, 0.01);
  const leg = legStats(route, s, 0, 34.142);
  near(leg.climbM, 10);
  near(leg.dropM, 0);
  const back = legStats(route, s, 34.142, 0);
  near(back.climbM, 0);
  near(back.dropM, 10);
  near(bearingDeg({ lon: 0, lat: 0 }, { lon: 1, lat: 0 }), 90);
  near(bearingDeg({ lon: 0, lat: 0 }, { lon: 0, lat: -1 }), 180);
});

test('clock and dose', () => {
  assert.equal(clockAt(p, 0), '09:00');
  assert.equal(clockAt(p, MARS_HOUR), '10:00');
  near(doseMsv(8), 0.67 / 3);
});

test('Mars local time: Curiosity landed mid-afternoon at Gale', () => {
  // Touchdown 2012-08-06 05:17:57 UTC at 137.44 E. NASA gives the landing as about 15:00 local mean solar time.
  const h = marsLocalHours(Date.UTC(2012, 7, 6, 5, 17, 57), 137.4417);
  assert.ok(h > 14.7 && h < 15.3, `got ${hoursToClock(h)}`);
  assert.equal(hoursToClock(9.5), '09:30');
  assert.equal(hoursToClock(-0.5), '23:30');
});

test('a sol later the Mars clock reads the same', () => {
  const t0 = Date.UTC(2026, 10, 13, 12, 0, 0);
  const a = marsLocalHours(t0, 137.4);
  const b = marsLocalHours(t0 + NASA.solHours * 3600000, 137.4);
  assert.ok(Math.abs(a - b) < 0.001 || Math.abs(a - b) > 23.999);
});

test('route slicing uses the index lookup', () => {
  const route = [[0, 0, 0, 0], [0, 0, 1, 10], [0, 0, 2, 20], [0, 0, 3, 30]];
  assert.equal(indexAtChain(route, 0), 0);
  assert.equal(indexAtChain(route, 19.9), 1);
  assert.equal(indexAtChain(route, 99), 3);
  assert.deepEqual(sliceRoute(route, 5, 25).map((q) => q.chain), [5, 10, 20, 25]);
});
