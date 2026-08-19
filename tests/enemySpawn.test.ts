/**
 * ENEMY SPAWN PLACEMENT (§V.15, §V.80).
 *
 * User: "we should change the spawn position of the other ship, so it's not
 * always hidden behind the other island, and we have to go against the wind to
 * get to it."
 *
 * These tests assert the PROPERTIES that complaint names, over MANY WORLD
 * SEEDS — never a coordinate. A pinned `[210, 40]` would pass on the shipped
 * seed and enforce the same defect on the next one, which is §V.80's exact
 * failure shape and is what the hardcoded `[190, -150]` was.
 *
 * The properties, and why each is the thing that matters:
 *  - IN SIGHT: no land on the line between the two ships. The user cannot fight
 *    what the island is standing in front of.
 *  - OFF THE WIND: the course to her clears `deadZone + deadZoneRamp`. The
 *    whole ramp, not just `deadZone`: `stepShipSailing` run for 600 s at 40°
 *    off the wind — halfway up the ramp — makes NO ground along the course at
 *    all, because the gate is half open and the §B.49 aback term pushes her
 *    astern. The old spawn sat at 11-28° off the wind on every seed measured.
 *  - IN THE ENVELOPE: inside `aiParams.engageRange` so the AI engages at tick
 *    0, and clear of `fireRange` (and of the 133.6 m maximum a ball can
 *    actually reach) so nobody opens fire on an anchored ship.
 *  - AFLOAT: her draft plus the measured swell trough, held across her own
 *    half-length — not on a beach and not in the 4.5 m showcase basin.
 *
 * The worlds are rebuilt the way `createArchipelago` builds them (same sites,
 * same archetype-avoidance order, same seabed sampler) rather than through it,
 * because the full build makes meshes, rocks, palms and structures this file
 * has no use for. The first test proves the reconstruction IS the real world.
 */
import { describe, expect, it, vi } from 'vitest';
import {
  createArchipelago,
  generateIslandSites,
  siteParams,
} from '../src/island/archipelago';
import { generateIslandHeightmap } from '../src/island/heightmap';
import { sampleSeabedHeight } from '../src/island/seabed';
import { findLagoonAnchorage } from '../src/island/showcase';
import { islandParams } from '../src/params/island';
import { aiParams } from '../src/params/ai';
import { sailingParams } from '../src/params/sailing';
import { DEFAULT_SETTINGS } from '../src/ui/settingsStore';
import {
  enemySpawn,
  enemySpawnRules,
  type EnemySpawnContext,
} from '../src/ai/enemySpawn';
import type { ArchetypeName } from '../src/island/archetypes';

/** the world seed main.ts ships, plus a spread that is not near it */
const SEEDS = [
  1337, 1, 2, 3, 7, 11, 12, 42, 55, 99, 123, 404, 606, 777, 1000, 2024, 5150,
  9001, 31337, 65535, 8675309, 314159, 27182, 161803,
];

/** the wind the game boots with, and the one every measurement here is against */
const BOOT_WIND = DEFAULT_SETTINGS.world.windDirection;

interface TestWorld {
  seabedAt(x: number, z: number): number;
  /** where the player actually boots: the lagoon berth, world XZ */
  player: [number, number];
  heading: number;
}

function buildWorld(seed: number): TestWorld {
  const sites = generateIslandSites(seed, islandParams);
  const used: ArchetypeName[] = [];
  const islands = sites.map((site) => {
    const heightmap = generateIslandHeightmap(site.seed, siteParams(site), used);
    used.push(heightmap.archetype);
    return { heightmap, center: site.position };
  });
  const berth = findLagoonAnchorage(islands[0].heightmap);
  return {
    seabedAt: (x, z) => sampleSeabedHeight(islands, x, z, islandParams),
    player: [islands[0].center[0] + berth.x, islands[0].center[1] + berth.z],
    heading: berth.heading,
  };
}

function context(world: TestWorld, wind = BOOT_WIND): EnemySpawnContext {
  return {
    player: world.player,
    heading: world.heading,
    windDirection: wind,
    seabedAt: world.seabedAt,
  };
}

/** angle between a course and the eye of the wind — `stepShipSailing`'s theta */
function thetaOffWind(course: number, windDirection: number): number {
  const dot =
    Math.sin(course) * Math.sin(windDirection) + Math.cos(course) * Math.cos(windDirection);
  return Math.acos(Math.max(-1, Math.min(1, -dot)));
}

/** deepest land found on the line between them; < 0 means clear water */
function highestOnSightLine(
  world: TestWorld,
  to: readonly [number, number],
  step = 4,
): number {
  const dx = to[0] - world.player[0];
  const dz = to[1] - world.player[1];
  const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / step));
  let peak = -Infinity;
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const h = world.seabedAt(world.player[0] + dx * t, world.player[1] + dz * t);
    if (h > peak) peak = h;
  }
  return peak;
}

/** shallowest water on the disc she occupies (m of column, still water) */
function shallowestUnderHull(
  world: TestWorld,
  at: readonly [number, number],
  radius: number,
): number {
  let least = -world.seabedAt(at[0], at[1]);
  // 24 points, not the module's 8 — a test that samples the same ring the code
  // does cannot catch a bank that falls between the code's own samples
  for (let i = 0; i < 24; i++) {
    const a = (i / 24) * Math.PI * 2;
    const d = -world.seabedAt(at[0] + Math.cos(a) * radius, at[1] + Math.sin(a) * radius);
    if (d < least) least = d;
  }
  return least;
}

describe('enemy spawn — the world under test is the world the game builds', () => {
  it('the rebuilt seabed and berth match createArchipelago exactly', () => {
    const seed = 1337;
    const arch = createArchipelago({ seed });
    try {
      const world = buildWorld(seed);
      const berth = arch.anchorages.find((a) => a.name === 'lagoon');
      expect(berth).toBeDefined();
      expect(world.player[0]).toBeCloseTo(berth!.x, 6);
      expect(world.player[1]).toBeCloseTo(berth!.z, 6);
      expect(world.heading).toBeCloseTo(berth!.heading, 6);
      // sample the seabed on a coarse lattice over the play area rather than at
      // a couple of hand-picked points — the placement reads it everywhere
      for (let x = -400; x <= 1600; x += 137) {
        for (let z = -800; z <= 1200; z += 149) {
          expect(world.seabedAt(x, z)).toBeCloseTo(arch.seabed.heightAt(x, z), 6);
        }
      }
    } finally {
      arch.dispose();
    }
  });
});

describe('enemy spawn — properties that must hold on every seed', () => {
  const rules = enemySpawnRules();

  it.each(SEEDS)('seed %i: in sight, off the wind, in the envelope, afloat', (seed) => {
    const world = buildWorld(seed);
    const at = enemySpawn(context(world));

    // AFLOAT — her draft plus the swell trough, across her own half-length
    expect(shallowestUnderHull(world, at, rules.clearRadius)).toBeGreaterThanOrEqual(
      rules.minDepth,
    );

    // IN SIGHT — nothing above the waterline between the two ships
    expect(highestOnSightLine(world, at)).toBeLessThan(0);

    // OFF THE WIND — the course to her clears the whole no-go ramp
    const course = Math.atan2(at[0] - world.player[0], at[1] - world.player[1]);
    expect(thetaOffWind(course, BOOT_WIND)).toBeGreaterThanOrEqual(rules.minTheta);

    // IN THE ENVELOPE — the AI engages at tick 0, nobody is in gun range
    const range = Math.hypot(at[0] - world.player[0], at[1] - world.player[1]);
    expect(range).toBeGreaterThanOrEqual(rules.minRange);
    expect(range).toBeLessThanOrEqual(rules.maxRange);
  });

  it('the no-go margin is the FULL ramp, not just deadZone', () => {
    // The distinction this whole change turns on: 30° is where thrust stops
    // being zero, 50.1° is where the sails actually draw. A spawn at 40° looks
    // legal against `deadZone` and is unreachable in practice.
    expect(rules.minTheta).toBeCloseTo(sailingParams.deadZone + sailingParams.deadZoneRamp, 12);
    expect(rules.minTheta).toBeGreaterThan(sailingParams.deadZone);
  });

  it('the range band sits between the gun and the AI envelope', () => {
    // 133.6 m is the measured maximum a 60 m/s ball reaches (36c5a8d); the band
    // must start clear of it AND of fireRange, and end no further out than the
    // range at which the AI leaves patrol.
    expect(rules.minRange).toBeGreaterThan(133.6);
    expect(rules.minRange).toBeGreaterThan(aiParams.fireRange);
    expect(rules.maxRange).toBeLessThanOrEqual(aiParams.engageRange);
    expect(rules.preferredRange).toBeGreaterThan(rules.minRange);
    expect(rules.preferredRange).toBeLessThan(rules.maxRange);
  });
});

describe('enemy spawn — §V.2 determinism', () => {
  it('same world in, same berth out, and no Math.random anywhere', () => {
    const world = buildWorld(1337);
    const random = vi.spyOn(Math, 'random');
    try {
      const a = enemySpawn(context(world));
      const b = enemySpawn(context(world));
      expect(b).toEqual(a);
      expect(random).not.toHaveBeenCalled();
    } finally {
      random.mockRestore();
    }
  });
});

describe('enemy spawn — §V.62: every input drives the output', () => {
  const world = buildWorld(1337);
  const base = enemySpawn(context(world));

  it('the WIND moves her: the berth follows the eye of the wind round', () => {
    // not merely "different numbers" — the COURSE to her must rotate with the
    // wind, which is the only reason the wind is an input at all
    const courseAt = (wind: number): number => {
      const at = enemySpawn(context(world, wind));
      return Math.atan2(at[0] - world.player[0], at[1] - world.player[1]);
    };
    const c0 = courseAt(BOOT_WIND);
    const c1 = courseAt(BOOT_WIND + Math.PI / 2);
    const turned = Math.abs(Math.atan2(Math.sin(c1 - c0), Math.cos(c1 - c0)));
    expect(turned).toBeGreaterThan(Math.PI / 4);
    // and she is still legally off the new wind
    expect(thetaOffWind(c1, BOOT_WIND + Math.PI / 2)).toBeGreaterThanOrEqual(
      enemySpawnRules().minTheta,
    );
  });

  it('the PLAYER POSITION moves her: the berth is relative, not absolute', () => {
    const moved = enemySpawn({ ...context(world), player: [world.player[0] - 900, world.player[1] - 900] });
    expect(Math.hypot(moved[0] - base[0], moved[1] - base[1])).toBeGreaterThan(500);
  });

  it('minTheta drives the achieved angle off the wind', () => {
    const rules = enemySpawnRules();
    const tight = enemySpawn(context(world), { ...rules, minTheta: (170 * Math.PI) / 180 });
    const course = Math.atan2(tight[0] - world.player[0], tight[1] - world.player[1]);
    expect(thetaOffWind(course, BOOT_WIND)).toBeGreaterThanOrEqual((170 * Math.PI) / 180);
  });

  it('the range band drives the achieved range', () => {
    const rules = enemySpawnRules();
    const near = enemySpawn(context(world), {
      ...rules,
      minRange: 150,
      maxRange: 160,
      preferredRange: 155,
    });
    // 1e-6 of slack on both ends: the berth is built from sin/cos of the
    // course, so the range comes back a float ulp either side of the bound
    const range = Math.hypot(near[0] - world.player[0], near[1] - world.player[1]);
    expect(range).toBeGreaterThan(150 - 1e-6);
    expect(range).toBeLessThan(160 + 1e-6);

    const far = enemySpawn(context(world), {
      ...rules,
      minRange: 300,
      maxRange: 320,
      preferredRange: 310,
    });
    expect(Math.hypot(far[0] - world.player[0], far[1] - world.player[1])).toBeGreaterThanOrEqual(300);
  });

  it('minDepth drives the water she is placed in', () => {
    const rules = enemySpawnRules();
    // 30 m, against the 35.4 m deepest hull disc the band offers at this seed:
    // far past the 7 m the shipped rules ask for, so a berth that satisfied it
    // by luck could not satisfy this one
    const deep = enemySpawn(context(world), { ...rules, minDepth: 30 });
    expect(shallowestUnderHull(world, deep, rules.clearRadius)).toBeGreaterThanOrEqual(30);
    expect(shallowestUnderHull(world, base, rules.clearRadius)).toBeLessThan(30);
    expect(deep).not.toEqual(base);
  });
});

describe('enemy spawn — §Rule 8: it fails loudly rather than beaching her', () => {
  it('throws when there is nowhere in the band she could float', () => {
    expect(() =>
      enemySpawn({
        player: [0, 0],
        heading: 0,
        windDirection: 0,
        // dry land in every direction
        seabedAt: () => 10,
      }),
    ).toThrow(/enemySpawn/);
  });
});
