/**
 * THE DESCENT'S SEA: the water under the eye from ~30 km down to the hand-over into the sea's scene (act.ts
 * SEA_FROM_ALT, 150 m), drawn on the planet's surface (earth.ts) as a slope field for its glint, its Fresnel and the
 * sky in its water.
 *
 * WHY THIS REPLACED THE SEVEN RIPPLE TRAINS (the 2026-11-02 review: "when we come flying down to the debris spiral
 * … the wave pattern is perfectly regular and tiled, and that's causing more ray effects, and it looks a bit shitty
 * and cheap"). The descent's waves were seven long-crested cosines, 1.2–14 m, each faded out by the pixel's
 * footprint (earth.ts `footprint`). Two faults, seen in the 665ba98 seat render at 306–315 s as a grey sizzle with
 * a grid in it and moiré rings round the nadir:
 *   - THE BAND LIMIT WAS PAST NYQUIST: a train was whole while it spanned 3 footprints and gone only at 1.5 — under
 *     the 2 px a wave needs to be sampled at all, and the glint's GGX lobe, sharply non-linear in the slope, makes
 *     harmonics of whatever it is given, so a wave needs ~10 px before its glint stops beating against the pixels.
 *   - THE FOOTPRINT WAS THE GEOMETRIC MEAN: t·P/√μV. On the water a pixel is an ellipse 1/μV longer along the view
 *     than across it, so at the grazing views of the descent (μV 0.02–0.2 toward the horizon) a train whose crests
 *     ran across the view was under-filtered by 1/√μV, 2–7× — and all of them were drawn at a quarter of a pixel a
 *     wave there. The seven, few and long-crested, then beat against each other and the pixel grid: the rings.
 *   - THE PATTERN WAS REGULAR even where resolved: seven plane waves at fixed directions are a quasi-periodic comb,
 *     nothing like the sea's FFT surface the hand-over cuts to.
 *
 * WHAT IS HERE NOW. The sea's own spectrum (src/ocean/oceanMath.ts `waveSpectrum`: the Phillips wind sea with its
 * wavenumber-dependent spread and the swell train) at the sea's scene's own sea state (SEA_STATE: wandering/sea.ts's
 * RIPPLE, swell and wind, over the game's glass preset), sampled as a multi-octave field of plane waves: half-octave
 * bands from 250 m down to 0.35 m, two waves in each (four over 4 m, the ones the eye resolves from a few hundred
 * metres up) at random wavelengths within the band and at directions drawn from that band's own directional spread
 * (so the long waves keep to the wind and the short chop fans out ~40°, as the sea's spread does: oceanMath
 * `windSeaSpread`), no two within 3° of one heading, with random phases and deep-water dispersion (ω² = g·k, the
 * FFT's), their crests bent by a slow warp of the water (WARP) so none runs straight for long — 34 waves from 19 m to
 * 0.36 m once the swell's and the spectral gap's, too gentle to show under the glint, are left out: no comb, nothing
 * that tiles. Each wave carries its band's
 * share of the spectrum's slope variance, so the field has the sea's mean square slope band for band (σ² 0.020, the
 * cascades' own to a few %: tests/getTheDriftDescentSea.test.ts); the slope variance under the shortest drawn wave
 * (0.35 m to the capillaries) is the roughness under everything.
 *
 * BAND-LIMITED BY THE PIXEL'S FOOTPRINT, PER WAVE AND ANISOTROPICALLY: each wave's phase step across one pixel is
 * taken along the footprint's long axis (t·P/μV, along the view) and its short one (t·P, across), for the wave's own
 * direction, and the wave is whole while it spans 10 pixels or more and gone by 4 (DESCENT_BAND: the shoreline's
 * OCT_BAND, wandering/shoreline.ts, measured on the same kind of fault under a dusk sky). What the pixel cannot hold
 * goes into the glint's roughness instead (§V.48b, src/ocean/surfaceFiltering.ts: the variance a fade removes is
 * handed to the specular lobe), so the sea's texture comes up out of the glitter as the eye comes down, and from a
 * few km up the sea is what it is from a plane: sun-glitter, and its patches.
 *
 * THE PATCHES (`roughMod`): real water from a few km up shows no crests but the wind's own structure in the glitter
 * — cat's paws, gusts roughening the chop over a few hundred metres, and slicks, long calm streaks along the wind
 * (Langmuir rows) where the short waves die. Both act on the short chop only (under ~2 m, CHOP_FROM: the waves the
 * wind of the moment makes and a film damps), from noise in metres stretched along the wind, each octave faded to
 * its mean as the footprint passes it. They ease out as the eye comes down to the hand-over (PATCH_ALT), where the
 * sea's scene, which has none, takes over.
 *
 * Every frame is a pure function of t: the waves' phases run on the act's clock; nothing carries over.
 */
import { If, float, mix, mx_noise_float, normalize, select, smoothstep, sqrt, vec3 } from 'three/tsl';
import type * as THREE from 'three/webgpu';
import { GRAVITY, waveSpectrum } from '../../ocean/oceanMath';
import { oceanParams, type OceanParams } from '../../params/ocean';
import { weatherPresets } from '../../weather/presets';
import { createRng } from '../../state/rng';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/**
 * THE SEA'S SCENE'S SEA STATE, restated (wandering/sea.ts RIPPLE, SWELL_RMS, SWELL_PERIOD, WIND_TO: a light
 * breeze's ripples, 4 m/s, over a 10 s ground swell, over the game's glass preset). Restated rather than imported:
 * sea.ts is the whole sea scene, and the descent's planet would pull all of it in for four numbers.
 * tests/getTheDriftDescentSea.test.ts holds the two to the same numbers: if they part, the hand-over shows a seam.
 */
export const SEA_STATE = {
  ripple: { amplitude: 0.28, windSpeed: 4, choppiness: 0.8 },
  /** m RMS */
  swellRms: 0.13,
  /** s */
  swellPeriod: 10,
  /** rad, the wind's heading (oceanParams.windDirection: the sea's wind sea runs along (cos, sin) of it in x, z) */
  windTo: Math.PI,
} as const;

/** the ocean params the sea's scene builds its spectrum from (sea.ts: Object.assign(oceanParams, glass, RIPPLE, …)) */
export function seaSpectrumParams(): OceanParams {
  return {
    ...oceanParams,
    ...weatherPresets.glass.ocean,
    ...SEA_STATE.ripple,
    swellAmplitude: SEA_STATE.swellRms,
    swellPeriod: SEA_STATE.swellPeriod,
    windDirection: SEA_STATE.windTo,
  } as OceanParams;
}

/** m: the longest and shortest waves drawn (the swell's 156 m within the first band; under the last, roughness) */
export const DRAWN_LAMBDA: [number, number] = [250, 0.35];
/** bands per octave, and waves per band */
const BANDS_PER_OCTAVE = 2;
const PER_BAND = 2;
/** m: bands of waves longer than this get PER_BAND_LONG instead — the waves the eye resolves from a few hundred
 * metres up, where two a band read as a lattice (a crosshatch of the 13–19 m waves at 312 s, 280 m up: the first
 * render of this field) */
const LONG_FROM = 4;
const PER_BAND_LONG = 4;
/** the least slope amplitude a wave is drawn with */
const MIN_SLOPE = 0.008;
/** rad: the least angle between two waves' headings */
const MIN_APART = (3 * Math.PI) / 180;
/** cycles per pixel: a wave is whole up to the first (10 px a wavelength), gone from the second (4 px) */
export const DESCENT_BAND: [number, number] = [0.1, 0.25];
/** m: the chop the gusts and slicks act on — whole under the first wavelength, none over the second */
const CHOP_FROM: [number, number] = [1.2, 3];
/** m: the eye's height the patches ease out over, down to the hand-over (act.ts SEA_FROM_ALT, 150 m) */
const PATCH_ALT: [number, number] = [250, 1200];
/** the gusts' and the slicks' scales (m, along the wind × across it) and strengths: the gusts' octaves (with their
 * weights) ±45% each on the chop's slope variance, the slicks taking up to 80% of it off, in rows ~120 m apart */
const GUST_SCALE: [number, number, number][] = [
  // (and the wind's km-wide cells: from 5–10 km up the glitter road lies at grazing views where a pixel is ~150 m
  // along the view, and the hundred-metre paws were gone from it — the first stills of this field, 296 s, a smooth
  // column of light)
  [2600, 1300, 0.8],
  [900, 450, 1],
  [340, 170, 0.5],
];
const GUST_GAIN = 0.45;
const SLICK_SCALE: [number, number] = [1400, 120];
const SLICK_DEPTH = 0.8;
/** the slicks' mask (noise in −1..1 → 0..1) and its mean over the noise, what it fades to as the footprint passes it */
const SLICK_EDGES: [number, number] = [0.15, 0.5];
const SLICK_MEAN = 0.18;
/** m: the crests' warp — its reach, and the size of its bends; and the most it can shorten a wave by (its gradient's
 * bound: the noise's slope is ≲ 2 a unit, so reach × 2 / size; the band limit allows for it) */
const WARP: [number, number] = [6, 140];
const WARP_GAIN = (WARP[0] * 2) / WARP[1];
/** σ² floor (Cox & Munk's zero-wind intercept, src/ocean/surfaceMaterial.ts COX_MUNK_CALM_SLOPE_VAR: the sea's own) */
export const CALM_SLOPE_VAR = 0.003;
const SEED = 0x2d5ea;

export interface DescentWave {
  /** rad/m, the wavevector in the field's frame (x east, z north) */
  kx: number;
  kz: number;
  /** rad/s */
  omega: number;
  /** the slope amplitude (k × the height amplitude) */
  slope: number;
  /** rad */
  phase: number;
  /** 0..1: how much of it is wind chop (the gusts and slicks act on it) */
  chop: number;
}

export interface DescentSpectrum {
  waves: DescentWave[];
  /** the spectrum's slope variance under the shortest drawn wave (σ², unresolved everywhere) */
  rest: number;
  /** the spectrum's whole slope variance, drawn and not (σ²) */
  total: number;
  /** unit, the wind sea's heading in x, z */
  wind: [number, number];
}

/** σ² density of the spectrum over (k, θ): S·k² per unit k-area / 4π² (oceanMath slopeWavelengthHistogram's
 * bookkeeping: per FFT cell 2·amp²·k², amp = √(S/2)/domain, cell area (2π/domain)²), times k for the polar area */
function slopeDensity(k: number, th: number, p: OceanParams): number {
  return (waveSpectrum(k * Math.cos(th), k * Math.sin(th), p) * k * k * k) / (4 * Math.PI * Math.PI);
}

const ANGLES = 180;
const K_STEPS = 12;

/** the band [k0, k1)'s slope variance by direction (σ² per angle step) */
function bandByAngle(k0: number, k1: number, p: OceanParams): Float64Array {
  const out = new Float64Array(ANGLES);
  const dth = (2 * Math.PI) / ANGLES;
  const lr = Math.log(k1 / k0) / K_STEPS;
  for (let i = 0; i < K_STEPS; i++) {
    const k = k0 * Math.exp((i + 0.5) * lr);
    const dk = k * lr;
    for (let a = 0; a < ANGLES; a++) out[a] += slopeDensity(k, (a + 0.5) * dth, p) * dk * dth;
  }
  return out;
}

/**
 * The descent's waves from the sea's spectrum: deterministic (a fixed seed), built once per planet.
 */
export function descentSpectrum(p: OceanParams = seaSpectrumParams()): DescentSpectrum {
  const rng = createRng(SEED);
  const kLo = (2 * Math.PI) / DRAWN_LAMBDA[0];
  const kHi = (2 * Math.PI) / DRAWN_LAMBDA[1];
  const bands = Math.ceil(Math.log2(kHi / kLo) * BANDS_PER_OCTAVE);
  const ratio = Math.pow(kHi / kLo, 1 / bands);
  const waves: DescentWave[] = [];
  let drawn = 0;
  let skipped = 0;
  for (let b = 0; b < bands; b++) {
    const k0 = kLo * Math.pow(ratio, b);
    const k1 = k0 * ratio;
    const byAngle = bandByAngle(k0, k1, p);
    const v = byAngle.reduce((s, x) => s + x, 0);
    if (!(v > 0)) continue;
    drawn += v;
    // directions stratified over the band's own directional distribution (inverse CDF), wavelengths stratified
    // log-uniform within the band, each stratum jittered by the seed
    const cdf = new Float64Array(ANGLES);
    let acc = 0;
    for (let a = 0; a < ANGLES; a++) cdf[a] = acc += byAngle[a] / v;
    // (the wavelength strata dealt to the direction strata in a seeded order: the band's longer wave not always
    // the one nearer the wind)
    const per = (2 * Math.PI) / Math.sqrt(k0 * k1) > LONG_FROM ? PER_BAND_LONG : PER_BAND;
    const kOrder = [...Array(per).keys()];
    for (let i = kOrder.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [kOrder[i], kOrder[j]] = [kOrder[j], kOrder[i]];
    }
    for (let j = 0; j < per; j++) {
      // (jittered within its stratum, and drawn again while it lands within MIN_APART of a wave already placed:
      // two waves on one heading are one long-crested comb, the more so at a whole ratio of wavelengths — a 6.6 m
      // and a 2.2 m wave 0.5° apart came out of the plain draw, a train and its third harmonic)
      const at = (u: number): number => {
        const target = (j + u) / per;
        let a = 0;
        while (a < ANGLES - 1 && cdf[a] < target) a++;
        const prev = a > 0 ? cdf[a - 1] : 0;
        return ((a + (target - prev) / Math.max(1e-12, cdf[a] - prev)) * 2 * Math.PI) / ANGLES;
      };
      const apart = (th: number): number =>
        Math.min(Math.PI, ...waves.map((w) => Math.abs(((Math.atan2(w.kz, w.kx) - th + 3 * Math.PI) % (2 * Math.PI)) - Math.PI)));
      // (kept off the strata's outer tenths: two waves a band stand in for its whole fan, and one drawn from the far
      // tail of the isotropic pedestal put a peak-band 12 m wave 86° off the wind)
      const draw = (): number => at(0.1 + 0.8 * rng());
      let th = draw();
      for (let tries = 0; tries < 24 && apart(th) < MIN_APART; tries++) th = draw();
      const k = k0 * Math.pow(ratio, (kOrder[j] + rng()) / per);
      const lambda = (2 * Math.PI) / k;
      // (a cosine of slope amplitude s has σ² s²/2: the band's σ² shared between its waves)
      const chop = 1 - Math.min(1, Math.max(0, (lambda - CHOP_FROM[0]) / (CHOP_FROM[1] - CHOP_FROM[0])));
      // (the swell's and the spectral gap's waves, slopes under MIN_SLOPE, are not drawn: under a glint ~0.15 wide
      // they do not show, and each costs every pixel a cosine; their σ² joins `rest`)
      const slope = Math.sqrt((2 * v) / per);
      if (slope < MIN_SLOPE * Math.sqrt(PER_BAND / per)) {
        skipped += v / per;
        continue;
      }
      waves.push({
        kx: k * Math.cos(th),
        kz: k * Math.sin(th),
        omega: Math.sqrt(GRAVITY * k),
        slope,
        phase: rng() * 2 * Math.PI,
        chop: chop * chop * (3 - 2 * chop),
      });
    }
  }
  // what lies under the shortest drawn wave, to where the spectrum's small-wave cutoff has taken all of it
  const under = bandByAngle(kHi, Math.max(kHi * 8, 40 / Math.max(1e-3, p.smallWaveCutoff)), p).reduce((s, x) => s + x, 0);
  return { waves, rest: under + skipped, total: drawn + under, wind: [Math.cos(p.windDirection), Math.sin(p.windDirection)] };
}

/**
 * The slope field on the flat sea under the eye, band-limited by the pixel's footprint, for one view ray.
 *  - `d` the view ray (world, unit); `up`, `east`, `north` the sea's frame there (world, unit)
 *  - `eye` the eye in that frame (m: x east, y height over the sea, z north)
 *  - `time` s, `pixel` rad (the pixel's angular size)
 * Returns the surface's slope (∂h/∂east, ∂h/∂north) and its unresolved slope variance (σ²: the spectrum's waves this
 * pixel cannot hold and those under the shortest drawn one, the calm floor not included), the gusts and slicks in
 * both.
 */
export function descentSlopes(
  spec: DescentSpectrum,
  o: { d: V3; up: V3; east: V3; north: V3; eye: V3; time: F; pixel: F },
): { gx: F; gz: F; unresolved: F } {
  const gx = float(0).toVar();
  const gz = float(0).toVar();
  const unresolved = float(spec.total).toVar();
  // only low down: from orbit it is all roughness (`unresolved` starts at the whole spectrum's)
  If(o.eye.y.lessThan(4e4), () => {
    const mu = o.d.dot(o.up).negate().max(1e-4);
    const reach = o.eye.y.div(mu);
    const de = o.d.dot(o.east);
    const dn = o.d.dot(o.north);
    const x = o.eye.x.add(de.mul(reach));
    const z = o.eye.z.add(dn.mul(reach));
    // the footprint's axes on the water: along the view (stretched by 1/μ) and across it
    const flat = sqrt(de.mul(de).add(dn.mul(dn)));
    const ax = select(flat.greaterThan(1e-4), de.div(flat.max(1e-4)), float(1));
    const az = select(flat.greaterThan(1e-4), dn.div(flat.max(1e-4)), float(0));
    const across = reach.mul(o.pixel);
    const along = across.div(mu);
    // ---- the patches: the gusts and the slicks, on the chop's slope variance
    const [wx, wz] = spec.wind;
    const qa = x.mul(wx).add(z.mul(wz));
    const qc = z.mul(wx).sub(x.mul(wz));
    // an octave of feature size `s` (m, its finer axis) whole while it spans 8 footprints, gone (to its mean) by 4
    const seen = (s: number): F => float(1).sub(smoothstep(s / 8, s / 4, along));
    let gust: F = float(0);
    GUST_SCALE.forEach(([sa, sc, g], i) => {
      gust = gust.add(mx_noise_float(vec3(qa.div(sa), qc.div(sc), 3.7 * i + 1.3)).mul(seen(sc)).mul(g)) as F;
    });
    const slickNoise = mx_noise_float(vec3(qa.div(SLICK_SCALE[0]), qc.div(SLICK_SCALE[1]), 7.9));
    const slick = mix(float(SLICK_MEAN), smoothstep(SLICK_EDGES[0], SLICK_EDGES[1], slickNoise), seen(SLICK_SCALE[1]));
    const patches = smoothstep(PATCH_ALT[0], PATCH_ALT[1], o.eye.y);
    const roughMod = float(1).add(gust.mul(GUST_GAIN)).mul(float(1).sub(slick.mul(SLICK_DEPTH))).max(0.05);
    const chopVar = float(1).add(roughMod.sub(1).mul(patches)).toVar();
    const chopAmp = sqrt(chopVar);
    // ---- the waves, their crests bent: the plane waves laid on a slowly warped copy of the water (WARP), so no crest
    // runs straight for more than a few of its own wavelengths and the long waves, the few the eye resolves from a
    // few hundred metres up, read short-crested, as the FFT's hundreds of modes make them, not as a lattice
    const wq = vec3(x.div(WARP[1]), z.div(WARP[1]), 0);
    const xw = x.add(mx_noise_float(wq.add(vec3(0, 0, 11.3))).mul(WARP[0]));
    const zw = z.add(mx_noise_float(wq.add(vec3(0, 0, 23.9))).mul(WARP[0]));
    let lost: F = float(spec.rest).mul(chopVar) as F;
    for (const w of spec.waves) {
      const k = Math.hypot(w.kx, w.kz);
      // the wave's phase step across one pixel, for its direction against the footprint's two axes (cycles), and
      // the most the warp can shorten it by (WARP_GAIN)
      const ka = ax.mul(w.kx).add(az.mul(w.kz)).mul(along);
      const kc = az.mul(w.kx).sub(ax.mul(w.kz)).mul(across);
      const step = sqrt(ka.mul(ka).add(kc.mul(kc))).mul((1 + WARP_GAIN) / (2 * Math.PI));
      const fade = float(1).sub(smoothstep(DESCENT_BAND[0], DESCENT_BAND[1], step));
      const amp = w.chop > 0 ? float(1).add(chopAmp.sub(1).mul(w.chop)) : float(1);
      const s = fade.mul(amp).mul(w.slope);
      const c = xw.mul(w.kx).add(zw.mul(w.kz)).sub(o.time.mul(w.omega)).add(w.phase).cos().mul(s);
      gx.addAssign(c.mul(w.kx / k));
      gz.addAssign(c.mul(w.kz / k));
      // (what the fade took, by the variance it would have had: §V.48b)
      lost = lost.add(float(1).sub(fade.mul(fade)).mul(amp.mul(amp)).mul((w.slope * w.slope) / 2)) as F;
    }
    unresolved.assign(lost);
  });
  return { gx, gz, unresolved };
}

/** the rippled normal (world) from the slopes, over the sea's up `n` */
export function slopeNormal(n: V3, east: V3, north: V3, gx: F, gz: F): V3 {
  return normalize(n.sub(east.mul(gx)).sub(north.mul(gz)));
}
