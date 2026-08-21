# assets/lut — colour grade LUT strips (§T.101, §V.89)

One PNG per time-of-day slot: `dawn.png`, `noon.png`, `dusk.png`, `night.png`.
All four shipped files are the **identity** LUT — no look has been authored
yet; the R3 lookdev sync bakes the first ones in-engine.

## Format

A 32³ RGB LUT flattened to a `1024 × 32` RGBA8 PNG ("strip"):

- pixel `x = r + 32·b`, `y = g` — the 32 blue slices laid side by side, each
  a 32×32 red-by-green square (a Hald CLUT folds the slices into a square;
  this stays flat so one slice can be read by eye)
- value = the graded display-space colour for the grid input
  `(r, g, b) / 31`, 8 bits per channel, alpha 255
- `lutFromStrip` derives the size from the image height, so a 16³ (256×16)
  or 64³ (4096×64) strip also loads and is resampled onto 32³

Encoder/decoder: `src/core/gradeLut.ts` (`lutToStrip` / `lutFromStrip`);
the round trip is tested in `tests/grade.test.ts`.

## Authoring in-engine

1. Open `raft.html?tod=17.8` (or whichever hour), tune the `grade` folder in
   the Tweakpane (lift/gamma/gain, saturation, split tone).
2. `__game.grade.bake('dusk')` — bakes the sliders into the dusk slot, resets
   the sliders to identity (the look now lives in the LUT, so it is not
   applied twice), and returns a `data:image/png;base64,…` URL.
3. Save it over `assets/lut/dusk.png`.

Other handle methods: `bake(slot, { keepLgg: true })`, `exportSlot(slot)`,
`setSlotFromStrip(slot, img)`, `loadSlot(slot, url?)`, `resetSlot(slot)`,
`resetLgg()`, `weights(tod?)`, `bound()`.

The LUT sits **after** the ACES tone map and exposure, so a strip encodes a
display-referred (sRGB 0..1) transform. The sampler applies
`rgb·31/32 + 0.5/32` so the grid points fall on texel centres and the
identity strip is exact to 8 bits (§V.89).
