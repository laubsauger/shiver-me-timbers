/** Actual flow-foam texture sampling: empty tiers must not change visible age. */
export async function probeWakeAgeHandover(renderer) {
  const T = await import('three/webgpu');
  const N = await import('three/tsl');
  const { createFlowFoam } = await import('../../src/flowfoam/index.ts');
  const { flowFoamParams } = await import('../../src/params/flowfoam.ts');
  const results = [];
  for (const scenario of ['near-only', 'far-only', 'far-disabled']) {
    const p = { ...flowFoamParams, resolution: 8, farResolution: 8, regionSize: 120,
      farRegionSize: 640, farStrength: scenario === 'far-disabled' ? 0 : 1 };
    const ff = createFlowFoam({ params: p, wakeBackend: 'sim' });
    const fresh = N.vec4(0.4, 0.4 * p.simSlickPerFoam, 0, 0);
    const empty = N.vec4(0, 0, 0, 0);
    const fill = N.Fn(() => {
      const xy = N.ivec2(N.int(N.instanceIndex.modInt(8)), N.int(N.instanceIndex.div(N.uint(8))));
      N.textureStore(ff.foamTexture, xy, scenario === 'far-only' ? empty : fresh).toWriteOnly();
      N.textureStore(ff.farFoamTexture, xy, scenario === 'near-only' ? empty : fresh).toWriteOnly();
    })().compute(64);
    const material = new T.MeshBasicNodeMaterial();
    material.toneMapped = false;
    // Exactly halfway through the near/far distance handover.
    const x = 120 * (p.farBlendStart + 0.5 * (1 - p.edgeFade)) / 2;
    const world = N.vec2(x, 0);
    material.outputNode = N.vec4(ff.wakeFoamFreshnessNode(world), ff.foamSampleNode(world), 0, 1);
    const geometry = new T.PlaneGeometry(2, 2), scene = new T.Scene();
    scene.add(new T.Mesh(geometry, material));
    const camera = new T.OrthographicCamera(-1, 1, 1, -1, 0.1, 10); camera.position.z = 2;
    const target = new T.RenderTarget(1, 1, { type: T.FloatType, depthBuffer: false });
    const previous = renderer.getRenderTarget();
    try {
      renderer.compute(fill);
      renderer.setRenderTarget(target); renderer.render(scene, camera);
      const data = await renderer.backend.copyTextureToBuffer(target.texture, 0, 0, 1, 1, 0);
      if (Math.abs(data[0] - 1) > 1e-6 || data[1] <= 0) throw new Error(`${scenario}: age ${data[0]}, coverage ${data[1]}`);
      results.push({ scenario, age: data[0], coverage: data[1] });
    } finally {
      renderer.setRenderTarget(previous); target.dispose(); material.dispose(); geometry.dispose(); ff.dispose();
    }
  }
  return results;
}
