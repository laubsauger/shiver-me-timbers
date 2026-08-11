/**
 * §V.2: determinism + serializability of SimState.
 * These tests exist so multiplayer-later stays possible: if state stops
 * being plain serializable data or determinism breaks, netcode is dead.
 */
import { describe, expect, it } from 'vitest';
import {
  createInitialState,
  deserializeState,
  hashState,
  serializeState,
} from '../src/state/simState';
import { createRng } from '../src/state/rng';

describe('SimState (§V.2)', () => {
  it('same seed → identical state hash', () => {
    const a = createInitialState(42);
    const b = createInitialState(42);
    expect(hashState(a)).toBe(hashState(b));
  });

  it('different seed → different hash', () => {
    expect(hashState(createInitialState(1))).not.toBe(
      hashState(createInitialState(2)),
    );
  });

  it('survives serialize → deserialize round trip exactly', () => {
    const state = createInitialState(7);
    state.ships.push({
      id: 'player',
      kind: 'player',
      position: [1, 2, 3],
      quaternion: [0, 0, 0, 1],
      velocity: [0.5, 0, 0],
      angularVelocity: [0, 0, 0],
      rudder: 0.25,
      sailTrim: 1,
      flood: 0,
      damage: { 'hull-port-1': 1 },
    });
    const restored = deserializeState(serializeState(state));
    expect(restored).toEqual(state);
    expect(hashState(restored)).toBe(hashState(state));
  });

  it('state is plain data — JSON round trip loses nothing (§V.3 store contract)', () => {
    const state = createInitialState(9);
    // would fail if anyone sneaks a class instance / function / TypedArray in
    expect(JSON.parse(JSON.stringify(state))).toEqual(state);
  });
});

describe('rng (§V.2)', () => {
  it('same seed → same sequence', () => {
    const a = createRng(123);
    const b = createRng(123);
    for (let i = 0; i < 100; i++) expect(a()).toBe(b());
  });

  it('outputs in [0,1)', () => {
    const r = createRng(555);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});
