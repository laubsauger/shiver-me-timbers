/**
 * C3's spray: the water a dolphin throws as it leaves the sea and comes down into it, and the blow at each roll
 * (the v9 review: "what is missing is some splashes … when he exits and enters"); the ring of foam that spreads on
 * the water where it broke it, and the drips that run off it in the air (the user, 2026-11-01: "slightly wet … the
 * water it breaks").
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
/** s over which a drip splash's drops are born (dolphin.ts sheds one every DRIP_EVERY s of a leap) */
const DRIP_EVERY = 0.22;

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
  // three texel rows per splash: (x, z, t0, energy), (vx, vz, kind, y0) and (vy, 0, 0, 0), eye frame
  const KIND = { spray: 0, blow: 1, ring: 2, drip: 3 } as const;
  const n = splashes.length;
  const data = new Float32Array(n * 3 * 4);
  splashes.forEach((s, i) => {
    data.set([s.x, s.z, s.at, s.energy], i * 4);
    data.set([s.vx, s.vz, KIND[s.kind], s.y], (n + i) * 4);
    data.set([s.vy, 0, 0, 0], (2 * n + i) * 4);
  });
  const table = new THREE.DataTexture(data, n, 3, THREE.RGBAFormat, THREE.FloatType);
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
  const vy = (textureLoad(table, ivec2(int(e), int(2))) as unknown as THREE.Node<'vec4'>).x;
  const h = (k: number): F => hash2(vec2(j.add(k * 17.31), e.mul(7.13).add(k))) as F;
  // (one of the kinds at a time: 1 for it, 0 else)
  const blow = float(1).sub(b.z.sub(1).abs()).max(0);
  const ring = float(1).sub(b.z.sub(2).abs()).max(0);
  const drip = float(1).sub(b.z.sub(3).abs()).max(0);
  const energy = a.w;
  // where it leaves the water: a ring round the crossing (the body's girth), the blow straight up from it; a ring's
  // foam a little further out, at the water
  const ang = h(1).mul(Math.PI * 2);
  const r0 = mix(mix(float(0.45), float(0.05), blow).mul(h(2).sqrt()), mix(float(0.35), float(0.7), h(2)), ring);
  const dir = vec2(ang.cos(), ang.sin());
  const p0 = vec3(a.x.add(dir.x.mul(r0)), mix(mix(float(0.05), float(0.25), blow), float(0.03), ring), a.y.add(dir.y.mul(r0)));
  // up and out: a dolphin coming down at ~6 m/s throws water 1–2 m high; the blow is a short puff of mist. A ring's
  // foam does not rise: it spreads on the water (~1.5 m/s at first, slowing)
  // (cut back, the user, 2026-11-01: "too much spray covering the guy" — up to 3.5 m/s from 6: under a metre high)
  const up = mix(float(0.9).add(h(3).pow(2).mul(2.6)), float(1.8).add(h(3).mul(2.4)), blow).mul(mix(energy, float(1), blow)).mul(float(1).sub(ring));
  const out = mix(mix(float(0.3).add(h(4).mul(2.4)).mul(energy), h(4).mul(0.35), blow), float(0.5).add(h(4).mul(1.4)).mul(energy.add(0.3)), ring);
  const carry = mix(mix(float(0.35), float(0), blow), float(0.15), ring);
  const vh = dir.mul(out).add(b.xy.mul(carry));
  const tauS = U.time.sub(a.z).sub(h(5).mul(0.12));
  // drag on the horizontal (the drops are small; the foam on the water drags harder), ballistic in height (the
  // blow's mist hangs: less pull; the foam stays on the water)
  const dragK = mix(float(DRAG), float(1.4), ring);
  const drift = float(1).sub(exp(tauS.max(0).mul(dragK.negate()))).div(dragK);
  const g = mix(float(G), float(2.2), blow).mul(float(1).sub(ring));
  const yS = p0.y.add(up.mul(tauS)).sub(g.mul(tauS).mul(tauS).mul(0.5));
  const localS = vec3(p0.x.add(vh.x.mul(drift)), yS, p0.z.add(vh.y.mul(drift)));
  // A DRIP leaves the body where the body is at ITS OWN moment: born any time over the DRIP_EVERY s after its splash's,
  // on the body's centre then (the body's ballistic path from the splash: x + v·dt, y0 + vy·dt − g·dt²/2), anywhere along
  // the body's 2.6 m — along its path, inclined with it — and round its girth; it leaves with the body's velocity then,
  // a little slower, and falls on its own arc. (Spread along a LEVEL line at the splash's height and all born at once,
  // the drips of each splash fell as one horizontal line of spray across the body in every leap — the user, 2026-11-01:
  // "a weird horizontal line of particle spray mid-air during all jumps")
  const bt = h(5).mul(DRIP_EVERY);
  const tauD = U.time.sub(a.z).sub(bt);
  const vBody = vec3(b.x, vy.sub(bt.mul(G)), b.y);
  const axis = vBody.add(vec3(0, 1e-4, 0)).normalize();
  // (water runs off down and back: off the tail stock and the flukes, from its underside, just outside its skin — spread over the whole body and inside its girth they sat on it as white specks, a spotted
  // dolphin, in the leap stills of 2026-11-01)
  const jitter = vec3(h(10).sub(0.5), h(11).sub(0.5).abs().negate().sub(0.15), h(12).sub(0.5)).normalize();
  const born = vec3(a.x.add(b.x.mul(bt)), b.w.add(vy.mul(bt)).sub(bt.mul(bt).mul(G / 2)), a.y.add(b.y.mul(bt)))
    .add(axis.mul(h(8).mul(-0.4).sub(0.95)))
    .add(jitter.mul(mix(float(0.3), float(0.4), h(2))));
  const vDrop = vBody.mul(mix(float(0.75), float(0.95), h(3))).add(jitter.mul(h(4).mul(0.5)));
  const localD = born.add(vDrop.mul(tauD)).sub(vec3(0, tauD.mul(tauD).mul(G / 2), 0));
  const tau = mix(tauS, tauD, drip);
  const local = mix(localS, localD, drip);
  const y = local.y;
  // the eye's level frame (x right, z ahead) into the world: turned by the yaw about y, ahead is −z
  const c = U.yaw.cos();
  const s = U.yaw.sin();
  const lx = local.x;
  const lz = local.z.negate();
  const pos = vec3(U.eye.x.add(lx.mul(c)).add(lz.mul(s)), y, U.eye.z.sub(lx.mul(s)).add(lz.mul(c)));
  // alive from its throw until it is back in the sea (and the blow's mist thins out)
  // (a drip's splash draws only its share of its drops: `energy`)
  // (spray: a third of its drops drawn, the rest of the 900 kept for the ring and the blow — the full burst wrapped
  // the body as it left the water: "too much spray covering the guy", 2026-11-01)
  const life = mix(mix(float(1.5), float(1.6), blow), float(2.6), ring);
  const share = mix(mix(float(0.33), float(1), blow.add(ring)), energy, drip);
  const alive = tau.greaterThan(0).and(y.greaterThan(-0.02)).and(tau.lessThan(life)).and(h(9).lessThan(share));
  const dist = cameraPosition.sub(pos).length();
  // 1–6 cm drops, a few clumps of a hand's breadth; the blow's mist in larger, fainter puffs
  // (drips: 1–2.5 cm)
  const wanted = mix(mix(mix(mix(float(0.02), float(0.06), h(6)).mul(mix(float(1), float(1.8), smoothstep(0.9, 0.97, h(7)))), float(0.14), blow), mix(float(0.04), float(0.09), h(6)), ring), mix(float(0.01), float(0.025), h(6)), drip);
  const drawn = max(wanted, U.pixelAngle.mul(1.3).mul(dist));
  const coverage = wanted.div(drawn).pow(2);
  // (the drops break up as they go: a quarter smaller by the end of their life)
  const size = drawn.mul(alive.select(float(1), float(0))).mul(float(1).sub(tau.div(life).clamp(0, 1).mul(0.25)));

  const material = new THREE.NodeMaterial();
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.blending = THREE.NormalBlending;
  material.positionNode = eyeFacing(pos, size);
  material.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    // a soft round drop, its edge a little brighter where it bends the light behind it toward the eye
    const r = q.length();
    const disc = float(1).sub(smoothstep(0.35, 1, r));
    const rim = smoothstep(0.35, 0.8, r).mul(disc);
    // LIT AS WATER IN THIS LIGHT (the user, 2026-11-01, on the spray: "looks a bit weird, like it's not lit, so it pokes
    // out weirdly and looks like it's not part of the scene"). It had been a near-opaque white disc lit by 1.5× the
    // Sun's light from every side: a grey-white blob wherever the Sun was not behind it. A drop is clear: it scatters
    // the Sun's light FORWARD — a Henyey-Greenstein lobe, g 0.75, normalised to 1 sideways (×4π: ~25 at the Sun, ~0.3
    // at right angles, ~0.07 back toward it) — and mirrors the sky round it dimly. So toward the low Sun the spray burns
    // warm and bright, its rims sparkling; away from it, it is a faint sky-coloured veil, translucent. The ring's foam
    // is the exception: a lace of bubbles scatters every way (white-ish, sky-lit, a little of the Sun's glow).
    const cosT = normalize(pos.sub(cameraPosition)).dot(U.sun);
    const g = 0.75;
    const hg = float(1 - g * g).div(float(1 + g * g).sub(cosT.mul(2 * g)).pow(1.5));
    const toward = cosT.max(0);
    const dropLight = U.sunLight.mul(hg.mul(0.55).add(rim.mul(toward.pow(8)).mul(6))).add(U.skyLight.mul(0.55));
    const foamLight = U.sunLight.mul(float(0.35).add(hg.mul(0.25))).add(U.skyLight.mul(0.9));
    const col = mix(dropLight, foamLight, ring);
    // fading as it falls: thinner, the drops breaking up, and gone into the sea (fade); and clearer away from the Sun
    const fade = float(1).sub(smoothstep(life.mul(0.45), life, tau));
    const clear = mix(float(0.3), float(0.9), smoothstep(-0.2, 0.9, cosT));
    const opacity = mix(mix(clear, float(0.35), blow), float(0.5), ring);
    const alpha = disc.mul(min(coverage.mul(3), 1)).mul(fade).mul(opacity);
    return vec4(col, alpha);
  })();
  material.name = 'drift-splash';
  const mesh = billboardMesh(material, n * PER, 'drift-splash');
  // after the water: both are transparent, and sorted by the object's place (the world's origin, kilometres off)
  // the spray went first and the sea, which writes depth, was drawn over it
  mesh.renderOrder = 1;
  return { mesh, uniforms: U as unknown as SplashUniforms };
}
