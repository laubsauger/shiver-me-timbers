/**
 * The moment of creation, with flesh on it (production-design.md, look-dev notes): where two photons meet,
 * a small TURBULENT FIREBALL — a textured ball of light that swells in a tenth of a second and cools as it
 * thins, white to gold to orange to a deep ember red — and a SPRAY of sparks thrown out of it, slowing as
 * they go. The pair's beads leave through it. The hero's is big; the field's are in proportion to their
 * energy (events.ts `burst`).
 *
 * Closed-form in act time like everything else; shaded from a tileable noise texture (mist.ts), so the
 * fireball is turbulent, never a disc. Sparks are stretched along their screen velocity (motion blur in
 * the geometry) and pixel-floored.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, exp, float, hash, max, min, mix, normalize, pow, smoothstep, step, texture, uv, vec2, vec3, vec4 } from 'three/tsl';
import type { PairEvent } from './events';
import { noiseTexture } from './mist';
import { randomDir } from './pairModel';

type F = THREE.Node<'float'>;

/** sparks per creation */
const SPARKS = 22;

export interface BurstUniforms {
  time: F;
  pixelAngle: F;
  radiance: F;
}

export interface Burst {
  readonly mesh: THREE.InstancedMesh;
  dispose(): void;
}

export function createBursts(events: readonly PairEvent[], U: BurstUniforms): Burst {
  const per = 1 + SPARKS;
  const n = events.length * per;
  const A = new Float32Array(n * 4);
  const V = new Float32Array(n * 4);
  events.forEach((e, i) => {
    for (let k = 0; k < per; k++) {
      A.set([e.birth, e.burst, e.energy, i * 17.13 + k], (i * per + k) * 4);
      V.set([...e.vertex, k], (i * per + k) * 4);
    }
  });
  const a = attribute<'vec4'>('burstA', 'vec4');
  const v = attribute<'vec4'>('burstV', 'vec4');
  const birth = a.x;
  const scale = a.y;
  const energy = a.z;
  const seed = a.w;
  const vertex = v.xyz;
  const isBall = step(v.w, 0.5);
  const age = U.time.sub(birth);

  // the fireball: swells fast, then keeps spreading slowly as it cools
  const R = scale.mul(float(1).sub(exp(age.max(0).div(0.09).negate()))).mul(age.max(0).mul(0.5).add(0.75));
  // a fireball cools on its own scale: the hero's lingers, the wave's small ones are gone in a breath
  const tau = scale.mul(0.35).add(0.12).min(0.5);
  const ballA = step(0, age).mul(exp(age.div(tau).negate())).mul(step(age, tau.mul(6)));
  // sparks: thrown out of it, slowing (drag), gone in under a second
  const dir = randomDir(hash(seed.mul(1.37)), hash(seed.mul(2.91)));
  const v0 = scale.mul(hash(seed.mul(4.7)).mul(5).add(2.5));
  const drag = 3.2;
  const travel = v0.mul(float(1).sub(exp(age.max(0).mul(-drag)))).div(drag);
  const sparkPos = vertex.add(dir.mul(travel));
  const speed = v0.mul(exp(age.max(0).mul(-drag)));
  const sparkA = step(0, age).mul(exp(age.div(tau.mul(0.7)).negate())).mul(step(age, 1.2)).mul(step(hash(seed.mul(8.3)), 0.85));

  const centre = mix(sparkPos, vertex, isBall);
  const toEye = cameraPosition.sub(centre);
  const dist = toEye.length();
  const view = normalize(toEye);
  const along0 = dir.sub(view.mul(dir.dot(view)));
  const alongLen = along0.length();
  const along = mix(normalize(view.cross(vec3(0, 1, 0.001))), along0.div(alongLen.max(1e-4)), float(1).sub(isBall));
  const acrossV = normalize(view.cross(along));
  const px = U.pixelAngle.mul(dist);
  const width = max(px.mul(1.5), mix(float(0.02), R.mul(2.2), isBall));
  const length = max(width, mix(speed.mul(0.06).mul(alongLen).add(0.02), R.mul(2.2), isBall));
  const alpha = mix(sparkA, ballA, isBall);
  const corner = attribute<'vec3'>('position', 'vec3');
  const noise = noiseTexture();
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = centre
    .add(along.mul(corner.y.mul(length)))
    .add(acrossV.mul(corner.x.mul(width)))
    .mul(step(0.0005, alpha))
    .add(centre.mul(float(1).sub(step(0.0005, alpha))));
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    // turbulence: two scales of noise, drifting as the ball churns, push its edge in and out
    const n1 = texture(noise, q.mul(0.45).add(vec2(hash(seed), age.mul(0.25)))).r;
    const n2 = texture(noise, q.mul(1.3).add(vec2(age.mul(-0.4), hash(seed.add(3.3))))).r;
    const rd = r.add(n1.sub(0.5).mul(0.55)).add(n2.sub(0.5).mul(0.25));
    const body = smoothstep(1, 0.25, rd);
    // temperature: hottest in the middle and at the start, cooling outward and with age
    const T = exp(age.div(0.22).negate()).mul(float(1).sub(rd).max(0)).mul(1.6).add(body.mul(0.15));
    const white = vec3(1, 0.97, 0.9);
    const gold = vec3(1, 0.72, 0.32);
    const orange = vec3(1, 0.36, 0.1);
    const ember = vec3(0.45, 0.06, 0.02);
    const ramp = mix(mix(ember, orange, smoothstep(0, 0.25, T)), mix(gold, white, smoothstep(0.7, 1.1, T)), smoothstep(0.25, 0.7, T));
    const ball = ramp.mul(body).mul(pow(T.max(0), float(1.2)).mul(6).add(0.03)).mul(float(1).sub(smoothstep(0.55, 0.9, r)));
    // a spark: a hot streak, brightest at its head
    const spark = mix(gold, white, exp(age.div(0.15).negate())).mul(exp(q.x.mul(q.x).mul(5).negate())).mul(smoothstep(-1, 1, q.y)).mul(8);
    const c = mix(spark, ball, isBall);
    return vec4(c.mul(U.radiance).mul(energy).mul(alpha).mul(min(float(1), mix(float(0.02), R.mul(2.2), isBall).div(width))), 1);
  })();
  material.name = 'undertime-bursts';
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.deleteAttribute('normal');
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  geometry.setAttribute('burstA', new THREE.InstancedBufferAttribute(A, 4));
  geometry.setAttribute('burstV', new THREE.InstancedBufferAttribute(V, 4));
  mesh.frustumCulled = false;
  mesh.name = 'undertime-bursts';
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
      noise.dispose();
    },
  };
}
