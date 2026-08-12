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
import { float, smoothstep, uniform, vec2, vec3 } from 'three/tsl';
import { GRAVITY, KELVIN_R_MAX, KELVIN_TAN_MAX } from './slickMath';
import type { FlowFoamParams } from '../params/flowfoam';

/** floor for divisors and smoothstep spans (§V28) */
const EPS = 1e-6;

/** extremum of −2u·e^(−u²) — normalises the mound slope to exactly ±moundSlope */
const RIDGE_PEAK = Math.SQRT2 * Math.exp(-0.5);

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
  const uSpeedThreshold = uniform(p.speedThreshold);

  return {
    /**
     * vec3(slickRate, slopeX, slopeZ) at one texel.
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

      if (!detail) return vec3(slick, 0, 0);

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
      const magT = uTransSlope
        .mul(f.sf)
        .mul(f.envelope)
        .mul(innerFade)
        .mul(f.age.div(uTransDecay.max(EPS)).negate().exp())
        .mul(spreadOf(uTransSpread))
        .mul(bandOf(tT))
        .mul(phaseOf(tT).sin());

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

      const slope = dirOf(tT).mul(magT).add(dirOf(tD).mul(magD));
      return vec3(slick, slope.x, slope.y);
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
      const ridge = u.mul(-2).mul(u.mul(u).negate().exp()).div(RIDGE_PEAK);
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
      return grad.div(grad.length().max(EPS)).mul(mag);
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
 * rather than a uniform.
 */
export function bandKeepNode(pixWorld: any, texelWorld: any, full: any, cut: any): any {
  const px = pixWorld.max(0).div(texelWorld.max(EPS));
  const f = full.max(EPS);
  // smoothstep(e0, e1, x) with e0 > e1 reads "1 below e1, 0 above e0" (§V23)
  return smoothstep(cut.max(f.add(EPS)), f, px);
}
