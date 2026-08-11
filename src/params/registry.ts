/**
 * Central params registry (§V.16): every tunable lives in a params module
 * and registers here so the debug panel can auto-bind it. Plain TS, zero
 * UI imports — sim code depends on this, never on Tweakpane.
 */

export interface ParamMeta {
  min?: number;
  max?: number;
  step?: number;
}

/** per-key UI hints for a params object */
export type MetaMap = Record<string, ParamMeta>;

export interface ParamsEntry {
  name: string;
  params: Record<string, unknown>;
  meta: MetaMap;
}

export type RegistryListener = (entry: ParamsEntry) => void;

const entries = new Map<string, ParamsEntry>();
const listeners = new Set<RegistryListener>();

/**
 * Register a system's params object. Returns the SAME object — the panel
 * mutates it in place, so the system reads live values with no glue code.
 * Re-registering a name replaces the entry (hot-reload) and re-notifies.
 */
export function registerParams<T extends object>(
  name: string,
  params: T,
  meta: Partial<Record<Extract<keyof T, string>, ParamMeta>> = {},
): T {
  const entry: ParamsEntry = {
    name,
    params: params as Record<string, unknown>,
    meta: meta as MetaMap,
  };
  entries.set(name, entry);
  for (const listener of listeners) listener(entry);
  return params;
}

export function getParamsEntry(name: string): ParamsEntry | undefined {
  return entries.get(name);
}

export function listParamsEntries(): ParamsEntry[] {
  return [...entries.values()];
}

/**
 * Subscribe to registrations. Existing entries replay synchronously so a
 * late-created panel still sees everything; entries registered later (late
 * registration) arrive through the same callback. Returns unsubscribe.
 */
export function subscribeParams(listener: RegistryListener): () => void {
  listeners.add(listener);
  for (const entry of entries.values()) listener(entry);
  return () => {
    listeners.delete(listener);
  };
}

/** test/HMR helper — drop all entries and listeners */
export function clearParamsRegistry(): void {
  entries.clear();
  listeners.clear();
}
