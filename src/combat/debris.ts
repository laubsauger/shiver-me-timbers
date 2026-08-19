/**
 * SOLID DEBRIS (§T.63) — the pieces of the ship a hit actually knocks off her,
 * as opposed to the sprite burst that stands for the dust and slivers.
 *
 * ── WHY A SECOND SYSTEM, WHEN combatFx ALREADY THROWS SPLINTERS ────────
 * They answer different halves of the same complaint, and neither can do the
 * other's job:
 *
 *   SPLINTERS are camera-facing sprites. They are the right model for the
 *   hundreds of small fast slivers and the dust — cheap, additive-adjacent,
 *   and gone in about a second. A sprite has no orientation in the world, so
 *   it can never land: it can only fade wherever it happens to be, which is
 *   what "the effects don't really register" means in practice. Something
 *   that vanishes in mid-air leaves no evidence a hit occurred.
 *
 *   CHUNKS are real boxes with a real attitude. There are a handful of them,
 *   they tumble on three axes, they ARC, and — the whole point — they COME
 *   DOWN and disturb the sea where they land. The evidence outlives the
 *   event, which is the same argument impactRing.ts makes for the foam scar.
 *
 * ── COST, AND WHY THIS IS AFFORDABLE ───────────────────────────────────
 * ONE InstancedMesh, so one draw call while anything is in the air and ZERO
 * when nothing is: the mesh sets `visible = false` the moment the pool is
 * provably empty, which is the same idle-skip discipline 076ad93 imposed on
 * the sprite pool (the lesson there was that a system which is quiet 99% of
 * the time must cost nothing during that 99%, not merely little).
 *
 * The only non-trivial per-chunk cost is the sea lookup at 2.48 us, and it is
 * gated on a chunk being low enough and slow enough for the answer to matter.
 * A full pool of 40 all falling at once is ~0.10 ms, against a 28 ms frame in
 * which `combat.update` currently measures 0.012 ms.
 *
 * ── §V.2 / THE RENDER CLOCK ────────────────────────────────────────────
 * Integrated on the RENDER clock with a clamped dt, exactly like combatFx's
 * particles and combatRuntime's fallen spars, and for the same stated reason:
 * this is RENDER state. Nothing in SimState is written here and no value is
 * ever read back out of it, so a replay is unaffected by how many frames were
 * drawn (§V.3, one-way). Every draw is deterministic in (seed, index) — no
 * Math.random and no wall clock reaches a chunk.
 *
 * §V.28 throughout: pool size is a sanitized construction-time int, every
 * caller-fed value is finite-guarded at the spawn boundary, and a dead chunk
 * is written at EXACTLY zero scale rather than being hidden some other way.
 */
import * as THREE from 'three/webgpu';
import { hash01 } from './fxMath';

export interface DebrisChunks {
  /** add to the scene once (combatFx puts it in its own group) */
  mesh: THREE.Object3D;
  /**
   * Throw `count` chunks out of a point, along `axis`.
   *
   * @param seed keys every per-chunk draw, so one impact always throws the
   *             same debris and two impacts throw different debris
   */
  spawn(
    origin: readonly number[],
    axis: readonly [number, number, number],
    count: number,
    seed: number,
  ): void;
  /**
   * Advance. `seaHeightAt` is the LIVE sea (§V.8 — the same field the hulls
   * float on); `onSplash` is called once per chunk that touches the water, so
   * the caller can put a ring on the surface with the mesh it already owns
   * rather than this file growing a second splash.
   */
  update(
    dt: number,
    seaHeightAt: (x: number, z: number) => number,
    onSplash?: (x: number, y: number, z: number, energy: number) => void,
  ): void;
  /** live chunk count — for tests and the dev console */
  liveCount(): number;
  dispose(): void;
}

export interface DebrisConfig {
  /** pool size; the oldest chunk is evicted when it overflows */
  count: number;
  /** s in the air before it fades, even if it never finds water */
  life: number;
  /** s bobbing on the surface after it lands, before it fades under */
  floatLife: number;
  /** m/s launch speed */
  speed: number;
  /** 0 = a beam along the axis, 1 = a full hemisphere */
  spread: number;
  /** m — nominal LENGTH of a plank fragment; thickness/width derive from it */
  size: number;
  /** rad/s — peak tumble rate */
  spin: number;
  /** m/s^2 */
  gravity: number;
  /** 1/s exponential velocity bleed */
  drag: number;
  /** sRGB tint of freshly broken timber */
  color: number;
}

export const DEBRIS_DEFAULTS: DebrisConfig = {
  count: 40,
  life: 6,
  floatLife: 3,
  speed: 7,
  spread: 0.55,
  size: 0.8,
  spin: 6,
  gravity: 9.81,
  drag: 0.25,
  // BROKEN oak, not weathered oak: the inside of a plank is markedly lighter
  // and yellower than the sun-and-salt-greyed outside of the same plank, and
  // matching the hull's own tint here is what makes a chunk read as part of
  // the deck texture rather than as a piece that has just been torn out of it.
  color: 0xb08a5c,
};

/** the box the instance transform stretches into a plank fragment */
const CHUNK_GEO_SIZE = 1;

export function createDebris(config: Partial<DebrisConfig> = {}): DebrisChunks {
  const c: DebrisConfig = { ...DEBRIS_DEFAULTS, ...config };
  const count = sanitizeCount(c.count, DEBRIS_DEFAULTS.count, 256);

  const px = new Float32Array(count);
  const py = new Float32Array(count);
  const pz = new Float32Array(count);
  const vx = new Float32Array(count);
  const vy = new Float32Array(count);
  const vz = new Float32Array(count);
  /** tumble axis, unit */
  const ax = new Float32Array(count);
  const ay = new Float32Array(count);
  const az = new Float32Array(count);
  /** current roll about that axis, rad, and its rate */
  const ang = new Float32Array(count);
  const spin = new Float32Array(count);
  /** per-chunk box dimensions, m */
  const sx = new Float32Array(count);
  const sy = new Float32Array(count);
  const sz = new Float32Array(count);
  const age = new Float32Array(count);
  const life = new Float32Array(count);
  /**
   * Seconds this chunk has been IN THE WATER. -1 means still airborne.
   *
   * A separate clock from `age` on purpose: a chunk that lands early has
   * earned its float time, and one that is still in the air at the end of
   * `life` has not. Folding them into one counter would make a long, high arc
   * disappear the instant it touched down.
   */
  const wet = new Float32Array(count);
  age.fill(1);
  life.fill(1); // whole pool starts dead (age >= life)
  wet.fill(-1);

  let cursor = 0;
  /**
   * Upper bound on remaining life across the pool — the same device combatFx
   * uses. Zero means every slot is provably dead, which is the one condition
   * under which skipping the walk (and hiding the mesh) cannot change a pixel.
   */
  let liveFor = 0;
  let live = 0;

  const geo = new THREE.BoxGeometry(CHUNK_GEO_SIZE, CHUNK_GEO_SIZE, CHUNK_GEO_SIZE);
  const material = new THREE.MeshStandardNodeMaterial({
    // §V.31: sRGB-authored tint through THREE.Color, never a bare setRGB
    color: new THREE.Color(c.color),
    roughness: 0.85,
    metalness: 0,
  });
  const mesh = new THREE.InstancedMesh(geo, material, count);
  mesh.name = 'combat-debris';
  mesh.count = 0;
  mesh.visible = false;
  // positions are rewritten every frame from world coordinates, so there are
  // no meaningful bounds to cull against (same as the sprite pool and balls)
  mesh.frustumCulled = false;
  /**
   * NO SHADOW, deliberately. Sun shadows went back on only after B5 was found
   * (243e15a), and a shadow pass is a second draw of every caster; 40 tumbling
   * fragments the size of a forearm would cost that pass for shadows that are
   * a few pixels each and are moving too fast to be read. Turn it on here if
   * the budget ever says otherwise — it is one line and no other code cares.
   */
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  /** published for tests and the dev console — the same contract combatFx sets */
  mesh.userData.debrisPool = { px, py, pz, sx, age, life, wet };

  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const tmpAxis = new THREE.Vector3();
  const tmpPos = new THREE.Vector3();
  const tmpScale = new THREE.Vector3();

  return {
    mesh,

    spawn(origin, axis, n, seed): void {
      if (count === 0) return;
      const total = sanitizeCount(n, 0, count);
      const ox = finite(origin[0]);
      const oy = finite(origin[1]);
      const oz = finite(origin[2]);
      const dir = unit(axis[0], axis[1], axis[2]);
      const spread = clamp01(c.spread);
      const size = Math.max(0.02, nn(c.size, DEBRIS_DEFAULTS.size));

      for (let k = 0; k < total; k++) {
        const i = cursor;
        cursor = (cursor + 1) % count; // rotating pool: the newest hit wins

        // launch direction: the axis, tipped into a cone by two independent
        // draws. Not `burstDirection` — that is a golden-angle SPIRAL built to
        // fill a cone evenly with dozens of particles, and with five chunks an
        // even fill reads as a fan. Debris wants to look thrown, not arranged.
        const t1 = hash01(seed, k * 5 + 1) * 2 - 1;
        const t2 = hash01(seed, k * 5 + 2) * 2 - 1;
        const [u, v] = perpBasis(dir);
        const dx = dir[0] + (u[0] * t1 + v[0] * t2) * spread;
        const dy = dir[1] + (u[1] * t1 + v[1] * t2) * spread;
        const dz = dir[2] + (u[2] * t1 + v[2] * t2) * spread;
        const d = unit(dx, dy, dz);
        // a heavier fragment leaves slower: the speed draw and the SIZE draw
        // below share `k` but not their salt, so they are independent, and
        // then speed is divided by the size the chunk actually got. Without
        // that, a burst is a set of identical arcs at different scales.
        const bulk = 0.55 + 0.9 * hash01(seed, k * 5 + 3);
        const speed = Math.max(0, nn(c.speed, DEBRIS_DEFAULTS.speed))
          * (0.7 + 0.6 * hash01(seed, k * 5 + 4)) / bulk;

        px[i] = ox;
        py[i] = oy;
        pz[i] = oz;
        vx[i] = d[0] * speed;
        vy[i] = d[1] * speed;
        vz[i] = d[2] * speed;

        // a plank fragment: long, thin, and narrow — in that order. The 0.09
        // and 0.28 are FRACTIONS of the length, so `size` is one knob that
        // scales a chunk without ever making it a cube.
        const len = size * bulk;
        sx[i] = len;
        sy[i] = len * 0.09;
        sz[i] = len * 0.28;

        // tumble about a random unit axis, so chunks turn end-over-end AND
        // roll about their own length rather than all spinning in one plane
        const tumbleAxis = unit(
          hash01(seed, k * 5 + 5) * 2 - 1,
          hash01(seed ^ 0x9e3779b9, k * 5 + 5) * 2 - 1,
          hash01(seed ^ 0x85ebca6b, k * 5 + 5) * 2 - 1,
        );
        ax[i] = tumbleAxis[0];
        ay[i] = tumbleAxis[1];
        az[i] = tumbleAxis[2];
        ang[i] = hash01(seed, k * 5 + 6) * Math.PI * 2;
        // small fragments spin FASTER, for the same reason they fly faster
        spin[i] = (hash01(seed, k * 5 + 7) * 2 - 1)
          * Math.max(0, nn(c.spin, DEBRIS_DEFAULTS.spin)) / bulk;

        age[i] = 0;
        // floored below zero-length: a life of 0 divides to a NaN age (§B.5)
        life[i] = Math.max(0.1, nn(c.life, DEBRIS_DEFAULTS.life))
          * (0.8 + 0.4 * hash01(seed, k * 5 + 8));
        wet[i] = -1;
        if (life[i] > liveFor) liveFor = life[i];
      }
    },

    update(dt, seaHeightAt, onSplash): void {
      // §V.28: a non-finite dt would drive every chunk to NaN in one frame; a
      // huge one (restored tab) would teleport the whole field
      const step = Number.isFinite(dt) ? Math.max(0, Math.min(dt, 0.25)) : 0;
      if (liveFor <= 0) {
        // provably empty. `liveFor` only reaches zero AFTER the frame on which
        // the last chunk was written at zero scale, so the mesh is flushed
        // before it is hidden and this cannot leave a chunk stuck on screen.
        if (mesh.visible) {
          mesh.visible = false;
          mesh.count = 0;
          live = 0;
        }
        return;
      }
      liveFor = Math.max(0, liveFor - step);

      const gravity = Math.max(0, nn(c.gravity, DEBRIS_DEFAULTS.gravity));
      const keep = Math.exp(-Math.max(0, nn(c.drag, DEBRIS_DEFAULTS.drag)) * step);
      const floatLife = Math.max(0.05, nn(c.floatLife, DEBRIS_DEFAULTS.floatLife));

      let n = 0;
      for (let i = 0; i < count; i++) {
        if (age[i] >= life[i]) continue;
        age[i] += step;

        if (wet[i] < 0) {
          // ── AIRBORNE ────────────────────────────────────────────────────
          vx[i] *= keep;
          vy[i] = (vy[i] - gravity * step) * keep;
          vz[i] *= keep;
          px[i] += vx[i] * step;
          py[i] += vy[i] * step;
          pz[i] += vz[i] * step;
          ang[i] += spin[i] * step;

          // THE SEA LOOKUP IS GATED. It is the only expensive thing in this
          // loop (2.48 us), and it can only change the outcome for a chunk
          // that is descending: one still climbing cannot enter the water this
          // frame however low it is. That halves the calls in the first half
          // of every arc for free, and costs one compare.
          if (vy[i] <= 0) {
            const sea = finite(seaHeightAt(px[i], pz[i]));
            if (py[i] <= sea) {
              // Land it ON the surface rather than wherever the step happened
              // to put it: at 15 m/s and a 16 ms frame a chunk overshoots by a
              // quarter of a metre, which is a visible plunge-through.
              py[i] = sea;
              wet[i] = 0;
              // the ring is the caller's to make — it already owns a mesh that
              // fits the local wave plane (376d02d), and a second splash path
              // is exactly the duplication that file's header argues against
              const impact = Math.hypot(vx[i], vy[i], vz[i]);
              onSplash?.(px[i], sea, pz[i], Math.min(1.6, 0.35 + impact * 0.05));
              vx[i] *= 0.15;
              vz[i] *= 0.15;
              vy[i] = 0;
            }
          }
        } else {
          // ── AFLOAT ──────────────────────────────────────────────────────
          // It rides the surface it landed on — the sea moves metres under a
          // floating object inside its own float life, and a chunk pinned to
          // its splashdown height sinks into the next crest and pops out of
          // the one after (the same defect §V.71 records for the rings).
          wet[i] += step;
          px[i] += vx[i] * step;
          pz[i] += vz[i] * step;
          vx[i] *= keep;
          vz[i] *= keep;
          py[i] = finite(seaHeightAt(px[i], pz[i]));
          // the tumble washes out fast in water, but does not stop dead
          ang[i] += spin[i] * step;
          spin[i] *= 0.9;
          if (wet[i] >= floatLife) {
            age[i] = life[i]; // waterlogged: it goes under
          }
        }

        if (age[i] >= life[i]) continue; // died this frame; leave it unwritten

        // FADE BY SHRINKING, not by opacity. The material is opaque and lit,
        // so fading it out would mean a transparent pass and a sort — and a
        // §V.28 dead instance must be zero-SIZE anyway. A fragment tumbling
        // away and getting smaller reads as distance, which is free honesty.
        const t = age[i] / Math.max(life[i], 1e-4);
        const fade = t > 0.75 ? Math.max(0, 1 - (t - 0.75) / 0.25) : 1;
        // afloat, it also settles INTO the water rather than resting on it
        const sink = wet[i] > 0 ? Math.min(1, wet[i] / floatLife) * sy[i] * 0.5 : 0;

        tmpAxis.set(ax[i], ay[i], az[i]);
        q.setFromAxisAngle(tmpAxis, ang[i]);
        tmpPos.set(px[i], py[i] - sink, pz[i]);
        tmpScale.set(sx[i] * fade, sy[i] * fade, sz[i] * fade);
        m.compose(tmpPos, q, tmpScale);
        mesh.setMatrixAt(n++, m);
      }

      live = n;
      mesh.count = n;
      mesh.visible = n > 0;
      mesh.instanceMatrix.needsUpdate = true;
    },

    liveCount: () => live,

    dispose(): void {
      geo.dispose();
      material.dispose();
    },
  };
}

/** the two unit vectors perpendicular to `d` and to each other */
function perpBasis(
  d: readonly [number, number, number],
): [[number, number, number], [number, number, number]] {
  // the helper must not be parallel to `d`, or the cross product is zero
  const helper: [number, number, number] = Math.abs(d[1]) < 0.9 ? [0, 1, 0] : [1, 0, 0];
  const u = unit(
    d[1] * helper[2] - d[2] * helper[1],
    d[2] * helper[0] - d[0] * helper[2],
    d[0] * helper[1] - d[1] * helper[0],
  );
  const v = unit(
    d[1] * u[2] - d[2] * u[1],
    d[2] * u[0] - d[0] * u[2],
    d[0] * u[1] - d[1] * u[0],
  );
  return [u, v];
}

/** unit vector with a floored divisor — a zero axis would burst to NaN */
function unit(x: number, y: number, z: number): [number, number, number] {
  const fx = finite(x);
  const fy = finite(y);
  const fz = finite(z);
  const len = Math.hypot(fx, fy, fz);
  if (len < 1e-6) return [0, 1, 0];
  return [fx / len, fy / len, fz / len];
}

function sanitizeCount(v: number, fallback: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(0, Math.min(n, max));
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
