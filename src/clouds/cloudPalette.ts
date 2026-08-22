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
 * ...AND THEN THE KEY STOPPED BEING THE HAZE (§B90). The paragraph above is
 * still the right shape — two signals, never one — but the KEY's half was
 * measured in §B90 and the haze is not a usable stand-in for the sun. At
 * `timeOfDay 17` the sky is 44% into its sunset palette while the haze's
 * red-minus-blue proxy reads 0.13, and the haze's own hue there is 68° against
 * the key's 28°. The key half now reads `keyLight().color` and the sky's own
 * `lowSunWarmth` directly; see `resolveCloudPalette`'s header for the numbers.
 * The FILL is untouched by that change and may still never be re-pointed at
 * either input — that collapse is the bug this header exists for.
 *
 * NO NEW PLUMBING FOR EITHER. Both halves are read straight from the sky's own
 * owners — `skyPalette()` for "what colour is the sky" and `keyLight()` for
 * "what colour is the key" (§T39, §V.72) — at the same `skyParams.timeOfDay`
 * that `main.ts` hands `sky.update()`. Reading the owner rather than
 * re-deriving is the pattern `caustics/waterLighting.ts` already established
 * for exactly this class of split.
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
import { lowSunWarmth, skyPalette, sunElevation } from '../sky/sunCycle';
import { keyDirectionWeight, keyLight } from '../sky/moonCycle';
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
  /**
   * §B90. 0..1 how far the SKYLIGHT's LEVEL falls at full golden hour.
   *
   * The fill's level used to be pinned at the authored lightness at every
   * hour, which is a claim that a cloud receives as much skylight at a deep
   * sunset as at noon. It does not — the dome's own irradiance falls by
   * roughly an order of magnitude as the sun reaches the horizon — and the
   * measured consequence was the defect: with the fill at a constant 0.50
   * lightness it carried 32% of the interior's luminance in the ZENITH's
   * violet, so the body of every sunset cumulus resolved to hue 333°/286°/233°
   * — the "weirdly grey" the user photographed, next to a sky at hue 31°.
   *
   * NOT a readout of the atmosphere's brightness — that is §B.19's mistake and
   * the thing `srgbLightness` pinning was defending against. This is a pure
   * function of the SUN's elevation (the sky's own `lowSunWarmth`), gated so
   * that it is exactly 0 at midday AND exactly 0 once the moon owns the key.
   * One-directional (a multiplier ≤ 1 on the authored lightness), so the
   * §B.19 guarantee — neither endpoint of the mix is brighter than what was
   * tuned — holds by construction, not by clamping afterwards.
   */
  skyDarken: number;
}

/**
 * §T.119 / §B90 — how far this hour belongs to the SUN, and how warm it is.
 *
 * Both are pure functions of `sunElevation` and both are read from the sky's
 * own owners (`sunCycle`/`moonCycle`), never re-derived here (§T.39). They
 * exist as a pair because the two jobs are different and conflating them is
 * how the old code failed:
 *
 *  - `warm` is the SKY'S OWN golden-hour weight, `lowSunWarmth ×
 *    sunsetStrength` — the exact number `skyPalette()` blends its sunset hexes
 *    by. Using anything else is two clocks (§V.55), and the old proxy WAS
 *    something else: see the header of `resolveCloudPalette`.
 *  - `sunOwn` is `1 − keyDirectionWeight`, i.e. the share of the key the SUN
 *    still holds. It is exactly 1 for every elevation above SUN_BELOW (−2°)
 *    and exactly 0 below HANDOVER_END (−5.7°), so it reaches FULL strength at
 *    the moment of sunset — which `daylight()` does not (it is 0.30 there,
 *    because it carries `beamStrength`'s attenuation) and which is why
 *    `daylight` is the wrong gate for a COLOUR. Being exactly 0 once the moon
 *    owns the key is also what makes the night look bit-identical to before
 *    this change: every new term below multiplies by it.
 */
export interface KeyWeights {
  /** 0..1 share of the key still owned by the sun — 1 by day, 0 at night */
  sunOwn: number;
  /** 0..1 the sky's own golden-hour weight */
  warm: number;
}

export function keyWeights(): KeyWeights {
  const elev = sunElevation(skyParams.timeOfDay, skyParams.latitude);
  return {
    sunOwn: clamp01(1 - keyDirectionWeight(elev)),
    warm: clamp01(lowSunWarmth(elev) * skyParams.sunsetStrength),
  };
}

/**
 * The KEY's own colour this frame, written into `out` — `keyLight().color`,
 * the §V.72 contract value that "every sun-driven water term is tinted by".
 *
 * Read from the owner rather than re-derived, the same pattern as
 * {@link resolveDomeAmbient} below, so the clouds cannot drift from the sun.
 * The moon blend already inside `key.color` is deliberately harmless here:
 * every consumer multiplies by `keyWeights().sunOwn`, which is 0 by the time
 * the moon has any share of it.
 *
 * §V.31: `keyLight().color` is an sRGB triple, so it enters through the sRGB
 * overload — the working space is linear and skipping the transfer is §B.9.
 */
export function resolveKeyTint(out: THREE.Color): void {
  const key = keyLight(skyParams.timeOfDay, skyParams);
  out.setRGB(key.color[0], key.color[1], key.color[2], THREE.SRGBColorSpace);
}

const clamp01 = (v: number): number =>
  Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;

// scratch — resolveCloudPalette runs every frame and must not allocate
const _hsl = { h: 0, s: 0, l: 0 };
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
 * `key` is {@link resolveKeyTint}'s output — the KEY LIGHT's own colour — and
 * drives the sunlit faces. `dome` is {@link resolveDomeAmbient}'s output and
 * drives the FILL. Passing null for either leaves that half authored, which is
 * the safe direction: a scene with no sky rig still renders.
 *
 * ─── §B90: WHY `key` REPLACED `scene.fog.color` HERE ──────────────────────
 * This argument used to be the horizon HAZE, and the header above still
 * argues (correctly) that the haze is a reddened-by-the-long-path colour. What
 * it is NOT is the sun, and the amount by which it is not was never measured
 * until §B90. Two numbers, at latitude 15 with the shipped sky params:
 *
 *   - At `timeOfDay 17` (sun elevation 14.5°) the SKY is already 44% into its
 *     sunset palette — visibly pink overhead — while the haze resolves to hue
 *     68°, saturation 0.20. The old gate was `clamp01((haze.r − haze.b) ×
 *     paletteWarmthGain)`, which reads **0.13** there. The clouds therefore
 *     took 13% of a sunset while the sky took 44%, and every hour from 8° to
 *     23° of elevation was wrong in the same direction. THAT IS THE BUG: a
 *     proxy whose window (roughly ±5° of the horizon) is four times narrower
 *     than the window of the palette it was standing in for.
 *   - The colour it stood in for is not close either. At that same hour the
 *     key is hue 28°, saturation 1.00; the haze is hue 68°, saturation 0.20.
 *
 * So the warmth WEIGHT is now the sky's own `lowSunWarmth × sunsetStrength`
 * (one clock, §V.55) and the warmth COLOUR is now `keyLight().color` (§V.72's
 * "what every sun-driven water term is tinted by" — the clouds were the one
 * sun-driven term in the project that did not read it).
 *
 * The haze keeps the OTHER job the header gives it and this does not touch:
 * the warm uplight on cloud bases at low sun, which `cloudCores.ts` adds into
 * the sunlight channel — that light rides `sunColor`, which is now the key's
 * own colour rather than a haze-shaped guess at it, i.e. strictly closer to
 * what that comment always claimed.
 *
 * The FILL may still never be re-pointed at either input. That collapse is
 * §B.49 and is what the 210°-of-separation guard in tests/clouds.test.ts pins.
 */
export function resolveCloudPalette(
  p: CloudPaletteInput,
  key: THREE.Color | null | undefined,
  dome: THREE.Color | null | undefined,
  outSun: THREE.Color,
  outSky: THREE.Color,
): void {
  _baseSun.setHex(p.sunColor); // setHex defaults to SRGBColorSpace (§V31)
  _baseSky.setHex(p.skyColor);
  outSun.copy(_baseSun);
  outSky.copy(_baseSky);

  const { sunOwn, warm } = keyWeights();

  // SKYLIGHT follows the DOME's hue — that IS what bounces into a cloud's
  // shadow side: cyan-blue at midday, violet at sunset, and on the far side of
  // the wheel from the key in both cases. Its LIGHTNESS is never a readout of
  // the dome's own brightness, because a bright dome driving it is §B.19 —
  // pinning is also what stops the near-black night zenith blacking out the
  // clouds, so night clouds still read pale grey as the SoT references show.
  //
  // §B90 adds ONE way the level is allowed to move, and it is not the dome:
  // `skyDarken × warm × sunOwn`, a pure function of the SUN's elevation. See
  // the param's own note — it is a multiplier ≤ 1, so every §B.19 guarantee
  // survives, and it is exactly 1.0 at midday and exactly 1.0 at night.
  if (dome) {
    const skyL = srgbLightness(_baseSky);
    tintTowardAtmosphere(
      _baseSky,
      dome,
      p.skyTint,
      p.paletteSatFollow,
      skyL * (1 - clamp01(p.skyDarken) * warm * sunOwn),
      outSky,
    );
  }
  if (!key) return;

  key.getHSL(_hsl, THREE.SRGBColorSpace);
  const keyL = _hsl.l;
  const sunL = srgbLightness(_baseSun);
  // ...and the lit faces darken toward the key's own lightness as the hour
  // warms, but only ever downward (Math.min): a sunset cloud is deep orange,
  // not a midday cloud wearing an orange hat. This is also what BUYS the
  // chroma — the authored 0xfff0d8 sits at sRGB lightness 0.92, where the
  // largest possible chroma is 0.16 whatever the hue is, and ACES at exposure
  // 1.1 then resolves it to 235,235,235. Measured lit-face chroma at the
  // §T.39 sunset: 0.075 before, 0.20 after.
  const sunTargetL = Math.min(sunL, sunL + (keyL - sunL) * clamp01(p.sunDarken) * warm);
  tintTowardAtmosphere(
    _baseSun,
    key,
    clamp01(p.sunTint) * sunOwn,
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
