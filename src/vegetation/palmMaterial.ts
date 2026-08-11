/**
 * Palm TSL material (T26). One material for the whole palm, branching on the
 * baked `role` attribute (palmGeometry.ts): trunk gets procedural ringed bark
 * stripes, fronds a two-tone green ramp along their length, coconuts a flat
 * husk tint. Translucency fake: when the sun is behind a frond
 * (dot(normalWorld, sunDir) < 0) a warm green backlit glow is added via
 * emissiveNode — no physical SSS. All colors/knobs live in params/vegetation
 * (§V16) and refresh() re-reads them each frame for live panel tweaks.
 */
import * as THREE from 'three/webgpu';
import { attribute, float, fract, mix, normalWorld, step, uniform, uv } from 'three/tsl';
import { vegetationParams, type VegetationParams } from '../params/vegetation';

export function createPalmMaterial(p: VegetationParams = vegetationParams) {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // frond strips are single planes
  material.roughness = 0.85;
  material.metalness = 0;

  const uTrunkColor = uniform(new THREE.Color(p.trunkColor));
  const uStripeColor = uniform(new THREE.Color(p.barkStripeColor));
  const uFrondDark = uniform(new THREE.Color(p.frondColorDark));
  const uFrondLight = uniform(new THREE.Color(p.frondColorLight));
  const uBacklitColor = uniform(new THREE.Color(p.backlitColor));
  const uCoconutColor = uniform(new THREE.Color(p.coconutColor));
  const uRingFrequency = uniform(p.barkRingFrequency);
  const uStripeRatio = uniform(p.barkStripeRatio);
  const uBacklitStrength = uniform(p.backlitStrength);
  const uSunDirection = uniform(new THREE.Vector3(0.4, 0.75, 0.3).normalize());

  // role masks: 0 = trunk, 1 = frond, 2 = coconut
  const role = attribute('role', 'float');
  const frondMask = step(float(0.5), role).mul(step(float(1.5), role).oneMinus());
  const coconutMask = step(float(1.5), role);
  const trunkMask = step(float(0.5), role).oneMinus();

  const coords = uv();

  // trunk: procedural ring stripes along height (uv.y = 0..1 up the trunk)
  const ring = step(uStripeRatio, fract(coords.y.mul(uRingFrequency)));
  const barkColor = mix(uStripeColor, uTrunkColor, ring);

  // fronds: two-tone green, darker at the stem, brighter toward the tip
  const frondColor = mix(uFrondDark, uFrondLight, coords.y);

  material.colorNode = barkColor
    .mul(trunkMask)
    .add(frondColor.mul(frondMask))
    .add(uCoconutColor.mul(coconutMask));

  // backlit boost: normal facing away from the sun → warm green glow
  const backlit = normalWorld.dot(uSunDirection).min(0).negate();
  material.emissiveNode = uBacklitColor.mul(backlit.mul(uBacklitStrength).mul(frondMask));

  return {
    material,
    uSunDirection,
    /** re-read live-tweakable params (Tweakpane mutates them in place) */
    refresh(): void {
      uTrunkColor.value.set(p.trunkColor);
      uStripeColor.value.set(p.barkStripeColor);
      uFrondDark.value.set(p.frondColorDark);
      uFrondLight.value.set(p.frondColorLight);
      uBacklitColor.value.set(p.backlitColor);
      uCoconutColor.value.set(p.coconutColor);
      uRingFrequency.value = p.barkRingFrequency;
      uStripeRatio.value = p.barkStripeRatio;
      uBacklitStrength.value = p.backlitStrength;
    },
  };
}

export type PalmMaterial = ReturnType<typeof createPalmMaterial>;
