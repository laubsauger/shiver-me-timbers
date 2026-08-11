/**
 * Analytic ship wake injector (§V10 follow-up): bow V at the Kelvin angle +
 * stern turbulence band, ADDED on top of the ortho-capture injection inside
 * the accumulation advect pass (accumulation.ts composes:
 * foam = prev·decay + capture·injectStrength·dt + wakeRate·dt).
 *
 * Look rules from user review:
 * - SPEED DEVELOPMENT is strong: sf = smoothstep(threshold, fullWakeSpeed,
 *   speed) scales V-arm intensity and ALL widths/ranges. Slow drift = faint
 *   narrow stern churn only (stern term is NOT ×sf, but is ∝ speed² and
 *   width-scaled); full sail = narrow cut at the stem opening into the V.
 * - NO painted-on stripes: the envelope is multiplied by a world-anchored
 *   fbm breakup factor (gappy, feathered patches that stay in the water as
 *   the ship sweeps through).
 * - Injection is local (fades over the scaled wakeRange); flow advection,
 *   decay and progressive blur do the trailing/spreading.
 *
 * MIRROR CONTRACT: flowMath.wakeEnvelopeCpu / wakeBreakupCpu / wakeRateCpu /
 * bowArmDistCpu / shipLocalCpu are the exact CPU formulas (tested) — change
 * one side → change the other.
 *
 * main.ts feeds per tick (yaw = atan2(fwd.x, fwd.z) of ship local +z):
 *   ff.setShip([ship.x, ship.z], yaw, speedOverWater,
 *              bowOffset, sternOffset, beam);  // offsets from blueprint AABB
 *
 * §V23: functional 3-arg smoothstep/mix only; chained `x.step(edge)` reads
 * step(edge, x) and is commented at each use site.
 */
import * as THREE from 'three/webgpu';
import { float, mix, smoothstep, uniform, vec2 } from 'three/tsl';
import { fbm2 } from '../terrain/noise';
import { FLOW_OCTAVES } from './flowMath';
import { INV_SQRT2 } from './wakeMath';
import type { FlowFoamParams } from '../params/flowfoam';

export function createWakeInjector(p: FlowFoamParams) {
  const uShipPos = uniform(new THREE.Vector2(0, 0));
  /** forward = (sin yaw, cos yaw) — precomputed CPU-side from yaw */
  const uFwd = uniform(new THREE.Vector2(0, 1));
  const uSpeed = uniform(0);
  const uBowOffset = uniform(0);
  const uSternOffset = uniform(0);
  const uBeam = uniform(2);
  const uKelvinTan = uniform(Math.tan((p.kelvinAngle * Math.PI) / 180));
  const uBowIntensity = uniform(p.bowIntensity);
  const uSternIntensity = uniform(p.sternIntensity);
  const uSpeedThreshold = uniform(p.speedThreshold);
  const uFullWakeSpeed = uniform(p.fullWakeSpeed);
  const uSlowWakeWidth = uniform(p.slowWakeWidth);
  const uArmWidth = uniform(p.armWidth);
  const uArmWidthGrowth = uniform(p.armWidthGrowth);
  const uSternWidth = uniform(p.sternWidth);
  const uWakeRange = uniform(p.wakeRange);
  const uWakeNoiseScale = uniform(p.wakeNoiseScale);
  const uWakeNoiseContrast = uniform(p.wakeNoiseContrast);
  const uWakeBreakup = uniform(p.wakeBreakup);

  return {
    /**
     * TSL wake injection rate (foam/second) at a world-XZ node.
     * CPU mirror: flowMath.wakeRateCpu (envelope × breakup).
     */
    wakeRateNode(worldXZ: any): any {
      // on/off feather over [threshold, 2·threshold] — exactly 0 at anchor
      const gate = smoothstep(uSpeedThreshold, uSpeedThreshold.mul(2), uSpeed);
      // wake development: arms/widths/ranges all follow speed-through-water
      const sf = smoothstep(uSpeedThreshold, uFullWakeSpeed, uSpeed);
      const widthScale = mix(uSlowWakeWidth, float(1), sf);
      const range = uWakeRange.mul(widthScale);

      const d = worldXZ.sub(uShipPos);
      const along = d.dot(uFwd);
      // right = (fz, −fx) — forward rotated −90° about +y (shipLocalCpu twin)
      const across = d.dot(vec2(uFwd.y, uFwd.x.negate()));

      // bow V (flowMath.bowArmDistCpu): narrow cut at the stem, slow widening
      const sBow = uBowOffset.sub(along);
      const behindBow = sBow.step(0); // x.step(edge) = step(0, sBow): 1 when sBow ≥ 0
      const armDist = across.abs().sub(sBow.mul(uKelvinTan)).abs();
      const armW = uArmWidth.add(sBow.mul(uArmWidthGrowth)).mul(widthScale);
      const armMask = smoothstep(float(0), armW, armDist).oneMinus();
      const bowFade = smoothstep(float(0), range, sBow).oneMinus();
      // ×sf: a drifting ship cuts no V
      const bow = uBowIntensity.mul(uSpeed).mul(sf).mul(armMask).mul(bowFade).mul(behindBow);

      // stern churn: width ≈ beam·widthScale, ∝ speed², centerline-peaked
      const sStern = uSternOffset.sub(along);
      const behindStern = sStern.step(0); // x.step(edge) = step(0, sStern): 1 when sStern ≥ 0
      const halfW = uBeam.mul(uSternWidth).mul(0.5).mul(widthScale);
      const sternMask = smoothstep(float(0), halfW, across.abs()).oneMinus();
      const sternFade = smoothstep(float(0), range, sStern).oneMinus();
      const stern = uSternIntensity
        .mul(uSpeed)
        .mul(uSpeed)
        .mul(sternMask)
        .mul(sternFade)
        .mul(behindStern);

      // world-anchored breakup: gappy foam patches, not painted stripes.
      // Two lattice orientations (axis + 45°) hide the square value-noise
      // grid (flowMath.wakeBreakupCpu twin)
      const np = worldXZ.mul(uWakeNoiseScale);
      const rot = vec2(np.x.sub(np.y).mul(INV_SQRT2), np.x.add(np.y).mul(INV_SQRT2));
      const n = fbm2(np, FLOW_OCTAVES).add(fbm2(rot, FLOW_OCTAVES)).mul(0.5);
      const patch = smoothstep(
        float(0.5).sub(uWakeNoiseContrast),
        float(0.5).add(uWakeNoiseContrast),
        n,
      );
      const breakup = mix(uWakeBreakup.oneMinus(), float(1), patch);

      return bow.add(stern).mul(gate).mul(breakup);
    },

    /** per-tick ship state; geometry offsets come from the blueprint AABBs */
    setShip(
      pos: [number, number],
      yaw: number,
      speed: number,
      bowOffset: number,
      sternOffset: number,
      beam: number,
    ): void {
      uShipPos.value.set(pos[0], pos[1]);
      uFwd.value.set(Math.sin(yaw), Math.cos(yaw));
      uSpeed.value = speed;
      uBowOffset.value = bowOffset;
      uSternOffset.value = sternOffset;
      uBeam.value = beam;
    },

    /** push live param values (called from index.update each tick, §V16) */
    pushParams(): void {
      uKelvinTan.value = Math.tan((p.kelvinAngle * Math.PI) / 180);
      uBowIntensity.value = p.bowIntensity;
      uSternIntensity.value = p.sternIntensity;
      uSpeedThreshold.value = p.speedThreshold;
      uFullWakeSpeed.value = p.fullWakeSpeed;
      uSlowWakeWidth.value = p.slowWakeWidth;
      uArmWidth.value = p.armWidth;
      uArmWidthGrowth.value = p.armWidthGrowth;
      uSternWidth.value = p.sternWidth;
      uWakeRange.value = p.wakeRange;
      uWakeNoiseScale.value = p.wakeNoiseScale;
      uWakeNoiseContrast.value = p.wakeNoiseContrast;
      uWakeBreakup.value = p.wakeBreakup;
    },
  };
}

export type WakeInjector = ReturnType<typeof createWakeInjector>;
