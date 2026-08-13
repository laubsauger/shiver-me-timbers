#!/usr/bin/env node
/**
 * The EDIT LOOP runner. Runs only the tests that import what you touched.
 *
 * WHY THIS EXISTS: an edit to src/foam/** needs foam's 8 related files
 * (~3 s), not the sea's 40 s. Vitest's own `related` walks the real module
 * graph, so the selection is the import graph and not a filename guess —
 * touching src/params/ocean.ts correctly pulls in everything that reads it.
 *
 * WHY IT IS NOT A GATE, AND SAYS SO TWICE. §Rule 8: "'Tests pass' is wrong
 * if any were skipped." A suite that is green because it quietly skipped the
 * expensive half is worse than a slow one, so this prints what it did NOT
 * run — before and after, on pass AND on fail — and never claims more than
 * it checked. `npm test` remains the one gate, it runs everything, and
 * nobody has to remember what is in it. There is deliberately no "fast lane"
 * that a commit could be signed off against: the only two states are
 * "narrowed, and told you so" and "all of it".
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const git = (args) =>
  execFileSync('git', args, { encoding: 'utf8' })
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);

// explicit paths win; otherwise everything dirty vs HEAD, untracked included
// (a brand-new source file is exactly the case you least want to miss)
const explicit = process.argv.slice(2);
const changed = explicit.length
  ? explicit
  : [
      ...git(['diff', '--name-only', 'HEAD']),
      ...git(['ls-files', '--others', '--exclude-standard']),
    ].filter((f) => /^(src|tests)\/.*\.ts$/.test(f));

const total = readdirSync('tests').filter((f) => f.endsWith('.test.ts')).length;

const banner = (lines) => {
  const w = Math.max(...lines.map((l) => l.length));
  console.log('\n' + '─'.repeat(w));
  for (const l of lines) console.log(l);
  console.log('─'.repeat(w) + '\n');
};

if (changed.length === 0) {
  banner([
    'PARTIAL RUN: nothing changed vs HEAD, so NOTHING RAN.',
    `This is not a pass. ${total} test files were not executed.`,
    'The gate is:  npm test',
  ]);
  process.exit(0);
}

// A path that does not exist selects no tests, and `vitest related` exits 0
// on an empty selection — i.e. a typo'd or renamed path prints GREEN having
// run nothing. That is the §Rule 8 failure mode this whole script is written
// against, so it is a hard error before we start.
const missing = changed.filter((f) => !existsSync(f));
if (missing.length) {
  banner([
    'REFUSING TO RUN — these paths do not exist:',
    ...missing.map((f) => `  ${f}`),
    'A missing path selects no tests and would have exited GREEN.',
  ]);
  process.exit(2);
}

banner([
  `PARTIAL RUN — only tests importing these ${changed.length} file(s):`,
  ...changed.map((f) => `  ${f}`),
  `Everything else of the ${total} test files is SKIPPED by design.`,
  'The gate before commit is:  npm test',
]);

// JSON alongside the human reporter so the closing banner counts what
// ACTUALLY ran instead of asserting it — an empty run must not read as a pass
const out = mkdtempSync(join(tmpdir(), 'smt-related-'));
const jsonPath = join(out, 'related.json');
const r = spawnSync(
  'npx',
  [
    'vitest',
    'related',
    '--run',
    '--reporter=basic',
    '--reporter=json',
    `--outputFile.json=${jsonPath}`,
    ...changed,
  ],
  { stdio: 'inherit' },
);

let ran = 0;
let tests = 0;
try {
  const j = JSON.parse(readFileSync(jsonPath, 'utf8'));
  ran = j.testResults.length;
  tests = j.numTotalTests;
} catch {
  ran = -1; // no report written — treat as "cannot account for the run"
}
rmSync(out, { recursive: true, force: true });

const ok = r.status === 0 && ran > 0;
banner([
  ran <= 0
    ? 'NO TESTS RAN. This is a FAILURE, not a pass — nothing was checked.'
    : r.status === 0
      ? `PASSED ${tests} tests in ${ran} of ${total} test files — that is all this proves.`
      : `FAILED (${ran} of ${total} test files ran).`,
  `${total - Math.max(ran, 0)} test files were NOT executed.`,
  'Before you commit, run the gate:  npm test',
]);

process.exit(ok ? 0 : (r.status || 1));
