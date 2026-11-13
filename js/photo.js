// Choosing a Navcam frame that shows the ground ahead, not the rover's own deck.
// Pure functions: they only read fields that NASA's raw-image feed returns.

const DEG = 180 / Math.PI;
const nums = (text) => String(text || '').replace(/[()]/g, '').split(',').map(Number);

// Where a frame is looking. `camera_model_component_list` is the CAHVOR camera model "C;A;H;V;O;R"
// in the rover frame (+X forward, +Y right, +Z down); A is the boresight. `attitude` is the
// rover-to-local-level quaternion (w, x, y, z); local level is north, east, down.
export function navPointing(im) {
  const a = nums(((im.camera || {}).camera_model_component_list || '').split(';')[1]);
  const q = nums(im.attitude);
  if (a.length !== 3 || q.length !== 4 || [...a, ...q].some(Number.isNaN)) return null;
  const [w, x, y, z] = q;
  const [vx, vy, vz] = a;
  const tx = 2 * (y * vz - z * vy);
  const ty = 2 * (z * vx - x * vz);
  const tz = 2 * (x * vy - y * vx);
  const north = vx + w * tx + (y * tz - z * ty);
  const east = vy + w * ty + (z * tx - x * tz);
  const down = vz + w * tz + (x * ty - y * tx);
  return {
    az: (Math.atan2(east, north) * DEG + 360) % 360,              // compass direction of the view
    el: -Math.asin(Math.max(-1, Math.min(1, down))) * DEG,        // degrees above the horizon
    roverAz: (Math.atan2(vy, vx) * DEG + 360) % 360,              // 0 = straight ahead of the rover, 90 = to its right
  };
}

const angleBetween = (a, b) => Math.abs(((a - b + 540) % 360) - 180);

// Best left-Navcam frame taken at one rover position (site, drive).
// Frames looking back across the deck are rejected, frames that include the horizon are preferred,
// and among those the one closest to `bearing` (for example, toward the next stop) wins.
export function pickLandscape(images, site, drive, bearing = null) {
  let best = null;
  for (const im of images) {
    const m = /_[FS](\d{3})(\d{4})NCAM/.exec(im.imageid || '');
    if (!m || !/^NAV_LEFT/.test((im.camera || {}).instrument || '') || Number(m[1]) !== site || Number(m[2]) !== drive) continue;
    const p = navPointing(im);
    if (!p) continue;
    const deck = p.roverAz > 165 && p.roverAz < 335;
    const horizon = p.el >= -25 && p.el <= 8;
    const tier = !deck && horizon ? 0 : !deck ? 1 : horizon ? 2 : 3;
    const score = tier * 1000 + Math.abs(p.el + 10) + (bearing === null ? 0 : 0.15 * angleBetween(p.az, bearing)) + (im.sample_type === 'full' ? 0 : 6);
    if (!best || score < best.score) best = { im, pointing: p, score, tier };
  }
  return best;
}

// "NNE" for 20 degrees, and so on.
export function compass(az) {
  return ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'][Math.round((((az % 360) + 360) % 360) / 22.5) % 16];
}
