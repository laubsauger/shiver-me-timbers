// Types for drift-farm.mjs so tests (tsc over tests/) can import it. The job's full shape: drift-dash.mjs's FarmJob.
import type { IncomingMessage, ServerResponse } from 'node:http';

export const LEASE_MS: number;
export const PATIENCE_MS: number;
export const CLAIM_HOLD_MS: number;
export const FREE_MS: number;
export const FINAL: Set<string>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type FarmJobRecord = Record<string, any> & { id: string; state: string };
export function transition(job: FarmJobRecord, to: string, patch?: Record<string, unknown>): FarmJobRecord;
export function jobKind(argv: string[]): 'still' | 'clip' | 'long';
export function jobClass(argv: string[]): string;
export function pickWorker(job: { kind: string; prefer?: string | null; queuedAt?: number; createdAt?: number }, waiting: { node: string; speed: number }[], free: { node: string; speed: number }[], now: number, patienceMs?: number): string | null;
export function holdReason(job: { kind: string; prefer?: string | null; queuedAt?: number; createdAt?: number }, workers: { node: string; state: string; why?: string | null; speed: number }[], now: number, patienceMs?: number): string;
export function learn(speeds: unknown, s: { node: string; cls: string; fps?: number; durS?: number; speed?: number }): { nodes: Record<string, Record<string, number>>; dur1: Record<string, number> };
export function speedOf(node: string, speeds: unknown, hint?: number): number;
export const SAMPLE_MS: number;
export const SAMPLES_MAX: number;
export function fpsSamples(samples: [number, number, number | null][] | undefined, t: number, fps: number, done?: number | null): [number, number, number | null][];
export function safeRel(p: string | null | undefined): string | null;
export function landingPath(out: { local: string; file: boolean }, rel: string): string;
export function gitIgnoreState(file: string): 'ignored' | 'tracked' | 'not-ignored' | 'no-repo';
export function farmToken(file: string): { token: string; created: boolean };
export function createFarmHub(o: {
  dir: string;
  token: string;
  allow?: (ip: string | undefined) => boolean;
  hints?: () => { name: string; tailnetIp?: string; speed?: number }[];
  bundleDir?: string | null;
  repo?: string | null;
  assetsRoot?: string | null;
  now?: () => number;
  log?: (m: string) => void;
}): {
  handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  view(): any;
  sweep(): void;
  close(): void;
  jobs(): FarmJobRecord[];
};
