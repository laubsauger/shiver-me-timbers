// Types for drift-join.mjs so tests (tsc over tests/) can import it.
export function frameCountOf(file: string): number;
export function joinClips(files: string[], out: string, F: number, list: string, say?: (m: string) => void): string | null;
