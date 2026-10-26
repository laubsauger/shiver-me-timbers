/**
 * U3's front, made of annihilations: thousands of short gold-white sparks per second, each lighting the
 * moment the front's ragged edge reaches its direction (pairModel.ts waveFrac — the same edge the sky's band
 * and the field's pairs die on), each gone in a quarter of a second. The front is the place where
 * everything cancels, so it is built from cancellations, not painted on.
 *
 * Sparks are spread over the dome's upper hemisphere only (below the spring line nobody sees them), at a
 * range of distances so the front has depth, and pixel-floored so none of them shimmer.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, acos, clamp, exp, float, hash, instanceIndex, length, max, smoothstep, step, uv, vec4 } from 'three/tsl';
import { randomDir, waveFrac } from './pairModel';
import { billboardMesh, eyeFacing } from './billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface WaveUniforms {
  /** act time, and the wave's start and length in act time */
  time: F;
  start: F;
  length: F;
  eye: V3;
  domeAxis: V3;
  domeFront: V3;
  light: V3;
  radiance: F;
  pixelAngle: F;
}

export function createWaveSparks(count: number, U: WaveUniforms): THREE.InstancedMesh {
  const i = float(instanceIndex);
  const raw = randomDir(hash(i.mul(1.913).add(0.17)), hash(i.mul(2.671).add(0.53)));
  // mirrored into the dome's upper hemisphere
  const d = raw.mul(raw.dot(U.domeAxis).sign().add(0.0001).sign());
  const hit = U.start.add(waveFrac(d, U.domeFront).mul(U.length)).add(hash(i.mul(3.37)).mul(0.1));
  const age = U.time.sub(hit);
  const flash = step(0, age).mul(exp(age.div(0.06).negate()).add(exp(age.div(0.14).negate()).mul(0.15)));
  const theta = acos(d.dot(U.domeFront).clamp(-1, 1));
  const behind = float(1).sub(smoothstep(PI.mul(0.55), PI.mul(0.72), theta).mul(0.5));
  const bright = hash(i.mul(4.19)).pow(3).mul(3).add(0.3);
  // gone within ~0.3 s: behind the front the dome returns to black, no residue
  const alpha = flash.mul(behind).mul(bright).mul(step(age, 0.3));
  const dist = hash(i.mul(5.71)).mul(22).add(6);
  const pos = U.eye.add(d.mul(dist));
  const quad = max(dist.mul(U.pixelAngle).mul(4), dist.mul(0.014).mul(hash(i.mul(6.1)).mul(1.2).add(0.4)));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, quad.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    const core = exp(r.div(0.16).pow(2).negate()).add(exp(r.div(0.5).pow(2).negate()).mul(0.12)).mul(float(1).sub(smoothstep(0.75, 1, r)));
    return vec4(U.light.mul(U.radiance).mul(alpha).mul(core), 1);
  })();
  material.name = 'undertime-wave-sparks';
  return billboardMesh(material, count, 'undertime-wave-sparks');
}
