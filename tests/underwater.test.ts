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
  smooth01,
  submersionState,
  type SubmersionState,
} from '../src/underwater/submersion';
import { submergedFraction, transmittance } from '../src/underwater/waterVolume';
import { underwaterParams } from '../src/params/underwater';
import { causticsParams } from '../src/params/caustics';
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

/**
 * The submerged FRACTION is what makes the waterline split a split rather than
 * a full-screen filter: at the crossing the camera sits on the surface and the
 * same frame contains rays that are entirely in air and rays that are entirely
 * in water. A single submersion scalar cannot say that; this can.
 */
describe('submerged path fraction (the meridian, mirrors waterVolume.ts)', () => {
  it('both ends under → the whole ray is in water, in either order', () => {
    // order-independence is the property the branchless form BUYS us: the
    // fraction of a segment under a plane cannot depend on which end you
    // walk from, and the min/max form encodes exactly that.
    expect(submergedFraction(-5, -1)).toBe(1);
    expect(submergedFraction(-1, -5)).toBe(1);
  });

  it('both ends above → no water on the path at all (above-water frames are untouched)', () => {
    expect(submergedFraction(1, 5)).toBe(0);
    expect(submergedFraction(5, 1)).toBe(0);
  });

  it('a crossing ray splits at the plane, symmetrically', () => {
    // camera under / fragment above, and the mirror case: both are half water
    expect(submergedFraction(-1, 1)).toBeCloseTo(0.5, 12);
    expect(submergedFraction(1, -1)).toBeCloseTo(0.5, 12);
    // a shallow camera looking at something deep is mostly water
    expect(submergedFraction(-3, 1)).toBeCloseTo(0.75, 12);
  });

  it('the HORIZONTAL ray resolves through the floored divisor, not in spite of it', () => {
    // a == b makes the denominator zero. §V.28 floors it, and the sign of
    // -min then carries the answer to the correct saturated end. This is the
    // case that fires across the whole horizon band while swimming level, so
    // getting it wrong is a full-screen artifact, not an edge case.
    expect(submergedFraction(-2, -2)).toBe(1);
    expect(submergedFraction(2, 2)).toBe(0);
    expect(submergedFraction(0, 0)).toBe(0);
  });

  it('is bounded [0,1] for absurd inputs (a bad heightFn must not blow the frame)', () => {
    for (const [a, b] of [[-1e9, 1e9], [1e9, -1e9], [-1e-9, 1e-9], [0, -1e9]]) {
      const f = submergedFraction(a, b);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
  });
});

describe('aquatic perspective (Beer–Lambert on the SHARED Jerlov coefficients)', () => {
  const { submergedAbsorptionR: KR, submergedAbsorptionG: KG, submergedAbsorptionB: KB } =
    causticsParams;

  it('red dies first — the defining fact of looking through water', () => {
    // At 10 m the ordering must be strict, not merely "tinted": this is the
    // reason a submerged hull reads blue-green instead of grey.
    const r = transmittance(KR, 10);
    const g = transmittance(KG, 10);
    const b = transmittance(KB, 10);
    expect(r).toBeLessThan(g);
    expect(g).toBeLessThan(b);
    // and red must be substantially GONE, not just reduced
    expect(r).toBeLessThan(0.05);
    expect(b).toBeGreaterThan(0.5);
  });

  it('closes the horizon on its own — §V.30 stops applying under the surface', () => {
    // The visibility limit is not a separate far-clip or fog wall; it is the
    // same exponential. Nothing survives 4 km of water in ANY channel.
    expect(transmittance(KB, 4000)).toBeLessThan(1e-6);
    // and the useful range is tens of metres, not kilometres
    expect(transmittance(KB, 150)).toBeLessThan(0.02);
  });

  it('murkiness scales all three channels together (a water TYPE, not a new set)', () => {
    // The whole point of the scalar: it may not re-order the channels, or it
    // would be authoring a second absorption vector by the back door.
    const murk = 3;
    expect(transmittance(KR, 5, murk)).toBeLessThan(transmittance(KR, 5, 1));
    expect(transmittance(KR, 5, murk)).toBeLessThan(transmittance(KG, 5, murk));
    expect(transmittance(KG, 5, murk)).toBeLessThan(transmittance(KB, 5, murk));
  });

  it('is the identity at zero path length — above water costs nothing', () => {
    expect(transmittance(KR, 0)).toBe(1);
    expect(transmittance(KG, 0)).toBe(1);
    expect(transmittance(KB, 0)).toBe(1);
  });

  it('clamps negative inputs instead of exploding (bad heightFn / camera data)', () => {
    // a negative length through exp() would AMPLIFY, i.e. an unbounded
    // additive-looking term in a multiply slot (§V.44).
    expect(transmittance(KR, -50)).toBe(1);
    expect(transmittance(-1, 50)).toBe(1);
    expect(transmittance(KR, 50, -2)).toBe(1);
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
