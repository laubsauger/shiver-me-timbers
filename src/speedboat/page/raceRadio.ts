/**
 * RACE CONTROL ON CHANNEL 16 (§T.185 radio strip + toasts, fed by §T.184 race events and §T.188 crash events).
 * Pure: events in, one current radio line + one current toast out, ids bumped per new line (the HUD rebuilds its
 * strip on an id change). No DOM, no clock — `step(dt)` ages the line in the caller's real seconds.
 *
 * WHY A QUEUE WITH PRIORITIES: one tick can carry the fifth lamp, green and three position swaps. Showing only the
 * last event hides "Green" behind "Up to P7"; showing each for a frame shows nothing. So calls queue, a call stays
 * up at least RADIO_HOLD_S, and a MORE urgent call (lamps, green, your crash) cuts in at once. Lamp counts and
 * position calls coalesce: a newer one replaces a queued or showing one of its kind (only the newest count or place
 * is worth saying; lamps are 1 s apart, shorter than the hold).
 *
 * Toasts (missed gate, jump start, wrong way, Surge earned, best lap) are momentary and the newest wins at once.
 */
import type { RaceEvent } from '../../race/events';
import type { SurgeReason } from '../../race/surge';
import type { CrashEvent } from '../crash/machine';

/** a line stays on the strip at least this long before a queued call of the same or lower priority replaces it */
export const RADIO_HOLD_S = 1.6;

export const PRIORITY = { rival: 0, position: 1, lap: 2, start: 3, count: 4, urgent: 5 } as const;

const COUNT = ['Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine'];
const SURGE_LABEL: Record<SurgeReason, string> = { cleanLanding: 'Clean landing', wakeJump: 'Wake jump', cleanSector: 'Clean sector' };
const ALL = 'ALL STATIONS';

export interface RaceRadioOptions {
  playerId: number;
  laps: number;
  /** boat name for a racer ("Crosswind"); the player's is not used */
  name(racerId: number): string;
  /** race number painted on the player's hull, for race control's call sign */
  playerNumber(): number;
  /** the racer's current place, when the caller knows it (finish call) */
  position?(racerId: number): number;
}

interface Call {
  text: string;
  to: string;
  priority: number;
  kind: 'position' | 'count' | 'other';
}

export class RaceRadio {
  radioId = 0;
  radioText = '';
  radioTo = '';
  toastId = 0;
  toastTitle = '';
  toastDetail = '';
  private current: Call | null = null;
  private age = 0;
  private readonly queue: Call[] = [];
  private phase: string = 'prestart';
  private winnerCalled = false;
  private leaderFinalCalled = false;

  constructor(private readonly o: RaceRadioOptions) {}

  /** forget the race (restart): nothing on the strip, ids keep counting so the HUD sees the change */
  reset(): void {
    this.queue.length = 0;
    this.current = null;
    this.age = 0;
    this.phase = 'prestart';
    this.winnerCalled = false;
    this.leaderFinalCalled = false;
    this.show({ text: '', to: '', priority: -1, kind: 'other' });
  }

  ingest(events: readonly RaceEvent[], crashEvents: readonly { racerId: number; event: CrashEvent }[] = []): void {
    const me = this.o.playerId;
    for (const e of events) {
      switch (e.kind) {
        case 'phase':
          this.phase = e.phase;
          if (e.phase === 'rolling') this.say('Pace boat out. Hold your slots.', ALL, PRIORITY.start);
          break;
        case 'lights':
          if (e.green) {
            this.say('Green, green, green.', ALL, PRIORITY.urgent);
            if (this.o.laps === 1) this.say('One lap. Final lap.', ALL, PRIORITY.lap);
          } else {
            const n = e.of + 1 - e.lit;
            this.say(`${COUNT[n] ?? n}.`, ALL, PRIORITY.count, 'count');
          }
          break;
        case 'positionChanged':
          if (e.racerId !== me || this.phase !== 'racing') break;
          this.say(e.to < e.from ? `Up to P${e.to}.` : `Down to P${e.to}.`, '', PRIORITY.position, 'position');
          break;
        case 'lapCompleted':
          if (e.racerId === me) {
            if (e.best && e.lap > 1) this.toast('Best lap', fmtLap(e.lapTime));
            if (e.lap === this.o.laps - 1) this.say('Final lap.', '', PRIORITY.lap);
            else if (e.lap < this.o.laps) this.say(`Lap ${e.lap}, ${fmtLap(e.lapTime)}.`, '', PRIORITY.position);
          } else if (e.lap === this.o.laps - 1 && !this.leaderFinalCalled) {
            this.leaderFinalCalled = true;
            this.say(`${this.o.name(e.racerId)} on the final lap.`, ALL, PRIORITY.rival);
          }
          if (e.lap === this.o.laps - 1) this.leaderFinalCalled = true;
          break;
        case 'finish': {
          const won = !this.winnerCalled;
          this.winnerCalled = true;
          if (e.racerId === me) {
            const p = this.o.position?.(me);
            this.say(won ? 'Chequer. You take the run.' : p ? `Chequer. P${p}.` : 'Chequer. You are home.', '', PRIORITY.urgent);
          } else if (won) {
            this.say(`${this.o.name(e.racerId)} takes the run.`, ALL, PRIORITY.lap);
          }
          break;
        }
        case 'penalty':
          if (e.racerId !== me) break;
          if (e.reason === 'jumpStart') {
            this.toast('Jump start', `+${e.seconds} s`);
            this.say(`${this.o.playerNumber()}, jump start. Plus ${e.seconds}.`, '', PRIORITY.lap);
          } else {
            this.toast('Missed gate', `+${e.seconds} s`);
          }
          break;
        case 'wrongWay':
          if (e.racerId === me && e.wrongWay) this.toast('Wrong way', 'Turn around');
          break;
        case 'surgeEarned':
          if (e.racerId === me) this.toast('Surge', SURGE_LABEL[e.reason]);
          break;
        case 'dnf':
          if (e.racerId === me) this.say('Out of time. Bring her in.', '', PRIORITY.lap);
          break;
        default:
          break;
      }
    }
    for (const { racerId, event } of crashEvents) {
      if (racerId === me) {
        if (event.type === 'crash') this.say(`${this.o.playerNumber()}, you are down. Stand by.`, '', PRIORITY.urgent);
        else if (event.type === 'teleport') this.say('Back on the line. You are ghosted.', '', PRIORITY.lap);
        else if (event.type === 'recovered') this.say('Recovered. Go.', '', PRIORITY.lap);
      } else if (event.type === 'crash') {
        this.say(`${this.o.name(racerId)} is down.`, ALL, PRIORITY.rival);
      }
    }
  }

  /** age the current line; show the next queued call when it is due */
  step(dt: number): void {
    this.age += dt;
    if (this.queue.length === 0) return;
    const next = this.queue[0];
    if (this.current === null || this.age >= RADIO_HOLD_S || next.priority > this.current.priority) {
      this.queue.shift();
      this.show(next);
    }
  }

  private say(text: string, to: string, priority: number, kind: Call['kind'] = 'other'): void {
    const coalesce = kind !== 'other';
    if (coalesce) {
      const i = this.queue.findIndex((c) => c.kind === kind);
      if (i >= 0) this.queue.splice(i, 1);
    }
    const call: Call = { text, to, priority, kind };
    // stable by priority: after every queued call of the same or higher priority
    let at = this.queue.length;
    for (let i = 0; i < this.queue.length; i++) {
      if (this.queue[i].priority < priority) {
        at = i;
        break;
      }
    }
    this.queue.splice(at, 0, call);
    // an idle strip, a more urgent call, or a newer count/place over the one showing goes out now
    const cur = this.current;
    if (cur === null || this.age >= RADIO_HOLD_S || priority > cur.priority || (coalesce && cur.kind === kind)) {
      this.queue.splice(this.queue.indexOf(call), 1);
      this.show(call);
    }
  }

  private show(c: Call): void {
    this.current = c.priority < 0 ? null : c;
    this.age = 0;
    this.radioText = c.text;
    this.radioTo = c.to;
    this.radioId++;
  }

  private toast(title: string, detail: string): void {
    this.toastTitle = title;
    this.toastDetail = detail;
    this.toastId++;
  }
}

function fmtLap(s: number): string {
  if (!(s >= 0) || !Number.isFinite(s)) return '–';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
}
