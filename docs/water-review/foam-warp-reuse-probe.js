/** Compare shared and independently constructed warp in the real foam mask. */
export async function probe(renderer) {
  const T = await import('three/webgpu'), N = await import('three/tsl');
  const { foamWarpVec, foamDetailMask } = await import('/src/foam/foamShading.ts');
  const span = N.uniform(16), size = 128;
  const materials = [false, true].map(shared => {
    const material = new T.MeshBasicNodeMaterial();
    const coord = N.uv().mul(span).add(N.vec2(1200, -350));
    const warp = foamWarpVec(coord).toVar();
    const coverage = coord.add(warp).x.mul(0.3).sin().mul(0.45).add(0.5);
    const mask = foamDetailMask(coverage, coord, N.float(0.6), N.float(0.4), undefined,
      undefined, undefined, false, shared ? warp : undefined);
    material.outputNode = N.vec4(mask, warp, 1); material.toneMapped = false;
    return material;
  });
  const geometry = new T.PlaneGeometry(2, 2), scene = new T.Scene();
  const mesh = new T.Mesh(geometry, materials[0]); scene.add(mesh);
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 2;
  const target = new T.RenderTarget(size, size, {type:T.FloatType, depthBuffer:false});
  const previous = renderer.getRenderTarget(), results = [];
  try {
    renderer.setRenderTarget(target);
    for (const metres of [16, 256, 2048]) {
      span.value = metres;
      const arrays = [];
      for (const material of materials) {
        mesh.material = material; await renderer.renderAsync(scene, camera);
        arrays.push(await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, size, size, 0));
      }
      let maxDifference = 0, minMask = 1, maxMask = 0;
      for (let i = 0; i < arrays[0].length; i += 4) {
        minMask = Math.min(minMask, arrays[1][i]); maxMask = Math.max(maxMask, arrays[1][i]);
        for (let c = 0; c < 3; c++) maxDifference = Math.max(maxDifference, Math.abs(arrays[0][i+c]-arrays[1][i+c]));
      }
      if (maxDifference > 1e-4 || maxMask-minMask < 0.01) throw Error(JSON.stringify({metres,maxDifference,minMask,maxMask}));
      results.push({metresPerPixel:metres/size,maxDifference,minMask,maxMask});
    }
    return {size,results};
  } finally {
    renderer.setRenderTarget(previous); target.dispose(); geometry.dispose(); materials.forEach(m=>m.dispose());
  }
}
