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
  if (next.frame === 'swim') return stepSwim(next, surface, wx, wz, dt, p);
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
  const [x, y, z] = s.pos;
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
  s.crouch = Boolean(input.crouch) || clearance < standThreshold;
  const speed = s.crouch ? p.crouchSpeed : p.walkSpeed;
  const vx = wx * speed;
  const vz = wz * speed;

  // vertical first, so the horizontal pass knows whether it is a stride or a fall
  let vy = s.vel[1];
  if (s.grounded && input.jump && p.jumpSpeed > 0) {
    vy = p.jumpSpeed;
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

function stepSwim(
  s: PlayerState,
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

  const toWorld = surface.shipToWorld ?? identity;
  for (const bp of surface.boardingPoints ?? []) {
    const w = toWorld(bp);
    if (Math.hypot(w[0] - nx, w[2] - nz) > p.boardReach) continue;
    if (Math.abs(w[1] - ny) > p.boardVertical) continue;
    return {
      frame: 'ship',
      pos: [bp[0], bp[1], bp[2]],
      yaw: wrapAngle(s.yaw - shipYawOf(surface)),
      pitch: s.pitch,
      vel: [0, 0, 0],
      crouch: false,
      grounded: true,
    };
  }
  return s;
}
