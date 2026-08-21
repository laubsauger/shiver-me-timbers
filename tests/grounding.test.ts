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
import { quatFromAxisAngle, rotateVec } from '../src/core/quat';
import { oceanParams } from '../src/params/ocean';
import { seaPhysicsParams, type SeaPhysicsParams } from '../src/params/seaPhysics';
import { CpuOcean } from '../src/sea-physics/cpuOcean';
import { createHullContact, waterlineFromBox } from '../src/sea-physics/hullContact';
import { groundGrip, stepShipGrounding, type SeabedField } from '../src/sea-physics/grounding';
import { stepShipSailing, type Wind } from '../src/sailing/shipKinematics';
import { neutralInput } from '../src/sailing/input';
import { equilibriumDraft, stepShipBuoyancy } from '../src/sea-physics/buoyancy';
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
const equilibriumY = (p: SeaPhysicsParams): number => equilibriumDraft(p);

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
    // flat water is one mode at k = 0, so e^(−k·d) = 1 and the pressure head
    // IS the surface — the Smith correction (§V.68) is identically inert here
    pressureHeadAt(): number {
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

/**
 * A shoal that bites `bite` metres into the keel of a ship floating at her
 * design draft. Note this is NOT `-(draft − bite)`: she floats with her
 * waterline plane ~0.44 m BELOW the sea surface (that is what the spring/
 * mass ratio means), so measuring the bank from the waterline understates
 * the interference by half a metre and turns an intended brush into a hard
 * grounding. Named so no future test has to rediscover that.
 */
const bitesKeelBy = (bite: number, sp: SeaPhysicsParams): SeabedField =>
  SHOAL(equilibriumY(sp) - DRAFT + bite);

/**
 * A shoal that makes the SEABED CARRY `frac` of the ship's weight once she
 * has settled on it — which is the quantity every test below actually means
 * by "hard aground" or "a light touch", because grip is μ·N/m and N is
 * exactly that load.
 *
 * WHY this exists (§B.27): the depths used to be written as metres of bite,
 * and metres of bite stopped meaning what they meant the moment the hull got
 * its real displacement and its real reserve buoyancy. She now floats 2.44 m
 * into her own hull instead of 0.44 m, and — the part that actually bit —
 * her buoyancy no longer VANISHES when the waterline plane clears the water,
 * it fades over the whole 2 m of draft. So a bank that lifts her 1.2 m used
 * to leave her with nothing under her but sand, and now leaves her 83%
 * afloat: a light touch, correctly, and the sails walked her over it at 4
 * m/s. Nothing in grounding changed and its force balance still closes.
 *
 * She rests where buoyancy + bed = weight, and with the plane a height `−B`
 * above the sea the buoyancy is K·(−B) (see buoyancy.immersedDepth), so the
 * bed level for a given load fraction is algebra, not a magic number.
 */
const takesWeight = (frac: number, sp: SeaPhysicsParams): SeabedField =>
  SHOAL(-((sp.mass * 9.81 * (1 - frac)) / sp.buoyancySpring));

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
    // ...but she travelled to get there: a wall would stop her in ~0 m.
    // 1.5 m is ~90 ticks of decelerating from 8 m/s. (It was 3 m while
    // buoyancy was ALSO integrating the planar channel that this harness
    // integrates above — every distance in this file read exactly 2×,
    // §B.22.)
    expect(r.ship.position[2]).toBeGreaterThan(1.5);
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

describe('the sails cannot drive her over the bank (user bug)', () => {
  // WHY, verbatim: "we're crashing into something and the boat will still
  // try to continue to accelerate over a mountain — our sails magically
  // continue to propulse us forward." Grounding bled velocity while sailing
  // re-applied full thrust from the reduced velocity every tick, so she
  // ground onward for ever. These tests drive the WHOLE tick — sailing,
  // buoyancy, contact, grounding — because the bug only exists between two
  // modules that each looked right on their own.
  const WIND: Wind = { direction: 0, speed: 11 }; // toward +z, sailing weather

  function voyage(seabed: SeabedField, seconds: number, sp = testSeaParams()) {
    const ocean = flatSea(0);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ship.quaternion = quatFromAxisAngle([0, 1, 0], Math.PI / 2); // beam reach
    ship.sailTrim = 1; // sails full and drawing, the whole way
    const input = neutralInput();
    const track: number[] = [];
    const n = Math.round(seconds / DT);
    for (let i = 0; i < n; i++) {
      const t = (i + 1) * DT;
      stepShipSailing(ship, input, WIND, DT);
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, DT, sp);
      contact.update(ship, ocean, t);
      stepShipGrounding(ship, contact, seabed, DRAFT, DT, sp);
      track.push(Math.hypot(ship.position[0], ship.position[2]));
    }
    const speed = Math.hypot(ship.velocity[0], ship.velocity[2]);
    const last3s = track.slice(-Math.round(3 / DT));
    return { ship, speed, track, crept: last3s[last3s.length - 1] - last3s[0] };
  }

  it('open water: she sails, so the gate is not just breaking sailing', () => {
    const r = voyage(OPEN, 20);
    expect(r.speed).toBeGreaterThan(3);
    expect(r.crept).toBeGreaterThan(9); // still making way at the end
  });

  it('hard aground under full sail: she STOPS and stays stopped', () => {
    // the bank takes three quarters of her weight: μ·N/m = 7.4 m/s² against
    // a best-case 3.6 m/s² of thrust, so canvas cannot move her
    const r = voyage(takesWeight(0.75, testSeaParams()), 25);
    expect(r.speed).toBeLessThan(0.3);
    // the whole point: no crawling onward while the sails are still drawing
    expect(r.crept).toBeLessThan(0.5);
  });

  it('she rides up a cliff shelf and holds, instead of climbing it', () => {
    // the harshest island archetype: seabed rising steeply under her
    const r = voyage(SHELF(0.6, -(DRAFT + 6)), 30);
    expect(r.speed).toBeLessThan(0.5);
    expect(r.crept).toBeLessThan(1);
    expect(r.ship.position.every(Number.isFinite)).toBe(true);
  });

  it('a light touch only slows her — grounding is not a binary wall', () => {
    // WHY: a hard "aground = stopped" switch would make every shoal a
    // cliff. Brushing a bank should scrub speed and let her sail clear.
    // Measured gradient at 11 m/s of wind, by the load the bank takes:
    // 10% of her weight → 11.5 m/s, 25% → 9.2, 40% → 6.0, 60% → stopped.
    // One model, no switch.
    const sp = testSeaParams();
    const light = voyage(takesWeight(0.1, sp), 20, sp);
    const free = voyage(OPEN, 20, sp);
    expect(light.speed).toBeGreaterThan(0.5); // still moving...
    expect(light.speed).toBeLessThan(free.speed * 0.95); // ...but held back
  });

  it('and the hold deepens smoothly as she drives further on', () => {
    const sp = testSeaParams();
    const speeds = [0.1, 0.25, 0.4, 0.6].map((f) => voyage(takesWeight(f, sp), 20, sp).speed);
    for (let i = 1; i < speeds.length; i++) expect(speeds[i]).toBeLessThan(speeds[i - 1]);
    expect(speeds[speeds.length - 1]).toBeLessThan(0.3); // ...and finally holds
  });
});

describe('getting off again (grounding must not be a soft game-over)', () => {
  it('a swell lifts her clear, and the sails bite again', () => {
    // WHY: if running aground were permanent it would be worse than having
    // no grounding at all. The escape route is physical, not a special
    // case: the sea takes her weight back, N falls, the grip falls with it.
    const sp = testSeaParams();
    const ocean = new CpuOcean(7, { ...oceanParams, resolution: 128, amplitude: 1.2 }, sp);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    // aground hard enough to be stopped, not so hard she is high and dry
    const seabed = bitesKeelBy(0.3, sp);
    let liftedTicks = 0;
    let heldTicks = 0;
    for (let i = 0; i < 1800; i++) {
      const t = (i + 1) * DT;
      ocean.update(t);
      stepShipBuoyancy(ship, ocean, DT, sp);
      contact.update(ship, ocean, t);
      const g = stepShipGrounding(ship, contact, seabed, DRAFT, DT, sp);
      if (i < 600) continue;
      if (g.aground) heldTicks++;
      else liftedTicks++;
    }
    // she spends real time on the bottom...
    expect(heldTicks).toBeGreaterThan(100);
    // ...and real time floating free, which is when she can be worked off
    expect(liftedTicks).toBeGreaterThan(100);
    expect(groundGrip(ship, 0)).toBeLessThan(20);
  });

  it('the hold fades if the grounding step stops running at all', () => {
    // WHY: main.ts may skip grounding far from land as an optimisation. A
    // grip left behind by the last call would cripple her sails for the
    // rest of the voyage, and it would look like a sailing bug.
    const sp = testSeaParams();
    const ocean = flatSea(0);
    const contact = createHullContact(HULL, 11);
    const ship = makeShip();
    ship.position[1] = equilibriumY(sp);
    ocean.update(DT);
    contact.update(ship, ocean, DT);
    stepShipGrounding(ship, contact, SHOAL(0), DRAFT, DT, sp);
    expect(groundGrip(ship, 0)).toBeGreaterThan(1); // she is held...

    const wind: Wind = { direction: 0, speed: 11 };
    ship.quaternion = quatFromAxisAngle([0, 1, 0], Math.PI / 2);
    ship.sailTrim = 1;
    for (let i = 0; i < 300; i++) stepShipSailing(ship, neutralInput(), wind, DT);
    // ...and five seconds later, with no grounding step, she sails again
    expect(groundGrip(ship, 0)).toBeLessThan(0.1); // negligible vs 3.6 thrust
    expect(Math.hypot(ship.velocity[0], ship.velocity[2])).toBeGreaterThan(2);
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
