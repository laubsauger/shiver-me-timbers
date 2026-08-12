/**
 * Live cloud palette (§T.39 golden hour).
 *
 * THE PROBLEM. The composite reconstructs cloud colour as
 * `sunColor*(R/B) + skyColor*(G/B)` from two constants. Sky, fog and ambient
 * all follow a live day-cycle palette, so at `timeOfDay 17.75` the whole
 * scene went rose-and-amber while the clouds stayed lavender-blue — warm sky
 * over a cold subject.
 *
 * THE SIGNAL. `scene.fog.color` is republished every frame by the sky rig
 * with its blended horizon haze — measured `#99def9` at midday, `#fdb669` at
 * that sunset. One value that already tracks the whole day. No new plumbing:
 * `attachTo(scene)` hands us the scene, so we just read it.
 *
 * THE TRAP, AND THE GUARD. §B.19 was exactly this pair of colours both being
 * near-white and SUMMING past 1.0 pre-ACES, so lit faces and shadow faces
 * both clipped and the clouds had no tonal range at all. The midday haze
 * (`#99def9`, sRGB lightness ~0.79) is close to that near-white, so lerping
 * naively toward it walks straight back into the bug.
 *
 * So the atmosphere drives HUE AND SATURATION ONLY. Before blending, the
 * haze colour is re-lit to the authored colour's own sRGB lightness — both
 * ends of the blend then carry the authored lightness, and a lerp never
 * leaves the segment between its endpoints. The sun/sky magnitude
 * relationship that was tuned against §B.19 therefore survives every
 * possible atmosphere by construction, not by clamping afterwards.
 *
 * Colours enter and leave through THREE.Color with an explicit
 * `SRGBColorSpace` on every HSL read/write (§V31) — the authored hexes are
 * sRGB, the working space is linear, and skipping that conversion is what
 * washed out the sky in §B.9.
 */
import * as THREE from 'three/webgpu';

export interface CloudPaletteInput {
  /** authored sRGB hex: sunlit cloud faces */
  sunColor: number;
  /** authored sRGB hex: skylight bouncing into the cloud (NOT "the sky") */
  skyColor: number;
  /** 0..1 how far the skylight hue follows the live atmosphere */
  skyTint: number;
  /** 0..1 how far the sunlight hue follows it at full warmth */
  sunTint: number;
  /** maps the atmosphere's (r-b) in sRGB to a 0..1 "how warm is the light" */
  paletteWarmthGain: number;
  /**
   * 0..1 how far SATURATION follows the atmosphere, separately from hue.
   * Deliberately much lower than skyTint: adopting a saturated haze's full
   * saturation at a fixed lightness drives one channel to ~1.0, and a channel
   * pinned at 1.0 on both the lit and the shadow face is §B.19 again, just in
   * orange instead of white. Hue carries the warmth; saturation must not.
   */
  paletteSatFollow: number;
  /**
   * 0..1 how far the SUNLIGHT follows the atmosphere's own brightness DOWN at
   * full warmth. Asymmetric on purpose: at golden hour the sun genuinely is
   * deeper and dimmer, so the lit faces must darken as well as warm or they
   * read as midday clouds under a sunset. The clamp is one-directional —
   * this term can never end up BRIGHTER than authored, which is the direction
   * §B.19 failed in.
   */
  sunDarken: number;
}

const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

// scratch — resolveCloudPalette runs every frame and must not allocate
const _hsl = { h: 0, s: 0, l: 0 };
const _srgb = { r: 0, g: 0, b: 0 };
const _tint = /*@__PURE__*/ new THREE.Color();
const _baseSun = /*@__PURE__*/ new THREE.Color();
const _baseSky = /*@__PURE__*/ new THREE.Color();

/**
 * `out` = `authored`, with the hue/saturation of `ambient` mixed in by `t`,
 * and the authored sRGB lightness preserved at both ends of that mix.
 */
/**
 * `out` = `authored`, mixed by `t` toward a colour carrying the atmosphere's
 * HUE (and a damped share of its saturation) at lightness `targetL`.
 *
 * `targetL` is what every §B.19 guarantee rests on: callers pass the authored
 * lightness, or something strictly below it, so neither endpoint of the mix
 * is ever brighter than what was tuned — and a lerp never leaves the segment
 * between its endpoints.
 */
function tintTowardAtmosphere(
  authored: THREE.Color,
  ambient: THREE.Color,
  t: number,
  satFollow: number,
  targetL: number,
  out: THREE.Color,
): void {
  out.copy(authored);
  if (t <= 0) return;
  authored.getHSL(_hsl, THREE.SRGBColorSpace);
  const authoredS = _hsl.s;
  ambient.getHSL(_hsl, THREE.SRGBColorSpace);
  const sat = authoredS + (_hsl.s - authoredS) * clamp01(satFollow);
  _tint.setHSL(_hsl.h, sat, clamp01(targetL), THREE.SRGBColorSpace);
  out.lerp(_tint, clamp01(t));
}

/**
 * Resolve the frame's sun/sky pair. `ambient` is `scene.fog.color` (already
 * in the linear working space); pass null and the authored colours come back
 * untouched, so an unattached or fogless scene still renders.
 */
export function resolveCloudPalette(
  p: CloudPaletteInput,
  ambient: THREE.Color | null | undefined,
  outSun: THREE.Color,
  outSky: THREE.Color,
): void {
  _baseSun.setHex(p.sunColor); // setHex defaults to SRGBColorSpace (§V31)
  _baseSky.setHex(p.skyColor);
  outSun.copy(_baseSun);
  outSky.copy(_baseSky);
  if (!ambient) return;

  ambient.getHSL(_hsl, THREE.SRGBColorSpace);
  const hazeL = _hsl.l;

  // SKYLIGHT follows the atmosphere's hue directly — that IS what is bouncing
  // into the cloud, cyan at midday and amber at sunset. Its LIGHTNESS is
  // pinned: how much ambient a cloud receives is an authored level, and the
  // midday haze is near-white, so letting it drive brightness is §B.19.
  tintTowardAtmosphere(
    _baseSky,
    ambient,
    p.skyTint,
    p.paletteSatFollow,
    srgbLightness(_baseSky),
    outSky,
  );

  // SUNLIGHT follows it only as far as the light is actually WARM. Driving it
  // from hue like the skylight would turn sunlit faces blue at midday, when
  // the haze is cyan; warmth (r-b in sRGB) is ~0 then and ~0.58 at sunset.
  ambient.getRGB(_srgb, THREE.SRGBColorSpace);
  const warmth = clamp01((_srgb.r - _srgb.b) * p.paletteWarmthGain);
  const sunL = srgbLightness(_baseSun);
  // ...and it darkens toward the atmosphere's own brightness as it warms, but
  // only ever downward (Math.min): a sunset cloud is deep orange, not a
  // midday cloud wearing an orange hat.
  const sunTargetL = Math.min(
    sunL,
    sunL + (hazeL - sunL) * clamp01(p.sunDarken) * warmth,
  );
  tintTowardAtmosphere(
    _baseSun,
    ambient,
    clamp01(p.sunTint) * warmth,
    p.paletteSatFollow,
    sunTargetL,
    outSun,
  );
}

/** sRGB lightness of a working-space colour — what the guard above pins. */
export function srgbLightness(c: THREE.Color): number {
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return _hsl.l;
}
