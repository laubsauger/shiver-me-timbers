/**
 * THE DRIFT'S SUBMITTER ON THE STUDIO FARM'S SDK: what `drift-slot.mjs --farm` and `drift-farm.mjs render` become
 * once they submit typed jobs. Not wired in yet (nothing imports this file): the switch to it is two call sites, after
 * every box runs the package's worker (an old worker never takes a typed job). The SDK comes from the sibling
 * studio-farm checkout (farm/package.mjs), loaded when a function here is called.
 *
 *   farmSubmit({ root, hub, tokenFile, argv, … })   a drift-slot command: a typed job when typedJobOf can say it
 *                                                    exactly (review clip, review stills, a render chunk), else
 *                                                    { legacy: true } and the caller sends it as today
 *   farmRender({ root, hub, tokenFile, from, to, … }) a whole render in chunks: one code state for all, one group,
 *                                                    one drift-render@1 job per chunk at low priority, the chunks
 *                                                    landed and joined (concatJoin, its frame count checked)
 *
 * The code state is the same as today's (PACK: the git diff against origin/main, untracked files under src scripts
 * tests public, the assets the boxes' set lacks up to 200 MB), checked to build first (drift-precheck.mjs).
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ASSET_SET, PACK, assetOverlay, typedJobOf } from './drift.adapter.mjs';
import { fromPackage } from './package.mjs';

const imp = (root, f) => import(pathToFileURL(join(root, 'scripts', f)).href);

/** the Drift's code state for a farm job (header), packed in `stage` → { payload, meta } */
export async function packDrift({ root, stage, clean = false, base = 'origin/main', say = () => {} }) {
  const [{ packGitDiff }, { contentId }] = await Promise.all([fromPackage('src/sdk.mjs'), fromPackage('src/artifacts.mjs')]);
  const manifestFile = join(root, ASSET_SET.worker.installedManifest);
  const manifest = existsSync(manifestFile) ? JSON.parse(readFileSync(manifestFile, 'utf8')) : null;
  return packGitDiff({
    root, stage, base, clean, ...PACK, say,
    meta: { bundle: manifest ? contentId(manifest.files) : null },
    precheck: async (r) => {
      const { precheck, precheckMessage } = await imp(r, 'drift-precheck.mjs');
      const pc = await precheck(r);
      return { ok: pc.ok, message: pc.ok ? '' : precheckMessage(pc) };
    },
    // the assets the boxes' set lacks: what a bundle would hold now (drift-bundle.mjs --list-json) against the last one
    extra: async () => {
      const list = join(stage, 'assets-now.json');
      mkdirSync(stage, { recursive: true });
      const r = spawnSync(process.execPath, [join(root, 'scripts/drift-bundle.mjs'), '--list-json', list], { cwd: root, encoding: 'utf8', windowsHide: true });
      if (r.status !== 0) throw new Error(`drift-bundle --list-json failed: ${r.stderr}`);
      return assetOverlay(JSON.parse(readFileSync(list, 'utf8')), manifest).map((f) => ({ path: f.path, bytes: f.bytes, why: f.why }));
    },
  });
}

/** a drift-slot command on the farm as a typed job → { code, job } or { legacy: true } (the caller sends it as today) */
export async function farmSubmit({ root, hub, tokenFile, argv, prefer = null, priority = 'normal', stage, say = console.error, out = (s) => process.stdout.write(s), cwd = process.cwd() }) {
  const typed = typedJobOf(argv, { cwd });
  if (!typed) return { legacy: true };
  const { createClient, submitterOf } = await fromPackage('src/sdk.mjs');
  const farm = createClient({ hub, tokenFile });
  const { payload } = await packDrift({ root, stage, say });
  try {
    const { job, code } = await farm.run(
      { ...typed.spec, label: argv.join(' ').slice(0, 160), priority, ...(prefer && prefer !== 'auto' && prefer !== 'any' ? { prefer } : {}), submitter: submitterOf() },
      { code: payload, inputs: typed.inputs, land: typed.land, say, onLog: (lines, j) => out(lines.map((l) => `[farm ${j.node ?? '?'}] ${l}\n`).join('')) },
    );
    say(`farm: job ${job.id} ${job.state} on ${job.node} (exit ${job.exitCode ?? '—'})${job.error ? `: ${job.error}` : ''}`);
    return { code, job };
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

/**
 * a whole render in chunks over the farm (today's drift-farm-render.mjs, on the SDK): → { joined, missing }.
 * Chunks already landed with their frame count are not rendered again, so the same call resumes.
 */
export async function farmRender({ root, hub, tokenFile, from, to, chunk = 20, size = 2048, fps = 30, lanes = 1, extra = undefined, priority = 'low', prefer = null, outDir, stage, clean = false, say = console.log }) {
  const { chunksOf, concatJoin, createClient, frameCountOf, submitterOf } = await fromPackage('src/sdk.mjs');
  const farm = createClient({ hub, tokenFile });
  const chunks = chunksOf(from, to, chunk, fps).map((c) => ({ ...c, file: join(outDir, 'chunks', `chunk_${c.from.toFixed(3).padStart(8, '0')}-${c.to.toFixed(3).padStart(8, '0')}.mp4`) }));
  mkdirSync(join(outDir, 'chunks'), { recursive: true });
  const todo = chunks.filter((c) => !(existsSync(c.file) && frameCountOf(c.file) === c.frames));
  const groupId = `drift-${size}-${process.pid}-${Date.now().toString(36)}`;
  await farm.group({ id: groupId, label: `dome ${size}² [${from}, ${to}) s`, meta: { kind: 'dome', from, to, size, fps, chunk }, size: chunks.length });
  const { payload } = todo.length ? await packDrift({ root, stage, clean, base: clean ? 'HEAD' : 'origin/main', say }) : { payload: null };
  try {
    await Promise.all(todo.map(async (c) => {
      const i = chunks.indexOf(c);
      const { job } = await farm.run(
        { type: 'drift-render@1', params: { from: c.from, to: c.to, size, fps, lanes, ...(extra ? { extra } : {}) }, priority, ...(prefer ? { prefer } : {}), group: { id: groupId, index: i }, label: `chunk ${c.from}–${c.to} s`, submitter: submitterOf() },
        { code: payload, land: { chunk: { file: c.file } } },
      );
      say(`${c.from}–${c.to} s: ${job.state}${job.node ? ` on ${job.node}` : ''}`);
    }));
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
  const missing = chunks.filter((c) => !(existsSync(c.file) && frameCountOf(c.file) === c.frames));
  if (missing.length) return { joined: null, missing };
  const F = chunks.reduce((a, c) => a + c.frames, 0);
  return { joined: concatJoin(chunks.map((c) => c.file), join(outDir, `show_${from}-${to}.mp4`), F, { list: join(outDir, 'chunks', 'concat.txt'), say }), missing: [] };
}
