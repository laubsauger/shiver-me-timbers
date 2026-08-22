/**
 * Raft half of the preview harness (§T91). Blueprint selection, the five
 * on-deck stations (`?station=`), and the optional first-person walk (`?fp=1`)
 * — kept out of preview.ts so that file stays the galleon harness it was.
 *
 * Stations resolve through `ShipAssembly.socketWorldPosition` (§V71): the
 * camera sits on the LIVE socket, so a re-layout of the raft moves the
 * station with it and no constant here can drift from the blueprint.
 */
import * as THREE from 'three/webgpu';
import type { PieceDef } from './pieceTypes';
import type { ShipAssembly } from './shipAssembly';
import { buildRaftBlueprint } from './raftBlueprint';
import { buildBrigantineBlueprint, buildGalleonBlueprint } from './shipBlueprint';
import { buildRaftDeckField, createRaftCeiling, raftBoardingPoints } from './raftDeckField';
import { createPlayer, type Player } from '../player';
import { createHands } from '../player/hands';
import { createRaftPrompt, type CameraLike, type RaftPrompt } from '../ui/raftPrompt';
import { raftMaterialParams } from '../params/raftMaterials';
import { createInitialState } from '../state/simState';

export type ShipName = 'galleon' | 'brigantine' | 'raft';

export function shipNameOf(q: string | null): ShipName {
  return q === 'raft' || q === 'brigantine' ? q : 'galleon';
}

/** the raft's canvas is ochre, not galleon white — same per-mesh tint path §T.73 uses */
export function tintForShip(name: ShipName): number | undefined {
  return name === 'raft' ? raftMaterialParams.sailTint : undefined;
}

export function buildShipBlueprint(name: ShipName): PieceDef[] {
  if (name === 'raft') return buildRaftBlueprint();
  if (name === 'brigantine') return buildBrigantineBlueprint();
  return buildGalleonBlueprint();
}

/** ship-space AABB over every piece's own box (parents ignored: the raft's
 *  deck pieces are unparented, and a metre of slop is fine for a camera) */
export function blueprintAabb(bp: PieceDef[]): { min: [number, number, number]; max: [number, number, number] } {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const p of bp) {
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p.transform.position[i] + p.aabb.min[i]);
      max[i] = Math.max(max[i], p.transform.position[i] + p.aabb.max[i]);
    }
  }
  return { min, max };
}

const STAND = 1.65;
const CROUCH = 1.05;
/** socket, eye height above it, and ship-local look direction (+z bow, +x starboard) */
const RAFT_STATIONS: Record<string, { socket: string; eye: number; dir: [number, number, number] }> = {
  tiller: { socket: 'station-tiller', eye: STAND, dir: [0, 0, 1] }, // forward over the cabin
  radio: { socket: 'station-radio', eye: CROUCH, dir: [-1, -0.2, -1] }, // into the cabin's port-aft corner
  bow: { socket: 'station-gangway-bow', eye: STAND, dir: [0, 0, -1] }, // aft, at the mast and cabin
  nest: { socket: 'station-lookout', eye: STAND, dir: [0, -0.6, 1] }, // down-forward off the platform
  cabin: { socket: 'station-mat', eye: CROUCH, dir: [1, -0.1, 0.3] }, // toward the starboard door
};

export const RAFT_STATION_NAMES = Object.keys(RAFT_STATIONS);

/** place the camera on a named station; false when the name is unknown */
export function placeAtStation(camera: THREE.Camera, assembly: ShipAssembly, name: string): boolean {
  const st = RAFT_STATIONS[name];
  if (st === undefined) return false;
  assembly.group.updateMatrixWorld(true);
  const s = assembly.socketWorldPosition(st.socket);
  const dir = new THREE.Vector3(...st.dir).normalize().applyQuaternion(assembly.group.quaternion);
  camera.position.set(s[0], s[1] + st.eye, s[2]);
  camera.lookAt(camera.position.clone().add(dir));
  return true;
}

export interface FirstPersonWalk {
  player: Player;
  /** the §T.116 station prompts, drawn over the harness canvas */
  prompt: RaftPrompt;
  /** advance the walker and write the camera; dt in seconds */
  update(dt: number, camera: THREE.Camera): void;
  dispose(): void;
}

/**
 * `?fp=1`: walk the raft in the harness. The sim is a throwaway with one ship
 * at the origin carrying the preview's `?heading=`; the deck field is the
 * raft writer's (§T92), never the galleon's (§V18).
 */
export function attachFirstPerson(
  assembly: ShipAssembly,
  blueprint: PieceDef[],
  canvas: HTMLCanvasElement,
  spawnStation = 'tiller',
): FirstPersonWalk {
  const sim = createInitialState(1);
  const field = buildRaftDeckField(blueprint);
  const g = assembly.group;
  const q = g.quaternion;
  let spawn: [number, number, number] | undefined;
  const st = spawnStation === undefined ? undefined : RAFT_STATIONS[spawnStation];
  if (st !== undefined) {
    // socket is world-space; the walker wants ship-local feet
    const w = assembly.socketWorldPosition(st.socket);
    const l = new THREE.Vector3(w[0], w[1], w[2]).applyQuaternion(q.clone().invert());
    spawn = [l.x, l.y, l.z];
  }
  // stations resolve LIVE through the assembly (§V71) — main-raft's resolver;
  // without it `interact` is inert and the ladder/lookout cannot be tested (§B78)
  const socketWorld = (id: string): [number, number, number] | null => {
    try {
      return assembly.socketWorldPosition(id);
    } catch {
      return null;
    }
  };
  const player = createPlayer({
    sim,
    shipPose: () => ({ position: [0, 0, 0], quaternion: [q.x, q.y, q.z, q.w] }),
    deckField: field,
    boardingPoints: raftBoardingPoints(blueprint),
    ceilingAt: createRaftCeiling(),
    spawn,
    canvas,
    hands: createHands(),
    socketWorld,
  });
  player.setActive(true);
  // §T.116: the harness gets the SAME prompts the game does — one module, one
  // label table (§V95). `?fp=1` is where the §V22 reviewer walks the raft, so
  // an affordance the harness cannot show is an affordance nobody reviews.
  // There are no view modes here, hence nothing to hide it.
  let lens: CameraLike | null = null;
  const prompt = createRaftPrompt({ interact: player.interact, socketWorld, camera: () => lens });
  let hung = false;
  return {
    player,
    prompt,
    update(dt, camera) {
      if (!hung && player.hands !== null) {
        camera.add(player.hands.group);
        hung = true;
      }
      player.step(Math.min(0.05, Math.max(0, dt)));
      const pose = player.cameraPose();
      camera.position.copy(pose.position);
      camera.quaternion.copy(pose.quaternion);
      lens = camera;
      prompt.update(dt);
    },
    dispose(): void {
      prompt.dispose();
      player.dispose();
    },
  };
}
