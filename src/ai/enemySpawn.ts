/**
 * WHERE THE ENEMY IS WHEN THE GAME STARTS (§V.15).
 *
 * User: "we should change the spawn position of the other ship, so it's not
 * always hidden behind the other island, and we have to go against the wind to
 * get to it."
 *
 * She used to be the literal constant `[190, -150]` in main.ts, chosen when the
 * player still booted at the origin. She is not there any more: §T.52 made the
 * showcase lagoon the default boot destination, so the player wakes up at the
 * berth the anchorage solver picked — MEASURED over 20 world seeds, that is
 * (1130, 232) on the shipped seed 1337 and always ~(980..1150, 40..390):
 *
 *   - RANGE to (190, -150): 953-1014 m on every seed. The AI engages at 220 m
 *     (`aiParams.engageRange`) and the guns reach 133.6 m (measured, 36c5a8d),
 *     so she was 4.5x outside the range at which anything at all happens.
 *   - COURSE to her: 11.2-27.5° off the eye of the wind on ALL 20 seeds, i.e.
 *     INSIDE the ±30° no-go zone on every one of them. Sailed straight at her
 *     from rest the hull makes NO ground at all: simulated through the real
 *     `stepShipSailing` for 600 s at 20/30/40° off the wind, along-course
 *     displacement never reaches even 200 m, because `noGoGate` is 0 (or half)
 *     and the §B.49 aback term drives her astern. That is "we have to go
 *     against the wind to get to it", and it is not a slow beat, it is a wall.
 *   - LINE OF SIGHT: land on the line on 3 of 20 seeds. The smallest defect of
 *     the three, and the one the user named — because at 1 km, over the rim of
 *     the island you are anchored inside, "blocked" and "a speck in the haze"
 *     look the same.
 *
 * SO THIS IS A DERIVED POSITION, NOT A SECOND CONSTANT (§V.80). A replacement
 * literal would be right for one seed and one wind and wrong for the next of
 * either. What is pinned here are the PROPERTIES the user asked for, resolved
 * against the world that was actually built:
 *
 *   1. she is in DEEP ENOUGH WATER for her draft, across her own footprint —
 *      never on a beach, never in the 4.5 m lagoon basin;
 *   2. NOTHING BUT WATER on the line between the two ships;
 *   3. the course to her is OUTSIDE the no-go zone with the full margin;
 *   4. the RANGE puts her inside the AI's engage envelope and outside gun
 *      range, so the fight starts on its own and nobody is shot at t = 0.
 *
 * PRIORITY WHEN THEY CONFLICT — measured, they do not: over 20 seeds, 1446 to
 * 1628 of 2700 sampled (bearing, range) pairs satisfy all three gates at once,
 * so the search below finds its first-choice bearing immediately. The ladder
 * exists anyway because a params change could tighten it, and its order is
 * stated rather than emergent: DEPTH is never relaxed (a ship spawned aground
 * is a broken game, not a compromised one); the WIND MARGIN gives way first,
 * because a bad point of sail is a slow approach while a hidden enemy is no
 * approach at all; LINE OF SIGHT is the last property to go. If even the depth
 * gate cannot be met the placement THROWS (§Rule 8) — the same choice
 * `generateIslandSites` and `findLagoonAnchorage` already make at boot, for the
 * same reason.
 *
 * §V.2: a pure function of (player position, wind, seabed). No `Math.random`,
 * no clock, no hidden state — same world in, same berth out.
 */
import { aiParams, type AiParams } from '../params/ai';
import { sailingParams, type SailingParams } from '../params/sailing';

export interface EnemySpawnContext {
  /** where the PLAYER actually boots, world XZ (not necessarily the origin) */
  player: readonly [number, number];
  /** her boot heading (rad, sim yaw). Tie-break only — see `pick` below. */
  heading: number;
  /** TRUE wind toward-bearing (rad) — `state.wind.direction` */
  windDirection: number;
  /**
   * Seabed height in m, waterline 0, negative below — i.e.
   * `archipelago.seabed.heightAt`. Taken as a callback so this module imports
   * nothing from src/island: the placement is a rule about water, and the
   * thing that knows where the water is passes itself in.
   */
  seabedAt(x: number, z: number): number;
}

export interface EnemySpawnRules {
  /** rad off the eye of the wind the course to her must clear */
  minTheta: number;
  /** m — nearest she may be placed */
  minRange: number;
  /** m — furthest she may be placed */
  maxRange: number;
  /** m — the range the search aims for; the others are fallbacks */
  preferredRange: number;
  /** m of water she must have under her, at still water */
  minDepth: number;
  /** m — radius of the disc around her that must ALSO carry `minDepth` */
  clearRadius: number;
}

/**
 * How much clear of `fireRange` she spawns (m). She is meant to be sailed at,
 * not to open the action with a broadside into an anchored ship — and the
 * measured maximum attainable gun range is 133.6 m against a `fireRange` of
 * 130, so the standoff also has to cover that 3.6 m of slack.
 */
const FIRE_STANDOFF = 20;

/**
 * Water under her, and the disc it must hold across.
 *
 * The SAME figures as the anchorage solver's (island/showcase.ts): the galleon
 * draws 2 m, the measured swell trough is -3.96 m, and grounding compares the
 * keel against the seabed — so 6 m is where she starts touching in a trough and
 * 7 m is that plus a margin. 22 m is her half-length: §V.54's lesson, a lumped
 * body has to sample at its own extent or her bow spawns on a bank the centre
 * sample never saw. Restated rather than imported because these belong to the
 * HULL, and showcase.ts owns a berth for one island.
 */
const MIN_DEPTH = 7;
const CLEAR_RADIUS = 22;

/** the placement rules, resolved from the live params that own each figure */
export function enemySpawnRules(
  sailing: SailingParams = sailingParams,
  ai: AiParams = aiParams,
): EnemySpawnRules {
  // THE FULL RAMP, NOT JUST `deadZone`. `trimEfficiency` is zero below
  // `deadZone` (30°) and only reaches full drive at `deadZone + deadZoneRamp`
  // (50.1°) — and the measurement above is unambiguous about which of the two
  // is the real boundary: at 40°, halfway up the ramp, she still makes no
  // ground in ten minutes. Clearing the whole ramp is what "comfortably
  // outside the no-go zone" has to mean.
  const minTheta = sailing.deadZone + sailing.deadZoneRamp;
  const minRange = ai.fireRange + FIRE_STANDOFF;
  const maxRange = ai.engageRange;
  return {
    minTheta,
    minRange,
    maxRange,
    // the middle of the band: ~16 s of sailing from rest on a beam reach
    // (measured 17 s to 200 m through `stepShipSailing` at the shipped wind)
    preferredRange: (minRange + maxRange) * 0.5,
    minDepth: MIN_DEPTH,
    clearRadius: CLEAR_RADIUS,
  };
}

/** bearings and ranges the search walks — resolution, not look tunables */
const BEARING_STEP = (5 * Math.PI) / 180;
const RANGE_STEP = 10;
/** spacing of the seabed samples along the line of sight (m) */
const SIGHT_STEP = 8;
/** points on the clearance ring — a ring catches banks a single point misses */
const CLEARANCE_SAMPLES = 8;

/** angle between a course and the eye of the wind — `stepShipSailing`'s theta */
function thetaOffWind(course: number, windDirection: number): number {
  const dot =
    Math.sin(course) * Math.sin(windDirection) + Math.cos(course) * Math.cos(windDirection);
  return Math.acos(Math.max(-1, Math.min(1, -dot)));
}

/** magnitude of the shortest angle between two bearings */
function angleBetween(a: number, b: number): number {
  return Math.abs(Math.atan2(Math.sin(a - b), Math.cos(a - b)));
}

function deepEnough(ctx: EnemySpawnContext, x: number, z: number, r: EnemySpawnRules): boolean {
  if (-ctx.seabedAt(x, z) < r.minDepth) return false;
  for (let i = 0; i < CLEARANCE_SAMPLES; i++) {
    const a = (i / CLEARANCE_SAMPLES) * Math.PI * 2;
    const px = x + Math.cos(a) * r.clearRadius;
    const pz = z + Math.sin(a) * r.clearRadius;
    if (-ctx.seabedAt(px, pz) < r.minDepth) return false;
  }
  return true;
}

/**
 * Is there anything but water between them?
 *
 * The test is on the WATERLINE, not on an eye-height sight line: "no land on
 * the segment" is one rule with no assumed camera height in it, and a camera
 * height would be a second thing to keep in sync with a lens this module
 * cannot see. It is the stricter of the two — a 0.5 m rock does not really
 * hide a galleon — and strictness costs nothing here, because the majority of
 * candidates pass anyway.
 */
function inSight(ctx: EnemySpawnContext, x: number, z: number): boolean {
  const dx = x - ctx.player[0];
  const dz = z - ctx.player[1];
  const steps = Math.max(2, Math.ceil(Math.hypot(dx, dz) / SIGHT_STEP));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    if (ctx.seabedAt(ctx.player[0] + dx * t, ctx.player[1] + dz * t) >= 0) return false;
  }
  return true;
}

interface Candidate {
  x: number;
  z: number;
  course: number;
  range: number;
  theta: number;
}

/**
 * Every berth worth considering, best first.
 *
 * ORDER IS THE WHOLE ALGORITHM, so it is a total order and every term in it is
 * stated: (1) how far the course is off a BEAM REACH, where `trimEfficiency`
 * peaks — that is the fastest and most pleasant point of sail to be handed;
 * (2) how far the range is off `preferredRange`; (3) how far the course is off
 * the heading she boots on, which decides between the two beam reaches (there
 * is always a pair, one either side of the wind) by putting her on the side the
 * player is already looking. Without (3) the pair would tie and the winner
 * would be whichever the loop happened to reach first.
 */
function candidates(ctx: EnemySpawnContext, r: EnemySpawnRules): Candidate[] {
  const out: Candidate[] = [];
  const steps = Math.round((Math.PI * 2) / BEARING_STEP);
  for (let i = 0; i < steps; i++) {
    const course = i * BEARING_STEP;
    const theta = thetaOffWind(course, ctx.windDirection);
    for (let range = r.minRange; range <= r.maxRange + 1e-9; range += RANGE_STEP) {
      out.push({
        x: ctx.player[0] + Math.sin(course) * range,
        z: ctx.player[1] + Math.cos(course) * range,
        course,
        range,
        theta,
      });
    }
  }
  const key = (c: Candidate): [number, number, number] => [
    Math.abs(c.theta - Math.PI / 2),
    Math.abs(c.range - r.preferredRange),
    angleBetween(c.course, ctx.heading),
  ];
  out.sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || a.course - b.course;
  });
  return out;
}

/**
 * The enemy's berth, world XZ. Throws if the world cannot float her anywhere in
 * the band (§Rule 8) — a silently beached enemy is worse than a loud boot.
 */
export function enemySpawn(
  ctx: EnemySpawnContext,
  rules: EnemySpawnRules = enemySpawnRules(),
): [number, number] {
  const list = candidates(ctx, rules);
  // the relaxation ladder, tightest first. Depth is in every rung: she must
  // float wherever she ends up.
  const gates: Array<(c: Candidate) => boolean> = [
    (c) => c.theta >= rules.minTheta && inSight(ctx, c.x, c.z),
    (c) => inSight(ctx, c.x, c.z),
    () => true,
  ];
  for (const gate of gates) {
    for (const c of list) {
      if (!gate(c)) continue;
      if (!deepEnough(ctx, c.x, c.z, rules)) continue;
      return [c.x, c.z];
    }
  }
  throw new Error(
    `enemySpawn: no water ${rules.minDepth} m deep across a ${rules.clearRadius} m disc ` +
      `anywhere ${rules.minRange}-${rules.maxRange} m from (${ctx.player[0].toFixed(0)}, ` +
      `${ctx.player[1].toFixed(0)}) — the player is boxed in and the enemy cannot be placed`,
  );
}
