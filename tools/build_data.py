#!/usr/bin/env python3
"""Snapshot the NASA data Tenacity needs into data/ so the app runs offline.

Sources (all public, no key):
  - Curiosity waypoints + traverse (NASA/JPL-Caltech, MMGIS location map feeds)
  - Curiosity REMS daily weather (NASA/JPL-Caltech/CAB)
  - Curiosity raw images (NASA/JPL-Caltech)

Run:  python3 tools/build_data.py
Only the Python standard library is used.
"""
import json
import math
import re
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
PHOTOS = DATA / "photos"
CACHE = ROOT / "tools" / ".cache"

WAYPOINTS_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints.json"
TRAVERSE_URL = "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_traverse.json"
WEATHER_URL = "https://mars.nasa.gov/rss/api/?feed=weather&category=msl&feedtype=json"
IMAGES_URL = "https://mars.nasa.gov/rss/api/?feed=raw_images&category=msl&feedtype=json&sol={sol}&num=500"

# Curiosity's boxwork campaign on Mount Sharp, Gale Crater.
SOL_FIRST = 4553  # "Back to the boxwork" (NASA Curiosity blog, sol 4553)
SOL_LAST = 4880   # Atacama drill site, first layered-sulfate bedrock past the boxwork

MARS_RADIUS_M = 3396190.0
MIN_SPACING_M = 0.5  # the feed repeats points a few centimetres apart
UA = "tenacity-data-snapshot/1.0"


def fetch(url, cache_name, binary=False):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / cache_name
    if not path.exists():
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=90) as r:
            path.write_bytes(r.read())
        time.sleep(0.3)
    return path.read_bytes() if binary else json.loads(path.read_text(encoding="utf-8", errors="replace"))


def ground_m(a, b):
    """Horizontal distance in metres between two [lon, lat] points on Mars."""
    lat = math.radians((a[1] + b[1]) / 2)
    dx = math.radians(b[0] - a[0]) * math.cos(lat) * MARS_RADIUS_M
    dy = math.radians(b[1] - a[1]) * MARS_RADIUS_M
    return math.hypot(dx, dy)


def build_route(waypoints, traverse):
    """Join the per-drive traverse lines between the first and last waypoint."""
    def key(c):
        return (round(c[0], 6), round(c[1], 6))

    def coords(f):
        g = f["geometry"]
        if g["type"] == "MultiLineString":
            return [c for line in g["coordinates"] for c in line]
        return g["coordinates"]

    drives = [coords(f) for f in traverse["features"]]
    ends = {key(d[-1]): i for i, d in enumerate(drives) if d}

    first = ends.get(key(waypoints[0]["geometry"]["coordinates"]))
    last = ends.get(key(waypoints[-1]["geometry"]["coordinates"]))
    if first is None or last is None:
        sys.exit("could not match waypoints to traverse segments")

    pts = [waypoints[0]["geometry"]["coordinates"]]
    for d in drives[first + 1:last + 1]:
        for c in d:
            if ground_m(pts[-1], c) > MIN_SPACING_M:
                pts.append(c)

    route, chain = [], 0.0
    for i, c in enumerate(pts):
        if i:
            chain += math.hypot(ground_m(pts[i - 1], c), c[2] - pts[i - 1][2])
        route.append([round(c[0], 7), round(c[1], 7), round(c[2], 2), round(chain, 2)])
    return route


def nearest_chain(route, lon, lat):
    best = min(route, key=lambda p: ground_m(p, (lon, lat)))
    return best[3], ground_m(best, (lon, lat))


def pick_photo(sol, next_sol, site, drive):
    """First full-frame left Navcam image taken at this exact rover position."""
    tag = re.compile(r"_F(\d{3})(\d{4})NCAM")
    for s in range(sol, min(next_sol, sol + 4)):
        feed = fetch(IMAGES_URL.format(sol=s), f"images_{s}.json")
        for im in feed.get("images", []):
            if im["camera"]["instrument"] != "NAV_LEFT_B" or im["sample_type"] != "full":
                continue
            m = tag.search(im["imageid"])
            if m and int(m.group(1)) == site and int(m.group(2)) == drive:
                return im
    return None


def main():
    wp_all = fetch(WAYPOINTS_URL, "waypoints.json")["features"]
    traverse = fetch(TRAVERSE_URL, "traverse.json")
    weather = fetch(WEATHER_URL, "weather.json")

    wps = [f for f in wp_all if SOL_FIRST <= f["properties"]["sol"] <= SOL_LAST]
    route = build_route(wps, traverse)

    PHOTOS.mkdir(parents=True, exist_ok=True)
    stops = []
    for i, f in enumerate(wps):
        p = f["properties"]
        chain, off = nearest_chain(route, p["lon"], p["lat"])
        next_sol = wps[i + 1]["properties"]["sol"] if i + 1 < len(wps) else p["sol"] + 4
        stop = {
            "id": p["RMC"],
            "sol": p["sol"],
            "lon": round(p["lon"], 7),
            "lat": round(p["lat"], 7),
            "elev_m": round(p["elev_geoid"], 1),
            "tilt_deg": p["tilt"],
            "chain_m": chain,
        }
        if off > 2:
            print(f"warn: waypoint sol {p['sol']} is {off:.1f} m off the route", file=sys.stderr)
        im = pick_photo(p["sol"], max(next_sol, p["sol"] + 1), p["site"], p["drive"])
        if im:
            name = f"{p['RMC']}.jpg"
            (PHOTOS / name).write_bytes(fetch(im["image_files"]["medium"], f"photo_{name}", binary=True))
            stop["photo"] = {
                "file": f"data/photos/{name}",
                "sol": im["sol"],
                "taken_utc": im["date_taken_utc"][:19],
                "page": im["link"],
                "credit": im["credit"],
            }
        stops.append(stop)

    latest = next(s for s in weather["soles"] if s["max_temp"] not in ("--", "", None))
    site = {
        "meta": {
            "name": "Boxwork ridges, Mount Sharp, Gale Crater",
            "snapshot_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "sol_range": [SOL_FIRST, SOL_LAST],
            "mars_radius_m": MARS_RADIUS_M,
            "elevation_datum": "Mars geoid (rover localisation)",
        },
        "route": route,
        "stops": stops,
        "weather": {
            "sol": int(latest["sol"]),
            "earth_date": latest["terrestrial_date"],
            "ls_deg": int(latest["ls"]),
            "air_min_c": int(latest["min_temp"]),
            "air_max_c": int(latest["max_temp"]),
            "ground_min_c": int(latest["min_gts_temp"]),
            "ground_max_c": int(latest["max_gts_temp"]),
            "pressure_pa": int(latest["pressure"]),
            "sky": latest["atmo_opacity"],
            "uv": latest["local_uv_irradiance_index"],
            "sunrise": latest["sunrise"],
            "sunset": latest["sunset"],
        },
    }
    DATA.mkdir(exist_ok=True)
    (DATA / "site.json").write_text(json.dumps(site, separators=(",", ":")), encoding="utf-8")

    with_photo = sum(1 for s in stops if "photo" in s)
    print(f"route points: {len(route)}  length: {route[-1][3]:.0f} m")
    print(f"stops: {len(stops)}  with photo: {with_photo}")
    print(f"weather: sol {site['weather']['sol']} ({site['weather']['earth_date']})")


if __name__ == "__main__":
    main()
