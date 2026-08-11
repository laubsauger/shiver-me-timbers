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
  instancedBufferAttribute,
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
    const puffs: CloudPuff[] = [];
    for (let i = 0; i < count; i++) {
      // point in unit disc; flat-ish bottom, domed top near the centre
      const a = rng() * Math.PI * 2;
      const r = Math.sqrt(rng());
      const lift = rng();
      const centrality = 1 - r;
      puffs.push({
        x: cx + Math.cos(a) * r * cr * p.clusterFlatten,
        y: cy + lift * lift * centrality * cr * 0.9,
        z: cz + Math.sin(a) * r * cr * p.clusterFlatten,
        radius:
          lerp(p.puffScaleMin, p.puffScaleMax, rng()) * (0.55 + 0.45 * centrality),
        seed: rng(),
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
  const scales = new Float32Array(n);
  const seeds = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const puff = puffs[i];
    offsets[i * 3 + 0] = puff.x;
    offsets[i * 3 + 1] = puff.y;
    offsets[i * 3 + 2] = puff.z;
    scales[i] = puff.radius * 2; // sprite geometry is a unit quad → diameter
    seeds[i] = puff.seed;
  }
  const offsetAttr = new THREE.InstancedBufferAttribute(offsets, 3);
  const scaleAttr = new THREE.InstancedBufferAttribute(scales, 1);
  const seedAttr = new THREE.InstancedBufferAttribute(seeds, 1);

  const uSunView = uniform(new THREE.Vector3(0, 1, 0));
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
  const sunlight = nrm.dot(uSunView).mul(0.5).add(0.5).pow(1.5);
  const skylight = nrm.dot(uUpView).mul(0.35).add(0.65);

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
