/**
 * The planet's life as shader layers over the measured Earth (earthMaps.ts; life.ts gives the states). Each
 * layer arrives as a TIME WAVE: a soft front travelling over the sphere from a point on the front limb
 * toward the audience, its edge broken by noise, so a layer is never switched on — it rolls in.
 *
 *   young     before life the land is bare: where the Blue Marble is green (forest, field, steppe) it is
 *             rock and sediment instead; the deserts are as they are
 *   fields    a first front brings back about half of the green
 *   forests   a second front brings the rest: the land as the satellites see it today
 *   ice       the young world's ice: caps down to ~50° latitude and snow down to ~1800 m, settling to the
 *             caps of today's climate, shrinking further in the overshoot
 *   lights    on the night side only, from the Black Marble: camp fires first (a faint speckle where people
 *             will live), then every settlement grows from its brightest core out to its dim edges; in the
 *             overshoot they brighten, whiten (LED) and run together; under the risen sea they go dark
 *   sea       metres the sea has risen: the measured elevation floods to it
 */
import * as THREE from 'three/webgpu';
import { abs, float, floor, hash, max, mix, mx_noise_float, smoothstep, step, vec3 } from 'three/tsl';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

export interface LifeUniforms {
  fields: F;
  forests: F;
  ice: F;
  lights: F;
  overshoot: F;
  sea: F;
  /** unit, where the time waves start (a point on the front limb) */
  waveOrigin: V3;
}

/** m the sea rises by the end of the flood: about what all the land ice holds */
export const SEA_RISE_M = 70;

/** 0..1: has the front of a wave at progress k (0..1 over the half-sphere) reached unit surface normal n? */
function waveFront(n: V3, k: F, L: LifeUniforms, seed: number): F {
  const reach = float(1).sub(n.dot(L.waveOrigin)).mul(0.5); // 0 at the origin, 1 at its antipode
  const ragged = mx_noise_float(n.mul(5).add(seed)).mul(0.08).add(mx_noise_float(n.mul(40).add(seed * 2)).mul(0.015));
  return smoothstep(reach.add(ragged).sub(0.04), reach.add(ragged).add(0.04), k.mul(1.15));
}

/** m, the sea level now */
export const seaLevel = (L: LifeUniforms): F => L.sea.mul(SEA_RISE_M);

/**
 * The land's albedo (linear) with life on it: `real` is the Blue Marble colour, `bare` the same map's desert
 * (earth.ts samples the Sahara for it: real bare rock and sand, its own geology), `e` elevation (m), `lat` deg.
 */
export function lifeAlbedo(n: V3, real: V3, bare: V3, e: F, lat: F, L: LifeUniforms): V3 {
  // green: the vegetation index of the colour (forest ~0.2, steppe ~0.05, desert < 0)
  const green = smoothstep(0, 0.2, real.y.sub(real.x).div(real.y.add(real.x).add(1e-3)));
  // the young world's rock is darker and greyer than today's sand
  const young = mix(real, bare.mul(vec3(0.72, 0.66, 0.62)), green);
  const life = waveFront(n, L.fields, L, 1.3).mul(0.5).add(waveFront(n, L.forests, L, 4.7).mul(0.5));
  const a = mix(young, real, life);
  // ice: a latitude edge and a snow line, both broken by noise
  const ragged = mx_noise_float(n.mul(9).add(8.8));
  const edge = float(90).sub(L.ice.mul(40)).add(ragged.mul(4));
  const snowLine = float(4600).sub(L.ice.mul(2800)).add(ragged.mul(350));
  const ice = max(smoothstep(edge, edge.add(2.5), abs(lat)), smoothstep(snowLine, snowLine.add(400), e));
  return mix(a, vec3(0.72, 0.77, 0.82), ice);
}

/**
 * Night lights (emission, linear) from the Black Marble grey `v` (0..1, a gamma-encoded radiance), after the
 * ISS imagery: sodium amber with whiter cores, a faint rural speckle, the cores the brightest by far.
 * `land` 0..1 is the land above the sea now; `fp` the pixel's footprint on the unit sphere.
 */
export function nightLights(n: V3, v: F, land: F, L: LifeUniforms, fp: F): V3 {
  const stage = L.lights;
  // camp fires: a sparse warm speckle (~3 km cells) wherever there will be people, faint, early
  const pc = n.mul(2000);
  const cell = floor(pc);
  const hc = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113)));
  const inhabited = smoothstep(0.02, 0.12, v);
  const fineEnough = smoothstep(2 / 2000, 0.7 / 2000, fp);
  const camp = mix(inhabited.mul(0.04), step(hc, inhabited.mul(0.25)), fineEnough).mul(smoothstep(0, 1, stage)).mul(float(1).sub(smoothstep(1.5, 2.5, stage)));
  // settlements grow from the core out: a pixel lights when the stage passes its level (bright = early);
  // the regions wake at different times
  const wake = mx_noise_float(n.mul(22).add(3.1)).mul(0.1);
  const level = float(1.05).sub(stage.sub(1).div(2).clamp(0, 1).mul(1.15)).sub(L.overshoot.mul(0.25)).add(wake);
  // (nothing before the villages' stage: at stage 0 the brightest cores would pass the level)
  const on = smoothstep(level.sub(0.12), level.add(0.02), v).mul(smoothstep(1, 1.3, stage));
  // within a ~1 km pixel: the streets' own grain, where it can show
  const grain = mx_noise_float(n.mul(16000)).mul(0.7).mul(float(1).sub(smoothstep(0.25, 0.5, fp.mul(16000)))).add(1);
  const radiance = v.mul(v).mul(on).mul(grain).mul(L.overshoot.mul(0.9).add(1));
  const sodium = vec3(1, 0.52, 0.18);
  const core = vec3(1, 0.83, 0.62);
  const led = vec3(0.86, 0.92, 1);
  const tint = mix(mix(sodium, core, smoothstep(0.55, 0.9, v)), led, L.overshoot.mul(0.55));
  const fire = vec3(1, 0.42, 0.12).mul(camp).mul(0.25);
  return tint.mul(radiance).mul(6).add(fire).mul(land);
}
