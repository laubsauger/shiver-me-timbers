/**
 * Deck water Pass 1 — outflow (§V9, Mei et al. 2007, docs/handoff.md §3).
 * TSL compute (`Fn().compute()` per §C): each cell computes the flux it emits
 * to its 4 neighbors ∝ max(0, hydraulic head difference), where head =
 * deckHeight (R) + volume (B). The ship's rotation enters as a uniform tilt
 * gradient that biases the head difference directionally, so water slides
 * across the deck as the ship rocks. Total outflow is clamped to the
 * available volume (no negative water). Off-deck neighbors drain against
 * EDGE_DRAIN_HEAD ("leaky deck").
 * CPU mirror of this exact math: fluxMath.computeOutflow (tested).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  float,
  instanceIndex,
  int,
  ivec2,
  select,
  textureLoad,
  textureStore,
  uint,
  uniform,
  uvec2,
  vec4,
} from 'three/tsl';
import type { DeckWaterParams } from '../params/deckwater';
import { EDGE_DRAIN_HEAD } from './fluxMath';

/**
 * Uniforms shared by both passes. Per-step values (uFluxRate, uEvapVolume,
 * uEvapWetness) are set to param-rate × dt every update (§V2 fixed tick).
 */
export function createDeckWaterUniforms(p: DeckWaterParams) {
  return {
    /** ship tilt gradient (roll/pitch → grid x/y downhill direction) */
    uTilt: uniform(new THREE.Vector2(0, 0)),
    uFluxRate: uniform(0),
    uTiltBias: uniform(p.tiltBiasStrength),
    uEvapVolume: uniform(0),
    uEvapWetness: uniform(0),
    uWetnessGain: uniform(p.wetnessGain),
    uSplashRadius: uniform(p.splashRadius),
  };
}

export type DeckWaterUniforms = ReturnType<typeof createDeckWaterUniforms>;

/**
 * Build the outflow compute for one ping-pong direction. Reads `state`
 * (R=deck, G=wetness, B=volume) and writes per-cell directional fluxes to
 * `outflow` packed RGBA = N/E/S/W (fluxMath.DIRECTIONS order).
 */
export function createOutflowPass(
  state: THREE.Texture,
  outflow: THREE.StorageTexture,
  w: number,
  h: number,
  u: DeckWaterUniforms,
) {
  return Fn(() => {
    If(instanceIndex.lessThan(uint(w * h)), () => {
      const x = int(instanceIndex.modInt(w));
      const y = int(instanceIndex.div(uint(w)));
      const cell = textureLoad(state, ivec2(x, y));
      const volume = cell.b;
      const head = cell.r.add(volume);

      // neighbor hydraulic head; outside the grid the deck "leaks" (§V9)
      const neighborHead = (dx: number, dy: number) => {
        const sx = x.add(int(dx));
        const sy = y.add(int(dy));
        const inside = sx
          .greaterThanEqual(int(0))
          .and(sx.lessThan(int(w)))
          .and(sy.greaterThanEqual(int(0)))
          .and(sy.lessThan(int(h)));
        const nc = textureLoad(state, ivec2(sx.clamp(0, w - 1), sy.clamp(0, h - 1)));
        return select(inside, nc.r.add(nc.b), float(EDGE_DRAIN_HEAD));
      };

      // flux ∝ max(0, headDiff + tilt bias·direction) — rocking slosh (§V9)
      const fluxTo = (dx: number, dy: number) => {
        const bias = u.uTiltBias.mul(u.uTilt.x.mul(dx).add(u.uTilt.y.mul(dy)));
        return head.sub(neighborHead(dx, dy)).add(bias).mul(u.uFluxRate).max(0);
      };
      const fN = fluxTo(0, -1);
      const fE = fluxTo(1, 0);
      const fS = fluxTo(0, 1);
      const fW = fluxTo(-1, 0);

      // clamp: cell can never emit more than it holds (mirror: computeOutflow)
      const total = fN.add(fE).add(fS).add(fW);
      const scale = volume.div(total.max(1e-6)).min(1);
      textureStore(
        outflow,
        uvec2(ivec2(x, y)),
        vec4(fN, fE, fS, fW).mul(scale),
      ).toWriteOnly();
    });
  })().compute(w * h);
}
