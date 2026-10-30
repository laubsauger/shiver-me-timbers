/**
 * THE FRONT'S SHAPE, on the CPU and the GPU alike (waveFx.ts is its TSL twin, sky.ts draws it).
 *
 * The wave's front is the circle at angle θ from the dome front that sweeps to the back (timeline.ts waveSweep).
 * Its edge is ragged — a perfect circle reads as a wipe, a ragged one as a physical front — and the raggedness has
 * to be the SAME function everywhere the front matters: the CPU decides when each pair dies on it (field.ts), the
 * GPU decides when each trail, mote and puff it passes freezes and starts to cool (waveFx.ts frontTime), and the sky
 * draws its light (sky.ts). Before this the sky's edge was GPU Perlin noise the CPU could not evaluate, so the
 * light and the deaths were up to ~7° apart; now the rag is a short sum of sines of the direction, cheap on both.
 *
 * `frac` is the front's progress (0 at the dome front, 1 at the back) at which it reaches a direction: θ/π plus the
 * rag. The rag's amplitude is in those units (0.03 ≈ 5.4°).
 */
import type { Vec3 } from '../../cine/domeMaster';

/** three fixed unit directions and wave numbers (1/rad-ish) the rag's sines run along, and their phases */
export const RAG_DIRS: readonly Vec3[] = [
  [0.48, 0.71, -0.51],
  [-0.77, 0.21, 0.6],
  [0.29, -0.86, 0.42],
];
export const RAG_K = [4.3, 8.9, 16.7] as const;
export const RAG_PHASE = [1.3, 0.4, 2.1] as const;
export const RAG_AMP = [1, 0.55, 0.3] as const;
/** frac units, the rag's largest excursion (the weights above sum to 1.85) */
export const RAG = 0.03;

export function frontRagCpu(d: Vec3): number {
  let s = 0;
  for (let i = 0; i < 3; i++) {
    const a = RAG_DIRS[i];
    s += RAG_AMP[i] * Math.sin(RAG_K[i] * (a[0] * d[0] + a[1] * d[1] + a[2] * d[2]) + RAG_PHASE[i]);
  }
  return (RAG * s) / 1.85;
}

/** 0..1 the front's progress when it reaches direction `d` (any length) from the eye; `front` the dome front (unit) */
export function frontFracCpu(d: Vec3, front: Vec3): number {
  const l = Math.hypot(d[0], d[1], d[2]) || 1;
  const n: Vec3 = [d[0] / l, d[1] / l, d[2] / l];
  const c = Math.max(-1, Math.min(1, n[0] * front[0] + n[1] * front[1] + n[2] * front[2]));
  return Math.min(1, Math.max(0, Math.acos(c) / Math.PI + frontRagCpu(n)));
}
