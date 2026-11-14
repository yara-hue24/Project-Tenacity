#!/usr/bin/env python3
"""Snapshot what Curiosity's CheMin instrument measured in each drill and scoop sample.

Source: NASA PDS Geosciences Node, MSL CheMin mineral-abundance products (RDR level 5).
Each product name carries the analysis sol and the rover's site and drive index, which is the
same id Curiosity's stops use, so every sample lands on an exact stop of the route.

What is taken from where:
 - the crystalline minerals come from the product's table (.csv);
 - the clay and X-ray amorphous shares of the whole sample are not in any table so far: the
   CheMin team states them in the prose DESCRIPTION of the product label (.lbl). They are read
   from there, in every wording the labels use, and never estimated. Where neither the table nor
   the label gives a number the value stays null.

Run after build_data.py:  python3 tools/build_minerals.py
  --refresh   download every product again instead of using tools/.cache/chemin
Only the Python standard library is used.
"""
import json
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "chemin"
BASE = "https://pds-geosciences.wustl.edu/msl/msl-m-chemin-4-rdr-v1/mslcmn_1xxx/data/rdr5/"
UA = "data-snapshot/1.0"
PAUSE_S = 0.4

# A product is tagged with where the rover was when CheMin ran, which is normally where the sample
# was collected. Two cases break that, and both are filtered out below:
#  - a sample analysed again later, after the rover had driven on (only the first analysis is kept);
#  - Ogunquit Beach sand, which was carried for months and first analysed far from where it was scooped.
ANALYSED_ELSEWHERE = {"Ogunquit Beach"}

# Product name: cm[ab]_<clock>min<sol 4><site 3><drive 4>ch<sequence>p<version>
# Everything before the final "p<version>" identifies one analysis. The trailing number is the
# version of that analysis: p2 supersedes p1, p3 supersedes p2 (the labels say so in words, for
# example "This MIN analysis supersedes that of ...P1"). A revision may change the table, the
# label text, or both, so the label and the table are always read from the same, latest version.
NAME = re.compile(r"\b((cm[ab]_\d+min(\d{4})(\d{3})(\d{4})ch\d+)p(\d+))\.(csv|lbl)\b", re.I)

# --- clay and amorphous shares -----------------------------------------------------------------
# "~22 +/- 11 weight%", "7.6 +/- 3.8 weight%", "~27 weight%", "~11 +/-7 weight%"
_PCT = r"~?\s*(\d+(?:\.\d+)?)\s*(?:\+/-\s*\d+(?:\.\d+)?\s*)?weight\s*%"
_CLAY = r"(?:clay[- ]minerals?|phyllosilicates?|smectites?)"
# The number must follow the clay wording inside the same sentence, with no other phase named in
# between. Wordings met in the labels:
#   "The abundance of clay minerals was estimated separately, using the program FULLPAT, at ~22 +/- 11 weight% of the total sample mass"
#   "the abundance of clay minerals was modeled using the program FULLPAT at ~15 +/- 7 weight% of the total sample"
#   "estimate the abundance of poorly crystalline clay minerals at ~18 +/- 8 weight% of the total sample"
#   "The program FULLPAT was used to estimate clay mineral abundance at ~10 +/- 5 weight%"
#   "the abundance of clay minerals was estimated at ~28 +/- 12 weight%"
#   "opal-CT was modeled using the program FULLPAT at ~7 +/- 3 weight% of the total sample, and clay minerals were estimated at ~3 +/- 2 weight%"
CLAY_IN_LABEL = re.compile(_CLAY + r"\b(?:(?!opal|amorphous|glass)[^.;])*?\bat\s+" + _PCT, re.I)
#   "~28 +/- 17 weight% of this sample consists of X-ray amorphous material"
#   "~40 +/- 24 weight% of the total sample consists of X-ray amorphous materials"
AMORPHOUS_IN_LABEL = re.compile(_PCT + r"\s+of\s+(?:this|the(?:\s+total)?)\s+sample(?:\s+mass)?\s+consists\s+of\s+X-ray\s+amorphous", re.I)
# A table row that is itself the clay or the amorphous share (no product has one so far).
CLAY_ROW = re.compile(r"clay|phyllosilicate|smectite", re.I)
AMORPHOUS_ROW = re.compile(r"amorphous", re.I)
# Mentions of clay that state no amount, so that a missed wording is reported instead of passing silently.
CLAY_NO_AMOUNT = re.compile(r"other than clay minerals(?: and opal-CT)?|no clay minerals were detected|amorphous and clay mineral values", re.I)

# Chemical symbols and silica polytypes inside mineral names that older products write in capitals.
SYMBOLS = {"k": "K", "na": "Na", "ca": "Ca", "fe": "Fe", "mg": "Mg", "ct": "CT", "a": "A"}


def fetch(name, refresh=False):
    """One file from the PDS directory (the listing itself for ""), kept in the cache."""
    CACHE.mkdir(parents=True, exist_ok=True)
    path = CACHE / (name or "index.html")
    if refresh or not path.exists():
        req = urllib.request.Request(BASE + name, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=90) as r:
            path.write_bytes(r.read())
        time.sleep(PAUSE_S)
    return path.read_text(encoding="latin1")


def listing():
    """The directory listing, always fresh so a new version is noticed; the cached copy if PDS cannot be reached."""
    try:
        return fetch("", refresh=True)
    except OSError as e:
        if not (CACHE / "index.html").exists():
            raise
        print(f"WARNING: PDS listing not reachable ({e}); using the cached listing, which may miss newer versions")
        return fetch("")


def latest_products(index):
    """One product per analysis: the highest version that has both its table and its label."""
    files = {}
    for product, analysis, sol, site, drive, version, ext in NAME.findall(index):
        files.setdefault((analysis.lower(), int(sol), int(site), int(drive)), {}).setdefault(int(version), set()).add(ext.lower())
    out = []
    for (analysis, sol, site, drive), versions in files.items():
        complete = [v for v, exts in versions.items() if exts >= {"csv", "lbl"}]
        if complete:
            out.append({"product": f"{analysis}p{max(complete)}", "sol": sol, "stop": f"{site}_{drive}",
                        "version": max(complete), "versions": sorted(versions)})
    return sorted(out, key=lambda p: (p["sol"], p["product"]))


def description(label):
    descs = re.findall(r'DESCRIPTION\s*=\s*"(.*?)"', label, flags=re.S)
    return re.sub(r"\s+", " ", max(descs, key=len)).strip() if descs else ""


def sample_name(desc):
    m = re.search(r"(?:data|pattern|patterns) (?:for|of|from) (?:the )?(.*?)(?: drill| scoop| sample|,| analy[sz]ed| powder)", desc)
    name = m.group(1).strip() if m else ""
    # The label's own name wins: "the second Mary Anning drill sample, labelled Mary Anning 3".
    own = re.match(r"[^.]*?\bsample, labell?ed ([A-Z][\w ]*?\d*)(?=[.,;])", desc[m.end(1):]) if m else None
    if own:
        return own.group(1).strip()
    # "first Glen Etive" -> "Glen Etive 1"; "Mojave2" -> "Mojave 2"
    order = {"first": 1, "second": 2, "third": 3, "fourth": 4, "fifth": 5}
    words = name.split()
    if words and words[0].lower() in order:
        rest = " ".join(words[1:])
        return f"{rest} {order[words[0].lower()]}" if rest else f"Rocknest scoop {order[words[0].lower()]}"
    return re.sub(r"(?<=[a-z])(\d)$", r" \1", name)


def mineral_name(raw):
    """The table's own spelling; names written in capitals become "Plagioclase", "K-feldspar", "Opal-CT"."""
    name = re.sub(r"\s+", " ", raw).strip()
    if not name or name != name.upper():
        return name                      # mixed case already, e.g. "FeMgCa carbonate", "Mg-sulfate.4H2O"
    name = "".join(SYMBOLS.get(part, part) for part in re.split(r"([- ])", name.lower()))
    return name[0].upper() + name[1:]


def read_table(csv_text):
    """Rows of the abundance table as (name, percent); rows that are not a name and a number are returned apart."""
    rows, odd = [], []
    for line in csv_text.strip().splitlines()[1:]:
        cells = [c.strip() for c in line.split(",")]
        if not any(cells):
            continue
        if len(cells) >= 2 and cells[0] and re.fullmatch(r"\d+(?:\.\d*)?|\.\d+", cells[1]):
            rows.append((cells[0], float(cells[1])))
        else:
            odd.append(line.strip())
    return rows, odd


def whole_sample_share(rows, row_pattern, desc, label_pattern, what, warn):
    """(value, "table" | "label") for clay or amorphous content, or (None, None) when the source gives no number."""
    in_table = [pct for name, pct in rows if row_pattern.search(name)]
    in_label = sorted({float(v) for v in label_pattern.findall(desc)})
    if len(in_table) > 1 or len(in_label) > 1:
        warn(f"{what}: several values (table {in_table}, label {in_label}); left empty, read the product by hand")
        return None, None
    if in_table:
        if in_label and in_label[0] != in_table[0]:
            warn(f"{what}: table says {in_table[0]:g}, label says {in_label[0]:g}; the table value is used")
        return in_table[0], "table"
    if in_label:
        return in_label[0], "label"
    return None, None


def sentences_with(desc, word):
    return [s.strip() for s in re.split(r"(?<=[a-z%)])\.\s+(?=[A-Z])", desc) if re.search(word, s, re.I)]


def main():
    refresh = "--refresh" in sys.argv[1:]
    stops = {s["id"] for s in json.loads((ROOT / "data" / "site.json").read_text())["stops"]}
    products = latest_products(listing())

    by_stop, skipped, notes = {}, [], []
    seen = set()
    for p in products:
        product, stop = p["product"], p["stop"]
        desc = description(fetch(product + ".lbl", refresh))
        name = sample_name(desc)
        if not name or name in ANALYSED_ELSEWHERE:
            skipped.append(f"{product}  {name or 'no sample name found in the label'}")
            continue
        if name in seen:                  # analysed again later, possibly after driving on
            skipped.append(f"{product}  {name}, a later analysis of a sample already placed")
            continue
        seen.add(name)                    # the first analysis decides where the sample belongs
        if stop not in stops:
            skipped.append(f"{product}  {name}, stop {stop} is not on the route")
            continue

        def warn(msg, name=name, product=product):
            notes.append(f"WARNING {name} ({product}): {msg}")

        rows, odd = read_table(fetch(product + ".csv", refresh))
        for line in odd:
            warn(f"table row not understood and left out: {line!r}")
        clay, clay_from = whole_sample_share(rows, CLAY_ROW, desc, CLAY_IN_LABEL, "clay", warn)
        amorphous, amorphous_from = whole_sample_share(rows, AMORPHOUS_ROW, desc, AMORPHOUS_IN_LABEL, "amorphous", warn)
        if clay is None and re.search(r"clay|phyllosilicate|smectite", CLAY_NO_AMOUNT.sub("", desc), re.I):
            warn("the label mentions clay in a wording this script does not read: " + " | ".join(sentences_with(CLAY_NO_AMOUNT.sub("", desc), "clay|phyllosilicate|smectite")))
        if amorphous is None and re.search(r"amorphous", desc, re.I):
            warn("the label mentions amorphous material in a wording this script does not read: " + " | ".join(sentences_with(desc, "amorphous")))
        # Whole-sample percentages the label states for something else (opal-CT, opaline material...). Shown, not recorded.
        used = [m.span() for pat in (CLAY_IN_LABEL, AMORPHOUS_IN_LABEL) for m in pat.finditer(desc)]
        for m in re.finditer(_PCT, desc):
            if not any(a <= m.start() and m.end() <= b for a, b in used):
                start = max(desc.rfind(". ", 0, m.start()) + 2, 0)
                end = desc.find(". ", m.end())
                notes.append(f"note {name} ({product}): the label also states, not recorded: \"{desc[start:end if end > 0 else len(desc)].strip()}\"")

        minerals = [[mineral_name(n), pct] for n, pct in rows if not (CLAY_ROW.search(n) or AMORPHOUS_ROW.search(n))]
        minerals.sort(key=lambda m: -m[1])
        entry = {
            "sample": name,
            "kind": "scoop" if "scoop" in desc.lower() else "drill",
            "sol": p["sol"],
            "minerals": minerals,
            "clay_pct": clay,
            "amorphous_pct": amorphous,
            "product": product,
        }
        if clay_from:
            entry["clay_from"] = clay_from
        if amorphous_from:
            entry["amorphous_from"] = amorphous_from
        entry["_versions"] = p["versions"]
        by_stop.setdefault(stop, []).append(entry)

    samples = [it for items in by_stop.values() for it in items]
    print(f"samples: {len(samples)} at {len(by_stop)} stops  (analyses listed: {len(products)}, not used: {len(skipped)})")
    print(f"with clay share: {sum(it['clay_pct'] is not None for it in samples)}   with amorphous share: {sum(it['amorphous_pct'] is not None for it in samples)}")
    for stop, items in sorted(by_stop.items(), key=lambda kv: kv[1][0]["sol"]):
        for it in items:
            versions = it.pop("_versions")
            top = ", ".join(f"{n} {pct:g}%" for n, pct in it["minerals"][:3])
            ver = f"p{max(versions)}" + (f" of {len(versions)}" if len(versions) > 1 else "")
            print(f"  sol {it['sol']:4d} {stop:9s} {it['kind']:5s} {it['sample']:22s} {ver:7s} clay={it['clay_pct']} amorphous={it['amorphous_pct']} | {top}")
    for line in skipped:
        print("  not used:", line)
    for line in notes:
        print(" ", line)

    out = {
        "source": "NASA PDS Geosciences Node, MSL CheMin RDR mineral abundance tables",
        "source_url": BASE,
        "note": "Mineral percentages are shares of the crystalline part of the sample, from the latest version of each product. Clay and X-ray amorphous material are shares of the whole sample and are listed separately where the product gives them (clay_from and amorphous_from say whether in its table or in its label text); null means the product states no number. Each sample is placed where the rover was parked for its first analysis.",
        "stops": by_stop,
    }
    (ROOT / "data" / "minerals.json").write_text(json.dumps(out, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
