/**
 * §T.73 per-class sea physics: ship 1 is a brigantine, so she has to FLOAT
 * as one. `seaPhysicsParams` used to be one global hull — the galleon's
 * 35.5 m plan, 604 t, draft 2.0 — fed to `stepShipBuoyancy` for both ships,
 * so the brigantine rode at a galleon's draft and pitched with a galleon's
 * inertia. Now `sea-brigantine` is derived from her own `brigantineParams`
 * (§V.77: one expression off the loft, no second set of typed numbers), and
 * these tests pin the PROPERTIES that derivation must keep (§V.80):
 *  - her hull numbers are her blueprint's, not the galleon's
 *  - she floats on HER marks, level, and the two hulls are ballasted alike
 *  - she is lighter: shorter heave period, same dimensionless gyradii
 *  - the galleon is untouched, so the player's ride is byte-identical
 *  - two classes stepped on one sea each keep their own state
 */
import { describe, expect, it } from 'vitest';
import { oceanParams, type OceanParams } from '../src/params/ocean';
import {
  brigantineSeaParams,
  seaPhysicsParams,
  waterlineOf,
  type SeaPhysicsParams,
} from '../src/params/seaPhysics';
import { brigantineParams, galleonParams } from '../src/params/ship';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import {
  equilibriumDraft,
  probeStations,
  stepShipBuoyancy,
} from '../src/sea-physics/buoyancy';
import { rotateVec } from '../src/core/quat';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;

/** flat calm: both wave trains off (see seaPhysics.test `flatOceanParams`) */
function flatOcean(): OceanParams {
  return { ...oceanParams, resolution: 128, amplitude: 0, swellAmplitude: 0 };
}

function fast(p: SeaPhysicsParams, over: Partial<SeaPhysicsParams> = {}): SeaPhysicsParams {
  return { ...p, mirrorResolution: 64, ...over };
}

function makeShip(id: string): ShipState {
  return {
    id,
    kind: 'enemy',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0,
    flood: 0,
    damage: {},
  };
}

/** bow elevation (rad, + = bow up) and heel (rad) off the quaternion */
function pitchOf(ship: ShipState): number {
  return Math.asin(rotateVec(ship.quaternion, [0, 0, 1])[1]);
}
function rollOf(ship: ShipState): number {
  return Math.asin(-rotateVec(ship.quaternion, [1, 0, 0])[1]);
}

/** how far below her design waterline plane a hull floats, as a fraction
 * of her own draft — the one number that says "ballasted the same way" */
function overfloat(p: SeaPhysicsParams): number {
  return -equilibriumDraft(p) / p.hullDraft;
}

const galleon = seaPhysicsParams;
const brig = brigantineSeaParams;

describe('§T.73 the brigantine has her own hull (sea-brigantine)', () => {
  it('her plan, draft and freeboard are READ from brigantineParams', () => {
    // WHY: the enemy ship used to float on the galleon's numbers. If these
    // ever came from anywhere but her own blueprint they would drift from
    // the hull that is drawn (§V.77).
    expect(brig.hullDraft).toBe(brigantineParams.draft);
    expect(brig.hullFreeboard).toBe(brigantineParams.freeboard);
    expect(brig.hullHalfBeam).toBe(brigantineParams.beam / 2);
    // the waterline lies INSIDE her loft: aft of the stem point, forward of
    // the loft's transom, and longer than the hull box proper
    const stem = brigantineParams.hullLength / 2 + brigantineParams.bowLength;
    expect(brig.hullBowZ).toBeLessThan(stem);
    expect(brig.hullBowZ).toBeGreaterThan(brigantineParams.hullLength / 2);
    expect(brig.hullSternZ).toBeGreaterThan(-brigantineParams.hullLength / 2);
    expect(brig.hullSternZ).toBeLessThan(0);
    // and she is the SHORTER, NARROWER, SHALLOWER hull
    expect(brig.hullBowZ - brig.hullSternZ).toBeLessThan(galleon.hullBowZ - galleon.hullSternZ);
    expect(brig.hullHalfBeam).toBeLessThan(galleon.hullHalfBeam);
    expect(brig.hullDraft).toBeLessThan(galleon.hullDraft);
  });

  it('she is lighter than the galleon, at the SAME block coefficient', () => {
    // WHY: both hulls come off one loft family (hullMath), so the displaced
    // volume per L·B·T must be the same — a different Cb would be a number
    // someone typed, not a hull someone drew.
    expect(brig.mass).toBeLessThan(galleon.mass);
    const cb = (p: SeaPhysicsParams): number =>
      p.mass / ((p.hullBowZ - p.hullSternZ) * 2 * p.hullHalfBeam * p.hullDraft);
    expect(cb(brig)).toBeCloseTo(cb(galleon), 9);
    // and the historical sanity bound: a 30 m brigantine is a few hundred
    // tonnes, not a galleon's 600
    expect(brig.mass).toBeGreaterThan(150e3);
    expect(brig.mass).toBeLessThan(450e3);
  });

  it('floats on HER marks and level, ballasted as the galleon is', () => {
    // WHY: "floats at her own design draft" is the whole point of the change.
    // The galleon settles 0.22·T past her design waterline (§B.27 — that is
    // where her heave period comes from); the brigantine must settle the
    // same FRACTION of her own, smaller draft, or one of them is mis-ballasted.
    const p = fast(brig);
    const ocean = new CpuOcean(1, flatOcean(), p);
    ocean.update(0);
    const ship = makeShip('b');
    for (let i = 0; i < 1200; i++) stepShipBuoyancy(ship, ocean, DT, p);
    expect(Math.abs(ship.position[1] - equilibriumDraft(p))).toBeLessThan(0.02);
    expect(Math.abs(ship.velocity[1])).toBeLessThan(0.01);
    // on her marks: below the plane (she carries weight), by less than a
    // quarter of her own draft (she is not a galleon's weight on a brig's hull)
    expect(equilibriumDraft(p)).toBeLessThan(0);
    expect(overfloat(p)).toBeLessThan(0.25);
    expect(overfloat(brig)).toBeCloseTo(overfloat(galleon), 6);
    // and SHALLOWER in the water than the galleon, in metres
    expect(equilibriumDraft(brig)).toBeGreaterThan(equilibriumDraft(galleon));
    // static trim 0, heel 0: the station plan is centred on its own
    // waterplane, so flat water makes no pitch torque for her either
    expect(Math.abs(pitchOf(ship))).toBeLessThan(1e-4);
    expect(Math.abs(rollOf(ship))).toBeLessThan(1e-4);
  });

  it('responds as a lighter ship: shorter heave period, same gyradii', () => {
    // WHY: "lighter" has to be measurable in her MOTION, not just in the mass
    // field. Her immersion is smaller so her heave period is shorter
    // (T = 2π√(immersion·(1+a)/g)); and her inertia is the galleon's gyradii
    // on her own length and beam, so the dimensionless §V.53 check holds for
    // both hulls with one pair of ratios.
    const period = (base: SeaPhysicsParams): number => {
      const p = fast(base, { buoyancyDamping: 0 });
      const ocean = new CpuOcean(1, flatOcean(), p);
      ocean.update(0);
      const ship = makeShip('p');
      ship.position[1] = equilibriumDraft(p) + 0.2;
      const crossings: number[] = [];
      let prev = ship.position[1] - equilibriumDraft(p);
      for (let i = 0; i < 3600; i++) {
        stepShipBuoyancy(ship, ocean, DT, p);
        const d = ship.position[1] - equilibriumDraft(p);
        if (prev > 0 !== d > 0) crossings.push(i * DT);
        prev = d;
      }
      return (2 * (crossings[crossings.length - 1] - crossings[0])) / (crossings.length - 1);
    };
    const tB = period(brig);
    const tG = period(galleon);
    expect(tB).toBeLessThan(tG);
    const immersion = (p: SeaPhysicsParams): number => p.hullDraft - equilibriumDraft(p);
    expect(tB / tG).toBeCloseTo(Math.sqrt(immersion(brig) / immersion(galleon)), 1);
    // gyradii as fractions of the hull: identical between the classes
    const kPitch = (p: SeaPhysicsParams): number =>
      Math.sqrt(p.inertiaPitch / p.mass) / (p.hullBowZ - p.hullSternZ);
    const kRoll = (p: SeaPhysicsParams): number =>
      Math.sqrt(p.inertiaRoll / p.mass) / (2 * p.hullHalfBeam);
    expect(kPitch(brig)).toBeCloseTo(kPitch(galleon), 9);
    expect(kRoll(brig)).toBeCloseTo(kRoll(galleon), 9);
    // and the station set's own added-water gyradius scales with her length
    const sb = probeStations(brig.probeSlices, brig);
    const sg = probeStations(galleon.probeSlices, galleon);
    expect(Math.sqrt(sb.az2)).toBeLessThan(Math.sqrt(sg.az2));
    expect(Math.sqrt(sb.az2) / (brig.hullBowZ - brig.hullSternZ)).toBeCloseTo(
      Math.sqrt(sg.az2) / (galleon.hullBowZ - galleon.hullSternZ),
      6,
    );
  });

  it('the galleon is untouched: her plan is still the §B.22 one', () => {
    // WHY: this refactor moved three module constants onto the params. Every
    // number in seaPhysics.ts was measured against bow 19 / stern −16.5 /
    // half-beam 4.25, so the expression that now produces them has to land
    // there exactly, and the default station set has to be the galleon's.
    const wl = waterlineOf(galleonParams);
    expect(wl.bowZ).toBeCloseTo(19, 12);
    expect(wl.sternZ).toBeCloseTo(-16.5, 12);
    expect(wl.halfBeam).toBe(4.25);
    expect(galleon.hullBowZ).toBe(wl.bowZ);
    expect(galleon.hullSternZ).toBe(wl.sternZ);
    expect(galleon.hullHalfBeam).toBe(wl.halfBeam);
    expect(probeStations(galleon.probeSlices)).toBe(
      probeStations(galleon.probeSlices, galleon),
    );
    // the two classes do NOT share a station set
    expect(probeStations(brig.probeSlices, brig)).not.toBe(
      probeStations(galleon.probeSlices, galleon),
    );
  });

  it('two classes on one sea each keep their own draft and memory', () => {
    // WHY: main.ts steps both ships on the same CpuOcean every tick. The
    // per-ship sea memory is keyed by ship identity and the station cache by
    // plan, so neither hull may end up on the other's draft or prevHeights.
    const pg = fast(galleon);
    const pb = fast(brig);
    const ocean = new CpuOcean(1, flatOcean(), pg);
    ocean.update(0);
    const g = makeShip('g');
    const b = makeShip('b');
    b.position[0] = 60;
    for (let i = 0; i < 1200; i++) {
      stepShipBuoyancy(g, ocean, DT, pg);
      stepShipBuoyancy(b, ocean, DT, pb);
    }
    expect(Math.abs(g.position[1] - equilibriumDraft(pg))).toBeLessThan(0.02);
    expect(Math.abs(b.position[1] - equilibriumDraft(pb))).toBeLessThan(0.02);
    expect(b.position[1]).not.toBeCloseTo(g.position[1], 2);
  });
});
