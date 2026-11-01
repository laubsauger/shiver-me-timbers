/**
 * Get the Drift as one scene group the show drives with the act's own time (direction:
 * drift-narrative/get-the-drift/direction.md and direction-part-b.md): the field of galaxies at Undertime's
 * knots, our galaxy as an impostor that hands over to its ray-marched volume, the stars near the Sun point
 * and the Sun; then Earth (earth.ts), its life (life.ts) and Drift-2's debris spirals (debris.ts).
 */
import * as THREE from 'three/webgpu';
import { uniform } from 'three/tsl';
import type { GetTheDriftParams } from '../../params/getTheDrift';
import type { Vec3 } from '../../cine/domeMaster';
import { EARTH_RADIUS, arrivalEye, arrivalState, beatStarts, domeDir, earthPose, gatherFrame, glideAxis, glideSpin, landingTrack, landingTurn, ourGalaxy, type ArrivalState } from './timeline';
import type { SeaDrive } from '../wandering/sea';
import { createEarth } from './earth';
import { geoFrameAt } from './earthMaps';
import { lifeState } from './life';
import { OUR_LOOK, createGalaxies, type GalaxyAtlas, type GalaxySpec } from './galaxies';
import { diveGalaxies } from './webGalaxies';
import type { WebFrame } from './webDive';
import { FOG as WEB_FOG, type WebKnot } from '../undertime/webVolume';
import { createMilkyWay } from './milkyWay';
import { DEBRIS_SPIN, createDebrisField, debrisPieces } from './debrisField';
import { EARTH_R, SUN_E } from './atmosphere';
import { skyIrradiance, sunlightCpu } from '../wandering/seaSky';
import { CLOUD_TOP } from '../wandering/clouds';

/** rad/s the sky wheels at over Earth, and the s it eases in over */
const SKY_TURN = (0.5 * Math.PI) / 180;
const SKY_EASE = 8;
/** m: the eye's height the sea's scene takes over at (main-drift crossfades there) — low enough that the sea's
 * own ocean and pieces carry the view, high enough that the hand-over is still part of the descent */
const SEA_FROM_ALT = 150;
/** s the sea's clouds take to form, from where the descent comes down through their layer's top (cloudsFrom: ~304 s,
 * 2.3 km up) — under them by ~307 s, formed by ~320 s, before the slow follow at the raft. They formed over 25 s from
 * the hand-over at 150 m until the 2026-10-30 review of the final render ("we go from titanium sky to clouds"): the
 * descent's sky had none, so the cut to the sea showed a clear sky turning into cumulus */
const CLOUDS_FORM = 16;

/** s: the focus on ours (u.focus) starts this long before the ours beat, and takes this long */
const FOCUS_LEAD = 3;
const FOCUS_S = 6;

/**
 * s: the debris MATS on the planet's water (debris.ts driftMatter: the brown turbid arms and their slicks, the field
 * as the planet's sea colour carries it from afar) fade out over this long, ending as the hand-over into the sea's
 * scene begins (`seaFrom`). The sea's scene has no such mats — only the pieces (debrisField.ts), which both scenes
 * draw and so carry on — so the streaks used to vanish inside the 3 s crossfade, a pop at 314–317 s (the coordinator,
 * 2026-11-01). From the hand-over's 150 m (SEA_FROM_ALT) the pieces carry the field on their own.
 */
const MATS_OUT = 6;

const smoothstep01 = (x: number): number => {
  const k = Math.min(1, Math.max(0, x));
  return k * k * (3 - 2 * k);
};

export interface ArrivalAct {
  readonly group: THREE.Group;
  /** s, the act's length */
  readonly total: number;
  /** act s the landing comes down through SEA_FROM_ALT, where the sea's scene takes over */
  readonly seaFrom: number;
  /** act s the descent comes down through the sea's cloud layer's top (wandering/clouds.ts CLOUD_TOP): its clouds form
   * from here (seaDrive's `formFrom`), in the descent's sky and on in the sea's */
  readonly cloudsFrom: number;
  /** the turn from Act 2's world into the debris galaxy's frame (the sea's: x east, y up, z north) */
  readonly toField: THREE.Quaternion;
  /** resolves once the Earth's maps are loaded (a render must wait for it) */
  readonly ready: Promise<void>;
  /** put the act into the state of its time t; returns the state (and the eye's height over the water, Mm) and
   * writes the eye into `eye`, its turn (the landing's levelling out) into `turn` */
  update(t: number, eye: THREE.Vector3, turn: THREE.Quaternion): ArrivalState & { altitude: number };
  setPixelAngle(rad: number): void;
  /**
   * The landing as the sea's scene takes it over (wandering/sea.ts): the eye, its turn and the Sun at act
   * time t, in the frame of Drift-2's debris galaxy (metres: x east, y above the mean sea, z north of its
   * centre); the clouds form from `formFrom` (act s) on
   */
  seaDrive(t: number, formFrom: number): SeaDrive;
  dispose(): void;
}

/**
 * `atlas` must be loaded (its tiles' kinds pick the field's galaxies); `web`, the cosmic web the dive flies through
 * (webDive.ts frame, the web's knots and particles: where the field's galaxies sit)
 */
export function createArrival(p: GetTheDriftParams, e0: Vec3, web: { frame: WebFrame; knots: WebKnot[]; particles: Uint16Array }, tiltDeg: number, atlas: GalaxyAtlas): ArrivalAct {
  const g = ourGalaxy(p, e0, tiltDeg);
  // ours is born a moment after the first of the field, as the dive gathers speed (~85.5 s: "then OUR galaxy")
  const ours: GalaxySpec = { centre: g.centre, normal: g.normal, xAxis: g.xAxis, radius: g.radius, ...OUR_LOOK, appear: 0.62, brightness: 1, tile: -1, planar: true, roll: 0 };
  const specs = diveGalaxies(
    { ...web, ours, size: p.galaxySize, zenith: domeDir(90, 0, tiltDeg), start: arrivalEye(-p.diveLead, p, g) },
    atlas.galaxies,
  );
  const skyTurn = new THREE.Matrix3();
  const u = {
    time: uniform(0), ours: uniform(1), field: uniform(1), radiance: uniform(p.galaxyRadiance), pixelAngle: uniform(0.0015), skyTurn: uniform(skyTurn),
    fog: uniform(WEB_FOG * web.frame.box), focus: uniform(0), oursAt: uniform(new THREE.Vector3(...g.centre)), oursAngle: uniform(0),
  };
  const galaxies = createGalaxies(
    specs,
    { ...u, skyTurn: u.skyTurn as unknown as THREE.Node<'mat3'>, oursAt: u.oursAt as unknown as THREE.Node<'vec3'> },
    atlas,
  );
  const milky = createMilkyWay(g, p.marchSteps);
  const earth = createEarth();
  const group = new THREE.Group();
  group.name = 'get-the-drift';
  group.add(galaxies, milky.group, earth.group);
  const centre = new THREE.Vector3();
  const sun = new THREE.Vector3();
  const waveOrigin = new THREE.Vector3();

  // Drift-2's debris galaxy floats at the gathering point (timeline.ts gatherFrame), in its tangent frame
  const { starts } = beatStarts(p);
  const gf = gatherFrame(p, tiltDeg);
  const up = new THREE.Vector3(...gf.up);
  const east = new THREE.Vector3(...gf.east);
  const north = new THREE.Vector3(...gf.north);
  // the landing levels the eye out over it: level (its up the planet's), heading the dome's front
  const levelFront = new THREE.Vector3(...gf.front);
  const level = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().makeBasis(new THREE.Vector3().crossVectors(levelFront, up), up, levelFront.clone().negate()),
  );
  // Drift-2 looks further down onto the spiral (a pitch about the eye's left–right axis), then the landing levels
  // out from there (timeline.ts landingTurn)
  const lookAxis = new THREE.Vector3(1, 0, 0);
  const eyeTurn = (t: number, out: THREE.Quaternion): THREE.Quaternion => {
    const lt = landingTurn(t, p, tiltDeg);
    return out.setFromAxisAngle(lookAxis, -lt.look).slerp(level, lt.k);
  };
  // from the planet's scene into the debris galaxy's frame (the sea's: x east, y up, z north)
  const toField = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, north)).invert();
  // where the descent comes down through SEA_FROM_ALT (its height falls all the way)
  const comesDown = (alt: number): number => {
    let lo = starts.drift2;
    let hi = starts.landing + p.landing;
    for (let i = 0; i < 40; i++) {
      const mid = (lo + hi) / 2;
      if (landingTrack(mid, p, tiltDeg).alt > alt) lo = mid;
      else hi = mid;
    }
    return hi;
  };
  const hi = comesDown(SEA_FROM_ALT);
  // WHERE ON EARTH (direction.md: "a high angle POV looking eastward"): the matter gathers over the
  // drowned Po plain between Padua and Rovigo (~5–10 m up today), the view heading east. The flood flies
  // ~1300 km east to it, so we arrive over the Bay of Biscay: France below, the Alps, Italy and the Adriatic
  // ahead, the Balkans at the limb, the North Sea to the left, the Mediterranean and the Sahara to the
  // right; a summer dawn rising in the north-east, front left. At 70 m the Po plain becomes a gulf between
  // the Alps and the Apennines.
  const front = new THREE.Vector3(...domeDir(0, 0, tiltDeg));
  front.addScaledVector(up, -front.dot(up)).normalize();
  const rgt = new THREE.Vector3().crossVectors(front, up);
  const h = (p.heading * Math.PI) / 180;
  const geoNorth = front.clone().multiplyScalar(Math.cos(h)).addScaledVector(rgt, -Math.sin(h));
  const geo = geoFrameAt(p.gatherLat, p.gatherLon, up, geoNorth);
  earth.setGeo(geo);
  // THE GLIDE (timeline.ts glideSpin): through the lights the map is turned back a little about glideAxis and turns
  // forward to `geo` by the flood, so the ground streams under the eye faster than the placement alone carries it
  const spinAxis = new THREE.Vector3(...glideAxis(p, tiltDeg));
  const spinTurn = new THREE.Quaternion();
  const geoNow = { north: geo.north.clone(), zero: geo.zero.clone(), east: geo.east.clone() };
  // over Earth the sky wheels slowly about the planet's axis (a time-lapse, as in orbital footage): it eases
  // in from the Earth beat's start to SKY_TURN rad/s; the planet stays put
  const turnStart = starts.earth;
  const turnAt = (t: number): number => {
    const x = t - turnStart;
    if (x <= 0) return 0;
    // ∫ of a rate easing in over SKY_EASE s (smoothstep): closed form
    const e = Math.min(x, SKY_EASE);
    const k = e / SKY_EASE;
    const eased = SKY_EASE * (k * k * k - 0.5 * k * k * k * k);
    return SKY_TURN * (eased + Math.max(0, x - SKY_EASE));
  };
  const turn4 = new THREE.Matrix4();
  // the debris lifts off the drowned coasts late in the flood
  const lift = starts.flood + p.flood * 0.55;
  let pixelAngle = 0.0015;
  // Drift-2's pieces (debrisField.ts), anchored at the gathering point in its tangent frame (x east, y up,
  // z north), metres scaled to the scene's Mm; the same field the sea's scene floats at the raft
  const du = {
    sun: uniform(new THREE.Vector3()),
    sunLight: uniform(new THREE.Vector3()),
    skyLight: uniform(new THREE.Vector3()),
    presence: uniform(0),
    pixelAngle: uniform(0.0015),
    metres: uniform(1e-6),
  };
  const debris = createDebrisField(debrisPieces(), du as unknown as Parameters<typeof createDebrisField>[1]);
  const field = new THREE.Group();
  field.add(debris);
  field.scale.setScalar(1e-6);
  field.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(east, up, north));
  group.add(field);
  const sunLocal = new THREE.Vector3();

  return {
    group,
    total: beatStarts(p).total,
    seaFrom: hi,
    cloudsFrom: comesDown(CLOUD_TOP),
    toField,
    ready: earth.ready,
    update(t, eye, turn) {
      const s = arrivalState(t, p);
      eye.set(...arrivalEye(t, p, g));
      eyeTurn(t, turn);
      u.time.value = t;
      // our galaxy's far disc hands over to its volume; the other galaxies dim once we are inside its
      // dust and stars (they are still there, faintly, through the gaps)
      u.ours.value = 1 - s.volume;
      // THE FOCUS (galaxies.ts; the 2026-10-31 review: the neighbours "stay there for way too long … once we are in
      // the zoom we can focus on the Milky Way"): over FOCUS_S s from FOCUS_LEAD s before the zoom (the ours beat)
      // the others near ours on the sky go out, as far round it as its own disc has grown
      u.focus.value = smoothstep01((t - starts.ours + FOCUS_LEAD) / FOCUS_S);
      u.oursAngle.value = Math.atan(g.radius / Math.max(1e-6, Math.hypot(eye.x - g.centre[0], eye.y - g.centre[1], eye.z - g.centre[2])));
      // (about the map's own north at rest: the glide turns the map, not the sky)
      skyTurn.setFromMatrix4(turn4.makeRotationAxis(geo.north, turnAt(t)));
      spinTurn.setFromAxisAngle(spinAxis, glideSpin(t, p));
      geoNow.north.copy(geo.north).applyQuaternion(spinTurn);
      geoNow.zero.copy(geo.zero).applyQuaternion(spinTurn);
      geoNow.east.copy(geo.east).applyQuaternion(spinTurn);
      earth.setGeo(geoNow);
      u.skyTurn.value.copy(skyTurn);
      // Earth: the planet comes to the eye (earthPose); its Sun takes over from the Milky Way's Sun star over
      // a few seconds (a quick swap reads as a flash). As the sunlit planet grows the sky steps back — the
      // eye (and a camera) loses the faint stars — but only as fast as the planet grows, never as a cut
      const e = earthPose(t, p, tiltDeg);
      const handover = smoothstep01((t - starts.earth + 1) / 5);
      const glare = smoothstep01((e.radiusDeg - 3) / 45) * s.earth;
      // (the volume takes over from the far disc while still a few radii out; the field dims only once we
      // are inside the disk, among its near stars)
      // down in the sunlit air the day sky hides the stars (from ~60 km down to ~15 km, as the Sun clears the
      // horizon below us)
      const sunUp = -(e.sun[0] * e.centreDir[0] + e.sun[1] * e.centreDir[1] + e.sun[2] * e.centreDir[2]);
      const day = smoothstep01((sunUp + 0.05) / 0.2) * smoothstep01((0.06 - (e.distance - EARTH_RADIUS)) / 0.045);
      const night = 1 - 0.97 * day;
      u.field.value = (1 - 0.92 * s.local) * (1 - glare) * night;
      centre.set(...e.centreDir).multiplyScalar(e.distance).add(eye);
      sun.set(...e.sun);
      earth.group.visible = s.earth > 0;
      // Part B: the life layers; the time waves start at the planet's limb straight ahead
      const ahead = domeDir(p.limbEl - 4, 0, tiltDeg);
      const oc = [eye.x - centre.x, eye.y - centre.y, eye.z - centre.z];
      const bb = ahead[0] * oc[0] + ahead[1] * oc[1] + ahead[2] * oc[2];
      const cc = oc[0] * oc[0] + oc[1] * oc[1] + oc[2] * oc[2] - EARTH_RADIUS * EARTH_RADIUS;
      const disc = bb * bb - cc;
      const hitT = disc > 0 ? -bb - Math.sqrt(disc) : -bb;
      waveOrigin.set(eye.x + ahead[0] * hitT - centre.x, eye.y + ahead[1] * hitT - centre.y, eye.z + ahead[2] * hitT - centre.z).normalize();
      const L = lifeState(t, p);
      const drift = {
        up, east, north, time: Math.max(0, t - lift), presence: Math.min(1, Math.max(0, (t - lift) / 6)),
        clear: smoothstep01((t - starts.flood - 0.35 * p.flood) / (0.65 * p.flood + p.drift2 * 0.3)),
        // (the eye in the field's frame, m: the descent's waves are laid out from it, earth.ts ripples)
        eye: ((tr) => [tr.east, tr.alt, tr.north] as [number, number, number])(landingTrack(t, p, tiltDeg)),
      };
      // (the mats out before the hand-over: MATS_OUT; the pieces below keep drift.presence)
      const mats = { ...drift, presence: drift.presence * (1 - smoothstep01((t - (hi - MATS_OUT)) / MATS_OUT)) };
      earth.update({ time: t, centre, sun, presence: s.earth, sunPresence: handover, pixelAngle, eye, life: { ...L, waveOrigin }, drift: mats });
      // the pieces: where the gathering point is now (the planet only translates), turning with the field, lit by
      // the same air as the sea there
      field.visible = drift.presence > 0;
      if (field.visible) {
        field.position.copy(centre).addScaledVector(up, EARTH_RADIUS);
        debris.rotation.y = DEBRIS_SPIN * drift.time;
        du.presence.value = drift.presence;
        du.pixelAngle.value = pixelAngle;
        du.sun.value.copy(sun);
        sunLocal.set(sun.dot(east), sun.dot(up), sun.dot(north));
        const sl = sunlightCpu(EARTH_R, sunLocal.y);
        du.sunLight.value.set(sl[0], sl[1], sl[2]).multiplyScalar(SUN_E / Math.PI);
        const sky = skyIrradiance(EARTH_R, sunLocal);
        du.skyLight.value.set(sky[0], sky[1], sky[2]).multiplyScalar(1 / Math.PI);
      }
      milky.update({
        volume: s.volume * (1 - 0.4 * glare) * night, local: s.local * (1 - 0.55 * glare) * night, sunStar: s.sunStar * (1 - handover),
        radiance: p.volumeRadiance, pixelAngle, eye,
        // (the glow's unresolved stars as we come inside the disk: milkyWay.ts starGrain)
        grain: s.local,
        occluder: { centre, radius: s.earth > 0 ? EARTH_RADIUS * 1.003 : 0 },
        skyTurn,
      });
      return { ...s, altitude: e.distance - EARTH_RADIUS };
    },
    setPixelAngle(rad) {
      pixelAngle = rad;
    },
    seaDrive(t, formFrom) {
      const tr = landingTrack(t, p, tiltDeg);
      const e = earthPose(t, p, tiltDeg);
      const s3 = new THREE.Vector3(...e.sun);
      const fx = levelFront.dot(east);
      const fz = levelFront.dot(north);
      return {
        eye: new THREE.Vector3(tr.east, tr.alt, tr.north),
        yaw: Math.atan2(-fx, -fz),
        turn: eyeTurn(t, new THREE.Quaternion()).premultiply(toField),
        sun: new THREE.Vector3(s3.dot(east), s3.dot(up), s3.dot(north)).normalize(),
        driftTime: Math.max(0, t - lift),
        clouds: smoothstep01((t - formFrom) / CLOUDS_FORM),
      };
    },
    dispose() {
      galaxies.geometry.dispose();
      (galaxies.material as THREE.Material).dispose();
      for (const c of galaxies.children) ((c as THREE.Mesh).material as THREE.Material).dispose();
      milky.dispose();
      earth.dispose();
    },
  };
}
