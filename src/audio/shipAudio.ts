/**
 * The ship's positional sound field (§V3: reads the render-side ship pose,
 * writes nothing back).
 *
 *   bow      → water rush loop + splash slices   (bow world pos, §V27 gates)
 *   stern    → wake rush loop                    (ship-local -z)
 *   hull     → gurgle loop at the waterline      (amidships, y = waterline)
 *   rigging  → wooden creak loop                 (mainmast foot, roll+pitch)
 *   sails ×3 → canvas snaps / deploy one-shots   (fore/main/rear mast heads)
 *
 * Bus split: continuous water/creak LOOPS are ambience (they are the ship's
 * bed), discrete events are sfx — so the §I ambience slider ducks the world
 * and the sfx slider ducks the events.
 */
import { audioParams as p } from '../params/audio';
import { createLoopLayer, type LoopLayer } from './layer';
import { createPanner, setPannerPosition } from './emitters';
import { createDeltaTrigger, createGatedTrigger } from './triggers';
import { emitterTargets, luffEstimate, slamSignal, type ContactInput } from './mix';
import { createHullEvents, type HullEvents } from './hullEvents';
import { createSailHaul, type SailHaul } from './sailHaul';
import { playSample } from './sampleShot';
import { createRng, type Rng } from '../state/rng';
import { rotateVec } from '../core/quat';
import type { Quat, Vec3 } from '../state/simState';
import type { SampleName } from './assets';

export interface ShipAudioInput {
  position: Vec3;
  quaternion: Quat;
  velocity: Vec3;
  angularVelocity: Vec3;
  /** 0..1, 0 = furled */
  sailTrim: number;
  /** metres of bow below the surface — main.ts's bow-immersion sensor (§V27) */
  bowImmersion: number;
  /** exact bow world position if the caller has it; else derived from params */
  bowWorld?: Vec3;
  /**
   * Live hull-contact sensor (sea-physics/hullContact), passed straight
   * through. Drives the slam and puts the water emitter on the real surface
   * crossing instead of a fixed bow offset. Absent = pre-wiring fallback.
   */
  contact?: ContactInput | null;
  /**
   * Continuous cloth drop, 1 = full sail … 0 = furled — the SAME scalar the
   * rig animates with (ship/sailDynamics `trimDropScale`). When present it
   * drives the haul (reefing/setting sounds like men working, in both
   * directions); when absent the coarser sailTrim delta path is used.
   */
  sailDrop?: number;
}

export interface ShipAudioEnvIn {
  windSpeed: number;
  windDirection: number;
  /** 0..1 hull working (mix.hullWorking) — creak level + groan pacing */
  working: number;
}

export interface ShipAudio {
  onSample(name: SampleName, buffer: AudioBuffer): void;
  update(ship: ShipAudioInput, env: ShipAudioEnvIn, dt: number): void;
  dispose(): void;
}

interface Emitter {
  panner: PannerNode;
  layer?: LoopLayer;
}

function offsetWorld(ship: ShipAudioInput, local: Vec3): Vec3 {
  const r = rotateVec(ship.quaternion, local);
  return [ship.position[0] + r[0], ship.position[1] + r[1], ship.position[2] + r[2]];
}

export function createShipAudio(
  ctx: BaseAudioContext,
  buses: { sfx: GainNode; ambience: GainNode },
): ShipAudio {
  const mk = (bus: GainNode, layer?: { seed: number }): Emitter => {
    const panner = createPanner(ctx, bus);
    return {
      panner,
      layer: layer ? createLoopLayer(ctx, panner, { seed: layer.seed }) : undefined,
    };
  };

  // loops on the ambience bus, event panners on sfx
  const bow = mk(buses.ambience, { seed: 0xb0111 });
  const stern = mk(buses.ambience, { seed: 0x57e27 });
  const hull = mk(buses.ambience, { seed: 0x6072612 });
  const rigging = mk(buses.ambience, { seed: 0xc27ea1 });
  const bowShots = mk(buses.sfx);
  const sails = [mk(buses.sfx), mk(buses.sfx), mk(buses.sfx)];

  const snapBufs: AudioBuffer[] = [];
  let deployBuf: AudioBuffer | null = null;

  const rng: Rng = createRng(0x5a1105);
  // splash / slam / creak groans: water events at the cutwater, timber events
  // up at the rig where the ship's own noise belongs
  const events: HullEvents = createHullEvents(ctx, {
    water: bowShots.panner,
    timber: rigging.panner,
  });
  // the haul is spread across the masts — hands are working the whole rig
  const haul: SailHaul = createSailHaul(
    ctx,
    sails.map((s) => s.panner),
  );
  // one trigger per mast, each with its own rng stream → the three sails never
  // snap in unison (§B4 spirit: shared phase reads as a machine)
  const snapTriggers = [0x5a11a, 0x5a11b, 0x5a11c].map((seed) =>
    createGatedTrigger(
      () => ({
        on: p.sailSnapLuffOn,
        off: p.sailSnapLuffOff,
        cooldown: p.sailSnapCooldown,
        repeat: true,
        jitter: 0.45,
      }),
      createRng(seed),
    ),
  );
  // two scales of trim change: a big haul is a sail being set/furled (deploy
  // sample), a small one is just cloth taking up (a single snap)
  const deploy = createDeltaTrigger(() => ({
    delta: p.sailDeployDelta,
    cooldown: p.sailDeployCooldown,
  }));
  const trimSnap = createDeltaTrigger(() => ({
    delta: p.trimSnapDelta,
    cooldown: p.sailSnapCooldown,
  }));

  const snapAt = (emitter: Emitter, gain: number): void => {
    if (snapBufs.length === 0) return;
    const buf = snapBufs[Math.floor(rng() * snapBufs.length) % snapBufs.length];
    playSample(ctx, emitter.panner, buf, {
      gain,
      playbackRate: 1 + p.sailSnapRateJitter * (rng() * 2 - 1),
    });
  };

  return {
    onSample(name, buffer) {
      events.onSample(name, buffer);
      haul.onSample(name, buffer);
      if (name === 'wake') {
        bow.layer?.start(buffer);
        stern.layer?.start(buffer);
      } else if (name === 'hullGurgle') hull.layer?.start(buffer);
      else if (name === 'shipCreak') rigging.layer?.start(buffer);
      // three takes in the snap rotation, not two: canvasCrackB is a generated
      // full-size sail crack, where the two freesound takes are a dropcloth —
      // right shape, wrong scale for a galleon's mainsail
      else if (name === 'canvasSnapA' || name === 'canvasSnapB' || name === 'canvasCrackB') {
        snapBufs.push(buffer);
      } else if (name === 'sailDeploy') deployBuf = buffer;
    },

    update(ship, env, dt) {
      const speed = Math.hypot(ship.velocity[0], ship.velocity[2]);
      const targets = emitterTargets({ speed, working: env.working }, p);
      const tau = Math.max(0.05, p.ambienceTau);

      // ── positions (cheap: 6 quat rotations + a few AudioParam writes) ──
      const bowPos = ship.bowWorld ?? offsetWorld(ship, [0, p.waterlineY, p.bowEmitterZ]);
      setPannerPosition(bow.panner, bowPos[0], bowPos[1], bowPos[2]);
      // water EVENTS come from the real surface crossing when the sensor is
      // wired — a slam heard from the stem while the stem is in the air is
      // exactly the mismatch the cutwater signal exists to remove
      const cut = ship.contact?.cutwater;
      const water = cut?.inContact ? cut.world : bowPos;
      setPannerPosition(bowShots.panner, water[0], water[1], water[2]);
      const sternPos = offsetWorld(ship, [0, p.waterlineY, p.sternEmitterZ]);
      setPannerPosition(stern.panner, sternPos[0], sternPos[1], sternPos[2]);
      const hullPos = offsetWorld(ship, [0, p.waterlineY, 0]);
      setPannerPosition(hull.panner, hullPos[0], hullPos[1], hullPos[2]);
      const rigPos = offsetWorld(ship, [0, p.sailEmitterY * 0.35, p.mainMastEmitterZ]);
      setPannerPosition(rigging.panner, rigPos[0], rigPos[1], rigPos[2]);
      const mastZ = [p.foreMastEmitterZ, p.mainMastEmitterZ, p.rearMastEmitterZ];
      for (let i = 0; i < sails.length; i++) {
        const pos = offsetWorld(ship, [0, p.sailEmitterY, mastZ[i]]);
        setPannerPosition(sails[i].panner, pos[0], pos[1], pos[2]);
      }

      // ── continuous loops ──
      bow.layer?.update({ gain: targets.bowRush }, dt, tau);
      stern.layer?.update({ gain: targets.wake }, dt, tau);
      hull.layer?.update({ gain: targets.gurgle }, dt, tau);
      rigging.layer?.update({ gain: targets.creak }, dt, tau);

      // ── water impacts + timber groans (hullEvents owns the gating) ──
      events.update(
        {
          bowImmersion: ship.contact?.cutwater.depth ?? ship.bowImmersion,
          speed,
          slamRate: slamSignal(ship.contact, p),
          working: env.working,
          inContact: ship.contact ? ship.contact.cutwater.inContact : true,
        },
        dt,
      );

      // ── canvas: sustained luff snaps + a sharp trim change ──
      const fwd = rotateVec(ship.quaternion, [0, 0, 1]);
      const luff = luffEstimate(
        {
          forwardX: fwd[0],
          forwardZ: fwd[2],
          windDirection: env.windDirection,
          windSpeed: env.windSpeed,
          yawRate: ship.angularVelocity[1],
          trim: ship.sailTrim,
        },
        p,
      );
      for (let i = 0; i < snapTriggers.length; i++) {
        if (snapTriggers[i].step(luff, dt)) snapAt(sails[i], p.sailSnapGain * luff);
      }
      // ── reefing / setting sail ──
      if (ship.sailDrop !== undefined) {
        // preferred: the continuous cloth scalar → a full haul, both ways
        haul.update(ship.sailDrop, dt);
      } else {
        // fallback until main.ts passes sailDrop: coarse trim-delta events
        const set = deploy.step(ship.sailTrim, dt);
        const nudge = trimSnap.step(ship.sailTrim, dt);
        if (set > 0 && deployBuf) {
          playSample(ctx, sails[1].panner, deployBuf, { gain: p.sailDeployGain });
        } else if (set < 0 || nudge !== 0) {
          snapAt(sails[1], p.sailSnapGain * (set < 0 ? 1 : 0.6));
        }
      }
    },

    dispose() {
      events.dispose();
      for (const e of [bow, stern, hull, rigging, bowShots, ...sails]) {
        e.layer?.dispose();
        e.panner.disconnect();
      }
    },
  };
}
