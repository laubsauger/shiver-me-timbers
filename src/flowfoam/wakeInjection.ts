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
  vec3,
  vec4,
} from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { FLOW_OCTAVES } from './flowMath';
import { bowSlopeCpu, slickFieldCpu } from './slickMath';
import { createSlickInjector } from './slickInjection';
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
  const uBowDecay = uniform(p.bowDecay);
  const uCutIntensity = uniform(p.cutIntensity);
  const uCutWidth = uniform(p.cutWidth);
  const uCutLength = uniform(p.cutLength);
  const uSternIntensity = uniform(p.sternIntensity);
  const uSternWidth = uniform(p.sternWidth);
  const uSternWidthSlow = uniform(p.sternWidthSlow);
  const uBreakupSmoothAge = uniform(p.breakupSmoothAge);
  const uSternSpread = uniform(p.sternSpread);
  const uSternDecay = uniform(p.sternDecay);
  const uSternOnset = uniform(p.sternOnset);
  const uVortexIntensity = uniform(p.vortexIntensity);
  const uVortexOffset = uniform(p.vortexOffset);
  const uVortexSpread = uniform(p.vortexSpread);
  const uVortexWidth = uniform(p.vortexWidth);
  const uVortexSpacing = uniform(p.vortexSpacing);
  const uVortexDecay = uniform(p.vortexDecay);
  const uSpeedThreshold = uniform(p.speedThreshold);
  const uFullWakeSpeed = uniform(p.fullWakeSpeed);
  const uTrackLife = uniform(p.trackLife);
  /** capacity-limited track length (m) — the OTHER eviction edge to fade over */
  const uTrackCapDist = uniform(0);
  /**
   * Cutwater odometer (m), WRAPPED to one vortex period. `odo − dist` is the
   * odometer reading when a patch of water was passed, and it is constant at a
   * fixed world point (both grow by the same `moved` each frame) — that is what
   * anchors the shed eddies so they stay where they were shed instead of
   * marching astern with the ship (wakeTrack.WakeTrack.odo).
   *
   * Wrapped because the phase is 2π·odo/vortexSpacing: subtracting a whole
   * number of periods leaves it bit-identical while keeping the uniform small,
   * so an hour under sail cannot erode float precision. A live `vortexSpacing`
   * tweak shifts the phase once, on the frame it changes — a debug-slider
   * discontinuity, not a running error.
   */
  const uOdo = uniform(0);
  const uTailFade = uniform(p.tailFade);
  const uBowClip = uniform(p.bowClip);
  const uTrailInject = uniform(p.trailInject);
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

  // the wake's effect on the WATER (glassy lane + transverse crests). It rides
  // this module's track projection instead of walking the polyline itself —
  // that walk is the only expensive part and the foam already pays for it.
  const slick = createSlickInjector(p);

  const track = createWakeTrack();
  const pose: TrackPose = { x: 0, z: 0, fx: 0, fz: 1, speed: 0 };
  const hull: WakeHull = { length: 20, beam: 6 };
  let moundSpeed = 0;
  /**
   * THE EARLY-OUT AABB, held as ONE object both consumers read (§V.8).
   *
   * `wakeFieldNode` returns exactly 0 outside `uTrackMin/uTrackMax` — it is the
   * first thing the shader tests. `elevationCpu` must therefore return exactly 0
   * there too, or the mirror carries the exponential tails of the aft features
   * over a region the GPU zeroed outright. Both sides read THIS object rather
   * than each recomputing `trackBounds`, for the same reason the spectrum swap
   * is an identity check and not a matched countdown (§B.34, `3ad1212`): two
   * computations that must agree eventually stop agreeing.
   *
   * Degenerate (min > max) until the first `advance()` lays a track, so a query
   * before the ship has moved is 0 on both sides.
   */
  const aabb = { minX: 1, minZ: 1, maxX: -1, maxZ: -1 };

  /** falling edge: 1 at x = 0, 0 at x = e (§V23 functional smoothstep) */
  const fadeTo = (e: any, x: any): any => smoothstep(float(0), e.max(EPS), x).oneMinus();
  /** true dissipation exp(−a/τ) — see wakeMath.dissipate for why not smoothstep */
  const dissipate = (tau: any, a: any): any => a.div(tau.max(EPS)).negate().exp();

  return {
    /**
     * TSL wake field at a world-XZ node. Returns `{ rate, elev }`:
     *   rate.x = foam injection rate (foam/second) — mirror wakeMath.wakeRateCpu
     *   rate.y = slick coverage rate (1/second)    — mirror slickMath.slickFieldCpu
     *   rate.zw = wake world SLOPE (signed)        — same mirror
     *   elev   = wake world ELEVATION (m, signed)  — same mirror
     *
     * `elev` is the SCALAR POTENTIAL of `rate.zw` less the divergent train, so
     * it is the same field and not a second one — slickMath's header derives
     * each potential and states the two exclusions. It is stored in its own
     * texture rather than a channel because all four of the accumulation's are
     * spoken for, and it is read ONLY by the ocean's VERTEX stage (§V.40: the
     * fragment ledger does not move).
     *
     * ONE polyline walk feeds all five. `detail = false` (the far tier) drops
     * both wave trains, the bow mound's slope AND the elevation, all of which
     * are below Nyquist at 2.5 m per texel. `texel` is the tier's own world
     * texel size — every periodic term is band-limited against it AT THE
     * SOURCE (§V48).
     */
    wakeFieldNode(worldXZ: any, detail = true, texel: any = float(0.25)): any {
      const rate = vec4(0, 0, 0, 0).toVar();
      const elev = float(0).toVar();
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
        // the track's own forward at the winning segment — the transverse
        // crests run across it, so the slope they add points ALONG it
        const bestFwd = vec2(0, 1).toVar();
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
          bestFwd.assign(select(better, vec2(a.z, a.w), bestFwd));
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
          .mul(fadeTo(uCutLength, d))
          .mul(dissipate(uBowDecay, age));

        // 2. Kelvin arms — crest at dist·tanθ (speed-INDEPENDENT, as it must
        //    be), thickness capped so the V never swells into a wedge-shaped
        //    blob at the ranges the trail now reaches
        const kelvin = d.mul(uKelvinTan); // the envelope every aft feature obeys
        const armW = uArmWidth.add(uArmWidthGrowth.mul(d)).min(uArmWidthMax);
        // dilution: a crest spread wider carries the same water more thinly
        const arm = fadeTo(armW, ay.sub(kelvin).abs()).mul(uArmWidth.div(armW.max(EPS)));
        const boost = float(1).add(uHullBoost.mul(fadeTo(uHullBoostDist, d)));
        // sf SQUARED on the arms only — see wakeMath: a drifting ship must
        // show no lateral spread, only a little churn aft
        const bow = uBowIntensity
          .mul(s)
          .mul(sf)
          .mul(sf)
          .mul(arm)
          .mul(boost)
          .mul(dissipate(uBowDecay, age));

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
          .mul(shoulderHold)
          .mul(dissipate(uBowDecay, age));

        // aft features start only where the TRANSOM has passed (onset = 0 ahead)
        const ds = d.sub(uHullLength);
        const onset = smoothstep(float(0), uSternOnset.max(EPS), ds);
        const as = age.sub(uHullLength.div(s.max(uSpeedThreshold).max(EPS))).max(0);

        // nothing aft may pan out past the Kelvin wedge (see wakeMath)
        const aftCap = uBeam.mul(0.5).add(uAftSpreadCap.mul(kelvin));

        // 3. stern churn — wide flat centreline band, ∝ speed², spreads with AGE
        // envelope is speed-independent; the turbulent CORE is not (wakeMath)
        const churnW0 = uBeam
          .mul(0.5)
          .mul(uSternWidth)
          .mul(mix(uSternWidthSlow, float(1), sf));
        const churnW = churnW0.add(uSternSpread.mul(as)).min(aftCap);
        // LINEAR in speed (see wakeMath) so drift still churns aft; dilution
        // and exp dissipation so it thins and fades instead of ending hard
        const stern = uSternIntensity
          .mul(s)
          .mul(fadeTo(churnW, ay))
          .mul(churnW0.div(churnW.max(EPS)))
          .mul(dissipate(uSternDecay, as))
          .mul(onset);

        // 4. shed vortex pair — lobes off the transom corners, alternating
        //    port/starboard (§B.4: phased by track DISTANCE, per-position)
        const vOff = uBeam.mul(0.5).mul(uVortexOffset).add(uVortexSpread.mul(as)).min(aftCap);
        const side = select(bestLat.lessThan(0), float(Math.PI), float(0));
        const phase = ds.div(uVortexSpacing.max(EPS)).mul(Math.PI * 2).add(side);
        const puff = phase.sin().mul(0.5).add(0.5);
        const vortex = uVortexIntensity
          .mul(s)
          .mul(fadeTo(uVortexWidth, ay.sub(vOff).abs()))
          .mul(puff)
          .mul(dissipate(uVortexDecay, as))
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
        // coarsen with age toward the noise's own mean — old wake is a soft
        // wash, not stipple (wakeMath.wakeRateCpu twin)
        const rawBreakup = mix(uWakeBreakup.oneMinus(), float(1), patch);
        const coarse = smoothstep(float(0), uBreakupSmoothAge.max(EPS), age);
        const breakup = mix(rawBreakup, float(1).sub(uWakeBreakup.mul(0.5)), coarse);

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
        // a hove-to hull generates no wake — see wakeMath.wakeTrailCpu for why
        // this must gate on LIVE speed, not the speed each sample was laid at
        const liveGate = smoothstep(
          uSpeedThreshold,
          uSpeedThreshold.mul(2).max(uSpeedThreshold.add(EPS)),
          uMoundSpeed,
        );
        const foam = cut
          .add(bow)
          .add(shoulder)
          .add(stern)
          .add(vortex)
          .mul(gate)
          .mul(liveGate)
          .mul(tail)
          .mul(clip)
          .mul(breakup)
          // ONE scale on the whole trail so its coverage profile straddles the
          // ocean's dissolve gate instead of sitting above it — see
          // params/flowfoam.trailInject. The mound is added AFTER, on its own
          // dose arithmetic.
          .mul(uTrailInject)
          .add(mound);

        // the water's own response, off the SAME projection. It deliberately
        // shares tail/clip/liveGate with the foam (one wake, one envelope) and
        // deliberately does NOT take `breakup`: this feeds a slope the material
        // differentiates in screen space, so a stippled factor would come back
        // as per-pixel noise amplified by the wave normals (§V49).
        const sk = slick.slickFieldNode(
          {
            speed: s,
            sf,
            ay,
            d,
            age,
            kelvin,
            halfBeam: uBeam.mul(0.5),
            fwd: bestFwd,
            latSign: select(bestLat.lessThan(0), float(-1), float(1)),
            envelope: liveGate.mul(tail).mul(clip),
            texel,
            // world-anchored along-track coordinate of THIS water
            odo: uOdo.sub(d),
            onset,
          },
          detail,
        );
        // THE BOW MOUND AS A SURFACE (user: "we actually show the water pushed
        // forward"). Same live stem frame and same lagged drive as the foam
        // mound above, so paint and shape build and subside together — the
        // foam was being applied to a surface that was not actually deformed.
        // Summed into the SAME slope channels: the wake's effect on the water
        // is one vector field however many mechanisms contribute to it, so no
        // new channel and no new sampler (§V40 — the fragment stage is at
        // 16/16 and `wakeSlopeNode` already reads these two textures).
        const bowSlope = detail
          ? slick.bowSlopeNode({
              dc,
              thick: uMoundThick,
              aside: mAside,
              span: uMoundSpan,
              sweep: uMoundSweep,
              sgn: select(
                hd.x.mul(uHead.w).sub(hd.y.mul(uHead.z)).lessThan(0),
                float(-1),
                float(1),
              ),
              fwd: vec2(uHead.z, uHead.w),
              drive: mGate.mul(mSf),
              texel,
            })
          : vec3(0, 0, 0);
        rate.assign(vec4(foam, sk.x, sk.y.add(bowSlope.x), sk.z.add(bowSlope.y)));
        // one surface, so its elevation sums exactly as its slope does
        elev.assign(sk.w.add(bowSlope.z));
      });
      return { rate, elev };
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
     * ── THE §V.8 MIRROR OF `elev` ────────────────────────────────────────────
     * Wake surface elevation (m) at a world XZ, on the CPU, from the SAME track
     * polyline, the SAME lagged mound speed and the SAME wrapped odometer the
     * compute pass is handed this tick. Not an approximation of the GPU field —
     * the same two functions (`slickFieldCpu`, `bowSlopeCpu`) whose TSL twins
     * `slickFieldNode`/`bowSlopeNode` are, which is the contract the rest of
     * this module already lives under.
     *
     * THREE THINGS THAT MAKE THIS AGREE RATHER THAN MERELY MATCH, and each of
     * them is a way §B.34 could arrive again:
     *  (a) `liveSpeed` is `moundSpeed`, the LAGGED speed — not `pose.speed`.
     *      The shader's `liveGate` is built on `uMoundSpeed`; handing the raw
     *      pose speed here would gate the two sides differently through every
     *      acceleration, which is most of the time a player is sailing.
     *  (b) `odo` is the WRAPPED odometer, the identical float the uniform got
     *      in `advance()` this tick, so the two vortex streets sit at one phase.
     *  (c) `texel` is the NEAR tier's, because the near tier is the only one
     *      that writes elevation — the §V48 band gates inside the formulas must
     *      see the grid the value is actually stored on.
     *  (d) the AABB early-out is the SAME object the uniforms were set from
     *      this tick (see `aabb`), so "outside the wake" is one decision rather
     *      than two agreeing ones.
     *
     * RESIDUAL AGAINST THE GPU — MEASURED, and NOT sub-millimetre. The shader
     * evaluates at texel CENTRES and the material bilinearly interpolates, while
     * this evaluates exactly at the query point, so the residual is that
     * reconstruction error. Over a full manoeuvre (tests/wakeSea.test.ts):
     *
     *   ahead of the cutwater      0.007 m
     *   0-2 m astern (the APEX)    0.311 m   ← NOT small; see below
     *   2-4 m astern               0.043 m
     *   4 m and beyond             0.041 m,  RMS over all of it 0.004 m
     *
     * THE APEX IS SUB-TEXEL AND IT IS THE FIELD'S OWN PROPERTY, not the
     * mirror's. `slickFieldCpu`'s `innerFade` confines the transverse train to
     * the Kelvin wedge, so its full-amplitude half-width is 0.265·d — 0.13 m at
     * d = 0.5 m, half a texel, while the elevation it carries there is the full
     * a/k ≈ 0.30 m. A 0.234 m grid cannot hold a 0.3 m notch a quarter of a
     * metre wide; the drawn surface smooths it and this does not. §V.48's own
     * cure applies (fade a term where its FEATURE, not its period, goes
     * sub-texel) and WOULD be mirrorable — the texel belongs to the region, not
     * to the camera, unlike the vertex-spacing gate this module's header rules
     * out — but it changes the drawn bow wave, so it is STATED here and left to
     * the owner rather than taken unilaterally.
     *
     * `smithDepth` > 0 asks the §V.68 question instead of the geometric one:
     * see slickMath.smithAtten. Callers other than buoyancy want 0.
     */
    elevationCpu(wx: number, wz: number, smithDepth = 0): number {
      // the shader's own first test, off the same numbers — see `aabb`
      if (wx < aabb.minX || wx > aabb.maxX || wz < aabb.minZ || wz > aabb.maxZ) return 0;
      const pts = trackPoints(track, pose);
      if (pts.length < 2) return 0;
      const texel = p.regionSize / Math.max(p.resolution, 1);
      const period = Math.max(p.vortexSpacing, EPS);
      const odo = track.odo - Math.floor(track.odo / period) * period;
      const sk = slickFieldCpu(pts, wx, wz, hull, p, moundSpeed, texel, odo, smithDepth);
      const bow = bowSlopeCpu(pts[0], wx, wz, moundSpeed, p, texel, smithDepth);
      return sk.elev + bow.elev;
    },

    /**
     * The LAGGED stem speed (m/s) the bow mound rides — both its foam and its
     * slope. Published so bow SPRAY can key off the same number instead of
     * deriving its own: the user wants spray "whenever we actually hit it", and
     * spray that fires on raw throttle while the mound builds on a lag
     * disagrees about when the bow is working. A strictly better shared signal
     * would be the hull-contact system's stem entry rate (immersion × closing
     * speed); this module would take it as an extra `setShip` argument.
     */
    get moundDrive(): number {
      return moundSpeed;
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
      // wrap to one period — see uOdo. Same `p.vortexSpacing` the shader gets
      // from pushParams() in this very tick, so the two cannot disagree.
      const period = Math.max(p.vortexSpacing, EPS);
      uOdo.value = track.odo - Math.floor(track.odo / period) * period;

      const maxDist = count >= 2 ? pts[count - 1].dist : 0;
      const bounds = trackBounds(pts.slice(0, count), wakeReachCpu(maxDist, hull, p));
      if (bounds) {
        aabb.minX = bounds.minX;
        aabb.minZ = bounds.minZ;
        aabb.maxX = bounds.maxX;
        aabb.maxZ = bounds.maxZ;
      } else {
        // degenerate track: empty AABB so the loop is skipped entirely
        aabb.minX = 1;
        aabb.minZ = 1;
        aabb.maxX = -1;
        aabb.maxZ = -1;
      }
      uTrackMin.value.set(aabb.minX, aabb.minZ);
      uTrackMax.value.set(aabb.maxX, aabb.maxZ);
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
      uBowDecay.value = p.bowDecay;
      uCutIntensity.value = p.cutIntensity;
      uCutWidth.value = p.cutWidth;
      uCutLength.value = p.cutLength;
      uSternIntensity.value = p.sternIntensity;
      uSternWidth.value = p.sternWidth;
      uSternWidthSlow.value = p.sternWidthSlow;
      uBreakupSmoothAge.value = p.breakupSmoothAge;
      uSternSpread.value = p.sternSpread;
      uSternDecay.value = p.sternDecay;
      uSternOnset.value = p.sternOnset;
      uVortexIntensity.value = p.vortexIntensity;
      uVortexOffset.value = p.vortexOffset;
      uVortexSpread.value = p.vortexSpread;
      uVortexWidth.value = p.vortexWidth;
      uVortexSpacing.value = p.vortexSpacing;
      uVortexDecay.value = p.vortexDecay;
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
      uTrailInject.value = p.trailInject;
      uMoundIntensity.value = p.moundIntensity;
      uMoundLead.value = p.moundLead;
      uMoundSweep.value = p.moundSweep;
      uMoundSpan.value = p.moundSpan;
      uMoundThick.value = p.moundThick;
      uMoundFill.value = p.moundFill;
      uWakeNoiseScale.value = p.wakeNoiseScale;
      uWakeNoiseContrast.value = p.wakeNoiseContrast;
      uWakeBreakup.value = p.wakeBreakup;
      slick.pushParams();
    },
  };
}

export type WakeInjector = ReturnType<typeof createWakeInjector>;
