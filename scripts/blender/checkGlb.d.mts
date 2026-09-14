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
/** §T.200: which channels a KTX2 actually encodes (DFD), and the livery channels a packaged boat must keep */
export function ktx2Channels(bytes: Uint8Array | null): { model: number; r: boolean; g: boolean; b: boolean; a: boolean } | null;
export function liveryChannelErrors(document: Document): string[];
export function checkDocument(document: Document, contract: unknown, opts?: CheckOptions): CheckResult;
export function checkGlbFile(path: string, opts?: CheckOptions): Promise<CheckResult>;
/** §V98 on the built GLB (§T.192): coplanar overlaps wider than 2 cm in both in-plane axes, world space */
export function coplanarOverlaps(
  lod0: import('@gltf-transform/core').Node | undefined,
  opts?: { planeTol?: number; maxAngleDeg?: number; minExtent?: number },
): { area: number; extent: [number, number]; centre: [number, number, number]; normal: [number, number, number]; nodes: [string, string]; materials: [string, string] }[];
export function coplanarErrors(lod0: import('@gltf-transform/core').Node | undefined, opts?: { planeTol?: number; maxAngleDeg?: number; minExtent?: number }): string[];
/** §T.192: per engine and coarse LOD, the worst distance of that LOD's drive surface samples from the LOD0 drive */
export function driveLodDeviation(
  lodGroups: (import('@gltf-transform/core').Node | undefined)[],
): { level: number; engine: string; worst: number; at: [number, number, number] | null; node: string | null; samples: number }[];
export function driveLodErrors(lodGroups: (import('@gltf-transform/core').Node | undefined)[], opts?: { tol?: number }): string[];
/** §T.192: the hull water-mask extras cover the well sole and stay inside the deck edge */
export function waterMaskErrors(rootExtras: Record<string, unknown>, lod0: import('@gltf-transform/core').Node | undefined, tol?: number): string[];
/** §T.192 / pilot-log v2: seat, wheel rim, throttle handle, footrest and dash cable sockets exist, agree and are reachable */
export function partsSocketErrors(rootExtras: Record<string, unknown>, lod0: import('@gltf-transform/core').Node | undefined): string[];
