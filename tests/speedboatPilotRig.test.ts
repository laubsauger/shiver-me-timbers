/**
 * §T.191 render-side boats: the pilot in the seat, the pace boat, the drive spin placeholder, the rooster tail's gate.
 *
 * WHY each block:
 *  - CLIP MAPPING: the steer clips are scrubbed by the helm. A swapped sign puts the pilot's wheel hard left while
 *    the boat turns right — the first thing a player sees in the chase cam and nothing in a physics test catches.
 *  - SEAT SOCKET: the parts GLB carries no seat node, so the socket is derived from two assets' anchors. If either
 *    build moves its eye anchor the derivation must still land on the hull JSON seat station, or the pilot floats
 *    above the pan or sinks into the hull — asserted against the real GLBs on disk, not a copy of their numbers.
 *  - PACE BOAT: race ticks and frames alternate irregularly. Without dead-reckoning the marshal skiff stutters at
 *    display rate; without the cap a stalled race drives it away; without the cut a restart glides it across the bay.
 *  - ROOSTER TAIL: a buried prop throws a boil, a half-exposed one throws the tail. Until the in-tree §T.189/§T.196
 *    physics the deep-V's props ran fully buried at every planing speed (user: "rooster tail not visible yet") and an
 *    `it.fails` pinned that; the §T.197 run found it turned red (props now pierce at full throttle), so it is a plain
 *    `it`: a planing boat that stops throwing a tail is a regression again.
 *  - §T.197 SEATED POSE: the pilot was in every boat and could not be seen — folded under the seat back, eye 0.15 m
 *    above the pan instead of 0.77 m. The scrubbed clips were made additive against `seated_base`, which keys only the
 *    pelvis, so every other bone got its rest rotation applied twice. Checked on the real GLB through GLTFLoader: the
 *    rig as the page drives it (idle base layer + three additive clips at the helm's times) keeps the eye on the
 *    asset's own seated eye, and the naive three conversion does not (so this test fails if the page reverts to it).
 *  - §T.197 LOADER: the NPC skin variant materials are referenced by no mesh; built after the KTX2 loader was disposed,
 *    their texture promise never settled and `createPilots` hung silently. The order is pinned on the source.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../src/core/loop';
import { buildDeepVHull } from '../src/speedboat/hullMesh';
import { createPlayerBoat } from '../src/speedboat/page/playerBoat';
import { gridSlot } from '../src/speedboat/page/course';
import * as THREE from 'three/webgpu';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { makeClipAdditiveToRest, pilotClipTimes, pilotVariantFor, seatSocketFromAnchors } from '../src/speedboat/page/pilotRig';
import { PACE_PREDICT_S, PACE_SNAP_M, createPaceDisplay, stepPaceDisplay } from '../src/speedboat/page/paceBoat';
import { PLACEHOLDER_IDLE_RPM, PLACEHOLDER_RATED_RPM, jetStats, placeholderPropRpm } from '../src/speedboat/page/speedboatFrame';
import type { PropWashInput } from '../src/wake/propWash';
import type { ShipState } from '../src/state/simState';

function glbRootExtras(path: string): Record<string, unknown> {
  const b = readFileSync(new URL(path, import.meta.url));
  const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as { scenes: { nodes: number[] }[]; nodes: { extras?: Record<string, unknown> }[] };
  return json.nodes[json.scenes[0].nodes[0]].extras ?? {};
}

describe('pilot clips follow the helm', () => {
  it('right lock deflects only the right clip to its last frame; left only the left', () => {
    expect(pilotClipTimes({ steer: 1, throttle: 0 })).toEqual({ steerLeft: 0, steerRight: 1, throttle: 0 });
    expect(pilotClipTimes({ steer: -0.5, throttle: 0 })).toEqual({ steerLeft: 0.5, steerRight: 0, throttle: 0 });
  });

  it('the throttle lever rides forward throttle only; reverse and garbage leave it at idle', () => {
    expect(pilotClipTimes({ steer: 0, throttle: 0.6 }).throttle).toBeCloseTo(0.6, 12);
    expect(pilotClipTimes({ steer: 0, throttle: -0.3 }).throttle).toBe(0);
    expect(pilotClipTimes({ steer: Number.NaN, throttle: Number.POSITIVE_INFINITY })).toEqual({ steerLeft: 0, steerRight: 0, throttle: 0 });
  });

  it('NPC pilots are never the player\'s face, and grid neighbours differ', () => {
    for (let i = 0; i < 7; i++) {
      expect(pilotVariantFor(i)).not.toBe('hero');
      expect(pilotVariantFor(i)).not.toBe(pilotVariantFor(i + 1));
    }
  });
});

describe('seat socket from the real assets', () => {
  const boat = glbRootExtras('../assets/models/speedboat_hero.glb');
  const pilot = glbRootExtras('../assets/models/speedboat_pilot.glb');

  it('lands on the hull JSON seat station, inside the hull between keel and deck', () => {
    const s = seatSocketFromAnchors(boat, pilot);
    expect(s).not.toBeNull();
    const anchors = JSON.parse(boat.partsAnchors as string) as { seatZ: number; deckY: number };
    const [x, y, z] = s as [number, number, number];
    expect(x).toBeCloseTo(0, 6);
    expect(z).toBeCloseTo(anchors.seatZ, 3); // two assets' eye anchors must agree on the station
    expect(y).toBeLessThan(anchors.deckY); // the pan sits in the cockpit well, below the sheer deck
    expect(y).toBeGreaterThan(boat.keelY as number);
  });

  it('refuses to guess when an anchor is missing', () => {
    expect(seatSocketFromAnchors({}, pilot)).toBeNull();
    expect(seatSocketFromAnchors(boat, {})).toBeNull();
  });
});

describe('§T.197 the seated pose survives the clips', () => {
  const load = async () => {
    const bytes = readFileSync(new URL('../assets/models/speedboat_pilot.glb', import.meta.url));
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const fakeKtx2 = { load(_u: string, onLoad: (t: THREE.CompressedTexture) => void): void { onLoad(new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format)); } };
    loader.setKTX2Loader(fakeKtx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
    const g = globalThis as unknown as { self?: unknown };
    const hadSelf = 'self' in g;
    if (!hadSelf) g.self = globalThis;
    try {
      return await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
    } finally {
      if (!hadSelf) delete g.self;
    }
  };

  /** the page's mixer set-up (pilotRig build): idle base layer, scrubbed additive steer/throttle clips */
  const poseEye = (gltf: Awaited<ReturnType<typeof load>>, additive: (c: THREE.AnimationClip) => THREE.AnimationClip, steer: number, throttle: number): THREE.Vector3 => {
    const root = gltf.scene.getObjectByName('SB_Pilot') as THREE.Object3D;
    const copy = cloneSkinned(root);
    const clip = (n: string): THREE.AnimationClip => gltf.animations.find((a) => a.name === n) as THREE.AnimationClip;
    const mixer = new THREE.AnimationMixer(copy);
    mixer.clipAction(clip('idle_seated')).play();
    const t = pilotClipTimes({ steer, throttle });
    for (const [name, time] of [['steer_left', t.steerLeft], ['steer_right', t.steerRight], ['throttle_push', t.throttle]] as const) {
      const c = additive(clip(name));
      const a = mixer.clipAction(c);
      a.blendMode = THREE.AdditiveAnimationBlendMode;
      a.setLoop(THREE.LoopOnce, 1);
      a.clampWhenFinished = true;
      a.play();
      a.paused = true;
      a.time = time * c.duration;
    }
    mixer.update(0);
    copy.updateMatrixWorld(true);
    return new THREE.Vector3().setFromMatrixPosition((copy.getObjectByName('cam_eye') as THREE.Object3D).matrixWorld);
  };

  it('helm centred and at full lock: the eye stays on the rig\'s seated bind eye; the naive conversion folds the pilot up', async () => {
    const gltf = await load();
    const root = gltf.scene.getObjectByName('SB_Pilot') as THREE.Object3D;
    const seated = JSON.parse(root.userData.seated as string) as { eye: [number, number, number] };
    const base = gltf.animations.find((a) => a.name === 'seated_base') as THREE.AnimationClip;
    const restOf = (n: string): THREE.Quaternion | null => root.getObjectByName(n)?.quaternion ?? null;
    const ours = (c: THREE.AnimationClip): THREE.AnimationClip => makeClipAdditiveToRest(c, base, restOf);
    // the reference is the rig's own seated bind (clip frame 0 = rest); the extras' `seated.eye` is that eye within a few
    // cm (it is quoted off the build's sockets, 5.5 cm ahead of the cam_eye node today — asset owner note)
    const bindCopy = cloneSkinned(root);
    bindCopy.updateMatrixWorld(true);
    const want = new THREE.Vector3().setFromMatrixPosition((bindCopy.getObjectByName('cam_eye') as THREE.Object3D).matrixWorld);
    expect(want.distanceTo(new THREE.Vector3(...seated.eye))).toBeLessThan(0.08);
    const centred = poseEye(gltf, ours, 0, 0);
    expect(centred.distanceTo(want), `eye ${centred.toArray()} vs seated bind ${want.toArray()}`).toBeLessThan(0.02);
    // a full lock turns the shoulders and head a little; the pilot does not leave the seat
    for (const steer of [-1, 1]) expect(poseEye(gltf, ours, steer, 1).distanceTo(want)).toBeLessThan(0.15);
    // the pre-§T.197 conversion (three's makeClipAdditive against seated_base) is what hid the pilot
    const naive = (c: THREE.AnimationClip): THREE.AnimationClip => THREE.AnimationUtils.makeClipAdditive(c.clone(), 0, base, 30);
    expect(poseEye(gltf, naive, 0, 0).distanceTo(want)).toBeGreaterThan(0.2);
  }, 60_000);

  it('the variant materials are built while the KTX2 loader is alive (a disposed transcoder never settles)', () => {
    const src = readFileSync(new URL('../src/speedboat/page/pilotRig.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('async function loadPilotGltf'), src.indexOf('export async function createPilots'));
    const deps = body.indexOf("getDependencies('material')");
    expect(deps).toBeGreaterThan(0);
    expect(deps).toBeLessThan(body.indexOf('ktx2.dispose()'));
  });
});

describe('pace boat display', () => {
  const pose = { x: 10, z: 20, yaw: 0, speed: 20 };

  it('hidden with no pose (after green), cut onto the first pose', () => {
    const s = createPaceDisplay();
    expect(stepPaceDisplay(s, null, 1 / 60).visible).toBe(false);
    stepPaceDisplay(s, pose, 1 / 60);
    expect([s.visible, s.x, s.z, s.yaw]).toEqual([true, 10, 20, 0]);
    expect(stepPaceDisplay(s, null, 1 / 60).visible).toBe(false);
  });

  it('a repeated pose dead-reckons along yaw (0 = +z) at the published speed, capped', () => {
    const s = createPaceDisplay();
    stepPaceDisplay(s, pose, 1 / 60);
    for (let k = 0; k < 120; k++) stepPaceDisplay(s, pose, 1 / 60);
    // converged on the capped prediction, straight down +z
    expect(s.x).toBeCloseTo(10, 6);
    expect(s.z).toBeCloseTo(20 + 20 * PACE_PREDICT_S, 3);
  });

  it('a new pose resets the prediction; a jump past the snap distance cuts', () => {
    const s = createPaceDisplay();
    stepPaceDisplay(s, pose, 1 / 60);
    stepPaceDisplay(s, { ...pose, z: 20.33 }, 1 / 60);
    expect(s.z).toBeGreaterThan(20);
    expect(s.z).toBeLessThan(20.33);
    stepPaceDisplay(s, { ...pose, x: 10 + PACE_SNAP_M + 5 }, 1 / 60);
    expect(s.x).toBe(10 + PACE_SNAP_M + 5);
  });

  it('yaw follows the short way across ±π', () => {
    const s = createPaceDisplay();
    stepPaceDisplay(s, { ...pose, yaw: Math.PI - 0.05 }, 1 / 60);
    stepPaceDisplay(s, { ...pose, yaw: -Math.PI + 0.05 }, 1 / 60);
    expect(Math.abs(s.yaw)).toBeGreaterThan(Math.PI - 0.06); // never swings through 0
  });
});

describe('drive spin placeholder and rooster tail gate', () => {
  it('props idle at zero throttle, reach rated at full, reverse spins too', () => {
    expect(placeholderPropRpm(0, 3)).toEqual([PLACEHOLDER_IDLE_RPM, PLACEHOLDER_IDLE_RPM, PLACEHOLDER_IDLE_RPM]);
    expect(placeholderPropRpm(1, 3)[2]).toBe(PLACEHOLDER_RATED_RPM);
    expect(placeholderPropRpm(-0.3, 1)[0]).toBeGreaterThan(PLACEHOLDER_IDLE_RPM);
  });

  // §T.199: the tail is thrown at blade-tip speed, so the jet carries its rev/s as the drive publishes it
  // (propWashHullWater); without propRps and a pitch the estimate is 0 rps and nothing is thrown at any immersion.
  const jet = (immersion: number): PropWashInput => ({ x: 0, z: 0, dirX: 0, dirZ: -1, thrust: 6000, discArea: Math.PI * 0.04, depth: 0, advance: 25, immersion, propRps: 50 });

  it('a buried prop throws nothing, a half-exposed one throws the tail', () => {
    expect(jetStats([jet(1)]).roosterRate).toBe(0);
    expect(jetStats([jet(0)]).roosterRate).toBe(0);
    const half = jetStats([jet(0.5)]);
    expect(half.maxExposure).toBeCloseTo(1, 12);
    expect(half.roosterRate).toBeGreaterThan(0);
  });

  function planingJets(throttle: number) {
    const hull = buildDeepVHull();
    const state = { ...gridSlot(0) } as unknown as ShipState;
    const boat = createPlayerBoat({ hull, pressureHeadAt: () => 0 }, state);
    boat.place(gridSlot(0));
    let t = 0;
    for (let k = 0; k < 900; k++) boat.tick({ steer: 0, throttle, trim: 0, surge: false }, (t += SIM_DT));
    return { speed: Math.hypot(state.velocity[0], state.velocity[2]), stats: jetStats(boat.jets([])) };
  }

  // HISTORY (§T.189 physics, before §T.196): 15.9 / 23.5 / 29.4 m/s at throttle 0.3 / 0.6 / 1, prop centres 0.70 / 0.53 /
  // 0.48 m below the surface (r = 0.2 m) ⇒ immersion 1.000 ⇒ exposure 0 ⇒ no rooster tail at any speed.
  it('a planing boat at full throttle has surface-piercing props and throws a rooster tail', () => {
    const { speed, stats } = planingJets(1);
    expect(speed).toBeGreaterThan(20);
    expect(stats.roosterRate).toBeGreaterThan(0);
  }, 60_000);
});
