#!/usr/bin/env node
/**
 * §T.213 RIVAL AI SEED SWEEP (opt-in; the CI-default tests run 6 seeds of the synthetic pack, tests/raceAiSeeds.test.ts).
 *
 * WHY A SCRIPT: a Tower Reach race is ~140 s of wall on one core and the acceptance reads 12+ seeds × 2 seas. Vitest runs
 * with 2 workers here (docs: agents share the machine), so the sweep runs each race in its own vite-node process
 * (tests/raceAiSweep.ts, SWEEP_JOB) with a small pool instead — CPU only, no browser.
 *
 *   node scripts/race-ai-sweep.mjs                        # tower + pack, 12 seeds calm + working, 3 seeds open, 6 jobs
 *   node scripts/race-ai-sweep.mjs --course pack --seeds 12 --seas calm,working --jobs 6
 *   node scripts/race-ai-sweep.mjs --course tower --seed-list 101,105 --seas working --events
 *   --out <file.json>   all reports (incl. the per-event situations) as JSON
 *   --log <file.jsonl>  append each race's report as it finishes; re-running with the same log skips the races already in it
 *                       (a long sweep survives an interrupted shell)
 *
 * Prints one row per race, then per (course, sea) the §T.213 acceptance: 0 crashes in ≥ 95 % of races and never > 1,
 * every rival finished, no missed gates, and the median pack spread (the design band: P1–P8 ≤ 25 s over a 3-lap race,
 * design-doc §4 — 25/3 s per lap).
 */
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? dflt : process.argv[i + 1];
};
const flag = (name) => process.argv.includes(`--${name}`);

const courses = (arg('course', 'tower,pack')).split(',');
const nSeeds = Number(arg('seeds', '12'));
const seedList = arg('seed-list', null)?.split(',').map(Number) ?? Array.from({ length: nSeeds }, (_, k) => 101 + k);
const seas = arg('seas', 'calm,working').split(',');
const openSeeds = Number(arg('open-seeds', seas.includes('open') ? '0' : '3'));
const jobsN = Math.max(1, Math.min(Number(arg('jobs', '6')), cpus().length - 2));
const laps = Number(arg('laps', '1'));
const out = arg('out', null);
const showEvents = flag('events');
const log = arg('log', null);
const parse = (text) => JSON.parse(text, (_k, v) => (v === 'Infinity' ? Infinity : v === 'NaN' ? NaN : v));
const done = log && existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean).map(parse).filter((r) => !r.error) : [];

const jobs = [];
for (const course of courses) {
  for (const sea of seas) for (const seed of seedList) jobs.push({ course, seed, sea, laps });
  for (let k = 0; k < openSeeds; k++) jobs.push({ course, seed: seedList[k % seedList.length], sea: 'open', laps });
}
// the slow course first so the pool stays full
jobs.sort((a, b) => (a.course === b.course ? 0 : a.course === 'tower' ? -1 : 1));
const key = (j) => `${j.course}/${j.sea}/${j.seed}/${j.laps}`;
const have = new Set(done.map(key));
const todo = jobs.filter((j) => !have.has(key(j)));

const vn = join(ROOT, 'node_modules/.bin/vite-node');
const runJob = (job) =>
  new Promise((resolve) => {
    const p = spawn(vn, [join(ROOT, 'tests/raceAiSweep.ts')], { cwd: ROOT, env: { ...process.env, SWEEP_JOB: JSON.stringify(job) }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    p.stdout.on('data', (d) => (buf += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => {
      const line = buf.split('\n').find((l) => l.startsWith('SWEEP_RESULT '));
      if (!line) return resolve({ ...job, error: `exit ${code}: ${err.slice(-2000)}` });
      resolve(parse(line.slice('SWEEP_RESULT '.length)));
    });
  });

const row = (r) => {
  if (r.error) return `${r.course} ${r.sea} seed ${r.seed}: ERROR ${r.error}`;
  const hooks = r.racers.reduce((a, x) => a + x.hooks, 0);
  const resp = r.racers.reduce((a, x) => a + x.respawns, 0);
  return `${r.course.padEnd(5)} ${r.sea.padEnd(7)} seed ${String(r.seed).padStart(4)}: fin ${r.finished}/${r.racers.length} crashes ${r.crashes} hooks ${hooks} respawns ${resp} missed ${r.missed} solid ${r.solid} boat ${r.boat} scares ${r.racers.reduce((a, x) => a + Math.max(0, x.scares ?? 0), 0)} laps ${r.lapMin.toFixed(1)}–${r.lapMax.toFixed(1)} s pack ${r.packSpread.toFixed(1)} s (${r.wallS.toFixed(0)} s)`;
};

const t0 = Date.now();
console.log(`[sweep] ${jobs.length} races (${jobs.length - todo.length} already in the log), ${jobsN} at a time`);
const results = done.filter((r) => have.has(key(r)) && jobs.some((j) => key(j) === key(r)));
let next = 0;
await Promise.all(
  Array.from({ length: jobsN }, async () => {
    while (next < todo.length) {
      const job = todo[next++];
      const r = await runJob(job);
      results.push(r);
      if (log) appendFileSync(log, `${JSON.stringify(r, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v))}\n`);
      console.log(row(r));
      if (showEvents && !r.error) for (const x of r.racers) for (const e of x.events) console.log(`    ${x.id}: ${e}`);
    }
  }),
);

const median = (v) => {
  const s = [...v].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN;
};
console.log(`\n[sweep] done in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
let failed = false;
for (const course of courses) {
  for (const sea of [...new Set(results.filter((r) => r.course === course).map((r) => r.sea))]) {
    const rs = results.filter((r) => r.course === course && r.sea === sea).sort((a, b) => a.seed - b.seed);
    const ok = rs.filter((r) => !r.error);
    const clean = ok.filter((r) => r.crashes === 0).length;
    const worst = Math.max(0, ...ok.map((r) => r.crashes));
    const allFin = ok.every((r) => r.finished === r.racers.length);
    const missed = ok.reduce((a, r) => a + r.missed, 0);
    const spreads = ok.map((r) => r.packSpread);
    const band = (25 / 3) * laps;
    const pass = ok.length === rs.length && clean >= 0.95 * ok.length && worst <= 1 && allFin && missed === 0;
    if ((sea === 'calm' || sea === 'working') && !pass) failed = true;
    console.log(
      `[sweep] ${course} ${sea}: ${rs.length} races${rs.length - ok.length ? ` (${rs.length - ok.length} ERRORS)` : ''}; crash-free ${clean}/${ok.length} (${((100 * clean) / Math.max(1, ok.length)).toFixed(0)} %), worst ${worst}; ` +
        `all finished ${allFin}; missed ${missed}; solid ${ok.reduce((a, r) => a + r.solid, 0)}; boat ${ok.reduce((a, r) => a + r.boat, 0)}; ` +
        `pack spread median ${median(spreads).toFixed(1)} s, max ${Math.max(...spreads).toFixed(1)} s (band ${band.toFixed(1)} s) → ${pass ? 'PASS' : 'FAIL'}`,
    );
  }
}
if (out) writeFileSync(out, JSON.stringify(results, (_k, v) => (typeof v === 'number' && !Number.isFinite(v) ? String(v) : v), 1));
process.exitCode = failed ? 1 : 0;
