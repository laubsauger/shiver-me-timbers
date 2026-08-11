/**
 * Running aground — WHY these tests: with islands in the scene the first
 * thing anyone does is sail at one. Two failure modes are equally bad and
 * pull opposite ways: sailing THROUGH the sand (no collision at all), and
 * hitting an invisible wall (a 40 m ship stopping dead). What we want in
 * between is: touches, slows, lists, holds. Each test below pins one of
 * those four words, plus the "open water changes nothing" guarantee, since
 * this runs every tick for a ship that is almost never aground.
 */
import { describe, expect, it } from 'vitest';
import { quatFromAxisAngle, rotateVec } from '../src/combat/quatMath';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { createHullContact, waterlineFromBox } from '../src/sea-physics/hullContact';
import { stepShipGrounding, type SeabedField } from '../src/sea-physics/grounding';
import { stepShipBuoyancy, PROBE_LAYOUT } from '../src/sea-physics/buoyancy';
import type { ShipState } from '../src/state/simState';

const DT = 1 / 60;
const DRAFT = 2;
const HULL = waterlineFromBox(21, -17.5, 4.25);

function testSeaParams(over: Partial<SeaPhysicsParams> = {}): SeaPhysicsParams {
  return { ...seaPhysicsParams, mirrorResolution: 64, ...over };
}
function makeShip(): ShipState {
  return {
    id: 's',
    kind: 'player',
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
const equilibriumY = (p: SeaPhysicsParams): number =>
  -(p.mass * 9.81) / (PROBE_LAYOUT.length * p.buoyancySpring);

const flatSea = (level = 0) => {
  let t = 0;
  return {
    get currentTime(): number {
      return t;
    },
    update(time: number): void {
      t = time;
    },
    heightAt(): number {
      return level;
    },
  };
};

/** open ocean, as the archipelago reports it away from land */
const OPEN: SeabedField = { heightAt: () => -45 };
/** a bank rising toward +x: shelves from −45 m to above the waterline */
const SHELF = (slope: number, offset = 0): SeabedField => ({
  heightAt: (x: number) => Math.max(-45, offset + slope * x),
});
/** a flat shoal at a fixed depth */
const SHOAL = (bedY: number): SeabedField => ({ heightAt: () => bedY });

function sail(
  seabed: SeabedField,
  opts: { seconds: number; speed: number; bedY?: number; sp?: SeaPhysicsParams },
) {
  const sp = opts.sp ?? testSeaParams();
  const ocean = flatSea(0);
  const contact = createHullContact(HULL, 11);
  const ship = makeShip();
  ship.position[1] = equilibriumY(sp);
  ship.velocity[2] = opts.speed;
  const n = Math.round(opts.seconds / DT);
  let everAground = false;
  let maxPen = 0;
  let settledPen = 0;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) * DT;
    ocean.update(t);
    // sailing's planar channel (thrust held constant by re-imposing nothing:
    // grounding friction is the only planar force in this harness)
    ship.position[0] += ship.velocity[0] * DT;
    ship.position[2] += ship.velocity[2] * DT;
    stepShipBuoyancy(ship, ocean, DT, sp);
    contact.update(ship, ocean, t);
    const g = stepShipGrounding(ship, contact, seabed, DRAFT, DT, sp);
    everAground = everAground || g.aground;
    maxPen = Math.max(maxPen, g.penetration);
    // settled = the last second, past the drop-in transient
    if (i >= n - 60) settledPen = Math.max(settledPen, g.penetration);
  }
  return { ship, everAground, maxPen, settledPen, contact };
}

const rollOf = (s: ShipState): number =>
  Math.asin(Math.max(-1, Math.min(1, rotateVec(s.quaternion, [1, 0, 0])[1])));

describe('open water: grounding must be inert', () => {
  it('45 m under the keel changes nothing at all', () => {
    // WHY: this runs every tick of every voyage. A grounding step that
    // leaks any force into open water would show up as mystery drag or a
    // ship that rides high, and would be blamed on buoyancy.
    const sp = testSeaParams();
    const ocean = flatSea(0);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ocean.update(DT);
    contact.update(ship, ocean, DT);
    const before = [...ship.velocity] as [number, number, number];
    const g = stepShipGrounding(ship, contact, OPEN, DRAFT, DT, sp);
    expect(g.aground).toBe(false);
    expect(g.normalForce).toBe(0);
    expect(ship.velocity).toEqual(before);
    expect(ship.angularVelocity).toEqual([0, 0, 0]);
  });
});

describe('the four words: touches, slows, lists, holds', () => {
  it('TOUCHES: a shoal shallower than the draft stops the hull sinking into it', () => {
    // WHY: sailing through sand is the bug. The keel must rest ON the bed.
    const sp = testSeaParams();
    const bedY = -(DRAFT - 0.5); // 1.5 m of water over a 2 m draft
    const r = sail(SHOAL(bedY), { seconds: 12, speed: 0, sp });
    expect(r.everAground).toBe(true);
    // she settles a few cm into the bank, not metres, and not through it
    // (the ship spawns already inside the bank here, so the interesting
    // number is where she comes to rest, not the drop-in transient)
    expect(r.settledPen).toBeLessThan(0.3);
    const keelY = r.ship.position[1] - DRAFT;
    expect(keelY).toBeGreaterThan(bedY - 0.5);
    // and she is floating HIGHER than her open-water draft, held up by sand
    expect(r.ship.position[1]).toBeGreaterThan(equilibriumY(sp) + 0.1);
  });

  it('SLOWS: way comes off over seconds, not in one tick (no invisible wall)', () => {
    const sp = testSeaParams();
    const r = sail(SHOAL(-(DRAFT - 0.4)), { seconds: 6, speed: 8, sp });
    const speed = Math.hypot(r.ship.velocity[0], r.ship.velocity[2]);
    expect(r.everAground).toBe(true);
    expect(speed).toBeLessThan(1); // she is stopped by the end...
    // ...but she travelled to get there: a wall would stop her in ~0 m
    expect(r.ship.position[2]).toBeGreaterThan(3);
  });

  it('HOLDS: aground and stopped, she stays stopped', () => {
    const sp = testSeaParams();
    const r = sail(SHOAL(-(DRAFT - 0.6)), { seconds: 20, speed: 6, sp });
    const speed = Math.hypot(r.ship.velocity[0], r.ship.velocity[2]);
    expect(speed).toBeLessThan(0.2);
  });

  it('LISTS: a bank shelving to one side rolls her over, from geometry alone', () => {
    // WHY: no authored "beached" pose — the list must emerge from which
    // stations touch first, or a bank from any other angle would look wrong.
    const sp = testSeaParams();
    const r = sail(SHELF(0.35, -(DRAFT - 0.6)), { seconds: 15, speed: 0, sp });
    expect(r.everAground).toBe(true);
    const roll = rollOf(r.ship);
    expect(Math.abs(roll)).toBeGreaterThan(0.02); // she is visibly over
    expect(Math.abs(roll)).toBeLessThan(0.9); // and not capsized by it
    // the bed rises toward +x, so the starboard keel takes the weight first
    // and is pushed UP — she lies over to port. rollOf is starboard-up
    // positive, so that is a positive roll; the opposite sign would mean the
    // ship leans INTO the bank, which is the classic torque-sign bug.
    expect(roll).toBeGreaterThan(0);
  });
});

describe('stability (a grounded ship must not explode)', () => {
  it('a hard grounding at speed stays finite and bounded', () => {
    // WHY: a spring stiff enough to hold 150 t is stiff enough to blow up a
    // 60 Hz explicit integrator if the damping or the lever arms are wrong.
    const sp = testSeaParams();
    const r = sail(SHOAL(0.5), { seconds: 20, speed: 12, sp }); // bank ABOVE water
    expect(r.everAground).toBe(true);
    expect(r.ship.position.every(Number.isFinite)).toBe(true);
    expect(r.ship.quaternion.every(Number.isFinite)).toBe(true);
    expect(Math.abs(r.ship.position[1])).toBeLessThan(20);
    expect(Math.hypot(...r.ship.angularVelocity)).toBeLessThan(2);
  });

  it('rides the waves while touching bottom instead of chattering', () => {
    // real swell over a shoal: the hull lifts off and settles back
    const sp = testSeaParams();
    const ocean = new CpuOcean(7, { ...oceanParams, resolution: 128, amplitude: 1 }, sp);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    let aground = 0;
    let maxAbsVy = 0;
    for (let i = 0; i < 1800; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, DT, sp);
      contact.update(ship, ocean, t);
      const g = stepShipGrounding(ship, contact, SHOAL(-(DRAFT - 0.3)), DRAFT, DT, sp);
      if (g.aground) aground++;
      if (i > 600) maxAbsVy = Math.max(maxAbsVy, Math.abs(ship.velocity[1]));
    }
    expect(aground).toBeGreaterThan(0);
    expect(Number.isFinite(maxAbsVy)).toBe(true);
    expect(maxAbsVy).toBeLessThan(8); // no trampoline
  });
});

describe('§B.6: grounding respects the channel split', () => {
  it('never writes yaw rate or spins the ship up about its mast', () => {
    const sp = testSeaParams();
    const ocean = flatSea(0);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 1, 0], 0.8); // sailing owns this
    ship.angularVelocity[1] = 0.42; // ...and this
    ocean.update(DT);
    contact.update(ship, ocean, DT);
    stepShipGrounding(ship, contact, SHOAL(0), DRAFT, DT, sp);
    expect(ship.angularVelocity[1]).toBe(0.42);
  });
});
