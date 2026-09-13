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
  dFdx,
  dFdy,
  float,
  fwidth,
  luminance,
  mix,
  normalize,
  normalLocal,
  normalMap,
  normalWorldGeometry,
  objectGroup,
  positionLocal,
  positionView,
  positionWorld,
  select,
  smoothstep,
  step,
  texture,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { waterLighting } from '../../caustics';
import type { TslNode } from '../../caustics/causticsNode';
import type { SlotName } from './contract';
import { HERO_LIVERY, numberGlyphs, resolveLivery } from './livery';

export type BoatVariant = 'hero' | 'npc';

export interface SlotMaterialOptions {
  /** hero pays for true transmission on the perspex; npc boats use cheap alpha (doc §5.4) */
  variant: BoatVariant;
  /** fold in waterLighting(); false for a studio lookdev with no sea bound */
  water: boolean;
}

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
function hullLiveryAlbedo(maskMap: THREE.Texture, map: TslNode, baseFactor: TslNode, ex: HullLiveryExtras): { albedo: TslNode; boot: TslNode; overlay: TslNode } {
  const hue = (hex: number) => uniform(new THREE.Color(hex)).setGroup(objectGroup);
  const topsides = hue(HERO_LIVERY.topsides);
  const band = hue(HERO_LIVERY.band);
  const stripe = hue(HERO_LIVERY.stripe);
  const antifoul = hue(HERO_LIVERY.antifoul);
  const numeral = hue(HERO_LIVERY.numeral);
  const digitA = uniform(2).setGroup(objectGroup);
  const digitB = uniform(7).setGroup(objectGroup);
  const digitCount = uniform(2).setGroup(objectGroup);
  topsides.onObjectUpdate((frame) => {
    const l = resolveLivery(liveryOwner(frame.object));
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
  return { albedo, boot, overlay };
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
  if (orm) m.aoNode = mix(float(1), orm.r, float(s.aoMapIntensity ?? 1));

  const w = opts.water
    ? waterLighting({ worldPos: positionWorld, normal: normalWorldGeometry, shipLocalPos: positionLocal, mode: 'both' })
    : null;

  m.colorNode = w ? albedo.mul(w.tint) : albedo;
  m.roughnessNode = (w ? rough.mul(w.roughnessScale) : rough).clamp(0.02, 1);
  m.metalnessNode = metal;
  if (w) m.emissiveNode = w.addLight;
  if (s.normalMap) {
    const scale = vec2(s.normalScale?.x ?? 1, s.normalScale?.y ?? 1);
    const ns = extras.nonSkid;
    if (slot === 'M_NonSlip' && ns && s.clearcoatNormalMap && map !== null) {
      // moulded non-skid: tiling detail at its metric scale, whiteout-blended where baseColor alpha says
      // non-skid, faded out with distance so it band-limits (§V48)
      const det = texture(s.clearcoatNormalMap, uv().mul(ns.atlasMetres / ns.tileMetres)).xyz.mul(2).sub(1);
      const base = texture(s.normalMap).xyz.mul(2).sub(1);
      const k = map.a.mul(smoothstep(ns.fade[0], ns.fade[1], positionView.length()).oneMinus());
      const blended = normalize(vec3(base.xy.add(det.xy.mul(k)), base.z));
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
    case 'M_Perspex':
      m.ior = s.ior ?? 1.49;
      if (opts.variant === 'hero') {
        // one viewport-texture copy for the hero's screen, never ×8 (doc §5.4)
        m.transmission = s.transmission && s.transmission > 0 ? s.transmission : 1;
        m.thickness = 0.012;
        m.side = THREE.DoubleSide;
      } else {
        m.transparent = true;
        m.opacity = s.opacity < 1 ? s.opacity : 0.35;
        m.depthWrite = false;
        m.side = THREE.DoubleSide;
      }
      break;
    default:
      break;
  }
  return m;
}
