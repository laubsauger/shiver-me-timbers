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
import { createDebris } from './debris';
import { OUR_LOOK, createGalaxies, galaxyField, type GalaxySpec } from './galaxies';
import { createMilkyWay } from './milkyWay';

export interface ArrivalAct {
  readonly group: THREE.Group;
  /** s, the act's length */
  readonly total: number;
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

  // Drift-2's spirals sit on the water in front of the audience as the flood ends: the point a ray at 14°
  // elevation straight ahead meets the planet then (the planet only translates, so it stays put on it)
  const { starts } = beatStarts(p);
  const endFlood = earthPose(starts.flood + p.flood, p, tiltDeg);
  const c = endFlood.centreDir.map((x) => x * endFlood.distance) as Vec3;
  const ray = domeDir(14, 0, tiltDeg);
  const b = ray[0] * c[0] + ray[1] * c[1] + ray[2] * c[2];
  const hit = b - Math.sqrt(Math.max(0, b * b - (c[0] * c[0] + c[1] * c[1] + c[2] * c[2]) + EARTH_RADIUS * EARTH_RADIUS));
  const up = new THREE.Vector3(ray[0] * hit - c[0], ray[1] * hit - c[1], ray[2] * hit - c[2]).normalize();
  const east = new THREE.Vector3().crossVectors(up, new THREE.Vector3(0, 1, 0)).normalize();
  const north = new THREE.Vector3().crossVectors(east, up);
  const du = {
    time: uniform(0), presence: uniform(0), centre: uniform(new THREE.Vector3()), radius: uniform(EARTH_RADIUS),
    up: uniform(up), east: uniform(east), north: uniform(north), sun: uniform(new THREE.Vector3(0, 1, 0)), pixelAngle: uniform(0.0015),
  };
  const v3 = (x: unknown) => x as THREE.Node<'vec3'>;
  const debris = createDebris(120000, {
    time: du.time, presence: du.presence, centre: v3(du.centre), radius: du.radius, up: v3(du.up), east: v3(du.east), north: v3(du.north),
    sun: v3(du.sun), pixelAngle: du.pixelAngle,
  });
  debris.renderOrder = 1;
  group.add(debris);
  // the debris lifts off the drowned coasts late in the flood
  const lift = starts.flood + p.flood * 0.55;
  let pixelAngle = 0.0015;

  return {
    group,
    total: beatStarts(p).total,
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
      earth.update({ centre, sun, presence: s.earth, sunPresence: s.earth, pixelAngle, eye });
      du.time.value = Math.max(0, t - lift);
      du.presence.value = Math.min(1, Math.max(0, (t - lift) / 5));
      du.centre.value.copy(centre);
      du.sun.value.copy(sun);
      du.pixelAngle.value = pixelAngle;
      debris.visible = t > lift;
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
      debris.geometry.dispose();
      (debris.material as THREE.Material).dispose();
    },
  };
}
