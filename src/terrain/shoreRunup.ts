/**
 * Shore runup / swash (T33 — "waves lapping on the beach"), TSL only.
 *
 * WHAT THIS IS *NOT*: the water body itself. The ocean clipmap is one disc
 * that covers the islands too, it writes depth, and its FFT displacement
 * genuinely surges up and down the beach slope — the geometric waterline is
 * already correct and already §V8-consistent, and §V10's depth-compare
 * already breaks foam on it. Repainting a fake water plane on the sand would
 * fight all three.
 *
 * WHAT THIS IS: everything the ocean surface cannot know about the sand.
 *  - the swash TONGUE that overshoots still water and drains back, thinner
 *    and faster than the swell that launched it
 *  - the FOAM LINE riding that moving edge, plus the lace it strands behind
 *  - WET SAND MEMORY: the beach remembers the highest the water reached and
 *    dries back out over `dryTime`, so a retreating wave leaves a dark band
 *    that fades — the single cue that sells "a wave was just here"
 *
 * The still-water level comes in through the shared `waterline` uniform,
 * which the island drives per frame from the SAME CpuOcean mirror buoyancy
 * uses — so the painted bands breathe with the drawn sea instead of drifting
 * off it. Everything is analytic (no state texture, no extra pass): cost is a
 * handful of ALU ops and two value-noise taps in the sand fragment shader.
 *
 * All levels are METERS OF ELEVATION above the waterline. Elevation maps to
 * horizontal distance through the local beach slope for free: the flat apron
 * gets a long swash, a steep face a short slap.
 *
 * §V23: functional smoothstep/mix only. smoothstep(e0,e1,x) with e0 > e1 is a
 * DECREASING ramp (1 at/below e1, 0 at/above e0) — every such use is flagged.
 * §V28: every divisor floored.
 */
import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, uniform, vec2 } from 'three/tsl';
import { terrainParams } from '../params/terrain';
import { hash2, valueNoise2 } from './noise';

/** Live GPU uniforms mirroring the shore/swash section of terrainParams. */
export function createShoreUniforms() {
  const p = terrainParams;
  return {
    /** sim time (s) — pushed per frame, NOT the renderer clock (§V2/§V3) */
    time: uniform(0),
    // NOTE: the still-water level is NOT here — it is the sand material's
    // shared `waterline` uniform, so the static wet band and the swash can
    // never disagree about where the sea is.
    period: uniform(p.runupPeriod),
    riseFraction: uniform(p.runupRiseFraction),
    heightMin: uniform(p.runupHeightMin),
    heightMax: uniform(p.runupHeightMax),
    swellResponse: uniform(p.runupSwellResponse),
    /** swell AMPLITUDE (m) ≈ Hs/2, from the live sea state — see setSwell */
    swell: uniform(1),
    phaseScale: uniform(p.runupPhaseScale),
    sheetFeather: uniform(p.runupSheetFeather),
    sheetColor: uniform(new THREE.Color(p.sheetColor)),
    sheetStrength: uniform(p.sheetStrength),
    foamWidth: uniform(p.swashFoamWidth),
    foamColor: uniform(new THREE.Color(p.swashFoamColor)),
    foamStrength: uniform(p.swashFoamStrength),
    residualStrength: uniform(p.swashResidualStrength),
    foamNoiseScale: uniform(p.swashFoamNoiseScale),
    foamNoiseStrength: uniform(p.swashFoamNoiseStrength),
    dryTime: uniform(p.dryTime),
  };
}

export type ShoreUniforms = ReturnType<typeof createShoreUniforms>;

/** Copy current terrainParams values into the uniforms (call on change). */
export function updateShoreUniforms(u: ShoreUniforms): void {
  const p = terrainParams;
  u.period.value = p.runupPeriod;
  u.riseFraction.value = p.runupRiseFraction;
  u.heightMin.value = p.runupHeightMin;
  u.heightMax.value = p.runupHeightMax;
  u.swellResponse.value = p.runupSwellResponse;
  u.phaseScale.value = p.runupPhaseScale;
  u.sheetFeather.value = p.runupSheetFeather;
  u.sheetColor.value.setHex(p.sheetColor);
  u.sheetStrength.value = p.sheetStrength;
  u.foamWidth.value = p.swashFoamWidth;
  u.foamColor.value.setHex(p.swashFoamColor);
  u.foamStrength.value = p.swashFoamStrength;
  u.residualStrength.value = p.swashResidualStrength;
  u.foamNoiseScale.value = p.swashFoamNoiseScale;
  u.foamNoiseStrength.value = p.swashFoamNoiseStrength;
  u.dryTime.value = p.dryTime;
}

export interface ShoreNodes {
  /** 0..1 sand currently under the swash tongue */
  sheet: any;
  /** 0..1 damp sand — the drying memory of recent waves */
  wet: any;
  /** 0..1 foam: the line on the moving edge + the lace stranded behind it */
  foam: any;
  /** current swash edge elevation (m above the waterline) */
  level: any;
}

/**
 * Build the swash bands.
 * @param heightAbove elevation of this fragment above the live water level (m)
 * @param worldXZ     world XZ (vec2) — drives alongshore phase + foam lace
 */
export function buildShoreNodes(
  u: ShoreUniforms,
  heightAbove: any,
  worldXZ: any,
): ShoreNodes {
  // Alongshore phase: without this every beach on every island laps in
  // lockstep and the shoreline reads as one pulsing ring.
  const phase = valueNoise2(worldXZ.mul(u.phaseScale));

  const period = u.period.max(1e-3);
  const cycles = u.time.div(period).add(phase);
  const n = cycles.floor();
  const p = cycles.fract();

  // Set structure: consecutive waves differ, so some tongues run much further
  // up the sand than their neighbours (the reason a beach never looks metric).
  // mix(1, swell, response): response 0 ignores the sea, 1 scales linearly
  // with swell AMPLITUDE (≈Hs/2 ≈ 1.4 m in the default sea), so heavier
  // weather runs the tongue further up the sand for free.
  const ampScale = mix(float(1), u.swell.max(0), u.swellResponse);
  const ampOf = (k: any) =>
    mix(u.heightMin, u.heightMax, hash2(vec2(k, phase.mul(97))))
      .mul(ampScale);
  const a0 = ampOf(n);
  const a1 = ampOf(n.sub(1));
  const a2 = ampOf(n.sub(2));

  // Swash shape over one cycle: rush up in `rise`, drain back over the rest.
  // min(up, down) peaks at exactly 1 at p = rise.
  const rise = u.riseFraction.clamp(0.02, 0.95);
  const up = smoothstep(float(0), rise, p);
  // DECREASING ramp (e0=1 > e1=rise): 1 at p=rise, 0 at the end of the cycle
  const down = smoothstep(float(1), rise, p);
  const level = a0.mul(up.min(down));

  // Wet memory. `up` is the running maximum of the swash shape, so a0·up is
  // the highest this cycle has reached so far; earlier cycles' high-water
  // marks decay with the drying time constant. max() of the three = "where
  // water has been recently", which is precisely the dark band on a beach.
  const dry = u.dryTime.max(1e-3);
  const wet1 = a1.mul(p.mul(period).div(dry).negate().exp());
  const wet2 = a2.mul(p.add(1).mul(period).div(dry).negate().exp());
  const wetLevel = a0.mul(up).max(wet1).max(wet2);

  const feather = u.sheetFeather.max(1e-3);
  // DECREASING ramps: 1 below the level (submerged / damp), 0 above it
  const sheet = smoothstep(level, level.sub(feather), heightAbove);
  const wet = smoothstep(wetLevel, wetLevel.sub(feather.mul(2)), heightAbove);

  // Foam line on the moving edge + lace stranded on sand the water has left.
  const foamWidth = u.foamWidth.max(1e-3);
  // DECREASING ramp: 1 at the edge, 0 one band-width away from it
  const edge = smoothstep(foamWidth, float(0), heightAbove.sub(level).abs());
  const residual = wet.sub(sheet).max(0).mul(u.residualStrength);
  // break the band up so it reads as lace, never as a painted contour
  const lace = mix(
    u.foamNoiseStrength.oneMinus(),
    float(1),
    valueNoise2(worldXZ.mul(u.foamNoiseScale.max(1e-3))),
  );
  const foam = edge.max(residual).mul(lace).mul(u.foamStrength).clamp(0, 1);

  return { sheet, wet, foam, level };
}

// ---------------------------------------------------------------------------
// CPU MIRROR of the two behaviours above that are pure functions of the cycle
// phase. Same convention as noise.ts / noiseCpu.ts: the shader side cannot run
// under vitest, so the swash TIMING — rush up, drain back slower, sand
// remembers and dries — is pinned here. Change one side, change the other.
// Hash-driven per-cycle amplitudes are deliberately NOT mirrored: they are an
// input to these functions, not part of the timing contract.
// ---------------------------------------------------------------------------

const smoothstepCpu = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0 || 1e-9), 0), 1);
  return t * t * (3 - 2 * t);
};

/**
 * Swash tongue shape over one cycle phase p ∈ [0,1): 0 at the start, exactly
 * 1 at p = rise, back to 0 at the end. Mirrors `min(up, down)` above.
 */
export function swashShapeCpu(p: number, rise: number): number {
  const r = Math.min(Math.max(rise, 0.02), 0.95);
  return Math.min(smoothstepCpu(0, r, p), smoothstepCpu(1, r, p));
}

/**
 * Highest level the sand has "seen" at phase p, given this cycle's amplitude
 * and the two before it. `a0·up` is the running max within the current cycle;
 * older cycles decay with the drying time constant. Mirrors `wetLevel` above.
 */
export function wetLevelCpu(
  p: number,
  period: number,
  dryTime: number,
  rise: number,
  a0: number,
  a1: number,
  a2: number,
): number {
  const r = Math.min(Math.max(rise, 0.02), 0.95);
  const dry = Math.max(dryTime, 1e-3);
  const now = a0 * smoothstepCpu(0, r, p);
  const prev = a1 * Math.exp(-(p * period) / dry);
  const older = a2 * Math.exp(-((p + 1) * period) / dry);
  return Math.max(now, prev, older);
}
