#!/usr/bin/env python3
"""Build two terrain overlays for Gale Crater, and sample them at every rover stop.

  data/overlays/slope.png   Slope from the 1 m HiRISE elevation model served by NASA Mars Trek
                            ("Gale_DEM_SMG_1m"), computed by the server at about 6 m per pixel and
                            binned against the 20 degree limit of NASA's exploration suit.
  data/overlays/overlays.json   Bounds, legends and sources, plus:
                            - a grid of loose-ground classes from THEMIS thermal inertia (ASU JMARS,
                              100 m), which the app draws as stipple, the map convention for sand;
                            - slope and thermal inertia sampled at every rover stop.

The image and the grid are plain latitude/longitude grids over one box.
Run after build_data.py:  python3 tools/build_overlays.py      (Python standard library only)
"""
import json
import math
import re
import struct
import urllib.parse
import urllib.request
import zlib
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "overlays"
CACHE = ROOT / "tools" / ".cache"

WEST, SOUTH, EAST, NORTH = 137.32, -4.88, 137.48, -4.55     # all of Curiosity's track
WIDTH, HEIGHT = 1552, 3200                                   # about 6 m per pixel
TREK = "https://trek.nasa.gov/mars/trekarcgis/rest/services/Gale_DEM_SMG_1m/ImageServer/exportImage"
JMARS = "https://ms-mars.mars.asu.edu/"
UA = "tenacity-data-snapshot/1.0"
M_PER_DEG = 59274.7                                          # metres per degree of latitude on Mars

SUIT_LIMIT_DEG = 20
# (upper bound in degrees, RGBA, legend). Gentle ground is left clear so the photo map shows through.
SLOPE_CLASSES = [
    (10, (0, 0, 0, 0), "Under 10°: clear"),
    (15, (242, 234, 221, 55), "10 to 15°"),
    (20, (242, 234, 221, 120), "15 to 20°"),
    (30, (255, 182, 46, 170), "20 to 30°: above the suit limit"),
    (91, (255, 182, 46, 240), "Over 30°"),
]
# Thermal inertia in TIU (J m^-2 K^-1 s^-1/2). Low values mean loose, fine material such as sand or dust.
# (upper bound, class digit in the grid, stipple spacing in screen pixels, legend)
LOOSE_CLASSES = [
    (300, 2, 6, "Under 300 TIU: loose sand or dust likely"),
    (400, 1, 11, "300 to 400 TIU: mixed ground"),
]


def get(url, params, cache_name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / cache_name
    if not path.exists():
        # JMARS rejects percent-encoded "/", ":" and ","
        req = urllib.request.Request(url + "?" + urllib.parse.urlencode(params, safe="/:,"), headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=240) as r:
            path.write_bytes(r.read())
    return path.read_bytes()


def write_png(path, width, height, rows):
    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    raw = b"".join(b"\x00" + row for row in rows)
    path.write_bytes(b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 6, 0, 0, 0))
                     + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


def read_tiff_f32(b):
    """Uncompressed little-endian float32 TIFF, in strips or tiles."""
    assert b[:4] == b"II*\x00", "not a little-endian TIFF"
    off = struct.unpack("<I", b[4:8])[0]
    tags = {}
    for i in range(struct.unpack("<H", b[off:off + 2])[0]):
        tag, typ, count, value = struct.unpack("<HHII", b[off + 2 + i * 12:off + 14 + i * 12])
        fmt, size = {1: ("B", 1), 3: ("H", 2), 4: ("I", 4)}.get(typ, (None, 0))
        if fmt is None:
            continue
        start = off + 10 + i * 12 if size * count <= 4 else value
        tags[tag] = list(struct.unpack("<" + fmt * count, b[start:start + size * count]))
    w, h = tags[256][0], tags[257][0]
    assert tags.get(259, [1])[0] == 1 and tags[258][0] == 32, "expected uncompressed 32-bit samples"
    if 322 in tags:
        tw, th = tags[322][0], tags[323][0]
        across = -(-w // tw)
        grid = [[0.0] * w for _ in range(h)]
        for k, o in enumerate(tags[324]):
            tx, ty = (k % across) * tw, (k // across) * th
            for r in range(min(th, h - ty)):
                vals = struct.unpack(f"<{tw}f", b[o + r * tw * 4:o + (r + 1) * tw * 4])
                cw = min(tw, w - tx)
                grid[ty + r][tx:tx + cw] = vals[:cw]
        return w, h, grid
    rows = []
    for o, c in zip(tags[273], tags[279]):
        for k in range(c // (w * 4)):
            rows.append(struct.unpack(f"<{w}f", b[o + k * w * 4:o + (k + 1) * w * 4]))
    return w, h, rows


def read_vicar_f32(b):
    n = int(re.search(rb"LBLSIZE=(\d+)", b[:200]).group(1))
    label = dict(re.findall(r"(\w+)=('[^']*'|\S+)", b[:n].decode("latin1")))
    lines, samples = int(label["NL"]), int(label["NS"])
    vals = struct.unpack(f"<{lines * samples}f", b[n:n + lines * samples * 4])
    return samples, lines, [vals[i * samples:(i + 1) * samples] for i in range(lines)]


def at(grid, w, h, lon, lat):
    """Grid value at a position, or None outside the box."""
    x = int((lon - WEST) / (EAST - WEST) * w)
    y = int((NORTH - lat) / (NORTH - SOUTH) * h)
    return grid[y][x] if 0 <= x < w and 0 <= y < h else None


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    bbox = f"{WEST},{SOUTH},{EAST},{NORTH}"
    stops = json.loads((ROOT / "data" / "site.json").read_text())["stops"]

    # ---- slope ----
    rule = {"rasterFunction": "Slope", "rasterFunctionArguments": {"ZFactor": 1.0 / M_PER_DEG}}   # heights in metres, grid in degrees
    sw, sh, slope = read_tiff_f32(get(TREK, {
        "bbox": bbox, "bboxSR": 104905, "size": f"{WIDTH},{HEIGHT}", "f": "image", "format": "tiff", "pixelType": "F32",
        "renderingRule": json.dumps(rule)}, "gale_slope_f32.tif"))
    share = [0] * len(SLOPE_CLASSES)
    rows = []
    for row in slope:
        px = bytearray()
        for v in row:
            k = next(i for i, c in enumerate(SLOPE_CLASSES) if v < c[0]) if v == v and v >= 0 else 0
            share[k] += 1
            px += bytes(SLOPE_CLASSES[k][1])
        rows.append(bytes(px))
    write_png(OUT / "slope.png", sw, sh, rows)

    # ---- loose ground ----
    tw, th, ti = read_vicar_f32(get(JMARS, {
        "SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "FORMAT": "image/vicar", "SRS": "EPSG:4326",
        "LAYERS": "thm_ti_100m_32bit", "STYLES": "", "WIDTH": 194, "HEIGHT": 400, "BBOX": bbox}, "gale_thermal_inertia.vic"))
    grid = ["".join(str(next((c for limit, c, _, _ in LOOSE_CLASSES if 0 < v < limit), 0)) for v in row) for row in ti]

    # ---- sample both at every stop, and check the slope against the tilt the rover recorded ----
    per_stop, pairs = {}, []
    for s in stops:
        sl = at(slope, sw, sh, s["lon"], s["lat"])
        tv = at(ti, tw, th, s["lon"], s["lat"])
        if sl is None or sl != sl or sl < 0:
            continue
        per_stop[s["id"]] = [round(sl, 1), round(tv) if tv and tv > 0 else None]
        pairs.append((sl, s["tilt_deg"]))
    diffs = sorted(abs(a - b) for a, b in pairs)
    n = len(pairs)
    ma, mb = sum(a for a, _ in pairs) / n, sum(b for _, b in pairs) / n
    corr = sum((a - ma) * (b - mb) for a, b in pairs) / math.sqrt(sum((a - ma) ** 2 for a, _ in pairs) * sum((b - mb) ** 2 for _, b in pairs))

    total = sw * sh
    meta = {
        "bounds": [[SOUTH, WEST], [NORTH, EAST]],
        "slope": {
            "file": "data/overlays/slope.png",
            "legend": [{"rgba": c[1], "label": c[2]} for c in SLOPE_CLASSES[1:]],
            "share_above_suit_limit": round(sum(share[3:]) / total, 4),
            "check": {"stops": n, "median_difference_from_rover_tilt_deg": round(diffs[n // 2], 1), "correlation_with_rover_tilt": round(corr, 2)},
            "source": "NASA Mars Trek, Gale_DEM_SMG_1m (MRO HiRISE 1 m elevation model), server-side slope at about 6 m per pixel",
            "source_url": "https://trek.nasa.gov/mars/",
        },
        "loose": {
            "width": tw, "height": th,
            "grid": grid,     # one string per row, north to south; each digit is a class, 0 = firm ground
            "legend": [{"class": c, "pitch": p, "label": label} for _, c, p, label in LOOSE_CLASSES],
            "source": "ASU JMARS, THEMIS quantitative thermal inertia, 100 m global mosaic (thm_ti_100m_32bit)",
            "source_url": "https://jmars.asu.edu/",
        },
        "suit_limit_deg": SUIT_LIMIT_DEG,
        "stops": per_stop,
    }
    (OUT / "overlays.json").write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")

    print(f"slope.png {sw}x{sh}: " + ", ".join(f"{c[2]} {share[i] / total:.1%}" for i, c in enumerate(SLOPE_CLASSES)))
    tvals = [v for row in ti for v in row if v > 0]
    print(f"thermal inertia {tw}x{th}: {min(tvals):.0f} to {max(tvals):.0f} TIU, under 300: {sum(v < 300 for v in tvals) / len(tvals):.1%}, 300-400: {sum(300 <= v < 400 for v in tvals) / len(tvals):.1%}")
    print(f"stops sampled: {n}  slope vs rover tilt: median difference {diffs[n // 2]:.1f} deg, correlation {corr:.2f}")


if __name__ == "__main__":
    main()
