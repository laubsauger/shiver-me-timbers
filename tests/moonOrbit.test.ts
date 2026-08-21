/**
 * §V91 / §B63 / §T.108 — THE MOON HAS ITS OWN ORBIT, AND DISCS EXIST ONLY
 * ABOVE THE HORIZON.
 *
 * The report: "the sun turns into the moon and vice versa ... the sun is
 * barely crossing the horizon at sunset but already looks like a moon while
 * providing sunset colours". Two causes, both measured on the CPU before the
 * fix and both pinned here as PROPERTIES (§V80), over the full day × every
 * phase, never as a number somebody liked:
 *
 *   1. the sun's DISC was drawn along THE KEY direction, which swings to the
 *      moon each dusk — so from -5.7° of sun on, an ember-orange 14× disc sat
 *      ON the moon all night (centre luminance 5.2 at -7.2°, 0.36 by -14°),
 *      and during the swing it travelled through the nadir and came up
 *      under the moon. "The sun turned into the moon."
 *   2. `moonDirection = sunDirection(tod − 24·phase)`: the sun's own track,
 *      time-shifted, so near new/old phase the moon rode beside the sun; and
 *      no disc, glow or halo of either body was gated by its elevation.
 *
 * Every test here sweeps; none of them cares what the inclination is set to
 * beyond reading it back from params.
 */
import { describe, expect, it } from 'vitest';
import { skyParams, type SkyParams } from '../src/params/sky';
import {
  keyDirectionWeight,
  keyLight,
  moonDirection,
  moonElevation,
  moonElongation,
  moonIllumination,
  moonDiscState,
  nightRamp,
} from '../src/sky/moonCycle';
import { bodyHorizonGate, daylight, sunDirection, sunElevation } from '../src/sky/sunCycle';

const P = skyParams;
const LAT = P.latitude;
const DEG = Math.PI / 180;
const INCL_DEG = P.moonInclination;

function withParams(over: Partial<SkyParams>): SkyParams {
  return { ...P, ...over };
}

function hours(step = 0.05): number[] {
  const out: number[] = [];
  for (let t = 0; t <= 24 + 1e-9; t += step) out.push(t);
  return out;
}

const PHASES = [0, 0.02, 0.05, 0.1, 0.25, 0.5, 0.75, 0.9, 0.95, 0.98, 1];

function len(v: readonly number[]): number {
  return Math.hypot(v[0], v[1], v[2]);
}

describe('the orbit (§V91): elongation IS the phase', () => {
  it('angular separation from the sun is monotone: 0 → 180° over the waxing half, back over the waning', () => {
    for (const t of [0, 6.3, 12, 17.7, 19.25, 23.9]) {
      const s = sunDirection(t, LAT);
      const sep = (ph: number) => moonElongation(s, moonDirection(t, ph, LAT));
      // new moon is within the tilt of the sun; full is within the tilt of the antipode
      expect(sep(0)).toBeLessThanOrEqual(INCL_DEG + 1e-9);
      expect(sep(0.5)).toBeGreaterThanOrEqual(180 - INCL_DEG - 1e-9);
      for (let ph = 0; ph < 0.5 - 1e-9; ph += 0.01) {
        expect(sep(ph + 0.01)).toBeGreaterThan(sep(ph));
      }
      for (let ph = 0.5; ph < 1 - 1e-9; ph += 0.01) {
        expect(sep(ph + 0.01)).toBeLessThan(sep(ph));
      }
    }
  });

  it('with the tilt switched off it IS the old time-shifted sun — nothing else moved', () => {
    // the reduction that proves the new expression changed exactly one
    // thing (the tilt) and not the track, the latitude handling or the wrap
    for (const lat of [-45, 0, 15, 55]) {
      for (const t of hours(0.37)) {
        for (const ph of PHASES) {
          const m = moonDirection(t, ph, lat, 0);
          const old = sunDirection(t - 24 * Math.min(1, Math.max(0, ph)), lat);
          expect(Math.abs(m[0] - old[0]) + Math.abs(m[1] - old[1]) + Math.abs(m[2] - old[2])).toBeLessThan(1e-12);
        }
      }
    }
  });

  it('the moon is never ON the sun\'s track at the default tilt — that is the whole point', () => {
    // the new moon and the full moon both sit a full tilt off the track at
    // the default node; a moon that ever coincided with the sun would be
    // §B63 again the moment a disc is drawn for it
    for (const t of hours(0.25)) {
      const s = sunDirection(t, LAT);
      expect(moonElongation(s, moonDirection(t, 0, LAT))).toBeGreaterThan(INCL_DEG * 0.99);
      expect(moonElongation(s, moonDirection(t, 0.5, LAT))).toBeLessThan(180 - INCL_DEG * 0.99);
    }
  });

  it('a full moon rises as the sun sets — elevations of opposite sign, within the tilt', () => {
    for (const t of hours(0.05)) {
      const se = sunElevation(t, LAT);
      const me = moonElevation(t, 0.5, LAT);
      expect(Math.abs(se + me)).toBeLessThanOrEqual(INCL_DEG * DEG + 1e-9);
    }
    // and concretely, the Night preset has a low moon over a set sun
    expect(sunElevation(19.25, LAT)).toBeLessThan(0);
    expect(moonElevation(19.25, 0.5, LAT)).toBeGreaterThan(0);
    expect(moonElevation(19.25, 0.5, LAT) * (1 / DEG)).toBeLessThan(25);
  });

  it('is a unit vector, finite, at every hour, phase, latitude, tilt and node — including garbage (§V28)', () => {
    for (const lat of [-60, 0, 15, 60]) {
      for (const t of [-1, 0, 5.5, 12, 18.7, 23.9, 24, 25, Number.NaN]) {
        for (const ph of [-0.1, 0, 0.2, 0.5, 0.77, 1, 1.1, Number.NaN]) {
          for (const [i, node] of [
            [0, 0],
            [5.1, 90],
            [30, 360],
            [Number.NaN, 45],
            [5.1, Number.NaN],
          ]) {
            const m = moonDirection(t, ph, lat, i, node);
            expect(Number.isFinite(m[0] + m[1] + m[2])).toBe(true);
            expect(len(m)).toBeCloseTo(1, 12);
          }
        }
      }
    }
  });

  it('is continuous in time across midnight and in phase across 0/1', () => {
    for (const ph of PHASES) {
      const a = moonDirection(23.9999, ph, LAT);
      const b = moonDirection(0.0001, ph, LAT);
      expect(len([a[0] - b[0], a[1] - b[1], a[2] - b[2]])).toBeLessThan(1e-3);
    }
    for (const t of [0, 7, 18.2]) {
      const a = moonDirection(t, 0.9999, LAT);
      const b = moonDirection(t, 0.0001, LAT);
      expect(len([a[0] - b[0], a[1] - b[1], a[2] - b[2]])).toBeLessThan(1e-2);
    }
  });

  it('is deterministic — same inputs, identical outputs, no hidden state', () => {
    for (const t of [0, 6.3, 18.5]) {
      for (const ph of [0.05, 0.5]) {
        const p = withParams({ moonPhase: ph });
        expect(keyLight(t, p)).toEqual(keyLight(t, { ...p }));
        expect(moonDirection(t, ph, LAT)).toEqual(moonDirection(t, ph, LAT));
      }
    }
  });
});

describe('horizon gating (§V91): no body is drawn from under the sea', () => {
  it('bodyHorizonGate is exactly 0 at -(radius + margin), exactly 1 at +radius, monotone, finite', () => {
    const r = 1.8;
    const m = 1.0;
    expect(bodyHorizonGate(-(r + m) * DEG, r, m)).toBe(0);
    expect(bodyHorizonGate(-(r + m + 3) * DEG, r, m)).toBe(0);
    expect(bodyHorizonGate(r * DEG, r, m)).toBe(1);
    expect(bodyHorizonGate(0.5, r, m)).toBe(1);
    let prev = -1;
    for (let e = -0.2; e <= 0.2; e += 0.001) {
      const g = bodyHorizonGate(e, r, m);
      expect(g).toBeGreaterThanOrEqual(prev);
      prev = g;
    }
    for (const [rr, mm] of [
      [0, 0],
      [-1, -1],
      [Number.NaN, 1],
      [1, Number.NaN],
    ]) {
      for (const e of [-1, 0, 1]) expect(Number.isFinite(bodyHorizonGate(e, rr, mm))).toBe(true);
    }
  });

  it('∀ body, ∀ hour, ∀ phase: disc/glow/halo gate is 0 below -(radius + margin) and 1 above +radius', () => {
    const sunLo = -(P.sunDiscSize + P.bodyHorizonMargin) * DEG;
    const moonLo = -(P.moonDiscSize + P.bodyHorizonMargin) * DEG;
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours()) {
        const k = keyLight(t, p);
        if (k.sunElevation <= sunLo) expect(k.sunDiscGate).toBe(0);
        if (k.sunElevation >= P.sunDiscSize * DEG) expect(k.sunDiscGate).toBe(1);
        if (k.moonElevation <= moonLo) expect(k.moonDiscGate).toBe(0);
        expect(k.sunDiscGate).toBeGreaterThanOrEqual(0);
        expect(k.sunDiscGate).toBeLessThanOrEqual(1);
        expect(k.moonDiscGate).toBeGreaterThanOrEqual(0);
        expect(k.moonDiscGate).toBeLessThanOrEqual(1);
      }
    }
  });

  it('the sun DISC is drawn at the SUN, never along the key — at every hour of every phase', () => {
    // the literal bug: after the handover `direction` is the moon's, and the
    // disc used to follow it. Now the disc has its own direction and it is
    // the true sun, bit for bit.
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours()) {
        const k = keyLight(t, p);
        expect(k.sunDirection).toEqual(sunDirection(t, LAT));
        // and whenever the key has fully become the moon's, the sun's picture is gone
        if (keyDirectionWeight(k.sunElevation) >= 1) expect(k.sunDiscGate).toBe(0);
      }
    }
  });

  it('the sky palette is still driven by the TRUE sun elevation, not the key', () => {
    // sunset colours come from where the sun is even after the key is the
    // moon's — `sunElevation` is published untouched for every palette ramp
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.25)) {
        expect(keyLight(t, p).sunElevation).toBe(sunElevation(t, LAT));
      }
    }
  });
});

describe('a near-new moon is DARK, and is not drawn beside the sun (§B63)', () => {
  it('moon visible term is 0 whenever it is within 15° of a sun above -6°', () => {
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours()) {
        const k = keyLight(t, p);
        const sep = moonElongation(k.sunDirection, k.moonDirection);
        const visible = k.moonDiscGate * P.moonDiscIntensity * k.moonLitFraction;
        if (sep < 15 && k.sunElevation > -6 * DEG) expect(visible).toBe(0);
      }
    }
  });

  it('the drawn disc is never more lit than the orbit says — the crescent cheat can only subtract', () => {
    for (const ph of PHASES) {
      for (const cheat of [0, 0.18, 0.5, 1]) {
        const k = keyLight(18.5, withParams({ moonPhase: ph, moonDiscPhase: cheat }));
        expect(k.moonLitFraction).toBeLessThanOrEqual(moonIllumination(ph) + 1e-12);
        expect(k.moonLitFraction).toBeLessThanOrEqual(moonIllumination(cheat) + 1e-12);
      }
    }
    // at new moon the disc itself is dark, whatever the cheat asks for
    for (const cheat of [0.18, 0.5]) {
      const k = keyLight(18.5, withParams({ moonPhase: 0, moonDiscPhase: cheat }));
      expect(k.moonLitFraction).toBe(0);
      expect(k.moonDiscGate).toBe(0);
    }
  });

  it('the shipped default (full orbit, 0.18 crescent) draws exactly the crescent it always did', () => {
    // non-regression for the signed-off Night look: the cap is inactive at
    // phase 0.5, so the terminator and aura weight are the old values
    const k = keyLight(19.25, P);
    expect(k.moonDrawPhase).toBe(P.moonDiscPhase);
    expect(k.moonLitFraction).toBe(moonIllumination(P.moonDiscPhase));
    expect(k.moonDiscGate).toBe(1);
  });

  it('moonDiscState is bounded 0..1 and finite for garbage inputs (§V28, §V44)', () => {
    for (const [se, me, sep] of [
      [Number.NaN, 0.3, 90],
      [0.3, Number.NaN, 90],
      [0.3, 0.3, Number.NaN],
      [-9, 9, 720],
      [9, -9, -5],
    ]) {
      const garbage = withParams({
        moonGlareSoftness: 0,
        moonGlareAngle: Number.NaN,
        bodyHorizonMargin: Number.NaN,
      });
      for (const p of [P, garbage]) {
        const d = moonDiscState(se, me, sep, p);
        for (const v of [d.sunDiscGate, d.moonDiscGate, d.litFraction, d.drawPhase]) {
          expect(Number.isFinite(v)).toBe(true);
          expect(v).toBeGreaterThanOrEqual(0);
          expect(v).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

describe('the handover survives the new orbit (moonCycle header — keep the nadir route)', () => {
  it('the dead window is still dark for EVERY phase: sun gate 0 and moon ramp 0 across the swing', () => {
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.002)) {
        const k = keyLight(t, p);
        const w = keyDirectionWeight(k.sunElevation);
        if (w <= 0 || w >= 1) continue;
        expect(daylight(k.sunElevation)).toBe(0);
        expect(nightRamp(k.sunElevation)).toBe(0);
        expect(k.intensity).toBe(0);
        expect(k.moonWeight).toBe(0);
      }
    }
  });

  it('the key never rises above the horizon during the swing unless the MOON is up, for every phase', () => {
    // The nadir route's contract: mid-swing `.y` ≤ max(sun.y, moon.y), and
    // since the sun is below the horizon for the whole window that means
    // `.y` ≤ 0 unless the moon itself is above it — in which case the key
    // may rise TOWARD the moon and no higher. A moon below the horizon keeps
    // the key at or below the horizon for the entire swing.
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.002)) {
        const k = keyLight(t, p);
        const w = keyDirectionWeight(k.sunElevation);
        if (w <= 0 || w >= 1) continue;
        expect(k.direction[1]).toBeLessThanOrEqual(Math.max(0, k.moonDirection[1]) + 1e-12);
        if (k.moonDirection[1] <= 0) expect(k.direction[1]).toBeLessThanOrEqual(0);
        expect(Number.isFinite(k.direction[0] + k.direction[1] + k.direction[2])).toBe(true);
        expect(len(k.direction)).toBeCloseTo(1, 10);
      }
    }
  });

  it('never points anywhere but at a real body while lighting anything — every phase', () => {
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      let worst = 0;
      for (const t of hours(0.002)) {
        const k = keyLight(t, p);
        if (k.intensity <= 0) continue;
        const s = k.sunDirection;
        const m = k.moonDirection;
        const ds = len([k.direction[0] - s[0], k.direction[1] - s[1], k.direction[2] - s[2]]);
        const dm = len([k.direction[0] - m[0], k.direction[1] - m[1], k.direction[2] - m[2]]);
        worst = Math.max(worst, Math.min(ds, dm));
      }
      expect(worst).toBe(0);
    }
  });

  it('the tilt does not change how fast the key swings — same worst step as the flat orbit, every phase', () => {
    // The nadir route has a PRE-EXISTING fast leg when the moon is near the
    // zenith at dusk (quarter phases: NADIR → a moon at .y 0.96 is a 165°
    // lerp, worst step 0.1485 per 0.001 h, identical with the tilt at 0).
    // That is not §T.108's and is not touched here; what this pins is that
    // the orbit change did not make ANY phase swing faster than it did, and
    // that the phases the nadir route was designed around stay smooth.
    for (const ph of PHASES) {
      const step = (incl: number) => {
        const p = withParams({ moonPhase: ph, moonInclination: incl });
        let prev = keyLight(0, p).direction;
        let worst = 0;
        for (const t of hours(0.001)) {
          const d = keyLight(t, p).direction;
          worst = Math.max(worst, len([d[0] - prev[0], d[1] - prev[1], d[2] - prev[2]]));
          prev = d;
        }
        return worst;
      };
      const tilted = step(P.moonInclination);
      expect(tilted).toBeLessThanOrEqual(step(0) * 1.1);
      // new, crescent and full: the moon is low at the handover, so the swing
      // is the two ~90° lerps the header describes — no jump
      if (ph <= 0.1 || ph >= 0.9 || ph === 0.5) expect(tilted).toBeLessThan(0.05);
    }
  });
});
