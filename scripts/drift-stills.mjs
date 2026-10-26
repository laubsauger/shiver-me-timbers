#!/usr/bin/env node
/**
 * Look-dev stills of The Drift's dome master: one headless Chromium on the GPU, one page, a handful of
 * show times, PNGs to out/drift/stills/<tag>_<t>.png. For review rounds — fast and light; motion goes
 * through scripts/drift-render.mjs (low-res x264), masters only after approval.
 *
 *   node scripts/drift-stills.mjs <tag> <t> [<t> ...] [--size 768] [--param key=value ...] [--query sea]
 *        [--channel chromium|chrome]   (chrome for the sea acts: see drift-render.mjs)
 *
 *   --param   set a live tunable (src/params/drift.ts) before rendering, e.g. --param bloomStrength=0 (A/B)
 *
 * Guards (docs/cine/drift-render.md, MACHINE GUARDS): at most 1024 px unless --allow-large; refuses to run
 * while a render holds out/drift/.render.lock; its own dev server (no watcher) and browser are closed on any
 * exit.
 */
import { existsSync, mkdirSync, readFileSync, statfsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const SIZE = Number(flag('size', '768'));
const positional = argv.filter((a, i) => !a.startsWith('--') && !argv[i - 1]?.startsWith('--'));
const params = argv.flatMap((a, i) => (a === '--param' ? [argv[i + 1]] : [])).map((kv) => {
  const [k, v] = kv.split('=');
  return [k, Number(v)];
});
const [tag, ...times] = positional;
if (!tag || times.length === 0) throw new Error('usage: drift-stills.mjs <tag> <t> [<t> ...] [--size 768]');
if (SIZE > 1024 && !argv.includes('--allow-large')) throw new Error(`--size ${SIZE}: above 1024 needs --allow-large`);
const LOCK = join(ROOT, 'out/drift/.render.lock');
if (existsSync(LOCK)) {
  const pid = Number(readFileSync(LOCK, 'utf8').trim());
  let alive = false;
  try {
    process.kill(pid, 0);
    alive = true;
  } catch {
    alive = false;
  }
  if (alive) throw new Error(`a render is running (pid ${pid}) — stills wait for it`);
}
const OUT = join(ROOT, 'out/drift/stills');
mkdirSync(OUT, { recursive: true });
const st = statfsSync(OUT);
if (st.bavail * st.bsize < 20 * 2 ** 30) throw new Error('less than 20 GB free — not writing stills');

let vite = null;
let browser = null;
const close = async () => {
  await browser?.close().catch(() => {});
  await vite?.close().catch(() => {});
};
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => void close().then(() => process.exit(130)));

try {
  vite = await createServer({ root: ROOT, clearScreen: false, logLevel: 'warn', cacheDir: join(ROOT, 'node_modules/.vite-drift-stills'), server: { port: 5293, strictPort: true, hmr: false, watch: null } });
  await vite.listen();
  browser = await chromium.launch({ channel: flag('channel', 'chromium'), headless: true });
  const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
  page.on('console', (m) => m.type() === 'error' && console.log('[console]', m.text().slice(0, 300)));
  page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
  const query = flag('query', null) ? `&${flag('query', '')}` : '';
  await page.goto(`http://localhost:5293/drift.html?t=${times[0]}&paused&view=dome&guides=0${query}`);
  await page.waitForFunction(() => '__drift' in window, null, { timeout: 60000 });
  await page.evaluate(
    ([s, kv]) => {
      window.__drift.params.domeFace = Math.ceil((s * 0.55) / 16) * 16;
      for (const [k, v] of kv) window.__drift.params[k] = v;
      document.getElementById('drift-hud').style.display = 'none';
    },
    [SIZE, params],
  );
  for (const t of times) {
    await page.evaluate((x) => window.__drift.setTime(x), Number(t));
    await new Promise((r) => setTimeout(r, 1200));
    const file = join(OUT, `${tag}_${t}.png`);
    await page.screenshot({ path: file });
    console.log(file);
  }
} finally {
  await close();
}
