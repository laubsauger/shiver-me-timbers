// Types for drift-chrome.mjs so tests (tsc over tests/) can import it.
export const NODE_CHROME_FILE: string;
export const PLATFORM_GPU_ARGS: Record<string, string[]>;
export const GPU_ARG_VARIANTS: Record<string, string[][]>;
export function gpuArgs(): { args: string[]; from: string };
export function chromeLaunchOptions(channel: string | undefined, gpu?: string[]): { channel?: string; headless: boolean; args: string[]; ignoreDefaultArgs?: string[] };
export const PROFILES_DIR: string;
export const PROFILE_GPU_CACHE_MAX: number;
export const GPU_CACHE_DIRS: string[];
export function takeProfile(kind: string, root?: string, pid?: number): { dir: string; release: () => void };
export function gpuDriver(): string | null;
export function staleWhy(meta: { driver?: string | null; chrome?: string } | null, o: { driver: string | null; chrome?: string | null; bytes: number; max?: number }): string | null;
export function clearGpuCaches(dir: string): void;
export interface ChromeHandle {
  newPage(o?: { viewport?: { width: number; height: number } }): Promise<unknown>;
  close(): Promise<void>;
  version(): string;
  profile: { dir: string; cache: 'warm' | 'cold'; why: string | null } | null;
}
export function launchChrome(chromium: unknown, o?: { channel?: string; gpu?: string[]; kind?: string; say?: (m: string) => void }): Promise<ChromeHandle>;
