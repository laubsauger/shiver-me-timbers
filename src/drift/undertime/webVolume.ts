/**
 * The cosmic web as a VOLUME (direction U5–U6): the density field scripts/drift-web-volume.py builds the way
 * the structure forms (the Zel'dovich approximation), ray-marched per view direction and lit as glowing gas,
 * after the simulations' renders (drift-narrative/references/cosmic-web): foam — dark voids walled by sheets,
 * filaments where sheets meet, small saturated knots where filaments meet, fine hair everywhere — under the
 * log stretch every one of those images uses.
 *
 * PATTERN SPACE is the periodic box [0, 1)³ (the volume tiles). The show keeps the eye still and the world
 * scales about the hero grain (timeline.ts), which in pattern space is the eye flying back out of the grain's
 * knot along a slowly turning line: `eyePat` is where the eye is in the box, and the ray marches from there
 * in the same directions as in the world (no rotation between the two). Nearby filaments sweep past, far
 * ones barely move: the depth is the parallax.
 *
 * Two levels of the volume: 256³, and a 64³ average for the far, coarse steps (a mip by hand: a step longer
 * than a few fine cells would alias the fine one into sparkle). Palette after TNG's dark matter: navy voids,
 * blue sheets and filaments, the knots warm white — the film's blue and amber.
 */
import * as THREE from 'three/webgpu';
import { attribute, clamp, length, max, min, step, uv } from 'three/tsl';
import { billboardMesh, eyeFacing } from './billboard';
import { Fn, Loop, cameraPosition, exp, float, fract, mix, normalize, positionWorld, pow, screenCoordinate, smoothstep, texture3D, vec3, vec4 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

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
const FOG = 0.38;

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
    const d = normalize(positionWorld.sub(cameraPosition));
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

/** world position of a pattern point p: the image of p nearest the eye, `scale` world units per box */
export function patternToWorld(p: [number, number, number], eyePat: [number, number, number], eye: [number, number, number], scale: number): [number, number, number] {
  return [0, 1, 2].map((i) => {
    let dp = p[i] - eyePat[i];
    dp -= Math.round(dp);
    return eye[i] + dp * scale;
  }) as [number, number, number];
}

export interface WebParticleUniforms extends WebVolumeUniforms {
  /** the eye (world) and the box's size in the world */
  eye: V3;
  box: F;
  pixelAngle: F;
}

/**
 * The simulation's particles as points (scripts/drift-web-volume.py keeps every one on the filaments and
 * knots, a sprinkle in the voids): crisp at any distance — a point is never wider than ~0.07°, never
 * narrower than a pixel (what it gains in size it gives back in brightness), so near filaments read as
 * streams of fine grains, far ones as fine lines, and the knots pile up into saturated cores.
 */
export function createWebParticles(data: WebData, U: WebParticleUniforms): THREE.InstancedMesh {
  const n = data.particles.data.length / 4;
  const A = attribute<'vec4'>('webPart', 'vec4');
  const v = A.w;
  // the image of the particle nearest the eye
  const dp0 = A.xyz.sub(U.eyePat);
  const dp = dp0.sub(dp0.add(0.5).floor());
  const pos = U.eye.add(dp.mul(U.box));
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
  const alpha = weight.mul(coverage).mul(exp(dPat.div(-FOG))).mul(smoothstep(NEAR, NEAR * 4, dPat)).mul(U.presence);
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = eyeFacing(pos, drawn.mul(step(0.00002, alpha)));
  material.colorNode = Fn(() => {
    const r = clamp(length(uv().sub(0.5)).mul(2), 0, 1);
    return vec4(palette(v).mul(alpha).mul(U.radiance).mul(exp(r.mul(r).mul(-5))), 1);
  })();
  material.name = 'undertime-web-particles';
  const mesh = billboardMesh(material, n, 'undertime-web-particles');
  mesh.geometry.setAttribute('webPart', new THREE.InstancedBufferAttribute(data.particles.data, 4, true));
  mesh.renderOrder = -1;
  return mesh;
}
