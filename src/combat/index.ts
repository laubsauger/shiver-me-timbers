/**
 * Combat public surface (T16/T17/T18). Everything main.ts needs to wire the
 * chain: build the system from ship configs, feed it fire orders once per sim
 * tick, read the flood holes back out for §V14 flooding, and query the sink
 * sequence for HUD / control gating.
 */
export { createCombat } from './combatSystem';
export type {
  Combat,
  CombatFrame,
  CombatMemory,
  CombatShipConfig,
  FireOrder,
  MuzzleEvent,
} from './combatSystem';
export { buildBattery, batterySide, sideForBearing } from './battery';
export type { Battery, BroadsideSide, GunMount } from './battery';
export { controlAuthority, isSunk, sinkPhase, stepSinkSettle } from './sinking';
export type { SinkPhase } from './sinking';
export type { HitEvent, HitTarget } from './hitTest';
export { elevationForRange, shotRange } from './ballistics';
export type { ProjectileEvent, WaterHeightFn } from './ballistics';
export { createCombatFx } from './combatFx';
export type { CombatFx } from './combatFx';
export { createCombatRuntime, viewBearing } from './combatRuntime';
export type { CombatAudioSink, CombatRuntime, CombatRuntimeConfig } from './combatRuntime';
