/**
 * @types/three 0.186 types `.clamp()`, `.min()` and `.max()` for float and vector nodes only (MathNode.d.ts:
 * "TODO Allow int/uint"). three's runtime does them on integers too (WGSL `clamp`/`min`/`max` on i32/u32), and
 * the compute passes here clamp and bound texel indices with them. This fills that typing gap; it changes no
 * emitted code.
 */
import type { Node } from 'three/webgpu';

declare module 'three/src/nodes/core/Node.js' {
  interface IntExtensions {
    clamp(low?: Node<'int'> | number, high?: Node<'int'> | number): Node<'int'>;
    min(...values: Array<Node<'int'> | number>): Node<'int'>;
    max(...values: Array<Node<'int'> | number>): Node<'int'>;
  }
  interface UintExtensions {
    clamp(low?: Node<'uint'> | number, high?: Node<'uint'> | number): Node<'uint'>;
    min(...values: Array<Node<'uint'> | number>): Node<'uint'>;
    max(...values: Array<Node<'uint'> | number>): Node<'uint'>;
  }
}
