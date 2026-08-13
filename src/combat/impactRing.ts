/**
 * The expanding ring a cannonball leaves on the sea (§T.16 water entry).
 *
 * ── WHY THIS IS GEOMETRY AND NOT A SHADER RING ─────────────────────────
 * The obvious build is a quad with `smoothstep` on a radial coordinate. That
 * is a procedural periodic-ish EDGE on a spatial coordinate, which §V.48
 * requires be band-limited against the FEATURE's own width plus the §V.48b
 * fade — and the §V.48 ratchet is at BASELINE 176 with zero headroom by
 * design, so the commit that adds an unfiltered edge is the commit that
 * fails. Here the annulus is real geometry and the cross-section profile is
 * a per-vertex attribute interpolated across triangles: a varying cannot
 * alias, and the outline is geometric coverage, which is the one thing MSAA
 * genuinely does resolve (§B.45). Zero new edges, and no browser needed to
 * defend it.
 *
 * The cost of that choice is that ring THICKNESS lives in the vertex data
 * rather than in a uniform. A construction-time-only thickness would be a
 * dead knob, and this project produces those faster than it finds them
 * (§V.62, ten occurrences) — so `update` re-lays the two attributes in place
 * when `ringWidth` moves. Same vertex count, same buffers, no reallocation,
 * and it only runs on the frame the slider actually changes.
 *
 * ── THICKNESS IS A RATIO, NOT METRES (§V.66) ───────────────────────────
 * `ringWidth` is a fraction of the ring's own radius, so the annulus
 * broadens as it expands — which is what a real ripple does, and which
 * scales the feature by its own dimension instead of against an absolute
 * metre value that silently changes meaning when `ringRadius` moves.
 *
 * §V.28: a dead ring is written at EXACTLY zero scale, never zero opacity —
 * an invisible-but-rasterized quad is the same fill-rate bill for nothing.
 */
import * as THREE from 'three/webgpu';
import { attribute, instancedBufferAttribute, vec3 } from 'three/tsl';
import type { CombatFxParams } from '../params/combat';

/** ring segments around, and rows across the annulus (the profile's smoothness) */
const THETA_SEGMENTS = 48;
const RADIAL_ROWS = 6;

/** sea foam, §V.31 sRGB through THREE.Color */
const RING_TINT = /*@__PURE__*/ new THREE.Color(0xdff0ec);

export interface ImpactRings {
  mesh: THREE.Object3D;
  /** start a ring at a world point (called once per water entry) */
  spawn(x: number, y: number, z: number): void;
  /**
   * Advance and refresh. `seaHeightAt` re-seats each live ring on the LIVE
   * surface every frame — a ring pinned to its birth height sinks into the
   * next crest, and the sea moves metres under it inside its own lifetime.
   */
  update(dt: number, seaHeightAt: (x: number, z: number) => number): void;
  dispose(): void;
}

export function createImpactRings(p: CombatFxParams): ImpactRings {
  const count = sanitizeCount(p.ringCount, 24, 64);

  const geo = new THREE.BufferGeometry();
  const vertexCount = (THETA_SEGMENTS + 1) * (RADIAL_ROWS + 1);
  const posArr = new Float32Array(vertexCount * 3);
  const bandArr = new Float32Array(vertexCount);
  const posAttr = new THREE.BufferAttribute(posArr, 3);
  const bandAttr = new THREE.BufferAttribute(bandArr, 1);
  let laidWidth = layAnnulus(posArr, bandArr, p.ringWidth);
  geo.setAttribute('position', posAttr);
  geo.setAttribute('band', bandAttr);
  geo.setIndex(annulusIndices());
  // instances sit anywhere in the world at any scale; the unit-radius bound
  // three would compute means nothing, so skip culling entirely (24 rings)
  geo.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1);

  const fadeArr = new Float32Array(count);
  const fadeAttr = new THREE.InstancedBufferAttribute(fadeArr, 1);
  fadeAttr.setUsage(THREE.DynamicDrawUsage);

  const material = new THREE.MeshBasicNodeMaterial();
  // Colour is a FLAT tint; the cross-section profile and the age fade both
  // drive OPACITY. Fading the colour instead would turn the ring grey as it
  // died rather than thinning it — foam gets sparser, it does not get darker.
  material.colorNode = vec3(RING_TINT.r, RING_TINT.g, RING_TINT.b);
  material.opacityNode = instancedBufferAttribute(fadeAttr, 'float')
    .mul(attribute('band', 'float'));
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
  age.fill(2); // whole pool starts dead
  let cursor = 0;

  const matrix = new THREE.Matrix4();
  const pos = new THREE.Vector3();
  const quat = new THREE.Quaternion(); // identity: the annulus is already flat
  const scale = new THREE.Vector3();

  const writeDead = (i: number): void => {
    // §V.28: zero SCALE, not zero opacity
    matrix.makeScale(0, 0, 0);
    mesh.setMatrixAt(i, matrix);
    fadeArr[i] = 0;
  };
  for (let i = 0; i < count; i++) writeDead(i);
  mesh.instanceMatrix.needsUpdate = true;

  return {
    mesh,

    spawn(x, y, z): void {
      if (count === 0) return;
      const i = cursor;
      cursor = (cursor + 1) % count;
      cx[i] = finite(x);
      cy[i] = finite(y);
      cz[i] = finite(z);
      age[i] = 0;
    },

    update(frameDt, seaHeightAt): void {
      const dt = Number.isFinite(frameDt) ? Math.max(0, Math.min(frameDt, 0.25)) : 0;
      const life = pos01(p.ringLife, 1.4);
      const maxR = Math.max(1e-3, nn(p.ringRadius, 5.5));
      const lift = Math.max(0, nn(p.ringLift, 0.12));
      const opacity = Math.max(0, nn(p.ringOpacity, 0.5));

      // a slider move re-lays the vertex data rather than being ignored (§V.62)
      if (Math.abs(p.ringWidth - laidWidth) > 1e-6) {
        laidWidth = layAnnulus(posArr, bandArr, p.ringWidth);
        posAttr.needsUpdate = true;
        bandAttr.needsUpdate = true;
      }

      for (let i = 0; i < count; i++) {
        const t = age[i] / Math.max(life, 1e-4); // floored divisor (§V.28)
        if (!(t < 1)) {
          if (fadeArr[i] !== 0) writeDead(i);
          continue;
        }
        age[i] += dt;
        // ease-out: a ripple leaves fast and settles, it does not travel at
        // a constant rate, and the deceleration is most of what reads as water
        const r = maxR * (1 - (1 - t) * (1 - t));
        const h = seaHeightAt(cx[i], cz[i]);
        pos.set(cx[i], (Number.isFinite(h) ? h : cy[i]) + lift, cz[i]);
        scale.set(Math.max(1e-4, r), 1, Math.max(1e-4, r));
        matrix.compose(pos, quat, scale);
        mesh.setMatrixAt(i, matrix);
        // fade in over the first 12% so a ring does not pop in at full
        // strength on the frame it is born, then out over the remainder
        fadeArr[i] = opacity * Math.min(1, t / 0.12) * (1 - t) * (1 - t);
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
 * Lay an annulus of unit outer radius in the XZ plane, with a per-vertex
 * `band` giving the cross-section profile: 0 at both edges, 1 in the middle.
 * `sin(pi*u)` rather than a triangle so the profile has no crease down the
 * ring's spine. Returns the width actually laid, clamped into a sane range.
 */
function layAnnulus(posArr: Float32Array, bandArr: Float32Array, width: number): number {
  const w = Number.isFinite(width) ? Math.min(0.95, Math.max(0.02, width)) : 0.32;
  const inner = 1 - w;
  let v = 0;
  for (let j = 0; j <= RADIAL_ROWS; j++) {
    const u = j / RADIAL_ROWS;
    const radius = inner + w * u;
    const band = Math.sin(Math.PI * u);
    for (let i = 0; i <= THETA_SEGMENTS; i++) {
      const theta = (i / THETA_SEGMENTS) * Math.PI * 2;
      posArr[v * 3] = Math.cos(theta) * radius;
      posArr[v * 3 + 1] = 0;
      posArr[v * 3 + 2] = Math.sin(theta) * radius;
      bandArr[v] = band;
      v++;
    }
  }
  return w;
}

function annulusIndices(): number[] {
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
