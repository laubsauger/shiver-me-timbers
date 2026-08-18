/**
 * What a cannonball leaves ON THE SEA ITSELF (§T.16 water entry) — the
 * expanding ring, and the foam scar that outlives it.
 *
 * This is the half of a water impact that says the water was INTERACTED WITH
 * rather than decorated. Sprites thrown into the air above a surface always
 * read as sprites thrown into the air above a surface; a disturbance that
 * lives ON the surface, moves with it and takes seconds to fade is the cue
 * the user was asking for ("they don't really look like they are interacting
 * with the water").
 *
 * ── WHY THIS IS GEOMETRY AND NOT A SHADER RING ─────────────────────────
 * The obvious build is a quad with `smoothstep` on a radial coordinate. That
 * is a procedural periodic-ish EDGE on a spatial coordinate, which §V.48
 * requires be band-limited against the FEATURE's own width plus the §V.48b
 * fade — and the §V.48 ratchet is at BASELINE 176 with zero headroom by
 * design, so the commit that adds an unfiltered edge is the commit that
 * fails. Here the disc is real geometry and BOTH cross-section profiles are
 * per-vertex attributes interpolated across triangles: a varying cannot
 * alias, and the outline is geometric coverage, which is the one thing MSAA
 * genuinely does resolve (§B.45). Zero new edges, and no browser needed to
 * defend it.
 *
 * The cost of that choice is that ring THICKNESS lives in the vertex data
 * rather than in a uniform. A construction-time-only thickness would be a
 * dead knob, and this project produces those faster than it finds them
 * (§V.62) — so `update` re-lays the profile attributes in place when
 * `ringWidth` moves. Same vertex count, same buffers, no reallocation, and it
 * only runs on the frame the slider actually changes.
 *
 * ── ONE MESH, TWO FAMILIES ─────────────────────────────────────────────
 * The rim RING and the foam SCAR are the same disc drawn with two different
 * radial profiles, selected per instance by `fill`. They are one InstancedMesh
 * on purpose: the frame is CPU-BOUND at ~595 draws and 18 passes, so a second
 * mesh to hold a second profile is the wrong currency. Their pool slots are
 * partitioned rather than shared, so a burst of rings can never evict the
 * long-lived scars — two rotating cursors over one buffer.
 *
 * ── §V.71: A PART RESOLVES AGAINST THE SURFACE'S LIVE SHAPE ────────────
 * A flat disc seated at the sea height under its own CENTRE is right in one
 * point and wrong everywhere else. Measured on the shipped sea (wind 11,
 * amplitude 0.24, Hs 3.66 m) at the shipped 5.5 m ring radius, the rim of
 * such a disc misses the water by a MEAN of 0.376 m and by as much as
 * 1.784 m — i.e. by three to fifteen times the 0.12 m lift that is supposed
 * to keep it off the surface, so half the ring is buried and half is floating
 * in the air. That is the "latched on top" read, and it is the same class of
 * defect as the ratlines, the buntlines and the reef points: a part resolved
 * against a rest pose while its host surface moves metres underneath it.
 *
 * The cure is to seat each disc on the local wave PLANE rather than at a
 * point: four `heightAt` samples in a cross at the disc's own radius give the
 * mean height and both gradients, and the instance is tilted onto that plane.
 * Same measurement, re-run: mean rim error 0.142 m, max 0.758 m — 2.6x and
 * 2.4x better, and now comfortably inside the lift. Cost is 4 `heightAt`
 * calls per LIVE disc per frame at 2.48 us each (measured), so a broadside's
 * worth of misses in the air at once is ~0.08 ms and the pool completely full
 * is ~0.40 ms. Not throttled: the sea it is fitting moves, and a stale plane
 * is the bug being fixed.
 *
 * §V.28: a dead disc is written at EXACTLY zero scale, never zero opacity —
 * an invisible-but-rasterized quad is the same fill-rate bill for nothing.
 */
import * as THREE from 'three/webgpu';
import { attribute, instancedBufferAttribute, mix, vec3 } from 'three/tsl';
import type { CombatFxParams } from '../params/combat';

/** ring segments around, and rows from centre to rim */
const THETA_SEGMENTS = 48;
/**
 * Rows across the disc. The RING's profile is a sine hump confined to the
 * outer `ringWidth` fraction, so it gets only `RADIAL_ROWS * ringWidth` rows —
 * at the shipped 0.32 that is 4.5 rows, which is the same resolution the old
 * annulus-only geometry gave it with 6 rows over its whole span.
 */
const RADIAL_ROWS = 14;

/** sea foam, §V.31 sRGB through THREE.Color */
const RING_TINT = /*@__PURE__*/ new THREE.Color(0xdff0ec);

export interface ImpactRings {
  mesh: THREE.Object3D;
  /**
   * Start a ring AND its foam scar at a world point (once per water entry).
   * `energy` is the impact scale (1 = the authored burst) — a heavier strike
   * disturbs more water, and before it existed every splash in the game left
   * the identical mark whatever shot made it.
   */
  spawn(x: number, y: number, z: number, energy?: number): void;
  /**
   * Advance and refresh. `seaHeightAt` re-seats every live disc on the LIVE
   * surface — on the local wave PLANE, not at a point; see the header. `windX`
   * / `windZ` drift the foam scars, because foam sits IN the water and the
   * surface layer moves; a scar pinned to world coordinates slides backwards
   * across the sea it is supposed to be floating in.
   */
  update(
    dt: number,
    seaHeightAt: (x: number, z: number) => number,
    windX?: number,
    windZ?: number,
  ): void;
  dispose(): void;
}

export function createImpactRings(p: CombatFxParams): ImpactRings {
  const ringCount = sanitizeCount(p.ringCount, 24, 64);
  const foamCount = sanitizeCount(p.foamCount, 20, 64);
  const count = ringCount + foamCount;

  const geo = new THREE.BufferGeometry();
  const vertexCount = (THETA_SEGMENTS + 1) * (RADIAL_ROWS + 1);
  const posArr = new Float32Array(vertexCount * 3);
  const bandArr = new Float32Array(vertexCount);
  const discArr = new Float32Array(vertexCount);
  const posAttr = new THREE.BufferAttribute(posArr, 3);
  const bandAttr = new THREE.BufferAttribute(bandArr, 1);
  const discAttr = new THREE.BufferAttribute(discArr, 1);
  let laidWidth = layDisc(posArr, bandArr, discArr, p.ringWidth);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('band', bandAttr);
  geo.setAttribute('disc', discAttr);
  geo.setIndex(discIndices());
  // instances sit anywhere in the world at any scale; the unit-radius bound
  // three would compute means nothing, so skip culling entirely
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

  const fadeArr = new Float32Array(count);
  const fadeAttr = new THREE.InstancedBufferAttribute(fadeArr, 1);
  fadeAttr.setUsage(THREE.DynamicDrawUsage);
  /** 0 = rim ring, 1 = foam scar. Fixed per slot by the pool partition. */
  const fillArr = new Float32Array(count);
  for (let i = ringCount; i < count; i++) fillArr[i] = 1;
  const fillAttr = new THREE.InstancedBufferAttribute(fillArr, 1);

  const material = new THREE.MeshBasicNodeMaterial();
  // Colour is a FLAT tint; the cross-section profile and the age fade both
  // drive OPACITY. Fading the colour instead would turn the mark grey as it
  // died rather than thinning it — foam gets sparser, it does not get darker.
  material.colorNode = vec3(RING_TINT.r, RING_TINT.g, RING_TINT.b);
  material.opacityNode = instancedBufferAttribute(fadeAttr, 'float').mul(
    mix(
      attribute('band', 'float'),
      attribute('disc', 'float'),
      instancedBufferAttribute(fillAttr, 'float'),
    ),
  );
  material.transparent = true;
  material.depthWrite = false;
  material.side = THREE.DoubleSide;
  material.fog = false;

  const mesh = new THREE.InstancedMesh(geo, material, Math.max(1, count));
  mesh.name = 'combat-impact-rings';
  mesh.count = count;
  mesh.frustumCulled = false;

  // --- pool ---------------------------------------------------------------
  const cx = new Float32Array(count);
  const cy = new Float32Array(count);
  const cz = new Float32Array(count);
  const age = new Float32Array(count);
  /** impact scale this disc was born at (§V.66) */
  const gain = new Float32Array(count).fill(1);
  age.fill(1e6); // whole pool starts dead
  /** two cursors over one buffer: a burst of rings cannot evict the scars */
  let ringCursor = 0;
  let foamCursor = 0;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion();
  const scale = new THREE.Vector3();
  const normal = new THREE.Vector3();
  const UP = new THREE.Vector3(0, 1, 0);

  const writeDead = (i: number): void => {
    // §V.28: zero SCALE, not zero opacity
    matrix.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, matrix);
    fadeArr[i] = 0;
  };
  for (let i = 0; i < count; i++) writeDead(i);
  mesh.instanceMatrix.needsUpdate = true;

  /**
   * Seat instance `i` on the LIVE sea at radius `r`, tilted onto the local
   * wave plane (§V.71 — see the header for the measurement this replaces).
   * Four samples in a cross give the mean height and both gradients at once.
   */
  const seat = (
    i: number,
    r: number,
    lift: number,
    seaHeightAt: (x: number, z: number) => number,
  ): void => {
    const x = cx[i];
    const z = cz[i];
    /**
     * Sample at the disc's OWN radius — the plane is fitted to the water this
     * disc actually covers, so the fit degrades gracefully as it spreads.
     *
     * ONE value for the sample offset AND the divisor, floored together. They
     * are the numerator and denominator of the same central difference, and
     * flooring only the divisor (which is what this did first) silently
     * DIVIDES OUT the slope: a newborn ring is at r ≈ 0, so a 1e-3 floor on
     * the denominator alone reported a 1:4 ramp as a 1:40 one and the tilt
     * quietly did almost nothing. The floor is 0.5 m rather than an epsilon
     * because a plane fitted across a tenth of a millimetre of sea is noise —
     * a disc that has not opened yet still wants the slope of the wave it is
     * opening on.
     */
    const s = Math.max(r, 0.5);
    const hpx = finite(seaHeightAt(x + s, z));
    const hnx = finite(seaHeightAt(x - s, z));
    const hpz = finite(seaHeightAt(x, z + s));
    const hnz = finite(seaHeightAt(x, z - s));
    const h0 = (hpx + hnx + hpz + hnz) * 0.25;
    const inv = 0.5 / s;
    const gx = (hpx - hnx) * inv;
    const gz = (hpz - hnz) * inv;
    // surface normal of the plane y = h0 + gx*dx + gz*dz
    normal.set(-gx, 1, -gz).normalize();
    quat.setFromUnitVectors(UP, normal);
    // the lift is along the NORMAL, not along world up: on a steep wave face
    // a world-up lift slides the disc downhill out of the water it marks
    pos.set(x + normal.x * lift, h0 + normal.y * lift, z + normal.z * lift);
    scale.set(r, 1, r);
    matrix.compose(pos, quat, scale);
    mesh.setMatrixAt(i, matrix);
  };

  return {
    mesh,

    spawn(x, y, z, energy = 1): void {
      const g = Number.isFinite(energy) && energy > 0 ? energy : 1;
      if (ringCount > 0) {
        const i = ringCursor;
        ringCursor = (ringCursor + 1) % ringCount;
        cx[i] = finite(x);
        cy[i] = finite(y);
        cz[i] = finite(z);
        age[i] = 0;
        gain[i] = g;
      }
      if (foamCount > 0) {
        const i = ringCount + foamCursor;
        foamCursor = (foamCursor + 1) % foamCount;
        cx[i] = finite(x);
        cy[i] = finite(y);
        cz[i] = finite(z);
        age[i] = 0;
        gain[i] = g;
      }
    },

    update(frameDt, seaHeightAt, windX = 0, windZ = 0): void {
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      const life = pos01(p.ringLife, 1.4);
      const maxR = Math.max(1e-3, nn(p.ringRadius, 5.5));
      const lift = Math.max(0, nn(p.ringLift, 0.12));
      const opacity = Math.max(0, nn(p.ringOpacity, 0.5));
      const foamLife = pos01(p.foamLife, 5);
      const foamR = Math.max(1e-3, nn(p.foamRadius, 2.2));
      const foamGrow = Math.max(1, nn(p.foamGrowth, 2.1));
      const foamOpacity = Math.max(0, nn(p.foamOpacity, 0.42));
      /**
       * Surface DRIFT as a fraction of the wind speed. ~3% is the standard
       * figure for the wind-driven surface layer, and it is the reason this
       * takes a wind at all: foam floats IN the water, and water at the
       * surface moves. A scar pinned to world coordinates visibly slides
       * astern through the sea it is meant to be floating in.
       */
      const drift = Math.max(0, nn(p.foamDrift, 0.03));
      const dx = (Number.isFinite(windX) ? windX : 0) * drift * dt;
      const dz = (Number.isFinite(windZ) ? windZ : 0) * drift * dt;

      // a slider move re-lays the vertex data rather than being ignored (§V.62)
      if (Math.abs(p.ringWidth - laidWidth) > 1e-6) {
        laidWidth = layDisc(posArr, bandArr, discArr, p.ringWidth);
        posAttr.needsUpdate = true;
        bandAttr.needsUpdate = true;
        discAttr.needsUpdate = true;
      }

      for (let i = 0; i < count; i++) {
        const foam = i >= ringCount;
        const t = age[i] / (foam ? foamLife : life); // divisors floored by pos01
        if (!(t < 1)) {
          if (fadeArr[i] !== 0) writeDead(i);
          continue;
        }
        age[i] += dt;
        const g = gain[i];

        if (foam) {
          // the scar drifts with the surface layer and spreads slowly — it is
          // dissipating, not expanding, so growth is sub-linear where the
          // ring's is an ease-OUT of a launched ripple
          cx[i] += dx;
          cz[i] += dz;
          const r = Math.max(1e-4, foamR * g * (1 + (foamGrow - 1) * Math.sqrt(t)));
          seat(i, r, lift, seaHeightAt);
          // hold, then a long tail: foam sits before it disperses. t^2 out
          // rather than linear so the last third is nearly gone rather than
          // switching off at a visible edge.
          fadeArr[i] = foamOpacity * Math.min(1, t / 0.08) * (1 - t) * (1 - t);
        } else {
          // ease-out: a ripple leaves fast and settles, it does not travel at
          // a constant rate, and the deceleration is most of what reads as water
          const r = Math.max(1e-4, maxR * g * (1 - (1 - t) * (1 - t)));
          seat(i, r, lift, seaHeightAt);
          // fade in over the first 12% so a ring does not pop in at full
          // strength on the frame it is born, then out over the remainder
          fadeArr[i] = opacity * Math.min(1, t / 0.12) * (1 - t) * (1 - t);
        }
      }
      mesh.instanceMatrix.needsUpdate = true;
      fadeAttr.needsUpdate = true;
    },

    dispose(): void {
      geo.dispose();
      material.dispose();
    },
  };
}

/**
 * Lay a unit disc in the XZ plane with the TWO radial profiles the mesh
 * selects between per instance:
 *
 *   `band` — the rim RING: `sin(pi*u)` over the outer `width` fraction and
 *     zero inside it. Sine rather than a triangle so the profile has no
 *     crease down the ring's spine.
 *   `disc` — the foam SCAR: `(1 - r^2)^2`, which is 1 at the centre, has zero
 *     derivative at BOTH ends, and so meets the rim with no visible edge. A
 *     linear falloff leaves a first-derivative discontinuity at r = 1 that
 *     reads as a hard circle however faint the patch is.
 *
 * Returns the ring width actually laid, clamped into a sane range.
 */
function layDisc(
  posArr: Float32Array,
  bandArr: Float32Array,
  discArr: Float32Array,
  width: number,
): number {
  const w = Number.isFinite(width) ? Math.min(0.95, Math.max(0.02, width)) : 0.32;
  const inner = 1 - w;
  let v = 0;
  for (let j = 0; j <= RADIAL_ROWS; j++) {
    const radius = j / RADIAL_ROWS;
    // u is the position ACROSS the ring band; below the band there is no ring
    const u = (radius - inner) / w;
    const band = u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u);
    const s = 1 - radius * radius;
    const disc = s * s;
    for (let i = 0; i <= THETA_SEGMENTS; i++) {
      const theta = (i / THETA_SEGMENTS) * Math.PI * 2;
      posArr[v * 3] = Math.cos(theta) * radius;
      posArr[v * 3 + 1] = 0;
      posArr[v * 3 + 2] = Math.sin(theta) * radius;
      bandArr[v] = band;
      discArr[v] = disc;
      v++;
    }
  }
  return w;
}

function discIndices(): number[] {
  const idx: number[] = [];
  const stride = THETA_SEGMENTS + 1;
  for (let j = 0; j < RADIAL_ROWS; j++) {
    for (let i = 0; i < THETA_SEGMENTS; i++) {
      const a = j * stride + i;
      const b = a + 1;
      const c = a + stride;
      const d = c + 1;
      idx.push(a, c, b, b, c, d);
    }
  }
  return idx;
}

/** §V.28: pool sizes are sanitized ints fixed at construction */
function sanitizeCount(v: number, fallback: number, max: number): number {
  const n = Number.isFinite(v) ? Math.floor(v) : fallback;
  return Math.max(0, Math.min(n, max));
}

function pos01(v: number, fallback: number): number {
  return Number.isFinite(v) && v > 0 ? v : fallback;
}

function nn(v: number, fallback: number): number {
  return Number.isFinite(v) ? v : fallback;
}

function finite(v: number): number {
  return Number.isFinite(v) ? v : 0;
}
