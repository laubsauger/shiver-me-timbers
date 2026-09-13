/**
 * §T.183 / §T.189 THE ENGINE-MODEL SEAM (V77: thrust, the Governor assist and audio read ONE rpm).
 *
 * Every boat-audio module imports the engine model from HERE and nowhere else. Today this re-exports
 * the temporary audio adapter `./rpmModel`; when `src/sea-physics/engine.ts` (§T.189) lands, the
 * switch is the one line below:
 *
 *   export … from '../../sea-physics/engine';
 *
 * Contract the physics module must satisfy for that to compile unchanged:
 *   types     VoiceKind, GovernorMode, EngineSpec, EngineState, EngineInput
 *   values    VOICE_KINDS, ENGINE_SPECS (per VoiceKind), createEngineState(spec), stepEngine(st, spec, input, dt)
 *   EngineState fields read by the voices: rpm, thrEff, spool, load, bark, limiterCut, overrun, overrunTime,
 *             limiterActivity, refireCount; EngineSpec fields read: gear, idleRpm, calRpm, limitRpm.
 * Physical state (limiter/fuel cut, overrun, spool, ventilation flare) belongs in engine.ts. What stays in
 * audio is sound-only: the 20 ms rpm de-zipper on the override path, pop timing, cam-lope wobble.
 *
 * Once the SIM integrates rpm, the page passes it per boat as `BoatFrameTelemetry.rpm` (the override
 * path, already wired): the worklet then follows the sim's rpm instead of integrating its own.
 */
export {
  ENGINE_SPECS,
  VOICE_KINDS,
  createEngineState,
  stepEngine,
  type EngineInput,
  type EngineSpec,
  type EngineState,
  type GovernorMode,
  type VoiceKind,
} from './rpmModel';
