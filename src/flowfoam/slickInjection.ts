/**
 * TSL twin of slickMath.ts — the wake's effect on the WATER (glassy lane +
 * transverse Kelvin crests), evaluated inside the accumulation advect pass.
 *
 * It does NOT walk the track itself: wakeInjection.ts already pays for the
 * polyline projection to place the foam, so this module takes the resulting
 * track-frame quantities and adds ~20 ALU ops on top. That is the whole reason
 * the slick lives in the same compute pass as the foam rather than in the ocean
 * material — per-fragment track walking would be unaffordable, and per-texel at
 * 0.23 m it is free.
 *
 * MIRROR CONTRACT: slickMath.slickFieldCpu is the exact CPU formula (tested).
 * Change one side → change the other.
 *
 * §V28: every divisor floored, every smoothstep span floored, no unbounded
 * term. §V44: |slope| ≤ transSlope and slick ≥ 0 by construction, at SOURCE.
 */
import { float, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import { GRAVITY, KELVIN_R_MAX, KELVIN_TAN_MAX, RIDGE_PEAK } from './slickMath';
import type { FlowFoamParams } from '../params/flowfoam';

/** floor for divisors and smoothstep spans (§V28) */
const EPS = 1e-6;

/**
 * Track-frame inputs, all already computed by the foam pass. Every field is a
 * TSL node (`any`, the same convention the rest of src/flowfoam uses).
 */
export interface SlickFrame {
  /** speed (m/s) the hull had at the projection */
  speed: any;
  /** smoothstep(speedThreshold, fullWakeSpeed, speed) */
  sf: any;
  /** |lateral offset| (m) from the track */
  ay: any;
  /** arclength (m) forward to the live cutwater */
  d: any;
  /** seconds since the cutwater passed */
  age: any;
  /** d·tan(kelvinAngle) — the wedge half-width, already to hand */
  kelvin: any;
  /** hull half-beam (m) */
  halfBeam: any;
  /** unit track forward (world XZ) at the projection */
  fwd: any;
  /** +1 if the point is to starboard of the track, −1 to port */
  latSign: any;
  /** tail × clip × liveGate — the foam pass's own eviction/clip envelope */
  envelope: any;
  /** world size (m) of one texel of the tier being written — the §V48 yardstick */
  texel: any;
  /**
   * WORLD-ANCHORED along-track coordinate (m) of this water: the odometer
   * reading when the cutwater passed it (`track.odo − dist`). Constant at a
   * fixed world point, which is what lets a shed eddy stay where it was shed —
   * see wakeTrack.WakeTrack.odo for why `dist` cannot do this job.
   */
  odo: any;
  /** smoothstep(0, sternOnset, dist − hullLength): 0 until the transom passes */
  onset: any;
}

/**
 * Live stem-frame inputs for the bow mound's SLOPE. wakeInjection has already
 * built every one of these for the foam mound, so this reuses them rather than
 * duplicating the uniforms.
 */
export interface BowFrame {
  /** signed distance (m) from the swept crest line; + = ahead of the crest */
  dc: any;
  /** fore-aft thickness (m) of the ridge */
  thick: any;
  /** |lateral offset| (m) from the stem */
  aside: any;
  /** outboard half-extent (m) of the mound */
  span: any;
  /** crest aft-sweep per metre outboard */
  sweep: any;
  /** +1 starboard, −1 port */
  sgn: any;
  /** live stem forward (world XZ) */
  fwd: any;
  /** gate × sf on the LAGGED mound speed — the same drive the foam mound rides */
  drive: any;
  /** world size (m) of one texel of the tier being written */
  texel: any;
}

export function createSlickInjector(p: FlowFoamParams) {
  const uSlickIntensity = uniform(p.slickIntensity);
  const uSlickWidth = uniform(p.slickWidth);
  const uSlickSpread = uniform(p.slickSpread);
  const uSlickSpreadCap = uniform(p.slickSpreadCap);
  const uSlickDecay = uniform(p.slickDecay);
  const uSlickEdge = uniform(p.slickEdge);
  const uTransSlope = uniform(p.transSlope);
  const uTransDecay = uniform(p.transDecay);
  const uTransSpread = uniform(p.transSpread);
  const uTransInner = uniform(p.transInner);
  const uDivSlope = uniform(p.divSlope);
  const uDivDecay = uniform(p.divDecay);
  const uDivSpread = uniform(p.divSpread);
  const uDivOuterFade = uniform(p.divOuterFade);
  const uWaveBandLow = uniform(p.waveBandLow);
  const uWaveBandHigh = uniform(p.waveBandHigh);
  const uMoundSlope = uniform(p.moundSlope);
  const uEddySlope = uniform(p.eddySlope);
  const uEddyRadius = uniform(p.eddyRadius);
  const uVortexOffset = uniform(p.vortexOffset);
  const uVortexSpacing = uniform(p.vortexSpacing);
  const uVortexDecay = uniform(p.vortexDecay);
  const uSpeedThreshold = uniform(p.speedThreshold);

  return {
    /**
     * vec4(slickRate, slopeX, slopeZ, elevation) at one texel.
     *
     * `.w` is the SCALAR WHOSE GRADIENT IS `.yz`, less the divergent train —
     * slickMath's header derives all four potentials and states why the
     * divergent branch is shading-only and why the remainder needs no Nyquist
     * gate. It is what the ocean's vertex stage displaces by and what the CPU
     * mirror adds to `heightAt`, so the drawn wake and the floated wake are one
     * expression (§V.8).
     *
     * `detail` = false drops the transverse crests entirely. The FAR tier is
     * 2.5 m per texel and the shortest transverse wavelength in play is 5.8 m
     * (3 m/s), i.e. 2.3 texels per wave — below Nyquist, so writing it there
     * would be pure aliasing (§V48). The lane, being a smooth several-metre
     * feature, is fine at that resolution and is carried by both tiers.
     */
    slickFieldNode(f: SlickFrame, detail: boolean): any {
      // --- 1. the glassy lane: flat core, soft shoulder, NO breakup noise ---
      // capped by the Kelvin wedge so the lane can never be wider than the wake
      const laneW = f.halfBeam
        .mul(uSlickWidth)
        .add(uSlickSpread.mul(f.age))
        .min(f.halfBeam.add(uSlickSpreadCap.mul(f.kelvin)))
        .max(EPS);
      const inner = laneW.mul(uSlickEdge.clamp(0, 1).oneMinus());
      const lane = smoothstep(inner, laneW.max(inner.add(EPS)), f.ay).oneMinus();
      const slick = uSlickIntensity
        .mul(f.sf)
        .mul(f.envelope)
        .mul(lane)
        .mul(f.age.div(uSlickDecay.max(EPS)).negate().exp());

      if (!detail) return vec4(slick, 0, 0, 0);

      // --- 2. BOTH Kelvin wave systems, from ONE stationary-phase solve -----
      // 2r·t² − t + r = 0, r = |lat|/dist ⟹ t = [1 ± √(1−8r²)]/(4r). The minus
      // root is the transverse train, the plus root is the DIVERGENT train —
      // the bow wave. Real only inside 19.4712°, so the Kelvin envelope falls
      // out of the algebra. Full derivation: slickMath.kelvinBranchesCpu.
      const v = f.speed.max(uSpeedThreshold).max(EPS);
      const kk = float(GRAVITY).div(v.mul(v)); // g/v²
      const r = f.ay.div(f.d.max(EPS));
      const rf = r.max(EPS); // §V28: the ± root divides by r
      const disc = float(1).sub(rf.mul(rf).mul(8)).max(0).sqrt();
      // 2r/(1+disc), NOT (1−disc)/(4r): algebraically identical, but the latter
      // is 0/0 on the centreline where the transverse train is strongest
      const tT = rf.mul(2).div(disc.add(1).max(EPS));
      // the divergent root runs to ∞ on the centreline (λ → 0 there). Clamped
      // because 0 × NaN is NaN, not 0 — the band gate below is already 0 by
      // then, but only a FINITE phase can be multiplied by it (§V44).
      const tD = disc.add(1).div(rf.mul(4).max(EPS)).min(KELVIN_TAN_MAX);

      // φ = (g/v²)(d + |y|t)√(1+t²);  λ = 2πv²/(g(1+t²))
      const sq = (t: any) => float(1).add(t.mul(t));
      const phaseOf = (t: any) => kk.mul(f.d.add(f.ay.mul(t))).mul(sq(t).sqrt());
      // §V48 AT THE SOURCE: fade a train to its own mean (zero — it is a
      // zero-mean crest field) once its wavelength goes sub-texel. This is what
      // makes the divergent branch's centreline singularity harmless.
      const bandOf = (t: any) =>
        smoothstep(
          uWaveBandLow,
          uWaveBandHigh.max(uWaveBandLow.add(EPS)),
          float(Math.PI * 2).mul(v).mul(v).div(float(GRAVITY).mul(sq(t))).div(f.texel.max(EPS)),
        );
      const spreadOf = (L: any) => float(1).add(f.d.div(L.max(EPS))).sqrt().max(EPS).reciprocal();
      // propagation is aft·cosθ + lateral·sinθ; the slope points along it
      const aft = f.fwd.negate();
      const right = vec2(f.fwd.y, f.fwd.x.negate()).mul(f.latSign);
      const dirOf = (t: any) => {
        const c = sq(t).sqrt().max(EPS).reciprocal();
        return aft.mul(c).add(right.mul(t.mul(c)));
      };

      // 2a. transverse — long crests across the track, peak on the centreline
      const e0 = f.kelvin.mul(uTransInner);
      const innerFade = smoothstep(e0, f.kelvin.max(e0.add(EPS)), f.ay).oneMinus();
      const ampT = uTransSlope
        .mul(f.sf)
        .mul(f.envelope)
        .mul(innerFade)
        .mul(f.age.div(uTransDecay.max(EPS)).negate().exp())
        .mul(spreadOf(uTransSpread))
        .mul(bandOf(tT))
        .toVar();
      // +π: a CREST at the stem, not a trough — the bow is a stagnation region,
      // not a pressure point. Mirror of slickMath.slickFieldCpu (§T.82), where
      // the reasoning lives; the shift moves sin and cos together so ∇η = slope.
      const phiT = phaseOf(tT).add(Math.PI);
      const magT = ampT.mul(phiT.sin());
      // η = −(a/k)·cos φ, k = |∇φ| = (g/v²)(1+t²) — the potential of the line
      // above, so amplitude = slope·λ/2π falls out instead of being a knob
      const kT = float(GRAVITY).mul(sq(tT)).div(v.mul(v)).max(EPS);
      const elevT = ampT.negate().mul(phiT.cos()).div(kT);

      // 2b. DIVERGENT — the bow wave. sf SQUARED (f.envelope carries one sf,
      // this adds the second), matching the foam arms' own shaping: the user
      // asks for this "at higher speeds", and a hull barely making way throws
      // no bow wave at all. Fades just OUTSIDE the cusp rather than stepping —
      // a hard edge in a differentiated field is a 1-px line (§V38).
      const outer = smoothstep(
        float(KELVIN_R_MAX),
        float(KELVIN_R_MAX).mul(uDivOuterFade.max(EPS).add(1)),
        r,
      ).oneMinus();
      const magD = uDivSlope
        .mul(f.sf)
        .mul(f.sf)
        .mul(f.envelope)
        .mul(outer)
        .mul(f.age.div(uDivDecay.max(EPS)).negate().exp())
        .mul(spreadOf(uDivSpread))
        .mul(bandOf(tD))
        .mul(phaseOf(tD).sin());

      // --- 3. SHED EDDIES: the vortex street as a SURFACE, not as paint ----
      // The street was already here and already right — a von Kármán pair
      // alternating port/starboard π out of phase, shed at the transom corners
      // `vortexSpacing` apart — and every bit of it went to the ALBEDO. Nothing
      // rotational ever reached the normal, so the water the hull actually
      // stirred read as white paint on an undisturbed surface (user: the wake
      // "really doesn't" disturb the specular). This connects that feature; it
      // does not invent one, which is also why there is no fbm here and no
      // scale that did not come from the hull: 11 m spacing, 8.5 m beam.
      //
      // Each eddy is a Gaussian surface DIMPLE whose slope is radial, using the
      // same normalised derivative the bow mound does — so one core peaks at
      // exactly `eddySlope` and the street at 2× that, by construction rather
      // than by a clamp (§V44 at source; accumulation's ±1 is only a backstop).
      //
      // BOTH CORES ARE SUMMED, and that is not an optimisation left on the
      // table. Evaluating only the core on the query point's own side makes the
      // field discontinuous across the centreline, where `latSign` flips — and
      // a step in a field the ocean differentiates in screen space is a 1-px
      // line (§V38), the same defect the divergent train's outer feather exists
      // to avoid. Summed, the two counter-rotating cores meet continuously.
      const coreR = f.halfBeam.mul(uEddyRadius).max(EPS);
      const vOff = f.halfBeam.mul(uVortexOffset);
      // SIGNED lateral, and the UNSIGNED right axis to go with it: the street
      // lives in the track's own frame, not in a per-point mirrored one
      const latS = f.ay.mul(f.latSign);
      const rightAbs = vec2(f.fwd.y, f.fwd.x.negate());
      // vec3(slopeX, slopeZ, η/magE). The potential −coreR·e^(−u²)/RIDGE_PEAK
      // differentiates radially back into the 2u·e^(−u²) profile above, so the
      // dimple the eye sees IS the dimple the shading solves. Negative because
      // a vortex core is a depression.
      const core = (off: any, phase: any): any => {
        const qE = f.odo.sub(phase).div(uVortexSpacing.max(EPS));
        // q − round(q) ∈ [−½, ½] → signed distance to the NEAREST core
        const dAlong = qE.sub(qE.add(0.5).floor()).mul(uVortexSpacing);
        const dAcross = latS.sub(off);
        const rE = vec2(dAlong, dAcross).length();
        const uE = rE.div(coreR);
        const bell = uE.mul(uE).negate().exp();
        // 2u·e^(−u²) over its own extremum: peak exactly 1 at u = 1/√2
        const prof = uE.mul(2).mul(bell).div(RIDGE_PEAK);
        const s = f.fwd.mul(dAlong).add(rightAbs.mul(dAcross)).div(rE.max(EPS)).mul(prof);
        return vec3(s.x, s.y, coreR.negate().mul(bell).div(RIDGE_PEAK));
      };
      // port lags starboard by half a period — the alternation IS the street
      const street = core(vOff, float(0)).add(
        core(vOff.negate(), uVortexSpacing.mul(0.5)),
      );
      // §V48 — measured against the FEATURE (a whole core, 2·coreR ≈ 7.6 m at
      // the shipped radius), never the texel. §V48(b): the mean this fades to
      // is ZERO, and for once the naive thing is the correct thing — a radial
      // dimple's slope field integrates to zero by symmetry, so the field's own
      // mean IS zero. Worth stating because it looks exactly like the mistake
      // of fading a non-zero-mean field to zero, and it is not one.
      const bandE = smoothstep(
        uWaveBandLow,
        uWaveBandHigh.max(uWaveBandLow.add(EPS)),
        coreR.mul(2).div(f.texel.max(EPS)),
      );
      const magE = uEddySlope
        .mul(f.sf)
        .mul(f.envelope)
        .mul(f.onset)
        // nothing aft may pan out past the Kelvin wedge — the same envelope
        // every aft feature obeys, and it is what keeps "outside the V there is
        // exactly nothing" true of the SURFACE and not just of the foam
        .mul(innerFade)
        .mul(f.age.div(uVortexDecay.max(EPS)).negate().exp())
        .mul(bandE);
      const slope = dirOf(tT).mul(magT).add(dirOf(tD).mul(magD)).add(street.xy.mul(magE));
      // .w: the divergent train is absent ON PURPOSE (slickMath header —
      // sub-Nyquist on the ocean mesh over the inner half of its own wedge)
      const elev = elevT.add(street.z.mul(magE));
      return vec4(slick, slope.x, slope.y, elev);
    },

    /**
     * THE BOW MOUND AS A SURFACE — vec2 world slope (user: "we actually show
     * the water pushed forward"). The foam mound paints white on this ridge;
     * without the ridge there is nothing under the paint, which is why the
     * water ahead of the stem has read undisturbed however much foam was on it.
     *
     * Slope = the derivative of a ridge across its own crest line,
     * −2u·e^(−u²) normalised by its extremum, so |slope| ≤ moundSlope by
     * CONSTRUCTION rather than by a clamp (§V44 bounded at source).
     * Mirror: slickMath.bowSlopeCpu.
     */
    bowSlopeNode(b: BowFrame): any {
      const u = b.dc.div(b.thick.max(EPS));
      const bell = u.mul(u).negate().exp();
      const ridge = u.mul(-2).mul(bell).div(RIDGE_PEAK);
      const lat = smoothstep(float(0), b.span.max(EPS), b.aside).oneMinus();
      // §V48: the ridge is ~2·thick wide — if that goes sub-texel, fade it
      const band = smoothstep(
        uWaveBandLow,
        uWaveBandHigh.max(uWaveBandLow.add(EPS)),
        b.thick.mul(2).div(b.texel.max(EPS)),
      );
      const mag = uMoundSlope.mul(b.drive).mul(lat).mul(band).mul(ridge);
      // ∇(distance from the crest) = forward + sweep·(signed lateral)
      const right = vec2(b.fwd.y, b.fwd.x.negate()).mul(b.sgn);
      const grad = b.fwd.add(right.mul(b.sweep));
      const len = grad.length().max(EPS);
      const s = grad.div(len).mul(mag);
      /**
       * .z — THE MOUND AS A RIDGE OF WATER (user: "we actually show the water
       * pushed forward"). η = A·e^(−u²), A = moundSlope·thick/(RIDGE_PEAK·|∇dc|),
       * so ∇η is EXACTLY the vector above. The |∇dc| divisor is not cosmetic:
       * the slope is written on the NORMALISED gradient, and without it shape
       * and shading disagree by a constant 1.35× at the shipped `moundSweep`.
       */
      const elev = uMoundSlope
        .mul(b.drive)
        .mul(lat)
        .mul(band)
        .mul(b.thick)
        .mul(bell)
        .div(float(RIDGE_PEAK).mul(len));
      return vec3(s.x, s.y, elev);
    },

    /** live param push (§V16), called from wakeInjection.pushParams */
    pushParams(): void {
      uSlickIntensity.value = p.slickIntensity;
      uSlickWidth.value = p.slickWidth;
      uSlickSpread.value = p.slickSpread;
      uSlickSpreadCap.value = p.slickSpreadCap;
      uSlickDecay.value = p.slickDecay;
      uSlickEdge.value = p.slickEdge;
      uTransSlope.value = p.transSlope;
      uTransDecay.value = p.transDecay;
      uTransSpread.value = p.transSpread;
      uTransInner.value = p.transInner;
      uDivSlope.value = p.divSlope;
      uDivDecay.value = p.divDecay;
      uDivSpread.value = p.divSpread;
      uDivOuterFade.value = p.divOuterFade;
      uWaveBandLow.value = p.waveBandLow;
      uWaveBandHigh.value = p.waveBandHigh;
      uMoundSlope.value = p.moundSlope;
      uEddySlope.value = p.eddySlope;
      uEddyRadius.value = p.eddyRadius;
      uVortexOffset.value = p.vortexOffset;
      uVortexSpacing.value = p.vortexSpacing;
      uVortexDecay.value = p.vortexDecay;
      uSpeedThreshold.value = p.speedThreshold;
    },
  };
}

/**
 * §V48 band-limit factor, TSL twin of slickMath.bandKeepCpu. Lives here rather
 * than in index.ts so the two halves of the pair sit in one file.
 *
 * `pixWorld` must be the caller's OWN `fwidth(worldXZ)` footprint — the
 * material is the only place that knows it, which is why this is a node factory
 * rather than a uniform. `featureWorld` is the FINEST FEATURE the texture
 * holds (`texel × waveBandLow`), never one texel — see slickMath.bandKeepCpu
 * for what keying it to the storage grid cost.
 */
export function bandKeepNode(pixWorld: any, featureWorld: any, full: any, cut: any): any {
  const px = pixWorld.max(0).div(featureWorld.max(EPS));
  const f = full.max(EPS);
  // smoothstep(e0, e1, x) with e0 > e1 reads "1 below e1, 0 above e0" (§V23)
  return smoothstep(cut.max(f.add(EPS)), f, px);
}
