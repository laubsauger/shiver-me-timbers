/**
 * Undertime's medium as photographs show light in space: DUST MOTES catching it. A ball of fine motes
 * around the audience, fixed in the world (parallax as we drift), each barely there until an event lights
 * it: a creation burst or an annihilation flash lights up a cloud of motes around itself, a photon crossing
 * the dome leaves a streak of lit motes along its path, the beads light their neighbourhood as they pass.
 * Discrete, sparkling, deep — where a lit fog read as smog.
 *
 * Each mote sums the frame's strongest event lights (events.ts eventLights) with inverse-square falloff and
 * a forward-scattering phase (a mote between the eye and a light shines brighter). Motes are pixel-floored
 * points: what is smaller than a pixel is paid back in brightness, so they never shimmer.
 */
import * as THREE from 'three/webgpu';
import { Fn, Loop, cameraPosition, clamp, exp, float, hash, instanceIndex, length, max, normalize, pow, sin, step, uniformArray, uv, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from './billboard';
import { randomDir } from './pairModel';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

type V4 = THREE.Node<'vec4'>;

export const DUST_LIGHTS = 12;

export interface DustUniforms {
  time: F;
  pixelAngle: F;
  /** world centre of the mote ball and its radius */
  centre: V3;
  radius: F;
  /** 0..1 how much dust there is (the medium thins as the universe cools) */
  density: F;
  radiance: F;
}

export interface Dust {
  readonly mesh: THREE.InstancedMesh;
  setLights(lights: Array<{ pos: [number, number, number]; colour: [number, number, number] }>): void;
  dispose(): void;
}

export function createDust(count: number, U: DustUniforms): Dust {
  const lightPos = uniformArray(Array.from({ length: DUST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const lightCol = uniformArray(Array.from({ length: DUST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const i = float(instanceIndex);
  const dir = randomDir(hash(i.mul(1.31).add(0.07)), hash(i.mul(2.17).add(0.41)));
  // denser near the audience (cube-root would be uniform; a softer power puts more motes close by)
  const r = pow(hash(i.mul(3.73).add(0.29)), float(0.55)).mul(U.radius).add(0.6);
  const wobble = vec3(sin(U.time.mul(0.21).add(i)), sin(U.time.mul(0.17).add(i.mul(1.3))), sin(U.time.mul(0.13).add(i.mul(2.1)))).mul(0.04);
  const pos = U.centre.add(dir.mul(r)).add(wobble);
  const toEye = cameraPosition.sub(pos);
  const dist = toEye.length();
  const view = normalize(toEye);
  const lit = vec3(0).toVar();
  Loop(DUST_LIGHTS, ({ i: j }) => {
    const L = lightPos.element(j) as unknown as V4;
    const C = lightCol.element(j) as unknown as V4;
    const d = L.xyz.sub(pos);
    const r2 = d.dot(d).add(0.05);
    // forward scattering: a mote seen against a light glows (cosT → 1 when the light is behind it)
    const cosT = normalize(d).dot(view.negate());
    const phase = float(0.35).add(pow(cosT.mul(0.5).add(0.5), float(6)).mul(2.5));
    lit.addAssign(C.xyz.mul(phase).div(r2));
  });
  const present = step(hash(i.mul(5.11)), U.density);
  const size = float(0.035).mul(hash(i.mul(6.7)).mul(1.5).add(0.5));
  const drawn = max(size, U.pixelAngle.mul(1.3).mul(dist));
  const coverage = size.div(drawn).pow(2);
  const alpha = present.mul(coverage).mul(clamp(length(lit), 0, 1e6).greaterThan(1e-4).select(float(1), float(0)));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, drawn.mul(step(1e-6, alpha)));
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const core = exp(q.dot(q).mul(5).negate());
    return vec4(lit.mul(U.radiance).mul(alpha).mul(core), 1);
  })();
  material.name = 'undertime-dust';
  const mesh = billboardMesh(material, count, 'undertime-dust');
  mesh.geometry.deleteAttribute('normal');
  return {
    mesh,
    setLights(lights) {
      for (let j = 0; j < DUST_LIGHTS; j++) {
        const l = lights[j];
        (lightPos.array[j] as THREE.Vector4).set(l ? l.pos[0] : 0, l ? l.pos[1] : 0, l ? l.pos[2] : 0, 0);
        (lightCol.array[j] as THREE.Vector4).set(l ? l.colour[0] : 0, l ? l.colour[1] : 0, l ? l.colour[2] : 0, 0);
      }
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
