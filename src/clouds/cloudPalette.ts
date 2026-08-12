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
function tintPreservingLightness(
  authored: THREE.Color,
  ambient: THREE.Color,
  t: number,
  out: THREE.Color,
): void {
  out.copy(authored);
  if (t <= 0) return;
  authored.getHSL(_hsl, THREE.SRGBColorSpace);
  const authoredL = _hsl.l;
  ambient.getHSL(_hsl, THREE.SRGBColorSpace);
  // the haze hue and saturation, re-lit to the authored brightness
  _tint.setHSL(_hsl.h, _hsl.s, authoredL, THREE.SRGBColorSpace);
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

  // SKYLIGHT follows the atmosphere's hue directly — that IS what is bouncing
  // into the cloud, cyan at midday and amber at sunset.
  tintPreservingLightness(_baseSky, ambient, p.skyTint, outSky);

  // SUNLIGHT follows it only as far as the light is actually WARM. Driving it
  // from hue like the skylight would turn sunlit faces blue at midday, when
  // the haze is cyan; warmth (r-b in sRGB) is ~0 then and ~0.58 at sunset.
  ambient.getRGB(_srgb, THREE.SRGBColorSpace);
  const warmth = clamp01((_srgb.r - _srgb.b) * p.paletteWarmthGain);
  tintPreservingLightness(_baseSun, ambient, clamp01(p.sunTint) * warmth, outSun);
}

/** sRGB lightness of a working-space colour — what the guard above pins. */
export function srgbLightness(c: THREE.Color): number {
  c.getHSL(_hsl, THREE.SRGBColorSpace);
  return _hsl.l;
}
