/**
 * Precomputed display strings for the per-frame HUD path.
 *
 * WHY: the race HUD changes numbers every frame (lap clock, knots, rpm, gaps). Formatting them
 * with toFixed or template strings makes garbage every frame, and GC pauses show up as hitches in a
 * 60 fps racer. Every number the hot path shows is quantised and looked up here instead, and each
 * group of digits sits in its own Text node (`Text.data = TABLE[i]`), so an update allocates nothing.
 * Built once at module load, about 12 kB of strings.
 */

/** U+2212 MINUS SIGN: typographic minus, same width as plus in Saira */
export const MINUS = '−';

const range = (n: number, f: (i: number) => string): readonly string[] => Array.from({ length: n }, (_, i) => f(i));

/** "0".."999" */
export const INT: readonly string[] = range(1000, (i) => String(i));
/** "00".."99" */
export const PAD2: readonly string[] = range(100, (i) => String(i).padStart(2, '0'));
/** "000".."999" */
export const PAD3: readonly string[] = range(1000, (i) => String(i).padStart(3, '0'));

/** rpm quantised to 50: RPM_TEXT[rpm/50] = "5,850" */
export const RPM_STEP = 50;
export const RPM_TEXT: readonly string[] = range(201, (i) => (i * RPM_STEP).toLocaleString('en-US'));

/** signed whole degrees −40..+40 as "+4°" / "−6°" */
export const DEG_MIN = -40;
export const DEG_TEXT: readonly string[] = range(81, (i) => {
  const d = i + DEG_MIN;
  return d > 0 ? `+${d}°` : d < 0 ? `${MINUS}${-d}°` : '0°';
});

/** transform strings for a 0..1 bar in 1/200 steps (style.transform = SCALE_X[k]) */
export const SCALE_STEPS = 200;
export const SCALE_X: readonly string[] = range(SCALE_STEPS + 1, (i) => `scaleX(${i / SCALE_STEPS})`);

export const clampInt = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v) | 0;

/** set a Text node only when the string changes (strings from the tables compare by identity) */
export function setData(node: Text, s: string): void {
  if (node.data !== s) node.data = s;
}
