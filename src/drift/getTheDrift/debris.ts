/**
 * Drift-2 (direction-part-b.md, B5): what the flood lifted — beds of wood, debris, relics — floating on the
 * new sea and gathered by the currents into slow spirals, like galaxies on the water. The film's one shape
 * again: Drift-1's pair spirals, the galaxies, now the sea.
 *
 * STATELESS WINDING. Each vortex starts as streaks running out from its centre (debris washed off a coast);
 * the water turns faster near the centre than far out (Ω ∝ 1/(r + r0)), so every streak winds into a
 * trailing spiral arm — the same differential rotation that winds a galaxy's arms. A particle's angle is
 * θ0 + Ω(r)·τ, a pure function of its index and time, so any frame renders on its own.
 *
 * The field lies ON the planet: tangent-plane coordinates around a target point are wrapped onto the
 * sphere. Particles are pixel-floored points (a raft is a few metres; seen from tens of km it is a speck),
 * sunlit wood warm, pale debris catching glints.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, attribute, cameraPosition, clamp, cos, exp, float, hash, instanceIndex, length, max, normalize, pow, sin, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { rng } from '../undertime/web';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface DebrisUniforms {
  /** act s since the flood lifted the debris */
  time: F;
  /** 0..1 how much has floated free */
  presence: F;
  centre: V3;
  radius: F;
  /** unit: the target point's outward normal, and two tangents spanning its plane */
  up: V3;
  east: V3;
  north: V3;
  sun: V3;
  pixelAngle: F;
}

const VORTICES = 5;

export function createDebris(count: number, U: DebrisUniforms): THREE.InstancedMesh {
  // vortices scattered within ~120 km of the target point (units: Mm), each with its own size and turn
  const r = rng(2026);
  const vort = new Float32Array(VORTICES * 4);
  for (let v = 0; v < VORTICES; v++) {
    const a = r() * Math.PI * 2;
    const d = v === 0 ? 0 : 0.06 + r() * 0.16;
    vort.set([Math.cos(a) * d, Math.sin(a) * d, 0.03 + r() * 0.07, (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6)], v * 4);
  }
  const info = new Float32Array(count * 4);
  for (let i = 0; i < count; i++) {
    const v = Math.min(VORTICES - 1, Math.floor(Math.pow(r(), 1.6) * VORTICES));
    // streaks: a handful of directions per vortex, particles scattered along them (denser toward the centre)
    const streak = Math.floor(r() * 7);
    const along = Math.pow(r(), 0.7);
    info.set([v, streak, along, r()], i * 4);
  }
  const I = attribute<'vec4'>('debrisInfo', 'vec4');
  const k = float(instanceIndex);
  const vIndex = I.x;
  // per-vortex parameters, read by index from a small table baked into the shader
  const table = Array.from({ length: VORTICES }, (_, v) => vort.subarray(v * 4, v * 4 + 4));
  const pick = (c: number): F => {
    let out: F = float(table[0][c]);
    for (let v = 1; v < VORTICES; v++) out = step(v - 0.5, vIndex).mul(float(table[v][c]).sub(out)).add(out) as F;
    return out;
  };
  const cx = pick(0);
  const cy = pick(1);
  const size = pick(2);
  const spin = pick(3);
  const rad = I.z.mul(size).add(hash(k.mul(1.7)).mul(size.mul(0.08)));
  const theta0 = I.y.div(7).mul(PI.mul(2)).add(hash(vIndex.mul(3.1)).mul(6.28)).add(hash(k.mul(2.3)).sub(0.5).mul(0.25));
  // differential rotation: the inner water turns faster, winding each streak into a trailing arm
  // slow enough that a streak winds into two or three arms over the beat (fast winding draws rings)
  const omega = spin.mul(0.12).div(rad.div(size).add(0.25));
  const theta = theta0.add(omega.mul(U.time));
  const x = cx.add(cos(theta).mul(rad));
  const y = cy.add(sin(theta).mul(rad));
  // tangent plane → sphere, a hair above the water
  const flat = U.up.mul(U.radius).add(U.east.mul(x)).add(U.north.mul(y));
  const n = normalize(flat);
  const pos = U.centre.add(n.mul(U.radius.add(0.00002)));
  const dist = pos.sub(cameraPosition).length();
  // wood beds (most), pale debris, a few relics that catch the sun
  const kind = I.w;
  const wood = vec3(0.42, 0.27, 0.15);
  const pale = vec3(0.7, 0.68, 0.62);
  const colour = kind.lessThan(0.7).select(wood, pale);
  const day = smoothstep(-0.05, 0.2, n.dot(U.sun));
  const toEye = normalize(cameraPosition.sub(pos));
  const glint = pow(max(U.sun.add(toEye).normalize().dot(n), 0), float(300)).mul(step(0.92, kind)).mul(30);
  const wanted = float(0.00015).mul(hash(k.mul(4.4)).mul(1.5).add(0.5));
  const drawn = max(wanted, U.pixelAngle.mul(1.2).mul(dist));
  const coverage = wanted.div(drawn).pow(2).mul(40).min(1);
  const alpha = U.presence.mul(smoothstep(0, 0.05, I.z.sub(0.02))).mul(coverage);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, drawn.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const q = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    const light = colour.mul(day.mul(0.9).add(0.02)).add(vec3(1, 0.9, 0.7).mul(glint));
    return vec4(light.mul(alpha).mul(exp(q.mul(2.5).pow(2).negate())).mul(2.4), 1);
  })();
  material.name = 'drift-debris';
  const mesh = billboardMesh(material, count, 'drift-debris');
  mesh.geometry.setAttribute('debrisInfo', new THREE.InstancedBufferAttribute(info, 4));
  return mesh;
}
