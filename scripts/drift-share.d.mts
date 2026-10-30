// Types for drift-share.mjs so tests (tsc over tests/) can import it.

export interface YieldPolicy {
  foreignVramGB: number;
  foreignUtil: number;
  needVramGB: number | null;
  recheckS: number;
}
export interface ProcEntry {
  pid: number;
  ppid: number;
  cpuPct: number | null;
  rssMB: number;
  cmd: string;
}
export interface SmiGpu {
  name: string | null;
  totalMB: number | null;
  usedMB: number | null;
  freeMB: number | null;
  utilPct: number | null;
  procs: { pid: number; type: string | null; path: string; memMB: number | null }[];
}
export interface GpuShare {
  name: string | null;
  totalMB: number | null;
  usedMB: number | null;
  freeMB: number | null;
  utilPct: number | null;
  procs: { pid: number; label: string; kind: 'ours' | 'system' | 'foreign'; heavy: boolean; memMB: number | null }[];
  oursMB: number;
  foreignMB: number;
  systemMB: number;
  memKnown: boolean;
  /** the sustained utilisation (gpuSnapshot's window over this process's samples) */
  utilWindow?: { medianPct: number | null; n: number; spanS: number };
}
export interface ShareDecision {
  state: 'idle' | 'busy-foreign' | 'rendering' | 'rendering+shared';
  canStart: boolean;
  why: string;
  foreign: { name: string; memGB: number | null }[];
  foreignGB: number | null;
  freeGB: number | null;
}

export const YIELD_DEFAULTS: Readonly<YieldPolicy>;
export function readYieldPolicy(root: string): YieldPolicy;
export function policyOf(y: unknown, where?: string): YieldPolicy;
export function needVramGB(job: { size?: number; lanes?: number } | null | undefined, policy?: YieldPolicy): number;
export function parseNvidiaSmiXml(xml: string): { driver: string | null; gpus: SmiGpu[] };
export function parsePsTable(text: string): Map<number, ProcEntry>;
export const WIN_GPU_MARK: string;
export const WIN_PS: string;
export const WIN_ADAPTER_MARK: string;
export function parseWinPs(text: string): { table: Map<number, ProcEntry>; gpuMemByLuid: Map<string, Map<number, number>>; adapters: Map<string, number> };
export function nvidiaGpuMem(w: { gpuMemByLuid: Map<string, Map<number, number>>; adapters: Map<string, number> }, usedMB: number): Map<number, number>;
export function isOurs(pid: number, table: Map<number, ProcEntry>, path?: string): boolean;
export interface AgentService { name: string; pid: number; alive?: boolean; vramMb?: number | null }
export function classify(pid: number, path: string, table: Map<number, ProcEntry>, services?: AgentService[]): { kind: 'ours' | 'system' | 'foreign'; label: string; heavy: boolean };
export function shareOf(parsed: { gpus: SmiGpu[] } | null | undefined, table: Map<number, ProcEntry>, gpuMem?: Map<number, number>, services?: AgentService[]): GpuShare | null;
export function agentOf(rows: unknown, devices: unknown): { services: AgentService[]; gpuName: string | null } | null;
export function localAgent(o?: { port?: number; timeoutMs?: number }): Promise<{ services: AgentService[]; gpuName: string | null } | null>;
export function shareDecision(share: GpuShare | null, policy?: YieldPolicy, needGB?: number | null): ShareDecision;
export function gpuSnapshot(o?: { agent?: { services: AgentService[]; gpuName: string | null } | null }): Promise<GpuShare | null>;
export function waitForGpu(o?: {
  policy?: YieldPolicy;
  needGB?: number | null;
  say?: (m: string) => void;
  onWait?: (d: ShareDecision, sinceMs: number) => void;
  force?: boolean;
  snapshot?: () => Promise<GpuShare | null>;
}): Promise<ShareDecision | null>;
export const UTIL_WINDOW_S: number;
export const UTIL_MIN_SAMPLES: number;
export const UTIL_MIN_SPAN_S: number;
export function utilWindow(samples: { at: number; pct: number | null; ours?: boolean }[], now: number, windowS?: number): { medianPct: number | null; n: number; spanS: number };
export function sustainedSnapshot(snapshot?: () => Promise<GpuShare | null>, stepMs?: number): Promise<GpuShare | null>;
