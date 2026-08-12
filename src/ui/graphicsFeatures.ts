/**
 * Graphics feature catalog + params bridge (§I ui/settings/graphics: every
 * expensive system must be individually switchable from the MENU, not only
 * from Tweakpane — the user could not turn off the effect corrupting their
 * ship).
 *
 * The bridge reads and writes through the params REGISTRY (§V16) rather than
 * importing each system, so a new system appears here by registering a key and
 * this file never grows a dependency on the renderer.
 *
 * Two failure modes are made loud on purpose (six silent no-ops in §B and
 * counting):
 *  - a switch whose params key does not exist and has no sink is UNWIRED, and
 *    the settings screen renders it disabled rather than pretending it works;
 *  - a key read at CONSTRUCTION time (TSL bakes its graph once) is marked
 *    `reload`, and the screen says so on the row that changed.
 */
import { getParamsEntry } from '../params/registry';

export type GraphicsFeatureId =
  | 'reflections'
  | 'caustics'
  | 'deckWater'
  | 'spray'
  | 'rain'
  | 'shadows'
  | 'islandShadows'
  | 'postFx'
  | 'postAo'
  | 'postBloom'
  | 'postVibrance'
  | 'postVignette';

export interface GraphicsFeature {
  id: GraphicsFeatureId;
  label: string;
  /** one line: what it buys, in the player's words, not the renderer's */
  hint: string;
  /** params registry entry name + the key this switch owns */
  system: string;
  key: string;
  on: number | boolean;
  off: number | boolean;
  /** key is read once at construction — a change only lands after a reload */
  reload: boolean;
  /** rendered indented under, and disabled with, another switch */
  parent?: GraphicsFeatureId;
}

/** Order here is the order on screen. */
export const GRAPHICS_FEATURES: readonly GraphicsFeature[] = [
  {
    id: 'reflections',
    label: 'Water reflections',
    hint: 'Ship, islands and clouds mirrored in the sea. The single most expensive effect.',
    system: 'reflection',
    key: 'live',
    on: 1,
    off: 0,
    reload: false,
  },
  {
    id: 'caustics',
    label: 'Caustics',
    hint: 'Sunlight focused through the waves onto the hull, seabed and beach.',
    system: 'caustics',
    key: 'enabled',
    on: true,
    off: false,
    reload: true,
  },
  {
    id: 'deckWater',
    label: 'Deck water',
    hint: 'Water shipped over the bow pools and runs off the deck.',
    system: 'deckwater',
    key: 'enabled',
    on: true,
    off: false,
    reload: true,
  },
  {
    id: 'spray',
    label: 'Spray',
    hint: 'Mist off breaking crests and off the cutwater.',
    system: 'spray',
    key: 'enabled',
    on: true,
    off: false,
    reload: false,
  },
  {
    id: 'rain',
    label: 'Rain',
    hint: 'Wind-driven rain in squalls.',
    system: 'rain',
    key: 'enabled',
    on: true,
    off: false,
    reload: false,
  },
  {
    id: 'shadows',
    label: 'Sun shadows',
    hint: 'Rigging and sails cast shadows onto the deck and the water.',
    system: 'sky',
    key: 'shadowsEnabled',
    on: true,
    off: false,
    reload: false,
  },
  {
    id: 'islandShadows',
    label: 'Island shadows',
    hint: 'Terrain, rocks and palms cast shadows too.',
    system: 'island',
    key: 'castShadows',
    on: true,
    off: false,
    reload: false,
  },
  {
    id: 'postFx',
    label: 'Post-processing',
    hint: 'The full-screen grade: occlusion, bloom, colour, vignette.',
    system: 'post',
    key: 'enabled',
    on: true,
    off: false,
    reload: false,
  },
  {
    id: 'postAo',
    label: 'Ambient occlusion',
    hint: 'Contact shading in the corners of the ship.',
    system: 'post',
    key: 'aoEnabled',
    on: true,
    off: false,
    reload: true,
    parent: 'postFx',
  },
  {
    id: 'postBloom',
    label: 'Bloom',
    hint: 'Glow around the sun glints.',
    system: 'post',
    key: 'bloomEnabled',
    on: true,
    off: false,
    reload: true,
    parent: 'postFx',
  },
  {
    id: 'postVibrance',
    label: 'Vibrance',
    hint: 'Lifts the sea colour without oversaturating skin of sail.',
    system: 'post',
    key: 'vibranceEnabled',
    on: true,
    off: false,
    reload: true,
    parent: 'postFx',
  },
  {
    id: 'postVignette',
    label: 'Vignette',
    hint: 'Darkens the frame edge.',
    system: 'post',
    key: 'vignetteEnabled',
    on: true,
    off: false,
    reload: true,
    parent: 'postFx',
  },
];

export const GRAPHICS_FEATURE_IDS: readonly GraphicsFeatureId[] =
  GRAPHICS_FEATURES.map((f) => f.id);

export const SHADOW_MAP_SIZES: readonly number[] = [1024, 2048, 4096];

/** what applyGraphicsSettings needs — structurally, so no import cycle */
export interface GraphicsApply {
  features: Record<GraphicsFeatureId, boolean>;
  shadowMapSize: number;
  foliageDensity: number;
}

/**
 * Direct appliers for switches the params registry cannot express yet (a
 * system with no `enabled` key). main.ts registers one and the switch goes
 * live; nobody registers one and the switch renders disabled. Never silent.
 */
type FeatureSink = (on: boolean) => void;
const sinks = new Map<GraphicsFeatureId, FeatureSink>();

export function setFeatureSink(id: GraphicsFeatureId, fn: FeatureSink): () => void {
  sinks.set(id, fn);
  return () => {
    if (sinks.get(id) === fn) sinks.delete(id);
  };
}

function paramsKeyPresent(system: string, key: string): boolean {
  const entry = getParamsEntry(system);
  return !!entry && key in entry.params;
}

/** a switch is wired if a params key backs it, or main.ts registered a sink */
export function featureWired(id: GraphicsFeatureId): boolean {
  const f = GRAPHICS_FEATURES.find((x) => x.id === id);
  if (!f) return false;
  return paramsKeyPresent(f.system, f.key) || sinks.has(id);
}

export function unwiredFeatures(): GraphicsFeatureId[] {
  return GRAPHICS_FEATURE_IDS.filter((id) => !featureWired(id));
}

/**
 * Value each key holds after the FIRST apply — i.e. exactly what the engine
 * then constructs with, since main.ts applies settings before it builds
 * anything. Capturing before that first write would compare against the
 * authored param default instead, and a construction-gated switch restored
 * from localStorage would wrongly claim it needs a restart on every launch.
 */
const bootValues = new Map<string, unknown>();
let bootCaptured = false;

function keyId(system: string, key: string): string {
  return `${system}.${key}`;
}

/** does this feature's desired value differ from what the engine booted with */
export function featureNeedsReload(id: GraphicsFeatureId, on: boolean): boolean {
  const f = GRAPHICS_FEATURES.find((x) => x.id === id);
  if (!f || !f.reload) return false;
  const boot = bootValues.get(keyId(f.system, f.key));
  if (boot === undefined) return false;
  return boot !== (on ? f.on : f.off);
}

export function shadowMapSizeNeedsReload(size: number): boolean {
  const boot = bootValues.get(keyId('sky', 'shadowMapSize'));
  return boot !== undefined && boot !== size;
}

function captureBoot(): void {
  if (bootCaptured) return;
  bootCaptured = true;
  for (const f of GRAPHICS_FEATURES) {
    const entry = getParamsEntry(f.system);
    if (entry && f.key in entry.params) bootValues.set(keyId(f.system, f.key), entry.params[f.key]);
  }
  const sky = getParamsEntry('sky');
  if (sky && 'shadowMapSize' in sky.params) {
    bootValues.set(keyId('sky', 'shadowMapSize'), sky.params.shadowMapSize);
  }
}

/**
 * Authored palm LOD distances, captured once. Foliage density SCALES these, so
 * it has to multiply the authored value every time rather than the last one it
 * wrote — otherwise dragging the slider walks the distances to zero.
 */
let palmLodBase: { full: number; cull: number } | null = null;

function applyFoliageDensity(density: number): void {
  const entry = getParamsEntry('island');
  if (!entry || !('lodPalmFull' in entry.params) || !('lodPalmCull' in entry.params)) return;
  if (!palmLodBase) {
    palmLodBase = {
      full: Number(entry.params.lodPalmFull) || 0,
      cull: Number(entry.params.lodPalmCull) || 0,
    };
  }
  const d = Math.min(1, Math.max(0, density));
  // density 0 collapses the cull distance to 0, which palmLodCount reads as
  // "no palms survive at any distance" — an actual off switch, not a fade.
  entry.params.lodPalmFull = palmLodBase.full * d;
  entry.params.lodPalmCull = palmLodBase.cull * d;
}

/**
 * Push the whole graphics block into the params registry. Call ONCE before any
 * system is constructed (construction-gated keys must be right the first time)
 * and again on every settings change for the live ones.
 */
export function applyGraphicsSettings(g: GraphicsApply): void {
  for (const f of GRAPHICS_FEATURES) {
    const on = g.features[f.id] ?? true;
    const entry = getParamsEntry(f.system);
    if (entry && f.key in entry.params) entry.params[f.key] = on ? f.on : f.off;
    sinks.get(f.id)?.(on);
  }
  const sky = getParamsEntry('sky');
  if (sky && 'shadowMapSize' in sky.params) sky.params.shadowMapSize = g.shadowMapSize;
  applyFoliageDensity(g.foliageDensity);
  captureBoot(); // after the write: this is the state the engine builds from
}

/** test/HMR helper — drop captured boot values, sinks and LOD baselines */
export function resetGraphicsBridge(): void {
  bootValues.clear();
  bootCaptured = false;
  palmLodBase = null;
  sinks.clear();
}
