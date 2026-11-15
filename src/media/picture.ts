// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Whether a video's picture could be carrying captions (open captions), measured from frames the media-files
// probe samples while speech is heard. Pure arithmetic on pixels: no AI, no text recognition. It answers one
// narrow question, strictly: does this frame show anything fine enough to be writing? A frame is "plain" only
// when no part of it holds small marks (letters, digits, icons, texture): flat colour, smooth gradients, large
// shapes and thin straight rules are plain. Anything else ("marks") may be text, which this cannot read, so it
// decides nothing: a video is failed for missing captions only when every sampled frame is plain, because then
// its picture cannot be giving the words. Engine core: no imports.

/** Side of a cell (px). A line of text 6 px tall or more puts marks in a cell. */
export const PICTURE_CELL = 16;
/**
 * How far apart cells start (px): half a cell, so cells overlap and a line of writing that lies across the edge
 * of one cell is whole inside the next. The last cell along each side ends at the frame's edge, whatever the
 * frame's size: no strip at the right or the bottom goes unread (review round 1, S2).
 */
export const PICTURE_STEP = 8;
/** A step this large (0-255) in any colour channel across two pixels is an edge. Readable text steps far more. */
export const PICTURE_EDGE = 24;

export interface FrameMarks {
  width: number;
  height: number;
  /** Cells that hold small marks, and the cells of the frame (cells overlap: `PICTURE_STEP`). */
  marked: number;
  cells: number;
  /** The box around the marked cells (px), when there are some. */
  box?: { x: number; y: number; w: number; h: number };
}

/**
 * The marks of one frame (`rgba`: width × height × 4 bytes). A stroke is a run of edge pixels along a row
 * (runs two pixels apart or less are one stroke, so a thin rule is one stroke, not two). A cell holds marks when
 * three or more of its rows each cross two strokes or more, or the same down its columns: letters and small
 * shapes do; a flat area, a gradient, the edge of a large shape or a rule through the cell do not. Cells start
 * every `PICTURE_STEP` px and the last one along each side ends at the frame's edge, so every pixel of the frame
 * is in a cell.
 */
export function frameMarks(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): FrameMarks {
  // Self-contained (no outer names): the media-files probe sends this function's source into the page.
  const PICTURE_CELL = 16; // the exported PICTURE_CELL
  const PICTURE_STEP = 8; // the exported PICTURE_STEP
  const PICTURE_EDGE = 24; // the exported PICTURE_EDGE
  // Rows (or columns) of a cell that must each cross two strokes or more for the cell to hold marks.
  const MARK_ROWS = 3;
  /** Where cells start along a side of `size` px: every step, and one that ends at the edge. */
  const starts = (size: number): number[] => {
    const at: number[] = [];
    for (let s = 0; s + PICTURE_CELL <= size; s += PICTURE_STEP) at.push(s);
    if (at.length && at[at.length - 1]! + PICTURE_CELL < size) at.push(size - PICTURE_CELL);
    return at;
  };
  const xs = Number.isInteger(width) && width > 0 ? starts(width) : [];
  const ys = Number.isInteger(height) && height > 0 ? starts(height) : [];
  const out: FrameMarks = { width, height, marked: 0, cells: xs.length * ys.length };
  // A frame with no whole cell, or with bytes missing, has no cells: it is never read as plain.
  if (!xs.length || !ys.length || rgba.length < width * height * 4) return { ...out, cells: 0 };
  // Edges: a central difference along the row (and down the column), the largest of the three channels.
  const along = new Uint8Array(width * height);
  const down = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const up = Math.max(0, y - 1) * width;
    const below = Math.min(height - 1, y + 1) * width;
    for (let x = 0; x < width; x++) {
      const a = (y * width + Math.max(0, x - 1)) * 4;
      const b = (y * width + Math.min(width - 1, x + 1)) * 4;
      if (Math.abs(rgba[a]! - rgba[b]!) > PICTURE_EDGE || Math.abs(rgba[a + 1]! - rgba[b + 1]!) > PICTURE_EDGE || Math.abs(rgba[a + 2]! - rgba[b + 2]!) > PICTURE_EDGE) along[y * width + x] = 1;
      const c = (up + x) * 4;
      const d = (below + x) * 4;
      if (Math.abs(rgba[c]! - rgba[d]!) > PICTURE_EDGE || Math.abs(rgba[c + 1]! - rgba[d + 1]!) > PICTURE_EDGE || Math.abs(rgba[c + 2]! - rgba[d + 2]!) > PICTURE_EDGE) down[y * width + x] = 1;
    }
  }
  // For each row, and each place a cell starts along it: does the row cross two strokes or more inside that cell?
  // (And the same for each column.) A cell's rows are then counted from these.
  const nx = xs.length;
  const ny = ys.length;
  const rowHit = new Uint8Array(height * nx);
  for (let y = 0; y < height; y++) {
    for (let i = 0; i < nx; i++) {
      const left = xs[i]!;
      let strokes = 0;
      let gap = 3;
      for (let x = left; x < left + PICTURE_CELL && strokes < 2; x++) {
        if (along[y * width + x]) { if (gap > 2) strokes++; gap = 0; } else gap++;
      }
      if (strokes >= 2) rowHit[y * nx + i] = 1;
    }
  }
  const colHit = new Uint8Array(width * ny);
  for (let x = 0; x < width; x++) {
    for (let j = 0; j < ny; j++) {
      const top = ys[j]!;
      let strokes = 0;
      let gap = 3;
      for (let y = top; y < top + PICTURE_CELL && strokes < 2; y++) {
        if (down[y * width + x]) { if (gap > 2) strokes++; gap = 0; } else gap++;
      }
      if (strokes >= 2) colHit[x * ny + j] = 1;
    }
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -1;
  let y1 = -1;
  for (let j = 0; j < ny; j++) {
    const top = ys[j]!;
    for (let i = 0; i < nx; i++) {
      const left = xs[i]!;
      let rows = 0;
      for (let y = top; y < top + PICTURE_CELL && rows < MARK_ROWS; y++) rows += rowHit[y * nx + i]!;
      let cols = 0;
      if (rows < MARK_ROWS) for (let x = left; x < left + PICTURE_CELL && cols < MARK_ROWS; x++) cols += colHit[x * ny + j]!;
      if (rows >= MARK_ROWS || cols >= MARK_ROWS) {
        out.marked++;
        if (left < x0) x0 = left;
        if (top < y0) y0 = top;
        if (left + PICTURE_CELL > x1) x1 = left + PICTURE_CELL;
        if (top + PICTURE_CELL > y1) y1 = top + PICTURE_CELL;
      }
    }
  }
  if (out.marked) out.box = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  return out;
}

/** True when the frame shows nothing fine enough to be writing. */
export const framePlain = (m: FrameMarks): boolean => m.cells > 0 && m.marked === 0;
