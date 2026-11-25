// Pure layout for the 1–6 photo modes. No DOM, no imports: tests load this file directly.

export type Mode = 1 | 2 | 4 | 6;

export interface Cell {
  x: number;
  y: number;
  w: number;
  h: number;
}

// Photos sit inside the transparent middle of the twibbon (1080×1920 frame).
export const COLLAGE_AREA: Cell = { x: 60, y: 380, w: 960, h: 1120 };
export const COLLAGE_GAP = 16;

const MODES: readonly Mode[] = [1, 2, 4, 6];

const GRID: Record<Mode, { cols: number; rows: number }> = {
  1: { cols: 1, rows: 1 },
  2: { cols: 1, rows: 2 },
  4: { cols: 2, rows: 2 },
  6: { cols: 2, rows: 3 },
};

// Splits `total` px into `n` tracks separated by COLLAGE_GAP. Floors keep every edge on whole pixels,
// and the last track ends exactly on the area edge.
function tracks(start: number, total: number, n: number): { pos: number; size: number }[] {
  const avail = total - COLLAGE_GAP * (n - 1);
  const out: { pos: number; size: number }[] = [];
  for (let i = 0; i < n; i++) {
    const from = Math.floor((i * avail) / n);
    const to = Math.floor(((i + 1) * avail) / n);
    out.push({ pos: start + from + i * COLLAGE_GAP, size: to - from });
  }
  return out;
}

export function collageCells(mode: Mode): Cell[] {
  if (mode === 1) return [{ x: 0, y: 0, w: 1080, h: 1920 }];
  const { cols, rows } = GRID[mode];
  const colTracks = tracks(COLLAGE_AREA.x, COLLAGE_AREA.w, cols);
  const rowTracks = tracks(COLLAGE_AREA.y, COLLAGE_AREA.h, rows);
  // Row by row, left to right.
  const cells: Cell[] = [];
  for (const r of rowTracks) {
    for (const c of colTracks) cells.push({ x: c.pos, y: r.pos, w: c.size, h: r.size });
  }
  return cells;
}

// Unknown input falls back to 1, the single-photo mode that matches the original booth.
export function parseMode(value: unknown): Mode {
  const s = typeof value === "number" || typeof value === "string" ? String(value) : "";
  return MODES.find((m) => String(m) === s) ?? 1;
}

// The first shot counts down from 3; each later shot starts at 2 because the guest is already in place.
export function countdownFor(shotIndex: number): number[] {
  return shotIndex === 0 ? [3, 2, 1] : [2, 1];
}

// Source rect a cell is cut from. The guest sees the preview's cover crop of the camera frame
// (frameW x frameH), so cells are cut from that region, never from the full sensor frame.
export function cellSourceRect(
  srcW: number,
  srcH: number,
  cell: Cell,
  frameW: number,
  frameH: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const region = coverRect(srcW, srcH, frameW, frameH);
  const inner = coverRect(region.sw, region.sh, cell.w, cell.h);
  return { sx: region.sx + inner.sx, sy: region.sy + inner.sy, sw: inner.sw, sh: inner.sh };
}

// Same center-crop rule as compose.ts coverCrop. Inlined so this module stays import-free.
function coverRect(srcW: number, srcH: number, dstW: number, dstH: number) {
  const srcAspect = srcW / srcH;
  const dstAspect = dstW / dstH;
  if (srcAspect > dstAspect) {
    const sw = srcH * dstAspect;
    return { sx: (srcW - sw) / 2, sy: 0, sw, sh: srcH };
  }
  const sh = srcW / dstAspect;
  return { sx: 0, sy: (srcH - sh) / 2, sw: srcW, sh };
}
