/**
 * STUB implementations of the later tasks' seams (§T.181 S0), one small factory each, so the page
 * boots end to end today and each task swaps exactly one line of `main-speedboat.ts`:
 *
 *   createSilentAudio   → §T.183   createNoCrashes → §T.188   createKnotsHud → §T.185
 *   createChaseCamera   → §T.182   (controls stub: controls.ts; course stub: course.ts)
 */
import type { PerspectiveCamera } from 'three/webgpu';
import { FollowCam } from '../../camera';
import { cameraParams } from '../../params/camera';
import type { BoatAudioSink, CameraRig, CrashHook, HudSink } from './seams';

/**
 * §T.183 hook: no AudioContext is created (nothing to play yet, and an unused context only earns
 * an autoplay warning). `unlock` is still wired to the first gesture by `installAudioUnlock`, so
 * the real sink gets the call it needs without the page changing.
 */
export function createSilentAudio(): BoatAudioSink & { readonly unlocked: boolean } {
  let unlocked = false;
  return {
    get unlocked() {
      return unlocked;
    },
    unlock() {
      unlocked = true;
    },
    update() {},
    dispose() {},
  };
}

/** first pointer/key gesture → `sink.unlock()`, once (autoplay policy) */
export function installAudioUnlock(sink: BoatAudioSink, target: Window = window): void {
  const once = (): void => {
    target.removeEventListener('pointerdown', once);
    target.removeEventListener('keydown', once);
    sink.unlock();
  };
  target.addEventListener('pointerdown', once);
  target.addEventListener('keydown', once);
}

/** §T.188 hook: nothing ever crashes */
export function createNoCrashes(): CrashHook {
  return { tick: () => null };
}

/**
 * §T.182 hook: the shared FollowCam in its chase ('follow') mode, framed for a 12 m hull instead
 * of the galleon. The framing is written into `cameraParams` BEFORE the cam is built (it copies
 * `radius` at construction) — this page's own params instance; pirate and raft are other pages.
 * C still toggles the free camera; while it is free the controls go quiet (`capturesInput`).
 */
export const CHASE_RADIUS = 16;
export const CHASE_PIVOT_HEIGHT = 2.4;
export const CHASE_LOOK_AHEAD = 0.25;

export function createChaseCamera(camera: PerspectiveCamera, dom: HTMLElement): CameraRig & { readonly cam: FollowCam } {
  cameraParams.radius = CHASE_RADIUS;
  cameraParams.pivotHeight = CHASE_PIVOT_HEIGHT;
  cameraParams.lookAhead = CHASE_LOOK_AHEAD;
  const cam = new FollowCam(camera, dom);
  cam.setMode('follow');
  return {
    cam,
    update: (view, dt, waterAt) => cam.update(view as Parameters<FollowCam['update']>[0], dt, waterAt),
    snap: () => cam.snap(),
    capturesInput: () => cam.isFree(),
  };
}

/** §T.185 hook: one knots readout (plus the NPC transport line, for the §V110 browser check) */
export function createKnotsHud(parent: HTMLElement = document.body): HudSink & { readonly el: HTMLElement } {
  const el = document.createElement('div');
  el.id = 'speedboat-hud-stub';
  el.style.cssText =
    'position:fixed;right:24px;bottom:20px;z-index:50;pointer-events:none;text-align:right;' +
    'font:700 48px/1 system-ui,sans-serif;color:#f2b54a;text-shadow:0 2px 6px rgba(0,0,0,.6)';
  const knots = document.createElement('div');
  const small = document.createElement('div');
  small.style.cssText = 'font:600 11px/1.4 system-ui,sans-serif;color:#dce2e3;opacity:.75;margin-top:4px';
  el.append(knots, small);
  parent.appendChild(el);
  let lastKn = -1;
  let lastLine = '';
  return {
    el,
    update(m) {
      const kn = Math.round(m.knots);
      if (kn !== lastKn) {
        lastKn = kn;
        knots.textContent = `${kn} kn`;
      }
      const line = `npc ${m.npcTransport} · lag ${m.npcLagTicks}`;
      if (line !== lastLine) {
        lastLine = line;
        small.textContent = line;
      }
    },
    dispose() {
      el.remove();
    },
  };
}
