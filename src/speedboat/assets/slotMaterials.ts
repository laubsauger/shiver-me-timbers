/**
 * glTF material slot → TSL node material (docs/speedboat/asset-pipeline-research.md §5.4, §6.3).
 *
 * GLTFLoader hands back MeshStandard/PhysicalMaterials: drawable under WebGPURenderer, but blind
 * to the sea — no caustics, bounce, wetness or absorption. So each slot is REBUILT here from the
 * loaded textures and factors, with the shared `waterLighting()` hook folded in exactly the way
 * `ship/fittingMaterials.ts` does it (tint × albedo, addLight → emissive, roughness × wet scale).
 *
 * Budgets this keeps (§V40): a textured slot samples at most three filterable textures of its
 * own (baseColor, normal, ORM — occlusion/roughness/metal are ONE texture, sampled once), which
 * leaves the receiver stage room for waterLighting's ocean, caustic, wetline and shadow reads.
 *
 * Livery: hues are OBJECT-scoped uniforms read from `userData.boatLivery` / `liveryTint` (livery.ts; the
 * `sailTint` mechanism, ship/sailDriver.ts), so eight boats share one material, one pipeline and one
 * texture set and still wear eight colours. Hero hull M_Gelcoat: paint from the hull mask fields, overlays
 * from baseColor alpha, the race number from the mask's glyph strip (4 textures). M_NonSlip: a tiling
 * non-skid detail normal (4 textures). M_Carbon: baseColor alpha = cowl livery mask, dominant hue.
 *
 * Materials are built at construction (TSL bakes the graph), so `setActiveCaustics` and any
 * `attachHullWetline` must already have happened — `waterLighting()` warns if not.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  dFdx,
  dFdy,
  float,
  fwidth,
  int,
  luminance,
  min,
  mix,
  normalize,
  normalLocal,
  normalMap,
  normalView,
  normalWorld,
  normalWorldGeometry,
  objectGroup,
  positionLocal,
  positionView,
  positionViewDirection,
  positionWorld,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  uniformArray,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { waterLighting } from '../../caustics';
import type { TslNode } from '../../caustics/causticsNode';
import type { SlotName } from './contract';
import { HERO_LIVERY, ledColor, numberGlyphs, resolveLivery } from './livery';
import { boatLightParams } from '../../params/boatLights';

export type BoatVariant = 'hero' | 'npc';

export interface SlotMaterialOptions {
  /** materials are keyed per variant (the hero/npc split of doc §5.4); since §T.192 both blend the perspex the same way */
  variant: BoatVariant;
  /** fold in waterLighting(); false for a studio lookdev with no sea bound */
  water: boolean;
  /** the deck's outline for the painted deck livery on M_NonSlip (boatModel measures it off Hull_LOD0) */
  deckEdge?: DeckEdge;
}

/** plan outline of the deck: the widest hull half-beam near deck height per z bin, body frame */
export interface DeckEdge {
  z0: number;
  dz: number;
  half: number[];
  sternZ: number;
  deckY: number;
}

/**
 * §T.192 DECK LIVERY (USER: "some kind of usage of the respective player colour … on the top of the boat… some orange
 * band, resp. whatever player colour we got, and then a band of white and then the rubber decking anti-slip"). Painted
 * in plan-view distance from the deck edge (the hull's own outline, a 64-entry uniform array — no texture, §V40), so
 * every livery drives it and it runs round the transom edge and closes to a point at the bow:
 *   0 … DECK_BAND_M      the boat's dominant colour (the first 35 mm is the rounded sheer edge)
 *   … + DECK_STRIPE_M    bone-white pinstripe band
 *   beyond               the moulded rubber non-skid field (baked albedo + the tiling detail normal)
 * Edges anti-aliased with fwidth; paint is smooth (the non-skid relief is lifted off it) and satin (roughness 0.38),
 * shaded by the baked AO so hardware bases and the hatch gap stay grounded. Only up-facing deck-height texels: the
 * well walls, sole and lip keep their non-skid.
 */
export const DECK_BAND_M = 0.17;
export const DECK_STRIPE_M = 0.05;
const DECK_WHITE = 0xe9e5da;

/**
 * §T.209 BOAT LEDs (USER: "cool LED lighting … in the respective player color"). Two emissive strips per boat, in the
 * livery's `ledColor` (livery.ts): an UNDERGLOW strip on each topside just above the boot line (the antifoul field of
 * the hull mask, metric: B = 0.5 + signed distance / HULL_BOOT_SCALE, hull_textures.py), and a deck COURTESY strip on
 * the seam between the white deck band and the non-skid. ONE scene-wide level (`setBoatLedLevel`; page/boatLights.ts
 * drives it from `sky.nightFactor` or a cine override): at 0 both strips add exactly 0. No texture, no sampler (§V40).
 */
const HULL_BOOT_SCALE = 0.16;
const ledLevel = uniform(0);
const ledHullNits = uniform(boatLightParams.stripNits);
const ledDeckNits = uniform(boatLightParams.deckStripNits);
const ledSubmergedNits = uniform(boatLightParams.submergedStripNits);
const ledHullWidth = uniform(boatLightParams.hullStripWidth);
const ledDeckWidth = uniform(boatLightParams.deckStripWidth);
const ledPilotFill = uniform(boatLightParams.pilotLedFill);
/** the pilot LED fill's level (`pilotFillLevel`): the LED level, lifted through twilight */
const ledPilotLevel = uniform(0);
/**
 * TWILIGHT. `sky.nightFactor` is linear-ish from +1.7° to −12°, so at dusk (the trailer's −4°: 0.38) every night fill
 * term was a third of night's, in the one hour whose light rig is darkest: the sun's key and daylight ambient are gone
 * and the moon's handover has not begun (moonCycle.ts `ambientLevel` sits on its night floor). The pilot in 10 dusk was
 * a black silhouette against a bright twilight sky (final look review). The fill terms ride this ramp instead: the same
 * clock, exactly 0 wherever the night factor is (sunset at +3° included), full by n = TWILIGHT_FILL_FULL (≈ −6.5°).
 */
export const TWILIGHT_FILL_FULL = 0.6;
export function twilightFillRamp(nightFactor: number): number {
  const n = Number.isFinite(nightFactor) ? Math.min(1, Math.max(0, nightFactor / TWILIGHT_FILL_FULL)) : 0;
  return n * n * (3 - 2 * n);
}
/** the pilot's LED fill level: 0 with the LEDs off, else the LED level lifted to the twilight ramp (never below it) */
export function pilotFillLevel(ledLevel: number, nightFactor: number): number {
  const l = Number.isFinite(ledLevel) ? Math.min(1, Math.max(0, ledLevel)) : 0;
  return l > 0 ? Math.max(l, twilightFillRamp(nightFactor)) : 0;
}
let lastNightFactor = 0;
export function setBoatLedLevel(level: number, p = boatLightParams): void {
  ledLevel.value = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  ledPilotLevel.value = pilotFillLevel(ledLevel.value as number, lastNightFactor);
  ledPilotFill.value = p.pilotLedFill;
  ledHullNits.value = p.stripNits;
  ledDeckNits.value = p.deckStripNits;
  ledSubmergedNits.value = p.submergedStripNits;
  ledHullWidth.value = p.hullStripWidth;
  ledDeckWidth.value = p.deckStripWidth;
}
/**
 * §T.209 NIGHT FILL. Under a half moon the key is ~4% of noon and the hemisphere ambient is a dark navy, so the hulls
 * rendered as pure black silhouettes (nothing zeroes them: that is the physically-lit level). A small moonlight term
 * keeps the hull SHAPE readable: a Fresnel rim biased toward the key (moon) direction plus a little sky fill on the
 * albedo, both in the moon's hue × `twilightFillRamp(sky.nightFactor)` × `boatLightParams.nightRim / nightFill`. Exactly 0
 * by day.
 */
const nightFill = uniform(new THREE.Color(0, 0, 0));
const nightRim = uniform(new THREE.Color(0, 0, 0));
const nightKeyDir = uniform(new THREE.Vector3(0, 1, 0));
export function setBoatNightFill(moonLinear: THREE.Color, nightFactor: number, keyDir: THREE.Vector3, p = boatLightParams): void {
  lastNightFactor = Number.isFinite(nightFactor) ? Math.min(1, Math.max(0, nightFactor)) : 0;
  ledPilotLevel.value = pilotFillLevel(ledLevel.value as number, lastNightFactor);
  const n = twilightFillRamp(lastNightFactor);
  (nightFill.value as THREE.Color).copy(moonLinear).multiplyScalar(n * p.nightFill);
  (nightRim.value as THREE.Color).copy(moonLinear).multiplyScalar(n * p.nightRim);
  (nightKeyDir.value as THREE.Vector3).copy(keyDir).normalize();
}
export function boatLedLevel(): number {
  return ledLevel.value as number;
}
/** the pilots' live LED fill level (see `pilotFillLevel`) */
export function boatPilotFillLevel(): number {
  return ledPilotLevel.value as number;
}
/** the night fill's live moon terms (linear radiance): black by day */
export function boatNightFillLevels(): { fill: THREE.Color; rim: THREE.Color } {
  return { fill: nightFill.value as THREE.Color, rim: nightRim.value as THREE.Color };
}
/** the night fill as an emissive term over `albedo`: the rim toward the moon + a little sky (hulls and pilots) */
export function nightFillNode(albedo: TslNode): TslNode {
  const facing = normalView.dot(positionViewDirection).abs().clamp(0, 1);
  const toward = normalWorldGeometry.dot(nightKeyDir).mul(0.5).add(0.5);
  const rim = facing.oneMinus().pow(3).mul(toward.mul(0.7).add(0.3));
  return nightRim.mul(rim).add(nightFill.mul(albedo));
}
/**
 * §T.209 the pilot's LED fill: the boat's strips, pool and arch light bouncing up off the deck and the water onto him,
 * in `hue` (his boat's LED colour, linear) × `albedo` × `pilotFillLevel` × `boatLightParams.pilotLedFill`. A hemisphere
 * weight, not a light: 1 on down-facing normals, 0.65 on his front and sides, 0.3 on top. 0 when the LEDs are off.
 */
export function pilotLedFillNode(albedo: TslNode, hue: TslNode): TslNode {
  const below = normalWorld.y.mul(-0.35).add(0.65);
  return hue.mul(albedo).mul(below).mul(ledPilotLevel).mul(ledPilotFill);
}
/** 1 inside a strip of full width `width` centred on `d = centre` (anti-aliased with the footprint of d) */
const ledStrip = (d: TslNode, centre: TslNode, width: TslNode): TslNode => {
  const aw = fwidth(d).max(1e-4);
  const half = width.mul(0.5);
  // @band-limited-elsewhere: `aw` IS fwidth(d) one line up — the strip edge is filtered on its own footprint
  return smoothstep(half.sub(aw), half.add(aw), d.sub(centre).abs()).oneMinus();
};

type SourceMaterial = THREE.MeshStandardMaterial & Partial<THREE.MeshPhysicalMaterial>;

/** `userData.liveryTint` on the drawn object (or any ancestor up to the boat root) */
function liveryOf(object: THREE.Object3D | null): number | undefined {
  for (let o = object; o !== null; o = o.parent) {
    const hex = o.userData.liveryTint;
    if (typeof hex === 'number' && Number.isFinite(hex)) return hex;
    if (o.userData.boatRoot === true) break;
  }
  return undefined;
}

/** the userData that carries the livery: the nearest ancestor with `boatLivery`/`liveryTint`, or the boat root */
function liveryOwner(object: THREE.Object3D | null): Record<string, unknown> | undefined {
  for (let o = object; o !== null; o = o.parent) {
    if (o.userData.boatLivery !== undefined || o.userData.liveryTint !== undefined || o.userData.boatRoot === true) return o.userData;
  }
  return undefined;
}

/** material extras the hero hull build writes (scripts/blender/hull/hull_textures.py) */
interface HullLiveryExtras {
  overspray: [number, number, number];
  numeralWear: [number, number];
  numberField: { zCentre: number; yCentre: number; height: number; digitWidth: number; gap: number };
  deckNumberField?: { zCentre: number; xCentre: number; height: number; digitWidth: number; gap: number };
  glyphAtlas: { u0: number; v0: number; cellW: number; cellH: number };
}
interface NonSkidExtras {
  atlasMetres: number;
  tileMetres: number;
  fade: [number, number];
}

/** anti-aliased threshold of a signed-distance field at 0.5 (edges stay crisp at any texture resolution) */
const aaStep = (v: TslNode): TslNode => {
  const w = fwidth(v).max(1e-4).mul(0.75);
  return smoothstep(float(0.5).sub(w), float(0.5).add(w), v);
};

/**
 * M_Gelcoat on the hero hull (STYLE-SPEC §4): paint from the mask fields (R band, G pinstripe, B antifoul),
 * overlays (chips, filler, salt, plates…) from baseColor alpha, the race number from the glyph strip in the
 * mask, all hues per object. Mirrors `preview_albedo` in hull_textures.py, which the CPU renders use.
 */
function hullLiveryAlbedo(maskMap: THREE.Texture, map: TslNode, baseFactor: TslNode, ex: HullLiveryExtras): { albedo: TslNode; boot: TslNode; overlay: TslNode; bootField: TslNode; led: TslNode } {
  const hue = (hex: number) => uniform(new THREE.Color(hex)).setGroup(objectGroup);
  const topsides = hue(HERO_LIVERY.topsides);
  const band = hue(HERO_LIVERY.band);
  const stripe = hue(HERO_LIVERY.stripe);
  const antifoul = hue(HERO_LIVERY.antifoul);
  const numeral = hue(HERO_LIVERY.numeral);
  const digitA = uniform(2).setGroup(objectGroup);
  const digitB = uniform(7).setGroup(objectGroup);
  const digitCount = uniform(2).setGroup(objectGroup);
  const led = hue(ledColor(HERO_LIVERY));
  topsides.onObjectUpdate((frame) => {
    const l = resolveLivery(liveryOwner(frame.object));
    (led.value as THREE.Color).set(ledColor(l));
    (topsides.value as THREE.Color).set(l.topsides);
    (band.value as THREE.Color).set(l.band);
    (stripe.value as THREE.Color).set(l.stripe);
    (antifoul.value as THREE.Color).set(l.antifoul);
    (numeral.value as THREE.Color).set(l.numeral);
    const g = numberGlyphs(l.number);
    digitA.value = g[0];
    digitB.value = g[g.length - 1];
    digitCount.value = g.length;
  });

  const m = texture(maskMap);
  const inBand = aaStep(m.r);
  const inStripe = aaStep(m.g);
  const boot = aaStep(m.b);
  const [o0, o1, oAmt] = ex.overspray;
  const over = smoothstep(o0, o1, m.r).mul(inBand.oneMinus()).mul(oAmt);
  let paint: TslNode = mix(topsides, band, inBand.max(over));
  paint = mix(paint, stripe, inStripe);
  paint = mix(paint, antifoul, boot);
  const overlay = map.a;
  let albedo: TslNode = mix(paint, map.rgb.mul(baseFactor), overlay);

  // race numbers: a planar field on each topside, read left→right from outside (bow to the right on starboard), and
  // a larger one on the foredeck panel, glyph up = bow, read from aft/above. Both use one glyph sample (V23: no branches)
  const ga = ex.glyphAtlas;
  const p = positionLocal;
  const numberCoords = (nf: { height: number; digitWidth: number; gap: number }, along: TslNode, up: TslNode) => {
    const fieldW = digitCount.mul(nf.digitWidth).add(digitCount.sub(1).mul(nf.gap));
    const gx = along.div(fieldW).add(0.5);
    const gy = up.div(nf.height).add(0.5);
    const gxm = gx.mul(fieldW);
    const cx0 = gxm.div(nf.digitWidth);
    const second = digitCount.greaterThan(1.5).and(gxm.greaterThan(nf.digitWidth + nf.gap / 2));
    const cx = select(second, gxm.sub(nf.digitWidth + nf.gap).div(nf.digitWidth), cx0);
    const inField = step(0, gx).mul(step(gx, 1)).mul(step(0, gy)).mul(step(gy, 1)).mul(step(0, cx)).mul(step(cx, 1));
    return { gy, cx, cx0, second, inField };
  };
  const sideNf = ex.numberField;
  const side = step(0, p.x).mul(2).sub(1);
  const S = numberCoords(sideNf, side.negate().mul(p.z.sub(sideNf.zCentre)), p.y.sub(sideNf.yCentre));
  let gy: TslNode = S.gy;
  let cx: TslNode = S.cx;
  let cx0: TslNode = S.cx0;
  let second: TslNode = S.second;
  let inField: TslNode = S.inField.mul(step(0.5, normalLocal.x.abs()));
  if (ex.deckNumberField) {
    const dn = ex.deckNumberField;
    const Dk = numberCoords(dn, p.x.negate().sub(dn.xCentre), p.z.sub(dn.zCentre));
    const onDeck = step(0.7, normalLocal.y);
    const deck = onDeck.greaterThan(0.5);
    gy = select(deck, Dk.gy, gy);
    cx = select(deck, Dk.cx, cx);
    cx0 = select(deck, Dk.cx0, cx0);
    second = select(deck, Dk.second, second);
    inField = mix(inField, Dk.inField, onDeck);
  }
  const digit = select(second, digitB, digitA);
  const guv = vec2(float(ga.u0).add(digit.add(cx.clamp(0, 1)).mul(ga.cellW)), float(ga.v0).add(gy.clamp(0, 1).oneMinus().mul(ga.cellH)));
  // gradients of the CONTINUOUS coordinates: no mip seam where the cell switches between the digits (V48 band-limit)
  const gradX = vec2(dFdx(cx0).mul(ga.cellW), dFdx(gy).negate().mul(ga.cellH));
  const gradY = vec2(dFdy(cx0).mul(ga.cellW), dFdy(gy).negate().mul(ga.cellH));
  const glyph = aaStep(texture(maskMap, guv).grad(gradX, gradY).r);
  const wear = smoothstep(ex.numeralWear[0], ex.numeralWear[1], m.a).oneMinus();
  const paintNum = glyph.mul(inField).mul(wear).mul(boot.oneMinus()).mul(0.97);
  albedo = mix(albedo, numeral, paintNum);
  return { albedo, boot, overlay, bootField: m.b, led };
}

/**
 * §T.192 COCKPIT TOO DARK (USER: "cockpit a bit dark in general, so drowning stuff out a bit"). Two measured causes:
 *  1. NO SPECULAR AMBIENT. The scene has a HemisphereLight and no environment, and a hemisphere light is diffuse-only:
 *     a metal (M_Metal ORM metalness median 0.77 — rails, bezels, wheel, bracket, rams) has no diffuse, so everything
 *     metal out of the sun rendered near black, and the carbon clearcoat had nothing to reflect.
 *     Fix: a procedural SKY ENVIRONMENT for the boat slots, the scene's own hemisphere read back each render as
 *     radiance (ground → sky over the reflected direction's height). L = C·intensity/π is exactly the radiance whose
 *     irradiance the hemisphere light already applies (E = πL), so reflections are as bright as the ambient they
 *     belong to, and they follow the time of day. The IRRADIANCE lookup returns 0: the hemisphere light keeps the
 *     diffuse, nothing is counted twice. No texture, no sampler (§V40).
 *  2. CRUSHED AO. The parts' Cycles AO (0.6 m rays) inside a 0.75 m deep well: M_Cockpit AO median 0.21, a quarter of
 *     its texels 0 (M_Carbon a quarter < 0.06), so the ambient that does reach the cockpit was multiplied by ~0.2.
 *     Fix: parts slots remap AO onto [AO_FLOOR_PARTS, 1] — contact shadows and cavities keep their ORDER and shape, the
 *     well stops being a black pit. The hull's own AO (median 0.92) is untouched.
 * Hemisphere lookup is cached per scene.
 */
export const AO_FLOOR_PARTS = 0.35;
const PARTS_SLOTS: readonly SlotName[] = ['M_Carbon', 'M_Metal', 'M_Cockpit', 'M_Perspex'];
const hemiOfScene = new WeakMap<object, THREE.HemisphereLight | null>();
let skyEnvNode: TslNode | null = null;
function skyEnvironment(): TslNode {
  if (skyEnvNode) return skyEnvNode;
  const sky = uniform(new THREE.Color(0.25, 0.28, 0.32));
  const ground = uniform(new THREE.Color(0.1, 0.1, 0.1));
  sky.onRenderUpdate(({ scene }) => {
    if (!scene) return;
    let hemi = hemiOfScene.get(scene);
    if (hemi === undefined || (hemi && !hemi.parent)) {
      hemi = null;
      scene.traverse((o) => {
        if (!hemi && (o as THREE.HemisphereLight).isHemisphereLight) hemi = o as THREE.HemisphereLight;
      });
      hemiOfScene.set(scene, hemi);
    }
    if (!hemi) return;
    const k = Number.isFinite(hemi.intensity) ? Math.max(0, hemi.intensity) / Math.PI : 0;
    (sky.value as THREE.Color).copy(hemi.color).multiplyScalar(k);
    (ground.value as THREE.Color).copy(hemi.groundColor).multiplyScalar(k);
  });
  // a zero-parameter Fn receives the node builder (TSLCore: `jsFunc(builder)`), whose context is EnvironmentNode's
  const envFn = Fn((builder: { context: { getUV?: () => TslNode } }) => {
    const dir = builder.context.getUV?.();
    // irradiance context (EnvironmentNode asks with normalWorld): the HemisphereLight already lights the diffuse
    if (!dir || dir === normalWorld) return vec3(0);
    return mix(ground, sky, smoothstep(-0.2, 0.35, (dir as TslNode).y));
  }) as unknown as () => TslNode;
  skyEnvNode = envFn();
  return skyEnvNode;
}

export function createSlotMaterial(slot: SlotName, source: THREE.Material, opts: SlotMaterialOptions): THREE.MeshPhysicalNodeMaterial {
  const s = source as SourceMaterial;
  const m = new THREE.MeshPhysicalNodeMaterial();
  m.name = `${slot}:${opts.variant}`;
  m.side = s.side ?? THREE.FrontSide;

  const baseFactor = uniform(s.color ? s.color.clone() : new THREE.Color(1, 1, 1));
  const map = s.map ? texture(s.map) : null;
  let albedo: TslNode = map ? map.rgb.mul(baseFactor) : baseFactor;

  const extras = (s.userData ?? {}) as { hullLivery?: HullLiveryExtras; nonSkid?: NonSkidExtras };
  const heroHull = slot === 'M_Gelcoat' && map !== null && s.clearcoatMap && extras.hullLivery ? hullLiveryAlbedo(s.clearcoatMap, map, baseFactor, extras.hullLivery) : null;
  if (heroHull) {
    albedo = heroHull.albedo;
  } else if (slot === 'M_Gelcoat' || slot === 'M_Carbon') {
    // baseColor alpha = livery mask (pipeline-test gelcoat band, hero cowl tops): the livery hue keeps the baked
    // shading by the luminance ratio against the baked hero orange, so chips and wear survive a recolour
    const livery = uniform(new THREE.Color(1, 1, 1)).setGroup(objectGroup);
    const liveryOn = uniform(0).setGroup(objectGroup);
    livery.onObjectUpdate((frame) => {
      const owner = liveryOwner(frame.object);
      const hex = owner && (owner.boatLivery !== undefined || owner.liveryTint !== undefined) ? resolveLivery(owner).dominant : liveryOf(frame.object);
      liveryOn.value = hex === undefined ? 0 : 1;
      if (hex !== undefined) (livery.value as THREE.Color).set(hex);
    });
    const mask = map ? map.a : float(0);
    const heroLum = luminance(uniform(new THREE.Color(HERO_LIVERY.band)));
    const shaded = slot === 'M_Carbon' ? livery.mul(luminance(albedo).div(heroLum).clamp(0, 1.6)) : livery;
    albedo = mix(albedo, shaded, mask.mul(liveryOn));
  }

  // ORM: one texture, one sampler, three channels
  const ormTex = s.aoMap ?? s.roughnessMap ?? s.metalnessMap ?? null;
  const orm = ormTex ? texture(ormTex) : null;
  const rough = orm ? orm.g.mul(s.roughness ?? 1) : float(s.roughness ?? 0.5);
  const metal = orm ? orm.b.mul(s.metalness ?? 1) : float(s.metalness ?? 0);
  if (orm) {
    const ao = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));
    m.aoNode = PARTS_SLOTS.includes(slot) ? mix(float(AO_FLOOR_PARTS), float(1), ao) : ao;
  }
  // specular ambient from the sky the hemisphere light describes (header, cause 1)
  m.envNode = skyEnvironment();

  const w = opts.water
    ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, shipLocalPos: positionLocal, mode: 'both' })
    : null;

  let deckPaint: TslNode | null = null;
  let ledEmissive: TslNode | null = null;
  if (heroHull) {
    // metres below the boot line (+) / above it (−); the strip sits just above it, on the sides only
    const sd = heroHull.bootField.sub(0.5).mul(HULL_BOOT_SCALE);
    // @band-limited-elsewhere: a broad ramp over the hull's NORMAL (transom vs sides), not a spatial edge
    const sides = smoothstep(0.2, 0.45, normalLocal.x.abs());
    const strip = ledStrip(sd, ledHullWidth.mul(-0.5).sub(0.008), ledHullWidth).mul(sides);
    // A second continuous line on the actual hull, 45 mm below its boot line.
    // Stay inside the mask's ±80 mm signed-distance range; the saturated
    // antifoul field must not turn the whole bottom into an emissive surface.
    // Actual immersion follows hull motion and the existing water depth pass.
    const submerged = ledStrip(sd, float(0.045), float(0.02)).mul(sides);
    ledEmissive = heroHull.led.mul(
      strip.mul(ledHullNits).add(submerged.mul(ledSubmergedNits)).mul(ledLevel),
    );
  }
  let roughOut: TslNode = rough;
  if (slot === 'M_NonSlip' && opts.deckEdge && opts.deckEdge.half.length >= 2) {
    const de = opts.deckEdge;
    const hue = uniform(new THREE.Color(HERO_LIVERY.dominant)).setGroup(objectGroup);
    const led = uniform(new THREE.Color(ledColor(HERO_LIVERY))).setGroup(objectGroup);
    hue.onObjectUpdate((frame) => {
      const l = resolveLivery(liveryOwner(frame.object));
      (hue.value as THREE.Color).set(l.dominant);
      (led.value as THREE.Color).set(ledColor(l));
    });
    const halfArr = uniformArray<'float'>(de.half, 'float');
    const p = positionLocal;
    const fi = p.z.sub(de.z0).div(Math.max(de.dz, 1e-4)).clamp(0, de.half.length - 1.001);
    const i0 = int(fi.floor());
    const halfAt = mix(halfArr.element(i0), halfArr.element(i0.add(1)), fi.fract());
    const d = min(halfAt.sub(p.x.abs()), p.z.sub(de.sternZ));
    const aw = fwidth(d).max(1e-4);
    const inside = (edge: number): TslNode => smoothstep(float(edge).sub(aw), float(edge).add(aw), d); // 1 beyond the edge
    const onTop = smoothstep(0.55, 0.8, normalLocal.y).mul(step(de.deckY - 0.3, p.y));
    const band = inside(DECK_BAND_M).oneMinus().mul(onTop);
    const white = inside(DECK_BAND_M).mul(inside(DECK_BAND_M + DECK_STRIPE_M).oneMinus()).mul(onTop);
    const shade = orm ? mix(float(0.78), float(1), orm.r) : float(1);
    albedo = mix(mix(albedo, uniform(new THREE.Color(DECK_WHITE)).mul(shade), white), hue.mul(shade), band);
    deckPaint = band.add(white).clamp(0, 1);
    // §T.209 courtesy strip on the white band / non-skid seam
    ledEmissive = led.mul(ledStrip(d, float(DECK_BAND_M + DECK_STRIPE_M), ledDeckWidth).mul(onTop).mul(ledLevel).mul(ledDeckNits));
    roughOut = mix(rough, float(0.38), deckPaint);
  }

  m.colorNode = w ? albedo.mul(w.tint) : albedo;
  if (slot !== 'M_Perspex') {
    // §T.209 night fill (see setBoatNightFill): rim toward the moon + a little sky on the albedo
    const fill = nightFillNode(albedo);
    ledEmissive = ledEmissive ? ledEmissive.add(fill) : fill;
  }
  m.roughnessNode = (w ? roughOut.mul(w.roughnessScale) : roughOut).clamp(0.02, 1);
  m.metalnessNode = metal;
  if (w) m.emissiveNode = ledEmissive ? w.addLight.add(ledEmissive) : w.addLight;
  else if (ledEmissive) m.emissiveNode = ledEmissive;
  if (s.normalMap) {
    const scale = vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1);
    const ns = extras.nonSkid;
    if (slot === 'M_NonSlip' && ns && s.clearcoatNormalMap && map !== null) {
      // moulded non-skid: tiling detail at its metric scale, whiteout-blended where baseColor alpha says
      // non-skid, faded out with distance so it band-limits (§V48)
      const det = texture(s.clearcoatNormalMap, uv().mul(ns.atlasMetres / ns.tileMetres)).xyz.mul(2).sub(1);
      const base = texture(s.normalMap).xyz.mul(2).sub(1);
      const k = map.a.mul(smoothstep(ns.fade[0], ns.fade[1], positionView.length()).oneMinus()).mul(deckPaint ? deckPaint.oneMinus() : float(1));
      // `k` is a float at runtime; @types/three 0.186 resolves `.mul(any)` to vec3, so the xy sum is retyped loosely
      const blended = normalize(vec3(base.xy.add(det.xy.mul(k)) as TslNode, base.z));
      m.normalNode = normalMap(blended.mul(0.5).add(0.5), w ? scale.mul(w.reliefScale) : scale);
    } else {
      m.normalNode = normalMap(texture(s.normalMap), w ? scale.mul(w.reliefScale) : scale);
    }
  }

  switch (slot) {
    case 'M_Gelcoat':
      if (heroHull) {
        // gloss follows the paint: none on antifoul, overlays (chips, filler, crust) and chalky texels
        m.clearcoatNode = heroHull.boot.oneMinus().mul(heroHull.overlay.mul(0.9).oneMinus()).mul(smoothstep(0.25, 0.62, rough).oneMinus());
        m.clearcoatRoughness = 0.1;
        break;
      }
      m.clearcoat = s.clearcoat && s.clearcoat > 0 ? s.clearcoat : 1;
      m.clearcoatRoughness = s.clearcoatRoughness ?? 0.08;
      break;
    case 'M_Carbon':
      m.clearcoat = s.clearcoat && s.clearcoat > 0 ? s.clearcoat : 1;
      m.clearcoatRoughness = s.clearcoatRoughness ?? 0.08;
      break;
    case 'M_Perspex': {
      // §T.192 (USER: "the window shield seems to not be transparent at all"). The hero used `transmission`, whose
      // backdrop is a viewport copy taken BEFORE the ocean draws (the ocean is itself a transparent-pass reader of the
      // opaque scene, surfaceMaterial.ts §V.24) — so the screen refracted a sea-less backdrop and read as a grey slab.
      // Every variant is now alpha-blended smoked polycarbonate drawn AFTER the ocean (PERSPEX_RENDER_ORDER):
      //  - coverage = the baked opacity in baseColor alpha (smoke 0.38, scratches/salt/grime raise it; bake.py);
      //  - Schlick Fresnel (F0 0.04, n 1.49) raises it toward grazing, so the sky reflection the physical specular
      //    adds is not blended away where a real screen turns into a mirror;
      //  - roughness from the ORM (scratch webs, salt film), relief from the normal map (crazing, chips).
      // Both faces of the 12 mm slab exist, so FrontSide gives exactly one blend per crossing.
      m.ior = s.ior ?? 1.49;
      m.transparent = true;
      m.depthWrite = false;
      m.side = THREE.FrontSide;
      const coverage = map ? map.a : float(s.opacity !== undefined && s.opacity < 1 ? s.opacity : 0.38);
      const cosV = normalView.dot(positionViewDirection).abs().clamp(0, 1);
      const fresnel = float(0.04).add(float(0.96).mul(cosV.oneMinus().pow(5)));
      m.opacityNode = mix(coverage, float(1), fresnel).clamp(0, 1);
      m.metalnessNode = float(0);
      break;
    }
    default:
      break;
  }
  return m;
}
