/**
 * Scene glue every mode builds the same way (§V95).
 *
 * `main.ts` (pirate) and `raft/raftScene.ts` + `raft/raftFrame.ts` (raft) had
 * their own copy of both pieces below, character for character in places. The
 * user's words on why that is a defect rather than a style question: "some of
 * these things shouldn't be reinvented in both modes and then live duplicated
 * and varied — that's going to cause code rot."
 *
 * What is NOT here: the heavy systems a mode deliberately leaves out (combat,
 * AI, lanterns, the enemy). §V95 permits a mode to omit a system; it forbids
 * a mode to grow a second implementation of one.
 *
 * @see bootCompile.ts  pipeline warm-up glue
 * @see bootSettings.ts settings → engine bindings
 * @see bootSplash.ts   boot phase / splash hooks
 */
import type { Vector3 } from 'three/webgpu';
import type { Material } from 'three/webgpu';
import type { MaterialFactory } from '../ship/shipAssembly';
import type { DeckFieldSampler } from '../ship/deckFieldTexture';
import { createHoleMaterial, createPieceMaterial } from '../ship/pieceMaterials';
import type { AudioFrame, HasWorldMatrix, ShipAudioInput } from '../audio';
import type { ShipState, SimState } from '../state/simState';

/**
 * §T.40: ONE material set shared by every assembly built from it.
 *
 * three's node cache key is built from node INSTANCE ids, so two structurally
 * identical materials share no codegen and no pipeline — the enemy galleon was
 * a second full set of ~30 piece shaders, and the wood family is the heaviest
 * in the project. Semantically free: piece materials already key nothing off
 * which ship they sit on — `uShipWorldInverse` and `uShipSunDirection` are
 * module-level singletons that every assembly has always shared.
 *
 * The deck-field texture is the ONE thing the cache closes over, which is why
 * a set is per-vessel-class rather than global: the galleon's writer field and
 * the raft's are different fields (§V.18).
 */
export function createPieceMaterialCache(deckFieldTexture: DeckFieldSampler): MaterialFactory {
  const cache = new Map<string, Material>();
  return (kind, role) => {
    const key = `${kind}:${role}`;
    let material = cache.get(key);
    if (material === undefined) {
      material = role === 'hole' ? createHoleMaterial() : createPieceMaterial(kind, deckFieldTexture);
      cache.set(key, material);
    }
    return material;
  };
}

export interface ShipAudioFeed {
  /** the hoisted frame object — handed to `audio.update()` by the caller */
  frame: AudioFrame;
  /**
   * Copy this frame's wind, weather, pose and sensors into the hoisted frame.
   *
   * Call LAST, after the render: the panner listener reads
   * `camera.matrixWorld`, which is only final once the frame is drawn —
   * updating earlier lags the whole field by one frame.
   *
   * `ship` is the LIVE sim ship (velocity, rates, trim) and `view` the
   * interpolated render pose (§V.2) — the sound follows what is on screen,
   * the motion follows what the sim did. Wind and weather are read off the
   * sim state this feed was built with. Positional arguments, and every write
   * lands in a hoisted object: this runs once per rendered frame and
   * allocates nothing.
   *
   * @param bowImmersion metres of bow below the surface (§V27)
   * @param bowWorld     exact bow world position this frame
   * @param sailDrop     continuous cloth drop, the SAME scalar `updateRig` animates with
   * @param contact      live hull-contact sensor, passed straight through
   */
  publish(
    dt: number,
    ship: ShipState,
    view: ShipState,
    bowImmersion: number,
    bowWorld: Vector3,
    sailDrop: number,
    contact: ShipAudioInput['contact'],
  ): void;
}

/**
 * The per-frame audio input, hoisted once (§V21). Both entries built the same
 * `ShipAudioInput` + `AudioFrame` pair and then copied the same twelve fields
 * into it every frame — the copy is the part that rots, because a field added
 * on one side is simply missing on the other.
 */
export function createShipAudioFeed(camera: HasWorldMatrix, state: SimState): ShipAudioFeed {
  const shipIn: ShipAudioInput = {
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    sailTrim: 0,
    bowImmersion: 0,
    bowWorld: [0, 0, 0],
  };
  const bowWorld = shipIn.bowWorld as [number, number, number];
  const frame: AudioFrame = {
    dt: 0,
    camera,
    wind: { speed: 0, direction: 0 },
    weather: state.weather,
    ship: shipIn,
  };
  return {
    frame,
    publish(dt, ship, view, bowImmersion, bow, sailDrop, contact): void {
      frame.dt = dt;
      frame.wind.speed = state.wind.speed;
      frame.wind.direction = state.wind.direction;
      frame.weather = state.weather;
      shipIn.position = view.position;
      shipIn.quaternion = view.quaternion;
      shipIn.velocity = ship.velocity;
      shipIn.angularVelocity = ship.angularVelocity;
      shipIn.sailTrim = ship.sailTrim;
      shipIn.bowImmersion = bowImmersion;
      // the whole contact set, typed structurally so src/audio imports nothing
      // from sea-physics. Drives hull working (creak) and the slam trigger —
      // arrays are reused per tick, audio reads them inside update() only.
      shipIn.contact = contact;
      // the SAME scalar updateRig uses, so the haul sound and the cloth move
      // together by construction rather than by coincidence
      shipIn.sailDrop = sailDrop;
      bowWorld[0] = bow.x;
      bowWorld[1] = bow.y;
      bowWorld[2] = bow.z;
    },
  };
}
