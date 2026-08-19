/**
 * Ocean surface object (§V.4, §V.30): ONE camera-centered clipmap mesh whose
 * displaced sea reaches the horizon radius, sharing one TSL material.
 * Follows the camera in whole core-spacing steps so near vertices never swim.
 *
 * INTEGRATION (main thread owns the call):
 *   new OceanSurface(sim, foam, flowFoam, {
 *     sunLight: sky.sunLight,          // §V20 water receives sun shadows
 *     seabed: archipelago.seabed,      // §V24 shallows tint (optional)
 *     reflection,                      // §V26 planar reflections (optional)
 *     skyDomeColor: sky.skyDomeColor,  // §V26 THE reflected sky (optional)
 *   })
 *   surface.update(camera, time, sky.sunDirection)   // per frame
 * `sunLight` is optional but without it the water receives no sun shadows
 * (§V20 — the material is MeshBasicNodeMaterial on purpose, so receiveShadow
 * on the mesh does nothing; the shadow map is sampled inside the material).
 */
import * as THREE from 'three/webgpu';
import type { OceanSimulation } from './oceanCascades';
import type { FoamSim } from '../foam';
import type { FlowFoam } from '../flowfoam';
import { buildOceanSurfaceMaterial, type OceanSurfaceMaterial } from './surfaceMaterial';
import { buildOceanGrid, snapToGrid, type SurfaceGridOptions } from './surfaceGeometry';
import { oceanSurfaceParams as sp } from '../params/oceanSurface';
import { skyParams } from '../params/sky';
import { keyRadianceScale } from '../sky/lighting';
import type { SeabedField } from '../island/seabed';
import type { FetchField } from './fetchField';
import type { PlanarReflection } from '../reflection';
import { postParams } from '../params/post';

export interface OceanSurfaceOptions {
  /** the scene's sun — enables the in-material shadow sample (§V20) */
  sunLight?: THREE.DirectionalLight;
  /**
   * Seabed depth field from the archipelago (§V24 shallows tint). Absent →
   * the shallow term compiles out entirely and open ocean is unaffected.
   */
  seabed?: SeabedField | null;
  /**
   * Shelter field (§V.73 fetch). Absent → the fetch term compiles out entirely
   * and the sea is bit-identically the one it was, exactly like `seabed`.
   * §V.8: whatever is passed here MUST also be handed to `CpuOcean.setFetch`
   * and `Caustics.setFetchField`, or the drawn sea, the sea the hull floats on
   * and the sea the beach thinks it is drowned by are three different seas.
   */
  fetch?: FetchField | null;
  /**
   * Planar reflection (§V26). Absent → the analytic sky term is used, so this
   * is a no-op the main thread can wire whenever the perf picture allows.
   */
  reflection?: PlanarReflection | null;
  /**
   * The sky's radiance toward an arbitrary world direction, sun disc
   * EXCLUDED — `SkyHandle.skyDomeColor`. This IS the water's reflected sky
   * (§V.26): one implementation, shared with `scene.backgroundNode`, so the
   * sea reflects the real sky's azimuth instead of an elevation-only ramp.
   * Absent → the authored horizon→zenith fallback, no sun term.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node union
  skyDomeColor?: (dir: any) => any;
  /**
   * True when the scene is rendered into a HALF-FLOAT pass target rather than
   * straight to the canvas — i.e. when post-processing is on. The §V24
   * scene-colour copy has to be allocated in that format or WebGPU rejects
   * the copy every frame and the refraction silently reads nothing.
   * Defaults to `postParams.enabled` at construction time.
   */
  hdrSceneTarget?: boolean;
  /** grid override; defaults to the params values (reload to apply) */
  grid?: SurfaceGridOptions;
}

/** grid config from params — baked into geometry, so it is read once */
function gridFromParams(): SurfaceGridOptions {
  return {
    segments: sp.gridSegments,
    coreSpacing: sp.gridCoreSpacing,
    horizonRadius: sp.gridHorizonRadius,
    rimRound: sp.gridRimRound,
  };
}

export class OceanSurface {
  readonly group: THREE.Group;
  readonly mesh: THREE.Mesh;
  private sim: OceanSimulation;
  private sunLight: THREE.DirectionalLight | null;
  /** guards the one-shot warning below */
  private warnedHdrMismatch = false;
  private surface: OceanSurfaceMaterial;
  private grid: SurfaceGridOptions;

  constructor(
    sim: OceanSimulation,
    foam?: FoamSim,
    flowFoam?: FlowFoam,
    opts: OceanSurfaceOptions = {},
  ) {
    this.sim = sim;
    this.sunLight = opts.sunLight ?? null;
    this.grid = opts.grid ?? gridFromParams();
    this.surface = buildOceanSurfaceMaterial(
      sim,
      foam,
      flowFoam,
      this.grid,
      sp.shadowsEnabled ? opts.sunLight : undefined,
      opts.seabed,
      opts.reflection,
      opts.hdrSceneTarget ?? postParams.enabled,
      opts.skyDomeColor,
      opts.fetch,
    );
    this.group = new THREE.Group();
    this.mesh = new THREE.Mesh(buildOceanGrid(this.grid), this.surface.material);
    this.mesh.frustumCulled = false; // displaced verts break static bounds
    this.mesh.name = 'ocean-surface';
    this.group.add(this.mesh);
  }

  /** how far the displaced sea reaches (m) — camera far must exceed this */
  get horizonRadius(): number {
    return this.grid.horizonRadius;
  }

  /** per-frame: follow camera (snapped), advance shading time, sync params */
  update(camera: THREE.Camera, time: number, sunDirection?: THREE.Vector3): void {
    const [ox, oz] = snapToGrid(camera.position.x, camera.position.z, this.grid);
    this.group.position.set(ox, 0, oz);
    this.surface.originUniform.value.set(ox, oz);
    this.surface.timeUniform.value = time;
    // sea-state scale for the shading's crest thresholds — the sim recomputes
    // it whenever the spectrum is rebuilt, so weather changes carry through
    this.surface.seaRmsUniform.value = this.sim.heightRms;
    // normals must solve the same surface the vertices drew (§B storm fold)
    this.surface.choppinessUniform.value = this.sim.effectiveChoppiness();
    if (sunDirection) this.surface.sunDirectionUniform.value.copy(sunDirection);
    // Live key RADIANCE — colour x level, not colour alone (§V.72).
    //
    // THE LEVEL IS HALF OF IT AND IT USED TO BE MISSING. Every sun-driven water
    // term is tinted by this: the diffuse, the foam, the sparkle and the §V.75
    // glint road, whose unit bridge is READ OFF that diffuse so the two cannot
    // drift. Feed it a hue with no level and the bridge is exact but anchored
    // to the wrong irradiance — and after dark the key is the moon, whose hue
    // (moonColor, luminance 0.390) is 43% of a noon sun's while the moon
    // really keys at moonIntensity/sunIntensity = 0.22. So the water lit and
    // burned a road at ~2.5x the moon it was told about, which is the reported
    // "same size as what the sun is doing"; caustics/waterLighting.ts was
    // meanwhile computing the correct 0.22 from the same light. One expression
    // now, not two that disagree by 4.53x.
    //
    // §B.9/§V.31b: both operands are already LINEAR — `sunLight.color` is
    // written by sky/lighting.ts's setSrgb(), and the scale is a plain
    // radiance ratio — so this is a linear multiply with no transfer, which is
    // what a light level composed onto a light colour has to be.
    //
    // It is exactly 1 whenever the sun owns the key, so every daylight and
    // sunset framing is untouched by construction.
    if (this.sunLight) {
      this.surface.sunColorUniform.value
        .copy(this.sunLight.color)
        .multiplyScalar(keyRadianceScale(this.sunLight));
    }
    // §B.3: linearDepth() is normalized over the camera range — the material
    // needs the live far plane to turn it back into meters
    const persp = camera as THREE.PerspectiveCamera;
    if (persp.isPerspectiveCamera) this.surface.cameraFarUniform.value = persp.far;
    // haze target = the scene's fog colour (the sky rig retints it per frame),
    // so water and objects melt into the same horizon (§V30 — no seam where
    // the sea disc ends). With fog removed entirely, fall back to the sky's
    // horizon haze so the rim still lands on the dome's colour.
    const scene = this.group.parent as THREE.Scene | null;
    const fog = scene?.fog as THREE.Fog | THREE.FogExp2 | null | undefined;
    if (fog) this.surface.hazeColorUniform.value.copy(fog.color);
    else this.surface.hazeColorUniform.value.set(skyParams.horizonColor);
    // FAIL LOUD (user rule): the scene-colour copy format is baked into a GPU
    // texture at construction. If the render path flips between canvas and
    // post-processing afterwards, WebGPU silently refuses the copy every frame
    // and §V24 refraction reads an uninitialised texture — exactly the class
    // of bug that has cost this project seven silent no-ops. Say so, once.
    if (!this.warnedHdrMismatch && postParams.enabled !== this.surface.hdrSceneTarget) {
      this.warnedHdrMismatch = true;
      console.warn(
        '[ocean] scene-colour copy target was built for ' +
          (this.surface.hdrSceneTarget ? 'a half-float post pass' : 'the canvas') +
          ` but postParams.enabled is now ${postParams.enabled}. ` +
          'Water refraction (§V24) is reading a stale texture — reload to rebuild.',
      );
    }
    this.surface.updateFromParams();
  }
}
