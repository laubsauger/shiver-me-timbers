/**
 * Part C's raft (drift-narrative/wandering-on/direction.md, C1–C3): the game's own raft — its logs, deck and
 * square sail (ship/raftBlueprint.ts through ShipAssembly) — afloat on the sea test act's ocean.
 *
 * In the game the raft's pose is physics (buoyancy integrated step by step), which a frame rendered on its
 * own cannot reproduce. Here it is a pure function of time instead: the sea's height (CpuOcean) under its
 * log contact points, averaged over the last second or so (a raft does not follow every ripple), fitted
 * with a plane — heave from its mean, pitch and roll from its slopes. The logs' centreline is the waterline
 * (raftParams.logAxisY = 0), so the heave is the raft's height.
 *
 * The sail's (and the flag's) glow is the game's: a backlit transmission and an ambient floor added as emission at fixed
 * strength (tuned at the game's fixed exposure). Under the dome's adapting exposure they lit the sails at
 * night, so they are scaled here by the light that is actually there: the transmission by the sunlight
 * reaching the sea, the floor by the sky's light against the day's.
 *
 * The pennant is struck: its flutter integrates a phase from the renderer's frame clock (flagDriver.ts),
 * which is wall time — offline, at a few frames a second, it flapped ten times too fast (a "hyperlapse"). The
 * square sail's driver (sailDriver.ts) runs on the same clock, so for the film it is held STILL: set full and
 * drawing (the v8 notes: furled, the raft read as "screwed on rails"), its flutter, luff flap, gusts and turn
 * skew off, its response fast, so the belly is the wind's alone — a steady sail on a light steady air, the same
 * in every frame. `sails` hoists it (0 furled: the cloth gone, the yard lowered; 1 set) as a continuous trim.
 *
 * The ropes: not the game's (a Verlet solve carried frame to frame) but its plan, laid afresh each frame between the
 * same live sockets (raftRigLines.ts). Not yet: the deck water (a simulation).
 */
import * as THREE from 'three/webgpu';
import { buildRaftBlueprint } from '../../ship/raftBlueprint';
import { buildRaftDeckField } from '../../ship/raftDeckField';
import { createDeckFieldTexture } from '../../ship/deckFieldTexture';
import { createPieceMaterialCache } from '../../core/bootShared';
import { ShipAssembly } from '../../ship/shipAssembly';
import { raftMaterialParams } from '../../params/raftMaterials';
import { raftParams } from '../../params/raft';
import { createDeckWater, setActiveDeckWater } from '../../deckwater';
import { raftContactPoints } from '../../sailing/raftBeaching';
import { shipFlagParams, shipMaterialParams } from '../../params/ship';
import { refreshShipMaterials } from '../../ship/pieceMaterials';
import { writeSailWindFrame } from '../../ship/sailFrame';
import { createRaftLanterns } from '../../ship/raftLanterns';
import { blueprintAabb } from '../../ship/previewRaft';
import { waterlineFromBlueprint, waterlineFromBox } from '../../sea-physics/hullContact';
import { raftLayout } from '../../ship/raftPartsLayout';
import { createRaftLook, filmWaterline } from '../../ship/raftLook';
import { dressRaft } from '../../ship/raftDress';
import { createRaftRigLines } from './raftRigLines';

/** s the sea's height is averaged over, and how many instants — CENTRED on t (t ± SETTLE/2: the film's sea is a pure
 * function of time, so the instants ahead are as known as those behind). A trailing window lagged the swell by
 * SETTLE/2: over the lagoon's shoaled swell (half a metre a second at its steepest) the raft rode 12–14 cm high on
 * falling water and as low on rising (545–551 s, measured against the CpuOcean under it) — its logs out of the
 * water, "floating ON it" (2026-10-29) */
const SETTLE = 1.2;
const SAMPLES = 5;

export interface RaftProp {
  readonly group: THREE.Group;
  /** its waterline's ends (m along the bow axis, +z) and full breadth: what its wake is shed from (raft/raftScene.ts's own) */
  readonly hull: { stemZ: number; transomZ: number; beam: number };
  /** resolves once its film dressing (raftLook.ts's scans, raftProps.ts's models) is loaded: await before drawing */
  readonly ready: Promise<void>;
  /**
   * the raft's pose at time t, at (x, z) on the sea heading `heading` rad (0: bow toward +z); `sun` and `sky`
   * are the light there against the day's (0..1: the sunlight's luminance, the sky's irradiance); `windTo` and
   * `windSpeed` the air its sail stands in (rad, toward; m/s), where it is not the sea's
   */
  update(t: number, x: number, z: number, heading: number, light: { sun: number; sky: number }, sails?: number, speed?: number, windTo?: number, windSpeed?: number): void;
}

/** the film's still sail (see the header): the game's cloth with everything that moves it from frame to frame off */
const STILL_SAIL = { sailFlutterAmp: 0.015, sailLuffFlap: 0, sailGustAmp: 0, sailTurnSkew: 0, sailResponse: 12, sailWindRef: 2.4 };

/** m/s of apparent wind at which the film's canvas reads full. The film's true wind is the light air its ripples
 * are built from (2.5 m/s), so a raft running before it at 1.2 m/s sees ~1.3 m/s: at the game's 4.2 the sail hung
 * 9% full, flat as a board ("a little more fullness in the sails", the v9 review). At 1.4 it is ~60% full under
 * way and full at rest; the waves keep their wind. */
const FILM_SAIL_WIND_REF = 1.4;

/** the lanterns' glass and light against the game's full night (the user, 2026-10-29: "tone down the lights ever so
 * slightly on the boat, especially going into the night") */
const LANTERNS = 0.72;
/** its logs in plan (m: x to starboard, the bow +z): the blueprint's own layout (raftPartsLayout.ts) */
export function raftLogsInPlan(): Array<{ x: number; r: number; zStern: number; zBow: number }> {
  return raftLayout(raftParams).logs.map((l) => ({ x: l.x, r: l.r, zStern: l.zStern, zBow: l.zBow }));
}

/** the fore guaras' depth in the film (0 hauled clear … 1 fully down: ShipAssembly.setGuaraDepths): their heads
 * 2 cm over their collars, under anything the main course sweeps */
const FORE_GUARA_DEPTH = 0.8;
/** REVIEW ONLY: `drift.html?raftplain` draws the hero raft as the game builds it, undressed (an A/B against
 * raftLook.ts / raftDress.ts) */
const PLAIN = typeof location !== 'undefined' && new URLSearchParams(location.search).has('raftplain');
/** the least drop the sails are set to (0..1 of the cloth's drop): struck, but not degenerate (see `update`) */
const SAIL_STRUCK = 0.01;
/** the furled roll lashed to its yard (pieceGeometrySail.ts `furlLash`), packed to this share of the game's bundle
 * radius: the main's ~0.2 m thick, about the yard's own girth and a half, against the game's half-metre swags (the
 * 2026-11-01 review of the struck sail at 590 s: a bare yard, then balloons on a string) */
const FILM_FURL_PACK = 0.6;
/** `far`: a raft seen only on the horizon (its lanterns carry no point lights: raftLanterns.ts) */
export function createRaft(heightAt: (x: number, z: number, t: number) => number, o: { far?: boolean } = {}): RaftProp {
  // (read into each sail's shape as the blueprint is built)
  raftParams.sailWindRef = FILM_SAIL_WIND_REF;
  const blueprint = buildRaftBlueprint();
  // the film's furl: the roll snug on its yard, lashed every arm's length (read as each sail's geometry is built)
  for (const def of blueprint) if (def.sailStates && def.shape) def.shape.furlLash = FILM_FURL_PACK;
  const deckField = buildRaftDeckField(blueprint);
  // the deck material reads the active deck water at construction (raft/raftScene.ts): bound, never stepped
  setActiveDeckWater(createDeckWater({ source: deckField }));
  const pieceMaterials = createPieceMaterialCache(createDeckFieldTexture(deckField));
  // THE HERO RAFT'S OWN SURFACES (raftLook.ts: scans with parallax for the walls, the thatch and the boards; a
  // fibre sheen on the hemp and the mats) — a far raft is a few pixels on the horizon and keeps the game's
  const look = o.far || PLAIN ? null : createRaftLook(pieceMaterials, { tier: 'film' });
  const assembly = new ShipAssembly(blueprint, look?.factory ?? pieceMaterials);
  assembly.setSailTint(raftMaterialParams.sailTint);
  // set full once; hoisted and furled after by the continuous trim (the cloth's drop, the yard's hoist)
  Object.assign(shipMaterialParams, STILL_SAIL);
  const sailIds: string[] = [];
  for (const def of blueprint) {
    if (!def.sailStates) continue;
    assembly.setSailState(def.id, 'full');
    assembly.setSailDropScale(def.id, 0);
    assembly.setYardHoist(def.id, 0);
    sailIds.push(def.id);
  }
  const pennant = assembly.group.getObjectByName('flag-stern');
  if (pennant) pennant.visible = false;
  assembly.group.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  const group = new THREE.Group();
  group.name = 'drift-raft';
  group.add(assembly.group);
  // …and dressed for a close camera (raftDress.ts: worn edges, the cabin's frame, real stores for the boxes)
  const dressed = look ? dressRaft(assembly.group, blueprint, look.factory, { tier: 'film' }) : null;
  look?.track(assembly.group);
  // its rigging — the game's plan, laid each frame between the live sockets (raftRigLines.ts): sheets, braces, lifts,
  // halyards and stays, so no clew or yard hangs free (the user, 2026-10-30: the topsail and the mizzen "don't really
  // have a connection to the top with any kind of ropes")
  const rig = look ? createRaftRigLines(assembly, blueprint, look.factory('lashing', 'base'), group) : null;
  // the fore centreboards worked down to just proud of their collars (the user: "the blades on the front pierce
  // the sail in some moments" — at the blueprint's half depth they stood a metre up under the course, which the
  // cloth sweeps through as the yard is lowered and hoisted); the aft pair, clear of the sail, as built
  if (look) assembly.setGuaraDepths([FORE_GUARA_DEPTH, FORE_GUARA_DEPTH, FORE_GUARA_DEPTH]);
  // the lanterns under the roof's corners (the game's), lit as the sunlight goes
  const lanterns = createRaftLanterns(undefined, { lights: !o.far });
  assembly.group.add(lanterns.group);
  const contacts = raftContactPoints();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const backlit = shipMaterialParams.sailBacklitStrength;
  const ambientLift = shipMaterialParams.sailAmbientLift;
  const flagLift = shipFlagParams.flagAmbientLift;

  // (the loft finds no hull section on the logs: the box fallback, as the game's raft)
  const box = blueprintAabb(blueprint);
  const beamHalf = Math.max(box.max[0], -box.min[0]);
  const waterline = waterlineFromBlueprint(blueprint) ?? waterlineFromBox(box.max[2], box.min[2], beamHalf);

  return {
    group,
    hull: { stemZ: waterline.bowZ, transomZ: waterline.sternZ, beam: beamHalf * 2 },
    ready: Promise.all([look?.ready, dressed?.ready]).then(() => undefined),
    update(t, x, z, heading, light, sails = 0, speed = 0, windTo, windSpeed) {
      for (const id of sailIds) {
        // (never quite 0: at a drop of exactly 0 the cloth shader's frame is cross(du, dv) with dv = 0, normalised —
        // NaN, and the whole sail mesh, its furled bundle with it, rasterises nothing: through c1 the raft had no sail
        // at all until the hoist began, then the furled bundle popped in, the 2026-10-31 review: "up to 5:36 our raft
        // has no sail at all; at 5:37 the sail suddenly appears, furled". SAIL_STRUCK is a few cm of cloth, inside
        // the bundle; the game's trim never strikes below 0.23)
        assembly.setSailDropScale(id, Math.max(SAIL_STRUCK, sails));
        assembly.setYardHoist(id, sails);
        // the wind frame the game's rig would publish: the hull's heading and its way through the water
        writeSailWindFrame(assembly.sailMesh(id), {
          shipForwardX: Math.sin(heading),
          shipForwardZ: Math.cos(heading),
          shipVelX: Math.sin(heading) * speed,
          shipVelZ: Math.cos(heading) * speed,
          gustPhase: 0,
          gustPhaseB: 0,
          windDirection: windTo,
          windSpeed,
        });
        // (a film frame's sail: its shape a pure function of this frame, sailDriver.ts — not of the frame and the
        // world drawn before it)
        assembly.sailMesh(id).userData.sailPure = { time: t, yawRate: 0 };
      }
      // lit from last light (the sunlight at a seventh of the day's) to full night, a little under the game's
      // (LANTERNS)
      const dusk = Math.min(1, Math.max(0, 1 - light.sun / 0.15));
      lanterns.update(LANTERNS * dusk * dusk * (3 - 2 * dusk), t);
      shipMaterialParams.sailBacklitStrength = backlit * light.sun;
      shipMaterialParams.sailAmbientLift = ambientLift * light.sky;
      shipFlagParams.flagAmbientLift = flagLift * light.sky;
      refreshShipMaterials();
      look?.update();
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      // least squares h = a + b·u + d·v over the contacts (u across, v along the raft), averaged in time
      let su = 0, sv = 0, suu = 0, svv = 0, suv = 0, sh = 0, shu = 0, shv = 0, n = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const tk = t + SETTLE / 2 - (SETTLE * k) / (SAMPLES - 1);
        for (const [u, , v] of contacts) {
          // raft local (u across, v toward the bow, +z) turned by the heading about y → world
          const wx = x + u * c + v * s;
          const wz = z - u * s + v * c;
          const h = heightAt(wx, wz, tk);
          su += u; sv += v; suu += u * u; svv += v * v; suv += u * v; sh += h; shu += h * u; shv += h * v; n++;
        }
      }
      const mu = su / n, mv = sv / n, mh = sh / n;
      const cuu = suu / n - mu * mu, cvv = svv / n - mv * mv, cuv = suv / n - mu * mv;
      const chu = shu / n - mh * mu, chv = shv / n - mh * mv;
      const det = cuu * cvv - cuv * cuv || 1e-9;
      const slopeU = (chu * cvv - chv * cuv) / det;
      const slopeV = (chv * cuu - chu * cuv) / det;
      group.position.set(x, mh - slopeU * mu - slopeV * mv, z);
      // the bow rises with the along-slope (pitch about x, negative lifts +z), the side with the across-slope
      euler.set(-Math.atan(slopeV), heading, Math.atan(slopeU));
      group.quaternion.setFromEuler(euler);
      group.updateMatrixWorld(true);
      rig?.update(1 - Math.min(1, Math.max(0, sails)));
      if (!o.far) {
        // the live waterline for the logs' under-water term (raftLook.ts `filmWaterline`): the sea at t itself, a
        // plane through the centre from four taps 2 m out — not the settle average the pose rides on
        const h0 = heightAt(x, z, t);
        const sx = (heightAt(x + 2, z, t) - heightAt(x - 2, z, t)) / 4;
        const sz = (heightAt(x, z + 2, t) - heightAt(x, z - 2, t)) / 4;
        filmWaterline.centre.value.set(x, z, h0);
        filmWaterline.slope.value.set(sx, sz);
      }
    },
  };
}
