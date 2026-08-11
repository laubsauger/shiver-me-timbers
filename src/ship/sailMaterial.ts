/**
 * Sail cloth material (T8 / §V22 sail critique). Two things live here:
 *
 * 1. MOTION. The belly, the luff-shake and the gust ripple are computed in
 *    the vertex stage from the REAL wind and the ship's own heading, so the
 *    cloth fills on a run, backs and shivers when the wind heads it, and
 *    shakes while the ship swings. The drive values come from
 *    sailDynamics.ts through per-object uniforms updated in `onObjectUpdate`
 *    — the ship's world matrix is read off the object itself, so nothing
 *    outside src/ship has to push state in (§V3: read-only on sim data,
 *    wind is read from params/ocean, the same object the sim reads).
 * 2. SHADING. The lee face must read genuinely dark. The old material lifted
 *    every fragment with a flat emissive floor and glowed on ANY backfacing
 *    normal, so both faces looked sunlit. Now transmission needs the viewer
 *    to be looking sunward THROUGH the cloth, and the shaded face gets a
 *    real albedo drop, with vertex normals rebuilt from the live billow so
 *    the curvature shades.
 *
 * §V23: functional mix()/smoothstep() only — chained a.mix(b,t) reads the
 * receiver as the factor (§B.1/§B.2).
 * §V28: every divisor floored, every uniform finite-guarded in sailDynamics.
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  cameraPosition,
  clamp,
  cross,
  directionToFaceDirection,
  float,
  fract,
  max,
  mix,
  normalLocal,
  normalWorld,
  positionLocal,
  positionWorld,
  sin,
  smoothstep,
  time,
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { fbm2, hash2 } from '../terrain/noise';
import { skyParams } from '../params/sky';
import { sunDirection } from '../sky/sunCycle';
import { shipMaterialParams, type ShipMaterialParams } from '../params/ship';
import { createSailWindUniforms } from './sailDriver';
import type { ShipMaterialHandle } from './woodMaterial';

const TAU = Math.PI * 2;

/** live sun direction (toward the sun), re-derived from the same pure
 *  function + params the sky rig uses — no wiring through main.ts */
export const uShipSunDirection = /*@__PURE__*/ uniform(
  new THREE.Vector3(0.4, 0.75, 0.3).normalize(),
).onRenderUpdate((): void => {
  const d = sunDirection(skyParams.timeOfDay, skyParams.latitude);
  uShipSunDirection.value.set(d[0], d[1], d[2]);
});

/** off-white weathered canvas: wind-driven shape + backlit translucency */
export function createSailClothMaterial(
  p: ShipMaterialParams = shipMaterialParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // sails are single surfaces
  material.metalness = 0;
  material.roughness = 0.95;

  const uLight = uniform(new THREE.Color(p.sailLight));
  const uDark = uniform(new THREE.Color(p.sailDark));
  const uWeaveScale = uniform(p.sailWeaveScale);
  const uBacklitColor = uniform(new THREE.Color(p.sailBacklitColor));
  const uBacklitStrength = uniform(p.sailBacklitStrength);
  const uBacklitFocus = uniform(p.sailBacklitFocus);
  const uLeeDarken = uniform(p.sailLeeDarken);
  const uBillow = uniform(p.sailBillow);
  const uFlutterAmp = uniform(p.sailFlutterAmp);
  const uFlutterFreq = uniform(p.sailFlutterFreq);
  const uLuffFlap = uniform(p.sailLuffFlap);
  const uRippleCount = uniform(p.sailRippleCount);
  const uPanelCount = uniform(p.sailPanelCount);
  const uSeamDarken = uniform(p.sailSeamDarken);
  const uAmbientLift = uniform(p.sailAmbientLift);
  const uStain = uniform(p.sailStainStrength);

  // per-sail wind state (object uniform buffer, driven in sailDriver.ts)
  const wind = createSailWindUniforms(p);
  const uDrive = wind.drive;
  const uLuff = wind.luff;
  const uSkew = wind.skew;

  // --- shape ---------------------------------------------------------------
  // (clothWeight, width, drop): robands and the furled roll carry weight 0 so
  // only cloth moves; width/drop let one shared material serve every sail size
  const shapeAttr = attribute('sailShape', 'vec3');
  const clothWeight = shapeAttr.x;
  const width = max(shapeAttr.y, float(0.01)); // §V28 floored divisor
  // live drop = built drop × the sim's trim scale, so easing the sheets
  // shortens the canvas continuously instead of popping between trim states
  const clothScale = mix(float(1), wind.dropScale, clothWeight);
  const drop = max(shapeAttr.z.mul(clothScale), float(0.01));
  // per-sail phase from its own dimensions — no two sails ripple in step (§B.4)
  const phase = hash2(vec2(width.mul(3.71), drop.mul(1.17))).mul(TAU);

  /** billow + flutter offset (m, along local +z = forward of the yard) */
  const clothZ = Fn(([u, v]: [ReturnType<typeof float>, ReturnType<typeof float>]) => {
    // belly: sin² across, pinned at the head, shifted to leeward while turning
    const us = clamp(u.add(uSkew.mul(0.22).mul(v.oneMinus())), float(0), float(1));
    // squared by multiplication, NOT pow(): WGSL pow() with a base that
    // rounds a hair below zero is undefined → NaN vertices (§V28, §B.5)
    const arch = sin(us.mul(Math.PI));
    const across = arch.mul(arch);
    const down = smoothstep(float(0), float(0.9), v.oneMinus());
    const belly = across.mul(down).mul(uDrive).mul(uBillow).mul(drop);
    // flutter: travelling ripples, biggest at the free foot and the leeches,
    // faster and deeper the harder the sail is shaking
    const shake = float(0.3).add(uLuff.mul(uLuffFlap));
    const rippleFreq = uFlutterFreq.mul(float(1).add(uLuff));
    const wave = sin(
      time.mul(rippleFreq).add(phase).add(u.mul(uRippleCount.mul(TAU))).add(v.mul(2.1)),
    );
    const edge = float(0.35).add(u.sub(0.5).abs().mul(1.3));
    const flutter = wave.mul(uFlutterAmp).mul(shake).mul(v.oneMinus()).mul(edge);
    return belly.add(flutter);
  });

  const cloth = uv();
  const u0 = cloth.x;
  const v0 = cloth.y;
  const z0 = clothZ(u0, v0);
  // cloth hangs from the head (local y = 0), so scaling y shortens it from
  // the foot up and leaves it bent to its yard
  const hung = positionLocal.mul(vec3(1, clothScale, 1));
  material.positionNode = hung.add(vec3(0, 0, z0.mul(clothWeight)));

  // normals rebuilt from the live surface (finite differences in cloth
  // space) — without this the billow is invisible to the lighting
  const e = float(0.03);
  const du = vec3(width.mul(e), 0, clothZ(u0.add(e), v0).sub(z0));
  const dv = vec3(0, drop.mul(e), clothZ(u0, v0.add(e)).sub(z0));
  const billowNormal = cross(du, dv).normalize();
  const localNormal = mix(normalLocal, billowNormal, clothWeight).normalize();
  material.normalNode = directionToFaceDirection(
    transformNormalToView(localNormal).toVarying('vSailNormalView').normalize(),
  );

  // --- colour --------------------------------------------------------------
  const warp = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec2(1, 6)), 2);
  const weft = fbm2(positionLocal.xy.mul(uWeaveScale).mul(vec2(6, 1)), 2);
  const weave = warp.add(weft).mul(0.5);
  const stain = fbm2(positionLocal.xy.mul(0.35), 3);
  const panelTone = hash2(vec2(cloth.x.mul(uPanelCount).floor(), 3.7));
  const base = mix(uDark, uLight, weave)
    .mul(mix(float(1).sub(uStain), float(1), stain))
    .mul(mix(float(0.92), float(1.03), panelTone));

  const pf = fract(cloth.x.mul(uPanelCount));
  const panelMask = smoothstep(float(0), float(0.045), pf.min(pf.oneMinus()));
  const hemMask = smoothstep(
    float(0),
    float(0.03),
    cloth.x.min(cloth.x.oneMinus()).min(cloth.y),
  );
  const cloth3 = mix(base.mul(uSeamDarken), base, panelMask.min(hemMask));

  // shading normal in world space — normalWorld resolves to the material's
  // own normalNode (set above), so this is the billowed, face-flipped normal
  const sunDot = normalWorld.dot(uShipSunDirection);
  // Lee face albedo drop, but ONLY once the face is genuinely turned away.
  // MEASURED BUG (in-browser): the band used to open at −0.15 and not close
  // until +0.4, so a sun GRAZING the cloth (sunDot ≈ 0, which is most of the
  // day for square sails — their normals are fore-and-aft) darkened BOTH
  // faces to ~0.59 albedo. Sun-side and lee-side screenshots came out
  // identically dark grey, and switching the sun's shadows off changed
  // nothing, which is what proved it was this term and not self-shadowing.
  // Grazing light must now read as fully lit; only a real back-face darkens.
  const lit = smoothstep(float(-0.45), float(-0.02), sunDot);
  material.colorNode = cloth3.mul(mix(uLeeDarken, float(1), lit));

  // transmission: the sun must be BEHIND the cloth and the viewer looking
  // roughly toward it — not a blanket glow on every backfacing fragment
  const viewDir = cameraPosition.sub(positionWorld).normalize();
  const sunward = clamp(uShipSunDirection.dot(viewDir.negate()), float(0), float(1));
  const through = max(sunDot.negate(), float(0)).mul(sunward.pow(uBacklitFocus));
  material.emissiveNode = uBacklitColor.mul(through.mul(uBacklitStrength).add(uAmbientLift));

  return {
    material,
    refresh(): void {
      uLight.value.set(p.sailLight);
      uDark.value.set(p.sailDark);
      uWeaveScale.value = p.sailWeaveScale;
      uBacklitColor.value.set(p.sailBacklitColor);
      uBacklitStrength.value = p.sailBacklitStrength;
      uBacklitFocus.value = p.sailBacklitFocus;
      uLeeDarken.value = p.sailLeeDarken;
      uBillow.value = p.sailBillow;
      uFlutterAmp.value = p.sailFlutterAmp;
      uFlutterFreq.value = p.sailFlutterFreq;
      uLuffFlap.value = p.sailLuffFlap;
      uRippleCount.value = p.sailRippleCount;
      uPanelCount.value = p.sailPanelCount;
      uSeamDarken.value = p.sailSeamDarken;
      uAmbientLift.value = p.sailAmbientLift;
      uStain.value = p.sailStainStrength;
    },
  };
}
