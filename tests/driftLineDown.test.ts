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
import { A3_BREATHE, A3_CIRCLER, A3_LEAD, A3_UNDER, DAY_DOLPHIN, DAY_DOLPHIN_GONE, LINE_DOWN, LINE_DOWN_DAY, LINE_DOWN_LIGHT, LINE_DOWN_ON, LINE_DOWN_SUN_EL, createLineDown, lineDownLight, lineDownOn, raiseSun } from '../src/drift/wandering/lineDown';
import { SUNKEN_SET } from '../src/drift/wandering/drowned';
import { swimEnvelope } from '../src/drift/wandering/dolphin';
import { thingsAt } from '../src/drift/getTheDrift/debrisField';
import { C1_FOLLOW, beatStarts, raftPose } from '../src/drift/wandering/beats';
import { ADAPT_IN, BAND, DIVE, DIVE_A3, DIVE_LATE, DIVE_PACED, adaptAt, foamAt, heightOn, planDive } from '../src/drift/wandering/lineDownDive';
import { WINDOW_DEBUG, boxRows, createWindowRaft } from '../src/drift/wandering/lineDownWindow';
import { SNOW, WET_LENS, createLineDownVeil, dropsAt } from '../src/drift/wandering/lineDownVeil';

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
  it('is ON by default as A3 (the user, 2026-11-02), with a switch to turn it off; the c2 power line and the window trace\'s red debug paint stay off', () => {
    expect(LINE_DOWN_ON).toBe(true);
    expect(LINE_DOWN_LIGHT).toBe('a3');
    expect(lineDownOn('off')).toBe(false);
    expect(lineDownOn('0')).toBe(false);
    expect(lineDownOn(null)).toBe(true);
    expect(lineDownOn('')).toBe(true);
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
    it('is asked for by name; a bare ?linedown is A3, the sunset by its name, and no Sun is raised unless asked', () => {
      expect(lineDownLight('day')).toBe('day');
      expect(lineDownLight('sunset')).toBe('sunset');
      expect(lineDownLight('')).toBe('a3');
      expect(lineDownLight(null)).toBe('a3');
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

    it('opens the eye quickly under the water and closes it before the surfacing (no flash); foam only at the waterline', () => {
      const under = 2.1;
      expect(adaptAt(plan.down, plan.down, plan.up, under)).toBe(1);
      // (the water at its beauty "pretty immediately" — the user, 2026-11-02, round 2: within ADAPT_IN ≤ 0.6 s)
      expect(ADAPT_IN).toBeLessThanOrEqual(0.6);
      expect(adaptAt(plan.down + ADAPT_IN, plan.down, plan.up, under)).toBeCloseTo(under, 6);
      // AT EACH CROSSING the exposure meets the scene's step half way (the water is darker than the air): up a little
      // going in, and coming up the air is let in at less than the water's exposure, never more — never a flash
      expect(adaptAt(plan.down + 1e-3, plan.down, plan.up, under)).toBeGreaterThan(1);
      const lastUnder = adaptAt(plan.up - 1e-3, plan.down, plan.up, under);
      const firstAir = adaptAt(plan.up + 1e-3, plan.down, plan.up, under);
      expect(firstAir).toBeLessThan(1);
      expect(lastUnder).toBeGreaterThan(firstAir);
      expect(adaptAt(plan.up + 1.5, plan.down, plan.up, under)).toBeCloseTo(1, 6);
      // (and away from the crossings it never jumps: a frame's change at 30 fps stays small)
      for (let t = plan.down - 1; t < plan.up + 2; t += 1 / 30) {
        if (Math.abs(t - plan.down) < 0.05 || Math.abs(t - plan.up) < 0.05) continue;
        expect(Math.abs(adaptAt(t + 1 / 30, plan.down, plan.up, under) - adaptAt(t, plan.down, plan.up, under))).toBeLessThan(0.2);
      }
      // the waterline's foam: up only for a moment round each crossing — nothing in the air before the entry (the
      // first build's veil: "a gray screen with snow on it"), nothing a half-second into the water
      expect(foamAt(plan.down, plan.down, plan.up)).toBe(1);
      expect(foamAt(plan.up, plan.down, plan.up)).toBe(1);
      expect(foamAt(plan.down - 0.15, plan.down, plan.up)).toBe(0);
      expect(foamAt(plan.down + 0.5, plan.down, plan.up)).toBe(0);
      expect(foamAt(plan.up + 0.5, plan.down, plan.up)).toBe(0);
      expect(foamAt((plan.down + plan.up) / 2, plan.down, plan.up)).toBe(0);
    });

    it('keeps the marine snow sparse, and the wet lens few, small, ahead, and gone within ~1.5 s', () => {
      expect(SNOW).toBeLessThanOrEqual(260);
      // (the wet lens is off unless asked for: the user, 2026-11-02 — "spot on, not some janky blob", or not at all)
      expect(WET_LENS).toBe(false);
      const front: [number, number] = [0, -1];
      expect(dropsAt(-0.1, front)).toHaveLength(0);
      expect(dropsAt(1.3, front)).toHaveLength(0);
      const at = dropsAt(0.3, front);
      expect(at.length).toBeGreaterThan(4);
      expect(at.length).toBeLessThanOrEqual(30);
      for (const [dir, r] of at) {
        expect(r).toBeLessThanOrEqual((3.5 * Math.PI) / 180 + 1e-9);
        // (ahead: within ~100° of the front)
        expect(dir.x * front[0] + dir.z * front[1]).toBeGreaterThan(-0.2);
      }
      // (sliding down: a drop is lower later in its life; and the same t gives the same drops)
      expect(dropsAt(0.3, front)[0][0].y).toBeCloseTo(at[0][0].y, 12);
    });

    it('builds its foam, wet lens, bubbles and snow face-safe (world places, eye-facing quads, no screen space)', () => {
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

  it('the things set by the eye float as wreckage does: nothing upright riding high, the wood low in the water', () => {
    // (the user, 2026-11-02, on the upturned picnic table beside the raft: "it wouldn't float like this")
    const d = thingsAt(Array.from({ length: 30 }, (_, i) => [i * 3, 0] as [number, number]));
    const TABLE = 16;
    const BUOY = 11;
    const WOOD = new Set([4, 8, 17]);
    for (let n = 0; n < d.count; n++) {
      expect([TABLE, BUOY]).not.toContain(d.kind[n]);
      if (WOOD.has(d.kind[n])) expect(d.extra[n * 4]).toBeLessThanOrEqual(0.3);
    }
  });

  describe('the later dips: A2 paced, B late (2026-11-02)', () => {
    it('are asked for by name, and none of them moves a beat', () => {
      expect(lineDownLight('paced')).toBe('paced');
      expect(lineDownLight('late')).toBe('late');
      // (the beats the music is cut to: c2 at 355 s, c3 at 385 s — the same with or without them)
      expect(show(starts.c2)).toBeCloseTo(355, 6);
      expect(show(starts.c3)).toBeCloseTo(385, 6);
    });

    it('A2 shows the raft from the air first, then ~12 s of calm under it, and is back on the follow before c2', () => {
      // (the approach to ~327 s is the approved descent's: the raft in view from ~321 s, slowing onto it)
      expect(355 + DIVE_PACED.from).toBeGreaterThanOrEqual(327);
      expect(DIVE_PACED.up - DIVE_PACED.down).toBeGreaterThanOrEqual(12);
      expect(DIVE_PACED.to).toBeLessThanOrEqual(0);
      // (no plunge in, no rip out)
      expect(Math.abs(DIVE_PACED.vDown)).toBeLessThanOrEqual(2);
      expect(DIVE_PACED.vUp).toBeLessThanOrEqual(2);
    });

    it('B keeps the landing whole and dips while the Sun is still ≥ ~6° (blue water), leaving c3 its surface scene', () => {
      // (the follow starts at 335 s: the approved landing is untouched)
      expect(355 + DIVE_LATE.from).toBeGreaterThanOrEqual(335 + 5);
      // (the Sun time-lapsed from the landing's 11° to c2's 3° over 338–375 s: ≥ 6° until ~360 s)
      expect(355 + DIVE_LATE.up).toBeLessThanOrEqual(360);
      expect(355 + DIVE_LATE.to).toBeLessThan(385);
    });

    it('leave the sailing path and come back to it matched, crossing the drawn sea once each way, gently', () => {
      // a sailing eye: 3 m up, under way along the raft's course at up to 1.2 m/s, eased on (sea.ts WAY)
      const c2 = 355;
      const base = (t: number): [number, number, number] => {
        const k = Math.min(1, Math.max(0, (t - 342) / 9));
        const along = t < 342 ? 0.48 * (t - 335) : 0.48 * 7 + 1.2 * (9 * (k * k * k - 0.5 * k * k * k * k) + Math.max(0, t - 351)) + 0.48 * (t - 342);
        return [0.3 * along, 3, -along];
      };
      const sea = (x: number, z: number, t: number): number => 0.15 * Math.sin(0.063 * x - 0.63 * t) + 0.08 * Math.sin(0.4 * z - 1.9 * t + 1);
      for (const spec of [DIVE_PACED, DIVE_LATE, DIVE_A3]) {
        const p = planDive(c2, base, sea, 0, { ...spec, glide: [2, 6] });
        expect(p.check.down).toBe(true);
        expect(p.check.up).toBe(true);
        for (const t of [p.from + 0.03, p.to - 0.03]) {
          const v = (f: (t: number) => number, x: number): number => (f(x + 0.01) - f(x - 0.01)) / 0.02;
          expect(p.y(t)).toBeCloseTo(base(t)[1], 2);
          expect(v(p.y, t)).toBeCloseTo(0, 1);
          expect(p.xz(t)[0]).toBeCloseTo(base(t)[0], 2);
          expect(p.xz(t)[1]).toBeCloseTo(base(t)[2], 2);
        }
        let vMax = 0;
        for (let t = p.from; t < p.to; t += 0.05) vMax = Math.max(vMax, Math.abs((p.y(t + 0.01) - p.y(t - 0.01)) / 0.02));
        expect(vMax).toBeLessThan(2.6);
        // (A3's rest at the bottom: ~still for its length — the user, "rest for a second or two at the bottom")
        if (spec.rest) {
          const r0 = c2 + spec.bottom;
          for (let t = r0; t <= r0 + spec.rest; t += 0.05) expect(Math.abs((p.y(t + 0.01) - p.y(t - 0.01)) / 0.02)).toBeLessThan(0.05);
        }
      }
    });
  });

  describe('A3: the raft held in view, a shorter dip under A\'s framing, two dolphins (2026-11-02)', () => {
    it('gives the raft ~15 s above the water, then sinks slowly to a shallow, unhurried hang, and rises back to the follow', () => {
      expect(lineDownLight('a3')).toBe('a3');
      // (the raft ahead from ~321 s of the approved descent, the eye at rest from 335 s: the entry no sooner than ~336 s)
      expect(355 + DIVE_A3.down - 321).toBeGreaterThanOrEqual(15);
      // (round 2, the user: "way too hectic, way too fast … no reason to be like 'oh, it's down 10 metres'")
      // (slow before and after; through the surface itself quick enough not to linger with it at the lens)
      expect(Math.abs(DIVE_A3.vDown)).toBeLessThanOrEqual(1.3);
      expect(DIVE_A3.vUp).toBeLessThanOrEqual(1.3);
      expect(DIVE_A3.depth).toBeGreaterThanOrEqual(2);
      expect(DIVE_A3.depth).toBeLessThanOrEqual(4);
      // (time to breathe, then the dolphins, then the rise: ~11–14 s under)
      expect(DIVE_A3.up - DIVE_A3.down).toBeGreaterThanOrEqual(11);
      expect(DIVE_A3.up - DIVE_A3.down).toBeLessThanOrEqual(14);
      expect(A3_BREATHE).toBeGreaterThanOrEqual(2.5);
      // (back on the follow's path a moment into c2: the follow and c2 are one shot of one sea, no beat moves)
      expect(DIVE_A3.to).toBeLessThanOrEqual(2);
    });

    it('fills its time with the dolphins: a close pass over the eye with a roll, a circle, both up before the eye', () => {
      const at = (keys: Array<[number, number, number, number]>, k: number): [number, number, number] => {
        let i = 0;
        while (i < keys.length - 2 && k > keys[i + 1][0]) i++;
        const u = (k - keys[i][0]) / (keys[i + 1][0] - keys[i][0]);
        return [1, 2, 3].map((j) => keys[i][j] + (keys[i + 1][j] - keys[i][j]) * u) as [number, number, number];
      };
      // (the eye's shallow hang in A's frame: ~6 m short of the raft's centre at (4.7, 17.4), 3.5 m down)
      const eye: [number, number, number] = [3.1, 11.6, -3.5];
      let nearest = Infinity;
      for (let k = 0; k < A3_LEAD.gone; k += 0.02) {
        const [x, z, y] = at(A3_LEAD.keys, k);
        nearest = Math.min(nearest, Math.hypot(x - eye[0], z - eye[1], y - eye[2]));
      }
      // (closer than A2's pass, never so close it fills the dome)
      expect(nearest).toBeGreaterThan(2.8);
      expect(nearest).toBeLessThan(5);
      // (its roll falls while it is over the eye)
      const [rx, rz] = at(A3_LEAD.keys, (A3_LEAD.roll[0] + A3_LEAD.roll[1]) / 2);
      expect(Math.hypot(rx - eye[0], rz - eye[1])).toBeLessThan(4);
      // both break the surface before the eye comes up, and clear of the raft (its centre at (4.7, 17.4), 2.7 m half-beam)
      for (const tr of [A3_LEAD, A3_CIRCLER]) {
        const up = tr.keys.find(([, , , y]) => y > 0)!;
        expect(up[0]).toBeLessThan(A3_UNDER);
        expect(Math.hypot(up[1] - 4.7, up[2] - 17.4)).toBeGreaterThan(4.5);
      }
    });

    it('swims: tail beats in bursts and glides, ~1–2 Hz', () => {
      let lo = 1;
      let hi = 0;
      for (let t = 0; t < 10; t += 0.05) {
        lo = Math.min(lo, swimEnvelope(t));
        hi = Math.max(hi, swimEnvelope(t));
        expect(Math.abs(swimEnvelope(t + 1 / 30) - swimEnvelope(t))).toBeLessThan(0.1);
      }
      expect(lo).toBeLessThan(0.3);
      expect(hi).toBeGreaterThan(0.9);
      for (const tr of [A3_LEAD, A3_CIRCLER]) {
        expect(tr.hz).toBeGreaterThanOrEqual(1);
        expect(tr.hz).toBeLessThanOrEqual(2);
      }
    });
  });

  it('leaves the raft\'s own pose alone: no frame-to-frame step in it through every variant\'s window (300–365 s)', () => {
    // (the user, 2026-11-02, on A3: "the boat is hitching and jumping". The dips move the EYE only — the raft's pose is
    // beats.ts raftPose's, the same for every variant; held here to no step beyond its smooth eased keys)
    const rest = { bearing: 0.26, distance: 18, heading: -1.6, height: 3 };
    const f = 1 / 30;
    const at = (t: number) => raftPose(t - 355 + starts.c2, c1End, rest);
    for (let t = 300; t < 365; t += f) {
      const [a, b, c] = [at(t - f), at(t), at(t + f)];
      for (const k of ['bearing', 'distance', 'heading', 'height'] as const) {
        // (velocity per frame small, and no kink: the second difference tiny)
        expect(Math.abs(c[k] - b[k])).toBeLessThan(0.05);
        expect(Math.abs(c[k] - 2 * b[k] + a[k])).toBeLessThan(0.002);
      }
    }
  });
});
