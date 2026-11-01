/**
 * The islands' ground for the film (Act 3's beach; the user, 2026-10-27: the game's terrain is "flat coloured
 * stuff, no structure"): scanned CC0 PBR layers (scripts/drift-pbr-fetch.py, packed by drift-pbr-pack.py) in
 * the game's own terrain blend, through its ground hook (terrain/sandMaterial.ts TerrainBlendHooks) — so the
 * waterline, the swash, the water lighting over the shallows and the aerial haze all stay the game's:
 *
 *   sand_dry      ambientCG Ground027   pale fine beach sand: its colour's grain only
 *   sand_relief   Poly Haven aerial_beach_02   the dry sand's shape: a 20 m scan of a smooth beach
 *   sand_wet      ambientCG Ground061   wet, smooth sand at the waterline
 *   rock          Poly Haven rock_boulder_dry   where the ground is too steep to hold sand or cover
 *   grass         Poly Haven sparse_grass       the cover above the beach
 *   forest_floor  Poly Haven forest_floor       mixed into the cover, its autumn leaves dulled (temperate)
 *
 * Each layer is two RGBA maps (albedo + roughness; normal xy + ambient occlusion + height), sampled flat on
 * the ground (xz) without a repeat: Quílez's "texture repetition" (its third, two-tap form) — a slow gradient
 * noise picks one of 8 offsets of the tile and blends to the next across its transitions, the blend biased by the
 * two samples' own contrast so it follows the texture's features and not a straight band. (The earlier anti-tiling
 * — two scales and two turns blended by a value noise — left a single tile wherever the noise saturated, and the
 * value noise's own cells: a grid through the sand, the v9 review.) The rock is triplanar. The shading normal is
 * the maps' (reoriented about the ground's), in view space as the hook wants it.
 *
 * Under the palms the ground is darker (`setOccluders`): a crown hides the sky overhead, and at golden hour the
 * sky is most of the light on a beach (the Sun is over the sea: the palms' own shadows fall inland, out of view).
 * Ambient occlusion, so the low Sun's direct light still reaches under them.
 */
import * as THREE from 'three/webgpu';
import { Fn, Loop, abs, cameraPosition, cameraViewMatrix, dFdx, dFdy, exp, float, mix, normalWorldGeometry, positionWorld, sin, smoothstep, texture, uniform, uniformArray, vec2, vec3, vec4, vertexStage } from 'three/tsl';
import type { TerrainBlendHooks } from '../../terrain/sandMaterial';
import { fbm2, hash2 } from '../../terrain/noise';
import { WRACK } from './beachDressing';
import { swashAt, swashClock } from './shoreline';
import { swashField, swashIn, swashUV } from './swashSim';
import { coordFilter } from '../../ship/bandLimit';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** m: each layer's tile (its scan's real size where known), w × h */
const LAYERS = {
  sand_dry: [2.2, 2.2],
  sand_wet: [3.2, 1.6],
  rock: [1.8, 1.8],
  grass: [2, 2],
  forest_floor: [2.14, 2.14],
} as const;
type Layer = keyof typeof LAYERS;

/** the dry sand's albedo, linear: coral sand's warm off-white (references §12.4, sunlit #e6d9c1) — the scan's grain
 * rides on it in luminance only */
const SAND_DRY = vec3(0.6, 0.55, 0.45);
/** wet sand's albedo, linear: a neutral grey-beige under half the dry's (wet sand drinks the light) */
const SAND_WET = vec3(0.3, 0.285, 0.255);
/** m of rise above the live sea the wet band reaches: its mean, and the full swing of its wander along the beach */
const WET_RISE = [0.6, 0.3] as const;
/** THE SWASH'S UPPER LIMIT, beachDressing.ts LIMIT and its placement (`zones`): m over the sea of the line's middle,
 * how far it wanders (fbm2 at 17 m), its half-width in height; its clumps (fbm2 at 5.3 m); how strongly the grit
 * tints the sand at the line's core */
const SWASH_LIMIT = { height: 0.62, wander: 0.06, half: 0.07, strength: 0.32 };
/** m: the dry sand's relief scan (aerial_beach_02), its real size — bound as sand_dry's second map */
const RELIEF_TILE = 20;
/** the relief scan's slopes taken to this share. Its median slope is 2–3° at 2–8 cm, its ripple patches and pits
 * ~10°; at the w3–w5 Sun, 1–6° up, a facet tilted by the Sun's own elevation takes double the sunlight or none. At
 * 0.6 the scan's 5–10 cm clumps still mottled the beach blue-grey at 4° (wrack_650, the 16:9 review stills); at 0.4
 * what is left is the broad undulations, the odd ripple patch and pit catching the light */
const RELIEF_GAIN = 0.4;
/** the relief's mip footprint over the pixel's (see relief()): near the eye, and from FAR_AT m on */
const RELIEF_BLUR = [2.5, 6] as const;
/** m from the eye the relief's blur and the grain's contrast hand over across */
const FAR_AT = [2, 6] as const;

export interface BeachTerrain {
  hooks: TerrainBlendHooks;
  ready: Promise<void>;
  /** what hides the sky from the ground: (x, z) m, radius m, strength 0..1 — a palm's crown, a trunk's foot */
  setOccluders(list: Array<[number, number, number, number]>): void;
  /** where leaf litter lies on the ground (forest.ts litterMask): LITTER_RES² weights 0..255 over the square from
   * `origin` (world x, z) `size` m on a side; and `contact`, the same square's contact shade at the plants' feet
   * (forest.ts contactMask: the share of the sky hidden, 0..255), none if left out */
  setLitter(mask: Uint8Array, origin: [number, number], size: number, contact?: Uint8Array): void;
}

/** texels a side of the litter mask */
export const LITTER_RES = 1024;

/** the most occluders the ground reads (each a few ALU per terrain fragment) */
const MAX_OCCLUDERS = 112;
/** m: where the fine patterns are measured from — the coast's anchor (sea.ts COAST_AT); any point within a few km of
 * the beach would do. The coast lies 40 km out, where a 32-bit world position steps every 4 mm: a tile's uv there
 * (~2·10⁴) steps every 1/256 of a tile, many texels of a 4k map, and a 4 cm speck's noise every 1/16 of a speck —
 * blocks and rulings the pixels beat into moiré (the sim water's did, the 2026-10-30 note: "this weird moiré
 * pattern"). Measured from here, at the vertex, and interpolated small, they are exact. Kept on the world position:
 * everything that must agree with something placed on the CPU at the same world point (the swash-limit and wrack
 * bands with beachDressing.ts, the swash's events and sim, the litter, the occluders) — all metres-scale, where the
 * 4 mm steps do not show */
const PATTERN_ORIGIN = new THREE.Vector3(-40000, 0, 0);

export function createBeachTerrain(
  base = `${import.meta.env.BASE_URL}drift/pbr/packed/`,
  /** the Sun's transmittance through the clouds at a world point (seaSky.ts `cloudSun`): their shadows on the ground */
  o: { cloudSun?: (p: V3) => F } = {},
): BeachTerrain {
  const loader = new THREE.TextureLoader();
  const loads: Promise<unknown>[] = [];
  const tex = (name: string): THREE.Texture => {
    let t!: THREE.Texture;
    loads.push(new Promise((ok, fail) => (t = loader.load(`${base}${name}.png`, ok, undefined, () => fail(new Error(`beach: ${name} (run scripts/drift-pbr-pack.py)`))))));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    // raw: the albedo's rgb is sRGB with linear roughness in a (decoded by hand below), the other map is data
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  // (the dry sand's second map is the relief scan's, not Ground027's own: see the SAND section below)
  const maps = Object.fromEntries((Object.keys(LAYERS) as Layer[]).map((l) => [l, { a: tex(`${l}_albedo_rough`), b: tex(l === 'sand_dry' ? 'sand_relief_normal_ao_h' : `${l}_normal_ao_h`) }])) as Record<
    Layer,
    { a: THREE.Texture; b: THREE.Texture }
  >;

  /** sRGB → linear (the albedo's rgb) */
  const linear = (c: V3): V3 => c.pow(2.2) as V3;
  /** m from PATTERN_ORIGIN, exact (see there) */
  const pL = vertexStage(positionWorld.sub(vec3(PATTERN_ORIGIN.x, PATTERN_ORIGIN.y, PATTERN_ORIGIN.z))) as unknown as V3;
  const pP = pL.xz as V2;

  // the index field the tile offsets follow: a slow gradient noise (no cells to show), m
  const index = fbm2(positionWorld.xz.div(13), 2).mul(8) as F;
  const indexCell = index.floor();
  const indexBlend = index.fract();
  const offA = sin(vec2(3, 7).mul(indexCell)) as V2;
  const offB = sin(vec2(3, 7).mul(indexCell.add(1))) as V2;

  /** one layer flat on the ground: albedo (linear), roughness, tangent normal (xy), AO — without a repeat */
  const flat = (layer: Layer, k = 1) => {
    const [tw0, th0] = LAYERS[layer];
    const tw = tw0 * k;
    const th = th0 * k;
    const p = pP;
    const uv = vec2(p.x.div(tw), p.y.negate().div(th)) as V2;
    // (explicit gradients: the offsets jump at an index step, and an implicit sample there takes the smallest mip)
    const gx = dFdx(uv);
    const gy = dFdy(uv);
    const A1 = texture(maps[layer].a, uv.add(offA)).grad(gx, gy) as V4;
    const A2 = texture(maps[layer].a, uv.add(offB)).grad(gx, gy) as V4;
    const B1 = texture(maps[layer].b, uv.add(offA)).grad(gx, gy) as V4;
    const B2 = texture(maps[layer].b, uv.add(offB)).grad(gx, gy) as V4;
    const d = A1.rgb.sub(A2.rgb);
    const w = smoothstep(0.2, 0.8, indexBlend.sub(d.x.add(d.y).add(d.z).mul(0.1))) as F;
    const a = mix(A1, A2, w) as V4;
    const n = mix(B1.xy.mul(2).sub(1) as V2, B2.xy.mul(2).sub(1) as V2, w) as V2;
    return { albedo: linear(a.rgb as V3), rough: a.a as F, n, ao: mix(B1.z, B2.z, w) as F, h: mix(B1.w, B2.w, w) as F };
  };

  /** the dry sand's relief (sand_dry's second map, the 20 m scan): tangent normal (xy) and AO, without a repeat on
   * an index field of its own, slower than the tiles' (its features are metres apart, not centimetres) */
  const relief = () => {
    const p = pP;
    const uv = vec2(p.x.div(RELIEF_TILE), p.y.negate().div(RELIEF_TILE)) as V2;
    const ri = fbm2(p.div(61).add(vec2(17.3, 4.1)), 2).mul(6) as F;
    const rA = sin(vec2(3, 7).mul(ri.floor())) as V2;
    const rB = sin(vec2(3, 7).mul(ri.floor().add(1))) as V2;
    // (sampled RELIEF_BLUR × blurrier than the pixel asks: the scan's 5 mm texels carry a speckle of grain clumps,
    // slopes to 25°, that a few metres off is a pixel's size — a fine gritty mottle, sky-blue in its shadows, at the
    // w3–w5 Sun. "I'd much rather have stuff disappear than look noisy" (the user, 2026-10-29). At the eye's feet a
    // little of the grain is kept)
    const blur = mix(float(RELIEF_BLUR[0]), float(RELIEF_BLUR[1]), smoothstep(FAR_AT[0], FAR_AT[1], positionWorld.sub(cameraPosition).length())) as F;
    const gx = dFdx(uv).mul(blur);
    const gy = dFdy(uv).mul(blur);
    const B1 = texture(maps.sand_dry.b, uv.add(rA)).grad(gx, gy) as V4;
    const B2 = texture(maps.sand_dry.b, uv.add(rB)).grad(gx, gy) as V4;
    // (the hand-over biased by the two heights, so it runs round a ripple patch or a pit, not through it)
    const w = smoothstep(0.2, 0.8, ri.fract().sub(B1.w.sub(B2.w).mul(0.5))) as F;
    return { n: mix(B1.xy.mul(2).sub(1) as V2, B2.xy.mul(2).sub(1) as V2, w) as V2, ao: mix(B1.z, B2.z, w) as F };
  };

  // THE LEAF LITTER under the trees and round every foot (the user, 2026-10-29: shrubs "poke out of the sand
  // straight up"): a mask laid by forest.ts (setLitter), empty until then. Half-float red, the seabed's own format,
  // unmipped (a smooth field of half-metre texels). setLitter hands each sampling node a NEW texture: rewriting
  // the first one's data and flagging it never reached the GPU here — the litter read zero everywhere.
  // Its green, THE CONTACT SHADE at the plants' feet (forest.ts contactMask): one texture, two channels, no binding
  // more.
  const litterOf = (data: Uint16Array): THREE.DataTexture => {
    const t = new THREE.DataTexture(data, LITTER_RES, LITTER_RES, THREE.RGFormat, THREE.HalfFloatType);
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    t.needsUpdate = true;
    return t;
  };
  let litterTex = litterOf(new Uint16Array(LITTER_RES * LITTER_RES * 2));
  const litterNodes: Array<{ value: THREE.Texture }> = [];
  const litterAt = uniform(new THREE.Vector2(0, 0));
  const litterInv = uniform(1);

  // THE SKY HIDDEN BY THE PALMS (see the header)
  const occData = Array.from({ length: MAX_OCCLUDERS }, () => new THREE.Vector4(0, 0, 1, 0));
  const occ = uniformArray(occData, 'vec4');
  const skyOcclusion = Fn(() => {
    const keep = float(1).toVar();
    Loop(MAX_OCCLUDERS, ({ i }: { i: THREE.Node }) => {
      const o = occ.element(i) as unknown as V4;
      const d = positionWorld.xz.sub(o.xy);
      keep.mulAssign(float(1).sub(o.w.mul(exp(d.dot(d).div(o.z.mul(o.z)).negate()))));
    });
    return keep;
  })() as F;

  /** value noise of the ground's position / scale, 0..1 (anti-tiling and patchiness) */
  const noise = (scale: number): F => {
    const q = pP.div(scale);
    const i = q.floor();
    const f = q.fract();
    const u = f.mul(f).mul(f.mul(-2).add(3));
    // (sin-free, the same on every GPU: tests/gpuSinHash.test.ts)
    const hash = (o: V2): F => hash2(i.add(o)) as F;
    const a = hash(vec2(0, 0) as V2);
    const b = hash(vec2(1, 0) as V2);
    const c = hash(vec2(0, 1) as V2);
    const d = hash(vec2(1, 1) as V2);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) as F;
  };

  const hooks: TerrainBlendHooks = {
    // THE CLOUDS' SHADOWS on the sand and the seabed (the open notes' "cloud shadows on the sea": the lagoon's
    // turquoise is the lit floor seen through the water, so a shadow shows there first) — the same transmittance the
    // sea's sun terms and the swash take, read at the vertex: the cloud light volume is two filterable 3D textures,
    // and the ground's fragment stage already binds a dozen maps; the shadow is ~100 m soft, the ground's cells ≤ 6 m
    sunThrough: o.cloudSun ? vertexStage(o.cloudSun(positionWorld as unknown as V3)) : undefined,
    ground(ctx) {
      const N = normalWorldGeometry;
      // THE TERRAIN'S WEIGHTS AS SCALARS. ctx.shoreW (and so ctx.groundW, mixed by it) reaches this hook as a vec2:
      // groundCover.ts multiplies the shore band's wobble by periodResolved(bandCoord), the band-limit of a vec2
      // coordinate, which is a vec2. In mix(vec3, vec3, w) TSL widens that w to vec3(x, y, 0), so the BLUE channel of
      // the beach's albedo and the world-z of its shading normal were the ROCK layer's (triplanar rock_boulder_dry,
      // 1.8 m) and the cover's, not the sand's: the rock's blotches in blue, its normal map's tilt in z — the
      // "lavender pits" and gold crests all over the beach under the w3–w5 Sun (the 2026-10-29 reviews; found by
      // rendering the beach with a white albedo × groundW: blue came out exactly 0). float() takes the x component
      const groundW = float(ctx.groundW) as F;
      const shoreW = float(ctx.shoreW) as F;
      const dry = flat('sand_dry');
      const wet = flat('sand_wet');
      const grass = flat('grass');
      const leaves = flat('forest_floor');


      // SAND (the v11 review: "the beach looks very cheap"; the 2026-10-29 reviews: "very gritty and regular … it
      // looks hyper tiled", and "lavender"). A coral beach's dry sand is soft, pale warm off-white and fine-grained;
      // its shape low broad undulations, a rare soft patch of wind ripples, the odd pit (references §12.4, §12.8):
      //  · its COLOUR a warm off-white (SAND_DRY; §12.4, sunlit #e6d9c1) with the Ground027 scan's grain in its
      //    luminance only, at 0.7–0.35 of its contrast (its hue's orange and green specks are a temperate beach's debris);
      //    away from the eye the same scan at 4.3× (9.5 m), so its 2.2 m tile does not repeat; under it all two slow
      //    swells of tone (23 m, 7 m), drier and paler here, damper there, as a real beach is;
      //  · its SHAPE the 20 m aerial_beach_02 scan (relief(), RELIEF_GAIN), not Ground027's own normals: trampled
      //    lumps every 10–20 cm, median slope 21° and still 6° at the quarter they were last drawn at. Under the
      //    w3–w5 Sun, 1–6° up, every lump was lit gold on one side and sky-lit on the other: the whole beach one
      //    regular mottle. (Mipmapped, the relief's centimetre grain fades to its mean with distance by itself.)
      const LUM = vec3(0.2126, 0.7152, 0.0722);
      const dryFar = flat('sand_dry', 4.3);
      const far = smoothstep(4, 22, positionWorld.sub(cameraPosition).length()) as F;
      // (the scan's mean linear luminance is 0.476)
      const grain = mix(dry.albedo, dryFar.albedo, far.mul(0.65)).dot(LUM).div(0.476) as F;
      const macro = fbm2(positionWorld.xz.div(23), 3).mul(0.2).add(fbm2(positionWorld.xz.div(7).add(31.7), 2).mul(0.08)).add(0.86) as F;
      // (the grain's contrast at 0.7 at the eye's feet, where a pixel is a millimetre or two, half that from FAR_AT on)
      const grainK = mix(float(0.7), float(0.35), smoothstep(FAR_AT[0], FAR_AT[1], positionWorld.sub(cameraPosition).length())) as F;
      const dryA = SAND_DRY.mul(mix(float(1), grain, grainK)).mul(macro) as V3;
      const rel = relief();
      const dryN = rel.n.mul(RELIEF_GAIN) as V2;
      // THE WET BAND (the user, 2026-10-29: "the wet sand should be a little longer and darker"): the sand the swash
      // keeps wet, from the water up WET_RISE of rise (5–8 m of the 1:11 face), saturated at the water and drying
      // toward its wandering top; a shade darker for half a metre above that. Wet sand drinks the light: a neutral
      // grey-beige half the dry sand's albedo where saturated (the wet scan's grain in its luminance only), and
      // mirror-ish there (roughness 0.14), matte again as it dries; its shape the dry sand's smoothed by the swash: the
      // wet scan's own ripples, a regular one every few cm everywhere, only a trace of it
      const rise = float(ctx.sand.depthBelow).negate() as F;
      const wetTop = fbm2(positionWorld.xz.div(9).add(vec2(3.1, 8.7)), 2).sub(0.5).mul(WET_RISE[1]).add(WET_RISE[0]) as F;
      // (the swash's own events, shoreline.ts swashAt: the sand dark under each run-up's water and drying behind it)
      const swE = swashAt(rise, positionWorld.xz, swashClock as unknown as F);
      // (over the swash sim's domain, its own fields: swashSim.ts — wet where its water has been, glazed after it)
      const simIn = swashIn(positionWorld.xz) as F;
      const simMarks = texture(swashField.marks, swashUV(positionWorld.xz)) as V4;
      // (what the water left — its wetness and its glaze — read a little off where it lies, ±0.2 m over a metre and
      // ±0.05 m over 30 cm: the line a run-up stopped at, crisp in the sim's 10 cm cells, meanders and frays as the
      // sand drains. The water itself, `sheet` below, is read where it is)
      const leftAt = positionWorld.xz.add(vec2(fbm2(pP.mul(0.9).add(vec2(2.4, 7.7)), 2), fbm2(pP.mul(0.9).add(vec2(9.1, 1.3)), 2)).sub(0.5).mul(0.4))
        .add(vec2(fbm2(pP.mul(3.3).add(vec2(5.5, 0.6)), 2), fbm2(pP.mul(3.3).add(vec2(1.8, 4.4)), 2)).sub(0.5).mul(0.1)) as V2;
      const leftMarks = texture(swashField.marks, swashUV(leftAt)) as V4;
      // (graded, not a band: saturated at the still water, drying up the face to wetTop — one wide uniform dark band
      // read heavy, the swash v2 clips — and the swash's own wetness over it, its darkness going as it dries)
      // (the sim's wetness drying unevenly where it is going: ±0.4 of what is left of it, in patches of ~0.4 m — with the
      // sim's own wicking (WICK) the line a run-up stopped at goes soft and ragged as it dries, not a crisp lobe, the
      // 2026-10-30 note: "real drying is uneven")
      const wetLeft = leftMarks.z as F;
      const wetSim = wetLeft.sub(float(1).sub(wetLeft).mul((fbm2(pP.mul(2.5).add(vec2(6.6, 3.2)), 3) as F).sub(0.5).mul(0.8))).clamp(0, 1) as F;
      // THE LAST HIGH RUN-UPS' REACH (the user, 2026-11-01, of the beach at dusk: "way too sharp all the way through, no
      // layers"): the graded band faded out smoothly to wetTop, and from the walk's eye, at this grazing, those 6 m of
      // fading face squeezed into a few pixels — no band, only the water's edge. A real beach's damp sand has an edge
      // of its own, where the highest run-ups of the last hour stopped: damp below, pale dry sand above, the line
      // scalloped by the swash's cusps (horns every ~18 m along it, ±0.4 m across) and frayed where it dries. So: the
      // grade holds at under half-wet (0.45) up to that line, and gives out over ~0.3 m of face across it
      const cusp = sin(pP.y.mul((2 * Math.PI) / 18).add(fbm2(pP.mul(0.05).add(vec2(1.7, 4.2)), 2).mul(5))).abs().sub(0.64).mul(0.07) as F;
      const fray = fbm2(pP.mul(1.4).add(vec2(8.3, 2.6)), 2).sub(0.5).mul(0.05).add(fbm2(pP.mul(4.7).add(vec2(0.9, 6.1)), 2).sub(0.5).mul(0.02)) as F;
      const reachTop = wetTop.add(cusp).add(fray) as F;
      const graded = mix(float(1), float(0.45), smoothstep(-0.02, reachTop.mul(0.9), rise)).mul(float(1).sub(smoothstep(reachTop.sub(0.03), reachTop, rise))) as F;
      // OVER THE SWASH SIM, ITS WATER ALONE WETS THE SAND (the user, 2026-11-01, of the walkers' view at 705 s: "the wet
      // sand effect is way too far up for the distance the waves actually reach here. It's also not synced, so it moves
      // disconnected from the water … We had this looking better at the landing shot"). That band and its reach line
      // stood at a fixed WET_RISE over the sea — 0.45–0.75 m of rise, 5–8 m of the 1:11 face — where the sim's run-ups
      // at dusk reach 1.4–4 m: a dark band metres above every wave, its edge wandering with its own noise. Where the
      // sim runs, the sand is as wet as its water left it (`wetSim`: under each run-up, drying over the sim's DRY s
      // behind it and wicking soft — the last few waves' reach, and nothing above it), on a thin strip of seep along
      // the still waterline (the water table, ~0.05 m of rise: half a metre of face). The fixed band stays only beyond
      // the sim's ends, under the analytic events (shoreline.ts swashAt)
      const seep = float(1).sub(smoothstep(-0.02, 0.05, rise)) as F;
      const damp = mix(graded, seep, simIn).max(mix(swE.wet, wetSim, simIn)) as F;
      const wetA = SAND_WET.mul(mix(float(1), wet.albedo.dot(LUM).div(0.54), 0.5)) as V3;
      // (the shade darker above the band: over the sim, above where its water has been, not above a fixed line)
      const margin = float(1).sub(smoothstep(reachTop, reachTop.add(0.5), rise)).mul(0.1).mul(float(1).sub(simIn)) as F;
      // sand: dry above the wet band, wet in it, foam where the swash is. UNDER WATER it is the lagoon's white coral
      // sand, neutral grey-beige (§12.4: #9a9888 under 20–50 cm); the water's own absorption turns it turquoise
      // (only under a quarter metre of water and more, and darker than it was: a pale grey-beige from 5 cm down painted
      // a dry-looking strip between the sea and the wet sand — "a band in between where there's no water … very ugly
      // and unlikely", the 2026-10-29 review of the 568 s view. The sand nearest the sea is the wettest, never paler)
      const submerged = smoothstep(0.25, 1.2, float(ctx.sand.depthBelow)) as F;
      const sandA0 = mix(mix(dryA.mul(float(1).sub(margin)), wetA, damp), wetA.mul(1.3), submerged) as V3;
      // THE SWASH'S UPPER LIMIT (the dressing's recommendation, 2026-10-29): where the last waves dropped what they
      // carried, a faint band of shell grit and dried foam along the line beachDressing.ts lays its pebbles and
      // shells on — the same height, wander and clumps as its placement (SWASH_LIMIT), so the decal carries the line
      // on past the ~27 m where those pieces fade out, as the wrack line's decal does. Pale shell and darker grit in
      // 4 cm specks (their mean from where a pixel spans half a speck: no sparkle at distance), darker where it is wet
      const limitMid = fbm2(positionWorld.xz.div(17).add(vec2(3.1, 0)), 2).sub(0.5).mul(2 * SWASH_LIMIT.wander).add(SWASH_LIMIT.height) as F;
      const limitOff = positionWorld.y.sub(limitMid).div(SWASH_LIMIT.half) as F;
      const limitClump = smoothstep(0.35, 0.7, fbm2(positionWorld.xz.div(5.3).add(vec2(11, 0)), 3)).mul(1.4).add(0.3) as F;
      const limitBand = exp(limitOff.mul(limitOff).negate()).mul(limitClump).clamp(0, 1).mul(float(1).sub(submerged)) as F;
      const gritPx = (coordFilter(pP) as V2).x.max((coordFilter(pP) as V2).y) as F;
      const speck = mix(noise(0.04), float(0.5), smoothstep(0.015, 0.04, gritPx)) as F;
      const grit = mix(vec3(0.66, 0.6, 0.55), vec3(0.36, 0.34, 0.32), speck).mul(mix(float(1), float(0.6), damp)) as V3;
      const sandA = mix(sandA0, grit, limitBand.mul(SWASH_LIMIT.strength)) as V3;
      // the swash's moving sheet of water: a film over the sand, darker, mirror-smooth (the game's sand did this in
      // its own albedo, which this hook replaces — the tongues had gone invisible)
      // (the sim's water present: its glaze is 1 only while the water stands on the sand)
      const sheet = mix(smoothstep(0.0003, 0.002, swE.depth), smoothstep(0.97, 1, simMarks.w), simIn) as F;
      // (clear water over sand: the sand under the sheet a little darker still, no tint of its own — the sheet's
      // surface, its mirror and its foam, is shoreline.ts)
      // (and the sand the water has just left, for a few seconds: glazed, darker still — where the backwash strands
      // its foam, on sand it has just wet, not on dry-looking sand: the 2026-10-29 review of beach_600)
      const glazed = mix(swE.fresh, leftMarks.w, simIn).mul(sheet.oneMinus()) as F;
      const filmed = mix(sandA.mul(float(1).sub(glazed.mul(0.22))), wetA.mul(0.85), sheet) as V3;
      // (its foam is the shoreline layer's, on the water's own surface)
      const foamed = filmed;
      // (dry sand is matte: the scan's roughness, ~0.5, made it a satin sheen mirroring the blue sky)
      // (and glossy only where it is saturated: mirror-ish at the line, matte again as it dries)
      const sandR0 = mix(dry.rough.max(0.88), mix(float(0.55), float(0.4), damp.mul(damp)), damp) as F;
      // (the water's mirror is the shoreline layer's: the sand under it is wet sand, not a second mirror — at 0.04 it
      // took the low Sun as a key-light highlight of its own, one compact blob under the sheet)
      // (glazed at 0.12: as glossy as the saturated sand at the line, for the seconds the film takes to sink in; never
      // the mirror the water itself is — at 0.04 the sand under the sheet took the low Sun as one compact highlight)
      // (and under the water no gloss of its own: the water fills the grains, sand to water is no mirror, and the
      // Sun's highlight is the water's surface's — at 0.14 the sand under the swash's thin film took the low Sun as one
      // white slab, the sim6 close clip at 649 s)
      // THE GLAZE'S GLITTER (the 2026-10-30 note: "real wet sand under a low Sun gives a glitter of sparkling points
      // and streaks, plus a broad, dimmer sheen, not a smooth slab"): the film draining off the grains leaves a
      // broad sheen (0.55) with mirror facets in it (0.05), each tilted its own way (±0.2), so only those turned to the
      // Sun light — a point here and there, the rest of the sheen dim (at 0.35 the sheen alone, this grazing, still
      // blew out white: the sheet hidden, the smear stayed — the sand's). Cells ~2.5 px wide, octaves of the footprint as the
      // water's glitter (shoreline.ts), a facet a third of a cell across; the microfacet lobes keep their energy, the
      // facets only gather it. An even glaze (0.12) took the low Sun as one white smear along the line the backwash
      // left (lowsun_649, 2026-10-30)
      const cellSz = float(2).pow(gritPx.mul(2.5).max(0.002).log2().floor()) as F;
      const cellQ = pP.div(cellSz) as V2;
      const cellI = cellQ.floor() as V2;
      const hash = (salt: number): F => {
        const p3 = vec3(cellI.x, cellI.y, cellI.x).mul(vec3(0.1031, 0.103, 0.0973)).add(salt).fract() as V3;
        const p4 = p3.add(p3.dot(vec3(p3.y, p3.z, p3.x).add(33.33))) as V3;
        return p4.x.add(p4.y).mul(p4.z).fract() as F;
      };
      const facetAt = vec2(hash(0.21), hash(0.64)).mul(0.5).add(0.25) as V2;
      // (each cell's film a drop or a thin pool left between the grains, there with the chance the glaze still gives:
      // as the water drains the spots go out one by one — it dries back, not dims)
      const filmLeft = smoothstep(hash(0.47).sub(0.04), hash(0.47).add(0.04), glazed) as F;
      const facet = smoothstep(0.42, 0.18, cellQ.sub(cellI).sub(facetAt).length()).mul(filmLeft) as F;
      const facetTilt = vec2(hash(0.37), hash(0.83)).sub(0.5).mul(0.3) as V2;
      // (saturated sand 0.4 and the glaze between its drops 0.65, swept on the farm against 0.14/0.55: at 0.14 the
      // drained strip took the low Sun as one smooth smear, the sim7 clip at 649 and 657 s; now a grainy glint)
      const glazeR = mix(float(0.65), float(0.05), facet) as F;
      const sandR = mix(mix(sandR0, glazeR, glazed.max(facet)), float(0.7), sheet) as F;
      const sandN = mix(dryN, dryN.mul(0.6).add(wet.n.mul(0.1)), damp).mul(sheet.oneMinus()).add(facetTilt.mul(facet)) as V2;
      const sandAO = mix(mix(rel.ao, float(1), 0.5), wet.ao, damp) as F;
      // the cover: dry grass with patches of leaf-litter soil, the litter's autumn colours dulled toward the soil
      const patch = smoothstep(0.35, 0.7, noise(11)) as F;
      const litter = mix(vec3(leaves.albedo.dot(vec3(0.2126, 0.7152, 0.0722))).mul(vec3(1.05, 0.98, 0.88)), leaves.albedo, 0.25) as V3;
      const coverA = mix(grass.albedo.mul(2.2), litter, patch) as V3;
      const coverR = mix(grass.rough, leaves.rough, patch) as F;
      const coverN = mix(grass.n, leaves.n, patch) as V2;
      const coverAO = mix(grass.ao, leaves.ao, patch) as F;

      // the litter: the forest floor's dead leaves, sand showing through them, kept off the wet sand
      const litterNode = texture(litterTex, positionWorld.xz.sub(litterAt).mul(litterInv));
      litterNodes.push(litterNode as unknown as { value: THREE.Texture });
      const lit = litterNode.r.mul(smoothstep(0.35, 0.9, rise)) as F;
      // (dead leaves, brown and darker than the sand, the sand only showing through a little)
      // (the scan's leaves are a temperate autumn's, reddish: taken toward their own luminance in a dry brown)
      const leafLum = leaves.albedo.dot(vec3(0.2126, 0.7152, 0.0722)) as F;
      const litterA = mix(mix(vec3(leafLum).mul(vec3(1.0, 0.78, 0.52)), leaves.albedo, 0.25), dryA, 0.15).mul(0.9) as V3;
      // THE WRACK LINE on the sand (beachDressing.ts WRACK; the user, 2026-10-29: "some pebbles on the beach could
      // be a thing"): where the highest tides leave dried seagrass and leaves, a band round 1 m over the sea that
      // wanders along the beach, broken into clumps — the line beachDressing.ts lays its leaves, twigs and sticks
      // on, carried on here out to where they are too small to draw (the same noise at the same coordinates as its
      // CPU twin, wrackAt). The forest floor's leaves, already sampled, taken to the wrack's dry brown (~0.15
      // linear, darker than the litter), lying only where the scan has a leaf (its brighter half), the sand showing
      // between them: a band of the scan's whole tone read as a stain, lavender under the evening sky. (Its distance
      // from the band's middle squared by hand: WGSL's pow of a negative base is undefined.)
      const wrackOff = positionWorld.y.sub(fbm2(positionWorld.xz.div(WRACK.wanderScale).add(vec2(7.3, 0)), 2).sub(0.5).mul(2 * WRACK.wander).add(WRACK.height)).div(WRACK.half);
      const wrackClump = smoothstep(WRACK.clump[0], WRACK.clump[1], fbm2(positionWorld.xz.div(WRACK.clumpScale).add(vec2(1.9, 0)), 3));
      const wrack = exp(wrackOff.mul(wrackOff).negate()).mul(wrackClump).mul(smoothstep(0.18, 0.3, leafLum)).mul(0.9) as F;
      const sandW = mix(foamed, vec3(leafLum).mul(vec3(0.9, 0.62, 0.4)), wrack) as V3;
      const groundA = mix(mix(coverA, sandW, shoreW), litterA, lit) as V3;
      const groundR = mix(mix(coverR, mix(sandR, leaves.rough, wrack), shoreW), leaves.rough, lit) as F;
      const groundN2 = mix(mix(coverN, mix(sandN, leaves.n.mul(0.5), wrack), shoreW), leaves.n, lit) as V2;
      const groundAO = mix(mix(coverAO, mix(sandAO, leaves.ao, wrack), shoreW), leaves.ao, lit) as F;
      // the flat layers' tangent normal about the geometric one (u along +x, v along −z)
      const T = vec3(1, 0, 0).sub(N.mul(N.x)).normalize();
      const Bv = N.cross(T);
      const groundN = T.mul(groundN2.x).add(Bv.mul(groundN2.y)).add(N.mul(float(1).sub(groundN2.dot(groundN2)).max(0).sqrt())).normalize() as V3;

      // the rock, triplanar (steep ground): the planes' tangent normals onto the world, whiteout-blended about
      // the geometric normal
      const [tw] = LAYERS.rock;
      const p = pL.div(tw);
      const bw = abs(N).pow(4);
      const wsum = bw.x.add(bw.y).add(bw.z);
      const wx = bw.x.div(wsum);
      const wy = bw.y.div(wsum);
      const wz = bw.z.div(wsum);
      const ax = texture(maps.rock.a, p.zy) as V4;
      const ay = texture(maps.rock.a, p.xz) as V4;
      const az = texture(maps.rock.a, p.xy) as V4;
      const bx = texture(maps.rock.b, p.zy) as V4;
      const by = texture(maps.rock.b, p.xz) as V4;
      const bz = texture(maps.rock.b, p.xy) as V4;
      const rockA4 = ax.mul(wx).add(ay.mul(wy)).add(az.mul(wz)) as V4;
      const tx = bx.xy.mul(2).sub(1);
      const ty = by.xy.mul(2).sub(1);
      const tz = bz.xy.mul(2).sub(1);
      const rockN = vec3(0, tx.y, tx.x).mul(wx).add(vec3(ty.x, 0, ty.y).mul(wy)).add(vec3(tz.x, tz.y, 0).mul(wz)).add(N).normalize() as V3;
      const rockAO = bx.z.mul(wx).add(by.z.mul(wy)).add(bz.z.mul(wz)) as F;

      // THE CONTACT SHADE's colour (the 2026-11-01 note: in sunlight too — the ground at a plant's foot is darker
      // itself, its litter, damper soil and root shade): the same patch takes the ground a touch darker and browner,
      // ~15–20% in luminance at its core (green 0.4–0.55, forest.ts contactMask; a Pachira's half-metre patch on the
      // half-metre texels comes out nearer 0.3: at 0.26–0.36 a channel it showed 1–3% at 604 and 645 s), blue a little
      // more than red
      const footA = vec3(1).sub(vec3(0.34, 0.38, 0.46).mul(litterNode.g)) as V3;
      const albedo = mix(linear(rockA4.rgb as V3).mul(rockAO), groundA.mul(groundAO).mul(footA), groundW);
      const roughness = mix(rockA4.a, groundR, groundW);
      const nWorld = mix(rockN, groundN, groundW).normalize();
      const normal = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
      // (no painted glitter on scanned sand)
      // (the contact shade is the sky hidden too: the indirect light's, the Sun's direct light untouched)
      return { albedo, roughness, normal, emissiveGate: float(0), ao: skyOcclusion.mul(litterNode.g.oneMinus()) };
    },
  };
  return {
    hooks,
    ready: Promise.all(loads).then(() => undefined),
    setLitter(mask, origin, size, contact) {
      if (mask.length !== LITTER_RES * LITTER_RES) throw new Error(`beach: litter mask of ${mask.length}, not ${LITTER_RES}²`);
      if (contact && contact.length !== mask.length) throw new Error(`beach: contact mask of ${contact.length}, not ${LITTER_RES}²`);
      const half = new Uint16Array(mask.length * 2);
      for (let i = 0; i < mask.length; i++) {
        half[i * 2] = THREE.DataUtils.toHalfFloat(mask[i] / 255);
        half[i * 2 + 1] = THREE.DataUtils.toHalfFloat((contact?.[i] ?? 0) / 255);
      }
      const was = litterTex;
      litterTex = litterOf(half);
      for (const node of litterNodes) node.value = litterTex;
      was.dispose();
      litterAt.value.set(origin[0], origin[1]);
      litterInv.value = 1 / size;
    },
    setOccluders(list) {
      if (list.length > MAX_OCCLUDERS) throw new Error(`beach: ${list.length} occluders, at most ${MAX_OCCLUDERS}`);
      occData.forEach((v, i) => (i < list.length ? v.set(...list[i]) : v.set(0, 0, 1, 0)));
    },
  };
}
