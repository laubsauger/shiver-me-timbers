/**
 * THE EDIT PLAN for the trailer — exactly the `edit-plan.json` schema of docs/cine/trailer-edit-plan.md, which
 * scripts/resolve/trailer_import.py turns into a Resolve timeline. Pure: no DOM, no three.
 *
 * The page POSTs this to the sink's `/plan` when a record or an audio pass starts; the sink writes `edit-plan.json`
 * keeping only the files that exist on disk (a video that was not rendered is not in the plan; a missing proxy or SFX
 * stem drops that key), so the importer never fails on a path the render has not produced yet.
 */
import type { Shot } from '../../cine/types';
import { TRAILER_MARKERS, TRAILER_NAME, TRAILER_SECONDS, TRAILER_SHOTS, TRAILER_SLOTS, type TrailerShot } from './shotlist';

/** `sb-trailer-v1_07_rear-chase-launch_take01` — stable, sortable, one name for the master, the proxy and the stem */
export function trailerClipName(shot: Pick<Shot, 'id' | 'slug'>, take = 1): string {
  return `${TRAILER_NAME}_${shot.id}_${shot.slug}_take${String(take).padStart(2, '0')}`;
}

export interface EditPlanShot {
  id: string;
  name: string;
  video: string;
  proxy?: string;
  sfx?: string;
  handleS: number;
  recordInS: number;
  recordOutS: number;
  notes: string;
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
}

export function trailerEditPlan(run: { fps: number; width: number; height: number }, take = 1, shots: readonly TrailerShot[] = TRAILER_SHOTS): EditPlan {
  return {
    name: TRAILER_NAME,
    fps: run.fps,
    width: run.width,
    height: run.height,
    durationS: TRAILER_SECONDS,
    shots: shots.map((s) => {
      const clip = trailerClipName(s, take);
      return {
        id: s.id,
        name: s.slug,
        video: `video/${clip}.mov`,
        proxy: `proxy/${clip}.mov`,
        sfx: `sfx/${clip}.wav`,
        handleS: s.handle ?? 0,
        recordInS: s.in,
        recordOutS: s.out,
        notes: `${s.cue} ${s.note ?? ''}`.trim(),
      };
    }),
    markers: TRAILER_MARKERS.map((m) => ({ ...m })),
    slots: TRAILER_SLOTS.map((m) => ({ ...m })),
  };
}
