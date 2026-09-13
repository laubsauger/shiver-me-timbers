/**
 * §T.181 S0 follow-ups — the speedboat page's sea plumbing is SHARED, not copied, and the hooks the
 * page used to leave dead now carry real data.
 *
 * WHY each block:
 *  - §V95 ONE SEA SEQUENCE: the raft and the speedboat each ran the same 30-odd sea calls (spectrum,
 *    mirror, wake track, sky → rain, spray, shore, flowfoam, clouds, reflection, surface). Two copies
 *    drift: the first sea system added to one page silently never reaches the other. The runs live in
 *    `core/seaFrame.ts`; this pins that neither entry re-grows a copy (by the calls' most distinctive
 *    lines, so a renamed paste is caught too) and that both call the runs in the order TSL and the
 *    camera need (shore tags foam targets BEFORE the injection capture; camera passes AFTER the lens).
 *    The raft's bit-identity across the extraction is recorded in docs/speedboat/page.md (scratch hash).
 *  - PROP JETS REACH THE FOAM: `createFlowFoam({ propJets })` sizes the sim foam's jet slots at
 *    construction; with 0 slots `setPropWash` is a silent no-op and the rooster tail's wash never paints.
 *  - BURIAL + WETLINE ARE REAL: `setHullBurial(null)` and an empty wetline feed were the S0 stubs; the
 *    page must hand the contact's station view to both, and forget its rate history on a teleport.
 *  - AUDIO HOOKS (docs/speedboat/audio.md hooks 1–5): per-drive advance/immersion or the rpm load
 *    loses ventilation; a slam overwritten per tick is lost whenever a frame covers two ticks (the hit you
 *    hear depends on the frame rate); rivals with no contact/throttle are silent on landings; and the
 *    crash hook must keep seeing THIS tick's slam, not the frame's sum.
 *  - PARAMS ON THE PANEL (§V16): the sea params live in `src/params`, registered, and the object the
 *    registry hands the panel IS the one the page builds the mirror and the fleet with (a copy would let
 *    the panel move the player's sea apart from the rivals', §V110).
 */
import { describe, expect, it } from 'vitest';
import mainSrc from '../src/main-speedboat.ts?raw';
import { SIM_DT } from '../src/core/loop';
import { oceanParams } from '../src/params/ocean';
import { createNpcFleetDriver, STRAIGHT_LINE_THROTTLE } from '../src/speedboat/page/npcFleet';
import { openSeaCourse } from '../src/speedboat/page/course';
import { B } from '../src/sim-worker/layout';
import seaFrameSrc from '../src/core/seaFrame.ts?raw';
import seaSceneSrc from '../src/core/seaScene.ts?raw';
import raftFrameSrc from '../src/raft/raftFrame.ts?raw';
import speedboatFrameSrc from '../src/speedboat/page/speedboatFrame.ts?raw';
import speedboatSceneSrc from '../src/speedboat/page/speedboatScene.ts?raw';
import { getParamsEntry } from '../src/params/registry';
import { seaPhysicsParams } from '../src/params/seaPhysics';
import { SPEEDBOAT_SEA_PARAMS_NAME, registerSpeedboatSeaParams } from '../src/params/speedboatSea';
import { HULL_DATA, buildDeepVHull } from '../src/speedboat/hullMesh';
import { speedboatSeaParams } from '../src/speedboat/page/seaParams';
import { SPAWN_CG_Y } from '../src/speedboat/page/course';

const code = (s: string): string => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
const seaFrame = code(seaFrameSrc);
const raft = code(raftFrameSrc);
const boat = code(speedboatFrameSrc);

/** a method body of a frame object: from `name(` to the next 4-space-indented method */
function method(src: string, name: string): string {
  const at = src.search(new RegExp(`\\n {4}${name}\\(`));
  expect(at, name).toBeGreaterThan(-1);
  const rest = src.slice(at + 1);
  const next = rest.slice(1).search(/\n {4}[a-zA-Z]+\(/);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

function inOrder(src: string, needles: string[]): void {
  let at = -1;
  for (const n of needles) {
    const i = src.indexOf(n, at + 1);
    expect(i, `'${n}' after position ${at}`).toBeGreaterThan(at);
    at = i;
  }
}

/** the distinctive lines of the shared runs — any of these in an entry is a copy */
const SHARED_LINES = [
  'advanceSpectrum(',
  'cpuOcean.update(',
  'setFlowDir(',
  'advanceWake(',
  'setShadowFocus(',
  'sea.ocean.update(',
  'sea.foam.update(',
  'sea.caustics.update(',
  'fetchField.update(',
  'sea.rain.update(',
  'centerUniform.value.set(',
  'sea.spray.update(',
  'archipelago.update(',
  'renderInjection(',
  'sea.flowFoam.update(',
  'sea.clouds.update(',
  'reflection?.update(',
  'sea.surface.update(',
];

describe('§V95 the raft and the speedboat drive their sea through ONE core/seaFrame', () => {
  it('seaFrame owns every shared call, and neither entry carries a copy of any of them', () => {
    for (const line of SHARED_LINES) expect(seaFrame, `seaFrame: ${line}`).toContain(line);
    for (const [name, src] of [['raftFrame', raft], ['speedboatFrame', boat]] as const) {
      expect(src, `${name} builds the shared frame`).toMatch(/createSeaFrame\(\{ app, sea, sky, state, weatherHere: d\.weatherHere, waterAt: d\.waterAt \}\)/);
      for (const line of SHARED_LINES) expect(src, `${name} re-grew '${line}'`).not.toContain(line);
    }
  });

  it('tick: spectrum before any force reads the sea; the wake track on the SIM pose (§V105)', () => {
    inOrder(method(raft, 'tickSea'), ['seaFrame.tickSpectrum()', 'seaFrame.trackWake(raft,', 'stepShipBuoyancy(']);
    expect(method(boat, 'tickSea')).toContain('seaFrame.tickSpectrum()');
    expect(method(boat, 'tickBoat')).toMatch(/seaFrame\.trackWake\(boat, hull\.stemZ, hull\.transomZ, hull\.beam, dt\)/);
  });

  it('render: base → wetline → spray → shore → flowfoam; lens → camera passes → surface, on both pages', () => {
    inOrder(method(raft, 'renderSea'), [
      'seaFrame.renderSeaBase(raft, frameDt, paused)',
      'wetline.updateFromHullContact(',
      'seaFrame.renderSpray(raft)',
      'sea.bowSpray',
      'seaFrame.renderShore()',
      'seaFrame.renderFlowFoam(frameDt)',
    ]);
    inOrder(method(boat, 'renderSea'), [
      'seaFrame.renderSeaBase(boat, frameDt, paused)',
      'wetline.updateFromHullContact(',
      'seaFrame.renderSpray(boat)',
      'seaFrame.renderShore()',
      'seaFrame.renderFlowFoam(frameDt)',
    ]);
    inOrder(method(raft, 'renderVessel'), ['d.placeCamera(', 'seaFrame.renderCameraPasses()', 'updateShipRig(', 'seaFrame.renderSurface()']);
    inOrder(method(boat, 'renderBoats'), ['d.placeCamera(', 'seaFrame.renderCameraPasses()', 'seaFrame.renderSurface()']);
    // the shared shore run tags the foam targets the injection capture then traverses for
    inOrder(seaFrame, ['archipelago.update(', 'renderInjection(']);
  });
});

describe('§T.180 c the speedboat sea compiles one prop-jet slot per drive', () => {
  it('buildSea forwards propJets to createFlowFoam, and the speedboat page asks for its drive count', () => {
    const scene = code(seaSceneSrc);
    const call = scene.slice(scene.indexOf('createFlowFoam({'), scene.indexOf('});', scene.indexOf('createFlowFoam({')));
    expect(call).toMatch(/propJets: opts\.propJets/);
    expect(code(speedboatSceneSrc)).toMatch(/propJets: HULL_DATA\.engines\.length/);
    // and the wake grid is the speedboat tier (reach astern at 40 m/s), not the 160 m ship tier
    expect(code(speedboatSceneSrc)).toMatch(/wakeTier: WAKE_SPEEDBOAT_TIER/);
    expect(HULL_DATA.engines.length).toBe(buildDeepVHull().drives.length);
    expect(HULL_DATA.engines.length).toBeGreaterThan(0);
  });
});

describe('§V101 burial and wetline read the player contact, not stubs', () => {
  it('tickBoat updates the station view after the step and hands it to the churn; renderSea feeds the wetline; snap forgets', () => {
    const tb = method(boat, 'tickBoat');
    inOrder(tb, ['stations.update(player.hw, boat, dt)', 'setHullBurial(stations)', 'wakeSim?.tick(']);
    expect(boat).not.toMatch(/setHullBurial\(null\)/);
    expect(boat).not.toMatch(/NO_CONTACTS|updateFromContacts\(/);
    expect(method(boat, 'renderSea')).toMatch(/wetline\.updateFromHullContact\(frameDt, stations\.stations, stations\.waterlineY\)/);
    expect(boat).toMatch(/const snap = \(\): void => \{\s*stations\.reset\(\);/);
  });
});

describe('§V16 speedboat sea params live in src/params and are the panel\'s object', () => {
  it('registered under its name with ranges; the registry holds the SAME object the page builds from', () => {
    const hull = buildDeepVHull();
    const p = speedboatSeaParams(hull);
    const entry = getParamsEntry(SPEEDBOAT_SEA_PARAMS_NAME);
    expect(entry?.params).toBe(p);
    expect(entry?.meta.hullDraft).toBeDefined();
    // the deep-V's rest keel depth, not the galleon's 2 m — and an independent copy of the shared defaults
    expect(p.hullDraft).toBeCloseTo(-(SPAWN_CG_Y + hull.keelBodyY), 12);
    expect(p.hullDraft).toBeLessThan(0.8);
    expect(p).not.toBe(seaPhysicsParams);
    p.mirrorResolution = 7;
    expect(seaPhysicsParams.mirrorResolution).not.toBe(7);
    expect(() => registerSpeedboatSeaParams({ keelBodyY: 5 }, SPAWN_CG_Y)).toThrow(/implausible/);
  });
});

describe('§T.183 audio hooks the page owes the sink', () => {
  const main = code(mainSrc);
  it('per-drive advance/immersion zero-copy; slams SUMMED per frame and reset after audio; crash keeps the per-tick slam; governor from the assists', () => {
    expect(main).toMatch(/driveAdvance: player\.hw\.driveAdvance, driveImmersion: player\.hw\.driveImmersion/);
    expect(main).toMatch(/audioFrame\.contact\.slamImpulse \+= player\.hw\.slamImpulse/);
    expect(main).not.toMatch(/audioFrame\.contact\.slamImpulse = player/);
    expect(main).toMatch(/c\.slamImpulse = player\.hw\.slamImpulse;[\s\S]*crash\.tick\(dt, boat, c\)/);
    inOrder(main, ['audio.update(audioFrame)', 'audioFrame.contact.slamImpulse = 0', 'npcs.resetSlam()']);
    expect(main).toMatch(/audioFrame\.governor = controls\.settings\.governor\.toLowerCase\(\)/);
    expect(main).toMatch(/npcContact: \(i\) => npcs\.contact\(i\), npcThrottle: \(i\) => npcs\.throttle\(i\)/);
    expect(mainSrc.split('\n').length).toBeLessThanOrEqual(300);
  });

  it('the fleet driver publishes each rival\'s stepper contact and applied throttle; slams accumulate until reset', async () => {
    const hull = buildDeepVHull();
    const warn = console.warn;
    console.warn = () => {};
    try {
      const npcs = await createNpcFleetDriver({
        seed: 2100, boats: 2, oceanParams: structuredClone(oceanParams), seaParams: speedboatSeaParams(hull),
        // rival 0 is dropped onto the water at 4 m/s: its landing is a slam the audio must hear
        spawn: (i) => {
          const p = openSeaCourse().spawn(i + 1);
          if (i === 0) {
            p.position[1] += 0.8;
            p.velocity[1] = -4;
          }
          return p;
        },
        caps: { crossOriginIsolated: false, sharedArrayBuffer: false, worker: false },
        budgetMs: 1e6,
      });
      let time = 0;
      let perTick = 0;
      for (let tick = 1; tick <= 40; tick++) {
        time += SIM_DT;
        npcs.recordTick(tick, time);
        npcs.pump(tick);
        npcs.pump(tick);
        perTick += npcs.fleet.readOut(0, B.SLAM_IMPULSE);
      }
      // never reset: the published sum is every collected tick's slam (one tick per request here)
      expect(perTick).toBeGreaterThan(0);
      expect(npcs.contact(0).slamImpulse).toBeCloseTo(perTick, 6);
      for (let i = 0; i < 2; i++) {
        expect(npcs.contact(i).wettedArea).toBeGreaterThan(1); // afloat at the spawn: real wetted area, not the sink's default
        expect(npcs.contact(i).propImmersion).toBeGreaterThan(0);
        expect(npcs.throttle(i)).toBe(STRAIGHT_LINE_THROTTLE);
      }
      npcs.resetSlam();
      expect(npcs.contact(0).slamImpulse).toBe(0);
      npcs.dispose();
    } finally {
      console.warn = warn;
    }
  }, 60_000);
});
