/**
 * GPU texture construction for the ocean FFT pipeline (§V.4).
 * All simulation data lives in StorageTextures written by compute passes.
 */
import * as THREE from 'three/webgpu';

export function createDataTexture(
  data: Float32Array,
  width: number,
  height: number,
): THREE.DataTexture {
  const tex = new THREE.DataTexture(
    data,
    width,
    height,
    THREE.RGBAFormat,
    THREE.FloatType,
  );
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

/** rgba32f storage texture for spectrum ping-pong (exact intermediate math) */
export function createSpectrumTexture(n: number): THREE.StorageTexture {
  const tex = new THREE.StorageTexture(n, n);
  tex.type = THREE.FloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  return tex;
}

/** tiling output texture (displacement / derivatives), sampled by materials */
export function createOutputTexture(n: number): THREE.StorageTexture {
  const tex = new THREE.StorageTexture(n, n);
  tex.type = THREE.FloatType;
  tex.format = THREE.RGBAFormat;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.generateMipmaps = false;
  return tex;
}
