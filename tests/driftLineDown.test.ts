/**
 * "THE LINE DOWN" — the underwater look-dev of the 2026-11-02 next-level review (src/drift/wandering/lineDown.ts). What
 * must hold, whatever its look is tuned to:
 *
 *   - it is OFF unless `?linedown` asks for it, so the next master draws as the last one did (the brief: "behind its
 *     own film param, default OFF") — and so is the c2 power line (`?powerline`, drowned.ts SUNKEN_SET);
 *   - its moment lies inside the synthesis's slot, c2–c3 (~365–410 s), on the beats' own clock: no beat moves for it
 *     (the music is synced);
 *   - open ocean only (the user, 2026-11-02: "we zoomed into what really looks like an ocean"): nothing in its set
 *     stands on a seabed — every piece floats, hangs from floats or swims, within a few metres of the surface;
 *   - its water compiles into a material's output as a pure expression of the world ray (face-safe: no screen space);
 *   - the brighter-water fallback (`?linedown=day`, after gate 2 found the sunset water too dark) lies in the
 *     synthesis's 300–345 s slot, in the landing's daylight, and ENDS where c1's follow begins: the hoist and the sail
 *     stay as they are (the dramaturg's objection to the slot: "it eats C1_FOLLOW"); the sunset version stays the
 *     default of `?linedown`;
 *   - THE DAY'S DIVE (lineDownDive.ts, the 2026-11-02 build after "some more polish and lets go"): the eye leaves the
 *     descent and comes back to it with its height, speed and acceleration matched (no lurch at either join, the cut
 *     to c1 seamless), brakes into the water without ever being pushed faster toward it, and goes through the drawn
 *     sea exactly twice, each time at a trough and clear of the waterline band within a moment (a crossing that
 *     flips the dome over and back is a strobe); the eye's adaptation eases in after the entry and out BEFORE the
 *     surfacing (or the air breaks through at twice the exposure: a white flash);
 *   - the flotsam the brief names is all there (planks, a door, a chair, a barrel, a tyre, branches and leaves, a net
 *     with floats), and the raft's rig is traced into the window where its pieces really are.
 */
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { vec3 } from 'three/tsl';
import { DAY_DOLPHIN, DAY_DOLPHIN_GONE, LINE_DOWN, LINE_DOWN_DAY, LINE_DOWN_LIGHT, LINE_DOWN_ON, LINE_DOWN_SUN_EL, createLineDown, lineDownLight, raiseSun } from '../src/drift/wandering/lineDown';
import { SUNKEN_SET } from '../src/drift/wandering/drowned';
import { C1_FOLLOW, beatStarts } from '../src/drift/wandering/beats';
import { BAND, DIVE, adaptAt, heightOn, planDive, veilAt } from '../src/drift/wandering/lineDownDive';
import { WINDOW_DEBUG, boxRows, createWindowRaft } from '../src/drift/wandering/lineDownWindow';
import { createLineDownVeil } from '../src/drift/wandering/lineDownVeil';

const c1End = 41.1;
const { starts } = beatStarts(c1End);
/** show s of a sea time (c2 starts at 355 s of the show) */
const show = (sea: number): number => 355 + (sea - starts.c2);

function fragmentOf(mesh: THREE.Mesh, scene: THREE.Scene): string {
  const canvas = { width: 4, height: 4, style: {}, getContext: () => null, addEventListener: () => {}, removeEventListener: () => {}, getRootNode: () => ({}), setAttribute: () => {} };
  const renderer = new THREE.WebGPURenderer({ canvas: canvas as unknown as HTMLCanvasElement });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- three's internal codegen harness
  const backend = (renderer as any).backend;
  backend.renderer = renderer;
  backend.device = { limits: { maxUniformBufferBindingSize: 65536 } };
  const builder = backend.createNodeBuilder(mesh, renderer);
  builder.scene = scene;
  builder.fogNode = scene.fogNode;
  builder.material = mesh.material;
  builder.camera = new THREE.PerspectiveCamera();
  builder.context.material = builder.material;
  builder.build();
  return builder.fragmentShader;
}

describe('the Line Down look-dev', () => {
  it('is off by default, and so is the c2 power line (and the window trace\'s red debug paint)', () => {
    expect(LINE_DOWN_ON).toBe(false);
    expect(WINDOW_DEBUG).toBe(false);
    expect(SUNKEN_SET.powerLine).toBe(false);
  });

  it('lies inside the synthesis\'s slot, c2–c3, on the beats\' clock', () => {
    const from = show(starts[LINE_DOWN.from[0]] + LINE_DOWN.from[1]);
    const to = show(starts[LINE_DOWN.to[0]] + LINE_DOWN.to[1]);
    expect(from).toBeGreaterThanOrEqual(360);
    expect(to).toBeLessThanOrEqual(415);
    expect(to - from).toBeGreaterThan(20);
    // (the beats it is timed from are where the music has them: c2 at 355 s, c3 at 385 s)
    expect(show(starts.c3)).toBeCloseTo(385, 6);
  });

  const scene = new THREE.Scene();
  const look = createLineDown(undefined as unknown as THREE.WebGPURenderer, scene, starts);

  it('floats: nothing in the open-ocean set reaches deeper than a few metres', () => {
    const box = new THREE.Box3();
    look.group.updateMatrixWorld(true);
    look.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh || m.name === 'drift-dolphin') return;
      box.setFromObject(m);
      expect(box.min.y).toBeGreaterThan(-4.5);
    });
    // (and the eye is under the water deep enough for a window, not so deep the sunset's red is gone: K_red 0.36/m)
    expect(LINE_DOWN.depth).toBeGreaterThan(3);
    expect(Math.exp(-0.36 * LINE_DOWN.depth)).toBeGreaterThan(0.1);
  });

  it('puts its water into a material\'s output from the world ray', () => {
    expect(scene.fogNode).toBeTruthy();
    const frag = fragmentOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()), scene);
    expect(frag.length).toBeGreaterThan(100);
    // (the shafts' march along the ray is in it: the water reached the material)
    expect(frag).toMatch(/for\s*\(/);
    // (no screen-space read: the dome's faces would seam — the synthesis on godRays.ts)
    expect(frag).not.toMatch(/screenUV|textureSample\([^)]*scenePass/);
  });

  describe('the day fallback', () => {
    it('is asked for by name; a bare ?linedown keeps the sunset, and no Sun is raised unless asked', () => {
      expect(lineDownLight('day')).toBe('day');
      expect(lineDownLight('')).toBe('sunset');
      expect(lineDownLight(null)).toBe('sunset');
      expect(LINE_DOWN_LIGHT).toBe('sunset');
      expect(LINE_DOWN_SUN_EL).toBeUndefined();
    });

    it('lies in the 300–345 s slot, leaves the descent alone before 315 s, and ends where the follow (the hoist, the sail) begins', () => {
      const from = show(starts[LINE_DOWN_DAY.from[0]] + LINE_DOWN_DAY.from[1]);
      const to = show(starts[LINE_DOWN_DAY.to[0]] + LINE_DOWN_DAY.to[1]);
      expect(from).toBeGreaterThanOrEqual(300);
      expect(to).toBeLessThanOrEqual(345);
      expect(to - from).toBeGreaterThan(10);
      // (the dive re-blocks the descent's last seconds only: 367627d's continuous dive stands up to ~315 s)
      expect(from).toBeGreaterThanOrEqual(315 - 1e-9);
      // (the follow starts C1_FOLLOW before c2: the moment must not reach into it)
      expect(to).toBeLessThanOrEqual(show(starts.c2 - C1_FOLLOW) + 1e-9);
    });

    it('raises the Sun about its own bearing (the &ldsun look-dev)', () => {
      const s = new THREE.Vector3(0.3, Math.sin((11 * Math.PI) / 180), -0.9).normalize();
      const az = Math.atan2(s.x, s.z);
      raiseSun(s, 40);
      expect(s.length()).toBeCloseTo(1, 9);
      expect(Math.asin(s.y) * (180 / Math.PI)).toBeCloseTo(40, 9);
      expect(Math.atan2(s.x, s.z)).toBeCloseTo(az, 9);
    });

    it('builds the same face-safe water, without the case (c3\'s, not yet in the story)', () => {
      const daySc = new THREE.Scene();
      const dayLook = createLineDown(undefined as unknown as THREE.WebGPURenderer, daySc, starts, 'day');
      let caseShown = false;
      dayLook.group.traverse((o) => void (o.name === 'drift-hard-case' && o.visible && (caseShown = true)));
      expect(caseShown).toBe(false);
      const frag = fragmentOf(new THREE.Mesh(new THREE.BoxGeometry(), new THREE.MeshStandardNodeMaterial()), daySc);
      expect(frag).toMatch(/for\s*\(/);
      expect(frag).not.toMatch(/screenUV|textureSample\([^)]*scenePass/);
    });
  });

  describe('the day\'s dive', () => {
    // a descent like Act 2's (an eased approach to rest 3 m over the sea, levelling out onto a slow drift) over a sea of
    // a ground swell and a light ripple, both travelling (m, s; c2 at 355 s)
    const c2 = 355;
    // (Act 2's measured descent: 108 m at 315 s falling at 33 m/s, 25 m at 320 s, 7.7 m at 325 s, at rest at 3 m)
    const drive = (t: number): [number, number, number] => {
      const k = Math.exp(-(t - 315) / 3.2);
      return [0.48 * (t - 315) - 15 * k, 3 + 105 * k, -0.3 * (t - 315)];
    };
    const sea = (x: number, z: number, t: number): number =>
      0.18 * Math.sin(0.063 * x - 0.63 * t) + 0.1 * Math.sin(0.4 * z + 0.3 * x - 1.9 * t + 1) + 0.04 * Math.sin(1.3 * x - 3.4 * t);
    const plan = planDive(c2, drive, sea);
    const y = plan.y;
    const vOf = (f: (t: number) => number, t: number, h = 0.01): number => (f(t + h) - f(t - h)) / (2 * h);
    const aOf = (f: (t: number) => number, t: number, h = 0.01): number => (f(t + h) - 2 * f(t) + f(t - h)) / (h * h);
    const driveY = (t: number): number => drive(t)[1];

    it('leaves the descent and lands back on its rest with height, speed and acceleration matched (no lurch, no cut)', () => {
      expect(plan.from).toBeCloseTo(c2 + DIVE.from, 9);
      expect(plan.to).toBeCloseTo(c2 + DIVE.to, 9);
      for (const t of [plan.from, plan.to]) {
        const inside = t === plan.from ? t + 0.03 : t - 0.03;
        expect(y(inside)).toBeCloseTo(driveY(inside), 1);
        expect(vOf(y, inside)).toBeCloseTo(vOf(driveY, inside), 0);
        expect(Math.abs(aOf(y, inside) - aOf(driveY, inside))).toBeLessThan(1);
      }
      // (the rest itself: c1's follow begins from the very frame it always did)
      expect(y(plan.to)).toBeCloseTo(driveY(plan.to), 6);
    });

    it('brakes into the water, never pushed faster toward it, and under it moves as a swimmer, not a lift', () => {
      for (let t = plan.from + 0.05; t < plan.down; t += 0.05) expect(aOf(y, t)).toBeGreaterThan(-0.2);
      let vMax = 0;
      let aMax = 0;
      for (let t = plan.down; t <= plan.to; t += 0.05) {
        vMax = Math.max(vMax, Math.abs(vOf(y, t)));
        aMax = Math.max(aMax, Math.abs(aOf(y, t)));
      }
      expect(vMax).toBeLessThan(5);
      expect(aMax).toBeLessThan(3.5);
      // (the bottom of the dive: the water's depth the look was tuned at, not a plunge into the dark)
      let lowest = 0;
      for (let t = plan.down; t <= plan.up; t += 0.05) lowest = Math.min(lowest, y(t));
      expect(lowest).toBeCloseTo(-DIVE.depth, 1);
    });

    it('goes through the drawn sea exactly twice, each at a trough, clear of the waterline band within a moment', () => {
      expect(plan.check.down).toBe(true);
      expect(plan.check.up).toBe(true);
      expect(plan.check.clearance).toBeGreaterThan(BAND);
      const over = (t: number): number => {
        const [x, , z] = drive(t);
        return y(t) - sea(x, z, t);
      };
      let flips = 0;
      for (let t = plan.from; t < plan.to; t += 0.005) if (Math.sign(over(t)) !== Math.sign(over(t + 0.005))) flips++;
      expect(flips).toBe(2);
      // (at a trough — or, where the reach holds none, its lowest water: the sea low, and all but still against the
      // eye going through it, so the two cannot meet a second time)
      const h = (t: number): number => {
        const [x, , z] = drive(t);
        return sea(x, z, t);
      };
      for (const at of [plan.down, plan.up]) {
        expect(h(at)).toBeLessThan(0);
        expect(Math.abs(vOf(h, at))).toBeLessThan(Math.abs(vOf(y, at)) / 3);
      }
      // (near their nominal times: the trough is looked for within DIVE.search)
      expect(Math.abs(plan.down - (c2 + DIVE.down))).toBeLessThanOrEqual(DIVE.search + 1e-9);
      expect(Math.abs(plan.up - (c2 + DIVE.up))).toBeLessThanOrEqual(DIVE.search + 1e-9);
      // (the keys are the plan's curve)
      expect(heightOn(plan.keys, plan.down)).toBeCloseTo(y(plan.down), 9);
    });

    it('eases the eye\'s adaptation in after the entry and out before the surfacing (no flash), under a veil each time', () => {
      const under = 2.1;
      expect(adaptAt(plan.down, plan.down, plan.up, under)).toBe(1);
      expect(adaptAt(plan.up, plan.down, plan.up, under)).toBe(1);
      expect(adaptAt((plan.down + plan.up) / 2, plan.down, plan.up, under)).toBeCloseTo(under, 6);
      // (just before the air comes back the eye is nearly at the air's exposure already)
      expect(adaptAt(plan.up - 0.15, plan.down, plan.up, under)).toBeLessThan(1.05);
      // (and it never jumps: a frame's change at 30 fps stays small)
      for (let t = plan.down - 1; t < plan.up + 1; t += 1 / 30) expect(Math.abs(adaptAt(t + 1 / 30, plan.down, plan.up, under) - adaptAt(t, plan.down, plan.up, under))).toBeLessThan(0.08);
      // the veil: up over each crossing, gone between them and outside
      expect(veilAt(plan.down + 0.05, plan.down, plan.up)).toBeGreaterThan(0.95);
      expect(veilAt(plan.up, plan.down, plan.up)).toBeGreaterThan(0.95);
      expect(veilAt((plan.down + plan.up) / 2, plan.down, plan.up)).toBe(0);
      expect(veilAt(plan.down - 1, plan.down, plan.up)).toBe(0);
      expect(veilAt(plan.up + 1.5, plan.down, plan.up)).toBe(0);
    });

    it('builds its veil, bubbles and snow face-safe (world places, eye-facing quads, no screen space)', () => {
      const v = createLineDownVeil({ down: { t: plan.down, x: 0, z: 0, v: DIVE.vDown, vx: 0.5, vz: 0 }, up: { t: plan.up, x: 0, z: 0 } });
      const sc = new THREE.Scene();
      sc.add(v.group);
      v.group.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const frag = fragmentOf(m, sc);
        expect(frag).not.toMatch(/screenUV|textureSample\([^)]*scenePass/);
        // (lit by the water, never fogged by it: lineDown skips them when it turns the scene's fog on)
        expect(o.userData.lineDownOwn).toBe(true);
      });
    });
  });

  describe('the day\'s set and window', () => {
    it('has every piece of flotsam the brief names, afloat', () => {
      const sc = new THREE.Scene();
      const day = createLineDown(undefined as unknown as THREE.WebGPURenderer, sc, starts, 'day');
      const names = new Set<string>();
      day.group.traverse((o) => names.add(o.name));
      for (const kind of ['plank', 'door', 'chair', 'barrel', 'tyre', 'branch', 'net']) expect(names.has(`line-down-${kind}`)).toBe(true);
      // (without its drive and sea — here — the dive is not planned and the eye is never moved)
      expect(day.plan).toBeNull();
    });

    it('traces the raft\'s pieces where they are, and only those above the water', () => {
      // a mast-like piece: a pole 6 m tall, 10 m ahead, leaning; its unit box's corners must map to ±½
      const world = new THREE.Matrix4().compose(new THREE.Vector3(2, 3, -10), new THREE.Quaternion().setFromEuler(new THREE.Euler(0.1, 0.3, -0.08)), new THREE.Vector3(1, 1, 1));
      const box = new THREE.Box3(new THREE.Vector3(-0.08, -3, -0.08), new THREE.Vector3(0.08, 3, 0.08));
      const rows: [THREE.Vector4, THREE.Vector4, THREE.Vector4] = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
      boxRows(world, box, rows);
      const top = new THREE.Vector3(0.08, 3, -0.08).applyMatrix4(world);
      const p = new THREE.Vector4(top.x, top.y, top.z, 1);
      expect(rows[0].dot(p)).toBeCloseTo(0.5, 6);
      expect(rows[1].dot(p)).toBeCloseTo(0.5, 6);
      expect(rows[2].dot(p)).toBeCloseTo(-0.5, 6);
      // the pieces it picks from a raft: the pole and the cabin above the water; not the logs' undersides below it,
      // nor the rig's ropes (one mesh spanning the whole rig: its box would hide everything)
      const w = createWindowRaft();
      const raft = new THREE.Group();
      const add = (name: string, size: [number, number, number], y: number): void => {
        const m = new THREE.Mesh(new THREE.BoxGeometry(...size), new THREE.MeshBasicNodeMaterial());
        m.name = name;
        m.position.y = y;
        raft.add(m);
      };
      add('mast-leg-mesh', [0.16, 6.5, 0.16], 3.4);
      add('cabin-mesh', [2.4, 1.4, 4.3], 0.9);
      add('keel-mesh', [0.3, 0.4, 6], -0.5);
      add('drift-raft-rig-lines', [6, 8, 14], 4);
      w.update(raft, true, new THREE.Vector3(0, 1, 0), new THREE.Vector3(1, 1, 1), new THREE.Vector3(1, 1, 1));
      expect(w.boxes).toBe(2);
      // and it compiles into the sea's window as a trace from the surface point (no screen space)
      const mat = new THREE.MeshBasicNodeMaterial();
      mat.colorNode = w.sky(vec3(0, 1, 0), vec3(0.5));
      const frag = fragmentOf(new THREE.Mesh(new THREE.PlaneGeometry(), mat), new THREE.Scene());
      expect(frag).toMatch(/for\s*\(/);
      expect(frag).not.toMatch(/screenUV/);
    });
  });

  describe('the day\'s dolphin', () => {
    // (rest-frame keys, s from c2's start; the dive's own hang and surfacing: lineDownDive.ts DIVE, the glide)
    const at = (k: number): [number, number, number] => {
      let i = 0;
      while (i < DAY_DOLPHIN.length - 2 && k > DAY_DOLPHIN[i + 1][0]) i++;
      const [t0, x0, z0, y0] = DAY_DOLPHIN[i];
      const [t1, x1, z1, y1] = DAY_DOLPHIN[i + 1];
      const u = (k - t0) / (t1 - t0);
      return [x0 + (x1 - x0) * u, z0 + (z1 - z0) * u, y0 + (y1 - y0) * u];
    };
    it('is met under the water after the eye goes in, and breaks the surface just before the eye comes up — leading it up', () => {
      expect(DAY_DOLPHIN[0][0]).toBeGreaterThan(DIVE.down + DIVE.search);
      expect(DAY_DOLPHIN[0][3]).toBeLessThan(-8);
      let breaks = Infinity;
      for (let k = DAY_DOLPHIN[0][0]; k < DAY_DOLPHIN_GONE; k += 0.01) if (at(k)[2] > 0) {
        breaks = k;
        break;
      }
      expect(breaks).toBeLessThan(DIVE.up);
      expect(breaks).toBeGreaterThan(DIVE.up - DIVE.search - 1.5);
      expect(DAY_DOLPHIN_GONE).toBeLessThan(DIVE.up + 1);
    });
    it('crosses the window over the eye\'s hang slowly enough for the dome: ≥3 s inside it, never nearer than 3 m', () => {
      // the eye's way in the rest's frame (right, ahead, up; s from c2), as the dive lays it over Act 2's descent
      // (lineDownDive.ts, measured with the real drive: its hang and its drift back up)
      const EYE: Array<[number, number, number, number]> = [[-29, 3.5, 8.1, -7.85], [-28, 3.3, 8.1, -7.9], [-27, 3.1, 7.7, -7.2], [-26, 2.7, 6.6, -5.8], [-25, 2.2, 4.9, -4.0], [-24, 1.6, 3.0, -2.1]];
      const eyeAt = (k: number): [number, number, number] => {
        let i = 0;
        while (i < EYE.length - 2 && k > EYE[i + 1][0]) i++;
        const u = Math.min(1, Math.max(0, (k - EYE[i][0]) / (EYE[i + 1][0] - EYE[i][0])));
        return [EYE[i][1] + (EYE[i + 1][1] - EYE[i][1]) * u, EYE[i][2] + (EYE[i + 1][2] - EYE[i][2]) * u, EYE[i][3] + (EYE[i + 1][3] - EYE[i][3]) * u];
      };
      let inside = 0;
      let nearest = Infinity;
      for (let k = DAY_DOLPHIN[0][0]; k < -24.2; k += 0.02) {
        const [x, z, y] = at(k);
        const eye = eyeAt(k);
        const d = Math.hypot(x - eye[0], z - eye[1], y - eye[2]);
        nearest = Math.min(nearest, d);
        // (inside the window: within the critical angle of straight up from the eye)
        if (y > eye[2] && Math.hypot(x - eye[0], z - eye[1]) < (y - eye[2]) * Math.tan((48.6 * Math.PI) / 180)) inside += 0.02;
      }
      expect(inside).toBeGreaterThanOrEqual(3);
      expect(nearest).toBeGreaterThan(3);
    });
  });
});
