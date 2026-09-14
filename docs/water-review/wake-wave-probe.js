/** Run on an initialized WebGPU renderer with the game loop paused. */
export async function probe(renderer) {
  const T = await import('three/webgpu');
  const N = await import('three/tsl');
  const { foamDetailMask } = await import('/src/foam/foamShading.ts');
  const width = 256, height = 128;
  const materials = [false, true].map(coupled => {
    const material = new T.MeshBasicNodeMaterial();
    material.outputNode = N.Fn(() => {
      const coord = N.uv().mul(N.vec2(24, 12));
      const lift = coord.x.mul(Math.PI / 12).sin();
      const mask = foamDetailMask(N.float(0.3), coord, undefined,
        coupled ? lift : undefined, undefined, N.float(0.8), N.float(0.8), true);
      return N.vec4(N.vec3(mask), 1);
    })();
    material.toneMapped = false;
    return material;
  });
  const geometry = new T.PlaneGeometry(2, 2), scene = new T.Scene();
  const mesh = new T.Mesh(geometry, materials[0]);
  scene.add(mesh);
  const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  camera.position.z = 2;
  const target = new T.RenderTarget(width, height, { type: T.FloatType, depthBuffer: false });
  const previous = renderer.getRenderTarget(), arrays = [];
  try {
    for (const material of materials) {
      mesh.material = material;
      renderer.setRenderTarget(target);
      await renderer.renderAsync(scene, camera);
      arrays.push(await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, width, height, 0));
    }
    let difference = 0, flatMean = 0, coupledMean = 0;
    for (let i = 0; i < arrays[0].length; i += 4) {
      const flat = arrays[0][i], coupled = arrays[1][i];
      if (!Number.isFinite(coupled) || coupled < 0 || coupled > 1) throw Error('Invalid wake mask');
      difference += Math.abs(flat - coupled);
      flatMean += flat; coupledMean += coupled;
    }
    const pixels = width * height;
    const result = { width, height, difference: difference / pixels,
      flatMean: flatMean / pixels, coupledMean: coupledMean / pixels };
    if (result.difference < 0.005) throw Error(`Wave coupling inactive: ${JSON.stringify(result)}`);
    if (Math.abs(result.flatMean - result.coupledMean) > 0.05) throw Error(`Coverage drift: ${JSON.stringify(result)}`);
    return result;
  } finally {
    renderer.setRenderTarget(previous);
    target.dispose(); geometry.dispose(); materials.forEach(material => material.dispose());
  }
}
