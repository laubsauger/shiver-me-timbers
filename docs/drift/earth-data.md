# The Drift — Earth maps

`src/drift/getTheDrift/earth.ts` draws the measured planet from maps built by
`scripts/drift-earth-data.py` into `public/drift/earth/` (git-ignored, ~300 MB; it travels in the asset bundle).
Four nested levels, all equirectangular, each finer one fading into the one under it inside its own edge
(`earthMaps.ts`):

| level | box (lon, lat) | texel | maps | fades in over |
|---|---|---|---|---|
| global | the planet | ~5 km (8192 × 4096; elevation 4096 × 2048) | colour, lights + clouds + water, elevation (zoom 4) | |
| region | −25..45, 18..68 | 1/100° ~1.1 km (7000 × 5000) | colour, lights + clouds + water, elevation (zoom 7) | 1.5° |
| near | −12..20, 36..54 | 1/240° ~460 m (7680 × 4320): the Blue and Black Marble's own grid | colour, lights + water, elevation (zoom 9) | 1° |
| inset | 6..14, 43.5..47 | 1/1000° × 1/1400° ~79 m (8000 × 4900) | Sentinel-2 colour, its own water, elevation (zoom 11, EU-DEM) | 0.35° |

The near level and the inset are on by default only after the render boxes have their maps; until then
`?earthfine` turns them on and `?earthfine=0` off (an A/B against the region alone).

## Rebuild

```bash
mkdir -p out/drift/data/raw && cd out/drift/data && python3 -m venv .venv && .venv/bin/pip install numpy pillow tifffile imagecodecs
# download the sources below into out/drift/data/raw (see "Downloads")
out/drift/data/.venv/bin/python -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth            # all four levels
out/drift/data/.venv/bin/python -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth near,inset # only these
node scripts/drift-bundle.mjs --manifest-only   # then the render boxes fetch the changed maps file by file
```

The near level takes ~35 s, the inset ~30 s on the M3 Max. The inset bake prints what it fitted (the Sentinel
scenes' Sun, the colour gain) so a rerun can be checked against the last one.

## Sources and credits

| map | source | licence / credit |
|---|---|---|
| surface colour | NASA Blue Marble Next Generation, July 2004: `world.200407.3x21600x10800.jpg`, tiles `world.200407.3x21600x21600.{B1,C1}.jpg` — https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/ | public domain, NASA Earth Observatory (Reto Stöckli) |
| inset surface colour | Sentinel-2 cloudless 2016 by EOX, WMTS layer `s2cloudless` (the 2016 edition), WGS84 matrix level 11 — `https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84/11/{row}/{col}.jpg` | **CC BY 4.0. Credit: "Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)"** (EOX's current wording of the same: "EOxCloudless https://cloudless.eox.at by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)"). Only the 2016 (and 2017) layers are CC BY; 2018 on are CC BY-NC-SA or commercial — do not swap the year |
| night lights | NASA Black Marble 2016, grey: `BlackMarble_2016_3km_gray_geo.tif`, `BlackMarble_2016_{B1,C1}_geo_gray.tif` — https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/ | public domain, NASA Earth Observatory (Joshua Stevens, Miguel Román) |
| global clouds | `cloud_combined_8192.tif` — https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/ | public domain, NASA |
| Europe clouds | VIIRS NOAA-20 Corrected Reflectance (true colour), 2023-09-08, via GIBS WMS: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&CRS=EPSG:4326&BBOX=18,-25,68,45&WIDTH=7000&HEIGHT=5000&FORMAT=image/jpeg&TIME=2023-09-08` | NASA EOSDIS GIBS / Worldview, free use with acknowledgement |
| elevation | AWS Terrain Tiles (terrarium), zoom 4 globally, 7 over the region, 9 over the near level, 11 over the inset — `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Mapzen / AWS Open Data; attribution per https://github.com/tilezen/joerd/blob/master/docs/attribution.md — here: "Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers"; "Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration"; "United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey"; "Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich" (the inset's north-east corner) |

The day was picked for clear central Europe (the arrival, the night lights and the flood all look
there) with an Atlantic cyclone and its fronts at the western limb. The cloud cover is what the VIIRS
day shows brighter and whiter than the cloud-free Blue Marble.

## Downloads

Everything goes into `out/drift/data/raw/` under the names the script reads:

- the Blue Marble and Black Marble files above, `cloud_combined_8192.tif`, the VIIRS day saved as
  `wv/viirs_2023-09-08_7000.jpg` (~337 MB together);
- terrain tiles as `terrarium/<z>_<x>_<y>.png`: all 256 of zoom 4; zoom 7 x 55–80, y 30–57 (728); zoom 9
  x 238–284, y 164–201 (1786 tiles, 208 MB); zoom 11 x 1058–1103, y 720–748 (1334 tiles, 142 MB);
- Sentinel-2 cloudless as `s2cloudless/11_<row>_<col>.img`: level 11, rows 489–529, columns 2116–2207 (3772
  tiles, 61 MB; open sea comes as a one-colour PNG, land as JPEG, hence `.img`). EOX asks that its free 2016
  endpoint not be hit with large batches: fetch with a few connections at a time, once, and keep the tiles.

```sh
cd out/drift/data/raw
T=https://s3.amazonaws.com/elevation-tiles-prod/terrarium
mkdir -p terrarium s2cloudless
for x in $(seq 238 284); do for y in $(seq 164 201); do curl -fsS -o terrarium/9_${x}_${y}.png $T/9/$x/$y.png; done; done
for x in $(seq 1058 1103); do for y in $(seq 720 748); do curl -fsS -o terrarium/11_${x}_${y}.png $T/11/$x/$y.png; done; done
S=https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless/default/WGS84/11
for r in $(seq 489 529); do for c in $(seq 2116 2207); do curl -fsS -o s2cloudless/11_${r}_${c}.img $S/$r/$c.jpg; done; done
```

## Resolution (measured 2026-10-30)

The question: "at the zoom level we end up in they look kind of low resolution … can we upscale them?" Measured
with the show's own camera path (`timeline.ts`): for each time, where the dome's front meridian meets the
ground, the pixel's footprint across the view at a 2048² and a 4096² master (π/2048, π/4096 rad), against the
map's east–west texel there. "Under" is texel / footprint: above 1 the map is magnified — soft, and in the relief
shading and the lights' edges, chunky. (The 16:9 review at 1280 px and fov 60 is about the 4096 master.)

| show s | beat | height | front edge of the dome looks at | footprint 2K / 4K | under, before (2K / 4K) | under, after (2K / 4K) |
|---|---|---|---|---|---|---|
| 185 | arrival | 1370 km | 37.6 N 27.8 W (Atlantic) | 2.2 / 1.1 km | 1.8 / 3.6 (global; open sea) | same |
| 225 | lights | 620 km | 43.1 N 8.8 W (Galicia) | 1.1 km / 550 m | 0.7 / 1.5 | 0.3 / 0.6 (near) |
| 245 | flood | 450 km | 43.8 N 4.9 W | 820 / 410 m | 1.0 / 2.0 | 0.4 / 0.8 (near) |
| 255 | flood (night) | 270 km | 44.4 N 0.4 W (Aquitaine) | 510 / 260 m | 1.6 / 3.1 | 0.6 / 1.3 (near) |
| 262 | flood | 170 km | 44.7 N 2.8 E (Massif Central) | 340 / 170 m | 2.3 / 4.7 | 1.0 / 1.9 (near) |
| 268 | Drift-2 | 113 km | 44.9 N 5.4 E (Drôme) | 220 / 110 m | 3.5 / 7.1 | 1.5 / 3.0 (near) |
| 275 | Drift-2 | 68 km | 45.0 N 8.1 E (Piedmont) | 130 / 64 m | 6.2 / 12.4 | 0.6 / 1.2 (inset) |
| 282 | Drift-2 | 40 km | 45.0 N 10.8 E (Po plain, flooded) | 71 / 36 m | 11 / 22 | 1.1 / 2.2 (inset) |
| 287 | landing | 24 km | 45.0 N 11.9 E (the gathering point, flooded) | 45 / 22 m | 17 / 35 | 1.8 / 3.5 (inset) |
| 297 | landing | 7 km | the same | 16 / 8 m | 50 / 100 | 5 / 10 (inset) |

Over all the dome and every time from 220 s on (a 4096 master): the region's 1.1 km is too coarse over lon
−13.5..19.5, lat 32..57; the Blue Marble's own 460 m over lon −6.5..19, lat 39.5..50.5; and the pixel falls under
120 m over lon 4.5..14, lat 43.5..46.5, under 60 m over lon 8.5..13, lat 44..46 — the boxes above follow from
that. **The night lights**: at the lights beat a 4096 pixel covers 500–700 m of the night side, and the Black
Marble's own 500 m (the near level) matches it. The night comes closer only in the flood: ~250 m at 255 s, and in
its last twilight (265–273 s, over the Rhône and Piedmont, the Sun 1–6° under the horizon) 200 down to ~80 m, by
when the flood has put out all but the brightest cores. No public data is finer than 500 m: under it the lights are
the shader's (`lifeLayers.ts` nightLights, its grain), so the lights stop at the near level. Below the inset's 79 m (the
landing under ~15 km) the ground in front is the new sea, drawn by the shader; the land in view is 30 km off and
more.

### How the inset is made

1. The Sentinel tiles (~38 m) averaged (Lanczos) onto the inset's grid.
2. **The water from the terrain, not the colour**: EU-DEM leaves the sea and the lagoons at exactly 0 m and its
   lakes flat (Garda at 61.0 m); the Blue Marble's colour test misses the turbid northern Adriatic, and no colour
   test tells the lagoon's grey-green from wet fields. The sea floor under it comes from zoom 9 (zoom 11 has none),
   so the shader's teal shelves match the near level's.
3. **The scenes' own shading taken out**: Sentinel's ground is sunlit from the south-east at mid-morning; the film
   lights it again from the elevation. The hillshade of the zoom-11 terrain under a fitted Sun (azimuth 160°,
   elevation 45°; correlation 0.46 with Sentinel's relative brightness on land) is divided out per channel (red
   1.0, green 0.92, blue 0.56: the shaded side is lit blue by the sky), at most 2× brighter.
4. **The colour**: each channel's distribution over the land matched to the Blue Marble's (one curve for the
   inset), then a regional cast evened out over ~7 km (by at most 1.5×), held closer to the Blue Marble near the
   box's edge (~2 km, by at most 2×). Tried first and dropped: Sentinel scaled to the Blue Marble's ratio at
   460 m everywhere — it painted July 2004's snow over 2016's bare rock (whitened rock, yellow-green halos round
   every snowfield). What still differs is real (2016's snow line, fields, towns) and fades into the near level
   over the last 0.35°: over 0.25° cells along the edge the two agree to within ±5–10% in red and green.
5. Blue excess on land cut to a third (shaded snow, 1.5% of the land).

### In the shader

- `sampleLevels` (earthMaps.ts): four lookups a map, each finer level over the coarser by its weight; mips from
  the pixel's footprint. The clouds and the desert's bare rock stay on the region and global maps.
- The relief's baseline is never under 0.72 of the finest elevation texel there (0.8 km over the region as before,
  ~330 m over the near level, ~57 m over the inset), and its exaggeration falls from 2.5× at 0.8 km to 1× at
  100 m: real slopes at 60 m read by themselves (2.5× tipped the Alps' normals past 70°).
- The flood line's sub-pixel noise over the inset starts at ~160 m and is 1 m high (7 m from ~2 km elsewhere: in
  a plain falling 1 m a km that moved the real coast by kilometres).

### GPU memory

The two new levels add about 800 MB of textures with their mips (near: colour 177, lights + water 177, elevation
88; inset: colour 209, water 52 as one channel, elevation 105), on the ~800 MB the region and global maps use.
A 2K or 4K lane (~10 GB) has room on every box; the 8K master on a 24 GB card is tighter (it needed `--msaa 0`
there already).
