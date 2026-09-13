/*
 * COI SHIM — page half (§T.178). A classic script, loaded BEFORE the page's module:
 *   <script src="./coi-register.js"></script>
 * Add that line ONLY to speedboat pages. It registers coi-sw.js scoped to `<base>/speedboat`
 * and reloads the page once so the navigation goes through it. Where the page is already
 * isolated (Vite dev/preview send the headers, or the shim already took) it does nothing.
 * Where isolation cannot happen (no service workers, insecure context, a hard reload that
 * bypasses the worker) it gives up after one reload and says so: src/sim-worker/select.ts then
 * runs NPC physics on the transferable-worker path at full fidelity.
 */
(() => {
  const KEY = 'coi-shim-reloaded';
  const storage = {
    get: () => {
      try {
        return sessionStorage.getItem(KEY);
      } catch {
        return '1'; // no storage ⇒ never risk a reload loop
      }
    },
    set: () => {
      try {
        sessionStorage.setItem(KEY, '1');
      } catch {
        /* ignore */
      }
    },
    clear: () => {
      try {
        sessionStorage.removeItem(KEY);
      } catch {
        /* ignore */
      }
    },
  };
  if (window.crossOriginIsolated) {
    storage.clear();
    return;
  }
  if (!window.isSecureContext || !('serviceWorker' in navigator)) {
    console.warn('[coi-shim] no service worker here (insecure context or unsupported): page stays non-isolated');
    return;
  }
  const here = document.currentScript && document.currentScript.src ? document.currentScript.src : location.href;
  const swUrl = new URL('coi-sw.js', here);
  const scope = new URL('speedboat', here).pathname;
  const reloadOnce = () => {
    if (storage.get()) {
      console.warn('[coi-shim] reloaded once and still not crossOriginIsolated: giving up (NPC physics falls back to transferable workers)');
      return;
    }
    storage.set();
    location.reload();
  };
  navigator.serviceWorker.register(swUrl.href, { scope }).then(
    () => {
      // already controlled but not isolated ⇒ this load bypassed the worker (e.g. hard reload)
      if (navigator.serviceWorker.controller) reloadOnce();
      else navigator.serviceWorker.addEventListener('controllerchange', reloadOnce, { once: true });
    },
    (err) => console.warn('[coi-shim] service worker registration failed:', err),
  );
})();
