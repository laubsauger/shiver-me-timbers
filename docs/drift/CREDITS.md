# The Drift — on-screen credits

The film has no end-credit roll of its own: its end title is the written-on signature ("the Drift",
`src/drift/flatTitles.ts`, `undertime/crawl.ts`). These are the credits the data on screen requires or customarily
gets, to paste into the end credits in DaVinci. The block between the rules is the text; the notes under it say why.

---

**Earth imagery and terrain**

Sentinel-2 cloudless – https://s2maps.eu by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016)

Europe terrain data produced using Copernicus data and information funded by the European Union - EU-DEM layers

Austria terrain data © offene Daten Österreichs – Digitales Geländemodell (DGM) Österreich

Global ETOPO1 terrain data U.S. National Oceanic and Atmospheric Administration

United States 3DEP (formerly NED) and global GMTED2010 and SRTM terrain data courtesy of the U.S. Geological Survey

Terrain tiles: Mapzen / AWS Open Data (Terrain Tiles)

NASA Earth Observatory: Blue Marble Next Generation (Reto Stöckli), Black Marble 2016 (Joshua Stevens, Miguel Román), cloud composite

VIIRS imagery: NASA Worldview / GIBS, part of NASA's Earth Observing System Data and Information System (EOSDIS)

**Galaxy images** (Act 2's galaxies; CC BY)

- ESA/Hubble & NASA. Acknowledgement: Luca Limatola — CC BY 3.0 — https://commons.wikimedia.org/wiki/File:Hubble_portrays_a_dusty_spiral_galaxy.jpg
- ESA/Hubble & NASA, D. Rosario — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A_Spiral_in_Profile_NGC_3717.jpg
- ESA/Hubble & NASA, C. Kilpatrick — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A_super(nova)_spiral_(potw2434a).jpg
- ESA/Hubble & NASA, L. Galbany, S. Jha, K. Noll, A. Riess — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A_supernova-rich_spiral_(potw2530a).jpg
- Image: European Space Agency & NASA Acknowledgements: Project Invest … — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:M101_hires_STScI-PRC2006-10a.jpg
- ESA/Hubble & NASA, G. Fabbiano — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:Revisiting_an_unusual_spiral_(potw2544a).jpg
- ESA/Hubble & NASA, O. Fox, L. Jenkins, S. Van Dyk, A. Filippenko, J. Lee and … — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:Galaxy_light_show_(potw2445a).jpg
- ESA/Hubble & NASA — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A_galaxy_on_the_edge.jpg
- ESA/Hubble, NASA Y. Choi (NOIRLab), K. Gilbert (Space Telescope Science Institut … — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:Dwarf_irregular_galaxy_UGC_8091_(heic2313a).jpg
- ESA/Hubble & NASA, C. Kilpatrick — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:A_dishevelled_irregular_galaxy_(potw2324a).jpg
- ESA/Hubble & NASA, R. J. Foley (UC Santa Cruz) — CC BY 4.0 — https://commons.wikimedia.org/wiki/File:Swirling_spiral_in_Hydra_(potw2529a).jpg

Further galaxy images: NASA, ESA and the Hubble Heritage Team (STScI/AURA), public domain

---

## Notes

- **Sentinel-2 cloudless 2016** (the inset, the Alps to Istria under the end of Drift-2 and the landing): CC BY 4.0;
  the credit line is EOX's required wording, verbatim. Only the 2016 and 2017 layers are CC BY (earth-data.md).
- **EU-DEM** (the inset's zoom-11 terrain, through the AWS Terrain Tiles): the wording is the one Tilezen's attribution
  list gives for it (https://github.com/tilezen/joerd/blob/master/docs/attribution.md), as in earth-data.md. The
  Austrian DGM is in the inset's north-east corner (CC BY 4.0, the same list). ETOPO1 and USGS cover the global and
  sea-floor terrain; Tilezen asks for each source that is used.
- **NASA Blue Marble, Black Marble, the cloud composite, VIIRS via GIBS**: public domain or free use; a credit is
  customary (GIBS asks for an acknowledgement).
- **Galaxies**: from `public/drift/galaxies/galaxy-atlas.json` (built by `scripts/drift-galaxy-atlas.py`). Its credit
  field is cut at 80 characters: the lines ending in "…" must be completed from the source page before they go on
  screen. The 16 public-domain ones need no credit; the last line covers them.
