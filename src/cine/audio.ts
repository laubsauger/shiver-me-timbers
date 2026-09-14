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
 *
 * LOSSLESS. The tap is an AudioWorklet that copies the float PCM of every
 * input straight off the render thread (`cine-pcm-tap`), and the sink writes
 * 48 kHz 24-bit WAV from it. The first version recorded a MediaRecorder stream
 * (webm/opus): a lossy codec in front of a mix stem, and a start latency
 * nobody could measure.
 *
 * STEMS. Input 0 is always the MIX (sfx + ambience, no music, no radio). A page
 * can name more taps (`CineAudioSource.stems`: engine / water / amb), each its
 * own input and its own WAV beside the mix.
 *
 * ALIGNMENT. The tap runs from the cue, through the preroll, to past the tail;
 * every display frame the pass logs (context sample frame, shot time), and the
 * take is cut from the sample a straight-line fit of those marks puts at the
 * head of the clip. The fit's slope is the sim's speed against the audio clock:
 * a pass whose sim fell behind real time is stretched sound, and says so.
 */
import type { EngineBuses } from '../audio/engine';

/**
 * What a shoot needs of a page's audio: the unlock, and the §V95 seam onto the
 * ONE graph. The pirate `AudioSystem` is this as-is; the speedboat page adapts
 * its `AudioEngine` (src/speedboat/cine/host.ts). Structural, so this module
 * pulls in neither page's audio.
 */
export interface CineAudioSource {
  resume(): Promise<void>;
  attach(make: (ctx: BaseAudioContext, buses: EngineBuses) => { update(dt: number): void; dispose(): void }): () => void;
  /**
   * Optional split stems: the nodes whose output IS that stem (tapped with an extra `connect`, never rerouted). A stem
   * the page cannot separate is simply absent; the mix is always written. `null` = the page CAN split but its taps do
   * not exist yet (the speedboat's boat-audio graph is built asynchronously after the unlock): the tap retries.
   */
  stems?(ctx: BaseAudioContext, buses: EngineBuses): Partial<Record<StemName, readonly AudioNode[]>> | null;
}

export type StemName = 'engine' | 'water' | 'amb';
export const STEM_NAMES: readonly StemName[] = ['engine', 'water', 'amb'];


const PROCESSOR = 'cine-pcm-tap';
/** how long the tap waits for a page's stem taps to exist after the unlock */
const STEM_WAIT_MS = 3000;

/**
 * The worklet, as source: a Blob URL keeps it one self-contained module that both pages (and their different worker
 * bundling) load the same way. `inputs` stereo inputs in, their PCM out to the main thread in ~0.1 s batches, each
 * batch stamped with the context sample frame of its first sample.
 */
const WORKLET_SRC = `
class CinePcmTap extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.n = o.processorOptions.inputs;
    this.on = false;
    this.q = [];
    this.len = 0;
    this.first = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'start') { this.on = true; this.q = []; this.len = 0; }
      else if (e.data === 'stop') { this.flush(); this.on = false; this.port.postMessage({ t: 'done' }); }
    };
  }
  flush() {
    if (this.len === 0) return;
    const data = [];
    for (let k = 0; k < this.n; k++) {
      const b = new Float32Array(this.len * 2);
      let o = 0;
      for (const blk of this.q) { b.set(blk[k], o); o += blk[k].length; }
      data.push(b);
    }
    this.port.postMessage({ t: 'pcm', frame: this.first, frames: this.len, data }, data.map((b) => b.buffer));
    this.q = [];
    this.len = 0;
  }
  process(inputs) {
    if (!this.on) return true;
    const n = 128;
    if (this.len === 0) this.first = currentFrame;
    const blk = [];
    for (let k = 0; k < this.n; k++) {
      const ch = inputs[k] || [];
      const L = ch[0];
      const R = ch[1] || ch[0];
      const b = new Float32Array(n * 2);
      if (L) for (let i = 0; i < n; i++) { b[2 * i] = L[i]; b[2 * i + 1] = R[i]; }
      blk.push(b);
    }
    this.q.push(blk);
    this.len += n;
    if (this.len >= 4800) this.flush();
    return true;
  }
}
registerProcessor('${PROCESSOR}', CinePcmTap);
`;

const loaded = new WeakMap<BaseAudioContext, Promise<void>>();
function loadWorklet(ctx: AudioContext): Promise<void> {
  let p = loaded.get(ctx);
  if (p === undefined) {
    const url = URL.createObjectURL(new Blob([WORKLET_SRC], { type: 'application/javascript' }));
    p = ctx.audioWorklet.addModule(url).finally(() => URL.revokeObjectURL(url));
    loaded.set(ctx, p);
  }
  return p;
}

/** one cut take: interleaved stereo float PCM per stream at the context's rate */
export interface ShotAudioTake {
  sampleRate: number;
  /** 'mix' first, then the stems the page gave */
  streams: { name: 'mix' | StemName; pcm: Float32Array }[];
  /** the fit's slope: context samples per second of shot time ÷ sample rate (1 = the sim kept real time) */
  speed: number;
  /** RMS of the fit's residual, ms (the display-frame jitter of the marks) */
  jitterMs: number;
  /** peak |sample| per stream, for a loud "this stem is silent" */
  peaks: Record<string, number>;
}

export class ShotAudio {
  private node: AudioWorkletNode | null = null;
  private detach: (() => void) | null = null;
  private ctx: AudioContext | null = null;
  private names: ('mix' | StemName)[] = [];
  private blocks: { frame: number; frames: number; data: Float32Array[] }[] = [];
  private marks: [number, number][] = [];
  private done: (() => void) | null = null;

  constructor(private audio: CineAudioSource) {}

  static get supported(): boolean {
    return typeof AudioWorkletNode !== 'undefined';
  }

  /** tap the graph and start buffering. Resolves once the tap is live. */
  async start(): Promise<void> {
    await this.audio.resume();
    // stems not ready yet (null): wait for them up to STEM_WAIT_MS, then record the mix alone, loudly
    let stemsReady = false;
    for (let waited = 0; this.audio.stems !== undefined; waited += 100) {
      let ready = false;
      const off = this.audio.attach((ctx, buses) => {
        ready = this.audio.stems?.(ctx, buses) !== null;
        return { update: () => undefined, dispose: () => undefined };
      });
      off();
      if (ready) {
        stemsReady = true;
        break;
      }
      if (waited >= STEM_WAIT_MS) {
        console.warn(`[cine:audio] the page's stem taps did not appear in ${STEM_WAIT_MS} ms — recording the mix only`);
        break;
      }
      await new Promise((r) => setTimeout(r, 100));
    }
    let live: AudioContext | null = null;
    let build: ((ctx: AudioContext) => void) | null = null;
    this.detach = this.audio.attach((ctx, buses) => {
      live = ctx as AudioContext;
      const nodes: { name: 'mix' | StemName; from: readonly AudioNode[] }[] = [{ name: 'mix', from: [buses.sfx, buses.ambience] }];
      const stems = (stemsReady ? this.audio.stems?.(ctx, buses) : null) ?? {};
      for (const name of STEM_NAMES) {
        const from = stems[name];
        if (from !== undefined && from.length > 0) nodes.push({ name, from });
      }
      const wired: [AudioNode, AudioWorkletNode, number][] = [];
      let sink: GainNode | null = null;
      build = (c) => {
        const node = new AudioWorkletNode(c, PROCESSOR, {
          numberOfInputs: nodes.length,
          numberOfOutputs: 1,
          outputChannelCount: [1],
          channelCount: 2,
          channelCountMode: 'explicit',
          channelInterpretation: 'speakers',
          processorOptions: { inputs: nodes.length },
        });
        nodes.forEach((n, k) => {
          for (const src of n.from) {
            src.connect(node, 0, k);
            wired.push([src, node, k]);
          }
        });
        // pulled by the destination through a silent gain, so the render thread always runs it
        sink = c.createGain();
        sink.gain.value = 0;
        node.connect(sink);
        sink.connect(c.destination);
        this.node = node;
        this.names = nodes.map((n) => n.name);
      };
      return {
        update: () => undefined,
        dispose: () => {
          for (const [src, node, k] of wired) {
            try {
              src.disconnect(node, 0, k);
            } catch {
              /* already torn down with the context */
            }
          }
          (sink as GainNode | null)?.disconnect();
          this.node?.disconnect();
        },
      };
    });
    if (live === null || build === null) {
      // attach() is a no-op before the context exists — say so rather than record an empty file
      this.detach?.();
      this.detach = null;
      throw new Error('cine: audio context not running — click the page once, then retry');
    }
    const ctx = live as AudioContext;
    this.ctx = ctx;
    await loadWorklet(ctx);
    // the node is built only once the module has loaded (a worklet node cannot exist before its processor)
    (build as (c: AudioContext) => void)(ctx);
    const node = this.node as AudioWorkletNode | null;
    if (node === null) throw new Error('cine: audio tap was not built');
    node.port.onmessage = (e: MessageEvent): void => {
      const m = e.data as { t: string; frame: number; frames: number; data: Float32Array[] };
      if (m.t === 'pcm') this.blocks.push({ frame: m.frame, frames: m.frames, data: m.data });
      else if (m.t === 'done') this.done?.();
    };
    node.port.postMessage('start');
  }

  /** once per display frame: where the audio clock is at this shot time */
  mark(shotTime: number): void {
    if (this.ctx !== null) this.marks.push([shotTime, this.ctx.currentTime * this.ctx.sampleRate]);
  }

  /** stop and cut `seconds` of every stream starting at shot time `from` */
  async stop(from: number, seconds: number): Promise<ShotAudioTake> {
    const node = this.node;
    const ctx = this.ctx;
    if (node === null || ctx === null) throw new Error('cine: stop() without start()');
    await new Promise<void>((res) => {
      this.done = res;
      node.port.postMessage('stop');
    });
    this.detach?.();
    this.detach = null;
    this.node = null;
    const sr = ctx.sampleRate;
    // least squares: context frame = a + b · shotTime
    const m = this.marks;
    if (m.length < 30) throw new Error(`cine: only ${m.length} audio clock marks — the pass did not run`);
    let sx = 0, sy = 0, sxx = 0, sxy = 0;
    for (const [x, y] of m) {
      sx += x;
      sy += y;
      sxx += x * x;
      sxy += x * y;
    }
    const n = m.length;
    const b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    const a = (sy - b * sx) / n;
    let rr = 0;
    for (const [x, y] of m) rr += (y - (a + b * x)) ** 2;
    const jitterMs = (Math.sqrt(rr / n) / sr) * 1000;
    const first = Math.round(a + b * from);
    const len = Math.round(seconds * sr);
    const streams = this.names.map((name, k) => {
      const pcm = new Float32Array(len * 2);
      for (const blk of this.blocks) {
        const lo = Math.max(blk.frame, first);
        const hi = Math.min(blk.frame + blk.frames, first + len);
        if (hi <= lo) continue;
        pcm.set((blk.data[k] as Float32Array).subarray((lo - blk.frame) * 2, (hi - blk.frame) * 2), (lo - first) * 2);
      }
      return { name, pcm };
    });
    const peaks: Record<string, number> = {};
    for (const st of streams) {
      let p = 0;
      for (let i = 0; i < st.pcm.length; i++) p = Math.max(p, Math.abs(st.pcm[i] as number));
      peaks[st.name] = p;
    }
    this.blocks = [];
    this.marks = [];
    return { sampleRate: sr, streams, speed: b / sr, jitterMs, peaks };
  }
}
