/**
 * SCRATCH (§T.132 measurement) — how many DISTINCT sierra terrain/rock
 * programs does the raft world's island set produce, and what does the
 * NodeBuilder codegen for them cost?
 *
 * MEASURED, same machine, minutes apart, on the raft world's six islands
 * (3 slices @256^2 + 3 fillers @128^2), against the tree with the T128
 * nodeTypeCache fix already in it:
 *
 *   BEFORE (one material per heightmap)   terrain 6 programs / 12,882 ms
 *                                         rock    6 programs /  8,563 ms
 *   AFTER  (one material, atlas layers)   terrain 1 program  /  2,251 ms
 *                                         rock    1 program  /  1,507 ms
 *
 * 12 programs / 21.4 s -> 2 programs / 3.8 s, and now FLAT in island count.
 * The BEFORE leg was this file with `{ horizon, info, iceAzimuth }` per
 * island; diffing two of those shaders showed exactly six differing literals.
 *
 * Not a gate. The gate is tests/islandMaterialSharing.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';

import { createSierraRockMaterial, createSierraTerrainMaterial } from '../src/island/sierraMaterial';
import { createSierraAtlas } from '../src/island/sierraAtlas';
import type { IslandHeightmap } from '../src/island/heightmap';

const hash = (s: string): string => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16);
};

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 4,
    height: 4,
    style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  } as unknown as HTMLCanvasElement;
}

const normalise = (wgsl: string): string => wgsl.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N');

function build(material: THREE.Material, geometry: THREE.BufferGeometry): { wgsl: string; ms: number } {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
  const mesh = new THREE.Mesh(geometry, material);
  const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
  backend.renderer = renderer;
  (renderer as unknown as { hasFeature: (n: string) => boolean }).hasFeature = (n: string): boolean =>
    n === 'float32-filterable';
  const builder = (
    backend as unknown as {
      createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown>;
    }
  ).createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = material;
  builder.camera = new THREE.PerspectiveCamera();
  (builder.context as Record<string, unknown>).material = material;
  builder.lightsNode = lights([]);
  const t0 = performance.now();
  (builder as unknown as { build: () => void }).build();
  const ms = performance.now() - t0;
  return {
    wgsl: normalise(`${builder.vertexShader as string}\n/*---*/\n${builder.fragmentShader as string}`),
    ms,
  };
}

/** the raft world: 3 slice islands @256², 2 fillers + 1 half dome @128² */
const WORLD = [
  { size: 256, radius: 280, az: 0.3 },
  { size: 256, radius: 220, az: 1.1 },
  { size: 256, radius: 165, az: 2.7 },
  { size: 128, radius: 88, az: 4.0 },
  { size: 128, radius: 62, az: 5.2 },
  { size: 128, radius: 74, az: 0.9 },
];

function fakeHeightmap(size: number, radius: number, az: number): IslandHeightmap {
  const data = new Float32Array(size * size);
  for (let iz = 0; iz < size; iz++) {
    for (let ix = 0; ix < size; ix++) {
      const u = (ix / (size - 1)) * 2 - 1;
      const v = (iz / (size - 1)) * 2 - 1;
      data[iz * size + ix] = Math.max(0, 60 * (1 - Math.hypot(u, v))) - 5;
    }
  }
  return {
    archetype: 'sierraDome',
    features: [],
    data,
    size,
    worldRadius: radius,
    lagoonCenter: null,
    sierra: { iceAzimuth: az },
    heightAt: (): number => 0,
  } as unknown as IslandHeightmap;
}

describe('§T.132 scratch: sierra program count', () => {
  it('reports distinct programs + codegen ms for a 6-island world', () => {
    const geom = new THREE.PlaneGeometry(1, 1, 2, 2);
    const terrainHashes = new Set<string>();
    const rockHashes = new Set<string>();
    let terrainMs = 0;
    let rockMs = 0;

    const atlas = createSierraAtlas();
    for (const w of WORLD) atlas.bind(fakeHeightmap(w.size, w.radius, w.az));
    // ONE material each, built once, whatever the island count
    {
      const t = createSierraTerrainMaterial(undefined, { atlas });
      const bt = build(t.material, geom);
      terrainMs += bt.ms;
      terrainHashes.add(hash(bt.wgsl));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (globalThis as any).__t132 = bt.wgsl;
      const r = createSierraRockMaterial(undefined, { atlas });
      const br = build(r.material, geom);
      rockMs += br.ms;
      rockHashes.add(hash(br.wgsl));
    }

    // eslint-disable-next-line no-console
    console.log(
      `[T132] islands=${WORLD.length} terrain: programs=${terrainHashes.size} codegen=${terrainMs.toFixed(0)}ms | ` +
        `rock: programs=${rockHashes.size} codegen=${rockMs.toFixed(0)}ms`,
    );
    expect(terrainHashes.size).toBeGreaterThan(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const w = (globalThis as any).__t132 as string;
    // eslint-disable-next-line no-console
    console.log(w.split('\n').filter((l) => l.includes('nodeUniform') && (l.includes('textureSample') || l.includes('positionLocal.xz'))).slice(0, 12).join('\n'));
  }, 600_000);
});
