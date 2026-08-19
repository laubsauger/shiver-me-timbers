/**
 * SHIPBOARD CAMERA STATIONS — where the numbered vantages ARE, expressed in
 * the SHIP's own frame. `followCam.ts` owns what the lens does once it is
 * there; this file owns nothing but "which point on the ship, pointing which
 * way".
 *
 * WHY THE POSITIONS ARE NOT TYPED IN (§V.71). Every station resolves against
 * the LIVE assembly, not against numbers copied out of a blueprint dump: the
 * bow station is `socket-figurehead`, the stern one the midpoint of the two
 * taffrail cleats, the masthead one `socket-lookout`. Ask the §V.71 diagnostic
 * — "what happens when the host moves?" — and the answer comes from the host's
 * own evaluator (`ShipAssembly.socketWorldPosition`, inverted back through the
 * ship's root), so a sterncastle that grows a metre takes the camera with it
 * instead of leaving it standing in mid-air. None of these fittings currently
 * animate in ship-local space (only yards, the wheel disc and sail cloth do),
 * which is exactly the condition under which an authored constant would look
 * right today and be a latent defect tomorrow.
 *
 * WHY THE GUN'S BORE IS NOT RE-DERIVED (§V.77). "Where does this gun point" is
 * already an expression: `combat/aim.ts`'s `muzzleLay`, the same one the
 * crosshair and the ball both come from. Evaluating it with an IDENTITY
 * quaternion returns that answer in the ship's frame, which is what a
 * deck-parented camera wants — so the shot looks down the true bore including
 * the player's live lay, and a tuning pass on `muzzleForward` or the elevation
 * clamp moves the camera, the reticle and the ball together or none of them.
 * WHICH gun likewise comes from `battery.batteryCentreGun`, the same call the
 * crosshair makes, so the reticle reports the very barrel you are sitting on.
 *
 * §V.3: read-only. Nothing here writes SimState or the assembly.
 */
import type { Object3D } from 'three';
import { Vector3 } from 'three';
import type { PieceDef, Vec3 } from '../ship/pieceTypes';
import { buildBattery, batteryCentreGun, type Battery } from '../combat/battery';
import { muzzleLay } from '../combat/aim';
import { cameraParams } from '../params/camera';

export type StationId = 'gun' | 'bow' | 'stern' | 'nest';

/** the number-row order (§I): Digit1 → gun, Digit2 → bow, … */
export const STATION_IDS: readonly StationId[] = ['gun', 'bow', 'stern', 'nest'];

export interface StationPose {
  /** SHIP-LOCAL eye position, m */
  eye: Vec3;
  /** SHIP-LOCAL unit vector the station's zero look-offset points along */
  forward: Vec3;
}

/** what a station needs to know about the ship it is standing on, LIVE */
export interface StationHost {
  /**
   * Ship-local position of a socket as it is RIGHT NOW, or null when this hull
   * has no such socket (a brigantine has no crow's nest). Null, never a
   * throw — a camera key must not be able to take the frame down.
   */
  socketLocal(socketId: string): Vec3 | null;
  /** the player's CURRENT gun lay, rad above horizontal */
  gunElevation(): number;
}

export interface StationSource {
  /** null when this hull cannot offer that station */
  pose(id: StationId): StationPose | null;
}

/**
 * Sockets each standing station is pinned to. More than one = their midpoint,
 * which is how the stern station lands on the centreline: the taffrail has a
 * cleat at each quarter and no socket between them, and averaging the two real
 * fittings is honest where inventing a third would not be.
 */
const STATION_SOCKETS: Record<Exclude<StationId, 'gun'>, readonly string[]> = {
  bow: ['socket-figurehead'],
  stern: ['anchor-cleat-stern-port', 'anchor-cleat-stern-starboard'],
  nest: ['socket-lookout'],
};

/** which way each standing station faces before the player looks around */
const STATION_FORWARD: Record<Exclude<StationId, 'gun'>, Vec3> = {
  bow: [0, 0, 1], // over the bow wave (ship-local +z is forward)
  stern: [0, 0, -1], // back down the wake
  nest: [0, 0, 1],
};

const ORIGIN: Vec3 = [0, 0, 0];
const IDENTITY: [number, number, number, number] = [0, 0, 0, 1];

/**
 * Bind the station set to one hull. The battery is resolved once (gun stations
 * do not move on the deck) but every POSITION is read per call, because the
 * lay and the assembly both move (§V.62: a station read once at construction
 * would be a vantage that stops answering the moment anything changes).
 */
export function createStations(
  blueprint: readonly PieceDef[],
  host: StationHost,
): StationSource {
  const battery: Battery = buildBattery(blueprint as PieceDef[]);

  const standing = (id: Exclude<StationId, 'gun'>): StationPose | null => {
    const p = cameraParams;
    let x = 0;
    let y = 0;
    let z = 0;
    const ids = STATION_SOCKETS[id];
    for (const socketId of ids) {
      const local = host.socketLocal(socketId);
      if (local === null) return null;
      x += local[0];
      y += local[1];
      z += local[2];
    }
    const n = ids.length;
    return {
      eye: [x / n, y / n + p.stationEyeHeight, z / n],
      forward: STATION_FORWARD[id],
    };
  };

  const gun = (): StationPose | null => {
    const p = cameraParams;
    // read every frame, not captured: flipping this in the debug panel walks
    // the camera across the deck while you watch (§V.62)
    const side = p.gunStationPort ? 'port' : 'starboard';
    const mount = batteryCentreGun(battery, side);
    if (mount === undefined) return null;
    const local = host.socketLocal(mount.socketId);
    if (local === null) return null;
    // §V.77: gunnery's OWN lay, evaluated in the ship's frame. `position` is
    // the muzzle and goes unused — it is `direction` that must not be a second
    // opinion, since it carries the live elevation the player is holding.
    const lay = muzzleLay(ORIGIN, IDENTITY, local, side, host.gunElevation());
    const d = lay.direction;
    const back = p.gunStationBack;
    return {
      eye: [
        local[0] - d[0] * back,
        local[1] + p.gunStationEyeHeight - d[1] * back,
        local[2] - d[2] * back,
      ],
      forward: d,
    };
  };

  return {
    pose: (id) => (id === 'gun' ? gun() : standing(id)),
  };
}

/** the slice of ShipAssembly a station set needs — kept narrow for tests */
export interface StationAssembly {
  group: Object3D;
  socketWorldPosition(socketId: string): Vec3;
}

/**
 * The three.js-side adapter: ship-local out of the LIVE scene graph.
 *
 * `socketWorldPosition` walks the piece's own parent chain and answers in WORLD
 * space, so it already carries the hull's current pose; putting it back through
 * the ship root's inverse is what makes it a ship-LOCAL station that the deck
 * can then carry (heel, pitch and heave arrive with the parenting, not from
 * here). An unknown socket throws in there — caught, because a hull that lacks
 * a fitting must degrade to "that key does nothing visible" and say so once,
 * not to a dead frame.
 */
export function createShipStations(
  blueprint: readonly PieceDef[],
  assembly: StationAssembly,
  gunElevation: () => number,
): StationSource {
  const scratch = new Vector3();
  return createStations(blueprint, {
    socketLocal(socketId) {
      let world: Vec3;
      try {
        world = assembly.socketWorldPosition(socketId);
      } catch {
        return null;
      }
      assembly.group.updateWorldMatrix(true, false);
      scratch.set(world[0], world[1], world[2]);
      assembly.group.worldToLocal(scratch);
      if (!Number.isFinite(scratch.x) || !Number.isFinite(scratch.y) || !Number.isFinite(scratch.z)) {
        return null; // §V.28: never hand a NaN to a transform
      }
      return [scratch.x, scratch.y, scratch.z];
    },
    gunElevation,
  });
}
