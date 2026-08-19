/**
 * The cascade spectrum view (research-poseidon §2.3) — the half of it that can
 * be pinned without a GPU.
 *
 * WHAT THESE TESTS ARE FOR. This is an INSTRUMENT, and the failure mode of an
 * instrument is not "it looks wrong", it is §V.62: it renders nothing, or a
 * stale frame, or swallows a key into a state nobody can see, and every
 * measurement taken through it is quietly void. Three things below can only be
 * checked here and not by looking:
 *
 *  1. a key that means nothing right now must SAY SO rather than be eaten —
 *     the whole silent-no-op family starts with a consumed keypress that did
 *     nothing;
 *  2. the selection must survive a close/reopen, because an A/B that loses its
 *     mode on every toggle is not an A/B (every measurement this session
 *     drifted under the measurer);
 *  3. det J and λ⁻ must stay adjacent in the field order — the §V.58 comparison
 *     (0.5 % coverage vs 9.2 %, cap CV 0.08 vs 0.68) is the reason the view was
 *     worth building, and it is only one keypress apart by construction.
 *
 * What is NOT here, and cannot be: that each mode draws a DIFFERENT IMAGE.
 * That needs a device, and it is verified by capture.
 */
import { describe, expect, it } from 'vitest';
import {
  CASCADE_FIELDS,
  INITIAL_CASCADE_VIEW,
  reduceCascadeView,
  type CascadeViewState,
} from '../src/debug/cascadeView';
import {
  cascadeViewAction,
  cascadeViewAttached,
  emitCascadeView,
  resetCascadeViewSink,
  setCascadeViewSink,
} from '../src/ui/cascadeViewChannel';
import { CONTROL_CODES, CONTROL_GROUPS } from '../src/input/controlMap';
import { FLY_KEYS } from '../src/camera/freeCam';

const CASCADES = 3;

function step(s: CascadeViewState, code: string): CascadeViewState {
  const action = cascadeViewAction(code);
  if (action === null) return s;
  return reduceCascadeView(s, action, CASCADES).state;
}

function consumed(s: CascadeViewState, code: string): boolean {
  const action = cascadeViewAction(code);
  if (action === null) return false;
  return reduceCascadeView(s, action, CASCADES).consumed;
}

describe('cascade view keys claim nothing another owner already has', () => {
  /**
   * THE DIGITS ARE SHARED NOW, DELIBERATELY. The camera stations took 1..4
   * (`src/camera/camInput.ts` STATION_CODES) at the user's request, and this
   * test used to assert blanket exclusivity against CONTROL_CODES — which is a
   * DECISION, not a property (§V.80): it would fail on any legitimate move and
   * says nothing about why exclusivity mattered. What actually matters is that
   * two owners never both think a key is theirs to SWALLOW. The camera never
   * calls stopPropagation on a digit, and this view declines one it cannot use
   * (the §V.62 block below), so at any instant at most one owner acts on it.
   */
  const SHARED_WITH_CAMERA = new Set(['Digit1', 'Digit2', 'Digit3']);

  it('does not collide with the flight keys, the anchor, the helm or the guns', () => {
    const claimed = ['KeyG', 'Digit1', 'Digit2', 'Digit3', 'BracketLeft', 'BracketRight'];
    for (const code of claimed) {
      expect(cascadeViewAction(code), `${code} must be ours`).not.toBeNull();
      expect(FLY_KEYS.has(code), `${code} is a FreeCam flight key`).toBe(false);
      if (SHARED_WITH_CAMERA.has(code)) {
        // shared, and it has to be shared ON PURPOSE: declared in the binding
        // map so the Controls page and the code cannot drift apart
        expect(Object.values(CONTROL_CODES)).toContain(code);
      } else {
        expect(Object.values(CONTROL_CODES)).not.toContain(code);
      }
    }
    // the arena, the jump and the combat keys are bound by code in their own
    // modules; assert the specific ones the brief names as taken
    for (const taken of ['KeyX', 'KeyC', 'KeyH', 'KeyJ', 'Space', 'KeyB', 'KeyV', 'ArrowUp', 'ArrowDown']) {
      expect(claimed).not.toContain(taken);
    }
  });

  it('is discoverable — the read-only Controls page advertises the toggle', () => {
    const bindings = CONTROL_GROUPS.flatMap((g) => g.bindings);
    const entry = bindings.find((b) => b.action === 'Cascade spectrum view');
    expect(entry?.keys).toEqual(['G']);
    expect(bindings.find((b) => b.action === 'Choose the wave band')?.keys)
      .toEqual(['1', '2', '3']);
  });
});

describe('a key that means nothing right now must not be swallowed (§V.62)', () => {
  it('ignores band and field keys while the view is closed, and says it ignored them', () => {
    const closed = { ...INITIAL_CASCADE_VIEW, on: false };
    for (const code of ['Digit1', 'Digit3', 'BracketLeft', 'BracketRight']) {
      expect(consumed(closed, code), `${code} while closed`).toBe(false);
      expect(step(closed, code)).toEqual(closed);
    }
    // G is the ONE way in, so it is always consumed
    expect(consumed(closed, 'KeyG')).toBe(true);
  });

  it('rejects a band index the sim does not have rather than clamping silently', () => {
    const open = { ...INITIAL_CASCADE_VIEW, on: true };
    const out = reduceCascadeView(open, { type: 'cascade', index: 7 }, CASCADES);
    expect(out.consumed).toBe(false);
    expect(out.state).toEqual(open);
  });

  it('reports back when nothing is listening, so viewModes leaves the key alone', () => {
    resetCascadeViewSink();
    expect(cascadeViewAttached()).toBe(false);
    expect(emitCascadeView({ type: 'toggle' })).toBe(false);

    const seen: string[] = [];
    const detach = setCascadeViewSink((a) => {
      seen.push(a.type);
      return a.type === 'toggle';
    });
    expect(cascadeViewAttached()).toBe(true);
    expect(emitCascadeView({ type: 'toggle' })).toBe(true);
    expect(emitCascadeView({ type: 'stepField', delta: 1 })).toBe(false);
    expect(seen).toEqual(['toggle', 'stepField']);
    detach();
    expect(cascadeViewAttached()).toBe(false);
  });
});

describe('the selection is stable enough to A/B against', () => {
  it('survives a close and reopen — a mode lost on every toggle is not an A/B', () => {
    let s: CascadeViewState = { ...INITIAL_CASCADE_VIEW, on: true };
    s = step(s, 'Digit3');
    s = step(s, 'BracketRight');
    const chosen = { field: s.field, cascade: s.cascade };
    s = step(s, 'KeyG'); // closed
    expect(s.on).toBe(false);
    s = step(s, 'KeyG'); // open again
    expect(s.on).toBe(true);
    expect({ field: s.field, cascade: s.cascade }).toEqual(chosen);
  });

  it('steps the field list in both directions and wraps', () => {
    const n = CASCADE_FIELDS.length;
    let s: CascadeViewState = { ...INITIAL_CASCADE_VIEW, on: true, field: 0 };
    s = step(s, 'BracketLeft');
    expect(s.field).toBe(n - 1);
    s = step(s, 'BracketRight');
    expect(s.field).toBe(0);
    // a full lap returns to the start and visits every field exactly once
    const visited = new Set<number>();
    for (let i = 0; i < n; i++) {
      visited.add(s.field);
      s = step(s, 'BracketRight');
    }
    expect(visited.size).toBe(n);
    expect(s.field).toBe(0);
  });
});

describe('the field list is the one the view was built for', () => {
  it('puts det J next to λ⁻ so the §V.58 comparison is one keypress', () => {
    const det = CASCADE_FIELDS.findIndex((f) => f.id === 'detJ');
    const eig = CASCADE_FIELDS.findIndex((f) => f.id === 'lambdaMinus');
    expect(det).toBeGreaterThanOrEqual(0);
    expect(Math.abs(det - eig)).toBe(1);
  });

  it('opens on λ⁻ — the view that never existed and every foam gate speaks in', () => {
    expect(CASCADE_FIELDS[INITIAL_CASCADE_VIEW.field].id).toBe('lambdaMinus');
    expect(INITIAL_CASCADE_VIEW.on).toBe(false);
  });

  it('covers displacement AND the derived fields, with unique ids and captions', () => {
    const ids = CASCADE_FIELDS.map((f) => f.id);
    expect(new Set(ids).size).toBe(ids.length);
    // the brief: "show the derived fields, not just displacement"
    for (const required of ['height', 'displacement', 'slope', 'detJ', 'lambdaMinus', 'foam']) {
      expect(ids).toContain(required);
    }
    // a capture with no caption is not a measurement
    for (const f of CASCADE_FIELDS) {
      expect(f.label.length, `${f.id} label`).toBeGreaterThan(3);
      expect(f.legend.length, `${f.id} legend`).toBeGreaterThan(10);
    }
  });

  it('declares a reducible scalar for every field stats() will be asked about', () => {
    const withScalar = CASCADE_FIELDS.filter((f) => f.scalar !== null).map((f) => f.id);
    // the two fold metrics must both be measurable, not just visible: the
    // foam-synchrony coverage number is a stats() call on λ⁻
    expect(withScalar).toContain('lambdaMinus');
    expect(withScalar).toContain('detJ');
    expect(withScalar).toContain('foam');
    // λD is a vector; it has no single scalar and must say so rather than
    // return the magnitude under a name that reads like the field
    expect(CASCADE_FIELDS.find((f) => f.id === 'displacement')?.scalar).toBeNull();
  });
});
