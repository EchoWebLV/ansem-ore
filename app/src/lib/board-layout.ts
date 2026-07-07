/** One bull tile's placement on the board. `id` === on-chain square index 0..24. */
export interface BullCell {
  id: number;
  left: number; // normalized [0,1] center x within the board box
  top: number;  // normalized [0,1] center y within the board box
  eye: boolean; // the two glowing-eye cells (|c|==1, r==0)
}

const S3 = Math.sqrt(3);

// Half-lattice (col >= 0), mirrored across the center column -> 25 symmetric cells.
// (c,r) -> flat-top hex pixel: x = c*1.5 ; y = r*sqrt3 + (|c| odd ? sqrt3/2 : 0).
const HALF: Array<[number, number]> = [
  [0, 0], [0, 1], [0, 2], [0, 3], [0, 4], // center column: poll -> chin
  [1, -1], [1, 0], [1, 1], [1, 2],        // inner face (row0 = eye)
  [2, 0], [2, 1], [2, 2],                 // cheeks
  [3, -1], [3, 0],                        // lower horn
  [4, -1],                                // horn tip
];

/** Deterministic bull-head layout: 25 cells with normalized positions. */
export function bullCells(): BullCell[] {
  const raw: Array<{ c: number; r: number }> = [];
  for (const [c, r] of HALF) {
    raw.push({ c, r });
    if (c !== 0) raw.push({ c: -c, r });
  }
  const pts = raw.map(({ c, r }) => ({
    c, r,
    x: c * 1.5,
    y: r * S3 + (Math.abs(c) % 2 === 1 ? S3 / 2 : 0),
  }));
  const xs = pts.map((p) => p.x);
  const ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1;
  const spanY = maxY - minY || 1;
  return pts.map((p, id) => ({
    id,
    left: (p.x - minX) / spanX,
    top: (p.y - minY) / spanY,
    eye: Math.abs(p.c) === 1 && p.r === 0,
  }));
}
