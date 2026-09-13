/**
 * Hull↔water contact (src/sea-physics/hullWater.ts) + deep-V proxy (src/speedboat/hullMesh.ts)
 * — WHY these tests (docs/speedboat/tech-research.md §2, S1; docs/wake/wake-research.md V-W2):
 *
 * One clipped-triangle contact feeds the rigid body, the wake, spray and crash sensors. So it
 * has to be (a) exact where physics is exact — Archimedes for any pose, a symmetric body cut
 * through its centre displaces half its volume in ANY orientation; (b) total over SO(3) —
 * loops, inversion and flight are ordinary poses, not special cases; (c) honest in the air —
 * no wet triangle, no force, no phantom support (§V54); (d) substep-invariant (proposed V103);
 * (e) bounded at the result (V110) and (f) the same numbers for every consumer: the wake's
 * samples sum to the force (V-W2). Each block fails if its mechanism is removed.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, quatMul, rotateVec } from '../src/core/quat';
import {
  buildDeepVHull,
  deadriseAt,
  deckHeight,
  halfBeamAt,
  deriveMassProperties,
  HULL_DATA,
  hullStations,
  keelLength,
  keelRiseAt,
  REFERENCE_DEEP_V,
  type DeepVHullSpec,
  type HullProxy,
  type HullStation,
} from '../src/speedboat/hullMesh';
import { HULL_WATER_DEFAULTS, HullWater, planingSubsteps, type HeightSampler, type HullWaterMesh } from '../src/sea-physics/hullWater';
import { createRigid6Memory, stepRigid6, type Rigid6State } from '../src/sea-physics/rigidBody';
import type { Quat, Vec3 } from '../src/state/simState';

const DT = 1 / 60;
const RHO = 1025;
const G = 9.81;
const FLAT: HeightSampler = () => 0;

function st(p: Vec3, q: Quat = [0, 0, 0, 1], v: Vec3 = [0, 0, 0], w: Vec3 = [0, 0, 0]): Rigid6State {
  return { position: [...p] as Vec3, quaternion: [...q] as Quat, velocity: [...v] as Vec3, angularVelocity: [...w] as Vec3 };
}

function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function randomQuat(r: () => number): Quat {
  const ax: Vec3 = [r() - 0.5, r() - 0.5, r() - 0.5];
  const l = Math.hypot(...ax);
  return quatFromAxisAngle([ax[0] / l, ax[1] / l, ax[2] / l], r() * 2 * Math.PI);
}

/** CG height where hydrostatic support = weight, at a fixed orientation (flat water) */
function equilibriumY(hull: HullWaterMesh, q: Quat, lo = -4, hi = 4): number {
  const hw = new HullWater(hull, { planing: false, viscous: false });
  for (let i = 0; i < 70; i++) {
    const mid = (lo + hi) / 2;
    const s = st([0, mid, 0], q);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT);
    if (hw.load.force[1] > hull.mass * G) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/** one tick with the contact as rigid6's force provider */
function tick(hw: HullWater, s: Rigid6State, mem: ReturnType<typeof createRigid6Memory>, N: number, sea = FLAT, extra?: (s: Rigid6State, out: { force: Vec3; torque: Vec3 }) => void): void {
  hw.samplePatch(sea, s, DT);
  stepRigid6(s, hw.mesh, DT, N, (ss, h, out) => {
    hw.evaluate(ss, h, out);
    if (extra) extra(ss, out);
  }, mem);
}

/** a closed box mesh (12 tris), centred on the origin */
function boxMesh(hx: number, hy: number, hz: number, mass: number): HullWaterMesh {
  const P: number[] = [];
  for (const x of [-hx, hx]) for (const y of [-hy, hy]) for (const z of [-hz, hz]) P.push(x, y, z);
  const idx = (x: number, y: number, z: number): number => (x * 4 + y * 2 + z);
  const faces: number[][] = [
    [idx(1, 0, 0), idx(1, 1, 0), idx(1, 1, 1), idx(1, 0, 1)], // +x
    [idx(0, 0, 0), idx(0, 0, 1), idx(0, 1, 1), idx(0, 1, 0)], // −x
    [idx(0, 1, 0), idx(0, 1, 1), idx(1, 1, 1), idx(1, 1, 0)], // +y
    [idx(0, 0, 0), idx(1, 0, 0), idx(1, 0, 1), idx(0, 0, 1)], // −y
    [idx(0, 0, 1), idx(1, 0, 1), idx(1, 1, 1), idx(0, 1, 1)], // +z
    [idx(0, 0, 0), idx(0, 1, 0), idx(1, 1, 0), idx(1, 0, 0)], // −z
  ];
  const T: number[] = [];
  for (const [a, b, c, d] of faces) T.push(a, b, c, a, c, d);
  const m = mass;
  return {
    positions: Float64Array.from(P),
    vertexCount: 8,
    indices: Uint16Array.from(T),
    triCount: 12,
    triStrip: new Int16Array(12).fill(-1),
    strips: { count: 0, dz: 1, zCentre: new Float64Array(0), chineHalfBeam: new Float64Array(0), keelY: new Float64Array(0) },
    mass: m,
    inertia: [(m * (4 * hy * hy + 4 * hz * hz)) / 12, (m * (4 * hx * hx + 4 * hz * hz)) / 12, (m * (4 * hx * hx + 4 * hy * hy)) / 12],
    propPoint: [0, -hy, -hz],
    propRadius: 0.1,
    transomZ: -hz,
    stemZ: hz,
  };
}

/** exact submerged volume of the ANALYTIC deep-V (not the mesh) at a no-heel pose; sinT = fwd·Ŷ */
function analyticVolume(spec: Readonly<DeepVHullSpec>, cgY: number, sinT: number, n = 4000): number {
  const cosT = Math.sqrt(1 - sinT * sinT);
  const H = deckHeight(spec);
  const dz = keelLength(spec) / n;
  let v = 0;
  for (let i = 0; i < n; i++) {
    const z = (i + 0.5) * dz;
    const b = halfBeamAt(spec, z);
    const ky = keelRiseAt(spec, z);
    const yk = cgY + (ky - spec.vcgAboveKeel) * cosT + (z - spec.lcgFromTransom) * sinT;
    const t = Math.min(-yk / cosT, H - ky);
    if (t <= 0) continue;
    const tanB = Math.tan(deadriseAt(spec, z));
    const dc = b * tanB;
    v += (t <= dc ? (t * t) / tanB : dc * b + (t - dc) * 2 * b) * dz;
  }
  return v;
}

describe('deep-V proxy hull (pure data)', () => {
  const hull = buildDeepVHull();

  it('is a closed, consistently wound manifold whose volume is the analytic hull volume', () => {
    // WHY: Σ −ρg·d·A·n̂ is Archimedes only on a closed surface; one flipped triangle is a
    // silent buoyancy error that reads as "sits a bit low".
    const edges = new Map<string, number>();
    for (let t = 0; t < hull.triCount; t++) {
      for (let e = 0; e < 3; e++) {
        const a = hull.indices[t * 3 + e];
        const b = hull.indices[t * 3 + ((e + 1) % 3)];
        edges.set(`${a},${b}`, (edges.get(`${a},${b}`) ?? 0) + 1);
      }
    }
    for (const [k, n] of edges) {
      const [a, b] = k.split(',');
      expect(n, `directed edge ${k} used ${n}×`).toBe(1);
      expect(edges.get(`${b},${a}`), `edge ${k} has no opposite`).toBe(1);
    }
    let vol = 0;
    const P = hull.positions;
    for (let t = 0; t < hull.triCount; t++) {
      const [a, b, c] = [hull.indices[t * 3], hull.indices[t * 3 + 1], hull.indices[t * 3 + 2]];
      vol +=
        (P[a * 3] * (P[b * 3 + 1] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3 + 1]) -
          P[a * 3 + 1] * (P[b * 3] * P[c * 3 + 2] - P[b * 3 + 2] * P[c * 3]) +
          P[a * 3 + 2] * (P[b * 3] * P[c * 3 + 1] - P[b * 3 + 1] * P[c * 3])) /
        6;
    }
    const full = analyticVolume(REFERENCE_DEEP_V, 10 /* whole hull below */, 0);
    // a CG 10 m up leaves nothing submerged; integrate the full section instead
    const H = deckHeight(REFERENCE_DEEP_V);
    const analyticFull = analyticVolume(REFERENCE_DEEP_V, -H - 1, 0);
    expect(full).toBe(0);
    expect(vol).toBeGreaterThan(0);
    expect(Math.abs(vol - analyticFull) / analyticFull).toBeLessThan(0.01);
  });

  it('the shared data file (render hull + physics) cannot drift: its offsets table IS the generator output, and it is the 12 m boat', () => {
    // WHY: Blender lofts the render hull from `stations`, physics builds from `spec`. One file, and
    // this pins the two halves of it together (§V77), so an edit to either shows up here.
    const gen = hullStations(HULL_DATA.spec);
    expect(HULL_DATA.stations.length).toBe(gen.length);
    for (let i = 0; i < gen.length; i++) {
      for (const k of Object.keys(gen[i]) as (keyof HullStation)[]) {
        expect(Math.abs(HULL_DATA.stations[i][k] - gen[i][k]), `station ${i} ${k}`).toBeLessThan(1e-6);
      }
    }
    // and the mesh vertices sit exactly on those stations (keel and +x chine, hull frame)
    for (let i = 0; i < gen.length; i++) {
      const v = i * 5;
      expect(hull.positions[v * 3 + 2] + REFERENCE_DEEP_V.lcgFromTransom).toBeCloseTo(gen[i].z, 9);
      expect(hull.positions[(v + 1) * 3]).toBeCloseTo(gen[i].chineHalfBeam, 9);
      expect(hull.positions[(v + 1) * 3 + 1] + REFERENCE_DEEP_V.vcgAboveKeel).toBeCloseTo(gen[i].chineY, 9);
    }
    // concept sign-off: 12 m LOA, 24°, chine beam 2.30 m; mass, CG and inertia are DERIVED from the
    // mass budget in the same file, so an edit to an item cannot leave the physics on stale numbers
    const mp = deriveMassProperties(HULL_DATA.massItems);
    expect(HULL_DATA.spec.length).toBe(12);
    expect(HULL_DATA.spec.deadriseDeg).toBe(24);
    expect(2 * HULL_DATA.spec.chineHalfBeam).toBeCloseTo(2.3, 6);
    expect(HULL_DATA.spec.mass).toBeCloseTo(mp.mass, 0);
    expect(HULL_DATA.spec.lcgFromTransom).toBeCloseTo(mp.cg[2], 3);
    expect(HULL_DATA.spec.vcgAboveKeel).toBeCloseTo(mp.cg[1], 3);
    expect(Math.abs(mp.cg[0])).toBeLessThan(1e-9); // symmetric budget: no heel at rest
    expect(HULL_DATA.spec.gyradiusPitchOverL! * 12).toBeCloseTo(Math.sqrt(mp.inertia[0] / mp.mass), 3);
    expect(HULL_DATA.spec.gyradiusRollOverB * 2.3).toBeCloseTo(Math.sqrt(mp.inertia[2] / mp.mass), 3);
    expect(HULL_DATA.spec.gyradiusYawOverL! * 12).toBeCloseTo(Math.sqrt(mp.inertia[1] / mp.mass), 3);
    expect(HULL_DATA.spec.mass).toBeGreaterThanOrEqual(5000);
    expect(HULL_DATA.spec.mass).toBeLessThanOrEqual(6000);
    // the physics prop point is the centreline equivalent of the three drives
    const data = HULL_DATA as unknown as { engines: { propPoint: { x: number; yAboveKeel: number; zFromTransom: number } }[]; renderOnly: { strakes: unknown[] }; derived: { beamOverall: number } };
    expect(data.engines.length).toBe(3);
    const mean = (f: (e: (typeof data.engines)[number]) => number): number => data.engines.reduce((a, e) => a + f(e), 0) / 3;
    expect(mean((e) => e.propPoint.x)).toBeCloseTo(0, 9);
    expect(-mean((e) => e.propPoint.zFromTransom)).toBeCloseTo(HULL_DATA.spec.propAftOfTransom, 9);
    expect(-mean((e) => e.propPoint.yAboveKeel)).toBeCloseTo(HULL_DATA.spec.propBelowKeel, 9);
    expect(data.renderOnly.strakes.length).toBe(3);
    expect(data.derived.beamOverall).toBeGreaterThanOrEqual(2.44);
    expect(data.derived.beamOverall).toBeLessThanOrEqual(2.51);
  });

  it('meets the collision-hull budget and carries its section table from the mesh (D12, §2.3)', () => {
    expect(hull.triCount).toBeLessThanOrEqual(300);
    expect(hull.strips.count).toBeGreaterThanOrEqual(12);
    for (let i = 0; i < hull.strips.count; i++) {
      // tabulated from the mesh, equal to the warped deadrise law at the strip centre (24° aft, 45° at the stem)
      expect(hull.strips.deadrise[i]).toBeCloseTo(deadriseAt(REFERENCE_DEEP_V, hull.strips.zCentre[i] + REFERENCE_DEEP_V.lcgFromTransom), 9);
      expect(hull.strips.chineHalfBeam[i]).toBeCloseTo(halfBeamAt(REFERENCE_DEEP_V, hull.strips.zCentre[i] + REFERENCE_DEEP_V.lcgFromTransom), 1);
    }
  });

  it('has the inertia of a real 12 m boat, not a tuned one (§V53 dimensionless)', () => {
    const [ip, iy, ir] = hull.inertia;
    const m = hull.mass;
    expect(Math.sqrt(ip / m) / REFERENCE_DEEP_V.length).toBeGreaterThanOrEqual(0.24);
    expect(Math.sqrt(ip / m) / REFERENCE_DEEP_V.length).toBeLessThanOrEqual(0.26);
    expect(Math.sqrt(ir / m) / hull.beam).toBeGreaterThanOrEqual(0.35);
    expect(Math.sqrt(ir / m) / hull.beam).toBeLessThanOrEqual(0.4);
    // a physical tensor: each principal moment ≤ the sum of the other two
    expect(iy).toBeLessThanOrEqual(ip + ir + 1e-6);
    expect(ip).toBeLessThanOrEqual(iy + ir);
    expect(ir).toBeLessThanOrEqual(ip + iy);
  });
});

describe('clipper exactness (hydrostatics)', () => {
  it('a box centred on the surface displaces exactly half its volume in ANY orientation, with no horizontal force', () => {
    // WHY: point symmetry makes this exact for every pose, so it exercises all 0/1/2/3-vertex
    // clip cases against a closed-form answer, not against the clipper's own output.
    const box = boxMesh(1.1, 0.6, 2.3, 1000);
    const V = 8 * 1.1 * 0.6 * 2.3;
    const hw = new HullWater(box, { planing: false, viscous: false });
    const r = rng(7);
    let partial = 0;
    for (let k = 0; k < 64; k++) {
      const s = st([r() * 5, 0, r() * 5], randomQuat(r));
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT);
      if (hw.waterline.count > 0) partial++;
      expect(Math.abs(hw.displacedVolume - V / 2) / V).toBeLessThan(1e-9);
      expect(hw.load.force[1]).toBeCloseTo((RHO * G * V) / 2, 4);
      expect(Math.abs(hw.load.force[0]) + Math.abs(hw.load.force[2])).toBeLessThan(1e-6 * hw.load.force[1]);
    }
    expect(partial).toBe(64);
  });

  it('a box of density 0.4 ρ floats at 0.4 of its height (±1%)', () => {
    const hy = 0.5;
    const box = boxMesh(1, hy, 2, 0.4 * RHO * (2 * 1) * (2 * hy) * (2 * 2));
    const y = equilibriumY(box, [0, 0, 0, 1]);
    const draft = hy - y;
    expect(Math.abs(draft - 0.4 * 2 * hy) / (0.4 * 2 * hy)).toBeLessThan(0.01);
  });

  it('a fully clear hull has no wet triangles and exactly zero load; fully sunk displaces its whole volume', () => {
    const box = boxMesh(1, 0.5, 2, 100);
    const hw = new HullWater(box);
    const up = st([0, 3, 0], randomQuat(rng(3)), [4, -2, 9], [1, 2, 3]);
    hw.samplePatch(FLAT, up, DT);
    hw.evaluate(up, DT);
    expect(hw.wet.count).toBe(0);
    expect(hw.waterline.count).toBe(0);
    expect([...hw.load.force, ...hw.load.torque, ...hw.load.addedMass, ...hw.load.addedInertia].every((x) => x === 0)).toBe(true);
    const down = st([0, -3, 0], randomQuat(rng(4)));
    hw.samplePatch(FLAT, down, DT);
    hw.evaluate(down, DT);
    expect(hw.displacedVolume).toBeCloseTo(8 * 1 * 0.5 * 2, 9);
  });
});

describe('reference hull statics', () => {
  const hull = buildDeepVHull();

  it('a mirror-symmetric hull at rest makes no yaw or roll torque (hydrostatic torque at the centre of pressure)', () => {
    // WHY: the centroid form depends on how a clipped quad is split, which follows the winding,
    // which is mirrored port vs starboard: measured −70 N·m of yaw at rest and 20° of yaw in 20 s.
    const hw = new HullWater(hull);
    for (const pitch of [0, 0.03, -0.05]) {
      for (const y of [0.1, 0.3, 0.5]) {
        const s = st([0, y, 0], quatFromAxisAngle([1, 0, 0], pitch));
        hw.samplePatch(FLAT, s, DT);
        hw.evaluate(s, DT);
        const ref = Math.max(Math.abs(hw.load.torque[0]), hull.mass * G * 0.01);
        expect(Math.abs(hw.load.torque[1]) / ref).toBeLessThan(1e-9);
        expect(Math.abs(hw.load.torque[2]) / ref).toBeLessThan(1e-9);
      }
    }
  });

  it('settles to the Archimedes draft: analytic displaced volume at the rest pose = m/ρ within 3%', () => {
    // WHY: the whole chain (mesh fidelity, clip, centre of pressure, integrator, 2D+t terms at
    // rest) must leave her where Archimedes puts her. The volume is measured on the ANALYTIC
    // hull at the settled pose, independent of the clipper. A test-side damper stands in for
    // the radiation damping this model does not have at zero speed (see report).
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const s = st([0, 0.3, 0]);
    for (let t = 0; t < 60 * 60; t++) {
      tick(hw, s, mem, 2, FLAT, (ss, out) => {
        for (let k = 0; k < 3; k++) {
          out.force[k] -= 3 * hull.mass * ss.velocity[k];
          out.torque[k] -= 3 * hull.inertia[0] * ss.angularVelocity[k];
        }
      });
    }
    const q = s.quaternion;
    const sinT = 2 * (q[1] * q[2] - q[3] * q[0]);
    const need = hull.mass / RHO;
    const vol = analyticVolume(REFERENCE_DEEP_V, s.position[1], sinT);
    expect(Math.abs(vol - need) / need).toBeLessThan(0.03);
    // at rest the only support is hydrostatic, so the clipped volume carries the weight exactly
    expect(Math.abs(hw.displacedVolume - need) / need).toBeLessThan(0.005);
    // LCG 3.3 m from the transom sits aft of the hull's LCB: she must trim by the stern
    expect(sinT).toBeGreaterThan(0);
    expect(Math.hypot(s.velocity[0], s.velocity[2])).toBeLessThan(1e-3);
  });

  it('floats upside-down at the deck-plane draft (±3%) and stays inverted when disturbed (capsize is a state, not a bug)', () => {
    const qInv: Quat = [0, 0, 1, 0]; // 180° about body z
    const y = equilibriumY(hull, qInv);
    const H = deckHeight(REFERENCE_DEEP_V);
    const deckDepth = -(y - (H - REFERENCE_DEEP_V.vcgAboveKeel));
    // the deck lid is flat and the sides are vertical above the chine: V = A_deck·d, A_deck from
    // the SAME piecewise-linear stations the mesh uses
    let aDeck = 0;
    const stn = hullStations(REFERENCE_DEEP_V);
    for (let i = 0; i + 1 < stn.length; i++) {
      aDeck += (stn[i].deckHalfBeam + stn[i + 1].deckHalfBeam) * (stn[i + 1].deckZ - stn[i].deckZ);
    }
    const expected = hull.mass / RHO / aDeck;
    expect(Math.abs(deckDepth - expected) / expected).toBeLessThan(0.03);

    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const tilt = quatMul(qInv, quatMul(quatFromAxisAngle([0, 0, 1], 0.09), quatFromAxisAngle([1, 0, 0], 0.05)));
    const s = st([0, y + 0.05, 0], tilt);
    let maxUpY = -1;
    for (let t = 0; t < 60 * 30; t++) {
      tick(hw, s, mem, 2);
      maxUpY = Math.max(maxUpY, rotateVec(s.quaternion, [0, 1, 0])[1]);
    }
    expect(maxUpY).toBeLessThan(-0.9);
  });

  it('heaves at 2π·√(m(1+a)/(ρg·A_wp)) ±10%, with a the added mass the SAME strips give (§V53, §V69)', () => {
    // A fore-aft symmetric prism (LCG at mid-length, no taper) so heave does not couple into
    // pitch; the reference hull couples (LCF ≠ LCG) and its crossings beat.
    const spec: DeepVHullSpec = { ...REFERENCE_DEEP_V, taperStart: 1, keelRiseStart: 1, warpStart: 1, stemRake: 0, lcgFromTransom: REFERENCE_DEEP_V.length / 2 };
    const prism = buildDeepVHull(spec);
    const y0 = equilibriumY(prism, [0, 0, 0, 1]);
    const probe = new HullWater(prism);
    const s0 = st([0, y0, 0]);
    probe.samplePatch(FLAT, s0, DT);
    probe.evaluate(s0, DT);
    const a = probe.load.addedMass[1] / prism.mass;
    const keel = -(y0 - spec.vcgAboveKeel);
    const tanB = Math.tan((spec.deadriseDeg * Math.PI) / 180);
    const aWp = 2 * Math.min(keel / tanB, spec.chineHalfBeam) * keelLength(spec);

    const hw = new HullWater(prism);
    const mem = createRigid6Memory();
    const s = st([0, y0 - 0.01, 0]);
    const ys: number[] = [];
    for (let t = 0; t < 60 * 12; t++) {
      tick(hw, s, mem, 2);
      ys.push(s.position[1] - y0);
    }
    const up: number[] = [];
    for (let i = 1; i < ys.length; i++) if (ys[i - 1] < 0 && ys[i] >= 0) up.push(i - ys[i] / (ys[i] - ys[i - 1]));
    expect(up.length).toBeGreaterThanOrEqual(3);
    const T = ((up[up.length - 1] - up[0]) / (up.length - 1)) * DT;
    const Tclosed = 2 * Math.PI * Math.sqrt((prism.mass * (1 + a)) / (RHO * G * aWp));
    const Tdry = 2 * Math.PI * Math.sqrt(prism.mass / (RHO * G * aWp));
    expect(Math.abs(T - Tclosed) / Tclosed).toBeLessThan(0.1);
    // the added mass is load-bearing: without it the period would be the "cork" one
    expect(T / Tdry).toBeGreaterThan(1.5);
  });
});

describe('total over SO(3) with contact (proposed V102)', () => {
  const hull = buildDeepVHull();

  for (const [name, axis] of [
    ['pitch', [1, 0, 0]],
    ['roll', [0, 0, 1]],
  ] as const) {
    it(`a 360° ${name} sweep at the waterline gives a finite, continuous force and torque`, () => {
      const hw = new HullWater(hull, { viscous: false });
      const sweep = (step: number): { F: Vec3[]; T: Vec3[]; jumpF: number; jumpT: number } => {
        const F: Vec3[] = [];
        const T: Vec3[] = [];
        for (let i = 0; i * step <= 360 + 1e-9; i++) {
          const s = st([0, 0, 0], quatFromAxisAngle([axis[0], axis[1], axis[2]], (i * step * Math.PI) / 180));
          hw.samplePatch(FLAT, s, DT);
          hw.evaluate(s, DT);
          expect(Number.isFinite(hw.load.force[1] + hw.load.torque[0] + hw.load.torque[2])).toBe(true);
          F.push([...hw.load.force] as Vec3);
          T.push([...hw.load.torque] as Vec3);
        }
        let jumpF = 0;
        let jumpT = 0;
        for (let i = 1; i < F.length; i++) {
          jumpF = Math.max(jumpF, Math.hypot(F[i][0] - F[i - 1][0], F[i][1] - F[i - 1][1], F[i][2] - F[i - 1][2]));
          jumpT = Math.max(jumpT, Math.hypot(T[i][0] - T[i - 1][0], T[i][1] - T[i - 1][1], T[i][2] - T[i - 1][2]));
        }
        return { F, T, jumpF, jumpT };
      };
      const range = (arr: Vec3[]): number => Math.max(...arr.map((v) => Math.hypot(...v)));
      const a = sweep(0.5);
      const b = sweep(0.25);
      // small steps, and CONTINUOUS: a real step in the load does not shrink with the angle step, a steep but continuous
      // one halves (the flat deck lid of the 1.30 m hull crossing the surface inverted at 184° pitch is 5.1% of the range
      // per 0.5°, 2.6% per 0.25° — steep, not a jump)
      expect(a.jumpF / range(a.F)).toBeLessThan(0.08);
      expect(a.jumpT / range(a.T)).toBeLessThan(0.08);
      expect(b.jumpF / a.jumpF, 'force: largest jump halves with the step').toBeLessThan(0.6);
      expect(b.jumpT / a.jumpT, 'torque: largest jump halves with the step').toBeLessThan(0.6);
      // 0° and 360° are the same pose
      const F = a.F;
      expect(Math.hypot(F[0][0] - F[F.length - 1][0], F[0][1] - F[F.length - 1][1], F[0][2] - F[F.length - 1][2])).toBeLessThan(1e-6 * range(F));
    });
  }

  it('20 random tumbles × 10 s through the surface: no NaN, unit quaternion, bounded result, samples = force', () => {
    const r = rng(1165);
    for (let k = 0; k < 20; k++) {
      const hw = new HullWater(hull);
      const mem = createRigid6Memory();
      const s = st([0, (r() - 0.5) * 2, 0], randomQuat(r), [(r() - 0.5) * 20, (r() - 0.5) * 10, (r() - 0.5) * 30], [(r() - 0.5) * 8, (r() - 0.5) * 8, (r() - 0.5) * 8]);
      for (let t = 0; t < 600; t++) {
        tick(hw, s, mem, 2);
        expect(Math.abs(Math.hypot(...s.quaternion) - 1)).toBeLessThan(1e-9);
        expect(hw.capScale).toBeLessThanOrEqual(1);
        let sum = 0;
        for (let j = 0; j < hw.wet.count; j++) sum += hw.wet.fy[j];
        expect(Math.abs(sum - hw.load.force[1])).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(hw.load.force[1])));
      }
    }
  });
});

describe('airborne', () => {
  it('no wet triangle ⇒ zero hydro load ⇒ the flight is the ballistic integration, bit for bit (§V54)', () => {
    const hull = buildDeepVHull();
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const a = st([0, 8, 0], quatFromAxisAngle([1, 0, 0], 0.4), [0, 6, 35], [0.3, 0.1, -0.2]);
    const b = st([0, 8, 0], quatFromAxisAngle([1, 0, 0], 0.4), [0, 6, 35], [0.3, 0.1, -0.2]);
    const memB = createRigid6Memory();
    for (let t = 0; t < 45; t++) {
      tick(hw, a, mem, 2);
      expect(hw.wet.count).toBe(0);
      expect(hw.load.force.every((x) => x === 0) && hw.load.torque.every((x) => x === 0)).toBe(true);
      stepRigid6(b, hull, DT, 2, (_s, _h, out) => void out, memB);
    }
    expect(a.position).toEqual(b.position);
    expect(a.quaternion).toEqual(b.quaternion);
    // and it IS a parabola: the CG after 0.75 s is where the closed form puts it (symplectic bias)
    const T = 45 * DT;
    expect(a.position[1]).toBeCloseTo(8 + 6 * T - 0.5 * G * T * T - 0.5 * G * (DT / 2) * T, 9);
  });
});

describe('substep invariance (proposed V103)', () => {
  const hull = buildDeepVHull();

  function planing(V: number, N: number): { trim: number; R: number; wet: number } {
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const s = st([0, 0.35, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, V]);
    let integ = 0;
    let sumT = 0;
    let sumR = 0;
    let sumW = 0;
    let n = 0;
    for (let t = 0; t < 60 * 20; t++) {
      const err = V - s.velocity[2];
      integ += err * DT;
      const thrust = Math.max(0, hull.mass * (2 * err + 0.8 * integ));
      tick(hw, s, mem, N, FLAT, (_ss, out) => {
        out.force[2] += thrust; // horizontal thrust through the CG (Savitsky's assumption)
      });
      if (t >= 60 * 15) {
        const q = s.quaternion;
        sumT += Math.asin(2 * (q[1] * q[2] - q[3] * q[0]));
        sumR += thrust;
        sumW += hw.wettedArea;
        n++;
      }
    }
    return { trim: sumT / n, R: sumR / n, wet: sumW / n };
  }

  it('running trim, resistance and wetted area at 25 m/s change < 2% between N = 2 and N = 4', () => {
    const a = planing(25, 2);
    const b = planing(25, 4);
    expect(Math.abs(a.trim - b.trim) / Math.abs(b.trim)).toBeLessThan(0.02);
    expect(Math.abs(a.R - b.R) / b.R).toBeLessThan(0.02);
    expect(Math.abs(a.wet - b.wet) / b.wet).toBeLessThan(0.02);
    expect(a.trim).toBeGreaterThan(0); // planing bow-up, not a wedge dug in by the head
  });

  function drop(N: number): { peak50: number; rebound: number } {
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const s = st([0, equilibriumY(hull, [0, 0, 0, 1]) + 3.6, 0]);
    // hydro vertical force resampled onto a 1 ms grid at SUBSTEP resolution (piecewise constant over
    // each substep), so the 50 ms window is the same physical window for every N
    const binsPerS = 1000;
    const bins = new Float64Array(4 * binsPerS);
    let t = 0;
    let wetSeen = false;
    let apex = -Infinity;
    for (let k = 0; k < 60 * 4; k++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, N, (ss, h, out) => {
        hw.evaluate(ss, h, out);
        const f = hw.load.force[1];
        const t1 = t + h;
        for (let bi = Math.floor(t * binsPerS); bi < Math.min(bins.length, Math.ceil(t1 * binsPerS)); bi++) {
          const lo = Math.max(t, bi / binsPerS);
          const hi = Math.min(t1, (bi + 1) / binsPerS);
          if (hi > lo) bins[bi] += f * (hi - lo);
        }
        t = t1;
      }, mem);
      if (hw.wet.count > 0) wetSeen = true;
      if (wetSeen && s.velocity[1] > 0) apex = Math.max(apex, s.position[1]);
    }
    let peak = 0;
    let win = 0;
    for (let i = 0; i < bins.length; i++) {
      win += bins[i];
      if (i >= 50) win -= bins[i - 50];
      peak = Math.max(peak, win / 0.05 / hull.mass - G);
    }
    return { peak50: peak, rebound: apex };
  }

  it('adaptive substeps (§2.6) key on sim state only, stay in [2, 4], and grow with B₃₃·dt/m_eff', () => {
    // NOTE (reported): with m_eff = m + A_heave from the same strips, B₃₃/m_eff ≤ U/L_wet, so the
    // doc's rule gives 2 at every physical speed measured (rest … 55 m/s); only an absurd speed
    // reaches the cap. Substep convergence at N = 2 is asserted separately above.
    const hw = new HullWater(hull);
    const at = (s: Rigid6State): number => {
      hw.resetMemory();
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2);
      return planingSubsteps(hw, s, DT);
    };
    expect(at(st([0, equilibriumY(hull, [0, 0, 0, 1]), 0]))).toBe(2);
    expect(at(st([0, 0.45, 0], [-Math.sin(0.015), 0, 0, Math.cos(0.015)], [0, 0, 55]))).toBe(2);
    const absurd = st([0, 0.3, 0], [0, 0, 0, 1], [0, 0, 1e4]);
    const n = at(absurd);
    expect(n).toBe(4);
    expect(at(absurd)).toBe(n); // same state, same answer (§V2)
  });

  it('drop from 3.6 m: 50 ms peak decel converges first-order (< 2% from N = 4, < 5% N 2→4) and she does not bounce (§V70)', () => {
    // The old observable differenced TICK-sampled velocity over 3 ticks, so where the first wet
    // substep fell inside a tick moved the peak: N2→4 read 1.8% (11 m), 2.3% (12 m) against a 2% gate,
    // and N4→8 3.2% after a 20 cm change of drop height. Deterministic, but a gate on aliasing noise
    // (the "flaky" full-suite red). Now the window is 50 ms of hydro force at substep resolution,
    // and what is left is clean FIRST-ORDER convergence (measured 16.26/16.43/16.53/16.57 g for
    // N 4/8/16/32; each doubling halves the change): N2→4 2.4%, N4→8 1.1%. So V103's 2% holds from
    // N = 4; at the adaptive default N = 2 the landing peak is 2.4% off (reported).
    const a = drop(2);
    const b = drop(4);
    const c = drop(8);
    expect(Math.abs(b.peak50 - c.peak50) / c.peak50).toBeLessThan(0.02);
    expect(Math.abs(a.peak50 - b.peak50) / b.peak50).toBeLessThan(0.05);
    // first order: the N2→4 change is about twice the N4→8 change (not noise, which would not scale)
    const ratio = Math.abs(a.peak50 - b.peak50) / Math.abs(b.peak50 - c.peak50);
    expect(ratio).toBeGreaterThan(1.5);
    expect(ratio).toBeLessThan(3);
    // the momentum exchange must dissipate: rebound apex (CG) < 15% of the drop above rest CG
    const rest = equilibriumY(hull, [0, 0, 0, 1]);
    expect((a.rebound - rest) / 3.6).toBeLessThan(0.15);
    expect(a.peak50).toBeGreaterThan(3 * G); // and there WAS an impact
  });
});

describe('one contact, every consumer; bounded; memory', () => {
  const hull = buildDeepVHull();

  it('the wake samples sum to the vertical hydro force: ∫ρg·h_P dA = ΣF_y (V-W2), planing and slamming', () => {
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const s = st([0, 1.2, 0], quatFromAxisAngle([1, 0, 0], -0.08), [0, -4, 20], [0.2, 0, 0]);
    let slams = 0;
    for (let t = 0; t < 120; t++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, hull, DT, 2, (ss, h, out) => {
        hw.evaluate(ss, h, out);
        if (hw.slamImpulse > 0) slams++;
        let sum = 0;
        for (let j = 0; j < hw.wet.count; j++) sum += hw.wet.fy[j];
        expect(Math.abs(sum - hw.load.force[1])).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(hw.load.force[1])));
      }, mem);
    }
    expect(slams).toBeGreaterThan(0);
  });

  it('wake load samples are ≥ 0 and integrate to the net vertical contact load, buried bow and inverted landing included (V101)', () => {
    // WHY: the wet samples' fy is signed (a submerged upward-facing face is pushed UP), and the wake's
    // source buffer clamps negatives — so ∫ρg·h dA would exceed the load exactly when a bow buries or a
    // hull lands inverted. The wake reads per-plan-column loads instead: the column under a plan point
    // carries the NET of its faces (hydrostatically ρg × submerged thickness ≥ 0).
    const cases: [string, Rigid6State, boolean][] = [
      ['upright planing', st([0, 0.45, 0], [-Math.sin(0.02), 0, 0, Math.cos(0.02)], [0, 0, 20]), false],
      ['buried bow', st([0, -0.2, 0], quatFromAxisAngle([1, 0, 0], 0.3), [0, -2, 15], [0.3, 0, 0]), true],
      ['inverted landing', st([0, -0.4, 0], quatMul([0, 0, 1, 0], quatFromAxisAngle([0, 0, 1], 0.4)), [0, -5, 8]), true],
      ['buried bow at rest (hydrostatic only)', st([0, -0.2, 0], quatFromAxisAngle([1, 0, 0], 0.3)), true],
    ];
    for (const [name, s, expectsNegativeFaces] of cases) {
      const hw = new HullWater(hull);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT / 2); // first call: no slam history
      hw.evaluate(s, DT / 2);
      const net = hw.load.force[1];
      let clampedWet = 0;
      let negatives = 0;
      for (let j = 0; j < hw.wet.count; j++) {
        clampedWet += Math.max(0, hw.wet.fy[j]);
        if (hw.wet.fy[j] < 0) negatives++;
      }
      let wakeSum = 0;
      for (let j = 0; j < hw.wake.count; j++) {
        expect(hw.wake.fy[j], `${name}: sample ${j}`).toBeGreaterThanOrEqual(0);
        wakeSum += hw.wake.fy[j];
      }
      expect(Math.abs(wakeSum - Math.max(0, net)), name).toBeLessThanOrEqual(1e-6 * Math.max(1, Math.abs(net)));
      if (expectsNegativeFaces) {
        // the scenario really has the defect the per-sample clamp would make
        expect(negatives, name).toBeGreaterThan(0);
        expect(clampedWet, name).toBeGreaterThan(net * 1.01);
      }
    }
    // hydrostatically the column sums need NO clamping: the per-cell split is the physical one
    const rest = new HullWater(hull, { planing: false, viscous: false });
    const sr = st([0, -0.2, 0], quatFromAxisAngle([1, 0, 0], 0.3));
    rest.samplePatch(FLAT, sr, DT);
    rest.evaluate(sr, DT);
    expect(rest.wake.rescale).toBeGreaterThan(0.98);
    expect(rest.wake.rescale).toBeLessThanOrEqual(1 + 1e-12);
  });

  it('bounds the result (V110): force and torque scaled by ONE factor, samples too', () => {
    const hw = new HullWater(hull, { maxAccel: 5 * G });
    // teleported 2 m under at 30 m/s: raw buoyancy + slam far exceed 5 g
    const s = st([0, -2, 0], quatFromAxisAngle([0, 0, 1], 0.3), [0, -30, 10], [0, 0, 2]);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT / 2);
    const raw = hw.rawForce;
    expect(hw.capScale).toBeLessThan(1);
    expect(Math.hypot(...hw.load.force) / hull.mass).toBeLessThanOrEqual(5 * G * (1 + 1e-9));
    for (let k = 0; k < 3; k++) expect(hw.load.force[k]).toBeCloseTo(raw[k] * hw.capScale, 6);
    let sum = 0;
    for (let j = 0; j < hw.wet.count; j++) sum += hw.wet.fy[j];
    expect(sum).toBeCloseTo(hw.load.force[1], 3);
    // at rest the cap never engages
    const rest = new HullWater(hull);
    const r = st([0, equilibriumY(hull, [0, 0, 0, 1]), 0]);
    rest.samplePatch(FLAT, r, DT);
    rest.evaluate(r, DT);
    expect(rest.capScale).toBe(1);
  });

  it('slam and crossflow drag do not throw a hard landing back up, at one substep per tick and 10× the drag (V103)', () => {
    // WHY: both are velocity-level impulses (inelastic exchange; linearised implicit drag). The
    // explicit force form of the crossflow term bounced a 25 m/s flat entry to +20 m/s at N = 1.
    // LIMIT (measured, reported): one Gauss–Seidel sweep is not a converged solve — at C_Dc 100 a
    // 20° stern-first 30 m/s entry still rebounds at +12 m/s, at C_Dc 2000 a flat one at +10 m/s.
    for (const crossflowDrag of [1, 10]) {
      for (const N of [1, 2, 8]) {
        for (const [q, v] of [
          [[0, 0, 0, 1], [0, -25, 0]],
          [quatFromAxisAngle([1, 0, 0], -0.35), [0, -30, 40]],
        ] as [Quat, Vec3][]) {
          const hw = new HullWater(hull, { maxAccel: 1e9, maxAngularAccel: 1e9, crossflowDrag });
          const mem = createRigid6Memory();
          const s = st([0, 0.9, 0], q, v);
          let maxVy = -Infinity;
          for (let t = 0; t < 3; t++) {
            tick(hw, s, mem, N);
            maxVy = Math.max(maxVy, s.velocity[1]);
          }
          expect(maxVy, `C_Dc ${crossflowDrag} N ${N} v ${v}`).toBeLessThan(4);
        }
      }
    }
  });

  it('resetMemory (teleport, V108): the first contact after a reset exchanges no slam momentum', () => {
    const hw = new HullWater(hull);
    const air = st([0, 5, 0], [0, 0, 0, 1], [0, -6, 0]);
    hw.samplePatch(FLAT, air, DT);
    hw.evaluate(air, DT);
    const under = st([0, 0.2, 0], [0, 0, 0, 1], [0, -6, 0]);
    // without a reset, appearing in the water IS an entry
    hw.samplePatch(FLAT, under, DT);
    hw.evaluate(under, DT);
    expect(hw.slamImpulse).toBeGreaterThan(0);
    hw.resetMemory();
    hw.evaluate(under, DT);
    expect(hw.slamImpulse).toBe(0);
  });
});

describe('height patch and geometric outputs', () => {
  const hull = buildDeepVHull();

  /**
   * Worst (over heading) of: max over phase |F_y(patch) − F_y(fine)| / max over phase |F_y(fine) − F_y(flat)|,
   * i.e. the error relative to the wave heave force AMPLITUDE. (A per-phase ratio divides by the
   * wave force's own zero crossings — the 12 m hull nearly cancels an 8.3 m wave — and read 376%.)
   */
  function waveError(lambda: number, spacing: number): number {
    const k = (2 * Math.PI) / lambda;
    let worst = 0;
    for (const yaw of [0, 0.6, 1.3, 2.2]) {
      let maxWave = 0;
      let maxErr = 0;
      for (let ph = 0; ph < 16; ph++) {
        const sea: HeightSampler = (x, z) => 0.3 * Math.sin(k * (Math.cos(0.4) * x + Math.sin(0.4) * z) + (ph * Math.PI) / 8);
        const s = st([1.3, 0.3, -0.7], quatFromAxisAngle([0, 1, 0], yaw));
        const coarse = new HullWater(hull, { planing: false, viscous: false, patchSpacing: spacing });
        const fine = new HullWater(hull, { planing: false, viscous: false, patchSpacing: 0.05, patchMaxAxis: 400 });
        const flat = new HullWater(hull, { planing: false, viscous: false });
        for (const [hw, sampler] of [[coarse, sea], [fine, sea], [flat, FLAT]] as const) {
          hw.samplePatch(sampler, s, DT);
          hw.evaluate(s, DT);
        }
        expect(coarse.patch.outside).toBe(0);
        maxWave = Math.max(maxWave, Math.abs(fine.load.force[1] - flat.load.force[1]));
        maxErr = Math.max(maxErr, Math.abs(coarse.load.force[1] - fine.load.force[1]));
      }
      worst = Math.max(worst, maxErr / maxWave);
    }
    return worst;
  }

  it('the default patch reproduces the wave heave force of the sampled sea within 10% down to λ 8.3 m (§V50 sweep)', () => {
    // WHY 0.8 m (user decision, all boats): measured on the 12 m hull at λ 8.3 (the shortest mirrored
    // wave) the doc's 1.6 m patch is off by 17% of the wave heave force amplitude, 0.8 m by 4%;
    // λ 20: 2.6% → 0.5%. The sweep is over wavelength × heading × phase, not one cell (§V50).
    expect(waveError(8.3, HULL_WATER_DEFAULTS.patchSpacing)).toBeLessThanOrEqual(0.1);
    expect(waveError(20, HULL_WATER_DEFAULTS.patchSpacing)).toBeLessThan(0.02);
    // and the old spacing is what failed, so this test is about the spacing, not the sea
    expect(waveError(8.3, 1.6)).toBeGreaterThan(0.1);
  });

  it('the patch covers the hull through a whole tick at 45 m/s while yawing (no clamped reads)', () => {
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const sea: HeightSampler = (x, z) => 0.4 * Math.sin(0.3 * x + 0.1 * z);
    const s = st([0, 0.45, 0], [0, 0, 0, 1], [8, 0, 45], [0, 2.5, 0]);
    for (let t = 0; t < 60; t++) {
      tick(hw, s, mem, 3, sea);
      expect(hw.patch.outside).toBe(0);
      expect(hw.patch.du).toBeLessThanOrEqual(HULL_WATER_DEFAULTS.patchSpacing + 1e-9);
      expect(hw.patch.dw).toBeLessThanOrEqual(HULL_WATER_DEFAULTS.patchSpacing + 1e-9);
      expect(hw.patch.sampleCount).toBeLessThanOrEqual(200); // ~140 at 45 m/s for the 12 m hull
    }
  });

  it('waterline segments lie on the surface (no mid-air spray emitters) and wet centroids are below it', () => {
    const hw = new HullWater(hull);
    const s = st([0, 0.2, 0], quatFromAxisAngle([0, 0, 1], 0.3), [0, 0, 10]);
    hw.samplePatch(FLAT, s, DT);
    hw.evaluate(s, DT);
    expect(hw.waterline.count).toBeGreaterThan(10);
    for (let j = 0; j < hw.waterline.count; j++) {
      expect(Math.abs(hw.waterline.a[j * 3 + 1])).toBeLessThan(1e-9);
      expect(Math.abs(hw.waterline.b[j * 3 + 1])).toBeLessThan(1e-9);
    }
    for (let j = 0; j < hw.wet.count; j++) expect(hw.wet.centroid[j * 3 + 1]).toBeLessThan(1e-9);
  });

  it('prop immersion is 1 at rest, 0 when the transom is clear, and monotone in between (§3.1 ventilation input)', () => {
    const hw = new HullWater(hull);
    const y0 = equilibriumY(hull, [0, 0, 0, 1]);
    let prev = Infinity;
    for (let dy = 0; dy <= 1.5; dy += 0.05) {
      const s = st([0, y0 + dy, 0]);
      hw.samplePatch(FLAT, s, DT);
      hw.evaluate(s, DT);
      expect(hw.propImmersion).toBeLessThanOrEqual(prev + 1e-12);
      prev = hw.propImmersion;
      if (dy === 0) expect(hw.propImmersion).toBe(1);
    }
    expect(prev).toBe(0);
  });
});

/** Savitsky 1964 short form, prismatic hull, all forces through the CG (docs §2.4; scratch savitsky.mjs) */
function savitsky(
  mass: number,
  b: number,
  betaDeg: number,
  lcg: number,
  V: number,
): { Cv: number; tauDeg: number; R: number; lambda: number; chineWetLength: number; CLb: number } {
  const D = mass * G;
  const Cv = V / Math.sqrt(G * b);
  const CLb = D / (0.5 * RHO * V * V * b * b);
  let CL0 = CLb;
  for (let i = 0; i < 100; i++) CL0 = CLb + 0.0065 * betaDeg * Math.pow(CL0, 0.6);
  const lamFor = (tau: number): number => {
    let lo = 1e-4;
    let hi = 20;
    for (let i = 0; i < 80; i++) {
      const m = (lo + hi) / 2;
      const f = Math.pow(tau, 1.1) * (0.012 * Math.sqrt(m) + (0.0055 * Math.pow(m, 2.5)) / (Cv * Cv));
      if (f > CL0) hi = m;
      else lo = m;
    }
    return (lo + hi) / 2;
  };
  const lp = (tau: number): number => {
    const lam = lamFor(tau);
    return lam * b * (0.75 - 1 / ((5.21 * Cv * Cv) / (lam * lam) + 2.39));
  };
  let lo = 0.3;
  let hi = 25;
  for (let i = 0; i < 80; i++) {
    const m = (lo + hi) / 2;
    if (lp(m) > lcg) lo = m;
    else hi = m;
  }
  const tau = (lo + hi) / 2;
  const lam = lamFor(tau);
  const t = (tau * Math.PI) / 180;
  const beta = (betaDeg * Math.PI) / 180;
  const Re = (V * lam * b) / 1.19e-6;
  const Cf = 0.075 / Math.pow(Math.log10(Re) - 2, 2) + 0.0004;
  const Df = (0.5 * RHO * V * V * Cf * lam * b * b) / Math.cos(beta);
  // chine wetted length L_c = λb − b·tanβ/(2π·tanτ): < 0 ⇒ chines dry, outside Savitsky's data
  const chineWetLength = lam * b - (b * Math.tan(beta)) / (2 * Math.PI * Math.tan(t));
  return { Cv, tauDeg: tau, R: D * Math.tan(t) + Df / Math.cos(t), lambda: lam, chineWetLength, CLb };
}

describe('planing (2D+t + steady Garme + ITTC-57/ΔC_F) against the Savitsky oracle (proposed V104)', () => {
  // Savitsky assumes a PRISMATIC hull over the wetted length (keel wetted ≈ 10 m at C_v 3): the
  // oracle runs on the 12 m reference with its taper/keel rise moved beyond that.
  // Savitsky's β is the constant TRANSOM deadrise (24°): the warp is moved beyond the wetted length too
  const spec: DeepVHullSpec = { ...REFERENCE_DEEP_V, taperStart: 0.85, keelRiseStart: 0.88, warpStart: 0.88 };
  const hull: HullProxy = buildDeepVHull(spec);
  const b = 2 * spec.chineHalfBeam;
  const oracle = (V: number): ReturnType<typeof savitsky> => savitsky(spec.mass, b, spec.deadriseDeg, spec.lcgFromTransom, V);
  /** Savitsky's own data range: chines wet (L_c > 0), τ ≥ 2°, λ ≤ 4 */
  const valid = (o: ReturnType<typeof savitsky>): boolean => o.chineWetLength > 0 && o.tauDeg >= 2 && o.lambda <= 4;
  const cvs = [3.1, 3.7, 4.3, 5.0, 5.6, 6.0, 7.2, 9.3];

  /**
   * EQUILIBRIUM running attitude, which is what Savitsky gives. Two harness terms make the
   * comparison like-for-like and neither moves an equilibrium: (1) speed held at V by a surge force
   * through the CG (his thrust-through-CG assumption); (2) heave and pitch RATE damping, only to reach the
   * equilibrium sooner (it moves no equilibrium; free-running settling is tested separately); (3) the skin-friction moment about the CG removed — Savitsky's short form puts D_f through
   * the CG, the model applies it on the bottom 0.8 m below.
   */
  function equilibrium(V: number): { trimDeg: number; R: number; disp: number } {
    const o = oracle(V);
    const hw = new HullWater(hull);
    const mem = createRigid6Memory();
    const t0 = (o.tauDeg * Math.PI) / 360;
    const s = st([0, 0.3, 0], [-Math.sin(t0), 0, 0, Math.cos(t0)], [0, 0, V]);
    let sumT = 0;
    let sumR = 0;
    let sumD = 0;
    let n = 0;
    for (let t = 0; t < 60 * 30; t++) {
      hw.samplePatch(FLAT, s, DT);
      let drag = 0;
      stepRigid6(s, hull, DT, 2, (ss, h, out) => {
        hw.evaluate(ss, h, out);
        drag = -hw.load.force[2];
        out.force[2] += (hull.mass * (V - ss.velocity[2])) / h;
        out.force[1] -= 4 * hull.mass * ss.velocity[1];
        out.torque[0] -= 4 * hull.inertia[0] * ss.angularVelocity[0];
        for (let k = 0; k < 3; k++) out.torque[k] -= hw.frictionTorque[k] * hw.capScale;
      }, mem);
      if (t >= 60 * 24) {
        const q = s.quaternion;
        sumT += (Math.asin(2 * (q[1] * q[2] - q[3] * q[0])) * 180) / Math.PI;
        sumR += drag;
        sumD += hw.displacedVolume;
        n++;
      }
    }
    return { trimDeg: sumT / n, R: sumR / n, disp: sumD / n };
  }
  const results = cvs.map((cv) => {
    const V = cv * Math.sqrt(G * b);
    return { V, model: equilibrium(V), oracle: oracle(V) };
  });

  it('meets Savitsky within ±1.0° trim and ±25% resistance over its valid range, C_v 3.1–6.0 (V104)', () => {
    // Measured (signed-off 12 m hull, Garme's a_non 0.34): trim/R errors per C_v in the report; all within ±1°/±25%.
    // Outside the range (C_v 7.2, 9.3: chines dry, τ < 2°) Savitsky has no data; not asserted.
    const inRange = results.filter((r) => valid(r.oracle));
    expect(inRange.map((r) => r.oracle.Cv.toFixed(1))).toEqual(['3.1', '3.7', '4.3', '5.0', '5.6', '6.0']);
    for (const r of inRange) {
      expect(Math.abs(r.model.trimDeg - r.oracle.tauDeg), `trim at C_v ${r.oracle.Cv.toFixed(1)}`).toBeLessThanOrEqual(1);
      expect(Math.abs(r.model.R - r.oracle.R) / r.oracle.R, `R at C_v ${r.oracle.Cv.toFixed(1)}`).toBeLessThanOrEqual(0.25);
    }
    expect(results.filter((r) => !valid(r.oracle)).map((r) => r.oracle.Cv.toFixed(1))).toEqual(['7.2', '9.3']);
  });

  it('behaves like a planing hull: trim falls with speed, dynamic lift carries the weight, resistance rises', () => {
    for (let i = 1; i < results.length; i++) {
      expect(results[i].model.trimDeg).toBeLessThan(results[i - 1].model.trimDeg + 0.05);
      expect(results[i].model.R).toBeGreaterThan(results[i - 1].model.R);
    }
    // at C_v ≥ 5 less than a quarter of her weight is hydrostatic: she is ON the water, not in it
    for (const r of results.filter((x) => x.oracle.Cv >= 5)) expect(r.model.disp * RHO).toBeLessThan(0.25 * spec.mass);
  });

  function freeRun(h: HullProxy, cv: number, roll0: number, seconds: number): { pitch: number[]; roll: number[] } {
    const V = cv * Math.sqrt(G * b);
    const hw = new HullWater(h);
    const mem = createRigid6Memory();
    const s = st([0, 0.35, 0], quatMul(quatFromAxisAngle([1, 0, 0], -0.06), quatFromAxisAngle([0, 0, 1], roll0)), [0, 0, V]);
    const pitch: number[] = [];
    const roll: number[] = [];
    for (let t = 0; t < seconds * 60; t++) {
      hw.samplePatch(FLAT, s, DT);
      stepRigid6(s, h, DT, 2, (ss, hh, out) => {
        hw.evaluate(ss, hh, out);
        out.force[2] += (h.mass * (V - ss.velocity[2])) / hh; // hold U (Savitsky's thrust through the CG)
      }, mem);
      const q = s.quaternion;
      pitch.push((Math.asin(Math.max(-1, Math.min(1, 2 * (q[1] * q[2] - q[3] * q[0])))) * 180) / Math.PI);
      roll.push((Math.asin(Math.max(-1, Math.min(1, 2 * (q[0] * q[1] + q[3] * q[2])))) * 180) / Math.PI);
    }
    return { pitch, roll };
  }
  const amp = (a: number[], x: number, y: number): number => {
    const w = a.slice(x * 60, y * 60);
    return (Math.max(...w) - Math.min(...w)) / 2;
  };

  it('free-running in calm water from C_v 2.5 to 6 she settles to a steady trim: pitch amplitude ≤ 0.2° after 10 s, at 14, 28 and 56 strips', () => {
    // WHY (V80 — a property): a real deep-V runs steady here; the doc's porpoising criterion (§2.4,
    // τ_crit ≈ √(C_Lβ/2) for β = 0, higher with deadrise) puts the limit far above the running trim.
    // Root causes of the limit cycles this used to show (measured, reported):
    //  (1) V_n·dm_a/dt applied on entry only — halved the steady-flow heave/pitch damping U·sinτ·∂m_a/∂z;
    //  (2) Garme's steady transom reduction applied to the rate terms;
    //  (3) the ROTATING-FRAME part of m_a·∂V_n/∂t (m_a·N·(ω×v), for pitch m_a·q·u) was missing: rigid6's
    //      added mass only resists WORLD accelerations. That left a cycle at C_v 3.5–3.9 that GREW with
    //      strip refinement (0.39° → 0.87° at 14 → 56 strips) — the continuum model, not discretisation.
    // No damping is added; the refined-strip runs prove the fix is not numerical diffusion.
    const cases: [number, number[]][] = [
      [REFERENCE_DEEP_V.segments, [2.5, 3.1, 3.5, 3.7, 3.9, 4.3, 5.0, 5.6, 6.0]],
      [2 * REFERENCE_DEEP_V.segments, [3.5, 3.7, 3.9]],
      [4 * REFERENCE_DEEP_V.segments, [3.7]],
    ];
    for (const [segments, cvList] of cases) {
      const h = segments === hull.spec.segments ? hull : buildDeepVHull({ ...spec, segments });
      for (const cv of cvList) {
        const { pitch } = freeRun(h, cv, 0.005, 30);
        const mean = pitch.slice(600).reduce((x, y) => x + y, 0) / (pitch.length - 600);
        const limitDeg = (Math.sqrt(oracle(cv * Math.sqrt(G * b)).CLb / 2) * 180) / Math.PI;
        expect(mean, `${segments} seg C_v ${cv}: running trim below the porpoising limit`).toBeLessThan(limitDeg);
        expect(amp(pitch, 10, 30), `${segments} seg C_v ${cv}: pitch amplitude after 10 s`).toBeLessThanOrEqual(0.2);
        expect(amp(pitch, 25, 30), `${segments} seg C_v ${cv}: decaying, not a small limit cycle`).toBeLessThanOrEqual(Math.max(amp(pitch, 10, 15), 0.01));
      }
    }
  });

  it('roll: a 10° heel kick decays, no loll, no capsize, from C_v 3 to 10 in calm water (≤ 3° after 10 s)', () => {
    // WHY: a real deep-V at top speed chine-walks mildly and does not capsize in calm water. The strip-mean
    // 2D+t averaged the roll-rate normal velocity away across the keel (linearised roll damping −0.3
    // kN·m·s) and its roll stiffness went positive at C_v 10: ±27–31° limit cycle at C_v 8, capsize at 9–10.
    // The port/starboard half-sections restore roll damping (−5…−7 kN·m·s) and asymmetric-wedge restoring.
    const player = buildDeepVHull(); // the warped, raked reference hull the player drives
    for (const cv of [3.1, 4.3, 6.0, 8.0, 10.0]) {
      const { roll } = freeRun(player, cv, (10 * Math.PI) / 180, 40);
      const mean = roll.slice(20 * 60).reduce((x, y) => x + y, 0) / (roll.length - 20 * 60);
      expect(amp(roll, 10, 40), `C_v ${cv}: roll amplitude after 10 s`).toBeLessThanOrEqual(3);
      expect(Math.abs(mean), `C_v ${cv}: no loll`).toBeLessThanOrEqual(3);
      expect(amp(roll, 30, 40), `C_v ${cv}: decaying`).toBeLessThanOrEqual(amp(roll, 10, 20) + 0.01);
    }
  });
});
