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

# Where the rovers are now. The app re-reads the two position feeds when it loads;
# this snapshot is the fallback when NASA cannot be reached.
ROVERS = [
    {
        "id": "curiosity", "name": "Curiosity", "mission": "Mars Science Laboratory", "place": "Gale Crater",
        "landed_utc": "2012-08-06T05:17:57Z",
        "feed": "https://mars.nasa.gov/mmgis-maps/MSL/Layers/json/MSL_waypoints_current.json",
        "map": "https://science.nasa.gov/mission/msl-curiosity/location-map/",
        "track": None,   # Curiosity's track is the walkable route in site.json
    },
    {
        "id": "perseverance", "name": "Perseverance", "mission": "Mars 2020", "place": "Jezero Crater",
        "landed_utc": "2021-02-18T20:55:00Z",
        "feed": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_waypoints_current.json",
        "map": "https://science.nasa.gov/mission/mars-2020-perseverance/location-map/",
        "track": "https://mars.nasa.gov/mmgis-maps/M20/Layers/json/M20_traverse.json",
    },
]
ROVER_TRACK_SPACING_M = 8

# The whole track is walkable ground. Photos are bundled only for the boxwork campaign
# on Mount Sharp; every other stop loads its photo from NASA when it is opened.
PHOTO_SOL_FIRST = 4553  # "Back to the boxwork" (NASA Curiosity blog, sol 4553)
PHOTO_SOL_LAST = 4880   # Atacama drill site, first layered-sulfate bedrock past the boxwork

MARS_RADIUS_M = 3396190.0
MIN_SPACING_M = 1.5  # keep one route point per this many metres; the feed is far denser
UA = "data-snapshot/1.0"


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


COMPASS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"]


def nav_pointing(im):
    """Where a Navcam frame looks: compass azimuth, elevation, and azimuth relative to the rover's nose.

    Mirrors js/photo.js. The feed gives the CAHVOR camera model in the rover frame (A is the
    boresight) and the rover-to-local-level quaternion (w, x, y, z).
    """
    try:
        nums = lambda t: [float(v) for v in t.strip("()").split(",")]
        vx, vy, vz = nums(im["camera"]["camera_model_component_list"].split(";")[1])
        w, x, y, z = nums(im["attitude"])
    except (KeyError, IndexError, ValueError):
        return None
    tx, ty, tz = 2 * (y * vz - z * vy), 2 * (z * vx - x * vz), 2 * (x * vy - y * vx)
    north = vx + w * tx + (y * tz - z * ty)
    east = vy + w * ty + (z * tx - x * tz)
    down = vz + w * tz + (x * ty - y * tx)
    return {
        "az": math.degrees(math.atan2(east, north)) % 360,
        "el": -math.degrees(math.asin(max(-1.0, min(1.0, down)))),
        "rover_az": math.degrees(math.atan2(vy, vx)) % 360,
    }


def pick_photo(sol, next_sol, site, drive, bearing):
    """Best left-Navcam frame at this rover position: no deck, horizon in view, looking along the track."""
    tag = re.compile(r"_[FS](\d{3})(\d{4})NCAM")
    best = None
    for s in range(sol, min(next_sol, sol + 3)):
        feed = fetch(IMAGES_URL.format(sol=s), f"images_{s}.json")
        for im in feed.get("images", []):
            m = tag.search(im["imageid"])
            if not m or not im["camera"]["instrument"].startswith("NAV_LEFT") or int(m.group(1)) != site or int(m.group(2)) != drive:
                continue
            p = nav_pointing(im)
            if not p:
                continue
            deck = 165 < p["rover_az"] < 335
            horizon = -25 <= p["el"] <= 8
            tier = 0 if (not deck and horizon) else 1 if not deck else 2 if horizon else 3
            off = abs((p["az"] - bearing + 540) % 360 - 180) if bearing is not None else 0
            score = tier * 1000 + abs(p["el"] + 10) + 0.15 * off + (0 if im["sample_type"] == "full" else 6)
            if best is None or score < best[0]:
                best = (score, tier, im, p)
        if best and best[1] == 0:
            break
    return best


def rover_now(feed):
    p = feed["features"][-1]["properties"]
    return {
        "sol": p["sol"], "lat": round(p["lat"], 6), "lon": round(p["lon"], 6),
        "elev_m": round(p["elev_geoid"], 1), "dist_total_m": round(p["dist_total_m"], 1),
    }


def thin_track(traverse):
    """One [lon, lat] every few metres, kept as separate lines per drive group."""
    lines = []
    for f in traverse["features"]:
        g = f["geometry"]
        for line in (g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]):
            out = []
            for c in line:
                if not out or ground_m(out[-1], c) >= ROVER_TRACK_SPACING_M:
                    out.append([round(c[0], 6), round(c[1], 6)])
            if line and out[-1] != [round(line[-1][0], 6), round(line[-1][1], 6)]:
                out.append([round(line[-1][0], 6), round(line[-1][1], 6)])
            if len(out) > 1:
                if lines and lines[-1][-1] == out[0]:
                    lines[-1].extend(out[1:])     # drives join end to start
                else:
                    lines.append(out)
    return lines


def build_rovers():
    rovers = []
    for r in ROVERS:
        entry = {k: r[k] for k in ("id", "name", "mission", "place", "landed_utc", "feed", "map")}
        entry["now"] = rover_now(fetch(r["feed"], f"{r['id']}_current.json"))
        if r["track"]:
            entry["track"] = thin_track(fetch(r["track"], f"{r['id']}_traverse.json"))
        rovers.append(entry)
    out = {"snapshot_utc": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%MZ"), "rovers": rovers}
    (DATA / "rovers.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    for r in rovers:
        n = r["now"]
        pts = sum(len(line) for line in r.get("track", []))
        print(f"{r['name']}: sol {n['sol']}  {n['lat']}, {n['lon']}  driven {n['dist_total_m'] / 1000:.2f} km  track points {pts}")


def main():
    wp_all = fetch(WAYPOINTS_URL, "waypoints.json")["features"]
    traverse = fetch(TRAVERSE_URL, "traverse.json")
    weather = fetch(WEATHER_URL, "weather.json")

    wps = wp_all
    route, ends, key = build_route(traverse)
    ends.setdefault(key(route[0]), 0.0)

    PHOTOS.mkdir(parents=True, exist_ok=True)
    stops = []
    deck_shots = 0
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
        bearing = None
        if i + 1 < len(wps):
            q = wps[i + 1]["properties"]
            bearing = math.degrees(math.atan2((q["lon"] - p["lon"]) * math.cos(math.radians(p["lat"])), q["lat"] - p["lat"])) % 360
        pick = pick_photo(p["sol"], max(next_sol, p["sol"] + 1), p["site"], p["drive"], bearing) if bundled else None
        if pick:
            _, tier, im, look = pick
            name = f"{p['RMC']}.jpg"
            url = im["image_files"]["medium"].replace("http://", "https://")
            (PHOTOS / name).write_bytes(fetch(url, f"photo_{im['imageid']}.jpg", binary=True))
            stop["photo"] = {
                "file": f"data/photos/{name}",
                "sol": im["sol"],
                "taken_utc": im["date_taken_utc"][:19],
                "page": im["link"],
                "credit": im["credit"],
                "looking": COMPASS[round(look["az"] / 22.5) % 16],
            }
            deck_shots += tier >= 2
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
    print(f"stops: {len(stops)}  with photo: {with_photo}  of which only a deck view exists: {deck_shots}")
    print(f"weather: sol {site['weather']['sol']} ({site['weather']['earth_date']})")
    build_rovers()


if __name__ == "__main__":
    main()
