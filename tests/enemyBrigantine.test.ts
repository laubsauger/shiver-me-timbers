/**
 * §T.73 — the enemy is the brigantine, and every pipeline she passes through
 * in main.ts has to accept her. The class has had unit coverage per subsystem
 * for a while; what was missing is the END-TO-END walk the boot actually
 * takes (assembly → rigging plan → ratlines → blocks → deck field → battery →
 * hit targets → arena targets), which is where "tolerates a class without a
 * rear mast" was a belief rather than a measurement.
 *
 * Properties, not decisions (§V.80): "two masts" is asserted as FEWER masts
 * than the galleon and "smaller" as a SHORTER hull, so re-proportioning either
 * class does not fail this file — only making them the same ship does.
 */
import { describe, expect, it } from 'vitest';
import type { Material } from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildBlockDescriptors, buildRiggingPlan } from '../src/ropes/shipRigging';
import { buildRatlinePlan } from '../src/ship/ratlinePlan';
import { buildRungDescriptors } from '../src/ropes/ratlines';
import { buildDeckHeightfield } from '../src/ship/deckHeightfield';
import { buildBattery } from '../src/combat/battery';
import { buildHitTargetSet } from '../src/combat/hitTargets';
import { arenaTargets } from '../src/combat/combatArena';
import { ropeParams } from '../src/params/ropes';
import { shipMaterialParams } from '../src/params/ship';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

function hullExtentZ(bp: PieceDef[]): number {
  let bow = -Infinity;
  let stern = Infinity;
  for (const p of bp) {
    if (p.kind !== 'hull-section') continue;
    bow = Math.max(bow, p.transform.position[2] + p.aabb.max[2]);
    stern = Math.min(stern, p.transform.position[2] + p.aabb.min[2]);
  }
  return bow - stern;
}

describe('§T.73 the enemy brigantine is a DIFFERENT ship, built on the same rails', () => {
  const brig = buildBrigantineBlueprint();
  const galleon = buildGalleonBlueprint();

  it('is visibly a lighter class: fewer masts, shorter hull, than the player galleon', () => {
    // WHY: the user reported the NPC "was still the same ship". If these two
    // ever converge the wiring is back on the galleon and nobody would notice
    // from the unit tests of either class alone.
    const masts = (bp: PieceDef[]) => bp.filter((p) => p.kind === 'mast').length;
    expect(masts(brig)).toBeLessThan(masts(galleon));
    expect(masts(brig)).toBeGreaterThanOrEqual(2);
    expect(hullExtentZ(brig)).toBeLessThan(hullExtentZ(galleon));
  });

  it('carries canvas on EVERY yard — the AI sails her, and bare poles read as a wreck', () => {
    // WHY: the blueprint used to build her with `sails: false`. updateRig and
    // the sail driver both early-out on zero sails, so she would have sailed
    // at 0.7 trim under no cloth at all and nothing would have thrown.
    const yards = brig.filter((p) => p.kind === 'yard');
    expect(yards.length).toBeGreaterThan(0);
    for (const yard of yards) {
      const sail = brig.find((p) => p.kind === 'sail' && p.parent === yard.id);
      expect(sail, `yard ${yard.id} has no sail`).toBeDefined();
    }
  });

  it('walks the whole boot pipeline without a galleon-only socket or piece', () => {
    // WHY: main.ts feeds ONE blueprint through all of these. Any of them
    // reaching for `mast-rear`, a crow's nest, or a sterncastle socket by name
    // throws or silently produces nothing — this is the tripwire for both.
    const asm = new ShipAssembly(brig, stubFactory);
    expect(asm.group.children.length).toBeGreaterThan(10);

    const plan = buildRiggingPlan(brig);
    expect(plan.length).toBeGreaterThan(0);
    // every rope end resolves on the live assembly (what the per-frame
    // anchor rewrite in main.ts does)
    for (const rope of plan) {
      expect(asm.socketWorldPosition(rope.socketA)).toHaveLength(3);
      expect(asm.socketWorldPosition(rope.socketB)).toHaveLength(3);
    }
    // sails ARE rigged: clews are sheeted, not just yard ends braced
    expect(plan.some((r) => r.role === 'sheet')).toBe(true);

    const ladders = buildRatlinePlan(brig);
    expect(ladders.length).toBeGreaterThan(0);
    const declared = ladders.reduce((n, l) => n + l.rungs.length, 0);
    expect(buildRungDescriptors(ladders, plan)).toHaveLength(declared);

    expect(buildBlockDescriptors(plan, ropeParams.maxBlocks).length).toBeGreaterThan(0);

    // her OWN deck field, not the galleon's (§V.18) — and a smaller one
    const field = buildDeckHeightfield(brig);
    const galleonField = buildDeckHeightfield(galleon);
    expect(field).not.toBeNull();
    expect(galleonField).not.toBeNull();
    expect(field!.maxZ - field!.minZ).toBeLessThan(galleonField!.maxZ - galleonField!.minZ);

    // a broadside on each side, from her hull-mounted sockets
    const battery = buildBattery(brig);
    expect(battery.port.length).toBeGreaterThan(0);
    expect(battery.port.length).toBe(battery.starboard.length);

    expect(buildHitTargetSet(brig).pieces.length).toBeGreaterThan(0);

    // the combat arena force-hits ship 1 by piece id — those ids must be hers
    const targets = arenaTargets(brig);
    const ids = new Set(brig.map((p) => p.id));
    expect(ids.has(targets.mastId)).toBe(true);
    for (const id of targets.hullIds) expect(ids.has(id)).toBe(true);
    asm.dispose();
  });

  it('setSailTint dyes every sail and nothing else, and ignores a non-finite value (§V28)', () => {
    // WHY: the tint is a per-mesh uniform on the SHARED sail material
    // (§T.40 — she adds no pipeline). If it landed on any non-sail mesh the
    // driver would ignore it silently; if it skipped a sail, one sail would
    // stay white.
    const asm = new ShipAssembly(brig, stubFactory);
    asm.setSailTint(shipMaterialParams.npcSailTint);
    const sails = new Set(asm.sailPieceIds());
    expect(sails.size).toBeGreaterThan(0);
    asm.group.traverse((o) => {
      const tint = o.userData.sailTint;
      const pieceId = o.name.replace(/-mesh$/, '');
      if (sails.has(pieceId) && o.name.endsWith('-mesh')) {
        expect(tint).toBe(shipMaterialParams.npcSailTint);
      } else {
        expect(tint).toBeUndefined();
      }
    });
    asm.setSailTint(Number.NaN);
    for (const id of sails) {
      expect(asm.sailMesh(id).userData.sailTint).toBe(shipMaterialParams.npcSailTint);
    }
    asm.dispose();
  });
});
