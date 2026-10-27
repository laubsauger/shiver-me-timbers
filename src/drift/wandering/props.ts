/**
 * What happens at sea level beyond the sea, the sky and the raft (drift-narrative/wandering-on/direction.md),
 * each a pure function of the sea's clock and placed by the beat being drawn (beats.ts):
 *
 *   people     figures on the raft (c1–w2): BLOCKING STAND-INS, as the dolphin — no models yet (the user's
 *              call, 2026-10-27: crude placeholders now, real assets in a later pass)
 *   dolphin    c3: circles the raft, surfacing, then flips the blue case onto the deck with its snout
 *   case       the blue hard case; in c4 its radio's dial glows
 *   beams      c4: signals made visible, arcing between far stations below the horizon across the sky,
 *              few at first, more as stations answer — thin, slow, soft-edged, warm (direction.md)
 *   field      w3–w4: Drift 3, Act 1's pairs (events.ts, loops.ts) at a breath of their energy, every pair
 *              meeting its partner — no bursts, no remainder: sensed more than seen
 *   walkers    w5: the wanderers, small, walking on along the waterline into the dusk
 *
 * Sea-scene metres (x east, y up, z north).
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, cameraPosition, float, normalWorld, positionWorld, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import { driftParams } from '../../params/drift';
import { generatePairs } from '../undertime/events';
import { createLoopSprites, createLoopTrails, type LoopUniforms } from '../undertime/loops';

const smooth = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

/** a lit stand-in material (the scene's sun and sky lights it) */
const standIn = (hex: number, roughness = 0.8): THREE.MeshStandardNodeMaterial => {
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness: 0 });
  m.name = 'drift-stand-in';
  return m;
};

/** a figure, standing or sitting (1.7 m tall standing), feet at its origin, facing −z */
function figure(sitting: boolean, hex: number): THREE.Group {
  const g = new THREE.Group();
  const cloth = standIn(hex);
  const skin = standIn(0x8a6a55);
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.19, sitting ? 0.45 : 0.75, 4, 10), cloth);
  body.position.y = sitting ? 0.55 : 1.0;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 8), skin);
  head.position.y = sitting ? 1.05 : 1.6;
  g.add(body, head);
  if (sitting) {
    const legs = new THREE.Mesh(new THREE.CapsuleGeometry(0.09, 0.5, 4, 8), cloth);
    legs.rotation.x = Math.PI / 2;
    legs.position.set(0, 0.25, -0.3);
    g.add(legs);
  }
  g.traverse((o) => {
    o.castShadow = true;
  });
  return g;
}

/** the dolphin stand-in: a spindle body along −z (its snout), a dorsal fin, flukes; 2.4 m */
function dolphin(): THREE.Group {
  const skin = standIn(0x56636f, 0.35);
  const pts: THREE.Vector2[] = [];
  for (let i = 0; i <= 16; i++) {
    const u = i / 16;
    // thickest a third back from the snout, tapering to the tail stock
    const r = 0.28 * Math.sin(Math.PI * Math.pow(u, 0.7)) * (1 - 0.55 * u);
    pts.push(new THREE.Vector2(Math.max(0.01, r), -1.2 + 2.4 * u));
  }
  const bodyGeo = new THREE.LatheGeometry(pts, 14);
  bodyGeo.rotateX(Math.PI / 2);
  const g = new THREE.Group();
  g.add(new THREE.Mesh(bodyGeo, skin));
  const fin = new THREE.Shape();
  fin.moveTo(0, 0);
  fin.lineTo(-0.28, 0.32);
  fin.lineTo(-0.38, 0);
  const finGeo = new THREE.ExtrudeGeometry(fin, { depth: 0.03, bevelEnabled: false });
  finGeo.rotateY(Math.PI / 2);
  const finMesh = new THREE.Mesh(finGeo, skin);
  finMesh.position.set(-0.015, 0.22, 0.05);
  g.add(finMesh);
  const fluke = new THREE.Shape();
  fluke.moveTo(0, 0);
  fluke.lineTo(0.32, 0.22);
  fluke.lineTo(0.1, 0);
  fluke.lineTo(0.32, -0.22);
  const flukeGeo = new THREE.ExtrudeGeometry(fluke, { depth: 0.03, bevelEnabled: false });
  flukeGeo.rotateX(-Math.PI / 2);
  flukeGeo.rotateY(-Math.PI / 2);
  const flukeMesh = new THREE.Mesh(flukeGeo, skin);
  flukeMesh.position.set(0, 0, 1.15);
  g.add(flukeMesh);
  g.traverse((o) => {
    o.castShadow = true;
  });
  return g;
}

/** the wanderers: their clothes, and their heights (m) */
const WALKERS: Array<[number, number]> = [
  [0x3b342d, 1.78],
  [0x5a4a3c, 1.64],
  [0x2f3438, 1.72],
];
/** m/s they walk at, s before w5 they come past the eye, and where along the beach (beats.ts) they start */
const WALK_SPEED = 1.15;
const WALK_LEAD = 1;
const WALK_FROM = 7;

/** a walking figure (feet at its origin, facing −z): legs and arms swinging about the hips and shoulders */
function walker(hex: number, height: number): { group: THREE.Group; stride: (phase: number) => void } {
  const k = height / 1.75;
  const cloth = standIn(hex);
  const skin = standIn(0x7a5c48);
  const group = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.17 * k, 0.48 * k, 4, 10), cloth);
  body.position.y = 1.12 * k;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.11 * k, 14, 10), skin);
  head.position.y = 1.62 * k;
  group.add(body, head);
  const limb = (len: number, r: number, mat: THREE.Material, x: number, y: number): THREE.Group => {
    const pivot = new THREE.Group();
    const m = new THREE.Mesh(new THREE.CapsuleGeometry(r * k, len * k, 3, 8), mat);
    m.position.y = -(len * k) / 2 - r * k;
    pivot.add(m);
    pivot.position.set(x * k, y * k, 0);
    group.add(pivot);
    return pivot;
  };
  const legs = [limb(0.72, 0.07, cloth, -0.09, 0.86), limb(0.72, 0.07, cloth, 0.09, 0.86)];
  const arms = [limb(0.5, 0.05, cloth, -0.23, 1.4), limb(0.5, 0.05, skin, 0.23, 1.4)];
  group.traverse((o) => {
    o.castShadow = true;
    o.receiveShadow = true;
  });
  return {
    group,
    // `phase`: strides walked (one stride is two steps)
    stride(phase) {
      const a = Math.sin(phase * Math.PI * 2);
      legs[0].rotation.x = 0.42 * a;
      legs[1].rotation.x = -0.42 * a;
      arms[0].rotation.x = -0.3 * a;
      arms[1].rotation.x = 0.3 * a;
      body.position.y = 1.12 * k + 0.025 * Math.abs(Math.cos(phase * Math.PI * 2));
      head.position.y = body.position.y + 0.5 * k;
    },
  };
}

export interface PropsState {
  /** sea s, and the beat's start times it is placed by */
  t: number;
  starts: { c3: number; c4: number; w1: number; w2: number; w3: number; w4: number; w5: number; w6: number };
  world: 'flood' | 'open' | 'coast' | 'test';
  eye: THREE.Vector3;
  /** the eye's front, a turn about y (beats.ts) */
  yaw: number;
  raft: THREE.Object3D;
  /** the beach's middle, and the w5 walkers' line (beats.ts: along runs toward −z) */
  beach: { x: number; z: number };
  /** the night's darkness 0..1 (the radio and the beams are lights against it) */
  night: number;
  /** where the eye stands in w3 (the field gathers about it), and the ground's height (m, the sea's 0) */
  fieldEye: THREE.Vector3;
  ground: (x: number, z: number) => number;
}

export interface Props {
  readonly group: THREE.Group;
  /** what glows (added light: the beams, the field) — kept out of the water's mirror, whose capture is cleared
   * transparent and would take their coverage for a dark body */
  readonly glows: THREE.Object3D[];
  update(s: PropsState): void;
  setPixelAngle(rad: number): void;
}

/** the dolphin's surfacings in c3 (s into c3, deg right of the front, m from the eye, m it clears the water
 * by): at last light a dark body only reads against something bright, so it leaps on the Sun's side (c3's
 * Sun sets ~24° left), between the eye and the afterglow and its road on the water — porpoising in, two clear
 * breaches, the flip at the raft's sunward end, away */
const SURFACINGS: Array<[number, number, number, number]> = [
  [4, -62, 20, 0.4],
  [8.5, -46, 16, 1.3],
  [13, -30, 13, 0.5],
  [18, -12, 15, 1.5],
];
const FLIP: [number, number, number, number] = [26, -14, 11, 1.2];
const LEAVE: [number, number, number, number] = [34, -40, 22, 0.8];
/** s the case flies, and how high (m over the line from the water to the deck: up against the sky) */
const FLIGHT = 1.3;
const LOFT = 2.6;
/** the beams: stations' bearings (deg right of the front, just under the horizon), and which answer which,
 * when (s into c4) */
const STATIONS = [-150, -95, -40, 10, 55, 105, 160];
const LINKS: Array<[number, number, number]> = [
  [2, 3, 9], [3, 4, 15], [1, 2, 20], [4, 5, 25], [0, 3, 30], [5, 6, 34], [2, 5, 38], [1, 4, 42], [0, 6, 46],
];
/** m: the beams' sphere about the eye (inside the far plane), and their tube's radius (soft: brightest at its
 * core, a few pixels across in the master) */
const BEAM_R = 9000;
const BEAM_W = 45;

export function createProps(): Props {
  const group = new THREE.Group();
  group.name = 'drift-props';

  // PEOPLE on the raft (raft-local: deck height found below, by a ray onto its planks)
  const people = new THREE.Group();
  const crew: Array<[boolean, number, number, number, number]> = [
    [true, 0x6b4a3a, -0.9, 1.2, 0.6],
    [true, 0x3c4f5e, 0.7, 2.2, -0.5],
    [false, 0x7a6a4a, 0.2, -1.8, 2.6],
  ];
  for (const [sit, hex, x, z, rot] of crew) {
    const f = figure(sit, hex);
    f.position.set(x, 0, z);
    f.rotation.y = rot;
    people.add(f);
  }
  let deckY: number | null = null;

  // THE DOLPHIN and THE CASE
  const fish = dolphin();
  group.add(fish);
  const caseMesh = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.22, 0.4), standIn(0x1f5fa8, 0.45));
  caseMesh.castShadow = true;
  const dialGlow = uniform(0);
  const dialMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  dialMat.colorNode = vec3(1, 0.62, 0.25).mul(dialGlow);
  const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), dialMat);
  dial.rotation.x = -Math.PI / 2;
  dial.position.set(0.08, 0.112, 0.05);
  caseMesh.add(dial);
  // the dial's glow, seen from across the deck (a soft halo facing the eye)
  const haloMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  haloMat.colorNode = Fn(() => {
    const d = uv().sub(0.5).length().mul(2);
    return vec4(vec3(1, 0.6, 0.25).mul(dialGlow.mul(0.35)).mul(float(1).sub(d).max(0).pow(2.5)), 1);
  })();
  const halo = new THREE.Mesh(new THREE.PlaneGeometry(0.5, 0.5), haloMat);
  halo.position.set(0.08, 0.2, 0.05);
  caseMesh.add(halo);
  // and its light on the deck and the sails about it (always in the scene, so the light count never changes)
  const radioLight = new THREE.PointLight(0xffa35a, 0, 7, 2);
  radioLight.position.set(0.08, 0.35, 0.05);
  caseMesh.add(radioLight);
  group.add(caseMesh);

  // THE BEAMS: one tube per link on a sphere about the eye (it follows the eye: they are far)
  const beams = new THREE.Group();
  beams.name = 'drift-beams';
  const beamTime = uniform(0);
  const beamNight = uniform(0);
  // (the outro's network is the memory of c4's: fainter)
  const beamGain = uniform(1);
  const dirAt = (bearingDeg: number, elDeg: number): THREE.Vector3 => {
    const b = (bearingDeg * Math.PI) / 180;
    const e = (elDeg * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(b) * Math.cos(e), Math.sin(e), -Math.cos(b) * Math.cos(e));
  };
  for (const [a, b, at] of LINKS) {
    const A = dirAt(STATIONS[a], -1.5);
    const B = dirAt(STATIONS[b], -1.5);
    // a circle on the sky through both stations and an apex over the bearing between them (a rainbow's
    // shape): the wider the link, the higher it reaches (35–70°), never higher than half the stations' spread
    // (higher, the arc through the apex is the circle's major one: a loop, not an arch)
    let mid = (STATIONS[a] + STATIONS[b]) / 2;
    if (Math.abs(STATIONS[a] - STATIONS[b]) > 180) mid += 180;
    const sep = A.angleTo(B);
    const C = dirAt(mid, Math.min(35 + 35 * (sep / Math.PI), ((sep * 180) / Math.PI) * 0.45));
    const n = new THREE.Vector3().subVectors(B, A).cross(new THREE.Vector3().subVectors(C, A)).normalize();
    const centre = n.clone().multiplyScalar(n.dot(A));
    const ua = A.clone().sub(centre);
    const rho = ua.length();
    ua.normalize();
    const wa = new THREE.Vector3().crossVectors(n, ua);
    const angle = (p: THREE.Vector3): number => {
      const q = p.clone().sub(centre);
      const x = Math.atan2(q.dot(wa), q.dot(ua));
      return x < 0 ? x + 2 * Math.PI : x;
    };
    // round the circle from A through C to B
    let toB = angle(B);
    if (angle(C) > toB) toB -= 2 * Math.PI;
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const ph = (toB * i) / 64;
      pts.push(centre.clone().addScaledVector(ua, rho * Math.cos(ph)).addScaledVector(wa, rho * Math.sin(ph)).normalize().multiplyScalar(BEAM_R));
    }
    const geo = new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 160, BEAM_W, 8, false);
    const mat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
    const start = uniform(at);
    mat.colorNode = Fn(() => {
      const u = uv().x;
      // it grows from the station that calls to the one that answers over 4 s, then a slow pulse runs along it
      const grown = smoothstep(u.sub(0.04), u, beamTime.sub(start).div(4));
      const pulse = sin(u.mul(18).sub(beamTime.mul(0.9))).mul(0.25).add(0.75);
      // soft-edged: brightest where the tube faces the eye
      const facing = abs(normalWorld.dot(cameraPosition.sub(positionWorld).normalize())).pow(3);
      const ends = smoothstep(0, 0.03, u).mul(smoothstep(1, 0.97, u));
      const k = grown.mul(pulse).mul(facing).mul(ends).mul(beamNight);
      return vec4(vec3(1, 0.74, 0.42).mul(k.mul(0.025).mul(beamGain)), 1);
    })();
    const tube = new THREE.Mesh(geo, mat);
    tube.frustumCulled = false;
    beams.add(tube);
  }
  group.add(beams);

  // THE FIELD (Drift 3): Act 1's grammar on the beach, at a breath of its energy
  const P = driftParams;
  const fieldU = {
    time: uniform(0),
    pixelAngle: uniform(0.0015),
    fog: uniform(0),
    matter: uniform(new THREE.Color(P.matterColor)),
    anti: uniform(new THREE.Color(P.antimatterColor)),
    light: uniform(new THREE.Color(P.lightColor)),
    trailRadiance: uniform(0),
    beadRadiance: uniform(0),
    flashRadiance: uniform(0),
    eye: uniform(new THREE.Vector3()),
    pocket: {
      domeAxis: uniform(new THREE.Vector3(0, 1, 0)),
      domeFront: uniform(new THREE.Vector3(0, 0, -1)),
      domeRight: uniform(new THREE.Vector3(1, 0, 0)),
      pocketLo: uniform(0),
      pocketHi: uniform(0),
      pocketAz: uniform(0),
      pocket: uniform(0),
    },
  };
  let fieldBuilt: { trails: THREE.Object3D; sprites: THREE.Object3D } | null = null;
  const fieldGroup = new THREE.Group();
  fieldGroup.name = 'drift-field';
  group.add(fieldGroup);

  // THE WALKERS (w5): three figures with legs and arms that swing as they walk (stand-ins all the same)
  const walkers = new THREE.Group();
  const walkerShapes = WALKERS.map(([hex, h]) => walker(hex, h));
  walkerShapes.forEach((w) => walkers.add(w.group));
  group.add(walkers);

  const tmp = new THREE.Vector3();
  const deckAt = new THREE.Vector3(0.6, 0, -1.4);
  return {
    group,
    glows: [beams, fieldGroup],
    setPixelAngle(rad) {
      fieldU.pixelAngle.value = rad;
    },
    update(s) {
      const { t, starts, world, raft } = s;
      // people ride the raft wherever it goes
      if (deckY === null) {
        // where each stands, found by a ray down onto the raft (raft-local): out from under the cabin's roof
        // (anything over 1.5 m), on the top of what is there (deck, crates: under 1.3 m)
        raft.updateMatrixWorld(true);
        const ray = new THREE.Raycaster();
        const footing = (x: number, z: number): THREE.Vector3 => {
          for (let k = 0; k < 16; k++) {
            const zz = z + Math.sign(z || 1) * 0.5 * k;
            ray.set(new THREE.Vector3(x, 6, zz).applyMatrix4(raft.matrixWorld), new THREE.Vector3(0, -1, 0));
            const ys = ray.intersectObject(raft, true).map((h) => raft.worldToLocal(h.point.clone()).y);
            if (ys.some((y) => y > 1.5)) continue;
            const under = ys.filter((y) => y < 1.3);
            return new THREE.Vector3(x, under.length ? Math.max(...under) : 0.6, zz);
          }
          return new THREE.Vector3(x, 0.6, z);
        };
        people.children.forEach((f) => {
          f.position.copy(footing(f.position.x, f.position.z));
        });
        deckAt.copy(footing(deckAt.x, deckAt.z)).add(new THREE.Vector3(0, 0.11, 0));
        deckY = deckAt.y;
        raft.add(people);
      }
      // (aboard until the raft, aground, is far behind the eye on the beach: gone sooner, they popped out of a
      // raft in plain view as it ran in)
      const aboard = t < starts.w3 + 25;
      people.visible = world !== 'test' && aboard;

      // THE DOLPHIN: from one surfacing to the next under water (eye-relative: it crosses the view in front of
      // the raft), each an arc out of the water; the flip, high; away
      const c3 = t - starts.c3;
      const stops = [...SURFACINGS, FLIP, LEAVE];
      fish.visible = world === 'open' && c3 > stops[0][0] - 3 && c3 < LEAVE[0] + 3;
      if (fish.visible) {
        let i = 0;
        while (i < stops.length - 1 && c3 > stops[i + 1][0]) i++;
        const [ta, ba, da, clear] = stops[i];
        const [tb, bb, db] = stops[Math.min(i + 1, stops.length - 1)];
        const u = tb > ta ? Math.min(1, Math.max(0, (c3 - ta) / (tb - ta))) : 0;
        const bear = ((ba + (bb - ba) * u) * Math.PI) / 180;
        const dist = da + (db - da) * u;
        const at = (bearing: number, d: number): THREE.Vector3 => tmp.set(Math.sin(bearing) * d, 0, -Math.cos(bearing) * d).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(s.eye);
        at(bear, dist);
        const px = tmp.x;
        const pz = tmp.z;
        // heading: along the way to the next stop
        at(((bb * Math.PI) / 180), db);
        const head = Math.atan2(-(tmp.x - px), -(tmp.z - pz));
        // out of the water after each stop, clearing it by `clear` (a breach of a metre and more is out ~2 s),
        // nose up rising, down falling; the flip: head high
        const since = c3 - ta;
        const span = 1.2 + 0.7 * clear;
        const arc = since > 0 && since < span ? since / span : -1;
        const y = arc >= 0 ? -0.8 + (clear + 1.1) * Math.sin(Math.PI * arc) : -1.4;
        const pitch = arc >= 0 ? (i === SURFACINGS.length ? 1.0 : 0.65) * Math.cos(Math.PI * arc) : 0;
        fish.position.set(px, y, pz);
        fish.rotation.set(pitch, head, 0, 'YXZ');
      }

      // THE CASE: from the dolphin's snout onto the deck, then aboard
      const cf = c3 - FLIP[0] - 0.9;
      caseMesh.visible = world !== 'test' && aboard && cf > 0;
      if (caseMesh.visible) {
        raft.updateMatrixWorld(true);
        const end = deckAt.clone().applyMatrix4(raft.matrixWorld);
        if (cf < FLIGHT && world === 'open') {
          const u = cf / FLIGHT;
          const startP = fish.position.clone().add(new THREE.Vector3(0, 0.5, 0));
          caseMesh.position.copy(startP).lerp(end, u);
          caseMesh.position.y += 4 * LOFT * u * (1 - u);
          caseMesh.rotation.set(u * Math.PI * 2.5, raft.rotation.y + u * 1.2, u * 0.8);
        } else {
          caseMesh.position.copy(end);
          caseMesh.quaternion.copy(raft.quaternion).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), 0.4));
        }
      }
      // the radio: its dial glows from c4 on (with the static's flicker), dark again by day
      const radio = smooth((t - starts.c4 + 2) / 4) * (1 - smooth((t - starts.w1 + 3) / 6));
      dialGlow.value = radio * (0.85 + 0.15 * Math.sin(t * 7.3) * Math.sin(t * 2.1)) * 6;
      radioLight.intensity = (dialGlow.value / 6) * 0.08;

      // THE BEAMS: about the eye, in c4's night
      beams.visible = (world === 'open' && t > starts.c4 - 6) || (world === 'coast' && t > starts.w6 - 6);
      beams.position.copy(s.eye);
      beams.rotation.set(0, s.yaw, 0);
      beamTime.value = t - starts.c4;
      beamNight.value = s.night;
      beamGain.value = world === 'coast' ? 0.4 : 1;

      // THE FIELD: w3 swells and settles; it fades through w4
      if (!fieldBuilt && world === 'coast') {
        const events = generatePairs(
          {
            seed: 2103,
            rate: (x) => 30 * smooth((x - starts.w3) / 14) * (1 - smooth((x - starts.w4 - 10) / 20)),
            from: starts.w3 - 2,
            to: starts.w5,
            centre: () => [s.fieldEye.x, s.fieldEye.y + 3, s.fieldEye.z - 12],
            radius: 16,
            eye: () => [s.fieldEye.x, s.fieldEye.y, s.fieldEye.z],
            clearance: 2.5,
            loopRadius: [0.15, 0.5],
            loopTime: [1.2, 2.4],
          },
          30,
        ).filter((e) => e.meets === 1);
        for (const e of events) {
          // no creation burst; and under the energy that draws photons and gammas (loops.ts: rays only above 0.45)
          e.burst = 0;
          e.energy = Math.min(0.4, e.energy * 0.5);
        }
        const U = fieldU as unknown as LoopUniforms;
        fieldBuilt = { trails: createLoopTrails(events, U), sprites: createLoopSprites(events, U) };
        fieldGroup.add(fieldBuilt.trails, fieldBuilt.sprites);
      }
      fieldGroup.visible = world === 'coast' && t > starts.w3 - 3 && t < starts.w5;
      fieldU.time.value = t;
      fieldU.eye.value.copy(s.eye);
      // at the edge of seeing (direction: "like heat shimmer or dust in sunlight"; brighter, the beads read as
      // stars by day in the v9 review)
      fieldU.trailRadiance.value = 0.06;
      fieldU.beadRadiance.value = 0.02;
      fieldU.flashRadiance.value = 0.02;

      // THE WALKERS: from behind the eye on its left, down the wet sand by the waterline, the way the flock went
      const w5 = t - starts.w5 + WALK_LEAD;
      walkers.visible = world === 'coast' && w5 > 0;
      walkerShapes.forEach((w, i) => {
        const walked = WALK_SPEED * Math.max(0, w5 - i * 0.7);
        const along = WALK_FROM + walked - i * 1.5;
        // (2–3 m to the eye's left as they pass it: beats.ts holds the eye at off −8)
        const off = -5.3 + (i - 1) * 0.5 + 0.2 * Math.sin(walked * 0.11 + i);
        const x = s.beach.x - off;
        const z = s.beach.z - along;
        w.group.position.set(x, Math.max(-0.05, s.ground(x, z)), z);
        w.group.rotation.y = 0;
        w.stride(walked / WALKERS[i][1]);
      });
    },
  };
}
