/** Run from a Vite-served module with an initialized WebGPU renderer. */
export async function probeSparkleMean(renderer) {
  const THREE = await import('three/webgpu');
  const { uv, uniform, float, smoothstep, vec4 } = await import('three/tsl');
  const { sparkleDiscMean } = await import('../../src/ocean/sparkleMath.ts');
  const radius = uniform(0.5);
  const expected = uniform(0);
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  const distance = uv().sub(0.5).length();
  material.outputNode = vec4(smoothstep(radius, float(0), distance), expected, 0, 1);
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  scene.add(new THREE.Mesh(geometry, material));
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const size = 512;
  const target = new THREE.RenderTarget(size, size, { type: THREE.FloatType, depthBuffer: false });
  const previous = renderer.getRenderTarget();
  const results = [];
  try {
    for (const value of [0.1, 0.8 / 2.6, 0.5, 0.6, Math.SQRT1_2, 1, 2.5]) {
      radius.value = value;
      expected.value = sparkleDiscMean(value);
      renderer.setRenderTarget(target);
      renderer.render(scene, camera);
      const data = await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, size, size, 0);
      let sum = 0;
      for (let i = 0; i < data.length; i += 4) sum += data[i];
      const measured = sum / (size * size);
      results.push({ radius: value, measured, expected: expected.value, error: Math.abs(measured - expected.value) });
    }
    return results;
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    geometry.dispose();
    material.dispose();
  }
}
