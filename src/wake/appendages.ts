/**
 * W8 round 3: SURFACE-PIERCING APPENDAGES — struts, rudders, oars (docs/wake/w8-foam-readability.md §13).
 * USER (trailer shot 03, outboards at ~5 kn): "no turbulence/wake from the outboard lower units slicing the water".
 *
 * One `AppendageInput` per surface-piercing foil, generic across vessels: where it cuts the waterline, the way the
 * water leaves it, its chord and thickness, how deep it is immersed and the flow speed past it. Two consumers:
 *
 *   WAKE     `appendageSample`: a thin body moving through the surface displaces its immersed volume, so it is a
 *            hull-type source of weight ρ·g·t·c·h over its chord (the same currency as the hull's station loads,
 *            §V101) — the small split ripple / V it trails.
 *   FOAM     `appendageFoamDrive`: the streak behind it. A surface-piercing strut VENTILATES once its depth Froude
 *            number Fn_h = U/√(g·h) passes ≈ 2 (ventilation inception for surface-piercing struts, Breslin & Skalak
 *            1959; Harwood & Young 2016): an air cavity trails it and sheds bubbles. Below that the trailing edge
 *            sheds a turbulent eddy street that folds a little air at the surface. Drive = K·U·(eddy + (1 − eddy)·v).
 *
 * The speedboat's producer is `strutsFromJets` — each drive's gearcase strut sits on the drive line just forward of
 * its prop, and moves with steer and trim because the jet does (live pose). STATED, NOT WIRED: the raft's steering oar
 * and the galleon's rudder need a producer on their own pages (raftFrame / main.ts), which this module is ready for.
 */
import { GRAVITY } from '../ocean/oceanMath';
import { WAKE_RHO, type HydroSample } from './wakeSolverMath';
import { propWashValid, type PropWashInput } from './propWash';

export interface AppendageInput {
  /** where it cuts the waterline, world (m) */
  x: number;
  z: number;
  /** unit direction the water leaves it (aft), world XZ */
  dirX: number;
  dirZ: number;
  /** chord and thickness (m) */
  chord: number;
  thickness: number;
  /** immersed length below the surface (m, ≥ 0) */
  depth: number;
  /** flow speed past it (m/s, ≥ 0) */
  speed: number;
}

/** Mercury Sport Master gearcase strut: chord = lateralArea / span (0.19 m² / 0.5 m, `HullDrive`), ~18 % thick; 0.2 m forward of the prop (foilCe) */
export const DRIVE_STRUT = Object.freeze({ chord: 0.38, thickness: 0.07, lead: 0.2 });
/** ventilation inception band of a surface-piercing strut in depth Froude number */
export const STRUT_VENT_FN: readonly [number, number] = [1.5, 3];
/** share of the streak drive an unventilated eddy street keeps */
export const STRUT_EDDY_SHARE = 0.15;
/** LOOK CALIBRATION: streak drive per m/s of flow (a thin line, well under a prop ribbon's 1–3 m/s) */
export const STRUT_FOAM_GAIN = 0.05;

/** the drive struts of a vessel's jets (reuses `out`'s objects; returns the live count) */
export function strutsFromJets(jets: readonly PropWashInput[], out: AppendageInput[]): number {
  let n = 0;
  for (const j of jets) {
    if (!propWashValid(j) || !(j.immersion > 0)) continue;
    const len = Math.hypot(j.dirX, j.dirZ);
    const a = (out[n] ??= { x: 0, z: 0, dirX: 0, dirZ: 1, chord: 0, thickness: 0, depth: 0, speed: 0 });
    a.dirX = j.dirX / len;
    a.dirZ = j.dirZ / len;
    a.x = j.x - a.dirX * DRIVE_STRUT.lead;
    a.z = j.z - a.dirZ * DRIVE_STRUT.lead;
    a.chord = DRIVE_STRUT.chord;
    a.thickness = DRIVE_STRUT.thickness;
    a.depth = Math.max(0, j.depth + Math.sqrt(j.discArea / Math.PI) * (2 * j.immersion - 1));
    a.speed = Math.abs(j.advance);
    n++;
  }
  out.length = n;
  return n;
}

/** the wake source of one appendage, or null when it is out of the water or at rest */
export function appendageSample(a: AppendageInput, out: HydroSample = { x: 0, z: 0, fy: 0, footprint: 0, depth: 0 }): HydroSample | null {
  const vals = [a.x, a.z, a.chord, a.thickness, a.depth, a.speed];
  if (!vals.every(Number.isFinite) || !(a.depth > 0) || !(a.speed > 0.1)) return null;
  out.x = a.x + a.dirX * a.chord * 0.5;
  out.z = a.z + a.dirZ * a.chord * 0.5;
  out.fy = WAKE_RHO * GRAVITY * a.thickness * a.chord * a.depth;
  out.footprint = Math.max(0.5 * a.chord, a.thickness);
  out.depth = 0.5 * a.depth;
  return out;
}

/** the foam streak drive (m/s) behind one appendage (header) */
export function appendageFoamDrive(a: AppendageInput): number {
  if (![a.depth, a.speed].every(Number.isFinite) || !(a.depth > 0) || !(a.speed > 0.1)) return 0;
  const fn = a.speed / Math.sqrt(GRAVITY * Math.max(0.05, a.depth));
  const t = Math.min(1, Math.max(0, (fn - STRUT_VENT_FN[0]) / (STRUT_VENT_FN[1] - STRUT_VENT_FN[0])));
  const vent = t * t * (3 - 2 * t);
  return STRUT_FOAM_GAIN * a.speed * (STRUT_EDDY_SHARE + (1 - STRUT_EDDY_SHARE) * vent);
}
