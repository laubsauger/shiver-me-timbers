/**
 * The planet's life as shader layers over the Earth's surface (life.ts gives the states; earth.ts calls
 * these with its own elevation field). Each layer arrives as a TIME WAVE: a soft front travelling over the
 * sphere from a point on the front limb toward the audience, its edge broken by noise, so a layer is never
 * switched on — it rolls in.
 *
 *   fields    low and middle ground takes a first tint of life (ochre → olive), wettest first
 *   forests   a second front brings dark green up the lowlands near water
 *   ice       polar caps about the planet's axis: big on the young world, settling, shrinking in the overshoot
 *   lights    on the night side only: population where it is low, near water and temperate — sparks (camps),
 *             then clusters (villages), then networks (cities) at the same places, so they grow in place;
 *             in the overshoot they brighten, whiten and run together; under a risen sea they go dark
 *   sea       the sea level the surface floods to (elevation units of earth.ts's height field)
 */
import * as THREE from 'three/webgpu';
import { abs, exp, float, floor, fract, hash, max, mix, mx_noise_float, pow, smoothstep, step, vec3 } from 'three/tsl';

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
  /** unit, the planet's spin axis (for the ice caps) */
  axis: V3;
}

/** 0..1: has the front of a wave at progress k (0..1 over the half-sphere) reached unit surface normal n? */
function waveFront(n: V3, k: F, L: LifeUniforms, seed: number): F {
  const reach = float(1).sub(n.dot(L.waveOrigin)).mul(0.5); // 0 at the origin, 1 at its antipode
  const ragged = mx_noise_float(n.mul(5).add(seed)).mul(0.08);
  return smoothstep(reach.add(ragged).sub(0.04), reach.add(ragged).add(0.04), k.mul(1.15));
}

/** how high the sea has risen, in the elevation field's units, added to its base sea level */
export const seaRise = (L: LifeUniforms): F => L.sea.mul(0.09);

/**
 * The surface albedo with life on it. `e` is elevation (sea level `sea`), `wet` 0..1 how near water / how
 * moist (earth.ts can pass its own; a noise is fine).
 */
export function lifeAlbedo(n: V3, e: F, sea: F, wet: F, base: V3, L: LifeUniforms): V3 {
  const land = smoothstep(sea, sea.add(0.01), e);
  const height = e.sub(sea);
  const fieldsHere = waveFront(n, L.fields, L, 1.3).mul(smoothstep(0.55, 0.1, height)).mul(wet.mul(0.6).add(0.4));
  const forestsHere = waveFront(n, L.forests, L, 4.7).mul(smoothstep(0.35, 0.05, height)).mul(smoothstep(0.35, 0.75, wet));
  const field = mix(vec3(0.33, 0.29, 0.14), vec3(0.2, 0.27, 0.1), wet);
  const forest = vec3(0.04, 0.11, 0.05);
  let a = mix(base, field, fieldsHere.mul(land).mul(0.85));
  a = mix(a, forest, forestsHere.mul(land).mul(0.9));
  // ice caps about the axis: the cap's edge is a latitude, broken by noise
  const lat = abs(n.dot(L.axis));
  const edge = float(1).sub(L.ice.mul(0.32)).add(mx_noise_float(n.mul(6).add(8.8)).mul(0.04));
  const ice = smoothstep(edge, edge.add(0.03), lat);
  return mix(a, vec3(0.82, 0.86, 0.9), ice);
}

/**
 * Night lights (emission, linear), after the satellite and ISS imagery of Earth at night: cities are CLUSTERS
 * of many fine sodium-amber points, densest and whitest at their cores and thinning outward; their sizes
 * follow a steep power law (a few big cities, many towns); a faint rural speckle between them; thin threads
 * of road joining them. Zero by day (earth.ts multiplies by its night factor).
 *
 * Two scales of cells on the sphere: CITY cells (~45 km) each may host a city of its own size, and FINE
 * cells (~2.5 km) that light when they fall inside a city's extent (with a probability falling off from its
 * core) or, rarely, as a rural light. Where a fine cell is smaller than ~2 pixels (`fp`, the pixel footprint
 * on the unit sphere) the points are replaced by their average — no shimmer, no grit.
 *
 * Stages (L.lights): camps 0–1 are the rural speckle alone; villages 1–2 light the small cities' cores; cities
 * 2–3 grow every cluster to its full extent; the overshoot merges and whitens them. Drowned under the sea.
 */
export function nightLights(n: V3, e: F, sea: F, L: LifeUniforms, fp: F = float(0)): V3 {
  const height = e.sub(sea);
  const lowland = smoothstep(0, 0.008, height).mul(smoothstep(0.2, 0.03, height)).mul(smoothstep(0.85, 0.55, abs(n.dot(L.axis))));
  const region = smoothstep(0.5, 0.8, mx_noise_float(n.mul(6).add(3.7)).mul(0.5).add(0.5).add(smoothstep(0.05, 0, height).mul(0.25)));
  const stage = L.lights;
  // ---- cities: one may sit in each ~45 km cell, at a random point, its size from a steep power law
  const pc = n.mul(140);
  const cc = floor(pc);
  const hc = hash(cc.x.add(cc.y.mul(157)).add(cc.z.mul(113)));
  const centre = cc.add(vec3(hash(hc.add(0.1)), hash(hc.add(0.2)), hash(hc.add(0.3)))).div(140);
  const isCity = step(hash(hc.add(0.7)), region.mul(lowland).mul(0.55));
  const big = pow(hash(hc.add(0.9)), float(3)); // most small, a few big
  // a city's radius (unit sphere) grows with the stage: cores in the village stage, full in the city stage
  const grow = smoothstep(1, 2, stage).mul(0.35).add(smoothstep(2, 3, stage).mul(0.65)).add(L.overshoot.mul(0.6));
  const radius = big.mul(0.009).add(0.0015).mul(grow);
  const dc = n.sub(centre).length();
  const inCity = isCity.mul(exp(dc.div(radius.max(1e-5)).pow(2).negate()));
  // ---- fine lights: ~2.5 km cells, lit inside a city (denser to its core) or rarely in the countryside
  const pf = n.mul(2500);
  const cf = floor(pf);
  const hf = hash(cf.x.add(cf.y.mul(311)).add(cf.z.mul(197)));
  const at = vec3(hash(hf.add(0.1)), hash(hf.add(0.2)), hash(hf.add(0.3))).mul(0.8).add(0.1);
  const df = fract(pf).sub(at).length();
  const rural = lowland.mul(region.mul(0.7).add(0.3)).mul(0.035).mul(smoothstep(0.2, 1, stage));
  const chance = inCity.mul(0.85).add(rural);
  const on = step(hf, chance);
  const brightness = hash(hf.add(0.5)).pow(2).mul(1.5).add(0.25).mul(inCity.mul(2).add(0.6));
  const point = exp(df.div(0.18).pow(2).negate());
  // LOD: where a fine cell is under ~2 px, its average (its probability × brightness × a point's area)
  const fine = smoothstep(2 / 2500, 1 / 2500, fp);
  const glow = mix(chance.mul(brightness).mul(0.1), on.mul(point).mul(brightness), fine);
  // the cores' diffuse glow (too dense to resolve), whiter
  const core = inCity.pow(3).mul(big.mul(2).add(0.5)).mul(0.6);
  // road threads between towns: thin, faint, only once there are cities
  const web = mx_noise_float(n.mul(400)).mul(0.5).add(0.5);
  const roads = smoothstep(0.015, 0, abs(web.sub(0.5))).mul(lowland).mul(region).mul(smoothstep(2, 3, stage)).mul(0.06);
  const sodium = vec3(1, 0.55, 0.2);
  const white = mix(vec3(1, 0.85, 0.65), vec3(0.92, 0.95, 1), L.overshoot);
  const light = sodium.mul(glow.add(roads)).add(white.mul(core));
  // drowned: under the risen sea the lights are out
  return light.mul(max(stage, 0).min(1)).mul(L.overshoot.mul(0.8).add(1)).mul(smoothstep(-0.002, 0.004, height)).mul(0.6);
}
