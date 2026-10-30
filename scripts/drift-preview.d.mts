// Types for drift-preview.mjs so tests (tsc over tests/) can import it.
export const PREVIEW_EVERY_MS: number;
export const PREVIEW_WIDTH: number;
export function previewTee(o?: { file?: string; everyMs?: number; now?: () => number; ffmpeg?: string }): { offer(bytes: Buffer | Uint8Array, w: number, h: number, o?: { depth?: number; crop?: number | null }): boolean };
