/**
 * §V.48 TRIPWIRE — the mechanical check that nine occurrences deserved.
 *
 * WHY THIS EXISTS. Band-limiting failures have been found NINE separate times
 * in this project, by nine different people, each after a user reported the
 * symptom: §B.20 (hull caulk seams), the ocean sparkle cells, the foam crackle
 * octave, the foam cascade handover, the deck-water product (§V.49), the cloud
 * edge octave, the sand sparkle, the rock posterize band, and the palm ring
 * (`step(ratio, fract(y·freq))` — a ZERO-width edge, aliasing at every
 * distance rather than past an onset). The island agent's observation is the
 * one that matters: "nine occurrences found nine times by nine people is the
 * actual problem, and there is a mechanical tell every one of them shares."
 *
 * THE TELL: a `step` / `smoothstep` / `fract` applied to a spatially-varying
 * coordinate, with no `fwidth` / `dFdx` / `dFdy` anywhere in the same
 * expression. That is a hard edge with no idea how big a pixel is.
 *
 * WHAT THIS IS NOT. It cannot prove a band limit is CORRECT — §B.20 was gated
 * on the plank PERIOD when it needed the seam WIDTH, 12x too late, and that
 * would sail through any lexical check. Nor can it see whether the second half
 * of the cure is present (fading amplitude to the feature's own mean, §V.48b).
 * It catches the case where nobody thought about it at all, which is what all
 * nine of these were.
 *
 * HOW TO SATISFY IT. Either use a filtered form in the same expression, or add
 * the marker comment `@band-limited-elsewhere` on the line or the one above
 * with a reason. The marker is deliberately ugly so it reads as a claim someone
 * made, not a suppression.
 */
import { describe, expect, it } from 'vitest';

/**
 * `import.meta.glob` rather than `node:fs`: this project has no `@types/node`
 * and adding one for a test is a dependency for nothing. Vite's own glob is
 * typed by `vite/client`, which tsconfig already lists.
 */
const SOURCES = import.meta.glob('../src/**/*.ts', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>;

/** shader-side dirs: everything here can end up in a fragment stage */
const SHADER_DIRS = [
  'ocean', 'foam', 'flowfoam', 'clouds', 'caustics', 'deckwater',
  'ship', 'terrain', 'island', 'vegetation', 'ropes', 'sky', 'rain', 'core',
];

/** the filtered forms that prove someone considered the footprint */
const FILTER_TOKENS = ['fwidth', 'dFdx', 'dFdy', 'bandLimit', 'periodResolved', 'projectedWidthPx'];
/** the edge builders that alias when unfiltered */
const EDGE_TOKENS = ['smoothstep(', 'step(', '.fract()', 'fract('];

const MARKER = '@band-limited-elsewhere';

/**
 * An expression's "statement" for this purpose is the line plus the two above
 * it — TSL graphs are written as fluent chains that wrap, so a `fwidth` often
 * sits a line or two up from the `smoothstep` it feeds.
 */
function context(lines: string[], i: number): string {
  return lines.slice(Math.max(0, i - 2), i + 2).join('\n');
}

interface Finding {
  file: string;
  line: number;
  text: string;
}

function auditFile(path: string, src: string): Finding[] {
  const rel = path.replace('../', '');
  const lines = src.split('\n');
  const found: Finding[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // comments are prose, not code
    if (trimmed.startsWith('*') || trimmed.startsWith('//')) continue;
    if (!EDGE_TOKENS.some((t) => line.includes(t))) continue;

    const ctx = context(lines, i);
    if (FILTER_TOKENS.some((t) => ctx.includes(t))) continue;
    if (ctx.includes(MARKER)) continue;
    found.push({ file: rel, line: i + 1, text: trimmed.slice(0, 100) });
  }
  return found;
}

describe('§V.48 tripwire: unfiltered edges in shader code', () => {
  /**
   * A BASELINE, not a gate at zero. There is real pre-existing surface here and
   * failing the suite on all of it would just get the test deleted. The number
   * may only go DOWN: adding an unfiltered edge fails, and fixing one requires
   * lowering the ceiling, which is the ratchet.
   *
   * When this fires on new code the fix is one of:
   *   1. filter it — `fwidth` of the FEATURE's own coordinate, not its period
   *      (§B.20: the period gate was 12x too late), plus fade to the feature's
   *      own mean as it goes sub-pixel (§V.48b — both halves, or it is a fade
   *      to a hard edge);
   *   2. or mark it `@band-limited-elsewhere` WITH a reason.
   */
  // 188 → 184 when the foam art texture landed (§T.5 stage 3): the four gates
  // in src/foam that ARE the band limit — `smoothstep` on
  // `coordFootprint(coord)`, i.e. on dFdx+dFdy directly — now say so with the
  // marker instead of reading as unfiltered. The lexical rule cannot see a
  // footprint that arrives through a helper.
  const BASELINE = 184; // measured 2026-08-12; ratchet only downward

  it('does not grow the population of unfiltered edges', () => {
    const findings = Object.entries(SOURCES)
      .filter(([p]) => !p.endsWith('.test.ts'))
      .filter(([p]) => SHADER_DIRS.some((d) => p.includes(`/src/${d}/`)))
      .flatMap(([p, src]) => auditFile(p, src));

    if (findings.length > BASELINE) {
      const worst = findings
        .slice(0, 25)
        .map((f) => `  ${f.file}:${f.line}  ${f.text}`)
        .join('\n');
      throw new Error(
        `§V.48: ${findings.length} unfiltered edges, baseline ${BASELINE}.\n` +
          `A step/smoothstep/fract on a spatial coordinate with no fwidth in the\n` +
          `same expression is a hard edge that does not know how big a pixel is.\n` +
          `Filter it (on the FEATURE's width, not its period — §B.20 was 12x too\n` +
          `late) and fade to its mean (§V.48b), or mark @band-limited-elsewhere\n` +
          `with a reason.\n\nFirst findings:\n${worst}`,
      );
    }
    expect(findings.length).toBeLessThanOrEqual(BASELINE);
  });

  it('the tell it looks for is the one all nine occurrences shared', () => {
    // the palm ring, §V.48's ninth: a ZERO-width edge, so it aliased at every
    // distance rather than past an onset. Nothing to widen — that is what made
    // it worse than the others and what makes the lexical check the right shape.
    const unfiltered = ['const m = step(ratio, y.mul(freq).fract());'];
    const filtered = ['const w = fwidth(ringCoord);', 'const m = smoothstep(a.sub(w), a.add(w), d);'];
    const marked = ['const m = step(edge, v); // @band-limited-elsewhere: constant per vertex'];

    const scan = (ls: string[]) =>
      ls.filter((l, i) => {
        if (!EDGE_TOKENS.some((t) => l.includes(t))) return false;
        const ctx = context(ls, i);
        return !FILTER_TOKENS.some((t) => ctx.includes(t)) && !ctx.includes(MARKER);
      }).length;

    expect(scan(unfiltered)).toBe(1);
    expect(scan(filtered)).toBe(0);
    expect(scan(marked)).toBe(0);
  });
});
