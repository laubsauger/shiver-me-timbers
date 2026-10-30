/**
 * LIVE FRAME PREVIEWS for the studio console's "now rendering" mosaic (the coordinator, 2026-10-30): while a farm job
 * runs, its newest frame as a small JPEG, at most every 10 s. The render scripts already hold each frame in memory on
 * its way to the encoder (cine-sink.mjs for drift-render, the review page's sink for the review clips and stills), so
 * this only TEES one of them: no extra GPU readback, nothing awaited — the frame is handed to an ffmpeg of its own
 * (scaled to ≤640 px, JPEG quality ~70) and the render goes on; while one is still being written, the next offers are
 * dropped. It costs a 640 px encode every 10 s, against frames that take 0.2–1 s each.
 *
 * The file is DRIFT_PREVIEW_FILE, which the farm worker sets for each job (drift-farm-client.mjs runJob, which sends
 * it to the hub when it changes); without it, nothing happens.
 */
import { spawn } from 'node:child_process';
import { renameSync } from 'node:fs';

/** ms between two previews */
export const PREVIEW_EVERY_MS = 10_000;
/** px: the widest preview */
export const PREVIEW_WIDTH = 640;

/**
 * a tee for one script's frames: `offer(bytes, w, h, { depth, crop })` — raw RGBA (8-bit, or rgba64le with depth 16),
 * `crop` = the 16:9 height cut from the middle of a square frame (the flat review view). Returns whether it took it.
 */
export function previewTee({ file = process.env.DRIFT_PREVIEW_FILE, everyMs = PREVIEW_EVERY_MS, now = Date.now, ffmpeg = 'ffmpeg' } = {}) {
  let last = -Infinity;
  let busy = false;
  return {
    offer(bytes, w, h, { depth = 8, crop = null } = {}) {
      if (!file || busy || now() - last < everyMs) return false;
      last = now();
      busy = true;
      const vf = [crop ? `crop=${w}:${crop}:0:${(h - crop) / 2}` : null, `scale='min(${PREVIEW_WIDTH},iw)':-2`].filter(Boolean).join(',');
      const p = spawn(ffmpeg, ['-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', depth === 16 ? 'rgba64le' : 'rgba', '-s', `${w}x${h}`, '-i', 'pipe:0', '-vf', vf, '-frames:v', '1', '-q:v', '5', '-f', 'mjpeg', `${file}.part`], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true });
      p.on('error', () => (busy = false));
      p.on('close', (code) => {
        busy = false;
        if (code === 0) {
          try {
            renameSync(`${file}.part`, file);
          } catch {
            // (the job's folder went away: it ended)
          }
        }
      });
      p.stdin.on('error', () => {});
      p.stdin.end(bytes);
      return true;
    },
  };
}
