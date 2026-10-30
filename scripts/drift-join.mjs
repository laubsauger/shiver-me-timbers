/**
 * JOINING CHUNKS into one clip, for every script that renders a show in pieces: the render queue on one machine
 * (drift-queue.mjs) and the farm's chunked render across machines (drift-farm-render.mjs). A chunk is a whole clip
 * that starts on a keyframe (x264 closes its GOP at a chunk's end; ProRes and FFV1 are intra-only), so the clips are
 * concatenated without re-encoding, `ffmpeg -f concat -c copy`, and the result is kept only when its frame count is
 * the sum of the chunks' (a chunk short by a frame would shift everything after it: a seam that jumps).
 */
import { spawnSync } from 'node:child_process';
import { renameSync, writeFileSync } from 'node:fs';

const sh = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 26 });
  return { ok: r.status === 0, out: r.stdout ?? '', err: r.stderr ?? String(r.error ?? '') };
};

/** a clip's frame count (its stream's nb_frames), or NaN */
export function frameCountOf(file) {
  const r = sh('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=nb_frames', '-of', 'csv=p=0', file]);
  return r.ok ? Number(r.out.trim()) : NaN;
}

/** `ffmpeg -f concat -c copy` of whole clips into `out` (.part until its frame count is F); out, or null */
export function joinClips(files, out, F, list, say = console.log) {
  const quoted = (f) => `file '${(process.platform === 'win32' ? f.replace(/\\/g, '/') : f).replace(/'/g, "'\\''")}'\n`;
  writeFileSync(list, files.map(quoted).join(''));
  const ext = out.endsWith('.mp4') ? 'mp4' : 'mov';
  const r = sh('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', ...(ext === 'mp4' ? ['-movflags', '+faststart'] : []), '-f', ext, `${out}.part`]);
  const n = r.ok ? frameCountOf(`${out}.part`) : NaN;
  if (n !== F) {
    say(`  JOIN FAILED: ${r.ok ? `${n} frames, ${F} expected` : r.err.trim()} — left ${out}.part`);
    return null;
  }
  renameSync(`${out}.part`, out);
  say(`  joined: ${out} (${F} frames)`);
  return out;
}
