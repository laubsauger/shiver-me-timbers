/**
 * Deck water integration (§V9): owns the 512×192 state ping-pong
 * (StorageTexture RGBA32F: R=deck height static, G=persistent wetness,
 * B=water volume, A=spare), the intermediate outflow flux texture
 * (RGBA=N/E/S/W), and the two Mei compute passes per update.
 *
 * Deck material hookup: sample `stateNode` (tracks the front texture across
 * ping-pong swaps) — G drives roughness↓/specular↑ where wet, B is standing
 * water depth. Normal/slope hint: derive in the material from stateTexture
 * neighbors — sample surface height s = R + B at uv ± one texel
 * (1/gridWidth, 1/gridHeight) and build
 * normal ≈ normalize(vec3(sL - sR, 2·cellSize, sT - sB)); no extra normal
 * pass needed, the state texture already carries all height data.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  If,
  instanceIndex,
  int,
  ivec2,
  texture,
  textureLoad,
  textureStore,
  uint,
  uniformArray,
  uvec2,
  vec4,
} from 'three/tsl';
import { deckWaterParams, type DeckWaterParams } from '../params/deckwater';
import { generateDeckHeightfield } from './deckHeightfield';
import { createDeckWaterUniforms, createOutflowPass } from './outflowPass';
import { createInflowPass, MAX_SPLASHES } from './inflowPass';

export interface DeckWaterOptions {
  params?: DeckWaterParams;
  /** ship-piece heightfield override (row-major gridWidth×gridHeight, §V13 later) */
  heightfield?: Float32Array;
}

interface QueuedSplash {
  u: number;
  v: number;
  amount: number;
}

export function createDeckWater(opts: DeckWaterOptions = {}) {
  const p = opts.params ?? deckWaterParams;
  const w = p.gridWidth;
  const h = p.gridHeight;

  const field =
    opts.heightfield ??
    generateDeckHeightfield({
      width: w,
      height: h,
      camberHeight: p.camberHeight,
      plankSpacing: p.plankSpacing,
      plankGrooveDepth: p.plankGrooveDepth,
      railHeight: p.railHeight,
      scupperCount: p.scupperCount,
    });
  if (field.length !== w * h) {
    throw new Error(`deckwater: heightfield length ${field.length} ≠ ${w}×${h}`);
  }

  // seed texture: deck height in R, read once by the init pass
  const seedData = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) seedData[i * 4] = field[i];
  const seedTex = new THREE.DataTexture(seedData, w, h, THREE.RGBAFormat, THREE.FloatType);
  seedTex.minFilter = THREE.NearestFilter;
  seedTex.magFilter = THREE.NearestFilter;
  seedTex.generateMipmaps = false;
  seedTex.needsUpdate = true;

  const makeState = (): THREE.StorageTexture => {
    const t = new THREE.StorageTexture(w, h);
    t.type = THREE.FloatType;
    t.format = THREE.RGBAFormat;
    t.minFilter = THREE.LinearFilter; // material samples wetness smoothly
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  };
  const stateA = makeState();
  const stateB = makeState();
  const outflowTex = new THREE.StorageTexture(w, h);
  outflowTex.type = THREE.FloatType;
  outflowTex.format = THREE.RGBAFormat;
  outflowTex.minFilter = THREE.NearestFilter;
  outflowTex.magFilter = THREE.NearestFilter;
  outflowTex.generateMipmaps = false;

  const u = createDeckWaterUniforms(p);
  const splashVecs = Array.from({ length: MAX_SPLASHES }, () => new THREE.Vector4());
  const uSplashes = uniformArray(splashVecs);

  const makeInit = (dst: THREE.StorageTexture) =>
    Fn(() => {
      If(instanceIndex.lessThan(uint(w * h)), () => {
        const x = int(instanceIndex.modInt(w));
        const y = int(instanceIndex.div(uint(w)));
        const deck = textureLoad(seedTex, ivec2(x, y)).r;
        textureStore(dst, uvec2(ivec2(x, y)), vec4(deck, 0, 0, 0)).toWriteOnly();
      });
    })().compute(w * h);
  const initA = makeInit(stateA);
  const initB = makeInit(stateB);

  // both ping-pong directions built up front (TSL passes bind fixed textures)
  const outflowFromA = createOutflowPass(stateA, outflowTex, w, h, u);
  const outflowFromB = createOutflowPass(stateB, outflowTex, w, h, u);
  const inflowA2B = createInflowPass(stateA, outflowTex, stateB, w, h, u, uSplashes);
  const inflowB2A = createInflowPass(stateB, outflowTex, stateA, w, h, u, uSplashes);

  let front = 0; // 0 → stateA holds current state, 1 → stateB
  let initialized = false;
  const splashQueue: QueuedSplash[] = [];
  /** stable TSL node for the deck material; retargeted on every swap */
  const stateNode = texture(stateA);

  return {
    /** current front state texture (R=deck, G=wetness, B=volume, A=spare) */
    get stateTexture(): THREE.StorageTexture {
      return front === 0 ? stateA : stateB;
    },
    stateNode,
    uniforms: u,

    /**
     * Run one sim step (§V2 fixed dt). tiltGradient = downhill direction of
     * the deck plane from ship roll/pitch, in grid axes [x=along length,
     * z=across beam]; e.g. the ship-local xz of the deck normal.
     */
    update(renderer: THREE.WebGPURenderer, tiltGradient: [number, number], dt: number): void {
      if (!initialized) {
        renderer.compute(initA);
        renderer.compute(initB);
        initialized = true;
      }
      u.uTilt.value.set(tiltGradient[0], tiltGradient[1]);
      u.uFluxRate.value = p.fluxRate * dt;
      u.uTiltBias.value = p.tiltBiasStrength;
      u.uEvapVolume.value = p.evapVolume * dt;
      u.uEvapWetness.value = p.evapWetness * dt;
      u.uWetnessGain.value = p.wetnessGain;
      u.uSplashRadius.value = p.splashRadius;
      for (let i = 0; i < MAX_SPLASHES; i++) {
        const s = splashQueue.shift(); // overflow stays queued for next step
        if (s) splashVecs[i].set(s.u, s.v, s.amount, 0);
        else splashVecs[i].set(0, 0, 0, 0);
      }
      renderer.compute(front === 0 ? outflowFromA : outflowFromB);
      renderer.compute(front === 0 ? inflowA2B : inflowB2A);
      front = 1 - front;
      stateNode.value = front === 0 ? stateA : stateB;
    },

    /** queue a water injection (wave over rail, cannonball splash) at deck uv */
    splash(su: number, sv: number, amount: number): void {
      if (!(amount > 0)) return;
      splashQueue.push({
        u: Math.min(1, Math.max(0, su)),
        v: Math.min(1, Math.max(0, sv)),
        amount,
      });
    },

    dispose(): void {
      stateA.dispose();
      stateB.dispose();
      outflowTex.dispose();
      seedTex.dispose();
    },
  };
}

export type DeckWater = ReturnType<typeof createDeckWater>;
