// Types for checkPilotGlb.mjs so tests (tsc over tests/) can import the pilot checker.
import type { Document } from '@gltf-transform/core';

export interface PilotConfig {
  version: number;
  rig: {
    maxBones: number;
    extraBones: Record<string, { parent: string; deform: boolean; face?: boolean; about?: string }>;
    sockets: { cam_eye: { parentBone: string; forwardM: number; nearMaxM: number; about?: string } };
  };
  lod: { trisMax: number[]; trisTarget: number[] };
  hair: { styles: string[] };
  clips: Record<string, { loop: boolean; additive: boolean }>;
  materials: Record<string, { alphaMode: 'OPAQUE' | 'MASK' | 'BLEND'; doubleSided: boolean; alphaCutoff?: number; size: number }>;
  helm: {
    wheelHub: number[];
    wheelAxis: number[];
    wheelRadius: number;
    rimTube: number;
    gripClockDeg: number;
    throttleOrigin: number[];
    throttleIdleDeg: number;
    throttleFullDeg: number;
    footBar: number[];
    soleY: number;
    eyeAnchorParts: number[];
    cableDashAnchor: number[];
    [key: string]: unknown;
  };
  seat: { panAboveSole: number; panFrontEdgeZ: number; backrestFaceZ: number; hipsZRange: number[]; maxLeanDeg: number; [key: string]: unknown };
  [key: string]: unknown;
}

export interface PilotCheckResult {
  errors: string[];
  warnings: string[];
  stats: { tris: number[]; worstVariantTris: number[]; joints: number; clips: string[]; materials: string[]; textures: number; draws: number[] };
}

export const PILOT_CONFIG_PATH: string;
export const REQUIRED_BONES: string[];
export const VARIANT_KEYS: string[];
export function loadPilotConfig(path?: string): PilotConfig;
export function slotOf(name: string): string;
export function checkPilotDocument(document: Document, cfg: PilotConfig, opts?: { stage?: 'raw' | 'final' }): PilotCheckResult;
export function checkPilotFile(path: string, opts?: { stage?: 'raw' | 'final'; config?: PilotConfig }): Promise<PilotCheckResult>;
