/**
 * The islands' ground for the film (Act 3's beach; the user, 2026-10-27: the game's terrain is "flat coloured
 * stuff, no structure"): scanned CC0 PBR layers (scripts/drift-pbr-fetch.py, packed by drift-pbr-pack.py) in
 * the game's own terrain blend, through its ground hook (terrain/sandMaterial.ts TerrainBlendHooks) — so the
 * waterline, the swash, the water lighting over the shallows and the aerial haze all stay the game's:
 *
 *   sand_dry      ambientCG Ground027   pale fine beach sand
 *   sand_wet      ambientCG Ground061   wet, smooth sand at the waterline
 *   rock          Poly Haven rock_boulder_dry   where the ground is too steep to hold sand or cover
 *   grass         Poly Haven sparse_grass       the cover above the beach
 *   forest_floor  Poly Haven forest_floor       mixed into the cover, its autumn leaves dulled (temperate)
 *
 * Each layer is two RGBA maps (albedo + roughness; normal xy + ambient occlusion + height), sampled flat on
 * the ground (xz) at two scales and two turns blended by a slow noise, so the tile never repeats visibly; the
 * rock triplanar. The shading normal is the maps' (reoriented about the ground's), in view space as the hook
 * wants it.
 */
import * as THREE from 'three/webgpu';
import { abs, cameraViewMatrix, float, mix, normalWorldGeometry, positionWorld, sin, smoothstep, texture, vec2, vec3, vec4 } from 'three/tsl';
import type { TerrainBlendHooks } from '../../terrain/sandMaterial';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** m: each layer's tile (its scan's real size where known), w × h */
const LAYERS = {
  sand_dry: [2.2, 2.2],
  sand_wet: [3.2, 1.6],
  rock: [1.8, 1.8],
  grass: [2, 2],
  forest_floor: [2.14, 2.14],
} as const;
type Layer = keyof typeof LAYERS;

export interface BeachTerrain {
  hooks: TerrainBlendHooks;
  ready: Promise<void>;
}

export function createBeachTerrain(base = `${import.meta.env.BASE_URL}drift/pbr/packed/`): BeachTerrain {
  const loader = new THREE.TextureLoader();
  const loads: Promise<unknown>[] = [];
  const tex = (name: string): THREE.Texture => {
    let t!: THREE.Texture;
    loads.push(new Promise((ok, fail) => (t = loader.load(`${base}${name}.png`, ok, undefined, () => fail(new Error(`beach: ${name} (run scripts/drift-pbr-pack.py)`))))));
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.anisotropy = 16;
    // raw: the albedo's rgb is sRGB with linear roughness in a (decoded by hand below), the other map is data
    t.colorSpace = THREE.NoColorSpace;
    return t;
  };
  const maps = Object.fromEntries((Object.keys(LAYERS) as Layer[]).map((l) => [l, { a: tex(`${l}_albedo_rough`), b: tex(`${l}_normal_ao_h`) }])) as Record<
    Layer,
    { a: THREE.Texture; b: THREE.Texture }
  >;

  /** sRGB → linear (the albedo's rgb) */
  const linear = (c: V3): V3 => c.pow(2.2) as V3;
  const rot = (uv: V2, a: number): V2 => vec2(uv.x.mul(Math.cos(a)).sub(uv.y.mul(Math.sin(a))), uv.x.mul(Math.sin(a)).add(uv.y.mul(Math.cos(a)))) as V2;

  /** one layer flat on the ground: albedo (linear), roughness, tangent normal (xy), AO — anti-tiled */
  const flat = (layer: Layer, w: F) => {
    const [tw, th] = LAYERS[layer];
    const p = positionWorld.xz;
    const uv1 = vec2(p.x.div(tw), p.y.negate().div(th)) as V2;
    const uv2 = rot(vec2(p.x.div(tw * 2.7), p.y.negate().div(th * 2.7)) as V2, 0.9);
    const A1 = texture(maps[layer].a, uv1) as V4;
    const A2 = texture(maps[layer].a, uv2) as V4;
    const B1 = texture(maps[layer].b, uv1) as V4;
    const B2 = texture(maps[layer].b, uv2) as V4;
    // the second sample's normal turned back by its uv's turn
    const n2 = rot(B2.xy.mul(2).sub(1) as V2, -0.9);
    const a = mix(A1, A2, w) as V4;
    const n = mix(B1.xy.mul(2).sub(1) as V2, n2, w) as V2;
    return { albedo: linear(a.rgb as V3), rough: a.a as F, n, ao: mix(B1.z, B2.z, w) as F, h: mix(B1.w, B2.w, w) as F };
  };

  /** value noise of positionWorld.xz / scale, 0..1 (anti-tiling and patchiness) */
  const noise = (scale: number): F => {
    const q = positionWorld.xz.div(scale);
    const i = q.floor();
    const f = q.fract();
    const u = f.mul(f).mul(f.mul(-2).add(3));
    const hash = (o: V2): F => sin(i.add(o).dot(vec2(127.1, 311.7))).mul(43758.5453).fract() as F;
    const a = hash(vec2(0, 0) as V2);
    const b = hash(vec2(1, 0) as V2);
    const c = hash(vec2(0, 1) as V2);
    const d = hash(vec2(1, 1) as V2);
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y) as F;
  };

  const hooks: TerrainBlendHooks = {
    ground(ctx) {
      const N = normalWorldGeometry;
      const mixW = smoothstep(0.25, 0.75, noise(7)) as F;
      const dry = flat('sand_dry', mixW);
      const wet = flat('sand_wet', mixW);
      const grass = flat('grass', mixW);
      const leaves = flat('forest_floor', mixW);


      // sand: dry above the wet band, wet in it, foam where the swash is
      const sandA = mix(dry.albedo, wet.albedo, ctx.sand.wet) as V3;
      // (the swash's foam: the line on its moving edge and the lace stranded behind it; none without run-up)
      const foam = ctx.sand.swash ? (ctx.sand.swash.foam as F) : float(0);
      const foamed = mix(sandA, vec3(0.86, 0.88, 0.86), foam.mul(0.8).clamp(0, 1)) as V3;
      const sandR = mix(dry.rough, wet.rough.mul(0.45), ctx.sand.wet) as F;
      const sandN = mix(dry.n, wet.n, ctx.sand.wet) as V2;
      const sandAO = mix(dry.ao, wet.ao, ctx.sand.wet) as F;
      // the cover: dry grass with patches of leaf-litter soil, the litter's autumn colours dulled toward the soil
      const patch = smoothstep(0.35, 0.7, noise(11)) as F;
      const litter = mix(vec3(leaves.albedo.dot(vec3(0.2126, 0.7152, 0.0722))).mul(vec3(1.05, 0.98, 0.88)), leaves.albedo, 0.25) as V3;
      const coverA = mix(grass.albedo.mul(2.2), litter, patch) as V3;
      const coverR = mix(grass.rough, leaves.rough, patch) as F;
      const coverN = mix(grass.n, leaves.n, patch) as V2;
      const coverAO = mix(grass.ao, leaves.ao, patch) as F;

      const groundA = mix(coverA, foamed, ctx.shoreW) as V3;
      const groundR = mix(coverR, sandR, ctx.shoreW) as F;
      const groundN2 = mix(coverN, sandN, ctx.shoreW) as V2;
      const groundAO = mix(coverAO, sandAO, ctx.shoreW) as F;
      // the flat layers' tangent normal about the geometric one (u along +x, v along −z)
      const T = vec3(1, 0, 0).sub(N.mul(N.x)).normalize();
      const Bv = N.cross(T);
      const groundN = T.mul(groundN2.x).add(Bv.mul(groundN2.y)).add(N.mul(float(1).sub(groundN2.dot(groundN2)).max(0).sqrt())).normalize() as V3;

      // the rock, triplanar (steep ground): the planes' tangent normals onto the world, whiteout-blended about
      // the geometric normal
      const [tw] = LAYERS.rock;
      const p = positionWorld.div(tw);
      const bw = abs(N).pow(4);
      const wsum = bw.x.add(bw.y).add(bw.z);
      const wx = bw.x.div(wsum);
      const wy = bw.y.div(wsum);
      const wz = bw.z.div(wsum);
      const ax = texture(maps.rock.a, p.zy) as V4;
      const ay = texture(maps.rock.a, p.xz) as V4;
      const az = texture(maps.rock.a, p.xy) as V4;
      const bx = texture(maps.rock.b, p.zy) as V4;
      const by = texture(maps.rock.b, p.xz) as V4;
      const bz = texture(maps.rock.b, p.xy) as V4;
      const rockA4 = ax.mul(wx).add(ay.mul(wy)).add(az.mul(wz)) as V4;
      const tx = bx.xy.mul(2).sub(1);
      const ty = by.xy.mul(2).sub(1);
      const tz = bz.xy.mul(2).sub(1);
      const rockN = vec3(0, tx.y, tx.x).mul(wx).add(vec3(ty.x, 0, ty.y).mul(wy)).add(vec3(tz.x, tz.y, 0).mul(wz)).add(N).normalize() as V3;
      const rockAO = bx.z.mul(wx).add(by.z.mul(wy)).add(bz.z.mul(wz)) as F;

      const albedo = mix(linear(rockA4.rgb as V3).mul(rockAO), groundA.mul(groundAO), ctx.groundW);
      const roughness = mix(rockA4.a, groundR, ctx.groundW);
      const nWorld = mix(rockN, groundN, ctx.groundW).normalize();
      const normal = cameraViewMatrix.mul(vec4(nWorld, 0)).xyz.normalize();
      // (no painted glitter on scanned sand)
      return { albedo, roughness, normal, emissiveGate: float(0) };
    },
  };
  return { hooks, ready: Promise.all(loads).then(() => undefined) };
}
