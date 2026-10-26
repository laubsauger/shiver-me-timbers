/**
 * Earth at dawn, seen from high above (direction G5) — the measured planet, in its own frame: 1 unit = 1000 km,
 * the planet's centre placed so the final eye sits at the frame's origin. Everything is lit by one Sun, fixed
 * in the dome (where the Milky Way arrival left it), so the scene never needs a camera turn: we come over
 * the planet by translation, and the dawn is the limb lifting toward a Sun that stays put.
 *
 *   SURFACE     the satellites' Earth (earthMaps.ts): Blue Marble colour, the measured elevation for the
 *               relief shading (exaggerated) and for the flood, open water deep navy with teal shelves and a
 *               rough-water sun glint; Part B's life layers over it (lifeLayers.ts). The clouds' shadows
 *               fall on it. Night is black but for the Black Marble's lights.
 *   CLOUDS      a shell a few km up: a real day's cloud field over Europe (VIIRS), NASA's composite
 *               elsewhere, with sub-km texture at the edges; lit by the same Sun (embossed toward it, so low
 *               light gives them tops and shaded sides), lit from below at night by the towns.
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
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { lifeAlbedo, nightLights, seaLevel, type LifeUniforms } from './lifeLayers';
import { GLOBAL_ELEV_TEXEL, latLon, loadEarthMaps, mapCoords, sampleBoth, type GeoFrame } from './earthMaps';
import { driftMatter, type DriftUniforms } from './debris';
import type { LifeState } from './life';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

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
  /** resolves once the maps are on the GPU side (a render must wait for it) */
  readonly ready: Promise<void>;
  /** the planet's orientation: world-space unit vectors to the north pole, to lon 0° lat 0°, to lon 90°E */
  setGeo(g: { north: THREE.Vector3; zero: THREE.Vector3; east: THREE.Vector3 }): void;
  update(o: {
    /** s, act time (the clouds drift with it) */
    time: number;
    centre: THREE.Vector3;
    sun: THREE.Vector3;
    presence: number;
    sunPresence: number;
    pixelAngle: number;
    eye: THREE.Vector3;
    /** Part B (life.ts): the time-wave layers, the lights, the flood; omitted = the young world */
    life?: LifeState & { waveOrigin: THREE.Vector3 };
    /** Drift-2's floating matter (debris.ts): the gathering point's normal and tangents, s since it lifted, 0..1 */
    drift?: { up: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3; time: number; presence: number; clear: number };
  }): void;
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

// ------------------------------------------------------------------ the measured surface
/** relief exaggeration for the shading (the real relief is too low to read from orbit) */
const RELIEF = 2.5;
/** m: below this height the coasts get sub-pixel elevation detail once the sea starts rising */
const LOWLAND_M = 150;
/** deg/s the cloud field drifts east (a time-lapse wind) */
const CLOUD_DRIFT = 0.012;

export function createEarth(): Earth {
  const maps = loadEarthMaps();
  const u = {
    centre: uniform(new THREE.Vector3()),
    sun: uniform(new THREE.Vector3(0, 0, -1)),
    presence: uniform(0),
    sunPresence: uniform(0),
    pixelAngle: uniform(0.0015),
    cloudShift: uniform(0),
  };
  const gu = { north: uniform(new THREE.Vector3(0, 1, 0)), zero: uniform(new THREE.Vector3(1, 0, 0)), east: uniform(new THREE.Vector3(0, 0, -1)) };
  const G: GeoFrame = { north: gu.north as unknown as V3, zero: gu.zero as unknown as V3, east: gu.east as unknown as V3 };
  const lu = {
    fields: uniform(0), forests: uniform(0), ice: uniform(1), lights: uniform(0), overshoot: uniform(0), sea: uniform(0),
    waveOrigin: uniform(new THREE.Vector3(0, 0, 1)),
  };
  const L: LifeUniforms = {
    fields: lu.fields, forests: lu.forests, ice: lu.ice, lights: lu.lights, overshoot: lu.overshoot, sea: lu.sea,
    waveOrigin: lu.waveOrigin as unknown as V3,
  };
  const du = { clear: uniform(0), time: uniform(0), presence: uniform(0), up: uniform(new THREE.Vector3(0, 1, 0)), east: uniform(new THREE.Vector3(1, 0, 0)), north: uniform(new THREE.Vector3(0, 0, -1)) };
  const D: DriftUniforms = { time: du.time, presence: du.presence, up: du.up as unknown as V3, east: du.east as unknown as V3, north: du.north as unknown as V3 };
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
  /** the two maps' coordinates at unit normal n, `shift` deg east */
  const coords = (n: V3, shift: F | number = 0) => {
    const { lat, lon } = latLon(n, G);
    return { lat, ...mapCoords(lat, lon.sub(shift)) };
  };
  const elevation = (c: ReturnType<typeof coords>, fp: F): F => sampleBoth(maps.regionElevation, maps.globalElevation, c, fp, GLOBAL_ELEV_TEXEL).x as F;
  const lcwAt = (c: ReturnType<typeof coords>, fp: F): V4 => sampleBoth(maps.regionLcw, maps.globalLcw, c, fp);
  /** cloud cover 0..1 at unit normal n (on the cloud shell), the data's own plus sub-km texture at its edges */
  const cloudAt = (n: V3, fp: F): F => {
    const c = coords(n, u.cloudShift);
    const a = lcwAt(c, fp).y;
    // after the flood the weather clears over the new sea (within ~600 km of the gathering point, softly out
    // to ~1100 km): the spirals read from low down, the far clouds stay on the horizon
    const cover = a.mul(a).mul(float(1).sub(du.clear.mul(smoothstep(0.985, 0.996, n.dot(D.up)))));
    // the data is ~1 km and soft: below it, fbm erodes the edges and textures the decks, then the edges
    // are sharpened (cloud from orbit has crisp edges); thin haze keeps half its cover
    const detail = fbm(n.add(vec3(3, 7, 1)), 900, 7, 0.55, fp);
    const eroded = cover.add(detail.mul(sqrt(cover.mul(float(1).sub(cover))).mul(0.9)));
    return max(smoothstep(0.1, 0.65, eroded), cover.mul(0.5)) as F;
  };

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
    const c = coords(n);
    const real = sampleBoth(maps.regionAlbedo, maps.globalAlbedo, c, fp).rgb.toVar();
    const lcw = lcwAt(c, fp).toVar();
    const sea = seaLevel(L);
    // the measured elevation, with sub-pixel detail in the lowlands once the sea moves (a fractal flood line)
    const e0 = elevation(c, fp).toVar();
    const lowDetail = fbm(n.add(vec3(-4, 9, 2)), 3000, 6, 0.5, fp).mul(7).mul(smoothstep(LOWLAND_M, 20, e0)).mul(smoothstep(0, 0.03, L.sea));
    const e = e0.add(lowDetail).toVar();
    // relief: the elevation one footprint (at least ~1 km) along the Sun's azimuth and across it
    const eps = max(fp, 0.8 * KM).toVar();
    const metres = eps.mul(6371000);
    const g1 = elevation(coords(normalize(n.add(t1.mul(eps)))), fp).sub(e0).div(metres).toVar();
    const g2 = elevation(coords(normalize(n.add(t2.mul(eps)))), fp).sub(e0).div(metres).toVar();
    const slope = sqrt(g1.mul(g1).add(g2.mul(g2)));
    // land above the sea now: the colour's own coast, and the risen sea over the measured elevation
    const above = e.sub(sea);
    const width = max(float(1.5), slope.mul(metres).mul(0.5));
    const dry = smoothstep(width.negate(), width, above);
    const land = float(1).sub(lcw.z).mul(dry).toVar();
    const flooded = float(1).sub(lcw.z).mul(float(1).sub(dry));
    const N = normalize(n.sub(t1.mul(g1).add(t2.mul(g2)).mul(RELIEF).mul(land)));

    // land: the young world bare, life rolling over it in waves, the ice (lifeLayers.ts). Its bare rock is
    // the Sahara's (lat 18–30°, lon −12–29°: no Nile, no sea), mirrored over the planet so it has no seams
    const mirror = (x: F): F => float(1).sub(abs(fract(x.mul(0.5)).mul(2).sub(1))) as F;
    const { lat, lon } = latLon(n, G);
    const desert = mapCoords(mirror(lat.sub(18).div(12)).mul(12).add(18) as F, mirror(lon.add(12).div(41)).mul(41).sub(12) as F);
    const bare = sampleBoth(maps.regionAlbedo, maps.globalAlbedo, desert, fp).rgb;
    const landAlbedo = lifeAlbedo(n, real, bare, e, lat, L);
    // water: deep navy, teal over the shallow shelves; the new sea over drowned land is silty
    const depth = sea.sub(e).max(0).add(step(0, e).mul(lcw.z).mul(200));
    const open = mix(vec3(0.0035, 0.01, 0.026), vec3(0.012, 0.042, 0.048), exp(depth.div(-35)));
    const water = mix(open, vec3(0.014, 0.022, 0.02), flooded.mul(exp(depth.div(-60))).mul(0.85));
    // Drift-2: the floating matter, drawn into the eddies' spirals (only near the gathering point, once lifted)
    const matter = vec2(0).toVar();
    If(D.presence.greaterThan(0.001).and(n.dot(D.up).greaterThan(0.998)), () => {
      const m = driftMatter(n, D, fp, EARTH_R);
      matter.assign(vec2(m.cover, m.specks));
    });
    const afloat = matter.x.mul(float(1).sub(land));
    const albedo = mix(mix(water, vec3(0.15, 0.14, 0.11), afloat), landAlbedo, land);

    // sunlight at the terrain's height, under the clouds' shadows
    const sun = sunlight(float(EARTH_R).add(e.max(0).mul(1e-6 * RELIEF)), muS).toVar();
    const tanZ = sqrt(float(1).sub(muS.mul(muS)).max(0)).div(muS.max(0.08));
    const shadowAt = normalize(n.add(t1.mul(tanZ.mul(CLOUD_H / EARTH_R))));
    const overhead = cloudAt(n, max(fp, 2 * KM));
    const shade = float(1).sub(cloudAt(shadowAt, max(fp, 2 * KM)).mul(0.85));
    const diffuse = mix(muS, N.dot(S), land).max(0);
    // skylight: a little blue fill on the day side (none on the night side)
    const sky = vec3(0.3, 0.45, 0.8).mul(smoothstep(-0.12, 0.3, muS).mul(0.06));
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
    // floating matter kills the glint where it lies; its specks catch the Sun
    const glint = ggx.mul(fresnel).mul(smith(muS.max(1e-3))).mul(smith(muV)).div(muV.mul(4)).mul(float(1).sub(land)).mul(shade).mul(float(1).sub(afloat.mul(0.85)))
      .add(matter.y.mul(float(1).sub(land)).mul(muS.max(0)).mul(0.25));
    // the sky in the water: Fresnel at grazing angles
    const skyInWater = vec3(0.25, 0.4, 0.75).mul(pow(float(1).sub(muV), 5).mul(0.03).mul(smoothstep(-0.05, 0.3, muS))).mul(float(1).sub(land));
    // the lights of the night side, dimmed and spread by the cloud over them
    const night = float(1).sub(smoothstep(-0.12, 0.04, muS));
    const lights = nightLights(n, lcw.x, land, L, fp).mul(night).mul(float(1).sub(overhead.mul(0.75)));
    const out = lit.add(sun.mul(glint).add(skyInWater).mul(SUN_E)).add(lights);
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
  // no depth test: from a few hundred km up the depth buffer cannot resolve the shell's 7 km above the
  // ground at the limb, and the shader shades the nearest point along the pixel's own ray anyway (the
  // ground's hit, below), whichever of the sphere's faces runs it
  cloudMat.depthTest = false;
  cloudMat.colorNode = Fn(() => {
    const rc = EARTH_R + CLOUD_H;
    // the shell's own hit loses its precision with distance (from a planet's width away it lands on the
    // sunlit far side); the ground's hit is held to it, and the shell's only serves the rays grazing above
    // the limb, which miss the ground
    const shell = onSphere(rc);
    const ground = onSphere(EARTH_R);
    const g0 = sphereHit(cameraPosition, ground.d, C, EARTH_R);
    const hitsGround = g0.t1.greaterThan(g0.t0);
    const d = shell.d;
    const t = select(hitsGround, ground.t, shell.t) as F;
    const n = normalize(select(hitsGround, ground.n, shell.n)) as V3;
    const v = d.negate();
    const muV = n.dot(v).max(1e-3);
    const muS = n.dot(S);
    const fp = footprint(t, muV).toVar();
    const cover = cloudAt(n, fp).toVar();
    // the deck's own brightness (the VIIRS day's) carries its relief; thick cloud scatters light round into
    // its shaded side (wrap), forward scattering lights it against the Sun
    const wrap = muS.mul(0.65).add(0.35).max(0);
    const gm = 0.55;
    const fwd = float(1 - gm * gm).div(pow(float(1 + gm * gm).sub(d.dot(S).mul(2 * gm)), 1.5)).mul(0.08);
    const sky = vec3(0.3, 0.45, 0.8).mul(smoothstep(-0.12, 0.3, muS).mul(0.08));
    const T = towardEye(float(rc), muV, eyeR, eyeUp.dot(v));
    // thin cloud is darker as well as clearer; at night the towns below light its underside
    const thick = cover.mul(0.6).add(0.4);
    const below = coords(n);
    const glow = nightLights(n, lcwAt(below, fp.mul(12)).x, float(1), L, float(1)).mul(float(1).sub(smoothstep(-0.12, 0.04, muS))).mul(0.6);
    // the light falls off as the Sun gets low: the terminator a soft ramp, not a gold-edged line
    const low = smoothstep(-0.04, 0.25, muS).mul(0.85).add(0.15);
    const col = sunlight(float(rc), muS).mul(wrap.add(fwd)).mul(low).add(sky).mul((0.9 * SUN_E) / Math.PI).mul(thick).add(glow).mul(T);
    // while the planet is small the shell is left out: its shading is unreliable at those distances (and a
    // cloud deck a few pixels across is better carried by the disc's own colour)
    const big = smoothstep(40, 120, asin(float(EARTH_R).div(eyeR).min(1)).div(P));
    return vec4(col.mul(u.presence), cover.mul(0.96).mul(u.presence).mul(big));
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
    // (and more so from low down, where the view looks steeply through the densest air to the sea)
    const held = mix(float(0.6), float(0.32), float(1).sub(smoothstep(0.03, 0.12, eyeR.sub(EARTH_R))));
    return vec4(light.mul(mix(float(1), held, overGround)).mul(u.presence), alpha.mul(u.presence));
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
    ready: maps.ready,
    setGeo(g) {
      gu.north.value.copy(g.north);
      gu.zero.value.copy(g.zero);
      gu.east.value.copy(g.east);
    },
    update(o) {
      u.cloudShift.value = o.time * CLOUD_DRIFT;
      du.presence.value = o.drift?.presence ?? 0;
      du.clear.value = o.drift?.clear ?? 0;
      if (o.drift) {
        du.time.value = o.drift.time;
        du.up.value.copy(o.drift.up);
        du.east.value.copy(o.drift.east);
        du.north.value.copy(o.drift.north);
      }
      const l = o.life;
      lu.fields.value = l?.fields ?? 0;
      lu.forests.value = l?.forests ?? 0;
      lu.ice.value = l?.ice ?? 1;
      lu.lights.value = l?.lights ?? 0;
      lu.overshoot.value = l?.overshoot ?? 0;
      lu.sea.value = l?.sea ?? 0;
      if (l) lu.waveOrigin.value.copy(l.waveOrigin);
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
      maps.dispose();
    },
  };
}
