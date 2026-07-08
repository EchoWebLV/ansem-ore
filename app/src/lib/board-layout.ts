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

/** One cell's SVG geometry in the prototype's 400x340 viewBox (docs/design/bull-board.html). */
export interface SvgCell {
  id: number;
  cx: number;
  cy: number;
  r: number;      // outer hex radius for this cell
  eye: boolean;
  points: string; // flat-top hexagon polygon points (at r*0.92, like the prototype)
}

/** Flat-top hexagon polygon points, exactly as the design prototype computes them. */
export function hexPoints(cx: number, cy: number, R: number): string {
  const p: string[] = [];
  for (let k = 0; k < 6; k++) {
    const a = (60 * k * Math.PI) / 180;
    p.push(`${(cx + R * Math.cos(a)).toFixed(1)},${(cy + R * Math.sin(a)).toFixed(1)}`);
  }
  return p.join(" ");
}

/** The design's SVG layout: 25 hex cells fitted into a 400x340 viewBox. */
export function svgCells(): SvgCell[] {
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
  const W = 400, H = 340;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const mnx = Math.min(...xs) - 1, mxx = Math.max(...xs) + 1;
  const mny = Math.min(...ys) - 1, mxy = Math.max(...ys) + 1;
  const s = Math.min((W - 20) / (mxx - mnx), (H - 20) / (mxy - mny));
  const ox = (W - s * (mxx - mnx)) / 2 - s * mnx;
  const oy = (H - s * (mxy - mny)) / 2 - s * mny;
  return pts.map((p, id) => {
    const cx = ox + s * p.x, cy = oy + s * p.y, r = s * 0.9;
    return {
      id, cx, cy, r,
      eye: Math.abs(p.c) === 1 && p.r === 0,
      points: hexPoints(cx, cy, r * 0.92),
    };
  });
}

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
