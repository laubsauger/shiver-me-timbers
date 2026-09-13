/**
 * COCKPIT EYE FALLBACK (§T.182) — used only until the pilot GLB's `cam_eye` node is wired (pilot agent: a child of
 * the `head` joint, glTF camera convention, outside the `head_geo` collapse bone; scripts/blender/pilot/checkPilotGlb.mjs).
 *
 * Body frame (relative to the CG, +z bow, +y up), from the hull JSON:
 *   x = renderOnly.cockpit.seats[0].x
 *   y = deckHeight(spec) + EYE_ABOVE_SHEER − vcgAboveKeel
 *   z = seats[0].zFromTransom + EYE_AHEAD_OF_SEAT − lcgFromTransom
 * EYE_ABOVE_SHEER 0.63 / EYE_AHEAD_OF_SEAT 0.29: the parts manifest's ergonomic anchor is sheer + 0.50, 0.45 ahead of
 * the seat (scripts/blender/parts/manifest.json helm), but the rigged 1.78 m pilot's eyes sit 0.13 m above and 0.16 m
 * aft of it (docs/speedboat/pilot-log.md Blockers 1, "or the anchor moves to about sheer + 0.63"). The camera uses
 * where the pilot's eyes ARE, so the fallback and the eye node agree to a few cm.
 */
import { deckHeight, HULL_DATA } from '../speedboat/hullMesh';

export const EYE_ABOVE_SHEER = 0.63;
export const EYE_AHEAD_OF_SEAT = 0.29;

export function cockpitEyeFallback(): [number, number, number] {
  const spec = HULL_DATA.spec;
  const seats = (HULL_DATA as unknown as { renderOnly?: { cockpit?: { seats?: { x: number; zFromTransom: number }[] } } })
    .renderOnly?.cockpit?.seats;
  if (!seats || seats.length === 0) throw new Error('raceCamEye: deepV12.hull.json has no renderOnly.cockpit.seats[0]');
  const seat = seats[0];
  return [
    seat.x,
    deckHeight(spec) + EYE_ABOVE_SHEER - spec.vcgAboveKeel,
    seat.zFromTransom + EYE_AHEAD_OF_SEAT - spec.lcgFromTransom,
  ];
}
