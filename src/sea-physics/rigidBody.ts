/**
 * rigid6 — full 6DOF rigid-body integrator for the speedboat (§T.165 S1,
 * docs/speedboat/tech-research.md §1.3). Engine-free (§V3), allocation-free when stepped with a
 * per-boat memory, deterministic for a fixed (dt, substeps, force function), no module-level state (§V2;
 * a worker copy is bit-identical).
 *
 * SINGLE OWNER (§V51 / proposed V100). For a body stepped here, THIS function
 * is the one integrator of all 13 channels: position (3, the CG), quaternion
 * (4), velocity (3, world) and angularVelocity (3, world). Hull hydro, drive,
 * aero, assists and contacts contribute FORCE and TORQUE only, through the
 * force callback, once per substep. Nothing else may `x += v·dt` these channels.
 * (The `stepShipBuoyancy|Sailing|Grounding` throw-guards V100 asks for live in
 * files this change does not own — see the S1 report.)
 *
 * NO EULER ANGLES (proposed V102). Orientation is a unit quaternion
 * integrated from world ω; the path has no asin/atan decomposition, so a full
 * loop in any axis, inversion and a vertical bow are ordinary poses.
 *
 * COUPLED ADDED MASS (T179): a provider may hand a body-frame 6×6 `addedMass6` with `coupled` set; the substep
 * then solves (M + A6)·[a_lin; a_ang] = [F_b; τ_b] (Cholesky) and the gyroscopic step uses the RIGID inertia.
 * In that mode the provider owns the entrained-water bookkeeping (keep) and the rotating-frame fluid loads.
 *
 * Per substep h = dt/N (doc §1.3):
 *   F, τ   ← gravity + forceFn(state)                      accumulate only
 *   v      ← v + h·R·diag(1/(m + A))·Rᵀ·F                   body-frame added mass (§V69)
 *   ω_b    ← implicit-midpoint gyroscopic step (Newton, energy-clamped) on I + ΔI
 *   ω_b    ← ω_b + h·(I + ΔI)⁻¹·τ_b
 *   x      ← x + h·v ;  q ← normalize(q + h/2·[ω,0]⊗q)       semi-implicit (symplectic) Euler
 *
 * WHY IMPLICIT GYRO: explicit ω×Iω pumps energy into a spinning asymmetric body
 * and diverges. DEVIATION: the doc names Catto's one-step implicit Euler; that is
 * stable but dissipative enough to fail the doc's own |L| ±1% at tumble rates, so
 * the midpoint rule is used, clamped so energy never rises (tests: |L| held,
 * energy non-increasing, Dzhanibekov flip).
 *
 * WEIGHT ON m, NOT m + A: gravity is applied as the force m·g and divided by
 * (m + A) with everything else, as the doc's step writes it — equilibrium is
 * unchanged (A moves no force); a wet body's free-fall acceleration is blunted,
 * a dry one (A = 0) falls at exactly g.
 *
 * DEDUPE NOTE (§V95): the quaternion update below is the same first-order
 * formula as the private `integrateQuat` in buoyancy.ts. The doc's precursor P1
 * moves that to src/core/quat.ts; src/core is owned elsewhere right now, so the
 * formula is inlined here (allocation-free) and flagged for the P1 move.
 */
import { invRotateVec as worldToBody, rotateVec as bodyToWorld } from '../core/quat';
import type { Quat, Vec3 } from '../state/simState';

/** the 13 channels rigid6 owns; structurally satisfied by ShipState */
export interface Rigid6State {
  position: Vec3;
  quaternion: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
}

export interface Rigid6Body {
  mass: number;
  /** body-frame principal inertia, kg·m² */
  inertia: Vec3;
}

/** what a force provider hands the integrator for ONE substep */
export interface Rigid6Load {
  /** world force through the CG, N */
  force: Vec3;
  /** world torque about the CG, N·m */
  torque: Vec3;
  /** body-frame diagonal added mass, kg (≥ 0) */
  addedMass: Vec3;
  /** body-frame diagonal added inertia, kg·m² (≥ 0) */
  addedInertia: Vec3;
  /**
   * OPTIONAL COUPLED ADDED MASS: body-frame symmetric positive semi-definite 6×6 about the CG, row-major,
   * generalized order [surge-x, y, z, rot-x, rot-y, rot-z] (36 entries). Used instead of the diagonal
   * `addedMass`/`addedInertia` for the substep when `coupled` is true. The provider owns its
   * entrained-water bookkeeping in that mode (it hands the matrix the step must divide by), and the
   * rotating-frame fluid loads (Kirchhoff) — the gyroscopic step then acts on the rigid inertia only.
   */
  addedMass6?: Float64Array;
  coupled?: boolean;
}

/**
 * Called once per substep with the state at the START of the substep.
 * Must ACCUMULATE into `out` (it arrives zeroed) and must not write `state`.
 */
export type Rigid6ForceFn = (state: Readonly<Rigid6State>, h: number, out: Rigid6Load) => void;

export function createRigid6Load(): Rigid6Load {
  return { force: [0, 0, 0], torque: [0, 0, 0], addedMass: [0, 0, 0], addedInertia: [0, 0, 0], addedMass6: new Float64Array(36), coupled: false };
}

function clearLoad(l: Rigid6Load): void {
  l.force[0] = l.force[1] = l.force[2] = 0;
  l.torque[0] = l.torque[1] = l.torque[2] = 0;
  l.addedMass[0] = l.addedMass[1] = l.addedMass[2] = 0;
  l.addedInertia[0] = l.addedInertia[1] = l.addedInertia[2] = 0;
  if (l.addedMass6) l.addedMass6.fill(0);
  l.coupled = false;
}

export const RIGID6_GRAVITY = 9.81;


/**
 * ENTRAINED-WATER MEMORY (deviation from the doc's step). The doc divides each substep's force by
 * (m + A); with A changing every substep that division has to know which water is new. The memory keeps
 * the previous substep's added mass and inertia, and the step divides by min(A_old, A_new) per body axis:
 *   A constant      ⇒ identical to the doc's step;
 *   A shrinking     ⇒ divide by A_new: the departing water takes its momentum, nothing is handed back
 *                     to the hull (§V70 "lost, not returned");
 *   A growing       ⇒ divide by A_old: the exchange with the new water is the SLAM IMPULSE the contact
 *                     already applied with the same 1/(m + min(A_old, A_new)), so it is not done twice.
 * Per-body memory (V108: `resetRigid6Memory` on any teleport); no memory gives the doc's plain step.
 * NO ROTATIONAL TRANSFER (changed, measured): an earlier version carried the water's momentum in the
 * WORLD frame (Kirchhoff's R·A·Rᵀ·v conserved through rotations). The hull model supplies that physics,
 * correctly for a strip model, as the rotating-frame section load m_a·N·(ω×v); both together
 * double-counted it. Rotation alone now moves nothing between axes here.
 */
export interface Rigid6Memory {
  valid: boolean;
  /** this boat's step scratch (no data carried between calls) */
  workspace: Rigid6Workspace;
  addedMass: Vec3;
  addedInertia: Vec3;
}

export function createRigid6Memory(): Rigid6Memory {
  return {
    valid: false,
    workspace: createRigid6Workspace(),
    addedMass: [0, 0, 0],
    addedInertia: [0, 0, 0],
  };
}

export function resetRigid6Memory(mem: Rigid6Memory): void {
  mem.valid = false;
}

/**
 * Per-call scratch (V2 / worker purity): NOTHING is kept at module level. A step's only inputs are its
 * arguments; its scratch lives in the caller's memory object (allocated once per boat) or, without
 * memory, in a workspace allocated for that call.
 */
export interface Rigid6Workspace {
  load: Rigid6Load;
  b0: Float64Array;
  b1: Float64Array;
  b2: Float64Array;
  /** 6×6 system matrix and solution scratch (coupled added mass) */
  s6: Float64Array;
  x6: Float64Array;
}

export function createRigid6Workspace(): Rigid6Workspace {
  return {
    load: createRigid6Load(),
    b0: new Float64Array(3),
    b1: new Float64Array(3),
    b2: new Float64Array(3),
    s6: new Float64Array(36),
    x6: new Float64Array(6),
  };
}

/** Cholesky-factor a symmetric positive-definite 6×6 (row-major) in place, lower triangle = L. false if not SPD. */
export function factorSpd6(S: Float64Array): boolean {
  for (let j = 0; j < 6; j++) {
    let d = S[j * 6 + j];
    for (let k = 0; k < j; k++) d -= S[j * 6 + k] * S[j * 6 + k];
    if (!(d > 0)) return false;
    const l = Math.sqrt(d);
    S[j * 6 + j] = l;
    for (let i = j + 1; i < 6; i++) {
      let v = S[i * 6 + j];
      for (let k = 0; k < j; k++) v -= S[i * 6 + k] * S[j * 6 + k];
      S[i * 6 + j] = v / l;
    }
  }
  return true;
}

/** x ← (L·Lᵀ)⁻¹·x for a matrix factored by `factorSpd6` */
export function solveFactored6(L: Float64Array, x: Float64Array): void {
  for (let i = 0; i < 6; i++) {
    let v = x[i];
    for (let k = 0; k < i; k++) v -= L[i * 6 + k] * x[k];
    x[i] = v / L[i * 6 + i];
  }
  for (let i = 5; i >= 0; i--) {
    let v = x[i];
    for (let k = i + 1; k < 6; k++) v -= L[k * 6 + i] * x[k];
    x[i] = v / L[i * 6 + i];
  }
}

/** solve S·x = b in place (x holds b on entry) for a symmetric positive-definite 6×6 S, which is overwritten */
export function solveSpd6(S: Float64Array, x: Float64Array): boolean {
  if (!factorSpd6(S)) return false;
  solveFactored6(S, x);
  return true;
}

function toBody(q: Quat, x: number, y: number, z: number, out: Float64Array): void {
  const qx = -q[0];
  const qy = -q[1];
  const qz = -q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

function toWorld(q: Quat, x: number, y: number, z: number, out: Float64Array): void {
  const qx = q[0];
  const qy = q[1];
  const qz = q[2];
  const qw = q[3];
  const tx = 2 * (qy * z - qz * y);
  const ty = 2 * (qz * x - qx * z);
  const tz = 2 * (qx * y - qy * x);
  out[0] = x + qw * tx + (qy * tz - qz * ty);
  out[1] = y + qw * ty + (qz * tx - qx * tz);
  out[2] = z + qw * tz + (qx * ty - qy * tx);
}

/**
 * Implicit-midpoint torque-free Euler step in the body frame; result in `out`.
 * Up to 4 Newton iterations on g(ω2) = I(ω2−ω1) + h·ω̄×Iω̄; energy clamped non-increasing.
 */
function gyroMidpoint(Ix: number, Iy: number, Iz: number, w1x: number, w1y: number, w1z: number, h: number, out: Float64Array): void {
  let x = w1x;
  let y = w1y;
  let z = w1z;
  for (let it = 0; it < 4; it++) {
    const mx = 0.5 * (w1x + x);
    const my = 0.5 * (w1y + y);
    const mz = 0.5 * (w1z + z);
    const Lx = Ix * mx;
    const Ly = Iy * my;
    const Lz = Iz * mz;
    const gx = Ix * (x - w1x) + h * (my * Lz - mz * Ly);
    const gy = Iy * (y - w1y) + h * (mz * Lx - mx * Lz);
    const gz = Iz * (z - w1z) + h * (mx * Ly - my * Lx);
    if (Math.abs(gx) + Math.abs(gy) + Math.abs(gz) < 1e-14 * (Ix * Math.abs(x) + Iy * Math.abs(y) + Iz * Math.abs(z) + 1e-300)) break;
    // J = I + (h/2)·(skew(ω̄)·I − skew(Iω̄))
    const k = 0.5 * h;
    const j00 = Ix;
    const j01 = k * (-mz * Iy + Lz);
    const j02 = k * (my * Iz - Ly);
    const j10 = k * (mz * Ix - Lz);
    const j11 = Iy;
    const j12 = k * (-mx * Iz + Lx);
    const j20 = k * (-my * Ix + Ly);
    const j21 = k * (mx * Iy - Lx);
    const j22 = Iz;
    const c00 = j11 * j22 - j12 * j21;
    const c01 = j12 * j20 - j10 * j22;
    const c02 = j10 * j21 - j11 * j20;
    const det = j00 * c00 + j01 * c01 + j02 * c02;
    if (!(det !== 0 && Number.isFinite(det))) break;
    const inv = 1 / det;
    x -= (c00 * gx + (j02 * j21 - j01 * j22) * gy + (j01 * j12 - j02 * j11) * gz) * inv;
    y -= (c01 * gx + (j00 * j22 - j02 * j20) * gy + (j02 * j10 - j00 * j12) * gz) * inv;
    z -= (c02 * gx + (j01 * j20 - j00 * j21) * gy + (j00 * j11 - j01 * j10) * gz) * inv;
  }
  const e1 = Ix * w1x * w1x + Iy * w1y * w1y + Iz * w1z * w1z;
  const e2 = Ix * x * x + Iy * y * y + Iz * z * z;
  if (!Number.isFinite(e2)) {
    x = w1x;
    y = w1y;
    z = w1z;
  } else if (e2 > e1 && e2 > 0) {
    const sc = Math.sqrt(e1 / e2);
    x *= sc;
    y *= sc;
    z *= sc;
  }
  out[0] = x;
  out[1] = y;
  out[2] = z;
}

/** the added mass the step divides by: min(old, new) — growth is exchanged by the contact's slam impulse */
function keepOf(aOld: number, aNew: number): number {
  return aNew < aOld ? aNew : aOld;
}

/**
 * Advance `state` by dt in `substeps` equal substeps. Mutates the state's arrays
 * in place (element writes, so references held by consumers stay valid).
 * Throws on a non-integer substep count or a non-finite state (fail loud, §Rule 8):
 * a NaN in one channel otherwise spreads silently into the replay hash.
 */
export function stepRigid6(
  state: Rigid6State,
  body: Rigid6Body,
  dt: number,
  substeps: number,
  forceFn: Rigid6ForceFn | null,
  memory: Rigid6Memory | null = null,
  gravity: number = RIGID6_GRAVITY,
): void {
  if (!Number.isInteger(substeps) || substeps < 1) {
    throw new Error(`rigid6: substeps must be a positive integer, got ${substeps}`);
  }
  if (!(dt > 0)) throw new Error(`rigid6: dt must be > 0, got ${dt}`);
  const h = dt / substeps;
  const m = body.mass;
  const [I0, I1, I2] = body.inertia;
  const p = state.position;
  const q = state.quaternion;
  const v = state.velocity;
  const w = state.angularVelocity;
  const ws = memory ? memory.workspace : createRigid6Workspace();
  const load = ws.load;
  const B0 = ws.b0;
  const B1 = ws.b1;
  const B2 = ws.b2;

  for (let s = 0; s < substeps; s++) {
    clearLoad(load);
    if (forceFn) forceFn(state, h, load);
    const fx = load.force[0];
    const fy = load.force[1] - m * gravity;
    const fz = load.force[2];
    const tx = load.torque[0];
    const ty = load.torque[1];
    const tz = load.torque[2];

    const mem = memory;
    const Anx = load.addedMass[0];
    const Any = load.addedMass[1];
    const Anz = load.addedMass[2];
    const Inx = load.addedInertia[0];
    const Iny = load.addedInertia[1];
    const Inz = load.addedInertia[2];
    const fresh = !mem || !mem.valid;

    if (load.coupled && load.addedMass6) {
      // ---- COUPLED: (M + A6)·[a_lin; a_ang] = [F_b; τ_b], a_lin = world acceleration in body axes,
      //      a_ang = ω̇_b + I⁻¹(ω_b × Iω_b) (the rigid gyroscopic step below supplies the latter)
      const S6 = ws.s6;
      const X6 = ws.x6;
      const A6 = load.addedMass6;
      for (let k = 0; k < 36; k++) S6[k] = A6[k];
      S6[0] += m;
      S6[7] += m;
      S6[14] += m;
      S6[21] += I0;
      S6[28] += I1;
      S6[35] += I2;
      toBody(q, fx, fy, fz, B0);
      X6[0] = B0[0];
      X6[1] = B0[1];
      X6[2] = B0[2];
      toBody(q, tx, ty, tz, B0);
      X6[3] = B0[0];
      X6[4] = B0[1];
      X6[5] = B0[2];
      if (!solveSpd6(S6, X6)) throw new Error('rigid6: coupled added-mass system is not positive definite');
      toBody(q, v[0], v[1], v[2], B1);
      toWorld(q, B1[0] + h * X6[0], B1[1] + h * X6[1], B1[2] + h * X6[2], B2);
      v[0] = B2[0];
      v[1] = B2[1];
      v[2] = B2[2];
      toBody(q, w[0], w[1], w[2], B1);
      gyroMidpoint(I0, I1, I2, B1[0], B1[1], B1[2], h, B0);
      toWorld(q, B0[0] + h * X6[3], B0[1] + h * X6[4], B0[2] + h * X6[5], B2);
      w[0] = B2[0];
      w[1] = B2[1];
      w[2] = B2[2];
      if (memory) memory.valid = false;
    } else {
    // ---- linear, body frame: the doc's v ← v + h·R·diag(1/(m + A))·Rᵀ·F, with A the kept added mass
    //      (see ENTRAINED-WATER MEMORY above)
    toBody(q, fx, fy, fz, B0);
    toBody(q, v[0], v[1], v[2], B1);
    const Kx = fresh || !mem ? Anx : keepOf(mem.addedMass[0], Anx);
    const Ky = fresh || !mem ? Any : keepOf(mem.addedMass[1], Any);
    const Kz = fresh || !mem ? Anz : keepOf(mem.addedMass[2], Anz);
    B1[0] += (h * B0[0]) / (m + Kx);
    B1[1] += (h * B0[1]) / (m + Ky);
    B1[2] += (h * B0[2]) / (m + Kz);
    toWorld(q, B1[0], B1[1], B1[2], B2);
    v[0] = B2[0];
    v[1] = B2[1];
    v[2] = B2[2];

    // ---- angular, in the body frame
    {
      toBody(q, tx, ty, tz, B0);
      const tbx = B0[0];
      const tby = B0[1];
      const tbz = B0[2];
      toBody(q, w[0], w[1], w[2], B1);
      const Ix = I0 + (fresh || !mem ? Inx : keepOf(mem.addedInertia[0], Inx));
      const Iy = I1 + (fresh || !mem ? Iny : keepOf(mem.addedInertia[1], Iny));
      const Iz = I2 + (fresh || !mem ? Inz : keepOf(mem.addedInertia[2], Inz));
      let ox = B1[0];
      let oy = B1[1];
      let oz = B1[2];

      // gyroscopic step: IMPLICIT MIDPOINT, I(ω2−ω1) + h·ω̄×Iω̄ = 0, ω̄ = (ω1+ω2)/2, by Newton
      // from ω1 (the Catto/Bullet Jacobian, halved for the midpoint). Converged, it conserves
      // |L| and E exactly; the doc's one-step implicit EULER (Catto GDC'15) is stable but
      // measured −18% |L| and −34% E in 10 s at a 1 rev/s tumble — a flipping boat would
      // brake in the air. Then an energy clamp: E may only go down, so an unconverged solve
      // (huge ω·h) degrades to dissipation, never to the explicit form's blow-up.
      gyroMidpoint(Ix, Iy, Iz, ox, oy, oz, h, B0);
      ox = B0[0];
      oy = B0[1];
      oz = B0[2];
      ox += (h * tbx) / Ix;
      oy += (h * tby) / Iy;
      oz += (h * tbz) / Iz;
      if (mem) {
        mem.addedMass[0] = Anx;
        mem.addedMass[1] = Any;
        mem.addedMass[2] = Anz;
        mem.addedInertia[0] = Inx;
        mem.addedInertia[1] = Iny;
        mem.addedInertia[2] = Inz;
        mem.valid = true;
      }
      toWorld(q, ox, oy, oz, B2);
      w[0] = B2[0];
      w[1] = B2[1];
      w[2] = B2[2];
    }
    }

    // ---- position and orientation from the NEW velocities (symplectic Euler)
    p[0] += h * v[0];
    p[1] += h * v[1];
    p[2] += h * v[2];
    {
      const qx = q[0];
      const qy = q[1];
      const qz = q[2];
      const qw = q[3];
      const wx = w[0];
      const wy = w[1];
      const wz = w[2];
      // [ω,0] ⊗ q
      const dqx = wx * qw + wy * qz - wz * qy;
      const dqy = -wx * qz + wy * qw + wz * qx;
      const dqz = wx * qy - wy * qx + wz * qw;
      const dqw = -wx * qx - wy * qy - wz * qz;
      const nx = qx + 0.5 * h * dqx;
      const ny = qy + 0.5 * h * dqy;
      const nz = qz + 0.5 * h * dqz;
      const nw = qw + 0.5 * h * dqw;
      const len = Math.sqrt(nx * nx + ny * ny + nz * nz + nw * nw);
      q[0] = nx / len;
      q[1] = ny / len;
      q[2] = nz / len;
      q[3] = nw / len;
    }

    const probe = p[0] + p[1] + p[2] + v[0] + v[1] + v[2] + w[0] + w[1] + w[2] + q[0] + q[1] + q[2] + q[3];
    if (!Number.isFinite(probe)) {
      throw new Error(
        `rigid6: non-finite state after substep ${s} (p=${p.join(',')} v=${v.join(',')} w=${w.join(',')} q=${q.join(',')})`,
      );
    }
  }
}

/**
 * CONTACT IMPULSE (§T.188, additive). Apply the world impulse J (N·s) at the world arm r (m, from the CG):
 *   v ← v + J/m ;  ω ← ω + R·I⁻¹·Rᵀ·(r × J)
 * RIGID mass and inertia only, no added mass: a boat↔boat or boat↔rock contact is resolved on the two
 * rigid momenta, so Σ m·v of a pair is conserved exactly when the pair gets ±J (tests/boatCollide). The
 * water's share arrives next substep through the hull contact, as for any other velocity change.
 * VELOCITIES ONLY — position and quaternion stay this file's step's to integrate (V100), so this is a
 * velocity-level constraint response, not a second integrator. Allocation-free; fails loud on NaN.
 */
export function applyRigid6Impulse(
  state: Rigid6State,
  body: Rigid6Body,
  rx: number,
  ry: number,
  rz: number,
  jx: number,
  jy: number,
  jz: number,
): void {
  if (!Number.isFinite(rx + ry + rz + jx + jy + jz)) {
    throw new Error(`rigid6: non-finite impulse r=${rx},${ry},${rz} J=${jx},${jy},${jz}`);
  }
  const v = state.velocity;
  const w = state.angularVelocity;
  const q = state.quaternion;
  const im = 1 / body.mass;
  v[0] += jx * im;
  v[1] += jy * im;
  v[2] += jz * im;
  // L = r × J (world) → body → ÷I → world
  const lx = ry * jz - rz * jy;
  const ly = rz * jx - rx * jz;
  const lz = rx * jy - ry * jx;
  const qx = -q[0];
  const qy = -q[1];
  const qz = -q[2];
  const qw = q[3];
  let tx = 2 * (qy * lz - qz * ly);
  let ty = 2 * (qz * lx - qx * lz);
  let tz = 2 * (qx * ly - qy * lx);
  const bx = (lx + qw * tx + (qy * tz - qz * ty)) / body.inertia[0];
  const by = (ly + qw * ty + (qz * tx - qx * tz)) / body.inertia[1];
  const bz = (lz + qw * tz + (qx * ty - qy * tx)) / body.inertia[2];
  tx = 2 * (-qy * bz + qz * by);
  ty = 2 * (-qz * bx + qx * bz);
  tz = 2 * (-qx * by + qy * bx);
  w[0] += bx + qw * tx + (-qy * tz + qz * ty);
  w[1] += by + qw * ty + (-qz * tx + qx * tz);
  w[2] += bz + qw * tz + (-qx * ty + qy * tx);
}

/** kinetic energy ½m|v|² + ½ω_b·Iω_b (rigid inertia only), J */
export function rigid6KineticEnergy(state: Readonly<Rigid6State>, body: Rigid6Body): number {
  const wb = worldToBody(state.quaternion, state.angularVelocity);
  const v = state.velocity;
  return (
    0.5 * body.mass * (v[0] * v[0] + v[1] * v[1] + v[2] * v[2]) +
    0.5 * (body.inertia[0] * wb[0] * wb[0] + body.inertia[1] * wb[1] * wb[1] + body.inertia[2] * wb[2] * wb[2])
  );
}

/** world angular momentum R·I·ω_b (rigid inertia only), kg·m²/s */
export function rigid6AngularMomentum(state: Readonly<Rigid6State>, body: Rigid6Body): Vec3 {
  const wb = worldToBody(state.quaternion, state.angularVelocity);
  return bodyToWorld(state.quaternion, [body.inertia[0] * wb[0], body.inertia[1] * wb[1], body.inertia[2] * wb[2]]);
}
