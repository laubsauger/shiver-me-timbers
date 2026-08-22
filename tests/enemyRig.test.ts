/**
 * §T.118 / §B88 — THE ENEMY SAILS UNDER HER OWN CANVAS.
 *
 * USER, pirate mode: "the enemy ship is steering around and driving around,
 * the NPC ship, but the sails are furled — makes me think the rig update rule
 * doesn't apply to that one, which is obviously not correct."
 *
 * The rig rule DID apply to her (main.ts has called `updateRig` on the enemy
 * assembly since §T.76). What did not was the CANVAS ORDER behind it: the AI
 * used `sailTrim` as a point-of-sail throttle (`steering.sailTrimFor`, floor
 * 0.15 inside the irons cone), and since §T.85 made the cloth drop continuous
 * in trim, 0.15 is drawn as a furled bundle on the yard. So she manoeuvred
 * with her canvas struck. Two smaller player-only leaks rode with it: the
 * rigging furl the enemy's ropes were hauled by was the PLAYER's, and the
 * per-frame drive had been copied per vessel instead of shared.
 *
 * EVERY TEST HERE DRIVES THE SIM AND READS WHAT THE SHADER READS (§V62): the
 * drop scale off each sail mesh's userData (`sailDriver` reads exactly that
 * field), the yard angle off the assembly, the wheel off the assembly. None of
 * them asserts that a function was called.
 *
 * §V80 properties, not decisions: "she carries working canvas" is asserted as
 * a drop scale WELL ABOVE the furled floor, never as a particular number, and
 * "her yards are her own" as two ships DIFFERING, never as two constants.
 */
import { describe, expect, it } from 'vitest';
import { Vector3, type Material } from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { rigDrive, rudderBladeAngle, updateShipRig } from '../src/ship/rigTrim';
import { trimDropScale } from '../src/ship/sailDynamics';
import { createAiShip, stepAiShip } from '../src/ai/aiShip';
import { yawOf } from '../src/ai/steering';
import { autoBrace, slewRudder, stepShipSailing, windBearing } from '../src/sailing/shipKinematics';
import type { InputState } from '../src/sailing/input';
import { createInitialState, type ShipState } from '../src/state/simState';
import { quatFromAxisAngle } from '../src/core/quat';
import { SIM_DT } from '../src/core/loop';
import { shipRigParams } from '../src/params/ship';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

/** the canvas the SHADER will read: the drop scale on the sail meshes */
function drawnDropScale(asm: ShipAssembly): number {
  const ids = asm.sailPieceIds();
  expect(ids.length).toBeGreaterThan(0); // a ship with no canvas proves nothing
  let min = Infinity;
  for (const id of ids) {
    const v = asm.sailMesh(id).userData.sailDropScale as number | undefined;
    min = Math.min(min, typeof v === 'number' ? v : 1);
  }
  return min;
}

function makeShip(id: string, kind: ShipState['kind'], pos: [number, number, number], yaw: number, trim: number): ShipState {
  return {
    id, kind, position: pos, quaternion: quatFromAxisAngle([0, 1, 0], yaw),
    velocity: [0, 0, 0], angularVelocity: [0, 0, 0], rudder: 0, sailTrim: trim,
    flood: 0, damage: {},
  };
}

const HELM_CENTRED: InputState = {
  rudder: 0, sailTrimDelta: 0, braceDelta: 0, brake: false, fire: false, anchorToggle: false,
};

/** one vessel through the sim tick and then through the ONE rig drive */
function sailFor(
  seconds: number,
  ship: ShipState,
  asm: ShipAssembly,
  wind: { direction: number; speed: number },
  input: InputState = HELM_CENTRED,
): void {
  for (let i = 0; i < Math.round(seconds / SIM_DT); i++) {
    stepShipSailing(ship, input, wind, SIM_DT);
    asm.group.position.set(ship.position[0], ship.position[1], ship.position[2]);
    asm.group.quaternion.set(...ship.quaternion);
    asm.group.updateMatrixWorld(true);
    updateShipRig(ship, asm, SIM_DT);
  }
}

describe('§B88 the enemy makes way under working canvas, not under a furled bundle', () => {
  it('sets her canvas from FURLED and keeps it set while she manoeuvres under AI', () => {
    // WHY: this is the reported bug, measured the way the user saw it — the
    // canvas the shader draws, over a long chase, while she is making way.
    // Before the fix she carried under 35% of her drop for 12–52% of a chase
    // (mean 0.54–0.69, min 0.224) at 3–7 knots.
    const furled = trimDropScale(0, shipRigParams);
    for (const windDirection of [0, 1.6, 3.0, -1.2]) {
      const state = createInitialState(11);
      state.wind = { direction: windDirection, speed: 9 };
      const player = makeShip('p', 'player', [0, 0, 0], 0.7, 1);
      const enemy = makeShip('e', 'enemy', [180, 0, -140], 2.0, 0); // canvas struck
      state.ships.push(player, enemy);
      const ai = createAiShip(1, [180, -140]);
      const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);

      updateShipRig(enemy, asm, SIM_DT);
      expect(drawnDropScale(asm), 'starts furled, so a pass is a real change')
        .toBeCloseTo(furled, 6);

      let worstUnderWay = 1;
      let sawWay = false;
      for (let i = 0; i < Math.round(180 / SIM_DT); i++) {
        // the player keeps sailing a lazy circle, so the geometry the AI
        // answers to keeps changing and she is driven onto every point of sail
        stepShipSailing(
          player,
          { ...HELM_CENTRED, rudder: Math.sin(i / 900) * 0.6 },
          state.wind,
          SIM_DT,
        );
        stepShipSailing(enemy, stepAiShip(ai, state, 0).input, state.wind, SIM_DT);
        state.tick++;
        state.time += SIM_DT;
        asm.group.position.set(enemy.position[0], enemy.position[1], enemy.position[2]);
        asm.group.quaternion.set(...enemy.quaternion);
        asm.group.updateMatrixWorld(true);
        updateShipRig(enemy, asm, SIM_DT);
        if (i * SIM_DT < 20) continue; // give the crew time to make sail
        const speed = Math.hypot(enemy.velocity[0], enemy.velocity[2]);
        if (speed < 1) continue; // hove to for some reason: not this test's claim
        sawWay = true;
        worstUnderWay = Math.min(worstUnderWay, drawnDropScale(asm));
      }
      expect(sawWay, `wind ${windDirection}: she never made way at all`).toBe(true);
      // the property: canvas SET, not a particular trim. The furled floor is
      // trimDropMin (0.03); anything near it is the bundle the user saw.
      expect(worstUnderWay, `wind ${windDirection}: worst drop while under way`)
        .toBeGreaterThan(0.7);
    }
  });

  it('carries more way with her canvas set than she did with it struck', () => {
    // WHY: §V62 — the canvas has to DRIVE something, or "she sets sail" is a
    // cosmetic claim. Same ship, same wind, same helm: trim is the only
    // difference, and it has to show up in the water she goes through.
    const wind = { direction: 0.9, speed: 9 };
    const run = (trim: number): number => {
      const ship = makeShip('e', 'enemy', [0, 0, 0], 2.2, trim);
      const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
      sailFor(40, ship, asm, wind);
      return Math.hypot(ship.velocity[0], ship.velocity[2]);
    };
    expect(run(1)).toBeGreaterThan(run(0.15) * 1.5);
  });
});

describe('§B88 the yards are HERS: braced to her own apparent wind, per ship', () => {
  it('her yards follow the wind when the wind turns under her', () => {
    // WHY: §V77 — the brace must come from the sim expressions that own it
    // (windBearing → autoBrace), evaluated on HER heading, not from a copy.
    const ship = makeShip('e', 'enemy', [0, 0, 0], 1.1, 1);
    const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    const first = { direction: 0, speed: 9 };
    sailFor(20, ship, asm, first);
    const settled = asm.braceAngle;
    expect(settled).toBeCloseTo(
      autoBrace(windBearing(yawOf(ship.quaternion), first.direction), shipRigParams),
      2,
    );

    // haul the wind round a quarter of the compass and let her yards answer
    const veered = { direction: first.direction + 1.4, speed: 9 };
    const target = autoBrace(windBearing(yawOf(ship.quaternion), veered.direction), shipRigParams);
    sailFor(20, ship, asm, veered);
    expect(Math.abs(target - settled), 'the test wind must actually move the yards')
      .toBeGreaterThan(0.2);
    expect(asm.braceAngle).toBeCloseTo(target, 2);
    expect(Math.abs(asm.braceAngle - settled)).toBeGreaterThan(0.2);
  });

  it('two ships on different headings in ONE wind brace differently', () => {
    // WHY: the whole §V95 claim. A brace computed once and applied to every
    // assembly would pass every single-ship test above and fail this one.
    const wind = { direction: 0.3, speed: 9 };
    const a = makeShip('a', 'enemy', [0, 0, 0], 0.4, 1);
    const b = makeShip('b', 'enemy', [400, 0, 0], 2.6, 1);
    const asmA = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    const asmB = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    sailFor(20, a, asmA, wind);
    sailFor(20, b, asmB, wind);
    expect(Math.abs(asmA.braceAngle - asmB.braceAngle)).toBeGreaterThan(0.2);
    expect(asmA.braceAngle).toBeCloseTo(
      autoBrace(windBearing(yawOf(a.quaternion), wind.direction), shipRigParams), 2);
    expect(asmB.braceAngle).toBeCloseTo(
      autoBrace(windBearing(yawOf(b.quaternion), wind.direction), shipRigParams), 2);
  });
});

describe('§V95 one rig drive, and every scalar it returns belongs to the ship it was given', () => {
  it('two ships at different trims get different canvas AND different rigging furl', () => {
    // WHY: main.ts computed the furl scalar once, from the PLAYER's trim, and
    // handed it to the ENEMY's rigging plan as well — her ropes were hauled by
    // the player's sheets. This is the tripwire for that crossing.
    const asmFull = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    const asmFurled = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    const full = updateShipRig({ sailTrim: 1, rudder: 0 }, asmFull, 1 / 60);
    const furled = updateShipRig({ sailTrim: 0, rudder: 0 }, asmFurled, 1 / 60);

    expect(full.drop).toBeGreaterThan(furled.drop);
    expect(full.furl).toBeLessThan(furled.furl);
    expect(full.furl).toBeCloseTo(0, 6);
    expect(furled.furl).toBeCloseTo(1, 6);
    // and the canvas each assembly is drawn with agrees with the furl its
    // ropes are hauled to — one scalar, two consumers (§B.30)
    expect(drawnDropScale(asmFull)).toBeCloseTo(full.drop, 6);
    expect(drawnDropScale(asmFurled)).toBeCloseTo(furled.drop, 6);
  });

  it('furl is the normalised complement of drop, monotone, and clamped (§V28)', () => {
    let prev = rigDrive(0).furl;
    expect(prev).toBeCloseTo(1, 6);
    for (let t = 0.05; t <= 1.0001; t += 0.05) {
      const d = rigDrive(t);
      expect(d.furl).toBeLessThanOrEqual(prev + 1e-9);
      expect(d.furl).toBeGreaterThanOrEqual(0);
      expect(d.furl).toBeLessThanOrEqual(1);
      prev = d.furl;
    }
    expect(rigDrive(1).furl).toBeCloseTo(0, 6);
    // a non-finite trim must not poison a rope length or a vertex
    expect(Number.isFinite(rigDrive(Number.NaN).furl)).toBe(true);
  });

  it('her wheel turns with HER rudder, and a brace-less class leaves her yards alone', () => {
    // WHY: the helm is the other half of "the rig update rule applies to her".
    // And a vessel whose sim carries no brace (the raft) must not have her
    // yards flung to 0 by the same call — `brace` absent means "leave them".
    const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    updateShipRig({ sailTrim: 1, rudder: 0, brace: 0.5 }, asm, 1 / 60);
    const braced = asm.braceAngle;
    expect(braced).toBeCloseTo(0.5, 6);

    updateShipRig({ sailTrim: 1, rudder: 1 }, asm, 1 / 60);
    const starboard = asm.wheelAngle;
    updateShipRig({ sailTrim: 1, rudder: -1 }, asm, 1 / 60);
    expect(asm.wheelAngle).toBeCloseTo(-starboard, 6);
    expect(Math.abs(starboard)).toBeGreaterThan(0.5);
    // yards untouched by the two brace-less calls
    expect(asm.braceAngle).toBeCloseTo(braced, 6);
  });
});

describe('§B92 the rudder blade moves — on every hull, from her own helm', () => {
  /** where the blade's TRAILING EDGE stands, in ship-local space */
  function bladeTip(asm: ShipAssembly): Vector3 {
    const node = asm.group.getObjectByName('rudder');
    expect(node, 'this blueprint has no rudder piece').toBeDefined();
    asm.group.updateMatrixWorld(true);
    // the blade lies entirely abaft its own stock (blueprintEnds.buildRudder:
    // z ∈ [−chord, 0]), so −z in the piece's frame is its after edge
    return new Vector3(0, 0, -1).applyMatrix4(node!.matrixWorld).sub(
      new Vector3(0, 0, 0).applyMatrix4(node!.matrixWorld),
    );
  }

  for (const [name, blueprint] of [
    ['player galleon', buildGalleonBlueprint()],
    ['enemy brigantine', buildBrigantineBlueprint()],
  ] as const) {
    it(`${name}: hard a-starboard swings the blade to starboard, hard a-port to port`, () => {
      // WHY: §B92 — "the rudder does not seem to move on the big pirate ship,
      // or not enough". It did not move at all: only the WHEEL was driven. The
      // property asserted is the physical one — which way the after edge of the
      // blade goes — not a rotation sign, so re-authoring the piece's frame
      // cannot make this pass while the ship steers the wrong way.
      const asm = new ShipAssembly(blueprint, stubFactory);
      updateShipRig({ sailTrim: 1, rudder: 0 }, asm, 1 / 60);
      const amidships = bladeTip(asm);
      expect(Math.abs(amidships.x)).toBeLessThan(1e-6);

      updateShipRig({ sailTrim: 1, rudder: 1 }, asm, 1 / 60); // turn to starboard
      const over = bladeTip(asm);
      expect(over.x, 'blade to starboard when she turns to starboard').toBeGreaterThan(0.2);
      expect(over.distanceTo(amidships), 'the blade actually MOVED').toBeGreaterThan(0.2);

      updateShipRig({ sailTrim: 1, rudder: -1 }, asm, 1 / 60);
      expect(bladeTip(asm).x).toBeCloseTo(-over.x, 6);
      asm.dispose();
    });

    it(`${name}: the blade has STOPS — hard over is the blade limit, not the wheel's turns`, () => {
      // WHY: the wheel spins 3.5 turns lock to lock. Geared straight onto the
      // blade that is 5½ revolutions of rudder. A rudder stalls past ~35°, so
      // its travel is its own parameter and the two mappings must not be one.
      const asm = new ShipAssembly(blueprint, stubFactory);
      for (const r of [-5, -1, -0.3, 0, 0.3, 1, 5, Number.NaN]) {
        updateShipRig({ sailTrim: 1, rudder: r }, asm, 1 / 60);
        expect(Math.abs(asm.bladeAngle)).toBeLessThanOrEqual(shipRigParams.rudderBladeMax + 1e-9);
        expect(Number.isFinite(asm.bladeAngle)).toBe(true);
      }
      updateShipRig({ sailTrim: 1, rudder: 1 }, asm, 1 / 60);
      expect(Math.abs(asm.bladeAngle)).toBeCloseTo(shipRigParams.rudderBladeMax, 6);
      // and it is NOT the wheel's mapping — 3.5 turns is 11 rad, the blade 0.61
      expect(Math.abs(asm.wheelAngle)).toBeGreaterThan(Math.abs(asm.bladeAngle) * 4);
      asm.dispose();
    });
  }

  it('follows the helm through a real turn, on the ship the sim is actually steering', () => {
    // WHY (§V62): the assertions above drive the rig directly. This one steers
    // a ship — the blade has to track `ship.rudder` as the helmsman's own slew
    // moves it, on every frame, with no second lag of its own.
    const wind = { direction: 0.4, speed: 9 };
    const ship = makeShip('e', 'enemy', [0, 0, 0], 0.2, 1);
    const asm = new ShipAssembly(buildBrigantineBlueprint(), stubFactory);
    sailFor(15, ship, asm, wind); // way on, helm centred
    expect(Math.abs(asm.bladeAngle)).toBeLessThan(1e-9);

    const yawBefore = yawOf(ship.quaternion);
    let sawPartial = false;
    for (let i = 0; i < Math.round(6 / SIM_DT); i++) {
      // through `slewRudder`, which is where the ONE rudder rate limit lives —
      // the keyboard, the AI and a replayed input log all pass through it, and
      // the blade must inherit that rather than carry a second lag of its own
      stepShipSailing(
        ship,
        { ...HELM_CENTRED, rudder: slewRudder(ship.rudder, 1, SIM_DT) },
        wind,
        SIM_DT,
      );
      asm.group.quaternion.set(...ship.quaternion);
      asm.group.updateMatrixWorld(true);
      updateShipRig(ship, asm, SIM_DT);
      // the blade IS ship.rudder, geared — never a lagging copy of it
      expect(asm.bladeAngle).toBeCloseTo(rudderBladeAngle(ship.rudder, shipRigParams), 9);
      if (Math.abs(asm.bladeAngle) > 1e-6 && Math.abs(asm.bladeAngle) < shipRigParams.rudderBladeMax - 1e-6) {
        sawPartial = true; // she puts it over progressively, she does not snap
      }
    }
    expect(sawPartial, 'the blade jumped straight to hard over').toBe(true);
    expect(Math.abs(asm.bladeAngle)).toBeCloseTo(shipRigParams.rudderBladeMax, 6);
    // and she answered it: helm to starboard, head to starboard
    expect(yawOf(ship.quaternion)).toBeGreaterThan(yawBefore);
    asm.dispose();
  });
});
