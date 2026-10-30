#!/usr/bin/env node
/**
 * A WHOLE RENDER ON THE FARM, IN CHUNKS (the user, 2026-10-30: "I gave you all the computer in the world and
 * everything is idle"): the show cut into short pieces, each one farm job (drift-render.mjs over its own
 * [from, to)), handed to whichever boxes are free — every box in `accepting` takes chunks at once — and joined on this
 * Mac when the last one is back. At `--priority low` (the default here) it fills the gaps between the agents' review
 * jobs and never holds one up: a box a queued normal job could use is not given a chunk (drift-farm.mjs PRIORITIES),
 * and a chunk of 20 s of show is the longest a review job waits.
 *
 *   node scripts/drift-farm.mjs render --from 0 --to 770 [--chunk 20] [--size 2048] [--priority low]
 *        [--fps 30] [--lanes 1] [--box <name>] [--out out/drift/preview/<commit>/] [-- <more drift-render.mjs flags>]
 *   node scripts/drift-farm.mjs render --flat 2048 --from 0 --to 770 …      [-- <more drift-review-clip.mjs flags>]
 *
 *   --flat <width>  THE 16:9 VERSION instead of the dome master (the user, 2026-10-30: the whole show "in both
 *                   formats at 2K"): each chunk a drift-review-clip.mjs over its range — the flat rectilinear view of
 *                   the focus zone through the real pipeline (dome.setFlat), the show's eye, as the review clips — at
 *                   <width>×<width>·9/16, its own default supersampling. Its frames are the dome master's, t = from +
 *                   n/fps (both draw through __drift.record), so the two versions line up frame for frame
 *   --box <name>    every chunk on that box (a measurement); by default whichever box is free
 *   --clean         the COMMITTED state, HEAD exactly (it must be on origin), not this checkout's work in progress —
 *                   for a render that is kept (the coordinator, 2026-10-30: a tree packed while another session was
 *                   mid-edit hung every job of its window); without it the live tree, checked to build first
 *                   (drift-precheck.mjs)
 *
 * THE CODE STATE is this checkout's, as for any farm job (HEAD's base on origin + the diff + untracked files), packed
 * ONCE for every chunk; the assets are the bundle the boxes sync. THE CHUNKS are cut on whole frames (every frame is a
 * pure function of show time, so chunks from different machines meet at the seams — tests/gpuSinHash.test.ts and
 * `drift-farm.mjs consistency` hold the machines to the same picture). Each lands as <out>/chunks/chunk_<from>-<to>.mp4;
 * one already there with its frame count is not rendered again, so the same command resumes. At the end the chunks
 * are joined into <out>/show_<from>-<to>.mp4 (drift-join.mjs: concat without re-encoding, its frame count checked).
 * The console says each chunk's progress in one line; a chunk that fails is listed, and running the command again
 * renders only what is missing.
 */
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { frameCountOf, joinClips } from './drift-join.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const all = process.argv.slice(process.argv[2] === 'render' ? 3 : 2);
const dd = all.indexOf('--');
const argv = dd < 0 ? all : all.slice(0, dd);
const extra = dd < 0 ? [] : all.slice(dd + 1);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const say = (m) => console.log(`[farm render] ${m}`);

/**
 * the chunks of [from, to) at `fps`, `chunk` s each, cut on whole frames (the last one shorter): [{ from, to, frames }]
 * — the times are frame boundaries, so drift-render.mjs's frame count (round((to − from)·fps)) is exactly `frames`
 */
export function chunksOf(from, to, chunk, fps) {
  const total = Math.max(0, Math.round((to - from) * fps));
  const per = Math.max(1, Math.round(chunk * fps));
  const out = [];
  for (let f = 0; f < total; f += per) {
    const n = Math.min(per, total - f);
    out.push({ from: +(from + f / fps).toFixed(6), to: +(from + (f + n) / fps).toFixed(6), frames: n });
  }
  return out;
}

const stamp = (t) => t.toFixed(3).padStart(8, '0');

async function main() {
  const from = Number(arg('from', '0'));
  const to = Number(arg('to', NaN));
  if (!Number.isFinite(to) || to <= from) throw new Error('--to <s> (the show is ~770 s: node scripts/drift-node.mjs length says exactly)');
  const chunk = Number(arg('chunk', '20'));
  const size = Number(arg('size', '2048'));
  const fps = Number(arg('fps', '30'));
  const lanes = Number(arg('lanes', '1'));
  const flat = arg('flat', null) === null ? null : Number(arg('flat'));
  if (flat !== null && !(flat > 0 && flat % 2 === 0)) throw new Error(`--flat ${arg('flat')}: an even width in px`);
  const box = arg('box', null);
  const clean = argv.includes('--clean');
  const priority = arg('priority', 'low');
  if (!['low', 'normal', 'high'].includes(priority)) throw new Error(`--priority ${priority}: low | normal | high`);
  const head = spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout.trim();
  const dirty = !clean && spawnSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8' }).stdout.trim() !== '';
  if (clean) {
    spawnSync('git', ['-C', ROOT, 'fetch', '--quiet', 'origin']);
    if (spawnSync('git', ['-C', ROOT, 'merge-base', '--is-ancestor', 'HEAD', 'origin/main']).status !== 0) throw new Error(`--clean: HEAD ${head} is not on origin/main — push it first (the boxes fetch the commit)`);
  }
  const out = resolve(ROOT, arg('out', `out/drift/preview/${head}${dirty ? '+dirty' : ''}`));
  const chunksDir = join(out, 'chunks');
  mkdirSync(chunksDir, { recursive: true });
  const kind = flat ? `_flat${flat}` : '';
  const chunks = chunksOf(from, to, chunk, fps).map((c) => ({ ...c, file: join(chunksDir, `chunk_${stamp(c.from)}-${stamp(c.to)}${kind}.mp4`) }));
  const have = chunks.filter((c) => existsSync(c.file) && frameCountOf(c.file) === c.frames);
  const todo = chunks.filter((c) => !have.includes(c));
  if (clean) say(`code: the commit ${head} exactly (--clean), nothing of this checkout's work in progress`);
  say(`[${from}, ${to}) s, ${flat ? `16:9 ${flat}×${Math.round((flat * 9) / 16 / 2) * 2}` : `dome ${size}²`}, ${fps} fps: ${chunks.length} chunks of ${chunk} s (${have.length} here already), ${priority} priority${box ? `, on ${box}` : ''} → ${out}`);

  const { packState, submit } = await import('./drift-farm-client.mjs');
  const token = (await import('node:fs')).readFileSync(process.env.DRIFT_FARM_TOKEN_FILE ?? join(ROOT, 'farm.json'), 'utf8');
  const hub = process.env.DRIFT_FARM_HUB ?? 'http://localhost:5190';
  // ONE code state for every chunk (header)
  const stage = join(ROOT, 'out/drift/farm/stage', `render-${process.pid}`);
  const packed = todo.length > 0 ? await packState({ root: ROOT, stage, say, ...(clean ? { clean: true, base: 'HEAD' } : {}) }) : null;
  // THE RUN, for the console's full-show tracker (drift-farm.mjs POST /farm/runs): its chunks, those here already marked
  const { submitterOf } = await import('./drift-farm-client.mjs');
  const runId = `${new Date().toISOString().slice(0, 19).replace(/[-:]/g, '').replace('T', '-')}-${flat ? 'flat' : 'dome'}-${process.pid}`;
  await fetch(`${hub}/farm/runs`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${JSON.parse(token).token}` }, signal: AbortSignal.timeout(10_000),
    body: JSON.stringify({ id: runId, kind: flat ? 'flat' : 'dome', label: `${flat ? `16:9 ${flat}` : `dome ${size}²`} [${from}, ${to}) s`, from, to, size: flat ?? size, priority, submitter: submitterOf(), chunks: chunks.map((c) => ({ from: c.from, to: c.to, here: have.includes(c) })) }),
  }).catch((e) => say(`(the console's tracker will not show this run: ${e.message})`));
  let done = have.length;
  const t0 = Date.now();
  // CTRL-C / SIGTERM CANCELS EVERY CHUNK it sent, and ends (the coordinator, 2026-10-30: a SIGINT to the full-show
  // preview cancelled nothing and left it running — every submit had its own handler, and the process waited on them)
  const sent = new Set();
  const call = (path) => fetch(`${hub}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(5000) });
  let stopping = false;
  const stop = async (sig) => {
    if (stopping) process.exit(130);
    stopping = true;
    say(`${sig}: cancelling ${sent.size} chunk job(s)`);
    await Promise.allSettled([...sent].map((id) => call(`/farm/jobs/${id}/cancel`)));
    rmSync(stage, { recursive: true, force: true });
    say('cancelled; the chunks already here stay (the same command resumes)');
    process.exit(130);
  };
  process.on('SIGINT', () => void stop('SIGINT'));
  process.on('SIGTERM', () => void stop('SIGTERM'));
  const results = await Promise.all(
    todo.map(async (c) => {
      const tag = `${c.from}–${c.to} s`;
      const r = await submit({
        root: ROOT, hub, token: JSON.parse(token).token, prefer: box ?? 'any', weight: flat ? 1 : lanes, priority, stage, packed, signals: false, onQueued: (id) => sent.add(id), run: { id: runId, i: chunks.indexOf(c) },
        argv: flat
          ? ['node', 'scripts/drift-review-clip.mjs', '--from', String(c.from), '--to', String(c.to), '--fps', String(fps), '--width', String(flat), '--channel', 'chrome', '--allow-long', '--allow-large', '--out', c.file, ...extra]
          : ['node', 'scripts/drift-render.mjs', '--size', String(size), '--fps', String(fps), '--from', String(c.from), '--to', String(c.to), '--channel', 'chrome', '--lanes', String(lanes), '--out', c.file, ...extra],
        // (one line a chunk: queued, its box, its end; the render's own lines stay in the hub's job log)
        say: (m) => {
          if (/queued|done on|failed on|cancelled|requeued|hub does not answer/.test(m)) say(`${tag}: ${m.replace(/^farm: /, '')}`);
        },
        out: () => {},
      }).catch((e) => ({ code: 1, error: e.message }));
      const ok = r.code === 0 && frameCountOf(c.file) === c.frames;
      if (ok) done++;
      say(`${tag}: ${ok ? 'back' : `NOT DONE (${r.error ?? `exit ${r.code}`}${existsSync(c.file) ? `, ${frameCountOf(c.file)} of ${c.frames} frames` : ''})`} — ${done}/${chunks.length} chunks, ${((Date.now() - t0) / 60000).toFixed(1)} min`);
      return ok;
    }),
  );
  rmSync(stage, { recursive: true, force: true });
  const missing = chunks.filter((c) => !(existsSync(c.file) && frameCountOf(c.file) === c.frames));
  if (missing.length > 0) {
    say(`INCOMPLETE: ${missing.length} chunk(s) missing (${missing.map((c) => `${c.from}–${c.to}`).join(', ')}) — the same command renders only those`);
    process.exit(1);
  }
  const F = chunks.reduce((a, c) => a + c.frames, 0);
  const joined = joinClips(chunks.map((c) => c.file), join(out, `show_${from}-${to}${flat ? '_flat' : ''}.mp4`), F, join(chunksDir, `concat${kind}.txt`), say);
  say(joined ? `done: ${joined}, ${F} frames, ${results.filter(Boolean).length} chunk(s) rendered now in ${((Date.now() - t0) / 60000).toFixed(1)} min` : 'the join failed (above): the chunks are all there');
  process.exit(joined ? 0 : 1);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url) || (process.argv[2] === 'render' && /drift-farm\.mjs$/.test(process.argv[1] ?? ''))) {
  main().catch((e) => {
    console.error(`[farm render] ${e.message}`);
    process.exit(2);
  });
}
