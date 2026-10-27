/**
 * C3's spray: the water a dolphin throws as it leaves the sea and comes down into it, and the blow at each roll
 * (the v9 review: "what is missing is some splashes … when he exits and enters").
 *
 * Every droplet is a pure function of the time since its splash (dolphin.ts `dolphinSplashes`): flung from a
 * ring round where the body crossed the surface, up and out, carried a little along with the body, slowed by the
 * air and pulled down by gravity, gone when it is back in the sea. No state, so any frame renders on its own.
 * Drawn as eye-facing quads (billboard.ts), a pixel at least, paid back in strength as the flock's birds are.
 * Lit as water drops: the sky's light and the Sun's, and much brighter toward the Sun, where a drop scatters
 * forward (at last light the spray between the eye and the afterglow is the brightest thing on the sea).
 *
 * The ocean's own foam (flowfoam wakes, the foam sim's whitecaps, the white contact froth) is state carried
 * from frame to frame and is not wired into the film's sea; see docs/drift/engine-findings.md §15.
 */
import * as THREE from 'three/webgpu';
import { Fn, cameraPosition, exp, float, floor, instanceIndex, int, ivec2, max, min, mix, normalize, smoothstep, textureLoad, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { billboardMesh, eyeFacing } from '../undertime/billboard';
import { hash2 } from '../../terrain/noise';
import type { Splash } from './dolphin';

type F = THREE.Node<'float'>;
type V3 = THREE.Node<'vec3'>;

/** droplets per splash */
const PER = 900;
/** m/s²; 1/s, the air's drag on a drop's horizontal speed */
const G = 9.81;
const DRAG = 0.9;

export interface SplashUniforms {
  /** s on the splashes' clock (into c3) */
  time: F;
  /** the eye's level frame: its position (the sea's 0) and its yaw */
  eye: THREE.Node<'vec3'>;
  yaw: F;
  sun: V3;
  sunLight: V3;
  skyLight: V3;
  pixelAngle: F;
}

export function createSplashes(splashes: Splash[]): { mesh: THREE.InstancedMesh; uniforms: SplashUniforms } {
  // one texel row per splash: (x, z, t0, energy) and (vx, vz, blow, 0), eye frame
  const n = splashes.length;
  const data = new Float32Array(n * 2 * 4);
  splashes.forEach((s, i) => {
    data.set([s.x, s.z, s.at, s.energy], i * 4);
    data.set([s.vx, s.vz, s.blow ? 1 : 0, 0], (n + i) * 4);
  });
  const table = new THREE.DataTexture(data, n, 2, THREE.RGBAFormat, THREE.FloatType);
  table.minFilter = table.magFilter = THREE.NearestFilter;
  table.needsUpdate = true;

  const U = {
    time: uniform(-100),
    eye: uniform(new THREE.Vector3()),
    yaw: uniform(0),
    sun: uniform(new THREE.Vector3(0, 1, 0)),
    sunLight: uniform(new THREE.Vector3()),
    skyLight: uniform(new THREE.Vector3()),
    pixelAngle: uniform(0.0015),
  };
  const id = float(instanceIndex);
  const e = floor(id.div(PER));
  const j = id.sub(e.mul(PER));
  const a = textureLoad(table, ivec2(int(e), int(0))) as unknown as THREE.Node<'vec4'>;
  const b = textureLoad(table, ivec2(int(e), int(1))) as unknown as THREE.Node<'vec4'>;
  const h = (k: number): F => hash2(vec2(j.add(k * 17.31), e.mul(7.13).add(k))) as F;
  const blow = b.z;
  const energy = a.w;
  // where it leaves the water: a ring round the crossing (the body's girth), the blow straight up from it
  const ang = h(1).mul(Math.PI * 2);
  const r0 = mix(float(0.45), float(0.05), blow).mul(h(2).sqrt());
  const dir = vec2(ang.cos(), ang.sin());
  const p0 = vec3(a.x.add(dir.x.mul(r0)), mix(float(0.05), float(0.25), blow), a.y.add(dir.y.mul(r0)));
  // up and out: a dolphin coming down at ~6 m/s throws water 1–2 m high; the blow is a short puff of mist
  const up = mix(float(1.2).add(h(3).pow(2).mul(4.8)), float(1.8).add(h(3).mul(2.4)), blow).mul(mix(energy, float(1), blow));
  const out = mix(float(0.3).add(h(4).mul(2.4)).mul(energy), h(4).mul(0.35), blow);
  const carry = mix(float(0.35), float(0), blow);
  const vh = dir.mul(out).add(b.xy.mul(carry));
  const tau = U.time.sub(a.z).sub(h(5).mul(0.12));
  // drag on the horizontal (the drops are small), ballistic in height (the blow's mist hangs: less pull)
  const drift = float(1).sub(exp(tau.max(0).mul(-DRAG))).div(DRAG);
  const g = mix(float(G), float(2.2), blow);
  const y = p0.y.add(up.mul(tau)).sub(g.mul(tau).mul(tau).mul(0.5));
  const local = vec3(p0.x.add(vh.x.mul(drift)), y, p0.z.add(vh.y.mul(drift)));
  // the eye's level frame (x right, z ahead) into the world: turned by the yaw about y, ahead is −z
  const c = U.yaw.cos();
  const s = U.yaw.sin();
  const lx = local.x;
  const lz = local.z.negate();
  const pos = vec3(U.eye.x.add(lx.mul(c)).add(lz.mul(s)), y, U.eye.z.sub(lx.mul(s)).add(lz.mul(c)));
  // alive from its throw until it is back in the sea (and the blow's mist thins out)
  const life = mix(float(2.4), float(1.6), blow);
  const alive = tau.greaterThan(0).and(y.greaterThan(-0.02)).and(tau.lessThan(life));
  const dist = cameraPosition.sub(pos).length();
  // 1–6 cm drops, a few clumps of a hand's breadth; the blow's mist in larger, fainter puffs
  const wanted = mix(mix(float(0.02), float(0.06), h(6)).mul(mix(float(1), float(2.5), smoothstep(0.86, 0.95, h(7)))), float(0.14), blow);
  const drawn = max(wanted, U.pixelAngle.mul(1.3).mul(dist));
  const coverage = wanted.div(drawn).pow(2);
  const size = drawn.mul(alive.select(float(1), float(0)));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.NormalBlending;
  material.positionNode = eyeFacing(pos, size);
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const disc = float(1).sub(smoothstep(0.2, 1, q.length()));
    // a drop takes light from the sky all round it and the Sun's, forward-scattered: toward the Sun it glows
    // (with the sky's alone the spray read lavender-grey at last light, flat discs on the sea)
    const toward = normalize(pos.sub(cameraPosition)).dot(U.sun).max(0);
    const glow = float(1.5).add(toward.pow(4).mul(6));
    const col = vec3(0.92, 0.92, 0.92).mul(U.skyLight.mul(1.2).add(U.sunLight.mul(glow)));
    const fade = float(1).sub(smoothstep(life.mul(0.55), life, tau));
    const alpha = disc.mul(min(coverage.mul(3), 1)).mul(fade).mul(mix(float(0.95), float(0.35), blow));
    return vec4(col, alpha);
  })();
  material.name = 'drift-splash';
  const mesh = billboardMesh(material, n * PER, 'drift-splash');
  // after the water: both are transparent, and sorted by the object's place (the world's origin, kilometres off)
  // the spray went first and the sea, which writes depth, was drawn over it
  mesh.renderOrder = 1;
  return { mesh, uniforms: U as unknown as SplashUniforms };
}
