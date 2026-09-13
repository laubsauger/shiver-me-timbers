/**
 * §T.183 THE BOAT SYNTH CORE — everything the AudioWorklet does, with no worklet globals, so node
 * tests drive the exact same object (offline WAVs, determinism, NaN, schedule).
 *
 * Per render quantum:
 *   for each CONTROL chunk (32 samples ≈ 0.67 ms at 48 k):
 *     every boat: ramp its inputs, step its engines' rpm ODE (rpmModel) → EngineState
 *     every slot: render that boat's engine voices and/or water layer, ramp gain + air absorption
 *
 * PARAMETER SCHEDULE (deterministic, tested): a frame message sets TARGETS; every continuous value
 * then ramps linearly from its current value to the target over RAMP_SECONDS, advancing only at
 * chunk boundaries. So a given (frames, arrival quantum) sequence always renders the same samples,
 * whatever the page's frame rate did.
 */
import { DcBlock, OnePole, clamp, finite } from './dsp';
import {
  BI,
  BOAT_STRIDE,
  DEFAULT_VOICE_TUNABLES,
  LAYER_ENGINE,
  LAYER_WATER,
  MAX_ENGINES,
  REPORT_STRIDE,
  RI,
  SI,
  SLOT_STRIDE,
  governorOf,
  kindOf,
  muffleAmount,
  type VoiceTunables,
} from './protocol';
import { ENGINE_SPECS, createEngineState, stepEngine, type EngineSpec, type EngineState, type VoiceKind } from './engineModel';
import { WaterLayer, createEngineVoice, type EngineFrame, type EngineVoice, type WaterFrame } from './voices';

export const CONTROL_SAMPLES = 32;
const ENGINE_WEIGHT = [1.12, 0.95, 0.8];
/**
 * ≤ one 60 Hz frame, so at ≥ 60 fps every ramp completes before the next target arrives (a longer
 * ramp re-targeted mid-way turns into a geometric approach that never lands on 0). At a higher
 * frame rate a ramp is re-targeted early — still continuous, just approached rather than reached.
 */
export const RAMP_SECONDS = 0.016;
/** a boat missing from frames for this long is dropped */
const BOAT_TIMEOUT_S = 1.0;
/** full ⟷ cheap tier crossfade */
const TIER_FADE_S = 0.08;

/** linear ramp that advances only when told to — the schedule the tests pin */
export class Ramp {
  value: number;
  private step = 0;
  private left = 0;
  constructor(v = 0) {
    this.value = v;
  }
  set(target: number, samples: number): void {
    const t = finite(target, this.value);
    if (samples <= 0) {
      this.value = t;
      this.left = 0;
      return;
    }
    this.step = (t - this.value) / samples;
    this.left = samples;
  }
  /** advance by n samples; returns the value after */
  advance(n: number): number {
    if (this.left <= 0) return this.value;
    const k = Math.min(n, this.left);
    this.value += this.step * k;
    this.left -= k;
    return this.value;
  }
}

class BoatModel {
  kind: VoiceKind;
  spec: EngineSpec;
  engines: EngineState[] = [];
  count = 3;
  throttle = 0;
  governor: 'off' | 'air' | 'full' = 'off';
  readonly advance = [new Ramp(), new Ramp(), new Ramp()];
  readonly immersion = [new Ramp(1), new Ramp(1), new Ramp(1)];
  readonly rpmOverride = [0, 0, 0];
  hasOverride = false;
  readonly speed = new Ramp();
  readonly wet = new Ramp(1);
  readonly thrust = new Ramp();
  /** rpm at the start of the current chunk, per engine */
  readonly rpmA = [0, 0, 0];
  muffle = 1;
  seed: number;
  age = 0;
  slam = 0;
  landing = 0;
  wake = 0;
  constructor(
    readonly id: number,
    kind: VoiceKind,
    seed: number,
  ) {
    this.kind = kind;
    this.spec = ENGINE_SPECS[kind];
    this.seed = seed;
    for (let i = 0; i < MAX_ENGINES; i++) {
      this.engines.push(createEngineState(this.spec));
      // rebuilt engines are not identical: idle settles a few rpm apart — the triple beats
      this.engines[i].rpm = this.spec.idleRpm * (1 + 0.012 * (i - 1));
    }
  }
}

/** per-engine small spec perturbation: prop pitch / idle tune tolerance ⟹ natural detune (beating) */
function detunedSpec(base: EngineSpec, index: number): EngineSpec {
  if (index === 1) return base;
  const d = index === 0 ? -1 : 1;
  return { ...base, calRpm: base.calRpm * (1 + 0.004 * d), idleRpm: base.idleRpm * (1 + 0.015 * d), limitRpm: base.limitRpm + 25 * d };
}

class SlotState {
  boatId = -1;
  kind: VoiceKind | null = null;
  full: EngineVoice[] = [];
  cheap: EngineVoice | null = null;
  water: WaterLayer | null = null;
  readonly gain = new Ramp(0);
  readonly airHz = new Ramp(16000);
  readonly fullMix = new Ramp(1);
  mask = 0;
  private readonly air = new OnePole();
  private readonly dc = new DcBlock();
  private readonly scratch: Float32Array;
  constructor(
    private sr: number,
    readonly index: number,
  ) {
    this.scratch = new Float32Array(CONTROL_SAMPLES);
    this.dc.setHz(15, sr);
  }
  bind(boat: BoatModel | null): void {
    this.boatId = boat ? boat.id : -1;
    this.kind = boat ? boat.kind : null;
    this.full = [];
    this.cheap = null;
    this.water = null;
    if (!boat) return;
    const seed = (boat.seed * 2654435761 + this.index * 97) >>> 0;
    for (let i = 0; i < boat.count; i++) this.full.push(createEngineVoice(boat.kind, this.sr, seed + i * 7919, false));
    this.cheap = createEngineVoice(boat.kind, this.sr, seed + 31337, true);
    this.water = new WaterLayer(this.sr, seed + 4242, false);
  }
  render(out: Float32Array, off: number, n: number, boat: BoatModel, frames: EngineFrame[], waterFrame: WaterFrame, t: VoiceTunables): void {
    const buf = this.scratch;
    buf.fill(0, 0, n);
    const fm = this.fullMix.value;
    if (this.mask & LAYER_ENGINE) {
      const eg = t.engineGain / Math.sqrt(Math.max(1, boat.count));
      // unequal weights: the triple beats, but two engines never fully cancel the third
      if (fm > 0.001) for (let i = 0; i < this.full.length; i++) this.full[i].render(buf, 0, n, frames[i], t, eg * fm * ENGINE_WEIGHT[i]);
      if (fm < 0.999 && this.cheap) this.cheap.render(buf, 0, n, frames[0], t, t.engineGain * 1.1 * (1 - fm));
    }
    if (this.mask & LAYER_WATER && this.water) {
      // cheap tier keeps the water at a lower level; the layer's events are only fed to full slots
      this.water.render(buf, 0, n, waterFrame, t, t.waterGain * (0.6 + 0.4 * fm));
    }
    const g0 = this.gain.value;
    const g1 = this.gain.advance(n);
    this.air.setHz(this.airHz.advance(n), this.sr);
    this.fullMix.advance(n);
    const inv = 1 / n;
    for (let s = 0; s < n; s++) {
      let y = this.dc.run(this.air.lp(buf[s]));
      y *= g0 + (g1 - g0) * (s * inv);
      out[off + s] += Number.isFinite(y) ? y : 0;
    }
  }
}

export interface CoreStats {
  boats: number;
  activeSlots: number;
  nanResets: number;
}

export class BoatSynthCore {
  readonly sr: number;
  readonly slots: SlotState[] = [];
  private boats = new Map<number, BoatModel>();
  private tun: VoiceTunables = { ...DEFAULT_VOICE_TUNABLES };
  private readonly rampSamples: number;
  private readonly tierSamples: number;
  private reportBuf = new Float32Array(REPORT_STRIDE * 16);
  private readonly engineFrames: EngineFrame[][];
  private readonly waterFrame: WaterFrame = { speed: 0, wet: 1, thrust: 0, immersion: 1, rpm: 0, gear: 1, throttle: 0 };
  nanResets = 0;

  constructor(sampleRate: number, slotCount: number) {
    this.sr = sampleRate;
    this.rampSamples = Math.round(RAMP_SECONDS * sampleRate);
    this.tierSamples = Math.round(TIER_FADE_S * sampleRate);
    for (let i = 0; i < slotCount; i++) this.slots.push(new SlotState(sampleRate, i));
    this.engineFrames = [];
    for (let i = 0; i < slotCount; i++) {
      const fr: EngineFrame[] = [];
      for (let e = 0; e < MAX_ENGINES; e++) {
        fr.push({ rpmA: 0, rpmB: 0, load: 0, bark: 0, thrEff: 0, spool: 0, fuelOn: true, overrun: false, overrunTime: 0, limiterActivity: 0, refireCount: 0, muffle: 1, gear: 1 });
      }
      this.engineFrames.push(fr);
    }
  }

  setTunables(t: Partial<VoiceTunables>): void {
    for (const k of Object.keys(DEFAULT_VOICE_TUNABLES) as (keyof VoiceTunables)[]) {
      const v = t[k];
      if (typeof v === 'number' && Number.isFinite(v)) this.tun[k] = v;
    }
  }

  tunables(): Readonly<VoiceTunables> {
    return this.tun;
  }

  /** apply one packed frame (boats: nBoats × BOAT_STRIDE, slots: slotCount × SLOT_STRIDE) */
  applyFrame(boats: Float32Array, nBoats: number, slots: Float32Array): void {
    const R = this.rampSamples;
    for (let b = 0; b < nBoats; b++) {
      const o = b * BOAT_STRIDE;
      const id = Math.round(finite(boats[o + BI.ID], -1));
      if (id < 0) continue;
      const kind = kindOf(boats[o + BI.KIND]);
      let m = this.boats.get(id);
      if (!m || m.kind !== kind) {
        m = new BoatModel(id, kind, Math.round(finite(boats[o + BI.SEED], id)) >>> 0);
        this.boats.set(id, m);
      }
      m.age = 0;
      m.count = clamp(Math.round(finite(boats[o + BI.ENGINES], 3)), 1, MAX_ENGINES);
      m.throttle = clamp(finite(boats[o + BI.THROTTLE]), -1, 1);
      m.governor = governorOf(boats[o + BI.GOVERNOR]);
      m.hasOverride = boats[o + BI.HAS_OVERRIDE] > 0.5;
      for (let e = 0; e < MAX_ENGINES; e++) {
        m.advance[e].set(clamp(finite(boats[o + BI.ADVANCE + e]), 0, 80), R);
        m.immersion[e].set(clamp(finite(boats[o + BI.IMMERSION + e], 1), 0, 1), R);
        m.rpmOverride[e] = clamp(finite(boats[o + BI.RPM_OVERRIDE + e]), 0, 20000);
      }
      m.speed.set(clamp(finite(boats[o + BI.SPEED]), 0, 120), R);
      m.wet.set(clamp(finite(boats[o + BI.WET], 1), 0, 1), R);
      m.thrust.set(clamp(finite(boats[o + BI.THRUST]), 0, 2), R);
      m.slam = Math.max(m.slam, clamp(finite(boats[o + BI.SLAM]), 0, 2));
      m.landing = Math.max(m.landing, clamp(finite(boats[o + BI.LANDING]), 0, 2));
      m.wake = Math.max(m.wake, clamp(finite(boats[o + BI.WAKE]), 0, 2));
    }
    for (let i = 0; i < this.slots.length; i++) {
      const o = i * SLOT_STRIDE;
      const slot = this.slots[i];
      const id = Math.round(finite(slots[o + SI.BOAT], -1));
      const boat = id >= 0 ? (this.boats.get(id) ?? null) : null;
      if (slot.boatId !== (boat ? boat.id : -1) || (boat && slot.kind !== boat.kind) || (boat && slot.full.length !== boat.count)) {
        slot.bind(boat);
        slot.gain.set(0, 0);
      }
      slot.mask = Math.round(finite(slots[o + SI.MASK]));
      slot.gain.set(boat ? clamp(finite(slots[o + SI.GAIN]), 0, 16) : 0, R);
      slot.airHz.set(clamp(finite(slots[o + SI.AIR_HZ], 16000), 200, 20000), R);
      slot.fullMix.set(slots[o + SI.FULL] > 0.5 ? 1 : 0, this.tierSamples);
    }
  }

  /** render n samples into one mono buffer per slot (ADDS; callers pass zeroed buffers) */
  process(outputs: (Float32Array | undefined)[], n: number): void {
    const sr = this.sr;
    const t = this.tun;
    for (let off = 0; off < n; off += CONTROL_SAMPLES) {
      const m = Math.min(CONTROL_SAMPLES, n - off);
      const dt = m / sr;
      // ---- boats: one rpm integration per boat, whatever the number of slots listening to it
      for (const boat of this.boats.values()) {
        boat.age += dt;
        let immSum = 0;
        let advSum = 0;
        let loadSum = 0;
        for (let e = 0; e < boat.count; e++) {
          const st = boat.engines[e];
          boat.rpmA[e] = st.rpm;
          const adv = boat.advance[e].advance(m);
          const imm = boat.immersion[e].advance(m);
          immSum += imm;
          advSum += adv;
          stepEngine(st, e === 1 ? boat.spec : this.detuned(boat, e), {
            throttle: boat.throttle,
            advance: adv,
            immersion: imm,
            governor: boat.governor,
            rpmOverride: boat.hasOverride ? boat.rpmOverride[e] : undefined,
          }, dt);
          if (!Number.isFinite(st.rpm)) {
            boat.engines[e] = createEngineState(boat.spec);
            this.nanResets++;
          }
          loadSum += st.load;
        }
        boat.speed.advance(m);
        boat.wet.advance(m);
        boat.thrust.advance(m);
        const k = boat.count;
        boat.muffle = boat.kind === 'turbine' || boat.kind === 'electric' ? 0 : muffleAmount(immSum / k, advSum / k, loadSum / k, t);
      }
      // ---- slots
      for (let i = 0; i < this.slots.length; i++) {
        const slot = this.slots[i];
        const out = outputs[i];
        const boat = slot.boatId >= 0 ? this.boats.get(slot.boatId) : undefined;
        if (!out || !boat) {
          slot.gain.advance(m);
          continue;
        }
        // events land once, on the slot that carries this boat's water layer
        if (slot.mask & LAYER_WATER && slot.water && slot.fullMix.value > 0.5) {
          if (boat.slam > 0) slot.water.slam(boat.slam);
          if (boat.landing > 0) slot.water.landing(boat.landing);
          if (boat.wake > 0) slot.water.wakeKnock(boat.wake);
        }
        const frames = this.engineFrames[i];
        for (let e = 0; e < boat.count; e++) {
          const st = boat.engines[e];
          const f = frames[e];
          f.rpmA = boat.rpmA[e];
          f.rpmB = st.rpm;
          f.load = st.load;
          f.bark = st.bark;
          f.thrEff = st.thrEff;
          f.spool = st.spool;
          f.fuelOn = !st.limiterCut && !st.overrun;
          f.overrun = st.overrun;
          f.overrunTime = st.overrunTime;
          f.limiterActivity = st.limiterActivity;
          f.refireCount = st.refireCount;
          f.muffle = boat.muffle;
          f.gear = boat.spec.gear;
        }
        const w = this.waterFrame;
        w.speed = boat.speed.value;
        w.wet = boat.wet.value;
        w.thrust = boat.thrust.value;
        let imm = 0;
        for (let e = 0; e < boat.count; e++) imm += boat.immersion[e].value;
        w.immersion = imm / boat.count;
        w.rpm = boat.engines[0].rpm;
        w.gear = boat.spec.gear;
        w.throttle = Math.abs(boat.throttle);
        slot.render(out, off, m, boat, frames, w, t);
      }
      // events are consumed by the first chunk after their frame
      for (const boat of this.boats.values()) {
        boat.slam = 0;
        boat.landing = 0;
        boat.wake = 0;
      }
    }
    for (const [id, boat] of this.boats) {
      if (boat.age > BOAT_TIMEOUT_S) this.boats.delete(id);
    }
  }

  private detunedCache = new Map<string, EngineSpec>();
  private detuned(boat: BoatModel, e: number): EngineSpec {
    const key = `${boat.kind}:${e}`;
    let s = this.detunedCache.get(key);
    if (!s) {
      s = detunedSpec(boat.spec, e);
      this.detunedCache.set(key, s);
    }
    return s;
  }

  /** per-boat rpm/cut/overrun/load report (worklet posts it back ~15 Hz) */
  report(): { data: Float32Array; count: number } {
    const need = this.boats.size * REPORT_STRIDE;
    if (this.reportBuf.length < need) this.reportBuf = new Float32Array(need * 2);
    let b = 0;
    for (const boat of this.boats.values()) {
      const o = b * REPORT_STRIDE;
      this.reportBuf[o + RI.ID] = boat.id;
      for (let e = 0; e < MAX_ENGINES; e++) {
        const st = boat.engines[e];
        const on = e < boat.count;
        this.reportBuf[o + RI.RPM + e] = on ? st.rpm : 0;
        this.reportBuf[o + RI.CUT + e] = on && st.limiterCut ? 1 : 0;
        this.reportBuf[o + RI.OVERRUN + e] = on && st.overrun ? 1 : 0;
        this.reportBuf[o + RI.LOAD + e] = on ? st.load : 0;
      }
      b++;
    }
    return { data: this.reportBuf, count: b };
  }

  stats(): CoreStats {
    let active = 0;
    for (const s of this.slots) if (s.boatId >= 0) active++;
    return { boats: this.boats.size, activeSlots: active, nanResets: this.nanResets };
  }
}
