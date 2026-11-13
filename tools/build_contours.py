#!/usr/bin/env python3
"""Draw relief lines (contours) along Curiosity's track from the 1 m HiRISE elevation model.

Source: NASA Mars Trek image service "Gale_DEM_SMG_1m", sampled at about 6 m per pixel.
Lines are traced every 5 m of height inside a corridor around the track, smoothed, simplified
and written to data/overlays/contours.json as delta-encoded integer coordinates.

The lines show the shape of the ground. Heights in this model sit a few metres off the rover's own
elevations (up to about 20 m on Mount Sharp), so the lines are not labelled with absolute heights.

Run after build_data.py:  python3 tools/build_contours.py      (Python standard library only)
"""
import json
import math
from pathlib import Path

from build_overlays import EAST, HEIGHT, NORTH, SOUTH, TREK, WEST, WIDTH, get, read_tiff_f32

ROOT = Path(__file__).resolve().parent.parent
INTERVAL_M = 5
INDEX_EVERY_M = 25
CORRIDOR_M = 450          # how far either side of the track the lines are drawn
SIMPLIFY_M = 2.5
MIN_LENGTH_M = 60         # drop specks
SCALE = 1e5               # coordinates are stored as round(degrees * SCALE), about 0.6 m
M_PER_DEG = 59274.7


def corridor_mask(route, w, h):
    """Coarse grid (8 x 8 pixels per cell) of which cells lie within CORRIDOR_M of the track."""
    cw, ch = w // 8 + 1, h // 8 + 1
    reach = int(CORRIDOR_M / (M_PER_DEG * (EAST - WEST) / w * 8)) + 1
    mask = [bytearray(cw) for _ in range(ch)]
    seen = set()
    for lon, lat, _, _ in route:
        cx = int((lon - WEST) / (EAST - WEST) * w) // 8
        cy = int((NORTH - lat) / (NORTH - SOUTH) * h) // 8
        if (cx, cy) in seen:
            continue
        seen.add((cx, cy))
        for y in range(max(0, cy - reach), min(ch, cy + reach + 1)):
            row = mask[y]
            for x in range(max(0, cx - reach), min(cw, cx + reach + 1)):
                if (x - cx) ** 2 + (y - cy) ** 2 <= reach * reach:
                    row[x] = 1
    return mask


def smooth(grid, w, h, mask):
    """3 x 3 mean inside the corridor, to take the pixel noise out of the lines."""
    out = [list(row) for row in grid]
    for y in range(1, h - 1):
        m = mask[y // 8]
        a, b, c, o = grid[y - 1], grid[y], grid[y + 1], out[y]
        for x in range(1, w - 1):
            if m[x // 8]:
                o[x] = (a[x - 1] + a[x] + a[x + 1] + b[x - 1] + b[x] + b[x + 1] + c[x - 1] + c[x] + c[x + 1]) / 9
    return out


def trace(grid, w, h, mask):
    """Marching squares. Returns {level: [((x1, y1), (x2, y2)), ...]} in pixel coordinates."""
    segs = {}
    for y in range(h - 1):
        m = mask[y // 8]
        top, bot = grid[y], grid[y + 1]
        for x in range(w - 1):
            if not m[x // 8]:
                continue
            a, b, c, d = top[x], top[x + 1], bot[x + 1], bot[x]      # clockwise from top-left
            lo, hi = min(a, b, c, d), max(a, b, c, d)
            if lo < -1e6 or hi - lo < 1e-9:                           # no data, or flat
                continue
            level = math.ceil(lo / INTERVAL_M) * INTERVAL_M
            while level < hi:
                pts = []
                for (v1, v2, p1, p2) in ((a, b, (x, y), (x + 1, y)), (b, c, (x + 1, y), (x + 1, y + 1)),
                                         (c, d, (x + 1, y + 1), (x, y + 1)), (d, a, (x, y + 1), (x, y))):
                    if (v1 < level) != (v2 < level):
                        t = (level - v1) / (v2 - v1)
                        pts.append((round(p1[0] + (p2[0] - p1[0]) * t, 3), round(p1[1] + (p2[1] - p1[1]) * t, 3)))
                if len(pts) == 2:
                    segs.setdefault(level, []).append((pts[0], pts[1]))
                elif len(pts) == 4:                                    # saddle: pair neighbours
                    segs.setdefault(level, []).append((pts[0], pts[1]))
                    segs.setdefault(level, []).append((pts[2], pts[3]))
                level += INTERVAL_M
    return segs


def stitch(segments):
    """Join loose segments end to end into polylines."""
    ends = {}
    for i, (p, q) in enumerate(segments):
        ends.setdefault(p, []).append(i)
        ends.setdefault(q, []).append(i)
    used = [False] * len(segments)
    lines = []
    for i, (p, q) in enumerate(segments):
        if used[i]:
            continue
        used[i] = True
        line = [p, q]
        for at_end in (True, False):
            while True:
                tip = line[-1] if at_end else line[0]
                nxt = next((j for j in ends[tip] if not used[j]), None)
                if nxt is None:
                    break
                used[nxt] = True
                a, b = segments[nxt]
                other = b if a == tip else a
                if at_end:
                    line.append(other)
                else:
                    line.insert(0, other)
        lines.append(line)
    return lines


def simplify(points, tol):
    """Douglas-Peucker, iterative. A closed ring is split at its far side and done as two halves."""
    if len(points) < 3:
        return points
    if points[0] == points[-1]:
        far = max(range(len(points)), key=lambda k: math.hypot(points[k][0] - points[0][0], points[k][1] - points[0][1]))
        return simplify(points[:far + 1], tol)[:-1] + simplify(points[far:], tol)
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        i, j = stack.pop()
        (x1, y1), (x2, y2) = points[i], points[j]
        dx, dy = x2 - x1, y2 - y1
        norm = math.hypot(dx, dy) or 1e-12
        worst, at = 0.0, None
        for k in range(i + 1, j):
            d = abs(dy * (points[k][0] - x1) - dx * (points[k][1] - y1)) / norm
            if d > worst:
                worst, at = d, k
        if at is not None and worst > tol:
            keep[at] = True
            stack += [(i, at), (at, j)]
    return [p for p, k in zip(points, keep) if k]


def main():
    route = json.loads((ROOT / "data" / "site.json").read_text())["route"]
    w, h, dem = read_tiff_f32(get(TREK, {
        "bbox": f"{WEST},{SOUTH},{EAST},{NORTH}", "bboxSR": 104905, "size": f"{WIDTH},{HEIGHT}",
        "f": "image", "format": "tiff", "pixelType": "F32", "interpolation": "RSP_BilinearInterpolation"}, "gale_dem_f32.tif"))
    mask = corridor_mask(route, w, h)
    dem = smooth(dem, w, h, mask)
    px_m = M_PER_DEG * (EAST - WEST) / w * math.cos(math.radians((NORTH + SOUTH) / 2))   # metres per pixel, east-west
    py_m = M_PER_DEG * (NORTH - SOUTH) / h

    out, total_pts, total_m = [], 0, 0.0
    for level, segments in sorted(trace(dem, w, h, mask).items()):
        for line in stitch(segments):
            metres = [(x * px_m, y * py_m) for x, y in line]
            length = sum(math.hypot(metres[i + 1][0] - metres[i][0], metres[i + 1][1] - metres[i][1]) for i in range(len(metres) - 1))
            if length < MIN_LENGTH_M:
                continue
            kept = simplify(metres, SIMPLIFY_M)
            # back to degrees, as integers, each point stored as the step from the one before
            ints = [(round((WEST + (mx / px_m) / w * (EAST - WEST)) * SCALE), round((NORTH - (my / py_m) / h * (NORTH - SOUTH)) * SCALE)) for mx, my in kept]
            flat, prev = [], (0, 0)
            for p in ints:
                flat += [p[0] - prev[0], p[1] - prev[1]]
                prev = p
            out.append([int(level), flat])
            total_pts += len(ints)
            total_m += length

    meta = {
        "interval_m": INTERVAL_M, "index_every_m": INDEX_EVERY_M, "corridor_m": CORRIDOR_M, "scale": SCALE,
        "source": "NASA Mars Trek, Gale_DEM_SMG_1m (MRO HiRISE 1 m elevation model), sampled at about 6 m per pixel",
        "note": "Lines show the shape of the ground. Model heights differ from the rover's by a few metres, so lines carry no height labels.",
        "lines": out,
    }
    path = ROOT / "data" / "overlays" / "contours.json"
    path.write_text(json.dumps(meta, separators=(",", ":")), encoding="utf-8")
    print(f"lines: {len(out)}  points: {total_pts}  length: {total_m / 1000:.0f} km  file: {path.stat().st_size / 1024:.0f} KB")
    levels = sorted({l for l, _ in out})
    print(f"levels: {levels[0]} to {levels[-1]} m every {INTERVAL_M} m")


if __name__ == "__main__":
    main()
