/**
 * Analytic ship wake injector (§V10 follow-up), TSL side — the GPU twin of
 * wakeMath.ts. Injected ADDITIVELY on top of the ortho-capture inside the
 * accumulation advect pass (accumulation.ts composes:
 * foam = prev·decay + capture·injectStrength·dt + wakeRate·dt).
 *
 * WORLD-SPACE HISTORY, NOT A SHIP-LOCAL SHAPE. The previous version evaluated
 * a bow-V/stern-band pattern in the ship's LIVE frame out to `wakeRange`
 * metres, so a turn instantly re-pointed ~40 m of already-laid wake ("as if
 * it's actually propelled out of the air when you turn"). Now the only thing
 * this module draws from the live pose is the tip of the V at the stem; every
 * other feature is read off the recorded cutwater polyline (wakeTrack.ts), so
 * deposited wake can never re-orient. A hard turn leaves a curved trail whose
 * far end still points the old way, and the new rooster tail has to be
 * travelled into existence because a fresh track sample has dist = 0.
 *
 * Per texel the pass walks TRACK_SEGMENTS segments, keeps the nearest, and
 * evaluates four features (cutwater core, Kelvin arms, stern churn, shed
 * vortex pair) in that track frame, plus the bow mound in the live stem frame
 * — see wakeMath.ts for the model and the bow-vs-aft rationale. The mound is
 * the only feature forward of the stem; it is emitted at the instantaneous
 * pose and immediately becomes ordinary world-anchored trail.
 * §V28: literal Loop bound, floored divisors, finite-
 * guarded uniforms (advanceTrack rejects non-finite poses), AABB early-out so
 * open water pays ~nothing.
 *
 * MIRROR CONTRACT: wakeMath.projectOnTrack / wakeEnvelopeCpu / wakeBreakupCpu
 * / wakeRateCpu are the exact CPU formulas (tested) — change one side → change
 * the other.
 *
 * main.ts feeds per tick (yaw = atan2(fwd.x, fwd.z) of ship local +z), exactly
 * as before — the history is built internally, no new inputs required:
 *   ff.setShip([ship.x, ship.z], yaw, speedOverWater,
 *              bowOffset, sternOffset, beam);  // offsets from blueprint AABB
 *
 * §V23: functional 3-arg smoothstep/mix only.
 */
import * as THREE from 'three/webgpu';
import {
  If,
  Loop,
  float,
  int,
  mix,
  select,
  smoothstep,
  uniform,
  uniformArray,
  vec2,
  vec4,
} from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { FLOW_OCTAVES } from './flowMath';
import { INV_SQRT2, wakeReachCpu, type WakeHull } from './wakeMath';
import {
  TRACK_CAPACITY,
  advanceTrack,
  approachExp,
  createWakeTrack,
  trackReachCpu,
  trackBounds,
  trackPoints,
  type TrackPose,
} from './wakeTrack';
import type { FlowFoamParams } from '../params/flowfoam';

export { TRACK_CAPACITY };
/** uniform-array slots = history + the live cutwater pose prepended at index 0 */
export const TRACK_SLOTS = TRACK_CAPACITY + 1;
/** polyline segments walked per texel */
export const TRACK_SEGMENTS = TRACK_SLOTS - 1;
/** larger than any squared distance inside the foam region — nearest-point seed */
const FAR = 1e12;
/** floor for divisors and smoothstep spans (§V28) */
const EPS = 1e-6;

export function createWakeInjector(p: FlowFoamParams) {
  // (x, z, fx, fz) and (age, dist, speed, unused) per slot
  const posVecs = Array.from({ length: TRACK_SLOTS }, () => new THREE.Vector4(0, 0, 0, 1));
  const metaVecs = Array.from({ length: TRACK_SLOTS }, () => new THREE.Vector4());
  const uTrackPos = uniformArray(posVecs);
  const uTrackMeta = uniformArray(metaVecs);
  const uTrackCount = uniform(0);
  const uTrackMin = uniform(new THREE.Vector2(0, 0));
  const uTrackMax = uniform(new THREE.Vector2(0, 0));
  /** live cutwater pose (x, z, fx, fz) — only used for the forward clip */
  const uHead = uniform(new THREE.Vector4(0, 0, 0, 1));

  const uHullLength = uniform(20);
  const uBeam = uniform(6);
  const uKelvinTan = uniform(Math.tan((p.kelvinAngle * Math.PI) / 180));
  const uBowIntensity = uniform(p.bowIntensity);
  const uArmWidth = uniform(p.armWidth);
  const uArmWidthGrowth = uniform(p.armWidthGrowth);
  const uArmWidthMax = uniform(p.armWidthMax);
  const uAftSpreadCap = uniform(p.aftSpreadCap);
  const uShoulderIntensity = uniform(p.shoulderIntensity);
  const uShoulderLength = uniform(p.shoulderLength);
  const uShoulderPush = uniform(p.shoulderPush);
  const uShoulderWidth = uniform(p.shoulderWidth);
  const uShoulderEntry = uniform(p.shoulderEntry);
  const uHullBoost = uniform(p.hullBoost);
  const uHullBoostDist = uniform(p.hullBoostDist);
  const uBowLife = uniform(p.bowLife);
  const uCutIntensity = uniform(p.cutIntensity);
  const uCutWidth = uniform(p.cutWidth);
  const uCutLength = uniform(p.cutLength);
  const uSternIntensity = uniform(p.sternIntensity);
  const uSternWidth = uniform(p.sternWidth);
  const uSternSpread = uniform(p.sternSpread);
  const uSternLife = uniform(p.sternLife);
  const uSternOnset = uniform(p.sternOnset);
  const uVortexIntensity = uniform(p.vortexIntensity);
  const uVortexOffset = uniform(p.vortexOffset);
  const uVortexSpread = uniform(p.vortexSpread);
  const uVortexWidth = uniform(p.vortexWidth);
  const uVortexSpacing = uniform(p.vortexSpacing);
  const uVortexLife = uniform(p.vortexLife);
  const uSpeedThreshold = uniform(p.speedThreshold);
  const uFullWakeSpeed = uniform(p.fullWakeSpeed);
  const uTrackLife = uniform(p.trackLife);
  /** capacity-limited track length (m) — the OTHER eviction edge to fade over */
  const uTrackCapDist = uniform(0);
  const uTailFade = uniform(p.tailFade);
  const uBowClip = uniform(p.bowClip);
  const uMoundIntensity = uniform(p.moundIntensity);
  const uMoundLead = uniform(p.moundLead);
  const uMoundSweep = uniform(p.moundSweep);
  const uMoundSpan = uniform(p.moundSpan);
  const uMoundThick = uniform(p.moundThick);
  const uMoundFill = uniform(p.moundFill);
  /** lagged speed driving the mound — a heavy hull piles it up, then lets go */
  const uMoundSpeed = uniform(0);
  const uWakeNoiseScale = uniform(p.wakeNoiseScale);
  const uWakeNoiseContrast = uniform(p.wakeNoiseContrast);
  const uWakeBreakup = uniform(p.wakeBreakup);

  const track = createWakeTrack();
  const pose: TrackPose = { x: 0, z: 0, fx: 0, fz: 1, speed: 0 };
  const hull: WakeHull = { length: 20, beam: 6 };
  let moundSpeed = 0;

  /** falling edge: 1 at x = 0, 0 at x = e (§V23 functional smoothstep) */
  const fadeTo = (e: any, x: any): any => smoothstep(float(0), e.max(EPS), x).oneMinus();

  return {
    /**
     * TSL wake injection rate (foam/second) at a world-XZ node.
     * CPU mirror: wakeMath.wakeRateCpu (track-frame envelope × world breakup).
     */
    wakeRateNode(worldXZ: any): any {
      const rate = float(0).toVar();
      // AABB early-out: most of a 512² region is open water far from the track
      const inRange = worldXZ.x
        .greaterThanEqual(uTrackMin.x)
        .and(worldXZ.x.lessThanEqual(uTrackMax.x))
        .and(worldXZ.y.greaterThanEqual(uTrackMin.y))
        .and(worldXZ.y.lessThanEqual(uTrackMax.y))
        .and(uTrackCount.greaterThanEqual(2));

      If(inRange, () => {
        // nearest track point: (squared distance, dist, age, speed) + lateral
        const best = vec4(FAR, 0, 0, 0).toVar();
        const bestLat = float(0).toVar();
        Loop(TRACK_SEGMENTS, ({ i }) => {
          const a = uTrackPos.element(int(i));
          const b = uTrackPos.element(int(i).add(1));
          const ma = uTrackMeta.element(int(i));
          const mb = uTrackMeta.element(int(i).add(1));
          const q0 = vec2(a.x, a.y);
          const e = vec2(b.x, b.y).sub(q0);
          const dp = worldXZ.sub(q0);
          const t = dp.dot(e).div(e.dot(e).max(EPS)).clamp(0, 1); // §V28 floored
          const diff = dp.sub(e.mul(t));
          const d2 = diff.dot(diff);
          // slot i+1 must exist: i + 2 ≤ count
          const valid = float(i).add(2).lessThanEqual(uTrackCount);
          const better = valid.and(d2.lessThan(best.x));
          best.assign(
            select(
              better,
              // §V23 functional mix(a, b, t) — interpolate along the segment
              vec4(d2, mix(ma.y, mb.y, t), mix(ma.x, mb.x, t), mix(ma.z, mb.z, t)),
              best,
            ),
          );
          // right = (fz, −fx): a.z = fx, a.w = fz (sign only; |lat| = √d2)
          bestLat.assign(select(better, diff.x.mul(a.w).sub(diff.y.mul(a.z)), bestLat));
        });

        const s = best.w;
        // §V28: both smoothstep spans floored so e0 == e1 can never divide by 0
        const gate = smoothstep(uSpeedThreshold, uSpeedThreshold.mul(2).max(uSpeedThreshold.add(EPS)), s);
        const sf = smoothstep(uSpeedThreshold, uFullWakeSpeed.max(uSpeedThreshold.add(EPS)), s);
        const ay = best.x.sqrt(); // |lateral offset| from the track
        const d = best.y.max(0); // arclength forward to the live cutwater
        const age = best.z.max(0);

        // 1. cutwater core — the stem tearing the surface open, at dist ≈ 0
        const cut = uCutIntensity
          .mul(s)
          .mul(sf)
          .mul(fadeTo(uCutWidth, ay))
          .mul(fadeTo(uCutLength, d));

        // 2. Kelvin arms — crest at dist·tanθ (speed-INDEPENDENT, as it must
        //    be), thickness capped so the V never swells into a wedge-shaped
        //    blob at the ranges the trail now reaches
        const kelvin = d.mul(uKelvinTan); // the envelope every aft feature obeys
        const armW = uArmWidth.add(uArmWidthGrowth.mul(d)).min(uArmWidthMax);
        const arm = fadeTo(armW, ay.sub(kelvin).abs());
        const boost = float(1).add(uHullBoost.mul(fadeTo(uHullBoostDist, d)));
        const bow = uBowIntensity
          .mul(s)
          .mul(sf)
          .mul(arm)
          .mul(boost)
          .mul(fadeTo(uBowLife, age));

        // 2b. hull shoulder — the water the forebody shoulders ASIDE, pressed
        //     out past the hull side along the whole immersed forebody and
        //     peeling into the arms. Mirror: wakeMath (see there for the
        //     "plowing, not flying" rationale). `halfBeam` is the wetted
        //     half-beam profile and is where the physics agent's per-station
        //     immersion table will plug in.
        const halfBeam = uBeam.mul(0.5).mul(smoothstep(float(0), uShoulderEntry.max(EPS), d));
        const shoulderOff = halfBeam.add(
          uShoulderPush.mul(smoothstep(float(0), uShoulderLength.max(EPS), d)),
        );
        const shoulderHold = smoothstep(
          uShoulderLength.mul(0.55),
          uShoulderLength.max(uShoulderLength.mul(0.55).add(EPS)),
          d,
        ).oneMinus();
        const shoulder = uShoulderIntensity
          .mul(s)
          .mul(sf)
          .mul(fadeTo(uShoulderWidth, ay.sub(shoulderOff).abs()))
          .mul(shoulderHold);

        // aft features start only where the TRANSOM has passed (onset = 0 ahead)
        const ds = d.sub(uHullLength);
        const onset = smoothstep(float(0), uSternOnset.max(EPS), ds);
        const as = age.sub(uHullLength.div(s.max(uSpeedThreshold).max(EPS))).max(0);

        // nothing aft may pan out past the Kelvin wedge (see wakeMath)
        const aftCap = uBeam.mul(0.5).add(uAftSpreadCap.mul(kelvin));

        // 3. stern churn — wide flat centreline band, ∝ speed², spreads with AGE
        const churnW = uBeam.mul(0.5).mul(uSternWidth).add(uSternSpread.mul(as)).min(aftCap);
        const stern = uSternIntensity
          .mul(s)
          .mul(s)
          .mul(fadeTo(churnW, ay))
          .mul(fadeTo(uSternLife, as))
          .mul(onset);

        // 4. shed vortex pair — lobes off the transom corners, alternating
        //    port/starboard (§B.4: phased by track DISTANCE, per-position)
        const vOff = uBeam.mul(0.5).mul(uVortexOffset).add(uVortexSpread.mul(as)).min(aftCap);
        const side = select(bestLat.lessThan(0), float(Math.PI), float(0));
        const phase = ds.div(uVortexSpacing.max(EPS)).mul(Math.PI * 2).add(side);
        const puff = phase.sin().mul(0.5).add(0.5);
        const vortex = uVortexIntensity
          .mul(s)
          .mul(s)
          .mul(fadeTo(uVortexWidth, ay.sub(vOff).abs()))
          .mul(puff)
          .mul(fadeTo(uVortexLife, as))
          .mul(onset);

        // Tail fade so an evicted sample never pops out of existence — BOTH
        // eviction routes (capacity = a length at speed, trackLife = a time
        // adrift) need one, see wakeMath.wakeEnvelopeCpu.
        const ageE0 = uTrackLife.mul(uTailFade.oneMinus());
        const distE0 = uTrackCapDist.mul(uTailFade.oneMinus());
        const tail = smoothstep(ageE0, uTrackLife.max(ageE0.add(EPS)), age)
          .oneMinus()
          .mul(smoothstep(distE0, uTrackCapDist.max(distE0.add(EPS)), d).oneMinus());
        // forward clip: nothing ahead of the live cutwater
        const ahead = worldXZ.x
          .sub(uHead.x)
          .mul(uHead.z)
          .add(worldXZ.y.sub(uHead.y).mul(uHead.w));
        const clip = fadeTo(uBowClip, ahead);

        // world-anchored breakup: gappy foam patches, not painted stripes.
        // Two lattice orientations (axis + 45°) hide the square value-noise
        // grid (wakeMath.wakeBreakupCpu twin)
        const np = worldXZ.mul(uWakeNoiseScale);
        const rot = vec2(np.x.sub(np.y).mul(INV_SQRT2), np.x.add(np.y).mul(INV_SQRT2));
        const n = fbm2(np, FLOW_OCTAVES).add(fbm2(rot, FLOW_OCTAVES)).mul(0.5);
        const patch = smoothstep(
          float(0.5).sub(uWakeNoiseContrast),
          float(0.5).add(uWakeNoiseContrast).max(float(0.5).sub(uWakeNoiseContrast).add(EPS)),
          n,
        );
        const breakup = mix(uWakeBreakup.oneMinus(), float(1), patch);

        // --- 0. bow mound: the displacement bow wave, the one feature FORWARD
        //     of the stem, so it sits outside `clip`. Evaluated in the live
        //     stem frame (it has to lead the ship) but injected into the
        //     world-anchored accumulation, so from the next frame on it is
        //     ordinary trail and never re-orients. Mirror: wakeMath.bowMoundCpu
        const ms = uMoundSpeed;
        const mGate = smoothstep(uSpeedThreshold, uSpeedThreshold.mul(2).max(uSpeedThreshold.add(EPS)), ms);
        const mSf = smoothstep(uSpeedThreshold, uFullWakeSpeed.max(uSpeedThreshold.add(EPS)), ms);
        const hd = worldXZ.sub(vec2(uHead.x, uHead.y));
        const mAhead = hd.x.mul(uHead.z).add(hd.y.mul(uHead.w));
        const mAside = hd.x.mul(uHead.w).sub(hd.y.mul(uHead.z)).abs();
        // signed distance from the crest, which sweeps aft as it goes outboard
        const dc = mAhead.sub(uMoundLead.sub(uMoundSweep.mul(mAside)));
        // thin on the leading face, moundFill× thicker behind — fills the gap
        // back to the hull so nothing forward of the stem reads undisturbed
        const thick = select(dc.greaterThanEqual(0), uMoundThick, uMoundThick.mul(uMoundFill));
        const mound = uMoundIntensity
          .mul(ms)
          .mul(mSf)
          .mul(mGate)
          .mul(fadeTo(thick, dc.abs()))
          .mul(fadeTo(uMoundSpan, mAside));

        // the mound skips `breakup` on purpose: the user asked for a CONSTANT
        // reaction at the stem, and gappy noise makes it flicker in and out
        rate.assign(
          cut
            .add(bow)
            .add(shoulder)
            .add(stern)
            .add(vortex)
            .mul(gate)
            .mul(tail)
            .mul(clip)
            .mul(breakup)
            .add(mound),
        );
      });
      return rate;
    },

    /**
     * Per-tick ship state; geometry offsets come from the blueprint AABBs.
     * Records the CUTWATER pose (ship origin + forward·bowOffset) — the wake
     * is generated at the stem, so that is the curve the whole field hangs off.
     * Signature unchanged from the ship-local version (main.ts untouched).
     */
    setShip(
      pos: [number, number],
      yaw: number,
      speed: number,
      bowOffset: number,
      sternOffset: number,
      beam: number,
    ): void {
      const fx = Math.sin(yaw);
      const fz = Math.cos(yaw);
      pose.x = pos[0] + fx * bowOffset;
      pose.z = pos[1] + fz * bowOffset;
      pose.fx = fx;
      pose.fz = fz;
      pose.speed = speed;
      hull.length = Math.max(bowOffset - sternOffset, EPS);
      hull.beam = Math.max(beam, EPS);
    },

    /** exposed for tests/debug: the live world-space history (index 0 = newest) */
    get trackSamples() {
      return track.samples;
    },

    /**
     * Age the world-space history, lay a new sample if the ship has travelled
     * far enough, and upload the polyline + its AABB. Called once per tick from
     * index.update BEFORE the compute passes.
     */
    advance(dt: number): void {
      // the mound rides a LAGGED speed so it builds and subsides with the
      // hull's motion instead of snapping to a throttle value (user review)
      moundSpeed = approachExp(moundSpeed, pose.speed, dt, p.moundLag);
      uMoundSpeed.value = moundSpeed;
      advanceTrack(track, pose, dt, {
        capacity: TRACK_CAPACITY,
        spacing: Math.max(p.trackSpacing, EPS),
        life: Math.max(p.trackLife, EPS),
        minSpeed: p.speedThreshold,
        maxTurn: (Math.max(p.trackTurn, EPS) * Math.PI) / 180,
        coarsen: Math.max(p.trackCoarsen, EPS),
        coarsenStart: Math.max(p.trackCoarsenStart, 0),
      });
      const pts = trackPoints(track, pose);
      const count = Math.min(pts.length, TRACK_SLOTS);
      for (let i = 0; i < TRACK_SLOTS; i++) {
        const s = i < count ? pts[i] : undefined;
        if (s) {
          posVecs[i].set(s.x, s.z, s.fx, s.fz);
          metaVecs[i].set(s.age, s.dist, s.speed, 0);
        } else {
          posVecs[i].set(0, 0, 0, 1);
          metaVecs[i].set(0, 0, 0, 0);
        }
      }
      uTrackCount.value = count;
      uHead.value.set(pose.x, pose.z, pose.fx, pose.fz);

      const maxDist = count >= 2 ? pts[count - 1].dist : 0;
      const bounds = trackBounds(pts.slice(0, count), wakeReachCpu(maxDist, hull, p));
      if (bounds) {
        uTrackMin.value.set(bounds.minX, bounds.minZ);
        uTrackMax.value.set(bounds.maxX, bounds.maxZ);
      } else {
        // degenerate track: empty AABB so the loop is skipped entirely
        uTrackMin.value.set(1, 1);
        uTrackMax.value.set(-1, -1);
      }
    },

    /** push live param values (called from index.update each tick, §V16) */
    pushParams(): void {
      uKelvinTan.value = Math.tan((p.kelvinAngle * Math.PI) / 180);
      uHullLength.value = hull.length;
      uBeam.value = hull.beam;
      uBowIntensity.value = p.bowIntensity;
      uArmWidth.value = p.armWidth;
      uArmWidthGrowth.value = p.armWidthGrowth;
      uArmWidthMax.value = p.armWidthMax;
      uAftSpreadCap.value = p.aftSpreadCap;
      uShoulderIntensity.value = p.shoulderIntensity;
      uShoulderLength.value = p.shoulderLength;
      uShoulderPush.value = p.shoulderPush;
      uShoulderWidth.value = p.shoulderWidth;
      uShoulderEntry.value = p.shoulderEntry;
      uHullBoost.value = p.hullBoost;
      uHullBoostDist.value = p.hullBoostDist;
      uBowLife.value = p.bowLife;
      uCutIntensity.value = p.cutIntensity;
      uCutWidth.value = p.cutWidth;
      uCutLength.value = p.cutLength;
      uSternIntensity.value = p.sternIntensity;
      uSternWidth.value = p.sternWidth;
      uSternSpread.value = p.sternSpread;
      uSternLife.value = p.sternLife;
      uSternOnset.value = p.sternOnset;
      uVortexIntensity.value = p.vortexIntensity;
      uVortexOffset.value = p.vortexOffset;
      uVortexSpread.value = p.vortexSpread;
      uVortexWidth.value = p.vortexWidth;
      uVortexSpacing.value = p.vortexSpacing;
      uVortexLife.value = p.vortexLife;
      uSpeedThreshold.value = p.speedThreshold;
      uFullWakeSpeed.value = p.fullWakeSpeed;
      uTrackLife.value = p.trackLife;
      uTrackCapDist.value = trackReachCpu({
        capacity: TRACK_CAPACITY,
        spacing: Math.max(p.trackSpacing, EPS),
        coarsen: Math.max(p.trackCoarsen, EPS),
        coarsenStart: Math.max(p.trackCoarsenStart, 0),
        life: p.trackLife,
        minSpeed: p.speedThreshold,
        maxTurn: 1,
      });
      uTailFade.value = p.tailFade;
      uBowClip.value = p.bowClip;
      uMoundIntensity.value = p.moundIntensity;
      uMoundLead.value = p.moundLead;
      uMoundSweep.value = p.moundSweep;
      uMoundSpan.value = p.moundSpan;
      uMoundThick.value = p.moundThick;
      uMoundFill.value = p.moundFill;
      uWakeNoiseScale.value = p.wakeNoiseScale;
      uWakeNoiseContrast.value = p.wakeNoiseContrast;
      uWakeBreakup.value = p.wakeBreakup;
    },
  };
}

export type WakeInjector = ReturnType<typeof createWakeInjector>;
