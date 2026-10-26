/**
 * Earth at dawn, seen from high above (direction G5) — procedural, in its own frame: 1 unit = 1000 km, the
 * planet's centre placed so the final eye sits at the frame's origin. Everything is lit by one Sun, fixed
 * in the dome (where the Milky Way arrival left it), so the scene never needs a camera turn: we come over
 * the planet by translation, and the dawn is the limb lifting toward a Sun that stays put.
 *
 *   SURFACE     a young world (Part B greens it): warped-fbm continents whose coasts stay fractal down to
 *               the pixel, ridged mountain belts, relief shading from the height field's own gradient;
 *               basalt, rust, ochre and pale sediment by province, height and slope; dark deep ocean, teal
 *               shelves, a rough-water sun glint. The clouds' shadows fall on it. Night is black.
 *   CLOUDS      a shell a few km up: weather systems, long frontal bands and cellular cumulus fields, lit
 *               by the same Sun (embossed toward it, so low light gives them tops and shaded sides); they
 *               keep the light a little past the ground's terminator.
 *   ATMOSPHERE  single scattering (Rayleigh + Mie), ray-marched from the eye through a 100 km shell: the
 *               blue limb on the day side, the orange-red band at the terminator, the glow over the night
 *               limb as the Sun rises. Over the ground it only adds its light; the ground and clouds apply
 *               their own (coloured) extinction toward the eye. Against space it also dims what is behind.
 *   SUN         a disc with a glare, at "infinity" in the Sun's direction, hidden by the planet and reddened
 *               by its air as it rises through the limb.
 *
 * WHY EACH SHADER RAY-TRACES ITS SPHERE: the meshes only cover the right pixels. A tessellated sphere's
 * facets sit up to ~0.5 km inside the true one, and at the grazing angles of a 600 km-high view that slides
 * the terrain lookup by many km along the triangle edges — the facets would show, and swim.
 *
 * WHY THE SUNLIGHT IS ANALYTIC: at dawn every light path is grazing, where a few uniform march steps get the
 * optical depth (and so the colour) badly wrong. The column of air along a ray in an exponential atmosphere
 * is a Chapman function: √(πx/2)·erfcx(√(x/2)·μ) with a rational erfcx, and the tangent-point identity below
 * the horizon (`chapmanColumn`, held to numeric integration by tests/earthChapman.test.ts). It gives the
 * ground's and clouds' sunlight, warm at the terminator, the extinction toward the eye (a far glint
 * reddens) and the Sun's own colour in the limb.
 *
 * LOD: from 600 km up a pixel spans ~1 km at the dome's edge and many km toward the limb, and the planet
 * starts as a point. Every fbm fades out its octaves finer than the pixel's footprint on the ground (no
 * shimmer), which also ends its loop early where that detail could not show.
 */
import * as THREE from 'three/webgpu';
import {
  Break,
  Fn,
  If,
  Loop,
  PI,
  abs,
  acos,
  asin,
  cameraPosition,
  cross,
  exp,
  float,
  fract,
  length,
  max,
  min,
  mix,
  mx_noise_float,
  mx_noise_vec3,
  mx_worley_noise_float,
  normalize,
  positionWorld,
  pow,
  screenCoordinate,
  select,
  smoothstep,
  sqrt,
  step,
  uniform,
  uv,
  vec3,
  vec4,
} from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** Mm (1000 km) */
export const EARTH_R = 6.371;
const ATMOS = 0.1;
const H_RAY = 0.008;
const H_MIE = 0.0012;
/** scattering per Mm at sea level */
const BETA_R = vec3(5.8, 13.5, 33.1);
const BETA_M = 6;
const MIE_G = 0.76;
/** Mm, the cloud tops */
const CLOUD_H = 0.007;
/** the Sun's irradiance (linear): a white surface facing it is SUN_E / π */
const SUN_E = 7;
/** rad, the Sun's angular radius */
const SUN_ANG = 0.00465;
/** e^(y²)·erfc(y) ≈ (1 + c·y) / (1 + (a + c)·y + √π·c·y²) for y ≥ 0, within 0.4 % */
const ERFCX_A = 1.09;
const ERFCX_C = 0.6;
const KM = 1 / 6371;

export interface Earth {
  readonly group: THREE.Group;
  update(o: { centre: THREE.Vector3; sun: THREE.Vector3; presence: number; sunPresence: number; pixelAngle: number; eye: THREE.Vector3 }): void;
  dispose(): void;
}

/** ray / sphere: [near, far] distances (far < near when it misses) */
export function sphereHit(o: V3, d: V3, c: V3, r: number | F): { t0: F; t1: F } {
  const oc = o.sub(c);
  const b = oc.dot(d);
  const rr = typeof r === 'number' ? float(r * r) : r.mul(r);
  const disc = b.mul(b).sub(oc.dot(oc)).add(rr);
  const s = sqrt(disc.max(0));
  const miss = disc.lessThan(0);
  return { t0: select(miss, float(1), b.negate().sub(s)) as F, t1: select(miss, float(-1), b.negate().add(s)) as F };
}

/**
 * Mm of sea-level-density air along a ray from radius r (Mm) at cos-zenith μ out to space, scale height H.
 * Below the horizon (μ < 0) the ray passes a tangent point: twice the horizontal column there, less the
 * column behind us. Whether the ray hits the ground is the caller's business. The CPU twin of `column`.
 */
export function chapmanColumn(r: number, mu: number, H: number): number {
  const x = r / H;
  const y = Math.sqrt(x / 2) * Math.abs(mu);
  const erfcx = (1 + ERFCX_C * y) / (1 + (ERFCX_A + ERFCX_C) * y + Math.sqrt(Math.PI) * ERFCX_C * y * y);
  const above = Math.exp(-(r - EARTH_R) / H) * Math.sqrt((Math.PI * x) / 2) * erfcx;
  if (mu >= 0) return H * above;
  const rt = r * Math.sqrt(1 - mu * mu);
  return H * (Math.sqrt((2 * Math.PI * rt) / H) * Math.exp(Math.min(60, -(rt - EARTH_R) / H)) - above);
}

function column(r: F, mu: F, H: number): F {
  const x = r.div(H);
  const y = sqrt(x.mul(0.5)).mul(abs(mu));
  const erfcx = y.mul(ERFCX_C).add(1).div(y.mul(y).mul(Math.sqrt(Math.PI) * ERFCX_C).add(y.mul(ERFCX_A + ERFCX_C)).add(1));
  const above = exp(r.sub(EARTH_R).div(-H)).mul(sqrt(x.mul(Math.PI / 2))).mul(erfcx);
  const rt = r.mul(sqrt(float(1).sub(mu.mul(mu)).max(0)));
  const through = sqrt(rt.mul((2 * Math.PI) / H)).mul(exp(min(rt.sub(EARTH_R).div(-H), 60)));
  return select(mu.lessThan(0), through.sub(above), above).mul(H) as F;
}

/** optical depth (per channel) of the air along a ray from radius r at cos-zenith μ out to space */
const opticalDepth = (r: F, mu: F): V3 => BETA_R.mul(column(r, mu, H_RAY)).add(column(r, mu, H_MIE).mul(BETA_M * 1.1));

/** the Sun's light reaching radius r at cos-zenith μ (white = 1): through the air, and set behind the horizon */
function sunlight(r: F, mu: F): V3 {
  // the horizon dips by √(2h/R) at height h; the Sun's disc makes the setting a fade
  const dip = sqrt(r.sub(EARTH_R).max(0).mul(2 / EARTH_R));
  return exp(opticalDepth(r, mu).negate()).mul(smoothstep(-SUN_ANG, SUN_ANG, asin(mu.clamp(-1, 1)).add(dip)));
}

/** transmittance from a point at radius r up to the eye: the ray's cos-zenith μ there, μe at the eye (radius re) */
const towardEye = (r: F, mu: F, re: F, mue: F): V3 => exp(opticalDepth(r, mu).sub(opticalDepth(re, mue)).max(0).negate());

const LACUNARITY = 2.03;

/** an octave of frequency f fades out as its wavelength shrinks from 4 to 2 footprints (fp, unit sphere) */
const lod = (f: F, fp: F): F => float(1).sub(smoothstep(0.25, 0.5, f.mul(fp)));

/** fbm of gradient noise, its octaves finer than the footprint faded out (and not evaluated) */
function fbm(p: V3, f0: number, octaves: number, gain: number, fp: F): F {
  const sum = float(0).toVar();
  const f = float(f0).toVar();
  const a = float(1).toVar();
  Loop(octaves, ({ i }) => {
    const w = lod(f, fp).toVar();
    If(w.lessThanEqual(0), () => {
      Break();
    });
    sum.addAssign(mx_noise_float(p.mul(f).add(vec3(1.7, -3.1, 2.3).mul(float(i)))).mul(a.mul(w)));
    f.mulAssign(LACUNARITY);
    a.mulAssign(gain);
  });
  return sum;
}

/** ridged multifractal 0..~1: sharp crests, the finer octaves only where the coarser ones are high */
function ridged(p: V3, f0: number, octaves: number, fp: F): F {
  const sum = float(0).toVar();
  const f = float(f0).toVar();
  const a = float(0.5).toVar();
  const weight = float(1).toVar();
  Loop(octaves, ({ i }) => {
    const w = lod(f, fp).toVar();
    If(w.lessThanEqual(0), () => {
      Break();
    });
    const r = float(1).sub(abs(mx_noise_float(p.mul(f).add(vec3(-2.9, 1.3, 4.1).mul(float(i)))))).toVar();
    const s = r.mul(r).mul(weight).toVar();
    sum.addAssign(s.mul(a).mul(w));
    weight.assign(s.mul(2).clamp(0, 1));
    f.mulAssign(LACUNARITY);
    a.mulAssign(0.5);
  });
  return sum;
}

// ------------------------------------------------------------------ terrain
/** sea level in `shape` units; the continents are where shape > SEA */
const SEA = 0.07;
/** the continental fbm's spectrum continues below ~300 km at this amplitude (its 5th octave on) */
const DETAIL_AMP = 0.0625;
/** km of plateau per unit of shape above the sea; km of the tallest ridges */
const PLAIN_KM = 5;
const MOUNT_KM = 4.5;
/** relief exaggeration for the shading */
const RELIEF = 2.2;

/** the fine part of the land at warped position q: the continents' detail (shapes the coast) and the ridges */
function roughness(q: V3, fp: F): { detail: F; peaks: F } {
  return { detail: fbm(q, 1.3 * LACUNARITY ** 4, 9, 0.5, fp).toVar(), peaks: ridged(q.add(vec3(5.2, 1.1, -3.4)), 9, 11, fp).toVar() };
}
/** km of relief above the continental base, the ridges where the mountain belt is */
const reliefKm = (r: { detail: F; peaks: F }, belt: F): F => r.detail.mul(DETAIL_AMP * PLAIN_KM).add(r.peaks.mul(belt).mul(MOUNT_KM));

// ------------------------------------------------------------------ clouds
/** cloud density (cover where > 0): weather systems, frontal bands, cumulus cells, fine detail */
function cloudDensity(n: V3, fp: F): F {
  const w = mx_noise_vec3(n.mul(1.6).add(vec3(4.1, 0.3, 7.7))).mul(0.22);
  const q = n.add(w);
  // where the air is wet: a few large systems, most of a young world's sky clear
  const wet = fbm(q.add(vec3(11, 2, 5)), 1.7, 3, 0.5, fp);
  // fronts: long thin bands along a warped noise's zero line, inside the wet systems
  const front = float(1).sub(smoothstep(0, 0.07, abs(mx_noise_float(q.add(w.mul(1.5)).mul(2.3).add(vec3(9.1, 0, 3))))));
  // cumulus / stratocumulus cells (~40 km), faded to their mean where the cells shrink below the footprint
  const cells = mix(float(0.45), mx_worley_noise_float(q.mul(160), 0.9, 0), lod(float(160), fp));
  const detail = fbm(q.add(vec3(3, 7, 1)), 40, 8, 0.55, fp);
  return wet.mul(1.5).add(front.mul(0.55).mul(smoothstep(-0.25, 0.1, wet))).add(float(0.45).sub(cells).mul(0.55)).add(detail.mul(0.55)).sub(0.42);
}
const cloudCover = (density: F): F => smoothstep(0, 0.3, density);

export function createEarth(): Earth {
  const u = {
    centre: uniform(new THREE.Vector3()),
    sun: uniform(new THREE.Vector3(0, 0, -1)),
    presence: uniform(0),
    sunPresence: uniform(0),
    pixelAngle: uniform(0.0015),
  };
  const C = u.centre as unknown as V3;
  const S = u.sun as unknown as V3;
  const P = u.pixelAngle as unknown as F;
  const eyeR = length(cameraPosition.sub(C));
  const eyeUp = normalize(cameraPosition.sub(C));

  /** where this pixel's view ray meets the sphere of radius r (the mesh's own point if it misses) */
  const onSphere = (r: number): { t: F; n: V3; d: V3 } => {
    const d = normalize(positionWorld.sub(cameraPosition));
    const h = sphereHit(cameraPosition, d, C, r);
    const t = select(h.t1.greaterThan(h.t0), h.t0, length(positionWorld.sub(cameraPosition))) as F;
    return { t, d, n: normalize(cameraPosition.add(d.mul(t)).sub(C)) };
  };
  /** unit tangent toward the Sun's azimuth at n (any tangent at the subsolar point) */
  const sunward = (n: V3, muS: F): V3 => {
    const t = S.sub(n.mul(muS));
    return normalize(select(length(t).greaterThan(1e-5), t, cross(n, vec3(0.48, 0.6, 0.64)))) as V3;
  };
  /** a pixel's footprint on the sphere (unit-sphere units), stretched where the view is grazing */
  const footprint = (t: F, muV: F): F => t.mul(P).div(sqrt(muV.max(0.03))).div(EARTH_R);

  // ------------------------------------------------------------------ surface
  const surfMat = new THREE.MeshBasicNodeMaterial();
  surfMat.colorNode = Fn(() => {
    const { t, d, n } = onSphere(EARTH_R);
    const v = d.negate();
    const muV = n.dot(v).max(1e-3);
    const muS = n.dot(S);
    const fp = footprint(t, muV).toVar();
    const t1 = sunward(n, muS).toVar();
    const t2 = cross(n, t1);
    // geology on a warped sphere: continents, provinces and mountain belts are coarse, shared by the samples
    const q = n.add(mx_noise_vec3(n.mul(1.1).add(vec3(2.7, 5.1, 0.4))).mul(0.3)).toVar();
    const cont = fbm(q, 1.3, 4, 0.5, fp);
    const r0 = roughness(q, fp);
    const s = cont.add(r0.detail.mul(DETAIL_AMP)).sub(SEA).toVar();
    const landK = select(s.greaterThan(0), float(1), float(0));
    const belt = smoothstep(0.72, 0.96, float(1).sub(abs(mx_noise_float(q.mul(1.9).add(vec3(5.3, 2, 8)))))).mul(smoothstep(0, 0.06, s)).toVar();
    const km0 = reliefKm(r0, belt).toVar();
    // relief: the height field's gradient along the Sun's azimuth and across it
    const eps = max(fp, 0.4 * KM).toVar();
    const g1 = reliefKm(roughness(q.add(t1.mul(eps)), fp), belt).sub(km0).div(eps.mul(6371)).mul(landK).toVar();
    const g2 = reliefKm(roughness(q.add(t2.mul(eps)), fp), belt).sub(km0).div(eps.mul(6371)).mul(landK).toVar();
    const N = normalize(n.sub(t1.mul(g1).add(t2.mul(g2)).mul(RELIEF)));
    const slope = sqrt(g1.mul(g1).add(g2.mul(g2)));
    const km = s.max(0).mul(PLAIN_KM).add(r0.peaks.mul(belt).mul(MOUNT_KM)).mul(landK);

    // land: dark basalt provinces, rust and ochre weathering, pale sediment in the lowlands and basins;
    // exposed dark rock on the steep slopes
    const prov = fbm(q.add(vec3(-4, 9, 2)), 2.6, 4, 0.55, fp);
    const oxide = fbm(q.add(vec3(7, -1, 5)), 5, 4, 0.55, fp);
    const basalt = mix(vec3(0.03, 0.03, 0.03), vec3(0.075, 0.058, 0.045), smoothstep(-0.3, 0.3, r0.detail));
    const weathered = mix(vec3(0.2, 0.075, 0.032), vec3(0.32, 0.2, 0.085), smoothstep(-0.25, 0.35, oxide));
    const rock = mix(basalt, weathered, smoothstep(-0.12, 0.12, prov.add(r0.detail.mul(0.25))));
    const lowland = float(1).sub(smoothstep(0.004, 0.05, s.add(r0.detail.mul(0.02)))).mul(smoothstep(-0.4, 0.2, oxide.add(prov)));
    const ground = mix(rock, vec3(0.44, 0.38, 0.3), lowland.mul(0.85));
    const landAlbedo = mix(ground, vec3(0.04, 0.036, 0.034), smoothstep(0.08, 0.35, slope).mul(0.6)).mul(r0.detail.mul(0.6).add(1).clamp(0.6, 1.4));
    // water: deep blue-black, teal over the shelves, paler over the shallowest sand
    const depth = s.negate().max(0);
    const water = mix(vec3(0.003, 0.009, 0.02), vec3(0.01, 0.045, 0.05), exp(depth.div(-0.018))).add(vec3(0.03, 0.06, 0.045).mul(exp(depth.div(-0.003))));
    // the coast, antialiased over one footprint of `shape`
    const coast = smoothstep(fp.negate(), fp, s);
    const albedo = mix(water, landAlbedo, coast);

    // sunlight at the terrain's height (the peaks keep it a little longer), under the clouds' shadows
    const sun = sunlight(float(EARTH_R).add(km.mul(0.001 * RELIEF)), muS).toVar();
    const tanZ = sqrt(float(1).sub(muS.mul(muS)).max(0)).div(muS.max(0.08));
    const shadowAt = normalize(n.add(t1.mul(tanZ.mul(CLOUD_H / EARTH_R))));
    const shade = float(1).sub(cloudCover(cloudDensity(shadowAt, max(fp, 2 * KM))).mul(0.85));
    const diffuse = mix(muS, N.dot(S), coast).max(0);
    // skylight: a little blue fill on the day side (none on the night side)
    const sky = vec3(0.3, 0.45, 0.8).mul(smoothstep(-0.06, 0.3, muS).mul(0.05));
    const lit = albedo.mul(sun.mul(diffuse).mul(shade).add(sky)).mul(SUN_E / Math.PI);
    // glint: GGX on the open water, its roughness by wind patches; Fresnel and the long grazing paths make
    // it swell and redden toward the terminator
    const h = normalize(S.add(v));
    const a = mix(float(0.07), float(0.22), smoothstep(-0.35, 0.35, fbm(n.add(vec3(1, 4, 2)), 14, 4, 0.5, fp)));
    const a2 = a.mul(a);
    const nh = n.dot(h).max(0);
    const ggx = a2.div(PI.mul(pow(nh.mul(nh).mul(a2.sub(1)).add(1), 2)));
    const fresnel = pow(float(1).sub(v.dot(h).max(0)), 5).mul(0.98).add(0.02);
    const smith = (m: F): F => m.mul(2).div(m.add(sqrt(a2.add(float(1).sub(a2).mul(m.mul(m))))));
    const glint = ggx.mul(fresnel).mul(smith(muS.max(1e-3))).mul(smith(muV)).div(muV.mul(4)).mul(float(1).sub(coast)).mul(shade);
    // the sky in the water: Fresnel at grazing angles
    const skyInWater = vec3(0.25, 0.4, 0.75).mul(pow(float(1).sub(muV), 5).mul(0.03).mul(smoothstep(-0.05, 0.3, muS))).mul(float(1).sub(coast));
    const out = lit.add(sun.mul(glint).add(skyInWater).mul(SUN_E));
    const T = towardEye(float(EARTH_R), muV, eyeR, eyeUp.dot(v));
    return vec4(out.mul(T).mul(u.presence), 1);
  })();
  surfMat.name = 'drift-earth-surface';
  const surface = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 256, 128), surfMat);
  surface.frustumCulled = false;
  surface.name = 'drift-earth-surface';

  // ------------------------------------------------------------------ clouds
  const cloudMat = new THREE.MeshBasicNodeMaterial();
  cloudMat.transparent = true;
  cloudMat.depthWrite = false;
  cloudMat.colorNode = Fn(() => {
    const rc = EARTH_R + CLOUD_H;
    const { t, d, n } = onSphere(rc);
    const v = d.negate();
    const muV = n.dot(v).max(1e-3);
    const muS = n.dot(S);
    const fp = footprint(t, muV).toVar();
    const dens = cloudDensity(n, fp).toVar();
    const cover = cloudCover(dens).toVar();
    const col = vec3(0).toVar();
    If(cover.greaterThan(0.002), () => {
      // embossed toward the Sun: density as a height field (~3 km of relief), its slope along the light
      const eps = max(fp, 1.5 * KM);
      const dens1 = cloudDensity(normalize(n.add(sunward(n, muS).mul(eps))), fp);
      const slope = dens1.sub(dens).div(eps).mul(3 * KM).clamp(-3, 3);
      const ndl = muS.sub(sqrt(float(1).sub(muS.mul(muS)).max(0)).mul(slope)).div(sqrt(slope.mul(slope).add(1)));
      // thick cloud scatters light round into its shaded side; forward scattering lights it against the Sun
      const wrap = ndl.mul(0.65).add(0.35).max(0);
      const g = 0.55;
      const fwd = float(1 - g * g).div(pow(float(1 + g * g).sub(d.dot(S).mul(2 * g)), 1.5)).mul(0.08);
      const sky = vec3(0.3, 0.45, 0.8).mul(smoothstep(-0.06, 0.3, muS).mul(0.08));
      const T = towardEye(float(rc), muV, eyeR, eyeUp.dot(v));
      col.assign(sunlight(float(rc), muS).mul(wrap.add(fwd)).add(sky).mul((0.9 * SUN_E) / Math.PI).mul(T));
    });
    return vec4(col.mul(u.presence), cover.mul(0.95).mul(u.presence));
  })();
  cloudMat.name = 'drift-earth-clouds';
  const clouds = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R + CLOUD_H, 192, 96), cloudMat);
  clouds.frustumCulled = false;
  clouds.renderOrder = 1;
  clouds.name = 'drift-earth-clouds';

  // ------------------------------------------------------------------ atmosphere
  const atmMat = new THREE.MeshBasicNodeMaterial();
  atmMat.transparent = true;
  atmMat.depthWrite = false;
  atmMat.depthTest = false;
  // back faces: they cover the same pixels from outside, and still do from inside the shell
  atmMat.side = THREE.BackSide;
  atmMat.blending = THREE.CustomBlending;
  atmMat.blendSrc = THREE.OneFactor;
  atmMat.blendDst = THREE.OneMinusSrcAlphaFactor;
  atmMat.colorNode = Fn(() => {
    const o = cameraPosition;
    const d = normalize(positionWorld.sub(o));
    const atm = sphereHit(o, d, C, EARTH_R + ATMOS);
    const gnd = sphereHit(o, d, C, EARTH_R);
    const t0 = atm.t0.max(0);
    const hitGround = gnd.t1.greaterThan(gnd.t0).and(gnd.t0.greaterThan(0));
    const t1 = select(hitGround, gnd.t0, atm.t1);
    const STEPS = 32;
    const ds = t1.sub(t0).max(0).div(STEPS);
    const inR = vec3(0).toVar();
    const inM = vec3(0).toVar();
    const odR = float(0).toVar();
    const odM = float(0).toVar();
    const mu = d.dot(S);
    const phaseR = float(3).div(PI.mul(16)).mul(mu.mul(mu).add(1));
    const g2 = MIE_G * MIE_G;
    const phaseM = float(3 * (1 - g2)).div(PI.mul(8 * (2 + g2))).mul(mu.mul(mu).add(1)).div(pow(float(1 + g2).sub(mu.mul(2 * MIE_G)), float(1.5)));
    // a per-pixel jitter of the samples turns banding into fine grain
    const jitter = fract(fract(screenCoordinate.x.mul(0.06711056).add(screenCoordinate.y.mul(0.00583715))).mul(52.9829189));
    If(t1.greaterThan(t0), () => {
      Loop(STEPS, ({ i }) => {
        const p = o.add(d.mul(t0.add(float(i).add(jitter).mul(ds))));
        const r = length(p.sub(C));
        const h = r.sub(EARTH_R).max(0);
        const rR = exp(h.div(H_RAY).negate()).mul(ds);
        const rM = exp(h.div(H_MIE).negate()).mul(ds);
        odR.addAssign(rR.mul(0.5));
        odM.addAssign(rM.mul(0.5));
        // the Sun's light here, through the air above (analytic), none in the planet's shadow
        const att = exp(BETA_R.mul(odR).add(vec3(BETA_M * 1.1).mul(odM)).negate()).mul(sunlight(r, p.sub(C).dot(S).div(r)));
        inR.addAssign(att.mul(rR));
        inM.addAssign(att.mul(rM));
        odR.addAssign(rR.mul(0.5));
        odM.addAssign(rM.mul(0.5));
      });
    });
    const light = inR.mul(BETA_R).mul(phaseR).add(inM.mul(BETA_M).mul(phaseM)).mul(SUN_E);
    const T = exp(BETA_R.mul(odR).add(vec3(BETA_M * 1.1).mul(odM)).negate());
    // over the ground the haze is held back: from a few hundred km up nearly every view is grazing, and the
    // full haze flattens the planet to a pale disc. The limb, seen against space, keeps all of it and dims
    // the stars behind it.
    const overGround = select(hitGround, float(1), float(0));
    const alpha = float(1).sub(T.x.add(T.y).add(T.z).div(3)).mul(float(1).sub(overGround));
    return vec4(light.mul(mix(float(1), float(0.6), overGround)).mul(u.presence), alpha.mul(u.presence));
  })();
  atmMat.name = 'drift-earth-atmosphere';
  const atmosphere = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R + ATMOS, 192, 96), atmMat);
  atmosphere.frustumCulled = false;
  atmosphere.renderOrder = 2;
  atmosphere.name = 'drift-earth-atmosphere';

  // ------------------------------------------------------------------ the Sun
  const sunDistance = 4000;
  const sunPos = cameraPosition.add(S.mul(sunDistance));
  const sunMat = new THREE.NodeMaterial();
  sunMat.transparent = true;
  sunMat.depthWrite = false;
  sunMat.depthTest = false;
  sunMat.side = THREE.DoubleSide;
  sunMat.blending = THREE.AdditiveBlending;
  const QUAD = 1.2; // rad across: room for the glare to fall to nothing before the quad's edge
  sunMat.positionNode = eyeFacing(sunPos, float(sunDistance * QUAD));
  /** what of the Sun's light reaches the eye along d: none through the planet, reddened through its air */
  const pastEarth = (d: V3): V3 => {
    const g = sphereHit(cameraPosition, d, C, EARTH_R);
    const blocked = g.t1.greaterThan(g.t0).and(g.t1.greaterThan(0));
    return exp(opticalDepth(eyeR, eyeUp.dot(d)).negate()).mul(select(blocked, float(0), float(1)));
  };
  sunMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const r = q.length().mul(QUAD / 2); // rad from the Sun's centre
    const disc = smoothstep(0.0052, 0.0042, r).mul(60);
    // the glare is the eye's (or lens's) response to the whole disc: it goes as the disc sets behind the limb
    const aboveLimb = acos(eyeUp.dot(S).negate().clamp(-1, 1)).sub(asin(float(EARTH_R).div(eyeR)));
    const seen = pastEarth(S).mul(smoothstep(-SUN_ANG, SUN_ANG, aboveLimb));
    const glare = exp(r.div(0.01).negate()).mul(5).add(exp(r.div(0.045).negate()).mul(0.22)).add(exp(r.div(0.15).negate()).mul(0.02));
    const rays = exp(abs(q.x).div(max(u.pixelAngle.div(QUAD / 2), 0.002)).negate()).mul(exp(abs(q.y).mul(14).negate()))
      .add(exp(abs(q.y).div(max(u.pixelAngle.div(QUAD / 2), 0.002)).negate()).mul(exp(abs(q.x).mul(14).negate())))
      .mul(0.25);
    const fade = float(1).sub(smoothstep(0.6, 1, q.length()));
    const light = pastEarth(normalize(positionWorld.sub(cameraPosition))).mul(disc).add(seen.mul(glare.add(rays)));
    return vec4(vec3(1, 0.95, 0.86).mul(light).mul(fade).mul(u.sunPresence), 1);
  })();
  sunMat.name = 'drift-earth-sun';
  const sun = billboardMesh(sunMat, 1, 'drift-earth-sun');
  sun.renderOrder = 3;

  // ------------------------------------------------------------------ the blue point
  // while the planet is smaller than a few pixels the meshes cannot show it: a pixel-floored point does,
  // as bright as its sunlit part (and the forward-scattering ring of its air when it is backlit)
  const toEarth = C.sub(cameraPosition);
  const dist = toEarth.length();
  const rpx = float(EARTH_R).div(dist).div(u.pixelAngle);
  const lit = normalize(cameraPosition.sub(C)).dot(S).mul(0.5).add(0.5);
  const pointGain = float(1).sub(smoothstep(2, 6, rpx)).mul(lit.mul(1.6).add(0.25)).mul(u.presence);
  const pointMat = new THREE.NodeMaterial();
  pointMat.transparent = true;
  pointMat.depthWrite = false;
  pointMat.depthTest = false;
  pointMat.side = THREE.DoubleSide;
  pointMat.blending = THREE.AdditiveBlending;
  pointMat.positionNode = eyeFacing(C, dist.mul(u.pixelAngle).mul(6).mul(step(0.0005, pointGain)));
  pointMat.colorNode = Fn(() => {
    const r = uv().sub(0.5).mul(2).length();
    return vec4(vec3(0.55, 0.75, 1).mul(exp(r.div(0.3).pow(2).negate())).mul(pointGain).mul(3), 1);
  })();
  pointMat.name = 'drift-earth-point';
  const point = billboardMesh(pointMat, 1, 'drift-earth-point');

  const group = new THREE.Group();
  group.name = 'drift-earth';
  group.add(surface, clouds, atmosphere, sun, point);
  return {
    group,
    update(o) {
      u.centre.value.copy(o.centre);
      u.sun.value.copy(o.sun).normalize();
      u.presence.value = o.presence;
      u.sunPresence.value = o.sunPresence;
      u.pixelAngle.value = o.pixelAngle;
      surface.position.copy(o.centre);
      clouds.position.copy(o.centre);
      atmosphere.position.copy(o.centre);
    },
    dispose() {
      for (const m of [surface, clouds, atmosphere, sun, point]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
    },
  };
}
