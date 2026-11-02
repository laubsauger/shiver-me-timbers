/**
 * The radio story in Act 3 (the 2026-11-02 next-level review, drift-narrative/next-level-2026-11-02.md; roseTraffic.ts
 * CALL, CASCADE, ENDING, beats.ts POSE_KEYS_CALL, props.ts arcPoint's lift). What has to hold for it to read as "what
 * remained, calls, and is answered", and to be bearable on a tilted dome:
 *
 *   - the first call goes unanswered: nothing on the station ahead flares until our call sign comes back from it, on
 *     the music's step (447.93 show s, c4 starting at 430.0) — an answer before the step, or the Rose waking before
 *     the answer, is the 1.5 s wake the review cut;
 *   - the calls leave room for doubt (about 8 s between them), the second is shorter, and its pulse has arrived before
 *     the answer starts (an answer that leads the call reads as coincidence);
 *   - the answer repeats the first call's rhythm exactly (the "same rhythm" is the whole message);
 *   - nothing flashes faster than about once a second, and no flash edge is a cut (comfort);
 *   - the cascade puts one pulse in flight a side, every crossing ≥ 5 s, reaches every station, and has closed before
 *     c4's Rose starts going quiet (else the ring closes in the fade, unseen);
 *   - the raft's bow comes round to the station that answered while the eye's own pose is untouched;
 *   - the ending: our station speaks only once it is lit, the traffic ends converging on one station before the title,
 *     and the stranger comes after the title and before the last flare, which comes before the black.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  ANSWER_AT,
  ANSWER_TURN,
  CALL,
  CALLS,
  CALL_RHYTHM,
  CASCADE,
  ENDING,
  FLASH,
  WAKE_FROM,
  answerFlare,
  callLamp,
  callPulses,
  cascadeTraffic,
  endingTraffic,
  lastFlare,
  oursLit,
  receiver,
  roseLinks,
  sender,
  stationFlare,
  strangerPulse,
} from '../src/drift/wandering/roseTraffic';
import { BEATS, C1_FOLLOW, beatStarts, raftPose, type RaftPose } from '../src/drift/wandering/beats';
import { STATIONS, arcDegrees, arcPoint } from '../src/drift/wandering/props';
import { FILM_RING } from '../src/drift/wandering/radioTower';
import { stationOf } from '../src/radio/network';
import { lampOverFoot } from '../src/radio/mast';
import { driftParams } from '../src/params/drift';

/** show s c4 starts at (docs/drift/STATUS.md: C4 the network, 430 s) and the sea's clock under it */
const C4_SHOW = 430;
const c1End = 21 + C1_FOLLOW;
const { starts } = beatStarts(c1End);
const C4 = starts.c4;
const show = (t: number): number => t - C4 + C4_SHOW;
const N = STATIONS.length;
const links = roseLinks(N);
/** each station's lamp from the sea's eye (m): 7 km out at its bearing, its mast's lamp over a few metres of motu */
const lamps = STATIONS.map((b, i) => {
  const r = (b * Math.PI) / 180;
  return new THREE.Vector3(7000 * Math.sin(r), 3 + lampOverFoot(stationOf(FILM_RING[i]).mast) - 2.2, -7000 * Math.cos(r));
});
const arcRaised = links.map(([a, b]) => arcDegrees(lamps[a], lamps[b], CASCADE.lift));
const arcFlat = links.map(([a, b]) => arcDegrees(lamps[a], lamps[b]));
const el = (v: THREE.Vector3): number => (Math.asin(v.clone().normalize().y) * 180) / Math.PI;

describe('move 1: call, wait, answer (c4)', () => {
  it("answers on the music's step, and not a moment before", () => {
    // the answer's first flash peaks on the step (its rise FLASH.rise before)
    expect(show(C4 + ANSWER_AT)).toBeCloseTo(447.93, 2);
    expect(answerFlare(C4 + ANSWER_AT, C4)).toBeGreaterThan(1);
    expect(answerFlare(C4 + ANSWER_AT - FLASH.rise, C4)).toBe(0);
    // and the station ahead takes no Rose flare either until it has answered
    const { messages } = cascadeTraffic(C4, links, arcRaised, N);
    for (let t = C4; t < C4 + ANSWER_AT; t += 0.05) expect(stationFlare(t, WAKE_FROM, messages, links)).toBe(0);
  });

  it('leaves about 8 s between the calls, the second shorter, its pulse in before the answer', () => {
    const [first, second] = CALLS;
    expect(second.at - first.at).toBeGreaterThan(7);
    expect(second.at - first.at).toBeLessThan(11);
    expect(second.flashes.length).toBeLessThan(first.flashes.length);
    const [, p2] = callPulses(C4);
    const arrive = p2.t0 + p2.dur;
    expect(arrive).toBeLessThan(C4 + ANSWER_AT - FLASH.rise);
    expect(arrive).toBeGreaterThan(C4 + ANSWER_AT - FLASH.rise - 1.5);
    // the dial wakes before the first call
    expect(CALL.dial).toBeLessThan(first.at);
  });

  it('answers with exactly the first call’s rhythm', () => {
    const lead = FLASH.rise;
    for (let x = 0; x < 4; x += 0.05) {
      const ours = callLamp(C4 + CALLS[0].at + x, C4);
      const theirs = answerFlare(C4 + ANSWER_AT - lead + x, C4);
      expect(theirs).toBeCloseTo(ours * answerFlare(C4 + ANSWER_AT, C4), 6);
    }
    expect(CALLS[0].flashes).toEqual(CALL_RHYTHM);
  });

  it('flashes no faster than about once a second, with soft edges', () => {
    const onsets = CALL_RHYTHM.map(([at]) => at);
    for (let i = 1; i < onsets.length; i++) expect(onsets[i] - onsets[i - 1]).toBeGreaterThanOrEqual(0.85);
    expect(FLASH.rise).toBeGreaterThanOrEqual(0.2);
    // the lamp's level never steps by more than ~0.2 in a 30 fps frame
    let step = 0;
    for (let t = C4; t < C4 + ANSWER_AT + 5; t += 1 / 30) step = Math.max(step, Math.abs(callLamp(t + 1 / 30, C4) - callLamp(t, C4)), Math.abs(answerFlare(t + 1 / 30, C4) - answerFlare(t, C4)) / 1.2);
    expect(step).toBeLessThan(0.25);
  });

  it('raises the arches high: a neighbour’s apex ~50° up (it was ~9°), still ending in its lamps', () => {
    const [a, b] = [lamps[2], lamps[3]];
    expect(el(arcPoint(a, b, 0.5))).toBeLessThan(12);
    expect(el(arcPoint(a, b, 0.5, CASCADE.lift))).toBeGreaterThan(40);
    expect(arcPoint(a, b, 0, CASCADE.lift).distanceTo(a)).toBeLessThan(1e-6 * a.length() + 1e-3);
    expect(arcPoint(a, b, 1, CASCADE.lift).distanceTo(b)).toBeLessThan(1e-6 * b.length() + 1e-3);
    expect(Math.min(...arcRaised.map((d, k) => d - arcFlat[k]))).toBeGreaterThan(0);
  });

  it('wakes the Rose as a cascade: one pulse a side, each crossing ≥ 5 s, every station, closed before the quiet', () => {
    const { messages, litAt } = cascadeTraffic(C4, links, arcRaised, N);
    expect(Math.min(...messages.map((m) => m.t0))).toBeGreaterThanOrEqual(C4 + ANSWER_AT + CASCADE.lead);
    for (const m of messages) expect(m.dur).toBeGreaterThanOrEqual(5);
    for (let t = C4 + ANSWER_AT; t < C4 + 60; t += 0.1) expect(messages.filter((m) => m.t0 <= t && t < m.t0 + m.dur).length).toBeLessThanOrEqual(2);
    expect(litAt.every(Number.isFinite)).toBe(true);
    for (const m of messages) expect(m.t0).toBeGreaterThanOrEqual(litAt[sender(m, links)]);
    const closed = Math.max(...messages.map((m) => m.t0 + m.dur));
    const w1 = C4 + BEATS.find((b) => b.name === 'c4')!.length;
    expect(closed).toBeLessThan(w1 - CASCADE.quiet[0] + 1);
    // the closing link is behind us: between the two stations nearest the back
    const last = messages.reduce((a, m) => (m.t0 + m.dur > a.t0 + a.dur ? m : a));
    const back = (i: number): number => Math.abs(Math.abs(STATIONS[i]) - 180);
    expect(Math.min(back(sender(last, links)), back(receiver(last, links)))).toBeLessThan(35);
  });
});

describe('move 1: the raft turns its bow toward the answer, the eye does not turn', () => {
  const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
  afterEach(() => {
    driftParams.radioCall = false;
  });
  it('points its bow at the station that answered, then back onto the course before first light', () => {
    const off = (t: number): RaftPose => raftPose(t, c1End, rest);
    const offPoses = Array.from({ length: 2000 }, (_, i) => off(starts.c3 + i * 0.1));
    driftParams.radioCall = true;
    const on = (t: number): RaftPose => raftPose(t, c1End, rest);
    // the eye's pose against the raft is the same
    offPoses.forEach((p, i) => {
      const q = on(starts.c3 + i * 0.1);
      expect(q.bearing).toBeCloseTo(p.bearing, 9);
      expect(q.distance).toBeCloseTo(p.distance, 9);
      expect(q.height).toBeCloseTo(p.height, 9);
    });
    const D = 180 / Math.PI;
    // held broadside until the answer, then round to the lamp ahead
    expect(on(C4 + ANSWER_AT).heading * D).toBeCloseTo(70, 3);
    const p = on(C4 + ANSWER_TURN.to);
    const raft = [Math.sin(p.bearing) * p.distance, -Math.cos(p.bearing) * p.distance];
    const st = lamps[WAKE_FROM];
    const toward = Math.atan2(st.x - raft[0], -(st.z - raft[1])) * D;
    // (heading + is bow to the left: bearing −heading)
    expect(Math.abs(-p.heading * D - toward)).toBeLessThan(1);
    expect(on(starts.w1 + ANSWER_TURN.back).heading).toBeCloseTo(0, 6);
    // slowly: never faster than 3.5°/s from the answer on (c3's own swing, the dolphin's, is not this turn's)
    let rate = 0;
    for (let t = C4 + ANSWER_AT - 1; t < starts.w2; t += 0.1) rate = Math.max(rate, (Math.abs(on(t + 0.1).heading - on(t).heading) * D) / 0.1);
    expect(rate).toBeLessThan(3.5);
  });
});

describe('move 7: our lamp, then the stranger (w6)', () => {
  const W6 = starts.w6;
  const ours = FILM_RING.indexOf('lagoon');
  const sea = FILM_RING.indexOf('treetops');
  const ms = endingTraffic(W6, links, arcFlat, ours, sea, N);
  it('our station is dark and silent until it lights, then speaks first to the seaward one', () => {
    expect(oursLit(W6 + ENDING.ours[0], W6)).toBe(0);
    expect(oursLit(W6 + ENDING.ours[1], W6)).toBe(1);
    for (const m of ms) if (sender(m, links) === ours || receiver(m, links) === ours) expect(m.t0).toBeGreaterThanOrEqual(W6 + ENDING.ours[1]);
    expect(ms.some((m) => sender(m, links) === ours && receiver(m, links) === sea)).toBe(true);
  });
  it('turns every station’s last word seaward and is silent before the title', () => {
    const late = ms.filter((m) => m.t0 >= W6 + ENDING.seaward[0]);
    expect(late.length).toBe(N - 2);
    for (const m of late) expect(receiver(m, links)).toBe(sea);
    expect(Math.max(...ms.map((m) => m.t0))).toBeLessThanOrEqual(W6 + ENDING.seaward[1]);
    // (main-drift.ts endTitle: w6 + 38)
    expect(ENDING.quiet[1]).toBeLessThanOrEqual(38);
  });
  it('sends the stranger after the title, the last flare after it lands, black after that', () => {
    const sp = strangerPulse(W6);
    expect(sp.t0).toBeGreaterThan(W6 + 38);
    expect(sp.t0 + sp.dur).toBeLessThan(W6 + ENDING.flare);
    expect(lastFlare(W6 + ENDING.flare, W6)).toBe(0);
    expect(lastFlare(W6 + ENDING.flare + 1, W6)).toBeGreaterThan(0.5);
    // (main-drift.ts END_FADE: the last 6 s of w6's 60)
    expect(ENDING.flare).toBeLessThan(60 - 4);
  });
});
