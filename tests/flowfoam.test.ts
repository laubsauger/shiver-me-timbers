/**
 * §V10 flow-foam invariants, verified against the pure CPU mirror
 * (src/flowfoam/flowMath.ts) of the GPU compute math. WHY each matters:
 * - divergence-poor flow: advection must swirl foam outward/downstream, not
 *   pile it into sinks (bright hotspots) or tear vacuum holes — mass moves,
 *   only decay removes it.
 * - determinism (§V2): same world position + time → same flow vector, or
 *   replays/multiplayer would advect different wakes from the same state.
 * - region-shift math: foam is a WORLD-anchored effect rendered in a sliding
 *   window; if recentering moved texel content, wakes would smear along with
 *   the ship instead of staying behind it in the water.
 * - decay factor: half-life must be frame-rate independent or trail length
 *   would change with fps.
 * - params bounds (§V16): every tunable registered with sane Tweakpane meta.
 */
import { describe, expect, it } from 'vitest';
import {
  advectLookupUv,
  farBlendWeightCpu,
  flowPotentialCpu,
  flowVectorCpu,
  regionEdgeFadeCpu,
  regionShiftUv,
  snapToTexel,
  uvForWorld,
  worldForUv,
  type FlowFieldParams,
} from '../src/flowfoam/flowMath';
import {
  bowMoundCpu,
  projectOnTrack,
  smoothstepCpu as smooth,
  wakeBreakupCpu,
  wakeEnvelopeCpu,
  wakeRateCpu,
  wakeReachCpu,
  wakeTrailCpu,
  type WakeHull,
  type WakeParams,
} from '../src/flowfoam/wakeMath';
import {
  KELVIN_HALF_ANGLE_DEG,
  bandKeepCpu,
  slickDampCpu,
  slickFieldCpu,
  transverseWavelengthCpu,
  type SlickParams,
} from '../src/flowfoam/slickMath';
import {
  COARSEN_MAX_MUL,
  TRACK_CAPACITY,
  advanceTrack,
  approachExp,
  createWakeTrack,
  trackBounds,
  trackPoints,
  trackReachCpu,
  trackSpacingAt,
  type TrackConfig,
  type TrackSample,
} from '../src/flowfoam/wakeTrack';
import { decayFactorPerFrame } from '../src/foam/foamMath';
import { flowFoamParams } from '../src/params/flowfoam';
import { getParamsEntry } from '../src/params/registry';

const P: FlowFieldParams = {
  noiseScale: 0.06,
  noiseStrength: 3,
  noiseScrollSpeed: 0.4,
  baseFlowSpeed: 0.8,
  curlStep: 1.2,
};
const T = 1.7;
const DIR: [number, number] = [0, 1];

/** forward-difference divergence of the flow field with probe step h */
function divergenceAt(x: number, z: number, h: number, p: FlowFieldParams): number {
  const v0 = flowVectorCpu(x, z, T, DIR[0], DIR[1], p);
  const vx = flowVectorCpu(x + h, z, T, DIR[0], DIR[1], p);
  const vz = flowVectorCpu(x, z + h, T, DIR[0], DIR[1], p);
  return (vx[0] - v0[0]) / h + (vz[1] - v0[1]) / h;
}

describe('flow noise pseudo-curl (§V10 advection field)', () => {
  it('divergence vanishes exactly at the matching stencil step', () => {
    // v = (∂ψ/∂z, −∂ψ/∂x) via forward differences with step e: probing the
    // divergence with the SAME step e makes the ψ cross-terms cancel
    // algebraically, so only f64 rounding remains. Tolerance 1e-12 (measured
    // residual ~1e-17). This is the "no sources/sinks" guarantee.
    for (let x = -60; x <= 60; x += 15) {
      for (let z = -60; z <= 60; z += 15) {
        expect(Math.abs(divergenceAt(x, z, P.curlStep, P))).toBeLessThan(1e-12);
      }
    }
  });

  it('divergence-poor vs a gradient field at a mismatched probe step', () => {
    // With probe step h ≠ e the cancellation is only approximate. Compare
    // against the WORST construction from the same potential — the raw
    // gradient (pure source/sink field). Measured mean-|div| ratio ≈ 0.047;
    // tolerance 0.15 leaves ~3× margin for noise-octave/param drift while
    // still failing if someone replaces the curl with a gradient lookup.
    const h = P.curlStep / 3;
    const curlOnly: FlowFieldParams = { ...P, baseFlowSpeed: 0 };
    const e = P.curlStep;
    const grad = (x: number, z: number): [number, number] => {
      const p0 = flowPotentialCpu(x, z, T, DIR[0], DIR[1], P);
      const px = flowPotentialCpu(x + e, z, T, DIR[0], DIR[1], P);
      const pz = flowPotentialCpu(x, z + e, T, DIR[0], DIR[1], P);
      return [((px - p0) / e) * P.noiseStrength, ((pz - p0) / e) * P.noiseStrength];
    };
    let divCurl = 0;
    let divGrad = 0;
    let mag = 0;
    let n = 0;
    for (let x = -60; x <= 60; x += 10) {
      for (let z = -60; z <= 60; z += 10) {
        divCurl += Math.abs(divergenceAt(x, z, h, curlOnly));
        const g0 = grad(x, z);
        const gx = grad(x + h, z);
        const gz = grad(x, z + h);
        divGrad += Math.abs((gx[0] - g0[0]) / h + (gz[1] - g0[1]) / h);
        const v = flowVectorCpu(x, z, T, DIR[0], DIR[1], curlOnly);
        mag += Math.hypot(v[0], v[1]);
        n++;
      }
    }
    expect(mag / n).toBeGreaterThan(0.01); // field is not trivially zero
    expect(divCurl / divGrad).toBeLessThan(0.15);
  });

  it('flow is deterministic and time/scroll-dependent (§V2)', () => {
    const a = flowVectorCpu(12.5, -33.1, T, DIR[0], DIR[1], P);
    const b = flowVectorCpu(12.5, -33.1, T, DIR[0], DIR[1], P);
    expect(b).toEqual(a); // bit-identical: pure function of inputs
    const later = flowVectorCpu(12.5, -33.1, T + 5, DIR[0], DIR[1], P);
    expect(later).not.toEqual(a); // scrolling potential animates the eddies
  });

  it('base flow adds exactly dir·baseFlowSpeed on top of the curl', () => {
    // WHY: setFlowDir carries ship velocity/current — the wake must trail
    // downstream at a predictable speed the params panel can reason about.
    const still: FlowFieldParams = { ...P, baseFlowSpeed: 0 };
    const c = flowVectorCpu(4, 9, T, DIR[0], DIR[1], still);
    const withBase = flowVectorCpu(4, 9, T, DIR[0], DIR[1], P);
    expect(withBase[0]).toBeCloseTo(c[0] + DIR[0] * P.baseFlowSpeed, 12);
    expect(withBase[1]).toBeCloseTo(c[1] + DIR[1] * P.baseFlowSpeed, 12);
  });
});

describe('region window math (§V10 world anchoring)', () => {
  const size = 120;
  const res = 512;
  const texel = size / res;

  it('worldForUv inverts uvForWorld (v axis flips world z)', () => {
    const [u, v] = uvForWorld(12.34, -37.71, 10, -40, size);
    const [wx, wz] = worldForUv(u, v, 10, -40, size);
    expect(wx).toBeCloseTo(12.34, 10);
    expect(wz).toBeCloseTo(-37.71, 10);
    // orientation contract: +z world → smaller v (ortho camera up = (0,0,−1))
    const [, vNorth] = uvForWorld(12.34, -37.71 + 1, 10, -40, size);
    expect(vNorth).toBeLessThan(v);
  });

  it('snapToTexel lands on the texel grid within half a texel', () => {
    const c = snapToTexel(37.777, size, res);
    expect(Math.abs(c / texel - Math.round(c / texel))).toBeLessThan(1e-9);
    expect(Math.abs(c - 37.777)).toBeLessThanOrEqual(texel / 2 + 1e-12);
  });

  it('after a setCenter jump the shift maps a world point to the same texel', () => {
    // WHY: the advect pass reads previous-frame foam through this shift; if
    // it were wrong by even one texel, standing foam would crawl with the
    // ship instead of staying anchored in the water.
    const c1: [number, number] = [snapToTexel(10.3, size, res), snapToTexel(-40.2, size, res)];
    const c2: [number, number] = [
      snapToTexel(c1[0] + 37.53, size, res),
      snapToTexel(c1[1] - 12.24, size, res),
    ];
    const w: [number, number] = [12.34, -37.71];
    const uv1 = uvForWorld(w[0], w[1], c1[0], c1[1], size);
    const uv2 = uvForWorld(w[0], w[1], c2[0], c2[1], size);
    const shift = regionShiftUv(c1[0], c1[1], c2[0], c2[1], size);
    expect(uv2[0] + shift[0]).toBeCloseTo(uv1[0], 12);
    expect(uv2[1] + shift[1]).toBeCloseTo(uv1[1], 12);
    // snapped centers → shift is an exact texel offset → identical texel index
    expect(Math.floor((uv2[0] + shift[0]) * res)).toBe(Math.floor(uv1[0] * res));
    expect(Math.floor((uv2[1] + shift[1]) * res)).toBe(Math.floor(uv1[1] * res));
  });

  it('advect lookup: zero flow = pure shift, flow moves foam downstream', () => {
    const [u0, v0] = advectLookupUv(0.5, 0.5, 0, 0, 0.4, size, 0.01, -0.02);
    expect(u0).toBeCloseTo(0.51, 12);
    expect(v0).toBeCloseTo(0.48, 12);
    // backward lookup: flow +x → source LEFT of the texel (foam moves +x);
    // flow +z → source at LARGER v (v axis flips world z) — this encodes the
    // uv/world orientation shared by the GPU pass and material sampling.
    const [u1, v1] = advectLookupUv(0.5, 0.5, 2, 3, 0.4, size, 0, 0);
    expect(u1).toBeLessThan(0.5);
    expect(v1).toBeGreaterThan(0.5);
  });
});

describe('decay factor (§V10 accumulation fade, shared with §V6)', () => {
  it('halves after exactly one half-life of fixed ticks', () => {
    const dt = 1 / 60;
    const f = decayFactorPerFrame(3.0, dt);
    expect(Math.pow(f, 3.0 / dt)).toBeCloseTo(0.5, 9);
  });

  it('is frame-rate independent: two half-steps equal one full step', () => {
    // WHY: wake trail length must not depend on fps (§V2 fixed tick).
    const f1 = decayFactorPerFrame(3.0, 1 / 30);
    const f2 = decayFactorPerFrame(3.0, 1 / 60);
    expect(f2 * f2).toBeCloseTo(f1, 12);
  });

  it('non-positive half-life kills foam instantly instead of dividing by zero', () => {
    expect(decayFactorPerFrame(0, 1 / 60)).toBe(0);
    expect(decayFactorPerFrame(-1, 1 / 60)).toBe(0);
  });
});

// The SHIPPED defaults, not a hand-picked fixture: WakeParams is a structural
// subset of FlowFoamParams, so spreading it means these tests validate what the
// game actually runs. A tuning pass that breaks an invariant (aft inside the
// Kelvin wedge, shoulder meeting the arms, no saturation) now fails here.
const WP: WakeParams = { ...flowFoamParams };
/** galleon-ish: bow z=+12, stern z=−10 → 22 m between stem and transom */
const HULL: WakeHull = { length: 22, beam: 6 };
const CFG: TrackConfig = {
  capacity: TRACK_CAPACITY,
  spacing: WP.trackSpacing,
  life: WP.trackLife,
  minSpeed: WP.speedThreshold,
  maxTurn: (6 * Math.PI) / 180,
  coarsen: WP.trackCoarsen,
  coarsenStart: WP.trackCoarsenStart,
};
const TAN = Math.tan((WP.kelvinAngle * Math.PI) / 180);
const DT = 1 / 60;

/**
 * Drive the track like the game does: `legs` of (heading, seconds) sailed at
 * `speed`, integrating the cutwater position at the fixed tick. Returns the
 * GPU-facing polyline (live pose prepended) and where the cutwater ended up.
 */
function sail(
  legs: { fx: number; fz: number; seconds: number }[],
  speed: number,
  start: [number, number] = [0, 0],
): { points: TrackSample[]; x: number; z: number; fx: number; fz: number } {
  const t = createWakeTrack();
  const pose = { x: start[0], z: start[1], fx: 0, fz: 1, speed };
  for (const leg of legs) {
    pose.fx = leg.fx;
    pose.fz = leg.fz;
    for (let i = 0; i < Math.round(leg.seconds / DT); i++) {
      pose.x += leg.fx * speed * DT;
      pose.z += leg.fz * speed * DT;
      advanceTrack(t, pose, DT, CFG);
    }
  }
  return { points: trackPoints(t, pose), x: pose.x, z: pose.z, fx: pose.fx, fz: pose.fz };
}

describe('wake track: the water remembers (§V10 follow-up, user regression)', () => {
  // THE bug this whole model exists to kill. User, twice: "the trail we leave
  // in the water is very statically moving and immediately spraying out at a
  // new angle at full distance", "as if it's actually propelled out of the air
  // when you turn". The old wake was a ship-LOCAL shape evaluated along the
  // live heading, so a turn re-pointed every metre of already-laid wake.

  it('THE PRIZE: a deposit made at heading A is still at heading A after the turn', () => {
    // The single claim the whole rework rests on, driven the way the hull now
    // actually behaves: the physics agent's yaw builds over ~1 s and carries
    // past the helm, so the heading SWEEPS instead of snapping. Every sample
    // is checked against the heading recorded at the instant it was laid.
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 6 };
    const laidAt = new Map<TrackSample, number>(); // sample → yaw when deposited
    let yaw = 0;

    const tick = () => {
      pose.fx = Math.sin(yaw);
      pose.fz = Math.cos(yaw);
      pose.x += pose.fx * pose.speed * DT;
      pose.z += pose.fz * pose.speed * DT;
      const before = t.samples[0];
      advanceTrack(t, pose, DT, CFG);
      if (t.samples[0] !== before) laidAt.set(t.samples[0], yaw);
    };

    for (let i = 0; i < 360; i++) tick(); // 6 s due north at heading A = 0
    const turnTicks = Math.round(1.5 / DT); // ~1 s yaw ramp, eased in and out
    for (let i = 1; i <= turnTicks; i++) {
      yaw = (Math.PI / 2) * smooth(0, 1, i / turnTicks);
      tick();
    }
    for (let i = 0; i < 360; i++) tick(); // 6 s due east at heading B = π/2

    let fromA = 0;
    let fromTurn = 0;
    let fromB = 0;
    for (const s of t.samples) {
      const when = laidAt.get(s);
      expect(when).toBeDefined();
      // the deposit still carries the heading it was laid with, exactly
      expect(s.fx).toBe(Math.sin(when!));
      expect(s.fz).toBe(Math.cos(when!));
      if (when! === 0) fromA++;
      else if (when! === Math.PI / 2) fromB++;
      else fromTurn++;
    }
    // all three populations coexist: heading-A water astern, heading-B water at
    // the stem, and the arc between them — the trail is a history, not a shape.
    // A is the oldest and therefore the most aggressively thinned by the
    // distance grading, so it is measured by EXTENT rather than sample count.
    expect(fromTurn).toBeGreaterThan(3);
    expect(fromB).toBeGreaterThan(3);
    expect(fromA).toBeGreaterThanOrEqual(2);
    const aDists = t.samples.filter((s) => laidAt.get(s) === 0).map((s) => s.dist);
    expect(Math.max(...aDists) - Math.min(...aDists)).toBeGreaterThan(20);

    // and the turn is deposited as a CURVE: read oldest → newest, the stored
    // headings climb smoothly from A to B with no hinge bigger than trackTurn
    const headings = [...t.samples].reverse().map((s) => Math.atan2(s.fx, s.fz));
    for (let i = 1; i < headings.length; i++) {
      expect(headings[i]).toBeGreaterThanOrEqual(headings[i - 1] - 1e-9);
      expect(headings[i] - headings[i - 1]).toBeLessThan((CFG.maxTurn * 180) / Math.PI);
    }
    expect(headings[0]).toBeCloseTo(0, 9);
    expect(headings[headings.length - 1]).toBeCloseTo(Math.PI / 2, 9);
  });

  it('a deposited sample never moves or re-orients, whatever the ship does after', () => {
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 6 };
    for (let i = 0; i < 60; i++) {
      pose.z += 6 * DT;
      advanceTrack(t, pose, DT, CFG);
    }
    const frozen = t.samples.map((s) => ({ ...s }));
    // now turn hard to starboard and keep sailing
    pose.fx = 1;
    pose.fz = 0;
    for (let i = 0; i < 60; i++) {
      pose.x += 6 * DT;
      advanceTrack(t, pose, DT, CFG);
    }
    for (const old of frozen) {
      const still = t.samples.find((s) => s.x === old.x && s.z === old.z);
      expect(still).toBeDefined();
      expect(still!.fx).toBe(old.fx); // heading at emission, not the live one
      expect(still!.fz).toBe(old.fz);
      expect(still!.speed).toBe(old.speed);
      expect(still!.age).toBeGreaterThan(old.age); // only ageing may change it
      expect(still!.dist).toBeGreaterThan(old.dist); // and arclength to the stem
    }
  });

  it('after a 90° turn the wake follows the PATH, not the new heading', () => {
    // Sail 6 s north (+z), then 6 s east (+x) — an L-shaped track. A wake
    // parented to the current heading would lie ~36 m astern along −x; the
    // real one lies along the northward leg it was actually laid on.
    const s = sail(
      [
        { fx: 0, fz: 1, seconds: 6 },
        { fx: 1, fz: 0, seconds: 6 },
      ],
      6,
    );
    expect(s.x).toBeCloseTo(36, 6);
    expect(s.z).toBeCloseTo(36, 6);

    const onOldLeg = wakeEnvelopeCpu(s.points, 0, 20, HULL, WP); // 52 m back along the path
    const behindNewHeading = wakeEnvelopeCpu(s.points, -16, 36, HULL, WP); // 52 m astern
    expect(onOldLeg).toBeGreaterThan(0);
    expect(behindNewHeading).toBe(0);

    // and the old leg is still oriented the OLD way: a point 3 m to its east
    // reads +3 m starboard of a NORTHBOUND track (right = (fz, −fx) = (1, 0))
    const proj = projectOnTrack(s.points, 3, 20);
    expect(proj.found).toBe(true);
    expect(proj.lateral).toBeCloseTo(3, 6);
    expect(proj.dist).toBeCloseTo(52, 6); // 16 m to the corner + 36 m of new leg
  });

  it('the SHIP-LOCAL model fails these exact probes — the test discriminates', () => {
    // Archived copy of the wake this module used to inject: a V + stern band
    // evaluated in the ship's LIVE frame out to wakeRange metres. Kept here
    // (and nowhere else) so the regression above is provably not vacuous — it
    // must be RED for the old shape and GREEN for the track model. Old
    // defaults: wakeRange 40, slowWakeWidth 0.3, bowIntensity 0.5,
    // sternIntensity 0.2, armWidth 0.6, armWidthGrowth 0.045, sternWidth 0.6.
    const shipLocalWakeRef = (
      wx: number,
      wz: number,
      ship: { x: number; z: number; yaw: number; speed: number },
    ): number => {
      const [bowOffset, sternOffset, beam] = [12, -10, 6];
      const gate = smooth(0.5, 1.0, ship.speed);
      const sf = smooth(0.5, 5.0, ship.speed);
      const widthScale = 0.3 + 0.7 * sf;
      const range = 40 * widthScale;
      const fx = Math.sin(ship.yaw);
      const fz = Math.cos(ship.yaw);
      const dx = wx - ship.x;
      const dz = wz - ship.z;
      const along = dx * fx + dz * fz;
      const across = dx * fz - dz * fx;
      const sBow = bowOffset - along;
      const armW = (0.6 + sBow * 0.045) * widthScale;
      const bow =
        sBow < 0
          ? 0
          : 0.5 *
            ship.speed *
            sf *
            (1 - smooth(0, armW, Math.abs(Math.abs(across) - sBow * TAN))) *
            (1 - smooth(0, range, sBow));
      const sStern = sternOffset - along;
      const stern =
        sStern < 0
          ? 0
          : 0.2 *
            ship.speed *
            ship.speed *
            (1 - smooth(0, beam * 0.6 * 0.5 * widthScale, Math.abs(across))) *
            (1 - smooth(0, range, sStern));
      return (bow + stern) * gate;
    };

    const s = sail(
      [
        { fx: 0, fz: 1, seconds: 6 },
        { fx: 1, fz: 0, seconds: 6 },
      ],
      6,
    );
    // the ship ORIGIN is bowOffset behind the cutwater, heading +x (yaw π/2)
    const ship = { x: s.x - 12, z: s.z, yaw: Math.PI / 2, speed: 6 };
    const onOldLeg: [number, number] = [0, 20]; // 52 m back along the PATH
    const behindNewHeading: [number, number] = [-16, 36]; // 52 m dead astern

    // OLD: nothing where the ship actually sailed, a full rooster tail hanging
    // off the current heading in water the hull never touched — the bug.
    expect(shipLocalWakeRef(...onOldLeg, ship)).toBe(0);
    expect(shipLocalWakeRef(...behindNewHeading, ship)).toBeGreaterThan(0);
    // NEW: exactly inverted.
    expect(wakeEnvelopeCpu(s.points, ...onOldLeg, HULL, WP)).toBeGreaterThan(0);
    expect(wakeEnvelopeCpu(s.points, ...behindNewHeading, HULL, WP)).toBe(0);
  });

  it('the rooster tail BUILDS UP over travel instead of snapping to full length', () => {
    // User: "instead of it taking a while to build up after the turn". The old
    // model injected the full wakeRange the instant the ship moved.
    const reach = (secs: number): number => {
      const s = sail([{ fx: 0, fz: 1, seconds: secs }], 6);
      let far = 0;
      for (let d = 0; d <= 90; d += 0.5) {
        for (let y = -30; y <= 30; y += 0.5) {
          if (wakeEnvelopeCpu(s.points, y, s.z - d, HULL, WP) > 0) far = Math.max(far, d);
        }
      }
      return far;
    };
    const early = reach(1); // 6 m travelled
    const mid = reach(4); // 24 m
    const late = reach(9); // 54 m
    // after 1 s the trail is a few metres long — it cannot exceed what we
    // sailed (plus an arm half-width). The old ship-local model painted its
    // full 40 m wakeRange on frame one, which is exactly the reported bug.
    expect(early).toBeLessThanOrEqual(10);
    expect(mid).toBeGreaterThan(early + 8);
    expect(late).toBeGreaterThan(mid + 8);
  });

  it('the V opens with travel: fresh track is narrow, old track is wide', () => {
    // same build-up, measured laterally — the arms have to be walked outward
    const s = sail([{ fx: 0, fz: 1, seconds: 9 }], 6);
    const widthAt = (d: number): number => {
      let w = 0;
      for (let y = 0; y <= 30; y += 0.25) {
        if (wakeEnvelopeCpu(s.points, y, s.z - d, HULL, WP) > 0) w = y;
      }
      return w;
    };
    expect(widthAt(4)).toBeLessThan(widthAt(20));
    expect(widthAt(20)).toBeLessThan(widthAt(45));
    // the crest tracks the Kelvin angle: arm centre at dist·tan θ
    for (const d of [15, 30, 45]) {
      expect(wakeEnvelopeCpu(s.points, d * TAN, s.z - d, HULL, WP)).toBeGreaterThan(0);
      expect(wakeEnvelopeCpu(s.points, d * TAN + 8, s.z - d, HULL, WP)).toBe(0);
    }
  });

  it('samples age out, capacity is capped, a teleport resets instead of streaking', () => {
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 8 };
    for (let i = 0; i < 60 * 30; i++) {
      pose.z += 8 * DT;
      advanceTrack(t, pose, DT, CFG);
    }
    expect(t.samples.length).toBeLessThanOrEqual(CFG.capacity); // GPU loop bound
    expect(t.samples.length).toBeGreaterThan(2);
    for (const s of t.samples) expect(s.age).toBeLessThanOrEqual(CFG.life + DT);
    // ages/dists must stay monotone — the GPU interpolates along them
    for (let i = 1; i < t.samples.length; i++) {
      expect(t.samples[i].age).toBeGreaterThan(t.samples[i - 1].age);
      expect(t.samples[i].dist).toBeGreaterThan(t.samples[i - 1].dist);
    }
    pose.x += 5000; // respawn across the map
    advanceTrack(t, pose, DT, CFG);
    expect(t.samples.length).toBeLessThanOrEqual(1);
  });

  it('no track, no wake: a ship at anchor is not ringed by foam', () => {
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 0.2 }; // below minSpeed
    for (let i = 0; i < 600; i++) advanceTrack(t, pose, DT, CFG);
    expect(t.samples).toHaveLength(0);
    const pts = trackPoints(t, pose);
    expect(wakeEnvelopeCpu(pts, 0, -14, HULL, WP)).toBe(0);
    expect(wakeRateCpu(pts, 3, -30, HULL, WP)).toBe(0);
    expect(trackBounds(pts, 40)).toBeNull(); // → GPU skips the segment walk
  });

  it('non-finite ship state is ignored, never written into the track (§V28)', () => {
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 6 };
    for (let i = 0; i < 120; i++) {
      pose.z += 6 * DT;
      advanceTrack(t, pose, DT, CFG);
    }
    const before = t.samples.length;
    advanceTrack(t, { x: NaN, z: 0, fx: 0, fz: 1, speed: 6 }, DT, CFG);
    advanceTrack(t, { x: 0, z: 0, fx: 0, fz: 1, speed: NaN }, DT, CFG);
    expect(t.samples).toHaveLength(before);
    for (const s of t.samples) {
      expect(Number.isFinite(s.x + s.z + s.fx + s.fz + s.age + s.dist + s.speed)).toBe(true);
    }
  });
});

describe('wake field in the track frame (bow vs aft, §V10 follow-up)', () => {
  const STRAIGHT = sail([{ fx: 0, fz: 1, seconds: 9 }], 6);
  /** wake at a point `d` metres back along the (northbound) track, `y` abeam */
  const at = (d: number, y: number, s = STRAIGHT) =>
    wakeEnvelopeCpu(s.points, y, s.z - d, HULL, WP);

  it('the disturbance starts AT the cutwater, not metres aft of it', () => {
    // User: "the bow wake is not appearing far enough at the front... the very
    // front of the boat is perfectly clean most of the time." The live pose is
    // prepended to the polyline, so dist = 0 exists every frame.
    expect(at(0, 0)).toBeGreaterThan(0);
    expect(at(0.5, 0.4)).toBeGreaterThan(0);
  });

  it('the bow MOUND leads the stem — water is shoved ahead of the hull', () => {
    // User: "there's some sort of reaction with the water actually being
    // thrown away forwards from more or less the spearhead of the boat".
    // Negative d = ahead of the stem.
    expect(at(-WP.moundLead, 0)).toBeGreaterThan(0); // crest, ahead of the stem
    // the crest is the PEAK: water piles up against the stem and thins going
    // forward, so the mound is strongest at moundLead, not at the hull
    expect(at(-WP.moundLead, 0)).toBeGreaterThan(at(-WP.moundLead - WP.moundThick * 0.8, 0));
    // ...and the sea well ahead of the mound is still untouched
    expect(at(-(WP.moundLead + WP.moundThick + 1), 0)).toBe(0);
  });

  it('the mound peels outboard and hands over to the Kelvin arms', () => {
    // "must connect visually and continuously to the stern churn and the
    // trailing wake". The crest sweeps aft as it goes outboard, so at the
    // outboard edge it has crossed behind the stem and meets the arms.
    const outboard = WP.moundSpan * 0.7;
    const crestAt = (aside: number) => WP.moundLead - WP.moundSweep * aside;
    expect(crestAt(outboard)).toBeLessThan(0); // tips are abaft the stem
    expect(at(-crestAt(outboard), outboard)).toBeGreaterThan(0);
    // and it does NOT extend indefinitely sideways — the arms take over
    expect(at(-crestAt(outboard), WP.moundSpan + 2)).toBe(0);
    // no gap between the mound's aft edge and the cutwater core on the keel
    // line: sweep from ahead of the stem to well behind it, all wetted
    for (let d = -WP.moundLead; d <= WP.cutLength * 0.5; d += 0.25) {
      expect(at(d, 0)).toBeGreaterThan(0);
    }
  });

  it('the mound rides a LAGGED speed so it builds and subsides, never pops', () => {
    // User wants a heavier, more inertial ship: the mound must follow the
    // hull's motion, not snap to a throttle value.
    const probe: [number, number] = [0, STRAIGHT.z + WP.moundLead]; // on the crest
    const amp = (ms: number) =>
      wakeEnvelopeCpu(STRAIGHT.points, probe[0], probe[1], HULL, WP, ms);
    expect(amp(6)).toBeGreaterThan(amp(3)); // taller mound for a faster hull
    expect(amp(3)).toBeGreaterThan(amp(1.5));
    expect(amp(0)).toBe(0); // dead in the water, no mound
    // the lag itself: a step in speed is approached, not jumped to
    let ms = 0;
    for (let i = 0; i < 30; i++) ms = approachExp(ms, 6, DT, WP.moundLag);
    expect(ms).toBeGreaterThan(0.2);
    expect(ms).toBeLessThan(5.4); // half a second in, nowhere near settled
    // ...and it is frame-rate independent (exact under subdivision)
    const full = approachExp(2, 6, 0.2, WP.moundLag);
    const halves = approachExp(approachExp(2, 6, 0.1, WP.moundLag), 6, 0.1, WP.moundLag);
    expect(halves).toBeCloseTo(full, 12);
  });

  it('the mound is emitted at the live stem, so it never trails the old heading', () => {
    // The mound is the ONE feature read off the live pose. It must therefore
    // sit at the CURRENT stem after a turn — the deposited trail behind it is
    // what keeps the old orientation (tested above).
    const turned = sail(
      [
        { fx: 0, fz: 1, seconds: 6 },
        { fx: 1, fz: 0, seconds: 6 },
      ],
      6,
    );
    const head = turned.points[0];
    // the mound is on the crest ahead of the CURRENT stem, along +x...
    expect(bowMoundCpu(head, turned.x + WP.moundLead, turned.z, 6, WP)).toBeGreaterThan(0);
    // ...and there is no leftover mound at the corner where the ship turned,
    // nor one still pointing the old way (+z) from the current stem
    expect(bowMoundCpu(head, 0, 36 + WP.moundLead, 6, WP)).toBe(0);
    expect(bowMoundCpu(head, turned.x, turned.z + WP.moundSpan + 2, 6, WP)).toBe(0);
  });

  it('bow and aft disturbances are emitted at DIFFERENT spots', () => {
    // User: "a clear distinction between the disturbance caused by the front of
    // the boat and that caused by the aft — they're also emitted in different
    // spots." Aft features cannot exist until the hull has gone by.
    const dMid = HULL.length * 0.5; // amidships
    const dAft = HULL.length + 12; // well aft of the transom
    // Amidships the water carries TWO SEPARATED CRESTS: foam on the arms, a
    // gap between them and the keel line, nothing on the centreline (the hull
    // is still sitting there).
    expect(at(dMid, dMid * TAN)).toBeGreaterThan(0);
    expect(at(dMid, dMid * TAN * 0.4)).toBe(0); // the gap
    expect(at(dMid, 0)).toBe(0);
    // Aft of the transom it is ONE FILLED BAND about a beam wide, centreline
    // included — a different shape from a different emission point.
    for (const y of [0, HULL.beam * 0.25, HULL.beam * 0.45]) {
      expect(at(dAft, y)).toBeGreaterThan(0);
    }
  });

  it('shed vortices alternate port/starboard (von Kármán street, not a band)', () => {
    // the aft's signature: discrete lobes off the transom corners, sides half a
    // period apart. A symmetric result here would mean the street collapsed
    // into the churn band and aft would read the same as bow again.
    const lobe = HULL.beam * 0.5 * WP.vortexOffset;
    const d0 = HULL.length + WP.vortexSpacing * 0.25; // starboard puff peak
    const d1 = d0 + WP.vortexSpacing * 0.5; // port puff peak
    const stbd0 = at(d0, lobe + 0.6);
    const port0 = at(d0, -(lobe + 0.6));
    const stbd1 = at(d1, lobe + 0.6);
    const port1 = at(d1, -(lobe + 0.6));
    expect(stbd0).toBeGreaterThan(port0);
    expect(port1).toBeGreaterThan(stbd1);
  });

  it('the V reads strongest close to the hull (hullBoost, user review)', () => {
    // User: "V-arm readability near the hull is still weak"; wanted a "heaving
    // water out" feel. Intensity on the arm crest must fall off with distance.
    const near = at(6, 6 * TAN);
    const far = at(50, 50 * TAN);
    expect(near).toBeGreaterThan(far * 1.5);
    // and turning hullBoost off must measurably weaken exactly that
    const flat = wakeEnvelopeCpu(
      STRAIGHT.points,
      6 * TAN,
      STRAIGHT.z - 6,
      HULL,
      { ...WP, hullBoost: 0 },
    );
    expect(flat).toBeLessThan(near);
  });

  it('slow drift: faint aft churn only, no developed V (user review)', () => {
    // "if we're going very slow we wouldn't see it spread out to the side;
    // only some slight disturbance at the aft."
    const slow = sail([{ fx: 0, fz: 1, seconds: 40 }], 1.1);
    const onArm = wakeEnvelopeCpu(slow.points, 25 * TAN, slow.z - 25, HULL, WP);
    const churn = wakeEnvelopeCpu(slow.points, 0, slow.z - (HULL.length + 8), HULL, WP);
    expect(churn).toBeGreaterThan(0);
    expect(onArm).toBeLessThan(churn * 0.15);
  });

  it('the envelope is port/starboard symmetric apart from the vortex street', () => {
    // WHY: the bow V and the churn band must be symmetric about the keel line
    // or the ship looks like it permanently cuts harder on one side. Only the
    // shed street (tested above) and the world-anchored breakup may differ.
    const noStreet: WakeParams = { ...WP, vortexIntensity: 0 };
    for (const d of [2, 10, 25, 44]) {
      for (const y of [1.5, 4, 9]) {
        const s = wakeEnvelopeCpu(STRAIGHT.points, y, STRAIGHT.z - d, HULL, noStreet);
        const pgt = wakeEnvelopeCpu(STRAIGHT.points, -y, STRAIGHT.z - d, HULL, noStreet);
        expect(s).toBeCloseTo(pgt, 9);
      }
    }
  });

  it('LENGTH: the trail reaches hundreds of metres, not ~100 (user review)', () => {
    // User: "disappearing too immediately... not fading out over a long enough
    // distance." Uniform 2.2 m spacing spent all 48 samples in 105 m. Distance
    // grading buys the reach without touching the GPU loop bound, which is the
    // constraint that actually matters (§V17).
    expect(trackReachCpu(CFG)).toBeGreaterThan(400);
    const uniform = trackReachCpu({ ...CFG, coarsenStart: 1e9 }); // grading off
    expect(uniform).toBeLessThan(120);
    expect(trackReachCpu(CFG) / uniform).toBeGreaterThan(3);
    // the near field keeps FULL resolution — grading may not cost near detail
    expect(trackSpacingAt(0, CFG)).toBe(0); // 0 = never thinned
    expect(trackSpacingAt(CFG.coarsenStart - 1, CFG)).toBe(0);
    expect(trackSpacingAt(CFG.coarsenStart + 1, CFG)).toBeGreaterThan(0);
    // ...and the grade is BOUNDED, or thinning never reaches a fixed point
    expect(trackSpacingAt(1e6, CFG)).toBe(CFG.spacing * COARSEN_MAX_MUL);
  });

  it('thinning reaches a FIXED POINT — the track cannot collapse to its ends', () => {
    // The bug this caught: with an unbounded grade, `required(dist)` outgrows
    // every gap however often it has already been thinned, so each tick drops
    // more samples than are laid and the whole history collapses to 2 points.
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed: 8 };
    for (let i = 0; i < 60 * 120; i++) {
      pose.z += 8 * DT;
      advanceTrack(t, pose, DT, CFG);
    }
    expect(t.samples.length).toBeGreaterThan(20); // a real history, not 2 ends
    expect(t.samples.length).toBeLessThanOrEqual(CFG.capacity);
    expect(t.samples[t.samples.length - 1].dist).toBeGreaterThan(300);
    // every surviving gap respects the grade (no runaway thinning)
    for (let i = 1; i < t.samples.length - 1; i++) {
      const gap = Math.hypot(
        t.samples[i].x - t.samples[i - 1].x,
        t.samples[i].z - t.samples[i - 1].z,
      );
      expect(gap).toBeLessThanOrEqual(CFG.spacing * COARSEN_MAX_MUL * 2 + 1e-6);
    }
  });

  it('AFT STRUCTURE never pans out past the Kelvin wedge (user review)', () => {
    // User: "the structure of it, especially in the back... maybe it's panning
    // out too heavily." The Kelvin half-angle is a physical constant and is
    // speed-INDEPENDENT; turbulent spread is a rate, so uncapped it overtakes
    // the wedge — worst at LOW speed, where the ship travels little per second.
    // isolate the aft features: no bow mound, cutwater, arms or shoulder
    const aftOnly: WakeParams = {
      ...WP,
      bowIntensity: 0,
      cutIntensity: 0,
      shoulderIntensity: 0,
      moundIntensity: 0,
    };
    for (const speed of [1.2, 3, 6, 10]) {
      const s = sail([{ fx: 0, fz: 1, seconds: 60 }], speed);
      for (let d = HULL.length + 1; d <= 200; d += 2) {
        const cap = HULL.beam * 0.5 + WP.aftSpreadCap * d * TAN;
        // churn and shed vortices stay inside the capped wedge at EVERY speed
        expect(wakeEnvelopeCpu(s.points, cap + WP.vortexWidth + 0.5, s.z - d, HULL, aftOnly, 0)).toBe(0);
        // and the whole wake stays inside the Kelvin arms themselves
        const beyondArms = d * TAN + WP.armWidthMax + WP.cutWidth + 1;
        expect(wakeEnvelopeCpu(s.points, beyondArms, s.z - d, HULL, WP, 0)).toBe(0);
      }
    }
    // the cap BINDS at low speed — that is the case it exists for (turbulent
    // spread is a rate, the wedge is a slope, so slow ships are where an
    // uncapped churn overtakes the V)
    const slowAge = 60;
    expect(HULL.beam * 0.5 * WP.sternWidth + WP.sternSpread * slowAge).toBeGreaterThan(
      HULL.beam * 0.5 + WP.aftSpreadCap * 30 * TAN,
    );
    // and the arm THICKNESS is capped, so the V stays a V far astern
    expect(WP.armWidth + WP.armWidthGrowth * 400).toBeGreaterThan(WP.armWidthMax);
  });

  it('SHOULDER: displaced water runs the whole forebody and meets the arms', () => {
    // User: "it doesn't really feel like we're actually pushing away and
    // displacing water to the side... reads as if the boat is flying through
    // the water instead of plowing through it."
    const halfBeam = HULL.beam * 0.5;
    // a continuous band of foam pressed OUT along the hull side, sustained the
    // whole length of the forebody rather than a dab at the stem
    for (let d = 2; d <= WP.shoulderLength * 0.5; d += 1) {
      const off =
        halfBeam * smooth(0, WP.shoulderEntry, d) +
        WP.shoulderPush * smooth(0, WP.shoulderLength, d);
      expect(at(d, off)).toBeGreaterThan(0);
      expect(off).toBeGreaterThan(0);
    }
    // it is pressed OUTBOARD of the hull side by the end of the forebody
    const endOff =
      halfBeam * smooth(0, WP.shoulderEntry, WP.shoulderLength) +
      WP.shoulderPush * smooth(0, WP.shoulderLength, WP.shoulderLength);
    expect(endOff).toBeGreaterThan(halfBeam);
    // ...and hands over to the Kelvin arms: at the end of the forebody the arm
    // crest has diverged to roughly the same offset, so there is no gap or step
    expect(Math.abs(endOff - WP.shoulderLength * TAN)).toBeLessThan(WP.shoulderWidth);
    // turning the shoulder off measurably empties the hull sides
    const flat: WakeParams = { ...WP, shoulderIntensity: 0 };
    const mid = WP.shoulderLength * 0.4;
    const midOff = halfBeam * smooth(0, WP.shoulderEntry, mid) + WP.shoulderPush * smooth(0, WP.shoulderLength, mid);
    expect(wakeEnvelopeCpu(STRAIGHT.points, midOff, STRAIGHT.z - mid, HULL, flat, 0)).toBeLessThan(
      at(mid, midOff),
    );
  });

  it('ACCUMULATION must not saturate into a formless slab (user screenshots)', () => {
    // THE BUG THIS PINS: foam under a sustained source settles at
    // `rate × halfLife/ln2`. Raising decayHalfLife 2.8 → 14 s multiplied every
    // equilibrium by 5 and pinned the whole region to 1.0 — the user saw "a
    // large oval cloud of dense white foam" with no taper, detached-looking,
    // because a saturated mask has no structure left and all you see is the
    // region's edge fade. Injection rates and decay are COUPLED; neither can be
    // tuned alone. Simulating the accumulation is the only way to catch it.
    const decay = decayFactorPerFrame(flowFoamParams.decayHalfLife, DT);
    const farDecay = decayFactorPerFrame(flowFoamParams.farDecayHalfLife, DT);
    const speed = 8.2; // ~16 knots, the speed in the screenshots
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed };
    // a transect across the wake, 30 m astern of the stem, world-anchored
    const probes = Array.from({ length: 25 }, (_, i) => ({ x: -24 + i * 2, near: 0, far: 0 }));
    const probeZ = speed * 40 - 30; // 30 m astern of where the ship ENDS
    let ms = 0;
    for (let step = 0; step < 40 / DT; step++) {
      pose.z += speed * DT;
      advanceTrack(t, pose, DT, CFG);
      ms = approachExp(ms, speed, DT, flowFoamParams.moundLag);
      const pts = trackPoints(t, pose);
      for (const p of probes) {
        const r = wakeRateCpu(pts, p.x, probeZ, HULL, WP, ms);
        p.near = Math.min(1, p.near * decay + r * DT);
        p.far = Math.min(1, p.far * farDecay + r * DT * flowFoamParams.farInject);
      }
    }
    const near = probes.map((p) => p.near);
    const far = probes.map((p) => p.far * flowFoamParams.farStrength);
    // 1. nothing pins to white — that is the slab
    expect(Math.max(...near)).toBeLessThan(0.98);
    expect(Math.max(...far)).toBeLessThan(0.98);
    // 2. ...but 30 m astern the wake is still plainly THERE and readable
    expect(Math.max(...near)).toBeGreaterThan(0.2);
    // 3. and it has STRUCTURE: wet and dry across the same transect, which a
    //    saturated region cannot have however it is tuned
    expect(near.filter((v) => v > 0.15).length).toBeGreaterThan(0);
    expect(near.filter((v) => v < 0.05).length).toBeGreaterThan(0);
    // 4. the tiers are BRIGHTNESS-MATCHED in the handover band. This replaces
    //    an older "far must be fainter" rule: a fainter far tier is exactly
    //    what produced the visible step at the near window's border. What the
    //    seamless handover actually requires is that they agree.
    const n = Math.max(...near);
    const f = Math.max(...far);
    expect(Math.abs(f - n)).toBeLessThan(n * 0.3);
  });

  it('HOVE TO: a stopped hull generates no wake and the sea recovers', () => {
    // User's unambiguous acceptance test: "if you're stationary then it should
    // be like a very very very tiny amount around the hull directly, if
    // anything." The trap is that the analytic field is a SOURCE re-evaluated
    // every frame — under way its pattern sweeps outward so each texel gets a
    // bounded dose, but stopped it freezes and the same dose lands on the same
    // texels for ever. Before the live-speed gate this pinned to 1.0 and STAYED
    // there; the wake got BRIGHTER after dropping anchor.
    const decay = decayFactorPerFrame(flowFoamParams.decayHalfLife, DT);
    const speed = 8.2;
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed };
    const probes = Array.from({ length: 21 }, (_, i) => ({ x: -20 + i * 2, v: 0 }));
    const probeZ = speed * 30 - 25;
    let ms = 0;
    const tick = (dt: number) => {
      if (pose.speed > 0) pose.z += pose.speed * dt;
      advanceTrack(t, pose, dt, CFG);
      ms = approachExp(ms, pose.speed, dt, flowFoamParams.moundLag);
      const pts = trackPoints(t, pose);
      for (const p of probes) {
        p.v = Math.min(1, p.v * decay + wakeRateCpu(pts, p.x, probeZ, HULL, WP, ms) * dt);
      }
    };
    for (let i = 0; i < 30 / DT; i++) tick(DT);
    const underway = Math.max(...probes.map((p) => p.v));
    expect(underway).toBeGreaterThan(0.2); // a real wake while making way

    pose.speed = 0; // hove to
    for (let i = 0; i < 30 / DT; i++) tick(DT);
    const stopped = Math.max(...probes.map((p) => p.v));
    // it must FALL, not grow — and end as barely a trace
    expect(stopped).toBeLessThan(underway * 0.25);
    expect(stopped).toBeLessThan(0.15);
    for (let i = 0; i < 60 / DT; i++) tick(DT);
    expect(Math.max(...probes.map((p) => p.v))).toBeLessThan(0.05);
  });

  it('speed drives intensity AND length; the Kelvin ENVELOPE stays constant', () => {
    // User: "velocity is relevant, both for intensity and length and angle."
    // Intensity and length: yes, and they must scale. Angle: the Kelvin
    // half-angle is arcsin(1/3) ≈ 19.47° and is famously INDEPENDENT of speed
    // in deep water, so the envelope must NOT move — what changes with speed is
    // the brightness and the width of the turbulent core inside it.
    const peakAt = (speed: number, dAstern: number) => {
      const s = sail([{ fx: 0, fz: 1, seconds: 40 }], speed);
      let mx = 0;
      for (let y = -40; y <= 40; y += 0.5) {
        mx = Math.max(mx, wakeEnvelopeCpu(s.points, y, s.z - dAstern, HULL, WP, speed));
      }
      return mx;
    };
    expect(peakAt(1.2, 30)).toBeLessThan(peakAt(3, 30));
    expect(peakAt(3, 30)).toBeLessThan(peakAt(6, 30));
    expect(peakAt(6, 30)).toBeLessThan(peakAt(8.2, 30));
    expect(peakAt(0.3, 30)).toBe(0); // below threshold: nothing at all

    // the arm CREST sits at dist·tan(19.47°) at every speed — the one thing
    // about a wake that is exactly constant
    for (const speed of [3, 6, 8.2]) {
      const s = sail([{ fx: 0, fz: 1, seconds: 40 }], speed);
      for (const d of [20, 40, 60]) {
        const on = wakeEnvelopeCpu(s.points, d * TAN, s.z - d, HULL, WP, speed);
        const outside = wakeEnvelopeCpu(
          s.points,
          d * TAN + WP.armWidthMax + WP.cutWidth + 1,
          s.z - d,
          HULL,
          WP,
          speed,
        );
        expect(on).toBeGreaterThan(0);
        expect(outside).toBe(0);
      }
    }
    // ...while the turbulent CORE inside it does widen with speed
    const core = (speed: number) => {
      const s = sail([{ fx: 0, fz: 1, seconds: 40 }], speed);
      let w = 0;
      for (let y = 0; y <= 12; y += 0.25) {
        if (wakeEnvelopeCpu(s.points, y, s.z - (HULL.length + 10), HULL, WP, speed) > 0.05) w = y;
      }
      return w;
    };
    expect(core(8.2)).toBeGreaterThan(core(3));
  });

  it('NO HARD CUT: the rendered wake fades smoothly, tier handover invisible', () => {
    // The user's repeated complaint: "there's a straight straight hard line
    // cutoff whenever our wake disappears behind us". Three compounding causes,
    // all pinned here:
    //   1. the near tier hit its window border still at ~0.65 while the far
    //      tier only carried ~0.19 — a 3.4x brightness step;
    //   2. the tiers were combined with max(), which steps whenever they differ;
    //   3. the edge fade was a product of two per-axis smoothsteps, i.e. a
    //      SQUARE, so the border was literally a straight line.
    // This models what the OCEAN MATERIAL actually receives — both sliding
    // windows, both radial fades and the crossfade — not just the field. The
    // earlier mirror omitted the windows entirely and so measured a beautiful
    // gradient the GPU never produced.
    const speed = 8.2;
    const decayN = decayFactorPerFrame(flowFoamParams.decayHalfLife, DT);
    const decayF = decayFactorPerFrame(flowFoamParams.farDecayHalfLife, DT);
    const t = createWakeTrack();
    const pose = { x: 0, z: 0, fx: 0, fz: 1, speed };
    let ms = 0;
    for (let i = 0; i < 120 / DT; i++) {
      pose.z += speed * DT;
      advanceTrack(t, pose, DT, CFG);
      ms = approachExp(ms, speed, DT, flowFoamParams.moundLag);
    }
    const pts = trackPoints(t, pose);
    const cz = pose.z - 12; // ship origin; regions are centred here

    /** accumulate one world cell's history, EARLIEST → now, inside its window */
    const accum = (y: number, dAstern: number, decay: number, scale: number, win: number) => {
      let a = 0;
      const steps = Math.ceil((dAstern + 40) / speed / DT);
      for (let n = steps - 1; n >= 0; n--) {
        const dThen = dAstern - speed * n * DT;
        if (Math.abs(dThen) > win / 2 || Math.abs(y) > win / 2) {
          a *= decay; // scrolled out of the sliding window: content is gone
          continue;
        }
        a = Math.min(1, a * decay + wakeRateCpu(pts, y, cz - dThen, HULL, WP, ms) * DT * scale);
      }
      return a;
    };
    const rendered = (y: number, dAstern: number) => {
      const n =
        accum(y, dAstern, decayN, 1, flowFoamParams.regionSize) *
        regionEdgeFadeCpu(y, dAstern, flowFoamParams.regionSize, flowFoamParams.edgeFade);
      const f =
        accum(y, dAstern, decayF, flowFoamParams.farInject, flowFoamParams.farRegionSize) *
        regionEdgeFadeCpu(y, dAstern, flowFoamParams.farRegionSize, flowFoamParams.farEdgeFade) *
        flowFoamParams.farStrength;
      const w = farBlendWeightCpu(
        Math.hypot(y, dAstern),
        flowFoamParams.regionSize,
        flowFoamParams.farBlendStart,
        flowFoamParams.edgeFade,
      );
      return n * (1 - w) + f * w;
    };

    const dists = [10, 25, 40, 48, 52, 56, 60, 64, 70, 80, 100, 140, 200, 280];
    const peak = dists.map((d) => {
      let mx = 0;
      for (let y = -80; y <= 80; y += 2) mx = Math.max(mx, rendered(y, d));
      return mx;
    });
    // 1. MONOTONE: no re-brightening anywhere along the trail
    for (let i = 1; i < peak.length; i++) {
      expect(peak[i]).toBeLessThanOrEqual(peak[i - 1] + 1e-9);
    }
    // 2. NO STEP across the tier handover (the near window border, ~50-60 m):
    //    consecutive samples 4 m apart may not drop by more than a tenth
    for (let i = 1; i < dists.length; i++) {
      if (dists[i] > 70 || dists[i] < 40) continue;
      expect(peak[i - 1] - peak[i]).toBeLessThan(0.1);
    }
    // 3. and it does actually reach far astern before dying
    expect(peak[0]).toBeGreaterThan(0.4);
    expect(peak[dists.indexOf(200)]).toBeGreaterThan(0.05);
    expect(peak[dists.length - 1]).toBeLessThan(0.15);
  });

  it('the edge fade is RADIAL — a window border can never be a straight line', () => {
    // WHY: a per-axis product fades over a square, and a square border seen
    // from any angle is a straight line across the sea. Radial cannot be.
    const size = 120;
    const ef = 0.16;
    // equal radius in any direction => equal fade (that IS the invariant)
    const r = 55;
    const base = regionEdgeFadeCpu(r, 0, size, ef);
    for (const ang of [0.3, 0.9, 1.4, 2.2, 3.9, 5.1]) {
      expect(regionEdgeFadeCpu(r * Math.cos(ang), r * Math.sin(ang), size, ef)).toBeCloseTo(base, 12);
    }
    // the OLD square fade did not have this property: along a diagonal it
    // survived far past where it died along an axis
    const sqFade = (dx: number, dz: number) => {
      const inner = 0.5 * (1 - ef);
      const f = (u: number) => {
        const t = Math.min(1, Math.max(0, (Math.abs(u) - 0.5) / (inner - 0.5)));
        return t * t * (3 - 2 * t);
      };
      return f(dx / size) * f(dz / size);
    };
    expect(sqFade(r, 0)).not.toBeCloseTo(sqFade(r * Math.SQRT1_2, r * Math.SQRT1_2), 2);
    // fully inside => 1, at the rim => 0, monotone between
    expect(regionEdgeFadeCpu(0, 0, size, ef)).toBeCloseTo(1, 12);
    expect(regionEdgeFadeCpu(size / 2, 0, size, ef)).toBe(0);
    // strictly decreasing THROUGH the fade band (inner 50.4 m -> rim 60 m);
    // everything inside the band is untouched at 1
    expect(regionEdgeFadeCpu(30, 0, size, ef)).toBeCloseTo(1, 12);
    expect(regionEdgeFadeCpu(52, 0, size, ef)).toBeGreaterThan(
      regionEdgeFadeCpu(58, 0, size, ef),
    );
    expect(regionEdgeFadeCpu(58, 0, size, ef)).toBeGreaterThan(0);
  });

  it('breakup factor is bounded [1−wakeBreakup, 1] and deterministic', () => {
    // WHY: breakup may only REMOVE injected foam (gaps), never amplify it —
    // otherwise intensities in the params panel would lie.
    for (const [x, z] of [[0, -14], [3, -20], [-7, 4], [15.5, -33]]) {
      const b = wakeBreakupCpu(x, z, WP);
      expect(b).toBeGreaterThanOrEqual(1 - WP.wakeBreakup - 1e-12);
      expect(b).toBeLessThanOrEqual(1 + 1e-12);
      expect(wakeBreakupCpu(x, z, WP)).toBe(b);
    }
    // The rate is trail x breakup, but breakup COARSENS with age: fresh water
    // carries the raw gappy noise, old water is blended toward the noise's mean
    // so it reads as a soft wash instead of high-frequency stipple.
    const fresh: [number, number] = [1.2, STRAIGHT.z - 3];
    const freshAge = projectOnTrack(STRAIGHT.points, fresh[0], fresh[1]).age;
    const ct = smooth(0, WP.breakupSmoothAge, freshAge);
    const coarsened =
      wakeBreakupCpu(fresh[0], fresh[1], WP) * (1 - ct) + (1 - WP.wakeBreakup * 0.5) * ct;
    // + the bow mound, which rides outside the trail's breakup (a gappy mound
    // flickers; the user asked for a constant reaction at the stem)
    const moundHere = bowMoundCpu(STRAIGHT.points[0], fresh[0], fresh[1], 6, WP);
    expect(wakeRateCpu(STRAIGHT.points, fresh[0], fresh[1], HULL, WP)).toBeCloseTo(
      wakeTrailCpu(STRAIGHT.points, fresh[0], fresh[1], HULL, WP) * coarsened + moundHere,
      10,
    );
    expect(moundHere).toBeGreaterThan(0);
    // far astern the gaps have smoothed away: the effective breakup sits much
    // closer to the mean than the raw noise does
    const old: [number, number] = [2.5, STRAIGHT.z - 45];
    const trail = wakeTrailCpu(STRAIGHT.points, old[0], old[1], HULL, WP);
    const effective = wakeRateCpu(STRAIGHT.points, old[0], old[1], HULL, WP) / trail;
    const mean = 1 - WP.wakeBreakup * 0.5;
    expect(Math.abs(effective - mean)).toBeLessThan(
      Math.abs(wakeBreakupCpu(old[0], old[1], WP) - mean),
    );
  });

  it('deterministic (§V2) and never NaN, including off the ends of the track', () => {
    const a = wakeRateCpu(STRAIGHT.points, 3.3, STRAIGHT.z - 17, HULL, WP);
    expect(wakeRateCpu(STRAIGHT.points, 3.3, STRAIGHT.z - 17, HULL, WP)).toBe(a);
    for (const [x, z] of [[0, 1e4], [0, -1e4], [1e4, 0], [0, STRAIGHT.z + 200]]) {
      const v = wakeEnvelopeCpu(STRAIGHT.points, x, z, HULL, WP);
      expect(Number.isFinite(v)).toBe(true);
      expect(v).toBe(0);
    }
  });

  it('trackBounds contains every point the wake can reach', () => {
    // WHY: the GPU skips the whole segment walk outside this AABB — a margin
    // that under-estimates the arms would clip the outer V into a hard edge.
    const maxDist = STRAIGHT.points[STRAIGHT.points.length - 1].dist;
    const b = trackBounds(STRAIGHT.points, wakeReachCpu(maxDist, HULL, WP))!;
    expect(b).not.toBeNull();
    for (let d = 0; d <= maxDist; d += 1) {
      for (let y = -40; y <= 40; y += 0.5) {
        if (wakeEnvelopeCpu(STRAIGHT.points, y, STRAIGHT.z - d, HULL, WP) <= 0) continue;
        expect(y).toBeGreaterThanOrEqual(b.minX);
        expect(y).toBeLessThanOrEqual(b.maxX);
        expect(STRAIGHT.z - d).toBeGreaterThanOrEqual(b.minZ);
        expect(STRAIGHT.z - d).toBeLessThanOrEqual(b.maxZ);
      }
    }
  });
});

// ─── the wake's effect on the WATER, not on its colour ──────────────────────
// User: "I would expect an actual influence on the surface ripple / wave noise
// structure caused by the bow wake, by the trail that we leave in the water. It
// still feels not really believable enough." Everything above this line paints
// FOAM — white on top of an otherwise undisturbed sea, i.e. a decal. These
// tests pin the two mechanisms that make it a wake (src/flowfoam/slickMath.ts).
const SP: SlickParams = { ...flowFoamParams };

describe('capillary-damping lane (the glassy track, §V10 follow-up)', () => {
  it('THE CLAIM: the lane follows the TRACK, not the live heading', () => {
    // Same discriminator as the foam's: a wake that re-points when the ship
    // turns is not a wake. The damping lane is derived from the same recorded
    // polyline, so it inherits the property — and this test would fail loudly
    // if someone re-derived it from the ship's current frame.
    // same 36 m north / 36 m east course and the same two probes the foam's
    // "wake follows the PATH" test uses, so the two systems are pinned to one
    // geometry: 52 m back along the PATH vs 52 m dead astern of the new heading
    const s = sail(
      [
        { fx: 0, fz: 1, seconds: 6 },
        { fx: 1, fz: 0, seconds: 6 },
      ],
      6,
    );
    expect(slickFieldCpu(s.points, 0, 20, HULL, SP).slick).toBeGreaterThan(0);
    // west of the corner the hull never went — it came from the south
    expect(slickFieldCpu(s.points, -16, 36, HULL, SP).slick).toBe(0);
  });

  it('it is a LANE on the centreline, not the foam arms — a different shape', () => {
    // The physical claim: turbulence smooths the water the HULL passed through,
    // while the Kelvin arms are crests at ±dist·tanθ. If the damping simply
    // reused the foam mask the two would peak in the same place, the lane would
    // be gappy, and the whole effect would read as "shinier foam".
    const s = sail([{ fx: 0, fz: 1, seconds: 15 }], 6);
    const at = (lat: number, d: number) => ({
      slick: slickFieldCpu(s.points, lat, s.z - d, HULL, SP).slick,
      foam: wakeRateCpu(s.points, lat, s.z - d, HULL, WP),
    });
    const d = 40;
    const centre = at(0, d);
    const arm = at(d * TAN, d);
    expect(centre.slick).toBeGreaterThan(arm.slick); // lane is centred
    expect(arm.foam).toBeGreaterThan(centre.foam); // foam is on the arms
    // …and the lane never fans out past the wedge the whole wake lives in
    expect(slickFieldCpu(s.points, d * TAN + 6, s.z - d, HULL, SP).slick).toBe(0);
  });

  it('the lane is SMOOTH — no breakup stipple, because §V49 amplifies it', () => {
    // THE reason this field cannot simply be the foam mask. The ocean material
    // multiplies this factor into a slope it then differentiates in screen
    // space (dFdx(normalWorld) → Toksvig lobe widening), so the product rule
    // hands the normal H·dS/dx: any high-frequency structure in S comes back
    // amplified by the wave slope's own magnitude. The foam carries deliberate
    // gappy breakup noise; the lane must not.
    const s = sail([{ fx: 0, fz: 1, seconds: 15 }], 6);
    // Measured as the largest step per sample as a fraction of the field's OWN
    // peak — that is the quantity a screen-space derivative sees, and it is
    // scale-free so the two fields can be compared directly.
    const step = 0.05; // ~a fifth of a near-tier texel
    const roughness = (f: (x: number) => number): number => {
      let peak = 0;
      let jump = 0;
      let prev = f(0);
      for (let x = step; x <= 12; x += step) {
        const cur = f(x);
        peak = Math.max(peak, cur);
        jump = Math.max(jump, Math.abs(cur - prev));
        prev = cur;
      }
      return jump / Math.max(peak, 1e-9);
    };
    const slickRough = roughness((x) => slickFieldCpu(s.points, x, s.z - 20, HULL, SP).slick);
    // The bound is DERIVED, not tuned: the lane's only lateral structure is one
    // smoothstep shoulder, whose peak gradient is 1.5/span, and the span is at
    // worst `slickEdge × halfBeam` metres (the narrowest the lane ever gets, at
    // the stem). So the step per sample can never exceed 1.5·step/that — metres
    // of transition against centimetres of sample, which is the whole claim.
    const shoulderBound = (1.5 * step) / (SP.slickEdge * HULL.beam * 0.5);
    expect(slickRough).toBeLessThan(shoulderBound);
    expect(shoulderBound).toBeLessThan(0.05);

    // And UNIMODAL: one plateau, one shoulder, no interior bumps. The foam
    // along the very same line is multi-modal — arm crests plus deliberate
    // breakup gaps — which is exactly the structure that must not reach a
    // differentiated normal. If the lane is ever re-derived from the foam mask
    // this count goes up and the test fails.
    // Measured ALONG the trail, which is where the breakup lattice lives.
    const bumps = (f: (d: number) => number): number => {
      const v: number[] = [];
      for (let d = 10; d <= 80; d += 0.25) v.push(f(d));
      const peak = Math.max(...v, 1e-9);
      let n = 0;
      for (let i = 1; i + 1 < v.length; i++) {
        if (v[i] > v[i - 1] && v[i] > v[i + 1] && v[i] > peak * 0.1) n++;
      }
      return n;
    };
    // the lane down the centreline: one monotone decay, no patches at all
    expect(bumps((d) => slickFieldCpu(s.points, 0, s.z - d, HULL, SP).slick)).toBe(0);
    // the foam down its own arm crest: broken into patches, as it should be
    expect(bumps((d) => wakeRateCpu(s.points, d * TAN, s.z - d, HULL, WP))).toBeGreaterThan(3);
  });

  it('BUILDS UP over time and RELAXES after the ship has gone', () => {
    // A slick is a state of the water, not an instantaneous field: it has to
    // accumulate under the hull and then take (much) longer than the foam to
    // fade. Mirrors the accumulation arithmetic in accumulation.ts exactly.
    const s = sail([{ fx: 0, fz: 1, seconds: 15 }], 6);
    const rate = slickFieldCpu(s.points, 0, s.z - 20, HULL, SP).slick;
    expect(rate).toBeGreaterThan(0);
    const keep = decayFactorPerFrame(flowFoamParams.slickHalfLife, DT);
    let cover = 0;
    const grow: number[] = [];
    for (let i = 0; i < 120; i++) {
      cover = Math.min(cover * keep + rate * DT, 1);
      if (i % 40 === 39) grow.push(cover);
    }
    expect(grow[0]).toBeLessThan(grow[1]);
    expect(grow[1]).toBeLessThan(grow[2]); // still building, never snapping
    // ship gone: injection stops, and the lane must halve in slickHalfLife —
    // an order of magnitude slower than the foam, which is the whole point
    const settled = cover;
    for (let i = 0; i < Math.round(flowFoamParams.slickHalfLife / DT); i++) cover *= keep;
    expect(cover).toBeCloseTo(settled * 0.5, 4);
    expect(flowFoamParams.slickHalfLife).toBeGreaterThan(flowFoamParams.decayHalfLife * 4);
  });

  it('must not saturate into a formless slab — the accumulation arithmetic', () => {
    // The AccumProfile.wakeScale trap, in the slick's own units: a persistent
    // source settles at rate x halfLife/ln2, so a long INJECTION decay stacked
    // on a long ACCUMULATION half-life pins every texel at 1 and the lane loses
    // every gradient it has. Measured 8.4 with the first defaults — 8x clipped.
    // The cure is the physical one: turbulence is generated in the first
    // seconds behind the hull (slickDecay), the water then heals slowly
    // (slickHalfLife). Integrate the ODE the compute pass runs and check.
    const k = Math.LN2 / flowFoamParams.slickHalfLife;
    const tau = flowFoamParams.slickDecay;
    let cover = 0;
    let peak = 0;
    let peakAt = 0;
    for (let i = 1; i <= Math.round(400 / DT); i++) {
      const t = i * DT;
      cover += (flowFoamParams.slickIntensity * Math.exp(-t / tau) - k * cover) * DT;
      if (cover > peak) {
        peak = cover;
        peakAt = t;
      }
    }
    expect(peak).toBeLessThanOrEqual(1); // never clipped ⟹ the gradient survives
    expect(peak).toBeGreaterThan(0.7); // …but the lane does read strongly
    expect(peakAt).toBeGreaterThan(5); // and it BUILDS: no snap to full effect
    expect(cover).toBeLessThan(peak * 0.2); // and heals, hundreds of m astern
  });

  it('injection DECAYS with the water age, so the lane has a gradient', () => {
    // Not a fixed-length ribbon that stops: exp(−age/slickDecay), the same
    // dissipation shape the foam features were reworked onto (wakeMath header).
    const s = sail([{ fx: 0, fz: 1, seconds: 60 }], 6);
    const young = slickFieldCpu(s.points, 0, s.z - 10, HULL, SP).slick;
    const mid = slickFieldCpu(s.points, 0, s.z - 120, HULL, SP).slick;
    const old = slickFieldCpu(s.points, 0, s.z - 300, HULL, SP).slick;
    expect(young).toBeGreaterThan(mid);
    expect(mid).toBeGreaterThan(old);
    expect(old).toBeGreaterThanOrEqual(0);
  });

  it('HOVE TO: a stopped hull lays no new lane (else it pins solid white)', () => {
    // Same trap as the foam's (wakeMath.wakeTrailCpu): this is a SOURCE
    // re-evaluated every frame. Stop the ship and the pattern freezes, so the
    // same dose lands on the same texels for ever. Gating on LIVE speed lets
    // the deposit simply decay. User: "if you're stationary it should be a very
    // very tiny amount around the hull directly, if anything."
    const s = sail([{ fx: 0, fz: 1, seconds: 15 }], 6);
    const under = slickFieldCpu(s.points, 0, s.z - 20, HULL, SP, 6).slick;
    const stopped = slickFieldCpu(s.points, 0, s.z - 20, HULL, SP, 0).slick;
    expect(under).toBeGreaterThan(0);
    expect(stopped).toBe(0);
  });
});

describe('transverse Kelvin waves (λ = 2πv²/g, the speed-dependent half)', () => {
  it('the WEDGE ANGLE is speed-independent, the WAVELENGTH is not', () => {
    // Kelvin's result: the half-angle is asin(1/3), fixed by the deep-water
    // dispersion relation alone — it is not a look knob and must not be tuned.
    expect(flowFoamParams.kelvinAngle).toBeCloseTo(KELVIN_HALF_ANGLE_DEG, 2);
    expect(KELVIN_HALF_ANGLE_DEG).toBeCloseTo(19.4712, 3);
    // the rendered envelope agrees: the arm crest sits at dist·tanθ at ANY
    // speed, so a fast ship and a slow one draw the same V (different lengths
    // and intensities — that part is speed-driven, and tested above)
    for (const speed of [3, 12]) {
      const s = sail([{ fx: 0, fz: 1, seconds: 20 }], speed);
      const d = 40;
      const onCrest = wakeEnvelopeCpu(s.points, d * TAN, s.z - d, HULL, WP);
      const outside = wakeEnvelopeCpu(s.points, d * TAN + 8, s.z - d, HULL, WP);
      expect(onCrest).toBeGreaterThan(0);
      expect(outside).toBe(0);
    }
    // the transverse wavelength, by contrast, goes as v²: double the speed and
    // the crests spread four-fold. Getting this constant means the wake reads
    // differently under way than at a crawl, which is what sells the speed.
    expect(transverseWavelengthCpu(4)).toBeCloseTo(transverseWavelengthCpu(2) * 4, 6);
    expect(transverseWavelengthCpu(6)).toBeCloseTo((2 * Math.PI * 36) / 9.80665, 6);
  });

  it('the crest SPACING measured off the field really scales as v²', () => {
    // Not just the formula — the field the GPU twin evaluates. Count sign
    // changes of the transverse slope along the centreline over a fixed run:
    // a longer wavelength must cross zero fewer times.
    const crossings = (speed: number): number => {
      const s = sail([{ fx: 0, fz: 1, seconds: 40 }], speed);
      let n = 0;
      let prev = 0;
      for (let d = 2; d <= 120; d += 0.25) {
        const v = slickFieldCpu(s.points, 0, s.z - d, HULL, SP).slopeZ;
        if (prev !== 0 && Math.sign(v) !== Math.sign(prev) && v !== 0) n++;
        prev = v;
      }
      return n;
    };
    const slow = crossings(3); // λ ≈ 5.8 m
    const fast = crossings(7); // λ ≈ 31.4 m
    expect(slow).toBeGreaterThan(fast * 3);
    expect(fast).toBeGreaterThan(0); // and the fast one is still a wave train
  });

  it('crests stay INSIDE the wedge and point across the track', () => {
    const s = sail([{ fx: 0, fz: 1, seconds: 20 }], 6);
    const d = 50;
    // outside the V there is no transverse wave at all
    expect(slickFieldCpu(s.points, d * TAN + 2, s.z - d, HULL, SP).slopeZ).toBe(0);
    // sailing due north (fwd = +z), so the slope must be purely along z —
    // crests run ACROSS the track, which is what makes them read as a ladder
    const on = slickFieldCpu(s.points, 2, s.z - d, HULL, SP);
    expect(Math.abs(on.slopeX)).toBeLessThan(1e-9);
    expect(Math.abs(on.slopeZ)).toBeGreaterThan(0);
  });
});

describe('§V44/§V48/§V49 — what the ocean is allowed to multiply', () => {
  it('BOUNDED AT SOURCE over the whole field, including off the track', () => {
    // §V44: the damping multiplier ends up scaling a surface slope and the
    // transverse term is ADDED to one. Both must be provably bounded where they
    // are produced, not clamped by the consumer.
    const s = sail([{ fx: 0, fz: 1, seconds: 20 }, { fx: 1, fz: 0, seconds: 6 }], 7);
    for (let x = -80; x <= 80; x += 3.5) {
      for (let z = -160; z <= 40; z += 3.5) {
        const f = slickFieldCpu(s.points, x, z, HULL, SP);
        expect(Number.isFinite(f.slick)).toBe(true);
        expect(f.slick).toBeGreaterThanOrEqual(0);
        expect(f.slick).toBeLessThanOrEqual(flowFoamParams.slickIntensity);
        expect(Math.hypot(f.slopeX, f.slopeZ)).toBeLessThanOrEqual(
          flowFoamParams.transSlope + 1e-9,
        );
        const m = slickDampCpu(f.slick, 1, SP);
        expect(m).toBeLessThanOrEqual(1);
        expect(m).toBeGreaterThanOrEqual(1 - flowFoamParams.slickDamp - 1e-9);
      }
    }
  });

  it('FAILS SAFE: a non-finite coverage damps nothing rather than NaNing a normal', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(slickDampCpu(bad, 1, SP)).toBe(1);
      expect(slickDampCpu(0.5, bad, SP)).toBe(1);
      expect(bandKeepCpu(bad, 0.234, SP)).toBe(0);
    }
    // and out-of-range inputs saturate instead of extrapolating
    expect(slickDampCpu(5, 1, SP)).toBeCloseTo(1 - flowFoamParams.slickDamp, 9);
    expect(slickDampCpu(-5, 1, SP)).toBe(1);
  });

  it('BAND-LIMITED: the product tends to the UNDAMPED slope at minification', () => {
    // §V48 + §V49 in one. The accumulation texture is compute-written, so it
    // can carry no mip chain: once one screen pixel spans more than a texel a
    // texture() fetch is a point sample, and §V49 says the material's own
    // dFdx(normal) then returns that aliasing amplified by the slope magnitude.
    // The fix has to be applied by THIS owner, against the caller's footprint.
    const texel = flowFoamParams.regionSize / flowFoamParams.resolution; // 0.234 m
    const keep = (px: number) => bandKeepCpu(px, texel, SP);
    // resolved: full effect
    expect(keep(texel * 0.5)).toBeCloseTo(1, 6);
    // monotone, never rising back
    let prev = 1;
    for (let m = 0.5; m <= 6; m += 0.1) {
      const k = keep(texel * m);
      expect(k).toBeLessThanOrEqual(prev + 1e-12);
      prev = k;
    }
    // past the cut it is exactly zero, so the PRODUCT is fineSlope × 1 — i.e.
    // precisely what the ocean draws with no wake at all. Nothing to alias.
    expect(keep(texel * flowFoamParams.slickBandCut * 1.01)).toBe(0);
    expect(slickDampCpu(1, keep(texel * 8), SP)).toBe(1);
    // fading to "no damping" is also the honest AVERAGE: a lane a few metres
    // wide occupies a vanishing fraction of a footprint that large.
    expect(flowFoamParams.slickBandCut).toBeGreaterThan(flowFoamParams.slickBandFull);
  });

  it('the FAR tier is coarser than the shortest transverse wave it could hold', () => {
    // Which is exactly why accumulation's `useDetail` is false there: 2.5 m
    // texels cannot carry a 5.8 m wave (2.3 samples per period, below Nyquist),
    // and that field ends up in the surface NORMAL.
    const farTexel = flowFoamParams.farRegionSize / flowFoamParams.farResolution;
    const shortest = transverseWavelengthCpu(flowFoamParams.speedThreshold * 6);
    expect(shortest / farTexel).toBeLessThan(4);
    // the near tier, by contrast, resolves it comfortably
    const nearTexel = flowFoamParams.regionSize / flowFoamParams.resolution;
    expect(shortest / nearTexel).toBeGreaterThan(20);
  });
});

describe('flowfoam params (§V16 registry contract)', () => {
  it('registers under "flowfoam" with the live object', () => {
    const entry = getParamsEntry('flowfoam');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(flowFoamParams);
  });

  it('defaults sit inside their Tweakpane meta bounds', () => {
    const entry = getParamsEntry('flowfoam')!;
    for (const [key, meta] of Object.entries(entry.meta)) {
      const value = (flowFoamParams as unknown as Record<string, number>)[key];
      if (meta.min !== undefined) expect(value).toBeGreaterThanOrEqual(meta.min);
      if (meta.max !== undefined) expect(value).toBeLessThanOrEqual(meta.max);
    }
  });

  it('structural bounds the shaders/dispatch rely on', () => {
    // power-of-two resolution: exact texel-snap arithmetic + dispatch align
    expect(flowFoamParams.resolution).toBeGreaterThan(0);
    expect(Math.log2(flowFoamParams.resolution) % 1).toBe(0);
    expect(flowFoamParams.depthThreshold).toBeGreaterThan(0);
    expect(flowFoamParams.maskFeather).toBeGreaterThan(0);
    expect(flowFoamParams.maskFeather).toBeLessThanOrEqual(1);
    expect(flowFoamParams.decayHalfLife).toBeGreaterThan(0);
    expect(flowFoamParams.edgeFade).toBeGreaterThan(0);
    expect(flowFoamParams.edgeFade).toBeLessThan(0.5);
    expect(flowFoamParams.curlStep).toBeGreaterThan(0);
    // Kelvin default is the physical wake half-angle (arcsin(1/3) ≈ 19.47°)
    expect(flowFoamParams.kelvinAngle).toBeCloseTo(19.47, 2);
    expect(flowFoamParams.speedThreshold).toBeGreaterThanOrEqual(0);
    expect(flowFoamParams.armWidth).toBeGreaterThan(0);
    expect(flowFoamParams.sternWidth).toBeGreaterThan(0);
    // track history: spacing/life must actually span the foam region, or the
    // trail would end inside the visible window with a hard edge
    expect(flowFoamParams.trackSpacing).toBeGreaterThan(0);
    expect(flowFoamParams.trackLife).toBeGreaterThan(0);
    expect(flowFoamParams.trackSpacing * TRACK_CAPACITY).toBeGreaterThan(
      flowFoamParams.regionSize * 0.7,
    );
    // fades must not outlive the samples that feed them (dead injection cost)
    expect(flowFoamParams.bowDecay).toBeLessThanOrEqual(flowFoamParams.trackLife);
    expect(flowFoamParams.sternDecay).toBeLessThanOrEqual(flowFoamParams.trackLife);
    expect(flowFoamParams.tailFade).toBeGreaterThan(0);
    expect(flowFoamParams.tailFade).toBeLessThan(1);
    expect(flowFoamParams.vortexSpacing).toBeGreaterThan(0);
    expect(flowFoamParams.fullWakeSpeed).toBeGreaterThan(flowFoamParams.speedThreshold);

    // two-tier foam region: the near tier buys DETAIL, the far tier buys
    // LENGTH, and neither can do the other's job with one 512² texture
    expect(Math.log2(flowFoamParams.farResolution) % 1).toBe(0);
    const nearTexel = flowFoamParams.regionSize / flowFoamParams.resolution;
    const farTexel = flowFoamParams.farRegionSize / flowFoamParams.farResolution;
    expect(nearTexel).toBeLessThan(farTexel); // near is the detailed one
    expect(nearTexel).toBeLessThan(0.5); // sub-metre: arms/cutwater are ~1 m
    expect(flowFoamParams.farRegionSize).toBeGreaterThan(flowFoamParams.regionSize * 3);
    // the far tier must not outrun the history that feeds it, or the trail
    // would simply stop mid-window with a hard edge
    const reach = trackReachCpu({
      capacity: TRACK_CAPACITY,
      spacing: flowFoamParams.trackSpacing,
      coarsen: flowFoamParams.trackCoarsen,
      coarsenStart: flowFoamParams.trackCoarsenStart,
      life: flowFoamParams.trackLife,
      minSpeed: flowFoamParams.speedThreshold,
      maxTurn: 1,
    });
    expect(reach).toBeGreaterThanOrEqual(flowFoamParams.farRegionSize / 2);
    // and the far decay must outlast the time it takes to sail that far
    expect(flowFoamParams.farDecayHalfLife).toBeGreaterThan(flowFoamParams.decayHalfLife);
  });
});
