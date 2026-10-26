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
import { OUR_LOOK, createGalaxies, galaxyField, type GalaxySpec } from './galaxies';
import { createMilkyWay } from './milkyWay';

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

export function createArrival(p: GetTheDriftParams, e0: Vec3, knots: Array<{ pos: Vec3; level: number }>, tiltDeg: number): ArrivalAct {
  const g = ourGalaxy(p, e0, tiltDeg);
  const ours: GalaxySpec = { centre: g.centre, normal: g.normal, xAxis: g.xAxis, radius: g.radius, ...OUR_LOOK, appear: 0, brightness: 1 };
  const specs = galaxyField(knots, ours, [e0, g.sun], p.galaxySize);
  const u = { open: uniform(0), ours: uniform(1), field: uniform(1), radiance: uniform(p.galaxyRadiance), pixelAngle: uniform(0.0015) };
  const galaxies = createGalaxies(specs, u);
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
  // WHERE ON EARTH: the debris gathers over the drowned lowland of the north-eastern Netherlands (Drenthe,
  // ~10–30 m up today), geographic north straight ahead. The flood flies ~1000 km north to it, so we arrive
  // over the western Mediterranean (between the Balearics and Sardinia), the Alps and Europe toward the limb.
  const front = new THREE.Vector3(...domeDir(0, 0, tiltDeg));
  earth.setGeo(geoFrameAt(52.85, 6.75, up, front));
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
      u.field.value = (1 - 0.92 * s.volume) * (1 - s.earth);
      u.radiance.value = p.galaxyRadiance;
      u.pixelAngle.value = pixelAngle;
      // Earth: the planet comes to the eye (earthPose); its Sun takes over from the Milky Way's Sun star
      const e = earthPose(t, p, tiltDeg);
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
      const drift = { up, east, north, time: Math.max(0, t - lift), presence: Math.min(1, Math.max(0, (t - lift) / 6)) };
      earth.update({ time: t, centre, sun, presence: s.earth, sunPresence: s.earth, pixelAngle, eye, life: { ...L, waveOrigin }, drift });
      milky.update({
        // with a sunlit planet in view the sky steps back (the eye — and a camera — would lose the faint stars)
        volume: s.volume * (1 - 0.5 * s.earth), local: s.local * (1 - 0.65 * s.earth), sunStar: s.sunStar * (1 - s.earth),
        radiance: p.volumeRadiance, pixelAngle, eye,
        occluder: { centre, radius: s.earth > 0 ? EARTH_RADIUS * 1.003 : 0 },
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
