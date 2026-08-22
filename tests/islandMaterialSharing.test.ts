/**
 * §T.132 — THE SIERRA MATERIAL SET MUST NOT GROW WITH THE ISLAND COUNT.
 *
 * WHY THIS FILE EXISTS AT ALL. `islandMaterials.ts:62-70` carried a comment
 * saying the per-heightmap sierra handles "DO share the program: the node
 * graph is identical, only the texture binding differs, and the WebGPU
 * pipeline cache keys on the generated code". Every clause was false, and it
 * survived for months because NOTHING TESTED IT — the only test in the area
 * asserted the OPPOSITE (`expect(m.sierraRock(a)).not.toBe(m.sierraRock(b))`,
 * tests/terrainQuickWins.test.ts), i.e. it wrote the defect down (§V80's
 * corollary). Measured headlessly on the raft world's six islands: SIX
 * distinct terrain programs and SIX rock programs, 12.9 s + 8.6 s of
 * `NodeBuilder.build()`, and in-browser 39.9 s + 18.4 s of `compileAsync` —
 * the single biggest item in boot, and one that got worse with every island.
 * Six numbers did it: `2·worldRadius` (twice), the sheeting phase, the
 * joint-noise offset and the two joint axes were CONSTANTS in the graph, so
 * three printed each island's own values into its own WGSL.
 *
 * SO THE PROPERTY, not the decision (§V80): a world with N sierra islands
 * builds the SAME NUMBER of terrain/rock materials as a world with one, and
 * emits BYTE-IDENTICAL WGSL for both. The second half is the one that catches
 * a regression at its cause — the moment any per-island value goes back into
 * the graph as a literal, two differently-shaped worlds stop agreeing.
 *
 * It runs without a GPU for the reason tests/nodeTypeCache.test.ts documents:
 * `NodeBuilder.build()` is TSL setup + WGSL codegen + binding setup and never
 * touches a GPUDevice.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights } from 'three/tsl';
import {
  createSierraAtlas,
  resampleRgba8,
  tagSierraIsland,
  SIERRA_ATLAS_SIZE,
  type SierraIslandBinding,
} from '../src/island/sierraAtlas';
import { createSierraRockMaterial, createSierraTerrainMaterial } from '../src/island/sierraMaterial';
import { createIslandMaterials } from '../src/island/islandMaterials';
import type { IslandHeightmap } from '../src/island/heightmap';

// ── fixtures ──────────────────────────────────────────────────────────────

/**
 * A cone on a grid — enough for the horizon march and the info bake, and
 * cheap enough that nine of them cost less than one erosion pass. The bake
 * CONTENT is irrelevant here; what matters is that the islands differ in
 * every value that used to fork the shader: radius, grid size, ice azimuth.
 */
function fakeIsland(size: number, radius: number, az: number): IslandHeightmap {
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

/** the shipped raft world's shape: 3 slices at 256², 3 fillers at 128² */
const RAFT_WORLD = [
  fakeIsland(256, 280, 0.3),
  fakeIsland(256, 220, 1.1),
  fakeIsland(256, 165, 2.7),
  fakeIsland(128, 88, 4.0),
  fakeIsland(128, 62, 5.2),
  fakeIsland(128, 74, 0.9),
];

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

/** see tests/nodeTypeCache.test.ts: the buffer NAME carries a global counter */
const normalise = (wgsl: string): string => wgsl.replace(/NodeBuffer_\d+/g, 'NodeBuffer_N');

function buildWgsl(material: THREE.Material): string {
  const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(1, 1, 2, 2), material);
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
  (builder as unknown as { build: () => void }).build();
  return normalise(`${builder.vertexShader as string}\n/*---*/\n${builder.fragmentShader as string}`);
}

// ── the growth bound ──────────────────────────────────────────────────────

describe('§T.132 sierra materials do not grow with island count', () => {
  it('ONE terrain handle and ONE rock handle, whether the world has 1 island or 9', () => {
    const m = createIslandMaterials();
    try {
      const world = [...RAFT_WORLD, fakeIsland(128, 51, 3.3), fakeIsland(64, 44, 5.9), fakeIsland(256, 301, 2.2)];
      const terrains = new Set<unknown>();
      const rocks = new Set<unknown>();
      const growth: Array<{ islands: number; materials: number }> = [];
      for (let n = 1; n <= world.length; n++) {
        terrains.add(m.sierraTerrain(world[n - 1]));
        rocks.add(m.sierraRock(world[n - 1]));
        growth.push({ islands: n, materials: terrains.size + rocks.size });
      }
      // the PROPERTY: nine islands, two materials — the count is a constant
      // function of the island count, not a linear one
      expect(terrains.size).toBe(1);
      expect(rocks.size).toBe(1);
      for (const row of growth) expect(row.materials).toBe(2);
      // and the handle asked for without an island is the SAME one: which
      // island a draw belongs to is object state, not graph state
      expect(m.sierraTerrain()).toBe([...terrains][0]);
      expect(m.sierraRock()).toBe([...rocks][0]);
    } finally {
      m.dispose();
    }
  }, 120_000);

  it('two differently-shaped worlds emit BYTE-IDENTICAL WGSL (no per-island literal survives)', () => {
    // world A: one small island. world B: the raft world's six, every radius,
    // grid size and ice azimuth different. If ANY of those reaches the graph
    // as a constant — as `2·worldRadius`, `bandPhase`, the joint offset and
    // the two joint axes all did — these two shaders stop matching.
    const a = createSierraAtlas();
    a.bind(fakeIsland(128, 51, 3.3));
    const b = createSierraAtlas();
    for (const hm of RAFT_WORLD) b.bind(hm);

    const terrainA = createSierraTerrainMaterial(undefined, { atlas: a });
    const terrainB = createSierraTerrainMaterial(undefined, { atlas: b });
    expect(buildWgsl(terrainB.material)).toBe(buildWgsl(terrainA.material));

    const rockA = createSierraRockMaterial(undefined, { atlas: a });
    const rockB = createSierraRockMaterial(undefined, { atlas: b });
    expect(buildWgsl(rockB.material)).toBe(buildWgsl(rockA.material));

    terrainA.dispose();
    terrainB.dispose();
    rockA.dispose();
    rockB.dispose();
    a.dispose();
    b.dispose();
  }, 120_000);

  it('the atlas holds ONE layer per island and the shader reads it as an array index', () => {
    const atlas = createSierraAtlas();
    try {
      for (const hm of RAFT_WORLD) atlas.bind(hm);
      expect(atlas.used).toBe(RAFT_WORLD.length);
      // three textures for the whole world, one binding each (§V40) —
      // 2 horizon planes + 1 terrain-info, exactly what ONE island used to cost
      expect(atlas.horizon[0].image.depth).toBeGreaterThanOrEqual(RAFT_WORLD.length);
      const wgsl = buildWgsl(createSierraTerrainMaterial(undefined, { atlas }).material);
      // the layer index is an OBJECT uniform, not a constant
      expect(wgsl).toMatch(/textureSample\([^)]*,\s*i32\( object\.nodeUniform\d+ \) \)/);
    } finally {
      atlas.dispose();
    }
  }, 120_000);
});

// ── the per-object delivery (§T.90 / §B85) ────────────────────────────────

describe('§T.132 which island a draw belongs to is OBJECT state', () => {
  it('every uniform in the set carries the update hook (§B85), not just the first', () => {
    const atlas = createSierraAtlas();
    const u = atlas.uniforms;
    // §B85 cost a day: three runs a uniform's onObjectUpdate only when THAT
    // uniform is referenced by the shader, and the terrain graph and the rock
    // graph reference different subsets of these six. A hook on one of them
    // updates none of the others.
    for (const node of [u.layer, u.radius, u.jointOffset, u.jointDirA, u.jointDirB, u.bandPhase]) {
      expect((node as unknown as { updateType: string }).updateType).toBe('object');
      expect(typeof (node as unknown as { update: unknown }).update).toBe('function');
    }
    atlas.dispose();
  });

  it('drawing two islands with one material pushes each island\'s own numbers', () => {
    const atlas = createSierraAtlas();
    try {
      const first = fakeIsland(256, 280, 0.3);
      const second = fakeIsland(128, 62, 5.2);
      const meshA = new THREE.Mesh();
      const meshB = new THREE.Mesh();
      tagSierraIsland(meshA, atlas.bind(first));
      tagSierraIsland(meshB, atlas.bind(second));

      const u = atlas.uniforms as unknown as Record<string, { value: unknown; update(f: unknown): void }>;
      const read = (): { layer: unknown; radius: unknown; phase: unknown } => ({
        layer: u.layer.value,
        radius: u.radius.value,
        phase: u.bandPhase.value,
      });

      u.layer.update({ object: meshA, frameId: 1 });
      const a = read();
      u.layer.update({ object: meshB, frameId: 1 });
      const b = read();

      expect(a.radius).toBe(280);
      expect(b.radius).toBe(62);
      expect(a.layer).not.toBe(b.layer);
      expect(a.phase).not.toBe(b.phase);

      // ... and back, in the same frame: two islands in one pass must not
      // stick on whichever was drawn first
      u.layer.update({ object: meshA, frameId: 1 });
      expect(read().radius).toBe(280);
    } finally {
      atlas.dispose();
    }
  }, 120_000);

  it('tagSierraIsland reaches every mesh under the island group, not a hand list', () => {
    const atlas = createSierraAtlas();
    try {
      const group = new THREE.Group();
      const terrain = new THREE.Mesh();
      const rocks = new THREE.Group();
      const talus = new THREE.Mesh();
      rocks.add(talus);
      group.add(terrain, rocks);
      const binding = atlas.bind(RAFT_WORLD[0]);
      tagSierraIsland(group, binding);
      for (const o of [group, terrain, rocks, talus]) {
        expect(o.userData.sierraIsland).toBe(binding);
      }
    } finally {
      atlas.dispose();
    }
  }, 120_000);
});

// ── layer allocation ──────────────────────────────────────────────────────

describe('§T.132 atlas layer allocation', () => {
  it('binding is memoised per heightmap and a released layer is reused', () => {
    const atlas = createSierraAtlas(3);
    try {
      const a = fakeIsland(128, 90, 0.2);
      const b = fakeIsland(128, 70, 1.2);
      const first = atlas.bind(a);
      expect(atlas.bind(a)).toBe(first);
      expect(atlas.used).toBe(1);
      const secondLayer = atlas.bind(b).layer;
      expect(secondLayer).not.toBe(first.layer);
      expect(atlas.used).toBe(2);

      // an island destroyed at runtime hands its layer back — otherwise a
      // world that respawns islands runs the atlas dry (§T.132's free list)
      atlas.release(a);
      expect(atlas.used).toBe(1);
      const c = fakeIsland(128, 55, 2.2);
      expect(atlas.bind(c).layer).toBe(first.layer);
      expect(atlas.used).toBe(2);
    } finally {
      atlas.dispose();
    }
  }, 120_000);

  it('past the cap it says so by name rather than shading an island as its neighbour', () => {
    const atlas = createSierraAtlas(2);
    try {
      atlas.bind(fakeIsland(64, 40, 0.1));
      atlas.bind(fakeIsland(64, 41, 0.2));
      expect(() => atlas.bind(fakeIsland(64, 42, 0.3))).toThrow(/SIERRA_ATLAS_LAYERS/);
    } finally {
      atlas.dispose();
    }
  }, 120_000);
});

// ── the resample the fixed layer size forces ──────────────────────────────

describe('§T.132 layer resample', () => {
  it('a same-size layer is copied byte for byte', () => {
    const n = 8;
    const src = new Uint8Array(n * n * 4);
    for (let i = 0; i < src.length; i++) src[i] = (i * 37) & 255;
    const dst = new Uint8Array(n * n * 4 + 16);
    resampleRgba8(src, 0, n, dst, 16, n);
    expect([...dst.subarray(16)]).toEqual([...src]);
  });

  it('doubling reproduces the source at the GPU\'s own sampling points', () => {
    // A 128 layer read at 256 must be what the GPU's bilinear filter would
    // have returned from the 128 texture — that is the whole licence for
    // storing every island at one resolution. Destination texel 2i+0.5 in a
    // doubled grid straddles source texels i and i±1 at weights 3/4, 1/4.
    const n = 4;
    const src = new Uint8Array(n * n * 4);
    const at = (ix: number, iz: number): number => (iz * n + ix) * 4;
    for (let iz = 0; iz < n; iz++) {
      for (let ix = 0; ix < n; ix++) src[at(ix, iz)] = 20 * ix + 4 * iz;
    }
    const dst = new Uint8Array(n * n * 16);
    resampleRgba8(src, 0, n, dst, 0, n * 2);
    // an interior destination texel: 3/4 of its own source texel + 1/4 of the
    // neighbour, in both axes
    const d = (ix: number, iz: number): number => dst[(iz * n * 2 + ix) * 4];
    const bil = (x: number, z: number): number => {
      const x0 = Math.floor(x);
      const z0 = Math.floor(z);
      const fx = x - x0;
      const fz = z - z0;
      const s = (ix: number, iz: number): number => src[at(Math.min(ix, n - 1), Math.min(iz, n - 1))];
      const top = s(x0, z0) + (s(x0 + 1, z0) - s(x0, z0)) * fx;
      const bot = s(x0, z0 + 1) + (s(x0 + 1, z0 + 1) - s(x0, z0 + 1)) * fx;
      return top + (bot - top) * fz;
    };
    for (const [jx, jz] of [
      [3, 3],
      [4, 3],
      [5, 4],
    ]) {
      expect(d(jx, jz)).toBe(Math.round(bil((jx + 0.5) / 2 - 0.5, (jz + 0.5) / 2 - 0.5)));
    }
    // and the corner clamps rather than reading off the edge
    expect(d(0, 0)).toBe(src[at(0, 0)]);
  });

  it('the layer size is the largest grid the shipped world bakes', () => {
    // NOT a decision pinned for its own sake (§V80): the property is that the
    // HERO islands are stored at native resolution, so the only resampling in
    // the shipped world is an upsample, which is lossless under the linear
    // filter these fields are read with. If sliceGridSize moves past this,
    // slice shading starts losing detail and someone has to decide.
    expect(SIERRA_ATLAS_SIZE).toBeGreaterThanOrEqual(256);
  });

  it('a binding carries only numbers — nothing per-island can reach the graph through it', () => {
    const atlas = createSierraAtlas(1);
    try {
      const b: SierraIslandBinding = atlas.bind(RAFT_WORLD[0]);
      expect(Number.isFinite(b.radius)).toBe(true);
      expect(Number.isFinite(b.bandPhase)).toBe(true);
      expect(b.jointDirA.length()).toBeCloseTo(1, 6);
      expect(b.jointDirB.length()).toBeCloseTo(1, 6);
    } finally {
      atlas.dispose();
    }
  }, 120_000);
});
