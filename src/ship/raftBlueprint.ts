/**
 * Kon-Tiki raft blueprint (RAFT 2100, §T89) — the third ship class on the
 * same `PieceDef[]` contract (§V13/§V18). Pure, deterministic function of
 * params/raft.ts; every dimension there cites docs/raft2100/kon-tiki-
 * reference.md (§V82).
 *
 * Frame: +z bow, +x starboard, y = 0 waterline, log centrelines at y = 0.
 */
import { raftParams, type RaftParams } from '../params/raft';
import type { PieceDef } from './pieceTypes';
import { raftLayout } from './raftPartsLayout';
import {
  buildBambooDeck,
  buildCrossbeams,
  buildGuaras,
  buildLogs,
  buildSplashboards,
  buildSteering,
} from './raftPartsHull';
import { buildCabin, buildDressing } from './raftPartsCabin';
import { buildBipodMast, buildMizzenAndFlag } from './raftPartsRig';

export { raftLayout } from './raftPartsLayout';

export function buildRaftBlueprint(p: RaftParams = raftParams): PieceDef[] {
  const L = raftLayout(p);
  return [
    ...buildLogs(p, L),
    ...buildSplashboards(p, L),
    ...buildCrossbeams(p, L),
    ...buildBambooDeck(p, L),
    ...buildCabin(p, L),
    ...buildBipodMast(p, L),
    ...buildMizzenAndFlag(p, L),
    ...buildGuaras(p, L),
    ...buildSteering(p, L),
    ...buildDressing(p, L),
  ];
}
