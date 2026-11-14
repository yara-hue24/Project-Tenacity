#!/usr/bin/env python3
"""Bake two small context layers for the browser.

  data/layers/regions.json   named science regions along Curiosity's route up Mount Sharp, each with the
                             colour NASA used for it on its annotated route map (PIA23179), a sol range taken
                             from a published source, and the stretch of rover track (chain_m) that sol range
                             or DAN member name corresponds to. Also a table of the DAN stratigraphic members.
  data/layers/geology.json   the units of the USGS global geologic map of Mars (SIM 3292, 1:20,000,000) that
                             fall inside a box around the track, clipped and thinned.

What is typed in by hand and what is computed:
  * Typed in: region names, the plain-language text, the sol ranges and their citations, and the colours
    (sampled once from NASA's annotated image; the method is described in regions.json "colour_method").
    Each sol range carries a "confidence" label saying what kind of source supports it.
  * Computed here: every chain_m value (from the sols of the rover stops in data/site.json, or from the first
    and last DAN point of a member in data/layers/dan.json), the member table, the cross-check of which DAN
    members lie inside each region, and all the geology geometry.
Nothing is extended beyond its source: a region whose limits no source supports gets null, not a guess.

The geology download is cached under tools/.cache/regions/ (git-ignored), so a second run needs no network.
Run after build_data.py and build_science.py:   python3 tools/build_regions.py
Options:   --only regions,geology    rebuild a subset
           --refresh                 download the geology again instead of using the cache
Only the Python standard library is used.
"""
import argparse
import datetime
import json
import re
import sys
import urllib.parse
import urllib.request
from collections import Counter
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "tools" / ".cache" / "regions"
OUT = ROOT / "data" / "layers"
UA = "data-snapshot/1.0 (python-urllib)"          # generic on purpose: no personal or project name
MAX_BYTES = 40 * 1024 * 1024

# ---------------------------------------------------------------------------------------------------------
# Sources (every URL below was opened and read when this table was written, 2026-11-14)
# ---------------------------------------------------------------------------------------------------------
S_PIA23179 = {"title": "NASA Science, 'Curiosity's Proposed Path up Mount Sharp' (PIA23179, 15 May 2019)",
              "url": "https://science.nasa.gov/resource/curiositys-proposed-path-up-mount-sharp/"}
S_FLYOVER = {"title": "NASA/JPL video with transcript, 'NASA's Curiosity Finds Climate Clues on a Martian Mountain' (15 May 2019)",
             "url": "https://www.jpl.nasa.gov/videos/nasas-curiosity-finds-climate-clues-on-a-martian-mountain/"}
S_PIA26042 = {"title": "NASA/JPL, 'Curiosity's Path to Gediz Vallis Ridge and Beyond' (PIA26042, 18 Sept 2023)",
              "url": "https://www.jpl.nasa.gov/images/pia26042-curiositys-path-to-gediz-vallis-ridge-and-beyond/"}
S_VASAVADA14 = {"title": "Vasavada et al. 2014, JGR Planets 119, 'Overview of the Mars Science Laboratory mission: Bradbury Landing to Yellowknife Bay and beyond' (abstract: 'On sol 324, the mission turned its focus southwest')",
                "url": "https://doi.org/10.1002/2014JE004622"}
S_YKB_ENTRY = {"title": "NASA Photojournal PIA16447, 'Looking Back at Entry into Yellowknife Bay' ('The Sol 125 drive entered Yellowknife Bay')",
               "url": "https://science.nasa.gov/photojournal/looking-back-at-entry-into-yellowknife-bay/"}
S_GROTZINGER14 = {"title": "Grotzinger et al. 2014, Science 343, 'A Habitable Fluvio-Lacustrine Environment at Yellowknife Bay, Gale Crater, Mars'",
                  "url": "https://doi.org/10.1126/science.1242777"}
S_PAHRUMP = {"title": "NASA Photojournal PIA19148, 'Curiosity Heading Away from Pahrump Hills' (route Sol 751 to Sol 903; sample delivered Sol 922, 11 March 2015)",
             "url": "https://science.nasa.gov/photojournal/curiosity-heading-away-from-pahrump-hills/"}
S_VASAVADA22 = {"title": "Vasavada 2022, Space Science Reviews 218:14, 'Mission Overview and Scientific Contributions from the Mars Science Laboratory Curiosity Rover After Eight Years of Surface Operations'",
                "url": "https://doi.org/10.1007/s11214-022-00882-7"}
S_EWING17 = {"title": "Ewing et al. 2017, JGR Planets 122, 'Sedimentary processes of the Bagnold Dunes' (dated images Sol 1173 to Sol 1221)",
             "url": "https://doi.org/10.1002/2017JE005324"}
S_LAPOTRE18 = {"title": "Lapotre & Rampe 2018, GRL 45, 'Curiosity's Investigation of the Bagnold Dunes, Gale Crater: Overview of the Two-Phase Scientific Campaign'",
               "url": "https://doi.org/10.1029/2018GL079032"}
S_PIA21269 = {"title": "NASA Photojournal PIA21269, 'Curiosity's Bagnold Dunes Campaign: Two Types of Dunes'",
              "url": "https://science.nasa.gov/photojournal/curiositys-bagnold-dunes-campaign-two-types-of-dunes/"}
S_JOHNSON18 = {"title": "Johnson et al. 2018, GSA Annual Meeting abstract 317770 (Bagnold Dunes Phase 2 sand observations 'during Sols 1601-1653')",
               "url": "https://gsa.confex.com/gsa/2018AM/webprogram/Paper317770.html"}
S_MURRAY_BUTTES = {"title": "NASA/JPL news, 'NASA's Curiosity Rover Begins Next Mars Chapter' (3 Oct 2016; Murray Buttes images dated 18 Aug to 4 Sept 2016, Quela drilled 18 Sept 2016)",
                   "url": "https://www.jpl.nasa.gov/news/nasas-curiosity-rover-begins-next-mars-chapter/"}
S_FRAEMAN20 = {"title": "Fraeman et al. 2020, JGR Planets 125, 'Evidence for a Diagenetic Origin of Vera Rubin Ridge' (campaign Sols 1726-2302; on the ridge from Sol 1809)",
               "url": "https://doi.org/10.1029/2020JE006527"}
S_BENNETT23 = {"title": "Bennett et al. 2023, JGR Planets 128, 'The Curiosity Rover's Exploration of Glen Torridon, Gale Crater, Mars: An Overview of the Campaign and Scientific Results' (sols 2300-3072; pediment sols 2691-2734)",
               "url": "https://doi.org/10.1029/2022JE007185"}
S_SALTY = {"title": "NASA news, 'NASA's Curiosity Mars Rover Reaches Long-Awaited Salty Region' (19 Oct 2022; panorama in the pass on Sol 3572)",
           "url": "https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/nasas-curiosity-mars-rover-reaches-long-awaited-salty-region/"}
S_SEEGER24 = {"title": "Seeger & Grotzinger 2024, JGR Planets 129, 'Diagenesis of the Clay-Sulfate Stratigraphic Transition, Mount Sharp Group, Gale Crater, Mars' (sols 2904-3627, ending at the Canaima drill target in the sulfate-bearing unit)",
              "url": "https://doi.org/10.1029/2024JE008531"}
S_BLOG5016 = {"title": "NASA Curiosity blog, Sols 5016-5021 (planning date 18 Sept 2026: 'our recent sulfate unit workspaces')",
              "url": "https://science.nasa.gov/blog/curiosity-blog-sols-5016-5021-fantastic-minerals-and-how-to-detect-them/"}
S_PIA26019 = {"title": "NASA Photojournal PIA26019, 'Curiosity Views Gediz Vallis Ridge' (reached 14 Aug 2023, stayed 11 days)",
              "url": "https://science.nasa.gov/photojournal/curiosity-views-gediz-vallis-ridge/"}
S_GVC_BEGIN = {"title": "NASA news, 'NASA's Curiosity Searches for New Clues About Mars' Ancient Water' (29 March 2024; panorama after arriving at the channel, 3 Feb 2024)",
               "url": "https://www.nasa.gov/missions/mars-science-laboratory/curiosity-rover/nasas-curiosity-searches-for-new-clues-about-mars-ancient-water/"}
S_GVC_LAST = {"title": "NASA/JPL news, 'NASA's Curiosity Mars Rover Takes a Last Look at Mysterious Sulfur' (18 Nov 2024)",
              "url": "https://www.jpl.nasa.gov/news/nasas-curiosity-mars-rover-takes-a-last-look-at-mysterious-sulfur/"}
S_GVC_EXIT = {"title": "NASA Curiosity blog, 'Sols 4321-4322: Sailing Out of Gediz Vallis' (planning date 30 Sept 2024)",
              "url": "https://science.nasa.gov/blog/sols-4321-4322-sailing-out-of-gediz-vallis/"}
S_BOX_PHASES = {"title": "NASA Curiosity blog, Sols 4804-4811 (lists the boxwork campaign phases: phase 1 sols 4534-4570, phase 2 4571-4599, phase 3 4600-4805, phase 4 from 4805)",
                "url": "https://science.nasa.gov/blog/curiosity-blog-sols-4804-4811-kicking-off-the-final-phase-of-boxwork-exploration/"}
S_BOX_BYE = {"title": "NASA Curiosity blog, 'Sols 4845-4851: Bye-Bye Boxwork, Bye-Bye' (the drive in the sols 4842-4844 plan crossed the southern contact of the boxwork terrain)",
             "url": "https://science.nasa.gov/blog/curiosity-blog-sols-4845-4851-bye-bye-boxwork-bye-bye/"}
S_DAN = {"title": "Nikiforov, Djachkova & Lisov 2022, DAN pixel table to sol 3333 (member names), Zenodo 6974535",
         "url": "https://doi.org/10.5281/zenodo.6974535"}

# Confidence labels. The first four are the ones asked for; the fifth is a weaker kind of support that
# needed its own honest name.
C_PUBLISHED = "published sol range"
C_DAN = "from DAN member names"
C_BLOG = "approximate, from mission blog dates"
C_OBS = "approximate, from sols of dated observations in published papers"
C_UNKNOWN = "unknown"

# Colours sampled from frame 7 of the 12-frame GIF on the PIA23179 page (the fully annotated frame).
# Each tint is laid over shaded terrain, so it is a range of shades; the value kept is the most common
# strongly saturated colour inside the labelled area.
COL_CLAY = "#338902"       # green
COL_PEDIMENT = "#027b65"   # teal
COL_RIDGE = "#982d29"      # red
COL_SULFATE = "#d39100"    # gold

# A region's extent is given EITHER as sols (looked up in data/site.json) OR as DAN members.
REGIONS = [
    {
        "id": "bradbury_plains",
        "name": "Bradbury Rise and the crater-floor plains",
        "what_to_see": "The plain crossed from the landing site to the foot of Mount Sharp, with many outcrops of pebble conglomerate: rounded pebbles cemented into rock.",
        "why_it_matters": "Pebbles are rounded and laid down like this by flowing water, so these outcrops are ground evidence that streams once crossed the floor of Gale Crater.",
        "colour": "none",
        "sol_range": None,
        "dan_span": {"first_of": "Bradbury", "last_before_first_of": "Murray / Pahrump Hills"},
        "confidence": C_DAN,
        "range_note": "From the first DAN point labelled Bradbury to the last one before the first point labelled Murray / Pahrump Hills. Bradbury labels continue beyond this, mixed with Pahrump Hills and Stimson points, up to the chain given in the members table.",
        "sources": [S_VASAVADA14, S_DAN],
    },
    {
        "id": "yellowknife_bay",
        "name": "Yellowknife Bay",
        "what_to_see": "A shallow basin entered by a step down of about half a metre from the surrounding plain, floored by fine-grained mudstone.",
        "why_it_matters": "The mission's first drilled rock samples came from here. They are the mud of an ancient lake whose water was neither too acidic nor too salty for microbes.",
        "colour": "none",
        "sol_range": [125, 324],
        "confidence": C_PUBLISHED,
        "range_note": "Entry on Sol 125 is from the NASA image caption; Sol 324 is when the mission 'turned its focus southwest' (Vasavada et al. 2014). The DAN points labelled Sheepbed (the Yellowknife Bay mudstone) fall inside this stretch.",
        "sources": [S_YKB_ENTRY, S_VASAVADA14, S_GROTZINGER14],
    },
    {
        "id": "pahrump_hills",
        "name": "Pahrump Hills",
        "what_to_see": "A pale outcrop of very finely layered mudstone on a short slope, the first bedrock of Mount Sharp itself that the rover reached.",
        "why_it_matters": "These thin layers are lake-bed mud at the base of the mountain, the start of the long layered record the rest of the climb reads upward.",
        "colour": "none",
        "sol_range": [751, 922],
        "confidence": C_PUBLISHED,
        "range_note": "NASA maps the route driven here from Sol 751 to Sol 903 and says the rover was still at the Sol 903 spot on Sol 922. The same caption gives the first drive away as 'Sol 933 (March 12, 2015)'; that date is Sol 923, so 922 is used as the last sol here.",
        "sources": [S_PAHRUMP, S_VASAVADA22],
    },
    {
        "id": "bagnold_dunes_phase1",
        "name": "Bagnold Dunes, first visit (Namib and High Dune)",
        "what_to_see": "Dark, active crescent-shaped sand dunes with a steep downwind face and metre-scale ripples on their backs. The sand is loose: a place to walk around, not across.",
        "why_it_matters": "The first active dune field studied up close on another planet. It shows how wind moves sand in the thin Martian air today.",
        "colour": "none",
        "sol_range": [1173, 1231],
        "confidence": C_OBS,
        "range_note": "No campaign sol range was found in a source that could be opened. These are the earliest and latest dated dune observations found: Mastcam at High Dune on Sol 1173 (Ewing et al. 2017) and the third Gobabeb scoop on Sol 1231 (Vasavada 2022, scoop table). The published description is by date only: 'late 2015 and early 2016' (NASA), 'November 2015' onward (Lapotre & Rampe 2018). The real visit is somewhat longer than this range.",
        "sources": [S_EWING17, S_VASAVADA22, S_LAPOTRE18, S_PIA21269],
    },
    {
        "id": "murray_buttes",
        "name": "Murray Buttes",
        "what_to_see": "Flat-topped buttes and mesas standing up to about 12 metres above the plain and tens of metres apart.",
        "why_it_matters": "The ground between the buttes is Murray formation mudstone, mud that settled in ancient lakes, and the rover drilled it here. For a walker the buttes are steep-sided obstacles to route between.",
        "colour": "none",
        "sol_range": [1434, 1464],
        "confidence": C_BLOG,
        "range_note": "Converted from dates in a NASA release: the earliest dated image from inside the buttes (18 Aug 2016) and the Quela drill at the last butte (18 Sept 2016). The rover entered the buttes somewhat before the first of these, so the true stretch is a little longer at its start.",
        "sources": [S_MURRAY_BUTTES],
    },
    {
        "id": "bagnold_dunes_phase2",
        "name": "Bagnold Dunes, second visit (Nathan Bridges Dune)",
        "what_to_see": "A long, straight dune of dark sand and a field of ripples along the southern margin of the dune belt, visited in the windy season.",
        "why_it_matters": "A second dune shape in a second season, so the two visits together show how the same sand behaves under different winds.",
        "colour": "none",
        "sol_range": [1601, 1653],
        "confidence": C_PUBLISHED,
        "range_note": "From a conference abstract that reports the phase 2 sand observations 'during Sols 1601-1653'. It is the span of those observations, which is close to but not formally the campaign's limits. NASA dates the start of phase 2 to February 2017.",
        "sources": [S_JOHNSON18, S_LAPOTRE18, S_PIA21269],
    },
    {
        "id": "vera_rubin_ridge",
        "name": "Vera Rubin Ridge (hematite ridge)",
        "what_to_see": "A long, hard ridge standing above the slope below it, steep on the side the rover approached from, with red bedrock crossed by metre-scale fractures and scattered grey patches near the top.",
        "why_it_matters": "Orbiters saw the iron mineral hematite here. On the ground it proved to be lake mudstone hardened later by groundwater, which is why it resisted the wind and stands up as a ridge.",
        "colour": "none",
        "sol_range": [1809, 2302],
        "confidence": C_PUBLISHED,
        "range_note": "The paper gives the whole campaign as Sols 1726-2302, of which Sols 1726-1808 were imaging the ridge from below while driving along its base. Sol 1809 is the first sol of work on the ridge itself, so that is the start used here.",
        "sources": [S_FRAEMAN20],
    },
    {
        "id": "glen_torridon",
        "name": "Glen Torridon (clay-bearing unit)",
        "what_to_see": "A broad shallow trough between Vera Rubin Ridge and the pediment cliff: rubbly, pebbly ground with low straight ridges, three buttes and a sheet of dark sand about 235 metres across.",
        "why_it_matters": "The strongest clay signal seen from orbit on the route. Clay forms where water soaks rock for a long time, and clay is good at preserving organic molecules.",
        "colour": COL_CLAY,
        "sol_range": [2300, 3072],
        "confidence": C_PUBLISHED,
        "range_note": "Stated as sols 2300-3072 (January 2019 to January 2021). The pediment visit below falls inside this range.",
        "sources": [S_BENNETT23, S_PIA23179, S_FLYOVER],
    },
    {
        "id": "greenheugh_pediment",
        "name": "Greenheugh Pediment (first ascent, north edge)",
        "what_to_see": "A gently sloping bench capped by hard, cross-layered sandstone, ending in a cliff. The rover reached the top by a slope that tilted it 32 degrees. Farther in, the cap weathers into sharp-edged 'gator-back' ridges.",
        "why_it_matters": "A younger sheet of ancient dune sand lying across the older clay and sulfate layers. For a walker it is a cliff edge and, beyond it, ground rough enough that the rover turned back in 2022.",
        "colour": COL_PEDIMENT,
        "sol_range": [2691, 2734],
        "confidence": C_PUBLISHED,
        "range_note": "Only the first visit to the northern edge (sol 2691 to sol 2734). The 2022 attempt to cross the pediment farther south is described by NASA by date only and is not given a range here. NASA's 2023 map (PIA26042) shows how far the pediment extends; this file does not.",
        "sources": [S_BENNETT23, S_PIA23179, S_PIA26042],
    },
    {
        "id": "sulfate_bearing_unit",
        "name": "Sulfate-bearing unit (layered sulfates)",
        "what_to_see": "Layered hills and cliffs above the clay unit, with finely layered bedrock, small 'popcorn' nodules and salt minerals.",
        "why_it_matters": "Sulfate salts are left behind as water dries up, so these layers record Mars turning from wetter to drier. It is also the highest ground on the track.",
        "colour": COL_SULFATE,
        "sol_range": [3572, 5016],
        "confidence": C_BLOG,
        "range_note": "Start: NASA shows the rover still in the sand-lined pass on Sol 3572 and says it then 'arrived in the sulfate-bearing unit'; the Canaima sample (about Sol 3612) is described in a paper as inside the unit. So the true start lies between Sol 3572 and about Sol 3612, roughly 110 m of track. End: Sol 5016 is the latest NASA blog found that places the rover in the sulfate unit. The track in this app runs on to a later sol; nothing read here says the rover has left the unit, but nothing confirms it either. The Gediz Vallis ridge and channel and the boxwork all lie inside this range. Below it, sols 2904-3627 are treated in one paper as a gradual clay-to-sulfate transition.",
        "sources": [S_SALTY, S_SEEGER24, S_BLOG5016, S_PIA23179, S_PIA26042],
    },
    {
        "id": "gediz_vallis_ridge",
        "name": "Gediz Vallis Ridge",
        "what_to_see": "A tall ridge built of dark boulders and rubble lying on the layered sulfate bedrock, with steep sides that the rover slid on.",
        "why_it_matters": "The rubble was carried down from higher on Mount Sharp by ancient debris flows, so it is a sample of layers nobody on this route will reach, and a mark of one of the last wet episodes here.",
        "colour": COL_RIDGE,
        "sol_range": [3918, 3928],
        "confidence": C_BLOG,
        "range_note": "Converted from NASA's dates, 14 to 25 August 2023 (an 11-day stay). The NASA caption calls 14 August 'the 3,923rd sol', but by NASA's own date and sol pairs elsewhere Sol 3923 is 19 August, the day the panorama was taken; 14 August is about Sol 3918. The rover stood at the upper end of the ridge; the ridge itself runs far downhill from this spot.",
        "sources": [S_PIA26019, S_PIA26042, S_PIA23179],
    },
    {
        "id": "gediz_vallis_channel",
        "name": "Gediz Vallis Channel",
        "what_to_see": "A winding, steep-sided valley cut into the layered bedrock and partly filled with boulders and mounds of debris, with a patch of bright white stones of pure sulfur on its floor.",
        "why_it_matters": "It was cut after the layers around it had formed, so water still ran here late, when the climate was already drying. Its steep sides and bouldery fill make slow going.",
        "colour": "none",
        "sol_range": [4086, 4318],
        "confidence": C_BLOG,
        "range_note": "Converted from dates: a panorama taken 'after arriving at Gediz Vallis channel' on 3 February 2024, and the weekend of 28-29 September 2024, when the blog says the rover finished work 'while departing the channel'. On NASA's 2019 map the channel has no colour, only a white dashed outline and a label.",
        "sources": [S_GVC_BEGIN, S_GVC_LAST, S_GVC_EXIT, S_PIA23179, S_FLYOVER],
    },
    {
        "id": "boxwork",
        "name": "Boxwork unit",
        "what_to_see": "A web of low, hard ridges enclosing hollows, like a spider's web seen from above, spread over a wide shoulder of the mountain.",
        "why_it_matters": "The ridges are thought to be cracks that groundwater filled with minerals, later left standing when softer rock eroded away: a sign of water moving underground late in the mountain's history.",
        "colour": "none",
        "sol_range": [4534, 4844],
        "confidence": C_PUBLISHED,
        "range_note": "Start is the first sol of phase 1 of the campaign as listed by the mission blog. End is the last sol of the plan whose drive took the rover 'just over the southernmost contact of the boxwork terrain' (sols 4842-4844). The blog notes this was the third crossing of that contact, so the boundary is touched more than once inside the range.",
        "sources": [S_BOX_PHASES, S_BOX_BYE, S_GVC_LAST],
    },
]

NASA_MAP = {
    "title": "Curiosity's Proposed Path up Mount Sharp (PIA23179)",
    "page": S_PIA23179["url"],
    "image": "https://assets.science.nasa.gov/content/dam/science/psd/mars/resources/detail_files/2/22472_PIA23179-combo-rev_main.gif",
    "date": "2019-05-15",
    "credit": "NASA/JPL-Caltech/ESA/University of Arizona/JHUAPL/MSSS/USGS Astrogeology Science Center",
    "view": "Oblique perspective view, not a top-down map: orbital imagery draped over a terrain model, looking roughly south-east up the lower slopes of Mount Sharp, with sky at the top. No scale bar, no north arrow and no stated vertical exaggeration.",
    "animation": "A 1041 x 586 GIF of 12 frames: the plain terrain with the route holds for 2 s, five frames fade the tints in, the fully labelled frame holds for 4 s, five frames fade out.",
    "route_style": "One thin solid white line (sampled #f5f1ee), the same for ground already driven and for the proposed route; it ends in a short white dashed outline around Gediz Vallis Channel.",
    "labels": [
        {"label": "Clay-Bearing Unit", "colour": COL_CLAY, "colour_name": "green", "region_id": "glen_torridon"},
        {"label": "Greenheugh Pediment", "colour": COL_PEDIMENT, "colour_name": "teal", "region_id": "greenheugh_pediment"},
        {"label": "Gediz Vallis Ridge", "colour": COL_RIDGE, "colour_name": "red", "region_id": "gediz_vallis_ridge"},
        {"label": "Sulfate-Bearing Unit", "colour": COL_SULFATE, "colour_name": "gold", "region_id": "sulfate_bearing_unit"},
        {"label": "Gediz Vallis Channel", "colour": "none", "colour_name": "white dashed outline, no fill", "region_id": "gediz_vallis_channel"},
    ],
    "colour_method": "Sampled from the fully annotated frame (frame 7 of 12). Each tint is semi-transparent over shaded terrain, so it is really a range of shades; the hex kept is the most common strongly saturated colour inside the labelled area. Label text is white italic.",
    "other_nasa_colourings": "NASA's 2023 version of the same view (PIA26042) keeps gold for the sulfate-bearing unit, red for Gediz Vallis Ridge and teal for Greenheugh Pediment (its caption calls it green). The May 2019 narrated video uses green for the 'Clay Unit' but orange-red (about #9f2e11) for the 'Sulfate Unit', so NASA's colours are a convention of each graphic, not a standard.",
}

# NASA states these date and sol pairs in the pages cited above; they calibrate the date conversion.
DATE_SOL_ANCHORS = [("2012-12-12", 125), ("2014-09-16", 751), ("2015-02-19", 903), ("2015-03-11", 922),
                    ("2022-08-23", 3572), ("2024-09-21", 4311), ("2024-11-02", 4352)]
DATE_DERIVED = {            # region id -> the two Earth dates its sol range was converted from
    "murray_buttes": ("2016-08-18", "2016-09-18"),
    "gediz_vallis_ridge": ("2023-08-14", "2023-08-25"),
    "gediz_vallis_channel": ("2024-02-03", "2024-09-28"),
}
SOL_DAYS = 1.02749125       # length of a Mars solar day in Earth days


def sol_from_date(iso):
    """Sol number for an Earth date (UTC), good to about one sol. The 0.8 offset reproduces five of the seven
    NASA pairs in DATE_SOL_ANCHORS exactly and the other two to within one sol (a sol does not line up with a
    UTC calendar day, so one sol of slack is unavoidable)."""
    days = (datetime.date.fromisoformat(iso) - datetime.date(2012, 8, 6)).days
    return int(days / SOL_DAYS + 0.8)


# ---------------------------------------------------------------------------------------------------------
# Geology source
# ---------------------------------------------------------------------------------------------------------
GEO_SERVICE = ("https://services.arcgis.com/v01gqwM5QqNysAAi/arcgis/rest/services/"
               "Tanaka_et_al_2014_Mars_Global_Map_Features/FeatureServer")
GEO_LAYER = GEO_SERVICE + "/3"                       # Global_Geology (polygons)
GEO_PUB = "https://pubs.usgs.gov/sim/3292/"
GEO_CITATION = ("Tanaka, K.L., Skinner, J.A., Jr., Dohm, J.M., Irwin, R.P., III, Kolb, E.J., Fortezzo, C.M., "
                "Platz, T., Michael, G.G., and Hare, T.M., 2014, Geologic map of Mars: U.S. Geological Survey "
                "Scientific Investigations Map 3292, scale 1:20,000,000, https://doi.org/10.3133/sim3292")
# The service stores coordinates in a Robinson projection on the Mars sphere. Giving it this geographic
# system as inSR and outSR makes it answer in plain longitude and latitude (east-positive, planetocentric).
GCS_MARS = ('GEOGCS["GCS_Mars_2000_Sphere",DATUM["D_Mars_2000_Sphere",SPHEROID["Mars_2000_Sphere_IAU_IAG",'
            '3396190.0,0.0]],PRIMEM["Reference_Meridian",0.0],UNIT["Degree",0.0174532925199433]]')
CORE_BOX = (137.32, -4.88, 137.48, -4.55)            # west, south, east, north: the area the walk planner covers
PAD_DEG = 0.5
SIMPLIFY_DEG = 0.0005                                 # about 30 m on the ground, far finer than the map itself
TEST_POINT = (137.40, -4.70)
MARS_RADIUS_M = 3396190.0


def fetch(url, rel, force=False, timeout=120):
    path = CACHE / rel
    if path.exists() and not force:
        return path.read_bytes()
    req = urllib.request.Request(url, headers={"User-Agent": UA, "Accept": "*/*"})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        data = r.read(MAX_BYTES + 1)
    if len(data) > MAX_BYTES:
        raise RuntimeError("download larger than the 40 MB limit: " + url)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return data


def write_json(name, obj):
    path = OUT / name
    text = json.dumps(obj, ensure_ascii=False, separators=(",", ":"))
    path.write_text(text + "\n", encoding="utf-8")
    print(f"  wrote {path.relative_to(ROOT)}  {path.stat().st_size / 1024:.1f} KB")
    return path.stat().st_size


def now_utc():
    return datetime.datetime.now(datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


# ---------------------------------------------------------------------------------------------------------
# Regions
# ---------------------------------------------------------------------------------------------------------
def chain_for_sols(stops, a, b):
    """Stretch of track the rover occupied from sol a to sol b: where it stood on sol a (the last stop with
    sol <= a) through every stop up to sol b. Returns (lo, hi, n_stops, first_sol_used, last_sol_used)."""
    before = [s for s in stops if s["sol"] <= a]
    start = before[-1] if before else stops[0]
    inside = [s for s in stops if a < s["sol"] <= b]
    group = [start] + inside
    chains = [s["chain_m"] for s in group]
    return round(min(chains), 1), round(max(chains), 1), len(group), group[0]["sol"], group[-1]["sol"]


def member_table(dan):
    fields, names = dan["fields"], dan["members"]
    mi, ci = fields.index("member_index"), fields.index("chain_m")
    pts = sorted(((p[ci], p[mi]) for p in dan["points"] if p[mi] is not None), key=lambda t: t[0])
    runs = []                                   # consecutive points with the same member, along the track
    for chain, m in pts:
        if runs and runs[-1][0] == m:
            runs[-1][2] = chain
            runs[-1][3] += 1
        else:
            runs.append([m, chain, chain, 1])
    table = []
    for idx, name in enumerate(names):
        mine = [c for c, m in pts if m == idx]
        if not mine:
            table.append({"index": idx, "name": name, "chain_range_m": None, "n_points": 0, "runs": [],
                          "interleaved_with": []})
            continue
        lo, hi = min(mine), max(mine)
        others = Counter(names[m] for c, m in pts if lo <= c <= hi and m != idx)
        table.append({
            "index": idx,
            "name": name,
            "chain_range_m": [round(lo, 1), round(hi, 1)],
            "n_points": len(mine),
            "runs": [[round(r[1], 1), round(r[2], 1), r[3]] for r in runs if r[0] == idx],
            "interleaved_with": [{"name": n, "n_points": k} for n, k in others.most_common()],
        })
    return table, pts


def members_inside(pts, names, lo, hi):
    c = Counter(names[m] for chain, m in pts if lo <= chain <= hi)
    return [{"name": n, "n_points": k} for n, k in c.most_common()]


def build_regions():
    site = json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))
    dan = json.loads((OUT / "dan.json").read_text(encoding="utf-8"))
    stops = site["stops"]
    track_end = round(site["route"][-1][3], 1)
    last_sol = stops[-1]["sol"]
    names = dan["members"]
    members, pts = member_table(dan)
    dan_end = max(c for c, _ in pts)

    for iso, sol in DATE_SOL_ANCHORS:                      # the date conversion must keep matching NASA
        if abs(sol_from_date(iso) - sol) > 1:
            raise SystemExit(f"date conversion drifted: {iso} gives {sol_from_date(iso)}, NASA says {sol}")
    for rid, (d0, d1) in DATE_DERIVED.items():
        reg = next(r for r in REGIONS if r["id"] == rid)
        got = [sol_from_date(d0), sol_from_date(d1)]
        if got != reg["sol_range"]:
            raise SystemExit(f"{rid}: dates {d0}..{d1} convert to {got}, table says {reg['sol_range']}")

    out = []
    for reg in REGIONS:
        r = {k: reg[k] for k in ("id", "name", "what_to_see", "why_it_matters", "colour")}
        r["what_to_see_source"] = reg["sources"][0]["url"]
        r["sol_range"] = reg["sol_range"]
        if reg["sol_range"]:
            a, b = reg["sol_range"]
            if a > last_sol:
                r["chain_range_m"], how = None, "The sol range lies beyond the last rover stop in data/site.json."
            else:
                lo, hi, n, s0, s1 = chain_for_sols(stops, a, min(b, last_sol))
                r["chain_range_m"] = [lo, hi]
                how = (f"chain_m of the {n} rover stops in data/site.json from sol {s0} (where the rover stood on "
                       f"sol {a}) to sol {s1}.")
        else:
            span = reg["dan_span"]
            first = next(m for m in members if m["name"] == span["first_of"])["chain_range_m"][0]
            stop_at = next(m for m in members if m["name"] == span["last_before_first_of"])["chain_range_m"][0]
            idx = names.index(span["first_of"])
            hi = max(c for c, m in pts if m == idx and c < stop_at)
            r["chain_range_m"] = [round(first, 1), round(hi, 1)]
            how = "First and last DAN points of the named member in data/layers/dan.json, as described in range_note."
        r["chain_range_from"] = how
        r["confidence"] = reg["confidence"]
        r["range_note"] = reg["range_note"]
        if reg["id"] in DATE_DERIVED:
            r["dates_converted"] = list(DATE_DERIVED[reg["id"]])
        if r["chain_range_m"]:
            lo, hi = r["chain_range_m"]
            r["length_m"] = round(hi - lo, 1)
            r["dan_members_inside"] = members_inside(pts, names, lo, hi)
            r["beyond_dan_coverage"] = bool(lo > dan_end)
        r["sources"] = reg["sources"]
        out.append(r)

    doc = {
        "built_utc": now_utc(),
        "built_by": "tools/build_regions.py",
        "regions": out,
        "members": members,
        "nasa_map": NASA_MAP,
        "confidence_values": [C_PUBLISHED, C_DAN, C_BLOG, C_OBS, C_UNKNOWN],
        "track": {"length_m": track_end, "last_sol": last_sol, "dan_coverage_end_m": round(dan_end, 1)},
        "date_to_sol": {
            "rule": "sol = floor(days since 2012-08-06 / 1.02749125 + 0.8), good to about one sol",
            "checked_against_nasa_pairs": [{"date": d, "nasa_sol": s, "rule_gives": sol_from_date(d)}
                                           for d, s in DATE_SOL_ANCHORS],
        },
        "source_notes": (
            "Regions are stretches of the rover track, not areas: chain_range_m says where along the track the "
            "rover was while the mission was working in that region, so a region's true outline on the ground is "
            "wider than its stretch of track and is not in this file. Ranges overlap on purpose: the pediment "
            "visit lies inside Glen Torridon, and the Gediz Vallis ridge and channel and the boxwork lie inside "
            "the sulfate-bearing unit. Parts of the track belong to no listed region. Sol ranges are copied from "
            "the cited sources and never stretched to close gaps; 'confidence' says what kind of source each one "
            "rests on, and range_note gives the wording and any doubt. chain_range_m is computed from "
            "data/site.json (rover stops by sol) or data/layers/dan.json (member names) by this script. "
            "'members' lists each stratigraphic member named in the DAN table with its first and last chain_m, "
            "its separate runs along the track as [start_m, end_m, n_points], and the other members found between "
            "its first and last point; DAN member names stop at sol 3333 (dan_coverage_end_m), so regions beyond "
            "that have no member cross-check. Colours are those of NASA's 2019 annotated route image (see "
            "nasa_map); 'none' means NASA gave that region no colour. The what_to_see and why_it_matters text is "
            "a plain-language summary written for this app from the listed sources, not a quotation."
        ),
    }
    size = write_json("regions.json", doc)
    if size > 60 * 1024:
        raise SystemExit("regions.json is over 60 KB")
    for r in out:
        print(f"    {r['id']:24s} sols {str(r['sol_range']):14s} chain {str(r['chain_range_m']):22s} {r['confidence']}")


# ---------------------------------------------------------------------------------------------------------
# Geology
# ---------------------------------------------------------------------------------------------------------
def clip_ring(ring, box):
    """Sutherland-Hodgman clip of a closed ring to an axis-aligned box (west, south, east, north)."""
    w, s, e, n = box
    pts = ring[:-1] if ring[0] == ring[-1] else ring[:]

    def run(points, inside, cross):
        res = []
        for i, cur in enumerate(points):
            prev = points[i - 1]
            if inside(cur):
                if not inside(prev):
                    res.append(cross(prev, cur))
                res.append(cur)
            elif inside(prev):
                res.append(cross(prev, cur))
        return res

    def x_cross(x):
        return lambda p, q: [x, p[1] + (q[1] - p[1]) * (x - p[0]) / (q[0] - p[0])]

    def y_cross(y):
        return lambda p, q: [p[0] + (q[0] - p[0]) * (y - p[1]) / (q[1] - p[1]), y]

    for inside, cross in ((lambda p: p[0] >= w, x_cross(w)), (lambda p: p[0] <= e, x_cross(e)),
                          (lambda p: p[1] >= s, y_cross(s)), (lambda p: p[1] <= n, y_cross(n))):
        if not pts:
            return []
        pts = run(pts, inside, cross)
    if len(pts) < 3:
        return []
    return pts + [pts[0]]


def simplify(points, tol):
    """Douglas-Peucker on an open list of points (iterative)."""
    if len(points) < 3:
        return points[:]
    keep = [False] * len(points)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        a, b = stack.pop()
        ax, ay = points[a]
        bx, by = points[b]
        dx, dy = bx - ax, by - ay
        norm = (dx * dx + dy * dy) ** 0.5
        worst, at = 0.0, None
        for i in range(a + 1, b):
            px, py = points[i]
            d = abs(dy * (px - ax) - dx * (py - ay)) / norm if norm else ((px - ax) ** 2 + (py - ay) ** 2) ** 0.5
            if d > worst:
                worst, at = d, i
        if at is not None and worst > tol:
            keep[at] = True
            stack.append((a, at))
            stack.append((at, b))
    return [p for p, k in zip(points, keep) if k]


def simplify_ring(ring, tol):
    """Simplify a closed ring in two halves so the start point is not special-cased away."""
    body = ring[:-1]
    if len(body) < 8:
        return ring
    far = max(range(len(body)), key=lambda i: (body[i][0] - body[0][0]) ** 2 + (body[i][1] - body[0][1]) ** 2)
    first = simplify(body[:far + 1], tol)
    second = simplify(body[far:] + [body[0]], tol)
    out = first + second[1:]
    return out if len(out) >= 4 else ring


def signed_area(ring):
    return sum(ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1] for i in range(len(ring) - 1)) / 2.0


def in_ring(x, y, ring):
    hit = False
    for i in range(len(ring) - 1):
        x1, y1 = ring[i]
        x2, y2 = ring[i + 1]
        if (y1 > y) != (y2 > y) and x < x1 + (x2 - x1) * (y - y1) / (y2 - y1):
            hit = not hit
    return hit


def in_polygon(x, y, rings):
    """Even-odd rule over all rings, so holes are handled without knowing which ring is which."""
    return sum(1 for r in rings if in_ring(x, y, r)) % 2 == 1


def age_from_name(desc):
    m = re.match(r"((?:Early|Middle|Late|Amazonian|Hesperian|Noachian|and)(?:\s+(?:Early|Middle|Late|Amazonian|"
                 r"Hesperian|Noachian|and))*)", desc or "")
    return m.group(1) if m else None


def clean(text):
    return re.sub(r"\s+", " ", text or "").strip()


def build_geology(refresh):
    site = json.loads((ROOT / "data" / "site.json").read_text(encoding="utf-8"))
    w, s, e, n = CORE_BOX
    clip = (round(w - PAD_DEG, 4), round(s - PAD_DEG, 4), round(e + PAD_DEG, 4), round(n + PAD_DEG, 4))
    sr = json.dumps({"wkt": GCS_MARS})
    query = urllib.parse.urlencode({
        "geometry": ",".join(str(v) for v in clip), "geometryType": "esriGeometryEnvelope",
        "inSR": sr, "outSR": sr, "spatialRel": "esriSpatialRelIntersects",
        "outFields": "*", "returnGeometry": "true", "f": "json"})
    raw = json.loads(fetch(GEO_LAYER + "/query?" + query, "sim3292_gale_box.json", force=refresh))
    if "error" in raw or raw.get("exceededTransferLimit"):
        raise SystemExit("geology query failed or was truncated: " + json.dumps(raw.get("error"))[:300])
    layer = json.loads(fetch(GEO_LAYER + "?f=json", "sim3292_layer.json", force=refresh))
    colours = {}
    for info in layer.get("drawingInfo", {}).get("renderer", {}).get("uniqueValueInfos", []):
        c = info.get("symbol", {}).get("color")
        if c:
            colours[info["value"]] = "#%02x%02x%02x" % tuple(c[:3])

    units, full = [], {}
    points_in, points_out = 0, 0
    for feat in raw["features"]:
        a = feat["attributes"]
        src_rings = feat["geometry"]["rings"]
        full[a["Unit"]] = full.get(a["Unit"], []) + src_rings
        rings, roles = [], []
        for ring in src_rings:
            points_in += len(ring)
            # ArcGIS convention: outer rings run clockwise (negative signed area), holes counter-clockwise
            role = "outer" if signed_area(ring) < 0 else "hole"
            clipped = clip_ring(ring, clip)
            if not clipped:
                continue
            thin = [[round(x, 4), round(y, 4)] for x, y in simplify_ring(clipped, SIMPLIFY_DEG)]
            thin = [p for i, p in enumerate(thin) if i == 0 or p != thin[i - 1]]
            if len(thin) >= 4:
                rings.append(thin)
                roles.append(role)
                points_out += len(thin)
        if not rings:
            continue
        core_hit = any(in_polygon(x, y, src_rings) for x in (w, (w + e) / 2, e) for y in (s, (s + n) / 2, n))
        units.append({
            "code": a["Unit"],
            "name": a["UnitDesc"],
            "age": age_from_name(a["UnitDesc"]),
            "group": a.get("UnitGroup"),
            "description": clean(a.get("PrimaryCharacteristics")),
            "additional": clean(a.get("AdditionalCharacteristics")),
            "interpretation": clean(a.get("Interpretation")),
            "colour": colours.get(a["Unit"]),
            "source_polygon_area_km2": round(a.get("SphArea_km") or 0),
            "in_core_box": core_hit,
            "rings": rings,
            "ring_roles": roles,
        })

    def unit_at(lon, lat):
        for code, rings in full.items():
            if in_polygon(lon, lat, rings):
                return code
        return None

    track_units = []                              # which map unit each stretch of the rover track falls in
    for lon, lat, _elev, chain in site["route"]:
        code = unit_at(lon, lat)
        if track_units and track_units[-1]["code"] == code:
            track_units[-1]["chain_range_m"][1] = round(chain, 1)
        else:
            track_units.append({"code": code, "chain_range_m": [round(chain, 1), round(chain, 1)]})

    km_per_deg = MARS_RADIUS_M * 3.141592653589793 / 180 / 1000
    box_km = [round((e - w) * km_per_deg, 1), round((n - s) * km_per_deg, 1)]
    doc = {
        "built_utc": now_utc(),
        "built_by": "tools/build_regions.py",
        "units": units,
        "source": "USGS Scientific Investigations Map 3292, Geologic Map of Mars (Tanaka and others, 2014), unit polygons from the USGS-hosted ArcGIS feature service, layer 3 'Global_Geology'",
        "source_url": GEO_LAYER,
        "publication_url": GEO_PUB,
        "citation": GEO_CITATION,
        "scale_note": (
            f"This is a 1:20,000,000 map of the whole planet. At that scale one millimetre on the printed map is "
            f"20 km on the ground, and the whole walk-planner box ({box_km[0]} km by {box_km[1]} km) is smaller "
            f"than one square millimetre of it. A contact line here can be several kilometres from where the "
            f"rocks really change, so this layer says only what kind of terrain the region is in the global "
            f"picture: it must not be used to say what rock is under any particular step of a walk. No finer "
            f"published USGS geologic map of Gale Crater or Mount Sharp exists as GIS data (checked 2026-11-14)."),
        "core_box": {"west": w, "south": s, "east": e, "north": n},
        "clip_box": {"west": clip[0], "south": clip[1], "east": clip[2], "north": clip[3]},
        "coordinates": "longitude east-positive and planetocentric latitude in degrees on the Mars 2000 sphere (radius 3,396,190 m), as returned by the service when asked for GCS_Mars_2000_Sphere; the service itself stores a Robinson projection",
        "rings_note": "Each ring is closed (first point repeated last) and clipped to clip_box, so straight edges along the box are cuts, not contacts. ring_roles says whether a ring is an outer boundary or a hole in the source polygon; drawing all rings of a unit with the even-odd fill rule gives the right shape.",
        "simplification": f"Douglas-Peucker, tolerance {SIMPLIFY_DEG} degrees (about {round(SIMPLIFY_DEG * km_per_deg * 1000)} m), then rounded to 4 decimals; {points_in} source vertices became {points_out}",
        "point_check": {"lon": TEST_POINT[0], "lat": TEST_POINT[1], "unit": unit_at(*TEST_POINT),
                        "note": "computed here from the unclipped polygons; the service's own point query gives the same unit"},
        "track_units": track_units,
        "track_units_note": "Which unit polygon each stretch of the rover track (chain_m from data/site.json) falls in, by point-in-polygon on the unclipped source polygons. Because of the map scale the changeover chain is uncertain by kilometres.",
        "cors": "The feature service answers with access-control-allow-origin: * (tested 2026-11-14), so a browser could query it live; this file is a baked copy so the app needs no network.",
    }
    size = write_json("geology.json", doc)
    if size > 80 * 1024:
        raise SystemExit("geology.json is over 80 KB")
    for u in units:
        print(f"    {u['code']:5s} {u['name']:42s} rings {len(u['rings'])} points {sum(len(r) for r in u['rings'])}"
              f" in core box: {u['in_core_box']}")
    print("    unit at test point:", doc["point_check"]["unit"], "| track:", track_units)


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", default="regions,geology")
    ap.add_argument("--refresh", action="store_true")
    args = ap.parse_args()
    todo = {t.strip() for t in args.only.split(",") if t.strip()}
    bad = todo - {"regions", "geology"}
    if bad:
        sys.exit("unknown --only value: " + ", ".join(sorted(bad)))
    if "regions" in todo:
        print("regions")
        build_regions()
    if "geology" in todo:
        print("geology")
        build_geology(args.refresh)


if __name__ == "__main__":
    main()
