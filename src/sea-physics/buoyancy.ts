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

/** galleon design waterline in ship space (§B.22 keeps these = the loft) */
const HULL_BOW_Z = 19;
const HULL_STERN_Z = -16.5;
const HULL_HALF_BEAM = 4.25;

/**
 * Normalised half-breadth of the waterline outline, 0..1 of HULL_HALF_BEAM.
 * Same elliptical family as hullContact.waterlineFromBox — pointed at the
 * stem, cut off at 0.55 beam across the transom.
 */
function halfBreadth(z: number): number {
  const mid = (HULL_BOW_Z + HULL_STERN_Z) / 2;
  const halfLen = (HULL_BOW_Z - HULL_STERN_Z) / 2;
  const u = Math.min(1, Math.max(-1, (z - mid) / halfLen));
  const ell = Math.sqrt(Math.max(0, 1 - u * u));
  return u >= 0 ? ell : Math.max(ell, 0.55);
}

/**
 * One buoyancy sample point: a ship-local position on the design waterline
 * plane, plus the SHARE of the hull's waterplane it stands for (Σ = 1).
 */
export interface ProbeStation {
  local: Vec3;
  weight: number;
}

/**
 * WHY THE HULL IS A QUADRATURE, NOT A HANDFUL OF PROBES (§B.22).
 *
 * The heave force on a hull is ∫ ρg·h(z)·b(z) dz over the waterplane — an
 * INTEGRAL along the ship's length. Approximating it with 8 hand-placed
 * probes samples that integral at 8 points, and 8 points cannot represent a
 * cosine whose wavelength is comparable to the hull: at λ = 40 m the old
 * layout summed to −0.28 where the true integral is +0.10 — three times too
 * big AND SIGN-INVERTED (the hull rose on crests), and at λ = 50 m it summed
 * to ≈0, a total null. Those are the wavelengths this sea actually carries
 * (energy-weighted mean λ ≈ 69 m, cascade band edge at 40 m), so the ship
 * responded to the swell erratically, out of phase, and far too weakly —
 * "she dips into the water instead of riding it", "she doesn't feel alive".
 *
 * The cure is to sample densely enough to BE the integral: `probeSlices`
 * stations evenly spaced bow→stern, each weighted by the local half-breadth
 * (so the fat midships carries the buoyancy a real hull carries there), each
 * split into a port/starboard pair for roll. Then the length integral does
 * for free, and correctly, the wavelength filtering the Gaussian footprint
 * kernel used to fake: a 35 m hull in an 8 m wave sums to 5% because the
 * crests and troughs under it genuinely cancel, not because we smeared them.
 *
 * The pair's lever ±b/√3 is the radius of gyration of a rectangular strip
 * of half-width b (∫x²dx = ⅔b³ over an area 2b): two point loads at the
 * hull's full half-beam would overstate the waterplane's second moment —
 * i.e. the roll stiffness — by 3×, which is what pinned the old roll period.
 */
export interface StationSet {
  readonly stations: readonly ProbeStation[];
  /** Σ w·z² and Σ w·x² — the waterplane's second moments, for slope fits */
  readonly z2: number;
  readonly x2: number;
}

function buildStations(slices: number): StationSet {
  const n = Math.max(1, Math.round(slices));
  const stations: ProbeStation[] = [];
  let wSum = 0;
  let zBar = 0;
  const zs: number[] = [];
  const bs: number[] = [];
  for (let i = 0; i < n; i++) {
    // cell centres, so the end stations stand for half-cells at bow/stern
    const t = (i + 0.5) / n;
    const z = HULL_BOW_Z + (HULL_STERN_Z - HULL_BOW_Z) * t;
    const b = halfBreadth(z);
    zs.push(z);
    bs.push(b);
    wSum += b;
    zBar += b * z;
  }
  if (wSum <= 0) {
    return { stations: [{ local: [0, 0, 0], weight: 1 }], z2: 1, x2: 1 };
  }
  zBar /= wSum;
  let z2 = 0;
  let x2 = 0;
  for (let i = 0; i < n; i++) {
    // shift so the centre of the waterplane sits at the origin: the ship is
    // ballasted to float on her lines, and Σ w·z = 0 is what makes flat
    // water produce exactly zero pitch torque (no phantom static trim)
    const z = zs[i] - zBar;
    const x = (bs[i] * HULL_HALF_BEAM) / Math.sqrt(3);
    const w = bs[i] / wSum / 2;
    stations.push({ local: [-x, 0, z], weight: w });
    stations.push({ local: [x, 0, z], weight: w });
    z2 += 2 * w * z * z;
    x2 += 2 * w * x * x;
  }
  return { stations, z2: Math.max(1e-6, z2), x2: Math.max(1e-6, x2) };
}

/** stations are pure geometry — build once per distinct slice count */
const stationCache = new Map<number, StationSet>();
export function probeStations(slices: number): StationSet {
  const key = Math.max(1, Math.round(slices));
  let s = stationCache.get(key);
  if (s === undefined) {
    s = buildStations(key);
    stationCache.set(key, s);
  }
  return s;
}

/**
 * Wave slope is bounded by the sea itself (deep-water waves break past
 * ~1/7 steepness), but a finite-difference over a fold-capped displaced
 * surface is not — and this number multiplies g, so §V.44 applies: bound
 * the RESULT, not just its inputs.
 */
const MAX_WAVE_SLOPE = 0.35;
function clampSlope(s: number): number {
  return s < -MAX_WAVE_SLOPE ? -MAX_WAVE_SLOPE : s > MAX_WAVE_SLOPE ? MAX_WAVE_SLOPE : s;
}

/**
 * IMMERSED DEPTH OF A STATION'S SLICE, given the immersion `d` of the
 * waterline plane there (§B.27 — why the ship could "catch airtime").
 *
 * Every station sits on ONE plane, y = 0. Treating its buoyancy as k·max(d,0)
 * says the hull is an infinitely thin sheet: rise 0.44 m (the whole
 * equilibrium immersion) and the support is not reduced, it is GONE, and she
 * is ballistic at exactly −g with no water term at all. A real hull rising
 * out of a crest still has its whole 2 m of draft in the water, still carries
 * ~82% of her weight in buoyancy, and still drags her added mass with her.
 *
 * So the slice has a body: it runs from the keel (`hullDraft` below the
 * plane) to the deck (`hullFreeboard` above it), and its immersed depth is
 * d + draft, clamped to that range. Zero support now needs the KEEL to clear
 * the water, not the waterline plane, and the upper clamp says a fully
 * submerged hull stops gaining buoyancy — a bounded result, not a bounded
 * input (§V.44).
 *
 * Stiffness is unchanged where it matters: d(immersion)/dd = 1 through the
 * whole working range, so the waterplane spring, the roll/pitch restoring
 * moments and every period derived from them are exactly as before. What
 * changes is the DEPTH of the equilibrium — she now floats 2.44 m into her
 * own hull instead of 0.44 m — and that is what the heave period is made of:
 * T = 2π√(immersion·(1+a)/g) goes 2.30 s → 5.43 s, the textbook value for a
 * 2 m draft. A hull that bobs at twice the right frequency reads as light,
 * whatever it weighs.
 */
function immersedDepth(d: number, p: SeaPhysicsParams): number {
  const e = d + p.hullDraft;
  if (e <= 0) return 0;
  const cap = p.hullDraft + p.hullFreeboard;
  return e > cap ? cap : e;
}

/**
 * Immersion (m, negative = the waterline plane sits below the sea surface)
 * the hull settles to in flat water: weight over the hull's TOTAL waterplane
 * stiffness, less the draft that is already in the water at y = 0. Station
 * count cannot move it — the weights sum to 1 whatever `probeSlices` is,
 * which is the whole point of making them shares.
 */
export function equilibriumDraft(p: SeaPhysicsParams = seaPhysicsParams): number {
  return p.hullDraft - (p.mass * GRAVITY) / p.buoyancySpring;
}

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
 * HULL FOOTPRINT LOW-PASS — what is left for it to do (§B.22).
 *
 * The LENGTHWISE filtering is now the station quadrature's job (see
 * `buildStations`): a 35 m hull rejects an 8 m wave because the integral
 * along it genuinely cancels, which is both free and correctly phased,
 * where a Gaussian smear was neither. `hullFootprintLength` therefore
 * defaults to 0 and exists only as an anti-alias pre-filter if anyone runs
 * a very coarse `probeSlices`.
 *
 * ACROSS the beam there is no length to integrate over — 8.5 m of hull
 * cannot cancel a 17 m beam wave — so the one physical effect that keeps
 * short beam chop from rolling the ship is the Smith effect: wave pressure
 * decays as e^(−k·draft) under the surface. `hullFootprintBeam` is that
 * decay expressed as a Gaussian patch, response ≈ exp(−k²σ²/2). σ = 3.5 m
 * matches e^(−k·2 m) closely over the beam-chop band (λ 10–25 m).
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

  const stationSet = probeStations(p.probeSlices);
  const stations = stationSet.stations;
  let mem = seaMemory.get(ship);
  if (mem === undefined || mem.prevHeights.length !== stations.length) {
    // resizing on a live `probeSlices` tweak costs one tick of surface-
    // velocity damping, which is exactly what a fresh ship costs
    mem = {
      pitch: mem?.pitch ?? 0,
      prevHeights: new Float64Array(stations.length).fill(Number.NaN),
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
  // body-frame angular rates, so the damper can tell roll from pitch: the
  // vertical speed of a station is wBody.z·x (roll) − wBody.x·z (pitch),
  // and those two need DIFFERENT coefficients — see `rollDampingScale`
  const wBody0 = invRotateVec(q, [w[0], 0, w[2]]);
  // NONLINEAR (eddy-making) ROLL damping — Ikeda's decomposition in one
  // number. Roll damping is the one rotational DOF that is not mostly
  // linear: the wave-radiation part is, but the bilge/eddy part goes as
  // ω|ω|, and that is exactly why a hull can swing freely through a swell
  // (ζ ≈ 0.11, the feel we want) and still cannot spin itself over in a
  // gale. Without it, cutting ζ_roll from 0.41 to a realistic 0.10 to make
  // her ALIVE made her CAPSIZE — measured roll RMS 105°, max 180° in storm.
  //
  // ROLL ONLY, on purpose. Pitch damping is dominated by wave radiation,
  // which is linear; boosting it with the same term over-damped the bow at
  // swell rates and took the pitch back out of her, which is the complaint
  // this whole change exists to answer.
  //
  // Note this is also the model's only stability limit: station levers are
  // fixed in the body frame, so the righting arm honestly goes to zero at
  // 90° of heel and reverses past it, as a real hull's does. Nothing
  // recovers her from beyond that — she has to be kept short of it.
  const rollDamp =
    p.rollDampingScale * (1 + p.quadraticDampingRate * Math.abs(wBody0[2]));
  const pitchDamp = p.pitchDampingScale;
  // Σ w·h·z and Σ w·h·x — numerators of the least-squares fit of the WATER
  // surface across the hull's own footprint. Σ w·z = Σ w·x = 0 by
  // construction, so no mean subtraction is needed. (Water height, not
  // immersion: a hull already aligned with a wave face still slides down
  // it, so the relative slope is the wrong quantity for surge.)
  let slopeFore = 0;
  let slopeBeam = 0;

  for (let i = 0; i < stations.length; i++) {
    const st = stations[i];
    const local = st.local;
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
    // the slope fit uses EVERY station, wet or dry: a bow lifting clear of
    // a crest is exactly when the slope under her matters most
    slopeFore += st.weight * h * local[2];
    slopeBeam += st.weight * h * local[0];
    // the slice's own immersed depth, not the plane's: she is still floating
    // while the waterline plane is clear of the water (§B.27)
    const immersion = immersedDepth(depth, p);
    if (immersion <= 0) continue;
    submerged += st.weight;
    // Damp probe velocity RELATIVE to the surface so the hull rides a
    // passing swell instead of being braked against it (calm water,
    // waterVy 0, is the plain absolute damper).
    //
    // The rotational shares get their OWN coefficients. One damper serving
    // all three DOFs is why tuning heave killed roll: raising this damper
    // to stop the hull flying off crests took roll's damping ratio to 0.41,
    // where a ship is ~0.05–0.10 and swings for many cycles. Heave damping
    // is wave radiation (large and real); roll damping is viscous (small),
    // and they must be dialled apart or every heave fix re-pins the ship
    // upright — the user's "she doesn't feel dynamic".
    const vRoll = wBody0[2] * local[0] * p.probeLayoutScale;
    const vPitch = -wBody0[0] * local[2] * p.probeLayoutScale;
    const vRel = vel[1] - waterVy + rollDamp * vRoll + pitchDamp * vPitch;
    const f =
      (p.buoyancySpring * immersion - p.buoyancyDamping * vRel) * support * st.weight;
    force[1] += f;
    const t = cross(r, [0, f, 0]);
    torque[0] += t[0];
    torque[1] += t[1];
    torque[2] += t[2];
  }
  mem.prevTime = time;

  // WAVE SURGE (§B.22): the hull sits on a tilted water surface, and the
  // component of its own buoyant support along that tilt drives it — this
  // is what makes a ship accelerate down the back of a swell and labour
  // climbing the next one. Without it the horizontal channel is completely
  // deaf to the sea (measured: forward-acceleration RMS 0.000 m/s² in a
  // swell) and she tracks like a vehicle on rails, whatever the water does.
  // Slope comes free from the station depths already sampled: Σw·depth·z
  // over Σw·z² is the least-squares gradient about the (centred) waterplane.
  if (p.waveSurgeGain > 0) {
    // fit is against the SCALED station coordinate ζ = z·scale, so
    // Σw·h·ζ / Σw·ζ² = (Σw·h·z) / (scale · Σw·z²)
    const s = Math.max(1e-3, p.probeLayoutScale);
    const gz = slopeFore / (stationSet.z2 * s);
    const gx = slopeBeam / (stationSet.x2 * s);
    // scaled by how much hull is actually in the water: a ship clear of a
    // crest is not being pushed by it
    const aFore = -p.waveSurgeGain * GRAVITY * clampSlope(gz) * submerged;
    const aBeam = -p.waveSurgeGain * GRAVITY * clampSlope(gx) * submerged;
    force[0] += mass * (aFore * axL[0] + aBeam * axB[0]);
    force[2] += mass * (aFore * axL[2] + aBeam * axB[2]);
  }

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
  // `submerged` is already a waterplane FRACTION (station weights sum to 1)
  const heaveMass = mass * (1 + p.addedMassHeave * submerged);
  vel[0] += (force[0] / mass) * dt;
  vel[1] += (force[1] / heaveMass) * dt;
  vel[2] += (force[2] / mass) * dt;
  // POSITION IS INTEGRATED IN Y ONLY (§B.22 — this is the bug that shape
  // keeps producing). Sailing already did `position += velocity·dt` for the
  // planar channel earlier this same tick; integrating it again here made
  // the ship travel EXACTLY TWICE its own velocity over the ground —
  // measured 2.000× over 120 s — so she outran her own wake, her own drag
  // equilibrium and the sea's encounter frequency. Buoyancy may still ADD
  // horizontal FORCE (wave surge above, exactly as grounding adds friction);
  // sailing owns the planar integration, and only sailing.
  pos[1] += vel[1] * dt;

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
