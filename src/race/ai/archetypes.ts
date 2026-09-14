/**
 * THE SEVEN COURIERS (design doc §4) as parameter sets (§T.186). Numbers are *tuning* starting points; the
 * behaviour they must produce is pinned by tests/raceAi*.test.ts (veteran crashes less than the rookie, the pack
 * stays close without any power multiplier, nobody hooks).
 *
 * RISK is the one dial most parameters hang off (pilot.ts `riskShape`): line margin and profile aggression come
 * from the line LEVEL picked by risk, wave-lift threshold and mistake rate scale with it. An archetype sets its
 * BASE risk and how the race moves it: sector bias (swell/lee specialists), catch-up gain (trailing ⇒ riskier,
 * never faster engines), recovery mood after a crash.
 */

export type ArchetypeId = 'rival' | 'veteran' | 'hothead' | 'blocker' | 'swell' | 'lee' | 'rookie';

export interface Archetype {
  id: ArchetypeId;
  number: number;
  boat: string;
  pilot: string;
  community: string;
  /** base risk 0..1 */
  risk: number;
  /** risk added in exposed / sheltered sectors */
  exposedBias: number;
  shelteredBias: number;
  /** risk added per unit of trailing (0 at the leader's shoulder, 1 at ≥ 7 s behind) */
  catchUp: number;
  /** predicted airtime (s) the pilot accepts before lifting, at risk 0 */
  airTolerance: number;
  /** 0..1: likes to hold throttle over a ramp the sea offers (exposed water) */
  jumpAppetite: number;
  /** 0..1: how much of the needed lift the pilot actually applies (wave reading) */
  waveSkill: number;
  /** 0..1: covers the inside line when someone is close behind */
  aggression: number;
  /** spontaneous errors per minute at risk 0 (seeded, deterministic) */
  mistakesPerMin: number;
  /** seconds of changed risk after a respawn, and the change */
  recoveryS: number;
  recoveryRisk: number;
  /** pure-pursuit lookahead, seconds of travel */
  lookaheadS: number;
}

export const ARCHETYPES: Readonly<Record<ArchetypeId, Readonly<Archetype>>> = Object.freeze({
  rival: { id: 'rival', number: 9, boat: 'Crosswind', pilot: 'J. Reyes', community: 'Dome Ten', risk: 0.55, exposedBias: 0, shelteredBias: 0, catchUp: 0.6, airTolerance: 0.55, jumpAppetite: 0.5, waveSkill: 0.8, aggression: 0.5, mistakesPerMin: 0.4, recoveryS: 6, recoveryRisk: 0.15, lookaheadS: 1.8 },
  veteran: { id: 'veteran', number: 3, boat: 'Longhaul', pilot: 'R. Castellane', community: 'Bench Hollow', risk: 0.4, exposedBias: -0.1, shelteredBias: 0.05, catchUp: 0.35, airTolerance: 0.4, jumpAppetite: 0.1, waveSkill: 1, aggression: 0.2, mistakesPerMin: 0.1, recoveryS: 8, recoveryRisk: -0.2, lookaheadS: 2.0 },
  hothead: { id: 'hothead', number: 11, boat: 'Shine', pilot: 'D. Kowalczyk', community: 'The Stills', risk: 0.8, exposedBias: 0.1, shelteredBias: 0, catchUp: 0.7, airTolerance: 1.0, jumpAppetite: 0.9, waveSkill: 0.35, aggression: 0.7, mistakesPerMin: 1.2, recoveryS: 5, recoveryRisk: 0.2, lookaheadS: 1.8 },
  blocker: { id: 'blocker', number: 22, boat: 'Breakwater', pilot: 'M. Okafor', community: 'Levee Town', risk: 0.45, exposedBias: 0, shelteredBias: 0, catchUp: 0.4, airTolerance: 0.5, jumpAppetite: 0.3, waveSkill: 0.75, aggression: 1, mistakesPerMin: 0.4, recoveryS: 6, recoveryRisk: 0, lookaheadS: 1.8 },
  swell: { id: 'swell', number: 44, boat: 'White Horses', pilot: 'A. Lindqvist', community: 'Outer Bar', risk: 0.5, exposedBias: 0.25, shelteredBias: -0.15, catchUp: 0.5, airTolerance: 0.8, jumpAppetite: 0.8, waveSkill: 0.95, aggression: 0.4, mistakesPerMin: 0.4, recoveryS: 6, recoveryRisk: 0, lookaheadS: 1.8 },
  lee: { id: 'lee', number: 56, boat: 'Flat Jack', pilot: 'S. Moreau', community: 'Pine Cut', risk: 0.5, exposedBias: -0.2, shelteredBias: 0.3, catchUp: 0.5, airTolerance: 0.45, jumpAppetite: 0.2, waveSkill: 0.6, aggression: 0.4, mistakesPerMin: 0.4, recoveryS: 6, recoveryRisk: 0, lookaheadS: 1.8 },
  rookie: { id: 'rookie', number: 27, boat: 'Spark', pilot: 'T. Varga', community: 'Solar Ridge', risk: 0.35, exposedBias: 0, shelteredBias: 0, catchUp: 0.5, airTolerance: 0.8, jumpAppetite: 0.4, waveSkill: 0.2, aggression: 0.1, mistakesPerMin: 1.5, recoveryS: 10, recoveryRisk: -0.15, lookaheadS: 1.5 },
});

export const ARCHETYPE_ORDER: readonly ArchetypeId[] = ['rival', 'veteran', 'hothead', 'blocker', 'swell', 'lee', 'rookie'];
