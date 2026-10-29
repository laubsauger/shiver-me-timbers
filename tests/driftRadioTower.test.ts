/**
 * The radio tower on the high island (src/drift/wandering/radioTower.ts), the film's first sunken-world cue. What it
 * must keep true, whatever the tower is tuned to: the beacon is a pure function of the sea's clock (renders draw lanes
 * in any order) and flashes as an aviation light does; the light it adds does not change with the resolution it is
 * drawn at (a point floored to a pixel or two at a 2K master is a smaller, brighter one at 8K, never more light); the
 * mast stands on the highest ground, sunk into it, its guys each running down to their own anchor in the slope; its
 * solid antenna stack hides the lattice inside it (the 2026-10-29 round's change for legibility); the lattice and the
 * guys are drawn by minimum width with BLENDED coverage (no hashed dither: that steps with the frame
 * counter — a still eye would see it shimmer); and its three materials compile (real TSL codegen, no GPU).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { BEACON, TOWER, beaconLevel, buildRadioTower, coreProfile, lampAt, layTower, loadKit, nightStep, summitOf, type KitMast } from '../src/drift/wandering/radioTower';
import { THIN_AXIS_ATTRIBUTE } from '../src/core/minWidth';

/** a dome of a hill: 466 m at (100, −50), falling 0.25 m a metre (the high island's summit is that broad) */
const ground = (x: number, z: number): number => 466 - 0.25 * Math.hypot(x - 100, z + 50);
const site = { ground, at: [100, -50] as [number, number], toward: [100 + 5300, -50 + 5600] as [number, number] };
/** the kit's own numbers (radio_tower.py: guys at 30/60/90 m on legs at π, ±π/3; the beacon on the cap) */
const KIT: KitMast = {
  heightAboveWater: 104.12,
  legAzimuths: [Math.PI, Math.PI / 3, -Math.PI / 3],
  guys: [30, 60, 90].flatMap((y) => [
    { leg: 0, at: [-3.4856, y - 0.3, 0] as [number, number, number] },
    { leg: 1, at: [1.7428, y - 0.3, 3.0187] as [number, number, number] },
    { leg: 2, at: [1.7428, y - 0.3, -3.0187] as [number, number, number] },
  ]),
  lamp: [0, 96.33, 0],
};

describe('the beacon', () => {
  it('is a pure function of the clock: any order of frames gives the same lamp', () => {
    const ts = Array.from({ length: 200 }, (_, i) => 380 + i * 0.0337);
    const forward = ts.map(beaconLevel);
    const backward = [...ts].reverse().map(beaconLevel).reverse();
    expect(backward).toEqual(forward);
  });

  it('flashes as an L-864 does: 20–40 a minute, lit about half of each cycle', () => {
    const perMinute = BEACON.hz * 60;
    expect(perMinute).toBeGreaterThanOrEqual(20);
    expect(perMinute).toBeLessThanOrEqual(40);
    const period = 1 / BEACON.hz;
    for (const t of [0.1, 3.7, 412.25]) expect(beaconLevel(t + period)).toBeCloseTo(beaconLevel(t), 6);
    let lit = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) lit += beaconLevel((i / n) * period);
    expect(lit / n).toBeGreaterThan(0.4);
    expect(lit / n).toBeLessThan(0.6);
    // (and it goes fully dark between flashes: a blink, not a pulse)
    expect(Math.min(...Array.from({ length: 100 }, (_, i) => beaconLevel(((i + 0.5) / 100) * period)))).toBe(0);
  });

  /** ∫ peak · profile over a disc of angular radius R (rad), numerically: the light a drawn point adds (scene units) */
  const lightOf = (peak: number, R: number, profile: (rho: number) => number): number => {
    let sum = 0;
    const N = 800;
    for (let i = 0; i < N; i++) {
      const rho = (i + 0.5) / N;
      sum += profile(rho) * 2 * Math.PI * rho * (1 / N);
    }
    return peak * sum * R * R;
  };
  const glowProfile = (rho: number): number => (1 - rho * rho) ** 3;

  it('draws the glow from the air\'s scattered light, the same light at any size (a few mrad, any master)', () => {
    const a = lightOf(lampAt(2000, 0.407, 7630, 0.5e-3, 1.5e-3).glow, 1.5e-3, glowProfile);
    const b = lightOf(lampAt(2000, 0.407, 7630, 0.5e-3, 4e-3).glow, 4e-3, glowProfile);
    expect(b).toBeCloseTo(a, 18);
    // (and never more than the haze took out of the beam: a share of (1 − T) of what left the lamp)
    const direct = lightOf(lampAt(2000, 0.407, 7630, 1e-6, 1e-3).core, 1e-6, coreProfile);
    expect(a).toBeLessThan((direct / 0.407) * (1 - 0.407));
  });

  it('shows the core at the eye\'s brightness where pixels are coarser than the eye: a 4K pixel no dimmer than an 8K one', () => {
    // (the dusk round: kept to its energy, a 4K pixel diluted the lamp to +1 level against the afterglow)
    const k4 = lampAt(2000, 0.407, 7630, 0.77e-3, 2e-3).core;
    const k8 = lampAt(2000, 0.407, 7630, 0.38e-3, 2e-3).core;
    expect(k4).toBeCloseTo(k8, 12);
    // and where the drawn point is finer than the eye's cell it keeps exactly its own light, no more
    const f1 = lightOf(lampAt(2000, 0.407, 7630, 0.05e-3, 2e-3).core, 0.05e-3, coreProfile);
    const f2 = lightOf(lampAt(2000, 0.407, 7630, 0.02e-3, 2e-3).core, 0.02e-3, coreProfile);
    expect(f2).toBeCloseTo(f1, 18);
    expect(lightOf(k4, 0.77e-3, coreProfile)).toBeGreaterThan(f1);
  });

  it('steps down only in the dark: full at dusk (horizon log10 −1.2), stepped in the night (−7.3), red under AgX', () => {
    expect(nightStep(10 ** -1.2)).toBeCloseTo(1, 6);
    expect(nightStep(10 ** -7.3)).toBeLessThan(0.5);
    expect(nightStep(10 ** -7.3)).toBeGreaterThan(0.2);
    // (monotone through the dissolve's range: no flash on the way down)
    let last = 2;
    for (let x = -1; x >= -8; x -= 0.1) {
      const k = nightStep(10 ** x);
      expect(k).toBeLessThanOrEqual(last + 1e-12);
      last = k;
    }
  });
});

describe('the mast on the summit', () => {
  it('finds the highest ground', () => {
    // two hills: the higher one wins, to within the 2 m refinement
    const two = (x: number, z: number): number => Math.max(430 - 0.2 * Math.hypot(x - 600, z - 300), 466 - 0.25 * Math.hypot(x + 900, z + 410));
    const s = summitOf(two, [0, 0], 3600);
    expect(Math.hypot(s.x + 900, s.z + 410)).toBeLessThan(3);
    expect(s.y).toBeGreaterThan(465);
  });

  const lay = layTower(site, KIT);

  it('stands sunk into the ground at the summit, its tip TOWER.tip over it, the beacon at the cap', () => {
    expect(lay.foot[0]).toBe(100);
    expect(lay.foot[2]).toBe(-50);
    expect(lay.foot[1]).toBeLessThan(ground(100, -50));
    expect(KIT.heightAboveWater * lay.up).toBeCloseTo(TOWER.tip, 6);
    expect(lay.lamp[1] - lay.foot[1]).toBeGreaterThan(0.9 * TOWER.tip);
  });

  it('runs every guy from its lug down to its own leg\'s anchor, sunk in the slope', () => {
    expect(lay.guys).toHaveLength(9);
    for (const [i, g] of lay.guys.entries()) {
      const leg = KIT.guys[i].leg;
      const out = Math.hypot(g.to[0] - 100, g.to[2] + 50);
      expect(out).toBeCloseTo(TOWER.anchorRadius, 6);
      expect(g.to[1]).toBeLessThan(ground(g.to[0], g.to[2]));
      expect(g.to[1]).toBeLessThan(g.from[1]);
      // the three guys of a leg share its anchor
      const same = lay.guys.filter((_, j) => KIT.guys[j].leg === leg);
      for (const s of same) expect(Math.hypot(s.to[0] - g.to[0], s.to[2] - g.to[2])).toBeLessThan(1e-6);
      // and leave from that leg's side of the mast
      const lug = Math.atan2(g.from[2] - lay.foot[2], g.from[0] - lay.foot[0]);
      const anchor = Math.atan2(g.to[2] + 50, g.to[0] - 100);
      expect(Math.abs(Math.atan2(Math.sin(lug - anchor), Math.cos(lug - anchor)))).toBeLessThan(0.05);
    }
  });

  it('turns its first leg toward the beach, so the other two fan left and right behind the summit', () => {
    const g0 = lay.guys[0];
    const toAnchor = Math.atan2(g0.to[2] + 50, g0.to[0] - 100);
    const toBeach = Math.atan2(site.toward[1] + 50, site.toward[0] - 100);
    expect(Math.abs(Math.atan2(Math.sin(toAnchor - toBeach), Math.cos(toAnchor - toBeach)))).toBeLessThan(1e-6);
  });
});

/** real TSL codegen without a GPU device (the harness of sprayLightingShader.test.ts) */
function shaders(mesh: THREE.Object3D): { vertex: string; fragment: string } {
  const canvas = {
    width: 4, height: 4, style: {}, getContext: () => null,
    addEventListener: () => {}, removeEventListener: () => {},
    getRootNode: () => ({}), setAttribute: () => {},
  };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three's internal codegen harness
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = new THREE.Scene();
  builder.material = (mesh as THREE.Mesh).material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = builder.material;
  builder.build();
  return { vertex: builder.vertexShader, fragment: builder.fragmentShader };
}

describe('the kit, built', async () => {
  const bytes = readFileSync(new URL('../assets/models/course_radio_tower.glb', import.meta.url));
  const root = await loadKit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const group = new THREE.Group();
  const haze = uniform(new THREE.Color(0.6, 0.7, 0.8));
  const built = buildRadioTower(root, { ...site, haze, air: 8500 }, uniform(0), group);
  const byName = (n: string): THREE.Mesh => group.getObjectByName(n) as THREE.Mesh;

  it('reads the kit\'s own guys, legs and beacon (nine guys at three levels)', () => {
    expect(built.guys).toHaveLength(9);
    const levels = new Set(built.guys.map((g) => Math.round(g.from[1] - built.foot[1])));
    expect(levels.size).toBe(3);
  });

  it('draws the lattice by minimum width: nearly every vertex of it is on a member axis', () => {
    const axes = byName('drift-radio-tower-mast').geometry.getAttribute(THIN_AXIS_ATTRIBUTE);
    let claimed = 0;
    for (let i = 0; i < axes.count; i++) if (axes.getW(i) > 0) claimed++;
    expect(claimed / axes.count).toBeGreaterThan(0.85);
  });

  it('blends its coverage (never the frame-stepped hash) and writes no depth, mast and guys alike', () => {
    for (const n of ['drift-radio-tower-mast', 'drift-radio-tower-guys']) {
      const m = byName(n).material as THREE.NodeMaterial;
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(m.maskNode ?? null).toBeNull();
      expect(m.opacityNode).toBeTruthy();
    }
  });

  it('wraps the top in a solid antenna stack that hides the lattice inside it: depth written, drawn before the lattice', () => {
    const stack = byName('drift-radio-tower-antennas');
    const mast = byName('drift-radio-tower-mast');
    expect((stack.material as THREE.Material).depthWrite).toBe(true);
    expect(stack.renderOrder).toBeLessThan(mast.renderOrder);
    stack.geometry.computeBoundingBox();
    const box = stack.geometry.boundingBox!;
    expect(box.min.y).toBeCloseTo(TOWER.panels.from, 3);
    expect(box.max.y).toBeCloseTo(TOWER.panels.to, 3);
    // (wider than the lattice it wraps, and clear of the beacon on the cap)
    expect(box.max.x - box.min.x).toBeGreaterThan(TOWER.face);
    expect(TOWER.panels.to).toBeLessThan(built.lamp[1] - built.foot[1]);
  });

  it.each(['drift-radio-tower-mast', 'drift-radio-tower-antennas', 'drift-radio-tower-guys', 'drift-radio-tower-beacon'])('%s compiles', (n) => {
    // (the beacon is a one-instance InstancedMesh; without a device the harness cannot size an instance matrix
    // buffer, so its material is built on a plain quad — the graph under test is the material's)
    const mesh = byName(n);
    const { vertex, fragment } = shaders((mesh as THREE.InstancedMesh).isInstancedMesh ? new THREE.Mesh(mesh.geometry, mesh.material) : mesh);
    expect(vertex.length).toBeGreaterThan(100);
    expect(fragment.length).toBeGreaterThan(100);
  });
});
