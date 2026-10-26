/**
 * The night sky over the sea: Act 2's own galaxy (milkyWay.ts — the ray-marched disk and the stars near the
 * Sun) as seen from the Sun's position, baked once into a cube texture when the act is built. The galaxy does
 * not change between the end of Act 2 and the sea, so the bake is static and every frame stays a pure
 * function of time; the sky over the sea samples it behind the air (seaSky.ts), dimmed by the air along each
 * ray and swamped by the day sky until the light falls.
 *
 * Its orientation is chosen for the dome, not computed from a date: the galactic centre GC_AZ / GC_EL from
 * the dome's front, the band arching through it and near the dome's zenith.
 */
import * as THREE from 'three/webgpu';
import { getTheDriftParams } from '../../params/getTheDrift';
import { driftParams } from '../../params/drift';
import { ourGalaxy } from '../getTheDrift/timeline';
import { createMilkyWay } from '../getTheDrift/milkyWay';

/** deg: the galactic centre's bearing from the dome's front (+ right) and its elevation */
const GC_AZ = -35;
const GC_EL = 30;

export interface NightSky {
  readonly texture: THREE.CubeTexture;
  /** sea-world direction → the bake's (galaxy) direction */
  readonly toGalaxy: THREE.Matrix3;
}

/**
 * Render the galaxy from the Sun into a cube (size² per face). `front` and `up` are the sea world's dome front
 * and up (unit): the frame the galactic centre is placed in.
 */
export function bakeNightSky(renderer: THREE.WebGPURenderer, front: THREE.Vector3, up: THREE.Vector3, size = 1536): NightSky {
  const p = getTheDriftParams;
  const g = ourGalaxy(p, [0, 0, 0], driftParams.domeTilt);
  const milky = createMilkyWay(g, p.marchSteps);
  const sun = new THREE.Vector3(...g.sun);
  milky.update({
    volume: 1,
    local: 1,
    sunStar: 0,
    radiance: p.volumeRadiance,
    pixelAngle: Math.PI / 2 / size,
    eye: sun,
    occluder: { centre: new THREE.Vector3(), radius: 0 },
    skyTurn: new THREE.Matrix3(),
  });
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x000000);
  scene.add(milky.group);
  const target = new THREE.CubeRenderTarget(size, { type: THREE.HalfFloatType });
  const camera = new THREE.CubeCamera(1e-7, 1e4, target);
  camera.position.copy(sun);
  scene.add(camera);
  const autoClear = renderer.autoClear;
  renderer.autoClear = true;
  camera.update(renderer, scene);
  renderer.autoClear = autoClear;
  milky.dispose();

  // the galaxy's frame (toward its centre, its pole) placed in the sea's: the centre at GC_AZ / GC_EL, the pole
  // square to it and to the dome's zenith side, so the band runs through the centre and arches overhead
  const gc = new THREE.Vector3(...g.centre).sub(sun).normalize();
  const pole = new THREE.Vector3(...g.normal);
  gc.addScaledVector(pole, -gc.dot(pole)).normalize();
  const right = new THREE.Vector3().crossVectors(front, up).normalize();
  const az = (GC_AZ * Math.PI) / 180;
  const el = (GC_EL * Math.PI) / 180;
  const gcSea = front.clone().multiplyScalar(Math.cos(az) * Math.cos(el)).addScaledVector(right, Math.sin(az) * Math.cos(el)).addScaledVector(up, Math.sin(el));
  const poleSea = new THREE.Vector3().crossVectors(gcSea, up).normalize();
  // the sea's basis (centre, pole, centre × pole) onto the galaxy's: G · Sᵀ (columns are the basis vectors)
  const s3 = new THREE.Vector3().crossVectors(gcSea, poleSea);
  const g3 = new THREE.Vector3().crossVectors(gc, pole);
  const S = new THREE.Matrix3().set(gcSea.x, poleSea.x, s3.x, gcSea.y, poleSea.y, s3.y, gcSea.z, poleSea.z, s3.z);
  const G = new THREE.Matrix3().set(gc.x, pole.x, g3.x, gc.y, pole.y, g3.y, gc.z, pole.z, g3.z);
  const toGalaxy = G.multiply(S.transpose());
  return { texture: target.texture as THREE.CubeTexture, toGalaxy };
}
