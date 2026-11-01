/**
 * The 16:9 cut (src/drift/flatFraming.ts, src/drift/flatTitles.ts): one 60° window on a show made for a dome, so where
 * it looks decides what the cut shows. The QA sweep of 2026-10-30 (item 2) found the straight-ahead view missing
 * Acts 1–2 (their action sits 30–50° up) and the titles cut in half on the frame's bottom edge or gone. These tests
 * hold what makes the cut watchable: it looks where each act's action is, it never whips or jumps (a camera
 * operator's pan, not a cut), its turns never stack on the show eye's own, and its titles are whole, legible and
 * inside the frame — the end title too.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { FLAT_MOVES, FLAT_START, MAX_RATE, flatFramingTrack, viewAngle, type FlatMove } from '../src/drift/flatFraming';
import { FLAT_SAFE, FLAT_WIDTH, flatTitleLines } from '../src/drift/flatTitles';
import { DomeCapture } from '../src/cine/domeCapture';
import { beatStarts as act1Beats, eyePath, heroGrainPosition } from '../src/drift/undertime/timeline';
import { beatStarts as act2Beats } from '../src/drift/getTheDrift/timeline';
import { C1_FOLLOW, coastLook, beatStarts as seaBeats } from '../src/drift/wandering/beats';
import { driftParams } from '../src/params/drift';
import { getTheDriftParams } from '../src/params/getTheDrift';
import { undertimeCrawl } from '../src/drift/undertime/crawlText';
import type { CrawlLayout, CrawlPhrase } from '../src/drift/undertime/crawl';

// the show's clock as main-drift.ts builds it (flatMarks). Act 2's hand-over into the sea is found by a bisection on
// the landing's height at boot (getTheDrift/act.ts seaFrom); 233 s into the act is where it falls with these params
const p = driftParams;
const p2 = getTheDriftParams;
const act1 = act1Beats(p);
const act2Start = act1.total - p2.overlap;
const act2 = act2Beats(p2);
const SEA_FROM = 233;
const seaStart = act2Start + SEA_FROM;
const c1End = act2.total - SEA_FROM + C1_FOLLOW;
const sea = seaBeats(c1End);
const total = seaStart + sea.total;
function marksFor(shift: Record<string, number> = {}): Record<string, number> {
  const m: Record<string, number> = { ...act1.starts, end: total };
  for (const [b, s] of Object.entries(act2.starts)) m[b] = act2Start + s;
  for (const [b, s] of Object.entries(sea.starts)) m[b] = seaStart + s;
  for (const [b, d] of Object.entries(shift)) m[b] += d;
  return m;
}
const marks = marksFor();
const view = flatFramingTrack(marks);
/** deg, half the 16:9 crop's height for a square frame of `fov` across */
const halfV = (fov: number): number => (Math.atan(Math.tan((fov * Math.PI) / 360) * (9 / 16)) * 180) / Math.PI;

describe('the 16:9 cut: framing', () => {
  it('is timed from beats the acts really have, and the show runs to its full length', () => {
    // (a beat renamed in an act's timeline would leave a move with nothing to start from: the track refuses it)
    for (const m of FLAT_MOVES) expect(marks[m.beat], m.beat).toBeTypeOf('number');
    expect(total).toBeGreaterThan(700);
  });

  it('never pans faster than ~1°/s and never jumps, sampled frame by frame over the whole show', () => {
    const fps = 30;
    let was = view(0);
    let fastest = 0;
    for (let n = 1; n <= Math.ceil(total * fps); n++) {
      const v = view(n / fps);
      const step = Math.max(viewAngle(was, v), Math.abs(v.fov - was.fov));
      fastest = Math.max(fastest, step * fps);
      was = v;
    }
    expect(fastest).toBeLessThanOrEqual(MAX_RATE * 1.01);
    expect(fastest).toBeGreaterThan(0.3); // it does move: the act changes are framed, not left to the default
  });

  it("never adds its turns to the eye's own at the coast past the dome's comfort, 1.5°/s — w4's turn to the flock above all", () => {
    // the coast's eye turns by itself (beats.ts coastLook: toward the land over the landfall, 24°; to the flock in w4,
    // 10° over 10 s, peaking at 1.5°/s) — a yaw about the world's up, on top of which the framing aims (main-drift.ts:
    // setFlat's yaw and pitch inside the eye's frame). The coordinator, 2026-10-30: the first w4 tilt peaked with the
    // flock turn at w4 + 11, 1.63°/s together
    const fps = 30;
    const total3 = (t: number) => {
      const v = view(t);
      return { ...v, yaw: v.yaw + (coastLook(t - seaStart, c1End) * 180) / Math.PI };
    };
    let fastest = 0;
    let at = 0;
    for (let n = Math.floor(marks.w1 * fps); n < marks.w6 * fps; n++) {
      const rate = viewAngle(total3(n / fps), total3((n + 1) / fps)) * fps;
      if (rate > fastest) [fastest, at] = [rate, n / fps];
    }
    expect(fastest, `at ${at.toFixed(1)} s`).toBeLessThanOrEqual(1.5 * 1.001);
    // and in w4 the framing holds still while the eye turns to the flock and back
    for (let t = marks.w4 + 6; t <= marks.w4 + 36; t += 0.25) expect(viewAngle(view(t), view(marks.w4 + 6)), `at ${t} s`).toBeLessThan(1e-9);
  });

  it('looks up through Acts 1–2 until the dawn on the limb, where their action is (QA 2026-10-30 item 2)', () => {
    for (let t = 0; t < marks.timewave + 10; t += 0.5) expect(view(t).pitch, `at ${t} s`).toBeGreaterThanOrEqual(20);
  });

  it("frames Undertime's one warm grain well inside the frame, from when it is alone through the zoom about it", () => {
    // the grain's elevation from the eye (deg; 37: heroGrainEl on the tilted dome). At pitch 22 it sat 15° over the
    // middle, on the frame's top edge (the coordinator's 2026-11-01 check: y ≈ 65/720 at 48.5 s) — held now to the
    // frame's middle three fifths from 2 s into the remain beat (its text at + 3) to the zoom's end
    const g = heroGrainPosition(p);
    for (let t = marks.remain + 2; t < marks.gather; t += 0.5) {
      const e = eyePath(t, p);
      const el = (Math.atan2(g[1] - e[1], Math.hypot(g[0] - e[0], g[2] - e[2])) * 180) / Math.PI;
      const v = view(t);
      expect(Math.abs(v.pitch - el), `at ${t} s`).toBeLessThan(halfV(v.fov) * 0.6);
    }
  });

  it("holds still while the show's own eye looks down onto the spiral and levels out (the two never add)", () => {
    // landingTurn: Drift-2's look-down eases in from 4 s before drift2, the landing's level-out after it
    const a = view(marks.drift2 - 4);
    for (let t = marks.drift2 - 4; t < marks.c2; t += 0.5) expect(viewAngle(view(t), a), `at ${t} s`).toBeLessThan(1e-9);
  });

  it('keeps the sea horizon in the frame, its middle three fifths, from the landing to the night of w6', () => {
    for (let t = marks.c1; t < marks.w6 - 8; t += 0.5) {
      const v = view(t);
      expect(Math.abs(v.pitch), `at ${t} s`).toBeLessThan(halfV(v.fov) * 0.6);
    }
  });

  it("looks up into w6's night, toward the beams, once its dissolve is over", () => {
    for (let t = marks.w6 + 18; t <= total; t += 0.5) expect(view(t).pitch, `at ${t} s`).toBeGreaterThanOrEqual(5);
  });

  it('follows the beats: a beat that starts later takes its move with it', () => {
    const later = flatFramingTrack(marksFor({ lights: 10, overshoot: 10, flood: 10, drift2: 10, landing: 10 }));
    for (let t = marks.lights - 20; t < marks.lights + 60; t += 1) expect(later(t + 10).pitch).toBeCloseTo(view(t).pitch, 9);
  });

  it('refuses a framing that would whip, overlap, or start from a beat the show lacks', () => {
    const one = (m: Partial<FlatMove>): FlatMove[] => [{ beat: 'w6', at: 0, dur: 40, to: { pitch: 10 }, ...m }];
    expect(() => flatFramingTrack(marks, one({ dur: 5 }))).toThrow(/°\/s/);
    expect(() => flatFramingTrack(marks, one({ to: { fov: 90 } }))).toThrow(/°\/s/);
    expect(() => flatFramingTrack(marks, [...one({}), ...one({ at: 10 })])).toThrow(/overlaps/);
    expect(() => flatFramingTrack(marks, one({ beat: 'w7' }))).toThrow(/no beat/);
    expect(flatFramingTrack(marks, [])(400)).toEqual(FLAT_START);
  });
});

describe('the 16:9 cut: titles', () => {
  const crawlL: CrawlLayout = { elTop: p.crawlElTop, sink: p.crawlSink, holdEl: p.crawlHoldEl, size: p.crawlSize, fade: 3, end: act1.total, maxArc: p.crawlMaxArc };
  // the end title as main-drift.ts has it: Act 1's signature again, w6 + 38 s, held to the show's end (fade END_FADE − 1)
  const endTitle: CrawlPhrase[] = [{ lines: ['the Drift'], at: marks.w6 + 38, signature: true }];
  const endL: CrawlLayout = { ...crawlL, end: total, fade: 5 };
  const every = (from: number, to: number, phrases: CrawlPhrase[], L: CrawlLayout) => {
    const out: Array<{ t: number; lines: ReturnType<typeof flatTitleLines> }> = [];
    for (let t = from; t < to; t += 0.1) out.push({ t, lines: flatTitleLines(t, phrases, L) });
    return out;
  };
  const crawl = every(0, act1.total + 1, undertimeCrawl(p), crawlL);
  const end = every(marks.w6 + 30, total + 1, endTitle, endL);

  it('shows every phrase of the crawl, and the end title, in the cut', () => {
    for (const ph of undertimeCrawl(p)) expect(crawl.some((f) => f.lines.some((l) => l.text === ph.lines[0] && l.alpha > 0.99)), ph.lines[0]).toBe(true);
    const held = end.filter((f) => f.lines.some((l) => l.text === 'the Drift' && l.alpha > 0.99));
    expect(held.length * 0.1).toBeGreaterThan(10); // up for more than 10 s before the fade
  });

  it('keeps every line whole inside the 16:9 frame (title-safe), below its centre where the framing puts the action', () => {
    for (const { t, lines } of [...crawl, ...end]) {
      for (const l of lines) {
        expect(l.y - l.em / 2, `${l.text} at ${t.toFixed(1)} s`).toBeGreaterThanOrEqual(FLAT_SAFE - 1e-9);
        expect(l.y + l.em / 2, `${l.text} at ${t.toFixed(1)} s`).toBeLessThanOrEqual(1 - FLAT_SAFE + 1e-9);
        // (Act 1's framing centres the remain beat's grain: the text sits under it, as the dome's does under its action)
        expect(l.y - l.em / 2, `${l.text} at ${t.toFixed(1)} s`).toBeGreaterThan(0.5);
      }
    }
  });

  it("stays put in the frame when the dome's title is placed elsewhere (the coast's end title moves under the beams)", () => {
    // (the dome's placement is the dome's: only how far a phrase sinks or settles reaches the flat frame, in ems — the
    // 2026-10-30 end title settles 2° to endTitleEl instead of 7° to crawlHoldEl)
    for (const holdEl of [10, 18, 30, 45]) {
      for (const settle of [0, 2, 7, 15]) {
        const L: CrawlLayout = { ...endL, holdEl, elTop: holdEl + settle };
        for (const { lines } of every(marks.w6 + 30, total + 1, endTitle, L)) {
          for (const l of lines) {
            expect(l.y - l.em / 2).toBeGreaterThan(0.5);
            expect(l.y + l.em / 2).toBeLessThanOrEqual(1 - FLAT_SAFE + 1e-9);
          }
        }
      }
    }
  });

  it('is legible at the review size: an em of at least ~5 % of the frame, lines that do not touch, the signature larger', () => {
    for (const { lines } of [...crawl, ...end]) {
      for (const l of lines) expect(l.em).toBeGreaterThanOrEqual(0.05);
      for (let j = 1; j < lines.length; j++) expect(lines[j].y - lines[j - 1].y).toBeGreaterThanOrEqual(lines[j].em);
    }
    const sig = end.flatMap((f) => f.lines).find((l) => l.signature)!;
    const body = crawl.flatMap((f) => f.lines).find((l) => !l.signature)!;
    expect(sig.em).toBeGreaterThan(body.em * 1.3);
    expect(FLAT_WIDTH).toBeLessThanOrEqual(0.9); // lines are shrunk to fit inside the title-safe width
  });
});

describe('the 16:9 cut: the capture swaps in its titles only while the flat view is on', () => {
  it("reads the flat layer in the flat view and the master's layer otherwise, leaving the dome's untouched", () => {
    const domeLayer = new THREE.Texture();
    const flatLayer = new THREE.Texture();
    const dome = new DomeCapture({ faceSize: 16, overlay: domeLayer, flatOverlay: flatLayer, grade: true });
    const node = (dome as unknown as { overlayNode: { value: THREE.Texture } }).overlayNode;
    expect(node.value).toBe(domeLayer);
    expect(dome.flat).toBe(false);
    dome.setFlat({ fov: 60, pitch: 30 });
    expect(dome.flat).toBe(true);
    expect(node.value).toBe(flatLayer);
    dome.setFlat(null);
    expect(node.value).toBe(domeLayer);
    // without a flat layer the flat view keeps reading the master's, as before
    const plain = new DomeCapture({ faceSize: 16, overlay: domeLayer, grade: true });
    plain.setFlat({ fov: 60 });
    expect((plain as unknown as { overlayNode: { value: THREE.Texture } }).overlayNode.value).toBe(domeLayer);
  });
});
