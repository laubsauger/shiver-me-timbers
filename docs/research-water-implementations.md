# Research — "Water Pro 3.4" and the published state of the art on whitecaps

Status: research only. No code was written and nothing in `src/` was touched.
Written for the agents who will act on it. Every claim is tagged:

- **[DOC]** — stated in vendor documentation or a primary source. Checkable at the URL.
- **[INF]** — my inference from a documented fact. Labelled so you can disagree.
- **[GAP]** — I looked and could not find it. Not padding it with a guess.

Read `docs/talk-transcript.md` and `docs/transcript-learnings.md` first; this
document deliberately does not repeat the Rare/Sea of Thieves material.

---

## 0. If you read nothing else

The asset is **Three.js Water Pro** by Dan Greenheck — correctly identified, and
its documentation is genuinely informative (§1, §2). But the **published
literature and open source turned out to be the more valuable half** (§3), so do
not stop at §2.

Six findings, in the order they would change the picture:

1. **The real ocean is about 1 % foam at 10 m/s wind, 10 % at 20 m/s** (Monahan
   & O'Muircheartaigh 1980). Nobody appears to have calibrated a real-time foam
   field against this. Measure ours. "Big white blobs" may substantially be "far
   too much coverage".
2. **We composite foam as a lerp to near-white; the published forms are additive
   and coverage-weighted at albedo 0.4**, or alpha with a translucent sub-surface
   bubble layer underneath. Three independent implementations agree foam belongs
   partly *inside* the water. One small edit attacks both live complaints.
3. **Shadows should not be one multiply.** Crest routes hard shadow → sun glint
   and foam lighting, soft shadow → scatter (as a *lerp to a bluer colour*, not a
   darkening), and **never shadows the sky reflection at all**. That is the best
   available explanation for shadowed water looking wrong, and the fix is free.
4. **Our foam injects only on the fold (λ⁻); every reference also injects on the
   wind-facing rising flank.** A fold is a point test; a windward face is shaped
   like the wave and ends at the crest line. This is the "follows the crest
   structure" mechanism, and it is one dot product.
5. **Our residue clock (0.9 s, weight 0.30) is backwards from the measurements** —
   observed effective decay is 1.4–4.8 s and residual (Stage B) foam out-areas
   actively-breaking (Stage A) foam by 1.5–40×.
6. **Tessendorf says the minimum eigen*vector* gives the fold direction, then
   explicitly declines to develop it, and nobody has.** We already compute λ⁻.
   Ten more ALU gives a physically derived per-texel crest orientation where we
   currently use an invented fbm angle field.

There is also a **repo-level diagnostic in §2.11 that should be checked before
any of this**: an interim per-pixel crest-foam path in `surfaceMaterial.ts`, gated
by value noise (round level sets → discs), may be producing most of the foam the
complaint was made about — its own comment says the foam sim "at normal swell
currently produces nothing".

---

## 1. What the asset is

**Identified with high confidence: [Three.js Water Pro](https://threejsroadmap.com/assets/threejs-water-pro)
v3.4.0, by Dan Greenheck (DRG Software Solutions LLC), released 2026-08-14.**

Evidence:

- It is a **WebGPU + TSL FFT ocean for three.js** — the same engine, language and
  algorithm family as ours, not a Unity or Unreal asset. [DOC]
- Its version numbering reaches exactly **3.4**, and there is a migration guide
  literally titled *Migrating from v3.3 to v3.4*. The user's "3.4" is a version,
  not a product name. [DOC]
- "Any of the others from the same guy" resolves cleanly: the same author sells
  **[Three.js Sky Pro](https://threejsskypro.com)** (volumetric clouds, day/night,
  cloud shadows), bundled with Water Pro, and runs
  **[threejsroadmap.com](https://threejsroadmap.com/)**. [DOC]
- Corroborating detail: the `webgpu-threejs-tsl` Claude skill already installed in
  this environment is his — `~/.claude/plugins/marketplaces/webgpu-threejs-tsl`
  has `origin = git@github.com:dgreenheck/webgpu-claude-skill.git`. The author is
  already in this project's toolchain. [DOC]

I ruled out the Unity "Water Pro" (a legacy Unity Standard Asset, unrelated,
non-FFT) and the various Unity/Unreal ocean assets with similar names; none of
them versions to 3.4 and none is three.js.

**How much technical detail actually exists.** More than I expected, but all of
it is *parameter-level*, not *algorithm-level*:

- `docs.threejswaterpro.com` is a complete API reference plus a detailed
  changelog going back to v1.0.0. Parameter names, defaults, units and several
  sentences of mechanism per feature. This is the primary source and it is good.
- There is **no source, no dev blog, no conference talk, no forum thread with
  substance**. `github.com/dgreenheck/webgpu-water`, `.../threejs-water-pro` and
  `.../threejs-sky-pro` are all **404 (private)**. The 80.lv and TheRookies
  write-ups are press releases that restate the changelog — I checked, they add
  nothing. [GAP]
- The product **ships readable source** ("a digital product containing source
  code"; the docs tell you to edit `src/config/presets` and
  `src/config/QualityLevels.ts`; the build directory ships `index.js` **plus
  `index.js.map`**). Bundle price listed at $278 → $239 for Water + Sky. [DOC]
- The licence grants "Modify the Software solely for the purpose of creating End
  Products" but forbids decompiling the compiled code and forbids building a
  "Competing Product" derived from it. **I therefore did not open the live demo's
  JS bundle**, which would be the only other way to get real shader code. If we
  want the actual TSL, the clean route is to buy it. Building our own pirate game
  is an "End Product" and is not a Competing Product. [DOC]

So: I can tell you precisely *what knobs his foam has and what they mean*, which
turns out to be enough to reconstruct the model. I cannot show you his shader.

---

## 2. Techniques found

### 2.1 Foam is an **energy field with equilibrium semantics**, not an accumulator

This is the most important finding in the whole document.

[DOC] `water.foam.waves.persistence` has exactly three knobs:

| knob | default | documented meaning (verbatim) |
|---|---|---|
| `crestStrength` | 2.5 | "Crest-driven foam strength. **Equilibrium energy at a sustained sharp fold. Should exceed 1.0 to push fresh-crest foam to solid white through the dissolve mask**" |
| `windwardStrength` | 1.5 | "Windward-face foam strength. **Equilibrium energy on a fully wind-facing pixel.** Drives foam onto the rising face; persistence carries it past the crest" |
| `decayTime` | 0.5 s | "**Exponential e-folding time** in seconds (clamped at 0.05)" |

[INF] That vocabulary — *equilibrium energy*, *e-folding time*, *dissolve mask* —
describes a relaxation model, not our saturating accumulator:

```
E_target = max(crestStrength · foldGate, windwardStrength · windFacing)
E       += (E_target − E) · (1 − exp(−dt / decayTime))
foam     = E > dissolveTexture(uv)        // dissolve texture ~ U[0,1]
```

The wake system uses the same words independently — `foamStrength` "controls the
**equilibrium** foam energy", `foamPersistence` 0.99 per-frame decay,
`foamBreakThreshold` on `|∇h|` [DOC] — so the vocabulary is a house style, not a
one-off.

**Why this matters for the "big white blobs" complaint.** Two structural
differences from ours:

1. **Headroom above the dissolve threshold.** His energy runs to 2.5 at a
   sustained fold, against a threshold texture on [0,1]. Ours is
   `accumulateFoam = min(1, prev + injected)` — hard-clamped at 1 — and
   `foamMath.ts` records that in practice it needs ~100 ticks to reach **0.3**
   against a 77-tick mean visible age. [DOC, our repo]
   [INF] A field that lives at ~0.3 against a uniform [0,1] threshold keeps only
   the lowest ~30% of thresholds *everywhere it exists* — that is a wide, dim,
   low-contrast wash, which is exactly the "blob" read. A field that spikes to
   2.5 and e-folds through the [0,1] band in ~0.5 s is **solid white in a small
   core** and spends only a brief window in the band where the dissolve texture
   actually draws torn structure — so the structure appears as a moving ring at
   the edge of a bright cap instead of as a permanent mush. The interesting
   territory is where energy ≈ threshold, and his field *sweeps through* it while
   ours *parks in* it.
2. **Relaxation vs accumulation.** `E += (E_target − E)·k` reaches its target
   fast and cannot overshoot; `x ← (x + I)·decay` takes ~100 ticks and its
   equilibrium `I·decay/(1−decay)` depends on the decay constant, so tuning
   brightness and tuning lifetime are coupled. His are orthogonal.

Addresses: **blotchy foam** (primary). Cost: arithmetic only, no new samples.

### 2.2 Foam is injected by **two independent gates**, and the second one is the windward face

[DOC] v3.0.0 removed `foam.waves.windBias` with the note: "**Leading-edge gating
is now exclusively the persistent foam's job** … Use
`foam.waves.persistence.windwardStrength` to control how much foam appears on
**the rising face of waves**." The v3.1.0 WebGL parity fix says outright: "Foam
now **concentrates on the leading face** of waves." And the v3.0 highlight: "Foam
on whitecaps now persists and **rolls off the back of the wave** before decaying."

So his foam mass is `max(fold term, wind-facing term)`, and persistence carries
it *over the crest and down the back*.

**Ours has no windward term at all** — `src/foam/foamMath.ts` gates purely on the
minimum eigenvalue λ⁻ of the displacement Jacobian; `grep -i wind src/foam/foamMath.ts`
finds only commentary. [DOC, our repo]

[INF] This is very likely the single largest contributor to "does not follow the
crest structure". λ⁻ is a *point* test — it fires where the surface folds, which
is a scattered set of patches. A windward-face term is a *field* test —
`saturate(dot(normal.xz, windDir))` is high across the entire rising flank of
every wave and falls to zero on the lee, so it paints a continuous sheet that is
shaped like the wave, is bounded by the crest line, and has a hard trailing edge
at the crest. Fold-only foam has no reason to know where the crest line is;
windward foam is *defined by* it.

Addresses: **blotchy foam** (primary — this is the "follows the crest" mechanism).
Cost: one `dot` of the existing normal against a wind constant, inside the
existing inject pass. No new sample, no new texture, no new pass.

### 2.3 `windStretch` — anisotropy runs along the **wind**, not along the crest

[DOC] `water.foam.waves.windStretch`, default 0.5, range 0–1: "**Stretches foam
in wind direction for streaky whitecaps**."

Ours stretches along the **crest tangent** — `crestAnisoCoord()` in
`src/foam/foamShading.ts` builds `tan = perp(prop)` and divides the along-tangent
coordinate by `uElong`, i.e. features are elongated *parallel to the crest*,
perpendicular to the wind. [DOC, our repo]

**These are 90° apart.** [INF] Both are real, and they belong to different
lifecycle stages: a *fresh breaking cap* is crest-aligned (it is the crest), but
*decaying residue* gets dragged into downwind streaks. The Beaufort scale says
this explicitly at Force 8 (17.2–20.7 m/s): "the foam is **blown in well-marked
streaks along the direction of the wind**" [DOC,
[NWS](https://www.weather.gov/mfl/beaufort)] — and his own wave-tuning table
independently calls 13–18 m/s "**streaked foam**" [DOC]. We already have exactly the architecture to serve
both: the two-clock split. Breaking channel → crest-aligned; residue channel →
wind-aligned.

Addresses: **blotchy foam**. Cost: the anisotropic frame already exists; this is a
second call with a different axis, selected by the freshness ratio we already
compute. Arithmetic only.

### 2.4 Domain-warped foam is a *quality tier feature*

[DOC] The quality table lists "**Domain Warp Foam**" as an optional feature
enabled at High / Ultra / Max and off at Low / Medium — i.e. he considers it
expensive enough to gate, and important enough to ship.

We already do this (`foamWarpVec()`). Reported only as **corroboration that our
approach is the right one** — do not "add" it.

### 2.5 The foam field is camera-anchored and world-fixed, not cascade-tiled

[DOC] "The energy is carried in a **camera-anchored field** whose size and
resolution are fixed by the active quality level (**256 / 512 / 1024 / 2048**
texels per side for low/medium/high/ultra); these are **not runtime-tunable**."
v3.1.0: "Persistent wave crest foam now uses a **world-fixed texture that follows
camera**" and "**Swells and ripples now contribute** to wave crest foam."

Ours is per-cascade storage textures that tile with each cascade domain — which
is what the Rare talk describes, and which is free at the horizon.

[INF] He moved *away* from tiling because a tiled foam field repeats visibly; we
get repetition-immunity from `capVariationNode()` instead, which is cheaper. **Not
a recommendation** — see §5.

### 2.6 Three foam layers, three textures, four bundled JPGs

[DOC] `foam.surface` (ambient, static, size 20 m, coverage 0.5), `foam.waves`
(whitecaps, size 12 m), `foam.shoreline` (depth-based, size 10 m, `range` = 2 m
of water depth over which it fades). Four bundled tileable textures
`foam1`–`foam4`, selectable per layer.

That is **three texture bindings for foam**. We are at 17 sampled textures / 15
samplers against a 16-sampler cap. We fold crest and soft detail into **one**
texture sampled at two world scales, explicitly so they dedupe to one sampler
(`foamShading.ts` comment: "two texture objects would have cost both of the
ocean's spare samplers for one feature"). **Our arrangement is strictly better on
our budget.** See §5.

### 2.7 Transparency: there is no alpha. At all.

[DOC] v3.0.0, verbatim: "`color.alpha` **is removed**. Surface transparency is now
driven **entirely by absorption and Fresnel**, so a separate global opacity
control is redundant. … To make water more see-through everywhere, lower
`color.absorptionColor`; to make it opaque sooner, raise it."

The model, all documented:

- **Per-channel Beer–Lambert absorption** against one intrinsic `waterColor`
  (`#003366`) with `absorptionColor` (`#0a0503`) as the per-channel extinction
  coefficient *encoded as a colour*. Larger channel value ⇒ that channel absorbs
  sooner. The default is red-heavy, so blue survives deepest. The same
  attenuation is used above and below water (v3.0 unified underwater fog with it).
- **Full dielectric Fresnel**, cited to "Pharr et al., PBR §9.5.1", single
  `iorRatio` = 1.33, the *same curve* driving above-water reflect/refract mixing
  and below-water Snell's window / TIR. Not Schlick.
- **`transmissionColor`** (`#50a890`) — "**wave-crest transmission tint**", the
  colour of light coming *through* a thin backlit crest. This is a separate term
  from body colour, and the SSS system consumes it: "Custom mode uses
  `water.color.transmissionColor` for the crest tint."
- **Screen-space refraction**, `fresnel.refractionStrength` 0.1 (useful 0–0.5) —
  a UV offset on the scene-colour sample, giving seabed wobble from above and
  Snell's-window warp from below. Gated to High+ quality ("Screen Refraction").
- **Local Fresnel-based transparency** (v3.0 highlight, verbatim): "Looking nearly
  straight down at **thin** water (over a boat, sea floor, or shallow terrain),
  the surface **fades toward transparent** and the underwater scene shows through;
  **at grazing angles or over deep water the surface stays opaque**."
- **v3.4 physical mode**: `setJerlovType()` over ten Jerlov water types, deriving
  absorption/scattering/crest transmission from three constituents — `algae`
  (phytoplankton, raises green), `silt` (suspended mineral, "increases broad
  **backscatter** and turbidity"), `stain` (CDOM, absorbs blue, shifts brown).
  Oceanic IB = (0, 0.19, 0.01); Coastal 9C = (1.05, 2.0, 1.3). He is explicit
  these are "adjustable starting points rather than measured concentrations".

**The transferable idea is the framing, not the numbers**: transparency is not a
material property, it is a *result* of (Fresnel at this view angle) × (how much
water is between the surface and the thing behind it). A sea that is opaque at
grazing and see-through at nadir over shallow water reads as water; a sea with a
constant alpha reads as plastic at both.

Addresses: **"we're still missing a bunch of transparency"** (primary).
Cost: **the expensive one.** Needs a scene-colour sample and a scene-depth sample
behind the water. He gates screen refraction to High+ and renders his scene-colour
pass at 1/4× (low) to 1× (ultra) resolution to control it, and the associated
`SceneCapturePass` / `SceneDepthSampler` rebuild in v3.1.1 bought a 5–10% frame
win. See §4.11 for what a partial version costs us.

### 2.8 How foam composites — not documented

[GAP] Nothing in the documentation says whether foam replaces, adds to, or
modulates the water shading, whether it has its own normal or roughness, or how
its edges behave against the transparency model. `foam.waves` exposes only
`color`, `opacity`, `size`, `windStretch`, `enabled`, `foamTexture`.

[INF] `opacity` "Master opacity (0–1)" on a layer whose colour is `#ffffff`
suggests a lerp of the same shape as our `mix(col, foamCol, foamAmount)` (§T.42),
i.e. he probably has the same replacement problem we do. I would not build
anything on this inference. The one hint against it is that `foam1`–`foam4` are
JPGs, so single-channel-per-texture-slot budgeting is not driving his design the
way it drives ours.

**Do not treat "how does his foam composite" as answered.** If we want it, buying
the asset answers it in ten minutes.

For the record on our side, since §T.42 is quoted in briefs as though foam were a
total replacement: `surfaceMaterial.ts` caps `foamAmount` at `mask · 0.9` (and
`0.85` on the second branch), and already multiplies at least two later terms by
`1 − foamAmount` (lines ~1279, ~1424), so there *is* a translucency floor and
foam does already suppress the terms it should. What foam still lacks is its own
**normal** and **roughness** — a foam patch is currently a flat albedo swap
sitting in the water's shading, which is why it reads as a decal at the point the
eye expects a rough, self-shadowing crust. [DOC, our repo]

### 2.9 Shadows — the asset has no answer, but its sibling does

[DOC] Everything Water Pro documents about shadows:

- `water.lighting.sunLight` is a read-only handle to a **stock
  `THREE.DirectionalLight`**. The app sets `castShadow`, `shadow.mapSize`,
  `shadow.bias` (suggested `-0.0005`) and the shadow camera frustum. Default
  frustum is **±100 m**. That is it — no cascades, no custom shadow node, no
  special handling for a displaced surface.
- The shadow map is **reused to occlude caustics** on the seabed: "shadow-casting
  objects block the dancing caustic pattern"; disabling `castShadow` restores
  un-occluded caustics.

[GAP] **There is no documented mechanism for the water surface itself receiving a
shadow.** I grepped the entire Water Pro doc set; "shadow" appears only in the
contexts above. This is a genuine dead end for our complaint — either his ocean
does not receive shadows either, or he does it silently.

**The real find is in Sky Pro**, and it is directly usable
([shadows guide](https://docs.threejsskypro.com/guide/shadows.html)) [DOC]:

- Clouds are baked into a **top-down cloud-coverage map**, resolution 128–1024
  square, `extent` 4000 m half-width (an **8 km box centred on the camera**),
  `mipLevel` 1–3 to soften cheaply, `lightSteps` 8 marching through the cloud
  shell per texel, `bakeInterval` to re-bake every Nth frame.
- It is consumed by assigning it to the three.js light:
  `sunLight.shadow.shadowNode = sky.cloudShadow(positionWorld)` — and critically,
  `sunLight.shadow.mapSize.set(64, 64)` with the comment "**the depth-compare map
  goes unused, keep it tiny**". A flat XZ world-position lookup replaces the
  depth-compare entirely.
- Explicit shading rule, verbatim: "multiply `sky.cloudShadow(worldPos)` into
  **direct light only. Do not apply it to ambient or sky lighting**."
- Per-material attenuation without changing the global:
  `mix(1.0, cloudShade, 0.6)`.
- Stated limitations, honestly: cloud-cast only (no object-to-object shadows);
  "flat top-down lookup, **not a true directional shadow map** — least accurate at
  very low sun elevation"; finite footprint, receivers outside the box read full
  sun; shared with god rays.

Addresses: **"shadow casting is maybe not perfect"** — partially, and from an
angle we have not tried. Cost: one texture sample (exactly our one contested
spare) plus a cheap bake pass.

### 2.10 Wave-field facts worth knowing, tangentially

- [DOC] **Spectrum is JONSWAP with size decoupled from energy**: `peakWavelength`
  (default 70 m) sets the dominant wave size *directly*; `windSpeed` sets energy
  and steepness *at that size*, independently. `spectralSharpness` multiplies a
  **Hasselmann 1980 frequency-dependent directional spread**, normalised so total
  energy is constant as spread changes — so ripples come out near-omnidirectional
  while the dominant sea tracks the wind, from one parameter.
- [DOC] **Cascade tiles are derived, not chosen**: one number `maxScale` (default
  **1024 m**) sizes the swell tile, and each later cascade derives its tile from
  `maxScale` and the resolutions before it "so adjacent bands **abut without a gap
  or overlap**". At `maxScale` 1024 the tiles are **1024 / 96 / 9 m**. Ours are
  253 / 59 / 13.7 m. He notes explicitly that `maxScale` "is the distance at which
  the swell field repeats, so a larger value pushes any visible tiling farther
  away" — worth weighing against the handoff's "looking into the abyss" and
  vision-range critique.
- [DOC] v3.3.0 **removed the Gerstner swell layer entirely**: "The wave spectrum
  now produces large swells on its own." He had added Gerstner in v2.0 to fix FFT
  tiling and removed it two majors later.
- [DOC] He uses **SSR, not planar reflections** — `strength` 0.8 blend against
  sky, `thickness` 0.1 to reject false hits, cost made independent of screen
  coverage in v3.0. This *contradicts* Rare's explicit "we just use planar water
  reflections, not screen space" [talk 03:59]. Two shipped systems, opposite
  choices. Our T30/V26 picked planar on Rare's authority; that is still defensible
  (SSR cannot reflect anything off-screen, which is most of a mast), but it is no
  longer unanimous.
- [DOC] **Fog**: `fadeStart` 500 / `fadeEnd` 1800 / `skyBlendDistance` 1500, and
  the fog colour **blends toward the sampled sky colour** with distance "so that
  the horizon has **no visible seam**". Ours is 900–4200 with no sky blend. This
  is one cheap trick against the "blown out white sky / short vision range" pair.
- [DOC] Buoyancy: the inverse of the horizontal displacement is **iterated, not
  single-stepped**, "so it converges on steep crests where buoyant objects
  previously floated above troughs or sank under crests" (v3.1.0 fix). Also,
  readback is non-blocking, at the cost of heights being one frame stale, worth
  ~2 ms CPU.

### 2.11 A diagnostic that came out of comparing the two — read this before acting

While checking his injection model against ours I found something that changes
where the shortlist should point. `src/ocean/surfaceMaterial.ts` (~line 1164)
carries an **interim per-pixel crest-foam path**, separate from the foam sim, and
its own comment says:

> "INTERIM (§Rule 8 — this is NOT §T.5). The foam sim owns real whitecap
> injection; **at normal swell it currently produces nothing**, so the sea reads
> 'synthetic, like a weird liquid' (user). This adds sparse foam on the steepest
> crest tops so swell is not bare…"

That interim path gates coverage with `bandNoise()` — **`valueNoise` over world
XZ**. `src/foam/foamPattern.ts`'s own header states the failure mode precisely:
"VALUE NOISE HAS ROUND LEVEL SETS … Threshold it and you get discs; that is the
user's 'blotchy, reads as discs'."

[INF] If that comment is still accurate, then **at the default swell preset most
or all of the foam the user is looking at is coming from the interim per-pixel
gate, not from the foam sim** — and therefore not from the λ⁻ pipeline that
§V.58, the two-clock split and the injection jitter were all built to fix. Every
measured win recorded in the handoff (58.8% → 92.4% crest placement, p90 34.0 →
14.9 m) is a property of the *sim*, which by this comment is idle at the sea
state the complaint was made against.

**First action for whoever picks this up: confirm or refute that.** Turn the
interim `uFoamPatch` path off at the default preset and look at the sea. If the
foam mostly vanishes, the blob complaint is about the interim gate and the
recommendations below change priority sharply — because §4.4 (windward-face
injection) is *also the thing that makes the sim produce foam at normal swell*: a
wind-facing flank exists at every sea state, whereas a fold does not. That would
make one change fix both the "sim produces nothing at swell" problem and the
"blobs" problem, and let the interim value-noise path be deleted rather than
tuned.

This is [INF] and the code comment may be stale — hence "confirm or refute", not
"do this".

---

## 3. Published literature and open source — more useful than the asset

I set out to treat this as a fallback in case the commercial product had no
detail. It turned out to be the *better* half of the research, because
**[Crest Ocean System](https://github.com/wave-harmonic/crest) is MIT-licensed
and its foam and shadow code is readable**, and because Dupuy & Bruneton's
whitecap paper ships source. The Crest excerpts below are MIT and can be learned
from and adapted directly. I did **not** check the licence on
`github.com/jdupuy/whitecaps` — verify it before lifting code rather than ideas;
the *method* in §3.2 is published in a peer-reviewed paper and is free to
implement regardless.

### 3.1 Whitecap coverage — there is a physical number, and we should measure against it

[DOC] The standard parameterisation is **Monahan & O'Muircheartaigh 1980**
([AMS abstract, verbatim](https://journals.ametsoc.org/view/journals/phoc/10/12/1520-0485_1980_010_2094_opldoo_2_0_co_2.xml)):

```
W = 2.95e-6 · U10^3.52     (ordinary least squares)
W = 3.84e-6 · U10^3.41     (robust biweight — the one usually quoted)
```

W is a **fraction**, U10 the 10 m wind speed in m/s. Attested in multiple
independent reviews
([ACP 2016](https://acp.copernicus.org/articles/16/13725/2016/acp-16-13725-2016.pdf),
[Anguelova & Webster 2006](http://magde.info/main/texts/journals/2006_JGR_AnguelovaWebster_whitecapSatellite.pdf)).
The general form `W = a·U10^b` with **b between 2 and 4** is the predominant
model across the field
([Schwendeman & Thomson 2015](https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2015JC011196)),
and the exponent rises with sea-surface temperature — so treat this as an order
of magnitude, not a constant of nature.

Evaluated (my arithmetic, from the formula above):

| U10 | Beaufort-ish | W (whitecap area fraction) |
|---|---|---|
| 3 m/s | light breeze | **0.02 %** |
| 5 m/s | gentle | **0.09 %** |
| 8 m/s | moderate | **0.46 %** |
| 10 m/s | fresh breeze | **0.99 %** |
| 15 m/s | near gale | **3.9 %** |
| 20 m/s | storm | **10.5 %** |
| 25 m/s | violent storm | **22.5 %** |

**This is the most quietly alarming number in the document.** At a normal sailing
sea state the real ocean is about **one percent** foam. Whatever fraction of our
sea is currently white, it is worth *measuring* — the foam sim already writes a
mask we can average on the GPU or in the CPU mirror.

[INF] "Big white blobs" may be, in part, simply **too much coverage**. A 1%
coverage budget forces caps to be small and sparse, which is the same visual
outcome the cap-size work (p90 34.0 → 14.9 m) was chasing by a different route.
And it interacts with §4.2: with a relaxation model you can raise brightness to
solid white *and* cut coverage at the same time, which you cannot do with a
single clamped accumulator where coverage and brightness are the same number.

**Lifetimes.** [DOC] Monahan & Woolf 1989 split a whitecap into two stages, and
the split is the same shape as our two clocks:

- **Stage A** — the actively breaking crest: air entrainment, bubble-plume
  creation. Forms over roughly **one third of a wave period**; ends when air is
  no longer being entrained.
- **Stage B** — the residual foam patch left behind: plume rise, degassing, then
  decay of the residual foam. Longer-lived than Stage A.

Quantitatively, from [Callaghan, Deane & Stokes, JPO 2013](https://journals.ametsoc.org/view/journals/phoc/43/6/jpo-d-12-0148.1.xml)
and [Callaghan et al., JGR 2012](https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2012JC008147) [DOC]:

- **Decaying (Stage B) foam contributes between 1.5× and 40× the area that
  actively-breaking (Stage A) crests do.** At any instant, the sea is mostly
  *residue*, not *breaking*.
- Per-event foam decay times span **0.2 s to 10.4 s** — a factor of 50. The
  **area-weighted "effective" decay time ranged 1.4 s to 4.8 s** across
  observation periods (552 breaking waves, Martha's Vineyard 2008).
- Bigger patches live longer (positive correlation between decay time and maximum
  patch area). Surfactants stabilise foam by roughly **3×**.
- Growth is **approximately linear**, then decay is close to **exponential**;
  `τ_form` has been measured at **20–100 % of τ_decay**, so the ramp-up is not
  negligible ([AMS Discrete Whitecap Method reassessment, open PDF](https://ams.confex.com/ams/95Annual/webprogram/Manuscript/Paper260568/AMS,%2017CAChem.,J1.%204,%20DWM.,%20Reassess,paper,ver.%20H.pdf)).
- Monahan's W above is the **sum** of Stage A and Stage B coverage, not just
  breaking crests.

Our clocks are **0.15 s breaking and 0.9 s residue**, weighted 1.0 / 0.30. Water
Pro's single `decayTime` default is **0.5 s**. Two mismatches against the
measurements, both pointing the same way:

- our residue clock is **~2–5× shorter** than the effective decay time, and
- our residue is weighted **0.30 against the breaking channel's 1.0**, whereas
  physically Stage B out-areas Stage A by 1.5–40×.

[INF] Short-lived, under-weighted residue cannot develop structure — it vanishes
before advection, stretching or the dissolve threshold have had time to sculpt
it, so every cap reads as a stamp rather than a trail. Lengthening the residue
clock toward ~2–3 s, *raising* its weight, and cutting peak coverage toward ~1 %
is a three-constant change with physical justification and zero shader cost. Also
worth noting: injection should **ramp**, not step, since τ_form is a fifth to a
whole τ_decay.

### 3.2 Dupuy & Bruneton 2012 — the paper that targets our exact complaint

**"Real-time Animation and Rendering of Ocean Whitecaps", SIGGRAPH Asia 2012
technical brief. [Paper PDF](https://liris.cnrs.fr/Documents/Liris-5812.pdf) ·
[HAL record](https://inria.hal.science/hal-00967078v1) ·
[source, github.com/jdupuy/whitecaps](https://github.com/jdupuy/whitecaps).**

This is the most important item in the literature half and I nearly missed it. It
attacks precisely the complaint "the foam does not reflect the sub-tessellations
of the ocean surface", and it is arithmetic-only.

**The idea** [DOC]. Do not threshold the Jacobian per pixel — that is a binary
test on a sub-pixel field, which is why it blobs and why it crawls at distance.
Instead treat the Jacobian determinant `j` **within the pixel footprint as a
Gaussian random variable** and compute the *fractional coverage of that pixel*
analytically, as a Gaussian CDF:

```
W = (1/A) ∬_A Υ(ε − j(p,t)) dp                       (Υ = Heaviside)
W ≈ 1/2 + 1/2 · erf( (ε − μ_A) / sqrt(2 σ²_A) )       (paper eq. 6)
```

where `μ_A`, `σ²_A` are the mean and variance of `j` over the footprint and `ε`
is the breaking threshold. The paper's key practical point: those two moments
"can be evaluated using **fast linear pre-filtering** methods such as the
**hardware accelerated mipmap generator**". Expanding over cascades, the cross
terms are products of uncorrelated fields and average to zero, so you only need
per-cascade `k_i` and `k_i²` in mip-mapped textures:

```
k_i  = 1/n + a_i + b_i + a_i·b_i − c_i²
       with a_i = λ_i ∂u_i/∂x,  b_i = λ_i ∂v_i/∂y,  c_i = λ_i ∂u_i/∂y
μ_A  = (1/A) Σ_i ∬ k_i
σ²_A = −μ_A² + (1/A) Σ_i ∬ k_i²
```

The shipped [`ocean.glsl`](https://github.com/jdupuy/whitecaps/blob/master/ocean.glsl):

```glsl
float whitecapCoverage(float epsilon, float mu, float sigma2) {
    return 0.5*erf((0.5*sqrt(2.0)*(epsilon-mu)*inversesqrt(sigma2))) + 0.5;
}
vec2 jm = jm1+jm2+jm3+jm4;
float jSigma2 = max(jm.y - (jm1.x*jm1.x + jm2.x*jm2.x + jm3.x*jm3.x + jm4.x*jm4.x), 0.0);
float W = whitecapCoverage(jacobian_scale, jm.x, jSigma2);
```

and a polynomial `erf` we can lift, since WGSL has none:

```glsl
float error_function(float x) {
    float a = 0.140012; float pi = 3.14159265;
    float x2 = x*x; float ax2 = a*x2;
    return sign(x) * sqrt( 1.0 - exp(-x2*(4.0/pi + ax2)/(1.0 + ax2)) );
}
```

**And the compositing, which is the transparency answer** [DOC]. Foam radiance is
**coverage-weighted and additive**, over a Lambertian layer of **albedo 0.4**
(citing Premožé & Ashikhmin 2001, Koepke 1984):

```
R ≈ W·R_F + R_C + R_W                                 (paper eq. 2)
vec3 l = (Lsun * max(dot(N, worldSunDir), 0.0) + Esky) / M_PI;
gl_FragColor.rgb += vec3(W * l * 0.4);                // R_ftot
```

Contrast with `mix(col, foamCol, foamAmount)` (ours, §T.42): at coverage 0.4, a
lerp to a 0.905-luminance white **deletes 40 % of the water's own light
response**; the additive form adds 40 % of a **0.4-albedo Lambert layer** and the
water underneath stays visible. That single edit plausibly addresses both live
complaints at once — "blobs" and "too opaque" — and it is about three ALU.

Reported cost: whole scene under **10 ms at 1280×720 on a GeForce 560 Ti** (2012
hardware).

**Fit against our constraints:** we already compute per-cascade Jacobian
quantities. Storing `k` and `k²` is a **channel-packing change in existing FFT
output textures plus a mip chain**, not a new sampler. This is the single
best-matched published technique to our situation that I found.

[DOC] The paper's own stated limitation is worth repeating: "our model only
produces whitecaps whenever a wave breaks, but **does not handle their decay**
which can last up to several seconds" — i.e. it is the *coverage* half done
properly, and our persistent foam RT is the *decay* half done properly. They are
complementary, not alternatives.

### 3.3 Crest Ocean System — the foam model, from actual source

MIT licence. Files: `crest/Assets/Crest/Crest/Shaders/Resources/UpdateFoam.compute`
and `crest/Assets/Crest/Crest/Shaders/OceanFoam.hlsl`.

**a. The simulation** (`UpdateFoam.compute`) [DOC — this is the code]:

```hlsl
// advect: read last frame at the position the water flowed FROM
const half2 velocity = _LD_TexArray_Flow.SampleLevel(...).xy;
const float2 worldPosXZ_flowed = worldPosXZ - _SimDeltaTime * velocity;
foam = _LD_TexArray_Foam_Source.SampleLevel(..., WorldToUV(worldPosXZ_flowed, ...));

foam *= max(0.0, 1.0 - _FoamFadeRate * _SimDeltaTime);          // decay

const float det = determinant(jacobian);                        // det J, not λ⁻
foam += 5.0 * simDeltaTime * _WaveFoamStrength
      * saturate(_WaveFoamCoverage - det + foamBase * 0.7);     // SOFT ramp injection

foam += _ShorelineFoamStrength * simDeltaTime
      * saturate(1.0 - signedOceanDepth / _ShorelineFoamMaxDepth);
_LD_TexArray_Target[id] = saturate(foam);
```

Three things worth taking:

1. **Foam is advected**, semi-Lagrangian, by sampling last frame's foam at
   `pos − dt·velocity`. Our ocean foam sim decays and blurs but — as far as I can
   see in `src/foam/foamPasses.ts` — does **not** advect (our `flowfoam`
   accumulator does). [INF] Advection is a large part of "rolls off the back of
   the wave": foam that does not move relative to the water cannot trail.
2. **Injection is a `saturate` ramp, not a hard gate.** `saturate(coverage − det)`
   gives a soft shoulder, so the foam field has an intrinsic gradient at cap
   edges instead of a binary boundary that the blur then rounds into a disc.
3. They also fall back to the **next coarser cascade** when a sample lands
   outside the current one, rather than dropping to zero.

Note they use **det J**, which §V.58 correctly identifies as direction-free. Our
λ⁻ is the better metric. This is one place we are ahead.

**b. The shading** (`OceanFoam.hlsl`) — this is the valuable file.

**The dissolve, with a named feather parameter** [DOC]:

```hlsl
i_foam = saturate(1.0 - i_foam);                       // foam amount -> threshold
return smoothstep(i_foam, i_foam + _WaveFoamFeather, ft);   // ft = tiled foam texture
```

So: high foam ⇒ low threshold ⇒ more of the texture survives. `_WaveFoamFeather`
is the width of the transition — the single knob that decides "torn edge" vs
"hard cutout" vs "soft blob". Shipped defaults: **`_WaveFoamFeather` = 0.4**
(range 0.001–1.0), `_FoamScale` = 10.0. Crest's user docs describe it in prose:
"Foam Feather — controls how gradual the transition is from full foam to no foam"
([water appearance](https://crest.readthedocs.io/en/latest/user/water-appearance.html)).
We do the equivalent; the *feather as an explicit tunable* is the detail worth
copying, and its interaction with §4.2 is the whole game.

Sim-side defaults for calibration reference (`SimSettingsFoam.cs`):
`_foamFadeRate` = 0.8 (0–20), `_waveFoamStrength` = 1.0 (0–5),
`_waveFoamCoverage` = 0.55 (0–1, "higher values will lower the threshold for foam
generation"), sim at **30 Hz** in **R16_SFloat**. There is also a `_filterWaves`
knob — "the minimum LOD to sample waves from … increasing will exclude lower
wavelengths **which can help with too much foam near the camera**", which is a
targeted answer to a failure mode we have hit from the other direction (§2.5,
cascade banding).

**A second, independent instance of the same dissolve family** [DOC]: Yingst,
Alford & Parberry, *Very Fast Real-Time Ocean Wave Foam Rendering Using
Halftoning*, GAMEON-NA 2011
([PDF](https://ianparberry.com/pubs/GAMEON-NA_GRAPH_04.pdf)). They threshold a
foam saturation function against a **precomputed halftone mask** and — the part
that matters — they document that the mask's **clustering statistics** decide
whether it reads as foam. Their masks are Gaussian-filtered white noise, and
**σ = 24 gives "adequate visual clusters of foam"** where σ = 1.5 (blue-noise-like,
evenly spread isolated dots) reads wrong. They also explicitly reject plain alpha
fade: "Foam does not simply fade or become transparent as the bubbles dissipate."
Measured overhead versus a plain texture fade: **under 3 %**.

[INF] Read against our `foamPattern.ts`: our Worley wall network is a *clustered*
field by construction, so we are on the right side of this result — but the
`FOAM_BREAKUP_CELLS` density is exactly the σ-equivalent knob, and it is worth
sweeping deliberately rather than assuming.

**Foam gets its own normal — from finite differences of the dissolved foam
itself** [DOC]:

```hlsl
float2 dd = float2(0.25 * i_pixelZ * i_texture._texel, 0.0);   // delta scales with distance
half whiteFoam_x = WhiteFoamTexture(..., dd.xy, ...);
half whiteFoam_z = WhiteFoamTexture(..., dd.yx, ...);
half dfdx = whiteFoam_x - whiteFoam, dfdz = whiteFoam_z - whiteFoam;
half3 fN = normalize(i_n + _WaveFoamNormalStrength * half3(-dfdx, 0.0, -dfdz));
half foamNdL = max(0.0, dot(fN, i_lightDir));
o_whiteFoamCol.rgb = _FoamWhiteColor.rgb
  * (AmbientLight() + _WaveFoamLightScale * _LightColor0 * foamNdL * i_shadow);
half3 refl = reflect(-i_view, fN);
o_whiteFoamCol.rgb += pow(max(0., dot(refl, i_lightDir)), _WaveFoamSpecularFallOff)
  * _WaveFoamSpecularBoost * _LightColor0 * i_shadow;
```

**This is the direct answer to §T.42's "foam has no normal and no roughness".**
And critically for us: it costs **two extra taps of the texture we are already
sampling** — same texture object, same sampler, no new binding. The delta is
scaled by `i_pixelZ` so the relief holds up with distance rather than
disappearing into the mip chain. Foam ends up with a diffuse `N·L` term *and* a
Phong lobe, both multiplied by shadow.

**Foam composites as alpha, over a second, additive, sub-surface layer** [DOC]:

```hlsl
o_whiteFoamCol.a = _FoamWhiteColor.a * whiteFoam;          // white foam: ALPHA over water
// separate layer, sampled at mip 3 for a free blur, with a parallax offset:
float2 parallaxOffset = -_FoamBubbleParallax * i_view.xz / dot(i_n, i_view);
o_bubbleCol = bubbleFoamTexValue * _FoamBubbleColor.rgb
            * saturate(i_foam * _WaveFoamBubblesCoverage) * AmbientLight();
```

Two layers, two composite modes: **sub-surface bubbles are additive, blurred (a
forced mip level, free), parallax-offset so they sit *below* the surface and tinted
by ambient only**; **surface white foam is alpha-composited on top**. That is the
answer to "how translucent is foam at its edges" — the white layer's alpha
carries the edge, and underneath it the bubble layer keeps the water reading as
water rather than as a hole.

**Anchoring** [DOC]: white foam samples at **undisplaced** world XZ; bubbles at
`lerp(undisplaced, displaced, 0.7)` plus a wind-direction scroll
(`0.5 * _CrestTime * windDir`) plus a normal-driven offset (`0.125 * i_n.xz`).
[INF] Sampling the foam texture in the *undisplaced* (Lagrangian) frame is why
the foam pattern travels with the wave instead of the water sliding beneath a
world-locked decal — worth checking which frame ours uses.

**Depth feathering** [DOC]:
`foamAmount *= saturate((i_sceneZ - i_pixelZ) / _ShorelineFoamMinDepth);` — foam
fades out where the water is thin against scene geometry, so it never hard-edges
against a hull.

**Flow ping-pong** [DOC]: `ComputeFoamWithFlow` samples twice with offsets
`fmod(t, 2)` and `fmod(t+1, 2)` and triangle-wave weights, so flow-distorted UVs
reset every cycle instead of shearing without bound. Standard flowmap practice,
but a clean reference implementation.

Add to that the foam-normal defaults, since they are the ones to start from:
`_WaveFoamNormalStrength` = **3.5** (0–30), `_WaveFoamSpecularFallOff` = **293**
(1–512), `_WaveFoamSpecularBoost` = **0.15** (0–16), `_WaveFoamLightScale` =
**1.35**; and for the bubble layer `_FoamBubbleParallax` = 0.14,
`_WaveFoamBubblesCoverage` = 1.68. The crucial detail is that the finite
difference is taken on the **already-thresholded** foam value, not on the raw
density — so the relief comes from the foam texture's own torn structure, which
is exactly the "sub-tessellation detail" the user is asking for. [DOC]

### 3.4 War Thunder / Gaijin — foam as an advected *turbulent energy* field

[DOC] *Ocean simulation and rendering in War Thunder*, NVIDIA CGDC 2015
([slides PDF](https://developer.download.nvidia.com/assets/gameworks/downloads/regular/events/cgdc15/CGDC2015_ocean_simulation_en.pdf)).
Verbatim slide text, in order — note that they name our exact failure mode:

- "Jerry Tessendorf proposal: use Jacobian of flat→displaced transform. … **We use
  J < M, M ~ 0.3 .. 0.5**"
- "Modulate foam textures by `saturate(k*(-J+M))`. Breaking areas look better.
  **Foam disappears!**"  ← this is the slide that motivates everything after it
- "Breaking waves **inject turbulent energy** to cascades. Energy **dissipates
  over time and in space**." — illustrated as exponential fade *plus* blur.
- "Foam simulation results, colour coded: Breaking areas / Turbulent energy /
  **Surface stretching**. **Stretching is important for foam layer: stretched →
  thinner, squeezed → thicker**"
- "**Turbulent energy = foam intensity. Modulate foam textures by energy and
  stretching.** Add dense foam on breaking areas."
- "…and mixed-in bubbles! Add **'milkiness' modulated by energy to refraction
  colour**"

Two takeaways we do not have:

1. **Stretch modulates foam thickness.** We use the Jacobian's *determinant-like*
   fold metric (λ⁻) and nothing else. The **diagonal/trace** part of the same
   matrix is local stretch-vs-squash, independent of folding, and using it to
   thin foam over stretched water and thicken it over squeezed water breaks a
   patch into structure that is *aligned with the wave geometry* rather than with
   a noise field. Pure ALU on data we already compute. [DOC as their technique;
   [INF] that it maps cleanly onto our λ⁻ pipeline.]
2. **Foam's transparency contribution is "milkiness in the refraction colour"**,
   not a white overlay. Consistent with Dupuy & Bruneton's additive form and with
   Crest's sub-surface bubble layer — three independent implementations all
   putting part of the foam *inside* the water rather than *on top of* it.

Their 2026 "Ninth Wave" dev post adds, as a claim without shader detail
([warthunder.com](https://warthunder.com/en/news/9957)): "The foam structure
itself now has a **microrelief**: an overlay **normal map** causes highlights to
glide across the bubbles, creating the effect of a three-dimensional, slowly
settling suspension." [DOC as a dev-blog statement — no math given.]

### 3.5 Crest's shadows on water — the one real technique I found for complaint #3

`crest/Assets/Crest/Crest/Shaders/ShaderLibrary/UpdateShadow.hlsl` and
`SimSettingsShadow.cs`, MIT.

Crest **does not sample the shadow map in the water shader**. It bakes shadow
into the ocean's own world-space LOD cascade textures, in a separate pass, with
jittered sampling and temporal accumulation [DOC]:

```hlsl
// one jittered tap per texel per frame, not a PCF kernel:
positionWS.xz += i_jitterDiameter * (hash33(uint3(abs(positionWS.xz*10.0), _Time.y*120.0)) - 0.5).xy;
...
shadow = lerp(shadow, shadowThisFrame, _JitterDiameters_CurrentFrameWeights.zw * _SimDeltaTime * 60.0);
```

with two independent channels and these shipped defaults (`SimSettingsShadow.cs`):

| channel | jitter diameter | current-frame weight |
|---|---|---|
| **soft** | **15 m** | **0.03** ("responsiveness") |
| **hard** | **0.6 m** | **0.15** |

So a 15-metre-wide penumbra is built from *single taps* accumulated over roughly
30 frames, and a tight contact shadow is accumulated over ~7. Supporting details,
all in the source:

- `positionWS.xyz += displacement;` before projecting — "Add displacement so
  shorelines do not receive shadows incorrectly." The shadow is looked up at the
  **displaced** position, which is the non-obvious part on a choppy FFT surface.
- The tap is only taken when the point **projects inside the main camera
  frustum** (`abs(projected.xy) < 1 && 0 < projected.z < 1`); outside, the texel
  keeps its history. This is what makes the world-space cascade survive a
  screen-space shadow source.
- A **shadow-bleed guard**: if the jittered position lands below terrain height,
  return "no shadow" rather than sampling through the terrain.
- `CrestComputeShadowFade(positionWS)` fades shadows out with distance.
**And then — the part that matters most — the two channels drive *different
lighting terms*** [DOC, `Ocean.shader` and `OceanReflection.hlsl`]:

```hlsl
fixed2 shadow = (fixed2)1.0 - input.flow_shadow.zw;   // .x = soft, .y = hard
ComputeFoam(...,        shadow.y, ...);   // HARD shadow -> foam lighting
ScatterColour(...,      shadow.x, ...);   // SOFT shadow -> scatter / SSS
ApplyReflectionSky(..., shadow.y, ...);   // HARD shadow -> sun GLINT only
```

and inside the reflection:

```hlsl
skyColour += pow(max(0., dot(refl, i_lightDir)), fallOff)
           * _DirectionalLightBoost * _LightColor0 * i_shadow;   // glint lobe only
float R_theta = CalculateFresnelReflectionCoefficient(max(dot(i_n_pixel, i_view), 0.0));
io_col = lerp(io_col, skyColour, R_theta * _Specular * i_weight);   // sky NOT shadowed
```

**The shadow multiplies only the directional sun-glitter lobe. The environment /
sky reflection is never shadowed at all.** And the scatter term is not multiplied
by shadow either — it is **lerped toward a separate, hue-shifted shadow colour**:
`_DiffuseShadow` default `(0.0, 0.0013, 0.0849)` and `_SubSurfaceShallowColShadow`
default `(0.0, 0.0054, 0.17)` — deliberately *bluer*, not merely darker.

[INF] **This is the single best explanation I found for "our shadow casting is
maybe not perfect".** A shadow applied as a uniform multiply on the final colour
kills glint, sky reflection and subsurface scatter together, and a patch of real
ocean in shadow still reflects the entire sky — so uniform-multiplied shadowed
water reads as a dead grey hole punched in the sea. The fix is free: shadow the
sun glint, shadow the foam's direct lighting, tint the scatter toward a bluer
shadow colour, and leave the environment reflection alone.

[DOC] Crest's own code also documents an engine-level reason water shadows go
wrong: caustics use a separate screen-space shadow texture with the comment
"Normally, we would use `SHADOW_ATTENUATION()`, but `SHADOWS_SCREEN` and
`UNITY_NO_SCREENSPACE_SHADOWS` are **not handled for the transparent pass**."
Our ocean is `material.transparent = true` (§V.24) — the same class of problem
may be why `receiveShadow` is inert for us.

[INF] On the architecture: a huge, displaced, moving surface sampled per-fragment
against one tight shadow map produces swimming, aliased, acne-prone results, and
PCF-widening it is unaffordable. Crest's answer is to move the shadow into the
ocean's own low-frequency world-space representation and buy softness with *time*
instead of with taps. Generic CSM background supports the acne half: cascaded
shadow maps "create striping artifacts when the surface being lit is nearly
parallel to the direction of the light"
([NVIDIA CSM paper](https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf)) —
an ocean under a low sun is exactly that case. I found **no ocean-specific
published treatment of shadow acne on displaced water vertices**. [GAP]

Cost for us: a new pass and — the sticking point — **a new texture and sampler**,
which we do not have alongside the cloud-shadow idea in §2.9. The two compete for
the same slot. See §4.10.

### 3.6 Transparency, from the same open sources

Three concrete things beyond §2.7's parameter list, all readable code:

**a. Per-channel Beer–Lambert against scene depth, with a refraction guard**
[DOC, Crest `OceanEmission.hlsl`]:

```hlsl
float2 refractOffset = _RefractionStrength * i_n_pixel.xz;
// kill the refraction offset as the scene surface approaches the water surface
if (!i_underwater) refractOffset *= min(1.0, 0.5 * (i_sceneZ - i_pixelZ)) / i_sceneZ;
...
depthFogDistance = sceneZ - i_pixelZ;
alpha = 1.0 - exp(-_DepthFogDensity.xyz * depthFogDistance);   // float3, per channel
col = lerp(sceneColour, col, alpha);
```

`_DepthFogDensity` being a **float3** is the whole point: red dies in about a
metre, blue survives tens. It also re-samples depth at the *refracted* UV and
cancels the offset if the refracted sample landed in front of the water — the
standard fix for objects bleeding through the surface at contact.

**b. The energy split that decides whether water looks opaque** [DOC, Crest and
[GarrettGunnell/Water](https://github.com/GarrettGunnell/Water) independently]:

```
output = (1 - F) * scatter + specular + F * envReflection
```

[INF] If our scatter/SSS term is added on top of a full-strength reflection
rather than Fresnel-weighted against it, the surface will read opaque no matter
what we do to the body colour — the two brightest terms both survive at every
angle. Worth auditing `surfaceMaterial.ts` for this specific shape before
anything more expensive is attempted; it costs nothing to check.

**c. Foam should modulate roughness** [DOC, GarrettGunnell]:
`float a = _Roughness + foam * _FoamRoughnessModifier;` fed into a
Beckmann + Smith BRDF. Cheap, and it is half of what §2.8 says our foam is
missing.

### 3.7 What was looked for and not found

- **[GAP] A shipped-game writeup of how whitecap *placement and shape* are
  decided.** Rare's talk (already in `docs/talk-transcript.md`) remains the most
  specific thing in the public record. The AC4 Black Flag material is
  journalism-level only — [fxguide](https://www.fxguide.com/fxfeatured/5-things-you-need-to-know-about-the-tech-of-assassins-creed-iv-black-flag/)
  mentions foam colour ramps for "coarse, sparse, medium" foam density with
  transparency in RGB ramps, but gives no math. The Uncharted and Atlas GDC talks
  are video-only on GDC Vault and could not be mined without watching them.
- **[GAP] Anyone using Monahan's coverage law to calibrate a real-time
  renderer.** Dupuy & Bruneton cite Anguelova & Webster for *motivation* but
  derive their coverage purely from Jacobian statistics, uncalibrated against any
  W(U10) law. The oceanography and the graphics literature do not appear to have
  been joined up in public. If we do it we are ahead of the published state of
  the art, and it costs one average over a texture.
- **[GAP] Anisotropic stretching of the foam lookup along the wind vector.**
  Langmuir circulation and wind-aligned foam windrows are documented physics;
  Crest's `windDir` is directional *scroll*, and War Thunder's stretch is
  Jacobian-driven, not wind-driven. Nobody appears to have published the
  wind-aligned stretch. Our `crestAnisoCoord()` is therefore in unpublished
  territory in *either* orientation — treat §2.3 as a hypothesis to test, not as
  a correction backed by literature.
- **[GAP, and the most interesting one] Using Tessendorf's minimum eigen*vector*
  to orient the foam.** From the
  [2004 course notes](https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf),
  verbatim: "the **minimum eigenvalue is the actual signal of the onset of
  folding**. Further, the eigenvector **ê₋ points in the horizontal direction in
  which the folding is taking place** … the alignment of the folded wave is
  parallel to the minimum eigenvector." He then says: "**We will not discuss here
  how to carry out such an extension**." Every implementation I looked at uses
  det J and throws the direction away. We already compute λ⁻ — the eigenvector of
  a symmetric 2×2 is about ten more ALU, and it is a **per-texel, physically
  derived crest orientation field**, which is exactly what §2.3 and our
  `crestAnisoCoord()` currently approximate with an fbm angle field. This is the
  most promising unexplored idea in the whole document.
- **[GAP] NVIDIA WaveWorks foam parameter documentation.** Not found; the War
  Thunder deck is the best available proxy for it.
- **Erosion/dilation or multi-octave thresholding of the foam field** exists only
  as tutorial-blog material [FORUM/TUTORIAL-HEARSAY, e.g.
  [yelzkizi](https://yelzkizi.org/procedural-sea-foam-generation-guide/)]. The
  halftoning paper (§3.3) is the only peer-reviewed member of that family.
- For contrast, the hobby state of the art —
  [GarrettGunnell/Water](https://github.com/GarrettGunnell/Water) and
  [2Retr0/GodotOceanWaves](https://github.com/2Retr0/GodotOceanWaves) — is
  det J + linear accumulate + exponential decay + `lerp(col, foamColor, foam)`,
  i.e. squarely behind where we already are. The differentiators in the public
  record are Dupuy & Bruneton (§3.2), Crest's dissolve and foam normal (§3.3),
  and War Thunder's energy field (§3.4).

---

## 4. Ranked shortlist — what to steal

Ranked by (likely improvement to the live complaints) / (cost + risk). Items 1–9
are **arithmetic-only or reuse an existing sample — zero new samplers.** Only
items 10–11 spend the contested slot.

**Item 0, free, do it first:** run the §2.11 check. One toggle, and it decides
whether the rest of this list will even be visible at the default preset.

### 1. Recalibrate coverage and the residue clock against Monahan (§3.1)

Three constants, no shader change:

- **Measure** the current foam area fraction (average the mask; the CPU mirror or
  a compute reduction both work) and compare against `W = 3.84e-6·U10^3.41` —
  ~1 % at 10 m/s, ~4 % at 15, ~10 % at 20.
- If we are over by an order of magnitude, cut peak injected coverage until we
  are not.
- Lengthen the **residue** clock from 0.9 s toward the measured effective decay
  of **1.4–4.8 s**, and *raise* `residueWeight` from 0.30 — physically Stage B
  out-areas Stage A by **1.5–40×**, and ours is weighted the other way round.
- Make injection **ramp** rather than step (`τ_form` is 20–100 % of `τ_decay`).

Why it is first: it is free, it is measurable, it has a published target, and
"too much foam, too briefly" is a complete and sufficient explanation of "big
white blobs" on its own. Everything below is wasted effort if the coverage is
10× high.

Risk: low, but it will look *worse* before it looks better if coverage drops
without the brightness/structure changes below — pair it with item 2.

### 2. Composite foam additively at coverage weight, not as a lerp to white (§3.2)

Replace `mix(col, foamCol, foamAmount)` with the Dupuy & Bruneton form:

```
R += W · (Lsun·max(dot(N,L),0) + Esky)/π · 0.4        // Lambertian foam, albedo 0.4
```

- Why it wins: it is the **only single edit that attacks both live complaints at
  once.** A lerp at coverage 0.4 deletes 40 % of the sea's light response (the
  §T.42 problem, and the reason foam reads as paint); the additive form leaves
  the water visible underneath, which is exactly "we're still missing a bunch of
  transparency". Three independent shipped implementations agree that foam
  belongs partly *inside* the water: Dupuy & Bruneton (additive coverage-weighted
  Lambert), Crest (additive sub-surface bubble layer under an alpha-composited
  surface layer), War Thunder ("milkiness modulated by energy added to refraction
  colour").
- Cost: ~3 ALU. The albedo 0.4 is a published, cited figure — note it is far
  below our current foam albedo `#eef6f2` (linear luminance 0.905), which is
  itself a large part of why our foam reads as blown-out.
- Risk: low mechanically, but it changes the look everywhere foam exists, so it
  wants a screenshot pass against `docs/ocean-foam-*.png`.

### 3. Split the shadow term instead of multiplying it into everything (§3.5)

Free, and it is the only concrete answer found for "our shadow casting is maybe
not perfect":

- **Never shadow the environment / sky reflection.** Shadowed ocean still
  reflects the whole sky; multiplying the reflection by shadow is what turns a
  shadowed patch into a dead grey hole.
- Shadow the **sun glint lobe** and the **foam's direct lighting** only.
- For the scatter/SSS term, do not multiply — **lerp toward a separate, bluer
  shadow colour** (Crest ships `_DiffuseShadow` = `(0.0, 0.0013, 0.0849)`).
- Sample the shadow at the **displaced** position, not the undisplaced one, or
  shadows slide across the waves.
- Fade shadows out with distance.

Cost: pure ALU, no new resources. Risk: low. Caveat [DOC]: our ocean is in the
transparent pass (`material.transparent = true`, §V.24) and `receiveShadow` is
currently inert per the handoff — this item presumes that blocker is cleared
first, and Crest's own code comment about screen-space shadows not being handled
for the transparent pass suggests it is the same class of problem.

### 4. Windward-face injection term (§2.2)

Add a second injection gate to the foam sim: `saturate(dot(normal.xz, windDir))`
raised to a shaping power, feeding the same accumulator as λ⁻, with its own
strength. Keep λ⁻ as the *breaking* channel; the windward term feeds the
*residue* channel.

- Why it wins: λ⁻ is a point test and cannot know where a crest line is; the
  windward gate is shaped like the wave by construction and terminates at the
  crest. This is the mechanism behind "concentrates on the leading face" and
  "rolls off the back". Together with item 2 it is the strongest structural change
  here: it is what converts scattered patches into wave-shaped sheets.
- Cost: one dot product per texel in the existing inject pass. No new texture, no
  new pass, no sampler.
- Risk: low, and it is a pure addition with a strength knob that defaults to 0 —
  the null setting reproduces today's look exactly, so it is bisectable.
- Verification: the existing crest-placement metric (92.4% of foam mass in the top
  30% by elevation) should hold or improve, and cap p90 should not regress past
  14.9 m. Add a new one: foam mass should become asymmetric about the crest line
  (more on the windward flank than the lee).

### 5. Relaxation-with-headroom instead of a clamped accumulator (§2.1)

Replace `min(1, prev + injected)` with `E += (E_target − E)·(1 − exp(−dt/τ))`,
let `E` exceed 1, and keep the dissolve comparison at [0,1].

- Why it wins: it decouples brightness from lifetime, and it makes the field
  *sweep through* the dissolve band instead of parking in it — bright small cores
  with torn moving edges, rather than a dim wide wash with permanent mush. Our own
  `foamMath.ts` already documents the symptom (needs ~100 ticks to reach 0.3).
- Cost: arithmetic in the inject/decay pass. `crestStrength`-equivalent per
  cascade replaces `injectStrength`.
- Risk: **medium** — this is a change to the accumulator's semantics and every
  σ-relative tuning constant downstream (`eigenInjectPerStep`, `breakingGain`,
  `residueWeight`) is calibrated against the current one. It will need a
  re-tune, and the vitest invariants around `accumulateFoam` will need to move
  with it. Do it *after* items 1 and 4 so you can tell which change did what —
  item 1's coverage recalibration partly overlaps it, and doing that first may
  reduce how much of this is needed.
- Reference targets from his defaults: equilibrium **2.5** at a sustained fold,
  **1.5** on a fully wind-facing pixel, e-folding **0.5 s**. Our clocks are 0.15 s
  and 0.9 s — his single 0.5 s sits between them, which is mild corroboration
  that our two-clock split is the more expressive design.

### 6. Give foam its own normal, by finite-differencing the thresholded foam (§3.3)

Two extra taps of the **texture we already sample** — same object, same sampler,
no new binding — then a normal from the differences, an `N·L`, and a tight Phong
lobe. Crest's defaults to start from: `_WaveFoamNormalStrength` 3.5,
`_WaveFoamSpecularFallOff` 293, `_WaveFoamSpecularBoost` 0.15,
`_WaveFoamLightScale` 1.35, with the sample delta scaled by pixel Z so the relief
survives distance.

- Why it wins: this is the direct fix for the *second* half of §T.42 ("no normal,
  no roughness"), and because the difference is taken on the **already
  dissolve-thresholded** value, the relief comes from the foam texture's own torn
  structure. That is literally "reflecting the sub-tessellations of the surface".
- Cost: 2 texture fetches, no sampler. Also pair with GarrettGunnell's
  `roughness += foam · k` — one add.
- Risk: low, contained in `foamShading.ts` / `surfaceMaterial.ts`.

### 7. Statistical sub-pixel coverage via the Jacobian's Gaussian CDF (§3.2)

Store per-cascade `k` and `k²` in spare channels of the existing FFT output,
mip them, and evaluate `W = 0.5 + 0.5·erf((ε − μ)/√(2σ²))` with the polynomial
`erf` from the reference implementation.

- Why it wins: it is the published answer to foam that crawls, aliases and blobs
  at distance, and it composes exactly with item 2 (which consumes `W`
  directly). It replaces a binary per-pixel test with a correct fractional area.
- Cost: ~10 ALU plus a mip chain on an existing texture. **No new sampler** *if*
  channels are free — verify that first, because that is the whole cost argument.
- Risk: medium. It is a real change to how the fold metric is consumed, and our
  λ⁻ formulation is not the det-J formulation the paper derives, so the moment
  expansion needs re-deriving for λ⁻ or the paper's `k` needs adopting alongside.
  Do it after items 1–6 have been evaluated.

### 8. Advect the foam field, and modulate thickness by stretch (§3.3, §3.4)

Two independent additions to the foam sim:

- **Advection**: sample last frame's foam at `pos − dt·velocity` instead of at
  `pos`. This is most of what "rolls off the back of the wave" means, and our
  ocean foam sim does not appear to do it (our `flowfoam` accumulator does).
- **Stretch modulation**: use the diagonal/trace part of the Jacobian — local
  stretch vs squash, independent of folding — to thin foam over stretched water
  and thicken it over squeezed water. Data we already compute.

- Cost: advection is one extra sample of an existing field per texel in an
  existing pass; stretch is pure ALU.
- Risk: medium for advection (it interacts with the tiling/wrap semantics of the
  per-cascade RTs and with the σ-relative calibration), low for stretch.

### 9. Orient foam by the minimum eigen*vector*, and split the axis by age (§2.3, §3.7)

Two related changes to `crestAnisoCoord()`:

- Replace the fbm angle field with **ê₋, the eigenvector of the displacement
  Jacobian belonging to λ⁻**. Tessendorf states outright that it "points in the
  horizontal direction in which the folding is taking place" and that "the
  alignment of the folded wave is parallel to the minimum eigenvector" — and then
  declines to develop it. **No implementation I could find uses it.** We already
  compute λ⁻; the eigenvector of a symmetric 2×2 is ~10 more ALU, and it gives a
  per-texel, physically derived crest orientation instead of an invented noise
  field.
- Then **split the axis by foam age**: fresh (breaking channel) stays aligned to
  ê₋; aged (residue channel) rotates toward the **wind** and lengthens, per the
  Beaufort "streaks along the direction of the wind" description.

- Why it is ranked here rather than higher: it is the most *interesting* idea in
  the document and possibly novel, but it is unvalidated by anyone, and §3.7
  records that the wind-aligned half is unpublished in either orientation. Treat
  as a hypothesis with a cheap experiment, not as a known fix.
- Cost: ALU only. Risk: low mechanically, unknown visually.

### 10. Cloud shadows as a flat top-down `shadowNode` (§2.9)

Bake cloud coverage into a top-down map over a few-km box centred on the camera,
sample it by world XZ, multiply into **direct light only**, never ambient.

- Why it wins: it puts large, soft, *moving* shadow shapes on the sea, which is
  the thing the current PCF-2048 ship shadow structurally cannot do, and it
  breaks up the flat lit sea that reads as "blown out". It also sidesteps every
  hard problem of shadowing a displaced surface — no depth compare, no acne, no
  frustum fitting, no cascade seams.
- Cost: **one texture sample** — our single contested spare — plus a small bake
  pass. `mipLevel` gives softness for free; `bakeInterval` amortises the bake.
- Risk: medium, because it spends the last sampler. Sequence it after the free
  items and only if the cloud system is otherwise ready. His stated failure mode
  (low sun elevation) matters for a game with sunsets in the reference set.
- Note: it does *not* fix ship-shadow-on-water. Nothing found does.

### 11. Fresnel × depth transparency instead of a global opacity (§2.7, §3.6)

At minimum, the cheap half: make the water's opacity a function of the Fresnel
term we already compute, so nadir views go translucent and grazing views stay
opaque, *without* yet adding the scene-colour sample.

- Why it wins: it is the correct framing, and it is the direct answer to
  "we're still missing a bunch of transparency". The full version needs scene
  colour behind the water; the Fresnel-only half needs nothing new and already
  buys the angular behaviour, which is most of what the eye reads as "water".
- Cost: Fresnel-only half = arithmetic. Full version = a scene-colour capture
  plus a scene-depth sample, i.e. **at least one sampler and a pass**, and it
  collides head-on with the sampler budget and with T30 planar reflections, which
  also wants an RT and a sample. These two should be planned as one decision, not
  two.
- Risk: high for the full version. Low for the Fresnel-only half.
- **Free first step, do this before anything else in this item**: audit
  `surfaceMaterial.ts` for the energy split `(1−F)·scatter + specular +
  F·reflection` (§3.6b). Both Crest and GarrettGunnell weight scatter by `(1−F)`
  against the reflection. If ours adds the SSS/scatter term on top of a
  full-strength reflection, the surface will read opaque at every angle no matter
  what the body colour does, and no amount of absorption work will fix it. Costs
  nothing to check.
- Related and free: per-channel Beer–Lambert against one intrinsic colour is
  cheaper and better-behaved than a shallow/deep colour lerp — Water Pro replaced
  the latter with the former in v3.0 and called it a breaking improvement, and
  Crest's `_DepthFogDensity` is likewise a **float3**. If our `seaChroma` still
  lerps two colours by depth, that swap is arithmetic.

### 12. Fog colour → sky colour blend at distance (§2.10)

`skyBlendDistance` so the fog resolves into the sky rather than into a grey band.
Cheap, and it targets a named item on the user's open critique list (item 4,
"blown out white"; item 5, vision range). Not a foam fix — listed because the
cost is close to zero.

---

## 5. What is NOT applicable, and why

- **Three separate foam texture layers (surface / waves / shoreline), §2.6.**
  Three texture bindings. We have **one** spare sampler against a 16 cap and are
  already using a single 4-channel foam texture at two world scales specifically
  to avoid this. His layering is a licensing/authoring convenience for customers
  who want knobs; it buys no visual quality we cannot get from more channels in
  one texture. **Do not port.** If we want an ambient-surface-foam layer, it is a
  fifth channel or a second UV scale on the existing texture, not a second image.

- **Four bundled foam JPGs / a foam texture atlas.** Same reason, worse: multiple
  authored images is precisely the technique our sampler budget forbids. Our
  procedurally generated 4-channel `foamPattern.ts` (Worley wall network +
  domain-warped contours, seamless by construction) is the right adaptation and is
  arguably a better foam texture than a photo-sourced JPG. Judgement, not a
  finding.

- **Camera-anchored world-fixed foam field, §2.5.** Would mean abandoning the
  per-cascade tiling that the Rare talk describes and that our foam sim, its blur,
  its wrap semantics and its vitest invariants are all built on. It buys
  non-repetition, which `capVariationNode()` already buys us for free at
  broadband-fbm cost. High risk, near-zero visual delta. **Do not port.**

- **"Physical mode" Jerlov constituents (algae / silt / stain), §2.7.** This is a
  parameterisation, not a rendering technique — it maps three sliders onto the
  same absorption coefficients you would otherwise author directly. It sells well
  and it would cost us a spectral model for nothing the artist cannot reach with
  `absorptionColor`. Note the numbers if you want a plausible open-ocean starting
  point (Oceanic IB) and move on.

- **His shadow setup, §2.9.** Stock `THREE.DirectionalLight` with `mapSize`,
  `bias` and a ±100 m frustum is *what we already have*, at 2048 with a
  ship-following frustum. There is nothing to learn here. If the user's shadow
  complaint is about ship-shadow-on-water specifically, **this asset does not
  solve it and neither does the Sky Pro cloud shadow.** That problem stays open,
  and the handoff's existing note (water went `MeshBasicNodeMaterial` to kill the
  white sheen, so `receiveShadow` is inert) remains the actual blocker.

- **SSR.** We are committed to planar via V26/T30 on Rare's explicit authority,
  and SSR cannot reflect off-screen geometry — which for a first-person deck
  camera is most of the ship. His SSR being constant-cost is a nice property but
  not a reason to switch. Noted in §2.10 only so nobody thinks the choice is
  unanimous in the field.

- **Removing our Gerstner-equivalent / restructuring cascades to 1024/96/9.**
  Our 253/59/13.7 split is non-commensurate by design and the whole foam
  σ-calibration is derived from those domains. `maxScale` is worth *remembering*
  when the vision-range work happens; it is not a foam fix and it is not a
  cheap change.

- **Crest's world-space shadow LOD bake as an architecture (§3.5).** The
  *technique* is excellent and the *term routing* inside it is free (item 3) —
  but baking shadow into a dedicated world-space cascade needs a new pass **and a
  new texture/sampler**, and it competes for the same single spare slot as the
  cloud-shadow idea (§2.9, item 10). Take the term routing, the displaced-position
  lookup and the distance fade — those are ALU. Leave the bake until a sampler is
  freed. If a sampler *is* freed, note that the jitter-plus-temporal-accumulation
  idea (15 m jitter at 3 %/frame) can be applied to our existing PCF path without
  the cascade, which is the cheap half of the same insight.

- **A dedicated halftone/dither mask texture (§3.3).** The result — that
  *clustered* masks read as foam and blue-noise-even masks do not — is worth
  knowing, but a new mask texture is a new binding. Our `foamPattern.ts` breakup
  channel already is a clustered field; the transferable part is to sweep
  `FOAM_BREAKUP_CELLS` deliberately, not to add an image.

- **Buying and reading the source in order to copy his shader.** The licence
  forbids a Competing Product and forbids decompiling. Buying it to *read and
  learn*, and shipping our own implementation in our own game, is inside the
  grant (our game is an "End Product"). Copying his TSL verbatim into our
  codebase is not something I can recommend from the licence text. If the team
  wants the ~$150, the honest pitch is: it answers §2.8 (how foam composites) and
  the exact form of the dissolve comparison, which are the two things this
  document could not.

---

## 6. Sources

**Three.js Water Pro (primary, vendor documentation)**

- Docs home — https://docs.threejswaterpro.com/
- Changelog (v1.0.0 → v3.4.0; the densest single source) — https://docs.threejswaterpro.com/changelog.html
- Foam API (`persistence`, `crestStrength`, `windwardStrength`, `decayTime`, `windStretch`) — https://docs.threejswaterpro.com/api/foam.html
- Color & Transparency (Beer–Lambert, Jerlov, Fresnel, `iorRatio`, `refractionStrength`) — https://docs.threejswaterpro.com/api/color.html
- Waves API (JONSWAP, `peakWavelength`, `spectralSharpness`, cascade tile derivation) — https://docs.threejswaterpro.com/api/waves.html
- Wave Tuning (sea-state ↔ whitecap wording, recipes) — https://docs.threejswaterpro.com/guide/wave-tuning.html
- Sun & Lighting (the entire shadow story) — https://docs.threejswaterpro.com/api/sun.html
- Quality Levels ("Domain Warp Foam", screen refraction gating) — https://docs.threejswaterpro.com/guide/quality-levels.html
- SSR — https://docs.threejswaterpro.com/api/ssr.html
- SSS — https://docs.threejswaterpro.com/api/sss.html
- Atmospheric Fog (`skyBlendDistance`) — https://docs.threejswaterpro.com/api/fog.html
- Wake (`foamStrength` "equilibrium foam energy", `foamBreakThreshold` on |∇h|) — https://docs.threejswaterpro.com/api/wake.html
- Ocean Floor & caustics — https://docs.threejswaterpro.com/api/ocean-floor.html
- Transparent Objects — https://docs.threejswaterpro.com/guide/transparent-objects.html
- Presets (incl. `blackFlag`, `seaOfThieves`) — https://docs.threejswaterpro.com/guide/presets.html
- v3.3 → v3.4 migration — https://docs.threejswaterpro.com/guide/migrating-from-v3-3-to-v3-4.html
- Licence (grant, reverse-engineering and Competing Product clauses) — https://docs.threejswaterpro.com/license.html
- Product page, price, files, FAQ — https://threejsroadmap.com/assets/threejs-water-pro
- Live demo — https://threejswaterpro.com/

**Three.js Sky Pro (same author)**

- Docs home — https://docs.threejsskypro.com/
- **Shadows guide** (cloud shadow map, `shadowNode`, direct-light-only rule) — https://docs.threejsskypro.com/guide/shadows.html
- Cloud rendering pipeline (raymarch → amortize → reconstruct → upscale) — https://docs.threejsskypro.com/guide/cloud-rendering-pipeline.html
- Water Pro integration (wiring, post-processing order) — https://docs.threejsskypro.com/guide/water-integration.html

**Press coverage (restates the changelog; no added technical content)**

- 80.lv, V3 update — https://80.lv/articles/major-update-released-for-this-three-js-ocean-rendering-system
- 80.lv, earlier foam/reflections piece — https://80.lv/articles/have-a-look-at-this-ocean-shader-with-dynamic-foam-realistic-reflections
- TheRookies, V3 — https://www.therookies.co/blog/headlines/three-js-water-pro-v3-boosts-ocean-rendering-features

**Published techniques (the useful half)**

- **Dupuy & Bruneton, "Real-time Animation and Rendering of Ocean Whitecaps", SIGGRAPH Asia 2012 TB** — paper https://liris.cnrs.fr/Documents/Liris-5812.pdf · record https://inria.hal.science/hal-00967078v1 · **source** https://github.com/jdupuy/whitecaps (see `ocean.glsl`, `foam.glsl`)
- **Crest Ocean System (MIT)** — https://github.com/wave-harmonic/crest
  - foam sim — `crest/Assets/Crest/Crest/Shaders/Resources/UpdateFoam.compute`
  - foam shading, dissolve + foam normal — `crest/Assets/Crest/Crest/Shaders/OceanFoam.hlsl`
  - transparency, Beer–Lambert, refraction guard — `crest/Assets/Crest/Crest/Shaders/OceanEmission.hlsl`
  - shadow bake — `crest/Assets/Crest/Crest/Shaders/ShaderLibrary/UpdateShadow.hlsl`, `Scripts/LodData/Shadows/SimSettingsShadow.cs`
  - term routing (soft→scatter, hard→glint+foam, sky unshadowed) — `crest/Assets/Crest/Crest/Shaders/Ocean.shader`, `OceanReflection.hlsl`
  - user docs — https://crest.readthedocs.io/en/latest/user/water-appearance.html
- **War Thunder / Gaijin, "Ocean simulation and rendering in War Thunder", NVIDIA CGDC 2015** — https://developer.download.nvidia.com/assets/gameworks/downloads/regular/events/cgdc15/CGDC2015_ocean_simulation_en.pdf ; 2026 dev post on foam microrelief — https://warthunder.com/en/news/9957
- **Yingst, Alford & Parberry, "Very Fast Real-Time Ocean Wave Foam Rendering Using Halftoning", GAMEON-NA 2011** — https://ianparberry.com/pubs/GAMEON-NA_GRAPH_04.pdf
- **Tessendorf, "Simulating Ocean Water", course notes 2004** (min eigenvalue *and eigenvector*; "we will not discuss here how to carry out such an extension") — https://jtessen.people.clemson.edu/reports/papers_files/coursenotes2004.pdf
- NVIDIA, "Cascaded Shadow Maps" (striping when the lit surface is near-parallel to the light) — https://developer.download.nvidia.com/SDK/10.5/opengl/src/cascaded_shadow_maps/doc/cascaded_shadow_maps.pdf
- Hobby FFT oceans, for contrast — https://github.com/GarrettGunnell/Water , https://github.com/2Retr0/GodotOceanWaves
- AC4 Black Flag, journalism-level only — https://www.fxguide.com/fxfeatured/5-things-you-need-to-know-about-the-tech-of-assassins-creed-iv-black-flag/

**Oceanography**

- **Monahan & O'Muircheartaigh 1980**, "Optimal Power-Law Description of Oceanic Whitecap Coverage Dependence on Wind Speed", JPO 10:2094 (both fits, verbatim in the abstract) — https://journals.ametsoc.org/view/journals/phoc/10/12/1520-0485_1980_010_2094_opldoo_2_0_co_2.xml
- Callaghan, Deane & Stokes 2013, "Two Regimes of Laboratory Whitecap Foam Decay" (Stage A/B definitions; Stage B is 1.5–40× Stage A area; decay 0.2–10.4 s; surfactant ×3) — https://journals.ametsoc.org/view/journals/phoc/43/6/jpo-d-12-0148.1.xml
- Callaghan et al. 2012, "Observed variation in the decay time of oceanic whitecap foam" (effective decay 1.4–4.8 s over 552 events) — https://agupubs.onlinelibrary.wiley.com/doi/10.1029/2012JC008147
- Callaghan et al. 2008, whitecap coverage vs wind speed and wind history (inception threshold ~2.5–3.6 m/s) — https://agupubs.onlinelibrary.wiley.com/doi/full/10.1029/2008GL036165
- Schwendeman & Thomson 2015, whitecap coverage observations (power law `a·U10^b`, b ≈ 2–4) — https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2015JC011196
- Discrete Whitecap Method reassessment (linear growth + exponential decay; τ_form = 20–100 % of τ_decay; W = W_A + W_B), open PDF — https://ams.confex.com/ams/95Annual/webprogram/Manuscript/Paper260568/AMS,%2017CAChem.,J1.%204,%20DWM.,%20Reassess,paper,ver.%20H.pdf
- Anguelova & Webster 2006, whitecap coverage from satellite — http://magde.info/main/texts/journals/2006_JGR_AnguelovaWebster_whitecapSatellite.pdf
- Potter et al. 2015, whitecap lifetime stages from infrared imagery (abstract only, paywalled) — https://agupubs.onlinelibrary.wiley.com/doi/full/10.1002/2015jc011276
- Beaufort wind force scale, sea-state descriptions (Force 8: "foam is blown in well-marked streaks along the direction of the wind") — https://www.weather.gov/mfl/beaufort

**Author identity corroboration**

- `github.com/dgreenheck` — public repos (ez-tree, three-pinata, webgpu-galaxy, …); `webgpu-water`, `threejs-water-pro`, `threejs-sky-pro` all return 404 (private).
- `webgpu-claude-skill` — the `webgpu-threejs-tsl` plugin already installed in this environment, origin `git@github.com:dgreenheck/webgpu-claude-skill.git`.

---
