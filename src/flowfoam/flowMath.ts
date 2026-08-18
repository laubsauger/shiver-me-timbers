/**
 * Pure CPU mirrors of the flow-foam GPU math (§V10) — ZERO three imports so
 * tests/flowfoam.test.ts runs in node without a GPU (same mirror contract as
 * deckwater/fluxMath.ts and foam/foamMath.ts). GPU twins:
 *   flowVectorCpu          ↔ flowNoise.flowVectorNode
 *   uvForWorld/worldForUv  ↔ accumulation advect pass texel↔world math
 *   regionShiftUv          ↔ uShift uniform consumed by the advect lookup
 *   advectLookupUv         ↔ backward semi-Lagrangian source uv
 * Change one side → change the other. CPU runs f64, GPU f32: structurally
 * identical, not bit-exact; properties (determinism, divergence, anchoring)
 * carry over.
 *
 * REGION UV CONVENTION (single source of truth):
 *   u = (wx − cx) / size + 0.5
 *   v = (cz − wz) / size + 0.5      ← v axis is FLIPPED vs world +z
 * because the injection ortho camera looks down −Y with up = (0, 0, −1)
 * (camera x = world +x, camera y = world −z), so RT v grows toward −z.
 *
 * REGION-SHIFT MATH: when the region recenters prevC → c, the same world
 * point w moves in uv space:
 *   uPrev − uCur = (cx − prevCx) / size
 *   vPrev − vCur = (prevCz − cz) / size   (v flip)
 * The advect pass reads PREVIOUS-frame foam whose texels are anchored at
 * prevC, so the lookup ADDS this shift to the current uv — foam stays pinned
 * to the world while the texture window slides under it. setCenter snaps to
 * whole texels (snapToTexel) so the shift is an exact texel offset and a
 * standing foam patch is never blurred by fractional resampling.
 */
import { fbm2Cpu } from '../terrain/noiseCpu';

/** fbm octave count of the flow potential — build constant (unrolls in TSL) */
export const FLOW_OCTAVES = 2;

/** subset of FlowFoamParams the flow field needs (pure, structural) */
export interface FlowFieldParams {
  noiseScale: number;
  noiseStrength: number;
  noiseScrollSpeed: number;
  baseFlowSpeed: number;
  curlStep: number;
}

/**
 * Scalar flow potential ψ: low-frequency fbm scrolled along the base flow
 * direction over time, so eddies ride downstream with the current.
 */
export function flowPotentialCpu(
  x: number,
  z: number,
  time: number,
  dirX: number,
  dirZ: number,
  p: FlowFieldParams,
): number {
  const nx = (x - dirX * time * p.noiseScrollSpeed) * p.noiseScale;
  const nz = (z - dirZ * time * p.noiseScrollSpeed) * p.noiseScale;
  return fbm2Cpu(nx, nz, FLOW_OCTAVES);
}

/**
 * Pseudo-curl flow vector: two offset ψ samples give forward-difference
 * gradients; rotating the gradient 90° → v = (∂ψ/∂z, −∂ψ/∂x) is a discrete
 * curl, divergence-free by construction for the matching stencil (tests
 * verify) — advected foam swirls instead of piling into sinks or tearing
 * holes. A uniform base flow (dir · baseFlowSpeed) drifts it downstream.
 */
export function flowVectorCpu(
  x: number,
  z: number,
  time: number,
  dirX: number,
  dirZ: number,
  p: FlowFieldParams,
  /** multiplies only the curl/eddy part (GPU feeds local foam-driven churn) */
  curlScale = 1,
): [number, number] {
  const e = p.curlStep;
  const p0 = flowPotentialCpu(x, z, time, dirX, dirZ, p);
  const px = flowPotentialCpu(x + e, z, time, dirX, dirZ, p);
  const pz = flowPotentialCpu(x, z + e, time, dirX, dirZ, p);
  const dpdx = (px - p0) / e;
  const dpdz = (pz - p0) / e;
  const k = p.noiseStrength * curlScale;
  return [
    dpdz * k + dirX * p.baseFlowSpeed,
    -dpdx * k + dirZ * p.baseFlowSpeed,
  ];
}

/** world XZ → region uv (see header convention; v flips world z) */
export function uvForWorld(
  wx: number,
  wz: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [(wx - cx) / size + 0.5, (cz - wz) / size + 0.5];
}

/** region uv → world XZ (inverse of uvForWorld) */
export function worldForUv(
  u: number,
  v: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [cx + (u - 0.5) * size, cz - (v - 0.5) * size];
}

/** uv offset ADDED to a current-region uv to find the same world point in the previous region (see header math) */
export function regionShiftUv(
  prevCx: number,
  prevCz: number,
  cx: number,
  cz: number,
  size: number,
): [number, number] {
  return [(cx - prevCx) / size, (prevCz - cz) / size];
}

/* -------------------------------------------------------------------------
 * THE BLUR WAS A FRAME QUANTITY *AND* A GRID QUANTITY (§V2, §B).
 *
 * The 3×3 blur ran once per RENDER frame at a fixed `blurMix` 0.35 while the
 * decay next to it used `decayFactorPerFrame`. So diffusion was proportional
 * to frame rate: a 60 fps session spread foam 13× further per SECOND than the
 * 4.6 fps session the tuning was measured in, and the wake looked different on
 * a 144 Hz monitor than a 60 Hz one and different again under GPU contention.
 * That is the same defect §V2 pins for the sim tick, in a compute pass.
 *
 * It was a GRID quantity too, and that half was larger. Variance per step is
 * `mix · 0.5 · radius² · texel²`, so ONE shared `blurMix` across two tiers
 * whose texels are 0.234 m and 2.5 m diffused the far tier (2.5/0.234)² = 114×
 * faster in WORLD terms. Measured: at 60 fps the far tier reached σ = 33.7 m
 * over its own mean visible lifetime — wider than the bright core of the trail
 * it was carrying, which is why the far field read as a smeared band and why
 * every CPU model in tests/flowfoam.test.ts (none of which diffuse at all)
 * predicted several times the coverage the GPU actually held.
 *
 * Foam spreading is ONE physical process with ONE world rate — exactly the
 * lesson foamMath's `blurMixPerStep` header records for the whitecap cascades.
 * The difference here is that the two tiers hold the same foam at DIFFERENT
 * AGES (5 s vs 12 s half-life), so they must share a diffusion RATE and reach
 * different spreads, rather than share a spread as the cascades do.
 * ---------------------------------------------------------------------- */

/**
 * Per-step 3×3 kernel weight that diffuses at a fixed WORLD rate over a fixed
 * time, whatever the texel size and whatever the frame took.
 *
 * `spreadPerRootSecond` is the gaussian σ in metres the foam reaches after ONE
 * second, so σ(t) = spread·√t (variances add linearly in time — that is what
 * makes a diffusion a diffusion, and why the knob is per-√second rather than
 * per-second). The implied diffusivity is D = spread² m²/s.
 *
 * A 1-D (1,2,1)/4 kernel at a tap offset of `radius` texels has variance
 * 0.5·radius² texels²; mixing it with the identity at weight w gives exactly
 * w× that. Setting the variance laid down in one step equal to D·dt gives
 * w = spread²·dt / (0.5·radius²·texel²).
 *
 * CLAMPED AT 1, which is a real limit and not a guard: one 3×3 tap cannot move
 * foam further than its own kernel however long the frame was, so below
 * ~21 fps the near tier saturates and diffuses SLOWER than the world rate asks.
 * That is bounded and monotone rather than proportional-to-fps, which is the
 * whole point, but it does mean a heavily contended session under-diffuses —
 * sub-stepping the pass would be the fix if that ever matters visually.
 */
export function blurMixForDt(
  spreadPerRootSecond: number,
  texelMetres: number,
  radius: number,
  dt: number,
): number {
  const perStep = 0.5 * radius * radius * texelMetres * texelMetres;
  if (!(perStep > 0) || !(dt > 0) || !Number.isFinite(dt)) return 0;
  // NaN fails every comparison, so Math.max(0, NaN) is NaN — guard the
  // numerator explicitly or one bad uniform poisons the kernel weight (§V28)
  if (!Number.isFinite(spreadPerRootSecond)) return 0;
  const w = (Math.max(0, spreadPerRootSecond) ** 2 * dt) / perStep;
  return Math.min(1, Math.max(0, w));
}

/**
 * Gaussian σ (m) the diffusion reaches over `seconds` — σ = spread·√t. Used by
 * the tests to state the far tier's smear as a LENGTH against the width of the
 * trail it is carrying, rather than as a kernel weight.
 */
export function blurSpreadOver(spreadPerRootSecond: number, seconds: number): number {
  if (!(seconds > 0) || !Number.isFinite(seconds)) return 0;
  if (!Number.isFinite(spreadPerRootSecond)) return 0;
  return Math.max(0, spreadPerRootSecond) * Math.sqrt(seconds);
}

/** snap a center coordinate to the texel grid (size/res) — exact-texel shifts */
export function snapToTexel(c: number, size: number, res: number): number {
  const texel = size / res;
  return Math.round(c / texel) * texel;
}

/**
 * Backward semi-Lagrangian source uv: where the foam now at (u, v) came
 * from = current world position minus flow·dt, plus the region shift.
 * v moves OPPOSITE to world z (uv convention above).
 */
export function advectLookupUv(
  u: number,
  v: number,
  vx: number,
  vz: number,
  advectDt: number,
  size: number,
  shiftU: number,
  shiftV: number,
): [number, number] {
  return [
    u - (vx * advectDt) / size + shiftU,
    v + (vz * advectDt) / size + shiftV,
  ];
}

/**
 * Weight of the COARSE far foam tier at `dist` metres from the near region's
 * centre. 0 inside the near window, ramping to 1 by the time the near region
 * starts fading at its border.
 *
 * WHY A CROSSFADE AND NOT max(): the two tiers hold the same wake at different
 * scales, and the far one — long decay, 2.5 m texels, no flow advection — is
 * smooth. Taken as a plain max it out-reads the near tier's actual structure a
 * few tens of metres astern and paints over exactly the detail the near tier
 * exists to provide. The far tier's only job is to carry the trail PAST the
 * near window, so it must be silent inside it.
 *
 * The ramp ends where the near region's own `edgeFade` begins, so the far tier
 * is at full weight precisely as the near one fades out — no seam, no gap.
 */
/**
 * RADIAL region edge fade. Replaces the old product of two per-axis
 * smoothsteps, which faded over a SQUARE and therefore ended in straight
 * lines — the user saw the near region's border directly: "a straight straight
 * hard line cutoff whenever our wake disappears behind us". A circular falloff
 * cannot produce a straight edge at any camera angle.
 *
 * Note this is the WINDOW's fade only. It must never be what actually ends the
 * wake — the wake has to have dissipated on its own well before it reaches the
 * border, or the window clips a still-bright trail and no amount of softening
 * hides it.
 */
export function regionEdgeFadeCpu(
  dx: number,
  dz: number,
  size: number,
  edgeFade: number,
): number {
  const outer = size * 0.5;
  const inner = Math.max(outer * (1 - edgeFade), 1e-6);
  const d = Math.hypot(dx, dz);
  const t = Math.min(1, Math.max(0, (d - outer) / (inner - outer)));
  return t * t * (3 - 2 * t);
}

export function farBlendWeightCpu(
  dist: number,
  nearSize: number,
  blendStart: number,
  edgeFade: number,
): number {
  const e0 = nearSize * blendStart;
  const e1 = Math.max(nearSize * 0.5 * (1 - edgeFade), e0 + 1e-6);
  const t = Math.min(1, Math.max(0, (dist - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
