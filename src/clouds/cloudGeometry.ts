import * as THREE from 'three/webgpu';

/**
 * Index identical icosphere vertices so the GPU can reuse the expensive cloud
 * displacement and normal calculation. Keep every attribute bit and triangle
 * corner unchanged, including UV seams and flat normals at detail zero.
 */
export function createCloudLobeGeometry(detail: number): THREE.BufferGeometry {
  const source = new THREE.IcosahedronGeometry(1, detail);
  const names = ['position', 'normal', 'uv'] as const;
  const attributes = names.map(name => source.getAttribute(name) as THREE.BufferAttribute);
  const bits = attributes.map(attribute => {
    const array = attribute.array;
    return new Uint32Array(array.buffer, array.byteOffset, array.length);
  });
  const unique = new Map<string, number>();
  const retained: number[] = [];
  const indices: number[] = [];
  for (let vertex = 0; vertex < attributes[0].count; vertex++) {
    const key = attributes.map((attribute, lane) => {
      const start = vertex * attribute.itemSize;
      return bits[lane].subarray(start, start + attribute.itemSize).join(',');
    }).join('|');
    let index = unique.get(key);
    if (index === undefined) {
      index = retained.length;
      unique.set(key, index);
      retained.push(vertex);
    }
    indices.push(index);
  }
  const geometry = new THREE.BufferGeometry();
  attributes.forEach((attribute, lane) => {
    const array = new Float32Array(retained.length * attribute.itemSize);
    retained.forEach((vertex, index) => {
      array.set(attribute.array.subarray(
        vertex * attribute.itemSize, (vertex + 1) * attribute.itemSize,
      ), index * attribute.itemSize);
    });
    geometry.setAttribute(names[lane], new THREE.BufferAttribute(array, attribute.itemSize));
  });
  geometry.setIndex(indices);
  source.dispose();
  return geometry;
}
