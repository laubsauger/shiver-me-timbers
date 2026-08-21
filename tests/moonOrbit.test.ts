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
  moonLitAxis,
  moonTerminator,
  nightFactor,
  nightRamp,
} from '../src/sky/moonCycle';
import { starDuskGate } from '../src/sky/starfield';
import type { Vec3 } from '../src/sky/sunCycle';
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

  // RE-CUT (§V80, §B77). The previous pin here — "the drawn disc is never
  // more lit than the orbit says, the cheat can only subtract" — PASSED WHILE
  // ENFORCING THE DEFECT: a `min` by illumination is exactly what drew every
  // full moon as the 0.18 crescent. The property that matters is the other
  // way round: the drawn disc is never LESS lit than the orbit says, and
  // never thinner than the floor crescent, and the two agree wherever the
  // floor is inactive.
  it('the drawn disc is at least as lit as the orbit AND as the floor crescent; the orbit wins when it is fatter', () => {
    for (const ph of PHASES) {
      for (const cheat of [0, 0.18, 0.5, 1]) {
        const k = keyLight(18.5, withParams({ moonPhase: ph, moonDiscPhase: cheat }));
        expect(k.moonLitFraction).toBeGreaterThanOrEqual(moonIllumination(ph) - 1e-12);
        expect(k.moonLitFraction).toBeGreaterThanOrEqual(moonIllumination(cheat) - 1e-12);
        if (moonIllumination(ph) >= moonIllumination(cheat)) expect(k.moonDrawPhase).toBe(ph);
      }
    }
    // at new moon the floor may widen the crescent, but the GATE is 0: the
    // orbit's own 0% lit is below moonMinLit, and nothing is drawn
    for (const cheat of [0.18, 0.5]) {
      const k = keyLight(18.5, withParams({ moonPhase: 0, moonDiscPhase: cheat }));
      expect(k.moonDiscGate).toBe(0);
    }
  });

  it('the shipped default (full orbit) draws a FULL disc — the floor is inactive at phase 0.5 (§B77)', () => {
    // the §B77 report: phase 0.5 rendered as a ~20% crescent. The shipped
    // moonPhase IS full, and the disc must say so.
    expect(P.moonPhase).toBe(0.5);
    const k = keyLight(19.25, P);
    expect(k.moonDrawPhase).toBe(P.moonPhase);
    expect(k.moonLitFraction).toBe(1);
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

// ─────────────────────────────────────────────────────────────────────────
// §B77 — THE TERMINATOR. The T108 lookdev frames showed phase 0.5 as a ~20%
// crescent with the lit limb facing AWAY from the sun. Two causes, both CPU:
// `moonDiscState` took the `min` of cheat and orbit by illumination (so the
// 0.18 cheat beat full), and the shader's disc axis was `moonDir × up`, a
// fixed horizontal, not the sun's projection. The shader cannot be run here
// (§V88), so `rasterLit` below is a line-for-line mirror of skyBackground.ts
// step 5 fed the same uniforms keyLight publishes.
// ─────────────────────────────────────────────────────────────────────────

function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function norm(a: Vec3): Vec3 {
  const l = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / l, a[1] / l, a[2] / l];
}

/**
 * Shader mirror: march view rays across the moon's disc exactly as the
 * background does (basis `right` = uMoonLitAxis, `up2` = uMoonDir × right,
 * disc coords dx/dy in radius units, lit where dx > k·√(1−dy²)) with the
 * softness at its limit (a hard step; the GPU's smoothstep is symmetric about
 * the edge so it integrates to the same area). Returns the lit fraction of
 * the disc and the lit area's centroid in WORLD space, projected into the
 * disc plane.
 */
function rasterLit(
  moonDir: Vec3,
  litAxis: Vec3,
  k: number,
  sinRadius: number,
  n = 301,
): { litFraction: number; centroid: Vec3 } {
  const right = litAxis;
  const up2 = cross(moonDir, right);
  const inv = 1 / Math.max(1e-3, sinRadius);
  let inDisc = 0;
  let lit = 0;
  const c: Vec3 = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const x = ((i + 0.5) / n) * 2 - 1;
      const y = ((j + 0.5) / n) * 2 - 1;
      if (x * x + y * y > 1) continue;
      // a view ray through this disc point, as the camera would supply it
      const v = norm([
        moonDir[0] + sinRadius * (x * right[0] + y * up2[0]),
        moonDir[1] + sinRadius * (x * right[1] + y * up2[1]),
        moonDir[2] + sinRadius * (x * right[2] + y * up2[2]),
      ]);
      const dx = dot(v, right) * inv;
      const dy = Math.min(1, Math.max(-1, dot(v, up2) * inv));
      const termEdge = Math.sqrt(Math.max(0, 1 - dy * dy)) * k;
      inDisc++;
      if (dx > termEdge) {
        lit++;
        c[0] += v[0] - moonDir[0];
        c[1] += v[1] - moonDir[1];
        c[2] += v[2] - moonDir[2];
      }
    }
  }
  if (lit > 0) {
    c[0] /= lit;
    c[1] /= lit;
    c[2] /= lit;
  }
  return { litFraction: lit / inDisc, centroid: c };
}

const SIN_R = Math.sin((P.moonDiscSize * Math.PI) / 180);

describe('§B77 — the drawn lit fraction IS moonIllumination, at every phase', () => {
  it('shader-mirror lit area == moonIllumination(drawPhase) within 2% at 7 phases, and drawPhase == moonPhase wherever the floor is off', () => {
    for (const ph of [0, 0.1, 0.25, 0.5, 0.75, 0.9, 1]) {
      const k = keyLight(21, withParams({ moonPhase: ph }));
      const term = moonTerminator(k.sunDirection, k.moonDirection, k.moonDrawPhase);
      expect(term.litAxis).toEqual(k.moonLitAxis);
      expect(Math.abs(term.litFraction - k.moonLitFraction)).toBeLessThan(1e-12);
      const drawn = rasterLit(k.moonDirection, k.moonLitAxis, term.k, SIN_R);
      expect(Math.abs(drawn.litFraction - moonIllumination(k.moonDrawPhase))).toBeLessThan(0.02);
      // the floor only lifts a crescent thinner than the cheat; these phases
      // are all fatter (or gated dark), so the drawn disc is the ORBIT's
      if (moonIllumination(ph) >= moonIllumination(P.moonDiscPhase)) {
        expect(k.moonDrawPhase).toBe(ph);
        expect(Math.abs(drawn.litFraction - moonIllumination(ph))).toBeLessThan(0.02);
      }
    }
    // and the report's own frame: tod 19, phase 0.5 → full, not 20%
    const full = keyLight(19, withParams({ moonPhase: 0.5 }));
    const drawn = rasterLit(full.moonDirection, full.moonLitAxis, Math.cos(2 * Math.PI * full.moonDrawPhase), SIN_R);
    expect(drawn.litFraction).toBeGreaterThan(0.98);
  });

  it('the lit limb faces the SUN — lit centroid · sun projection > 0 for every (tod, phase) with a terminator on the disc', () => {
    let checked = 0;
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.25)) {
        const k = keyLight(t, p);
        const axis = k.moonLitAxis;
        // always a unit vector in the disc plane (§V28: never a zero)
        expect(Math.abs(len(axis) - 1)).toBeLessThan(1e-9);
        expect(Math.abs(dot(axis, k.moonDirection))).toBeLessThan(1e-9);
        const sm = dot(k.sunDirection, k.moonDirection);
        const proj: Vec3 = [
          k.sunDirection[0] - k.moonDirection[0] * sm,
          k.sunDirection[1] - k.moonDirection[1] * sm,
          k.sunDirection[2] - k.moonDirection[2] * sm,
        ];
        if (len(proj) < 1e-3) continue; // new/full: no side to face
        expect(dot(axis, proj)).toBeGreaterThan(0);
        const lit = k.moonLitFraction;
        if (lit < 0.05 || lit > 0.95) continue; // no terminator to read
        const drawn = rasterLit(k.moonDirection, axis, Math.cos(2 * Math.PI * k.moonDrawPhase), SIN_R, 121);
        expect(dot(drawn.centroid, proj)).toBeGreaterThan(0);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(200);
  });

  it('the old axis was wrong: moonDir × up pointed AWAY from the sun in the report frame (tod 19, phase 0.5, looking east)', () => {
    // regression witness, not a property: the frame in
    // docs/raft2100/lookdev/T108/dusk-tod19-phase0.5-east.png, where the
    // 0.18 crescent was lit on the south limb with the sun in the west.
    // Measured: old·proĵ = −0.97, new·proĵ = +1.00.
    const k = keyLight(19, withParams({ moonPhase: 0.5 }));
    const old = norm(cross(k.moonDirection, [0, 1, 0]));
    const sm = dot(k.sunDirection, k.moonDirection);
    const proj = norm([
      k.sunDirection[0] - k.moonDirection[0] * sm,
      k.sunDirection[1] - k.moonDirection[1] * sm,
      k.sunDirection[2] - k.moonDirection[2] * sm,
    ]);
    expect(dot(old, proj)).toBeLessThan(-0.9);
    expect(dot(k.moonLitAxis, proj)).toBeGreaterThan(0.99);
  });

  it('moonLitAxis is a unit vector for degenerate and garbage input (§V28)', () => {
    for (const [s, m] of [
      [[0, 1, 0], [0, 1, 0]], // sun along the moon, moon at zenith
      [[0, -1, 0], [0, 1, 0]],
      [[1, 0, 0], [1, 0, 0]],
      [[0, 0, 0], [0, 0, 0]],
      [[Number.NaN, 0, 0], [0, 1, 0]],
      [[1, 0, 0], [Number.NaN, Number.NaN, Number.NaN]],
    ] as [Vec3, Vec3][]) {
      const a = moonLitAxis(s, m);
      expect(a.every(Number.isFinite)).toBe(true);
      expect(Math.abs(len(a) - 1)).toBeLessThan(1e-9);
    }
  });
});

describe('§B77 — the sliver: visible term is EXACTLY 0 inside the glare angle or under moonMinLit', () => {
  it('∀ hour × phase: gate 0 when elongation < moonGlareAngle or the orbit is under moonMinLit lit', () => {
    for (const ph of PHASES) {
      const p = withParams({ moonPhase: ph });
      for (const t of hours(0.05)) {
        const k = keyLight(t, p);
        const sep = moonElongation(k.sunDirection, k.moonDirection);
        const visible = k.moonDiscGate * P.moonDiscIntensity * k.moonLitFraction;
        if (sep <= P.moonGlareAngle || moonIllumination(ph) <= P.moonMinLit) expect(visible).toBe(0);
      }
    }
  });

  it('the report frames: phase 0.05 at 18.5 and 19.0 draw nothing, phase 0.1 at night draws a crescent', () => {
    for (const t of [18.5, 19]) {
      const k = keyLight(t, withParams({ moonPhase: 0.05 }));
      expect(k.moonDiscGate).toBe(0);
    }
    // a young moon outside the glare is drawn — the floor makes it readable
    const young = keyLight(19.5, withParams({ moonPhase: 0.1 }));
    if (young.moonElevation > 0.1) {
      expect(young.moonDiscGate).toBeGreaterThan(0);
      expect(young.moonLitFraction).toBeGreaterThanOrEqual(moonIllumination(P.moonDiscPhase));
    }
  });

  it('moonMinLit reaches exactly 0 at the threshold and is continuous above it; garbage is finite', () => {
    const at = (lit: number) => {
      const ph = Math.acos(1 - 2 * lit) / (2 * Math.PI); // inverse of moonIllumination
      return moonDiscState(-0.5, 0.8, 120, withParams({ moonPhase: ph })).moonDiscGate;
    };
    expect(at(P.moonMinLit)).toBeLessThan(1e-12); // acos round-trip lands an ulp above the edge
    expect(at(P.moonMinLit * 0.5)).toBe(0);
    expect(at(P.moonMinLit * 2)).toBe(1);
    let prev = at(0);
    for (let l = 0; l <= 0.2; l += 0.001) {
      const cur = at(l);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(cur - prev).toBeLessThan(0.1);
      prev = cur;
    }
    const g = moonDiscState(-0.5, 0.8, 120, withParams({ moonMinLit: Number.NaN, moonPhase: 0.5 }));
    expect(Number.isFinite(g.moonDiscGate)).toBe(true);
  });
});

describe('§B77 — stars gate on solar depression, and nobody else moves', () => {
  const DEG_ = Math.PI / 180;

  it('0 at +7° and at −2°, 1 at −12°, monotone in elevation', () => {
    expect(starDuskGate(7 * DEG_, P)).toBe(0);
    expect(starDuskGate(-2 * DEG_, P)).toBe(0);
    expect(starDuskGate(-4 * DEG_, P)).toBe(0); // the 18:18 frame: pink sky, no stars
    expect(starDuskGate(-12 * DEG_, P)).toBe(1);
    expect(starDuskGate(-30 * DEG_, P)).toBe(1);
    let prev = starDuskGate(20 * DEG_, P);
    for (let e = 20; e >= -20; e -= 0.05) {
      const cur = starDuskGate(e * DEG_, P);
      expect(cur).toBeGreaterThanOrEqual(prev - 1e-12);
      expect(cur - prev).toBeLessThan(0.03);
      prev = cur;
    }
  });

  it('the stars begin AFTER civil dusk: strictly 0 down to starDuskStart, strictly > 0 just past it', () => {
    expect(starDuskGate(P.starDuskStart * DEG_, P)).toBe(0);
    expect(starDuskGate((P.starDuskStart - 0.5) * DEG_, P)).toBeGreaterThan(0);
    expect(P.starDuskStart).toBeLessThanOrEqual(-6);
    expect(P.starDuskEnd).toBeLessThanOrEqual(-12);
  });

  it('is finite and 0..1 for NaN elevation, NaN, swapped or collapsed edges (§V28)', () => {
    for (const over of [
      {},
      { starDuskStart: Number.NaN },
      { starDuskEnd: Number.NaN },
      { starDuskStart: -12, starDuskEnd: -6 },
      { starDuskStart: -8, starDuskEnd: -8 },
    ]) {
      for (const e of [Number.NaN, -1, 0, 1]) {
        const g = starDuskGate(e, withParams(over));
        expect(Number.isFinite(g)).toBe(true);
        expect(g).toBeGreaterThanOrEqual(0);
        expect(g).toBeLessThanOrEqual(1);
      }
    }
  });

  it('nightFactor — the lamps\' clock — is untouched by the star gate', () => {
    for (const t of hours(0.25)) {
      const k = keyLight(t, P);
      expect(k.nightFactor).toBe(nightFactor(k.sunElevation));
    }
    // lamps are lit before the stars show: at −4° the lamps are on, the sky has no stars
    const dusk = keyLight(18.3, P);
    expect(dusk.nightFactor).toBeGreaterThan(0.2);
    expect(starDuskGate(dusk.sunElevation, P)).toBe(0);
  });
});
