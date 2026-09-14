/** Run from the dev-server browser console with the live WebGPU renderer:
 * const { reviewRefraction } = await import('/docs/water-review/refraction-probe.js');
 * await reviewRefraction(__game.app.renderer);
 * Allocates independent probe state; does not change the scene or parameters.
 */
export async function reviewRefraction(renderer) {
  const N = await import('three/tsl');
  const T = await import('three/webgpu');
  const { refractionOffsetNode } = await import('/src/ocean/surfaceRefraction.ts');
  const normal = N.uniform(new T.Vector3());
  const view = N.uniform(new T.Matrix4());
  const viewport = N.uniform(new T.Vector2(1280, 800));
  const strength = N.uniform(0.02);
  const output = new T.StorageTexture(64, 1);
  output.type = T.FloatType;
  output.format = T.RGBAFormat;
  const pass = N.Fn(() => N.textureStore(output, N.ivec2(0, 0), N.vec4(
    refractionOffsetNode(normal, view, viewport, strength), 0, 1,
  )).toWriteOnly())().compute(1);
  const camera = new T.PerspectiveCamera(60, 1.6, 0.1, 1000);
  const baseNormal = new T.Vector3(0.3, Math.sqrt(0.9), -0.1);
  const rows = [];
  async function sample() {
    renderer.compute(pass);
    const data = await renderer.backend.copyTextureToBuffer(output, 0, 0, 64, 1, 0);
    return [data[0], data[1]];
  }
  try {
    camera.position.set(0, 10, 0);
    camera.up.set(0, 0, -1);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    view.value.copy(camera.matrixWorldInverse);
    normal.value.copy(baseNormal);
    const top = await sample();
    if (Math.abs(top[0] + 0.00375) > 1e-7 || Math.abs(top[1] - 0.002) > 1e-7) {
      throw new Error('Top-down refraction has wrong sign or scale');
    }
    rows.push({ case: 'top down', offset: top });
    normal.value.set(0, 1, 0);
    const flat = await sample();
    if (flat.some(value => value !== 0)) throw new Error('Flat water distorts');
    rows.push({ case: 'flat', offset: flat });
    let reference;
    for (const yaw of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) {
      const rotation = new T.Quaternion().setFromAxisAngle(new T.Vector3(0, 1, 0), yaw);
      camera.position.set(0, 10, 10).applyQuaternion(rotation);
      camera.up.set(0, 1, 0);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      view.value.copy(camera.matrixWorldInverse);
      normal.value.copy(baseNormal).applyQuaternion(rotation);
      const value = await sample();
      if (reference === undefined) reference = value;
      if (value.some((channel, i) => Math.abs(channel - reference[i]) > 1e-7)) {
        throw new Error('Joint camera/sea rotation changes refraction');
      }
      rows.push({ case: 'yaw', yaw, offset: value });
    }
    viewport.value.x = 640;
    const portrait = await sample();
    if (Math.abs(portrait[0] * 640 - reference[0] * 1280) > 1e-5 ||
        Math.abs(portrait[1] - reference[1]) > 1e-7) {
      throw new Error('Viewport aspect stretches refraction');
    }
    rows.push({ case: 'aspect', offset: portrait });
    return rows;
  } finally {
    output.dispose();
  }
}
