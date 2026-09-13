/**
 * Speedboat race UI (§T.185): race HUD + cockpit overlay, rolling start, crash overlay, results,
 * hull & paint select, pause. "Stencil and signal" (design doc §9).
 *
 * Page wiring (§T.181), per frame:
 *   updateRaceHudModel(model, raceState, hudCourse, playerId, telemetry, dt);
 *   hud.update(model, dt);
 *   if (model.camera === 'cockpit') dash.update(model, dt);   // canvases → dash CanvasTextures
 *   pause.poll(now); results.poll(now); select.poll(now);     // gamepad, only while open
 *
 * Isolation (§V109): imports only src/race/types and this directory (tests/speedboatUiIsolation).
 */
export { injectSpeedboatUiCss, SPEEDBOAT_UI_CSS } from './styles';
export { loadSpeedboatFonts } from './fonts';
export * from './model';
export { RaceHud } from './raceHud';
export { DashDisplays, GOVERNOR_DETENTS, RPM_NEEDLE_SWEEP } from './dash';
export { PauseScreen, ASSIST_PRESETS, type AssistSettings, type AudioSettings, type PauseCallbacks, type PauseState } from './pause';
export { ResultsScreen, type ResultsCallbacks, type ResultsMeta } from './results';
export { BoatSelectScreen, DEFAULT_SELECTION, type BoatSelectCallbacks, type BoatSelection } from './boatSelect';
export { COMMUNITY_PAINTS, GOGGLES, RIVALS, buildRoster, type CommunityPaint, type GogglesOption, type HudRacer } from './roster';
export { CHASE_PANELS, COCKPIT_PANELS, HUD_SCALES, placePanel, lowerCentreKeepOut, centralKeepOut } from './layout';
