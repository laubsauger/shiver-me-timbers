/**
 * IS WHAT CAME OUT A PICTURE? — every farm job's results, checked on the box before they are sent back (the coordinator,
 * 2026-10-30: linux-monster ran out of video memory beside sd-webrtc, VK_ERROR_OUT_OF_DEVICE_MEMORY, and returned 16
 * pure-black stills with exit 0; "a master chunk could do the same unnoticed"). The page reports a lost device and the
 * scripts now fail on it (drift-review-page.mjs, drift-render.mjs), but a frame drawn black before the message
 * arrives, or a loss the browser never reports, would still pass — so the outputs are looked at too.
 *
 * Each image, and each video frame, scaled to 32×32 grey (ffmpeg, a fraction of a second a clip): its brightest pixel.
 * The verdict is BAD when
 *   - a still is pure black (its brightest pixel ≤ 1), or every frame of a video is;
 *   - a video DROPS to pure black: a frame whose brightest pixel was over DROP_FROM (32) followed by a pure-black one.
 * The film's own black is a fade, never a drop: its opening at 60 s comes up out of black over a second (the first
 * frames' brightest pixels 0, 0, 5, 11, 16 …, the full-show preview of 2026-10-30), and a lost device does the opposite
 * in one frame. So a chunk that STARTS in black is fine when it comes up gradually; one that ends in it, or is black
 * throughout, is not. A still of the film's black (the act openings) is the one case this refuses that is right: pass
 * `allowBlack` for it (there is none in the review shots today).
 */
import { spawnSync } from 'node:child_process';

/** brightest grey (0–255) a pure-black frame may have after the encoder's rounding */
export const BLACK_MAX = 1;
/** a frame brighter than this, followed by a pure-black one: a drop, not a fade */
export const DROP_FROM = 32;
const SIDE = 32;

/** the brightest pixel of each frame of `file` (an image is one frame), or null when it does not decode */
export function frameMaxima(file) {
  const r = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-vf', `scale=${SIDE}:${SIDE},format=gray`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 28, windowsHide: true });
  if (r.status !== 0) return null;
  const px = SIDE * SIDE;
  const n = Math.floor(r.stdout.length / px);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    let m = 0;
    for (let k = i * px; k < (i + 1) * px; k++) if (r.stdout[k] > m) m = r.stdout[k];
    out[i] = m;
  }
  return out;
}

/** BAD, in words, or null (header): `maxima` per frame, `still`: one picture */
export function blackVerdict(maxima, { still = false, allowBlack = false } = {}) {
  if (!maxima || maxima.length === 0) return 'it does not decode';
  if (maxima.every((m) => m <= BLACK_MAX)) return allowBlack ? null : still ? 'the still is pure black' : `all ${maxima.length} frames are pure black`;
  for (let i = 1; i < maxima.length; i++) {
    if (maxima[i] <= BLACK_MAX && maxima[i - 1] > DROP_FROM) {
      let n = 0;
      while (i + n < maxima.length && maxima[i + n] <= BLACK_MAX) n++;
      return `it drops to pure black at frame ${i} (${n} frame(s), after one as bright as ${maxima[i - 1]}/255): a lost GPU device draws black`;
    }
  }
  return null;
}

/** the files a job made that can be looked at */
export const LOOKED_AT = /\.(png|jpe?g|webp|mp4|mov|mkv)$/i;

/** → null, or the reason `file` is not a picture */
export function checkOutput(file, o = {}) {
  return blackVerdict(frameMaxima(file), { still: /\.(png|jpe?g|webp)$/i.test(file), ...o });
}
