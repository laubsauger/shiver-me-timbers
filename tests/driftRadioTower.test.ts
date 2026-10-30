/**
 * The radio masts (src/radio/mast.ts, the builder the game will share) and The Drift's towers on every island
 * (src/drift/wandering/radioTower.ts). What must hold, whatever they are tuned to:
 *
 *   - a lamp is a pure function of its clock (renders draw lanes in any order), flashes as an aviation light does, and
 *     a dead one stays dark;
 *   - the light a lamp adds does not change with the size it is drawn at, except where the drawn point is coarser than
 *     the eye's own cell (the 2026-10-29 dusk round: kept to its energy a 4K pixel diluted it to nothing) — there it
 *     shows the eye's brightness, never more;
 *   - a mast stands sunk into its summit, its guys down to their own anchors (a self-supporting tower has none), and
 *     its lamp is where the beams are aimed before the kit has loaded;
 *   - the high island's station builds the tower exactly as reviewed;
 *   - every mast is drawn by minimum width with BLENDED coverage (no frame-stepped hash: a still eye would see it
 *     shimmer), a broadcast mast's solid stack hides the lattice inside it, and every material compiles (real TSL
 *     codegen, no GPU);
 *   - the film puts every station of the network on the Rose once, and the coast's stations on the coast.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import { KIT, MAST, beaconLevel, buildMast, coreProfile, kitMast, lampLight, lampOverFoot, layMast, loadMastKit, type KitMast } from '../src/radio/mast';
import { NETWORK, stationOf, type MastSpec } from '../src/radio/network';
import { FILM_COAST, FILM_RING, HIGH_SECOND, LUX_PER_UNIT, expAir, filmLamp, nightStep, ridgeSite, summitOf } from '../src/drift/wandering/radioTower';
import { THIN_AXIS_ATTRIBUTE } from '../src/core/minWidth';

const ALIVE = { alive: true, flashesPerMin: 36, phase: 0 };

describe('a mast\'s lamp', () => {
  it('is a pure function of the clock: any order of frames gives the same lamp', () => {
    const ts = Array.from({ length: 200 }, (_, i) => 380 + i * 0.0337);
    expect([...ts].reverse().map((t) => beaconLevel(t, ALIVE)).reverse()).toEqual(ts.map((t) => beaconLevel(t, ALIVE)));
  });

  it('flashes as an L-864 does: lit about half of each cycle, fully dark between; its phase shifts it', () => {
    const period = 60 / ALIVE.flashesPerMin;
    let lit = 0;
    const n = 10000;
    for (let i = 0; i < n; i++) lit += beaconLevel((i / n) * period, ALIVE);
    expect(lit / n).toBeGreaterThan(0.4);
    expect(lit / n).toBeLessThan(0.6);
    expect(Math.min(...Array.from({ length: 100 }, (_, i) => beaconLevel(((i + 0.5) / 100) * period, ALIVE)))).toBe(0);
    const shifted = { ...ALIVE, phase: 0.5 };
    expect(beaconLevel(0.3 * period, shifted)).toBeCloseTo(beaconLevel(0.8 * period, ALIVE), 9);
  });

  it('stays dark when dead', () => {
    for (const t of [0, 1.3, 431.86]) expect(beaconLevel(t, { ...ALIVE, alive: false })).toBe(0);
  });

  /** ∫ peak · profile over a disc of angular radius R (rad), numerically: the light a drawn point adds */
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
  const film = { eyeCell: 0.12e-3, glow: { share: 0.5, radius: 1.5e-3 } };

  it('draws the glow from the air\'s scattered light, the same light at any size, never more than the haze took', () => {
    const a = lightOf(lampLight(2000, 0.407, 7630, 0.5e-3, 1.5e-3, LUX_PER_UNIT, film).glow, 1.5e-3, glowProfile);
    const b = lightOf(lampLight(2000, 0.407, 7630, 0.5e-3, 4e-3, LUX_PER_UNIT, film).glow, 4e-3, glowProfile);
    expect(b).toBeCloseTo(a, 18);
    const direct = lightOf(lampLight(2000, 0.407, 7630, 1e-6, 1e-3, LUX_PER_UNIT, film).core, 1e-6, coreProfile);
    expect(a).toBeLessThan((direct / 0.407) * (1 - 0.407));
  });

  it('shows the eye\'s brightness where pixels are coarser than the eye — a 4K pixel no dimmer than an 8K one', () => {
    const k4 = lampLight(2000, 0.407, 7630, 0.77e-3, 2e-3, LUX_PER_UNIT, film).core;
    const k8 = lampLight(2000, 0.407, 7630, 0.38e-3, 2e-3, LUX_PER_UNIT, film).core;
    expect(k4).toBeCloseTo(k8, 12);
    const f1 = lightOf(lampLight(2000, 0.407, 7630, 0.05e-3, 2e-3, LUX_PER_UNIT, film).core, 0.05e-3, coreProfile);
    const f2 = lightOf(lampLight(2000, 0.407, 7630, 0.02e-3, 2e-3, LUX_PER_UNIT, film).core, 0.02e-3, coreProfile);
    expect(f2).toBeCloseTo(f1, 18);
    expect(lightOf(k4, 0.77e-3, coreProfile)).toBeGreaterThan(f1);
    // (and without an eye cell — the game's default — the core keeps its own light at every size)
    const e4 = lightOf(lampLight(2000, 0.407, 7630, 0.77e-3, 2e-3, LUX_PER_UNIT).core, 0.77e-3, coreProfile);
    expect(e4).toBeCloseTo(f1, 18);
  });

  it('steps down only in the dark (the film\'s night step): full at dusk, stepped in the night, monotone between', () => {
    expect(nightStep(10 ** -1.2)).toBeCloseTo(1, 6);
    expect(nightStep(10 ** -7.3)).toBeLessThan(0.5);
    expect(nightStep(10 ** -7.3)).toBeGreaterThan(0.2);
    let last = 2;
    for (let x = -1; x >= -8; x -= 0.1) {
      const k = nightStep(10 ** x);
      expect(k).toBeLessThanOrEqual(last + 1e-12);
      last = k;
    }
  });
});

/** a dome of a hill: 466 m at (100, −50), falling 0.25 m a metre */
const ground = (x: number, z: number): number => 466 - 0.25 * Math.hypot(x - 100, z + 50);
const site = { ground, at: [100, -50] as [number, number], toward: [100 + 5300, -50 + 5600] as [number, number] };
/** the kit's own numbers (radio_tower.py: guys at 30/60/90 m on legs at π, ±π/3; the beacon on the cap) */
const KITM: KitMast = {
  heightAboveWater: 104.12,
  legAzimuths: [Math.PI, Math.PI / 3, -Math.PI / 3],
  guys: [30, 60, 90].flatMap((y) => [
    { leg: 0, at: [-3.4856, y - 0.3, 0] as [number, number, number] },
    { leg: 1, at: [1.7428, y - 0.3, 3.0187] as [number, number, number] },
    { leg: 2, at: [1.7428, y - 0.3, -3.0187] as [number, number, number] },
  ]),
  lamp: [0, 96.33, 0],
};

describe('a mast on its summit', () => {
  it('finds the highest ground', () => {
    const two = (x: number, z: number): number => Math.max(430 - 0.2 * Math.hypot(x - 600, z - 300), 466 - 0.25 * Math.hypot(x + 900, z + 410));
    const s = summitOf(two, [0, 0], 3600);
    expect(Math.hypot(s.x + 900, s.z + 410)).toBeLessThan(3);
  });

  const spec = stationOf('treetops').mast;
  const lay = layMast(site, KITM, spec);

  it('stands sunk into the ground at the summit, its tip the spec\'s over it, its lamp where the beams aim before the kit loads', () => {
    expect(lay.foot[1]).toBeLessThan(ground(100, -50));
    expect(KITM.heightAboveWater * lay.up).toBeCloseTo(spec.tipM, 6);
    expect(lay.lamp[1] - lay.foot[1]).toBeCloseTo(lampOverFoot(spec), 6);
    expect(lay.lamp[0]).toBeCloseTo(100, 6);
    expect(lay.lamp[2]).toBeCloseTo(-50, 6);
  });

  it('runs every guy from its lug down to its own leg\'s anchor, sunk in the slope, the first toward `toward`', () => {
    expect(lay.guys).toHaveLength(9);
    for (const [i, g] of lay.guys.entries()) {
      expect(Math.hypot(g.to[0] - 100, g.to[2] + 50)).toBeCloseTo(MAST.anchorShare * spec.tipM, 6);
      expect(g.to[1]).toBeLessThan(ground(g.to[0], g.to[2]));
      expect(g.to[1]).toBeLessThan(g.from[1]);
      const lug = Math.atan2(g.from[2] - lay.foot[2], g.from[0] - lay.foot[0]);
      const anchor = Math.atan2(g.to[2] + 50, g.to[0] - 100);
      expect(Math.abs(Math.atan2(Math.sin(lug - anchor), Math.cos(lug - anchor)))).toBeLessThan(0.05);
      void i;
    }
    const toAnchor = Math.atan2(lay.guys[0].to[2] + 50, lay.guys[0].to[0] - 100);
    const toBeach = Math.atan2(site.toward[1] + 50, site.toward[0] - 100);
    expect(Math.abs(Math.atan2(Math.sin(toAnchor - toBeach), Math.cos(toAnchor - toBeach)))).toBeLessThan(1e-6);
  });

  it('gives a self-supporting tower no guys, and keeps its lamp on its axis', () => {
    const tower: MastSpec = { kind: 'tower', tipM: 90, faceM: 9, lamp: ALIVE };
    const t = layMast(site, KITM, tower);
    expect(t.guys).toHaveLength(0);
    expect(t.lamp[1] - t.foot[1]).toBeCloseTo(lampOverFoot(tower), 6);
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
  const root = await loadMastKit(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
  const haze = uniform(new THREE.Color(0.6, 0.7, 0.8));
  const build = (spec: MastSpec, lod: 0 | 1 = 1) =>
    buildMast(root, site, spec, { time: uniform(0), air: expAir(haze, 8500), luxPerUnit: LUX_PER_UNIT, lod, lamp: filmLamp(haze) });
  const named = (g: THREE.Group, n: string): THREE.Mesh | undefined => g.getObjectByName(n) as THREE.Mesh | undefined;

  it('knows where its lamp is before it loads: the kit\'s beacon is on its axis at KIT.lampShare of its tip', () => {
    const k = kitMast(root);
    expect(k.lamp[0]).toBeCloseTo(0, 6);
    expect(k.lamp[2]).toBeCloseTo(0, 6);
    expect(k.lamp[1] / k.heightAboveWater).toBeCloseTo(KIT.lampShare, 6);
  });

  it('builds the high island\'s station as reviewed, raised to 250 m: its 5 m face, its stack and guys in the same proportion, 36 a minute', () => {
    const spec = stationOf('treetops').mast;
    expect([spec.kind, spec.tipM, spec.faceM, spec.lamp.flashesPerMin, spec.lamp.phase]).toEqual(['broadcast', 250, 5, 36, 0]);
    const { group, layout } = build(spec);
    const stack = named(group, 'mast-antennas')!;
    stack.geometry.computeBoundingBox();
    // (the reviewed 208 m mast's stack at 140–186 m and anchors 150 m out, scaled with the tip)
    expect(stack.geometry.boundingBox!.min.y).toBeCloseTo((140 / 208) * 250, 3);
    expect(stack.geometry.boundingBox!.max.y).toBeCloseTo((186 / 208) * 250, 3);
    expect(Math.hypot(layout.guys[0].to[0] - 100, layout.guys[0].to[2] + 50)).toBeCloseTo((150 / 208) * 250, 6);
  });

  it.each(NETWORK.map((s) => [s.id, s.mast] as const))('builds %s: the parts its kind has, and none it has not', (_id, spec) => {
    const { group } = build(spec);
    expect(named(group, 'mast-lattice')).toBeTruthy();
    expect(!!named(group, 'mast-antennas')).toBe(spec.kind === 'broadcast');
    expect(!!named(group, 'mast-guys')).toBe(spec.kind !== 'tower');
    expect(!!named(group, 'mast-beacon')).toBe(spec.lamp.alive);
  });

  it.each(['broadcast', 'relay', 'tower'] as const)('draws a %s\'s lattice by minimum width: nearly every vertex on a member axis', (kind) => {
    const spec = NETWORK.find((s) => s.mast.kind === kind)!.mast;
    const axes = named(build(spec).group, 'mast-lattice')!.geometry.getAttribute(THIN_AXIS_ATTRIBUTE);
    let claimed = 0;
    for (let i = 0; i < axes.count; i++) if (axes.getW(i) > 0) claimed++;
    expect(claimed / axes.count).toBeGreaterThan(0.85);
  });

  it('blends its coverage (never the frame-stepped hash), and the solid stack writes depth and is drawn first', () => {
    const { group } = build(stationOf('treetops').mast);
    for (const n of ['mast-lattice', 'mast-guys']) {
      const m = named(group, n)!.material as THREE.NodeMaterial;
      expect(m.transparent).toBe(true);
      expect(m.depthWrite).toBe(false);
      expect(m.maskNode ?? null).toBeNull();
    }
    const stack = named(group, 'mast-antennas')!;
    expect((stack.material as THREE.Material).depthWrite).toBe(true);
    expect(stack.renderOrder).toBeLessThan(named(group, 'mast-lattice')!.renderOrder);
  });

  it.each(['mast-lattice', 'mast-antennas', 'mast-guys', 'mast-beacon'])('%s compiles', (n) => {
    const { vertex, fragment } = shaders(named(build(stationOf('treetops').mast).group, n)!);
    expect(vertex.length).toBeGreaterThan(100);
    expect(fragment.length).toBeGreaterThan(100);
  });

  it('builds a mast seen close at the kit\'s full detail', () => {
    const near = named(build(stationOf('lagoon').mast, 0).group, 'mast-lattice')!;
    const far = named(build(stationOf('lagoon').mast, 1).group, 'mast-lattice')!;
    expect(near.geometry.getAttribute('position').count).toBeGreaterThan(2 * far.geometry.getAttribute('position').count);
  });
});

describe('the film\'s placements', () => {
  it('stands the high island\'s second mast on its ridge, beside the first as the beach sees it, never behind it', () => {
    // a ridge running east–west through the summit at (0, 0), falling away north and south; the beach due south
    const ridge = (x: number, z: number): number => 470 - 0.05 * Math.abs(x) - 0.6 * Math.abs(z);
    const [x, z] = ridgeSite(ridge, [0, 0], [0, 7000]);
    // across the line of sight (east or west, along the ridge), 150–300 m from the first, and on the ridge's crest
    expect(Math.abs(x)).toBeGreaterThanOrEqual(150);
    expect(Math.abs(x)).toBeLessThanOrEqual(300);
    expect(Math.abs(z)).toBeLessThan(1e-6);
    // (a smaller relay of its own, its own lamp)
    expect(HIGH_SECOND.kind).toBe('relay');
    expect(HIGH_SECOND.tipM).toBeLessThan(stationOf('treetops').mast.tipM);
    expect(HIGH_SECOND.lamp.flashesPerMin).not.toBe(stationOf('treetops').mast.lamp.flashesPerMin);
  });

  it('puts every station of the network on the Rose, once each', () => {
    expect([...FILM_RING].sort()).toEqual(NETWORK.map((s) => s.id).sort());
  });

  it('stands the coast\'s stations on four islands of the coast, the high island\'s being the reviewed tower', () => {
    expect(Object.keys(FILM_COAST)).toHaveLength(4);
    for (const id of Object.keys(FILM_COAST)) expect(() => stationOf(id)).not.toThrow();
    expect(FILM_COAST.treetops).toBe('high');
    expect(new Set(Object.values(FILM_COAST)).size).toBe(4);
  });

  it('gives the coast\'s stations the Rose\'s slots nearest their coast bearings, so the w6 hand-over barely moves the figure', () => {
    // (props.ts STATIONS: −150, −95, −40, 10, 55, 105, 160; the high island at −43°, motu 1 at −78° from the beach)
    const slot = (id: string): number => [-150, -95, -40, 10, 55, 105, 160][FILM_RING.indexOf(id)];
    expect(slot('treetops')).toBe(-40);
    expect(slot('relay-a')).toBe(-95);
  });
});
