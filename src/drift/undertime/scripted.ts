/**
 * Undertime's two SCRIPTED pairs — the act's idea made visible in one place (direction.md):
 *
 *   HERO      U0. The first light: one pair at the spot where the remainder will be, seen face-on so its
 *             two opposed spirals read at full size, each ending in a flash that sends a shell over the dome.
 *   SURVIVOR  U3, "the one that got away". A big near pair born just before the wave. The front reaches it:
 *             its antimatter flashes out, its matter track keeps going — the only moving line left on the
 *             dome — and curls down onto that same spot, where it becomes the hero grain of U4 (and, at
 *             the end, the last star to light, above the signature).
 *
 * Pure CPU (field.ts turns these into uniforms; tests/undertimeScripted.test.ts holds the aim): both are
 * placed so the survivor's matter spiral CONVERGES on the hero grain.
 */
import type { DriftParams } from '../../params/drift';
import { domeBasis, type Vec3 } from '../../cine/domeMaster';
import { beatStarts, eyePath, heroGrainPosition, waveFront, waveTimeAt } from './timeline';
import { spiralEndCpu, type PairCpu } from './pairModel';

export interface ScriptedPair extends PairCpu {
  /** act s */
  birth: number;
  /** track s the matter / antimatter tracks run before they annihilate */
  tEnd: number;
  tEndAnti: number;
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (a: Vec3): Vec3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
/** `a` with its component along unit `n` removed, normalised */
const across = (a: Vec3, n: Vec3): Vec3 => norm(sub(a, [n[0] * dot(a, n), n[1] * dot(a, n), n[2] * dot(a, n)]));

/** the matter track's spiral: about two turns, radius down ~4× */
const HERO_SPIRAL = { omega: 4, k: 0.45, open: 0.35 };
export const HERO_TRACK_END = 3.2;

export function heroPair(p: DriftParams): ScriptedPair {
  const g = heroGrainPosition(p);
  const eye = eyePath(p.heroBirth, p);
  const field = norm(sub(g, eye)); // face-on to the audience
  return {
    vertex: g,
    // launched upward, so the V opens left and right and the two spirals curl away from each other as
    // mirror images (the classic pair) rather than stacking into a figure
    dir: across(domeBasis(p.domeTilt).axis, field),
    field,
    v: p.heroSpeed,
    ...HERO_SPIRAL,
    birth: p.heroBirth,
    tEnd: HERO_TRACK_END,
    tEndAnti: HERO_TRACK_END,
  };
}

const SURVIVOR_SPIRAL = { v: 8, omega: 2.4, k: 0.55, open: 0.3 };
/** s the survivor is born before the wave */
const SURVIVOR_LEAD = 2.2;

/** 0..1 how far through its sweep the wave front is when it reaches direction `d` from the eye */
export function waveFracCpu(d: Vec3, tiltDeg: number): number {
  const f = domeBasis(tiltDeg).front;
  return Math.acos(Math.max(-1, Math.min(1, dot(norm(d), f)))) / Math.PI;
}

export function survivorPair(p: DriftParams): ScriptedPair {
  const { starts } = beatStarts(p);
  const g = heroGrainPosition(p);
  const eye = eyePath(starts.wave, p);
  const field = norm(sub(g, eye));
  // launched downward across the line of sight; then shifted so the matter spiral ends ON the grain
  const dir = across(domeBasis(p.domeTilt).axis.map((x) => -x) as Vec3, field);
  const base: PairCpu = { vertex: [0, 0, 0], dir, field, ...SURVIVOR_SPIRAL };
  const end = spiralEndCpu(base, 1);
  const vertex = sub(g, end);
  const birth = starts.wave - SURVIVOR_LEAD;
  // its antimatter goes when the front's light passes the vertex
  const W = waveFront(p);
  const cut = W.start + waveTimeAt(waveFracCpu(sub(vertex, eye), p.domeTilt)) * W.length;
  return { ...base, vertex, birth, tEnd: 1e4, tEndAnti: Math.max(0.3, cut - birth) };
}
