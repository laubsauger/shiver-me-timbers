// Types for drift-consistency.mjs so tests (tsc over tests/) can import it.
export const NOISE_RMS: number;
export const NOISE_MEAN: number;
export interface Rgb { w: number; h: number; rgb: Buffer | Uint8Array }
export function readRgb(file: string): Rgb;
export function means(p: Rgb): { y: number; r: number; g: number; b: number };
export function compare(a: Rgb, ref: Rgb): { rms: number; p99: number; heat: Buffer };
export function withinNoise(m: { y: number }, ref: { y: number }, c: { rms: number }): boolean;
