/**
 * THE DRIFT'S ADAPTER for the studio farm package (studio-farm, a sibling checkout: STUDIO_FARM_DIR, default
 * ../studio-farm; farm/package.mjs): everything of the farm that is the film's and not the farm's, in one module.
 * The types in farm/types/*.json name it as their "hooks" ("farm/drift.adapter.mjs", resolved inside each job's own
 * tree), drift-dash's hub takes its jobKind and jobClass through farm/hub-hooks.mjs, and farm/submit.mjs is the
 * Mac's submitter on the package's SDK. It imports nothing from the package: Node built-ins only.
 *
 * WORKER HOOKS (the package's src/worker.mjs loads them for drift-render@1, drift-review-clip@1,
 * drift-review-stills@1 and, through the worker config's legacy.hooks, for legacy-argv@1 during the migration):
 *   progress(line, prev)    the scripts' "[review|render] n/N x fps" lines, and one line per review still
 *   timing(line, timing)    "first frame … s after launch" (the boot) and "shader cache: warm|cold"
 *   checkOutput(file, ctx)  IS IT A PICTURE: scripts/drift-sanity.mjs of the job's own tree (a pure-black still, a
 *                           clip that drops to black: a lost device) — the job fails and goes to another box
 *   preflight(ctx)          the box's last drift-gpu-check is on record and passed (out/drift/node-state.json)
 *   env(ctx)                DRIFT_FARM off (no farm loop inside a farm job), the box's own Chrome flags
 *                           (DRIFT_NODE_CHROME: the checkout's, not the tree's), DRIFT_PREVIEW_FILE (the farm's
 *                           FARM_PREVIEW_FILE), DRIFT_SLOTS_DIR (the box's slots)
 * HUB HOOKS (the hub's legacy.hooks, for /farm/jobs while the Drift still sends argv): jobKind, jobClass.
 * SUBMITTER (scripts/drift-slot.mjs --farm and drift-farm-render.mjs, after the switch): the code state's paths
 * (PACK), the asset overlay (what the boxes' set lacks), the precheck, and `typedJobOf(argv)`: a drift-slot command line
 * mapped to a typed job, so only what the types cannot say still goes as legacy-argv.
 * WORKSPACE (a box's farm-worker.json "workspaces.smt"): WORKSPACE below — the asset set, the warm Vite caches, the
 * env — and OURS, what share.mjs counts as the farm's own GPU processes.
 *
 * Everything here is lifted from shiver-me-timbers at 4f197c1 (scripts/drift-farm.mjs, drift-farm-client.mjs,
 * drift-share.mjs, drift-node.mjs), with the line it came from.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

// ------------------------------------------------------------------------------------------------ the workspace
/** the scripts' Vite dependency caches (drift-farm-client.mjs:58 VITE_CACHES): linked from the box's into each job */
export const VITE_CACHES = ['.vite-drift-render', '.vite-drift-review-stills', '.vite-drift-review-clip', '.vite-drift-check', '.vite-drift-node', '.vite-drift-stills'];
/** our processes on the GPU (drift-share.mjs:213 OURS): the drift / cine scripts, and a Chrome on Playwright's profile */
export const OURS = 'scripts[/\\\\](?:drift|cine)-[\\w.-]+\\.mjs|playwright_chromiumdev_profile';
/** the asset bundle as an artifact set: where drift-bundle.mjs puts it (hub) and where a box has it installed */
export const ASSET_SET = {
  name: 'drift-assets',
  hub: { dir: 'out/drift-bundle', root: '.', manifest: 'manifest-assets.json', pointer: 'latest-assets.json', tarball: '^drift-assets-\\d{8}\\.tar\\.gz$', prefix: 'public/' },
  worker: { prefix: 'public/', installedManifest: 'out/drift-bundle/manifest-assets.json', index: 'out/drift-bundle/hash-index.json' },
};
/** a box's workspace "smt" (its farm-worker.json): the checkout, the set, packages linked, warm caches, env */
export const WORKSPACE = {
  assetSets: { 'drift-assets': ASSET_SET.worker },
  modules: 'npm',
  warm: VITE_CACHES,
  followHead: true,
  env: { DRIFT_FARM: '', DRIFT_NODE_CHROME: '{workspace}/out/drift/node-chrome.json', DRIFT_PREVIEW_FILE: '{preview}', DRIFT_SLOTS_DIR: '{workspace}/out/drift/.slots' },
};
/** what a code state carries (drift-farm-client.mjs:188): untracked files under these, not public/drift (the set's) */
export const PACK = { include: ['src', 'scripts', 'tests', 'public'], exclude: ['public/drift/'], maxExtraMB: 200 };

// ------------------------------------------------------------------------------------------------- worker hooks
/** progress from a job's output line (drift-farm-client.mjs:131 progressOf) */
export function progress(line, p = { done: null, total: null, unit: null, fps: null, etaS: null }) {
  const m = /\[(review|render)\] (\d+)\/(\d+)\s+([\d.]+) fps/.exec(line);
  if (m) {
    const [done, total, fps] = [Number(m[2]), Number(m[3]), Number(m[4])];
    return { done, total, unit: 'frames', fps, etaS: fps > 0 ? Math.round((total - done) / fps) : null };
  }
  if (/\[review\] \S+\.(png|jpe?g)\s/.test(line)) return { ...p, done: (p.done ?? 0) + 1, unit: 'stills' };
  return p;
}

/** the boot and the shader cache, from the scripts' own lines (drift-farm-client.mjs:701–704) */
export function timing(line, t) {
  const fb = /first frame ([\d.]+) s after launch/.exec(line);
  if (fb && t.bootMs === null) t.bootMs = Math.round(Number(fb[1]) * 1000);
  const sc = /shader cache: (warm|cold)/.exec(line);
  if (sc) t.cache = t.cache === 'cold' ? 'cold' : sc[1];
}

/** the files drift-sanity.mjs looks at (drift-sanity.mjs:56 LOOKED_AT) */
export const LOOKED_AT = /\.(png|jpe?g|webp|mp4|mov|mkv)$/i;
/** IS IT A PICTURE (drift-farm-client.mjs:620–640): drift-sanity.mjs of the job's tree (its code, its thresholds) */
export async function checkOutput(file, ctx) {
  if (!LOOKED_AT.test(file)) return null;
  const root = ctx?.tree ?? ctx?.workspaceRoot;
  const f = root && join(root, 'scripts', 'drift-sanity.mjs');
  if (!f || !existsSync(f)) return null;
  const { checkOutput: check } = await import(pathToFileURL(f).href);
  return check(file);
}

/** the box's GPU check on record (drift-node.mjs:475 gpuCheck: PASS | FAIL | ASKED); none yet: let it run */
export function preflight(ctx) {
  try {
    const st = JSON.parse(readFileSync(join(ctx.workspaceRoot, 'out', 'drift', 'node-state.json'), 'utf8'));
    if (st.gpuCheck?.result === 'FAIL') return { ok: false, why: `this box's last drift-gpu-check failed (${st.gpuCheck.at ?? '?'}): node scripts/drift-node.mjs sync --gpu-check` };
  } catch {
    // (no state: a box that never synced through drift-node; the render's own errors say what is wrong)
  }
  return { ok: true };
}

/** GB of free VRAM a job needs (drift-share.mjs:91 needVramGB): 22 a lane at 8192², else 10; the policy's own figure first */
export function needVramGB(job, policy = {}) {
  const lanes = Math.max(1, Number(job?.lanes ?? 1));
  const perLane = Number.isFinite(policy.needVramGB) ? policy.needVramGB : (job?.size ?? 0) >= 8192 ? 22 : 10;
  return perLane * lanes;
}

// ---------------------------------------------------------------------------------------------------- hub hooks
/** what kind of work a legacy command is (drift-farm.mjs:127 jobKind) */
export function jobKind(argv) {
  const s = argv.join(' ');
  if (/drift-(review-)?stills\.mjs/.test(s)) return 'still';
  if (/drift-(render|queue|node)\.mjs/.test(s)) return 'long';
  return 'clip';
}
/** the class a legacy command's speed is measured in (drift-farm.mjs:135 jobClass) */
export function jobClass(argv) {
  const script = argv.map((a) => basename(String(a))).find((a) => a.endsWith('.mjs')) ?? argv[0] ?? '?';
  const size = (() => {
    for (const f of ['--width', '--size']) {
      const i = argv.indexOf(f);
      if (i >= 0 && /^\d+$/.test(argv[i + 1] ?? '')) return argv[i + 1];
    }
    return argv.find((a) => /^\d{3,5}$/.test(a)) ?? '-';
  })();
  return `${script}:${size}`;
}

// ---------------------------------------------------------------------------------------------------- submitter
/** the asset files the boxes' set lacks (drift-farm-client.mjs:143 assetOverlay): new, resized, or touched */
export function assetOverlay(now, manifest) {
  const had = new Map((manifest?.files ?? []).map((f) => [f.path, f]));
  const created = manifest?.created ? Date.parse(manifest.created) : 0;
  const out = [];
  for (const f of now) {
    const m = had.get(f.path);
    if (!m) out.push({ ...f, why: 'new' });
    else if (m.bytes !== f.bytes) out.push({ ...f, why: 'changed' });
    else if (f.mtimeMs > created) out.push({ ...f, why: 'touched', sha256: m.sha256 });
  }
  return out;
}

const OUT_FLAGS = new Set(['--out', '--out-dir', '--outdir', '-o']);
/** a flag's value in argv (`--k v` or `--k=v`), or null */
const flagOf = (argv, k) => {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === k) return argv[i + 1] ?? null;
    if (argv[i].startsWith(`${k}=`)) return argv[i].slice(k.length + 1);
  }
  return null;
};
const has = (argv, k) => argv.includes(k);
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v));

/**
 * A DRIFT-SLOT COMMAND LINE AS A TYPED JOB (what `drift-slot.mjs --farm` sends after the switch): → { spec, inputs,
 * land } for the SDK's run(), or null when the command is not one the types say exactly (then it goes as legacy-argv,
 * as today). Only the flags each type declares are taken; any other flag, an unknown script, or a path the box would
 * have to guess makes it null — never a silent drop of a flag.
 */
export function typedJobOf(argv0, { cwd = process.cwd() } = {}) {
  const argv = argv0[0] && /(^|[/\\])node(\.exe)?$/.test(argv0[0]) ? argv0.slice(1) : argv0;
  const script = basename(argv[0] ?? '');
  const rest = argv.slice(1);
  const out = flagOf(rest, '--out');
  const known = (names, bools = []) => {
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (!a.startsWith('-')) continue;
      const k = a.split('=')[0];
      if (bools.includes(k)) continue;
      if (!names.includes(k)) return false;
      if (!a.includes('=')) i++;
    }
    return true;
  };
  if (script === 'drift-review-clip.mjs') {
    if (!known(['--from', '--to', '--width', '--fps', '--ss', '--query', '--shot', '--setup', '--out', '--channel'], ['--dome', '--flat-track', '--allow-long', '--allow-large'])) return null;
    if ((flagOf(rest, '--channel') ?? 'chrome') !== 'chrome' || !out) return null;
    const params = { from: num(flagOf(rest, '--from')), to: num(flagOf(rest, '--to')), width: num(flagOf(rest, '--width')) ?? 1280, fps: num(flagOf(rest, '--fps')) ?? 30, dome: has(rest, '--dome'), flatTrack: has(rest, '--flat-track'), ss: num(flagOf(rest, '--ss')), query: flagOf(rest, '--query') ?? '', shot: flagOf(rest, '--shot'), setup: flagOf(rest, '--setup'), allowLong: has(rest, '--allow-long'), allowLarge: has(rest, '--allow-large') };
    return { spec: { type: 'drift-review-clip@1', params }, inputs: {}, land: { clip: { file: resolve(cwd, out) } } };
  }
  if (script === 'drift-review-stills.mjs') {
    const shots = rest[0] && !rest[0].startsWith('-') ? resolve(cwd, rest[0]) : null;
    if (!shots || !known(['--width', '--ss', '--query', '--setup', '--post', '--out', '--channel'], ['--dome', '--allow-large']) || (flagOf(rest, '--channel') ?? 'chrome') !== 'chrome') return null;
    if (rest.slice(1).some((a, i) => !a.startsWith('-') && !rest[i].startsWith('-'))) return null; // (a second positional: not this type's)
    const params = { width: num(flagOf(rest, '--width')) ?? 1280, dome: has(rest, '--dome'), ss: num(flagOf(rest, '--ss')), query: flagOf(rest, '--query') ?? '', setup: flagOf(rest, '--setup'), post: flagOf(rest, '--post'), allowLarge: has(rest, '--allow-large') };
    const dest = resolve(cwd, out ?? join('out/drift/review', basename(shots, '.json')));
    return { spec: { type: 'drift-review-stills@1', params }, inputs: { shots }, land: { stills: dest } };
  }
  if (script === 'drift-render.mjs') {
    const flags = { '--blur': 'int', '--ss': 'number', '--codec': 'string', '--depth': 'int', '--msaa': 'int', '--shutter': 'number', '--crf': 'int', '--query': 'string' };
    if (!known(['--size', '--fps', '--from', '--to', '--lanes', '--out', '--channel', ...Object.keys(flags)], ['--allow-lanes']) || (flagOf(rest, '--channel') ?? 'chrome') !== 'chrome' || !out) return null;
    const extra = {};
    for (const [k, t] of Object.entries(flags)) {
      const v = flagOf(rest, k);
      if (v !== null) extra[k] = t === 'string' ? v : Number(v);
    }
    if (has(rest, '--allow-lanes')) extra['--allow-lanes'] = true;
    const ext = /\.(mp4|mov|mkv)$/i.exec(out)?.[1]?.toLowerCase() ?? 'mp4';
    const params = { from: num(flagOf(rest, '--from')) ?? 0, to: num(flagOf(rest, '--to')), size: num(flagOf(rest, '--size')) ?? 2048, fps: num(flagOf(rest, '--fps')) ?? 30, lanes: num(flagOf(rest, '--lanes')) ?? 1, ext, ...(Object.keys(extra).length ? { extra } : {}) };
    return { spec: { type: 'drift-render@1', params }, inputs: {}, land: { chunk: { file: resolve(cwd, out) } } };
  }
  return null;
}

/**
 * the legacy argv remapping (drift-farm-client.mjs:72 remapArgv), kept for what typedJobOf cannot say: `{{in:i}}` for
 * an uploaded input, `{{out:i}}` for an out path, repo files as paths relative to the code tree. `shipped(rel)`: is
 * this repo-relative file in the job's tree.
 */
export function remapArgv(argv, { root, cwd = root, shipped }) {
  const out = [];
  const inputs = [];
  const outs = [];
  for (let k = 0; k < argv.length; k++) {
    const a = argv[k];
    const eq = /^(--[\w-]+)=(.*)$/.exec(a);
    const flagName = eq ? eq[1] : null;
    const value = eq ? eq[2] : a;
    const prefix = eq ? `${eq[1]}=` : '';
    if (k === 0 && /^node(\.exe)?$|[/\\]node(\.exe)?$/.test(a)) {
      out.push('node');
      continue;
    }
    if ((flagName && OUT_FLAGS.has(flagName)) || (!flagName && OUT_FLAGS.has(argv[k - 1]))) {
      const local = resolve(cwd, value);
      const i = outs.length;
      outs.push({ i, local, file: /\.[a-z0-9]{2,5}$/i.test(basename(local)) });
      out.push(`${prefix}{{out:${i}}}`);
      continue;
    }
    if (!eq && a.startsWith('-')) {
      out.push(a);
      continue;
    }
    const abs = resolve(cwd, value);
    let isFile = false;
    try {
      isFile = value !== '' && statSync(abs).isFile();
    } catch {
      isFile = false;
    }
    if (isFile) {
      const rel = relative(root, abs);
      if (!rel.startsWith('..') && !isAbsolute(rel) && shipped(rel.split(sep).join('/'))) out.push(prefix + rel.split(sep).join('/'));
      else {
        const i = inputs.length;
        inputs.push({ i, local: abs, name: basename(abs) });
        out.push(`${prefix}{{in:${i}}}`);
      }
      continue;
    }
    out.push(a);
  }
  return { argv: out, inputs, outs };
}

export default { progress, timing, checkOutput, preflight, env: () => ({}) };
