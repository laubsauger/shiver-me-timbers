/**
 * Rope rigging tunables (§V16: every tunable in a params module, no shader
 * magic constants). Consumed by src/ropes/* (§V12 catenary compute + render).
 * `segmentsPerRope` / `radialSegments` are startup-only: they size the storage
 * buffers and instanced geometry, so changing them live has no effect until
 * the ropes system is recreated. Everything else is live via uniforms.
 */
import { registerParams, type ParamMeta } from './registry';

export interface RopeParams {
  /** curve samples per rope = tube segments per rope (startup-only) */
  segmentsPerRope: number;
  /** tube cross-section face count (startup-only) */
  radialSegments: number;
  /** default rope length = chord × slackFactor when setRope gets no length */
  slackFactor: number;
  /** default tube radius (m) when setRope gets no thickness */
  defaultThickness: number;
  /** wind sway: perpendicular offset amplitude (m), zero at anchors */
  swayAmplitude: number;
  /** wind sway oscillation speed (rad/s) */
  swaySpeed: number;
  /** sway phase offset per rope index (rad) — decorrelates neighbouring ropes */
  swayPhaseStep: number;
  /** dark hemp albedo */
  colorHex: number;
  /** high roughness with a slight sheen left in the specular lobe */
  roughness: number;
}

const meta: Partial<Record<keyof RopeParams, ParamMeta>> = {
  segmentsPerRope: { min: 4, max: 64, step: 1 },
  radialSegments: { min: 3, max: 12, step: 1 },
  slackFactor: { min: 1, max: 2, step: 0.01 },
  defaultThickness: { min: 0.005, max: 0.2, step: 0.005 },
  swayAmplitude: { min: 0, max: 0.5, step: 0.005 },
  swaySpeed: { min: 0, max: 8, step: 0.05 },
  swayPhaseStep: { min: 0, max: 6.28, step: 0.01 },
  roughness: { min: 0, max: 1, step: 0.01 },
};

export const ropeParams: RopeParams = registerParams(
  'ropes',
  {
    segmentsPerRope: 16,
    radialSegments: 6,
    slackFactor: 1.06,
    defaultThickness: 0.035,
    swayAmplitude: 0.06,
    swaySpeed: 1.2,
    swayPhaseStep: 2.399, // ≈ golden angle: no two ropes share a phase
    colorHex: 0x4a3826,
    roughness: 0.72,
  },
  meta,
);
