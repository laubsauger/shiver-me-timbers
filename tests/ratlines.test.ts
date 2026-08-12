/**
 * §V45 ratlines. The ship system owns the ladders' INTENT (which shrouds, how
 * many rungs, where) and src/ropes owns turning that into geometry addressed
 * into its own rope-index space. This file guards the seam between them, which
 * is where a silent failure would live: a ladder whose shrouds cannot be found
 * simply produces no rungs, and nothing errors.
 */
import { describe, expect, it } from 'vitest';
import { buildRatlinePlan, validateRatlinePlan, MIN_RUNG } from '../src/ship/ratlinePlan';
import {
  buildRungDescriptors,
  packRungs,
  rungVisibility,
  sampleRopeByArcLength,
} from '../src/ropes/ratlines';
import { applyRiggingPlan, buildRiggingPlan } from '../src/ropes/shipRigging';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { solveCatenary, type Vec3Like } from '../src/ropes/catenaryMath';
import type { PieceDef } from '../src/ship/pieceTypes';
import type { Material } from 'three';
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

/**
 * User report: "the horizontal climbing bars — they seem to rotate and tilt in
 * a strange way when the rope is sagging in a very extreme way… pointing almost
 * completely vertical".
 *
 * Measured cause, which is NOT sag: `solveCatenary` samples uniformly in
 * HORIZONTAL SPAN, and a shroud is steep (galleon: v/h ≈ 6.8 : 1), so sample
 * index is violently non-uniform in height. Worse, HOW non-uniform depends on
 * each rope's own h — the two shrouds of one fan run h = 3.85 m and h = 3.21 m
 * — so the same t landed at y = 9.52 on one and y = 8.71 on the other and the
 * rung between them stood 45° off level. Adding slack made it BETTER, not
 * worse, and furl changed nothing at all (shrouds have zero furl response).
 */
describe('§V45 rungs are level: the ladder is a ladder, not a spike', () => {
  const stubMat = (): Material => ({ dispose(): void {} }) as unknown as Material;

  /** every rung of a ship, placed exactly as the vertex stage places it */
  function placedRungs(build: () => PieceDef[], furl: number) {
    const blueprint = build();
    const plan = buildRiggingPlan(blueprint);
    const assembly = new ShipAssembly(blueprint, stubMat);
    assembly.group.updateWorldMatrix(true, true);
    const solved: Vec3Like[][] = [];
    applyRiggingPlan(plan, {
      setRope(i, a, b, length): void {
        solved[i] = solveCatenary(a, b, length ?? 0, ropeParams.segmentsPerRope);
      },
      setRopeCount(): void {},
    }, (id) => assembly.socketWorldPosition(id), furl);
    return buildRungDescriptors(buildRatlinePlan(blueprint), plan).map((r) => {
      const pA = sampleRopeByArcLength(solved[r.ropeA], r.tA);
      const pB = sampleRopeByArcLength(solved[r.ropeB], r.tB);
      const span = Math.hypot(pB.x - pA.x, pB.y - pA.y, pB.z - pA.z);
      return {
        span,
        drawn: rungVisibility(span) > 0.5,
        tiltDeg: (Math.asin(Math.min(1, Math.abs(pB.y - pA.y) / Math.max(span, 1e-9))) * 180) / Math.PI,
      };
    });
  }

  it.each(ships)('%s: no rung stands on end, at any trim', (_n, build) => {
    // WHY: this is the user report, and it is the assertion the shipped
    // sample-index sampler fails at 45.3°. A ladder whose bars are cocked
    // tens of degrees does not read as something you could climb.
    for (const furl of [0, 1]) {
      const drawn = placedRungs(build, furl).filter((r) => r.drawn);
      expect(drawn.length).toBeGreaterThan(50);
      const worst = Math.max(...drawn.map((r) => r.tiltDeg));
      const mean = drawn.reduce((s, r) => s + r.tiltDeg, 0) / drawn.length;
      expect(worst, `furl=${furl} worst rung tilt`).toBeLessThan(12);
      expect(mean, `furl=${furl} mean rung tilt`).toBeLessThan(6);
    }
  });

  it('…but they are still not machined level (§V2 hand-seized)', () => {
    // WHY: the complement. The bound must clip the tail, never flatten the
    // ladder into the "ultra regular" tell the ship's jitter exists to remove
    // — a fix that made every rung exactly level would pass the test above and
    // still be wrong.
    const drawn = placedRungs(buildGalleonBlueprint, 0).filter((r) => r.drawn);
    expect(drawn.filter((r) => r.tiltDeg > 0.5).length).toBeGreaterThan(drawn.length / 4);
  });

  it('furl does not move the shrouds, so it cannot move the ladder', () => {
    // WHY: the report blamed furling. It provably is not: shrouds carry zero
    // furl response, so every rung is identical at both extremes. Pinned so a
    // future furl response on standing rigging cannot silently reintroduce
    // this — it would have to come past this test first.
    const set = placedRungs(buildGalleonBlueprint, 0);
    const furled = placedRungs(buildGalleonBlueprint, 1);
    expect(furled.map((r) => r.tiltDeg.toFixed(6))).toEqual(set.map((r) => r.tiltDeg.toFixed(6)));
  });

  it('places a station by ARC LENGTH, not by sample index', () => {
    // WHY: the root cause, pinned at the level of the sampler itself. On a
    // steep rope the two disagree wildly, and that disagreement is what tilted
    // the rungs. t = 0.5 must be the point equidistant ALONG THE ROPE from
    // both ends — the station a rung is physically seized at.
    const A = { x: 0, y: 28.6, z: 10 };
    const B = { x: -3.5, y: 2.57, z: 8.4 };
    const chord = Math.hypot(B.x - A.x, B.y - A.y, B.z - A.z);
    const pts = solveCatenary(A, B, chord * 1.004, ropeParams.segmentsPerRope);
    const mid = sampleRopeByArcLength(pts, 0.5);
    const arcTo = (p: Vec3Like, from: number, to: number): number => {
      let s = 0;
      for (let i = from; i < to; i++) {
        s += Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y, pts[i + 1].z - pts[i].z);
      }
      return s + 0 * p.x;
    };
    const total = arcTo(mid, 0, pts.length - 1);
    // walk from the masthead end to the sampled point and confirm it is half
    let acc = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const l = Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y, pts[i + 1].z - pts[i].z);
      const d = Math.hypot(mid.x - pts[i].x, mid.y - pts[i].y, mid.z - pts[i].z);
      if (d <= l + 1e-9) { acc += d; break; }
      acc += l;
    }
    expect(acc / total).toBeCloseTo(0.5, 3);
    // and it is emphatically NOT where the sample index says — that is the bug
    const byIndex = pts[Math.round(0.5 * (pts.length - 1))];
    expect(Math.abs(mid.y - byIndex.y)).toBeGreaterThan(3);
  });

  it('collapses rungs the fan has closed on, where the span is known', () => {
    // WHY: MIN_RUNG is applied by the ship to straight lines in ship space,
    // but the drawn rung is a chord of two solved curves. Now that rungs
    // actually reach the top of the fan, 40 of the galleon's 162 come out
    // under the cutoff — and a ladder tapering to a point reads as a spike.
    const all = placedRungs(buildGalleonBlueprint, 0);
    const stubs = all.filter((r) => r.span < MIN_RUNG);
    expect(stubs.length).toBeGreaterThan(0);
    for (const stub of stubs) expect(rungVisibility(stub.span)).toBeLessThan(1);
    for (const r of all) {
      if (r.span >= MIN_RUNG) expect(rungVisibility(r.span)).toBe(1);
    }
    // the cull is a fade, not a step: nothing can pop as §V42 works the fan
    expect(rungVisibility(MIN_RUNG * 0.9)).toBeGreaterThan(0);
    expect(rungVisibility(MIN_RUNG * 0.9)).toBeLessThan(1);
    expect(rungVisibility(MIN_RUNG * 0.5)).toBe(0);
  });
});
