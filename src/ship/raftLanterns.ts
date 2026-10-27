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
import { float, sin, uniform, vec3 } from 'three/tsl';
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
  const corners: Array<[number, number]> = [];
  for (const sx of [-1, 1]) for (const z of zs) corners.push([sx * out, z]);
  corners.forEach(([x, z], i) => {
    const lantern = new THREE.Group();
    lantern.name = `raft-lantern-${i}`;
    const y = eaveTip - DROP;
    lantern.position.set(x, y, z);
    // the glass: a candle's flicker, each its own (two slow sines and a quick one, never out)
    const glassMat = new THREE.MeshBasicNodeMaterial({ fog: false });
    const ph = i * 1.7;
    const flicker = float(0.82)
      .add(sin(uTime.mul(1.3).add(ph)).mul(0.07))
      .add(sin(uTime.mul(3.1).add(ph * 2.3)).mul(0.05))
      .add(sin(uTime.mul(11.7).add(ph * 0.7)).mul(0.03));
    glassMat.colorNode = vec3(CANDLE.r, CANDLE.g, CANDLE.b).mul(uNight.mul(flicker).mul(GLOW).add(0.04));
    const glass = new THREE.Mesh(new THREE.CylinderGeometry(GLASS.r, GLASS.r * 1.1, GLASS.h, 10), glassMat);
    lantern.add(glass);
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
