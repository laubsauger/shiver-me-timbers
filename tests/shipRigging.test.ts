/**
 * §V12/§V13 rigging plan tests. The plan is the contract between the ship
 * piece graph (socket ids) and the GPU rope solver (createRopes indices) —
 * if it references a socket that does not exist, or drifts between runs,
 * ropes attach to nothing after a ship-side rename. Pure data tests; no
 * three.js/WebGPU is imported at runtime (shipRigging uses type-only imports).
 */
import { describe, expect, it } from 'vitest';
import {
  applyRiggingPlan,
  buildRiggingPlan,
  collectRopeAnchorIds,
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

describe('validateRiggingPlan (fail loud on unknown sockets)', () => {
  it('throws when a plan references a socket id the blueprint lacks', () => {
    // WHY: the concurrent ship rework may rename sockets; silent mis-rig is
    // the §B bug class this guards against.
    const bogus: RiggingRope[] = [
      { socketA: 'anchor-masthead-fore', socketB: 'anchor-nope', slack: 1.1, thickness: 0.03 },
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
});
