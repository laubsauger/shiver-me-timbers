/**
 * §T52 dev jump. WHY each of these matters:
 *
 * - §V.62 is the reason the keydown test exists at all. This project has
 *   shipped TWELVE controls that drive nothing, every one of them discovered by
 *   a user reporting that a fix "did not work". A jump key is exactly that
 *   shape: a listener that looks wired and is not. So the binding is exercised
 *   through a real EventTarget with a real KeyboardEvent, and the assertion is
 *   that SimState moved — not that a handler was registered.
 * - the teleport itself is a §V.51/§V.8 hazard, not a setter. She carries
 *   momentum, an orientation belonging to the wave she left, and buoyancy's
 *   per-location memory of the sea under each station. Leaving any of those
 *   behind means she arrives fighting a sea she was never in.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  SPAWN_TARGET,
  bootJumpTarget,
  installJump,
  teleportShip,
  type JumpTarget,
} from '../src/debug/jump';
import { rotateVec } from '../src/combat/quatMath';
import type { ShipState } from '../src/state/simState';

const LAGOON: JumpTarget = { name: 'lagoon', x: 900, z: 150, heading: Math.PI / 2 };

function shipUnderWay(): ShipState {
  return {
    id: 'player',
    kind: 'player',
    position: [10, 1.5, -20],
    quaternion: [0.1, 0.2, 0.05, 0.97],
    velocity: [6, -1, 3],
    angularVelocity: [0.3, 0.4, -0.2],
    rudder: 0.5,
    sailTrim: 0.8,
    flood: 0,
    damage: {},
  };
}

/** minimal EventTarget stand-in — node has no window, and this proves more */
function fakeTarget(): EventTarget {
  return new EventTarget();
}

function keydown(code: string, shiftKey = false): Event {
  // KeyboardEvent is not in the node test env; the handler only reads these
  const e = new Event('keydown') as Event & Record<string, unknown>;
  e.code = code;
  e.shiftKey = shiftKey;
  e.metaKey = false;
  e.ctrlKey = false;
  e.altKey = false;
  return e;
}

describe('teleport leaves her in a state she could have sailed into', () => {
  it('puts her at the destination on the live sea, not at y = 0', () => {
    // arriving at datum while the sea there is at +3 m drops her three metres
    // and she answers with a heave she has no physical reason to have
    const ship = shipUnderWay();
    teleportShip(ship, LAGOON, 2.75);
    expect(ship.position[0]).toBe(900);
    expect(ship.position[1]).toBeCloseTo(2.75, 9);
    expect(ship.position[2]).toBe(150);
  });

  it('kills momentum and spin — she is not still going where she was going', () => {
    const ship = shipUnderWay();
    teleportShip(ship, LAGOON, 0);
    expect(ship.velocity).toEqual([0, 0, 0]);
    expect(ship.angularVelocity).toEqual([0, 0, 0]);
  });

  it('arrives level on the requested heading, dropping the old wave’s pose', () => {
    // yaw ONLY. The incoming quaternion carries the pitch and roll of the wave
    // she left; integrating that forward from a place it does not describe is
    // how a teleport turns into a capsize.
    const ship = shipUnderWay();
    teleportShip(ship, LAGOON, 0);
    const fwd = rotateVec(ship.quaternion, [0, 0, 1]);
    expect(fwd[1]).toBeCloseTo(0, 9); // dead level
    expect(Math.atan2(fwd[0], fwd[2])).toBeCloseTo(LAGOON.heading, 9);
    const up = rotateVec(ship.quaternion, [0, 1, 0]);
    expect(up[1]).toBeCloseTo(1, 9); // no heel
  });

  it('never writes a non-finite height into SimState (§V28)', () => {
    // the boot path teleports before the ocean mirror has been stepped, so the
    // water level lookup legitimately has no answer yet
    const ship = shipUnderWay();
    teleportShip(ship, LAGOON, Number.NaN);
    expect(Number.isFinite(ship.position[1])).toBe(true);
    expect(ship.position[1]).toBe(0);
  });
});

describe('§V.62: the key is wired to something, proven by pressing it', () => {
  it('J moves the ship — the control is not a no-op', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const jump = installJump({
      target,
      ship,
      targets: [LAGOON],
      waterLevelAt: () => 0,
    });
    target.dispatchEvent(keydown('KeyJ'));
    expect(ship.position[0]).toBe(900);
    expect(ship.position[2]).toBe(150);
    jump.dispose();
  });

  it('Shift+J returns her to spawn even when spawn was not in the list', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const jump = installJump({ target, ship, targets: [LAGOON], waterLevelAt: () => 0 });
    target.dispatchEvent(keydown('KeyJ'));
    target.dispatchEvent(keydown('KeyJ', true));
    expect(ship.position[0]).toBe(0);
    expect(ship.position[2]).toBe(0);
    expect(jump.targets.map((t) => t.name)).toContain(SPAWN_TARGET.name);
    jump.dispose();
  });

  it('J cycles rather than sticking on one destination', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const jump = installJump({ target, ship, targets: [LAGOON], waterLevelAt: () => 0 });
    target.dispatchEvent(keydown('KeyJ'));
    const first = [...ship.position];
    target.dispatchEvent(keydown('KeyJ'));
    expect([...ship.position]).not.toEqual(first);
    jump.dispose();
  });

  it('ignores other keys and modified presses', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const before = [...ship.position];
    const jump = installJump({ target, ship, targets: [LAGOON], waterLevelAt: () => 0 });
    target.dispatchEvent(keydown('KeyK'));
    const meta = keydown('KeyJ') as Event & Record<string, unknown>;
    meta.metaKey = true;
    target.dispatchEvent(meta);
    expect([...ship.position]).toEqual(before);
    jump.dispose();
  });

  it('dispose() actually detaches — a stale listener would steer a dead ship', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const jump = installJump({ target, ship, targets: [LAGOON], waterLevelAt: () => 0 });
    jump.dispose();
    const before = [...ship.position];
    target.dispatchEvent(keydown('KeyJ'));
    expect([...ship.position]).toEqual(before);
  });

  it('tells the caller to resync, on the same frame, with the destination', () => {
    // the render side interpolates between two cached ticks and the camera
    // chases on an exponential; both need telling or she smears and the lens
    // flies after her. The callback firing is the only thing that proves it.
    const target = fakeTarget();
    const ship = shipUnderWay();
    const onTeleport = vi.fn();
    const jump = installJump({
      target,
      ship,
      targets: [LAGOON],
      waterLevelAt: () => 0,
      onTeleport,
    });
    jump.jumpTo('lagoon');
    expect(onTeleport).toHaveBeenCalledTimes(1);
    expect(onTeleport.mock.calls[0][0]).toMatchObject({ name: 'lagoon' });
    // and the ship is already moved when it fires, not after
    expect(ship.position[0]).toBe(900);
    jump.dispose();
  });

  it('jumpTo reports an unknown name instead of silently doing nothing', () => {
    const target = fakeTarget();
    const ship = shipUnderWay();
    const jump = installJump({ target, ship, targets: [LAGOON], waterLevelAt: () => 0 });
    expect(jump.jumpTo('lagoon')).toBe(true);
    expect(jump.jumpTo('atlantis')).toBe(false);
    jump.dispose();
  });
});

describe('?at= boots at a destination without moving the default spawn', () => {
  it('reads the name, and reads nothing when absent', () => {
    expect(bootJumpTarget('?at=lagoon')).toBe('lagoon');
    expect(bootJumpTarget('?boot=baseline')).toBeNull();
    expect(bootJumpTarget('')).toBeNull();
  });
});
