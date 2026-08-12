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
import { float, smoothstep, uniform, vec3 } from 'three/tsl';
import { GRAVITY } from './slickMath';
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
  /** tail × clip × liveGate — the foam pass's own eviction/clip envelope */
  envelope: any;
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

      // --- 2. transverse Kelvin crests: λ = 2πv²/g ⟹ φ = g·d/v² -------------
      // Speed-DEPENDENT wavelength (the wedge angle is not — see slickMath).
      const v = f.speed.max(uSpeedThreshold).max(EPS);
      const phase = f.d.mul(GRAVITY).div(v.mul(v));
      // inside the wedge only, strongest on the centreline
      const e0 = f.kelvin.mul(uTransInner);
      const wedge = smoothstep(e0, f.kelvin.max(e0.add(EPS)), f.ay).oneMinus();
      const amp = uTransSlope
        .mul(f.sf)
        .mul(f.envelope)
        .mul(wedge)
        .mul(f.age.div(uTransDecay.max(EPS)).negate().exp())
        // energy spreads over a widening front: amplitude ~ 1/√(1 + d/L)
        .div(float(1).add(f.d.div(uTransSpread.max(EPS))).sqrt().max(EPS));
      // crests run ACROSS the track ⟹ the slope points ALONG it
      const mag = amp.mul(phase.sin());
      return vec3(slick, mag.mul(f.fwd.x), mag.mul(f.fwd.y));
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
