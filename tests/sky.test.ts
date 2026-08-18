/**
 * Sky day-cycle math tests (§V16). WHY these matter: the sun direction and
 * color ramps feed every lit system — ocean SSS/sparkle, cloud sun channel,
 * fog, the light rig. A discontinuity or out-of-range color here shows up as
 * a full-scene flash or teleporting shadows, so the pure math is pinned down
 * before any GPU work depends on it.
 */
import { describe, expect, it } from 'vitest';
import { skyParams } from '../src/params/sky';
import {
  bandGeometry,
  beamStrength,
  daylight,
  desaturate,
  hemisphereColors,
  fogRange,
  hexToRgb,
  lowSunWarmth,
  luminance,
  skyPalette,
  skyTint,
  sunAboveHorizon,
  sunColor,
  sunDirection,
  sunDiscCosines,
  sunElevation,
} from '../src/sky/sunCycle';
import { shadowBasis, shadowTexelSize, snapShadowCenter } from '../src/sky/shadowMath';

/**
 * The §T39 golden-hour hero look, as an hour rather than as "whatever the
 * default happens to be".
 *
 * This WAS `skyParams.timeOfDay`, back when the shipped default and the hero
 * look were the same 17.3. They are no longer: the default moved to 15.0 so
 * that visual defects are inspectable instead of being lost in a near-black
 * scene, while the sunset stayed a look you reach for on the slider. Two
 * tests below assert properties of a LOW SUN — that the sunset grade actually
 * renders, and that shadow coverage degenerates into a thin strip — and both
 * failed on that default change while nothing they test had moved. Binding a
 * low-sun invariant to a knob that is free to leave the low sun is the bug,
 * and naming the hour is the fix.
 */
const GOLDEN_HOUR = 17.3;

const len = (v: [number, number, number]) => Math.hypot(v[0], v[1], v[2]);
const angleBetween = (a: [number, number, number], b: [number, number, number]) =>
  Math.acos(Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2])));

describe('sunDirection (drives every shadow + specular in the scene)', () => {
  it('is unit length at any hour and latitude', () => {
    for (const lat of [-60, -15, 0, 15, 45, 60]) {
      for (let t = 0; t <= 24; t += 0.5) {
        expect(len(sunDirection(t, lat))).toBeCloseTo(1, 10);
      }
    }
  });

  it('never teleports across the midnight wrap — lights would visibly snap', () => {
    const before = sunDirection(23.999, 15);
    const after = sunDirection(0.001, 15);
    expect(angleBetween(before, after)).toBeLessThan(0.01);
  });

  it('moves smoothly through a whole day (no jump anywhere, not just at 0h)', () => {
    // 1 sim-minute steps; a day is 2π of hour angle so each step is tiny
    let prev = sunDirection(0, 15);
    for (let t = 1 / 60; t <= 24.0001; t += 1 / 60) {
      const cur = sunDirection(t, 15);
      expect(angleBetween(prev, cur)).toBeLessThan(0.01);
      prev = cur;
    }
  });

  it('handles out-of-range hours by wrapping (day cycle loops forever)', () => {
    expect(sunDirection(25, 15)).toEqual(sunDirection(1, 15));
    expect(sunDirection(-2, 15)).toEqual(sunDirection(22, 15));
  });

  it('rises in the east, sets in the west (morning sun lights the +x side)', () => {
    expect(sunDirection(8, 15)[0]).toBeGreaterThan(0);
    expect(sunDirection(16, 15)[0]).toBeLessThan(0);
  });
});

describe('sunElevation (day/night arc every intensity ramp keys off)', () => {
  it('noon is higher than morning — otherwise the whole day arc is wrong', () => {
    expect(sunElevation(12, 15)).toBeGreaterThan(sunElevation(8, 15));
  });

  it('noon is the daily maximum and midnight is below the horizon', () => {
    const noon = sunElevation(12, 15);
    for (let t = 0; t < 24; t += 0.25) {
      expect(sunElevation(t, 15)).toBeLessThanOrEqual(noon + 1e-12);
    }
    expect(sunElevation(0, 15)).toBeLessThan(0);
  });

  it('tropical latitude keeps noon sun near zenith (the SoT look)', () => {
    expect(sunElevation(12, 0)).toBeCloseTo(Math.PI / 2, 6);
    expect(sunElevation(12, 15)).toBeGreaterThan(1.2);
  });
});

describe('color ramps (multiplied into materials — must stay 0..1)', () => {
  const elevations = [-2, -0.5, -0.1, 0, 0.05, 0.3, 0.8, Math.PI / 2, 3];

  it('sunColor and skyTint clamp every channel to 0..1 for any elevation', () => {
    for (const e of elevations) {
      for (const c of [...sunColor(e), ...skyTint(e)]) {
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(1);
      }
    }
  });

  it('low sun is warmer than noon (red-blue gap shrinks as the sun climbs)', () => {
    const dawn = sunColor(0.05);
    const noon = sunColor(1.3);
    expect(dawn[0] - dawn[2]).toBeGreaterThan(noon[0] - noon[2]);
  });

  it('skyTint darkens at night so the whole scene dims as one', () => {
    const night = skyTint(-0.5);
    const day = skyTint(1.0);
    expect(night[0] + night[1] + night[2]).toBeLessThan(day[0] + day[1] + day[2]);
  });

  it('daylight is 0 below horizon and 1 at high sun; warmth peaks at sunset', () => {
    expect(daylight(-0.3)).toBe(0);
    expect(daylight(1.0)).toBe(1);
    expect(lowSunWarmth(0.02)).toBeGreaterThan(lowSunWarmth(1.0));
    expect(lowSunWarmth(0.02)).toBeGreaterThan(lowSunWarmth(-0.3));
  });
});

describe('ambient in shade must not repaint materials (teal-hull bug)', () => {
  // The hemisphere light is never shadowed, so on a shaded surface it is the
  // ONLY light left. Whatever hue bias it carries is applied to every shaded
  // pixel with nothing to counteract it — which is how a brown hull came out
  // sea-coloured. These tests work in LINEAR space because that is where the
  // multiply against albedo happens.
  const s2l = (c: number): number =>
    c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  const lin = (hex: number): [number, number, number] => {
    const [r, g, b] = hexToRgb(hex);
    return [s2l(r), s2l(g), s2l(b)];
  };
  /** three's HemisphereLight: mix(ground, sky, 0.5*normal.y + 0.5) */
  const ambientOn = (normalY: number, intensity: number, elev = 1.0) => {
    // drive it through the SHIPPED function, so swapping midColor back to
    // zenithColor in the light rig breaks this, not just a param edit
    // full path: palette (day↔sunset crossfade) → hemisphere colours
    const pal = skyPalette(elev, skyParams);
    const { sky, ground } = hemisphereColors(
      pal.mid,
      pal.ground,
      [1, 1, 1],
      skyParams.ambientDesaturation,
    );
    // hemisphereColors already returns LINEAR — no transfer here
    const t = 0.5 * normalY + 0.5;
    return [0, 1, 2].map((i) => (ground[i] + (sky[i] - ground[i]) * t) * intensity);
  };
  /** shaded oak: warm, and the exact material the user saw go teal */
  const OAK: [number, number, number] = [0.13, 0.07, 0.035];

  it('leaves shaded timber reading as timber, not as sea', () => {
    // vertical hull side = the reported case; also check a downward face,
    // which gets the ground half nearly pure and is the worst case
    for (const normalY of [0, -0.5, -1]) {
      // high sun AND golden hour — the sunset crossfade must not undo this
      for (const elev of [1.0, 0.05]) {
        const amb = ambientOn(normalY, skyParams.ambientIntensity, elev);
        const lit = amb.map((v, i) => v * OAK[i]);
        expect(lit[0]).toBeGreaterThan(lit[1]); // red still leads
        expect(lit[1]).toBeGreaterThan(lit[2]); // and blue still trails
      }
    }
  });

  it('fails for the palette that caused the bug — this test can bite', () => {
    // zenithColor as the sky half, zero desaturation: the shipped-before
    // state. If someone reverts either decision, the assertion above breaks.
    const sky = lin(skyParams.zenithColor);
    const ground = lin(skyParams.groundBounceColor);
    const amb = [0, 1, 2].map((i) => (ground[i] + sky[i]) * 0.5 * 0.85);
    const lit = amb.map((v, i) => v * OAK[i]);
    expect(lit[0]).toBeLessThan(lit[2]); // blue beats red → the teal slab
  });

  it('desaturation changes hue spread without changing brightness', () => {
    // mixing toward luminance is luminance-preserving by construction, so
    // this knob is safe to turn without re-exposing the whole scene
    const base = lin(skyParams.midColor);
    const l0 = luminance(base);
    for (const d of [0, 0.25, 0.5, 0.75, 1]) {
      const out = desaturate(base, d);
      expect(luminance(out)).toBeCloseTo(l0, 12);
      const spread = Math.max(...out) - Math.min(...out);
      const baseSpread = Math.max(...base) - Math.min(...base);
      expect(spread).toBeCloseTo(baseSpread * (1 - d), 12);
    }
    expect(desaturate(base, 1).every((c) => Math.abs(c - l0) < 1e-12)).toBe(true);
  });

  it('clamps a garbage desaturation instead of inverting the colour', () => {
    const base = lin(skyParams.midColor);
    expect(desaturate(base, -5)).toEqual(base); // clamped to 0, not negated
    expect(desaturate(base, 9)[0]).toBeCloseTo(luminance(base), 12);
    expect(desaturate(base, NaN).every(Number.isFinite)).toBe(true);
  });
});

describe('golden-hour palette (§T39 — one warm key, not a warm sky)', () => {
  const warmth = (c: [number, number, number]): number => c[0] - c[2];

  it('is the day palette untouched while the sun is high', () => {
    const day = skyPalette(1.2, skyParams);
    expect(day.warm).toBe(0);
    expect(day.mid).toEqual(hexToRgb(skyParams.midColor));
    expect(day.ground).toEqual(hexToRgb(skyParams.groundBounceColor));
  });

  it('warms EVERY channel of the scene together as the sun drops', () => {
    // the whole point: sky, the haze islands melt into, and the light on the
    // ship's shaded side must warm by the same weight at the same moment,
    // or the shot reads as a warm sky pasted over a cold scene
    const day = skyPalette(1.2, skyParams);
    const dusk = skyPalette(0.03, skyParams);
    expect(dusk.warm).toBeGreaterThan(0.9);
    for (const k of ['zenith', 'mid', 'horizon', 'ground'] as const) {
      expect(warmth(dusk[k])).toBeGreaterThan(warmth(day[k]));
    }
    // and the ambient that fills shade must go warm too, not stay blue
    expect(dusk.ground[0]).toBeGreaterThan(dusk.ground[2]);
    expect(dusk.mid[0]).toBeGreaterThan(dusk.mid[2]);
  });

  it('crossfades monotonically — no hue snap as the sun sets', () => {
    let prev = -Infinity;
    for (let e = 0.5; e >= 0.0; e -= 0.01) {
      const w = skyPalette(e, skyParams).warm;
      expect(w).toBeGreaterThanOrEqual(prev - 1e-12);
      prev = w;
    }
  });

  it('sunsetStrength 0 disables the grade entirely', () => {
    const off = skyPalette(0.03, { ...skyParams, sunsetStrength: 0 });
    expect(off.warm).toBe(0);
    expect(off.mid).toEqual(hexToRgb(skyParams.midColor));
  });

  it('keeps full daylight brightness down to the horizon', () => {
    // skyTint used to darken everything below ~16°, cooling golden hour by
    // more in red than blue — the grade cannot fight its own tint
    const atHorizon = skyTint(0.0);
    for (const c of atHorizon) expect(c).toBeGreaterThan(0.95);
    const twilight = skyTint(-0.2);
    expect(twilight[0]).toBeLessThan(0.5); // still dims once actually set
  });
});

describe('sky band geometry — the sunset must be a GRADIENT (§T39)', () => {
  // The user's report was "the golden hour still feels like a very bit
  // single-coloured". It was not a palette problem — the three sunset stops
  // are genuinely distinct hues. It was that the only part of the sky a
  // camera framing the sea can see (roughly 0-30°) showed none of them
  // except the horizon, because height = lift^gradientCurve with
  // lift = sin(elevation) leaves height at 0.35 even at 30°.
  const hex = (h: number): [number, number, number] => hexToRgb(h);
  const mix3 = (
    a: [number, number, number],
    b: [number, number, number],
    t: number,
  ): [number, number, number] => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const cl = (v: number) => Math.min(1, Math.max(0, v));
  /** transliteration of the TSL composite in skyBackground.ts */
  const composite = (elevDeg: number, sunSide: number, warm: number) => {
    const p = skyParams;
    const g = bandGeometry(warm, p);
    const pal = { zenith: 0, mid: 0, horizon: 0 };
    void pal;
    const Z = mix3(hex(p.zenithColor), hex(p.sunsetZenithColor), warm);
    const M = mix3(hex(p.midColor), hex(p.sunsetMidColor), warm);
    const H = mix3(hex(p.horizonColor), hex(p.sunsetHorizonColor), warm);
    const W = hex(p.horizonWarmColor);
    const lift = Math.max(0, Math.sin((elevDeg * Math.PI) / 180));
    const body = mix3(M, Z, Math.pow(lift, g.gradientCurve));
    const band = cl(Math.exp(-lift / g.hazeFalloff));
    const hazed = mix3(body, H, cl(band * (p.hazeStrength + sunSide * p.sunHazeStrength)));
    return mix3(hazed, W, cl(band * sunSide * sunSide * p.horizonWarmStrength * warm));
  };
  const spread = (warm: number): number => {
    const cs = [0, 2, 5, 10, 15, 20, 30].map((e) => composite(e, 1, warm));
    let m = 0;
    for (let i = 0; i < cs.length; i++)
      for (let j = i; j < cs.length; j++)
        m = Math.max(m, Math.hypot(cs[i][0] - cs[j][0], cs[i][1] - cs[j][1], cs[i][2] - cs[j][2]));
    return m;
  };

  it('leaves the signed-off MIDDAY geometry bit-for-bit untouched', () => {
    // the whole reason this crossfades instead of being retuned in place:
    // docs/final-full-result.png is signed off at a high sun (§T39 caution)
    const g = bandGeometry(0, skyParams);
    expect(g.hazeFalloff).toBe(skyParams.hazeFalloff);
    expect(g.gradientCurve).toBe(skyParams.gradientCurve);
  });

  it('reaches the authored sunset geometry at full golden hour', () => {
    const g = bandGeometry(1, skyParams);
    expect(g.hazeFalloff).toBe(skyParams.sunsetHazeFalloff);
    expect(g.gradientCurve).toBe(skyParams.sunsetGradientCurve);
  });

  it('moves on the SAME weight as the palette — never its own ramp', () => {
    // if these ever drift apart you get a sunset-shaped sky in day colours
    // somewhere in the middle of the crossfade
    for (const w of [0, 0.25, 0.5, 0.75, 1]) {
      const g = bandGeometry(w, skyParams);
      const f = skyParams.hazeFalloff + (skyParams.sunsetHazeFalloff - skyParams.hazeFalloff) * w;
      expect(g.hazeFalloff).toBeCloseTo(f, 12);
    }
    // and it is monotone + bounded by the two endpoints, for any garbage in
    for (const w of [-5, NaN, 9]) {
      const g = bandGeometry(w, skyParams);
      expect(Number.isFinite(g.hazeFalloff)).toBe(true);
      expect(g.gradientCurve).toBeGreaterThanOrEqual(
        Math.min(skyParams.gradientCurve, skyParams.sunsetGradientCurve),
      );
      expect(g.gradientCurve).toBeLessThanOrEqual(
        Math.max(skyParams.gradientCurve, skyParams.sunsetGradientCurve),
      );
    }
  });

  it('actually widens the visible hue journey — the user-facing claim', () => {
    // THE test. Measured RGB spread over the 0-30° window a sea-framing
    // camera sees. If someone reverts the geometry to the day values this
    // drops back to ~0.53 and the sunset is a single wash again.
    // Threshold set so that NEITHER lever alone passes — both must move:
    //   day geometry .18/1.5  0.411 | haze alone .10  0.446
    //   curve alone 0.60      0.514 | both (shipped) 0.561
    const dayGeometrySpread = 0.411;
    expect(spread(1)).toBeGreaterThan(dayGeometrySpread * 1.3); // 0.534
    // and the top of frame must actually reach a ROSE, not another orange:
    // red-minus-blue collapses as the zenith hue arrives. Day geometry
    // leaves 0.370 up there — another orange — so this assertion bites.
    const low = composite(2, 1, 1);
    const high = composite(30, 1, 1);
    expect(low[0] - low[2]).toBeGreaterThan(0.4); // warm cream near the sea
    expect(high[0] - high[2]).toBeLessThan(0.25); // rose-indigo up top (0.182)
  });
});

describe('key light vs golden hour — the two ramps must OVERLAP (§T39)', () => {
  // THE BUG THIS BLOCK EXISTS FOR: skyPalette().warm and daylight() are two
  // independent ramps over the same variable, and they used to have disjoint
  // saturation windows — warm hit 1 only below 4.58° while daylight hit 1
  // only above 10.31°. There was therefore NO time of day with both a
  // saturated sunset palette and a full-strength key, so the §T39 showcase
  // could only ever be "warm and murky" or "bright and blue". Worse, the
  // shipped default sat at 23.13°, three hundredths of a radian past warm's
  // upper edge, so the entire sunset palette multiplied by zero and had
  // never rendered at all. Every assertion below fails if either ramp is
  // retuned without the other.

  it('the golden hour actually renders the sunset grade', () => {
    // the headline regression: warm == 0 there means the four sunsetXxxColor
    // params are dead code and nobody can ever see the grade.
    //
    // THIS USED TO BE BOUND TO `skyParams.timeOfDay`, AND THAT BINDING WAS
    // WRONG. It conflated two separate things — "the sunset grade is
    // reachable" (a real invariant, the one the original bug violated) and
    // "the shipped default IS the sunset" (an art choice, and one the user
    // has since reversed: the default moved 17.3 → 15.0 so that defects are
    // inspectable rather than lost in a near-black scene). Pinning an
    // invariant to a knob means every legitimate move of that knob reads as
    // a regression. The hour is named here instead.
    const e = sunElevation(GOLDEN_HOUR, skyParams.latitude);
    // 0.7, not 0.95: the hero hour deliberately sits BELOW warm's plateau so
    // the sea is not maximally molten and N·L is high enough for shadows to
    // read. This bound still catches the original bug exactly — an hour past
    // lowSunWarmth's upper edge scores 0, not 0.7.
    expect(skyPalette(e, skyParams).warm).toBeGreaterThan(0.7);
  });

  it('the sunset grade stays REACHABLE from the slider, wherever the default sits', () => {
    // the guard the test above used to provide for free and no longer does.
    // The original bug was two ramps with DISJOINT saturation windows, so no
    // hour existed with both a saturated palette and a full key. Sweeping for
    // the existence of such an hour tests that directly, and — unlike the old
    // form — it cannot be broken merely by moving the default.
    let found = false;
    for (let h = 0; h < 24; h += 0.05) {
      const e = sunElevation(h, skyParams.latitude);
      if (skyPalette(e, skyParams).warm > 0.7 && daylight(e) > 0.7) found = true;
    }
    expect(found).toBe(true);
  });

  it('keeps enough N·L on flat water for a shadow to be VISIBLE', () => {
    // The shadow can only darken the diffuse sun term, and on flat water
    // that is sun × sin(elevation). At the old 17.7 default this was 0.240
    // and ship/island shadows read as absent; under the storm preset
    // (sunIntensity 1.6) it fell to 0.113. This is the floor that keeps a
    // cast shadow on the sea believable — including in weather.
    const e = sunElevation(skyParams.timeOfDay, skyParams.latitude);
    const clear = skyParams.sunIntensity * daylight(e) * Math.sin(e);
    expect(clear).toBeGreaterThan(0.5);
    const storm = 1.6 * daylight(e) * Math.sin(e); // storm preset sunIntensity
    expect(storm).toBeGreaterThan(0.24);
  });

  it('the SHIPPED default also has a real key light on the subject', () => {
    // and the other half: a full grade under a 38% sun is the murk we are
    // avoiding, so the default must clear a usable key too
    const e = sunElevation(skyParams.timeOfDay, skyParams.latitude);
    expect(daylight(e)).toBeGreaterThan(0.85);
  });

  it('would have caught the old default — this test can bite', () => {
    // 16.4 was the shipped value; if someone reverts timeOfDay, or widens
    // lowSunWarmth's 0.4 upper edge back over it, the two tests above break
    const e = sunElevation(16.4, 15);
    expect(e).toBeGreaterThan(0.4); // past lowSunWarmth's upper edge...
    expect(skyPalette(e, skyParams).warm).toBe(0); // ...so: no grade at all
  });

  it('leaves a whole window where BOTH ramps are effectively saturated', () => {
    // not just the one time we picked: a recording session needs room to
    // move the clock without losing the grade or the key
    const usable: number[] = [];
    for (let t = 16; t <= 18.5; t += 0.05) {
      const e = sunElevation(t, 15);
      if (skyPalette(e, skyParams).warm > 0.95 && daylight(e) > 0.85) usable.push(t);
    }
    expect(usable.length).toBeGreaterThan(4); // ≥ 0.2 h of usable clock
  });
});

describe('daylight = horizon gate × beam strength (§V44 bounded at source)', () => {
  it('is 0 below the horizon and 1 at high sun', () => {
    expect(daylight(-0.3)).toBe(0);
    expect(daylight(1.0)).toBe(1);
  });

  it('only the GEOMETRIC gate may reach zero — atmosphere dims, never kills', () => {
    // the physical claim the split encodes: a sun at 4° is reddened and
    // attenuated, not extinguished. If beamStrength is ever allowed to hit 0
    // above the horizon we are back to a silhouetted golden hour.
    for (let e = 0; e <= 1.5; e += 0.01) {
      expect(beamStrength(e)).toBeGreaterThan(0.3);
    }
    expect(sunAboveHorizon(-0.05)).toBe(0); // the earth still occludes
    expect(daylight(-0.05)).toBe(0);
  });

  it('never exceeds 1 and never goes negative, at any input (§V44)', () => {
    // this feeds DirectionalLight.intensity and HemisphereLight.intensity;
    // both factors are smoothsteps so the PRODUCT is bounded by construction
    for (const e of [-1e9, -3, -0.3, -0.02, 0, 0.05, 0.2, 1.5, 1e9, NaN]) {
      const d = daylight(e);
      expect(Number.isFinite(d)).toBe(true);
      expect(d).toBeGreaterThanOrEqual(0);
      expect(d).toBeLessThanOrEqual(1);
    }
  });

  it('never decreases as the sun climbs — a dip would pulse the whole scene', () => {
    let prev = -Infinity;
    for (let e = -0.6; e <= 1.6; e += 0.0005) {
      const d = daylight(e);
      expect(d).toBeGreaterThanOrEqual(prev - 1e-15);
      prev = d;
    }
  });

  it('crosses dusk smoothly — no strobe as the sun sets (§V44 lesson)', () => {
    // sunLight AND hemi intensity both key off this, so a step here flashes
    // the entire scene. Steepest slope must stay well under a per-frame jump.
    let prev = daylight(-0.6);
    let worst = 0;
    for (let e = -0.6; e <= 1.6; e += 0.0005) {
      const d = daylight(e);
      worst = Math.max(worst, Math.abs(d - prev));
      prev = d;
    }
    expect(worst).toBeLessThan(0.01); // measured 6.8e-3 per 5e-4 rad
  });

  it('holds the key through golden hour instead of dimming with air mass', () => {
    // 5.79° and 4.35° are the two showcase candidates; the old single ramp
    // gave 0.66 and 0.47 there, which is the "full grade, dim sun" trap
    expect(daylight(sunElevation(17.6, 15))).toBeGreaterThan(0.99);
    expect(daylight(sunElevation(17.7, 15))).toBeGreaterThan(0.9);
  });

  it('sunColor already carries the spectral half of the extinction', () => {
    // WHY beamStrength has a floor rather than tracking air mass: the colour
    // ramp alone more than halves the key's luminance by the horizon. If
    // someone makes sunColorLow less orange, this drops and the floor needs
    // revisiting — that is the coupling, made visible.
    const s2l = (c: number): number =>
      c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    const lum = (c: [number, number, number]): number =>
      0.2126 * s2l(c[0]) + 0.7152 * s2l(c[1]) + 0.0722 * s2l(c[2]);
    const ratio = lum(sunColor(0)) / lum(sunColor(1.3));
    expect(ratio).toBeGreaterThan(0.4);
    expect(ratio).toBeLessThan(0.55); // measured 0.473
  });
});

describe('shadow texel snapping (why: unsnapped = crawling shadow edges)', () => {
  const sun = sunDirection(16.4, 15);
  const texel = shadowTexelSize(80, 2048); // 7.8 cm at the shipped settings

  it('derives the texel size the renderer actually uses', () => {
    expect(texel).toBeCloseTo(0.078125, 10);
    expect(shadowTexelSize(80, 4096)).toBeCloseTo(texel / 2, 10);
  });

  it('refuses to divide by nonsense — snapping off, never NaN (§V28)', () => {
    for (const [e, m] of [[0, 2048], [80, 0], [-80, 2048], [NaN, 2048], [80, NaN]] as Array<
      [number, number]
    >) {
      expect(shadowTexelSize(e, m)).toBe(0);
    }
    // texel 0 must pass the centre straight through, not emit NaN
    const c: [number, number, number] = [12.3, 0, -4.5];
    expect(snapShadowCenter(c, sun, 0)).toEqual(c);
    expect(snapShadowCenter(c, sun, NaN)).toEqual(c);
    expect(snapShadowCenter(c, [0, 0, 0], texel).every(Number.isFinite)).toBe(true);
    expect(snapShadowCenter(c, [0, 1, 0], texel).every(Number.isFinite)).toBe(true);
  });

  it('holds the frustum STILL while the ship moves within one texel', () => {
    // this is the whole point: sub-texel ship motion must not move the grid,
    // or every shadow edge re-samples on a new grid and visibly crawls
    const base = snapShadowCenter([100, 0, 100], sun, texel);
    const { x, y } = shadowBasis(sun);
    for (const f of [0, 0.1, -0.2, 0.35, -0.45, 0.49]) {
      const nudged: [number, number, number] = [
        base[0] + x[0] * f * texel + y[0] * f * texel,
        base[1] + x[1] * f * texel + y[1] * f * texel,
        base[2] + x[2] * f * texel + y[2] * f * texel,
      ];
      const snapped = snapShadowCenter(nudged, sun, texel);
      for (let i = 0; i < 3; i++) expect(snapped[i]).toBeCloseTo(base[i], 9);
    }
  });

  it('moves by WHOLE texels when the ship crosses cell boundaries', () => {
    const { x } = shadowBasis(sun);
    const start = snapShadowCenter([0, 0, 0], sun, texel);
    for (const n of [1, 2, 7, 40]) {
      const moved: [number, number, number] = [
        start[0] + x[0] * n * texel,
        start[1] + x[1] * n * texel,
        start[2] + x[2] * n * texel,
      ];
      const snapped = snapShadowCenter(moved, sun, texel);
      const du =
        (snapped[0] - start[0]) * x[0] +
        (snapped[1] - start[1]) * x[1] +
        (snapped[2] - start[2]) * x[2];
      expect(du / texel).toBeCloseTo(n, 6); // exactly n texels, no drift
    }
  });

  it('never strays more than half a texel — the ship stays framed', () => {
    const { x, y } = shadowBasis(sun);
    for (let i = 0; i < 200; i++) {
      const c: [number, number, number] = [i * 3.7 - 300, 0, i * -2.9 + 120];
      const s = snapShadowCenter(c, sun, texel);
      const d: [number, number, number] = [s[0] - c[0], s[1] - c[1], s[2] - c[2]];
      const du = d[0] * x[0] + d[1] * x[1] + d[2] * x[2];
      const dv = d[0] * y[0] + d[1] * y[1] + d[2] * y[2];
      expect(Math.abs(du)).toBeLessThanOrEqual(texel / 2 + 1e-9);
      expect(Math.abs(dv)).toBeLessThanOrEqual(texel / 2 + 1e-9);
    }
  });

  it('puts a caster and its ground shadow in the SAME texel column', () => {
    // THE MISCONCEPTION THIS TEST EXISTS TO KILL: at a 4.35° sun a 40 m mast
    // throws a 526 m shadow, and "the ortho half-width is 80, so 85% of the
    // shadow is clipped" is the obvious — and wrong — conclusion. It cost a
    // proposal for cascades, a 4096 map and a second shadow render before
    // anyone did the projection. A caster and its shadow are displaced from
    // each other ALONG THE LIGHT DIRECTION, which is the shadow camera's
    // DEPTH axis, so their (u,v) are IDENTICAL. shadowExtent cannot clip a
    // long shadow at any elevation; only near/far can.
    for (const t of [12, 15, 16.4, 17.3, 17.7, 17.95]) {
      const s = sunDirection(t, 15);
      const { x, y } = shadowBasis(s);
      const mast: [number, number, number] = [0, 40, 0];
      // where the mast top's shadow lands on the water plane y = 0
      const k = mast[1] / s[1];
      const hit: [number, number, number] = [mast[0] - s[0] * k, 0, mast[2] - s[2] * k];
      const uv = (p: [number, number, number]): [number, number] => [
        p[0] * x[0] + p[1] * x[1] + p[2] * x[2],
        p[0] * y[0] + p[1] * y[1] + p[2] * y[2],
      ];
      const [mu, mv] = uv(mast);
      const [hu, hv] = uv(hit);
      expect(hu).toBeCloseTo(mu, 9);
      expect(hv).toBeCloseTo(mv, 9);
      // and the ground distance really is long — this is not a trivial case
      if (t >= 17.7) expect(Math.hypot(hit[0], hit[2])).toBeGreaterThan(400);
    }
  });

  it('sizes the extent by the caster, bounded by its own HEIGHT', () => {
    // corollary of the above, and the reason 80 needs no revisiting for the
    // sunset: the mast's light-space half-footprint is height*cos(elevation).
    // That GROWS as the sun drops (the mast turns side-on to the light) but
    // it is bounded above by the mast height itself — 40 m, never 526 m. So
    // the worst case over the whole day is a sun on the horizon, and even
    // that needs half the shipped extent.
    const MAST = 40;
    let worst = 0;
    for (let t = 6; t <= 18; t += 0.05) {
      const { y } = shadowBasis(sunDirection(t, 15));
      const need = Math.abs(MAST * y[1]); // mast projected onto the v axis
      expect(need).toBeLessThanOrEqual(MAST + 1e-9); // never exceeds height
      worst = Math.max(worst, need);
    }
    expect(worst).toBeLessThan(skyParams.shadowExtent); // 40 vs 80: 2× margin
    expect(worst).toBeGreaterThan(0.99 * MAST); // and the bound really is tight
  });

  it('covers the whole ship shadow at the shipped sunset default', () => {
    // the concrete claim, against the SHIPPED params: if someone lowers
    // shadowExtent or moves timeOfDay past sunset, this is what breaks
    const s = sunDirection(skyParams.timeOfDay, skyParams.latitude);
    const e = sunElevation(skyParams.timeOfDay, skyParams.latitude);
    const { x, y } = shadowBasis(s);
    const mast: [number, number, number] = [0, 40, 0];
    const k = mast[1] / s[1];
    const hit: [number, number, number] = [mast[0] - s[0] * k, 0, mast[2] - s[2] * k];
    for (const p of [mast, hit]) {
      const u = p[0] * x[0] + p[1] * x[1] + p[2] * x[2];
      const v = p[0] * y[0] + p[1] * y[1] + p[2] * y[2];
      expect(Math.abs(u)).toBeLessThan(skyParams.shadowExtent);
      expect(Math.abs(v)).toBeLessThan(skyParams.shadowExtent);
    }
    // the receiver swath along the sun azimuth must reach past the shadow
    const reach = skyParams.shadowExtent / Math.sin(e);
    expect(reach).toBeGreaterThan(Math.hypot(hit[0], hit[2]));
    // ...and the far plane must reach it too — that IS the bound that applies
    expect(1200 + Math.hypot(hit[0], hit[2]) * Math.cos(e)).toBeLessThan(2600);
  });

  it('covers a STRIP, not a disc — the coverage hole islands fall into', () => {
    // The other half of the story, and the correction to an over-broad read
    // of the test above. A caster shares its shadow's texel column, but the
    // frustum is centred on the PLAYER, so a caster displaced SIDEWAYS is
    // simply not in the map and casts nothing at all. The ±extent/sin(elev)
    // reach applies only along the sun azimuth: at a low sun the covered
    // water is a long thin strip, which is why the user sees "islands cast no
    // shadow" and "it does receive shadow at some point very far away" in the
    // same frame. If a coverage fix lands, these numbers move and this test
    // must be re-derived rather than deleted.
    //
    // ASSERTED AT THE GOLDEN HOUR, NOT AT THE SHIPPED DEFAULT. The whole
    // premise here is "at a LOW sun the covered water is a long thin strip" —
    // the anisotropy is 1/sin(elevation), so the defect is a property of a low
    // sun, not of whatever hour happens to be the default. It used to read
    // `skyParams.timeOfDay` only because the default was itself a low-sun
    // hero look; when that moved 17.3 → 15.0 the test failed while nothing
    // about shadow coverage had changed. The severity bounds below belong to
    // the hour, so the hour is named.
    const s = sunDirection(GOLDEN_HOUR, skyParams.latitude);
    const e = sunElevation(GOLDEN_HOUR, skyParams.latitude);
    const { x, y } = shadowBasis(s);
    const ext = skyParams.shadowExtent;
    const reach = (azFromSun: number): number => {
      const sa = [s[0] / Math.cos(e), s[2] / Math.cos(e)]; // horizontal, toward sun
      const ca = [-sa[1], sa[0]]; // crosswind
      const r = (azFromSun * Math.PI) / 180;
      const dx = sa[0] * Math.cos(r) + ca[0] * Math.sin(r);
      const dz = sa[1] * Math.cos(r) + ca[1] * Math.sin(r);
      let d = 0;
      for (let k = 1; k <= 5000; k++) {
        const p: [number, number, number] = [dx * k, 0, dz * k];
        const u = p[0] * x[0] + p[1] * x[1] + p[2] * x[2];
        const v = p[0] * y[0] + p[1] * y[1] + p[2] * y[2];
        if (Math.abs(u) > ext || Math.abs(v) > ext) break;
        d = k;
      }
      return d;
    };
    // Along the sun line the strip reaches extent/sin(elevation) — 454 m at
    // the 17.3 default's 10.14°, and it was 1055 m when the default was
    // 17.7/4.35°, so these scale with time of day and are asserted as
    // ratios rather than pinned metres.
    expect(reach(0)).toBeGreaterThan(4 * ext);
    expect(reach(180)).toBeGreaterThan(4 * ext);
    // ...and crosswind it stops at the bare extent. 5.7× anisotropy at 17.3.
    expect(reach(90)).toBeLessThanOrEqual(ext + 1);
    expect(reach(0) / reach(90)).toBeGreaterThan(4);
    // the anisotropy is exactly 1/sin(elevation) — the shape of the defect
    expect(reach(0) / reach(90)).toBeCloseTo(1 / Math.sin(e), 0);

    // the concrete victim: the enemy ship is a featured subject and is out
    const enemy: [number, number, number] = [190, 0, -150];
    const eu = enemy[0] * x[0] + enemy[1] * x[1] + enemy[2] * x[2];
    expect(Math.abs(eu)).toBeGreaterThan(ext); // outside → casts nothing
  });

  it('never slides along the light axis — that would move near/far', () => {
    const { z } = shadowBasis(sun);
    for (const c of [
      [10, 2, -30],
      [-1234, 5, 987],
      [0.001, 0, 0.001],
    ] as Array<[number, number, number]>) {
      const s = snapShadowCenter(c, sun, texel);
      const before = c[0] * z[0] + c[1] * z[1] + c[2] * z[2];
      const after = s[0] * z[0] + s[1] * z[1] + s[2] * z[2];
      expect(after).toBeCloseTo(before, 9);
    }
  });

  it('builds an orthonormal basis at every sun position of the day', () => {
    // if this basis drifts from three's lookAt the snap quantises against a
    // grid the renderer never uses, and the flicker survives the "fix"
    for (let t = 0; t <= 24; t += 0.25) {
      for (const lat of [-60, 0, 15, 70]) {
        const { x, y, z } = shadowBasis(sunDirection(t, lat));
        for (const v of [x, y, z]) {
          expect(Math.hypot(v[0], v[1], v[2])).toBeCloseTo(1, 9);
        }
        const d = (a: [number, number, number], b: [number, number, number]) =>
          a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
        expect(d(x, y)).toBeCloseTo(0, 9);
        expect(d(x, z)).toBeCloseTo(0, 9);
        expect(d(y, z)).toBeCloseTo(0, 9);
      }
    }
  });
});

describe('sunDiscCosines (edges of the sky shader smoothstep)', () => {
  it('orders the edges so smoothstep(outer, inner, dot) grows toward the sun', () => {
    // cosine falls as the angle grows, so the outer (wider) edge must be the
    // SMALLER number — swap them and the disc inverts into a hole in the sky
    const [outer, inner] = sunDiscCosines(1.1, 0.35);
    expect(outer).toBeLessThan(inner);
    expect(inner).toBeCloseTo(Math.cos((1.1 * Math.PI) / 180), 12);
    expect(outer).toBeCloseTo(Math.cos((1.45 * Math.PI) / 180), 12);
  });

  it('never collapses both edges together — equal edges are a NaN sky (§V28)', () => {
    // the panel lets softness be typed to 0 (or garbage); smoothstep divides
    // by (inner - outer), so a zero gap NaNs every pixel of the background
    for (const [size, soft] of [
      [1.1, 0],
      [0, 0],
      [3, -2],
      [1, NaN],
      [NaN, NaN],
    ] as Array<[number, number]>) {
      const [outer, inner] = sunDiscCosines(size, soft);
      expect(Number.isFinite(outer)).toBe(true);
      expect(Number.isFinite(inner)).toBe(true);
      expect(inner - outer).toBeGreaterThan(0);
    }
  });

  it('a bigger disc reaches further from the sun axis', () => {
    expect(sunDiscCosines(3, 0.5)[1]).toBeLessThan(sunDiscCosines(1, 0.5)[1]);
  });
});

describe('fogRange (distance haze must never become a divide-by-zero)', () => {
  it('passes sane authored ranges through untouched', () => {
    expect(fogRange(700, 4500)).toEqual([700, 4500]);
  });

  it('keeps far strictly above near — three divides by (far - near) (§V28)', () => {
    for (const [n, f] of [
      [4000, 4000],
      [4000, 100],
      [900, NaN],
      [NaN, 5000],
      [-500, 200],
    ] as Array<[number, number]>) {
      const [near, far] = fogRange(n, f);
      expect(Number.isFinite(near)).toBe(true);
      expect(Number.isFinite(far)).toBe(true);
      expect(far).toBeGreaterThan(near);
      expect(near).toBeGreaterThanOrEqual(0);
    }
  });

  it('leaves room for a kilometre-scale sea — no clamp to a few hundred m (§V30)', () => {
    // the ocean draws to kilometres; a fog range that saturated before the
    // water ends is exactly the "wall" the user reported
    expect(fogRange(1500, 16000)).toEqual([1500, 16000]);
  });
});
