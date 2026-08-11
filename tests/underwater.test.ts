/**
 * Underwater submersion logic tests (§V25). WHY these matter: the underwater
 * grade is a fullscreen effect — any discontinuity in mode or blend is an
 * instant whole-screen flash. Wave chop makes the waterline oscillate around
 * the camera every frame, so the hysteresis band and the rate-limited blend
 * are the only things standing between "cinematic crossing" and a strobing
 * screen. These tests pin the pure math down so the GPU side can trust it.
 */
import { describe, expect, it } from 'vitest';
import {
  expFogFactor,
  smooth01,
  submersionState,
  type SubmersionState,
} from '../src/underwater/submersion';
import { underwaterParams } from '../src/params/underwater';
import { getParamsEntry } from '../src/params/registry';

const cfg = { hysteresisBand: 0.5, maxBlendStep: 0.1 };

function run(
  ys: number[],
  waterH = 0,
  c = cfg,
): SubmersionState[] {
  const out: SubmersionState[] = [];
  let prev: SubmersionState | undefined;
  for (const y of ys) {
    prev = submersionState(y, waterH, prev, c);
    out.push(prev);
  }
  return out;
}

describe('submersion hysteresis (chop must not strobe the effect)', () => {
  it('camera clearly above → above, clearly below → below', () => {
    expect(submersionState(5, 0, undefined, cfg).mode).toBe('above');
    expect(submersionState(-5, 0, undefined, cfg).mode).toBe('below');
    expect(submersionState(5, 0, undefined, cfg).blend).toBe(0);
    expect(submersionState(-5, 0, undefined, cfg).blend).toBe(1);
  });

  it('chop oscillating INSIDE the band keeps mode stable at crossing — the grade never flips hard above/below', () => {
    // ±0.2m around the waterline, band is 0.5m (half = 0.25)
    const ys = Array.from({ length: 60 }, (_, i) => 0.2 * Math.sin(i * 1.7));
    const states = run(ys);
    for (const s of states) expect(s.mode).toBe('crossing');
  });

  it('swings BEYOND the band do flip the mode (effect must engage)', () => {
    const states = run([1, -1, 1, -1]);
    expect(states.map((s) => s.mode)).toEqual([
      'above',
      'below',
      'above',
      'below',
    ]);
  });

  it('band boundary is exclusive: exactly at ±band/2 still counts as crossing', () => {
    expect(submersionState(0.25, 0, undefined, cfg).mode).toBe('crossing');
    expect(submersionState(-0.25, 0, undefined, cfg).mode).toBe('crossing');
  });

  it('waterHeight shifts the band with the sea — same logic off y=0', () => {
    expect(submersionState(10.4, 10.3, undefined, cfg).mode).toBe('crossing');
    expect(submersionState(11, 10.3, undefined, cfg).mode).toBe('above');
    expect(submersionState(9, 10.3, undefined, cfg).mode).toBe('below');
  });
});

describe('blend continuity (V25: no pop — fullscreen effect must fade)', () => {
  it('never jumps more than maxBlendStep per tick, even on a teleport', () => {
    let prev = submersionState(5, 0, undefined, cfg); // fully above
    // teleport deep underwater and hold
    for (let i = 0; i < 30; i++) {
      const next = submersionState(-20, 0, prev, cfg);
      expect(Math.abs(next.blend - prev.blend)).toBeLessThanOrEqual(
        cfg.maxBlendStep + 1e-12,
      );
      prev = next;
    }
    expect(prev.blend).toBeCloseTo(1, 10); // and it does arrive
  });

  it('blend stays in [0,1] and tracks depth monotonically through the band', () => {
    let prev: SubmersionState | undefined;
    let last = 0;
    // slow descent through the band: blend must only ever increase
    for (let y = 0.4; y >= -0.4; y -= 0.01) {
      prev = submersionState(y, 0, prev, cfg);
      expect(prev.blend).toBeGreaterThanOrEqual(last);
      expect(prev.blend).toBeGreaterThanOrEqual(0);
      expect(prev.blend).toBeLessThanOrEqual(1);
      last = prev.blend;
    }
  });

  it('smooth01 is the hermite ramp the crossing fade relies on', () => {
    expect(smooth01(-1, 1, -1)).toBe(0);
    expect(smooth01(-1, 1, 0)).toBeCloseTo(0.5, 10);
    expect(smooth01(-1, 1, 1)).toBe(1);
  });
});

describe('fog falloff math (mirrors the TSL exp fog in underwaterGrade)', () => {
  it('is strictly monotonic in distance — nearer is always clearer', () => {
    let last = -1;
    for (let d = 0; d <= 200; d += 5) {
      const f = expFogFactor(d, 0.045);
      expect(f).toBeGreaterThan(last);
      last = f;
    }
  });

  it('is bounded [0,1): fog can approach but never exceed full occlusion', () => {
    expect(expFogFactor(0, 0.045)).toBe(0);
    expect(expFogFactor(1e6, 0.045)).toBeLessThanOrEqual(1);
    expect(expFogFactor(1e6, 0.045)).toBeGreaterThan(0.999);
  });

  it('higher density fogs more at equal distance (storm water reads murkier)', () => {
    expect(expFogFactor(20, 0.1)).toBeGreaterThan(expFogFactor(20, 0.02));
  });

  it('clamps negative inputs instead of exploding (bad heightFn data)', () => {
    expect(expFogFactor(-5, 0.045)).toBe(0);
    expect(expFogFactor(10, -1)).toBe(0);
  });
});

describe('underwater params (V16: registered, clamped, sane)', () => {
  it('registers under "underwater" so Tweakpane auto-binds it', () => {
    const entry = getParamsEntry('underwater');
    expect(entry).toBeDefined();
    expect(entry!.params).toBe(underwaterParams);
  });

  it('every numeric default sits inside its own declared meta clamp', () => {
    const entry = getParamsEntry('underwater')!;
    for (const [key, meta] of Object.entries(entry.meta)) {
      const v = entry.params[key] as number;
      if (meta.min !== undefined) expect(v).toBeGreaterThanOrEqual(meta.min);
      if (meta.max !== undefined) expect(v).toBeLessThanOrEqual(meta.max);
    }
  });

  it('hysteresis band and blend step are positive — zero would freeze the fade', () => {
    expect(underwaterParams.hysteresisBand).toBeGreaterThan(0);
    expect(underwaterParams.maxBlendStep).toBeGreaterThan(0);
  });

  it('shader-build-time params are usable integer counts', () => {
    expect(Number.isInteger(underwaterParams.rayTaps)).toBe(true);
    expect(Number.isInteger(underwaterParams.waterlineSamples)).toBe(true);
    expect(underwaterParams.waterlineSamples).toBeGreaterThanOrEqual(2);
  });
});
