/**
 * The products of Undertime's collisions (productModel.ts) drawn: annihilation stars and their kinks, delta rays,
 * jets and V0s. Closed-form in act time like the pairs (loops.ts), and drawn the same way so they belong to the
 * same chamber:
 *
 *   TRAILS   a strip along each track's whole path, lit from where it starts up to where the particle is now;
 *            a bright core in a coloured glow, white-hot just behind the head, fading on the track's own time
 *            scale and breaking up as it goes. Thinner than a pair's trail (these are the light, fast things).
 *   HEADS    the particle itself, a hot bead stretched along its screen velocity (motion blur in the geometry);
 *            and, for a particle that stops and decays, a pin-point flash where it ends.
 *
 * The light wave (waveFx.ts) acts on them as on the pairs: drawn where the front's pull puts them, frozen where it
 * reaches them and cooling in its afterglow. Pixel-floored throughout (nothing thinner than ~2 px: no shimmer).
 *
 * WebGPU's 8 vertex buffers: position + the strip's coordinate + the instance matrix + the five records below.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, cameraPosition, cos, exp, float, instanceIndex, max, min, mix, normalize, sin, smoothstep, sqrt, step, uv, vec3, vec4 } from 'three/tsl';
import { ANTI, LIGHT, MATTER, ROSE, SURVIVOR, TEAL, type ProductTrack } from './productModel';
import { pocketMask, type PocketUniforms } from './pairModel';
import type { Shades } from './loops';
import { afterglow, afterglowColour, frontTime, spent, waveWarp, type WaveFxUniforms } from './waveFx';
import { ribbonAcross, ribbonGlow, screenBend, spriteGlow, type GlowProfile } from './glow';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface ProductUniforms {
  time: F;
  pixelAngle: F;
  matter: V3;
  anti: V3;
  light: V3;
  /** the pions' own shades: rose (positive), teal (negative) */
  rose: V3;
  teal: V3;
  shades: Shades;
  radiance: F;
  /** 1/m, the plasma's extinction (loops.ts fog) */
  fog: F;
  pocket: PocketUniforms;
  eye: V3;
  fx?: WaveFxUniforms;
  /** the core-and-halo glow profile (glow.ts), as the pairs' */
  profile: GlowProfile;
}

function pack(tracks: readonly ProductTrack[], per: number): Record<string, Float32Array> {
  const n = tracks.length * per;
  const A = new Float32Array(n * 4);
  const B = new Float32Array(n * 4);
  const C = new Float32Array(n * 4);
  const D = new Float32Array(n * 4);
  const E = new Float32Array(n * 4);
  tracks.forEach((T, i) => {
    for (let k = 0; k < per; k++) {
      const j = (i * per + k) * 4;
      A.set([T.t0, T.life, T.radius, T.curl], j);
      B.set([...T.start, T.turn], j);
      C.set([...T.dir, T.pitch], j);
      D.set([...T.normal, T.energy], j);
      // (the end flash rides in the family as +8: the buffers are spent)
      E.set([T.q, T.family + (T.flash > 0.5 ? 8 : 0), T.shade, T.end], j);
    }
  });
  return { prodA: A, prodB: B, prodC: C, prodD: D, prodE: E };
}

interface TrackNodes {
  t0: F;
  life: F;
  radius: F;
  curl: F;
  start: V3;
  turn: F;
  dir: V3;
  pitch: F;
  normal: V3;
  energy: F;
  q: F;
  family: F;
  shade: F;
  flash: F;
  /** 0..1 of its life it runs (the wave cuts some short) */
  uEnd: F;
}

function trackNodes(): TrackNodes {
  const a = attribute<'vec4'>('prodA', 'vec4');
  const b = attribute<'vec4'>('prodB', 'vec4');
  const c = attribute<'vec4'>('prodC', 'vec4');
  const d = attribute<'vec4'>('prodD', 'vec4');
  const e = attribute<'vec4'>('prodE', 'vec4');
  return {
    t0: a.x, life: a.y, radius: a.z, curl: a.w, start: b.xyz, turn: b.w, dir: c.xyz, pitch: c.w, normal: d.xyz, energy: d.w,
    q: e.x, family: e.y.mod(8), shade: e.z, flash: step(7.5, e.y), uEnd: e.w,
  };
}

/** productModel.ts trackPoint on the GPU */
function trackPoint(T: TrackNodes, f: F): V3 {
  const phi = T.turn.mul(f.clamp(0, 1));
  const k = T.curl;
  const g = float(1).div(k.mul(k).add(1));
  const e = exp(k.mul(phi).negate());
  const x = T.radius.mul(g).mul(e.mul(sin(phi).sub(k.mul(cos(phi)))).add(k));
  const y = T.radius.mul(g).mul(float(1).sub(e.mul(cos(phi).add(k.mul(sin(phi))))));
  const s = T.radius.mul(float(1).sub(e)).div(k.max(1e-4));
  const side = T.normal.cross(T.dir).mul(T.q);
  return T.start.add(T.dir.mul(x)).add(side.mul(y)).add(T.normal.mul(T.pitch.mul(s)));
}

function trackTangent(T: TrackNodes, f: F): V3 {
  const phi = T.turn.mul(f.clamp(0, 1));
  const side = T.normal.cross(T.dir).mul(T.q);
  return normalize(T.dir.mul(cos(phi)).add(side.mul(sin(phi))).add(T.normal.mul(T.pitch)));
}

/** productModel.ts productEase and its inverse */
const ease = (u: F): F => {
  const k = u.clamp(0, 1);
  return float(1).sub(float(1).sub(k).mul(float(1).sub(k)));
};
const unease = (f: F): F => float(1).sub(sqrt(float(1).sub(f.clamp(0, 1))));

/** a track's colour: its family, at its shade (deep → pale) */
function trackColour(T: TrackNodes, U: ProductUniforms): V3 {
  const s = T.shade;
  const up = s.max(0);
  const down = s.negate().max(0);
  const is = (k: number): F => step(k - 0.5, T.family).mul(step(T.family, k + 0.5));
  const matter = mix(mix(U.matter, U.shades.deep, down), U.shades.pale, up);
  const anti = mix(mix(U.anti, U.shades.magenta, down), U.shades.cyan, up);
  const rose = mix(mix(U.rose, U.shades.deep, down.mul(0.5)), vec3(1, 0.86, 0.86), up.mul(0.6));
  const teal = mix(mix(U.teal, U.shades.magenta, down.mul(0.4)), vec3(0.8, 1, 0.97), up.mul(0.6));
  // a survivor (survivors.ts): matter, warm and a little pale — the one thing on the dome that is not spent
  const survivor = mix(U.matter, U.shades.pale, float(0.35)).mul(1.3);
  return matter.mul(is(MATTER)).add(anti.mul(is(ANTI))).add(U.light.mul(is(LIGHT))).add(rose.mul(is(ROSE))).add(teal.mul(is(TEAL))).add(survivor.mul(is(SURVIVOR)));
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

/** a strip of `segments` quads, s ∈ [0, 1] along it, side ±1 across */
function strip(segments: number): THREE.BufferGeometry {
  const n = (segments + 1) * 2;
  const sv = new Float32Array(n * 2);
  for (let i = 0; i <= segments; i++) {
    sv.set([i / segments, -1], i * 4);
    sv.set([i / segments, 1], i * 4 + 2);
  }
  const index: number[] = [];
  for (let i = 0; i < segments; i++) index.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
  g.setAttribute('prodSV', new THREE.BufferAttribute(sv, 2));
  g.setIndex(index);
  return g;
}

export interface ProductMeshes {
  readonly trails: THREE.InstancedMesh;
  readonly heads: THREE.InstancedMesh;
  dispose(): void;
}

export function createProducts(tracks: readonly ProductTrack[], U: ProductUniforms): ProductMeshes {
  // ---------------------------------------------------------------- trails
  const T = trackNodes();
  const SV = attribute<'vec2'>('prodSV', 'vec2');
  const S = SV.x;
  const side = SV.y;
  const path = trackPoint(T, S);
  const fx = U.fx;
  const pos = fx ? waveWarp(path, fx) : path;
  const tangent = trackTangent(T, S);
  const toEye = cameraPosition.sub(pos);
  const dist = toEye.length();
  // (pinched, not flipped, where the path points at the eye: glow.ts ribbonAcross)
  const acrossView = ribbonAcross(tangent, normalize(toEye));
  const tEnd = T.t0.add(T.life.mul(T.uEnd));
  // only what was there before the front reached this point freezes (loops.ts createLoopTrails says why)
  const tFront = fx ? frontTime(path, fx) : null;
  // a survivor is the exception to both: it is born on the front, runs on and comes to rest (survivors.ts)
  const isSurvivor = step(SURVIVOR - 0.5, T.family).mul(step(T.family, SURVIVOR + 0.5));
  const tFreeze = tFront ? step(T.t0.add(0.05), tFront).mul(float(1).sub(isSurvivor)).greaterThan(0.5).select(max(tFront, tEnd), float(1e6)) : null;
  const left = tFront ? mix(spent(tFront, fx as WaveFxUniforms, 0.35), float(1), isSurvivor) : float(1);
  const now = tFreeze ? min(U.time, tFreeze) : U.time;
  const glowOf = fx && tFreeze ? afterglow(U.time.sub(tFreeze), fx) : null;
  const head = ease(U.time.sub(T.t0).div(T.life).min(T.uEnd));
  // the head's whole segment kept, its light faded in behind it (loops.ts createLoopTrails, THE HEAD)
  const passedGeo = step(S.sub(1 / 128), head).mul(step(T.t0, U.time));
  const glowLen = float(0.06).div(T.radius.mul(T.turn).max(0.2)).clamp(0.003, 0.08);
  const passed = smoothstep(head, head.sub(glowLen), S).mul(step(T.t0, U.time));
  const age = now.sub(T.t0.add(unease(S).mul(T.life))).max(0);
  // (never wider than a third of the local radius of curvature: wider, the ribbon folds over itself on a tight curl
  // and cuts a wedge out of its glow; loops.ts createLoopTrails. The helix's radius of curvature is r·(1 + pitch²))
  const bendR = T.radius.mul(exp(T.curl.mul(T.turn).mul(S).negate())).mul(T.pitch.mul(T.pitch).add(1));
  // (drawn 1.5× wider for the profile's windowed halo, glow.ts; the bend cap on the drawn half-width)
  const spread = U.profile.halo.mul(1.5);
  const Sm = S.clamp(0.012, 0.988);
  const seen = screenBend(trackPoint(T, Sm.sub(0.012)), trackPoint(T, Sm), trackPoint(T, Sm.add(0.012)));
  const wide = float(0.035).add(age.mul(0.03)).mul(T.energy.mul(0.6).add(0.6)).mul(1.35).mul(spread).min(bendR.mul(0.4)).min(seen.mul(0.45));
  // both ends tapered to a point (loops.ts createLoopTrails: a square end on a broad glow is a hard line)
  const cap = wide.mul(1.5).div(T.radius.mul(T.turn).max(0.1));
  const fEndHere = ease(T.uEnd);
  const taper = smoothstep(0, cap, S).mul(smoothstep(fEndHere, fEndHere.sub(cap), S));
  const glowWidth = wide.mul(taper.mul(0.85).add(0.15));
  const drawn = max(glowWidth, U.pixelAngle.mul(2.5).mul(dist));
  const coverage = glowWidth.div(drawn).mul(taper);
  const pocketKeep = float(1).sub(pocketMask(pos.sub(U.eye), U.pocket).mul(0.85));
  const alpha = passed.mul(coverage).mul(pocketKeep);
  // a track fades on its own time scale: a quick pion's is gone in a breath, a slow curl lingers a little
  const tau = T.life.mul(0.6).add(0.15).min(0.9);
  // a SURVIVOR's run is gone soon after it rests: its grain (survivors.ts, the hero grain) is the thing left, alone.
  // With only the e-fold above (2.25 s for the hero's 2.1 s run, survivor-bright) the run's curl still hung by the
  // grain as faint smudges 6 s on, in the remain beat's dark (the coordinator's check of 48.5 s, 2026-11-01: hidden
  // with the product trails, they went). Out from 1 s to 2.5 s after the run ends: the hero's by 45.1 s, the remain
  // beat's start
  const rested = float(1).sub(isSurvivor.mul(smoothstep(tEnd.add(1), tEnd.add(2.5), U.time)));
  const lasting = passedGeo.mul(coverage).mul(pocketKeep).mul(exp(age.div(tau.mul(2.5)).negate())).mul(glowOf ? glowOf.gain : float(1)).mul(left).mul(rested);
  const trailMat = additive('undertime-product-trails');
  trailMat.positionNode = pos.add(acrossView.mul(side.mul(drawn).mul(step(0.0005, lasting))));
  trailMat.colorNode = Fn(() => {
    const kg = 2.5 * 1.35 ** 2;
    const { core, halo: glow } = ribbonGlow(side, spread, U.profile, { sigmaCore: Math.sqrt(0.02 / 1.35 ** 2 / 2), sigmaHalo: Math.sqrt(1 / (2 * kg)) });
    // break-up along the track: bubbles, not a wire (scaled to its length, not to the strip)
    const along = S.mul(T.radius.mul(T.turn).max(0.5)).div(0.22).add(float(instanceIndex).mul(2.7));
    const noise = sin(along).mul(0.5).add(sin(along.mul(2.7).add(1.1)).mul(0.3)).mul(0.5).add(0.5);
    const crumble = glowOf && fx ? smoothstep(0.15, 1.6, U.time.sub(tFreeze as F).div(fx.afterglow)).mul(glowOf.on) : float(0);
    const breakup = mix(float(0.75).add(noise.mul(0.25)), noise.mul(noise), smoothstep(0.3, 1.2, age.div(tau)).max(crumble));
    const tint = trackColour(T, U);
    const hot = exp(age.div(0.08).negate());
    const coreC = mix(tint, vec3(1, 0.97, 0.92), hot.mul(0.75)).mul(core).mul(exp(age.div(tau).negate())).mul(5);
    const glowC = tint.mul(glow).mul(exp(age.div(tau.mul(2)).negate())).mul(0.4);
    let c: V3 = coreC.add(glowC).mul(breakup);
    if (glowOf) c = afterglowColour(c, glowOf.heat, glowOf.on).mul(glowOf.gain);
    return vec4(c.mul(U.radiance).mul(T.energy).mul(alpha).mul(left).mul(rested).mul(exp(U.fog.mul(dist).negate())), 1);
  })();
  // (128 segments: a delta ray's or a slow pion's tight curl seen edge-on drew as a zigzag at 64)
  const trails = new THREE.InstancedMesh(strip(128), trailMat, Math.max(1, tracks.length));
  trails.count = tracks.length;
  for (const [name, data] of Object.entries(pack(tracks, 1))) trails.geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, 4));
  trails.frustumCulled = false;
  trails.name = 'undertime-product-trails';

  // ---------------------------------------------------------------- heads: kind 0 the bead, 1 its end flash
  const H = trackNodes();
  const kind = float(instanceIndex.mod(2));
  const hAge = U.time.sub(H.t0);
  const u = hAge.div(H.life);
  const f = ease(u);
  const beadAt = trackPoint(H, f);
  const endAt = trackPoint(H, float(1));
  const placed = mix(beadAt, endAt, kind);
  const centre = fx ? waveWarp(placed, fx) : placed;
  // a bead dies with its track (the CPU cuts the ones the front catches: uEnd); a flash only where a stopping
  // particle decays, and not for one the front cut short
  const beadA = step(0, hAge).mul(step(hAge, H.life.mul(H.uEnd))).mul(smoothstep(0, 0.04, hAge));
  const since = hAge.sub(H.life).add(float(1).sub(step(0.999, H.uEnd)).mul(1e4));
  const flashA = step(0, since).mul(exp(since.div(0.1).negate())).mul(H.flash);
  const isSurvivorH = step(SURVIVOR - 0.5, H.family).mul(step(H.family, SURVIVOR + 0.5));
  const leftH = fx ? mix(spent(frontTime(placed, fx), fx, 0.35), float(1), isSurvivorH) : float(1);
  const alphaH = mix(beadA, flashA, kind).mul(float(1).sub(pocketMask(centre.sub(U.eye), U.pocket).mul(0.8))).mul(leftH);
  const dirH = trackTangent(H, f);
  const hToEye = cameraPosition.sub(centre);
  const hDist = hToEye.length();
  const view = normalize(hToEye);
  const along0 = dirH.sub(view.mul(dirH.dot(view)));
  const alongLen = along0.length();
  const along = along0.div(alongLen.max(1e-4));
  const acrossV = normalize(view.cross(along));
  // m/s: |dP/df| · df/du / life, with |dP/df| = R₀·e^(−kφ)·turn·√(1 + pitch²)
  const speed = H.radius.mul(exp(H.curl.mul(H.turn).mul(f).negate())).mul(H.turn).mul(sqrt(H.pitch.mul(H.pitch).add(1)))
    .mul(float(1).sub(u.clamp(0, 1)).mul(2)).div(H.life);
  const px = U.pixelAngle.mul(hDist);
  // (larger quads for the profile's windowed halo, glow.ts; `natural` the light's own size, for the coverage)
  const natural = mix(float(0.1), float(0.22), kind);
  const spreadH = U.profile.halo.mul(mix(float(1.6), float(1.4), kind));
  const size = natural.mul(spreadH);
  const width = max(px.mul(1.5), size);
  const length = max(width, speed.mul(1 / 40).mul(alongLen).mul(float(1).sub(kind)));
  const corner = attribute<'vec3'>('position', 'vec3');
  const headMat = additive('undertime-product-heads');
  const on = step(0.0005, alphaH);
  headMat.positionNode = centre.add(along.mul(corner.y.mul(length))).add(acrossV.mul(corner.x.mul(width))).mul(on).add(centre.mul(float(1).sub(on)));
  headMat.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const rr = p.dot(p);
    const tint = trackColour(H, U);
    const b = spriteGlow(rr, spreadH, U.profile, { kCore: 50, coreGain: 14, kHalo: 3, haloGain: 1.8 });
    const bead = tint.mul(b.halo).add(vec3(1, 0.97, 0.92).mul(b.core));
    const f = spriteGlow(rr, spreadH, U.profile, { kCore: 10, coreGain: 2, kHalo: 3, haloGain: 0.15 });
    const flash = U.light.mul(f.core.add(f.halo)).mul(18);
    const coverageH = min(float(1), size.div(width));
    return vec4(mix(bead, flash, kind).mul(U.radiance).mul(H.energy).mul(alphaH).mul(coverageH).mul(exp(U.fog.mul(hDist).negate())), 1);
  })();
  const geometry = new THREE.PlaneGeometry(1, 1);
  geometry.deleteAttribute('normal');
  const heads = new THREE.InstancedMesh(geometry, headMat, Math.max(1, tracks.length * 2));
  heads.count = tracks.length * 2;
  for (const [name, data] of Object.entries(pack(tracks, 2))) geometry.setAttribute(name, new THREE.InstancedBufferAttribute(data, 4));
  heads.frustumCulled = false;
  heads.name = 'undertime-product-heads';

  return {
    trails,
    heads,
    dispose() {
      trails.geometry.dispose();
      trailMat.dispose();
      geometry.dispose();
      headMat.dispose();
    },
  };
}
