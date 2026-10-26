/**
 * The act's idea is one place: the first light (U0), the matter that got away from the wave (U3), the grain
 * that remained (U4) and the last star to light (U6) are the same spot in front of the audience. These
 * hold the aim: the hero pair is born there, the survivor's matter spiral comes to rest there, and the
 * survivor's antimatter (and only that) is taken by the wave while the front is sweeping.
 */
import { describe, expect, it } from 'vitest';
import { driftParams } from '../src/params/drift';
import { beatStarts, heroGrainPosition } from '../src/drift/undertime/timeline';
import { HERO_TRACK_END, heroPair, survivorPair } from '../src/drift/undertime/scripted';
import { trackPositionCpu } from '../src/drift/undertime/pairModel';

const p = { ...driftParams };
const { starts } = beatStarts(p);
const g = heroGrainPosition(p);
const dist = (a: number[], b: number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('Undertime scripted pairs', () => {
  it('the first light is born where the remainder will be', () => {
    expect(dist(heroPair(p).vertex, g)).toBeLessThan(1e-9);
  });

  it("the hero's two tracks are opposed spirals that tighten (about two turns, radius down ~4×)", () => {
    const h = heroPair(p);
    const end = trackPositionCpu(h, 1, 60);
    const early = dist(trackPositionCpu(h, 1, 0.4), end);
    const late = dist(trackPositionCpu(h, 1, HERO_TRACK_END), end);
    expect(early / late).toBeGreaterThan(3);
    expect((h.omega * HERO_TRACK_END) / (2 * Math.PI)).toBeGreaterThan(1.5);
    // matter and antimatter end on opposite sides of the vertex
    const m = trackPositionCpu(h, 1, HERO_TRACK_END);
    const a = trackPositionCpu(h, -1, HERO_TRACK_END);
    expect(dist(m, a)).toBeGreaterThan(dist(m, h.vertex) * 0.5);
  });

  it("the survivor's matter comes to rest on the grain by the remain beat", () => {
    const s = survivorPair(p);
    const at = (t: number) => trackPositionCpu(s, 1, t - s.birth);
    expect(dist(at(starts.remain), g)).toBeLessThan(0.35);
    expect(dist(at(starts.remain + 2), g)).toBeLessThan(0.1);
    // and it is a big near pair, not a speck: it spans a good part of the front of the dome
    expect(dist(s.vertex, g)).toBeGreaterThan(1.5);
  });

  it('the wave takes its antimatter while the front is sweeping, and never its matter', () => {
    const s = survivorPair(p);
    const cut = s.birth + s.tEndAnti;
    expect(cut).toBeGreaterThan(starts.wave);
    expect(cut).toBeLessThan(starts.wave + p.wave);
    expect(s.tEnd).toBeGreaterThan(1e3);
    expect(s.birth).toBeLessThan(starts.wave);
  });
});
