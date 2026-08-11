/**
 * Cloud cores (§V11 stage 1): soft billboard puffs clustered into cumulus
 * shapes, forward-rendered into an offscreen RT with channel packing per
 * docs/clouds-channels.png — R=sunlight, G=skylight, B=alpha/coverage,
 * A=normalized depth. Channels are premultiplied by puff alpha and summed
 * with ONE/ONE blending, so the blur/composite stages recover weighted
 * averages as channel/B.
 *
 * Cluster generation is pure + seeded (§V2 determinism extends to seeded
 * visuals): no Math.random, no GPU side effects at import time.
 */
import * as THREE from 'three/webgpu';
import {
  float,
  instancedBufferAttribute,
  mix,
  uniform,
  uv,
  vec3,
  vec4,
  vertexStage,
  modelViewMatrix,
} from 'three/tsl';
import { createRng } from '../state/rng';
import type { CloudParams } from '../params/clouds';

export interface CloudPuff {
  x: number;
  y: number;
  z: number;
  /** billboard radius (m) */
  radius: number;
  /** per-puff deterministic variation, 0..1 */
  seed: number;
  /** normalized height inside the cluster, 0=base sheet 1=dome top */
  heightN: number;
  /** unit offset direction from cluster centre (sun-side gradient) */
  dirX: number;
  dirY: number;
  dirZ: number;
}

export interface CloudCluster {
  x: number;
  y: number;
  z: number;
  radius: number;
  puffs: CloudPuff[];
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Deterministic cumulus cluster layout: same seed → identical clusters.
 * Pure data, safe to import in node tests.
 */
export function generateClusters(seed: number, p: CloudParams): CloudCluster[] {
  const rng = createRng(seed);
  const clusters: CloudCluster[] = [];
  for (let c = 0; c < p.clusterCount; c++) {
    const angle = rng() * Math.PI * 2;
    const dist = lerp(p.ringInner, p.ringOuter, rng());
    const cx = Math.cos(angle) * dist;
    const cz = Math.sin(angle) * dist;
    const cy = lerp(p.altitudeMin, p.altitudeMax, rng());
    const cr = lerp(p.clusterRadiusMin, p.clusterRadiusMax, rng());
    const count = p.puffsMin + Math.floor(rng() * (p.puffsMax - p.puffsMin + 1));
    // cumulus silhouette: wide flat base sheet + smaller domed top puffs,
    // overall wider than tall (refs: docs/final-full-result.png)
    const horiz = cr * p.clusterFlatten;
    const vert = cr * 0.55;
    const baseCount = Math.max(1, Math.round(count * 0.55));
    const puffs: CloudPuff[] = [];
    for (let i = 0; i < count; i++) {
      const a = rng() * Math.PI * 2;
      let r: number;
      let yN: number;
      let sizeScale: number;
      if (i < baseCount) {
        // base layer: centre-biased disc (rng^0.7 packs puffs into one mass,
        // not a sparse ring), nearly flat, larger puffs toward centre
        r = Math.pow(rng(), 0.7);
        yN = rng() * 0.18;
        sizeScale = 0.8 + 0.3 * (1 - r);
      } else {
        // top layer: hemispherical dome, puffs shrink with height
        const h = rng();
        r = Math.pow(rng(), 0.7) * Math.sqrt(Math.max(0, 1 - h * h)) * 0.85;
        yN = 0.15 + 0.85 * h;
        sizeScale = 0.55 + 0.35 * (1 - h);
      }
      const px = Math.cos(a) * r * horiz;
      const py = yN * vert;
      const pz = Math.sin(a) * r * horiz;
      const len = Math.hypot(px, py, pz);
      // radius follows cluster size so big clusters read as one cohesive mass
      const sizeNorm = cr / 220;
      puffs.push({
        x: cx + px,
        y: cy + py,
        z: cz + pz,
        radius: lerp(p.puffScaleMin, p.puffScaleMax, rng()) * sizeScale * sizeNorm,
        seed: rng(),
        heightN: yN,
        dirX: len > 1e-6 ? px / len : 0,
        dirY: len > 1e-6 ? py / len : 1,
        dirZ: len > 1e-6 ? pz / len : 0,
      });
    }
    clusters.push({ x: cx, y: cy, z: cz, radius: cr, puffs });
  }
  return clusters;
}

/**
 * Instanced sprite batch writing the packed 4-channel core RT.
 * View-space light directions are uniforms updated per frame by index.ts.
 */
export function createCloudCores(clusters: CloudCluster[], p: CloudParams) {
  const puffs = clusters.flatMap((c) => c.puffs);
  const n = puffs.length;
  const offsets = new Float32Array(n * 3);
  const dirs = new Float32Array(n * 3);
  const scales = new Float32Array(n);
  const seeds = new Float32Array(n);
  const heights = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const puff = puffs[i];
    offsets[i * 3 + 0] = puff.x;
    offsets[i * 3 + 1] = puff.y;
    offsets[i * 3 + 2] = puff.z;
    dirs[i * 3 + 0] = puff.dirX;
    dirs[i * 3 + 1] = puff.dirY;
    dirs[i * 3 + 2] = puff.dirZ;
    scales[i] = puff.radius * 2; // sprite geometry is a unit quad → diameter
    seeds[i] = puff.seed;
    heights[i] = puff.heightN;
  }
  const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
  const dirAttr = new THREE.InstancedBufferAttribute(dirs, 3);
  const scaleAttr = new THREE.InstancedBufferAttribute(scales, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seeds, 1);
  const heightAttr = new THREE.InstancedBufferAttribute(heights, 1);

  const uSunView = uniform(new THREE.Vector3(0, 1, 0));
  const uSunWorld = uniform(new THREE.Vector3(0, 1, 0));
  const uUpView = uniform(new THREE.Vector3(0, 1, 0));
  const uCoverage = uniform(p.coverage);
  const uMaxDist = uniform(p.maxCloudDist);

  const material = new THREE.SpriteNodeMaterial();
  const offsetNode = instancedBufferAttribute(offsetAttr, 'vec3');
  material.positionNode = offsetNode;
  material.scaleNode = instancedBufferAttribute(scaleAttr, 'float');

  // soft round falloff on the billboard
  const q = uv().mul(2).sub(1);
  const r2 = q.dot(q);
  const shape = r2.oneMinus().max(0);
  const puffSeed = instancedBufferAttribute(seedAttr, 'float');
  const alpha = shape.pow(1.7).mul(puffSeed.mul(0.4).add(0.6)).mul(uCoverage);

  // fake sphere normal in view space → sun/sky lit amounts (wrap lighting)
  const nrm = vec3(q.x, q.y, shape.sqrt());
  // cluster-level gradient: puffs on the sun side of their cluster lit more
  const sunSide = instancedBufferAttribute(dirAttr, 'vec3')
    .dot(uSunWorld)
    .mul(0.5)
    .add(0.5);
  const sunlight = nrm
    .dot(uSunView)
    .mul(0.5)
    .add(0.5)
    .pow(2.0)
    .mul(sunSide.mul(0.8).add(0.5))
    .clamp(0, 1.2);
  // bases sit in self-shadow, dome tops face open sky — mix(a,b,t) functional
  // form per §V23 (receiver-chained mix reads receiver as factor)
  const puffHeight = instancedBufferAttribute(heightAttr, 'float');
  const skylight = nrm
    .dot(uUpView)
    .mul(0.2)
    .add(0.8)
    .mul(mix(float(0.5), float(1.1), puffHeight));

  // normalized view distance of the puff centre, computed per vertex
  const depthN = vertexStage(
    modelViewMatrix.mul(vec4(offsetNode, 1)).xyz.length().div(uMaxDist).clamp(0, 1),
  );

  // premultiplied pack: R=sun, G=sky, B=coverage, A=depth (all × alpha)
  material.outputNode = vec4(
    sunlight.mul(alpha),
    skylight.mul(alpha),
    alpha,
    depthN.mul(alpha),
  );
  material.transparent = true;
  material.blending = THREE.CustomBlending;
  material.blendEquation = THREE.AddEquation;
  material.blendSrc = THREE.OneFactor;
  material.blendDst = THREE.OneFactor;
  material.blendSrcAlpha = THREE.OneFactor;
  material.blendDstAlpha = THREE.OneFactor;
  material.depthTest = false;
  material.depthWrite = false;
  material.fog = false;

  const object = new THREE.Sprite(material as unknown as THREE.SpriteMaterial);
  object.count = n;
  object.frustumCulled = false;

  return {
    object,
    material,
    uSunView,
    uSunWorld,
    uUpView,
    uCoverage,
    uMaxDist,
    puffCount: n,
    dispose(): void {
      material.dispose();
    },
  };
}

export type CloudCores = ReturnType<typeof createCloudCores>;
