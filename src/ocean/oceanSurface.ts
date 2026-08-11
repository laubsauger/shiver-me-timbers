/**
 * Ocean surface object (§V.4): dense inner grid + horizon ring sharing one
 * displaced TSL material; follows the camera in whole grid steps.
 */
import * as THREE from 'three/webgpu';
import type { OceanSimulation } from './oceanCascades';
import { buildOceanSurfaceMaterial, type OceanSurfaceMaterial } from './surfaceMaterial';
import { buildHorizonRing, buildInnerGrid, snapToGrid, type SurfaceGridOptions } from './surfaceGeometry';

const DEFAULT_GRID: SurfaceGridOptions = {
  innerSize: 420,
  innerSegments: 512,
  horizonRadius: 4500,
  ringRadial: 24,
  ringAngular: 96,
};

export class OceanSurface {
  readonly group: THREE.Group;
  private surface: OceanSurfaceMaterial;
  private grid: SurfaceGridOptions;

  constructor(sim: OceanSimulation, grid: SurfaceGridOptions = DEFAULT_GRID) {
    this.grid = grid;
    this.surface = buildOceanSurfaceMaterial(sim);
    this.group = new THREE.Group();

    const inner = new THREE.Mesh(buildInnerGrid(grid), this.surface.material);
    inner.frustumCulled = false; // displaced verts break static bounds
    const ring = new THREE.Mesh(buildHorizonRing(grid), this.surface.material);
    ring.frustumCulled = false;
    this.group.add(inner, ring);
  }

  /** per-frame: follow camera (snapped), advance shading time, sync params */
  update(camera: THREE.Camera, time: number, sunDirection?: THREE.Vector3): void {
    const [ox, oz] = snapToGrid(camera.position.x, camera.position.z, this.grid);
    this.group.position.set(ox, 0, oz);
    this.surface.originUniform.value.set(ox, oz);
    this.surface.timeUniform.value = time;
    if (sunDirection) this.surface.sunDirectionUniform.value.copy(sunDirection);
    this.surface.updateFromParams();
  }
}
