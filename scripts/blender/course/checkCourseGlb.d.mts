// Types for checkCourseGlb.mjs so tests (tsc over tests/) can import the course checker.
import type { Document } from '@gltf-transform/core';

export interface CourseCheckResult {
  errors: string[];
  warnings: string[];
  stats: {
    /** heaviest PLACED INSTANCE per LOD (contract `instances`) */
    tris: number[];
    draws: number[];
    /** every variant summed per LOD */
    totalTris?: number[];
    materials: number;
    textures: number;
    variants: Record<string, { tris: number; min: number[]; max: number[] }>;
  };
}

export const COURSE_CONTRACT_PATH: string;
export function loadCourseContract(path?: string): unknown;
export function checkCourseDocument(document: Document, contract: unknown, opts?: { stage?: 'raw' | 'final'; asset?: string }): CourseCheckResult;
export function checkCourseGlbFile(path: string, opts?: { stage?: 'raw' | 'final'; asset?: string; contract?: unknown }): Promise<CourseCheckResult>;
