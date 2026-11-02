// Types for drift.adapter.mjs so tests (tsc over tests/) can import it: the parts the tests use.
type Progress = { done: number | null; total: number | null; unit: string | null; fps: number | null; etaS: number | null };
export function progress(line: string, prev?: Progress): Progress;
export function jobKind(argv: string[]): 'still' | 'clip' | 'long';
export function jobClass(argv: string[]): string;
export function needVramGB(job: { size?: number; lanes?: number } | null | undefined, policy?: { needVramGB?: number }): number;
export const VITE_CACHES: string[];
export function typedJobOf(argv: string[], o?: { cwd?: string }): { spec: { type: string; params: Record<string, unknown> }; inputs: Record<string, string>; land: Record<string, string | { file: string } | { dir: string }> } | null;
