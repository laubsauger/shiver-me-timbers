/**
 * Island rock outcrops (T20): icosahedra deformed by CPU noise, scattered on
 * the beach ring and waterline with T27's rockMaterial. Deterministic per
 * seed (§V2-adjacent: createRng only). Tunables in params/island.ts (§V16).
 *
 * T13 SOCKET (intersection foam, §V10): rocks that straddle the waterline are
 * tagged `mesh.userData.foamTarget = true`. T13's water-material depth-compare
 * pass should treat every scene mesh with that flag as an intersection-foam
 * target (foam ring where the hull/rock pierces the water). Nothing else is
 * built here — no foam RT, no depth mask.
 *
 * generateRockPlacements + deformRockGeometry are material-free so tests
 * verify placement/determinism without a renderer; createRocks assembles
 * meshes and (lazily-compiling) material.
 */
import * as THREE from 'three/webgpu';
import { createRng } from '../state/rng';
import { fbm2Cpu } from '../terrain/noiseCpu';
import { createRockMaterial, type RockMaterialHandle } from '../terrain';
import { islandParams, type IslandParams } from '../params/island';
import { findShoreRadius, type IslandHeightmap } from './heightmap';

export interface RockPlacement {
  /** island-local; y = terrain height + partial embed */
  position: [number, number, number];
  /** uniform xz scale (unit icosahedron radius 1 → rock radius ≈ scale) */
  scale: number;
  /** vertical squash: rock half-height ≈ scale × squash */
  squash: number;
  /** yaw (rad) */
  yaw: number;
  /** index into the shared deformed-geometry variants */
  variant: number;
  /** straddles the waterline → T13 intersection-foam target (§V10) */
  foamTarget: boolean;
}

/** pure, deterministic: same (seed, heightmap, params) → same placements */
export function generateRockPlacements(
  seed: number,
  hm: IslandHeightmap,
  p: IslandParams = islandParams,
): RockPlacement[] {
  const rng = createRng(seed);
  const placements: RockPlacement[] = [];
  for (let i = 0; i < p.rockCount; i++) {
    const angle = rng() * Math.PI * 2;
    const r = findShoreRadius(hm, angle) + (rng() * 2 - 1) * p.rockSpread;
    const x = Math.cos(angle) * r;
    const z = Math.sin(angle) * r;
    const scale = p.rockMinScale + (p.rockMaxScale - p.rockMinScale) * rng();
    const squash = p.rockSquashMin + (p.rockSquashMax - p.rockSquashMin) * rng();
    const yaw = rng() * Math.PI * 2;
    const variant = Math.floor(rng() * p.rockGeoVariants) % p.rockGeoVariants;
    const halfHeight = scale * squash;
    const y = hm.heightAt(x, z) + halfHeight * (1 - p.rockEmbed);
    // approximate: deformation perturbs the surface ±rockNoiseAmp, so the
    // straddle test uses the undeformed half-height (good enough for tagging)
    const foamTarget = y - halfHeight < 0 && y + halfHeight > 0;
    placements.push({ position: [x, y, z], scale, squash, yaw, variant, foamTarget });
  }
  return placements;
}

/**
 * Unit icosahedron with seeded per-vertex radial perturbation:
 * radius ×= 1 + (n − 0.5)·2·amp, n = mean of three axis-pair fbm projections
 * (position-hashed → crack-free across duplicated vertices).
 */
export function deformRockGeometry(
  seed: number,
  p: IslandParams = islandParams,
): THREE.BufferGeometry {
  const geometry = new THREE.IcosahedronGeometry(1, p.rockDetail);
  const rng = createRng(seed);
  const o = [rng() * 256, rng() * 256, rng() * 256, rng() * 256, rng() * 256, rng() * 256];
  const pos = geometry.getAttribute('position') as THREE.BufferAttribute;
  const f = p.rockNoiseFreq;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const n =
      (fbm2Cpu(x * f + o[0], y * f + o[1], p.rockNoiseOctaves) +
        fbm2Cpu(y * f + o[2], z * f + o[3], p.rockNoiseOctaves) +
        fbm2Cpu(z * f + o[4], x * f + o[5], p.rockNoiseOctaves)) /
      3;
    const k = 1 + (n * 2 - 1) * p.rockNoiseAmp;
    pos.setXYZ(i, x * k, y * k, z * k);
  }
  pos.needsUpdate = true;
  geometry.computeVertexNormals();
  return geometry;
}

export interface CreateRocksOptions {
  seed: number;
  heightmap: IslandHeightmap;
  /** inject a shared material (e.g. the island's); default creates its own */
  material?: THREE.Material;
}

export interface Rocks {
  group: THREE.Group;
  placements: RockPlacement[];
  /** meshes tagged userData.foamTarget — T13 intersection-foam targets */
  foamTargets: THREE.Object3D[];
  /** LOD hook (§V17): hide the whole outcrop set beyond the cull distance */
  setVisible(visible: boolean): void;
  /** push live Tweakpane rock-material edits (no-op if material injected) */
  updateFromParams(): void;
  dispose(): void;
}

/**
 * Assemble rock outcrops as ONE InstancedMesh per deformed geometry variant
 * (§V17: rockCount × islandCount separate meshes was rockCount draw calls per
 * island; instancing makes it rockGeoVariants). Instances of a variant share
 * the foam tag — the injection mask is a waterline height compare, so rocks
 * that sit clear of the water contribute nothing to it anyway (§V10).
 */
export function createRocks(opts: CreateRocksOptions): Rocks {
  const p = islandParams;
  const placements = generateRockPlacements(opts.seed, opts.heightmap, p);
  const variants: THREE.BufferGeometry[] = [];
  for (let v = 0; v < p.rockGeoVariants; v++) {
    variants.push(deformRockGeometry(opts.seed + 101 * (v + 1), p));
  }
  const ownMaterial: RockMaterialHandle | null = opts.material ? null : createRockMaterial();
  const material = opts.material ?? ownMaterial!.material;

  const group = new THREE.Group();
  group.name = 'island-rocks';
  const foamTargets: THREE.Object3D[] = [];

  const matrix = new THREE.Matrix4();
  const position = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);

  for (let v = 0; v < variants.length; v++) {
    const forVariant = placements.filter((pl) => pl.variant === v);
    if (forVariant.length === 0) continue;
    const mesh = new THREE.InstancedMesh(variants[v], material, forVariant.length);
    mesh.name = `island-rocks-${v}`;
    let straddles = false;
    for (let i = 0; i < forVariant.length; i++) {
      const pl = forVariant[i];
      position.set(...pl.position);
      quat.setFromAxisAngle(up, pl.yaw);
      scale.set(pl.scale, pl.scale * pl.squash, pl.scale);
      mesh.setMatrixAt(i, matrix.compose(position, quat, scale));
      straddles = straddles || pl.foamTarget;
    }
    mesh.instanceMatrix.needsUpdate = true;
    // instance matrices are baked, so the default unit-icosahedron bounds
    // would cull the whole batch the moment the origin leaves the frustum
    mesh.computeBoundingSphere();
    if (straddles) {
      mesh.userData.foamTarget = true; // T13 socket, §V10
      foamTargets.push(mesh);
    }
    group.add(mesh);
  }

  return {
    group,
    placements,
    foamTargets,
    setVisible(visible: boolean): void {
      group.visible = visible;
    },
    updateFromParams(): void {
      ownMaterial?.updateFromParams();
    },
    dispose(): void {
      for (const g of variants) g.dispose();
      for (const child of group.children) (child as THREE.InstancedMesh).dispose?.();
      ownMaterial?.dispose();
    },
  };
}
