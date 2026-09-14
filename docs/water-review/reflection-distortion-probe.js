/** Run from the dev-server browser console with the live WebGPU renderer:
 * const { reviewReflectionDistortion } = await import('/docs/water-review/reflection-distortion-probe.js');
 * await reviewReflectionDistortion(__game.app.renderer);
 * Allocates independent probe state; does not change the scene or parameters.
 */
export async function reviewReflectionDistortion(renderer) {
  const N = await import('three/tsl');
  const T = await import('three/webgpu');
  const { reflectionDistortionNode } = await import('/src/reflection/reflectionShading.ts');
  const normal = N.uniform(new T.Vector3());
  const view = N.uniform(new T.Matrix4());
  const viewDirection = N.uniform(new T.Vector3());
  const viewport = N.uniform(new T.Vector2(1280, 800));
  const strength = N.uniform(0.02);
  const output = new T.StorageTexture(64, 1);
  output.type = T.FloatType;
  output.format = T.RGBAFormat;
  const pass = N.Fn(() => N.textureStore(output, N.ivec2(0, 0), N.vec4(
    reflectionDistortionNode(normal, viewDirection, view, viewport, strength), 0, 1,
  )).toWriteOnly())().compute(1);
  const camera = new T.PerspectiveCamera(60, 1.6, 0.1, 1000);
  const baseNormal = new T.Vector3(0.3, Math.sqrt(0.9), -0.1);
  const rows = [];
  async function sample() {
    viewDirection.value.copy(camera.position).normalize();
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
    if (Math.abs(top[0] + 0.00375 * Math.sqrt(0.9)) > 1e-7 || Math.abs(top[1] + 0.002 * Math.sqrt(0.9)) > 1e-7) {
      throw new Error('Top-down reflection distortion has wrong sign or scale');
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
        throw new Error('Joint camera/sea rotation changes reflection distortion');
      }
      rows.push({ case: 'yaw', yaw, offset: value });
    }
    viewport.value.x = 640;
    const portrait = await sample();
    if (Math.abs(portrait[0] * 640 - reference[0] * 1280) > 1e-5 ||
        Math.abs(portrait[1] - reference[1]) > 1e-7) {
      throw new Error('Viewport aspect stretches reflection distortion');
    }
    rows.push({ case: 'aspect', offset: portrait });
    viewport.value.set(1280, 800);
    normal.value.set(0, Math.sqrt(0.99), 0.1);
    for (const height of [100, 1]) {
      camera.position.set(0, height, 100);
      camera.lookAt(0, 0, 0);
      camera.updateMatrixWorld();
      view.value.copy(camera.matrixWorldInverse);
      const value = await sample();
      // A tilt in the view's vertical plane rotates the reflected ray by
      // twice the tilt, even when the view approaches the horizon.
      const expected = 0.02 * 0.1 * Math.sqrt(0.99);
      if (Math.abs(value[0]) > 1e-7 || Math.abs(value[1] - expected) > 1e-7) {
        throw new Error('Grazing view loses vertical reflection distortion');
      }
      rows.push({ case: 'pitch', height, offset: value });
    }
    return rows;
  } finally {
    output.dispose();
  }
}
