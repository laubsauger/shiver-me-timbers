/** Run against an initialized WebGPU renderer. Compares equal foam doses at different ages. */
export async function probeFoamAge(renderer, baseline) {
  const T = await import('three/webgpu');
  const { float, uniform, uv, vec4 } = await import('three/tsl');
  const { foamDetailMask, updateFoamShadingUniforms } = await import('../../src/foam/foamShading.ts');
  const { foamDetailMask: beforeMask, updateFoamShadingUniforms: updateBefore } = baseline;
  const { foamParams } = await import('../../src/params/foam.ts');
  updateFoamShadingUniforms(foamParams, 0, 0);
  updateBefore(foamParams, 0, 0);
  const coverage = uniform(0.7), age = uniform(1);
  const coord = uv().mul(32);
  const material = new T.MeshBasicNodeMaterial();
  material.toneMapped = false;
  material.outputNode = vec4(
    beforeMask(coverage, coord, undefined, undefined, undefined, age),
    foamDetailMask(coverage, coord, undefined, undefined, undefined, age),
    float(0), float(1),
  );
  const geometry = new T.PlaneGeometry(2, 2);
  const scene = new T.Scene();
  scene.add(new T.Mesh(geometry, material));
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const size = 256;
  const target = new T.RenderTarget(size, size, { type: T.FloatType, depthBuffer: false });
  const previous = renderer.getRenderTarget();
  const results = [];
  try {
    for (const dose of [0, 0.2, 0.7]) {
      coverage.value = dose;
      for (const seconds of [0, 0.53, 1.06, 2.12]) {
        age.value = Math.exp(-seconds / 0.53);
        renderer.setRenderTarget(target);
        renderer.render(scene, camera);
        const data = await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, size, size, 0);
        let oldMean = 0, newMean = 0, meanDifference = 0;
        for (let i = 0; i < data.length; i += 4) {
          const a = data[i], b = data[i + 1];
          if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a > 1 || b > 1) {
            throw new Error(`Invalid foam coverage: ${a}, ${b}`);
          }
          oldMean += a; newMean += b; meanDifference += Math.abs(a - b);
        }
        results.push({ dose, seconds, oldMean: oldMean / (size * size), newMean: newMean / (size * size), meanDifference: meanDifference / (size * size) });
      }
    }
    if (results.filter(r => r.dose === 0).some(r => r.newMean !== 0)) throw new Error('Age creates foam on bare water');
    if (!results.some(r => r.dose === 0.7 && r.seconds > 1 && r.meanDifference > 0.01)) throw new Error('Measured age does not affect dense foam');
    if (results.some(r => r.oldMean > 0 && Math.abs(r.newMean / r.oldMean - 1) > 0.03)) throw new Error("Age changes mean coverage by more than 3%");
    return results;
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); geometry.dispose(); material.dispose();
  }
}
