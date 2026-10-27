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
 * Not yet: the ropes (a Verlet solve carried frame to frame) and the deck water (a simulation).
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

/** s the sea's height is averaged over, and how many instants */
const SETTLE = 1.2;
const SAMPLES = 5;

export interface RaftProp {
  readonly group: THREE.Group;
  /**
   * the raft's pose at time t, at (x, z) on the sea heading `heading` rad (0: bow toward +z); `sun` and `sky`
   * are the light there against the day's (0..1: the sunlight's luminance, the sky's irradiance)
   */
  update(t: number, x: number, z: number, heading: number, light: { sun: number; sky: number }, sails?: number, speed?: number): void;
}

/** the film's still sail (see the header): the game's cloth with everything that moves it from frame to frame off */
const STILL_SAIL = { sailFlutterAmp: 0.015, sailLuffFlap: 0, sailGustAmp: 0, sailTurnSkew: 0, sailResponse: 12, sailWindRef: 2.4 };

/** m/s of apparent wind at which the film's canvas reads full. The film's true wind is the light air its ripples
 * are built from (2.5 m/s), so a raft running before it at 1.2 m/s sees ~1.3 m/s: at the game's 4.2 the sail hung
 * 9% full, flat as a board ("a little more fullness in the sails", the v9 review). At 1.4 it is ~60% full under
 * way and full at rest; the waves keep their wind. */
const FILM_SAIL_WIND_REF = 1.4;

/** `far`: a raft seen only on the horizon (its lanterns carry no point lights: raftLanterns.ts) */
export function createRaft(heightAt: (x: number, z: number, t: number) => number, o: { far?: boolean } = {}): RaftProp {
  // (read into each sail's shape as the blueprint is built)
  raftParams.sailWindRef = FILM_SAIL_WIND_REF;
  const blueprint = buildRaftBlueprint();
  const deckField = buildRaftDeckField(blueprint);
  // the deck material reads the active deck water at construction (raft/raftScene.ts): bound, never stepped
  setActiveDeckWater(createDeckWater({ source: deckField }));
  const assembly = new ShipAssembly(blueprint, createPieceMaterialCache(createDeckFieldTexture(deckField)));
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
  // the lanterns under the roof's corners (the game's), lit as the sunlight goes
  const lanterns = createRaftLanterns(undefined, { lights: !o.far });
  assembly.group.add(lanterns.group);
  const contacts = raftContactPoints();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const backlit = shipMaterialParams.sailBacklitStrength;
  const ambientLift = shipMaterialParams.sailAmbientLift;
  const flagLift = shipFlagParams.flagAmbientLift;

  return {
    group,
    update(t, x, z, heading, light, sails = 0, speed = 0) {
      for (const id of sailIds) {
        assembly.setSailDropScale(id, sails);
        assembly.setYardHoist(id, sails);
        // the wind frame the game's rig would publish: the hull's heading and its way through the water
        writeSailWindFrame(assembly.sailMesh(id), {
          shipForwardX: Math.sin(heading),
          shipForwardZ: Math.cos(heading),
          shipVelX: Math.sin(heading) * speed,
          shipVelZ: Math.cos(heading) * speed,
          gustPhase: 0,
          gustPhaseB: 0,
        });
      }
      // lit from last light (the sunlight at a seventh of the day's) to full night
      const dusk = Math.min(1, Math.max(0, 1 - light.sun / 0.15));
      lanterns.update(dusk * dusk * (3 - 2 * dusk), t);
      shipMaterialParams.sailBacklitStrength = backlit * light.sun;
      shipMaterialParams.sailAmbientLift = ambientLift * light.sky;
      shipFlagParams.flagAmbientLift = flagLift * light.sky;
      refreshShipMaterials();
      const c = Math.cos(heading);
      const s = Math.sin(heading);
      // least squares h = a + b·u + d·v over the contacts (u across, v along the raft), averaged in time
      let su = 0, sv = 0, suu = 0, svv = 0, suv = 0, sh = 0, shu = 0, shv = 0, n = 0;
      for (let k = 0; k < SAMPLES; k++) {
        const tk = t - (SETTLE * k) / (SAMPLES - 1);
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
    },
  };
}
