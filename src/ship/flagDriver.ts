/**
 * Per-flag wind uniforms (§V3 read-only on sim data). Same pattern as
 * sailDriver.ts: the values live in three's OBJECT uniform group and are
 * refreshed in `onObjectUpdate`, so every pennant gets its own angle and lag
 * from ONE shared material, nothing outside src/ship has to push state in,
 * and a flag on a mast that snaps off keeps flying on the wreckage.
 *
 * The ship's velocity is measured here, from the flag's own world position
 * over time, because apparent wind needs it and nothing hands it to the
 * render side. It is heavily damped: a masthead is 30 m up, so the ship's
 * roll swings it several m/s sideways, and an unfiltered derivative would
 * read that roll as a gale.
 */
import * as THREE from 'three/webgpu';
import { objectGroup, uniform } from 'three/tsl';
import { oceanParams } from '../params/ocean';
import type { ShipFlagParams } from '../params/ship';
import {
  advanceFlag,
  angleDelta,
  apparentWind,
  gustModulation,
  streamStrength,
  wrapAngle,
  type FlagState,
} from './flagDynamics';

interface Motion {
  x: number;
  y: number;
  z: number;
  vx: number;
  vz: number;
  time: number;
}

/** velocity smoothing time constant (s) — long enough to reject mast sway */
const VELOCITY_TAU = 0.6;

const motionMemory = new WeakMap<THREE.Object3D, Motion>();

/**
 * World velocity of a flag's carrier, low-passed. Returns dt as well: reading
 * the history twice would return the value just written and yield dt ≈ 0,
 * which freezes every damped term downstream (the bug sailDriver documents).
 */
function sampleMotion(
  object: THREE.Object3D,
  now: number,
): { vx: number; vz: number; dt: number } {
  const m = object.matrixWorld.elements;
  const [x, y, z] = [m[12], m[13], m[14]];
  const prev = motionMemory.get(object);
  if (prev === undefined) {
    motionMemory.set(object, { x, y, z, vx: 0, vz: 0, time: now });
    return { vx: 0, vz: 0, dt: 1 / 60 };
  }
  const raw = now - prev.time;
  const dt = Math.min(0.25, Math.max(1 / 1000, raw)); // §V28 floored divisor
  const k = raw <= 1e-4 ? 0 : 1 - Math.exp(-dt / VELOCITY_TAU);
  const vx = prev.vx + ((x - prev.x) / dt - prev.vx) * k;
  const vz = prev.vz + ((z - prev.z) / dt - prev.vz) * k;
  motionMemory.set(object, { x, y, z, vx, vz, time: now });
  return { vx, vz, dt };
}

export interface FlagWindUniforms {
  /** angle (rad) the cloth leaves the staff at, in the flag's LOCAL frame */
  rootAngle: ReturnType<typeof uniform>;
  /**
   * tip angle MINUS root angle — the whip, spread along the fly in the
   * shader. Sent as a difference, not as a second absolute angle, because the
   * damped angles accumulate without bound: a ship that circles for an hour
   * would hand sin()/cos() a number large enough to lose the low bits and the
   * flag would start to judder. The root is wrapped to (−π, π] and the lag
   * rides along with it, so the pair stays small forever.
   */
  lagAngle: ReturnType<typeof uniform>;
  /** 0..1 stream strength: 1 = board stiff, 0 = hanging dead */
  strength: ReturnType<typeof uniform>;
  /**
   * Ripple phase, ∫rate dt, wrapped to [0, 2π). NOT `time × rate` in the
   * shader: with a rate that answers the wind, that expression's instantaneous
   * frequency is ω + t·dω/dt and it ramps away without bound as the app runs
   * (measured 0.93 Hz intended → 59.5 Hz after ten minutes). See advanceFlag.
   */
  wavePhase: ReturnType<typeof uniform>;
  /** the crack's own phase, integrated at FLAG_CRACK_RATIO × the ripple rate */
  crackPhase: ReturnType<typeof uniform>;
}

export function createFlagWindUniforms(p: ShipFlagParams): FlagWindUniforms {
  // seeded to a flag flying across the ship: if the per-object update never
  // runs (headless probe, renderer swap) the cloth still reads as a flag
  // rather than collapsing into the mast — fail visible, not silently worse
  const rootAngle = uniform(0).setGroup(objectGroup);
  const lagAngle = uniform(0).setGroup(objectGroup);
  const strength = uniform(0.75).setGroup(objectGroup);
  const wavePhase = uniform(0).setGroup(objectGroup);
  const crackPhase = uniform(0).setGroup(objectGroup);
  const states = new WeakMap<THREE.Object3D, FlagState>();

  rootAngle.onObjectUpdate((frame: { object: THREE.Object3D | null; time: number }): void => {
    const object = frame.object;
    if (object === null || object === undefined) return;
    const motion = sampleMotion(object, frame.time);
    const wind = apparentWind({
      windDirection: oceanParams.windDirection,
      windSpeed: oceanParams.windSpeed,
      shipVelX: motion.vx,
      shipVelZ: motion.vz,
    });

    // express the apparent wind in the flag's OWN frame: the piece rides a
    // mast that rides the ship, so its basis already carries heading, heel
    // and any brace angle above it. Horizontal projections of the local x and
    // z axes, renormalised — a heeled mast tilts them but never flattens them.
    const m = object.matrixWorld.elements;
    const xLen = Math.max(1e-4, Math.hypot(m[0], m[2])); // §V28
    const zLen = Math.max(1e-4, Math.hypot(m[8], m[10]));
    const alongX = (wind.x * m[0] + wind.z * m[2]) / xLen;
    const alongZ = (wind.x * m[8] + wind.z * m[10]) / zLen;
    const target = Math.atan2(alongZ, alongX);

    let prev = states.get(object);
    if (prev === undefined) {
      // each flag gets its OWN gust phase, from its own position: three
      // pennants breathing in step would read as one animation playing rather
      // than as three pieces of cloth in the same air (§B.4)
      const m0 = object.matrixWorld.elements;
      const own = (Math.abs(m0[13]) * 2.393 + Math.abs(m0[14]) * 1.117) % (Math.PI * 2);
      prev = {
        root: target,
        tip: target,
        strength: streamStrength(wind.speed, p),
        phase: own,
        // seeded from the same per-flag offset, so two pennants do not start
        // their ripple in step either (§B.4)
        wavePhase: own,
        crackPhase: own * 1.3,
      };
    }
    // lull and gust: the cloth breathes instead of holding one fixed pose,
    // which was half of "they are just very much flying hard"
    const gusted = streamStrength(wind.speed, p) * gustModulation(frame.time, prev.phase);
    const next = advanceFlag(prev, target, gusted, motion.dt, p);
    states.set(object, next);
    rootAngle.value = wrapAngle(next.root);
    lagAngle.value = angleDelta(next.root, next.tip);
    strength.value = next.strength;
    wavePhase.value = next.wavePhase;
    crackPhase.value = next.crackPhase;
  });

  return { rootAngle, lagAngle, strength, wavePhase, crackPhase };
}
