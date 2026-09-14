import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { nightWindGate, windLineNightAmp, windLineNightWhiteness, windLineWeight } from '../src/sky/windLines';
import { skyParams } from '../src/params/sky';
import { keyLight } from '../src/sky/moonCycle';
import { skyPalette, skyTint } from '../src/sky/sunCycle';
import { MOONLIT_NIGHT, applyNightPreset } from '../src/sky/nightPreset';

describe('night wind wisps', () => {
  it('retains one third of the hashed population while preserving daylight', () => {
    const gate=0.75, count=30000;
    const nightGate=nightWindGate(gate,1,skyParams.windLineNightDensity);
    let day=0,night=0;
    for(let i=0;i<count;i++) {
      const hash=(i+.5)/count;
      if(windLineWeight(hash,gate,1.5)>1e-8)day++;
      if(windLineWeight(hash,nightGate,1.5)>1e-8)night++;
    }
    expect(night/day).toBeCloseTo(1/3,3);
    expect(nightWindGate(gate,0,skyParams.windLineNightDensity)).toBe(gate);
    expect(night).toBeGreaterThan(0);
    expect(skyParams.windLineNightDim).toBeGreaterThan(0);
  });
  /**
   * WHY (trailer final look review): the amplitude dim alone left "white scratches" in every night sky. The streak was
   * lifted 65% toward absolute white, a daylight-sized radiance, while the moonlit sky it is drawn on is ~1% of noon.
   * Measured against the sky the streak sits on (the resolved zenith, sky/skyBackground.ts `tinted(pal.zenith, tint)`),
   * a night streak's peak must be a faint trace, and a day streak must be exactly what was signed off.
   */
  it('a night streak is a trace against the moonlit sky it is drawn on; day streaks are unchanged', () => {
    const lum = (c: THREE.Color): number => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    const streakToZenith = (tod: number, night: boolean): number => {
      const p = structuredClone(skyParams);
      applyNightPreset(night, p);
      const key = keyLight(tod, p);
      const pal = skyPalette(key.sunElevation, p);
      const tint = skyTint(key.sunElevation, key.moonWeight);
      const srgb = (c: readonly number[]) => new THREE.Color().setRGB(c[0] * tint[0], c[1] * tint[1], c[2] * tint[2], THREE.SRGBColorSpace);
      const haze = srgb(pal.horizon);
      const streak = haze.clone().lerp(new THREE.Color(1, 1, 1), windLineNightWhiteness(p.windLineWhiteness, key.nightFactor));
      const out = (lum(streak) * windLineNightAmp(p.windLineBrightness, key.nightFactor, p.windLineNightDim)) / lum(srgb(pal.zenith));
      applyNightPreset(false, p);
      return out;
    };
    const night = streakToZenith(MOONLIT_NIGHT.timeOfDay, true);
    expect(night).toBeGreaterThan(0); // a trace, not deleted
    expect(night).toBeLessThan(0.02); // was 0.11 with the white lift: a visible white line on navy
    // day: the signed-off formula, bit for bit (night factor 0)
    expect(windLineNightWhiteness(skyParams.windLineWhiteness, 0)).toBe(skyParams.windLineWhiteness);
    expect(windLineNightAmp(skyParams.windLineBrightness, 0, skyParams.windLineNightDim)).toBe(skyParams.windLineBrightness);
    expect(streakToZenith(12, false)).toBeGreaterThan(0.3);
    // through dusk the streak only ever fades
    let prev = Infinity;
    for (let n = 0; n <= 1.0001; n += 0.05) {
      const v = (0.5 + 0.5 * windLineNightWhiteness(0.65, n)) * windLineNightAmp(0.06, n, 0.035);
      expect(v).toBeLessThanOrEqual(prev);
      prev = v;
    }
  });
  it('thins continuously through dusk and does not revive calm-weather streaks', () => {
    let previous=1;
    for(let n=0;n<=1;n+=.01) {
      const gate=nightWindGate(.75,n,1/3);
      expect(gate).toBeLessThanOrEqual(previous);
      expect(previous-gate).toBeLessThan(.251);
      expect(nightWindGate(0,n,1/3)).toBe(0);
      previous=gate;
    }
  });
});
