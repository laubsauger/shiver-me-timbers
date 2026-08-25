/**
 * SCRATCH MEASUREMENT — §T.75 yard/shroud geometry. NOT AN INVARIANT TEST.
 * `RIG_RESEARCH=1 npx vitest run tests/zzScratchRigGeometry.test.ts`.
 *
 * WHAT IT REPORTS
 *   1. the shroud fan: where every chainplate lands, how far outboard of the
 *      shell, and how wide the fan still is at each yard's own height
 *   2. yard length against beam and against the fan at that height
 *   3. SURFACE-to-surface clearance (tube radii subtracted) between every
 *      yard and every shroud, swept over brace angle, both tacks — i.e. the
 *      angle at which the yards actually foul, which is what `braceMax`
 *      is supposed to be a consequence of
 */
import { describe, expect, it } from 'vitest';
import { buildGalleonBlueprint, buildBrigantineBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { buildRiggingPlan } from '../src/ropes/shipRigging';
import { solveCatenary } from '../src/ropes/catenaryMath';
import { galleonParams, brigantineParams } from '../src/params/ship';
import { asHullShape, hullHalfWidthAt, hullTopY, type HullShape } from '../src/ship/hullMath';
import { applyRiggingPlan } from '../src/ropes/shipRigging';
import type { Material } from 'three';
import type { PieceDef } from '../src/ship/pieceTypes';

const RUN = process.env.RIG_RESEARCH === '1';
const stubFactory = (): Material => ({ dispose(): void {} }) as unknown as Material;
type P = [number, number, number];

/** shortest distance between segment AB and segment CD */
function segSegDist(a: P, b: P, c: P, d: P): number {
  const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const v = [d[0] - c[0], d[1] - c[1], d[2] - c[2]];
  const w = [a[0] - c[0], a[1] - c[1], a[2] - c[2]];
  const dot = (p: number[], q: number[]): number => p[0] * q[0] + p[1] * q[1] + p[2] * q[2];
  const A = dot(u, u); const B = dot(u, v); const C = dot(v, v);
  const D = dot(u, w); const E = dot(v, w);
  const den = A * C - B * B;
  let s = 0; let t = 0;
  if (den > 1e-12) {
    s = Math.min(1, Math.max(0, (B * E - C * D) / den));
  }
  t = C > 1e-12 ? (B * s + E) / C : 0;
  t = Math.min(1, Math.max(0, t));
  s = A > 1e-12 ? Math.min(1, Math.max(0, (B * t - D) / A)) : 0;
  const p = [a[0] + u[0] * s, a[1] + u[1] * s, a[2] + u[2] * s];
  const q = [c[0] + v[0] * t, c[1] + v[1] * t, c[2] + v[2] * t];
  return Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
}

/** mirror of tests/shipRigging.test.ts's hull solid + penetration probe */
function hullSolid(blueprint: PieceDef[]): {
  shape: HullShape;
  decks: Array<{ topY: number; z0: number; z1: number }>;
} {
  const shape = asHullShape(blueprint.find((p) => p.kind === 'deck')?.shape)!;
  const raised = new Set(['forecastle-deck', 'sterncastle-deck', 'cabin']);
  const decks = blueprint
    .filter((p) => raised.has(p.kind) && p.parent === undefined)
    .map((p) => ({
      topY: p.transform.position[1] + p.aabb.max[1],
      z0: p.transform.position[2] + p.aabb.min[2],
      z1: p.transform.position[2] + p.aabb.max[2],
    }));
  return { shape, decks };
}

function penetration(p: P, solid: ReturnType<typeof hullSolid>): number {
  const [x, y, z] = p;
  const { shape, decks } = solid;
  if (z > shape.bowZ || z < shape.sternZ || y < -shape.draft) return -1;
  let top = hullTopY(z, shape);
  for (const deck of decks) if (z >= deck.z0 && z <= deck.z1) top = Math.max(top, deck.topY);
  if (y > top) return -1;
  return hullHalfWidthAt(z, y, shape) - Math.abs(x);
}

interface Resolved { rope: { role: string; socketA: unknown; socketB: unknown }; a: P; b: P; length: number }

function resolvePlan(blueprint: PieceDef[], brace: number): Resolved[] {
  const plan = buildRiggingPlan(blueprint);
  const asm = new ShipAssembly(blueprint, stubFactory);
  asm.setRigTrim(brace);
  asm.group.updateWorldMatrix(true, true);
  const out: Resolved[] = [];
  applyRiggingPlan(plan, {
    setRope(index, a, b, length): void {
      out[index] = {
        rope: plan[index],
        a: [a.x, a.y, a.z],
        b: [b.x, b.y, b.z],
        length: length ?? 0,
      };
    },
    setRopeCount(): void {},
  }, (id) => asm.socketWorldPosition(id));
  return out;
}

interface Shroud { id: string; pts: P[]; radius: number }
interface Yard { id: string; a: P; b: P; radius: number }

function shrouds(blueprint: PieceDef[], asm: ShipAssembly): Shroud[] {
  const plan = buildRiggingPlan(blueprint);
  const out: Shroud[] = [];
  for (const rope of plan) {
    if (rope.role !== 'shroud') continue;
    const a = asm.socketWorldPosition(rope.socketA as string);
    const b = asm.socketWorldPosition(rope.socketB as string);
    const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2]);
    const curve = solveCatenary(
      { x: a[0], y: a[1], z: a[2] },
      { x: b[0], y: b[1], z: b[2] },
      chord * rope.slack,
      24,
    );
    out.push({
      id: `${rope.socketA}→${rope.socketB}`,
      pts: curve.map((p) => [p.x, p.y, p.z] as P),
      radius: rope.thickness,
    });
  }
  return out;
}

function yards(blueprint: PieceDef[], asm: ShipAssembly): Yard[] {
  const out: Yard[] = [];
  for (const piece of blueprint) {
    if (piece.kind !== 'yard') continue;
    out.push({
      id: piece.id,
      a: asm.socketWorldPosition(`anchor-${piece.id}-port`) as P,
      b: asm.socketWorldPosition(`anchor-${piece.id}-starboard`) as P,
      radius: piece.aabb.max[1],
    });
  }
  return out;
}

/** worst (smallest) surface-to-surface clearance, yard vs shroud, at one brace */
function worstClearance(
  blueprint: PieceDef[],
  asm: ShipAssembly,
  brace: number,
): { gap: number; yard: string; shroud: string } {
  asm.setRigTrim(brace);
  asm.group.updateWorldMatrix(true, true);
  const ss = shrouds(blueprint, asm);
  const ys = yards(blueprint, asm);
  let best = Infinity; let yard = ''; let shroud = '';
  for (const y of ys) {
    for (const s of ss) {
      for (let i = 0; i + 1 < s.pts.length; i++) {
        const d = segSegDist(y.a, y.b, s.pts[i], s.pts[i + 1]) - y.radius - s.radius;
        if (d < best) { best = d; yard = y.id; shroud = s.id; }
      }
    }
  }
  return { gap: best, yard, shroud };
}

describe.skipIf(!RUN)('§T.75 rig geometry measurement', () => {
  it('reports the shroud fan, the yard lengths, and the brace sweep', () => {
    for (const [name, build, p] of [
      ['galleon', buildGalleonBlueprint, galleonParams],
      ['brigantine', buildBrigantineBlueprint, brigantineParams],
    ] as const) {
      const blueprint = build();
      const asm = new ShipAssembly(blueprint, stubFactory);
      asm.setRigTrim(0);
      asm.group.updateWorldMatrix(true, true);
      const shape = asHullShape(blueprint.find((q) => q.kind === 'deck')?.shape)!;

      console.log(`\n===== ${name} (beam ${p.beam} m, half ${p.beam / 2} m) =====`);

      // --- chainplates -----------------------------------------------------
      console.log('-- chainplates (starboard) --');
      const plates = new Map<string, P[]>();
      for (const piece of blueprint) {
        for (const s of piece.sockets) {
          const m = /^anchor-channel-starboard-(\w+)-(\d+)$/.exec(s.id);
          if (m === null) continue;
          const w = asm.socketWorldPosition(s.id) as P;
          const list = plates.get(m[1]) ?? [];
          list.push(w);
          plates.set(m[1], list);
          const shell = hullHalfWidthAt(w[2], w[1], shape);
          console.log(
            `   ${s.id}  x=${w[0].toFixed(2)} y=${w[1].toFixed(2)} z=${w[2].toFixed(2)}` +
            `  shell=${shell.toFixed(2)}  proud=${(w[0] - shell).toFixed(3)} m` +
            `  x/halfBeam=${(w[0] / (p.beam / 2)).toFixed(2)}`,
          );
        }
      }

      // --- yards -----------------------------------------------------------
      console.log('-- yards --');
      const ys = yards(blueprint, asm);
      for (const y of ys) {
        const len = Math.hypot(y.b[0] - y.a[0], y.b[1] - y.a[1], y.b[2] - y.a[2]);
        console.log(
          `   ${y.id}  len=${len.toFixed(2)} m  half=${(len / 2).toFixed(2)}` +
          `  len/beam=${(len / p.beam).toFixed(2)}  y=${y.a[1].toFixed(2)}  r=${y.radius.toFixed(3)}`,
        );
      }

      // --- fan width at each yard height -----------------------------------
      console.log('-- shroud lateral offset at each yard height (starboard) --');
      const ss = shrouds(blueprint, asm);
      for (const y of ys) {
        const h = y.a[1];
        const row: string[] = [];
        for (const s of ss) {
          if (!s.id.includes('starboard')) continue;
          // interpolate the shroud polyline at height h
          for (let i = 0; i + 1 < s.pts.length; i++) {
            const p0 = s.pts[i]; const p1 = s.pts[i + 1];
            if ((p0[1] - h) * (p1[1] - h) > 0) continue;
            const t = (h - p0[1]) / (p1[1] - p0[1] || 1e-9);
            const x = p0[0] + (p1[0] - p0[0]) * t;
            const z = p0[2] + (p1[2] - p0[2]) * t;
            row.push(`${s.id.split('→')[1].replace('anchor-channel-starboard-', '')}:x=${x.toFixed(2)},z=${z.toFixed(2)}`);
            break;
          }
        }
        console.log(`   ${y.id} (y=${h.toFixed(1)}): ${row.join('  ')}`);
      }

      // --- brace sweep ------------------------------------------------------
      console.log('-- surface-to-surface clearance, yard vs shroud, by brace --');
      for (let deg = 0; deg <= 90; deg += 5) {
        const stbd = worstClearance(blueprint, asm, (deg * Math.PI) / 180);
        const port = worstClearance(blueprint, asm, (-deg * Math.PI) / 180);
        const w = stbd.gap <= port.gap ? stbd : port;
        console.log(
          `   ${String(deg).padStart(3)}°  worst=${w.gap.toFixed(3)} m` +
          `  (+${stbd.gap.toFixed(3)} / -${port.gap.toFixed(3)})  ${w.yard} vs ${w.shroud}`,
        );
      }
      asm.setRigTrim(0);
    }
    expect(true).toBe(true);
  });

  it('reports the CLOTH corners against the shrouds (§V.71, live sail shape)', () => {
    // NOT asserted anywhere — the property tests guard the SPARS. A course
    // braced up really does press on the lee shrouds on a real ship, so this
    // is reported rather than pinned; what it must not do is go grossly
    // through, which is what a big negative here would mean.
    const blueprint = buildGalleonBlueprint();
    const asm = new ShipAssembly(blueprint, stubFactory);
    console.log('\n===== galleon: worst sail-anchor→shroud distance (m) =====');
    for (let deg = 0; deg <= 50; deg += 10) {
      asm.setRigTrim((deg * Math.PI) / 180);
      asm.group.updateWorldMatrix(true, true);
      const ss = shrouds(blueprint, asm);
      let best = Infinity; let who = '';
      for (const piece of blueprint) {
        if (piece.kind !== 'sail') continue;
        for (const socket of piece.sockets) {
          const p = asm.socketWorldPosition(socket.id) as P;
          for (const s of ss) {
            for (let i = 0; i + 1 < s.pts.length; i++) {
              const d = segSegDist(p, p, s.pts[i], s.pts[i + 1]) - s.radius;
              if (d < best) { best = d; who = `${socket.id} vs ${s.id}`; }
            }
          }
        }
      }
      console.log(`   ${String(deg).padStart(3)}°  ${best.toFixed(3)}  ${who}`);
    }
    asm.setRigTrim(0);
    expect(true).toBe(true);
  });

  it('reports rope-vs-hull penetration across the brace range', () => {
    // the OTHER half of §T.75: braces and sheets swing with the yards, and the
    // galleon sheet that has been red all session enters the hull at 0.61 rad.
    for (const [name, build] of [
      ['galleon', buildGalleonBlueprint],
      ['brigantine', buildBrigantineBlueprint],
    ] as const) {
      const blueprint = build();
      const solid = hullSolid(blueprint);
      console.log(`\n===== ${name}: worst rope penetration (m, ≤0 = clear) =====`);
      for (let deg = 0; deg <= 60; deg += 5) {
        const row: string[] = [];
        for (const sgn of [1, -1]) {
          let worst = -Infinity; let who = '';
          for (const { rope, a, b, length } of resolvePlan(blueprint, (sgn * deg * Math.PI) / 180)) {
            for (const pt of solveCatenary(
              { x: a[0], y: a[1], z: a[2] },
              { x: b[0], y: b[1], z: b[2] },
              length,
              24,
            )) {
              const d = penetration([pt.x, pt.y, pt.z], solid);
              if (d > worst) { worst = d; who = `${rope.role} ${rope.socketA}→${rope.socketB}`; }
            }
          }
          row.push(`${worst.toFixed(4)} ${who}`);
        }
        console.log(`   ${String(deg).padStart(3)}°  +${row[0]}\n         -${row[1]}`);
      }
    }
    expect(true).toBe(true);
  });

  it('what-if: hounds height and channel projection vs the brace stop', () => {
    // Synthesise the shroud as hounds→plate (the real square-rig geometry:
    // lower shrouds are set up to the LOWER masthead, not the truck) and sweep
    // both knobs. Nothing in src/ is touched — this is the design search.
    for (const [name, build, p] of [
      ['galleon', buildGalleonBlueprint, galleonParams],
      ['brigantine', buildBrigantineBlueprint, brigantineParams],
    ] as const) {
      const blueprint = build();
      const asm = new ShipAssembly(blueprint, stubFactory);
      const shape = asHullShape(blueprint.find((q) => q.kind === 'deck')?.shape)!;
      const masts = blueprint.filter((q) => q.kind === 'mast');

      const synth = (houndsFrac: number, proj: number): Shroud[] => {
        const out: Shroud[] = [];
        for (const mast of masts) {
          const m = mast.id.replace(/^mast-/, '');
          const H = mast.aabb.max[1];
          const head: P = [
            mast.transform.position[0],
            mast.transform.position[1] + H * houndsFrac,
            mast.transform.position[2],
          ];
          for (const piece of blueprint) {
            for (const s of piece.sockets) {
              const mm = new RegExp(`^anchor-channel-(port|starboard)-${m}-(\\d+)$`).exec(s.id);
              if (mm === null) continue;
              const w = asm.socketWorldPosition(s.id) as P;
              const sign = Math.sign(w[0]);
              const shell = hullHalfWidthAt(w[2], w[1], shape);
              const foot: P = [sign * (shell + proj), w[1], w[2]];
              const chord = Math.hypot(...head.map((v, k) => v - foot[k]));
              const curve = solveCatenary(
                { x: head[0], y: head[1], z: head[2] },
                { x: foot[0], y: foot[1], z: foot[2] },
                chord * 1.004,
                24,
              );
              out.push({ id: s.id, pts: curve.map((q) => [q.x, q.y, q.z] as P), radius: 0.04 });
            }
          }
        }
        return out;
      };

      const stopAngle = (ss: Shroud[], margin: number): number => {
        // first brace (deg, 0.5° steps) at which worst clearance < margin
        for (let deg = 0; deg <= 90; deg += 0.5) {
          for (const sgn of [1, -1]) {
            asm.setRigTrim((sgn * deg * Math.PI) / 180);
            asm.group.updateWorldMatrix(true, true);
            for (const y of yards(blueprint, asm)) {
              for (const s of ss) {
                for (let i = 0; i + 1 < s.pts.length; i++) {
                  const d = segSegDist(y.a, y.b, s.pts[i], s.pts[i + 1]) - y.radius - s.radius;
                  if (d < margin) return deg;
                }
              }
            }
          }
        }
        return 90;
      };

      console.log(`\n===== ${name}: brace stop (deg) at surface margin 0.10 m =====`);
      console.log('   houndsFrac \\ projection   0.06      0.26      0.45');
      for (const hf of [1.0, 0.70, 0.66, 0.62, 0.58, 0.56, 0.54, 0.52]) {
        const row = [0.06, 0.26, 0.45].map((proj) =>
          stopAngle(synth(hf, proj), 0.1).toFixed(1).padStart(6));
        console.log(`   ${hf.toFixed(2)}                    ${row.join('    ')}`);
      }
      console.log(`   (lower yard at frac ${p.yardLowerFrac}, upper ${p.yardUpperFrac})`);
      asm.setRigTrim(0);
    }
    expect(true).toBe(true);
  });
});
