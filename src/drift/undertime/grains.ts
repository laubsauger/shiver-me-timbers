/**
 * Undertime's remainder: the grains of matter the cancelling left (U4), the web they lie on (U5), and the
 * first stars it makes (U6).
 *
 * SELF-SIMILAR PULL-BACK. Scaling a world about the eye changes nothing the eye can see, so the zoom scales
 * the world about the HERO GRAIN in front — which is the camera flying away from it at exponential speed:
 * everything flows toward the grain and shrinks. To keep the sky populated, grains come in LEVELS: level L
 * is the same kind of field ten times larger (positions and sizes ×10^L, its own rotation), so as level L
 * shrinks into the pivot, level L+1 arrives from all around at the size L had. A level fades in and out by
 * its apparent scale a = 10^L · s, so the flow reads as one endless pull-back, never a cut.
 *
 * THE WEB. Level 0 is the scatter the wave left; higher levels lie increasingly on filaments between the
 * knots of a jittered lattice (a cosmic web, cheaply: neighbours on a lattice are always near each other).
 * In the gather beat the knots of the levels that fill the sky at the end of the zoom ignite one by one as
 * the first stars; the hero grain, which everything converged on, is the first.
 *
 * COMFORT. The pivot never moves on the dome: the eye has a fixed point to rest on while everything else
 * flows toward it (the timeline caps the flow rate, tests/undertimeTimeline.test.ts).
 *
 * Every size has a floor of about a pixel (the minimum projected width tracks.ts uses), paid back as
 * brightness: a receding grain becomes a fainter point instead of a flickering sub-pixel one.
 */
import * as THREE from 'three/webgpu';
import { Fn, PI, abs, attribute, cameraPosition, clamp, cos, cross, exp, float, floor, hash, instanceIndex, length, max, min, mix, normalize, pow, sin, smoothstep, step, uv, vec3, vec4 } from 'three/tsl';
import { pocketMask, type PocketUniforms } from './pairModel';
import { billboardMesh, eyeFacing } from './billboard';
import { stripGeometry } from './tracks';
import { buildWeb, placeGrains, rng, type Web } from './web';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * Which levels exist for a zoom of `decades`: level D fills the sky at the end and level D + 1 is arriving,
 * so the grains need levels 0..D+1, the threads the web levels around the end, the stars those two.
 */
export function grainLevels(decades: number): { count: number; threads: number[]; stars: number[] } {
  const D = Math.max(1, Math.round(decades));
  return { count: D + 2, threads: [D - 1, D, D + 1], stars: [D, D + 1] };
}

/** share of a level's grains that lie on its web: level 0 is the wave's scatter, the web emerges above it */
const webShare = (L: number): number => (L === 0 ? 0 : L === 1 ? 0.6 : 0.92);
const levelWeb = (L: number): Web => buildWeb(1009 + L * 7919, 46);

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
  /** 0..1 how far the web's threads have emerged */
  web: F;
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
}

/** pattern space → world for level L at world scale s */
function toWorld(p: V3, L: F, U: GrainUniforms): V3 {
  return U.pivot.add(p.mul(U.radius.mul(pow(float(10), L)).mul(U.scale)));
}

/** 0..1 presence of level L at its apparent scale a = 10^L · s: arriving from far, gone into the pivot */
function levelPresence(L: F, U: GrainUniforms): F {
  const a = pow(float(10), L).mul(U.scale);
  // levels above 0 exist only once the pull-back has begun (U4 is level 0 alone: "very few")
  const begun = mix(smoothstep(1, 0.6, U.scale), float(1), step(L, 0.5));
  return smoothstep(16, 6, a).mul(smoothstep(0.02, 0.12, a)).mul(begun);
}

/** size floor of ~1.2 px at `dist`, and the brightness that pays the widening back (area ratio) */
function floored(wanted: F, dist: F, U: GrainUniforms): { size: F; coverage: F } {
  const drawn = max(wanted, U.pixelAngle.mul(1.2).mul(dist));
  const k = wanted.div(drawn);
  return { size: drawn, coverage: k.mul(k) };
}

function instanced(mesh: THREE.InstancedMesh, name: string, data: Float32Array, size: number): void {
  mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, size));
}

export function createGrains(count: number, U: GrainUniforms, decades: number): THREE.InstancedMesh {
  const levels = grainLevels(decades).count;
  const per = Math.floor(count / levels);
  // per grain: pattern position, and (level, kind, size jitter, appear order)
  const gPos = new Float32Array(per * levels * 3);
  const gInfo = new Float32Array(per * levels * 4);
  for (let L = 0; L < levels; L++) {
    const { pos, kind } = placeGrains(levelWeb(L), per, webShare(L), 31 + L);
    const r = rng(77 + L);
    for (let i = 0; i < per; i++) {
      const j = L * per + i;
      gPos.set(pos.subarray(i * 3, i * 3 + 3), j * 3);
      gInfo.set([L, kind[i], r(), r()], j * 4);
    }
  }
  const pattern = attribute<'vec3'>('grainPos', 'vec3');
  const info = attribute<'vec4'>('grainInfo', 'vec4');
  const L = info.x;
  const kind = info.y;
  const j = float(instanceIndex);

  const wander = vec3(sin(U.time.mul(0.11).add(j)), sin(U.time.mul(0.13).add(j.mul(1.7))), cos(U.time.mul(0.09).add(j.mul(2.3)))).mul(0.25).mul(U.scale);
  const pos = toWorld(pattern, L, U).add(wander);
  const dist = pos.sub(U.eye).length();

  // level 0 appears grain by grain through U4 (a few, then a few more), and fills out as the pull-back begins
  const share = mix(U.reveal.mul(0.12), float(1), U.fill);
  const appear = info.w;
  const present = smoothstep(appear, appear.add(0.02), share).mul(levelPresence(L, U));
  // knots brighter than the threads between them, voids dimmest, so the structure reads
  const weight = mix(mix(float(0.55), float(0.5), step(0.25, kind)), float(1.3), step(0.75, kind)).mul(mix(float(1), float(1.6), step(L, 0.5)));
  const wanted = U.size.mul(pow(float(10), L)).mul(U.scale).mul(info.z.mul(0.8).add(0.6)).mul(mix(float(1), float(0.6), step(0.25, kind)));
  const f = floored(wanted, dist, U);
  // a few grains on the web ignite with the knots: the first stars are many, not one per knot
  const ignites = step(0.955, info.z).mul(step(0.25, kind));
  const t0 = info.w.mul(0.8).add(0.1);
  const lit = ignites.mul(smoothstep(t0, t0.add(0.06), U.stars));
  const alpha = present
    .mul(weight)
    .mul(f.coverage)
    .mul(lit.mul(9).add(1))
    // dim (not gone) behind the crawl; never one across the eye (a grain within ~15 of its sizes is a blur)
    .mul(float(1).sub(pocketMask(pos.sub(U.eye), U).mul(0.85)))
    .mul(smoothstep(wanted.mul(12), wanted.mul(40), dist));
  const tint = mix(U.warm, mix(vec3(0.75, 0.85, 1), U.star, hash(j.mul(0.37))), lit);

  const material = additive('undertime-grains');
  material.positionNode = eyeFacing(pos, f.size.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    return vec4(tint.mul(U.radiance).mul(alpha).mul(float(1).sub(r).pow(2.5)), 1);
  })();
  const mesh = billboardMesh(material, per * levels, 'undertime-grains');
  instanced(mesh, 'grainPos', gPos, 3);
  instanced(mesh, 'grainInfo', gInfo, 4);
  return mesh;
}

/**
 * The web's threads: a faint ribbon along every filament of the web levels, under the grains that lie on
 * it — what makes the structure read as a web at a glance rather than a scatter. Bowed, never straight;
 * clumped along its length; emerging through the pull-back (`web`).
 */
export function createThreads(U: GrainUniforms, threadRadiance: F, decades: number): THREE.InstancedMesh {
  const levels = grainLevels(decades).threads;
  const a: number[] = [];
  const c: number[] = [];
  const b: number[] = [];
  for (const L of levels) {
    const w = levelWeb(L);
    for (const fl of w.filaments) {
      a.push(...w.knots[fl.a], L);
      c.push(...fl.c);
      b.push(...w.knots[fl.b]);
    }
  }
  const S = attribute<'float'>('trackS', 'float');
  const side = attribute<'float'>('trackSide', 'float');
  const A4 = attribute<'vec4'>('threadA', 'vec4');
  const L = A4.w;
  const k = float(instanceIndex);
  const A = toWorld(A4.xyz, L, U);
  const C = toWorld(attribute<'vec3'>('threadC', 'vec3'), L, U);
  const B = toWorld(attribute<'vec3'>('threadB', 'vec3'), L, U);
  const u1 = float(1).sub(S);
  const pos = A.mul(u1.mul(u1)).add(C.mul(u1.mul(S).mul(2))).add(B.mul(S.mul(S)));
  const tangent = C.sub(A).mul(u1).add(B.sub(C).mul(S));
  const toEye = pos.sub(cameraPosition);
  const across = normalize(cross(normalize(tangent), normalize(toEye)));
  const dist = toEye.length();
  // gas, not wire: a wide soft ribbon (its cross-section is a gaussian, so it reads as a glow)
  const wanted = U.radius.mul(pow(float(10), L)).mul(U.scale).mul(0.012);
  const f = floored(wanted, dist, U);
  // a thread passing close to the eye would be a wide smear across the dome: only far ones are drawn;
  // and a level shrinking into the pivot loses its threads first (a small web there reads as a cage)
  const far = smoothstep(wanted.mul(8), wanted.mul(25), dist).mul(smoothstep(0.15, 0.5, pow(float(10), L).mul(U.scale)));
  const clump = hash(floor(S.mul(11)).add(k.mul(5.3))).mul(0.5).add(0.5);
  const ends = smoothstep(0, 0.08, S).mul(smoothstep(1, 0.92, S));
  const alpha = levelPresence(L, U)
    .mul(U.web)
    .mul(far)
    .mul(clump)
    .mul(ends)
    .mul(f.coverage)
    .mul(float(1).sub(pocketMask(toEye, U).mul(0.85)))
    .mul(hash(k.mul(1.9).add(0.4)).mul(0.6).add(0.4));
  const material = additive('undertime-threads');
  material.positionNode = pos.add(across.mul(side.mul(f.size)));
  material.colorNode = Fn(() => {
    const glow = exp(side.mul(side).mul(4).negate()).sub(0.018).max(0);
    // the web's gas glows cooler than the warm grains on it: violet-blue, warming toward the knots
    const gas = mix(vec3(0.42, 0.4, 0.9), mix(U.warm, vec3(0.9, 0.5, 0.75), 0.4), float(1).sub(S.mul(2).sub(1).abs()).oneMinus().pow(2));
    return vec4(gas.mul(threadRadiance).mul(alpha).mul(glow), 1);
  })();
  const mesh = new THREE.InstancedMesh(stripGeometry(24), material, a.length / 4);
  instanced(mesh, 'threadA', new Float32Array(a), 4);
  instanced(mesh, 'threadC', new Float32Array(c), 3);
  instanced(mesh, 'threadB', new Float32Array(b), 3);
  mesh.frustumCulled = false;
  mesh.name = 'undertime-threads';
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

/** the first stars: knots of the star levels, igniting one by one through the gather beat */
export function createStars(U: GrainUniforms, decades: number): THREE.InstancedMesh {
  const knots: number[] = [];
  for (const L of grainLevels(decades).stars) for (const k of levelWeb(L).knots) knots.push(...k, L);
  const K = attribute<'vec4'>('starKnot', 'vec4');
  const L = K.w;
  const k = float(instanceIndex);
  const pos = toWorld(K.xyz, L, U);
  const seed = k.mul(3.31).add(0.5);
  // most knots ignite, each at its own moment, with a brief overshoot as it catches
  const lit = step(hash(seed), 0.85);
  const t0 = hash(seed.add(1.3)).mul(0.8).add(0.08);
  const on = smoothstep(t0, t0.add(0.05), U.stars);
  const catchFlare = exp(U.stars.sub(t0.add(0.03)).div(0.04).pow(2).negate()).mul(1.5);
  const bright = hash(seed.add(2.9)).pow(2).mul(0.8).add(0.2);
  const alpha = lit.mul(on.add(catchFlare.mul(on))).mul(bright).mul(levelPresence(L, U)).mul(float(1).sub(pocketMask(pos.sub(U.eye), U).mul(0.6)));
  // a point, not a disc: constant angular size whatever the distance
  const dist = pos.sub(U.eye).length();
  const size = dist.mul(STAR_HALF * 2);
  // the first stars were massive and hot: blue-white, some warm
  const blue = vec3(0.7, 0.8, 1);
  const tint = mix(blue, U.star, hash(seed.add(4.1)).pow(2));

  const material = additive('undertime-stars');
  material.positionNode = eyeFacing(pos, size.mul(step(0.0005, alpha)));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    return vec4(tint.mul(U.starRadiance).mul(alpha).mul(starLight(length(p), p.x, p.y, U.pixelAngle.div(STAR_HALF))).mul(0.05), 1);
  })();
  const mesh = billboardMesh(material, knots.length / 4, 'undertime-stars');
  instanced(mesh, 'starKnot', new Float32Array(knots), 4);
  return mesh;
}

/**
 * The hero grain: in front and up, the thing that remained. Warm, with a slow breath so it reads as
 * present rather than painted; it recedes with the pull-back like any grain, and is the first star to light.
 */
export function createHeroGrain(U: GrainUniforms): THREE.InstancedMesh {
  const dist = U.pivot.sub(U.eye).length();
  const breath = sin(U.time.mul(PI.mul(2 * 0.2))).mul(0.06).add(1);
  const wanted = U.size.mul(1.6).mul(U.scale);
  const f = floored(wanted, dist, U);
  // it keeps a little more presence than a plain grain while receding: the eye follows it into the web
  const grain = U.heroGrain.mul(max(f.coverage, min(float(1), U.scale.mul(40)).mul(0.25))).mul(breath);
  const ignite = smoothstep(0.02, 0.07, U.stars);
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
