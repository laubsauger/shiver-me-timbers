#!/usr/bin/env node
/**
 * THE DRIFT'S DATA BUNDLES: what a render node needs that git does not carry (docs/drift/RENDER-NODE.md §Bundles).
 *
 *   node scripts/drift-bundle.mjs                     the assets: public/drift, what drift.html loads (~1.7 GB)
 *   node scripts/drift-bundle.mjs --refs              + the film's content folder, ../drift-narrative (direction docs,
 *                                                       review notes, references/ with its README of credits)
 *   node scripts/drift-bundle.mjs --renders latest    + review renders from out/drift: the newest whole-show master
 *        [--renders-include a.mp4,dir]                  and the review sheets (top-level stills, *_review/ folders)
 *   node scripts/drift-bundle.mjs --refs --no-assets  one target alone
 *   options: --out out/drift-bundle · --dry-run (list and size, write nothing) · --narrative <dir>
 *
 *   node scripts/drift-bundle.mjs --verify [manifest.json …] [--quick] [--base <dir>]
 *        on the node, after unpacking: every file of every bundle manifest found (out/drift-bundle/manifest-*.json,
 *        ../drift-narrative/.drift-bundle-manifest.json) is there with its size and sha256 (--quick: sizes only)
 *
 * FOR THE RENDER NODES (scripts/drift-node.mjs sync): beside each bundle, latest-<target>.json names the newest one,
 * its sha256 and the id of its files (`content`). A node pulls it straight from this folder over SSH on the tailnet
 * (or from a folder it was copied to by hand: copy the .tar.gz and its latest-assets.json), and only when `content`
 * differs from what it has unpacked. So publishing the current state is: commit and push, then run this.
 *
 * EACH BUNDLE is one .tar.gz, written here in node (the same bytes from any OS; no macOS extended attributes or ._
 * files), which every machine unpacks with its stock tar: `tar -xzf <bundle>` — Windows 10/11 ship tar.exe. Inside
 * is a manifest of every file (path, bytes, sha256), the archive's last entry:
 *   assets   unpack in the repo root      → public/drift/…, out/drift-bundle/manifest-assets.json
 *   renders  unpack in the repo root      → out/drift/…,    out/drift-bundle/manifest-renders.json
 *   refs     unpack BESIDE the repo (..)  → drift-narrative/…, drift-narrative/.drift-bundle-manifest.json
 *
 * WHAT THE ASSETS LEAVE OUT: raw sources that only feed a bake or an export whose output is in the bundle — checked
 * against the files drift.html actually fetches (drift-gpu-check.mjs --requests; any file it then misses fails
 * that check on the node, so a new loader of a left-out file is found, not rendered around):
 *   - .blend .zip .usdc .mtlx .tres: BlenderKit and ambientCG source files (the palms load as .glb)
 *   - ambientCG 4K maps (Ground027, Ground061): scripts/drift-pbr-pack.py packs them into packed/sand_*
 *   - Poly Haven texture sets packed into packed/ (scripts/drift-pbr-pack.py, drift-raft-pack.py): the rock, forest
 *     floor and grass layers; bamboo_wall(_03), thatch_roof_angled, weathered_planks for the raft
 *   - a prop's or a debris piece's .gltf + .bin + textures when its self-contained _prop.glb / _lod.glb is what loads
 *     (scripts/drift-prop-export.py, drift-tree-export.py, drift-rock-lod.py)
 * SOURCE_ONLY below lists them; `--dry-run` prints what it keeps and drops.
 *
 * LICENCES — THE BUNDLES ARE PRIVATE. The assets hold BlenderKit models (public/drift/pbr/blenderkit): royalty-free
 * for the user's own renders, NOT to be passed on. The bundle is for the user's own machines only: never in git,
 * never on a public share. The CC0 assets (Poly Haven, ambientCG) can instead be fetched again with
 * scripts/drift-pbr-fetch.py. The references are mostly Wikimedia Commons (CC BY / CC BY-SA / public domain) and NASA
 * (public domain): their credits are references/README.md, which travels with them.
 */
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, statfsSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import { spawnSync } from 'node:child_process';
import { userInfo } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGzip } from 'node:zlib';
import { contentId, pointerName, sha256File } from './drift-node-lib.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PARENT = dirname(ROOT);
const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
};
const flag = (name) => argv.includes(`--${name}`);
const OUT = resolve(ROOT, arg('out', 'out/drift-bundle'));
const NARRATIVE = resolve(ROOT, arg('narrative', '../drift-narrative'));
const gb = (b) => `${(b / 2 ** 30).toFixed(2)} GB`;
const mb = (b) => `${(b / 2 ** 20).toFixed(0)} MB`;
const posix = (p) => p.split(sep).join('/');

const LICENCE = {
  assets: 'PRIVATE. public/drift/pbr/blenderkit holds BlenderKit models: royalty-free for the owner\'s renders, not to be redistributed. Keep this bundle on your own machines: never in git, never on a public share. The CC0 assets can be re-fetched with scripts/drift-pbr-fetch.py.',
  refs: 'PRIVATE working folder. references/: mostly Wikimedia Commons (CC BY / CC BY-SA / public domain) and NASA (public domain); credits and licences per file in references/README.md (and .sources.tsv) — keep them with the images. Not for git.',
  renders: 'PRIVATE review renders of The Drift (they show the BlenderKit models): own machines only.',
};

// ------------------------------------------------------------------------------------------------- selection
/** never loaded by the page */
const NEVER = /\.(blend\d?|zip|usdc|usda|usd|mtlx|tres|part|tmp)$|(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini|__pycache__)(\/|$)/i;
/**
 * raw sources whose bake / export output is in the bundle (paths under public/drift/pbr/). Each line names the
 * script that consumes it. A model's source is listed only where its .glb loads INSTEAD (forest.ts's near trees and
 * plants.ts load their .gltf themselves and stay in).
 */
const SOURCE_ONLY = [
  // ambientCG 4K sets → packed/sand_* (drift-pbr-pack.py); their previews too
  /^(Ground027|Ground061)\//,
  // Poly Haven texture sets → packed/{rock,forest_floor,grass}_* (drift-pbr-pack.py)
  /^(rock_boulder_dry|forest_floor|sparse_grass)\//,
  // Poly Haven raft scans → packed/raft_* (drift-raft-pack.py); the game raft's → public/textures/raft (in git,
  // scripts/raft-scan-pack.py)
  /^(bamboo_wall|bamboo_wall_03|thatch_roof_angled|weathered_planks|rough_wood|reed_roof_04)\//,
  // props → <id>_prop.glb (drift-prop-export.py)
  // (and the floating debris' own cut, <id>_float.glb: getTheDrift/debrisField.ts)
  /^(Barrel_02|lifebuoy|metal_jerrycan_green|metal_jug|pot_enamel_01|wicker_basket_02|wooden_bowl_02|wooden_crate_01|wooden_crate_02|wooden_spoon)\/(?!.*_(prop|float)\.glb$)/,
  // ground debris and rocks → <id>_lod.glb (drift-tree-export.py, drift-rock-lod.py)
  /^(bark_debris_01|dead_tree_trunk|dead_tree_trunk_02|dry_branches_medium_01|root_cluster_01|single_root|shrub_02|shrub_03|coast_rocks_05|namaqualand_boulder_05)\/(?!.*_(lod|float)\.glb$)/,
];

function walk(dir, base) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) continue;
    if (e.isDirectory()) out.push(...walk(p, base));
    else if (e.isFile()) out.push(posix(relative(base, p)));
  }
  return out;
}

/**
 * every file under public/ that git does NOT carry (gitignored): what the page can load that a clone lacks. Without
 * git, public/drift (all of it is ignored). Untracked files that are not ignored reach the node only by a commit:
 * they are listed, not bundled (another session's new assets, until they are committed).
 */
function ignoredPublic() {
  const r = spawnSync('git', ['-C', ROOT, 'ls-files', '--others', '--ignored', '--exclude-standard', '-z', 'public'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  const u = spawnSync('git', ['-C', ROOT, 'ls-files', '--others', '--exclude-standard', '-z', 'public'], { encoding: 'utf8', maxBuffer: 1 << 26 });
  if (r.status !== 0) return { files: walk(join(ROOT, 'public/drift'), ROOT), untracked: [] };
  return { files: r.stdout.split('\0').filter(Boolean), untracked: u.status === 0 ? u.stdout.split('\0').filter(Boolean) : [] };
}

function selectAssets() {
  const keep = [];
  const drop = [];
  const { files, untracked } = ignoredPublic();
  if (untracked.length > 0) console.log(`[bundle] NOTE: ${untracked.length} untracked, not ignored file(s) under public/ reach a node only once committed and pushed: ${untracked.slice(0, 6).join(', ')}${untracked.length > 6 ? ', …' : ''}`);
  for (const rel of files) {
    const pbr = rel.startsWith('public/drift/pbr/') ? rel.slice('public/drift/pbr/'.length) : null;
    const why = NEVER.test(rel) ? 'never loaded' : pbr !== null && SOURCE_ONLY.some((r) => r.test(pbr)) ? 'bake/export source' : null;
    (why ? drop : keep).push({ path: rel, why });
  }
  return { base: 'repo', keep, drop };
}

function selectRefs() {
  if (!existsSync(NARRATIVE)) throw new Error(`no ${NARRATIVE} (--narrative <dir>)`);
  const name = basename(NARRATIVE);
  const keep = [];
  const drop = [];
  for (const rel of walk(NARRATIVE, dirname(NARRATIVE))) {
    // its own local git (no remote; its history is not the bundle's), editor caches, OS litter
    const why = new RegExp(`^${name}/(\\.git|\\.lh|node_modules)/`).test(rel) ? 'repository/cache' : NEVER.test(rel) ? 'litter' : null;
    (why ? drop : keep).push({ path: rel, why });
  }
  if (!keep.some((f) => f.path === `${name}/references/README.md`)) throw new Error(`${name}/references/README.md is missing: the references' credits must travel with them`);
  return { base: 'repo-parent', keep, drop };
}

function selectRenders(mode) {
  if (mode !== 'latest' && mode !== 'stills') throw new Error(`--renders ${mode}: latest | stills`);
  const dir = join(ROOT, 'out/drift');
  const top = readdirSync(dir, { withFileTypes: true });
  const keep = [];
  const add = (abs) => keep.push({ path: posix(relative(ROOT, abs)), why: null });
  // the review sheets: comparison stills at the top level, and the *_review/ folders
  for (const e of top) if (e.isFile() && /\.(png|jpe?g)$/i.test(e.name)) add(join(dir, e.name));
  for (const e of top) if (e.isDirectory() && /_review$/.test(e.name)) for (const f of walk(join(dir, e.name), ROOT)) if (!NEVER.test(f)) keep.push({ path: f, why: null });
  // the newest whole-show master (…_full_<size>.mp4/.mov, roughcut_…): every act is in it
  if (mode === 'latest') {
    const masters = top.filter((e) => e.isFile() && /(_full_|^roughcut_)/.test(e.name) && /\.(mp4|mov)$/.test(e.name)).map((e) => ({ f: join(dir, e.name), t: statSync(join(dir, e.name)).mtimeMs }));
    masters.sort((a, b) => b.t - a.t);
    if (masters[0]) add(masters[0].f);
  }
  for (const name of (arg('renders-include', '') || '').split(',').filter(Boolean)) {
    const abs = join(dir, name);
    if (!existsSync(abs)) throw new Error(`--renders-include ${name}: no out/drift/${name}`);
    if (statSync(abs).isDirectory()) for (const f of walk(abs, ROOT)) keep.push({ path: f, why: null });
    else add(abs);
  }
  return { base: 'repo', keep: [...new Map(keep.map((k) => [k.path, k])).values()], drop: [] };
}

const MANIFEST_IN_ARCHIVE = { assets: 'out/drift-bundle/manifest-assets.json', renders: 'out/drift-bundle/manifest-renders.json', refs: () => `${basename(NARRATIVE)}/.drift-bundle-manifest.json` };
const manifestPath = (target) => (typeof MANIFEST_IN_ARCHIVE[target] === 'function' ? MANIFEST_IN_ARCHIVE[target]() : MANIFEST_IN_ARCHIVE[target]);
const baseDir = (base) => (base === 'repo' ? ROOT : PARENT);

// --------------------------------------------------------------------------------------------- the tar writer
/** a ustar header; a pax 'x' record first when the path does not fit ustar's 155 + 100 bytes */
function tarHeaders(path, size, mtime) {
  const blocks = [];
  const field = (buf, off, len, str) => buf.write(str, off, Math.min(len, Buffer.byteLength(str)), 'utf8');
  const octal = (n, len) => n.toString(8).padStart(len - 1, '0');
  const header = (name, prefix, sz, type) => {
    const h = Buffer.alloc(512);
    field(h, 0, 100, name);
    field(h, 100, 8, '0000644');
    field(h, 108, 8, '0000000');
    field(h, 116, 8, '0000000');
    field(h, 124, 12, octal(sz, 12));
    field(h, 136, 12, octal(Math.floor(mtime / 1000), 12));
    h.fill(0x20, 148, 156);
    h[156] = type.charCodeAt(0);
    field(h, 257, 6, 'ustar');
    field(h, 263, 2, '00');
    field(h, 345, 155, prefix);
    let sum = 0;
    for (const b of h) sum += b;
    field(h, 148, 8, `${octal(sum, 7)}\0 `);
    return h;
  };
  let name = path;
  let prefix = '';
  const ascii = /^[\x20-\x7e]*$/.test(path);
  if (Buffer.byteLength(path) > 100) {
    const cut = path.lastIndexOf('/', 155);
    if (cut > 0 && Buffer.byteLength(path.slice(cut + 1)) <= 100) {
      prefix = path.slice(0, cut);
      name = path.slice(cut + 1);
    } else name = '';
  }
  if (name === '' || !ascii || size >= 8 ** 11) {
    // pax: "<len> path=<p>\n", len counting its own digits
    const rec = (k, v) => {
      const body = ` ${k}=${v}\n`;
      let len = Buffer.byteLength(body) + 1;
      while (String(len).length + Buffer.byteLength(body) !== len) len = String(len).length + Buffer.byteLength(body);
      return `${len}${body}`;
    };
    const pax = Buffer.from(rec('path', path) + (size >= 8 ** 11 ? rec('size', String(size)) : ''), 'utf8');
    blocks.push(header('PaxHeader', '', pax.length, 'x'), pax, Buffer.alloc((512 - (pax.length % 512)) % 512));
    name = path.slice(-100).replace(/^[^/]*\//, '');
    prefix = '';
  }
  blocks.push(header(name, prefix, size >= 8 ** 11 ? 0 : size, '0'));
  return blocks;
}

/** the bundle being written, removed when the run fails (a half-written .tar.gz.part is only disk taken) */
let partial = null;

async function writeBundle(target, sel) {
  const base = baseDir(sel.base);
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const file = join(OUT, `drift-${target}-${stamp}.tar.gz`);
  const sumBytes = sel.keep.reduce((a, f) => a + statSync(join(base, f.path)).size, 0);
  const st = statfsSync(existsSync(OUT) ? OUT : ROOT);
  if (st.bavail * st.bsize < sumBytes + 20 * 2 ** 30) throw new Error(`not enough disk for the ${target} bundle: ${gb(st.bavail * st.bsize)} free, it is up to ${gb(sumBytes)} and 20 GB must stay free`);
  mkdirSync(OUT, { recursive: true });
  const gz = createGzip({ level: 6 });
  const sink = createWriteStream(`${file}.part`);
  gz.pipe(sink);
  partial = `${file}.part`;
  const put = async (buf) => {
    if (!gz.write(buf)) await once(gz, 'drain');
  };
  const files = [];
  const t0 = Date.now();
  let done = 0;
  for (const f of sel.keep) {
    const abs = join(base, f.path);
    const s = statSync(abs);
    for (const h of tarHeaders(f.path, s.size, s.mtimeMs)) await put(h);
    const hash = createHash('sha256');
    let n = 0;
    // exactly the size the header promised: a file that changes while it is read (other sessions bake into
    // public/drift) must fail the bundle, not shift every entry after it
    if (s.size > 0) {
      for await (const chunk of createReadStream(abs, { start: 0, end: s.size - 1 })) {
        hash.update(chunk);
        n += chunk.length;
        await put(chunk);
      }
    }
    if (n !== s.size || statSync(abs).mtimeMs !== s.mtimeMs) throw new Error(`${f.path} changed while it was bundled (${n} of ${s.size} bytes) — run again when nothing is writing it`);
    await put(Buffer.alloc((512 - (s.size % 512)) % 512));
    files.push({ path: f.path, bytes: s.size, sha256: hash.digest('hex') });
    done += s.size;
    if (files.length % 50 === 0) process.stdout.write(`\r[bundle] ${target}: ${files.length}/${sel.keep.length} files, ${gb(done)} of ${gb(sumBytes)}`);
  }
  const commit = sel.base === 'repo' ? spawnSync('git', ['-C', ROOT, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).stdout?.trim() : undefined;
  const manifest = { bundle: target, created: new Date().toISOString(), base: sel.base, unpack: sel.base === 'repo' ? 'in the repo root: tar -xzf <bundle>' : 'beside the repo: tar -xzf <bundle> -C ..', ...(commit ? { commit } : {}), licence: LICENCE[target], bytes: done, count: files.length, files };
  const mbuf = Buffer.from(`${JSON.stringify(manifest, null, 1)}\n`);
  const mpath = manifestPath(target);
  for (const h of tarHeaders(mpath, mbuf.length, Date.now())) await put(h);
  await put(mbuf);
  await put(Buffer.alloc((512 - (mbuf.length % 512)) % 512));
  await put(Buffer.alloc(1024));
  gz.end();
  await once(sink, 'close');
  renameSync(`${file}.part`, file);
  partial = null;
  // the manifest beside the bundle too (the Mac keeps it; the node gets it from the archive)
  writeFileSync(join(OUT, `manifest-${target}.json`), mbuf);
  const size = statSync(file).size;
  process.stdout.write('\n');
  console.log(`[bundle] ${target}: ${file}`);
  console.log(`[bundle]   ${files.length} files, ${gb(done)} → ${gb(size)} gzipped, ${((Date.now() - t0) / 1000).toFixed(0)} s; unpack ${manifest.unpack}`);
  // THE POINTER the render nodes read first (scripts/drift-node.mjs sync; drift-node-lib.mjs, header): which tarball
  // is the newest, its sha256 (the copy's check) and `content`, the id of its files — the same for a rebuild that
  // changed nothing, so a publish without new assets costs a node a few hundred bytes, not 1.4 GB. Written last and
  // whole (a temp file renamed): a node reading it mid-build sees the old bundle's, whose tarball is still the old one
  const pointer = { bundle: target, file: basename(file), bytes: size, sha256: await sha256File(file), content: contentId(files), created: manifest.created, ...(commit ? { commit } : {}), count: files.length, filesBytes: done, unpack: manifest.unpack, licence: LICENCE[target] };
  writeFileSync(join(OUT, `${pointerName(target)}.part`), `${JSON.stringify(pointer, null, 1)}\n`);
  renameSync(join(OUT, `${pointerName(target)}.part`), join(OUT, pointerName(target)));
  console.log(`[bundle]   ${join(OUT, pointerName(target))}: content ${pointer.content.slice(0, 6)}, sha256 ${pointer.sha256.slice(0, 12)}…`);
  return { file, size, bytes: done, count: files.length };
}

function summarise(target, sel) {
  const base = baseDir(sel.base);
  const sz = (list) => list.reduce((a, f) => a + statSync(join(base, f.path)).size, 0);
  const byDir = new Map();
  for (const f of sel.keep) {
    const d = f.path.split('/').slice(0, f.path.startsWith('public/drift/pbr/') ? 4 : 3).join('/');
    byDir.set(d, (byDir.get(d) ?? 0) + statSync(join(base, f.path)).size);
  }
  console.log(`[bundle] ${target}: keep ${sel.keep.length} files, ${gb(sz(sel.keep))}; leave out ${sel.drop.length} files, ${gb(sz(sel.drop))}`);
  for (const [d, b] of [...byDir].sort((a, b) => b[1] - a[1]).slice(0, flag('dry-run') ? 60 : 12)) console.log(`           ${mb(b).padStart(7)}  ${d}`);
  if (flag('dry-run') && sel.drop.length) {
    const reasons = new Map();
    for (const f of sel.drop) reasons.set(f.why, (reasons.get(f.why) ?? 0) + statSync(join(base, f.path)).size);
    for (const [w, b] of reasons) console.log(`   dropped ${mb(b).padStart(7)}  ${w}`);
  }
}

// ---------------------------------------------------------------------------------------------------- verify
async function verify() {
  const given = argv.filter((a, i) => a.endsWith('.json') && argv[i - 1] !== '--out');
  const found = given.length > 0 ? given.map((g) => resolve(g)) : [
    ...(existsSync(join(ROOT, 'out/drift-bundle')) ? readdirSync(join(ROOT, 'out/drift-bundle')).filter((f) => /^manifest-\w+\.json$/.test(f)).map((f) => join(ROOT, 'out/drift-bundle', f)) : []),
    ...[join(NARRATIVE, '.drift-bundle-manifest.json')].filter(existsSync),
  ];
  if (found.length === 0) {
    console.error('[verify] no bundle manifest: unpack a bundle first (assets in the repo root, refs beside it), or pass the manifest');
    process.exit(1);
  }
  let bad = 0;
  for (const m of found) {
    const man = JSON.parse(readFileSync(m, 'utf8'));
    // --base: where the bundle was unpacked, when not in the repo (assets, renders) or beside it (refs)
    const base = arg('base', null) ? resolve(arg('base')) : baseDir(man.base);
    let missing = 0;
    let wrong = 0;
    const t0 = Date.now();
    for (const f of man.files) {
      const abs = join(base, f.path);
      if (!existsSync(abs)) {
        if (missing++ < 10) console.log(`  MISSING ${f.path}`);
        continue;
      }
      const size = statSync(abs).size;
      let ok = size === f.bytes;
      if (ok && !flag('quick')) {
        const h = createHash('sha256');
        for await (const c of createReadStream(abs)) h.update(c);
        ok = h.digest('hex') === f.sha256;
      }
      if (!ok && wrong++ < 10) console.log(`  DIFFERS ${f.path} (${size} bytes, the bundle's ${f.bytes})`);
    }
    const okAll = missing === 0 && wrong === 0;
    if (!okAll) bad++;
    console.log(`[verify] ${okAll ? 'PASS' : 'FAIL'} ${man.bundle} (${man.created.slice(0, 10)}${man.commit ? `, commit ${man.commit}` : ''}): ${man.count} files, ${gb(man.bytes)} under ${base}${missing ? `, ${missing} missing` : ''}${wrong ? `, ${wrong} differ` : ''}${flag('quick') ? ' (sizes only)' : ''}, ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    // a file the Mac has changed since: the node renders the old one. Not an error here, but say it.
    if (man.bundle === 'assets' && man.commit) console.log(`         (the bundle matches the repo at ${man.commit}; a newer bake on the Mac needs a newer bundle)`);
  }
  process.exit(bad === 0 ? 0 : 1);
}

// ------------------------------------------------------------------------------------------------------ main
async function main() {
  if (flag('verify')) return verify();
  const targets = [];
  if (!flag('no-assets')) targets.push('assets');
  if (flag('refs')) targets.push('refs');
  if (arg('renders', null)) targets.push('renders');
  if (targets.length === 0) throw new Error('nothing to bundle');
  const report = [];
  for (const t of targets) {
    const sel = t === 'assets' ? selectAssets() : t === 'refs' ? selectRefs() : selectRenders(arg('renders'));
    summarise(t, sel);
    if (!flag('dry-run')) report.push({ target: t, ...(await writeBundle(t, sel)) });
  }
  if (report.length) {
    console.log('\n[bundle] done:');
    for (const r of report) console.log(`  ${r.target.padEnd(8)} ${gb(r.size).padStart(9)}  ${r.file}`);
    console.log(`  ${LICENCE.assets}`);
    // what a render node's drift-node.json names to pull this over SSH (RENDER-NODE.md): this user and folder; the
    // host is this Mac's name in Tailscale (\`tailscale status\`), often its hostname in lower case
    if (report.some((r) => r.target === 'assets')) console.log(`  nodes pull it with drift-node.json: { "bundle": "${userInfo().username}@<this Mac's tailnet name>:${posix(OUT)}" } (then: node scripts/drift-node.mjs sync)`);
  }
}

main().catch((e) => {
  console.error(`\n[bundle] FAILED: ${e?.message ?? e}`);
  if (partial !== null) rmSync(partial, { force: true });
  process.exit(1);
});
