/**
 * §V92 / §T110 THE SUN HAS A WIDTH, AND THE ROAD INHERITS IT.
 *
 * User: "the reflection road on the water from the sun and the god rays…
 * when the sun goes down toward the horizon they converge in too small of a
 * spot — like a point source. The sun has a minimum width."
 *
 * MEASURED on a CPU mirror of the shader's own road (Beckmann D · Smith V ·
 * Schlick F · N·L · π, surfaceMaterial.ts sun-glint block) with the sun's
 * CENTRE as the light: the road's azimuthal half-width at its apex — the
 * water point whose half vector stands vertical — is 2·tan(elev)·θ_hm
 * EXACTLY (θ_hm = atan(σ·√ln2), the Beckmann half-power half-angle), because
 * a facet must tilt φ/(2·tan elev) across the sun's bearing to swing a
 * grazing reflection by φ. σ² = 0.003 (the Cox–Munk floor): 0.09° at 1°,
 * 0.46° at 5°, 9.1° at 60°. Against a DRAWN disc of 1.1° radius that is a
 * point on the horizon. Widening σ² cannot fix it — σ² widens the lobe in
 * HALF-VECTOR space and the pinch is the half-vector→reflection Jacobian
 * going to zero at grazing — so the fix is a source with angular extent:
 * Karis's representative point on a disc of radius r = sunDiscSize +
 * sunGlareRadiusDeg, normalised by (σ/(σ + tan(r/2)))².
 *
 * THE GRAZING TERM THAT WAS NOT ADDED (§V62/§V80): the road's REACH toward
 * the eye (its extent in view depression, ±2θ_hm about the sun's elevation,
 * i.e. ground length ∝ 1/sin²) already falls out of the half-vector geometry
 * — the point mirror below shows the road touching the horizon from 5° down
 * with no distance term anywhere. A `roadGrazingGain` knob would double
 * it. What the geometry does NOT carry is the azimuthal floor, and that is
 * the only thing this change adds.
 *
 * Everything here is a CPU mirror — no GPU, no browser (§V88). The mirror is
 * a transliteration of the shader block; keep the pair in step.
 */
import { describe, expect, it } from 'vitest';
import { sunSourceVector } from '../src/ocean/oceanSurface';
import { projectedSourceRadius, sourceHorizonGate } from '../src/core/postGodRays';
import { skyParams } from '../src/params/sky';
import { postParams } from '../src/params/post';
import { oceanSurfaceParams as sp } from '../src/params/oceanSurface';
import { getParamsEntry } from '../src/params/registry';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import oceanSurfaceSource from '../src/ocean/oceanSurface.ts?raw';
import godRaysSource from '../src/core/postGodRays.ts?raw';

const D2R = Math.PI / 180;
type V3 = [number, number, number];
const norm = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]);
  return [v[0] / l, v[1] / l, v[2] / l];
};
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const UP: V3 = [0, 1, 0];

// ── the shader block, transliterated ────────────────────────────────────
const beckmann = (cosH: number, a2: number) => {
  const c2 = Math.max(cosH * cosH, 1e-4);
  return Math.exp(-((1 - c2) / c2) / a2) / (Math.PI * a2 * c2 * c2);
};
const smithV = (nol: number, nov: number, a2: number) =>
  0.5 /
  Math.max(
    nol * Math.sqrt(nov * nov * (1 - a2) + a2) + nov * Math.sqrt(nol * nol * (1 - a2) + a2),
    1e-5,
  );
const schlick = (voh: number) => sp.fresnelR0 + (1 - sp.fresnelR0) * Math.pow(1 - voh, 5);
const GLINT_RADIANCE_MAX = 32;

/** flat water: eye direction for a point seen at depression `thv`, bearing `phi` */
const viewDir = (thv: number, phi: number): V3 => [
  -Math.sin(phi) * Math.cos(thv),
  Math.sin(thv),
  -Math.cos(phi) * Math.cos(thv),
];
const sunDir = (elev: number): V3 => [0, Math.sin(elev), Math.cos(elev)];

/** the road with the sun's CENTRE as the light — the pre-§V92 shader */
function roadPoint(V: V3, L: V3, a2: number): number {
  const H = norm(add(V, L));
  const nol = Math.max(dot(UP, L), 1e-3);
  const nov = Math.max(dot(UP, V), 1e-3);
  const voh = Math.min(Math.max(dot(V, H), 0), 1);
  return beckmann(Math.max(dot(UP, H), 0), a2) * smithV(nol, nov, a2) * schlick(voh) * nol * Math.PI;
}
/**
 * the road with the representative point of a disc of angular radius r —
 * `srcDir`, `srcHalf`, `srcEnergy` in surfaceMaterial.ts. `tanR`/`tanHalf`
 * are sunSourceUniform.x/.y.
 */
function roadArea(V: V3, L: V3, a2: number, tanR: number, tanHalf: number): number {
  const R: V3 = [-V[0], V[1], -V[2]]; // reflect(−V, up)
  const along = dot(R, L);
  const toRay = add(mul(R, along), mul(L, -1));
  const len = Math.max(Math.hypot(...toRay), 1e-6);
  const Lp = norm(add(L, mul(toRay, Math.min(1, tanR / len))));
  const H = norm(add(V, Lp));
  const nol = Math.max(dot(UP, Lp), 1e-3);
  const nov = Math.max(dot(UP, V), 1e-3);
  const voh = Math.min(Math.max(dot(V, H), 0), 1);
  const sig = Math.sqrt(a2);
  const k = (sig / (sig + Math.max(tanHalf, 0))) ** 2;
  return (
    beckmann(Math.max(dot(UP, H), 0), a2) * smithV(nol, nov, a2) * schlick(voh) * nol * Math.PI * k
  );
}

/** D(N·H') · k alone — the part of `roadArea` the source widening touches */
function areaNdfK(V: V3, L: V3, a2: number): number {
  const R: V3 = [-V[0], V[1], -V[2]];
  const toRay = add(mul(R, dot(R, L)), mul(L, -1));
  const len = Math.max(Math.hypot(...toRay), 1e-6);
  const Lp = norm(add(L, mul(toRay, Math.min(1, SRC[0] / len))));
  const H = norm(add(V, Lp));
  const sig = Math.sqrt(a2);
  return beckmann(Math.max(dot(UP, H), 0), a2) * (sig / (sig + SRC[1])) ** 2;
}

type Road = (V: V3, L: V3) => number;

/** azimuthal half-width (rad) of the road at its apex (depression = elevation) */
function apexHalfWidth(f: Road, elev: number): number {
  const L = sunDir(elev);
  const thv = Math.max(elev, 0.05 * D2R);
  const peak = f(viewDir(thv, 0), L);
  let lo = 0;
  let hi = Math.PI / 2;
  for (let i = 0; i < 50; i++) {
    const m = (lo + hi) / 2;
    if (f(viewDir(thv, m), L) > peak / 2) lo = m;
    else hi = m;
  }
  return lo;
}
/** ∫ road · cos(view zenith) dω over the viewing hemisphere, shader clamp applied */
function energy(f: Road, elev: number, n = 120): number {
  const L = sunDir(elev);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const th = ((i + 0.5) / n) * (Math.PI / 2);
    for (let j = 0; j < 2 * n; j++) {
      const ph = ((j + 0.5) / (2 * n)) * 2 * Math.PI;
      const dw = Math.cos(th) * (Math.PI / 2 / n) * (Math.PI / n);
      s += Math.min(f(viewDir(th, ph), L) * sp.lightGain, GLINT_RADIANCE_MAX) * Math.sin(th) * dw;
    }
  }
  return s;
}

const SRC = sunSourceVector(
  skyParams.sunDiscSize,
  skyParams.sunGlareRadiusDeg,
  skyParams.bodyHorizonMargin,
);
const R_SRC = (skyParams.sunDiscSize + skyParams.sunGlareRadiusDeg) * D2R;
/** the Cox–Munk floor (near field) and the shipped swell's total (far field) */
const SIGMAS = [0.003, 0.0607];
const point = (a2: number): Road => (V, L) => roadPoint(V, L, a2);
const area = (a2: number): Road => (V, L) => roadArea(V, L, a2, SRC[0], SRC[1]);

describe('§V92 the sun road has the sun\'s width', () => {
  it('measures the defect: with a point sun the apex pinches as 2·tan(elev)·θ_hm', () => {
    for (const a2 of SIGMAS) {
      const thm = Math.atan(Math.sqrt(a2 * Math.LN2));
      for (const e of [1, 2, 5, 10]) {
        const w = apexHalfWidth(point(a2), e * D2R);
        // the small-angle limit; within 10% even at the swell's σ (θ_hm 11.6°)
        const predicted = 2 * Math.tan(e * D2R) * thm;
        expect(Math.abs(w - predicted) / predicted).toBeLessThan(0.1);
      }
      // and below ~5° that is narrower than the drawn disc itself
      expect(apexHalfWidth(point(a2), 2 * D2R)).toBeLessThan(skyParams.sunDiscSize * D2R);
    }
  });

  it('apex half-width ≥ disc + glare at every elevation, both sea states', () => {
    for (const a2 of SIGMAS) {
      for (let e = 0; e <= 90; e += 3) {
        expect(apexHalfWidth(area(a2), e * D2R)).toBeGreaterThanOrEqual(R_SRC * 0.999);
      }
    }
    // and the horizon bar is at least twice the drawn disc (T110 acceptance)
    expect(apexHalfWidth(area(0.003), 0)).toBeGreaterThanOrEqual(2 * skyParams.sunDiscSize * D2R);
  });

  it('projected on the water the road is monotone non-increasing in width with elevation', () => {
    // ground half-width at the apex, per metre of eye height: the point at
    // depression = elev and bearing φ lies sin(φ)/tan(elev) to the side
    for (const a2 of SIGMAS) {
      let prev = Infinity;
      for (let e = 1; e <= 85; e += 2) {
        const w = Math.sin(apexHalfWidth(area(a2), e * D2R)) / Math.tan(e * D2R);
        // 1%: the half-max search on a clamped plateau carries ~0.1% noise
        expect(w).toBeLessThanOrEqual(prev * 1.01);
        prev = w;
      }
    }
  });

  it('at 60° the daytime look survives: same energy, wider by exactly the source', () => {
    // BASELINE, pinned from the pre-change mirror (point sun, σ² = 0.003):
    // apex half-width 9.09° at 60°. Pinned so a drift in the point lobe and
    // a drift in the widening cannot mask each other.
    const OLD_60 = 9.09 * D2R;
    const p = apexHalfWidth(point(0.003), 60 * D2R);
    expect(Math.abs(p - OLD_60) / OLD_60).toBeLessThan(0.02);
    // the disc's image at 60° spans r/cos(60°) in bearing — the widening is
    // the source's own footprint and nothing else (within 10%)
    const a = apexHalfWidth(area(0.003), 60 * D2R);
    expect(Math.abs(a - p - R_SRC / Math.cos(60 * D2R)) / (R_SRC / Math.cos(60 * D2R))).toBeLessThan(0.1);
    // and the lobe's ENERGY at 60° is within 10% of the point lobe's: the
    // source redistributes the sun's light, it does not add any
    for (const a2 of SIGMAS) {
      const ratio = energy(area(a2), 60 * D2R) / energy(point(a2), 60 * D2R);
      expect(ratio).toBeGreaterThan(0.9);
      expect(ratio).toBeLessThan(1.1);
    }
  });

  it('is bounded at source (§V44): no pixel exceeds the point lobe\'s peak, albedo ≤ 1', () => {
    for (const a2 of SIGMAS) {
      const peakPoint = beckmann(1, a2); // D's own maximum, 1/(πσ²)
      for (const e of [0, 1, 5, 30, 60, 89]) {
        const L = sunDir(e * D2R);
        for (let th = 0.5; th < 90; th += 3) {
          for (let ph = 0; ph < 180; ph += 7) {
            const V = viewDir(th * D2R, ph * D2R);
            const vPt = roadPoint(V, L, a2);
            const vAr = roadArea(V, L, a2, SRC[0], SRC[1]);
            // the widened lobe's NDF × k never exceeds D's own peak (k ≤ 1)
            expect(areaNdfK(V, L, a2)).toBeLessThanOrEqual(peakPoint * (1 + 1e-9));
            expect(Number.isFinite(vPt) && Number.isFinite(vAr)).toBe(true);
            expect(vAr).toBeGreaterThanOrEqual(0);
          }
        }
        // ∫ L cos dω ≤ E = π·lightGain in these units: albedo ≤ 1
        expect(energy(area(a2), e * D2R, 60)).toBeLessThanOrEqual(Math.PI * sp.lightGain);
      }
    }
  });

  it('is NaN-safe at elev 0, 90, −10 and for garbage source params (§V28)', () => {
    for (const e of [0, 90, -10]) {
      for (const a2 of SIGMAS) {
        expect(Number.isFinite(apexHalfWidth(area(a2), e * D2R))).toBe(true);
        const v = roadArea(viewDir(0.3, 0.1), sunDir(e * D2R), a2, SRC[0], SRC[1]);
        expect(Number.isFinite(v)).toBe(true);
      }
    }
    for (const bad of [NaN, -5, Infinity]) {
      const v = sunSourceVector(bad, bad, bad);
      expect(v.every(Number.isFinite)).toBe(true);
      expect(v[3]).toBeGreaterThan(v[2]); // gate edges stay ordered
    }
  });

  it('is deterministic', () => {
    const a = roadArea(viewDir(0.2, 0.05), sunDir(0.1), 0.01, SRC[0], SRC[1]);
    const b = roadArea(viewDir(0.2, 0.05), sunDir(0.1), 0.01, SRC[0], SRC[1]);
    expect(a).toBe(b);
  });

  it('the road\'s horizon gate is the disc\'s gate (§T108): set at −(r+margin), clear at +r', () => {
    const r = skyParams.sunDiscSize * D2R;
    const m = skyParams.bodyHorizonMargin * D2R;
    expect(SRC[2]).toBeCloseTo(-Math.sin(r + m), 6);
    expect(SRC[3]).toBeCloseTo(Math.sin(r), 6);
    // a half-set sun still lights the water: for a sun centred ON the horizon
    // the representative point sits on the UPPER rim — above the sea, within
    // the source radius — so the road's N·L is the rim's, not the centre's 0
    const L = sunDir(0);
    const V = viewDir(1 * D2R, 0);
    const R: V3 = [-V[0], V[1], -V[2]];
    const toRay = add(mul(R, dot(R, L)), mul(L, -1));
    const Lp = norm(add(L, mul(toRay, Math.min(1, SRC[0] / Math.max(Math.hypot(...toRay), 1e-6)))));
    expect(Lp[1]).toBeGreaterThan(0);
    expect(Lp[1]).toBeLessThanOrEqual(Math.sin(R_SRC) + 1e-9);
  });
});

describe('§V92 god rays fan from the disc, not the centre pixel', () => {
  const fov = 55;
  const aspect = 16 / 9;
  const discUv = Math.tan(skyParams.sunDiscSize * D2R) / (2 * Math.tan((fov * D2R) / 2));

  it('source radius ≥ the projected disc radius, everywhere in the frame', () => {
    const deg =
      (skyParams.sunDiscSize + skyParams.sunGlareRadiusDeg) * postParams.godRaySourceRadiusScale;
    for (const facing of [1, 0.95, 0.8, 0.6]) {
      const r = projectedSourceRadius(deg, fov, aspect, facing);
      expect(r.y).toBeGreaterThanOrEqual(discUv);
      expect(r.x).toBeCloseTo(r.y / aspect, 9); // round on screen
      expect(r.y).toBeLessThanOrEqual(0.5);
    }
    // off-axis the disc projects LARGER, never smaller
    expect(projectedSourceRadius(deg, fov, aspect, 0.8).y).toBeGreaterThan(
      projectedSourceRadius(deg, fov, aspect, 1).y,
    );
  });

  it('is 0 below the horizon gate and 1 once the disc has cleared', () => {
    const r = skyParams.sunDiscSize * D2R;
    const m = skyParams.bodyHorizonMargin * D2R;
    expect(sourceHorizonGate(Math.sin(-(r + m)))).toBe(0);
    expect(sourceHorizonGate(Math.sin(-10 * D2R))).toBe(0);
    expect(sourceHorizonGate(-1)).toBe(0);
    expect(sourceHorizonGate(Math.sin(r))).toBe(1);
    expect(sourceHorizonGate(1)).toBe(1);
    const mid = sourceHorizonGate(0);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
  });

  it('is NaN-safe and deterministic', () => {
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(Number.isFinite(sourceHorizonGate(bad))).toBe(true);
      const r = projectedSourceRadius(bad, bad, bad, bad);
      expect(Number.isFinite(r.x) && Number.isFinite(r.y)).toBe(true);
    }
    expect(projectedSourceRadius(2.6, fov, aspect, 0.9)).toEqual(
      projectedSourceRadius(2.6, fov, aspect, 0.9),
    );
  });

  it('the knobs drive something (§V62) and are on the panel (§V16)', () => {
    // the ocean feeds the source every frame, from the sky params
    expect(oceanSurfaceSource).toContain('sunSourceUniform.value.set(');
    expect(oceanSurfaceSource).toContain('skyParams.sunGlareRadiusDeg');
    // the road reads the representative point, gated on its own edges
    expect(surfaceMaterialSource).toContain('const srcHalf = normalize(viewDir.add(srcDir))');
    expect(surfaceMaterialSource).toContain('.mul(srcEnergy)');
    expect(surfaceMaterialSource).toContain('road.mul(roadGate)');
    // the god rays: origins on the disc, gated, radius refreshed per frame
    expect(godRaysSource).toContain('uSrcRadius.value.set(sr.x, sr.y)');
    expect(godRaysSource).toContain('sunState.vis * sourceHorizonGate(dir.y)');
    expect(godRaysSource).toContain('for (let s = 0; s < SRC_TAPS; s++)');
    for (const [entry, key] of [
      ['sky', 'sunGlareRadiusDeg'],
      ['post', 'godRaySourceRadiusScale'],
      ['post', 'godRaySourceTaps'],
    ] as const) {
      const e = getParamsEntry(entry);
      expect(e, entry).toBeDefined();
      expect(e!.params).toHaveProperty(key);
      expect(e!.meta).toHaveProperty(key);
    }
  });
});
