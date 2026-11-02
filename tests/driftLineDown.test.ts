/**
 * "THE LINE DOWN" — the underwater look-dev of the 2026-11-02 next-level review (src/drift/wandering/lineDown.ts). What
 * must hold, whatever its look is tuned to:
 *
 *   - it is OFF unless `?linedown` asks for it, so the next master draws as the last one did (the brief: "behind its
 *     own film param, default OFF") — and so is the c2 power line (`?powerline`, drowned.ts SUNKEN_SET);
 *   - its moment lies inside the synthesis's slot, c2–c3 (~365–410 s), on the beats' own clock: no beat moves for it
 *     (the music is synced);
 *   - open ocean only (the user, 2026-11-02: "we zoomed into what really looks like an ocean"): nothing in its set
 *     stands on a seabed — every piece floats, hangs from floats or swims, within a few metres of the surface;
 *   - its water compiles into a material's output as a pure expression of the world ray (face-safe: no screen space);
 *   - the brighter-water fallback (`?linedown=day`, after gate 2 found the sunset water too dark) lies in the
 *     synthesis's 300–345 s slot, in the landing's daylight, and ENDS where c1's follow begins: the hoist and the sail
 *     stay as they are (the dramaturg's objection to the slot: "it eats C1_FOLLOW"); the sunset version stays the
 *     default of `?linedown`.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { LINE_DOWN, LINE_DOWN_DAY, LINE_DOWN_LIGHT, LINE_DOWN_ON, LINE_DOWN_SUN_EL, createLineDown, lineDownLight, raiseSun } from '../src/drift/wandering/lineDown';
import { SUNKEN_SET } from '../src/drift/wandering/drowned';
import { C1_FOLLOW, beatStarts } from '../src/drift/wandering/beats';

const c1End = 41.1;
const { starts } = beatStarts(c1End);
/** show s of a sea time (c2 starts at 355 s of the show) */
const show = (sea: number): number => 355 + (sea - starts.c2);

function fragmentOf(mesh: THREE.Mesh, scene: THREE.Scene): string {
  const canvas = { width: 4, height: 4, style: {}, getContext: () => null, addEventListener: () => {}, removeEventListener: () => {}, getRootNode: () => ({}), setAttribute: () => {} };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three's internal codegen harness
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  backend.device = { limits: { maxUniformBufferBindingSize: 65536 } };
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.fogNode = scene.fogNode;
  builder.material = mesh.material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = builder.material;
  builder.build();
  return builder.fragmentShader;
}

describe('the Line Down look-dev', () => {
  it('is off by default, and so is the c2 power line', () => {
    expect(LINE_DOWN_ON).toBe(false);
    expect(SUNKEN_SET.powerLine).toBe(false);
  });

  it('lies inside the synthesis\'s slot, c2–c3, on the beats\' clock', () => {
    const from = show(starts[LINE_DOWN.from[0]] + LINE_DOWN.from[1]);
    const to = show(starts[LINE_DOWN.to[0]] + LINE_DOWN.to[1]);
    expect(from).toBeGreaterThanOrEqual(360);
    expect(to).toBeLessThanOrEqual(415);
    expect(to - from).toBeGreaterThan(20);
    // (the beats it is timed from are where the music has them: c2 at 355 s, c3 at 385 s)
    expect(show(starts.c3)).toBeCloseTo(385, 6);
  });

  const scene = new THREE.Scene();
  const look = createLineDown(undefined as unknown as THREE.WebGPURenderer, scene, starts);

  it('floats: nothing in the open-ocean set reaches deeper than a few metres', () => {
    const box = new THREE.Box3();
    look.group.updateMatrixWorld(true);
    look.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name === 'drift-dolphin') return;
      box.setFromObject(m);
      expect(box.min.y).toBeGreaterThan(-4.5);
    });
    // (and the eye is under the water deep enough for a window, not so deep the sunset's red is gone: K_red 0.36/m)
    expect(LINE_DOWN.depth).toBeGreaterThan(3);
    expect(Math.exp(-0.36 * LINE_DOWN.depth)).toBeGreaterThan(0.1);
  });

  it('puts its water into a material\'s output from the world ray', () => {
    expect(scene.fogNode).toBeTruthy();
    const frag = fragmentOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()), scene);
    expect(frag.length).toBeGreaterThan(100);
    // (the shafts' march along the ray is in it: the water reached the material)
    expect(frag).toMatch(/for\s*\(/);
    // (no screen-space read: the dome's faces would seam — the synthesis on godRays.ts)
    expect(frag).not.toMatch(/screenUV|textureSample\([^)]*scenePass/);
  });

  describe('the day fallback', () => {
    it('is asked for by name; a bare ?linedown keeps the sunset, and no Sun is raised unless asked', () => {
      expect(lineDownLight('day')).toBe('day');
      expect(lineDownLight('')).toBe('sunset');
      expect(lineDownLight(null)).toBe('sunset');
      expect(LINE_DOWN_LIGHT).toBe('sunset');
      expect(LINE_DOWN_SUN_EL).toBeUndefined();
    });

    it('lies in the 300–345 s slot and ends where the follow (the hoist, the sail) begins', () => {
      const from = show(starts[LINE_DOWN_DAY.from[0]] + LINE_DOWN_DAY.from[1]);
      const to = show(starts[LINE_DOWN_DAY.to[0]] + LINE_DOWN_DAY.to[1]);
      expect(from).toBeGreaterThanOrEqual(300);
      expect(to).toBeLessThanOrEqual(345);
      expect(to - from).toBeGreaterThan(10);
      // (the follow starts C1_FOLLOW before c2: the moment must not reach into it)
      expect(to).toBeLessThanOrEqual(show(starts.c2 - C1_FOLLOW) + 1e-9);
    });

    it('rises in under the raft, from deep enough for a wide window to shallow beside it', () => {
      const [d0, d1] = LINE_DOWN_DAY.depth;
      expect(d0).toBeGreaterThan(d1);
      expect(d1).toBeGreaterThan(3);
      // (the raft ahead of the eye throughout, nearer at the end)
      const [[, a0], [, a1]] = LINE_DOWN_DAY.offset;
      expect(a0).toBeLessThan(a1);
      expect(a1).toBeLessThan(0);
    });

    it('raises the Sun about its own bearing (the &ldsun look-dev)', () => {
      const s = new THREE.Vector3(0.3, Math.sin((11 * Math.PI) / 180), -0.9).normalize();
      const az = Math.atan2(s.x, s.z);
      raiseSun(s, 40);
      expect(s.length()).toBeCloseTo(1, 9);
      expect(Math.asin(s.y) * (180 / Math.PI)).toBeCloseTo(40, 9);
      expect(Math.atan2(s.x, s.z)).toBeCloseTo(az, 9);
    });

    it('builds the same face-safe water, without the case (c3\'s, not yet in the story)', () => {
      const daySc = new THREE.Scene();
      const dayLook = createLineDown(undefined as unknown as THREE.WebGPURenderer, daySc, starts, 'day');
      let caseShown = false;
      dayLook.group.traverse((o) => void (o.name === 'drift-hard-case' && o.visible && (caseShown = true)));
      expect(caseShown).toBe(false);
      const frag = fragmentOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()), daySc);
      expect(frag).toMatch(/for\s*\(/);
      expect(frag).not.toMatch(/screenUV|textureSample\([^)]*scenePass/);
    });
  });
});
