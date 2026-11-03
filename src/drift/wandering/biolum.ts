/**
 * THE WANDERERS' PRINTS IN LIGHT (params biolum, off by default; the user, 2026-11-02, after the spine review: glowing
 * plankton "could be a nice thing for maybe when they walk also through the rather dark beach section at the end").
 * On a beach where the surf glows, the plankton the backwash leaves in the wet sand flash where a foot presses it: each
 * step lights the sole's shape and a little round it, bright for a moment, fading over a few seconds; a step in the
 * shallows throws a small ring of sparks out from the foot. So the three who walk on in w6 leave a short trail of
 * light along the water's edge behind them (the surf's own light: shoreline.ts, swashSim.ts THE GLOW; both drawn by
 * biolumGlow.ts).
 *
 * PURE IN t, AS THE WALK IS. A print is where a foot came down, and when: found from the walk's own history (props.ts
 * `wanderer`, read-only here), not remembered from the frames before. The walk is sampled on a fixed grid of times
 * (GRID s, absolute: every frame that asks for one gets the same sample, so they are kept and shared across frames
 * and lanes alike) over the last LIFE s; a foot comes down where its stride's phase passes a heel strike (crew.ts
 * pose: foot s is planted from 2π(phase + s/2) = π/2, the thigh at its most forward, to 3π/2), and the phase is
 * interpolated between samples for the moment and the place. The foot lands ahead of the body by the leg's swing
 * (WALK_LEG · sin(amp · WALK_HIP), crew.ts) and to its own side.
 *
 * Only where the sand is wet or under water (the swash sim's `marks` wetness and `water` depth, at the fragment): up the
 * dry sand, a foot lights nothing. Drawn as one small mesh of quads laid on the sand under the prints, its vertices
 * rewritten each frame, added light (no fog: it is light at the sand, not a surface the haze lies over), after the
 * shoreline's water and before the sea, so it shows through the swash's few centimetres.
 */
import * as THREE from 'three/webgpu';
import { attribute, exp, float, fwidth, mix, normalize, positionWorld, smoothstep, texture, vec2, vec4 } from 'three/tsl';
import { wanderer, wetSand } from './props';
import { swashClock, swashLight } from './shoreline';
import { swashField, swashIn, swashUV } from './swashSim';
import { biolumDark, biolumFade, biolumLight, biolumOnset, biolumSparkle } from './biolumGlow';
import { spec } from './beats';

type F = THREE.Node<'float'>;
type V2 = THREE.Node<'vec2'>;
type V3 = THREE.Node<'vec3'>;
type V4 = THREE.Node<'vec4'>;

/** s between the walk's samples, and s a print is kept for (its light is gone by then: PRINT) */
const GRID = 0.1;
const LIFE = 7;
/** prints drawn at most (three walkers, ~1.7 steps a second each, over LIFE s: ~36) */
const MAX_PRINTS = 64;
/** m: the quad each print is drawn on (a side; the splash ring reaches ~0.5 m across), and its lift over the sand */
const QUAD = 1.1;
const LIFT = 0.012;
/** the wanderers' heights (m; props.ts WALKERS, which it does not export — only the prints' size and spacing ride on
 * them) and the crew's gait (crew.ts WALK_LEG, WALK_HIP, the ankle's 0.1 m off the middle) at 1.75 m */
const HEIGHTS = [1.78, 1.64, 1.72];
const LEG = 0.85;
const HIP = 0.41;
const ANKLE_SIDE = 0.1;
/** m the sole's middle lies ahead of the ankle (props.ts: the contact shade's 0.05) */
const SOLE_AHEAD = 0.05;
/**
 * THE PRINT'S LIGHT over its age τ (s): a flash as the foot presses the sand, most of it gone within half a second, and
 * a faint tail over a couple more — the user's "footprints that glow briefly and fade (a few seconds)". Brightest at
 * the print's RIM, where the foot pushed the wet sand out and the water in it was stirred most, the sole's middle
 * dimmer (the references, Norderney's wet sand: the glow in the films of water the sand is squeezed into, a soft
 * smudge, not glitter spread round it; the 2026-11-02 note on the first round: "a short-lived glowing smudge rim").
 *
 * IN THE SHALLOWS, the foot's shape too, never a ring (the user, 2026-11-02, of the first round's: "the steps they take
 * in the water seem like perfect circles … unnatural and a bit digital"): the water pushed out round the sole lights
 * along its rim as it comes down; a splash thrown forward of the toe, elongated along the walk (SPLASH.ahead: how far
 * ahead and how far it runs, m; its half-size across and along, m; its fade, s); and as the foot lifts and swings on,
 * the water it leaves behind it swirls — a short V of wake trailing from the heel (SPLASH.wake: its length, m, the
 * V's half-angle as a slope, its width, m, its fade, s) — breaking into the grain's sparks. Every step its own: its
 * size and its light vary with its seed (SPLASH.vary)
 */
const PRINT = { rim: 0.75, middle: 0.3, flashLife: 0.45, tail: 0.3, tailLife: 1.8 } as const;
const SPLASH = {
  rim: 0.35,
  rimLife: 0.35,
  ahead: { at: 0.17, run: 0.14, runLife: 0.3, across: 0.06, along: 0.12, light: 0.7, life: 0.45 },
  wake: { length: 0.45, slope: 0.45, width: 0.035, light: 0.6, from: 0.15, life: 0.9 },
  vary: { size: 0.2, light: 0.35 },
} as const;

export interface BiolumPrints {
  readonly mesh: THREE.Mesh;
  /** the prints at sea time t: `w5` the walk's start (beats.ts starts.w5), `on` false where the walkers are not drawn */
  update(t: number, w5: number, on: boolean): void;
}

/** a foot come down: where (world x, z, m), the walker's turn (rad, its group's rotation.y: −z forward), its size
 * against the crew's 1.75 m, s since it came down, which foot (+1 right, −1 left), and a seed for its sparks */
export interface Footfall {
  x: number;
  z: number;
  rot: number;
  scale: number;
  age: number;
  side: number;
  seed: number;
  /** which wanderer (props.ts WALKERS) */
  walker: number;
}

interface WalkSample {
  along: number;
  off: number;
  phase: number;
  amp: number;
  rot: number;
}

/** the prints of the wanderers along our beach: `ground` its height (m over the sea), `beach` its middle */
export function createBiolumPrints(o: { ground: (x: number, z: number) => number; beach: { x: number; z: number } }): BiolumPrints {
  const { ground, beach } = o;
  const n4 = MAX_PRINTS * 4;
  const pos = new Float32Array(n4 * 3);
  const local = new Float32Array(n4 * 2);
  const info = new Float32Array(n4 * 2);
  const idx = new Uint16Array(MAX_PRINTS * 6);
  for (let k = 0; k < MAX_PRINTS; k++) {
    idx.set([k * 4, k * 4 + 2, k * 4 + 1, k * 4 + 1, k * 4 + 2, k * 4 + 3], k * 6);
  }
  const geo = new THREE.BufferGeometry();
  const posA = new THREE.BufferAttribute(pos, 3);
  const localA = new THREE.BufferAttribute(local, 2);
  const infoA = new THREE.BufferAttribute(info, 2);
  for (const a of [posA, localA, infoA]) a.setUsage(THREE.DynamicDrawUsage);
  geo.setAttribute('position', posA);
  geo.setAttribute('printLocal', localA);
  geo.setAttribute('printInfo', infoA);
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.setDrawRange(0, 0);

  // THE LIGHT of a print, per fragment: `printLocal` m in the foot's own frame (x to its right, y ahead, scaled to
  // its walker), `printInfo` (age s, a seed)
  const q = attribute('printLocal', 'vec2') as V2;
  const pi = attribute('printInfo', 'vec2') as V2;
  const age = pi.x as F;
  // (the sole: a ball and a heel, as a distance in sole-radii; its rim a soft band round 1, its middle under it)
  const ell = (c: [number, number], r: [number, number]): F => q.sub(vec2(...c)).div(vec2(...r)).length() as F;
  const soleD = ell([0, 0.065], [0.05, 0.075]).min(ell([0, -0.07], [0.036, 0.048])) as F;
  const rimD = soleD.sub(1.05).div(0.28) as F;
  const shape = exp(rimD.mul(rimD).negate()).mul(PRINT.rim).max(smoothstep(1.1, 0.6, soleD).mul(PRINT.middle)) as F;
  const onSand = shape.mul(exp(age.div(-PRINT.flashLife)).mul(float(1).sub(PRINT.tail)).add(exp(age.div(-PRINT.tailLife)).mul(PRINT.tail))) as F;
  // (each step its own: a size and a light from its seed, ±SPLASH.vary)
  const vS = pi.y.mul(0.618).fract() as F;
  const vL = pi.y.mul(0.382).add(0.27).fract() as F;
  const size = vS.sub(0.5).mul(2 * SPLASH.vary.size).add(1) as F;
  const lightV = vL.sub(0.5).mul(2 * SPLASH.vary.light).add(1) as F;
  const qv = q.div(size) as V2;
  const ellV = (c: [number, number], r: [number, number]): F => qv.sub(vec2(...c)).div(vec2(...r)).length() as F;
  const soleV = ellV([0, 0.065], [0.05, 0.075]).min(ellV([0, -0.07], [0.036, 0.048])) as F;
  const rimV = soleV.sub(1.1).div(0.35) as F;
  const rimW = exp(rimV.mul(rimV).negate()).mul(exp(age.div(-SPLASH.rimLife))).mul(SPLASH.rim) as F;
  // (the splash ahead of the toe: an elongated blob thrown forward, running on a little)
  const A = SPLASH.ahead;
  const aheadY = float(A.at).add(float(1).sub(exp(age.div(-A.runLife))).mul(A.run)) as F;
  const aD = vec2(qv.x.div(A.across), qv.y.sub(aheadY).div(A.along)).length() as F;
  const aheadW = exp(aD.mul(aD).negate()).mul(exp(age.div(-A.life))).mul(A.light) as F;
  // (the wake trailing from the heel as the foot swings on: a V behind it, |x| ≈ slope·(distance behind), coming in
  // as the foot lifts and lasting longest)
  const W = SPLASH.wake;
  const behind = qv.y.negate().sub(0.1) as F;
  const vD = qv.x.abs().sub(behind.max(0).mul(W.slope)).div(W.width) as F;
  const wakeW = exp(vD.mul(vD).negate())
    .mul(smoothstep(0, 0.05, behind).mul(smoothstep(W.length, W.length * 0.5, behind)))
    .mul(smoothstep(W.from * 0.5, W.from, age).mul(exp(age.div(-W.life))))
    .mul(W.light) as F;
  const inWaterLight = rimW.max(aheadW).max(wakeW).mul(lightV) as F;
  // (where the sand is wet, or under water: the swash sim's fields at this fragment; past the sim's ends, the sand
  // within ~0.3 m of the still water)
  const xzW = positionWorld.xz as V2;
  const uvW = swashUV(xzW);
  const depth = ((texture(swashField.water, uvW) as unknown as V4).y as F).max(0) as F;
  const wetSim = ((texture(swashField.marks, uvW) as unknown as V4).z as F).max(smoothstep(0.0005, 0.003, depth)) as F;
  const wet = mix(smoothstep(0.3, 0.12, positionWorld.y), wetSim, swashIn(xzW)) as F;
  const inWater = smoothstep(0.008, 0.03, depth).mul(swashIn(xzW)) as F;
  const excite = mix(onSand.mul(lightV), inWaterLight, inWater).mul(wet).mul(smoothstep(-0.01, 0.02, age)).clamp(0, 1) as F;
  // (sparks in the foot's frame, offset by its seed, so no two prints share a pattern)
  const qs = q.add(vec2(pi.y.mul(37.1), pi.y.mul(11.3))) as V2;
  const px = fwidth(q).length() as F;
  const sunY = normalize(swashLight.dir as unknown as V3).y as F;
  const light = biolumLight.mul(biolumSparkle(qs, excite, px, swashClock as unknown as F, 5).mul(biolumDark(sunY))) as V3;
  const m = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  m.colorNode = vec4(light, 1);
  m.polygonOffset = true;
  m.polygonOffsetFactor = -2;
  m.side = THREE.DoubleSide;
  m.name = 'drift-biolum-prints';
  const mesh = new THREE.Mesh(geo, m);
  mesh.name = 'drift-biolum-prints';
  mesh.position.set(beach.x, 0, beach.z);
  mesh.frustumCulled = false;
  // (after the shoreline's water, -0.25, before the sea: shoreline.ts — the sea writes its depth over the shallows)
  mesh.renderOrder = -0.2;

  const footfalls = createFootfalls(ground, beach);

  let count = 0;
  const lay = (x: number, z: number, rot: number, scale: number, ageS: number, seed: number): void => {
    if (count >= MAX_PRINTS) return;
    // (the quad's corners in the foot's frame, ±QUAD/2; in the world turned by the walker's rot — its −z forward)
    const c = Math.cos(rot);
    const s = Math.sin(rot);
    const h = QUAD / 2;
    const corners: Array<[number, number]> = [
      [-h, -h],
      [h, -h],
      [-h, h],
      [h, h],
    ];
    corners.forEach(([lx, ly], v) => {
      // (local x right → world (cos, −sin); local ahead (y) → world (−sin, −cos))
      const wx = x + lx * c - ly * s;
      const wz = z - lx * s - ly * c;
      const k = count * 4 + v;
      pos.set([wx - beach.x, ground(wx, wz) + LIFT, wz - beach.z], k * 3);
      local.set([lx / scale, ly / scale], k * 2);
      info.set([ageS, seed], k * 2);
    });
    count++;
  };

  return {
    mesh,
    update(t, w5, on) {
      // (the glow's onset with the night, for every term of it: biolumGlow.ts BIOLUM_ONSET)
      (biolumFade as unknown as { value: number }).value = biolumOnset(t, w5 + spec('w5')!.length);
      count = 0;
      if (on) for (const f of footfalls(t, w5)) lay(f.x, f.z, f.rot, f.scale, f.age, f.seed);
      posA.needsUpdate = true;
      localA.needsUpdate = true;
      infoA.needsUpdate = true;
      geo.setDrawRange(0, count * 6);
      mesh.visible = count > 0;
    },
  };
}

/**
 * THE FEET THAT CAME DOWN over the last LIFE s before sea time t (see the header): `w5` the walk's start (beats.ts
 * starts.w5). The walk's samples on the grid are kept between calls (the same for whoever asks, so the result does not
 * depend on which frames came before); a frame's own instant is sampled fresh.
 */
export function createFootfalls(ground: (x: number, z: number) => number, beach: { x: number; z: number }): (t: number, w5: number) => Footfall[] {
  const edge = wetSand(ground, beach);
  const samples = new Map<number, WalkSample[]>();
  let samplesFor = NaN;
  const sampleAt = (time: number, w5: number): WalkSample[] =>
    HEIGHTS.map((_, i) => {
      const p = wanderer(i, time, w5, edge);
      return { along: p.along, off: p.off, phase: p.phase, amp: p.amp, rot: p.heading + 0.25 * p.look };
    });
  const gridAt = (k: number, w5: number): WalkSample[] => {
    let s = samples.get(k);
    if (!s) {
      s = sampleAt(k * GRID, w5);
      samples.set(k, s);
    }
    return s;
  };
  return (t, w5) => {
    if (samplesFor !== w5) {
      samples.clear();
      samplesFor = w5;
    }
    const k0 = Math.floor((t - LIFE - 1) / GRID);
    const k1 = Math.floor(t / GRID);
    for (const k of samples.keys()) if (k < k0 || k > k1 + 1) samples.delete(k);
    const times: number[] = [];
    const at: WalkSample[][] = [];
    for (let k = k0; k <= k1; k++) {
      times.push(k * GRID);
      at.push(gridAt(k, w5));
    }
    if (t > k1 * GRID) {
      times.push(t);
      at.push(sampleAt(t, w5));
    }
    const out: Footfall[] = [];
    HEIGHTS.forEach((height, i) => {
      const scale = height / 1.75;
      for (let n = 1; n < times.length; n++) {
        const a = at[n - 1][i];
        const b = at[n][i];
        if (!(b.phase > a.phase)) continue;
        // heel strikes in (a.phase, b.phase]: phase = m/2 + 1/4, foot m mod 2 (crew.ts pose: foot s's thigh most
        // forward at 2π(phase + s/2) = π/2)
        for (let m = Math.ceil((a.phase - 0.25) * 2); m / 2 + 0.25 <= b.phase; m++) {
          const strike = m / 2 + 0.25;
          if (strike <= a.phase) continue;
          const f = (strike - a.phase) / (b.phase - a.phase);
          const age = t - (times[n - 1] + f * (times[n] - times[n - 1]));
          if (age > LIFE || age < 0) continue;
          const along = a.along + f * (b.along - a.along);
          const off = a.off + f * (b.off - a.off);
          const rot = a.rot + f * (b.rot - a.rot);
          const amp = a.amp + f * (b.amp - a.amp);
          // (foot 0 is the right: crew.ts sym, its +x first)
          const side = m % 2 === 0 ? 1 : -1;
          // the body at the strike; the foot ahead of it by the leg's swing, and to its own side
          const ahead = (LEG * Math.sin(amp * HIP) + SOLE_AHEAD) * scale;
          const lat = side * ANKLE_SIDE * scale;
          const c = Math.cos(rot);
          const sn = Math.sin(rot);
          // (the walker's frame: its right (cos, −sin), ahead (−sin, −cos) in world x, z — three's rotation.y)
          out.push({ x: beach.x - off + lat * c - ahead * sn, z: beach.z - along - lat * sn - ahead * c, rot, scale, age, side, seed: (i * 997 + m * 13) % 101, walker: i });
        }
      }
    });
    return out;
  };
}
