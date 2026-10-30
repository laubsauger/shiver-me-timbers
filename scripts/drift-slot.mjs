#!/usr/bin/env node
/**
 * THE MACHINE'S RENDER SLOTS. Every headless-Chrome render of the film — a still, a review clip, a benchmark, a
 * master lane — is heavy: a GPU process with gigabytes of textures, a CPU-bound sea. Several agents or people working
 * at once each start their own, and past two at a time the whole machine crawls (the user, 2026-10-29: "not more
 * than two lanes of heavy renderers"). This hands out a fixed number of slots, machine-wide, and runs a command in one:
 *
 *   node scripts/drift-slot.mjs -- node scripts/drift-review-stills.mjs 1280 shots.json out/
 *   node scripts/drift-slot.mjs --weight 2 -- node scripts/drift-render.mjs --lanes 2 ...   (a job of two lanes)
 *   node scripts/drift-slot.mjs --status
 *
 * It waits for free slots (polling every few seconds, printing who holds them), takes `--weight` of them, runs the
 * command with its stdio, and gives them back when it exits — also on Ctrl-C. A slot is a file holding its owner's
 * pid in out/drift/.slots/ (`DRIFT_SLOTS_DIR` to move it); one whose pid is gone is stale and taken over. Slot count:
 * `--slots`, else `DRIFT_SLOTS`, else the number in out/drift/.slots/limit, else 2. The limit file is the machine's
 * own setting, changed without touching anyone's command: `echo 1 > out/drift/.slots/limit` while someone works at
 * the machine (the user, 2026-10-29, with two at once: "my computer is getting unusably slow"), delete it for 2.
 *
 * FOR THE DASHBOARD (scripts/drift-dash.mjs; the user, 2026-10-29: "a cute little dashboard … so I can see what's
 * going on … and how long it's gonna take"): a job waiting for a slot leaves `wait-<pid>` (its command) here, and a
 * running job's output is copied to `<slot>.log` beside its slot file as well as to the terminal, so the dashboard can
 * show the queue and read a clip's `[review] n/N` progress. The log stays after the job, until the slot's next job.
 *
 * ON THE FARM (scripts/drift-farm-client.mjs; the user, 2026-10-29: "make sure that these machines get fat work …
 * so we have to wait less"): `--farm [auto|<box>]` (or DRIFT_FARM=auto in the environment: every agent's job, with
 * one variable) sends the command to a studio render machine instead of a slot here, through this Mac's farm hub
 * (drift-dash.mjs, :5190; token from farm.json). Its output shows here as it runs, and its files land at the --out
 * paths it named, as if it had run here; files it reads outside the code are sent along. `auto`: the best free box,
 * and with none free (or none taking it in 60 s), a slot here as before. `--local` overrides DRIFT_FARM.
 * `--priority low|normal|high` (or DRIFT_FARM_PRIORITY; normal by default): the farm hands out the highest first, and a
 * low job only to a box no queued higher job could use (drift-farm.mjs PRIORITIES); a low job never falls back here.
 *
 *   node scripts/drift-slot.mjs --farm auto -- node scripts/drift-review-stills.mjs shots.json --out out/drift/x
 */
import { spawn } from 'node:child_process';
import { mkdirSync, openSync, writeSync, closeSync, readFileSync, unlinkSync, readdirSync, writeFileSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const dd = argv.indexOf('--');
const opts = dd < 0 ? argv : argv.slice(0, dd);
const cmd = dd < 0 ? [] : argv.slice(dd + 1);
const opt = (name, fallback) => {
  const i = opts.indexOf(name);
  return i >= 0 ? opts[i + 1] : fallback;
};
const DIR = process.env.DRIFT_SLOTS_DIR ?? join(ROOT, 'out/drift/.slots');
mkdirSync(DIR, { recursive: true });
const limitFile = () => {
  try {
    return readFileSync(join(DIR, 'limit'), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};
const SLOTS = Number(opt('--slots', process.env.DRIFT_SLOTS ?? limitFile() ?? 2));
const WEIGHT = Number(opt('--weight', 1));

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
};
/** the slot files held by a live process: name → { pid, what } */
const held = () => {
  const out = new Map();
  for (const f of readdirSync(DIR)) {
    if (!f.endsWith('.slot')) continue;
    try {
      const [pid, ...what] = readFileSync(join(DIR, f), 'utf8').split('\n');
      if (alive(Number(pid))) out.set(f, { pid: Number(pid), what: what.join(' ').trim() });
      else unlinkSync(join(DIR, f));
    } catch {
      // (taken or released while we looked)
    }
  }
  return out;
};

if (opts.includes('--status')) {
  const h = held();
  console.log(`${h.size}/${SLOTS} render slots in use (${DIR})`);
  for (const [f, v] of h) console.log(`  ${f}: pid ${v.pid}  ${v.what}`);
  process.exit(0);
}
if (!cmd.length) {
  console.error('usage: node scripts/drift-slot.mjs [--slots N] [--weight N] -- <command…>   |   --status');
  process.exit(2);
}
if (WEIGHT > SLOTS) {
  console.error(`drift-slot: a job of weight ${WEIGHT} can never run in ${SLOTS} slots`);
  process.exit(2);
}

// ON THE FARM (header): submit instead of running here; `auto` falls back to a slot here
const farmAt = opts.indexOf('--farm');
const FARM = opts.includes('--local') ? null : farmAt >= 0 ? (opts[farmAt + 1] && !opts[farmAt + 1].startsWith('--') ? opts[farmAt + 1] : 'auto') : process.env.DRIFT_FARM || null;
if (FARM) {
  const priority = opt('--priority', process.env.DRIFT_FARM_PRIORITY || 'normal');
  if (!['low', 'normal', 'high'].includes(priority)) {
    console.error(`drift-slot: --priority ${priority}: low | normal | high`);
    process.exit(2);
  }
  const { submit } = await import('./drift-farm-client.mjs');
  const { rmSync } = await import('node:fs');
  const stage = join(ROOT, 'out/drift/farm/stage', `${process.pid}-${Date.now()}`);
  let r;
  try {
    const token = JSON.parse(readFileSync(process.env.DRIFT_FARM_TOKEN_FILE ?? join(ROOT, 'farm.json'), 'utf8')).token;
    r = await submit({ root: ROOT, hub: process.env.DRIFT_FARM_HUB ?? 'http://localhost:5190', token, argv: cmd, prefer: FARM, weight: WEIGHT, priority, stage, say: (m) => console.error(`drift-slot: ${m}`) });
  } catch (e) {
    r = { fallback: e.message };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  if (!r.fallback) process.exit(r.code);
  // (a low job is background work for the farm: it never takes a slot of this Mac's instead)
  if (FARM !== 'auto' || priority === 'low') {
    console.error(`drift-slot: farm (${FARM}): ${r.fallback}`);
    process.exit(1);
  }
  console.error(`drift-slot: farm: ${r.fallback} — running it here`);
}

/** take `WEIGHT` free slots at once (all or none), or null */
const take = () => {
  const h = held();
  if (SLOTS - h.size < WEIGHT) return null;
  const mine = [];
  for (let i = 0; i < SLOTS && mine.length < WEIGHT; i++) {
    const f = join(DIR, `${i}.slot`);
    try {
      const fd = openSync(f, 'wx');
      writeSync(fd, `${process.pid}\n${cmd.join(' ').slice(0, 300)}`);
      closeSync(fd);
      mine.push(f);
    } catch {
      // held: try the next
    }
  }
  if (mine.length < WEIGHT) {
    for (const f of mine) unlinkSync(f);
    return null;
  }
  return mine;
};
const release = (mine) => {
  for (const f of mine) {
    try {
      unlinkSync(f);
    } catch {
      // already gone
    }
  }
};

let mine = take();
let said = 0;
const waitFile = join(DIR, `wait-${process.pid}`);
if (!mine) writeFileSync(waitFile, cmd.join(' ').slice(0, 300));
while (!mine) {
  if (Date.now() - said > 60000) {
    const h = held();
    console.error(`drift-slot: waiting for ${WEIGHT} of ${SLOTS} render slots — held by ${[...h.values()].map((v) => `pid ${v.pid} (${v.what.slice(0, 60)})`).join(', ')}`);
    said = Date.now();
  }
  await new Promise((r) => setTimeout(r, 3000));
  mine = take();
}
try {
  unlinkSync(waitFile);
} catch {
  // never waited
}
const log = createWriteStream(mine[0].replace(/\.slot$/, '.log'));
log.write(`${new Date().toISOString()}  ${cmd.join(' ').slice(0, 300)}\n`);
const child = spawn(cmd[0], cmd.slice(1), { stdio: ['inherit', 'pipe', 'pipe'] });
child.stdout.on('data', (b) => (process.stdout.write(b), log.write(b)));
child.stderr.on('data', (b) => (process.stderr.write(b), log.write(b)));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
child.on('close', (code, signal) => {
  release(mine);
  log.end(`\n${new Date().toISOString()}  exit ${code ?? signal}\n`, () => process.exit(code ?? (signal ? 1 : 0)));
});
