/**
 * Deck water (§T.12 solve, §T.31 wiring; §V9 + §V27).
 *
 * WHAT THIS IS: a Mei et al. 2007 shallow-water solve on a 512×192 grid laid
 * over the ship's waist, run as two TSL computes per substep (outflow biased
 * by the hull's live rotation → inflow + resolve), fed by an EVENT sensor
 * reading §V8's per-slice hull contact, and read back by the deck material as
 * a wetness/puddle mask. The state texture is RGBA32F:
 * R = static deck height, G = wetness, B = water volume (m), A = drain mask.
 *
 * INTEGRATION (main thread owns the wiring; the ship material never builds
 * this — same contract as caustics, and for the same reason: TSL bakes the
 * graph at material construction, so a late bind is silently neutral):
 *
 *   // once, BEFORE any deck material is built, and AFTER the blueprint (the
 *   // field is generated from it) but BEFORE `new ShipAssembly(blueprint)`:
 *   const deckField = buildDeckHeightfield(galleonBlueprint);  // src/ship
 *   const deckWater = createDeckWater({ source: deckField });
 *   setActiveDeckWater(deckWater);
 *
 *   // per frame, AFTER hullContact.update() (it is the sensor's input):
 *   deckWater.update(app.renderer, {
 *     quaternion: playerShip.quaternion,
 *     speed: shipSpeed,
 *     seaSigma: ocean.heightRms,      // σ, not amplitude (§V36)
 *     hull: hullContact,              // the SLICE arrays, not just .cutwater
 *   }, frameDt);
 *
 *   // and in the deck material (src/ship), once, at construction:
 *   //   const dw = deckWetness({ shipLocalPos });
 *   //   color = color.mul(dw.tint);
 *   //   rough = rough.mul(dw.roughnessScale);
 *   //   height = height.mul(dw.reliefScale).add(dw.heightAdd);
 *   // WITHOUT that call nothing this module computes reaches a pixel.
 *
 * PLAYER SHIP ONLY (§V27, 1 ship budget): there is one instance, bound
 * globally, and the deck material's ship-local sampling is only correct for
 * the ship whose inverse world matrix woodMaterial publishes. Do not
 * generalise this to the AI fleet without giving each ship its own binding.
 *
 * §V29's relative: the solver's write targets are StorageTextures written
 * with `textureStore(...).toWriteOnly()` and read elsewhere through separate
 * `texture()` / `textureLoad()` nodes, so there is no shared node whose
 * access mode one side can downgrade under the other. The front buffer never
 * swaps (substeps are even), so the material's binding is fixed for the life
 * of the material — which is also why a material built before
 * setActiveDeckWater() can never acquire the hook.
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
import type { Quat } from '../state/simState';
import {
  deckFieldFromSource,
  frameFromSource,
  syntheticDeckField,
  type DeckHeightfieldSource,
} from './deckHeightfield';
import { EDGE_DRAIN_HEAD } from './fluxMath';
import { createDeckWaterUniforms, createOutflowPass } from './outflowPass';
import { createInflowPass, MAX_SPLASHES } from './inflowPass';
import { deckTiltGradient, isValidDeckFrame } from './deckFrame';
import {
  createBowWaterSensor,
  type BowWaterSensor,
  type HullContactSlices,
  type DeckSplash,
} from './bowWaterSensor';
import {
  createDeckWetnessUniforms,
  deckWetnessNode,
  neutralDeckWetness,
  refreshDeckWetnessUniforms,
  type DeckReceiver,
  type DeckWetness,
} from './deckMaterialNode';

export {
  deckFieldFromSource,
  frameFromSource,
  syntheticDeckField,
  validateDeckField,
} from './deckHeightfield';
export type { DeckField, DeckHeightfieldSource } from './deckHeightfield';
export { deckTiltGradient, deckUv, isValidDeckFrame } from './deckFrame';
export type { DeckFrame } from './deckFrame';
export { createBowWaterSensor } from './bowWaterSensor';
export type { BowWaterSample, HullContactSlices, DeckSplash } from './bowWaterSensor';
export type { DeckReceiver, DeckWetness } from './deckMaterialNode';
export { MAX_SPLASHES } from './inflowPass';

export interface DeckWaterOptions {
  /**
   * The ship's own deck heightfield — `buildDeckHeightfield(blueprint)` from
   * src/ship/deckHeightfield.ts. It carries the grid dims, the ship-space
   * rectangle (so the frame is derived, not restated) and the coverage mask.
   *
   * Supply it: it is generated from the real deck pieces, so the waterway,
   * hatch coamings, gratings and mast partners stay correct as §T.34 adds
   * fittings, AND the deck's plank relief is driven from the SAME array —
   * water pools exactly where the timber dishes. Omitted → a crude synthetic
   * field, which proves the solve but is not this ship.
   */
  source?: DeckHeightfieldSource;
  params?: DeckWaterParams;
}

/** everything one update needs; `hull` is the §V8 hullContact object itself */
export interface DeckWaterSample {
  /** hull orientation [x,y,z,w] — drives the §V9 rotation bias */
  quaternion: Quat;
  /** hull speed over ground (m/s) */
  speed: number;
  /** live sea σ (`ocean.heightRms`) — §V36 */
  seaSigma: number;
  /**
   * `hullContact` straight from src/sea-physics — the per-slice arrays, not
   * just the cutwater. Water is injected at the stations actually burying,
   * which is what stops it appearing along the whole length at once.
   */
  hull: HullContactSlices;
}

interface QueuedSplash {
  u: number;
  v: number;
  amount: number;
}

export function createDeckWater(opts: DeckWaterOptions = {}) {
  const p = opts.params ?? deckWaterParams;
  const source =
    opts.source ??
    syntheticDeckField({
      // §V28: dispatch counts and buffer sizes from sanitized construction-time ints
      width: Math.max(4, Math.round(p.gridWidth)),
      height: Math.max(4, Math.round(p.gridHeight)),
    });
  const frame = frameFromSource(source);
  if (!isValidDeckFrame(frame)) {
    // Rule 8: a degenerate frame maps every deck pixel onto one cell and the
    // puddles land nowhere — fail here, not three sessions from now
    throw new Error(
      `deckwater: invalid frame ${JSON.stringify(frame)} — the deck field's ` +
      'ship-space rectangle must have extent in both x and z',
    );
  }
  const field = deckFieldFromSource(source);
  const w = field.width;
  const h = field.height;

  // The drain head must sit BELOW the lowest point of the deck. The ship's
  // field measures heights relative to the deck plane and the waterway gutter
  // inboard of the bulwark is NEGATIVE, so a drain left at datum would stand
  // higher than the gutter: water would run into the waterway (correct) and
  // then sit there forever instead of leaving through the freeing ports.
  let lowest = Infinity;
  for (let i = 0; i < w * h; i++) {
    if (field.drain[i] === 0 && field.heights[i] < lowest) lowest = field.heights[i];
  }
  if (!Number.isFinite(lowest)) lowest = EDGE_DRAIN_HEAD; // a field that is all drain
  const drainHead = lowest - Math.max(1e-4, p.drainDrop);

  // seed texture: R = deck height, A = drain mask. Expressed once here so
  // neither compute pass has to carry a mask branch.
  const seedData = new Float32Array(w * h * 4);
  for (let i = 0; i < w * h; i++) {
    const isDrain = field.drain[i] !== 0;
    seedData[i * 4] = isDrain ? drainHead : field.heights[i];
    seedData[i * 4 + 3] = isDrain ? 1 : 0;
  }
  const seedTex = new THREE.DataTexture(seedData, w, h, THREE.RGBAFormat, THREE.FloatType);
  seedTex.minFilter = THREE.NearestFilter;
  seedTex.magFilter = THREE.NearestFilter;
  seedTex.generateMipmaps = false;
  seedTex.needsUpdate = true;

  const makeState = (): THREE.StorageTexture => {
    const t = new THREE.StorageTexture(w, h);
    t.type = THREE.FloatType;
    t.format = THREE.RGBAFormat;
    // the material samples wetness smoothly; float32 filtering is the same
    // bet flowfoam's accumulation texture already makes and wins in-game
    t.minFilter = THREE.LinearFilter;
    t.magFilter = THREE.LinearFilter;
    t.generateMipmaps = false;
    return t;
  };
  /** FRONT — always holds the current state, so materials bind it once */
  const stateA = makeState();
  /** BACK — scratch; an even substep count returns the result to stateA */
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
        const seed = textureLoad(seedTex, ivec2(x, y));
        // R = deck height, G/B = dry and empty, A = drain mask (carried for
        // the life of the sim by the resolve pass)
        textureStore(dst, uvec2(ivec2(x, y)), vec4(seed.r, 0, 0, seed.a)).toWriteOnly();
      });
    })().compute(w * h);
  const initA = makeInit(stateA);
  const initB = makeInit(stateB);

  // both ping-pong directions built up front (TSL passes bind fixed textures)
  // metres per cell — the tilt gradient is a SLOPE and must be multiplied by
  // the distance travelled, or heel swamps the deck's own relief (§V9)
  const cellSize: readonly [number, number] = [
    (frame.maxX - frame.minX) / w,
    (frame.maxZ - frame.minZ) / h,
  ];
  const outflowFromA = createOutflowPass(stateA, outflowTex, w, h, u, cellSize);
  const outflowFromB = createOutflowPass(stateB, outflowTex, w, h, u, cellSize);
  const inflowA2B = createInflowPass(stateA, outflowTex, stateB, w, h, u, uSplashes);
  const inflowB2A = createInflowPass(stateB, outflowTex, stateA, w, h, u, uSplashes);

  let initialized = false;
  const splashQueue: QueuedSplash[] = [];
  const sensor: BowWaterSensor = createBowWaterSensor();
  const wetU = createDeckWetnessUniforms();
  /** stable TSL texture node for the deck material — never retargeted */
  const stateNode = texture(stateA);

  /** lazily allocated float target for probe() readbacks */
  let probeTarget: THREE.RenderTarget | undefined;

  /** last event, for the HUD/debug: how hard, and how long ago */
  let lastEventVolume = 0;
  let lastEventAge = Infinity;

  /**
   * Snap an injection onto the WAIST. The sensor places water at the z of the
   * station that shipped it, but forward of the fo'c's'le break that z is
   * under the forecastle — whose sole stands 1.6 m proud in the field. Water
   * put there is invisible (the material gates to the deck plane) and runs
   * off the castle's edges instead of onto the deck, which is exactly the
   * "it isn't where she's taking it" failure. Walk aft along the column to
   * the first waist cell; if this column has no deck at all (outboard of the
   * outline), drop the injection rather than dumping it in the sea.
   */
  const snapToWaist = (u: number, v: number): { u: number; v: number } | null => {
    const x = Math.min(w - 1, Math.max(0, Math.round(u * (w - 1))));
    const y0 = Math.min(h - 1, Math.max(0, Math.round(v * (h - 1))));
    if (field.waist[y0 * w + x]) return { u, v };
    for (let step = 1; step < h; step++) {
      const y = y0 - step; // aft: the sea comes over the head and runs aft
      if (y < 0) break;
      if (field.waist[y * w + x]) return { u, v: y / (h - 1) };
    }
    return null;
  };

  const queue = (s: DeckSplash): void => {
    if (!(s.amount > 0) || !Number.isFinite(s.u) || !Number.isFinite(s.v)) return;
    const at = snapToWaist(Math.min(1, Math.max(0, s.u)), Math.min(1, Math.max(0, s.v)));
    if (!at) return;
    splashQueue.push({ u: at.u, v: at.v, amount: s.amount });
  };

  const water = {
    /** the FRONT state texture (R=deck height, G=wetness, B=volume, A=drain) */
    stateTexture: stateA,
    stateNode,
    uniforms: u,
    frame,
    sensor,
    /** debug/HUD readout — no gameplay reads this */
    get lastEvent(): { volume: number; age: number; armed: boolean } {
      return { volume: lastEventVolume, age: lastEventAge, armed: sensor.armed };
    },

    /**
     * One frame. Runs the §V27 sensor (which is silent on most frames by
     * construction), then `p.substeps` Mei substeps. `dt` is the render
     * frame's dt — deck water is a render-only visual, like caustics'
     * hull wetline, and is deliberately NOT part of SimState (§V2).
     */
    update(renderer: THREE.WebGPURenderer, s: DeckWaterSample, dt: number): void {
      if (!initialized) {
        renderer.compute(initA);
        renderer.compute(initB);
        initialized = true;
      }
      // §V28: caller-fed dt is finite-guarded and capped — an alt-tab return
      // hands you a multi-second frame, and one giant flux step blows the
      // explicit scheme apart (it cannot go negative, but it does ring)
      const step = Number.isFinite(dt) ? Math.min(0.1, Math.max(0, dt)) : 0;
      lastEventAge += step;

      for (const splash of sensor.update(s, step, p, frame)) queue(splash);

      // even, ≥ 2: the result must land back on stateA (see DeckWaterParams)
      const substeps = Math.max(2, Math.round(p.substeps / 2) * 2);
      const sub = step / substeps;

      const tilt = deckTiltGradient(s.quaternion);
      u.uTilt.value.set(tilt[0], tilt[1]);
      u.uFluxRate.value = p.fluxRate * sub;
      u.uTiltBias.value = p.tiltBiasStrength;
      u.uEvapVolume.value = p.evapVolume * sub;
      u.uEvapWetness.value = p.evapWetness * sub;
      u.uWetnessGain.value = p.wetnessGain;
      u.uSplashRadius.value = p.splashRadius;
      // off-grid neighbours present the same head as a drain cell, so a field
      // whose mask runs right to the grid border still empties overboard
      u.uDrainHead.value = drainHead;

      // Splashes are injected by EVERY substep at 1/substeps strength rather
      // than by the first one only. Same total volume, and it avoids varying
      // a uniform between two dispatches that may share a command encoder —
      // the write would land before the encoder ran and BOTH substeps would
      // read the second value.
      let queued = 0;
      for (let i = 0; i < MAX_SPLASHES; i++) {
        const q = splashQueue[i]; // overflow stays queued for the next frame
        if (q) {
          splashVecs[i].set(q.u, q.v, q.amount / substeps, 0);
          queued++;
        } else splashVecs[i].set(0, 0, 0, 0);
      }
      if (queued > 0) {
        let volume = 0;
        for (let i = 0; i < queued; i++) volume += splashQueue[i].amount;
        lastEventVolume = volume;
        lastEventAge = 0;
        splashQueue.splice(0, queued);
      }

      for (let i = 0; i < substeps; i++) {
        const fromA = i % 2 === 0;
        renderer.compute(fromA ? outflowFromA : outflowFromB);
        renderer.compute(fromA ? inflowA2B : inflowB2A);
      }
      refreshDeckWetnessUniforms(wetU);
    },

    /**
     * Queue a water injection at deck uv — the §V27 event path calls this,
     * and so may anything else that dumps water on deck (a cannonball plume,
     * a burst pump). NOT a per-frame call: passive always-on splashing ⊥.
     */
    splash(su: number, sv: number, amount: number): void {
      queue({ u: su, v: sv, amount });
    },

    /** build the deck material's shading nodes (see deckMaterialNode.ts) */
    node(r: DeckReceiver): DeckWetness {
      return deckWetnessNode({ state: stateA, frame, u: wetU }, r);
    },

    /**
     * §V29's required proof, as a callable: read the front state texture back
     * and report what is actually in it. Every "built but never wired" system
     * in this project has been caught by exactly this check, and §B.8 hid
     * behind its absence for multiple sessions.
     *
     * `await window.__game.deckWater.probe()` from the console. What the
     * numbers must say:
     *   - `deckRange` matches the ship's field (galleon: −0.105 … +3.06 m).
     *     All zero ⇒ the init pass never ran, or R is not being carried.
     *   - `drainFraction` ≈ 0.28 for the galleon. 0 ⇒ the mask never arrived
     *     and the solve is running on a bare rectangle.
     *   - after `splash(0.5, 0.9, 0.1)` and a few frames, `volumeMax` > 0 and
     *     `wetMax` > 0. Still zero ⇒ the compute writes are not landing (the
     *     §B.8 signature: no error, no NaN, buffer stays 0).
     *   - `wetMax` ≤ 1 and `nonFinite` = 0 always. Anything else is a §V28
     *     NaN leak and the material will read garbage.
     */
    async probe(renderer: THREE.WebGPURenderer): Promise<{
      deckRange: [number, number];
      volumeMax: number;
      wetMax: number;
      drainFraction: number;
      nonFinite: number;
      wetCells: number;
    }> {
      // StorageTextures have no readback of their own: copy into a matching
      // float render target and read that. Allocated once and kept — a probe
      // that leaks a 192×512 RGBA32F target per call would itself become the
      // perf bug it was added to rule out.
      probeTarget ??= (() => {
        const rt = new THREE.RenderTarget(w, h, { depthBuffer: false, type: THREE.FloatType });
        rt.texture.name = 'deckwater/probe';
        return rt;
      })();
      renderer.copyTextureToTexture(stateA, probeTarget.texture);
      const data = (await renderer.readRenderTargetPixelsAsync(
        probeTarget, 0, 0, w, h,
      )) as unknown as Float32Array;
      if (!data || data.length < w * h * 4) {
        throw new Error(`deckwater.probe: readback returned ${data?.length ?? 0} floats`);
      }
      let dLo = Infinity;
      let dHi = -Infinity;
      let volumeMax = 0;
      let wetMax = 0;
      let drains = 0;
      let nonFinite = 0;
      let wetCells = 0;
      for (let i = 0; i < w * h; i++) {
        const r = data[i * 4];
        const g = data[i * 4 + 1];
        const b = data[i * 4 + 2];
        const a = data[i * 4 + 3];
        if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) nonFinite++;
        if (a > 0.5) drains++;
        else {
          dLo = Math.min(dLo, r);
          dHi = Math.max(dHi, r);
        }
        volumeMax = Math.max(volumeMax, b);
        wetMax = Math.max(wetMax, g);
        if (g > 0.02) wetCells++;
      }
      return {
        deckRange: [Number.isFinite(dLo) ? dLo : 0, Number.isFinite(dHi) ? dHi : 0],
        volumeMax,
        wetMax,
        drainFraction: drains / (w * h),
        nonFinite,
        wetCells,
      };
    },

    dispose(): void {
      // never leave the global binding pointing at disposed GPU resources
      if (active === water) active = undefined;
      stateA.dispose();
      stateB.dispose();
      outflowTex.dispose();
      seedTex.dispose();
      probeTarget?.dispose();
    },
  };
  return water;
}

export type DeckWater = ReturnType<typeof createDeckWater>;

let active: DeckWater | undefined;
let warned = false;

/** main.ts binds the instance so the deck material stays decoupled */
export function setActiveDeckWater(d: DeckWater | undefined): void {
  active = d;
}

export function activeDeckWater(): DeckWater | undefined {
  return active;
}

/**
 * The receiver-facing call — src/ship's deck material makes exactly this one
 * call. Safe before `setActiveDeckWater` and safe with
 * `deckWaterParams.enabled = false`: it returns identity nodes that fold away
 * at compile time.
 *
 * Rule 8 (fail loud): binding AFTER a deck material is built is silent
 * visually but not silent in the console — TSL bakes the graph at
 * construction and that material can never get deck water without a rebuild.
 */
export function deckWetness(r: DeckReceiver): DeckWetness {
  if (!deckWaterParams.enabled) return neutralDeckWetness();
  if (!active) {
    if (!warned) {
      warned = true;
      console.warn(
        '[deckwater] deckWetness() called before setActiveDeckWater() — this ' +
        'deck material is baked WITHOUT deck water and needs a rebuild to get ' +
        'it. Bind DeckWater before constructing deck materials.',
      );
    }
    return neutralDeckWetness();
  }
  return active.node(r);
}
