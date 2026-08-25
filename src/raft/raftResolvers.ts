/**
 * §V71 / §T.157 — THE TWO LIVE ANSWERS ABOUT WHERE THINGS ARE ON THE RAFT,
 * resolved against the assembly every time they are asked.
 *
 *   socketWorld  where a station's SOCKET is — the patch of deck a hand can
 *                reach from, which is the only question a socket answers.
 *   pieceNear    where the OBJECT that station operates is — the point on its
 *                piece nearest a given spot, so the tiller's plaque lands on
 *                the oar's grip and the radio's on the set's face (§T.157).
 *
 * They live together, and outside `main-raft.ts` (§T.98 keeps the entry to
 * boot), because everything that asks either — the walker's look cone, the
 * prompt, the cue dots, §T.155's outline — must ask the SAME pair or be free
 * to disagree about what is being looked at (§V62).
 */
import type { PieceResolver, Vec3 } from '../player/stations';
import type { ShipAssembly } from '../ship/shipAssembly';

export interface StationResolvers {
  socketWorld(id: string): Vec3 | null;
  pieceNear: PieceResolver;
}

export function createStationResolvers(assembly: ShipAssembly): StationResolvers {
  return {
    // `socketWorldPosition` throws on an unknown socket; a station naming one
    // that has not been built must go quiet, not take the frame down
    socketWorld(id: string): Vec3 | null {
      try {
        return assembly.socketWorldPosition(id) as Vec3;
      } catch {
        return null;
      }
    },
    pieceNear: (id, at) => assembly.pieceNearestPoint(id, [at[0], at[1], at[2]]),
  };
}
