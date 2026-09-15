/**
 * B124: blocky dark bars on the far sea, hugging the horizon, with nothing above the water to cause them. The ocean
 * writes depth (§V28), so GTAO marched the grazing water sheet itself and the composite multiplied that occlusion onto
 * the water. These pin the rule that removed it: AO lands only on surfaces that receive it, and the sea does not
 * (its look is pigment + Fresnel reflection + transmission; the mirror owns what occludes its reflection).
 */
import { describe, expect, it } from 'vitest';
import { MeshBasicNodeMaterial, MeshStandardNodeMaterial } from 'three/webgpu';
import { AO_RECEIVER_OUTPUT, aoReceptivity, markAoExempt } from '../src/core/aoReceiver';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import postPipelineSource from '../src/core/postPipeline.ts?raw';

describe('AO receptivity (B124)', () => {
  it('every surface receives AO unless it says otherwise — hulls, decks and terrain keep their contact shading', () => {
    expect(aoReceptivity(new MeshStandardNodeMaterial())).toBe(1);
    expect(aoReceptivity(null)).toBe(1);
  });

  it('a surface marked exempt receives none', () => {
    const sea = new MeshBasicNodeMaterial();
    markAoExempt(sea);
    expect(aoReceptivity(sea)).toBe(0);
  });

  it('the ocean material marks itself exempt, and the composite scales AO by the receptivity target', () => {
    // lexical, because the ocean material needs a live GPU cascade to build: removing either half brings the bars back
    expect(surfaceMaterialSource).toMatch(/markAoExempt\(material\)/);
    expect(postPipelineSource).toContain(`getTextureNode(AO_RECEIVER_OUTPUT)`);
    expect(postPipelineSource).toMatch(/uAoAmount\.mul\(aoReceiver\)/);
    expect(AO_RECEIVER_OUTPUT).toBe('aoReceiver');
  });
});
