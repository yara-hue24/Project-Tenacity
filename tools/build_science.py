#!/usr/bin/env python3
"""Bake published Curiosity science data into compact JSON layers for the browser.

Writes five files under data/layers/:

  dan.json           subsurface water-equivalent hydrogen and chlorine along the track (DAN, Zenodo 6974535)
  apxs.json          APXS oxide chemistry of contact-science spots, grouped by rover stop (PDS Geosciences)
  chemcam.json       names and types of ChemCam laser targets, grouped by rover stop (PDS Geosciences)
  spaceweather.json  snapshot of NASA DONKI WSA-Enlil simulations that predict an impact at Mars
  science.json       manifest describing the four layers above

Every download is cached under tools/.cache/science/ (git-ignored), so a second run needs no network.
Values are copied from the sources. Nothing is interpolated or estimated; a missing value is stored as null.
The only arithmetic is the averaging of neighbouring DAN pixels into 5 m track bins, described in dan.json.

Run after build_data.py:   python3 tools/build_science.py
Options:                   --apxs-budget-min N   stop fetching APXS products after N minutes (default 15)
                           --refresh-spaceweather   ask DONKI again instead of using the cached answer
                           --only dan,apxs,chemcam,spaceweather   rebuild a subset (the manifest is always rewritten)
Only the Python standard library is used.
"""
import argparse
import csv
import datetime
import http.client
import io
import json
import math
import re
import sys
import time
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "science"
OUT = ROOT / "data" / "layers"
UA = "data-snapshot/1.0 (python-urllib)"          # generic on purpose: no personal or project name
MAX_BYTES = 40 * 1024 * 1024                        # refuse any single download larger than this

DAN_RECORD = "https://zenodo.org/api/records/6974535"
DAN_CSV = DAN_RECORD + "/files/DAN_Pixelization_Table_sol_3333.csv/content"
DAN_README = DAN_RECORD + "/files/readme.txt/content"
DAN_SIS = "https://pds-geosciences.wustl.edu/msl/msl-m-dan-3_4-rdr-v1/msldan_1xxx/document/dan_rdr_sis.htm"
DAN_BIN_M = 5.0

PDS_HOST = "pds-geosciences.wustl.edu"
APXS_BASE = "/msl/msl-m-apxs-4_5-rdr-v1/mslapx_1xxx/"
APXS_URL = "https://" + PDS_HOST + APXS_BASE
APXS_MAIN = ["SiO2", "FeO", "SO3", "Cl", "MgO", "CaO", "Al2O3", "Na2O", "K2O"]
APXS_FULL_FROM_SOL = 3000

CCAM_URL = "https://" + PDS_HOST + "/msl/msl-m-chemcam-libs-4_5-rdr-v1/mslccm_1xxx/document/msl_ccam_obs.csv"
CCAM_CAP = 12

DONKI_URL = "https://api.nasa.gov/DONKI/WSAEnlilSimulations"
DONKI_DAYS = 60


# ----------------------------------------------------------------------------- downloads

def _store(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".part")
    tmp.write_bytes(data)
    tmp.replace(path)


def fetch(url, rel, pause=0.5, timeout=180, force=False):
    """Return the bytes of url, from the cache when present (unless force). One request, then a short pause."""
    path = CACHE / rel
    if path.exists() and not force:
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    chunks, size = [], 0
    with urllib.request.urlopen(req, timeout=timeout) as r:
        while True:
            block = r.read(1 << 16)
            if not block:
                break
            size += len(block)
            if size > MAX_BYTES:
                raise RuntimeError(f"{url}: larger than {MAX_BYTES} bytes, download stopped")
            chunks.append(block)
    data = b"".join(chunks)
    _store(path, data)
    time.sleep(pause)
    return data


class PoliteHost:
    """Sequential GETs over one kept-alive HTTPS connection, with a pause after every request.

    Used for the ~1,800 tiny APXS files so the server sees one connection and a steady slow trickle.
    A 404 is remembered in a small marker file so that a re-run stays offline.
    """

    def __init__(self, host, pause=0.2):
        self.host, self.pause, self.conn, self.requests = host, pause, None, 0

    def _get(self, path):
        if self.conn is None:
            self.conn = http.client.HTTPSConnection(self.host, timeout=60)
        self.conn.request("GET", path, headers={"User-Agent": UA, "Accept": "*/*", "Connection": "keep-alive"})
        r = self.conn.getresponse()
        data = r.read(MAX_BYTES + 1)
        if len(data) > MAX_BYTES:
            raise RuntimeError(f"{path}: larger than {MAX_BYTES} bytes")
        return r.status, data

    def cached(self, rel):
        path = CACHE / rel
        if path.exists():
            return path.read_bytes()
        if path.with_name(path.name + ".missing").exists():
            return None
        return False                                   # not tried yet

    def get(self, paths, rel):
        """Bytes of the first of https://host/<paths> that exists; None when the server says 404 for all."""
        hit = self.cached(rel)
        if hit is not False:
            return hit
        for path in ([paths] if isinstance(paths, str) else paths):
            for attempt in (1, 2, 3):
                try:
                    status, data = self._get(path)
                    break
                except (OSError, http.client.HTTPException):
                    self.close()
                    if attempt == 3:
                        raise
                    time.sleep(2.0 * attempt)
            self.requests += 1
            time.sleep(self.pause)
            if status == 200:
                _store(CACHE / rel, data)
                return data
            if status != 404:
                raise RuntimeError(f"https://{self.host}{path}: HTTP {status}")
        _store((CACHE / rel).with_name((CACHE / rel).name + ".missing"), b"")
        return None

    def close(self):
        if self.conn is not None:
            try:
                self.conn.close()
            except OSError:
                pass
            self.conn = None


# ----------------------------------------------------------------------------- rover track helpers

class Track:
    """The rover route from data/site.json, with a grid index for nearest-vertex lookups."""

    CELL = 20.0   # metres

    def __init__(self, site):
        self.route = site["route"]                                   # [lon, lat, elev, chain_m]
        radius = site["meta"]["mars_radius_m"]
        lat0 = sum(p[1] for p in self.route) / len(self.route)
        self.ky = radius * math.pi / 180.0
        self.kx = self.ky * math.cos(math.radians(lat0))
        self.xy = [(p[0] * self.kx, p[1] * self.ky) for p in self.route]
        self.grid = defaultdict(list)
        for i, (x, y) in enumerate(self.xy):
            self.grid[(int(x // self.CELL), int(y // self.CELL))].append(i)

    def nearest(self, lon, lat):
        """(distance in metres, index) of the route vertex nearest to lon/lat. Exact, not approximate."""
        x, y = lon * self.kx, lat * self.ky
        cx, cy = int(x // self.CELL), int(y // self.CELL)
        best_d2, best_i, ring = None, None, 0
        while ring < 5000:
            for gx in range(cx - ring, cx + ring + 1):
                for gy in range(cy - ring, cy + ring + 1):
                    if max(abs(gx - cx), abs(gy - cy)) != ring:
                        continue
                    for i in self.grid.get((gx, gy), ()):
                        px, py = self.xy[i]
                        d2 = (px - x) ** 2 + (py - y) ** 2
                        if best_d2 is None or d2 < best_d2:
                            best_d2, best_i = d2, i
            # every vertex outside the rings searched so far is more than ring * CELL away
            if best_d2 is not None and best_d2 <= (ring * self.CELL) ** 2:
                break
            ring += 1
        return math.sqrt(best_d2), best_i


def text_lines(text):
    """Split on newlines only (str.splitlines would also split on stray Latin-1 control bytes)."""
    return [line.rstrip("\r") for line in text.split("\n")]


def load_site():
    return json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))


def write_json(name, obj):
    OUT.mkdir(parents=True, exist_ok=True)
    path = OUT / name
    path.write_text(json.dumps(obj, separators=(",", ":")), encoding="utf-8")
    return path.stat().st_size


def percentile(values, q):
    values = sorted(values)
    return values[min(len(values) - 1, int(q * len(values)))]


# ----------------------------------------------------------------------------- 1. DAN water and chlorine

def plus_minus(cell):
    """'2.9±0.3' -> (2.9, 0.3); '' -> (None, None)."""
    cell = cell.strip()
    if not cell:
        return None, None
    value, _, err = cell.partition("±")
    return float(value), (float(err) if err.strip() else None)


def mean(values):
    return sum(values) / len(values)


def build_dan(site, track):
    record = json.loads(fetch(DAN_RECORD, "dan/record_6974535.json"))
    readme = fetch(DAN_README, "dan/readme.txt").decode("latin-1")
    lines = fetch(DAN_CSV, "dan/DAN_Pixelization_Table_sol_3333.csv").decode("latin-1")
    lines = text_lines(lines)
    header = lines[0].split(";")
    assert [h.split(" (")[0] for h in header] == ["Pixel ID", "Pixel Type", "Longitude", "Latitude",
                                                  "Associated Member of the Stratigraphic Column",
                                                  "WEH values", "AEC values"], header

    members, pixels, snaps = [], [], []
    for n, line in enumerate(lines[1:], start=2):
        if not line.strip():
            continue
        cells = line.split(";")
        if len(cells) != 7:
            raise RuntimeError(f"DAN table line {n}: expected 7 fields, got {len(cells)}")
        _, kind, lon, lat, member, weh, aec = cells
        lon, lat, member = float(lon), float(lat), member.strip()
        if member not in members:
            members.append(member)
        water, water_err = plus_minus(weh)
        cl, cl_err = plus_minus(aec)
        dist, vertex = track.nearest(lon, lat)
        snaps.append(dist)
        pixels.append({"line": n, "kind": kind.strip(), "lon": lon, "lat": lat, "member": members.index(member),
                       "water": water, "water_err": water_err, "cl": cl, "cl_err": cl_err,
                       "chain": track.route[vertex][3], "snap": dist})

    # Thin: all pixels whose nearest route vertex lies in the same 5 m stretch of track become one point.
    bins = defaultdict(list)
    for p in pixels:
        bins[int(p["chain"] // DAN_BIN_M)].append(p)

    def avg(group, key, digits):
        values = [p[key] for p in group if p[key] is not None]
        return round(mean(values), digits) if values else None

    points, trace = [], []
    for key in sorted(bins):
        group = bins[key]
        member = Counter(p["member"] for p in group).most_common(1)[0][0]
        points.append([
            round(mean([p["lat"] for p in group]), 5),
            round(mean([p["lon"] for p in group]), 5),
            avg(group, "water", 2), avg(group, "water_err", 2),
            avg(group, "cl", 2), avg(group, "cl_err", 2),
            member,
            round(mean([p["chain"] for p in group]), 1),
            len(group),
            sum(1 for p in group if p["kind"] == "PAD"),
        ])
        trace.append([p["line"] for p in group])

    meta = record["metadata"]
    authors = ", ".join(c["name"] for c in meta["creators"])
    year = meta["publication_date"][:4]
    waters = [p["water"] for p in pixels if p["water"] is not None]
    last_chain = max(p["chain"] for p in pixels)
    out = {
        "fields": ["lat", "lon", "water_wt_pct", "water_err", "cl_wt_pct", "cl_err", "member_index", "chain_m",
                   "n_pixels", "n_active"],
        "members": members,
        "points": points,
        "source": "Zenodo record 6974535, file DAN_Pixelization_Table_sol_3333.csv (DAN instrument team)",
        "source_url": DAN_CSV,
        "record_url": "https://doi.org/" + record["doi"],
        "licence": meta["license"]["id"],
        "citation": f"{authors} ({year}). {meta['title']} [Data set]. Zenodo. https://doi.org/{record['doi']}",
        "coverage_note": (
            "Landing to sol 3333 only (the table has no sol column; the limit is from the record's readme). "
            f"The last pixel is at latitude {min(p['lat'] for p in pixels):.5f}, {last_chain:.0f} m along a "
            f"{track.route[-1][3]:.0f} m track, so everything after that has no DAN value here. "
            "Chlorine exists only where the rover made an active (neutron-pulse) measurement."),
        "notes": (
            "water_wt_pct is Water Equivalent Hydrogen (WEH) in weight percent: the amount of water that would "
            "hold the hydrogen DAN senses, whatever form the hydrogen is really in (the record says 'water ... "
            "content in shallow Martian subsurface'). cl_wt_pct is Absorption Equivalent Chlorine (AEC) in weight "
            "percent: the chlorine that would absorb as many thermal neutrons as the ground does. The errors are "
            "the statistical errors given per pixel. The source has two pixel types on a 0.00005 degree (about "
            "3 m) grid: PAD, from active measurements with the pulsed 14 MeV neutron generator (method: Lisov et "
            "al. 2018, Astronomy Letters 44, 482, doi:10.1134/S1063773718070034), which carry both WEH and AEC; "
            "and PPD, from passive neutron-background counts while roving, converted to WEH by the 'Method of "
            "Referencing by Active Data' (Nikiforov et al. 2020, Icarus 346, 113818, "
            "doi:10.1016/j.icarus.2020.113818), which carry WEH only. Neither the readme nor the record states a "
            "sensing depth or a layering model for these numbers; each is a single bulk value per pixel. For "
            "depth, the PDS DAN data product specification (depth_reference_url, section 2.1) describes the "
            "instrument as sensing hydrogen-bearing material 'in a shallow layer (~1 m) of Mars' subsurface' and "
            "lists 'the upper <0.5 m' as the layer whose structure it investigates. That is a statement about "
            "the instrument, not a property recorded in this table."),
        "depth_reference_url": DAN_SIS,
        "thinning_note": (
            f"Each source pixel was snapped to the nearest vertex of the route in data/site.json to get chain_m. "
            f"Pixels whose vertex falls in the same {DAN_BIN_M:g} m stretch of track were averaged into one point: "
            "lat, lon, chain_m, water and its error are plain means over the n_pixels pixels (active and passive "
            "together); cl and its error are means over the n_active active pixels, null where there is none; the "
            "member is the most common one. water_err is the mean of the source errors, not an error of the mean. "
            "Where n_pixels is 1 the values are the source values unchanged."),
        "source_readme": readme.replace("\r\n", "\n").strip(),
        "pixels_in_source": len(pixels),
        "pixels_active": sum(1 for p in pixels if p["kind"] == "PAD"),
        "pixels_passive": sum(1 for p in pixels if p["kind"] == "PPD"),
        "bin_m": DAN_BIN_M,
        "max_snap_m": round(max(snaps), 1),
        "median_snap_m": round(percentile(snaps, 0.5), 1),
        "p95_snap_m": round(percentile(snaps, 0.95), 1),
        "chain_range_m": [min(p["chain"] for p in pixels), last_chain],
        "water_range_source": [min(waters), max(waters)],
    }
    size = write_json("dan.json", out)
    print(f"dan.json: {len(points)} points from {len(pixels)} pixels "
          f"({out['pixels_passive']} passive, {out['pixels_active']} active), {size} bytes")
    print(f"  snap to nearest route vertex: median {out['median_snap_m']} m, 95% {out['p95_snap_m']} m, "
          f"max {out['max_snap_m']} m; chain {out['chain_range_m'][0]:.0f} to {last_chain:.0f} m")
    return out, {"lines": lines, "trace": trace}


# ----------------------------------------------------------------------------- 2. APXS chemistry

APXS_NAME = re.compile(r"(ap([ab])_(\d{9})rwp(\d{4})(\d{3})(\d{4})_+p(\d))", re.I)
APXS_ACT = re.compile(r"^\s*AP([AB])_(\d{9})ESC\w*\.DAT\s*,(.*)$", re.I)


def even_order(n):
    """Indices 0..n-1 ordered so that any prefix is spread evenly (stride 64, 32, ... 1)."""
    seen, order, stride = set(), [], 64
    while stride >= 1:
        for i in range(0, n, stride):
            if i not in seen:
                seen.add(i)
                order.append(i)
        stride //= 2
    return order


def parse_rwp(text):
    """An APXS oxide table -> ({name: value}, analysis label). Unreadable values become None."""
    rows = [r for r in text_lines(text) if r.strip()]
    label = [c.strip().strip('"') for c in rows[0].split(",")]
    values = {}
    for row in rows[1:]:
        cells = [c.strip().strip('"') for c in row.split(",")]
        if len(cells) < 2 or not cells[0]:
            continue
        try:
            values[cells[0]] = float(cells[1])
        except ValueError:
            values[cells[0]] = None
    return values, (label[1] if len(label) > 1 else "")


def build_apxs(site, budget_min):
    stops = {s["id"] for s in site["stops"]}
    host = PoliteHost(PDS_HOST)

    inventory = fetch(APXS_URL + "data/collection_data_inventory.csv", "apxs/collection_data_inventory.csv").decode("latin-1")
    products = {}
    for m in APXS_NAME.finditer(inventory):
        name, unit, clock, sol, site_n, drive, _ = m.groups()
        products[name.lower()] = (int(sol), int(clock), unit.lower(), int(site_n), int(drive))
    products = sorted(products.items(), key=lambda kv: (kv[1][0], kv[1][1]))

    # Target names: the "activities" tables map each raw measurement file (unit + spacecraft clock) to a target.
    listing = fetch(APXS_URL + "extras/", "apxs/extras_index.html").decode("latin-1")
    activity_files = sorted(set(re.findall(r"msl_apxs_activities_sol\d{4}_\d{4}\.csv", listing, flags=re.I)))
    targets, target_line = {}, {}
    for name in activity_files:
        text = host.get(APXS_BASE + "extras/" + name, "apxs/extras/" + name).decode("latin-1")
        for row in text_lines(text):
            m = APXS_ACT.match(row)
            if m:
                key = (m.group(1).lower(), int(m.group(2)))
                targets[key] = m.group(3).strip().strip('"').strip()
                target_line[key] = f"{name}: {row.strip()}"

    # Fetch order: everything from sol 3000 on, then earlier products in an evenly spread order, so that if
    # the time budget runs out the earlier part is an even sample rather than a truncated one.
    late = [p for p in products if p[1][0] >= APXS_FULL_FROM_SOL]
    early = [p for p in products if p[1][0] < APXS_FULL_FROM_SOL]
    queue = late + [early[i] for i in even_order(len(early))]
    deadline = time.monotonic() + budget_min * 60.0
    texts, not_fetched, missing = {}, [], []
    for name, (sol, clock, unit, site_n, drive) in queue:
        rel = f"apxs/data/{name}.csv"
        hit = host.cached(rel)
        if hit is False:
            if time.monotonic() > deadline:
                not_fetched.append(name)
                continue
            # A measurement that ran past midnight can be filed under the sol folder before its own.
            hit = host.get([f"{APXS_BASE}data/sol{n:05d}/{name}.csv" for n in (sol, sol - 1, sol + 1)], rel)
            if host.requests % 200 == 0:
                print(f"  apxs: {host.requests} requests so far", flush=True)
        if hit is None:
            missing.append(name)
        else:
            texts[name] = hit.decode("latin-1")
    host.close()

    by_stop, raw = {}, {}
    extra_keys, labels = Counter(), Counter()
    skipped_no_stop, skipped_cal, skipped_empty, no_target = [], [], [], 0
    for name, (sol, clock, unit, site_n, drive) in products:
        if name not in texts:
            continue
        values, label = parse_rwp(texts[name])
        target = targets.get((unit, clock))
        stop = f"{site_n}_{drive}"
        if target and re.search(r"calibration\s+target|cal\s*target", target, re.I):
            skipped_cal.append(name)                    # the rover's own reference slab, not the ground
            continue
        if not any(v is not None for v in values.values()):
            skipped_empty.append(name)
            continue
        if stop not in stops:
            skipped_no_stop.append(name)
            continue
        if target is None:
            no_target += 1
        labels[label] += 1
        spot = {"sol": sol, "target": target}
        for key in APXS_MAIN:
            spot[key] = values.get(key)
        for key, value in values.items():
            if key not in spot:
                spot[key] = value
                extra_keys[key] += 1
        by_stop.setdefault(stop, []).append(spot)
        raw[(stop, len(by_stop[stop]) - 1)] = (name, target_line.get((unit, clock)))

    spots = sum(len(v) for v in by_stop.values())
    sols = [s["sol"] for v in by_stop.values() for s in v]
    listed_sols = [p[1][0] for p in products]
    complete = not not_fetched
    out = {
        "source": "NASA PDS Geosciences Node, MSL APXS calibrated oxide-abundance products (RDR, '*rwp*' tables)",
        "source_url": APXS_URL,
        "licence": "NASA Planetary Data System, public domain. Credit: NASA/JPL-Caltech/University of Guelph (APXS team)",
        "units": "weight percent, as written in each product (Ni, Zn and Br are also in weight percent, not ppm)",
        "oxides": APXS_MAIN + [k for k, _ in extra_keys.most_common()],
        "notes": (
            "One entry per APXS measurement (one oxide table). The same target can appear several times: "
            "before and after brushing (DRT), offsets, rasters, drill tailings and dump piles. Values are the "
            "product's abundance column; the product's statistical-uncertainty column is not carried. The archive "
            "warns that short, warm or distant measurements have poorer minor and trace elements. Target names "
            "are the science team's informal names, spelled as in the archive's activity tables. Any oxide table "
            "whose target is the rover's own APXS calibration target is left out "
            f"({len(skipped_cal)} found in this build)."),
        "join_note": (
            "Each product name carries the sol, site and drive of the rover when the measurement was made "
            "(ap?_<clock>rwp<sol 4><site 3><drive 4>). site_drive is the stop id in data/site.json, so the join is "
            "exact; the spot itself is within arm's reach (about 2 m) of that rover position. The target name is "
            "joined through the unit letter and spacecraft clock of the raw file listed in "
            "extras/msl_apxs_activities_sol*.csv."),
        "coverage_note": (
            f"Sols {min(sols)} to {max(sols)} (archive lists sols {min(listed_sols)} to {max(listed_sols)}). "
            + ("All listed oxide tables were read. " if complete else
               f"SAMPLED: every product from sol {APXS_FULL_FROM_SOL} on, plus an even sample of earlier ones; "
               f"{len(not_fetched)} earlier products were not fetched within the {budget_min:g} minute budget. ")
            + f"{len(skipped_no_stop)} measurement(s) made at a site/drive that is not a stop in site.json are left out."),
        "complete": complete,
        "products_listed": len(products),
        "products_read": len(texts),
        "products_not_fetched": len(not_fetched),
        "products_missing_on_server": len(missing),
        "skipped_not_a_stop": len(skipped_no_stop),
        "skipped_calibration_target": len(skipped_cal),
        "skipped_no_values": len(skipped_empty),
        "spots": spots,
        "spots_without_target_name": no_target,
        "sol_range": [min(sols), max(sols)],
        "stops": by_stop,
    }
    size = write_json("apxs.json", out)
    print(f"apxs.json: {spots} spots at {len(by_stop)} stops, sols {min(sols)}-{max(sols)}, {size} bytes")
    print(f"  products listed {len(products)}, read {len(texts)}, not fetched {len(not_fetched)}, "
          f"404 {len(missing)}; new requests this run {host.requests}")
    print(f"  skipped: {len(skipped_no_stop)} not at a stop, {len(skipped_cal)} calibration target, "
          f"{len(skipped_empty)} without values; {no_target} kept spots have no target name")
    print(f"  analysis labels: {dict(labels)}")
    if skipped_no_stop:
        print("  not at a stop (first 8):", ", ".join(skipped_no_stop[:8]))
    return out, {"raw": raw, "texts": texts}


# ----------------------------------------------------------------------------- 3. ChemCam targets

def build_chemcam(site):
    stops = {s["id"] for s in site["stops"]}
    data = fetch(CCAM_URL, "chemcam/msl_ccam_obs.csv", timeout=600).decode("latin-1")
    raw_lines = text_lines(data)
    reader = csv.reader(io.StringIO(data, newline=""))
    header = [h.strip() for h in next(reader)]
    col = {name: i for i, name in enumerate(header)}
    for needed in ("Sol", "Spacecraft Clock", "Type of Product", "Target", "RMC Site", "RMC Drive", "Target Type"):
        assert needed in col, f"ChemCam list: column {needed!r} not found in {header}"

    rows_all = rows_laser = rows_cal = rows_blank = rows_no_stop = 0
    per_stop, types, type_index, first_line, first_sol = {}, [], {}, {}, {}
    unmatched, sols, distances = set(), [], []
    for row in reader:
        rows_all += 1
        if len(row) <= col["Target Type"] or row[col["Type of Product"]].strip() != "1-D Single laser":
            continue                                   # keep only rows that are laser (LIBS) spectra
        rows_laser += 1
        target, kind = row[col["Target"]].strip(), row[col["Target Type"]].strip()
        if re.search(r"calibration|cal\s*target|ccct", target + " " + kind, re.I):
            rows_cal += 1
            continue
        if not target:
            rows_blank += 1
            continue
        try:
            stop = f"{int(row[col['RMC Site']])}_{int(row[col['RMC Drive']])}"
            sol = int(row[col["Sol"]])
        except ValueError:
            rows_blank += 1
            continue
        if stop not in stops:
            rows_no_stop += 1
            unmatched.add((stop, target))
            continue
        sols.append(sol)
        try:
            distances.append(float(row[col["Distance (m)"]]))
        except (KeyError, ValueError):
            pass
        seen = per_stop.setdefault(stop, {})
        if target not in seen:
            if kind not in type_index:
                type_index[kind] = len(types)
                types.append(kind)
            seen[target] = type_index[kind]
            first_line[(stop, target)] = reader.line_num
            first_sol[(stop, target)] = sol

    out_stops = {}
    for stop, seen in per_stop.items():
        names = list(seen.items())                     # in order of first observation
        out_stops[stop] = {"n": len(names), "targets": [[n, t] for n, t in names[:CCAM_CAP]]}

    total = sum(v["n"] for v in out_stops.values())
    listed = sum(len(v["targets"]) for v in out_stops.values())
    out = {
        "source": "NASA PDS Geosciences Node, MSL ChemCam LIBS archive, master observation list msl_ccam_obs.csv",
        "source_url": CCAM_URL,
        "licence": "NASA Planetary Data System, public domain. Credit: NASA/JPL-Caltech/LANL/CNES/IRAP (ChemCam team)",
        "notes": (
            "Names of the rocks, soils and other features ChemCam fired its laser at from each rover stop, with "
            "the list's free-text 'Target Type'. Only rows whose 'Type of Product' is '1-D Single laser' are "
            "counted; passive, dark, imaging-only and calibration-target rows are left out. Names and types are "
            "spelled as in the list. The list holds no chemistry: this layer says what was examined, not what it "
            f"is made of. At most {CCAM_CAP} names are stored per stop, the first ones observed; 'n' is the full "
            "count of distinct names there."),
        "join_note": (
            "Joined by the list's own 'RMC Site' and 'RMC Drive' columns, which are the rover position counters "
            "that make up the stop id in data/site.json, so the join is exact and does not rely on the sol. "
            + (f"The list's own distance column puts these laser targets {min(distances):.1f} to "
               f"{max(distances):.1f} m from the mast (median {percentile(distances, 0.5):.1f} m), so each is "
               "placed at its stop." if distances else "")),
        "coverage_note": (
            f"Sols {min(sols)} to {max(sols)}. {rows_no_stop} laser rows ({len(unmatched)} stop/target pairs) were "
            "taken at a site/drive that is not a stop in site.json and are left out."),
        "fields": {"n": "distinct laser targets at the stop", "targets": ["name", "index into types"]},
        "cap": CCAM_CAP,
        "rows_in_list": rows_all,
        "rows_laser": rows_laser,
        "rows_calibration_skipped": rows_cal,
        "rows_blank_skipped": rows_blank,
        "rows_not_a_stop": rows_no_stop,
        "targets_total": total,
        "targets_listed": listed,
        "sol_range": [min(sols), max(sols)],
        "types": types,
        "stops": out_stops,
    }
    size = write_json("chemcam.json", out)
    print(f"chemcam.json: {total} targets at {len(out_stops)} stops ({listed} names stored, cap {CCAM_CAP}), "
          f"sols {min(sols)}-{max(sols)}, {len(types)} type strings, {size} bytes")
    print(f"  list rows {rows_all}, laser rows {rows_laser}, calibration skipped {rows_cal}, blank {rows_blank}, "
          f"not at a stop {rows_no_stop} rows / {len(unmatched)} targets")
    return out, {"lines": raw_lines, "first_line": first_line, "first_sol": first_sol}


# ----------------------------------------------------------------------------- 4. space weather

def build_spaceweather(refresh):
    """One DONKI request, cached. A failed or rate-limited request never crashes the build."""
    cache_dir = CACHE / "donki"
    stamp_format = "%Y-%m-%dT%H:%M:%SZ"
    now = datetime.datetime.now(datetime.timezone.utc)
    start, end = (now.date() - datetime.timedelta(days=DONKI_DAYS)).isoformat(), now.date().isoformat()
    fetched, error, refresh_error, sims = now, None, None, []

    cached = sorted(cache_dir.glob("wsa_enlil_*.json")) if cache_dir.exists() else []
    if refresh or not cached:
        incoming = cache_dir / "incoming.tmp"          # only renamed into place once it is known to be good
        try:
            raw = fetch(f"{DONKI_URL}?startDate={start}&endDate={end}&api_key=DEMO_KEY",
                        "donki/incoming.tmp", pause=0, timeout=240, force=True)          # one request only
            answer = json.loads(raw) if raw.strip() else []
            if not isinstance(answer, list):
                raise ValueError(f"unexpected response: {str(answer)[:200]}")
            good = cache_dir / f"wsa_enlil_{start}_{end}.json"
            incoming.replace(good)
            good.with_suffix(".fetched").write_text(now.strftime(stamp_format))
            cached = sorted(set(cached) | {good})
        except urllib.error.HTTPError as e:
            error = f"HTTP {e.code} {e.reason}" + (" (rate limited)" if e.code == 429 else "")
        except Exception as e:                                                              # noqa: BLE001
            error = f"{type(e).__name__}: {e}"
        if incoming.exists():
            incoming.unlink()
    if cached:
        # The newest good snapshot on disk: the one just fetched, or an older one when offline or when a
        # refresh failed.
        path = cached[-1]
        start, end = re.match(r"wsa_enlil_(\d{4}-\d\d-\d\d)_(\d{4}-\d\d-\d\d)", path.name).groups()
        stamp = path.with_suffix(".fetched")
        fetched = (datetime.datetime.strptime(stamp.read_text().strip(), stamp_format) if stamp.exists()
                   else datetime.datetime.fromtimestamp(path.stat().st_mtime, datetime.timezone.utc))
        sims = json.loads(path.read_bytes())
        refresh_error, error = error, None

    mars, raw_by_id = [], {}
    for sim in sims:
        for hit in sim.get("impactList") or []:
            if (hit.get("location") or "").strip().lower() != "mars":
                continue
            cme_ids = [c.get("CMEID") or c.get("cmeid") for c in sim.get("cmeInputs") or []
                       if c.get("CMEID") or c.get("cmeid")]
            mars.append({
                "arrival_utc": hit.get("arrivalTime"),
                "glancing_blow": hit.get("isGlancingBlow"),
                "minor_impact": hit.get("isMinorImpact"),
                "cme_ids": cme_ids,
                "simulation_id": sim.get("simulationID"),
                "model_completion_utc": sim.get("modelCompletionTime"),
                "link": sim.get("link"),
            })
            raw_by_id[sim.get("simulationID")] = {"impactList entry": hit, "cmeInputs CMEID": [
                c.get("CMEID") or c.get("cmeid") for c in sim.get("cmeInputs") or []]}
    mars.sort(key=lambda m: (m["arrival_utc"] or "", m["simulation_id"] or ""))

    out = {
        "source": "NASA CCMC DONKI (Space Weather Database Of Notifications, Knowledge, Information), WSA-Enlil simulations",
        "source_url": "https://api.nasa.gov/DONKI/WSAEnlilSimulations",
        "request_url": f"{DONKI_URL}?startDate={start}&endDate={end}",
        "licence": "NASA open data (api.nasa.gov). Credit: NASA Community Coordinated Modeling Center",
        "notes": (
            "Each entry is one model run that predicts a coronal mass ejection reaching Mars. They are forecasts "
            "from a solar-wind model, not measurements at Mars, and the same eruption is often simulated several "
            "times with different inputs, so several entries can describe one event. arrival_utc is the model's "
            "predicted arrival time at Mars; glancing_blow and minor_impact are the model's own flags; cme_ids are "
            "the DONKI ids of the eruptions fed into the run."),
        "coverage_note": f"Simulations dated {start} to {end} ({DONKI_DAYS} days). A frozen snapshot, not a live feed.",
        "fetched_utc": fetched.strftime("%Y-%m-%dT%H:%M:%SZ"),
        "start_date": start,
        "end_date": end,
        "count_all": len(sims),
        "count_mars": len(mars),
        "mars_impacts": mars,
    }
    if error:
        out["error"] = error
    if refresh_error:
        out["refresh_error"] = f"{refresh_error}; showing the previous snapshot"
    size = write_json("spaceweather.json", out)
    print(f"spaceweather.json: {len(mars)} Mars impacts in {len(sims)} simulations, {start} to {end}, {size} bytes"
          + (f"  ERROR: {error}" if error else ""))
    return out, {"raw_by_id": raw_by_id}


# ----------------------------------------------------------------------------- 5. manifest

def build_manifest(layers):
    entries = []
    dan, apxs, ccam, sw = (layers.get(k) for k in ("dan", "apxs", "chemcam", "spaceweather"))
    if dan:
        entries.append({
            "id": "dan", "title": "Subsurface water and chlorine (DAN)", "file": "dan.json",
            "count": len(dan["points"]),
            "what_it_is": "How much hydrogen (counted as water) and chlorine Curiosity's neutron instrument sensed in roughly the top metre of ground under the rover, point by point along the track.",
            "units": "weight percent water-equivalent hydrogen; weight percent absorption-equivalent chlorine",
            "source": dan["source"], "source_url": dan["source_url"],
            "credit_or_licence": f"{dan['licence']}; {dan['citation']}",
            "coverage_note": dan["coverage_note"],
            "join_note": f"Points carry their own latitude and longitude; chain_m comes from snapping to the nearest route vertex (median {dan['median_snap_m']} m, largest {dan['max_snap_m']} m), then averaging into {dan['bin_m']:g} m bins.",
        })
    if apxs:
        entries.append({
            "id": "apxs", "title": "Rock and soil chemistry (APXS)", "file": "apxs.json",
            "count": apxs["spots"],
            "what_it_is": "The chemical make-up of rocks and soil that Curiosity touched with its arm-mounted X-ray spectrometer, listed for each rover stop.",
            "units": "weight percent of each oxide or element",
            "source": apxs["source"], "source_url": apxs["source_url"],
            "credit_or_licence": apxs["licence"],
            "coverage_note": apxs["coverage_note"],
            "join_note": apxs["join_note"],
        })
    if ccam:
        entries.append({
            "id": "chemcam", "title": "Laser targets (ChemCam)", "file": "chemcam.json",
            "count": ccam["targets_total"],
            "what_it_is": "The names and kinds of rocks and soils Curiosity zapped with its laser from each rover stop.",
            "units": "none (names and descriptions only)",
            "source": ccam["source"], "source_url": ccam["source_url"],
            "credit_or_licence": ccam["licence"],
            "coverage_note": ccam["coverage_note"],
            "join_note": ccam["join_note"],
        })
    if sw:
        entries.append({
            "id": "spaceweather", "title": "Solar storms predicted to reach Mars (DONKI)", "file": "spaceweather.json",
            "count": sw["count_mars"],
            "what_it_is": "Recent NASA model runs that predict a solar eruption arriving at Mars, with the predicted arrival time.",
            "units": "UTC times",
            "source": sw["source"], "source_url": sw["source_url"],
            "credit_or_licence": sw["licence"],
            "coverage_note": sw["coverage_note"] + (f" The request failed: {sw['error']}." if sw.get("error") else ""),
            "join_note": "Not tied to a place: applies to Mars as a whole.",
        })
    out = {
        "built_utc": datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "built_by": "tools/build_science.py",
        "layers": entries,
    }
    size = write_json("science.json", out)
    print(f"science.json: {len(entries)} layers, {size} bytes")
    return out


# ----------------------------------------------------------------------------- verification printout

def verify(site, track, layers, traces):
    print("\n================ verification: baked record next to its raw source ================")
    stops = {s["id"]: s for s in site["stops"]}
    # Window of sols the rover spent at each stop, used to cross-check the site/drive joins against the sol.
    order = site["stops"]
    window = {s["id"]: (s["sol"], order[i + 1]["sol"] if i + 1 < len(order) else 10 ** 6) for i, s in enumerate(order)}

    def sol_check(label, pairs):
        pairs = list(pairs)
        off = [(stop, sol) for stop, sol in pairs if not window[stop][0] <= sol <= window[stop][1]]
        print(f"  sol cross-check, {label}: {len(pairs) - len(off)} of {len(pairs)} fall inside the sols the rover "
              f"spent at the joined stop" + (f"; outside: {off[:6]}" if off else ""))

    if "dan" in layers:
        dan, tr = layers["dan"], traces["dan"]
        pts = dan["points"]
        singles = [i for i, p in enumerate(pts) if p[8] == 1]
        multi = [i for i, p in enumerate(pts) if p[9] >= 1 and p[8] > 1]
        picks = [singles[0], multi[len(multi) // 2], len(pts) - 1]
        print("\n-- dan.json  fields:", dan["fields"])
        for i in picks:
            p = pts[i]
            print(f"  point[{i}] = {json.dumps(p)}  member={dan['members'][p[6]]!r}")
            for n in tr["trace"][i]:
                print(f"      source line {n}: {tr['lines'][n - 1]}")
        print("  on-track check (baked lat/lon to nearest route vertex):")
        worst = 0.0
        for i, p in enumerate(pts):
            d, v = track.nearest(p[1], p[0])
            worst = max(worst, d)
            if i in (0, len(pts) // 4, len(pts) // 2, 3 * len(pts) // 4, len(pts) - 1):
                print(f"      point[{i}] lat {p[0]} lon {p[1]} chain {p[7]} m -> {d:.1f} m from vertex {v} "
                      f"(vertex chain {track.route[v][3]} m)")
        print(f"      largest distance over all {len(pts)} baked points: {worst:.1f} m")

    if "apxs" in layers:
        apxs, tr = layers["apxs"], traces["apxs"]
        ids = list(apxs["stops"])
        print("\n-- apxs.json")
        for stop in (ids[0], ids[len(ids) // 2], ids[-1]):
            spot = apxs["stops"][stop][-1]
            name, act = tr["raw"][(stop, len(apxs["stops"][stop]) - 1)]
            s = stops[stop]
            print(f"  stops[{stop!r}][-1] = {json.dumps(spot)}")
            print(f"      stop in site.json: sol {s['sol']}, lat {s['lat']}, lon {s['lon']}")
            print(f"      product {name}.csv: " + " | ".join(
                re.sub(r"\s+", " ", r).strip() for r in text_lines(tr["texts"][name])[:8]))
            print(f"      activity table: {act}")
        sol_check("APXS spots", ((stop, spot["sol"]) for stop, spots in apxs["stops"].items() for spot in spots))

    if "chemcam" in layers:
        ccam, tr = layers["chemcam"], traces["chemcam"]
        ids = list(ccam["stops"])
        print("\n-- chemcam.json")
        for stop in (ids[0], ids[len(ids) // 2], ids[-1]):
            rec = ccam["stops"][stop]
            name, t = rec["targets"][0]
            print(f"  stops[{stop!r}] = n {rec['n']}, first target {[name, t]} -> type {ccam['types'][t]!r}")
            print(f"      source line {tr['first_line'][(stop, name)]}: {tr['lines'][tr['first_line'][(stop, name)] - 1][:330]}")
        sol_check("ChemCam targets (first shot)", ((stop, sol) for (stop, _), sol in tr["first_sol"].items()))

    if "spaceweather" in layers:
        sw, tr = layers["spaceweather"], traces["spaceweather"]
        print("\n-- spaceweather.json")
        if sw.get("error"):
            print("  error:", sw["error"])
        for rec in sw["mars_impacts"][:3]:
            print(f"  {json.dumps(rec)}")
            print(f"      raw: {json.dumps(tr['raw_by_id'].get(rec['simulation_id']))}")
        if not sw["mars_impacts"]:
            print(f"  no Mars impacts among {sw['count_all']} simulations")


# ----------------------------------------------------------------------------- main

def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--apxs-budget-min", type=float, default=15.0)
    ap.add_argument("--refresh-spaceweather", action="store_true")
    ap.add_argument("--only", default="dan,apxs,chemcam,spaceweather")
    args = ap.parse_args()
    only = {x.strip() for x in args.only.split(",") if x.strip()}

    site = load_site()
    track = Track(site)
    layers, traces = {}, {}
    if "dan" in only:
        layers["dan"], traces["dan"] = build_dan(site, track)
    if "apxs" in only:
        layers["apxs"], traces["apxs"] = build_apxs(site, args.apxs_budget_min)
    if "chemcam" in only:
        layers["chemcam"], traces["chemcam"] = build_chemcam(site)
    if "spaceweather" in only:
        layers["spaceweather"], traces["spaceweather"] = build_spaceweather(args.refresh_spaceweather)
    for key in ("dan", "apxs", "chemcam", "spaceweather"):          # keep manifest entries of layers not rebuilt
        if key not in layers and (OUT / f"{key}.json").exists():
            layers[key] = json.loads((OUT / f"{key}.json").read_text(encoding="utf-8"))
    build_manifest(layers)
    verify(site, track, {k: v for k, v in layers.items() if k in traces}, traces)
    return 0


if __name__ == "__main__":
    sys.exit(main())
