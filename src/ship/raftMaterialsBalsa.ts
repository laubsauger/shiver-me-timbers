/**
 * BALSA (§T90): the raft's logs, crossbeams, stern block, oar shaft and bipod
 * legs. Weathered grey-brown with a seeded warm-dry variation per piece,
 * long shallow grain along the member, radial end-grain checks within
 * `balsaEndZone` of either end, rope-lashing grooves at the crossbeam
 * stations (logs), and a green weed band at the waterline that thins toward
 * the bow (logs). One shared material per kind; which piece a fragment is on
 * comes from raftMaterialNodes.ts. §V23: functional mix()/smoothstep().
 *
 * §T147 — WHY THIS READ AS PLASTIC, and what woodMaterial.ts had that this did
 * not. The user: "the colours are way too even, it looks like plastic instead
 * of wood, and the textures are still weak." Four causes, measured rather than
 * guessed, all of them in the ALBEDO or in the relief GAIN and none of them in
 * the geometry (the logs are 12-sided smooth-shaded cylinders and their round
 * volume was never the problem):
 *
 *   1. NO GRAIN CONTRAST. The grain was `colour × mix(0.86, 1.1, fbm)` — an
 *      ACHROMATIC ±12% at the extremes, and a 3-octave value fbm lives in
 *      0.3–0.7, so what actually reached the pixel was ±5% of brightness and
 *      no hue movement at all. woodMaterial has always run its grain as
 *      `mix(dark, light, grain)` between two DIFFERENT COLOURS whose ratio is
 *      1.6–2.0 per channel. That is the whole difference between timber and a
 *      painted tube. Fixed here with `balsaShadow` + `balsaGrainContrast`.
 *   2. NOTHING AT THE SCALE THE VIEWER STANDS AT. Every varying term was
 *      either per-PIECE (one tone for a whole 13.7 m log) or 2.8 cm grain that
 *      is sub-pixel past a few metres and averages to one flat colour — so at
 *      the 10 m the raft is usually seen from there was, arithmetically,
 *      nothing left. woodMaterial fills that band with per-BOARD tone steps
 *      (0.55 m) plus butt joints. A log has no boards, so the equivalent is a
 *      metre-scale weathering STAIN (`balsaBlotch*`), seeded per piece.
 *   3. THE PER-PIECE JITTER WAS NOT PER-PIECE. `lowTone` was an fbm of
 *      `positionLocal` on nine near-identical centred cylinders, i.e. very
 *      nearly the SAME field on every log; only the seed decorrelated them,
 *      and it only reached half the grey→warm range. Now the seed offsets the
 *      sample position as well, which is what makes "no two logs alike"
 *      (ref §7) true of the pattern and not only of the base tone.
 *   4. THE RELIEF WAS EXAGGERATED 8×, which is §T134's defect verbatim on a
 *      third family: `reliefNormal` is exact and every depth here is in
 *      metres, so `balsaBump` is pure gain. At 8 an end check presented an 87°
 *      wall and a rope groove 78° — the log ends rendered as black caps and
 *      the grooves as moulded ribs. Over-embossed relief on a flat albedo IS
 *      the plastic look; the cure is the other way round.
 *
 * The CPU twins at the bottom are the §V80 witnesses for each property, in the
 * transliteration-pair style bandLimit.ts uses.
 */
import * as THREE from 'three/webgpu';
import { atan, float, mix, normalLocal, positionLocal, uniform, vec2, vec3 } from 'three/tsl';
import { bandLimitedEdge, bandLimitedEdgeValue } from './bandLimit';
import { fbm2, hash2, triplanarFbm } from '../terrain/noise';
import { reliefNormal } from './surfaceRelief';
import type { PieceKind } from './pieceTypes';
import { raftParams } from '../params/raft';
import { raftMaterialParams, type RaftMaterialParams } from '../params/raftMaterials';
import { buildRaftBlueprint, raftLayout } from './raftBlueprint';
import {
  createRaftPieceUniforms,
  faceness,
  gateAbove,
  noiseResolved,
  ringMask,
  shipWater,
  type AnyNode,
  type RaftPieceUniforms,
} from './raftMaterialNodes';
import type { LocalFrame, ShipMaterialHandle } from './woodMaterial';

type Axis = 'x' | 'y' | 'z';

/** the piece-local axis a balsa member runs along (pieceGeometryRaft.ts) */
export const BALSA_AXIS: Partial<Record<PieceKind, Axis>> = {
  log: 'z',
  crossbeam: 'x',
  'stern-block': 'x',
  'steering-oar': 'z',
  'bipod-mast': 'y',
};

const AXES: readonly Axis[] = ['x', 'y', 'z'];
const others = (a: Axis): [Axis, Axis] => AXES.filter((b) => b !== a) as [Axis, Axis];

/**
 * How far the fbm's own range is stretched before it drives a colour, §T147.
 *
 * MEASURED, NOT PICKED. `fbm2` normalises to [0,1] but a 2–3 octave value fbm
 * does not USE [0,1] — measured over a cylinder flank at this file's tri-planar
 * sharpness it has mean 0.51 and sd 0.129 (3 octaves) / 0.145 (2). So the old
 * `mix(0.86, 1.1, grain)` — already only a ±12% ACHROMATIC swing at its
 * unreachable extremes — delivered a brightness sd of 0.24 × 0.129 = ±3.1%.
 * That is the whole of "the colours are way too even".
 *
 * 2.2 takes the grain to sd 0.27 with 6.8% of samples clipping at one end or
 * the other, which is the right trade for a weathered surface: a fully bleached
 * streak and a fully soaked one both exist on a real log. Beyond ~2.6 the clip
 * fraction passes 14% and the field starts reading as two-tone camouflage.
 */
const CONTRAST_GAIN = 2.2;

/** contrast-stretch an fbm about its 0.5 midpoint — see {@link CONTRAST_GAIN} */
function contrastStretch(v: AnyNode): AnyNode {
  return v.sub(0.5).mul(CONTRAST_GAIN).add(0.5).clamp(0, 1);
}

/** CPU mirror of {@link contrastStretch}, for the §V80 property tests */
export function balsaContrastStretch(v: number): number {
  return Math.min(1, Math.max(0, (v - 0.5) * CONTRAST_GAIN + 0.5));
}

/** ship-frame z of the first crossbeam station — read off the blueprint (§V37: one source) */
export function crossbeamStation0(): number {
  const beam = buildRaftBlueprint(raftParams).find((d) => d.id === 'crossbeam-0');
  return beam === undefined ? 0 : beam.transform.position[2];
}

export function createBalsaMaterial(
  kind: PieceKind,
  frame?: LocalFrame,
  p: RaftMaterialParams = raftMaterialParams,
): ShipMaterialHandle {
  const axis = BALSA_AXIS[kind] ?? 'z';
  const [b, c] = others(axis);
  const isLog = kind === 'log';
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0;

  const uGrey = uniform(new THREE.Color(p.balsaGrey));
  const uWarm = uniform(new THREE.Color(p.balsaWarm));
  const uShadow = uniform(new THREE.Color(p.balsaShadow));
  const uToneVar = uniform(p.balsaToneVar);
  const uGrainScale = uniform(p.balsaGrainScale);
  const uGrainStretch = uniform(p.balsaGrainStretch);
  const uGrainContrast = uniform(p.balsaGrainContrast);
  const uBlotchScale = uniform(p.balsaBlotchScale);
  const uBlotchStrength = uniform(p.balsaBlotchStrength);
  const uGrainRelief = uniform(p.balsaGrainRelief);
  const uEndZone = uniform(p.balsaEndZone);
  const uCheckWidth = uniform(p.balsaCheckWidth);
  const uCheckDepth = uniform(p.balsaCheckDepth);
  const uCheckDarken = uniform(p.balsaCheckDarken);
  const uGrooveWidth = uniform(p.grooveWidth);
  const uGrooveDepth = uniform(p.grooveDepth);
  const uGrooveDarken = uniform(p.grooveDarken);
  const uPitch = uniform(raftParams.crossbeamPitch);
  const uBeamCount = uniform(raftParams.crossbeamCount);
  const uBeamHalf = uniform(raftParams.crossbeamLength / 2);
  const uStation0 = uniform(crossbeamStation0());
  const uWeed = uniform(new THREE.Color(p.weedColor));
  const uWeedHalf = uniform(p.weedHalfBand);
  const uWeedFade = uniform(p.weedBowFade);
  const uWeedStrength = uniform(p.weedStrength);
  const uWetDarken = uniform(p.wetDarken);
  const uWetRise = uniform(p.wetRise);
  const uCrevice = uniform(p.balsaCrevice);
  const uHalfBeam = uniform(raftLayout().halfBeam);
  const uRough = uniform(p.balsaRough);
  const uBump = uniform(p.balsaBump);
  const piece: RaftPieceUniforms = createRaftPieceUniforms();

  const pos = positionLocal;
  const along: AnyNode = pos[axis];
  const angle = atan(pos[c], pos[b]);

  // SEEDED PER-PIECE TONE — "no two logs alike" [§7]. The seed spans the whole
  // grey→warm range about its centre, so `balsaToneVar` reads as the SPREAD it
  // is documented to be; before §T147 it was `seed × toneVar`, a one-sided
  // 0..0.5 that put every log in the grey half and left the warm end unused.
  const toneMix = piece.seed.sub(0.5).mul(uToneVar).add(0.5).clamp(0, 1);
  const tone: AnyNode = mix(uGrey, uWarm, toneMix);

  const stretch = vec3(
    axis === 'x' ? uGrainStretch.reciprocal() : 1,
    axis === 'y' ? uGrainStretch.reciprocal() : 1,
    axis === 'z' ? uGrainStretch.reciprocal() : 1,
  );
  /**
   * A PER-PIECE OFFSET OF THE SAMPLE POSITION, not only of the tone.
   *
   * Nine logs are nine near-identical centred cylinders, so an fbm of
   * `positionLocal` returns very nearly the SAME field on all of them and adds
   * nothing to "no two alike" — the pre-§T147 `lowTone` term was decorrelated
   * only by the seed it was added to. Sliding the sample point by the seed is
   * what makes the PATTERN differ and not just the base colour.
   */
  const offset = vec3(piece.seed.mul(31.7), piece.seed.mul(11.3), piece.seed.mul(53.1));

  // long shallow grain: fbm stretched along the member, run as a COLOUR ramp
  // between a dark weathered end and a light one (woodMaterial's construction)
  const samplePos = pos.mul(uGrainScale).mul(stretch).add(offset);
  const grain = triplanarFbm(samplePos, normalLocal, float(6), 3);
  const grainResolved = noiseResolved(samplePos, 3);
  const dark = mix(tone, uShadow, uGrainContrast);
  const lite = tone.mul(float(1).add(uGrainContrast.mul(0.45)));
  /**
   * …and it FADES TO ITS OWN MEAN, not to zero (§V.70). The contrast this now
   * carries is a 2:1 albedo ratio, which is enough that leaving it ungated
   * would be per-pixel colour noise once a 2.8 cm grain cell is sub-pixel (past
   * about 12 m). A smooth term's honest band-limited value is the midpoint of
   * its two levels, which is what `mix(0.5, …)` converges to — and the variance
   * is not lost, it is CONVERTED (§V.64): the metre-scale stain below is the
   * carrier that is still resolvable at the range this retires at.
   */
  let color: AnyNode = mix(dark, lite, mix(float(0.5), contrastStretch(grain), grainResolved));

  /**
   * METRE-SCALE WEATHERING STAIN — the band §T147 found empty.
   *
   * `balsaBlotchScale` is cells per metre ACROSS the member and rides the same
   * `stretch`, so a patch is several metres long and about a third of the girth
   * wide: a stain, not a speckle. It needs no band limit of its own — it is a
   * smooth fbm with no edge, and its own failure mode (the whole repeat going
   * sub-pixel) does not arrive until a 3 m feature is one pixel, which is
   * several hundred metres past the point the raft is two pixels wide.
   */
  const blotch = triplanarFbm(pos.mul(uBlotchScale).mul(stretch).add(offset), normalLocal, float(6), 2);
  const stain = contrastStretch(blotch).oneMinus();
  color = mix(color, uShadow, stain.mul(uBlotchStrength));

  // END-GRAIN CHECKS: radial cracks that open within `endZone` of either end
  const endDist = along.sub(piece.aabbMin[axis]).min(piece.aabbMax[axis].sub(along)).max(0);
  const endness = bandLimitedEdge(endDist, along, uEndZone).oneMinus();
  const checkCount = Math.max(3, Math.round(p.balsaCheckCount));
  const checkCoord = angle.mul(checkCount / (Math.PI * 2)).add(piece.seed.mul(checkCount));
  // @band-limited-elsewhere: the edge is drawn by bandLimitedEdge below
  const cf = checkCoord.fract();
  const checkDist = cf.min(cf.oneMinus());
  // the crack's width in CHECK units: circumference ÷ count is one check
  const circumference = piece.aabbMax[b].sub(piece.aabbMin[b]).mul(Math.PI).max(0.05);
  const checkWidth = uCheckWidth.mul(checkCount).div(circumference);
  const checkMask = bandLimitedEdge(checkDist, checkCoord, checkWidth);
  const open = gateAbove(hash2(vec2(checkCoord.floor(), piece.seed.mul(97))), 0.55);
  const check = checkMask.oneMinus().mul(open).mul(endness);

  // ROPE GROOVES at the crossbeam stations, logs only, and only on the logs a
  // 5.5 m beam actually reaches
  let groove: AnyNode = float(0);
  if (isLog) {
    const phase = uStation0.sub(piece.origin.z);
    const idx = along.sub(phase).div(uPitch).add(0.5).floor();
    const inRange = idx.add(1).clamp(0, 1).mul(uBeamCount.sub(idx).clamp(0, 1));
    const reached = uBeamHalf.sub(piece.origin.x.abs()).mul(10).clamp(0, 1);
    groove = ringMask(along, uPitch, uGrooveWidth, phase).oneMinus().mul(inRange).mul(reached);
  }

  color = color.mul(mix(float(1), uCheckDarken, check));
  color = color.mul(mix(float(1), uGrooveDarken, groove));
  // a stained patch is soaked and slightly smoother; the dry weathered fibre
  // between the patches is rougher. One more thing that was one flat number.
  let rough: AnyNode = uRough.add(grain.mul(0.1)).add(check.mul(0.1)).sub(stain.mul(0.12));

  let crevice: AnyNode = float(0);
  if (isLog) {
    // WEED along the waterline (log axis y = 0), patchy, thinning toward the bow
    const band = bandLimitedEdge(pos.y.abs(), pos.y, uWeedHalf).oneMinus();
    /**
     * The patch coordinate is `pos[b]` — the ACROSS-member metre — and not
     * `angle`. §T147: `atan` has a branch cut at ±π, which on a log lands at
     * y = 0 on the PORT flank, i.e. exactly in the weed band and exactly in a
     * chink; an fbm of the angle therefore stepped there and drew a hard line
     * down every log at the waterline. Metres across the log wrap nowhere, and
     * the band is only ±0.15 m tall so the top and bottom of the log (where
     * ±x is degenerate) never sample it.
     */
    const patch = fbm2(vec2(along.mul(1.3), pos[b].mul(2.2).add(piece.seed.mul(7))), 2)
      .sub(0.35)
      .mul(2.5)
      .clamp(0, 1);
    const bowFade = piece.aabbMax.z.sub(along).div(uWeedFade.max(0.05)).clamp(0, 1);
    const weed = band.mul(patch).mul(bowFade).mul(uWeedStrength);
    color = mix(color, uWeed, weed);
    rough = rough.sub(weed.mul(0.3));
    /**
     * THE WET BAND STRADDLES THE WATERLINE — §T147.
     *
     * `logAxisY` = 0 IS the waterline (the logs float half submerged), so the
     * old `y < 0` ramp was painting the half of the log nobody can see and the
     * visible flank kept its dry tone right down to the sea. The reference
     * frame is unambiguous: near-black at the surface, fading out about a fifth
     * of a radius up. A clamp on metres — no period, no sub-pixel regime.
     */
    const wet = uWetRise.sub(pos.y).div(uWetRise.add(0.08).max(0.02)).clamp(0, 1);
    color = color.mul(float(1).sub(uWetDarken.mul(wet)));
    rough = rough.sub(wet.mul(0.25));
    /**
     * CHINK CREVICE (§T147 half a). The gap between two logs measures 2.5–7.1
     * cm on the built raft — dead inside the reference's 2–8 cm [§1 Gaps] — so
     * the chink is not too WIDE, it reads too wide. Two 0.55 m cylinders 5 cm
     * apart form a slot whose walls see almost no sky, which is why every
     * reference photo shows the chinks as dark LINES; ours had the flanks lit
     * by the full hemisphere and read as open water.
     *
     * `faceness` is a smoothstep on a NORMAL COMPONENT — no period, so no
     * band limit applies — and on a cylinder it peaks exactly at the waterline
     * (|n·x| = 1 at y = 0) and releases toward the crown, which is the shape of
     * the real occlusion. Exempted on the one face that genuinely sees the sky:
     * the OUTBOARD flank of an outer log, which is the whole of what the beam
     * station looks at.
     */
    const flank = faceness(normalLocal[b]);
    const outerLog = piece.origin.x.abs().sub(uHalfBeam).add(0.05).mul(20).clamp(0, 1);
    const outward = normalLocal[b].mul(piece.origin.x.sign()).clamp(0, 1);
    crevice = flank.mul(float(1).sub(outerLog.mul(outward))).mul(uCrevice);
  }

  const height = grain
    .sub(0.5)
    .mul(uGrainRelief)
    .mul(grainResolved)
    .sub(check.mul(uCheckDepth))
    .sub(groove.mul(uGrooveDepth));

  const water = shipWater(frame);
  material.colorNode = color.mul(water.tint);
  material.roughnessNode = rough.mul(water.roughnessScale).clamp(0.04, 1);
  material.emissiveNode = water.addLight;
  // cavity: the check and groove cuts, and — logs only — the chink the log's
  // flank faces. Every input is either an already-band-limited mask or a
  // normal component, so none of it needs a gate of its own (§V.48).
  material.aoNode = float(1).sub(check.max(groove).mul(0.6).max(crevice).clamp(0, 1));
  material.normalNode = reliefNormal(height, uBump.mul(water.reliefScale));

  return {
    material,
    refresh(): void {
      uGrey.value.set(p.balsaGrey);
      uWarm.value.set(p.balsaWarm);
      uShadow.value.set(p.balsaShadow);
      uToneVar.value = p.balsaToneVar;
      uGrainScale.value = p.balsaGrainScale;
      uGrainStretch.value = p.balsaGrainStretch;
      uGrainContrast.value = p.balsaGrainContrast;
      uBlotchScale.value = p.balsaBlotchScale;
      uBlotchStrength.value = p.balsaBlotchStrength;
      uGrainRelief.value = p.balsaGrainRelief;
      uEndZone.value = p.balsaEndZone;
      uCheckWidth.value = p.balsaCheckWidth;
      uCheckDepth.value = p.balsaCheckDepth;
      uCheckDarken.value = p.balsaCheckDarken;
      uGrooveWidth.value = p.grooveWidth;
      uGrooveDepth.value = p.grooveDepth;
      uGrooveDarken.value = p.grooveDarken;
      uPitch.value = raftParams.crossbeamPitch;
      uBeamCount.value = raftParams.crossbeamCount;
      uBeamHalf.value = raftParams.crossbeamLength / 2;
      uStation0.value = crossbeamStation0();
      uWeed.value.set(p.weedColor);
      uWeedHalf.value = p.weedHalfBand;
      uWeedFade.value = p.weedBowFade;
      uWeedStrength.value = p.weedStrength;
      uWetDarken.value = p.wetDarken;
      uWetRise.value = p.wetRise;
      uCrevice.value = p.balsaCrevice;
      uHalfBeam.value = raftLayout().halfBeam;
      uRough.value = p.balsaRough;
      uBump.value = p.balsaBump;
    },
  };
}

// ---------------------------------------------------------------------------
// §V80 CPU TWINS — a documented TRANSLITERATION PAIR with the graph above, in
// the style bandLimit.ts and sailShape.ts already use. A TSL node graph cannot
// be evaluated headless, so the properties §T147 is answerable for (no two logs
// alike; the weed only at the waterline; checks only near the ends; grooves
// only at the crossbeam stations; the chink dark) are asserted through these.
// Change one side → change the other.
// ---------------------------------------------------------------------------

/** the two colours the grain ramps between on one piece, LINEAR rgb */
export interface BalsaToneRange {
  /** the grain's dark end (`mix(tone, balsaShadow, balsaGrainContrast)`) */
  dark: THREE.Color;
  /** its light end */
  lite: THREE.Color;
  /** the un-grained per-piece base tone */
  tone: THREE.Color;
}

/**
 * CPU twin of the per-piece tone and the two ends its grain ramps between.
 * `seed` is {@link hashPieceId} of the piece id, 0..1.
 */
export function balsaToneRange(seed: number, p: RaftMaterialParams = raftMaterialParams): BalsaToneRange {
  const t = Math.min(1, Math.max(0, (seed - 0.5) * p.balsaToneVar + 0.5));
  const tone = new THREE.Color(p.balsaGrey).lerp(new THREE.Color(p.balsaWarm), t);
  const dark = tone.clone().lerp(new THREE.Color(p.balsaShadow), p.balsaGrainContrast);
  const lite = tone.clone().multiplyScalar(1 + p.balsaGrainContrast * 0.45);
  return { dark, lite, tone };
}

/** Rec.709 relative luminance of a LINEAR colour — the "how different are these
 *  two logs" measure the §V80 tests compare against. */
export function balsaLuminance(c: THREE.Color): number {
  return 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
}

/** CPU twin of `endness`: 1 at a member's end, 0 beyond `balsaEndZone`. */
export function balsaEndness(endDist: number, p: RaftMaterialParams = raftMaterialParams): number {
  return 1 - bandLimitedEdgeValue(Math.max(0, endDist), p.balsaEndZone, 0);
}

/** CPU twin of the weed BAND (the |y| term; the patch noise is separate):
 *  1 on the waterline, 0 outside ±`weedHalfBand`. */
export function balsaWeedBand(y: number, p: RaftMaterialParams = raftMaterialParams): number {
  return 1 - bandLimitedEdgeValue(Math.abs(y), p.weedHalfBand, 0);
}

/** CPU twin of the wet band: 1 at and below the waterline, 0 above `wetRise`. */
export function balsaWetBand(y: number, p: RaftMaterialParams = raftMaterialParams): number {
  return Math.min(1, Math.max(0, (p.wetRise - y) / Math.max(0.02, p.wetRise + 0.08)));
}

/**
 * CPU twin of the lashing-groove mask on a LOG: 1 in a groove, 0 between.
 *
 * @param along   piece-local z (the log runs along z)
 * @param originZ the log node's ship-frame z
 * @param originX …and its ship-frame x, which decides whether a 5.5 m beam
 *                reaches this log at all
 */
export function balsaGrooveAt(
  along: number,
  originZ: number,
  originX: number,
  p: RaftMaterialParams = raftMaterialParams,
): number {
  const pitch = raftParams.crossbeamPitch;
  const phase = crossbeamStation0() - originZ;
  const idx = Math.floor((along - phase) / pitch + 0.5);
  const inRange = Math.min(1, Math.max(0, idx + 1)) * Math.min(1, Math.max(0, raftParams.crossbeamCount - idx));
  const reached = Math.min(1, Math.max(0, (raftParams.crossbeamLength / 2 - Math.abs(originX)) * 10));
  const c = (along - phase) / pitch + 0.5;
  const centred = Math.abs(c - Math.floor(c) - 0.5);
  const half = p.grooveWidth / pitch / 2;
  const ring = 1 - bandLimitedEdgeValue(Math.max(0, centred - half), half, 0);
  return ring * inRange * reached;
}

/**
 * CPU twin of the chink crevice occlusion, 0..1 (1 = fully occluded flank).
 *
 * @param nAcross  the piece-local x component of the surface normal
 * @param originX  the log's ship-frame x
 * @param halfBeam the outer log's centreline x (`raftLayout().halfBeam`)
 */
export function balsaCreviceAt(
  nAcross: number,
  originX: number,
  halfBeam: number,
  p: RaftMaterialParams = raftMaterialParams,
): number {
  const flank = smooth01(0.6, 0.9, Math.abs(nAcross));
  const outerLog = Math.min(1, Math.max(0, (Math.abs(originX) - halfBeam + 0.05) * 20));
  const outward = Math.min(1, Math.max(0, nAcross * Math.sign(originX)));
  return flank * (1 - outerLog * outward) * p.balsaCrevice;
}

/** the `smoothstep` `faceness()` is built from */
function smooth01(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / Math.max(1e-6, e1 - e0)));
  return t * t * (3 - 2 * t);
}
