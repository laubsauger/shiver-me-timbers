import { describe, expect, it } from 'vitest';
import { uniform } from 'three/tsl';
import { WaterLitMaterial } from '../src/terrain/waterLitMaterial';

// Evaluate the actual lighting model's scalar graph, one color channel at a
// time. Inputs represent the already accumulated standard BRDF contributions.
function evaluate(node: any): number {
  if (node.isConstNode || node.isUniformNode) return node.value;
  // three r186 returns every `add`/`mul` result wrapped in a var INTENT
  // (`nodeProxyIntent` → `toVarIntent`): a hint that the builder may hoist it
  // into a variable, with no arithmetic of its own. Look through exactly that
  // wrapper; an explicit `toVar()` (intent false) still throws.
  if (node.isVarNode && node.intent === true) return evaluate(node.node);
  if (node.isOperatorNode) {
    if (node.op === '+') return evaluate(node.aNode) + evaluate(node.bNode);
    if (node.op === '*') return evaluate(node.aNode) * evaluate(node.bNode);
  }
  throw new Error(`Unexpected lighting node: ${node.type}`);
}

describe('submerged terrain specular absorption', () => {
  const attenuation = uniform(1);
  const material = new WaterLitMaterial(attenuation);
  const model = material.setupLightingModel();
  function light(directDiffuse: number, indirectDiffuse: number, directSpecular: number, indirectSpecular: number, lightingModel = model) {
    let result: any;
    lightingModel.finish({ context: {
      reflectedLight: {
        directDiffuse: uniform(directDiffuse), indirectDiffuse: uniform(indirectDiffuse),
        directSpecular: uniform(directSpecular), indirectSpecular: uniform(indirectSpecular),
      },
      outgoingLight: { assign(node: any) { result = node; } },
    } } as never);
    return evaluate(result);
  }

  it('preserves dry terrain lighting', () => {
    attenuation.value = 1;
    expect(light(2, 3, 5, 7)).toBe(17);
  });

  it('preserves water attenuation when the material is cloned', () => {
    const clone = material.clone();
    attenuation.value = 0.25;
    expect(light(2, 3, 5, 7, clone.setupLightingModel())).toBe(8);
    clone.dispose();
  });

  it('attenuates both specular paths without darkening diffuse twice', () => {
    for (const transmission of [0, 0.1, 0.5, 1]) {
      attenuation.value = transmission;
      expect(light(2, 3, 5, 7)).toBeCloseTo(5 + 12 * transmission);
      expect(light(2, 3, 0, 0)).toBe(5);
    }
  });

  it('uses each channel of the receiver attenuation, not a gray multiplier', () => {
    const rgb = [0.36, 0.08, 0.03].map(coefficient => {
      attenuation.value = Math.exp(-coefficient * 40 * 1.4);
      return light(0, 0, 1, 0);
    });
    expect(rgb[0]).toBeLessThan(rgb[1]);
    expect(rgb[1]).toBeLessThan(rgb[2]);
    expect(rgb[2]).toBeCloseTo(0.186374, 5);
  });
});
