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
  transformNormalToView,
  uniform,
  uv,
  vec2,
  vec3,
} from 'three/tsl';
import { bandLimitedEdge } from './bandLimit';
import { fbm2, hash2 } from '../terrain/noise';
import { shipFlagParams, type ShipFlagParams } from '../params/ship';
import { createFlagWindUniforms } from './flagDriver';
import { FLAG_CRACK_RATIO } from './flagDynamics';
import { jollyRoger } from './flagBadge';
import { uShipSunDirection } from './sailMaterial';
import type { ShipMaterialHandle } from './woodMaterial';

const TAU = Math.PI * 2;

/** style ids carried in the geometry's `flagShape.w` (see pieceGeometryRig) */
export const FLAG_STYLE_JOLLY = 0;
export const FLAG_STYLE_PENNANT = 1;
/** the raft's ensign (§T89 [§4 Mizzen]): red field, white-bordered blue Nordic cross */
export const FLAG_STYLE_NORWAY = 2;

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
  const uHang = uniform(p.flagHang);
  const uWaveAmp = uniform(p.flagWaveAmp);
  const uWaveCount = uniform(p.flagWaveCount);
  const uSnap = uniform(p.flagSnap);
  const uLeeDarken = uniform(p.flagLeeDarken);
  const uAmbientLift = uniform(p.flagAmbientLift);

  const wind = createFlagWindUniforms(p);
  const uRoot = wind.rootAngle;
  const uLag = wind.lagAngle;
  const uStrength = wind.strength;
  const uWavePhase = wind.wavePhase;
  const uCrackPhase = wind.crackPhase;

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

    // HANG. The cloth falls away from horizontal as the wind dies, and it does
    // so as an ANGLE, not as a shortening: the old form kept 77% of the fly
    // sticking out even in a dead calm, which is most of why the user saw
    // flags "very much flying hard" while stationary. The angle grows along
    // the fly, so the cloth curves down from the staff instead of tilting
    // rigidly like a rod.
    const droopT = u.mul(0.35).add(u.mul(u).mul(0.65));
    const theta = uHang.mul(uStrength.oneMinus()).mul(droopT);
    const reach = along.mul(theta.cos());
    const droop = along.mul(theta.sin());

    // travelling ripple, perpendicular to the streaming direction, growing
    // toward the free fly and skewed by v so the cloth twists as it waves.
    // Amplitude and rate both scale with the wind: a flag in a light air stirs
    // slowly and shallowly, and that difference is the information.
    //
    // THE TIME TERM IS AN INTEGRAL, NOT A PRODUCT. This used to read
    // `time.mul(rate)` with `rate` a function of the live stream strength,
    // which is the phase of a sine only while the rate is constant. It is not:
    // the flag breathes with the gusts, and sin(t·ω(t)) has instantaneous
    // frequency ω + t·dω/dt, so the elapsed time multiplied every wobble and
    // the flap ramped 0.93 Hz → 13 Hz by two minutes and 60 Hz by ten, sign
    // flips included. `uWavePhase` is ∫ω dt, accumulated per flag in
    // flagDriver.ts and wrapped there (§B "FLAG BUG AGAIN" — third time a flag
    // has had a rate/reference defect, and the first that was not a saturated
    // reference).
    // §B76: a crest sits where ωt − k·u is constant, so it moves toward +u —
    // FROM the hoist TO the fly. With `+ spatial` (the old form) the wave ran
    // in from the free end and the flag read as "starting at the tip".
    // Mirror: flagDynamics.flagRipplePhase / flagRippleGrow.
    const grow = u.mul(0.4).add(u.mul(u).mul(0.6));
    const spatial = u.mul(uWaveCount.mul(TAU));
    const carrier = uWavePhase.add(phase).sub(spatial);
    const wave = sin(carrier.add(v.mul(1.7)));
    // the snap: a faster, shorter crack that only appears once it is really
    // blowing — below half strength there is nothing to crack. Its own
    // integrated phase (the ratio is shared, not copied); the SPATIAL term is
    // still scaled by the same ratio, exactly as the old `carrier.mul(2.3)` did
    const cracking = smoothstep(float(0.45), float(0.95), uStrength);
    const crack = sin(
      uCrackPhase.add(phase.mul(1.3)).sub(spatial.mul(FLAG_CRACK_RATIO)),
    )
      .mul(uSnap)
      .mul(cracking);
    const amp = uWaveAmp.mul(hoist).mul(grow).mul(float(0.06).add(uStrength.mul(0.94)));
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
  // Norwegian ensign: Nordic cross, hoist-side arm at 6/22 of the fly, the
  // cross 4/22 wide with the blue 2/22 inside it — the flag's own proportions
  // @band-limited-elsewhere: `style` is a per-vertex constant, not a coordinate
  const isNorway = smoothstep(float(1.4), float(1.6), style);
  const cx = u0.sub(8 / 22).abs();
  const cy = v0.sub(0.5).abs();
  const nd = cx.min(cy); // distance to the nearer arm's centreline
  // the cross edges are steps in uv: widened to the pixel footprint (§V.48)
  const white = bandLimitedEdge(nd.sub(2 / 22).max(0), u0.add(v0), float(0.3 / 22)).oneMinus();
  const blue = bandLimitedEdge(nd.sub(1 / 22).max(0), u0.add(v0), float(0.3 / 22)).oneMinus();
  const norwayColor = mix(mix(vec3(0.52, 0.02, 0.06), vec3(0.9, 0.88, 0.84), white), vec3(0.0, 0.06, 0.28), blue);
  const pattern = mix(mix(pennantColor, jollyColor, isJolly), norwayColor, isNorway);

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
      uHang.value = p.flagHang;
      uWaveAmp.value = p.flagWaveAmp;
      uWaveCount.value = p.flagWaveCount;
      uSnap.value = p.flagSnap;
      uLeeDarken.value = p.flagLeeDarken;
      uAmbientLift.value = p.flagAmbientLift;
    },
  };
}
