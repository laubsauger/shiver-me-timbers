/**
 * §V13/§V14 destruction ops. WHY: damage must ONLY act through piece-graph
 * ops (V13) so AI-mesh swaps and netcode replay keep working; thresholds
 * must fire exactly once (V14 splinter burst ≠ every hit); flooding must
 * see the ship's roll or T18's sink logic floods the wrong compartments.
 */
import { describe, expect, it } from 'vitest';
import type { Material, Mesh } from 'three';
import { applyHitDamage, floodingHoles, type DestructionEvent } from '../src/ship/destruction';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import type { HitEvent } from '../src/combat/hitTest';
import { quatFromAxisAngle } from '../src/combat/quatMath';
import type { Quat } from '../src/state/simState';

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;
const IDENTITY: Quat = [0, 0, 0, 1];
const P = { hitDamage: 0.25, holedThreshold: 0.5, splinterCount: 10 };
const hitOn = (pieceId: string): HitEvent => ({
  shipIndex: 0,
  pieceId,
  point: [4.2, 0.1, -1],
  projectileId: 7,
});

function freshShip() {
  const blueprint = buildGalleonBlueprint();
  return { blueprint, asm: new ShipAssembly(blueprint, stub) };
}

describe('applyHitDamage (§V14)', () => {
  it('decrements hp deterministically — same hits, same hp, same events', () => {
    const run = (): [Record<string, number>, DestructionEvent[]] => {
      const { blueprint, asm } = freshShip();
      const damage: Record<string, number> = {};
      const events = [
        ...applyHitDamage(asm, blueprint, hitOn('hull-starboard-mid'), damage, P).events,
        ...applyHitDamage(asm, blueprint, hitOn('hull-starboard-mid'), damage, P).events,
        ...applyHitDamage(asm, blueprint, hitOn('mast-fore'), damage, P).events,
      ];
      asm.dispose();
      return [damage, events];
    };
    const [damageA, eventsA] = run();
    const [damageB, eventsB] = run();
    expect(damageA).toEqual(damageB);
    expect(eventsA).toEqual(eventsB);
    expect(damageA['hull-starboard-mid']).toBe(0.5);
  });

  it('swaps to holed + spawns splinters exactly at the threshold, once', () => {
    const { blueprint, asm } = freshShip();
    const damage: Record<string, number> = {};
    const mesh = asm.group.getObjectByName('hull-port-mid-mesh') as Mesh;
    const intactGeo = mesh.geometry;

    const first = applyHitDamage(asm, blueprint, hitOn('hull-port-mid'), damage, P);
    expect(first.events).toEqual([]); // hp 0.75 > threshold: no swap yet
    expect(mesh.geometry).toBe(intactGeo);

    const second = applyHitDamage(asm, blueprint, hitOn('hull-port-mid'), damage, P);
    expect(second.events).toEqual([
      { type: 'splinters', position: [4.2, 0.1, -1], count: P.splinterCount },
    ]);
    expect(mesh.geometry).not.toBe(intactGeo); // §V13: swap via piece op
    expect(mesh.geometry.groups).toHaveLength(2); // breach overlay group

    const third = applyHitDamage(asm, blueprint, hitOn('hull-port-mid'), damage, P);
    expect(third.events).toEqual([]); // no splinter re-trigger below threshold
    asm.dispose();
  });

  it('mast at 0 hp detaches as one subtree with its yards (V14 mast break)', () => {
    const { blueprint, asm } = freshShip();
    const damage: Record<string, number> = { 'mast-main': 0.25 };
    const result = applyHitDamage(asm, blueprint, hitOn('mast-main'), damage, P);
    expect(result.events).toEqual([{ type: 'mastFall', pieceId: 'mast-main' }]);
    expect(result.detachedSubtree).toBeDefined();
    for (const child of ['yard-main-lower', 'yard-main-upper', 'crow-nest']) {
      expect(result.detachedSubtree!.getObjectByName(child), child).toBeDefined();
    }
    expect(asm.group.getObjectByName('mast-main')).toBeUndefined();
    // further hits on the fallen mast are inert
    expect(applyHitDamage(asm, blueprint, hitOn('mast-main'), damage, P).events).toEqual([]);
    asm.dispose();
  });

  it('rejects hits on pieces the blueprint does not know (fail loud)', () => {
    const { blueprint, asm } = freshShip();
    expect(() => applyHitDamage(asm, blueprint, hitOn('ghost'), {}, P)).toThrow();
    asm.dispose();
  });

  it('emits only JSON-serializable records (fx/netcode replay them)', () => {
    const { blueprint, asm } = freshShip();
    const damage: Record<string, number> = {
      'hull-port-bow': 0.6,
      'mast-rear': 0.2,
    };
    const events = [
      ...applyHitDamage(asm, blueprint, hitOn('hull-port-bow'), damage, P).events,
      ...applyHitDamage(asm, blueprint, hitOn('mast-rear'), damage, P).events,
    ];
    expect(events.map((e) => e.type)).toEqual(['splinters', 'mastFall']);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    asm.dispose();
  });
});

describe('floodingHoles (§V14 → T18 flooding)', () => {
  const blueprint = buildGalleonBlueprint();

  it('counts only non-intact damage zones below the waterline', () => {
    expect(floodingHoles(blueprint, {}, IDENTITY, 0).count).toBe(0);
    const holes = floodingHoles(blueprint, { 'hull-port-mid': 'holed' }, IDENTITY, 0);
    expect(holes.count).toBe(1);
    expect(holes.positions[0][1]).toBeLessThan(0); // dz sits below waterline
    // destroyed sections flood too
    expect(
      floodingHoles(blueprint, { 'hull-port-mid': 'destroyed' }, IDENTITY, 0).count,
    ).toBe(1);
  });

  it('respects ship roll — a rolled ship submerges different holes', () => {
    const states = { 'hull-port-mid': 'holed' } as const;
    // roll port side up 30°: the port breach lifts clear of the water
    const portUp = quatFromAxisAngle([0, 0, 1], -Math.PI / 6);
    expect(floodingHoles(blueprint, states, portUp, 0).count).toBe(0);
    // roll port side down 30°: breach goes deeper, still flooding
    const portDown = quatFromAxisAngle([0, 0, 1], Math.PI / 6);
    expect(floodingHoles(blueprint, states, portDown, 0).count).toBe(1);
    // same roll, starboard breach: exactly the mirrored outcome
    const starboard = { 'hull-starboard-mid': 'holed' } as const;
    expect(floodingHoles(blueprint, starboard, portUp, 0).count).toBe(1);
    expect(floodingHoles(blueprint, starboard, portDown, 0).count).toBe(0);
  });

  it('accepts raw zone hp (ShipState.damage) — hp ≤ threshold is breached', () => {
    expect(floodingHoles(blueprint, { 'hull-port-mid': 0.3 }, IDENTITY, 0).count).toBe(1);
    expect(floodingHoles(blueprint, { 'hull-port-mid': 0.9 }, IDENTITY, 0).count).toBe(0);
  });

  it('returns JSON-serializable plain data', () => {
    const holes = floodingHoles(blueprint, { 'hull-port-stern': 'holed' }, IDENTITY, 0);
    expect(JSON.parse(JSON.stringify(holes))).toEqual(holes);
  });
});
