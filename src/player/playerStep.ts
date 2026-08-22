/**
 * PURE first-person locomotion core (§T.94). No three.js, no DOM: a function
 * from (state, input, surface, dt) to a new state, so it runs on the fixed sim
 * tick, replays from an input log (§V2) and is tested without a GPU.
 *
 * THE FRAME IS THE POINT (§V73/§V85). Aboard, `pos` is SHIP-LOCAL and the
 * surface is sampled in ship space, so the walker rides every heave, roll and
 * yaw for free and "standing still" is genuinely zero velocity whatever the
 * hull is doing. The world transform is applied OUTSIDE this file, once, to
 * produce the camera pose — and at the two frame transitions (overboard,
 * climbing back), which is the only reason `shipToWorld` is on the surface.
 *
 * Convention: yaw 0 faces frame +z (ship forward), +yaw turns LEFT (toward
 * +x) — the right-handed sense about +y. Pitch + looks up.
 */
import { playerParams, type PlayerParams } from '../params/player';

export type Vec3 = [number, number, number];
export type PlayerFrame = 'ship' | 'world' | 'swim';

export interface PlayerState {
  frame: PlayerFrame;
  /** FEET position. Ship-local while `frame === 'ship'`, world otherwise. */
  pos: Vec3;
  /** radians about +y, 0 = frame +z; relative to the ship while aboard */
  yaw: number;
  /** radians, + = up */
  pitch: number;
  /** frame-local m/s */
  vel: Vec3;
  crouch: boolean;
  grounded: boolean;
}

export interface PlayerInput {
  /** -1..1, + = forward (along yaw) */
  forward: number;
  /** -1..1, + = to the RIGHT */
  strafe: number;
  /** EDGE: true on the tick the jump key went down */
  jump: boolean;
  /** held */
  crouch: boolean;
  /** radians to add this tick (already scaled by sensitivity, signed) */
  yawDelta: number;
  pitchDelta: number;
}

/**
 * What the walker stands on, in the coordinates of the CURRENT frame.
 * `heightAt` returning null means "no ground here at all" — outboard of the
 * deck mask — and walking there puts the player in the water.
 */
export interface WalkSurface {
  heightAt(x: number, z: number): number | null;
  solidAt(x: number, z: number): boolean;
  /** underside of whatever is overhead (cabin roof), or null for open sky */
  ceilingAt?(x: number, z: number): number | null;
  /** WORLD sea-surface height; needed to swim and to notice a submerged deck */
  waterAt?(x: number, z: number): number;
  /** SHIP-LOCAL foot-rail points a swimmer can climb at */
  boardingPoints?: readonly Vec3[];
  /** the live ship transform; identity when absent */
  shipToWorld?(p: Vec3): Vec3;
  /** walking-speed multiplier here (terrain slope, §T.100); 1 when absent */
  speedAt?(x: number, z: number): number;
}

export function neutralPlayerInput(): PlayerInput {
  return { forward: 0, strafe: 0, jump: false, crouch: false, yawDelta: 0, pitchDelta: 0 };
}

export function createPlayerState(pos: Vec3 = [0, 0, 0], yaw = 0): PlayerState {
  return { frame: 'ship', pos: [pos[0], pos[1], pos[2]], yaw, pitch: 0, vel: [0, 0, 0], crouch: false, grounded: false };
}

/** a non-finite number is a bug upstream; it must not become NaN state */
function num(v: number, fallback = 0): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function wrapAngle(a: number): number {
  const twoPi = Math.PI * 2;
  a = a % twoPi;
  if (a > Math.PI) a -= twoPi;
  else if (a < -Math.PI) a += twoPi;
  return a;
}

export function capsuleHeight(crouch: boolean, p: PlayerParams = playerParams): number {
  return crouch ? p.crouchHeight : p.standHeight;
}

export function eyeHeight(crouch: boolean, p: PlayerParams = playerParams): number {
  return capsuleHeight(crouch, p) - p.eyeDrop;
}

/**
 * §T.135 — LAUNCH SPEED FOR THE AUTHORED APEX, v = √(2·g·h).
 *
 * `jumpHeight` is the knob because the height is the design decision; the
 * speed is arithmetic. Deriving it here rather than storing it is the §V62
 * shape in reverse: move `gravity` on the panel and the jump keeps the apex
 * it was authored at, instead of silently becoming a different jump.
 *
 * WHY 0.5 m (params/player.ts). It is a real adult's standing vertical, and
 * it is 8× the 1.2 m/s the walker shipped with — a 7 cm twitch that read as
 * "Space is not bound" (§T.135's whole complaint). What it CHANGES about the
 * raft, measured against the field rather than guessed:
 *
 *  · the walking deck is 0.63 m over the sea and the cabin FLOOR 0.30 m over
 *    that, with the eave 1.20 m and the ridge 1.45 m over the floor. The
 *    HIGHEST thing the walk can stand on anywhere aboard is 1.08 m (the
 *    cabin's box layer), so apex + `stepUp` tops out at 1.98 against an eave
 *    at 2.13. §T.141's tuck spends that margin — a jump-crouch puts the feet
 *    1.1 m up, 2.58 with a stride on top — and the roof is STILL unreachable,
 *    for the reason in the next bullet and not for the arithmetic.
 *  · and it could not at ANY height: the whole cabin envelope is `solid` in
 *    the deck field, and `admits()` below refuses a solid cell whatever the
 *    walker's altitude. The roof-trap §T.135 warns about is structurally
 *    impossible here, and `tests/raftDeckField.test.ts` proves it by flooding
 *    the real field — every cell a jump can land on is one the WALK already
 *    reaches.
 *  · airtime is 2√(2h/g) = 0.64 s, which is 1.02 m of travel at `walkSpeed`.
 *    The starboard lane is one capsule wide (0.6 m, §T.115), so a jump ALONG
 *    the lane is free and a jump ACROSS it goes in the water — which, as of
 *    this task, is a mistake you swim out of rather than a dead end.
 */
export function jumpSpeed(p: PlayerParams = playerParams): number {
  const h = num(p.jumpHeight);
  const g = num(p.gravity);
  return h > 0 && g > 0 ? Math.sqrt(2 * g * h) : 0;
}

/** yaw of the ship's +z in the world, derived from the transform alone */
export function shipYawOf(surface: WalkSurface): number {
  if (surface.shipToWorld === undefined) return 0;
  const o = surface.shipToWorld([0, 0, 0]);
  const f = surface.shipToWorld([0, 0, 1]);
  return Math.atan2(f[0] - o[0], f[2] - o[2]);
}

const identity = (p: Vec3): Vec3 => [p[0], p[1], p[2]];

export function stepPlayer(
  state: PlayerState,
  input: PlayerInput,
  surface: WalkSurface,
  dt: number,
  p: PlayerParams = playerParams,
): PlayerState {
  dt = num(dt);
  if (dt <= 0) return { ...state, pos: [...state.pos], vel: [...state.vel] };
  const pitchLimit = (p.pitchLimitDeg * Math.PI) / 180;
  const yaw = wrapAngle(num(state.yaw) + num(input.yawDelta));
  const pitch = clamp(num(state.pitch) + num(input.pitchDelta), -pitchLimit, pitchLimit);
  const fwd = clamp(num(input.forward), -1, 1);
  const strafe = clamp(num(input.strafe), -1, 1);
  // facing +z, the right hand points to -x (see header)
  let wx = Math.sin(yaw) * fwd - Math.cos(yaw) * strafe;
  let wz = Math.cos(yaw) * fwd + Math.sin(yaw) * strafe;
  const wl = Math.hypot(wx, wz);
  if (wl > 1) {
    wx /= wl;
    wz /= wl;
  }
  const next: PlayerState = {
    frame: state.frame,
    pos: [num(state.pos[0]), num(state.pos[1]), num(state.pos[2])],
    yaw,
    pitch,
    vel: [0, num(state.vel[1]), 0],
    crouch: Boolean(state.crouch),
    grounded: Boolean(state.grounded),
  };
  if (next.frame === 'swim') return stepSwim(next, input, surface, wx, wz, dt, p);
  return stepWalk(next, input, surface, wx, wz, dt, p);
}

function stepWalk(
  s: PlayerState,
  input: PlayerInput,
  surface: WalkSurface,
  wx: number,
  wz: number,
  dt: number,
  p: PlayerParams,
): PlayerState {
  const x = s.pos[0];
  const z = s.pos[2];
  let y = s.pos[1]; // §T.141: a mid-air crouch moves the FEET, so this moves
  const toWorld = surface.shipToWorld ?? identity;
  const ground = surface.heightAt(x, z);
  if (ground === null) return goOverboard(s, surface);
  if (surface.waterAt !== undefined) {
    // a deck that has gone under is water, whatever its planks say
    const w = toWorld([x, y, z]);
    if (w[1] < surface.waterAt(w[0], w[2]) - p.crouchHeight) return goOverboard(s, surface);
  }

  // auto-crouch by head clearance, with hysteresis so a sill does not flicker
  const ceiling = surface.ceilingAt?.(x, z) ?? null;
  const clearance = ceiling === null ? Infinity : ceiling - ground;
  const standThreshold = s.crouch ? p.standHeight + p.crouchHysteresis : p.standHeight;
  const wasCrouch = s.crouch;
  // …and the auto half of it is a fact about the room he is STANDING in:
  // `clearance` is the headroom of a man on this cell, which an airborne one
  // is not. Gating it on `grounded` is what keeps §T.141's tuck below a thing
  // the player ASKED for — otherwise flying under an eave would tuck his legs,
  // and hand him the tuck's extra reach, with no key pressed (§V85 unchanged
  // on the ground, which is the only place the auto-crouch ever meant
  // anything: the cabin, the sill, the §T.115 lanes).
  s.crouch = Boolean(input.crouch) || (s.grounded && clearance < standThreshold);

  /**
   * §T.141 — A CROUCH MOVES WHICHEVER END OF THE BODY IS FREE.
   *
   * `pos` is the FEET and the eye is `pos.y + eyeHeight(crouch)`, so a crouch
   * is a head-down move by construction. Standing on a deck that is exactly
   * right: the feet are held by the planks and the head is the end that can
   * go anywhere. IN THE AIR IT IS BACKWARDS, and that was §T.141's report —
   * "it pulls the upper body down instead of the lower body up". Nothing
   * holds a jumper's feet; the head is a ballistic particle travelling
   * through the body's own arc and no leg can move it. Tucking raises the
   * FEET; extending lowers them again.
   *
   * So on any crouch transition while airborne the feet take the whole delta
   * and the eye keeps its parabola to the bit. Note what this leaves alone:
   * the capsule TOP is `pos.y + capsuleHeight(crouch)`, and raising y by
   * exactly the amount capsuleHeight falls leaves it untouched — the tucked
   * capsule is a strict SUBSET of the standing one at the same instant, so a
   * tuck can never push the head into something the standing jump cleared.
   * All it buys is reach under the feet, which is the point: apex + `stepUp`
   * becomes apex + delta + `stepUp`, and that is the lip a jump-crouch clears
   * and a plain jump does not.
   *
   * THE RELEASE MID-AIR IS A HOLD, NOT A PUSH-OUT. If the legs cannot extend
   * — the tucked feet are over a surface less than a delta below them, i.e.
   * inside the very ledge he tucked to clear — the tuck is KEPT for this
   * tick and retried on the next. A push-out would have to pick a direction
   * and would move the EYE, which is the exact pop this task exists to
   * remove; holding is a no-op on the eye, is deterministic, and resolves
   * itself either when he clears the ledge or when he lands (landing puts the
   * feet ON the surface, and the stand-up then happens grounded, where the
   * eye moving IS the correct reading).
   */
  if (!s.grounded && s.crouch !== wasCrouch) {
    // never negative: a panel with crouchHeight above standHeight would
    // otherwise drive the feet DOWN on a tuck (§V28 — a knob out of order is
    // a no-op here, not an inverted body)
    const tuck = Math.max(0, num(p.standHeight) - num(p.crouchHeight));
    if (s.crouch) y += tuck;
    else if (y - tuck >= ground) y -= tuck;
    else s.crouch = true; // no room to put the feet down: hold the tuck
  }

  // the crouch speed is a LEG cost — a duck-walk is slow because the legs are
  // carrying the body bent. Mid-air they are carrying nothing, and a tuck that
  // halved his ground speed would fall SHORT of the thing he tucked to clear.
  const speed = (s.crouch && s.grounded ? p.crouchSpeed : p.walkSpeed) * clamp(num(surface.speedAt?.(x, z) ?? 1, 1), 0, 1);
  const vx = wx * speed;
  const vz = wz * speed;

  // vertical first, so the horizontal pass knows whether it is a stride or a fall
  let vy = s.vel[1];
  const launch = jumpSpeed(p);
  // NOT WHILE CROUCHED (§T.135). A jump is the legs straightening, and the
  // only reason the walker is crouched aboard is that §V85's auto-crouch found
  // a ceiling under head height — the cabin's thatch, 0.9 m over the mattress.
  // Launching there drives the head through the roof. Ctrl-crouch in the open
  // is refused by the same rule, which is the conventional reading: stand up
  // first. `s.crouch` is settled a few lines above, so this sees THIS tick's
  // stance and not the last one's.
  if (s.grounded && !s.crouch && input.jump && launch > 0) {
    vy = launch;
    s.grounded = false;
  } else if (!s.grounded) {
    vy -= p.gravity * dt;
  } else {
    vy = 0;
  }

  const tanMax = Math.tan((p.maxSlopeDeg * Math.PI) / 180);
  const ul = Math.hypot(vx, vz);
  const ux = ul > 1e-9 ? vx / ul : 0;
  const uz = ul > 1e-9 ? vz / ul : 0;
  /** can the foot go to (tx,tz) from height `y` — null means no deck there */
  const admits = (tx: number, tz: number): boolean => {
    const h = surface.heightAt(tx, tz);
    if (h === null) return true;
    if (surface.solidAt(tx, tz)) return false;
    const c = surface.ceilingAt?.(tx, tz) ?? null;
    if (c !== null && c - h < p.crouchHeight) return false;
    const rise = h - y;
    if (rise > p.stepUp) return false;
    if (rise > 0 && s.grounded) {
      // a stride onto a rising slope: refuse beyond maxSlope, but a step's
      // flat top reads as 0 and is admitted by `stepUp` above
      const ahead = surface.heightAt(tx + ux * p.slopeProbe, tz + uz * p.slopeProbe);
      if (ahead !== null && (ahead - h) / p.slopeProbe > tanMax) return false;
    }
    return true;
  };
  let nx = x + vx * dt;
  let nz = z + vz * dt;
  if (!admits(nx, nz)) {
    // slide: keep whichever axis is free
    if (admits(nx, z)) nz = z;
    else if (admits(x, nz)) nx = x;
    else {
      nx = x;
      nz = z;
    }
  }
  s.vel[0] = (nx - x) / dt;
  s.vel[2] = (nz - z) / dt;

  const h = surface.heightAt(nx, nz);
  let ny = y;
  if (s.grounded) {
    if (h !== null && h >= y - p.stepUp) {
      ny = h; // the stride follows the deck, up a step or down one
    } else {
      s.grounded = false; // walked off a ledge: fall
      ny = y + vy * dt;
    }
  } else {
    ny = y + vy * dt;
    if (h !== null && ny <= h) {
      ny = h;
      vy = 0;
      s.grounded = true;
    }
  }
  s.pos = [nx, ny, nz];
  s.vel[1] = vy;
  if (h === null) return goOverboard(s, surface);
  return s;
}

function goOverboard(s: PlayerState, surface: WalkSurface): PlayerState {
  const toWorld = surface.shipToWorld ?? identity;
  const w = toWorld(s.pos);
  const shipYaw = shipYawOf(surface);
  return {
    frame: 'swim',
    pos: w,
    yaw: wrapAngle(s.yaw + shipYaw),
    pitch: s.pitch,
    vel: [0, 0, 0],
    crouch: false,
    grounded: false,
  };
}

/**
 * §V85/§B78 — THE CLIMB IS MEASURED FROM THE SEA, NOT FROM THE FEET, and this
 * is the ONE place that measures it (§V95). Three callers ask the same
 * question with different generosity: the passive drift-aboard, §T.135's
 * deliberate haul-out, and the prompt that tells the swimmer the key exists —
 * a second copy of the rule would light a prompt for a climb Space refuses.
 *
 * A swimmer floats with the EYE `swimEyeAbove` over the surface, so the feet
 * hang a whole body below it (−1.35 m on flat water). Measuring a boarding
 * point against the FEET therefore asked the raft's foot-rail — 0.44 m of
 * honest freeboard — to be within `boardVertical` of a point 1.8 m under it,
 * and no point on this raft ever qualified: re-boarding was impossible (R2
 * walk review, §B78-1). What a swimmer actually pulls himself over is the
 * FREEBOARD: how far the rail stands above the water he is in.
 *
 * The sea is sampled AT THE BOARDING POINT (a wave lifts the rail and the
 * swimmer by different amounts); with no `waterAt` it is the flat sea the
 * swimmer is already floating on, so nothing else changes meaning.
 *
 * Returns the SHIP-LOCAL boarding point and its WORLD position — the caller
 * needs the first to stand on and the second to hang a label from.
 */
export function boardingCandidate(
  surface: WalkSurface,
  x: number,
  z: number,
  water: number,
  reach: number,
  vertical: number,
): { local: Vec3; world: Vec3 } | null {
  const toWorld = surface.shipToWorld ?? identity;
  for (const bp of surface.boardingPoints ?? []) {
    const w = toWorld(bp);
    if (Math.hypot(w[0] - x, w[2] - z) > reach) continue;
    const sea = surface.waterAt === undefined ? water : num(surface.waterAt(w[0], w[2]));
    if (Math.abs(w[1] - sea) > vertical) continue;
    return { local: [bp[0], bp[1], bp[2]], world: [w[0], w[1], w[2]] };
  }
  return null;
}

/**
 * Where a HAUL-OUT puts the feet: one `boardStepIn` inboard of the rail he
 * came over, if the deck there is real, not a wall and level with the rail
 * within a stride. Otherwise the rail itself — the same spot the passive
 * route uses, which is why the passive route is not given this step (it is a
 * hand-over-hand crawl onto the rail, not a man throwing himself over it, and
 * §V85's "climbs back aboard AT the rail" pins that).
 */
function haulLanding(surface: WalkSurface, bp: Vec3, p: PlayerParams): Vec3 {
  const d = Math.hypot(bp[0], bp[2]);
  if (!(d > 1e-6) || !(p.boardStepIn > 0)) return bp;
  const tx = bp[0] - (bp[0] / d) * p.boardStepIn;
  const tz = bp[2] - (bp[2] / d) * p.boardStepIn;
  const h = surface.heightAt(tx, tz);
  if (h === null || !Number.isFinite(h)) return bp;
  if (surface.solidAt(tx, tz)) return bp;
  if (Math.abs(h - bp[1]) > p.stepUp) return bp;
  return [tx, h, tz];
}

/** the swimmer's state once he is over the rail, in the ship's frame */
function comeAboard(s: PlayerState, surface: WalkSurface, at: Vec3): PlayerState {
  return {
    frame: 'ship',
    pos: [at[0], at[1], at[2]],
    yaw: wrapAngle(s.yaw - shipYawOf(surface)),
    pitch: s.pitch,
    vel: [0, 0, 0],
    crouch: false,
    grounded: true,
  };
}

function stepSwim(
  s: PlayerState,
  input: PlayerInput,
  surface: WalkSurface,
  wx: number,
  wz: number,
  dt: number,
  p: PlayerParams,
): PlayerState {
  const vx = wx * p.swimSpeed;
  const vz = wz * p.swimSpeed;
  const nx = s.pos[0] + vx * dt;
  const nz = s.pos[2] + vz * dt;
  const water = surface.waterAt === undefined ? 0 : num(surface.waterAt(nx, nz));
  // the eye rides the surface: feet sit eyeHeight below it, eased so chop bobs
  const target = water + p.swimEyeAbove - eyeHeight(false, p);
  const k = 1 - Math.exp(-p.swimBobRate * dt);
  const ny = s.pos[1] + (target - s.pos[1]) * k;
  s.vel = [vx, (ny - s.pos[1]) / dt, vz];
  s.pos = [nx, ny, nz];

  /**
   * §T.135 — SPACE IN THE WATER IS A HAUL-OUT, and it is tried FIRST.
   *
   * The passive board below is the forgiving fallback and stays exactly as it
   * was (§B78: a player who never learns the key must still get back aboard).
   * The lunge is the same rule with the swimmer's own effort behind it — a
   * longer reach and a higher haul — so anything the passive route accepts,
   * this accepts too, and the only difference the player can feel is that it
   * works from further off and lands them on the deck rather than the rail.
   */
  if (input.jump) {
    const lunge = boardingCandidate(surface, nx, nz, water, p.boardLungeReach, p.boardLungeVertical);
    if (lunge !== null) return comeAboard(s, surface, haulLanding(surface, lunge.local, p));
  }
  const drift = boardingCandidate(surface, nx, nz, water, p.boardReach, p.boardVertical);
  if (drift !== null) return comeAboard(s, surface, drift.local);
  return s;
}
