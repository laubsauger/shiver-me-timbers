/**
 * Analytic ship wake injector (§V10 follow-up): bow V at the Kelvin angle +
 * stern turbulence band, ADDED on top of the ortho-capture injection inside
 * the accumulation advect pass (composition happens in accumulation.ts:
 * foam = prev·decay + capture·injectStrength·dt + wakeRate·dt). Injection is
 * deliberately local (fades over wakeRange) — the existing flow advection,
 * decay and progressive blur do the long trailing/spreading naturally.
 *
 * MIRROR CONTRACT: flowMath.wakeRateCpu / bowArmDistCpu / shipLocalCpu are
 * the exact CPU formulas (tested) — change one side → change the other.
 *
 * Wiring (index.ts owns this): the injector's `wakeRateNode(worldXZ)` is
 * passed into createAccumulation and evaluated per texel of the region;
 * main.ts feeds ship state per tick:
 *
 *   ff.setShip([ship.x, ship.z], ship.yaw, speedOverWater,
 *              bowOffset, sternOffset, beam);  // offsets from blueprint AABB
 *
 * §V23: functional 3-arg smoothstep only; chained `x.step(edge)` reads
 * step(edge, x) and is commented at each use site.
 */
import * as THREE from 'three/webgpu';
import { smoothstep, uniform, vec2, float } from 'three/tsl';
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
  const uArmWidth = uniform(p.armWidth);
  const uArmWidthGrowth = uniform(p.armWidthGrowth);
  const uSternWidth = uniform(p.sternWidth);
  const uWakeRange = uniform(p.wakeRange);

  return {
    /**
     * TSL wake injection rate (foam/second) at a world-XZ node.
     * CPU mirror: flowMath.wakeRateCpu.
     */
    wakeRateNode(worldXZ: any): any {
      // feather in over [threshold, 2·threshold] — exactly 0 at anchor
      const gate = smoothstep(uSpeedThreshold, uSpeedThreshold.mul(2), uSpeed);
      const d = worldXZ.sub(uShipPos);
      const along = d.dot(uFwd);
      // right = (fz, −fx) — forward rotated −90° about +y (shipLocalCpu twin)
      const across = d.dot(vec2(uFwd.y, uFwd.x.negate()));

      // bow V (flowMath.bowArmDistCpu): arms at ±sBow·tan(kelvin), ∝ speed
      const sBow = uBowOffset.sub(along);
      const behindBow = sBow.step(0); // x.step(edge) = step(0, sBow): 1 when sBow ≥ 0
      const armDist = across.abs().sub(sBow.mul(uKelvinTan)).abs();
      const armW = uArmWidth.add(sBow.mul(uArmWidthGrowth)); // V thickens aft
      const armMask = smoothstep(float(0), armW, armDist).oneMinus();
      const bowFade = smoothstep(float(0), uWakeRange, sBow).oneMinus();
      const bow = uBowIntensity.mul(uSpeed).mul(armMask).mul(bowFade).mul(behindBow);

      // stern band: width ≈ beam, ∝ speed², peaked at centerline (rooster hump)
      const sStern = uSternOffset.sub(along);
      const behindStern = sStern.step(0); // x.step(edge) = step(0, sStern): 1 when sStern ≥ 0
      const halfW = uBeam.mul(uSternWidth).mul(0.5);
      const sternMask = smoothstep(float(0), halfW, across.abs()).oneMinus();
      const sternFade = smoothstep(float(0), uWakeRange, sStern).oneMinus();
      const stern = uSternIntensity
        .mul(uSpeed)
        .mul(uSpeed)
        .mul(sternMask)
        .mul(sternFade)
        .mul(behindStern);

      return bow.add(stern).mul(gate);
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
      uArmWidth.value = p.armWidth;
      uArmWidthGrowth.value = p.armWidthGrowth;
      uSternWidth.value = p.sternWidth;
      uWakeRange.value = p.wakeRange;
    },
  };
}

export type WakeInjector = ReturnType<typeof createWakeInjector>;
