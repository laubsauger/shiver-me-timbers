/**
 * THE IMPACT (§V.14's visible half) — the tests that would have caught it.
 *
 * WHAT WAS WRONG. `combatFx.emit` read `frame.muzzles`, `frame.destruction`
 * and `frame.projectiles` and never read `frame.hits`. Every cannonball that
 * struck a hull reached exactly one consumer repo-wide — `audio.event
 * ('ballHit')` — so a hit made a SOUND AND NO PICTURE. The user's words:
 * "I just see a very weak impact sound and that's it", "there's like no
 * visual effect of an impact whatsoever".
 *
 * The one hull visual that did exist hung off destruction's `splinters`
 * event, which fires EXACTLY ONCE per piece, at the hp threshold. At
 * hitDamage 0.25 / holedThreshold 0.5 that is hit 2 of 4, and after hit 4 the
 * piece is at 0 hp and never emits again — ONE HIT IN FOUR drew anything and
 * then nothing ever again, which is why it read as random rather than absent.
 *
 * WHY THE OLD TESTS WENT GREEN THROUGH ALL OF IT. combatWiring asserted that
 * "smoke and flash reach the sprite buffer on a MUZZLE event" and that a
 * `ballHit` SOUND carries a position. Both true, both still true, neither
 * says anything about whether a hit is drawn. These tests assert the thing
 * that was actually missing, and each is written so it FAILS if the behaviour
 * regresses rather than merely exercising the code:
 *
 *   - a hit that breaches NOTHING still draws (the whole bug),
 *   - drawing does not depend on the destruction event (escalate, not gate),
 *   - the dev harness's forced hit lands OUTSIDE the piece it hits,
 *   - the flash light is never added to or removed from anything,
 *   - the additive brightness is bounded at source (§V.44),
 *   - the ring's thickness knob is live (§V.62).
 */
import { describe, expect, it } from 'vitest';
import { Matrix4, Object3D, Quaternion, Vector3, type Material } from 'three';
import { SIM_DT } from '../src/core/loop';
import { createInitialState, type ShipState, type SimState } from '../src/state/simState';
import { buildGalleonBlueprint } from '../src/ship/shipBlueprint';
import { ShipAssembly } from '../src/ship/shipAssembly';
import { createCombatRuntime } from '../src/combat/combatRuntime';
import { createCombatFx } from '../src/combat/combatFx';
import { createFlashLight } from '../src/combat/flashLight';
import { createImpactRings } from '../src/combat/impactRing';
import { createProfiles, fillProfiles } from '../src/combat/fxProfiles';
import { BOOST_MAX, brightnessAt } from '../src/combat/fxMath';
import { combatFxParams } from '../src/params/combat';
import { destructionParams } from '../src/params/destruction';
import type { CombatFrame } from '../src/combat/combatSystem';
import type { HitEvent } from '../src/combat/hitTest';

const stub = (): Material => ({ dispose(): void {} }) as unknown as Material;

function makeShip(id: string, x: number, z: number): ShipState {
  return {
    id,
    kind: id === 'player' ? 'player' : 'enemy',
    position: [x, 0, z],
    quaternion: [0, 0, 0, 1],
    velocity: [0, 0, 0],
    angularVelocity: [0, 0, 0],
    sailTrim: 0,
    rudder: 0,
    damage: {},
    flood: 0,
  } as ShipState;
}

function rig(): { state: SimState; runtime: ReturnType<typeof createCombatRuntime> } {
  const state = createInitialState(4242);
  state.ships.push(makeShip('player', 0, 0));
  state.ships.push(makeShip('enemy-1', 40, 0));
  const assemblies = state.ships.map(() => new ShipAssembly(buildGalleonBlueprint(), stub));
  assemblies.forEach((a, i) => {
    a.group.position.fromArray(state.ships[i].position);
    a.group.updateMatrixWorld(true);
  });
  const runtime = createCombatRuntime({
    ships: assemblies.map((assembly, shipIndex) => ({
      shipIndex,
      blueprint: buildGalleonBlueprint(),
      assembly,
    })),
    waterHeightAt: () => 0,
    audio: null,
  });
  return { state, runtime };
}

/** an empty frame carrying only the hits we hand it */
function frameWith(hits: HitEvent[]): CombatFrame {
  return { muzzles: [], hits, projectiles: [], destruction: [], detached: [] };
}

/** one ring instance's world transform */
function ringTransform(mesh: Object3D, i: number): Matrix4 {
  const m = new Matrix4();
  (mesh as unknown as { getMatrixAt(i: number, m: Matrix4): void }).getMatrixAt(i, m);
  return m;
}

interface FxPool {
  position: Float32Array;
  color: Float32Array;
  size: Float32Array;
  aspect: Float32Array;
  seed: Float32Array;
  tear: Float32Array;
  kinds: string[];
}

/** the pool's PUBLISHED buffers — never reach through the node graph */
function pool(root: Object3D): FxPool {
  const sprites = root.getObjectByName('combat-sprites');
  const p = (sprites as unknown as { userData?: { fxPool?: FxPool } })?.userData?.fxPool;
  if (p === undefined) throw new Error('combat-sprites has no published fxPool');
  return p;
}

/** the sprite pool's live per-instance sizes (0 = dead, §V.28) */
function liveSprites(root: Object3D): number[] {
  return [...pool(root).size].filter((s) => s > 0);
}

describe('a cannonball hit is DRAWN, not only heard (the whole defect)', () => {
  it('a hit that breaches nothing still puts particles on screen', () => {
    // THE regression. `frame.destruction` is deliberately EMPTY: this is an
    // ordinary hit, the kind that was three times out of four, and the kind
    // that drew literally nothing. If someone re-gates the impact on the
    // destruction event, this is the test that goes red.
    const fx = createCombatFx();
    expect(liveSprites(fx.group)).toHaveLength(0);

    fx.emit(frameWith([{ shipIndex: 0, pieceId: 'hull-port-mid', point: [3, 2, 1], projectileId: 7 }]));
    fx.update(1 / 60, []);

    const live = liveSprites(fx.group);
    // flash + debris + smoke, all three, or the strike does not read
    expect(live.length).toBeGreaterThanOrEqual(
      1 + combatFxParams.debrisPerHit + combatFxParams.impactSmokePerHit,
    );
    fx.dispose();
  });

  it('EVERY hit draws — not one in four, which is what the hp table gave', () => {
    // The old behaviour, stated as arithmetic so the intent survives a
    // retune: with hp starting at 1, only the hit that CROSSES holedThreshold
    // emitted a splinters event, and destruction fires it exactly once.
    const { hitDamage, holedThreshold } = destructionParams;
    let hp = 1;
    let breaches = 0;
    const hits = 4;
    for (let i = 0; i < hits; i++) {
      const after = Math.max(0, hp - hitDamage);
      if (hp > holedThreshold && after <= holedThreshold) breaches++;
      hp = after;
    }
    expect(breaches).toBe(1); // <- the old visual budget for four hits

    // and now: four hits, four bursts, regardless of that one breach
    const fx = createCombatFx();
    let previous = 0;
    for (let i = 0; i < hits; i++) {
      fx.emit(frameWith([
        { shipIndex: 0, pieceId: 'hull-port-mid', point: [3, 2, i], projectileId: i },
      ]));
      fx.update(1 / 600, []); // tiny dt: nothing dies between hits
      const live = liveSprites(fx.group).length;
      expect(live, `hit ${i + 1} of ${hits} drew nothing new`).toBeGreaterThan(previous);
      previous = live;
    }
    fx.dispose();
  });

  it('a breach ESCALATES the hit rather than gating it', () => {
    // Same hit, once without a destruction event and once with. The second
    // must draw strictly MORE — if it draws the same, the breach path has
    // become the only path again.
    const hit: HitEvent = {
      shipIndex: 0, pieceId: 'hull-port-mid', point: [3, 2, 1], projectileId: 11,
    };

    const plain = createCombatFx();
    plain.emit(frameWith([hit]));
    plain.update(1 / 600, []);
    const plainCount = liveSprites(plain.group).length;
    plain.dispose();

    const breached = createCombatFx();
    breached.emit({
      ...frameWith([hit]),
      destruction: [{ type: 'splinters', position: [3, 2, 1], count: 18 }],
    });
    breached.update(1 / 600, []);
    const breachedCount = liveSprites(breached.group).length;
    breached.dispose();

    expect(plainCount).toBeGreaterThan(0); // the ordinary hit draws at all
    expect(breachedCount).toBeGreaterThan(plainCount); // and the breach adds
  });

  it('the impact reaches the pool through the real runtime, on a real hit', () => {
    // end-to-end: no synthetic frame anywhere, a broadside that connects
    const { state, runtime } = rig();
    let hits = 0;
    for (let i = 0; i < 60 * 30 && hits === 0; i++) {
      state.tick++;
      hits = runtime.tick(state, SIM_DT, [
        { shipIndex: 0, fire: true, aimBearing: Math.PI / 2 },
      ]).hits.length;
    }
    expect(hits).toBeGreaterThan(0);
    runtime.update(1 / 60, state);
    expect(liveSprites(runtime.group).length).toBeGreaterThan(0);
  });
});

describe('debris comes OUT of the hull, not up out of the deck', () => {
  it('a hit on the port side throws its burst to port', () => {
    // A fixed [0,1,0] axis fountains debris vertically out of a vertical
    // wall, which reads as a geyser rather than a strike. The burst axis is
    // the ship's own outward normal, approximated centre → impact point.
    const fx = createCombatFx();
    const ship = makeShip('enemy-1', 0, 0);
    // impact well out to port (-x) and low on the side
    fx.emit(
      frameWith([{ shipIndex: 0, pieceId: 'hull-port-mid', point: [-5, 1, 0], projectileId: 3 }]),
      undefined,
      0,
      [ship],
    );
    fx.update(1 / 60, []);

    const { position: positions, size: sizes } = pool(fx.group);

    // of the live particles, the clear majority must have moved to PORT
    let toPort = 0;
    let live = 0;
    for (let i = 0; i < sizes.length; i++) {
      if (sizes[i] <= 0) continue;
      live++;
      if (positions[i * 3] < -5) toPort++;
    }
    expect(live).toBeGreaterThan(0);
    expect(toPort / live).toBeGreaterThan(0.6);
    fx.dispose();
  });
});

describe('the dev breach key stops burying its own burst', () => {
  it('a forced hit lands on the piece FACE, outside the solid', () => {
    // §B-class: `lerp(min, max, 0.5)` put the impact point at the AABB CENTRE
    // — inside opaque geometry — so every particle it spawned was
    // depth-rejected. Third occurrence of that shape in one day (bow wake
    // 3.5 m inside the stem, bow spray at the same wrong bowZ, this).
    const { state, runtime } = rig();
    const frame = runtime.forceHit(state, 1, 'hull-port-mid', 1);
    expect(frame.hits.length).toBeGreaterThan(0);

    const enemy = state.ships[1];
    const hit = frame.hits[0];
    // ship-local x of the impact, with the hull unrotated (identity quat)
    const localX = hit.point[0] - enemy.position[0];

    const piece = buildGalleonBlueprint().find((p) => p.id === 'hull-port-mid');
    expect(piece).toBeDefined();
    const halfBeam = Math.max(Math.abs(piece!.aabb.min[0]), Math.abs(piece!.aabb.max[0]));

    // the point must sit at the piece's own outboard extent, not at its
    // middle: |x| must clear the half-width rather than land near the axis
    expect(Math.abs(localX)).toBeGreaterThan(halfBeam * 0.5);
  });
});

describe('the flash light (§V.17, §T.47 — three recompiles on scene.add)', () => {
  it('is never added to or removed from anything; "off" is intensity 0', () => {
    // three folds the scene's light set into every material's cache key, so
    // adding one light recompiles EVERY shader in the scene, ocean included.
    // The light must therefore be a boot-time constant of the scene graph.
    const fx = createCombatFx();
    expect(fx.light.parent).toBeNull(); // NOT inside the deferred fx group
    expect(fx.group.getObjectByName('combat-flash')).toBeUndefined();
    expect(fx.light.intensity).toBe(0);
    expect(fx.light.castShadow).toBe(false); // 6 scene passes/frame otherwise
    fx.dispose();
  });

  it('lights on a strike and is dark again within its own decay', () => {
    const flash = createFlashLight(combatFxParams);
    flash.update(1 / 60);
    expect(flash.light.intensity).toBe(0);

    flash.strike(1, 2, 3);
    flash.update(1 / 600);
    expect(flash.light.intensity).toBeGreaterThan(0);
    expect(flash.light.position.toArray()).toEqual([1, 2, 3]);

    // §V.55: the envelope integrates dt. Run past the decay and it is out.
    for (let i = 0; i < 60; i++) flash.update(combatFxParams.flashLightDecay / 10);
    expect(flash.light.intensity).toBe(0);
    flash.dispose();
  });

  it('a non-finite position can never move the light (§V.28)', () => {
    const flash = createFlashLight(combatFxParams);
    flash.strike(5, 5, 5);
    flash.strike(Number.NaN, 1, 1);
    expect(flash.light.position.toArray()).toEqual([5, 5, 5]);
    flash.update(1 / 60);
    expect(Number.isFinite(flash.light.intensity)).toBe(true);
    flash.dispose();
  });

  it('bounds its intensity at source even with a hostile params set (§V.44)', () => {
    const hostile = { ...combatFxParams, flashLightIntensity: Number.NaN, flashLightDecay: 0 };
    const flash = createFlashLight(hostile);
    flash.strike(0, 0, 0);
    for (let i = 0; i < 10; i++) flash.update(1 / 60);
    expect(Number.isFinite(flash.light.intensity)).toBe(true);
    expect(flash.light.intensity).toBeGreaterThanOrEqual(0);
    flash.dispose();
  });
});

describe('additive brightness is bounded AT SOURCE (§V.44)', () => {
  it('no params edit can drive a particle past the boost ceiling', () => {
    // §V.44's exact shape: bloom is live now and an unbounded additive term
    // would define the exposure of the whole frame rather than glare in it.
    const hostile = { ...combatFxParams, flashBoost: 1e9, intensity: 1 };
    const prof = fillProfiles(createProfiles(), hostile);
    for (const p of Object.values(prof)) {
      expect(p.boost).toBeLessThanOrEqual(BOOST_MAX);
      expect(p.boost).toBeGreaterThan(0);
    }
    // and the product that actually reaches the buffer is bounded too:
    // brightnessAt ∈ [0,1] × boost ≤ BOOST_MAX × colour ∈ [0,1]
    let peak = 0;
    for (let i = 0; i <= 100; i++) peak = Math.max(peak, brightnessAt(i / 100));
    expect(peak).toBeLessThanOrEqual(1);
    expect(peak * prof.impactFlash.boost).toBeLessThanOrEqual(BOOST_MAX);
  });

  it('a NaN boost falls back to unity rather than poisoning the buffer', () => {
    const prof = fillProfiles(createProfiles(), { ...combatFxParams, flashBoost: Number.NaN });
    expect(prof.impactFlash.boost).toBe(1);
    expect(prof.flash.boost).toBe(1);
  });

  it('the flash kinds are the only ones boosted — smoke must not glare', () => {
    const prof = fillProfiles(createProfiles(), combatFxParams);
    expect(prof.flash.boost).toBeGreaterThan(1);
    expect(prof.impactFlash.boost).toBeGreaterThan(1);
    expect(prof.smoke.boost).toBe(1);
    expect(prof.impactSmoke.boost).toBe(1);
    expect(prof.column.boost).toBe(1);
  });
});

describe('impact profiles encode the timescale CONTRAST, not just values', () => {
  it('the flash is brief and the smoke lingers, by a wide margin', () => {
    // This is the thing that makes an impact read as an impact. A retune
    // that collapses the two toward each other is the regression worth
    // catching, so the test asserts the RATIO (§V.66), not the seconds.
    const prof = fillProfiles(createProfiles(), combatFxParams);
    expect(prof.impactFlash.life).toBeLessThan(0.15);
    expect(prof.impactSmoke.life).toBeGreaterThan(1.5);
    expect(prof.impactSmoke.life / prof.impactFlash.life).toBeGreaterThan(15);
  });

  it('the water column is a PILLAR: far tighter than the splash around it', () => {
    // spread is what separates a column from another round puff; if the two
    // converge, water entry goes back to being a ball of droplets
    const prof = fillProfiles(createProfiles(), combatFxParams);
    expect(prof.column.spread).toBeLessThan(prof.splash.spread * 0.5);
    expect(prof.column.speed).toBeGreaterThan(prof.splash.speed * 1.5);
  });
});

describe('the surface ring (§V.28, §V.62)', () => {
  it('spawns on water entry and rides the LIVE sea, not its birth height', () => {
    const rings = createImpactRings(combatFxParams);
    rings.spawn(10, 0, 20);
    // a sea that is 3 m up under this ring
    rings.update(1 / 60, () => 3);
    const pos = new Vector3();
    ringTransform(rings.mesh, 0).decompose(pos, new Quaternion(), new Vector3());
    expect(pos.y).toBeCloseTo(3 + combatFxParams.ringLift, 5);
    expect(pos.x).toBeCloseTo(10, 5);
    expect(pos.z).toBeCloseTo(20, 5);
    rings.dispose();
  });

  it('a dead ring is written at EXACTLY zero scale, never zero opacity', () => {
    // §V.28: an invisible-but-rasterized quad is the same fill-rate bill for
    // nothing, and §B.5 is what happens when that goes wrong
    const rings = createImpactRings(combatFxParams);
    rings.spawn(0, 0, 0);
    for (let i = 0; i < 200; i++) rings.update(1 / 60, () => 0);
    const scale = new Vector3(1, 1, 1);
    ringTransform(rings.mesh, 0).decompose(new Vector3(), new Quaternion(), scale);
    expect(scale.x).toBe(0);
    expect(scale.y).toBe(0);
    expect(scale.z).toBe(0);
    rings.dispose();
  });

  it('the thickness knob actually drives something (§V.62)', () => {
    // TEN occurrences of dead knobs in this project. The ring's profile
    // lives in vertex data, so a slider move has to RE-LAY it — if it only
    // read the param at construction the control would silently do nothing.
    const p = { ...combatFxParams, ringWidth: 0.2 };
    const rings = createImpactRings(p);
    const geo = (rings.mesh as unknown as { geometry: { attributes: { position: { array: Float32Array } } } }).geometry;
    const before = [...geo.attributes.position.array];

    p.ringWidth = 0.8;
    rings.update(1 / 60, () => 0);
    const after = [...geo.attributes.position.array];

    expect(after).not.toEqual(before);
    rings.dispose();
  });

  it('survives a hostile params set without producing a NaN transform', () => {
    const hostile = {
      ...combatFxParams,
      ringLife: 0, ringRadius: Number.NaN, ringWidth: Number.NaN, ringLift: Number.NaN,
    };
    const rings = createImpactRings(hostile);
    rings.spawn(Number.NaN, 1, 2);
    rings.update(Number.NaN, () => Number.NaN);
    const geo = (rings.mesh as unknown as { geometry: { attributes: { position: { array: Float32Array } } } }).geometry;
    for (const v of geo.attributes.position.array) expect(Number.isFinite(v)).toBe(true);
    rings.dispose();
  });
});
