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
 * the horizon (atmosphere.ts `chapmanColumn`, held to numeric integration by tests/earthChapman.test.ts). It gives the
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
  atan,
  cameraPosition,
  cross,
  exp,
  float,
  fract,
  length,
  max,
  mix,
  mx_noise_float,
  normalize,
  positionWorld,
  pow,
  select,
  sin,
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
import { STAR_SIGMA } from './milkyWay';
import { ATMOS, EARTH_R, SUN_ANG, SUN_E, SUN_TINT, opticalDepth, scatter, sphereHit, starburst, sunBloom, sunDisc, sunlight, towardEye } from './atmosphere';
export { EARTH_R };
import type { LifeState } from './life';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** Mm, the cloud tops */
const CLOUD_H = 0.007;
const KM = 1 / 6371;
/** the night side's moonlit ambient, against the Sun's light */
const MOONLIGHT = 0.035;
/** the Sun's glint off the sea while the planet is small (see the glint, below): its point's peak at STAR_SIGMA
 * wide (a bright star's), its rays' light (atmosphere.ts starburst) and reach (rad: ~1.5°, a sparkle, not a
 * flare), the quad it is drawn on (rad across), and the planet's angular radius (rad) over which it goes */
const GLINT_PEAK = 8;
const GLINT_BURST = 0.0018;
const GLINT_RAYS = 0.026;
const GLINT_QUAD = 0.08;
/** rad/s each of its rays flickers at (the wind's ripples tilting the facets that mirror the Sun in and out),
 * none a multiple of another so the sparkle never repeats; and the point's own, slower */
const GLINT_TWINKLE = [6.1, 7.9, 9.4, 5.3, 8.7, 6.6, 10.2, 7.3];
const GLINT_PULSE = 4.7;
const GLINT_FADE: [number, number] = [(0.3 * Math.PI) / 180, (1.5 * Math.PI) / 180];

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
    time: uniform(0),
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
    // the new sea over what was land: by the measured elevation (continuous across the old coast — the
    // satellite water mask is binary and would draw the old coastline across the sea as a hard edge)
    const flooded = smoothstep(-30, 4, e).mul(float(1).sub(dry));
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
      matter.assign(vec2(m.turbid, m.slick));
    });
    // Drift-2: the debris mats (weathered wood and wrack: brighter than open water in diffuse light, dark only
    // in the glint, which they do not mirror) across the arms, bright scum and foam along their inner edges —
    // as floating debris fields read from the air, against the silty flood water
    const mats = vec3(0.25, 0.2, 0.14);
    const foam = vec3(0.6, 0.57, 0.52);
    const albedo = mix(mix(mix(water, mats, matter.x.mul(0.9)), foam, matter.y.mul(0.6)), landAlbedo, land);

    // sunlight at the terrain's height, under the clouds' shadows
    const sun = sunlight(float(EARTH_R).add(e.max(0).mul(1e-6 * RELIEF)), muS).toVar();
    const tanZ = sqrt(float(1).sub(muS.mul(muS)).max(0)).div(muS.max(0.08));
    const shadowAt = normalize(n.add(t1.mul(tanZ.mul(CLOUD_H / EARTH_R))));
    const overhead = cloudAt(n, max(fp, 2 * KM));
    const shade = float(1).sub(cloudAt(shadowAt, max(fp, 2 * KM)).mul(0.85));
    const diffuse = mix(muS, N.dot(S), land).max(0);
    // skylight: a little blue fill on the day side (none on the night side)
    const sky = vec3(0.3, 0.45, 0.8).mul(smoothstep(-0.12, 0.3, muS).mul(0.06));
    // the night side is not black: a faint moonlit ambient (the ISS night photographs show the ground and
    // the clouds dimly, cool grey)
    const night = float(1).sub(smoothstep(-0.2, 0.03, muS));
    const moon = vec3(0.5, 0.55, 0.7).mul(MOONLIGHT).mul(night);
    const lit = albedo.mul(sun.mul(diffuse).mul(shade).add(sky).add(moon)).mul(SUN_E / Math.PI);
    // glint: GGX on the open water, its roughness by wind patches; Fresnel and the long grazing paths make
    // it swell and redden toward the terminator
    const h = normalize(S.add(v));
    // (along the eddy's slicks the floating matter calms the ripples: a smoother, brighter glint)
    const a = mix(float(0.07), float(0.22), smoothstep(-0.35, 0.35, fbm(n.add(vec3(1, 4, 2)), 14, 4, 0.5, fp))).mul(float(1).sub(matter.y.mul(0.75)));
    const a2 = a.mul(a);
    const nh = n.dot(h).max(0);
    const ggx = a2.div(PI.mul(pow(nh.mul(nh).mul(a2.sub(1)).add(1), 2)));
    const fresnel = pow(float(1).sub(v.dot(h).max(0)), 5).mul(0.98).add(0.02);
    const smith = (m: F): F => m.mul(2).div(m.add(sqrt(a2.add(float(1).sub(a2).mul(m.mul(m))))));
    // floating matter kills the glint where it lies; its specks catch the Sun
    const glint = ggx.mul(fresnel).mul(smith(muS.max(1e-3))).mul(smith(muV)).div(muV.mul(4)).mul(float(1).sub(land)).mul(shade).mul(float(1).sub(matter.x.mul(0.85)));
    // the sky in the water: Fresnel at grazing angles
    const skyInWater = vec3(0.25, 0.4, 0.75).mul(pow(float(1).sub(muV), 5).mul(0.03).mul(smoothstep(-0.05, 0.3, muS))).mul(float(1).sub(land));
    // the lights of the night side, dimmed and spread by the cloud over them
    // the lights come up behind the terminator as the dusk deepens (a gradient that follows it, not a switch)
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
    // (the clouds a little dimmer than the ground's moonlight would make them: they read as cut-outs otherwise)
    const moon = vec3(0.5, 0.55, 0.7).mul(MOONLIGHT * 0.25).mul(float(1).sub(smoothstep(-0.2, 0.03, muS)));
    const col = sunlight(float(rc), muS).mul(wrap.add(fwd)).mul(low).add(sky).add(moon).mul((0.9 * SUN_E) / Math.PI).mul(thick).add(glow).mul(T);
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
    const { light, T, hitGround } = scatter(cameraPosition, normalize(positionWorld.sub(cameraPosition)), C, S);
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
  const QUAD = 1.6; // rad across: room for the glare to fall to nothing before the quad's edge
  sunMat.positionNode = eyeFacing(sunPos, float(sunDistance * QUAD));
  /** what of the Sun's light reaches the eye along d: none through the planet, reddened through its air */
  const pastEarth = (d: V3): V3 => {
    const g = sphereHit(cameraPosition, d, C, EARTH_R);
    const blocked = g.t1.greaterThan(g.t0).and(g.t1.greaterThan(0));
    return exp(opticalDepth(eyeR, eyeUp.dot(d)).negate()).mul(select(blocked, float(0), float(1)));
  };
  sunMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    // the quad's plane, rad from the Sun's centre along it, and the true angle (atan: the quad is wide)
    const o = q.mul(QUAD / 2);
    const r = atan(o.length());
    const disc = sunDisc(r);
    // the glare is the eye's (or lens's) response to the whole disc: it goes as the disc sets behind the limb.
    // A veil with no edge and the optics' rays (atmosphere.ts sunBloom): an exponential glare read as a lens
    // flare, the Sun in space "underwhelming" (the user, 2026-10-29)
    const aboveLimb = acos(eyeUp.dot(S).negate().clamp(-1, 1)).sub(asin(float(EARTH_R).div(eyeR)));
    const seen = pastEarth(S).mul(smoothstep(-SUN_ANG, SUN_ANG, aboveLimb));
    const fade = float(1).sub(smoothstep(0.6, 1, q.length()));
    const light = pastEarth(normalize(positionWorld.sub(cameraPosition))).mul(disc).add(seen.mul(sunBloom(o, r, P)));
    return vec4(SUN_TINT.mul(light).mul(fade).mul(u.sunPresence), 1);
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

  // ------------------------------------------------------------------ the glint
  // THE PLANET FIRST SHOWS AS ONE MORE STAR: a blue point low on the right among thousands, mostly its night
  // side, the eye never finds it. What finds it is the Sun's image in its sea: from far off a planet's ocean
  // mirrors the Sun from the one point whose normal halves the way to the Sun and to the eye — on the sunlit
  // side, toward the limb — and seen from afar that glint is a point as bright as the whole sunlit crescent
  // around it. As a SPARKLE (the user, 2026-10-29: a round glow read "round and weird"): a pinpoint, the optics'
  // short rays out of it (atmosphere.ts starburst, as the Sun's own), each flickering on its own as the ripples
  // tilt the mirroring facets — no veil (any halo of its own read as a disc; the dome's bloom gives it what glow
  // it has). It comes up with the planet's Sun (the
  // hand-over from the Milky Way's Sun star) and goes as the disc grows past GLINT_FADE: by then the surface
  // shades its own glint, and the planet needs no help to be seen. (Not masked by land and cloud: from where the
  // eye first sees it the point falls near the Bering Strait, and the flare is the crescent's, held for the eye.)
  const glintN = normalize(S.add(normalize(cameraPosition.sub(C))));
  const glintAt = C.add(glintN.mul(EARTH_R));
  const glintDist = glintAt.sub(cameraPosition).length();
  const glintMu = glintN.dot(S);
  const glintGain = float(1)
    .sub(smoothstep(GLINT_FADE[0], GLINT_FADE[1], asin(float(EARTH_R).div(dist).min(1))))
    .mul(u.presence)
    .mul(u.sunPresence);
  // a pinpoint: 0.64 px wide on any master, its light that of a STAR_SIGMA-wide star of peak GLINT_PEAK
  const glintSigma = P.mul(0.64);
  const glintMat = new THREE.NodeMaterial();
  glintMat.transparent = true;
  glintMat.depthWrite = false;
  glintMat.depthTest = false;
  glintMat.side = THREE.DoubleSide;
  glintMat.blending = THREE.AdditiveBlending;
  glintMat.positionNode = eyeFacing(glintAt, glintDist.mul(GLINT_QUAD).mul(step(0.0005, glintGain)));
  glintMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const o = q.mul(GLINT_QUAD / 2); // rad from the glint, in the quad's plane
    const r = o.length();
    const pulse = sin(u.time.mul(GLINT_PULSE)).mul(0.12).add(0.88);
    const core = exp(r.div(glintSigma).pow(2).negate()).mul(float(STAR_SIGMA).div(glintSigma).pow(2)).mul(GLINT_PEAK).mul(pulse);
    const flicker = (ray: number): F => sin(u.time.mul(GLINT_TWINKLE[ray]).add(ray * 2.4)).mul(0.225).add(0.775);
    const rays = starburst(o, P, float(GLINT_RAYS), flicker).mul(GLINT_BURST);
    const fade = float(1).sub(smoothstep(0.6, 1, q.length()));
    // the sunlight down to the sea there and back up to the eye: warm, as the grazing paths through the air redden it
    const light = sunlight(float(EARTH_R), glintMu).mul(towardEye(float(EARTH_R), glintMu, eyeR, eyeUp.dot(normalize(cameraPosition.sub(glintAt)))));
    return vec4(SUN_TINT.mul(light).mul(rays.add(core)).mul(fade).mul(glintGain), 1);
  })();
  glintMat.name = 'drift-earth-glint';
  const glint = billboardMesh(glintMat, 1, 'drift-earth-glint');
  glint.renderOrder = 3;

  const group = new THREE.Group();
  group.name = 'drift-earth';
  group.add(surface, clouds, atmosphere, sun, point, glint);
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
      u.time.value = o.time;
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
      for (const m of [surface, clouds, atmosphere, sun, point, glint]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      maps.dispose();
    },
  };
}
