/**
 * PARAMS AS A NUMBER VECTOR (§T.178). The CPU mirror reads `OceanParams` and
 * `SeaPhysicsParams` LIVE every tick — the weather preset lerps them, the panel tweaks them,
 * and `SpectrumScheduler.advance(p)` arms a rebuild off their signature. A worker has its own
 * module instance of those singletons, so it would silently float the NPCs on the DEFAULT sea
 * while the player floats on the tweaked one (§V110, §V8). So the params are tick inputs:
 * the main thread flattens every numeric leaf into the buffer, the stepper writes them back
 * into its own copy of the same object shape before it steps.
 *
 * Leaf order is `Object.keys` order, recursively, arrays by index — identical on both sides
 * because the stepper's object is a structured clone of the main thread's (clone preserves
 * key order). Booleans travel as 0/1. Anything else (string, function, null) throws: a leaf
 * that cannot travel is a leaf the two seas could disagree on.
 */

type Leaf = number | boolean;

function walk(obj: unknown, path: string, visit: (holder: Record<string, unknown> | unknown[], key: string | number, v: Leaf, path: string) => void): void {
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      const v = obj[i];
      if (typeof v === 'object' && v !== null) walk(v, `${path}[${i}]`, visit);
      else if (typeof v === 'number' || typeof v === 'boolean') visit(obj, i, v, `${path}[${i}]`);
      else throw new Error(`params vector: ${path}[${i}] is ${typeof v}, only number/boolean leaves can travel`);
    }
    return;
  }
  if (typeof obj !== 'object' || obj === null) throw new Error(`params vector: ${path} is not an object`);
  const rec = obj as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    const v = rec[key];
    if (typeof v === 'object' && v !== null) walk(v, `${path}.${key}`, visit);
    else if (typeof v === 'number' || typeof v === 'boolean') visit(rec, key, v, `${path}.${key}`);
    else throw new Error(`params vector: ${path}.${key} is ${typeof v}, only number/boolean leaves can travel`);
  }
}

export function paramsLength(obj: object): number {
  let n = 0;
  walk(obj, '$', () => n++);
  return n;
}

/** write every leaf into `out` from `offset`; returns true if any slot changed */
export function writeParams(obj: object, out: Float64Array, offset: number): boolean {
  let i = offset;
  let changed = false;
  walk(obj, '$', (_h, _k, v) => {
    const x = typeof v === 'boolean' ? (v ? 1 : 0) : v;
    // Object.is: a NaN leaf that stays NaN is not a change, and −0 → +0 is
    if (!Object.is(out[i], x)) {
      out[i] = x;
      changed = true;
    }
    i++;
  });
  return changed;
}

/** write the vector back into an object of the same shape, in place (consumers hold references) */
export function readParams(target: object, src: Float64Array, offset: number): void {
  let i = offset;
  walk(target, '$', (holder, key, v) => {
    const x = src[i++];
    (holder as Record<string | number, unknown>)[key] = typeof v === 'boolean' ? x !== 0 : x;
  });
}
