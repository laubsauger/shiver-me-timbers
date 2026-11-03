/**
 * The distant storm (wandering/stormCell.ts; params distantStorm), the 2026-11-02 next-level review's move 4, phase 1:
 * "A shelf cloud stands on the horizon from c2, unremarked. In c4 the cell flickers silently inside itself, low on the
 * horizon. Each flash spits sferics into the dial's static … The cell clears just before the call." What has to hold
 * for it to support the radio story and stay bearable on a tilted, reflective dome:
 *
 *   - it stands where nothing else of the story is: off the sunset's road, clear of the Rose's stations and well away
 *     from the station that answers, and low (its top ~10° up: never a flash near the zenith);
 *   - it is there from c2 on and stays into c4's night (the user, at the 56e951c master, 2026-11-03: "maybe we keep the
 *     thunderstorm in the distance there for a while. It could look really cool at night"), and has gone before w1's
 *     dissolve: the night lifts into the island's morning with no storm in it;
 *   - the flicker sits from after the case has landed into the night, at most one flash per ~2 s, each a few soft
 *     pulses (no one-frame spike at 30 fps: a strobe on a reflective bowl), the same schedule on every machine;
 *   - no stroke falls in the radio's moments — the dial's wake, the calls, the answer and its pulses back, the
 *     cascade's landings (measured here from roseTraffic.ts and the ring's own arcs) — so a flash never steals a beat;
 *   - by night its light is held to what the eye's opening makes of it: never brighter on the screen than at dusk;
 *   - the dial stutters only while a flash spits into it, and is untouched otherwise.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  CASCADE_LANDINGS,
  CLEAR,
  FLASH_GAP,
  FLICKER,
  LIGHTNING_PEAK,
  STORM_BEARING,
  STORM_DIST,
  createDistantStorm,
  dialStutter,
  lightningAt,
  lightningGain,
  radioMoments,
  pulseShape,
  sfericsAt,
  stormFlashes,
  stormPresence,
} from '../src/drift/wandering/stormCell';
import { C1_FOLLOW, beatStarts, spec } from '../src/drift/wandering/beats';
import { ANSWER_AT, CALL, CASCADE, FLASH, WAKE_FROM, callPulses, cascadeTraffic, roseLinks } from '../src/drift/wandering/roseTraffic';
import { STATIONS, arcDegrees } from '../src/drift/wandering/props';
import { FILM_RING } from '../src/drift/wandering/radioTower';
import { stationOf } from '../src/radio/network';
import { lampOverFoot } from '../src/radio/mast';
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
  it('stays whole into the night, past the answer and most of the cascade', () => {
    for (let t = starts.c4; t < starts.c4 + CLEAR[0]; t += 0.5) expect(stormPresence(t, starts)).toBeCloseTo(1, 6);
    expect(CLEAR[0]).toBeGreaterThan(ANSWER_AT + 20);
  });
  it('has gone before w1\'s dissolve begins, and stays gone over the coast', () => {
    const dissolve = starts.w1 - spec('w1')!.dissolve / 2;
    expect(starts.c4 + CLEAR[1]).toBeLessThanOrEqual(dissolve - 5);
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
  it('sits after the case has landed and runs into the night, a flash every few seconds, done before the storm is', () => {
    expect(flashes[0].t).toBeGreaterThan(starts.c3 + FLIP_AT_T + 1.5);
    // some at dusk, and the night's: several after the dial has woken
    expect(flashes.filter((f) => f.t < starts.c4).length).toBeGreaterThanOrEqual(4);
    expect(flashes.filter((f) => f.t > starts.c4 + CALL.dial).length).toBeGreaterThanOrEqual(5);
    for (const f of flashes) expect(f.t).toBeLessThanOrEqual(starts.c4 + FLICKER[1]);
    // nothing lit once the cell has gone
    for (let t = starts.c4 + CLEAR[1]; t < starts.w1; t += 1 / 30) expect(lightningAt(t, flashes)).toHaveLength(0);
    // at most one flash per ~2 s (the review's comfort rule)
    for (let i = 1; i < flashes.length; i++) expect(flashes[i].t - flashes[i - 1].t).toBeGreaterThanOrEqual(FLASH_GAP[0] - 1e-9);
  });
  it('never strikes in the radio\'s moments: the dial waking, the calls, the answer, the cascade landing', () => {
    // the moments, measured here, not read back from stormCell.ts: the dial's crackle peak; each of our calls' pulses
    // while it leaves; the answer's flashes and its pulses back to us, to their arrival; the cascade's every landing,
    // on the ring's own raised arcs (as tests/radioStory.test.ts lays them)
    const C4 = starts.c4;
    const lamps = STATIONS.map((b, i) => {
      const r = (b * Math.PI) / 180;
      return new THREE.Vector3(7000 * Math.sin(r), 3 + lampOverFoot(stationOf(FILM_RING[i]).mast) - 2.2, -7000 * Math.cos(r));
    });
    const links = roseLinks(STATIONS.length);
    const arcs = links.map(([a, b]) => arcDegrees(lamps[a], lamps[b], CASCADE.lift));
    const landings = cascadeTraffic(C4, links, arcs, STATIONS.length).messages.map((m) => m.t0 + m.dur - C4).sort((a, b) => a - b);
    // (stormCell.ts keeps the landings as numbers: they have to be the cascade's)
    expect(landings).toHaveLength(CASCADE_LANDINGS.length);
    [...CASCADE_LANDINGS].sort((a, b) => a - b).forEach((l, i) => expect(l).toBeCloseTo(landings[i], 1));
    const quiet: Array<[number, number]> = [[CALL.dial - 0.5, CALL.dial + 0.5]];
    for (const p of callPulses(C4)) quiet.push([p.t0 - C4, p.t0 - C4 + p.hold + FLASH.fall + (p.back ? CALL.travel : 0)]);
    quiet.push([ANSWER_AT - FLASH.rise, ANSWER_AT + 3.5]);
    for (const l of landings) quiet.push([l - 0.5, l + 0.5]);
    for (const [a, b] of quiet) for (let x = a; x <= b; x += 1 / 60) expect(lightningAt(C4 + x, flashes)).toHaveLength(0);
    // (and stormCell.ts' own list covers every one of them)
    const own = radioMoments();
    for (const [a, b] of quiet) expect(own.some(([c, d]) => c <= a + 1e-6 && d >= b - 1e-6)).toBe(true);
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
    for (let t = starts.c3; t < starts.c4 + FLICKER[1] + 2; t += 1 / 60) for (const l of lightningAt(t, flashes)) expect(l.light).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('by night is no brighter on the screen than at dusk, though the eye opens ~7× on the dark', () => {
    // (the screen's level: the radiance × the eye's exposure — seaSky.ts adaptation, ~2.1 at the dusk, 14 at night)
    const screen = (e: number): number => lightningGain(e) * e;
    expect(lightningGain(1.5)).toBe(1);
    for (let e = 2.1; e <= 14; e += 0.1) expect(screen(e)).toBeLessThanOrEqual(screen(2.1) + 1e-9);
    // the night's a little under the dusk's (it reads against black), and falling smoothly, never stepped
    expect(screen(14) / screen(2.1)).toBeGreaterThan(0.4);
    expect(screen(14) / screen(2.1)).toBeLessThan(0.7);
    for (let e = 2.1; e < 14; e += 0.05) expect(Math.abs(screen(e + 0.05) - screen(e))).toBeLessThan(0.02);
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
  it('the dial takes the night\'s flashes: the radio is lit from c4 − 2 s (props.ts), and they fall in the waits', () => {
    expect(flashes.filter((f) => f.t > starts.c4 - 2 + 0.5).length).toBeGreaterThanOrEqual(5);
  });
});
