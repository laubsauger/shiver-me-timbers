/**
 * In-engine LUT authoring (§T.101). The lookdev agent tunes the grade sliders
 * on a real frame, then `__game.grade.bake('dusk')` freezes that look into
 * the dusk slot and hands back a PNG data URL to save as
 * `assets/lut/dusk.png`. main-raft attaches the returned handle as
 * `window.__game.grade`; nothing here touches the window itself.
 *
 * `bake` resets the sliders to identity afterwards by default: the look now
 * lives in the LUT, and leaving the sliders up would apply it twice (LGG,
 * then the LUT of the same LGG). Pass `{ keepLgg: true }` to stack instead.
 */
import { gradeParams, GRADE_SLOTS, type GradeSlot } from '../params/grade';
import type { GradeNode } from './grade';
import {
  IDENTITY_LGG,
  LUT_SIZE,
  LUT_STRIP_URLS,
  type BandWeights,
  type StripImage,
  gradeBandWeights,
  identityLut,
  loadLutStrip,
  lutFromLgg,
  lutFromStrip,
  lutToStrip,
  slotIndex,
} from './gradeLut';

export interface GradeHandle {
  /** bake the current LGG/split sliders into a slot; returns the strip as a PNG data URL */
  bake(slot: GradeSlot | number, opts?: { keepLgg?: boolean }): string;
  /** the current sliders as a LUT, without touching any slot */
  bakeLut(): Float32Array;
  /** strip of what a slot holds right now (to save after an external edit) */
  exportSlot(slot: GradeSlot | number): string;
  /** load a strip (an <img>, ImageData, or {width,height,data}) into a slot */
  setSlotFromStrip(slot: GradeSlot | number, img: StripImage | HTMLImageElement): void;
  /** fetch a strip PNG by URL into a slot */
  loadSlot(slot: GradeSlot | number, url?: string): Promise<void>;
  resetSlot(slot: GradeSlot | number): void;
  /** sliders back to identity (the grade then shows the LUTs alone) */
  resetLgg(): void;
  /** band weights for an hour (defaults to the last frame's) */
  weights(tod?: number): BandWeights;
  /** which two slots are bound and the blend toward the second */
  bound(): { a: GradeSlot; b: GradeSlot; blend: number };
  readonly params: typeof gradeParams;
  readonly slots: typeof GRADE_SLOTS;
  readonly strips: typeof LUT_STRIP_URLS;
}

function stripToDataUrl(strip: StripImage): string {
  const canvas = document.createElement('canvas');
  canvas.width = strip.width;
  canvas.height = strip.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) throw new Error('[grade] 2d context unavailable');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(strip.data), strip.width, strip.height), 0, 0);
  return canvas.toDataURL('image/png');
}

function imageToStrip(img: HTMLImageElement): StripImage {
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (ctx === null) throw new Error('[grade] 2d context unavailable');
  ctx.drawImage(img, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height);
}

export function createGradeHandle(grade: GradeNode, params = gradeParams): GradeHandle {
  const resetLgg = (): void => {
    Object.assign(params, IDENTITY_LGG);
  };
  const currentLut = (slot: number): Float32Array => {
    const data = grade.slots[slot].image.data as Uint8Array;
    const lut = new Float32Array(LUT_SIZE * LUT_SIZE * LUT_SIZE * 3);
    for (let i = 0; i < lut.length / 3; i++) {
      lut[i * 3] = data[i * 4] / 255;
      lut[i * 3 + 1] = data[i * 4 + 1] / 255;
      lut[i * 3 + 2] = data[i * 4 + 2] / 255;
    }
    return lut;
  };
  return {
    bake(slot, opts = {}) {
      const i = slotIndex(slot);
      const lut = lutFromLgg(params, LUT_SIZE);
      grade.setSlotLut(i, lut, LUT_SIZE);
      if (!opts.keepLgg) resetLgg();
      grade.update();
      return stripToDataUrl(lutToStrip(lut, LUT_SIZE));
    },
    bakeLut: () => lutFromLgg(params, LUT_SIZE),
    exportSlot: (slot) => stripToDataUrl(lutToStrip(currentLut(slotIndex(slot)), LUT_SIZE)),
    setSlotFromStrip(slot, img) {
      const strip = img instanceof HTMLImageElement ? imageToStrip(img) : img;
      const { lut, size } = lutFromStrip(strip);
      grade.setSlotLut(slotIndex(slot), lut, size);
    },
    async loadSlot(slot, url) {
      const i = slotIndex(slot);
      const { lut, size } = await loadLutStrip(url ?? LUT_STRIP_URLS[GRADE_SLOTS[i]]);
      grade.setSlotLut(i, lut, size);
    },
    resetSlot: (slot) => grade.setSlotLut(slotIndex(slot), identityLut(LUT_SIZE), LUT_SIZE),
    resetLgg,
    weights: (tod) => (tod === undefined ? grade.lastWeights : gradeBandWeights(tod, params)),
    bound() {
      const b = grade.lastBound;
      return { a: GRADE_SLOTS[b.a], b: GRADE_SLOTS[b.b], blend: b.blend };
    },
    params,
    slots: GRADE_SLOTS,
    strips: LUT_STRIP_URLS,
  };
}
