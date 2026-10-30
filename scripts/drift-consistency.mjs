#!/usr/bin/env node
/**
 * DO THE MACHINES DRAW THE SAME FILM? (the coordinator, 2026-10-30: the dressing agent's farm stills from linux-monster
 * came out brighter than its own Mac render of the same view, sand at 137 against 123 — "if boxes render differently
 * from each other, master chunks from different machines will jump at the seams, and review stills will mislead").
 *
 *   node scripts/drift-farm.mjs consistency [--boxes linux-monster,windows-monster,eeg-msi] [--width 960]
 *        [--shots <file.json>] [--no-mac] [--keep] [--save-ref]
 *
 *   --save-ref   the Mac's clean tree also refreshes the GPU check's reference (drift-gpu-check.mjs --save-ref →
 *                scripts/drift-gpu-check.ref.json, at this commit): the frames every box's GPU check is held to
 *   --boxes ''   this Mac only
 *   --priority   high by default: the check gates a night's render, and waits behind no agent's review jobs
 *
 * Box against box too: the RMS between each pair of boxes per shot (two NVIDIA boxes on Vulkan and D3D12 — the Act 2
 * agent, 2026-10-30: "the same tree draws slightly differently on linux-monster and windows-monster")
 *
 * One fixed shot list (scripts/drift-consistency-shots.json: the beach at 604, the sea at 400, night at 744, space at
 * 150), drawn by the review pipeline (drift-review-stills.mjs, 16:9) at ONE code state on every machine at once:
 *   - the commit is HEAD, which must be on origin (the boxes fetch it); nothing of this checkout's work in progress
 *     goes along (packState `clean`), so every machine draws exactly that commit;
 *   - the assets are this Mac's, published first (drift-bundle.mjs --manifest-only): each box patches its bundle to
 *     them before it draws (its job asks for that bundle), the Mac's own run links the same files;
 *   - this Mac draws in a clean tree of the same commit (out/drift/consistency/<commit>/tree, through its own render
 *     slot), each box through the farm, pinned to it.
 * Then per shot and machine: mean luminance (Rec. 709 weights on the 8-bit sRGB values), the per-channel means, the
 * RMS against the Mac's still (0–255), the 99th percentile of the per-pixel difference, and a heatmap (|ΔY| × 8, as
 * grey) beside the stills. Everything lands in out/drift/consistency/<commit>/: <machine>/<shot>.png, diff/<machine>_
 * <shot>.png, report.json; the table is printed.
 *
 * WITHIN NOISE: RMS ≤ NOISE_RMS and |Δ mean luminance| ≤ NOISE_MEAN against the Mac (the same GPU drawing twice
 * differs by about 1/255 in the foam and the stars; another vendor's float arithmetic by a little more).
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** RMS (0–255) between two machines' stills that still counts as the same picture */
export const NOISE_RMS = 3;
/** |Δ mean luminance| (0–255) that still counts as the same exposure */
export const NOISE_MEAN = 1.5;

const argv = process.argv.slice(process.argv[2] === 'consistency' ? 3 : 2);
const arg = (k, d) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : d;
};
const has = (k) => argv.includes(`--${k}`);

const git = (...a) => spawnSync('git', ['-C', ROOT, ...a], { encoding: 'utf8' });
const say = (m) => console.log(`[consistency] ${m}`);

// ---------------------------------------------------------------------------------------------- the pictures
/** a PNG as 8-bit RGB (ffmpeg decodes it): { w, h, rgb } */
export function readRgb(file) {
  const p = spawnSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', file], { encoding: 'utf8' });
  const [w, h] = p.stdout.trim().split(',').map(Number);
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], { maxBuffer: 1 << 30 });
  if (r.status !== 0 || !(w > 0 && h > 0)) throw new Error(`cannot decode ${file}: ${String(r.stderr)}`);
  return { w, h, rgb: r.stdout };
}

const lum = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

/** the means of one picture: { y, r, g, b } (0–255) */
export function means({ rgb }) {
  let r = 0;
  let g = 0;
  let b = 0;
  const n = rgb.length / 3;
  for (let i = 0; i < rgb.length; i += 3) {
    r += rgb[i];
    g += rgb[i + 1];
    b += rgb[i + 2];
  }
  return { y: lum(r / n, g / n, b / n), r: r / n, g: g / n, b: b / n };
}

/** a picture against the reference: { rms, p99 } over all channels (0–255), and the |ΔY| heatmap (grey bytes) */
export function compare(a, ref) {
  if (a.w !== ref.w || a.h !== ref.h) throw new Error(`sizes differ: ${a.w}×${a.h} against ${ref.w}×${ref.h}`);
  let sq = 0;
  const hist = new Uint32Array(256);
  const heat = Buffer.alloc(a.w * a.h);
  for (let i = 0, k = 0; i < a.rgb.length; i += 3, k++) {
    const dr = a.rgb[i] - ref.rgb[i];
    const dg = a.rgb[i + 1] - ref.rgb[i + 1];
    const db = a.rgb[i + 2] - ref.rgb[i + 2];
    sq += dr * dr + dg * dg + db * db;
    const d = Math.max(Math.abs(dr), Math.abs(dg), Math.abs(db));
    hist[d]++;
    heat[k] = Math.min(255, Math.round(Math.abs(lum(dr, dg, db)) * 8));
  }
  const n = a.rgb.length / 3;
  let acc = 0;
  let p99 = 0;
  for (; p99 < 256; p99++) if ((acc += hist[p99]) >= 0.99 * n) break;
  return { rms: Math.sqrt(sq / a.rgb.length), p99, heat };
}

/** within noise of the reference (header: WITHIN NOISE) */
export const withinNoise = (m, ref, c) => c.rms <= NOISE_RMS && Math.abs(m.y - ref.y) <= NOISE_MEAN;

function writeGrey(file, w, h, bytes) {
  mkdirSync(dirname(file), { recursive: true });
  const r = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'gray', '-s', `${w}x${h}`, '-i', '-', file], { input: bytes });
  if (r.status !== 0) throw new Error(`heatmap ${file}: ${String(r.stderr)}`);
}

// ------------------------------------------------------------------------------------------------ the runs
const runCmd = (cmd, args, opts) =>
  new Promise((ok) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
    let out = '';
    const line = (prefix) => (c) => {
      out += c;
      for (const l of String(c).split('\n').filter(Boolean)) console.log(`${prefix} ${l}`);
    };
    p.stdout.on('data', line(opts.prefix));
    p.stderr.on('data', line(opts.prefix));
    p.on('close', (code) => ok({ code, out }));
  });

async function main() {
  const boxes = String(arg('boxes', 'linux-monster,windows-monster,eeg-msi') ?? '').split(',').filter(Boolean);
  const width = Number(arg('width', '960'));
  const shotsFile = resolve(arg('shots', join(ROOT, 'scripts/drift-consistency-shots.json')));
  const head = git('rev-parse', 'HEAD').stdout.trim();
  git('fetch', '--quiet', 'origin');
  if (git('merge-base', '--is-ancestor', head, 'origin/main').status !== 0) throw new Error(`HEAD ${head.slice(0, 7)} is not on origin/main: push it first (the boxes draw a commit they can fetch)`);
  const dir = join(ROOT, 'out/drift/consistency', head.slice(0, 7));
  mkdirSync(dir, { recursive: true });
  // the shots travel as an input (they need not be in the commit)
  const shots = join(dir, 'shots.json');
  copyFileSync(shotsFile, shots);
  const names = JSON.parse(readFileSync(shots, 'utf8')).map((s) => s.name);
  say(`commit ${head.slice(0, 7)}, ${names.length} shots (${names.join(', ')}), ${width} px wide; machines: ${has('no-mac') ? '' : 'this Mac, '}${boxes.join(', ')}`);

  // this Mac's assets, published: the boxes patch to exactly these files before they draw
  const pub = spawnSync(process.execPath, [join(ROOT, 'scripts/drift-bundle.mjs'), '--manifest-only'], { cwd: ROOT, encoding: 'utf8' });
  if (pub.status !== 0) throw new Error(`drift-bundle --manifest-only failed: ${pub.stderr}`);
  say(pub.stdout.trim().split('\n')[0].replace(/^\[bundle\] /, 'assets: '));

  const { applyState, packState, submit } = await import('./drift-farm-client.mjs');
  const token = JSON.parse(readFileSync(process.env.DRIFT_FARM_TOKEN_FILE ?? join(ROOT, 'farm.json'), 'utf8')).token;
  const hub = process.env.DRIFT_FARM_HUB ?? 'http://localhost:5190';
  const stillsArgs = (out, port) => ['scripts/drift-review-stills.mjs', shots, '--width', String(width), '--out', out, '--port', String(port), '--channel', 'chrome'];

  const runs = [];
  if (!has('no-mac')) {
    runs.push((async () => {
      // a clean tree of the commit beside the results, the assets linked from this checkout (applyState, as a box does)
      const jobDir = join(dir, 'tree-job');
      rmSync(jobDir, { recursive: true, force: true });
      mkdirSync(jobDir, { recursive: true });
      const { payload } = await packState({ root: ROOT, stage: join(dir, 'stage-mac'), base: head, clean: true });
      spawnSync('tar', ['-xzf', payload, '-C', jobDir]);
      const { tree } = await applyState({ main: ROOT, jobDir, say: (m) => say(`mac: ${m}`) });
      const out = join(dir, 'laubs-mbp');
      const r = await runCmd(process.execPath, [join(tree, 'scripts/drift-slot.mjs'), '--', 'node', ...stillsArgs(out, 5381)], {
        cwd: tree, prefix: '[mac]',
        env: { ...process.env, DRIFT_FARM: '', DRIFT_SLOTS_DIR: join(ROOT, 'out/drift/.slots'), DRIFT_NODE_CHROME: join(ROOT, 'out/drift/node-chrome.json') },
      });
      if (has('save-ref')) {
        // (git must not find this checkout above the tree: the reference names the commit itself, below)
        const g = await runCmd(process.execPath, [join(tree, 'scripts/drift-gpu-check.mjs'), '--save-ref', '--channel', 'chrome'], {
          cwd: tree, prefix: '[mac check]',
          env: { ...process.env, DRIFT_FARM: '', DRIFT_SLOTS_DIR: join(ROOT, 'out/drift/.slots'), GIT_CEILING_DIRECTORIES: dirname(tree) },
        });
        const made = join(tree, 'scripts/drift-gpu-check.ref.json');
        if (existsSync(made)) {
          const ref = JSON.parse(readFileSync(made, 'utf8'));
          writeFileSync(join(ROOT, 'scripts/drift-gpu-check.ref.json'), `${JSON.stringify({ ...ref, commit: head.slice(0, 7) })}\n`);
          say(`the GPU check's reference refreshed at ${head.slice(0, 7)} (scripts/drift-gpu-check.ref.json)${g.code !== 0 ? `; its check exited ${g.code}: read its lines above` : ''}`);
        } else say(`no GPU-check reference written (its check exited ${g.code})`);
      }
      if (!has('keep')) rmSync(jobDir, { recursive: true, force: true });
      return { machine: 'laubs-mbp', code: r.code };
    })());
  }
  for (const [k, box] of boxes.entries()) {
    runs.push((async () => {
      const r = await submit({
        root: ROOT, hub, token, prefer: box, stage: join(dir, `stage-${box}`), clean: true, base: head, priority: arg('priority', 'high'),
        argv: ['node', ...stillsArgs(join(dir, box), 5382 + k)],
        say: (m) => console.log(`[${box}] ${m}`), out: (s) => process.stdout.write(s.split('\n').filter(Boolean).map((l) => `[${box}] ${l}\n`).join('')),
      });
      return { machine: box, code: r.code ?? 1 };
    })());
  }
  const done = await Promise.all(runs);
  for (const d of done) if (d.code !== 0) say(`${d.machine}: exit ${d.code} (its stills, if any, are compared below)`);

  // ------------------------------------------------------------------------------------------- the comparison
  const machines = ['laubs-mbp', ...boxes].filter((m) => existsSync(join(dir, m)));
  const report = { commit: head, width, created: new Date().toISOString(), noise: { rms: NOISE_RMS, mean: NOISE_MEAN }, shots: {} };
  const rows = [];
  for (const name of names) {
    const ref = existsSync(join(dir, 'laubs-mbp', `${name}.png`)) ? readRgb(join(dir, 'laubs-mbp', `${name}.png`)) : null;
    const refM = ref ? means(ref) : null;
    report.shots[name] = {};
    for (const m of machines) {
      const f = join(dir, m, `${name}.png`);
      if (!existsSync(f)) {
        rows.push([name, m, 'missing']);
        continue;
      }
      const pic = readRgb(f);
      const mm = means(pic);
      const entry = { mean: mm };
      if (ref && m !== 'laubs-mbp') {
        const c = compare(pic, ref);
        writeGrey(join(dir, 'diff', `${m}_${name}.png`), pic.w, pic.h, c.heat);
        Object.assign(entry, { rms: c.rms, p99: c.p99, dY: mm.y - refM.y, same: withinNoise(mm, refM, c) });
      }
      report.shots[name][m] = entry;
      const f1 = (x) => x.toFixed(1);
      rows.push([name, m, `Y ${f1(mm.y)}  RGB ${f1(mm.r)} ${f1(mm.g)} ${f1(mm.b)}${entry.rms !== undefined ? `  ΔY ${entry.dY >= 0 ? '+' : ''}${f1(entry.dY)} (${f1((100 * entry.dY) / Math.max(1, refM.y))}%)  RMS ${f1(entry.rms)}  p99 ${entry.p99}  ${entry.same ? 'same' : 'DIFFERS'}` : m === 'laubs-mbp' ? '  (reference)' : '  (no reference from this Mac)'}`]);
    }
  }
  // box against box (header)
  const boxesHere = boxes.filter((b) => existsSync(join(dir, b)));
  const pairs = [];
  for (const name of names) {
    for (let i = 0; i < boxesHere.length; i++) {
      for (let k = i + 1; k < boxesHere.length; k++) {
        const fa = join(dir, boxesHere[i], `${name}.png`);
        const fb = join(dir, boxesHere[k], `${name}.png`);
        if (!existsSync(fa) || !existsSync(fb)) continue;
        const a = readRgb(fa);
        const b = readRgb(fb);
        const c = compare(a, b);
        const dY = means(a).y - means(b).y;
        pairs.push({ shot: name, a: boxesHere[i], b: boxesHere[k], rms: c.rms, p99: c.p99, dY });
        writeGrey(join(dir, 'diff', `${boxesHere[i]}_vs_${boxesHere[k]}_${name}.png`), a.w, a.h, c.heat);
      }
    }
  }
  report.pairs = pairs;
  writeFileSync(join(dir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  console.log('');
  for (const [s, m, t] of rows) console.log(`${s.padEnd(12)} ${m.padEnd(16)} ${t}`);
  if (pairs.length) {
    console.log('\nbox against box:');
    for (const p of pairs) console.log(`${p.shot.padEnd(12)} ${`${p.a} / ${p.b}`.padEnd(34)} RMS ${p.rms.toFixed(1)}  p99 ${p.p99}  ΔY ${p.dY >= 0 ? '+' : ''}${p.dY.toFixed(1)}${p.rms > NOISE_RMS || Math.abs(p.dY) > NOISE_MEAN ? '  DIFFERS' : ''}`);
  }
  const compared = Object.values(report.shots).flatMap((x) => Object.values(x)).filter((e) => e.same !== undefined).length;
  const differs = Object.values(report.shots).flatMap((x) => Object.entries(x).filter(([, e]) => e.same === false).map(([m]) => m));
  const verdict = compared === 0 ? 'NOTHING COMPARED (no box stills, or no reference from this Mac)' : differs.length === 0 ? 'every machine within noise of this Mac' : `differs beyond noise: ${[...new Set(differs)].join(', ')}`;
  console.log(`\n${verdict} — ${dir}`);
  process.exit(compared > 0 && differs.length === 0 ? 0 : 1);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url) || basename(process.argv[1] ?? '') === 'drift-farm.mjs') {
  main().catch((e) => {
    console.error(`[consistency] ${e.message}`);
    process.exit(2);
  });
}
