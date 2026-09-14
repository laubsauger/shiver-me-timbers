/** Run in a Vite-served module with an initialized Three WebGPU renderer. */
export async function probeReflectionSkyVisibility(renderer) {
  const THREE = await import('three/webgpu');
  const { uv, float, vec4 } = await import('three/tsl');
  const { reflectionSkyVisibilityNode } = await import('../../src/ocean/surfaceFiltering.ts');
  const material = new THREE.MeshBasicNodeMaterial();
  material.toneMapped = false;
  const height = uv().x.mul(2).sub(1);
  material.outputNode = vec4(
    reflectionSkyVisibilityNode(height, float(0.01), float(0)),
    reflectionSkyVisibilityNode(height, float(0), float(0.04)),
    reflectionSkyVisibilityNode(height.negate(), float(0), float(0.04)),
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
    let maxFormulaError = 0;
    let maxComplementError = 0;
    const smooth = (x, width) => {
      const t = Math.max(0, Math.min(1, (x + width) / (2 * width)));
      return t * t * (3 - 2 * t);
    };
    for (let i = 0; i < 64; i++) {
      const height = 2 * (i + 0.5) / 64 - 1;
      maxFormulaError = Math.max(maxFormulaError,
        Math.abs(data[i * 4] - smooth(height, 0.02)),
        Math.abs(data[i * 4 + 1] - smooth(height, 0.4)));
      maxComplementError = Math.max(maxComplementError,
        Math.abs(data[i * 4 + 1] + data[i * 4 + 2] - 1));
    }
    if (maxFormulaError > 1e-6 || maxComplementError > 1e-6) {
      throw new Error(`Sky visibility mismatch: ${maxFormulaError}, ${maxComplementError}`);
    }
    return { samples: 64, maxFormulaError, maxComplementError };
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose();
    material.dispose();
    geometry.dispose();
  }
}
