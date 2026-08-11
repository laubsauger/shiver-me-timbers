/**
 * §V.16: every tunable must surface in the debug panel. The registry is
 * the contract that makes that possible without sim→UI coupling: systems
 * register plain objects, the panel subscribes and binds them. If the
 * registry stops returning the same reference or stops notifying late
 * registrations, tunables silently vanish from the panel and V16 dies.
 * Node env — registry must be importable without any DOM/Tweakpane.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import {
  clearParamsRegistry,
  getParamsEntry,
  listParamsEntries,
  registerParams,
  subscribeParams,
  type ParamsEntry,
} from '../src/params/registry';

beforeEach(() => {
  clearParamsRegistry();
});

describe('params registry (§V.16)', () => {
  it('returns the SAME object reference — panel mutation reaches the system live', () => {
    const params = { amplitude: 1.5, choppy: 0.8 };
    const returned = registerParams('ocean', params);
    expect(returned).toBe(params);
    // simulate panel edit: the system's own object must see it
    getParamsEntry('ocean')!.params['amplitude'] = 3.0;
    expect(params.amplitude).toBe(3.0);
  });

  it('stores per-key meta hints for the panel (min/max/step)', () => {
    registerParams(
      'wind',
      { speed: 8, direction: 0 },
      { speed: { min: 0, max: 40, step: 0.5 } },
    );
    const entry = getParamsEntry('wind');
    expect(entry).toBeDefined();
    expect(entry!.meta['speed']).toEqual({ min: 0, max: 40, step: 0.5 });
    // no hint given → no fabricated constraints
    expect(entry!.meta['direction']).toBeUndefined();
  });

  it('subscribe replays existing entries — panel created late still sees all tunables', () => {
    registerParams('ocean', { amplitude: 1 });
    registerParams('foam', { bias: 0.4 });
    const seen: string[] = [];
    subscribeParams((e: ParamsEntry) => seen.push(e.name));
    expect(seen).toEqual(['ocean', 'foam']);
  });

  it('notifies for entries registered AFTER subscribing — late systems still get folders', () => {
    const seen: string[] = [];
    subscribeParams((e) => seen.push(e.name));
    registerParams('clouds', { coverage: 0.5 });
    expect(seen).toEqual(['clouds']);
  });

  it('unsubscribe stops notifications — disposed panel leaks no callbacks', () => {
    const seen: string[] = [];
    const unsubscribe = subscribeParams((e) => seen.push(e.name));
    unsubscribe();
    registerParams('ropes', { slack: 0.1 });
    expect(seen).toEqual([]);
  });

  it('re-registering a name replaces the entry and re-notifies (hot-reload)', () => {
    registerParams('ocean', { amplitude: 1 });
    const seen: ParamsEntry[] = [];
    subscribeParams((e) => seen.push(e));
    const next = { amplitude: 2, choppy: 1 };
    registerParams('ocean', next);
    expect(listParamsEntries()).toHaveLength(1);
    expect(getParamsEntry('ocean')!.params).toBe(next);
    // replay of old + notification of replacement
    expect(seen).toHaveLength(2);
    expect(seen[1].params).toBe(next);
  });
});
