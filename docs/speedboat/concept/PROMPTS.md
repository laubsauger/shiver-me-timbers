# Concept set: prompts used

Method: OpenAI image generation through the installed Codex CLI (`codex exec`, codex-cli 0.154.0, built-in `image_gen` tool, user's ChatGPT plan; no API key). Script: one `codex exec -s workspace-write -C docs/speedboat/concept [-i reference.png ...]` per image, with instructions to pass the prompt verbatim and copy the PNG here. Run 2026-09-13.

Consistency tricks: (1) the fixed STYLE + BOAT prefix below is prepended to every prompt, with numbers stated (12.0 m, 2.6 m beam, 24°, 1.67 m depth, 0.40 m windscreen, zones in % of length); (2) the side profile was generated first, corrected by an image **edit** pass (01 → 01c), and 01c was attached as an image reference to every later view; (3) when an image is attached, this line is prepended: *"ATTACHED IMAGE(S): reference of this exact boat design. Match its hull shape, proportions, deck layout, parts and livery exactly; only change the view as described."*

Output size: the tool ignored the requested 1536×1024 for most views and returned 1942×809 (wide views), 1375×1144 (front) or 1536×1024 (sheets). PNGs are gitignored by the repo's `docs/**/*.png` rule (see report).

## Fixed prefix (every image)

```text
STYLE (fixed for every image in this set): AAA game vehicle concept art, industrial-design presentation render, physically plausible PBR materials, crisp hard-surface edges with small bevels, soft overcast studio key light from upper left with gentle sky fill, neutral warm-grey seamless studio background (#D8D4CC) unless the VIEW says otherwise. No text, no letters, no numbers, no logos, no brand names, no watermark, no UI. Colour mood: Studio Ghibli warmth with a Firewatch-like restrained palette; sun-bleached and salt-weathered, never neon, never grimdark.

BOAT (identical in every image, do not redesign): a fictional salvaged-and-rebuilt offshore racing powerboat from a flooded world in the year 2100. 12.0 m long deep-V monohull, 2.6 m beam, 24-degree deadrise V bottom, hull depth from keel to deck 1.67 m at the transom (so length is 4.6 times beam and 7 times hull depth), flat vertical transom, straight nearly level sheer line, long fine pointed bow with a slightly raked stem, keel sweeping up over the forward 30% of the length, two lifting strakes per side and a narrow chine flat, hull sides with slight flare, black rubber rub rail along the sheer. Deck from bow to stern: long smooth foredeck with a gently crowned centre (front 50% of length), a flush round hatch near the bow; a low wraparound smoked perspex windscreen only 0.40 m tall at 50% of length; one open cockpit from 50% to 68% of length with ONE centreline racing bolster seat, carbon-fibre dashboard and a small aluminium steering wheel; a welded stainless-steel tube roll arch just behind the cockpit carrying one tall whip radio antenna, a small flat solar panel and a round nav light; a long flat aft deck hatch (battery bay) with two low cooling vents; a short transom bracket carrying THREE large outboard motors side by side with smooth rebuilt electric-conversion cowls. Hero livery: bone-white gelcoat topsides (#EDE6D6), a broad sun-faded international-orange (#E4572E) band sweeping along the sheer from bow to stern, a thin deep-teal (#1F4E5F) pinstripe below the band, dark oxide-red matte antifouling bottom (#6B2E25), charcoal non-slip deck panels (#3A3D40), a plain white circular race-number roundel on each side of the hull under the cockpit with no number in it, outboard cowls in the same bone white with orange tops. Salvage story, subtle (70% clean and fast-looking, 20% repaired, 10% worn): one mismatched off-white fibreglass patch with a visible resin edge on the starboard bow quarter, a riveted bare-aluminium repair plate along the aft starboard chine, a jerrycan and a hard battery case lashed behind the seat, faint ghosts of older peeled decals, light chalky salt bloom, a faint green algae line only at the waterline.
```

## Per-image VIEW prompts

### `01-side-profile.png`

- Image input: none
- Status: superseded: 2 outboards, camera slightly above deck

```text
VIEW: strict orthographic starboard side elevation (naval-architecture profile view), bow pointing to the RIGHT, camera exactly level with the hull at mid-height, zero perspective distortion, the entire boat including outboards and antenna fits the frame horizontally with about 6% margin each side, boat shown out of the water floating in the studio with no stand and no water, waterline indicated only by the antifouling boundary. Even, technical lighting. All salvage details on the starboard side are visible.
```

### `01b-side-profile.png`

- Image input: none
- Status: rejected: 4 outboards, tall bubble windscreen, over-weathered

```text
VIEW: strict orthographic starboard side elevation (naval-architecture profile view), bow pointing to the RIGHT, camera exactly level with the hull at mid-height, zero perspective distortion, the entire boat including outboards and antenna fits the frame horizontally with about 6% margin each side, boat shown out of the water floating in the studio with no stand and no water, waterline indicated only by the antifouling boundary. Even, technical lighting. All salvage details on the starboard side are visible.
```

### `01c-side-profile.png`

- Image input: 01-side-profile.png
- Status: SELECTED anchor (edit of 01): 3 outboards, near-orthographic

```text
VIEW: EDIT the attached side view. Keep everything the same (hull shape, livery, colours, salvage patches, roll arch, seat, crates, background, lighting) with exactly these corrections: (1) THREE outboard motors side by side on the transom bracket instead of two, identical bone-white cowls with orange tops; (2) true orthographic side elevation: camera exactly level with the hull, so the deck surface is seen edge-on and not from above; (3) keep the windscreen low (0.40 m); (4) bow pointing RIGHT, whole boat fits with margin.
```

### `02-top-plan.png`

- Image input: 01c-side-profile.png
- Status: selected

```text
VIEW: strict orthographic top-down plan view looking straight down, bow pointing to the RIGHT, zero perspective distortion, boat centred, the entire boat including outboards fits the frame horizontally with about 6% margin. Deck layout must read clearly: long foredeck with flush bow hatch, low wraparound windscreen, open cockpit with the single centreline bolster seat and dashboard, roll arch tubes with the small solar panel, aft battery hatch with two cooling vents, transom bracket with three outboard motors. The hull is symmetric about the centreline. No water, no shadow on the ground.
```

### `03-front.png`

- Image input: 01c-side-profile.png
- Status: superseded: bow too full

```text
VIEW: strict orthographic head-on bow view from dead ahead, camera exactly level with the deck, zero perspective distortion, boat centred and filling about 60% of the frame height. Must read clearly: the sharp 24-degree V bottom, the two lifting strakes and chine flat on each side, slight topside flare, the crowned foredeck, the low windscreen silhouette, the roll arch outline with the whip antenna and nav light, the tops of the three outboard cowls peeking above the aft deck. Perfectly symmetric apart from the small starboard bow patch. No water.
```

### `03b-front.png`

- Image input: 01c-side-profile.png, 07-front-34-studio.png
- Status: selected (bow still full, extra seat backs drift)

```text
VIEW: strict orthographic head-on bow view from dead ahead, camera exactly level with the deck, zero perspective distortion, boat centred and filling about 60% of the frame height. The bow is FINE and SHARP like a classic offshore racer: a narrow knife-like 24-degree V at the stem that widens toward the transom, the deck edges converge steeply to a pointed bow, topsides only slightly flared. Must read clearly: the two lifting strakes and chine flat on each side, the crowned foredeck with the flush hatch, the low 0.40 m windscreen, the roll arch with RAKED legs as in the attached side view (not a square portal), the whip antenna and nav light, the tops of the three outboard cowls peeking above the aft deck. The fibreglass patch sits on the starboard bow quarter (viewer's left). No water.
```

### `04-rear-34.png`

- Image input: 01c-side-profile.png
- Status: selected

```text
VIEW: three-quarter rear view from the starboard-aft quarter, camera about 1.5 m above deck height and 9 m away, 35 mm lens. Must read clearly: the flat vertical transom with the 24-degree V bottom, strakes and chines ending at the transom, the short transom bracket, the three outboard motors with trim rams and propellers, the riveted aluminium repair plate on the aft starboard chine, the aft battery hatch and vents, the roll arch from behind with antenna and solar panel, the cockpit with the single bolster seat and lashed jerrycan and battery case. No water, studio background.
```

### `05-cockpit-pov.png`

- Image input: 01c-side-profile.png
- Status: selected; background peaks too alpine

```text
VIEW: first-person view from the pilot's eyes, sitting braced in the centreline bolster seat (eye 0.5 m above deck level, 0.9 m behind the windscreen), looking forward over the dashboard and through and just over the low windscreen along the long foredeck to the bow point. Environment for this view only: out on calm open sea in warm late-morning light, a hazy distant granite mountaintop island with dark pines on the horizon (a flooded Sierra Nevada summit), no studio background. 28 mm lens. Cockpit details: carbon-fibre dashboard with three round analogue gauges with plain unmarked dials, a scratched salvaged tablet screen zip-tied to the dash showing an abstract glowing chart with no text, a chunky old VHF radio handset on a coiled cord clipped to the dash, a twin-lever throttle quadrant on the right side, a row of toggle switches under flip guards, a small aluminium steering wheel with a rope-wrapped rim held by the pilot's two gloved hands, stainless grab rails, a strip of worn duct tape and some cable ties, the orange livery band just visible on the deck edges. Gauges and screens contain no readable text or numbers.
```

### `06-hero-34.png`

- Image input: 01c-side-profile.png
- Status: superseded: hull floats above water, wrong planing attitude

```text
VIEW: dynamic three-quarter front-starboard hero shot of the boat racing at 80 knots, planing with the bow up about 5 degrees, only the aft third of the hull touching the water, white spray sheets peeling off the chines, a tall white rooster tail behind the outboards, one pilot in a sand-coloured racing suit and white full-face helmet braced behind the windscreen. Environment for this view only: open sea with a moderate swell, warm late-afternoon light, flooded granite mountaintop islands with pines in the hazy distance, one drowned concrete radio mast sticking out of the water far away. 135 mm telephoto lens, slight motion blur on the water only, the boat is sharp. No studio background.
```

### `06b-hero-34.png`

- Image input: 01c-side-profile.png, 07-front-34-studio.png
- Status: SELECTED hero

```text
VIEW: dynamic three-quarter front-starboard hero shot of the boat racing at 80 knots on open sea. Correct planing attitude: the hull is trimmed bow-up about 5 degrees, only the aft 35% of the V bottom is in the water, the forward 60% of the hull is clear of the water with the red antifouling bottom and strakes visible, the outboard lower units and propellers are buried in foaming white water at the transom, a thin flat sheet of spray peels off the chine at mid-length, a tall white rooster tail rises behind the outboards, a long white foam wake trails behind. One pilot in a sand-coloured racing suit and white full-face helmet braced behind the low windscreen. Environment for this view only: open sea with a moderate swell, warm late-afternoon light, distant islands that are smooth bare granite domes and cliffs like Yosemite's Half Dome with scattered dark pines (no snow, no alpine spikes), and far away one rusty lattice radio mast half-drowned in the sea. 135 mm telephoto lens, slight motion blur on the water only, the boat is sharp.
```

### `07-front-34-studio.png`

- Image input: 01c-side-profile.png
- Status: selected

```text
VIEW: three-quarter front view from the starboard-forward quarter, camera about 1.2 m above deck height and 10 m away, 50 mm lens, boat out of the water in the studio. Clean modelling reference: shows the bow entry, strakes, chine flat, topside flare, the fibreglass patch on the starboard bow quarter, foredeck crown and flush hatch, windscreen, cockpit, roll arch, outboard cowls behind. No water.
```

### `08-livery-variants.png`

- Image input: 01c-side-profile.png
- Status: selected

```text
VIEW: livery sheet. Three copies of the identical boat in strict orthographic starboard side elevation, bow pointing RIGHT, stacked vertically with equal spacing, each fitting the width of the frame. Hull shape, parts, stripe layout, number roundel position and salvage patches are IDENTICAL on all three; ONLY the paint colours change. Top boat: the hero livery exactly as described. Middle boat: sun-faded turquoise topsides (#3E8C8A), cream band (#F2E6C8), charcoal pinstripe (#2B2F33), black antifouling (#1E1F21), cowls turquoise with cream tops. Bottom boat: matte charcoal topsides (#2B2F33), cadmium-yellow band (#F2B705), signal-red pinstripe (#C8372D), oxide-red antifouling (#6B2E25), cowls charcoal with yellow tops. No water.
```

### `09-salvage-callouts.png`

- Image input: 01c-side-profile.png
- Status: selected; tile 1 patch reads metallic, should be fibreglass

```text
VIEW: detail callout sheet. A 3 by 2 grid of six square close-up renders of parts of this boat, each tile separated by a thin white border, same studio light, no text or labels. Tile 1: the mismatched off-white fibreglass patch on the bow gelcoat, visible chopped-strand mat texture at the feathered resin edge, sanding marks, slightly different white. Tile 2: the riveted bare-aluminium repair plate along the hull chine, a line of pop rivets, sealant squeeze-out, salt streaks and a little galvanic white corrosion. Tile 3: the welded stainless roll-arch joint with blue-gold heat tint, the whip radio antenna base with a coax cable, cable ties and a small rubber boot. Tile 4: an outboard cowl rebuilt for electric drive: one mismatched replacement panel, hand-cut cooling louvres, visible bolt heads, a screw-cap charging port. Tile 5: the jerrycan and hard battery case lashed behind the seat with a faded ratchet strap and frayed blue rope. Tile 6: layered peeling race decals over chalky oxidised gelcoat, the ghost outline of an older removed stripe.
```

### `10-material-swatches.png`

- Image input: none
- Status: selected; non-slip reads as metal tread plate (spec rules: moulded)

```text
VIEW: material swatch board for this boat. A clean 4 by 2 grid of eight identical square sample tiles, each tile a gently curved panel so reflections and roughness read, same studio light, thin white gaps between tiles, no text or labels. Row 1: (1) glossy bone-white gelcoat #EDE6D6 with light chalking and fine swirl marks; (2) international-orange #E4572E clearcoated livery paint, sun-faded unevenly, with fine scratches and a chip; (3) dark oxide-red #6B2E25 matte antifouling paint with a faint green algae film and a few tiny barnacles along one edge; (4) charcoal #3A3D40 diamond-pattern moulded non-slip deck with scuffed wear on the raised diamonds. Row 2: (5) 2x2 twill carbon fibre under glossy clearcoat with scuffs; (6) brushed stainless steel, salt-weathered, with blue-gold weld heat tint and a small rust bleed streak; (7) black rubber rub-rail extrusion with scuffs and chalky salt; (8) smoked perspex with fine crazing, light scratches and dried water spots.
```

### `11-pilot.png`

- Image input: 01-side-profile.png
- Status: selected; trim the military cargo look

```text
VIEW: character turnaround of the boat's single pilot, full body, three poses side by side on the studio background: front view standing, side view standing, and seated-braced pose as in the bolster seat. The boat itself is NOT shown, only the pilot. Pilot: adult of average build, 1.78 m tall, face fully hidden. Gear: white full-face offshore racing helmet with a dark tinted visor, an orange (#E4572E) stripe matching the hero livery, a small boom intercom mic and a cable; a black carbon neck restraint collar; a one-piece sand-coloured (#CDBFA3) racing suit with an integrated low-profile foam flotation vest in faded orange, reflective tape patches, a small emergency air bottle in a chest pouch, knee pads; black-and-grey gloves; short neoprene marine boots; sun-faded, repaired with a few stitched patches and a strip of tape on one sleeve.
```

## Rev B additions (2026-09-13, after user feedback: no helmet, roundel too heavy)

Same method, same fixed prefix. The number variants override the prefix's no-numbers rule inside their VIEW text.

### `12-pilot-goggles.png`

- Image input: 11-pilot.png
- Status: SELECTED direction: bare head, strap goggles (recommended eyewear)

```text
VIEW: EDIT the attached pilot turnaround. Keep the same character, build, proportions, the three poses, the sand racing suit, orange flotation vest, harness webbing, gloves, boots, knee pads, colours, studio background and lighting. Changes: NO HELMET and no carbon neck collar. Bare head: short dark weather-beaten hair, messy and wind-swept; an ordinary sun-tanned adult face with a calm, focused expression (not a celebrity, not a caricature); a battered salvaged single-ear radio headset with a small boom microphone over the left ear; old leather-strapped aviator-style goggles with scratched amber lenses, worn over the eyes in the seated pose and pushed up onto the forehead in the two standing poses. The flotation vest gains a tall padded foam collar behind the neck. The boat is still not shown.
```

### `12b-pilot-sunglasses.png`

- Image input: 11-pilot.png
- Status: alternative eyewear

```text
VIEW: EDIT the attached pilot turnaround. Keep the same character, build, proportions, the three poses, the sand racing suit, orange flotation vest, harness webbing, gloves, boots, knee pads, colours, studio background and lighting. Changes: NO HELMET and no carbon neck collar. Bare head: short dark weather-beaten hair, messy and wind-swept; an ordinary sun-tanned adult face with a calm, focused expression (not a celebrity, not a caricature); a battered salvaged single-ear radio headset with a small boom microphone over the left ear; scratched wrap-around sport sunglasses with dark lenses on a faded cord retainer, worn in all three poses. The flotation vest gains a tall padded foam collar behind the neck. The boat is still not shown.
```

### `14a-number-painted.png`

- Image input: 01c-side-profile.png
- Status: RECOMMENDED number variant (a)

```text
VIEW: EDIT the attached side view. Keep everything identical (hull shape, livery band and pinstripe, weathering, riveted plates, outboards, roll arch, cockpit, background, camera) except the white circular number roundel. REMOVE the white disc completely and continue the bone-white topsides behind it. Instead, the race number 27 is hand-painted directly onto the bone-white topsides below the cockpit: bold, slightly uneven brush-and-stencil numerals in stencil black (#151B1C), about 0.6 m tall, sun-faded, chipped, with some paint loss and a few drips, clearly painted by hand. EXCEPTION to the no-numbers rule: only the number 27 may appear.
```

### `14b-number-plate.png`

- Image input: 01c-side-profile.png
- Status: variant (b); drift: plate sits mid-hull, not low and aft as asked

```text
VIEW: EDIT the attached side view. Keep everything identical (hull shape, livery band and pinstripe, weathering, riveted plates, outboards, roll arch, cockpit, background, camera) except the white circular number roundel. REMOVE the white disc completely and continue the bone-white topsides behind it. Instead, add a small irregular salvaged aluminium number plate, about 0.55 m wide and 0.45 m tall, not a perfect rectangle (one corner cut off, slightly bent edge), riveted onto the hull LOWER and FURTHER AFT than the old disc (roughly below the roll arch, just above the waterline boot and forward of the aft riveted chine plate). The plate is roughly overpainted off-white by hand with a black hand-painted race number 27; the overpaint is worn away around the rivets and edges, showing bare metal and a streak of salt. EXCEPTION to the no-numbers rule: only the number 27 may appear.
```

### `14c-number-ghost.png`

- Image input: 01c-side-profile.png
- Status: variant (c); drift: ghost disc still reads nearly solid

```text
VIEW: EDIT the attached side view. Keep everything identical (hull shape, livery band and pinstripe, weathering, riveted plates, outboards, roll arch, cockpit, background, camera) except the white circular number roundel. The old pre-flood roundel becomes a FADED GHOST in the same place: only a pale chalky circular outline and a partly sanded-off, slightly lighter disc shape that mostly blends into the bone topsides, with the orange band repaint overlapping its top edge. Over it, new bold hand-painted race numbers 27 in stencil black (#151B1C), about 0.6 m tall, slightly off-centre relative to the ghost circle, weathered and chipped. EXCEPTION to the no-numbers rule: only the number 27 may appear.
```

### `13-chase-bare-head.png`

- Image input: 04-rear-34.png, 12-pilot-goggles.png
- Status: chase-cam check of the bare-headed pilot

```text
VIEW: game chase-camera framing. Camera 7.5 m behind the transom and 2.4 m above the water, looking forward and slightly down at the boat as it planes at speed on open sea, 70-degree field of view, the boat centred in the lower half of the frame. We see the three outboards and transom bracket, a white rooster tail and spray behind the outboards, the aft deck hatch, the roll arch with antenna, the lashed jerrycans, and the single pilot seen from behind and slightly above: the pilot from the second attached image, BARE HEAD with no helmet, short wind-swept dark hair blown forward-back by the wind, leather goggle strap around the back of the head, single-ear headset, orange vest collar. Environment for this view only: warm late-afternoon light, moderate swell, distant granite dome islands with pines. No studio background, no HUD, no text.
```
