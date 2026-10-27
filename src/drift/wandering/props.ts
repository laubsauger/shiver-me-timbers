/**
 * What happens at sea level beyond the sea, the sky and the raft (drift-narrative/wandering-on/direction.md),
 * each a pure function of the sea's clock and placed by the beat being drawn (beats.ts):
 *
 *   people     figures on the raft (c1–w2): BLOCKING STAND-INS — no models yet (the user's call, 2026-10-27:
 *              crude placeholders now, real assets in a later pass)
 *   dolphin    c3: porpoising in, circling the raft, then flips the blue case onto the deck with its snout
 *              (dolphin.ts: its outline and its motion)
 *   case       the blue hard case; in c4 its radio's dial glows
 *   beams      c4: signals made visible, arcing between far stations below the horizon across the sky,
 *              few at first, more as stations answer — thin, slow, soft-edged, warm (direction.md)
 *   field      w3–w4: Drift 3, Act 1's pairs (events.ts, loops.ts) at a breath of their energy, every pair
 *              meeting its partner — no bursts, no remainder: sensed more than seen; and again in w6, over
 *              the eye as it rises into the night, among the stars
 *   walkers    w5: the wanderers, small, walking on along the waterline into the dusk
 *
 * Sea-scene metres (x east, y up, z north).
 */
import * as THREE from 'three/webgpu';
import { Fn, abs, cameraPosition, float, normalWorld, positionWorld, sin, smoothstep, uniform, uv, vec3, vec4 } from 'three/tsl';
import { driftParams } from '../../params/drift';
import { generatePairs } from '../undertime/events';
import { spec } from './beats';
import { createLoopSprites, createLoopTrails, type LoopUniforms } from '../undertime/loops';
import type { Vec3 } from '../../cine/domeMaster';
import { DOLPHIN_SPAN, FLIP_RELEASE, createDolphin, flipThrow } from './dolphin';
import { dolphinPose } from './dolphin';

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
  /** the sky's radiance just above the horizon (linear): the far islands are hazed into it */
  horizon: THREE.Color;
  /** where the eye stands in w3 (the field gathers about it), and the ground's height (m, the sea's 0) */
  fieldEye: THREE.Vector3;
  /** where the eye is on the coast at sea time t (w6's field gathers over it as it rises) */
  coastEyeAt: (t: number) => THREE.Vector3;
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

/** the case's throw: m on from the snout it lands, m it rises over the snout (up against the afterglow), m/s² */
const CASE_REACH = 3.0;
const CASE_LOB = 1.0;
const G_CASE = 9.81;
/** the beams: stations' bearings (deg right of the front), and which answer which, when (s into c4). Each
 * station is a light on a low island on the horizon (STATION_*): the beams start and end at its light, so they
 * point at something (they had met in empty sky just under the horizon: the v9 review) */
const STATIONS = [-150, -95, -40, 10, 55, 105, 160];
/** m: how far the stations' islands lie, their islands' radius and height (seeded per station, ±40%), and the
 * light's height over the island's top */
const STATION_DIST = 7000;
const STATION_R = 380;
const STATION_H = 55;
const BEACON_UP = 6;
const LINKS: Array<[number, number, number]> = [
  [2, 3, 9], [3, 4, 15], [1, 2, 20], [4, 5, 25], [0, 3, 30], [5, 6, 34], [2, 5, 38], [1, 4, 42], [0, 6, 46],
];
/** m: the beams' sphere about the eye (inside the far plane), and their tube's radius (soft: brightest at its
 * core, a few pixels across in the master) */
const BEAM_R = 9000;
const BEAM_W = 30;

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
  const dolphin = createDolphin();
  const fish = dolphin.group;
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
  // THE STATIONS: a low island on the horizon each (a flattened dome, its height and width seeded), dark, hazed
  // most of the way into the horizon's own colour (7 km of marine air), and its light on top (night only)
  const stations = new THREE.Group();
  stations.name = 'drift-stations';
  const uHorizon = uniform(new THREE.Color());
  const islandMat = new THREE.MeshBasicNodeMaterial({ fog: false });
  // (a silhouette a little darker than the sky behind it, never black: the haze between)
  islandMat.colorNode = (uHorizon as unknown as THREE.Node<"vec3">).mul(0.55);
  const beaconMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  beaconMat.colorNode = Fn(() => {
    const q = uv().sub(0.5).mul(2);
    const r = q.length();
    // a point and its glow in the haze (the quad is 0.5° wide at the stations' range: the core ~3 px in a 2k master)
    const core = smoothstep(0.3, 0.0, r);
    const halo = smoothstep(1, 0, r).pow(2).mul(0.35);
    return vec4(vec3(1, 0.7, 0.38).mul(core.mul(3).add(halo).mul(beamNight).mul(beamGain)), 1);
  })();
  // …and its road on the water below it: a light on the horizon is a column of glitter down to the eye (the mirror
  // fades out at 2.5 km, the stations are 7 km off)
  const roadMat = new THREE.MeshBasicNodeMaterial({ transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: false, side: THREE.DoubleSide });
  roadMat.colorNode = Fn(() => {
    const q = uv();
    const across = smoothstep(0.5, 0, q.x.sub(0.5).abs());
    // brightest toward the horizon (q.y = 1), broken into glints along it
    const along = float(0.2).add(q.y.pow(2).mul(0.8));
    const glint = sin(q.y.mul(173).add(beamTime.mul(2.1))).mul(sin(q.y.mul(61).sub(beamTime.mul(1.3)))).mul(0.5).add(0.5);
    return vec4(vec3(1, 0.68, 0.36).mul(across.mul(along).mul(glint.pow(3)).mul(2.5).mul(beamNight).mul(beamGain)), 1);
  })();
  const beaconDir: THREE.Vector3[] = [];
  // one road along −z (turned to each bearing): a trapezoid from 150 m to the station, half-width ∝ distance
  const roadGeo = (() => {
    const g = new THREE.BufferGeometry();
    const n = 24;
    const pos: number[] = [];
    const uvs: number[] = [];
    const idx: number[] = [];
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      // (spaced geometrically: as many rows near as far)
      const d = 150 * Math.pow(STATION_DIST / 150, u);
      const w = d * 0.0045;
      pos.push(-w, 0, -d, w, 0, -d);
      uvs.push(0, u, 1, u);
      if (i < n) idx.push(2 * i, 2 * i + 1, 2 * i + 2, 2 * i + 1, 2 * i + 3, 2 * i + 2);
    }
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    g.setIndex(idx);
    return g;
  })();
  STATIONS.forEach((bearing, i) => {
    const k = (n: number): number => 0.6 + 0.8 * ((Math.sin((i + 1) * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
    const h = STATION_H * k(1);
    const r = STATION_R * k(2);
    const dome = new THREE.Mesh(new THREE.SphereGeometry(1, 24, 8, 0, Math.PI * 2, 0, Math.PI / 2), islandMat);
    const at = dirAt(bearing, 0).multiplyScalar(STATION_DIST);
    dome.position.set(at.x, -h * 0.15, at.z);
    dome.scale.set(r, h, r * 0.7);
    dome.rotation.y = (-bearing * Math.PI) / 180;
    stations.add(dome);
    const top = new THREE.Vector3(at.x, h * 0.85 + BEACON_UP, at.z);
    beaconDir.push(top.clone().normalize());
    const beacon = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), beaconMat);
    beacon.position.copy(top);
    beacon.lookAt(0, top.y, 0);
    stations.add(beacon);
    // the road: flat on the sea from near the eye out to the island's foot, a constant ~0.5° wide as seen from
    // the eye (a strip of constant width is a sub-pixel line at the horizon and a slab close by)
    const road = new THREE.Mesh(roadGeo, roadMat);
    road.rotation.y = (-bearing * Math.PI) / 180;
    // (1.6 m over the mean sea, under the night eye (2.2 m and up): lower, the sea hid it; from 150 m out, as a
    // road comes in to the one who sees it)
    road.position.y = 1.6;
    // (after the sea: both transparent, sorted by place, and the sea writes depth)
    road.renderOrder = 2;
    stations.add(road);
  });
  group.add(stations);

  for (const [a, b, at] of LINKS) {
    // from station to station, light to light (on the beams' sphere, along the lights' own directions)
    const A = beaconDir[a].clone();
    const B = beaconDir[b].clone();
    // a circle on the sky through both stations and an apex over the bearing between them (a rainbow's
    // shape): the wider the link, the higher it reaches (35–70°), never higher than half the stations' spread
    // (higher, the arc through the apex is the circle's major one: a loop, not an arch)
    let mid = (STATIONS[a] + STATIONS[b]) / 2;
    if (Math.abs(STATIONS[a] - STATIONS[b]) > 180) mid += 180;
    const sep = A.angleTo(B);
    // (at most 55° up: higher, the arcs between far-apart stations ran through the zenith as straight lines)
    const C = dirAt(mid, Math.min(25 + 30 * (sep / Math.PI), ((sep * 180) / Math.PI) * 0.4));
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
      const ends = smoothstep(0, 0.01, u).mul(smoothstep(1, 0.99, u));
      // the haze: low over the sea a beam is seen through kilometres more air, and dims into the horizon
      const up = positionWorld.sub(cameraPosition).normalize().y;
      const haze = smoothstep(-0.01, 0.2, up).mul(0.75).add(0.25);
      const k = grown.mul(pulse).mul(facing).mul(ends).mul(haze).mul(beamNight);
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

      // THE DOLPHIN (dolphin.ts), in the eye's level frame: x right, z ahead
      const c3 = t - starts.c3;
      fish.visible = world === 'open' && c3 > DOLPHIN_SPAN[0] && c3 < DOLPHIN_SPAN[1];
      if (fish.visible) {
        const d = dolphinPose(c3);
        tmp.set(d.x, 0, -d.z).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(s.eye);
        fish.position.set(tmp.x, d.y, tmp.z);
        // (its body along −z: heading 0 is ahead, −z in the eye's frame)
        fish.rotation.set(d.pitch, s.yaw - d.heading, 0, 'YXZ');
        dolphin.set(d);
      }

      // THE CASE: flicked from the dolphin's snout as it rises in the flip, along its heading (it carries on where
      // the dolphin was going), lobbed a metre over the snout and falling onto the deck there; then aboard
      const cf = c3 - FLIP_RELEASE;
      caseMesh.visible = world !== 'test' && aboard && cf > 0;
      if (caseMesh.visible) {
        raft.updateMatrixWorld(true);
        const throwAt = flipThrow();
        const toWorld = (x: number, y: number, z: number): THREE.Vector3 =>
          new THREE.Vector3(x, 0, -z).applyAxisAngle(new THREE.Vector3(0, 1, 0), s.yaw).add(new THREE.Vector3(s.eye.x, y, s.eye.z));
        const from = toWorld(...throwAt.from);
        // where it lands: CASE_REACH m on along the heading, on the deck (raft-local deck height), every frame from
        // the raft's pose now (pure in t)
        const land = raft.worldToLocal(toWorld(throwAt.from[0] + throwAt.dir[0] * CASE_REACH, 0, throwAt.from[2] + throwAt.dir[1] * CASE_REACH));
        land.y = deckY ?? 0.6;
        const end = raft.localToWorld(land.clone());
        const vy0 = Math.sqrt(2 * G_CASE * CASE_LOB);
        const flight = (vy0 + Math.sqrt(vy0 * vy0 + 2 * G_CASE * Math.max(0, from.y - end.y))) / G_CASE;
        if (cf < flight && world === 'open') {
          const u = cf / flight;
          caseMesh.position.lerpVectors(from, end, u);
          caseMesh.position.y = from.y + vy0 * cf - 0.5 * G_CASE * cf * cf;
          // tumbling end over end about the axis across its flight
          caseMesh.rotation.set(0, s.yaw - Math.atan2(throwAt.dir[0], throwAt.dir[1]), 0, 'YXZ');
          caseMesh.rotateX(-u * Math.PI * 1.5);
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
      // the stations' islands are on the open sea's horizon all along (the coast's are the archipelago's)
      stations.visible = world === 'open' || beams.visible;
      stations.position.set(s.eye.x, 0, s.eye.z);
      stations.rotation.set(0, s.yaw, 0);
      (uHorizon.value as THREE.Color).copy(s.horizon);
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
        // w6: over the eye as it rises into the night, wider and slower, the loops larger (seen from tens of
        // metres, against the stars)
        const night = generatePairs(
          {
            seed: 2106,
            rate: (x) => 25 * smooth((x - starts.w6 - 4) / 18),
            from: starts.w6 - 2,
            to: starts.w6 + spec('w6')!.length,
            centre: (x) => {
              const e = s.coastEyeAt(x);
              return [e.x, e.y + 24, e.z - 18];
            },
            radius: 34,
            eye: (x) => s.coastEyeAt(x).toArray() as Vec3,
            clearance: 7,
            loopRadius: [0.5, 1.6],
            loopTime: [1.6, 3.2],
          },
          25,
        ).filter((e) => e.meets === 1);
        events.push(...night);
        for (const e of events) {
          // no creation burst; and under the energy that draws photons and gammas (loops.ts: rays only above 0.45)
          e.burst = 0;
          e.energy = Math.min(0.4, e.energy * 0.5);
        }
        const U = fieldU as unknown as LoopUniforms;
        fieldBuilt = { trails: createLoopTrails(events, U), sprites: createLoopSprites(events, U) };
        fieldGroup.add(fieldBuilt.trails, fieldBuilt.sprites);
      }
      fieldGroup.visible = world === 'coast' && ((t > starts.w3 - 3 && t < starts.w5) || t > starts.w6 - 3);
      fieldU.time.value = t;
      fieldU.eye.value.copy(s.eye);
      // at the edge of seeing (direction: "like heat shimmer or dust in sunlight"; brighter, the beads read as
      // stars by day in the v9 review)
      // (at night the eye has opened to the stars: the same radiance read as scribbles over the Milky Way)
      const dim = t > starts.w6 - 3 ? 0.6 : 1;
      fieldU.trailRadiance.value = 0.06 * dim;
      fieldU.beadRadiance.value = 0.02 * dim;
      fieldU.flashRadiance.value = 0.02 * dim;

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
