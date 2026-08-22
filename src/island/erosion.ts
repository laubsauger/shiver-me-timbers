/**
 * EROSION + MACRO FORM pass stage (T112c, §V94). Pure CPU, ZERO three
 * imports — tests/erosion.test.ts drives it on synthetic fields.
 *
 * heightmap.ts composes the archetype analytically (the UPLIFT mask) and
 * then hands the grid here. The stage is an ORDERED LIST OF PASSES run on a
 * bedrock + debris field:
 *
 *   bedrockSheeting  glacial shear along the per-island ice vector (stoss
 *                    long and gentle, lee short and steep — a roche
 *                    moutonnée), then curvature-masked sheeting steps
 *                    measured along the surface normal (Martel 2006: sheet
 *                    joints form where the surface is CONVEX, never in the
 *                    concave; the step mask is joint-density noise × lee
 *                    bias, so the stoss flank is polished and the lee flank
 *                    is plucked)
 *   streamPower      Schott-style uplift/erosion iterations — see
 *                    erosionStream.ts (owns the ridge + cirque silhouettes;
 *                    off for the dome by default)
 *   rockfallThermal  steep bedrock sheds into the debris layer; the debris
 *                    settles at tan 35° — see erosionThermal.ts
 *   (carve)          T112b's path carve goes HERE: insertPassBefore(passes,
 *                    'thermalSmooth', carvePass)
 *   thermalSmooth    bedrock thermal at a steep repose: kills one-cell
 *                    spikes left by the channels
 *   floodAtSeaLevel  no cell that started as land ends under the sea unless
 *                    it is lagoon-masked (an inland pit would show the ocean
 *                    plane through it)
 *
 * CHUNKED: `erodeAndShape` returns a bake whose `step(msBudget)` runs pass
 * steps until the budget is spent (always at least one), so a loader can
 * yield between frames; `finish()` runs it out. One code path, so chunked
 * and one-shot are byte-identical. `stats` carries performance.now() timings
 * per pass (no console output).
 *
 * Everything is masked by `erodible` (0 through the DG-sand band, 1 above
 * `erodeBandStart + erodeBandWidth`): the beach is §V90's and erosion never
 * touches it.
 */
import { swissTurbulence2Cpu, valueNoise2Cpu } from '../terrain/noiseCpu';
import type { SierraParams } from '../params/sierra';
// the pass modules import only TYPES from here, so this is not a runtime cycle
import { streamPowerPass } from './erosionStream';
import { rockfallThermalPass, thermalSmoothPass } from './erosionThermal';

export interface ErosionField {
  size: number;
  /** metres per cell */
  cell: number;
  bedrock: Float64Array;
  debris: Float64Array;
}

export interface ErosionContext {
  size: number;
  cell: number;
  seaLevel: number;
  /** the family's peak (m) — normalises the shear */
  peak: number;
  /** unit ice-flow vector (island-local x, z): stoss is upstream of it */
  ice: [number, number];
  /** archetype uplift mask 0..1 per cell */
  uplift: Float64Array;
  /** the field as handed in (flood reads "was land" off it) */
  h0: Float64Array;
  /** 0..1: where the passes may act (beach guard) */
  erodible: Float64Array;
  /** 0..1 joint-density noise: close joints = plucked, wide = whaleback */
  joint: Float64Array;
  /** plate-wise sheet offset noise (fraction of a sheet) */
  plate: Float64Array;
  /** cells allowed to end below sea level (null = none) */
  lagoonMask: Uint8Array | null;
  p: SierraParams;
  /** per-archetype stream-power iteration count */
  streamIters: number;
  /** double-buffer scratch, size² */
  scratch: Float64Array;
}

export interface ErosionPass {
  name: string;
  /** how many advance() calls this pass takes (0 = skipped) */
  steps: number;
  advance(field: ErosionField, ctx: ErosionContext, i: number): void;
}

export interface BakeStats {
  size: number;
  totalMs: number;
  passes: { name: string; steps: number; ms: number }[];
}

export interface ErosionBake {
  /** run pass steps until `msBudget` ms elapsed (≥ 1 step); true when finished */
  advance(msBudget: number): boolean;
  /** run everything remaining */
  finish(): void;
  readonly done: boolean;
  readonly stats: BakeStats;
}

const smoothstep01 = (t: number): number => {
  const c = Math.min(Math.max(t, 0), 1);
  return c * c * (3 - 2 * c);
};

/** build the per-cell masks from the island's seeded noise offsets */
export function buildErosionContext(opts: {
  size: number;
  cell: number;
  worldRadius: number;
  peak: number;
  iceAzimuth: number;
  uplift: Float64Array;
  h0: Float64Array;
  noiseOffset: [number, number];
  p: SierraParams;
  streamIters: number;
  lagoonMask?: Uint8Array | null;
  seaLevel?: number;
}): ErosionContext {
  const { size, cell, p } = opts;
  const n = size * size;
  const erodible = new Float64Array(n);
  const joint = new Float64Array(n);
  const plate = new Float64Array(n);
  const R = opts.worldRadius;
  const [ox, oz] = opts.noiseOffset;
  const bw = Math.max(p.erodeBandWidth, 1e-3); // §V28 floored divisor
  const plateScale = 1 / Math.max(p.sheetPlateSize, 1e-3);
  for (let iz = 0; iz < size; iz++) {
    const z = -R + iz * cell;
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      const x = -R + ix * cell;
      erodible[i] = smoothstep01((opts.h0[i] - p.erodeBandStart) / bw);
      joint[i] = swissTurbulence2Cpu(x * p.jointScale + ox, z * p.jointScale + oz, 3);
      plate[i] = valueNoise2Cpu(x * plateScale + oz, z * plateScale + ox);
    }
  }
  return {
    size,
    cell,
    seaLevel: opts.seaLevel ?? 0,
    peak: Math.max(opts.peak, 1e-3),
    ice: [Math.cos(opts.iceAzimuth), Math.sin(opts.iceAzimuth)],
    uplift: opts.uplift,
    h0: opts.h0,
    erodible,
    joint,
    plate,
    lagoonMask: opts.lagoonMask ?? null,
    p,
    streamIters: opts.streamIters,
    scratch: new Float64Array(n),
  };
}

/** bilinear sample of a grid at fractional cell coords, clamped */
function sampleGrid(g: Float64Array, size: number, gx: number, gz: number): number {
  const cx = Math.min(Math.max(gx, 0), size - 1);
  const cz = Math.min(Math.max(gz, 0), size - 1);
  const x0 = Math.min(Math.floor(cx), size - 2);
  const z0 = Math.min(Math.floor(cz), size - 2);
  const fx = cx - x0;
  const fz = cz - z0;
  const a = g[z0 * size + x0] + (g[z0 * size + x0 + 1] - g[z0 * size + x0]) * fx;
  const b = g[(z0 + 1) * size + x0] + (g[(z0 + 1) * size + x0 + 1] - g[(z0 + 1) * size + x0]) * fx;
  return a + (b - a) * fz;
}

/**
 * GLACIAL SHEAR: every cell reads its height from `iceShear · h/peak` metres
 * UPSTREAM, so the form is dragged downstream — the crest moves toward the
 * lee, the stoss flank lengthens (gentler) and the lee shortens (steeper).
 * Zero at the waterline (shift ∝ h), so the shoreline does not move.
 */
export function glacialShearStep(field: ErosionField, ctx: ErosionContext): void {
  const { size, cell, bedrock } = field;
  const out = ctx.scratch;
  const [ix0, iz0] = ctx.ice;
  const k = ctx.p.iceShear / (ctx.peak * cell);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const i = iz * size + ix;
      const s = Math.max(bedrock[i], 0) * k * ctx.erodible[i];
      out[i] = s > 0 ? sampleGrid(bedrock, size, ix - ix0 * s, iz - iz0 * s) : bedrock[i];
    }
  }
  bedrock.set(out);
}

/**
 * SHEETING: where the (blurred) surface is convex, quantise the height
 * MEASURED ALONG THE NORMAL (h·cosθ, the perpendicular sheet thickness)
 * into `sheetThickness` onion steps with a smooth riser and a plate-wise
 * offset, weighted by joint density and the lee bias. Concave ground
 * (curvature ≤ 0) is left byte-identical — Martel's rule.
 */
export function sheetingStep(field: ErosionField, ctx: ErosionContext): void {
  const { size, cell, bedrock } = field;
  const { p } = ctx;
  const blur = ctx.scratch;
  // Box blur so the curvature reads the FORM, not the detail noise — that was
  // always the intent of this blur, but its radius was ONE CELL (§T.130). At
  // 256² on a 250 m island a cell is 1.96 m, so "curvature" was measured over
  // 4 m and the mask read the surface-detail fbm's own convexities (its finest
  // octave is 3.6 m) rather than the landform's: it fired across the whole
  // island instead of on the noses Martel's rule is about. `sheetCurvatureBlur`
  // metres of separable box, squared (two passes ≈ a triangle kernel), puts it
  // back on the form's scale. Measured on the dome at 256²: rms|∇h| over the
  // land 0.51 → 0.46 with the same silhouette, i.e. the steps stop being
  // sprayed over flat ground. (It does NOT change the sheeting's own
  // wavelength, which is `sheetThickness` / slope — see that knob's note.)
  const rad = Math.max(1, Math.round(ctx.p.sheetCurvatureBlur / Math.max(cell, 1e-3)));
  const tmp = new Float64Array(size * size);
  const w = 1 / (2 * rad + 1);
  let src: Float64Array = bedrock;
  for (let pass = 0; pass < 2; pass++) {
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        let s = 0;
        for (let k = -rad; k <= rad; k++) s += src[iz * size + Math.min(Math.max(ix + k, 0), size - 1)];
        tmp[iz * size + ix] = s * w;
      }
    }
    for (let iz = 0; iz < size; iz++) {
      for (let ix = 0; ix < size; ix++) {
        let s = 0;
        for (let k = -rad; k <= rad; k++) s += tmp[Math.min(Math.max(iz + k, 0), size - 1) * size + ix];
        blur[iz * size + ix] = s * w;
      }
    }
    src = blur;
  }
  const T = Math.max(p.sheetThickness, 1e-3); // §V28 floored divisor
  const rf = Math.min(Math.max(p.sheetRiser, 0.05), 0.95);
  const curvScale = Math.max(p.sheetCurvature, 1e-6);
  const inv2 = 1 / (2 * cell);
  const invC2 = 1 / (cell * cell);
  const [ix0, iz0] = ctx.ice;
  const out = new Float64Array(size * size);
  out.set(bedrock);
  // In from the border by the BLUR'S OWN REACH: the clamped blur flattens the
  // field outward, which reads as a false convexity, so the contaminated
  // margin grows with `sheetCurvatureBlur` (§T.130 — at one cell it was two
  // cells, and pinned as such). The border is under the rim envelope anyway.
  const margin = Math.min(Math.max(2, 2 * rad), (size >> 1) - 1);
  for (let iz = margin; iz < size - margin; iz++) {
    for (let ix = margin; ix < size - margin; ix++) {
      const i = iz * size + ix;
      const e = ctx.erodible[i];
      if (e <= 0) continue;
      const lap = (blur[i + 1] + blur[i - 1] + blur[i + size] + blur[i - size] - 4 * blur[i]) * invC2;
      const convex = smoothstep01(-lap / curvScale);
      if (convex <= 0) continue;
      const gx = (blur[i + 1] - blur[i - 1]) * inv2;
      const gz = (blur[i + size] - blur[i - size]) * inv2;
      const g = Math.hypot(gx, gz);
      // lee = the downhill direction agrees with the ice flow
      const leeW = g > 1e-6 ? 0.5 - (0.5 * (gx * ix0 + gz * iz0)) / g : 0.5;
      const leeBias = p.sheetStossFactor + (1 - p.sheetStossFactor) * leeW;
      const mask = convex * e * leeBias * (0.35 + 0.65 * ctx.joint[i]);
      const cosT = 1 / Math.sqrt(1 + g * g);
      const h = bedrock[i];
      const q = h * cosT;
      const off = ctx.plate[i] * T;
      const kk = (q - off) / T;
      const stepI = Math.floor(kk);
      const f = kk - stepI;
      const riserT = smoothstep01((f - (1 - rf)) / rf);
      const Q = off + (stepI + riserT) * T;
      // the correction is applied VERTICALLY at the normal-space amount, so a
      // cell never moves more than half a sheet — dividing by cosθ would
      // inflate it without bound on a steep wall (measured +9.5 m on a cirque)
      out[i] = h + (Q - q) * mask;
    }
  }
  bedrock.set(out);
}

export function bedrockSheetingPass(): ErosionPass {
  return {
    name: 'bedrockSheeting',
    steps: 2,
    advance(field, ctx, i) {
      if (i === 0) glacialShearStep(field, ctx);
      else sheetingStep(field, ctx);
    },
  };
}

/** cells that were land and are not lagoon-masked are held at ≥ floodFloor */
export function floodStep(field: ErosionField, ctx: ErosionContext): void {
  const { bedrock, debris } = field;
  const floor = ctx.seaLevel + ctx.p.floodFloor;
  for (let i = 0; i < bedrock.length; i++) {
    if (ctx.h0[i] <= ctx.seaLevel) continue;
    if (ctx.lagoonMask && ctx.lagoonMask[i]) continue;
    const total = bedrock[i] + debris[i];
    if (total < floor) bedrock[i] = floor - debris[i];
  }
}

export function floodPass(): ErosionPass {
  return { name: 'floodAtSeaLevel', steps: 1, advance: floodStep };
}

/** the default order; T112b inserts its carve before 'thermalSmooth' */
export function defaultErosionPasses(ctx: ErosionContext): ErosionPass[] {
  const { p } = ctx;
  return [
    bedrockSheetingPass(),
    streamPowerPass(ctx.streamIters),
    rockfallThermalPass(p.thermalIters),
    thermalSmoothPass(p.smoothIters),
    floodPass(),
  ];
}

/** insert `pass` before the pass named `before` (throws if absent — fail loud) */
export function insertPassBefore(passes: ErosionPass[], before: string, pass: ErosionPass): void {
  const k = passes.findIndex((q) => q.name === before);
  if (k < 0) throw new Error(`insertPassBefore: no pass named "${before}"`);
  passes.splice(k, 0, pass);
}

export function erodeAndShape(
  field: ErosionField,
  ctx: ErosionContext,
  passes: ErosionPass[] = defaultErosionPasses(ctx),
): ErosionBake {
  const stats: BakeStats = {
    size: field.size,
    totalMs: 0,
    passes: passes.map((q) => ({ name: q.name, steps: q.steps, ms: 0 })),
  };
  let pi = 0;
  let si = 0;
  let finished = false;
  const advance = (): boolean => {
    while (pi < passes.length && si >= passes[pi].steps) {
      pi++;
      si = 0;
    }
    if (pi >= passes.length) {
      finished = true;
      return true;
    }
    const t0 = performance.now();
    passes[pi].advance(field, ctx, si);
    const dt = performance.now() - t0;
    stats.passes[pi].ms += dt;
    stats.totalMs += dt;
    si++;
    return false;
  };
  const bake: ErosionBake = {
    get done() {
      return finished;
    },
    get stats() {
      return stats;
    },
    advance(msBudget) {
      const t0 = performance.now();
      do {
        if (advance()) return true;
      } while (performance.now() - t0 < msBudget);
      return advance();
    },
    finish() {
      while (!advance()) {
        /* run out */
      }
    },
  };
  return bake;
}

