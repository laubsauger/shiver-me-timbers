/** Map each cell to water at least two grid steps clear of land.
 * Four-neighbor breadth-first extension keeps the offshore sample on the
 * nearest coast in grid distance. Geometry only: bake once, reuse when wind
 * or swell turns. Open-water cells retain their own sample.
 */
export function shoreSamplingMap(land: Uint8Array, size: number): Int32Array {
  if (land.length !== size * size) throw new Error('Shore sampling requires a square land grid');
  const source = new Int32Array(land.length).fill(-1);
  // Dilate only land cells, rather than searching a neighborhood around
  // every ocean cell. Offshore water is most of the grid.
  const blocked = land.slice();
  for (let i = 0; i < land.length; i++) {
    if (!land[i]) continue;
    const x = i % size, z = Math.floor(i / size);
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (Math.abs(dx) + Math.abs(dz) > 2) continue;
      const xx = x + dx, zz = z + dz;
      if (xx >= 0 && xx < size && zz >= 0 && zz < size) blocked[zz * size + xx] = 1;
    }
  }
  const queue = new Int32Array(land.length);
  let read = 0, write = 0, seeds = 0;
  for (let z = 0; z < size; z++) for (let x = 0; x < size; x++) {
    const i = z * size + x;
    if (blocked[i]) continue;
    source[i] = i; seeds++;
    // Only the offshore rim can extend onto the beach. Do not enqueue and
    // revisit the entire open ocean just to discover it already has a source.
    if ((x > 0 && blocked[i - 1]) || (x + 1 < size && blocked[i + 1]) ||
        (z > 0 && blocked[i - size]) || (z + 1 < size && blocked[i + size])) queue[write++] = i;
  }
  if (seeds === 0) throw new Error('Shelter grid contains no offshore water for shore sampling');
  const visit = (from: number, to: number) => {
    if (source[to] !== -1) return;
    source[to] = source[from]; queue[write++] = to;
  };
  while (read < write) {
    const i = queue[read++], x = i % size, z = Math.floor(i / size);
    if (x > 0) visit(i, i - 1);
    if (x + 1 < size) visit(i, i + 1);
    if (z > 0) visit(i, i - size);
    if (z + 1 < size) visit(i, i + size);
  }
  return source;
}
