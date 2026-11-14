// Sun position and local solar time on Mars. Pure functions, no DOM.
//
// Algorithm: Mars24 (Allison & McEwen 2000, Planet. Space Sci. 48, 215-235; Allison 1997),
// as published by NASA GISS: https://www.giss.nasa.gov/tools/mars24/help/algorithm.html
// Equation numbers in the comments (B-1, C-1, ...) are the ones on that page. The coefficients
// were copied from the page itself and the two worked examples on it are in the tests.
//
// Conventions used here:
//   - longitude is EAST positive (Mars24 itself uses west longitude; LMST = MST + lonEast / 15);
//   - latitude is used as given. Mars24 expects planetographic latitude, the map uses
//     planetocentric; at Gale the two differ by about 0.05 deg, which is ignored;
//   - "hours" in every *H field are Mars clock hours (1/24 of a sol), not SI hours;
//   - azimuth is degrees clockwise from north;
//   - sunrise and sunset are for the geometric centre of the Sun on a flat horizon at 0 deg.
//     Atmospheric refraction, the Sun's disc (about 0.35 deg across at Mars), dust twilight and
//     real terrain (crater walls, Mount Sharp) are all IGNORED. Terrain can move the real
//     sunrise or sunset by many minutes; the disc and refraction by about one minute.

import { marsLocalHours } from './model.js';

// One sol in Earth days (Mars24 eq. C-2) and in SI seconds.
export const SOL_DAYS = 1.0274912517;
export const SOL_LENGTH_S = SOL_DAYS * 86400;      // 88775.244 s
export const MARS_HOUR_S = SOL_LENGTH_S / 24;      // 3698.968 s: one hour on a Mars clock

// Same value js/model.js uses: 37 leap seconds + 32.184 s, valid from 2017 until the next leap second.
const TT_MINUS_UTC_S = 69.184;

const RAD = Math.PI / 180;
const sinD = (deg) => Math.sin(deg * RAD);
const cosD = (deg) => Math.cos(deg * RAD);
const mod = (x, m) => ((x % m) + m) % m;

// B-3 perturbers: amplitude (deg), period (Earth years), phase (deg).
const PBS = [
  [0.0071, 2.2353, 49.409],
  [0.0057, 2.7543, 168.173],
  [0.0039, 1.1177, 191.837],
  [0.0037, 15.7866, 21.736],
  [0.0021, 2.1354, 15.704],
  [0.0020, 2.4694, 95.528],
  [0.0018, 32.8493, 49.095],
];

// Orbital quantities that depend on the instant only: season (Ls), equation of time, declination.
export function marsOrbit(epochMs) {
  const jdTT = epochMs / 86400000 + 2440587.5 + TT_MINUS_UTC_S / 86400;   // A-2, A-5
  const dt = jdTT - 2451545.0;                                            // A-6
  const M = 19.3871 + 0.52402073 * dt;                                    // B-1 mean anomaly
  const aFMS = 270.3871 + 0.524038496 * dt;                               // B-2 fictitious mean sun
  let pbs = 0;                                                            // B-3
  for (const [a, tau, phi] of PBS) pbs += a * cosD((0.985626 * dt) / tau + phi);
  const nuM = (10.691 + 3.0e-7 * dt) * sinD(M) + 0.623 * sinD(2 * M) + 0.050 * sinD(3 * M)
    + 0.005 * sinD(4 * M) + 0.0005 * sinD(5 * M) + pbs;                   // B-4 equation of centre
  const lsDeg = mod(aFMS + nuM, 360);                                     // B-5
  const eotDeg = 2.861 * sinD(2 * lsDeg) - 0.071 * sinD(4 * lsDeg) + 0.002 * sinD(6 * lsDeg) - nuM;   // C-1
  const declDeg = Math.asin(0.42565 * sinD(lsDeg)) / RAD + 0.25 * sinD(lsDeg);                       // D-1
  return { lsDeg, eotDeg, eotMin: eotDeg * 4, declDeg };   // 1 deg = 4 Mars clock minutes
}

// Sun elevation and azimuth for a local TRUE solar time, declination and latitude.
// Lets the app scrub the time of day without recomputing the orbit.
export function sunAt(ltstH, declDeg, latDeg) {
  const h = 15 * (ltstH - 12);   // hour angle, deg, positive after local noon
  const sinEl = sinD(latDeg) * sinD(declDeg) + cosD(latDeg) * cosD(declDeg) * cosD(h);
  const elevDeg = Math.asin(Math.max(-1, Math.min(1, sinEl))) / RAD;
  const east = -sinD(h) * cosD(declDeg);
  const north = sinD(declDeg) * cosD(latDeg) - cosD(declDeg) * sinD(latDeg) * cosD(h);
  const azDeg = mod(Math.atan2(east, north) / RAD, 360);
  return { elevDeg, azDeg };
}

// Flat-horizon sunrise and sunset in local true solar time for a declination and latitude.
// Returns null times when the Sun never rises or never sets (polar night or day).
export function daylight(declDeg, latDeg) {
  const cosH0 = -Math.tan(latDeg * RAD) * Math.tan(declDeg * RAD);
  if (cosH0 >= 1) return { sunriseLtstH: null, sunsetLtstH: null, dayLengthH: 0 };
  if (cosH0 <= -1) return { sunriseLtstH: null, sunsetLtstH: null, dayLengthH: 24 };
  const h0H = Math.acos(cosH0) / RAD / 15;   // half the day, Mars hours
  return { sunriseLtstH: 12 - h0H, sunsetLtstH: 12 + h0H, dayLengthH: 2 * h0H };
}

// Everything the planner needs about the Sun at an Earth instant and a place on Mars.
//   lsDeg         areocentric solar longitude (season), 0-360
//   eotMin        equation of time, Mars clock minutes: true solar time minus mean solar time
//   lmstH, ltstH  local mean and local true solar time, Mars hours 0-24
//   declDeg       solar declination (latitude of the subsolar point)
//   elevDeg       Sun elevation above a flat horizon (negative at night)
//   azDeg         Sun azimuth, degrees clockwise from north
//   sunrise/sunset in LTST and LMST, Mars hours (null if the Sun does not cross the horizon)
//   dayLengthH    sunrise to sunset, Mars hours
//   solLengthS    length of the sol, SI seconds
// The LMST sunrise and sunset use the equation of time at `epochMs`; it drifts by well under
// a minute within one sol.
export function marsSun(epochMs, latDeg, lonEastDeg) {
  const { lsDeg, eotDeg, eotMin, declDeg } = marsOrbit(epochMs);
  const lmstH = marsLocalHours(epochMs, lonEastDeg);     // C-2, C-3
  const ltstH = mod(lmstH + eotDeg / 15, 24);            // C-4
  const { elevDeg, azDeg } = sunAt(ltstH, declDeg, latDeg);
  const { sunriseLtstH, sunsetLtstH, dayLengthH } = daylight(declDeg, latDeg);
  const toLmst = (ltst) => (ltst === null ? null : mod(ltst - eotDeg / 15, 24));
  return {
    lsDeg, eotMin, lmstH, ltstH, declDeg, elevDeg, azDeg,
    sunriseLtstH, sunsetLtstH,
    sunriseLmstH: toLmst(sunriseLtstH), sunsetLmstH: toLmst(sunsetLtstH),
    dayLengthH, solLengthS: SOL_LENGTH_S,
  };
}
