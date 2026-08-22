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
import { updateShipRig } from '../src/ship/rigTrim';
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
import { brigantineParams, galleonParams } from '../src/params/ship';

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

/**
 * A digest of the galleon's piece graph: id, kind, parent, position. Pinned so
 * that sharing the fittings builders with the brigantine (§T.73 deck fittings)
 * cannot silently move a plank on the PLAYER's ship. It changes ONLY with a
 * deliberate galleon edit, and then the new value is the one-line review.
 */
function pieceDigest(bp: PieceDef[]): string {
  const s = bp
    .map((p) => `${p.id}|${p.kind}|${p.parent ?? ''}|${p.transform.position.map((v) => v.toFixed(4)).join(',')}`)
    .join(';');
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${bp.length}:${h.toString(16)}`;
}

/** ship-space position of a piece, walking its parent chain (no rotations
 *  on the deck pieces involved here, and the test asserts that) */
function shipSpace(bp: PieceDef[], id: string): [number, number, number] {
  const piece = bp.find((p) => p.id === id);
  if (piece === undefined) throw new Error(`no piece ${id}`);
  const pos: [number, number, number] = [...piece.transform.position];
  if (piece.parent !== undefined) {
    const parent = bp.find((p) => p.id === piece.parent);
    expect(parent?.transform.rotation, `${piece.parent} is rotated`).toEqual([0, 0, 0]);
    const pp = shipSpace(bp, piece.parent);
    for (let i = 0; i < 3; i++) pos[i] += pp[i];
  }
  return pos;
}

describe('§T.73 she carries her own deck fittings — wheel, binnacle, capstan, lanterns', () => {
  const brig = buildBrigantineBlueprint();
  const galleon = buildGalleonBlueprint();
  const p = brigantineParams;
  const L2 = p.hullLength / 2;
  const byId = (id: string) => brig.find((x) => x.id === id);

  it('has a helm: wheel, its turning disc, and socket-wheel for the helm camera', () => {
    // WHY: user: "the small boat is missing the proper steering wheel, the
    // helm and this kind of stuff". The disc is what setHelmAngle spins (by
    // KIND, so she gets it on the same call the galleon does), and the socket
    // is what followCam parks on.
    const wheel = byId('wheel');
    const disc = byId('wheel-disc');
    expect(wheel?.kind).toBe('wheel');
    expect(disc?.kind).toBe('wheel-disc');
    expect(disc?.parent).toBe('wheel');
    const owners = brig.filter((x) => x.sockets.some((s) => s.id === 'socket-wheel'));
    expect(owners).toHaveLength(1);
  });

  it('stands the wheel on the MAIN DECK aft, clear of the mainmast foot and the rudder head', () => {
    // WHY: she has no sterncastle. A wheel parented to a deck she has not got
    // would throw in ShipAssembly; one at the galleon's quarterdeck offset
    // would float amidships. A brig steers from the main deck, ahead of the
    // tiller — so: deck height, aft third, inside the hull, not in the mast.
    const [, y, z] = shipSpace(brig, 'wheel');
    expect(y).toBeGreaterThanOrEqual(p.freeboard);
    expect(y).toBeLessThan(p.freeboard + 0.1);
    expect(z).toBeLessThan(-L2 / 3); // aft third
    expect(z).toBeGreaterThan(-L2 + 1.0); // inboard of the transom / rudder head
    const mainFoot = p.mainMastZ - p.mastRadius - 1.5; // mast + its fiferail
    expect(z + 0.3).toBeLessThan(mainFoot);
    // the socket is WHERE THE WHEEL IS, same deck, within a metre
    const socketOwner = brig.find((x) => x.sockets.some((s) => s.id === 'socket-wheel'))!;
    const socket = socketOwner.sockets.find((s) => s.id === 'socket-wheel')!;
    const so = shipSpace(brig, socketOwner.id);
    expect(Math.abs(so[2] + socket.position[2] - z)).toBeLessThan(1);
    expect(Math.abs(so[1] + socket.position[1] - y)).toBeLessThan(0.1);
    // and the binnacle is by the wheel, on the same deck
    const bin = shipSpace(brig, 'binnacle');
    expect(Math.abs(bin[1] - y)).toBeLessThan(0.1);
    expect(Math.abs(bin[2] - z)).toBeLessThan(2);
  });

  it('has a capstan on the main deck between the masts, clear of both fiferails', () => {
    // WHY: a 30 m brig weighs anchor with one. The naive hullLength×0.18 put
    // hers 2 cm inside the fore pin-rail; this pins the clearance as a
    // property so re-spacing the masts cannot reintroduce that.
    const cap = byId('capstan')!;
    expect(cap.parent).toBe('deck');
    const [, , z] = shipSpace(brig, 'capstan');
    expect(z).toBeLessThan(p.foreMastZ);
    expect(z).toBeGreaterThan(p.mainMastZ);
    for (const rail of brig.filter((x) => x.kind === 'pin-rail')) {
      const rz = shipSpace(brig, rail.id)[2];
      const gap = Math.abs(rz - z) - (rail.aabb.max[2] + cap.aabb.max[2]);
      expect(gap, `${rail.id} vs capstan`).toBeGreaterThan(0);
    }
    // the deck socket and the drum agree (§V.37)
    const deck = byId('deck')!;
    const socket = deck.sockets.find((s) => s.id === 'socket-capstan')!;
    expect(socket.position[2]).toBeCloseTo(cap.transform.position[2], 6);
  });

  it('declares both lantern sockets at her taffrail, on posts standing on a deck she has', () => {
    // WHY: main.ts hangs the practical lanterns off socket-lantern-port/
    // starboard. They are player-only today; the sockets are data and cost
    // nothing, and without them she can never carry a light.
    for (const side of ['port', 'starboard']) {
      const post = byId(`lantern-post-${side}`)!;
      expect(post.kind).toBe('lantern-post');
      expect(post.sockets.map((s) => s.id)).toContain(`socket-lantern-${side}`);
      const [x, y, z] = shipSpace(brig, post.id);
      expect(y).toBeCloseTo(p.freeboard, 6); // no cabin roof: the main deck
      expect(z).toBeLessThan(-L2 + 1); // at the transom head
      expect(Math.abs(x)).toBeLessThan(p.beam / 2); // inboard
      expect(post.aabb.max[1]).toBeGreaterThan(p.sheerStern + p.railHeight); // lamp above the rail
    }
  });

  it('flies an ensign and carries catheads + anchors, but no figurehead, no gallery, no castle rails', () => {
    // WHY: §V.18 — the builders are shared and a class without a feature is
    // SKIPPED. The negative half matters as much: a figurehead on a hull
    // whose bow declares no socket for it, or a 'stern-lights' window
    // parented to a gallery she lacks, is exactly the fork this guards.
    const ids = new Set(brig.map((x) => x.id));
    expect(ids.has('ensign-stern')).toBe(true);
    expect(ids.has('cathead-port') && ids.has('anchor-starboard')).toBe(true);
    expect(ids.has('figurehead')).toBe(false);
    expect(ids.has('stern-lights')).toBe(false);
    expect(ids.has('rail-quarterdeck-port')).toBe(false);
    // every parent resolves — the assembly would throw on a dangling one,
    // but say so here, by name
    for (const piece of brig) {
      if (piece.parent !== undefined) expect(ids.has(piece.parent), `${piece.id} -> ${piece.parent}`).toBe(true);
    }
  });

  it('the boot pipeline ends in a RIG DRIVE: the same call the player makes moves her canvas (§B88)', () => {
    // WHY: the walk above proves she BUILDS. §B88 is what the user actually
    // saw — she was built, she sailed, and her canvas stayed struck. The end
    // of the pipeline is `updateShipRig`, and this is the tie between the two:
    // the brigantine that came out of the blueprint answers it. The behaviour
    // itself (under AI, over a chase, in four winds) is tests/enemyRig.test.ts.
    const asm = new ShipAssembly(brig, stubFactory);
    updateShipRig({ sailTrim: 0, rudder: 0, brace: 0 }, asm, 1 / 60);
    const struck = asm.sailPieceIds().map((id) => asm.sailMesh(id).userData.sailDropScale as number);
    updateShipRig({ sailTrim: 1, rudder: 0.5, brace: 0.4 }, asm, 1 / 60);
    const set = asm.sailPieceIds().map((id) => asm.sailMesh(id).userData.sailDropScale as number);
    expect(set.length).toBe(struck.length);
    expect(set.length).toBeGreaterThan(0);
    for (let i = 0; i < set.length; i++) expect(set[i]).toBeGreaterThan(struck[i] + 0.5);
    expect(asm.braceAngle).toBeCloseTo(0.4, 6); // her yards, from her own brace
    expect(Math.abs(asm.wheelAngle)).toBeGreaterThan(0); // and her wheel, from her rudder
    asm.dispose();
  });

  it('adds NO piece kind (and so no material, no pipeline) the galleon does not already draw', () => {
    // WHY: §T.40 / §V.40 — one shared material set, keyed by piece KIND
    // (pieceMaterials.FAMILY_OF is total over PieceKind). Every kind she uses
    // is one the galleon already draws, so she binds nothing new; a kind of
    // her own would be a material on a second hull the budget test never sees.
    const galleonKinds = new Set(galleon.map((x) => x.kind));
    for (const piece of brig) {
      expect(galleonKinds.has(piece.kind), piece.kind).toBe(true);
    }
  });

  it('left the player galleon byte-identical: same pieces, same parents, same positions', () => {
    // WHY: the brigantine got her fittings by GENERALISING the galleon's
    // builders (helmStation, capstanStation, buildLanternPosts). This pins
    // the galleon's graph so that generalisation provably moved nothing on
    // the ship the user is standing on. Update the digest only with a
    // deliberate galleon change.
    expect(pieceDigest(galleon)).toBe('94:b2123106');
    expect(galleonParams.sterncastleLength).toBeGreaterThan(0); // the branch the brig does NOT take
  });
});
