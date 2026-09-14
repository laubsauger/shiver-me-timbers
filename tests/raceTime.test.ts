import { describe, expect, it } from 'vitest';
import { skyParams } from '../src/params/sky';
import { applyRaceTime, raceTimeHour } from '../src/speedboat/page/raceTime';

describe('race clock validation', () => {
  it('accepts clock hours and rejects overflowing minutes', () => {
    expect(raceTimeHour('06:30')).toBe(6.5);
    expect(raceTimeHour('0:00')).toBe(0);
    expect(raceTimeHour('23:59')).toBeCloseTo(23 + 59 / 60);
    for (const label of ['06:60', '06:90', '00:99', '24:00', '12:-1', '12:5', 'garbage']) {
      expect(raceTimeHour(label), label).toBeNull();
    }
  });

  it('invalid labels leave an active night preset and its restore state intact', () => {
    const sky = { ...skyParams, timeOfDay: 15, moonPhase: 0.17 };
    const original = { ...sky };
    try {
      applyRaceTime('Night', sky);
      const night = { ...sky };
      for (const label of ['garbage', '06:90', '24:00']) {
        applyRaceTime(label, sky);
        expect(sky).toEqual(night);
      }
      applyRaceTime('06:30', sky);
      expect(sky).toEqual({ ...original, timeOfDay: 6.5 });
    } finally {
      applyRaceTime('15:00', sky);
    }
  });
});
