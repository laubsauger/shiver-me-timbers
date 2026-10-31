/**
 * The cosmic web as a VOLUME (direction U5–U6): the density field scripts/drift-web-volume.py builds the way
 * the structure forms (the Zel'dovich approximation), ray-marched per view direction and lit as glowing gas,
 * after the simulations' renders (drift-narrative/references/cosmic-web): foam — dark voids walled by sheets,
 * filaments where sheets meet, small saturated knots where filaments meet, fine hair everywhere — under the
 * log stretch every one of those images uses.
 *
 * PATTERN SPACE is the periodic box [0, 1)³ (the volume tiles). The show keeps the eye still and the world
 * scales about the hero grain (timeline.ts), which in pattern space is the eye flying back out of the grain's
 * knot along a slowly turning line; then Get the Drift's dive carries it on through the box into our galaxy
 * (getTheDrift/webDive.ts). `eyePat` is where the eye is in the box, and the ray marches from there; the box
 * sits TURNED in the world by the dive's frame (`toWorld`, `toPattern`: one fixed rotation, set so the dive runs
 * down a filament — until the 2026-10-30 dive there was no rotation between the two). Nearby filaments sweep past,
 * far ones barely move: the depth is the parallax.
 *
 * Two levels of the volume: 256³, and a 64³ average for the far, coarse steps (a mip by hand: a step longer
 * than a few fine cells would alias the fine one into sparkle). Palette after TNG's dark matter: navy voids,
 * blue sheets and filaments, the knots warm white — the film's blue and amber.
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, clamp, cross, length, max, min, select, step, uv, varying, vec2 } from 'three/tsl';
import { billboardMesh } from './billboard';
import { Fn, Loop, cameraPosition, exp, float, fract, mix, normalize, positionWorld, pow, screenCoordinate, smoothstep, texture3D, vec3, vec4 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type M3 = THREE.Node<'mat3'>;

/** the volume's log stretch (scripts/drift-web-volume.py): 0..1 over log10 of ρ/ρ̄ from 0.15 to 300 */
const LOG_LO = Math.log10(0.15);
const LOG_HI = Math.log10(300);

export interface WebKnot {
  /** pattern position (texture coordinates, [0, 1)³) */
  pos: [number, number, number];
  /** smoothed ρ/ρ̄ at the peak */
  density: number;
}

export interface WebData {
  fine: THREE.Data3DTexture;
  coarse: THREE.Data3DTexture;
  knots: WebKnot[];
  /** the simulation's particles: (u, v, w, log density) as normalised uint16 */
  particles: { data: Uint16Array };
  ready: Promise<void>;
}

function volumeTexture(n: number): THREE.Data3DTexture {
  const t = new THREE.Data3DTexture(new Uint8Array(n * n * n), n, n, n);
  t.format = THREE.RedFormat;
  t.type = THREE.UnsignedByteType;
  t.minFilter = THREE.LinearFilter;
  t.magFilter = THREE.LinearFilter;
  t.wrapS = THREE.RepeatWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.wrapR = THREE.RepeatWrapping;
  t.unpackAlignment = 1;
  t.generateMipmaps = false;
  return t;
}

export function loadWebData(base = `${import.meta.env.BASE_URL}drift/web/`): WebData {
  const fine = volumeTexture(256);
  const coarse = volumeTexture(64);
  const knots: WebKnot[] = [];
  const particles = { data: new Uint16Array(0) };
  const bytes = (name: string, tex: THREE.Data3DTexture): Promise<void> =>
    fetch(base + name)
      .then((r) => {
        if (!r.ok) throw new Error(`web volume: ${name} ${r.status} (run scripts/drift-web-volume.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        (tex.image as { data: Uint8Array }).data = new Uint8Array(b);
        tex.needsUpdate = true;
      });
  const ready = Promise.all([
    bytes('web-256.u8', fine),
    bytes('web-64.u8', coarse),
    fetch(base + 'web-particles.u16')
      .then((r) => {
        if (!r.ok) throw new Error(`web volume: web-particles.u16 ${r.status} (run scripts/drift-web-volume.py)`);
        return r.arrayBuffer();
      })
      .then((b) => {
        particles.data = new Uint16Array(b);
      }),
    fetch(base + 'web-knots.json')
      .then((r) => r.json())
      .then((j: { knots: Array<{ pos: number[]; density: number }> }) => {
        // the file's (x, y, z) are the array's axes; the texture's (u, v, w) run (z, y, x)
        for (const k of j.knots) knots.push({ pos: [k.pos[2], k.pos[1], k.pos[0]], density: k.density });
      }),
  ]).then(() => undefined);
  return { fine, coarse, knots, particles, ready };
}

export interface WebVolumeUniforms {
  /** the eye in pattern space */
  eyePat: V3;
  /** the box's turn in the world (webDive.ts frame): world = toWorld · pattern, and its inverse */
  toWorld?: M3;
  toPattern?: M3;
  /** 0..1 */
  presence: F;
  radiance: F;
}

const STEPS = 96;
/** pattern units: the march's first and last sample, and the fog's length (it hides the tiling). Only the
 * filaments and knots shine (below), so a long view stays clean: lines and knots in depth, as in the
 * simulations' exterior renders, not a projection's dense mesh */
const NEAR = 0.0025;
const FAR = 1.3;
export const FOG = 0.38;

/** colour of the gas by its log density v (0..1): navy voids → blue filaments → warm white knots */
function palette(v: F): V3 {
  const blue = vec3(0.12, 0.3, 1);
  const pale = vec3(0.5, 0.68, 1);
  const warm = vec3(1, 0.66, 0.36);
  return mix(mix(blue, pale, smoothstep(0.5, 0.64, v)), warm, smoothstep(0.66, 0.82, v)) as V3;
}

export function createWebVolume(data: WebData, U: WebVolumeUniforms): THREE.Mesh {
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.AdditiveBlending;
  material.colorNode = Fn(() => {
    // the view direction, in the box's own axes
    const dw = normalize(positionWorld.sub(cameraPosition));
    const d = U.toPattern ? U.toPattern.mul(dw) : dw;
    const light = vec3(0).toVar();
    // a per-pixel jitter of the samples turns the step pattern into fine grain
    const jitter = fract(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189));
    const span = Math.log(FAR / NEAR);
    Loop(STEPS, ({ i }) => {
      // samples spaced geometrically: dense near the eye, where the parallax is
      const s = float(i).add(jitter).div(STEPS);
      const tt = exp(s.mul(span)).mul(NEAR);
      const dt = tt.mul(span / STEPS);
      const p = U.eyePat.add(d.mul(tt));
      const fine = texture3D(data.fine, p).r;
      const coarse = texture3D(data.coarse, p).r;
      // a step longer than a few fine cells reads the coarse level (else the fine one aliases)
      const v = mix(fine, coarse, smoothstep(2 / 256, 8 / 256, dt));
      const rho = pow(float(10), v.mul(LOG_HI - LOG_LO).add(LOG_LO));
      // only the filaments and the knots shine: the voids black, the sheets between them gone (seen from
      // inside the foam, a sheet is a broad wall of fog); the knots far the brightest
      const emit = palette(v).mul(pow(rho, float(1.15))).mul(smoothstep(0.38, 0.58, v));
      light.addAssign(emit.mul(dt).mul(exp(tt.div(-FOG))).mul(smoothstep(NEAR, NEAR * 4, tt)));
    });
    return vec4(light.mul(U.radiance).mul(U.presence), 1);
  })();
  material.name = 'undertime-web-volume';
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(300, 64, 32), material);
  mesh.frustumCulled = false;
  mesh.renderOrder = -2;
  mesh.name = 'undertime-web-volume';
  return mesh;
}

export interface WebParticleUniforms extends WebVolumeUniforms {
  /** the eye (world) and the box's size in the world */
  eye: V3;
  box: F;
  pixelAngle: F;
  /** world units per second the web streams past the eye: minus the eye's velocity through it (webDive.ts) */
  flow: V3;
  /** 0..1 THE DIVE (webDive.ts): the particles near the eye stay crisp points down to EYE_MIN, brighten as they near
   * and streak along their motion. 0 for Undertime's pull-back, whose eye starts inside the hero knot's swarm */
  close: F;
}

/** box units: inside this the dive's particles fade (one passing through the eye would flash the dome) */
const EYE_MIN = 0.0002;
/** box units inside which a particle brightens as 1/d² in the dive (a galaxy's light as one nears it), and the cap */
const NEAR_GAIN_D = 0.01;
const NEAR_GAIN_MAX = 12;
/** s: the streak's exposure — the distance a near particle crosses in it is drawn as its length (a 180° shutter at
 * 30 fps) */
const SHUTTER = 1 / 60;
/** box units (largest component of the offset): particles near the edge of the eye's box image fade out, before
 * they jump to the opposite image as the eye moves through the box */
const WRAP_FADE: [number, number] = [0.4, 0.49];

/**
 * The simulation's particles as points (scripts/drift-web-volume.py keeps every one on the filaments and
 * knots, a sprinkle in the voids): crisp at any distance — a point is never wider than ~0.07°, never
 * narrower than a pixel (what it gains in size it gives back in brightness), so near filaments read as
 * streams of fine grains, far ones as fine lines, and the knots pile up into saturated cores.
 *
 * IN THE DIVE (`close`; the 2026-10-30 review: "more detail and a better sense of speed"): the old near fade, from
 * 0.0025 box out to 0.01, hid exactly the filament the eye flew through — the particles nearest the eye, the only
 * detail at that scale — and every point kept the same light at any distance, so the near field read as an even
 * sprinkle with no depth. Now they stay down to EYE_MIN, the nearest brighten as 1/d² (capped), and each is drawn
 * as a short streak along its own apparent motion over SHUTTER: what streams past overhead is what is near. A streak
 * keeps the point's light (spread over its length), so the far ones, which barely move, stay points.
 */
export function createWebParticles(data: WebData, U: WebParticleUniforms): THREE.InstancedMesh {
  const n = data.particles.data.length / 4;
  const A = attribute<'vec4'>('webPart', 'vec4');
  const v = A.w;
  // the image of the particle nearest the eye, turned into the world by the box's frame
  const dp0 = A.xyz.sub(U.eyePat);
  const dp = dp0.sub(dp0.add(0.5).floor());
  const pos = U.eye.add((U.toWorld ? U.toWorld.mul(dp) : dp).mul(U.box));
  const dPat = length(dp);
  const dist = dPat.mul(U.box);
  // a grain of the web: ~a third of a cell, its angular size capped (a near particle is a point, not a blob)
  const wanted = min(U.box.mul(0.35 / 256), dist.mul(0.0012));
  const drawn = max(wanted, U.pixelAngle.mul(1.2).mul(dist));
  const k = wanted.div(drawn);
  const coverage = k.mul(k);
  // the filaments and knots shine, the void particles barely; faded with distance (it hides the tiling)
  // and kept off the eye
  const weight = smoothstep(0.32, 0.62, v).mul(0.94).add(0.06).mul(pow(float(10), v.mul(LOG_HI - LOG_LO).add(LOG_LO)).pow(0.35));
  const near = mix(float(NEAR), float(EYE_MIN), U.close);
  const gain = mix(float(1), clamp(float(NEAR_GAIN_D).div(dPat.max(1e-6)).pow(2), 1, NEAR_GAIN_MAX), U.close);
  const edge = float(1).sub(smoothstep(WRAP_FADE[0], WRAP_FADE[1], max(abs(dp.x), max(abs(dp.y), abs(dp.z)))));
  const alpha = weight.mul(coverage).mul(exp(dPat.div(-FOG))).mul(smoothstep(near, near.mul(4), dPat)).mul(edge).mul(gain).mul(U.presence);
  // THE STREAK: the particle's motion across the view in SHUTTER, in the world (the flow less its part along the line
  // of sight), and the quad laid along it; the eye-facing basis otherwise (billboard.ts: the six cube faces agree)
  const toEye = normalize(cameraPosition.sub(pos));
  const across = U.flow.sub(toEye.mul(U.flow.dot(toEye))).mul(U.close);
  const sweep = length(across).mul(SHUTTER);
  const up0 = select(abs(toEye.y).greaterThan(0.98), vec3(1, 0, 0), vec3(0, 1, 0)) as V3;
  const side0 = normalize(cross(up0, toEye));
  // (along the motion, or the eye-facing side as the motion fades: never a zero vector)
  const along = normalize(across.mul(SHUTTER).add(side0.mul(drawn.mul(0.01))));
  const athwart = cross(toEye, along);
  const len = drawn.add(sweep);
  const corner = attribute<'vec3'>('position', 'vec3');
  const show = step(0.00002, alpha);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = pos.add(along.mul(corner.x.mul(len).mul(show))).add(athwart.mul(corner.y.mul(drawn).mul(show)));
  // (per particle, handed to the fragment stage once rather than rebuilt per pixel)
  const shape = varying(vec3(sweep.div(len), drawn.div(len), alpha), 'webPartShape');
  material.colorNode = Fn(() => {
    // in the quad: x along the streak in units of its length, y across in units of the point's width
    const q = uv().sub(0.5);
    // distance from the streak's core segment, in point radii
    const dx = max(abs(q.x).sub(shape.x.mul(0.5)), 0).div(shape.y.mul(0.5));
    const r = clamp(length(vec2(dx, q.y.mul(2))), 0, 1);
    // the point's light spread over the streak's length
    return vec4(palette(v).mul(shape.z).mul(shape.y).mul(U.radiance).mul(exp(r.mul(r).mul(-5))), 1);
  })();
  material.name = 'undertime-web-particles';
  const mesh = billboardMesh(material, n, 'undertime-web-particles');
  mesh.geometry.setAttribute('webPart', new THREE.InstancedBufferAttribute(data.particles.data, 4, true));
  mesh.renderOrder = -1;
  return mesh;
}
