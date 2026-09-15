/**
 * T212 SPEEDBOAT AMBIENCE, sample-rate DSP (the worklet's stereo ambience output → the engine's ambience bus).
 * Procedural, seeded, no assets. Levels are set against the engine bed (docs/speedboat/audio.md "Ambience").
 *
 *   WIND        noise ─► resonant lowpass (cutoff and level rise with airspeed at the listener) ─► L/R, partly decorrelated
 *               + a low buffet (lowpassed noise) near the hull; slow gusts from the weather wind move level and cutoff
 *   HULL BED    low speed: lapping grains (band-passed noise, 180–650 Hz, soft attack, 60–220 ms decay) + a slow slosh,
 *               both driven by sea state and hull heave; crossfades at speed to a passing-water hiss/rush along the hull
 *   SEA WASH    distant wash: lowpassed noise breathing on two incommensurate wave periods, a faint break hiss on the crests;
 *               energy from the sea state, quieter at night
 *   FAR LIFE    near course furniture only (LANDMARK): an occasional far gull call (day) and a bell buoy rocked by the sea
 *
 * Nothing here is pitched by a speed (V112): speed and airspeed reach gains and filter cutoffs only; the gull and bell
 * pitches are drawn from the seeded noise.
 */
import { Noise, OnePole, Svf, clamp, sin01, smoothstep } from './dsp';
import type { VoiceTunables } from './protocol';

export interface AmbienceFrame {
  on: number;
  air: number;
  wind: number;
  near: number;
  speed: number;
  wet: number;
  heave: number;
  sea: number;
  night: number;
  landmark: number;
}

/** control-rate gain smoothing, s */
const GAIN_TAU_S = 0.08;
/** airspeed that reads as full rush (≈ 80 kn), m/s */
const AIR_REF = 41;
const LAP_GRAINS = 3;
/** bell buoy partials (a small cast bell: ratios, levels, decays in s) */
const BELL_RATIO = [1, 2.0, 2.41, 3.0, 4.18] as const;
const BELL_AMP = [0.6, 0.35, 0.3, 0.2, 0.12] as const;
const BELL_DECAY_S = [2.2, 1.4, 1.0, 0.7, 0.45] as const;
/** absolute levels against the engine bed (measured in tests/boatAudioSynth T212 renders) */
const WIND_LEVEL = 0.28;
const BUFFET_LEVEL = 1.6;
const LAP_LEVEL = 0.22;
const SLOSH_LEVEL = 0.05;
const PASS_LEVEL = 0.1;
const WASH_LEVEL = 0.2;
const GULL_LEVEL = 0.006;
const BELL_LEVEL = 0.007;

class LapGrain {
  readonly bp = new Svf();
  env = 0;
  target = 0;
  kAtt = 0;
  kDec = 0;
  attacking = false;
  panL = 0.7;
  panR = 0.7;
}

export class AmbienceVoice {
  private readonly sr: number;
  private readonly noise: Noise;
  private readonly noiseL: Noise;
  private readonly noiseR: Noise;
  // wind
  private readonly windL = new Svf();
  private readonly windR = new Svf();
  private readonly buffet = new Svf();
  private windG = 0;
  private buffetG = 0;
  private gust = 0;
  private gustTarget = 0;
  private gustTimer = 0;
  // hull bed
  private readonly grains: LapGrain[] = [];
  private nextGrain = 0;
  private readonly slosh = new Svf();
  private sloshAm = 0;
  private readonly passHissL = new Svf();
  private readonly passHissR = new Svf();
  private readonly passRush = new Svf();
  private lapG = 0;
  private sloshG = 0;
  private passG = 0;
  // sea wash
  private readonly washL = new Svf();
  private readonly washR = new Svf();
  private readonly breakBp = new Svf();
  private washG = 0;
  private wavePhaseA: number;
  private wavePhaseB: number;
  // gull
  private readonly gullLp = new OnePole();
  private readonly gullRasp = new OnePole();
  private gullTimer: number;
  private gullSyllables = 0;
  private gullGap = 0;
  private gullAge = -1;
  private gullDur = 0.2;
  private gullHz = 1800;
  private gullPhase = 0;
  private gullPanL = 0.7;
  private gullPanR = 0.7;
  private gullLevel = 1;
  // bell buoy
  private readonly bellPhase = new Float64Array(BELL_RATIO.length);
  private readonly bellEnv = new Float64Array(BELL_RATIO.length);
  private readonly bellK: Float64Array;
  private readonly bellHz: number;
  private bellTimer: number;
  private bellEcho = -1;
  private bellG = 0;
  private landmarkG = 0;
  private dayG = 1;

  constructor(sr: number, seed: number) {
    this.sr = sr;
    this.noise = new Noise(seed ^ 0xa3b1e7);
    this.noiseL = new Noise(seed ^ 0x1eef);
    this.noiseR = new Noise(seed ^ 0x719e7);
    this.buffet.set(75, 0.8, sr);
    this.slosh.set(320, 0.7, sr);
    this.passRush.set(650, 0.7, sr);
    this.breakBp.set(1400, 0.8, sr);
    this.gullLp.setHz(3200, sr);
    this.gullRasp.setHz(90, sr);
    for (let i = 0; i < LAP_GRAINS; i++) this.grains.push(new LapGrain());
    this.wavePhaseA = this.noise.next();
    this.wavePhaseB = this.noise.next();
    this.gullTimer = 3 + 6 * this.noise.next();
    this.bellTimer = 2 + 4 * this.noise.next();
    this.bellHz = 610 * (1 + 0.04 * this.noise.bi());
    this.bellK = new Float64Array(BELL_DECAY_S.map((d) => Math.exp(-1 / (d * sr))));
  }

  /** true while any layer can still be heard (the core skips the render otherwise) */
  audible(): boolean {
    return this.windG + this.lapG + this.sloshG + this.passG + this.washG + this.bellG > 1e-6 || this.gullAge >= 0 || this.gullSyllables > 0;
  }

  /** ADDS n samples into outL/outR (outR absent ⟹ a mono fold into outL) */
  render(outL: Float32Array, outR: Float32Array | undefined, off: number, n: number, a: AmbienceFrame, t: VoiceTunables): void {
    const sr = this.sr;
    const dt = n / sr;
    const k = 1 - Math.exp(-dt / GAIN_TAU_S);
    const on = clamp(a.on, 0, 1);
    const near = clamp(a.near, 0, 1);
    const wet = clamp(a.wet, 0, 1);
    const sea = clamp(a.sea, 0, 1);
    const night = clamp(a.night, 0, 1);
    const speed = Math.max(0, a.speed);

    // ── gusts: a new random target every 1.5–4 s, glided (weather wind sets the depth)
    this.gustTimer -= dt;
    if (this.gustTimer <= 0) {
      this.gustTimer = 1.5 + 2.5 * this.noise.next();
      this.gustTarget = this.noise.bi();
    }
    this.gust += (this.gustTarget - this.gust) * (1 - Math.exp(-dt / 0.9));
    const gustDepth = clamp(a.wind / 14, 0, 0.55);
    const air = Math.max(0, a.air) + Math.max(0, a.wind) * 0.3 * this.gust;
    const airN = clamp(air / AIR_REF, 0, 1.4);

    // ── targets
    const windT = on * t.windGain * WIND_LEVEL * airN * airN * (1 + gustDepth * this.gust) * Math.pow(near, 1.5);
    const buffetT = windT * BUFFET_LEVEL * near * near;
    const slow = 1 - smoothstep(2, 9, speed);
    const heaveN = clamp(a.heave / 1.2, 0, 1);
    const nearHull = Math.pow(near, 1.3);
    const lapT = on * t.lapGain * LAP_LEVEL * (0.4 + 0.6 * sea + 0.5 * heaveN) * slow * wet * nearHull;
    const sloshT = on * t.lapGain * SLOSH_LEVEL * (0.3 + 0.7 * sea + 0.4 * heaveN) * slow * wet * nearHull;
    const passT = on * t.passGain * PASS_LEVEL * smoothstep(3, 32, speed) * wet * nearHull;
    const washT = on * t.washGain * WASH_LEVEL * (0.14 + 0.55 * sea + 0.08 * clamp(a.wind / 12, 0, 1)) * (1 - 0.45 * night);
    const landT = on * clamp(a.landmark, 0, 1);
    const dayT = 1 - night;

    const w0 = this.windG;
    const b0 = this.buffetG;
    const p0 = this.passG;
    const s0 = this.washG;
    this.windG += (windT - this.windG) * k;
    this.buffetG += (buffetT - this.buffetG) * k;
    this.lapG += (lapT - this.lapG) * k;
    this.sloshG += (sloshT - this.sloshG) * k;
    this.passG += (passT - this.passG) * k;
    this.washG += (washT - this.washG) * k;
    this.landmarkG += (landT - this.landmarkG) * k;
    this.dayG += (dayT - this.dayG) * k;
    this.bellG = this.landmarkG * t.birdGain;

    // ── per-chunk filter settings
    const windHz = 170 + 1800 * Math.min(1.2, airN) * (1 + 0.12 * gustDepth * this.gust);
    this.windL.set(windHz, 1.15, sr);
    this.windR.set(windHz * 1.07, 1.15, sr);
    const passHz = 1700 + 1300 * smoothstep(5, 40, speed);
    this.passHissL.set(passHz, 0.7, sr);
    this.passHissR.set(passHz * 1.05, 0.7, sr);
    const washHz = 380 + 520 * sea;
    this.washL.set(washHz, 0.7, sr);
    this.washR.set(washHz * 0.92, 0.7, sr);
    this.wavePhaseA += dt / (9.5 - 2.5 * sea);
    this.wavePhaseB += dt / (6.3 - 1.5 * sea);
    if (this.wavePhaseA > 1) this.wavePhaseA -= 1;
    if (this.wavePhaseB > 1) this.wavePhaseB -= 1;
    const wave = 0.6 * sin01(this.wavePhaseA) + 0.4 * sin01(this.wavePhaseB);
    const waveAm = 0.55 + 0.45 * wave;
    const breakG = Math.max(0, wave - 0.45) * (0.2 + 0.8 * sea);
    // the slosh breathes on the same swell, a little ahead
    this.sloshAm = 0.45 + 0.55 * Math.max(0, 0.6 * sin01(this.wavePhaseA + 0.12) + 0.4 * sin01(this.wavePhaseB + 0.3));

    // ── lapping grains: Poisson onsets, round-robin over three band-pass voices
    const lapRate = (0.9 + 3.2 * sea + 2.5 * heaveN) / sr;
    const lapOn = this.lapG > 1e-6;

    // ── gull calls (day, near furniture) and the bell buoy
    this.stepGull(dt, t);
    this.stepBell(dt, sea);

    const inv = 1 / n;
    const dw = (this.windG - w0) * inv;
    const db = (this.buffetG - b0) * inv;
    const dp = (this.passG - p0) * inv;
    const ds = (this.washG - s0) * inv;
    const windOn = this.windG > 1e-6 || w0 > 1e-6;
    const passOn = this.passG > 1e-6 || p0 > 1e-6;
    const washOn = this.washG > 1e-6 || s0 > 1e-6;
    const gullOn = this.gullAge >= 0;
    const bellOn = this.bellG > 1e-6 && this.bellEnv[0] > 1e-5;
    const gullLevel = GULL_LEVEL * t.birdGain * this.landmarkG * this.dayG * this.gullLevel;
    const bellLevel = BELL_LEVEL * this.bellG;

    for (let s = 0; s < n; s++) {
      const nc = this.noise.bi();
      const nl = this.noiseL.bi();
      const nr = this.noiseR.bi();
      let yl = 0;
      let yr = 0;
      if (windOn) {
        const g = w0 + dw * s;
        this.windL.run(0.72 * nl + 0.28 * nc);
        this.windR.run(0.72 * nr + 0.28 * nc);
        this.buffet.run(nc);
        const bf = this.buffet.lp * (b0 + db * s);
        yl += this.windL.lp * g + bf;
        yr += this.windR.lp * g + bf;
      }
      if (lapOn) {
        if (this.noise.next() < lapRate) this.trigger();
        let gl = 0;
        let gr = 0;
        for (let i = 0; i < LAP_GRAINS; i++) {
          const gr0 = this.grains[i];
          if (gr0.env < 1e-5 && !gr0.attacking) continue;
          if (gr0.attacking) {
            gr0.env += (gr0.target - gr0.env) * gr0.kAtt;
            if (gr0.env > 0.92 * gr0.target) gr0.attacking = false;
          } else gr0.env *= gr0.kDec;
          gr0.bp.run((i & 1 ? nl : nr) * gr0.env);
          gl += gr0.bp.bp * gr0.panL;
          gr += gr0.bp.bp * gr0.panR;
        }
        this.slosh.run(nc);
        const sl = this.slosh.lp * this.sloshG * this.sloshAm;
        yl += gl * this.lapG + sl;
        yr += gr * this.lapG + sl;
      }
      if (passOn) {
        const g = p0 + dp * s;
        this.passHissL.run(nl);
        this.passHissR.run(nr);
        this.passRush.run(nc);
        const rush = this.passRush.lp * 0.9;
        yl += (this.passHissL.bp * 0.8 + rush) * g;
        yr += (this.passHissR.bp * 0.8 + rush) * g;
      }
      if (washOn) {
        const g = (s0 + ds * s) * waveAm;
        this.washL.run(nl);
        this.washR.run(nr);
        this.breakBp.run(nc);
        const br = this.breakBp.bp * breakG * 0.35;
        yl += (this.washL.lp + br) * g;
        yr += (this.washR.lp + br) * g;
      }
      if (gullOn) {
        const y = this.gullSample() * gullLevel;
        yl += y * this.gullPanL;
        yr += y * this.gullPanR;
      }
      if (bellOn) {
        const y = this.bellSample() * bellLevel;
        yl += y * 0.8;
        yr += y * 0.6;
      }
      if (outR) {
        outL[off + s] += Number.isFinite(yl) ? yl : 0;
        outR[off + s] += Number.isFinite(yr) ? yr : 0;
      } else {
        const y = 0.5 * (yl + yr);
        outL[off + s] += Number.isFinite(y) ? y : 0;
      }
    }
  }

  private trigger(): void {
    const g = this.grains[this.nextGrain];
    this.nextGrain = (this.nextGrain + 1) % LAP_GRAINS;
    const sr = this.sr;
    g.bp.set(180 + 470 * this.noise.next() * this.noise.next(), 1.3, sr);
    g.target = 0.35 + 0.65 * this.noise.next();
    g.kAtt = 1 - Math.exp(-1 / ((0.008 + 0.012 * this.noise.next()) * sr));
    g.kDec = Math.exp(-1 / ((0.06 + 0.16 * this.noise.next()) * sr));
    g.attacking = true;
    const pan = this.noise.next();
    g.panL = Math.cos(pan * Math.PI * 0.5);
    g.panR = Math.sin(pan * Math.PI * 0.5);
  }

  private stepGull(dt: number, t: VoiceTunables): void {
    const allowed = this.landmarkG > 0.05 && this.dayG > 0.5 && t.birdGain > 0;
    if (this.gullSyllables > 0 && this.gullAge < 0) {
      this.gullGap -= dt;
      if (this.gullGap <= 0) this.startSyllable();
      return;
    }
    if (this.gullAge >= 0) return;
    this.gullTimer -= dt;
    if (this.gullTimer > 0) return;
    // next call: 6–22 s apart at a landmark, rarer at its edge
    this.gullTimer = (6 + 16 * this.noise.next()) / Math.max(0.25, this.landmarkG);
    if (!allowed) return;
    this.gullSyllables = 1 + Math.floor(3 * this.noise.next());
    const pan = 0.15 + 0.7 * this.noise.next();
    this.gullPanL = Math.cos(pan * Math.PI * 0.5);
    this.gullPanR = Math.sin(pan * Math.PI * 0.5);
    this.gullLevel = 0.4 + 0.6 * this.noise.next();
    this.startSyllable();
  }

  private startSyllable(): void {
    this.gullSyllables--;
    this.gullAge = 0;
    this.gullDur = 0.16 + 0.14 * this.noise.next();
    this.gullHz = 1500 + 600 * this.noise.next();
    this.gullGap = 0.1 + 0.15 * this.noise.next();
  }

  /** one sample of a "kyow": a falling, slightly rasped harmonic call under a far-air lowpass */
  private gullSample(): number {
    if (this.gullAge < 0) return this.gullLp.lp(0);
    const u = this.gullAge / this.gullDur;
    if (u >= 1) {
      this.gullAge = -1;
      return this.gullLp.lp(0);
    }
    this.gullAge += 1 / this.sr;
    const hz = this.gullHz * (1.22 - 0.42 * u * u);
    this.gullPhase += hz / this.sr;
    if (this.gullPhase > 1) this.gullPhase -= 1;
    const p = this.gullPhase;
    const env = Math.min(1, u * 9) * (1 - u) * (1 - u);
    const rasp = 1 + 0.6 * this.gullRasp.lp(this.noise.bi() * 12);
    const y = (sin01(p) + 0.45 * sin01(2 * p) + 0.22 * sin01(3 * p)) * env * rasp;
    return this.gullLp.lp(y);
  }

  private stepBell(dt: number, sea: number): void {
    if (this.bellEcho >= 0) {
      this.bellEcho -= dt;
      if (this.bellEcho < 0) this.strike(0.55);
    }
    this.bellTimer -= dt;
    if (this.bellTimer > 0) return;
    // the buoy rocks on the swell: more often in a working sea, sometimes a double clang
    this.bellTimer = (3.5 + 6 * this.noise.next()) / (0.5 + sea);
    if (this.bellG < 0.03) return;
    this.strike(0.6 + 0.4 * this.noise.next());
    if (this.noise.next() < 0.35) this.bellEcho = 0.35 + 0.3 * this.noise.next();
  }

  private strike(v: number): void {
    for (let i = 0; i < BELL_RATIO.length; i++) this.bellEnv[i] = Math.max(this.bellEnv[i], v * BELL_AMP[i]);
  }

  private bellSample(): number {
    let y = 0;
    for (let i = 0; i < BELL_RATIO.length; i++) {
      this.bellPhase[i] += (this.bellHz * BELL_RATIO[i]) / this.sr;
      if (this.bellPhase[i] > 1) this.bellPhase[i] -= 1;
      y += sin01(this.bellPhase[i]) * this.bellEnv[i];
      this.bellEnv[i] *= this.bellK[i];
    }
    return y;
  }
}
