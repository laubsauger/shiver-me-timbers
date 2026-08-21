/**
 * §B76 — a flag's ripple travels FROM the hoist TO the fly. The user read the
 * old wave as "starting from the tip away from the pole": the spatial term
 * was ADDED to the time phase, so crests ran inward. Same class of defect as
 * the wake's phase sign (commit e6740ae).
 */
import { describe, expect, it } from 'vitest';
import { flagRippleGrow, flagRipplePhase } from '../src/ship/flagDynamics';
import flagMaterialSource from '../src/ship/flagMaterial.ts?raw';

describe('§B76 flag ripple direction', () => {
  it('crest velocity is hoist → fly: ∂φ/∂t > 0 and ∂φ/∂u < 0 for every wave count', () => {
    for (const count of [1, 2.5, 4]) {
      const dt = flagRipplePhase(0.3, 1.0, count) - flagRipplePhase(0.3, 0.0, count);
      const du = flagRipplePhase(0.4, 1.0, count) - flagRipplePhase(0.3, 1.0, count);
      expect(dt).toBeGreaterThan(0);
      expect(du).toBeLessThan(0);
      // the crest that was at u0 at phase P is at u0 + Δ at phase P + ΔP, Δ > 0
      const crestAt = (P: number): number => P / (count * 2 * Math.PI);
      expect(crestAt(2) - crestAt(1)).toBeGreaterThan(0);
    }
  });

  it('amplitude is 0 at the hoist and grows monotonically to the fly', () => {
    expect(flagRippleGrow(0)).toBe(0);
    expect(flagRippleGrow(1)).toBeCloseTo(1, 9);
    let prev = 0;
    for (let i = 1; i <= 20; i++) {
      const g = flagRippleGrow(i / 20);
      expect(g).toBeGreaterThan(prev);
      prev = g;
    }
  });

  it('the GPU cloth subtracts the spatial term from the integrated phase — the CPU mirror\'s sign', () => {
    // the shader cannot call the JS helper; the sign is the whole bug, so it is
    // pinned in the source: the carrier and the crack both SUBTRACT `spatial`
    expect(flagMaterialSource).toMatch(/uWavePhase\.add\(phase\)\.sub\(spatial\)/);
    expect(flagMaterialSource).toMatch(/\.sub\(spatial\.mul\(FLAG_CRACK_RATIO\)\)/);
    expect(flagMaterialSource).not.toMatch(/\.add\(spatial\)/);
    expect(flagMaterialSource).toMatch(/u\.mul\(0\.4\)\.add\(u\.mul\(u\)\.mul\(0\.6\)\)/); // flagRippleGrow
  });
});
