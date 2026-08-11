/**
 * Deck water Pass 2 — inflow + resolve (§V9, Mei et al. 2007, handoff §3).
 * TSL compute: gathers the neighbor fluxes aimed at this cell (each
 * neighbor's opposite-direction component of the outflow texture), subtracts
 * the cell's own outflow, injects queued splashes, then applies the §V9
 * channel rules: B = volume, G = persistent wetness (ratchets up from
 * standing water, decays independently — wet planks outlive the puddle),
 * constant evaporation subtracted from BOTH each step so the deck dries.
 * Off-grid neighbors contribute nothing (their flux fell off the deck).
 * CPU mirror of this exact math: fluxMath.applyInflow/gatherInflow (tested).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  Loop,
  float,
  instanceIndex,
  int,
  ivec2,
  select,
  textureLoad,
  textureStore,
  uint,
  uniformArray,
  uvec2,
  vec4,
} from 'three/tsl';
import type { DeckWaterUniforms } from './outflowPass';

/** splash queue capacity per step (uniform array slots, not a tunable) */
export const MAX_SPLASHES = 8;

/** vec4 uniform array node: per splash x=u, y=v, z=amount, w=unused */
export type SplashArrayNode = ReturnType<typeof uniformArray>;

/**
 * Build the inflow/resolve compute for one ping-pong direction:
 * stateSrc + outflow → stateDst. R (deck height) passes through unchanged,
 * A stays spare (0).
 */
export function createInflowPass(
  stateSrc: THREE.Texture,
  outflow: THREE.StorageTexture,
  stateDst: THREE.StorageTexture,
  w: number,
  h: number,
  u: DeckWaterUniforms,
  uSplashes: SplashArrayNode,
) {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(w * h)), () => {
      const x = int(instanceIndex.modInt(w));
      const y = int(instanceIndex.div(uint(w)));
      const cell = textureLoad(stateSrc, ivec2(x, y));
      const own = textureLoad(outflow, ivec2(x, y));
      const outSum = own.x.add(own.y).add(own.z).add(own.w);

      // neighbor's flux component pointing back at this cell (fluxMath order:
      // N sends its S(z), E sends W(w), S sends N(x), W sends E(y))
      const inFrom = (
        dx: number,
        dy: number,
        pick: (f: ReturnType<typeof textureLoad>) => THREE.Node,
      ) => {
        const sx = x.add(int(dx));
        const sy = y.add(int(dy));
        const inside = sx
          .greaterThanEqual(int(0))
          .and(sx.lessThan(int(w)))
          .and(sy.greaterThanEqual(int(0)))
          .and(sy.lessThan(int(h)));
        const nf = textureLoad(outflow, ivec2(sx.clamp(0, w - 1), sy.clamp(0, h - 1)));
        return select(inside, pick(nf), float(0));
      };
      const inflow = inFrom(0, -1, (f) => f.z)
        .add(inFrom(1, 0, (f) => f.w))
        .add(inFrom(0, 1, (f) => f.x))
        .add(inFrom(-1, 0, (f) => f.y));

      // queued splashes: gaussian splat of volume around each (u,v) center
      const splash = float(0).toVar();
      const r2 = u.uSplashRadius.mul(u.uSplashRadius).max(1e-6);
      Loop(MAX_SPLASHES, ({ i }) => {
        const s = uSplashes.element(int(i));
        const dx = float(x).sub(s.x.mul(float(w)));
        const dy = float(y).sub(s.y.mul(float(h)));
        const d2 = dx.mul(dx).add(dy.mul(dy));
        splash.addAssign(s.z.mul(d2.div(r2.mul(2)).negate().exp()));
      });

      // resolve (mirror: fluxMath.applyInflow) — §V9 evaporation on B AND G
      const settled = cell.b.sub(outSum).add(inflow).add(splash).max(0);
      const wet = cell.g.max(settled.mul(u.uWetnessGain).min(1));
      const volumeOut = settled.sub(u.uEvapVolume).max(0);
      const wetnessOut = wet.sub(u.uEvapWetness).max(0);
      textureStore(
        stateDst,
        uvec2(ivec2(x, y)),
        vec4(cell.r, wetnessOut, volumeOut, 0),
      ).toWriteOnly();
    });
  })().compute(w * h);
}
