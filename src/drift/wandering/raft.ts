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
 * The sails are furled and the pennant is struck: their flutter integrates a phase from the renderer's
 * frame clock (sailDriver.ts, flagDriver.ts), which is wall time — offline, at a few frames a second, the
 * canvas flapped ten times too fast (a "hyperlapse"), and from frame to frame, not from show time.
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
import { createDeckWater, setActiveDeckWater } from '../../deckwater';
import { raftContactPoints } from '../../sailing/raftBeaching';
import { shipFlagParams, shipMaterialParams } from '../../params/ship';
import { refreshShipMaterials } from '../../ship/pieceMaterials';

/** s the sea's height is averaged over, and how many instants */
const SETTLE = 1.2;
const SAMPLES = 5;

export interface RaftProp {
  readonly group: THREE.Group;
  /**
   * the raft's pose at time t, at (x, z) on the sea heading `heading` rad (0: bow toward +z); `sun` and `sky`
   * are the light there against the day's (0..1: the sunlight's luminance, the sky's irradiance)
   */
  update(t: number, x: number, z: number, heading: number, light: { sun: number; sky: number }): void;
}

export function createRaft(heightAt: (x: number, z: number, t: number) => number): RaftProp {
  const blueprint = buildRaftBlueprint();
  const deckField = buildRaftDeckField(blueprint);
  // the deck material reads the active deck water at construction (raft/raftScene.ts): bound, never stepped
  setActiveDeckWater(createDeckWater({ source: deckField }));
  const assembly = new ShipAssembly(blueprint, createPieceMaterialCache(createDeckFieldTexture(deckField)));
  assembly.setSailTint(raftMaterialParams.sailTint);
  // furled as on a moored raft: the cloth gone (the shader's drop scale), the yards lowered with it
  for (const def of blueprint) {
    if (!def.sailStates) continue;
    assembly.setSailState(def.id, 'furled');
    assembly.setSailDropScale(def.id, 0);
    assembly.setYardHoist(def.id, 0);
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
  const contacts = raftContactPoints();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');
  const backlit = shipMaterialParams.sailBacklitStrength;
  const ambientLift = shipMaterialParams.sailAmbientLift;
  const flagLift = shipFlagParams.flagAmbientLift;

  return {
    group,
    update(t, x, z, heading, light) {
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
