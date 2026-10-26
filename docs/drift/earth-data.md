# The Drift — Earth maps

`src/drift/getTheDrift/earth.ts` draws the measured planet from maps built by
`scripts/drift-earth-data.py` into `public/drift/earth/` (git-ignored, ~150 MB). Rebuild:

```bash
mkdir -p out/drift/data/raw && cd out/drift/data && python3 -m venv .venv && .venv/bin/pip install numpy pillow tifffile imagecodecs
# download the sources below into out/drift/data/raw (terrain tiles into raw/terrarium/<z>_<x>_<y>.png, VIIRS into raw/wv/)
out/drift/data/.venv/bin/python -I scripts/drift-earth-data.py out/drift/data/raw public/drift/earth
```

| map | source | licence / credit |
|---|---|---|
| surface colour | NASA Blue Marble Next Generation, July 2004: `world.200407.3x21600x10800.jpg`, tiles `world.200407.3x21600x21600.{B1,C1}.jpg` — https://eoimages.gsfc.nasa.gov/images/imagerecords/74000/74092/ | public domain, NASA Earth Observatory (Reto Stöckli) |
| night lights | NASA Black Marble 2016, grey: `BlackMarble_2016_3km_gray_geo.tif`, `BlackMarble_2016_{B1,C1}_geo_gray.tif` — https://eoimages.gsfc.nasa.gov/images/imagerecords/144000/144897/ | public domain, NASA Earth Observatory (Joshua Stevens, Miguel Román) |
| global clouds | `cloud_combined_8192.tif` — https://eoimages.gsfc.nasa.gov/images/imagerecords/57000/57747/ | public domain, NASA |
| Europe clouds | VIIRS NOAA-20 Corrected Reflectance (true colour), 2023-09-08, via GIBS WMS: `https://gibs.earthdata.nasa.gov/wms/epsg4326/best/wms.cgi?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=VIIRS_NOAA20_CorrectedReflectance_TrueColor&CRS=EPSG:4326&BBOX=18,-25,68,45&WIDTH=7000&HEIGHT=5000&FORMAT=image/jpeg&TIME=2023-09-08` | NASA EOSDIS GIBS / Worldview, free use with acknowledgement |
| elevation | AWS Terrain Tiles (terrarium), zoom 7 over Europe, zoom 4 globally — `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png` | Mapzen / AWS Open Data; SRTM, ETOPO1 and others — attribution per https://github.com/tilezen/joerd/blob/master/docs/attribution.md |

The day was picked for clear central Europe (the arrival, the night lights and the flood all look
there) with an Atlantic cyclone and its fronts at the western limb. The cloud cover is what the VIIRS
day shows brighter and whiter than the cloud-free Blue Marble.
