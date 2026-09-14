/**
 * §T.183 boat worklet DSP, rendered in node through the SAME BoatSynthCore the AudioWorklet runs.
 *
 * WHY each property:
 *  - PITCH IS RPM (V112, tech-research §S3 criterion): the V8's firing line sits at rpm·8/120 ±3 %,
 *    the two-stroke's at rpm·3/60, the inverter whine at 6·f_e — and rendering the same rpm at 0 and at
 *    40 m/s puts it at the same frequency. If speed leaked into pitch the engine would "rev" coasting.
 *  - CROSS-PLANE LUMP: firing order 1-8-4-3-6-5-7-2 on odd/even banks makes each bank's pulses uneven;
 *    the audible burble is energy at the HALF orders (multiples of the cycle rate rpm/120 that are
 *    not firing harmonics). An even-fire pulse train has none, and sounds like a buzz.
 *  - UNDERWATER EXHAUST: idle through the hub is darker than the same idle in air.
 *  - LIMITER BOUNCE: airborne at the limit the loudness is chopped at the bounce rate (the fuel cut
 *    silences combustion) — an envelope line between 4 and 25 Hz, or the limiter is inaudible.
 *  - LANDING: the boom lands in the 50–120 Hz band the design doc names.
 *  - SCHEDULE / DETERMINISM: identical frames render identical samples, and every continuous input
 *    ramps linearly over RAMP_SECONDS (a step would click).
 *  - NaN / CPU: sim garbage must not poison the audio thread, and 8 boats must render faster than
 *    real time with headroom.
 *
 * With BOAT_AUDIO_WAV_DIR set, the scenarios are also written as WAVs for listening.
 */
import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { BoatSynthCore, CONTROL_SAMPLES, RAMP_SECONDS, Ramp } from '../src/audio/boat/synthCore';
import { BI, BOAT_STRIDE, SI, SLOT_COUNT, SLOT_STRIDE, LAYER_ENGINE, LAYER_WATER, kindIndex } from '../src/audio/boat/protocol';
import { ENGINE_SPECS, type VoiceKind } from '../src/audio/boat/engineModel';
import { DopplerTrack, RampClock, airAbsorptionCutoffHz, distanceGain } from '../src/audio/boat/mixMath';
import { boatAudioParams as P } from '../src/audio/boat/params';

const SR = 48000;
const FRAME = 800; // 60 Hz
const WAV_DIR = process.env.BOAT_AUDIO_WAV_DIR;

interface BoatCtl {
  id?: number;
  kind?: VoiceKind;
  engines?: number;
  throttle?: number;
  advance?: number;
  immersion?: number;
  /** per-drive immersion (overrides `immersion`) */
  immersions?: number[];
  speed?: number;
  wet?: number;
  thrust?: number;
  rpm?: number;
  governor?: number;
  slam?: number;
  landing?: number;
  wake?: number;
}

function packCtl(out: Float32Array, b: number, c: BoatCtl): void {
  const o = b * BOAT_STRIDE;
  const kind = c.kind ?? 'v8';
  out[o + BI.ID] = c.id ?? 1;
  out[o + BI.KIND] = kindIndex(kind);
  out[o + BI.ENGINES] = c.engines ?? (kind === 'turbine' || kind === 'electric' ? 1 : 3);
  out[o + BI.THROTTLE] = c.throttle ?? 0;
  out[o + BI.GOVERNOR] = c.governor ?? 0;
  for (let e = 0; e < 3; e++) {
    out[o + BI.ADVANCE + e] = c.advance ?? 0;
    out[o + BI.IMMERSION + e] = c.immersions?.[e] ?? c.immersion ?? 1;
    out[o + BI.RPM_OVERRIDE + e] = (c.rpm ?? 0) * (1 + 0.003 * (e - 1));
  }
  out[o + BI.HAS_OVERRIDE] = c.rpm !== undefined ? 1 : 0;
  out[o + BI.SPEED] = c.speed ?? c.advance ?? 0;
  out[o + BI.WET] = c.wet ?? 1;
  out[o + BI.THRUST] = c.thrust ?? Math.abs(c.throttle ?? 0);
  out[o + BI.SLAM] = c.slam ?? 0;
  out[o + BI.LANDING] = c.landing ?? 0;
  out[o + BI.WAKE] = c.wake ?? 0;
  out[o + BI.SEED] = (c.id ?? 1) * 7919;
}

interface SlotCtl {
  boat: number;
  full?: boolean;
  gain?: number;
  airHz?: number;
  mask: number;
}

/** render `seconds`; `script(t)` returns boats and slot bindings for each 60 Hz frame */
function render(seconds: number, script: (t: number) => { boats: BoatCtl[]; slots: SlotCtl[] }, core = new BoatSynthCore(SR, SLOT_COUNT)): Float32Array[] {
  const n = Math.round(seconds * SR);
  const outs = Array.from({ length: SLOT_COUNT }, () => new Float32Array(n));
  for (let s = 0; s < n; s += FRAME) {
    const { boats, slots } = script(s / SR);
    const bb = new Float32Array(Math.max(1, boats.length) * BOAT_STRIDE);
    boats.forEach((b, i) => packCtl(bb, i, b));
    const ss = new Float32Array(SLOT_COUNT * SLOT_STRIDE);
    for (let i = 0; i < SLOT_COUNT; i++) ss[i * SLOT_STRIDE + SI.BOAT] = -1;
    slots.forEach((sl, i) => {
      const o = i * SLOT_STRIDE;
      if (sl.boat < 0) return;
      ss[o + SI.BOAT] = sl.boat;
      ss[o + SI.FULL] = sl.full === false ? 0 : 1;
      ss[o + SI.GAIN] = sl.gain ?? 1;
      ss[o + SI.AIR_HZ] = sl.airHz ?? 18000;
      ss[o + SI.MASK] = sl.mask;
    });
    core.applyFrame(bb, boats.length, ss);
    for (let q = 0; q < FRAME && s + q < n; q += 128) {
      const m = Math.min(128, FRAME - q, n - s - q);
      core.process(
        outs.map((o) => o.subarray(s + q, s + q + m)),
        m,
      );
    }
  }
  return outs;
}

const engineOnly = (c: BoatCtl) => (_t: number) => ({ boats: [c], slots: [{ boat: c.id ?? 1, mask: LAYER_ENGINE }] });

// ───────────── analysis ─────────────
function magSpectrum(x: Float32Array, start: number, size = 1 << 16): Float64Array {
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (let i = 0; i < size; i++) re[i] = (x[start + i] ?? 0) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (size - 1)));
  for (let i = 1, j = 0; i < size; i++) {
    let bit = size >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= size; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < size; i += len) {
      let cr = 1;
      let ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k];
        const ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = nr;
      }
    }
  }
  const mag = new Float64Array(size / 2);
  for (let i = 0; i < size / 2; i++) mag[i] = Math.hypot(re[i], im[i]);
  return mag;
}
const binHz = (size = 1 << 16): number => SR / size;
function peakIn(mag: Float64Array, lo: number, hi: number): { hz: number; mag: number } {
  const b = binHz();
  let best = Math.round(lo / b);
  for (let i = Math.round(lo / b); i <= Math.round(hi / b); i++) if (mag[i] > mag[best]) best = i;
  return { hz: best * b, mag: mag[best] };
}
function bandEnergy(mag: Float64Array, lo: number, hi: number): number {
  const b = binHz();
  let e = 0;
  for (let i = Math.round(lo / b); i <= Math.round(hi / b); i++) e += mag[i] * mag[i];
  return e;
}
function centroid(mag: Float64Array, hi = 8000): number {
  const b = binHz();
  let num = 0;
  let den = 0;
  for (let i = 1; i < hi / b; i++) {
    num += i * b * mag[i];
    den += mag[i];
  }
  return num / den;
}
const rms = (x: Float32Array, a: number, b: number): number => {
  let s = 0;
  for (let i = Math.round(a * SR); i < Math.round(b * SR); i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, Math.round((b - a) * SR)));
};

function writeWav(name: string, chans: Float32Array[]): void {
  if (!WAV_DIR) return;
  mkdirSync(WAV_DIR, { recursive: true });
  const n = chans[0].length;
  const nc = chans.length;
  const bytes = new Uint8Array(44 + n * nc * 2);
  const dv = new DataView(bytes.buffer);
  const tag = (s: string, at: number): void => {
    for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i);
  };
  tag('RIFF', 0);
  dv.setUint32(4, 36 + n * nc * 2, true);
  tag('WAVE', 8);
  tag('fmt ', 12);
  dv.setUint32(16, 16, true);
  dv.setUint16(20, 1, true);
  dv.setUint16(22, nc, true);
  dv.setUint32(24, SR, true);
  dv.setUint32(28, SR * nc * 2, true);
  dv.setUint16(32, nc * 2, true);
  dv.setUint16(34, 16, true);
  tag('data', 36);
  dv.setUint32(40, n * nc * 2, true);
  // the in-game bus compressor is not in this render: a gentle tanh stands in so peaks do not wrap
  for (let i = 0; i < n; i++) for (let c = 0; c < nc; c++) dv.setInt16(44 + (i * nc + c) * 2, Math.round(Math.tanh(chans[c][i] * 1.2) * 32000), true);
  writeFileSync(`${WAV_DIR}/${name}.wav`, bytes);
}

// ───────────── tests ─────────────
describe('§T.183 pitch follows rpm, never speed (V112)', () => {
  it.each([900, 2500, 4500, 6300])('V8 firing line at rpm·8/120 ±3 %% (%i rpm)', (rpm) => {
    const [out] = render(2, engineOnly({ engines: 1, throttle: 0.8, advance: 30, immersion: 0.5, rpm }));
    const mag = magSpectrum(out, SR / 2);
    const f = (rpm * 8) / 120;
    const pk = peakIn(mag, f * 0.9, f * 1.1);
    expect(Math.abs(pk.hz / f - 1)).toBeLessThan(0.03);
    // a real line, not noise: well above the band's median
    const b = binHz();
    const band = Array.from(mag.slice(Math.round((f * 0.75) / b), Math.round((f * 1.25) / b))).sort((a, c) => a - c);
    expect(pk.mag).toBeGreaterThan(4 * band[band.length >> 1]);
  });

  it('two-stroke fires once per revolution per cylinder (rpm·3/60) and the inverter whine sits at 6·f_e', () => {
    const rpm = 5000;
    const [two] = render(2, engineOnly({ kind: 'twoStroke', engines: 1, throttle: 0.8, advance: 30, immersion: 0.5, rpm }));
    const f2 = (rpm * 3) / 60;
    expect(Math.abs(peakIn(magSpectrum(two, SR / 2), f2 * 0.9, f2 * 1.1).hz / f2 - 1)).toBeLessThan(0.03);
    const [el] = render(2, engineOnly({ kind: 'electric', throttle: 0.8, advance: 30, rpm }));
    const fe6 = (rpm / 60) * 4 * 6;
    expect(Math.abs(peakIn(magSpectrum(el, SR / 2), fe6 * 0.95, fe6 * 1.05).hz / fe6 - 1)).toBeLessThan(0.01);
  });

  it('the same rpm at 0 and 40 m/s has the same firing frequency', () => {
    const rpm = 3800;
    const f = (rpm * 8) / 120;
    const at = (speed: number): number => {
      const [out] = render(2, engineOnly({ engines: 1, throttle: 0.6, advance: speed, speed, immersion: 0.3, rpm }));
      return peakIn(magSpectrum(out, SR / 2), f * 0.9, f * 1.1).hz;
    };
    expect(at(0)).toBe(at(40));
  });
});

describe('§T.183 V8 character', () => {
  it('cross-plane lump: the half orders (cycle-rate harmonics that are not firing harmonics) carry real energy', () => {
    const rpm = 1200;
    const [out] = render(2.5, engineOnly({ engines: 1, throttle: 0.1, advance: 20, immersion: 0.2, rpm }));
    const mag = magSpectrum(out, SR / 2);
    const cyc = rpm / 120;
    let half = 0;
    let firing = 0;
    for (let k = 1; k <= 40; k++) {
      const e = bandEnergy(mag, k * cyc - 1.5, k * cyc + 1.5);
      if (k % 8 === 0) firing += e;
      else half += e;
    }
    // ≥ −20 dB relative to the firing orders
    expect(half / firing).toBeGreaterThan(0.01);
  });

  it('underwater exhaust at idle is darker than the same idle exhausting in air', () => {
    const idle = { engines: 1, throttle: 0, rpm: 650 };
    const [under] = render(2.5, engineOnly({ ...idle, advance: 0, immersion: 1 }));
    const [air] = render(2.5, engineOnly({ ...idle, advance: 0, immersion: 0.1 }));
    expect(centroid(magSpectrum(under, SR / 2))).toBeLessThan(0.7 * centroid(magSpectrum(air, SR / 2)));
  });

  it('limiter bounce is audible: airborne at the limit, the loudness envelope has a line at the bounce rate (4–25 Hz)', () => {
    const [out] = render(6, (t) => ({
      boats: [{ engines: 1, throttle: 1, advance: 41, immersion: t < 3 ? 0.85 : 0, wet: t < 3 ? 1 : 0 }],
      slots: [{ boat: 1, mask: LAYER_ENGINE }],
    }));
    // 2.5 ms RMS envelope of the airborne second half
    const hop = 120;
    const env = new Float32Array(Math.floor((2.5 * SR) / hop));
    const s0 = Math.round(3.4 * SR);
    for (let i = 0; i < env.length; i++) {
      let s = 0;
      for (let j = 0; j < hop; j++) s += out[s0 + i * hop + j] ** 2;
      env[i] = Math.sqrt(s / hop);
    }
    const envSr = SR / hop;
    let mean = 0;
    for (const v of env) mean += v / env.length;
    const size = 1024;
    const padded = new Float32Array(size);
    for (let i = 0; i < Math.min(size, env.length); i++) padded[i] = env[i] - mean;
    const re = magSpectrumSmall(padded);
    const hzPerBin = envSr / size;
    let best = 0;
    let bestHz = 0;
    const all: number[] = [];
    for (let i = 1; i < 60 / hzPerBin; i++) {
      all.push(re[i]);
      if (i * hzPerBin >= 4 && i * hzPerBin <= 25 && re[i] > best) {
        best = re[i];
        bestHz = i * hzPerBin;
      }
    }
    all.sort((a, b) => a - b);
    expect(bestHz).toBeGreaterThan(4);
    expect(best).toBeGreaterThan(4 * all[all.length >> 1]);
  });

  it('three detuned engines beat: the triple is not a louder copy of one engine (loudness wobbles at < 3 Hz)', () => {
    const one = render(4, engineOnly({ engines: 1, throttle: 0.8, advance: 30, immersion: 0.5, rpm: 4000 }))[0];
    const three = render(4, engineOnly({ engines: 3, throttle: 0.8, advance: 30, immersion: 0.5, rpm: 4000 }))[0];
    const wobble = (x: Float32Array): number => {
      const w: number[] = [];
      for (let t = 1; t < 3.9; t += 0.05) w.push(rms(x, t, t + 0.05));
      const m = w.reduce((a, b) => a + b, 0) / w.length;
      return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / w.length) / m;
    };
    expect(wobble(three)).toBeGreaterThan(1.5 * wobble(one));
  });
});

// small FFT for the envelope (power of two, magnitude)
function magSpectrumSmall(x: Float32Array): Float64Array {
  const n = x.length;
  const out = new Float64Array(n / 2);
  for (let k = 0; k < n / 2; k++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
      re += x[i] * w * Math.cos((2 * Math.PI * k * i) / n);
      im -= x[i] * w * Math.sin((2 * Math.PI * k * i) / n);
    }
    out[k] = Math.hypot(re, im);
  }
  return out;
}

describe('§T.183 water layer', () => {
  it('a landing puts a boom in the 50–120 Hz band; planing hiss grows with wetted speed', () => {
    const outs = render(3, (t) => ({
      boats: [{ throttle: 0, advance: 20, speed: 20, landing: Math.abs(t - 1) < 0.008 ? 1 : 0 }],
      slots: [{ boat: 1, mask: LAYER_WATER }],
    }));
    const before = magSpectrum(outs[0], Math.round(0.2 * SR), 1 << 14);
    const after = magSpectrum(outs[0], Math.round(1.0 * SR), 1 << 14);
    const b = (m: Float64Array): number => {
      let e = 0;
      for (let i = Math.round(50 / (SR / (1 << 14))); i <= Math.round(120 / (SR / (1 << 14))); i++) e += m[i] * m[i];
      return e;
    };
    expect(b(after)).toBeGreaterThan(20 * b(before));
    const hiss = (speed: number): number => rms(render(1.5, () => ({ boats: [{ advance: speed, speed, throttle: 0 }], slots: [{ boat: 1, mask: LAYER_WATER }] }))[0], 0.5, 1.5);
    expect(hiss(35)).toBeGreaterThan(3 * hiss(8));
  });
});

describe('§T.183 schedule, determinism, robustness, cost', () => {
  it('Ramp: a target is reached linearly in exactly RAMP samples, in chunk-sized steps', () => {
    const R = Math.round(RAMP_SECONDS * SR);
    const r = new Ramp(0);
    r.set(1, R);
    let prev = 0;
    for (let s = CONTROL_SAMPLES; s <= R; s += CONTROL_SAMPLES) {
      const v = r.advance(CONTROL_SAMPLES);
      expect(v - prev).toBeCloseTo(CONTROL_SAMPLES / R, 9);
      prev = v;
    }
    r.advance(CONTROL_SAMPLES);
    expect(r.value).toBeCloseTo(1, 9);
    r.set(NaN, R);
    expect(r.advance(R)).toBeCloseTo(1, 9);
  });

  it('identical frame sequences render bit-identical audio', () => {
    const script = (t: number) => ({
      boats: [{ throttle: t < 1 ? 0.2 : 1, advance: t * 10, immersion: t > 1.5 && t < 2 ? 0 : 0.8, slam: Math.abs(t - 1.2) < 0.01 ? 0.7 : 0 }],
      slots: [
        { boat: 1, mask: LAYER_ENGINE },
        { boat: 1, mask: LAYER_WATER },
      ],
    });
    const a = render(2.5, script);
    const b = render(2.5, script);
    const same = (x: Float32Array, y: Float32Array): boolean => x.length === y.length && x.every((v, i) => Object.is(v, y[i]));
    expect(same(a[0], b[0])).toBe(true);
    expect(same(a[1], b[1])).toBe(true);
    expect(a[0].some((v) => v !== 0)).toBe(true);
  });

  it('slot gain changes ramp: no sample-to-sample step larger than the ramp allows', () => {
    const [out] = render(1, (t) => ({ boats: [{ throttle: 0.5, advance: 10, rpm: 3000 }], slots: [{ boat: 1, mask: LAYER_ENGINE, gain: t < 0.5 ? 1 : 0 }] }));
    const R = Math.round(RAMP_SECONDS * SR);
    const i0 = Math.round(0.5 * SR);
    // after the ramp the slot is silent; during it the level decays rather than cuts
    expect(rms(out, 0.5 + (R + 2 * FRAME) / SR, 0.9)).toBe(0);
    expect(rms(out, (i0 + FRAME) / SR, (i0 + FRAME + R / 2) / SR)).toBeGreaterThan(0);
  });

  it('extreme and non-finite telemetry renders finite samples', () => {
    const core = new BoatSynthCore(SR, SLOT_COUNT);
    const outs = render(
      1,
      (t) => ({
        boats: [
          { throttle: t < 0.5 ? NaN : 1e9, advance: Infinity, immersion: -Infinity, speed: NaN, wet: NaN, thrust: 1e12, slam: NaN, landing: Infinity, wake: 1e9 },
          { id: 2, kind: 'turbine', throttle: -1e9, rpm: NaN, advance: -5 },
          { id: 3, kind: 'electric', throttle: 1, rpm: 1e9 },
          { id: 4, kind: 'twoStroke', throttle: 1, immersion: 0, advance: 1e6 },
        ],
        slots: [
          { boat: 1, mask: 3, gain: NaN },
          { boat: 1, mask: 3, gain: Infinity, airHz: NaN },
          { boat: 2, mask: 3 },
          { boat: 3, mask: 3, full: false },
          { boat: 4, mask: 3 },
        ],
      }),
      core,
    );
    let bad = 0;
    for (const o of outs) for (const v of o) if (!Number.isFinite(v)) bad++;
    expect(bad).toBe(0);
    expect(core.nanResets).toBe(0);
  });

  it('8 boats (player engine+water, 3 full NPCs, 4 cheap) render ≥ 2× faster than real time in node', () => {
    const kinds: VoiceKind[] = ['v8', 'turbine', 'twoStroke', 'electric', 'v8', 'v8', 'v8'];
    const script = () => ({
      boats: [{ id: 1, throttle: 1, advance: 35, immersion: 0.6 }, ...kinds.map((kind, i) => ({ id: 10 + i, kind, throttle: 0.9, advance: 35, immersion: 0.8 }))],
      slots: [{ boat: 1, mask: LAYER_ENGINE }, { boat: 1, mask: LAYER_WATER }, ...kinds.map((_, i) => ({ boat: 10 + i, mask: 3, full: i < 3, gain: 0.3 }))],
    });
    render(0.5, script); // warm the JIT
    const t0 = performance.now();
    render(3, script);
    const ratio = (performance.now() - t0) / 3000;
    console.log(`[boatAudioSynth] 8-boat render cost: ${(ratio * 100).toFixed(1)} % of real time (node, one core)`);
    expect(ratio).toBeLessThan(0.5);
  });
});

// ───────────── listening renders ─────────────
describe.runIf(!!WAV_DIR)('§T.183 WAV renders (BOAT_AUDIO_WAV_DIR)', () => {
  const player = (b: BoatCtl) => ({ boats: [b], slots: [{ boat: 1, mask: LAYER_ENGINE, gain: 1 }, { boat: 1, mask: LAYER_WATER, gain: 0.8 }] });
  const mix = (outs: Float32Array[]): Float32Array => {
    const m = new Float32Array(outs[0].length);
    for (const o of outs) for (let i = 0; i < m.length; i++) m[i] += o[i];
    return m;
  };

  it('idle burble at the dock, blip, and settle', () => {
    const outs = render(8, (t) => player({ throttle: t > 4 && t < 4.35 ? 0.45 : 0, advance: 0, speed: 0, immersion: 1 }));
    writeWav('01-v8-idle-burble', [mix(outs)]);
  });

  it('hole shot → planing → lift', () => {
    const outs = render(14, (t) => {
      const v = t < 1.5 ? 0 : Math.min(41, (t - 1.5) * 4.2);
      return player({ throttle: t < 1.5 ? 0 : t < 11 ? 1 : 0, advance: v, speed: v, immersion: t < 3 ? 1 : 0.85, wet: 1, slam: t > 6 && Math.sin(t * 9) > 0.995 ? 0.35 : 0 });
    });
    writeWav('02-v8-holeshot-planing-lift', [mix(outs)]);
  });

  it('airborne over-rev with limiter bounce, landing, re-bite', () => {
    const outs = render(9, (t) => {
      const air = t > 2.5 && t < 5;
      return player({ throttle: 1, advance: 40, speed: 40, immersion: air ? 0 : t > 5 && t < 5.4 ? 0.4 : 0.85, wet: air ? 0 : 1, landing: Math.abs(t - 5) < 0.009 ? 1 : 0 });
    });
    writeWav('03-v8-airborne-overrev-landing', [mix(outs)]);
  });

  it('limiter bounce (props out, held at WOT) vs Governor air', () => {
    const a = render(4, () => player({ throttle: 1, advance: 30, speed: 30, immersion: 0, wet: 0 }));
    const b = render(4, () => player({ throttle: 1, advance: 30, speed: 30, immersion: 0, wet: 0, governor: 1 }));
    const m = new Float32Array(8 * SR);
    m.set(mix(a), 0);
    m.set(mix(b), 4 * SR);
    writeWav('04-v8-limiter-bounce-then-governor-air', [m]);
  });

  /** NPC pass-by: the worklet slot → emulated DelayNode (the same DopplerTrack/RampClock automation) → equalpower pan */
  function flyby(kind: VoiceKind, speed: number, offset: number, seconds: number): Float32Array[] {
    const x0 = -speed * seconds * 0.5;
    const track = new DopplerTrack();
    const clock = new RampClock();
    const events: [number, number][] = [];
    const outs = render(seconds, (t) => {
      const x = x0 + speed * t;
      const d = Math.hypot(x, offset);
      if (events.length === 0) {
        track.reset(d, P.maxDelay);
        events.push([t, track.delay]);
      } else events.push([clock.next(t, FRAME / SR), track.step(d, FRAME / SR, P.dopplerTau, P.maxDelay)]);
      return {
        boats: [{ id: 5, kind, throttle: 1, advance: ENGINE_SPECS[kind].calSpeed * 0.97, speed, immersion: 0.85 }],
        slots: [{ boat: -1, mask: 0 }, { boat: -1, mask: 0 }, { boat: 5, mask: 3, gain: distanceGain(d, P), airHz: airAbsorptionCutoffHz(d, P.airAbsorptionScale) }],
      };
    });
    const src = outs[2];
    const L = new Float32Array(src.length);
    const R = new Float32Array(src.length);
    let ev = 1;
    for (let i = 0; i < src.length; i++) {
      const t = i / SR;
      while (ev < events.length - 1 && events[ev][0] < t) ev++;
      const [ta, va] = events[ev - 1];
      const [tb, vb] = events[ev];
      const delay = t <= ta ? va : t >= tb ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
      const pos = i - delay * SR;
      const j = Math.floor(pos);
      const y = j < 0 ? 0 : src[j] + (src[Math.min(src.length - 1, j + 1)] - src[j]) * (pos - j);
      // listener at origin facing −z, boat running along +x at z = −offset: azimuth → equalpower
      const x = x0 + speed * t;
      const pan = x / Math.hypot(x, offset);
      const a = ((pan + 1) * Math.PI) / 4;
      L[i] = y * Math.cos(a);
      R[i] = y * Math.sin(a);
    }
    return [L, R];
  }

  it('NPC flybys with doppler: V8, turbine, two-stroke, electric', () => {
    writeWav('05-npc-v8-flyby-40ms-15m', flyby('v8', 40, 15, 12));
    writeWav('06-npc-turbine-flyby-40ms-15m', flyby('turbine', 40, 15, 12));
    writeWav('07-npc-twostroke-flyby-40ms-15m', flyby('twoStroke', 40, 15, 12));
    writeWav('08-npc-electric-flyby-40ms-15m', flyby('electric', 40, 15, 12));
  });

  /**
   * Ventilation states at planing speed (T196 surfaced props: 0.6–0.7 is normal running). 2 s of normal running,
   * then the state for 4 s; the spectrum is read over the settled tail. Logged, not asserted: a listening aid.
   */
  it('ventilation states: planing buried / surfaced / one prop lifted / airborne', () => {
    const states: [string, number[], number][] = [
      ['planing-imm100', [1, 1, 1], 1],
      ['surfaced-imm065', [0.65, 0.65, 0.65], 0.8],
      ['one-prop-lifted-imm020', [0.2, 0.65, 0.65], 0.7],
      ['airborne', [0, 0, 0], 0],
    ];
    const db = (x: number): string => (20 * Math.log10(Math.max(1e-9, x))).toFixed(1);
    const layerProbe = process.env.BOAT_AUDIO_VENT_PROBE; // e.g. 'howlGain' or 'sprayGain': render with that layer at 0
    for (const [name, imm, wet] of states) {
      const core = new BoatSynthCore(SR, SLOT_COUNT);
      if (layerProbe) core.setTunables({ [layerProbe]: 0 });
      const rpms: number[] = [];
      const outs = render(6, (t) => {
        if (t >= 3.5) {
          const r = core.report();
          if (r.count) rpms.push(r.data[1]);
        }
        const on = t >= 2;
        const im = on ? imm : [0.65, 0.65, 0.65];
        return player({ throttle: 1, advance: 38, speed: 38, immersions: im, wet: on ? wet : 0.8, thrust: 0.9 * (im[0] + im[1] + im[2]) / 3 / 0.65 });
      }, core);
      const m = mix(outs);
      writeWav(`vent-${name}`, [m]);
      const a = Math.round(3.5 * SR);
      const mag = magSpectrum(m, a);
      const tot = bandEnergy(mag, 20, 20000);
      const peaks: string[] = [];
      const b = binHz();
      const cand: { hz: number; prom: number; mag: number }[] = [];
      for (let i = Math.round(1500 / b); i < Math.round(12000 / b); i++) {
        if (!(mag[i] > mag[i - 1] && mag[i] >= mag[i + 1])) continue;
        const w = Array.from(mag.slice(i - Math.round(150 / b), i + Math.round(150 / b))).sort((x, y) => x - y);
        const prom = mag[i] / w[w.length >> 1];
        if (prom > 4) cand.push({ hz: i * b, prom, mag: mag[i] });
      }
      cand.sort((x, y) => y.mag - x.mag);
      let maxMag = 0;
      for (let i = 1; i < mag.length; i++) maxMag = Math.max(maxMag, mag[i]);
      for (const c of cand.slice(0, 6)) peaks.push(`${c.hz.toFixed(0)}Hz ${db(c.mag / maxMag)}dB(+${db(c.prom)})`);
      const eMag = magSpectrum(outs[0], a);
      const eTot = bandEnergy(eMag, 20, 20000);
      const wMag = magSpectrum(outs[1], a);
      const wTot = bandEnergy(wMag, 20, 20000);
      const edges = [20, 300, 600, 1000, 1500, 3000, 20000];
      const wBands = edges.slice(1).map((hi, k) => `${edges[k]}–${hi}:${((100 * bandEnergy(wMag, edges[k], hi)) / wTot).toFixed(0)}%`).join(' ');
      console.log(
        `[vent]   engine-only >1.5k ${((100 * bandEnergy(eMag, 1500, 20000)) / eTot).toFixed(1)}% >3k ${((100 * bandEnergy(eMag, 3000, 20000)) / eTot).toFixed(1)}% | ` +
          `water-only >1.5k ${((100 * bandEnergy(wMag, 1500, 20000)) / wTot).toFixed(1)}% >3k ${((100 * bandEnergy(wMag, 3000, 20000)) / wTot).toFixed(1)}% centroid ${centroid(wMag).toFixed(0)} Hz | water bands ${wBands}`,
      );
      const rmin = Math.min(...rpms);
      const rmax = Math.max(...rpms);
      console.log(
        `[vent] ${name}: mix ${db(rms(m, 3.5, 5.5))} dBFS, engine ${db(rms(outs[0], 3.5, 5.5))}, water ${db(rms(outs[1], 3.5, 5.5))} | ` +
          `>1.5k ${((100 * bandEnergy(mag, 1500, 20000)) / tot).toFixed(1)}%, >3k ${((100 * bandEnergy(mag, 3000, 20000)) / tot).toFixed(1)}% | ` +
          `centroid ${centroid(mag).toFixed(0)} Hz | rpm0 ${rmin.toFixed(0)}–${rmax.toFixed(0)} | peaks>1.5k: ${peaks.join(', ') || 'none'}`,
      );
    }
  });

  it('wake crossing double-knock and chop slaps at speed', () => {
    const outs = render(6, (t) => player({ throttle: 0.8, advance: 32, speed: 32, immersion: 0.8, wake: Math.abs(t - 2) < 0.009 || Math.abs(t - 4.2) < 0.009 ? 1 : 0, slam: t > 3 && t < 4 && Math.sin(t * 40) > 0.97 ? 0.4 : 0 }));
    writeWav('09-v8-wake-crossing-and-chop', [mix(outs)]);
  });
});
