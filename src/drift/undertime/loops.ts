/**
 * Undertime's pairs drawn from the event list (events.ts), all closed-form in act time:
 *
 *   TRAILS   what a bubble chamber photographs: a row of tiny bubbles along each bead's path, bright and
 *            coloured where the bead has just passed, then cooling to pale gas, swelling and fading as they
 *            diffuse into the plasma. Strip geometry along the loop; the bubbles are a pattern along it.
 *   SPRITES  eight per pair: the two incoming photons, the creation burst, the two hot beads, the
 *            annihilation flash and the two outgoing gamma rays. Photons, beads and gammas are STRETCHED
 *            along their screen-projected velocity — motion blur in the geometry, so a fast thing reads as
 *            fast in every frame — and none of them is ever thinner than ~1.5 px.
 *
 * Everything faces the eye's POSITION (billboard.ts), so the six cube faces of the dome capture agree.
 * Depth: what is far is seen through the plasma, dimmed by its optical depth (`fog`).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  PI,
  attribute,
  cameraPosition,
  clamp,
  cos,
  exp,
  float,
  instanceIndex,
  max,
  min,
  mix,
  normalize,
  pow,
  sin,
  sqrt,
  smoothstep,
  step,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import type { PairEvent } from './events';
import { pocketMask, type PocketUniforms } from './pairModel';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface LoopUniforms {
  /** act s */
  time: F;
  pixelAngle: F;
  /** 1/m: extinction of the plasma (what is far is dimmer, warmer) */
  fog: F;
  matter: V3;
  anti: V3;
  light: V3;
  /** overall gains */
  trailRadiance: F;
  beadRadiance: F;
  flashRadiance: F;
  /** the text pocket (pairModel.ts): what is under the text NOW fades, so it reads on a calm sky */
  pocket: PocketUniforms;
  eye: V3;
}

/** m/s, the photons' and gammas' "speed of light" (fast against everything else, still followable) */
const C = 38;

/** per-pair attributes from the event list (instanced; `per` instances per pair) */
function packEvents(events: readonly PairEvent[]): Record<string, Float32Array> {
  const n = events.length;
  const a = new Float32Array(n * 4);
  const v = new Float32Array(n * 4);
  const x = new Float32Array(n * 4);
  const y = new Float32Array(n * 4);
  // WebGPU allows 8 vertex buffers: the gamma direction rides in the spare components of axis and across
  // (it is unit, so its third component is recovered with its sign packed into the across vector's w)
  events.forEach((e, i) => {
    a.set([e.birth, e.loop, e.open, e.radius], i * 4);
    v.set([...e.vertex, e.energy], i * 4);
    x.set([...e.axis, e.gamma[0]], i * 4);
    y.set([...e.across, e.gamma[1] + (e.gamma[2] < 0 ? 4 : 0)], i * 4);
  });
  const z = new Float32Array(n * 4);
  // w: the fraction of its loop the pair lives, signed: > 0 the beads meet at its end, < 0 each ends apart
  events.forEach((e, i) => z.set([e.spiral, e.drift, e.arc, e.end * (e.meets && e.end >= 1 ? 1 : -1)], i * 4));
  return { pairA: a, pairV: v, pairX: x, pairY: y, pairZ: z };
}

/** repeat each pair's attributes `per` times (instance k belongs to pair floor(k / per)) */
function expand(data: Record<string, Float32Array>, per: number): Record<string, Float32Array> {
  const out: Record<string, Float32Array> = {};
  for (const [name, src] of Object.entries(data)) {
    const n = src.length / 4;
    const dst = new Float32Array(n * per * 4);
    for (let i = 0; i < n; i++) for (let k = 0; k < per; k++) dst.set(src.subarray(i * 4, i * 4 + 4), (i * per + k) * 4);
    out[name] = dst;
  }
  return out;
}

interface PairNodes {
  birth: F;
  loop: F;
  open: F;
  radius: F;
  vertex: V3;
  energy: F;
  axis: V3;
  across: V3;
  gamma: V3;
  spiral: F;
  drift: F;
  arc: F;
  meets: F;
  /** fraction of the loop it lives (the wave cuts some short) */
  uEnd: F;
}

function pairNodes(): PairNodes {
  const a = attribute<'vec4'>('pairA', 'vec4');
  const v = attribute<'vec4'>('pairV', 'vec4');
  const x = attribute<'vec4'>('pairX', 'vec4');
  const y = attribute<'vec4'>('pairY', 'vec4');
  const neg = step(2, y.w);
  const gy = y.w.sub(neg.mul(4));
  const gz = sqrt(float(1).sub(x.w.mul(x.w)).sub(gy.mul(gy)).max(0)).mul(float(1).sub(neg.mul(2)));
  const z = attribute<'vec4'>('pairZ', 'vec4');
  return {
    birth: a.x,
    loop: a.y,
    open: a.z,
    radius: a.w,
    vertex: v.xyz,
    energy: v.w,
    axis: x.xyz,
    across: y.xyz,
    gamma: vec3(x.w, gy, gz),
    spiral: z.x,
    drift: z.y,
    arc: z.z,
    meets: step(0, z.w),
    uEnd: z.w.abs(),
  };
}

/** loopEase (events.ts) on the GPU */
const ease = (u: F): F => {
  const k = clamp(u, 0, 1);
  return float(1).sub(pow(float(1).sub(k), float(1.7))).mul(0.85).add(k.mul(0.15));
};

/** loopPoint (events.ts) on the GPU: bead q at arc fraction f (0 at the vertex, 1 at its end) */
export function arcPoint(P: Pick<PairNodes, 'vertex' | 'axis' | 'across' | 'open' | 'radius' | 'spiral' | 'drift' | 'arc'>, q: F, f: F): V3 {
  const phi = P.arc.mul(f);
  const theta = P.open.sub(PI.div(2)).add(phi);
  const r = P.radius.mul(exp(P.spiral.mul(phi).negate()));
  const x = P.radius.mul(sin(P.open)).negate().add(r.mul(cos(theta)));
  const y = P.radius.mul(cos(P.open)).add(r.mul(sin(theta))).mul(q);
  const z = P.drift.mul(float(1).sub(cos(PI.mul(f)))).mul(0.5);
  return P.vertex.add(P.axis.mul(x)).add(P.across.mul(y)).add(P.axis.cross(P.across).mul(z));
}

/** the bead's velocity direction at arc fraction f */
function arcTangent(P: PairNodes, q: F, f: F): V3 {
  const phi = P.arc.mul(f);
  const theta = P.open.sub(PI.div(2)).add(phi);
  const r = P.radius.mul(exp(P.spiral.mul(phi).negate()));
  // d/dφ of the spiral (radius shrinking), plus the drift along the normal per unit φ
  const dx = P.spiral.negate().mul(cos(theta)).sub(sin(theta)).mul(r);
  const dy = P.spiral.negate().mul(sin(theta)).add(cos(theta)).mul(r).mul(q);
  const dz = P.drift.mul(PI).mul(0.5).mul(sin(PI.mul(f))).div(P.arc.max(1e-3));
  return normalize(P.axis.mul(dx).add(P.across.mul(dy)).add(P.axis.cross(P.across).mul(dz)));
}

/** act time the bead reached arc fraction f (inverse of the ease, four Newton steps) */
function timeAt(P: PairNodes, f: F): F {
  let u: F = f;
  for (let i = 0; i < 4; i++) {
    const k = clamp(u, 0, 1);
    const g = ease(k).sub(f);
    const dg = float(1.7).mul(pow(float(1).sub(k).max(1e-3), float(0.7))).mul(0.85).add(0.15);
    u = clamp(k.sub(g.div(dg)), 0, 1);
  }
  return P.birth.add(u.mul(P.loop));
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

/** a strip of `segments` quads with s ∈ [0, 1] along it and side = ±1 across */
function strip(segments: number): THREE.BufferGeometry {
  const n = (segments + 1) * 2;
  const s = new Float32Array(n);
  const side = new Float32Array(n);
  for (let i = 0; i <= segments; i++) {
    s[i * 2] = s[i * 2 + 1] = i / segments;
    side[i * 2] = -1;
    side[i * 2 + 1] = 1;
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  const sv = new Float32Array(n * 2);
  for (let i = 0; i < n; i++) sv.set([s[i], side[i]], i * 2);
  g.setAttribute('loopSV', new THREE.BufferAttribute(sv, 2));
  g.setIndex(index);
  return g;
}

export function createLoopTrails(events: readonly PairEvent[], U: LoopUniforms): THREE.InstancedMesh {
  const P = pairNodes();
  const SV = attribute<'vec2'>('loopSV', 'vec2');
  const S = SV.x;
  const side = SV.y;
  const k = float(instanceIndex);
  const q = float(1).sub(k.mod(2).mul(2)); // +1 matter, −1 antimatter
  const pos = arcPoint(P, q, S);
  const tangent = arcTangent(P, q, S);
  const toEye = cameraPosition.sub(pos);
  const dist = toEye.length();
  const acrossView = normalize(tangent.cross(toEye));
  // where the bead is now, and how long ago it passed this point of its path
  const head = ease(U.time.sub(P.birth).div(P.loop).min(P.uEnd));
  const passed = step(S, head).mul(step(P.birth, U.time));
  const age = U.time.sub(timeAt(P, S)).max(0);
  // a luminous trail: the ribbon spans the GLOW (it widens a little as the energy spreads); the core is a
  // narrow profile inside it
  // (the ribbon is a little wider than the glow reads, so the glow's falloff reaches zero inside it: a glow
  // clipped at the ribbon's edge shows as a hard band)
  const glowWidth = float(0.09).add(age.mul(0.05)).mul(P.energy.mul(0.5).add(0.7)).mul(1.35);
  const drawn = max(glowWidth, U.pixelAngle.mul(3).mul(dist));
  const coverage = glowWidth.div(drawn);
  const alpha = passed.mul(coverage).mul(float(1).sub(pocketMask(pos.sub(U.eye), U.pocket).mul(0.85)));
  const material = additive('undertime-loop-trails');
  material.positionNode = pos.add(acrossView.mul(side.mul(drawn).mul(step(0.0005, alpha.mul(exp(age.div(2.5).negate()))))));
  material.colorNode = Fn(() => {
    const core = exp(side.mul(side).div(0.02 / 1.35 ** 2).negate());
    // a gaussian that comes down to exactly zero at the ribbon's edge (same width as before the widening)
    const kg = 2.5 * 1.35 ** 2;
    const glow = exp(side.mul(side).mul(kg).negate()).sub(Math.exp(-kg)).div(1 - Math.exp(-kg)).max(0);
    // the energy fades and, as it does, the trail breaks up into fragments before it is gone
    // a smooth, LATE dissolve: the loop reads whole for a second, then thins out unevenly along its length
    const arcLen = P.radius.mul(P.arc);
    const along = S.mul(arcLen).div(0.5).add(k.mul(3.1));
    const noise = sin(along).mul(0.5).add(sin(along.mul(2.3).add(1.7)).mul(0.3)).mul(0.5).add(0.5);
    const breakup = mix(float(1), noise.mul(noise), smoothstep(0.9, 2.4, age));
    const tint = mix(U.matter, U.anti, step(q, 0));
    const hot = exp(age.div(0.12).negate());
    // a trail fades on its pair's own time scale: a long loop's lingers, a quick one's (the wave's) is gone
    const tau = P.loop.mul(0.35).add(0.25).min(1.1);
    const coreC = mix(tint, vec3(1, 0.97, 0.92), hot.mul(0.8)).mul(core).mul(exp(age.div(tau).negate())).mul(5);
    const glowC = tint.mul(glow).mul(exp(age.div(tau.mul(2)).negate())).mul(0.35);
    return vec4(coreC.add(glowC).mul(breakup).mul(U.trailRadiance).mul(P.energy).mul(alpha).mul(exp(U.fog.mul(dist).negate())), 1);
  })();
  const mesh = new THREE.InstancedMesh(strip(128), material, events.length * 2);
  for (const [name, data] of Object.entries(expand(packEvents(events), 2))) mesh.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, 4));
  mesh.frustumCulled = false;
  mesh.name = 'undertime-loop-trails';
  return mesh;
}

/**
 * kind 0, 1: incoming photons · 2: creation burst · 3, 4: beads · 5, 8: annihilation flashes (one where a
 * loop's beads meet; one at each end of a spiral) · 6, 7: gammas, from the meeting point or each end.
 * A sprite is a quad stretched along `along` (unit, world) by `length` and `width` across, facing the eye.
 */
export function createLoopSprites(events: readonly PairEvent[], U: LoopUniforms): THREE.InstancedMesh {
  const P = pairNodes();
  const k = float(instanceIndex.mod(9));
  const is = (a: number, b = a): F => step(a - 0.5, k).mul(step(k, b + 0.5));
  const sgn = float(1).sub(k.mod(2).mul(2)).negate(); // −1 / +1 alternating
  const age = U.time.sub(P.birth);
  const life = P.loop.mul(P.uEnd);
  const since = age.sub(life);
  const fEnd = ease(P.uEnd);
  const endM = arcPoint(P, float(1), fEnd);
  const endA = arcPoint(P, float(-1), fEnd);
  // photons: approaching the vertex from ±across, gone at the meeting
  const photonHead = P.vertex.add(P.across.mul(sgn.mul(C).mul(age.negate().max(0))));
  const rayKept = smoothstep(0.45, 0.6, P.energy);
  const photonA = smoothstep(-0.9, -0.5, age).mul(step(age, 0)).mul(rayKept);
  // beads
  const bq = mix(float(1), float(-1), is(4));
  const u = age.div(P.loop);
  const f = ease(u);
  const bead = arcPoint(P, bq, f);
  const beadDir = arcTangent(P, bq, f);
  const fdot = float(0.85 * 1.7).mul(pow(float(1).sub(clamp(u, 0, 1)).max(1e-3), float(0.7))).add(0.15);
  const beadSpeed = P.radius.mul(exp(P.spiral.mul(P.arc).mul(f).negate())).mul(P.arc).mul(fdot).div(P.loop);
  const beadA = step(0, age).mul(step(age, life)).mul(smoothstep(0, 0.08, age));
  // gammas: leaving the meeting point back to back (or, for a spiral, one from each end)
  const gammaFrom = mix(endM, mix(endM, endA, is(7)), float(1).sub(P.meets));
  const gammaHead = gammaFrom.add(P.gamma.mul(sgn.mul(C).mul(since.max(0))));
  const gammaA = step(0, since).mul(exp(since.div(0.7).negate())).mul(smoothstep(1.6, 1.1, since)).mul(rayKept);
  // bursts
  const burstA = step(0, age).mul(exp(age.div(0.16).negate())).mul(step(age, 0.8));
  const flashA = step(0, since).mul(exp(since.div(0.22).negate()).add(exp(since.div(0.9).negate()).mul(0.04))).mul(step(since, 2.5))
    // a spiral's two flashes share the light; a loop has only the one
    .mul(mix(float(0.6), float(1), P.meets));

  const isPhoton = is(0, 1);
  const isBurst = is(2);
  const isBead = is(3, 4);
  const isFlash = is(5).add(is(8).mul(float(1).sub(P.meets)));
  const flashAt = mix(endM, endA, is(8));
  const isGamma = is(6, 7);
  const centre = photonHead.mul(isPhoton).add(P.vertex.mul(isBurst)).add(bead.mul(isBead)).add(flashAt.mul(isFlash)).add(gammaHead.mul(isGamma));
  const alpha = photonA.mul(isPhoton).add(burstA.mul(isBurst)).add(beadA.mul(isBead)).add(flashA.mul(isFlash)).add(gammaA.mul(isGamma))
    .mul(float(1).sub(pocketMask(centre.sub(U.eye), U.pocket).mul(0.8)));
  const lightDir = P.across.mul(sgn.negate()).mul(isPhoton).add(beadDir.mul(isBead)).add(P.gamma.mul(sgn).mul(isGamma)).add(P.axis.mul(isBurst.add(isFlash)));
  const toEye = cameraPosition.sub(centre);
  const dist = toEye.length();
  const view = normalize(toEye);
  // the velocity seen across the line of sight is what streaks; along it nothing does
  const along0 = lightDir.sub(view.mul(lightDir.dot(view)));
  const alongLen = along0.length();
  const along = along0.div(alongLen.max(1e-4));
  const acrossV = normalize(view.cross(along));
  const px = U.pixelAngle.mul(dist);
  // sizes (m): streak length is the travel during ~1/40 s plus a short tail for light, a bead's blur
  // light RAYS: a photon or gamma is drawn as the whole path it has travelled (up to 14 m), brightest at its
  // head — a beam crossing the dome, not a dash
  // rays only from the more energetic pairs (a busy field is not a web of lines); the hero's run long
  const reach = mix(float(5), float(16), smoothstep(0.85, 1, P.energy));
  const travelled = mix(age.add(0.9).max(0), since.max(0), isGamma).mul(C).min(reach);
  const streak = travelled.mul(alongLen);
  const beadLen = beadSpeed.mul(1 / 40).mul(alongLen);
  // flashes and bursts are capped in APPARENT size: a near one is bright, never a blinding blob
  const flashW = min(float(1.2), dist.mul(0.09));
  const burstW = min(float(0.5), dist.mul(0.05));
  const width = max(px.mul(1.5), isBead.mul(0.3).add(isPhoton.add(isGamma).mul(0.035)).add(isBurst.mul(burstW)).add(isFlash.mul(flashW)));
  const length = max(width, streak.mul(isPhoton.add(isGamma)).add(beadLen.mul(isBead)));
  const corner = attribute<'vec3'>('position', 'vec3');
  const material = additive('undertime-loop-sprites');
  // streaks sit BEHIND their head (the tail trails the motion); bursts and beads are centred
  const back = isPhoton.add(isGamma).mul(0.5);
  material.positionNode = centre
    .sub(along.mul(length.mul(back)))
    .add(along.mul(corner.y.mul(length)))
    .add(acrossV.mul(corner.x.mul(width)))
    .mul(step(0.0005, alpha))
    .add(centre.mul(float(1).sub(step(0.0005, alpha))));
  const tint = mix(U.matter, U.anti, is(4));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const rx = p.x;
    const ry = p.y;
    // streaks: brightest at the head end (uv.y = 1), fading down the tail
    const streakShape = exp(rx.mul(rx).mul(5).negate()).mul(smoothstep(-1, 1, ry).pow(2));
    // a round light, gone well before the quad's edge (no square flashes)
    const edge = float(1).sub(smoothstep(0.6, 1, p.length()));
    const disc = exp(p.dot(p).mul(14).negate()).mul(2).add(exp(p.dot(p).mul(4).negate()).mul(0.2)).mul(edge);
    const photonC = vec3(0.85, 0.9, 1).mul(streakShape).mul(40);
    // a hot bead: a white core in a coloured glow
    const beadGlow = exp(p.dot(p).mul(3).negate()).mul(float(1).sub(smoothstep(0.7, 1, p.length())));
    const beadC = tint.mul(beadGlow).mul(2.2).add(vec3(1, 0.97, 0.92).mul(exp(p.dot(p).mul(60).negate())).mul(20));
    const burstC = U.light.mul(disc).mul(30);
    const flashC = U.light.mul(disc).mul(60);
    const gammaC = vec3(1, 0.97, 0.9).mul(streakShape).mul(30);
    const c = photonC.mul(isPhoton).mul(U.flashRadiance)
      .add(beadC.mul(isBead).mul(U.beadRadiance))
      .add(burstC.mul(isBurst).mul(U.flashRadiance))
      .add(flashC.mul(isFlash).mul(U.flashRadiance))
      .add(gammaC.mul(isGamma).mul(U.flashRadiance));
    // what is thinner than a pixel is paid back in brightness (energy kept, no shimmer)
    const coverage = min(float(1), isBead.mul(0.3).add(isPhoton.add(isGamma).mul(0.035)).add(isBurst.mul(burstW)).add(isFlash.mul(flashW)).div(width));
    return vec4(c.mul(P.energy).mul(alpha).mul(coverage).mul(exp(U.fog.mul(dist).negate())), 1);
  })();
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.deleteAttribute('normal');
  const mesh = new THREE.InstancedMesh(geometry, material, events.length * 9);
  for (const [name, data] of Object.entries(expand(packEvents(events), 9))) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, 4));
  mesh.frustumCulled = false;
  mesh.name = 'undertime-loop-sprites';
  return mesh;
}
