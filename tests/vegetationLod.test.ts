/**
 * §T.112g VEGETATION LOD WITHOUT POP — impostor + cull guards.
 *
 * WHY EACH MATTERS.
 * - OCTAHEDRAL MAPPING. The atlas is addressed by view direction; if encode
 *   and decode are not exact inverses the runtime samples a tile baked from a
 *   different bearing and the plant is subtly the wrong shape from every angle
 *   at once — a bug that looks like "the trees are ugly", not like a bug.
 * - SILHOUETTE MATCH. The impostor replaces the mesh at one distance. If the
 *   tile cannot represent the silhouette the mesh draws THERE, the swap is a
 *   change of shape, and a change of shape in one frame IS the pop. The test
 *   is written so that a too-small tile fails it.
 * - CROSS-FADE. Monotone and summing to 1 at every distance: at no point may
 *   the plant be partly missing (that is the single-frame gap a naive swap
 *   leaves) or doubled.
 * - CULL. It must keep everything a camera can see. A cull that is merely
 *   "mostly right" deletes trees at the edge of the frame while you turn,
 *   which reads as worse than no cull at all. Shadows included: a caster
 *   behind the camera whose shadow is in frame has to survive.
 * - DETERMINISM (§V2): the buffer layout is a function of the placement, so
 *   the same island must always draw the same instances in the same order.
 *
 * GPU-free (§V88). What is NOT covered here is named in the report: the atlas
 * BAKE and the impostor material are renderer-side and unverified until the R3
 * lookdev pass; only their maths is pinned.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import {
  hemiOctDecode,
  hemiOctEncode,
  impostorAtlasLayout,
  impostorBounds,
  impostorFade,
  impostorFrameBlend,
  impostorFrameDirection,
  screenPixels,
  silhouetteCoverage,
} from '../src/vegetation/impostor';
import {
  buildCullCells,
  createInstanceCuller,
  cullCells,
  frustumPlanes,
  hiZLevel,
  hiZOccluded,
  sphereScreenBounds,
  sphereVisible,
  type CullInstance,
} from '../src/vegetation/cull';
import { buildPineGeometry } from '../src/vegetation/pineGeometry';
import { buildJuniperGeometry } from '../src/vegetation/juniperGeometry';
import { buildManzanitaGeometry } from '../src/vegetation/manzanitaGeometry';
import { planSierraVegetation } from '../src/vegetation/pineScatter';
import { generateIslandHeightmap } from '../src/island/heightmap';
import { generateSierraSites } from '../src/island/sierraSites';
import { siteParams } from '../src/island/archipelago';
import { islandParams } from '../src/params/island';
import { sierraParams } from '../src/params/sierra';

const SEED = 909;

// ── the octahedral mapping ────────────────────────────────────────────────

describe('§T.112g hemi-octahedral atlas addressing', () => {
  it('encode and decode are exact inverses over the upper hemisphere', () => {
    let worst = 0;
    for (let i = 0; i < 400; i++) {
      // deterministic spiral over the hemisphere — no rng in a test (§V2)
      const t = (i + 0.5) / 400;
      const y = t;
      const r = Math.sqrt(Math.max(1 - y * y, 0));
      const phi = i * 2.399963;
      const d: [number, number, number] = [r * Math.cos(phi), y, r * Math.sin(phi)];
      const [u, v] = hemiOctEncode(...d);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThanOrEqual(1);
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
      const back = hemiOctDecode(u, v);
      worst = Math.max(worst, Math.hypot(back[0] - d[0], back[1] - d[1], back[2] - d[2]));
    }
    expect(worst).toBeLessThan(1e-9);
  });

  it('the four corners ARE the four horizon bearings and the centre is the zenith', () => {
    // the reason to lay frames on grid VERTICES: a walking camera looks along
    // the horizon, and those views are captured rather than interpolated
    expect(hemiOctDecode(0.5, 0.5)[1]).toBeCloseTo(1, 9);
    for (const [u, v, x, z] of [
      [1, 0, 1, 0],
      [1, 1, 0, 1],
      [0, 1, -1, 0],
      [0, 0, 0, -1],
    ] as const) {
      const d = hemiOctDecode(u, v);
      expect(d[1]).toBeCloseTo(0, 9);
      expect(d[0]).toBeCloseTo(x, 9);
      expect(d[2]).toBeCloseTo(z, 9);
    }
  });

  it('frame blending is a partition of unity and is CONTINUOUS in the view direction', () => {
    const frames = sierraParams.impostorFrames;
    let maxJump = 0;
    let prev: number[] | null = null;
    for (let i = 0; i <= 360; i++) {
      // sweep the horizon, the bearing a walking player actually travels
      const a = (i / 360) * Math.PI * 2;
      const d: [number, number, number] = [Math.cos(a), 0.25, Math.sin(a)];
      const b = impostorFrameBlend(...d, frames);
      const w = [
        (1 - b.fu) * (1 - b.fv),
        b.fu * (1 - b.fv),
        (1 - b.fu) * b.fv,
        b.fu * b.fv,
      ];
      expect(w.reduce((s, x) => s + x, 0)).toBeCloseTo(1, 9);
      for (const x of w) expect(x).toBeGreaterThanOrEqual(0);
      // the blended DIRECTION must track the real one, or the impostor shows
      // the wrong bearing halfway between two frames
      const dirs = [
        impostorFrameDirection(b.col, b.row, frames),
        impostorFrameDirection(b.col + 1, b.row, frames),
        impostorFrameDirection(b.col, b.row + 1, frames),
        impostorFrameDirection(b.col + 1, b.row + 1, frames),
      ];
      const mixed = [0, 1, 2].map((k) => dirs.reduce((s, dd, j) => s + dd[k] * w[j], 0));
      const len = Math.hypot(...(mixed as [number, number, number]));
      const dot = (mixed[0] * d[0] + mixed[1] * d[1] + mixed[2] * d[2]) / (len * Math.hypot(...d));
      expect(dot).toBeGreaterThan(0.985);
      if (prev) {
        maxJump = Math.max(
          maxJump,
          Math.hypot(mixed[0] - prev[0], mixed[1] - prev[1], mixed[2] - prev[2]),
        );
      }
      prev = mixed;
    }
    // 1° of camera yaw may never move the sampled direction by a visible step:
    // a discontinuity here is a frame POP, which is what this task is about
    expect(maxJump).toBeLessThan(0.05);
  });
});

// ── the silhouette ────────────────────────────────────────────────────────

describe('§T.112g the impostor silhouette matches the mesh at the swap distance', () => {
  const pine = buildPineGeometry(SEED, 'pine', sierraParams);
  const bounds = impostorBounds(pine);
  const tile = sierraParams.impostorTile;
  const swap = sierraParams.impostorDistance;

  it('the quad contains the geometry from every frame in the atlas', () => {
    const pos = pine.getAttribute('position').array as Float32Array;
    let worst = 0;
    for (let row = 0; row < sierraParams.impostorFrames; row++) {
      for (let col = 0; col < sierraParams.impostorFrames; col++) {
        const f = impostorFrameDirection(col, row, sierraParams.impostorFrames);
        for (let i = 0; i < pos.length / 3; i++) {
          const x = pos[i * 3];
          const y = pos[i * 3 + 1] - bounds.centerY;
          const z = pos[i * 3 + 2];
          // distance from the view axis is what the ortho frame has to cover
          const along = x * f[0] + y * f[1] + z * f[2];
          const perp = Math.hypot(x - f[0] * along, y - f[1] * along, z - f[2] * along);
          worst = Math.max(worst, perp / bounds.radius);
        }
      }
    }
    // ≤ 1 means nothing is clipped; a clipped bake is a mismatched silhouette
    expect(worst).toBeLessThanOrEqual(1);
  });

  it('the tile resolves the silhouette AREA the mesh draws at the swap distance', () => {
    // how big the plant actually is on screen when the impostor takes over
    const px = screenPixels(bounds.radius * 2, swap, 50, 1440);
    expect(px).toBeGreaterThan(20);
    expect(px).toBeLessThan(tile); // the atlas is magnified there → §V48 needs no mips
    for (const dir of [
      [1, 0, 0],
      [0.7, 0.25, 0.7],
      [0, 0.5, 1],
    ] as [number, number, number][]) {
      const ref = silhouetteCoverage(pine, dir, bounds.radius, 512, bounds.centerY);
      const atTile = silhouetteCoverage(pine, dir, bounds.radius, tile, bounds.centerY);
      expect(ref).toBeGreaterThan(0.02);
      // a mismatch in coverage IS a mismatch in projected area at the swap:
      // both are measured over the same quad, so the ratio is the ratio of
      // areas the eye sees the instant the mesh is replaced
      expect(Math.abs(atTile - ref) / ref).toBeLessThan(0.08);
    }
  });

  it('and the test BITES: an 8 px tile misses the silhouette by more than the tolerance', () => {
    const dir: [number, number, number] = [1, 0, 0];
    const ref = silhouetteCoverage(pine, dir, bounds.radius, 512, bounds.centerY);
    const tiny = silhouetteCoverage(pine, dir, bounds.radius, 8, bounds.centerY);
    expect(Math.abs(tiny - ref) / ref).toBeGreaterThan(0.08);
  });

  it('a foot-centred quad would waste most of the tile — the pivot is why it does not', () => {
    const footRadius = (() => {
      const a = pine.getAttribute('position').array as Float32Array;
      let m = 0;
      for (let i = 0; i < a.length / 3; i++) {
        m = Math.max(m, Math.hypot(a[i * 3], a[i * 3 + 1], a[i * 3 + 2]));
      }
      return m;
    })();
    // the tight quad is smaller in AREA by the square of the ratio, i.e. the
    // same tile carries that many more texels of actual plant
    expect((footRadius / bounds.radius) ** 2).toBeGreaterThan(1.5);
  });
});

describe('§T.112g the cross-fade', () => {
  it('is monotone, complete, and sums to exactly 1 at every distance', () => {
    let prev = 0;
    for (let d = 0; d < sierraParams.impostorDistance + sierraParams.impostorFadeBand * 2; d += 2) {
      const f = impostorFade(d, sierraParams);
      expect(f.mesh + f.impostor).toBeCloseTo(1, 12);
      expect(f.impostor).toBeGreaterThanOrEqual(prev);
      prev = f.impostor;
    }
    expect(impostorFade(0, sierraParams)).toEqual({ mesh: 1, impostor: 0 });
    expect(impostorFade(sierraParams.impostorDistance, sierraParams).impostor).toBe(0);
    const end = sierraParams.impostorDistance + sierraParams.impostorFadeBand;
    expect(impostorFade(end, sierraParams).impostor).toBe(1);
    expect(impostorFade(end + 1000, sierraParams).impostor).toBe(1);
  });

  it('has no slope discontinuity at either end of the band', () => {
    const e = 0.25;
    const slope = (d: number): number =>
      (impostorFade(d + e, sierraParams).impostor - impostorFade(d - e, sierraParams).impostor) /
      (2 * e);
    // smoothstep: the derivative goes to 0 at both ends, so the fade does not
    // start or stop with a visible crease (§V.48b's lesson on crossed fades)
    expect(Math.abs(slope(sierraParams.impostorDistance))).toBeLessThan(1e-3);
    expect(
      Math.abs(slope(sierraParams.impostorDistance + sierraParams.impostorFadeBand)),
    ).toBeLessThan(1e-3);
  });
});

describe('§T.112g the atlas cost is bounded (§V17)', () => {
  it('four species fit in a VRAM budget the report can justify', () => {
    const l = impostorAtlasLayout(sierraParams.impostorFrames, sierraParams.impostorTile);
    expect(l.size).toBe(sierraParams.impostorFrames * sierraParams.impostorTile);
    expect(l.bytes).toBe(l.size * l.size * 4 * 2);
    const fourSpecies = l.bytes * 4;
    // the whole plant atlas set must stay under the seabed texture's order of
    // magnitude — it is standing VRAM paid whether or not a tree is on screen
    expect(fourSpecies).toBeLessThan(64 * 1024 * 1024);
    // eslint-disable-next-line no-console
    console.log(
      `[T112g impostor] ${l.frames}×${l.frames} frames @ ${l.tile}px = ${l.size}² atlas, ` +
        `${(l.bytes / 1024 / 1024).toFixed(1)} MB/species × 4 = ` +
        `${(fourSpecies / 1024 / 1024).toFixed(1)} MB`,
    );
  });
});

// ── the cull ──────────────────────────────────────────────────────────────

const cameraMvp = (
  camera: THREE.PerspectiveCamera,
  position: [number, number, number],
  lookAt: [number, number, number],
): Float32Array => {
  camera.position.set(...position);
  camera.lookAt(...lookAt);
  camera.updateMatrixWorld(true);
  camera.updateProjectionMatrix();
  const m = new THREE.Matrix4().multiplyMatrices(
    camera.projectionMatrix,
    camera.matrixWorldInverse,
  );
  return new Float32Array(m.elements);
};

describe('§T.112g the cull keeps everything the camera can see', () => {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 4000);

  it('a point in front survives and a point behind does not — on a REAL projection', () => {
    const mvp = cameraMvp(camera, [0, 2, 0], [0, 2, -100]);
    const planes = frustumPlanes(mvp);
    expect(sphereVisible(planes, 0, 2, -50, 0.1)).toBe(true);
    expect(sphereVisible(planes, 0, 2, 50, 0.1)).toBe(false);
    // …and a sphere straddling the edge is KEPT: the test is conservative in
    // the direction that cannot delete something visible
    expect(sphereVisible(planes, 0, 2, 5, 20)).toBe(true);
  });

  it('EVERY instance inside the frustum survives, and the ones outside are dropped', () => {
    const mvp = cameraMvp(camera, [0, 3, 120], [0, 3, 0]);
    const planes = frustumPlanes(mvp);
    const instances: CullInstance[] = [];
    for (let z = -200; z <= 200; z += 10) {
      for (let x = -200; x <= 200; x += 10) {
        instances.push({ x, y: 0, z, radius: 3, size: 8 });
      }
    }
    const { cells, order } = buildCullCells(instances, sierraParams.vegCullCellSize);
    const res = cullCells(cells, planes, 0, 3, 120, Infinity);
    const kept = new Set<number>();
    for (const ci of res.visible) {
      for (let k = cells[ci].start; k < cells[ci].start + cells[ci].count; k++) kept.add(order[k]);
    }
    let visibleInstances = 0;
    for (let i = 0; i < instances.length; i++) {
      const c = instances[i];
      if (!sphereVisible(planes, c.x, c.y, c.z, c.radius)) continue;
      visibleInstances++;
      // THE property: a cell cull may keep more than it must, never less
      expect(kept.has(i)).toBe(true);
    }
    expect(visibleInstances).toBeGreaterThan(50);
    // and it must actually drop something, or it is not a cull
    expect(res.culled).toBeGreaterThan(instances.length * 0.3);
    // eslint-disable-next-line no-console
    console.log(
      `[T112g cull] ${instances.length} instances in ${cells.length} cells → ` +
        `${res.instances} drawn, ${res.culled} culled ` +
        `(${((100 * res.culled) / instances.length).toFixed(0)}%)`,
    );
  });

  it('the partition is deterministic and loses nothing (§V2)', () => {
    const instances: CullInstance[] = [];
    for (let i = 0; i < 500; i++) {
      const a = i * 2.399963;
      const r = 5 + (i % 97) * 2;
      instances.push({ x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r, radius: 2, size: 1 + (i % 7) });
    }
    const a = buildCullCells(instances, 32);
    const b = buildCullCells(instances, 32);
    expect(Array.from(a.order)).toEqual(Array.from(b.order));
    expect(new Set(a.order).size).toBe(instances.length);
    let counted = 0;
    for (const c of a.cells) counted += c.count;
    expect(counted).toBe(instances.length);
    // largest-first inside a cell, so truncating a cell drops the least
    // readable plant first — the property `sortForLod` exists for
    for (const c of a.cells) {
      for (let k = c.start + 1; k < c.start + c.count; k++) {
        expect(instances[a.order[k]].size).toBeLessThanOrEqual(instances[a.order[k - 1]].size);
      }
    }
  });

  it('every instance stays inside its own cell sphere — nothing can leave its cull volume', () => {
    const instances: CullInstance[] = [];
    for (let i = 0; i < 300; i++) {
      instances.push({ x: (i % 20) * 9, y: (i % 5) * 3, z: Math.floor(i / 20) * 11, radius: 4, size: 1 });
    }
    const { cells, order } = buildCullCells(instances, 32);
    for (const c of cells) {
      for (let k = c.start; k < c.start + c.count; k++) {
        const it = instances[order[k]];
        const d = Math.hypot(it.x - c.x, it.y - c.y, it.z - c.z) + it.radius;
        expect(d).toBeLessThanOrEqual(c.radius + 1e-6);
      }
    }
  });
});

describe('§T.112g the culler compacts the real instance buffers', () => {
  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 4000);

  const buildMesh = (n: number): THREE.InstancedMesh => {
    const geo = buildJuniperGeometry(SEED, sierraParams);
    geo.setAttribute(
      'instancePhase',
      new THREE.InstancedBufferAttribute(Float32Array.from({ length: n }, (_, i) => i), 1),
    );
    const mesh = new THREE.InstancedMesh(geo, undefined, n);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const x = ((i % 20) - 10) * 12;
      const z = (Math.floor(i / 20) - 10) * 12;
      mesh.setMatrixAt(i, m.makeTranslation(x, 0, z));
    }
    mesh.instanceMatrix.needsUpdate = true;
    return mesh;
  };

  it('draws exactly the visible instances, and their matrices are the right ones', () => {
    const mesh = buildMesh(400);
    const before = new Float32Array(mesh.instanceMatrix.array as Float32Array);
    const wanted = new Set<string>();
    const culler = createInstanceCuller(mesh, {
      cellSize: 32,
      swayMargin: 1,
      attributes: ['instancePhase'],
    });
    const mvp = cameraMvp(camera, [0, 4, 200], [0, 4, 0]);
    const planes = frustumPlanes(mvp);
    for (let i = 0; i < 400; i++) {
      const o = i * 16;
      if (sphereVisible(planes, before[o + 12], before[o + 13], before[o + 14], 6)) {
        wanted.add(`${before[o + 12]},${before[o + 14]}`);
      }
    }
    const stats = culler.update(mvp, 0, 4, 200);
    expect(stats.drawn).toBe(mesh.count);
    expect(stats.drawn).toBeLessThan(400);
    expect(stats.drawn).toBeGreaterThan(0);
    const live = mesh.instanceMatrix.array as Float32Array;
    const drawn = new Set<string>();
    for (let i = 0; i < mesh.count; i++) drawn.add(`${live[i * 16 + 12]},${live[i * 16 + 14]}`);
    // every instance the frustum accepts is actually SUBMITTED, at its own
    // matrix — a compaction that shuffled the buffer would fail this
    for (const key of wanted) expect(drawn.has(key)).toBe(true);
  });

  it('re-uploads only when the visible SET changes — the reason cells are worth it', () => {
    const mesh = buildMesh(400);
    const culler = createInstanceCuller(mesh, { cellSize: 32, attributes: ['instancePhase'] });
    const mvp = cameraMvp(camera, [0, 4, 200], [0, 4, 0]);
    expect(culler.update(mvp, 0, 4, 200).uploaded).toBe(true);
    expect(culler.update(mvp, 0, 4, 200).uploaded).toBe(false);
    expect(culler.update(mvp, 0, 4, 200).uploaded).toBe(false);
    const turned = cameraMvp(camera, [0, 4, 200], [200, 4, 0]);
    expect(culler.update(turned, 0, 4, 200).uploaded).toBe(true);
  });

  it('the wind-phase attribute travels with its own instance', () => {
    const mesh = buildMesh(400);
    const srcPhase = new Float32Array(
      (mesh.geometry.getAttribute('instancePhase').array as Float32Array).slice(),
    );
    const srcMat = new Float32Array((mesh.instanceMatrix.array as Float32Array).slice());
    const byKey = new Map<string, number>();
    for (let i = 0; i < 400; i++) {
      byKey.set(`${srcMat[i * 16 + 12]},${srcMat[i * 16 + 14]}`, srcPhase[i]);
    }
    const culler = createInstanceCuller(mesh, { cellSize: 32, attributes: ['instancePhase'] });
    culler.update(cameraMvp(camera, [0, 4, 200], [0, 4, 0]), 0, 4, 200);
    const live = mesh.instanceMatrix.array as Float32Array;
    const phase = mesh.geometry.getAttribute('instancePhase').array as Float32Array;
    for (let i = 0; i < mesh.count; i++) {
      expect(phase[i]).toBe(byKey.get(`${live[i * 16 + 12]},${live[i * 16 + 14]}`));
    }
  });

  it('a caster behind the camera whose shadow is in frame is KEPT', () => {
    const mesh = buildMesh(400);
    const culler = createInstanceCuller(mesh, { cellSize: 32 });
    // stand IN the field looking one way, so half of it is behind the eye
    const mvp = cameraMvp(camera, [0, 4, 0], [0, 4, -100]);
    const without = culler.update(mvp, 0, 4, 0).drawn;
    expect(without).toBeLessThan(300);
    // a low sun BEHIND the camera throws the shadows of the plants behind you
    // forward, into the frame
    culler.setShadow([0, 0.3, 0.95], 120);
    const withShadow = culler.update(mvp, 0, 4, 0).drawn;
    expect(withShadow).toBeGreaterThan(without);
    // …and it is still a cull, not a surrender
    expect(withShadow).toBeLessThan(400);
  });

  it('reset submits everything again', () => {
    const mesh = buildMesh(400);
    const culler = createInstanceCuller(mesh, { cellSize: 32 });
    culler.update(cameraMvp(camera, [0, 4, 200], [0, 4, 0]), 0, 4, 200);
    culler.reset();
    expect(mesh.count).toBe(400);
  });
});

describe('§T.112g the hi-z maths (CPU mirror — the pyramid itself is browser-only)', () => {
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 4000);

  it('projects a sphere to a screen rectangle, and refuses to when it straddles the near plane', () => {
    const mvp = cameraMvp(camera, [0, 0, 100], [0, 0, 0]);
    const r = sphereScreenBounds(mvp, 0, 0, 0, 5, 0, 0, 100, 0.1);
    expect(r).not.toBeNull();
    expect(r!.minX).toBeGreaterThan(0.3);
    expect(r!.maxX).toBeLessThan(0.7);
    expect(r!.depth).toBeGreaterThan(-1);
    // a sphere around the eye has no bounded silhouette rectangle; the only
    // safe answer is "cannot cull" (§Rule 8 — do not guess)
    expect(sphereScreenBounds(mvp, 0, 0, 100, 5, 0, 0, 100, 0.1)).toBeNull();
  });

  it('picks a mip whose texel covers the rectangle, so the test is O(1) in object size', () => {
    expect(hiZLevel({ minX: 0, maxX: 1 / 1024, minY: 0, maxY: 1 / 1024 }, 1024)).toBe(0);
    expect(hiZLevel({ minX: 0, maxX: 0.25, minY: 0, maxY: 0.1 }, 1024)).toBe(8);
    expect(hiZLevel({ minX: 0, maxX: 1, minY: 0, maxY: 1 }, 1024)).toBe(10);
  });

  it('occludes only what is BEHIND everything already drawn over its footprint', () => {
    const size = 4;
    // A MAX-reduced level: a wall at 0.9 with one gap where nothing was drawn
    // (the far plane, 1.0). The gap is what an object can be SEEN THROUGH, so
    // it has to be the FARTHEST value, and taking the max is what notices it.
    // exactly representable in float32, so the strict comparison below is
    // testing the RULE and not a rounding artifact of 0.9
    const mip = new Float32Array(size * size).fill(0.75);
    mip[size + 1] = 1.0;
    const throughGap = { minX: 0.2, maxX: 0.45, minY: 0.2, maxY: 0.45 };
    const solid = { minX: 0.6, maxX: 0.9, minY: 0.6, maxY: 0.9 };
    // behind the wall, but its footprint includes the gap → still visible
    expect(hiZOccluded(mip, size, throughGap, 0.875)).toBe(false);
    // behind the wall with no gap in the footprint → occluded
    expect(hiZOccluded(mip, size, solid, 0.875)).toBe(true);
    // in FRONT of the wall → never occluded, whatever the footprint
    expect(hiZOccluded(mip, size, solid, 0.5)).toBe(false);
    expect(hiZOccluded(mip, size, throughGap, 0.5)).toBe(false);
    // exactly coplanar is not occluded: the test is strict, so a surface never
    // culls itself on a frame where it is the thing that drew the depth
    expect(hiZOccluded(mip, size, solid, 0.75)).toBe(false);
  });
});


// ── the measurement the report is built on ────────────────────────────────

describe('§T.112g before/after on a real slice island (§V17: reported, then bounded)', () => {
  const world = generateSierraSites(1337);
  // the BUSIEST slice island, picked by the stand it actually grows rather
  // than by footprint: habitat area, not radius, is what sets the count
  // (T112e's `sierraCandidates` integrates a density over the benches), so the
  // widest island is not always the one with the most plants
  const stands = world.order.map((i) => {
    const s = world.sites[i];
    const h = generateIslandHeightmap(s.seed, siteParams(s));
    return { site: s, hm: h, plan: planSierraVegetation(h, s.seed) };
  });
  const busiest = stands.reduce((a, b) => (b.plan.all.length > a.plan.all.length ? b : a));
  const site = busiest.site;
  const hm = busiest.hm;
  const plan = busiest.plan;
  const tris = (g: { getIndex(): { count: number } | null }): number =>
    (g.getIndex()?.count ?? 0) / 3;
  const pineTris = tris(buildPineGeometry(site.seed, 'pine', sierraParams));
  const juniperTris = tris(buildJuniperGeometry(site.seed + 577, sierraParams));
  const manzTris = tris(buildManzanitaGeometry(site.seed + 2311, sierraParams));

  const species = [
    { name: 'pine', list: plan.pines, tris: pineTris, radius: 8 },
    { name: 'juniper', list: plan.junipers, tris: juniperTris, radius: 4 },
    { name: 'manzanita', list: plan.manzanita, tris: manzTris, radius: 1.5 },
  ];

  const camera = new THREE.PerspectiveCamera(50, 16 / 9, 0.1, 4000);

  /**
   * What one island submits from a given eye, with and without T112g.
   * BEFORE = today: the whole batch, thinned only by `palmLodCount`'s ramp on
   * the distance to the island CENTRE. AFTER = frustum-culled by cell, with
   * everything past the fade band drawn as a 2-triangle impostor.
   */
  const measure = (
    eye: [number, number, number],
    lookAt: [number, number, number],
  ) => {
    const mvp = cameraMvp(camera, eye, lookAt);
    const planes = frustumPlanes(mvp);
    const centreDistance = Math.hypot(eye[0], eye[2]);
    let beforeTris = 0;
    let afterTris = 0;
    let beforeInstances = 0;
    let afterInstances = 0;
    let beforeDraws = 0;
    let afterDraws = 0;
    for (const sp of species) {
      const ramp = Math.max(
        0,
        Math.min(
          1,
          (islandParams.lodPalmCull - centreDistance) /
            Math.max(islandParams.lodPalmCull - islandParams.lodPalmFull, 1e-3),
        ),
      );
      const kept = Math.round(sp.list.length * ramp);
      beforeInstances += kept;
      beforeTris += kept * sp.tris;
      if (kept > 0) beforeDraws++;

      const instances: CullInstance[] = sp.list.map((c) => ({
        x: c.x,
        y: c.y,
        z: c.z,
        radius: sp.radius,
        size: c.scale,
      }));
      const { cells, order } = buildCullCells(instances, sierraParams.vegCullCellSize);
      const res = cullCells(cells, planes, eye[0], eye[1], eye[2], islandParams.lodPalmCull);
      let mesh = 0;
      let impostor = 0;
      for (const ci of res.visible) {
        const c = cells[ci];
        for (let k = c.start; k < c.start + c.count; k++) {
          const it = instances[order[k]];
          const d = Math.hypot(it.x - eye[0], it.y - eye[1], it.z - eye[2]);
          if (impostorFade(d, sierraParams).impostor >= 1) impostor++;
          else mesh++;
        }
      }
      afterInstances += mesh + impostor;
      afterTris += mesh * sp.tris + impostor * 2;
      if (mesh > 0) afterDraws++;
      if (impostor > 0) afterDraws++;
    }
    return { beforeTris, afterTris, beforeInstances, afterInstances, beforeDraws, afterDraws };
  };

  const stations: {
    name: string;
    eye: [number, number, number];
    lookAt: [number, number, number];
  }[] = [
    // in the middle of the stand, looking one way — the case three's own
    // frustum cull cannot touch, because the batch's bound IS the island
    { name: 'in the stand, looking one way', eye: [0, 12, 0], lookAt: [0, 8, -100] },
    // walking in from the landing, looking across the island
    { name: 'on the island, 60 m out', eye: [0, 12, 60], lookAt: [0, 4, 0] },
    { name: 'offshore, 300 m', eye: [0, 14, 300], lookAt: [0, 4, 0] },
    { name: 'offshore, 900 m', eye: [0, 14, 900], lookAt: [0, 4, 0] },
  ];

  it('reports draw calls, triangles and surviving instances at four stations', () => {
    const live = plan.all.length;
    // The bound is on the MEASUREMENT being worth making, not on the stand: if
    // T112e's placement ever collapses to a handful the numbers below stop
    // meaning anything, and this fails loudly rather than reporting a win that
    // came from an empty island (§Rule 8).
    expect(live).toBeGreaterThan(150);
    for (const s of stands) {
      // eslint-disable-next-line no-console
      console.log(
        `[T112g island] seed ${s.site.seed} R=${s.site.radius.toFixed(0)} m: ` +
          `${s.plan.pines.length} pine / ${s.plan.junipers.length} juniper / ` +
          `${s.plan.manzanita.length} manzanita = ${s.plan.all.length} live`,
      );
    }
    // eslint-disable-next-line no-console
    console.log(
      `[T112g island] busiest: R=${site.radius.toFixed(0)} m, grid ${hm.size}², ${live} live, ` +
        `${pineTris}/${juniperTris}/${manzTris} tris per pine/juniper/manzanita`,
    );
    for (const st of stations) {
      const m = measure(st.eye, st.lookAt);
      // eslint-disable-next-line no-console
      console.log(
        `[T112g island] ${st.name}: draws ${m.beforeDraws}→${m.afterDraws}, ` +
          `instances ${m.beforeInstances}→${m.afterInstances}, ` +
          `tris ${m.beforeTris.toLocaleString()}→${m.afterTris.toLocaleString()}`,
      );
    }
  });

  it('standing in the stand, the cull drops what is behind your head', () => {
    const m = measure([0, 12, 0], [0, 8, -100]);
    // nothing is thinned by distance here — the island centre IS the eye, so
    // the ramp keeps every instance and the whole stand is submitted today
    expect(m.beforeInstances).toBe(plan.all.length);
    // a 50° × 16:9 frustum sees under half the bearings; the cell granularity
    // gives some of that back, so the bar is "most of the far half", not "half"
    expect(m.afterInstances).toBeLessThan(m.beforeInstances * 0.7);
    expect(m.afterTris).toBeLessThan(m.beforeTris * 0.7);
  });

  it('at range the impostors carry the stand instead of deleting it', () => {
    const far = measure([0, 14, 900], [0, 4, 0]);
    // the OLD behaviour at 900 m: the ramp has thinned the stand to a fraction
    // of itself — trees vanishing as you sail away, the pop this task names
    expect(far.beforeInstances).toBeLessThan(plan.all.length * 0.7);
    // the NEW behaviour: every plant in frame is still THERE, at 2 triangles
    expect(far.afterInstances).toBe(plan.all.length);
    expect(far.afterTris).toBeLessThan(far.beforeTris * 0.1);
    expect(far.afterTris / far.afterInstances).toBeLessThanOrEqual(2);
  });
});
