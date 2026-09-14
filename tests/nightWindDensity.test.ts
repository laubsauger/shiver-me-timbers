import { describe, expect, it } from 'vitest';
import { nightWindGate, windLineWeight } from '../src/sky/windLines';
import { skyParams } from '../src/params/sky';

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
