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
 *
 * THE LIGHT WAVE (`front`, Act 1; the 2026-10-30 review: "a total collapse of space and time … more fidelity"): the
 * front is a SHEET of light passing through this medium, not a band painted on the sky. Every mote it crosses
 * lights as the sheet goes through it — a white-hot instant, a violet glimmer just ahead (the light it pushes
 * before it), an amber glow just behind — at every distance at once, so the front has depth and parallax as it
 * goes over. Before it, the motes low in front catch the glow coming up under the horizon (the build); while it
 * stalls overhead the medium ahead of it sparkles with its crest. The front's pull (waveFx.ts) moves the motes too: the
 * medium is what makes space visibly fold.
 */
import * as THREE from 'three/webgpu';
import { Fn, Loop, acos, cameraPosition, clamp, exp, float, hash, instanceIndex, length, max, mix, normalize, pow, sin, smoothstep, step, uniformArray, uv, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from './billboard';
import { randomDir } from './pairModel';
import { frontFrac, frontTime, spent, waveWarp, type WaveFxUniforms } from './waveFx';
import { glowWindow } from './glow';

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
  /** Act 1: the light wave, see the header */
  front?: DustFront;
}

export interface DustFront {
  fx: WaveFxUniforms;
  /** linear radiance of the sheet where it passes (state.frontGain × frontRadiance) */
  sheet: F;
  /** 0..1 the build (the glow under the front horizon); the crest's radiance now */
  build: F;
  crest: F;
  light: V3;
  /** the violet just ahead of the front, the amber just behind it */
  lead: V3;
  trail: V3;
  /** unit, the dome front (the build's glow comes up under it) */
  domeFront: V3;
  /** 0..1 how much of the medium the wave's light finds (as `density`, for its light only) */
  density: F;
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
  const placed = U.centre.add(dir.mul(r)).add(wobble);
  const pos = U.front ? waveWarp(placed, U.front.fx) : placed;
  const toEye = cameraPosition.sub(pos);
  const dist = toEye.length();
  const view = normalize(toEye);
  const events = vec3(0).toVar();
  Loop(DUST_LIGHTS, ({ i: j }) => {
    const L = lightPos.element(j) as unknown as V4;
    const C = lightCol.element(j) as unknown as V4;
    const d = L.xyz.sub(pos);
    const r2 = d.dot(d).add(0.05);
    // forward scattering: a mote seen against a light glows (cosT → 1 when the light is behind it)
    const cosT = normalize(d).dot(view.negate());
    const phase = float(0.35).add(pow(cosT.mul(0.5).add(0.5), float(6)).mul(2.5));
    events.addAssign(C.xyz.mul(phase).div(r2));
  });
  // (the wave's light is summed as an expression: an assign outside the Loop's own stack is dropped by TSL)
  let wave: V3 = vec3(0);
  if (U.front) {
    const W = U.front;
    const dm = normalize(placed.sub(W.fx.eye));
    // rad ahead of the front (> 0) or behind it (< 0), on the same ragged edge the pairs die on
    const x = frontFrac(dm, W.fx).sub(W.fx.sweep).mul(Math.PI);
    // (squared by hand: WGSL's pow of a negative base is undefined, and x is signed)
    const xs = x.div(0.03);
    const sheet = exp(xs.mul(xs).negate());
    const lead = exp(x.max(0).div(0.05).negate()).mul(step(0, x)).mul(0.22);
    const trail = exp(x.min(0).div(0.08)).mul(step(x, 0)).mul(0.25);
    // a mote's own glint: each catches the sheet a little differently (orientation, size), so it sparkles
    const glint = hash(i.mul(8.13)).pow(2).mul(1.6).add(0.2);
    const onSweep = smoothstep(0.0, 0.02, W.fx.sweep).mul(smoothstep(1, 0.96, W.fx.sweep));
    wave = wave.add(W.light.mul(sheet).add(W.lead.mul(lead)).add(W.trail.mul(trail)).mul(W.sheet).mul(glint).mul(onSweep));
    // the build: what comes up under the front horizon lights the low motes in front, flickering — and hands over to
    // the front as it rises, as the sky's glow does (held on, it lit the spent dome behind the front as snow: the
    // 2026-10-30 story pass)
    const th = acos(dm.dot(W.domeFront).clamp(-1, 1));
    const flicker = sin(W.fx.time.mul(7.3).add(hash(i.mul(3.1)).mul(6.28))).mul(0.25).add(0.75);
    const handover = float(1).sub(smoothstep(0.03, 0.14, W.fx.sweep)).mul(step(0, x));
    wave = wave.add(W.light.mul(exp(th.div(0.32).negate())).mul(W.build.mul(W.build)).mul(flicker).mul(0.9).mul(handover));
    // the crest: the medium glitters in the band ahead of the line, faintly (brighter, the near motes were soft bokeh
    // snow); never behind it
    // (ahead ONLY: max(x, 0) is 0 everywhere behind the line, where the Gaussian is then 1 — that lit the whole spent
    // dome as snow, found by hiding the layers one by one at 42 s, 2026-10-30)
    const xc = x.max(0).div(0.3);
    wave = wave.add(mix(W.light, W.lead, float(0.25)).mul(W.crest).mul(glint).mul(exp(xc.mul(xc).negate())).mul(step(0, x)).mul(0.3));
  }
  // a mote fades as the dust thins (a hard cut makes lit motes blink off one by one)
  const h = hash(i.mul(5.11));
  const present = smoothstep(h, h.add(0.08), U.density);
  // the motes the light wave brings back (`front.density`) take only ITS light: lit by every event light too, the
  // extra motes were a brown snow over the build and a haze behind the front (2026-10-30 second look)
  const presentWave = U.front ? smoothstep(h, h.add(0.08), U.front.density) : float(0);
  // (what the front has passed is spent: its motes take no more of the events' light, waveFx.ts)
  const left = U.front ? spent(frontTime(placed, U.front.fx), U.front.fx, 0.3) : float(1);
  const lit = events.mul(present).mul(left).add(wave.mul(presentWave.max(present)));
  const size = float(0.035).mul(hash(i.mul(6.7)).mul(1.5).add(0.5));
  const drawn = max(size, U.pixelAngle.mul(1.3).mul(dist));
  const coverage = size.div(drawn).pow(2);
  const alpha = coverage.mul(clamp(length(lit), 0, 1e6).greaterThan(1e-4).select(float(1), float(0)));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, drawn.mul(step(1e-6, alpha)));
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    // (windowed to zero at the quad's edge, glow.ts: the 2026-10-30 note on the particles' falloff)
    const core = exp(q.dot(q).mul(5).negate()).mul(glowWindow(q.dot(q)));
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
