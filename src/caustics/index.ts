/**
 * Caustics + water lighting entry (§T.32, §V.34).
 *
 * WHAT THIS IS: one TSL hook that any material can multiply/add in to become
 * an object that is visibly IN the sea — caustics from the live FFT surface,
 * bounce fill off the water, a drying wetline, and depth absorption.
 * It adds NO render pass and NO compute pass: everything is evaluated in the
 * receiver's own fragment shader from the ocean's existing derivative and
 * displacement textures, so the cost scales with what the receivers actually
 * cover on screen (§V.17).
 *
 * INTEGRATION (main thread owns the wiring — receivers never construct this):
 *
 *   // once, BEFORE any receiver material is built (TSL graphs are baked at
 *   // material construction, so a late bind silently leaves them neutral):
 *   const water = createCaustics(oceanSim, { sunLight: sky.sunLight });
 *   setActiveCaustics(water);
 *
 *   // optional hull drying memory, once the ship exists. bowZ/sternZ come
 *   // straight off sea-physics' HullWaterline, so the two agree by
 *   // construction:
 *   const wetline = water.attachHullWetline({ bowZ, sternZ });
 *
 *   // per frame, after ocean.update() and after hullContact.update():
 *   water.update(sky.sunDirection);
 *   wetline.updateFromHullContact(dt, hullContact.stations, hullContact.depth);
 *
 * RECEIVER SIDE (ship / terrain / island materials, one call, three slots):
 *
 *   const w = waterLighting({ worldPos, normal, shipLocalPos, mode });
 *   material.colorNode     = albedo.mul(w.tint);        // wet + absorption
 *   material.emissiveNode  = w.addLight;                // bounce + caustics
 *   material.roughnessNode = roughness.mul(w.roughnessScale);
 *   // and, if the material builds bump/normal relief:
 *   relief = relief.mul(w.reliefScale);
 *
 * Every output MODULATES the receiver's own material — none of it replaces
 * the receiver's albedo, grain, or relief work.
 */
import type * as THREE from 'three/webgpu';
import { float, vec2, vec3 } from 'three/tsl';
import type { OceanSimulation } from '../ocean/oceanCascades';
import { fetchFieldSampleNode, type FetchField } from '../ocean/fetchField';
import { developmentRatioNode, fetchBandGainNode } from '../ocean/fetch';
import { swellShadowGainNode } from '../ocean/swellShadow';
import { causticsParams } from '../params/caustics';
import {
  createCausticsUniforms,
  createShoalingUniforms,
  refreshCausticsUniforms,
  refreshShoalingUniforms,
  waterHeightNode,
  type CausticsUniforms,
  type ShoalingUniforms,
  type TslNode,
} from './causticsNode';
import {
  createWaterLightingUniforms,
  refreshWaterLightingUniforms,
  waterLightingNode,
  type WaterLighting,
  type WaterLightingUniforms,
  type WaterReceiver,
} from './waterLighting';
import { HullWetline, type HullWetlineOptions } from './hullWetline';

export { causticsParams } from '../params/caustics';
export { HullWetline, dryStep } from './hullWetline';
export type { HullWetlineOptions, WetlineStation } from './hullWetline';
export { waterHeightNode } from './causticsNode';
export type { WaterLighting, WaterReceiver } from './waterLighting';

export interface CausticsOptions {
  /**
   * the scene's sun. Used ONLY to reuse an already-published
   * `sunLight.shadow.shadowNode` (the ocean publishes it) — this module never
   * builds a second ShadowNode, so the shadow map still renders once (§V.17).
   */
  sunLight?: THREE.DirectionalLight;
}

export class Caustics {
  readonly sim: OceanSimulation;
  /**
   * The live tunables (§V.16), reachable as `__game.caustics.params` in the
   * console. Writing a UNIFORM directly does not stick — `update()` re-pushes
   * every param into the uniforms each frame, so a console poke is silently
   * reverted on the next tick. Write this instead:
   *   __game.caustics.params.strength = 3
   * `enabled` is the exception: it is read when receiver materials are BUILT,
   * so toggling it at runtime does nothing and an A/B needs a reload.
   */
  readonly params = causticsParams;
  readonly caustics: CausticsUniforms;
  readonly lighting: WaterLightingUniforms;
  /** §V.72 — see `waterHeight`; refreshed from the spectrum every frame */
  readonly shoaling: ShoalingUniforms;
  wetline?: HullWetline;
  private wetlineSpan?: TslNode;
  private sunLight?: THREE.DirectionalLight;
  /**
   * Seabed open-ocean depth (m, positive). Zero until `setSeabedOpenDepth`,
   * which main.ts calls once the archipelago exists — the seabed field is
   * built INSIDE createArchipelago, and receiver materials are baked in there
   * too, so this cannot be a constructor argument. It only feeds a uniform,
   * so arriving after the graph is built is fine (§V.62: it is pushed every
   * frame by `update()`, not once).
   */
  private openDepth = 0;
  /**
   * §V.73 — the shelter field the sea is fetch-limited by. Wired the same way
   * and at the same moment as `openDepth`: it is built from the seabed, which
   * is built inside `createArchipelago`, long after this object exists.
   * Absent → the fetch term folds away and receivers reconstruct the
   * shoaling-only sea, exactly as they did before.
   */
  private fetchField: FetchField | null = null;
  private wakeElevation: ((worldXZ: TslNode) => TslNode) | null = null;

  constructor(sim: OceanSimulation, opts: CausticsOptions = {}) {
    this.sim = sim;
    this.sunLight = opts.sunLight;
    this.caustics = createCausticsUniforms();
    this.lighting = createWaterLightingUniforms();
    this.shoaling = createShoalingUniforms(sim);
  }

  /**
   * The depth the shoaling law is compressed against — `SeabedField.openHeight`
   * negated, the SAME number surfaceMaterial and CpuOcean use. All three call
   * `shoalWavenumber()` with it, so the three shoal identically (§V.72).
   */
  setSeabedOpenDepth(openDepth: number): void {
    this.openDepth = Math.max(openDepth, 0);
  }

  /**
   * §V.73 — THE SAME shelter field the ocean material and `CpuOcean` were
   * handed. Three consumers, one field, one law; anything else and the beach
   * is drowned by a sea nobody draws (f62e037).
   */
  setFetchField(field: FetchField | null): void {
    this.fetchField = field;
  }

  /** the sun shadow node the ocean already published, or undefined */
  private sharedShadow(): TslNode | undefined {
    const slot = this.sunLight?.shadow as unknown as { shadowNode?: TslNode } | undefined;
    return slot?.shadowNode;
  }

  /**
   * B125 — the wake elevation the ocean draws, by world XZ (flowfoam `wakeHeightNode`). Floating receivers built AFTER
   * this measure their depth below the drawn sea, so the hull under her own mound is shaded as hull under water (in the
   * refraction and in the mirror). +1 texture +1 sampler on those materials (§V.40, shipBindingBudget).
   */
  attachWakeElevation(node: ((worldXZ: TslNode) => TslNode) | null): void {
    this.wakeElevation = node;
  }

  /** hull drying memory ("where the water lapped") — one per ship */
  attachHullWetline(opts: HullWetlineOptions): HullWetline {
    const w = new HullWetline(opts);
    this.wetline = w;
    // baked, not a uniform: the hull's stem/transom offsets do not move
    this.wetlineSpan = vec2(w.sternZ, 1 / (w.bowZ - w.sternZ));
    return w;
  }

  /** build the shading nodes for one receiver */
  node(r: WaterReceiver): WaterLighting {
    return waterLightingNode(
      {
        sim: this.sim,
        caustics: this.caustics,
        lighting: this.lighting,
        wetline: this.wetline,
        wetlineSpan: this.wetlineSpan,
        wakeElevation: this.wakeElevation ?? undefined,
      },
      { ...r, shadow: r.shadow ?? this.sharedShadow() },
    );
  }

  /**
   * World Y of the sea at a world XZ — receivers that only need depth.
   *
   * PASS `depth` IF YOU ARE THE SEABED. Without it this returns the raw
   * open-ocean spectrum, which is not the height the ocean draws anywhere
   * shallow: see `waterHeightNode`'s docstring for the measured 1.9 m
   * disagreement at a waterline and the two symptoms it produced.
   */
  waterHeight(worldXZ: TslNode, depth?: TslNode): TslNode {
    return this.waterSurface(worldXZ, depth).height;
  }

  /** One shelter sample serves actual water height (RG) and shore exposure (BA). */
  waterSurface(worldXZ: TslNode, depth?: TslNode): { height: TslNode; shoreGain: TslNode } {
    // sampled HERE rather than asked of the caller: every receiver already
    // hands us its world XZ, and making the shelter lookup the caller's job is
    // how one of them ends up forgetting it. ONE sample node: `.r` fetch and
    // `.g` swell shadow (T174) cost one texture fetch and one binding.
    const shelter = depth && this.fetchField ? fetchFieldSampleNode(this.fetchField, worldXZ) : null;
    let shoreGain: TslNode = float(1);
    if (shelter) {
      const ratio = developmentRatioNode(shelter.b, this.shoaling.fetchFull);
      let energy: TslNode = float(0), total: TslNode = float(0);
      for (let i = 0; i < this.shoaling.sigma.length; i++) {
        const variance = this.shoaling.sigma[i].pow(2);
        const gain = fetchBandGainNode(this.shoaling.fetchC[i], ratio, this.shoaling.fetchMaxGain)
          .mul(swellShadowGainNode(this.shoaling.swellShare[i], shelter.a));
        energy = energy.add(variance.mul(gain.pow(2)));
        total = total.add(variance);
      }
      // No depth damping here: this is incoming offshore energy, not wave
      // height evaluated on dry land. The swash model owns the runup.
      shoreGain = energy.div(total.max(1e-12)).max(0).sqrt();
    }
    const height = waterHeightNode(
      this.sim,
      worldXZ,
      depth
        ? {
            u: this.shoaling,
            depth,
            fetch: shelter ? shelter.r : null,
            swellK: shelter ? shelter.g : null,
          }
        : undefined,
    );
    return { height, shoreGain };
  }

  /** per frame, after the ocean sim updates */
  update(sunDirection: THREE.Vector3): void {
    (this.caustics.sunDirection.value as THREE.Vector3).copy(sunDirection);
    refreshCausticsUniforms(this.caustics);
    // THE KEY, not just its shadow. `sunLight` was already held here and read
    // for exactly one thing (`sharedShadow()`), so the caustic — refracted
    // sunlight — burned at its authored noon colour and brightness at midnight
    // (§B.41's shape, second file). moonCycle re-aims this same light after
    // dark, so passing it hands the caustic the moon for free.
    refreshWaterLightingUniforms(this.lighting, this.sunLight);
    // §V.62: every tick, not only on rebuild — `shoalDeepFraction` and the
    // seabed's open depth are not spectrum params and would never move
    refreshShoalingUniforms(this.shoaling, this.sim, this.openDepth);
  }
}

export function createCaustics(sim: OceanSimulation, opts?: CausticsOptions): Caustics {
  return new Caustics(sim, opts);
}

let active: Caustics | undefined;
let warned = false;

/** main.ts binds the instance so receiver materials can stay decoupled */
export function setActiveCaustics(c: Caustics | undefined): void {
  active = c;
}

export function activeCaustics(): Caustics | undefined {
  return active;
}

/** neutral result — every field is the identity for its material slot */
function neutral(depth: TslNode): WaterLighting {
  return {
    attenuation: vec3(1, 1, 1),
    tint: vec3(1, 1, 1),
    addLight: vec3(0, 0, 0),
    roughnessScale: float(1),
    reliefScale: float(1),
    caustics: vec3(0, 0, 0),
    causticDarken: float(1),
    wet: float(0),
    submerged: float(0),
    depth,
  };
}

/**
 * The receiver-facing call. Safe before `setActiveCaustics` and safe with
 * `causticsParams.enabled = false` — it returns identity nodes that fold
 * away at compile time.
 *
 * §Rule 8 (fail loud): binding AFTER a material is built is silent visually
 * but not silent in the console, because TSL bakes the graph at construction
 * and that material can never get caustics without a rebuild.
 */
export function waterLighting(r: WaterReceiver): WaterLighting {
  if (!causticsParams.enabled) return neutral(float(0));
  if (!active) {
    if (!warned) {
      warned = true;
      console.warn(
        '[caustics] waterLighting() called before setActiveCaustics() — this ' +
        'material is baked WITHOUT caustics/wetness and needs a rebuild to get ' +
        'them. Bind Caustics before constructing receiver materials.',
      );
    }
    return neutral(float(0));
  }
  return active.node(r);
}
