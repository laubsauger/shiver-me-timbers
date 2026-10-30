/**
 * DOES THE CODE STATE BUILD? — before a farm job is packed (the coordinator, 2026-10-30: at 02:16 another agent's
 * loops.ts imported `packedSpiral` before events.ts exported it; every job packed in that window hung at boot on a
 * SyntaxError and held its box until someone cancelled it). Several sessions edit this tree at once, so a submit can
 * catch one of them half-way: this bundles the film's entry the way the page would load it — every import resolved,
 * every named import checked against the module's exports, every file parsed — with esbuild (Vite's own, already in
 * node_modules), in memory, nothing written. About a second. A state that does not build is refused with the
 * error and its file:line; it never reaches a box.
 *
 * Not checked: types (tsc is minutes, and a type error still runs) and the assets (`new URL(…, import.meta.url)`,
 * `?url`, `?raw`: left as they are).
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** the pages a farm job can boot */
export const ENTRIES = ['src/main-drift.ts'];

/** → { ok, ms, errors: [{ text, where }] } for the tree at `root` */
export async function precheck(root = ROOT, entries = ENTRIES) {
  const t0 = Date.now();
  // (a tree without the film's entry — a test's repository — has nothing to check)
  const present = entries.filter((e) => existsSync(join(root, e)));
  if (present.length === 0) return { ok: true, ms: 0, errors: [], skipped: true };
  const { build } = await import('esbuild');
  const assets = { name: 'assets', setup(b) {
    // (Vite's suffixes and the binary assets: not code, left to Vite)
    b.onResolve({ filter: /\?(url|raw|worker|inline)$/ }, (a) => ({ path: a.path, external: true }));
    b.onResolve({ filter: /\.(png|jpe?g|webp|ktx2|glb|gltf|hdr|exr|bin|woff2?|mp3|ogg|wav)$/ }, (a) => ({ path: a.path, external: true }));
  } };
  try {
    await build({
      entryPoints: present.map((e) => join(root, e)), absWorkingDir: root, bundle: true, write: false, format: 'esm', platform: 'browser',
      target: 'es2022', logLevel: 'silent', plugins: [assets], loader: { '.wgsl': 'text', '.glsl': 'text' },
    });
    return { ok: true, ms: Date.now() - t0, errors: [] };
  } catch (e) {
    const errors = (e.errors ?? [{ text: String(e.message) }]).slice(0, 8).map((x) => ({ text: x.text, where: x.location ? `${relative(root, join(root, x.location.file))}:${x.location.line}` : null }));
    return { ok: false, ms: Date.now() - t0, errors };
  }
}

/** the refusal, in words: what does not build, where */
export const precheckMessage = (r) => `the code here does not build (${r.errors.length} error(s), esbuild): ${r.errors.map((e) => `${e.where ? `${e.where}: ` : ''}${e.text}`).join(' | ')} — a session mid-edit? Submit again when it builds, or pack a commit (--clean)`;

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = await precheck();
  console.log(r.ok ? `builds (${r.ms} ms)` : precheckMessage(r));
  process.exit(r.ok ? 0 : 1);
}
