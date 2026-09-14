/**
 * Bow spray emitter (§V6 spray family, §V8 data source): bursts where the
 * hull punches through a wave. Uses its OWN small pool (sprayParams.bowCount)
 * rather than sharing the crest pool: crest spawning is continuous and
 * jacobian-driven while bow bursts are per-ship events — separate pools keep
 * the emitters from starving each other, and a second ship can own its own.
 *
 * CPU side per tick (Rule: code answers — three scalars per emitter, no GPU
 * round-trip): sprayMath.bowEmission returns {rate, sheet, slam} from speed,
 * immersion and the BURIAL RATE (d immersion/dt, from the sampler). Three
 * regimes on one path — a constant cutwater mist whenever the ship is making
 * way, an impact burst on top scaled by how hard the stem just buried, and
 * the SLAM: a forefoot coming down on the sea, which is keyed on the closing
 * speed ALONE (no hull-speed term anywhere in it) and launches water upward
 * by a multiple of that speed, because that is the event the user asked to
 * see and the only one that throws water clear of the surface. A rotating
 * cursor window releases rate·dt dead particles per tick (advanceBurstCursor /
 * inSpawnWindow) so density is rate-bound, not pool-bound.
 * GPU spawn per windowed dead particle: respawn ON THE WATERLINE along the
 * cutwater line (bowSpawnOffset — stem run + outboard flank, not one point),
 * thrown FORWARD past the bow (bowForwardThrow × speed), outboard on that
 * same flank, and up by rise × sheet (CPU mirror: sprayMath.bowLaunchVelocity).
 * `sheet` also rides in velSize.w as the per-particle size multiplier.
 * Physics/render: sprayPool.ts.
 *
 *   createBowSpray() => {
 *     update(renderer, bow: { cutwater?: CutwaterState; // §V8 hullContact —
 *                                                      //   the real emitter
 *                             bowWorldPos: Vector3;    // fallback stem point
 *                             shipVelocity: Vector3;   // world m/s
 *                             immersionDepth: number;  // fallback submersion
 *                             shipForward?: Vector3;   // unit heading
 *                           }): void;
 *     mesh; dispose();
 *   }
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  select,
  uniform,
  uniformArray,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { SIM_DT } from '../core/loop';
import { hash2 } from '../terrain/noise';
import { sprayParams } from '../params/spray';
import { SPRAY_OVER_WATER_ORDER, createSprayPool } from './sprayPool';
import {
  H_BOW_MAG,
  H_BOW_SIDE,
  H_BOW_UP,
  H_SIZE,
  PHI,
  T_BOW_MAG,
  T_BOW_SIDE,
  T_BOW_UP,
  T_SIZE,
  BOW_CONTACT_RISE,
  advanceBurstCursor,
  bowContactEmission,
  bowEmission,
  liftedFluxEmission,
  prioritiseEmitters,
  type BowContactInput,
  type WaterlineSpray,
} from './sprayMath';

/**
 * The cutwater slice of `HullContactResult` from src/sea-physics/hullContact
 * (§V8 — physics owns the sampling, this module only consumes it). Declared
 * structurally rather than imported so the emitter stays engine-agnostic and
 * testable; the field names and units match that module exactly.
 *
 * NOTE `world` is the interpolated crossing point ON THE SURFACE (depth 0 by
 * construction) — NOT a hull point. Spray spawns there directly; adding
 * `depth` to it would lift every sheet a second time.
 */
export interface CutwaterState {
  /** false when the bow is clear of the water — emit nothing */
  inContact: boolean;
  /** world crossing point, already on the surface: [x, y, z] */
  world: readonly number[];
  /** immersion of the forward-most WET slice (m, ≥ 0) — burst intensity */
  depth: number;
  /** burial rate there (m/s, > 0 = driving under) */
  rate: number;
  /** hull half-breadth at the crossing (m) — how wide a sheet to throw */
  halfWidth: number;
}

export interface BowState {
  bowWorldPos: THREE.Vector3;
  shipVelocity: THREE.Vector3;
  /** how far the bow waterline point is submerged this frame (m, ≥ 0) */
  immersionDepth: number;
  /**
   * Live cutwater from createHullContact(...).cutwater (optional only until
   * main.ts wires it). When absent the emitter falls back to the geometric
   * bow point and differences immersion itself — which IS the detaching
   * behaviour the user reported, so supply this.
   */
  cutwater?: CutwaterState;
  /**
   * Unit heading of the hull in world XZ (optional). PREFERRED over the
   * velocity direction: a ship making leeway crabs, and basing the ejection
   * frame on its track then throws spray off at an angle to its own stem
   * (user: "flows in a little bit of a weird angle"). Falls back to the
   * normalised velocity when the caller does not supply it.
   */
  shipForward?: THREE.Vector3;
  /**
   * §T.161 — this vessel's speed scale for the bow ramp; 1 = the galleon the
   * thresholds were authored on. The raft passes ~0.35 (her polar tops out at
   * 3.4 m/s against the galleon's 8), without which she throws 2% of a sheet
   * and reads as having no bow wave at all.
   */
  speedScale?: number;
  /**
   * §T.171 W5 — THE HULL CONTACT ITSELF (§V101: `createHullContact`'s result
   * plus the hull's design draft). When present, emission is
   * `sprayMath.bowContactEmission` — the water the waterline faces LIFT, from
   * relative normal velocity × immersion — and `speedScale` and the
   * speed/immersion ramps are not read at all. Absent = the legacy ramp (the
   * pirate page until W6), bit-identical.
   */
  contact?: BowContactInput;
}

/** an airborne cutwater: nothing in contact, whatever the stations say */
const NO_CONTACT: BowContactInput = { inContact: false, sliceZ: [], sliceHalfWidth: [], depth: [], draft: 0 };

export function createBowSpray() {
  /** this tick's emission model — the §T.59 fade override is a contact-mode property */
  let contactMode = false;
  // bow sheets are coarser than crest mist — same pool code, bigger sprites
  const pool = createSprayPool(sprayParams.bowCount, {
    sizeScale: () => sprayParams.bowSizeScale,
    life: () => sprayParams.bowLife,
    drag: () => sprayParams.bowDrag,
    fadeNear: () => (contactMode ? sprayParams.bowContactFadeNear : sprayParams.fadeNear),
    fadeFar: () => (contactMode ? sprayParams.bowContactFadeFar : sprayParams.fadeFar),
  });
  const count = pool.count; // sanitized — sizes the spawn dispatch too

  const uBowPos = uniform(new THREE.Vector3()); // waterline point at the stem
  const uSpeed = uniform(0); // hull speed over ground (m/s)
  const uForward = uniform(new THREE.Vector2(0, 1)); // unit heading, XZ
  const uSpread = uniform(sprayParams.bowLaunchSpread);
  const uForwardThrow = uniform(sprayParams.bowForwardThrow);
  const uRise = uniform(sprayParams.bowRise);
  const uSideOffset = uniform(sprayParams.bowSideOffset);
  const uStemLength = uniform(sprayParams.bowStemLength);
  /** closing speed of the slam (m/s) and its launch multipliers */
  const uSlamSpeed = uniform(0);
  const uSlamRise = uniform(sprayParams.bowSlamRise);
  const uSlamSpread = uniform(sprayParams.bowSlamSpread);
  const uSizeVar = uniform(sprayParams.sizeVariation);
  /** 0..1 how much of a full sheet this tick throws (size + rise) */
  const uSheet = uniform(0);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    // rotating window (sprayMath.inSpawnWindow): only budgeted slots respawn
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      // ejection basis = the HULL's frame (heading + its perpendicular), not
      // a world axis and not the ship's track — see BowState.shipForward
      const forward = uForward.toVar();
      const side = vec2(forward.y.negate(), forward.x).toVar();

      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));

      // CPU mirror: sprayMath.bowSpawnOffset — seed along the cutwater LINE:
      // outboard flank + a run AFT of the crossing (negative: the hull
      // shoulders water backward from where it enters, never ahead of it).
      const lateral = uSideOffset
        .mul(rSide.mul(2).sub(1).abs().mul(0.65).add(0.35))
        .mul(sideSign);
      const stem = uStemLength.mul(rMag).negate();
      const offXZ = side.mul(lateral).add(forward.mul(stem));

      // CPU mirror: sprayMath.bowLaunchVelocity — shoved FORWARD past the bow
      // (throw > 1 outruns the hull) and OUTBOARD on the flank it was seeded
      // on, fanning away from the centreline. Horizontal throw follows ship
      // speed alone; the RISE scales with the sheet, so a cruising stem throws
      // water flat and forward while a burial launches it high — PLUS the
      // slam's own closing speed, which owes nothing to how fast the ship is
      // going and is what actually detaches water from the surface.
      const out = uSpeed
        .mul(uSpread)
        .add(uSlamSpeed.mul(uSlamSpread))
        .mul(rMag)
        .mul(sideSign);
      const fwd = uSpeed.mul(uForwardThrow).mul(rMag.mul(0.4).add(0.6));
      const velXZ = side.mul(out).add(forward.mul(fwd));
      const vy = uSpeed
        .mul(uRise)
        .mul(uSheet)
        .add(uSlamSpeed.mul(uSlamRise))
        .mul(rUp.mul(0.5).add(0.5));

      const pos = uBowPos.add(vec3(offXZ.x, 0, offXZ.y));
      pool.posAge.element(instanceIndex).assign(vec4(pos, 0));
      // w = per-particle size multiplier: this tick's sheet fraction, jittered
      // per droplet (CPU mirror: sprayMath.sizeJitter) so a sheet is made of
      // different-sized water rather than one repeated sprite
      const rSize = hash2(vec2(s.mul(H_SIZE), uTime.add(T_SIZE)));
      pool.velSize
        .element(instanceIndex)
        .assign(vec4(velXZ.x, vy, velXZ.y, uSheet.mul(uSizeVar.mul(rSize).oneMinus())));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };
  let prevImmersion: number | null = null;

  return {
    mesh: pool.mesh,

    /** run once per fixed sim tick (§V2); bow state from buoyancy probes */
    update(renderer: THREE.WebGPURenderer, bow: BowState): void {
      contactMode = bow.contact !== undefined;
      uSpread.value = sprayParams.bowLaunchSpread;
      uForwardThrow.value = sprayParams.bowForwardThrow;
      // §T.180: the contact model launches at its Bernoulli bound (sprayMath.BOW_CONTACT_RISE); uniform value only
      uRise.value = contactMode ? BOW_CONTACT_RISE : sprayParams.bowRise;
      uSlamRise.value = Math.max(0, sprayParams.bowSlamRise);
      uSlamSpread.value = Math.max(0, sprayParams.bowSlamSpread);
      uSizeVar.value = Math.min(1, Math.max(0, sprayParams.sizeVariation));
      uStemLength.value = sprayParams.bowStemLength;
      // NaN from a broken buoyancy frame must not reach the spawn buffers —
      // it would persist in pos/vel for a full particle lifetime
      const fin = (v: number) => (Number.isFinite(v) ? v : 0);
      // Emit from the TRUE cutwater — the point where the hull outline crosses
      // the surface this instant — falling back to the geometric bow only
      // until the sampler is wired. A fixed stem point lifts clear in a trough
      // and keeps spraying from mid-air; the crossing point cannot, since it
      // is defined as being on the water.
      const cut = bow.cutwater;
      const lift = Math.max(0, sprayParams.bowSpawnLift);
      // cutwater.world is ALREADY on the surface (depth 0); the fallback bow
      // point is on the HULL with the surface `immersion` above it. Only the
      // fallback needs the immersion added — the lift keeps the sprite out of
      // the surface's depth buffer either way (the ocean writes depth now, so
      // a sheet born coplanar with the water is depth-rejected).
      const immersion = Math.max(0, fin(cut ? cut.depth : bow.immersionDepth));
      if (cut) {
        (uBowPos.value as THREE.Vector3).set(
          fin(cut.world[0]),
          fin(cut.world[1]) + lift,
          fin(cut.world[2]),
        );
      } else {
        (uBowPos.value as THREE.Vector3).set(
          fin(bow.bowWorldPos.x),
          fin(bow.bowWorldPos.y) + immersion + lift,
          fin(bow.bowWorldPos.z),
        );
      }
      // Sheet width follows the HULL's actual breadth where it enters the
      // water — a fine entry throws a narrow sheet, the full beam a wide one.
      // Hull-relative, so it survives a different ship (§V18) without retuning.
      //
      // FLOORED, and that floor is the whole point. `cutwater.halfWidth` is the
      // half-breadth AT THE CROSSING, and the crossing is normally the stem
      // itself — where a hull comes to a point and the half-breadth is EXACTLY
      // ZERO by construction. Measured at 20 kt in open water: halfWidth was 0
      // on 53% of ticks (75% in the earlier run), so `bowSideFraction` was being
      // multiplied by nothing and the entire sheet collapsed onto the
      // centreline. The young cohort read a 0.03 m spread across the beam
      // against 2.8 m along the hull — a line of particles, not a sheet, which
      // is exactly the "we lost the spray forward" the user reported.
      //
      // A knife-edged stem still throws water outboard: the width of a bow
      // sheet is set by the wave the hull makes, not by the plating at the one
      // point where the outline pierces the surface. So `bowSideOffset` is a
      // MINIMUM, not a fallback — the hull's real half-breadth takes over as
      // soon as the crossing walks aft into the shoulder, where it is wider.
      uSideOffset.value = Math.max(
        Math.max(0, sprayParams.bowSideOffset),
        cut ? Math.max(0, fin(cut.halfWidth)) * sprayParams.bowSideFraction : 0,
      );
      uTime.value += SIM_DT;
      pool.step(renderer); // physics always runs — airborne spray keeps falling

      const velX = fin(bow.shipVelocity.x);
      const velZ = fin(bow.shipVelocity.z);
      const speed = Math.hypot(velX, velZ);
      uSpeed.value = speed;
      // heading if the caller has one, else the track; both floored so a
      // dead-in-the-water frame can't normalise a zero vector (§V28)
      const fwd = bow.shipForward;
      const hx = fwd && Number.isFinite(fwd.x) ? fwd.x : velX;
      const hz = fwd && Number.isFinite(fwd.z) ? fwd.z : velZ;
      const hLen = Math.hypot(hx, hz);
      if (hLen > 1e-6) {
        (uForward.value as THREE.Vector2).set(hx / hLen, hz / hLen);
      }

      // Burial rate = how fast the cutwater is diving INTO the water. Prefer
      // the sampler's value: differencing our own immersion also registers the
      // emitter JUMPING between stations (or between hull and contact point),
      // which would read as a slam that never happened.
      const burialRate = cut
        ? Math.max(0, fin(cut.rate))
        : prevImmersion === null
          ? 0
          : Math.max(0, (immersion - prevImmersion) / SIM_DT);
      prevImmersion = immersion;

      // no contact signal yet → fall back to "immersed at all", the best
      // proxy a fixed geometric bow point can offer
      const inContact = cut ? cut.inContact : immersion > 0;
      let emission: { rate: number; sheet: number; slam: number };
      if (bow.contact) {
        // §T.171: hull velocity relative to the water in SHIP space — heading
        // basis above (+z forward), starboard = (fz, −fx) for a y-up yaw
        const f = uForward.value as THREE.Vector2;
        emission = bowContactEmission(
          inContact ? bow.contact : NO_CONTACT,
          velX * f.y - velZ * f.x,
          velX * f.x + velZ * f.y,
          burialRate,
          immersion,
          sprayParams,
        );
      } else {
        emission = bowEmission(immersion, speed, burialRate, inContact, sprayParams, bow.speedScale ?? 1);
      }
      const { rate, sheet, slam } = emission;
      if (rate <= 0) return;
      uSheet.value = sheet;
      // the LAUNCH takes the real closing speed, gated by the slam ramp so a
      // gentle settling into a trough does not fling water; `slam` is already
      // 0 below bowSlamRateOn and 1 at bowSlamRateFull
      uSlamSpeed.value = burialRate * slam;
      const next = advanceBurstCursor(cursorState, rate, SIM_DT, count);
      cursorState = { cursor: next.cursor, acc: next.acc };
      if (next.budget === 0) return;
      uCursor.value = (next.cursor - next.budget + count) % count;
      uBudget.value = next.budget;
      pool.run(renderer, spawnPass);
    },

    dispose(): void {
      pool.dispose();
    },
  };
}

export type BowSpray = ReturnType<typeof createBowSpray>;

// ---------------------------------------------------------------------------
// §T.195 THE FLEET'S BOW SPRAY — one pool, every boat's waterline
// ---------------------------------------------------------------------------

/** emitter slots the fleet spray carries (the hero + 7 rivals) — literal shader bound (§V28) */
export const BOW_FLEET_SLOTS = 8;
/** hash salt picking the emitter a particle leaves */
const H_EMIT = 613.7;
const T_EMIT = 2.3;

/** one boat's spray this tick: its waterline (`sprayMath.waterlineSprayEmission`) and its hull speed over water */
export interface BowFleetEmitter {
  bow: Readonly<WaterlineSpray>;
  /** hull speed over the water (m/s) */
  speed: number;
}

/**
 * THE LAUNCH OF A SHEET LEAVING A LIFTING WATERLINE (§T.195), per emitter, from the hull speed U and the flux-weighted
 * normal speed v_n the waterline drives into the water (sin θ = v_n/U, θ the waterline's angle to the flow). In the
 * hull frame the water arrives at −U and leaves the stagnation line reflected by 2θ at the same speed; in the world
 * frame (add U):
 *
 *   forward  U(1 − cos 2θ) = 2·v_n²/U           outboard  U·sin 2θ = 2·v_n·√(1 − (v_n/U)²)
 *   up       v_n·sheet (≤ v_n²/2g apex — the contact rise, BOW_CONTACT_RISE)
 *
 * A planing hull's spray root runs at θ ≈ 4° (v_n ≈ 3 m/s at 40 m/s): the sheet barely moves forward in the world,
 * fans outboard at ~6 m/s and is left behind as the boat runs off — the spray wings. A bluff bow at 2 m/s (θ ≈ 90°)
 * throws forward at 2U and nothing outboard — the raft's pile-up. No speed ramp, no per-vessel scale.
 * §V28: non-finite or non-positive speeds → zero launch.
 */
export function waterlineSheetLaunch(speed: number, vn: number): { forward: number; outboard: number; up: number } {
  if (!Number.isFinite(speed) || !Number.isFinite(vn) || !(vn > 0)) return { forward: 0, outboard: 0, up: 0 };
  const u = Math.max(Math.abs(speed), vn);
  const s = Math.min(1, vn / u);
  return { forward: (2 * vn * vn) / u, outboard: 2 * vn * Math.sqrt(Math.max(0, 1 - s * s)), up: vn * BOW_CONTACT_RISE };
}

export interface BowSprayFleetOptions {
  /** particle pool (default 4 × sprayParams.bowCount, sanitized) */
  count?: number;
  /** emitter slots (default BOW_FLEET_SLOTS) */
  slots?: number;
}

/**
 * EVERY BOAT'S BOW SPRAY IN ONE POOL (§T.195). The pirate/raft emitter (`createBowSpray`) is untouched; this is the
 * fleet's: a fixed pool, `slots` emitter uniforms, and a spawn pass that picks each respawning particle's emitter off
 * a CDF of the rates the budget GRANTED (`prioritiseEmitters`: nearest the camera first, total ≤ the pool's
 * turnover count/life). Emission per boat is `liftedFluxEmission` of her waterline (live params, page side); the
 * launch is `waterlineSheetLaunch`; spawn seeds along her waterline centroid ± her flux half-width, aft over
 * `bowStemLength`. §V28: every uniform finite-guarded; a non-finite emitter is not granted a slot.
 */
/** W8 round 5 LOOK: whisker-spray drops (2 cm, |v|·1/120 s, ≤ 10 widths, ≤ 6 mrad), sprites per sheet unit, pool factor, opacity */
export const BOW_WHISKER_BLUR = Object.freeze({ width: 0.02, shutter: 1 / 120, maxRatio: 10, angularCap: 0.006 });
export const BOW_WHISKER_DENSITY = 8;
export const BOW_WHISKER_POOL_FACTOR = 4;
export const BOW_WHISKER_OPACITY = 0.5;

export function createBowSprayFleet(opts: BowSprayFleetOptions = {}) {
  const slots = Math.max(1, Math.min(16, Math.floor(opts.slots ?? BOW_FLEET_SLOTS)));
  let killY = -1e6;
  // W8 round 5 SPRAY ROOT / WHISKER SPRAY: the planing bottom's sheet leaves as fine drops — physical motion-blur streaks
  // (`SprayPoolOptions.motionBlur`), BOW_WHISKER_DENSITY sprites per unit of the sheet's lifted flux, killed where they
  // fall back into the water. Only the fleet emitter; the raft/pirate `createBowSpray` pool is unchanged.
  const pool = createSprayPool((opts.count ?? sprayParams.bowCount * 4) * BOW_WHISKER_POOL_FACTOR, {
    droplets: true,
    motionBlur: BOW_WHISKER_BLUR,
    dropletAgeFalloff: 1.3,
    dropletNearFade: [0.3, 1.5],
    killBelow: () => killY,
    opacity: () => BOW_WHISKER_OPACITY,
    sizeScale: () => sprayParams.bowSizeScale,
    life: () => sprayParams.bowLife,
    drag: () => sprayParams.bowDrag,
    fadeNear: () => sprayParams.bowContactFadeNear,
    fadeFar: () => sprayParams.bowContactFadeFar,
    // §T.199 above the water: after the ocean in the transparent pass (sprayPool.ts SPRAY_OVER_WATER_ORDER)
    renderOrder: SPRAY_OVER_WATER_ORDER,
  });
  const count = pool.count;
  /** per slot: (x, y, z, CDF upper bound), (fwdX, fwdZ, halfWidth, sheet), (forward, outboard, up, slamSpeed) */
  const posCdf = Array.from({ length: slots }, () => new THREE.Vector4(0, -1000, 0, 1));
  const frameV = Array.from({ length: slots }, () => new THREE.Vector4(0, 1, 0, 0));
  const launchV = Array.from({ length: slots }, () => new THREE.Vector4());
  const uPosCdf = uniformArray(posCdf);
  const uFrame = uniformArray(frameV);
  const uLaunch = uniformArray(launchV);
  const uStemLength = uniform(sprayParams.bowStemLength);
  const uSlamRise = uniform(sprayParams.bowSlamRise);
  const uSlamSpread = uniform(sprayParams.bowSlamSpread);
  const uSizeVar = uniform(sprayParams.sizeVariation);
  const uCursor = uniform(0);
  const uBudget = uniform(0);
  const uTime = uniform(0);

  const spawnPass = Fn(() => {
    const pa = pool.posAge.element(instanceIndex);
    const rel = float(instanceIndex).sub(uCursor).add(count).mod(count);
    If(pa.w.greaterThanEqual(pool.lifeNode()).and(rel.lessThan(uBudget)), () => {
      // @band-limited-elsewhere: fract of the particle INDEX (a seed), not a spatial coordinate
      const s = float(instanceIndex).add(1).mul(PHI).fract().toVar();
      const rEmit = hash2(vec2(s.mul(H_EMIT), uTime.add(T_EMIT)));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let pc: any = uPosCdf.element(int(slots - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let fr: any = uFrame.element(int(slots - 1));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- TSL node
      let ln: any = uLaunch.element(int(slots - 1));
      for (let k = slots - 2; k >= 0; k--) {
        const take = rEmit.lessThan(uPosCdf.element(int(k)).w);
        pc = select(take, uPosCdf.element(int(k)), pc);
        fr = select(take, uFrame.element(int(k)), fr);
        ln = select(take, uLaunch.element(int(k)), ln);
      }
      const forward = vec2(fr.x, fr.y).toVar();
      const side = vec2(forward.y.negate(), forward.x).toVar();
      const rUp = hash2(vec2(s.mul(H_BOW_UP), uTime.add(T_BOW_UP)));
      const rSide = hash2(vec2(s.mul(H_BOW_SIDE), uTime.add(T_BOW_SIDE)));
      const rMag = hash2(vec2(s.mul(H_BOW_MAG), uTime.add(T_BOW_MAG)));
      const sideSign = select(rSide.lessThan(0.5), float(-1), float(1));
      // CPU mirror: sprayMath.bowSpawnOffset with the emitter's own half-width
      const lateral = fr.z.mul(rSide.mul(2).sub(1).abs().mul(0.65).add(0.35)).mul(sideSign);
      const stem = uStemLength.mul(rMag).negate();
      const offXZ = side.mul(lateral).add(forward.mul(stem));
      const slam = ln.w;
      const out = ln.y.add(slam.mul(uSlamSpread)).mul(rMag).mul(sideSign);
      const fwd = ln.x.mul(rMag.mul(0.4).add(0.6));
      const velXZ = side.mul(out).add(forward.mul(fwd));
      const vy = ln.z.mul(fr.w).add(slam.mul(uSlamRise)).mul(rUp.mul(0.5).add(0.5));
      pool.posAge.element(instanceIndex).assign(vec4(pc.xyz.add(vec3(offXZ.x, 0, offXZ.y)), 0));
      const rSize = hash2(vec2(s.mul(H_SIZE), uTime.add(T_SIZE)));
      pool.velSize.element(instanceIndex).assign(vec4(velXZ.x, vy, velXZ.y, fr.w.mul(uSizeVar.mul(rSize).oneMinus())));
    });
  })().compute(count);

  let cursorState = { cursor: 0, acc: 0 };
  const rates: number[] = [];
  const dists: number[] = [];
  const pick: number[] = [];
  const grant: number[] = [];
  const fin = (v: number, fallback = 0): number => (Number.isFinite(v) ? v : fallback);

  return {
    mesh: pool.mesh,
    slots,
    count,
    /** the last tick's granted (emitter index, rate) pairs, priority order (tests / debug) */
    granted: { index: pick, rate: grant },
    /**
     * FIXED TICK (§V2 physics step): every boat's waterline this tick; `camera` = the viewer (priority only — the
     * spray is visual, never sim state). Returns the total granted particles/s.
     */
    update(renderer: THREE.WebGPURenderer, emitters: readonly BowFleetEmitter[], camera: { x: number; y: number; z: number }): number {
      uStemLength.value = Math.max(0, fin(sprayParams.bowStemLength));
      uSlamRise.value = Math.max(0, fin(sprayParams.bowSlamRise));
      uSlamSpread.value = Math.max(0, fin(sprayParams.bowSlamSpread));
      uSizeVar.value = Math.min(1, Math.max(0, fin(sprayParams.sizeVariation)));
      uTime.value += SIM_DT;
      rates.length = 0;
      dists.length = 0;
      const emission = emitters.map((e) => {
        const b = e.bow;
        const ok = b.inContact && [b.x, b.y, b.z, b.fwdX, b.fwdZ, b.halfWidth, b.launch, e.speed].every(Number.isFinite);
        const em = ok ? liftedFluxEmission(b.flux, b.lift, b.burialRate, b.cutwaterDepth, sprayParams) : null;
        rates.push(em ? em.rate * BOW_WHISKER_DENSITY : 0);
        dists.push(ok ? Math.hypot(b.x - camera.x, b.y - camera.y, b.z - camera.z) : Infinity);
        return em;
      });
      const life = Math.max(1e-3, fin(sprayParams.bowLife, 1)) * (1 + Math.min(0.9, Math.max(0, fin(sprayParams.lifeVariation))));
      prioritiseEmitters(rates, dists, slots, count / life, pick, grant);
      let total = 0;
      let ySum = 0;
      for (let k = 0; k < pick.length; k++) ySum += emitters[pick[k]].bow.y;
      if (pick.length > 0) killY = ySum / pick.length - 0.05;
      for (let k = 0; k < slots; k++) {
        const live = k < pick.length;
        if (!live) {
          posCdf[k].set(0, -1000, 0, 1);
          frameV[k].set(0, 1, 0, 0);
          launchV[k].set(0, 0, 0, 0);
          continue;
        }
        const e = emitters[pick[k]];
        const em = emission[pick[k]]!;
        const b = e.bow;
        const launch = waterlineSheetLaunch(e.speed, b.launch);
        total += grant[k];
        posCdf[k].set(b.x, b.y + Math.max(0, fin(sprayParams.bowSpawnLift)), b.z, 0);
        frameV[k].set(b.fwdX, b.fwdZ, Math.max(0.3, b.halfWidth), em.sheet);
        launchV[k].set(launch.forward, launch.outboard, launch.up, Math.max(0, fin(b.burialRate)) * em.slam);
      }
      let acc = 0;
      for (let k = 0; k < slots; k++) {
        if (k < pick.length) acc += grant[k];
        posCdf[k].w = total > 0 ? (k >= pick.length - 1 ? 1 : acc / total) : 1;
      }
      // @band-limited-elsewhere: a pool method named step, not a shader edge
      pool.step(renderer); // physics always runs — airborne spray keeps falling
      if (!(total > 0)) return 0;
      const next = advanceBurstCursor(cursorState, total, SIM_DT, count);
      cursorState = { cursor: next.cursor, acc: next.acc };
      if (next.budget === 0) return total;
      uCursor.value = (next.cursor - next.budget + count) % count;
      uBudget.value = next.budget;
      pool.run(renderer, spawnPass);
      return total;
    },
    dispose(): void {
      pool.dispose();
    },
  };
}

export type BowSprayFleet = ReturnType<typeof createBowSprayFleet>;
