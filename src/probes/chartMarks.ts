// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.11 Non-text contrast for the data of a chart (batch 18, visual lane, D12; docs/atlas/visual.md). "Graphical
// objects: parts of graphics required to understand the content" need 3:1 against adjacent colours. In a chart the
// data series is that part: a line, the bars, the area. Gridlines and axes are not the data. Read from the page's
// own SVG (no screenshots), and only where it leaves no doubt:
// - a chart: an inline SVG at least 120 x 80 px with axis evidence, three or more tick labels (numbers, years,
//   months, quarters) in its own text or in the figure around it; an SVG with none is a picture or decoration;
// - a series: a path or polyline with a stroke and no fill whose points are not on one straight line (three or more),
//   a filled non-rectangular path (an area), or three or more rectangles of one fill that differ in length (bars);
//   straight two-point lines and rectangles as large as the plot are grid, axes and background;
// - its colour: the stroke or fill, with its opacity, composited over the backdrop behind the SVG (the SVG's own
//   full-size background rectangle included); a gradient or pattern is not decided;
// - the information is available otherwise, so no failure: a data label (a number) for every point or bar, markers on
//   the points with 3:1, or a visible table with numbers in the same figure, section or card.
// A series under 3:1 against the plot with none of those fails. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

/** Charts and series read per page, at most. */
export const CHART_LIMITS = { charts: 12, series: 6 } as const;

export interface FaintSeries {
  /** CSS path of the chart (its svg). */
  path: string;
  /** The chart's name (aria-label, title, figcaption), at most 60 characters. */
  name: string;
  kind: 'line' | 'bars' | 'area';
  colour: string;
  backdrop: string;
  ratio: number;
}

/**
 * Runs in the page (self-contained). Series of inline SVG charts under 3:1 against their plot whose values are not
 * given in text nearby (see the file comment). At most `max` charts are read.
 */
export function faintChartSeries(arg: { max: number; series: number }): FaintSeries[] {
  const out: FaintSeries[] = [];
  // Every CSS colour the browser computes (oklch, lab, color(display-p3 …) included) read as sRGB through a 1x1 canvas;
  // a value the canvas does not take is not decided (null).
  const cvs = document.createElement('canvas');
  cvs.width = 1;
  cvs.height = 1;
  const g2 = cvs.getContext('2d', { willReadFrequently: true });
  const memo = new Map<string, [number, number, number, number] | null>();
  const rgb = (c: string): [number, number, number, number] | null => {
    if (!c || c === 'none' || /url\(|gradient\(/.test(c)) return null;
    const hit = memo.get(c);
    if (hit !== undefined) return hit;
    let v: [number, number, number, number] | null = null;
    if (g2) {
      g2.fillStyle = '#010203';
      g2.fillStyle = c;
      if (g2.fillStyle !== '#010203' || /^#010203$/i.test(c.trim())) {
        g2.clearRect(0, 0, 1, 1);
        g2.fillRect(0, 0, 1, 1);
        const d = g2.getImageData(0, 0, 1, 1).data;
        v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      }
    }
    memo.set(c, v);
    return v;
  };
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const ratio = (a: number[], b: number[]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (top: number[], a: number, back: number[]) => [top[0]! * a + back[0]! * (1 - a), top[1]! * a + back[1]! * (1 - a), top[2]! * a + back[2]! * (1 - a)];
  const hex = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  // Batch 18, round 2: open shadow roots too (a web component's charts are the page's): matches in the document, then
  // in each open shadow root, and a path through a shadow root names its host first ("host >>> inner").
  const deepQuery = (sel: string): Element[] => {
    const found: Element[] = [];
    const visit = (root: Document | ShadowRoot, depth: number) => {
      found.push(...Array.from(root.querySelectorAll(sel)));
      if (depth > 6) return;
      for (const h of Array.from(root.querySelectorAll('*'))) if (h.shadowRoot) visit(h.shadowRoot, depth + 1);
    };
    visit(document, 0);
    return found;
  };
  const upOf = (e: Element): Element | null => e.parentElement ?? ((e.getRootNode() as ShadowRoot).host ?? null);
  /** What is behind the SVG, composited from the outermost in; null when a picture, gradient or filter is in the way. */
  const backdropOf = (el: Element): number[] | null => {
    const chain: Element[] = [];
    for (let e: Element | null = upOf(el); e; e = upOf(e)) chain.unshift(e);
    let c = [255, 255, 255];
    for (const e of chain) {
      const cs = getComputedStyle(e);
      if (cs.backgroundImage !== 'none' || (cs.filter && cs.filter !== 'none') || cs.mixBlendMode !== 'normal') return null;
      const bg = rgb(cs.backgroundColor);
      if (bg && bg[3] > 0) c = over(bg, bg[3], c);
    }
    return c;
  };
  const opacityOf = (el: Element, stop: Element) => {
    let o = 1;
    for (let e: Element | null = el; e && e !== stop.parentElement; e = e.parentElement) o *= Number(getComputedStyle(e).opacity) || (getComputedStyle(e).opacity === '0' ? 0 : 1);
    return o;
  };
  const TICK = /^[-+−]?[$€£]?\s?\d[\d,.\s]*\s?(%|k|m|bn|°[cf]?)?$|^(19|20)\d\d$|^(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?(\s+(19|20)?\d\d)?$|^q[1-4](\s+(19|20)?\d\d)?$|^(fy|week|wk|day)\s?\d+$/i;
  const NUMBER = /^[-+−]?[$€£]?\s?\d[\d,.\s]*\s?(%|k|m|bn)?$/i;
  const texts = (root: Element) => Array.from(root.querySelectorAll('text, tspan')).map((t) => (t.textContent ?? '').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
      if (cur.id && (cur.getRootNode() as Document | ShadowRoot).querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const deepPath = (el: Element): string => {
    const segs: string[] = [];
    for (let e: Element | null = el; e; ) {
      segs.unshift(cssPath(e));
      const r = e.getRootNode();
      e = r instanceof ShadowRoot ? r.host : null;
    }
    return segs.join(' >>> ');
  };
  /** Points along a geometry element (screen px), at most 24. */
  const pointsOf = (g: SVGGeometryElement): DOMPoint[] => {
    const pts: DOMPoint[] = [];
    try {
      const ctm = g.getScreenCTM();
      if (g.localName === 'polyline' || g.localName === 'polygon') {
        const list = (g as SVGPolylineElement).points;
        for (let i = 0; i < list.numberOfItems && pts.length < 200; i++) {
          const p = list.getItem(i);
          pts.push(ctm ? new DOMPoint(p.x, p.y).matrixTransform(ctm) : new DOMPoint(p.x, p.y));
        }
        return pts;
      }
      const len = g.getTotalLength();
      if (!(len > 0)) return pts;
      for (let i = 0; i <= 23; i++) {
        const p = g.getPointAtLength((len * i) / 23);
        pts.push(ctm ? new DOMPoint(p.x, p.y).matrixTransform(ctm) : new DOMPoint(p.x, p.y));
      }
    } catch {
      // not a geometry the browser can measure
    }
    return pts;
  };
  const bent = (pts: DOMPoint[]) => {
    if (pts.length < 3) return false;
    const a = pts[0]!;
    // The point farthest from the first (a closed outline ends where it starts).
    const b = pts.reduce((far, p) => (Math.hypot(p.x - a.x, p.y - a.y) > Math.hypot(far.x - a.x, far.y - a.y) ? p : far), a);
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    if (len < 20) return false;
    return pts.some((p) => Math.abs((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len > 2);
  };
  /** An L of axes in the SVG (see the caller). */
  const axesL = (svg: SVGSVGElement, box: DOMRect): boolean => {
    const h: { y: number; x0: number; x1: number }[] = [];
    const v: { x: number; y0: number; y1: number }[] = [];
    for (const g of Array.from(svg.querySelectorAll('path, line, polyline')) as SVGGeometryElement[]) {
      const st = getComputedStyle(g);
      if (!st.stroke || st.stroke === 'none' || (parseFloat(st.strokeWidth) || 0) <= 0) continue;
      const pts = pointsOf(g);
      if (g.localName === 'line') {
        const l = g as SVGLineElement;
        const ctm = l.getScreenCTM();
        const a = new DOMPoint(l.x1.baseVal.value, l.y1.baseVal.value).matrixTransform(ctm ?? undefined);
        const b = new DOMPoint(l.x2.baseVal.value, l.y2.baseVal.value).matrixTransform(ctm ?? undefined);
        pts.splice(0, pts.length, a, b);
      }
      if (pts.length < 2) continue;
      // Points on a horizontal stroke and on a vertical one (a path may draw both).
      const ys = pts.map((p) => Math.round(p.y));
      const xs = pts.map((p) => Math.round(p.x));
      const yMax = Math.max(...ys);
      const xMin = Math.min(...xs);
      const onH = pts.filter((p) => Math.abs(p.y - yMax) <= 1.5);
      const onV = pts.filter((p) => Math.abs(p.x - xMin) <= 1.5);
      if (onH.length + onV.length < pts.length) continue;
      if (onH.length >= 2) h.push({ y: yMax, x0: Math.min(...onH.map((p) => p.x)), x1: Math.max(...onH.map((p) => p.x)) });
      if (onV.length >= 2) v.push({ x: xMin, y0: Math.min(...onV.map((p) => p.y)), y1: Math.max(...onV.map((p) => p.y)) });
    }
    return h.some((a) => a.x1 - a.x0 >= 0.5 * box.width && v.some((b) => b.y1 - b.y0 >= 0.5 * box.height && Math.abs(b.x - a.x0) <= 6 && Math.abs(b.y1 - a.y) <= 6));
  };
  const svgs = (deepQuery('svg') as SVGSVGElement[]).filter((s) => !s.parentElement?.closest('svg'));
  let read = 0;
  for (const svg of svgs) {
    if (read >= arg.max || out.length >= arg.max) break;
    const box = svg.getBoundingClientRect();
    const cs = getComputedStyle(svg);
    if (box.width < 120 || box.height < 80 || cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) < 0.1) continue;
    const holder = svg.closest('figure, section, article, [role="region"], [role="figure"], .card') ?? svg.parentElement ?? svg;
    const own = texts(svg);
    const around = holder !== svg ? Array.from(holder.querySelectorAll('span, div, li, p, td, th, small')).filter((e) => !svg.contains(e) && e.children.length === 0)
      .map((e) => (e.textContent ?? '').trim()).filter(Boolean) : [];
    const ticks = [...own, ...around].filter((t) => t.length <= 16 && TICK.test(t)).length;
    // Axis evidence: three tick labels, or a named chart (role img or a figure) drawn on an L of axes: a horizontal and a
    // vertical straight stroke, each across half the plot or more, meeting at a corner.
    const named = svg.getAttribute('role') === 'img' || !!svg.closest('figure, [role="figure"]');
    if (ticks < 3 && !(named && axesL(svg, box))) continue;
    read++;
    // Information given in text nearby: a table with numbers in the same holder.
    const table = Array.from(holder.querySelectorAll('table')).some((t) => {
      const r = t.getBoundingClientRect();
      const tc = getComputedStyle(t);
      return r.width > 10 && r.height > 10 && tc.visibility !== 'hidden' && Array.from(t.querySelectorAll('td')).filter((td) => /\d/.test(td.textContent ?? '')).length >= 2;
    });
    if (table) continue;
    // Numbers drawn in the SVG, by where they sit (data labels sit among the marks; tick labels sit beside the plot).
    const numberAt = Array.from(svg.querySelectorAll('text')).filter((t) => NUMBER.test((t.textContent ?? '').replace(/\s+/g, ' ').trim()))
      .map((t) => {
        const r = t.getBoundingClientRect();
        return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
      });
    const labelsIn = (b: { l: number; t: number; r: number; b: number }) => numberAt.filter((p) => p.x >= b.l + 4 && p.x <= b.r && p.y >= b.t - 18 && p.y <= b.b - 4).length;
    // The plot's backdrop: the SVG's own full-size background shape, else what is behind the SVG. A picture, gradient or
    // filter behind or on the SVG leaves the chart undecided (Sol r1, finding 6).
    const behind = backdropOf(svg);
    if (!behind || cs.backgroundImage !== 'none' || (cs.filter && cs.filter !== 'none')) continue;
    let backdrop = behind;
    const svgBg = rgb(cs.backgroundColor);
    if (svgBg && svgBg[3] > 0) backdrop = over(svgBg, svgBg[3], backdrop);
    const area = box.width * box.height;
    const shapes = Array.from(svg.querySelectorAll('path, polyline, polygon, rect, line, circle, ellipse')) as SVGGeometryElement[];
    for (const sh of shapes) {
      if (sh.localName !== 'rect') continue;
      const r = sh.getBoundingClientRect();
      const fill = rgb(getComputedStyle(sh).fill);
      if (fill && r.width * r.height >= 0.5 * area && fill[3] > 0) backdrop = over(fill, fill[3] * opacityOf(sh, svg), backdrop);
    }
    const label = (svg.getAttribute('aria-label') || svg.querySelector('title')?.textContent || holder.querySelector('figcaption, h2, h3, h4')?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    type Cand = { kind: FaintSeries['kind']; colour: number[]; ratio: number; points: number; box: { l: number; t: number; r: number; b: number }; pts?: DOMPoint[] };
    const boxOfPts = (pts: DOMPoint[]) => ({ l: Math.min(...pts.map((p) => p.x)), t: Math.min(...pts.map((p) => p.y)), r: Math.max(...pts.map((p) => p.x)), b: Math.max(...pts.map((p) => p.y)) });
    const cands: Cand[] = [];
    const markers = shapes.filter((s) => s.localName === 'circle' || s.localName === 'ellipse');
    const bars = new Map<string, { colour: number[]; list: SVGGeometryElement[] }>();
    // Shapes drawn through <use> (Sol r1, F3): the referenced geometry placed by the use, painted with what the use passes
    // down (unless the shape sets its own paint). Shapes inside defs, symbols, masks and markers are not drawn themselves.
    const uses = Array.from(svg.querySelectorAll('use')).flatMap((u) => {
      const href = u.getAttribute('href') ?? u.getAttribute('xlink:href') ?? '';
      const ref = href.startsWith('#') ? svg.ownerDocument.getElementById(href.slice(1)) : null;
      return ref && /^(path|polyline|polygon)$/.test(ref.localName) ? [{ u, ref: ref as unknown as SVGGeometryElement }] : [];
    });
    const usePoints = (u: SVGUseElement, ref: SVGGeometryElement): DOMPoint[] => {
      const out: DOMPoint[] = [];
      try {
        const ctm = u.getScreenCTM();
        const dx = u.x.baseVal.value;
        const dy = u.y.baseVal.value;
        const len = ref.getTotalLength();
        if (!(len > 0) || !ctm) return out;
        for (let i = 0; i <= 23; i++) {
          const q = ref.getPointAtLength((len * i) / 23);
          out.push(new DOMPoint(q.x + dx, q.y + dy).matrixTransform(ctm));
        }
      } catch {
        // not measurable
      }
      return out;
    };
    for (const { u, ref } of uses) {
      const us = getComputedStyle(u);
      if (us.display === 'none' || us.visibility === 'hidden') continue;
      const own = (k: 'stroke' | 'fill') => ref.getAttribute(k) ?? (ref as unknown as HTMLElement).style?.getPropertyValue(k);
      const stroke = rgb(own('stroke') || us.stroke);
      const fill = rgb(own('fill') || us.fill);
      const sw = parseFloat(ref.getAttribute('stroke-width') ?? '') || parseFloat(us.strokeWidth) || 0;
      const pts = usePoints(u as SVGUseElement, ref);
      if (!bent(pts) || !stroke || sw <= 0 || (fill && fill[3]! >= 0.05)) continue;
      const a = stroke[3]! * opacityOf(u, svg);
      if (a < 0.1) continue;
      const c = over(stroke, a, backdrop);
      cands.push({ kind: 'line', colour: c, ratio: ratio(c, backdrop), points: 0, box: boxOfPts(pts), pts });
    }
    for (const sh of shapes) {
      if (sh.closest('defs, symbol, clipPath, mask, marker, pattern')) continue;
      const st = getComputedStyle(sh);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const r = sh.getBoundingClientRect();
      const op = opacityOf(sh, svg);
      // A rectangle drawn as a path (break-it V6) is a bar like a rect.
      const rectPath = sh.localName === 'path' && !/[aAcCqQsStT]/.test(sh.getAttribute('d') ?? '') && (() => {
        const p = pointsOf(sh);
        if (p.length < 4) return false;
        const xs = p.map((q) => q.x);
        const ys = p.map((q) => q.y);
        const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
        return p.every((q) => Math.abs(q.x - x0) <= 1 || Math.abs(q.x - x1) <= 1 || Math.abs(q.y - y0) <= 1 || Math.abs(q.y - y1) <= 1);
      })();
      if (sh.localName === 'rect' || rectPath) {
        if (r.width * r.height >= 0.5 * area || r.width < 3 || r.height < 3) continue;
        const fill = rgb(st.fill);
        if (!fill || fill[3] * Number(st.fillOpacity || 1) * op < 0.1) continue;
        const colour = over(fill, fill[3] * Number(st.fillOpacity || 1) * op, backdrop);
        const key = hex(colour);
        const entry = bars.get(key) ?? { colour, list: [] };
        entry.list.push(sh);
        bars.set(key, entry);
        continue;
      }
      if (sh.localName === 'circle' || sh.localName === 'ellipse' || sh.localName === 'line') continue;
      const stroke = rgb(st.stroke);
      const fill = rgb(st.fill);
      const sw = parseFloat(st.strokeWidth) || 0;
      const pts = pointsOf(sh);
      if (!bent(pts)) continue;
      if (stroke && sw > 0 && (!fill || fill[3] * Number(st.fillOpacity || 1) < 0.05)) {
        const a = stroke[3] * Number(st.strokeOpacity || 1) * op;
        if (a < 0.1) continue;
        const c = over(stroke, a, backdrop);
        cands.push({ kind: 'line', colour: c, ratio: ratio(c, backdrop), points: sh.localName === 'polyline' ? pts.length : 0, box: boxOfPts(pts), pts });
      } else if (fill && fill[3] * Number(st.fillOpacity || 1) * op >= 0.1 && !/[aA]/.test(sh.getAttribute('d') ?? '')) {
        const c = over(fill, fill[3] * Number(st.fillOpacity || 1) * op, backdrop);
        // An area under a line drawn in a stronger colour: the line carries the data.
        cands.push({ kind: 'area', colour: c, ratio: ratio(c, backdrop), points: 0, box: boxOfPts(pts) });
      }
    }
    for (const { colour: c, list } of bars.values()) {
      if (list.length < 3) continue;
      const rs = list.map((b) => b.getBoundingClientRect());
      const lengths = new Set(rs.map((r) => Math.round(r.height)));
      const widths = new Set(rs.map((r) => Math.round(r.width)));
      if (lengths.size < 2 && widths.size < 2) continue;
      const box = { l: Math.min(...rs.map((r) => r.left)), t: Math.min(...rs.map((r) => r.top)), r: Math.max(...rs.map((r) => r.right)), b: Math.max(...rs.map((r) => r.bottom)) };
      cands.push({ kind: 'bars', colour: c, ratio: ratio(c, backdrop), points: list.length, box });
    }
    // Several filled shapes that are not bars are regions (a map, a diagram, a pie), unless they all span the same width
    // (stacked areas over one axis; Sol r1, F4): then they are series.
    const areas = cands.filter((c) => c.kind === 'area');
    const stacked = areas.length > 2 && areas.every((a) => Math.abs(a.box.l - areas[0]!.box.l) <= 6 && Math.abs(a.box.r - areas[0]!.box.r) <= 6);
    if (areas.length > 2 && !stacked) for (let k = cands.length - 1; k >= 0; k--) if (cands[k]!.kind === 'area') cands.splice(k, 1);
    if (!cands.length) continue;
    // A line of 3:1 or more carries an area's data only when it draws that area's top edge (Sol r1, finding 11).
    const outlines = (a: Cand) => cands.some((l) => l.kind === 'line' && l.ratio >= 3 && Math.abs(l.box.l - a.box.l) <= 6 && Math.abs(l.box.r - a.box.r) <= 6 && Math.abs(l.box.t - a.box.t) <= 4);
    for (const c of cands.slice(0, arg.series)) {
      if (c.ratio >= 3 || (c.kind === 'area' && outlines(c))) continue;
      // Data labels: numbers drawn among the marks, one for most points or bars (three at least).
      if (labelsIn(c.box) >= Math.max(3, Math.ceil(0.6 * (c.kind === 'bars' ? c.points : Math.min(c.points || 3, 24))))) continue;
      // Markers with 3:1 on the series' own points (a circle elsewhere is decoration or a legend; Sol r1, finding 11).
      const marked = markers.filter((m) => {
        const f = rgb(getComputedStyle(m).fill);
        const r = m.getBoundingClientRect();
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        const onLine = (c.pts ?? []).some((p) => Math.hypot(p.x - cx, p.y - cy) <= 6);
        return !!f && f[3]! > 0.5 && ratio(over(f, f[3]!, backdrop), backdrop) >= 3 && r.width >= 3 && onLine;
      }).length;
      if (c.kind === 'line' && marked >= 3) continue;
      out.push({ path: deepPath(svg), name: label, kind: c.kind, colour: hex(c.colour), backdrop: hex(backdrop), ratio: Math.round(c.ratio * 100) / 100 });
      break;
    }
  }
  return out;
}

const KIND_WORDS: Record<FaintSeries['kind'], string> = { line: 'data line', bars: 'bars', area: 'filled area' };

/** The 1.4.11 findings for faint chart series (one per chart). */
export function chartSeriesFindings(list: readonly FaintSeries[]): ProbeFinding[] {
  return list.map((s) => ({
    criterion: '1.4.11', status: 'failed' as const, target: s.path,
    detail: `The ${KIND_WORDS[s.kind]} of the chart${s.name ? ` “${s.name}”` : ''} ${s.kind === 'bars' ? 'are' : 'is'} drawn in ${s.colour} on ${s.backdrop} (${s.ratio.toFixed(1)}:1): `
      + 'the data of a chart needs at least 3:1 against what is next to it, and its values are not given as text beside it (data labels or a table).',
  }));
}
