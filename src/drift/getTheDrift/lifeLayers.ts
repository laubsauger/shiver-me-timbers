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
import { abs, float, floor, fract, hash, max, mix, mx_noise_float, smoothstep, vec3 } from 'three/tsl';

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
 * Night lights (emission, linear) at surface normal n. Zero by day: earth.ts multiplies by its own night
 * factor. Settlements sit on a jittered grid of cells on the sphere; a cell is inhabited where it is low,
 * near the coast and temperate; stage by stage more of them light, brighter and wider.
 */
export function nightLights(n: V3, e: F, sea: F, L: LifeUniforms): V3 {
  const height = e.sub(sea);
  const habitable = smoothstep(0, 0.02, height).mul(smoothstep(0.22, 0.02, height)).mul(smoothstep(0.75, 0.45, abs(n.dot(L.axis))));
  // cells ~ 60 km across; a settlement at each cell's jittered centre
  const p = n.mul(110);
  const cell = floor(p);
  const f = fract(p);
  const h = hash(cell.x.add(cell.y.mul(157)).add(cell.z.mul(113)));
  const at = vec3(hash(h.add(0.1)), hash(h.add(0.2)), hash(h.add(0.3))).mul(0.6).add(0.2);
  const d = f.sub(at).length();
  const stage = L.lights;
  // which cells are lit at this stage (the same cells keep their light as it grows)
  const lit = smoothstep(h.add(0.05), h, stage.mul(0.33).mul(habitable.mul(1.4)));
  // camps are sparks; villages are small glows; cities spread and run along the coast
  const size = mix(float(0.04), float(0.22), smoothstep(1, 3, stage)).add(L.overshoot.mul(0.18));
  const point = smoothstep(size, size.mul(0.3), d);
  // the networks: a faint web between lit cells in the city stage
  const web = mx_noise_float(n.mul(70)).mul(0.5).add(0.5);
  const roads = smoothstep(0.03, 0, abs(web.sub(0.5))).mul(smoothstep(2, 3, stage)).mul(habitable).mul(0.25);
  const warm = mix(vec3(1, 0.6, 0.25), vec3(1, 0.85, 0.6), smoothstep(1, 3, stage));
  const harsh = mix(warm, vec3(0.95, 0.95, 1), L.overshoot.mul(0.6));
  const glow = point.mul(lit).add(roads).mul(max(stage.sub(0.2), 0)).mul(L.overshoot.mul(1.5).add(1));
  // drowned: under the risen sea the lights are out
  return harsh.mul(glow).mul(0.6).mul(smoothstep(-0.002, 0.004, height));
}
