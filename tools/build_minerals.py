#!/usr/bin/env python3
"""Snapshot what Curiosity's CheMin instrument measured in each drill and scoop sample.

Source: NASA PDS Geosciences Node, MSL CheMin mineral-abundance products (RDR level 5).
Each product name carries the analysis sol and the rover's site and drive index, which is the
same id Curiosity's stops use, so every sample lands on an exact stop of the route.

Run after build_data.py:  python3 tools/build_minerals.py
Only the Python standard library is used.
"""
import json
import re
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "chemin"
BASE = "https://pds-geosciences.wustl.edu/msl/msl-m-chemin-4-rdr-v1/mslcmn_1xxx/data/rdr5/"
UA = "tenacity-data-snapshot/1.0"

# A product is tagged with where the rover was when CheMin ran, which is normally where the sample
# was collected. Two cases break that, and both are filtered out below:
#  - a sample analysed again later, after the rover had driven on (only the first analysis is kept);
#  - Ogunquit Beach sand, which was carried for months and first analysed far from where it was scooped.
ANALYSED_ELSEWHERE = {"Ogunquit Beach"}

# Product name: cm[ab]_<clock>min<sol 4><site 3><drive 4>ch<cell>p<version>
NAME = re.compile(r"(cm[ab]_\d+min(\d{4})(\d{3})(\d{4})ch\w+?p(\d))\.csv", re.I)


def fetch(name):
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (name or "index.html")
    if not path.exists():
        req = urllib.request.Request(BASE + name, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=90) as r:
            path.write_bytes(r.read())
        time.sleep(0.2)
    return path.read_text(encoding="latin1")


def sample_name(desc):
    m = re.search(r"(?:data|pattern|patterns) (?:for|of|from) (?:the )?(.*?)(?: drill| scoop| sample|,| analy[sz]ed| powder)", desc)
    name = m.group(1).strip() if m else ""
    # "first Mary Anning" -> "Mary Anning 1"; "Mojave2" -> "Mojave 2"
    order = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
    words = name.split()
    if words and words[0].lower() in order:
        rest = " ".join(words[1:])
        return f"{rest} {order[words[0].lower()]}" if rest else f"Rocknest scoop {order[words[0].lower()]}"
    return re.sub(r"(?<=[a-z])(\d)$", r" \1", name)


def main():
    stops = {s["id"] for s in json.loads((ROOT / "data" / "site.json").read_text())["stops"]}
    products = sorted({m.groups() for m in NAME.finditer(fetch(""))}, key=lambda g: (int(g[1]), g[0]))

    by_stop, skipped = {}, []
    seen = set()
    for product, sol, site, drive, version in products:
        stop = f"{int(site)}_{int(drive)}"
        label = fetch(product + ".lbl")
        descs = re.findall(r'DESCRIPTION\s*=\s*"(.*?)"', label, flags=re.S)
        desc = re.sub(r"\s+", " ", max(descs, key=len)) if descs else ""
        name = sample_name(desc)
        if stop not in stops or not name or name in ANALYSED_ELSEWHERE:
            skipped.append(product)
            continue
        if name in seen:                  # a later version, or a re-analysis somewhere else
            continue
        seen.add(name)

        minerals = []
        for row in fetch(product + ".csv").strip().splitlines()[1:]:
            cells = [c.strip() for c in row.split(",")]
            if len(cells) >= 2 and re.fullmatch(r"[\d.]+", cells[1]):
                minerals.append([cells[0].title(), float(cells[1])])
        minerals.sort(key=lambda m: -m[1])
        clay = re.search(r"clay minerals at ~?\s*([\d.]+)", desc)
        amorphous = re.search(r"~\s*([\d.]+) \+/- [\d.]+ weight% of the total sample consists of X-ray amorphous", desc)
        by_stop.setdefault(stop, []).append({
            "sample": name,
            "kind": "scoop" if "scoop" in desc.lower() else "drill",
            "sol": int(sol),
            "minerals": minerals,
            "clay_pct": float(clay.group(1)) if clay else None,
            "amorphous_pct": float(amorphous.group(1)) if amorphous else None,
            "product": product.lower(),
        })

    out = {
        "source": "NASA PDS Geosciences Node, MSL CheMin RDR mineral abundance tables",
        "source_url": BASE,
        "note": "Mineral percentages are shares of the crystalline part of the sample. Clay and X-ray amorphous material are shares of the whole sample and are listed separately where the product label gives them. Each sample is placed where the rover was parked for its first analysis.",
        "stops": by_stop,
    }
    (ROOT / "data" / "minerals.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")
    samples = sum(len(v) for v in by_stop.values())
    print(f"samples: {samples} at {len(by_stop)} stops  (products listed: {len(products)}, skipped: {len(skipped)})")
    for stop, items in sorted(by_stop.items(), key=lambda kv: kv[1][0]["sol"]):
        for it in items:
            top = ", ".join(f"{n} {p:g}%" for n, p in it["minerals"][:3])
            print(f"  sol {it['sol']:4d} {stop:9s} {it['kind']:5s} {it['sample']:22s} clay={it['clay_pct']} amorphous={it['amorphous_pct']} | {top}")


if __name__ == "__main__":
    main()
