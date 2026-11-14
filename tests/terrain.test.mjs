import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { gzipSync, gunzipSync } from 'node:zlib';
import {
  MARS_RADIUS_M, UNREACHED,
  decodeDem, loadDem, gridFromBounds, cellOf, latLonOf, elevAt, sampleLine,
  gradient, slopeAspect, roughness, hillshade, castShadow, viewshed,
  costDistance, pathFrom, isochroneMask,
} from '../js/terrain.js';
import { handle } from '../js/terrain.worker.js';

const DEG = Math.PI / 180;
const M_LAT = DEG * MARS_RADIUS_M;
const near = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);
const sum = (arr) => arr.reduce((s, v) => s + v, 0);

// A grid near Gale's latitude whose cells are exactly cellX by cellY metres. fn(col, row) -> elevation.
function makeGrid(w, h, cellX, cellY, fn = () => 0) {
  const north = -4.6;
  const west = 137.3;
  const south = north - (h * cellY) / M_LAT;
  const east = west + (w * cellX) / (M_LAT * Math.cos(((north + south) / 2) * DEG));
  const elev = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) elev[r * w + c] = fn(c, r);
  const g = gridFromBounds(w, h, [[south, west], [north, east]], elev, 0.1);
  near(g.dx, cellX, 1e-6);
  near(g.dy, cellY, 1e-6);
  g.dx = cellX;
  g.dy = cellY;
  return g;
}

// The encoder of the dem.i16.gz spec: first column against the row above, the rest against the left.
function encodeDelta(q, w, h) {
  const s = new Int16Array(w * h);   // assignment wraps to int16
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      const i = r * w + c;
      s[i] = c === 0 ? q[i] - (r ? q[i - w] : 0) : q[i] - q[i - 1];
    }
  }
  return s;
}

const flatSpeed = (v) => new Float32Array(181).fill(v);

// Smooth bumpy ground for comparisons against brute force.
const bumps = (c, r) => 8 * Math.sin(c * 0.21) * Math.cos(r * 0.17) + 5 * Math.sin(c * 0.09 + r * 0.13) + 3 * Math.cos(r * 0.4 - c * 0.3);

function bilinear(g, x, y) {
  const c0 = Math.min(Math.floor(x), g.w - 2);
  const r0 = Math.min(Math.floor(y), g.h - 2);
  const fx = x - c0;
  const fy = y - r0;
  const z = g.elev;
  const i = r0 * g.w + c0;
  return (z[i] * (1 - fx) + z[i + 1] * fx) * (1 - fy) + (z[i + g.w] * (1 - fx) + z[i + g.w + 1] * fx) * fy;
}

// ---- decode ----

test('decodeDem undoes the delta coding, including a negative jump and int16 wrap', () => {
  const w = 5;
  const h = 4;
  const q = Int16Array.from([
    30000, 32000, -32000, -32768, 32767,   // +2000, then -64000 (wraps), -768, +65535 (wraps)
    -30000, -29999, 0, 5, -5,              // row start jumps -60000 (wraps)
    12, 12, 12, 12, 12,
    -1, 0, 1, 32767, -32768,
  ]);
  const stored = encodeDelta(q, w, h);
  assert.equal(stored[2], wrap(-64000));
  assert.equal(stored[5], wrap(-60000));
  const meta = { file: 'dem.i16.gz', w, h, cell_m: 6, bounds: [[-4.8, 137.3], [-4.7, 137.4]], scale_m: 0.1, offset_m: -4500 };
  const g = decodeDem(meta, stored);
  assert.equal(g.w, w);
  assert.equal(g.h, h);
  assert.equal(g.scale_m, 0.1);
  assert.deepEqual(g.bounds, meta.bounds);
  assert.ok(g.elev instanceof Float32Array);
  for (let i = 0; i < q.length; i++) near(g.elev[i], q[i] * 0.1 - 4500, 1e-3);

  // Same bytes handed over as an ArrayBuffer and as a byte view at an odd offset.
  const bytes = new Uint8Array(stored.buffer);
  const shifted = new Uint8Array(bytes.length + 1);
  shifted.set(bytes, 1);
  assert.deepEqual(decodeDem(meta, stored.buffer).elev, g.elev);
  assert.deepEqual(decodeDem(meta, shifted.subarray(1)).elev, g.elev);

  assert.throws(() => decodeDem(meta, stored.subarray(0, 10)), /expected 20/);
  const withHole = decodeDem({ ...meta, nodata: -32768 }, stored);
  assert.ok(Number.isNaN(withHole.elev[3]) && Number.isNaN(withHole.elev[19]));
  near(withHole.elev[4], 3276.7 - 4500, 1e-3);
});

function wrap(v) {
  return (v << 16) >> 16;
}

test('decodeDem: cell sizes come from the bounds and the Mars radius', () => {
  const w = 3200;
  const h = 1552;
  const south = -4.78;
  const north = south + (h * 6) / M_LAT;
  const west = 137.3;
  const east = west + (w * 6.5) / (M_LAT * Math.cos(((south + north) / 2) * DEG));
  const g = gridFromBounds(w, h, [[south, west], [north, east]], new Float32Array(0));
  near(g.dy, 6, 1e-9);
  near(g.dx, 6.5, 1e-9);
  near(M_LAT, 59274.7, 0.1);   // metres per degree of latitude on Mars
});

test('loadDem fetches the header, gunzips the file next to it and decodes', async () => {
  const w = 40;
  const h = 30;
  const q = new Int16Array(w * h);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(2000 * Math.sin(i * 0.37) + 20000 * Math.cos(i * 0.011));
  const meta = { file: 'dem.i16.gz', w, h, cell_m: 6, bounds: [[-4.8, 137.3], [-4.79, 137.32]], scale_m: 0.1, offset_m: -4000 };
  const gz = gzipSync(Buffer.from(encodeDelta(q, w, h).buffer));
  const raw = new Uint8Array(encodeDelta(q, w, h).buffer);
  const asked = [];
  const server = (file) => async (url) => {
    asked.push(url);
    if (url.includes('dem.json')) return new Response(JSON.stringify(meta));
    if (url.includes('dem.i16.gz')) return new Response(file);
    return new Response('', { status: 404 });
  };
  const g = await loadDem('data/terrain/dem.json?v=2', server(gz));
  assert.deepEqual(asked, ['data/terrain/dem.json?v=2', 'data/terrain/dem.i16.gz']);
  for (let i = 0; i < q.length; i += 7) near(g.elev[i], q[i] * 0.1 - 4000, 1e-3);
  // A server that already removed the gzip layer.
  const g2 = await loadDem('https://example.test/t/dem.json', server(raw));
  assert.equal(asked[3], 'https://example.test/t/dem.i16.gz');
  assert.deepEqual(g2.elev, g.elev);
  await assert.rejects(loadDem('missing.txt', server(gz)), /HTTP 404/);
});

// The real file is built by tools/build_terrain.py; its header lists a few cells to check a decoder against.
const shippedMeta = new URL('../data/terrain/dem.json', import.meta.url);
test('the shipped DEM, when present, decodes to the check values in its header', { skip: !existsSync(shippedMeta) }, (t) => {
  const meta = JSON.parse(readFileSync(shippedMeta, 'utf8'));
  const g = decodeDem(meta, gunzipSync(readFileSync(new URL(meta.file, shippedMeta))));
  assert.equal(g.elev.length, meta.w * meta.h);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < g.elev.length; i++) { if (g.elev[i] < lo) lo = g.elev[i]; if (g.elev[i] > hi) hi = g.elev[i]; }
  t.diagnostic(`${g.w} x ${g.h} cells of ${g.dx.toFixed(2)} x ${g.dy.toFixed(2)} m, ${lo.toFixed(1)} to ${hi.toFixed(1)} m`);
  if (typeof meta.min_m === 'number') near(lo, meta.min_m, 0.051);
  if (typeof meta.max_m === 'number') near(hi, meta.max_m, 0.051);
  for (const c of meta.check ?? []) near(g.elev[c.row * g.w + c.col], c.elev_m, 0.051);
  assert.ok(Math.abs(g.dx - meta.cell_m) < 0.1 && Math.abs(g.dy - meta.cell_m) < 0.1);
});

// ---- coordinates ----

test('cellOf and latLonOf agree; rows count from the north, columns from the west', () => {
  const g = makeGrid(13, 7, 6, 5);
  const [[south, west], [north, east]] = g.bounds;
  for (const [col, row] of [[0, 0], [12, 6], [5, 3], [12, 0]]) {
    const p = latLonOf(g, col, row);
    assert.deepEqual(cellOf(g, p.lat, p.lon), { col, row, inside: true });
  }
  const nw = latLonOf(g, 0, 0);
  near(nw.lat, north - (north - south) / 14, 1e-12);
  near(nw.lon, west + (east - west) / 26, 1e-12);
  assert.ok(latLonOf(g, 0, 6).lat < nw.lat);
  assert.ok(latLonOf(g, 12, 0).lon > nw.lon);
  assert.equal(cellOf(g, north + 1e-6, west + 1e-6).inside, false);
  assert.equal(cellOf(g, south + 1e-9, east + 1e-6).inside, false);
  assert.equal(cellOf(g, NaN, west).inside, false);
});

test('elevAt is bilinear between cell centres and NaN outside', () => {
  const g = makeGrid(4, 3, 6, 6, (c, r) => [[10, 20, 0, 0], [30, 60, 0, 0], [0, 0, 0, 8]][r][c]);
  const at = (col, row) => latLonOf(g, col, row);
  near(elevAt(g, at(1, 1).lat, at(1, 1).lon), 60, 1e-4);
  // Corner shared by cells (0,0) (1,0) (0,1) (1,1): the mean of the four.
  near(elevAt(g, at(0.5, 0.5).lat, at(0.5, 0.5).lon), 30, 1e-4);
  // Halfway between two centres on a row.
  near(elevAt(g, at(0.5, 0).lat, at(0.5, 0).lon), 15, 1e-4);
  near(elevAt(g, at(0.25, 1).lat, at(0.25, 1).lon), 37.5, 1e-4);
  // Between the outer centre and the edge the outer value is held.
  near(elevAt(g, g.bounds[0][0], g.bounds[1][1]), 8, 1e-4);
  near(elevAt(g, g.bounds[1][0], g.bounds[0][1]), 10, 1e-4);
  assert.ok(Number.isNaN(elevAt(g, g.bounds[1][0] + 1e-6, g.bounds[0][1])));
  assert.ok(Number.isNaN(elevAt(g, at(1, 1).lat, g.bounds[1][1] + 1e-6)));
});

test('sampleLine: evenly spaced, ends included, distance in metres, elevation from the grid', () => {
  const g = makeGrid(50, 40, 6, 5, (c) => c * 0.6);   // rises 0.1 m per metre toward the east
  const a = latLonOf(g, 5, 10);
  const b = latLonOf(g, 35, 30);                       // 180 m east, 100 m south
  const total = Math.hypot(180, 100);
  const pts = sampleLine(g, a, b, 10);
  assert.equal(pts.length, Math.ceil(total / 10) + 1);
  assert.deepEqual({ lat: pts[0].lat, lon: pts[0].lon, distM: pts[0].distM }, { ...a, distM: 0 });
  const last = pts[pts.length - 1];
  near(last.lat, b.lat, 1e-12);
  near(last.lon, b.lon, 1e-12);
  near(last.distM, total, 1e-6);
  for (let i = 1; i < pts.length; i++) {
    const step = pts[i].distM - pts[i - 1].distM;
    assert.ok(step <= 10 + 1e-9 && step > 9);
    near(pts[i].elev, 3 + pts[i].distM * (180 / total) * 0.1, 1e-3);
  }
  assert.equal(sampleLine(g, a, a, 10).length, 1);
  assert.equal(sampleLine(g, a, b, 1000).length, 2);
  const off = sampleLine(g, a, { lat: a.lat, lon: g.bounds[1][1] + 0.001 }, 10);
  assert.ok(Number.isNaN(off[off.length - 1].elev));
});

// ---- slope, aspect, roughness, hillshade ----

test('slope and aspect of tilted planes: angle and all four compass directions', () => {
  const tilt = Math.tan(12 * DEG);
  // East is +col * dx, north is -row * dy. Each plane falls toward the named direction.
  const planes = [
    { name: 'north', aspect: 0, fn: (c, r) => 100 + tilt * (r * 5) },
    { name: 'east', aspect: 90, fn: (c) => 100 - tilt * (c * 6) },
    { name: 'south', aspect: 180, fn: (c, r) => 100 - tilt * (r * 5) },
    { name: 'west', aspect: 270, fn: (c) => 100 + tilt * (c * 6) },
  ];
  for (const p of planes) {
    const g = makeGrid(9, 8, 6, 5, p.fn);
    const { slope, aspect } = slopeAspect(g);
    assert.ok(slope instanceof Float32Array && aspect instanceof Float32Array);
    for (let i = 0; i < slope.length; i++) {   // border cells included
      near(slope[i], 12, 2e-3);
      const diff = Math.abs(((aspect[i] - p.aspect + 540) % 360) - 180);
      assert.ok(diff < 0.05, `${p.name}: aspect ${aspect[i]} at ${i}`);
    }
  }
});

test('slope and aspect on a diagonal plane with unequal cell sizes', () => {
  const a = 0.2;    // rise per metre east
  const b = -0.1;   // rise per metre north
  const g = makeGrid(10, 10, 6, 5, (c, r) => a * c * 6 + b * (-r * 5));
  const { slope, aspect } = slopeAspect(g);
  const wantSlope = Math.atan(Math.hypot(a, b)) / DEG;
  const wantAspect = (Math.atan2(-a, -b) / DEG + 360) % 360;   // downhill: west and a little north
  near(wantAspect, 296.565, 1e-3);
  for (let i = 0; i < slope.length; i++) {
    near(slope[i], wantSlope, 2e-3);
    near(aspect[i], wantAspect, 0.02);
  }
});

test('flat ground: slope 0, no aspect, no roughness', () => {
  const g = makeGrid(6, 5, 6, 6, () => -4321.5);
  const { slope, aspect } = slopeAspect(g);
  assert.ok(slope.every((v) => v === 0));
  assert.ok(aspect.every((v) => Number.isNaN(v)));
  assert.ok(roughness(g).every((v) => v === 0));
});

test('roughness is the Riley ruggedness index', () => {
  const spike = makeGrid(7, 7, 6, 6, (c, r) => (c === 3 && r === 3 ? 2 : 0));
  const tri = roughness(spike);
  near(tri[3 * 7 + 3], Math.sqrt(8) * 2, 1e-5);
  near(tri[3 * 7 + 4], 2, 1e-6);
  near(tri[2 * 7 + 2], 2, 1e-6);
  assert.equal(tri[0], 0);
  // A plane rising 0.1 per metre east on 6 m cells: six neighbours differ by 0.6 m.
  const plane = makeGrid(7, 7, 6, 6, (c) => c * 0.6);
  const t2 = roughness(plane);
  near(t2[3 * 7 + 3], Math.sqrt(6) * 0.6, 1e-5);
  assert.ok(t2[0] > 0 && Number.isFinite(t2[0]));
});

test('hillshade: flat value, facing slopes brighter, no light from below the horizon', () => {
  const flat = makeGrid(5, 5, 6, 6);
  assert.ok(hillshade(flat, 315, 45).every((v) => v === 180));    // 255 * sin(45 deg)
  assert.ok(hillshade(flat, 10, 90).every((v) => v === 255));
  assert.ok(hillshade(flat, 10, 0).every((v) => v === 0));
  assert.ok(hillshade(flat, 10, -5).every((v) => v === 0));
  const tilt = Math.tan(30 * DEG);
  const faceEast = makeGrid(5, 5, 6, 6, (c) => -tilt * c * 6);
  const faceWest = makeGrid(5, 5, 6, 6, (c) => tilt * c * 6);
  const faceNorth = makeGrid(5, 5, 6, 6, (c, r) => tilt * r * 6);
  // Sun in the east, 60 deg up: square onto a 30 deg east-facing slope.
  assert.ok(hillshade(faceEast, 90, 60).every((v) => v === 255));
  assert.ok(hillshade(faceWest, 90, 50).every((v) => v === Math.round(255 * Math.cos(70 * DEG))));
  assert.ok(hillshade(faceNorth, 0, 60).every((v) => v === 255));
  assert.ok(hillshade(faceNorth, 180, 20).every((v) => v === 0));   // sun behind the slope
});

// ---- cast shadow ----

test('castShadow: a wall throws a shadow of the right length on the side away from the sun', () => {
  const wallCol = 30;
  const g = makeGrid(61, 9, 1, 1, (c) => (c === wallCol ? 10 : 0));
  const el = 30;                                   // shadow length 10 / tan(30) = 17.3 m
  const len = Math.floor(10 / Math.tan(el * DEG));
  const row = (mask, r) => Array.from(mask.subarray(r * 61, r * 61 + 61));

  const sunEast = castShadow(g, 90, el);
  const sunWest = castShadow(g, 270, el);
  for (let r = 0; r < 9; r++) {
    const e = row(sunEast, r);
    const wst = row(sunWest, r);
    for (let c = 0; c < 61; c++) {
      const westOfWall = wallCol - c;
      assert.equal(e[c], westOfWall >= 1 && westOfWall <= len ? 1 : 0, `sun east, col ${c}`);
      assert.equal(wst[c], -westOfWall >= 1 && -westOfWall <= len ? 1 : 0, `sun west, col ${c}`);
    }
  }
  assert.equal(len, 17);

  // Lower sun, longer shadow.
  const low = row(castShadow(g, 90, 10), 4);
  assert.equal(sum(low), wallCol);                 // 56 m long: everything west of the wall
  // Sun overhead: nothing. Sun on or below the horizon: everything.
  assert.equal(sum(castShadow(g, 90, 90)), 0);
  assert.equal(sum(castShadow(g, 123, 0)), g.w * g.h);
  assert.equal(sum(castShadow(g, 123, -3)), g.w * g.h);
});

test('castShadow: north and south sun, and unequal cell sizes', () => {
  const wallRow = 20;
  const g = makeGrid(7, 41, 6, 5, (c, r) => (r === wallRow ? 30 : 0));
  const len = Math.floor(30 / Math.tan(40 * DEG) / 5);   // 35.75 m = 7 rows of 5 m
  assert.equal(len, 7);
  const sunNorth = castShadow(g, 0, 40);
  const sunSouth = castShadow(g, 180, 40);
  for (let r = 0; r < 41; r++) {
    const south = r - wallRow;
    assert.equal(sunNorth[r * 7 + 3], south >= 1 && south <= len ? 1 : 0, `sun north, row ${r}`);
    assert.equal(sunSouth[r * 7 + 3], -south >= 1 && -south <= len ? 1 : 0, `sun south, row ${r}`);
  }
});

test('castShadow: a diagonal sun puts the shadow of a block on the far corner side', () => {
  const g = makeGrid(41, 41, 1, 1, (c, r) => (Math.abs(c - 20) <= 1 && Math.abs(r - 20) <= 1 ? 6 : 0));
  // Sun in the south-east at 45 deg: shadow runs 6 m toward the north-west (lower col, lower row).
  const s = castShadow(g, 135, 45);
  assert.equal(s[17 * 41 + 17], 1);
  assert.equal(s[16 * 41 + 16], 1);
  assert.equal(s[12 * 41 + 12], 0);     // beyond the tip
  assert.equal(s[23 * 41 + 23], 0);     // sunward side
  assert.equal(s[17 * 41 + 23], 0);     // off to the side
  assert.equal(s[23 * 41 + 17], 0);
  assert.equal(s[20 * 41 + 20], 0);     // top of the block
  for (let i = 0; i < s.length; i++) {
    if (!s[i]) continue;
    const c = i % 41;
    const r = (i / 41) | 0;
    assert.ok(c <= 21 && r <= 21 && c >= 12 && r >= 12, `stray shadow at ${c},${r}`);
  }
});

// Reference: march from each cell toward the sun over bilinear ground.
function shadowBruteForce(g, azDeg, elDeg) {
  const out = new Uint8Array(g.w * g.h);
  const sx = Math.sin(azDeg * DEG) / g.dx;
  const sy = -Math.cos(azDeg * DEG) / g.dy;
  const step = 0.2 * Math.min(g.dx, g.dy);
  const rise = Math.tan(elDeg * DEG);
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      for (let t = step; ; t += step) {
        const x = c + sx * t;
        const y = r + sy * t;
        if (x < -1e-9 || x > g.w - 1 + 1e-9 || y < -1e-9 || y > g.h - 1 + 1e-9) break;
        if (bilinear(g, Math.max(0, x), Math.max(0, y)) > g.elev[r * g.w + c] + t * rise + 1e-3) { out[r * g.w + c] = 1; break; }
      }
    }
  }
  return out;
}

test('castShadow agrees with brute-force ray marching on bumpy ground', (t) => {
  const g = makeGrid(120, 90, 6, 5, bumps);
  // Sun along a grid axis: the sweep is exact. In between, the edge of a shadow can sit one cell off.
  for (const [az, el, limitPct] of [[0, 7, 0], [90, 8, 0], [180, 8, 0], [270, 6, 0], [75, 8, 3], [200, 15, 3], [45, 9, 3], [135, 10, 3], [20, 5, 3], [310, 12, 3]]) {
    const fast = castShadow(g, az, el);
    const slow = shadowBruteForce(g, az, el);
    let differ = 0;
    let awayFromEdge = 0;
    for (let i = 0; i < fast.length; i++) {
      if (fast[i] === slow[i]) continue;
      differ++;
      const c = i % g.w;
      const r = (i / g.w) | 0;
      let edge = false;
      for (let rr = Math.max(0, r - 2); rr <= Math.min(g.h - 1, r + 2); rr++) {
        for (let cc = Math.max(0, c - 2); cc <= Math.min(g.w - 1, c + 2); cc++) if (slow[rr * g.w + cc] !== slow[i]) edge = true;
      }
      if (!edge) awayFromEdge++;
    }
    const pct = (100 * differ) / fast.length;
    t.diagnostic(`sun az ${az} el ${el}: ${sum(slow)} cells shaded, ${pct.toFixed(2)} % differ from brute force`);
    assert.ok(sum(slow) > 500, 'the case must have real shadows');
    assert.ok(pct <= limitPct, `${pct} % of cells differ`);
    assert.equal(awayFromEdge, 0, 'differences sit on shadow edges only');
  }
});

// ---- viewshed ----

test('viewshed: a ridge hides the ground behind it, a higher observer sees over', () => {
  const w = 61;
  const g = makeGrid(w, 21, 1, 1, (c) => (c === 30 ? 10 : 0));
  const obs = latLonOf(g, 5, 10);
  const low = viewshed(g, obs.lat, obs.lon, 2, 0);
  assert.ok(low instanceof Uint8Array);
  for (let r = 0; r < 21; r++) {
    for (let c = 0; c < w; c++) {
      assert.equal(low[r * w + c], c <= 30 ? 1 : 0, `col ${c} row ${r}`);
    }
  }
  // Eye at 50 m, ridge top 10 m, 25 m away: the sight line reaches the ground 6.25 m behind the ridge.
  const high = viewshed(g, obs.lat, obs.lon, 50, 0);
  const mid = (c) => high[10 * w + c];
  for (let c = 0; c <= 30; c++) assert.equal(mid(c), 1);
  for (let c = 31; c <= 36; c++) assert.equal(mid(c), 0, `col ${c} should still be hidden`);
  for (let c = 37; c < w; c++) assert.equal(mid(c), 1, `col ${c} should be revealed`);
  // A tall target behind the ridge shows over it: 12 m mast seen from 2 m, up to 31.25 m from the eye.
  const mast = viewshed(g, obs.lat, obs.lon, 2, 12);
  assert.equal(mast[10 * w + 36], 1);
  assert.equal(mast[10 * w + 37], 0);
  // Off the grid: nothing.
  assert.equal(sum(viewshed(g, g.bounds[1][0] + 1, obs.lon, 2, 0)), 0);
});

test('viewshed: every cell of open flat ground is covered, from any observer position', () => {
  const g = makeGrid(97, 53, 6, 5);
  for (const [c, r] of [[48, 26], [0, 0], [96, 52], [3, 40], [70, 1]]) {
    const o = latLonOf(g, c, r);
    assert.equal(sum(viewshed(g, o.lat, o.lon, 2, 0)), 97 * 53, `observer at ${c},${r}`);
  }
});

test('viewshed: symmetric ground gives a symmetric answer, and sight lines work both ways', () => {
  const w = 41;
  const h = 31;
  // Two ridges with gaps and a mound, mirrored left-right and top-bottom about the centre cell.
  const fn = (c, r) => {
    const x = Math.abs(c - 20);
    const y = Math.abs(r - 15);
    return (x === 8 && y > 3 ? 6 : 0) + (y === 9 && x < 5 ? 4 : 0) + 3 * Math.exp(-((x - 14) ** 2 + (y - 5) ** 2) / 8);
  };
  const g = makeGrid(w, h, 6, 6, fn);
  const o = latLonOf(g, 20, 15);
  const v = viewshed(g, o.lat, o.lon, 1.8, 0);
  const seen = sum(v);
  assert.ok(seen > 200 && seen < w * h - 100, `${seen} cells seen`);
  for (let r = 0; r < h; r++) {
    for (let c = 0; c < w; c++) {
      assert.equal(v[r * w + c], v[r * w + (w - 1 - c)], `left-right at ${c},${r}`);
      assert.equal(v[r * w + c], v[(h - 1 - r) * w + c], `top-bottom at ${c},${r}`);
    }
  }
  // Equal eye and target heights: A sees B exactly when B sees A.
  const ridge = makeGrid(61, 21, 1, 1, (c) => (c === 30 ? 10 : 0));
  const sees = (a, b) => {
    const p = latLonOf(ridge, a[0], a[1]);
    return viewshed(ridge, p.lat, p.lon, 2, 2)[b[1] * 61 + b[0]];
  };
  for (const [a, b, want] of [[[5, 10], [50, 10], 0], [[5, 10], [25, 3], 1], [[5, 4], [58, 17], 0], [[35, 2], [58, 18], 1], [[5, 10], [30, 10], 1]]) {
    assert.equal(sees(a, b), want);
    assert.equal(sees(b, a), want);
  }
});

// Reference: test the straight sight line to every cell centre over bilinear ground.
function viewshedBruteForce(g, oc, or, ho, ht) {
  const out = new Uint8Array(g.w * g.h);
  const z0 = g.elev[or * g.w + oc] + ho;
  for (let r = 0; r < g.h; r++) {
    for (let c = 0; c < g.w; c++) {
      const zt = g.elev[r * g.w + c] + ht;
      const n = Math.ceil(Math.max(Math.abs(c - oc), Math.abs(r - or)) * 5);
      let ok = 1;
      for (let k = 1; k < n && ok; k++) {
        const f = k / n;
        if (bilinear(g, oc + (c - oc) * f, or + (r - or) * f) > z0 + (zt - z0) * f + 1e-6) ok = 0;
      }
      out[r * g.w + c] = ok;
    }
  }
  return out;
}

test('viewshed is close to exact line-of-sight tests on bumpy ground', (t) => {
  const g = makeGrid(120, 90, 6, 5, bumps);
  for (const [oc, or, ho] of [[60, 45, 2], [10, 80, 2], [100, 20, 10]]) {
    const o = latLonOf(g, oc, or);
    const fast = viewshed(g, o.lat, o.lon, ho, 0);
    const slow = viewshedBruteForce(g, oc, or, ho, 0);
    let differ = 0;
    for (let i = 0; i < fast.length; i++) differ += fast[i] !== slow[i] ? 1 : 0;
    const pct = (100 * differ) / fast.length;
    t.diagnostic(`observer ${oc},${or} at ${ho} m: ${sum(slow)} of ${fast.length} cells visible, ${pct.toFixed(2)} % differ from exact`);
    assert.ok(sum(slow) > 300 && sum(slow) < fast.length - 300, 'the case must have both seen and hidden ground');
    assert.ok(pct < 3, `${pct} % of cells differ`);
  }
});

// ---- travel time ----

test('costDistance on flat ground: distance over speed along the axes, 8-direction error in between', () => {
  const w = 41;
  const g = makeGrid(w, 41, 6, 6);
  const src = latLonOf(g, 20, 20);
  const { time, prev } = costDistance(g, [src], { speedBySlope: flatSpeed(1.2) });
  assert.ok(time instanceof Float32Array && prev instanceof Int32Array);
  assert.equal(time[20 * w + 20], 0);
  assert.equal(prev[20 * w + 20], -1);
  for (let k = 1; k <= 20; k++) {
    near(time[20 * w + 20 + k], (k * 6) / 1.2, 1e-3);
    near(time[20 * w + 20 - k], (k * 6) / 1.2, 1e-3);
    near(time[(20 - k) * w + 20], (k * 6) / 1.2, 1e-3);
    near(time[(20 + k) * w + 20], (k * 6) / 1.2, 1e-3);
    near(time[(20 + k) * w + 20 - k], (k * 6 * Math.SQRT2) / 1.2, 1e-3);
  }
  // Anywhere else the 8-direction path is between 0 % and 8.24 % longer than the straight line.
  const worst = Math.cos(22.5 * DEG) + (Math.SQRT2 - 1) * Math.sin(22.5 * DEG);
  near(worst, 1.0824, 1e-4);
  let maxRatio = 0;
  for (let r = 0; r < 41; r++) {
    for (let c = 0; c < w; c++) {
      if (c === 20 && r === 20) continue;
      const a = Math.abs(c - 20);
      const b = Math.abs(r - 20);
      const straight = (6 * Math.hypot(a, b)) / 1.2;
      const octile = (6 * (Math.max(a, b) - Math.min(a, b) + Math.SQRT2 * Math.min(a, b))) / 1.2;
      near(time[r * w + c], octile, 1e-3);
      const ratio = time[r * w + c] / straight;
      assert.ok(ratio >= 1 - 1e-5 && ratio <= worst + 1e-5, `ratio ${ratio} at ${c},${r}`);
      maxRatio = Math.max(maxRatio, ratio);
    }
  }
  assert.ok(maxRatio > 1.08);
  assert.equal(sum(isochroneMask(time, 30)), [...time].filter((v) => v <= 30).length);
  assert.equal(isochroneMask(time, 4.99)[20 * w + 21], 0);
  assert.equal(isochroneMask(time, 5.01)[20 * w + 21], 1);
});

test('costDistance: unequal cell sizes use dx, dy and the true diagonal', () => {
  const w = 21;
  const g = makeGrid(w, 21, 6, 5);
  const { time } = costDistance(g, [latLonOf(g, 10, 10)], { speedBySlope: flatSpeed(1) });
  near(time[10 * w + 15], 30, 1e-3);
  near(time[15 * w + 10], 25, 1e-3);
  near(time[14 * w + 14], 4 * Math.hypot(6, 5), 1e-3);
  // Two sources: each cell gets the nearer one. Sources off the grid are ignored.
  const two = costDistance(g, [latLonOf(g, 0, 10), latLonOf(g, 20, 10), { lat: 0, lon: 0 }], { speedBySlope: flatSpeed(1) });
  near(two.time[10 * w + 3], 18, 1e-3);
  near(two.time[10 * w + 18], 12, 1e-3);
  assert.equal(two.prev[10 * w + 0], -1);
  assert.equal(two.prev[10 * w + 20], -1);
});

test('costDistance: a blocked wall forces a detour and paths never touch blocked cells', () => {
  const w = 21;
  const g = makeGrid(w, 21, 1, 1);
  const blocked = new Uint8Array(w * 21);
  for (let r = 0; r <= 15; r++) blocked[r * w + 10] = 1;       // wall on column 10, open below row 15
  const src = latLonOf(g, 5, 5);
  const dst = latLonOf(g, 15, 5);
  const open = costDistance(g, [src], { speedBySlope: flatSpeed(1) });
  near(open.time[5 * w + 15], 10, 1e-4);
  const { time, prev } = costDistance(g, [src], { speedBySlope: flatSpeed(1), blocked });
  // Round the end of the wall without cutting its corner: (5,5) -> (9,16) -> (10,16) -> (11,16) -> (15,5).
  near(time[5 * w + 15], 2 * (4 * Math.SQRT2 + 7) + 2, 1e-3);
  for (let r = 0; r <= 15; r++) {
    assert.equal(time[r * w + 10], Infinity);
    assert.equal(prev[r * w + 10], UNREACHED);
  }
  const path = pathFrom(g, prev, dst.lat, dst.lon);
  assert.deepEqual([path[0].col, path[0].row], [15, 5]);
  assert.deepEqual([path[path.length - 1].col, path[path.length - 1].row], [5, 5]);
  assert.ok(path.some((p) => p.col === 10 && p.row === 16));
  for (const p of path) assert.equal(blocked[p.row * w + p.col], 0);
});

test('costDistance: closed walls and corner-touching blocked cells cannot be crossed', () => {
  const w = 15;
  const g = makeGrid(w, 15, 1, 1);
  const diagonal = new Uint8Array(w * 15);
  for (let k = 0; k < 15; k++) diagonal[k * w + k] = 1;        // cells touch only at their corners
  const { time, prev } = costDistance(g, [latLonOf(g, 12, 2)], { speedBySlope: flatSpeed(1), blocked: diagonal });
  assert.equal(time[12 * w + 2], Infinity);
  near(time[1 * w + 14], Math.SQRT2 + 1, 1e-4);
  const far = latLonOf(g, 2, 12);
  assert.deepEqual(pathFrom(g, prev, far.lat, far.lon), []);
  assert.deepEqual(pathFrom(g, prev, 0, 0), []);               // off the grid
  assert.equal(isochroneMask(time, 1e9)[12 * w + 2], 0);
});

test('costDistance: uphill slower than downhill, and `toward` reverses the direction walked', () => {
  const w = 31;
  const g = makeGrid(w, 11, 1, 1, (c) => Math.tan(10 * DEG) * c);   // rises 10 deg toward the east
  const speed = new Float32Array(181);
  for (let d = 0; d <= 180; d++) speed[d] = d > 90 ? 0.5 : 1;        // 0.5 m/s on any climb
  const low = latLonOf(g, 0, 5);
  const iTop = 5 * w + 30;
  const out = costDistance(g, [low], { speedBySlope: speed });
  const home = costDistance(g, [low], { speedBySlope: speed, toward: true });
  near(out.time[iTop], 30 / 0.5, 1e-3);     // climbing away from the source
  near(home.time[iTop], 30 / 1, 1e-3);      // walking down to the source
  // From a source at the top it is the other way round.
  const high = latLonOf(g, 30, 5);
  near(costDistance(g, [high], { speedBySlope: speed }).time[5 * w], 30, 1e-3);
  near(costDistance(g, [high], { speedBySlope: speed, toward: true }).time[5 * w], 60, 1e-3);
});

test('costDistance: the speed table is read at the signed slope of the move, to the whole degree', () => {
  const w = 21;
  const g = makeGrid(w, 9, 1, 1, (c) => Math.tan(10 * DEG) * c);
  const west = latLonOf(g, 0, 4);
  const iEast = 4 * w + 20;
  const only = (deg, fast) => {
    const s = flatSpeed(1);
    s[deg + 90] = fast;
    return s;
  };
  near(costDistance(g, [west], { speedBySlope: only(10, 4) }).time[iEast], 5, 1e-3);
  near(costDistance(g, [west], { speedBySlope: only(-10, 4) }).time[iEast], 20, 1e-3);
  near(costDistance(g, [west], { speedBySlope: only(-10, 4), toward: true }).time[iEast], 5, 1e-3);
  near(costDistance(g, [west], { speedBySlope: only(9, 4) }).time[iEast], 20, 1e-3);
  near(costDistance(g, [west], { speedBySlope: only(11, 4) }).time[iEast], 20, 1e-3);
  // Rounding: 10.4 deg reads entry 10, 10.6 deg reads entry 11.
  const g104 = makeGrid(w, 9, 1, 1, (c) => Math.tan(10.4 * DEG) * c);
  const g106 = makeGrid(w, 9, 1, 1, (c) => Math.tan(10.6 * DEG) * c);
  near(costDistance(g104, [west], { speedBySlope: only(10, 4) }).time[iEast], 5, 1e-3);
  near(costDistance(g106, [west], { speedBySlope: only(11, 4) }).time[iEast], 5, 1e-3);
  // A step far steeper than the table's fast range still lands on the right entry (89 deg).
  const cliff = makeGrid(w, 9, 1, 1, (c) => (c >= 10 ? 60 : 0));
  near(costDistance(cliff, [west], { speedBySlope: only(89, 4) }).time[iEast], 19 + 0.25, 1e-3);
});

test('costDistance: a slope with speed 0 cannot be walked, in the direction that is too steep', () => {
  const w = 21;
  const g = makeGrid(w, 9, 1, 1, (c) => (c >= 10 ? 5 : 0));   // a 5 m step up toward the east
  const speed = new Float32Array(181);
  for (let d = 0; d <= 180; d++) speed[d] = d - 90 > 30 ? 0 : 1;   // no climbing above 30 deg
  const low = latLonOf(g, 2, 4);
  const iHigh = 4 * w + 18;
  const out = costDistance(g, [low], { speedBySlope: speed });
  assert.equal(out.time[iHigh], Infinity);                    // cannot climb the step
  assert.equal(out.prev[iHigh], UNREACHED);
  near(out.time[4 * w + 9], 7, 1e-4);
  const home = costDistance(g, [low], { speedBySlope: speed, toward: true });
  near(home.time[iHigh], 16, 1e-4);                           // but can come down it
  // Ground with no elevation is not walkable.
  const hole = makeGrid(w, 9, 1, 1, (c) => (c === 10 ? NaN : 0));
  assert.equal(costDistance(hole, [low], { speedBySlope: flatSpeed(1) }).time[iHigh], Infinity);
});

test('pathFrom returns a connected path that ends at the source, with time falling along it', () => {
  const g = makeGrid(60, 45, 6, 5, bumps);
  const speed = new Float32Array(181);
  for (let d = 0; d <= 180; d++) {
    const s = Math.tan((d - 90) * DEG);
    speed[d] = Math.abs(d - 90) > 25 ? 0 : 1.4 * Math.exp(-3.5 * Math.abs(s + 0.05));
  }
  const src = latLonOf(g, 7, 9);
  for (const toward of [false, true]) {
    const { time, prev } = costDistance(g, [src], { speedBySlope: speed, toward });
    const end = latLonOf(g, 55, 40);
    const path = pathFrom(g, prev, end.lat, end.lon);
    assert.ok(path.length > 48);
    assert.deepEqual([path[0].col, path[0].row], [55, 40]);
    const last = path[path.length - 1];
    assert.deepEqual([last.col, last.row], [7, 9]);
    near(last.lat, src.lat, 1e-12);
    near(last.lon, src.lon, 1e-12);
    for (let k = 0; k < path.length; k++) {
      const p = path[k];
      near(p.elev, g.elev[p.row * g.w + p.col], 0);
      assert.deepEqual(cellOf(g, p.lat, p.lon), { col: p.col, row: p.row, inside: true });
      if (!k) continue;
      const q = path[k - 1];
      assert.ok(Math.max(Math.abs(p.col - q.col), Math.abs(p.row - q.row)) === 1, 'steps join neighbouring cells');
      assert.ok(time[p.row * g.w + p.col] < time[q.row * g.w + q.col], 'time falls toward the source');
    }
    assert.equal(pathFrom(g, prev, src.lat, src.lon).length, 1);
  }
  // Walking out and walking home over the same ground take different times.
  const a = costDistance(g, [src], { speedBySlope: speed }).time[40 * 60 + 55];
  const b = costDistance(g, [src], { speedBySlope: speed, toward: true }).time[40 * 60 + 55];
  assert.ok(Math.abs(a - b) > 0.5, `${a} vs ${b}`);
});

// Reference: relax every move until nothing improves, slope from atan, all in doubles.
function costBruteForce(g, srcCol, srcRow, speed, blocked, toward) {
  const { w, h, elev: z } = g;
  const time = new Float64Array(w * h).fill(Infinity);
  time[srcRow * w + srcCol] = 0;
  for (let changed = true; changed;) {
    changed = false;
    for (let r = 0; r < h; r++) {
      for (let c = 0; c < w; c++) {
        const i = r * w + c;
        if (time[i] === Infinity) continue;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const cc = c + dc;
            const rr = r + dr;
            if ((!dc && !dr) || cc < 0 || cc >= w || rr < 0 || rr >= h) continue;
            const j = rr * w + cc;
            if (blocked && (blocked[j] || (dc && dr && (blocked[r * w + cc] || blocked[rr * w + c])))) continue;
            const len = Math.hypot(dc * g.dx, dr * g.dy);
            const rise = toward ? z[i] - z[j] : z[j] - z[i];
            const v = speed[Math.round(Math.atan(rise / len) / DEG) + 90];
            if (v > 0 && time[i] + len / v < time[j] - 1e-12) { time[j] = time[i] + len / v; changed = true; }
          }
        }
      }
    }
  }
  return time;
}

test('costDistance matches a plain reference on bumpy ground, both directions, with blocked cells', () => {
  const g = makeGrid(48, 36, 6, 5, (c, r) => 1.6 * bumps(c, r));
  const speed = new Float32Array(181);
  for (let d = 0; d <= 180; d++) {
    const s = Math.tan((d - 90) * DEG);
    speed[d] = Math.abs(d - 90) > 28 ? 0 : 1.4 * Math.exp(-3.5 * Math.abs(s + 0.05));
  }
  const blocked = new Uint8Array(48 * 36);
  for (let i = 0; i < blocked.length; i++) blocked[i] = (i * 7919) % 11 === 0 ? 1 : 0;
  blocked[12 * 48 + 20] = 0;
  const src = latLonOf(g, 20, 12);
  for (const toward of [false, true]) {
    for (const mask of [undefined, blocked]) {
      const { time } = costDistance(g, [src], { speedBySlope: speed, blocked: mask, toward });
      const want = costBruteForce(g, 20, 12, speed, mask, toward);
      let finite = 0;
      for (let i = 0; i < time.length; i++) {
        if (want[i] === Infinity) { assert.equal(time[i], Infinity); continue; }
        finite++;
        near(time[i], want[i], 1e-3 + want[i] * 1e-5);
      }
      assert.ok(finite > 1000, `${finite} cells reached`);
    }
  }
});

test('costDistance: maxTimeS stops the search and leaves the rest unreached', () => {
  const w = 41;
  const g = makeGrid(w, 41, 6, 6, bumps);
  const speed = flatSpeed(1.2);
  const src = [latLonOf(g, 20, 20)];
  const full = costDistance(g, src, { speedBySlope: speed });
  const part = costDistance(g, src, { speedBySlope: speed, maxTimeS: 40 });
  let inside = 0;
  for (let i = 0; i < full.time.length; i++) {
    if (full.time[i] <= 40) {
      inside++;
      assert.equal(part.time[i], full.time[i]);
      assert.equal(part.prev[i], full.prev[i]);
    } else {
      assert.equal(part.time[i], Infinity);
      assert.equal(part.prev[i], UNREACHED);
    }
  }
  assert.ok(inside > 100 && inside < full.time.length / 2);
});

// ---- worker ----

test('worker protocol: load, cached slope, transferables, errors', async () => {
  const w = 30;
  const h = 20;
  const q = new Int16Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) q[r * w + c] = c * 10 + r * 3;   // 1 m per cell east, 0.3 m south
  const north = -4.6;
  const south = north - (h * 6) / M_LAT;
  const meta = { file: 'dem.i16.gz', w, h, cell_m: 6, bounds: [[south, 137.3], [north, 137.3 + (w * 6) / (M_LAT * Math.cos(north * DEG))]], scale_m: 0.1, offset_m: 0 };
  const gz = gzipSync(Buffer.from(encodeDelta(q, w, h).buffer));
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url) => new Response(String(url).endsWith('.json') ? JSON.stringify(meta) : gz);
  try {
    const early = await handle({ id: 0, fn: 'hillshade', args: [315, 45] });
    assert.deepEqual(early.msg, { id: 0, ok: false, error: 'no terrain loaded: call load first' });

    const loaded = await handle({ id: 1, fn: 'load', args: ['https://example.test/data/terrain/dem.json'] });
    assert.equal(loaded.msg.ok, true);
    assert.equal(loaded.msg.id, 1);
    const grid = loaded.msg.result;
    assert.equal(grid.w, w);
    near(grid.dy, 6, 1e-6);
    near(grid.elev[5], 5, 1e-4);
    assert.deepEqual(loaded.transfer, [grid.elev.buffer]);

    const sa1 = await handle({ id: 2, fn: 'slopeAspect' });
    const sa2 = await handle({ id: 3, fn: 'slopeAspect', args: [] });
    assert.deepEqual(sa1.transfer, [sa1.msg.result.slope.buffer, sa1.msg.result.aspect.buffer]);
    assert.notEqual(sa1.msg.result.slope.buffer, sa2.msg.result.slope.buffer);   // the cache is not given away
    assert.deepEqual(sa1.msg.result.slope, sa2.msg.result.slope);
    near(sa1.msg.result.slope[w * 10 + 15], Math.atan(Math.hypot(1 / grid.dx, 0.3 / grid.dy)) / DEG, 1e-3);

    for (const [fn, args, type] of [
      ['roughness', [], Float32Array], ['hillshade', [315, 45], Uint8Array], ['castShadow', [90, 10], Uint8Array],
      ['viewshed', [grid.bounds[1][0] - 0.0005, 137.301, 2, 0], Uint8Array],
    ]) {
      const { msg, transfer } = await handle({ id: fn, fn, args });
      assert.equal(msg.ok, true, fn);
      assert.ok(msg.result instanceof type && msg.result.length === w * h, fn);
      assert.deepEqual(transfer, [msg.result.buffer]);
    }
    const here = latLonOf(grid, 3, 3);
    const there = latLonOf(grid, 20, 15);
    const cd = await handle({ id: 9, fn: 'costDistance', args: [[here], { speedBySlope: flatSpeed(1), toward: true }] });
    assert.equal(cd.msg.result.time[3 * w + 3], 0);
    assert.equal(cd.transfer.length, 2);

    const prof = await handle({ id: 10, fn: 'elevProfile', args: [[here, there, here], 5] });
    const pts = prof.msg.result;
    near(pts[pts.length - 1].distM, 2 * Math.hypot(17 * grid.dx, 12 * grid.dy), 1e-6);
    near(pts[pts.length - 1].elev, pts[0].elev, 1e-4);
    for (let i = 1; i < pts.length; i++) assert.ok(pts[i].distM > pts[i - 1].distM && pts[i].distM - pts[i - 1].distM <= 5 + 1e-9);
    assert.deepEqual(prof.transfer, []);

    const bad = await handle({ id: 11, fn: 'toString', args: [] });
    assert.deepEqual(bad.msg, { id: 11, ok: false, error: 'unknown function: toString' });
  } finally {
    globalThis.fetch = realFetch;
  }
});

// ---- performance on a grid the size of the real one ----

// Fractal-like ground: nine octaves of smoothed random lattices, each half the size and height of the last.
function fractalGround(w, h) {
  const z = new Float32Array(w * h);
  let seed = 20261114;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296) * 2 - 1;
  for (let cells = 512, amp = 150; cells >= 2; cells >>= 1, amp *= 0.5) {
    const lw = Math.ceil(w / cells) + 2;
    const lh = Math.ceil(h / cells) + 2;
    const lattice = Float32Array.from({ length: lw * lh }, rnd);
    for (let r = 0; r < h; r++) {
      const y = r / cells;
      const r0 = Math.floor(y);
      const fy = (y - r0) * (y - r0) * (3 - 2 * (y - r0));
      for (let c = 0; c < w; c++) {
        const x = c / cells;
        const c0 = Math.floor(x);
        const fx = (x - c0) * (x - c0) * (3 - 2 * (x - c0));
        const i = r0 * lw + c0;
        const top = lattice[i] + (lattice[i + 1] - lattice[i]) * fx;
        const bot = lattice[i + lw] + (lattice[i + lw + 1] - lattice[i + lw]) * fx;
        z[r * w + c] += amp * (top + (bot - top) * fy);
      }
    }
  }
  return z;
}

test('performance on a 1552 x 3200 grid (logged; fails only above 20 s per call)', (t) => {
  const w = 1552;
  const h = 3200;
  const ground = fractalGround(w, h);
  const q = new Int16Array(w * h);
  for (let i = 0; i < q.length; i++) q[i] = Math.round(ground[i] / 0.1);
  const stored = encodeDelta(q, w, h);
  const south = -4.78;
  const north = south + (h * 6) / M_LAT;
  const west = 137.33;
  const east = west + (w * 6) / (M_LAT * Math.cos(((south + north) / 2) * DEG));
  const meta = { file: 'dem.i16.gz', w, h, cell_m: 6, bounds: [[south, west], [north, east]], scale_m: 0.1, offset_m: -4400 };

  const timings = [];
  const timed = (name, fn) => {
    const t0 = performance.now();
    const out = fn();
    const ms = performance.now() - t0;
    timings.push([name, ms]);
    t.diagnostic(`${name}: ${ms.toFixed(0)} ms`);
    assert.ok(ms < 20000, `${name} took ${ms} ms`);
    return out;
  };

  const g = timed('decodeDem', () => decodeDem(meta, stored));
  near(g.dx, 6, 1e-6);
  near(g.elev[123456], q[123456] * 0.1 - 4400, 1e-2);
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i < g.elev.length; i++) { if (g.elev[i] < lo) lo = g.elev[i]; if (g.elev[i] > hi) hi = g.elev[i]; }

  const grad = timed('gradient', () => gradient(g));
  const { slope } = timed('slopeAspect (gradient given)', () => slopeAspect(g, grad));
  timed('slopeAspect (from elevation)', () => slopeAspect(g));
  timed('roughness', () => roughness(g));
  timed('hillshade (gradient given)', () => hillshade(g, 315, 45, grad));
  timed('hillshade (from elevation)', () => hillshade(g, 315, 45));
  let meanSlope = 0;
  for (let i = 0; i < slope.length; i++) meanSlope += slope[i];
  meanSlope /= slope.length;
  t.diagnostic(`ground: ${w} x ${h} cells, relief ${(hi - lo).toFixed(0)} m, mean slope ${meanSlope.toFixed(1)} deg`);

  for (const [az, el] of [[95, 5], [250, 20], [10, 45], [135, 10]]) {
    const s = timed(`castShadow az ${az} el ${el}`, () => castShadow(g, az, el));
    t.diagnostic(`  ${((100 * sum(s)) / s.length).toFixed(1)} % in shadow`);
  }

  const centre = latLonOf(g, w >> 1, h >> 1);
  const corner = latLonOf(g, 3, 3);
  const vc = timed('viewshed from the centre', () => viewshed(g, centre.lat, centre.lon, 2, 2));
  timed('viewshed from a corner', () => viewshed(g, corner.lat, corner.lon, 2, 2));
  t.diagnostic(`  ${((100 * sum(vc)) / vc.length).toFixed(1)} % visible from the centre`);

  const speed = new Float32Array(181);
  for (let d = 0; d <= 180; d++) {
    const s = Math.tan((d - 90) * DEG);
    speed[d] = Math.abs(d - 90) > 30 ? 0 : 1.4 * Math.exp(-3.5 * Math.abs(s + 0.05));   // Tobler shape, 30 deg limit
  }
  const out = timed('costDistance from the centre', () => costDistance(g, [centre], { speedBySlope: speed }));
  const home = timed('costDistance toward the centre', () => costDistance(g, [centre], { speedBySlope: speed, toward: true }));
  const blocked = new Uint8Array(w * h);
  for (let i = 0; i < blocked.length; i++) blocked[i] = slope[i] > 25 ? 1 : 0;
  timed('costDistance with a blocked mask', () => costDistance(g, [centre], { speedBySlope: speed, blocked }));
  timed('costDistance limited to 30 min', () => costDistance(g, [centre], { speedBySlope: speed, maxTimeS: 1800 }));
  const mask = timed('isochroneMask', () => isochroneMask(out.time, 3600));
  let reached = 0;
  for (let i = 0; i < out.time.length; i++) reached += out.time[i] < Infinity ? 1 : 0;
  t.diagnostic(`  ${((100 * reached) / out.time.length).toFixed(1)} % of cells reachable, ${((100 * sum(mask)) / mask.length).toFixed(1)} % within an hour`);

  const path = timed('pathFrom the corner', () => pathFrom(g, home.prev, corner.lat, corner.lon));
  if (home.time[3 * w + 3] < Infinity) {
    assert.deepEqual([path[path.length - 1].col, path[path.length - 1].row], [w >> 1, h >> 1]);
    t.diagnostic(`  walk home from the corner: ${path.length} cells, ${(home.time[3 * w + 3] / 3600).toFixed(2)} h`);
  }
  const line = timed('sampleLine corner to centre, 5 m steps', () => sampleLine(g, corner, centre, 5));
  assert.ok(line.length > 2000);
  assert.ok(Number.isFinite(line[1000].elev));
});
