/**
 * Eye-facing billboards for dome capture.
 *
 * three's Sprite faces the camera's VIEW PLANE. A dome master is stitched from six cube cameras that share
 * a position but not a view plane, so a large sprite near the eye is drawn at a different orientation on
 * each face it touches and breaks visibly at the seams. These quads face the eye's POSITION instead (the
 * basis is built from the direction eye → centre), which all six faces agree on, so they stitch seamlessly.
 * The same reasoning orients the track ribbons (tracks.ts).
 */
import * as THREE from 'three/webgpu';
import { abs, attribute, cameraPosition, cross, normalize, select, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** a unit quad (corners at ±0.5) with uv, instanced `count` times */
export function billboardMesh(material: THREE.NodeMaterial, count: number, name: string): THREE.InstancedMesh {
  const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), material, count);
  mesh.frustumCulled = false;
  mesh.name = name;
  return mesh;
}

/** world position of this quad corner: `center` faced toward the eye, `size` across */
export function eyeFacing(center: V3, size: F): V3 {
  const corner = attribute<'vec3'>('position', 'vec3');
  const toEye = normalize(cameraPosition.sub(center));
  // world up, unless the quad sits (almost) straight above or below the eye
  const up0 = select(abs(toEye.y).greaterThan(0.98), vec3(1, 0, 0), vec3(0, 1, 0)) as V3;
  const right = normalize(cross(up0, toEye));
  const up = cross(toEye, right);
  return center.add(right.mul(corner.x.mul(size))).add(up.mul(corner.y.mul(size)));
}
