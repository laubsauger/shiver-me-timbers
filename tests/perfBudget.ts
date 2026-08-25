/**
 * §V80 — A TIME BUDGET IS A DECISION ABOUT A MACHINE, NOT A PROPERTY OF THE CODE.
 *
 * Three bake budgets (`erosion`, `pathGraph`, `terrainInfo`) were absolute
 * millisecond numbers measured on the dev machine, and they FAIL on any
 * machine that is not it: a free-tier CI runner is a shared 2-core box that
 * came in at 301 ms against a 300 ms bar, 127 ms against 60 and 60 ms against
 * 40 — no defect, no regression, just a slower computer, and it blocked a
 * deploy. Raising the numbers until CI is happy throws the budget away on the
 * dev machine, where it is doing real work: these passes run at ISLAND LOAD
 * TIME and a 3× regression there is a stall the player sees.
 *
 * So the budget is expressed against a reference workload MEASURED IN THIS
 * PROCESS. `budgetMs(300)` means "300 ms of the machine this suite was tuned
 * on", and a box half the speed gets 600. What the assertion still catches is
 * the thing worth catching: an algorithmic regression, which shows up as a
 * multiple of the budget on every machine.
 *
 * The workload is deterministic, allocation-free and single-threaded, so it
 * measures the same thing the bakes are bound by (scalar FP throughput) and
 * cannot itself be affected by GC or worker contention beyond the min-of-runs
 * this already takes.
 */

const ITERATIONS = 3_000_000;
/**
 * The reference workload's cost on the machine every budget in the suite was
 * measured on (2026-08-25, M-series laptop, min of 5). If you re-tune the
 * budgets on different hardware, re-measure this in the same run.
 */
const REFERENCE_MS = 22.8;
/**
 * The most a slow machine may be forgiven. Past this the budgets stop meaning
 * anything, and a box that slow should not be gating a deploy at all — better
 * to fail loudly than to pass a 10× regression because the runner was busy.
 */
const MAX_FACTOR = 8;

function workload(): number {
  let s = 0;
  for (let i = 1; i <= ITERATIONS; i++) s += Math.sqrt(i) * Math.sin(i * 0.001);
  return s;
}

let cached: number | null = null;

/** how many times slower this machine is than the one the budgets came from (≥ 1) */
export function machineFactor(): number {
  if (cached !== null) return cached;
  workload(); // warm the JIT before the first timed run
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    workload();
    best = Math.min(best, performance.now() - t0);
  }
  const raw = best / REFERENCE_MS;
  cached = Math.min(MAX_FACTOR, Math.max(1, Number.isFinite(raw) ? raw : 1));
  return cached;
}

/** a budget authored on the reference machine, scaled to the one running now */
export function budgetMs(referenceMs: number): number {
  return referenceMs * machineFactor();
}

/** for a failure message: '127.1 ms vs 60 ms budget (machine ×2.1)' */
export function budgetLabel(measuredMs: number, referenceMs: number): string {
  return `${measuredMs.toFixed(1)} ms vs ${budgetMs(referenceMs).toFixed(0)} ms budget `
    + `(${referenceMs} ms reference × machine ${machineFactor().toFixed(2)})`;
}
