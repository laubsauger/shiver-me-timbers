/** Run in a Vite-served module with an initialized Three WebGPU renderer. */
export async function probeWaterVariance(renderer) {
  const THREE = await import('three/webgpu');
  const { uv, float, vec4 } = await import('three/tsl');
  const { unresolvedSlopeVarianceNode } = await import('../../src/ocean/surfaceFiltering.ts');
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  const amplitude = uv().x;
  material.outputNode = vec4(
    unresolvedSlopeVarianceNode(amplitude, float(0.5)),
    amplitude.mul(amplitude).mul(0.5),
    float(0.5),
    float(1),
  );
  const geometry = new THREE.PlaneGeometry(2, 2);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  scene.add(new THREE.Mesh(geometry, material));
  const target = new THREE.RenderTarget(64, 1, {
    type: THREE.FloatType, depthBuffer: false,
  });
  const previous = renderer.getRenderTarget();
  try {
    renderer.setRenderTarget(target);
    renderer.render(scene, camera);
    const data = await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, 64, 1, 0);
    let maxConservationError = 0;
    let maxFormulaError = 0;
    for (let i = 0; i < 64; i++) {
      const amplitude = (i + 0.5) / 64;
      maxConservationError = Math.max(
        maxConservationError, Math.abs(data[i * 4] + data[i * 4 + 1] - 0.5),
      );
      maxFormulaError = Math.max(
        maxFormulaError, Math.abs(data[i * 4] - (1 - amplitude * amplitude) * 0.5),
      );
    }
    return { samples: 64, maxConservationError, maxFormulaError };
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    material.dispose();
    geometry.dispose();
  }
}
