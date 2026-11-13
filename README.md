# Project Tenacity

A Marswalk margin map for Gale Crater, built on the 38.8 km of ground the Curiosity rover has already driven.

Built for the NASA Space Apps Challenge 2026, "Interplanetary Survival Guide: Martian Map".

## What it answers

One question for one walk: **can I walk there and get home alive, today?**

The crew parks a pressurised rover anywhere on Curiosity's track, walks out along it, works at a few science stops and walks back. Two walks are ready to load: a short one across the boxwork ridges on Mount Sharp, and a 5 km one from Dingo Gap to Pahrump Hills that runs close to the limit. Tenacity shows, at every moment of the plan:

- **Turn back in** – how much longer you can stay where you are before the walk home no longer fits.
- **Walk home** – distance and a time range, planned pace to slow pace.
- **Limiting supply** – whichever runs out first, oxygen or daylight, named.

Each stop also gets a "start home by" clock time, and the whole plan prints as a wrist-sized cuff card.

The screen starts simple: the map, one answer, a short stop list. Everything else opens on a click: the numbers behind the answer, each stop's photo and times, the ground profile, a Mars-and-Earth clock comparison, and an Advanced drawer with assumptions, layers and sources.

## The rule

> Keep enough oxygen to walk home at 2.4× working effort, at a slow pace, plus a reserve. Be home one reserve before sunset.

The 2.4 comes from NASA's own numbers: 2,505 kJ/h in the 10 km Advanced Walkback Test against 1,030 kJ/h for average Apollo surface work (NASA BVAD Rev 2). It was measured in simulated lunar gravity with six people, so the app labels it **derived**, not measured on Mars.

Every number on screen carries one of four tags: `MEASURED`, `NASA VALUE`, `DERIVED` or `ASSUMED`. The Sources tab lists where each one comes from and what the map cannot see.

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Tests for the walk model:

```sh
node --test tests/*.mjs
```

Refresh the NASA data snapshot (Python standard library only):

```sh
python3 tools/build_data.py
```

## Layout

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page and its styling |
| `js/model.js` | The walk model: pure functions, every constant sourced |
| `js/app.js` | Map, status strip, plan panel, timeline, cuff card |
| `data/site.json` | Snapshot of Curiosity's whole route, its 1,388 stops and the latest weather |
| `data/photos/` | One Curiosity Navcam frame for each boxwork stop; other stops load theirs from NASA when opened |
| `data/rovers.json` | Where Curiosity and Perseverance are now, plus Perseverance's track; refreshed from NASA when the page loads |
| `data/targets.json` | Ready-made walks, science goals, named stops with their NASA sources |
| `tools/build_data.py` | Rebuilds the snapshot from NASA's public feeds |
| `vendor/leaflet/` | Leaflet 1.9.4 (BSD-2-Clause) |
| `vendor/fonts/` | Inter and DM Mono, the typefaces NASA's own sites use (SIL Open Font License) |

## Data

| Data | Kind | Source |
|---|---|---|
| Route, stop positions, elevation, rover tilt | Topographic | Curiosity location-map feeds, NASA/JPL-Caltech |
| HiRISE 25 cm and CTX 6 m imagery | Optical | NASA/JPL-Caltech/Univ. of Arizona/MSSS |
| Navcam photo at each stop | Optical | Curiosity raw images, NASA/JPL-Caltech |
| Daily weather and sunset | Atmospheric | Curiosity REMS, NASA/JPL-Caltech/CAB |
| Surface dose rate | Radiation | Curiosity RAD, Hassler et al. 2014 |
| Oxygen use, walk-back effort | Life support | NASA BVAD Rev 2 (2022) |
| Stop names and science notes | – | NASA Curiosity mission blog |

Map tiles, and photos for stops outside the boxwork, load from NASA's public Curiosity pages. Everything else is stored in this repository.

Mars local time is computed with the Mars24 algorithm (Allison & McEwen 2000, NASA GISS).

The map zooms out to the whole planet (OpenPlanetaryMap basemap, from NASA/USGS data) and marks where Curiosity and Perseverance stopped after their last drives, read from NASA's rover position feeds each time the page loads.

## Known limits

- The route stays on Curiosity's track. That is the only ground measured at walking scale; rocks and sand off the track are not modelled.
- Weather is the latest record in NASA's public feed, which can be months old. The app flags its age.
- No solar-storm feed is connected. Routine radiation dose is shown for context and does not drive the verdict.
- Suit power, cooling water and CO₂ removal are not modelled.
- Walking speed on Mars in a suit has never been measured. The default is an Apollo planning value and can be changed.

## Use of AI

Parts of this project's code and background research were produced with an AI coding assistant (Claude, by Anthropic). The project submission form describes how it was used.

## Licence and credits

Code: MIT, see `LICENSE`. Data and imagery: courtesy NASA/JPL-Caltech and the institutions named above.

This project is not affiliated with or endorsed by NASA.
