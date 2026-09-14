/**
 * §T.199 SPEEDBOAT WATER EFFECTS READ STRONGLY (docs/wake/w7-speedboat-look.md).
 * USER: 'rooster tails are still pretty weak if visible at all. almost seems like they get rendered behind the ocean …
 * bow wake angle seems a bit round … not triangular enough … the water displacement / general 3D wake the boat does is
 * a bit weak. I know we built the plumbing but is it on? is it tuned down too hard?'
 *
 * WHY these tests, one per defect the browser measured:
 *  1. The ocean is a TRANSPARENT, DEPTH-WRITING mesh, and three sorts equal renderOrders back-to-front by each object's
 *     projected ORIGIN. A GPU particle pool's origin is the world origin, not its particles, so whenever the race was
 *     far from (0,0,0) the pool drew first and the sea painted over every droplet above it. The property: spray above
 *     the water draws after the ocean wherever the camera and the origin are; bubbles under it draw before.
 *  2. A rooster tail is thrown by the BLADE (its tip speed), not by the slipstream's axial excess — the old emitter's
 *     0.9 m/s launch stood 0.12 m tall. The plume must stand metres high at race rev/s, never exceed what the blade
 *     could throw, and not care how hard the prop pushes.
 *  3. Landed chine foam loses lateral momentum: its arms narrow downstream,
 *     unlike the gravity-wave Kelvin envelope. The prop lane stays inside it.
 *  4. The near-hull tier must draw what the 448 m tier's 2.5 m splat band-limits away, in the same compute group.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import RenderList from 'three/src/renderers/common/RenderList.js';
import surfaceMaterialSource from '../src/ocean/surfaceMaterial.ts?raw';
import oceanSurfaceSource from '../src/ocean/oceanSurface.ts?raw';
import { createBowSprayFleet } from '../src/foam/bowSpray';
import {
  ROOSTER_DROP_DRAG,
  createPropBubbles,
  createRoosterTail,
  roosterApexWithDrag,
  roosterFlightTime,
  roosterTailEmission,
} from '../src/foam/roosterTail';
import { waterlineSprayEmission } from '../src/foam/sprayMath';
import { sprayParams } from '../src/params/spray';
import { chineSheetFoamCpu, packChineSheet, propWashFoamCpu } from '../src/flowfoam/simFoam';
import { GRAVITY } from '../src/ocean/oceanMath';
import { MERCURY_450R } from '../src/sea-physics/engine';
import { propRpsEstimate, type PropWashInput } from '../src/wake/propWash';
import { SpeedboatTow } from '../src/wake/speedboatTow';
import { WAKE_SPEEDBOAT_NEAR_TIER, WAKE_SPEEDBOAT_TIER, measureWake, towPreset, type WakePreset } from '../src/wake/wakeCalibration';
import { WakeSim } from '../src/wake/wakeSim';
import { defaultSponge } from '../src/wake/wakeSolverMath';

function recorder() {
  const computes: unknown[][] = [];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const r: any = {
    compute: (n: unknown) => void computes.push(Array.isArray(n) ? n : [n]),
    render: () => {}, setRenderTarget: () => {}, getRenderTarget: () => null, getClearColor: () => {},
    getClearAlpha: () => 0, setClearColor: () => {}, clear: () => {},
  };
  return { r, computes };
}

describe('§T.199 1. spray above the water is drawn after the ocean, wherever the race is', () => {
  it('the ocean is the transparent, depth-writing mesh at the default renderOrder (the premise of the sort)', () => {
    expect(surfaceMaterialSource).toMatch(/material\.transparent = true;/);
    expect(surfaceMaterialSource).toMatch(/material\.depthWrite = true;/);
    expect(oceanSurfaceSource).not.toMatch(/renderOrder/);
  });

  /** three's transparent order for the ocean grid (camera-snapped) and the pools (origin at 0,0,0), as Renderer computes z */
  function transparentOrder(camPos: THREE.Vector3, look: THREE.Vector3, meshes: THREE.Object3D[]): THREE.Object3D[] {
    const camera = new THREE.PerspectiveCamera(55, 16 / 9, 0.1, 8000);
    camera.position.copy(camPos);
    camera.lookAt(look);
    camera.updateMatrixWorld();
    const proj = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const ocean = new THREE.Mesh(new THREE.PlaneGeometry(100, 100).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: true }));
    ocean.position.set(Math.round(camPos.x), 0, Math.round(camPos.z));
    ocean.updateMatrixWorld();
    const list = new RenderList({ getNode: () => ({}) } as never, new THREE.Scene() as never, camera as never);
    list.begin();
    const v = new THREE.Vector4();
    for (const o of [ocean, ...meshes]) {
      o.updateMatrixWorld();
      const m = o as THREE.Mesh;
      if ((o as THREE.Sprite).isSprite) v.setFromMatrixPosition(o.matrixWorld).applyMatrix4(proj);
      else {
        m.geometry.computeBoundingSphere();
        v.set(...m.geometry.boundingSphere!.center.toArray(), 1).applyMatrix4(o.matrixWorld).applyMatrix4(proj);
      }
      list.push(o as never, m.geometry as never, m.material as never, 0, v.z, null, null as never);
    }
    list.sort(null, null);
    return list.transparent.map((it) => ((it.object as unknown) === ocean ? oceanTag : (it.object as unknown as THREE.Object3D)));
  }
  const oceanTag = new THREE.Object3D();

  it('rooster drops + mist and the bow sheet after the ocean, prop bubbles before it — race 600 m from the origin, looking away from AND toward it', () => {
    const rooster = createRoosterTail({ maxJets: 24, count: 256 });
    const bow = createBowSprayFleet({ count: 256 });
    const bubbles = createPropBubbles({ count: 256 });
    const over = [...rooster.meshes, bow.mesh];
    for (const [cam, look] of [
      [new THREE.Vector3(620, 9, 130), new THREE.Vector3(600, 0, 120)], // origin far behind the boat: the T199 case
      [new THREE.Vector3(580, 9, 110), new THREE.Vector3(600, 0, 120)], // origin behind the camera
      [new THREE.Vector3(0, 30, 40), new THREE.Vector3(0, 0, 0)], // at the origin
    ] as const) {
      const order = transparentOrder(cam, look, [...over, bubbles.mesh]);
      const iOcean = order.indexOf(oceanTag);
      for (const m of over) expect(order.indexOf(m)).toBeGreaterThan(iOcean);
      expect(order.indexOf(bubbles.mesh)).toBeLessThan(iOcean);
    }
    // depth-TESTED against the sea it now follows (a droplet under a crest stays hidden), never depth-writing
    for (const m of [...over, bubbles.mesh]) {
      const mat = (m as THREE.Sprite).material as THREE.Material;
      expect(mat.depthTest).toBe(true);
      expect(mat.depthWrite).toBe(false);
    }
    // a dense plume occludes what is behind it: additive white over a bright sky or whitewater adds nothing
    for (const m of rooster.meshes) expect(((m as THREE.Sprite).material as THREE.Material).blending).toBe(THREE.NormalBlending);
  });
});

describe('§T.199 2. the rooster tail is thrown by the blade', () => {
  const RPS = 60;
  const jet = (over: Partial<PropWashInput> = {}): PropWashInput => ({
    x: 0, z: 0, dirX: -1, dirZ: 0, thrust: 6000, discArea: Math.PI * 0.2 * 0.2, depth: 0, advance: 30, immersion: 0.5, surfaceY: 0, propRps: RPS, ...over,
  });

  it('a half-in prop at race rev/s throws a plume METRES tall; never above what the blade tip could throw', () => {
    const e = roosterTailEmission(jet(), sprayParams);
    const tip = 2 * Math.PI * RPS * 0.2;
    expect(e.tip).toBeCloseTo(tip, 9);
    const apex = roosterApexWithDrag(e.launch, ROOSTER_DROP_DRAG);
    expect(apex).toBeGreaterThan(2.5);
    expect(apex).toBeLessThan((tip * tip) / (2 * GRAVITY));
    expect(e.launch).toBeLessThanOrEqual(tip);
    // drag lowers and shortens the arc relative to vacuum, and the flight time brings it back down
    expect(apex).toBeLessThan((e.launch * e.launch) / (2 * GRAVITY));
    expect(roosterFlightTime(e.launch, ROOSTER_DROP_DRAG)).toBeLessThan((2 * e.launch) / GRAVITY);
    expect(roosterFlightTime(e.launch, ROOSTER_DROP_DRAG)).toBeGreaterThan(e.launch / GRAVITY);
  });

  it('only a surface-PIERCING prop throws (buried or clear: nothing), and the throw is the blade\'s, not the thrust\'s', () => {
    const e = (over: Partial<PropWashInput>) => roosterTailEmission(jet(over), sprayParams);
    expect(e({ immersion: 1 }).rate).toBe(0);
    expect(e({ immersion: 0 }).rate).toBe(0);
    expect(e({ immersion: 0.5 }).rate).toBeGreaterThan(e({ immersion: 0.9 }).rate);
    expect(e({ thrust: 12000 }).launch).toBeCloseTo(e({}).launch, 9);
    expect(e({ propRps: 2 * RPS }).launch).toBeCloseTo(2 * e({}).launch, 9);
    expect(e({ x: Number.NaN }).rate).toBe(0);
  });

  it('a rival whose record carries no rev/s is estimated from its jet within 25% of the engine at race speed', () => {
    for (const U of [30, 40]) {
      const tow = new SpeedboatTow(U, 1);
      tow.advanceTo(U * 5);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const engines = (tow as any).hw.engines as { propRps: number }[];
      tow.jets().forEach((j, k) => {
        expect(j.propRps).toBeCloseTo(engines[k].propRps, 9);
        const est = propRpsEstimate(j, MERCURY_450R.propPitch);
        expect(Math.abs(est / Math.abs(engines[k].propRps) - 1)).toBeLessThan(0.25);
      });
    }
  }, 120_000);
});

describe('3. landed chine foam has bounded lateral spread, with the prop lane inside', () => {
  /** accumulated sheet coverage in the hull frame (decay half-life 5 s, the near tier's), at (a m astern, y m outboard) */
  function vOf(U: number) {
    const tow = new SpeedboatTow(U, 1);
    tow.advanceTo(U * 5);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const hw = (tow as any).hw;
    const bow = waterlineSprayEmission({ waterline: hw.waterline, sections: hw.sections, stripZ: hw.mesh.strips.zCentre }, tow.pose.quaternion);
    const sheets = [{ bow, speed: U }];
    const cov = (a: number, y: number): number => {
      let c = 0;
      const dt = 0.5 / U;
      for (let t = 0; t < 12; t += dt) {
        const aa = a - U * t;
        if (aa < -5) break;
        c += chineSheetFoamCpu(sheets, bow.x - aa, bow.z + y, 0.234) * dt * Math.pow(2, -t / 5);
      }
      return Math.min(1, c);
    };
    const pts: [number, number][] = [];
    for (let a = 10; a <= 50; a += 5) {
      const prof: [number, number][] = [];
      let mx = 0;
      for (let y = 0; y <= 10; y += 0.1) {
        const c = cov(a, y);
        prof.push([y, c]);
        mx = Math.max(mx, c);
      }
      let edge = 0;
      for (const [y, c] of prof) if (c >= 0.5 * mx) edge = y;
      pts.push([a, edge]);
    }
    const n = pts.length;
    const mxA = pts.reduce((s, p) => s + p[0], 0) / n;
    const myA = pts.reduce((s, p) => s + p[1], 0) / n;
    let sxy = 0;
    let sxx = 0;
    let syy = 0;
    for (const [x, y] of pts) {
      sxy += (x - mxA) * (y - myA);
      sxx += (x - mxA) ** 2;
      syy += (y - myA) ** 2;
    }
    return { tow, bow, pts, deg: (Math.atan(sxy / sxx) * 180) / Math.PI, r2: (sxy * sxy) / (sxx * syy) };
  }

  for (const U of [25, 30, 40]) {
    it(`${U} m/s: the landed trail narrows within six metres either side at 50 m astern`, () => {
      const v = vOf(U);
      const nearEdge = v.pts[0][1];
      const farEdge = v.pts[v.pts.length - 1][1];
      expect(farEdge).toBeLessThan(6);
      expect(farEdge - nearEdge).toBeLessThan(3);
      expect(farEdge).toBeGreaterThan(nearEdge);
      expect(packChineSheet(v.bow, U)).not.toBeNull();
      // the prop lane 50 m astern: rms half-width of the ribbon dose across the track, against the V edge there
      const jets = v.tow.jets();
      const fx = -1; // towed along +x: aft is −x
      let w = 0;
      let w2 = 0;
      for (let y = -12; y <= 12; y += 0.05) {
        const d = propWashFoamCpu(jets, v.tow.pose.position[0] + fx * 50, y, 0.234, true);
        w += d;
        w2 += d * y * y;
      }
      const laneHalf = Math.sqrt(w2 / Math.max(w, 1e-12));
      const vEdge50 = v.pts[v.pts.length - 1][1];
      expect(laneHalf).toBeLessThan(vEdge50);
    }, 300_000);
  }
});

describe('§T.199 4. the near-hull tier draws the short waves, in the SAME compute group', () => {
  it('one compute call carries both tiers\' dispatches; the single-tier sim keeps its single-solver call', () => {
    const two = new WakeSim(WAKE_SPEEDBOAT_TIER);
    expect(two.near).not.toBeNull();
    two.tick({ position: [0, 0, 0], quaternion: [0, 0, 0, 1], velocity: [0, 0, 30] }, [{ x: 0, z: 2, fy: 4e4, footprint: 0.3, depth: 0.2 }], 126, 1 / 60);
    // the near domain rides her stem, not the page's forward-pushed bowAhead
    const c = two.near!;
    expect(Math.abs(c.centerZ - (2 + 0.3 - (0.5 - c.sponge.width * 1.5) * c.domain))).toBeLessThanOrEqual(c.texel);
    const rec = recorder();
    two.step(rec.r);
    expect(rec.computes.length).toBe(1);
    expect(rec.computes[0].length).toBe(two.solver.computeNodes.length + c.computeNodes.length);
    two.dispose();
    const one = new WakeSim({ n: WAKE_SPEEDBOAT_TIER.n, texel: WAKE_SPEEDBOAT_TIER.texel });
    expect(one.near).toBeNull();
    one.tick({ position: [0, 0, 0], quaternion: [0, 0, 0, 1] }, [{ x: 0, z: 2, fy: 4e4, footprint: 0.3, depth: 0.2 }], 3, 1 / 60);
    const rec1 = recorder();
    one.step(rec1.r);
    expect(rec1.computes).toEqual([one.solver.computeNodes]);
    one.dispose();
  });

  it('the near domain stays on HER: a flying bow does not drag it aft, a respawn re-leads it, a stale far contact is not read', () => {
    const sim = new WakeSim(WAKE_SPEEDBOAT_TIER);
    const near = sim.near!;
    const lead = (0.5 - near.sponge.width * 1.5) * near.domain;
    const wet = (z0: number, stemZ: number) => [{ x: 0, z: z0 + stemZ, fy: 3e4, footprint: 0.3, depth: 0.2 }, { x: 0, z: z0 - 5, fy: 3e4, footprint: 0.3, depth: 0.2 }];
    const pose = (z: number) => ({ position: [0, 0, z], quaternion: [0, 0, 0, 1], velocity: [0, 0, 30] });
    let z = 0;
    const step = (samples: (zz: number) => { x: number; z: number; fy: number; footprint: number; depth: number }[]) => {
      z += 0.5;
      sim.tick(pose(z), samples(z), 126, 1 / 60);
    };
    for (let t = 0; t < 30; t++) step((zz) => wet(zz, 4));
    const settled = near.centerZ - z;
    expect(Math.abs(settled - (4.3 - lead))).toBeLessThanOrEqual(near.texel);
    // the bow lifts for 0.25 s: only the transom is wet — the domain walks aft at ≤ 2 m/s, not 9 m in a tick
    for (let t = 0; t < 15; t++) step((zz) => [wet(zz, 4)[1]]);
    expect(near.centerZ - z).toBeGreaterThan(settled - 0.5 - near.texel);
    // respawn 400 m away, the first tick still carrying the old contact: re-led from her own samples within a second
    z += 400;
    step((zz) => wet(zz - 400.5, 4));
    for (let t = 0; t < 60; t++) step((zz) => wet(zz, 4));
    expect(Math.abs(near.centerZ - z - (4.3 - lead))).toBeLessThanOrEqual(near.texel);
    sim.dispose();
  });

  /**
   * CPU tows of the contact hull at 30 m/s, 3 s at the game's tick: the near tier resolves the divergent waves and bow
   * lip next to the hull that the 448 m tier's σ ≥ 2.5 m splat removes — not a gain, the same sources on a finer grid.
   * Measured [M] (docs §3): 3 s tows p2t 0.039 → 0.156 m, slope 0.017 → 0.164; 8 s tows 0.023 → 0.242, 0.021 → 0.221.
   */
  it('30 m/s: near-hull peak-to-trough ≥ 3× and slope ≥ 5× the 448 m tier\'s, and a visible ≥ 0.1 m p2t', () => {
    const U = 30;
    const read = (tier: { n: number; texel: number }) => {
      const preset: WakePreset = { name: 'look', kind: 'speedboat', speed: U, n: tier.n, texel: tier.texel };
      const tow = towPreset(preset, { vessel: new SpeedboatTow(U, 1), duration: 3, dt: 1 / 60 });
      const s = tow.solver;
      s.step(0, { slope: true });
      const r = measureWake({ n: s.n, texel: s.texel, centerX: s.centerX, centerZ: s.centerZ, zeta: s.zeta }, tow.frame, tow.x, U);
      const interior = (0.5 - defaultSponge(s.n, s.texel).width) * s.n * s.texel;
      let slope = 0;
      for (let j = 0; j < s.n; j++) {
        for (let i = 0; i < s.n; i++) {
          const wx = s.centerX + (i - s.n / 2) * s.texel;
          const wz = s.centerZ + (j - s.n / 2) * s.texel;
          if (Math.abs(wx - s.centerX) > interior || Math.abs(wz - s.centerZ) > interior) continue;
          const dx = Math.max(0, wx - (tow.x + tow.frame.stem), tow.x + tow.frame.transom - wx);
          const dz = Math.max(0, Math.abs(wz) - tow.frame.halfBeam);
          const d = Math.hypot(dx, dz);
          if (d > 0.5 && d < 15) slope = Math.max(slope, Math.hypot(s.slopeX[j * s.n + i], s.slopeZ[j * s.n + i]));
        }
      }
      return { p2t: r.nearHullPeakToTrough, slope, clamp: r.clampHits };
    };
    const near = read(WAKE_SPEEDBOAT_NEAR_TIER);
    const far = read(WAKE_SPEEDBOAT_TIER);
    console.log('T199 near/far', JSON.stringify({ near, far }));
    expect(near.p2t).toBeGreaterThan(3 * far.p2t);
    expect(near.slope).toBeGreaterThan(5 * far.slope);
    expect(near.p2t).toBeGreaterThan(0.1);
    expect(near.clamp).toBe(0);
  }, 1_200_000);
});
