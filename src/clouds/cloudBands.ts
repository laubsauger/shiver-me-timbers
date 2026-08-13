/**
 * BANDED STRATUS LAYER (§V11 stage 1b) — the SECOND cloud form.
 *
 * User, 2026-08-13: "we need also this other type of clouds… these more bandy,
 * like stretched out, diffused clouds, so that we can break up our existing
 * clouds a little bit better." This is that layer. It does NOT replace the
 * cumulus cores; it sits above and behind them and does the compositional work
 * the SoT references give it — in docs/inspo/night/ the banded veil covers a
 * third to a half of the frame and carries almost none of the visual weight,
 * while one pale cumulus bank carries all of it.
 *
 * ─── WHY IT IS NOT GEOMETRY ───────────────────────────────────────────────
 * §V11b says cores are POLYGONAL MESHES because a billboard cannot hold a
 * sculpted silhouette. A stratus deck has no silhouette to hold: it is a
 * horizontal SHEET, and the thing that makes it read is perspective, not
 * outline. So it is drawn as an analytic ray/plane intersection — a
 * camera-pinned quad whose fragments intersect the view ray with the plane
 * y = bandAltitude and evaluate a 2D field at the world XZ of that hit.
 * Modelling it as lobes would be lying about its form and would cost hundreds
 * of instances to say one plane.
 *
 * ─── WHY IT SHARES THE CORES RT ───────────────────────────────────────────
 * It writes the SAME premultiplied 4-channel pack the lobes write
 * (R=sunlight, G=skylight, B=alpha, A=normalised depth, ONE/ONE blending), into
 * the same RenderTarget, so it inherits — for free and with no second copy of
 * anything — the depth-scaled blur, the composite's erosion/alpha ramp, the
 * §T.39 live day-cycle palette, and its own reflection in the water (§V26:
 * cloudMirror samples that RT). No new sampler, so §V.40's contested spare is
 * untouched; the field is procedural (mx_noise_float), no texture at all.
 *
 * Compositing with the cumulus therefore is not a decision this file makes: the
 * pack is ADDITIVE, so where a band crosses a cluster the two coverages sum and
 * the composite's channel/B recovers a coverage-WEIGHTED AVERAGE of the two
 * colours. Cluster interiors run coverage 3–6 (§V60) against a band's 0.1–0.4,
 * so a cumulus is diluted by a few percent — a veil, which is what a thin sheet
 * in front of a cumulus does — and never punctured. Open sky between bands is
 * mathematically untouched. What DOES move is the cumulus SKIRT: an edge pixel
 * at coverage 0.3 sitting under a band at 0.25 lands at 0.55 and reads slightly
 * more opaque. That is the one visible interaction, it is bounded by
 * `bandCoverage`, and it is why the default is modest.
 *
 * ─── DIFFUSED, NOT FOG ────────────────────────────────────────────────────
 * Four things separate a soft cloud from a grey wash, and all four are here:
 *  1. STRUCTURE WITH GAPS. The field is thresholded into a mask that reaches
 *     zero over roughly half the sky. Fog has no gaps; a band layer is mostly
 *     gaps. This is the single biggest cue.
 *  2. DIRECTION. The noise coordinate is scaled ~8:1 along the drift axis, so
 *     features are long and thin BY CONSTRUCTION. §V58's lesson in the sky: a
 *     direction-free field cannot make oriented features, so the direction has
 *     to be put in explicitly rather than hoped for.
 *  3. PARALLAX. The deck is at a finite altitude, so bands converge toward the
 *     horizon and stream past as the ship moves. Fog does neither.
 *  4. INTERNAL TONE. Brightness is forward-scattered sun through a thin sheet
 *     (Beer–Lambert on the layer's own thickness), so thin margins glow and
 *     dense cores go a shade darker than the sky. A wash has one value.
 *
 * ─── §V.32, DELIBERATELY ──────────────────────────────────────────────────
 * The sky background is camera-anchored at infinity; this layer is NOT. The
 * GEOMETRY is camera-pinned (a quad on the frustum, so nothing can ever be
 * clipped by camera.far or sailed out of — §B.10's failure mode is impossible
 * by construction), but the PATTERN is keyed on world XZ. Finite height plus
 * world-locked pattern is exactly what buys the parallax in (3); a layer keyed
 * on view direction would be wallpaper glued to the sky, which is the tell for
 * a painted backdrop. The ray range is clamped (`bandRange`) so the pattern
 * coordinate is bounded near the horizon rather than exploding through the
 * grazing divide (§V44's corollary: flooring a divisor bounds the DIVISION,
 * not the QUOTIENT).
 *
 * ─── §V.48 ────────────────────────────────────────────────────────────────
 * Every octave's amplitude is faded on ITS OWN feature size against ITS OWN
 * screen-space footprint (`bandLimitAmplitude`, src/ship/bandLimit.ts) — not
 * on the layer's period, which is §B.20's 12×-too-late error. mx_noise_float is
 * ZERO-MEAN, so fading an octave's amplitude to zero IS fading it to that
 * octave's own mean (§V.48b half b), the same argument the sail's antisymmetric
 * seam ridge rests on. That alone is NOT §V70 satisfied, because the shape is a
 * clamp and a pow ON TOP of the field and the mean of a nonlinear function is
 * not that function of the mean — so the shape blends to `bandFarMean`, the
 * layer's own area-mean, as its structure dissolves. See bandShapeAt(). Without
 * that second step the bands evaporate into a clean gap a few degrees above the
 * skyline instead of thinning into uniform veil. There is no `step`/`smoothstep`/`fract`
 * on a spatial coordinate anywhere in this file — every ramp is an `exp`, a
 * `pow` or a `clamp`, which have no edge to alias — so it adds nothing to the
 * §V.48 tripwire population.
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  mix,
  mx_noise_float,
  positionWorld,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { bandLimitAmplitude, coordFilter } from '../ship/bandLimit';
import { applyPackedBlending } from './cloudCores';
import { createRng } from '../state/rng';
import type { CloudParams } from '../params/clouds';

type N = ShaderNodeObject<Node>;

/**
 * One mx_noise_float lattice cell is 1 unit of its input, so the smallest
 * feature it can draw is about half of that. This is the FEATURE width the
 * band limit is measured against — the octave's own, at each octave's own
 * frequency, never the layer's period (§B.20).
 */
const NOISE_FEATURE = 0.5;

/** octave frequencies and weights of the band field (shared CPU/TSL) */
const OCTAVES: readonly { freq: number; amp: number }[] = [
  { freq: 1.0, amp: 1.0 },
  { freq: 2.3, amp: 0.45 },
  { freq: 5.1, amp: 0.22 },
];
const OCTAVE_NORM = OCTAVES.reduce((s, o) => s + o.amp, 0);

/** §V28 / §V44: no divisor here is ever allowed near zero */
const EPS = 1e-4;

const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

// ── CPU mirrors ────────────────────────────────────────────────────────────
// A TSL graph cannot be evaluated headless, so the numeric contracts below are
// stated once as plain functions and TRANSLITERATED into the graph — the same
// convention as sailShape.ts ↔ the sail graph and bandLimit.ts's own pair.
// tests/clouds.test.ts drives these.

/**
 * Shape (0..1 thickness) for a field value, at a resolution `resolved`.
 *
 * `bandGamma` ≥ 1 makes the falloff asymmetric — a firmer shoulder, a long
 * diffuse tail — with no edge function anywhere (§V.48).
 *
 * `resolved` is 1 while the field's own structure is bigger than a pixel and
 * 0 once it is not, and THAT IS THE HALF §V.48b IS EASY TO GET WRONG HERE.
 * Fading each noise octave to zero is correct for the FIELD, because the noise
 * is zero-mean — but the shape is a CLAMP and a POW on top of it, and the mean
 * of a nonlinear function is not that function of the mean. Fading the octaves
 * alone therefore converges to `bias^gamma` ≈ 0.005 where the layer's true
 * area-mean is ~0.19, i.e. it DELETES the layer over the few degrees of sky
 * where the structure is sub-pixel but the horizon fade has not yet taken it —
 * §V70's failure exactly ("converges to a FLAT surface … instead of filtering
 * it"), and it would read as the bands evaporating into a clean gap above the
 * skyline. So the shape blends to `bandFarMean`, which is what an infinitely
 * distant pixel actually sees.
 */
export function bandShapeAt(field: number, resolved: number, p: BandProfile): number {
  const mask = clamp01(field * p.bandContrast + p.bandBias);
  const sharp = Math.pow(mask, Math.max(1, p.bandGamma));
  const far = clamp01(p.bandFarMean);
  return far + (sharp - far) * clamp01(resolved);
}

/** Coverage the layer writes — shape × the layer's volume knob. */
export function bandCoverageAt(field: number, p: BandProfile, resolved = 1): number {
  return clamp01(bandShapeAt(field, resolved, p) * clamp01(p.bandCoverage));
}

/**
 * The layer's SUNLIGHT channel (the composite's R/B).
 *
 * A stratus sheet is optically thin, so what the eye gets is mostly light that
 * came THROUGH it and forward-scattered — not a lit face. Hence: a broad
 * ambient share, plus a Mie forward lobe on the view/sun angle, all attenuated
 * by Beer–Lambert on the layer's OWN thickness so thin margins glow and dense
 * cores sit a shade under the sky. Lighting it like a cumulus (wrapped diffuse
 * on a normal) is what would make it read flat, dark and gloomy, which is a
 * standing complaint about the cores and must not be inherited here.
 *
 * Every factor is bounded in [0,1] and MULTIPLIED (§V44 bounded at source).
 */
export function bandSunAt(forward: number, shape: number, p: BandProfile): number {
  const lobe = Math.pow(clamp01(forward), Math.max(1, p.bandForwardPower));
  const through = Math.exp(-Math.max(0, p.bandOptical) * clamp01(shape));
  const floorT = clamp01(p.bandThickFloor);
  return (
    Math.max(0, p.bandSunLevel) *
    (clamp01(p.bandAmbientFrac) + Math.max(0, p.bandForwardGain) * lobe) *
    (floorT + (1 - floorT) * through)
  );
}

/**
 * The layer's SKYLIGHT channel (the composite's G/B). Nearly flat — a
 * horizontal sheet has one orientation — with a lift toward the horizon, where
 * the line of sight runs the long way through it. That lift is most of why the
 * veil in the night reference brightens as it approaches the sea.
 */
export function bandSkyAt(rayUp: number, p: BandProfile): number {
  const lift = 1 + Math.max(0, p.bandHorizonLift) * (1 - clamp01(rayUp));
  return Math.max(0, p.bandSkyLevel) * lift;
}

/**
 * §V.55: drift is a PHASE, accumulated. `time × speed` is only a valid offset
 * while speed is constant, and band drift is meant to answer the wind, which
 * gusts — §B.30 is the same shape on the flags (0.93 Hz intended, 59.5 Hz at
 * ten minutes). Returns metres in world XZ; hostile dt is rejected rather than
 * integrated (§V28).
 */
export function advanceBandDrift(
  drift: { x: number; z: number },
  dirRadians: number,
  speed: number,
  dt: number,
): void {
  if (!Number.isFinite(dt) || dt <= 0 || dt > 1) return;
  const s = Number.isFinite(speed) ? speed : 0;
  drift.x += Math.cos(dirRadians) * s * dt;
  drift.z += Math.sin(dirRadians) * s * dt;
}

/** the subset of CloudParams this layer reads (also the CPU mirrors' input) */
export type BandProfile = Pick<
  CloudParams,
  | 'bandCoverage'
  | 'bandContrast'
  | 'bandBias'
  | 'bandGamma'
  | 'bandFarMean'
  | 'bandSunLevel'
  | 'bandAmbientFrac'
  | 'bandForwardGain'
  | 'bandForwardPower'
  | 'bandOptical'
  | 'bandThickFloor'
  | 'bandSkyLevel'
  | 'bandHorizonLift'
>;

// ── the TSL layer ──────────────────────────────────────────────────────────

/**
 * The banded layer as one camera-pinned quad writing the packed cores RT.
 * `seed` only fixes the noise offsets, so the same seed gives the same sky on
 * every client (§V2).
 */
export function createCloudBands(p: CloudParams, seed: number) {
  const rng = createRng(seed ^ 0x5bf03635);
  // per-octave lattice offsets: without them every octave would be the same
  // field at a different zoom, which reads as a self-similar smear
  const zOff = OCTAVES.map(() => rng() * 128);
  const zWarp = rng() * 128;

  const uAltitude = uniform(p.bandAltitude);
  const uRange = uniform(p.bandRange);
  const uAboveFade = uniform(p.bandAboveFade);
  const uHorizonFade = uniform(p.bandHorizonFade);
  const uLength = uniform(p.bandLength);
  const uWidth = uniform(p.bandWidth);
  const uWarp = uniform(p.bandWarp);
  const uContrast = uniform(p.bandContrast);
  const uBias = uniform(p.bandBias);
  const uGamma = uniform(p.bandGamma);
  const uFarMean = uniform(p.bandFarMean);
  const uCoverage = uniform(p.bandCoverage);
  const uSunLevel = uniform(p.bandSunLevel);
  const uAmbientFrac = uniform(p.bandAmbientFrac);
  const uForwardGain = uniform(p.bandForwardGain);
  const uForwardPower = uniform(p.bandForwardPower);
  const uOptical = uniform(p.bandOptical);
  const uThickFloor = uniform(p.bandThickFloor);
  const uSkyLevel = uniform(p.bandSkyLevel);
  const uHorizonLift = uniform(p.bandHorizonLift);
  const uMaxDist = uniform(p.maxCloudDist);
  /** world-XZ drift offset, accumulated on the CPU (§V.55) */
  const uDrift = uniform(new THREE.Vector2(0, 0));
  /** unit drift direction in world XZ — the band axis */
  const uAxis = uniform(new THREE.Vector2(1, 0));
  /** live world sun direction (shared with the cores) */
  const uSunWorld = uniform(new THREE.Vector3(0, 1, 0));

  const material = new THREE.MeshBasicNodeMaterial();

  // ── the view ray, and where it meets the deck ──────────────────────────
  const ray = positionWorld.sub(cameraPosition).normalize();
  const up = ray.y.max(0);

  // 1 - exp(-up/k): zero exactly at the horizon, rising over ~k of sin(elev).
  // An EXPONENTIAL, not a smoothstep, on purpose — it has no edge to alias and
  // needs no marker (§V.48). Fading OUT at the horizon rather than letting the
  // grazing path go opaque is what stops the layer ending in a grey wall along
  // the skyline (§V30's "fog wall ⊥"); the sky rig's own haze wedge carries the
  // last couple of degrees.
  const horizonFade = up.div(uHorizonFade.max(EPS)).negate().exp().oneMinus();

  // the deck is above the camera; as a freecam climbs into it the whole layer
  // fades out rather than flipping inside out. Bounded by construction.
  const rise = uAltitude.sub(cameraPosition.y);
  const aboveFade = rise.div(uAboveFade.max(EPS)).clamp(0, 1);

  // ray/plane distance. `up` is floored, and the RESULT is clamped too — a
  // floored divisor bounds the division, not the quotient (§V44).
  const range = rise.max(EPS).div(up.max(EPS)).min(uRange.max(1));
  const hit = cameraPosition.xz.add(ray.xz.mul(range));

  // ── the field ──────────────────────────────────────────────────────────
  // rotate world XZ into the band frame, then scale ANISOTROPICALLY: long
  // along the drift axis, short across it. This scaling IS the "bandy" read
  // (§V58 — a direction-free field cannot make oriented features).
  const q = hit.sub(uDrift);
  const along = q.x.mul(uAxis.x).add(q.y.mul(uAxis.y));
  const across = q.y.mul(uAxis.x).sub(q.x.mul(uAxis.y));
  const coord = vec2(along.div(uLength.max(1)), across.div(uWidth.max(1)));

  /** worst-axis screen footprint of a coordinate, in that coordinate's units */
  const footprint = (c: N): N => {
    const f = coordFilter(c);
    return f.x.max(f.y);
  };

  // domain warp: bends the bands off straight so they read as advected air
  // rather than as ruled lines (every "too regular / lattice" complaint in this
  // project, §B.33, is what a straight one would earn).
  const warpCoord = coord.mul(0.35) as N;
  const warpAmp = bandLimitAmplitude(
    float(NOISE_FEATURE),
    warpCoord.x,
    footprint(warpCoord),
  );
  const warped = vec2(
    coord.x,
    coord.y.add(
      mx_noise_float(vec3(warpCoord.x, warpCoord.y, zWarp)).mul(uWarp).mul(warpAmp),
    ),
  );

  // fbm, each octave faded on its OWN footprint against its OWN feature size.
  // mx_noise_float is zero-mean ⟹ amplitude→0 IS the octave's own mean
  // (§V.48b half b), the same argument the sail's antisymmetric seam ridge
  // rests on.
  let field = float(0) as N;
  /** resolution of the LOWEST octave — the last structure to go sub-pixel */
  let resolved = float(1) as N;
  OCTAVES.forEach((o, i) => {
    const c = warped.mul(o.freq) as N;
    const amp = bandLimitAmplitude(float(NOISE_FEATURE), c.x, footprint(c));
    if (i === 0) resolved = amp as N;
    field = field.add(mx_noise_float(vec3(c.x, c.y, zOff[i])).mul(o.amp).mul(amp)) as N;
  });
  field = field.div(OCTAVE_NORM) as N;

  // mask → shape. No edge function: clamp then pow, so the falloff is
  // asymmetric (firm shoulder, long diffuse tail) with nothing to alias.
  //
  // ...and then §V70's half, which the octave fades above do NOT cover: the
  // shape is a nonlinear function of the field, so the mean of the shape is
  // not the shape of the mean. Blend to the layer's own area-mean as the
  // structure dissolves, or the bands evaporate into a clean gap a few degrees
  // above the skyline instead of thinning into uniform veil. See bandShapeAt().
  const mask = field.mul(uContrast).add(uBias).clamp(0, 1);
  const shape = mix(uFarMean.clamp(0, 1), mask.pow(uGamma.max(1)), resolved);
  const cov = shape
    .mul(uCoverage.clamp(0, 1))
    .mul(horizonFade)
    .mul(aboveFade)
    .clamp(0, 1);

  // ── light ──────────────────────────────────────────────────────────────
  const lobe = ray.dot(uSunWorld).clamp(0, 1).pow(uForwardPower.max(1));
  const through = shape.mul(uOptical.max(0)).negate().exp();
  const thickness = mix(uThickFloor.clamp(0, 1), float(1), through);
  const sun = uSunLevel
    .max(0)
    .mul(uAmbientFrac.clamp(0, 1).add(uForwardGain.max(0).mul(lobe)))
    .mul(thickness)
    .clamp(0, 2);
  const sky = uSkyLevel
    .max(0)
    .mul(float(1).add(uHorizonLift.max(0).mul(up.oneMinus())))
    .clamp(0, 2);

  // honest depth: it drives the blur radius and the composite's near-soft /
  // far-sharp alpha ramp, and it is a coverage-weighted average once a cluster
  // shares the pixel — the band's 0.1-0.4 against a cluster's 3-6 moves it by
  // single-digit percent.
  const depthN = range.div(uMaxDist.max(1)).clamp(0, 1);

  material.outputNode = vec4(sun.mul(cov), sky.mul(cov), cov, depthN.mul(cov));
  applyPackedBlending(material);

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  quad.name = 'clouds/bands';
  quad.frustumCulled = false;
  // drawn first: the pack is additive so order cannot matter for the result,
  // but keeping the sheet behind the cores matches what it is
  quad.renderOrder = -1;

  return {
    quad,
    material,
    uSunWorld,
    uDrift,
    uAxis,
    /** push live params → uniforms (panel edits apply without a rebuild) */
    push(cp: CloudParams): void {
      uAltitude.value = cp.bandAltitude;
      uRange.value = cp.bandRange;
      uAboveFade.value = cp.bandAboveFade;
      uHorizonFade.value = cp.bandHorizonFade;
      uLength.value = cp.bandLength;
      uWidth.value = cp.bandWidth;
      uWarp.value = cp.bandWarp;
      uContrast.value = cp.bandContrast;
      uBias.value = cp.bandBias;
      uGamma.value = cp.bandGamma;
      uFarMean.value = cp.bandFarMean;
      uCoverage.value = cp.bandCoverage;
      uSunLevel.value = cp.bandSunLevel;
      uAmbientFrac.value = cp.bandAmbientFrac;
      uForwardGain.value = cp.bandForwardGain;
      uForwardPower.value = cp.bandForwardPower;
      uOptical.value = cp.bandOptical;
      uThickFloor.value = cp.bandThickFloor;
      uSkyLevel.value = cp.bandSkyLevel;
      uHorizonLift.value = cp.bandHorizonLift;
      uMaxDist.value = cp.maxCloudDist;
    },
    /**
     * Pin the quad to the camera frustum. Same construction as the composite
     * quad: only the DIRECTION through each fragment matters (the deck is
     * intersected analytically), so the distance is free and is chosen well
     * inside camera.far — nothing here can be clipped or sailed out of.
     */
    fitToCamera(camera: THREE.PerspectiveCamera, distance: number): void {
      const d = Math.max(1, distance);
      const height = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      const margin = 1.1;
      quad.scale.set(height * camera.aspect * margin, height * margin, 1);
      camera.getWorldPosition(quad.position);
      camera.getWorldQuaternion(quad.quaternion);
      quad.translateZ(-d);
    },
    dispose(): void {
      quad.geometry.dispose();
      material.dispose();
    },
  };
}

export type CloudBands = ReturnType<typeof createCloudBands>;
