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
import { WHEEL_LOCK_RAD, cineThrottle, makeClipAdditiveToRest, pilotClipTimes, pilotVariantFor, seatPilots, seatSocketFromAnchors, wheelAngleFor } from '../src/speedboat/page/pilotRig';
import { stepHelm } from '../src/speedboat/assists/steering';
import { assistPreset } from '../src/speedboat/assists/settings';
import { assetFromGltf } from '../src/speedboat/assets/boatModel';
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
    expect(pilotClipTimes({ steer: -1, throttle: 0 })).toEqual({ steerLeft: 1, steerRight: 0, throttle: 0 });
    expect(pilotClipTimes({ steer: -0.5, throttle: 0 }).steerRight).toBe(0);
  });

  // USER (helm fix): "the steering wheel does not actually turn … needs to actually steer and turn properly, with the
  // right speed". The torso/shoulder lean is the steer clip's; the wheel is `wheelAngleFor`. If the clip is scrubbed on
  // a different curve the pilot leans into a turn the wheel has not made (or the reverse).
  it('each steer clip is scrubbed to the frame whose baked wheel turn (90° × ease) is the drawn wheel, held past 90°', () => {
    const ease = (t: number): number => t * t * (3 - 2 * t);
    for (const steer of [0.05, 0.2, 0.4, 0.6, 2 / 3, 0.8, 1]) {
      for (const s of [steer, -steer]) {
        const t = pilotClipTimes({ steer: s, throttle: 0 });
        const clipWheel = (Math.PI / 2) * ease(s > 0 ? t.steerRight : t.steerLeft);
        expect(clipWheel, `steer ${s}`).toBeCloseTo(Math.min(Math.PI / 2, Math.abs(wheelAngleFor(s))), 9);
      }
    }
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

describe('the wheel turns with the drive steer', () => {
  // WHY: the page turns `Helm_LOD0` about its extras; a GLB whose wheel is merged into a static node, or lost its
  // pivot/axis, draws a solid wheel under turning hands (createHelmTurn returns null, silently). Rivals share the hero GLB.
  it.each(['speedboat_hero', 'speedboat_pipeline_test'])('%s.glb: Helm_LOD0 is its own node with a unit axis and its pivot on the rim socket', (name) => {
    const b = readFileSync(new URL(`../assets/models/${name}.glb`, import.meta.url));
    const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString()) as { scenes: { nodes: number[] }[]; nodes: { name?: string; mesh?: number; extras?: Record<string, unknown> }[] };
    const helm = json.nodes.filter((n) => n.name === 'Helm_LOD0');
    expect(helm.length).toBe(1);
    expect(helm[0].mesh).toBeTypeOf('number');
    const ex = helm[0].extras ?? {};
    const vec = (v: unknown): number[] => (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite) ? (v as number[]) : []);
    expect(ex.animRole).toBe('wheel');
    expect(vec(ex.pivot)).toHaveLength(3);
    expect(Math.hypot(...vec(ex.axis))).toBeCloseTo(1, 3);
    const rootExtras = json.nodes[json.scenes[0].nodes[0]].extras ?? {};
    if (typeof rootExtras.partsSockets === 'string') {
      const rim = (JSON.parse(rootExtras.partsSockets) as { wheelRim: { centre: number[] } }).wheelRim;
      expect(Math.hypot(...vec(ex.pivot).map((p, i) => p - rim.centre[i]))).toBeLessThan(0.01);
    }
  });

  // WHY: the wheel was an eased 90° of the steer — small corrections (race-speed drive angles are ≤ 12–16° of the 30°
  // lock) barely moved it while the outboards swung. It is LINEAR in the drive angle: right drive = clockwise (−) as the
  // pilot sees it, and 4× the outboards' angle at every instant.
  it('sign and ratio: right drive turns it clockwise, the wheel angle is WHEEL_LOCK_RAD × the drive fraction', () => {
    expect(WHEEL_LOCK_RAD).toBeCloseTo((120 * Math.PI) / 180, 12);
    expect(wheelAngleFor(1)).toBeCloseTo(-WHEEL_LOCK_RAD, 12);
    expect(wheelAngleFor(-1)).toBeCloseTo(WHEEL_LOCK_RAD, 12);
    for (const s of [0.02, 0.1, 0.4, 0.75]) {
      expect(wheelAngleFor(s)).toBeCloseTo(-s * WHEEL_LOCK_RAD, 12);
      expect(wheelAngleFor(-s)).toBeCloseTo(s * WHEEL_LOCK_RAD, 12);
    }
    expect(wheelAngleFor(3)).toBeCloseTo(-WHEEL_LOCK_RAD, 12);
    expect(Math.abs(wheelAngleFor(Number.NaN))).toBe(0);
  });

  // WHY: "with the right speed". The page feeds the drive angle the physics ran (the helm actuator, `stepHelm` at the
  // assist's rate), so a stick snapped to full lock turns the wheel at the actuator's rate times the ratio — never a snap —
  // and wheel and outboards arrive together.
  it('a stick snap: the wheel follows the rate-limited drive, never faster than the helm rate × ratio', () => {
    const hull = buildDeepVHull();
    const lock = hull.drives[0].maxSteerRad;
    const rate = (assistPreset('default').helmRateDegPerS * Math.PI) / 180;
    const ratio = WHEEL_LOCK_RAD / lock;
    let helm = 0;
    let prev = wheelAngleFor(0);
    let ticks = 0;
    for (; ticks < 1000 && helm < lock; ticks++) {
      helm = stepHelm(helm, 1, lock, rate, SIM_DT);
      const wheel = wheelAngleFor(helm / lock);
      expect(wheel).toBeCloseTo(-helm * ratio, 9); // together with the outboards
      expect(prev - wheel).toBeLessThanOrEqual(rate * ratio * SIM_DT + 1e-9); // right = clockwise, rate-limited
      prev = wheel;
    }
    expect(ticks * SIM_DT).toBeCloseTo(lock / rate, 1); // 1 s to the 30° lock at 30°/s: the wheel takes 1 s to 120° too
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

describe('§T.203 the hands grip the rim in the running rig', () => {
  // USER: "hands of the pilot are not touching the wheel. they are like an inch or so off." The asset's bind grip was
  // right (tests/assetPilot); the page's rig was not: (1) every NPC re-bind refilled the Skeleton.boneInverses array the
  // clones share with the hero, so the hero glove was skinned with NPC proportions (3.5–6 cm off); (2) the steer clips
  // turn the grips round a wheel the page never turned, and the bake's left arm cannot reach a right lock (fingertips
  // 4 cm, thumb 7.5 cm off); (3) the throttle clip lifted the right hand 9–18 cm off the rim at any race throttle.
  // Built through `seatPilots` (what createPilots runs after the load) on the real GLBs, WITH an NPC so the re-bind runs.
  const loadGlb = async (path: string) => {
    const bytes = readFileSync(new URL(path, import.meta.url));
    await MeshoptDecoder.ready;
    const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
    const fakeKtx2 = { load(_u: string, onLoad: (t: THREE.CompressedTexture) => void): void { onLoad(new THREE.CompressedTexture([{ data: new Uint8Array(64), width: 4, height: 4 }] as unknown as ImageData[], 4, 4, THREE.RGBA_ASTC_4x4_Format)); } };
    loader.setKTX2Loader(fakeKtx2 as unknown as Parameters<GLTFLoader['setKTX2Loader']>[0]);
    const g = globalThis as unknown as { self?: unknown };
    const hadSelf = 'self' in g;
    if (!hadSelf) g.self = globalThis;
    try {
      const gltf = await loader.parseAsync(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer, '');
      const materials = (await gltf.parser.getDependencies('material')) as THREE.Material[]; // the NPC skin variants too
      return { gltf, materials };
    } finally {
      if (!hadSelf) delete g.self;
    }
  };

  /** per hand: each fingertip's (distal phalanx, thumb included) closest skinned glove vertex to the rim tube surface, m */
  const fingertipGaps = (pilot: THREE.Object3D, boat: THREE.Object3D): Record<'l' | 'r', number[]> => {
    const rim = (JSON.parse(boat.userData.partsSockets as string) as { wheelRim: { centre: number[]; axis: number[]; radius: number; tube: number } }).wheelRim;
    const hub = new THREE.Vector3(...rim.centre);
    const axis = new THREE.Vector3(...rim.axis).normalize();
    boat.updateMatrixWorld(true);
    const toBoat = boat.matrixWorld.clone().invert();
    const best = new Map<string, number>();
    const v = new THREE.Vector3();
    const rel = new THREE.Vector3();
    pilot.traverse((o) => {
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isSkinnedMesh || !/^Pilot_M_Pilot_LOD0$/.test(mesh.name)) return;
      const geo = mesh.geometry;
      const pos = geo.getAttribute('position');
      const si = geo.getAttribute('skinIndex');
      const sw = geo.getAttribute('skinWeight');
      const morphs = geo.morphAttributes.position ?? [];
      for (let i = 0; i < pos.count; i++) {
        let bone = 0;
        for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, bone)) bone = k;
        const name = mesh.skeleton.bones[si.getComponent(i, bone)].name;
        if (!/^(thumb|index|middle|ring|pinky)_03_[lr]$/.test(name)) continue;
        v.fromBufferAttribute(pos, i);
        morphs.forEach((m, k) => v.addScaledVector(rel.fromBufferAttribute(m, i), mesh.morphTargetInfluences?.[k] ?? 0));
        mesh.applyBoneTransform(i, v);
        v.applyMatrix4(mesh.matrixWorld).applyMatrix4(toBoat);
        rel.subVectors(v, hub);
        const along = rel.dot(axis);
        const gap = Math.hypot(Math.sqrt(Math.max(0, rel.lengthSq() - along * along)) - rim.radius, along) - rim.tube;
        best.set(name, Math.min(best.get(name) ?? Infinity, gap));
      }
    });
    const side = (s: string): number[] => [...best].filter(([n]) => n.endsWith(`_${s}`)).map(([, d]) => d);
    return { l: side('l'), r: side('r') };
  };

  it('helm centred and at either lock, full throttle, hero and NPC: fingertips on the rim (< 1 cm), none lifted (< 2 cm)', async () => {
    const heroGlb = await loadGlb('../assets/models/speedboat_hero.glb');
    const pilotGlb = await loadGlb('../assets/models/speedboat_pilot.glb');
    const asset = assetFromGltf(heroGlb.gltf.scene);
    const hero = asset.instantiate({ variant: 'hero', water: false });
    const npc = asset.instantiate({ variant: 'hero', water: false });
    hero.object.position.set(40, 0.3, -12);
    hero.object.rotation.set(0.05, 1.1, -0.08); // a boat under way, not the identity frame
    const pilots = seatPilots(pilotGlb.gltf, pilotGlb.materials, { hero, npcs: [npc] }, 55);
    const helm = hero.object.getObjectByName('Helm_LOD0') as THREE.Object3D;
    // each hand's grip in the TURNED wheel's frame (boat frame, the helm's turn undone): a hand that rides the rim keeps
    // it; one that slid back because the arm ran out of reach does not. The hand PULLING the rim down (right hand in a
    // right turn) must ride it to full lock — that bounds WHEEL_LOCK_RAD (135° slips it 3.7 cm). The hand reaching across
    // slides along the rim past ~30° at any lock (the bake's reach), so it is held to the fingertip gaps only.
    const gripOnWheel = (p: typeof pilots.hero, boat: THREE.Object3D, s: 'l' | 'r'): THREE.Vector3 => {
      boat.updateMatrixWorld(true);
      const v = new THREE.Vector3().setFromMatrixPosition((p.object.getObjectByName(`hand_${s}`) as THREE.Object3D).matrixWorld);
      const turn = (boat.getObjectByName('Helm_LOD0') as THREE.Object3D).matrix;
      return v.applyMatrix4(boat.matrixWorld.clone().invert()).applyMatrix4(turn.clone().invert());
    };
    const centred = { steer: 0, throttle: 1 };
    pilots.update(0.4, centred, () => centred);
    const home = { hero: { l: gripOnWheel(pilots.hero, hero.object, 'l'), r: gripOnWheel(pilots.hero, hero.object, 'r') }, npc: { l: gripOnWheel(pilots.npcs[0], npc.object, 'l'), r: gripOnWheel(pilots.npcs[0], npc.object, 'r') } };
    for (const steer of [0, 1, -1, 0.5, -0.5]) {
      const controls = { steer, throttle: 1 };
      pilots.update(0.4, controls, () => controls);
      for (const [who, p, boat] of [['hero', pilots.hero, hero], ['npc', pilots.npcs[0], npc]] as const) {
        const pulling = steer >= 0 ? 'r' : 'l';
        const slip = gripOnWheel(p, boat.object, pulling).distanceTo(home[who][pulling]);
        expect(slip, `${who} hand ${pulling} steer ${steer}: ${(slip * 100).toFixed(1)} cm off its grip on the turned rim`).toBeLessThan(0.01);
      }
      for (const [who, p, boat] of [['hero', pilots.hero, hero], ['npc', pilots.npcs[0], npc]] as const) {
        const gaps = fingertipGaps(p.object, boat.object);
        for (const s of ['l', 'r'] as const) {
          expect(gaps[s].length, `${who} ${s} fingertips`).toBe(5);
          const cm = gaps[s].map((d) => (d * 100).toFixed(1)).join(', ');
          expect(Math.min(...gaps[s]), `${who} hand ${s} steer ${steer}: fingertip gaps ${cm} cm`).toBeLessThan(0.01);
          expect(Math.max(...gaps[s]), `${who} hand ${s} steer ${steer}: fingertip gaps ${cm} cm`).toBeLessThan(0.02);
        }
      }
      // the wheel turns under the hands by the angle they are carried round (spokes and grips agree)
      const turned = new THREE.Quaternion().setFromRotationMatrix(helm.matrix);
      expect(2 * Math.acos(Math.min(1, Math.abs(turned.w)))).toBeCloseTo(Math.abs(wheelAngleFor(steer)), 4);
    }
  }, 60_000);

  // TRAILER close-ups (insert 06, windscreen and over-the-shoulder cams): a finger through the rim, a spoke or the throttle
  // handles is the first thing a macro shot shows. The bake's lever grip was solved on a 22 mm cylinder while the three
  // ganged handles are a 60 × 40 mm block: the palm sank 5.7 mm and the ring fingertip came out of the front (31 glove
  // edges crossing). Counted on the skinned LOD0 glove against the boat's own Helm_LOD0 / Throttle_LOD0 triangles.
  it('no glove edge passes through the helm at any lock, or through the throttle lever during the cine push', async () => {
    const heroGlb = await loadGlb('../assets/models/speedboat_hero.glb');
    const pilotGlb = await loadGlb('../assets/models/speedboat_pilot.glb');
    const asset = assetFromGltf(heroGlb.gltf.scene);
    const hero = asset.instantiate({ variant: 'hero', water: false });
    const npc = asset.instantiate({ variant: 'hero', water: false });
    hero.object.position.set(-8, 0.2, 30);
    hero.object.rotation.set(-0.04, -2.3, 0.06);
    const pilots = seatPilots(pilotGlb.gltf, pilotGlb.materials, { hero, npcs: [npc] }, 55);
    /** triangles of a boat node and glove edges (dominant bone on the given hand), both in the boat frame */
    const trianglesOf = (boat: THREE.Object3D, node: string): THREE.Triangle[] => {
      boat.updateMatrixWorld(true);
      const toBoat = boat.matrixWorld.clone().invert();
      const out: THREE.Triangle[] = [];
      (boat.getObjectByName(node) as THREE.Object3D).traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        const pos = m.geometry.getAttribute('position');
        const idx = m.geometry.getIndex();
        const mw = toBoat.clone().multiply(m.matrixWorld);
        const at = (k: number): THREE.Vector3 => new THREE.Vector3().fromBufferAttribute(pos, idx ? idx.getX(k) : k).applyMatrix4(mw);
        for (let t = 0; t < (idx ? idx.count : pos.count); t += 3) out.push(new THREE.Triangle(at(t), at(t + 1), at(t + 2)));
      });
      return out;
    };
    const crossing = (pilot: THREE.Object3D, boat: THREE.Object3D, side: 'l' | 'r', tris: THREE.Triangle[]): { edges: number; closest: number } => {
      const toBoat = boat.matrixWorld.clone().invert();
      let mesh: THREE.SkinnedMesh | undefined;
      pilot.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === 'Pilot_M_Pilot_LOD0') mesh = o as THREE.SkinnedMesh;
      });
      const m = mesh as THREE.SkinnedMesh;
      const geo = m.geometry;
      const [pos, si, sw] = [geo.getAttribute('position'), geo.getAttribute('skinIndex'), geo.getAttribute('skinWeight')];
      const onHand = new RegExp(`^(hand|thumb|index|middle|ring|pinky)(_0[123])?_${side}$`);
      const verts = new Map<number, THREE.Vector3 | null>();
      const vertex = (i: number): THREE.Vector3 | null => {
        if (!verts.has(i)) {
          let b = 0;
          for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, b)) b = k;
          const v = onHand.test(m.skeleton.bones[si.getComponent(i, b)].name) ? m.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(pos, i)).applyMatrix4(m.matrixWorld).applyMatrix4(toBoat) : null;
          verts.set(i, v);
        }
        return verts.get(i) as THREE.Vector3 | null;
      };
      const box = new THREE.Box3();
      for (const t of tris) box.expandByPoint(t.a).expandByPoint(t.b).expandByPoint(t.c);
      const ray = new THREE.Ray();
      const hit = new THREE.Vector3();
      const cp = new THREE.Vector3();
      const index = geo.getIndex() as THREE.BufferAttribute;
      let edges = 0;
      let closest = Infinity;
      for (let t = 0; t < index.count; t += 3) {
        for (let e = 0; e < 3; e++) {
          const a = vertex(index.getX(t + e));
          const b = vertex(index.getX(t + ((e + 1) % 3)));
          if (!a || !b) continue;
          if (e === 0 && box.distanceToPoint(a) < 0.02) for (const tr of tris) closest = Math.min(closest, tr.closestPointToPoint(a, cp).distanceTo(a));
          if (!new THREE.Box3().setFromPoints([a, b]).intersectsBox(box)) continue;
          const len = a.distanceTo(b);
          ray.set(a, b.clone().sub(a).normalize());
          if (tris.some((tr) => ray.intersectTriangle(tr.a, tr.b, tr.c, false, hit) !== null && hit.distanceTo(a) < len)) edges++;
        }
      }
      return { edges, closest };
    };
    for (const steer of [0, 0.5, 1, -0.5, -1]) {
      const controls = { steer, throttle: 1 };
      pilots.update(0.2, controls, () => controls);
      for (const [who, p, boat] of [['hero', pilots.hero, hero], ['npc', pilots.npcs[0], npc]] as const) {
        const helm = trianglesOf(boat.object, 'Helm_LOD0');
        for (const s of ['l', 'r'] as const) expect(crossing(p.object, boat.object, s, helm).edges, `${who} glove ${s} through the helm at steer ${steer}`).toBe(0);
      }
    }
    try {
      cineThrottle.active = true;
      for (const [reach, lever] of [[0.8, 0], [1, 0], [1, 0.5], [1, 1]] as const) {
        cineThrottle.reach = reach;
        cineThrottle.lever = lever;
        const controls = { steer: 0, throttle: 1 };
        for (let i = 0; i < 2; i++) pilots.update(0.2, controls, () => controls);
        const { edges, closest } = crossing(pilots.hero.object, hero.object, 'r', trianglesOf(hero.object, 'Throttle_LOD0'));
        expect(edges, `right glove through the throttle lever at reach ${reach}, lever ${lever}`).toBe(0);
        if (reach === 1) expect(closest, `right glove ${(closest * 1000).toFixed(1)} mm off the handles (holding, not hovering)`).toBeLessThan(0.008);
      }
      // USER (night insert): "fingers mangled … not positioned so each finger takes one lever". With the lever at idle, each
      // of index / middle / ring curls over the front of ITS handle (index on the inboard one): its fingertip glove is nearest
      // that handle, within a few mm, and in front of the handle's centre.
      cineThrottle.reach = 1;
      cineThrottle.lever = 0;
      const still = { steer: 0, throttle: 1 };
      for (let i = 0; i < 2; i++) pilots.update(0.2, still, () => still);
      const th = (JSON.parse(hero.object.userData.partsSockets as string) as { throttleHandle: { position: number[]; pivot: number[]; axis: number[] } }).throttleHandle;
      const axis = new THREE.Vector3(...th.axis).normalize();
      const up = new THREE.Vector3(...th.position).sub(new THREE.Vector3(...th.pivot));
      up.addScaledVector(axis, -up.dot(axis)).normalize();
      const fore = new THREE.Vector3().crossVectors(axis, up);
      const handleCentre = (i: number): THREE.Vector3 => new THREE.Vector3(...th.position).addScaledVector(axis, i * 0.03);
      hero.object.updateMatrixWorld(true);
      const toBoat = hero.object.matrixWorld.clone().invert();
      let glove: THREE.SkinnedMesh | undefined;
      pilots.hero.object.traverse((o) => {
        if ((o as THREE.SkinnedMesh).isSkinnedMesh && o.name === 'Pilot_M_Pilot_LOD0') glove = o as THREE.SkinnedMesh;
      });
      const g = glove as THREE.SkinnedMesh;
      const [pos, si, sw] = [g.geometry.getAttribute('position'), g.geometry.getAttribute('skinIndex'), g.geometry.getAttribute('skinWeight')];
      for (const [finger, own] of [['index', 1], ['middle', 0], ['ring', -1]] as const) {
        const tip: THREE.Vector3[] = [];
        for (let i = 0; i < pos.count; i++) {
          let b = 0;
          for (let k = 1; k < 4; k++) if (sw.getComponent(i, k) > sw.getComponent(i, b)) b = k;
          if (g.skeleton.bones[si.getComponent(i, b)].name === `${finger}_03_r`) tip.push(g.applyBoneTransform(i, new THREE.Vector3().fromBufferAttribute(pos, i)).applyMatrix4(g.matrixWorld).applyMatrix4(toBoat));
        }
        const mean = tip.reduce((a, v) => a.add(v), new THREE.Vector3()).multiplyScalar(1 / tip.length);
        const along = mean.clone().sub(handleCentre(0)).dot(axis) / 0.03;
        expect(Math.abs(along - own), `${finger} fingertip over handle ${along.toFixed(2)} (want ${own}: index inboard, middle centre, ring outboard)`).toBeLessThan(0.5);
        expect(mean.clone().sub(handleCentre(own)).dot(fore), `${finger} fingertip in front of its handle`).toBeGreaterThan(0.01);
      }
    } finally {
      cineThrottle.active = false;
      cineThrottle.reach = 0;
      cineThrottle.lever = 0;
    }
  }, 60_000);
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
