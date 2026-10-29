// Types for drift-fleet.mjs so tests (tsc over tests/) can import it. The card's full shape: drift-dash.mjs's Machine.

export const STALE_MS: number;
export interface FarmNode { name: string; tailnet: string; tailnetIp?: string; os: string; gpu: string; vramGB: number; speed: number; maxLanes: number; battery?: boolean; agentUrl?: string }
export function farmNodes(file: string): FarmNode[];
export function agentView(n: FarmNode, a: unknown): Record<string, unknown>;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function machineCard(n: FarmNode, view: unknown, report: unknown, policy?: unknown, now?: number, farmJob?: unknown): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function fleetCards(o: { agents?: Record<string, unknown>; hub?: unknown; reports?: unknown[]; farm?: unknown[]; allow?: FarmNode[]; mac?: unknown; policy?: unknown; now?: number }): any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function macCard(o: { host: string; machine: unknown; slots: unknown }): any;
