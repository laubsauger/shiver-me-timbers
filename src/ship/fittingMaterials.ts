/**
 * Non-timber piece materials: wrought iron and cabin glass (§T.34 fittings).
 *
 * These deliberately do NOT go through createWoodMaterial: an anchor with
 * plank seams caulked across it, or a window pane with wale strakes, is worse
 * than a flat colour. They keep the parts of the wood material that are about
 * the SHIP rather than about timber — the caustics/bounce hook, so ironwork
 * near the waterline catches the same reflected light the planking does.
 *
 * §V23 functional mix()/smoothstep(). §V31 colours via THREE.Color(hex).
 */
import * as THREE from 'three/webgpu';
import {
  cameraPosition,
  float,
  mix,
  normalLocal,
  normalWorldGeometry,
  positionLocal,
  positionWorld,
  smoothstep,
  uniform,
  vec3,
  vec4,
} from 'three/tsl';
import { waterLighting } from '../caustics';
import { triplanarFbm } from '../terrain/noise';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';
import { uShipWorldInverse, type ShipMaterialHandle } from './woodMaterial';

/** wrought iron: anchors, chainplate straps, deadeye bands */
export function createIronMaterial(
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0.65;
  const uLight = uniform(new THREE.Color(p.ironLight));
  const uDark = uniform(new THREE.Color(p.ironDark));

  // hammer-scale and rust pitting: low-octave noise, deliberately blotchy so
  // no two straps read the same
  const pit = triplanarFbm(positionLocal.mul(7.5), normalLocal, float(6), 3);
  const color = mix(uDark, uLight, smoothstep(float(0.35), float(0.85), pit));
  const water = waterLighting({
    worldPos: positionWorld,
    normal: normalWorldGeometry,
    shipLocalPos: uShipWorldInverse.mul(vec4(positionWorld, 1)).xyz,
    mode: 'both',
  });
  material.colorNode = color.mul(water.tint);
  material.emissiveNode = water.addLight;
  material.roughnessNode = mix(float(0.42), float(0.78), pit).mul(water.roughnessScale).clamp(0.05, 1);

  return {
    material,
    refresh(): void {
      uLight.value.set(p.ironLight);
      uDark.value.set(p.ironDark);
    },
  };
}

/**
 * Cabin lights. Glass is the one surface on the ship that must NOT read as
 * matte, and the great cabin behind it is lit — so the panes carry a warm
 * emissive floor that rises as you look square into them, which is what makes
 * a stern gallery read as windows rather than as dark panels.
 */
export function createGlassMaterial(
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.metalness = 0.1;
  material.roughness = 0.14;
  const uGlass = uniform(new THREE.Color(p.glassColor));
  const uLit = uniform(new THREE.Color(p.glassLit));

  // old crown glass is uneven; the ripple is what catches a moving highlight
  const ripple = triplanarFbm(positionLocal.mul(vec3(9, 22, 9)), normalLocal, float(6), 2);
  material.colorNode = uGlass.mul(mix(float(0.82), float(1.18), ripple));
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const facing = normalWorldGeometry.dot(viewDir).clamp(0, 1);
  material.emissiveNode = uLit.mul(smoothstep(float(0.15), float(0.9), facing).add(0.25));
  material.roughnessNode = mix(float(0.08), float(0.24), ripple);

  return {
    material,
    refresh(): void {
      uGlass.value.set(p.glassColor);
      uLit.value.set(p.glassLit);
    },
  };
}
