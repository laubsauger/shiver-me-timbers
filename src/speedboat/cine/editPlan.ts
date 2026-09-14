/**
 * THE EDIT PLAN for the trailer — exactly the `edit-plan.json` schema of docs/cine/trailer-edit-plan.md, which
 * scripts/resolve/trailer_import.py turns into a Resolve timeline. Pure: no DOM, no three.
 *
 * The page POSTs this to the sink's `/plan` when a record or an audio pass starts; the sink writes `edit-plan.json`
 * keeping only the files that exist on disk (a video that was not rendered is not in the plan; a missing proxy or SFX
 * stem drops that key), so the importer never fails on a path the render has not produced yet.
 */
import type { Shot } from '../../cine/types';
import type { TrailerTime } from './look';
import { TRAILER_MARKERS, TRAILER_NAME, TRAILER_RUNS, TRAILER_SECONDS, TRAILER_SHOTS, TRAILER_SLOTS, coverageFor, trailerTakes, type CoverageTier, type TrailerShot } from './shotlist';

/**
 * `sb-trailer-v2_07_rear-chase-launch_take01` — stable, sortable, one name for the master, the proxy and the stem. A
 * time-of-day variant take carries its time: `sb-trailer-v2_10_bow-lookback_night_take01`.
 */
export function trailerClipName(shot: Pick<Shot, 'id' | 'slug'> & { variant?: TrailerTime; camera?: string }, take = 1): string {
  const c = shot.camera !== undefined ? `_cam-${shot.camera}` : '';
  const v = shot.variant !== undefined ? `_${shot.variant}` : '';
  return `${TRAILER_NAME}_${shot.id}_${shot.slug}${c}${v}_take${String(take).padStart(2, '0')}`;
}

/**
 * One COVERAGE clip (docs/cine/trailer-edit-plan.md §Coverage): a lens on a setup's run. Every clip of a setup covers the
 * same simulated interval, so `sourceStartS` (the setup's shot time at the clip's first frame) is its source timecode
 * and the cameras line up for multicam. The importer bins them by setup / camera / time.
 */
export interface EditPlanCoverage {
  /** the setup = the run's shot id */
  setup: string;
  setupName: string;
  /** 'main' = the shot's own lens */
  camera: string;
  kind: string;
  tier: CoverageTier;
  timeOfDay: string;
  video: string;
  proxy?: string;
  /** the setup's one stem (shared by every camera and time) */
  sfx?: string;
  sourceStartS: number;
  durationS: number;
  /** true = this clip is also the assembly's picture for that shot (V1) */
  onAssembly: boolean;
  /**
   * the frame to cut / centre a dissolve on between this setup's time-of-day takes, as SOURCE seconds into the clip
   * (handle + the shot's `cutAtS`) — 06c's lever push-start. Absent = no marked cut.
   */
  cutS?: number;
  notes: string;
}

/** one other time of day of a shot, stacked above the primary in the edit (trailer_import.py: V2, V3 …) */
export interface EditPlanAlternate {
  variant: string;
  video: string;
  proxy?: string;
}

export interface EditPlanShot {
  id: string;
  name: string;
  video: string;
  proxy?: string;
  /** the SFX MIX (all SFX + ambience, no music, no radio) */
  sfx?: string;
  /**
   * split stems of the same take, for mixing the engine or the water against the music (docs/cine/trailer-edit-plan.md):
   * listed for every shot; the sink keeps only the stems that were written (a page that cannot split writes none)
   */
  sfxStems?: { engine?: string; water?: string; amb?: string };
  handleS: number;
  recordInS: number;
  recordOutS: number;
  notes: string;
  /** the same take at other times of day; absent = none (the importer adds no tracks) */
  alternates?: EditPlanAlternate[];
}

/** every coverage clip of these runs (camera 0 of each run included) at a tier, over their times of day */
export function trailerCoverage(runs: readonly TrailerShot[], take = 1, tier: CoverageTier = 'C', variants?: readonly TrailerTime[]): EditPlanCoverage[] {
  const out: EditPlanCoverage[] = [];
  for (const run of runs) {
    const times = trailerTakes([run], variants);
    const stem = `sfx/${trailerClipName(run, take)}.wav`;
    const cams: { cam: string; kind: string; tier: CoverageTier; note: string }[] = [
      { cam: 'main', kind: run.primitive, tier: 'A', note: `${run.cue} ${run.note ?? ''}`.trim() },
      ...coverageFor(run, tier).map((c) => ({ cam: c.cam, kind: c.kind, tier: c.tier, note: c.note })),
    ];
    for (const c of cams) {
      for (const [k, t] of times.entries()) {
        const clip = trailerClipName({ ...t, camera: c.cam === 'main' ? undefined : c.cam }, take);
        out.push({
          setup: run.id,
          setupName: run.slug,
          camera: c.cam,
          kind: c.kind,
          tier: c.tier,
          timeOfDay: t.timeOfDay,
          video: `video/${clip}.mov`,
          proxy: `proxy/${clip}.mov`,
          sfx: stem,
          sourceStartS: -(run.handle ?? 0),
          durationS: 2 * (run.handle ?? 0) + (run.out - run.in),
          onAssembly: run.run !== true && c.cam === 'main' && k === 0,
          ...(run.cutAtS !== undefined ? { cutS: (run.handle ?? 0) + run.cutAtS } : {}),
          notes: c.note,
        });
      }
    }
  }
  return out;
}

export interface EditPlan {
  name: string;
  fps: number;
  width: number;
  height: number;
  durationS: number;
  shots: EditPlanShot[];
  markers: { atS: number; name: string; color: string; note: string }[];
  slots: { kind: string; recordInS?: number; recordOutS?: number; track?: string; name: string }[];
  /** every clip of every setup, for the multicam bins (absent in a plan with no coverage) */
  coverage?: EditPlanCoverage[];
}

export function trailerEditPlan(
  run: { fps: number; width: number; height: number },
  take = 1,
  shots: readonly TrailerShot[] = TRAILER_SHOTS,
  variants?: readonly TrailerTime[],
  tier: CoverageTier = 'C',
  runs: readonly TrailerShot[] = TRAILER_RUNS,
): EditPlan {
  const takes = trailerTakes(shots, variants);
  return {
    name: TRAILER_NAME,
    fps: run.fps,
    width: run.width,
    height: run.height,
    durationS: TRAILER_SECONDS,
    shots: shots.map((shot) => {
      const mine = takes.filter((t) => t.id === shot.id);
      const s = mine[0] ?? shot;
      const clip = trailerClipName(s, take);
      const alternates = mine.slice(1).map((a) => {
        const c = trailerClipName(a, take);
        return { variant: a.variant ?? a.timeOfDay, video: `video/${c}.mov`, proxy: `proxy/${c}.mov` };
      });
      return {
        id: s.id,
        name: s.slug,
        video: `video/${clip}.mov`,
        proxy: `proxy/${clip}.mov`,
        // ONE stem per shot, named like the audio pass names it (it never expands variants): identical across times of day
        sfx: `sfx/${trailerClipName(shot, take)}.wav`,
        sfxStems: {
          engine: `sfx/${trailerClipName(shot, take)}_engine.wav`,
          water: `sfx/${trailerClipName(shot, take)}_water.wav`,
          amb: `sfx/${trailerClipName(shot, take)}_amb.wav`,
        },
        handleS: s.handle ?? 0,
        recordInS: s.in,
        recordOutS: s.out,
        notes: `${s.cue} ${s.note ?? ''}`.trim(),
        ...(alternates.length > 0 ? { alternates } : {}),
      };
    }),
    markers: TRAILER_MARKERS.map((m) => ({ ...m })),
    slots: TRAILER_SLOTS.map((m) => ({ ...m })),
    coverage: trailerCoverage([...shots, ...runs], take, tier, variants),
  };
}
