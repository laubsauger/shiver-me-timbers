// Fragment-stage regression; supply the pre-filtering foamShading module URL.
export async function probe(renderer, baselineModuleUrl) {
  const T = await import('three/webgpu'), N = await import('three/tsl');
  const modules = await Promise.all([import(baselineModuleUrl), import('/src/foam/foamShading.ts')]);
  const size = 128, span = N.uniform(16), offset = N.uniform(0);
  const materials = modules.map(module => {
    const material = new T.MeshBasicNodeMaterial();
    material.outputNode = N.vec4(module.foamWarpVec(N.uv().mul(span).add(N.vec2(offset, 270))), 0, 1);
    material.toneMapped = false;
    return material;
  });
  const geometry = new T.PlaneGeometry(2, 2), scene = new T.Scene();
  const mesh = new T.Mesh(geometry, materials[0]); scene.add(mesh);
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 2;
  const target = new T.RenderTarget(size, size, { type: T.FloatType, depthBuffer: false });
  const previous = renderer.getRenderTarget(), results = [];
  try {
    renderer.setRenderTarget(target);
    for (const metres of [16, 256, 2048]) {
      span.value = metres;
      const arrays = [];
      for (const shift of [0, 0.25]) for (const material of materials) {
        offset.value = shift; mesh.material = material;
        await renderer.renderAsync(scene, camera);
        arrays.push(await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, size, size, 0));
      }
      let difference = 0, beforePeak = 0, afterPeak = 0, beforeMotion = 0, afterMotion = 0;
      for (let i = 0; i < arrays[0].length; i += 4) for (const c of [0, 1]) {
        difference = Math.max(difference, Math.abs(arrays[0][i+c] - arrays[1][i+c]));
        beforePeak = Math.max(beforePeak, Math.abs(arrays[0][i+c]));
        afterPeak = Math.max(afterPeak, Math.abs(arrays[1][i+c]));
        beforeMotion += Math.abs(arrays[0][i+c] - arrays[2][i+c]);
        afterMotion += Math.abs(arrays[1][i+c] - arrays[3][i+c]);
      }
      results.push({ metresPerPixel: metres / size, difference, beforePeak, afterPeak,
        beforeMotion: beforeMotion / (size*size*2), afterMotion: afterMotion / (size*size*2) });
    }
    if (results[0].difference > 1e-6) throw Error('Resolved foam warp changed');
    if (results[2].afterPeak > 1e-6 || results[2].beforePeak < 0.1) throw Error('Unresolved warp did not retire to zero');
    if (results[1].afterMotion >= results[1].beforeMotion) throw Error('Transition warp retained subpixel motion');
    return { size, results };
  } finally {
    renderer.setRenderTarget(previous); target.dispose(); geometry.dispose(); materials.forEach(m => m.dispose());
  }
}
