// Terrain analysis: pure functions over typed arrays, no DOM, no dependencies.
// Runs unchanged on the browser main thread, in a module worker and in Node.
//
// grid = { w, h, dx, dy, bounds: [[south, west], [north, east]], elev: Float32Array, scale_m }
// Cells are row-major, row 0 is the northern edge, column 0 the western edge, index = row * w + col.
// Cells are areas: the centre of cell (col, row) sits half a cell inside the bounds.
// The grid is treated as a flat metric grid: dx metres per cell east-west, dy north-south.
// Compass angles are degrees clockwise from north. Missing elevation is NaN.
//
// What each analysis leaves out is written above the function.

const DEG = Math.PI / 180;

export const MARS_RADIUS_M = 3396190;   // equatorial radius, the one the DEM bounds are built on
export const UNREACHED = -2;            // costDistance prev[] value for cells no path reaches

// ---- Decoding ----

// Wrap to int16 the way the encoder did.
const wrap16 = (v) => (v << 16) >> 16;

// Int16Array view of the stored samples, whatever container they arrived in. The file is little-endian.
function asInt16(stored, n) {
  if (stored instanceof Int16Array) return stored;
  const u8 = stored instanceof ArrayBuffer ? new Uint8Array(stored) : new Uint8Array(stored.buffer, stored.byteOffset, stored.byteLength);
  if (u8.length < n * 2) return new Int16Array(0);
  const littleEndian = new Uint8Array(new Uint16Array([1]).buffer)[0] === 1;
  if (littleEndian && u8.byteOffset % 2 === 0) return new Int16Array(u8.buffer, u8.byteOffset, n);
  const out = new Int16Array(n);
  const view = new DataView(u8.buffer, u8.byteOffset, n * 2);
  for (let i = 0; i < n; i++) out[i] = view.getInt16(i * 2, true);
  return out;
}

// meta = dem.json. stored = the gunzipped samples (Int16Array, ArrayBuffer or Uint8Array).
// Undoes the horizontal delta coding: the first value of a row is a difference from the first value
// of the row above, every other value is a difference from its left neighbour, all wrapped to int16.
// An optional meta.nodata (a quantised value) becomes NaN.
export function decodeDem(meta, stored) {
  const { w, h } = meta;
  const n = w * h;
  const s = asInt16(stored, n);
  if (s.length < n) throw new Error(`DEM has ${s.length} samples, expected ${n}`);
  const scale = meta.scale_m ?? 1;
  const offset = meta.offset_m ?? 0;
  const nodata = typeof meta.nodata === 'number' ? meta.nodata : null;
  const elev = new Float32Array(n);
  let rowStart = 0;
  let i = 0;
  for (let r = 0; r < h; r++) {
    let q = wrap16(rowStart + s[i]);
    rowStart = q;
    elev[i++] = q === nodata ? NaN : q * scale + offset;
    for (let c = 1; c < w; c++) {
      q = wrap16(q + s[i]);
      elev[i++] = q === nodata ? NaN : q * scale + offset;
    }
  }
  return gridFromBounds(w, h, meta.bounds, elev, scale);
}

// Cell sizes in metres from the corner coordinates: one degree of latitude is pi/180 * R,
// one degree of longitude is that times cos(latitude), taken at the middle of the grid.
export function gridFromBounds(w, h, bounds, elev, scale_m = 0) {
  const [[south, west], [north, east]] = bounds;
  const mPerDegLat = DEG * MARS_RADIUS_M;
  const mPerDegLon = mPerDegLat * Math.cos(((south + north) / 2) * DEG);
  return {
    w, h,
    dx: ((east - west) * mPerDegLon) / w,
    dy: ((north - south) * mPerDegLat) / h,
    bounds, elev, scale_m,
  };
}

async function gunzip(buf) {
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Response(stream).arrayBuffer();
}

// Fetch dem.json and the file it names (relative to dem.json), gunzip, decode.
// If the server already undid the gzip (Content-Encoding), the bytes are used as they are.
// Inside a worker a relative metaUrl resolves against the worker script, so pass an absolute URL there.
export async function loadDem(metaUrl, fetchFn = globalThis.fetch) {
  const res = await fetchFn(metaUrl);
  if (!res.ok) throw new Error(`cannot load ${metaUrl}: HTTP ${res.status}`);
  const meta = await res.json();
  const base = (res.url || String(metaUrl)).replace(/[?#].*$/, '').replace(/[^/]*$/, '');
  const fileUrl = /^([a-z][a-z0-9+.-]*:|\/)/i.test(meta.file) ? meta.file : base + meta.file;
  const fileRes = await fetchFn(fileUrl);
  if (!fileRes.ok) throw new Error(`cannot load ${fileUrl}: HTTP ${fileRes.status}`);
  const bytes = meta.w * meta.h * 2;
  let buf = await fileRes.arrayBuffer();
  if (buf.byteLength !== bytes) buf = await gunzip(buf);
  if (buf.byteLength !== bytes) throw new Error(`${fileUrl} holds ${buf.byteLength} bytes, expected ${bytes}`);
  return decodeDem(meta, buf);
}

// ---- Coordinates ----

// Cell containing a point. col and row are not clamped; check `inside` before indexing.
export function cellOf(grid, lat, lon) {
  const [[south, west], [north, east]] = grid.bounds;
  const col = Math.floor(((lon - west) / (east - west)) * grid.w);
  const row = Math.floor(((north - lat) / (north - south)) * grid.h);
  return { col, row, inside: col >= 0 && col < grid.w && row >= 0 && row < grid.h };
}

// Centre of a cell.
export function latLonOf(grid, col, row) {
  const [[south, west], [north, east]] = grid.bounds;
  return {
    lat: north - ((row + 0.5) / grid.h) * (north - south),
    lon: west + ((col + 0.5) / grid.w) * (east - west),
  };
}

// Bilinear elevation between the four nearest cell centres. NaN outside the bounds.
// In the half-cell strip between the outer cell centres and the edge the outer value is held.
export function elevAt(grid, lat, lon) {
  const { w, h, elev } = grid;
  const [[south, west], [north, east]] = grid.bounds;
  let x = ((lon - west) / (east - west)) * w - 0.5;
  let y = ((north - lat) / (north - south)) * h - 0.5;
  if (!(x >= -0.5 && x <= w - 0.5 && y >= -0.5 && y <= h - 0.5)) return NaN;
  x = Math.max(0, Math.min(w - 1, x));
  y = Math.max(0, Math.min(h - 1, y));
  const c0 = Math.min(Math.floor(x), Math.max(0, w - 2));
  const r0 = Math.min(Math.floor(y), Math.max(0, h - 2));
  const c1 = Math.min(c0 + 1, w - 1);
  const r1 = Math.min(r0 + 1, h - 1);
  const fx = x - c0;
  const fy = y - r0;
  const top = elev[r0 * w + c0] * (1 - fx) + elev[r0 * w + c1] * fx;
  const bot = elev[r1 * w + c0] * (1 - fx) + elev[r1 * w + c1] * fx;
  return top * (1 - fy) + bot * fy;
}

// Points along the straight line a -> b, both ends included, spaced evenly and at most stepM apart.
// distM is the horizontal distance from a. elev is NaN where the line leaves the grid.
export function sampleLine(grid, a, b, stepM) {
  const [[south, west], [north, east]] = grid.bounds;
  const mLat = (grid.dy * grid.h) / (north - south);
  const mLon = (grid.dx * grid.w) / (east - west);
  const total = Math.hypot((b.lon - a.lon) * mLon, (b.lat - a.lat) * mLat);
  let n = 0;                                 // number of equal steps
  if (total > 0) n = stepM > 0 ? Math.max(1, Math.ceil(total / stepM - 1e-9)) : 1;
  const out = [];
  for (let i = 0; i <= n; i++) {
    const f = n ? i / n : 0;
    const lat = a.lat + (b.lat - a.lat) * f;
    const lon = a.lon + (b.lon - a.lon) * f;
    out.push({ lat, lon, elev: elevAt(grid, lat, lon), distM: total * f });
  }
  return out;
}

// ---- Gradient, slope, aspect, roughness, hillshade ----

// Horn's 3x3 gradient. gx = rise per metre toward the east, gy = rise per metre toward the south.
// Border cells use the same kernel on a ring of cells extrapolated in a straight line from the two
// cells inside, so a tilted plane gives the same answer on the border as in the middle.
export function gradient(grid) {
  const { w, h, elev: z } = grid;
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  const kx = 1 / (8 * grid.dx);
  const ky = 1 / (8 * grid.dy);
  for (let r = 1; r < h - 1; r++) {
    let i = r * w + 1;
    for (let c = 1; c < w - 1; c++, i++) {
      const nw = z[i - w - 1], n = z[i - w], ne = z[i - w + 1];
      const west = z[i - 1], east = z[i + 1];
      const sw = z[i + w - 1], s = z[i + w], se = z[i + w + 1];
      gx[i] = ((ne + 2 * east + se) - (nw + 2 * west + sw)) * kx;
      gy[i] = ((sw + 2 * s + se) - (nw + 2 * n + ne)) * ky;
    }
  }
  const at = (c, r) => {
    if (c < 0) return w > 1 ? 2 * at(0, r) - at(1, r) : at(0, r);
    if (c >= w) return w > 1 ? 2 * at(w - 1, r) - at(w - 2, r) : at(w - 1, r);
    if (r < 0) return h > 1 ? 2 * at(c, 0) - at(c, 1) : at(c, 0);
    if (r >= h) return h > 1 ? 2 * at(c, h - 1) - at(c, h - 2) : at(c, h - 1);
    return z[r * w + c];
  };
  const border = (c, r) => {
    const i = r * w + c;
    gx[i] = ((at(c + 1, r - 1) + 2 * at(c + 1, r) + at(c + 1, r + 1)) - (at(c - 1, r - 1) + 2 * at(c - 1, r) + at(c - 1, r + 1))) * kx;
    gy[i] = ((at(c - 1, r + 1) + 2 * at(c, r + 1) + at(c + 1, r + 1)) - (at(c - 1, r - 1) + 2 * at(c, r - 1) + at(c + 1, r - 1))) * ky;
  };
  for (let c = 0; c < w; c++) { border(c, 0); border(c, h - 1); }
  for (let r = 1; r < h - 1; r++) { border(0, r); border(w - 1, r); }
  return { gx, gy };
}

// slope: degrees from horizontal. aspect: compass direction the ground falls toward, NaN where flat.
// Slope from a grid of about 6 m cells is the slope over about 12 m; shorter steep faces are understated.
export function slopeAspect(grid, grad = gradient(grid)) {
  const { gx, gy } = grad;
  const n = gx.length;
  const slope = new Float32Array(n);
  const aspect = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = gx[i];
    const y = gy[i];
    slope[i] = Math.atan(Math.sqrt(x * x + y * y)) / DEG;
    // Downhill is (-gx) toward the east and (+gy) toward the north.
    aspect[i] = x === 0 && y === 0 ? NaN : (Math.atan2(-x, y) / DEG + 360) % 360;
  }
  return { slope, aspect };
}

// Terrain ruggedness index (Riley et al. 1999): square root of the summed squared height differences
// between a cell and its eight neighbours, in metres. It grows with cell size, so compare values only
// within one grid. Border cells have fewer neighbours; their sum is scaled up to eight.
export function roughness(grid) {
  const { w, h, elev: z } = grid;
  const out = new Float32Array(w * h);
  for (let r = 1; r < h - 1; r++) {
    let i = r * w + 1;
    for (let c = 1; c < w - 1; c++, i++) {
      const e = z[i];
      const a = z[i - w - 1] - e, b = z[i - w] - e, d = z[i - w + 1] - e;
      const f = z[i - 1] - e, g = z[i + 1] - e;
      const k = z[i + w - 1] - e, l = z[i + w] - e, m = z[i + w + 1] - e;
      out[i] = Math.sqrt(a * a + b * b + d * d + f * f + g * g + k * k + l * l + m * m);
    }
  }
  const border = (c, r) => {
    const e = z[r * w + c];
    let sum = 0;
    let count = 0;
    for (let rr = Math.max(0, r - 1); rr <= Math.min(h - 1, r + 1); rr++) {
      for (let cc = Math.max(0, c - 1); cc <= Math.min(w - 1, c + 1); cc++) {
        if (rr === r && cc === c) continue;
        const d = z[rr * w + cc] - e;
        sum += d * d;
        count++;
      }
    }
    out[r * w + c] = count ? Math.sqrt((sum * 8) / count) : 0;
  };
  for (let c = 0; c < w; c++) { border(c, 0); border(c, h - 1); }
  for (let r = 1; r < h - 1; r++) { border(0, r); border(w - 1, r); }
  return out;
}

// Brightness of each cell for a sun at the given compass azimuth and elevation, 0..255:
// 255 * cosine of the angle between the surface normal and the sun, never below 0.
// This is shading only. It does not know about shadows thrown by other ground; see castShadow.
// A sun on or below the horizon gives 0 everywhere.
export function hillshade(grid, sunAzDeg, sunElDeg, grad = gradient(grid)) {
  const { gx, gy } = grad;
  const n = gx.length;
  const out = new Uint8Array(n);
  if (!(sunElDeg > 0)) return out;
  const az = sunAzDeg * DEG;
  const el = sunElDeg * DEG;
  const lx = Math.sin(az) * Math.cos(el);   // east
  const ly = Math.cos(az) * Math.cos(el);   // north
  const lz = Math.sin(el);                  // up
  for (let i = 0; i < n; i++) {
    const x = gx[i];
    const y = gy[i];
    const s = (-x * lx + y * ly + lz) / Math.sqrt(1 + x * x + y * y);
    out[i] = s > 0 ? (s * 255 + 0.5) | 0 : 0;
  }
  return out;
}

// ---- Cast shadow ----

const SHADOW_EPS_M = 1e-3;   // ground must be this far under the shadow edge to count as shaded

// 1 where the ground is in shadow for a sun at the given compass azimuth and elevation, 0 where lit.
// A sun on or below the horizon shades everything.
//
// One sweep, O(cells). The grid is cut into parallel lines that run exactly along the sun's direction,
// one per row (or per column when the sun is nearer north-south). Walking away from the sun, each line
// remembers the highest shadow edge thrown so far by the ground under it; the ground height on a line is
// interpolated between the two cells it passes between. A cell is shaded when it lies below the shadow
// edge interpolated between the two lines on either side of it.
//
// Left out: ground outside the grid casts no shadow (a low sun behind a distant rim is not seen);
// the planet's curvature; the sun's width (no penumbra); the side edge of a shadow can be off by up to
// one cell. Slopes that face away from the sun more steeply than its elevation count as shaded.
export function castShadow(grid, sunAzDeg, sunElDeg) {
  const { w, h, elev: z } = grid;
  const out = new Uint8Array(w * h);
  if (!(sunElDeg > 0)) return out.fill(1);
  if (sunElDeg >= 89.999) return out;
  const az = sunAzDeg * DEG;
  // Direction away from the sun in cells per metre: columns, rows.
  const ac = -Math.sin(az) / grid.dx;
  const ar = Math.cos(az) / grid.dy;
  const colMajor = Math.abs(ac) >= Math.abs(ar);
  const nMaj = colMajor ? w : h;           // steps along the sweep
  const nMin = colMajor ? h : w;           // cells across it
  const aMaj = colMajor ? ac : ar;
  const aMin = colMajor ? ar : ac;
  const unit = colMajor ? 1 : w;
  const minStride = colMajor ? w : 1;
  const majStride = aMaj > 0 ? unit : -unit;
  const start = aMaj > 0 ? 0 : (nMaj - 1) * unit;
  const r = aMin / Math.abs(aMaj);                         // sideways drift per step, -1..1 cells
  const drop = Math.tan(sunElDeg * DEG) / Math.abs(aMaj);  // fall of a sun ray per step, metres
  const span = r * (nMaj - 1);
  const off = 2 + Math.ceil(Math.max(0, span));
  // M[line] = highest (ground + steps * drop) seen on that line, so the shadow edge now is M - k * drop.
  const M = new Float64Array(nMin + 5 + Math.ceil(Math.abs(span))).fill(-1e30);
  for (let k = 0; k < nMaj; k++) {
    const base = start + k * majStride;
    const rk = r * k;
    let j = Math.floor(rk);
    let g = rk - j;                          // lines sit this far past each cell centre
    if (g < 1e-9) g = 0;
    else if (g > 1 - 1e-9) { g = 0; j++; }
    const kd = k * drop;
    let li = off - j;
    if (g === 0) {
      for (let y = 0, i = base; y < nMin; y++, i += minStride, li++) {
        const zc = z[i];
        const m = M[li];
        if (zc + SHADOW_EPS_M < m - kd) out[i] = 1;
        const v = zc + kd;
        if (v > m) M[li] = v;
      }
    } else {
      const g1 = 1 - g;
      let before = M[li - 1];                // the line just before cell 0, as it was before this step
      for (let y = 0, i = base; y < nMin; y++, i += minStride, li++) {
        const zc = z[i];
        const cur = M[li];
        if (zc + SHADOW_EPS_M < before * g + cur * g1 - kd) out[i] = 1;
        if (y < nMin - 1) {                  // the line past the last cell is off the grid: no ground there
          const v = zc * g1 + z[i + minStride] * g + kd;
          if (v > cur) M[li] = v;
        }
        before = cur;
      }
    }
  }
  return out;
}

// ---- Viewshed ----

// 1 where a target standing targetHeightM above the ground of that cell can be seen by an observer
// standing observerHeightM above the ground at (lat, lon). All 0 if the observer is off the grid.
//
// R2 method (Franklin and Ray), O(cells): one line of sight is walked from the observer to every cell
// on the edge of the grid, and each cell on the way takes its answer from the line that passes closest
// to its centre. Two refinements over plain R2: the ground under a line is interpolated between the two
// cells the line passes between instead of taking the nearest one, and the planet's curvature lowers
// distant ground by distance^2 / (2 R).
//
// Left out or approximate: the observer is moved to the centre of its cell (up to 0.7 cell); a cell far
// from the observer is judged at a point up to half a cell from its centre, so the edges of hidden areas
// can be one cell off and single-cell obstacles are softened; ground outside the grid hides nothing;
// no refraction. For a yes/no answer between two exact points use a dedicated line-of-sight test.
export function viewshed(grid, lat, lon, observerHeightM = 0, targetHeightM = 0) {
  const { w, h, elev: z, dx, dy } = grid;
  const out = new Uint8Array(w * h);
  const o = cellOf(grid, lat, lon);
  if (!o.inside) return out;
  const oi = o.row * w + o.col;
  const z0 = z[oi] + observerHeightM;
  const ht = targetHeightM;
  const inv2R = 1 / (2 * MARS_RADIUS_M);
  const best = new Uint8Array(w * h).fill(255);   // how far off-centre the best line so far passed, 0..255
  out[oi] = 1;
  best[oi] = 0;

  const ray = (bc, br) => {
    const dc = bc - o.col;
    const dr = br - o.row;
    const n = Math.max(Math.abs(dc), Math.abs(dr));
    if (n === 0) return;
    const stepLen = Math.hypot(dc * dx, dr * dy) / n;
    const colMajor = Math.abs(dc) >= Math.abs(dr);
    const majBase = colMajor ? o.col : o.row * w;
    const majStride = colMajor ? Math.sign(dc) : Math.sign(dr) * w;
    const minStride = colMajor ? w : 1;
    const om = colMajor ? o.row : o.col;
    const dm = colMajor ? dr : dc;
    let horizon = -Infinity;                 // steepest slope from the eye to any ground passed so far
    for (let k = 1; k <= n; k++) {
      const mm = om + (k * dm) / n;
      const m0 = Math.floor(mm);
      const f = mm - m0;
      const i0 = majBase + k * majStride + m0 * minStride;
      const dist = k * stepLen;
      const ground = (f === 0 ? z[i0] : z[i0] + (z[i0 + minStride] - z[i0]) * f) - dist * dist * inv2R - z0;
      const vis = (ground + ht) / dist >= horizon ? 1 : 0;
      if (f <= 0.5) {
        const q = (f * 510) | 0;
        if (q < best[i0]) { best[i0] = q; out[i0] = vis; } else if (q === best[i0]) out[i0] |= vis;
      }
      if (f >= 0.5) {
        const i1 = i0 + minStride;
        const q = ((1 - f) * 510) | 0;
        if (q < best[i1]) { best[i1] = q; out[i1] = vis; } else if (q === best[i1]) out[i1] |= vis;
      }
      const s = ground / dist;
      if (s > horizon) horizon = s;
    }
  };
  for (let c = 0; c < w; c++) { ray(c, 0); ray(c, h - 1); }
  for (let r = 1; r < h - 1; r++) { ray(0, r); ray(w - 1, r); }
  return out;
}

// ---- Travel time ----

// Whole-degree slope index (0 = -90 deg ... 180 = +90 deg) from rise over run, without calling atan
// for every step. A table over rise/run gives the degree at the start of each bin; one comparison with
// the next rounding boundary makes it exact. Outside +-SLOPE_MAX_TAN (about 83 deg) atan is used.
const SLOPE_MAX_TAN = 8;
const SLOPE_BINS_PER_UNIT = 1024;
let slopeTable = null;
function getSlopeTable() {
  if (slopeTable) return slopeTable;
  const thr = new Float64Array(182);         // thr[d] = smallest rise/run that rounds to index d
  thr[0] = -Infinity;
  for (let d = 1; d <= 180; d++) thr[d] = Math.tan((d - 90.5) * DEG);
  thr[181] = Infinity;
  const lut = new Uint8Array(2 * SLOPE_MAX_TAN * SLOPE_BINS_PER_UNIT + 1);
  let d = 0;
  for (let b = 0; b < lut.length; b++) {
    const lo = b / SLOPE_BINS_PER_UNIT - SLOPE_MAX_TAN;
    while (thr[d + 1] <= lo) d++;
    lut[b] = d;
  }
  slopeTable = { thr, lut };
  return slopeTable;
}

// Fastest travel time between the sources and every cell.
//   sources: [{ lat, lon }]; points off the grid are ignored.
//   opts.speedBySlope: Float32Array(181), walking speed in m/s over the map (horizontal metres per
//     second) for the slope along the direction of travel, index 0 = -90 deg ... 180 = +90 deg,
//     0 = cannot walk that slope. The slope of a move is rounded to the nearest whole degree.
//   opts.blocked: optional Uint8Array, 1 = no path may use the cell.
//   opts.toward: false = time from the source to each cell; true = time from each cell to the source.
//   opts.maxTimeS: optional, stop there; cells further away are left unreached.
// Returns time (seconds, Infinity where unreached) and prev (the neighbouring cell one step nearer the
// source on the best path; -1 at a source, UNREACHED = -2 where no path arrives).
//
// Dijkstra over the 8 neighbours. A move covers dx, dy or sqrt(dx^2 + dy^2) horizontal metres and its
// slope is atan(height change / that distance), taken in the direction actually walked.
//
// Left out or approximate: paths can only turn in 45 degree steps, so times are up to 8.2 % too long on
// headings between the 8 directions (about 5 % averaged over headings); slope is the average over one
// step of 6 to 9 m; a diagonal move may not squeeze between two blocked cells that touch at a corner;
// a source inside a blocked cell still counts as a source; cells with no elevation cannot be walked;
// times are accumulated in 32-bit floats (error well under a second).
export function costDistance(grid, sources, opts = {}) {
  const { w, h, elev: z, dx, dy } = grid;
  const n = w * h;
  const blocked = opts.blocked || null;
  const toward = !!opts.toward;
  const maxTime = opts.maxTimeS ?? Infinity;
  const time = new Float32Array(n).fill(Infinity);
  const prev = new Int32Array(n).fill(UNREACHED);

  const pace = new Float64Array(181);        // seconds per metre for each whole degree
  for (let d = 0; d <= 180; d++) pace[d] = opts.speedBySlope[d] > 0 ? 1 / opts.speedBySlope[d] : Infinity;
  const { thr, lut } = getSlopeTable();

  // Neighbours: W, E, N, S, then the four diagonals.
  const diag = Math.hypot(dx, dy);
  const DC = new Int32Array([-1, 1, 0, 0, -1, 1, -1, 1]);
  const DR = new Int32Array([0, 0, -1, 1, -1, -1, 1, 1]);
  const OFF = new Int32Array(8);
  const LEN = new Float64Array([dx, dx, dy, dy, diag, diag, diag, diag]);
  const INV = new Float64Array(8);
  for (let k = 0; k < 8; k++) { OFF[k] = DR[k] * w + DC[k]; INV[k] = 1 / LEN[k]; }

  // Binary min-heap in two typed arrays. Cells are pushed again when improved; old entries are skipped.
  let cap = Math.max(1024, n >> 2);
  let hk = new Float32Array(cap);
  let hc = new Int32Array(cap);
  let size = 0;
  const push = (key, cell) => {
    if (size === cap) {
      cap *= 2;
      const nk = new Float32Array(cap); nk.set(hk); hk = nk;
      const nc = new Int32Array(cap); nc.set(hc); hc = nc;
    }
    let p = size++;
    while (p > 0) {
      const q = (p - 1) >> 1;
      if (hk[q] <= key) break;
      hk[p] = hk[q]; hc[p] = hc[q];
      p = q;
    }
    hk[p] = key; hc[p] = cell;
  };

  for (const s of sources) {
    const c = cellOf(grid, s.lat, s.lon);
    if (!c.inside) continue;
    const i = c.row * w + c.col;
    if (time[i] === 0) continue;
    time[i] = 0;
    prev[i] = -1;
    push(0, i);
  }

  while (size > 0) {
    const key = hk[0];
    const i = hc[0];
    size--;
    if (size > 0) {
      const lk = hk[size];
      const lc = hc[size];
      let p = 0;
      for (;;) {
        let c = 2 * p + 1;
        if (c >= size) break;
        if (c + 1 < size && hk[c + 1] < hk[c]) c++;
        if (hk[c] >= lk) break;
        hk[p] = hk[c]; hc[p] = hc[c];
        p = c;
      }
      hk[p] = lk; hc[p] = lc;
    }
    if (key > time[i]) continue;             // an older, worse entry for a cell already settled
    if (key > maxTime) {                     // everything left is further than the limit: forget it
      time[i] = Infinity; prev[i] = UNREACHED;
      for (let q = 0; q < size; q++) {
        const c = hc[q];
        if (time[c] > maxTime) { time[c] = Infinity; prev[c] = UNREACHED; }
      }
      break;
    }
    const row = (i / w) | 0;
    const col = i - row * w;
    const inner = col > 0 && col < w - 1 && row > 0 && row < h - 1;
    const zi = z[i];
    for (let k = 0; k < 8; k++) {
      if (!inner) {
        const c = col + DC[k];
        const r = row + DR[k];
        if (c < 0 || c >= w || r < 0 || r >= h) continue;
      }
      const j = i + OFF[k];
      const tj = time[j];
      if (tj <= key) continue;
      if (blocked !== null) {
        if (blocked[j]) continue;
        if (k >= 4 && (blocked[i + DC[k]] || blocked[i + DR[k] * w])) continue;
      }
      // Height change in the direction walked: i -> j going out, j -> i coming home.
      const m = (toward ? zi - z[j] : z[j] - zi) * INV[k];
      let d;
      if (m > -SLOPE_MAX_TAN && m < SLOPE_MAX_TAN) {
        d = lut[((m + SLOPE_MAX_TAN) * SLOPE_BINS_PER_UNIT) | 0];
        if (m >= thr[d + 1]) d++;
      } else if (m !== m) {
        continue;                            // no elevation
      } else {
        d = Math.round(Math.atan(m) / DEG) + 90;
      }
      const p = pace[d];
      if (p === Infinity) continue;
      const t = Math.fround(key + LEN[k] * p);
      if (t < tj) {
        time[j] = t;
        prev[j] = i;
        push(t, j);
      }
    }
  }
  return { time, prev };
}

// The best path from the cell at (lat, lon) back to its source, as cell centres.
// With toward = false this is the outbound path in reverse; with toward = true it is the walk home in order.
// Empty if the point is off the grid or no path reaches it.
export function pathFrom(grid, prev, lat, lon) {
  const { w, h, elev } = grid;
  const [[south, west], [north, east]] = grid.bounds;
  const start = cellOf(grid, lat, lon);
  if (!start.inside) return [];
  const out = [];
  let i = start.row * w + start.col;
  if (prev[i] === UNREACHED) return out;
  for (let guard = w * h; i >= 0 && guard > 0; guard--) {
    const row = (i / w) | 0;
    const col = i - row * w;
    out.push({
      lat: north - ((row + 0.5) / h) * (north - south),
      lon: west + ((col + 0.5) / w) * (east - west),
      elev: elev[i], col, row,
    });
    i = prev[i];
  }
  return out;
}

// 1 where the travel time is within the limit.
export function isochroneMask(time, limitS) {
  const out = new Uint8Array(time.length);
  for (let i = 0; i < time.length; i++) if (time[i] <= limitS) out[i] = 1;
  return out;
}
