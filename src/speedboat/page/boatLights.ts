/**
 * §T.209 BOAT LEDs, the page side (docs/speedboat/night.md). HYBRID, by cost:
 *  - EVERY BOAT: the emissive underglow + deck courtesy strips (assets/slotMaterials.ts, one scene-wide level), a light
 *    POOL on the water (ocean/boatLightPool.ts: one uniform-array slot each, hero = slot 0) and an additive underwater
 *    GLOW sheet under the hull (drawn before the ocean, so the water's refraction copy carries it).
 *  - THE PLAYER ONLY: two real PointLights (port + starboard, at the waterline, shadows off) that light her hull and
 *    the rivals alongside. BOAT MATERIALS ONLY: the lights are NOT in the scene graph (every lit fragment on screen —
 *    the kit island terrain above all — would evaluate them; measured +2–4 ms GPU at 1080p); the boats' lit slot
 *    materials get `lightsNode = lights([scene lights at build, ...these two])` instead, and the page places the two
 *    lights by hand each frame. Created ONCE, never removed (a light set change recompiles): "off" is intensity 0.
 *    Stated limit: a light added to the scene AFTER the boats are built does not reach the boat materials.
 *
 * LEVEL: `sky.nightFactor` (THE single dusk clock, sky/moonCycle.ts — 0 above +1.7° sun, 1 below −12°), unless a
 * deterministic override is set (`setOverride`, the cine shot runner's hook). Colour: the livery's `ledColor`.
 */
import * as THREE from 'three/webgpu';
import { diffuseColor, float, lights, objectGroup, smoothstep, uniform, uv } from 'three/tsl';
import { boatLightParams } from '../../params/boatLights';
import type { BoatLightPool } from '../../ocean/boatLightPool';
import { nightFillNode, pilotLedFillNode, setBoatLedLevel, setBoatNightFill } from '../assets/slotMaterials';
import type { TslNode } from '../../caustics/causticsNode';
import { skyParams } from '../../params/sky';
import { ledColor, resolveLivery, type BoatLivery } from '../assets/livery';
import type { BoatExtras, BoatInstance } from '../assets';
import { createCockpitLights } from './cockpitLights';

/** drawn before the ocean (0) and the gauge glass (−2): inside the scene copy the water refracts */
export const GLOW_RENDER_ORDER = -3;

/**
 * How far outboard of the max beam the player's two lights sit (m): the MINIMUM light-to-topside distance, so it bounds
 * the inverse-square peak on her own hull. Final look review (night LED-strip inserts): at 1.1 m and 6 cd the white
 * topside next to the strip took ≈ 1.3 linear radiance (albedo 0.8 · 6 / 1.1² / π), ~100× the night sky and over the
 * night bloom threshold (0.8), and tonemapped to one flat orange card with only the dark numerals left. At 1.6 m and
 * 3 cd the peak is ≈ 0.3 (under half that threshold, ~1/25 of the strip's own 8 nits) and the falloff along the flank
 * still reads as a gradient (tests/pilotNightLight.test.ts).
 */
export const HERO_LIGHT_STANDOFF = 1.6;

/** the LED level 0..1: an override (clamped) wins, else the sky's night factor */
export function ledLevel(nightFactor: number, override: number | null): number {
  const v = override ?? nightFactor;
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
}

/** the LED hex each boat throws, hero first then rivals — the pool slots' colours in slot order */
export function poolLedColors(liveries: readonly Readonly<BoatLivery>[], max: number): number[] {
  return liveries.slice(0, max).map((l) => ledColor(l));
}

/** a pilot's night emissive over `albedo`: the hull's moon rim + sky fill and his boat's LED fill (0 by day) */
export function pilotNightEmissive(albedo: TslNode, hue: TslNode): TslNode {
  return nightFillNode(albedo).add(pilotLedFillNode(albedo, hue));
}

export interface BoatLightsDeps {
  scene: THREE.Scene;
  pool: BoatLightPool;
  hero: BoatInstance;
  npcs: readonly BoatInstance[];
  extras: BoatExtras;
}

export function createBoatLights(d: BoatLightsDeps) {
  const { pool, extras } = d;
  const boats = [d.hero, ...d.npcs].slice(0, pool.max);
  const length = extras.bowZ - extras.sternZ;
  const midZ = (extras.bowZ + extras.sternZ) / 2;
  const lineY = extras.keelY + 0.4 * (extras.deckY - extras.keelY);

  // ── the player's two real lights ──
  const heroLightOffsets = [-1, 1].map((side) => new THREE.Vector3(side * (extras.beam / 2 + HERO_LIGHT_STANDOFF), lineY + 0.25, midZ - 0.8));
  const heroLights = heroLightOffsets.map((_, k) => {
    const l = new THREE.PointLight(0xffffff, 0, boatLightParams.playerLightRange, 2);
    l.name = `boat-led-${k === 0 ? 'port' : 'starboard'}`;
    l.castShadow = false;
    return l;
  });
  const sceneLights: THREE.Light[] = [];
  d.scene.traverse((o) => {
    if ((o as THREE.Light).isLight) sceneLights.push(o as THREE.Light);
  });
  // The pipeline-test hull deliberately has no cockpit/roll arch.
  const cockpit = extras.pipelineTest ? null : createCockpitLights(boats.map(b => b.object), extras.deckY);
  const boatLightsNode = lights([...sceneLights, ...heroLights, ...(cockpit ? [cockpit.light] : [])]);
  const litMaterials = new Set<THREE.Material>();
  for (const b of boats) {
    b.object.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        const nm = m as THREE.NodeMaterial;
        if (nm.isNodeMaterial && nm.lights === true && !litMaterials.has(m)) {
          litMaterials.add(m);
          nm.lightsNode = boatLightsNode;
          nm.needsUpdate = true;
        }
      }
    });
  }

  // ── the underwater glow sheet (one material, the hue per object) ──
  const glowHue = uniform(new THREE.Color(1, 1, 1)).setGroup(objectGroup);
  glowHue.onObjectUpdate((frame) => {
    const c = frame.object?.userData.ledLinear as THREE.Color | undefined;
    if (c) (glowHue.value as THREE.Color).copy(c);
  });
  const glowLevel = uniform(0);
  const glowMat = new THREE.MeshBasicNodeMaterial();
  glowMat.name = 'boat-led-glow';
  const r = uv().sub(0.5).mul(2).length();
  // @band-limited-elsewhere: a radial falloff spanning the whole 4–18 m sheet (no edge inside it; 0 at the rim)
  glowMat.colorNode = glowHue.mul(smoothstep(float(0), float(1), r).oneMinus().pow(2)).mul(glowLevel);
  glowMat.transparent = true;
  glowMat.depthWrite = false;
  glowMat.blending = THREE.AdditiveBlending;
  glowMat.side = THREE.DoubleSide;
  glowMat.fog = false;
  const glowGeo = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
  const glows = boats.map((b) => {
    const m = new THREE.Mesh(glowGeo, glowMat);
    m.name = 'boat-led-glow';
    m.renderOrder = GLOW_RENDER_ORDER;
    m.castShadow = false;
    m.receiveShadow = false;
    m.userData.ledLinear = new THREE.Color();
    m.position.set(0, extras.keelY - 0.15, midZ);
    b.object.add(m);
    return m;
  });

  let override: number | null = null;
  let level = 0;
  const fwd = new THREE.Vector3();
  const up = new THREE.Vector3(0, 1, 0);
  const moonLinear = new THREE.Color();
  const lastLivery: unknown[] = boats.map(() => undefined);
  const linear = boats.map(() => new THREE.Color());

  const refreshColor = (i: number): THREE.Color => {
    const ud = boats[i].object.userData;
    const key = ud.boatLivery ?? ud.liveryTint;
    if (key !== lastLivery[i] || lastLivery[i] === undefined) {
      lastLivery[i] = key ?? null;
      linear[i].set(ledColor(resolveLivery(ud))); // sRGB hex → linear working space
      (glows[i].userData.ledLinear as THREE.Color).copy(linear[i]);
    }
    return linear[i];
  };

  // ── the pilots (seated later, pilotRig.ts loads beside the boot): see `lightPilots` ──
  const pilotMaterials = new Set<THREE.Material>();
  const pilotHue = uniform(new THREE.Color(0, 0, 0)).setGroup(objectGroup);
  pilotHue.onObjectUpdate((frame) => {
    const c = frame.object?.userData.ledLinear as THREE.Color | undefined;
    if (c) (pilotHue.value as THREE.Color).copy(c);
  });

  return {
    pool,
    heroLights,
    /**
     * §T.209 PILOTS (USER: "in the night bow look-back the pilot is completely black"). The pilot GLB is not a boat slot,
     * so its materials had none of the hull's night terms: moonlit from behind he was the key's back face over a navy
     * ambient. `pilots[i]` sits in boat i (hero first, then the rivals: V110, every pilot alike). Each lit pilot material
     * (a node material, pilotRig.ts `pilotNodeMaterial`; shared by every pilot wearing it) gets the hulls' light set
     * (the player's two LED lights and the arch light) and an emissive night term: the hulls' moon rim + sky fill and
     * `pilotLedFillNode` in his OWN boat's LED colour (per object, `userData.ledLinear` = this rig's live colour). Both
     * scale with the night factor / LED level: exactly 0 by day. No sampler, no light.
     */
    lightPilots(pilots: readonly THREE.Object3D[]): void {
      pilots.slice(0, boats.length).forEach((pilot, i) => {
        pilot.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          mesh.userData.ledLinear = linear[i];
          for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
            const nm = m as THREE.MeshStandardNodeMaterial;
            if (!nm.isNodeMaterial || nm.lights !== true || pilotMaterials.has(m)) continue;
            pilotMaterials.add(m); // a pilot seated before this rig was built already has the light set, not the emissive
            litMaterials.add(m);
            nm.lightsNode = boatLightsNode;
            nm.emissiveNode = pilotNightEmissive(diffuseColor.rgb, pilotHue);
            nm.needsUpdate = true;
          }
        });
      });
    },
    /** deterministic LED level for offline renders: 0..1, or null to follow the sky again */
    setOverride(v: number | null): void {
      override = v === null || !Number.isFinite(v) ? null : Math.min(1, Math.max(0, v));
    },
    get level(): number {
      return level;
    },
    /** RENDER, after the boats are at this frame's poses; `keyDir` = `sky.sunDirection` (the moon at night) */
    update(nightFactor: number, keyDir: THREE.Vector3 = up): void {
      const p = boatLightParams;
      setBoatNightFill(moonLinear.set(skyParams.moonColor), nightFactor, keyDir, p); // follows the sky, never the LED override
      level = ledLevel(nightFactor, override);
      setBoatLedLevel(level, p);
      pool.updateFromParams(p);
      glowLevel.value = level * p.glowIntensity;
      for (let i = 0; i < boats.length; i++) {
        const o = boats[i].object;
        const c = refreshColor(i);
        glows[i].scale.set(extras.beam * p.glowScale, 1, length * p.glowScale);
        glows[i].visible = level > 0;
        if (!o.visible || !o.parent) {
          pool.set(i, 0, 0, 0, 0, c, 0);
          continue;
        }
        fwd.set(0, 0, 1).applyQuaternion(o.quaternion);
        pool.set(i, o.position.x, o.position.y, o.position.z, Math.atan2(fwd.x, fwd.z), c, level);
      }
      pool.clearFrom(boats.length);
      cockpit?.update(level, linear); // after refreshColor: each arch light in its own boat's LED colour
      const hc = linear[0];
      const ho = d.hero.object;
      for (let k = 0; k < heroLights.length; k++) {
        const l = heroLights[k];
        l.position.copy(heroLightOffsets[k]).applyQuaternion(ho.quaternion).add(ho.position);
        l.updateMatrixWorld(true);
        l.color.copy(hc);
        l.intensity = p.playerLightIntensity * level;
        l.distance = p.playerLightRange;
      }
    },
    dispose(): void {
      cockpit?.dispose();
      for (const m of litMaterials) (m as THREE.NodeMaterial).lightsNode = null;
      for (const g of glows) g.removeFromParent();
      glowGeo.dispose();
      glowMat.dispose();
    },
  };
}
export type BoatLights = ReturnType<typeof createBoatLights>;
