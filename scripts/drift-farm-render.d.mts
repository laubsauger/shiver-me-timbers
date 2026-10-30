// Types for drift-farm-render.mjs so tests (tsc over tests/) can import it.
export function chunksOf(from: number, to: number, chunk: number, fps: number): { from: number; to: number; frames: number }[];
