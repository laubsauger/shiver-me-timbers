/**
 * §V12/§V45 rigging-block tests — the CPU ground truth for the block vertex
 * stage, which (like every other shader in src/ropes) cannot be unit-tested
 * itself. src/ropes/blockMath.ts is what the shader transliterates, so if it is
 * wrong every pulley on the ship is wrong.
 *
 * These encode the USER REPORT that produced this module, not today's numbers:
 * blocks that "are not really playing with the physics, as the ropes do". Two
 * properties are load-bearing and both used to be false:
 *
 *   1. a block's POSITION comes from the rope's solved curve, so it moves when
 *      the rope moves — not from the socket, which only ever moves with the
 *      ship. A block placed from a socket passes nothing below.
 *   2. a block's ORIENTATION comes from the line's tangent and the line's
 *      tension, so it hangs plumb when slack and is dragged into the line when
 *      taut. A block with a fixed decorative yaw — what shipped before — fails
 *      every orientation test here.
 */
import { describe, expect, it } from 'vitest';
import { solveCatenary, type Vec3Like } from '../src/ropes/catenaryMath';
import {
  DOWN,
  blockDetail,
  blockPose,
  blockTension,
  curveTangents,
  packBlocks,
  sampleCurve,
  type BlockDescriptor,
} from '../src/ropes/blockMath';
import { buildBlockDescriptors, buildRiggingPlan } from '../src/ropes/shipRigging';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { projectedWidthPx } from '../src/ropes/phoneWireAA';
import { ropeParams } from '../src/params/ropes';

const v3 = (x: number, y: number, z: number): Vec3Like => ({ x, y, z });
const dot = (a: Vec3Like, b: Vec3Like): number => a.x * b.x + a.y * b.y + a.z * b.z;
const dist = (a: Vec3Like, b: Vec3Like): number =>
  Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z);
const angleDeg = (a: Vec3Like, b: Vec3Like): number =>
  (Math.acos(Math.min(1, Math.max(-1, dot(a, b)))) * 180) / Math.PI;
const rotY = (p: Vec3Like, rad: number): Vec3Like =>
  v3(
    p.x * Math.cos(rad) - p.z * Math.sin(rad),
    p.y,
    p.x * Math.sin(rad) + p.z * Math.cos(rad),
  );
/** roll the whole ship about its own fore-and-aft axis (world Z) */
const rollZ = (p: Vec3Like, rad: number): Vec3Like =>
  v3(p.x * Math.cos(rad) - p.y * Math.sin(rad), p.x * Math.sin(rad) + p.y * Math.cos(rad), p.z);

const SPAN = ropeParams.blockSlackSpan;
const SEG = ropeParams.segmentsPerRope;

/** one solved rope + the block hanging on it, exactly as the GPU assembles it:
 *  the compute pass writes points and tangents, the vertex stage samples both */
function hang(
  A: Vec3Like,
  B: Vec3Like,
  slack: number,
  t = ropeParams.blockAnchorT,
): ReturnType<typeof blockPose> & { points: Vec3Like[]; chord: number } {
  const chord = dist(A, B);
  const L = chord * slack;
  const points = solveCatenary(A, B, L, SEG);
  const desc: BlockDescriptor = {
    rope: 3,
    t,
    size: ropeParams.blockSize,
    away: 1,
    socket: 'test',
  };
  const pose = blockPose(points, curveTangents(points), desc, L / chord, SPAN);
  return { ...pose, points, chord };
}

describe('§V12 block orientation follows its line', () => {
  it('a TAUT line drags its block into the line instead of letting it hang', () => {
    // WHY: this is the user-visible half of "playing with the physics" — a
    // block under tension lies along its rope. The old fixed-yaw instance
    // matrix pointed the same way no matter what the line did.
    const A = v3(0, 12, 0);
    const B = v3(14, 12.5, 5);
    const pose = hang(A, B, 1.001);
    const chordDir = (() => {
      const d = v3(B.x - A.x, B.y - A.y, B.z - A.z);
      const l = Math.hypot(d.x, d.y, d.z);
      return v3(d.x / l, d.y / l, d.z / l);
    })();
    expect(pose.tension).toBeGreaterThan(0.9);
    expect(angleDeg(pose.frame.hang, chordDir)).toBeLessThan(10);
    // …and emphatically NOT plumb, which is what it does when nothing pulls
    expect(angleDeg(pose.frame.hang, DOWN)).toBeGreaterThan(60);
  });

  it('a SLACK line lets its block hang plumb', () => {
    // WHY: the other end of the same behaviour. A block on a limp line is a
    // weight on a string; it must not point along a rope that is not pulling.
    const pose = hang(v3(0, 12, 0), v3(14, 12, 5), 1.25);
    expect(pose.tension).toBe(0);
    expect(angleDeg(pose.frame.hang, DOWN)).toBeLessThan(1);
  });

  it('rotating the line rotates the block: orientation is not a constant', () => {
    // WHY: the direct regression test for the shipped bug. A block whose
    // orientation ignores its line's tangent produces the SAME frame for both
    // of these, and this is the assertion that fails when someone reintroduces
    // a fixed yaw "because it looked fine".
    const A = v3(0, 12, 0);
    const straight = hang(A, v3(14, 12.5, 0), 1.002);
    const swung = hang(A, rotY(v3(14, 12.5, 0), Math.PI / 3), 1.002);
    expect(angleDeg(straight.frame.hang, swung.frame.hang)).toBeGreaterThan(30);
    // the sheave's axle turns with it — the slot stays square to the line
    expect(angleDeg(straight.frame.axle, swung.frame.axle)).toBeGreaterThan(30);
  });

  it('does not SNAP as its line swings through plumb (ship rolling)', () => {
    // WHY: the sheave's axle is square to the vertical plane its line runs in,
    // and that plane is undefined for a plumb line. The first version switched
    // to a seeded fallback below an epsilon — a discontinuity sitting exactly
    // where a lift or halyard passes as the ship rolls, measured at a 127.6°
    // frame snap in one frame: a pulley spinning on the spot. Same defect
    // class as the ratline rungs (§V45). No orientation is more correct than
    // another at plumb; what matters is that it does not JUMP.
    let previous: ReturnType<typeof hang> | null = null;
    let worstJump = 0;
    for (let i = 0; i <= 400; i++) {
      const offset = -0.5 + i / 400; // lower anchor sweeps through directly-below
      const pose = hang(v3(0, 20, 0), v3(offset, 8, 0), 1.02);
      if (previous !== null) {
        worstJump = Math.max(
          worstJump,
          angleDeg(previous.frame.axle, pose.frame.axle),
          angleDeg(previous.frame.side, pose.frame.side),
        );
      }
      previous = pose;
    }
    expect(worstJump, 'worst frame jump per step through plumb').toBeLessThan(15);
  });

  it('the frame is orthonormal for every line attitude, including vertical', () => {
    // WHY: the frame is fed straight into a vertex position. A degenerate or
    // non-unit basis is a squashed block at best and a NaN vertex at worst,
    // and a NaN vertex position is the §B5 class of GPU wedge — not a visual
    // bug. A dead-vertical line is the case with no defined sheave plane.
    const cases: [Vec3Like, number][] = [
      [v3(14, 12, 0), 1.02],
      [v3(0, 2, 0), 1.02], // straight down: cross(tangent, DOWN) = 0
      [v3(0, 22, 0), 1.002], // straight up, taut
      [v3(-9, 12, -9), 1.1],
      [v3(0.0001, 12, 0), 1.5], // near-vertical AND very slack
    ];
    for (const [B, slack] of cases) {
      const { frame } = hang(v3(0, 12, 0), B, slack);
      for (const axis of [frame.hang, frame.axle, frame.side]) {
        expect(Number.isFinite(axis.x + axis.y + axis.z), JSON.stringify(B)).toBe(true);
        expect(Math.hypot(axis.x, axis.y, axis.z)).toBeCloseTo(1, 6);
      }
      expect(dot(frame.hang, frame.axle)).toBeCloseTo(0, 6);
      expect(dot(frame.hang, frame.side)).toBeCloseTo(0, 6);
      expect(dot(frame.axle, frame.side)).toBeCloseTo(0, 6);
    }
  });
});

describe('§V45 a block hangs off the SOLVED rope, not off its socket', () => {
  it('sits on the sagging curve, below the straight chord', () => {
    // WHY: the position test that a socket-placed block cannot pass. If a
    // block is ever placed from its anchor again it sits exactly ON the chord
    // and this fails — which is the whole point of addressing it by (rope, t).
    const A = v3(0, 14, 0);
    const B = v3(16, 14, 0);
    const pose = hang(A, B, 1.08, 0.35);
    const onChord = A.y + (B.y - A.y) * 0.35;
    expect(pose.position.y).toBeLessThan(onChord - 0.05);
    // and it is genuinely the curve sample, not an approximation of it
    const points = solveCatenary(A, B, dist(A, B) * 1.08, SEG);
    expect(dist(pose.position, sampleCurve(points, 0.35))).toBeCloseTo(0, 9);
  });

  it('moves AND re-cocks when the ship rolls its anchors', () => {
    // WHY: the reported symptom was pulleys standing still while the rig moved
    // around them. Rolling the ship moves both anchors, which moves the solved
    // curve, which must move the block — position and attitude both. Under
    // §V42 the same read picks up the chain's lag and whip for free.
    const A = v3(2, 16, -3);
    const B = v3(9, 11, 4);
    const level = hang(A, B, 1.004);
    const heeled = hang(rollZ(A, 0.25), rollZ(B, 0.25), 1.004);
    expect(dist(level.position, heeled.position)).toBeGreaterThan(0.5);
    expect(angleDeg(level.frame.hang, heeled.frame.hang)).toBeGreaterThan(5);
  });

  it('…but a PLUMB block only translates: gravity is world, not ship', () => {
    // WHY: the complement, and it is the one a "just parent it to the socket"
    // fix gets wrong. A block on a limp line hangs straight down no matter how
    // far the ship heels — rigidly attached geometry rolls with the hull and
    // reads immediately as glued on.
    const A = v3(2, 16, -3);
    const B = v3(9, 11, 4);
    const level = hang(A, B, 1.2);
    const heeled = hang(rollZ(A, 0.3), rollZ(B, 0.3), 1.2);
    expect(dist(level.position, heeled.position)).toBeGreaterThan(0.5);
    expect(angleDeg(level.frame.hang, heeled.frame.hang)).toBeLessThan(0.001);
    expect(angleDeg(heeled.frame.hang, DOWN)).toBeLessThan(0.001);
  });

  it('§V46: hauling a line taut swings its block up into it, anchors unmoved', () => {
    // WHY: reefing changes a rope's LENGTH while its sockets stay put — that
    // is how a buntline snaps taut. The block must answer to that, because a
    // pulley that ignores the line going bar-tight is the same dead prop the
    // fixed instance matrix was. Tension is read from live descriptor data on
    // the GPU precisely so this works without a per-frame CPU update.
    const A = v3(0, 18, 0);
    const B = v3(11, 9, 2);
    const eased = hang(A, B, 1 + SPAN * 2);
    const hauled = hang(A, B, 1.001);
    expect(eased.tension).toBe(0);
    expect(hauled.tension).toBeGreaterThan(0.9);
    expect(angleDeg(eased.frame.hang, hauled.frame.hang)).toBeGreaterThan(20);
  });

  it('never produces a non-finite pose, even from a poisoned curve (§V28)', () => {
    // WHY: a NaN reaching a vertex position is a GPU wedge, not a glitch
    // (§B5). The shader guards by dividing by max(len, eps) and selecting
    // before it normalises; this pins that the reference does the same.
    const bad = new Array<Vec3Like>(SEG + 1).fill(v3(0, 0, 0));
    const desc: BlockDescriptor = {
      rope: 0,
      t: Number.NaN,
      size: ropeParams.blockSize,
      away: 1,
      socket: 'bad',
    };
    const pose = blockPose(bad, curveTangents(bad), desc, Number.NaN, SPAN);
    for (const v of [pose.position, pose.frame.hang, pose.frame.axle, pose.frame.side]) {
      expect(Number.isFinite(v.x + v.y + v.z)).toBe(true);
    }
    expect(Number.isFinite(pose.tension)).toBe(true);
  });
});

describe('block tension is read from the rope, and band-limited detail (§V48)', () => {
  it('tension falls monotonically from taut to limp over the slack span', () => {
    // WHY: any step here shows as a pulley snapping between two attitudes as
    // the sails trim. It must be smooth over the range §V46 actually sweeps.
    let last = Infinity;
    for (let i = 0; i <= 20; i++) {
      const tension = blockTension(1 + (SPAN * 1.5 * i) / 20, SPAN);
      expect(tension).toBeLessThanOrEqual(last + 1e-12);
      expect(tension).toBeGreaterThanOrEqual(0);
      expect(tension).toBeLessThanOrEqual(1);
      last = tension;
    }
    expect(blockTension(1, SPAN)).toBe(1);
    expect(blockTension(1 + SPAN, SPAN)).toBe(0);
  });

  it('the sheave and strop contrast is gone BEFORE the slot goes sub-pixel', () => {
    // WHY: §B.20 — an unfiltered high-contrast feature narrower than the pixel
    // grid is differenced into speckle, and it is ALWAYS discovered late (six
    // recorded occurrences under §V48). The slot is ~1/6 of the shell, so it
    // goes sub-pixel roughly six times sooner than the block does. §V48's own
    // refinement is the measurement that matters: band-limit against the
    // SHARPEST FEATURE's width, not the object's, and one pixel is already too
    // late because neighbouring samples straddle the whole step. So the fade
    // must be COMPLETE by the time the slot is 2 px, and may only be at full
    // strength while it is comfortably wider than that.
    const fov = (60 * Math.PI) / 180;
    const shell = ropeParams.blockSize;
    const slot = shell / 6;
    const min = ropeParams.blockDetailMinPx;
    const max = ropeParams.blockDetailMaxPx;
    const px = (feature: number, d: number): number =>
      projectedWidthPx(feature / 2, d, 1080, fov);
    /** distance at which `feature` is exactly `wanted` px across */
    const rangeFor = (feature: number, wanted: number): number => {
      let d = 1;
      while (px(feature, d) > wanted && d < 10000) d += 0.5;
      return d;
    };
    expect(blockDetail(px(shell, rangeFor(slot, 2)), min, max)).toBe(0);
    // full detail only where the slot is genuinely resolved — several pixels,
    // which for a 0.25 m block means a close hero shot and nothing further
    expect(blockDetail(px(shell, rangeFor(slot, 4)), min, max)).toBeGreaterThan(0.9);
    // and monotone in between, so nothing pops on the way out
    let prev = -1;
    for (let d = 200; d >= 2; d -= 2) {
      const detail = blockDetail(px(shell, d), min, max);
      expect(detail).toBeGreaterThanOrEqual(prev);
      prev = detail;
    }
  });

  it('packs descriptors into the exact lane layout the vertex stage reads', () => {
    // WHY: the packing is the wire format between the CPU plan and the shader.
    // A silent field reorder aims every pulley at the wrong rope — no error,
    // no NaN, just pulleys hanging in space (the §B8 failure shape).
    const plan = buildRiggingPlan(buildGalleonBlueprint());
    const blocks = buildBlockDescriptors(plan, ropeParams.maxBlocks);
    const arr = new Float32Array(blocks.length * 4);
    packBlocks(blocks, arr);
    blocks.forEach((b, i) => {
      expect(arr[i * 4]).toBe(b.rope);
      expect(arr[i * 4 + 1]).toBeCloseTo(b.t, 6);
      expect(arr[i * 4 + 2]).toBeCloseTo(b.size, 6);
      expect(arr[i * 4 + 3]).toBe(b.away);
    });
    expect(arr.every((n) => Number.isFinite(n))).toBe(true);
  });
});
