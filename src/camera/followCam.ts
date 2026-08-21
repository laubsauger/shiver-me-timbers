/**
 * FollowCam — chase camera for the player ship (T10) plus the detached
 * free/fly camera used for visual acceptance (§V22). Render-side: MAY use
 * three.js (§V.3 — reads SimState, never writes it). All pure math lives in
 * camMath.ts; all tunables in params/camera.ts (§V.16).
 *
 * Modes (C toggles follow ↔ free):
 *  - follow: orbit angles are stored as an OFFSET from the ship's stern
 *    heading, so a held angle persists forever and only swings with the
 *    ship's turns. It never re-centers to a "default framing" on its own.
 *  - orbit: world-absolute angles, no heading coupling at all.
 *  - free: fully detached fly camera (see freeCam.ts) — holds whatever
 *    pose the user parks it at, may go far below the surface.
 *  - helm: the captain's eye behind the wheel.
 *  - station: one of the numbered shipboard vantages (camStations.ts) — the
 *    gun, the bow, the taffrail, the masthead.
 *
 * HELM AND STATION ARE ONE MODEL, deliberately: the eye is rigidly parented to
 * the deck so it inherits heel, pitch and heave for free, and NOTHING about
 * the held pose is smoothed. Damping the position would slide the observer
 * around his own deck; damping the aim would make the horizon lag the roll.
 * They differ only in where the anchor comes from, which is why they share
 * `deckStation()` / `applyDeckPose()` below rather than being written twice.
 *
 * On top of the modes sits the debug vantage (setDebugPose, debugPose.ts):
 * an exact pose that outranks all of them, for visual verification.
 *
 * Mouse drag = look/orbit, wheel = zoom radius (follow/orbit) or fly speed
 * (free). Mode switches blend position AND look target so neither cut is a
 * jump. Bindings live in camInput.ts.
 */
import { PerspectiveCamera, Quaternion, Vector3 } from 'three';
import type { ShipState } from '../state/simState';
import { cameraParams } from '../params/camera';
import { FreeCam } from './freeCam';
import { attachCamInput } from './camInput';
import { DebugPose, readVec3, type Vec3Like } from './debugPose';
import { STATION_IDS, type StationId, type StationSource } from './camStations';
import {
  clamp,
  dampFactor,
  enforceMinHeight,
  sphericalOffset,
  stepFollowYaw,
  wrapAngle,
  yawPitchFromDirection,
} from './camMath';

export type CamMode = 'follow' | 'orbit' | 'free' | 'helm' | 'station' | 'fp';
/** a WORLD eye pose supplied from outside — the first-person walker (§T.94) */
export type PoseSource = () => { position: Vector3; quaternion: Quaternion };
export type HeightFn = (x: number, z: number) => number;
export type { Vec3Like } from './debugPose';
export type { StationId } from './camStations';

/**
 * Distance the deck-mode aim point is carried out in front of the lens while a
 * move is easing, m. NOT a feel tunable and deliberately not in params: it
 * cancels at both ends of the move (only the DIRECTION survives into the
 * rigid pose), and all it does in between is keep the two endpoints of the
 * lerp at a matched radius so interpolating the POINTS is a fair stand-in for
 * interpolating the angles. Far enough that a 60 m arrival does not swing the
 * aim through the ship.
 */
const DECK_AIM_DISTANCE = 200;

/** ease curve for a deck arrival: zero velocity at BOTH ends, so the handover
 *  to the rigid pose has no kink and the departure has no lurch */
function smoothstep(t: number): number {
  const x = clamp(t, 0, 1);
  return x * x * (3 - 2 * x);
}

const WORLD_UP = new Vector3(0, 1, 0);

export class FollowCam {
  private yaw = 0;
  private pitch = 0.45;
  /** orbit yaw relative to the ship's stern heading — the thing that persists */
  private yawOffset = 0;
  private radius = cameraParams.radius;
  private mode: CamMode = 'follow';
  private dragging = false;
  private smoothed = new Vector3();
  private initialized = false;
  private lookTarget = new Vector3();
  private lookSmoothed = new Vector3();
  private tmp = new Vector3();
  private free = new FreeCam();
  /** seconds left of the softened post-mode-switch blend */
  private blend = 0;
  /** last frame's pivot, so a mode switch can re-anchor on the ship */
  private lastPivot = new Vector3();
  /** debug vantage: pinned pose that outranks all modes (§V22) */
  private pin = new DebugPose();
  /**
   * Helm POV, all SHIP-LOCAL. The anchor is the wheel's own socket, handed in
   * from main.ts rather than hardcoded here, so the eye tracks the model if
   * the sterncastle moves. Free-look angles are their own pair, NOT the orbit
   * yaw/pitch: stepping to the helm and back must not disturb the chase
   * framing the shot was set up with.
   */
  private helmAnchor = new Vector3(0, 6.2, -13);
  private helmYaw = 0;
  private helmPitch = 0;
  private helmQuat = new Quaternion();
  /** where the numbered stations ARE — handed in from main.ts (camStations.ts) */
  private stations: StationSource | null = null;
  private station: StationId = STATION_IDS[0];
  /**
   * Per-station look offset, kept SEPARATELY per station and never reset.
   * Cycling 1→2→1 has to come back to the framing you left, or every visit
   * costs the shot its setup again. (The helm deliberately does NOT do this —
   * see setMode: H means "dead ahead over the bow", every time.)
   */
  private stationLook: Record<StationId, { yaw: number; pitch: number }> = {
    gun: { yaw: 0, pitch: 0 },
    bow: { yaw: 0, pitch: 0 },
    stern: { yaw: 0, pitch: 0 },
    nest: { yaw: 0, pitch: 0 },
  };
  /** stations this hull cannot offer, already reported once (§V.62) */
  private warnedStations = new Set<StationId>();
  /** how long the CURRENT blend was given, s — `blend` counts down from it */
  private blendSpan = 0;
  /**
   * true between "a deck mode was entered" and the first frame that can
   * measure the distance to it. The move's duration is distance-scaled, and
   * the distance needs the ship's live pose, which setMode() does not have.
   */
  private deckArm = false;
  /** camera.up at the instant a deck mode was left, so the roll eases out */
  private exitUp = new Vector3();
  private deckEye = new Vector3();
  private deckWorld = new Vector3();
  private deckAim = new Vector3();
  private deckUp = new Vector3();
  /** 'fp' mode's pose — the lens is a puppet of the walker, no orbit, no smoothing */
  private poseSource: PoseSource | null = null;
  private detach: () => void;

  constructor(
    private camera: PerspectiveCamera,
    domElement: HTMLElement,
  ) {
    this.detach = attachCamInput(domElement, {
      isFree: () => this.mode === 'free',
      toggleFree: () => this.setMode(this.mode === 'free' ? 'follow' : 'free'),
      toggleHelm: () => this.setMode(this.mode === 'helm' ? 'follow' : 'helm'),
      station: (index) => {
        const id = STATION_IDS[index];
        if (id !== undefined) this.setStation(id);
      },
      setDragging: (d) => {
        this.dragging = d;
      },
      drag: (dx, dy) => {
        if (!this.dragging || this.mode === 'fp') return; // fp: pointer lock owns the mouse
        const p = cameraParams;
        if (this.mode === 'free') {
          this.free.look(dx, dy);
          return;
        }
        if (this.mode === 'helm') {
          // free-look about the ship's OWN heading, so the view stays put
          // relative to the deck as she yaws instead of swinging with her
          this.helmYaw = clamp(
            this.helmYaw - dx * p.freeLookSpeed,
            -p.helmYawLimit,
            p.helmYawLimit,
          );
          this.helmPitch = clamp(
            this.helmPitch - dy * p.freeLookSpeed,
            -p.freePitchLimit,
            p.freePitchLimit,
          );
          return;
        }
        if (this.mode === 'station') {
          // same gesture, same frame as the helm — the offset is from the
          // STATION's own bearing (down the bore, over the bow, …), so a gun
          // that is re-laid takes the framing with it
          const look = this.stationLook[this.station];
          look.yaw = clamp(
            look.yaw - dx * p.freeLookSpeed,
            -p.stationYawLimit,
            p.stationYawLimit,
          );
          look.pitch = clamp(
            look.pitch - dy * p.freeLookSpeed,
            -p.freePitchLimit,
            p.freePitchLimit,
          );
          return;
        }
        this.yaw = wrapAngle(this.yaw - dx * p.orbitSpeed);
        this.pitch = clamp(this.pitch + dy * p.orbitSpeed, p.pitchMin, p.pitchMax);
      },
      wheel: (deltaY) => {
        const p = cameraParams;
        if (this.mode === 'fp') return;
        if (this.mode === 'free') {
          this.free.adjustSpeed(deltaY);
          return;
        }
        this.radius = clamp(this.radius * Math.exp(deltaY * p.zoomSpeed), p.minRadius, p.maxRadius);
      },
      flyKey: (code, down) => {
        if (down) this.free.keyDown(code);
        else this.free.keyUp(code);
      },
      blur: () => this.free.clearKeys(),
    });
  }

  getMode(): CamMode {
    return this.mode;
  }

  isFree(): boolean {
    return this.mode === 'free';
  }

  isDebugPinned(): boolean {
    return this.pin.pinned;
  }

  /**
   * Park the lens at an exact world pose and HOLD it there — the vantage
   * outranks every mode, and re-asserts itself on every update(), so a
   * screenshot's forced rAF frames cannot walk it off. This is the §V22
   * verification instrument: "put the camera somewhere specific and look".
   *
   *   __game.followCam.setDebugPose([12, 3, -40], [0, 4, 0])
   *
   * `target` omitted keeps the current aim. Released by clearDebugPose()
   * or by the C key (an explicit "I want to fly" gesture).
   */
  setDebugPose(position: Vec3Like, target?: Vec3Like): void {
    this.pin.set(this.camera, position, target, this.tmp);
  }

  /**
   * CUT, don't chase. The chase position is exponentially damped toward the
   * ship, which is exactly right when she is sailing and exactly wrong when she
   * has been teleported: the camera would fly the whole kilometre at
   * `posHalfLife`, arriving seconds later having flown through the island on
   * the way. Dropping `initialized` makes the next update() seat the lens at
   * its desired pose in one frame; clearing `blend` stops a mode-switch ramp
   * from re-softening it.
   *
   * Deliberately NOT wired into the mode machinery — teleporting is not a mode
   * change, and setMode() already has its own (correct) glide behaviour.
   */
  snap(): void {
    this.initialized = false;
    this.blend = 0;
  }

  /**
   * Ship-LOCAL position of the helm (the wheel's own socket). main.ts resolves
   * it from the assembly at boot so this file never has to know the galleon's
   * dimensions — and so a change to the sterncastle moves the captain's eye
   * with it instead of leaving him standing in mid-air.
   */
  setHelmAnchor(local: Vec3Like): void {
    readVec3(local, this.helmAnchor);
  }

  /**
   * Hand over the numbered shipboard vantages. main.ts builds them from the
   * live assembly + the player's gun lay (camStations.ts) so this file never
   * has to know a socket name; without it the number row is inert and says so
   * once per station rather than moving the lens somewhere invented.
   */
  setStations(stations: StationSource | null): void {
    this.stations = stations;
  }

  /** which station the lens is at (meaningful only in 'station' mode) */
  getStation(): StationId {
    return this.station;
  }

  /**
   * Go to a numbered station — or, if already at it, come back to the chase.
   * Every camera key in this project toggles (C, H); a station key that only
   * ever went one way would strand the lens on the deck.
   */
  setStation(id: StationId): void {
    if (this.mode === 'station' && this.station === id) {
      this.setMode('follow');
      return;
    }
    const wasStation = this.mode === 'station';
    this.station = id;
    if (wasStation) {
      // station → station is not a mode change, so setMode would no-op; the
      // arrival is the SAME eased move either way
      this.armDeckEntry();
    } else {
      this.setMode('station');
    }
  }

  /** Release the pin. The camera does NOT jump: free mode adopts the
   *  parked pose as its own, follow mode glides back to the chase. */
  clearDebugPose(): void {
    if (!this.pin.pinned) return;
    this.pin.clear();
    if (this.mode === 'free') {
      this.free.seedFrom(this.camera, this.tmp);
    } else if (this.mode === 'helm' || this.mode === 'station') {
      // a deck mode's pose is rigid, so it cannot "glide back" through the
      // chase machinery — re-run the arrival instead, from the pinned pose
      this.armDeckEntry();
    } else {
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed.copy(this.pin.target);
      this.initialized = true;
      this.blend = cameraParams.modeSwitchTime;
      this.blendSpan = cameraParams.modeSwitchTime;
    }
  }

  /**
   * Hand the lens to the first-person walker (§T.94). Mode 'fp' reads this
   * every frame and applies it verbatim — the walker already integrates in
   * the ship frame and rides the deck, so any damping here would be the
   * observer sliding on his own planks. Without a source, 'fp' falls back to
   * the chase rather than freezing.
   */
  setPoseSource(source: PoseSource | null): void {
    this.poseSource = source;
  }

  setMode(mode: CamMode): void {
    if (mode === this.mode) return;
    const p = cameraParams;
    // switching modes is an explicit "give me the camera back" gesture
    this.clearDebugPose();
    const toDeck = mode === 'helm' || mode === 'station';
    // leaving the walker glides back like leaving a deck station
    const fromDeck = this.mode === 'helm' || this.mode === 'station' || this.mode === 'fp';
    if (mode === 'helm') {
      // Angles reset so H always lands looking dead ahead over the bow. NOT
      // true of the numbered stations, which keep their own offsets — the helm
      // is a POV of a man at a wheel, a station is a camera you set up.
      this.helmYaw = 0;
      this.helmPitch = 0;
    }
    if (toDeck) {
      /**
       * ARRIVING AT THE HELM USED TO BE AN INSTANT CUT, ON PURPOSE. The
       * original note read: "an INSTANT cut, deliberately — 'POV the captain
       * in an instant' is the whole point, and easing a 30 m move would read
       * as a swoop, not a cut."
       *
       * REVERSED at the user's explicit request (2026-08-19, recording work):
       * "make sure that also has a camera transition, as we have going from
       * free-flying to follow cam, so that it's not stressingly abrupt but
       * actually the camera moves there, so it becomes readable."
       *
       * The original objection was real and is answered rather than ignored,
       * in two ways: the duration is DISTANCE-SCALED (`stationEaseSpeed`), so
       * a short hop is a short move instead of a leisurely swoop over 4 m; and
       * past `stationCutDistance` it goes back to being a cut, because easing
       * a kilometre — which the free camera can be — is a smear, not a move.
       * Both are params (§V.16): if the swoop reads badly at 30 m, dial
       * `stationEaseSpeed` up or `stationCutDistance` down, no code change.
       */
      this.armDeckEntry();
    } else if (fromDeck) {
      // leaving a deck station glides: start the chase from where the eye
      // actually is, or the camera teleports astern on the first frame
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed.copy(this.lastPivot);
      // ...and the ROLL eases out too. The deck lens is heeled with the ship;
      // snapping camera.up back to world-vertical on the first chase frame
      // pops the horizon by the heel angle, which is the most visible cut
      // there is in a shot that is about the sea.
      this.exitUp.copy(this.camera.up);
      this.deckArm = false;
      this.initialized = true;
      this.blend = p.modeSwitchTime;
      this.blendSpan = p.modeSwitchTime;
    }
    if (mode === 'free') {
      // world-up first: leaving a HEELED deck mode straight into free flight
      // used to carry the deck's up-vector with it, and free mode never resets
      // it, so the fly camera stayed rolled for the rest of the session
      this.camera.up.set(0, 1, 0);
      // adopt the live pose: entering free mode is a cut with zero motion
      this.free.seedFrom(this.camera, this.tmp);
    } else if (this.mode === 'free' && !toDeck) {
      // free mode never touched yaw offset / pitch / radius, so leaving it
      // restores the framing you had before the excursion; only the START
      // of the chase moves to the lens, making the return a glide not a cut
      const dist = this.camera.position.distanceTo(this.lastPivot);
      this.smoothed.copy(this.camera.position);
      this.lookSmoothed
        .copy(this.camera.position)
        .addScaledVector(this.camera.getWorldDirection(this.tmp), Math.max(dist, 1));
      this.initialized = true;
      this.blend = p.modeSwitchTime;
      this.blendSpan = p.modeSwitchTime;
    }
    this.mode = mode;
  }

  /**
   * Park the ease's FROM-pose on the buffers the chase blend already uses, and
   * arm the first deck frame to measure the distance and set the duration.
   * Same two vectors, same `blend` countdown — one transition system, not two.
   */
  private armDeckEntry(): void {
    this.smoothed.copy(this.camera.position);
    this.lookSmoothed
      .copy(this.camera.position)
      .addScaledVector(this.camera.getWorldDirection(this.tmp), DECK_AIM_DISTANCE);
    this.deckArm = true;
    this.blend = 0;
    this.blendSpan = 0;
  }

  /**
   * The active deck-parented vantage, ALL SHIP-LOCAL: where the eye sits and
   * which way it looks. One function for the helm and for every station,
   * because they are one model — the only difference is where the anchor and
   * the base bearing come from.
   *
   * Returns null when the hull cannot offer the station, which is a real
   * outcome (a brigantine has no crow's nest) and is reported once rather than
   * swallowed: a number key that silently does nothing is §V.62's whole
   * family, and it reads exactly like a broken binding.
   */
  private deckStation(): { eye: Vector3; yaw: number; pitch: number } | null {
    const p = cameraParams;
    if (this.mode === 'helm') {
      this.deckEye.set(
        this.helmAnchor.x,
        this.helmAnchor.y + p.helmEyeHeight,
        this.helmAnchor.z - p.helmAft,
      );
      return { eye: this.deckEye, yaw: this.helmYaw, pitch: this.helmPitch };
    }
    const pose = this.stations?.pose(this.station) ?? null;
    if (pose === null) {
      if (!this.warnedStations.has(this.station)) {
        this.warnedStations.add(this.station);
        console.warn(`[camera] no '${this.station}' station on this ship — key ignored`);
      }
      return null;
    }
    this.deckEye.set(pose.eye[0], pose.eye[1], pose.eye[2]);
    // the station's own bearing, in the SAME yaw/pitch convention the helm
    // uses (sphericalOffset: yaw 0 = ship-forward, positive pitch = up), so
    // the free-look offset composes with it instead of replacing it
    const [baseYaw, basePitch] = yawPitchFromDirection(
      pose.forward[0],
      pose.forward[1],
      pose.forward[2],
    );
    const look = this.stationLook[this.station];
    return {
      eye: this.deckEye,
      yaw: baseYaw + look.yaw,
      pitch: clamp(basePitch + look.pitch, -p.freePitchLimit, p.freePitchLimit),
    };
  }

  /**
   * Write a deck-parented pose onto the lens — rigidly once arrived, eased
   * while a move is running.
   *
   * WHY THE MOVE IS AN EASED LERP AND NOT THE CHASE'S EXPONENTIAL DAMP. The
   * chase target is always being chased, so a half-life that never quite
   * arrives is exactly right there. A station has to ARRIVE: the moment the
   * blend expires the pose becomes rigid, and any residual gap at that instant
   * is a visible pop of precisely the size the damp had left over. `smoothstep`
   * reaches 1 exactly, with zero velocity at both ends, so entry and handover
   * are both continuous. It reuses this class's one `blend` countdown and the
   * same two vectors the chase blend uses — one transition system, not two.
   */
  private applyDeckPose(
    ship: ShipState,
    q: ShipState['quaternion'],
    eyeLocal: Vector3,
    yaw: number,
    pitch: number,
    dt: number,
  ): void {
    const p = cameraParams;
    this.helmQuat.set(q[0], q[1], q[2], q[3]);
    this.deckWorld.copy(eyeLocal).applyQuaternion(this.helmQuat);
    this.deckWorld.x += ship.position[0];
    this.deckWorld.y += ship.position[1];
    this.deckWorld.z += ship.position[2];
    // aim in the SHIP's frame too, so a look to starboard stays to starboard
    // through a tack rather than being unwound by her turn
    const off = sphericalOffset(yaw, pitch, DECK_AIM_DISTANCE);
    this.deckAim
      .set(off[0], off[1], off[2])
      .applyQuaternion(this.helmQuat)
      .add(this.deckWorld);
    this.deckUp.copy(WORLD_UP).applyQuaternion(this.helmQuat);

    if (this.deckArm) {
      // FIRST frame of the arrival: now — and only now — the rigid target is
      // known, so the distance is measurable and the move can be given a
      // duration proportional to it (see setMode for why it is not constant)
      this.deckArm = false;
      const gap = this.smoothed.distanceTo(this.deckWorld);
      this.blendSpan =
        gap > p.stationCutDistance
          ? 0 // too far to read as a move: cut, as entering the helm always did
          : clamp(gap / Math.max(p.stationEaseSpeed, 1e-6), p.stationEaseMin, p.stationEaseMax);
      this.blend = this.blendSpan;
    }

    if (this.blend > 0) {
      const s = smoothstep(1 - this.blend / Math.max(this.blendSpan, 1e-6));
      this.blend = Math.max(0, this.blend - dt);
      this.camera.position.copy(this.smoothed).lerp(this.deckWorld, s);
      this.tmp.copy(this.lookSmoothed).lerp(this.deckAim, s);
      this.camera.up.copy(WORLD_UP).lerp(this.deckUp, s);
      if (this.camera.up.lengthSq() < 1e-8) this.camera.up.copy(this.deckUp);
      else this.camera.up.normalize();
      this.camera.lookAt(this.tmp);
      return;
    }

    this.camera.position.copy(this.deckWorld);
    this.camera.up.copy(this.deckUp);
    this.camera.lookAt(this.deckAim);
  }

  update(ship: ShipState, dt: number, heightFn?: HeightFn): void {
    const p = cameraParams;
    if (this.camera.fov !== p.fov) {
      this.camera.fov = p.fov;
      this.camera.updateProjectionMatrix();
    }
    const pivotX = ship.position[0];
    const pivotY = ship.position[1] + p.pivotHeight;
    const pivotZ = ship.position[2];
    const q = ship.quaternion;
    // ship forward yaw from quaternion (forward = local +z)
    const fx = 2 * (q[0] * q[2] + q[3] * q[1]);
    const fz = 1 - 2 * (q[0] * q[0] + q[1] * q[1]);
    const behind = Math.atan2(fx, fz) + Math.PI; // camera sits astern
    // cached so a toggle back out of free mode can re-anchor on the ship
    this.lastPivot.set(pivotX, pivotY, pivotZ);

    // the debug vantage outranks every mode and is re-asserted every frame
    if (this.pin.pinned) {
      this.pin.apply(this.camera);
      return;
    }

    if (this.mode === 'fp') {
      if (this.poseSource !== null) {
        const pose = this.poseSource();
        this.camera.up.copy(WORLD_UP);
        this.camera.position.copy(pose.position);
        this.camera.quaternion.copy(pose.quaternion);
        return;
      }
      this.mode = 'follow';
      this.initialized = false;
      this.blend = 0;
    }

    if (this.mode === 'free') {
      // lens moved from outside (console, another system)? adopt, don't
      // stomp — fighting an external pose breaks free mode's "holds what
      // you left it at" contract just as surely as drifting does
      this.free.adoptExternal(this.camera, this.tmp);
      this.free.update(dt);
      this.free.applyTo(this.camera, this.tmp);
      return;
    }

    // HELM / STATION: the eye is rigidly parented to the deck, so it inherits
    // every bit of heel, pitch and heave for free — that IS the shot. No
    // smoothing at all once it has arrived: damping the position would slide
    // the observer around his own deck, and damping the aim would make the
    // horizon lag the roll.
    if (this.mode === 'helm' || this.mode === 'station') {
      const st = this.deckStation();
      if (st !== null) {
        this.applyDeckPose(ship, q, st.eye, st.yaw, st.pitch, dt);
        return;
      }
      // this hull has no such station (already reported once). Fall through to
      // the chase rather than holding a pose nobody can name.
      this.mode = 'follow';
      this.initialized = false;
      this.blend = 0;
    }

    // yaw is an OFFSET from the stern heading (see stepFollowYaw): swings
    // with the ship's turns, never crawls back to a default framing
    if (this.mode === 'follow') {
      [this.yaw, this.yawOffset] = stepFollowYaw(
        this.yaw,
        this.yawOffset,
        behind,
        this.dragging,
        p.yawFollowHalfLife,
        dt,
      );
    }

    const off = sphericalOffset(this.yaw, this.pitch, this.radius);
    const desiredX = pivotX + off[0];
    const desiredY = pivotY + off[1];
    const desiredZ = pivotZ + off[2];

    // after a mode switch, chase on a softer half-life so returning from a
    // kilometre out is a glide; RAMP it back to normal rather than switch
    // at the end, or the camera visibly accelerates halfway home
    const blending = this.blend > 0;
    const t = blending ? clamp(1 - this.blend / Math.max(this.blendSpan, 1e-6), 0, 1) : 1;
    let posHalfLife = p.posHalfLife;
    if (blending) {
      posHalfLife = p.modeSwitchHalfLife + (p.posHalfLife - p.modeSwitchHalfLife) * t;
      this.blend = Math.max(0, this.blend - dt);
    }
    // every mode but the deck ones is world-up — but roll OUT of a heeled deck
    // pose over the same ramp rather than snapping the horizon level on frame 1
    if (blending && this.exitUp.lengthSq() > 1e-12) {
      this.camera.up.copy(this.exitUp).lerp(WORLD_UP, smoothstep(t));
      if (this.camera.up.lengthSq() < 1e-8) this.camera.up.copy(WORLD_UP);
      else this.camera.up.normalize();
    } else {
      this.camera.up.copy(WORLD_UP);
      this.exitUp.set(0, 0, 0);
    }

    if (!this.initialized) {
      this.smoothed.set(desiredX, desiredY, desiredZ);
      this.initialized = true;
    } else {
      const k = dampFactor(posHalfLife, dt);
      this.smoothed.x += (desiredX - this.smoothed.x) * k;
      this.smoothed.y += (desiredY - this.smoothed.y) * k;
      this.smoothed.z += (desiredZ - this.smoothed.z) * k;
    }
    // clamp only when diving is disabled — the underwater mode (T29) owns
    // the below-surface experience and we need free dives for debugging
    const y = p.allowUnderwater
      ? this.smoothed.y
      : enforceMinHeight(
          this.smoothed.y,
          this.smoothed.x,
          this.smoothed.z,
          p.minHeightAboveWater,
          heightFn,
        );

    this.camera.position.set(this.smoothed.x, y, this.smoothed.z);
    this.lookTarget.set(
      pivotX + ship.velocity[0] * p.lookAhead,
      pivotY,
      pivotZ + ship.velocity[2] * p.lookAhead,
    );
    if (blending) {
      // ease the aim too, else the toggle snaps the view round instantly
      const lk = dampFactor(posHalfLife, dt);
      this.lookSmoothed.lerp(this.lookTarget, lk);
      this.camera.lookAt(this.lookSmoothed);
    } else {
      this.lookSmoothed.copy(this.lookTarget);
      this.camera.lookAt(this.lookTarget);
    }
  }

  dispose(): void {
    this.detach();
  }
}
