/**
 * THE RAFT'S LANTERNS — four small hurricane lanterns hung from the cabin roof's corners, under the eave overhang
 * (the user, 2026-10-27: "little cute lanterns that hang from the roof on the corners … to give it a night presence
 * … it would also work at night quite beautifully without just drowning"). Lit at dusk, out by day.
 *
 * Each is a frame and a glass: the glass is emission only (a candle's 1800 K, a slow per-lantern flicker that is a
 * pure function of the time it is given, so a film frame renders on its own), the frame a dark lit metal. They
 * light the raft through TWO point lights, one under each eave (port, starboard) — four would put four more lights
 * into every lit material's shader for one look. Short range (they light the deck and the walls, not the sea).
 *
 * In the raft's own frame (ShipAssembly.group's local space): x across, y up, z toward the bow, as the blueprint.
 */
import * as THREE from 'three/webgpu';
import { cameraPosition, float, mix, normalWorld, positionWorld, sin, uniform, vec3 } from 'three/tsl';
import { raftParams, type RaftParams } from '../params/raft';
import { raftLayout } from './raftPartsLayout';

/** m: the lantern's glass and frame; the drop from the eave it hangs on */
const GLASS = { r: 0.055, h: 0.14 };
const DROP = 0.22;
/** the glass's radiance at full night (linear, × the candle colour) and the lights' intensity and reach */
const GLOW = 6;
const LIGHT = 0.9;
const REACH = 7;
const CANDLE = new THREE.Color(1, 0.55, 0.22);

export interface RaftLanterns {
  readonly group: THREE.Group;
  /**
   * `night` 0 (day: out) .. 1 (lit), and the time (s) the flicker runs on. The caller's night: the film's from
   * its Sun, the game's from `lanternNight(sunElevationDeg)`.
   */
  update(night: number, time: number): void;
}

/** the lanterns' share of lit from the Sun's elevation (deg): out above 2°, full by −4° */
export function lanternNight(sunElevationDeg: number): number {
  const k = Math.min(1, Math.max(0, (2 - sunElevationDeg) / 6));
  return k * k * (3 - 2 * k);
}

/**
 * `lights: false` for a raft seen only from far off: its glass still glows, but it carries no point lights — and
 * a light that is in the scene in one beat and not in the next makes every lit material rebuild, twice a frame
 * through a dissolve (The Drift's night-to-coast crossfade fell to under a frame a second).
 */
export function createRaftLanterns(p: RaftParams = raftParams, o: { lights?: boolean } = {}): RaftLanterns {
  const L = raftLayout(p);
  const hw = p.cabinWidth / 2;
  const eaveY = L.cabinFloorY + p.cabinEave;
  // the roof's eave line at the overhang's outer edge, a hand inboard of it (where a lantern's hook goes)
  const slope = Math.atan2(p.cabinRidge - p.cabinEave, hw);
  const out = hw + p.roofOverhang * 0.7;
  const eaveTip = eaveY - p.roofOverhang * 0.7 * Math.tan(slope);
  const zs = [L.cabinAftZ - p.roofOverhang * 0.6, L.cabinFrontZ + p.roofOverhang * 0.6];

  const group = new THREE.Group();
  group.name = 'raft-lanterns';
  const uNight = uniform(0);
  const uTime = uniform(0);
  const frameMat = new THREE.MeshStandardNodeMaterial({ color: 0x2a241d, roughness: 0.55, metalness: 0.6 });
  const waxMat = new THREE.MeshStandardNodeMaterial({ color: 0xe6dcc4, roughness: 0.55, metalness: 0 });
  const corners: Array<[number, number]> = [];
  for (const sx of [-1, 1]) for (const z of zs) corners.push([sx * out, z]);
  corners.forEach(([x, z], i) => {
    const lantern = new THREE.Group();
    lantern.name = `raft-lantern-${i}`;
    const y = eaveTip - DROP;
    lantern.position.set(x, y, z);
    // the glass: a candle's flicker, each its own (two slow sines and a quick one, never out)
    const ph = i * 1.7;
    const flicker = float(0.82)
      .add(sin(uTime.mul(1.3).add(ph)).mul(0.07))
      .add(sin(uTime.mul(3.1).add(ph * 2.3)).mul(0.05))
      .add(sin(uTime.mul(11.7).add(ph * 0.7)).mul(0.03));
    // GLASS, NOT A BROWN TUBE (the 2026-10-29 review: unlit, the lanterns read as "solid brown … they need to at
    // least hint at being transparent"): a clear chimney you see the candle through — faint where you look straight
    // through it, brighter at its edges (Fresnel), catching the sky — and, lit, the candle's glow filling it, the
    // glass going milky with the light it scatters
    const glow = uNight.mul(flicker);
    const view = cameraPosition.sub(positionWorld).normalize();
    const edge = float(1).sub(normalWorld.dot(view).abs()).pow(3);
    const glassMat = new THREE.MeshStandardNodeMaterial({ color: 0xdfe6e4, roughness: 0.06, metalness: 0, transparent: true, depthWrite: false, side: THREE.DoubleSide });
    glassMat.opacityNode = mix(float(0.1).add(edge.mul(0.55)), float(0.9), glow.min(1));
    glassMat.emissiveNode = vec3(CANDLE.r, CANDLE.g, CANDLE.b).mul(glow.mul(GLOW));
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(GLASS.r, GLASS.r * 1.1, GLASS.h, 14, 1, true), glassMat);
    glass.renderOrder = 3;
    lantern.add(glass);
    // inside it: the candle stub, its wick, and the flame's own small glow (lit only)
    const candle = new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.019, 0.06, 10), waxMat);
    candle.position.y = -GLASS.h / 2 + 0.03;
    lantern.add(candle);
    const flameMat = new THREE.MeshBasicNodeMaterial({ fog: false, transparent: true, depthWrite: false });
    flameMat.colorNode = vec3(1, 0.7, 0.35).mul(glow.mul(GLOW * 2.5));
    flameMat.opacityNode = glow.min(1);
    const flame = new THREE.Mesh(new THREE.SphereGeometry(0.009, 8, 6).scale(1, 2.2, 1), flameMat);
    flame.position.y = -GLASS.h / 2 + 0.075;
    lantern.add(flame);
    // the guard wires round the glass
    for (let w = 0; w < 4; w++) {
      const a = (w / 4) * Math.PI * 2 + 0.4;
      const wire = new THREE.Mesh(new THREE.CylinderGeometry(0.0025, 0.0025, GLASS.h, 4), frameMat);
      wire.position.set(Math.cos(a) * GLASS.r * 1.18, 0, Math.sin(a) * GLASS.r * 1.18);
      lantern.add(wire);
    }
    const cap = new THREE.Mesh(new THREE.ConeGeometry(GLASS.r * 1.35, 0.06, 10), frameMat);
    cap.position.y = GLASS.h / 2 + 0.03;
    lantern.add(cap);
    const base = new THREE.Mesh(new THREE.CylinderGeometry(GLASS.r * 1.25, GLASS.r * 1.25, 0.025, 10), frameMat);
    base.position.y = -GLASS.h / 2 - 0.012;
    lantern.add(base);
    // the bail it hangs from, up to the eave
    const bail = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.004, DROP - GLASS.h / 2, 4), frameMat);
    bail.position.y = GLASS.h / 2 + (DROP - GLASS.h / 2) / 2 + 0.03;
    lantern.add(bail);
    lantern.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) o.castShadow = false;
    });
    group.add(lantern);
  });
  const lights = (o.lights === false ? [] : [-1, 1]).map((sx) => {
    const l = new THREE.PointLight(CANDLE, 0, REACH, 2);
    l.position.set(sx * out, eaveTip - DROP, (zs[0] + zs[1]) / 2);
    l.castShadow = false;
    group.add(l);
    return l;
  });
  return {
    group,
    update(night, time) {
      uNight.value = night;
      uTime.value = time;
      const f = 0.85 + 0.08 * Math.sin(time * 1.3) + 0.05 * Math.sin(time * 3.1 + 1.1);
      for (const l of lights) l.intensity = LIGHT * night * f;
      group.visible = true;
    },
  };
}
