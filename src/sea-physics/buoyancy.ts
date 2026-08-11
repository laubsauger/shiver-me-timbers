/**
 * Ship buoyancy (§V.8): probe points sample the CPU ocean mirror — the
 * same seeded spectrum the GPU renders — so ships ride the visible waves.
 * Engine-free plain-data physics (§V.3), fixed-dt semi-implicit Euler
 * (§V.2). Righting roll/pitch torque emerges from the probe geometry:
 * the deeper side pushes harder, no separate metacentric model needed.
 *
 * Ship body frame matches the proc ship (§V.13): forward +z, beam x, up y.
 */
import { rotateVec, invRotateVec, quatFromAxisAngle, quatMul } from '../combat/quatMath';
import type { Quat, ShipState, Vec3 } from '../state/simState';
import { GRAVITY } from '../ocean/oceanMath';
import { seaPhysicsParams, type SeaPhysicsParams } from '../params/seaPhysics';
import type { OceanHeightField } from './cpuOcean';
import { buoyancyScale, floodListTorque, floodMassFactor } from './flooding';

/**
 * Canonical probe layout for the galleon hull (hullLength 35 + bow 3.5,
 * beam 8.5) at probeLayoutScale 1, on the ship-local waterline plane
 * (y=0): 4 quarters + bow/stern + 2 midship beam extents. Spread (not
 * count) is the tunable — probes must reach the true bow/stern/beam
 * extremes or wave slope under-torques pitch and roll.
 */
export const PROBE_LAYOUT: readonly Vec3[] = [
  // quarters sit 1.25 m aft-biased so Σz = 0 against the long bow probe:
  // flat water then yields zero net pitch torque (no phantom static trim)
  [-3.9, 0, 13.5],
  [3.9, 0, 13.5],
  [-3.9, 0, -14.75],
  [3.9, 0, -14.75],
  [0, 0, 19],
  [0, 0, -16.5],
  [-4.25, 0, 0],
  [4.25, 0, 0],
];

/**
 * Per-ship buoyancy memory, keyed by ShipState identity (plain-data state
 * stays untouched, §V.3):
 * - `pitch`: sailing recomposes the quaternion as pure yaw∘heel every tick
 *   (see shipKinematics SPLIT CONTRACT), which strips the pitch buoyancy
 *   integrated. We remember our own pitch and re-apply it when the
 *   incoming quat arrives pitch-stripped, so the bow actually rises and
 *   dips instead of resetting flat 60×/s.
 * - `prevHeights`/`prevTime`: last tick's water height under each probe,
 *   for the surface vertical velocity estimate (damp RELATIVE to the
 *   moving surface — absolute damping fights swell-tracking with ~40% of
 *   ship weight and leaves the hull static while waves roll over it).
 * Derived caches only: losing them (reload) costs one tick of damping and
 * a pitch snap, nothing sim-hash-relevant accumulates here.
 */
interface ShipSeaMemory {
  pitch: number;
  prevHeights: Float64Array;
  prevTime: number;
}

const seaMemory = new WeakMap<ShipState, ShipSeaMemory>();

/** water surface vy is clamped: K-tick mirror recomputes (updateEveryTicks
 * > 1) make heights jump discretely, and an unclamped spike would kick the
 * hull (impulse-free forces, feel target #4) */
const MAX_SURFACE_VY = 8;

/**
 * HULL FOOTPRINT LOW-PASS — why the hull must not sample a point.
 *
 * A probe reading `heightAt` at one point makes the hull a cork: it feels
 * every ripple at full strength and is shoved by chop it should slice
 * through. Real hull force is the pressure integrated over a hull PANEL,
 * and wave pressure also decays as e^(−k·depth) below the surface (the
 * Smith effect), so both the panel width and the draft filter out waves
 * short compared to the ship. Both are wavelength low-passes, so we model
 * them as ONE effective footprint kernel: each probe averages the surface
 * over a Gaussian patch (σ = hullFootprintLength along the hull,
 * hullFootprintBeam across it) instead of poking it at a point.
 *
 * Response to a wave of wavenumber k is ≈ exp(−k²σ²/2): swell (λ ≫ σ)
 * passes untouched and still lifts, pitches and rolls the ship, while chop
 * (λ ≲ 2πσ) is averaged to nothing. This is what makes the ship read as a
 * 35 m displacement hull rather than a buoy, and it is NOT a §V.8
 * divergence: the sea sampled is still exactly the mirrored spectrum the
 * GPU draws, only integrated over the hull's own footprint instead of one
 * infinitesimal point.
 *
 * Quadrature: 5 offsets per axis at ±0.75σ/±1.5σ with Gaussian weights.
 * 3 offsets leave a sidelobe (λ≈2σ returns at ~0.5 — chop would leak back
 * in); 5 hold the response below ~0.11 for every wavelength the mirror
 * carries (λ ≥ 5 m, cascade 2 is not mirrored).
 */
const KERNEL_T: readonly number[] = [-1.5, -0.75, 0, 0.75, 1.5];
const KERNEL_W: readonly number[] = KERNEL_T.map((t) => Math.exp(-0.5 * t * t));
/** σ→0 collapses an axis to its centre sample (point probe, no cost) */
const KERNEL_OFF: readonly number[] = [0];
const KERNEL_ONE: readonly number[] = [1];

function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** integrate world-space angular velocity into the orientation quat */
function integrateQuat(q: Quat, w: Vec3, dt: number): Quat {
  const dq = quatMul([w[0], w[1], w[2], 0], q);
  const out: Quat = [
    q[0] + 0.5 * dt * dq[0],
    q[1] + 0.5 * dt * dq[1],
    q[2] + 0.5 * dt * dq[2],
    q[3] + 0.5 * dt * dq[3],
  ];
  const len = Math.hypot(out[0], out[1], out[2], out[3]);
  return [out[0] / len, out[1] / len, out[2] / len, out[3] / len];
}

/**
 * One fixed-dt buoyancy step, mutating ship position/quaternion/velocity/
 * angularVelocity in place. Caller must have advanced `ocean.update(time)`
 * for this tick first (heights are read at ocean.currentTime).
 */
export function stepShipBuoyancy(
  ship: ShipState,
  ocean: OceanHeightField,
  dt: number,
  p: SeaPhysicsParams = seaPhysicsParams,
  /** world-frame hole offsets for flood listing (§V.14); empty = intact */
  floodHoles: readonly Vec3[] = [],
): void {
  const pos = ship.position;
  const vel = ship.velocity;
  const w = ship.angularVelocity;
  // §V.14 flooding hooks: heavier when flooded, support fades when sinking
  const mass = p.mass * floodMassFactor(ship.flood);
  const support = buoyancyScale(ship);

  const time = ocean.currentTime;
  if (Number.isNaN(time)) {
    // fail loud: silently floating on a never-computed sea hides V8 bugs
    throw new Error('stepShipBuoyancy: call ocean.update(time) first');
  }

  let mem = seaMemory.get(ship);
  if (mem === undefined) {
    mem = {
      pitch: 0,
      prevHeights: new Float64Array(PROBE_LAYOUT.length).fill(Number.NaN),
      prevTime: Number.NaN,
    };
    seaMemory.set(ship, mem);
  }

  // Re-apply pitch if sailing's yaw∘heel recompose stripped it: such a
  // quat has an exactly horizontal forward vector. When pitch survived
  // (no sailing ran, or the contract gets fixed), forward.y equals our
  // stored pitch's sine and this branch self-deactivates — no double-add.
  let q = ship.quaternion;
  const fwdY = rotateVec(q, [0, 0, 1])[1];
  if (Math.abs(fwdY) < 1e-6 && Math.abs(mem.pitch) >= 1e-6) {
    // R_x(a) maps forward [0,0,1]→[0,−sin a,cos a]: −pitch lifts the bow
    q = quatMul(q, quatFromAxisAngle([1, 0, 0], -mem.pitch));
  }

  const force: Vec3 = [0, -mass * GRAVITY, 0];
  const torque: Vec3 = [0, 0, 0];
  const dtWater = time - mem.prevTime;
  // footprint axes in world space: the patch each probe averages over is
  // hull-aligned (long axis fore-aft), so it turns with the ship
  const sigL = Math.max(0, p.hullFootprintLength);
  const sigB = Math.max(0, p.hullFootprintBeam);
  const offL = sigL > 1e-3 ? KERNEL_T : KERNEL_OFF;
  const offB = sigB > 1e-3 ? KERNEL_T : KERNEL_OFF;
  const wL = sigL > 1e-3 ? KERNEL_W : KERNEL_ONE;
  const wB = sigB > 1e-3 ? KERNEL_W : KERNEL_ONE;
  const spread = offL.length > 1 || offB.length > 1;
  const axL = rotateVec(q, [0, 0, 1]);
  const axB = rotateVec(q, [1, 0, 0]);
  let submerged = 0;

  for (let i = 0; i < PROBE_LAYOUT.length; i++) {
    const local = PROBE_LAYOUT[i];
    const r = rotateVec(q, [
      local[0] * p.probeLayoutScale,
      local[1] * p.probeLayoutScale,
      local[2] * p.probeLayoutScale,
    ]);
    const px = pos[0] + r[0];
    const py = pos[1] + r[1];
    const pz = pos[2] + r[2];
    let h: number;
    if (!spread) {
      h = ocean.heightAt(px, pz, time);
    } else {
      let hSum = 0;
      let wSum = 0;
      for (let a = 0; a < offL.length; a++) {
        const dL = offL[a] * sigL;
        for (let b = 0; b < offB.length; b++) {
          const dB = offB[b] * sigB;
          const w = wL[a] * wB[b];
          hSum +=
            w *
            ocean.heightAt(
              px + axL[0] * dL + axB[0] * dB,
              pz + axL[2] * dL + axB[2] * dB,
              time,
            );
          wSum += w;
        }
      }
      h = hSum / wSum;
    }
    // water surface vertical velocity under this probe (0 on first tick)
    let waterVy = 0;
    if (dtWater > 0 && Number.isFinite(mem.prevHeights[i])) {
      const raw = (h - mem.prevHeights[i]) / dtWater;
      waterVy = Math.max(-MAX_SURFACE_VY, Math.min(MAX_SURFACE_VY, raw));
    }
    mem.prevHeights[i] = h;
    const depth = h - py;
    if (depth <= 0) continue;
    submerged++;
    // damp probe velocity RELATIVE to the surface so the hull rides a
    // passing swell instead of being braked against it; calm water
    // (waterVy 0) reproduces the old absolute damping exactly
    const vy = vel[1] + (w[2] * r[0] - w[0] * r[2]);
    const f =
      (p.buoyancySpring * depth - p.buoyancyDamping * (vy - waterVy)) *
      support;
    force[1] += f;
    const t = cross(r, [0, f, 0]);
    torque[0] += t[0];
    torque[1] += t[1];
    torque[2] += t[2];
  }
  mem.prevTime = time;

  // flood listing: torque toward flooded side, grows with flood (§V.14)
  if (floodHoles.length > 0 && ship.flood > 0) {
    const listT = floodListTorque(ship, floodHoles, ship.flood);
    torque[0] += listT[0];
    torque[1] += listT[1];
    torque[2] += listT[2];
  }

  // ADDED MASS: a hull heaving vertically drags a slab of water with it,
  // so its effective inertia in heave is (1 + a)·m while its WEIGHT stays
  // m·g — equilibrium draft is untouched, but the heave natural period
  // stretches by √(1+a) and every vertical acceleration is blunted. This
  // is the "weight" in the ship's response: without it the spring/mass
  // pair alone fixes the period at √(g/draft) ≈ 1.3 s, which reads as a
  // cork no matter how the spring is tuned. Scaled by wetted fraction so
  // a ship clear of the water free-falls at g, not g/(1+a).
  const wetted = submerged / PROBE_LAYOUT.length;
  const heaveMass = mass * (1 + p.addedMassHeave * wetted);
  vel[0] += (force[0] / mass) * dt;
  vel[1] += (force[1] / heaveMass) * dt;
  vel[2] += (force[2] / mass) * dt;
  pos[0] += vel[0] * dt;
  pos[1] += vel[1] * dt;
  pos[2] += vel[2] * dt;

  // diagonal inertia lives in the body frame: world→body, apply, body→world.
  // Yaw is SAILING's channel end to end (§B.6): vertical probe forces make
  // exactly zero world yaw torque (cross(r,[0,f,0]).y ≡ 0) and flood list
  // torque is y-free, so the only thing this step could do to w[1] is bleed
  // the rudder's built-up turn rate through `decay` and smear roll/pitch
  // into it while heeled. It leaves w[1] strictly alone — sailing carries
  // its yaw momentum THERE across ticks, and a silent nibble here would
  // read as a ship that refuses to hold a turn.
  const tBody = invRotateVec(q, torque);
  const wBody = invRotateVec(q, [w[0], 0, w[2]]);
  wBody[0] += (tBody[0] / p.inertiaPitch) * dt;
  wBody[2] += (tBody[2] / p.inertiaRoll) * dt;
  const wWorld = rotateVec(q, wBody);
  const decay = Math.max(0, 1 - p.angularDamping * dt);
  w[0] = wWorld[0] * decay;
  w[2] = wWorld[2] * decay;

  ship.quaternion = integrateQuat(q, [w[0], 0, w[2]], dt);
  // remember our pitch (bow elevation) for next tick's strip-detection
  const fwd = rotateVec(ship.quaternion, [0, 0, 1]);
  const fy = fwd[1] < -1 ? -1 : fwd[1] > 1 ? 1 : fwd[1];
  mem.pitch = Math.asin(fy);
}
