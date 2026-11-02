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
 *   - the answer repeats the first call's rhythm exactly (the "same rhythm" is the whole message), and both ride
 *     pulses along the sky, one a beat — no lamp blinks on our raft;
 *   - nothing flashes faster than about once a second, and no flash edge is a cut (comfort);
 *   - the cascade puts one pulse in flight a side, every crossing ≥ 5 s, reaches every station, and has closed before
 *     c4's Rose starts going quiet (else the ring closes in the fade, unseen); the paths it and our call ran along
 *     keep faint trails through that quiet, gone as the dissolve begins;
 *   - w6's chatter keeps the same trails, no brighter than c4's, building link by link and gone before the title;
 *   - the raft's bow comes round to the station that answered while the eye's own pose is untouched;
 *   - the ending: our station speaks only once it is lit, the traffic ends converging on one station before the title,
 *     Act 1's pairs leave w6's sky with the Rose (the stranger's braid is the only thing in their colours), and the
 *     stranger comes after the title and before the last flare, which comes before the black.
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
  callSwell,
  TRAIL,
  TRAIL_W6,
  trailLevel,
  trailOut,
  trailOutW6,
  chatterTraffic,
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
import { STATIONS, arcDegrees, arcPoint, fieldOnCoast } from '../src/drift/wandering/props';
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

  it('leaves about 8 s between the calls, the second shorter, its pulses wholly in before the answer', () => {
    const [first, second] = CALLS;
    expect(second.at - first.at).toBeGreaterThan(7);
    expect(second.at - first.at).toBeLessThan(11);
    expect(second.flashes.length).toBeLessThan(first.flashes.length);
    // (a pulse is wholly at its far end CALL.travel after its tail, hold + FLASH.fall, has left)
    const ours = callPulses(C4).filter((p) => !p.back);
    const second2 = ours.filter((p) => p.t0 >= C4 + second.at - 1e-9);
    expect(second2.length).toBe(second.flashes.length);
    const inBy = Math.max(...second2.map((p) => p.t0 + p.hold + FLASH.fall + CALL.travel));
    expect(inBy).toBeLessThan(C4 + ANSWER_AT - FLASH.rise);
    // …and the answer follows within a breath (more, and the call and the answer read as unrelated)
    expect(inBy).toBeGreaterThan(C4 + ANSWER_AT - FLASH.rise - 1.5);
    // the dial wakes before the first call
    expect(CALL.dial).toBeLessThan(first.at);
  });

  it('calls in pulses along the sky, one a beat, and the answer comes back the same way', () => {
    // (the user, 2026-11-02: the masthead's blinking lamp "is not doing it for me at all" — the call sign rides the
    // pulses: they leave as its beats begin, as long as each is held)
    const ps = callPulses(C4);
    const out = ps.filter((p) => !p.back);
    const back = ps.filter((p) => p.back);
    const beats = CALLS.flatMap((c) => c.flashes.map(([at]) => c.at + at));
    expect(out.length).toBe(beats.length);
    out.forEach((p, i) => expect(p.t0 - C4).toBeCloseTo(beats[i], 9));
    expect(out.map((p) => p.hold)).toEqual(CALLS.flatMap((c) => c.flashes.map(([, hold]) => hold)));
    // the answer's pulses leave the lamp ahead with its flares, in our first call's rhythm
    expect(back.map((p) => p.hold)).toEqual(CALL_RHYTHM.map(([, hold]) => hold));
    for (const p of back) expect(answerFlare(p.t0 + FLASH.rise, C4)).toBeGreaterThan(1);
    expect(Math.min(...back.map((p) => p.t0))).toBeCloseTo(C4 + ANSWER_AT - FLASH.rise, 9);
    // the dial swells once a call, not once a pulse: no dip between a call's beats
    for (const c of CALLS) {
      const [lastAt, lastHold] = c.flashes[c.flashes.length - 1];
      for (let x = 0; x <= lastAt + lastHold; x += 0.05) expect(callSwell(C4 + c.at + x, C4)).toBe(1);
    }
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

  it('raises the arches high: a neighbour’s apex ~58° up (it was ~9°), still ending in its lamps', () => {
    const [a, b] = [lamps[2], lamps[3]];
    expect(el(arcPoint(a, b, 0.5))).toBeLessThan(12);
    // (0.5's ~50° "sits high instead of really crossing overhead", the 2026-11-02 seat-view review)
    expect(el(arcPoint(a, b, 0.5, CASCADE.lift))).toBeGreaterThan(54);
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
    // …on the score's last swell, a beat clear of the quiet (raised higher, the arches are longer: CASCADE.speed)
    expect(show(closed)).toBeLessThan(475);
    // brighter for the thin air the raised arches run through, and only by a step (no flash, a pulse)
    expect(CASCADE.gain).toBeGreaterThan(1);
    expect(CASCADE.gain).toBeLessThanOrEqual(2);
    // the closing link is behind us: between the two stations nearest the back
    const last = messages.reduce((a, m) => (m.t0 + m.dur > a.t0 + a.dur ? m : a));
    const back = (i: number): number => Math.abs(Math.abs(STATIONS[i]) - 180);
    expect(Math.min(back(sender(last, links)), back(receiver(last, links)))).toBeLessThan(35);
  });
});

describe('move 1: the paths keep faint trails (radioCall)', () => {
  // (the user, 2026-11-02: "keeping faint lines of where the lines traveled … but like much more faint … Otherwise, it's
  // like very empty") — the network's figure builds link by link, still there through the quiet, gone by the dissolve
  const w1 = C4 + BEATS.find((b) => b.name === 'c4')!.length;
  const at = (t: number, lit: number): number => trailLevel(t - lit) * trailOut(t, w1);
  it('comes in behind the pulse, not before it', () => {
    expect(trailLevel(0)).toBe(0);
    expect(trailLevel(-1)).toBe(0);
    expect(trailLevel(TRAIL.in)).toBeGreaterThan(0.9);
  });
  it('keeps every path the cascade and our first call ran along faintly lit through the quiet', () => {
    const { messages } = cascadeTraffic(C4, links, arcRaised, N);
    // (a path's trail starts as the first pulse's head has run its length: its far end lit last)
    const lit = [...messages.map((m) => m.t0 + m.dur), callPulses(C4)[0].t0 + CALL.travel];
    // the quiet: the Rose's pulses and flares fade over CASCADE.quiet (476 → 484 show s)
    const quiet = w1 - CASCADE.quiet[0];
    for (const l of lit) {
      expect(at(quiet, l)).toBeGreaterThan(0.3);
      expect(at(w1 - CASCADE.quiet[1], l)).toBeGreaterThan(0);
    }
    // the oldest, the first call's, has faded most — it is the earliest stroke of the figure
    expect(at(quiet, lit[lit.length - 1])).toBeLessThan(at(quiet, lit[0]));
  });
  it('is gone as the dissolve to w1 begins (5 s before it), never crossfaded', () => {
    expect(trailOut(w1 - 5, w1)).toBe(0);
    expect(TRAIL.out[1]).toBeGreaterThanOrEqual(5);
    expect(TRAIL.out[0]).toBeLessThan(CASCADE.quiet[0]);
  });
});

describe('w6: the chatter keeps the same faint trails, and lets them go before the title', () => {
  // (the 2026-11-02 spine round: c4's trails carried on into w6 — the network's figure builds slowly through w6 too,
  // "much more faint than we used to have. Otherwise, it's like very empty"; the light is c4's, props.ts ARC_L.trail)
  const W6 = starts.w6;
  /** main-drift.ts endTitle: w6 + 38 */
  const TITLE = W6 + 38;
  // (as props.ts lays w6's traffic: from 6 s before w6, each link's first message of that window lights its path)
  const ms = chatterTraffic(W6 - 6, W6 + 70, links, arcFlat);
  const lit = links.map((_, k) => {
    const m = ms.find((x) => x.link === k)!;
    return m.t0 + m.dur;
  });
  const at = (t: number, l: number): number => trailLevel(t - l) * trailOutW6(t, W6);
  const drawn = (t: number): number => lit.filter((l) => at(t, l) > 0.3).length;
  it('builds the figure link by link over w6, never all at once', () => {
    // a few strokes as the Rose comes back, most of the figure some 25 s in
    // (and never brighter than c4's: the low coast arcs run through thicker air, roseTraffic.ts TRAIL_W6.gain)
    expect(TRAIL_W6.gain).toBeGreaterThan(0);
    expect(TRAIL_W6.gain).toBeLessThanOrEqual(1);
    expect(drawn(W6 + 2)).toBeLessThan(links.length / 4);
    expect(drawn(W6 + 25)).toBeGreaterThan(links.length * 0.7);
    // never more than a handful of new strokes in any 2 s
    for (let t = W6 - 6; t < TITLE; t += 0.5) expect(lit.filter((l) => l >= t && l < t + 2).length, `${t - W6}`).toBeLessThanOrEqual(5);
  });
  it('is gone before the end title, and so before every one of radioEnding’s moments that follow it', () => {
    expect(trailOutW6(W6 + TRAIL_W6.out[0], W6)).toBe(1);
    for (let t = W6 + TRAIL_W6.out[1]; t < W6 + 60; t += 0.5) for (const l of lit) expect(at(t, l)).toBe(0);
    // gone 3 s or more before the title rises, and with radioEnding's quiet (its Rose out by ENDING.quiet[1])
    expect(W6 + TRAIL_W6.out[1]).toBeLessThanOrEqual(TITLE - 3);
    expect(TRAIL_W6.out[1]).toBeLessThanOrEqual(ENDING.quiet[1]);
    expect(W6 + TRAIL_W6.out[1]).toBeLessThan(strangerPulse(W6).t0);
    // a fade, not a cut: several seconds long, never faster than ~1/4 of the trails' light a second
    expect(TRAIL_W6.out[1] - TRAIL_W6.out[0]).toBeGreaterThanOrEqual(6);
    for (let t = W6 + TRAIL_W6.out[0]; t < W6 + TRAIL_W6.out[1]; t += 0.1) expect(Math.abs(trailOutW6(t + 0.1, W6) - trailOutW6(t, W6)) / 0.1).toBeLessThan(0.25);
  });
  it('holds the figure long enough to be seen before it goes', () => {
    // at least ~10 s with most of it drawn before the fade begins
    const full = Array.from({ length: 400 }, (_, i) => W6 + i * 0.1).filter((t) => drawn(t) > links.length * 0.6);
    expect(full.length * 0.1).toBeGreaterThan(10);
  });
});

describe('move 1: the raft turns its bow toward the answer, the eye does not turn', () => {
  const rest: RaftPose = { bearing: 0.26, distance: 18, heading: -1.5, height: 3 };
  // (radioCall is on by default since the 2026-11-02 spine review: each test leaves it as shipped)
  const shipped = driftParams.radioCall;
  afterEach(() => {
    driftParams.radioCall = shipped;
  });
  it('is in the film by default; off (?radioCall=0), the raft swings as it did in the old c4', () => {
    expect(shipped).toBe(true);
    driftParams.radioCall = false;
    // the old c4: broadside (70°) through c3's swing, round onto the coast's course (0) by c4 + 30 s, never held for
    // an answer (beats.ts POSE_KEYS)
    const D = 180 / Math.PI;
    expect(raftPose(C4 + 30, c1End, rest).heading * D).toBeCloseTo(0, 3);
    driftParams.radioCall = true;
    expect(raftPose(C4 + 30, c1End, rest).heading * D).toBeGreaterThan(30);
  });
  it('points its bow at the station that answered, then back onto the course before first light', () => {
    driftParams.radioCall = false;
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
  it('takes Act 1’s pairs out of w6’s sky with the Rose, so the stranger’s braid is alone in their colours', () => {
    // (props.ts fieldOnCoast: the w6 field, Act 1's loops, fades with the Rose's quiet under radioEnding — and only then)
    const sp = strangerPulse(W6);
    expect(fieldOnCoast(W6 + ENDING.quiet[0] - 1, starts, 1, true)).toBe(fieldOnCoast(W6 + ENDING.quiet[0] - 1, starts, 1));
    for (let t = W6 + ENDING.quiet[1]; t <= sp.t0 + sp.dur + 6; t += 0.25) expect(fieldOnCoast(t, starts, 1, true)).toBe(0);
    // gone before the title (main-drift.ts endTitle: w6 + 38), well before the stranger's glow on the horizon
    expect(ENDING.quiet[1]).toBeLessThanOrEqual(38);
    // and without the param w6's field is as it was
    expect(fieldOnCoast(sp.t0, starts, 1)).toBe(1);
    // (w3's field is not touched)
    expect(fieldOnCoast(starts.w3 + 10, starts, 1, true)).toBe(fieldOnCoast(starts.w3 + 10, starts, 1));
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
