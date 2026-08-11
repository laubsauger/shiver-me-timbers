/**
 * Flag / pennant cloth (§T.34, user request: "a little pirate flag on the
 * tippity top ... flags that give some more dynamic feeling to the wind and
 * the motion direction that we're going in relative to the wind").
 *
 * The whole shape is rebuilt in the vertex stage from two per-object angles
 * and a stream strength (flagDriver.ts → flagDynamics.ts), so the cloth
 * STREAMS rather than rotating rigidly: the root leaves the staff along the
 * apparent wind, the fly tip trails behind it, travelling ripples run out
 * along the fly and grow toward the free end, and the whole thing droops when
 * the apparent wind dies. Coming about therefore reads as a crack running out
 * to the tip, which is the thing that makes it look like a flag and not a
 * weather vane.
 *
 * §V23: functional mix()/smoothstep() only. §V28: every divisor floored.
 * §V31: colours enter through THREE.Color(hex).
 */
import * as THREE from 'three/webgpu';
import {
  Fn,
  attribute,
  clamp,
  cross,
  directionToFaceDirection,
  float,
  max,
  mix,
  normalLocal,
  normalWorld,
  positionLocal,
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
import { shipFlagParams, type ShipFlagParams } from '../params/ship';
import { createFlagWindUniforms } from './flagDriver';
import { jollyRoger } from './flagBadge';
import { uShipSunDirection } from './sailMaterial';
import type { ShipMaterialHandle } from './woodMaterial';

const TAU = Math.PI * 2;

/** style ids carried in the geometry's `flagShape.w` (see pieceGeometryRig) */
export const FLAG_STYLE_JOLLY = 0;
export const FLAG_STYLE_PENNANT = 1;

export function createFlagClothMaterial(
  p: ShipFlagParams = shipFlagParams,
): ShipMaterialHandle {
  const material = new THREE.MeshStandardNodeMaterial();
  material.side = THREE.DoubleSide; // a flag is one surface
  material.metalness = 0;
  material.roughness = 0.92;

  const uField = uniform(new THREE.Color(p.fieldColor));
  const uBadge = uniform(new THREE.Color(p.badgeColor));
  const uPennant = uniform(new THREE.Color(p.pennantColor));
  const uStripe = uniform(new THREE.Color(p.pennantStripe));
  const uSag = uniform(p.flagSag);
  const uWaveAmp = uniform(p.flagWaveAmp);
  const uWaveFreq = uniform(p.flagWaveFreq);
  const uWaveCount = uniform(p.flagWaveCount);
  const uSnap = uniform(p.flagSnap);
  const uLeeDarken = uniform(p.flagLeeDarken);
  const uAmbientLift = uniform(p.flagAmbientLift);

  const wind = createFlagWindUniforms(p);
  const uRoot = wind.rootAngle;
  const uLag = wind.lagAngle;
  const uStrength = wind.strength;

  // (clothWeight, fly, hoist, style): the staff carries weight 0 so it never
  // moves, and one shared material serves every flag size and pattern
  const shapeAttr = attribute('flagShape', 'vec4');
  const clothWeight = shapeAttr.x;
  const fly = max(shapeAttr.y, float(0.01)); // §V28 floored divisor
  const hoist = max(shapeAttr.z, float(0.01));
  const style = shapeAttr.w;
  // per-flag ripple phase from its own dimensions — the fore and main
  // pennants must never ripple in lockstep (§B.4 global-sync pulse)
  const phase = hash2(vec2(fly.mul(2.13), hoist.mul(5.77))).mul(TAU);

  /** cloth surface point (local space) for flag coords (u along fly, v up) */
  const clothAt = Fn(([u, v]: [ReturnType<typeof float>, ReturnType<typeof float>]) => {
    const along = u.mul(fly);
    // the tip trails the root: the lag is spread linearly along the fly, so a
    // course change travels outward instead of pivoting the whole flag
    const ang = uRoot.add(uLag.mul(u));
    const dirX = ang.cos();
    const dirZ = ang.sin();
    // slack cloth hangs: it loses horizontal reach and gains droop together
    const sag = uSag.mul(uStrength.oneMinus());
    const reach = along.mul(float(1).sub(sag.mul(0.55)));
    const droop = along.mul(sag);

    // travelling ripple, perpendicular to the streaming direction, growing
    // toward the free fly and skewed by v so the cloth twists as it waves
    const grow = u.mul(0.4).add(u.mul(u).mul(0.6));
    const carrier = time.mul(uWaveFreq).add(phase).add(u.mul(uWaveCount.mul(TAU)));
    const wave = sin(carrier.add(v.mul(1.7)));
    // the snap: a faster, shorter wave that only appears once it is blowing
    const crack = sin(carrier.mul(2.3).add(phase.mul(1.3))).mul(uSnap).mul(uStrength);
    const amp = uWaveAmp.mul(hoist).mul(grow).mul(float(0.3).add(uStrength.mul(0.7)));
    const swing = wave.add(crack.mul(0.4)).mul(amp);

    return vec3(
      dirX.mul(reach).sub(dirZ.mul(swing)),
      positionLocal.y.sub(droop).add(swing.mul(grow).mul(0.18)),
      dirZ.mul(reach).add(dirX.mul(swing)),
    );
  });

  const flagUv = uv();
  const u0 = flagUv.x;
  const v0 = flagUv.y;
  const surface = clothAt(u0, v0);
  material.positionNode = mix(positionLocal, surface, clothWeight);

  // normals from finite differences of the same surface — without this the
  // ripples are invisible to the lighting and the flag reads as a flat decal
  const e = float(0.035);
  const du = clothAt(u0.add(e), v0).sub(surface);
  const dv = clothAt(u0, v0.add(e)).sub(surface);
  const clothNormal = cross(du, dv).normalize();
  const localNormal = mix(normalLocal, clothNormal, clothWeight).normalize();
  material.normalNode = directionToFaceDirection(
    transformNormalToView(localNormal).toVarying('vFlagNormalView').normalize(),
  );

  // --- pattern --------------------------------------------------------------
  const isJolly = float(1).sub(smoothstep(float(0.4), float(0.6), style));
  const badge = jollyRoger(u0, v0, fly.div(hoist));
  const jollyColor = mix(uField, uBadge, badge.mul(isJolly));
  // coachwhip pennant: a bold two-band streamer, readable at masthead range
  const pennantColor = mix(uPennant, uStripe, smoothstep(float(0.52), float(0.6), v0));
  const pattern = mix(pennantColor, jollyColor, isJolly);

  // weave + weathering: a flag lives at the masthead and is the most beaten
  // piece of cloth on the ship, so the fly end is faded and thin
  const weave = fbm2(vec2(u0.mul(fly).mul(9), v0.mul(hoist).mul(26)), 2);
  const wear = smoothstep(float(0.45), float(1), u0).mul(0.35);
  const cloth = pattern
    .mul(mix(float(0.9), float(1.06), weave))
    .mul(mix(float(1), float(1.18), wear));

  // lighting: same rule the sails learned the hard way — grazing sun must
  // read as LIT, only a genuinely turned-away face darkens (§B sail-darkness)
  const sunDot = normalWorld.dot(uShipSunDirection);
  const lit = smoothstep(float(-0.45), float(-0.02), sunDot);
  material.colorNode = cloth.mul(mix(uLeeDarken, float(1), lit));
  // thin cloth against the sky: a small ambient floor so the lee side of a
  // flag never goes to dead black against a bright horizon
  material.emissiveNode = cloth.mul(
    uAmbientLift.mul(clamp(sunDot.negate(), float(0), float(1)).mul(1.4).add(0.6)),
  );

  return {
    material,
    refresh(): void {
      uField.value.set(p.fieldColor);
      uBadge.value.set(p.badgeColor);
      uPennant.value.set(p.pennantColor);
      uStripe.value.set(p.pennantStripe);
      uSag.value = p.flagSag;
      uWaveAmp.value = p.flagWaveAmp;
      uWaveFreq.value = p.flagWaveFreq;
      uWaveCount.value = p.flagWaveCount;
      uSnap.value = p.flagSnap;
      uLeeDarken.value = p.flagLeeDarken;
      uAmbientLift.value = p.flagAmbientLift;
    },
  };
}
