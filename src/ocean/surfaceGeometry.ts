/**
 * Ocean surface geometry (§V.4): camera-following XZ grid.
 * Dense central patch carries the FFT displacement; a coarse outer ring
 * reaches the horizon (displacement fades there — spec §V.19 tiling is
 * hidden by distance fade + fog, not by stretching one grid to infinity).
 * The mesh snaps to whole grid steps so vertices never "swim".
 */
import * as THREE from 'three/webgpu';

export interface SurfaceGridOptions {
  /** side length of the dense patch in meters */
  innerSize: number;
  /** vertices per side of the dense patch */
  innerSegments: number;
  /** outer ring reaches this radius (m) */
  horizonRadius: number;
  /** outer ring segments (radial × angular) */
  ringRadial: number;
  ringAngular: number;
}

/** flat XZ grid centered at origin, y = 0 */
export function buildInnerGrid(o: SurfaceGridOptions): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(o.innerSize, o.innerSize, o.innerSegments, o.innerSegments);
  g.rotateX(-Math.PI / 2);
  return g;
}

/**
 * Annulus from innerSize/2 to horizonRadius with exponentially growing
 * radial spacing — cheap horizon fill.
 */
export function buildHorizonRing(o: SurfaceGridOptions): THREE.BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const r0 = o.innerSize * 0.5 * Math.SQRT1_2 * 1.42; // just outside inner square
  const growth = Math.pow(o.horizonRadius / r0, 1 / o.ringRadial);
  for (let i = 0; i <= o.ringRadial; i++) {
    const r = r0 * Math.pow(growth, i);
    for (let j = 0; j <= o.ringAngular; j++) {
      const a = (j / o.ringAngular) * Math.PI * 2;
      positions.push(Math.cos(a) * r, 0, Math.sin(a) * r);
    }
  }
  const cols = o.ringAngular + 1;
  for (let i = 0; i < o.ringRadial; i++) {
    for (let j = 0; j < o.ringAngular; j++) {
      const a = i * cols + j;
      const b = a + 1;
      const c = a + cols;
      const d = c + 1;
      indices.push(a, c, b, b, c, d);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(indices);
  return g;
}

/** snap a camera position to grid steps (returns mesh origin XZ) */
export function snapToGrid(
  x: number,
  z: number,
  o: SurfaceGridOptions,
): [number, number] {
  const step = o.innerSize / o.innerSegments;
  return [Math.floor(x / step) * step, Math.floor(z / step) * step];
}
