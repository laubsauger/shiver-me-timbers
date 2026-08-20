/**
 * §T.82 — "SHE SITS BOW-DOWN BY 2-4°" — WHY these tests:
 *
 * The static trim is zero by construction (buoyancy centres its stations so
 * Σw·z = 0) and every buoyancy test is blind to the two places a bow-down can
 * still come from: the RENDERED hull's rest attitude against the sim frame,
 * and a DYNAMIC moment that only exists under way. Measured (flat sea, shipped
 * params): sim pitch is exactly 0.000° at rest and under full drive with no
 * wake; with the §T.78 wake wired it was −1.20° by the head on a beam reach at
 * 10 m/s. The cause was the transverse Kelvin train's phase origin — a TROUGH
 * under the stem (a moving pressure point's picture), where a hull's bow is a
 * stagnation CREST. These pin the PROPERTIES (§V.80), not the numbers:
 *
 *   1. the drawn keel is level in the sim frame at zero pitch;
 *   2. dead calm, sails furled: the sim pitch is zero, not merely small;
 *   3. the wake field puts a crest under the stem, not a trough;
 *   4. under full drive she trims by the head by less than 1° on any point of
 *      sail, and past the hump (Fn > 0.45) by the STERN — what a displacement
 *      hull does. A real ship under sail trims ~0.5–1° at most; 3° by the head
 *      is a flooded forepeak, not a trim.
 */
import { describe, expect, it } from 'vitest';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { asHullShape, buildLoftedHullSection } from '../src/ship/pieceGeometryHull';
import { galleonParams } from '../src/params/ship';
import { createFlowFoam } from '../src/flowfoam/index';
import { slickFieldCpu, transverseWavelengthCpu } from '../src/flowfoam/slickMath';
import type { TrackSample } from '../src/flowfoam/wakeTrack';
import { flowFoamParams } from '../src/params/flowfoam';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
import { stepShipSailing, type Wind } from '../src/sailing/shipKinematics';
import { neutralInput } from '../src/sailing/input';
import { sailingParams } from '../src/params/sailing';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { SIM_DT } from '../src/core/loop';
import { GRAVITY } from '../src/ocean/oceanMath';
import { quatFromAxisAngle, rotateVec } from '../src/combat/quatMath';
import type { ShipState } from '../src/state/simState';

const DT = SIM_DT;
const DEG = 180 / Math.PI;
/** the shipped galleon's waterline loft — the same numbers main.ts hands the wake */
const BOW_Z = 21.0;
const STERN_Z = -17.5;
const BEAM = 8.5;
const LWL = BOW_Z - STERN_Z;
/** genuinely flat: `amplitude` alone leaves the swell train running */
const FLAT: OceanParams = { ...oceanParams, resolution: 128, amplitude: 0, swellAmplitude: 0 };
/** the sea's hands off the helm, so a heading is a heading (see sailing.test.ts) */
const HELM_STEADY = { ...sailingParams, weatherHelmGain: 0, rollYawGain: 0 };

/** bow elevation (rad): + = bow UP — buoyancy's and sailing's shared convention */
function pitchOf(s: ShipState): number {
  const y = rotateVec(s.quaternion, [0, 0, 1])[1];
  return Math.asin(y < -1 ? -1 : y > 1 ? 1 : y);
}

function makeShip(trim: number): ShipState {
  return {
    id: 'player',
    kind: 'player',
    position: [0, equilibriumDraft(), 0],
    quaternion: quatFromAxisAngle([0, 1, 0], 0),
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: trim,
    flood: 0,
    damage: {},
  };
}

/**
 * main.ts's fixed tick, in its order: sailing → ocean → wake → buoyancy. The
 * mean is taken over the second half so the heel and the wake track are
 * settled; `speed` is the steady speed reached.
 */
function sail(wind: Wind, trim: number, wake: boolean, seconds: number) {
  const ocean = new CpuOcean(7, FLAT, seaPhysicsParams);
  const ff = wake ? createFlowFoam() : null;
  if (ff) ocean.setWakeField(ff);
  const ship = makeShip(trim);
  const input = neutralInput();
  const ticks = Math.round(seconds / DT);
  const warm = Math.round(ticks / 2);
  let sum = 0;
  let peakAbs = 0;
  let t = 0;
  for (let i = 0; i < ticks; i++) {
    t += DT;
    stepShipSailing(ship, input, wind, DT, HELM_STEADY);
    ocean.update(t);
    if (ff) {
      const f = rotateVec(ship.quaternion, [0, 0, 1]);
      const speed = Math.hypot(ship.velocity[0], ship.velocity[2]);
      ff.setCenter(ship.position[0], ship.position[2]);
      ff.setFlowDir([-ship.velocity[0], -ship.velocity[2]]);
      ff.setShip([ship.position[0], ship.position[2]], Math.atan2(f[0], f[2]), speed, BOW_Z, STERN_Z, BEAM);
      ff.advanceWake(DT);
    }
    stepShipBuoyancy(ship, ocean, DT);
    if (i >= warm) {
      const p = pitchOf(ship) * DEG;
      sum += p;
      peakAbs = Math.max(peakAbs, Math.abs(p));
    }
  }
  return {
    meanPitchDeg: sum / (ticks - warm),
    peakAbsDeg: peakAbs,
    speed: Math.hypot(ship.velocity[0], ship.velocity[2]),
  };
}

describe('§T.82 the rendered hull is level in the sim frame', () => {
  it('every hull section sits at y = 0, unrotated, with its keel flat at −draft bow to stern', () => {
    // A mesh authored bow-down would look exactly like a trim and no buoyancy
    // test could see it: buoyancy never reads the mesh. So read the mesh.
    const sections = buildGalleonBlueprint().filter((p) => p.kind === 'hull-section');
    expect(sections.length).toBeGreaterThan(0);
    for (const def of sections) {
      expect(def.transform.position[1]).toBe(0);
      expect(def.transform.rotation).toEqual([0, 0, 0]);
      const shape = asHullShape(def.shape);
      expect(shape).not.toBeNull();
      const pos = buildLoftedHullSection(shape!).getAttribute('position');
      // lowest vertex at each end of the piece: the keel line's two ends
      let foreMin = Infinity;
      let aftMin = Infinity;
      let zMin = Infinity;
      let zMax = -Infinity;
      for (let i = 0; i < pos.count; i++) {
        zMin = Math.min(zMin, pos.getZ(i));
        zMax = Math.max(zMax, pos.getZ(i));
      }
      for (let i = 0; i < pos.count; i++) {
        const z = pos.getZ(i);
        if (Math.abs(z - zMax) < 1e-4) foreMin = Math.min(foreMin, pos.getY(i));
        if (Math.abs(z - zMin) < 1e-4) aftMin = Math.min(aftMin, pos.getY(i));
      }
      expect(foreMin).toBeCloseTo(-galleonParams.draft, 5);
      expect(aftMin).toBeCloseTo(-galleonParams.draft, 5);
      // keel slope, in degrees, over this section's own length
      const slopeDeg = Math.atan2(foreMin - aftMin, zMax - zMin) * DEG;
      expect(Math.abs(slopeDeg)).toBeLessThan(0.01);
    }
  });
});

describe('§T.82 static trim: dead calm, sails furled', () => {
  it('sim pitch is zero — not small, zero — through 30 s of the shipped tick order', () => {
    // The stations are centred (Σw·z = 0) so flat water makes no pitch torque;
    // any number here at all is a second writer of pitch (the §B.6 shape).
    const r = sail({ direction: 0, speed: 0 }, 0, true, 30);
    expect(r.speed).toBeLessThan(1e-6);
    expect(Math.abs(r.meanPitchDeg)).toBeLessThan(0.01);
    expect(r.peakAbsDeg).toBeLessThan(0.01);
  });
});

describe('§T.82 the wake puts a CREST under the stem, not a trough', () => {
  /** a straight track laid at `speed`, head at the origin pointing +z */
  function straightTrack(speed: number, length = 120, spacing = 1): TrackSample[] {
    const pts: TrackSample[] = [];
    for (let d = 0; d <= length; d += spacing) {
      pts.push({ x: 0, z: -d, fx: 0, fz: 1, speed, age: d / speed, dist: d });
    }
    return pts;
  }
  // the train alone — the mound and the street are separate features with
  // their own tests; this is about the transverse train's phase origin
  const TRAIN = { ...flowFoamParams, moundSlope: 0, eddySlope: 0, divSlope: 0 };
  const hull = { length: LWL, beam: BEAM };

  it.each([5, 7, 10])('at %d m/s: crest at the cutwater, trough half a wavelength astern', (speed) => {
    const pts = straightTrack(speed);
    const lambda = transverseWavelengthCpu(speed);
    const atStem = slickFieldCpu(pts, 0, -0.01, hull, TRAIN, speed).elev;
    const halfWave = slickFieldCpu(pts, 0, -lambda / 2, hull, TRAIN, speed).elev;
    const fullWave = slickFieldCpu(pts, 0, -lambda, hull, TRAIN, speed).elev;
    expect(atStem).toBeGreaterThan(0);
    expect(halfWave).toBeLessThan(0);
    expect(fullWave).toBeGreaterThan(0);
    // and the amplitude really is slope·λ/2π — the elevation is the slope's
    // potential, not a second knob (the §T.78 contract this phase shift keeps)
    const k = (2 * Math.PI) / lambda;
    expect(Math.abs(atStem)).toBeLessThanOrEqual(TRAIN.transSlope / k + 1e-9);
  });
});

describe('§T.82 trim under way: by the head < 1°, past the hump by the stern', () => {
  // Froude number of the point of sail: the arcade speeds are high for a
  // galleon (Fn 0.37 on a run, 0.5 on a beam reach) and past Fn ≈ 0.45 every
  // displacement hull squats by the STERN — the stem rides its own bow crest
  // and the transom sits in the trough behind it.
  const fn = (speed: number) => speed / Math.sqrt(GRAVITY * LWL);

  it('beam reach, full drive: Fn > 0.45 and she trims by the STERN, under 2°', () => {
    const r = sail({ direction: Math.PI / 2, speed: 8 }, 1, true, 40);
    expect(fn(r.speed)).toBeGreaterThan(0.45);
    expect(r.meanPitchDeg).toBeGreaterThan(0);
    expect(r.meanPitchDeg).toBeLessThan(2);
  }, 60_000);

  it('dead run, full drive: within 1° of level either way', () => {
    const r = sail({ direction: 0, speed: 8 }, 1, true, 40);
    expect(r.speed).toBeGreaterThan(5);
    expect(Math.abs(r.meanPitchDeg)).toBeLessThan(1);
  }, 60_000);

  it('without the wake there is no trim at all: thrust makes no pitch moment', () => {
    // the one place a dynamic bow-down could come from other than the sea is a
    // thrust applied above the CoG; sailing applies it on the velocity, and
    // this is the test that says so
    const r = sail({ direction: Math.PI / 2, speed: 8 }, 1, false, 30);
    expect(r.speed).toBeGreaterThan(5);
    expect(r.peakAbsDeg).toBeLessThan(0.01);
  }, 60_000);
});
