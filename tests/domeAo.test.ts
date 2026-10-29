/**
 * The dome capture's ambient occlusion (src/cine/domeAo.ts): the sea acts' contact and crevice darkening of the sky's
 * light. These pin the two rules a wrong frame would not announce:
 *   - WHO RECEIVES IT: lit, opaque, depth-writing surfaces only. The sea is pigment + Fresnel + transmission (B124:
 *     occluded, it printed bars on the far water), the sky sphere and the glows are emitters, the swash's sheet and
 *     the spray are transparent films — darkening any of them is a defect, not a look.
 *   - THE GUARD BAND: each face's pre-pass must reach `BAND_DEG` of arc past the face on every side, or the march at
 *     a face's edge runs off the pre-pass and the two faces meeting there disagree — a seam on the dome.
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial, NodeMaterial } from 'three/webgpu';
import { domeAoBand, receivesDomeAo } from '../src/cine/domeAo';
import { markAoExempt } from '../src/core/aoReceiver';
import domeAoSource from '../src/cine/domeAo.ts?raw';

describe('dome AO receivers', () => {
  it('a lit, opaque, depth-writing surface receives it — the raft, the trunks, the sand', () => {
    expect(receivesDomeAo(new MeshStandardNodeMaterial())).toBe(true);
  });

  it('the water (marked exempt, and transparent) does not', () => {
    const sea = new MeshStandardNodeMaterial();
    markAoExempt(sea);
    expect(receivesDomeAo(sea)).toBe(false);
    expect(receivesDomeAo(new MeshStandardNodeMaterial({ transparent: true }))).toBe(false);
  });

  it('unlit surfaces do not: three treats a basic material’s whole colour as indirect light (the sky sphere)', () => {
    expect(receivesDomeAo(new MeshBasicNodeMaterial())).toBe(false);
    expect(receivesDomeAo(new NodeMaterial())).toBe(false);
  });

  it('what writes no depth does not: the pre-pass never saw it', () => {
    expect(receivesDomeAo(new MeshStandardNodeMaterial({ depthWrite: false }))).toBe(false);
  });
});

describe('dome AO guard band', () => {
  const bandDeg = Number(/const BAND_DEG = ([\d.]+);/.exec(domeAoSource)?.[1]);

  it('reaches BAND_DEG of arc past a face edge, for every face size the recorder makes, at both resolutions', () => {
    expect(bandDeg).toBeGreaterThan(0);
    for (const size of [256, 576, 1136, 2256, 4512, 9024]) {
      for (const scale of [1, 2]) {
        const band = domeAoBand(size, scale);
        // the face spans tan 45° = 1 each side of its axis in size / 2 px; BAND_DEG past its edge is tan(45° + BAND_DEG)
        const needed = (size / 2) * Math.tan(((45 + bandDeg) * Math.PI) / 180) - size / 2;
        expect(band).toBeGreaterThanOrEqual(needed);
        // and whole pre-pass texels, so a face pixel lands on the texel rasterised from it
        expect(band % scale).toBe(0);
      }
    }
  });
});
