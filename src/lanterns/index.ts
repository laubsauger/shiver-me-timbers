/**
 * Practical lights: swinging ship's lanterns (§V13 fixtures, §V16 params).
 *
 * Integration surface:
 *
 *   const lanterns = createLanterns({ scene, ids: ['stern-port', 'stern-stbd'] });
 *   lanterns.step('stern-port', { pivot, quaternion, velocity }, SIM_DT);  // sim tick
 *   lanterns.sync(nightFactor);                                           // render
 *   lanterns.dispose();
 *
 * ── THE ONE RULE THAT MATTERS: NEVER ADD OR REMOVE A LIGHT ─────────────
 * three r180 folds the scene's LIGHT SET into the dynamic cache key of every
 * render object (`RenderObject.getDynamicCacheKey` → `Nodes.getCacheKey` →
 * `LightsNode.customCacheKey`, which hashes each light's id and castShadow
 * flag). That key gates `needsUpdate`, so adding or removing ONE PointLight
 * invalidates and recompiles the node graph, WGSL and pipeline of EVERY
 * material in the scene — the ocean included, which is the widest shader in
 * the project and the reason `src/core/compileProfile.ts` exists (§T40: 58 s
 * cold boot, 52 s of it shader compilation).
 *
 * So the lights are created ONCE, here, at boot, and live for the process.
 * "Off" is `intensity = 0`, never `scene.remove()`. Moving them and
 * recolouring them is free — position, colour, intensity and decay are plain
 * `renderGroup` uniforms and are NOT in the cache key.
 *
 * ── WHY THEY DO NOT CAST SHADOWS ───────────────────────────────────────
 * A swinging light casting swinging shadows is most of the effect, and it was
 * measured rather than assumed. In this renderer a shadow-casting point light
 * is `PointShadowNode`, which is not a cube map: `PointLightShadow` sets
 * `_frameExtents = (4,2)` with `_viewportCount = 6` and `renderShadow()`
 * calls `renderer.render(scene, shadow.camera)` SIX TIMES, once per face,
 * every frame. Against §V17's 8 ms render budget — of which the ocean alone
 * measures 7.1 ms (§B.25) — six extra full scene passes per lantern is not a
 * trade-off, it is the whole frame. It also binds 2 textures + 2 samplers
 * into every lit material's fragment stage.
 *
 * `castShadow = false` is therefore deliberate and load-bearing, not an
 * oversight. If shadowed practicals are ever wanted, the affordable shape is
 * ONE spot light aimed down (a single pass, not six), not a point light.
 *
 * ── WHAT THEY LIGHT, AND WHAT THEY DO NOT ──────────────────────────────
 * Everything on `MeshStandardNodeMaterial` picks these up for free, because
 * `PhysicalLightingModel` implements `direct()`: the hull and deck, ropes,
 * ratlines, blocks, sails, flags, fittings, the island, rocks, palms and
 * cannonballs.
 *
 * THE WATER DOES NOT, and this is the honest gap. `src/ocean/surfaceMaterial.ts`
 * is a `MeshBasicNodeMaterial`, and `BasicLightingModel` has no `direct()` at
 * all — the light node is built and then handed to a no-op, so a lantern's
 * pool of light beside the hull does not exist. Giving the sea one needs a
 * hand-written term inside that material, which has another owner and sits at
 * 16/16 samplers (§V40). It costs no binding — a punctual light is four
 * uniforms, not a texture — but it is not this module's to write.
 */
import * as THREE from 'three/webgpu';
import { float, mix, normalView, positionViewDirection, uniform, vec3 } from 'three/tsl';
// side-effect import: registering the params module is what puts it in the
// Tweakpane panel at all (§B.18 — clouds shipped unregistered and every
// cloud value in every weather preset silently never applied)
import { lanternParams, type LanternParams } from '../params/lanterns';
import {
  createLanternState,
  flickerLevel,
  hangVector,
  stepPendulum,
  type LanternState,
  type Quat,
  type Vec3,
} from './pendulum';

/**
 * What the pendulum is driven by, per SIM TICK. Both fields are SimState
 * channels read straight off the ship — no matrices, no interpolation — so
 * the swing advances on exact sim data at a fixed dt (§V2).
 *
 * The hook's world POSITION is deliberately absent: it is only needed to
 * place the result, and placement happens at render time against the
 * INTERPOLATED pose (`place()` below). Driving the physics off the
 * interpolated pose instead would feed the ODE a signal that moves at the
 * display rate, which is neither deterministic nor the sea.
 */
export interface LanternDrive {
  /** ship orientation (unit quaternion, xyzw) */
  quaternion: Quat;
  /** ship world linear velocity — differenced here into the drive accel */
  velocity: Vec3;
}

interface Lantern {
  id: string;
  state: LanternState;
  light: THREE.PointLight;
  bulb: THREE.Mesh;
  material: THREE.MeshBasicNodeMaterial;
  uLevel: { value: number };
  uColor: { value: THREE.Color };
  /** previous velocity, for the single first difference that drives the swing */
  prevVelocity: Vec3 | null;
  /** last solved world position of the flame */
  position: THREE.Vector3;
}

export interface LanternOptions {
  scene: THREE.Scene;
  /** stable ids; also the flicker seed, so two lanterns never pulse together */
  ids: string[];
  params?: LanternParams;
}

/** cheap stable string → number, so a seed survives a rename predictably */
function seedOf(id: string, index: number): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return ((h >>> 0) % 10007) / 10007 + index * 0.618;
}

export function createLanterns(opts: LanternOptions) {
  const p = opts.params ?? lanternParams;
  const scene = opts.scene;
  const geometry = new THREE.SphereGeometry(1, 12, 8);
  const lanterns: Lantern[] = [];

  opts.ids.forEach((id, i) => {
    const uLevelNode = uniform(0);
    const uColorNode = uniform(new THREE.Color());
    const material = new THREE.MeshBasicNodeMaterial();
    // The flame is a SOURCE: it is the one thing here you look at rather than
    // look by, so its own pixels must not be shaded by the scene. colorNode
    // owns them outright. §V44: `uLevel` is bounded in flickerLevel() and by
    // the params' own range, so nothing unbounded reaches the frame.
    //
    // ── WHY THE FACING TERM, AND WHY IT IS NOT DECORATION ────────────────
    // A flat `color × level` over a sphere is CONSTANT across the whole disc,
    // and at `emissive` 2.4 every channel of 0xffaa7c clears 1.0 in the linear
    // working space — (2.4, 0.90, 0.49) — so the tonemapper lands the entire
    // silhouette on one cream value with a hard edge. That is not a lamp, it
    // is a cut-out circle, and it is what the user photographed
    // (docs/bugs/bug-lantern-spheres.png): "large flat cream-white DISCS".
    //
    // Falling the limb off restores BOTH things a flame has: a small hot core
    // that does clip to white, and a limb that stays amber because 0.22 × 2.4
    // = 0.53 is under the knee. The silhouette softens as a side effect —
    // nothing is being drawn at the edge but the sky's own value.
    //
    // §V23: functional `mix(a, b, t)`. `facing.pow()` is chained and the
    // receiver IS the base, which is the reading that form has.
    // §V44: the factor is bounded [0.22, 1] by construction, so the product
    // with an already-bounded level cannot grow.
    const facing = positionViewDirection.dot(normalView).clamp(0, 1);
    material.colorNode = vec3(uColorNode)
      .mul(uLevelNode)
      .mul(mix(float(0.22), float(1), facing.pow(0.5)));
    material.toneMapped = true;
    material.fog = false;

    const bulb = new THREE.Mesh(geometry, material);
    bulb.castShadow = false;
    // §V28-adjacent: the bulb is tiny and moves every frame; culling it
    // against a stale bounding sphere is a flicker nobody will diagnose
    bulb.frustumCulled = false;

    const light = new THREE.PointLight(0xffffff, 0, p.range, p.decay);
    // deliberate — see the header. Six scene passes per frame per lantern.
    light.castShadow = false;

    scene.add(bulb);
    scene.add(light);

    lanterns.push({
      id,
      state: createLanternState(seedOf(id, i)),
      light,
      bulb,
      material,
      uLevel: uLevelNode as unknown as { value: number },
      uColor: uColorNode as unknown as { value: THREE.Color },
      prevVelocity: null,
      position: new THREE.Vector3(),
    });
  });

  const byId = new Map(lanterns.map((l) => [l.id, l]));

  return {
    /** the created lights, for tests and for a perf HUD */
    lights: lanterns.map((l) => l.light),

    /**
     * Advance one lantern's pendulum by a sim tick.
     *
     * Call from the FIXED-TIMESTEP tick with SIM_DT, after the ship's pose is
     * final for the tick. The state is a pure function of the SimState
     * history at a fixed dt, so it is deterministic (§V2) — but it is
     * deliberately NOT part of SimState: a lantern's swing is decoration, and
     * putting it in the serialized state would change the sim hash for
     * something no gameplay reads. Same posture as deck water.
     *
     * §V51: this integrates ONLY its own two channels. It never writes the
     * ship's position, velocity or angular velocity.
     */
    step(id: string, drive: LanternDrive, dt: number): void {
      const l = byId.get(id);
      if (!l) return;
      // ONE first difference of a sim-owned velocity, not two of a position:
      // a second difference multiplies any jitter by 1/dt² = 3600 at 60 Hz,
      // and the pendulum would then be driven by numerical noise rather than
      // by the sea. hangTarget() clamps whatever comes out of this anyway.
      const v = drive.velocity;
      const prev = l.prevVelocity;
      const inv = dt > 1e-6 ? 1 / dt : 0;
      const accel: Vec3 = prev
        ? [(v[0] - prev[0]) * inv, (v[1] - prev[1]) * inv, (v[2] - prev[2]) * inv]
        : [0, 0, 0];
      l.prevVelocity = [v[0], v[1], v[2]];
      l.state = stepPendulum(l.state, drive.quaternion, accel, dt, p);
    },

    /**
     * Place the flame in the world, at RENDER rate.
     *
     * Split from `step()` because the two run on different clocks and must.
     * The physics advances on exact SimState at a fixed 60 Hz; the placement
     * has to follow the INTERPOLATED render pose, or the lantern judders
     * against the ship it is bolted to on every frame that falls between two
     * ticks. Call after the ship group's position/quaternion have been
     * lerped for this frame — `socketWorldPosition` walks the parent chain
     * itself, so no separate `updateMatrixWorld` is needed.
     */
    place(id: string, pivot: Vec3, quaternion: Quat): void {
      const l = byId.get(id);
      if (!l) return;
      // hook + cord along the solved hang direction. The hang vector is
      // ship-LOCAL, so it is rotated back into the world by the ship's own
      // orientation — that round trip is what makes the lantern stay plumb
      // while the deck rolls under it.
      const h = hangVector(l.state);
      const [qx, qy, qz, qw] = quaternion;
      const tx = 2 * (qy * h[2] - qz * h[1]);
      const ty = 2 * (qz * h[0] - qx * h[2]);
      const tz = 2 * (qx * h[1] - qy * h[0]);
      const cord = Math.max(0.02, p.cordLength);
      l.position.set(
        pivot[0] + (h[0] + qw * tx + (qy * tz - qz * ty)) * cord,
        pivot[1] + (h[1] + qw * ty + (qz * tx - qx * tz)) * cord,
        pivot[2] + (h[2] + qw * tz + (qx * ty - qy * tx)) * cord,
      );
    },

    /**
     * Push the solved state to the GPU.
     *
     * `nightFactor` (0..1) is how much of the scene's key the MOON owns —
     * `sky` publishes it. Lanterns are dimmed by daylight rather than
     * switched: a lit lantern at noon is invisible anyway (its 1/d² pool is
     * nothing against a directional 3.4), so ramping it costs nothing and
     * avoids the one thing that IS expensive, which is changing the light set.
     */
    sync(nightFactor: number): void {
      const night = Math.min(1, Math.max(0, Number.isFinite(nightFactor) ? nightFactor : 0));
      for (const l of lanterns) {
        const level = flickerLevel(l.state, p) * night;
        l.bulb.position.copy(l.position);
        l.bulb.scale.setScalar(Math.max(0.001, p.bulbRadius));
        l.light.position.copy(l.position);
        // §V31: the params hex is sRGB and must go through the transfer
        // function. A bare setRGB writes the linear working space (§B9).
        l.light.color.set(p.color);
        l.uColor.value.set(p.color);
        l.light.intensity = Math.max(0, p.intensity) * level;
        l.light.distance = Math.max(0, p.range);
        l.light.decay = Math.max(0, p.decay);
        l.uLevel.value = Math.max(0, p.emissive) * level;
        // §V28/§B5: an invisible additive quad still rasterises. A lantern
        // that contributes nothing is hidden outright, not merely dimmed.
        l.bulb.visible = level > 1e-4;
      }
    },

    /** world position of a lantern's flame — for audio, fx, or a test */
    positionOf(id: string): THREE.Vector3 | undefined {
      return byId.get(id)?.position;
    },

    /** pendulum state, for tests */
    stateOf(id: string): LanternState | undefined {
      return byId.get(id)?.state;
    },

    dispose(): void {
      for (const l of lanterns) {
        scene.remove(l.bulb);
        scene.remove(l.light);
        l.material.dispose();
        l.light.dispose();
      }
      geometry.dispose();
      lanterns.length = 0;
      byId.clear();
    },
  };
}

export type LanternRig = ReturnType<typeof createLanterns>;
export type { LanternState } from './pendulum';
