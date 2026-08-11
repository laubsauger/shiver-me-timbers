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
  flowPotentialCpu,
  flowVectorCpu,
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
  type WakeHull,
  type WakeParams,
} from '../src/flowfoam/wakeMath';
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

const WP: WakeParams = {
  kelvinAngle: 19.47,
  bowIntensity: 0.3,
  armWidth: 0.9,
  armWidthGrowth: 0.02,
  armWidthMax: 4.0,
  aftSpreadCap: 0.8,
  trackCoarsen: 20,
  trackCoarsenStart: 30,
  shoulderIntensity: 1.2,
  shoulderLength: 14,
  shoulderPush: 2.0,
  shoulderWidth: 1.3,
  shoulderEntry: 8,
  hullBoost: 1.6,
  hullBoostDist: 14,
  bowLife: 45,
  cutIntensity: 1.0,
  cutWidth: 1.1,
  cutLength: 7,
  sternIntensity: 0.05,
  sternWidth: 0.9,
  sternSpread: 0.55,
  sternLife: 40,
  sternOnset: 3,
  vortexIntensity: 0.05,
  vortexOffset: 1.15,
  vortexSpread: 0.28,
  vortexWidth: 1.3,
  vortexSpacing: 11,
  vortexLife: 45,
  moundIntensity: 0.5,
  moundLead: 1.6,
  moundSweep: 0.9,
  moundSpan: 5.0,
  moundThick: 1.4,
  moundFill: 3.0,
  moundLag: 1.1,
  speedThreshold: 0.5,
  fullWakeSpeed: 5,
  trackSpacing: 2.2,
  trackLife: 200,
  tailFade: 0.35,
  bowClip: 0.8,
  wakeNoiseScale: 0.3,
  wakeNoiseContrast: 0.18,
  wakeBreakup: 0.85,
};
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

  it('breakup factor is bounded [1−wakeBreakup, 1] and deterministic', () => {
    // WHY: breakup may only REMOVE injected foam (gaps), never amplify it —
    // otherwise intensities in the params panel would lie.
    for (const [x, z] of [[0, -14], [3, -20], [-7, 4], [15.5, -33]]) {
      const b = wakeBreakupCpu(x, z, WP);
      expect(b).toBeGreaterThanOrEqual(1 - WP.wakeBreakup - 1e-12);
      expect(b).toBeLessThanOrEqual(1 + 1e-12);
      expect(wakeBreakupCpu(x, z, WP)).toBe(b);
    }
    const [px, pz] = [2.5, STRAIGHT.z - 30];
    expect(wakeRateCpu(STRAIGHT.points, px, pz, HULL, WP)).toBeCloseTo(
      wakeEnvelopeCpu(STRAIGHT.points, px, pz, HULL, WP) * wakeBreakupCpu(px, pz, WP),
      12,
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
    expect(flowFoamParams.bowLife).toBeLessThanOrEqual(flowFoamParams.trackLife);
    expect(flowFoamParams.sternLife).toBeLessThanOrEqual(flowFoamParams.trackLife);
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
