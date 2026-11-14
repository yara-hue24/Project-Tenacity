// Shared state, colours, small helpers and a tiny event bus. No rendering here.

// Mirrors css/style.css. Each coding colour has one meaning everywhere.
export const C = {
  bg0: '#0d0d0d', bg1: '#1a1a1a', bg2: '#2b2b2b', line: '#6e6e6e', hair: '#3a3a3a', text: '#f2f2f2', label: '#c4c4c4', off: '#9a9a9a',
  warn: '#ff6b60', warnfill: '#b3001b', caut: '#ffd60a', adv: '#7fb0ff', stale: '#35d8e8', route: '#ff5cf4', ok: '#4ade80', focus: '#00ff66',
};
// Data ramp for map fills: one hue, light to dark. Red, amber and green are never used for data.
export const RAMP = ['#deebf7', '#9ecae1', '#4292c6', '#2171b5', '#084594'];

export const MARS_R = 3396190;
export const SOL_S = 88775.244;
export const MARS_HOUR_S = SOL_S / 24;

export const S = {
  site: null, cfg: null, rovers: [], roversAt: null, roversSnapshot: '', minerals: null, overlays: null, contours: null,
  byId: new Map(),
  rasters: [], science: {},       // baked layer manifests and their data, filled as files load
  grid: null,                     // elevation grid (js/terrain.js), null until loaded
  home: null,                     // cost field: seconds to walk back to the refuge from every cell
  auto: new Map(),                // least-time paths found over the terrain, by leg key
  trip: null, plan: null, params: {},
  legs: [], sim: null,            // derived on every plan change
  tS: 0, playing: false, rate: 60,
  sel: null,                      // {type: 'incons' | 'leg' | 'station' | 'return', i}
  probe: null,                    // {lat, lon, stop?}
  mode: 'edit', preset: 'plan', fill: 'none', on: new Set(), custom: false,
  tab: 'sequence', log: [],
};

export const $ = (s) => document.querySelector(s);
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
export const ll = (p) => [p.lat, p.lon];
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const p2 = (n) => String(n).padStart(2, '0');

// Distances, durations and clocks. Units are always written out.
export const fmtM = (m) => (Math.abs(m) >= 10000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);
export const fmtMin = (s) => `${Math.round(s / 60)} min`;
export const fmtHM = (s) => {
  const m = Math.round(s / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${p2(m % 60)} min`;
};
// Elapsed time in the day/hours:minutes:seconds form used on crew displays.
export const pet = (s) => {
  const t = Math.max(0, Math.round(s));
  return `${Math.floor(t / 86400)}/${p2(Math.floor(t / 3600) % 24)}:${p2(Math.floor(t / 60) % 60)}:${p2(t % 60)}`;
};
export const clockH = (h, sec = false) => {
  const t = Math.round((((h % 24) + 24) % 24) * 3600) % 86400;
  return `${p2(Math.floor(t / 3600))}:${p2(Math.floor(t / 60) % 60)}${sec ? `:${p2(t % 60)}` : ''}`;
};
export const parseClock = (s) => {
  const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(s);
  return m ? Number(m[1]) + Number(m[2]) / 60 : null;
};
export const fmtLat = (lat) => `${lat.toFixed(5)}°`;
export const fmtLon = (lon) => `${lon.toFixed(5)}°`;

// Metres east and north of an origin, good for a few kilometres.
export function localM(o, p) {
  const k = (Math.PI / 180) * MARS_R;
  return { x: (p.lon - o.lon) * k * Math.cos((o.lat * Math.PI) / 180), y: (p.lat - o.lat) * k };
}
export function distM(a, b) {
  const d = localM(a, b);
  return Math.hypot(d.x, d.y);
}
export function headingDeg(a, b) {
  const d = localM(a, b);
  return ((Math.atan2(d.x, d.y) * 180) / Math.PI + 360) % 360;
}

// Console: time-stamped lines, newest last. level is 'status', 'W', 'C' or 'A'.
export function log(level, text) {
  const last = S.log[S.log.length - 1];
  if (last && last.text === text && last.level === level) return;
  S.log.push({ at: new Date(), level, text });
  if (S.log.length > 200) S.log.shift();
  emit('log');
}

const handlers = {};
export const on = (name, fn) => { (handlers[name] ||= []).push(fn); };
export const emit = (name, data) => { (handlers[name] || []).forEach((fn) => fn(data)); };
