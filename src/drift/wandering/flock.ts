/**
 * Act 3's sandpipers (drift-narrative/wandering-on/direction.md, W4): the flock that takes off as one
 * vortex, with no leader — baked by scripts/drift-flock-bake.py to keyframes (10 000 birds, 15 keys/s), read
 * here as a float texture (per key, rows of texels, one per bird: xyz, w = 1 while flying) and interpolated
 * with Catmull–Rom, so every frame is a pure function of the flock's own time.
 *
 * A bird is a small dark silhouette (body and swept wings) stretched along its flight, a pixel at least (what it gains in size it gives
 * back in strength). Against the low sun a sandpiper is a dark back and a white belly: as the flock BANKS
 * through a turn the birds show the sun their bellies, so its brightness comes from its bank — the bend of
 * its path (from the keys) toward the sun — and waves of light run through the flock as it turns, the look
 * of every murmuration. Wingbeats (~10 Hz) would alias at 30 fps; the bank carries the life instead.
 */
import * as THREE from 'three/webgpu';
import { Fn, attribute, clamp, float, instanceIndex, int, ivec2, length, max, min, mix, normalize, sin, smoothstep, step, textureLoad, uv, vec2, vec3, vec4 } from 'three/tsl';
import { billboardMesh } from '../undertime/billboard';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** how much further a bird rolls than its turn alone needs (see the bank) */
const ROLL_GAIN = 2.6;

export interface FlockData {
  texture: THREE.DataTexture;
  birds: number;
  keys: number;
  hz: number;
  /** texels per row, and rows per key (a flock wider than a texture may be is laid out over several) */
  width: number;
  rows: number;
  ready: Promise<void>;
}

export function loadFlock(base = `${import.meta.env.BASE_URL}drift/flock/`): FlockData {
  const texture = new THREE.DataTexture(new Uint16Array(4), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  const data: FlockData = { texture, birds: 1, keys: 1, hz: 15, width: 1, rows: 1, ready: Promise.resolve() };
  data.ready = fetch(base + 'flock-keys.json')
    .then((r) => {
      if (!r.ok) throw new Error(`flock: ${r.status} (run scripts/drift-flock-bake.py)`);
      return r.json();
    })
    .then((j: { birds: number; keys: number; hz: number; width?: number; rows?: number }) => {
      data.birds = j.birds;
      data.keys = j.keys;
      data.width = j.width ?? j.birds;
      data.rows = j.rows ?? 1;
      data.hz = j.hz;
      return fetch(base + 'flock-keys.f16');
    })
    .then((r) => r.arrayBuffer())
    .then((b) => {
      texture.image = { data: new Uint16Array(b), width: data.width, height: data.keys * data.rows };
      texture.needsUpdate = true;
    });
  return data;
}

export interface FlockUniforms {
  /** s of the flock's own clock (0 = the startle) */
  time: F;
  /** world position of the bake's origin (the audience's feet), the turn from the bake's axes (−z ahead) to
   * the world's, and unit toward the sun */
  origin: V3;
  basis: THREE.Node<'mat3'>;
  sun: V3;
  eye: V3;
  pixelAngle: F;
  /** 0..1 */
  presence: F;
  /** the light on a bird: the sunlight's radiance on a white surface facing it, and the sky's (linear) */
  sunLight: V3;
  skyLight: V3;
}

/** Catmull–Rom through four keys */
const catmull = (p0: V3, p1: V3, p2: V3, p3: V3, u: F): V3 => {
  const u2 = u.mul(u);
  const u3 = u2.mul(u);
  return p1.mul(2).add(p2.sub(p0).mul(u)).add(p0.mul(2).sub(p1.mul(5)).add(p2.mul(4)).sub(p3).mul(u2)).add(p1.mul(3).sub(p0).sub(p2.mul(3)).add(p3).mul(u3)).mul(0.5) as V3;
};

export function createFlock(data: FlockData, U: FlockUniforms): THREE.InstancedMesh {
  const bird = float(instanceIndex);
  const k = U.time.mul(data.hz).clamp(0, data.keys - 1.001);
  const k1 = k.floor();
  const u = k.sub(k1);
  // (texel: column bird mod width, row key·rows + bird ÷ width)
  const col = int(instanceIndex).mod(data.width);
  const row = int(instanceIndex).div(data.width);
  const at = (dk: number) =>
    textureLoad(data.texture, ivec2(col, int(clamp(k1.add(dk), 0, data.keys - 1)).mul(data.rows).add(row))) as unknown as THREE.Node<'vec4'>;
  const a0 = at(-1);
  const a1 = at(0);
  const a2 = at(1);
  const a3 = at(2);
  const p = U.basis.mul(catmull(a0.xyz, a1.xyz, a2.xyz, a3.xyz, u));
  // velocity and acceleration from the keys (per s)
  const vel = U.basis.mul(a2.xyz.sub(a1.xyz).mul(data.hz));
  const acc = U.basis.mul(a3.xyz.sub(a2.xyz).sub(a1.xyz.sub(a0.xyz)).mul(data.hz * data.hz * 0.5));
  const flying = mix(a1.w, a2.w, u);
  const pos = U.origin.add(p);
  const toEye = U.eye.sub(pos);
  const dist = length(toEye);
  const view = normalize(toEye);
  // the bank: a bird rolls into its turn; its belly faces away from the turn's centre. The belly's normal
  // tilts from straight down toward the outside of the turn by the bank angle (tan = lateral g / 9.8)
  const fwd = normalize(vel.add(vec3(1e-4, 0, 0)));
  const lateral = acc.sub(fwd.mul(acc.dot(fwd)));
  // (rolled ROLL_GAIN× the centripetal estimate: a bird in a murmuration rolls far more than its turn needs — it
  // banks to turn AND to spill and steer — 40–70° in the turns of the reference footage, where the estimate gave
  // 10–25° and the belly flash hardly showed, the 2026-10-29 review: "seeing if we see the white belly effect at all")
  const bank = normalize(vec3(0, -9.8, 0).sub(lateral.mul(ROLL_GAIN)));
  // which side the eye sees: the white belly, or the dark back once the bird has rolled past the line of sight
  // (sandpipers "flash between black and white", the client's Ocean Shores reference); edge-on, the wings thin to
  // a line and the bird nearly vanishes — a turn running through the body blinks it out and back
  const facing = bank.dot(view);
  const seesBelly = smoothstep(-0.12, 0.12, facing);
  const thin = mix(float(0.3), float(1), smoothstep(0.05, 0.6, facing.abs()));
  const sunOnBelly = smoothstep(-0.1, 0.5, bank.dot(U.sun));
  const sunOnBack = smoothstep(-0.1, 0.5, bank.dot(U.sun).negate());
  // sandpipers are ~20 cm long, 40 cm across the wings; at least a pixel and a half, paid back as strength
  const wanted = float(0.3);
  const drawn = max(wanted, U.pixelAngle.mul(1.5).mul(dist));
  const coverage = wanted.div(drawn).pow(2);
  // the quad: along the flight (projected on the view) and across it
  const along = normalize(fwd.sub(view.mul(fwd.dot(view))).add(vec3(0, 1e-4, 0)));
  const across = normalize(along.cross(view));
  const corner = attribute<'vec3'>('position', 'vec3');
  const size = drawn.mul(step(0.5, flying.add(0.6)));
  // the wingbeat, each bird on its own phase (~3 Hz as drawn: a sandpiper's ~10 Hz would alias at 30 fps): the
  // span opens and closes, so the flock shimmers as live birds do instead of drifting as specks
  const beat = sin(U.time.mul(18.8).add(bird.mul(2.399))).mul(0.5).add(0.5);
  const span = mix(float(0.45), float(1), beat);
  const quad = pos.add(along.mul(corner.y.mul(size).mul(0.55).mul(thin))).add(across.mul(corner.x.mul(size).mul(1.7).mul(span)));
  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  // a dark silhouette over the sky, a bright belly when banked to the sun: drawn as an over-blend
  material.blending = THREE.NormalBlending;
  material.positionNode = quad;
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    // a bird seen from below: a slim body with its tail, and two wings tapering to swept-back tips (the
    // flock now wheels overhead, ~15 m up, where a wedge read as a blotch)
    const ax = q.x.abs();
    const wingY = float(0.22).sub(ax.pow(1.6).mul(0.55));
    const th = float(0.3).mul(float(1).sub(ax).max(0).pow(0.6)).add(0.02);
    const wingD = q.y.sub(wingY).abs().sub(th);
    const bodyD = length(vec2(q.x.div(0.13), q.y.div(0.85))).sub(1).mul(0.13);
    const wing = float(1).sub(smoothstep(-0.05, 0.05, min(wingD, bodyD)));
    // albedos, lit by the scene's own light: a dark back in the sky's light, a white belly in the Sun's when it
    // is turned to it (a Sun below the horizon lights nothing)
    // (the low Sun's colour half taken back to its brightness: at a pixel or two a warm-lit belly read as an
    // orange speck, "confetti" — the v8 notes)
    const sunGrey = mix(U.sunLight, vec3(U.sunLight.dot(vec3(0.2126, 0.7152, 0.0722))), 0.5);
    const back = vec3(0.07, 0.065, 0.06).mul(U.skyLight.add(sunGrey.mul(sunOnBack.mul(0.3).add(0.2))));
    // (a belly faces down: the sky's light reaches it only off the sea and the sand, ~a fifth; lit by the full
    // sky it matched the sky and the whole flock was gone, the first sixth-bake look)
    // (and the Sun's full light on a belly turned to it: at half of it, a banked belly toward the low Sun came out
    // no brighter than the sky behind it — the flash is the one thing in a murmuration brighter than the sky)
    const belly = vec3(0.8, 0.78, 0.74).mul(U.skyLight.mul(0.2).add(sunGrey.mul(sunOnBelly)));
    const c = mix(back, belly, seesBelly);
    const a = wing.mul(min(coverage.mul(1.4), 1)).mul(thin.sqrt()).mul(U.presence).mul(smoothstep(0.02, 0.4, flying.add(0.3)));
    return vec4(c, a);
  })();
  material.name = 'drift-flock';
  return billboardMesh(material, data.birds, 'drift-flock');
}
