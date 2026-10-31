/**
 * Earth at dawn, seen from high above (direction G5) — the measured planet, in its own frame: 1 unit = 1000 km,
 * the planet's centre placed so the final eye sits at the frame's origin. Everything is lit by one Sun, fixed
 * in the dome (where the Milky Way arrival left it), so the scene never needs a camera turn: we come over
 * the planet by translation, and the dawn is the limb lifting toward a Sun that stays put.
 *
 *   SURFACE     the satellites' Earth (earthMaps.ts): Blue Marble colour (Sentinel-2's under the closest views),
 *               the measured elevation for the relief shading (exaggerated from orbit) and for the flood, open
 *               water deep navy with teal shelves and a
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
  cos,
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
import { ELEV_TEXEL_KM, GLOBAL_ELEV_TEXEL, insetWater, latLon, loadEarthMaps, mapCoords, sampleBoth, sampleLevels, type GeoFrame } from './earthMaps';
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
/**
 * THE MOONLIGHT THROUGH THE AIR, grey: the moonlit ambient (MOONLIGHT) takes the air's transmittance toward the eye as
 * one grey factor, not the chromatic one the sunlight takes, and lights the ground's luminance, not its colour.
 * Chromatic, the night side's moonlit desert near the limb — the Sahara's orange, seen through ~1000 km of grazing air
 * that leaves its red and none of its blue — came out a dark brown crescent beyond the bright day-side limb (the
 * 2026-10-30 seat review at ~185 s: "a dark brown crescent sits beyond the bright limb on the right"; 13–22° past the
 * terminator, sRGB ~(27, 11, 1) in the master; with the grey transmittance alone still a warm (24, 17, 12)). Real
 * moonlit air along that path also scatters the moonlight back toward the eye, bluish, which the shell (sunlight only)
 * does not draw: the loss and the gain together leave it about grey; and a moonlit land is seen by night vision,
 * without its colour. So it is a dim cool ground, as the rest of the night side.
 */
const moonGrey = (T: THREE.Node<'vec3'>): THREE.Node<'vec3'> => vec3(T.dot(vec3(0.2126, 0.7152, 0.0722)));
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
    drift?: { up: THREE.Vector3; east: THREE.Vector3; north: THREE.Vector3; time: number; presence: number; clear: number; eye?: [number, number, number] };
  }): void;
  dispose(): void;
}

const LACUNARITY = 2.03;

/** an octave of frequency f fades out as its wavelength shrinks from 4 to 2 footprints (fp, unit sphere) */
const lod = (f: F, fp: F): F => float(1).sub(smoothstep(0.25, 0.5, f.mul(fp)));

/** fbm of gradient noise, its octaves finer than the footprint faded out (and not evaluated) */
function fbm(p: V3, f0: number | F, octaves: number, gain: number, fp: F): F {
  const sum = float(0).toVar();
  const f = (typeof f0 === 'number' ? float(f0) : float(f0)).toVar();
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
/** relief exaggeration for the shading (the real relief is too low to read from orbit) — over a baseline of RELIEF_KM[1]
 * and more; the real relief (1) from RELIEF_KM[0] down, where the near level's and the inset's finer elevation make
 * the slopes steep enough to read as they are (2.5x the inset's 60 m slopes in the Alps tipped the normals past
 * 70°: the ground shaded black and white) */
const RELIEF = 2.5;
const RELIEF_KM: [number, number] = [0.1, 0.8];
/** the relief's baseline is never under this share of the finest elevation texel there: a bilinear lookup's slope is
 * constant across a texel, so a shorter baseline draws the texel grid (the region's 1.1 km texels had a 0.8 km floor) */
const RELIEF_TEXELS = 0.72;
/** m: below this height the coasts get sub-pixel elevation detail once the sea starts rising */
const LOWLAND_M = 150;
/** the sub-pixel detail's first octave (unit-sphere frequency: 3000 is ~2.1 km) and height (m): over the region's
 * and the near level's elevation, and over the inset's (~160 m, two of its texels: its own EU-DEM lowlands are
 * measured to a metre or two, and 7 m of noise in a plain that falls 1 m a km moved its flood line by kilometres) */
const LOWLAND_DETAIL: [number, number] = [3000, 7];
const LOWLAND_DETAIL_INSET: [number, number] = [40000, 1];
/** Mm above the sea: the descent's last few km come in over this (its waves, the sky in its water, the full haze at the
 * horizon: `low` in createEarth) — from the top of the range to all of it at the bottom */
const LOW_FROM: [number, number] = [0.005, 0.03];
/** the descent's ripple trains (createEarth `ripples`): wavelength m, rad off the sea's wind (wandering/sea.ts WIND_TO,
 * toward −z), phase rad — a light breeze's sea, from the chop's 1 m to its longest 14 m crests */
const RIPPLES: ReadonlyArray<readonly [number, number, number]> = [
  [14, 0.15, 0.3],
  [9.3, -0.35, 2.1],
  [6.1, 0.5, 4.4],
  [4.2, -0.6, 1.2],
  [2.8, 0.9, 5.3],
  [1.9, -1.0, 3.6],
  [1.2, 0.3, 0.8],
];
/** each train's slope amplitude: seven at 0.06 give an RMS slope of ~0.11, about Cox–Munk's for a 3–4 m/s breeze */
const RIPPLE_SLOPE = 0.06;
/** deg: the near cap's angular radius (the horizon is 5.6° off from 30 km up), and Mm: the height it is drawn below */
const CAP_DEG = 6;
const CAP_BELOW = 0.03;
const Y_UP = new THREE.Vector3(0, 1, 0);
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
  const du = {
    clear: uniform(0), time: uniform(0), presence: uniform(0), up: uniform(new THREE.Vector3(0, 1, 0)), east: uniform(new THREE.Vector3(1, 0, 0)), north: uniform(new THREE.Vector3(0, 0, -1)),
    /** the eye in the debris galaxy's frame (m: x east, y above the sea, z north of its centre: the sea's scene's) */
    eye: uniform(new THREE.Vector3(0, 1e7, 0)),
  };
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
  /** 0..1: how far down the eye is into the descent's last few km (the waves and the sea's sky in the water, below) */
  const low = float(1).sub(smoothstep(LOW_FROM[0], LOW_FROM[1], eyeR.sub(EARTH_R)));
  /**
   * THE DESCENT'S WAVES (the 2026-10-30 review of the final render: the water "goes from perfectly flat to wavy" at the
   * hand-over to the sea's scene): a light breeze's ripples on the water under the eye, as the sea's scene's own sea
   * (wandering/sea.ts RIPPLE: 4 m/s toward −z, the debris galaxy's frame) — a few long-crested trains, 1–14 m, each
   * drawn only where it is wider than a few pixels (`fpm`, the pixel's footprint, m) and its slopes otherwise folded
   * into the glint's roughness (`rough2`, added to GGX's α²), so the sea's texture comes up out of the glint as the eye
   * comes down. Laid on the flat sea under the eye (the curve's drop is far below a ripple where they show), in metres
   * from the eye's own place in the field (`du.eye`): f32 Mm world positions are 0.5 m apart this close in. Returns the
   * rippled normal (world).
   */
  const ripples = (d: V3, n: V3, fpm: F, calm: F): { N: V3; rough2: F } => {
    const dUp = d.dot(D.up);
    const reach = du.eye.y.div(dUp.negate().max(1e-4));
    const x = du.eye.x.add(d.dot(D.east).mul(reach));
    const z = du.eye.z.add(d.dot(D.north).mul(reach));
    let gx: F = float(0);
    let gz: F = float(0);
    let lost: F = float(0);
    for (const [len, dir, phase] of RIPPLES) {
      const k = (2 * Math.PI) / len;
      const w = Math.sqrt(9.81 * k);
      const [cx, cz] = [Math.sin(dir), -Math.cos(dir)];
      const seen = float(1).sub(smoothstep(len / 3, len / 1.5, fpm));
      const slope = cos(x.mul(cx * k).add(z.mul(cz * k)).sub(u.time.mul(w)).add(phase)).mul(RIPPLE_SLOPE).mul(seen);
      gx = gx.add(slope.mul(cx)) as F;
      gz = gz.add(slope.mul(cz)) as F;
      lost = lost.add(float(1).sub(seen).mul((RIPPLE_SLOPE * RIPPLE_SLOPE) / 2)) as F;
    }
    const keep = float(1).sub(calm);
    return { N: normalize(n.sub(D.east.mul(gx.mul(keep))).sub(D.north.mul(gz.mul(keep)))), rough2: lost.mul(keep.mul(keep)).mul(2) as F };
  };
  /** the two maps' coordinates at unit normal n, `shift` deg east */
  const coords = (n: V3, shift: F | number = 0) => {
    const { lat, lon } = latLon(n, G);
    return { lat, ...mapCoords(lat, lon.sub(shift)) };
  };
  const elevation = (c: ReturnType<typeof coords>, fp: F): F =>
    sampleLevels({ global: maps.globalElevation, region: maps.regionElevation, near: maps.nearElevation, inset: maps.insetElevation, globalTexel: GLOBAL_ELEV_TEXEL }, c, fp).x as F;
  /** the clouds' map (G), and the lights (R) under them: the region over the global maps */
  const lcwAt = (c: ReturnType<typeof coords>, fp: F): V4 => sampleBoth(maps.regionLcw, maps.globalLcw, c, fp);
  /** the surface's lights (R) and water (B), down to the near level's 15″ and the inset's own water line */
  const lcwSurface = (c: ReturnType<typeof coords>, fp: F): V4 => {
    const v = sampleLevels({ global: maps.globalLcw, region: maps.regionLcw, near: maps.nearLcw }, c, fp);
    return vec4(v.x, v.y, insetWater(maps, c, fp, v.z as F), v.w);
  };
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
    const real = sampleLevels({ global: maps.globalAlbedo, region: maps.regionAlbedo, near: maps.nearAlbedo, inset: maps.insetAlbedo }, c, fp).rgb.toVar();
    const lcw = lcwSurface(c, fp).toVar();
    const sea = seaLevel(L);
    // the measured elevation, with sub-pixel detail in the lowlands once the sea moves (a fractal flood line)
    const e0 = elevation(c, fp).toVar();
    const lowDetail = fbm(n.add(vec3(-4, 9, 2)), mix(float(LOWLAND_DETAIL[0]), float(LOWLAND_DETAIL_INSET[0]), c.wi), 6, 0.5, fp)
      .mul(mix(float(LOWLAND_DETAIL[1]), float(LOWLAND_DETAIL_INSET[1]), c.wi))
      .mul(smoothstep(LOWLAND_M, 20, e0))
      .mul(smoothstep(0, 0.03, L.sea));
    const e = e0.add(lowDetail).toVar();
    // relief: the elevation one footprint along the Sun's azimuth and across it, at least RELIEF_TEXELS of the finest
    // elevation texel there (0.8 km over the region, as before the near level and the inset came)
    const finest = mix(mix(float(0.8), float(RELIEF_TEXELS * ELEV_TEXEL_KM.near), c.wn), float(RELIEF_TEXELS * ELEV_TEXEL_KM.inset), c.wi);
    const eps = max(fp, finest.mul(KM)).toVar();
    const relief = mix(float(1), float(RELIEF), smoothstep(RELIEF_KM[0] * KM, RELIEF_KM[1] * KM, eps));
    const metres = eps.mul(6371000);
    // (the land's slopes only: the sea floor is held at the sea's surface. Over the inset's ~57 m baseline the step
    // from a coastal field down to the shelf's −25 m read as a 25° slope — a lit or shaded rim along every coast)
    const g1 = elevation(coords(normalize(n.add(t1.mul(eps)))), fp).max(0).sub(e0.max(0)).div(metres).toVar();
    const g2 = elevation(coords(normalize(n.add(t2.mul(eps)))), fp).max(0).sub(e0.max(0)).div(metres).toVar();
    const slope = sqrt(g1.mul(g1).add(g2.mul(g2)));
    // land above the sea now: the colour's own coast, and the risen sea over the measured elevation
    const above = e.sub(sea);
    const width = max(float(1.5), slope.mul(metres).mul(0.5));
    const dry = smoothstep(width.negate(), width, above);
    const land = float(1).sub(lcw.z).mul(dry).toVar();
    // the new sea over what was land: by the measured elevation (continuous across the old coast — the
    // satellite water mask is binary and would draw the old coastline across the sea as a hard edge)
    const flooded = smoothstep(-30, 4, e).mul(float(1).sub(dry));
    const N = normalize(n.sub(t1.mul(g1).add(t2.mul(g2)).mul(relief).mul(land)));

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
    const lit = albedo.mul(sun.mul(diffuse).mul(shade).add(sky)).mul(SUN_E / Math.PI);
    // (moonlit, colour goes: the eye's night vision sees the albedo's luminance, not its hue — MOONLIGHT's own cool
    // tint is the night's colour; moonGrey)
    const moonLit = moon.mul(albedo.dot(vec3(0.2126, 0.7152, 0.0722))).mul(SUN_E / Math.PI);
    // glint: GGX on the open water, its roughness by wind patches; Fresnel and the long grazing paths make
    // it swell and redden toward the terminator
    const h = normalize(S.add(v));
    // (along the eddy's slicks the floating matter calms the ripples: a smoother, brighter glint)
    const a = mix(float(0.07), float(0.22), smoothstep(-0.35, 0.35, fbm(n.add(vec3(1, 4, 2)), 14, 4, 0.5, fp))).mul(float(1).sub(matter.y.mul(0.75)));
    // (low down, the ripples: their normal for the glint and the sky in the water, the rest of their slopes in its α²)
    const near = low.mul(float(1).sub(land)).toVar();
    const rip = ripples(d, n, fp.mul(EARTH_R * 1e6), matter.y.mul(0.75));
    const Nw = normalize(mix(n, rip.N, near)).toVar();
    const a2 = a.mul(a).add(rip.rough2.mul(near));
    const nh = Nw.dot(h).max(0);
    const ggx = a2.div(PI.mul(pow(nh.mul(nh).mul(a2.sub(1)).add(1), 2)));
    const fresnel = pow(float(1).sub(v.dot(h).max(0)), 5).mul(0.98).add(0.02);
    const smith = (m: F): F => m.mul(2).div(m.add(sqrt(a2.add(float(1).sub(a2).mul(m.mul(m))))));
    // floating matter kills the glint where it lies; its specks catch the Sun
    const glint = ggx.mul(fresnel).mul(smith(muS.max(1e-3))).mul(smith(muV)).div(muV.mul(4)).mul(float(1).sub(land)).mul(shade).mul(float(1).sub(matter.x.mul(0.85)));
    // the sky in the water: Fresnel at grazing angles
    const skyInWater = vec3(0.25, 0.4, 0.75).mul(pow(float(1).sub(muV), 5).mul(0.03).mul(smoothstep(-0.05, 0.3, muS))).mul(float(1).sub(land)).mul(float(1).sub(near));
    // ... and low down, the sky itself in the water (the sea's scene's far sea, seaSky.ts farSea): Fresnel's share of
    // the air's light along the ray the rippled water mirrors, held just over the horizon. Near grazing it is nearly
    // all of it — what makes the far sea meet the sky at the horizon; without it the water there drew only the dim
    // glint fill and a held haze, darker than the sky over it (with the near cap below, the other half of the dark
    // line along the horizon in the 2026-10-30 seat review, ~305–315 s)
    const mirrored = vec3(0).toVar();
    If(near.greaterThan(1e-3), () => {
      const r = d.sub(Nw.mul(d.dot(Nw).mul(2)));
      const rr = normalize(r.add(eyeUp.mul(float(0.003).sub(r.dot(eyeUp)).max(0))));
      const fresnelW = pow(float(1).sub(Nw.dot(v).max(1e-3)), 5).mul(0.98).add(0.02);
      mirrored.assign(scatter(cameraPosition, rr, C, S).light.mul(fresnelW).mul(near).mul(float(1).sub(matter.x.mul(0.85))));
    });
    // the lights of the night side, dimmed and spread by the cloud over them
    // the lights come up behind the terminator as the dusk deepens (a gradient that follows it, not a switch)
    const lights = nightLights(n, lcw.x, land, L, fp).mul(night).mul(float(1).sub(overhead.mul(0.75)));
    const out = lit.add(sun.mul(glint).add(skyInWater).mul(SUN_E)).add(lights).add(mirrored);
    const T = towardEye(float(EARTH_R), muV, eyeR, eyeUp.dot(v));
    // the moonlight through the air: grey (moonGrey)
    return vec4(out.mul(T).add(moonLit.mul(moonGrey(T))).mul(u.presence), 1);
  })();
  surfMat.name = 'drift-earth-surface';
  const surface = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 256, 128), surfMat);
  surface.frustumCulled = false;
  surface.name = 'drift-earth-surface';
  // THE NEAR CAP: the same surface on a finely cut cap of the sphere under the eye, low down. The sphere's 256 × 128
  // faces are chords up to ~1 km inside the true sphere, so from a few hundred metres up the mesh's own horizon lay
  // well under the true one, and the rays between them met no surface at all — only the air's held haze over the
  // void: the dark line along the whole horizon in the descent (the 2026-10-30 seat review, ~305–315 s: "a thick
  // black line across the whole horizon … breaks the immersion"; 6 px, 0.37°, at 312 s in 16:9, the chord sag's
  // dip). Here a face is 0.016° deep and 0.06° across at the rim: its chords sag ≤ ~1 m, under a pixel of the dip
  // from 150 m. Its rim at CAP_DEG is past the horizon from the 30 km it is drawn below.
  const cap = new THREE.Mesh(new THREE.SphereGeometry(EARTH_R, 384, 384, 0, 2 * Math.PI, 0, (CAP_DEG * Math.PI) / 180), surfMat);
  cap.frustumCulled = false;
  cap.name = 'drift-earth-near-cap';
  const capUp = new THREE.Vector3();

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
    const col = sunlight(float(rc), muS).mul(wrap.add(fwd)).mul(low).add(sky).mul((0.9 * SUN_E) / Math.PI).mul(thick).add(glow).mul(T)
      .add(moon.mul((0.9 * SUN_E) / Math.PI).mul(thick).mul(moonGrey(T)));
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
    const heldSteep = mix(float(0.6), float(0.32), float(1).sub(smoothstep(0.03, 0.12, eyeR.sub(EARTH_R))));
    // (but not toward the horizon in the descent's last few km: the far sea's air is the horizon's own haze, which the
    // sky just over it shows whole — held there, it drew a dark band along the horizon, the 2026-10-30 seat review.
    // The cosine at the ray's ground point by the sine rule: 1 − (r/R)²·sin²θ)
    const mu = eyeUp.dot(normalize(positionWorld.sub(cameraPosition)));
    const muHit = sqrt(float(1).sub(eyeR.div(EARTH_R).pow(2).mul(float(1).sub(mu.mul(mu)))).max(0));
    const held = mix(heldSteep, float(1), low.mul(float(1).sub(smoothstep(0, 0.2, muHit))));
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
  group.add(surface, cap, clouds, atmosphere, sun, point, glint);
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
        if (o.drift.eye) du.eye.value.set(...o.drift.eye);
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
      capUp.subVectors(o.eye, o.centre);
      cap.visible = capUp.length() - EARTH_R < CAP_BELOW;
      cap.position.copy(o.centre);
      cap.quaternion.setFromUnitVectors(Y_UP, capUp.normalize());
      clouds.position.copy(o.centre);
      atmosphere.position.copy(o.centre);
    },
    dispose() {
      cap.geometry.dispose();
      for (const m of [surface, clouds, atmosphere, sun, point, glint]) {
        m.geometry.dispose();
        (m.material as THREE.Material).dispose();
      }
      maps.dispose();
    },
  };
}
