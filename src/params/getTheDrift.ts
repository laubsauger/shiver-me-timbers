/**
 * The Drift, Act 2 "Get the Drift", part A: from the first stars to Earth (drift.html, after Undertime).
 * Direction: /Users/flo/work/code/drift-narrative/get-the-drift/direction.md. Beat lengths in seconds:
 *
 *   galaxies  the web's knots open into galaxies; we drift among them toward one
 *   ours      that one is ours: we glide down onto its disk
 *   band      inside: the Milky Way arcs over the dome
 *   sun       one star ahead brightens into the Sun
 *   earth     a blue point becomes Earth at dawn, seen from high above
 *
 * Distances are in Undertime's world units (the galaxies sit where its web's knots ended).
 */
import { registerParams } from './registry';

export interface GetTheDriftParams {
  /** s the act overlaps the end of Undertime (the knots open while the signature fades) */
  overlap: number;
  galaxies: number;
  ours: number;
  band: number;
  sun: number;
  earth: number;
  /** m, typical galaxy radius in the field */
  galaxySize: number;
  /** m, radius of our galaxy */
  ourRadius: number;
  /** m, how far ahead our galaxy's Sun point is when the act starts */
  ourDistance: number;
  /** deg, dome elevation / azimuth we approach the Sun point along */
  approachEl: number;
  approachAz: number;
  /** deg, lean of our galaxy's plane from the dome's meridian (its band arcs front → zenith → back) */
  bandLean: number;
  /** deg, dome elevation of the galactic centre seen from inside */
  centreEl: number;
  /** fraction of the radius the Sun sits from the centre */
  sunRadius: number;
  /** fraction of the starting distance left at the end of the galaxies beat / of ours (inside the disk) */
  driftKeep: number;
  insideKeep: number;
  galaxyRadiance: number;
  volumeRadiance: number;
  /** ray-march steps through our galaxy */
  marchSteps: number;
  exposure: number;
}

export const getTheDriftParams: GetTheDriftParams = registerParams(
  'getTheDrift',
  {
    overlap: 5,
    galaxies: 18,
    ours: 24,
    band: 10,
    sun: 12,
    earth: 19,
    galaxySize: 1.1,
    ourRadius: 1.6,
    ourDistance: 14,
    approachEl: 32,
    approachAz: -28,
    bandLean: 20,
    centreEl: 14,
    sunRadius: 0.55,
    driftKeep: 0.72,
    insideKeep: 4e-4,
    galaxyRadiance: 1.2,
    volumeRadiance: 0.2,
    marchSteps: 72,
    exposure: 1,
  },
  {
    overlap: { min: 0, max: 15, step: 0.5 },
    galaxies: { min: 1, max: 60, step: 0.5 },
    ours: { min: 1, max: 60, step: 0.5 },
    band: { min: 0, max: 60, step: 0.5 },
    sun: { min: 0, max: 60, step: 0.5 },
    earth: { min: 0, max: 60, step: 0.5 },
    galaxySize: { min: 0.1, max: 5, step: 0.05 },
    ourRadius: { min: 0.2, max: 6, step: 0.05 },
    ourDistance: { min: 2, max: 60, step: 0.5 },
    approachEl: { min: 0, max: 80, step: 1 },
    approachAz: { min: -90, max: 90, step: 1 },
    bandLean: { min: -60, max: 60, step: 1 },
    centreEl: { min: 0, max: 60, step: 1 },
    sunRadius: { min: 0.1, max: 0.9, step: 0.01 },
    driftKeep: { min: 0.1, max: 1, step: 0.01 },
    insideKeep: { min: 1e-5, max: 0.01, step: 1e-5 },
    galaxyRadiance: { min: 0, max: 10, step: 0.05 },
    volumeRadiance: { min: 0, max: 10, step: 0.05 },
    marchSteps: { min: 8, max: 256, step: 1 },
    exposure: { min: 0.05, max: 8, step: 0.05 },
  },
);
