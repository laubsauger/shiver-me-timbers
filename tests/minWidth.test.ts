/**
 * Minimum projected width for thin geometry (src/core/minWidth.ts, §V41/§V95). USER: "the power poles in the distance
 * look wonky. They get too thin and then aliasing eats them." The TSL cannot run headless; these drive the CPU mirror
 * and the member-axis builder the shader consumes, and each asserts the property the picture depends on.
 */
import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry, Matrix4, Vector3, type BufferGeometry } from 'three';
import { computeThinAxes, minWidthResponse, projectedWidthPxAt, THIN_MIN_WIDTH_PX, type ThinAxisGeometry } from '../src/core/minWidth';

/** concatenate geometries into one indexed soup, the way a GLB primitive joins every member of a material */
function soup(parts: BufferGeometry[]): ThinAxisGeometry & { pos: number[] } {
  const pos: number[] = [];
  const idx: number[] = [];
  for (const g of parts) {
    const base = pos.length / 3;
    const p = g.getAttribute('position');
    for (let i = 0; i < p.count; i++) pos.push(p.getX(i), p.getY(i), p.getZ(i));
    const ix = g.getIndex();
    for (let i = 0; i < ix!.count; i++) idx.push(base + ix!.getX(i));
  }
  return {
    pos,
    getAttribute: () => ({ count: pos.length / 3, getX: (i) => pos[i * 3], getY: (i) => pos[i * 3 + 1], getZ: (i) => pos[i * 3 + 2] }),
    getIndex: () => ({ count: idx.length, getX: (i) => idx[i] }),
  };
}

describe('minimum projected width', () => {
  it('a far member is drawn ≥ the floor and deposits exactly its true width — a faint line, not a thick one', () => {
    // a 16 cm pylon leg (half-width 8 cm) under a 60° chase camera at the 640×360 look pass: P00 = 1/(tan 30° · aspect)
    const projX = 1 / (Math.tan(Math.PI / 6) * (640 / 360));
    let last = Infinity;
    for (const depth of [5, 20, 50, 150, 400, 1000, 3500]) {
      const px = projectedWidthPxAt(0.08, depth, projX, 640);
      const { widen, coverage } = minWidthResponse(px, THIN_MIN_WIDTH_PX);
      expect(px * widen).toBeGreaterThanOrEqual(THIN_MIN_WIDTH_PX - 1e-9); // never a dashed sub-pixel sliver
      expect(px * widen * coverage).toBeCloseTo(px, 9); // energy: what the eye gets is the true width
      expect(coverage).toBeLessThanOrEqual(last); // fades monotonically with distance: no pop, no threshold
      last = coverage;
      if (px >= THIN_MIN_WIDTH_PX) expect([widen, coverage]).toEqual([1, 1]); // resolved members are untouched
    }
    expect(last).toBeGreaterThan(0); // still there at the pylon cull distance, just faint
    const zero = minWidthResponse(0, THIN_MIN_WIDTH_PX);
    expect(Number.isFinite(zero.widen) && zero.coverage === 0).toBe(true);
  });

  it('widening pushes a member out from its OWN axis — thicker, never longer, never shifted — and leaves a plate alone', () => {
    const leg = new CylinderGeometry(0.06, 0.06, 4, 8, 1, false);
    const tilt = new Matrix4().makeRotationZ(0.7).setPosition(3, 2, -1);
    leg.applyMatrix4(tilt);
    const plate = new BoxGeometry(1.2, 0.02, 0.9).translate(10, 0, 0); // a sign: fat, must never dither
    const g = soup([leg, plate]);
    const axes = computeThinAxes(g);
    const axis = new Vector3(0, 1, 0).transformDirection(tilt);
    const centre = new Vector3(3, 2, -1);
    const legVerts = leg.getAttribute('position').count;
    const widen = 7;
    for (let i = 0; i < g.pos.length / 3; i++) {
      const p = new Vector3(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2]);
      const o = new Vector3(axes[i * 4], axes[i * 4 + 1], axes[i * 4 + 2]);
      if (i >= legVerts) {
        expect([o.length(), axes[i * 4 + 3]]).toEqual([0, 0]);
        continue;
      }
      expect(axes[i * 4 + 3]).toBeCloseTo(0.06, 3); // half-width → the projected width the shader measures
      const moved = p.clone().addScaledVector(o, widen - 1); // the vertex stage
      const along = (v: Vector3): number => v.clone().sub(centre).dot(axis);
      const off = (v: Vector3): number => v.clone().sub(centre).addScaledVector(axis, -along(v)).length();
      expect(along(moved)).toBeCloseTo(along(p), 6);
      if (off(p) > 1e-6) expect(off(moved) / off(p)).toBeCloseTo(widen, 4);
    }
  });

  it('a lattice that decimation fused into one shell still resolves into its members', () => {
    // a leg and a diagonal sharing their end vertices at a node: one welded shell that is not a straight member
    const leg = new BoxGeometry(0.12, 6, 0.12);
    const brace = new BoxGeometry(0.08, 3, 0.08).applyMatrix4(new Matrix4().makeRotationZ(Math.PI / 4));
    const g = soup([leg, brace]);
    // weld them: move the brace so one of its end corners lands exactly on a leg corner
    const legTop = new Vector3(g.pos[0], g.pos[1], g.pos[2]);
    const n = leg.getAttribute('position').count;
    const d = legTop.clone().sub(new Vector3(g.pos[n * 3], g.pos[n * 3 + 1], g.pos[n * 3 + 2]));
    for (let i = n; i < g.pos.length / 3; i++) for (let c = 0; c < 3; c++) g.pos[i * 3 + c] += d.getComponent(c);
    const axes = computeThinAxes(g);
    const radii = new Set<number>();
    for (let i = 0; i < g.pos.length / 3; i++) if (axes[i * 4 + 3] > 0) radii.add(Math.round(axes[i * 4 + 3] * 1000));
    // both members found, each with its own half-width (box half-diagonals 0.085 and 0.057)
    expect([...radii].sort()).toEqual([57, 85]);
  });
});
