/**
 * §V45 ratlines. The ship system owns the ladders' INTENT (which shrouds, how
 * many rungs, where) and src/ropes owns turning that into geometry addressed
 * into its own rope-index space. This file guards the seam between them, which
 * is where a silent failure would live: a ladder whose shrouds cannot be found
 * simply produces no rungs, and nothing errors.
 */
import { describe, expect, it } from 'vitest';
import { buildRatlinePlan, validateRatlinePlan, MIN_RUNG } from '../src/ship/ratlinePlan';
import { buildRungDescriptors, packRungs } from '../src/ropes/ratlines';
import { buildRiggingPlan } from '../src/ropes/shipRigging';
import {
  buildBrigantineBlueprint,
  buildGalleonBlueprint,
} from '../src/ship/shipBlueprint';
import { projectedWidthPx, farness, type PhoneWireParams } from '../src/ropes/phoneWireAA';
import { ropeParams } from '../src/params/ropes';

const ships = [
  ['galleon', buildGalleonBlueprint],
  ['brigantine', buildBrigantineBlueprint],
] as const;

describe('§V45 ratline plan → rung descriptors', () => {
  it.each(ships)('%s: EVERY ladder the ship declares becomes rungs', (_n, build) => {
    // WHY: this is the tripwire the module deliberately does not throw for.
    // A ladder whose shrouds are missing from the rigging plan is dropped
    // silently — which is correct when a mast legitimately has no shrouds, and
    // a bug in every other case. Asserting the shipped blueprints lose NOTHING
    // is what makes the silence safe.
    const blueprint = build();
    const ladders = buildRatlinePlan(blueprint);
    const plan = buildRiggingPlan(blueprint);
    expect(ladders.length).toBeGreaterThan(0);
    const declared = ladders.reduce((sum, l) => sum + l.rungs.length, 0);
    expect(buildRungDescriptors(ladders, plan)).toHaveLength(declared);
  });

  it('galleon ladders climb all three masts, both sides', () => {
    // WHY: the mizzen is the mast whose shrouds were dropped entirely until
    // its chainplates were lifted onto the quarterdeck. If that ever regresses
    // its shrouds vanish, and with them its ladders — this catches the second
    // effect even if the first slipped through.
    const ladders = buildRatlinePlan(buildGalleonBlueprint());
    expect(ladders.map((l) => l.id).sort()).toEqual([
      'ratlines-port-fore',
      'ratlines-port-main',
      'ratlines-port-rear',
      'ratlines-starboard-fore',
      'ratlines-starboard-main',
      'ratlines-starboard-rear',
    ]);
  });

  it('a rung spans the WHOLE fan, not adjacent pairs', () => {
    // WHY: a ratline is one line seized across every shroud in the fan. Read
    // as a ladder per adjacent pair it would need ~440 rungs on the galleon
    // instead of 162 — nearly three times the geometry for a look that is
    // wrong anyway, because the rungs would stop short of the outer shroud.
    const blueprint = buildGalleonBlueprint();
    const plan = buildRiggingPlan(blueprint);
    const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), plan);
    expect(rungs.length).toBeLessThan(200);
    for (const rung of rungs) {
      expect(rung.ropeA).not.toBe(rung.ropeB);
      // both ends are shrouds of the SAME mast — a rung that spanned two masts
      // would be a line across the deck, not a ladder
      expect(plan[rung.ropeA].role).toBe('shroud');
      expect(plan[rung.ropeB].role).toBe('shroud');
      expect(plan[rung.ropeA].socketA).toBe(plan[rung.ropeB].socketA);
    }
  });

  it('stations stay inside the shrouds and the ladder never inverts', () => {
    // WHY: t addresses into the solved points buffer. Out of range would read
    // a neighbouring rope's samples and draw a rung across open air to another
    // mast — a spectacular failure that no type catches.
    for (const [, build] of ships) {
      const blueprint = build();
      const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), buildRiggingPlan(blueprint));
      for (const rung of rungs) {
        for (const t of [rung.tA, rung.tB]) {
          expect(Number.isFinite(t)).toBe(true);
          expect(t).toBeGreaterThanOrEqual(0);
          expect(t).toBeLessThanOrEqual(1);
        }
        expect(rung.radius).toBeGreaterThan(0);
        expect(rung.sag).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it('rungs are not perfectly level — hand-seized, not machined', () => {
    // WHY: the ship system jitters tA against tB on purpose; a perfectly level
    // ladder is the "ultra regular" tell the detail pass exists to remove. If
    // the descriptor builder ever clamped them together the jitter would be
    // silently thrown away on this side of the boundary.
    const blueprint = buildGalleonBlueprint();
    const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), buildRiggingPlan(blueprint));
    expect(rungs.some((r) => Math.abs(r.tA - r.tB) > 1e-6)).toBe(true);
  });

  it('is deterministic and validates against the blueprint (§V2)', () => {
    const blueprint = buildGalleonBlueprint();
    const ladders = buildRatlinePlan(blueprint);
    expect(() => validateRatlinePlan(ladders, blueprint)).not.toThrow();
    const plan = buildRiggingPlan(blueprint);
    expect(buildRungDescriptors(ladders, plan)).toEqual(buildRungDescriptors(ladders, plan));
  });

  it('drops a ladder whose shrouds are not rigged, rather than mis-indexing', () => {
    // WHY: the failure mode that must NOT happen is a rung addressed at a rope
    // index that means something else. Handed an empty rigging plan there is
    // nothing to point at, and the answer has to be no rungs — never index 0.
    const blueprint = buildGalleonBlueprint();
    expect(buildRungDescriptors(buildRatlinePlan(blueprint), [])).toHaveLength(0);
  });

  it('packs into the two vec4 lanes the mesh reads', () => {
    // WHY: the pack order IS the shader's contract; a transposed lane would
    // put a rope index where a radius belongs and draw nothing, or everything.
    const blueprint = buildGalleonBlueprint();
    const rungs = buildRungDescriptors(buildRatlinePlan(blueprint), buildRiggingPlan(blueprint));
    const a = new Float32Array(rungs.length * 4);
    const b = new Float32Array(rungs.length * 4);
    packRungs(rungs, a, b);
    expect(a[0]).toBe(rungs[0].ropeA);
    expect(a[1]).toBe(rungs[0].ropeB);
    expect(a[2]).toBeCloseTo(rungs[0].tA, 6);
    expect(a[3]).toBeCloseTo(rungs[0].tB, 6);
    expect(b[0]).toBeCloseTo(rungs[0].sag, 6);
    expect(b[1]).toBeCloseTo(rungs[0].radius, 6);
  });
});

describe('§V45 × §V41: ratlines are the hardest case the AA has', () => {
  it('go sub-pixel well inside the demo, so they MUST use phone-wire AA', () => {
    // WHY: at 0.022 m a rung is thinner than any rope in the rig, and there
    // are 162 of them. Without the width clamp they would be the first thing
    // to break up into crawling dashes as the ship pulls away — which is
    // exactly the artefact §V41 exists to remove, and the reason ratlines had
    // to route through the rope renderer rather than being their own meshes.
    const P: PhoneWireParams = {
      minWidthPx: ropeParams.aaMinWidthPx,
      farWidthPx: ropeParams.farWidthPx,
      nearWidthPx: ropeParams.nearWidthPx,
    };
    const fov = (60 * Math.PI) / 180;
    const radius = 0.022;
    expect(projectedWidthPx(radius, 100, 1080, fov)).toBeLessThan(0.5);
    // fully on the cheap unlit path by ~55 m, which is barely past the ship
    expect(farness(projectedWidthPx(radius, 55, 1080, fov), P)).toBeCloseTo(1, 3);
    // …and still shaded at the follow camera, where the ladder is a feature
    expect(farness(projectedWidthPx(radius, 12, 1080, fov), P)).toBeLessThan(0.5);
  });

  it('the ship-side MIN_RUNG cutoff is what stops the ladder ending in stubs', () => {
    // WHY: the fan converges on the masthead, so rung spans shrink to nothing.
    // The ship agent flagged that MIN_RUNG, not topFrac, is the load-bearing
    // rule. This pins that the rung count actually respects it — every ladder
    // stops short of the top rather than running to topFrac regardless.
    const ladders = buildRatlinePlan(buildGalleonBlueprint());
    expect(MIN_RUNG).toBeGreaterThan(0.3);
    for (const ladder of ladders) {
      const highest = Math.max(...ladder.rungs.map((r) => Math.max(r.tA, r.tB)));
      expect(highest, ladder.id).toBeLessThan(0.95);
    }
  });
});
