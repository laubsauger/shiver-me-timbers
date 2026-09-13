/**
 * rigid6 integrator — WHY these tests (docs/speedboat/tech-research.md §1.3, S1):
 * the speedboat has to flip, tumble, land inverted and blow over. Every one of those
 * is a pose the split buoyancy/sailing model cannot represent (§1.2), so the one thing
 * this integrator must never do is lose its orientation (NaN, non-unit quaternion,
 * gimbal singularity) or invent energy/momentum. Each test below fails if the specific
 * mechanism that guarantees one of those is removed:
 *  - drop the gyroscopic term → no Dzhanibekov flip;
 *  - make it explicit → |L| and energy grow;
 *  - reintroduce Euler angles → a loop through vertical breaks;
 *  - integrate position with the old velocity or skip substeps → the ballistic closed
 *    form (with its known symplectic-Euler bias) no longer matches;
 *  - carry the entrained water in the WORLD frame → rotation double-counts the rotating-frame
 *    section load the hull model supplies.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, quatMul, rotateVec, invRotateVec } from '../src/core/quat';
import {
  createRigid6Memory,
  type Rigid6Load,
  rigid6AngularMomentum,
  rigid6KineticEnergy,
  stepRigid6,
  type Rigid6Body,
  type Rigid6State,
} from '../src/sea-physics/rigidBody';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;

function freeState(q: Quat = [0, 0, 0, 1], w: Vec3 = [0, 0, 0], v: Vec3 = [0, 0, 0]): Rigid6State {
  return { position: [0, 0, 0], quaternion: [...q] as Quat, velocity: [...v] as Vec3, angularVelocity: [...w] as Vec3 };
}

/** seeded LCG so failures reproduce (§V2) */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function qNorm(q: Quat): number {
  return Math.hypot(q[0], q[1], q[2], q[3]);
}

describe('rigid6 torque-free rotation', () => {
  const body: Rigid6Body = { mass: 10, inertia: [100, 200, 300] };

  it('conserves |L| within 1% and never gains energy over 120 s of asymmetric tumbling (implicit gyro)', () => {
    // WHY: an explicit ω×Iω term pumps energy into exactly this case and diverges; the
    // implicit step is allowed to bleed a little but must never add.
    const st = freeState([0, 0, 0, 1], [0.7, 1.3, -0.4]);
    const L0 = rigid6AngularMomentum(st, body);
    const E0 = rigid6KineticEnergy(st, body);
    let Eprev = E0;
    let maxRise = 0;
    for (let t = 0; t < 60 * 120; t++) {
      stepRigid6(st, body, DT, 2, null, null, 0);
      const E = rigid6KineticEnergy(st, body);
      maxRise = Math.max(maxRise, (E - Eprev) / E0);
      Eprev = E;
      expect(Math.abs(qNorm(st.quaternion) - 1)).toBeLessThan(1e-9);
    }
    const L1 = rigid6AngularMomentum(st, body);
    const m0 = Math.hypot(...L0);
    const m1 = Math.hypot(...L1);
    expect(Math.abs(m1 - m0) / m0).toBeLessThan(0.01);
    // direction held too: world L is a constant vector, not only a constant length
    const cos = (L0[0] * L1[0] + L0[1] * L1[1] + L0[2] * L1[2]) / (m0 * m1);
    expect(cos).toBeGreaterThan(Math.cos((1 * Math.PI) / 180));
    expect(maxRise).toBeLessThan(1e-9);
    expect(Eprev).toBeLessThanOrEqual(E0);
    expect((E0 - Eprev) / E0).toBeLessThan(0.02);
  });

  it('does not brake a fast tumble: 1 rev/s asymmetric spin keeps |L| and E within 1% over 10 s', () => {
    // WHY: a boat tumbling after a blow-over spins at ~1 rev/s. The doc's one-step implicit
    // Euler gyro lost 18% of |L| and 34% of E here in 10 s — an in-air brake nobody tuned.
    const st = freeState([0, 0, 0, 1], [3, 6, -2]);
    const L0 = Math.hypot(...rigid6AngularMomentum(st, body));
    const E0 = rigid6KineticEnergy(st, body);
    for (let t = 0; t < 600; t++) stepRigid6(st, body, DT, 2, null, null, 0);
    expect(Math.abs(Math.hypot(...rigid6AngularMomentum(st, body)) - L0) / L0).toBeLessThan(0.01);
    const E = rigid6KineticEnergy(st, body);
    expect(E).toBeLessThanOrEqual(E0 * (1 + 1e-12));
    expect((E0 - E) / E0).toBeLessThan(0.01);
  });

  it('flips about the intermediate axis (Dzhanibekov) and stays put about the major and minor axes', () => {
    // WHY: with no gyroscopic term ω_b is constant in the body frame and nothing ever
    // flips. The intermediate-axis instability is the gyroscopic term's signature; the
    // stable major/minor controls prove the flip is not just numerical noise growing.
    const eps = 1e-3;
    const spin = 3;
    const run = (axis: 0 | 1 | 2): { signChanges: number; minAlong: number } => {
      const w: Vec3 = [eps, eps, eps];
      w[axis] = spin;
      const st = freeState([0, 0, 0, 1], w);
      let prevSign = 1;
      let signChanges = 0;
      let minAlong = Infinity;
      for (let t = 0; t < 60 * 30; t++) {
        stepRigid6(st, body, DT, 2, null, null, 0);
        const wb = invRotateVec(st.quaternion, st.angularVelocity);
        const along = wb[axis] / spin;
        minAlong = Math.min(minAlong, along);
        const sign = along >= 0 ? 1 : -1;
        if (sign !== prevSign) signChanges++;
        prevSign = sign;
      }
      return { signChanges, minAlong };
    };
    const inter = run(1);
    expect(inter.signChanges).toBeGreaterThanOrEqual(2); // flips over AND back
    expect(inter.minAlong).toBeLessThan(-0.9); // a real reversal, not a wobble
    const major = run(2);
    const minor = run(0);
    expect(major.signChanges).toBe(0);
    expect(minor.signChanges).toBe(0);
    expect(major.minAlong).toBeGreaterThan(0.99);
    expect(minor.minAlong).toBeGreaterThan(0.99);
  });
});

describe('rigid6 orientation total over SO(3) (proposed V102)', () => {
  const body: Rigid6Body = { mass: 4500, inertia: [34000, 37000, 3700] };

  for (const [name, axis] of [
    ['pitch (body x)', [1, 0, 0]],
    ['roll (body z)', [0, 0, 1]],
    ['oblique', [1 / Math.sqrt(3), 1 / Math.sqrt(3), 1 / Math.sqrt(3)]],
  ] as const) {
    it(`a full 360° loop in ${name} passes through vertical and inversion and closes`, () => {
      // spin about a principal axis (or with isotropic inertia for the oblique case) at
      // 1 rev/s for exactly 1 s: the orientation must come back to where it started.
      const b = name === 'oblique' ? { mass: 1, inertia: [5, 5, 5] as Vec3 } : body;
      const st = freeState([0, 0, 0, 1], [2 * Math.PI * axis[0], 2 * Math.PI * axis[1], 2 * Math.PI * axis[2]]);
      let sawVertical = false;
      let sawInverted = false;
      const N = 4;
      for (let t = 0; t < 60; t++) {
        stepRigid6(st, b, DT, N, null, null, 0);
        expect(Math.abs(qNorm(st.quaternion) - 1)).toBeLessThan(1e-9);
        const fwd = rotateVec(st.quaternion, [0, 0, 1]);
        const up = rotateVec(st.quaternion, [0, 1, 0]);
        if (Math.abs(fwd[1]) > 0.99 || Math.abs(up[0]) > 0.99) sawVertical = true;
        if (up[1] < -0.99) sawInverted = true;
      }
      if (name !== 'oblique') {
        expect(sawVertical).toBe(true);
        expect(sawInverted).toBe(true);
      }
      // |dot(q, identity)| = |w| → 1. First-order quaternion update has a per-step phase
      // error ~ (ωh)³/12; over one turn at h = 1/240 that is < 1e-3 rad.
      const angleErr = 2 * Math.acos(Math.min(1, Math.abs(st.quaternion[3])));
      expect(angleErr).toBeLessThan(2e-3);
    });
  }

  it('20 random full-SO(3) tumbles × 10 s: never NaN, |q| stays unit to 1e-9', () => {
    const r = rng(20260913);
    for (let k = 0; k < 20; k++) {
      const ax: Vec3 = [r() - 0.5, r() - 0.5, r() - 0.5];
      const al = Math.hypot(...ax);
      const q0 = quatFromAxisAngle([ax[0] / al, ax[1] / al, ax[2] / al], r() * 2 * Math.PI);
      const st = freeState(q0, [(r() - 0.5) * 12, (r() - 0.5) * 12, (r() - 0.5) * 12]);
      for (let t = 0; t < 600; t++) {
        stepRigid6(st, body, DT, 2, null);
        expect(Math.abs(qNorm(st.quaternion) - 1)).toBeLessThan(1e-9);
      }
      expect(Number.isFinite(st.position[1] + st.angularVelocity[0])).toBe(true);
    }
  });
});

describe('rigid6 translation', () => {
  it('ballistic arc = the analytic parabola plus the exact symplectic-Euler bias, which halves with 2N', () => {
    // WHY: pins that x uses the NEW velocity each substep (symplectic Euler), gravity acts on
    // m, and substepping really refines. y_n = y0 + v0·t − ½g·t² − ½g·h·t exactly.
    const g = 9.81;
    const body: Rigid6Body = { mass: 4500, inertia: [34000, 37000, 3700] };
    const errFor = (N: number): number => {
      const st = freeState([0, 0, 0, 1], [0, 0, 0], [3, 12, 40]);
      const T = 2.0;
      const ticks = Math.round(T / DT);
      for (let t = 0; t < ticks; t++) stepRigid6(st, body, DT, N, null);
      const h = DT / N;
      const yExact = 12 * T - 0.5 * g * T * T;
      const yClosed = yExact - 0.5 * g * h * T;
      expect(st.position[1]).toBeCloseTo(yClosed, 9);
      expect(st.position[0]).toBeCloseTo(3 * T, 9);
      expect(st.position[2]).toBeCloseTo(40 * T, 9);
      expect(st.velocity[1]).toBeCloseTo(12 - g * T, 9);
      return Math.abs(st.position[1] - yExact);
    };
    const e2 = errFor(2);
    const e4 = errFor(4);
    expect(e4 / e2).toBeCloseTo(0.5, 6);
  });

  it('constant added mass along a body axis divides only that axis (doc §1.3 step)', () => {
    // body pitched 90° nose-up: body y (heave, A = 4m) points along world −z
    const m = 1000;
    const body: Rigid6Body = { mass: m, inertia: [1, 1, 1] };
    const q = quatFromAxisAngle([1, 0, 0], -Math.PI / 2);
    const st = freeState(q);
    const h = DT;
    const A = 4 * m;
    stepRigid6(st, body, DT, 1, (_s, _h, out) => {
      out.force[1] += m * 9.81 + 500; // cancels gravity, +500 N up (body −z... world y → body z axis)
      out.force[2] += 500; // world z → body −y
      out.addedMass[1] = A;
    }, null);
    const bodyV = invRotateVec(st.quaternion, st.velocity);
    // world +y maps to body +z (no added mass), world +z maps to body −y (heave, m + A)
    const yb = invRotateVec(q, [0, 1, 0]);
    expect(Math.abs(yb[2])).toBeCloseTo(1, 9);
    expect(Math.abs(bodyV[2])).toBeCloseTo((500 * h) / m, 9);
    expect(Math.abs(bodyV[1])).toBeCloseTo((500 * h) / (m + A), 9);
  });

  it('rotation alone moves no momentum between body axes: the rotating-frame fluid load belongs to the hull model', () => {
    // WHY: an earlier WORLD-frame memory conserved Kirchhoff's R·A·Rᵀ·v through rotations. The hull model
    // supplies the same physics as the rotating-frame section load m_a·N·(ω×v) (hullWater), so both at
    // once double-counted it (a hull at rest drifted 3.7 m in 30 s). With constant A the memory must
    // be exactly the doc's plain division, rotating or not.
    const m = 1000;
    const body: Rigid6Body = { mass: m, inertia: [2000, 2500, 1500] };
    const A: Vec3 = [30, 4 * m, 50];
    const force = (_s: Rigid6State, _h: number, out: { addedMass: Vec3; force: Vec3; torque: Vec3 }): void => {
      out.addedMass[0] = A[0];
      out.addedMass[1] = A[1];
      out.addedMass[2] = A[2];
      out.force[1] += m * 9.81 + 400;
      out.torque[0] += 150;
    };
    const a = freeState([0, 0, 0, 1], [1.2, 0.3, 0], [0, 1, 5]);
    const b = freeState([0, 0, 0, 1], [1.2, 0.3, 0], [0, 1, 5]);
    const mem = createRigid6Memory();
    for (let t = 0; t < 600; t++) {
      stepRigid6(a, body, DT, 2, force, mem);
      stepRigid6(b, body, DT, 2, force, null);
    }
    expect(Math.hypot(a.velocity[0] - b.velocity[0], a.velocity[1] - b.velocity[1], a.velocity[2] - b.velocity[2])).toBeLessThan(1e-9);
    expect(Math.hypot(a.angularVelocity[0] - b.angularVelocity[0], a.angularVelocity[1] - b.angularVelocity[1], a.angularVelocity[2] - b.angularVelocity[2])).toBeLessThan(1e-9);
  });

  it('stepping is pure: two boats interleaved on one thread give bit-identical results to separate runs (V2, worker copy)', () => {
    // WHY: NPCs will be stepped in a worker; module scratch must carry nothing from one boat to the next.
    const body: Rigid6Body = { mass: 4500, inertia: [34000, 37000, 3700] };
    const load = (k: number) => (s: Rigid6State, _h: number, out: { force: Vec3; torque: Vec3; addedMass: Vec3; addedInertia: Vec3 }): void => {
      out.force[1] += 4500 * 9.81 + 800 * Math.sin(s.position[1] * 3 + k);
      out.torque[0] += 300 * Math.cos(s.velocity[1] + k);
      out.addedMass[1] = 2000 + 500 * Math.sin(s.position[1] + k);
      out.addedInertia[0] = 9000;
    };
    const run = (interleave: boolean): Rigid6State[] => {
      const s = [freeState([0, 0, 0, 1], [0.2, 0.1, 0], [0, 1, 20]), freeState(quatFromAxisAngle([0, 0, 1], 0.4), [0, -0.5, 0.3], [3, -2, 30])];
      const mem = [createRigid6Memory(), createRigid6Memory()];
      if (interleave) {
        for (let t = 0; t < 300; t++) for (let k = 0; k < 2; k++) stepRigid6(s[k], body, DT, 2, load(k), mem[k]);
      } else {
        for (let k = 0; k < 2; k++) for (let t = 0; t < 300; t++) stepRigid6(s[k], body, DT, 2, load(k), mem[k]);
      }
      return s;
    };
    const a = run(true);
    const b = run(false);
    for (let k = 0; k < 2; k++) {
      expect(a[k].position).toEqual(b[k].position);
      expect(a[k].quaternion).toEqual(b[k].quaternion);
      expect(a[k].velocity).toEqual(b[k].velocity);
      expect(a[k].angularVelocity).toEqual(b[k].angularVelocity);
    }
  });

  it('water leaving (A shrinking) hands no momentum back to the body (§V70: lost, not returned)', () => {
    const m = 1000;
    const body: Rigid6Body = { mass: m, inertia: [1, 1, 1] };
    const st = freeState([0, 0, 0, 1], [0, 0, 0], [0, 2, 0]);
    const mem = createRigid6Memory();
    let A = 4 * m;
    const force = (_s: Rigid6State, _h: number, out: { addedMass: Vec3; force: Vec3 }): void => {
      out.addedMass[1] = A;
      out.force[1] += m * 9.81;
    };
    for (let t = 0; t < 30; t++) {
      stepRigid6(st, body, DT, 2, force, mem);
      A = Math.max(0, A - 400);
    }
    expect(st.velocity[1]).toBeCloseTo(2, 9);
  });
});

describe('rigid6 coupled 6×6 added mass (T179)', () => {
  const m = 5000;
  const body: Rigid6Body = { mass: m, inertia: [60000, 60000, 7000] };

  it('a diagonal coupled matrix is exactly the per-axis step (the coupled path adds coupling, nothing else)', () => {
    // WHY: the coupled solve replaces diag(1/(m+A)) by (M+A6)⁻¹; with no off-diagonal terms both must agree,
    // or switching the hull model to the 6×6 would silently change heave/pitch/roll periods.
    const A: Vec3 = [800, 4000, 50];
    const I: Vec3 = [9000, 3000, 1500];
    const force = (coupled: boolean) => (s: Rigid6State, _h: number, out: Rigid6Load): void => {
      out.force[1] += m * 9.81 + 700 * Math.sin(s.position[1] * 4);
      out.force[2] += 300;
      // rotation about ONE principal axis (body x ≡ world x here): ω×(I·ω) = 0 in both paths
      out.torque[0] += 500 * Math.cos(s.velocity[1]);
      if (coupled && out.addedMass6) {
        out.coupled = true;
        for (let k = 0; k < 3; k++) {
          out.addedMass6[k * 7] = A[k];
          out.addedMass6[21 + k * 7] = I[k];
        }
      } else {
        for (let k = 0; k < 3; k++) {
          out.addedMass[k] = A[k];
          out.addedInertia[k] = I[k];
        }
      }
    };
    const a = freeState(quatFromAxisAngle([1, 0, 0], 0.3), [0.2, 0, 0], [1, 0.5, 8]);
    const b = freeState(quatFromAxisAngle([1, 0, 0], 0.3), [0.2, 0, 0], [1, 0.5, 8]);
    const ma = createRigid6Memory();
    const mb = createRigid6Memory();
    for (let t = 0; t < 120; t++) {
      stepRigid6(a, body, DT, 2, force(true), ma);
      stepRigid6(b, body, DT, 2, force(false), mb);
    }
    for (let k = 0; k < 3; k++) {
      expect(a.velocity[k]).toBeCloseTo(b.velocity[k], 9);
      expect(a.angularVelocity[k]).toBeCloseTo(b.angularVelocity[k], 9);
      expect(a.position[k]).toBeCloseTo(b.position[k], 9);
    }
  });

  it('with the rotating-frame loads A·(ω×v) − ω×(A·v) supplied, body + water momentum is conserved; without −ω×(A·v) it is not', () => {
    // WHY (T179 resting drift): rigid6 divides world accelerations by body-axis added mass. For water carried
    // by a rotating hull that alone does not conserve momentum; the hull model must add Kirchhoff's terms.
    // Pitching and heaving with no external horizontal force, P = m·v + R·A·Rᵀ·v must stay put.
    const A: number[][] = [
      [900, 0, 0],
      [0, 5000, 400],
      [0, 400, 300],
    ];
    const run = (withKirchhoff: boolean): number => {
      const s = freeState([0, 0, 0, 1], [0.4, 0, 0], [0, 0.5, 0.3]);
      const P = (): Vec3 => {
        const V = invRotateVec(s.quaternion, s.velocity);
        const AV: Vec3 = [0, 1, 2].map((r) => A[r][0] * V[0] + A[r][1] * V[1] + A[r][2] * V[2]) as Vec3;
        const pw = rotateVec(s.quaternion, AV);
        return [m * s.velocity[0] + pw[0], m * s.velocity[1] + pw[1], m * s.velocity[2] + pw[2]];
      };
      const P0 = P();
      let maxDev = 0;
      for (let t = 0; t < 600; t++) {
        stepRigid6(s, body, DT, 2, (ss, _h, out) => {
          const q = ss.quaternion as Quat;
          const V = invRotateVec(q, ss.velocity);
          const W = invRotateVec(q, ss.angularVelocity);
          const wxv: Vec3 = [W[1] * V[2] - W[2] * V[1], W[2] * V[0] - W[0] * V[2], W[0] * V[1] - W[1] * V[0]];
          const AV: Vec3 = [0, 1, 2].map((r) => A[r][0] * V[0] + A[r][1] * V[1] + A[r][2] * V[2]) as Vec3;
          const f: Vec3 = [0, 1, 2].map((r) => A[r][0] * wxv[0] + A[r][1] * wxv[1] + A[r][2] * wxv[2]) as Vec3;
          if (withKirchhoff) {
            f[0] -= W[1] * AV[2] - W[2] * AV[1];
            f[1] -= W[2] * AV[0] - W[0] * AV[2];
            f[2] -= W[0] * AV[1] - W[1] * AV[0];
          }
          const fw = rotateVec(q, f);
          for (let k = 0; k < 3; k++) out.force[k] += fw[k];
          out.force[1] += m * 9.81; // weight cancelled: no external force at all
          // a pitch spring keeps her rocking about body x
          const tw = rotateVec(q, [-60000 * 2 * q[0], 0, 0]);
          for (let k = 0; k < 3; k++) out.torque[k] += tw[k];
          if (out.addedMass6) {
            out.coupled = true;
            for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) out.addedMass6[r * 6 + c] = A[r][c];
          }
        }, null);
        const p = P();
        maxDev = Math.max(maxDev, Math.hypot(p[0] - P0[0], p[1] - P0[1], p[2] - P0[2]));
      }
      return maxDev / Math.hypot(...P0);
    };
    expect(run(true)).toBeLessThan(0.01);
    expect(run(false)).toBeGreaterThan(0.03);
  });

  it('a coupled matrix that is not positive definite throws instead of integrating garbage', () => {
    expect(() =>
      stepRigid6(freeState(), { mass: 1, inertia: [1, 1, 1] }, DT, 1, (_s, _h, out) => {
        if (!out.addedMass6) return;
        out.coupled = true;
        out.addedMass6[0] = -5;
      }),
    ).toThrow(/positive definite/);
  });
});

describe('rigid6 fail-loud guards', () => {
  const body: Rigid6Body = { mass: 1, inertia: [1, 1, 1] };
  it('rejects a non-integer or zero substep count', () => {
    expect(() => stepRigid6(freeState(), body, DT, 1.5, null)).toThrow(/substeps/);
    expect(() => stepRigid6(freeState(), body, DT, 0, null)).toThrow(/substeps/);
  });
  it('throws on a non-finite state instead of spreading NaN into the replay hash', () => {
    expect(() =>
      stepRigid6(freeState(), body, DT, 2, (_s, _h, out) => {
        out.force[0] = NaN;
      }),
    ).toThrow(/non-finite/);
  });
  it('does not allocate a new quaternion: consumers holding the arrays see the update', () => {
    const st = freeState([0, 0, 0, 1], [0, 1, 0]);
    const qRef = st.quaternion;
    stepRigid6(st, body, DT, 2, null);
    expect(st.quaternion).toBe(qRef);
    expect(quatMul(qRef, [0, 0, 0, 1])[1]).not.toBe(0);
  });
});
