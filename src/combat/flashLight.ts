/**
 * The gun/impact flash LIGHT — one PointLight for the whole battle.
 *
 * ── THE ONE RULE THAT MATTERS: NEVER ADD OR REMOVE A LIGHT ─────────────
 * three r180 folds the scene's light set into the dynamic cache key of every
 * render object (`RenderObject.getDynamicCacheKey` → `Nodes.getCacheKey` →
 * `LightsNode.customCacheKey`, which hashes each light's id and castShadow
 * flag). Adding one PointLight therefore invalidates and recompiles the node
 * graph, WGSL and pipeline of EVERY material in the scene — the ocean
 * included, the widest shader in the project, mid-broadside. So the light is
 * created ONCE, at boot, before the first compile, and lives for the process.
 * "No flash" is `intensity = 0`, never `scene.remove()`. This is the same
 * rule and the same reasoning as src/lanterns/index.ts, which established it.
 *
 * That constraint is also why there is exactly ONE light and not one per gun:
 * every light costs a block in every lit shader forever, whether or not it is
 * on, and a broadside's guns sit a few metres apart. The light hops to the
 * newest flash each time one fires, which across a rolling broadside reads as
 * gunfire flickering along the side — closer to the real thing than four
 * steady sources would be, and free.
 *
 * ── WHY IT CASTS NO SHADOW ─────────────────────────────────────────────
 * A shadow-casting point light is `PointShadowNode`, which renders the scene
 * SIX times per frame (`PointLightShadow._viewportCount = 6`). Against §V.17's
 * 8 ms render budget, of which the ocean alone measures 7.1 ms (§B.25), that
 * is not a trade-off, it is the whole frame. Deliberate and load-bearing.
 *
 * §V.44: `intensity = peak x level` where `level` is an envelope confined to
 * [0,1] by construction and `peak` is finite-guarded — bounded at SOURCE, not
 * clamped downstream. §V.55: the envelope integrates dt, it is never
 * `time x rate`.
 */
import * as THREE from 'three/webgpu';
import type { CombatFxParams } from '../params/combat';

/** muzzle fire: hot, and warmer than daylight. §V.31 sRGB via THREE.Color */
const FLASH_COLOR = /*@__PURE__*/ new THREE.Color(0xffc98a);

export interface FlashLight {
  /**
   * ADD THIS TO THE SCENE AT BOOT, before the first material compiles, and
   * never remove it. It is deliberately NOT inside the combat fx group,
   * because that group is deferred by §T.40's staged warm-up and would add
   * the light AFTER the first frame — i.e. exactly the recompile this whole
   * module exists to avoid.
   */
  light: THREE.PointLight;
  /** re-arm at a world point; the brightest arming in a frame wins */
  strike(x: number, y: number, z: number, strength?: number): void;
  /** decay on the render clock (call once per rendered frame) */
  update(frameDt: number): void;
  dispose(): void;
}

export function createFlashLight(p: CombatFxParams): FlashLight {
  const light = new THREE.PointLight(FLASH_COLOR.getHex(), 0, 0, 2);
  light.name = 'combat-flash';
  light.castShadow = false;
  light.visible = true; // toggling visibility is NOT in the cache key; keep it on

  /** 0..1 envelope, integrated on the render clock */
  let level = 0;
  /** strength of the arming that owns the current position */
  let owner = 0;

  return {
    light,

    strike(x, y, z, strength = 1): void {
      if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) return;
      const s = Number.isFinite(strength) ? Math.min(1, Math.max(0, strength)) : 1;
      // The brightest event of the frame owns the light. Without this the
      // LAST event in iteration order would win, which for a broadside is
      // whichever gun happens to sit last in the battery array — a stable,
      // arbitrary bias rather than the flash you are actually looking at.
      if (s < owner && level > 0) return;
      owner = s;
      level = Math.max(level, s);
      light.position.set(x, y, z);
    },

    update(frameDt): void {
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      if (level > 0) {
        // §V.55: integrate dt. Floored divisor so a zero decay param cannot
        // divide to Infinity and pin the light on forever.
        const decay = Math.max(1e-3, nn(p.flashLightDecay, 0.075));
        level = Math.max(0, level - dt / decay);
        if (level === 0) owner = 0;
      }
      const peak = Math.max(0, nn(p.flashLightIntensity, 900));
      // §V.44: bounded at source — level is [0,1] by construction above
      light.intensity = peak * level * level;
      light.distance = Math.max(0, nn(p.flashLightRange, 55));
      light.decay = 2;
    },

    dispose(): void {
      light.dispose();
    },
  };
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}
