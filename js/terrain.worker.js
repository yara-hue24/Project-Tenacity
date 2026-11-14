// Module worker around terrain.js. Start with: new Worker('js/terrain.worker.js', { type: 'module' }).
// Request:  { id, fn, args: [...] }      Reply: { id, ok: true, result } or { id, ok: false, error }.
// Typed arrays in a result are transferred, not copied. Requests are answered one at a time, in order.
//
//   load(metaUrl)                      -> { w, h, dx, dy, bounds, scale_m, elev }  (elev is a copy to keep)
//   slopeAspect()                      -> { slope, aspect }
//   roughness()                        -> Float32Array
//   hillshade(sunAzDeg, sunElDeg)      -> Uint8Array
//   castShadow(sunAzDeg, sunElDeg)     -> Uint8Array
//   viewshed(lat, lon, obsH, targetH)  -> Uint8Array
//   costDistance(sources, opts)        -> { time, prev }
//   elevProfile(points, stepM)         -> [{ lat, lon, elev, distM }] along the polyline through points
//
// metaUrl must be absolute: a relative URL would resolve against this script, not the page.

import * as T from './terrain.js';

let grid = null;
let grad = null;          // Horn gradient, shared by slopeAspect and hillshade
let slopeAspect = null;

const need = () => {
  if (!grid) throw new Error('no terrain loaded: call load first');
  return grid;
};
const gradient = () => grad || (grad = T.gradient(need()));

const handlers = {
  async load(metaUrl) {
    grid = await T.loadDem(metaUrl);
    grad = slopeAspect = null;
    return { ...grid, elev: grid.elev.slice() };
  },
  slopeAspect() {
    if (!slopeAspect) slopeAspect = T.slopeAspect(need(), gradient());
    return { slope: slopeAspect.slope.slice(), aspect: slopeAspect.aspect.slice() };
  },
  roughness: () => T.roughness(need()),
  hillshade: (az, el) => T.hillshade(need(), az, el, gradient()),
  castShadow: (az, el) => T.castShadow(need(), az, el),
  viewshed: (lat, lon, observerH, targetH) => T.viewshed(need(), lat, lon, observerH, targetH),
  costDistance: (sources, opts) => T.costDistance(need(), sources, opts),
  elevProfile(points, stepM) {
    const out = [];
    let base = 0;
    for (let i = 1; i < points.length; i++) {
      const leg = T.sampleLine(need(), points[i - 1], points[i], stepM);
      for (const p of leg.slice(out.length ? 1 : 0)) out.push({ ...p, distM: base + p.distM });
      base += leg[leg.length - 1].distM;
    }
    return out;
  },
};

const buffersOf = (v) => (ArrayBuffer.isView(v) ? [v.buffer] : []);

// One request in, one reply out, plus the buffers to hand over.
export async function handle({ id, fn, args = [] }) {
  try {
    if (!Object.hasOwn(handlers, fn)) throw new Error(`unknown function: ${fn}`);
    const result = await handlers[fn](...(Array.isArray(args) ? args : [args]));
    const transfer = buffersOf(result);
    if (result && !Array.isArray(result) && !ArrayBuffer.isView(result)) {
      for (const v of Object.values(result)) transfer.push(...buffersOf(v));
    }
    return { msg: { id, ok: true, result }, transfer };
  } catch (err) {
    return { msg: { id, ok: false, error: String(err?.message ?? err) }, transfer: [] };
  }
}

if (typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
  let queue = Promise.resolve();
  self.onmessage = (e) => {
    queue = queue.then(() => handle(e.data)).then(({ msg, transfer }) => self.postMessage(msg, transfer));
  };
}
