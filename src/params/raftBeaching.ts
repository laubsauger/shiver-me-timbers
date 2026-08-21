/**
 * Raft beaching tunables (§T.100, §V16). Consumed by src/sailing/raftBeaching.ts,
 * read LIVE on every tick through the `raftBeachingParams` object (§V62).
 *
 * The seabed contact itself is `sea-physics/grounding.ts` (the galleon's
 * spring/damper/friction model, §V.8); what lives here is the RAFT's side of
 * it — her mass, how deep the logs bite, the sand's grip, and the crew's
 * push-off — scaled the way `brigantineSeaParams` scales the galleon's.
 */
import { registerParams } from './registry';

export interface RaftBeachingParams {
  /** raft displacement, kg — nine balsa logs, cabin, crew and stores */
  mass: number;
  /** how far below the log UNDERSIDE the grounding points sit (loaded sinkage), m */
  draft: number;
  /** sand friction coefficient — planar deceleration per newton of bed support */
  grip: number;
  /** below this planar speed an aground raft is BEACHED and held, m/s */
  beachHoldSpeed: number;
  /** astern speed the crew's push-off gives her, m/s */
  pushOffSpeed: number;
  /** seconds the push-off keeps her free of the sand's grip so she can back clear */
  pushOffTime: number;
  /** along-log spacing of the contact points, m */
  contactSpacing: number;
}

export const raftBeachingParams: RaftBeachingParams = registerParams<RaftBeachingParams>(
  'raft-beaching',
  {
    mass: 15000,
    draft: 0.1,
    grip: 0.6,
    beachHoldSpeed: 0.05,
    pushOffSpeed: 0.8,
    pushOffTime: 3,
    contactSpacing: 1.5,
  },
  {
    mass: { min: 2000, max: 60000, step: 500 },
    draft: { min: 0, max: 1, step: 0.01 },
    grip: { min: 0, max: 3, step: 0.05 },
    beachHoldSpeed: { min: 0.01, max: 0.5, step: 0.01 },
    pushOffSpeed: { min: 0.1, max: 3, step: 0.05 },
    pushOffTime: { min: 0.5, max: 10, step: 0.1 },
    contactSpacing: { min: 0.5, max: 5, step: 0.1 },
  },
);
