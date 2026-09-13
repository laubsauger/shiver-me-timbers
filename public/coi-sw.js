/*
 * COI SHIM — service worker half (§T.178). Original to this repo; written after the approach of
 * gzuidhof/coi-serviceworker (MIT) without copying it.
 *
 * GitHub Pages cannot send response headers, and SharedArrayBuffer needs a crossOriginIsolated
 * page (COOP same-origin + COEP require-corp). This worker re-issues the responses that decide
 * isolation — the page document and worker scripts — with those two headers added.
 *
 * SCOPE, and why the pirate and raft pages never see it: coi-register.js registers this file
 * with scope `<base>/speedboat`, a URL prefix that matches `speedboat-lookdev.html`, a future
 * `speedboat.html` and the bundled `speedboat-workers/*` (vite.config.ts `worker`) — and not
 * `index.html` or `raft.html`. Nothing outside that prefix is controlled, so nothing outside it
 * is touched.
 *
 * Only documents and worker scripts are rewritten: COOP/COEP mean nothing on any other response,
 * and passing everything else straight through keeps the shim off the hot path. Opaque and
 * redirected responses are returned untouched (an opaque body cannot be re-wrapped, and a
 * re-wrapped redirect would lose its final URL, which is a module's base URL).
 */
/* eslint-env serviceworker */
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

const ISOLATING_DESTINATIONS = new Set(['document', 'iframe', 'worker', 'sharedworker']);

self.addEventListener('fetch', (event) => {
  const req = event.request;
  // Chrome bug class: an only-if-cached request outside same-origin mode throws inside fetch()
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return;
  if (!ISOLATING_DESTINATIONS.has(req.destination)) return;
  event.respondWith(
    fetch(req).then((res) => {
      if (res.status === 0 || res.type === 'opaque' || res.type === 'opaqueredirect' || res.redirected) return res;
      const headers = new Headers(res.headers);
      headers.set('Cross-Origin-Opener-Policy', 'same-origin');
      headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    }),
  );
});
