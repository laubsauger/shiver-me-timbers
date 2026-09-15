import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { activeBoatLightPool, createBoatLightPool, setActiveBoatLightPool } from '../src/ocean/boatLightPool';
import { createRoosterTail } from '../src/foam/roosterTail';
import { createHullSpray } from '../src/foam/hullSpray';

// Real TSL codegen, without a GPU device (same harness as wakeFoamBow).
// This catches an unscoped Loop disappearing while the shader still compiles.
function shaders(mesh: THREE.Object3D): { vertex: string; fragment: string } {
  const canvas = {
    width: 4, height: 4, style: {}, getContext: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    getRootNode: () => ({}), setAttribute: () => {},
  };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three's internal codegen harness
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = (mesh as THREE.Mesh).material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = builder.material;
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}

describe('spray lighting shader stage and LED flow', () => {
  it.each(['drops', 'mist', 'hull'] as const)('%s retains active LEDs in the vertex stage and skips zero-colour slots', (kind) => {
    const previous = activeBoatLightPool();
    setActiveBoatLightPool(createBoatLightPool(2));
    const rooster = createRoosterTail({ count: 4 });
    const hull = createHullSpray({ count: 4 });
    try {
      const mesh = kind === 'hull' ? hull.mesh : rooster.meshes[kind === 'drops' ? 0 : 1];
      const { vertex, fragment } = shaders(mesh);
      expect(vertex).toMatch(/for \( var i : i32 = 0; i < 2; i \+\+ \)/);
      expect(vertex).toMatch(/\.x != 0\.0/);
      expect(vertex).toMatch(/\.y != 0\.0/);
      expect(vertex).toMatch(/\.z != 0\.0/);
      expect(vertex).toContain('/ 64.0'); // LED distance attenuation survived codegen
      expect(vertex).toContain('0.64 / pow'); // scattering survived too
      expect(fragment).not.toContain('0.64 / pow'); // no per-fragment scattering loop
    } finally {
      rooster.dispose();
      hull.dispose();
      setActiveBoatLightPool(previous);
    }
  });
});
