/**
 * `HullWater` drives → `PropWashInput` (§T.180 c). Its own module so the wake,
 * flowfoam and every page that never carries a speedboat do not pull the
 * contact model in. Reads the per-drive thrust, prop point, drive line and
 * advance `HullWater` publishes after `evaluate` (§V77/§V101: one thrust
 * expression, in the contact model — this adapter only re-shapes it).
 */
import type { HullDrive } from '../sea-physics/hullWater';
import type { Rigid6State } from '../sea-physics/rigidBody';
import { ventilationFactor, type EngineSpec } from '../sea-physics/engine';
import { propLossPower, ventilationAirSpeed, type PropWashInput } from './propWash';

/** the HullWater surface this adapter reads (structural; the physics agent owns the class) */
export interface PropWashSource {
  readonly mesh: { readonly drives?: readonly HullDrive[]; readonly propRadius: number };
  /** per drive, last evaluate(): signed thrust N, prop point (world, 3k), unit drive line (world, 3k), |advance| m/s, prop immersion */
  readonly driveThrust: ArrayLike<number>;
  readonly driveProp: ArrayLike<number>;
  readonly driveDir: ArrayLike<number>;
  readonly driveAdvance: ArrayLike<number>;
  readonly driveImmersion: ArrayLike<number>;
  readonly patch: { heightAt(x: number, z: number): number };
  /** §T.195 per drive: the engine's prop shaft torque (N·m) and prop rev/s of the last evaluate — the lost power (optional) */
  readonly engines?: readonly { readonly propTorque: number; readonly propRps: number; readonly advanceRatio: number }[];
  /** §T.195 the drive's engine + prop spec (pitch, diameter, ventilation curve) — the ventilation air (optional) */
  readonly params?: { readonly engine?: Readonly<EngineSpec> };
}

/** The props of a `HullWater` after its `evaluate` this tick, as wash inputs. Reuses `out`'s objects; returns the live count. */
export function propWashFromHullWater(hw: PropWashSource, _state: Readonly<Rigid6State>, out: PropWashInput[]): number {
  const drives = hw.mesh.drives;
  if (!drives || drives.length === 0) return 0;
  const area = Math.PI * hw.mesh.propRadius * hw.mesh.propRadius;
  let live = 0;
  for (let k = 0; k < drives.length; k++) {
    const dx = hw.driveDir[3 * k];
    const dz = hw.driveDir[3 * k + 2];
    const len = Math.hypot(dx, dz);
    if (!(len > 1e-9)) continue;
    const T = hw.driveThrust[k];
    // the jet leaves against the thrust; reverse gear (T < 0) sends it FORWARD along the shaft
    const sign = T < 0 ? 1 : -1;
    const x = hw.driveProp[3 * k];
    const y = hw.driveProp[3 * k + 1];
    const z = hw.driveProp[3 * k + 2];
    const j = (out[live] ??= { x: 0, z: 0, dirX: 0, dirZ: 1, thrust: 0, discArea: area, depth: 0, advance: 0, immersion: 0 });
    j.x = x;
    j.z = z;
    j.dirX = (sign * dx) / len;
    j.dirZ = (sign * dz) / len;
    j.thrust = Math.abs(T);
    j.discArea = area;
    j.surfaceY = hw.patch.heightAt(x, z);
    j.depth = j.surfaceY - y;
    j.advance = hw.driveAdvance[k];
    j.immersion = Math.max(0, Math.min(1, hw.driveImmersion[k] ?? 0));
    const e = hw.engines?.[k];
    const spec = hw.params?.engine;
    j.lossPower = e ? propLossPower(e.propRps, e.propTorque, T, j.advance) : 0;
    // §T.199 the rooster tail's blade tip speed (absent without an engine model: the emitter estimates it)
    j.propRps = e && Number.isFinite(e.propRps) ? e.propRps : undefined;
    // the blades draw air only while they load the water: in neutral the gearcase decouples the prop (propTorque 0)
    // but the engine still reports the crank's idle rev/s, which would ventilate a coasting boat (no surface draw in neutral;
    // W8: the idling engine's exhaust still leaves through the hub — propWash.exhaustGasFlux reads that rev/s)
    j.ventAirSpeed =
      e && spec && e.propTorque !== 0 ? ventilationAirSpeed(j.immersion, ventilationFactor(spec, e.advanceRatio / (spec.propPitch / spec.propDiameter)), spec.propPitch, e.propRps) : 0;
    live++;
  }
  out.length = live;
  return live;
}
