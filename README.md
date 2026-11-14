# Project Tenacity

An EVA planner for walking on Mars: sketch a walk at Gale Crater, simulate it before it happens, and check it against flight rules. Built on real NASA data for the ground the Curiosity rover has explored.

Built for the NASA Space Apps Challenge 2026, "Interplanetary Survival Guide: Martian Map".

Live: https://yara-hue24.github.io/Project-Tenacity/

## The idea

Rover drivers at JPL plan every drive in a tool suite called RSVP: they sketch the drive on the terrain, simulate it, and validate it before sending it to Mars. Tenacity gives a walking astronaut the same loop.

| Rover planners (RSVP) | Tenacity, for a walk |
|---|---|
| MobSketch: drive legs drawn on the map, with an activity list | Legs and stations on the map, with an activity list |
| RoSE: command sequence table and a status console | Sequence table (one row per walk, work or return step) and a console |
| SSim: predicts what a sequence will do before it is sent | Walk simulation: time, oxygen, CO₂, cooling water, battery, walk-home time |
| HyperDrive: terrain views, several clocks, playback | Terrain layers, a clock strip (UTC, Mars mean and true solar time, elapsed time), playback |
| ROCS: time, shadow, path-planning and terrain services | Mars time, Sun position, cast shadow, line of sight, path finding, in the browser |

The top bar always answers one question: **GO or NO-GO, by what margin, and which rule decides.**

## What you can do

- Load a ready-made walk, or switch to **Sketch** and click the map to add stations anywhere.
- Choose how each leg is walked: along the rover's track, in a straight line, or on the easiest path the terrain engine can find under the slope limit.
- Mark **keep-out zones**; path finding and the walk-home calculation go around them.
- Click any point to **probe** it: every layer is read at that point, shown or not, with its source tag.
- Play the plan back on the Mars clock; shadow and sunlight layers follow the playhead.
- Print a wrist-sized **cuff card** of the plan.

## Flight rules

Every rule shows PASS, or a flag: `W` warning (blocks the walk), `C` caution, `A` advisory.

| Rule | Checks | Basis |
|---|---|---|
| FR-01 | At every moment the refuge is within 60 min at emergency pace | xEMU suit emergency return capability; Artemis III limits walking distance the same way |
| FR-02 | Oxygen left covers the emergency walk home plus a 30 min reserve | Apollo 15 planning memo (emergency walk-back at 1440 BTU/h) |
| FR-03 | Back before sunset, with the reserve | Mars24 algorithm for the season at the refuge |
| FR-04 | Slope along the route within the 20° suit limit | Artemis suit requirement |
| FR-05 | Ground driven by a rover; legs on ground known only from orbit are flagged | Our rule |
| FR-06 | Line of sight to the refuge | Computed from the elevation grid |
| FR-07 | Walk no longer than 8 h | Suit requirement |
| FR-08, FR-09 | Battery and cooling water cover the walk home plus reserve | xEMU capacities; battery load is assumed |
| FR-10 | No solar eruption forecast to reach Mars within 2 days | NASA DONKI WSA-Enlil forecasts |
| FR-11 | Loose ground on the route | THEMIS thermal inertia |
| FR-12 | Route stays out of keep-out zones | Zones set by the crew |

Every number carries one of four tags: `MEASURED`, `NASA VALUE`, `DERIVED` or `ASSUMED`. The Sources tab lists each constant with its source.

## Layers

One colour fill at a time; patterns, lines and points stack on top. The no-go hatch (slope over the limit) is always drawn. Presets: Plan, Terrain hazard, Science, Light + comms, Reach.

| Group | Layers | Source |
|---|---|---|
| Imagery | HiRISE 25 cm, CTX 6 m, place names, whole-planet basemap | NASA/JPL-Caltech/Univ. of Arizona/MSSS; OpenPlanetaryMap |
| Terrain | Elevation, slope, roughness, relief lines, no-go hatch | MRO HiRISE 1 m elevation model, NASA Mars Trek |
| Light and comms | Sunlit and shaded slopes at plan time, cast shadow at plan time, no line of sight to the refuge | Computed from the elevation grid and the Sun's position |
| Ground | Thermal inertia, loose ground, night-time warmth | Mars Odyssey THEMIS, ASU JMARS |
| Minerals from orbit | Hydrated minerals, clays, iron minerals | MRO CRISM browse products, NASA PDS |
| Measured by Curiosity | Rover track, 1,388 stops with photos, CheMin minerals (48 samples), APXS chemistry (1,784 spots), DAN subsurface water (to sol 3333), ChemCam target names | NASA/JPL-Caltech; NASA PDS; DAN table by Nikiforov et al. 2022 (Zenodo, CC BY 4.0) |
| Reach | Walk-home time to the refuge, suit-failure return limit | Computed from the elevation grid and the walking model |
| Positions | Where Curiosity and Perseverance are now | NASA rover position feeds, read when the page loads |

## Run it

No build step. Serve the folder and open it:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

Tests (walk simulation, Sun and time, terrain engine, older margin model):

```sh
node --test tests/*.mjs
```

Refresh the data (Python standard library only):

```sh
python3 tools/build_data.py
python3 tools/build_minerals.py
python3 tools/build_overlays.py
cd tools && python3 build_contours.py && python3 build_terrain.py && python3 build_rasters.py && python3 build_science.py
```

## Layout

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page: docked panes, neutral greys, colour only where it has a fixed meaning |
| `js/app.js` | Panels, events, and the plan / simulate / validate loop |
| `js/plan.js` | The plan: refuge, stations, legs, and the step list the simulation reads |
| `js/sim.js` | Walk simulation and flight rules; every constant with its value, tag and source |
| `js/sun.js` | Mars time, season, Sun position, sunrise and sunset (Mars24 algorithm) |
| `js/terrain.js`, `js/terrain.worker.js` | Elevation grid, slope, roughness, hillshade, cast shadow, line of sight, cost distance and path finding |
| `js/mapview.js` | Map, layer registry, presets, how the plan is drawn |
| `js/data.js` | Loads the grid and the science layers and wires them to layers, the probe and the rules |
| `js/model.js`, `js/photo.js` | Route helpers and the earlier margin model; the Navcam frame picker |
| `data/site.json`, `data/targets.json`, `data/rovers.json`, `data/minerals.json` | Rover route and stops, ready-made walks, rover positions, CheMin results |
| `data/terrain/` | Elevation grid: 1552 × 3200 cells of about 6 m, 16-bit, gzip |
| `data/layers/` | CRISM, THEMIS, DAN, APXS, ChemCam and space-weather files |
| `data/overlays/` | Relief lines, and the slope picture and loose-ground grid used before the elevation grid loads |
| `data/photos/` | One Curiosity Navcam frame for each boxwork stop; other stops load theirs from NASA |
| `tools/` | Scripts that rebuild every data file from NASA's public services |
| `vendor/` | Leaflet 1.9.4 (BSD-2-Clause); Inter and DM Mono (SIL Open Font License) |

## How the interface was designed

- **Colour has fixed meanings**, following NASA-STD-3001 Volume 2 (display standard): red warning, yellow caution, blue advisory, grey unavailable, cyan stale or missing data, magenta planned route, green selection. Alerts are filled fields with a class letter, never colour alone.
- **Routes are drawn the way rover planners draw drives**: named legs, stations with an arrival-tolerance circle, keep-out zones in red. Solid legs are on ground a rover has driven; dashed legs are on ground known only from orbit.
- **Units and time systems are always written out.** Coordinates are planetocentric latitude and east longitude.

## Known limits

- **Walking speed and effort on Mars in a suit have never been measured.** Speed against slope follows the function used in NASA/MIT's SEXTANT traverse planner (from Apollo data); effort follows Santee et al. 2001, scaled to NASA design values. Both are extrapolations and are tagged `ASSUMED`. The model makes climbs very slow.
- The elevation grid is good for relative height (slope, shadow, line of sight). It sits from a few metres to about 20 m off the rover's own elevations, and the service does not state its vertical datum.
- Slope is averaged over about 12 m, so short steep steps are understated. Paths found by the terrain engine turn in 45° steps and read up to 8% long.
- Sunrise and sunset assume a flat horizon. Cast shadows ignore ground outside the grid.
- Line of sight assumes a 3 m antenna at the refuge and a 1.8 m helmet height.
- Space weather is a snapshot of model forecasts, not a live feed and not a measurement at Mars.
- CRISM overlays were shifted 150 to 250 m to match the base map; expect 30 to 60 m of residual error. Their colours show which absorption bands are strong, not how much of a mineral is present.
- DAN water values end at sol 3333; ground south of that has none. Thermal inertia is a 100 m hint, not a footing map.
- Battery load and the usable share of the cooling-water tank are assumptions; no public figures were found.
- Rocks and sand at footstep scale away from the rover's track are not seen by any layer.

## Use of AI

Parts of this project's code and background research were produced with an AI coding assistant (Claude, by Anthropic). The project submission form describes how it was used.

## Licence and credits

Code: MIT, see `LICENSE`. Data and imagery: courtesy NASA/JPL-Caltech and the institutions named above.

This project is not affiliated with or endorsed by NASA.
