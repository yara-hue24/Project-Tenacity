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

# The whole track is walkable ground. Photos are bundled only for the boxwork campaign
# on Mount Sharp; every other stop loads its photo from NASA when it is opened.
PHOTO_SOL_FIRST = 4553  # "Back to the boxwork" (NASA Curiosity blog, sol 4553)
PHOTO_SOL_LAST = 4880   # Atacama drill site, first layered-sulfate bedrock past the boxwork

MARS_RADIUS_M = 3396190.0
MIN_SPACING_M = 1.5  # keep one route point per this many metres; the feed is far denser
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


def build_route(traverse):
    """Join every drive into one line.

    Distance along the track ("chain") is added up over every point NASA publishes,
    then the line is thinned, so the stored distances stay true to the full track.
    Returns the route and the chain at the end of each drive, keyed by position.
    """
    def key(c):
        return (round(c[0], 6), round(c[1], 6))

    def coords(f):
        g = f["geometry"]
        if g["type"] == "MultiLineString":
            return [c for line in g["coordinates"] for c in line]
        return g["coordinates"]

    route, ends = [], {}
    chain, prev, kept = 0.0, None, None

    def keep(c):
        route.append([round(c[0], 7), round(c[1], 7), round(c[2], 2), round(chain, 2)])

    for f in traverse["features"]:
        drive = coords(f)
        for i, c in enumerate(drive):
            if prev is not None:
                chain += math.hypot(ground_m(prev, c), c[2] - prev[2])
            prev = c
            last_of_drive = i == len(drive) - 1
            if kept is None or last_of_drive or ground_m(kept, c) >= MIN_SPACING_M:
                if kept is None or ground_m(kept, c) > 0.05:
                    keep(c)
                    kept = c
            if last_of_drive:
                ends[key(c)] = chain
    return route, ends, key


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

    wps = wp_all
    route, ends, key = build_route(traverse)
    ends.setdefault(key(route[0]), 0.0)

    PHOTOS.mkdir(parents=True, exist_ok=True)
    stops = []
    for i, f in enumerate(wps):
        p = f["properties"]
        k = key((p["lon"], p["lat"]))
        chain, off = (ends[k], 0.0) if k in ends else nearest_chain(route, p["lon"], p["lat"])
        next_sol = wps[i + 1]["properties"]["sol"] if i + 1 < len(wps) else p["sol"] + 4
        stop = {
            "id": p["RMC"],
            "sol": p["sol"],
            "lon": round(p["lon"], 7),
            "lat": round(p["lat"], 7),
            "elev_m": round(p["elev_geoid"], 1),
            "tilt_deg": p["tilt"],
            "chain_m": round(chain, 2),
        }
        if off > 2:
            print(f"warn: waypoint sol {p['sol']} is {off:.1f} m off the route", file=sys.stderr)
        bundled = PHOTO_SOL_FIRST <= p["sol"] <= PHOTO_SOL_LAST
        im = pick_photo(p["sol"], max(next_sol, p["sol"] + 1), p["site"], p["drive"]) if bundled else None
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
            "name": "Curiosity's track, Gale Crater",
            "snapshot_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"),
            "sol_range": [wps[0]["properties"]["sol"], wps[-1]["properties"]["sol"]],
            "bundled_photo_sols": [PHOTO_SOL_FIRST, PHOTO_SOL_LAST],
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
