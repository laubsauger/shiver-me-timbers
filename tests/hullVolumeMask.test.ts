/**
 * HULL VOLUME MASK (src/ocean/hullVolumeMask.ts; trailer review 2026-09-14, USER: "the water that crosses through the
 * whole boat … make sure it's masked out and can NEVER go through the boat and randomly fly into the camera where the
 * person is sitting. That immediately looks clippy and cheap.")
 *
 * WHY each test exists:
 *  - INSIDE at any pose: the depth cap it extends only worked for water below the sheer behind the lid; a heeled or
 *    pitched boat with a crest over the deck showed the sea plane through the cockpit. The volume must follow the full
 *    6DOF pose, so the same body points are tested under random rotations.
 *  - OUTSIDE never: a mask that reaches past the drawn shell cuts a dry moat into the sea at the waterline, which is
 *    the opposite artefact. Points just outside the render hull's surface (V bottom, flared topside, transom) must keep
 *    their water — this is what fails if the inset is dropped or the section is taken at the flared deck width all
 *    the way down.
 *  - THE COCKPIT: the well opening from the built GLB, the pilot's cockpit eye and head must be inside, or spray still
 *    reaches the lens and the sea still shows in the well.
 *  - SLOTS: a boat that stops drawing must not leave a hole in the sea where it was.
 */
import { readFileSync } from 'node:fs';
import * as THREE from 'three/webgpu';
import { describe, expect, it } from 'vitest';
import { cockpitEyeFallback } from '../src/camera/raceCamEye';
import {
  HULL_MASK_MAX,
  activeHullMask,
  createHullMask,
  hullMaskBoundRadius,
  hullMaskContains,
  hullMaskContainsBody,
  setActiveHullMask,
} from '../src/ocean/hullVolumeMask';
import { createSprayPool } from '../src/foam/sprayPool';
import { speedboatHullMaskShape } from '../src/speedboat/assets/waterMask';
import { HULL_DATA } from '../src/speedboat/hullMesh';

const shape = speedboatHullMaskShape();
const spec = HULL_DATA.spec;
const ro = (HULL_DATA as unknown as { renderOnly: { topsideFlareDeg: number; topsideFlareStartAboveChine: number } }).renderOnly;
const tanFlare = Math.tan((ro.topsideFlareDeg * Math.PI) / 180);

/** the render hull's outer half-width at hull-frame (z, y): the V to the chine, then the flared topside (hero_hull.py) */
function renderHalf(z: number, y: number): { half: number; keelY: number; deckY: number } {
  const st = HULL_DATA.stations;
  let j = 0;
  while (j < st.length - 2 && st[j + 1].z < z) j++;
  const a = st[j];
  const b = st[j + 1];
  const f = Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z)));
  const L = (k: 'keelY' | 'chineY' | 'chineHalfBeam') => a[k] + (b[k] - a[k]) * f;
  const keelY = L('keelY');
  const chineY = L('chineY');
  const c = L('chineHalfBeam');
  const yy = Math.min(y, a.deckY);
  const half = yy <= chineY ? (c * (yy - keelY)) / (chineY - keelY) : c + Math.max(0, yy - chineY - ro.topsideFlareStartAboveChine) * tanFlare;
  return { half, keelY, deckY: a.deckY };
}

/** hull frame → body frame (the boat object's origin is the CG) */
const body = (x: number, y: number, z: number): [number, number, number] => [x, y - spec.vcgAboveKeel, z - spec.lcgFromTransom];

/** deterministic unit quaternions spanning heel, trim and yaw well past anything a racing boat survives */
function poses(n: number): { pos: [number, number, number]; q: [number, number, number, number] }[] {
  let seed = 7;
  const rnd = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out: { pos: [number, number, number]; q: [number, number, number, number] }[] = [];
  for (let i = 0; i < n; i++) {
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler((rnd() - 0.5) * 1.6, rnd() * Math.PI * 2, (rnd() - 0.5) * 2.4, 'YXZ'));
    out.push({ pos: [(rnd() - 0.5) * 400, (rnd() - 0.5) * 6, (rnd() - 0.5) * 400], q: [q.x, q.y, q.z, q.w] });
  }
  return out;
}

const toWorld = (p: { pos: [number, number, number]; q: [number, number, number, number] }, b: [number, number, number]): [number, number, number] => {
  const v = new THREE.Vector3(...b).applyQuaternion(new THREE.Quaternion(...p.q));
  return [v.x + p.pos[0], v.y + p.pos[1], v.z + p.pos[2]];
};

describe('hull volume mask: inside the hull at any pose, never outside the drawn shell', () => {
  const P = poses(24);
  // stations from just forward of the transom to 90 % of the keel, heights keel → sheer → column
  const zs = [0.2, 1, 2.5, 4, 5.5, 7, 8.5, 9.5, 10.4];

  it('points inside the render hull (≥ 2·inset in from the surface) and in the column over the deck are masked at every pose', () => {
    let tested = 0;
    for (const z of zs) {
      const { keelY, deckY } = renderHalf(z, 0);
      for (const fy of [0.15, 0.35, 0.6, 0.85, 1]) {
        const y = keelY + (deckY - keelY) * fy;
        const { half } = renderHalf(z, y);
        const xIn = half - 2 * shape.inset;
        if (xIn <= 0) continue;
        for (const x of [0, xIn * 0.5, xIn, -xIn]) {
          for (const p of P) expect(hullMaskContains(shape, p.pos, p.q, toWorld(p, body(x, y, z))), `z ${z} y ${y.toFixed(2)} x ${x.toFixed(2)}`).toBe(true);
          tested++;
        }
      }
      // the column: over the deck up to just under its top
      const { half } = renderHalf(z, deckY);
      for (const dy of [0.05, 0.6, shape.columnHeight - 0.05]) {
        for (const p of P) expect(hullMaskContains(shape, p.pos, p.q, toWorld(p, body(half - 2 * shape.inset, deckY + dy, z)))).toBe(true);
        tested++;
      }
    }
    expect(tested).toBeGreaterThan(150);
  });

  it('points just OUTSIDE the render hull keep their water at every pose (no dry moat): V bottom, flared topside, transom, stem, column top', () => {
    const outside: [number, number, number][] = [];
    for (const z of zs) {
      const { keelY, deckY } = renderHalf(z, 0);
      for (const fy of [0.05, 0.3, 0.6, 0.9, 1]) {
        const y = keelY + (deckY - keelY) * fy;
        const { half } = renderHalf(z, y);
        outside.push(body(half + 0.005, y, z), body(-(half + 0.005), y, z));
      }
      outside.push(body(0, keelY - 0.01, z)); // under the keel
      outside.push(body(0, deckY + shape.columnHeight + 0.01, z)); // over the column
    }
    outside.push(body(0, 0.8, -0.01), body(0.5, 0.3, -0.5)); // aft of the transom (the outboards' water)
    outside.push(body(0, 1.25, HULL_DATA.stations[HULL_DATA.stations.length - 1].z + 0.05)); // ahead of the forefoot
    for (const b of outside) for (const p of poses(24)) expect(hullMaskContains(shape, p.pos, p.q, toWorld(p, b)), `body ${b.map((v) => v.toFixed(2))}`).toBe(false);
  });

  it('the inset is what keeps the waterline: with no inset, points ON the drawn V bottom and topside are masked', () => {
    // mutation check for the test above: the surface itself must sit outside the mask only because of the margin
    const flush = { ...shape, inset: 0 };
    const { half } = renderHalf(4, 0.45);
    expect(hullMaskContainsBody(shape, half - 0.001, 0.45 - spec.vcgAboveKeel, 4 - spec.lcgFromTransom)).toBe(false);
    expect(hullMaskContainsBody(flush, half - 0.001, 0.45 - spec.vcgAboveKeel, 4 - spec.lcgFromTransom)).toBe(true);
  });

  it('the bounding sphere the shader rejects with contains every masked point', () => {
    const r = hullMaskBoundRadius(shape);
    for (let z = -4; z < 9; z += 0.25)
      for (let y = -1.2; y < 2.2; y += 0.1)
        for (let x = -1.3; x <= 1.3; x += 0.1) if (hullMaskContainsBody(shape, x, y, z)) expect(Math.hypot(x, y, z)).toBeLessThan(r);
  });
});

describe('hull volume mask: the cockpit is inside', () => {
  const glb = readFileSync(new URL('../assets/models/speedboat_hero.glb', import.meta.url));
  const json = JSON.parse(glb.subarray(20, 20 + glb.readUInt32LE(12)).toString()) as { scenes: { nodes: number[] }[]; nodes: { extras?: Record<string, unknown> }[] };
  const extras = json.nodes[json.scenes[0].nodes[0]].extras as Record<string, unknown>;
  const well = JSON.parse(String(extras.waterMask)) as { y: number; soleY: number; outline: [number, number][] };

  it('the built GLB agrees with the mask on the frame: sheer and transom', () => {
    expect(Math.abs(well.y - shape.deckY)).toBeLessThan(0.005);
    expect(Math.abs((extras.sternZ as number) - shape.sternZ)).toBeLessThan(0.005);
  });

  it('every point of the well opening, from the sole to the pilot\'s head, and the cockpit eye are masked', () => {
    for (const [x, z] of well.outline) {
      // the outline is the lip's OUTER edge + 2 cm; the well walls are inboard of it
      for (const y of [well.soleY + 0.02, (well.soleY + well.y) / 2, well.y + 0.01, well.y + 0.63, well.y + 0.95]) {
        expect(hullMaskContainsBody(shape, x, y, z), `well x ${x} y ${y.toFixed(2)} z ${z}`).toBe(true);
      }
    }
    const [ex, ey, ez] = cockpitEyeFallback();
    expect(hullMaskContainsBody(shape, ex, ey, ez), 'cockpit eye').toBe(true);
    expect(hullMaskContainsBody(shape, ex, ey + 0.3, ez), 'top of the pilot\'s head').toBe(true);
  });
});

describe('hull volume mask: slots follow the boats that draw', () => {
  const at = (x: number): THREE.Vector3 => new THREE.Vector3(x, 0, 0);
  const q = new THREE.Quaternion();

  it('a new render call forgets last call\'s boats; beyond MAX boats the nearest to the lens win', () => {
    const m = createHullMask();
    m.setShape(shape);
    for (let i = 0; i < HULL_MASK_MAX + 1; i++) m.claim(1, at(i * 10), q, 100 - i); // the 9th (nearest) evicts the farthest
    const xs = m.data.slice(0, HULL_MASK_MAX).map((v) => v.x);
    expect(xs).toContain(80);
    expect(xs).not.toContain(0);
    m.claim(2, at(5), q, 1); // next call: one boat drew
    expect(m.data.slice(0, HULL_MASK_MAX).filter((v) => v.w > 0.5).length).toBe(1);
  });

  it('an upload with no boat drawn since the last one uploads no boat (a hidden hull leaves no hole in the sea)', () => {
    const m = createHullMask();
    m.setShape(shape);
    m.claim(1, at(3), q, 5);
    (m.node as unknown as { value: Float32Array }).value = new Float32Array(4 * m.data.length); // the buffer a build allocates
    (m.node as unknown as { update(f: unknown): void }).update({});
    expect(m.data[0].w).toBe(1);
    expect((m.node as unknown as { value: Float32Array }).value[3], 'the pose reached the uploaded buffer').toBe(1);
    (m.node as unknown as { update(f: unknown): void }).update({});
    expect(m.data[0].w).toBe(0);
  });

  it('opt-in: a spray pool built without an active mask has no mask node; with one it has', () => {
    expect(activeHullMask()).toBeUndefined();
    expect(createSprayPool(16).mesh.material.maskNode ?? null).toBeNull();
    setActiveHullMask(createHullMask());
    try {
      expect((createSprayPool(16).mesh.material as unknown as { maskNode: unknown }).maskNode).not.toBeNull();
    } finally {
      setActiveHullMask(undefined);
    }
  });
});
