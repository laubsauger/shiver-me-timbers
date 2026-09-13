// Types for checkGlb.mjs so tests (tsc over tests/) can import the checker.
import type { Document, NodeIO } from '@gltf-transform/core';

export interface CheckResult {
  errors: string[];
  warnings: string[];
  stats: { tris: number[]; drawsPerLod: number[]; materials: number; textures: number };
}

export interface CheckOptions {
  stage?: 'raw' | 'final';
  /** a scripts/blender/hullOffsets.ts dump: `proxy` (stem/transom/keel/deck/beam) and, when present,
   * `spec` + `stations` + `renderOnly` for the STYLE-SPEC C3 chine/sheer section rule */
  expect?: {
    proxy: { stemZ: number; transomZ: number; keelBodyY: number; deckBodyY: number; chineBeam: number };
    spec?: { length: number; lcgFromTransom: number; vcgAboveKeel: number };
    stations?: { z: number; chineHalfBeam: number; chineY: number; deckY: number; deckZ?: number }[];
    renderOnly?: { topsideFlareDeg?: number; topsideFlareStartAboveChine?: number } | null;
  };
  contract?: unknown;
}

export const CONTRACT_PATH: string;
export function loadContract(path?: string): unknown;
export function createIO(): Promise<NodeIO>;
export function readBytes(path: string): Uint8Array;
export function hullTopology(
  node: import('@gltf-transform/core').Node,
  tol: number,
): { tris: number; degenerate: number; openEdges: number; nonManifoldEdges: number; windingConflicts: number; volume: number };
export function ktx2LevelCount(bytes: Uint8Array | null): number;
export function checkDocument(document: Document, contract: unknown, opts?: CheckOptions): CheckResult;
export function checkGlbFile(path: string, opts?: CheckOptions): Promise<CheckResult>;
