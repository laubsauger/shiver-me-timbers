/**
 * The GPU timer's whole justification is that it refuses to print a plausible
 * wrong number (§Rule 8, §V.39, §V.63). These tests pin the refusals, not the
 * formatting: each one asserts that a specific broken state CANNOT be read as a
 * working one.
 */
import { describe, it, expect } from 'vitest';
import { formatGpuHud, type GpuTimer, type GpuTimerHealth, type GpuPassSample } from '../src/debug/gpuTimer';

const HEALTHY: GpuTimerHealth = {
  reads: 120,
  misses: 4,
  idle: 0,
  overflows: 0,
  incompleteReads: 0,
  passesPerFrame: { render: 26, compute: 85 },
  capacityPairs: 1023,
  unwritten: 0,
  staleMs: 12,
  batchFrames: 1,
  quantumMs: 0.065536,
  lastError: null,
};

function fakeTimer(
  health: Partial<GpuTimerHealth>,
  totals: { render: number; compute: number } = { render: 2, compute: 5 },
  passes: GpuPassSample[] = [
    { label: 'bloom 1280x720 (#7)', min: 1.2, last: 1.3, n: 60 },
    { label: 'output 2560x1440 (#3)', min: 0.8, last: 0.9, n: 60 },
  ],
): GpuTimer {
  return {
    tick: () => undefined,
    passes: (kind) => (kind === 'render' ? passes : []),
    total: (kind) => totals[kind],
    health: () => ({ ...HEALTHY, ...health }),
    reset: () => undefined,
    dispose: () => undefined,
  };
}

describe('formatGpuHud', () => {
  it('prints the pass ranking when nothing overflowed', () => {
    const lines = formatGpuHud(fakeTimer({}));
    expect(lines.join('\n')).toContain('bloom 1280x720');
  });

  it('REFUSES to print a ranking when passes overflowed the pool', () => {
    // The danger is not that the numbers are wrong — it is that a truncated
    // top-8 is plausible and ordered, so a reader ranks passes that were never
    // timed against ones that were. No ranking may survive an overflow.
    const lines = formatGpuHud(fakeTimer({ overflows: 89, incompleteReads: 5 }));
    const text = lines.join('\n');
    expect(text).not.toContain('bloom 1280x720');
    expect(text).not.toContain('output 2560x1440');
    expect(text).toContain('SUPPRESSED');
    expect(text).toContain('89');
  });

  it('shows the per-frame pass count so completeness is auditable', () => {
    // "Is this list complete?" is unanswerable without knowing how many passes
    // the frame had. Printing the count is what makes the top-8 checkable.
    const lines = formatGpuHud(fakeTimer({}));
    expect(lines[0]).toContain('26 p');
    expect(lines[0]).toContain('85 p');
  });

  it('shows -- rather than 0.00 for a pool that has never been read', () => {
    // A dead instrument must not be indistinguishable from a free pass.
    const lines = formatGpuHud(fakeTimer({ reads: 0 }, { render: NaN, compute: NaN }, []));
    expect(lines[0]).toContain('--');
    expect(lines[0]).not.toContain('0.00');
  });

  it('warns when query pairs came back unwritten', () => {
    const lines = formatGpuHud(fakeTimer({ unwritten: 17 }));
    expect(lines.join('\n')).toContain('unwritten 17');
  });

  it('shows -- rather than a stale number when the last read is over a second old', () => {
    // The exact fault this module exists to escape: three's pool returns its
    // last good reading forever, and a constant reads as a perfectly steady
    // frame. A min-of-window total printed 8 s after the last read is the same
    // lie in a different wrapper.
    const lines = formatGpuHud(fakeTimer({ staleMs: 8025 }));
    expect(lines[0]).toContain('--');
    expect(lines[0]).not.toContain('2.00');
    expect(lines.join('\n')).toContain('8.0s ago');
  });
});
