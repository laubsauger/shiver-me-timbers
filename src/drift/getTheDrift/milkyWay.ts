/**
 * Our galaxy, close up (G2–G4): the analytic model (galaxyModel.ts) RAY-MARCHED as a volume, seen from
 * wherever the eye is — a tilted disc from outside, the disk rushing up on approach, the band arcing over
 * the dome from inside — plus the stars near the Sun point as real points (parallax as we arrive), and the
 * Sun itself.
 *
 * The volume is drawn on a sphere around the eye, per view direction (sky.ts reasoning: all six cube faces
 * of a dome capture agree). Each ray is clipped to the galaxy's bounding ball AND to the slab around its
 * plane, so the samples go where the light is: an oblique ray through the thin disk gets all of them, a ray
 * along the plane spreads them over its whole length. A per-pixel jitter turns step banding into fine
 * grain, which the bloom and the projector soften.
 *
 * Emission and dust absorption integrate front to back (L += T·j·ds, T *= e^(−κ ds)), so the dust lanes
 * silhouette the bright centre exactly as the Great Rift does.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  abs,
  atan,
  attribute,
  cameraPosition,
  exp,
  float,
  fract,
  instanceIndex,
  length,
  max,
  min,
  mix,
  normalize,
  positionWorld,
  screenCoordinate,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { galaxyVolume } from './galaxyModel';
import { SUN_TINT, sunBloom } from './atmosphere';
import { OUR_LOOK } from './galaxies';
import { rng } from '../undertime/web';
import { eyeFacing, billboardMesh } from '../undertime/billboard';
import type { OurGalaxy } from './timeline';

type V3 = THREE.Node<'vec3'>;

export interface MilkyWay {
  readonly group: THREE.Group;
  update(o: {
    volume: number;
    local: number;
    sunStar: number;
    radiance: number;
    pixelAngle: number;
    eye: THREE.Vector3;
    /** a planet in front of the sky (Earth): what lies behind it is hidden; radius 0 = none */
    occluder: { centre: THREE.Vector3; radius: number };
    /** the sky's turn about the eye (world from sky) */
    skyTurn: THREE.Matrix3;
  }): void;
  dispose(): void;
}

/** dust extinction per channel relative to green (interstellar reddening: ~1/λ) */
const REDDEN = vec3(0.72, 1, 1.38);
/**
 * How far the march reaches above and below the plane, and from the centre (radii) — where the samples go — and the
 * share of each, from its edge inward, over which the light is TAPERED to nothing before the march stops.
 * THE HARD EDGE (the user, 2026-10-30, ~105–112 s: "a very sharp edge, like a cutoff edge that is definitely not like a
 * smooth round bulge … really doing a hard cut there"): the slab was 0.2 radii and cut the light off there, but the
 * bulge still shone at a quarter of a unit per radius at that height (exp(−1.6·0.2/0.055)·3.5·25). While the eye sinks
 * through 0.42 → 0.13 radii above the plane on its way in, the slab's surface is seen nearly edge-on, and it cut the
 * bulge's upper halo along a straight line beside the core, parallel to the disk: in every view, the dome master's as
 * the 16:9's (A/B on the farm, out/drift/review/webfly/edge_{A,B,C,E}: the edge went with the volume, not with the
 * impostors or the dust; a CPU march of the model put it on the slab). Now the slab is 0.3 (the bulge 50× fainter at its
 * surface) and the light fades out over its outer TAPER share, and the ball's, so no surface of the march has light
 * left to cut — a taller slab alone would have moved the line, not removed it.
 */
const SLAB = 0.3;
const BALL = 1.3;
const TAPER = 0.4;

// ------------------------------------------------------------------ the stars near the Sun point
// two populations: the neighbourhood (the bright naked-eye stars, nearly all round the sky) and, fainter
// and many more, the stars out to a few thousand light years in the thin disk — they crowd toward the
// band, as in every wide Milky Way photograph (references: milky-way, star density rising to the plane).
// Shared with the sea's night (nightSky.ts), which draws the same stars as seen from the Sun.
const NEARBY = 14000;
const DISC = 50000;
const COUNT = NEARBY + DISC;
/** rad, a star's drawn width: 0.64 px of a 1024 dome master (576 px faces), the look the field was set at */
export const STAR_SIGMA = (0.64 * Math.PI) / 2 / 576;
/** a star's peak radiance per unit flux at STAR_SIGMA (its light, π·STAR_SIGMA²·this·flux, at any width) */
export const STAR_PEAK = 0.25;
/** radii: the stars' spacing near the Sun, and the distance a star's flux is normalised at */
const SPACING = 0.003;
const FLUX_D0 = 0.014;
const FLUX_CAP = 60;
/** the Sun star's flux as the eye arrives at it: where it is all of the Earth's Sun (earth.ts) */
const SUN_CAP = 4000;

/** the stars near the Sun point: world position (xyz) and luminosity (w) of each, COUNT of them, fixed by seed */
export function localStars(g: OurGalaxy): Float32Array {
  const r = rng(9001);
  const H = 0.035; // star scale height (radii) of the neighbourhood, a little thicker than the gas
  const NEAR = 0.09; // radius (radii) of the neighbourhood drawn as points
  const local = new Float32Array(COUNT * 4);
  for (let i = 0; i < COUNT; i++) {
    const disc = i >= NEARBY;
    const a = r() * Math.PI * 2;
    const rr = disc ? NEAR * (1 + 4 * Math.pow(r(), 0.7)) : Math.sqrt(r()) * NEAR;
    const z = (disc ? 0.032 : H) * Math.atanh(Math.min(0.999999, Math.max(-0.999999, r() * 2 - 1))) * 0.5;
    // luminosity: many faint, few bright (a steep power law)
    const lum = (Math.pow(r(), 6) * 40 + 0.15) * (disc ? 2.5 : 1);
    const p = [0, 1, 2].map((k) => g.sun[k] + (g.xAxis[k] * Math.cos(a) * rr + g.yAxis[k] * Math.sin(a) * rr + g.normal[k] * z) * g.radius);
    local.set([p[0], p[1], p[2], lum], i * 4);
  }
  return local;
}

/** CPU twin of the shader's `flux` below: a star of luminosity `lum` seen from `dist` (world) */
export function localStarFlux(lum: number, dist: number, radius: number): number {
  return Math.min(lum * Math.pow((FLUX_D0 * radius) / Math.max(dist, SPACING * radius * 0.15), 2), FLUX_CAP);
}

/** a star's temperature-like rank, 0..1, from its index — float32 on the CPU as the shader computes it */
export function starTemp(i: number): number {
  const x = Math.fround(Math.fround(i) * Math.fround(0.61803398875));
  return x - Math.floor(x);
}

/** a star's colour from its rank: a share orange-red, most a warm white, a share blue-white */
export const starTint = (temp: THREE.Node<'float'>): V3 =>
  mix(mix(vec3(1, 0.72, 0.5), vec3(1, 0.95, 0.88), smoothstep(0, 0.55, temp)), vec3(0.72, 0.82, 1), smoothstep(0.75, 1, temp)) as V3;

export function createMilkyWay(g: OurGalaxy, steps: number): MilkyWay {
  const u = {
    centre: uniform(new THREE.Vector3(...g.centre)),
    X: uniform(new THREE.Vector3(...g.xAxis)),
    Y: uniform(new THREE.Vector3(...g.yAxis)),
    N: uniform(new THREE.Vector3(...g.normal)),
    radius: uniform(g.radius),
    volume: uniform(0),
    local: uniform(0),
    sunStar: uniform(0),
    radiance: uniform(1),
    pixelAngle: uniform(0.0015),
    sun: uniform(new THREE.Vector3(...g.sun)),
    occCentre: uniform(new THREE.Vector3()),
    occRadius: uniform(0),
    /** the sky's turn about the eye (the time-lapse over Earth): world → sky, and its inverse */
    skyToWorld: uniform(new THREE.Matrix3()),
    worldToSky: uniform(new THREE.Matrix3()),
  };
  const v3 = (x: unknown): V3 => x as V3;
  /** 1 where direction d from the eye is NOT blocked by the occluding planet */
  const clear = (d: V3): THREE.Node<'float'> => {
    const oc = v3(u.occCentre).sub(cameraPosition);
    const b = oc.dot(d);
    const m2 = oc.dot(oc).sub(b.mul(b));
    return float(1).sub(step(m2, u.occRadius.mul(u.occRadius)).mul(step(0, b)));
  };
  const look = { arms: float(OUR_LOOK.arms), wind: float(OUR_LOOK.wind), phase: float(OUR_LOOK.phase), seed: float(OUR_LOOK.seed), elliptical: float(0) };

  // ------------------------------------------------------------------ the volume
  const material = new THREE.MeshBasicNodeMaterial();
  material.side = THREE.BackSide;
  material.transparent = true;
  material.depthWrite = false;
  material.depthTest = false;
  material.blending = THREE.AdditiveBlending;
  material.colorNode = Fn(() => {
    const dWorld = normalize(positionWorld.sub(cameraPosition));
    const d = u.worldToSky.mul(dWorld);
    const rel = cameraPosition.sub(v3(u.centre)).div(u.radius);
    const o = vec3(rel.dot(v3(u.X)), rel.dot(v3(u.Y)), rel.dot(v3(u.N)));
    const dl = vec3(d.dot(v3(u.X)), d.dot(v3(u.Y)), d.dot(v3(u.N)));
    const light = vec3(0).toVar();
    const T = vec3(1).toVar();
    // the ball
    const b = o.dot(dl);
    const c = o.dot(o).sub(BALL * BALL);
    const disc = b.mul(b).sub(c);
    If(disc.greaterThan(0).and(u.volume.greaterThan(0.001)), () => {
      const sq = sqrt(disc);
      const t0 = b.negate().sub(sq).max(0).toVar();
      const t1 = b.negate().add(sq).toVar();
      // the slab |z| < SLAB: entry and exit along the ray; a ray (almost) parallel to the plane keeps the
      // ball's interval if it starts inside the slab, else has none
      const dz = dl.z;
      const flat = step(abs(dz), 1e-5);
      const dzSafe = mix(dz, float(1e-5), flat);
      const ta = float(-SLAB).sub(o.z).div(dzSafe);
      const tb = float(SLAB).sub(o.z).div(dzSafe);
      const inside = step(abs(o.z), SLAB);
      t0.assign(mix(max(t0, min(ta, tb)), mix(t1, t0, inside), flat));
      t1.assign(mix(min(t1, max(ta, tb)), mix(t0, t1, inside), flat));
      If(t1.greaterThan(t0), () => {
        const ds = t1.sub(t0).div(steps);
        const jitter = fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189);
        const j = fract(jitter);
        Loop(steps, ({ i }) => {
          const tt = t0.add(float(i).add(j).mul(ds));
          const x = o.add(dl.mul(tt));
          const s = galaxyVolume(x, look);
          // (nothing left at the march's own bounds to cut: TAPER above)
          const keep = float(1).sub(smoothstep(SLAB * (1 - TAPER), SLAB, abs(x.z))).mul(float(1).sub(smoothstep(BALL * (1 - TAPER * 0.4), BALL, length(x))));
          // the diffuse light is the DISTANT stars: the near ones are drawn as points (below), so the glow of
          // the first ~0.05 radii around the eye is left out — or the whole sky would be a milky wash
          const near = smoothstep(0.03, 0.1, tt);
          light.addAssign(s.emit.mul(T).mul(ds).mul(near).mul(keep));
          // dust dims blue more than red: the rift's edges brown, the band behind it warm (references:
          // milky-way — never a blue-purple band)
          T.mulAssign(exp(REDDEN.mul(s.kappa.mul(ds)).negate()));
        });
      });
    });
    return vec4(light.mul(u.radiance).mul(u.volume).mul(clear(dWorld)), 1);
  })();
  material.name = 'drift-milky-way';
  const sky = new THREE.Mesh(new THREE.SphereGeometry(400, 96, 48), material);
  sky.frustumCulled = false;
  sky.renderOrder = -1;
  sky.name = 'drift-milky-way';

  // ------------------------------------------------------------------ the stars near the Sun point
  const local = localStars(g);
  const S = attribute<'vec4'>('starLocal', 'vec4');
  const k = float(instanceIndex);
  // turned with the sky about the eye
  const starPos = cameraPosition.add(u.skyToWorld.mul(S.xyz.sub(cameraPosition)));
  const toStar = starPos.sub(cameraPosition);
  const dist = toStar.length();
  // flux falls with distance squared, normalised to a star a little out in the neighbourhood (so the sky
  // holds thousands of visible points); capped as one passes close
  const spacing = SPACING * g.radius;
  const D0 = FLUX_D0 * g.radius;
  const flux = min(S.w.mul(float(D0).div(dist.max(spacing * 0.15)).pow(2)), FLUX_CAP);
  // a star's LIGHT is set in angle, not in pixels: drawn STAR_SIGMA rad wide (or ~0.64 px where pixels are
  // coarser), its peak scaled so the total is the same at every resolution — at a fixed pixel size a star
  // carried a quarter of its light at 2160 that it had at 1024, and the streaming stars all but vanished
  const sigma = max(u.pixelAngle.mul(0.64), STAR_SIGMA);
  const payback = float(STAR_SIGMA).div(sigma).pow(2);
  const quad = dist.mul(sigma).mul(6.25);
  const tint = starTint(fract(k.mul(0.61803398875)));
  const starMat = new THREE.NodeMaterial();
  starMat.transparent = true;
  starMat.depthWrite = false;
  starMat.side = THREE.DoubleSide;
  starMat.blending = THREE.AdditiveBlending;
  starMat.positionNode = eyeFacing(starPos, quad.mul(step(0.0005, u.local)));
  starMat.colorNode = Fn(() => {
    const rr2 = length(uv().sub(0.5)).mul(2);
    const core = exp(rr2.div(0.32).pow(2).negate());
    return vec4(tint.mul(flux).mul(payback).mul(core).mul(u.local).mul(STAR_PEAK).mul(clear(normalize(toStar))), 1);
  })();
  starMat.name = 'drift-local-stars';
  const stars = billboardMesh(starMat, COUNT, 'drift-local-stars');
  stars.geometry.setAttribute('starLocal', new THREE.InstancedBufferAttribute(local, 4));

  // ------------------------------------------------------------------ the Sun
  const sunDist = v3(u.sun).sub(cameraPosition).length();
  const sunFlux = min(float(3).mul(float(spacing).div(sunDist.max(spacing * 0.01)).pow(2)), SUN_CAP).mul(u.sunStar);
  // (rad across: room for its veil to fill its part of the sky)
  const sunQuad = sunDist.mul(1.6);
  const sunMat = new THREE.NodeMaterial();
  sunMat.transparent = true;
  sunMat.depthWrite = false;
  sunMat.side = THREE.DoubleSide;
  sunMat.blending = THREE.AdditiveBlending;
  sunMat.positionNode = eyeFacing(v3(u.sun), sunQuad.mul(step(0.0005, u.sunStar)));
  sunMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const o = q.mul(0.8); // the quad's plane, rad from the Sun along it
    const r = atan(o.length());
    // core (pixel-sized at first), and around it the Sun's veil and rays as the Earth's Sun has them
    // (atmosphere.ts sunBloom), growing in with its brightness: all of them at the cap, so the hand-over to the
    // Earth's Sun is not seen. (Its old glare, two Gaussians, read as a lens flare: the user, 2026-10-29)
    const core = exp(r.div(u.pixelAngle.mul(1.5)).pow(2).negate()).mul(sunFlux);
    const bloom = sunBloom(o, r, u.pixelAngle).mul(sunFlux.div(SUN_CAP));
    return vec4(SUN_TINT.mul(bloom.add(core)).mul(float(1).sub(smoothstep(0.6, 1, q.length()))), 1);
  })();
  sunMat.name = 'drift-sun-star';
  const sunStar = billboardMesh(sunMat, 1, 'drift-sun-star');

  const group = new THREE.Group();
  group.name = 'drift-milky-way';
  group.add(sky, stars, sunStar);
  return {
    group,
    update(o) {
      u.volume.value = o.volume;
      u.local.value = o.local;
      u.sunStar.value = o.sunStar;
      u.occCentre.value.copy(o.occluder.centre);
      u.occRadius.value = o.occluder.radius;
      u.radiance.value = o.radiance;
      u.pixelAngle.value = o.pixelAngle;
      u.skyToWorld.value.copy(o.skyTurn);
      u.worldToSky.value.copy(o.skyTurn).transpose();
      sky.position.copy(o.eye);
    },
    dispose() {
      for (const m of [sky, stars, sunStar]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}

