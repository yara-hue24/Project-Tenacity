# Project Tenacity

An EVA planner for walking on Mars: sketch a walk at Gale Crater, simulate it before it happens, and check it against flight rules. Built on real NASA data for the ground the Curiosity rover has explored.

Built for the NASA Space Apps Challenge 2026, "Interplanetary Survival Guide: Martian Map".

Live: https://yara-hue24.github.io/Project-Tenacity/

## The idea

Rover drivers at JPL plan every drive in a tool suite called RSVP: they sketch the drive on the terrain, simulate it, and validate it before sending it to Mars. Tenacity gives a walking astronaut the same loop. The comparison below is ours, drawn from JPL's description of the suite and from figures in a JPL paper on Perseverance drive planning (Rankin et al. 2023, linked in the app).

| Rover planners (RSVP) | Tenacity, for a walk |
|---|---|
| MobSketch: drive legs drawn on the map, with an activity list | Legs and stations on the map, with an activity list |
| RoSE: command sequence table and a status console | Sequence table (one row per walk, work or return step) and a console |
| SSim: predicts what a sequence will do before it is sent | Walk simulation: time, oxygen, CO₂, cooling water, battery, walk-home time |
| HyperDrive: terrain views, several clocks, playback | Terrain layers, a clock strip (UTC, Mars mean and true solar time, elapsed time), playback |
| ROCS: time, shadow, path-planning and terrain services | Mars time, Sun position, cast shadow, line of sight, path finding, in the browser |

The top bar always answers one question: **GO or NO-GO, by what margin, and which rule decides.**

## What you can do

- Take the **guided tour** (Help ▸ Guided tour): a blinking box points at each part of the screen in turn.
- Load a ready-made walk, or switch to **Sketch** and click the map to add stations anywhere.
- Choose how each leg is walked: along the rover's track, in a straight line, or on the easiest path the terrain engine can find under the slope limit.
- See **why a path was chosen**: ground that cannot be crossed is red, slow ground is yellow, and the straight line the path finder rejected is drawn dashed. The leg card gives the numbers.
- **Visualize path**: a 3D flyover of the real terrain with the route drawing itself along the ground, and Curiosity's own photo of each station as the camera arrives.
- Mark **keep-out zones**; path finding and the walk-home calculation go around them.
- Click any point to **probe** it: every layer is read at that point, shown or not, with its source tag.
- Leave **notes and marks** on the map (note, hazard, sample, photo point).
- **Save plans**, step back through the **history** of every change, undo and redo. Export and import everything as one file. Stored in the browser (IndexedDB).
- **Search** places, samples, targets, layers, rules, commands or coordinates (Ctrl+K).
- Play the plan back on the Mars clock; shadow and sunlight layers follow the playhead.
- Make the **workspace** yours: drag the gutters to resize docks, fold or hide panels, swap sides, pick a ready-made workspace (Windows menu). A large mode for gloves is in Settings.
- Every panel and term has an **i** button that explains it and links to sources.
- Print a wrist-sized **cuff card** of the plan.

## Flight rules

Every rule shows PASS, or a flag: `W` warning (blocks the walk), `C` caution, `A` advisory, `NE` not evaluated. A rule whose data are missing or too old is never counted as a pass, and a plan is not GO while the return-time, oxygen or slope rule is not evaluated. Until the terrain engine has loaded the verdict reads PROVISIONAL.

| Rule | Checks | Basis |
|---|---|---|
| FR-01 | At every moment the refuge is within 60 min at emergency pace | xEMU suit emergency return capability; Artemis III limits walking distance the same way |
| FR-02 | Oxygen left covers the emergency walk home plus a 30 min reserve | Apollo 15 planning memo (emergency walk-back at 1440 BTU/h) |
| FR-03 | Back before sunset, with the reserve | Mars24 algorithm for the season at the refuge |
| FR-04 | Slope within the 20° suit limit, up, down or across: the steeper of the slope along the path and the slope of the ground itself, at every point | Artemis suit requirement ("up, down, across a 20-degree slope") |
| FR-05 | Ground driven by a rover; legs on ground known only from orbit are flagged | Our rule |
| FR-06 | Line of sight to the refuge | Computed from the elevation grid |
| FR-07 | Walk no longer than 8 h | Suit requirement |
| FR-08, FR-09 | Battery and cooling water cover the walk home plus reserve | xEMU capacities; battery load is assumed |
| FR-10 | No solar eruption forecast to reach Mars within 2 days; a glancing blow is a caution; forecasts older than 48 h are "not evaluated" | NASA DONKI WSA-Enlil forecasts, live when the service answers, else a stored snapshot |
| FR-11 | Loose ground on the route | THEMIS thermal inertia |
| FR-12 | Route stays out of keep-out zones | Zones set by the crew |
| FR-13 | Buddy rule: at least two crew on the walk | NASA plans surface walks in pairs |
| FR-14 | Slow-pace case: the timed rules must still hold when walking is 1.375 times slower | The slow end of the tool's own duration range (Apollo traverse average) |
| FR-15 | Pace on slopes: flags walks that spend long on slopes where the speed model crawls | Our rule, about the model's own limits |

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
| Science regions | The named regions on Curiosity's route up Mount Sharp, with what a crew would see there; the USGS global geologic unit | NASA's "Proposed Path up Mount Sharp" map and mission papers (published sol ranges); USGS SIM 3292 |
| Reach | Walk-home time to the refuge, suit-failure return limit, walking difficulty (what the path finder avoids) | Computed from the elevation grid and the walking model |
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
cd tools && python3 build_contours.py && python3 build_terrain.py && python3 build_rasters.py && python3 build_science.py && python3 build_regions.py
```

## Layout

| Path | What it is |
|---|---|
| `index.html`, `css/style.css` | The page: docked panes, neutral greys, colour only where it has a fixed meaning |
| `js/app.js` | Panels, events, and the plan / simulate / validate loop |
| `js/features.js`, `js/ui.js`, `js/info.js` | Menus, undo and history, saved plans, notes, search, settings, the guided tour, the locator, the path visualisation; dialogs and the resizable workspace; the text behind every information button |
| `js/store.js` | Browser database (IndexedDB) for saved plans, history and notes |
| `js/view3d.js` | 3D terrain view in plain WebGL for the path visualisation |
| `js/plan.js` | The plan: refuge, stations, legs, and the step list the simulation reads |
| `js/sim.js` | Walk simulation and flight rules; every constant with its value, tag and source |
| `js/sun.js` | Mars time, season, Sun position, sunrise and sunset (Mars24 algorithm) |
| `js/terrain.js`, `js/terrain.worker.js` | Elevation grid, slope, roughness, hillshade, cast shadow, line of sight, cost distance and path finding |
| `js/mapview.js` | Map, layer registry, presets, how the plan is drawn |
| `js/data.js` | Loads the grid and the science layers and wires them to layers, the probe and the rules |
| `js/model.js`, `js/photo.js` | Route helpers and the earlier margin model; the Navcam frame picker |
| `data/site.json`, `data/targets.json`, `data/rovers.json`, `data/minerals.json` | Rover route and stops, ready-made walks, rover positions, CheMin results |
| `data/terrain/` | Elevation grid: 1552 × 3200 cells of about 6 m, 16-bit, gzip |
| `data/layers/` | CRISM, THEMIS, DAN, APXS, ChemCam, science regions, geology and space-weather files |
| `data/overlays/` | Relief lines, and the slope picture and loose-ground grid used before the elevation grid loads |
| `data/photos/` | One Curiosity Navcam frame for each boxwork stop; other stops load theirs from NASA |
| `tools/` | Scripts that rebuild every data file from NASA's public services |
| `vendor/` | Leaflet 1.9.4 (BSD-2-Clause); Inter and DM Mono (SIL Open Font License) |

## How the interface was designed

- **Alert colours have fixed meanings**, following NASA-STD-3001 Volume 2 (display standard): red warning, yellow caution, light blue advisory, grey unavailable, cyan stale or missing data, magenta planned route, green probe and selection on the map. Alerts are filled fields with a class letter, never colour alone.
- **The panels follow professional creative tools**: dark neutral docks separated by thin gutters you can drag, collapsible sections, a menu bar. The interface accent (blue) marks focus, primary actions and things you can adjust. Segoe UI is used where the system has it; Inter is the bundled fallback.
- **Routes are drawn the way rover planners draw drives**: named legs, stations with an arrival-tolerance circle, keep-out zones in red. Solid legs are on ground a rover has driven; dashed legs are on ground known only from orbit.
- **Units and time systems are always written out.** Coordinates are planetocentric latitude and east longitude.

## Known limits

- **Walking speed and effort on Mars in a suit have never been measured.** Speed against slope follows the function used in NASA/MIT's SEXTANT traverse planner (from Apollo data); effort follows Santee et al. 2001, scaled to NASA design values. Both are extrapolations; walking speed is tagged `ASSUMED`. The model makes climbs very slow: about 0.5 km/h at +10° and 0.1 km/h near +20°. FR-15 flags walks that depend on those numbers.
- The emergency walk home assumes an able walker at the emergency pace set in INCONS (never faster than the planned walking speed). An injured crew member is not modelled.
- The plan has no date of its own: Sun, season and space weather are those of the day the tool is opened.
- Path finding gives up after two hours of walking for one leg, and the walk-home field is computed out to three hours; beyond those the tool says so and does not clear the plan.
- No dust-storm, thermal or solar-particle dose model. Radiation is the routine surface rate only.
- The elevation grid is good for relative height (slope, shadow, line of sight). It sits from a few metres to about 20 m off the rover's own elevations, and the service does not state its vertical datum.
- Slope is averaged over about 12 m, so short steep steps are understated. Paths found by the terrain engine turn in 45° steps and read up to 8% long.
- Sunrise and sunset assume a flat horizon. Cast shadows ignore ground outside the grid.
- Line of sight assumes a 3 m antenna at the refuge and a 1.8 m helmet height.
- Space weather is model forecasts, not a measurement at Mars. NASA's public demonstration key allows few requests, so the live read can fail; the stored snapshot is then used, and once it is older than 48 hours the rule reads "not evaluated".
- CRISM overlays were shifted 150 to 250 m to match the base map; expect 30 to 60 m of residual error. Their colours show which absorption bands are strong, not how much of a mineral is present.
- DAN water values end at sol 3333; ground south of that has none. Thermal inertia is a 100 m hint, not a footing map.
- Battery load is an assumption; no public figure was found. Usable cooling water is taken as 8.5 lb of the 10 lb tank, read from the xEMU schematic.
- Rocks and sand at footstep scale away from the rover's track are not seen by any layer.
- The planner assumes the crew always knows where it is. Mars has no satellite navigation; NASA's Perseverance rover fixes its own position to about 25 cm by matching camera panoramas to orbital maps (JPL, 2026), and a crew would need the same kind of system. Position error is not modelled.
- The 3D view is the elevation model draped with HiRISE imagery (or shaded by its own relief when the imagery cannot be fetched), with heights exaggerated 1.5 times. Science-region extents on the track come from published sol ranges and are approximate where the README of `data/layers/regions.json` says so.
- Saved plans, notes and history live in this browser only. Clearing site data removes them; use File ▸ Export to keep a copy.

## Use of AI

Parts of this project's code and background research were produced with an AI coding assistant (Claude, by Anthropic). The project submission form describes how it was used.

## Licence and credits

Code: MIT, see `LICENSE`. Data and imagery: courtesy NASA/JPL-Caltech and the institutions named above.

This project is not affiliated with or endorsed by NASA.
