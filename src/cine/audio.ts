/**
 * Shot audio: SFX and ambience, no music, time-aligned to a rendered clip.
 *
 * WHY IT IS A SECOND PASS AND NOT PART OF THE RENDER. The video is rendered
 * offline — a frame takes as long as it takes and the world advances by
 * exactly 1/fps regardless (recorder.ts). WebAudio has no such freedom: an
 * AudioContext runs on the wall clock and cannot be stepped. Recording it
 * during a 20 fps-of-render pass would produce a soundtrack stretched by
 * whatever the machine was doing.
 *
 * So a shot is played back a SECOND time at real speed with the same
 * deterministic camera and the same preroll, and the graph is recorded then.
 * The sim is fixed-step at 1/60 either way, so the same shot produces the same
 * events at the same shot-local times, and the two passes line up.
 *
 * Music is excluded by tapping the SFX and AMBIENCE buses rather than the
 * master: a bed under the picture is an edit decision, and a piece scored to
 * Alan Watts does not want the game's playlist under it.
 *
 * The tap goes in through `audio.attach` — the §V95 seam — because that is the
 * one sanctioned way to reach the shared context and buses without a second
 * audio path.
 */
import type { AudioSystem } from '../audio';

/** what the browser will actually give us, best first */
const MIME_CANDIDATES = [
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/ogg;codecs=opus',
  'audio/mp4',
];

function pickMime(): string | undefined {
  if (typeof MediaRecorder === 'undefined') return undefined;
  return MIME_CANDIDATES.find((m) => MediaRecorder.isTypeSupported(m));
}

export interface ShotAudioTake {
  blob: Blob;
  mime: string;
  seconds: number;
}

export class ShotAudio {
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private detach: (() => void) | null = null;
  private startedAt = 0;
  private mime = '';

  constructor(private audio: AudioSystem) {}

  static get supported(): boolean {
    return pickMime() !== undefined;
  }

  /** begin recording. Resolves once the graph is actually tapped. */
  async start(): Promise<void> {
    const mime = pickMime();
    if (mime === undefined) throw new Error('cine: this browser has no MediaRecorder audio codec');
    this.mime = mime;
    await this.audio.resume();

    let dest: MediaStreamAudioDestinationNode | null = null;
    this.detach = this.audio.attach((ctx, buses) => {
      // BaseAudioContext has no createMediaStreamDestination; a live shoot
      // always has the real one, and saying so beats a silent empty file
      const live = ctx as unknown as AudioContext;
      if (typeof live.createMediaStreamDestination !== 'function') {
        throw new Error('cine: audio capture needs a live AudioContext');
      }
      dest = live.createMediaStreamDestination();
      // the two buses the picture wants; `music` is deliberately not here
      buses.sfx.connect(dest);
      buses.ambience.connect(dest);
      return {
        update: () => undefined,
        dispose: () => {
          try {
            buses.sfx.disconnect(dest as AudioNode);
            buses.ambience.disconnect(dest as AudioNode);
          } catch {
            /* already torn down with the context */
          }
        },
      };
    });

    if (dest === null) {
      // attach() is a no-op before the context exists — say so rather than
      // handing back a recorder that will produce an empty file
      this.detach?.();
      this.detach = null;
      throw new Error('cine: audio context not running — click the page once, then retry');
    }

    this.chunks = [];
    this.recorder = new MediaRecorder((dest as MediaStreamAudioDestinationNode).stream, {
      mimeType: mime,
    });
    this.recorder.ondataavailable = (e): void => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.recorder.start(250);
    this.startedAt = performance.now();
  }

  async stop(): Promise<ShotAudioTake> {
    const rec = this.recorder;
    if (rec === null) throw new Error('cine: stop() without start()');
    const seconds = (performance.now() - this.startedAt) / 1000;
    await new Promise<void>((res) => {
      rec.onstop = (): void => res();
      rec.stop();
    });
    this.recorder = null;
    this.detach?.();
    this.detach = null;
    return { blob: new Blob(this.chunks, { type: this.mime }), mime: this.mime, seconds };
  }
}
