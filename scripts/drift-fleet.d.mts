// Types for drift-fleet.mjs so tests (tsc over tests/) can import it. The card's full shape: drift-dash.mjs's Machine.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function macCard(o: { host: string; machine: unknown; slots: unknown; farm?: unknown[]; farmState?: unknown; worker?: unknown }): any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function farmHeartbeats(workers?: unknown[]): any[];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function newestHeartbeats(...lists: unknown[][]): any[];
