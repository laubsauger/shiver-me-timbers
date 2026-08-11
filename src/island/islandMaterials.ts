/**
 * Shared island material set (T33, §V17).
 *
 * Every island wants the same three shaders — the sand/rock blend (T27 + the
 * T33 swash), the stand-alone rock tint, and the wind-swayed palm. Building
 * them per island meant five copies of each node graph, five NodeBuilder runs
 * and five pipelines for shaders that differ in nothing. This builds ONE set
 * and hands it to every island.
 *
 * The one thing that genuinely wants to be per-island is the live water level
 * feeding the swash — and it does not have to be: the alongshore phase noise
 * in shoreRunup already decorrelates the beaches, the sea level differs
 * between islands by about a metre, and only the island you are anchored off
 * is close enough to read the swash at all. So the archipelago drives this
 * from the NEAREST island and the rest inherit it, which is both cheaper and
 * indistinguishable.
 */
import * as THREE from 'three/webgpu';
import { attribute } from 'three/tsl';
import { createRockMaterial, terrainBlendMaterial, type TerrainBlendMaterialHandle } from '../terrain';
import { applyWindSway, createPalmMaterial } from '../vegetation';
import type { WindSway } from '../vegetation/windSway';

export interface IslandMaterials {
  terrain: TerrainBlendMaterialHandle;
  rock: ReturnType<typeof createRockMaterial>;
  palm: ReturnType<typeof createPalmMaterial>;
  palmSway: WindSway;
  /**
   * Per-frame push for every shared shader. `waterLevel` is the live sea
   * height at the shore being looked at (§V8: same CpuOcean mirror buoyancy
   * samples), `swell` the swell amplitude (≈Hs/2 = `ocean.heightRms * 2`).
   */
  update(frame: {
    time: number;
    windDir: [number, number];
    windStrength: number;
    waterLevel: number;
    swell: number;
    sunDirection: THREE.Vector3;
  }): void;
  dispose(): void;
}

export function createIslandMaterials(): IslandMaterials {
  const terrain = terrainBlendMaterial();
  const rock = createRockMaterial();
  const palm = createPalmMaterial();
  const palmSway = applyWindSway(palm.material, {
    instancePhase: attribute('instancePhase', 'float'),
    amplitudeScale: attribute('instanceSway', 'float'),
  });

  return {
    terrain,
    rock,
    palm,
    palmSway,
    update(frame): void {
      palmSway.setWind(frame.time, frame.windDir, frame.windStrength);
      palmSway.syncParams();
      palm.refresh();
      (palm.uSunDirection.value as THREE.Vector3).copy(frame.sunDirection).normalize();
      // updateFromParams FIRST: it re-reads terrainParams.waterline (the
      // Tweakpane default), so the live sea level has to be pushed after it
      // or the panel value would win every frame
      terrain.updateFromParams();
      terrain.setSunDirection(frame.sunDirection);
      terrain.setTime(frame.time);
      terrain.setSwell(frame.swell);
      terrain.setWaterline(frame.waterLevel);
      rock.updateFromParams();
      (rock.uniforms.sunDirection.value as THREE.Vector3)
        .copy(frame.sunDirection)
        .normalize();
    },
    dispose(): void {
      terrain.dispose();
      rock.dispose();
      palm.material.dispose();
    },
  };
}
