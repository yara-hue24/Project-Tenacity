#!/usr/bin/env python3
"""Bake picture layers for the Gale Crater map: orbital mineral maps and night-time infrared.

  data/layers/crism_<scene>_<hyd|phy|fm2>.png   MRO CRISM map-projected browse products (18 m), cropped to
                                               the map box, no-data made transparent.
  data/layers/themis_day_night_ir.png          THEMIS day infrared with colourised night infrared (100 m).
  data/layers/thermal_inertia.png              THEMIS thermal inertia as an 8-bit grey raster (100 m).
  data/layers/rasters.json                     The manifest: bounds, legends, sources, notes for each file.

Every image is a plain latitude/longitude grid (the same grid family as data/overlays/slope.png), so each
one is drawn as an image overlay stretched over its "bounds".

CRISM "bounds" are not the PDS label's: each scene is moved by a measured shift (about 150 to 200 m) so that
it lines up with the HiRISE base map. The label's own bounds stay in the manifest as "bounds_label", with
the measurement under "registration". See APPLY_REGISTRATION below.

What the CRISM colours mean is not guessed here: the three band names are read from each product's PDS
label and checked against the list below, which was copied from the CRISM Data Product SIS (see SIS_URL).
If a label ever disagrees, the legend note for that image says "unverified".

Run:  cd tools && python3 build_rasters.py      (Python standard library only)
"""
import colorsys
import json
import math
import operator
import re
import struct
import zlib
from pathlib import Path

from build_overlays import EAST, JMARS, NORTH, SOUTH, WEST, read_vicar_f32
from build_terrain import CACHE, M_PER_DEG, ROOT, fetch

OUT = ROOT / "data" / "layers"
REL = "data/layers/"                                  # "file" in the manifest is relative to the site root
MAX_FILE_BYTES = 700 * 1024

PDS = "https://pds-geosciences.wustl.edu/mro/mro-m-crism-5-rdr-mptargeted-v1/mrocr_4001/"
SIS_URL = PDS + "document/crism_dpsis.htm"
ODE_URL = ("https://oderest.rsl.wustl.edu/live2/?query=product&target=mars&ihid=MRO&iid=CRISM&pt=MTRDR"
           "&westlon=137.32&eastlon=137.48&minlat=-4.88&maxlat=-4.55&results=fp&output=JSON")

# Fourteen CRISM targeted scenes touch the box (PDS Orbital Data Explorer, ODE_URL). These three 18 m
# scenes were picked by counting rover stops that fall on valid pixels (with the label's own bounds):
# B6F1 alone has 955 of 1388, adding C0EF gives 1249, adding 2037A gives all 1388. The count after the
# scenes are lined up with the base map is printed at the end of a run. (folder under browse/, scene id)
SCENES = [
    ("2008/2008_191", "frt0000b6f1"),      # Mount Sharp: everything south of about -4.69
    ("2008/2008_230", "frt0000c0ef"),      # the plains crossing and the foot of Mount Sharp
    ("2011/2011_254", "frt0002037a"),      # the landing site and Yellowknife Bay
]

# CRISM map projection is not tied to the HiRISE base map the app draws on (the rover track and the elevation
# grid share that base map's frame). Each scene is therefore lined up with it: the scene's infrared albedo
# browse image (IRA) is correlated with the Trek HiRISE mosaic near the rover track, and the image bounds are
# moved by the best shift. Set to False to keep the label's own bounds; they are in the manifest either way.
APPLY_REGISTRATION = True
HIRISE = "https://trek.nasa.gov/mars/trekarcgis/rest/services/curiosity_hirise_mosaic/ImageServer/exportImage"
REG_W, REG_H = 776, 1600               # the map box at about 12 m per cell
REG_REACH = 26                         # search this many cells each way (about 320 m)
REG_NEAR_TRACK_M = 1500                # only ground this close to a rover stop is used

# Browse products. "bands" and the channel wording are from the CRISM Data Product SIS v1.3.7.7
# (5 November 2024), list of browse products, items 1.4 FM2, 2.4 HYD and 2.5 PHY, read on 2026-11-14.
PRODUCTS = {
    "hyd": {
        "name": "Hydrated minerals",
        "bands": ("SINDEX2", "BD2100_2", "BD1900_2"),
        "channels": ("spectral index keyed to bound water bands indicative of hydrated sulfates",
                     "2100 nm band depth attributable to a shifted H2O band exhibited by monohydrated sulfates",
                     "1900 nm band depth attributable to bound molecular H2O"),
        "reading": "Polyhydrated sulfates have strong 1900 nm and 2400 nm bands and appear magenta; monohydrated "
                   "sulfates have a strong 2100 nm band and appear yellow/green; blue indicates other hydrated "
                   "minerals (such as clays, glass, carbonate or zeolite).",
        "legend": [("Magenta: polyhydrated sulfates", (255, 0, 255)),
                   ("Yellow to green: monohydrated sulfates", (200, 230, 40)),
                   ("Blue: other hydrated minerals (clays, glass, carbonate, zeolite)", (40, 80, 255))],
    },
    "phy": {
        "name": "Clays and other hydroxylated minerals",
        "bands": ("D2300", "D2200", "BD1900R2"),
        "channels": ("2300 nm spectral drop-off associated with Fe/Mg phyllosilicate or Mg-carbonate",
                     "2200 nm spectral drop-off associated with Al-phyllosilicate or hydrated silica",
                     "1900 nm band depth attributable to bound molecular H2O"),
        "reading": "Fe/Mg-OH bearing minerals (for example Fe/Mg clays) appear red, or magenta when hydrated; "
                   "Al/Si-OH bearing minerals (Al clays or hydrated silica) appear green, or cyan when hydrated; "
                   "blue indicates other hydrated minerals (such as sulfates, glass, carbonate or water ice).",
        "legend": [("Red: Fe/Mg clays (magenta when hydrated)", (255, 40, 40)),
                   ("Magenta: hydrated Fe/Mg clays", (255, 0, 255)),
                   ("Green: Al clays or hydrated silica (cyan when hydrated)", (40, 220, 60)),
                   ("Cyan: hydrated Al clays or hydrated silica", (0, 230, 230)),
                   ("Blue: other hydrated minerals (sulfates, glass, carbonate)", (40, 80, 255))],
    },
    "fm2": {
        "name": "Iron minerals",
        "bands": ("BD530_2", "BD920_2", "BDI1000VIS"),
        "channels": ("530 nm band depth indicating the presence of nanophase ferric oxides",
                     "920 nm band depth highlighting coarser-grained ferric minerals or low-Ca pyroxene",
                     "1000 nm VNIR band depth highlighting dust-free or more mafic surfaces"),
        "reading": "Particularly sensitive to olivine and pyroxene, as well as nanophase ferric oxide and "
                   "crystalline ferric or ferrous minerals. Red often indicates nanophase ferric oxides, green "
                   "coarser-grained iron-bearing minerals, blue dust-free or more mafic surfaces. The SIS table of "
                   "summary parameters adds for the red band (BD530_2): higher value has more crystalline hematite. "
                   "The SIS text names the red and green bands BD530 and BD920; the label of this file names their "
                   "revised versions BD530_2 and BD920_2.",
        "legend": [("Red: nanophase ferric oxides (530 nm band)", (255, 40, 40)),
                   ("Green: coarser-grained iron minerals or low-Ca pyroxene (920 nm band)", (40, 220, 60)),
                   ("Blue: dust-free or more mafic surfaces (1000 nm band)", (40, 80, 255))],
    },
}
CRISM_CAVEAT = ("Colours show the relative strength of spectral bands inside this one scene, not amounts of a "
                "mineral, and are not comparable between scenes: each scene has its own stretch. The label says "
                "spectra must be analysed for a positive mineral identification.")


# ---------------------------------------------------------------- PNG in and out (8-bit, not interlaced)

def read_png(b):
    """Returns (width, height, channels, rows). Rows are bytearrays. Channels: 1 grey, 2 grey+alpha, 3 RGB, 4 RGBA."""
    if b[:8] != b"\x89PNG\r\n\x1a\n":
        raise ValueError("not a PNG")
    w, h, depth, ctype, _, _, interlace = struct.unpack(">IIBBBBB", b[16:29])
    if depth != 8 or interlace != 0 or ctype not in (0, 2, 4, 6):
        raise ValueError(f"unsupported PNG: depth {depth}, colour type {ctype}, interlace {interlace}")
    ch = {0: 1, 2: 3, 4: 2, 6: 4}[ctype]
    pos, idat = 8, []
    while pos < len(b):
        n, tag = struct.unpack(">I4s", b[pos:pos + 8])
        if tag == b"IDAT":
            idat.append(b[pos + 8:pos + 8 + n])
        pos += 12 + n
    raw = zlib.decompress(b"".join(idat))
    stride = w * ch
    if len(raw) != h * (stride + 1):
        raise ValueError("PNG data has the wrong length")
    rows, prev = [], bytearray(stride)
    for y in range(h):
        f = raw[y * (stride + 1)]
        cur = bytearray(raw[y * (stride + 1) + 1:(y + 1) * (stride + 1)])
        if f == 1:
            for x in range(ch, stride):
                cur[x] = (cur[x] + cur[x - ch]) & 255
        elif f == 2:
            for x in range(stride):
                cur[x] = (cur[x] + prev[x]) & 255
        elif f == 3:
            for x in range(stride):
                cur[x] = (cur[x] + (((cur[x - ch] if x >= ch else 0) + prev[x]) >> 1)) & 255
        elif f == 4:
            for x in range(stride):
                a = cur[x - ch] if x >= ch else 0
                up = prev[x]
                c = prev[x - ch] if x >= ch else 0
                pa, pb, pc = abs(up - c), abs(a - c), abs(a + up - 2 * c)
                cur[x] = (cur[x] + (a if pa <= pb and pa <= pc else up if pb <= pc else c)) & 255
        elif f != 0:
            raise ValueError(f"bad PNG filter {f}")
        rows.append(cur)
        prev = cur
    return w, h, ch, rows


_COST = bytes(v if v < 128 else 256 - v for v in range(256))


def _paeth(a, b, c):
    pa, pb, pc = abs(b - c), abs(a - c), abs(a + b - 2 * c)
    return a if pa <= pb and pa <= pc else b if pb <= pc else c


def png_bytes(w, h, ch, rows):
    """Encode 8-bit rows. Tries each PNG row filter for the whole image and a per-row choice, keeps the smallest."""
    ctype = {1: 0, 2: 4, 3: 2, 4: 6}[ch]
    stride = w * ch
    zero, prev = bytes(ch), bytes(stride)
    variants = [bytearray() for _ in range(6)]             # filters 0 to 4 everywhere, then best per row
    for row in rows:
        row = bytes(row)
        assert len(row) == stride
        left, upleft = zero + row[:-ch], zero + prev[:-ch]
        cands = (row,
                 bytes((a - b) & 255 for a, b in zip(row, left)),
                 bytes((a - b) & 255 for a, b in zip(row, prev)),
                 bytes((a - ((b + c) >> 1)) & 255 for a, b, c in zip(row, left, prev)),
                 bytes((x - _paeth(a, b, c)) & 255 for x, a, b, c in zip(row, left, prev, upleft)))
        for f in range(5):
            variants[f] += bytes([f]) + cands[f]
        best = min(range(5), key=lambda f: sum(cands[f].translate(_COST)))
        variants[5] += bytes([best]) + cands[best]
        prev = row
    idat = min((zlib.compress(bytes(v), 9) for v in variants), key=len)

    def chunk(tag, data):
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data))
    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, ctype, 0, 0, 0))
            + chunk(b"IDAT", idat) + chunk(b"IEND", b""))


def save_png(name, w, h, ch, rows):
    """Write, read back and compare. Returns the byte count."""
    data = png_bytes(w, h, ch, rows)
    bw, bh, bch, back = read_png(data)
    assert (bw, bh, bch) == (w, h, ch) and all(bytes(a) == bytes(b) for a, b in zip(back, rows)), name
    (OUT / name).write_bytes(data)
    return len(data)


# ---------------------------------------------------------------- CRISM

def label_number(label, key):
    return float(re.search(rf"\b{key}\s*=\s*(-?[\d.]+(?:[Ee][-+]?\d+)?)", label).group(1))


def label_tuple(label, key):
    body = re.search(rf"\b{key}\s*=\s*\(([^)]*)\)", label).group(1)
    return [t.strip().strip('"') for t in body.split(",")]


def crism_geometry(label, w, h, stem):
    """(pixels per degree, west outer edge, north outer edge). The label's limits are the centres of the
    first and last pixels: their span is one pixel short of the image, and the ENVI header of the same
    product puts the corner half a pixel further out. So the outer edges are half a pixel beyond them."""
    if "EQUIRECTANGULAR" not in label or label_number(label, "CENTER_LATITUDE") != 0:
        raise RuntimeError(f"{stem}: not a simple latitude/longitude grid")
    res = label_number(label, "MAP_RESOLUTION")
    s, n = label_number(label, "MINIMUM_LATITUDE"), label_number(label, "MAXIMUM_LATITUDE")
    wl, el = label_number(label, "WESTERNMOST_LONGITUDE"), label_number(label, "EASTERNMOST_LONGITUDE")
    if (w, h) != (int(label_number(label, "LINE_SAMPLES")), int(label_number(label, "LINES"))):
        raise RuntimeError(f"{stem}: PNG size does not match the label")
    if abs((el - wl) * res - (w - 1)) > 0.6 or abs((n - s) * res - (h - 1)) > 0.6:
        raise RuntimeError(f"{stem}: label limits are not pixel centres as assumed")
    return res, wl - 0.5 / res, n + 0.5 / res


def band_pass(img, w, h, fine=2, coarse=20):
    """Mean over a small box minus mean over a large box; None where either box touches missing data."""
    total = [[0.0] * (w + 1) for _ in range(h + 1)]
    count = [[0] * (w + 1) for _ in range(h + 1)]
    for y in range(h):
        run, seen, row = 0.0, 0, img[y]
        t0, t1, c0, c1 = total[y], total[y + 1], count[y], count[y + 1]
        for x in range(w):
            v = row[x]
            if v is not None:
                run += v
                seen += 1
            t1[x + 1] = t0[x + 1] + run
            c1[x + 1] = c0[x + 1] + seen

    def mean(y, x, k):
        y0, y1, x0, x1 = y - k, y + k + 1, x - k, x + k + 1
        if y0 < 0 or x0 < 0 or y1 > h or x1 > w or count[y1][x1] - count[y0][x1] - count[y1][x0] + count[y0][x0] != (2 * k + 1) ** 2:
            return None
        return (total[y1][x1] - total[y0][x1] - total[y1][x0] + total[y0][x0]) / (2 * k + 1) ** 2

    out = [[None] * w for _ in range(h)]
    for y in range(coarse, h - coarse):
        o = out[y]
        for x in range(coarse, w - coarse):
            a = mean(y, x, coarse)
            if a is not None:
                o[x] = mean(y, x, fine) - a
    return out


def best_shift(points, ref, reach):
    """points: [(x, y, value)] on the registration grid; ref: flat band-passed reference (0.0 where missing).
    Returns (dx, dy, r at the peak, r with no shift): a feature at (x, y) is found in ref at (x + dx, y + dy)."""
    idx = [y * REG_W + x for x, y, _ in points]
    u = [v for _, _, v in points]
    n = len(u)
    su, suu = sum(u), sum(v * v for v in u)
    r = {}
    for dy in range(-reach, reach + 1):
        for dx in range(-reach, reach + 1):
            off = dy * REG_W + dx
            v = [ref[i + off] for i in idx]
            sv = sum(v)
            den = (suu - su * su / n) * (sum(map(operator.mul, v, v)) - sv * sv / n)
            r[dx, dy] = (sum(map(operator.mul, u, v)) - su * sv / n) / math.sqrt(den) if den > 0 else 0.0
    (dx, dy), peak = max(r.items(), key=lambda kv: kv[1])

    def vertex(lo, hi):                                   # parabola through the peak and its two neighbours
        return 0.5 * (lo - hi) / (lo - 2 * peak + hi) if lo is not None and hi is not None and lo - 2 * peak + hi < 0 else 0.0
    return (dx + vertex(r.get((dx - 1, dy)), r.get((dx + 1, dy))), dy + vertex(r.get((dx, dy - 1)), r.get((dx, dy + 1))),
            peak, r[0, 0])


_reference = []


def hirise_reference():
    """The base map's frame: the Trek HiRISE mosaic of the box, band-passed, as one flat list."""
    if not _reference:
        w, h, ch, rows = read_png(fetch(HIRISE, {"bbox": f"{WEST},{SOUTH},{EAST},{NORTH}", "bboxSR": 104905,
                                                 "size": f"{REG_W},{REG_H}", "f": "image", "format": "png"},
                                        f"gale_hirise_mosaic_{REG_W}x{REG_H}.png"))
        if (w, h) != (REG_W, REG_H):
            raise RuntimeError("HiRISE reference came back at the wrong size")
        ref = band_pass([[row[x * ch] for x in range(w)] for row in rows], w, h)
        _reference.append([v if v is not None else 0.0 for row in ref for v in row])
    return _reference[0]


def register_scene(folder, scene, stops):
    """How far the scene sits from the HiRISE base map near the rover track. Returns a dict for the manifest."""
    stem = f"{scene}_07_briraj_mtr3"
    base = f"{PDS}browse/{folder}/{scene}/{stem}"
    label = fetch(base + ".lbl", None, stem + ".lbl", cache_dir=CACHE / "crism").decode("latin1")
    w, h, ch, rows = read_png(fetch(base + ".png", None, stem + ".png", cache_dir=CACHE / "crism"))
    res, west_edge, north_edge = crism_geometry(label, w, h, stem)
    ref = hirise_reference()

    # the scene's albedo picture on the registration grid (nearest pixel)
    cols = [math.floor((WEST + (x + 0.5) * (EAST - WEST) / REG_W - west_edge) * res) for x in range(REG_W)]
    img = [[None] * REG_W for _ in range(REG_H)]
    for y in range(REG_H):
        r = math.floor((north_edge - (NORTH - (y + 0.5) * (NORTH - SOUTH) / REG_H)) * res)
        if 0 <= r < h:
            row = rows[r]
            img[y] = [row[ch * c] if 0 <= c < w and row[ch * c + ch - 1] else None for c in cols]
    img = band_pass(img, REG_W, REG_H)

    # sample points: every third cell that has data and lies near the rover track
    cell_m = (NORTH - SOUTH) * M_PER_DEG / REG_H
    k = 16
    reach = int(REG_NEAR_TRACK_M / (cell_m * k)) + 1
    near = set()
    for st in stops:
        cx = int((st["lon"] - WEST) / (EAST - WEST) * REG_W) // k
        cy = int((NORTH - st["lat"]) / (NORTH - SOUTH) * REG_H) // k
        near.update((cx + i, cy + j) for i in range(-reach, reach + 1) for j in range(-reach, reach + 1) if i * i + j * j <= reach * reach)
    margin = REG_REACH + 22
    pts = [(x, y, img[y][x]) for y in range(margin, REG_H - margin, 3) for x in range(margin, REG_W - margin, 3)
           if img[y][x] is not None and (x // k, y // k) in near]
    if len(pts) < 800:
        return {"applied": False, "reason": f"only {len(pts)} usable points near the rover track"}
    dx, dy, peak, unshifted = best_shift(pts, ref, REG_REACH)
    mid = sorted(p[1] for p in pts)[len(pts) // 2]
    parts = []
    for name, part in (("northern half", [p for p in pts if p[1] < mid]), ("southern half", [p for p in pts if p[1] >= mid])):
        px, py, pr, _ = best_shift(part, ref, REG_REACH)
        parts.append({"part": name, "move_east_m": round(px * (EAST - WEST) / REG_W * M_PER_DEG),
                      "move_north_m": round(-py * cell_m), "r": round(pr, 2)})
    edge = max(abs(dx), abs(dy)) > REG_REACH - 1
    return {
        "applied": bool(APPLY_REGISTRATION and peak >= 0.4 and not edge),
        "move_east_deg": round(dx * (EAST - WEST) / REG_W, 7), "move_north_deg": round(-dy * (NORTH - SOUTH) / REG_H, 7),
        "move_east_m": round(dx * (EAST - WEST) / REG_W * M_PER_DEG), "move_north_m": round(-dy * cell_m),
        "r_at_best_shift": round(peak, 2), "r_with_label_bounds": round(unshifted, 2), "points": len(pts),
        "parts": parts,
        "method": f"Correlation of the scene's CRISM infrared albedo browse image ({stem.upper()}) with the NASA Mars Trek "
                  f"HiRISE mosaic (curiosity_hirise_mosaic), both band-passed on a {round(cell_m)} m grid, using ground within "
                  f"{REG_NEAR_TRACK_M} m of a rover stop. One shift for the whole scene; 'parts' shows how the best shift "
                  "differs between the two halves, which is the error left after the move.",
        "reference_url": HIRISE,
    }


def crism_layer(folder, scene, code, stops, registration):
    product = PRODUCTS[code]
    stem = f"{scene}_07_br{code}j_mtr3"
    base = f"{PDS}browse/{folder}/{scene}/{stem}"
    label = fetch(base + ".lbl", None, stem + ".lbl", cache_dir=CACHE / "crism").decode("latin1")
    w, h, ch, rows = read_png(fetch(base + ".png", None, stem + ".png", cache_dir=CACHE / "crism"))
    if ch != 4:
        raise RuntimeError(f"{stem}: expected RGBA, got {ch} channels")

    res, label_west, label_north = crism_geometry(label, w, h, stem)
    moved = registration.get("applied")
    dlat, dlon = (registration["move_north_deg"], registration["move_east_deg"]) if moved else (0.0, 0.0)
    west_edge, north_edge = label_west + dlon, label_north + dlat          # where the image is drawn

    # ---- no-data to transparent: alpha 0 in the source, or the ignore value 255 in all three bands
    alphas = set()
    for row in rows:
        alphas.update(row[3::4])
        for x in range(0, len(row), 4):
            if row[x + 3] == 0 or (row[x] == 255 and row[x + 1] == 255 and row[x + 2] == 255):
                row[x:x + 4] = b"\x00\x00\x00\x00"
    if not alphas <= {0, 255}:
        raise RuntimeError(f"{stem}: partial transparency in the source, not expected")

    # ---- crop to the map box on whole pixels, then trim empty margins
    c0 = max(0, math.floor((WEST - west_edge) * res + 1e-9))
    c1 = min(w, math.ceil((EAST - west_edge) * res - 1e-9))
    r0 = max(0, math.floor((north_edge - NORTH) * res + 1e-9))
    r1 = min(h, math.ceil((north_edge - SOUTH) * res - 1e-9))
    filled = [any(row[4 * c0 + 3:4 * c1:4]) for row in rows]
    while r0 < r1 and not filled[r0]:
        r0 += 1
    while r1 > r0 and not filled[r1 - 1]:
        r1 -= 1
    while c0 < c1 and not any(rows[r][4 * c0 + 3] for r in range(r0, r1)):
        c0 += 1
    while c1 > c0 and not any(rows[r][4 * c1 - 1] for r in range(r0, r1)):
        c1 -= 1
    if r1 <= r0 or c1 <= c0:
        raise RuntimeError(f"{stem}: nothing inside the map box")
    crop = [row[4 * c0:4 * c1] for row in rows[r0:r1]]
    cw, chh = c1 - c0, r1 - r0
    bounds = [[round(north_edge - r1 / res, 7), round(west_edge + c0 / res, 7)],
              [round(north_edge - r0 / res, 7), round(west_edge + c1 / res, 7)]]
    bounds_label = [[round(label_north - r1 / res, 7), round(label_west + c0 / res, 7)],
                    [round(label_north - r0 / res, 7), round(label_west + c1 / res, 7)]]
    valid = sum(1 for row in crop for a in row[3::4] if a)

    # ---- rover stops that fall on a valid pixel (with the image where the manifest puts it)
    on = []
    for st in stops:
        c, r = math.floor((st["lon"] - west_edge) * res), math.floor((north_edge - st["lat"]) * res)
        if c0 <= c < c1 and r0 <= r < r1 and rows[r][4 * c + 3]:
            on.append(st["id"])

    # ---- what the colours mean: band names from this file's own label, checked against the SIS list
    bands = tuple(label_tuple(label, "BAND_NAME"))
    offsets = [float(v) for v in label_tuple(label, "OFFSET")]
    factors = [float(v) for v in label_tuple(label, "SCALING_FACTOR")]
    verified = bands == product["bands"]
    channels = [{"channel": colour, "parameter": band,
                 "meaning": meaning if verified else "unverified",
                 "value_at_0": off, "value_at_254": round(off + 254 * fac, 6)}
                for colour, band, meaning, off, fac in zip(("red", "green", "blue"), bands, product["channels"], offsets, factors)]
    if verified:
        note = ("Verified. " + "; ".join(f"{c['channel']} = {c['parameter']}, {c['meaning']}" for c in channels) + ". "
                + product["reading"] + " Band names are from this file's PDS label (" + base + ".lbl); the wording is "
                "from the CRISM Data Product SIS v1.3.7.7, list of browse products (" + SIS_URL + "), which cites "
                "Viviano-Beck et al. 2014. " + CRISM_CAVEAT)
    else:
        note = (f"unverified: the label lists bands {bands}, not the expected {product['bands']}. " + CRISM_CAVEAT)

    name = f"crism_{scene}_{code}.png"
    size = save_png(name, cw, chh, 4, crop)
    sols = [st["sol"] for st in stops if st["id"] in set(on)]
    acquired = re.search(r"START_TIME\s*=\s*(\d{4}-\d\d-\d\d)", label).group(1)
    notes = (f"MRO CRISM scene {scene.upper()}, acquired {acquired}. Cropped to the map box from {w} x {h} to {cw} x {chh} "
             f"pixels; {valid / (cw * chh):.0%} of the cropped image has data, the rest is transparent. "
             + (f"{len(on)} of {len(stops)} rover stops fall on a valid pixel (sols {min(sols)} to {max(sols)}). " if on
                else "No rover stop falls on a valid pixel. ")
             + "bounds_label are the pixel outer edges worked out from the PDS label. ")
    if moved:
        spread = max(max(abs(p["move_east_m"] - registration["move_east_m"]), abs(p["move_north_m"] - registration["move_north_m"]))
                     for p in registration["parts"])
        notes += (f"With those bounds the scene sits off the HiRISE base map, so 'bounds' are moved "
                  f"{abs(registration['move_east_m'])} m {'east' if registration['move_east_m'] > 0 else 'west'} and "
                  f"{abs(registration['move_north_m'])} m {'north' if registration['move_north_m'] > 0 else 'south'} "
                  f"(measured, see 'registration'; correlation {registration['r_at_best_shift']} after the move, "
                  f"{registration['r_with_label_bounds']} before). The two halves of the scene differ from this single "
                  f"shift by up to about {spread} m, so expect that much error in places. The pixels are not resampled.")
    else:
        notes += ("'bounds' are the label's: no shift was applied (" + registration.get("reason", "registration off or not trusted")
                  + "). CRISM map projection can sit 150 m or more off the HiRISE base map.")
    return {
        "id": f"crism_{code}_{scene}", "title": f"{product['name']} (CRISM {code.upper()}, scene {scene.upper()})",
        "file": REL + name, "bounds": bounds, "kind": "rgb", "units": None, "value_min": None, "value_max": None,
        "legend": [{"label": label_, "rgb": list(rgb)} for label_, rgb in product["legend"]] if verified else [],
        "legend_note": note,
        "resolution_m": round(label_number(label, "MAP_SCALE") * 1000),
        "source": f"MRO CRISM map-projected targeted reduced data record (MTRDR) browse product {stem.upper()}, PDS Geosciences Node",
        "source_url": base + ".png",
        "credit": "NASA/JPL-Caltech/JHUAPL (MRO CRISM), PDS Geosciences Node",
        "notes": notes,
        "group": f"crism_{code}", "scene": scene, "acquired": acquired, "width": cw, "height": chh, "bytes": size,
        "legend_colours": "nominal colours named in the documentation, not sampled from this image",
        "channels": channels, "stops_on_valid_pixels": len(on),
        "bounds_label": bounds_label, "registration": registration, "_stops": on,
    }


# ---------------------------------------------------------------- THEMIS

# One-off check on 2026-11-14, not repeated by this script: the brightness of the day/night picture (daytime
# infrared, which looks like sunlit relief) matched shading computed from data/terrain best when moved about
# 200 m south (correlation 0.55 to 0.6, against 0.3 unmoved; the figure shifts by tens of metres with the sun
# direction assumed). The night mosaic and the thermal inertia could not be tested this way.
THEMIS_POSITION = ("Position: bounds are the requested box, not adjusted. A one-off check against the elevation grid "
                   "suggests the daytime infrared mosaic sits roughly 200 m (two of its own pixels) north of the HiRISE "
                   "base map; the night-time mosaic and the thermal inertia were not testable. Treat positions as good "
                   "to a few hundred metres.")


def jmars(layer, fmt, w, h, cache_name):
    return fetch(JMARS, {"SERVICE": "WMS", "REQUEST": "GetMap", "VERSION": "1.1.1", "FORMAT": fmt, "SRS": "EPSG:4326",
                         "LAYERS": layer, "STYLES": "", "WIDTH": w, "HEIGHT": h,
                         "BBOX": f"{WEST},{SOUTH},{EAST},{NORTH}"}, cache_name)     # fetch keeps / : , literal


def themis_picture():
    w, h, ch, rows = read_png(jmars("thm_dirnir_100m_v13_4", "image/png", 388, 800, "gale_thm_dirnir_388x800.png"))
    if ch == 4 and all(a == 255 for row in rows for a in row[3::4]):               # fully opaque: drop the alpha
        rows = [bytearray(v for x in range(0, len(row), 4) for v in row[x:x + 3]) for row in rows]
        ch = 3
    elif ch != 3:
        raise RuntimeError(f"night infrared picture: unexpected {ch} channels or transparency")
    size = save_png("themis_day_night_ir.png", w, h, ch, rows)
    return {
        "id": "themis_day_night_ir", "title": "Night-time warmth (THEMIS day infrared with colourised night infrared)",
        "file": REL + "themis_day_night_ir.png", "bounds": [[SOUTH, WEST], [NORTH, EAST]], "kind": "rgb",
        "units": None, "value_min": None, "value_max": None,
        "legend_note": "Brightness is the daytime infrared mosaic (landforms); colour is the night-time infrared mosaic "
                       "(relative night temperature), as the layer's title and abstract in the JMARS WMS capabilities say. "
                       "The colour ramp itself is not documented by the service. Ground that stays warm at "
                       "night is usually rock or cemented ground, ground that cools fast is usually loose sand or dust. "
                       "Relative temperatures only, no kelvin values.",
        "resolution_m": 100,
        "source": "ASU JMARS WMS, THEMIS Day IR with Colorized Night IR 100 m global mosaic v13.4 (thm_dirnir_100m_v13_4)",
        "source_url": JMARS,
        "credit": "NASA/JPL-Caltech/Arizona State University (Mars Odyssey THEMIS)",
        "notes": f"Requested at {w} x {h} pixels, about four times finer than the 100 m data, so the server's own "
                 "resampling does the smoothing. One real pixel is about the size of a football field. " + THEMIS_POSITION,
        "width": w, "height": h, "bytes": size,
    }


def thermal_inertia():
    # the same request and cache file as build_overlays.py, so the stipple layer and this raster agree
    w, h, ti = read_vicar_f32(jmars("thm_ti_100m_32bit", "image/vicar", 194, 400, "gale_thermal_inertia.vic"))
    good = [v for row in ti for v in row if v == v and v > 0]            # the service's null is -32768
    missing = w * h - len(good)
    lo, hi = math.floor(min(good) / 10) * 10, math.ceil(max(good) / 10) * 10
    step = (hi - lo) / 255
    if missing:                                                          # grey + alpha, transparent = no data
        rows = [bytearray(b for v in row for b in ((round((v - lo) / step), 255) if v == v and v > 0 else (0, 0))) for row in ti]
        ch = 2
    else:
        rows = [bytearray(round((v - lo) / step) for v in row) for row in ti]
        ch = 1
    worst = max(abs(lo + row[x * ch] * step - v) for row, src in zip(rows, ti) for x, v in enumerate(src) if v == v and v > 0)
    assert worst <= step / 2 + 1e-6, worst
    size = save_png("thermal_inertia.png", w, h, ch, rows)
    return {
        "id": "thermal_inertia", "title": "Thermal inertia (THEMIS)", "file": REL + "thermal_inertia.png",
        "bounds": [[SOUTH, WEST], [NORTH, EAST]], "kind": "gray8",
        "units": "TIU (J m^-2 K^-1 s^-1/2)", "value_min": lo, "value_max": hi,
        "legend_note": f"Pixel value p stands for {lo} + p * ({hi} - {lo}) / 255 TIU. Low thermal inertia means loose, fine "
                       "material such as sand or dust; high means rock or cemented ground. The app's loose-ground stipple "
                       "uses the same data with limits at 300 and 400 TIU.",
        "resolution_m": 100,
        "source": "ASU JMARS WMS, THEMIS Quantitative Thermal Inertia 100 m Global Mosaic, 32-bit (thm_ti_100m_32bit)",
        "source_url": JMARS,
        "credit": "NASA/JPL-Caltech/Arizona State University (Mars Odyssey THEMIS)",
        "notes": f"Data in the box run from {min(good):.0f} to {max(good):.0f} TIU. Quantised in steps of {step:.1f} TIU "
                 f"(largest rounding error {worst:.2f} TIU). {missing} of {w * h} cells have no data"
                 + (" and are transparent." if missing else ".") + f" Requested at {w} x {h} cells, about twice finer than "
                 "the 100 m data. " + ("Grey with alpha." if missing else "Plain 8-bit grey, no alpha.")
                 + " Read pixel values from a canvas with image smoothing off. " + THEMIS_POSITION,
        "width": w, "height": h, "bytes": size, "nodata_cells": missing,
    }


def night_colour_legend(picture, inertia):
    """What the colours of the day/night picture mean in practice: the service does not document its colour
    ramp, so the picture is compared with the thermal inertia raster cell by cell. Adds a legend and a note."""
    w, h, ch, rows = read_png((OUT / picture["file"][len(REL):]).read_bytes())
    tw, th, tch, trows = read_png((OUT / inertia["file"][len(REL):]).read_bytes())
    k = w // tw
    lo, step = inertia["value_min"], (inertia["value_max"] - inertia["value_min"]) / 255
    hues, values = [], []
    for y in range(th):
        for x in range(tw):
            if tch == 2 and not trows[y][x * tch + 1]:
                continue
            block = [colorsys.rgb_to_hsv(*(v / 255 for v in rows[k * y + j][ch * (k * x + i):ch * (k * x + i) + 3]))[0] * 360
                     for j in range(k) for i in range(k)]
            hues.append(sum(block) / len(block))
            values.append(lo + trows[y][x * tch] * step)
    n = len(hues)
    mh, mv = sum(hues) / n, sum(values) / n
    r = (sum((a - mh) * (b - mv) for a, b in zip(hues, values))
         / math.sqrt(sum((a - mh) ** 2 for a in hues) * sum((b - mv) ** 2 for b in values)))
    legend = []
    for name, rgb, h0, h1, ground in (("Red", (230, 50, 30), 0, 30, "warmest at night: rock or cemented ground"),
                                       ("Orange to yellow", (240, 190, 40), 30, 75, "warm"),
                                       ("Green", (60, 200, 60), 75, 150, "cool: looser ground"),
                                       ("Cyan to blue", (40, 110, 230), 150, 270, "coldest at night: loose sand or dust")):
        inside = [v for hue, v in zip(hues, values) if h0 <= hue < h1]
        if len(inside) >= 20:
            legend.append({"label": f"{name}: {ground} (mean {sum(inside) / len(inside):.0f} TIU here)", "rgb": list(rgb)})
    if r < -0.5:
        picture["legend"] = legend
        picture["legend_note"] += (f" Checked here against the thermal inertia layer: hue runs from red (high thermal inertia, warm "
                                   f"at night) through yellow and green to blue (low, cold at night); correlation of hue angle "
                                   f"with thermal inertia over the box is {r:.2f}. Legend colours are nominal, not sampled.")
    else:
        picture["legend_note"] += f" Colour meaning unverified: hue does not track thermal inertia here (correlation {r:.2f})."
    return r


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    stops = json.loads((ROOT / "data" / "site.json").read_text())["stops"]
    shifts = {scene: register_scene(folder, scene, stops) for folder, scene in SCENES}
    for scene, reg in shifts.items():
        print(f"registration {scene}: " + json.dumps({k: v for k, v in reg.items() if k not in ("method", "reference_url")}))
    layers = [crism_layer(folder, scene, code, stops, shifts[scene]) for code in PRODUCTS for folder, scene in SCENES]
    covered = set()
    for layer in layers:
        covered.update(layer.pop("_stops"))
    layers.append(themis_picture())
    layers.append(thermal_inertia())
    hue_r = night_colour_legend(layers[-2], layers[-1])
    (OUT / "rasters.json").write_text(json.dumps(layers, indent=1) + "\n", encoding="utf-8")
    for layer in layers:
        flag = "  OVER the size target" if layer["bytes"] > MAX_FILE_BYTES else ""
        print(f"{layer['file']}  {layer['width']} x {layer['height']}  {layer['bytes']} bytes  bounds {layer['bounds']}{flag}")
        if layer["kind"] == "rgb" and "channels" in layer:
            print("   " + ", ".join(f"{c['channel']}={c['parameter']}" for c in layer["channels"])
                  + ("  verified" if not layer["legend_note"].startswith("unverified") else "  UNVERIFIED")
                  + f"  stops on valid pixels: {layer['stops_on_valid_pixels']}")
    print(f"night infrared colours against thermal inertia: correlation of hue with TIU {hue_r:.2f}")
    print(f"rover stops on a valid pixel of at least one CRISM scene: {len(covered)} of {len(stops)}")
    print(f"rasters.json: {len(layers)} layers, {(OUT / 'rasters.json').stat().st_size} bytes")


if __name__ == "__main__":
    main()
