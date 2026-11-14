// 3D terrain view: an oblique WebGL 1 view of the elevation grid in which the planned route draws itself
// along the ground while the camera follows it. No dependencies. The pure maths at the top of the file
// runs in Node (tests/view3d.test.mjs); only createView3D touches the DOM and WebGL.
//
// Scene coordinates (right-handed, metres):
//   x = east, y = up, z = south. North is -z.
//   The origin is the middle of the terrain mesh; y = 0 is the lowest elevation in the shown region and
//   heights are multiplied by the vertical exaggeration. Horizontal distances are never exaggerated.
// Seen from straight above with north at the top of the screen, east is on the right (not mirrored).
// Compass angles are degrees clockwise from north, as in terrain.js.
// Matrices are column-major arrays of 16 numbers, the layout WebGL expects.
//
// Left out: the route and the markers are placed on the drawn mesh, so on a decimated mesh (stride > 1)
// they follow the simplified ground, not every 6 m cell. Labels are not hidden behind terrain. Route
// points outside the region are held at the height of the nearest mesh edge.

const DEG = Math.PI / 180;

export const MAX_VERTS = 200000;       // terrain mesh budget; larger regions are decimated by an integer stride
export const DEFAULT_EXAGGERATION = 1.5;
const FOV_Y = 40 * DEG;
const LIFT_M = 1;                      // the route floats this far above the mesh
const SOURCE_NOTE = 'elevation: MRO HiRISE model via NASA Mars Trek';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

// ---------------------------------------------------------------------------------------------
// Matrices
// ---------------------------------------------------------------------------------------------

// Perspective projection, camera looking down -z, clip z from -1 (near) to +1 (far).
export function mat4Perspective(fovYRad, aspect, near, far) {
  const f = 1 / Math.tan(fovYRad / 2);
  const m = new Float64Array(16);
  m[0] = f / aspect;
  m[5] = f;
  m[10] = (far + near) / (near - far);
  m[11] = -1;
  m[14] = (2 * far * near) / (near - far);
  return m;
}

// View matrix for a camera at `eye` looking at `target`. eye, target, up are [x, y, z].
export function mat4LookAt(eye, target, up) {
  let fx = target[0] - eye[0], fy = target[1] - eye[1], fz = target[2] - eye[2];
  let l = Math.hypot(fx, fy, fz) || 1;
  fx /= l; fy /= l; fz /= l;
  let sx = fy * up[2] - fz * up[1], sy = fz * up[0] - fx * up[2], sz = fx * up[1] - fy * up[0];   // side = f x up
  l = Math.hypot(sx, sy, sz) || 1;
  sx /= l; sy /= l; sz /= l;
  const ux = sy * fz - sz * fy, uy = sz * fx - sx * fz, uz = sx * fy - sy * fx;                   // true up = s x f
  const m = new Float64Array(16);
  m[0] = sx; m[1] = ux; m[2] = -fx;
  m[4] = sy; m[5] = uy; m[6] = -fy;
  m[8] = sz; m[9] = uz; m[10] = -fz;
  m[12] = -(sx * eye[0] + sy * eye[1] + sz * eye[2]);
  m[13] = -(ux * eye[0] + uy * eye[1] + uz * eye[2]);
  m[14] = fx * eye[0] + fy * eye[1] + fz * eye[2];
  m[15] = 1;
  return m;
}

// a * b: the result applies b first, then a.
export function mat4Multiply(a, b) {
  const m = new Float64Array(16);
  for (let c = 0; c < 4; c++) {
    for (let r = 0; r < 4; r++) {
      m[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return m;
}

// m * (x, y, z, 1) -> [x, y, z, w]
export function mat4TransformPoint(m, x, y, z) {
  return [
    m[0] * x + m[4] * y + m[8] * z + m[12],
    m[1] * x + m[5] * y + m[9] * z + m[13],
    m[2] * x + m[6] * y + m[10] * z + m[14],
    m[3] * x + m[7] * y + m[11] * z + m[15],
  ];
}

// Scene point -> pixel position in a width x height viewport, y down. w <= 0 means behind the camera.
export function projectPoint(viewProj, x, y, z, width, height) {
  const c = mat4TransformPoint(viewProj, x, y, z);
  const w = c[3];
  if (!(w > 1e-9)) return { x: NaN, y: NaN, w, visible: false };
  const px = (c[0] / w * 0.5 + 0.5) * width;
  const py = (0.5 - c[1] / w * 0.5) * height;
  return { x: px, y: py, w, visible: px >= 0 && px <= width && py >= 0 && py <= height && c[2] >= -w && c[2] <= w };
}

// Translate, then turn about the vertical axis, then scale. rotY turns local +z toward +x.
function modelMatrix(x, y, z, sx, sy, sz, rotY = 0) {
  const c = Math.cos(rotY), s = Math.sin(rotY);
  return [c * sx, 0, -s * sx, 0, 0, sy, 0, 0, s * sz, 0, c * sz, 0, x, y, z, 1];
}

// ---------------------------------------------------------------------------------------------
// Sub-grid, frame and heights
// ---------------------------------------------------------------------------------------------

const vertsAt = (cells, stride) => Math.floor((cells - 1) / stride) + 1;

// Smallest integer stride that keeps a cols x rows block of cells at or under maxVerts mesh vertices.
// 400 x 400 cells fit at stride 1.
export function chooseStride(cols, rows, maxVerts = MAX_VERTS) {
  let s = 1;
  while (vertsAt(cols, s) * vertsAt(rows, s) > maxVerts) s++;
  return s;
}

// The block of grid cells that covers `region` ({ south, west, north, east }), clamped to the grid.
// c0, r0: first column and row. cols, rows: cells covered. nx, nz: mesh vertices east-west and north-south.
// Vertex (i, j) sits on the centre of cell (c0 + i * stride, r0 + j * stride).
export function subGrid(grid, region, maxVerts = MAX_VERTS) {
  const { w, h } = grid;
  if (!(w >= 2 && h >= 2)) throw new Error('view3d: the elevation grid needs at least 2 x 2 cells');
  const [[S, W], [N, E]] = grid.bounds;
  const r = region || { south: S, west: W, north: N, east: E };
  const south = Math.min(r.south, r.north), north = Math.max(r.south, r.north);
  const west = Math.min(r.west, r.east), east = Math.max(r.west, r.east);
  const c0 = clamp(Math.floor(((west - W) / (E - W)) * w), 0, w - 2);
  const c1 = clamp(Math.ceil(((east - W) / (E - W)) * w) - 1, c0 + 1, w - 1);
  const r0 = clamp(Math.floor(((N - north) / (N - S)) * h), 0, h - 2);
  const r1 = clamp(Math.ceil(((N - south) / (N - S)) * h) - 1, r0 + 1, h - 1);
  const cols = c1 - c0 + 1;
  const rows = r1 - r0 + 1;
  const stride = chooseStride(cols, rows, maxVerts);
  return { c0, r0, cols, rows, stride, nx: vertsAt(cols, stride), nz: vertsAt(rows, stride) };
}

// Where the scene origin sits and how many metres a degree is. Same flat metric grid as terrain.js.
export function makeFrame(grid, sub) {
  const [[S, W], [N, E]] = grid.bounds;
  const colMid = sub.c0 + ((sub.nx - 1) * sub.stride) / 2 + 0.5;
  const rowMid = sub.r0 + ((sub.nz - 1) * sub.stride) / 2 + 0.5;
  return {
    lat0: N - (rowMid / grid.h) * (N - S),
    lon0: W + (colMid / grid.w) * (E - W),
    mPerDegLat: (grid.dy * grid.h) / (N - S),
    mPerDegLon: (grid.dx * grid.w) / (E - W),
  };
}

// lat/lon -> { x: metres east of the origin, z: metres south of the origin }.
export function toScene(frame, lat, lon) {
  return { x: (lon - frame.lon0) * frame.mPerDegLon, z: (frame.lat0 - lat) * frame.mPerDegLat };
}

export function fromScene(frame, x, z) {
  return { lat: frame.lat0 - z / frame.mPerDegLat, lon: frame.lon0 + x / frame.mPerDegLon };
}

// The mesh lattice for a region. y holds scene heights: (elevation - lowest elevation) * exaggeration.
// Missing elevation (NaN) is drawn at the lowest elevation.
export function buildTerrain(grid, region, exaggeration = DEFAULT_EXAGGERATION, maxVerts = MAX_VERTS) {
  const sub = subGrid(grid, region, maxVerts);
  const frame = makeFrame(grid, sub);
  const { nx, nz, stride, c0, r0 } = sub;
  const y = new Float32Array(nx * nz);
  let lo = Infinity, hi = -Infinity;
  for (let j = 0, k = 0; j < nz; j++) {
    const row = (r0 + j * stride) * grid.w + c0;
    for (let i = 0; i < nx; i++, k++) {
      const e = grid.elev[row + i * stride];
      y[k] = e;
      if (e === e) { if (e < lo) lo = e; if (e > hi) hi = e; }
    }
  }
  if (lo === Infinity) { lo = 0; hi = 0; }
  for (let k = 0; k < y.length; k++) y[k] = ((y[k] === y[k] ? y[k] : lo) - lo) * exaggeration;
  const cellX = stride * grid.dx;
  const cellZ = stride * grid.dy;
  return {
    sub, frame, nx, nz, cellX, cellZ, y, exaggeration,
    halfX: ((nx - 1) * cellX) / 2, halfZ: ((nz - 1) * cellZ) / 2,
    elevMin: lo, elevMax: hi, yMax: (hi - lo) * exaggeration,
  };
}

// Scene height of the drawn mesh under (x, z): the same two triangles per lattice square that are drawn,
// so things placed with it sit on the visible surface. Outside the mesh the edge value is held.
export function heightAt(t, x, z) {
  const { nx, nz, y } = t;
  const fx = clamp((x + t.halfX) / t.cellX, 0, nx - 1);
  const fz = clamp((z + t.halfZ) / t.cellZ, 0, nz - 1);
  const i = Math.min(Math.floor(fx), nx - 2);
  const j = Math.min(Math.floor(fz), nz - 2);
  const u = fx - i, v = fz - j;
  const a = y[j * nx + i], c = y[j * nx + i + 1];
  const b = y[(j + 1) * nx + i], d = y[(j + 1) * nx + i + 1];
  return u + v <= 1 ? a + (c - a) * u + (b - a) * v : d + (b - d) * (1 - u) + (c - d) * (1 - v);
}

// Interleaved position + normal (6 floats per vertex). Normals come from central differences of the
// exaggerated heights, so the lighting belongs to the shape that is shown.
export function terrainVertices(t) {
  const { nx, nz, y, cellX, cellZ } = t;
  const out = new Float32Array(nx * nz * 6);
  for (let j = 0, k = 0, o = 0; j < nz; j++) {
    const jn = j > 0 ? j - 1 : j, js = j < nz - 1 ? j + 1 : j;
    for (let i = 0; i < nx; i++, k++, o += 6) {
      const iw = i > 0 ? i - 1 : i, ie = i < nx - 1 ? i + 1 : i;
      const gx = (y[j * nx + ie] - y[j * nx + iw]) / ((ie - iw) * cellX || 1);
      const gz = (y[js * nx + i] - y[jn * nx + i]) / ((js - jn) * cellZ || 1);
      const l = 1 / Math.sqrt(gx * gx + gz * gz + 1);
      out[o] = -t.halfX + i * cellX;
      out[o + 1] = y[k];
      out[o + 2] = -t.halfZ + j * cellZ;
      out[o + 3] = -gx * l;
      out[o + 4] = l;
      out[o + 5] = -gz * l;
    }
  }
  return out;
}

// Row bands that each hold at most maxVerts vertices, for drawing with 16-bit indices.
// Neighbouring bands share one row of vertices so no strip of ground is left out.
export function meshChunks(nx, nz, maxVerts = 65536) {
  const per = Math.max(2, Math.floor(maxVerts / nx));
  const out = [];
  for (let r = 0; r < nz - 1; r += per - 1) out.push({ row0: r, rows: Math.min(per, nz - r) });
  return out;
}

// Triangle indices for a lattice of nx x rows vertices. Each square (a = north-west, b = south-west,
// c = north-east, d = south-east) is split along b-c into a-b-c and c-b-d, counter-clockwise seen from above.
export function gridIndices(nx, rows, Type = Uint16Array) {
  const out = new Type((nx - 1) * (rows - 1) * 6);
  let o = 0;
  for (let j = 0; j < rows - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + nx, c = a + 1, d = b + 1;
      out[o++] = a; out[o++] = b; out[o++] = c;
      out[o++] = c; out[o++] = b; out[o++] = d;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------------------------

// Every original point is kept; evenly spaced points are added so no segment is longer than maxSeg.
export function resamplePolyline(pts, maxSeg) {
  const out = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (i > 0 && maxSeg > 0) {
      const q = pts[i - 1];
      const n = Math.ceil(Math.hypot(p.x - q.x, p.z - q.z) / maxSeg - 1e-9);
      for (let k = 1; k < n; k++) out.push({ x: q.x + ((p.x - q.x) * k) / n, z: q.z + ((p.z - q.z) * k) / n });
    }
    out.push({ x: p.x, z: p.z });
  }
  return out;
}

// Horizontal distance from the first point to each point, in metres.
export function cumulativeLength(pts) {
  const s = new Float64Array(pts.length);
  for (let i = 1; i < pts.length; i++) s[i] = s[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
  return s;
}

// All legs in walking order as one resampled line.
// x, z: scene position of each point. s: horizontal metres walked to reach it; a gap between the end of
// one leg and the start of the next adds nothing. legs: { id, dashed, first, count, s0, s1 } per leg.
// Legs with fewer than two usable points are skipped.
export function buildRoute(legs, frame, maxSeg) {
  const xs = [], zs = [], ss = [], info = [];
  let s = 0;
  for (const leg of legs || []) {
    const raw = [];
    for (const p of leg.pts || []) {
      if (p && Number.isFinite(p.lat) && Number.isFinite(p.lon)) raw.push(toScene(frame, p.lat, p.lon));
    }
    if (raw.length < 2) continue;
    const pts = resamplePolyline(raw, maxSeg);
    const first = xs.length;
    const s0 = s;
    for (let i = 0; i < pts.length; i++) {
      if (i) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].z - pts[i - 1].z);
      xs.push(pts[i].x); zs.push(pts[i].z); ss.push(s);
    }
    info.push({ id: leg.id, dashed: !!leg.dashed, first, count: pts.length, s0, s1: s });
  }
  return { n: xs.length, x: Float64Array.from(xs), z: Float64Array.from(zs), s: Float64Array.from(ss), legs: info, total: s };
}

// The point `dist` metres along the route (clamped to its ends). i is the route point at or before it.
export function pointAtDistance(route, dist) {
  const n = route.n;
  if (!n) return null;
  const s = clamp(dist || 0, 0, route.total);
  let lo = 0, hi = n - 1;
  while (lo < hi) {                       // last point with route.s <= s
    const mid = (lo + hi + 1) >> 1;
    if (route.s[mid] <= s) lo = mid; else hi = mid - 1;
  }
  if (lo >= n - 1) return { x: route.x[n - 1], z: route.z[n - 1], s: route.total, i: n - 1 };
  const span = route.s[lo + 1] - route.s[lo];
  const t = span > 0 ? (s - route.s[lo]) / span : 0;
  return {
    x: route.x[lo] + (route.x[lo + 1] - route.x[lo]) * t,
    z: route.z[lo] + (route.z[lo + 1] - route.z[lo]) * t,
    s, i: lo,
  };
}

// The point at fraction f (0..1) of the whole route length.
export function pointAtFraction(route, f) {
  return pointAtDistance(route, clamp(f || 0, 0, 1) * route.total);
}

// Compass bearing of a scene direction (dx east, dz south).
export function bearingOf(dx, dz) {
  return (Math.atan2(dx, -dz) / DEG + 360) % 360;
}

// Direction of travel near distance s, taken over a chord of `span` metres that starts a quarter of the
// span behind s. A chord changes smoothly through a corner where the segment direction would jump.
export function headingAt(route, s, span) {
  if (!route.n || !(route.total > 0)) return 0;
  const len = Math.min(Math.max(span, 1e-6), route.total);
  const s0 = clamp(s - len * 0.25, 0, route.total - len);
  const a = pointAtDistance(route, s0);
  const b = pointAtDistance(route, s0 + len);
  if (a.x === b.x && a.z === b.z) return 0;
  return bearingOf(b.x - a.x, b.z - a.z);
}

// Signed shortest turn from `from` to `to`, in (-180, 180].
export function angleDiff(to, from) {
  let d = (to - from) % 360;
  if (d > 180) d -= 360;
  if (d <= -180) d += 360;
  return d;
}

// One low-pass step of a compass heading: move the fraction alpha (0..1) of the shortest turn toward target.
export function smoothHeading(prev, target, alpha) {
  return (((prev + angleDiff(target, prev) * clamp(alpha, 0, 1)) % 360) + 360) % 360;
}

// Progress with a gentle start and stop: constant speed in the middle, a linear ramp of speed over the
// first and last tenth. u and the result run 0..1.
export function easeProgress(u) {
  const a = 0.1;
  const v = 1 / (1 - a);
  u = clamp(u, 0, 1);
  if (u < a) return (v * u * u) / (2 * a);
  if (u > 1 - a) return 1 - (v * (1 - u) * (1 - u)) / (2 * a);
  return v * (u - a / 2);
}

// Camera position for an orbit camera. cam = { tx, ty, tz, az, pitch, dist }: az is the compass direction
// the camera looks toward, pitch the angle it looks down by. az = 0 puts the camera south of the target.
export function orbitEye(cam) {
  const a = cam.az * DEG, p = cam.pitch * DEG;
  const h = cam.dist * Math.cos(p);
  return [cam.tx - Math.sin(a) * h, cam.ty + cam.dist * Math.sin(p), cam.tz + Math.cos(a) * h];
}

// Ribbon geometry for the route, 10 floats per vertex: position (3), unit direction of travel (3),
// corner (along, across: each -1, 0 or +1), metres along the route, dashed 0 | 1.
// Every segment is a quad of its own (corner = (0, +-1)) and every point of a solid leg also gets a square
// (corner = (+-1, +-1)) that the fragment shader cuts round, which closes the outside of each bend.
// The buffer is sized for the most it can hold; dashed legs leave the tail unused.
// The vertex shader pushes the corners apart on screen. segIndex and joinIndex are triangle indices.
export function buildRibbon(route, terrain, lift = LIFT_M) {
  let segs = 0;
  for (const leg of route.legs) segs += leg.count - 1;
  const verts = new Float32Array((segs + route.n) * 4 * 10);
  const segIndex = [], joinIndex = [];
  const py = new Float32Array(route.n);
  for (let i = 0; i < route.n; i++) py[i] = heightAt(terrain, route.x[i], route.z[i]) + lift;
  let v = 0;
  const put = (i, dir, cx, cy, dashed) => {
    const o = v * 10;
    verts[o] = route.x[i]; verts[o + 1] = py[i]; verts[o + 2] = route.z[i];
    verts[o + 3] = dir[0]; verts[o + 4] = dir[1]; verts[o + 5] = dir[2];
    verts[o + 6] = cx; verts[o + 7] = cy; verts[o + 8] = route.s[i]; verts[o + 9] = dashed;
    return v++;
  };
  for (const leg of route.legs) {
    const last = leg.first + leg.count - 1;
    const dashed = leg.dashed ? 1 : 0;
    let dir = [1, 0, 0];
    for (let i = leg.first; i <= last; i++) {
      if (i < last) {
        const dx = route.x[i + 1] - route.x[i], dy = py[i + 1] - py[i], dz = route.z[i + 1] - route.z[i];
        const l = Math.hypot(dx, dy, dz);
        if (l > 0) dir = [dx / l, dy / l, dz / l];
        const a = put(i, dir, 0, -1, dashed), b = put(i, dir, 0, 1, dashed);
        const c = put(i + 1, dir, 0, -1, dashed), d = put(i + 1, dir, 0, 1, dashed);
        segIndex.push(a, b, c, c, b, d);
      }
      if (dashed) continue;               // a dash has square ends; round joins would bead it
      const a = put(i, dir, -1, -1, 0), b = put(i, dir, -1, 1, 0);
      const c = put(i, dir, 1, -1, 0), d = put(i, dir, 1, 1, 0);
      joinIndex.push(a, b, c, c, b, d);
    }
  }
  return { verts, segIndex, joinIndex, y: py };
}

// 1, 2 or 5 times a power of ten, at most maxM.
export function niceLength(maxM) {
  if (!(maxM > 0)) return 0;
  const p = Math.pow(10, Math.floor(Math.log10(maxM)));
  const m = maxM / p;
  return (m >= 5 ? 5 : m >= 2 ? 2 : 1) * p;
}

// ---------------------------------------------------------------------------------------------
// Shapes for the markers: plain triangles, 6 floats per vertex (position, normal)
// ---------------------------------------------------------------------------------------------

function shapeCylinder(seg = 14) {              // radius 1, y from 0 to 1, with a top cap
  const v = [];
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * 2 * Math.PI, a1 = ((k + 1) / seg) * 2 * Math.PI;
    const x0 = Math.cos(a0), z0 = Math.sin(a0), x1 = Math.cos(a1), z1 = Math.sin(a1);
    v.push(x0, 0, z0, x0, 0, z0, x1, 0, z1, x1, 0, z1, x0, 1, z0, x0, 0, z0);
    v.push(x0, 1, z0, x0, 0, z0, x1, 0, z1, x1, 0, z1, x1, 1, z1, x1, 0, z1);
    v.push(0, 1, 0, 0, 1, 0, x0, 1, z0, 0, 1, 0, x1, 1, z1, 0, 1, 0);
  }
  return v;
}

function shapeCone(seg = 18) {                  // apex at the origin, base of radius 1 at y = 1, capped
  const v = [];
  for (let k = 0; k < seg; k++) {
    const a0 = (k / seg) * 2 * Math.PI, a1 = ((k + 1) / seg) * 2 * Math.PI;
    const x0 = Math.cos(a0), z0 = Math.sin(a0), x1 = Math.cos(a1), z1 = Math.sin(a1);
    v.push(0, 0, 0, (x0 + x1) / 2, -0.4, (z0 + z1) / 2, x0, 1, z0, x0, -0.4, z0, x1, 1, z1, x1, -0.4, z1);
    v.push(0, 1, 0, 0, 1, 0, x0, 1, z0, 0, 1, 0, x1, 1, z1, 0, 1, 0);
  }
  return v;
}

function shapeSphere(rings = 8, seg = 12) {     // radius 1 about the origin
  const v = [];
  const pt = (i, k) => {
    const th = (i / rings) * Math.PI, ph = (k / seg) * 2 * Math.PI;
    return [Math.sin(th) * Math.cos(ph), Math.cos(th), Math.sin(th) * Math.sin(ph)];
  };
  for (let i = 0; i < rings; i++) {
    for (let k = 0; k < seg; k++) {
      const a = pt(i, k), b = pt(i + 1, k), c = pt(i, k + 1), d = pt(i + 1, k + 1);
      for (const p of [a, b, c, c, b, d]) v.push(p[0], p[1], p[2], p[0], p[1], p[2]);
    }
  }
  return v;
}

function shapeStar(inner = 0.42) {              // five points, outer radius 1, upright in the x-y plane
  const v = [];
  const pt = (k) => {
    const r = k % 2 ? inner : 1, a = Math.PI / 2 + (k / 10) * 2 * Math.PI;
    return [Math.cos(a) * r, Math.sin(a) * r];
  };
  for (let k = 0; k < 10; k++) {
    const p = pt(k), q = pt(k + 1);
    v.push(0, 0, 0, 0, 0.6, 0.8, p[0], p[1], 0, 0, 0.6, 0.8, q[0], q[1], 0, 0, 0.6, 0.8);
  }
  return v;
}

// ---------------------------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------------------------

const PRECISION = `
#ifdef GL_FRAGMENT_PRECISION_HIGH
precision highp float;
#else
precision mediump float;
#endif
`;

const SKY_VS = `
attribute vec2 a_pos;
varying float v_up;
void main() { v_up = a_pos.y * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }
`;
const SKY_FS = `${PRECISION}
varying float v_up;
uniform vec3 u_top;
uniform vec3 u_horizon;
void main() { gl_FragColor = vec4(mix(u_horizon, u_top, smoothstep(0.25, 1.0, v_up)), 1.0); }
`;

const TERRAIN_VS = `
attribute vec3 a_pos;
attribute vec3 a_normal;
uniform mat4 u_vp;
uniform vec3 u_eye;
varying vec3 v_pos;
varying vec3 v_normal;
varying float v_dist;
void main() {
  v_pos = a_pos;
  v_normal = a_normal;
  v_dist = distance(a_pos, u_eye);
  gl_Position = u_vp * vec4(a_pos, 1.0);
}
`;
const TERRAIN_FS = `${PRECISION}
varying vec3 v_pos;
varying vec3 v_normal;
varying float v_dist;
uniform sampler2D u_tex;
uniform sampler2D u_nogo;
uniform float u_hasTex;
uniform float u_hasNogo;
uniform vec4 u_texRect;     // west x, north z, 1 / width, 1 / depth
uniform vec4 u_nogoRect;
uniform vec3 u_light;       // unit vector toward the light
uniform float u_yMax;
uniform vec3 u_fog;
uniform vec2 u_fogRange;    // start distance, 1 / length
uniform float u_hatch;      // hatch period in metres
uniform float u_mPerPx;     // metres one pixel covers at 1 m from the eye
void main() {
  vec3 n = normalize(v_normal);
  float lambert = max(dot(n, u_light), 0.0);
  float shade = min(0.24 + 0.76 * pow(lambert * 1.41421, 1.8), 1.26);   // level ground comes out at 1, slopes are pushed apart
  vec3 col;
  if (u_hasTex > 0.5) {
    vec2 uv = (v_pos.xz - u_texRect.xy) * u_texRect.zw;
    col = texture2D(u_tex, uv).rgb * mix(1.0, shade, 0.6);
  } else {
    float t = clamp(v_pos.y / max(u_yMax, 1.0), 0.0, 1.0);
    col = mix(vec3(0.57, 0.515, 0.455), vec3(0.74, 0.73, 0.715), t) * shade;
  }
  if (u_hasNogo > 0.5) {
    vec2 nuv = (v_pos.xz - u_nogoRect.xy) * u_nogoRect.zw;
    float k = smoothstep(0.35, 0.65, texture2D(u_nogo, nuv).r);
    float stripe = step(0.5, fract((v_pos.x + v_pos.z) / u_hatch));
    float keep = clamp(u_hatch / (v_dist * u_mPerPx * 4.0) - 0.5, 0.0, 1.0);   // drop the hatch where it would alias
    col = mix(col, vec3(0.80, 0.05, 0.10), k * (0.34 + 0.30 * stripe * keep));
  }
  float fog = clamp((v_dist - u_fogRange.x) * u_fogRange.y, 0.0, 1.0);
  col = mix(col, u_fog, fog * 0.5);
  gl_FragColor = vec4(col, 1.0);
}
`;

const SOLID_VS = `
attribute vec3 a_pos;
attribute vec3 a_normal;
uniform mat4 u_vp;
uniform mat4 u_model;
uniform vec3 u_light;
uniform float u_lit;
varying float v_shade;
void main() {
  vec3 n = normalize((u_model * vec4(a_normal, 0.0)).xyz);
  v_shade = mix(1.0, 0.55 + 0.45 * max(dot(n, u_light), 0.0) + 0.15 * n.y, u_lit);
  gl_Position = u_vp * (u_model * vec4(a_pos, 1.0));
}
`;
const SOLID_FS = `${PRECISION}
varying float v_shade;
uniform vec4 u_color;
void main() { gl_FragColor = vec4(u_color.rgb * v_shade, u_color.a); }
`;

const RIBBON_VS = `
attribute vec3 a_pos;
attribute vec3 a_dir;
attribute vec4 a_misc;        // corner along, corner across, metres along the route, dashed
uniform mat4 u_vp;
uniform vec2 u_viewport;      // device pixels
uniform float u_pxPerM;       // device pixels per metre at clip w = 1
uniform float u_minHalfPx;
uniform float u_halfM;
uniform float u_casePx;
uniform float u_progress;     // metres already walked
uniform float u_zBias;
varying float v_rel;
varying float v_s;
varying float v_dash;
varying vec4 v_edge;          // pixels from the centre (along, across), half width of the coloured core, half width in all
void main() {
  vec4 c0 = u_vp * vec4(a_pos, 1.0);
  vec4 c1 = u_vp * vec4(a_pos + a_dir, 1.0);
  vec2 d = (c1.xy * c0.w - c0.xy * c1.w) * u_viewport;
  float len = length(d);
  d = len > 1e-9 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-d.y, d.x);
  float core = clamp(u_halfM * u_pxPerM / max(c0.w, 1e-4), u_minHalfPx, u_minHalfPx * 3.5);
  float total = core + u_casePx;
  c0.xy += (d * a_misc.x + nrm * a_misc.y) * total * 2.0 / u_viewport * c0.w;
  c0.z += u_zBias;
  v_rel = a_misc.z - u_progress;
  v_s = a_misc.z;
  v_dash = a_misc.w;
  v_edge = vec4(a_misc.xy * total, core, total);
  gl_Position = c0;
}
`;
const RIBBON_FS = `${PRECISION}
varying float v_rel;
varying float v_s;
varying float v_dash;
varying vec4 v_edge;
uniform vec3 u_ahead;
uniform vec3 u_behind;
uniform vec3 u_case;
uniform float u_alpha;
uniform float u_mode;         // 0 = core with its casing in one go, 1 = casing only, 2 = core only
uniform float u_dashPeriod;
uniform float u_dashPad;      // how far the casing reaches past each end of a dash, metres
void main() {
  float dist = length(v_edge.xy);
  if (dist > v_edge.w + 0.25) discard;
  if (v_dash > 0.5 && mod(v_s + u_dashPad, u_dashPeriod) > u_dashPeriod * 0.58 + 2.0 * u_dashPad) discard;
  float casing = u_mode > 1.5 ? 0.0 : u_mode > 0.5 ? 1.0 : smoothstep(v_edge.z - 0.6, v_edge.z + 0.6, dist);
  vec3 col = mix(v_rel < 0.0 ? u_behind : u_ahead, u_case, casing);
  gl_FragColor = vec4(col, u_alpha);
}
`;

// ---------------------------------------------------------------------------------------------
// Colours (css/style.css tokens)
// ---------------------------------------------------------------------------------------------

const hex = (h) => [parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255];
const COL = {
  route: hex('#ff5cf4'),      // planned route, current step
  walked: hex('#ffffff'),
  casing: hex('#0d0d0d'),
  skyTop: hex('#0d0d0d'),
  horizon: hex('#2b2b2b'),
  post: hex('#f2f2f2'),
  skirt: hex('#2b2b2b'),
  adv: hex('#7fb0ff'),
};
const CSS = { box: 'rgba(13,13,13,0.88)', line: '#6e6e6e', text: '#f2f2f2', label: '#c4c4c4', route: '#ff5cf4' };

function parseColour(c) {
  if (typeof c === 'string') {
    let m = /^#([0-9a-f]{6})$/i.exec(c.trim());
    if (m) return hex(`#${m[1]}`);
    m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c.trim());
    if (m) return hex(`#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------------------------

// createView3D(canvas, opts?) -> view
//
// canvas: the <canvas> to draw into. It should sit in a positioned container; a second, click-through
// canvas for the labels is added right after it (view.overlay).
// opts.maxVerts: terrain vertex budget. opts.forceUint16: draw in 16-bit chunks even when 32-bit indices
// exist (for testing the fallback).
// Throws an Error when WebGL is not available, so the caller can fall back to the map.
//
// view.setScene(scene)   scene = {
//     grid,                                   terrain.js grid
//     region: { south, west, north, east },   part of the grid to show; clamped to the grid; whole grid when missing
//     exaggeration,                           vertical exaggeration, default 1.5; always printed on the view
//     texture,                                canvas or image cut to exactly `region`, north up; null = grey relief
//     nogo,                                   Uint8Array over the full grid, 1 = avoid; drawn as a red hatch
//     legs: [{ id, pts: [{ lat, lon }], dashed }],   the route in walking order
//     stations: [{ lat, lon, label }], refuge: { lat, lon, label }, marks: [{ lat, lon, label, colour }],
//     credit,                                 text after the exaggeration note; default names the elevation source
//   }
//   The camera is reframed when the region or the exaggeration changes, and kept otherwise.
// view.setProgress(f, { follow }?)   f = 0..1 of the route length walked: white behind, magenta ahead, a pin
//   at the head. follow: true also puts the camera behind the head.
// view.flyAlong(durationMs, onProgress?, { reducedMotion }?) -> Promise<boolean>   true at the end, false if
//   cancelled or there is no route; rejects if onProgress throws. Drag and wheel adjust the following camera.
// view.cancel()   view.resetCamera()   view.getCamera()   view.setCamera({ az, pitch, dist, target: { lat, lon } })
// view.project(lat, lon, heightM?) -> { x, y, w, visible } in CSS pixels   view.resize()   view.render()
// view.destroy()   view.progress   view.flying   view.routeLengthM   view.stats()
// Mouse and touch: drag rotates, wheel or pinch zooms, right-drag or shift-drag or two fingers pans.
export function createView3D(canvas, opts = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') throw new Error('view3d: createView3D needs a <canvas> element');
  const attrs = { antialias: true, alpha: false, depth: true, stencil: false, preserveDrawingBuffer: false };
  let gl = null;
  try { gl = canvas.getContext('webgl', attrs) || canvas.getContext('experimental-webgl', attrs); } catch { gl = null; }
  if (!gl) throw new Error('view3d: WebGL is not available in this browser, so the 3D terrain view cannot be shown');

  const maxVerts = opts.maxVerts || MAX_VERTS;
  const doc = canvas.ownerDocument;
  const win = doc.defaultView;
  const overlay = doc.createElement('canvas');
  overlay.setAttribute('aria-hidden', 'true');
  overlay.style.cssText = 'position:absolute;pointer-events:none;left:0;top:0;';
  const ctx2d = overlay.getContext('2d');
  if (!canvas.hasAttribute('aria-label')) {
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', '3D terrain view of the planned route');
  }
  const prevTouchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  let G = null;                 // GL objects that do not depend on the scene
  let R = null;                 // GL objects of the current scene
  let S = null;                 // CPU side of the current scene
  let sceneIn = null;           // the scene as given, kept to rebuild after a lost context
  let lost = false;
  let destroyed = false;
  let raf = 0;
  let lastT = 0;
  let dirty = false;
  let progress = 0;
  let cssW = 0, cssH = 0, dpr = 1;
  const cam = { tx: 0, ty: 0, tz: 0, az: 0, pitch: 35, dist: 500 };
  let M = null;                 // matrices of the last drawn frame
  let fly = null;
  let inertia = null;
  let eyeLift = 0;
  let frameDt = 16;
  const m32 = new Float32Array(16);
  const f32 = (m) => { m32.set(m); return m32; };
  const stats = { vertices: 0, triangles: 0, stride: 1, chunks: 0, routePoints: 0, frames: 0, lastFrameMs: 0 };

  // ---- GL plumbing ----

  function compile(type, src) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS) && !gl.isContextLost()) {
      throw new Error(`view3d: shader did not compile: ${gl.getShaderInfoLog(sh)}`);
    }
    return sh;
  }

  function program(vs, fs, attribs) {
    const p = gl.createProgram();
    const a = compile(gl.VERTEX_SHADER, vs), b = compile(gl.FRAGMENT_SHADER, fs);
    gl.attachShader(p, a);
    gl.attachShader(p, b);
    attribs.forEach((name, i) => gl.bindAttribLocation(p, i, name));
    gl.linkProgram(p);
    gl.deleteShader(a);
    gl.deleteShader(b);
    const u = {};
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      if (!gl.isContextLost()) throw new Error(`view3d: shader program did not link: ${gl.getProgramInfoLog(p)}`);
      return { p, u };
    }
    const n = gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < n; i++) {
      const name = gl.getActiveUniform(p, i).name.replace(/\[0\]$/, '');
      u[name] = gl.getUniformLocation(p, name);
    }
    return { p, u };
  }

  function attribCount(n) {
    for (let i = 0; i < 3; i++) { if (i < n) gl.enableVertexAttribArray(i); else gl.disableVertexAttribArray(i); }
  }

  function staticBuffer(target, data) {
    const b = gl.createBuffer();
    gl.bindBuffer(target, b);
    gl.bufferData(target, data, gl.STATIC_DRAW);
    return b;
  }

  function initGL() {
    const shapes = { cylinder: shapeCylinder(), cone: shapeCone(), sphere: shapeSphere(), star: shapeStar() };
    const all = [];
    const range = {};
    for (const [name, v] of Object.entries(shapes)) {
      range[name] = { first: all.length / 6, count: v.length / 6 };
      for (let i = 0; i < v.length; i++) all.push(v[i]);
    }
    const white = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, white);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([255, 255, 255, 255]));
    G = {
      sky: program(SKY_VS, SKY_FS, ['a_pos']),
      terrain: program(TERRAIN_VS, TERRAIN_FS, ['a_pos', 'a_normal']),
      solid: program(SOLID_VS, SOLID_FS, ['a_pos', 'a_normal']),
      ribbon: program(RIBBON_VS, RIBBON_FS, ['a_pos', 'a_dir', 'a_misc']),
      quad: staticBuffer(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1])),
      shapes: staticBuffer(gl.ARRAY_BUFFER, new Float32Array(all)),
      range,
      white,
      uint: !opts.forceUint16 && !!gl.getExtension('OES_element_index_uint'),
      aniso: gl.getExtension('EXT_texture_filter_anisotropic') || gl.getExtension('WEBKIT_EXT_texture_filter_anisotropic'),
      maxTex: Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE) || 2048, 4096),
    };
  }

  function freeScene() {
    if (!R) return;
    for (const b of R.buffers) gl.deleteBuffer(b);
    for (const t of R.textures) gl.deleteTexture(t);
    R = null;
  }

  // ---- Scene ----

  // Slope mask for the shown block of cells as one byte per cell, at most maxTex on a side
  // (a block of cells becomes "avoid" when any cell in it is).
  function nogoTexture(nogo, grid, sub) {
    const k = Math.max(1, Math.ceil(Math.max(sub.cols, sub.rows) / G.maxTex));
    const tw = Math.ceil(sub.cols / k), th = Math.ceil(sub.rows / k);
    const px = new Uint8Array(tw * th);
    let any = false;
    for (let r = 0; r < sub.rows; r++) {
      const row = (sub.r0 + r) * grid.w + sub.c0;
      const o = Math.floor(r / k) * tw;
      for (let c = 0; c < sub.cols; c++) {
        if (nogo[row + c]) { px[o + Math.floor(c / k)] = 255; any = true; }
      }
    }
    if (!any) return null;
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.LUMINANCE, tw, th, 0, gl.LUMINANCE, gl.UNSIGNED_BYTE, px);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  // The drape image, copied to a power-of-two canvas so it can have mipmaps (WebGL 1 allows them on no
  // other size); without them a detailed image shimmers at a low viewing angle.
  function drapeTexture(image) {
    const iw = image.width || image.videoWidth || 0, ih = image.height || image.videoHeight || 0;
    if (!iw || !ih) return null;
    const pot = (n) => Math.min(G.maxTex, Math.pow(2, Math.round(Math.log2(Math.max(2, n)))));
    const c = doc.createElement('canvas');
    c.width = pot(iw);
    c.height = pot(ih);
    c.getContext('2d').drawImage(image, 0, 0, c.width, c.height);
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (G.aniso) gl.texParameterf(gl.TEXTURE_2D, G.aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(G.aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT) || 1));
    return tex;
  }

  // Walls from the edge of the mesh down to a little below the lowest ground, so the terrain reads as a block.
  function skirtVertices(t) {
    const v = [];
    const depth = -Math.max(6, 0.025 * Math.max(t.halfX, t.halfZ) * 2);
    const wall = (ax, ay, az, bx, by, bz, nx, nz) => {
      v.push(ax, ay, az, nx, 0, nz, bx, by, bz, nx, 0, nz, ax, depth, az, nx, 0, nz);
      v.push(bx, by, bz, nx, 0, nz, bx, depth, bz, nx, 0, nz, ax, depth, az, nx, 0, nz);
    };
    const X = (i) => -t.halfX + i * t.cellX, Z = (j) => -t.halfZ + j * t.cellZ;
    const Y = (i, j) => t.y[j * t.nx + i];
    for (let i = 0; i < t.nx - 1; i++) {
      wall(X(i), Y(i, 0), Z(0), X(i + 1), Y(i + 1, 0), Z(0), 0, -1);
      wall(X(i), Y(i, t.nz - 1), Z(t.nz - 1), X(i + 1), Y(i + 1, t.nz - 1), Z(t.nz - 1), 0, 1);
    }
    for (let j = 0; j < t.nz - 1; j++) {
      wall(X(0), Y(0, j), Z(j), X(0), Y(0, j + 1), Z(j + 1), -1, 0);
      wall(X(t.nx - 1), Y(t.nx - 1, j), Z(j), X(t.nx - 1), Y(t.nx - 1, j + 1), Z(j + 1), 1, 0);
    }
    return new Float32Array(v);
  }

  function buildScene() {
    freeScene();
    const sc = sceneIn;
    const grid = sc.grid;
    const exaggeration = Number.isFinite(sc.exaggeration) && sc.exaggeration > 0 ? sc.exaggeration : DEFAULT_EXAGGERATION;
    const [[gs, gw], [gn, ge]] = grid.bounds;
    const region = sc.region || { south: gs, west: gw, north: gn, east: ge };
    const t = buildTerrain(grid, region, exaggeration, maxVerts);
    const { sub, frame } = t;

    // Route: no segment longer than a mesh cell, and never more points than 16-bit indices can address.
    let rawLen = 0;
    for (const leg of sc.legs || []) {
      const p = leg.pts || [];
      for (let i = 1; i < p.length; i++) {
        const a = toScene(frame, p[i - 1].lat, p[i - 1].lon), b = toScene(frame, p[i].lat, p[i].lon);
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (d === d) rawLen += d;
      }
    }
    const maxPoints = G.uint ? 120000 : 8000;        // 8 ribbon vertices per point
    const maxSeg = Math.max(Math.min(t.cellX, t.cellZ), rawLen / (maxPoints * 0.6));
    let route = buildRoute(sc.legs, frame, maxSeg);
    for (let thin = 2; route.n > maxPoints && thin <= 1024; thin *= 2) {     // very many original points: keep every 2nd, 4th, ...
      const legs = (sc.legs || []).map((l) => ({ ...l, pts: (l.pts || []).filter((_, i, a) => i % thin === 0 || i === a.length - 1) }));
      route = buildRoute(legs, frame, maxSeg * thin);
    }
    const ribbon = buildRibbon(route, t, LIFT_M);

    const place = (p, kind, rgb, css) => {
      if (!p || !Number.isFinite(p.lat) || !Number.isFinite(p.lon)) return null;
      const q = toScene(frame, p.lat, p.lon);
      return { kind, x: q.x, z: q.z, y: heightAt(t, q.x, q.z), label: p.label == null ? '' : String(p.label), rgb, css };
    };
    const markers = [];
    for (const st of sc.stations || []) { const m = place(st, 'station', COL.post, CSS.route); if (m) markers.push(m); }
    for (const mk of sc.marks || []) {
      const rgb = parseColour(mk.colour) || COL.adv;
      const m = place(mk, 'mark', rgb, typeof mk.colour === 'string' ? mk.colour : '#7fb0ff');
      if (m) markers.push(m);
    }
    const refuge = place(sc.refuge, 'refuge', COL.walked, '#ffffff');
    if (refuge) markers.push(refuge);

    const sameView = S && S.key === [sub.c0, sub.r0, sub.cols, sub.rows, sub.stride, exaggeration].join();
    S = {
      key: [sub.c0, sub.r0, sub.cols, sub.rows, sub.stride, exaggeration].join(),
      grid, t, frame, sub, route, ribbonY: ribbon.y, markers, exaggeration,
      radius: Math.hypot(t.halfX, t.halfZ, t.yMax / 2),
      credit: typeof sc.credit === 'string' ? sc.credit : SOURCE_NOTE,
    };

    // GPU side
    R = { buffers: [], textures: [], chunks: [], tex: null, nogo: null };
    const keepB = (b) => { R.buffers.push(b); return b; };
    R.vbo = keepB(staticBuffer(gl.ARRAY_BUFFER, terrainVertices(t)));
    const chunks = G.uint ? [{ row0: 0, rows: t.nz }] : meshChunks(t.nx, t.nz, 65536);
    const byRows = new Map();
    for (const ch of chunks) {
      if (!byRows.has(ch.rows)) {
        const idx = gridIndices(t.nx, ch.rows, G.uint ? Uint32Array : Uint16Array);
        byRows.set(ch.rows, { buf: keepB(staticBuffer(gl.ELEMENT_ARRAY_BUFFER, idx)), count: idx.length });
      }
      R.chunks.push({ offset: ch.row0 * t.nx * 24, ...byRows.get(ch.rows) });
    }
    const skirt = skirtVertices(t);
    R.skirt = keepB(staticBuffer(gl.ARRAY_BUFFER, skirt));
    R.skirtCount = skirt.length / 6;
    R.ribbon = keepB(staticBuffer(gl.ARRAY_BUFFER, ribbon.verts));
    const RibbonIndex = G.uint ? Uint32Array : Uint16Array;
    R.ribbonIndex = keepB(staticBuffer(gl.ELEMENT_ARRAY_BUFFER, new RibbonIndex(ribbon.segIndex.concat(ribbon.joinIndex))));
    R.ribbonSegCount = ribbon.segIndex.length;
    R.ribbonCount = ribbon.segIndex.length + ribbon.joinIndex.length;

    if (sc.nogo && sc.nogo.length >= grid.w * grid.h) {
      R.nogo = nogoTexture(sc.nogo, grid, sub);
      if (R.nogo) R.textures.push(R.nogo);
      const x0 = -t.halfX - grid.dx * 0.5, z0 = -t.halfZ - grid.dy * 0.5;      // west and north edge of the first cell
      R.nogoRect = [x0, z0, 1 / (sub.cols * grid.dx), 1 / (sub.rows * grid.dy)];
    }
    if (sc.texture) {
      try { R.tex = drapeTexture(sc.texture); } catch { R.tex = null; }       // a tainted or empty image: fall back to the grey ramp
      if (R.tex) R.textures.push(R.tex);
      const nw = toScene(frame, Math.max(region.north, region.south), Math.min(region.west, region.east));
      const se = toScene(frame, Math.min(region.north, region.south), Math.max(region.west, region.east));
      R.texRect = [nw.x, nw.z, 1 / (se.x - nw.x || 1), 1 / (se.z - nw.z || 1)];
    }

    stats.vertices = t.nx * t.nz;
    stats.triangles = (t.nx - 1) * (t.nz - 1) * 2;
    stats.stride = sub.stride;
    stats.chunks = R.chunks.length;
    stats.routePoints = route.n;
    return sameView;
  }

  function setScene(scene) {
    if (destroyed) return;
    if (!scene || !scene.grid) throw new Error('view3d: setScene needs a scene with a grid');
    cancel();
    sceneIn = scene;
    if (lost) return;                       // built when the context comes back
    const sameView = buildScene();
    progress = clamp(progress, 0, 1);
    syncSize();
    if (!sameView) resetCamera(); else invalidate();
  }

  // ---- Camera ----

  function limits() {
    const r = S ? S.radius : 500;
    return { minDist: 12, maxDist: Math.max(200, r * 5) };
  }

  function resetCamera() {
    if (destroyed || !S) return;
    cancel();
    inertia = null;
    const t = S.t;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, y0 = Infinity, y1 = -Infinity;
    const add = (x, y, z) => {
      if (x < x0) x0 = x; if (x > x1) x1 = x;
      if (z < z0) z0 = z; if (z > z1) z1 = z;
      if (y < y0) y0 = y; if (y > y1) y1 = y;
    };
    for (let i = 0; i < S.route.n; i++) add(S.route.x[i], S.ribbonY[i], S.route.z[i]);
    if (S.route.n) for (const m of S.markers) add(m.x, m.y, m.z);
    if (x0 === Infinity) { add(-t.halfX, 0, -t.halfZ); add(t.halfX, t.yMax, t.halfZ); }
    const r = Math.max(40, Math.hypot(x1 - x0, y1 - y0, z1 - z0) / 2);
    const halfV = FOV_Y / 2;
    const halfH = Math.atan(Math.tan(halfV) * (cssW && cssH ? cssW / cssH : 1.5));
    const lim = limits();
    cam.tx = (x0 + x1) / 2;
    cam.tz = (z0 + z1) / 2;
    cam.ty = (y0 + y1) / 2;
    cam.az = 0;                             // looking north: the camera stands to the south
    cam.pitch = 36;
    cam.dist = clamp((r / Math.sin(Math.min(halfV, halfH))) * 0.92, lim.minDist, lim.maxDist);
    invalidate();
  }

  function getCamera() {
    return { az: cam.az, pitch: cam.pitch, dist: cam.dist, target: S ? { ...fromScene(S.frame, cam.tx, cam.tz), y: cam.ty } : null };
  }

  // Any of { az, pitch, dist, target: { lat, lon } }.
  function setCamera(c = {}) {
    if (destroyed) return;
    cancel();
    inertia = null;
    const lim = limits();
    if (Number.isFinite(c.az)) cam.az = ((c.az % 360) + 360) % 360;
    if (Number.isFinite(c.pitch)) cam.pitch = clamp(c.pitch, 4, 89.5);
    if (Number.isFinite(c.dist)) cam.dist = clamp(c.dist, lim.minDist, lim.maxDist);
    if (S && c.target && Number.isFinite(c.target.lat) && Number.isFinite(c.target.lon)) {
      const p = toScene(S.frame, c.target.lat, c.target.lon);
      cam.tx = p.x; cam.tz = p.z; cam.ty = heightAt(S.t, p.x, p.z);
    }
    invalidate();
  }

  function metresPerCssPx(w) { return (w * 2 * Math.tan(FOV_Y / 2)) / (cssH || 1); }

  function rotateBy(dx, dy) {
    if (fly) { fly.azOffset += dx * 0.25; fly.pitch = clamp(fly.pitch + dy * 0.25, 6, 80); return; }
    cam.az = (((cam.az + dx * 0.25) % 360) + 360) % 360;
    cam.pitch = clamp(cam.pitch + dy * 0.25, 4, 89.5);
  }

  function panBy(dx, dy) {
    if (fly || !S) return;
    const m = metresPerCssPx(cam.dist);
    const a = cam.az * DEG;
    const rx = Math.cos(a), rz = Math.sin(a);          // screen right on the ground
    const fx = Math.sin(a), fz = -Math.cos(a);         // screen up on the ground
    const along = (dy * m) / Math.max(0.35, Math.sin(cam.pitch * DEG));
    cam.tx = clamp(cam.tx - rx * dx * m + fx * along, -S.t.halfX, S.t.halfX);
    cam.tz = clamp(cam.tz - rz * dx * m + fz * along, -S.t.halfZ, S.t.halfZ);
    cam.ty += (heightAt(S.t, cam.tx, cam.tz) - cam.ty) * 0.25;
  }

  function zoomBy(factor) {
    const lim = limits();
    if (fly) { fly.dist = clamp(fly.dist * factor, lim.minDist, lim.maxDist); return; }
    cam.dist = clamp(cam.dist * factor, lim.minDist, lim.maxDist);
  }

  // ---- Pointer, wheel and touch ----

  const pointers = new Map();
  let dragMode = null;
  let pinch = null;
  let lastMove = 0;
  let vel = { az: 0, pitch: 0 };

  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, cx: (a.x + b.x) / 2, cy: (a.y + b.y) / 2 };
  }

  function onPointerDown(e) {
    if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
    try { canvas.setPointerCapture(e.pointerId); } catch { /* pointer already gone */ }
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    inertia = null;
    vel = { az: 0, pitch: 0 };
    if (pointers.size >= 2) { dragMode = 'pinch'; pinch = pinchState(); }
    else dragMode = e.button === 2 || e.shiftKey ? 'pan' : 'rotate';
    e.preventDefault();
  }

  function onPointerMove(e) {
    const p = pointers.get(e.pointerId);
    if (!p) return;
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    p.x = e.clientX; p.y = e.clientY;
    if (dragMode === 'pinch' && pointers.size >= 2) {
      const now = pinchState();
      zoomBy(pinch.d / now.d);
      panBy(now.cx - pinch.cx, now.cy - pinch.cy);
      pinch = now;
    } else if (dragMode === 'pan') {
      panBy(dx, dy);
    } else if (dragMode === 'rotate') {
      rotateBy(dx, dy);
      const t = performance.now();
      const dt = Math.max(1, t - lastMove);
      lastMove = t;
      vel.az = vel.az * 0.5 + ((dx * 0.25) / dt) * 0.5;
      vel.pitch = vel.pitch * 0.5 + ((dy * 0.25) / dt) * 0.5;
    }
    invalidate();
  }

  function onPointerUp(e) {
    if (!pointers.delete(e.pointerId)) return;
    try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
    if (pointers.size === 0) {
      if (dragMode === 'rotate' && !fly && performance.now() - lastMove < 90 && Math.hypot(vel.az, vel.pitch) > 0.01) {
        inertia = { az: clamp(vel.az, -0.3, 0.3), pitch: clamp(vel.pitch, -0.3, 0.3) };   // degrees per millisecond
        invalidate();
      }
      dragMode = null;
    } else if (pointers.size === 1) {
      dragMode = 'rotate';
    }
  }

  function onWheel(e) {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    zoomBy(Math.exp(clamp(e.deltaY * unit, -400, 400) * (e.ctrlKey ? 0.01 : 0.0016)));
    invalidate();
  }

  let gestureScale = 1;                     // Safari trackpad pinch
  const onGestureStart = (e) => { e.preventDefault(); gestureScale = e.scale || 1; };
  const onGestureChange = (e) => {
    e.preventDefault();
    if (e.scale > 0) { zoomBy(gestureScale / e.scale); gestureScale = e.scale; invalidate(); }
  };
  const onContextMenu = (e) => e.preventDefault();

  const onLost = (e) => {
    e.preventDefault();
    lost = true;
    G = null;
    R = null;
  };
  const onRestored = () => {
    if (destroyed) return;
    lost = false;
    initGL();
    if (sceneIn && !buildScene()) resetCamera();      // a scene given while the context was away gets its first framing now
    invalidate();
  };

  const listeners = [
    ['pointerdown', onPointerDown], ['pointermove', onPointerMove], ['pointerup', onPointerUp], ['pointercancel', onPointerUp],
    ['wheel', onWheel, { passive: false }], ['contextmenu', onContextMenu],
    ['gesturestart', onGestureStart], ['gesturechange', onGestureChange],
    ['webglcontextlost', onLost], ['webglcontextrestored', onRestored],
  ];
  for (const [type, fn, o] of listeners) canvas.addEventListener(type, fn, o);
  let observer = null;
  if (typeof win.ResizeObserver === 'function') {
    observer = new win.ResizeObserver(() => { if (syncSize()) invalidate(); });
    observer.observe(canvas);
  }

  // ---- Size ----

  // Match the drawing buffers to the size the canvas has on the page. Returns true when something changed.
  function syncSize() {
    if (!overlay.parentNode && canvas.parentNode) canvas.parentNode.insertBefore(overlay, canvas.nextSibling);
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return false;
    const ratio = Math.min(win.devicePixelRatio || 1, 2);
    const bw = Math.max(1, Math.round(w * ratio)), bh = Math.max(1, Math.round(h * ratio));
    const left = `${canvas.offsetLeft + canvas.clientLeft}px`, top = `${canvas.offsetTop + canvas.clientTop}px`;
    if (overlay.style.left !== left) overlay.style.left = left;
    if (overlay.style.top !== top) overlay.style.top = top;
    if (w === cssW && h === cssH && ratio === dpr && canvas.width === bw && canvas.height === bh) return false;
    cssW = w; cssH = h; dpr = ratio;
    canvas.width = bw; canvas.height = bh;
    overlay.width = bw; overlay.height = bh;
    overlay.style.width = `${w}px`;
    overlay.style.height = `${h}px`;
    return true;
  }

  function resize() {
    if (destroyed) return;
    syncSize();
    render();
  }

  // ---- Drawing ----

  function headPoint() {
    if (!S || !S.route.n) return null;
    const p = pointAtFraction(S.route, progress);
    return { x: p.x, z: p.z, y: heightAt(S.t, p.x, p.z) + LIFT_M, s: p.s };
  }

  function updateMatrices(dtMs) {
    const eye = orbitEye(cam);
    if (S) {                                 // keep the camera out of the ground
      const inside = Math.abs(eye[0]) <= S.t.halfX && Math.abs(eye[2]) <= S.t.halfZ;
      const need = inside ? Math.max(0, heightAt(S.t, eye[0], eye[2]) + 4 - eye[1]) : 0;
      if (fly && !fly.reduced) eyeLift = need > eyeLift ? eyeLift + (need - eyeLift) * 0.35 : eyeLift * Math.exp(-(dtMs || 16) / 700);
      else eyeLift = need;
      eye[1] += eyeLift;
    }
    const near = Math.max(0.5, cam.dist * 0.03);
    const far = cam.dist + (S ? S.radius : 500) * 3 + 200;
    const proj = mat4Perspective(FOV_Y, canvas.width / canvas.height, near, far);
    const view = mat4LookAt(eye, [cam.tx, cam.ty, cam.tz], [0, 1, 0]);
    M = { eye, proj, view, vp: mat4Multiply(proj, view) };
  }

  // Marker sizes follow the distance to the camera so a post is about the same height on screen at any zoom.
  function layoutMarkers() {
    const out = [];
    if (!S) return out;
    for (const m of S.markers) {
      const w = mat4TransformPoint(M.vp, m.x, m.y, m.z)[3];
      const px = Math.max(metresPerCssPx(Math.max(w, 1)), 0.02);
      const height = (m.kind === 'refuge' ? 58 : m.kind === 'mark' ? 30 : 44) * px;
      out.push({ m, px, height, w });
    }
    return out;
  }

  function drawShape(name, model, rgb, alpha, lit) {
    const u = G.solid.u;
    gl.uniformMatrix4fv(u.u_model, false, f32(model));
    gl.uniform4f(u.u_color, rgb[0], rgb[1], rgb[2], alpha);
    gl.uniform1f(u.u_lit, lit);
    gl.drawArrays(gl.TRIANGLES, G.range[name].first, G.range[name].count);
  }

  // A shape with a dark rim: a slightly larger black copy that leaves no depth behind, then the shape.
  function rimmed(name, x, y, z, sx, sy, sz, rot, rim, rgb, alpha, lit) {
    gl.depthMask(false);
    drawShape(name, modelMatrix(x, y - (name === 'sphere' || name === 'star' ? 0 : rim), z, sx + rim, sy + (name === 'sphere' || name === 'star' ? rim : 2 * rim), sz + rim, rot), COL.casing, alpha, 0);
    gl.depthMask(true);
    drawShape(name, modelMatrix(x, y, z, sx, sy, sz, rot), rgb, alpha, lit);
  }

  function drawMarkers(layout, head, alpha) {
    // A flat shape turned to face the camera squarely: its axes are the camera's right, up and back.
    const V = M.view;
    const facing = (x, y, z, r) => [V[0] * r, V[4] * r, V[8] * r, 0, V[1] * r, V[5] * r, V[9] * r, 0, V[2] * r, V[6] * r, V[10] * r, 0, x, y, z, 1];
    for (const { m, px, height } of layout) {
      const rim = 1.1 * px;
      rimmed('cylinder', m.x, m.y, m.z, 1.3 * px, height, 1.3 * px, 0, rim, COL.post, alpha, 0.6);
      if (m.kind === 'station') {
        rimmed('cylinder', m.x, m.y + height, m.z, 8 * px, 3 * px, 8 * px, 0, rim, COL.route, alpha, 0.35);
        drawShape('cylinder', modelMatrix(m.x, m.y + height + 3 * px, m.z, 3.4 * px, 0.6 * px, 3.4 * px), COL.walked, alpha, 0);
      } else if (m.kind === 'refuge') {
        const r = 13 * px;
        const cy = m.y + height + r * 0.8;
        gl.depthMask(false);
        drawShape('star', facing(m.x, cy, m.z, r * 1.28), COL.casing, alpha, 0);
        gl.depthMask(true);
        drawShape('star', facing(m.x, cy, m.z, r), COL.walked, alpha, 0);
      } else {
        rimmed('sphere', m.x, m.y + height, m.z, 5.5 * px, 5.5 * px, 5.5 * px, 0, rim, m.rgb, alpha, 0.5);
      }
    }
    if (head) {
      const w = mat4TransformPoint(M.vp, head.x, head.y, head.z)[3];
      const px = Math.max(metresPerCssPx(Math.max(w, 1)), 0.02);
      const rim = 1.2 * px;
      rimmed('cone', head.x, head.y, head.z, 9 * px, 26 * px, 9 * px, 0, rim, COL.walked, alpha, 0.25);
      rimmed('sphere', head.x, head.y + 29 * px, head.z, 10 * px, 10 * px, 10 * px, 0, rim, COL.route, alpha, 0.3);
    }
  }

  function render() {
    if (destroyed || lost || !G) return;
    syncSize();
    if (!canvas.width || !canvas.height) return;
    const t0 = performance.now();
    dirty = false;
    updateMatrices(frameDt);
    const vp = M.vp;
    const W = canvas.width, H = canvas.height;
    gl.viewport(0, 0, W, H);
    gl.disable(gl.CULL_FACE);
    gl.disable(gl.BLEND);
    gl.clearColor(COL.skyTop[0], COL.skyTop[1], COL.skyTop[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    // sky
    gl.disable(gl.DEPTH_TEST);
    gl.depthMask(false);
    gl.useProgram(G.sky.p);
    attribCount(1);
    gl.bindBuffer(gl.ARRAY_BUFFER, G.quad);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.uniform3fv(G.sky.u.u_top, COL.skyTop);
    gl.uniform3fv(G.sky.u.u_horizon, COL.horizon);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);
    gl.enable(gl.DEPTH_TEST);
    gl.depthFunc(gl.LEQUAL);

    if (S && R) {
      const light = [-0.5, Math.SQRT1_2, -0.5];          // from the north-west, 45 degrees up
      const mPerPx = (2 * Math.tan(FOV_Y / 2)) / H;       // metres per device pixel at 1 m
      const cssM = metresPerCssPx(cam.dist);              // metres per CSS pixel at the camera target
      const pow2 = (m) => 4 * Math.pow(2, Math.max(0, Math.round(Math.log2(Math.max(m, 1e-6) / 4))));

      // terrain
      let u = G.terrain.u;
      gl.useProgram(G.terrain.p);
      attribCount(2);
      gl.uniformMatrix4fv(u.u_vp, false, f32(vp));
      gl.uniform3fv(u.u_eye, M.eye);
      gl.uniform3fv(u.u_light, light);
      gl.uniform1f(u.u_yMax, S.t.yMax);
      gl.uniform3fv(u.u_fog, COL.horizon);
      gl.uniform2f(u.u_fogRange, cam.dist * 1.15, 1 / (S.radius * 2.2 + cam.dist));
      gl.uniform1f(u.u_hatch, pow2(cssM * 12));
      gl.uniform1f(u.u_mPerPx, mPerPx);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, R.tex || G.white);
      gl.uniform1i(u.u_tex, 0);
      gl.uniform1f(u.u_hasTex, R.tex ? 1 : 0);
      if (R.tex) gl.uniform4fv(u.u_texRect, R.texRect);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, R.nogo || G.white);
      gl.uniform1i(u.u_nogo, 1);
      gl.uniform1f(u.u_hasNogo, R.nogo ? 1 : 0);
      if (R.nogo) gl.uniform4fv(u.u_nogoRect, R.nogoRect);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.vbo);
      const indexType = G.uint ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
      const ribbonType = indexType;
      for (const ch of R.chunks) {
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, ch.offset);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, ch.offset + 12);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ch.buf);
        gl.drawElements(gl.TRIANGLES, ch.count, indexType, 0);
      }

      // block walls
      u = G.solid.u;
      gl.useProgram(G.solid.p);
      gl.uniformMatrix4fv(u.u_vp, false, f32(vp));
      gl.uniform3fv(u.u_light, light);
      gl.bindBuffer(gl.ARRAY_BUFFER, R.skirt);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.uniformMatrix4fv(u.u_model, false, f32(modelMatrix(0, 0, 0, 1, 1, 1)));
      gl.uniform4f(u.u_color, COL.skirt[0], COL.skirt[1], COL.skirt[2], 1);
      gl.uniform1f(u.u_lit, 1);
      gl.drawArrays(gl.TRIANGLES, 0, R.skirtCount);

      // route: once faintly through everything so a stretch behind a rise can still be followed, then properly
      const head = headPoint();
      if (R.ribbonCount) {
        u = G.ribbon.u;
        gl.useProgram(G.ribbon.p);
        attribCount(3);
        gl.bindBuffer(gl.ARRAY_BUFFER, R.ribbon);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 40, 0);
        gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 40, 12);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 40, 24);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, R.ribbonIndex);
        const casePx = 1.6 * dpr;
        const bias = (k) => (M.proj[14] * k) / (1 - k);          // as if the fraction k nearer the eye
        gl.uniformMatrix4fv(u.u_vp, false, f32(vp));
        gl.uniform2f(u.u_viewport, W, H);
        gl.uniform1f(u.u_pxPerM, (H / 2) * M.proj[5]);
        gl.uniform1f(u.u_minHalfPx, 2 * dpr);
        gl.uniform1f(u.u_halfM, 1.25);
        gl.uniform1f(u.u_progress, head ? head.s : 0);
        gl.uniform3fv(u.u_ahead, COL.route);
        gl.uniform3fv(u.u_behind, COL.walked);
        gl.uniform3fv(u.u_case, COL.casing);
        gl.uniform1f(u.u_dashPeriod, Math.max(12, pow2(cssM * 18)));     // a dash stays clearly longer than the ribbon is wide
        // faint pass: segments only, so nothing is blended twice
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.disable(gl.DEPTH_TEST);
        gl.uniform1f(u.u_alpha, 0.3);
        gl.uniform1f(u.u_mode, 0);
        gl.uniform1f(u.u_casePx, casePx);
        gl.uniform1f(u.u_dashPad, 0);
        gl.uniform1f(u.u_zBias, bias(0.004));
        gl.drawElements(gl.TRIANGLES, R.ribbonSegCount, ribbonType, 0);
        gl.disable(gl.BLEND);
        gl.enable(gl.DEPTH_TEST);
        gl.uniform1f(u.u_alpha, 1);
        // dark casing everywhere first, leaving no depth behind, then the colour: no casing cuts across a bend
        gl.uniform1f(u.u_mode, 1);
        gl.uniform1f(u.u_dashPad, cssM * 1.6);
        gl.depthMask(false);
        gl.drawElements(gl.TRIANGLES, R.ribbonCount, ribbonType, 0);
        gl.depthMask(true);
        gl.uniform1f(u.u_mode, 2);
        gl.uniform1f(u.u_casePx, 0);
        gl.uniform1f(u.u_dashPad, 0);
        gl.drawElements(gl.TRIANGLES, R.ribbonCount, ribbonType, 0);
      }

      // markers, faint through the ground first as well
      const layout = layoutMarkers();
      u = G.solid.u;
      gl.useProgram(G.solid.p);
      attribCount(2);
      gl.bindBuffer(gl.ARRAY_BUFFER, G.shapes);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0);
      gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
      gl.enable(gl.BLEND);
      gl.disable(gl.DEPTH_TEST);
      drawMarkers(layout, head, 0.3);
      gl.disable(gl.BLEND);
      gl.enable(gl.DEPTH_TEST);
      drawMarkers(layout, head, 1);
      drawOverlay(layout);
    } else {
      drawOverlay([]);
    }
    stats.frames++;
    stats.lastFrameMs = performance.now() - t0;
  }

  // ---- Labels (2D canvas above the GL canvas) ----

  const FONT = '600 11px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';
  const SMALL = '500 10.5px Inter, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  function textBox(c, text, x, y, border, swatch) {
    c.font = FONT;
    const w = Math.ceil(c.measureText(text).width) + 12 + (swatch ? 12 : 0), h = 18;
    c.fillStyle = CSS.box;
    c.fillRect(x, y, w, h);
    c.strokeStyle = border;
    c.lineWidth = 1;
    c.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    if (swatch) { c.fillStyle = swatch; c.fillRect(x + 6, y + 5, 8, 8); }
    c.fillStyle = CSS.text;
    c.textBaseline = 'middle';
    c.textAlign = 'left';
    c.fillText(text, x + 6 + (swatch ? 12 : 0), y + h / 2 + 0.5);
  }

  function drawOverlay(layout) {
    const c = ctx2d;
    if (!c) return;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, cssW, cssH);
    if (!S) return;

    // marker labels, each above the top of its post; a label that would cover an earlier one moves up
    const placed = [];
    c.font = FONT;
    for (const { m, px, height } of layout) {
      if (!m.label) continue;
      const top = m.y + height + (m.kind === 'refuge' ? 26 : m.kind === 'mark' ? 6 : 4) * px;
      const p = projectPoint(M.vp, m.x, top, m.z, cssW, cssH);
      if (!(p.w > 0) || p.x < -40 || p.x > cssW + 40 || p.y < -20 || p.y > cssH + 40) continue;
      const text = m.kind === 'refuge' && !/refuge/i.test(m.label) ? `Refuge: ${m.label}` : m.label;
      const w = Math.ceil(c.measureText(text).width) + 12 + (m.kind === 'mark' ? 12 : 0);
      const x = clamp(Math.round(p.x - w / 2), 2, Math.max(2, cssW - w - 2));
      let y = Math.round(p.y - 18 - 5);
      for (let tries = 0; tries < 8; tries++) {
        const hit = placed.find((b) => x < b.x + b.w + 2 && x + w + 2 > b.x && y < b.y + 20 && y + 20 > b.y);
        if (!hit) break;
        y = hit.y - 21;
      }
      y = Math.max(2, y);
      placed.push({ x, y, w });
      textBox(c, text, x, y, m.kind === 'refuge' ? '#ffffff' : m.kind === 'station' ? CSS.route : CSS.line, m.kind === 'mark' ? m.css : null);
    }

    // north arrow: which way on screen the ground north of the view centre lies
    const a = projectPoint(M.vp, cam.tx, cam.ty, cam.tz, cssW, cssH);
    const b = projectPoint(M.vp, cam.tx, cam.ty, cam.tz - Math.max(1, cam.dist * 0.05), cssW, cssH);
    let nx = 0, ny = -1;
    if (a.w > 0 && b.w > 0 && Math.hypot(b.x - a.x, b.y - a.y) > 1e-6) {
      const l = Math.hypot(b.x - a.x, b.y - a.y);
      nx = (b.x - a.x) / l; ny = (b.y - a.y) / l;
    } else {
      nx = -Math.sin(cam.az * DEG); ny = -Math.cos(cam.az * DEG);
    }
    const cx = cssW - 34, cy = 34, r = 22;
    c.fillStyle = CSS.box;
    c.beginPath(); c.arc(cx, cy, r, 0, 2 * Math.PI); c.fill();
    c.strokeStyle = CSS.line; c.lineWidth = 1; c.stroke();
    const tipX = cx + nx * (r - 12), tipY = cy + ny * (r - 12);
    const tailX = cx - nx * (r - 7), tailY = cy - ny * (r - 7);
    c.fillStyle = CSS.text;
    c.beginPath();
    c.moveTo(tipX, tipY);
    c.lineTo(tailX - ny * 5, tailY + nx * 5);
    c.lineTo(cx - nx * 4, cy - ny * 4);
    c.lineTo(tailX + ny * 5, tailY - nx * 5);
    c.closePath(); c.fill();
    c.font = '700 10px Inter, system-ui, sans-serif';
    c.textAlign = 'center'; c.textBaseline = 'middle';
    c.fillText('N', cx + nx * (r - 6), cy + ny * (r - 6) + 0.5);

    // scale bar and the honest note about the vertical scale
    const m = metresPerCssPx(cam.dist);
    const len = niceLength(110 * m);
    const ex = String(Math.round(S.exaggeration * 100) / 100);
    const spacing = Math.max(S.t.cellX, S.t.cellZ);
    const parts = [`Vertical exaggeration ×${ex}`, `ground sampled every ${spacing < 10 ? spacing.toFixed(1) : Math.round(spacing)} m`, S.credit].filter(Boolean);
    c.font = SMALL;
    const lines = [];
    let line = '';
    for (const part of parts) {                // break at the separators when the canvas is narrow
      const next = line ? `${line} · ${part}` : part;
      if (line && c.measureText(next).width > cssW - 28) { lines.push(line); line = part; } else line = next;
    }
    if (line) lines.push(line);
    const boxW = Math.min(cssW - 12, Math.max(...lines.map((s) => c.measureText(s).width), 150) + 16);
    const boxH = 24 + lines.length * 14;
    const bx = 6, by = cssH - boxH - 6;
    c.fillStyle = CSS.box;
    c.fillRect(bx, by, boxW, boxH);
    const barPx = len / m;
    c.strokeStyle = CSS.text; c.lineWidth = 1.5;
    c.beginPath();
    c.moveTo(bx + 8.5, by + 7); c.lineTo(bx + 8.5, by + 14.5); c.lineTo(bx + 8.5 + barPx, by + 14.5); c.lineTo(bx + 8.5 + barPx, by + 7);
    c.stroke();
    c.fillStyle = CSS.text; c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(`${len >= 1000 ? `${len / 1000} km` : `${len} m`} at view centre`, bx + 8.5 + barPx + 7, by + 11);
    c.fillStyle = CSS.label;
    lines.forEach((s, i) => c.fillText(s, bx + 8, by + 28 + i * 14));
  }

  // ---- Progress and the fly-along ----

  function setProgress(f, o = {}) {
    if (destroyed) return;
    progress = clamp(Number(f) || 0, 0, 1);
    if (o.follow && S && S.route.n && !fly) Object.assign(cam, followPose(headingAt(S.route, progress * S.route.total, chordSpan()), cam.ty, 0, 22, followDist(), true));
    invalidate();
  }

  const followDist = () => (S ? clamp(S.route.total * 0.2, 110, 600) : 250);
  const chordSpan = () => (S ? clamp(S.route.total * 0.08, 40, 250) : 80);

  // The camera behind and above the head, looking along `heading`, aimed a little ahead of the head.
  function followPose(heading, y, azOffset, pitch, dist, snapY) {
    const head = headPoint();
    const az = (((heading + azOffset) % 360) + 360) % 360;
    const lead = dist * 0.22;
    return {
      tx: head.x + Math.sin(az * DEG) * lead, tz: head.z - Math.cos(az * DEG) * lead,
      ty: snapY ? head.y : y, az, pitch, dist,
    };
  }

  function prefersReducedMotion() {
    try { return !!(win.matchMedia && win.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
  }

  function finishFly(done, error) {
    const f = fly;
    if (!f) return;
    fly = null;
    if (f.timer) win.clearTimeout(f.timer);
    if (error) f.reject(error); else f.resolve(done);
  }

  // Stop a running fly-along. Its promise resolves false. The camera stays where it is.
  function cancel() { finishFly(false); }

  function report(f) {
    if (!fly || !fly.onProgress) return true;
    try { fly.onProgress(f); return true; } catch (err) { finishFly(false, err); return false; }
  }

  // Animate progress 0 -> 1 over durationMs with the camera following the head. Resolves true when the
  // end is reached, false when cancelled (cancel(), a new scene, resetCamera, destroy) or when there is no route.
  // o.reducedMotion overrides the prefers-reduced-motion setting.
  function flyAlong(durationMs = 20000, onProgress, o = {}) {
    cancel();
    if (destroyed || !S || !(S.route.total > 0)) return Promise.resolve(false);
    const duration = Math.max(1, Number(durationMs) || 0);
    const reduced = typeof o.reducedMotion === 'boolean' ? o.reducedMotion : prefersReducedMotion();
    inertia = null;
    return new Promise((resolve, reject) => {
      fly = {
        resolve, reject, onProgress: typeof onProgress === 'function' ? onProgress : null, reduced, duration,
        elapsed: 0, started: false, heading: 0, heading1: 0, y: 0, azOffset: 0, pitch: 22, dist: followDist(), from: { ...cam },
        tau: clamp(duration * 0.035, 350, 1100), timer: 0,
      };
      if (reduced) {
        const steps = [0, 0.25, 0.5, 0.75, 1];
        const hold = clamp(duration / (steps.length - 1), 250, 2500);
        let i = 0;
        const step = () => {
          if (!fly) return;
          fly.timer = 0;
          progress = steps[i];
          Object.assign(cam, followPose(headingAt(S.route, progress * S.route.total, chordSpan()), 0, fly.azOffset, fly.pitch, fly.dist, true));
          render();
          if (!report(progress)) return;
          if (++i >= steps.length) finishFly(true); else fly.timer = win.setTimeout(step, hold);
        };
        step();
      } else {
        invalidate();
      }
    });
  }

  function stepFly(dt) {
    const f = fly;
    const route = S.route;
    if (!f.started) { f.started = true; dt = 0; }
    f.elapsed += dt;
    const u = clamp(f.elapsed / f.duration, 0, 1);
    const intro = Math.min(0.2, 2000 / f.duration);          // swing in from wherever the camera was
    progress = u <= intro ? 0 : easeProgress((u - intro) / (1 - intro));
    const head = headPoint();
    const want = headingAt(route, head.s, chordSpan());
    const k = 1 - Math.exp(-dt / f.tau);
    if (f.elapsed === 0) { f.heading1 = want; f.heading = want; f.y = head.y; }
    else {
      // two low-pass stages in a row: the turn starts gently as well as ending gently
      f.heading1 = smoothHeading(f.heading1, want, k);
      f.heading = smoothHeading(f.heading, f.heading1, k);
      f.y += (head.y - f.y) * k;
    }
    const pose = followPose(f.heading, f.y, f.azOffset, f.pitch, f.dist, false);
    const b = intro > 0 ? clamp(u / intro, 0, 1) : 1;
    const e = b * b * (3 - 2 * b);
    if (e >= 1) Object.assign(cam, pose);
    else {
      cam.tx = f.from.tx + (pose.tx - f.from.tx) * e;
      cam.ty = f.from.ty + (pose.ty - f.from.ty) * e;
      cam.tz = f.from.tz + (pose.tz - f.from.tz) * e;
      cam.az = smoothHeading(f.from.az, pose.az, e);
      cam.pitch = f.from.pitch + (pose.pitch - f.from.pitch) * e;
      cam.dist = Math.exp(Math.log(f.from.dist) + (Math.log(pose.dist) - Math.log(f.from.dist)) * e);
    }
    dirty = true;
    return u >= 1;
  }

  function invalidate() {
    dirty = true;
    if (!raf && !destroyed) raf = win.requestAnimationFrame(tick);
  }

  function tick(now) {
    raf = 0;
    if (destroyed) return;
    const dt = lastT ? Math.min(100, now - lastT) : 16;
    lastT = now;
    let more = false;
    let flown = null;
    if (fly && !fly.reduced && S) {
      const done = stepFly(dt);
      flown = { done, f: progress };
      more = !done;
    }
    if (inertia && !fly) {
      cam.az = (((cam.az + inertia.az * dt) % 360) + 360) % 360;
      cam.pitch = clamp(cam.pitch + inertia.pitch * dt, 4, 89.5);
      const decay = Math.exp(-dt / 180);
      inertia.az *= decay; inertia.pitch *= decay;
      if (Math.hypot(inertia.az, inertia.pitch) < 0.004) inertia = null; else more = true;
      dirty = true;
    }
    if (dirty) { frameDt = dt; render(); }
    if (flown && report(flown.f) && flown.done) finishFly(true);
    if (more && !raf) raf = win.requestAnimationFrame(tick);
    if (!raf) lastT = 0;
  }

  // Screen position (CSS pixels from the canvas corner) of a point on the ground, for callers that want
  // to line something up with the view. heightM is metres above the drawn ground.
  function project(lat, lon, heightM = 0) {
    if (!S || !M) return null;
    const p = toScene(S.frame, lat, lon);
    return projectPoint(M.vp, p.x, heightAt(S.t, p.x, p.z) + heightM, p.z, cssW, cssH);
  }

  function destroy() {
    if (destroyed) return;
    cancel();
    destroyed = true;
    if (raf) win.cancelAnimationFrame(raf);
    raf = 0;
    if (observer) observer.disconnect();
    for (const [type, fn, o] of listeners) canvas.removeEventListener(type, fn, o);
    canvas.style.touchAction = prevTouchAction;
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    if (!lost && G) {
      freeScene();
      for (const p of [G.sky, G.terrain, G.solid, G.ribbon]) gl.deleteProgram(p.p);
      gl.deleteBuffer(G.quad);
      gl.deleteBuffer(G.shapes);
      gl.deleteTexture(G.white);
    }
    G = null; R = null; S = null; sceneIn = null;
  }

  initGL();
  syncSize();

  return {
    setScene, setProgress, flyAlong, cancel, resetCamera, getCamera, setCamera, resize, render, destroy, project,
    get progress() { return progress; },
    get flying() { return !!fly; },
    get routeLengthM() { return S ? S.route.total : 0; },
    stats: () => ({ ...stats }),
    overlay,
  };
}
