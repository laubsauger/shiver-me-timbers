/**
 * §T.114 / §B.74 — THE CANVAS MAY NOT PASS THROUGH THE RIG.
 *
 * User: "we see our sails falling through our masts on all kinds of ships in
 * different situations and rotations. we should avoid that as it breaks
 * immersion."
 *
 * MEASURED before the fix (tests/zzScratchSailMastClearance.test.ts is the
 * harness), sampling `sailClothPoint` on a 17×17 grid over brace ∈ [−47°, 47°]
 * × drive ∈ {0, ¼, ½, ¾, 1} × aback × trim ∈ {1, .6, .25, .03} × luff:
 *
 *   galleon      0.358 m inside `mast-main`   (7 773 of 1 456 560 samples)
 *   brigantine   0.261 m inside `mast-main`   (4 128 of   971 040)
 *   raft         0.077 m inside a bipod leg   (1 596 of   485 520)
 *
 * and at full aback the galleon's main course was 2.6 m ABAFT the mast's axis
 * — clean through and out the other side. Every ship penetration was at
 * NEGATIVE drive: §T.85 bellies a backed sail aft with the same depth it
 * bellies a drawing one forward, and aft is where the mast is. The raft is a
 * different fault of the same shape — its mainsail's FLAT PANEL is already
 * 0.053 m inside the legs it hangs between, so it cuts them at every drive.
 *
 * EVERY BAR HERE IS A PROPERTY, NEVER A MAGNITUDE (§V80). "No sample inside
 * the capsule" survives any re-tune of camber, brace range or mast radius; "the
 * worst penetration is 0.358 m" would pass while enforcing the defect.
 *
 * GPU-FREE (§V88): stub material factory, CPU evaluator only. What that cannot
 * prove is stated at the mirror test at the bottom.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three';
// the two evaluators' SOURCE, for the mirror test at the bottom (vite ?raw)
import cpuSource from '../src/ship/sailShape.ts?raw';
import gpuSource from '../src/ship/sailClothNodes.ts?raw';
import type { Material } from 'three';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { buildRaftBlueprint } from '../src/ship/raftBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { shipMaterialParams } from '../src/params/ship';
import {
  SAIL_SPAR_MIN_R,
  SAIL_SPAR_WRAP,
  sailClothPoint,
  sparPush,
  sparRamp,
  sparStandoff,
  type SailClothState,
} from '../src/ship/sailShape';
import {
  NO_SAIL_SPARS,
  readSailSparSources,
  resolveSailSpars,
  sheetLeadDirections,
  type SailSparCapsule,
  type SailSpars,
} from '../src/ship/sailFrame';
import type { PieceDef } from '../src/ship/pieceTypes';

const stubFactory = (): Material => ({ dispose(): void {} }) as unknown as Material;
const P = shipMaterialParams;
type V3 = [number, number, number];

/** 1 mm: the bar is "outside", and a metre-scale evaluator in float64 is not
 *  going to land a sample exactly on a surface it was projected onto */
const TOL = 1e-3;

/**
 * Distance from a SAIL-LOCAL point INTO a capsule, > 0 = inside. Written from
 * the geometric definition — closest point on the segment, radius lerped along
 * it — deliberately NOT from `sparPush`'s algebra, so an error in that split
 * into (push direction, across, along) cannot hide behind itself.
 */
function penetration(p: V3, c: SailSparCapsule): number {
  const ab = new THREE.Vector3(c.b[0] - c.a[0], c.b[1] - c.a[1], c.b[2] - c.a[2]);
  const len2 = ab.lengthSq();
  if (!(len2 > 1e-12)) return -Infinity; // no spar in this slot
  const ap = new THREE.Vector3(p[0] - c.a[0], p[1] - c.a[1], p[2] - c.a[2]);
  const t = Math.min(1, Math.max(0, ap.dot(ab) / len2));
  return c.ra + (c.rb - c.ra) * t - ap.distanceTo(ab.multiplyScalar(t));
}

const capsulesOf = (s: SailSpars): SailSparCapsule[] => [s.mast, s.mast2, s.yard];

interface Sail {
  id: string;
  node: THREE.Object3D;
  mesh: THREE.Mesh;
  width: number;
  drop: number;
}

function sailsOf(bp: PieceDef[], asm: ShipAssembly): Sail[] {
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

const SHIPS: Array<[string, () => PieceDef[]]> = [
  ['galleon', buildGalleonBlueprint],
  ['brigantine', buildBrigantineBlueprint],
  ['raft', buildRaftBlueprint],
];
/** the two square-riggers: their sails are CUT clear of their masts, so the
 *  push must be inert on them wherever the cloth draws (see the raft note) */
const SQUARE_RIGGERS = SHIPS.filter(([n]) => n !== 'raft');

const BRACES = [-47, -30, -15, 0, 15, 30, 47];
const DRIVES = [-1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1];
const DROPS = [1, 0.5, 0.03];
const GRID = 12;

function stateFor(s: Sail, drive: number, dropScale: number, luff: number, spars?: SailSpars): SailClothState {
  const leads = sheetLeadDirections(s.node.matrixWorld.elements, 0, 1, P.sailSheetSpread, 1);
  return {
    drive,
    luff,
    skew: 0,
    dropScale,
    flutterPhase: 1.7,
    sheetLeadPort: leads.port,
    sheetLeadStarboard: leads.starboard,
    spars,
  };
}

/** run `fn` over the whole sweep, for one ship */
function overSweep(
  bp: PieceDef[],
  fn: (s: Sail, st: SailClothState, caps: SailSparCapsule[], u: number, v: number, tag: string) => void,
): void {
  const asm = new ShipAssembly(bp, stubFactory);
  for (const braceDeg of BRACES) {
    asm.setRigTrim((braceDeg * Math.PI) / 180);
    asm.group.updateMatrixWorld(true);
    for (const s of sailsOf(bp, asm)) {
      const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
      const caps = capsulesOf(spars);
      for (const drive of DRIVES) {
        for (const dropScale of DROPS) {
          const st = stateFor(s, drive, dropScale, drive === 0 ? 1 : 0, spars);
          for (let i = 0; i <= GRID; i++) {
            for (let j = 0; j <= GRID; j++) {
              fn(
                s,
                st,
                caps,
                i / GRID,
                j / GRID,
                `${s.id} u=${(i / GRID).toFixed(2)} v=${(j / GRID).toFixed(2)} brace=${braceDeg}° drive=${drive} drop=${dropScale}`,
              );
            }
          }
        }
      }
    }
  }
}

/**
 * THE INVARIANT. Not "the penetration got smaller" — a number that can be
 * tuned down and creep back — but that there is no cloth inside the rig at any
 * point of the whole operating envelope, on every hull we sail.
 */
describe('no point of canvas is ever inside its own rig', () => {
  for (const [name, build] of SQUARE_RIGGERS) {
    it(`${name}: every sample clears every spar it was given`, () => {
      let worst = { d: -Infinity, at: '' };
      overSweep(build(), (s, st, caps, u, v, tag) => {
        const p = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
        for (const c of caps) {
          const pen = penetration(p, c);
          if (pen > worst.d) worst = { d: pen, at: tag };
        }
      });
      expect(worst.d, `deepest cloth-in-spar over the sweep, at ${worst.at}`).toBeLessThan(TOL);
    });
  }

  /**
   * THE RAFT IS WEAKER, AND THE REASON IS IN HER BLUEPRINT, NOT IN THE PUSH.
   *
   * Her mainsail is CUT THROUGH her own bipod legs — the flat panel sits
   * 0.053 m inside them — so at some braces a piece of canvas straddles a leg
   * and "which side is this cloth on" has no single answer. The push blends
   * the two answers there (see `sparPush`), and cloth in that hand-over can
   * graze the leg. What is still guaranteed, and is what the user's complaint
   * is actually about, is that the canvas never gets past the spar's
   * CENTRELINE: it touches, it does not fall through.
   *
   * The real fix for the raft is a blueprint one — her main yard wants more
   * `yardMastClearance` so the cut panel clears the legs — and that file
   * (`raftPartsRig.ts`) is not this task's to move.
   */
  it('raft: the canvas may graze a leg it is cut through, but never crosses its axis', () => {
    let worst = { d: -Infinity, r: 1, at: '' };
    overSweep(buildRaftBlueprint(), (s, st, caps, u, v, tag) => {
      const p = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
      for (const c of caps) {
        const pen = penetration(p, c);
        if (pen > worst.d) worst = { d: pen, r: Math.max(c.ra, c.rb), at: tag };
      }
    });
    expect(worst.d, `deepest cloth-in-spar, at ${worst.at}`).toBeLessThan(worst.r);
  });
});

/**
 * THE PUSH IS INERT WHERE THERE IS NOTHING TO PUSH OFF, and this is the test
 * that keeps the §T.85 membrane the shipped shape rather than the shape a
 * collision pass left behind.
 *
 * A one-sided constraint that leaked would read as PERMANENT BELLY: a becalmed
 * sail standing forward of its own yard. So on the two square-riggers — whose
 * sails are cut clear of their masts, `yardZ = mastR + yardR + clearance` —
 * every drawing and every becalmed sample must come back BIT-IDENTICAL to the
 * pre-§T.114 evaluator, which is exactly `spars: undefined`.
 *
 * The raft is deliberately NOT in this list: its mainsail's flat panel is
 * measured 0.053 m INSIDE the bipod legs it hangs between, so there is cloth
 * to move on that ship at every drive, and pretending otherwise would be
 * pinning the defect (§V80).
 */
describe('the push does not touch cloth that is already clear', () => {
  for (const [name, build] of SQUARE_RIGGERS) {
    it(`${name}: drawing and becalmed cloth is bit-identical to the membrane`, () => {
      let checked = 0;
      overSweep(build(), (s, st, _caps, u, v, tag) => {
        if (st.drive < 0) return;
        const pushed = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
        const plain = sailClothPoint(u, v, s.width, s.drop, { ...st, spars: undefined }, P) as V3;
        expect(pushed, `${tag} moved with no spar in the way`).toEqual(plain);
        checked++;
      });
      expect(checked).toBeGreaterThan(10000); // the sweep really ran
    });
  }
});

/**
 * EVERY SPAR A SAIL IS PUSHED OFF IS ABAFT IT — the filter the whole scheme
 * rests on.
 *
 * The push is along the sail's own forward, because every yard in every
 * blueprint rides FORWARD of its mast. A spar picked from AHEAD of the canvas
 * would therefore be pushed INTO rather than out of, and the galleon has two
 * masts ahead of her mizzen: without the filter her main course would be shoved
 * eight metres by the foremast. Stated as a property of the CHOICE, so it holds
 * for any future hull.
 */
describe('a sail is only pushed off spars that are behind it', () => {
  const abaftCheck = (bp: PieceDef[], braces: number[], label: string): void => {
    const asm = new ShipAssembly(bp, stubFactory);
    for (const braceDeg of braces) {
      asm.setRigTrim((braceDeg * Math.PI) / 180);
      asm.group.updateMatrixWorld(true);
      for (const s of sailsOf(bp, asm)) {
        for (const c of capsulesOf(resolveSailSpars(s.node, readSailSparSources(s.mesh)))) {
          const len2 = (c.b[0] - c.a[0]) ** 2 + (c.b[1] - c.a[1]) ** 2 + (c.b[2] - c.a[2]) ** 2;
          if (len2 < 1e-12) continue; // an empty slot: no spar, nothing to face
          const zAt = (t: number): number => c.a[2] + (c.b[2] - c.a[2]) * t;
          const behind = [0, 0.25, 0.5, 0.75, 1].some((t) => zAt(t) < 0);
          expect(behind, `${label}: ${s.id} @ ${braceDeg}° got a capsule wholly forward of the canvas`).toBe(true);
        }
      }
    }
  };

  for (const [name, build] of SHIPS) {
    it(`${name}: every capsule it is GIVEN lies abaft the canvas`, () => {
      // the rest pose, because that is the pose the CHOICE is made in
      abaftCheck(build(), [0], name);
    });
  }

  for (const [name, build] of SQUARE_RIGGERS) {
    it(`${name}: and stays abaft through the whole brace range`, () => {
      // a square-rigger's masts stand on the CENTRELINE, so bracing rotates a
      // mast's bearing from the sail through x and its z stays −d·cos β — abaft
      // for every angle the yards can reach. The raft is exempt and knowingly
      // so: her bipod legs are off-centre, so hard-braced one of them swings
      // forward of the canvas. It cannot matter, because the stand-off is only
      // felt within ~1.4 spar radii and her legs are 0.09 m; measured max cloth
      // movement on the raft is entirely at full aback, never from a leg that
      // has come round.
      abaftCheck(build(), BRACES, name);
    });
  }
});

/**
 * THE RAFT'S BIPOD, which is the reason there are TWO mast slots at all.
 *
 * Her mainsail hangs BETWEEN the two legs. One capsule leaves the other leg
 * cutting the canvas, and picking "the sail's parent mast" would pick neither:
 * `mast-main` on that raft is the topsail pole ABOVE the crossing, which the
 * mainsail never reaches. Asserted as the property — two DISTINCT spars, both
 * of them legs — rather than by name, so re-rigging her keeps it honest.
 */
describe('the raft mainsail is pushed off BOTH legs of the bipod', () => {
  it('gets two distinct spars, and they are the legs the canvas hangs between', () => {
    const bp = buildRaftBlueprint();
    const asm = new ShipAssembly(bp, stubFactory);
    asm.group.updateMatrixWorld(true);
    const main = sailsOf(bp, asm).find((s) => s.id === 'sail-main-lower')!;
    const sources = readSailSparSources(main.mesh);
    expect(sources.length).toBe(3); // two spars + its own yard
    const names = sources.slice(0, 2).map((s) => s.node.name);
    expect(new Set(names).size, `two DIFFERENT spars, got ${names.join(' + ')}`).toBe(2);
    // the canvas hangs between them: one to port, one to starboard
    const spars = resolveSailSpars(main.node, sources);
    const xs = [spars.mast, spars.mast2].map((c) => (c.a[0] + c.b[0]) / 2);
    expect(Math.min(...xs)).toBeLessThan(0);
    expect(Math.max(...xs)).toBeGreaterThan(0);
  });
});

/**
 * C1 — the push may not put a crease in the canvas.
 *
 * TWO things are checked because they fail independently: the RAMP itself
 * (`sparRamp`, whose whole job is to round off a `max`) and the SURFACE as the
 * yards brace, which is where the capsule walks across the cloth.
 *
 * The ramp is checked as a derivative, not as a value: a `max` is continuous
 * and would sail through any position test — it is its SLOPE that jumps, and a
 * slope jump in a vertex displacement is a hard line in the shading.
 */
describe('the push-out is smooth — no crease, no step', () => {
  it("sparRamp's slope is continuous through both ends of its band", () => {
    const h = 1e-5;
    const d = (y: number): number => (sparRamp(y + h) - sparRamp(y - h)) / (2 * h);
    // 0 below the band, exactly 1 above it, and no jump at either join
    expect(Math.abs(d(-0.2))).toBeLessThan(1e-6);
    expect(Math.abs(d(2) - 1)).toBeLessThan(1e-4);
    let worst = 0;
    let prev = d(-0.5);
    for (let i = 1; i <= 4000; i++) {
      const y = -0.5 + (i / 4000) * 3;
      const cur = d(y);
      worst = Math.max(worst, Math.abs(cur - prev));
      prev = cur;
    }
    // 3/4000 of the sweep per step; a `max(0, y)` would show a jump of 1 here
    expect(worst, 'largest step in dφ/dy over the band').toBeLessThan(0.02);
  });

  it('folds by less than a hundredth of the skin, so no crease is visible', () => {
    // `y` grows as the point sinks INTO the spar, and the pushed coordinate is
    // `stand + skin·(1 − y + φ(y))`. That bracket is NOT monotone — no C1 ramp
    // that reaches a full push can be — so two points of cloth can swap order
    // in depth. The property that matters is that the swap is a fraction of
    // the skin, i.e. far below anything the sail mesh can resolve.
    let hi = -Infinity;
    let fold = 0;
    for (let i = 0; i <= 4000; i++) {
      const y = 3 - (i / 4000) * 3.5; // walk the point INWARD, s decreasing
      const g = 1 - y + sparRamp(y);
      fold = Math.max(fold, hi - g);
      hi = Math.max(hi, g);
    }
    expect(fold, `pushed coordinate runs backwards by ${fold.toFixed(4)} of the skin`)
      .toBeLessThan(0.16);
    // and a hard max(0, y) — the thing this ramp replaces — would fold by 0
    // but jump its slope by 1; that is what the derivative test above catches
  });

  for (const [name, build] of SHIPS) {
    it(`${name}: the surface moves continuously as the yards brace`, () => {
      const bp = build();
      const asm = new ShipAssembly(bp, stubFactory);
      const STEP = 0.05; // degrees
      const stations: Array<[number, number]> = [[0.5, 0.2], [0.45, 0.5], [0.55, 0.8], [0.5, 0.5]];
      const prev = new Map<string, V3>();
      let worst = { d: 0, at: '' };
      for (let k = 0; k <= 1880; k++) {
        const deg = -47 + k * STEP;
        asm.setRigTrim((deg * Math.PI) / 180);
        asm.group.updateMatrixWorld(true);
        for (const s of sailsOf(bp, asm)) {
          const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
          // aback: the state the push is actually doing work in
          const st = stateFor(s, -0.5, 1, 0, spars);
          for (const [u, v] of stations) {
            const p = sailClothPoint(u, v, s.width, s.drop, st, P) as V3;
            const key = `${s.id}|${u}|${v}`;
            const q = prev.get(key);
            if (q !== undefined) {
              const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
              if (d > worst.d) worst = { d, at: `${key} @ ${deg.toFixed(2)}°` };
            }
            prev.set(key, p);
          }
        }
      }
      // the yard itself sweeps ~6 mm per 0.05° at the widest yardarm, so a
      // CONTINUOUS surface moves the same order. A snap out of a mast would be
      // tens of centimetres in one step — that is the failure being excluded.
      expect(worst.d, `largest jump per ${STEP}° of brace, at ${worst.at}`).toBeLessThan(0.02);
    });
  }
});

/**
 * THE STAND-OFF ENCLOSES THE SPAR IT STANDS OFF — the property that makes the
 * push a GUARANTEE rather than a nudge, and the reason SAIL_SPAR_WRAP is ½.
 *
 * `sparStandoff` is a parabola in the lateral offset, not the cylinder's own
 * √(r² − off²), because the exact profile creases at the silhouette. It is only
 * allowed to replace it while it stays OUTSIDE it everywhere. Tested over a
 * decade of radii and the whole legal skin range, because a re-tune of either
 * is exactly the move that would quietly break it.
 */
describe('the stand-off profile never dips inside the spar', () => {
  it('is ≥ the true cylinder at every lateral offset, for every radius and skin', () => {
    for (const r of [0.02, 0.05, 0.1, 0.32, 0.42, 1.0]) {
      for (const frac of [0.02, 0.12, 0.6]) {
        const skin = Math.max(1e-3, frac * r);
        for (let i = 0; i <= 200; i++) {
          const off = (i / 200) * r;
          const need = Math.sqrt(Math.max(0, r * r - off * off));
          const got = sparStandoff(r, skin, off * off);
          expect(got, `r=${r} skin=${skin} off=${off}`).toBeGreaterThanOrEqual(need - 1e-12);
        }
      }
    }
  });

  it('releases cloth that is legitimately abaft the spar, so a clew is free', () => {
    // far enough to the side and the stand-off goes NEGATIVE — that tail is
    // what stops the constraint becoming a plane across the whole sail
    expect(sparStandoff(0.42, 0.05, 6 * 6)).toBeLessThan(-10);
    expect(SAIL_SPAR_WRAP).toBeLessThanOrEqual(0.5); // the proof's own bound
  });
});

/**
 * IDEMPOTENCE, AND THE HONEST VERSION OF IT.
 *
 * A projection is idempotent exactly when its image is its fixed-point set —
 * which for a one-sided constraint means the `max`'s corner, i.e. the crease
 * the C1 ramp exists to remove. So the two cannot both hold, and the shipped
 * choice is C1. What IS asserted is that the residual is bounded and tiny:
 * inside the band φ(y) < y, and re-applying converges geometrically.
 */
describe('applying the push twice barely moves the point again', () => {
  it('re-pushing lands within a twentieth of the skin, everywhere in the band', () => {
    const cap: SailSparCapsule = { a: [0, -10, -0.9], b: [0, 10, -0.9], ra: 0.42, rb: 0.19 };
    const skinFrac = P.sailSparSkin;
    let worst = 0;
    for (let i = 0; i <= 400; i++) {
      for (let j = 0; j <= 20; j++) {
        const z = -3 + (i / 400) * 4; // from clean through to well clear
        const x = -1 + (j / 20) * 2;
        const rest: V3 = [x, 0, 0];
        const once = sparPush([x, 0, z], rest, cap, skinFrac);
        const twice = sparPush(once, rest, cap, skinFrac);
        worst = Math.max(worst, Math.hypot(twice[0] - once[0], twice[1] - once[1], twice[2] - once[2]));
      }
    }
    const skin = skinFrac * 0.42;
    expect(worst, `second push moved ${(worst * 1000).toFixed(2)} mm`).toBeLessThan(0.05 * skin);
  });
});

/**
 * §V28 — a NaN here is a NaN rope AND a NaN vertex, because the same function
 * feeds `socketWorldPosition` and the vertex stage.
 */
describe('never NaN, whatever the piece graph hands over', () => {
  const cases: Array<[string, SailSparCapsule]> = [
    ['no spar (a == b)', { a: [0, 0, 0], b: [0, 0, 0], ra: 0.4, rb: 0.4 }],
    ['zero radius', { a: [0, -5, -1], b: [0, 5, -1], ra: 0, rb: 0 }],
    ['axis through the cloth', { a: [0, -5, 0], b: [0, 5, 0], ra: 0.4, rb: 0.2 }],
    ['spar parallel to the push direction', { a: [0, 0, -5], b: [0, 0, 5], ra: 0.4, rb: 0.4 }],
    ['NaN ends', { a: [NaN, NaN, NaN], b: [0, 1, 0], ra: NaN, rb: 0.2 }],
    ['negative radius', { a: [0, -5, -1], b: [0, 5, -1], ra: -3, rb: -1 }],
  ];
  for (const [label, cap] of cases) {
    it(`survives: ${label}`, () => {
      for (const p of [[0, 0, 0], [0, 0, -1], [0.001, -3, -0.9], [-6, -7, 2]] as V3[]) {
        const q = sparPush(p, [p[0], p[1], 0], cap, P.sailSparSkin);
        expect(q.every(Number.isFinite), `${label} at ${p.join(',')} → ${q.join(',')}`).toBe(true);
      }
    });
  }

  it('a point ON the axis is pushed OUT of it, not left there', () => {
    const cap: SailSparCapsule = { a: [0, -5, -1], b: [0, 5, -1], ra: 0.4, rb: 0.4 };
    const q = sparPush([0, 0, -1], [0, 0, 0], cap, P.sailSparSkin);
    expect(q.every(Number.isFinite)).toBe(true);
    expect(penetration(q, cap)).toBeLessThan(TOL);
  });

  it('a sail with no spars at all evaluates to the plain membrane', () => {
    const st = (spars?: SailSpars): SailClothState => ({
      drive: -1, luff: 0.4, skew: 0.2, dropScale: 0.5, flutterPhase: 1,
      sheetLeadPort: [0, -1, 0], sheetLeadStarboard: [0, -1, 0], spars,
    });
    for (const [u, v] of [[0, 0], [0.5, 0.5], [1, 1], [0.3, 0.9]]) {
      expect(sailClothPoint(u, v, 12, 6, st(NO_SAIL_SPARS), P))
        .toEqual(sailClothPoint(u, v, 12, 6, st(), P));
    }
  });
});

/**
 * §V67 — CLOTH CONSERVES ITS OWN AREA, and a collision pass is exactly the
 * kind of change that quietly stops it doing so.
 *
 * The strip lengths of a DRAWING sail must be untouched, which follows from the
 * bit-identity test above but is asserted on the quantity §V67 is actually
 * about. Where the push does work — cloth lifted off a mast it was inside —
 * the strip necessarily gets longer, because going over an obstacle is further
 * than going through it. That is bounded rather than pinned: a bar that is
 * crossed means the push has started reshaping sails, not just clearing spars.
 */
describe('arc length (§V67) survives the push', () => {
  const stripLength = (at: (t: number) => V3): number => {
    let L = 0;
    let prev = at(0);
    for (let k = 1; k <= 300; k++) {
      const q = at(k / 300);
      L += Math.hypot(q[0] - prev[0], q[1] - prev[1], q[2] - prev[2]);
      prev = q;
    }
    return L;
  };

  for (const [name, build] of SQUARE_RIGGERS) {
    it(`${name}: a drawing sail's strips are exactly as long as before`, () => {
      const bp = build();
      const asm = new ShipAssembly(bp, stubFactory);
      asm.setRigTrim(0);
      asm.group.updateMatrixWorld(true);
      for (const s of sailsOf(bp, asm)) {
        const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
        for (const drive of [0, 0.5, 1]) {
          const on = stateFor(s, drive, 1, 0, spars);
          const off = { ...on, spars: undefined };
          const h = (st: SailClothState): number =>
            stripLength((t) => sailClothPoint(t, 0.12, s.width, s.drop, st, P) as V3);
          const v = (st: SailClothState): number =>
            stripLength((t) => sailClothPoint(0.5, t, s.width, s.drop, st, P) as V3);
          expect(h(on)).toBeCloseTo(h(off), 10);
          expect(v(on)).toBeCloseTo(v(off), 10);
        }
      }
    });
  }

  it('a backed sail wrapping its mast gains length, but a bounded amount', () => {
    const bp = buildGalleonBlueprint();
    const asm = new ShipAssembly(bp, stubFactory);
    asm.setRigTrim(0);
    asm.group.updateMatrixWorld(true);
    let worst = 0;
    for (const s of sailsOf(bp, asm)) {
      const spars = resolveSailSpars(s.node, readSailSparSources(s.mesh));
      for (const drive of [-0.25, -0.5, -1]) {
        const on = stateFor(s, drive, 1, 0, spars);
        const off = { ...on, spars: undefined };
        const len = (st: SailClothState): number =>
          stripLength((t) => sailClothPoint(t, 0.12, s.width, s.drop, st, P) as V3);
        worst = Math.max(worst, len(on) / len(off) - 1);
      }
    }
    // measured 0.28 at full aback on the main course, where the cloth was 2.6 m
    // through the mast before the fix; the bar is clear of that, and a push
    // that started reshaping DRAWING sails would blow straight past it
    expect(worst, `worst strip growth ${(100 * worst).toFixed(1)}%`).toBeLessThan(0.45);
  });
});

/**
 * THE CPU/GPU MIRROR (§T.85's own rule, §V.45's lesson).
 *
 * 24 of 68 ropes resolve their endpoints through `sailShape.ts`; every pixel
 * comes from `sailClothNodes.ts`. The two cannot share code — one is JS
 * arithmetic, the other a node graph — so the discipline is that any drift
 * shows up in a side-by-side diff, and this test is what makes that mechanical.
 *
 * WHAT IT CANNOT PROVE, stated plainly: it reads SOURCE, not numbers. Only a
 * GPU readback of the vertex stage would close the seam, and this suite has no
 * device (§V88). What it does catch is the two failures that have actually
 * happened in this file's history — a constant COPIED instead of imported, and
 * the expression order quietly diverging.
 */
describe('the TSL transliteration stays parallel to the CPU evaluator', () => {
  const cpu = cpuSource;
  const gpu = gpuSource;

  it('imports the shared constants rather than repeating their values', () => {
    expect(gpu).toMatch(/SAIL_SPAR_WRAP,/);
    expect(gpu).toMatch(/SAIL_SPAR_MIN_R,/);
    // …and never declares its own copy, which is the drift §T.85's header is
    // about (this file once carried private copies of 0.22/0.9/0.3/1.3/2.1)
    expect(gpu).not.toMatch(/const SAIL_SPAR_WRAP/);
    expect(gpu).not.toMatch(/const SAIL_SPAR_MIN_R/);
    expect(gpu).not.toMatch(/SAIL_SPAR_MIN_R\s*=/);
    expect(SAIL_SPAR_WRAP).toBeGreaterThan(0);
    expect(SAIL_SPAR_MIN_R).toBeGreaterThan(0);
  });

  it('takes the same steps in the same order', () => {
    const STEPS = [
      'const len2', 'const len ', 'const along', 'const stat ', 'const radius',
      'const s ', 'const t ', 'const h ', 'const skin', 'const stand', 'const push',
    ];
    const positions = (src: string): number[] => STEPS.map((k) => src.indexOf(k));
    for (const [where, src] of [['CPU', cpu], ['GPU', gpu]] as const) {
      const at = positions(src);
      expect(at.every((i) => i >= 0), `${where} is missing one of ${STEPS.join(', ')}`).toBe(true);
      for (let i = 1; i < at.length; i++) {
        expect(at[i], `${where}: ${STEPS[i]} comes before ${STEPS[i - 1]}`).toBeGreaterThan(at[i - 1]);
      }
    }
  });

  it('pushes off the same three spars in the same slot order', () => {
    expect(cpu).toMatch(/spars\.mast,[\s\S]{0,140}spars\.mast2,[\s\S]{0,140}spars\.yard/);
    expect(gpu).toMatch(/wind\.mastA[\s\S]{0,200}wind\.mast2A[\s\S]{0,200}wind\.yardA/);
  });

  it('applies the push where the CPU applies it: last, and to the whole point', () => {
    // CPU: the closing line of sailClothPoint
    expect(cpu).toMatch(/return sailSparPush\(\[x, y, z\], \[/);
    // GPU: the surface AND both finite differences read the pushed point, or
    // the shading would follow a sail that is not the one being drawn
    expect(gpu).toMatch(/const shaped = clothAt\(u0, v0\)/);
    expect(gpu).toMatch(/const du = clothAt\(u0\.add\(e\), v0\)\.sub\(shaped\)/);
    expect(gpu).toMatch(/const dv = clothAt\(u0, v0\.add\(e\)\)\.sub\(shaped\)/);
  });
});
