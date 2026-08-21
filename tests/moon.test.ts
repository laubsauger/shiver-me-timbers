/**
 * §V22/§V44 — the moon as THE KEY LIGHT.
 *
 * The design claim these tests exist to defend: a moon is a DIRECTIONAL
 * source, so night is not a new light rig, it is the existing sun rig aimed
 * somewhere else. That buys a moon glint road, moonlit caustics and moon
 * shadows from systems that have never heard of a moon (`src/main.ts` hands
 * `sky.sunDirection` and `sky.sunLight` to the ocean, the caustics, the
 * clouds, the god rays and the terrain). The price of that shortcut is that
 * the handover between the two bodies has to be airtight, because every one
 * of those consumers gates on the direction's `.y` and none of them can see
 * what is happening.
 *
 * The two load-bearing tests here are "never points anywhere but at a real
 * body while it is lighting anything" and "the swing stays below the
 * horizon". Everything else is arithmetic.
 */
import { describe, expect, it } from 'vitest';
import { skyParams, type SkyParams } from '../src/params/sky';
import {
  HANDOVER_END,
  NIGHT_FULL,
  ambientLevel,
  blendKeyDirection,
  keyDirectionWeight,
  keyLight,
  keyRadianceScale,
  moonAboveHorizon,
  moonBrightness,
  moonDirection,
  moonElevation,
  moonIllumination,
  moonKeyWeight,
  nightRamp,
} from '../src/sky/moonCycle';
import {
  SUN_BELOW,
  daylight,
  hexToRgb,
  skyTint,
  sunColor,
  sunDirection,
  sunElevation,
} from '../src/sky/sunCycle';

const P = skyParams;
const LAT = P.latitude;

function withParams(over: Partial<SkyParams>): SkyParams {
  return { ...P, ...over };
}

function dist(a: readonly number[], b: readonly number[]): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** every hour of the day at a fine step — the handover is ~0.4 h wide */
function hours(step = 0.002): number[] {
  const out: number[] = [];
  for (let t = 0; t < 24; t += step) out.push(t);
  return out;
}

/** the orbit's tilt, in radians — the one tolerance the geometry tests allow */
const INCL = (P.moonInclination * Math.PI) / 180;

describe('moon geometry (the phase IS an elongation, not a texture)', () => {
  // §V80 re-cut (§V91): this pinned dot === -1 to 12 digits, i.e. "the full
  // moon is EXACTLY antipodal" — which is only true of a moon on the sun's
  // own track, the very defect §B63 removes. The PROPERTY a full moon has is
  // "opposite the sun to within the orbit's tilt", and exactly antipodal
  // only when that tilt is 0.
  it('a full moon sits opposite the sun, to within the orbit\'s inclination', () => {
    for (const t of [0, 3.5, 7, 11, 15.25, 19, 22.5]) {
      const s = sunDirection(t, LAT);
      const m = moonDirection(t, 0.5, LAT);
      const dot = s[0] * m[0] + s[1] * m[1] + s[2] * m[2];
      expect(dot).toBeLessThanOrEqual(-Math.cos(INCL) + 1e-12);
      // and with the tilt switched off it is the antipode, to floating point
      const flat = moonDirection(t, 0.5, LAT, 0);
      expect(s[0] * flat[0] + s[1] * flat[1] + s[2] * flat[2]).toBeCloseTo(-1, 12);
    }
  });

  // §V80 re-cut: pinned elev(0) === -sunElev(0) and elev(18) === 0 to 10-12
  // digits — the same "on the sun's track" decision. The property is that a
  // full moon is up for the hours the sun is not: it crosses the horizon
  // within the tilt of sunset/sunrise and peaks at midnight.
  it('a full moon rises at sunset and is highest at midnight', () => {
    // the whole reason a full moon is the right default for a night scene:
    // it is up for exactly the hours the sun is not.
    expect(Math.abs(moonElevation(0, 0.5, LAT) + sunElevation(0, LAT))).toBeLessThanOrEqual(INCL + 1e-12);
    const midnight = moonElevation(0, 0.5, LAT);
    for (const t of [1, 2, 4, 20, 22, 23]) {
      expect(moonElevation(t, 0.5, LAT)).toBeLessThan(midnight);
    }
    // and it crosses the horizon as the sun does, in the other direction
    expect(Math.abs(moonElevation(18, 0.5, LAT))).toBeLessThanOrEqual(INCL);
    expect(Math.abs(moonElevation(6, 0.5, LAT))).toBeLessThanOrEqual(INCL);
  });

  // §V80 re-cut: pinned dist(moon, sun) === 0 — a moon ON the sun, which
  // with any drawn disc is the §B63 "second disc beside the sun". The property
  // is: near the sun (within the tilt), and DARK — nothing to see.
  it('a new moon sits beside the sun, within the tilt, and is dark', () => {
    for (const t of [0, 6, 13, 21]) {
      const d = dist(moonDirection(t, 0, LAT), sunDirection(t, LAT));
      expect(d).toBeLessThanOrEqual(2 * Math.sin(INCL / 2) + 1e-12);
      expect(d).toBeGreaterThan(0); // beside, not on
    }
    expect(moonIllumination(0)).toBe(0);
    expect(moonBrightness(0)).toBe(0);
  });

  it('a crescent trails the sun and has set by the small hours', () => {
    // the phase moves WHEN the moon is up, not just how lit it is — that is
    // the difference between a real phase parameter and a brightness knob.
    const phase = 0.15; // waxing crescent, 3.6 h behind the sun
    expect(moonElevation(20, phase, LAT)).toBeGreaterThan(0); // still up at 20:00
    expect(moonElevation(2, phase, LAT)).toBeLessThan(0); // long gone by 02:00
  });

  it('is a unit vector at every hour, phase and latitude', () => {
    for (const lat of [-45, 0, 15, 55]) {
      for (const t of [0, 5.5, 12, 18.7, 23.9]) {
        for (const ph of [0, 0.2, 0.5, 0.77, 1]) {
          const m = moonDirection(t, ph, lat);
          expect(Math.hypot(m[0], m[1], m[2])).toBeCloseTo(1, 12);
        }
      }
    }
  });
});

describe('phase → light (the opposition surge is why quarters are dark)', () => {
  it('illumination is 0 at new, 1/2 at the quarters, 1 at full', () => {
    expect(moonIllumination(0)).toBeCloseTo(0, 12);
    expect(moonIllumination(0.25)).toBeCloseTo(0.5, 12);
    expect(moonIllumination(0.5)).toBeCloseTo(1, 12);
    expect(moonIllumination(0.75)).toBeCloseTo(0.5, 12);
    expect(moonIllumination(1)).toBeCloseTo(0, 12);
  });

  it('a half-lit moon delivers far LESS than half the light', () => {
    // the physical point: at full phase the moon's own regolith shadows hide
    // behind the grains casting them, so brightness is strongly non-linear in
    // illuminated area. A quarter moon is ~8% of a full one in reality; a
    // linear model would paint it at 50% and make every phase look the same.
    expect(moonBrightness(0.25)).toBeLessThan(0.25);
    expect(moonBrightness(0.5)).toBeCloseTo(1, 12);
    expect(moonBrightness(0)).toBeCloseTo(0, 12);
  });

  it('never leaves 0..1, for any phase including garbage (§V44)', () => {
    for (const ph of [-3, -0.001, 0, 0.33, 1, 1.5, 99]) {
      const b = moonBrightness(ph);
      expect(Number.isFinite(b)).toBe(true);
      expect(b).toBeGreaterThanOrEqual(0);
      expect(b).toBeLessThanOrEqual(1);
    }
  });
});

describe('THE HANDOVER — the part every downstream consumer depends on', () => {
  /**
   * THE test. Every consumer of `sky.sunDirection` (ocean glint road,
   * caustics, clouds, god rays, terrain) assumes it points at whatever is
   * lighting the scene. If the key direction is ever mid-swing WHILE it is
   * lighting something, all of them are shading against a body that is not
   * there. The design makes that impossible by putting the entire 180° swing
   * inside the elevation band where the sun's gate has already reached zero
   * and the moon's ramp has not yet left it.
   */
  it('never points anywhere but at a real body while it is lighting anything', () => {
    let worst = 0;
    for (const t of hours()) {
      const k = keyLight(t, P);
      if (k.intensity <= 0) continue;
      const s = sunDirection(t, LAT);
      const m = moonDirection(t, P.moonPhase, LAT);
      worst = Math.max(worst, Math.min(dist(k.direction, s), dist(k.direction, m)));
    }
    // exact, not approximate: the ramps are disjoint by construction, so the
    // blend weight is 0 or 1 at every hour where the key is lit at all
    expect(worst).toBe(0);
  });

  it('the swing never rises ABOVE either real body — no overshoot', () => {
    // The ocean's `sunUpFactor` and the caustics' `sunUp` threshold the key's
    // `.y` near 0, so a swing that arced UP over the horizon on its way
    // across would light the water from a body that is not there. Routing
    // through the NADIR bounds the path below both endpoints by construction.
    for (const t of hours()) {
      const e = sunElevation(t, LAT);
      const w = keyDirectionWeight(e);
      if (w <= 0 || w >= 1) continue; // mid-swing only
      const ceiling = Math.max(
        sunDirection(t, LAT)[1],
        moonDirection(t, P.moonPhase, LAT)[1],
      );
      expect(keyLight(t, P).direction[1]).toBeLessThanOrEqual(ceiling);
    }
  });

  it('the gates open ONCE per body per day — the swing cannot strobe them', () => {
    // The real downstream risk is not the swing's height, it is the swing
    // making a `.y` gate open and shut repeatedly: a glint road and a field
    // of caustics pulsing on black water at dusk. Count the actual gate
    // openings over a whole day using the caustics' own edges
    // (`src/caustics/causticsNode.ts:394`, smoothstep(-0.02, 0.06, dir.y)).
    // Two is the truth — the sun rises once and the moon rises once.
    const gate = (y: number) => (y - -0.02) / (0.06 - -0.02) > 0.5;
    let openings = 0;
    let prev = gate(keyLight(0, P).direction[1]);
    for (const t of hours(0.001)) {
      const now = gate(keyLight(t, P).direction[1]);
      if (now && !prev) openings++;
      prev = now;
    }
    expect(openings).toBe(2);
  });

  it('survives the antipodal full moon that breaks every naive slerp', () => {
    // normalize(lerp(d, -d, 0.5)) is normalize(0) — NaN over the whole sky.
    // This is the exact configuration the shipped default produces.
    const s: [number, number, number] = [1, 0, 0];
    const m: [number, number, number] = [-1, 0, 0];
    for (let w = 0; w <= 1; w += 0.01) {
      const d = blendKeyDirection(s, m, w);
      expect(Number.isFinite(d[0] + d[1] + d[2])).toBe(true);
      expect(Math.hypot(d[0], d[1], d[2])).toBeCloseTo(1, 10);
    }
    expect(blendKeyDirection(s, m, 0.5)).toEqual([0, -1, 0]);
  });

  it('hands over without a teleport — no jump anywhere in the day', () => {
    let worst = 0;
    let prev = keyLight(0, P).direction;
    for (const t of hours(0.001)) {
      const d = keyLight(t, P).direction;
      worst = Math.max(worst, dist(d, prev));
      prev = d;
    }
    // 0.001 h is 3.6 sim-seconds; a teleport would read as ~2 (antipodal)
    expect(worst).toBeLessThan(0.05);
  });

  it('the two ramps are DISJOINT — that is the whole safety argument', () => {
    // keyDirectionWeight finishes exactly where nightRamp starts. If a later
    // edit widens either, this fails and the test above starts lying.
    expect(keyDirectionWeight(SUN_BELOW)).toBe(0);
    expect(keyDirectionWeight(HANDOVER_END)).toBe(1);
    expect(nightRamp(HANDOVER_END)).toBe(0);
    expect(nightRamp(NIGHT_FULL)).toBe(1);
    // and the sun really is dead everywhere the direction is in motion
    for (let e = HANDOVER_END; e <= SUN_BELOW; e += 0.0005) {
      expect(daylight(e)).toBe(0);
      expect(nightRamp(e)).toBe(0);
    }
  });
});

describe('§T39 NON-REGRESSION — night must not cost the sunset', () => {
  it('the shipped 17.3 showcase is bit-for-bit the old sun path', () => {
    const k = keyLight(17.3, P);
    const e = sunElevation(17.3, LAT);
    expect(k.direction).toEqual(sunDirection(17.3, LAT));
    expect(k.color).toEqual(sunColor(e));
    expect(k.intensity).toBe(P.sunIntensity * daylight(e));
    expect(k.moonWeight).toBe(0);
    // the ambient formula lighting.ts used to inline: 0.15 + 0.85 * day
    expect(k.ambient).toBeCloseTo(0.15 + 0.85 * daylight(e), 12);
  });

  it('a full moon cannot touch ANY hour the sun is above the horizon', () => {
    for (let t = 6; t <= 18; t += 0.01) {
      expect(keyLight(t, P).moonWeight).toBe(0);
    }
  });

  it('the sky tint above the horizon ignores the moon entirely', () => {
    // skyTint's moonLift may only move the NIGHT endpoint. If it leaked into
    // the daylight half it would recolour the signed-off sunset.
    for (const e of [0.03, 0.1, 0.18, 0.5, 1.2]) {
      expect(skyTint(e, 1)).toEqual(skyTint(e, 0));
    }
  });

  it('but it DOES lift the night endpoint, or the sky stays a dead navy', () => {
    const moonless = skyTint(-0.6, 0);
    const moonlit = skyTint(-0.6, 1);
    expect(moonless).toEqual(hexToRgb(P.nightTint));
    expect(moonlit).toEqual(hexToRgb(P.moonlitNightTint));
    // brighter in every channel — a lit sky, not a differently-tinted one
    for (let i = 0; i < 3; i++) expect(moonlit[i]).toBeGreaterThan(moonless[i]);
  });
});

/**
 * §V.72 — ONE statement of how bright the key is.
 *
 * These exist because there were two. The ocean read `sunLight.color` and not
 * its intensity, so the water's idea of the moon's brightness was
 * `moonColor`'s luminance (0.390, i.e. 43% of a noon sun) while the ship's was
 * `moonIntensity / sunIntensity` (0.221). The road burned 2.5x brighter than
 * the moon that laid it, which is what the user saw and reported as "the same
 * size as what the sun is doing".
 *
 * A test that only checked `radianceScale`'s value could not fail when that
 * drifts back, so the load-bearing one here is the RATIO test: the moon's
 * road-to-key ratio must equal the sun's, because a glint road is the specular
 * lobe of the key and the lobe's shape is the sea's slope statistics, not the
 * source's brightness. That is the invariant, and it holds at every phase.
 */
describe('§V.72 the key states its brightness ONCE', () => {
  it('is exactly 1 for every hour the sun owns the key — no sun frame moves', () => {
    // The §T39 sunset and the signed-off 15.0 / 17.6 framings are bit-identical
    // BY CONSTRUCTION, not by a value that happens to land on 1: `dirW` is 0
    // at every sun elevation at or above SUN_BELOW.
    for (const t of hours(0.005)) {
      if (sunElevation(t, LAT) < SUN_BELOW) continue;
      expect(keyLight(t, P).radianceScale).toBe(1);
    }
    for (const t of [15.0, 17.3, 17.6]) {
      expect(keyLight(t, P).radianceScale).toBe(1);
    }
  });

  it('at full moon the water is told the SAME 0.22 the ship and caustics are', () => {
    const k = keyLight(0, P);
    expect(k.moonWeight).toBe(1);
    // caustics/waterLighting.ts computes key.intensity / sunIntensity for the
    // identical reason; if these two ever disagree, one of them is lying about
    // the moon and the frame will show it as a road that outshines its source.
    expect(k.radianceScale).toBeCloseTo(P.moonIntensity / P.sunIntensity, 12);
    expect(k.radianceScale).toBeCloseTo(k.intensity / P.sunIntensity, 12);
  });

  it('the moon road-to-key ratio EQUALS the sun\'s, at every phase', () => {
    // The whole point. `road ∝ radianceScale`, `key ∝ intensity`, so the ratio
    // is what has to match — and it has to match at every phase, because
    // MOON_SURGE makes the key wildly non-linear in phase while the lobe's
    // geometry does not move at all.
    const sunRatio = keyLight(12, P).radianceScale / keyLight(12, P).intensity;
    for (const ph of [0.42, 0.46, 0.5, 0.54, 0.58]) {
      const k = keyLight(0, withParams({ moonPhase: ph }));
      expect(k.moonWeight).toBeGreaterThan(0);
      expect(k.radianceScale / k.intensity).toBeCloseTo(sunRatio, 12);
    }
  });

  it('tracks moonKeyWeight, so a crescent lays a crescent\'s road', () => {
    // Before the fix this was CONSTANT across phase: the road burned at
    // moonColor's full luminance under a sliver of moon.
    const full = keyLight(0, withParams({ moonPhase: 0.5 })).radianceScale;
    const gibbous = keyLight(0, withParams({ moonPhase: 0.44 })).radianceScale;
    const sliver = keyLight(0, withParams({ moonPhase: 0.36 })).radianceScale;
    expect(full).toBeGreaterThan(gibbous);
    expect(gibbous).toBeGreaterThan(sliver);
    expect(sliver).toBeGreaterThan(0);
  });

  it('a new moon leaves the water exactly as dark as a moonless night', () => {
    expect(keyLight(0, withParams({ moonPhase: 0 })).radianceScale).toBe(0);
  });

  it('never leaves 0..1 — it may only DIM the water (§V44)', () => {
    // Same argument setCausticKey states: whatever the panel does to either
    // intensity knob, this may not brighten the sea past its daytime
    // calibration, because `lightGain` is authored against a full-strength sun.
    for (const mi of [0, 0.75, 4, 40, -1, Number.NaN]) {
      for (const si of [0.001, 3.4, 8]) {
        const p = withParams({ moonIntensity: mi, sunIntensity: si });
        for (const t of hours(0.05)) {
          const s = keyLight(t, p).radianceScale;
          expect(Number.isFinite(s)).toBe(true);
          expect(s).toBeGreaterThanOrEqual(0);
          expect(s).toBeLessThanOrEqual(1);
        }
      }
    }
    for (const d of [-1, 0, 0.5, 1, 2, Number.NaN]) {
      for (const w of [-1, 0, 0.5, 1, 2, Number.NaN]) {
        const s = keyRadianceScale(d, w, P);
        expect(Number.isFinite(s)).toBe(true);
        expect(s).toBeGreaterThanOrEqual(0);
        expect(s).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('§V44 bounded at source', () => {
  it('key intensity is finite, non-negative and capped, at every hour+phase', () => {
    const cap = Math.max(P.sunIntensity, P.moonIntensity);
    for (const ph of [0, 0.13, 0.25, 0.5, 0.62, 0.88, 1]) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.01)) {
        const i = keyLight(t, p).intensity;
        expect(Number.isFinite(i)).toBe(true);
        expect(i).toBeGreaterThanOrEqual(0);
        expect(i).toBeLessThanOrEqual(cap);
      }
    }
  });

  it('moonKeyWeight and ambient never leave 0..1, whatever is fed in', () => {
    for (const se of [-1.5, -0.3, -0.1, -0.03, 0, 0.4, 1.5]) {
      for (const me of [-1.5, -0.02, 0.3, 1.5]) {
        const w = moonKeyWeight(se, me, 0.5);
        expect(w).toBeGreaterThanOrEqual(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
    for (const d of [0, 0.5, 1]) {
      for (const w of [0, 0.5, 1]) {
        const a = ambientLevel(d, w, P);
        expect(a).toBeGreaterThanOrEqual(P.nightAmbientFloor);
        expect(a).toBeLessThanOrEqual(1);
      }
    }
  });

  it('ambient uses max, not a sum — so widening a ramp cannot break 1', () => {
    // the ramps are disjoint today, which makes max and + identical; the
    // point of max is that it stays bounded when someone later widens one.
    expect(ambientLevel(1, 1, P)).toBeLessThanOrEqual(1);
    expect(ambientLevel(1, 1, withParams({ moonAmbient: 1 }))).toBe(1);
  });

  it('a garbage phase or a negative intensity param cannot go negative', () => {
    const p = withParams({ moonIntensity: -5, moonPhase: Number.NaN });
    for (const t of [0, 6, 12, 21]) {
      const k = keyLight(t, p);
      expect(Number.isFinite(k.intensity)).toBe(true);
      expect(k.intensity).toBeGreaterThanOrEqual(0);
    }
  });

  it('moonAboveHorizon is the only factor allowed to reach exactly 0', () => {
    expect(moonAboveHorizon(-0.5)).toBe(0);
    expect(moonAboveHorizon(0.5)).toBe(1);
  });
});

describe('the user-facing claim: a full moon actually LIGHTS the scene', () => {
  it('midnight under a full moon has a real directional key, not a tint', () => {
    const k = keyLight(0, P);
    expect(k.moonWeight).toBe(1);
    expect(k.intensity).toBe(P.moonIntensity);
    // and it is aimed at the moon, high in the sky
    expect(k.direction[1]).toBeGreaterThan(0.9);
    // the key must beat the ambient it is competing with, or it reads as a
    // flat wash instead of as moonlight coming from a direction
    expect(k.intensity).toBeGreaterThan(P.ambientIntensity * k.ambient);
  });

  it('is coloured as the moon, not as the sun', () => {
    expect(keyLight(0, P).color).toEqual(hexToRgb(P.moonColor));
  });

  it('a NEW moon leaves the moonless night exactly as it was', () => {
    const k = keyLight(0, withParams({ moonPhase: 0 }));
    expect(k.intensity).toBe(0);
    expect(k.moonWeight).toBe(0);
    expect(k.ambient).toBeCloseTo(P.nightAmbientFloor, 12);
  });

  it('night is DARKER than day but not black — the day/night ratio', () => {
    const noon = keyLight(12, P);
    const night = keyLight(0, P);
    expect(night.intensity).toBeLessThan(noon.intensity / 4);
    expect(night.intensity).toBeGreaterThan(0);
  });
});
