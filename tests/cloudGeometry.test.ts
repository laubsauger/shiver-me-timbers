import { expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createCloudLobeGeometry } from '../src/clouds/cloudGeometry';

it.each([0, 1, 2, 3])('cloud indexing preserves every triangle attribute bit at detail %i', detail => {
  const source = new THREE.IcosahedronGeometry(1, detail);
  const indexed = createCloudLobeGeometry(detail);
  const indices = indexed.getIndex()!;
  expect(indices.count).toBe(source.getAttribute('position').count);
  for (const name of ['position', 'normal', 'uv']) {
    const before = source.getAttribute(name) as THREE.BufferAttribute;
    const after = indexed.getAttribute(name) as THREE.BufferAttribute;
    const expected = new Uint32Array(before.array.buffer);
    const actual = new Uint32Array(after.array.buffer);
    const restored = new Uint32Array(expected.length);
    for (let corner = 0; corner < indices.count; corner++) {
      const start = indices.getX(corner) * after.itemSize;
      restored.set(actual.subarray(start, start + after.itemSize), corner * after.itemSize);
    }
    expect(restored).toEqual(expected);
  }
  if (detail > 0) {
    expect(indexed.getAttribute('position').count).toBeLessThan(indices.count / 2);
  }
  source.dispose();
  indexed.dispose();
});
