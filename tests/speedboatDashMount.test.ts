/**
 * §T.208 the cockpit instruments on the hero's 3D dash (src/speedboat/page/dashMount.ts).
 *
 * WHY: USER "i'm missing the trim ui now. no indication anymore where we're at in first person view". The GLB has no
 * screen or needle nodes, so the mount points are derived from the nodes it does have (gauge glass, jack socket) and
 * dash.py's layout. A derivation that drifts puts the plotter floating in front of the tablet or sunk behind it and
 * the gauge tiles off their bezels — so the derived points are checked against the REAL geometry of the built GLB:
 * the tablet screen's four corners in the merged parts mesh, and the gauge glass rims. And the instruments repaint at
 * DASH_HZ only while the lens actually sees the dash: canvas painting + texture upload every frame, or in chase where
 * the dash is a few pixels, is CPU the race does not have (§T.205); a trailer insert at the gauges must still be live.
 *
 * VALUES FOLLOW THE TELEMETRY: a dash that is live but wrong is worse than the HUD it replaces — the pilot trims by the
 * needle. So the needles are read back as angles on the face (as the pilot sees them) after the page's telemetry went
 * through the HUD model, and the LED / Governor lamp text is read from the paint calls.
 *
 * LEGIBLE: the HUD drops its cockpit trim + speed panels only while every gauge is on screen and readable (user: trim
 * visible in ALL views). Looking back must bring them back, and the switch must not flicker at the threshold.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { assetFromGltf } from '../src/speedboat/assets/boatModel';
import type { Course, RaceState } from '../src/race/types';
import { DASH_HZ, DASH_LEGIBLE_OFF, DASH_LEGIBLE_ON, DASH_VISIBLE_MIN, createDashMount, dashBrightness, dashScreenRadius, locateDash, } from '../src/speedboat/page/dashMount';
import { RPM_NEEDLE_SWEEP, TRIM_NEEDLE_SWEEP } from '../src/speedboat/ui/dash';
import { RPM_MAX, TRIM_DIAL_DEG, createHudTelemetry, createRaceHudModel, prepareCourse, updateRaceHudModel } from '../src/speedboat/ui/model';

async function heroBoat() {
  const bytes = readFileSync(new URL('../assets/models/speedboat_hero.glb', import.meta.url));
  await MeshoptDecoder.ready;
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const fakeKtx2 = { load(_u: string, onLoad: (t: THREE.CompressedTexture) => void): void { onLoad(new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format)); } };
  loader.setKTX2Loader(fakeKtx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
  const g = globalThis as unknown as { self?: unknown };
  const hadSelf = 'self' in g;
  if (!hadSelf) g.self = globalThis;
  try {
    const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    return assetFromGltf(gltf.scene).instantiate({ variant: 'hero', water: false });
  } finally {
    if (!hadSelf) delete g.self;
  }
}

const verticesOf = (root: THREE.Object3D, frame: THREE.Object3D): THREE.Vector3[] => {
  const out: THREE.Vector3[] = [];
  frame.updateMatrixWorld(true);
  const inv = frame.matrixWorld.clone().invert();
  root.traverse((o) => {
    const pos = (o as THREE.Mesh).geometry?.getAttribute('position');
    if (!pos) return;
    const m = inv.clone().multiply(o.matrixWorld);
    for (let i = 0; i < pos.count; i++) out.push(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
  });
  return out;
};

describe('§T.208 dash displays on the hero dash', () => {
  it('sit on the real tablet screen and gauge glasses, and repaint at DASH_HZ only while the lens sees them, needles and LED following the telemetry', async () => {
    const boat = await heroBoat();
    const level0 = boat.object.levels[0].object;
    const face = locateDash(level0, boat.object.userData);
    expect(face).not.toBeNull();
    const f = face as NonNullable<typeof face>;

    // the tablet screen box (0.235 × 0.155 m): its four front corners are vertices of the merged parts mesh
    const parts = verticesOf(level0.getObjectByName('Parts_LOD0') as THREE.Object3D, level0);
    for (const [su, sv] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const corner = f.tablet.clone().addScaledVector(f.u, su * 0.1175).addScaledVector(f.v, sv * 0.0775);
      const d = Math.min(...parts.map((p) => p.distanceTo(corner)));
      expect(d, `tablet screen corner (${su}, ${sv}) is ${(d * 1000).toFixed(1)} mm from the nearest parts vertex`).toBeLessThan(0.002);
    }
    // each gauge centre is on its glass front, the glass rim (r 0.058) round it in the face plane
    const glass = verticesOf(level0.getObjectByName('GaugeGlass_LOD0') as THREE.Object3D, level0);
    expect(f.gauges).toHaveLength(3);
    expect(f.gauges[0].x).toBeGreaterThan(f.gauges[2].x); // tile 0 = the pilot's left (+x)
    for (const c of f.gauges) {
      const front = glass.filter((p) => Math.abs(p.clone().sub(c).dot(f.n)) < 0.0005 && p.distanceTo(c) < 0.08);
      expect(front.length).toBeGreaterThan(8);
      for (const p of front) {
        const r = p.distanceTo(c);
        if (r > 0.001) expect(Math.abs(r - 0.058), `glass rim radius ${r.toFixed(4)}`).toBeLessThan(0.001);
      }
    }

    // a no-op 2D context stands in for the DOM; it records what is painted as text
    const painted: string[] = [];
    const ctx = new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 0 }) : k === 'fillText' ? (t: string) => painted.push(t) : () => undefined), set: () => true });
    const g = globalThis as unknown as { document?: unknown };
    const hadDocument = 'document' in g;
    g.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ctx }) };
    try {
      boat.object.updateMatrixWorld(true);
      const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.05, 2000);
      const mount = createDashMount(boat, camera);
      expect(mount).not.toBeNull();
      const m = mount as NonNullable<typeof mount>;
      expect(m.meshes.every((mesh) => mesh.parent === level0)).toBe(true);
      let paints = 0;
      const update = m.displays.update.bind(m.displays);
      m.displays.update = (model, dt) => ((paints += 1), update(model, dt));
      const model = createRaceHudModel(8);
      const run = (frames: number): void => {
        for (let i = 0; i < frames; i++) m.update(model, 1 / 120);
      };
      const w = level0.matrixWorld;
      const centre = f.gauges[1].clone().applyMatrix4(w);
      const n = f.n.clone().transformDirection(w);
      const up = f.v.clone().transformDirection(w);
      const aim = (eye: THREE.Vector3, at: THREE.Vector3): void => {
        camera.position.copy(eye);
        camera.up.set(0, 1, 0);
        camera.lookAt(at);
        camera.updateMatrixWorld(true);
      };

      // chase: 9 m aft of the dash and 2.4 m up, looking forward past it — the gauges are a few pixels
      aim(centre.clone().addScaledVector(n, 9).add(new THREE.Vector3(0, 2.4, 0)), centre.clone().addScaledVector(n, -20));
      expect(dashScreenRadius(centre, n, 0.057, camera)).toBeLessThan(DASH_VISIBLE_MIN);
      run(120);
      expect(paints, 'the chase camera repaints the dash').toBe(0);
      expect(m.legible).toBe(false);

      // at the dash from the helm (0.6 m out, 0.2 m above): live at DASH_HZ, and legible
      const helm = centre.clone().addScaledVector(n, 0.6).addScaledVector(up, 0.2);
      aim(helm, centre);
      run(240); // 2 s at 120 fps
      expect(paints).toBeGreaterThanOrEqual(2 * DASH_HZ - 1);
      expect(paints).toBeLessThanOrEqual(2 * DASH_HZ + 1);
      expect(m.legible).toBe(true);

      // hysteresis: backing off to a radius between OFF and ON keeps it legible …
      const mid = (DASH_LEGIBLE_OFF + DASH_LEGIBLE_ON) / 2;
      const depthFor = (r: number): number => (0.057 * camera.projectionMatrix.elements[5]) / (2 * r);
      aim(centre.clone().addScaledVector(n, depthFor(mid)), centre);
      run(12);
      expect(m.legible, 'a bump across the ON threshold must not drop the dash').toBe(true);
      // … looking back over the shoulder hides it from the lens (no repaint) and brings the HUD panels back …
      aim(helm, helm.clone().addScaledVector(n, 5));
      paints = 0;
      run(60);
      expect(paints, 'the dash behind the lens repaints').toBe(0);
      expect(m.legible).toBe(false);
      // … and the same in-between radius does not make it legible again
      aim(centre.clone().addScaledVector(n, depthFor(mid)), centre);
      run(12);
      expect(m.legible).toBe(false);

      // VALUES: the page's telemetry through the HUD model onto the needles and the LED, from the helm
      aim(helm, centre);
      const tel = createHudTelemetry(8);
      const race: RaceState = { phase: 'racing', raceTime: 30, standings: [{ racerId: 0, position: 1, lap: 1, nextElement: 1, progress: 0, gapToLeader: 0, finished: false, state: 'racing', surge: 0 }], lapTimes: [[]] };
      const hc = prepareCourse(COURSE);
      const pilotSees = (mesh: THREE.Mesh): number => {
        // needle tip direction on the face: clockwise from 12 o'clock as the pilot sees it (right = −u)
        const tip = new THREE.Vector3(0, 1, 0).applyQuaternion(mesh.quaternion);
        return Math.atan2(tip.dot(f.u.clone().negate()), tip.dot(f.v));
      };
      const tach = m.meshes.find((x) => x.name === 'DashTachNeedle') as THREE.Mesh;
      const trim = m.meshes.find((x) => x.name === 'DashTrimNeedle') as THREE.Mesh;
      expect(tach.parent).toBe(level0);
      const cases = [
        { rpm: 0, trimDeg: TRIM_DIAL_DEG.min, kn: 5, gov: 'off', tach: -RPM_NEEDLE_SWEEP, trim: -TRIM_NEEDLE_SWEEP, digits: ['5'] },
        { rpm: RPM_MAX / 2, trimDeg: (TRIM_DIAL_DEG.min + TRIM_DIAL_DEG.max) / 2, kn: 42, gov: 'air', tach: 0, trim: 0, digits: ['4', '2'] },
        { rpm: RPM_MAX, trimDeg: TRIM_DIAL_DEG.max, kn: 87, gov: 'full', tach: RPM_NEEDLE_SWEEP, trim: TRIM_NEEDLE_SWEEP, digits: ['8', '7'] },
        // past the stops: pinned, never wrapped round the dial
        { rpm: 2 * RPM_MAX, trimDeg: 40, kn: 87, gov: 'full', tach: RPM_NEEDLE_SWEEP, trim: TRIM_NEEDLE_SWEEP, digits: [] },
      ] as const;
      for (const c of cases) {
        tel.rpm.fill(c.rpm);
        tel.trimDeg = c.trimDeg;
        tel.pitchDeg = 25; // the hull's pitch is NOT the drive trim gauge
        tel.airborne = true;
        tel.speedMps = c.kn / (3600 / 1852);
        tel.governor = c.gov;
        updateRaceHudModel(model, race, hc, 0, tel, 1 / 60);
        painted.length = 0;
        run(1); // needles: this frame
        expect(pilotSees(tach), `tach at ${c.rpm} rpm`).toBeCloseTo(c.tach, 5);
        expect(pilotSees(trim), `trim at ${c.trimDeg}°`).toBeCloseTo(c.trim, 5);
        run(12); // the next paint (≤ 1 / DASH_HZ)
        for (const d of c.digits) expect(painted, `${c.kn} kn on the LED`).toContain(d);
        if (c.digits.length) expect(painted).toContain(`GOV ${c.gov.toUpperCase()}`);
        else expect(painted, 'nothing changed on the LED: no gauge text repaints').not.toContain('GOV FULL');
      }
    } finally {
      if (!hadDocument) delete g.document;
    }
  }, 60_000);
});

const COURSE: Course = {
  id: 't', name: 'Test Reach', laps: 3, startGateId: 'sf', paceLine: [],
  elements: [
    { kind: 'gate', gate: { id: 'sf', left: [-50, 0], right: [50, 0], sector: 'sheltered' } },
    { kind: 'mark', mark: { id: 'm1', at: [0, -500], keepOn: 'port', radius: 20 } },
  ],
  referenceLine: [[0, 0], [0, -1000], [500, -1000], [500, 0]],
  bounds: { min: [-100, -1100], max: [600, 100] },
};

describe('§T.208 dash geometry-free rules', () => {
  it('the backlight dims at night but never goes dark, and a disc behind or beside the lens reads 0', () => {
    expect(dashBrightness(0)).toBe(1);
    expect(dashBrightness(1)).toBeLessThan(dashBrightness(0));
    expect(dashBrightness(1)).toBeGreaterThan(0.3);
    expect(dashBrightness(Number.NaN)).toBe(dashBrightness(0));
    const cam = new THREE.PerspectiveCamera(60, 1, 0.05, 100);
    cam.position.set(0, 0, 1);
    cam.lookAt(0, 0, 0);
    cam.updateMatrixWorld(true);
    const at = new THREE.Vector3();
    const facing = new THREE.Vector3(0, 0, 1);
    // 0.057 m at 1 m under a 60° vertical fov: r · (1/tan 30°) / 2
    expect(dashScreenRadius(at, facing, 0.057, cam)).toBeCloseTo((0.057 / Math.tan(Math.PI / 6)) / 2, 6);
    expect(dashScreenRadius(at, facing.clone().negate(), 0.057, cam), 'seen from behind').toBe(0);
    expect(dashScreenRadius(new THREE.Vector3(5, 0, 0), facing, 0.057, cam), 'off screen').toBe(0);
    expect(dashScreenRadius(new THREE.Vector3(0, 0, 3), facing, 0.057, cam), 'behind the lens').toBe(0);
    // a gauge whose centre is just inside the bottom edge: read as on screen, but never as legible (it is cut in half)
    const edge = new THREE.Vector3(0, -0.55, 0);
    expect(dashScreenRadius(edge, facing, 0.057, cam)).toBeGreaterThan(0);
    expect(dashScreenRadius(edge, facing, 0.057, cam, 0.02), 'clipped by the frame edge').toBe(0);
  });
});
