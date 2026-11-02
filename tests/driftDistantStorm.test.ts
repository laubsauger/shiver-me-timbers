/**
 * The distant storm (wandering/stormCell.ts; params distantStorm), the 2026-11-02 next-level review's move 4, phase 1:
 * "A shelf cloud stands on the horizon from c2, unremarked. In c4 the cell flickers silently inside itself, low on the
 * horizon. Each flash spits sferics into the dial's static … The cell clears just before the call." What has to hold
 * for it to support the radio story and stay bearable on a tilted, reflective dome:
 *
 *   - it stands where nothing else of the story is: off the sunset's road, clear of the Rose's stations and well away
 *     from the station that answers, and low (its top ~10° up: never a flash near the zenith);
 *   - it is there from c2 on, and gone before the dial wakes (433 show s): the call goes out under a clear sky — the
 *     game's rule that the stations come through on a clear night;
 *   - the flicker sits from after the case has landed to before the dial wakes, at most one flash per ~2 s, each a few
 *     soft pulses (no one-frame spike at 30 fps: a strobe on a reflective bowl), the same schedule on every machine;
 *   - the dial stutters only while a flash spits into it, and is untouched otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLEAR,
  FLASH_GAP,
  FLICKER,
  LIGHTNING_PEAK,
  STORM_BEARING,
  STORM_DIST,
  createDistantStorm,
  dialStutter,
  lightningAt,
  pulseShape,
  sfericsAt,
  stormFlashes,
  stormPresence,
} from '../src/drift/wandering/stormCell';
import { C1_FOLLOW, beatStarts, spec } from '../src/drift/wandering/beats';
import { CALL, WAKE_FROM } from '../src/drift/wandering/roseTraffic';
import { STATIONS } from '../src/drift/wandering/props';
import { FLIP_AT_T } from '../src/drift/wandering/dolphin';
import { driftParams } from '../src/params/drift';

/** a c1End that puts c4 at 430.0 show s with the show's sea start (any works: everything is relative to the beats) */
const c1End = 50;
const { starts } = beatStarts(c1End);
const flashes = stormFlashes(starts.c4);
const R = 6.371e6;
const wasOn = driftParams.distantStorm;
afterEach(() => {
  driftParams.distantStorm = wasOn;
});

const angle = (a: number, b: number): number => Math.abs(((a - b + 540) % 360) - 180);

describe('distant storm: where it stands', () => {
  it('stands off the sunset road and clear of every station, far from the one that answers', () => {
    const sun = spec('c2')!.sunAz;
    // the Sun's road and its glare: the cell's light would be lost in it, and the c2 frames are composed on it
    expect(angle(STORM_BEARING, sun)).toBeGreaterThan(45);
    // its base (~±4.5° at 55 km) never stands behind a station's motu, where a flash would read as that station's lamp
    for (const s of STATIONS) expect(angle(STORM_BEARING, s)).toBeGreaterThan(10);
    // the answer comes from low ahead (−40°): nothing of the cell anywhere near it
    expect(angle(STORM_BEARING, STATIONS[WAKE_FROM])).toBeGreaterThan(60);
    // inside a row-8 seat's view (±68° in azimuth): the deliverable seat clip has to show it
    expect(angle(STORM_BEARING, 0)).toBeLessThan(55);
  });
  it('is low on the horizon: its top under ~14° (never near the zenith), its foot under the sea\'s curve', () => {
    const drop = (STORM_DIST * STORM_DIST) / (2 * R);
    const top = (Math.atan((12900 - drop) / STORM_DIST) * 180) / Math.PI;
    expect(top).toBeLessThan(14);
    expect(top).toBeGreaterThan(6);
    // the horizon hides its first few hundred metres: no rain reaches the eye's sea
    expect(drop).toBeGreaterThan(200);
  });
});

describe('distant storm: from c2 on, gone before the call', () => {
  it('is formed through c2 and c3 and absent before the follow', () => {
    expect(stormPresence(starts.c2 - C1_FOLLOW - 1, starts)).toBe(0);
    for (let t = starts.c2; t < starts.c4 + CLEAR[0]; t += 0.5) expect(stormPresence(t, starts)).toBeCloseTo(1, 6);
  });
  it('has cleared before the dial wakes, and stays gone through the night and the coast', () => {
    const dial = starts.c4 + CALL.dial;
    expect(starts.c4 + CLEAR[1]).toBeLessThan(dial);
    for (let t = starts.c4 + CLEAR[1]; t < starts.w6 + 60; t += 0.5) expect(stormPresence(t, starts)).toBe(0);
  });
  it('draws nothing when the param is off, even once built', () => {
    const storm = createDistantStorm(starts);
    driftParams.distantStorm = false;
    storm.update(flashes[1].t + 0.02);
    expect((storm.uniforms.presence as unknown as { value: number }).value).toBe(0);
    expect((storm.uniforms.aLight as unknown as { value: number }).value).toBe(0);
    driftParams.distantStorm = true;
    storm.update(flashes[1].t + 0.02);
    expect((storm.uniforms.aLight as unknown as { value: number }).value).toBeGreaterThan(0);
  });
});

describe('distant storm: the flicker', () => {
  it('is the same schedule every time (a pure function of the beats)', () => {
    expect(stormFlashes(starts.c4)).toEqual(flashes);
    // shifted with c4, unchanged in itself
    const later = stormFlashes(starts.c4 + 7);
    later.forEach((f, i) => expect(f.t - 7).toBeCloseTo(flashes[i].t, 9));
  });
  it('sits after the case has landed and ends before the dial wakes, a flash every few seconds', () => {
    expect(flashes.length).toBeGreaterThanOrEqual(4);
    expect(flashes[0].t).toBeGreaterThan(starts.c3 + FLIP_AT_T + 1.5);
    for (const f of flashes) expect(f.t).toBeLessThanOrEqual(starts.c4 + FLICKER[1]);
    // every pulse of the last flash has died out most of a second before the dial's own crackle peaks
    const last = flashes[flashes.length - 1];
    for (let t = starts.c4 + CALL.dial - 0.8; t < starts.c4 + CALL.dial + 30; t += 1 / 30) expect(lightningAt(t, flashes)).toHaveLength(0);
    expect(last.t).toBeLessThan(starts.c4 + CALL.dial - 1.5);
    // at most one flash per ~2 s (the review's comfort rule)
    for (let i = 1; i < flashes.length; i++) expect(flashes[i].t - flashes[i - 1].t).toBeGreaterThanOrEqual(FLASH_GAP[0] - 1e-9);
  });
  it('flickers in a few soft pulses, none of them a one-frame spike at 30 fps', () => {
    for (const f of flashes) {
      expect(f.pulses.length).toBeGreaterThanOrEqual(2);
      expect(f.pulses.length).toBeLessThanOrEqual(4);
      expect(f.peak).toBeLessThanOrEqual(1);
      for (const p of f.pulses) {
        // over half its peak for at least a frame and a half
        let above = 0;
        for (let x = 0; x < 1; x += 0.001) if (pulseShape(x, p.decay) > 0.5) above += 0.001;
        expect(above).toBeGreaterThan(1.5 / 30);
      }
    }
  });
  it('is dim: no lit channel brighter than LIGHTNING_PEAK, and the light grows with the storm, not past it', () => {
    expect(LIGHTNING_PEAK).toBeLessThanOrEqual(1);
    for (let t = starts.c3; t < starts.c4 + 5; t += 1 / 60) for (const l of lightningAt(t, flashes)) expect(l.light).toBeLessThanOrEqual(1 + 1e-9);
  });
});

describe('distant storm: the sferics on the dial', () => {
  it('leaves the dial alone between flashes and stutters it while one spits into the radio', () => {
    expect(dialStutter(flashes[0].t - 0.5, flashes)).toBe(1);
    expect(dialStutter(starts.c4 + CALL.dial, flashes)).toBe(1);
    // across the flashes the glow both jumps and cuts out (frame by frame at 30 fps)
    const seen: number[] = [];
    for (const f of flashes) for (let t = f.t; t < f.t + 0.6; t += 1 / 30) seen.push(dialStutter(t, flashes));
    expect(Math.max(...seen)).toBeGreaterThan(1.3);
    expect(Math.min(...seen)).toBeLessThan(0.7);
    // the radio hears even the faint first flash whole
    expect(Math.max(...[0, 0.03, 0.06].map((x) => sfericsAt(flashes[0].t + x, flashes)))).toBeGreaterThan(0.9);
  });
  it('the dial is lit for the last flash: the radio wakes from c4 − 2 s (props.ts), so it shows on the dial', () => {
    expect(flashes[flashes.length - 1].t).toBeGreaterThan(starts.c4 - 2 + 0.5);
  });
});
