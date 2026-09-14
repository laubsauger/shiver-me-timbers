/**
 * §T.183 AudioWorkletGlobalScope entry: a thin shell around `BoatSynthCore` (all DSP lives there so
 * node tests run the same code). Loaded by boatAudio.ts through Vite's `?worker&url`, which bundles
 * this module graph into one ES file under `speedboat-workers/` (inside the COI shim scope).
 *
 * Messages in:  { t: 'frame', boats: Float32Array, nBoats, slots: Float32Array }
 *               { t: 'tunables', v: Partial<VoiceTunables> }
 *               { t: 'stems', on: boolean }   cine stems: render the NPC water-only stem outputs
 * Messages out: { t: 'report', data: Float32Array, count, nanResets } ~15 Hz
 */
import { BoatSynthCore } from './synthCore';
import { OUTPUT_COUNT, REPORT_STRIDE, SLOT_COUNT, WORKLET_NAME, type VoiceTunables } from './protocol';

declare const sampleRate: number;
declare function registerProcessor(name: string, ctor: new (options?: unknown) => AudioWorkletProcessorShape): void;
interface AudioWorkletProcessorShape {
  readonly port: MessagePort;
  process(inputs: Float32Array[][], outputs: Float32Array[][], params: Record<string, Float32Array>): boolean;
}
declare const AudioWorkletProcessor: { prototype: AudioWorkletProcessorShape; new (options?: unknown): AudioWorkletProcessorShape };

type InMsg =
  | { t: 'frame'; boats: Float32Array; nBoats: number; slots: Float32Array }
  | { t: 'tunables'; v: Partial<VoiceTunables> }
  | { t: 'stems'; on: boolean };

class BoatAudioProcessor extends AudioWorkletProcessor {
  private core = new BoatSynthCore(sampleRate, SLOT_COUNT);
  private sinceReport = 0;
  private readonly mono: (Float32Array | undefined)[] = new Array(OUTPUT_COUNT);
  constructor(options?: unknown) {
    super(options);
    this.port.onmessage = (e: MessageEvent<InMsg>) => {
      const m = e.data;
      if (!m) return;
      if (m.t === 'frame') this.core.applyFrame(m.boats, m.nBoats, m.slots);
      else if (m.t === 'tunables') this.core.setTunables(m.v);
      else if (m.t === 'stems') this.core.stems = m.on === true;
    };
  }
  process(_inputs: Float32Array[][], outputs: Float32Array[][]): boolean {
    const n = outputs[0]?.[0]?.length ?? 128;
    for (let i = 0; i < OUTPUT_COUNT; i++) this.mono[i] = outputs[i]?.[0];
    this.core.process(this.mono, n);
    this.sinceReport += n;
    if (this.sinceReport >= sampleRate / 15) {
      this.sinceReport = 0;
      const r = this.core.report();
      this.port.postMessage({ t: 'report', data: r.data.slice(0, r.count * REPORT_STRIDE), count: r.count, nanResets: this.core.nanResets });
    }
    return true;
  }
}

registerProcessor(WORKLET_NAME, BoatAudioProcessor);
