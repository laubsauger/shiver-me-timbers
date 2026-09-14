/**
 * §T.191 the page's race UI bridge (src/speedboat/page/raceUi.ts, raceRadio.ts, raceSettings.ts, liveries.ts).
 *
 * WHY each block:
 *  - HEADING: physics yaw (0 = +z) and the HUD heading (0 = north −z, clockwise) differ by a reflection. A wrong
 *    conversion puts the next-gate arrow and every plotter dot on the wrong side — on a course the pilot is
 *    learning by shape, that reads as the course being mirrored.
 *  - LAP SPLITS: the race publishes lap times in GRID order, the HUD and the results table index them by racer id.
 *    With the player at the back of the grid, an un-remapped HUD shows a rival's laps as yours.
 *  - RADIO: lamps and green must not be buried under position swaps from the same tick, and a flood of place
 *    changes must say only the newest place.
 *  - SETTINGS: storage is a convenience; a private window (getItem throws) or a corrupt record must still boot a
 *    valid race, and a stored value the screens cannot show must not survive.
 *  - ASSISTS: the pause screen's Pro must actually take the speed-limited lock and the Governor off in the controls
 *    the tick reads; otherwise the screen lies about the boat.
 *  - LIVERIES: all eight community paints must resolve to a hull livery on the one mask system, and the four the
 *    page adds must wear the roster's hue as their dominant colour, so hull and plotter dot read as one boat.
 */
import { describe, expect, it } from 'vitest';
import type { RaceEvent } from '../src/race/events';
import { assistPreset } from '../src/speedboat/assists/settings';
import { FLEET_LIVERIES } from '../src/speedboat/assets/livery';
import { COMMUNITY_LIVERIES, liveryFor } from '../src/speedboat/page/liveries';
import { PRIORITY, RADIO_HOLD_S, RaceRadio } from '../src/speedboat/page/raceRadio';
import {
  RACE_SETTINGS_KEY,
  SEA_PRESET,
  seaApplyArgs,
  applyUiAssists,
  defaultRaceSettings,
  loadRaceSettings,
  saveRaceSettings,
  uiAssistsFrom,
  type KeyValueStore,
} from '../src/speedboat/page/raceSettings';
import { compassFromYaw, createLapTimesById, hudCrashKind, hudHeadingFromYaw, ndcToViewport, seaHeadingFor } from '../src/speedboat/page/raceUi';
import { CONTACT_BOAT, CONTACT_SOLID } from '../src/sea-physics/boatCollide';
import { ASSIST_PRESETS as UI_PRESETS } from '../src/speedboat/ui/pause';
import { relativeBearing } from '../src/speedboat/ui/model';
import { COMMUNITY_PAINTS } from '../src/speedboat/ui/roster';
import { SEA_OPTIONS } from '../src/speedboat/ui/boatSelect';
import { weatherPresets } from '../src/weather/presets';

describe('physics yaw → HUD heading', () => {
  it('a point dead ahead of the hull bears 0, and the pilot’s right (world −x from a +z heading) bears starboard (+)', () => {
    for (const yaw of [0, 0.7, -1.9, Math.PI, 2.6]) {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      const h = hudHeadingFromYaw(yaw);
      expect(Math.abs(relativeBearing(3, -4, h, 3 + 50 * fx, -4 + 50 * fz))).toBeLessThan(1e-9);
      // the pilot's right (page/controls.ts steer sign: world −x from a +z heading) = (−cos yaw, sin yaw)
      const rx = -Math.cos(yaw);
      const rz = Math.sin(yaw);
      expect(relativeBearing(0, 0, h, 50 * rx, 50 * rz)).toBeCloseTo(Math.PI / 2, 9);
    }
  });

  it('north is −z on the plotter and compass', () => {
    expect(compassFromYaw(Math.PI)).toBe('N'); // facing −z
    expect(compassFromYaw(0)).toBe('S');
    expect(compassFromYaw(Math.PI / 2)).toBe('E'); // facing +x: clockwise from north
  });
});

describe('lap splits by racer id', () => {
  it('re-packs grid-order lap times under each racer id and allocates nothing until a lap is added', () => {
    const racerIds = [3, 1, 2, 0]; // the player (0) starts last
    const remap = createLapTimesById(racerIds, 8);
    const grid = [[70.1], [71.2], [], [74.5]];
    const byId = remap.update(grid);
    expect(byId[0]).toEqual([74.5]);
    expect(byId[3]).toEqual([70.1]);
    expect(byId[2]).toEqual([]);
    const arr0 = byId[0];
    expect(remap.update(grid)).toBe(byId);
    expect(remap.update(grid)[0]).toBe(arr0); // same arrays frame to frame
    grid[3] = [74.5, 69.9];
    expect(remap.update(grid)[0]).toEqual([74.5, 69.9]);
    // a restart empties the splits
    expect(remap.update([[], [], [], []])[0]).toEqual([]);
  });
});

describe('crash + sea telemetry', () => {
  it('maps every crash-machine kind to a HUD cause; an impact is contact only when it was a boat', () => {
    expect(hudCrashKind('hook', 0)).toBe('hook');
    expect(hudCrashKind('stuff', 0)).toBe('stuffed');
    expect(hudCrashKind('blowOver', 0)).toBe('blowover');
    expect(hudCrashKind('barrelRoll', 0)).toBe('barrelroll');
    expect(hudCrashKind('impact', CONTACT_BOAT)).toBe('contact');
    expect(hudCrashKind('impact', CONTACT_SOLID)).toBe('structure');
  });

  it('names the swell relative to the hull, and flat water as the lee', () => {
    expect(seaHeadingFor(0, 0, 1)).toBe('following');
    expect(seaHeadingFor(0, Math.PI, 1)).toBe('head');
    expect(seaHeadingFor(0, Math.PI / 2, 1)).toBe('beam');
    expect(seaHeadingFor(0, Math.PI, 0.05)).toBe('lee');
  });

  it('NDC → viewport puts NDC (0,0) mid-screen, +y up on screen, and flags a point behind the camera', () => {
    const o = { x: 0, y: 0, valid: false, behind: false };
    ndcToViewport({ x: 0, y: 0, z: 0.5 }, o);
    expect(o).toEqual({ x: 0.5, y: 0.5, valid: true, behind: false });
    ndcToViewport({ x: 1, y: 1, z: 1.2 }, o);
    expect(o.x).toBe(1);
    expect(o.y).toBe(0);
    expect(o.behind).toBe(true);
  });
});

describe('race control radio', () => {
  const mk = (laps = 3) =>
    new RaceRadio({ playerId: 0, laps, name: (id) => ['You', 'Crosswind', 'White Horses'][id] ?? `#${id}`, playerNumber: () => 1, position: () => 2 });

  it('rolling, the lamps counted down, then green cuts in over a position swap from the same tick', () => {
    const r = mk();
    const lines: string[] = [];
    const log = (): void => {
      if (lines[lines.length - 1] !== r.radioText) lines.push(r.radioText);
    };
    r.ingest([{ kind: 'phase', phase: 'rolling' }]);
    log();
    for (let lit = 1; lit <= 5; lit++) {
      r.ingest([{ kind: 'lights', lit, of: 5, green: false }]);
      log();
      r.step(1);
      log();
    }
    r.ingest([
      { kind: 'phase', phase: 'racing' },
      { kind: 'lights', lit: 0, of: 5, green: true },
      { kind: 'positionChanged', racerId: 0, from: 8, to: 7 },
    ]);
    log();
    expect(lines).toEqual(['Pace boat out. Hold your slots.', 'Five.', 'Four.', 'Three.', 'Two.', 'One.', 'Green, green, green.']);
    // the swap waits its turn, then goes out
    r.step(RADIO_HOLD_S);
    expect(r.radioText).toBe('Up to P7.');
  });

  it('a flood of place changes says only the newest place, and rivals never pre-empt your call', () => {
    const r = mk();
    r.ingest([{ kind: 'phase', phase: 'racing' }]);
    r.ingest([], [{ racerId: 0, event: { type: 'crash', kind: 'stuff', impact: 20 } }]);
    expect(r.radioText).toBe('1, you are down. Stand by.');
    const swaps: RaceEvent[] = [
      { kind: 'positionChanged', racerId: 0, from: 2, to: 3 },
      { kind: 'positionChanged', racerId: 0, from: 3, to: 4 },
      { kind: 'positionChanged', racerId: 0, from: 4, to: 5 },
    ];
    r.ingest(swaps, [{ racerId: 1, event: { type: 'crash', kind: 'hook', impact: 3 } }]);
    expect(r.radioText).toBe('1, you are down. Stand by.');
    r.step(RADIO_HOLD_S);
    expect(r.radioText).toBe('Down to P5.');
    r.step(RADIO_HOLD_S);
    expect(r.radioText).toBe('Crosswind is down.');
    expect(PRIORITY.urgent).toBeGreaterThan(PRIORITY.position);
  });

  it('final lap, winner and penalties: radio for race control, toasts for momentary things', () => {
    const r = mk(3);
    r.ingest([{ kind: 'phase', phase: 'racing' }, { kind: 'lapCompleted', racerId: 0, lap: 2, lapTime: 71.3, best: true, time: 140 }]);
    expect(r.radioText).toBe('Final lap.');
    expect(r.toastTitle).toBe('Best lap');
    const t = r.toastId;
    r.ingest([{ kind: 'penalty', racerId: 0, reason: 'missedElement', element: 4, seconds: 5, totalSeconds: 5, time: 150 }]);
    expect(r.toastId).toBe(t + 1);
    expect(r.toastTitle).toBe('Missed gate');
    r.step(RADIO_HOLD_S);
    r.ingest([{ kind: 'finish', racerId: 1, lapsCompleted: 3, time: 210, totalTime: 210 }]);
    r.step(RADIO_HOLD_S);
    expect(r.radioText).toBe('Crosswind takes the run.');
    r.ingest([{ kind: 'finish', racerId: 0, lapsCompleted: 3, time: 212, totalTime: 212 }]);
    expect(r.radioText).toBe('Chequer. P2.');
    const id = r.radioId;
    r.reset();
    expect(r.radioText).toBe('');
    expect(r.radioId).toBe(id + 1);
  });
});

describe('settings persistence', () => {
  const memory = (): KeyValueStore & { data: Map<string, string> } => {
    const data = new Map<string, string>();
    return { data, getItem: (k) => data.get(k) ?? null, setItem: (k, v) => void data.set(k, v) };
  };

  it('round-trips assists, camera, HUD size, audio and the last selection', () => {
    const s = memory();
    const want = defaultRaceSettings();
    want.assists = { preset: 'pro', ...UI_PRESETS.pro };
    want.camera = 'cockpit';
    want.hudScale = 0.85;
    want.audio.master = 0.3;
    want.lastSelection = { paintId: 'pine-cut', number: 12, gogglesId: 'sport-cord', sea: 'Working sea', time: '06:30', rivals: 'Club' };
    expect(saveRaceSettings(want, s)).toBe(true);
    expect(loadRaceSettings(s)).toEqual(want);
  });

  it('a throwing, absent or corrupt store boots the defaults; unknown values do not survive', () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error('SecurityError');
      },
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
    };
    expect(loadRaceSettings(throwing)).toEqual(defaultRaceSettings());
    expect(saveRaceSettings(defaultRaceSettings(), throwing)).toBe(false);
    expect(loadRaceSettings(null)).toEqual(defaultRaceSettings());
    const s = memory();
    s.data.set(RACE_SETTINGS_KEY, '{not json');
    expect(loadRaceSettings(s)).toEqual(defaultRaceSettings());
    s.data.set(RACE_SETTINGS_KEY, JSON.stringify({ camera: 'drone', hudScale: 3, audio: { master: 7 }, lastSelection: { paintId: 'nope', number: 400, sea: 'Hurricane' } }));
    const got = loadRaceSettings(s);
    expect(got.camera).toBe('chase');
    expect(got.hudScale).toBe(1);
    expect(got.audio.master).toBe(1);
    expect(got.lastSelection?.paintId).toBe('signal');
    expect(got.lastSelection?.number).toBe(1);
    expect(got.lastSelection?.sea).toBe('Working sea');
  });

  it('every boat-select sea option names a real weather preset (a speedboat sea through its sky rung)', () => {
    for (const opt of SEA_OPTIONS) expect(weatherPresets, opt).toHaveProperty(seaApplyArgs(SEA_PRESET[opt])[0]);
  });
});

describe('pause assists reach the controls', () => {
  it('Pro takes the lock and the Governor off in the controls object the tick reads; Default puts them back', () => {
    const controls = assistPreset('default');
    const helm = controls.helmRateDegPerS;
    applyUiAssists({ preset: 'pro', ...UI_PRESETS.pro }, controls);
    expect(controls.speedLimitedLock).toBe(0);
    expect(controls.governor).toBe('OFF');
    expect(controls.landingAssist).toBe(0);
    expect(controls.helmRateDegPerS).toBe(helm); // the actuator is not an assist
    expect(uiAssistsFrom(controls).preset).toBe('pro');
    applyUiAssists({ preset: 'default', ...UI_PRESETS.default }, controls);
    expect(controls).toEqual(assistPreset('default'));
    expect(uiAssistsFrom(controls)).toEqual({ preset: 'default', ...UI_PRESETS.default });
  });
});

describe('the eight community liveries', () => {
  it('every roster paint resolves to a full livery with valid colours, through its liveryKey', () => {
    for (const p of COMMUNITY_PAINTS) {
      const l = COMMUNITY_LIVERIES[p.id];
      expect(l, p.id).toBeDefined();
      for (const k of ['topsides', 'band', 'stripe', 'antifoul', 'numeral', 'dominant'] as const) {
        expect(Number.isInteger(l[k]) && l[k] >= 0 && l[k] <= 0xffffff, `${p.id}.${k}`).toBe(true);
      }
      expect(p.liveryKey, p.id).not.toBe('');
      // §T.201: every paint joins the ASSET table (the roster keeps no hull colours of its own to drift from it)
      const joined = (FLEET_LIVERIES as Record<string, unknown>)[p.liveryKey];
      expect(joined, p.liveryKey).toBeDefined();
      expect(l).toBe(joined);
    }
    expect(new Set(Object.values(COMMUNITY_LIVERIES).map((l) => l.dominant)).size).toBe(8);
  });

  it('liveryFor carries the race number and falls back to the hero for an unknown paint', () => {
    expect(liveryFor('dome-ten', 42).number).toBe(42);
    expect(liveryFor('dome-ten', 42).dominant).toBe(COMMUNITY_LIVERIES['dome-ten'].dominant);
    expect(liveryFor('mystery', 5)).toEqual({ ...FLEET_LIVERIES.hero, number: 5 });
  });
});
