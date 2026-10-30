/**
 * The dive into the cosmic web (src/drift/getTheDrift/webDive.ts): one curve through the web's box from Undertime's
 * pull-back, through the dive, into Get the Drift's approach. What has to hold for a dome audience:
 *   - the eye's place in the web never jumps and its speed never jerks — at the pull-back's rest (where the dive
 *     begins), at the act's hand-over (where the box changes size and the eye changes worlds) and at `ours` (where
 *     the dive hands its pace to the approach) — or the whole web on the dome would lurch at once;
 *   - the box's change of size at the act is invisible: every point of the web (the hero grain, a knot, our galaxy's
 *     Sun point) is seen in the same direction from either world;
 *   - the flow keeps one fixed centre: the dive runs straight along the approach (translation only, the view never
 *     turns), and ends on our galaxy's Sun point;
 *   - its pace stays under the comfort cap for exponential flight and accelerates, then decelerates;
 *   - from `ours` on the approach is exactly the approved one (the dive only adds to what comes before).
 */
import { describe, expect, it } from 'vitest';
import { driftParams as p } from '../src/params/drift';
import { getTheDriftParams as p2 } from '../src/params/getTheDrift';
import { beatStarts, eyePath, webFlight, webTurnEnd } from '../src/drift/undertime/timeline';
import { arrivalEye, arrivalState, beatStarts as actBeats, ourGalaxy } from '../src/drift/getTheDrift/timeline';
import { WEB_DIVE, WEB_PULL, diveWorld, toWorld, webFrame, webPlace, wrap } from '../src/drift/getTheDrift/webDive';
import type { Vec3 } from '../src/cine/domeMaster';

// a hero knot anywhere in the box (the frame is relative to it; the real one is in the gitignored web data)
const hero: Vec3 = [0.9043, 0.2832, 0.51758];
const { total } = beatStarts(p);
const actStart = total - p2.overlap;
const e0 = eyePath(actStart, p);
const g = ourGalaxy(p2, e0, p.domeTilt);
const f = webFrame(p, p2, hero, g.sun);
const sub = (a: number[], b: number[]): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (a: number[]): number => Math.hypot(a[0], a[1], a[2]);
const dot = (a: number[], b: number[]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const angleDeg = (a: number[], b: number[]): number => (Math.acos(Math.min(1, dot(a, b) / (len(a) * len(b)))) * 180) / Math.PI;
/** the show's eye in its world at show time t (main-drift: Undertime's until the act, the approach's after) */
const eyeAt = (t: number): Vec3 => (t < actStart ? eyePath(t, p) : arrivalEye(t - actStart, p2, g));
const placeAt = (t: number) => webPlace(t, eyeAt(t), f, p);

describe('the web dive', () => {
  it('starts where the pull-back comes to rest, and Get the Drift is timed to meet it', () => {
    expect(f.diveStart).toBe(webTurnEnd(p));
    expect(actStart - p2.diveLead).toBeCloseTo(f.diveStart, 9);
    // at rest there: the pull-back has eased out and the dive eases in
    expect(len(placeAt(f.diveStart).vel)).toBeLessThan(1e-3);
  });

  it('sits the box in the world by a rotation, the pull-back and the dive along their world directions', () => {
    const R = f.R;
    const cols = [0, 1, 2].map((j) => [R[j], R[3 + j], R[6 + j]]);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) expect(dot(cols[i], cols[j])).toBeCloseTo(i === j ? 1 : 0, 9);
    // the dive's line in the box maps onto the approach exactly: the flow expands from one fixed point on the dome
    expect(angleDeg(toWorld(R, f.dive), f.approach)).toBeLessThan(1e-6);
    // and the frame the search picked the filament in is the frame the show uses (the params still fit it)
    expect(angleDeg(f.dive, WEB_DIVE)).toBeLessThan(0.5);
    // the pull-back's own world direction where it rests is the pattern one the filament was searched from
    expect(angleDeg(toWorld(R, WEB_PULL), webFlight(f.diveStart, p).offset)).toBeLessThan(1e-6);
  });

  it('never jumps or jerks through the web, 55–123 s at 30 fps (pull-back, rest, dive, the act, the approach)', () => {
    const h = 1 / 30;
    let prev = placeAt(55);
    let worst = 0;
    let worstKick = 0;
    let diveKick = 0;
    for (let t = 55 + h; t < 123; t += h) {
      const now = placeAt(t);
      // a step against the speed either side: a jump shows as a step far above the speed times the frame
      const step = len(wrap(sub(now.eyePat, prev.eyePat)));
      const speed = Math.max(len(now.vel), len(prev.vel));
      worst = Math.max(worst, step / (speed * h + 1e-7));
      // the velocity's change per frame (box units/s²): a speed handed over badly is a step in it, a kick to the whole
      // dome. (Against the speed itself it reads large where the pull-back eases to rest at 73 s, by design.)
      const kick = len(sub(now.vel, prev.vel)) / h;
      worstKick = Math.max(worstKick, kick);
      if (t > f.diveStart - 0.5) diveKick = Math.max(diveKick, kick);
      prev = now;
    }
    expect(worst).toBeLessThan(1.2);
    // (the pull-back's own ease to rest peaks at ~0.039 box/s² at ~72 s, the dive's at under 0.01; the dive's speed
    // stepping at 81 s would read ~0.5)
    expect(worstKick).toBeLessThan(0.05);
    expect(diveKick).toBeLessThan(0.015);
  });

  it('changes worlds at the act invisibly: the hero grain and the Sun point are seen in the same directions', () => {
    // the frame just before the act, in Undertime's world (eye still, box 19 m), and just after, in Get the Drift's
    const before = webPlace(actStart - 1e-6, eyePath(actStart, p), f, p);
    const after = webPlace(actStart, arrivalEye(0, p2, g), f, p);
    expect(before.box).toBeLessThan(30);
    expect(after.box).toBeGreaterThan(500);
    for (const k of [hero, f.target]) {
      const a = toWorld(f.R, wrap(sub(k, before.eyePat)));
      const b = toWorld(f.R, wrap(sub(k, after.eyePat)));
      expect(angleDeg(a, b)).toBeLessThan(1e-3);
    }
    // and the Sun point in Get the Drift's world IS the dive's target
    expect(len(sub(diveWorld(f, f.target), g.sun))).toBeLessThan(1e-9);
  });

  it('accelerates, then slows to the approach: under the comfort cap, fastest mid-dive', () => {
    const h = 0.02;
    const rate = (t2: number): number => (Math.log(arrivalState(t2 - h, p2).f) - Math.log(arrivalState(t2 + h, p2).f)) / (2 * h);
    let peak = 0;
    let peakAt = 0;
    for (let t2 = -p2.diveLead; t2 < p2.galaxies + 30; t2 += 0.05) {
      const r = rate(t2);
      if (r > peak) [peak, peakAt] = [r, t2];
    }
    expect(peak).toBeLessThan(0.35);
    // a dive, not a drift: well above the old approach's own 0.17 peak, its top a little past halfway through it
    expect(peak).toBeGreaterThan(0.25);
    expect(peakAt).toBeGreaterThan(-p2.diveLead + 0.4 * (p2.diveLead + p2.galaxies));
    expect(peakAt).toBeLessThan(p2.galaxies - 4);
    // slow under Undertime's signature and the hero grain's ignition (~82.5 s): the dive has barely begun
    expect(rate(82.5 - actStart)).toBeLessThan(0.12);
  });

  it('is the approved approach from `ours` on, and only adds distance before it', () => {
    const plain = { ...p2, diveEfolds: 0 };
    for (const t2 of [p2.galaxies, p2.galaxies + 5, p2.galaxies + p2.ours, actBeats(p2).starts.sun + 3]) {
      expect(arrivalState(t2, p2).f).toBeCloseTo(arrivalState(t2, plain).f, 9);
    }
    // before it, further out: e^diveEfolds at the dive's start
    expect(arrivalState(-p2.diveLead, p2).f).toBeCloseTo(Math.exp(p2.diveEfolds), 6);
    expect(arrivalState(0, p2).f).toBeGreaterThan(arrivalState(0, plain).f);
  });

  it('flies the web at its true scale: the box hundreds of our galaxy’s radii, our galaxy a smudge at the start', () => {
    expect(f.box / g.radius).toBeGreaterThan(300);
    const startDist = len(sub(arrivalEye(-p2.diveLead, p2, g), g.sun));
    // under a degree across at the dive's start (it was ~13° across at the act's start before the dive)
    expect((2 * Math.atan(g.radius / startDist) * 180) / Math.PI).toBeLessThan(1);
  });
});
