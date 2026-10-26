/**
 * G1's field of galaxies: one oriented IMPOSTOR quad per galaxy, lying in the galaxy's own plane (not facing
 * the eye — a disc seen at an angle must foreshorten, and one seen edge-on must thin to a line), shaded
 * with the shared analytic model (galaxyModel.ts galaxyFace).
 *
 * They open at the knots where Undertime's first stars ignited (grains.ts finalKnots): each grows from a
 * point of light into its disc as `open` rises. Instance 0 is OUR galaxy, whose impostor hands over to the
 * ray-marched volume (milkyWay.ts) as we approach; its parameters are fixed so the two agree.
 *
 * Brightness per unit projected area rises as a disc tilts away (a longer path through a thin glowing
 * sheet), capped so an edge-on galaxy is a bright needle rather than a blown-out line.
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, attribute, cameraPosition, clamp, exp, float, max, min, mix, normalize, smoothstep, step, uv, vec2, vec4 } from 'three/tsl';
import { galaxyFace } from './galaxyModel';
import { rng } from '../undertime/web';
import type { Vec3 } from '../../cine/domeMaster';

type F = THREE.Node<'float'>;

export interface GalaxySpec {
  centre: Vec3;
  normal: Vec3;
  /** in-plane axis the model's x runs along */
  xAxis: Vec3;
  radius: number;
  arms: number;
  /** 1 / tan(pitch) */
  wind: number;
  phase: number;
  seed: number;
  elliptical: number;
  /** 0..1 order of appearance */
  appear: number;
  brightness: number;
}

/** OUR galaxy's model parameters (the volume reads the same ones) */
export const OUR_LOOK = { arms: 2, wind: 1 / Math.tan((13 * Math.PI) / 180), phase: 0.6, seed: 3.7, elliptical: 0 };

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);

function randomUnit(r: () => number): Vec3 {
  const z = r() * 2 - 1;
  const a = r() * Math.PI * 2;
  const s = Math.sqrt(1 - z * z);
  return [s * Math.cos(a), z, s * Math.sin(a)];
}

function inPlane(n: Vec3, r: () => number): Vec3 {
  const t = randomUnit(r);
  const d = t[0] * n[0] + t[1] * n[1] + t[2] * n[2];
  const x: Vec3 = [t[0] - n[0] * d, t[1] - n[1] * d, t[2] - n[2] * d];
  const l = len(x) || 1;
  return [x[0] / l, x[1] / l, x[2] / l];
}

/**
 * The field: a galaxy at every knot, except where it would sit on our galaxy or across our flight line.
 * Seeded, so every lane renders the same sky.
 */
export function galaxyField(knots: Array<{ pos: Vec3; level: number }>, ours: GalaxySpec, flight: [Vec3, Vec3], size: number): GalaxySpec[] {
  const r = rng(4242);
  const [a, b] = flight;
  const ab = sub(b, a);
  const abl = len(ab);
  const clearOfFlight = (p: Vec3): number => {
    const t = Math.min(1, Math.max(0, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / (abl * abl)));
    return len(sub(p, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]));
  };
  const out: GalaxySpec[] = [ours];
  for (const k of knots) {
    const radius = size * (0.45 + r() * 0.9) * (k.level > knots[0].level ? 1.6 : 1);
    if (len(sub(k.pos, ours.centre)) < ours.radius * 2.2 + radius || clearOfFlight(k.pos) < radius * 1.8) continue;
    const normal = randomUnit(r);
    const elliptical = r() < 0.25 ? 1 : 0;
    out.push({
      centre: k.pos,
      normal,
      xAxis: inPlane(normal, r),
      radius: elliptical ? radius * 0.6 : radius,
      arms: r() < 0.7 ? 2 : r() < 0.6 ? 3 : 4,
      wind: 1 / Math.tan(((9 + r() * 16) * Math.PI) / 180),
      phase: r() * Math.PI * 2,
      seed: r() * 50,
      elliptical,
      appear: r(),
      brightness: 0.6 + r() * 0.6,
    });
  }
  return out;
}

export interface GalaxyUniforms {
  open: F;
  /** 0..1 our galaxy's impostor (it hands over to the volume) */
  ours: F;
  /** 0..1 the rest of the field */
  field: F;
  radiance: F;
  pixelAngle: F;
}

export function createGalaxies(specs: GalaxySpec[], U: GalaxyUniforms): THREE.InstancedMesh {
  const n = specs.length;
  const centre = new Float32Array(n * 4);
  const normal = new Float32Array(n * 4);
  const xAxis = new Float32Array(n * 4);
  const look = new Float32Array(n * 4);
  specs.forEach((s, i) => {
    centre.set([...s.centre, s.radius], i * 4);
    normal.set([...s.normal, s.appear], i * 4);
    xAxis.set([...s.xAxis, s.brightness], i * 4);
    look.set([s.arms, s.wind, s.phase, s.seed + s.elliptical * 1000], i * 4);
  });
  const C4 = attribute<'vec4'>('galaxyCentre', 'vec4');
  const N4 = attribute<'vec4'>('galaxyNormal', 'vec4');
  const X4 = attribute<'vec4'>('galaxyX', 'vec4');
  const L4 = attribute<'vec4'>('galaxyLook', 'vec4');
  const isOurs = step(float(attribute<'float'>('galaxyIndex', 'float')), 0.5);
  const elliptical = step(999, L4.w);
  const seed = L4.w.sub(elliptical.mul(1000));
  const N = normalize(N4.xyz);
  const X = normalize(X4.xyz);
  const Y = N.cross(X);
  // open from a point: the disc grows and brightens in its own moment
  const appear = N4.w.mul(0.6);
  const grow = mix(smoothstep(appear, appear.add(0.4), U.open), float(1), isOurs);
  const R = C4.w.mul(grow.mul(0.95).add(0.05));
  const corner = attribute<'vec3'>('position', 'vec3');
  const EXTENT = 1.5; // the quad spans ±1.5 radii (the outer disk fades by then)
  const pos = C4.xyz.add(X.mul(corner.x.mul(2 * EXTENT).mul(R))).add(Y.mul(corner.y.mul(2 * EXTENT).mul(R)));
  const toEye = normalize(cameraPosition.sub(C4.xyz));
  const cosI = abs(toEye.dot(N));
  const gain = min(float(1).div(max(cosI, 0.12)), 4);
  const present = mix(U.field, U.ours, isOurs).mul(grow);
  // a galaxy narrower than a few pixels is a point of light: keep it from vanishing between pixels
  const dist = cameraPosition.sub(C4.xyz).length();
  const tiny = clamp(R.div(dist.mul(U.pixelAngle).mul(3)), 0, 1);

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.AdditiveBlending;
  material.positionNode = pos;
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2 * EXTENT);
    const face = galaxyFace(vec2(q.x, q.y), { arms: L4.x, wind: L4.y, phase: L4.z, seed, elliptical });
    const edge = float(1).sub(smoothstep(1.1, EXTENT, q.length()));
    const light = face.light.mul(exp(face.tau.negate())).mul(edge).mul(gain).mul(X4.w);
    return vec4(light.mul(U.radiance).mul(present).mul(tiny.mul(0.7).add(0.3)), 1);
  })();
  material.name = 'drift-galaxies';

  const geometry = new THREE.PlaneGeometry(1, 1);
  const mesh = new THREE.InstancedMesh(geometry, material, n);
  geometry.setAttribute('galaxyCentre', new THREE.InstancedBufferAttribute(centre, 4));
  geometry.setAttribute('galaxyNormal', new THREE.InstancedBufferAttribute(normal, 4));
  geometry.setAttribute('galaxyX', new THREE.InstancedBufferAttribute(xAxis, 4));
  geometry.setAttribute('galaxyLook', new THREE.InstancedBufferAttribute(look, 4));
  geometry.setAttribute('galaxyIndex', new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => i), 1));
  mesh.frustumCulled = false;
  mesh.name = 'drift-galaxies';
  return mesh;
}
