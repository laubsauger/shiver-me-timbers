/**
 * Surge boost meter, EARNED ONLY (§T.184, design doc §3). Pure, per racer, keyed to sim time.
 *
 * Earned by (each +`amount` segments, capped at `maxSegments`):
 *  - cleanLanding: an airborne spell ≥ `minAirSeconds` whose touchdown attitude is inside the
 *    clean window (pitch −2…+7°, |roll| < 10°) and whose slam over the landing window stays
 *    ≤ `cleanSlamMax`, with no crash in that window;
 *  - wakeJump: an airborne spell launched off another boat's wake that lands without a crash
 *    (one jump earns once: a clean wake jump is a wake jump, not both);
 *  - cleanSector: an EXPOSED gate-to-gate sector (from crossing an exposed gate to crossing
 *    the next gate) with no crash, no penalty and no hard landing.
 * No pickups, no passive recharge, no catch-up, no overheat. Firing takes one whole segment
 * and gives `thrustMultiplier` for `boostSeconds`; it does not stack.
 */
import type { RacerSensors } from './sensors';

export interface SurgeParams {
  maxSegments: number;
  cleanLandingAmount: number;
  wakeJumpAmount: number;
  cleanSectorAmount: number;
  minAirSeconds: number;
  cleanPitchMin: number;
  cleanPitchMax: number;
  cleanRollMax: number;
  /** g; slam above this in the landing window is not clean */
  cleanSlamMax: number;
  /** g; slam above this is a hard landing and voids the open sector */
  hardSlam: number;
  /** seconds after touchdown the slam/crash is watched before a landing is judged */
  landingWindowSeconds: number;
  boostSeconds: number;
  /** drive thrust multiplier while boosting (~(90/80)² for 80 → 90 kn against v² drag) */
  thrustMultiplier: number;
}

export type SurgeReason = 'cleanLanding' | 'wakeJump' | 'cleanSector';

export interface SurgeAward {
  reason: SurgeReason;
  amount: number;
}

type SurgeInputs = Pick<RacerSensors, 'airborne' | 'slam' | 'pitch' | 'roll' | 'crashed' | 'launchedFromWake' | 'surgePressed'>;

const EPS = 1e-9;

export class SurgeMeter {
  segments = 0;
  boostRemaining = 0;

  private wasAirborne = false;
  private takeoffTime = 0;
  private wakeLaunch = false;
  /** pending landing judgement */
  private landing: null | { until: number; airTime: number; attitudeClean: boolean; slamMax: number; wake: boolean } =
    null;
  private sectorOpen = false;
  private sectorClean = false;
  private wasPressed = false;

  constructor(private readonly params: SurgeParams) {}

  get boosting(): boolean {
    return this.boostRemaining > 0;
  }

  get thrustMultiplier(): number {
    return this.boosting ? this.params.thrustMultiplier : 1;
  }

  /**
   * One sim tick ending at time `t`. `earning` = the racer is in the race and may earn/fire
   * (racing phase, not finished). Returns awards earned and whether Surge fired this tick.
   */
  step(s: SurgeInputs, t: number, dt: number, earning: boolean): { awards: SurgeAward[]; fired: boolean } {
    const p = this.params;
    const awards: SurgeAward[] = [];
    this.boostRemaining -= dt;
    if (this.boostRemaining < EPS) this.boostRemaining = 0; // no float residue past the last tick

    if (s.crashed) {
      this.voidSector();
      this.landing = null;
      this.wakeLaunch = false;
      this.boostRemaining = 0;
    }
    if (s.slam > p.hardSlam) this.voidSector();

    // airborne spells
    if (s.airborne) {
      if (!this.wasAirborne) {
        this.takeoffTime = t;
        this.wakeLaunch = false;
        this.landing = null;
      }
      if (s.launchedFromWake) this.wakeLaunch = true;
    } else if (this.wasAirborne && !s.crashed) {
      const deg = Math.PI / 180;
      this.landing = {
        until: t + p.landingWindowSeconds,
        airTime: t - this.takeoffTime,
        attitudeClean:
          s.pitch >= p.cleanPitchMin * deg && s.pitch <= p.cleanPitchMax * deg && Math.abs(s.roll) < p.cleanRollMax * deg,
        slamMax: 0,
        wake: this.wakeLaunch,
      };
    }
    this.wasAirborne = s.airborne;

    if (this.landing && !s.airborne) {
      this.landing.slamMax = Math.max(this.landing.slamMax, s.slam);
      if (t >= this.landing.until - EPS) {
        const l = this.landing;
        this.landing = null;
        if (earning) {
          if (l.wake) awards.push(this.award('wakeJump', p.wakeJumpAmount));
          else if (l.airTime >= p.minAirSeconds - EPS && l.attitudeClean && l.slamMax <= p.cleanSlamMax) {
            awards.push(this.award('cleanLanding', p.cleanLandingAmount));
          }
        }
      }
    }

    let fired = false;
    const pressedEdge = s.surgePressed && !this.wasPressed;
    this.wasPressed = s.surgePressed;
    if (pressedEdge && earning && !s.crashed && !this.boosting && this.segments >= 1 - EPS) {
      this.segments = Math.max(0, this.segments - 1);
      if (this.segments < EPS) this.segments = 0;
      this.boostRemaining = p.boostSeconds;
      fired = true;
    }
    if (!earning) this.boostRemaining = 0;
    return { awards: awards.filter((a) => a.amount > 0), fired };
  }

  /** the racer crossed a gate (not a mark): closes the open sector, opens the next if exposed */
  passGate(sector: 'exposed' | 'sheltered', earning: boolean): SurgeAward | null {
    let award: SurgeAward | null = null;
    if (this.sectorOpen && this.sectorClean && earning) {
      award = this.award('cleanSector', this.params.cleanSectorAmount);
      if (award.amount <= 0) award = null;
    }
    this.sectorOpen = sector === 'exposed';
    this.sectorClean = true;
    return award;
  }

  /** crash, penalty, hard landing or respawn: the open sector cannot pay out */
  voidSector(): void {
    this.sectorClean = false;
  }

  private award(reason: SurgeReason, amount: number): SurgeAward {
    const before = this.segments;
    this.segments = Math.min(this.params.maxSegments, this.segments + amount);
    if (this.params.maxSegments - this.segments < EPS) this.segments = this.params.maxSegments;
    return { reason, amount: this.segments - before };
  }
}
