/**
 * Get the Drift, part A, as one scene group the show drives with the act's own time (direction:
 * drift-narrative/get-the-drift/direction.md): the field of galaxies at Undertime's knots, our galaxy as an
 * impostor that hands over to its ray-marched volume, the stars near the Sun point, and the Sun.
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { GetTheDriftParams } from '../../params/getTheDrift';
import type { Vec3 } from '../../cine/domeMaster';
import { arrivalEye, arrivalState, beatStarts, ourGalaxy, type ArrivalState } from './timeline';
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
  const group = new THREE.Group();
  group.name = 'get-the-drift';
  group.add(galaxies, milky.group);
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
      u.field.value = 1 - 0.92 * s.volume;
      u.radiance.value = p.galaxyRadiance;
      u.pixelAngle.value = pixelAngle;
      milky.update({ volume: s.volume, local: s.local, sunStar: s.sunStar, radiance: p.volumeRadiance, pixelAngle, eye });
      return s;
    },
    setPixelAngle(rad) {
      pixelAngle = rad;
    },
    dispose() {
      galaxies.geometry.dispose();
      (galaxies.material as THREE.Material).dispose();
      milky.dispose();
    },
  };
}
