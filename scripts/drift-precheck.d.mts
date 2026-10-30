// Types for drift-precheck.mjs so tests (tsc over tests/) can import it.
export const ENTRIES: string[];
export function precheck(root?: string, entries?: string[]): Promise<{ ok: boolean; ms: number; errors: { text: string; where: string | null }[]; skipped?: boolean }>;
export function precheckMessage(r: { errors: { text: string; where: string | null }[] }): string;
