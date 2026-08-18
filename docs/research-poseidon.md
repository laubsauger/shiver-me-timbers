# Research — `owenyuwono/poseidon`, read against our ocean

Status: research only. Nothing in `src/` was touched, no commits, no dependency
added. The repo was cloned to a scratchpad outside the project tree and read in
full — all 1217 lines of it.

Written for the agents who will act on it. Claims are tagged:

- **[SRC]** — I read it in their source. File and line given. Checkable.
- **[OURS]** — I read it in this repo. File and line given.
- **[INF]** — my inference or derivation on top of the above. Labelled so you
  can disagree with the reasoning rather than having to guess where it came from.
- **[GAP]** — I looked and could not determine it. Not padded with a guess.

Read `docs/research-water-implementations.md` and `docs/research-whitecap-coverage.md`
first. This document deliberately does not repeat them, and §3 below leans on
`research-water-implementations.md` §0.4 (the windward-face finding), which turns
out to be the same question from a different angle.

---

## 0. If you read nothing else

1. **Poseidon is a small, clean, single-author tutorial-grade FFT ocean — 1217
   lines, one commit, WebGPU/TSL, same engine and same algorithm family as ours.
   Its foam, spectrum and FFT are a faithful port of `gasgiant/FFT-Ocean` (Unity,
   MIT).** It is not a rival implementation; it is roughly where this project was
   several months ago, plus two things we never built. [SRC, §1]
2. **MIT, cleanly. We may copy code with attribution.** Their upstream
   (`gasgiant/FFT-Ocean`) is MIT too, so the chain is clean. §7 states the
   attribution rule. [SRC]
3. **The `anticipation` behaviour is not in their code.** Their foam accumulator
   is `min(J, prev + rise)` — mathematically incapable of preceding the fold,
   because the output is pointwise ≤ the input. What they have is a *zero-lag
   onset* (a `min`, which responds instantly) against our *first-order integrator*
   (which needs ~0.22 s even on the fast clock), plus a threshold placed well
   above the fold. That reads as promptness, not as prediction. §3 gives the
   proof, explains why it looks like anticipation anyway, and gives the mechanism
   that would produce a real lead — which costs **zero fragment samplers**.
4. **The one thing they have that we structurally lack: their initial spectrum is
   a GPU compute kernel and their cascade band cutoffs are live uniforms.** Ours
   is a 419 ms CPU loop with construction-time-frozen domains. That, not any
   shader trick, is the actual blocker on the user's weather-driven-cascades idea.
   §6.
5. **The cascade debug view is worth taking and is nearly free** — it lives in a
   *separate scene*, so it adds zero bindings and zero ALU to the ocean material.
   §2.3, ranked #2 in §4.
6. **Their sampler budget is 6 of 16. Ours is 15 of 16.** Almost everything they
   do that looks appealing is affordable to them precisely because they have no
   shadows, no planar reflection, no refraction, no depth buffer, no seabed and no
   foam simulation. Judge every borrowed idea against that gap. §9.

---

## 1. What it is

| | Poseidon | Us |
|---|---|---|
| Engine | three.js `0.184.0`, `WebGPURenderer` + TSL, Vite [SRC `package.json`] | three.js r180, `WebGPURenderer` + TSL, Vite |
| WebGL fallback | none, explicitly [SRC `main.js:21-24,40-43`] | none |
| Source size | 1217 lines across 14 files [SRC] | ~10 400 lines in `src/ocean` + `src/foam` alone [OURS] |
| History | **one commit**, `ef5a167 chore: add MIT license` [SRC `git log`] | long-lived, spec-driven |
| Licence | **MIT**, `Copyright (c) 2026 owenyuwono` [SRC `LICENSE`] | — |
| Lineage | "Spectrum and FFT techniques adapted from `gasgiant/FFT-Ocean` (MIT)" [SRC `README.md`] | Tessendorf direct |
| Package name | `"fft-ocean-claude"` [SRC `package.json:2`] | — |
| FFT | Stockham butterfly in compute, `logN·2 + 1` dispatches, precomputed twiddle/index buffer, self-tested against an analytic impulse at boot [SRC `fft.js`, `main.js:50-52`] | equivalent |
| Grid | `N = 256`, cascades `250 / 17 / 5 m` [SRC `params.js:12-15`] | `N = 512`, cascades `1010 / 98 / 22.7 m` [OURS `src/params/ocean.ts:207,224`] |
| Spectrum | JONSWAP × TMA × Donelan-Banner, wind-sea + swell (Horvath 2015) [SRC `spectrum.js:39-77`] | Phillips + second swell train (own period/direction/cos²⁴), Mitsuyasu/Hasselmann spread |
| Surface material | `MeshBasicNodeMaterial`, fully unlit, hand-written [SRC `oceanSurfaceMaterial.js:16`] | full PBR-ish stack with shadows, planar reflection, SSR refraction, Jerlov absorption |
| Mesh | one 400×400 m plane, 900×900 segments, `frustumCulled = false` [SRC `main.js:92-93`] | LOD'd, per-cascade footprint fades |

**Scale of the thing, honestly.** It is a well-commented, staged learning project
(the comments literally say "step 2", "step 5", "step 6" [SRC `params.js:53,64`,
`main.js:174`]). It has an FFT correctness gate at boot, which is genuinely good
practice. It has no tests, no CPU mirror, no physics, no shoaling, no shadows, no
weather. **Do not read its brevity as elegance we failed to reach** — it is
brevity from having less to do.

**Their entire ocean fragment shader binds 6 textures / 6 samplers** [INF, counted
from `oceanSurfaceMaterial.js`]: 3× `derivatives` (`:36`), 2× `displacement.w` for
foam (`:66`, the loop skips the finest cascade), and `detailTex` read four times
(`:43,44,74,75`) which dedupes to one binding. Vertex is 3/3 (`:25`). Against our
**17 textures / 15 samplers with a 16-sampler Metal wall**
[OURS `tests/oceanBindingBudget.test.ts:131-143,360-386`].

---

## 2. Item by item

### 2.1 Choppy horizontal displacement — *identical formulation, no news*

Their time-dependent spectrum builds the displacement and all its derivatives
analytically in k-space and packs eight real fields into four complex IFFTs
[SRC `spectrum.js:177-189`]:

```js
const dispX   = ih.mul(wave.x).mul(wave.y);        // i·(kx/|k|)·h
const dispZ   = ih.mul(wave.z).mul(wave.y);
const dispXdx = h.mul(wave.x).mul(wave.x).mul(wave.y).negate();  // −kx²/|k|·h
```
where `wave.y` is `1/|k|` precomputed in the initial-spectrum pass
[SRC `spectrum.js:146`].

Ours [OURS `src/ocean/spectrumPass.ts:67-73`]:

```ts
const dx    = ih.mul(kxN);                       // i·(kx/|k|)·h
const dz    = ih.mul(kzN);
const dDxdx = h.mul(kx.mul(kxN).negate());       // −kx²/|k|·h
```

**Same equation, same packing strategy, same everything.** λ is applied at the
same place — in the assemble/unpack pass, `lambda·Dx` written into the map
[SRC `maps.js:51`; OURS `src/ocean/unpackPass.ts:75`]. Their normal is
fold-aware in exactly our form [SRC `oceanSurfaceMaterial.js:37-38`]:

```js
const slopeX = d.x.div(float(1).add(d.z));   // (∂h/∂x) / (1 + λ·∂Dx/∂x)
```

versus ours [OURS `src/ocean/surfaceMaterial.ts:678,696`]:

```ts
const denomX = float(1).add(der.z.mul(lambda)).max(0.05);
const slopeX = der.x.div(denomX).mul(clipSlope);
```

**Verdict: nothing to take. We are ahead on three counts.**

- **They have no fold guard at all.** λ is a raw artist slider, `1.3` by default,
  `0…2.5` in the GUI [SRC `params.js:20`, `gui.js:19`]. We compute the band's own
  `σ(∂Dx/∂x + ∂Dz/∂z)` from the spectrum on the CPU and cap λ so `λ·σ ≤ foldLimit`,
  automatically pulling choppiness down as amplitude rises
  [OURS `src/ocean/oceanMath.ts:386-412,645-655`]. Their sea will self-intersect
  if you drag the slider; ours cannot.
- **They clamp nothing in the normal denominator.** `d.z` can reach −1 and the
  division blows up. Our `.max(0.05)` is the guard.
- **We carry a shoaling clip derivative through the normal** (`clipSlope`), so a
  breaker-limited crest is shaded with the slopes it actually has
  [OURS `src/ocean/surfaceMaterial.ts:681-695`]. They have no shoaling.

One small honest note in their favour: **they compute λ once, globally, and so do
we** — `oceanCascades.ts:315` applies the same `effectiveChoppiness` to all three
cascades [OURS]. Neither implementation has per-cascade choppiness. It is a
uniform already, so making it per-cascade is a free change if anyone wants it
(see §6.3).

### 2.2 Foam

#### 2.2.1 The accumulator — a verbatim port of gasgiant, and we should say so

Their entire foam simulation is three lines [SRC `maps.js:39-49`]:

```js
const jxx = float(1).add(lambda.mul(DxxDzz.x));
const jzz = float(1).add(lambda.mul(DxxDzz.y));
const jxz = lambda.mul(DyDxz.y);
const J   = jxx.mul(jzz).sub(jxz.mul(jxz));

const prev = turbulence.element(id);
const turb = min(J, prev.add(dt.mul(foamDecay).div(max(J, float(0.5)))));
turbulence.element(id).assign(turb);
```

I fetched the upstream to confirm the lineage.
`gasgiant/FFT-Ocean/Assets/ComputeShaders/WavesTexturesMerger.compute:25-27`:

```hlsl
float jacobian = (1 + Lambda*DxxDzz.x)*(1 + Lambda*DxxDzz.y) - Lambda*Lambda*DyDxz.y*DyDxz.y;
Turbulence[id.xy] = Turbulence[id.xy].r + DeltaTime * 0.5 / max(jacobian, 0.5);
Turbulence[id.xy] = min(jacobian, Turbulence[id.xy].r);
```

**It is the same code with the hardcoded `0.5` promoted to a `foamDecay`
uniform.** [SRC, both] The "lingering / dissipating whitecaps" the README
advertises is gasgiant's 2020 accumulator, not a poseidon invention. This matters
for §3 and for how much credit to give the idea.

Mechanics, stated plainly because §3 depends on it: `turb` is a **running minimum
of `J` with a slow upward creep**. It snaps down instantly when `J` drops and
recovers at `foamDecay / max(J, 0.5)` per second. At the shipped `foamDecay = 0.4`
[SRC `params.js:67`] that is 0.8/s in near-critical water and 0.2/s in stretched
water (`J = 2`) — so **foam persists longer where the surface is stretched flat**,
i.e. in troughs and on wave backs. [INF, from the formula]

**They use det J. We use λ⁻**, Tessendorf's actual folding signal, for reasons
already measured and recorded in this repo: at the same σ-multiple, det J produced
0.5 % coverage against λ⁻'s 9.2 %, with cap length spread CV 0.08 against 0.68 and
orientation spread 2.1° against 21.4° — round blobs at one size and one angle
[OURS `src/foam/foamMath.ts:158-186`]. **Do not regress this.**

#### 2.2.2 The threshold and the cross-cascade sum

[SRC `oceanSurfaceMaterial.js:62-69`]:

```js
const foamRaw = float(0).toVar();
cascades.forEach((c, i) => {
  if (i >= cascades.length - 1) return;          // skip the finest cascade
  const turb = texture(c.displacement, worldXZ.div(lengthScales[i])).w;
  foamRaw.addAssign(saturate(shading.foamThreshold.sub(turb).mul(shading.foamScale)));
});
const coverage = smoothstep(float(0.2), float(0.9), foamRaw);
```

Three things worth naming:

- **`foamThreshold = 0.4`, not 0** [SRC `params.js:65`]. Foam begins when the
  surface is 60 % area-compressed, well before it inverts, and reaches full white
  at `turb = 0` (since `foamScale = 2.5` and `0.4 × 2.5 = 1`). So their foam is a
  **continuous ramp over the whole compression range**, saturating exactly at the
  fold. This is the largest single contributor to the perceived "anticipation" —
  see §3.
- **The finest cascade is excluded from foam entirely**, with the comment "skip
  the finest cascade's constant speckle" [SRC `:62`]. A 5 m-domain cascade folds
  essentially everywhere, so its Jacobian is a uniform noise floor rather than a
  breaking signal. **We should check whether our 22.7 m cascade does the same
  thing.** Our per-band `bandCanFold(bandSigma, seaSigma)` gate
  [OURS `src/foam/foamMath.ts:94`] is the right shape of answer and is
  spectrum-driven rather than an `if (i === last)`, so this is probably already
  handled — but it is a cheap thing to verify with a measurement. [INF]
- The per-cascade contributions are **summed then smoothstepped**, not maxed. Ours
  composites per-lane through the shading node and takes the max with wake foam
  [OURS `src/ocean/surfaceMaterial.ts:1385`]. Different, not better.

#### 2.2.3 "The bubbly stuff and the sunlit shading"

This is the part the user liked, and it is six lines
[SRC `oceanSurfaceMaterial.js:71-79`]:

```js
// bubbly structure: modulate foam BRIGHTNESS with the noise texture at two
// scrolling scales (never carve coverage -> no dots), then shade the foam as
// a near-Lambertian surface lit by sun + sky so it has depth, not flat paint
const fb1 = texture(detailTex, worldXZ.mul(0.45).add(vec2(t.mul(0.03),  t.mul(0.02)))).b;
const fb2 = texture(detailTex, worldXZ.mul(1.6 ).add(vec2(t.mul(-0.05), t.mul(0.04)))).a;
const bubbles   = saturate(fb1.mul(0.7).add(fb2.mul(0.5)).add(0.2));
const foamLight = float(0.55).add(saturate(dot(N, shading.sunDir)).mul(0.6));
const foamShaded = shading.foamColor.mul(foamLight).mul(bubbles);
return mix(water, foamShaded, coverage);
```

`detailTex` is a CPU-baked 512² tiling fbm with channels packed as
`RG = normal perturbation, B = low-freq value, A = high-freq value`
[SRC `detailTexture.js:6-9,60-63`].

**What is genuinely interesting here is the comment, not the code.** The stated
rule — *modulate BRIGHTNESS, never carve COVERAGE, because carving coverage gives
you dots* — is a real design principle and it is the exact opposite of the road we
took. We carve the **silhouette** deliberately, with the art texture's breakup
channel used as a per-texel dissolve threshold, precisely because modulating the
interior of a disc leaves a disc [OURS `src/foam/foamShading.ts:361-401`]. Their
rule avoids one failure (dots) by accepting another (every cap is a smooth blob
with texture painted on it, which is the "blotchy, reads as discs" complaint this
project already fought and beat).

**Verdict: we are ahead, and the rule is a warning, not a recipe.** Their approach
is what we would fall back to if the dissolve ever produced dots — and our
dissolve has an explicit sub-pixel band-limit derivation (`softness` widening as
`resolved` retires, residual 0.045 of alpha, tested) that theirs does not need
because it never carves anything [OURS `src/foam/foamShading.ts:404-436`].

**`foamLight` is not new to us either.** We already light foam with an N·L wrap
plus shadow [OURS `src/ocean/surfaceMaterial.ts:1438-1441`]:

```ts
const foamCol = foamBase.mul(foamTintNode())
  .mul(ndl.mul(uLightGain.mul(0.6)).mul(shade).add(uLightFloor.add(0.1)));
```
plus a sky-colour tint (`uFoamSkyTint`) that theirs has no equivalent of. Ours
takes the shadow; theirs cannot, because the material is unlit.

**One thing they do that we do not: two decorrelated scrolling scales of the same
noise on the foam body, one at 0.45 and one at 1.6 world-frequency, with opposite
drift.** We scroll the art lookups with counter-motion
[OURS `src/foam/foamShading.ts:299-300`] so this is covered in kind. No steal.

#### 2.2.4 Aliasing — a real defect on their side

`mapTexture()` [SRC `maps.js:8-14`] creates a `StorageTexture` and sets only
`type` and wrapping. The comment above it claims "auto-mipmapped after each
compute write" [SRC `maps.js:7`]. **That comment is wrong.** three's
`StorageTexture` constructor sets `minFilter = LinearFilter` (not
`LinearMipmapLinearFilter`) and never enables `generateMipmaps`
[verified in `node_modules/three/src/renderers/common/StorageTexture.js`].

So their foam is a **point-filtered, never-blurred, never-mipped per-texel field**
sampled directly in the fragment shader. It will shimmer at distance and there is
nothing in the code to stop it. [INF, but a confident one — the texture state is
checkable and the sampling path is one line]

We run a 3×3 gaussian blur-with-feedback every frame (Rare's progressive blur,
age = blur count) [OURS `src/foam/foamPasses.ts:9-13`], the art texture carries a
real mip chain, and every gate in `foamDetailMask` is measured against the
**feature's own world size versus the measured pixel footprint**, not against
camera distance [OURS `src/foam/foamShading.ts:340-360`]. That is four separate
band-limiting mechanisms they have zero of.

### 2.3 Cascade spectra debug view — **take this**

The single most directly useful thing in the repo, and it is 33 lines.

[SRC `debugView.js:7-13`] — a fullscreen quad in its own ortho scene:

```js
export function createDebugView() {
  const scene = new Scene();
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1);
  const mesh = new Mesh(new PlaneGeometry(2, 2), new MeshBasicNodeMaterial());
  scene.add(mesh);
  return { scene, camera, mesh };
}
```

[SRC `debugView.js:16-32`] — a log-scaled magnitude heatmap of any complex storage
buffer:

```js
const mag = length(field.element(idx).xy);
const v = clamp(log(mag.mul(1000).add(1)).mul(exposure), 0, 1);
return vec3(v.mul(0.7).add(0.05), v.mul(0.85).add(0.05), v.mul(1.0).add(0.08));
```

[SRC `main.js:106-107,111-121,152-161`] — materials built once at init, keys
`1/2/3` select the cascade, `5` the height map, `F` returns to the ocean, and the
debug path calls `renderer.render(debug.scene, debug.camera)` **instead of** the
main render.

**Why this is the right architecture for us and not just a convenient one:** the
ocean material is **not touched**. No debug uniform, no branch, no extra binding.
Our ocean fragment stage has exactly one spare sampler
[OURS `tests/oceanBindingBudget.test.ts:360-386`] and this spends none of it.

**Their TSL trap is worth recording even though it probably does not bite us**
[SRC `debugView.js:18-21`]:

> Wrap the SAME GPU buffer in a separate read-only node. `toReadOnly()` **mutates
> the node it's called on**, so reusing `buffer` here would flip the live compute
> buffer to read-only and break the kernels that write to it.

Their fields are `attributeArray` storage *buffers*. Ours are storage *textures*
and a storage *array texture*, so a debug material would use `textureLoad` and
never call `toReadOnly()` at all. [INF] The general lesson — do not mutate the
live node — still applies.

**What we currently have: nothing.** There is no shader debug view, no cascade
visualiser, no "show normals / foam mask / derivatives" mode anywhere in `src/`
[OURS — `grep -rniE "debugmode|shownormals|debugview|visuali[sz]e|udebug"` over
`src/` returns zero hits]. `src/debug/panel.ts` is a Tweakpane numeric-parameter
panel only, and `src/debug/panel.ts:180-205` notes it binds no keys.

**Implementation note for whoever takes this:** the key must be registered through
`src/ui/viewModes.ts:153-178`, which is documented as the single owner of dev-layer
keys. Do not add a bare `addEventListener` the way `main.js:112` does.

**What we could show that they cannot.** Their debug view only reads complex
spectra (`h0`, `DyDxz`). Ours would want, per cascade: `h0Texture` (a CPU
`DataTexture`), `spec0/spec1` (storage textures), `displacement`
(`λDx, h, λDz, det J`), `derivatives` (a **`StorageArrayTexture`** — the sample
needs `.depth(int(layer))`, see `src/ocean/oceanTextures.ts:96-141` for the three
traps), and the two foam RTs per lane (R = residue, G = breaking). A per-cascade
λ⁻ readout would be the highest-value view of all, since every foam gate in the
project is expressed in σ of that quantity and nobody can currently *see* it.

### 2.4 Ballistic spray particles — **we already have this, and ours is better**

Their system [SRC `spray.js`]: a 24 000-particle pool in two `instancedArray`
`vec4`s; each frame one compute pass either respawns a dead particle at a randomly
sampled point in a 130 m disc around the camera or integrates a live one. Respawn
gate [SRC `spray.js:43,67`]:

```js
if (idx < cascades.length - 1) brk.assign(max(brk, shading.foamThreshold.sub(d.w)));
...
If(oc.brk.greaterThan(u.breakThreshold).and(r3.lessThan(u.emitChance)), () => { ... })
```

Ballistics [SRC `spray.js:79-85`]: gravity −9.8, wind acceleration `0.35·wind`,
linear drag `v *= max(1 − 0.6·dt, 0)`, life 0.8–2.2 s. Rendered as instanced
`Sprite`s with a `soft²` radial falloff, `NormalBlending`, `depthWrite = false`,
and zero scale when dead so there is no overdraw [SRC `spray.js:91-108`].

**It is disabled in their own repo** — `const ENABLE_SPRAY = false;` with the
comment "temporarily disabled" [SRC `main.js:96-97`]. I cannot tell from the
source whether that is a performance decision or an appearance one. [GAP]

**We have `src/foam/spray.ts` (297 lines), `sprayMath.ts` (561), `sprayPool.ts`
(250) and `bowSpray.ts` (305) already** [OURS]. Ours is better on every axis I
checked:

| | Poseidon | Us |
|---|---|---|
| Break gate | `foamThreshold − det J > 0.85`, a raw magic number [SRC `spray.js:27`] | **λ⁻ below the foam gate plus `sprayGateSigma` σ**, carried in σ from the foam gate so the two systems agree about where the sea is breaking, and no weather preset can drag it onto flat water [OURS `src/foam/spray.ts:9-13`, `src/params/spray.ts:23-33`] |
| Height gate | none | crest elevation as a multiple of sea-state σ — a crest **top**, not a trough, equally selective calm and storm [OURS `src/params/spray.ts:35-44`] |
| Randomness | `hash(i·2.17 + seed)` [SRC `spray.js:58`] | golden-ratio low-discrepancy per-particle seed + five decorrelated hash streams, **no `Math.random` anywhere**, deterministic [OURS `src/foam/sprayMath.ts:20-44`] |
| CPU mirror / tests | none | full mirror in `sprayMath.ts`, `tests/spray.test.ts` |
| Launch | uniform jitter | heavy-tailed gust factor so droplets **detach** rather than reading as "foam hopping" [OURS `src/params/spray.ts:54-58`] |
| Spawn position | undisplaced candidate XZ, `oc.h + 0.3` [SRC `spray.js:68`] | the **displaced** surface point (`candidate + Σ(λDx, λDz)`) [OURS `src/foam/spray.ts:15-17`] |

**Verdict: nothing to take. Item 4 on the user's list is already built.**

**One actionable difference, though: the user asked for spray to default OFF, and
ours defaults ON.** [OURS `src/main.ts:84` — `spray: true, // re-enabled: B5 NaN
guards landed`], with a runtime toggle wired through
`src/ui/graphicsFeatures.ts:83` and `src/main.ts:620-621`. Pool size defaults to
2048 [OURS `src/params/spray.ts:210`]. Flipping the default is a one-word change;
whether it *should* flip is a taste call for the user, not a research finding —
theirs being off may simply mean theirs did not look good (`main.js:96-97` says
"temporarily disabled" without a reason [GAP]).

The one architectural fact worth carrying forward from their version: **a spray
system costs zero fragment samplers**, because the ocean-map reads happen in a
compute pass via `textureLoad` (no sampler at all) and the render is a separate
sprite draw. Ours already exploits this [OURS `src/foam/spray.ts` imports
`textureLoad`, `loadCascadeLayer`].

### 2.5 Fresnel, sky, sun glitter, subsurface scattering

All four live in about 25 lines. Taken one at a time.

**Fresnel** [SRC `oceanSurfaceMaterial.js:49`]:
```js
const fresnel = float(0.02).add(float(0.98).mul(pow(float(1).sub(max(dot(N, V), 0)), 5)));
```
Schlick, F0 = 0.02, no roughness term, no horizon suppression, no grazing
handling. Ours [OURS `src/ocean/surfaceMaterial.ts:1012-1013`] is the same
functional form but with a tunable `uFresnelR0` and — decisively — a
**grazing-saturation hump** that hands the water's own pigment back to distant
pixels where Schlick ≈ 1 and the sea would otherwise grey out
[OURS `:1288-1296`], plus the Tokuyoshi/Kaplanyan specular-AA term and the
analytic sub-pixel slope-variance roughness [OURS `:585-613`]. **Worse, take
nothing.**

**Sky** [SRC `sky.js:7-14`] — a two-colour elevation gradient plus a sun disc and
halo, evaluated as a pure function of direction:
```js
const t    = smoothstep(float(-0.05), float(0.4), dir.y);
const grad = mix(u.horizon, u.zenith, t);
const sd   = max(dot(dir, u.sunDir), 0);
const disc = pow(sd, float(1200)).mul(u.sunColor).mul(8);
const halo = pow(sd, float(7)).mul(u.sunColor).mul(0.35);
return grad.add(disc).add(halo);
```
The **architecture** is the good part and we already have it: one function shared
by the sky dome and by the ocean's reflection, so the two can never disagree
[SRC `sky.js:20` and `oceanSurfaceMaterial.js:53`]. We do exactly this —
`skyDomeColor` is `src/sky/skyBackground.ts`'s own dome function, passed into the
ocean material and evaluated along the reflection ray, and the ocean is forbidden
from holding a second sky model [OURS `src/ocean/surfaceMaterial.ts:1245-1271`].
**No steal, and it is reassuring that an independent implementation reached the
same single-authority conclusion.**

Their reflection ray is clamped, not dropped [SRC `oceanSurfaceMaterial.js:53`]:
`normalize(vec3(R.x, abs(R.y).max(0.02), R.z))` — a downward-pointing reflection
is **flipped** into the upper hemisphere. Cheap, physically wrong, avoids black
pixels. We have a planar reflection RT so this is moot for us.

**Sun glitter** — this is the interesting one, and it is interesting because of
what they *don't* do. **There is no separate specular lobe anywhere in the
material.** The glitter is the analytic sun disc, `pow(sd, 1200)`, arriving
through the reflection vector and multiplied by Fresnel. Every wave facet whose
reflected ray happens to hit the sun lights up; the rest do not. One `pow`, zero
extra samplers, and it is automatically consistent with the sky.

We deliberately **exclude** the sun disc, glow and halo from the reflected-sky
evaluation and let `pow(N·H)` lobes produce the glint road instead
[OURS `src/ocean/surfaceMaterial.ts:1257-1265`], with the recorded reason:

> the reflected sun is not a mirror image of the disc, it is the glint road …
> Re-adding an HDR disc through a reflection — analytic OR through the planar
> mirror — paints the clean circular blob the user shot.

**These two decisions are in direct conflict and ours is the considered one.**
Their `pow(sd, 1200)` works for them only because their surface is a bare
band-limited normal field with no specular AA — at N = 256 over a 400 m plane the
facets are large enough that the disc naturally shatters. On our surface, with
sub-pixel slope variance folded into a roughness term, it would re-blob. **Do not
take this. It is already a recorded regression.**

**Subsurface scattering** [SRC `oceanSurfaceMaterial.js:56-59`]:
```js
const heightFactor = saturate(positionWorld.y.mul(0.5).add(0.4));
const H = normalize(N.negate().add(shading.sunDir));
const sss = pow(saturate(dot(V, H.negate())), 4).mul(shading.sssStrength).mul(heightFactor);
const body = mix(shading.deepColor, shading.scatterColor, saturate(float(0.12).add(sss)));
```
The classic back-lit translucency half-vector (Frostbite/Naughty Dog shape),
gated by a **raw world-height ramp** as a proxy for "thin water".

Ours [OURS `src/ocean/surfaceMaterial.ts:1172-1227`] is the same family but the
gate is a **tight band in σ units** (`smoothstep(σ·crestBand.x, σ·crestBand.y, y)`
— the top few percent of crests), gated on real sun backlighting, bounded as a
`mix` rather than an add, tinted by the live sun colour, multiplied by a choppiness
mask and by shadow, and with a skylight floor scaled by `stormFactor` so storm
crests are *more* luminous under overcast. The recorded reason the raw height ramp
was abandoned:

> The old version added a sun-INDEPENDENT slug over any water above 0.25 m, i.e.
> 36 % of the sea, at 4× the body colour's green: the blobs.

**Their `heightFactor` is literally the thing we deleted.** [OURS `:1176-1188`]
Worse. Take nothing.

**Summary of §2.5: nothing to steal.** All four are correct-but-minimal versions
of things we have built out. This section exists so nobody spends a day
reimplementing a downgrade.

### 2.6 Weather-driven cascading — **not in their code**

There is no weather system in poseidon. `lengthScales` is a static array
[SRC `params.js:14`], `boundaryFactor` is a constant 6 [SRC `params.js:15`], and
nothing animates them. See §6 — the useful finding here is architectural, not
behavioural.

---

## 3. The `anticipation` question

The most interesting item on the list, and the answer needs three parts.

### 3.1 Their code cannot lead the break. Proof.

[SRC `maps.js:48`]:
```js
const turb = min(J, prev.add(dt.mul(foamDecay).div(max(J, float(0.5)))));
```

`turb ≤ J` **pointwise, at every texel, at every frame, by construction** — it is
the first argument of a `min`. Foam alpha is `saturate((0.4 − turb) · 2.5)`, a
monotonically decreasing function of `turb`. Therefore foam at a texel can never
exceed what the *current* `J` at that texel already licenses. There is no state,
no lookahead, no neighbour read and no time offset anywhere in the pass. **The
foam signal cannot precede the fold signal.** [INF, but it is a one-line proof
over the quoted code]

The recovery term is the *only* asymmetry, and it points the other way: it makes
foam **persist after** the fold, never appear before it.

### 3.2 Where the perceived lead actually comes from

Two mechanisms, both real, neither prediction.

**(a) The onset is instantaneous; ours is a first-order lag.** `min` has *zero*
rise time — the frame `J` drops, `turb` is already there and the foam is at full
strength. Our foam is an accumulator on both channels
[OURS `src/foam/foamPasses.ts`, `foamMath.ts:485-491`]: a tick is
`x ← (x + I)·decay`. Even the short breaking clock (0.15 s half-life) has a rise
time constant of ≈0.22 s and reaches only 63 % of its steady state in that window.
[INF, standard first-order response] So on a crest that sharpens over ~0.3 s, they
are white at frame one and we are at roughly two-thirds. **Read as a behaviour,
"their foam gets there before ours does" is indistinguishable from "their foam
anticipates".**

**(b) The threshold sits well above the fold.** `foamThreshold = 0.4` against a
fold at `J = 0`, with `foamScale = 2.5` so alpha ramps linearly from 0 at
`J = 0.4` to 1 at `J = 0` [SRC `params.js:65-67`]. Foam therefore builds
*continuously as the crest sharpens* and saturates exactly at the fold. A crest
that never actually folds still gets partial foam. Ours is a σ-relative gate
feeding an integrator, so a crest that only briefly clears the gate deposits
almost nothing [OURS `src/foam/foamMath.ts:293-311`].

### 3.3 Why neither implementation can put foam ahead of the crest, and what would

Take one mode, `h = A cos θ`, `θ = kx − ωt`. Tessendorf's horizontal displacement
is the Hilbert transform, `Dx = −A sin θ`, so `∂Dx/∂x = −A k cos θ` and
`jxx = 1 − λ A k cos θ`. **That is minimal at `θ = 0`, which is exactly the
crest.** [INF, one line of calculus]

So the fold metric — det J or λ⁻, theirs or ours — is **symmetric about the crest
by construction**. Neither implementation can place foam on the forward face
before the crest arrives, because the quantity driving it does not know which face
is forward. Every visible asymmetry in either system comes from the temporal
accumulator, which by definition trails.

**Anticipation therefore requires an explicitly asymmetric term.** There are two
that would work, and one of them is very cheap for us.

#### (A) The phase-lead sample — the real answer, and it costs zero fragment samplers

For a travelling wave field, `f(x, t) = F(x − ct)`, so

```
f(x, t + τ) = f(x − cτ·d̂, t)
```

**The future at `x` is the present at `x − cτ·d̂`.** Sampling λ⁻ one band-mean
phase-velocity step *upwave* of a texel is a prediction of what λ⁻ at that texel
will be τ seconds from now. Inject on

```
depth = max(0, gate − min( λ⁻(p) , λ⁻(p − c·τ·d̂) ))
```

and the water **ahead of an oncoming crest whitens τ seconds before the crest
arrives**. That is the behaviour, not a tuning of the existing one.

Cost and fit:

- **Zero fragment samplers.** It lives entirely in the foam **inject compute
  pass**, which already reads `displacement` and `derivatives` by `textureLoad`
  (no sampler) [OURS `src/foam/foamPasses.ts:22,31`, `src/ocean/oceanTextures.ts:141`].
  The offset read is **+2 `textureLoad`s and ~6 ALU** in a compute kernel that
  already does a nine-tap structure-tensor ring, so the tap pattern exists.
- **We already have the per-band mean wavenumber.** `meanWavenumber` is measured
  per cascade on every h0 rebuild [OURS `src/ocean/oceanCascades.ts:124-128`], so
  `c = sqrt(g / k̄)` is a CPU-side scalar uniform. No new measurement.
- **`τ` is the single new artist knob** and it is in seconds, which is the right
  unit to tune in.

Honest caveats, stated because this is a recommendation and not a fact:

- **It assumes a narrow-band, single-direction train per cascade.** Our sea has
  two trains at ~78° [OURS, stated in the brief]. A single `d̂` per cascade will
  anticipate the dominant train correctly and misplace the other. Mitigation:
  drive `d̂` per cascade from whichever train owns that band's energy. We do not
  currently publish per-band-per-train energy — the CPU moment integrators
  (`oceanMath.ts:376,412,445,580,614`) could produce it in the same loop, but
  today they do not. **[GAP]**
- **Dispersion inside a band** means `c` varies; `k̄` is the energy-weighted
  compromise and the lead will be slightly wrong at the band edges. [INF]
- I have **not** found this technique in any published ocean renderer. It is a
  derivation, not a citation. Treat it as untested.

#### (B) The windward-face term — already identified, cheaper still

`docs/research-water-implementations.md` §0.4 already records that every reference
implementation injects foam on the **wind-facing rising flank** as well as on the
fold, and that Water Pro exposes it as a first-class knob (`windwardStrength`,
"Equilibrium energy on a fully wind-facing pixel. Drives foam onto the rising
face; **persistence carries it past the crest**"). That description *is*
anticipation: the foam is on the face before the crest, and the accumulator then
carries it over.

**One dot product, arithmetic-only, zero bindings.** It is asymmetric because the
wind direction is asymmetric. It is a weaker form of (A) — it puts foam on the
windward face always, rather than specifically ahead of a crest that is about to
break — but it is a third of the work.

**These two compose.** (B) decides *which face*; (A) decides *how far ahead in
time*. If only one gets built, build (B) first: it is already researched, and it
will tell you whether the user's "anticipation" was really about faces rather than
about timing.

#### (C) The asymmetric onset operator — the actual poseidon steal

Independent of true anticipation, their `min` is worth copying for the **breaking
channel only**. Replace the accumulate-then-decay with a **peak-hold**:

```
f ← max( d_normalised , f · decay )
```

Instant onset (their promptness), exponential linger (our residue), **one `max`
replacing one `add`**, zero bindings, zero samplers.

Caveat, and it is not a small one: `breakingGain` is *derived* from the
accumulator's steady state under the inject-then-blurDecay ordering
[OURS `src/foam/foamMath.ts:483-506`], `foamMaskFrom` consumes that gain, and
`tests/foam.test.ts` runs both accumulators to steady state and compares. A
peak-hold has no steady-state gain in that sense, so **`breakingGain`,
`foamMaskFrom` and the test would all need re-deriving together**. Budget that as
the real cost, not the one-line edit.

Keep the **residue** channel as an accumulator. Real seas do leave foam behind a
breaker and that integration is what produces it.

---

## 4. Ranked shortlist of what to steal

Ranked by (value to the user's stated list) ÷ (cost against our real constraints).
Every entry is tagged **arithmetic-only** (free on our binding budget) or **needs a
binding** (contested — we have exactly one spare fragment sampler).

| # | Thing | Cost | Binding | Effort |
|---|---|---|---|---|
| 1 | **Phase-lead injection** (§3.3A) — true anticipation | +2 `textureLoad` and ~6 ALU **in the foam compute pass**; one new `τ` uniform; `c` from existing `meanWavenumber` | **arithmetic-only** (compute-stage loads need no sampler) | Medium. New behaviour, needs a CPU mirror in `foamMath.ts` and a test, per this repo's mirror contract. |
| 2 | **Cascade spectrum debug view** (§2.3) — separate ortho scene | **zero** cost to the ocean material; one extra material set built at init; one key through `src/ui/viewModes.ts` | **arithmetic-only** — no ocean binding at all | Small. The only fiddly part is `derivatives` being a `StorageArrayTexture` (`.depth(int(layer))`, see `oceanTextures.ts:96-141`). |
| 3 | **Windward-face foam term** (§3.3B) | one dot product | **arithmetic-only** | Small–medium. Already researched in `research-water-implementations.md` §0.4. |
| 4 | **Peak-hold onset on the breaking channel** (§3.3C) | one `max` for one `add` | **arithmetic-only** | Medium — the edit is one line, the re-derivation of `breakingGain` + `foamMaskFrom` + `tests/foam.test.ts` is not. |
| 5 | **GPU initial-spectrum kernel** (§6.1) — prerequisite for weather-driven anything | 2 compute dispatches of N² per cascade, ~sub-ms, replacing part of a 419 ms CPU loop | **arithmetic-only** (compute) | **Large**, and only partly a win — see §6.1 for what it does *not* remove. |
| 6 | **Live-uniform cascade band cutoffs** (§6.2) | 2 uniforms per cascade | **arithmetic-only** | Only meaningful after #5. |
| 7 | **Verify the finest cascade is excluded from foam** (§2.2.2) | measurement, no code | — | Tiny. Probably already handled by `bandCanFold`; worth confirming rather than assuming. |

Nothing on this list needs the contested sampler. That is not a coincidence —
everything in poseidon that would need one is something we already do better.

---

## 5. What NOT to take, and why

Kept deliberately blunt. Each of these looks appealing in isolation and each is a
regression here.

| Their thing | Why not |
|---|---|
| **det J as the fold metric** [SRC `maps.js:42`] | Measured in this repo at 0.5 % coverage vs λ⁻'s 9.2 %, cap length CV 0.08 vs 0.68, orientation spread 2.1° vs 21.4°. Round blobs, one size, one angle — both original user complaints, one cause. [OURS `foamMath.ts:158-186`] |
| **The analytic sun disc through the reflection ray** [SRC `sky.js:11`] | We excluded the disc from the reflected sky on purpose. Re-adding it "paints the clean circular blob the user shot". [OURS `surfaceMaterial.ts:1257-1265`] Recorded regression. |
| **`heightFactor` SSS gate** [SRC `oceanSurfaceMaterial.js:56`] | Literally the term we deleted — a sun-independent slug over 36 % of the sea at 4× the body green. "The blobs." [OURS `surfaceMaterial.ts:1176-1188`] |
| **Brightness-only foam modulation** [SRC `oceanSurfaceMaterial.js:71-73`] | Avoids dots by never carving the silhouette — which is exactly the "reads as discs" failure this project spent four commits beating with the dissolve threshold. [OURS `foamShading.ts:361-401`] Their rule is a fallback, not a target. |
| **Their `detailTex` as a surface normal perturbation** [SRC `oceanSurfaceMaterial.js:43-46`] | **Needs a binding** we do not have, and duplicates our micro-warp + normal-detail path. The one contested spare is not spent on a re-implementation. |
| **The Horvath/JONSWAP/TMA/Donelan-Banner spectrum** [SRC `spectrum.js`] | A whole-spectrum swap. Every σ-relative gate in `src/foam`, the spray gates, the choppiness fold cap, the sub-pixel slope variance and the CPU buoyancy mirror are all calibrated against our current spectrum's measured moments. The cost is not the spectrum, it is the recalibration of nine downstream consumers. |
| **TMA depth correction** [SRC `spectrum.js:53-59`] | Tempting now that shoaling landed — but their `depth` is a **single global scalar** (`params.js:19`, `depth: 500`), not a field. It cannot vary per position, so it cannot know about an island. Our per-cascade `tanh(k·d)` against a real seabed field is strictly more capable. |
| **Their spray** [SRC `spray.js`] | We have a better one already (§2.4), and theirs is disabled in their own repo. |
| **Their normal without a denominator clamp** [SRC `oceanSurfaceMaterial.js:37`] | `d.z → −1` divides by zero. Our `.max(0.05)` exists for a reason. |
| **Point-sampled, un-mipped, un-blurred foam** [SRC `maps.js:8-14`] | Their `maps.js:7` comment claims auto-mipmapping; three's `StorageTexture` does not do that. Their foam aliases. Ours has four band-limiting mechanisms. |
| **`renderer.compute()` per FFT step from JS** [SRC `Ocean.js:94`] | Their `logN·2 + 1` = 17 separate submits per frame, batched across fields. We already solved the same barrier problem; do not "improve" ours toward theirs without measuring. |

---

## 6. Weather-driven cascading — what their architecture reveals

The user's own idea, and poseidon does not implement it. What it *does* do is make
the blocker visible.

### 6.1 Their initial spectrum is a GPU compute kernel. Ours is a 419 ms CPU loop.

[SRC `spectrum.js:119-148`] — `buildInitialSpectrum` is `Fn(...)().compute(N*N)`.
[SRC `Ocean.js:78-84`] — recomputing h0 is two `computeAsync` dispatches per
cascade. At N = 256 × 3 cascades that is 6 × 65 536 invocations, i.e. sub-millisecond.
[SRC `gui.js:15-18`] — they still bind it to `onFinishChange` (slider release), not
`onChange`, which suggests they did not consider it free either. [INF]

Ours [OURS `src/ocean/oceanMath.ts:663-706`, `oceanCascades.ts:120-160`]:
`generateH0` is a JS `Float32Array` fill, and `generateSpectrumData` additionally
re-measures `steepnessRms`, `jacobianRms`, `heightVariance`, `meanWavenumber` and
`slopeBins` — **five more full N² CPU scans per cascade, at N = 512, ×3 cascades**.
Measured cost: **419 ms warm** [OURS `src/ui/settingsControls.ts:42-47`].

It is rate-limited to one rebuild per 16 `update()` calls (~267 ms), latest-wins,
with a comment explaining that this is a **rate limit, not a quiet-detector**,
precisely because §V.46 drives `windSpeed` off the storm field at the ship's
position and a moving ship changes the signature every tick
[OURS `oceanCascades.ts:290-309`].

**So: a ship sailing through a squall gradient currently steps its entire wave
field every ~267 ms, and each step costs 419 ms of main-thread JS.** That is the
real state of weather→ocean coupling, and it is the thing to fix before anyone
animates cascade parameters.

**The honest caveat on porting h0 to the GPU:** it removes *one* of roughly six
N² CPU scans. The five moment integrators must stay on the CPU — every σ-relative
gate in `src/foam`, the spray gates, the choppiness fold cap and the analytic
sub-pixel slope variance read them as scalar uniforms, and `src/sea-physics/cpuOcean.ts`
needs its own mirror for buoyancy regardless. I have **not** measured the split
between h0 generation and moment integration inside that 419 ms. **[GAP — measure
before committing to this.]**

### 6.2 Their band cutoffs are live uniforms. Ours are baked into a CPU texture.

[SRC `OceanCascade.js:13-15`]:
```js
this.deltaK    = uniform((2 * Math.PI) / lengthScale);
this.cutoffLow = uniform(cutoffLow);
this.cutoffHigh= uniform(cutoffHigh);
```
[SRC `spectrum.js:142`] — the band mask is `step(cutoffLow, kLen) · step(kLen, cutoffHigh)`,
evaluated **on the GPU every time h0 is rebuilt**. Hand-off between cascades is
`2π/L_i × boundaryFactor` [SRC `Ocean.js:34,41-42`].

Ours [OURS `src/ocean/oceanMath.ts:23-32`] is a JS `if`-chain applied inside
`generateH0` [OURS `:678-683`]. **The band filter never appears in any TSL graph.**
The GPU only ever sees an already-filtered `h0Texture`. The only GPU uniforms in
our whole sim path are `timeUniform` and `choppinessUniform`
[OURS `spectrumPass.ts:39`, `unpackPass.ts:43`].

### 6.3 Three findings the implementing agent needs before touching this

**(a) Our cascade domains are silently unchangeable at runtime.** `OceanCascade.domain`
is `readonly` and assigned once in the constructor [OURS `oceanCascades.ts:34,98`].
`spectrumSignature` includes `p.cascades.map(c => c.domain)` [OURS `:195`], so
changing it *fires a rebuild* — but `generateSpectrumData` reads `this.domain`, the
frozen copy [OURS `:124-130`], and the domain is additionally **baked as a WGSL
literal** in two graphs: `spectrumPass.ts:47-48` (a plain JS `number` parameter, so
`.div(domain)` emits a constant) and `surfaceMaterial.ts:520,580` (the tiling
divisor). **A weather-driven domain change today would do nothing at all, loudly
rebuilding while quietly ignoring the new value.** Fix that before designing
anything on top of it.

**(b) Only two of the seven ocean preset keys are actually localised.**
`createAmbientHold(['windSpeed', 'amplitude'], oceanParams)`
[OURS `src/main.ts:255-258`]. `blendSample` blends all seven
[OURS `src/weather/sampler.ts:101-115`] but `publish` loops over `keys` only
[OURS `:186-194`], so `choppiness`, `jacobianFoamBias`, `swellPeriod`,
`swellAmplitude` and `swellDirection` are **globally lerped and never localised** —
the blended values are computed into `weatherHere.ocean` and thrown away. If the
user wants cascade behaviour to follow the weather *field*, that list is where it
starts, and adding a key there is a one-word change.

**(c) There are three per-cascade weights already on the GPU that need no h0
rebuild at all** [OURS]:

1. `dispLod[i]` — vertex displacement weight, `surfaceMaterial.ts:407-413`
2. `normLod[i]` — fragment normal weight, `surfaceMaterial.ts:466-469`, with a
   genuine per-cascade `vec2` uniform `uNormFoot[i]`
3. `lane.u.uBias` — per-cascade foam gate, written **every frame** with each band's
   own live σ, `src/foam/index.ts:372-375`

and `choppinessUniform` is per-cascade in the API but collapsed to one global λ
[OURS `oceanCascades.ts:315-316`].

**This is the cheap route and it should be tried first.** A weather-driven
`uCascadeGain[i]` multiplied into `dispLod`/`normLod`, plus per-cascade choppiness,
moves the *visible balance* between swell and chop with **zero rebuilds and zero
new bindings**. It is not physically the same as re-shaping the spectrum — it
scales the rendered contribution, not the energy — so §V.64 accounting would need
stating honestly. But it is hours, not weeks, and it would tell you whether the
idea is worth the GPU-spectrum port at all.

---

## 7. Licence

**MIT.** `Copyright (c) 2026 owenyuwono` [SRC `LICENSE`], and `"license": "MIT"`
in `package.json`. Their upstream `gasgiant/FFT-Ocean` is **also MIT** (confirmed
via the GitHub licence API), and poseidon credits it explicitly in `README.md`.
**The chain is clean.**

**We may copy code from it.** MIT requires only that the copyright notice and
permission notice be included "in all copies or substantial portions of the
Software". Practically, for this repo:

- Copying a **line or an idea** (the `min`-hold, the debug-quad pattern) is fine
  and needs no notice — those are ideas, not substantial portions.
- Copying a **file or a whole function verbatim** requires an attribution comment
  naming poseidon, the MIT licence and the author, in the file that receives it.
- The same applies transitively if anything is lifted from `gasgiant/FFT-Ocean`.

This is a genuinely permissive licence — unlike Water Pro, which
`docs/research-water-implementations.md` §1 records as forbidding decompilation
and competing products. **Nobody needs to be cagey about reading or borrowing from
poseidon.** Just attribute anything substantial.

---

## 8. What WE do better

The user was explicit that we are not throwing our work away. This section exists
so a well-meaning agent reading §2 does not "simplify" toward poseidon.

**Foam — not close.**
- **λ⁻, not det J**, with the measurement that justified it [OURS `foamMath.ts:158-186`].
- **Two clocks, two channels, one texture** — a 0.9 s residue and a 0.15 s
  breaking rate, so the mask encodes breaking *intensity* and not dwell time. Cost
  the project zero bindings because G and B were already being written as zero
  [OURS `foamMath.ts:425-480`]. Poseidon has one clock.
- **Crest-frame anisotropic breakup** from a structure tensor of ∇h on a ring
  whose radius is derived from the band's own shortest wavelength, with the
  measured agreement curve that found the optimum (0.855 at 4 cells, −0.127 at 32)
  [OURS `foamMath.ts:717-796`]. Poseidon has no breakup field.
- **Wind-gated coverage** via Callaghan 2008's threshold-cubic, so the Jacobian
  decides *where* and the wind decides *how much* — a tall swell on a windless day
  correctly sheds no foam [OURS `foamMath.ts:313-345` for the argument,
  `:340` `WHITECAP_ONSET_MS = 3.7`, `:403` `whitecapWindScale`]. Poseidon's foam
  is wind-blind: turn the wind to zero and the folds still foam.
- **An optical-depth composite** `1 − e^(−density·depth)` giving real opacity
  variation [OURS `foamMath.ts:866` `foamCoverage`]. Poseidon's foam is a binary-ish
  `mix(water, foam, coverage)` to a flat colour.
- **A dissolve threshold that carves the silhouette**, with a derived sub-pixel
  band limit (residual 0.045 of alpha, tested) [OURS `foamShading.ts:361-436`].
- **Progressive blur with feedback** (Rare, SIGGRAPH '18) [OURS `foamPasses.ts:9-13`].
- **A full CPU mirror with tests** for every one of the above.

**Ocean sim.**
- **Analytic anti-fold choppiness cap** from the spectrum's own trace moment, with
  the recorded story of why the moment is the trace and not the x-projection (the
  swell train made the projection read 0.38× of truth) [OURS `oceanMath.ts:615-655`].
- **Shoaling**, `tanh(k·d)` per cascade plus a soft breaker clip, **CPU-mirrored
  for buoyancy**, with the clip's derivative carried into the normal so a limited
  crest is shaded correctly [OURS `surfaceMaterial.ts:556-566,681-695`]. Poseidon's
  `depth` is one global scalar used only inside the dispersion relation.
- **N = 512 on domains up to 1010 m** against their 256 on 250 m.
- **Analytic sub-pixel slope variance per cascade, from the spectrum, for three
  scalar uniforms and zero texture fetches** [OURS `surfaceMaterial.ts:585-613`] —
  including the three separate reasons a mip chain cannot do this job here.

**Shading.**
- Per-channel Jerlov absorption, planar reflection, screen-space refraction,
  Tokuyoshi/Kaplanyan specular AA, shadow routed differently through the sun
  glint, the scatter and the sky reflection, grazing re-saturation, and a named
  pigment floor. Poseidon's material is `MeshBasicNodeMaterial` — **unlit, no
  shadow, no depth, no refraction, no reflection RT**.

**Engineering.**
- A binding ledger enforced by a test (`tests/oceanBindingBudget.test.ts`) with
  the counting rules for three r180 written down, because overrun does not
  degrade — the pipeline is invalid and the material never draws.
- CPU mirrors + tests for foam, spray, shoaling and the spectral moments.
- Deterministic hashing throughout — no `Math.random` in any per-particle path.

**The one thing poseidon does that we should be slightly embarrassed about:** it
validates its IFFT against an analytic impulse and an analytic single frequency at
boot, and puts PASS/FAIL on screen [SRC `fft.js:114-152`, `main.js:50-52`]. That
is a good habit. We have tests, which is better in CI — but we have no in-app
correctness gate. Cheap to add, and it belongs in the debug view of §2.3.

---

## 9. Reference: the budget, restated

Because every judgement above turns on it.

- **Ocean fragment: 17 sampled textures / 15 samplers. Ceiling is 16 samplers, and
  it is a Metal hardware wall — `maxSamplersPerShaderStage` *is* 16 on Apple
  silicon, so requesting more buys nothing.** One spare, and it is contested
  [OURS `tests/oceanBindingBudget.test.ts:131-143,360-386`; `SPEC.md:169`].
- **Ocean vertex: 4 textures / 4 samplers. Twelve free.**
- Unfilterable textures (`min === mag === Nearest`, no `compareFunction`) are read
  with `textureLoad` and **cost no sampler** — which is why our viewport depth and
  scene-colour reads are free.
- Bindings dedupe **by texture UUID**, not by node. Two reads of the same texture
  cost one binding — this is why the foam art texture is one texture sampled at
  two world scales [OURS `foamShading.ts:292-297`].
- Vertex and fragment get **separate** bindings for the same texture.
- **Compute-stage `textureLoad` costs nothing on this budget at all.** This is why
  §3.3A and §2.4 are affordable and §2.5 is not.

**Two housekeeping items found while auditing, neither in scope here but both
worth a line in the next spec pass:**

1. **`SPEC.md:81` (§V40) is stale.** It records "ocean fragment **16 sampled
   textures / 14 samplers**"; the enforced ledger asserts **17 / 15**. The foam
   art texture landed after the spec line was written. [OURS]
2. **`src/weather/haze.ts` and `src/weather/hazeNode.ts` have zero consumers in
   `src/`** — `createStormHaze` appears only in its own file and in
   `tests/rain.test.ts`. `src/sky/lighting.ts:200-210` still uses plain
   `p.hazeStrength`, so `hazeAnisotropy` / `hazeAwayMultiplier` /
   `hazeSunMultiplier` / `hazeStormWeight` in `src/params/weather.ts:127-130`
   currently drive nothing. [OURS]
