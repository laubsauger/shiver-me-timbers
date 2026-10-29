/**
 * Offline dome-master recorder for The Drift.
 *
 * The act is a pure function of act time, so recording is a loop over t = from + n / fps: draw the master
 * into an offscreen square target, read it back, POST raw RGBA to the cine sink. No game loop, no wall
 * clock: a frame may take seconds and still advances the act by exactly 1/fps (src/cine/recorder.ts says
 * why that matters). Pixels leave as raw RGBA and the sink encodes (capture.ts says why not in the browser).
 *
 * THREE FRAMES IN FLIGHT (shaderloom docs/offline-render-profile-2026-09-17.md: at 4K the readback wait was
 * ~70 % of a frame). Frame n renders into slot n % K of a ring of capture targets and its readback starts at
 * once; the loop moves on to frame n+1 in the next slot while that copy completes, and POSTs leave in frame
 * order on one chain. A slot is reused only after its own frame has been POSTed — Loom's recorder notes
 * that a capture finishing after the next render into the SAME target encodes the wrong pixels, which the
 * ring exists to rule out.
 *
 * PARALLEL LANES: frames are independent, so several pages can each render a [from, to) range into its own
 * clip and the clips are joined without re-encoding (scripts/drift-render.mjs). `group` keeps the sink from
 * closing one lane's encoder when another lane's frame arrives.
 *
 *   npm run cine:sink                      (scripts/cine-sink.mjs, default http://127.0.0.1:7654)
 *   __drift.record({ size: 2048, fps: 30 })  or  drift.html?record   or  npm run drift:render
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
  /** sink group: lanes of one render share it so the sink keeps all their encoders open */
  group?: string;
  sink?: string;
  /** frames in flight (capture ring size); 1 = the strictly serial path */
  inFlight?: number;
  /** skip the sink's /manifest and /done — a lane of a multi-lane render, the driver owns those */
  lane?: boolean;
  /** motion blur: sub-frames per frame (1 = none) */
  blur?: number;
  /** fraction of the frame interval the shutter is open (0.5 = a 180° shutter) */
  shutter?: number;
  /**
   * cube faces this many times the resolution the master needs (linear; 1 = matched, `faceSizeFor`): the master
   * then averages several face texels a pixel through the faces' mips — anti-aliasing for the sea's fine
   * detail at the horizon and for thin far things, at ~ss² the face shading.
   *
   * The faces' EDGES are multisampled besides (4× MSAA, cine/domeCapture.ts `setSamples`), which settles the
   * foliage, the rigging and the pebbles about as much as ss 2 does alone, for little shading; together they do
   * best, so the 2× planned for the 8K master is now 1.25 (2026-10-29, measured at the forest edge, 604 s):
   *   8192², ss 1.25 + MSAA: 5632 px faces, ~23.5 GB in the page's GPU process; quieter foliage than ss 2 alone
   *     (frame-to-frame noise 8.5 against 9.0 at 1.25 and 2 face texels a pixel) and ~18 % faster (at 4096²:
   *     1.13 / 1.05 s a frame against 1.38 / 1.28 at the forest edge / the raft);
   *   8192², ss 2 + MSAA: 9024 px faces, ~34 GB — does not fit; ss 2 without: 27.6 GB, and noisier;
   *   4096²: ss 1.5 + MSAA (7.5 against 9.0, the time of ss 2 alone); 2048²: ss 2 + MSAA (MSAA costs ~nothing there).
   * ss 1 + MSAA (4512 px faces at 8K, ~21.5 GB) where memory is short: as quiet at the edges as ss 2 alone was.
   */
  supersample?: number;
  /**
   * bits a channel the frames leave in: 8 (RGBA, the default) or 16 (rgba64le, the 10/12-bit ProRes masters —
   * capture.ts Encoder16; the sink must encode ProRes: cine-sink.mjs --codec proreshq | prores4444)
   */
  depth?: 8 | 16;
  onProgress?: (frame: number, frames: number) => void;
}

export interface DriftRecordDeps {
  renderer: THREE.WebGPURenderer;
  /**
   * Render the dome master of show time t into the CURRENTLY BOUND target, filling it: the world put into
   * the state of t, or — with `samples` > 1 — of `samples` instants spread over `shutter` seconds centred on
   * t, averaged (motion blur).
   */
  frame(t: number, shutter: number, samples: number): void;
}

async function post(sink: string, path: string, body: BodyInit): Promise<void> {
  const res = await fetch(`${sink}/${path}`, { method: 'POST', body });
  if (!res.ok) throw new Error(`drift record: sink ${path} → ${res.status} ${await res.text()}`);
}

/**
 * Frames between forced garbage collections. Chrome keeps a fetch's request body (here a whole frame, 18 MB at
 * 2160²) in native memory until the JS objects of that request are garbage collected, and V8 does not count that
 * memory, so nothing triggers a collection: the page grew ~18 MB a frame and long renders crashed ("Target
 * crashed" at ~900 frames a lane). Reproduced in a blank page posting 18 MB bodies; collecting every 10 posts held
 * it flat (docs/drift/engine-findings.md). `gc` exists only when the page's browser runs with
 * `--js-flags=--expose-gc` (scripts/drift-render.mjs launches it so); elsewhere this does nothing.
 */
const GC_EVERY = 20;

/** frames rendered for [from, to) at fps — the count the sink checks the take against */
export function frameCount(from: number, to: number, fps: number): number {
  return Math.max(0, Math.round((to - from) * fps));
}

/**
 * Cube-face size for a master of `size` px: an equidistant master spends size/2 px on 90° of zenith angle,
 * a cube face spends `face` px on 90° at its centre, so ~0.55 × size matches resolution at the face centres
 * (the corners are oversampled anyway). A face as large as the master renders ~3× the pixels for nothing.
 */
export function faceSizeFor(masterSize: number): number {
  return Math.max(64, Math.ceil((masterSize * 0.55) / 16) * 16);
}

export async function recordDomeMaster(o: DriftRecordOptions, deps: DriftRecordDeps): Promise<number> {
  const size = o.size ?? 2048;
  const fps = o.fps ?? 30;
  const from = o.from ?? 0;
  const shot = o.shot ?? 'undertime';
  const sink = o.sink ?? 'http://127.0.0.1:7654';
  const K = Math.max(1, o.inFlight ?? 3);
  const frames = frameCount(from, o.to, fps);
  const groupQ = o.group ? `&group=${encodeURIComponent(o.group)}` : '';
  const shotQ = encodeURIComponent(shot);
  const depth = o.depth ?? 8;
  if (depth !== 8 && depth !== 16) throw new Error(`drift record: depth ${String(depth)}, 8 | 16`);
  const depthQ = depth === 16 ? '&depth=16' : '';
  const slots = Array.from({ length: K }, () => ({ cap: new Capture(deps.renderer, size, size, undefined, depth), done: Promise.resolve() }));
  if (!o.lane) await post(sink, 'manifest', JSON.stringify({ fps, width: size, height: size, shots: [{ id: shot, frames, from, to: o.to }] }));
  let chain: Promise<void> = Promise.resolve();
  let n = 0;
  try {
    // A WARM-UP FRAME, drawn and dropped. The first frame a page draws is not the frame it draws at the same t
    // once it has drawn one (7.5k px differ at 1080², against ~300 between two warmed runs): the dolphin showed
    // through the water unshadowed beside the raft, and the raft and its reflections moved, in the first frame
    // of every lane — a flash at each lane's join (engine-findings.md §14). Whatever builds on first use (the
    // shadow maps are the likely part) has built by the second.
    if (frames > 0) {
      slots[0].cap.bind();
      try {
        deps.frame(from, (o.shutter ?? 0.5) / fps, Math.max(1, Math.round(o.blur ?? 1)));
      } finally {
        slots[0].cap.unbind();
      }
    }
    for (; n < frames; n++) {
      const slot = slots[n % K];
      await slot.done; // this target's previous frame is read back AND posted
      slot.cap.bind();
      try {
        deps.frame(from + n / fps, (o.shutter ?? 0.5) / fps, Math.max(1, Math.round(o.blur ?? 1)));
      } finally {
        slot.cap.unbind();
      }
      const pixels = slot.cap.grab(); // the copy is encoded now; the loop does not wait for it
      const frame = n;
      chain = chain.then(async () => {
        const px = await pixels;
        // as a Blob: Chrome uploads a typed-array body at ~40 MB/s (440 ms for one 2160² frame, five times the
        // frame's render), a Blob at ~1 GB/s (17 ms; docs/drift/engine-findings.md). The Blob copies the bytes,
        // so the capture's reused buffer is free again at once.
        await post(sink, `frame?shot=${shotQ}&n=${frame}&w=${size}&h=${size}${groupQ}${depthQ}`, new Blob([px as Uint8Array<ArrayBuffer>]));
        if (frame % GC_EVERY === GC_EVERY - 1) (globalThis as { gc?: () => void }).gc?.();
        o.onProgress?.(frame + 1, frames);
      });
      slot.done = chain;
    }
    await chain;
    await post(sink, `endshot?clip=${shotQ}&frames=${frames}`, '');
  } catch (e) {
    await post(sink, `endshot?clip=${shotQ}&frames=${frames}&failed=${encodeURIComponent(String(e))}`, '').catch(() => {});
    throw e;
  } finally {
    for (const s of slots) s.cap.dispose();
  }
  if (!o.lane) await post(sink, 'done', JSON.stringify({ fps }));
  return n;
}
