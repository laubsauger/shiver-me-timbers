/**
 * THE PAGE THE REVIEW SCRIPTS DRIVE (scripts/drift-review-stills.mjs, scripts/drift-review-clip.mjs): drift.html on a
 * Vite server of its own, in one headless browser on the real GPU, with the frame sink in this process. It is what
 * scripts/drift-render.mjs does for one lane, cut down to one page and one take at a time, so a review frame is drawn
 * by exactly the code that draws the master (src/drift/record.ts → src/cine/domeCapture.ts): the same cube faces,
 * ambient occlusion, bloom and grade.
 *
 * THE REVIEW EYE. Every shot may move the show's eye or put it behind the raft. Both go through the sea's
 * `reviewEye` hook (src/drift/wandering/sea.ts), which runs once `update` has placed the eye and the raft and before
 * anything reads the eye: the sky's shadow focus, the surface grid, the mirror's capture. The first review scripts
 * moved the eye after `update` instead, and the mirror kept the show eye's view — its reflections metres off. The
 * hook exists only in the sea's scene (Part C and Act 3), so a shot in Acts 1–2 that asks for an eye says so.
 *
 * Shot fields (a still's or a clip's view):
 *   fov, yaw, pitch                 the 16:9 view (dome.setFlat): the square frame's full angle (deg, default 60) and
 *                                   its aim from the eye's front (deg; yaw + left, pitch + up). Ignored in dome mode.
 *   eye: { dx, dz, y, yaw, pitch }  move the show's eye: dx, dz m added, y m above the sea (absolute), yaw deg added
 *                                   to its heading, pitch deg (absolute; no roll)
 *   mode: 'show' | 'aim' | 'chase'  'aim': the show's eye turned to the raft (+ `ahead` m along its heading);
 *   back, side, up, ahead           'chase': an eye `back` m astern of the raft (default 8), `side` m to its right
 *                                   (default 0), `up` m above the sea (default 2), looking at the raft + `ahead` m
 *
 * Guards, as scripts/drift-stills.mjs: nothing starts while a render holds out/drift/.render.lock, and the server and
 * browser are closed on any exit.
 */
import http from 'node:http';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'vite';

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** `--name value` (fallback when absent) and `--name` (a switch) */
export function cli(argv) {
  const arg = (name, fallback) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 && argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[i + 1] : fallback;
  };
  const num = (name, fallback) => {
    const v = Number(arg(name, String(fallback)));
    if (!Number.isFinite(v)) throw new Error(`--${name} must be a number`);
    return v;
  };
  return { arg, num, has: (name) => argv.includes(`--${name}`) };
}

/** a running render owns the GPU and the disk: review jobs wait for it (docs/cine/drift-render.md, MACHINE GUARDS) */
export function refuseDuringRender() {
  const lock = join(ROOT, 'out/drift/.render.lock');
  if (!existsSync(lock)) return;
  const pid = Number(readFileSync(lock, 'utf8').trim());
  try {
    process.kill(pid, 0);
  } catch {
    return; // a stale lock: its render is gone
  }
  throw new Error(`a render is running (pid ${pid}, ${lock}): review jobs wait for it`);
}

/**
 * Cube-face supersampling for a 16:9 view of `fov`° drawn `width` px across: a face spends 0.55·N px on 90° (record.ts
 * faceSizeFor), the view N px on `fov`°, so faces (90 / fov) / 0.55 times the master's put one face texel on each view
 * pixel. REVIEW_TEXELS of them a pixel (linear): matched, every face texel was the one sample of its pixel, and the
 * foliage, pebbles and the raft's rope came out as speckle that changed every frame (the 2026-10-29 reviews: "our
 * sub-pixel rendering is horrendous"); at 2 the master's mip filter averages ~4 face texels into each pixel, on top of
 * the faces' own 4× MSAA (src/cine/domeCapture.ts). Time does not cap it — the review view draws each face only inside
 * its own frustum (domeCapture.ts), so 2 texels a pixel cost less than matched faces drawn whole had — memory does: a
 * face is held under REVIEW_FACE_MAX px (a 1280 still at 30° would ask for 7700 px faces; it gets 1.1 texels a pixel).
 */
export const REVIEW_TEXELS = 2;
const REVIEW_FACE_MAX = 4096;
export const flatSupersample = (fov, width) => Math.max(1, Math.min((REVIEW_TEXELS * 90) / fov / 0.55, REVIEW_FACE_MAX / (0.55 * width)));

/**
 * Boot drift.html (?paused, plus `query`) on its own Vite server at `port` and wait for `__drift`. Each frame the
 * page records is handed to `onFrame(bytes, searchParams)`; the page's POST is answered when it resolves, so a slow
 * consumer holds the page back, and a throw fails the take. Returns { page, sinkUrl, run(js), close }.
 */
export async function openDriftPage({ port, channel, query, cacheDir, onFrame }) {
  let sink = null;
  let vite = null;
  let browser = null;
  const close = async () => {
    await browser?.close().catch(() => {});
    await vite?.close().catch(() => {});
    sink?.close();
  };
  for (const sig of ['SIGINT', 'SIGTERM']) process.once(sig, () => void close().then(() => process.exit(130)));
  try {
    sink = http.createServer((req, res) => {
      const parts = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', async () => {
        res.setHeader('access-control-allow-origin', '*');
        try {
          const url = new URL(req.url, 'http://sink');
          if (url.pathname === '/frame') await onFrame(Buffer.concat(parts), url.searchParams);
          else if (url.pathname === '/endshot' && url.searchParams.has('failed')) console.error('[review] take failed in the page:', url.searchParams.get('failed'));
          res.end('ok');
        } catch (e) {
          res.statusCode = 500;
          res.end(String(e));
        }
      });
    });
    await new Promise((r) => sink.listen(0, '127.0.0.1', r));
    const sinkUrl = `http://127.0.0.1:${sink.address().port}`;
    // its own server: no file watcher and no HMR, so an edit saved by anyone mid-take cannot reload the page; its
    // own dep cache, so it never fights another server's optimiser
    vite = await createServer({ root: ROOT, clearScreen: false, logLevel: 'warn', cacheDir: join(ROOT, cacheDir), server: { port, strictPort: true, hmr: false, watch: null } });
    await vite.listen();
    // --expose-gc: the page collects every few frames, or each POST body stays in its memory (record.ts GC_EVERY)
    browser = await chromium.launch({ channel, headless: true, args: ['--js-flags=--expose-gc'] });
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const seen = new Set();
    // a module the server could not build (a syntax error mid-edit, a missing import) answers 500 and the page never
    // boots: fail at once rather than at the boot timeout. Vite prints the module's error above.
    let bootFailed = () => {};
    const bootFailure = new Promise((_, reject) => (bootFailed = reject));
    bootFailure.catch(() => {});
    page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 300)));
    page.on('console', (m) => {
      if (m.type() !== 'error') return;
      if (m.text().includes('status of 500')) bootFailed(new Error('drift.html did not boot: a module failed to build on the server (its error is printed above)'));
      if (seen.has(m.text()) || seen.size > 20) return;
      seen.add(m.text());
      console.log('[console error]', m.text().slice(0, 300));
    });
    await page.goto(`http://localhost:${port}/drift.html?paused${query ? `&${query}` : ''}`);
    // the first boot builds every shader and loads ~150 MB of Earth maps: minutes on a cold machine
    const booted = page.waitForFunction(() => '__drift' in window, null, { timeout: 240_000 });
    booted.catch(() => {}); // when the boot failure wins the race, this one rejects later, as the browser closes
    await Promise.race([booted, bootFailure]);
    await page.evaluate(() => {
      const d = window.__drift;
      const D = Math.PI / 180;
      const review = (window.__review = { shot: null, calls: 0, raft: null });
      d.sea.reviewEye = (eye, r) => {
        review.calls++;
        review.raft = { x: +r.x.toFixed(2), z: +r.z.toFixed(2), heading: +(r.heading / D).toFixed(1) };
        const s = review.shot;
        if (!s) return;
        const mode = s.mode ?? 'show';
        const fx = Math.sin(r.heading);
        const fz = Math.cos(r.heading);
        if (mode === 'chase') {
          const back = s.back ?? 8;
          const side = s.side ?? 0;
          // the raft's right: (fz, −fx)
          eye.position.set(r.x - fx * back + fz * side, s.up ?? 2, r.z - fz * back - fx * side);
        }
        if (mode === 'chase' || mode === 'aim') {
          const ahead = s.ahead ?? 0;
          const lx = r.x + fx * ahead - eye.position.x;
          const lz = r.z + fz * ahead - eye.position.z;
          eye.rotation.set(0, Math.atan2(-lx, -lz), 0, 'YXZ');
        } else if (s.eye) {
          const o = s.eye;
          eye.position.x += o.dx ?? 0;
          eye.position.z += o.dz ?? 0;
          if (o.y !== undefined) eye.position.y = o.y;
          eye.rotation.set((o.pitch ?? 0) * D, eye.rotation.y + (o.yaw ?? 0) * D, 0, 'YXZ');
        }
      };
    });
    /** run `js` in the page as the body of an async function of `d` (= window.__drift); resolves to its result */
    const run = (js) => page.evaluate(async (src) => new Function('d', `return (async () => { ${src} })()`)(window.__drift), js);
    return { page, sinkUrl, run, close };
  } catch (e) {
    await close();
    throw e;
  }
}

/**
 * Point the page at `shot` (the fields above): its 16:9 view, or the dome master when `dome`, and its eye. Resets the
 * hook's call count, so `eyeReport` can tell afterwards whether an eye the shot asked for was used.
 */
export async function aim(page, shot, dome) {
  await page.evaluate(
    ({ s, dome }) => {
      window.__review.shot = s;
      window.__review.calls = 0;
      window.__drift.dome.setFlat(dome ? null : { fov: s.fov ?? 60, yaw: s.yaw ?? 0, pitch: s.pitch ?? 0 });
    },
    { s: shot, dome },
  );
}

/**
 * After a take: the raft's pose the sea last drew (null outside the sea's scene), and a warning when the shot asked for
 * an eye that was never used (Acts 1–2 have no review eye).
 */
export async function eyeReport(page, shot) {
  const { calls, raft } = await page.evaluate(() => ({ calls: window.__review.calls, raft: window.__review.raft }));
  const asked = shot.eye || (shot.mode && shot.mode !== 'show');
  if (asked && calls === 0) console.warn(`[review] WARNING: "${shot.name ?? 'shot'}" asks for an eye (eye/mode), but the sea's scene was not drawn: the show's eye was used`);
  return calls > 0 ? raft : null;
}
