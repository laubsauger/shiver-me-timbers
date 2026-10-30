// Types for drift-sanity.mjs so tests (tsc over tests/) can import it.
export const BLACK_MAX: number;
export const DROP_FROM: number;
export const LOOKED_AT: RegExp;
export function frameMaxima(file: string): number[] | null;
export function blackVerdict(maxima: number[] | null, o?: { still?: boolean; allowBlack?: boolean }): string | null;
export function checkOutput(file: string, o?: { allowBlack?: boolean }): string | null;
