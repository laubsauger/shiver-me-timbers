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
 *   - its water compiles into a material's output as a pure expression of the world ray (face-safe: no screen space).
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { LINE_DOWN, LINE_DOWN_ON, createLineDown } from '../src/drift/wandering/lineDown';
import { SUNKEN_SET } from '../src/drift/wandering/drowned';
import { beatStarts } from '../src/drift/wandering/beats';

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
});
