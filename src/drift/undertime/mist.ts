/**
 * Undertime's trails as a CLOUD CHAMBER films them (production-design.md): not lines, mist. Where a bead
 * has passed, the medium condenses into a trail of soft puffs that forms in an instant, curls with the
 * path, then drifts, swells and fades as it diffuses — the most photographic thing particle physics has.
 *
 * Each pair's two paths carry `PUFFS` puffs at fixed fractions of the loop (jittered). A puff is born when
 * its bead passes (events.ts timeAt via the GPU inverse of the ease), advected by a slow divergence-free
 * flow, its size growing with √age (diffusion), its density falling. Lit like real mist:
 *   KEY      one side light (a cool white, from the front-left high) seen through the puff with a forward
 *            scattering phase — trails toward the light shine silver, trails away are dim
 *   EVENTS   the frame's strongest event lights (bursts, flashes), inverse-square with absorption
 * Shape: a tileable noise texture (CPU, once) per puff, rotated and offset, inside a soft falloff — wisps,
 * not discs. Additive: mist on black only scatters light, it hides nothing.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  Loop,
  attribute,
  cameraPosition,
  cos,
  exp,
  float,
  hash,
  instanceIndex,
  max,
  mix,
  normalize,
  pow,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  uniformArray,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { PairEvent } from './events';
import { rng } from './web';
import { billboardMesh, eyeFacing } from './billboard';
import { arcPoint } from './loops';
import { pocketMask, type PocketUniforms } from './pairModel';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** puffs along each bead's path */
export const PUFFS = 110;
/** event lights the mist sees */
export const MIST_LIGHTS = 6;

export interface MistUniforms {
  time: F;
  pixelAngle: F;
  /** unit, toward the key light */
  key: V3;
  keyColour: V3;
  matter: V3;
  anti: V3;
  radiance: F;
  /** s, how long the mist takes to fade */
  life: F;
  pocket: PocketUniforms;
  eye: V3;
}

/** tileable value-noise fbm, 128², generated once (wispy alpha for the puffs) */
export function noiseTexture(): THREE.DataTexture {
  const N = 128;
  const r = rng(77);
  const grid = (g: number): Float32Array => Float32Array.from({ length: g * g }, () => r());
  const layers = [4, 8, 16, 32].map((g) => ({ g, v: grid(g) }));
  const data = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++)
    for (let x = 0; x < N; x++) {
      let sum = 0;
      let amp = 1;
      let norm = 0;
      for (const { g, v } of layers) {
        const fx = (x / N) * g;
        const fy = (y / N) * g;
        const x0 = Math.floor(fx);
        const y0 = Math.floor(fy);
        const tx = fx - x0;
        const ty = fy - y0;
        const sx = tx * tx * (3 - 2 * tx);
        const sy = ty * ty * (3 - 2 * ty);
        const at = (i: number, j: number): number => v[((j + g) % g) * g + ((i + g) % g)];
        const a = at(x0, y0) * (1 - sx) + at(x0 + 1, y0) * sx;
        const b = at(x0, y0 + 1) * (1 - sx) + at(x0 + 1, y0 + 1) * sx;
        sum += (a * (1 - sy) + b * sy) * amp;
        norm += amp;
        amp *= 0.55;
      }
      const n = sum / norm;
      data.set([n * 255, n * 255, n * 255, 255], (y * N + x) * 4);
    }
  const tex = new THREE.DataTexture(data, N, N, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.magFilter = tex.minFilter = THREE.LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export interface Mist {
  readonly mesh: THREE.InstancedMesh;
  /** the frame's strongest event lights (pos, rgb·intensity) */
  setLights(lights: Array<{ pos: [number, number, number]; colour: [number, number, number] }>): void;
  dispose(): void;
}

/**
 * `spark`: the same puffs as SPARKS the luminous trail sheds as it fades — small, coloured, glowing by
 * themselves, drifting off and out within a second (no key light, no wisps).
 */
export function createMist(events: readonly PairEvent[], U: MistUniforms, spark = false): Mist {
  const lightPos = uniformArray(Array.from({ length: MIST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  const lightCol = uniformArray(Array.from({ length: MIST_LIGHTS }, () => new THREE.Vector4()), 'vec4');
  // per instance: pair record (birth, loop, open, radius), vertex + energy, axis, across (+ the puff's
  // fraction along the path and charge packed in the spare components)
  const n = events.length * 2 * PUFFS;
  const A = new Float32Array(n * 4);
  const V = new Float32Array(n * 4);
  const X = new Float32Array(n * 4);
  const Y = new Float32Array(n * 4);
  const Z = new Float32Array(n * 4);
  const r = rng(99);
  let k = 0;
  for (const e of events)
    for (let q = 0; q < 2; q++)
      for (let j = 0; j < PUFFS; j++, k++) {
        A.set([e.birth, e.loop, e.open, e.radius], k * 4);
        V.set([...e.vertex, e.energy], k * 4);
        X.set([...e.axis, (j + r()) / PUFFS], k * 4);
        Y.set([...e.across, q === 0 ? 1 : -1], k * 4);
        Z.set([e.spiral, e.drift, e.arc, e.end], k * 4);
      }
  const a = attribute<'vec4'>('mistA', 'vec4');
  const v = attribute<'vec4'>('mistV', 'vec4');
  const x = attribute<'vec4'>('mistX', 'vec4');
  const y = attribute<'vec4'>('mistY', 'vec4');
  const z = attribute<'vec4'>('mistZ', 'vec4');
  const birth = a.x;
  const loop = a.y;
  const open = a.z;
  const radius = a.w;
  const vertex = v.xyz;
  const energy = v.w;
  const axis = x.xyz;
  const across = y.xyz;
  const f = x.w; // fraction along the path
  const q = y.w;
  const i = float(instanceIndex);

  // when the bead passed this fraction (inverse of events.ts loopEase, four Newton steps)
  const ease = (u: F): F => float(1).sub(pow(float(1).sub(u.clamp(0, 1)), float(1.7))).mul(0.85).add(u.clamp(0, 1).mul(0.15));
  let uu: F = f;
  for (let it = 0; it < 4; it++) {
    const kk = uu.clamp(0, 1);
    const g = ease(kk).sub(f);
    const dg = float(1.7 * 0.85).mul(pow(float(1).sub(kk).max(1e-3), float(0.7))).add(0.15);
    uu = kk.sub(g.div(dg)).clamp(0, 1);
  }
  const bornAt = birth.add(uu.mul(loop));
  const age = U.time.sub(bornAt);
  // the path point (events.ts loopPoint, loops.ts arcPoint)
  const base = arcPoint({ vertex, axis, across, open, radius, spiral: z.x, drift: z.y, arc: z.z }, q, f);
  // drift: a slow swirling flow (divergence-free, sum of rotated sines), more with age
  const s1 = base.mul(0.35).add(vec3(1.3, 4.1, 2.7));
  const flow = vec3(sin(s1.y.add(U.time.mul(0.3))).add(cos(s1.z)), sin(s1.z.add(U.time.mul(0.25))).add(cos(s1.x)), sin(s1.x.add(U.time.mul(0.2))).add(cos(s1.y))).mul(0.06);
  // a third of the puffs are the trail's thin bright CORE; the rest billow around it, wider and fainter
  const isCore = step(hash(i.mul(13.7)), 0.33);
  const billow = vec3(hash(i.mul(1.3)), hash(i.mul(2.1)), hash(i.mul(3.7))).sub(0.5).mul(mix(float(0.22), float(0.03), isCore)).mul(grow0(age));
  // sparks fly off the trail a little (their own random direction), mist only drifts
  const kick = spark ? vec3(hash(i.mul(21.1)), hash(i.mul(23.3)), hash(i.mul(29.7))).sub(0.5).mul(0.5).mul(age.max(0).mul(3).add(0).min(1.2)) : vec3(0);
  const pos = base.add(flow.mul(age.max(0))).add(billow).add(kick);
  // diffusion: size with √age, density falling; condenses in ~0.1 s
  const grow = sqrt(age.max(0).add(0.02));
  function grow0(a: F): F {
    return sqrt(a.max(0).add(0.3));
  }
  // overlapping puffs make one continuous trail of mist (no beads): ~3× their spacing across
  const size = spark
    ? float(0.025).add(grow.mul(0.02)).mul(hash(i.mul(5.1)).mul(1.2).add(0.4))
    : float(0.16).add(grow.mul(0.55)).mul(energy.mul(0.4).add(0.8)).mul(hash(i.mul(5.1)).mul(1.1).add(0.5)).mul(mix(float(1.25), float(0.45), isCore));
  // sparks start only once the trail behind the head is fading (~0.25 s), and twinkle out
  const presence = spark
    ? smoothstep(0.2, 0.35, age).mul(exp(age.sub(0.3).max(0).div(U.life.mul(loop.div(1.5).min(1))).negate())).mul(step(hash(i.mul(31.7)), 0.45))
    : smoothstep(0, 0.08, age).mul(exp(age.div(U.life).negate())).mul(step(0, age));
  // lighting at the puff: the key light through the puff (forward scattering), the event lights near it
  const toEye = normalize(cameraPosition.sub(pos));
  const cosK = U.key.dot(toEye.negate());
  const g = 0.55;
  const phase = float((1 - g * g) / (4 * Math.PI)).div(pow(float(1 + g * g).sub(cosK.mul(2 * g)), float(1.5))).mul(4 * Math.PI);
  // the key light carries most of the read: strongly forward-scattering, so a trail toward it shines and one
  // away from it is a ghost
  const lit = U.keyColour.mul(phase.mul(0.6).add(0.02)).toVar();
  Loop(MIST_LIGHTS, ({ i: j }) => {
    const L = lightPos.element(j) as unknown as V4;
    const C = lightCol.element(j) as unknown as V4;
    const d = L.xyz.sub(pos);
    const r2 = d.dot(d).add(0.2);
    lit.addAssign(C.xyz.mul(exp(sqrt(r2).mul(0.25).negate())).div(r2).mul(1.6));
  });
  const fresh = exp(age.div(0.3).negate());
  const tint = mix(U.matter, U.anti, step(q, 0));
  const colour = spark ? tint.mul(2.5).add(lit.mul(0.3)) : lit.mul(mix(vec3(1), tint.mul(1.6), fresh.mul(0.6)));
  const dist = cameraPosition.sub(pos).length();
  const drawn = max(size, U.pixelAngle.mul(2).mul(dist));
  const coverage = size.div(drawn).pow(2);
  // depth: far mist is seen through more of the chamber — dimmer (aerial perspective, no fog colour)
  const depth = exp(dist.div(22).negate()).mul(0.8).add(0.2);
  // not along the part of the path the pair never lived (the wave cut it)
  const lived = step(uu, z.w);
  const alive = presence.mul(coverage).mul(energy).mul(depth).mul(lived).mul(float(1).sub(pocketMask(pos.sub(U.eye), U.pocket).mul(0.85)));

  const noise = noiseTexture();
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, drawn.mul(step(0.0005, alive)));
  material.colorNode = Fn(() => {
    const p = uv().sub(0.5).mul(2);
    const rot = hash(i.mul(7.3)).mul(6.283);
    const c = cos(rot);
    const s = sin(rot);
    const pr = vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
    const w = texture(noise, pr.mul(0.35).add(vec2(hash(i.mul(9.1)), hash(i.mul(11.3))))).r;
    const fall = exp(p.dot(p).mul(2.6).negate());
    // wisps: the noise carves the soft puff; older puffs are thinner and more broken
    if (spark) return vec4(colour.mul(U.radiance).mul(alive).mul(exp(p.dot(p).mul(6).negate())), 1);
    const density = smoothstep(float(0.35).add(fresh.mul(-0.2)), 1, w.mul(fall).mul(1.8));
    return vec4(colour.mul(U.radiance).mul(alive).mul(density).mul(mix(float(0.28), float(0.9), isCore)), 1);
  })();
  material.name = 'undertime-mist';
  const mesh = billboardMesh(material, n, 'undertime-mist');
  mesh.geometry.deleteAttribute('normal');
  mesh.geometry.setAttribute('mistA', new THREE.InstancedBufferAttribute(A, 4));
  mesh.geometry.setAttribute('mistV', new THREE.InstancedBufferAttribute(V, 4));
  mesh.geometry.setAttribute('mistX', new THREE.InstancedBufferAttribute(X, 4));
  mesh.geometry.setAttribute('mistY', new THREE.InstancedBufferAttribute(Y, 4));
  mesh.geometry.setAttribute('mistZ', new THREE.InstancedBufferAttribute(Z, 4));
  return {
    mesh,
    setLights(lights) {
      for (let j = 0; j < MIST_LIGHTS; j++) {
        const l = lights[j];
        (lightPos.array[j] as THREE.Vector4).set(l ? l.pos[0] : 0, l ? l.pos[1] : 0, l ? l.pos[2] : 0, 0);
        (lightCol.array[j] as THREE.Vector4).set(l ? l.colour[0] : 0, l ? l.colour[1] : 0, l ? l.colour[2] : 0, 0);
      }
    },
    dispose() {
      mesh.geometry.dispose();
      material.dispose();
      noise.dispose();
    },
  };
}
