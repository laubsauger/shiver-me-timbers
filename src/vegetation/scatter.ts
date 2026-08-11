/**
 * Palm scatter (T26). Deterministic per seed (§V2-adjacent: createRng only).
 * Placement generation is pure data — node-test-safe, no materials/GPU.
 *
 * Default distribution: palms grouped into clusters spaced around a ring
 * (beach-line look per the SoT refs). Per-instance variation:
 *   - position / yaw / lean / scale (incl. height stretch) → instance matrix
 *   - sway phase + sway amplitude jitter → instanced attributes
 *     `instancePhase`, `instanceSway` consumed by windSway.ts
 * Distribution tunables live in params/vegetation (§V16).
 */
import * as THREE from 'three/webgpu';
import { createRng, type Rng } from '../state/rng';
import { vegetationParams } from '../params/vegetation';

export interface PalmPlacement {
  position: [number, number, number];
  /** uniform scale */
  scale: number;
  /** yaw (rad) */
  rotation: number;
  /** tilt off vertical (rad) and its azimuth */
  lean: number;
  leanDirection: number;
  /** extra y stretch on top of uniform scale (height variation) */
  heightScale: number;
  /** per-instance sway phase + amplitude jitter (instanced attributes) */
  phase: number;
  swayScale: number;
}

export type PlacementFn = (rng: Rng) => Pick<PalmPlacement, 'position' | 'scale' | 'rotation'>;

/** default placement: clusters on a ring around the origin */
export const ringClusterPlacement: PlacementFn = (rng) => {
  const p = vegetationParams;
  const cluster = Math.floor(rng() * p.clusterCount);
  const angle = (cluster / p.clusterCount) * Math.PI * 2 + (rng() - 0.5) * (p.clusterSpread / Math.max(p.ringInner, 1));
  const dist = p.ringInner + (p.ringOuter - p.ringInner) * rng() * 0.5 + (rng() - 0.5) * p.clusterSpread;
  return {
    position: [Math.cos(angle) * dist, 0, Math.sin(angle) * dist],
    scale: p.scaleMin + (p.scaleMax - p.scaleMin) * rng(),
    rotation: rng() * Math.PI * 2,
  };
};

/** pure, deterministic placement list — same (count, seed, fn) → same output */
export function generatePlacements(
  count: number,
  seed: number,
  placementFn: PlacementFn = ringClusterPlacement,
): PalmPlacement[] {
  const p = vegetationParams;
  const rng = createRng(seed);
  const placements: PalmPlacement[] = [];
  for (let i = 0; i < count; i++) {
    const base = placementFn(rng);
    placements.push({
      ...base,
      lean: rng() * p.leanMax,
      leanDirection: rng() * Math.PI * 2,
      heightScale: 1 + (rng() * 2 - 1) * p.heightJitter,
      phase: rng() * Math.PI * 2,
      swayScale: 0.75 + rng() * 0.5,
    });
  }
  return placements;
}

export interface ScatterOptions {
  count: number;
  seed: number;
  /** shared palm geometry (buildPalmGeometry) — instanced attrs are added to it */
  geometry: THREE.BufferGeometry;
  /** material is optional so tests never need to construct one */
  material?: THREE.Material;
  placementFn?: PlacementFn;
  /**
   * Write instances largest-first (§V17). InstancedMesh.count truncates from
   * the END, so a distance LOD that lowers `count` then drops the smallest,
   * least readable palms first instead of a random subset. Sorting a
   * deterministic list stays deterministic (§V2).
   */
  lodSort?: boolean;
}

/** stable largest-first order used by the distance LOD (see ScatterOptions) */
export function sortForLod(placements: PalmPlacement[]): PalmPlacement[] {
  return placements
    .map((pl, i) => ({ pl, i }))
    .sort((a, b) => b.pl.scale * b.pl.heightScale - a.pl.scale * a.pl.heightScale || a.i - b.i)
    .map((e) => e.pl);
}

/**
 * Build the instanced palm mesh. Instance matrices carry position/yaw/lean/
 * scale; `instancePhase` + `instanceSway` instanced attributes carry the
 * shader-side variation for windSway.
 */
export function scatterPalms(opts: ScatterOptions): THREE.InstancedMesh {
  const generated = generatePlacements(opts.count, opts.seed, opts.placementFn);
  const placements = opts.lodSort ? sortForLod(generated) : generated;
  const mesh = new THREE.InstancedMesh(opts.geometry, opts.material, opts.count);

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const yawQ = new THREE.Quaternion();
  const leanQ = new THREE.Quaternion();
  const leanAxis = new THREE.Vector3();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  const phases = new Float32Array(opts.count);
  const sways = new Float32Array(opts.count);

  for (let i = 0; i < placements.length; i++) {
    const pl = placements[i];
    position.set(...pl.position);
    yawQ.setFromAxisAngle(up, pl.rotation);
    leanAxis.set(Math.cos(pl.leanDirection), 0, Math.sin(pl.leanDirection));
    leanQ.setFromAxisAngle(leanAxis, pl.lean);
    quat.copy(leanQ).multiply(yawQ);
    scale.set(pl.scale, pl.scale * pl.heightScale, pl.scale);
    matrix.compose(position, quat, scale);
    mesh.setMatrixAt(i, matrix);
    phases[i] = pl.phase;
    sways[i] = pl.swayScale;
  }
  mesh.instanceMatrix.needsUpdate = true;

  opts.geometry.setAttribute('instancePhase', new THREE.InstancedBufferAttribute(phases, 1));
  opts.geometry.setAttribute('instanceSway', new THREE.InstancedBufferAttribute(sways, 1));

  // vertices move in the wind shader; skip per-instance culling surprises
  mesh.frustumCulled = false;
  return mesh;
}
