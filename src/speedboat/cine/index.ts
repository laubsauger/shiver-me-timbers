/**
 * The speedboat trailer's cine: a host for src/cine, the shot list, the scripted driver and the edit plan
 * (docs/cine/speedboat-trailer-v1.md).
 */
export { cineSettings, createCineBoot, createSpeedboatCine, type SpeedboatCine, type TrailerRecordOpts } from './host';
export { createCineChrome, CINE_CHROME_CLASS, CINE_CHROME_CSS, CINE_KEEP_ATTR } from './cineChrome';
export { createCineDrive, type CineDrive, type DriveSpec } from './drive';
export { TRAILER_SHOTS, TRAILER_BEATS, TRAILER_MARKERS, TRAILER_SLOTS, type TrailerShot } from './shotlist';
export { LOCATIONS, type LocationId } from './locations';
export { trailerClipName, trailerEditPlan } from './editPlan';
