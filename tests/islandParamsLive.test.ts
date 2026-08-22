/**
 * §T.121 / §V16 / §V62 — THE ISLAND'S PARAMS ARE THE PANEL'S PARAMS.
 *
 * `createIsland` resolved its params with a SPREAD:
 *
 *   const p = bespoke ? { ...islandParams, ...overrides, archetype } : islandParams
 *
 * and `createArchipelago` passes a `radius` for every island it builds, so
 * `bespoke` was true for EVERY island in EVERY world. `p` was therefore a
 * snapshot of the Tweakpane object taken at construction, and six values that
 * `update()` reads PER FRAME out of it — `lodTerrainDistance`,
 * `lodTerrainMorphBand`, `lodRockCull`, `castShadows`, `radius`,
 * `foamTargetMargin` — could never move again. Six sliders that did nothing,
 * silently, which is §V62's exact shape (a value read once at construction
 * into a closure). It is also why the R3 lookdev agent could not answer the
 * CDLOD question with the toggle and had to instrument
 * `morphTargetInfluences` by hand.
 *
 * WHAT THESE TESTS ASSERT (§V62/§V80): not that a getter exists — that the
 * WORLD MOVES. Each knob is dragged at runtime and the thing it is supposed to
 * drive (geometry level, morph influence, `visible`, `castShadow`, the §V10
 * foam tag) is read back off the built objects. And the other half of the
 * contract: a per-island override still WINS, because the slice islands' own
 * radius and family are build inputs, not panel state.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as THREE from 'three/webgpu';
import { createIsland, liveIslandParams, type Island, type IslandFrame } from '../src/island/island';
import { sierraOverrides } from '../src/island/sierraSites';
import { islandParams, type IslandParams } from '../src/params/island';

/** small grids: this file is about the read path, not about terrain quality */
const SIERRA_GRID = 96;
const PIRATE_GRID = 96;

const shipped: IslandParams = { ...islandParams };
afterEach(() => {
  Object.assign(islandParams, shipped);
});

function frameAt(distance: number): Omit<IslandFrame, 'cameraPosition'> & { cameraPosition: THREE.Vector3 } {
  return {
    time: 0,
    windDir: [1, 0],
    windStrength: 0.3,
    waterLevel: 0,
    swell: 0.5,
    sunDirection: new THREE.Vector3(0.3, 0.9, 0.2).normalize(),
    hazeColor: new THREE.Color(0.6, 0.7, 0.8),
    cameraPosition: new THREE.Vector3(0, 6, distance),
  };
}

/** a slice island exactly as the sierra world builds one (family + overrides) */
const sierraIsland = (): Island =>
  createIsland({
    seed: 1337,
    position: [0, 0],
    radius: 200,
    archetype: 'dome',
    overrides: { ...sierraOverrides('dome'), gridSize: SIERRA_GRID },
  });

/** a scattered pirate island exactly as `createArchipelago` builds one */
const pirateIsland = (): Island =>
  createIsland({ seed: 42, position: [0, 0], radius: 180, overrides: { gridSize: PIRATE_GRID } });

const worlds: [string, () => Island][] = [
  ['sierra', sierraIsland],
  ['pirate', pirateIsland],
];

describe('§T.121 the six per-frame knobs are live on every island', () => {
  for (const [world, make] of worlds) {
    it(`${world}: lodTerrainDistance moves the mounted tessellation level`, () => {
      const island = make();
      try {
        // 700 m: inside the shipped 900 m swap, so level 0 is mounted
        island.update(frameAt(700));
        expect(island.terrain.lod).toBe(0);
        // drag the swap in front of the camera and the geometry must change
        islandParams.lodTerrainDistance = 600;
        island.update(frameAt(700));
        expect(island.terrain.lod).toBe(1);
        islandParams.lodTerrainDistance = 1400;
        island.update(frameAt(700));
        expect(island.terrain.lod).toBe(0);
      } finally {
        island.dispose();
      }
    });

    it(`${world}: lodTerrainMorphBand moves the CDLOD influence the GPU reads`, () => {
      const island = make();
      try {
        // the morph is what the R3 agent had to instrument by hand. Read the
        // influence, not the handle's own bookkeeping: the influence is the
        // number the vertex shader blends with.
        const influence = (): number => (island.terrain.mesh.morphTargetInfluences as number[])[0];
        island.update(frameAt(700));
        // (700 − (900 − 300)) / 300
        expect(influence()).toBeCloseTo(1 / 3, 6);
        islandParams.lodTerrainMorphBand = 600;
        island.update(frameAt(700));
        // (700 − (900 − 600)) / 600
        expect(influence()).toBeCloseTo(2 / 3, 6);
        expect(island.terrain.morph).toBeCloseTo(2 / 3, 6);
        // and the toggle beside it still switches the whole ramp off
        islandParams.lodTerrainMorph = false;
        island.update(frameAt(700));
        expect(influence()).toBe(0);
      } finally {
        island.dispose();
      }
    });

    it(`${world}: lodRockCull shows and hides the outcrops`, () => {
      const island = make();
      try {
        island.update(frameAt(3000));
        expect(island.rocks.group.visible).toBe(true);
        islandParams.lodRockCull = 1000;
        island.update(frameAt(3000));
        expect(island.rocks.group.visible).toBe(false);
        islandParams.lodRockCull = 4200;
        island.update(frameAt(3000));
        expect(island.rocks.group.visible).toBe(true);
      } finally {
        island.dispose();
      }
    });

    it(`${world}: castShadows reaches every caster, not just the ones built with it on`, () => {
      const island = make();
      try {
        island.update(frameAt(300));
        expect(island.terrain.mesh.castShadow).toBe(true);
        islandParams.castShadows = false;
        island.update(frameAt(300));
        // the hoisted caster list is the whole point: terrain, plants,
        // structures AND every rock variant, or the toggle is half dead
        expect(island.terrain.mesh.castShadow).toBe(false);
        expect(island.palms.mesh.castShadow).toBe(false);
        for (const rock of island.rocks.group.children) expect(rock.castShadow).toBe(false);
        islandParams.castShadows = true;
        island.update(frameAt(300));
        expect(island.terrain.mesh.castShadow).toBe(true);
        for (const rock of island.rocks.group.children) expect(rock.castShadow).toBe(true);
      } finally {
        island.dispose();
      }
    });

    it(`${world}: foamTargetMargin moves the §V10 foam capture band`, () => {
      const island = make();
      try {
        // 700 m out: past radius + the shipped 220 m margin, so the island is
        // untagged and flowfoam skips it
        island.update(frameAt(700));
        for (const t of island.foamTargets) expect(t.userData.foamTarget).toBe(false);
        islandParams.foamTargetMargin = 900;
        island.update(frameAt(700));
        for (const t of island.foamTargets) expect(t.userData.foamTarget).toBe(true);
      } finally {
        island.dispose();
      }
    });
  }

  it('radius is live where the island does not own one, and the override wins where it does', () => {
    // A slice island's radius is a BUILD INPUT — the heightmap was baked at it
    // — so `overrides`/`radius` must keep beating the panel. Everything the
    // island did not name stays live. Both halves, on the same object.
    const owned = createIsland({
      seed: 1337,
      position: [0, 0],
      radius: 200,
      archetype: 'dome',
      overrides: { ...sierraOverrides('dome'), gridSize: SIERRA_GRID, lodRockCull: 500 },
    });
    const unowned = createIsland({
      seed: 1337,
      position: [0, 0],
      archetype: 'dome',
      overrides: { ...sierraOverrides('dome'), gridSize: SIERRA_GRID },
    });
    try {
      // the foam band is `radius + foamTargetMargin`, so it reads the radius
      // the island is actually using
      islandParams.foamTargetMargin = 0;
      islandParams.radius = 260; // shipped default is smaller; drag it out
      unowned.update(frameAt(240));
      owned.update(frameAt(240));
      expect(unowned.foamTargets[0].userData.foamTarget).toBe(true); // 240 < 260
      expect(owned.foamTargets[0].userData.foamTarget).toBe(false); // 240 > its own 200

      // and an explicit override of a LIVE knob is not undone by the fix
      islandParams.lodRockCull = 4000;
      owned.update(frameAt(800));
      unowned.update(frameAt(800));
      expect(owned.rocks.group.visible).toBe(false); // its own 500 m
      expect(unowned.rocks.group.visible).toBe(true); // the panel's 4000 m
    } finally {
      owned.dispose();
      unowned.dispose();
    }
  });
});

describe('§V16 liveIslandParams is a VIEW of the panel object, not a copy', () => {
  it('every key the island does not own tracks the live value, in both directions', () => {
    const p = liveIslandParams({ radius: 123, archetype: 'dome' });
    expect(p.radius).toBe(123);
    expect(p.archetype).toBe('dome');
    const before = islandParams.lodRockCull;
    islandParams.lodRockCull = before + 777;
    expect(p.lodRockCull).toBe(before + 777);
    islandParams.lodRockCull = before;
    expect(p.lodRockCull).toBe(before);
    // …and the own key is unmoved by the panel
    islandParams.radius = 999;
    expect(p.radius).toBe(123);
  });

  it('still reads as a whole IslandParams — spreading it resolves every key', () => {
    // the heightmap generator takes this object and reads ~80 keys off it; a
    // view that only answered for the overridden ones would build a different
    // island than the one the panel describes
    const p = liveIslandParams({ radius: 123 });
    const flat = { ...p } as Record<string, unknown>;
    for (const key of Object.keys(islandParams)) {
      expect(key in p).toBe(true);
      if (key === 'radius') continue;
      expect(flat[key]).toEqual((islandParams as unknown as Record<string, unknown>)[key]);
    }
  });

  it('an `undefined` in the override layer does not blank a live key', () => {
    // the old spread wrote `undefined` through — the shape this whole task is
    // about, one level down
    const p = liveIslandParams({ lodRockCull: undefined } as Partial<IslandParams>);
    expect(p.lodRockCull).toBe(islandParams.lodRockCull);
    islandParams.lodRockCull = 111;
    expect(p.lodRockCull).toBe(111);
  });
});

describe('§V2 the fix does not re-roll the world', () => {
  it('same seed and same overrides → byte-identical terrain', () => {
    const a = sierraIsland();
    const b = sierraIsland();
    try {
      expect(a.heightmap.data).toEqual(b.heightmap.data);
      expect(a.heightmap.archetype).toBe('dome');
      expect(a.heightmap.worldRadius).toBe(200);
    } finally {
      a.dispose();
      b.dispose();
    }
  });
});
