/**
 * §T.183 engine + water voices, sample-rate DSP. Every pitch in this file is derived from an engine
 * state (`rpm`, `spool`) — never from boat speed (V112). Speed reaches only gains and filter
 * cutoffs of the WATER layer and the exhaust-muffling crossfade.
 *
 *   V8 (cross-plane, firing order 1-8-4-3-6-5-7-2)
 *     crank phase ─► per-cylinder exhaust pulse  g(t) = v·e^(1−v), width ∝ 1/rpm, sharper on load
 *                   + turbulence noise under the pulse (dry ethanol grit)
 *                   + per-cylinder gain/timing signature, per-cycle lope variance at idle
 *        bank L (1,3,5,7) ─► pipe waveguide 0.85 m ─┐   odd/even bank sequence L R R L R L L R is
 *        bank R (2,4,6,8) ─► pipe waveguide 1.15 m ─┴► collector   what makes the half-order lump
 *     collector ─► body 95 Hz + midsection 420 Hz ─► soft clip (drive ∝ load)
 *        ├─ in air:     lowpass opening with load + rpm ............... bark
 *        └─ underwater: lowpass ~300 Hz × bubble AM + bubble resonator + idle-relief rasp
 *     pops: overrun/limiter/re-fire bursts injected INTO the pipe, so they ring like the exhaust
 *     lower-unit gear whine at pinion mesh (14 × crank)
 *   TWO-STROKE   3 cyl/rev, expansion-chamber positive reflection, nasal band, ring-ding skip-firing
 *   TURBINE      gas-generator blade-pass whine + shaft sidebands, combustor roar, power-turbine tone
 *   ELECTRIC     PMSM 6/12/24× electrical whine, inverter carrier (synchronous steps below base, async above)
 *   WATER        planing hiss, water rush, prop-wash spray roar, ventilation churn (hollow, < 2 kHz) at blade rate,
 *                hull slap, landing boom, wake double-knock
 */
import { DcBlock, Noise, OnePole, Svf, Waveguide, clamp, pulseShape, sin01, smoothstep, softClip } from './dsp';
import type { VoiceTunables } from './protocol';

export interface EngineFrame {
  /** rpm at the start and end of this control chunk (linearly interpolated per sample) */
  rpmA: number;
  rpmB: number;
  load: number;
  bark: number;
  thrEff: number;
  spool: number;
  fuelOn: boolean;
  overrun: boolean;
  overrunTime: number;
  limiterActivity: number;
  refireCount: number;
  /** 0 = exhaust in air, 1 = through the hub underwater */
  muffle: number;
  /** crank : prop reduction (ventilation howl pitch) */
  gear: number;
}

export interface EngineVoice {
  /** ADDS n samples × gain into out[off..] */
  render(out: Float32Array, off: number, n: number, f: EngineFrame, t: VoiceTunables, gain: number): void;
}

const FIRING_ORDER = [1, 8, 4, 3, 6, 5, 7, 2] as const;
const SPEED_OF_HOT_GAS = 520;

// ───────────────────────────── shared: exhaust exit (air / underwater) + pops ─────────────────────────────
class ExhaustExit {
  private airLp = new Svf();
  private underLp = new Svf();
  private relief = new Svf();
  private bubble = new Svf();
  private bubbleAm = new OnePole();
  private dc = new DcBlock();
  private noise: Noise;
  private bubbleHz = 300;
  constructor(
    private sr: number,
    seed: number,
    private cheap: boolean,
  ) {
    this.noise = new Noise(seed ^ 0xb0bb1e);
    this.bubbleAm.setHz(7, sr);
    this.relief.set(1100, 0.8, sr);
    this.dc.setHz(18, sr);
  }
  /** once per chunk */
  configure(load: number, rpmN: number, brightHz: number): void {
    // T204: +2600·rpmN opened the in-air exit to 5.8 kHz at WOT; the bark lives below ~4 kHz
    this.airLp.set(brightHz * (0.55 + 0.45 * load) + 1400 * rpmN, 0.7, this.sr);
    this.underLp.set(230 + 260 * rpmN + 150 * load, 0.9, this.sr);
  }
  /** a firing reached the hub: re-pitch the bubble */
  kick(): void {
    this.bubbleHz = 140 + 380 * this.noise.next();
    this.bubble.set(this.bubbleHz, 7, this.sr);
  }
  run(x: number, pulse: number, muffle: number): number {
    const y = this.dc.run(x);
    this.airLp.run(y);
    if (muffle <= 0.001) return this.airLp.lp;
    this.underLp.run(y);
    const am = 0.45 + 1.6 * Math.max(0, this.bubbleAm.lp(this.noise.bi() * 3));
    let under = this.underLp.lp * am * 1.1;
    if (!this.cheap) {
      this.bubble.run(pulse * 0.6);
      this.relief.run(y);
      // the idle-relief port is a trace of rasp: at 0.1 it put MORE energy above 1 kHz into the
      // through-the-hub exhaust than the in-air idle had (measured), the opposite of underwater
      under += this.bubble.bp * 1.4 + this.relief.hp * 0.025;
    }
    return this.airLp.lp * (1 - muffle) + under * muffle;
  }
}

class Pops {
  env = 0;
  private decay: number;
  private noise: Noise;
  private lastRefire = -1;
  constructor(sr: number, seed: number) {
    this.noise = new Noise(seed ^ 0x9095);
    this.decay = Math.exp(-1 / (0.0028 * sr));
  }
  /** per chunk: returns the per-sample pop probability */
  rate(f: EngineFrame, t: VoiceTunables, sr: number, rpm: number): number {
    if (this.lastRefire < 0) this.lastRefire = f.refireCount;
    if (f.refireCount !== this.lastRefire) {
      this.lastRefire = f.refireCount;
      // unburnt charge lighting off in the hot pipe when fuel comes back
      this.env = Math.max(this.env, 0.8 + 0.4 * this.noise.next());
    }
    const rpmN = clamp((rpm - 1500) / 5000, 0, 1);
    let lambda = 0;
    if (f.overrun) lambda += t.popRate * Math.exp(-f.overrunTime / 0.9) * (0.3 + 0.7 * rpmN);
    lambda += f.limiterActivity * t.popRate * 0.35;
    return lambda / sr;
  }
  next(p: number): number {
    if (p > 0 && this.noise.next() < p) this.env = Math.max(this.env, 0.35 + 0.65 * this.noise.next());
    if (this.env < 1e-4) return 0;
    const v = this.env * this.noise.bi();
    this.env *= this.decay;
    return v;
  }
}

/** combustion loudness ~0.16 (idle) … 1 (full load at the limiter); overrun keeps a pumping floor */
export function loudness(load: number, rpmN: number, overrun: boolean): number {
  const l = overrun ? 0.12 : load;
  return (0.26 + 0.74 * Math.min(1, l)) * (0.55 + 0.45 * rpmN);
}

function seeded(seed: number): Noise {
  return new Noise(seed);
}

// ───────────────────────────── V8 ─────────────────────────────
export class V8Voice implements EngineVoice {
  private phase: number;
  private next = 0;
  private nextAngle: number;
  private readonly timing = new Float32Array(8);
  private readonly cylGain = new Float32Array(8);
  private readonly age = new Float32Array(8).fill(1e9);
  private readonly amp = new Float32Array(8);
  private readonly bankOf = new Uint8Array(8);
  private pipeL: Waveguide;
  private pipeR: Waveguide;
  private body = new Svf();
  private mid = new Svf();
  private exit: ExhaustExit;
  private pops: Pops;
  private noise: Noise;
  private lope = new OnePole();
  private whinePhase = 0;
  private readonly sr: number;
  private readonly cheap: boolean;

  constructor(sr: number, seed: number, cheap = false) {
    this.sr = sr;
    this.cheap = cheap;
    const rng = seeded(seed);
    this.noise = new Noise(seed ^ 0x5eed);
    this.phase = rng.next();
    for (let i = 0; i < 8; i++) {
      // 1-based cylinder numbers: odd = left bank, even = right bank
      this.bankOf[i] = FIRING_ORDER[i] % 2 === 1 ? 0 : 1;
      this.timing[i] = 0.004 * rng.next();
      this.cylGain[i] = 0.86 + 0.28 * rng.next();
    }
    this.nextAngle = this.timing[0];
    // rebuilt engines: pipe lengths differ a few % engine to engine
    const lenL = 0.85 * (1 + 0.04 * rng.bi());
    const lenR = 1.15 * (1 + 0.04 * rng.bi());
    this.pipeL = new Waveguide((sr * 2 * lenL) / SPEED_OF_HOT_GAS, -0.58, 3200, sr);
    this.pipeR = new Waveguide((sr * 2 * lenR) / SPEED_OF_HOT_GAS, -0.52, 2800, sr);
    this.body.set(92 * (1 + 0.05 * rng.bi()), 1.3, sr);
    this.mid.set(420 * (1 + 0.06 * rng.bi()), 1.6, sr);
    this.exit = new ExhaustExit(sr, seed, cheap);
    this.pops = new Pops(sr, seed);
    this.lope.setHz(1.6, sr);
  }

  render(out: Float32Array, off: number, n: number, f: EngineFrame, t: VoiceTunables, gain: number): void {
    const sr = this.sr;
    const rpmMid = 0.5 * (f.rpmA + f.rpmB);
    const rpmN = clamp(rpmMid / 6800, 0, 1);
    const load = f.load;
    // cam lope: big overlap only matters at low rpm and light load
    const lope = t.lopeDepth * (1 - smoothstep(900, 2400, rpmMid)) * (1 - 0.7 * load);
    const pulseAmp = f.fuelOn ? (0.3 + 0.7 * load) * (1 + Math.min(1.5, f.bark * 2)) : 0.06;
    const turb = 0.3 + 0.5 * load;
    const drive = 1.4 + 3.2 * load + 1.2 * rpmN;
    const bright = this.cheap ? 2200 : 3200;
    this.exit.configure(load, rpmN, bright);
    const popP = this.cheap ? 0 : this.pops.rate(f, t, sr, rpmMid);
    const whine = this.cheap ? 0 : t.gearWhineGain * (0.2 + load) * rpmN * rpmN * (1 - 0.7 * f.muffle);
    const inv = 1 / n;
    // LOUDNESS LAW. Pulse energy ∝ width ∝ 1/rpm while pulse rate ∝ rpm, so the synthesis alone keeps
    // idle within ~3 dB of full throttle. A real outboard spans ~15 dB idle → WOT: set it explicitly.
    const norm = 1.25 * loudness(load, rpmN, f.overrun);

    for (let s = 0; s < n; s++) {
      const rpm = f.rpmA + (f.rpmB - f.rpmA) * (s * inv);
      const wob = 1 + lope * 0.02 * this.lope.lp(this.noise.bi() * 6);
      const cyc = (Math.max(0, rpm) * wob) / 120 / sr; // 4-stroke: one cycle = 2 revolutions
      this.phase += cyc;
      // firing: angles k/8 (+ signature timing), phase wraps once per cycle
      while (this.phase >= this.nextAngle) {
        const k = this.next;
        const variance = 1 + lope * 0.5 * this.noise.bi();
        this.amp[k] = pulseAmp * this.cylGain[k] * variance;
        this.age[k] = 0;
        if (k === 0 || k === 4) this.exit.kick();
        this.next = k + 1;
        if (this.next === 8) {
          this.next = 0;
          this.phase -= 1;
        }
        this.nextAngle = this.next / 8 + this.timing[this.next] + lope * 0.006 * this.noise.next();
      }
      // exhaust pulses: peak time ∝ 1/rpm, sharper on load; clamped to physical 0.5–5 ms
      const width = 40 / Math.max(300, rpm);
      // blowdown front: ~1.5 ms at idle, sub-ms on load — the transient IS the V8's crackle
      const peak = clamp(width * (0.028 - 0.014 * load), 0.00035, 0.0016);
      const invPeak = 1 / peak;
      let bl = 0;
      let br = 0;
      let pulseSum = 0;
      for (let c = 0; c < 8; c++) {
        const a = this.age[c];
        if (a > peak * 10) {
          this.age[c] = 1e9;
          continue;
        }
        const g = pulseShape(a * invPeak) * this.amp[c];
        const p = g * (1 + turb * this.noise.bi());
        if (this.bankOf[c] === 0) bl += p;
        else br += p;
        pulseSum += g;
        this.age[c] = a + 1 / sr;
      }
      const pop = this.pops.next(popP);
      bl += pop * 2.2;
      const yl = this.pipeL.run(bl);
      const yr = this.cheap ? br : this.pipeR.run(br);
      let x = yl + 0.88 * yr;
      this.body.run(x);
      this.mid.run(x);
      x = x + 1.6 * this.body.bp + 0.5 * this.mid.bp;
      x = softClip(x * drive) / (0.35 * drive + 0.65);
      let y = this.exit.run(x, pulseSum, f.muffle);
      y += pop * 0.25 * (1 - f.muffle);
      if (whine > 0) {
        this.whinePhase += (rpm / 60) * 14 / sr;
        if (this.whinePhase > 1) this.whinePhase -= 1;
        y += whine * (sin01(this.whinePhase) + 0.3 * sin01(this.whinePhase * 2));
      }
      out[off + s] += y * norm * gain;
    }
  }
}

// ───────────────────────────── two-stroke triple ─────────────────────────────
export class TwoStrokeVoice implements EngineVoice {
  private phase: number;
  private next = 0;
  private nextAngle = 0;
  private readonly age = new Float32Array(3).fill(1e9);
  private readonly amp = new Float32Array(3);
  private readonly cylGain = new Float32Array(3);
  private chamber: Waveguide;
  private nasal = new Svf();
  private ding = new Svf();
  private exit: ExhaustExit;
  private pops: Pops;
  private noise: Noise;
  private whinePhase = 0;
  constructor(
    private sr: number,
    seed: number,
    private cheap = false,
  ) {
    const rng = seeded(seed);
    this.noise = new Noise(seed ^ 0x2575);
    this.phase = rng.next();
    for (let i = 0; i < 3; i++) this.cylGain[i] = 0.85 + 0.3 * rng.next();
    this.chamber = new Waveguide((sr * 2 * 0.62 * (1 + 0.03 * rng.bi())) / SPEED_OF_HOT_GAS, 0.7, 4200, sr);
    this.nasal.set(1050 * (1 + 0.05 * rng.bi()), 1.4, sr);
    this.ding.set(2650 * (1 + 0.04 * rng.bi()), 12, sr); // T204: Q 28 rang as a steady 2.7 kHz tone at idle
    this.exit = new ExhaustExit(sr, seed, cheap);
    this.pops = new Pops(sr, seed);
  }
  render(out: Float32Array, off: number, n: number, f: EngineFrame, t: VoiceTunables, gain: number): void {
    const sr = this.sr;
    const rpmMid = 0.5 * (f.rpmA + f.rpmB);
    const rpmN = clamp(rpmMid / 7900, 0, 1);
    const load = f.load;
    // ring-ding: at light load a two-stroke 4-strokes — it misses firings irregularly
    const skip = 0.5 * (1 - smoothstep(0.08, 0.35, f.thrEff)) * (1 - smoothstep(1400, 3200, rpmMid));
    const pulseAmp = f.fuelOn ? (0.35 + 0.65 * load) * (1 + Math.min(1.2, f.bark * 2)) : 0.1;
    const drive = 2.5 + 4 * load + 2 * rpmN;
    this.exit.configure(load, rpmN, 4200);
    const popP = this.cheap ? 0 : this.pops.rate(f, t, sr, rpmMid) * 1.4;
    const whine = this.cheap ? 0 : t.gearWhineGain * (0.2 + load) * rpmN * rpmN * (1 - 0.7 * f.muffle);
    const level = 1.6 * loudness(load, rpmN, f.overrun);
    const inv = 1 / n;
    for (let s = 0; s < n; s++) {
      const rpm = f.rpmA + (f.rpmB - f.rpmA) * (s * inv);
      this.phase += Math.max(0, rpm) / 60 / sr; // fires every revolution
      while (this.phase >= this.nextAngle) {
        const k = this.next;
        const fire = this.noise.next() >= skip;
        this.amp[k] = (fire ? pulseAmp : 0.08) * this.cylGain[k];
        this.age[k] = 0;
        if (k === 0) this.exit.kick();
        this.next = k + 1;
        if (this.next === 3) {
          this.next = 0;
          this.phase -= 1;
        }
        this.nextAngle = this.next / 3 + 0.003 * this.noise.next();
      }
      const width = 30 / Math.max(300, rpm);
      const peak = clamp(width * 0.05, 0.0003, 0.003);
      const invPeak = 1 / peak;
      let src = 0;
      for (let c = 0; c < 3; c++) {
        const a = this.age[c];
        if (a > peak * 10) {
          this.age[c] = 1e9;
          continue;
        }
        src += pulseShape(a * invPeak) * this.amp[c] * (1 + 0.45 * this.noise.bi());
        this.age[c] = a + 1 / sr;
      }
      const pop = this.pops.next(popP);
      const y0 = this.chamber.run(src + pop * 2);
      this.nasal.run(y0);
      let x = y0 * 0.6 + this.nasal.bp * 1.8;
      if (!this.cheap) {
        this.ding.run(src);
        x += this.ding.bp * 0.9 * (1 - rpmN);
      }
      x = softClip(x * drive) / (0.35 * drive + 0.65);
      let y = this.exit.run(x, src, f.muffle);
      if (whine > 0) {
        this.whinePhase += ((rpm / 60) * 13) / sr;
        if (this.whinePhase > 1) this.whinePhase -= 1;
        y += whine * sin01(this.whinePhase);
      }
      out[off + s] += y * level * gain;
    }
  }
}

// ───────────────────────────── turbine ─────────────────────────────
export class TurbineVoice implements EngineVoice {
  private n1Phase = 0;
  private bpPhase = 0;
  private ptPhase = 0;
  private roar = new Svf();
  private rumble = new Svf();
  private intake = new Svf();
  private flutter = new OnePole();
  private noise: Noise;
  private readonly blades: number;
  constructor(
    private sr: number,
    seed: number,
    private cheap = false,
  ) {
    const rng = seeded(seed);
    this.noise = new Noise(seed ^ 0x7b1e);
    // T204: 11 blades on a 41 000 rpm spool put a constant 4.9 kHz whine (+9.8 kHz) on the idling grid —
    // the menu's shrill tone. A big marine gas generator (22 000 rpm, 9 blades) whines at 2.2–3.3 kHz
    this.blades = 9;
    this.n1Phase = rng.next();
    this.flutter.setHz(4, sr);
    this.rumble.set(85, 0.7, sr);
    this.intake.set(2400, 0.7, sr);
  }
  render(out: Float32Array, off: number, n: number, f: EngineFrame, _t: VoiceTunables, gain: number): void {
    const sr = this.sr;
    const spool = clamp(f.spool, 0, 1);
    // gas generator 52%→100% of 22 000 rpm over the spool; the lever never sets pitch directly
    const n1Hz = ((0.52 + 0.48 * spool) * 22000) / 60;
    const rpmMid = 0.5 * (f.rpmA + f.rpmB);
    const ptHz = ((rpmMid * 9) / 60) * 7; // power turbine through a 9:1 box, 7 blades
    this.roar.set(520 + 2000 * spool, 0.6, sr);
    // idle whine is a trace; it comes up with spool
    const whineG = 0.012 + 0.16 * spool * spool;
    const roarG = 0.12 + 0.8 * Math.pow(spool, 1.5);
    const ptG = this.cheap ? 0 : 0.04 * (0.3 + f.load) * clamp(rpmMid / 3000, 0, 1);
    for (let s = 0; s < n; s++) {
      const fl = 1 + 0.002 * this.flutter.lp(this.noise.bi() * 8);
      const n1 = n1Hz * fl;
      this.n1Phase += n1 / sr;
      if (this.n1Phase > 1) this.n1Phase -= 1;
      this.bpPhase += (n1 * this.blades) / sr;
      if (this.bpPhase > 1) this.bpPhase -= 1;
      const bp = this.bpPhase;
      let w = sin01(bp) * 0.5 + sin01(bp * 2) * 0.03 + sin01(bp + this.n1Phase) * 0.12 + sin01(bp - this.n1Phase) * 0.12;
      w += sin01(this.n1Phase * 2) * 0.18;
      const nz = this.noise.bi();
      this.roar.run(nz);
      this.rumble.run(nz);
      let y = w * whineG + this.roar.lp * roarG + this.rumble.lp * roarG * 2.2;
      if (!this.cheap) {
        this.intake.run(nz);
        y += this.intake.bp * 0.05 * spool;
        this.ptPhase += ptHz / sr;
        if (this.ptPhase > 1) this.ptPhase -= 1;
        y += sin01(this.ptPhase) * ptG;
      }
      out[off + s] += y * 0.8 * gain;
    }
  }
}

// ───────────────────────────── electric ─────────────────────────────
/** inverter carrier: synchronous PWM ratios step with electrical frequency (the "singing" inverter), async above */
export function inverterCarrierHz(fe: number): number {
  if (fe < 40) return fe * 45;
  if (fe < 80) return fe * 27;
  if (fe < 140) return fe * 15;
  if (fe < 200) return fe * 9;
  return 4500;
}

export class ElectricVoice implements EngineVoice {
  private ePhase = 0;
  private cPhase = 0;
  private gPhase = 0;
  private fan = new Svf();
  private noise: Noise;
  constructor(
    private sr: number,
    seed: number,
    private cheap = false,
  ) {
    this.noise = new Noise(seed ^ 0xe1ec);
    this.fan.set(3500, 0.7, sr);
  }
  render(out: Float32Array, off: number, n: number, f: EngineFrame, t: VoiceTunables, gain: number): void {
    const sr = this.sr;
    const inv = 1 / n;
    const rpmMid = 0.5 * (f.rpmA + f.rpmB);
    const rpmN = clamp(rpmMid / 7600, 0, 1);
    const alive = smoothstep(20, 250, rpmMid);
    const whineG = (0.1 + 0.3 * f.load) * alive;
    // T204: carrier and the 12×/24× partials were within 8 dB of the fundamental at cruise (3.4 / 4.5 / 6.9 kHz)
    const carrierG = this.cheap ? 0 : (0.005 + 0.03 * f.load) * smoothstep(0.005, 0.03, f.thrEff + rpmN);
    const gearG = this.cheap ? 0 : t.gearWhineGain * 2.5 * rpmN * (0.3 + f.load);
    for (let s = 0; s < n; s++) {
      const rpm = f.rpmA + (f.rpmB - f.rpmA) * (s * inv);
      const fe = (Math.max(0, rpm) / 60) * 4; // 4 pole pairs
      this.ePhase += fe / sr;
      if (this.ePhase > 1000) this.ePhase -= 1000;
      const e = this.ePhase;
      let y = (sin01(e * 6) * 0.55 + sin01(e * 12) * 0.08 + sin01(e * 24) * 0.015) * whineG;
      if (carrierG > 0) {
        this.cPhase += inverterCarrierHz(fe) / sr;
        if (this.cPhase > 1000) this.cPhase -= 1000;
        const c = this.cPhase;
        y += (sin01(c) * 0.5 + sin01(c + 2 * e) * 0.25 + sin01(c - 2 * e) * 0.25) * carrierG;
        this.gPhase += ((rpm / 60) * 23) / sr;
        if (this.gPhase > 1) this.gPhase -= 1;
        y += sin01(this.gPhase) * gearG;
        this.fan.run(this.noise.bi());
        y += this.fan.hp * 0.012 * rpmN;
      }
      out[off + s] += y * 0.8 * gain;
    }
  }
}

export function createEngineVoice(kind: 'v8' | 'turbine' | 'twoStroke' | 'electric', sr: number, seed: number, cheap: boolean): EngineVoice {
  switch (kind) {
    case 'turbine':
      return new TurbineVoice(sr, seed, cheap);
    case 'twoStroke':
      return new TwoStrokeVoice(sr, seed, cheap);
    case 'electric':
      return new ElectricVoice(sr, seed, cheap);
    default:
      return new V8Voice(sr, seed, cheap);
  }
}

// ───────────────────────────── water ─────────────────────────────
export interface WaterFrame {
  /** |v|, m/s — gains and cutoffs only */
  speed: number;
  /** wetted fraction 0..1 (0 = airborne) */
  wet: number;
  /** Σ|drive thrust| / rated, 0..1+ */
  thrust: number;
  /** mean prop immersion 0..1 */
  immersion: number;
  /** 0..1 ventilation BEYOND normal surfaced running, mean over drives (`ventilationWeight`) */
  vent: number;
  /** crank rpm of the ventilating drives (vent-weighted) and reduction: the churn sits on blade rate */
  rpm: number;
  gear: number;
  throttle: number;
}

/**
 * One drive's contribution to the ventilation churn, 0..1. T196 surfaced props run at 0.6–0.7 immersion at speed, so
 * that band is NORMAL running and adds (almost) nothing; the churn builds as the prop climbs out of the water (full by
 * 0.15), and a prop in clear air keeps 20 % of it — there is little water left to churn.
 */
export function ventilationWeight(immersion: number): number {
  const s = clamp(immersion, 0, 1);
  return smoothstep(0.7, 0.15, s) * (0.2 + 0.8 * smoothstep(0, 0.08, s));
}

/** churn mix: hollow blade-rate body, lowpassed whoosh (levels set against the engine bed, docs/speedboat/audio.md) */
const HOWL_BODY = 14;
const HOWL_WHOOSH = 8.5;
/** 450R surface-piercing prop (sea-physics MERCURY_450R: five-blade) */
const PROP_BLADES = 5;
/** ventilation churn envelope, s (T205: a 26 ms attack made every surfacing prop a scream onset) */
const VENT_ATTACK_S = 0.2;
const VENT_RELEASE_S = 0.35;
/** churn pitch follows the drive rpm this slowly, so a limiter bounce does not warble it */
const VENT_PITCH_TAU_S = 0.15;

export class WaterLayer {
  private hiss = new Svf();
  private rush = new Svf();
  private spray = new Svf();
  private howl = new Svf();
  private howl2 = new Svf();
  private chop = new OnePole();
  private howlTop = new OnePole();
  private ventEnv = 0;
  private ventRpm = -1;
  private slap1 = new Svf();
  private slap2 = new Svf();
  private splashHp = new Svf();
  private crashLp = new Svf();
  private tailHp = new Svf();
  private noise: Noise;
  private slapEnv = 0;
  private splashEnv = 0;
  private boomEnv = 0;
  private boomHz = 100;
  private boomPhase = 0;
  private crashEnv = 0;
  private tailEnv = 0;
  private howlPhase = 0;
  private pendingKnock = -1;
  private pendingKnockAmp = 0;
  private readonly kSlap: number;
  private readonly kSplash: number;
  private readonly kBoom: number;
  private readonly kBoomHz: number;
  private readonly kCrash: number;
  private readonly kTail: number;
  constructor(
    private sr: number,
    seed: number,
    private cheap = false,
  ) {
    this.noise = new Noise(seed ^ 0x3a7e2);
    this.chop.setHz(2.5, sr);
    this.howlTop.setHz(1600, sr);
    this.rush.set(380, 0.7, sr);
    this.slap1.set(118, 4, sr);
    this.slap2.set(265, 3, sr);
    this.splashHp.set(1300, 0.7, sr);
    this.crashLp.set(520, 0.7, sr);
    this.tailHp.set(2600, 0.7, sr);
    this.kSlap = Math.exp(-1 / (0.006 * sr));
    this.kSplash = Math.exp(-1 / (0.07 * sr));
    this.kBoom = Math.exp(-1 / (0.42 * sr));
    this.kBoomHz = Math.exp(-1 / (0.22 * sr));
    this.kCrash = Math.exp(-1 / (0.22 * sr));
    this.kTail = Math.exp(-1 / (0.95 * sr));
  }
  slam(strength: number): void {
    if (this.cheap || !(strength > 0)) return;
    const s = Math.min(1.5, strength);
    this.slapEnv = Math.max(this.slapEnv, s);
    this.splashEnv = Math.max(this.splashEnv, 0.6 * s);
  }
  landing(strength: number): void {
    if (this.cheap || !(strength > 0)) return;
    const s = Math.min(1.5, strength);
    this.boomEnv = Math.max(this.boomEnv, s);
    this.boomHz = 112;
    this.crashEnv = Math.max(this.crashEnv, s);
    this.tailEnv = Math.max(this.tailEnv, 0.7 * s);
    this.slam(s);
  }
  wakeKnock(strength: number): void {
    if (this.cheap || !(strength > 0)) return;
    this.slam(0.75 * strength);
    this.pendingKnock = Math.round(0.16 * this.sr);
    this.pendingKnockAmp = 0.55 * strength;
  }
  render(out: Float32Array, off: number, n: number, w: WaterFrame, t: VoiceTunables, gain: number): void {
    const sr = this.sr;
    const sN = clamp(w.speed / Math.max(1, t.speedRef), 0, 1.3);
    const wet = clamp(w.wet, 0, 1);
    const hissG = t.hissGain * Math.pow(wet, 0.6) * sN * sN;
    const rushG = t.rushGain * wet * Math.pow(sN, 1.5) * 0.8 + 0.04 * wet;
    const imm = clamp(w.immersion, 0, 1);
    const sprayG = t.sprayGain * clamp(w.thrust, 0, 1.2) * Math.pow(sN, 1.2) * (0.35 + 0.65 * (1 - imm)) * (wet > 0 ? 1 : 0.3);
    this.hiss.set(1000 + 2600 * sN, 0.8, sr); // T204: was 1.1→6.2 kHz, a hiss centre above 5 kHz reads as a sizzle
    this.spray.set(900 + 1400 * sN, 0.55, sr);
    // VENTILATION CHURN (T205). Was two resonant noise bands at 3×/5× blade rate (Q 14/18, peak gain ~50) plus a
    // sine, gated on mean immersion with a 26 ms lag and pitched on engine 0's raw rpm: 600–1500 Hz whistles that
    // warbled with the limiter bounce, level with the engines in NORMAL surfaced running and +6 dB over them with
    // one prop lifted. Now: a hollow low-Q band on blade rate plus a lowpassed whoosh, chopped lightly at blade rate, all
    // under ~1.6 kHz, scaled by ventilation beyond the normal running band, with slow attack/release and pitch.
    const rpmN = clamp(w.rpm / 6800, 0, 1.2);
    const ventTarget = this.cheap ? 0 : t.howlGain * clamp(w.vent, 0, 1) * rpmN * rpmN * smoothstep(0.05, 0.3, w.throttle);
    const tau = ventTarget > this.ventEnv ? VENT_ATTACK_S : VENT_RELEASE_S;
    this.ventEnv += (ventTarget - this.ventEnv) * (1 - Math.exp(-n / (tau * sr)));
    const rpmIn = Math.max(0, w.rpm);
    this.ventRpm = this.ventRpm < 0 ? rpmIn : this.ventRpm + (rpmIn - this.ventRpm) * (1 - Math.exp(-n / (VENT_PITCH_TAU_S * sr)));
    const bladeHz = (this.ventRpm / 60 / Math.max(0.3, w.gear)) * PROP_BLADES;
    const howlG = this.ventEnv;
    if (howlG > 0.0005) {
      this.howl.set(bladeHz, 2.2, sr);
      this.howl2.set(bladeHz * 2.5, 0.7, sr);
    }
    for (let s = 0; s < n; s++) {
      const nz = this.noise.bi();
      const chop = 0.65 + 0.7 * Math.max(0, 0.5 + this.chop.lp(nz * 4));
      let y = 0;
      this.rush.run(nz);
      y += this.rush.lp * rushG * chop;
      if (!this.cheap) {
        this.hiss.run(nz);
        y += this.hiss.bp * hissG * chop;
      }
      this.spray.run(this.noise.bi());
      y += (this.spray.lp * 0.7 + this.spray.bp * 0.6) * sprayG;
      if (howlG > 0.0005) {
        this.howl.run(nz);
        this.howl2.run(this.noise.bi());
        this.howlPhase += bladeHz / sr;
        if (this.howlPhase > 1) this.howlPhase -= 1;
        const chopAm = 1 + 0.25 * sin01(this.howlPhase);
        y += this.howlTop.lp((this.howl.bp * HOWL_BODY + this.howl2.lp * HOWL_WHOOSH) * chopAm) * howlG;
      }
      if (!this.cheap) {
        if (this.pendingKnock >= 0 && this.pendingKnock-- === 0) this.slam(this.pendingKnockAmp);
        if (this.slapEnv > 1e-4 || this.splashEnv > 1e-4) {
          const burst = nz * this.slapEnv;
          this.slap1.run(burst);
          this.slap2.run(burst);
          this.splashHp.run(this.noise.bi());
          y += (this.slap1.bp * 3.2 + this.slap2.bp * 2.2) * t.slapGain + this.splashHp.hp * this.splashEnv * 0.5 * t.slapGain;
          this.slapEnv *= this.kSlap;
          this.splashEnv *= this.kSplash;
        }
        if (this.boomEnv > 1e-4 || this.tailEnv > 1e-4) {
          this.boomHz = 50 + (this.boomHz - 50) * this.kBoomHz;
          this.boomPhase += this.boomHz / sr;
          if (this.boomPhase > 1) this.boomPhase -= 1;
          this.crashLp.run(nz);
          this.tailHp.run(this.noise.bi());
          y += (sin01(this.boomPhase) * this.boomEnv * 0.9 + this.crashLp.lp * this.crashEnv * 1.4 + this.tailHp.hp * this.tailEnv * 0.35) * t.landingGain;
          this.boomEnv *= this.kBoom;
          this.crashEnv *= this.kCrash;
          this.tailEnv *= this.kTail;
        }
      }
      out[off + s] += y * gain;
    }
  }
}
