#!/usr/bin/env node
/**
 * THE DRIFT'S FARM COMMANDS, on this Mac (the hub is drift-dash's, :5190): a thin wrapper over the studio-farm
 * package's own command line (bin/farm.mjs of the sibling checkout ../studio-farm, STUDIO_FARM_DIR) with the Drift's
 * hub and token filled in, plus the two commands that are the film's: the full-show render and the consistency check.
 *
 *   node farm/cli.mjs render --from 0 --to 770 [--chunk 20] [--size 2048] [--priority low] [--fps 30] [--lanes 1]
 *        [--box <name>] [--clean] [--out out/drift/preview/<commit>/] [-- <more drift-render.mjs flags>]
 *   node farm/cli.mjs render --flat 2048 --from 0 --to 770 …   [-- <more drift-review-clip.mjs flags>]
 *   node farm/cli.mjs consistency [--boxes linux-monster,eeg-msi] [--width 960] [--shots f.json] [--no-mac] [--save-ref]
 *   node farm/cli.mjs kick <box> sync-now|gpu-check-now|restart|pause|resume|drain
 *   node farm/cli.mjs state <box> accepting|draining|paused|removed
 *   node farm/cli.mjs cancel --agent <name> | --all-low | <job id> …
 *   node farm/cli.mjs status [<id>] | logs <id> [-f] | workers | types        (the package's, as they are)
 *
 * render: THE WHOLE SHOW IN CHUNKS over every free box, joined here (farm/submit.mjs farmRender; the user,
 * 2026-10-30: "I gave you all the computer in the world and everything is idle"). Each chunk is one typed job —
 * drift-render@1, the dome master at --size², or with --flat <width> drift-review-clip@1, the 16:9 view of the focus
 * zone through the real pipeline (the user, 2026-10-30: the whole show "in both formats at 2K"; its frames are the
 * dome master's, t = from + n/fps, so the two line up frame for frame). At --priority low (the default) it fills the
 * gaps between the agents' review jobs. --box: every chunk on that box (a measurement). --clean: the COMMITTED state,
 * HEAD exactly (it must be on origin), not this checkout's work in progress — for a render that is kept (the
 * coordinator, 2026-10-30: a tree packed while another session was mid-edit hung every job of its window); without it
 * the live tree, checked to build first (drift-precheck.mjs). Each chunk lands as <out>/chunks/chunk_<from>-<to>.mp4;
 * one already there with its frame count is not rendered again, so the same command resumes; at the end they are
 * joined into <out>/show_<from>-<to>.mp4 (concat without re-encoding, its frame count checked). Ctrl-C cancels every
 * chunk it sent.
 *
 * consistency: do the machines draw the same film (scripts/drift-consistency.mjs, which reads its own flags).
 * kick, state, cancel: the console's controls, through this Mac's loopback (no token: `farm ctl`, `farm cancel`).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hubOf, tokenFileOf } from './submit.mjs';
import { STUDIO_FARM_DIR } from './package.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [what, ...rest] = process.argv.slice(2);
const say = (m) => console.log(`[farm render] ${m}`);

/** the package's command line, with the Drift's hub (and, `withToken`, the Mac's submitter token) */
function farmCli(args, { withToken = true } = {}) {
  const env = { ...process.env, FARM_HUB: hubOf() };
  if (withToken) env.FARM_TOKEN_FILE = tokenFileOf(ROOT);
  else delete env.FARM_TOKEN_FILE;
  const r = spawnSync(process.execPath, [join(STUDIO_FARM_DIR, 'bin', 'farm.mjs'), ...args], { stdio: 'inherit', env });
  if (r.error) console.error(`farm: ${r.error.message} (is the studio-farm checkout at ${STUDIO_FARM_DIR}?)`);
  process.exit(r.status ?? 1);
}

async function render(argv) {
  const dd = argv.indexOf('--');
  const opts = dd < 0 ? argv : argv.slice(0, dd);
  const extra = dd < 0 ? [] : argv.slice(dd + 1);
  const arg = (k, d) => (opts.includes(`--${k}`) ? opts[opts.indexOf(`--${k}`) + 1] : d);
  const from = Number(arg('from', '0'));
  const to = Number(arg('to', NaN));
  if (!Number.isFinite(to) || to <= from) throw new Error('--to <s> (the show is ~770 s: node scripts/drift-node.mjs length says exactly)');
  const flat = arg('flat', null) === null ? null : Number(arg('flat'));
  if (flat !== null && !(flat > 0 && flat % 2 === 0)) throw new Error(`--flat ${arg('flat')}: an even width in px`);
  const priority = arg('priority', 'low');
  if (!['low', 'normal', 'high'].includes(priority)) throw new Error(`--priority ${priority}: low | normal | high`);
  const clean = opts.includes('--clean');
  const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
  const head = git('rev-parse', '--short', 'HEAD').stdout.trim();
  const dirty = !clean && git('status', '--porcelain', '--untracked-files=no').stdout.trim() !== '';
  if (clean) {
    git('fetch', '--quiet', 'origin');
    if (git('merge-base', '--is-ancestor', 'HEAD', 'origin/main').status !== 0) throw new Error(`--clean: HEAD ${head} is not on origin/main — push it first (the boxes fetch the commit)`);
    say(`code: the commit ${head} exactly (--clean), nothing of this checkout's work in progress`);
  }
  const o = {
    root: ROOT, from, to, chunk: Number(arg('chunk', '20')), size: Number(arg('size', '2048')), flat, fps: Number(arg('fps', '30')), lanes: Number(arg('lanes', '1')),
    extra, priority, box: arg('box', null), clean, outDir: resolve(ROOT, arg('out', `out/drift/preview/${head}${dirty ? '+dirty' : ''}`)), stage: join(ROOT, 'out/drift/farm/stage', `render-${process.pid}`), say,
  };
  const n = Math.ceil(Math.round((to - from) * o.fps) / Math.round(o.chunk * o.fps));
  say(`[${from}, ${to}) s, ${flat ? `16:9 ${flat}×${Math.round((flat * 9) / 16 / 2) * 2}` : `dome ${o.size}²`}, ${o.fps} fps: ${n} chunks of ${o.chunk} s, ${priority} priority${o.box ? `, on ${o.box}` : ''} → ${o.outDir}`);
  const { farmRender } = await import('./submit.mjs');
  const t0 = Date.now();
  const r = await farmRender(o);
  if (r.missing.length) {
    say(`INCOMPLETE: ${r.missing.length} chunk(s) missing (${r.missing.map((c) => `${c.from}–${c.to}`).join(', ')}) — the same command renders only those`);
    process.exit(1);
  }
  say(r.joined ? `done: ${r.joined}, ${r.chunks.reduce((a, c) => a + c.frames, 0)} frames in ${((Date.now() - t0) / 60000).toFixed(1)} min` : 'the join failed (above): the chunks are all there');
  process.exit(r.joined ? 0 : 1);
}

if (what === 'render') {
  render(rest).catch((e) => {
    console.error(`[farm render] ${e.message}`);
    process.exit(2);
  });
} else if (what === 'consistency') {
  const { main } = await import('../scripts/drift-consistency.mjs');
  main().catch((e) => {
    console.error(`[consistency] ${e.message}`);
    process.exit(2);
  });
} else if (what === 'kick' && rest.length === 2) farmCli(['ctl', rest[0], 'command', rest[1]], { withToken: false });
else if (what === 'state' && rest.length === 2) farmCli(['ctl', rest[0], 'state', rest[1]], { withToken: false });
else if (what === 'cancel') farmCli(['cancel', ...rest], { withToken: false });
else if (['status', 'logs', 'workers', 'types'].includes(what)) farmCli([what, ...rest]);
else {
  console.error(readFileSync(new URL(import.meta.url), 'utf8').split('\n').slice(5, 15).map((l) => l.replace(/^ \* ?/, '')).join('\n'));
  process.exit(what === undefined || what === 'help' ? 0 : 2);
}
