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
import {
  createCoverMeshMaterial,
  createRockMaterial,
  terrainBlendMaterial,
  type CoverMeshMaterial,
  type TerrainBlendMaterialHandle,
} from '../terrain';
import { applyWindSway, createPalmMaterial } from '../vegetation';
import type { WindSway } from '../vegetation/windSway';
import { createStructureMaterial } from './structures';
import type { ShipMaterialHandle } from '../ship/woodMaterial';
import { aerialOutputNode } from '../terrain/aerialPerspective';
import {
  createSierraRockMaterial,
  createSierraTerrainMaterial,
  type SierraRockMaterialHandle,
} from './sierraMaterial';
import { horizonMapFor } from './horizonMap';
import type { IslandHeightmap } from './heightmap';
import { createPineMaterialSet, type PineMaterialSet } from '../vegetation/pineScatter';

export interface IslandMaterials {
  terrain: TerrainBlendMaterialHandle;
  rock: ReturnType<typeof createRockMaterial>;
  palm: ReturnType<typeof createPalmMaterial>;
  palmSway: WindSway;
  /** grass + shrub instances — one shader for every tuft in the world (§V17) */
  cover: CoverMeshMaterial;
  /**
   * Jetties, piers and huts — the SHIP's timber (src/ship/woodMaterial.ts), so
   * a dock belongs to the same world as the galleon tied up alongside it by
   * construction rather than by two palettes being hand-matched. One handle for
   * every structure on every island (§V17).
   */
  structure: ShipMaterialHandle;
  /**
   * Granite + DG sand for the sierra families (§T.99, sierraMaterial.ts).
   * Built on first request — a pirate world never asks and never pays for
   * the node graph.
   *
   * §T.112a: ONE HANDLE PER SIERRA HEIGHTMAP, not per world. The horizon map
   * (sun self-shadow + sky AO) is a per-island texture and the material binds
   * it, so two islands cannot share a material object. They DO share the
   * program: the node graph is identical, only the texture binding differs,
   * and the WebGPU pipeline cache keys on the generated code. The cost is one
   * NodeBuilder run per sierra island (≈6 in the slice), not one per mesh.
   * Called without a heightmap it returns a horizon-less handle (tests, the
   * R0 path) that every caller without a heightmap shares.
   */
  sierraTerrain(hm?: IslandHeightmap): TerrainBlendMaterialHandle;
  /** granite boulders with the island's horizon map — same per-heightmap rule */
  sierraRock(hm?: IslandHeightmap): SierraRockMaterialHandle;
  /** pines/junipers/dead pines — same lazy rule, one shader world-wide */
  pines(): PineMaterialSet;
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
    /** atmosphere colour the terrain melts into (§V30) — `scene.fog.color` */
    hazeColor: THREE.Color;
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
  const cover = createCoverMeshMaterial();
  const structure = createStructureMaterial();

  // §B67 — EVERY island prop melts on the TERRAIN's aerial curve.
  //
  // THE DEFECT, measured against docs/raft2100/lookdev/R0/params.md: the far
  // island (~1.5 km) stayed sharp while the lookdev dragged `sky.fogNear/
  // fogFar` to 150/1400 m. It was not the LOD — both LOD levels are one mesh
  // with one material (islandMesh.ts `setLod` swaps geometry only). The
  // terrain reads the OCEAN's haze curve (`oceanSurface.hazeStart/End/Curve`,
  // 750/4600/^1.7 → 2% at 1.5 km) and sets `fog = false`, by design, so land
  // and sea agree at the shoreline (§V30, aerialPerspective.ts). But the
  // rocks, palms, ground cover and jetties were MeshStandardNodeMaterials on
  // scene fog — a different curve, the one the lookdev WAS dragging — so at
  // 0.75 km the props hazed (fog 48%) on terrain that did not (0%), and at
  // 1.5 km the props vanished into fog (100%) while the terrain stayed 2%
  // hazed: "the lagoon island is fully hazed, the far island is sharp brown".
  //
  // Cure at the cause: the props take the terrain's OWN aerial output node,
  // sharing its uniforms, so the whole island is one curve and one knob.
  // `fog = false` + `outputNode` are a pair (or they haze twice). The knob to
  // flatten the far plane is therefore `oceanSurface.hazeStart/hazeEnd/
  // hazeCurve` — which moves the sea too, which is the point.
  const aerial = terrain.uniforms.aerial;
  for (const m of [rock.material, palm.material, cover.material, structure.material]) {
    m.fog = false;
    m.outputNode = aerialOutputNode(aerial);
  }

  const sierraTerrains = new Map<IslandHeightmap | null, TerrainBlendMaterialHandle>();
  const sierraRocks = new Map<IslandHeightmap | null, SierraRockMaterialHandle>();
  let pines: PineMaterialSet | null = null;
  const getSierraTerrain = (hm?: IslandHeightmap): TerrainBlendMaterialHandle => {
    const key = hm ?? null;
    let h = sierraTerrains.get(key);
    if (!h) {
      h = createSierraTerrainMaterial(undefined, hm ? { horizon: horizonMapFor(hm) } : {});
      sierraTerrains.set(key, h);
    }
    return h;
  };
  const getSierraRock = (hm?: IslandHeightmap): SierraRockMaterialHandle => {
    const key = hm ?? null;
    let h = sierraRocks.get(key);
    if (!h) {
      h = createSierraRockMaterial(undefined, hm ? { horizon: horizonMapFor(hm) } : {});
      // same §B67 rule as the pirate rock: one haze curve per island
      h.material.fog = false;
      h.material.outputNode = aerialOutputNode(aerial);
      sierraRocks.set(key, h);
    }
    return h;
  };
  const getPines = (): PineMaterialSet => {
    if (!pines) {
      pines = createPineMaterialSet();
      // same §B67 rule as the palms: one haze curve per island
      pines.pine.material.fog = false;
      pines.pine.material.outputNode = aerialOutputNode(aerial);
    }
    return pines;
  };

  return {
    terrain,
    rock,
    palm,
    palmSway,
    cover,
    structure,
    sierraTerrain: getSierraTerrain,
    sierraRock: getSierraRock,
    pines: getPines,
    update(frame): void {
      for (const sierraTerrain of sierraTerrains.values()) {
        sierraTerrain.updateFromParams();
        sierraTerrain.setSunDirection(frame.sunDirection);
        sierraTerrain.setHazeColor(frame.hazeColor);
        sierraTerrain.setTime(frame.time);
        sierraTerrain.setSwell(frame.swell);
        sierraTerrain.setWaterline(frame.waterLevel);
      }
      for (const sierraRock of sierraRocks.values()) {
        sierraRock.updateFromParams();
        (sierraRock.uniforms.sunDirection.value as THREE.Vector3).copy(frame.sunDirection).normalize();
      }
      if (pines) {
        pines.sway.setWind(frame.time, frame.windDir, frame.windStrength);
        pines.sway.syncParams();
        pines.pine.refresh();
      }
      // the grass reads the SAME wind the palms and the sea do, so a gust
      // crosses the whole scene at once instead of each system having its own
      cover.setWind(frame.time, frame.windDir, frame.windStrength);
      cover.updateFromParams();
      palmSway.setWind(frame.time, frame.windDir, frame.windStrength);
      palmSway.syncParams();
      palm.refresh();
      (palm.uSunDirection.value as THREE.Vector3).copy(frame.sunDirection).normalize();
      // updateFromParams FIRST: it re-reads terrainParams.waterline (the
      // Tweakpane default), so the live sea level has to be pushed after it
      // or the panel value would win every frame
      terrain.updateFromParams();
      terrain.setSunDirection(frame.sunDirection);
      terrain.setHazeColor(frame.hazeColor);
      terrain.setTime(frame.time);
      terrain.setSwell(frame.swell);
      terrain.setWaterline(frame.waterLevel);
      rock.updateFromParams();
      (rock.uniforms.sunDirection.value as THREE.Vector3)
        .copy(frame.sunDirection)
        .normalize();
      // the docks track the SHIP's timber params, so one Tweakpane edit moves
      // the hull and the pier it is tied to together
      structure.refresh();
    },
    dispose(): void {
      for (const h of sierraTerrains.values()) h.dispose();
      for (const h of sierraRocks.values()) h.dispose();
      pines?.pine.material.dispose();
      terrain.dispose();
      rock.dispose();
      palm.material.dispose();
      cover.dispose();
      structure.material.dispose();
    },
  };
}
