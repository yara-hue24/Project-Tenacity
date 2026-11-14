#!/usr/bin/env python3
"""Bake the Gale Crater elevation grid that the browser loads for profiles, slope and line of sight.

  data/terrain/dem.i16.gz   Heights from the 1 m HiRISE elevation model served by NASA Mars Trek
                            ("Gale_DEM_SMG_1m"), resampled by the server to about 6 m per cell.
  data/terrain/dem.json     Size, bounds, encoding, checks.

Encoding (the decoder is written against exactly this):
  q = round((elev_m - offset_m) / scale_m), scale_m = 0.1, every q fits in int16.
  The grid is row-major. Row 0 is the northern edge, column 0 the western edge. Cells are areas:
  the centre of cell (r, c) is at  lat = north - (r + 0.5) * (north - south) / h,
                                   lon = west  + (c + 0.5) * (east - west) / w.
  Horizontal delta coding: stored[r][0] = q[r][0] - q[r-1][0]  (q[-1][0] = 0),
                           stored[r][c] = q[r][c] - q[r][c-1]  for c > 0,
  each stored value wrapped into int16 (two's complement), written little-endian, then the whole
  array gzip-compressed at level 9.
  To decode: gunzip, read w*h little-endian int16; for each row keep a running sum that starts from
  the first value of the row above (0 for row 0); elev_m = q * scale_m + offset_m.

Run:  cd tools && python3 build_terrain.py      (Python standard library only)
"""
import array
import gzip
import json
import math
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from collections import deque
from pathlib import Path

from build_overlays import EAST, NORTH, SOUTH, TREK, WEST, read_tiff_f32

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "terrain"
CACHE = ROOT / "tools" / ".cache"
UA = "data-snapshot/1.0"                       # generic on purpose: nothing about the project in any request
M_PER_DEG = 59274.7                            # metres per degree of latitude on Mars (radius 3396.19 km)

SIZES = [(1552, 3200), (1164, 2400)]           # about 6 m; fallback about 8 m if the file is too big
MAX_GZ_BYTES = 6 * 1024 * 1024
SCALE_M = 0.1
MAX_DOWNLOAD = 45 * 1024 * 1024                # refuse anything bigger than this in one response
PAUSE_S = 1.5                                  # wait after each real download
TREK_INFO = TREK.rsplit("/", 1)[0]


def fetch(url, params, cache_name, safe="/:,", cache_dir=None):
    """GET with an on-disk cache. Returns bytes. A cached file is never re-downloaded."""
    cache_dir = cache_dir or CACHE
    cache_dir.mkdir(parents=True, exist_ok=True)
    path = cache_dir / cache_name
    if path.exists() and path.stat().st_size > 0:
        return path.read_bytes()
    full = url + ("?" + urllib.parse.urlencode(params, safe=safe) if params else "")
    last = None
    for attempt in range(3):
        try:
            req = urllib.request.Request(full, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=240) as r:
                declared = int(r.headers.get("Content-Length") or 0)
                if declared > MAX_DOWNLOAD:
                    raise RuntimeError(f"{cache_name}: server announces {declared} bytes, over the limit")
                data = r.read(MAX_DOWNLOAD + 1)
            if len(data) > MAX_DOWNLOAD:
                raise RuntimeError(f"{cache_name}: response over the size limit")
            path.write_bytes(data)
            time.sleep(PAUSE_S)
            return data
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            last = e
            time.sleep(5 * (attempt + 1))
    raise RuntimeError(f"could not fetch {full}: {last}")


def export_f32(west, south, east, north, w, h, cache_name):
    """One raw float32 elevation request (no rendering rule). Returns rows of floats, north first."""
    b = fetch(TREK, {"bbox": f"{west},{south},{east},{north}", "bboxSR": 104905, "size": f"{w},{h}",
                     "f": "image", "format": "tiff", "pixelType": "F32",
                     "interpolation": "RSP_BilinearInterpolation"}, cache_name)
    if b[:4] != b"II*\x00":
        raise RuntimeError(f"{cache_name}: not a TIFF (starts {b[:80]!r})")
    tw, th, rows = read_tiff_f32(b)
    if (tw, th) != (w, h):
        raise RuntimeError(f"{cache_name}: asked {w}x{h}, got {tw}x{th}")
    return rows


def fetch_dem(w, h, max_w=None, max_h=None):
    """Whole box at w x h cells, in one request if the server allows that size, otherwise in tiles
    cut on exact cell boundaries and stitched."""
    if max_w is None:
        info = json.loads(fetch(TREK_INFO, {"f": "json"}, "trek_gale_dem_info.json"))
        max_w, max_h = int(info.get("maxImageWidth", 4096)), int(info.get("maxImageHeight", 4096))
    if w <= max_w and h <= max_h:
        # same request and cache file as build_contours.py at the default size, so both agree
        name = "gale_dem_f32.tif" if (w, h) == SIZES[0] else f"gale_dem_f32_{w}x{h}.tif"
        return [list(r) for r in export_f32(WEST, SOUTH, EAST, NORTH, w, h, name)], 1
    nx, ny = -(-w // max_w), -(-h // max_h)
    xs = [round(i * w / nx) for i in range(nx + 1)]
    ys = [round(j * h / ny) for j in range(ny + 1)]
    grid = [[0.0] * w for _ in range(h)]
    for j in range(ny):
        for i in range(nx):
            x0, x1, y0, y1 = xs[i], xs[i + 1], ys[j], ys[j + 1]
            tile = export_f32(WEST + (EAST - WEST) * x0 / w, NORTH - (NORTH - SOUTH) * y1 / h,
                              WEST + (EAST - WEST) * x1 / w, NORTH - (NORTH - SOUTH) * y0 / h,
                              x1 - x0, y1 - y0, f"gale_dem_f32_{w}x{h}_x{x0}_y{y0}_{x1 - x0}x{y1 - y0}.tif")
            for r, row in enumerate(tile):
                grid[y0 + r][x0:x1] = row
    return grid, nx * ny


def is_nodata(v):
    """NaN, a fill value far outside any Mars height, or exactly 0 (not a possible height in Gale)."""
    return v != v or v < -9000.0 or v > 22000.0 or v == 0.0


def fill_nodata(grid, w, h):
    """Replace no-data cells by the nearest valid cell (breadth-first over 8 neighbours).
    Returns the number of cells filled."""
    bad = [[is_nodata(v) for v in row] for row in grid]
    n_bad = sum(sum(row) for row in bad)
    if n_bad == 0:
        return 0
    if n_bad == w * h:
        raise RuntimeError("the elevation grid has no valid cells")
    steps = ((-1, 0), (1, 0), (0, -1), (0, 1), (-1, -1), (-1, 1), (1, -1), (1, 1))
    queue = deque()
    for r in range(h):
        for c in range(w):
            if not bad[r][c] and any(0 <= r + dr < h and 0 <= c + dc < w and bad[r + dr][c + dc] for dr, dc in steps):
                queue.append((r, c))
    while queue:
        r, c = queue.popleft()
        v = grid[r][c]
        for dr, dc in steps:
            rr, cc = r + dr, c + dc
            if 0 <= rr < h and 0 <= cc < w and bad[rr][cc]:
                bad[rr][cc] = False
                grid[rr][cc] = v
                queue.append((rr, cc))
    return n_bad


def quantise(grid, offset_m):
    return [[int(math.floor((v - offset_m) / SCALE_M + 0.5)) for v in row] for row in grid]


def wrap16(v):
    return ((v + 32768) & 0xFFFF) - 32768


def encode(q, w, h):
    """Rows of int -> gzip bytes, as described at the top of this file."""
    out = array.array("h")
    above = 0
    for row in q:
        out.append(wrap16(row[0] - above))
        out.extend(array.array("h", [wrap16(b - a) for a, b in zip(row, row[1:])]))
        above = row[0]
    assert len(out) == w * h and out.itemsize == 2
    if sys.byteorder == "big":
        out.byteswap()
    return gzip.compress(out.tobytes(), compresslevel=9, mtime=0)


def decode(gz, w, h, scale_m, offset_m):
    """The reference decoder: gzip bytes -> rows of heights in metres."""
    raw = array.array("h")
    raw.frombytes(gzip.decompress(gz))
    if sys.byteorder == "big":
        raw.byteswap()
    assert len(raw) == w * h
    rows, above = [], 0
    for r in range(h):
        acc = above
        row = []
        for d in raw[r * w:(r + 1) * w]:
            acc = wrap16(acc + d)
            row.append(acc)
        above = row[0]
        rows.append([v * scale_m + offset_m for v in row])
    return rows


def bilinear(grid, w, h, lon, lat):
    """Height at a position, interpolated between cell centres. None outside the box."""
    x = (lon - WEST) / (EAST - WEST) * w - 0.5
    y = (NORTH - lat) / (NORTH - SOUTH) * h - 0.5
    if not (-0.5 <= x <= w - 0.5 and -0.5 <= y <= h - 0.5):
        return None
    x, y = min(max(x, 0.0), w - 1.0), min(max(y, 0.0), h - 1.0)
    c, r = min(int(x), w - 2), min(int(y), h - 2)
    fx, fy = x - c, y - r
    return ((grid[r][c] * (1 - fx) + grid[r][c + 1] * fx) * (1 - fy)
            + (grid[r + 1][c] * (1 - fx) + grid[r + 1][c + 1] * fx) * fy)


def build(w, h):
    grid, requests = fetch_dem(w, h)
    filled = fill_nodata(grid, w, h)
    lo, hi = min(map(min, grid)), max(map(max, grid))
    offset_m = float(round((lo + hi) / 2 / 100.0) * 100)
    q = quantise(grid, offset_m)
    qlo, qhi = min(map(min, q)), max(map(max, q))
    if qlo < -32768 or qhi > 32767:
        raise RuntimeError(f"heights {lo} to {hi} m do not fit in int16 at {SCALE_M} m steps")
    return grid, q, encode(q, w, h), offset_m, lo, hi, filled, requests


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    notes = []
    for w, h in SIZES:
        grid, q, gz, offset_m, lo, hi, filled, requests = build(w, h)
        if len(gz) <= MAX_GZ_BYTES or (w, h) == SIZES[-1]:
            break
        notes.append(f"{w} x {h} came to {len(gz)} bytes gzipped, over {MAX_GZ_BYTES}; dropped to the next size")

    # ---- verify: decode our own bytes and compare with the source array ----
    back = decode(gz, w, h, SCALE_M, offset_m)
    max_err = max(abs(a - b) for ra, rb in zip(back, grid) for a, b in zip(ra, rb))
    if max_err > SCALE_M / 2 + 1e-9:
        raise RuntimeError(f"round trip error {max_err} m is over half a step")

    # ---- compare with the rover's own elevation at its stops ----
    stops = json.loads((ROOT / "data" / "site.json").read_text())["stops"]
    diffs = []
    for s in stops:
        v = bilinear(back, w, h, s["lon"], s["lat"])
        if v is not None and s.get("elev_m") is not None:
            diffs.append((s["id"], s["sol"], v - s["elev_m"]))
    every = max(1, len(diffs) // 20)
    sample = diffs[every // 2::every][:20]

    def med(values):
        v = sorted(values)
        return (v[(len(v) - 1) // 2] + v[len(v) // 2]) / 2

    all_d = sorted(d for _, _, d in diffs)
    stops_check = {
        "meaning": "this grid minus the rover's localisation elevation, metres (grid interpolated between cell centres)",
        "sample_stops": len(sample), "sample_median_m": round(med([d for _, _, d in sample]), 2),
        "sample_min_m": round(min(d for _, _, d in sample), 2), "sample_max_m": round(max(d for _, _, d in sample), 2),
        "all_stops": len(all_d), "all_median_m": round(med(all_d), 2),
        "all_p05_m": round(all_d[int(0.05 * (len(all_d) - 1))], 2), "all_p95_m": round(all_d[int(0.95 * (len(all_d) - 1))], 2),
        # the offset is not constant: it grows along the route, so it is given per fifth of the stops in route order
        "route_fifths": [{"sols": [part[0][1], part[-1][1]], "median_m": round(med([d for _, _, d in part]), 2)}
                         for part in (diffs[k * len(diffs) // 5:(k + 1) * len(diffs) // 5] for k in range(5))],
    }

    # ---- eight cells for the decoder to check itself against: four corners, four inside ----
    cells = [(0, 0), (0, w - 1), (h - 1, 0), (h - 1, w - 1),
             (h // 5, w // 3), (2 * h // 5, 2 * w // 3), (3 * h // 5, w // 4), (4 * h // 5, 3 * w // 4)]
    check = [{"row": r, "col": c, "elev_m": round(q[r][c] * SCALE_M + offset_m, 1)} for r, c in cells]

    (OUT / "dem.i16.gz").write_bytes(gz)
    meta = {
        "file": "dem.i16.gz", "w": w, "h": h,
        "cell_m": round((NORTH - SOUTH) * M_PER_DEG / h, 3),
        "bounds": [[SOUTH, WEST], [NORTH, EAST]],
        "scale_m": SCALE_M, "offset_m": offset_m,
        "encoding": "int16-le, horizontal delta, gzip",
        "min_m": round(lo, 1), "max_m": round(hi, 1),
        "nodata_filled_fraction": round(filled / (w * h), 6),
        "datum": "Heights in metres as served; the service does not state its vertical datum. Against the rover's "
                 "localisation elevations (Mars geoid) the grid is not a constant shift: see stops_check.route_fifths. "
                 "Use it for relative height (slope, climb, line of sight), not to restate absolute rover elevations.",
        "source": "NASA Mars Trek, Gale_DEM_SMG_1m (MRO HiRISE 1 m elevation model), raw float32 heights "
                  f"resampled by the server (bilinear) to {w} x {h} cells",
        "source_url": TREK,
        "bytes_gz": len(gz),
        "check": check,
        "cell_deg": [round((NORTH - SOUTH) / h, 9), round((EAST - WEST) / w, 9)],     # [latitude, longitude] step
        "m_per_deg": M_PER_DEG,
        "layout": "row-major; row 0 = north edge, col 0 = west edge; cell centres at half-cell offsets inside bounds",
        "decode": "gunzip; int16 little-endian; first value of a row adds to the first value of the row above "
                  "(0 above row 0), every other value adds to the value on its left, wrapping in int16; "
                  "elev_m = q * scale_m + offset_m",
        "round_trip_max_error_m": round(max_err, 4),
        "stops_check": stops_check,
        "credit": "NASA/JPL-Caltech/University of Arizona/USGS (MRO HiRISE), served by NASA Mars Trek",
        "notes": notes,
    }
    (OUT / "dem.json").write_text(json.dumps(meta, indent=1) + "\n", encoding="utf-8")

    print(f"dem.i16.gz {w} x {h} cells, {len(gz)} bytes ({len(gz) / 1048576:.2f} MB), {requests} request(s)")
    print(f"heights {lo:.2f} to {hi:.2f} m, offset_m {offset_m}, q {min(map(min, q))} to {max(map(max, q))}")
    print(f"no-data cells filled: {filled} ({filled / (w * h):.4%})")
    print(f"round trip against the source array: max error {max_err:.4f} m")
    print("stops:", json.dumps(stops_check))
    for n in notes:
        print("note:", n)


if __name__ == "__main__":
    main()
