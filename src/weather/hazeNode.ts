/**
 * TSL node pack for the §V47 sun-anisotropic haze — the GPU mirror of
 * ./haze.ts, kept in a SEPARATE module so src/weather/index.ts stays free of
 * three imports (the weather field is pure sim math and is unit-tested in node).
 *
 * OWNERSHIP: src/sky/** owns the fog and the sky material. This is the piece
 * §V47 asks for, handed over as nodes to drop into whatever the sky already
 * multiplies its haze by:
 *
 *   const haze = createStormHaze();
 *   // per frame, from the localised field at the camera (§V46):
 *   haze.update(weather.weatherAt(camX, camZ).storm);
 *
 *   // in the sky/fog graph, with a NORMALIZED world-space view direction:
 *   const scale = haze.densityScale(viewDir, sunDirNode);   // multiply haze by
 *   const lit   = haze.litWeight(viewDir, sunDirNode);      // 0..1 colour mix
 *   hazeAmount = baseHazeStrength.mul(scale);
 *   hazeColor  = mix(hazeShadowColor, hazeSunColor, lit);   // §V23 functional
 *
 * Both outputs are bounded at source: `densityScale` is a mix of two
 * non-negative param multipliers (never an addend — §V44) and `litWeight` is a
 * clamped 0..1. Nothing here can drive a light slot negative or unbounded.
 */
import { clamp, float, mix, uniform } from 'three/tsl';
import { MAX_ANISOTROPY } from './haze';
import { weatherParams } from '../params/weather';

const fin = (v: number, fallback: number): number =>
  Number.isFinite(v) ? v : fallback;

export function createStormHaze() {
  const uG = uniform(0);
  const uAway = uniform(1);
  const uSun = uniform(1);
  const uWeight = uniform(0);

  /**
   * Normalised Henyey-Greenstein, 1 along the sun vector. `viewDir` and
   * `sunDir` must both be normalized; the dot is clamped so a de-normalized
   * input cannot push the phase denominator out of range.
   */
  const aniso = (viewDir: any, sunDir: any): any => {
    const mu = clamp(viewDir.dot(sunDir), -1, 1);
    const num = uG.oneMinus().mul(uG.oneMinus());
    // ≥ (1−g)² by construction with g ≤ 0.95; floored regardless (§V28)
    const den = float(1).add(uG.mul(uG)).sub(uG.mul(mu).mul(2)).max(1e-4);
    // §V44/§B15: the RESULT is bounded, not merely the divisor — the
    // normalisation caps this at 1 analytically and the clamp proves it
    return clamp(num.div(den).pow(1.5), 0, 1);
  };

  return {
    /** anisotropy itself, 0..1 — 1 looking along the sun vector */
    anisotropy: aniso,

    /** multiply the sky's haze strength / fog density by this node */
    densityScale(viewDir: any, sunDir: any): any {
      // away (aniso 0) → uAway (>1, thicker), along the sun → uSun (<1, thinner)
      const raw = mix(uAway, uSun, aniso(viewDir, sunDir)); // §V23 functional
      // storm weight 0 ⇒ exactly 1 ⇒ the sky renders as it does today (§V7)
      return mix(float(1), raw, uWeight);
    },

    /** 0..1 — how sunlit the haze colour should read along this ray */
    litWeight(viewDir: any, sunDir: any): any {
      return aniso(viewDir, sunDir).mul(uWeight);
    },

    /** push live params + the localised storm strength at the camera (§V46) */
    update(storm: number): void {
      uG.value = Math.min(
        Math.max(fin(weatherParams.hazeAnisotropy, 0), 0),
        MAX_ANISOTROPY,
      );
      uAway.value = Math.max(fin(weatherParams.hazeAwayMultiplier, 1), 0);
      uSun.value = Math.max(fin(weatherParams.hazeSunMultiplier, 1), 0);
      const s = Math.min(Math.max(fin(storm, 0), 0), 1);
      const w = Math.min(Math.max(fin(weatherParams.hazeStormWeight, 0), 0), 1);
      uWeight.value = s * w;
    },
  };
}

export type StormHaze = ReturnType<typeof createStormHaze>;
