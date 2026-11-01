/**
 * COLLISIONS AS EVENTS (the 2026-11-01 brief: "each annihilation briefly lights its neighbours; a faint expanding
 * shock ring and decaying afterglow"). The flash of an annihilation (loops.ts) already lights the medium around it
 * (events.ts eventLights → dust.ts, depth.ts); what it lacked was a SHAPE to its moment and a memory after it:
 *
 *   RING       the light of the annihilation leaving through the medium: a spherical shell, which a viewer sees as its
 *              limb — a thin circle facing the eye, centred on the event (the same reason the quads face the eye's
 *              position, billboard.ts). It decelerates as it spreads (radius ∝ 1 − e^(−age/0.35 s), out to 0.6–3.5 m
 *              by the event's energy) and fades as it goes (e-fold 0.3 s, gone by 1.6 s). Faint, neutral gold-white:
 *              the colour script's annihilation light, never a coloured ring (direction.md: coloured rings read as a
 *              logo). Never thinner than ~1.5 px; what it gains in width it gives back in brightness.
 *   AFTERGLOW  where it happened, a POINT that cools — white, gold, ember — over ~1.2 s: the field remembers each
 *              collision for a breath. A point-spread function sized in pixels (a Moffat core, α 1.6 px), never a
 *              disc (the user, 2026-11-01: "so blobby").
 *
 * Only the strong annihilations get them (energy ≥ RING_ENERGY, the field's and the score's hits, field.ts), a few
 * hundred over the act; the wave front's thousand have the front's own light. Both are spent behind the front like
 * every other light (waveFx.ts). Pure in act time: a ring's state is a function of its record and t.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, exp, float, max, min, mix, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { eyeFacing } from './billboard';
import { frontTime, spent, waveWarp, type WaveFxUniforms } from './waveFx';
import type { Vec3 } from '../../cine/domeMaster';

type F = THREE.Node<'float'>;

/** an annihilation worth a ring: act s, where, its strength (0..1) and the ring's widest radius (m) */
export interface Shock {
  t0: number;
  pos: Vec3;
  strength: number;
  radius: number;
}

/** the least energy (events.ts PairEvent.energy) an annihilation needs for a ring */
export const RING_ENERGY = 0.6;

export interface ShockUniforms {
  time: F;
  pixelAngle: F;
  radiance: F;
  fx: WaveFxUniforms;
}

export function createShocks(shocks: readonly Shock[], U: ShockUniforms): { mesh: THREE.InstancedMesh; dispose(): void } {
  const n = Math.max(1, shocks.length);
  const A = new Float32Array(n * 4);
  const B = new Float32Array(n * 4);
  shocks.forEach((s, i) => {
    A.set([s.t0, s.strength, s.radius, 0], i * 4);
    B.set([...s.pos, 0], i * 4);
  });
  const a = attribute<'vec4'>('shockA', 'vec4');
  const b = attribute<'vec4'>('shockB', 'vec4');
  const t0 = a.x;
  const strength = a.y;
  const R = a.z;
  const at = b.xyz;
  const age = U.time.sub(t0);
  const live = step(0, age).mul(step(age, 1.6)).mul(spent(frontTime(at, U.fx), U.fx, 0.1));
  const centre = waveWarp(at, U.fx);
  const dist = cameraPosition.sub(centre).length();
  // the quad: the ring's widest, with room for its width
  const size = R.mul(2.3);
  const px = U.pixelAngle.mul(dist).div(size.mul(0.5));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(centre, size.mul(step(0.0005, live)));
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    const s = age.max(0);
    // the shell: decelerating out to 1/1.15 of the quad's half-width, thin, fading
    const rho = float(1).sub(exp(s.div(0.35).negate())).div(1.15);
    // (thin: at 0.012–0.047 of the quad, ~0.6° at 10 m, the first look drew a grey neon donut round every hit)
    const w0 = rho.mul(0.01).add(0.005);
    const w = max(w0, px.mul(1.5));
    const x = r.sub(rho).div(w);
    // (energy kept as it is floored: the floor's width is given back in brightness)
    const ring = exp(x.mul(x).negate()).mul(w0.div(w)).mul(exp(s.div(0.3).negate())).mul(smoothstep(0, 0.04, s)).mul(0.16);
    // the afterglow: a pixel-sized point at the centre, cooling white → gold → ember over ~1.2 s
    const al = max(px.mul(1.6), float(0.004));
    const heat = exp(s.div(0.4).negate());
    const point = float(1).add(r.div(al).pow(2)).pow(-2.5).mul(exp(s.div(0.55).negate())).mul(3);
    const ember = mix(mix(vec3(0.9, 0.24, 0.06), vec3(1, 0.72, 0.36), smoothstep(0.1, 0.5, heat)), vec3(1, 0.96, 0.9), smoothstep(0.55, 0.95, heat));
    const light = vec3(1, 0.93, 0.8).mul(ring).add(ember.mul(point));
    // windowed to nothing before the quad's edge
    return vec4(light.mul(strength).mul(U.radiance).mul(live).mul(smoothstep(1, 0.95, r)).mul(min(float(1), live.mul(1e3))), 1);
  })();
  material.name = 'undertime-shocks';
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.deleteAttribute('normal');
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  geometry.setAttribute('shockA', new THREE.InstancedBufferAttribute(A, 4));
  geometry.setAttribute('shockB', new THREE.InstancedBufferAttribute(B, 4));
  mesh.count = shocks.length;
  mesh.frustumCulled = false;
  mesh.name = 'undertime-shocks';
  return {
    mesh,
    dispose() {
      geometry.dispose();
      material.dispose();
    },
  };
}
