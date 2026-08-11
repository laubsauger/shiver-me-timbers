/**
 * §V12/§V13 rigging plan tests. The plan is the contract between the ship
 * piece graph (socket ids) and the GPU rope solver (createRopes indices) —
 * if it references a socket that does not exist, or drifts between runs,
 * ropes attach to nothing after a ship-side rename. Pure data tests; no
 * three.js/WebGPU is imported at runtime (shipRigging uses type-only imports).
 */
import { describe, expect, it } from 'vitest';
import {
  applyBlocks,
  applyRiggingPlan,
  buildRiggingPlan,
  collectRopeAnchorIds,
  selectBlockSockets,
  validateRiggingPlan,
  type RiggingRope,
} from '../src/ropes/shipRigging';
import {
  buildBrigantineBlueprint,
  buildGalleonBlueprint,
} from '../src/ship/shipBlueprint';

describe('buildRiggingPlan (§V13 sockets → §V12 ropes)', () => {
  it('is deterministic: identical blueprints → identical plans', () => {
    // WHY: sim determinism (§V2) and GPU re-solve both assume the plan is a
    // pure function of the blueprint — no ordering drift between runs.
    expect(buildRiggingPlan(buildGalleonBlueprint())).toEqual(
      buildRiggingPlan(buildGalleonBlueprint()),
    );
    expect(buildRiggingPlan(buildBrigantineBlueprint())).toEqual(
      buildRiggingPlan(buildBrigantineBlueprint()),
    );
  });

  it('references only rope-anchor sockets that exist, on BOTH ship classes', () => {
    // WHY: ship geometry is being reworked independently (§V18 swappable
    // pieces); this pins the socket-id contract so a rename fails here, not
    // as ropes anchored to nothing in the demo.
    for (const blueprint of [buildGalleonBlueprint(), buildBrigantineBlueprint()]) {
      const plan = buildRiggingPlan(blueprint);
      const ids = collectRopeAnchorIds(blueprint);
      for (const rope of plan) {
        expect(ids.has(rope.socketA), rope.socketA).toBe(true);
        expect(ids.has(rope.socketB), rope.socketB).toBe(true);
      }
      expect(() => validateRiggingPlan(plan, blueprint)).not.toThrow();
    }
  });

  it('galleon rig is substantial (≥ 12 ropes) and never self-ties', () => {
    // WHY: the SoT look needs a dense rig (forestay/backstays/shrouds/
    // lifts/braces); a near-empty plan means categories silently dropped.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    expect(plan.length).toBeGreaterThanOrEqual(12);
    for (const rope of plan) {
      expect(rope.socketA).not.toBe(rope.socketB);
    }
    // no duplicate rope between the same socket pair (backstay/shroud dedupe)
    const keys = plan.map((r) => `${r.socketA}|${r.socketB}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('every rope has slack > 1 — ropes sag, never taut-clamped', () => {
    // WHY: length = chord × slack; slack ≤ 1 hits the solver's taut clamp
    // (straight line) and the signature catenary sag disappears (§V12).
    for (const blueprint of [buildGalleonBlueprint(), buildBrigantineBlueprint()]) {
      for (const rope of buildRiggingPlan(blueprint)) {
        expect(rope.slack).toBeGreaterThan(1);
        expect(rope.thickness).toBeGreaterThan(0);
      }
    }
  });
});

describe('expanded rig ("whole shebang" — sheets, both-yard braces, halyard)', () => {
  it('braces serve BOTH yard levels on every mast', () => {
    // WHY: the reference schema shows braces on upper and lower yards; a
    // regression back to lower-only silently halves the running rigging.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const braces = plan.filter((r) => r.role === 'brace');
    expect(braces).toHaveLength(12); // 3 masts × 2 yards × 2 sides
    expect(braces.some((r) => r.socketA.includes('-upper-'))).toBe(true);
  });

  it('sheets run from lower yard ends to bow cleats (clew stand-in)', () => {
    // WHY: the blueprint has no sail-clew sockets yet, so sheets start at
    // the lower yard ends by design — this pins that stand-in so it gets
    // revisited (fails) when clew sockets appear and the rule changes.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const sheets = plan.filter((r) => r.role === 'sheet');
    expect(sheets).toHaveLength(6); // 3 masts × lower yard × 2 sides
    for (const s of sheets) {
      expect(s.socketA).toMatch(/^anchor-yard-\w+-lower-/);
      expect(s.socketB).toMatch(/^anchor-cleat-bow-/);
    }
  });

  it('halyard ties the crow-nest socket into the rig (galleon only)', () => {
    // WHY: the crow's nest anchor was the one unused rope socket; the rig
    // should consume every anchor the ship declares or say why not.
    const galleon = buildRiggingPlan(buildGalleonBlueprint());
    expect(galleon.some((r) => r.role === 'halyard' && r.socketA === 'anchor-crow-nest')).toBe(true);
    const brig = buildRiggingPlan(buildBrigantineBlueprint());
    expect(brig.some((r) => r.role === 'halyard')).toBe(false); // no nest
  });

  it('bobstays anchor the bowsprit tip down to the bow cleats', () => {
    // WHY: the schema shows the bowsprit held by bow-side runs; without
    // them the forestay pulls the spar visually unsupported.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const bobstays = plan.filter(
      (r) => r.socketA === 'anchor-bowsprit-tip' && r.socketB.startsWith('anchor-cleat-bow-'),
    );
    expect(bobstays).toHaveLength(2);
  });
});

describe('selectBlockSockets (§V12 blocks at running-rigging ends)', () => {
  it('is deterministic, unique, capped, and references real sockets', () => {
    // WHY: block instances are placed by plan order — nondeterminism or
    // unknown ids would scatter pulleys into thin air after a re-apply.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const sockets = selectBlockSockets(plan, 20);
    expect(sockets).toEqual(selectBlockSockets(plan, 20));
    expect(new Set(sockets).size).toBe(sockets.length);
    expect(sockets.length).toBeLessThanOrEqual(20);
    expect(sockets.length).toBeGreaterThan(0);
    const ids = collectRopeAnchorIds(buildGalleonBlueprint());
    for (const id of sockets) expect(ids.has(id), id).toBe(true);
    // yard ends dominate: that's where lifts/braces/sheets terminate
    expect(sockets.filter((id) => id.includes('yard')).length).toBeGreaterThanOrEqual(8);
    // a tighter cap truncates deterministically
    expect(selectBlockSockets(plan, 5)).toEqual(sockets.slice(0, 5));
  });
});

describe('validateRiggingPlan (fail loud on unknown sockets)', () => {
  it('throws when a plan references a socket id the blueprint lacks', () => {
    // WHY: the concurrent ship rework may rename sockets; silent mis-rig is
    // the §B bug class this guards against.
    const bogus: RiggingRope[] = [
      {
        socketA: 'anchor-masthead-fore',
        socketB: 'anchor-nope',
        role: 'stay',
        slack: 1.1,
        thickness: 0.03,
      },
    ];
    expect(() => validateRiggingPlan(bogus, buildGalleonBlueprint())).toThrow(
      /anchor-nope/,
    );
  });
});

describe('applyRiggingPlan (§V12 re-solve entry point)', () => {
  it('feeds setRope world positions and chord×slack lengths, then sets count', () => {
    // WHY: this is the exact call main.ts repeats when a mast moves; the
    // index↔plan-entry mapping and length formula must stay stable or
    // re-application scrambles the rig.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const calls: Array<{ index: number; length: number }> = [];
    let count = -1;
    const positions = new Map<string, [number, number, number]>();
    let n = 0;
    const socketWorldPosition = (id: string): [number, number, number] => {
      if (!positions.has(id)) positions.set(id, [n++, n * 2, -n]);
      return positions.get(id)!;
    };
    applyRiggingPlan(plan, {
      setRope(index, a, b, length) {
        const chord = Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
        expect(length).toBeCloseTo(chord * plan[index].slack, 10);
        calls.push({ index, length: length ?? NaN });
      },
      setRopeCount(c) {
        count = c;
      },
    }, socketWorldPosition);
    expect(calls.map((c) => c.index)).toEqual(plan.map((_, i) => i));
    expect(count).toBe(plan.length);
  });

  it('applyBlocks mirrors the same index/count contract for pulleys', () => {
    // WHY: blocks ride their sockets exactly like rope anchors; a drifting
    // index mapping would leave pulleys behind when the ship moves.
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const sockets = selectBlockSockets(plan, 20);
    const placed: number[] = [];
    let count = -1;
    applyBlocks(sockets, {
      setBlock(index, position) {
        expect(Number.isFinite(position.x)).toBe(true);
        placed.push(index);
      },
      setBlockCount(n) {
        count = n;
      },
    }, () => [1, 2, 3]);
    expect(placed).toEqual(sockets.map((_, i) => i));
    expect(count).toBe(sockets.length);
  });
});
