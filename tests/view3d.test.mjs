import test from 'node:test';
import assert from 'node:assert/strict';
import { MARS_RADIUS_M, gridFromBounds, latLonOf, elevAt } from '../js/terrain.js';
import {
  MAX_VERTS,
  mat4Perspective, mat4LookAt, mat4Multiply, mat4TransformPoint, projectPoint,
  chooseStride, subGrid, makeFrame, toScene, fromScene, buildTerrain, heightAt, terrainVertices,
  meshChunks, gridIndices,
  resamplePolyline, cumulativeLength, buildRoute, pointAtDistance, pointAtFraction,
  bearingOf, headingAt, angleDiff, smoothHeading, easeProgress, orbitEye, buildRibbon, niceLength,
  createView3D,
} from '../js/view3d.js';

const DEG = Math.PI / 180;
const M_LAT = DEG * MARS_RADIUS_M;
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b} (±${eps})`);
const nearAll = (a, b, eps = 1e-9) => { assert.equal(a.length, b.length); for (let i = 0; i < b.length; i++) near(a[i], b[i], eps); };

// A grid near Gale's latitude whose cells are exactly cellX by cellY metres. fn(col, row) -> elevation.
function makeGrid(w, h, cellX, cellY, fn = () => 0) {
  const north = -4.6;
  const west = 137.3;
  const south = north - (h * cellY) / M_LAT;
  const east = west + (w * cellX) / (M_LAT * Math.cos(((north + south) / 2) * DEG));
  const elev = new Float32Array(w * h);
  for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) elev[r * w + c] = fn(c, r);
  const g = gridFromBounds(w, h, [[south, west], [north, east]], elev, 0.1);
  g.dx = cellX;
  g.dy = cellY;
  return g;
}
const whole = (g) => ({ south: g.bounds[0][0], west: g.bounds[0][1], north: g.bounds[1][0], east: g.bounds[1][1] });
// A frame in which lat/lon are simply metres: lat = metres north, lon = metres east.
const METRES = { lat0: 0, lon0: 0, mPerDegLat: 1, mPerDegLon: 1 };
const leg = (id, pts, dashed = false) => ({ id, dashed, pts: pts.map(([east, north]) => ({ lat: north, lon: east })) });

// ---- matrices ----

test('mat4Perspective: hand values for 90 degrees, aspect 2, near 1, far 3', () => {
  const m = mat4Perspective(90 * DEG, 2, 1, 3);
  nearAll(Array.from(m), [0.5, 0, 0, 0, 0, 1, 0, 0, 0, 0, -2, -1, 0, 0, -3, 0], 1e-12);
  // a point on the near plane lands at clip z = -w, one on the far plane at +w
  nearAll(mat4TransformPoint(m, 0, 0, -1), [0, 0, -1, 1], 1e-12);
  nearAll(mat4TransformPoint(m, 0, 0, -3), [0, 0, 3, 3], 1e-12);
  // the edge of the view at 45 degrees up: y / w = 1; at 45 degrees right with aspect 2: x / w = 0.5
  nearAll(mat4TransformPoint(m, 2, 2, -2), [1, 2, 1, 2], 1e-12);
});

test('mat4LookAt: camera on +z looking at the origin is a plain shift', () => {
  const m = mat4LookAt([0, 0, 5], [0, 0, 0], [0, 1, 0]);
  nearAll(Array.from(m), [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, -5, 1], 1e-12);
  nearAll(mat4TransformPoint(m, 1, 2, 3), [1, 2, -2, 1], 1e-12);
});

test('mat4LookAt: looking east along +x, hand values', () => {
  const m = mat4LookAt([0, 0, 0], [1, 0, 0], [0, 1, 0]);
  // forward (+x) becomes -z in view space, south (+z) is on the right, up stays up
  nearAll(mat4TransformPoint(m, 1, 0, 0), [0, 0, -1, 1], 1e-12);
  nearAll(mat4TransformPoint(m, 0, 0, 1), [1, 0, 0, 1], 1e-12);
  nearAll(mat4TransformPoint(m, 0, 1, 0), [0, 1, 0, 1], 1e-12);
});

test('mat4LookAt: the eye maps to the origin and the target lies straight ahead', () => {
  const eye = [3, 7, -2], target = [10, 1, 4];
  const m = mat4LookAt(eye, target, [0, 1, 0]);
  nearAll(mat4TransformPoint(m, ...eye), [0, 0, 0, 1], 1e-12);
  const t = mat4TransformPoint(m, ...target);
  near(t[0], 0, 1e-12);
  near(t[1], 0, 1e-12);
  near(t[2], -Math.hypot(7, 6, 6), 1e-12);
});

test('mat4Multiply: a * b applies b first; hand values', () => {
  const T = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 10, 20, 30, 1];     // translate by (10, 20, 30)
  const S = [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 0, 0, 0, 1];        // scale by (2, 3, 4)
  nearAll(Array.from(mat4Multiply(T, S)), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 10, 20, 30, 1]);
  nearAll(Array.from(mat4Multiply(S, T)), [2, 0, 0, 0, 0, 3, 0, 0, 0, 0, 4, 0, 20, 60, 120, 1]);
  nearAll(mat4TransformPoint(mat4Multiply(T, S), 1, 1, 1), [12, 23, 34, 1]);     // scaled, then moved
  nearAll(mat4TransformPoint(mat4Multiply(S, T), 1, 1, 1), [22, 63, 124, 1]);    // moved, then scaled
  const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const A = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16];
  nearAll(Array.from(mat4Multiply(I, A)), A);
  nearAll(Array.from(mat4Multiply(A, I)), A);
  // one entry of a general product by hand: row 0, column 0 = row 0 of A (1, 5, 9, 13) . column 0 of A (1, 2, 3, 4)
  near(mat4Multiply(A, A)[0], 1 * 1 + 5 * 2 + 9 * 3 + 13 * 4);
});

test('projectPoint: centre, edges and behind the camera', () => {
  const vp = mat4Multiply(mat4Perspective(90 * DEG, 2, 1, 100), mat4LookAt([0, 0, 0], [0, 0, -1], [0, 1, 0]));
  let p = projectPoint(vp, 0, 0, -10, 800, 400);
  near(p.x, 400, 1e-9); near(p.y, 200, 1e-9); near(p.w, 10, 1e-9);
  assert.equal(p.visible, true);
  p = projectPoint(vp, 0, 10, -10, 800, 400);       // 45 degrees up: the top edge (y runs down the screen)
  near(p.y, 0, 1e-9);
  p = projectPoint(vp, 10, 0, -10, 800, 400);       // 45 degrees right at aspect 2: three quarters across
  near(p.x, 600, 1e-9);
  p = projectPoint(vp, 0, 0, 10, 800, 400);         // behind
  assert.equal(p.visible, false);
  assert.ok(!(p.w > 0));
});

// ---- stride and sub-grid ----

test('chooseStride: 400 x 400 cells stay whole, bigger blocks are decimated under the budget', () => {
  assert.equal(MAX_VERTS, 200000);
  assert.equal(chooseStride(400, 400), 1);
  assert.equal(chooseStride(447, 447), 1);          // 199 809 vertices
  assert.equal(chooseStride(448, 448), 2);          // 200 704 would be over
  assert.equal(chooseStride(1552, 3200), 5);        // the whole Gale grid: 311 x 640 = 199 040
  assert.equal(chooseStride(1552, 3200, 65536), 9); // 173 x 356 = 61 588
  assert.equal(chooseStride(2, 2), 1);
  for (const [c, r] of [[500, 500], [1552, 3200], [3000, 100], [901, 777]]) {
    const s = chooseStride(c, r);
    const verts = (n) => Math.floor((n - 1) / s) + 1;
    assert.ok(verts(c) * verts(r) <= MAX_VERTS);
    if (s > 1) {
      const prev = (n) => Math.floor((n - 1) / (s - 1)) + 1;
      assert.ok(prev(c) * prev(r) > MAX_VERTS, 'the stride is the smallest that fits');
    }
  }
});

test('subGrid: the cells covering a region, row 0 at the north', () => {
  const g = makeGrid(100, 80, 5, 5);
  const a = latLonOf(g, 10, 20), b = latLonOf(g, 39, 59);      // cell centres
  const sub = subGrid(g, { north: a.lat, west: a.lon, south: b.lat, east: b.lon });
  assert.deepEqual(sub, { c0: 10, r0: 20, cols: 30, rows: 40, stride: 1, nx: 30, nz: 40 });
  // south/north and west/east given the wrong way round mean the same region
  assert.deepEqual(subGrid(g, { north: b.lat, west: b.lon, south: a.lat, east: a.lon }), sub);
});

test('subGrid: clamps to the grid, and a missing region means the whole grid', () => {
  const g = makeGrid(100, 80, 5, 5);
  const all = { c0: 0, r0: 0, cols: 100, rows: 80, stride: 1, nx: 100, nz: 80 };
  assert.deepEqual(subGrid(g, { south: -10, west: 100, north: 10, east: 170 }), all);
  assert.deepEqual(subGrid(g, null), all);
  assert.deepEqual(subGrid(g, whole(g)), all);
  // a region wholly outside still gives a drawable strip at the nearest edge
  const out = subGrid(g, { south: 10, north: 11, west: 0, east: 1 });
  assert.deepEqual([out.c0, out.r0, out.cols, out.rows], [0, 0, 2, 2]);
  // a region inside a single cell is widened to two cells so there is something to draw
  const p = latLonOf(g, 50, 40);
  const tiny = subGrid(g, { south: p.lat, north: p.lat, west: p.lon, east: p.lon });
  assert.deepEqual([tiny.cols, tiny.rows, tiny.nx, tiny.nz], [2, 2, 2, 2]);
  assert.throws(() => subGrid({ w: 1, h: 5, bounds: g.bounds }, null), /2 x 2/);
});

test('subGrid: decimates by an integer stride to stay under the vertex budget', () => {
  const g = makeGrid(1552, 3200, 6.113, 6.113);
  const sub = subGrid(g, whole(g));
  assert.equal(sub.stride, 5);
  assert.equal(sub.nx, 311);
  assert.equal(sub.nz, 640);
  assert.ok(sub.nx * sub.nz <= MAX_VERTS);
  const small = subGrid(g, whole(g), 1000);
  assert.ok(small.nx * small.nz <= 1000);
  assert.ok(small.stride > 5);
});

// ---- lat/lon to scene ----

test('toScene: north is -z, east is +x, distances are metres', () => {
  const g = makeGrid(101, 81, 5, 4);
  const sub = subGrid(g, whole(g));
  const f = makeFrame(g, sub);
  const mid = latLonOf(g, 50, 40);                  // the middle vertex of the mesh
  const o = toScene(f, mid.lat, mid.lon);
  near(o.x, 0, 1e-6);
  near(o.z, 0, 1e-6);
  const n = toScene(f, mid.lat + 100 / M_LAT, mid.lon);
  near(n.x, 0, 1e-6);
  near(n.z, -100, 1e-6);                            // 100 m north
  const e = latLonOf(g, 60, 40);                    // ten cells east
  near(toScene(f, e.lat, e.lon).x, 50, 1e-6);
  near(toScene(f, e.lat, e.lon).z, 0, 1e-6);
  const s = latLonOf(g, 50, 50);                    // ten rows down the grid = south
  near(toScene(f, s.lat, s.lon).z, 40, 1e-6);
  const back = fromScene(f, 37.5, -12.25);
  const again = toScene(f, back.lat, back.lon);
  near(again.x, 37.5, 1e-6);
  near(again.z, -12.25, 1e-6);
});

test('toScene: every mesh vertex sits on its cell centre, also on a decimated sub-grid', () => {
  const g = makeGrid(120, 90, 6, 6, (c, r) => c + 2 * r);
  const a = latLonOf(g, 7, 11), b = latLonOf(g, 100, 80);
  const t = buildTerrain(g, { north: a.lat, west: a.lon, south: b.lat, east: b.lon }, 1, 500);
  assert.ok(t.sub.stride > 1);
  assert.ok(t.nx * t.nz <= 500);
  const v = terrainVertices(t);
  for (const [i, j] of [[0, 0], [t.nx - 1, 0], [0, t.nz - 1], [t.nx - 1, t.nz - 1], [3, 5]]) {
    const col = t.sub.c0 + i * t.sub.stride, row = t.sub.r0 + j * t.sub.stride;
    const p = latLonOf(g, col, row);
    const q = toScene(t.frame, p.lat, p.lon);
    const o = (j * t.nx + i) * 6;
    near(v[o], q.x, 1e-3);
    near(v[o + 2], q.z, 1e-3);
    near(v[o + 1], g.elev[row * g.w + col] - t.elevMin, 1e-3);
  }
  // the first row of the mesh is the northern edge: most negative z
  assert.ok(v[2] < 0 && v[(t.nz - 1) * t.nx * 6 + 2] > 0);
  // and the first column the western edge: most negative x
  assert.ok(v[0] < 0 && v[(t.nx - 1) * 6] > 0);
});

test('seen from straight above with north up, east is on the right (no mirror)', () => {
  // the camera looks north (az 0) from almost overhead
  const cam = { tx: 0, ty: 0, tz: 0, az: 0, pitch: 89.9, dist: 1000 };
  const vp = mat4Multiply(mat4Perspective(40 * DEG, 1.6, 1, 5000), mat4LookAt(orbitEye(cam), [0, 0, 0], [0, 1, 0]));
  const c = projectPoint(vp, 0, 0, 0, 1600, 1000);
  const east = projectPoint(vp, 100, 0, 0, 1600, 1000);
  const north = projectPoint(vp, 0, 0, -100, 1600, 1000);
  near(c.x, 800, 1e-6);
  near(c.y, 500, 1e-6);
  assert.ok(east.x > c.x + 50 && Math.abs(east.y - c.y) < 1, 'east is to the right');
  assert.ok(north.y < c.y - 50 && Math.abs(north.x - c.x) < 1, 'north is up the screen');
  // the same from an oblique view from the south
  const vp2 = mat4Multiply(mat4Perspective(40 * DEG, 1.6, 1, 5000), mat4LookAt(orbitEye({ ...cam, pitch: 35 }), [0, 0, 0], [0, 1, 0]));
  assert.ok(projectPoint(vp2, 100, 0, 0, 1600, 1000).x > 850);
  assert.ok(projectPoint(vp2, 0, 0, -100, 1600, 1000).y < 480);
});

test('orbitEye: az 0 stands south of the target looking north; pitch lifts the camera', () => {
  nearAll(orbitEye({ tx: 0, ty: 0, tz: 0, az: 0, pitch: 0, dist: 100 }), [0, 0, 100], 1e-9);       // south is +z
  nearAll(orbitEye({ tx: 0, ty: 0, tz: 0, az: 90, pitch: 0, dist: 100 }), [-100, 0, 0], 1e-9);     // looking east from the west
  nearAll(orbitEye({ tx: 5, ty: 6, tz: 7, az: 0, pitch: 90, dist: 100 }), [5, 106, 7], 1e-9);
  const e = orbitEye({ tx: 0, ty: 0, tz: 0, az: 0, pitch: 30, dist: 100 });
  near(e[1], 50, 1e-9);
  near(e[2], 100 * Math.cos(30 * DEG), 1e-9);
});

// ---- heights ----

test('buildTerrain: heights are measured from the lowest ground and scaled by the exaggeration', () => {
  const g = makeGrid(20, 20, 5, 5, (c, r) => -4000 + c * 2 + r);
  const t = buildTerrain(g, whole(g), 1.5);
  assert.equal(t.elevMin, -4000);
  assert.equal(t.elevMax, -4000 + 19 * 2 + 19);
  near(t.yMax, 57 * 1.5, 1e-4);
  near(t.y[0], 0, 1e-6);
  near(t.y[1], 2 * 1.5, 1e-4);
  near(t.y[20], 1 * 1.5, 1e-4);
  assert.equal(t.cellX, 5);
  near(t.halfX, 47.5, 1e-9);
  // horizontal sizes are not exaggerated
  const flat = buildTerrain(g, whole(g), 3);
  assert.equal(flat.halfX, t.halfX);
  assert.equal(flat.halfZ, t.halfZ);
});

test('buildTerrain: missing elevation is drawn at the lowest ground', () => {
  const g = makeGrid(6, 6, 5, 5, (c, r) => (c === 2 && r === 2 ? NaN : 10 + c));
  const t = buildTerrain(g, whole(g), 2);
  assert.equal(t.elevMin, 10);
  assert.equal(t.y[2 * 6 + 2], 0);
  assert.ok(t.y.every((v) => Number.isFinite(v)));
});

test('heightAt: reproduces a tilted plane exactly and matches bilinear elevAt on it', () => {
  const g = makeGrid(30, 30, 6, 6, (c, r) => 100 + 0.5 * c - 0.25 * r);
  const t = buildTerrain(g, whole(g), 2);
  for (const [col, row] of [[0, 0], [29, 29], [12.3, 7.9], [5.5, 20.25], [28.99, 0.01]]) {
    const x = -t.halfX + col * 6, z = -t.halfZ + row * 6;
    near(heightAt(t, x, z), (0.5 * col - 0.25 * row + 0.25 * 29) * 2, 1e-3);
    const p = fromScene(t.frame, x, z);
    near(heightAt(t, x, z), (elevAt(g, p.lat, p.lon) - t.elevMin) * 2, 1e-3);
  }
  // outside the mesh the edge height is held
  near(heightAt(t, -t.halfX - 500, -t.halfZ), heightAt(t, -t.halfX, -t.halfZ), 1e-6);
});

test('heightAt: follows the two triangles each square is drawn with (split from south-west to north-east)', () => {
  // one square: north-west 0, north-east 0, south-west 0, south-east 12
  const g = makeGrid(2, 2, 10, 10, (c, r) => (c === 1 && r === 1 ? 12 : 0));
  const t = buildTerrain(g, whole(g), 1);
  near(heightAt(t, -5, -5), 0);          // north-west corner
  near(heightAt(t, 5, 5), 12);           // south-east corner
  near(heightAt(t, 0, 0), 0);            // the middle lies on the flat diagonal, not at the bilinear 3
  near(heightAt(t, -2, -2), 0);          // north-west triangle is flat
  near(heightAt(t, 2.5, 2.5), 6);        // halfway from the diagonal to the raised corner
  // the index order agrees: triangles a-b-c and c-b-d share the edge b-c (south-west to north-east)
  assert.deepEqual(Array.from(gridIndices(2, 2)), [0, 2, 1, 1, 2, 3]);
});

test('terrainVertices: normals point up on flat ground and lean away from a rise', () => {
  const flat = buildTerrain(makeGrid(5, 5, 6, 6), null, 1.5);
  const v = terrainVertices(flat);
  assert.equal(v.length, 25 * 6);
  for (let i = 0; i < 25; i++) nearAll(Array.from(v.slice(i * 6 + 3, i * 6 + 6)), [0, 1, 0], 1e-6);
  // ground rising 1 m per metre toward the east: the normal leans west by 45 degrees
  const slope = buildTerrain(makeGrid(5, 5, 6, 6, (c) => c * 6), null, 1);
  const n = Array.from(terrainVertices(slope).slice(12 * 6 + 3, 12 * 6 + 6));
  nearAll(n, [-Math.SQRT1_2, Math.SQRT1_2, 0], 1e-6);
  // with exaggeration 2 the drawn slope is steeper and the normal leans further
  const steep = buildTerrain(makeGrid(5, 5, 6, 6, (c) => c * 6), null, 2);
  const n2 = Array.from(terrainVertices(steep).slice(12 * 6 + 3, 12 * 6 + 6));
  near(n2[0] / n2[1], -2, 1e-5);
  // ground rising toward the south: the normal leans north (-z)
  const south = buildTerrain(makeGrid(5, 5, 6, 6, (c, r) => r * 6), null, 1);
  assert.ok(terrainVertices(south)[12 * 6 + 5] < -0.7);
});

// ---- mesh chunks ----

test('meshChunks: every band fits 16-bit indices and neighbours share a row', () => {
  for (const [nx, nz] of [[447, 447], [311, 640], [1000, 200], [100, 100], [40000, 5]]) {
    const chunks = meshChunks(nx, nz);
    assert.equal(chunks[0].row0, 0);
    let quads = 0;
    chunks.forEach((ch, i) => {
      assert.ok(ch.rows >= 2);
      assert.ok(ch.rows * nx <= 65536 || ch.rows === 2, `${ch.rows} rows of ${nx}`);
      if (i) assert.equal(ch.row0, chunks[i - 1].row0 + chunks[i - 1].rows - 1, 'starts on the last row of the band before');
      quads += ch.rows - 1;
    });
    const last = chunks[chunks.length - 1];
    assert.equal(last.row0 + last.rows, nz, 'the last band ends on the last row');
    assert.equal(quads, nz - 1, 'every strip of ground is drawn exactly once');
  }
  assert.deepEqual(meshChunks(100, 100), [{ row0: 0, rows: 100 }]);
  assert.equal(meshChunks(447, 447).length, 4);     // 146 rows a band
});

test('gridIndices: two counter-clockwise triangles per square, all indices in range', () => {
  const idx = gridIndices(3, 2);
  assert.ok(idx instanceof Uint16Array);
  assert.deepEqual(Array.from(idx), [0, 3, 1, 1, 3, 4, 1, 4, 2, 2, 4, 5]);
  const big = gridIndices(300, 218, Uint16Array);
  assert.equal(big.length, 299 * 217 * 6);
  let max = 0;
  for (const i of big) if (i > max) max = i;
  assert.equal(max, 300 * 218 - 1);
  assert.ok(gridIndices(4, 4, Uint32Array) instanceof Uint32Array);
  // seen from above with x to the right and north (-z) up, a-b-c turns counter-clockwise
  const P = [[0, 0], [1, 0], [0, 1], [1, 1]];       // vertex -> (x east, z south) on a 2 x 2 lattice
  const [a, b, c] = gridIndices(2, 2);
  const cross = (P[b][0] - P[a][0]) * -(P[c][1] - P[a][1]) - -(P[b][1] - P[a][1]) * (P[c][0] - P[a][0]);
  assert.ok(cross > 0);
});

// ---- route ----

test('resamplePolyline: no segment longer than the limit, original points kept, length unchanged', () => {
  const pts = [{ x: 0, z: 0 }, { x: 10, z: 0 }, { x: 10, z: 25 }, { x: 10.5, z: 25 }];
  const out = resamplePolyline(pts, 4);
  for (let i = 1; i < out.length; i++) assert.ok(Math.hypot(out[i].x - out[i - 1].x, out[i].z - out[i - 1].z) <= 4 + 1e-9);
  for (const p of pts) assert.ok(out.some((q) => q.x === p.x && q.z === p.z), 'original point kept');
  // 10 m in 3 steps, 25 m in 7 steps, 0.5 m as it is: 1 + 3 + 7 + 1 points
  assert.equal(out.length, 12);
  near(out[1].x, 10 / 3, 1e-12);
  const s = cumulativeLength(out);
  near(s[s.length - 1], 35.5, 1e-9);
  // a segment exactly as long as the limit is not split
  assert.equal(resamplePolyline([{ x: 0, z: 0 }, { x: 8, z: 0 }], 4).length, 3);
  assert.equal(resamplePolyline([{ x: 0, z: 0 }, { x: 4, z: 0 }], 4).length, 2);
  assert.deepEqual(resamplePolyline([], 4), []);
  assert.deepEqual(resamplePolyline([{ x: 1, z: 2 }], 4), [{ x: 1, z: 2 }]);
});

test('cumulativeLength: hand values', () => {
  nearAll(Array.from(cumulativeLength([{ x: 0, z: 0 }, { x: 3, z: 4 }, { x: 3, z: 10 }, { x: 3, z: 10 }])), [0, 5, 11, 11]);
  assert.equal(cumulativeLength([]).length, 0);
});

test('buildRoute: legs in walking order, one running distance, no segment over the limit', () => {
  // 100 m east, then 50 m south, then (after a 10 m gap that is not walked) 30 m further south, dashed
  const route = buildRoute([leg('A', [[0, 0], [100, 0], [100, -50]]), leg('B', [[100, -60], [100, -90]], true)], METRES, 6);
  near(route.total, 180, 1e-9);
  assert.equal(route.legs.length, 2);
  assert.deepEqual([route.legs[0].id, route.legs[0].dashed, route.legs[0].first], ['A', false, 0]);
  assert.deepEqual([route.legs[1].id, route.legs[1].dashed], ['B', true]);
  near(route.legs[0].s1, 150, 1e-9);
  near(route.legs[1].s0, 150, 1e-9);
  near(route.legs[1].s1, 180, 1e-9);
  assert.equal(route.legs[0].count + route.legs[1].count, route.n);
  assert.equal(route.legs[1].first, route.legs[0].count);
  for (const l of route.legs) {
    for (let i = l.first + 1; i < l.first + l.count; i++) {
      const d = Math.hypot(route.x[i] - route.x[i - 1], route.z[i] - route.z[i - 1]);
      assert.ok(d <= 6 + 1e-9);
      near(route.s[i] - route.s[i - 1], d, 1e-9);
    }
  }
  // north is -z: walking south increases z
  near(route.z[route.n - 1], 90, 1e-9);
  near(route.x[route.n - 1], 100, 1e-9);
});

test('buildRoute: skips bad points and legs that cannot be drawn', () => {
  const route = buildRoute([
    { id: 'one point', pts: [{ lat: 0, lon: 0 }] },
    { id: 'ok', pts: [{ lat: 0, lon: 0 }, { lat: NaN, lon: 5 }, null, { lat: 0, lon: 10 }] },
    { id: 'none' },
  ], METRES, 100);
  assert.equal(route.legs.length, 1);
  assert.equal(route.legs[0].id, 'ok');
  near(route.total, 10, 1e-12);
  const empty = buildRoute([], METRES, 5);
  assert.equal(empty.n, 0);
  assert.equal(empty.total, 0);
  assert.equal(pointAtFraction(empty, 0.5), null);
  assert.equal(buildRoute(undefined, METRES, 5).n, 0);
});

test('pointAtFraction: positions along an L-shaped route, by hand', () => {
  const route = buildRoute([leg('A', [[0, 0], [100, 0], [100, -50]])], METRES, 7);
  const at = (f) => pointAtFraction(route, f);
  nearAll([at(0).x, at(0).z, at(0).s], [0, 0, 0], 1e-9);
  nearAll([at(1).x, at(1).z, at(1).s], [100, 50, 150], 1e-9);
  nearAll([at(0.5).x, at(0.5).z, at(0.5).s], [75, 0, 75], 1e-9);
  nearAll([at(2 / 3).x, at(2 / 3).z], [100, 0], 1e-9);              // the corner
  nearAll([at(0.8).x, at(0.8).z], [100, 20], 1e-9);                 // 120 m: 20 m down the second side
  // clamped outside 0..1, and NaN counts as the start
  nearAll([at(-3).x, at(-3).z], [0, 0], 1e-9);
  nearAll([at(7).x, at(7).z], [100, 50], 1e-9);
  nearAll([at(NaN).x, at(NaN).z], [0, 0], 1e-9);
  // the position moves continuously and by the right distance
  let prev = at(0);
  for (let k = 1; k <= 300; k++) {
    const p = at(k / 300);
    assert.ok(Math.hypot(p.x - prev.x, p.z - prev.z) <= 0.5 + 1e-9);
    prev = p;
  }
  nearAll([pointAtDistance(route, 30).x, pointAtDistance(route, 130).z], [30, 30], 1e-9);
});

test('pointAtFraction: a gap between legs is jumped, not walked', () => {
  const route = buildRoute([leg('A', [[0, 0], [100, 0]]), leg('B', [[100, -40], [200, -40]])], METRES, 10);
  near(route.total, 200, 1e-9);
  nearAll([pointAtFraction(route, 0.25).x, pointAtFraction(route, 0.25).z], [50, 0], 1e-9);
  nearAll([pointAtFraction(route, 0.75).x, pointAtFraction(route, 0.75).z], [150, 40], 1e-9);
  const before = pointAtDistance(route, 100 - 1e-6), after = pointAtDistance(route, 100 + 1e-6);
  near(before.z, 0, 1e-9);
  near(after.z, 40, 1e-9);
  // exactly at the end of a leg the head is already at the start of the next one
  nearAll([pointAtDistance(route, 100).x, pointAtDistance(route, 100).z], [100, 40], 1e-9);
});

test('buildRibbon: the route is lifted above the ground it crosses', () => {
  const g = makeGrid(40, 40, 6, 6, (c, r) => 50 + c * 0.8 + Math.sin(r / 3) * 4);
  const t = buildTerrain(g, null, 1.5);
  const a = fromScene(t.frame, -100, -90), b = fromScene(t.frame, 60, 20), c = fromScene(t.frame, 100, 100);
  const route = buildRoute([{ id: 'A', pts: [a, b], dashed: false }, { id: 'B', pts: [b, c], dashed: true }], t.frame, Math.min(t.cellX, t.cellZ));
  const rb = buildRibbon(route, t, 1);
  assert.equal(rb.y.length, route.n);
  for (let i = 0; i < route.n; i++) near(rb.y[i], heightAt(t, route.x[i], route.z[i]) + 1, 1e-4);
  // two triangles per segment; a round join at every point of the solid leg only
  const segs = route.legs[0].count - 1 + route.legs[1].count - 1;
  assert.equal(rb.segIndex.length, segs * 6);
  assert.equal(rb.joinIndex.length, route.legs[0].count * 6);
  const used = Math.max(...rb.segIndex, ...rb.joinIndex) + 1;
  assert.equal(used, segs * 4 + route.legs[0].count * 4);
  assert.ok(used * 10 <= rb.verts.length);
  // first segment: both ends carry the same unit direction of travel, sides -1 and +1, the running distance
  const vert = (k) => Array.from(rb.verts.slice(k * 10, k * 10 + 10));
  const [v0, v1, v2] = [vert(rb.segIndex[0]), vert(rb.segIndex[1]), vert(rb.segIndex[2])];
  near(Math.hypot(v0[3], v0[4], v0[5]), 1, 1e-6);
  assert.deepEqual([v0[6], v0[7], v1[6], v1[7]], [0, -1, 0, 1]);
  assert.equal(v0[8], 0);
  near(v2[8], route.s[1], 1e-4);
  assert.ok(v0[3] > 0 && v0[5] > 0, 'heading east and south');
  // dashed flag per leg
  assert.equal(v0[9], 0);
  assert.equal(vert(rb.segIndex[rb.segIndex.length - 1])[9], 1);
});

// ---- heading ----

test('bearingOf and headingAt: compass bearings clockwise from north', () => {
  near(bearingOf(0, -1), 0);        // north is -z
  near(bearingOf(1, 0), 90);
  near(bearingOf(0, 1), 180);
  near(bearingOf(-1, 0), 270);
  const dir = (pts) => headingAt(buildRoute([leg('A', pts)], METRES, 5), 50, 20);
  near(dir([[0, 0], [0, 100]]), 0, 1e-9);           // walking north
  near(dir([[0, 0], [100, 0]]), 90, 1e-9);
  near(dir([[0, 0], [0, -100]]), 180, 1e-9);
  near(dir([[0, 0], [-100, 0]]), 270, 1e-9);
  near(dir([[0, 0], [100, 100]]), 45, 1e-9);
  assert.equal(headingAt(buildRoute([], METRES, 5), 0, 20), 0);
});

test('headingAt: turns gradually through a right-angle corner and is defined at both ends', () => {
  const route = buildRoute([leg('A', [[0, 0], [0, 100], [100, 100]])], METRES, 5);   // north, then east
  const span = 40;
  near(headingAt(route, 0, span), 0, 1e-9);
  near(headingAt(route, 50, span), 0, 1e-9);
  near(headingAt(route, 150, span), 90, 1e-9);
  near(headingAt(route, 200, span), 90, 1e-9);
  // the chord runs from 10 m behind to 30 m ahead: half and half when the head is 10 m short of the corner
  near(headingAt(route, 90, span), 45, 1e-9);
  let prev = headingAt(route, 0, span), biggest = 0;
  for (let s = 0.5; s <= 200; s += 0.5) {
    const h = headingAt(route, s, span);
    assert.ok(h >= prev - 1e-9, 'never turns back');
    biggest = Math.max(biggest, h - prev);
    prev = h;
  }
  assert.ok(biggest < 2.5, `largest step per half metre is ${biggest} degrees, where the raw direction jumps 90`);
  // a span longer than the route uses the whole route
  near(headingAt(route, 100, 1000), 45, 1e-9);
});

test('angleDiff: shortest signed turn', () => {
  near(angleDiff(10, 350), 20);
  near(angleDiff(350, 10), -20);
  near(angleDiff(180, 0), 180);
  near(angleDiff(0, 180), 180);
  near(angleDiff(90, 90), 0);
  near(angleDiff(725, 0), 5);
  near(angleDiff(-90, 0), -90);
});

test('smoothHeading: low-pass step across north, never the long way round', () => {
  near(smoothHeading(350, 10, 0.5), 0, 1e-9);
  near(smoothHeading(10, 350, 0.5), 0, 1e-9);
  near(smoothHeading(350, 10, 0.25), 355, 1e-9);
  near(smoothHeading(90, 180, 0), 90, 1e-9);
  near(smoothHeading(90, 180, 1), 180, 1e-9);
  near(smoothHeading(90, 180, 5), 180, 1e-9);       // alpha is clamped
  near(smoothHeading(359, 1, 1), 1, 1e-9);
  const h = smoothHeading(-10, 20, 0.5);
  assert.ok(h >= 0 && h < 360);
  near(h, 5, 1e-9);
});

test('smoothHeading: a sudden 90 degree turn is spread over many frames and settles on the target', () => {
  let h = 0, biggest = 0;
  const alpha = 1 - Math.exp(-16 / 600);            // one 16 ms frame with a 0.6 s time constant
  for (let frame = 0; frame < 600; frame++) {
    const next = smoothHeading(h, 90, alpha);
    const step = Math.abs(angleDiff(next, h));
    assert.ok(step <= 90 * alpha + 1e-9);
    assert.ok(angleDiff(90, next) >= -1e-9, 'never overshoots');
    biggest = Math.max(biggest, step);
    h = next;
  }
  assert.ok(biggest < 2.5, `largest turn in one frame is ${biggest} degrees`);
  near(h, 90, 1e-3);
  // two stages in a row, as the fly-along uses: the turn also starts gently
  let a = 0, b = 0;
  const steps = [];
  for (let frame = 0; frame < 400; frame++) {
    a = smoothHeading(a, 90, alpha);
    const nb = smoothHeading(b, a, alpha);
    steps.push(angleDiff(nb, b));
    b = nb;
  }
  assert.ok(steps[0] < 0.1, 'starts slowly');
  assert.ok(Math.max(...steps) < 1, 'and never turns fast');
  for (let i = 1; i < steps.length; i++) assert.ok(Math.abs(steps[i] - steps[i - 1]) < 0.07, 'the turn rate changes a little at a time');
  near(b, 90, 0.05);
});

test('easeProgress: starts and ends at rest, constant speed between, never backwards', () => {
  near(easeProgress(0), 0);
  near(easeProgress(1), 1);
  near(easeProgress(0.5), 0.5, 1e-12);
  near(easeProgress(-1), 0);
  near(easeProgress(2), 1);
  let prev = 0;
  for (let k = 1; k <= 1000; k++) {
    const v = easeProgress(k / 1000);
    assert.ok(v >= prev);
    assert.ok(v - prev <= 0.00112, 'speed never above 1 / 0.9 of the average');
    prev = v;
  }
  assert.ok(easeProgress(0.001) < 1e-5);
  near(easeProgress(0.4) - easeProgress(0.3), easeProgress(0.7) - easeProgress(0.6), 1e-12);
});

test('niceLength: 1, 2 or 5 times a power of ten, not above the limit', () => {
  assert.equal(niceLength(85), 50);
  assert.equal(niceLength(100), 100);
  assert.equal(niceLength(249), 200);
  assert.equal(niceLength(4999), 2000);
  assert.equal(niceLength(7), 5);
  near(niceLength(0.3), 0.2, 1e-12);
  assert.equal(niceLength(0), 0);
});

// ---- the view without WebGL ----

test('createView3D: throws a clear error when WebGL is not available', () => {
  assert.throws(() => createView3D({ getContext: () => null }), /WebGL is not available/);
  assert.throws(() => createView3D({ getContext: () => { throw new Error('blocked'); } }), /WebGL is not available/);
  assert.throws(() => createView3D(null), /canvas/);
  assert.throws(() => createView3D({}), /canvas/);
});
