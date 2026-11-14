// The map: base imagery, the layer registry and its presets, and the plan drawn the way
// rover planners draw a drive (named legs, stations with tolerance circles, keep-out hatch).
import * as M from './model.js';
import { S, C, RAMP, $, esc, ll, clamp, emit, fmtM } from './state.js';
import * as P from './plan.js';

const TILES = 'https://mars.nasa.gov/mmgis-maps/MSL/Layers/';
const M20_TILES = 'https://mars.nasa.gov/mmgis-maps/M20/Layers/';
const GLOBAL_TILES = 'https://cartocdn-gusc.global.ssl.fastly.net/opmbuilder/api/v1/map/named/opm-mars-basemap-v0-2/all/{z}/{x}/{y}.png';
const TOLERANCE_M = 6;          // arrival tolerance drawn around each station
const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export let map = null;
const G = {};                    // Leaflet layers by id, made on first use
const SRC = {};                  // canvases that raster and pattern layers draw from
export const LAYERS = [];
export const GROUPS = ['Imagery', 'Terrain', 'Light and comms', 'Ground', 'Minerals from orbit', 'Measured by Curiosity', 'Reach', 'Positions'];

// Fixed draw order, bottom to top. One colour fill at a time; patterns, lines and points go above it.
const PANES = [['fill', 300], ['pattern', 350], ['lines', 400], ['limits', 450], ['science', 500], ['route', 550], ['cursor', 640]];

// ---------- presets ----------

// A preset is a task: which fill, which overlays, and how far the imagery is greyed so data reads clearly.
export const PRESETS = [
  { id: 'plan', title: 'Plan', fill: 'none', grey: 0.55, on: ['hirise', 'relief', 'track', 'stops', 'samples', 'rovers', 'limit'] },
  { id: 'terrain', title: 'Terrain hazard', fill: 'slope', grey: 0.9, on: ['hirise', 'loose', 'relief', 'track'] },
  { id: 'science', title: 'Science', fill: 'none', grey: 0, on: ['hirise', 'track', 'stops', 'samples', 'dan', 'apxs', 'names', 'rovers'] },
  { id: 'light', title: 'Light + comms', fill: 'shade', grey: 0.9, on: ['hirise', 'shadow', 'nolos', 'track'], needs: 'grid' },
  { id: 'reach', title: 'Reach', fill: 'home', grey: 0.9, on: ['hirise', 'track', 'limit', 'relief'], needs: 'home' },
];

export function applyPreset(id) {
  const p = PRESETS.find((x) => x.id === id);
  S.preset = id;
  S.custom = false;
  S.fill = LAYERS.some((l) => l.id === p.fill && l.avail()) ? p.fill : 'none';
  S.on = new Set(p.on);
  syncLayers();
}

export function toggleLayer(id, onNow) {
  const def = LAYERS.find((l) => l.id === id);
  if (def.kind === 'fill') S.fill = onNow ? id : 'none';
  else if (onNow) S.on.add(id); else S.on.delete(id);
  S.custom = true;
  syncLayers();
}

const isOn = (def) => (def.kind === 'fill' ? S.fill === def.id : def.cat === 'base' || S.on.has(def.id));

export function syncLayers() {
  if (!map) return;
  const z = map.getZoom();
  const preset = PRESETS.find((x) => x.id === S.preset);
  $('#map').style.setProperty('--map-grey', S.fill !== 'none' ? 0.9 : preset.grey);
  for (const def of LAYERS) {
    const want = isOn(def) && def.avail() && z >= (def.minZoom || 0);
    if (want && !G[def.id]) G[def.id] = def.make();
    const layer = G[def.id];
    if (!layer) continue;
    if (want && !map.hasLayer(layer)) map.addLayer(layer);
    if (!want && map.hasLayer(layer)) map.removeLayer(layer);
  }
  emit('layers');
}

// A layer whose source data changed is rebuilt the next time it is shown.
export function invalidate(...ids) {
  for (const id of ids) {
    if (G[id] && map.hasLayer(G[id])) map.removeLayer(G[id]);
    delete G[id];
    delete SRC[id];
  }
  syncLayers();
}

// ---------- raster and pattern helpers ----------

// A canvas the size of a data grid, coloured cell by cell. colour(i) returns [r, g, b, a] or null.
export function gridCanvas(w, h, colour) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(w, h);
  const d = img.data;
  for (let i = 0; i < w * h; i++) {
    const px = colour(i);
    if (!px) continue;
    d[i * 4] = px[0]; d[i * 4 + 1] = px[1]; d[i * 4 + 2] = px[2]; d[i * 4 + 3] = px[3];
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const hex = (s) => [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16)];
export const RAMP_RGB = RAMP.map(hex);

// An image overlay whose element is a canvas, so a computed grid goes on the map without being encoded as a picture first.
let CanvasOverlay = null;
function fillLayer(canvasOrUrl, bounds, opts = {}) {
  const options = { pane: 'fill', opacity: opts.opacity ?? 0.78, interactive: false, className: opts.smooth ? '' : 'pixelated' };
  if (typeof canvasOrUrl === 'string') return L.imageOverlay(canvasOrUrl, bounds, options);
  CanvasOverlay = CanvasOverlay || L.ImageOverlay.extend({
    _initImage() {
      const el = this._image = this._url;
      L.DomUtil.addClass(el, 'leaflet-image-layer');
      if (this._zoomAnimated) L.DomUtil.addClass(el, 'leaflet-zoom-animated');
      if (this.options.className) L.DomUtil.addClass(el, this.options.className);
      el.onselectstart = L.Util.falseFn;
      el.onmousemove = L.Util.falseFn;
    },
  });
  return new CanvasOverlay(canvasOrUrl, bounds, options);
}

const PATTERNS = {
  // Diagonal hatch: ground that breaks a hard limit.
  hatch(ctx) {
    const t = document.createElement('canvas');
    t.width = t.height = 8;
    const x = t.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.38)';
    x.fillRect(0, 0, 8, 8);
    x.strokeStyle = 'rgba(255,255,255,0.62)';
    x.lineWidth = 1.1;
    x.beginPath();
    for (const o of [-8, 0, 8]) { x.moveTo(o, 8); x.lineTo(o + 8, 0); }
    x.stroke();
    return ctx.createPattern(t, 'repeat');
  },
  // Stipple: the map convention for sand.
  stipple(ctx) {
    const t = document.createElement('canvas');
    t.width = t.height = 10;
    const x = t.getContext('2d');
    x.fillStyle = '#fff';
    for (const [px, py] of [[2, 2], [7, 7]]) { x.beginPath(); x.arc(px, py, 1.05, 0, 7); x.fill(); }
    return ctx.createPattern(t, 'repeat');
  },
  // Horizontal rule: in shadow.
  rule(ctx) {
    const t = document.createElement('canvas');
    t.width = t.height = 6;
    const x = t.getContext('2d');
    x.fillStyle = 'rgba(0,0,0,0.5)';
    x.fillRect(0, 0, 6, 6);
    x.fillStyle = 'rgba(255,255,255,0.55)';
    x.fillRect(0, 0, 6, 1);
    return ctx.createPattern(t, 'repeat');
  },
  // Solid warning colour: the mask is already a thin line (a hard limit drawn as a boundary).
  limit: () => 'rgba(255,107,96,0.95)',
  // Darkening: ground in shadow.
  dark: () => 'rgba(0,0,0,0.6)',
  // Vertical rule: no line of sight.
  bars(ctx) {
    const t = document.createElement('canvas');
    t.width = t.height = 7;
    const x = t.getContext('2d');
    x.fillStyle = 'rgba(255,255,255,0.7)';
    x.fillRect(0, 0, 1.2, 7);
    return ctx.createPattern(t, 'repeat');
  },
};

// A pattern drawn at screen resolution and cut to a mask, so marks keep their size at every zoom.
// getMask returns a canvas whose opaque cells are where the pattern shows.
function patternLayer(getMask, bounds, pattern) {
  const canvas = L.DomUtil.create('canvas');
  canvas.style.pointerEvents = 'none';
  const [[south, west], [north, east]] = bounds;
  const draw = () => {
    const mask = getMask();
    const size = map.getSize();
    const ratio = window.devicePixelRatio || 1;
    canvas.width = size.x * ratio;
    canvas.height = size.y * ratio;
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    L.DomUtil.setPosition(canvas, map.containerPointToLayerPoint([0, 0]));
    if (!mask) return;
    const ctx = canvas.getContext('2d');
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    ctx.fillStyle = PATTERNS[pattern](ctx);
    ctx.fillRect(0, 0, size.x, size.y);
    const nw = map.latLngToContainerPoint([north, west]);
    const se = map.latLngToContainerPoint([south, east]);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = (se.x - nw.x) / mask.width < 3;
    ctx.drawImage(mask, nw.x, nw.y, se.x - nw.x, se.y - nw.y);
    ctx.globalCompositeOperation = 'source-over';
  };
  const Layer = L.Layer.extend({
    onAdd() { map.getPane('pattern').appendChild(canvas); map.on('move zoom resize', draw); draw(); },
    onRemove() { canvas.remove(); map.off('move zoom resize', draw); },
    redraw: draw,
  });
  return new Layer();
}

const loadImage = (url) => new Promise((ok, fail) => {
  const im = new Image();
  im.onload = () => ok(im);
  im.onerror = fail;
  im.src = url;
});

// Slope classes shipped as a picture (data/overlays/slope.png): the alpha channel encodes the class.
// Used until the elevation grid is loaded; after that slope is computed from the grid itself.
const SLOPE_PNG_CLASS = (a) => (a >= 220 ? 4 : a >= 150 ? 3 : a >= 90 ? 1 : a >= 30 ? 0 : -1);
async function slopeFromPicture() {
  if (SRC.slopePng) return SRC.slopePng;
  const im = await loadImage(S.overlays.slope.file);
  const c = document.createElement('canvas');
  c.width = im.width;
  c.height = im.height;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(im, 0, 0);
  const a = ctx.getImageData(0, 0, c.width, c.height).data;
  const cls = new Int8Array(c.width * c.height);
  for (let i = 0; i < cls.length; i++) cls[i] = SLOPE_PNG_CLASS(a[i * 4 + 3]);
  SRC.slopePng = { w: c.width, h: c.height, cls };
  return SRC.slopePng;
}

// Slope as classes 0..4 (10-15, 15-limit, limit-30, over 30; -1 below 10), from the grid when present.
export const SLOPE_BREAKS = [10, 15, 20, 30];
async function slopeClasses() {
  if (S.slope && S.grid) {
    const { w, h } = S.grid;
    const lim = S.params.slopeLimitDeg ?? 20;
    const cls = new Int8Array(w * h);
    for (let i = 0; i < cls.length; i++) {
      const v = S.slope[i];
      cls[i] = v > 30 ? 4 : v > lim ? 3 : v > 15 ? 1 : v > 10 ? 0 : -1;
    }
    return { w, h, cls };
  }
  return slopeFromPicture();
}

// Layers built from async sources are added empty and filled when the source is ready.
function lazy(build) {
  const group = L.layerGroup();
  build().then((layer) => { if (layer) group.addLayer(layer); }).catch(() => {});
  return group;
}

// Loose ground from the shipped thermal-inertia class grid: a mask canvas per class.
function looseMask() {
  if (SRC.loose) return SRC.loose;
  const { grid, width, height } = S.overlays.loose;
  SRC.loose = gridCanvas(width, height, (i) => (grid[Math.floor(i / width)][i % width] === '2' ? [255, 255, 255, 255] : null));   // class 2: under 300 TIU
  return SRC.loose;
}

// A Uint8Array mask (1 = show) on the elevation grid, as a canvas for patternLayer.
export const maskCanvas = (mask, w, h) => gridCanvas(w, h, (i) => (mask[i] ? [255, 255, 255, 255] : null));

// ---------- registry ----------

const rampLegend = (labels, colours = RAMP) => labels.map((label, i) => [colours[i], label]);

function contourLayer() {
  const { lines, scale, index_every_m: indexEvery } = S.contours;
  return L.layerGroup(lines.map(([level, flat]) => {
    const pts = [];
    let x = 0;
    let y = 0;
    for (let i = 0; i < flat.length; i += 2) {
      x += flat[i];
      y += flat[i + 1];
      pts.push([y / scale, x / scale]);
    }
    const index = level % indexEvery === 0;
    return L.polyline(pts, { pane: 'lines', color: C.text, weight: index ? 1.2 : 0.6, opacity: index ? 0.6 : 0.36, interactive: false, smoothFactor: 0.5 });
  }));
}

function trackLayer() {
  const all = S.site.route.map((r) => [r[1], r[0]]);
  return L.layerGroup([
    L.polyline(all, { pane: 'lines', color: '#000', weight: 4.5, opacity: 0.7, interactive: false }),
    L.polyline(all, { pane: 'lines', color: C.label, weight: 1.5, interactive: false }),
  ]);
}

// A short line across the track at a given distance along it, a fixed number of pixels long at any zoom.
function crossTick(chain, halfPx) {
  const route = S.site.route;
  const a = map.project(ll(M.pointAtChain(route, chain - 4)));
  const b = map.project(ll(M.pointAtChain(route, chain + 4)));
  const mid = map.project(ll(M.pointAtChain(route, chain)));
  const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  const nx = (-(b.y - a.y) / len) * halfPx;
  const ny = ((b.x - a.x) / len) * halfPx;
  return [map.unproject([mid.x - nx, mid.y - ny]), map.unproject([mid.x + nx, mid.y + ny])];
}

// Every rover stop as a tick across the track, rebuilt when the zoom settles so ticks keep their size.
function stopsLayer() {
  const group = L.layerGroup();
  const build = () => {
    group.clearLayers();
    for (const s of S.site.stops) {
      const line = crossTick(s.chain_m, 5);
      group.addLayer(L.polyline(line, { pane: 'science', color: '#000', weight: 4, opacity: 0.8, interactive: false }));
      group.addLayer(L.polyline(line, { pane: 'science', color: C.text, weight: 1.5, interactive: false }));
      group.addLayer(L.circleMarker(ll(s), { pane: 'science', radius: 11, stroke: false, fillOpacity: 0 }).on('click', (e) => {
        L.DomEvent.stopPropagation(e);
        emit('pick', { stop: s.id, lat: s.lat, lon: s.lon });
      }));
    }
  };
  group.on('add', () => { build(); map.on('zoomend', build); });
  group.on('remove', () => map.off('zoomend', build));
  return group;
}

function samplesLayer() {
  return L.layerGroup(S.site.stops.filter((s) => P.samplesAt(s).length).flatMap((s) => [
    L.circleMarker(ll(s), { pane: 'science', radius: 7.5, color: '#000', weight: 4.5, fill: false, interactive: false }),
    L.circleMarker(ll(s), { pane: 'science', radius: 7.5, color: C.text, weight: 2, fillColor: '#000', fillOpacity: 0.5 }).on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      emit('pick', { stop: s.id, lat: s.lat, lon: s.lon });
    }),
    L.circleMarker(ll(s), { pane: 'science', radius: 1.8, stroke: false, fillColor: C.text, fillOpacity: 1, interactive: false }),
  ]));
}

function roversLayer() {
  const group = L.layerGroup();
  const build = () => {
    group.clearLayers();
    for (const r of S.rovers) {
      for (const line of r.track || []) {
        const pts = line.map((c) => [c[1], c[0]]);
        group.addLayer(L.polyline(pts, { pane: 'lines', color: '#000', weight: 4.5, opacity: 0.7, interactive: false }));
        group.addLayer(L.polyline(pts, { pane: 'lines', color: C.label, weight: 1.5, interactive: false }));
      }
      const at = [r.now.lat, r.now.lon];
      group.addLayer(L.marker(at, { icon: flag('', `${esc(r.name.toUpperCase())} NOW<small>sol ${r.now.sol}</small>`, 24, -24), interactive: false, zIndexOffset: 200 }));
      group.addLayer(L.marker(at, { icon: L.divIcon({ className: '', iconSize: [14, 14], iconAnchor: [7, 7], html: '<svg width="14" height="14"><rect x="2.5" y="2.5" width="9" height="9" transform="rotate(45 7 7)" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>' }), zIndexOffset: 250, title: `${r.name}, sol ${r.now.sol}` })
        .on('click', () => emit('tab', 'rovers')));
    }
  };
  group.on('add', build);
  group.refresh = build;
  return group;
}

// Points along the track coloured by a measured value, in five classes of one hue.
export function trackPointsLayer(points, value, breaks, onPick) {
  const cls = (v) => breaks.findIndex((b) => v < b);
  return L.layerGroup(points.filter((p) => value(p) !== null).map((p) => {
    const k = cls(value(p));
    return L.circleMarker([p.lat, p.lon], { pane: 'science', radius: 4, color: '#000', weight: 1, fillColor: RAMP[k < 0 ? RAMP.length - 1 : k], fillOpacity: 1 })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); onPick(p); });
  }));
}

function define() {
  const b = S.overlays.bounds;
  const always = () => true;
  LAYERS.push(
    { id: 'hirise', title: 'HiRISE orbital image, 25 cm per pixel', group: 'Imagery', kind: 'base', cat: 'standard', avail: always,
      tag: 'MEASURED', prov: 'MRO HiRISE mosaic from NASA\'s Curiosity location map.',
      make: () => L.tileLayer(`${TILES}MSL_Gale_HiRISE-LRGB_78quads/{z}/{x}/{y}.png`, { tms: true, zIndex: 3, minNativeZoom: 10, maxNativeZoom: 18, maxZoom: 20, bounds: [[-4.8756, 137.3267], [-4.5551, 137.4786]], attribution: 'HiRISE: NASA/JPL-Caltech/Univ. of Arizona' }) },
    { id: 'names', title: 'NASA place names', group: 'Imagery', kind: 'base', cat: 'other', avail: always,
      tag: 'MEASURED', prov: 'Informal names used by the Curiosity team.',
      make: () => L.tileLayer(`${TILES}MSL_WebGIS_PlaceText/{z}/{x}/{y}.png`, { tms: true, zIndex: 5, minZoom: 4, maxNativeZoom: 17, maxZoom: 20, attribution: 'Place names: NASA/JPL-Caltech' }) },

    { id: 'nogo', title: 'No-go: slope over the suit limit', group: 'Terrain', kind: 'pattern', cat: 'base', avail: always, minZoom: 13,
      tag: 'DERIVED', prov: 'Cells steeper than the slope limit set in INCONS, from the HiRISE elevation model at about 6 m. Always drawn.',
      swatch: 'hatch',
      make: () => { let mask = null; const layer = patternLayer(() => mask, b, 'hatch');
        slopeClasses().then((s) => { mask = gridCanvas(s.w, s.h, (i) => (s.cls[i] >= 3 ? [255, 255, 255, 255] : null)); if (map.hasLayer(layer)) layer.redraw(); });
        return layer; } },
    { id: 'slope', title: 'Slope', group: 'Terrain', kind: 'fill', cat: 'standard', avail: always,
      tag: 'DERIVED', prov: 'From the MRO HiRISE 1 m elevation model (NASA Mars Trek), about 6 m cells. Checked against rover tilt at 1,388 stops: median difference 1.7°.',
      ramp: () => [[RAMP[0], '10 to 15°'], [RAMP[1], `15 to ${S.params.slopeLimitDeg ?? 20}°`], [RAMP[3], `${S.params.slopeLimitDeg ?? 20} to 30°`], [RAMP[4], 'over 30°']],
      make: () => lazy(async () => { const s = await slopeClasses(); return fillLayer(gridCanvas(s.w, s.h, (i) => (s.cls[i] < 0 ? null : [...RAMP_RGB[s.cls[i]], 215])), b); }) },
    { id: 'relief', title: `Relief lines, every ${S.contours.interval_m} m`, group: 'Terrain', kind: 'line', cat: 'standard', avail: always, minZoom: 13.5,
      tag: 'DERIVED', prov: 'Traced from the HiRISE 1 m elevation model within 450 m of the rover track. Lines show shape, not absolute height.',
      swatch: 'contour', make: contourLayer },

    { id: 'loose', title: 'Loose ground likely', group: 'Ground', kind: 'pattern', cat: 'standard', avail: always, minZoom: 12,
      tag: 'DERIVED', prov: 'Thermal inertia under 300 TIU (Mars Odyssey THEMIS, 100 m cells): ground that cools fast at night is usually sand or dust. A hint, far coarser than a footstep.',
      swatch: 'stipple', make: () => patternLayer(looseMask, b, 'stipple') },

    { id: 'track', title: 'Ground Curiosity has driven', group: 'Measured by Curiosity', kind: 'line', cat: 'standard', avail: always,
      tag: 'MEASURED', prov: 'Rover localisation, sols 3 to 5070. The only ground measured at walking scale.', swatch: 'track', make: trackLayer },
    { id: 'stops', title: 'Rover stops, with photos', group: 'Measured by Curiosity', kind: 'point', cat: 'standard', avail: always, minZoom: 14.5,
      tag: 'MEASURED', prov: '1,388 end-of-drive positions with tilt, elevation and a Navcam view.', swatch: 'tick', make: stopsLayer },
    { id: 'samples', title: 'Drill and scoop sites, minerals by CheMin', group: 'Measured by Curiosity', kind: 'point', cat: 'standard', avail: always, minZoom: 12,
      tag: 'MEASURED', prov: '48 samples analysed by X-ray diffraction, NASA PDS Geosciences Node.', swatch: 'ring', make: samplesLayer },

    { id: 'rovers', title: 'Where the rovers are now', group: 'Positions', kind: 'point', cat: 'standard', avail: always,
      tag: 'MEASURED', prov: 'End of each rover\'s last drive, read from NASA\'s position feeds when the page loads.', swatch: 'diamond', make: roversLayer },
  );
}

// Other files add layers once their data has loaded.
export function addLayer(def) {
  const i = LAYERS.findIndex((l) => l.id === def.id);
  if (i >= 0) LAYERS[i] = def; else LAYERS.push(def);
  invalidate(def.id);
}
export { fillLayer, patternLayer, lazy, rampLegend };
export const refreshRovers = () => { if (G.rovers && G.rovers.refresh && map.hasLayer(G.rovers)) G.rovers.refresh(); };

// ---------- map ----------

export function initMap() {
  const crs = L.extend({}, L.CRS.EPSG3857, { R: S.site.meta.mars_radius_m });
  map = L.map('map', {
    crs, zoomControl: false, minZoom: 2, maxZoom: 20, zoomSnap: reduced ? 0.5 : 0, zoomDelta: 0.5, preferCanvas: true, worldCopyJump: true,
    scrollWheelZoom: reduced, inertia: !reduced, inertiaDeceleration: 2200, inertiaMaxSpeed: 2600, easeLinearity: 0.22,
  });
  map.attributionControl.setPrefix(false);
  L.control.scale({ imperial: false, position: 'bottomright', maxWidth: 150 }).addTo(map);
  L.control.zoom({ position: 'topright' }).addTo(map);
  const Fit = L.Control.extend({
    options: { position: 'topright' },
    onAdd() {
      const el = L.DomUtil.create('div', 'leaflet-bar');
      el.innerHTML = '<a role="button" tabindex="0" title="Show the whole walk" aria-label="Show the whole walk"><svg viewBox="0 0 18 18"><path d="M2 6V2h4M12 2h4v4M16 12v4h-4M6 16H2v-4"/></svg></a>';
      L.DomEvent.disableClickPropagation(el);
      el.addEventListener('click', fitPlan);
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fitPlan(); } });
      return el;
    },
  });
  map.addControl(new Fit());
  PANES.forEach(([name, z]) => { map.createPane(name).style.zIndex = z; });
  map.getPane('fill').style.pointerEvents = 'none';

  // Whole planet at the bottom, so zooming out from a walk ends at Mars itself. zIndex is set on every
  // image layer: they are added at different moments, and without it coarse layers can cover sharp ones.
  L.tileLayer(GLOBAL_TILES, { zIndex: 1, maxNativeZoom: 7, maxZoom: 11, attribution: 'Global basemap: OpenPlanetaryMap' }).addTo(map);
  L.tileLayer(`${TILES}MSL_CTX_ortho_mosaic_6m/{z}/{x}/{y}.png`, { tms: true, zIndex: 2, minZoom: 6, maxNativeZoom: 13, maxZoom: 20, attribution: 'CTX: NASA/JPL-Caltech/MSSS', bounds: [[-7.8441, 135.9788], [-3.3971, 139.4859]] }).addTo(map);
  L.tileLayer(`${M20_TILES}HMC_13E10_co5_colorcorrect_rect/{z}/{x}/{y}.png`, { tms: true, zIndex: 2, minZoom: 6, maxNativeZoom: 12, maxZoom: 20, bounds: [[15.0, 67.4993], [30.0006, 78.7492]], attribution: 'HRSC: ESA/DLR/FU Berlin' }).addTo(map);
  L.tileLayer(`${M20_TILES}M20_HiRISE_RGB_CTX_mosaic_25cm_v7_Merge_LERC_clip/{z}/{x}/{y}.png`, { tms: true, zIndex: 3, minZoom: 10, maxNativeZoom: 19, maxZoom: 20, bounds: [[18.2371, 77.1575], [18.5206, 77.5115]] }).addTo(map);

  define();
  G.dyn = L.layerGroup().addTo(map);
  if (!reduced) smoothWheel();

  map.on('mousemove', (e) => emit('cursor', { lat: e.latlng.lat, lon: e.latlng.lng }));
  map.on('mouseout', () => emit('cursor', null));
  map.on('click', (e) => emit('pick', { lat: e.latlng.lat, lon: e.latlng.lng }));
  let settle = 0;
  map.on('zoomend', () => { clearTimeout(settle); settle = setTimeout(() => { syncLayers(); drawPlan(); }, 140); });
  map.setMaxBounds([[-85, -180], [85, 360]]);
}

// Continuous wheel zoom: the wheel sets a target and the map eases toward it around the pointer.
function smoothWheel() {
  let target = null;
  let anchor = null;
  let raf = 0;
  const tick = () => {
    const z = map.getZoom();
    const dz = target - z;
    if (Math.abs(dz) < 0.005) { map.setZoomAround(anchor, target, { animate: false }); target = null; raf = 0; return; }
    map.setZoomAround(anchor, z + dz * 0.24, { animate: false });
    raf = requestAnimationFrame(tick);
  };
  map.getContainer().addEventListener('wheel', (e) => {
    e.preventDefault();
    const px = e.deltaY * (e.deltaMode === 1 ? 32 : e.deltaMode === 2 ? 400 : 1);
    target = clamp((target ?? map.getZoom()) - clamp(px, -240, 240) / 200, map.getMinZoom(), map.getMaxZoom());
    anchor = map.mouseEventToContainerPoint(e);
    if (!raf) raf = requestAnimationFrame(tick);
  }, { passive: false });
}

export function fitPlan() {
  const pts = S.legs.flatMap((l) => l.line);
  const legend = $('#legend');
  const under = legend && legend.open ? legend.offsetHeight + 24 : 60;   // keep the walk clear of the corner legend
  if (pts.length) map.fitBounds(L.latLngBounds(pts), { paddingTopLeft: [60, 50], paddingBottomRight: [70, under], maxZoom: 18, animate: false });
}

export function panTo(p) {
  if (!map.getBounds().pad(-0.12).contains(ll(p))) map.panTo(ll(p), { animate: !reduced, duration: 0.35 });
}

// ---------- the plan on the map ----------

// A label set off from its point and joined to it by a hairline.
function flag(cls, html, dx, dy) {
  const w = Math.abs(dx);
  const h = Math.max(Math.abs(dy), 1);
  const up = dy < 0;
  const left = dx < 0;
  return L.divIcon({
    className: '', iconSize: [0, 0], iconAnchor: [0, 0],
    html: `<svg width="${w}" height="${h}" style="position:absolute;left:${left ? -w : 0}px;top:${up ? -h : 0}px;overflow:visible"><line x1="${left ? w : 0}" y1="${up ? h : 0}" x2="${left ? 0 : w}" y2="${up ? 0 : h}" stroke="#fff" stroke-width="1"/></svg>
      <div class="lbl ${cls}" style="${left ? `right:${w}px` : `left:${w}px`};top:${dy - 9}px">${html}</div>`,
  });
}

const cased = (pts, color, weight, extra = {}) => [
  L.polyline(pts, { pane: 'route', color: '#000', weight: weight + 4, opacity: 0.95, interactive: false, lineCap: 'butt' }),
  L.polyline(pts, { pane: 'route', color, weight, interactive: false, lineCap: 'butt', ...extra }),
];

const STAR = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M11 1.5l2.8 6.2 6.7.7-5 4.5 1.4 6.6L11 16.1 5.1 19.5l1.4-6.6-5-4.5 6.7-.7z" fill="#fff" stroke="#000" stroke-width="1.4"/></svg>';
const CREW = '<svg width="18" height="18" viewBox="0 0 18 18"><path d="M9 2l6.5 13h-13z" fill="#fff" stroke="#000" stroke-width="1.5"/></svg>';

export function drawPlan() {
  if (!map || !S.sim) return;
  G.dyn.clearLayers();
  const add = (layers) => [].concat(layers).forEach((l) => G.dyn.addLayer(l));
  const sim = S.sim;
  const close = map.getZoom() >= 13;
  const walkSteps = sim.steps.filter((s) => s.type === 'walk');

  // Stretches that break a rule get a coloured band under the route: yellow caution, red warning.
  for (const rule of sim.rules) {
    if (rule.level !== 'warning' && rule.level !== 'caution') continue;
    for (const seg of rule.segments || []) {
      const pts = sim.samples.filter((q) => q.stepIndex === seg.stepIndex && q.distM >= seg.fromDistM - 0.01 && q.distM <= seg.toDistM + 0.01).map(ll);
      if (pts.length > 1) add(L.polyline(pts, { pane: 'route', color: rule.level === 'warning' ? C.warn : C.caut, weight: 15, opacity: 0.9, interactive: false, lineCap: 'butt' }));
    }
  }

  // Planned legs: solid on ground a rover has driven, dashed where only orbital data exists.
  S.legs.forEach((leg) => add(cased(leg.line, C.route, 4, leg.proven ? {} : { dashArray: '9 7' })));

  // Ground covered up to the playhead.
  if (S.tS > 0) {
    const here = P.positionAt(sim, S.tS);
    const done = sim.samples.filter((q) => q.tS <= S.tS).map(ll);
    done.push(ll(here));
    if (done.length > 1) add(L.polyline(done, { pane: 'route', color: '#fff', weight: 2, interactive: false }));
    add(L.marker(ll(here), { icon: L.divIcon({ className: '', iconSize: [18, 18], iconAnchor: [9, 10], html: CREW }), zIndexOffset: 900, interactive: false }));
  }

  // Distance walked, posted along the way out like the posts on a trail.
  if (close) {
    const out = sim.samples.filter((q) => sim.steps[q.stepIndex].type === 'walk' && sim.steps[q.stepIndex].id !== 'RETURN');
    const far = out.length ? out[out.length - 1].distM : 0;
    const every = far > 4000 ? 1000 : far > 1500 ? 500 : 250;
    let next = every;
    for (const q of out) {
      if (q.distM < next) continue;
      add(L.marker(ll(q), { icon: L.divIcon({ className: 'post', iconSize: [0, 0], html: `<span>${next >= 1000 ? `${next / 1000} km` : `${next} m`}</span>` }), interactive: false, zIndexOffset: 100 }));
      next += every;
    }
  }

  // Where the suit-failure return limit is first passed on the way out.
  const fr1 = sim.rules.find((r) => r.id === 'FR-01');
  if (fr1 && fr1.level === 'warning' && close) {
    const lim = fr1.limit * 60;
    const first = sim.samples.find((q) => q.homeS > lim);
    if (first) add(L.marker(ll(first), { icon: flag('W', `FR-01 LIMIT<small>${fr1.limit} min from refuge</small>`, 34, 34), interactive: false, zIndexOffset: 800 }));
  }

  // Keep-out zones: red outline, light red fill, the way rover planners mark them.
  (S.plan.koz || []).forEach((z, k) => {
    add(L.circle(ll(z), { pane: 'route', radius: z.r, color: C.warn, weight: 2, fillColor: C.warnfill, fillOpacity: 0.3, interactive: false }));
    if (close) add(L.marker(ll(z), { icon: flag('W', `KOZ_${String(k + 1).padStart(2, '0')}`, 26, -22), interactive: false, zIndexOffset: 250 }));
  });

  const ref = P.refugePt();
  add(L.marker(ll(ref), { icon: L.divIcon({ className: '', iconSize: [22, 22], iconAnchor: [11, 11], html: STAR }), zIndexOffset: 500, title: 'Refuge' })
    .on('click', (e) => { L.DomEvent.stopPropagation(e); emit('select', { type: 'incons' }); }));
  if (close) add(L.marker(ll(ref), { icon: flag('', `REFUGE<small>${esc(ref.name)}</small>`, 30, -26), interactive: false, zIndexOffset: 300 }));

  S.plan.stations.forEach((st, i) => {
    const p = P.pointOf(st.at);
    const selected = S.sel && S.sel.type === 'station' && S.sel.i === i;
    add(L.circle(ll(p), { pane: 'route', radius: TOLERANCE_M, color: C.route, weight: 1.8, fill: false, interactive: false }));
    add(L.circleMarker(ll(p), { pane: 'route', radius: 4, color: '#000', weight: 1.5, fillColor: '#fff', fillOpacity: 1 })
      .on('click', (e) => { L.DomEvent.stopPropagation(e); emit('select', { type: 'station', i }); }));
    if (selected) add(L.circleMarker(ll(p), { pane: 'cursor', radius: 14, color: C.focus, weight: 2, fill: false, interactive: false }));
    if (close) {
      const step = walkSteps[i];
      const flagged = step && step.flags && step.flags.length;
      add(L.marker(ll(p), { icon: flag('', `${P.stationId(i)}<small>${esc(p.name)}</small>`, i % 2 ? 34 : -34, i % 2 ? 26 : -26), interactive: false, zIndexOffset: 300 + (flagged ? 1 : 0) }));
    }
  });

  if (S.probe) {
    add(L.circleMarker(ll(S.probe), { pane: 'cursor', radius: 10, color: C.focus, weight: 2, fill: false, interactive: false }));
    add(L.circleMarker(ll(S.probe), { pane: 'cursor', radius: 1.5, color: C.focus, weight: 2, fillOpacity: 1, interactive: false }));
  }
}

// ---------- legend ----------

const SWATCH = {
  route: `<svg width="36" height="8"><path d="M0 4h36" stroke="#000" stroke-width="7"/><path d="M0 4h36" stroke="${C.route}" stroke-width="3.5"/></svg>`,
  dashed: `<svg width="36" height="8"><path d="M0 4h36" stroke="#000" stroke-width="7"/><path d="M0 4h36" stroke="${C.route}" stroke-width="3.5" stroke-dasharray="7 5"/></svg>`,
  koz: `<svg width="36" height="14"><circle cx="18" cy="7" r="5.5" fill="rgba(179,0,27,.35)" stroke="${C.warn}" stroke-width="1.6"/></svg>`,
  station: `<svg width="36" height="14"><circle cx="18" cy="7" r="5.5" fill="none" stroke="${C.route}" stroke-width="1.6"/><circle cx="18" cy="7" r="2" fill="#fff"/></svg>`,
  walked: '<svg width="36" height="8"><path d="M0 4h36" stroke="#000" stroke-width="5"/><path d="M0 4h36" stroke="#fff" stroke-width="2"/></svg>',
  caution: `<svg width="36" height="10"><path d="M0 5h36" stroke="${C.caut}" stroke-width="9"/><path d="M0 5h36" stroke="${C.route}" stroke-width="3"/></svg>`,
  hatch: '<svg width="36" height="12"><defs><pattern id="lg-h" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><path d="M0 0v6" stroke="#fff" stroke-width="1.3"/></pattern></defs><rect width="36" height="12" fill="#333"/><rect width="36" height="12" fill="url(#lg-h)"/></svg>',
  stipple: '<svg width="36" height="12"><rect width="36" height="12" fill="#333"/><g fill="#fff"><circle cx="4" cy="3" r="1"/><circle cx="14" cy="3" r="1"/><circle cx="24" cy="3" r="1"/><circle cx="34" cy="3" r="1"/><circle cx="9" cy="9" r="1"/><circle cx="19" cy="9" r="1"/><circle cx="29" cy="9" r="1"/></g></svg>',
  rule: '<svg width="36" height="12"><rect width="36" height="12" fill="#222"/><path d="M0 1h36M0 7h36" stroke="#aaa" stroke-width="1"/></svg>',
  bars: '<svg width="36" height="12"><rect width="36" height="12" fill="#333"/><path d="M1 0v12M8 0v12M15 0v12M22 0v12M29 0v12" stroke="#ddd" stroke-width="1.2"/></svg>',
  contour: `<svg width="36" height="12"><path d="M1 4c8-4 14 5 22 2s8-3 12-2M1 10c8-3 15 4 23 1s8-2 11-1" fill="none" stroke="${C.text}" stroke-width="0.9" opacity="0.75"/></svg>`,
  track: `<svg width="36" height="8"><path d="M0 4h36" stroke="#000" stroke-width="4.5"/><path d="M0 4h36" stroke="${C.label}" stroke-width="1.5"/></svg>`,
  tick: `<svg width="36" height="12"><path d="M0 6h36" stroke="${C.label}" stroke-width="1.5"/><path d="M18 1v10" stroke="#000" stroke-width="4"/><path d="M18 1v10" stroke="${C.text}" stroke-width="1.5"/></svg>`,
  ring: `<svg width="36" height="16"><circle cx="18" cy="8" r="6" fill="none" stroke="${C.text}" stroke-width="2"/><circle cx="18" cy="8" r="1.8" fill="${C.text}"/></svg>`,
  diamond: '<svg width="36" height="14"><rect x="13.5" y="2.5" width="9" height="9" transform="rotate(45 18 7)" fill="#fff" stroke="#000" stroke-width="1.2"/></svg>',
  dots: `<svg width="36" height="10">${RAMP.map((c, i) => `<circle cx="${4 + i * 7}" cy="5" r="3" fill="${c}" stroke="#000" stroke-width="0.8"/>`).join('')}</svg>`,
  limit: `<svg width="36" height="8"><path d="M0 4h36" stroke="${C.warn}" stroke-width="2.5"/></svg>`,
  dark: '<svg width="36" height="12"><rect width="36" height="12" fill="#777"/><rect x="12" width="24" height="12" fill="rgba(0,0,0,0.6)"/></svg>',
  star: `<svg width="36" height="18" viewBox="-7 2 36 18">${STAR.replace(/<\/?svg[^>]*>/g, '')}</svg>`,
};
export const swatch = (def) => (def.ramp ? `<svg width="36" height="10">${def.ramp().map(([c], i, a) => `<rect x="${(36 / a.length) * i}" width="${36 / a.length}" height="10" fill="${c}"/>`).join('')}</svg>` : SWATCH[def.swatch] || '');

// The corner legend lists only what is on the map right now.
export function legendHTML() {
  const rows = [[SWATCH.route, 'Planned leg, ground a rover has driven'], [SWATCH.dashed, 'Planned leg, orbital data only'],
    ...((S.plan.koz || []).length ? [[SWATCH.koz, 'Keep-out zone']] : []),
    [SWATCH.station, `Station, ${TOLERANCE_M} m arrival tolerance`], [SWATCH.star, 'Refuge: start and return']];
  if (S.tS > 0) rows.push([SWATCH.walked, 'Covered at the playhead']);
  if (S.sim && S.sim.rules.some((r) => (r.level === 'caution' || r.level === 'warning') && (r.segments || []).length)) rows.push([SWATCH.caution, 'Stretch that breaks a rule (yellow caution, red warning)']);
  const z = map ? map.getZoom() : 0;
  for (const def of LAYERS) {
    if (!isOn(def) || !def.avail() || def.kind === 'base' || z < (def.minZoom || 0)) continue;
    if (def.ramp) rows.push([swatch(def), `${esc(def.title)}: ${def.ramp().map(([, l]) => l).join(' · ')}`]);
    else if (def.swatch) rows.push([swatch(def), esc(def.title)]);
  }
  return rows.map(([sw, label]) => `${sw}<span>${label}</span>`).join('');
}

export { fmtM };
