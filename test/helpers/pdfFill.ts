// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// How full each page of a printed PDF is: the lowest drawn content (text, an image, a filled or stroked
// shape that is not white) as a share of the printable height between the @page margins. Read with the
// engine's own pdf.js (unpdf): the operator list for shapes and images (with the current transform and
// clip), the text content for text. Used by the print-layout test and the local before/after proof.

export interface PageFill {
  /** 1-based page number. */
  page: number;
  /** 0–1: how far down the printable area the lowest drawn content reaches. 0: nothing drawn. */
  fill: number;
  /** Characters of text on the page (whitespace excluded). */
  chars: number;
  /** The page's text, in drawing order. */
  text: string;
  /** Pictures cut by the page edge: drawn partly inside the printable area and partly beyond it. */
  cutImages: number;
  /** Pictures drawn inside the printable area. */
  images: number;
}

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
/** The y range (PDF space, bottom-up) of a box in the space of `m`. */
function yRange(m: M, x0: number, y0: number, x1: number, y1: number): [number, number] {
  const ys = [[x0, y0], [x1, y0], [x0, y1], [x1, y1]].map(([x, y]) => m[1] * x! + m[3] * y! + m[5]);
  return [Math.min(...ys), Math.max(...ys)];
}
/** Near-white (paper): not visible as content. */
const isPaper = (hex: unknown) => {
  const m = typeof hex === 'string' ? /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex) : null;
  return !!m && [m[1], m[2], m[3]].every((c) => parseInt(c!, 16) >= 0xf4);
};

/**
 * The fill of every page. `marginPt`: the @page top and bottom margin in points (14 mm by default,
 * the report's print stylesheet).
 */
export async function pageFills(bytes: Uint8Array, marginPt = (14 / 25.4) * 72): Promise<PageFill[]> {
  const { getResolvedPDFJS } = await import('unpdf');
  const pdfjs = await getResolvedPDFJS();
  const OPS = pdfjs.OPS as Record<string, number>;
  const doc = await pdfjs.getDocument({ data: bytes.slice(), verbosity: 0 }).promise;
  const out: PageFill[] = [];
  try {
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      const [, , , top] = page.view as [number, number, number, number];
      const areaTop = top - marginPt;
      const areaBottom = marginPt;
      let lowest = Infinity;
      let cutImages = 0;
      let images = 0;
      const mark = (lo: number, hi: number, clip: [number, number]) => {
        const a = Math.max(lo, clip[0], areaBottom);
        const b = Math.min(hi, clip[1], areaTop);
        if (b - a > 0.2) lowest = Math.min(lowest, a);
      };
      const ops = await page.getOperatorList();
      type G = { m: M; clip: [number, number]; fill: unknown; stroke: unknown };
      let g: G = { m: [1, 0, 0, 1, 0, 0], clip: [-Infinity, Infinity], fill: '#000000', stroke: '#000000' };
      const stack: G[] = [];
      let pendingClip = false;
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i];
        const args = ops.argsArray[i] as unknown[];
        if (fn === OPS.save) stack.push({ ...g });
        else if (fn === OPS.restore) g = stack.pop() ?? g;
        else if (fn === OPS.transform) g.m = mul(g.m, args as unknown as M);
        else if (fn === OPS.paintFormXObjectBegin) {
          stack.push({ ...g });
          const fm = args[0] as M | null;
          if (fm) g.m = mul(g.m, Array.from(fm) as M);
        } else if (fn === OPS.paintFormXObjectEnd) g = stack.pop() ?? g;
        else if (fn === OPS.setFillRGBColor) g.fill = args[0];
        else if (fn === OPS.setStrokeRGBColor) g.stroke = args[0];
        else if (fn === OPS.clip || fn === OPS.eoClip) pendingClip = true;
        else if (fn === OPS.constructPath) {
          const op = args[0] as number;
          const mm = args[2] as Record<number, number> | null;
          if (!mm) continue;
          const [lo, hi] = yRange(g.m, mm[0]!, mm[1]!, mm[2]!, mm[3]!);
          if (pendingClip) {
            g.clip = [Math.max(g.clip[0], lo), Math.min(g.clip[1], hi)];
            pendingClip = false;
          }
          const stroke = op === OPS.stroke || op === OPS.closeStroke;
          const fill = op === OPS.fill || op === OPS.eoFill;
          const both = op === OPS.fillStroke || op === OPS.eoFillStroke || op === OPS.closeFillStroke || op === OPS.closeEOFillStroke;
          if ((fill && !isPaper(g.fill)) || (stroke && !isPaper(g.stroke)) || (both && !(isPaper(g.fill) && isPaper(g.stroke)))) mark(lo, hi, g.clip);
        } else if (fn === OPS.paintImageXObject || fn === OPS.paintInlineImageXObject || fn === OPS.paintImageMaskXObject) {
          const [lo, hi] = yRange(g.m, 0, 0, 1, 1);
          mark(lo, hi, g.clip);
          const inside = Math.min(hi, areaTop) - Math.max(lo, areaBottom) > 0.2;
          if (inside) images++;
          if (inside && (lo < areaBottom - 1 || hi > areaTop + 1)) cutImages++;
        }
      }
      const text = await page.getTextContent();
      let chars = 0;
      const strs: string[] = [];
      for (const it of text.items as { str?: string; transform?: number[]; height?: number }[]) {
        if (it.str) strs.push(it.str);
        const s = (it.str ?? '').replace(/\s+/g, '');
        if (!s || !it.transform) continue;
        chars += s.length;
        const h = it.height || Math.abs(it.transform[3] ?? 0);
        const base = it.transform[5]!;
        mark(base - h * 0.22, base + h * 0.8, [-Infinity, Infinity]);
      }
      out.push({ page: n, fill: lowest === Infinity ? 0 : Math.min(1, (areaTop - lowest) / (areaTop - areaBottom)), chars, text: strs.join(' '), cutImages, images });
      page.cleanup();
    }
  } finally {
    await doc.cleanup();
  }
  return out;
}
