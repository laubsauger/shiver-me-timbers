/**
 * Colour grade node (§T.101, §V.89): LGG + split tone + a 3D LUT, sampled in
 * DISPLAY space after the tone map. The CPU mirror of every line here is in
 * `gradeLut.ts` and that is what the tests check (§V.80); keep the two in the
 * same order with the same constants or `bake()` stops matching the sliders.
 *
 * BINDINGS: exactly 2 sampled textures (+ their 2 samplers) and 11 uniforms,
 * regardless of how many LUT slots exist. The four slot textures live on the
 * CPU side; per frame `update()` computes the band weights for the sky's hour
 * (`gradeBandWeights`, ≤ 2 non-zero), picks the heavier two and SWAPS them
 * into the two bound texture nodes (`texA.value = …`, which
 * `NodeSampledTexture.update` re-binds). When only one band is active the
 * second node holds the same texture and the blend uniform is 0 — the second
 * trilinear fetch still happens (the graph is static) but it costs a cache
 * hit, not a binding. A slot that is disabled in params contributes the
 * identity texture for its share of the band.
 *
 * Identity is exact (§V.89): the LUT coordinate is `rgb·(N−1)/N + 0.5/N`, so
 * the grid points land on texel centres and trilinear between two identity
 * texels is the identity. The RGBA8 storage quantises to 1/255, which the
 * test bound (Δ < 1/255) allows for.
 *
 * No `step`/`smoothstep`/`fract` in here on purpose: the split-tone ramp is a
 * hand-written cubic on LUMA (no spatial period, nothing to band-limit), and
 * spelling it out keeps the §V.48 tripwire honest rather than marked.
 */
import * as THREE from 'three/webgpu';
import { float, mix, texture3D, uniform, vec3 } from 'three/tsl';
import type { Node } from 'three/webgpu';
import type { ShaderNodeObject } from 'three/tsl';
import { gradeParams, GRADE_SLOTS, type GradeParams } from '../params/grade';
import { skyParams } from '../params/sky';
import {
  GAMMA_FLOOR,
  LUMA,
  LUT_SIZE,
  LUT_STRIP_URLS,
  SOFTNESS_FLOOR,
  type BandWeights,
  gradeBandWeights,
  guardedLgg,
  identityLut,
  loadLutStrip,
  lutToTexture,
  pickTopTwo,
  sampleLutCpu,
  updateTexture,
} from './gradeLut';

export interface GradeNodeOptions {
  params?: GradeParams;
  /** hour source; defaults to the live sky clock */
  timeOfDay?: () => number;
  /**
   * fetch the shipped strips from assets/lut/ into the slots (browser only;
   * skipped automatically where there is no `document`). Identity until they
   * land, identity if one fails (warned once).
   */
  loadStrips?: boolean;
}

export interface GradeNode {
  /** the graded vec3, display space, clamped 0..1 */
  node: ShaderNodeObject<Node>;
  /** per frame, BEFORE render: push uniforms and rebind the two LUT slots */
  update(): void;
  /** replace a slot's LUT in place (any size; resampled onto LUT_SIZE³) */
  setSlotLut(slot: number, lut: Float32Array, size: number): void;
  /** back to identity */
  resetSlot(slot: number): void;
  /** what the last update() computed — for the panel/lookdev, not the shader */
  readonly lastWeights: BandWeights;
  readonly lastBound: { a: number; b: number; blend: number };
  readonly slots: ReadonlyArray<THREE.Data3DTexture>;
  dispose(): void;
}

export function createGradeNode(input: ShaderNodeObject<Node>, opts: GradeNodeOptions = {}): GradeNode {
  const p = opts.params ?? gradeParams;
  const hour = opts.timeOfDay ?? ((): number => skyParams.timeOfDay);

  const identity = lutToTexture(identityLut(LUT_SIZE), LUT_SIZE);
  const slots: THREE.Data3DTexture[] = GRADE_SLOTS.map(() => lutToTexture(identityLut(LUT_SIZE), LUT_SIZE));

  // --- uniforms (11) -------------------------------------------------------
  const uLift = uniform(new THREE.Vector3(0, 0, 0));
  const uGamma = uniform(new THREE.Vector3(1, 1, 1));
  const uGain = uniform(new THREE.Vector3(1, 1, 1));
  const uSat = uniform(1);
  const uPivot = uniform(0.5);
  const uSoft = uniform(0.25);
  const uStrength = uniform(0);
  const uShadow = uniform(new THREE.Vector3(0.5, 0.5, 0.5));
  const uHigh = uniform(new THREE.Vector3(0.5, 0.5, 0.5));
  const uBlend = uniform(0);
  const uLutMix = uniform(0);

  // --- LGG → saturation → split tone (mirror: gradeCpu) -------------------
  const c = input.clamp(0, 1);
  const lgg = c
    .mul(uGain)
    .add(uLift.mul(float(1).sub(c)))
    .clamp(0, 1)
    .pow(vec3(1).div(uGamma.max(GAMMA_FLOOR)));
  const luma = vec3(LUMA[0], LUMA[1], LUMA[2]);
  const l0 = lgg.dot(luma);
  const sat = mix(vec3(l0), lgg, uSat);
  const l = sat.dot(luma);
  const t = l.sub(uPivot).add(uSoft).div(uSoft.mul(2).max(SOFTNESS_FLOOR * 2)).clamp(0, 1);
  const b = t.mul(t).mul(float(3).sub(t.mul(2))).mul(2).sub(1);
  const ws = b.negate().max(0).mul(uStrength);
  const wh = b.max(0).mul(uStrength);
  const toned = sat
    .add(uShadow.sub(0.5).mul(ws))
    .add(uHigh.sub(0.5).mul(wh))
    .clamp(0, 1);

  // --- LUT (mirror: sampleLutCpu) -----------------------------------------
  // Every slot texture is LUT_SIZE³ unless setSlotLut is handed another size;
  // the coordinate transform is baked for LUT_SIZE, so a differently sized
  // slot is resampled onto LUT_SIZE at load (see setSlotLut) rather than
  // sampled off-centre.
  const coord = toned.mul((LUT_SIZE - 1) / LUT_SIZE).add(0.5 / LUT_SIZE);
  const texA = texture3D(identity, coord, null);
  const texB = texture3D(identity, coord, null);
  const lutted = mix(texA.rgb, texB.rgb, uBlend);
  const node = mix(toned, lutted, uLutMix).clamp(0, 1);

  // --- per frame --------------------------------------------------------------
  let lastWeights: BandWeights = [0, 0, 0, 0];
  let lastBound = { a: 0, b: 0, blend: 0 };
  const enabledFlags = (): boolean[] => [p.lutDawn, p.lutNoon, p.lutDusk, p.lutNight];

  const update = (): void => {
    const g = guardedLgg(p);
    uLift.value.set(g.liftR, g.liftG, g.liftB);
    uGamma.value.set(g.gammaR, g.gammaG, g.gammaB);
    uGain.value.set(g.gainR, g.gainG, g.gainB);
    uSat.value = g.saturation;
    uPivot.value = g.splitPivot;
    uSoft.value = g.splitSoftness;
    uStrength.value = g.splitStrength;
    uShadow.value.set(g.shadowTintR, g.shadowTintG, g.shadowTintB);
    uHigh.value.set(g.highlightTintR, g.highlightTintG, g.highlightTintB);
    uLutMix.value = Math.min(Math.max(Number.isFinite(p.lutMix) ? p.lutMix : 0, 0), 1);

    lastWeights = gradeBandWeights(hour(), p);
    lastBound = pickTopTwo(lastWeights);
    const on = enabledFlags();
    texA.value = on[lastBound.a] ? slots[lastBound.a] : identity;
    texB.value = on[lastBound.b] ? slots[lastBound.b] : identity;
    uBlend.value = lastBound.blend;
  };

  const setSlotLut = (slot: number, lut: Float32Array, size: number): void => {
    // resample onto the sampler's grid so the half-texel maths stays exact
    const data = size === LUT_SIZE ? lut : resample(lut, size);
    updateTexture(slots[slot], data, LUT_SIZE);
  };

  if (opts.loadStrips !== false && typeof document !== 'undefined') {
    GRADE_SLOTS.forEach((name, i) => {
      loadLutStrip(LUT_STRIP_URLS[name])
        .then(({ lut, size }) => setSlotLut(i, lut, size))
        .catch((err: unknown) => {
          console.warn(`[grade] LUT strip '${name}' failed to load; slot stays identity`, err);
        });
    });
  }

  update();

  return {
    node,
    update,
    setSlotLut,
    resetSlot: (slot) => setSlotLut(slot, identityLut(LUT_SIZE), LUT_SIZE),
    get lastWeights() {
      return lastWeights;
    },
    get lastBound() {
      return lastBound;
    },
    slots,
    dispose: () => {
      identity.dispose();
      for (const s of slots) s.dispose();
    },
  };
}

/** resample a LUT of any size onto LUT_SIZE³ with the same trilinear mirror */
function resample(lut: Float32Array, size: number): Float32Array {
  const out = new Float32Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
  const inv = 1 / (LUT_SIZE - 1);
  for (let b = 0; b < LUT_SIZE; b++)
    for (let g = 0; g < LUT_SIZE; g++)
      for (let r = 0; r < LUT_SIZE; r++) {
        const o = sampleLutCpu(lut, size, [r * inv, g * inv, b * inv]);
        const i = (r + LUT_SIZE * (g + LUT_SIZE * b)) * 3;
        out[i] = o[0];
        out[i + 1] = o[1];
        out[i + 2] = o[2];
      }
  return out;
}
