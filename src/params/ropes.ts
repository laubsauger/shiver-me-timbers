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
  /** §V42 master switch: false → every rope is the static catenary.
   *  CURRENTLY OFF: the Verlet chain enforces EQUAL link lengths while the
   *  catenary it is seeded from is sampled uniformly in horizontal x, whose
   *  links vary 2.2× end to end — so the chain fights its own rest state and
   *  never settles. Fix in flight (per-link rest lengths); until it is
   *  verified in-browser the proven static solve ships. */
  dynamic: boolean;
  /** Verlet constraint passes per substep (startup-only: literal Loop bound) */
  constraintIterations: number;
  /** integration substeps per frame (startup-only: literal Loop bound) */
  substeps: number;
  /** gravity on rope particles (m/s²) — what makes a slack line hang and
   *  swing rather than glide */
  gravity: number;
  /** per-substep velocity retention, 0..1. Below ~0.9 the rope goes lifeless;
   *  at 1 it never settles */
  damping: number;
  /** acceleration (m/s²) imparted per m/s of wind — the rope is light, so
   *  wind moves it far more than it moves the ship */
  windForce: number;
  /** gust frequency (rad/s) and how much of the wind force it modulates */
  gustSpeed: number;
  gustDepth: number;
  /** leash: a particle may never stray further than this (m) from where the
   *  catenary says it belongs. Stability net AND first-frame seeding */
  maxStray: number;
  /** leash also scales with rope length: a long rope carries more sag, and
   *  reefing can pull several metres of it out at once (§V46). The effective
   *  leash is max(maxStray, strayFraction × rope length) */
  strayFraction: number;
  /** if an anchor moves further than this in one frame (m) the rope was
   *  re-anchored, not sailed — a mast breaking (§V14), a respawn. The chain
   *  is re-seeded from the new catenary instead of being snapped across the
   *  map by its constraints. Must exceed the fastest honest per-frame anchor
   *  travel: ~0.25 m at 15 m/s and 60 fps */
  teleportDistance: number;
  /** camera distance (m) beyond which a rope stops simulating and is drawn
   *  from the static catenary alone; `simFadeBand` is the blend either side */
  simDistance: number;
  simFadeBand: number;
  /** dark hemp albedo */
  colorHex: number;
  /** high roughness with a slight sheen left in the specular lobe */
  roughness: number;
  /** §V41 phone-wire AA: never draw a rope thinner than this many PIXELS —
   *  below ~1px a fixed-radius tube goes dashed and crawls. Alpha pays the
   *  widening back so the rope's energy is unchanged */
  aaMinWidthPx: number;
  /** projected width (px) at or below which the FAR regime owns the rope:
   *  simple translucent line, no normals, no lighting. Keep near 1px — below
   *  that shading detail is meaningless, above it the hero ship's own rigging
   *  starts going unlit at normal camera distance */
  farWidthPx: number;
  /** projected width (px) at or above which the NEAR shaded tube owns it;
   *  between the two the regimes crossfade. Must exceed farWidthPx */
  nearWidthPx: number;
  /** far regime is UNLIT, so its flat albedo must be scaled to sit at roughly
   *  the brightness the lit near tube averages, or the handover shows as a
   *  tonal seam while zooming. Needs a visual pass to land exactly */
  farLightness: number;
  /** cross-section faces for the FAR tube — the cheap regime (startup-only) */
  farRadialSegments: number;
  /** rigging block (pulley) mesh cap per ship — keep modest */
  maxBlocks: number;
  /** block height (m); width/depth scale from this (startup-only) */
  blockSize: number;
  /** weathered block wood albedo */
  blockColorHex: number;
}

const meta: Partial<Record<keyof RopeParams, ParamMeta>> = {
  segmentsPerRope: { min: 4, max: 64, step: 1 },
  radialSegments: { min: 3, max: 12, step: 1 },
  slackFactor: { min: 1, max: 2, step: 0.01 },
  defaultThickness: { min: 0.005, max: 0.2, step: 0.005 },
  constraintIterations: { min: 1, max: 16, step: 1 },
  substeps: { min: 1, max: 4, step: 1 },
  gravity: { min: 0, max: 30, step: 0.1 },
  damping: { min: 0.8, max: 1, step: 0.001 },
  windForce: { min: 0, max: 4, step: 0.01 },
  gustSpeed: { min: 0, max: 4, step: 0.01 },
  gustDepth: { min: 0, max: 1, step: 0.01 },
  maxStray: { min: 0.05, max: 5, step: 0.05 },
  strayFraction: { min: 0, max: 1, step: 0.01 },
  teleportDistance: { min: 0.5, max: 20, step: 0.1 },
  simDistance: { min: 10, max: 500, step: 5 },
  simFadeBand: { min: 1, max: 200, step: 1 },
  roughness: { min: 0, max: 1, step: 0.01 },
  aaMinWidthPx: { min: 0.5, max: 4, step: 0.05 },
  farWidthPx: { min: 0.5, max: 8, step: 0.1 },
  nearWidthPx: { min: 1, max: 16, step: 0.1 },
  farLightness: { min: 0.5, max: 2.5, step: 0.05 },
  farRadialSegments: { min: 3, max: 8, step: 1 },
  maxBlocks: { min: 0, max: 64, step: 1 },
  blockSize: { min: 0.1, max: 0.6, step: 0.01 },
};

export const ropeParams: RopeParams = registerParams(
  'ropes',
  {
    segmentsPerRope: 16,
    radialSegments: 6,
    slackFactor: 1.06,
    defaultThickness: 0.035,
    dynamic: false,
    constraintIterations: 8,
    substeps: 2,
    gravity: 9.81,
    damping: 0.985,
    windForce: 0.6,
    gustSpeed: 0.7,
    gustDepth: 0.45,
    maxStray: 1.2,
    strayFraction: 0.25,
    teleportDistance: 2,
    simDistance: 120,
    simFadeBand: 40,
    colorHex: 0x4a3826,
    roughness: 0.72,
    aaMinWidthPx: 1,
    farWidthPx: 1,
    nearWidthPx: 2,
    farLightness: 1.15,
    farRadialSegments: 3,
    maxBlocks: 20,
    blockSize: 0.25,
    blockColorHex: 0x5a4632,
  },
  meta,
);
