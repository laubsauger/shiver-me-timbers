// Types for drift-node-lib.mjs so tests (tsc over tests/) can import it.

export interface NodeConfig {
  file: string;
  exists: boolean;
  bundle: string | null;
  dashboard: string | false | undefined;
  name: string;
  renders: string;
  farm: { hub?: string; token?: string } | null;
}
export type BundleSource = { kind: 'ssh'; target: string; host: string; path: string; label: string } | { kind: 'folder'; path: string; label: string } | { kind: 'farm'; hub: string; token: string | null; label: string };
export function farmSource(farm: { hub?: string; token?: string } | null | undefined, hub?: string | null): BundleSource | null;
export interface BundlePointer {
  file: string;
  bytes: number;
  sha256?: string;
  content?: string;
  created?: string;
  commit?: string;
  filesBytes?: number;
  mtimeMs?: number;
  fallback?: boolean;
}
export interface BundleRecord {
  file: string;
  bytes: number;
  sha256: string | null;
  mtimeMs: number | null;
  content: string;
  created: string | null;
  commit: string | null;
  source: string;
  at: string;
  local?: string;
}
export interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}
export interface QueueSpec {
  defaults?: Record<string, unknown>;
  jobs: Array<Record<string, unknown>>;
}

export const CONFIG_FILE: string;
export function pointerName(target?: string): string;
export function parseJsonc(text: string): unknown;
export function readConfig(root: string, env?: Record<string, string | undefined>): NodeConfig;
export function configHelp(root: string): string;
export function parseBundleSource(src: string | null | undefined): BundleSource | null;
export function dashboardUrl(cfg: Pick<NodeConfig, 'dashboard'>, source: BundleSource | null): string | null;
export function contentId(files: ManifestFile[]): string;
export function sha256File(path: string): Promise<string>;
export function installedManifest(root: string): { files: ManifestFile[]; created: string; commit?: string; count: number; bytes: number } | null;
export function run(
  cmd: string,
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string | undefined>; inherit?: boolean; onLine?: ((line: string) => void) | null; shell?: boolean; onSpawn?: ((child: unknown) => void) | null },
): Promise<{ code: number; out: string; err: string }>;
export function sshHint(err: string, target: string): string;
export function readPointer(source: BundleSource, root: string): Promise<BundlePointer>;
export function decideBundle(pointer: BundlePointer, installed: string | null, prev: Partial<BundleRecord> | null | undefined): { action: 'current' | 'fetch'; why: string };
export function syncBundle(o: {
  root: string;
  source: BundleSource;
  prev?: BundleRecord | null;
  dryRun?: boolean;
  say?: (line: string) => void;
  bundleScript: string;
  tar?: string;
}): Promise<{ changed: boolean; record: BundleRecord | null }>;
export function bundleStamp(rec: { file?: string; created?: string } | null | undefined): string | null;
export const JOB_FIELDS: string[];
export function parseSet(list: string[]): Record<string, unknown>;
export function resolveJobs(spec: QueueSpec, o?: { length?: number | null; out?: string | null; set?: Record<string, unknown> }): QueueSpec;
export function needsLength(spec: QueueSpec, set?: Record<string, unknown>): boolean;
export function stateLabel(commit: string, dirty: boolean, content: string | null): string;
export function jobOfQueueStatus(st: unknown): { name: string; chunk: number; chunks: number; frames: number; framesTotal: number; fps?: number; etaS?: number; out: string } | undefined;
export function startHeartbeat(url: string | null, payload: () => unknown, everyMs?: number): { url: string | null; beat: () => Promise<unknown>; stop: () => Promise<unknown> };
