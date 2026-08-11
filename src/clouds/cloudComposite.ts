/**
 * Cloud composite (§V11 stage 3): camera-pinned quad ~quadDistance out on the
 * frustum, sampling the blurred cloud texture via screenUV. Colour is
 * reconstructed as sunColor*R + skyColor*G with alpha from B; edges are
 * distorted + eroded by tileable 3D value noise sampled along the view
 * direction and scrolled by time (the "distortion cubemap" role from the Rare
 * talk — a wrap-repeat Data3DTexture stands in for the cubemap, generated
 * once at init from the seed).
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  positionWorld,
  screenUV,
  texture,
  texture3D,
  uniform,
  vec3,
} from 'three/tsl';
import { createRng } from '../state/rng';
import type { CloudParams } from '../params/clouds';

const NOISE_SIZE = 48;
const LATTICE = 8;

/** Tileable low-frequency RGB value noise, deterministic per seed. */
export function createNoiseTexture(seed: number): THREE.Data3DTexture {
  const rng = createRng(seed ^ 0x9e3779b9);
  const lat = new Float32Array(LATTICE * LATTICE * LATTICE * 3);
  for (let i = 0; i < lat.length; i++) lat[i] = rng();

  const latAt = (x: number, y: number, z: number, ch: number): number => {
    const xi = x % LATTICE;
    const yi = y % LATTICE;
    const zi = z % LATTICE;
    return lat[((zi * LATTICE + yi) * LATTICE + xi) * 3 + ch];
  };
  // trilinear-interpolated lattice lookup, wrapping for tileability
  const sample = (fx: number, fy: number, fz: number, ch: number): number => {
    const x0 = Math.floor(fx);
    const y0 = Math.floor(fy);
    const z0 = Math.floor(fz);
    const tx = fx - x0;
    const ty = fy - y0;
    const tz = fz - z0;
    let v = 0;
    for (let c = 0; c < 8; c++) {
      const cx = c & 1;
      const cy = (c >> 1) & 1;
      const cz = (c >> 2) & 1;
      const wgt =
        (cx ? tx : 1 - tx) * (cy ? ty : 1 - ty) * (cz ? tz : 1 - tz);
      v += wgt * latAt(x0 + cx, y0 + cy, z0 + cz, ch);
    }
    return v;
  };

  const data = new Uint8Array(NOISE_SIZE * NOISE_SIZE * NOISE_SIZE * 4);
  const freq = LATTICE / NOISE_SIZE;
  let o = 0;
  for (let z = 0; z < NOISE_SIZE; z++) {
    for (let y = 0; y < NOISE_SIZE; y++) {
      for (let x = 0; x < NOISE_SIZE; x++) {
        for (let ch = 0; ch < 3; ch++) {
          // two octaves of tileable value noise
          const n =
            sample(x * freq, y * freq, z * freq, ch) * 0.7 +
            sample(x * freq * 2, y * freq * 2, z * freq * 2, ch) * 0.3;
          data[o++] = Math.round(n * 255);
        }
        data[o++] = 255;
      }
    }
  }
  const tex = new THREE.Data3DTexture(data, NOISE_SIZE, NOISE_SIZE, NOISE_SIZE);
  tex.format = THREE.RGBAFormat;
  tex.type = THREE.UnsignedByteType;
  tex.wrapS = tex.wrapT = tex.wrapR = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export function createCloudComposite(
  blurred: THREE.Texture,
  p: CloudParams,
  seed: number,
) {
  const noiseTex = createNoiseTexture(seed);

  const uTime = uniform(0);
  const uSunColor = uniform(new THREE.Color(p.sunColor));
  const uSkyColor = uniform(new THREE.Color(p.skyColor));
  const uDistortScale = uniform(p.distortScale);
  const uDistortStrength = uniform(p.distortStrength);
  const uEdgeErode = uniform(p.edgeErode);
  const uAlphaGain = uniform(p.alphaGain);

  const material = new THREE.MeshBasicNodeMaterial();
  // scrolled view-direction noise lookup ("cubemap" role, see header)
  const viewDir = positionWorld.sub(cameraPosition).normalize();
  const scroll = vec3(uTime.mul(0.7), uTime.mul(0.43), uTime);
  const noise = texture3D(
    noiseTex,
    viewDir.mul(uDistortScale).mul(0.5).add(0.5).add(scroll),
    null,
  ).rgb;

  const packed = texture(blurred, screenUV.add(noise.xy.sub(0.5).mul(uDistortStrength)));
  const coverage = packed.b;
  const erode = noise.z.sub(0.5).mul(uEdgeErode);
  // channel/B recovers the weighted average from the premultiplied pack
  const denom = coverage.max(1e-4);
  material.colorNode = uSunColor
    .mul(packed.r.div(denom))
    .add(uSkyColor.mul(packed.g.div(denom)));
  material.opacityNode = coverage.add(erode.mul(coverage.oneMinus()))
    .mul(uAlphaGain)
    .clamp(0, 1);
  material.transparent = true;
  material.depthWrite = false;
  material.fog = false;

  const quad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), material);
  quad.frustumCulled = false;
  quad.renderOrder = 1000;

  return {
    quad,
    material,
    uTime,
    uSunColor,
    uSkyColor,
    uDistortScale,
    uDistortStrength,
    uEdgeErode,
    uAlphaGain,
    /** pin the quad to the camera frustum at quadDistance, covering the view */
    fitToCamera(camera: THREE.PerspectiveCamera): void {
      const d = p.quadDistance;
      const height = 2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov) * 0.5);
      const margin = 1.1; // oversize so distortion never reveals the border
      quad.scale.set(height * camera.aspect * margin, height * margin, 1);
      camera.getWorldPosition(quad.position);
      camera.getWorldQuaternion(quad.quaternion);
      quad.translateZ(-d);
    },
    dispose(): void {
      quad.geometry.dispose();
      material.dispose();
      noiseTex.dispose();
    },
  };
}

export type CloudComposite = ReturnType<typeof createCloudComposite>;
