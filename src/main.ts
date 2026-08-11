import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { createInitialState } from './state/simState';
import type { SimState } from './state/simState';
import { createDebugShell } from './debug';
import { createSky } from './sky';
import { createOceanSim, oceanParams } from './ocean';
import { OceanSurface } from './ocean/oceanSurface';
import { createFoamSim, createSpray, createBowSpray } from './foam';
import { createFlowFoam } from './flowfoam';
import { rotateVec } from './combat/quatMath';
import { createClouds } from './clouds';
import { skyParams } from './params/sky';
import { buildGalleonBlueprint } from './ship/shipBlueprint';
import { ShipAssembly } from './ship/shipAssembly';
import { updateRig } from './ship/rigTrim';
import { createInputCollector } from './sailing/input';
import { stepShipSailing } from './sailing/shipKinematics';
import { createFollowCam } from './camera';
import { createWeatherSystem } from './weather';
import { createPostPipeline } from './core/postPipeline';
import { postParams } from './params/post';
import { createGameUI } from './ui';
import {
  createAudio,
  attachAudioSettings,
  type AudioFrame,
  type ShipAudioInput,
} from './audio';
import { CpuOcean } from './sea-physics/cpuOcean';
import { stepShipBuoyancy } from './sea-physics/buoyancy';
import {
  createHullContact,
  waterlineFromBlueprint,
  waterlineFromBox,
} from './sea-physics/hullContact';
import { stepFlooding } from './sea-physics/flooding';
import { stepShipGrounding } from './sea-physics/grounding';
import { galleonParams } from './params/ship';
import { floodingHoles } from './ship/destruction';
import { createCaustics, setActiveCaustics } from './caustics';
import { buildDeckHeightfield } from './ship/deckHeightfield';
import { createDeckWater, setActiveDeckWater } from './deckwater';
import { createPlanarReflection } from './reflection';
import { createArchipelago } from './island';
import { palmWindStrength } from './vegetation';
import { createRopes } from './ropes';
import { createBlocks } from './ropes/blocks';
import {
  applyBlocks,
  applyRiggingPlan,
  buildRiggingPlan,
  selectBlockSockets,
} from './ropes/shipRigging';
import { ropeParams } from './params/ropes';

// bisect switches for the renderer-freeze hunt — all true = full game
const FEATURES = {
  spray: true, // re-enabled: B5 NaN guards landed
  bowSpray: true, // re-enabled: B5 NaN guards landed
  flowFoam: true, // re-enabled: T13 wake rework verification (see flowfoam report)
  // ropes+blocks wired and ready — kept OFF pending the freeze-hunt bisect;
  // flip to true for the T11 rig visual check once Chrome is back
  ropes: true,
};

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');

  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }

  const app = await App.create(root);
  const state: SimState = createInitialState(1337);

  const weather = createWeatherSystem({
    setWeather: (w) => {
      state.weather = w as SimState['weather'];
    },
  });
  const debug = createDebugShell({ onWeatherPreset: (p) => weather.apply(p) });

  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const ocean = createOceanSim(state.seed);
  const foam = createFoamSim(
    ocean.cascades.map((c) => ({ displacement: c.displacement, domain: c.domain })),
    oceanParams.resolution,
  );
  // §V.10 intersection foam + ship wake (T13) — created before the surface
  // so the material can sample the wake mask
  const flowFoam = createFlowFoam();

  // clouds are built here (not after the surface) because the planar
  // reflection needs their blurred RT at construction, and the reflection in
  // turn has to exist before the ocean material is built
  const clouds = createClouds({
    renderer: app.renderer,
    camera: app.camera,
    seed: state.seed,
  });
  clouds.attachTo(app.scene);

  // §T.32 caustics — MUST be created and bound BEFORE any receiver material
  // is built. TSL bakes graphs at construction, so binding later yields
  // receivers with no caustics and no error (the guard warns once, but the
  // visual failure is silent).
  const caustics = createCaustics(ocean, { sunLight: sky.sunLight });
  setActiveCaustics(caustics);

  // §T.33 islands: 5 at 1.2–3.1km sharing 3 materials. Built BEFORE the ocean
  // surface because its seabed field feeds the shallows tint, and TSL bakes
  // material graphs at construction.
  const archipelago = createArchipelago({ seed: state.seed });
  app.scene.add(archipelago.group);

  // §T.30 planar reflections (§V26). Compiled into the material but DORMANT:
  // reflectionParams.live defaults 0, because the mirror pass costs ~1.0–1.5ms
  // on top of a frame already at 8.1ms against §V17's 8ms render ceiling. The
  // ship's "negative cost" does NOT carry into the mirror pass — the ocean is
  // excluded there, so the hull occludes only sky and pays full price.
  // Exposed as a graphics quality toggle so the look/cost call is the user's.
  const reflection = createPlanarReflection({
    sunLight: sky.sunLight,
    planeY: 0,
    clouds: { blurred: clouds.blurredTexture, seed: state.seed },
  });

  // sunLight enables the in-material shadow sample: the water is
  // MeshBasicNodeMaterial on purpose (§V20), so mesh.receiveShadow is inert
  // and the shadow map has to be read inside the material instead.
  // seabed drives the §V24 shallows tint — zero in open water, so the term
  // compiles out entirely when no seabed rises (the legitimate turquoise
  // path, as opposed to §B.12's sun-independent ambient SSS).
  const surface = new OceanSurface(ocean, foam, flowFoam, {
    sunLight: sky.sunLight,
    seabed: archipelago.seabed,
    reflection,
  });
  app.scene.add(surface.group);

  // crest + bow spray particles (T5 follow-up)
  const spray = createSpray(
    ocean.cascades.map((c) => ({ displacement: c.displacement, domain: c.domain })),
    oceanParams.resolution,
  );
  const bowSpray = createBowSpray();
  app.scene.add(spray.mesh, bowSpray.mesh);

  // player ship (§V.13): galleon assembly rendered from SimState (§V.3)
  state.ships.push({
    id: 'player',
    kind: 'player',
    position: [0, 0, 0],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0.8,
    flood: 0,
    damage: {},
  });
  const playerShip = state.ships[0];
  // piece damage states (intact|holed|destroyed) — written by destruction
  // ops when combat wiring lands (T17); hp values live in ShipState.damage
  const playerZoneStates: Record<string, import('./ship/pieceTypes').DamageStateId> = {};
  const galleonBlueprint = buildGalleonBlueprint();

  // §T.12/§T.31 deck water. ONE procedurally-generated deck heightfield (per
  // the talk's "artist supplied static heightfield") serves two consumers: the
  // Mei solver pools water in its low spots, and the deck material derives
  // plank relief from the same field — so the timber and the water agree about
  // where the low spots are. MUST bind before ShipAssembly: TSL bakes material
  // graphs at construction, and a late bind is silent (§T.32's lesson).
  // null when the blueprint exposes no deck the field can be derived from —
  // the solver then falls back to its own frame rather than failing to build
  const deckField = buildDeckHeightfield(galleonBlueprint) ?? undefined;
  const deckWater = createDeckWater({ source: deckField });
  setActiveDeckWater(deckWater);

  const shipAssembly = new ShipAssembly(galleonBlueprint);
  app.scene.add(shipAssembly.group);

  // §V.12 rigging: catenary compute ropes anchored to blueprint sockets
  const riggingPlan = buildRiggingPlan(galleonBlueprint);
  const ropes = createRopes({ maxRopes: Math.max(riggingPlan.length, 32) });
  app.scene.add(ropes.mesh);
  // wooden blocks (pulleys) at running-rigging terminations
  const blockSockets = selectBlockSockets(riggingPlan, ropeParams.maxBlocks);
  const blocks = createBlocks(blockSockets.length);
  app.scene.add(blocks.mesh);

  // Islands stay IN the mirror pass — §V26 names them and they are the payoff.
  // The cloud quad exclusion is NOT an optimisation: it is camera-pinned and
  // samples through screenUV, so from the mirror camera it smears across the
  // whole reflection. The ocean needs no exclusion — three hides the
  // reflector's own material, and the sea is one mesh with one material.
  reflection?.attachTo(app.scene);
  reflection?.excludeFromReflection(clouds.compositeQuad);
  reflection?.excludeFromReflection(spray.mesh);
  reflection?.excludeFromReflection(bowSpray.mesh);
  reflection?.excludeFromReflection(ropes.mesh);
  reflection?.excludeFromReflection(blocks.mesh);

  // hull dims for wake + bow spray, from blueprint hull AABBs
  let bowZ = 0;
  let sternZ = 0;
  let beamHalf = 2;
  for (const piece of galleonBlueprint) {
    if (piece.kind !== 'hull-section') continue;
    bowZ = Math.max(bowZ, piece.transform.position[2] + piece.aabb.max[2]);
    sternZ = Math.min(sternZ, piece.transform.position[2] + piece.aabb.min[2]);
    beamHalf = Math.max(beamHalf, Math.abs(piece.transform.position[0]) + piece.aabb.max[0]);
  }
  // tag hull meshes as intersection-foam targets (§V.10); everything on the
  // ship casts + receives sun shadows (sails onto deck, masts onto sails…)
  shipAssembly.group.traverse((o) => {
    if (o.name.startsWith('hull') || o.name.includes('-hull')) {
      o.userData.foamTarget = true;
    }
    if ((o as Mesh).isMesh) {
      o.castShadow = true;
      o.receiveShadow = true;
    }
  });
  // the water receives ship shadows too
  surface.group.traverse((o) => {
    if ((o as Mesh).isMesh) o.receiveShadow = true;
  });
  ropes.mesh.castShadow = true;

  // §V.8: CPU mirror of the same seeded spectrum the GPU renders
  const cpuOcean = new CpuOcean(state.seed);

  // hull waterline contact (§T.33 support): coarse stations round the hull
  // outline, sampled against the SAME sea every tick. Consumers: bow spray
  // (emit from the real cutwater, silent when the bow is airborne) and the
  // wake (shoulder displaced water along the actually-wetted side).
  const hullWaterline =
    waterlineFromBlueprint(galleonBlueprint) ??
    waterlineFromBox(bowZ, sternZ, beamHalf);
  const hullContact = createHullContact(hullWaterline);
  // hull wetness with MEMORY: keeps the highest recent contact per station and
  // decays it, so timber stays wet where the sea just was rather than tracking
  // the instantaneous waterline (user: "wetness where the water LAPPED")
  const hullWetline = caustics.attachHullWetline({ bowZ, sternZ });

  const input = createInputCollector(window);
  const followCam = createFollowCam(app.camera, app.renderer.domElement);
  app.controls.enabled = false; // follow cam owns the pointer now

  let paused = false;
  const ui = createGameUI({
    onPause: () => {
      paused = true; // sim halts, render continues (§V.21)
    },
    onResume: () => {
      paused = false;
    },
  });

  // volumes come from the persisted settings store, and stay bound to it so
  // pause-menu changes apply live and survive reload (§I, §V21)
  const audio = createAudio(ui.settings.get().audio);
  attachAudioSettings(audio, ui.settings);
  // hoisted + mutated per frame: the render callback runs every frame and a
  // fresh object graph here would be pure GC churn
  // held as its own non-optional binding so the per-frame writes below don't
  // have to re-narrow AudioFrame['ship'] (which is optional by contract)
  const audioShip: ShipAudioInput = {
    position: playerShip.position,
    quaternion: playerShip.quaternion,
    velocity: playerShip.velocity,
    angularVelocity: playerShip.angularVelocity,
    sailTrim: playerShip.sailTrim,
    bowImmersion: 0,
    bowWorld: [0, 0, 0],
  };
  const audioBowWorld = audioShip.bowWorld as [number, number, number];
  const audioFrame: AudioFrame = {
    dt: 0,
    camera: app.camera,
    wind: { speed: 0, direction: 0 },
    weather: state.weather,
    ship: audioShip,
  };

  const post = createPostPipeline(app.renderer, app.scene, app.camera);

  // render-side interpolation caches (§V.2: sim ticks at 60Hz, render at
  // display rate — lerping prev→curr tick kills transform micro-stutter)
  const prevPos = new Vector3();
  const currPos = new Vector3();
  const prevQuat = new Quaternion();
  const currQuat = new Quaternion();
  currPos.fromArray(playerShip.position);
  currQuat.fromArray(playerShip.quaternion);
  prevPos.copy(currPos);
  prevQuat.copy(currQuat);
  // interpolated view of the player ship handed to render-side consumers
  const renderShipView = structuredClone(playerShip);

  const loop = new GameLoop(
    (dt) => {
      if (paused) return;
      state.tick++;
      state.time += dt;
      // live wind follows ocean params (weather transitions lerp these)
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      const snapshot = input.sample(dt);
      stepShipSailing(playerShip, snapshot, state.wind, dt);
      cpuOcean.update(state.time);
      // §V.14 flooding: holes from damaged zones (inert while undamaged)
      const holes = floodingHoles(galleonBlueprint, playerZoneStates, playerShip.quaternion, 0);
      stepFlooding(playerShip, holes.positions, dt);
      stepShipBuoyancy(playerShip, cpuOcean, dt, undefined, holes.positions);
      // AFTER buoyancy, so the pose is final for this tick. Throws if the
      // ocean mirror was never advanced to this time (§B.7 fail-loud).
      // Measured: the stem is dry 40–47% of ticks at cruising speed — that is
      // how often the old fixed-point emitter was firing into thin air.
      hullContact.update(playerShip, cpuOcean, state.time);
      // grounding reuses this tick's station world positions — no second pose
      // pass, no extra ocean sampling. Touches, slows, lists, holds.
      stepShipGrounding(playerShip, hullContact, archipelago.seabed, galleonParams.draft, dt);
      // §V27 event-driven: the bow-immersion sensor reads the SAME cutwater
      // signal as the bow spray, so splash, spray and wake agree about when
      // she buries. Passive always-on splashing is explicitly forbidden.
      deckWater.update(
        app.renderer,
        {
          quaternion: playerShip.quaternion,
          speed: Math.hypot(playerShip.velocity[0], playerShip.velocity[2]),
          seaSigma: ocean.heightRms, // σ, not amplitude (§V36)
          cutwater: hullContact.cutwater,
        },
        dt,
      );
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      currPos.fromArray(playerShip.position);
      currQuat.fromArray(playerShip.quaternion);
    },
    (alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);

      sky.setShadowFocus(playerShip.position[0], playerShip.position[1], playerShip.position[2]);
      sky.update(skyParams.timeOfDay);

      let t = performance.now();
      ocean.update(app.renderer, state.time);
      foam.update(app.renderer);
      debug.hud.setPassTiming('ocean+foam cpu-dispatch', performance.now() - t);

      caustics.update(sky.sunDirection);
      hullWetline.updateFromHullContact(frameDt, hullContact.stations, hullContact.depth);

      t = performance.now();
      clouds.update(state.time, sky.sunDirection);
      debug.hud.setPassTiming('clouds cpu-dispatch', performance.now() - t);

      // spray + wake systems follow the ship (§V.6, §V.10)
      const shipYaw = Math.atan2(
        rotateVec(playerShip.quaternion, [0, 0, 1])[0],
        rotateVec(playerShip.quaternion, [0, 0, 1])[2],
      );
      const shipSpeed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      spray.centerUniform.value.set(playerShip.position[0], playerShip.position[2]);
      windDirTmp.set(Math.cos(state.wind.direction), Math.sin(state.wind.direction));
      // σ feeds the σ-relative crest gate (§V.36) — omitting it makes the
      // emitter fall back to a bootstrap sigma and warn, because silently
      // gating on a constant is the exact bug that invariant exists to stop
      if (FEATURES.spray) spray.update(app.renderer, windDirTmp, ocean.heightRms);
      const bowLocal = rotateVec(playerShip.quaternion, [0, 0, bowZ]);
      bowWorldTmp.set(
        playerShip.position[0] + bowLocal[0],
        playerShip.position[1] + bowLocal[1],
        playerShip.position[2] + bowLocal[2],
      );
      shipVelTmp.fromArray(playerShip.velocity);
      // hull heading, NOT the track: a ship making leeway crabs, so basing
      // the ejection frame on velocity throws spray off at an angle to the
      // stem (user: "flows in a little bit of a weird angle")
      const shipFwd = rotateVec(playerShip.quaternion, [0, 0, 1]);
      shipFwdTmp.set(shipFwd[0], shipFwd[1], shipFwd[2]).normalize();
      // one heightAt for both the spray emitter and the splash audio gate —
      // the CPU ocean sample is not free
      const bowImmersion =
        cpuOcean.heightAt(bowWorldTmp.x, bowWorldTmp.z, state.time) - bowWorldTmp.y;
      if (FEATURES.bowSpray) {
        bowSpray.update(app.renderer, {
          bowWorldPos: bowWorldTmp,
          shipVelocity: shipVelTmp,
          shipForward: shipFwdTmp,
          immersionDepth: bowImmersion,
          // real cutwater: `world` is the surface crossing itself (depth 0),
          // so the emitter must NOT re-add immersion to it. inContact false
          // (bow airborne over a trough) means rate 0 — no spray from air.
          cutwater: hullContact.cutwater,
        });
      }
      // MUST precede flowFoam.renderInjection: it traverses the scene for
      // userData.foamTarget, so this frame's island foam tags must be current
      archipelago.update(
        {
          time: state.time,
          windDir: [Math.cos(state.wind.direction), Math.sin(state.wind.direction)],
          windStrength: palmWindStrength(state.wind.speed),
          swell: ocean.heightRms * 2, // Hs/2; heightRms is σ
          sunDirection: sky.sunDirection,
          cameraPosition: app.camera.position,
        },
        (x, z) => cpuOcean.heightAt(x, z, state.time),
      );

      if (FEATURES.flowFoam) {
        flowFoam.setCenter(playerShip.position[0], playerShip.position[2]);
        flowFoam.setFlowDir([-playerShip.velocity[0], -playerShip.velocity[2]]);
        flowFoam.setShip(
          [playerShip.position[0], playerShip.position[2]],
          shipYaw,
          shipSpeed,
          bowZ,
          sternZ,
          beamHalf * 2,
        );
        flowFoam.renderInjection(app.renderer, app.scene);
        flowFoam.update(app.renderer, frameDt);
      }

      // render reads SimState (§V.3), interpolated between ticks — the
      // camera must chase the same interpolated pose or IT stutters instead
      shipAssembly.group.position.lerpVectors(prevPos, currPos, alpha);
      shipAssembly.group.quaternion.slerpQuaternions(prevQuat, currQuat, alpha);
      renderShipView.position[0] = shipAssembly.group.position.x;
      renderShipView.position[1] = shipAssembly.group.position.y;
      renderShipView.position[2] = shipAssembly.group.position.z;
      renderShipView.quaternion[0] = shipAssembly.group.quaternion.x;
      renderShipView.quaternion[1] = shipAssembly.group.quaternion.y;
      renderShipView.quaternion[2] = shipAssembly.group.quaternion.z;
      renderShipView.quaternion[3] = shipAssembly.group.quaternion.w;
      renderShipView.velocity = playerShip.velocity;
      followCam.update(renderShipView, frameDt, (x, z) => cpuOcean.heightAt(x, z, state.time));

      // after the camera pose is final, before surface.update/render. This
      // only publishes pose, layer masks and live params — the mirror pass
      // itself runs inside the main render, when the ocean material draws.
      reflection?.update(app.camera, state.time);

      // yards brace round to the apparent wind + reef state follows trim.
      // MUST run before the ropes block: yards rotate → the block's
      // updateMatrixWorld(true) picks it up → rope anchors resolve braced.
      // updateRig owns the trim→state predicate and is edge-triggered
      // internally, so passing the raw scalar every frame is safe.
      updateRig(shipAssembly, frameDt, playerShip.sailTrim);

      // rigging follows the moving ship: rewrite anchors, GPU re-solves (§V.12)
      if (FEATURES.ropes) {
        shipAssembly.group.updateMatrixWorld(true);
        applyRiggingPlan(riggingPlan, ropes, (id) => shipAssembly.socketWorldPosition(id));
        applyBlocks(blockSockets, blocks, (id) => shipAssembly.socketWorldPosition(id));
        app.renderer.compute(ropes.computeNode);
      }

      const speed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      ui.setSpeed(speed * 1.944); // m/s → knots
      const fwd = shipAssembly.group.getWorldDirection(tmpDir);
      ui.setHeading(Math.atan2(fwd.x, fwd.z));

      surface.update(app.camera, state.time, sky.sunDirection);
      if (postParams.enabled) {
        post.updateFromParams();
        post.render();
      } else {
        app.render();
      }
      debug.hud.setRenderStats(app.renderer.info.render);

      // audio LAST: the panner listener reads camera.matrixWorld, which is
      // only final after the render — updating earlier lags it one frame.
      // Frame object is hoisted + mutated to keep this allocation-free.
      audioFrame.dt = frameDt;
      audioFrame.wind.speed = state.wind.speed;
      audioFrame.wind.direction = state.wind.direction;
      audioFrame.weather = state.weather;
      audioShip.position = renderShipView.position;
      audioShip.quaternion = renderShipView.quaternion;
      audioShip.velocity = playerShip.velocity;
      audioShip.angularVelocity = playerShip.angularVelocity;
      audioShip.sailTrim = playerShip.sailTrim;
      audioShip.bowImmersion = bowImmersion;
      audioBowWorld[0] = bowWorldTmp.x;
      audioBowWorld[1] = bowWorldTmp.y;
      audioBowWorld[2] = bowWorldTmp.z;
      audio.update(audioFrame);
    },
  );
  loop.start();

  // dev console handle (not part of any interface contract)
  (window as unknown as Record<string, unknown>).__game = {
    app,
    state,
    sky,
    ocean,
    surface,
    clouds,
    shipAssembly,
    ui,
    followCam,
    ropes,
    blocks,
    riggingPlan,
    blockSockets,
  };
}

import { Quaternion, Vector2, Vector3, type Mesh } from 'three/webgpu';
const tmpDir = new Vector3();
const windDirTmp = new Vector2();
const bowWorldTmp = new Vector3();
const shipVelTmp = new Vector3();
const shipFwdTmp = new Vector3();

boot();
