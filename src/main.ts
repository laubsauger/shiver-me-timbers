import { webgpuAvailable, renderGatePage } from './core/gate';
import { App } from './core/app';
import { GameLoop } from './core/loop';
import { createInitialState } from './state/simState';
import type { SimState } from './state/simState';
import { createDebugShell } from './debug';
import { installGpuTimer, formatGpuHud, reportGpu } from './debug/gpuTimer';
import { createSky } from './sky';
import { createLanterns } from './lanterns';
import { createOceanSim, oceanParams } from './ocean';
import { OceanSurface } from './ocean/oceanSurface';
import { createFoamSim, createSpray, createBowSpray } from './foam';
import { createFlowFoam } from './flowfoam';
import { rotateVec } from './combat/quatMath';
import { createCombatArena, createCombatRuntime, viewBearing } from './combat';
import type { FireOrder } from './combat';
import { createClouds } from './clouds';
import { skyParams } from './params/sky';
import { buildGalleonBlueprint } from './ship/shipBlueprint';
import { ShipAssembly, type MaterialFactory } from './ship/shipAssembly';
import { createHoleMaterial, createPieceMaterial } from './ship/pieceMaterials';
import { createDeckFieldTexture } from './ship/deckFieldTexture';
import { updateRig } from './ship/rigTrim';
import { trimDropScale } from './ship/sailDynamics';
import { createInputCollector } from './sailing/input';
import { stepShipSailing } from './sailing/shipKinematics';
import { createFollowCam } from './camera';
import {
  createAmbientHold,
  createWeatherSystem,
  createWeatherSample,
} from './weather';
import { createRain } from './rain';
import { createPostPipeline } from './core/postPipeline';
import { createUnderwater } from './underwater';
import {
  logCompileProfile,
  profileCompile,
  rankCompile,
  type CompilePhase,
} from './core/compileProfile';
// exposed on __game so a browser check can re-rank without a reload
import { postParams } from './params/post';
import { applyWorldSettings, createGameUI, initGraphicsSettings, setFeatureSink } from './ui';
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
import { galleonParams, shipRigParams } from './params/ship';
import { createCaustics, setActiveCaustics } from './caustics';
import { buildDeckHeightfield } from './ship/deckHeightfield';
import { createDeckWater, setActiveDeckWater } from './deckwater';
import { createPlanarReflection } from './reflection';
import { createArchipelago } from './island';
import {
  DEFAULT_BOOT_TARGET,
  SPAWN_TARGET,
  bootJumpTarget,
  installJump,
} from './debug/jump';
import { palmWindStrength } from './vegetation';
import { createRopes } from './ropes';
import {
  applyRiggingPlan,
  buildBlockDescriptors,
  buildRiggingPlan,
} from './ropes/shipRigging';
import { ropeParams } from './params/ropes';
import { buildRatlinePlan } from './ship/ratlinePlan';
import { buildRungDescriptors } from './ropes/ratlines';
import { createAiShip, stepAiShip } from './ai/aiShip';

/** enemy spawn, world XZ — far enough to frame, close enough to watch */
const ENEMY_SPAWN: [number, number] = [190, -150];

// bisect switches for the renderer-freeze hunt — all true = full game
const FEATURES = {
  spray: true, // re-enabled: B5 NaN guards landed
  bowSpray: true, // re-enabled: B5 NaN guards landed
  flowFoam: true, // re-enabled: T13 wake rework verification (see flowfoam report)
  // ropes+blocks wired and ready — kept OFF pending the freeze-hunt bisect;
  // flip to true for the T11 rig visual check once Chrome is back
  ropes: true,
};

/**
 * §T.40 A/B lever. `?boot=baseline` restores the pre-optimisation boot —
 * every subsystem in the scene before the first compile, and a separate
 * material set per ship — so the before/after can be measured on ONE machine
 * in ONE session. Anything else (i.e. the normal load) gets the staged boot.
 * Kept rather than deleted: it is the only honest way to re-check the boot
 * budget after a subsystem lands, and it costs one branch.
 */
const BOOT_BASELINE =
  new URLSearchParams(window.location.search).get('boot') === 'baseline';

/**
 * Bound a COSMETIC wait so it can never gate boot (§V.39, §B.21).
 *
 * Everything the presentation layer offers to wait on — `requestAnimationFrame`
 * and the Web Animations `finished` promise alike — is driven by the frame
 * clock, and Chrome STOPS that clock in a hidden tab. Measured on this page:
 * 3037ms of wall clock, 0 rAF callbacks, animation `currentTime` still 0 with
 * `playState: 'running'`. A promise from that clock does not resolve late in a
 * background tab, it resolves NEVER — and every automated verification of this
 * project runs in exactly that tab.
 *
 * So: race the pretty thing against a real timer, and swallow its rejection.
 * `setTimeout` keeps running when hidden; that is the whole reason it is here
 * and not another rAF.
 */
function atMost(work: Promise<unknown>, ms: number): Promise<void> {
  return Promise.race([
    // a cancelled animation REJECTS (AbortError) — cosmetics must not throw
    // into the boot chain, so the rejection is absorbed here.
    work.then(
      () => undefined,
      () => undefined,
    ),
    new Promise<void>((resolve) => {
      window.setTimeout(resolve, ms);
    }),
  ]);
}

const afterSplashPaint = (): Promise<void> => {
  // a hidden tab paints nothing and fires no rAF, so there is no paint to wait
  // for — skip rather than pay the deadline once per boot phase.
  if (document.visibilityState === 'hidden') return Promise.resolve();
  return atMost(
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    }),
    PAINT_DEADLINE_MS,
  );
};

/** two frames at 60Hz plus slack; a hidden tab pays this once per phase */
const PAINT_DEADLINE_MS = 120;
/** last letter lands at ~1.71s (888ms delay + 820ms); slack for a slow load */
const ENTRANCE_DEADLINE_MS = 2500;

/**
 * Let the splash title complete its entrance before scene construction takes
 * the main thread. CSS animation time keeps advancing during a long task, but
 * its intermediate frames cannot be painted; starting the build immediately
 * therefore left the title visibly stranded halfway through the word.
 *
 * This waits on the real final-letter animation rather than duplicating its
 * duration here. Two animation frames after `finished` are intentional: rAF
 * callbacks run before paint, so the first frame commits the final style and
 * the second proves that final style has actually had a paint opportunity.
 *
 * Every wait in here is a COURTESY to a human watching, and is bounded
 * accordingly (see `atMost`). Nothing cosmetic may throw either: a missing
 * splash element means the entrance cannot be watched, which is worth a
 * warning and nothing more — it is not worth the whole application.
 */
async function finishSplashTitleEntrance(): Promise<void> {
  // nobody is watching a hidden tab, and its frame clock is stopped anyway
  if (document.visibilityState === 'hidden') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

  const letters = document.querySelectorAll<HTMLElement>('.boot-splash__letter');
  const lastLetter = letters.item(letters.length - 1);
  if (!lastLetter) {
    console.warn('[boot] no splash title letters — skipping the entrance wait');
    return;
  }

  const entrance = lastLetter
    .getAnimations()
    .find(
      (animation) =>
        animation instanceof CSSAnimation && animation.animationName === 'boot-letter-rise',
    );
  if (!entrance) {
    console.warn('[boot] no splash title entrance animation — skipping the wait');
    return;
  }

  await atMost(entrance.finished, ENTRANCE_DEADLINE_MS);
  await afterSplashPaint();
}

async function boot(): Promise<void> {
  const root = document.getElementById('app');
  if (!root) throw new Error('missing #app root');

  if (!(await webgpuAvailable())) {
    renderGatePage(root);
    return;
  }

  await finishSplashTitleEntrance();
  const showBootPhase = async (label: string): Promise<void> => {
    (window as unknown as { __bootProgress?: (s: string) => void }).__bootProgress?.(label);
    await afterSplashPaint();
  };

  // boot timing — the splash now holds until a real frame exists, so every ms
  // here is user-visible waiting. Phase marks land on __game.bootTimings and
  // in the console so the cost can be attacked with numbers, not guesses.
  // FIRST — before the renderer and before ANY system is built. caustics,
  // deckwater and post bake their TSL graphs once and sky allocates its shadow
  // map once, so these values have to be right the first time rather than
  // applied after the fact.
  const settings = initGraphicsSettings();

  const bootT0 = performance.now();
  const bootTimings: Array<[string, number]> = [];
  let bootLast = bootT0;
  const bootMark = (label: string): void => {
    const now = performance.now();
    bootTimings.push([label, +(now - bootLast).toFixed(1)]);
    bootLast = now;
  };

  await showBootPhase('renderer');
  const app = await App.create(root);
  /**
   * §V.39's instrument, installed HERE — after `renderer.init()` (the device
   * must exist) and before the first render (three lazily builds its own
   * latching pool on the first pass and never replaces it). See
   * src/debug/gpuTimer.ts for why three's own pool cannot be trusted: every
   * one of its failure paths returns the PREVIOUS reading, which is §V.63's
   * constant 29.688 ms.
   */
  const gpuTimer = installGpuTimer(app.renderer);
  bootMark('renderer');
  await showBootPhase('scene build');
  const state: SimState = createInitialState(1337);

  // §T.40 staged warm-up. Anything the FIRST PICTURE does not need is built
  // as usual but kept OUT of the scene until its pipelines exist, then added.
  // Hiding it instead would not work: `visible = false` also hides it from
  // compileAsync, and a material that first compiles on a DRAW compiles
  // SYNCHRONOUSLY — the visible hitch this whole mechanism exists to avoid.
  // Sim is untouched by any of it (§V.2): nothing here reads scene membership.
  const deferred: Array<{ label: string; object: Object3D }> = [];
  const addOrDefer = (label: string, ...objects: Object3D[]): void => {
    for (const object of objects) {
      if (BOOT_BASELINE) app.scene.add(object);
      else deferred.push({ label, object });
    }
  };

  const weather = createWeatherSystem({
    seed: state.seed,
    setWeather: (w) => {
      state.weather = w as SimState['weather'];
    },
  });
  // §T.38: reused per frame — weatherAt fills a caller-owned sample, no alloc
  const weatherHere = createWeatherSample();
  // §V.46 write-back guard: these two keys are BOTH ends of the blend below —
  // the sample's `from` and the sim tick's destination. Without the hold the
  // field blends from its own last output and ratchets to storm (createAmbientHold).
  // The steps are the field's PUBLISH GRID, and they are load-bearing: both keys
  // re-cut the spectrum on the GPU and the §V.8 mirror (~490 ms of main-thread
  // work at 512²), so a value that moved every tick would stall the game under
  // way. 0.5 m/s and 0.02 are ~5× and ~2× the panel's own steps, below what is
  // readable from a deck, and bound the whole calm↔storm range to ≤14 and ≤46
  // distinct spectra. Anchored at ambient, so presets and panel drags are exact.
  const oceanAmbient = createAmbientHold(
    ['windSpeed', 'amplitude'],
    oceanParams,
    { windSpeed: 0.5, amplitude: 0.02 },
  );
  const debug = createDebugShell({ onWeatherPreset: (p) => weather.apply(p) });

  const sky = createSky({ scene: app.scene });
  sky.configureRenderer(app.renderer);

  const ocean = createOceanSim(state.seed);
  const foam = createFoamSim(
    ocean.cascades.map((c) => ({
      displacement: c.displacement,
      // trace of the displacement jacobian lives in .zw — the foam gate is on
      // the MIN EIGENVALUE now, which needs trace + det (src/foam/foamMath)
      derivatives: c.derivatives,
      domain: c.domain,
    })),
    oceanParams.resolution,
    // LIVE moments, held by reference: the foam gate is a multiple of each
    // band's own σ (§V36), so it has to see spectrum rebuilds, not a snapshot
    ocean,
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
    // §V.46: cluster silhouette reads the LOCAL storm strength, so a squall on
    // the horizon builds as a monument while the sky overhead stays fair.
    // Omitting this leaves every cluster fair-weather — silently.
    stormAt: weather.stormAt,
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
  // DEFERRED (§T.40): 1.2–3.1km away and three heavy materials (terrain, rock,
  // palm). Their seabed field still feeds the ocean material and grounding
  // from the moment it is built — only the DRAWING waits.
  addOrDefer('islands', archipelago.group);

  // §T.30 planar reflections (§V26). Compiled into the material but DORMANT:
  // reflectionParams.live defaults 0, because the mirror pass costs ~1.0–1.5ms
  // on top of a frame already at 8.1ms against §V17's 8ms render ceiling. The
  // ship's "negative cost" does NOT carry into the mirror pass — the ocean is
  // excluded there, so the hull occludes only sky and pays full price.
  // Exposed as a graphics quality toggle so the look/cost call is the user's.
  const reflection = createPlanarReflection({
    sunLight: sky.sunLight,
    planeY: 0,
    clouds: {
      blurred: clouds.blurredTexture,
      seed: state.seed,
      // the LIVE resolved pair, held by reference: the clouds system mutates
      // these in place each frame from the sky palette, so the reflection
      // warms with the real clouds instead of staying at the midday hexes.
      sunColorLive: clouds.sunColorLive,
      skyColorLive: clouds.skyColorLive,
      sunDirLive: clouds.sunDirLive,
    },
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
    // §V.26 the reflected sky is the SKY's own dome function (sun disc
    // excluded), not a second ramp inside the water material.
    skyDomeColor: sky.skyDomeColor,
  });
  app.scene.add(surface.group);

  // crest + bow spray particles (T5 follow-up)
  const spray = createSpray(
    ocean.cascades.map((c) => ({
      displacement: c.displacement,
      // λ− needs the jacobian TRACE too (§V58) — same pair foam injects from
      derivatives: c.derivatives,
      domain: c.domain,
    })),
    oceanParams.resolution,
  );
  const bowSpray = createBowSpray();
  const rain = createRain();
  // DEFERRED (§T.40): all three pools are EMPTY on frame one — the ship is
  // stationary and it is not raining — so nothing they would draw exists yet.
  // Warmed within a second, long before the first crest breaks.
  addOrDefer('spray + rain', spray.mesh, bowSpray.mesh, rain.mesh);

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

  // §T.40: ONE material set shared by BOTH galleons. three's node cache key is
  // built from node INSTANCE ids, so two structurally identical materials
  // share no codegen and no pipeline — the enemy was a second full set of
  // ~30 piece shaders, and the wood family is the heaviest in the project.
  // Semantically free: piece materials already key nothing off which ship they
  // sit on — `uShipWorldInverse` and `uShipSunDirection` are module-level
  // singletons that every assembly has always shared.
  const sharedPieceMaterials = ((): MaterialFactory | undefined => {
    if (BOOT_BASELINE || deckField === undefined) return undefined;
    const deckFieldTexture = createDeckFieldTexture(deckField);
    const cache = new Map<string, Material>();
    return (kind, role) => {
      const key = `${kind}:${role}`;
      let material = cache.get(key);
      if (material === undefined) {
        material =
          role === 'hole' ? createHoleMaterial() : createPieceMaterial(kind, deckFieldTexture);
        cache.set(key, material);
      }
      return material;
    };
  })();

  const shipAssembly = new ShipAssembly(galleonBlueprint, sharedPieceMaterials);
  app.scene.add(shipAssembly.group);

  // SHIP'S LANTERNS (§T15 night). Two point lights on the taffrail, hanging
  // from a pendulum so they stay plumb while the deck rolls.
  //
  // CREATED HERE, AT BOOT, AND NEVER ADDED OR REMOVED AGAIN. three folds the
  // scene's light set into every render object's dynamic cache key, so a
  // runtime scene.add(light) recompiles every material in the scene — see
  // src/lanterns/index.ts. Creating them before the first compile costs one
  // point-light block in each lit shader and no recompile at all; "off" is
  // intensity 0, driven by sky.nightFactor.
  //
  // They hang from the lantern posts on the poop — the pieces that already
  // carry the lantern-bulb geometry, which now declare the pivot socket for it
  // (src/ship/blueprintCastles.ts). They used to hang off the taffrail cleats,
  // which put two lit spheres beside two unlit decorative bulbs.
  const LANTERN_SOCKETS: Record<string, string> = {
    'stern-port': 'socket-lantern-port',
    'stern-starboard': 'socket-lantern-starboard',
  };
  const LANTERN_IDS = Object.keys(LANTERN_SOCKETS);
  const lanterns = createLanterns({ scene: app.scene, ids: LANTERN_IDS });

  // ENEMY SHIP (§T.19/§V.15). Placed off the starboard bow at a distance that
  // frames well rather than alongside — she is here to be looked at. Sailing
  // and buoyancy key per-ship state off a WeakMap, so they need no second
  // instance; the rig does, because applyRiggingPlan writes indices 0..n-1
  // with no offset and would otherwise overwrite the player's ropes.
  state.ships.push({
    id: 'enemy-1',
    kind: 'enemy',
    position: [ENEMY_SPAWN[0], 0, ENEMY_SPAWN[1]],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    rudder: 0,
    sailTrim: 0.7,
    flood: 0,
    damage: {},
  });
  const enemyShip = state.ships[1];
  const enemyBlueprint = buildGalleonBlueprint();
  const enemyAssembly = new ShipAssembly(enemyBlueprint, sharedPieceMaterials);
  // stays in the scene from frame one: sharing the player's materials means
  // she brings NO new pipelines, so deferring her would buy nothing and cost
  // a pop-in on a ship that is meant to be looked at.
  app.scene.add(enemyAssembly.group);
  const enemyAi = createAiShip(1, ENEMY_SPAWN);

  // §V.12 rigging: catenary compute ropes anchored to blueprint sockets
  const riggingPlan = buildRiggingPlan(galleonBlueprint);
  // §V.45: rungs read the SAME solved points buffer the shrouds render from,
  // sampled fractionally along both curves — so the ladder rides whatever the
  // shrouds actually do (sag now, swing when §V42 lands, a mast going over the
  // side for free). Authored geometry could never track that.
  const rungs = buildRungDescriptors(buildRatlinePlan(galleonBlueprint), riggingPlan);
  // wooden blocks (pulleys) at the running-rigging terminations. Same §V45
  // treatment as the rungs: addressed by (rope, t) and hung off the solved
  // curve, so they swing with the line rather than only with the ship, and
  // they cost the CPU nothing per frame.
  const blockDescriptors = buildBlockDescriptors(riggingPlan, ropeParams.maxBlocks);
  const ropes = createRopes({
    maxRopes: Math.max(riggingPlan.length, 32),
    rungs,
    blocks: blockDescriptors,
  });
  app.scene.add(ropes.mesh);

  // second rope instance for the enemy — see the note at her spawn
  const enemyRiggingPlan = buildRiggingPlan(enemyBlueprint);
  const enemyRungs = buildRungDescriptors(
    buildRatlinePlan(enemyBlueprint),
    enemyRiggingPlan,
  );
  const enemyRopes = createRopes({
    maxRopes: Math.max(enemyRiggingPlan.length, 32),
    rungs: enemyRungs,
  });
  // DEFERRED (§T.40): createRopes takes no material injection, so this second
  // instance is a second full set of FOUR shaders (near/far tube × rope/
  // ratline). At 240m her rigging arriving a second late is not visible —
  // whereas compiling four rope shaders before the first picture is.
  addOrDefer('enemy rigging', enemyRopes.mesh);

  // Islands stay IN the mirror pass — §V26 names them and they are the payoff.
  // The cloud quad exclusion is NOT an optimisation: it is camera-pinned and
  // samples through screenUV, so from the mirror camera it smears across the
  // whole reflection. The ocean needs no exclusion — three hides the
  // reflector's own material, and the sea is one mesh with one material.
  reflection?.attachTo(app.scene);
  reflection?.excludeFromReflection(clouds.compositeQuad);
  reflection?.excludeFromReflection(spray.mesh);
  reflection?.excludeFromReflection(bowSpray.mesh);
  // the blocks live INSIDE ropes.mesh now, so this one exclusion covers them
  reflection?.excludeFromReflection(ropes.mesh);

  // Hull PLAN dims from the blueprint hull AABBs. These are the box bounds of
  // the `hull-section` pieces ONLY, which is the parallel body — the 3.5 m stem
  // is a separate `kind: 'bow'` piece and is NOT in this scan, so `aabbBowZ`
  // stops 3.5 m SHORT of the drawn cutwater, inside the hull. Named `aabb*` so
  // nothing downstream can mistake them for the stem: the waterline loft below
  // is the single authority on where the bow is (§V.33), and every consumer
  // takes `stemZ`/`transomZ` from it.
  let aabbBowZ = 0;
  let aabbSternZ = 0;
  let beamHalf = 2;
  for (const piece of galleonBlueprint) {
    if (piece.kind !== 'hull-section') continue;
    aabbBowZ = Math.max(aabbBowZ, piece.transform.position[2] + piece.aabb.max[2]);
    aabbSternZ = Math.min(aabbSternZ, piece.transform.position[2] + piece.aabb.min[2]);
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
  // §V.72: ...and the same SEABED the ocean material shoals over. The material
  // was handed `archipelago.seabed` above; handing the mirror anything else —
  // including nothing — would put the hull on the open-ocean sea while the
  // drawn water calmed over the shallows, which is §V.8's whole subject.
  cpuOcean.setSeabed(archipelago.seabed, -archipelago.seabed.openHeight);

  // hull waterline contact (§T.33 support): coarse stations round the hull
  // outline, sampled against the SAME sea every tick. Consumers: bow spray
  // (emit from the real cutwater, silent when the bow is airborne) and the
  // wake (shoulder displaced water along the actually-wetted side).
  const hullWaterline =
    waterlineFromBlueprint(galleonBlueprint) ??
    waterlineFromBox(aabbBowZ, aabbSternZ, beamHalf);
  const hullContact = createHullContact(hullWaterline);
  /**
   * THE STEM AND THE TRANSOM — one value each, for every consumer (§V.33).
   *
   * The hull-section AABB scan above reports z 17.5, but the loft's waterline
   * stem is at 21.0 (`hullMath`: hullLength/2 + bowLength) and the `kind:'bow'`
   * piece that carries those 3.5 m descends 2 m BELOW the water. Feeding 17.5
   * to anything that emits at the bow puts the emitter inside the hull mesh.
   *
   * Measured, for the wake: cutwater at 17.5, bow-mound crest at 19.1, and the
   * mound's whole forward reach ending at 20.5 — half a metre short of the
   * stem. Every square metre of bow wake was being injected under the hull and
   * then depth-rejected by it, which is precisely the user's "swallowed by the
   * actual hull mesh". The same 17.5 was feeding the bow-spray emitter and the
   * caustics wetline, so all three were emitting from inside the ship.
   */
  const stemZ = hullWaterline.bowZ;
  const transomZ = hullWaterline.sternZ;
  // hull wetness with MEMORY: keeps the highest recent contact per station and
  // decays it, so timber stays wet where the sea just was rather than tracking
  // the instantaneous waterline (user: "wetness where the water LAPPED")
  const hullWetline = caustics.attachHullWetline({ bowZ: stemZ, sternZ: transomZ });

  const input = createInputCollector(window);
  const followCam = createFollowCam(app.camera, app.renderer.domElement);
  app.controls.enabled = false; // follow cam owns the pointer now

  // H = captain's eye at the helm. The anchor is resolved from the wheel's own
  // socket rather than typed in, so it follows the model; the assembly is still
  // at the origin here, so the world position IS the ship-local one. Throws
  // loudly if the socket ever disappears — a silently mis-placed POV that puts
  // the camera inside the transom is worse than a boot failure.
  shipAssembly.group.updateMatrixWorld(true);
  followCam.setHelmAnchor(shipAssembly.socketWorldPosition('socket-wheel'));

  let paused = false;
  // two switches have no params key yet — the sinks drive them until their
  // owning agents ship one, at which point the switch goes live unchanged
  setFeatureSink('shadows', (on) => {
    sky.sunLight.castShadow = on;
  });
  setFeatureSink('spray', (on) => {
    FEATURES.spray = on;
    FEATURES.bowSpray = on;
    // also hide the meshes: gating only the update would freeze live
    // particles mid-flight rather than clearing them
    spray.mesh.visible = on;
    bowSpray.mesh.visible = on;
  });

  const ui = createGameUI({
    settings, // REUSE the store — omitting it makes the UI build a second one
    onPause: () => {
      paused = true; // sim halts, render continues (§V.21)
    },
    onResume: () => {
      paused = false;
    },
  });

  // resolution scale: the UI owns the setting, the renderer is ours
  const applyResolution = (s = settings.get()): void => {
    app.renderer.setPixelRatio(
      Math.min(window.devicePixelRatio, 2) * s.graphics.resolutionScale,
    );
  };
  applyResolution();
  settings.subscribe(applyResolution);

  // world staging — time of day and the wind. The UI owns the settings, the
  // engine reads the params, and `applyWorldSettings` is the single mapping
  // between them (it is what the §V.62 wiring test holds). Pushed on every
  // change AND once up front, so a stored sky and a stored wind survive a
  // reload — during alpha the point is to come back to what you were sailing.
  //
  // The wind lands on `oceanParams`, which is where the sim tick below reads
  // `state.wind` from — so one write moves the spectrum, the sails, the AI,
  // the flags, the spray, the palms and the weather cells' drift together.
  const applyWorld = (s = settings.get()): void => {
    applyWorldSettings(s.world);
  };
  applyWorld();
  settings.subscribe(applyWorld);

  // volumes come from the persisted settings store, and stay bound to it so
  // pause-menu changes apply live and survive reload (§I, §V21)
  const audio = createAudio(ui.settings.get().audio);
  attachAudioSettings(audio, ui.settings);

  // §T.16/§T.17/§T.18/§V.14 combat. Built here because it needs BOTH ship
  // assemblies (it fires piece-graph ops at them) and the audio facade (guns
  // and breaches are positional events). DEFERRED (§T.40): its two materials
  // draw nothing on frame one — no shot has been fired yet.
  const combat = createCombatRuntime({
    ships: [
      { shipIndex: 0, blueprint: galleonBlueprint, assembly: shipAssembly },
      { shipIndex: 1, blueprint: enemyBlueprint, assembly: enemyAssembly },
    ],
    // the SAME sea the hulls float on: a ball pitches into the wave that is
    // actually there, and a breach floods against the live surface (§V.8)
    waterHeightAt: (x, z) => cpuOcean.heightAt(x, z, state.time),
    audio,
  });
  addOrDefer('combat fx', combat.group);
  // The gun/impact flash light goes in DIRECTLY, never through addOrDefer,
  // and is never removed. three folds the scene's light set into every
  // material's cache key, so adding a light during the deferred warm-up
  // would recompile every shader in the scene — the ocean included — after
  // the first frame. Same rule, same reason as the lanterns above. "No
  // flash" is intensity 0.
  app.scene.add(combat.flashLight);
  // §T.17 dev harness, `?scene=combat`: both hulls hove to at a fixed range,
  // the lens parked across the line of fire, keys to fire either side and to
  // force a breach or a mast. null (and free) in ordinary play. Combat was
  // unobservable without it — see the header of combatArena.ts.
  const arena = createCombatArena(state, combat, followCam, galleonBlueprint);
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

  // §V.25 / §T.29. The underwater handle owns two things that live in
  // different places: a scene-pass mesh (the meniscus band, drawn over
  // everything at the waterline) and a post STAGE. It is created here so both
  // ends can be reached, and because its update() needs the same sea sampler
  // the ship floats on — the split plane must be the wave the camera is in,
  // not y = 0 (§V.8: one source of truth for where the sea is).
  const underwater = createUnderwater({
    camera: app.camera,
    sunDirProvider: () => sky.sunDirection,
  });
  app.scene.add(underwater.waterlineMesh);

  const post = createPostPipeline(app.renderer, app.scene, app.camera, {
    underwater,
    // God rays follow THE KEY, not the sun. The pipeline's default is the pure
    // solar function, which is correct only while the sun owns the key: after
    // dusk it aims the shafts at a body that is below the horizon, so the
    // effect quietly extinguishes itself for the entire night. `sunDirection`
    // on the sky handle IS the key (src/sky/moonCycle.ts re-aims that one pair
    // rather than adding a second light), so binding it here buys moon shafts
    // through the rigging for nothing — the same trade every other consumer of
    // that handle already takes.
    sunDirection: () => sky.sunDirection,
  });

  // §T.40. The post switch has `reload: false`, so it can flip mid-session —
  // and post renders the scene into its OWN target, whose colour format and
  // sample count give every material a different pipeline cache key. Flipping
  // it on cold recompiles the entire scene synchronously inside one frame
  // (seconds, frozen). So: warm it in the background on the first request and
  // keep drawing direct to the canvas until the pipelines exist.
  // `compilePhases` is filled in below; this closure only ever pushes to it.
  const compilePhases: CompilePhase[] = [];
  let postWarm = postParams.enabled;
  let postWarming = false;
  const usePost = (): boolean => {
    if (!postParams.enabled) return false;
    if (postWarm) return true;
    if (!postWarming) {
      postWarming = true;
      void (async (): Promise<void> => {
        const phase = await profileCompile(app.renderer, 'warm:post', () => post.warmup());
        compilePhases.push(phase);
        postWarm = true;
        postWarming = false;
        console.info(`[boot] post path warmed in ${phase.wall}ms`);
      })();
    }
    return false;
  };

  // render-side interpolation caches (§V.2: sim ticks at 60Hz, render at
  // display rate — lerping prev→curr tick kills transform micro-stutter)
  const prevPos = new Vector3();
  const currPos = new Vector3();
  const prevQuat = new Quaternion();
  const currQuat = new Quaternion();
  // velocity too: the follow camera's look-ahead is part of the POSE it aims
  // with, so handing it the raw sim velocity while position and quaternion
  // are lerped makes the aim step at 60 Hz while the hull glides (§V.2)
  const prevVel = new Vector3();
  const currVel = new Vector3();
  currPos.fromArray(playerShip.position);
  currQuat.fromArray(playerShip.quaternion);
  currVel.fromArray(playerShip.velocity);
  prevPos.copy(currPos);
  prevQuat.copy(currQuat);
  prevVel.copy(currVel);
  // interpolated view of the player ship handed to render-side consumers
  const renderShipView = structuredClone(playerShip);

  // §T.52 dev jump. `J` cycles the archipelago's anchorages (the showcase
  // lagoon) and `Shift+J` returns to spawn; `?at=lagoon` boots there. The
  // callback is the whole reason this is not a one-liner: teleporting has to
  // collapse the render-side prev/curr interpolation pair AND cut the camera,
  // or she smears across the map for a frame and the lens chases her for
  // seconds (see followCam.snap).
  const jump = installJump({
    target: window,
    ship: playerShip,
    targets: archipelago.anchorages.map((a) => ({
      name: a.name,
      x: a.x,
      z: a.z,
      heading: a.heading,
    })),
    waterLevelAt: (x, z) => cpuOcean.heightAt(x, z, state.time),
    onTeleport: () => {
      currPos.fromArray(playerShip.position);
      currQuat.fromArray(playerShip.quaternion);
      currVel.fromArray(playerShip.velocity);
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      prevVel.copy(currVel);
      followCam.snap();
    },
  });
  /**
   * BOOT AT ANCHOR IN THE LAGOON (user: "anchored in this lagoon, with the
   * ship being static there, sitting with fully packed up sails").
   *
   * `requestedAt` is kept separate from `bootAt` so a missing destination only
   * warns when someone actually ASKED for it — a default that silently falls
   * back to the origin (a blueprint with no islands) is correct behaviour, not
   * a misconfiguration. `?at=spawn` is the open-water venue for ocean parity.
   *
   * FURLED, and that is what holds her: `teleportShip` already zeroes velocity
   * and spin, and trim 0 is the same "canvas off her, so she holds station"
   * idiom combatArena uses when it heaves a ship to. Measured in-browser at
   * the anchorage: 0.78 m of drift over 20 s, against 17-24 knots under the
   * 0.8 trim she used to boot with. No anchor mechanic is needed for her to
   * still be there when the user has finished looking at the beach.
   */
  const requestedAt = bootJumpTarget(window.location.search);
  const bootAt = requestedAt ?? DEFAULT_BOOT_TARGET;
  if (!jump.jumpTo(bootAt)) {
    if (requestedAt !== null) {
      console.warn(
        `[jump] ?at=${bootAt} is not a destination — have: ` +
          jump.targets.map((t) => t.name).join(', '),
      );
    }
  } else if (bootAt !== SPAWN_TARGET.name) {
    playerShip.sailTrim = 0;
  }
  /**
   * Sim time of the last ocean FFT dispatch — see the guard in the render path.
   * NaN so the first frame always dispatches (NaN !== NaN).
   */
  let lastOceanTime = Number.NaN;
  /** HUD refresh divider for the GPU block — the sort is per-call, not per-frame */
  let perfFrame = 0;

  const loop = new GameLoop(
    (dt) => {
      if (paused) return;
      state.tick++;
      state.time += dt;
      // live wind follows ocean params (weather transitions lerp these)
      state.wind.speed = oceanParams.windSpeed;
      state.wind.direction = oceanParams.windDirection;
      weather.update(dt);
      // §V46: storm strength is a FIELD, not a global. Driving the ocean from
      // the sample at the ship's own position is what makes sailing into a
      // squall real — and because rain and cell drift both read oceanParams,
      // sea, rain and cloud stay self-consistent for free.
      // AFTER weather.update: the transition lerp writes ambient into
      // oceanParams and restore() is what adopts it (§V.62 — same path a
      // panel drag takes). BEFORE weatherAt: it is the blend's `from` end.
      oceanAmbient.restore();
      weather.weatherAt(playerShip.position[0], playerShip.position[2], weatherHere);
      oceanAmbient.publish(weatherHere.ocean);
      const snapshot = input.sample(dt);
      stepShipSailing(playerShip, snapshot, state.wind, dt);
      // §V.15: the AI emits the SAME InputState a keyboard produces, so she
      // sails the player's exact code path rather than a parallel model
      const enemyCommands = stepAiShip(enemyAi, state, 0);
      stepShipSailing(enemyShip, enemyCommands.input, state.wind, dt);
      cpuOcean.update(state.time);
      // §T.16: Space fires the battery the CAMERA bears on (§I gives the
      // player one key, so the side has to be inferred from where she is
      // looking). The enemy's order comes out of the SAME state machine that
      // steers her — §V.15's broadside state, finally connected to a gun.
      // Runs before flooding: a breach opened this tick ships water this tick.
      // hold() first: it pins the test scene's hulls and drains its forced
      // damage, so the orders below are built against this tick's real poses
      arena?.hold(state);
      const orders: FireOrder[] = arena
        ? [arena.playerOrder(snapshot.fire), arena.enemyOrder()]
        : [
            {
              shipIndex: 0,
              fire: snapshot.fire,
              aimBearing: viewBearing(app.camera.matrixWorld.elements),
            },
            enemyCommands.order,
          ];
      combat.tick(state, dt, orders);
      // §V.14 flooding: breaches recorded by combat, measured against the sea
      const playerHoles = combat.floodHoles(state, 0);
      stepFlooding(playerShip, playerHoles, dt);
      stepShipBuoyancy(playerShip, cpuOcean, dt, undefined, playerHoles);
      const enemyHoles = combat.floodHoles(state, 1);
      stepFlooding(enemyShip, enemyHoles, dt);
      stepShipBuoyancy(enemyShip, cpuOcean, dt, undefined, enemyHoles);
      // AFTER buoyancy: at flood = 1 support and probe damping are both gone,
      // so this is the only floor under the wreck (§T.18, sinking.ts).
      combat.settle(state, dt);
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
          // the whole per-slice contact set, not just the cutwater: water is
          // injected at the stations actually burying, which is what stops it
          // appearing along the entire length at once (user report)
          hull: hullContact,
        },
        dt,
      );
      // lantern pendulums: driven by the ship's EXACT sim pose and velocity at
      // the fixed tick, never by the interpolated render pose (§V.2). Placing
      // them in the world happens at render rate — see the render path.
      for (const id of LANTERN_IDS) {
        lanterns.step(
          id,
          { quaternion: playerShip.quaternion, velocity: playerShip.velocity },
          dt,
        );
      }
      prevPos.copy(currPos);
      prevQuat.copy(currQuat);
      prevVel.copy(currVel);
      currPos.fromArray(playerShip.position);
      currQuat.fromArray(playerShip.quaternion);
      currVel.fromArray(playerShip.velocity);
    },
    (alpha, frameDt) => {
      debug.hud.frame(frameDt * 1000);
      sky.setShadowFocus(playerShip.position[0], playerShip.position[1], playerShip.position[2]);
      sky.update(skyParams.timeOfDay);

      let t = performance.now();
      /**
       * THE OCEAN FFT IS A PURE FUNCTION OF `state.time`, AND `state.time`
       * ONLY MOVES ON A TICK — so dispatching it on a frame where no tick
       * fired recomputes bit-identical texels and throws them away.
       *
       * `OceanSimulation.update` reads exactly two things: `time` and the
       * `oceanParams` singleton. No camera, no scene, no renderer state. It
       * sets `timeUniform`/`choppinessUniform` and dispatches the spectrum →
       * butterfly → unpack passes, which sample only h0 (static between
       * rebuilds), those two uniforms and the butterfly table. Same inputs,
       * same output textures — the skip cannot change a pixel by construction,
       * which is why this is a guard and not a heuristic.
       *
       * Measured: on a 120 Hz display half of all frames run no tick, so half
       * of the 3-cascade FFT dispatches were redundant. Watch it on the HUD's
       * `ocean+foam cpu-dispatch` line.
       *
       * `paused` is the exception, not an optimisation: the sim clock is
       * frozen there, so without it a live ocean-param tweak from the debug
       * panel would reach nothing until unpause — a silent no-op of exactly
       * the §B.7 shape. Paused frames are not the ones under budget pressure.
       *
       * NOT extended to `clouds.update` below: that one is camera-dependent
       * (fitToCamera + view-space sun basis + an offscreen pass rendered FROM
       * the camera), so it is not a function of time alone and must run every
       * frame — see its call site.
       */
      if (paused || state.time !== lastOceanTime) {
        lastOceanTime = state.time;
        ocean.update(app.renderer, state.time);
      }
      // frameDt, not nothing: foam accumulates/decays per dispatch, so it
      // steps itself on the fixed clock instead of at display rate (§V2)
      foam.update(app.renderer, frameDt);
      debug.hud.setPassTiming('ocean+foam cpu-dispatch', performance.now() - t);

      caustics.update(sky.sunDirection);
      // rain volume follows the camera through cameraPosition, so it only
      // needs local intensity + σ for the below-waterline cull (§V24/§V36)
      rain.update({
        intensity: weatherHere.rain,
        dt: frameDt,
        seaSigma: ocean.heightRms,
      });
      hullWetline.updateFromHullContact(frameDt, hullContact.stations, hullContact.depth);

      t = performance.now();
      // NOT guardable on `state.time` the way the ocean above is, and the
      // resemblance is a trap. `clouds.update` refits the camera-pinned
      // composite + band quads (`fitToCamera`), rebuilds the view-space sun/up
      // basis from `camera.matrixWorld`, and renders the cores pass FROM the
      // camera into an offscreen RT. The camera moves every render frame
      // (followCam runs at display rate), so skipping a no-tick frame would
      // leave the cloud quads fitted to the previous frame's view and the
      // puffs lit in a stale basis — clouds visibly swimming against the
      // camera. Its output is a function of the CAMERA, not of time alone.
      clouds.update(state.time, sky.sunDirection);
      debug.hud.setPassTiming('clouds cpu-dispatch', performance.now() - t);

      // spray + wake systems follow the ship (§V.6, §V.10)
      const shipYaw = Math.atan2(
        rotateVec(playerShip.quaternion, [0, 0, 1])[0],
        rotateVec(playerShip.quaternion, [0, 0, 1])[2],
      );
      const shipSpeed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      spray.centerUniform.value.set(playerShip.position[0], playerShip.position[2]);
      // wind VELOCITY, not a direction: spray is carried by the air it is
      // thrown into, so a gale has to blow it further than a breeze does
      windVecTmp.set(
        Math.cos(state.wind.direction) * state.wind.speed,
        Math.sin(state.wind.direction) * state.wind.speed,
      );
      // the moments feed the σ-relative crest gates (§V.36/§V.59) — omitting
      // them makes the emitter fall back to bootstrap constants and warn,
      // because silently gating on a constant is the exact bug those
      // invariants exist to stop
      if (FEATURES.spray) {
        spray.update(app.renderer, windVecTmp, {
          heightRms: ocean.heightRms,
          jacobianRms: ocean.jacobianRms,
          choppiness: ocean.effectiveChoppiness(),
        });
      }
      const bowLocal = rotateVec(playerShip.quaternion, [0, 0, stemZ]);
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
          // §V30/§V43: the islands melt into the SAME atmosphere the water
          // does. The sky rig retints scene.fog.color every frame and the
          // ocean copies it for its own haze, so handing the identical object
          // over is what keeps land and sea agreeing at every coastline.
          hazeColor: app.scene.fog?.color ?? hazeFallback,
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
          stemZ,
          transomZ,
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
      // velocity on the SAME alpha, not the raw sim value: it feeds the
      // camera's look-ahead, and an un-interpolated one steps at the tick rate
      // while everything else glides — measured 0.05°/frame of aim jitter in a
      // hard turn at 120 fps, ~150x the interpolated figure. Interpolating (as
      // opposed to damping the aim) costs no lag, so the anticipation
      // `lookAhead` exists for is untouched. NOT a reference assignment: this
      // array must stay distinct from playerShip.velocity or the render path
      // would write back into the sim (§V.3).
      renderShipView.velocity[0] = prevVel.x + (currVel.x - prevVel.x) * alpha;
      renderShipView.velocity[1] = prevVel.y + (currVel.y - prevVel.y) * alpha;
      renderShipView.velocity[2] = prevVel.z + (currVel.z - prevVel.z) * alpha;
      // COMBAT SHAKE, in a fixed three-part order around the follow camera.
      // `restore` MUST come first: FollowCam.update() adopts any external
      // camera rotation as the free camera's own pose, so a shake left on the
      // lens would be folded in and accumulate permanently — a silent,
      // cumulative drift that would surface as a free-cam bug in another file.
      combat.shake.restore(app.camera);
      followCam.update(renderShipView, frameDt, (x, z) => cpuOcean.heightAt(x, z, state.time));
      combat.shake.update(frameDt, app.camera);
      combat.shake.apply(app.camera);

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

      // lanterns follow the INTERPOLATED pose, so they do not judder against
      // the hull they hang from on frames between two ticks.
      // socketWorldPosition walks its own parent chain, so the group pose set
      // above is all it needs — no extra updateMatrixWorld.
      for (const id of LANTERN_IDS) {
        lanterns.place(
          id,
          shipAssembly.socketWorldPosition(LANTERN_SOCKETS[id]),
          renderShipView.quaternion,
        );
      }
      // ONE clock for every practical light in the world (§V.55's lesson
      // about second sources) — the sky owns dusk, the lanterns read it.
      lanterns.sync(sky.nightFactor);

      // enemy render pose. No interpolation caches for her: she is a distant
      // subject, not the camera's anchor, so per-tick pose is imperceptible
      // and the §V.2 interpolation only matters for what the camera chases.
      enemyAssembly.group.position.set(
        enemyShip.position[0],
        enemyShip.position[1],
        enemyShip.position[2],
      );
      enemyAssembly.group.quaternion.set(
        enemyShip.quaternion[0],
        enemyShip.quaternion[1],
        enemyShip.quaternion[2],
        enemyShip.quaternion[3],
      );
      updateRig(enemyAssembly, frameDt, enemyShip.sailTrim);

      // rigging follows the moving ship: rewrite anchors, GPU re-solves (§V.12)
      if (FEATURES.ropes) {
        shipAssembly.group.updateMatrixWorld(true);
        // furl 0..1 from the SAME cloth scalar the sail geometry and the haul
        // audio use, so rope, canvas and sound cannot disagree about how far
        // she is reefed. dropScale runs trimDropMin (fully reefed) → 1 (full
        // sail), so furl is its normalised complement.
        const drop = trimDropScale(playerShip.sailTrim, shipRigParams);
        const furl = Math.min(
          1,
          Math.max(0, (1 - drop) / Math.max(1e-3, 1 - shipRigParams.trimDropMin)),
        );
        applyRiggingPlan(
          riggingPlan,
          ropes,
          (id) => shipAssembly.socketWorldPosition(id),
          furl,
        );
        // no applyBlocks: the pulleys hang off the solved curve on the GPU, so
        // re-anchoring the ropes above is the only CPU work the rig needs
        app.renderer.compute(ropes.computeNode);

        enemyAssembly.group.updateMatrixWorld(true);
        applyRiggingPlan(
          enemyRiggingPlan,
          enemyRopes,
          (id) => enemyAssembly.socketWorldPosition(id),
          furl,
        );
        app.renderer.compute(enemyRopes.computeNode);
      }

      const speed = Math.hypot(playerShip.velocity[0], playerShip.velocity[2]);
      ui.setSpeed(speed * 1.944); // m/s → knots
      const fwd = shipAssembly.group.getWorldDirection(tmpDir);
      const headingRad = Math.atan2(fwd.x, fwd.z);
      ui.setHeading(headingRad);
      // The wind plaque and vane read APPARENT wind, which the HUD derives
      // itself from these four numbers using the same apparentWind() the flags
      // and sails use — so what the player reads and what the canvas answers to
      // cannot drift apart. `state.wind` is the LIVE wind (weather transitions
      // write it every tick), not the params default.
      ui.setWind({
        windDirection: state.wind.direction,
        windSpeed: state.wind.speed,
        shipVelX: playerShip.velocity[0],
        shipVelZ: playerShip.velocity[2],
        headingRad,
      });
      // canvas plaque: raw trim 0..1. The HUD re-runs sailStateForTrim() with
      // the SAME hysteresis the rig uses, so the plaque flips on the exact
      // frame the canvas does rather than a frame either side of it (§I hud).
      ui.setTrim(playerShip.sailTrim);

      // smoke, splinters, splashes, balls in flight and fallen spars —
      // render-clock particles reading sim-owned projectiles (§V.3)
      combat.update(frameDt, state);

      surface.update(app.camera, state.time, sky.sunDirection);
      // AFTER the camera is final for this frame (followCam ran above) and
      // BEFORE post reads its uniforms: the volume needs THIS frame's camera
      // matrices, or the meridian lags the lens by a frame under fast motion.
      underwater.update(
        frameDt,
        (x, z) => cpuOcean.heightAt(x, z, state.time),
        state.time,
      );
      if (usePost()) {
        post.updateFromParams();
        post.render();
      } else {
        app.render();
      }
      debug.hud.setRenderStats(app.renderer.info.render);
      /**
       * DRAIN THE TIMESTAMP POOLS, or §V.39's own method breaks (third time).
       *
       * three writes a query pair per pass EVERY frame and only recycles them
       * when someone resolves. Nothing did, so the pool filled and the console
       * reported "Maximum number of queries exceeded", after which the numbers
       * are silently wrong rather than absent — the same shape as §B.25: the
       * sanctioned measurement was itself the broken thing, and it reads as a
       * slow scene rather than as a bug.
       *
       * BOTH pools, not just RENDER. Compute gets its own query set and the
       * ocean FFT lives there, so resolving only RENDER left the compute pool
       * permanently full — and three's overflow path returns `null`, which
       * `initTimestampQuery` writes into `beginningOfPassWriteIndex` unchecked,
       * where WebIDL turns it into 0. An overflowed pool therefore ALIASES every
       * later pass onto query pair 0 instead of erroring.
       *
       * Unawaited on purpose: this reads back the queries submitted moments
       * ago, so awaiting it would stall the render thread on the GPU in order
       * to measure the GPU. Errors are swallowed — a diagnostic must never be
       * able to take the frame down.
       */
      if (gpuTimer !== null) {
        gpuTimer.tick();
        if (++perfFrame % 15 === 0) debug.hud.setGpu(formatGpuHud(gpuTimer));
      } else {
        void app.renderer.resolveTimestampsAsync(TimestampQuery.RENDER).catch(() => undefined);
        void app.renderer.resolveTimestampsAsync(TimestampQuery.COMPUTE).catch(() => undefined);
      }

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
      // the whole contact set, typed structurally so src/audio imports nothing
      // from sea-physics. Drives hull working (creak) and the slam trigger —
      // arrays are reused per tick, audio reads them inside update() only.
      audioShip.contact = hullContact;
      // the SAME scalar updateRig uses, so the haul sound and the cloth move
      // together by construction rather than by coincidence
      audioShip.sailDrop = trimDropScale(playerShip.sailTrim, shipRigParams);
      audioBowWorld[0] = bowWorldTmp.x;
      audioBowWorld[1] = bowWorldTmp.y;
      audioBowWorld[2] = bowWorldTmp.z;
      audio.update(audioFrame);
    },
    // the loop owns the pause, so the accumulator stops with the sim and the
    // interpolation alpha holds flat (§V.21) — see GameLoop.frame
    () => paused,
  );
  // Warm up BEFORE showing the world. compileAsync walks the scene and builds
  // every material's pipeline up front — otherwise the first frames stall for
  // seconds compiling shaders one material at a time, which is what the boot
  // splash was hiding badly (it dismissed on the canvas being appended, long
  // before anything drew, leaving a blank screen).
  //
  // §T.40: the cost is not hidden, it is made smaller and paid in two parts.
  // Part one is everything the first picture needs; part two runs after the
  // splash lifts, spread across frames, so the game is sailing while it
  // finishes. Every phase is measured per material (compileProfile.ts) —
  // "which subsystem feels heavy" is exactly how this got to 52s.

  /**
   * COVERAGE GUARD, and it is a real hole rather than a precaution.
   * `Renderer.compileAsync()` runs the same `_projectObject` walk a render
   * does — including the frustum cull — but it never rebuilds `_frustum`
   * (only `_renderScene` does, three r180 Renderer.js:1410). So the warm-up
   * culls against whatever was left there: on a cold boot, a default Frustum
   * whose six planes are all `x + 0 = 0`, which rejects every object whose
   * centre sits at negative world X. Those materials are then MISSING from
   * the warm-up and compile synchronously on their first draw — a hitch,
   * silently, and exactly what the splash is meant to have already paid for.
   * Nor does it update matrices, so the cull runs on stale ones.
   *
   * Turn culling off for the walk, restore precisely what was there. The
   * restore happens BEFORE the await: compileAsync is synchronous up to its
   * final `Promise.all`, so by then the walk is done, and leaving the flags
   * off across the wait would silently un-cull the running game.
   */
  const withFullCoverage = (root: Object3D, compile: () => Promise<unknown>): Promise<unknown> => {
    const culled: boolean[] = [];
    root.updateMatrixWorld(true);
    root.traverse((o) => {
      culled.push(o.frustumCulled);
      o.frustumCulled = false;
    });
    const pending = compile();
    let i = 0;
    root.traverse((o) => {
      o.frustumCulled = culled[i++] ?? o.frustumCulled;
    });
    return pending;
  };

  /** compile ONE object against the context it will actually be drawn in. */
  const warmObject = async (object: Object3D): Promise<void> => {
    await withFullCoverage(object, () =>
      postParams.enabled
        ? post.warmObject(object)
        : app.renderer.compileAsync(object, app.camera, app.scene),
    );
  };

  bootMark('scene build');
  await showBootPhase('shader compile');
  compilePhases.push(
    await profileCompile(app.renderer, 'core scene', () =>
      withFullCoverage(app.scene, () =>
        // post is the real render path when it is on, and its pass target has
        // a different sample count and colour format than the canvas — hence a
        // different pipeline cache key. Compiling against the wrong one means
        // paying the whole cost twice, the second time synchronously.
        postParams.enabled
          ? post.warmup()
          : app.renderer.compileAsync(app.scene, app.camera),
      ),
    ),
  );
  bootMark('shader compile');
  await showBootPhase('first frame');
  // one real presented frame, so the splash lifts on a picture and not on a
  // promise: the ocean/foam/rope compute passes also have to run once before
  // the surface has anything to show.
  ocean.update(app.renderer, state.time);
  foam.update(app.renderer);
  clouds.update(state.time, sky.sunDirection);
  surface.update(app.camera, state.time, sky.sunDirection);
  if (postParams.enabled) {
    post.updateFromParams();
    await post.presentAsync();
  } else {
    await app.renderer.renderAsync(app.scene, app.camera);
  }

  bootMark('first frame');
  loop.start();
  bootTimings.push(['TOTAL', +(performance.now() - bootT0).toFixed(1)]);
  console.info('[boot]', bootTimings.map(([k, v]) => `${k} ${v}ms`).join('  ·  '));
  (window as unknown as { __bootReady?: () => void }).__bootReady?.();
  ui.showQuickControls();

  // --- part two: warm the deferred subsystems, one per turn of the event
  // loop, and add each only once its pipelines exist (§T.40).
  //
  // setTimeout, NOT rAF: Chrome suspends rAF entirely in a hidden tab (§V.39),
  // and a warm-up that never finishes in a background tab would hand the first
  // visible frame the exact synchronous compile it exists to prevent.
  const nextTurn = (): Promise<void> =>
    new Promise((resolve) => {
      window.setTimeout(resolve, 0);
    });
  const warmDeferred = async (): Promise<void> => {
    for (const { label, object } of deferred) {
      await nextTurn();
      const phase = await profileCompile(app.renderer, `warm:${label}`, () =>
        warmObject(object),
      );
      compilePhases.push(phase);
      app.scene.add(object);
      bootTimings.push([`warm:${label}`, phase.wall]);
    }
    console.info(
      '[boot] background warm-up done',
      deferred.map((d) => d.label).join(', ') || '(nothing deferred)',
    );
    logCompileProfile(compilePhases);
  };
  void warmDeferred();


  /**
   * §V.39 measurement handle. `__perf.report()` prints the per-pass min-of-N
   * table; `__perf.reset()` starts a fresh window, which is what an A/B leg
   * needs (frozen tick + forced camera, §V.63). `__perf.timer` is null when
   * GPU timestamps are unavailable on this machine — and null means NO NUMBER,
   * not "fall back to wall clock" (§B.25).
   */
  (window as unknown as Record<string, unknown>).__perf = {
    timer: gpuTimer,
    report: (): void => {
      if (gpuTimer === null) {
        console.warn('[gpuTimer] not installed — GPU timing unavailable (§V.39).');
        return;
      }
      reportGpu(gpuTimer);
    },
    reset: (): void => gpuTimer?.reset(),
    health: () => gpuTimer?.health() ?? null,
  };

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
    riggingPlan,
    blockDescriptors,
    // verification handles: agents need these reachable from the console to
    // do §V29 readbacks and to isolate subsystems without a rebuild
    flowFoam,
    foam,
    deckWater,
    caustics,
    // §V.25 verification handle: `__game.underwater.blend` / `.mode` are the
    // only way to tell "the volume is off" from "the volume is on and wrong"
    // from a screenshot, and this module spent its whole life dead precisely
    // because nothing ever asked it whether it was running.
    underwater,
    reflection,
    archipelago,
    hullContact,
    cpuOcean,
    combat,
    arena,
    enemyAi,
    bootTimings,
    // §T.40 verification handles: the per-material compile ranking, and a
    // re-rank over whatever has been warmed so far.
    compilePhases,
    compileRanking: (): ReturnType<typeof rankCompile> => rankCompile(compilePhases),
    /** §T.52: `__game.jumpTo('lagoon')` / `('spawn')` — same path as the J key */
    jumpTo: jump.jumpTo,
    jumpTargets: jump.targets,
    /** debug: put the hull at a speed without waiting on the wind */
    setSpeed(knots: number): void {
      const ms = knots / 1.944;
      const fwd = rotateVec(playerShip.quaternion, [0, 0, 1]);
      playerShip.velocity[0] = fwd[0] * ms;
      playerShip.velocity[2] = fwd[2] * ms;
    },
  };
}

import {
  Color,
  Quaternion,
  TimestampQuery,
  Vector2,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
} from 'three/webgpu';
const tmpDir = new Vector3();
/**
 * Fallback atmosphere colour if the scene ever has no fog. Same fallback the
 * ocean uses (oceanSurface.ts) so land and sea cannot melt into two different
 * skies. §V31: hex must enter through `new Color(hex)`, never `setRGB`.
 */
const hazeFallback = new Color(skyParams.horizonColor);
const windVecTmp = new Vector2();
const bowWorldTmp = new Vector3();
const shipVelTmp = new Vector3();
const shipFwdTmp = new Vector3();

boot();
