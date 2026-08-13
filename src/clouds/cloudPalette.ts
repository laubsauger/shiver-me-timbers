/**
 * Live cloud palette (§T.39 golden hour).
 *
 * THE PROBLEM. The composite reconstructs cloud colour as
 * `sunColor*(R/B) + skyColor*(G/B)` from two constants. Sky, fog and ambient
 * all follow a live day-cycle palette, so at `timeOfDay 17.75` the whole
 * scene went rose-and-amber while the clouds stayed lavender-blue — warm sky
 * over a cold subject.
 *
 * TWO SIGNALS, AND USING ONE FOR BOTH IS §B.49. The first fix drove BOTH the
 * key and the fill from `scene.fog.color`, the sky rig's blended HORIZON HAZE.
 * That is right for the key — a low sun really is reddened by the long path
 * that paints the haze — and wrong for the fill, and the measurement is brutal:
 * at `timeOfDay 17.3` it resolved key hue 35° against fill hue 29°, SIX DEGREES
 * of separation. A cumulus then has no colour difference between its lit and
 * unlit faces, only a brightness one, and the whole mass reads as one brown
 * lump. That was the user's "dark and gloomy" and most of the "strange holes"
 * report, because a shadow side with no hue of its own reads as a bite taken
 * out of the cloud rather than as the far side of a solid.
 *
 * So the fill is driven by the SKY DOME instead — `skyPalette().zenith`, the
 * deep sky opposite and above the sun, which is what actually bounces into a
 * cloud's shadow side. Measured at the same moment: fill hue 245°, TWO HUNDRED
 * AND TEN degrees of separation from the key, which is the warm-top /
 * violet-underside pair every SoT sunset reference shows.
 *
 * MID IS NOT THE COOL ONE, which is worth writing down because it is the
 * obvious guess: `skyPalette().mid` at that same sunset is salmon (hue 356°),
 * so a fill driven from it lands warm again just by a different route. Only
 * the zenith is reliably on the far side of the wheel from the key.
 *
 * THE HAZE IS NOT DISCARDED, it is demoted to the two jobs it is right for:
 * the key's WARMTH (below), and the warm uplight on cloud BASES at low sun,
 * which cloudCores.ts adds into the sunlight channel — that light is the low
 * sun's own reddened light, so it rides `sunColor` and needs no third slot.
 * Neither of those may be re-pointed at the dome, and the fill may never be
 * re-pointed at the haze; that collapse is the bug this header exists for.
 *
 * NO NEW PLUMBING FOR EITHER. `attachTo(scene)` hands us the scene, so the
 * haze is `scene.fog.color`; the dome is read straight from `skyPalette()`,
 * the single owner of "what colour is the sky" (§T39), at the same
 * `skyParams.timeOfDay` that `main.ts` hands `sky.update()`. Reading the owner
 * rather than re-deriving is the pattern `caustics/waterLighting.ts` already
 * established for exactly this class of split.
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
import { skyPalette, sunElevation } from '../sky/sunCycle';
import { skyParams } from '../params/sky';

export interface CloudPaletteInput {
  /** authored sRGB hex: sunlit cloud faces */
  sunColor: number;
  /** authored sRGB hex: skylight bouncing into the cloud (NOT "the sky") */
  skyColor: number;
  /** 0..1 how far the skylight hue follows the live SKY DOME (not the haze —
   *  see the header: haze-driven fill is a 6°-hue-separation brown lump) */
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
 * The colour of the sky DOME this frame — the fill's input, written into
 * `out`. Read from `skyPalette()`, the single owner (§T39), at the same
 * `skyParams.timeOfDay` main.ts hands `sky.update()`, so the two cannot drift.
 *
 * VERIFIED EQUAL, not assumed: the sky background paints its zenith with
 * `skyPalette(key.sunElevation, p)`, and `keyLight()` sets that field to
 * `sunElevation(timeOfDay, p.latitude)` — the same pure function of the same
 * input this calls. The moon handover moves the key's DIRECTION and COLOUR but
 * not the palette ramp ("every palette ramp still keys off the SUN",
 * moonCycle.ts:299), so this stays exact after dark too.
 *
 * §V.31: `skyPalette()` returns sRGB TRIPLES, so they must enter through the
 * sRGB overload — the working space is linear and skipping the transfer here
 * is §B.9 exactly.
 */
export function resolveDomeAmbient(out: THREE.Color): void {
  const pal = skyPalette(
    sunElevation(skyParams.timeOfDay, skyParams.latitude),
    skyParams,
  );
  out.setRGB(pal.zenith[0], pal.zenith[1], pal.zenith[2], THREE.SRGBColorSpace);
}

/**
 * Resolve the frame's sun/sky pair.
 *
 * `haze` is `scene.fog.color` (already in the linear working space) and drives
 * the KEY's warmth only. `dome` is {@link resolveDomeAmbient}'s output and
 * drives the FILL. Passing the haze as both is the collapse the header
 * describes; passing null for either leaves that half authored, which is the
 * safe direction — an unattached or fogless scene still renders.
 */
export function resolveCloudPalette(
  p: CloudPaletteInput,
  haze: THREE.Color | null | undefined,
  dome: THREE.Color | null | undefined,
  outSun: THREE.Color,
  outSky: THREE.Color,
): void {
  _baseSun.setHex(p.sunColor); // setHex defaults to SRGBColorSpace (§V31)
  _baseSky.setHex(p.skyColor);
  outSun.copy(_baseSun);
  outSky.copy(_baseSky);

  // SKYLIGHT follows the DOME's hue — that IS what bounces into a cloud's
  // shadow side: cyan-blue at midday, violet at sunset, and on the far side of
  // the wheel from the key in both cases. Its LIGHTNESS is pinned, because how
  // much ambient a cloud receives is an authored level and a bright dome
  // driving it is §B.19. Pinning also means the night sky being near-black
  // (post-ACES zenith (0,1,17) at the Night preset) cannot black out the
  // clouds: only the hue transfers, so night clouds still read pale grey,
  // which is what the SoT night references show.
  if (dome) {
    tintTowardAtmosphere(
      _baseSky,
      dome,
      p.skyTint,
      p.paletteSatFollow,
      srgbLightness(_baseSky),
      outSky,
    );
  }
  if (!haze) return;

  haze.getHSL(_hsl, THREE.SRGBColorSpace);
  const hazeL = _hsl.l;

  // SUNLIGHT follows the HAZE, and only as far as the light is actually WARM.
  // The haze is the right input here for the same reason it is the wrong one
  // above: it is the colour of light that has come the long way through the
  // atmosphere, which is what reddens a low sun. Warmth (r-b in sRGB) is ~0 at
  // midday, when the haze is cyan, and ~0.58 at the §T.39 sunset.
  haze.getRGB(_srgb, THREE.SRGBColorSpace);
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
    haze,
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
