/**
 * §T.209 the pilot's night light (page/boatLights.ts `lightPilots`, pilotRig.ts `pilotNodeMaterial`).
 *
 * WHY each block:
 *  - HOOKS: the pilot GLB is not a boat slot, so the hull's night terms (the LED light set, the moon rim + sky fill) never
 *    reached him. USER, trailer 10 night bow look-back: "the pilot is completely BLACK" while his boat's LEDs lit the hull
 *    all round him. Every pilot, rivals included (§V110), carries the hulls' light set and a night emissive, and the LED
 *    fill is in his OWN boat's colour, not the hero's.
 *  - ZERO BY DAY: the emissive is built only from the night-factor / LED-level uniforms. If they stop being exactly 0 by
 *    day, every sunlit pilot (the game and the day trailer shots) shifts colour.
 *  - NODE COPY: the swap to a node material must draw the pilot as GLTFLoader's material did (maps, alpha test, side,
 *    anisotropy); a dropped map is a white or flat pilot. The hair keeps a matte floor (USER, sunset look-back: crawling
 *    specular sparkles on the hair), the suit its authored roughness.
 *  - BUILD: the added nodes must generate a shader, or the pilot silently falls back / vanishes on the page.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { lights as lightsOf } from 'three/tsl';
import { createBoatLights } from '../src/speedboat/page/boatLights';
import { PILOT_HAIR_MAX_ANISOTROPY, PILOT_HAIR_MIN_ROUGHNESS, pilotNodeMaterial } from '../src/speedboat/page/pilotRig';
import { createBoatLightPool } from '../src/ocean/boatLightPool';
import { boatLedLevel, boatNightFillLevels, boatPilotFillLevel, pilotFillLevel, twilightFillRamp } from '../src/speedboat/assets/slotMaterials';
import { nightFactor } from '../src/sky/moonCycle';
import { TIME_LED } from '../src/speedboat/cine/look';
import { ledColor, resolveLivery } from '../src/speedboat/assets/livery';
import type { BoatExtras, BoatInstance } from '../src/speedboat/assets';

const EXTRAS = { pipelineTest: true, bowZ: 6, sternZ: -5, beam: 2.5, keelY: -0.5, deckY: 0.55 } as unknown as BoatExtras;

/** the pilot GLB's two kinds of lit material, with its factors (M_Pilot: textured PBR; M_PilotHair: anisotropic cards) */
function glbMaterials() {
  const tex = () => new THREE.Texture();
  const suit = new THREE.MeshPhysicalMaterial({ name: 'M_Pilot', map: tex(), normalMap: tex(), aoMap: tex(), roughnessMap: tex(), metalnessMap: tex(), roughness: 1, metalness: 1 });
  const hair = new THREE.MeshPhysicalMaterial({ name: 'M_PilotHair', map: tex(), roughness: 0.55, metalness: 0, alphaTest: 0.35, side: THREE.DoubleSide, anisotropy: 0.8, anisotropyMap: tex() });
  return { suit, hair };
}

function rig() {
  const hull = (): THREE.Mesh => new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial());
  const hero = new THREE.Group();
  const rival = new THREE.Group();
  rival.userData.boatLivery = { dominant: 0x2266ff, stripe: 0x2266ff, led: 0x2266ff };
  hero.add(hull());
  rival.add(hull());
  const scene = new THREE.Scene();
  scene.add(hero, rival);
  const { suit, hair } = glbMaterials();
  const copies = new Map<THREE.Material, THREE.Material>([[suit, pilotNodeMaterial(suit)], [hair, pilotNodeMaterial(hair)]]);
  // one node copy shared by every pilot, as pilotRig's seat does
  const pilot = (): THREE.Group => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.SphereGeometry(), copies.get(suit)), new THREE.Mesh(new THREE.PlaneGeometry(), copies.get(hair)));
    return g;
  };
  const lights = createBoatLights({ scene, pool: createBoatLightPool(4), hero: { object: hero } as unknown as BoatInstance, npcs: [{ object: rival } as unknown as BoatInstance], extras: EXTRAS });
  // seated AFTER the rig, as on the page (pilotRig loads beside the boot)
  const pilots = [pilot(), pilot()];
  hero.add(pilots[0]);
  rival.add(pilots[1]);
  return { hero, rival, pilots, lights, suit, hair, copies };
}

const meshesOf = (o: THREE.Object3D): THREE.Mesh[] => o.children.filter((c): c is THREE.Mesh => (c as THREE.Mesh).isMesh);

describe('§T.209 the pilots get the boats\' night light', () => {
  it('every pilot material carries the hulls\' light set and a night emissive, the LED fill in its own boat\'s colour', () => {
    const r = rig();
    const hullLights = (meshesOf(r.hero)[0].material as THREE.NodeMaterial).lightsNode;
    expect(hullLights).not.toBeNull();
    r.lights.lightPilots(r.pilots);
    r.lights.update(1);
    for (const p of r.pilots) {
      for (const mesh of meshesOf(p)) {
        const m = mesh.material as THREE.MeshStandardNodeMaterial;
        expect(m.isNodeMaterial).toBe(true);
        expect(m.lightsNode).toBe(hullLights);
        expect(m.emissiveNode).not.toBeNull();
      }
    }
    const want = (o: THREE.Object3D): THREE.Color => new THREE.Color(ledColor(resolveLivery(o.userData)));
    expect((meshesOf(r.pilots[0])[0].userData.ledLinear as THREE.Color).equals(want(r.hero))).toBe(true);
    expect((meshesOf(r.pilots[1])[0].userData.ledLinear as THREE.Color).equals(want(r.rival))).toBe(true);
    expect(want(r.hero).equals(want(r.rival))).toBe(false); // the rival's pilot is not lit in the hero's colour
    r.lights.dispose();
  });

  it('by day the night terms are exactly zero; at night they are not', () => {
    const r = rig();
    r.lights.lightPilots(r.pilots);
    r.lights.update(1);
    expect(boatLedLevel()).toBe(1);
    expect(boatNightFillLevels().fill.r + boatNightFillLevels().rim.r).toBeGreaterThan(0);
    r.lights.update(0);
    expect(boatLedLevel()).toBe(0);
    const { fill, rim } = boatNightFillLevels();
    expect([fill.r, fill.g, fill.b, rim.r, rim.g, rim.b]).toEqual([0, 0, 0, 0, 0, 0]);
    r.lights.dispose();
  });

  /**
   * WHY (final look review, 10 dusk): at −4° the light rig is at its darkest (no sun key, moon not yet handed over, the
   * ambient on its night floor) but the night fill followed the raw night factor (0.38) and the pilot's LED fill the
   * pinned dusk LED level (0.4): a black silhouette. Dusk must read as the transition, most of the way to night, while
   * the sunset shots (+3°, LEDs pinned 0) stay bit-identical and LEDs switched off never light the pilot.
   */
  it('the fill ramps in through twilight: most of night\'s at dusk, exactly zero at the sunset stop and with LEDs off', () => {
    const r = rig();
    r.lights.lightPilots(r.pilots);
    const deg = Math.PI / 180;
    const at = (elevDeg: number, time: 'sunset' | 'dusk' | 'night') => {
      r.lights.setOverride(TIME_LED[time]);
      r.lights.update(nightFactor(elevDeg * deg));
      return { pilot: boatPilotFillLevel(), fill: boatNightFillLevels().fill.r };
    };
    const night = at(-40, 'night');
    const dusk = at(-4, 'dusk');
    const sunset = at(3, 'sunset');
    expect(night.pilot).toBe(1);
    expect(dusk.pilot).toBeGreaterThan(0.6 * night.pilot); // was 0.4: the LED level alone
    expect(dusk.pilot).toBeLessThan(night.pilot); // a transition, not night
    expect(dusk.fill).toBeGreaterThan(0.6 * night.fill); // was 0.38 of night's
    expect(dusk.fill).toBeLessThan(night.fill);
    expect([sunset.pilot, sunset.fill]).toEqual([0, 0]);
    // LEDs forced off at full night: the pilot's LED-hue fill is off with them
    r.lights.setOverride(0);
    r.lights.update(1);
    expect(boatPilotFillLevel()).toBe(0);
    // monotone through the whole dusk
    let prev = 0;
    for (let k = 0; k <= 50; k++) {
      const n = k / 50;
      const v = twilightFillRamp(n);
      expect(v).toBeGreaterThanOrEqual(prev);
      expect(pilotFillLevel(n, n)).toBeGreaterThanOrEqual(n); // never below the LED level itself
      prev = v;
    }
    r.lights.dispose();
  });

  it('the node copy draws the GLB material as authored; only the hair gets its matte floor', () => {
    const { suit, hair } = glbMaterials();
    const s = pilotNodeMaterial(suit) as THREE.MeshPhysicalNodeMaterial;
    const h = pilotNodeMaterial(hair) as THREE.MeshPhysicalNodeMaterial;
    for (const k of ['map', 'normalMap', 'aoMap', 'roughnessMap', 'metalnessMap'] as const) expect(s[k], k).toBe(suit[k]);
    expect([s.name, s.roughness, s.metalness]).toEqual(['M_Pilot', 1, 1]);
    expect([h.map, h.anisotropyMap, h.alphaTest, h.side]).toEqual([hair.map, hair.anisotropyMap, 0.35, THREE.DoubleSide]);
    expect(h.roughness).toBe(PILOT_HAIR_MIN_ROUGHNESS);
    expect(h.anisotropy).toBe(PILOT_HAIR_MAX_ANISOTROPY);
    expect(s.roughnessNode).not.toBeNull(); // the specular anti-aliasing
    expect(pilotNodeMaterial(s)).toBe(s); // idempotent
  });

  it('a lit pilot material still generates its shader (light set + night emissive + roughness AA)', () => {
    const r = rig();
    r.lights.lightPilots(r.pilots);
    for (const mesh of meshesOf(r.pilots[0])) {
      const material = mesh.material as THREE.NodeMaterial;
      const renderer = new THREE.WebGPURenderer({ canvas: stubCanvas() });
      const backend = (renderer as unknown as { backend: Record<string, unknown> }).backend;
      backend.renderer = renderer;
      (renderer as unknown as { hasFeature: (n: string) => boolean }).hasFeature = (n: string): boolean => n === 'float32-filterable';
      const builder = (backend as unknown as { createNodeBuilder: (o: THREE.Object3D, r: THREE.WebGPURenderer) => Record<string, unknown> }).createNodeBuilder(mesh, renderer);
      builder.scene = new THREE.Scene();
      builder.material = material;
      builder.camera = new THREE.PerspectiveCamera();
      (builder.context as Record<string, unknown>).material = material;
      builder.lightsNode = lightsOf([]);
      const errors: unknown[] = [];
      const err = console.error;
      console.error = (...a: unknown[]): void => void errors.push(a);
      try {
        (builder as unknown as { build: () => void }).build();
      } finally {
        console.error = err;
      }
      expect(errors, String(errors[0])).toEqual([]);
      expect(builder.fragmentShader as string).toMatch(/fn main/);
      expect(builder.fragmentShader as string).toMatch(/dpdx/); // the roughness AA made it into the shader
    }
    r.lights.dispose();
  });
});

function stubCanvas(): HTMLCanvasElement {
  return {
    width: 4, height: 4, style: {},
    getContext: (): null => null,
    addEventListener: (): void => {},
    removeEventListener: (): void => {},
    getRootNode: (): unknown => ({}),
    setAttribute: (): void => {},
  } as unknown as HTMLCanvasElement;
}
