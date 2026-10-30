/**
 * Undertime's remainder: the grains of matter the cancelling left (U4) and the first stars (U6). The web
 * they lie on (U5) is the volume of webVolume.ts.
 *
 * THE REMAINDER is a scatter about the HERO GRAIN in front: a few grains, then a few more; as the zoom pulls
 * back (the world scales about the grain, timeline.ts) they flow into it and the web's gas takes over.
 *
 * THE FIRST STARS ignite at the web's knots — its density peaks (scripts/drift-web-volume.py) — one by one
 * through the gather beat, placed by the same flight that places the gas (`eyePat`, `box`: the eye's place
 * in the web's box and its size in the world). The hero grain, which everything converged on, is the last.
 *
 * Every size has a floor of about a pixel (the minimum projected width tracks.ts uses), paid back as
 * brightness: a receding grain becomes a fainter point instead of a flickering sub-pixel one.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, abs, attribute, clamp, cos, exp, float, hash, instanceIndex, length, max, min, mix, sin, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { pocketMask, type PocketUniforms } from './pairModel';
import { billboardMesh, eyeFacing } from './billboard';
import { rng } from './web';
import type { WebKnot } from './webVolume';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface GrainUniforms extends PocketUniforms {
  time: F;
  eye: V3;
  /** world position of the hero grain: the zoom's pivot */
  pivot: V3;
  /** linear scale of the world about the pivot (timeline `scale`) */
  scale: F;
  /** 0..1 how many of level 0's grains have appeared (U4) */
  reveal: F;
  /** 0..1 the zoom's progress in decades (0 until it starts, 1 after one decade): fills level 0 out */
  fill: F;
  heroGrain: F;
  stars: F;
  radius: F;
  size: F;
  radiance: F;
  starRadiance: F;
  pixelAngle: F;
  /** the grains' colour (matter warmed toward starlight) */
  warm: V3;
  star: V3;
  /** the eye's place in the web's box, and the box's size in the world (timeline.ts webFlight, then the dive:
   * getTheDrift/webDive.ts), and the box's turn in the world (world = webToWorld · pattern; none: unturned) */
  eyePat: V3;
  box: F;
  webToWorld?: THREE.Node<'mat3'>;
}

/** the remainder's pattern (unit ball) → world: about the hero grain, shrinking into it with the zoom */
function toWorld(p: V3, U: GrainUniforms): V3 {
  return U.pivot.add(p.mul(U.radius.mul(U.scale)));
}

/** 0..1 the remainder's presence: there until the pull-back has carried it into the grain */
const remainderPresence = (U: GrainUniforms): F => smoothstep(0.08, 0.35, U.scale);

/** size floor of ~1.2 px at `dist`, and the brightness that pays the widening back (area ratio) */
function floored(wanted: F, dist: F, U: GrainUniforms): { size: F; coverage: F } {
  const drawn = max(wanted, U.pixelAngle.mul(1.2).mul(dist));
  const k = wanted.div(drawn);
  return { size: drawn, coverage: k.mul(k) };
}

function instanced(mesh: THREE.InstancedMesh, name: string, data: Float32Array, size: number): void {
  mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
}

export function createGrains(count: number, U: GrainUniforms): THREE.InstancedMesh {
  // per grain: its place in the remainder (unit ball), and (size jitter, appear order)
  const r = rng(31);
  const gPos = new Float32Array(count * 3);
  const gInfo = new Float32Array(count * 2);
  for (let i = 0; i < count; i++) {
    for (;;) {
      const q = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1];
      if (q[0] * q[0] + q[1] * q[1] + q[2] * q[2] <= 1) {
        gPos.set(q, i * 3);
        break;
      }
    }
    gInfo.set([r(), r()], i * 2);
  }
  const pattern = attribute<'vec3'>('grainPos', 'vec3');
  const info = attribute<'vec2'>('grainInfo', 'vec2');
  const j = float(instanceIndex);
  const wander = vec3(sin(U.time.mul(0.11).add(j)), sin(U.time.mul(0.13).add(j.mul(1.7))), cos(U.time.mul(0.09).add(j.mul(2.3)))).mul(0.08).mul(U.scale);
  const pos = toWorld(pattern, U).add(wander);
  const dist = pos.sub(U.eye).length();
  // the remainder appears grain by grain through U4 (a few, then a few more), filling out as the pull-back begins
  // (a quarter of the 12 % it was: the light wave now leaves its survivors on the dome, survivors.ts — they are the
  // "very few"; these are the scale the pull-back reveals)
  const share = mix(U.reveal.mul(0.03), float(1), U.fill);
  const present = smoothstep(info.y, info.y.add(0.02), share).mul(remainderPresence(U));
  const wanted = U.size.mul(U.scale).mul(info.x.mul(0.8).add(0.6));
  // a grain is a point of light, never a disc: capped at ~0.15° (a near disc reads as out-of-focus dirt)
  const f = floored(min(wanted, dist.mul(0.0026)), dist, U);
  const alpha = present
    .mul(0.6)
    .mul(f.coverage)
    // dim (not gone) behind the crawl; never one across the eye (a grain within ~15 of its sizes is a blur)
    .mul(float(1).sub(pocketMask(pos.sub(U.eye), U).mul(0.85)))
    .mul(smoothstep(wanted.mul(12), wanted.mul(40), dist));
  // pale matter; only the hero grain (createHeroGrain) is the act's amber
  const tint = mix(vec3(1, 0.92, 0.84), U.warm, hash(j.mul(0.53)).mul(0.3));

  const material = additive('undertime-grains');
  material.positionNode = eyeFacing(pos, f.size.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const rr = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    return vec4(tint.mul(U.radiance).mul(alpha).mul(float(1).sub(rr).pow(2.5)), 1);
  })();
  const mesh = billboardMesh(material, count, 'undertime-grains');
  instanced(mesh, 'grainPos', gPos, 3);
  instanced(mesh, 'grainInfo', gInfo, 2);
  return mesh;
}

/** a star's quad spans ±STAR_HALF rad around it: room for the halo and the glint */
const STAR_HALF = 0.03;

/**
 * Soft star in quad uv (±1): hot core, halo, faint four-point glint (all stars share its orientation, like
 * one lens). `px` is one pixel in those units: the core and the glint never get thinner than ~1.4 / 0.8 px,
 * and what they gain in size they give back in brightness, so a star is the same light at any resolution.
 */
function starLight(r: F, x: F, y: F, px: F): F {
  const rc = max(float(0.045), px.mul(1.4));
  const coreGain = float(0.045).div(rc).pow(2);
  const core = exp(r.div(rc).pow(2).negate()).mul(coreGain).mul(5);
  const halo = exp(r.div(0.35).pow(2).negate()).mul(0.3).add(exp(r.div(0.1).pow(2).negate()).mul(0.8));
  const sw = max(float(0.01), px.mul(0.8));
  const spikes = exp(abs(x).div(sw).pow(2).negate()).mul(exp(abs(y).mul(6).negate()))
    .add(exp(abs(y).div(sw).pow(2).negate()).mul(exp(abs(x).mul(6).negate())))
    .mul(float(0.01).div(sw))
    .mul(0.3);
  return core.add(halo).add(spikes).mul(float(1).sub(smoothstep(0.85, 1, r)));
}

/** the first stars: the web's knots, igniting one by one through the gather beat, the densest brightest */
export function createStars(U: GrainUniforms, knots: WebKnot[]): THREE.InstancedMesh {
  const top = Math.max(...knots.map((k) => k.density));
  const data = new Float32Array(knots.length * 4);
  knots.forEach((k, i) => data.set([...k.pos, k.density / top], i * 4));
  const K = attribute<'vec4'>('starKnot', 'vec4');
  const k = float(instanceIndex);
  // the knot's image nearest the eye, placed by the web's flight (and turned by its frame, as the gas is)
  const dp0 = K.xyz.sub(U.eyePat);
  const dp = dp0.sub(dp0.add(0.5).floor());
  const pos = U.eye.add((U.webToWorld ? U.webToWorld.mul(dp) : dp).mul(U.box));
  const seed = k.mul(3.31).add(0.5);
  // most knots ignite, each at its own moment, with a brief overshoot as it catches
  const lit = step(hash(seed), 0.88);
  const t0 = hash(seed.add(1.3)).mul(0.8).add(0.08);
  const on = smoothstep(t0, t0.add(0.05), U.stars);
  // (squared by hand: WGSL's pow of a negative base is undefined)
  const catchX = U.stars.sub(t0.add(0.03)).div(0.04);
  const catchFlare = exp(catchX.mul(catchX).negate()).mul(1.5);
  const bright = K.w.pow(0.6).mul(0.8).add(0.2);
  const alpha = lit.mul(on.add(catchFlare.mul(on))).mul(bright).mul(float(1).sub(pocketMask(pos.sub(U.eye), U).mul(0.75)));
  // a point, not a disc: constant angular size whatever the distance
  const dist = pos.sub(U.eye).length();
  const size = dist.mul(STAR_HALF * 2);
  // the first stars were massive and hot: blue-white, some warm
  const tint = mix(vec3(0.7, 0.8, 1), U.star, hash(seed.add(4.1)).pow(2));

  const material = additive('undertime-stars');
  material.positionNode = eyeFacing(pos, size.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    return vec4(tint.mul(U.starRadiance).mul(alpha).mul(starLight(length(p), p.x, p.y, U.pixelAngle.div(STAR_HALF))).mul(0.05), 1);
  })();
  const mesh = billboardMesh(material, knots.length, 'undertime-stars');
  instanced(mesh, 'starKnot', data, 4);
  return mesh;
}

/**
 * The hero grain: in front and up, the thing that remained — where the first light was and where the
 * survivor's matter track came to rest (scripted.ts). Amber, with a slow breath so it reads as present rather
 * than painted; it recedes with the pull-back like any grain, and is the last star to light.
 */
export function createHeroGrain(U: GrainUniforms): THREE.InstancedMesh {
  const dist = U.pivot.sub(U.eye).length();
  const breath = sin(U.time.mul(PI.mul(2 * 0.2))).mul(0.1).add(1);
  // a core of about half a degree, whatever its distance
  const wanted = min(U.size.mul(1.6).mul(U.scale), dist.mul(0.009));
  const f = floored(wanted, dist, U);
  // it keeps a little more presence than a plain grain while receding: the eye follows it into the web
  const grain = U.heroGrain.mul(max(f.coverage, min(float(1), U.scale.mul(40)).mul(0.25))).mul(breath);
  // it is the LAST star to light, above the signature: first light, the remainder and the last star are one place
  const ignite = smoothstep(0.88, 0.96, U.stars);
  const material = additive('undertime-hero-grain');
  // big enough quad for the star it becomes
  const size = max(f.size.mul(3), dist.mul(STAR_HALF * 2 * 1.4).mul(ignite));
  const px = U.pixelAngle.mul(dist).div(size.mul(0.5));
  material.positionNode = eyeFacing(U.pivot, size.mul(step(0.0005, grain.add(ignite))));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const r = length(p);
    const disc = exp(r.mul(3).pow(2).negate()).mul(1.6).add(exp(r.mul(9).pow(2).negate()).mul(3));
    const g = U.warm.mul(U.radiance).mul(grain).mul(disc);
    const s = mix(U.star, vec3(1, 0.95, 0.88), 0.5).mul(U.starRadiance).mul(ignite).mul(starLight(r, p.x, p.y, px)).mul(0.08);
    return vec4(g.add(s), 1);
  })();
  return billboardMesh(material, 1, 'undertime-hero-grain');
}

function additive(name: string): THREE.NodeMaterial {
  const m = new THREE.NodeMaterial();
  m.transparent = true;
  m.depthWrite = false;
  m.side = THREE.DoubleSide;
  m.blending = THREE.AdditiveBlending;
  m.name = name;
  return m;
}
