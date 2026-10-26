/**
 * Offline dome-master recorder for The Drift.
 *
 * The act is a pure function of act time, so recording is a plain loop: for frame n, set t = from + n / fps,
 * draw the master into an offscreen square target, read it back, POST it to the cine sink. No game loop, no
 * wall clock: a frame may take seconds and still advances the act by exactly 1/fps (src/cine/recorder.ts
 * says why that matters). Pixels leave as raw RGBA and the sink encodes (capture.ts says why not in the
 * browser).
 *
 *   npm run cine:sink                      (scripts/cine-sink.mjs, default http://127.0.0.1:7654)
 *   __drift.record({ size: 2048, fps: 30 })  or  drift.html?record
 *
 * The sink writes out/cine/seg/<shot>.mp4 (or ProRes with --edit). Dome masters are square; 4096 is the
 * common delivery size, 2048 a fast review size.
 */
import type * as THREE from 'three/webgpu';
import { Capture } from '../cine/capture';

export interface DriftRecordOptions {
  /** px, square master */
  size?: number;
  fps?: number;
  /** s, act time of the first frame */
  from?: number;
  /** s, act time to stop before */
  to: number;
  /** clip name at the sink */
  shot?: string;
  sink?: string;
  onProgress?: (frame: number, frames: number) => void;
}

export interface DriftRecordDeps {
  renderer: THREE.WebGPURenderer;
  /** put the world into the state of act time t (field uniforms, crawl, glow) */
  prepare(t: number): void;
  /** render the dome master into the CURRENTLY BOUND target, filling it */
  renderMaster(): void;
}

async function post(sink: string, path: string, body: BodyInit): Promise<void> {
  const res = await fetch(`${sink}/${path}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`drift record: sink ${path} → ${res.status} ${await res.text()}`);
}

/** frames rendered for [from, to) at fps — the count the sink checks the take against */
export function frameCount(from: number, to: number, fps: number): number {
  return Math.max(0, Math.round((to - from) * fps));
}

export async function recordDomeMaster(o: DriftRecordOptions, deps: DriftRecordDeps): Promise<number> {
  const size = o.size ?? 2048;
  const fps = o.fps ?? 30;
  const from = o.from ?? 0;
  const shot = o.shot ?? 'undertime';
  const sink = o.sink ?? 'http://127.0.0.1:7654';
  const frames = frameCount(from, o.to, fps);
  const capture = new Capture(deps.renderer, size, size);
  await post(sink, 'manifest', JSON.stringify({ fps, width: size, height: size, shots: [{ id: shot, frames, from, to: o.to }] }));
  let n = 0;
  try {
    for (; n < frames; n++) {
      deps.prepare(from + n / fps);
      capture.bind();
      try {
        deps.renderMaster();
      } finally {
        capture.unbind();
      }
      const px = await capture.grab();
      await post(sink, `frame?shot=${encodeURIComponent(shot)}&n=${n}&w=${size}&h=${size}`, px as unknown as BodyInit);
      o.onProgress?.(n + 1, frames);
    }
    await post(sink, `endshot?clip=${encodeURIComponent(shot)}&frames=${frames}`, '');
  } catch (e) {
    await post(sink, `endshot?clip=${encodeURIComponent(shot)}&frames=${frames}&failed=${encodeURIComponent(String(e))}`, '').catch(() => {});
    throw e;
  } finally {
    capture.dispose();
  }
  await post(sink, 'done', JSON.stringify({ fps }));
  return n;
}
