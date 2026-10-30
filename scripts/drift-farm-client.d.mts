// Types for drift-farm-client.mjs so tests (tsc over tests/) can import it.

export const MAX_EXTRA_MB: number;
export interface Remapped { argv: string[]; inputs: { i: number; local: string; name: string }[]; outs: { i: number; local: string; file: boolean }[] }
export function remapArgv(argv: string[], o: { root: string; cwd?: string; shipped: (rel: string) => boolean }): Remapped;
export function resolveArgv(argv: string[], o: { jobDir: string; outs: Remapped['outs']; inputs: { i: number; name: string }[]; node?: string }): string[];
export interface Progress { done: number | null; total: number | null; unit: string | null; fps: number | null; etaS: number | null }
export function progressOf(line: string, p?: Progress): Progress;
export function assetOverlay(now: { path: string; bytes: number; mtimeMs: number }[], manifest: { created?: string; files: { path: string; bytes: number; sha256: string }[] } | null): { path: string; bytes: number; mtimeMs: number; why: string; sha256?: string }[];
export function packState(o: { root: string; stage: string; inputs?: { i: number; local: string; name: string }[]; base?: string; say?: (m: string) => void; assetsNow?: { path: string; bytes: number; mtimeMs: number }[] | null; clean?: boolean }): Promise<{ payload: string; meta: { base: string; bundle: string | null; files: string[]; overlay: string[]; inputs: { i: number; name: string }[] } }>;
export function applyState(o: { main: string; jobDir: string; tar?: string; say?: (m: string) => void }): Promise<{ tree: string; meta: Record<string, unknown> }>;
export function removeTree(dir: string): void;
export function submit(o: Record<string, unknown>): Promise<{ code?: number; fallback?: string }>;
export function runJob(o: Record<string, unknown>): Promise<{ state: string; exitCode: number | null; fps?: number | null }>;
export function workLoop(o: Record<string, unknown>): Promise<void>;
export const HOLD_ON_MS: number;
export function holdOn<T>(what: string, fn: () => Promise<T>, o?: { untilMs?: number; say?: (m: string) => void; steps?: number[] }): Promise<T>;
export function submitterOf(env?: Record<string, string | undefined>, pid?: number, host?: string): { pid: number; host: string; agent: string };
export function labelOf(argv: string[], max?: number): string;
export const VITE_CACHES: string[];
export function roundTrip(job: Record<string, any>, at: { submitAt: number; followAt: number; landedAt: number }): string;
