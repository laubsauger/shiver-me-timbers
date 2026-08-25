/**
 * SCRATCH — §T.114 / §B74 diagnosis + before/after. Measures how far the §T85
 * cloth membrane penetrates its mast and its own yard, per ship, over a
 * brace × drive × aback × trim sweep, with the push-out ON and OFF.
 * Not a gate; the shipped properties live in tests/sailMastClearance.test.ts.
 */
import { describe, it } from 'vitest';
import * as THREE from 'three';
import type { Material } from 'three';
import { buildGalleonBlueprint, buildBrigantineBlueprint } from '../src/ship/shipBlueprint';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { shipMaterialParams } from '../src/params/ship';
import { sailClothPoint, type SailClothState } from '../src/ship/sailShape';
import {
  readSailSparSources,
  resolveSailSpars,
  sheetLeadDirections,
  type SailSparCapsule,
  type SailSpars,
} from '../src/ship/sailFrame';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = () => ({ dispose(): void {} }) as unknown as Material;

type V3 = [number, number, number];
const P = shipMaterialParams;

/** penetration depth (m) of a SAIL-LOCAL point into a capsule; ≤ 0 = clear */
function penetration(p: V3, c: SailSparCapsule): number {
  const ab = new THREE.Vector3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
  const len2 = ab.lengthSq();
  if (!(len2 > 1e-12)) return -Infinity;
  const ap = new THREE.Vector3(p[0] - c.a[0], p[1] - c.a[1], p[2] - c.a[2]);
  const t = Math.min(1, Math.max(0, ap.dot(ab) / len2));
  const axis = ab.clone().multiplyScalar(t);
  return c.ra + (c.rb - c.ra) * t - ap.distanceTo(axis);
}

const capsules = (s: SailSpars): SailSparCapsule[] => [s.mast, s.mast2, s.yard];

interface Probe {
  id: string;
  node: THREE.Object3D;
  mesh: THREE.Mesh;
  width: number;
  drop: number;
}

function probes(bp: PieceDef[], asm: ShipAssembly): Probe[] {
  const byId = new Map(bp.map((d) => [d.id, d]));
  return asm.sailPieceIds().map((id) => {
    const def = byId.get(id)!;
    return {
      id,
      node: asm.group.getObjectByName(id)!,
      mesh: asm.sailMesh(id),
      width: def.aabb.max[0] - def.aabb.min[0],
      drop: -def.aabb.min[1],
    };
  });
}

function sweep(name: string, bp: PieceDef[], on: boolean): void {
  const asm = new ShipAssembly(bp, stubFactory);
  const braces = [-47, -30, -15, 0, 15, 30, 47];
  const drives = [0, 0.25, 0.5, 0.75, 1];
  const drops = [1, 0.6, 0.25, 0.03];
  const N = 16;
  let worstMast = { d: -Infinity, at: '' };
  let worstYard = { d: -Infinity, at: '' };
  let insideM = 0;
  let insideY = 0;
  let total = 0;
  let moved = 0;
  let maxMove = 0;
  let worstVsCut = 0;
  for (const braceDeg of braces) {
    asm.setRigTrim((braceDeg * Math.PI) / 180);
    asm.group.updateMatrixWorld(true);
    for (const s of probes(bp, asm)) {
      const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
      const caps = capsules(spars);
      for (const driveMag of drives) {
        for (const aback of [false, true]) {
          for (const dropScale of drops) {
            for (const luff of [0, 1]) {
              const m = s.node.matrixWorld.elements;
              const leads = sheetLeadDirections(m, 0, 1, P.sailSheetSpread, 1);
              const base: SailClothState = {
                drive: aback ? -driveMag : driveMag,
                luff,
                skew: 0,
                dropScale,
                flutterPhase: 1.7,
                sheetLeadPort: leads.port,
                sheetLeadStarboard: leads.starboard,
              };
              const st = on ? { ...base, spars } : base;
              for (let i = 0; i <= N; i++) {
                for (let j = 0; j <= N; j++) {
                  const u = i / N;
                  const v = j / N;
                  const q = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
                  const q0 = sailClothPoint(u, v, s.width, s.drop, base, P) as V3;
                  const dmove = Math.hypot(q[0] - q0[0], q[1] - q0[1], q[2] - q0[2]);
                  if (dmove > 1e-9) moved++;
                  maxMove = Math.max(maxMove, dmove);
                  total++;
                  const tag = `${s.id} u=${u.toFixed(2)} v=${v.toFixed(2)} brace=${braceDeg} drive=${aback ? -driveMag : driveMag} drop=${dropScale} luff=${luff}`;
                  for (let k = 0; k < 2; k++) {
                    const pen = penetration(q, caps[k]);
                    if (pen > worstMast.d) worstMast = { d: pen, at: tag };
                    if (pen > 0) insideM++;
                  }
                  {
                    const flat: V3 = [(u - 0.5) * s.width, -(1 - v) * s.drop, 0];
                    for (let k = 0; k < 3; k++) {
                      const pen = penetration(q, caps[k]);
                      const cut = penetration(flat, caps[k]);
                      if (pen > cut + 1e-3 && pen > 0) worstVsCut = Math.max(worstVsCut, pen - Math.max(0, cut));
                    }
                  }
                  const py = penetration(q, caps[2]);
                  if (py > worstYard.d) worstYard = { d: py, at: tag };
                  if (py > 0) insideY++;
                }
              }
            }
          }
        }
      }
    }
  }
  console.log(`\n=== ${name} push=${on ? 'ON' : 'OFF'} === samples=${total}`);
  console.log(`  MAST worst penetration ${worstMast.d.toFixed(4)} m  inside=${insideM}  @ ${worstMast.at}`);
  console.log(`  YARD worst penetration ${worstYard.d.toFixed(4)} m  inside=${insideY}  @ ${worstYard.at}`);
  console.log(`  worst penetration BEYOND what the flat cut panel already has: ${worstVsCut.toFixed(4)} m`);
  console.log(`  samples moved by the push: ${moved} (${((100 * moved) / total).toFixed(3)}%), max move ${maxMove.toFixed(3)} m`);
}

const SHIPS = (): Array<[string, PieceDef[]]> => [
  ['galleon', buildGalleonBlueprint()],
  ['brigantine', buildBrigantineBlueprint()],
  ['raft', buildRaftBlueprint()],
];

describe('scratch: sail vs mast/yard penetration', () => {
  for (const [name, bp] of SHIPS()) {
    it(`${name} before`, () => { sweep(name, bp, false); });
    it(`${name} after`, () => { sweep(name, bp, true); });
  }
});

describe('scratch: which spars each sail got', () => {
  for (const [name, bp] of SHIPS()) {
    it(name, () => {
      const asm = new ShipAssembly(bp, stubFactory);
      asm.group.updateMatrixWorld(true);
      for (const s of probes(bp, asm)) {
        const src = readSailSparSources(s.mesh);
        const sp = resolveSailSpars(s.node, src);
        const show = (c: SailSparCapsule): string =>
          `A(${c.a.map((x) => x.toFixed(2)).join(',')})→B(${c.b.map((x) => x.toFixed(2)).join(',')}) r${c.ra.toFixed(3)}→${c.rb.toFixed(3)}`;
        console.log(`  ${s.id}: n=${src.length} ${src.map((x) => x.node.name).join(' + ')}`);
        console.log(`     mast  ${show(sp.mast)}`);
        console.log(`     mast2 ${show(sp.mast2)}`);
        console.log(`     yard  ${show(sp.yard)}`);
      }
    });
  }
});

/** §V67 arc length + local stretch + brace continuity, before vs after */
describe('scratch: smoothness and arc length', () => {
  for (const [name, bp] of SHIPS()) {
    it(name, () => {
      const asm = new ShipAssembly(bp, stubFactory);
      asm.setRigTrim(0);
      asm.group.updateMatrixWorld(true);
      const drives = [-1, -0.5, -0.25, 0, 0.5, 1];
      const stretchBy = new Map<number, number>();
      let worstStretch = { r: 0, at: '' };
      let worstBraceJump = { d: 0, at: '' };
      const arc: string[] = [];
      for (const s of probes(bp, asm)) {
        const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
        const leads = sheetLeadDirections(s.node.matrixWorld.elements, 0, 1, P.sailSheetSpread, 1);
        const mk = (drive: number, sp?: SailSpars): SailClothState => ({
          drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0,
          sheetLeadPort: leads.port, sheetLeadStarboard: leads.starboard, spars: sp,
        });
        const N = 64;
        for (const drive of drives) {
          const on = mk(drive, spars);
          const off = mk(drive);
          // local stretch: adjacent-sample spacing, pushed vs unpushed
          for (let j = 0; j <= N; j++) {
            for (let i = 0; i < N; i++) {
              const a1 = sailClothPoint(i / N, j / N, s.width, s.drop, on, P) as V3;
              const b1 = sailClothPoint((i + 1) / N, j / N, s.width, s.drop, on, P) as V3;
              const a0 = sailClothPoint(i / N, j / N, s.width, s.drop, off, P) as V3;
              const b0 = sailClothPoint((i + 1) / N, j / N, s.width, s.drop, off, P) as V3;
              const d1 = Math.hypot(b1[0] - a1[0], b1[1] - a1[1], b1[2] - a1[2]);
              const d0 = Math.hypot(b0[0] - a0[0], b0[1] - a0[1], b0[2] - a0[2]);
              const r = d1 / Math.max(1e-6, d0);
              if (r > worstStretch.r) worstStretch = { r, at: `${s.id} u=${(i / N).toFixed(2)} v=${(j / N).toFixed(2)} drive=${drive}` };
              stretchBy.set(drive, Math.max(stretchBy.get(drive) ?? 0, r));
            }
          }
          // arc length of the horizontal strip at the belly reference, and of
          // the centre vertical strip
          if (drive === 1 || drive === -1) {
            const len = (at: (t: number) => V3): number => {
              let L = 0; let prev = at(0);
              for (let k = 1; k <= 400; k++) {
                const q = at(k / 400);
                L += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
                prev = q;
              }
              return L;
            };
            const hOn = len((t) => sailClothPoint(t, 0.12, s.width, s.drop, on, P) as V3);
            const hOff = len((t) => sailClothPoint(t, 0.12, s.width, s.drop, off, P) as V3);
            const vOn = len((t) => sailClothPoint(0.5, t, s.width, s.drop, on, P) as V3);
            const vOff = len((t) => sailClothPoint(0.5, t, s.width, s.drop, off, P) as V3);
            arc.push(`${s.id} d=${drive}: horiz ${(hOff / s.width).toFixed(4)}→${(hOn / s.width).toFixed(4)} of cut, vert ${(vOff / s.drop).toFixed(4)}→${(vOn / s.drop).toFixed(4)}`);
          }
        }
      }
      // brace continuity: 0.05° steps through the whole range, biggest jump
      for (let k = 0; k <= 1880; k++) {
        const deg = -47 + k * 0.05;
        asm.setRigTrim((deg * Math.PI) / 180);
        asm.group.updateMatrixWorld(true);
        if (k === 0) continue;
        for (const s of probes(bp, asm)) {
          const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
          const st: SailClothState = {
            drive: -0.5, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0,
            sheetLeadPort: [0, 0, 0], sheetLeadStarboard: [0, 0, 0], spars,
          };
          for (const [u, v] of [[0.5, 0.2], [0.45, 0.5], [0.55, 0.8], [0.5, 0.5]]) {
            const q = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
            const key = `${name}${s.id}${u}${v}`;
            const prev = (globalThis as Record<string, unknown>)[key] as V3 | undefined;
            if (prev !== undefined) {
              const d = Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
              if (d > worstBraceJump.d) worstBraceJump = { d, at: `${s.id} u=${u} v=${v} brace=${deg.toFixed(2)}` };
            }
            (globalThis as Record<string, unknown>)[key] = q;
          }
        }
      }
      console.log(`\n### ${name}`);
      console.log(`  worst local stretch (pushed spacing / unpushed): ${worstStretch.r.toFixed(3)}× @ ${worstStretch.at}`);
      console.log(`  worst stretch by drive: ${[...stretchBy.entries()].sort((a, b) => a[0] - b[0]).map(([d, r]) => `${d}:${r.toFixed(2)}x`).join(' ')}`);
      console.log(`  worst position jump per 0.05° of brace: ${(worstBraceJump.d * 1000).toFixed(3)} mm @ ${worstBraceJump.at}`);
      for (const a of arc) console.log(`  ${a}`);
    });
  }
});

describe('scratch: where the big moves are', () => {
  it('raft', () => {
    const bp = buildRaftBlueprint();
    const asm = new ShipAssembly(bp, stubFactory);
    const worst = new Map<string, { d: number; at: string }>();
    for (const braceDeg of [-47, -30, -15, 0, 15, 30, 47]) {
      asm.setRigTrim((braceDeg * Math.PI) / 180);
      asm.group.updateMatrixWorld(true);
      for (const s of probes(bp, asm)) {
        const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
        for (const drive of [-1, -0.5, 0, 0.5, 1]) {
          const leads = sheetLeadDirections(s.node.matrixWorld.elements, 0, 1, P.sailSheetSpread, 1);
          const base: SailClothState = { drive, luff: 0, skew: 0, dropScale: 1, flutterPhase: 0, sheetLeadPort: leads.port, sheetLeadStarboard: leads.starboard };
          for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
            const u = i / 16; const v = j / 16;
            const a = sailClothPoint(u, v, s.width, s.drop, { ...base, spars }, P) as V3;
            const b = sailClothPoint(u, v, s.width, s.drop, base, P) as V3;
            const d = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
            const cur = worst.get(s.id);
            if (cur === undefined || d > cur.d) worst.set(s.id, { d, at: `u=${u.toFixed(2)} v=${v.toFixed(2)} brace=${braceDeg} drive=${drive}` });
          }
        }
      }
    }
    for (const [k, w] of worst) console.log(`  ${k}: max move ${w.d.toFixed(3)} m @ ${w.at}`);
  });
});
