/**
 * Get the Drift as one scene group the show drives with the act's own time (direction:
 * drift-narrative/get-the-drift/direction.md and direction-part-b.md): the field of galaxies at Undertime's
 * knots, our galaxy as an impostor that hands over to its ray-marched volume, the stars near the Sun point
 * and the Sun; then Earth (earth.ts), its life (life.ts) and Drift-2's debris spirals (debris.ts).
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { GetTheDriftParams } from '../../params/getTheDrift';
import type { Vec3 } from '../../cine/domeMaster';
import { EARTH_RADIUS, arrivalEye, arrivalState, beatStarts, domeDir, earthPose, ourGalaxy, type ArrivalState } from './timeline';
import { createEarth } from './earth';
import { geoFrameAt } from './earthMaps';
import { lifeState } from './life';
import { OUR_LOOK, createGalaxies, galaxyField, type GalaxyAtlas, type GalaxySpec } from './galaxies';
import { createMilkyWay } from './milkyWay';

/** rad/s the sky wheels at over Earth, and the s it eases in over */
const SKY_TURN = (0.5 * Math.PI) / 180;
const SKY_EASE = 8;

const smoothstep01 = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

export interface ArrivalAct {
  readonly group: THREE.Group;
  /** s, the act's length */
  readonly total: number;
  /** resolves once the Earth's maps are loaded (a render must wait for it) */
  readonly ready: Promise<void>;
  /** put the act into the state of its time t; returns the state and writes the eye into `eye` */
  update(t: number, eye: THREE.Vector3): ArrivalState;
  setPixelAngle(rad: number): void;
  dispose(): void;
}

/** `atlas` must be loaded (its tiles' kinds pick the field's galaxies) */
export function createArrival(p: GetTheDriftParams, e0: Vec3, knots: Array<{ pos: Vec3; level: number }>, tiltDeg: number, atlas: GalaxyAtlas): ArrivalAct {
  const g = ourGalaxy(p, e0, tiltDeg);
  const ours: GalaxySpec = { centre: g.centre, normal: g.normal, xAxis: g.xAxis, radius: g.radius, ...OUR_LOOK, appear: 0, brightness: 1, tile: -1, planar: true, roll: 0 };
  const specs = galaxyField(knots, ours, [e0, g.sun], p.galaxySize, atlas.galaxies);
  const skyTurn = new THREE.Matrix3();
  const u = { open: uniform(0), ours: uniform(1), field: uniform(1), radiance: uniform(p.galaxyRadiance), pixelAngle: uniform(0.0015), skyTurn: uniform(skyTurn) };
  const galaxies = createGalaxies(specs, { ...u, skyTurn: u.skyTurn as unknown as THREE.Node<'mat3'> }, atlas);
  const milky = createMilkyWay(g, p.marchSteps);
  const earth = createEarth();
  const group = new THREE.Group();
  group.name = 'get-the-drift';
  group.add(galaxies, milky.group, earth.group);
  const centre = new THREE.Vector3();
  const sun = new THREE.Vector3();
  const waveOrigin = new THREE.Vector3();

  // Drift-2's spirals sit on the water in front of the audience: the point a ray at gatherEl straight ahead
  // meets the planet at the act's end (the planet only translates, so it stays put on it)
  const { starts } = beatStarts(p);
  const end = earthPose(starts.drift2 + p.drift2, p, tiltDeg);
  const c = end.centreDir.map((x) => x * end.distance) as Vec3;
  const ray = domeDir(p.gatherEl, 0, tiltDeg);
  const b = ray[0] * c[0] + ray[1] * c[1] + ray[2] * c[2];
  const hit = b - Math.sqrt(Math.max(0, b * b - (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]) + EARTH_RADIUS * EARTH_RADIUS));
  const up = new THREE.Vector3(ray[0] * hit - c[0], ray[1] * hit - c[1], ray[2] * hit - c[2]).normalize();
  const east = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).normalize();
  const north = new THREE.Vector3().crossVectors(east, up);
  // WHERE ON EARTH (direction.md: "a high angle POV looking eastward"): the matter gathers over the
  // drowned Po plain between Padua and Rovigo (~5–10 m up today), the view heading east. The flood flies
  // ~1300 km east to it, so we arrive over the Bay of Biscay: France below, the Alps, Italy and the Adriatic
  // ahead, the Balkans at the limb, the North Sea to the left, the Mediterranean and the Sahara to the
  // right; a summer dawn rising in the north-east, front left. At 70 m the Po plain becomes a gulf between
  // the Alps and the Apennines.
  const front = new THREE.Vector3(...domeDir(0, 0, tiltDeg));
  front.addScaledVector(up, -front.dot(up)).normalize();
  const rgt = new THREE.Vector3().crossVectors(front, up);
  const h = (p.heading * Math.PI) / 180;
  const geoNorth = front.clone().multiplyScalar(Math.cos(h)).addScaledVector(rgt, -Math.sin(h));
  const geo = geoFrameAt(p.gatherLat, p.gatherLon, up, geoNorth);
  earth.setGeo(geo);
  // over Earth the sky wheels slowly about the planet's axis (a time-lapse, as in orbital footage): it eases
  // in from the Earth beat's start to SKY_TURN rad/s; the planet stays put
  const turnStart = starts.earth;
  const turnAt = (t: number): number => {
    const x = t - turnStart;
    if (x <= 0) return 0;
    // ∫ of a rate easing in over SKY_EASE s (smoothstep): closed form
    const e = Math.min(x, SKY_EASE);
    const k = e / SKY_EASE;
    const eased = SKY_EASE * (k * k * k - 0.5 * k * k * k * k);
    return SKY_TURN * (eased + Math.max(0, x - SKY_EASE));
  };
  const turn4 = new THREE.Matrix4();
  // the debris lifts off the drowned coasts late in the flood
  const lift = starts.flood + p.flood * 0.55;
  let pixelAngle = 0.0015;

  return {
    group,
    total: beatStarts(p).total,
    ready: earth.ready,
    update(t, eye) {
      const s = arrivalState(t, p);
      eye.set(...arrivalEye(t, p, g));
      u.open.value = s.open;
      // our galaxy's far disc hands over to its volume; the other galaxies dim once we are inside its
      // dust and stars (they are still there, faintly, through the gaps)
      u.ours.value = 1 - s.volume;
      skyTurn.setFromMatrix4(turn4.makeRotationAxis(geo.north, turnAt(t)));
      u.skyTurn.value.copy(skyTurn);
      // Earth: the planet comes to the eye (earthPose); its Sun takes over from the Milky Way's Sun star over
      // a few seconds (a quick swap reads as a flash). As the sunlit planet grows the sky steps back — the
      // eye (and a camera) loses the faint stars — but only as fast as the planet grows, never as a cut
      const e = earthPose(t, p, tiltDeg);
      const handover = smoothstep01((t - starts.earth + 1) / 5);
      const glare = smoothstep01((e.radiusDeg - 3) / 45) * s.earth;
      // (the volume takes over from the far disc while still a few radii out; the field dims only once we
      // are inside the disk, among its near stars)
      u.field.value = (1 - 0.92 * s.local) * (1 - glare);
      centre.set(...e.centreDir).multiplyScalar(e.distance).add(eye);
      sun.set(...e.sun);
      earth.group.visible = s.earth > 0;
      // Part B: the life layers; the time waves start at the planet's limb straight ahead
      const ahead = domeDir(p.limbEl - 4, 0, tiltDeg);
      const oc = [eye.x - centre.x, eye.y - centre.y, eye.z - centre.z];
      const bb = ahead[0] * oc[0] + ahead[1] * oc[1] + ahead[2] * oc[2];
      const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - EARTH_RADIUS * EARTH_RADIUS;
      const disc = bb * bb - cc;
      const hitT = disc > 0 ? -bb - Math.sqrt(disc) : -bb;
      waveOrigin.set(eye.x + ahead[0] * hitT - centre.x, eye.y + ahead[1] * hitT - centre.y, eye.z + ahead[2] * hitT - centre.z).normalize();
      const L = lifeState(t, p);
      const drift = {
        up, east, north, time: Math.max(0, t - lift), presence: Math.min(1, Math.max(0, (t - lift) / 6)),
        clear: smoothstep01((t - starts.flood - 0.35 * p.flood) / (0.65 * p.flood + p.drift2 * 0.3)),
      };
      earth.update({ time: t, centre, sun, presence: s.earth, sunPresence: handover, pixelAngle, eye, life: { ...L, waveOrigin }, drift });
      milky.update({
        volume: s.volume * (1 - 0.4 * glare), local: s.local * (1 - 0.55 * glare), sunStar: s.sunStar * (1 - handover),
        radiance: p.volumeRadiance, pixelAngle, eye,
        occluder: { centre, radius: s.earth > 0 ? EARTH_RADIUS * 1.003 : 0 },
        skyTurn,
      });
      return s;
    },
    setPixelAngle(rad) {
      pixelAngle = rad;
    },
    dispose() {
      galaxies.geometry.dispose();
      (galaxies.material as THREE.Material).dispose();
      milky.dispose();
      earth.dispose();
    },
  };
}
