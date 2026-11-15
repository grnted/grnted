// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Screenshots of elements for the contrast probes (Plan 4 Task 4.3): the in-page side (bring
// elements into view, measure their boxes, hide their text or icons and show them again) and the
// engine side (batches of elements per scroll position, one clipped screenshot per state).
// Engine core: no Node-only imports. Uses only `page.evaluate` and `page.screenshot` (PNG, clip),
// which @cloudflare/playwright also has.
import type { CDPSessionLike, PageLike } from '../types.js';
import { decodePng, type PxBox, type RgbaImage } from './pixels.js';

/** The in-page store of elements under test (an array on `window`), so the page never gets ids or marks until a screenshot needs them. */
export const SHOT_KEY = '__grntedShots';

/** [x, y, width, height] in CSS px, relative to the top-left of the viewport. */
export type CssBox = [number, number, number, number];

export interface ViewItem {
  ref: number;
  /** Visible parts (line boxes for text, the border box otherwise), clipped by every ancestor's overflow and by the viewport. */
  boxes: CssBox[];
  /** Part of the element's boxes that lies outside the viewport (0–1). */
  outside: number;
  /** The centre of its largest box shows another element (a fixed banner, an overlay). */
  covered: boolean;
  /**
   * Why nothing of it is in view: it has no boxes ('none'), it lies outside the page's scrollable area
   * (off-screen text: nobody sees it), or an ancestor's overflow or the viewport cuts it off ('clipped':
   * a slide of a carousel, a scrolled-away region).
   */
  cause?: 'none' | 'offpage' | 'clipped';
}

export interface ViewResult {
  /** Viewport size without scrollbars. */
  w: number;
  h: number;
  /** Where the viewport's top-left corner is in the document (CSS px): the page's scroll position. */
  sx: number;
  sy: number;
  items: ViewItem[];
}

/**
 * Runs in the page (self-contained). Scrolls the page so the store's element `first` is in view
 * (centred, then at the top or bottom when something fixed covers it there), and returns the visible boxes of the
 * elements `refs`: text line boxes (`mode: 'text'`, or the content box of form fields) or border boxes
 * (`mode: 'box'`). Elements in same-origin frames are measured in the top page's coordinates.
 */
export function viewElements(arg: { key: string; refs: number[]; first: number; mode: 'text' | 'box' }): ViewResult {
  const store = (window as unknown as Record<string, Element[] | undefined>)[arg.key] ?? [];
  const top = document.documentElement;
  const vw = top.clientWidth || window.innerWidth;
  const vh = top.clientHeight || window.innerHeight;
  type R = [number, number, number, number];
  const inter = (a: R, b: R): R | null => {
    const x = Math.max(a[0], b[0]);
    const y = Math.max(a[1], b[1]);
    const r = Math.min(a[0] + a[2], b[0] + b[2]);
    const btm = Math.min(a[1] + a[3], b[1] + b[3]);
    return r > x && btm > y ? [x, y, r - x, btm - y] : null;
  };
  const parentOf = (el: Element): Element | null => {
    if (el.parentElement) return el.parentElement;
    const root = el.getRootNode() as Node & { host?: Element };
    return root.host ?? null;
  };
  /** Offset of the element's frame in the top viewport, and the part of the viewport its frames show. */
  const frameOffset = (el: Element): { dx: number; dy: number; clip: R; ok: boolean } => {
    // The frame elements from the element's own frame out to the top page.
    const chain: Element[] = [];
    let win: Window | null = el.ownerDocument.defaultView;
    while (win && win !== window) {
      let fe: Element | null = null;
      try {
        fe = win.frameElement;
      } catch {
        fe = null;
      }
      if (!fe) return { dx: 0, dy: 0, clip: [0, 0, 0, 0], ok: false };
      chain.push(fe);
      win = fe.ownerDocument.defaultView;
    }
    let dx = 0;
    let dy = 0;
    let clip: R | null = [0, 0, vw, vh];
    // From the outermost frame in: each frame element's box is relative to the frame around it.
    for (let i = chain.length - 1; i >= 0 && clip; i--) {
      const fe = chain[i]!;
      const r = fe.getBoundingClientRect();
      const cs = getComputedStyle(fe);
      dx += r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
      dy += r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
      clip = inter(clip, [dx, dy, fe.clientWidth, fe.clientHeight]);
    }
    return { dx, dy, clip: clip ?? [0, 0, 0, 0], ok: true };
  };
  /** The part of `r` (in its own frame's viewport) not cut off by an ancestor's overflow. */
  const clipByAncestors = (el: Element, r: R): R | null => {
    let cur: R | null = r;
    for (let a = parentOf(el); a && cur; a = parentOf(a)) {
      if (a === a.ownerDocument.documentElement || a === a.ownerDocument.body) continue;
      const s = getComputedStyle(a);
      const cx = s.overflowX !== 'visible';
      const cy = s.overflowY !== 'visible';
      if (!cx && !cy) continue;
      const b = a.getBoundingClientRect();
      const bx = cx ? b.left + parseFloat(s.borderLeftWidth) : -1e9;
      const by = cy ? b.top + parseFloat(s.borderTopWidth) : -1e9;
      const bw = cx ? a.clientWidth : 2e9;
      const bh = cy ? a.clientHeight : 2e9;
      cur = inter(cur, [bx, by, bw, bh]);
    }
    return cur;
  };
  const rawBoxes = (el: Element): R[] => {
    const out: R[] = [];
    const add = (r: DOMRect) => {
      if (r.width >= 1 && r.height >= 1) out.push([r.left, r.top, r.width, r.height]);
    };
    if (arg.mode === 'box') {
      add(el.getBoundingClientRect());
      return out;
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      const l = parseFloat(s.borderLeftWidth) + parseFloat(s.paddingLeft);
      const t = parseFloat(s.borderTopWidth) + parseFloat(s.paddingTop);
      const w = r.width - l - parseFloat(s.borderRightWidth) - parseFloat(s.paddingRight);
      const h = r.height - t - parseFloat(s.borderBottomWidth) - parseFloat(s.paddingBottom);
      if (w >= 1 && h >= 1) out.push([r.left + l, r.top + t, w, h]);
      return out;
    }
    const doc = el.ownerDocument;
    const nodes: Text[] = [];
    for (const n of el.childNodes) if (n.nodeType === 3 && /\S/.test(n.nodeValue ?? '')) nodes.push(n as Text);
    if (!nodes.length) {
      const w = doc.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n = w.nextNode(); n && nodes.length < 40; n = w.nextNode()) if (/\S/.test(n.nodeValue ?? '')) nodes.push(n as Text);
    }
    for (const n of nodes.slice(0, 40)) {
      const range = doc.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects()) add(r);
    }
    return out;
  };
  const measure = (ref: number): ViewItem => {
    const el = store[ref];
    if (!el || !el.isConnected) return { ref, boxes: [], outside: 1, covered: false, cause: 'none' };
    const f = frameOffset(el);
    if (!f.ok) return { ref, boxes: [], outside: 1, covered: false, cause: 'none' };
    let total = 0;
    let shown = 0;
    const boxes: CssBox[] = [];
    const raw = rawBoxes(el);
    const doc: R = [-window.scrollX, -window.scrollY, Math.max(top.scrollWidth, vw), Math.max(top.scrollHeight, vh)];
    const onPage = raw.some((r) => inter([r[0] + f.dx, r[1] + f.dy, r[2], r[3]], doc));
    for (const r of raw) {
      const c = clipByAncestors(el, r);
      if (!c) continue;
      const moved: R = [c[0] + f.dx, c[1] + f.dy, c[2], c[3]];
      total += moved[2] * moved[3];
      const v = inter(moved, f.clip);
      if (!v || v[2] < 1 || v[3] < 1) continue;
      shown += v[2] * v[3];
      boxes.push([v[0], v[1], v[2], v[3]]);
    }
    let covered = false;
    const big = [...boxes].sort((a, b) => b[2] * b[3] - a[2] * a[3])[0];
    if (big && el.ownerDocument === document) {
      // Advisory only (it picks the scroll position): an element whose centre shows something else.
      const hit = document.elementFromPoint(big[0] + big[2] / 2, big[1] + big[3] / 2);
      covered = !!hit && hit !== el && !el.contains(hit) && !hit.contains(el);
    }
    const cause = boxes.length ? undefined : !raw.length ? 'none' as const : !onPage ? 'offpage' as const : 'clipped' as const;
    return { ref, boxes, outside: total > 0 ? Math.max(0, 1 - shown / total) : 1, covered, ...(cause ? { cause } : {}) };
  };
  const firstEl = store[arg.first];
  // Only the page (and a same-origin frame's own page) scrolls: scrolling regions inside it keep their
  // position, so a carousel never moves and what they hide stays hidden ('clipped').
  const scrollTo = (block: 'center' | 'start' | 'end') => {
    if (!firstEl) return;
    if (firstEl.ownerDocument !== document) {
      try {
        firstEl.scrollIntoView({ block, inline: 'nearest', behavior: 'instant' as ScrollBehavior });
      } catch {
        // keep the position
      }
      return;
    }
    const r = firstEl.getBoundingClientRect();
    const dy = block === 'center' ? r.top + r.height / 2 - vh / 2 : block === 'start' ? r.top - 8 : r.bottom - vh + 8;
    const dx = r.left < 0 ? r.left - 8 : r.right > vw ? Math.min(r.left - 8, r.right - vw + 8) : 0;
    window.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  };
  scrollTo('center');
  let probe = measure(arg.first);
  if (probe.covered) {
    for (const block of ['start', 'end'] as const) {
      scrollTo(block);
      probe = measure(arg.first);
      if (!probe.covered) break;
    }
    if (probe.covered) scrollTo('center');
  }
  const vv = window.visualViewport;
  return { w: vw, h: vh, sx: vv ? vv.pageLeft : window.scrollX, sy: vv ? vv.pageTop : window.scrollY, items: arg.refs.map(measure) };
}

/**
 * Runs in the page (self-contained). Waits, at most `maxMs`, for the pictures that can be behind
 * the store's elements `refs` to have loaded (or failed): every <img> (and <video> poster) whose box
 * meets the viewport area `clip`, and the CSS background images of the elements and of their
 * ancestors and pseudo-elements up to 6 levels. Scrolling to a batch can start lazy images, and a
 * phone width loads other sources: measured before they arrive, text sits on a placeholder instead
 * of the picture people see, so its contrast would depend on how fast the network was. True when
 * everything was there in time.
 */
export async function imagesReady(arg: { key: string; refs: number[]; clip: [number, number, number, number]; maxMs: number }): Promise<boolean> {
  const store = (window as unknown as Record<string, Element[] | undefined>)[arg.key] ?? [];
  const [cx, cy, cw, ch] = arg.clip;
  const frame = () => new Promise((resolve) => { requestAnimationFrame(() => requestAnimationFrame(resolve)); setTimeout(resolve, 100); });
  // Lazy loaders start on the next rendering update after the scroll (IntersectionObserver).
  await frame();
  const waits: Promise<unknown>[] = [];
  const meets = (r: DOMRect) => r.right > cx && r.left < cx + cw && r.bottom > cy && r.top < cy + ch && r.width > 0 && r.height > 0;
  for (const img of document.images) {
    if (img.complete || !meets(img.getBoundingClientRect())) continue;
    waits.push(new Promise((resolve) => { img.addEventListener('load', resolve, { once: true }); img.addEventListener('error', resolve, { once: true }); }));
  }
  const urls = new Set<string>();
  const add = (bg: string) => {
    for (const m of bg.matchAll(/url\(\s*(['"]?)(.*?)\1\s*\)/g)) if (m[2] && !m[2].startsWith('data:')) urls.add(m[2]);
  };
  for (const ref of arg.refs) {
    let el: Element | null = store[ref] ?? null;
    for (let depth = 0; el && depth < 6; depth++, el = el.parentElement) {
      if (el.ownerDocument !== document) break;
      add(getComputedStyle(el).backgroundImage);
      add(getComputedStyle(el, '::before').backgroundImage);
      add(getComputedStyle(el, '::after').backgroundImage);
    }
  }
  for (const url of [...urls].slice(0, 20)) {
    const im = new Image();
    im.src = url;
    // Shares the page's own request (or the cache): resolves when the picture can be drawn.
    waits.push(im.decode().catch(() => undefined));
  }
  if (!waits.length) return true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const done = await Promise.race([
    Promise.all(waits).then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), arg.maxMs); }),
  ]);
  clearTimeout(timer);
  // A picture that just arrived reaches the screen on the next frame.
  await frame();
  return done;
}

/**
 * Runs in the page (self-contained). Marks the store's elements for a screenshot state:
 * - 'text': the element's text becomes transparent (its colour, or its fill colour too when `fill`),
 *   text shadow and decoration included; descendants that inherit its colour follow it.
 * - 'black', 'white': the same text drawn in black or in white, without shadow: the two screenshots
 *   differ exactly where the letters are, by how much of each pixel they cover.
 * - 'icon': its icon (images, SVG, icon fonts, symbols; with `bg`, its own CSS background image; with
 *   `mask`, the element itself, which a CSS mask cuts to the icon's shape) is hidden.
 * - 'show': transitions stay off while the original colours return (so the next screenshot never
 *   catches a colour transition half way); 'drop' then removes every mark and style sheet.
 * Uses a constructed style sheet per document or shadow root, so nothing is added to the DOM tree
 * except a `data-grnted-px` attribute on the marked elements while the screenshots are taken.
 */
export function markElements(arg: { key: string; refs: { ref: number; fill?: boolean; bg?: boolean; mask?: boolean }[]; state: 'text' | 'black' | 'white' | 'icon' | 'show' | 'drop' }): MarkedState[] {
  const w = window as unknown as Record<string, unknown>;
  const store = (w[arg.key] as Element[] | undefined) ?? [];
  const sheetsKey = `${arg.key}Sheets`;
  const sheets = (w[sheetsKey] as Map<Document | ShadowRoot, CSSStyleSheet> | undefined) ?? new Map<Document | ShadowRoot, CSSStyleSheet>();
  w[sheetsKey] = sheets;
  const ATTR = 'data-grnted-px';
  // The text marks win over the page's own `!important` colours, even with ids in their selectors:
  // `:is()` takes the specificity of its most specific argument, here ids no element has.
  const BOOST = '#grnted-px-none#grnted-px-none#grnted-px-none#grnted-px-none#grnted-px-none';
  const on = (tokens: string, tail = '') => `:is(${tokens.split(' ').map((t) => `[${ATTR}~="${t}"]`).join('')}, ${BOOST})${tail}`;
  const CSS_TEXT = [
    `[${ATTR}], [${ATTR}] *, [${ATTR}]::before, [${ATTR}]::after, [${ATTR}] *::before, [${ATTR}] *::after { transition: none !important; }`,
    `${on('t')} { color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }`,
    `${on('k')} { color: #000 !important; text-shadow: none !important; text-decoration-color: #000 !important; caret-color: transparent !important; }`,
    `${on('w')} { color: #fff !important; text-shadow: none !important; text-decoration-color: #fff !important; caret-color: transparent !important; }`,
    `${on('t f')} { -webkit-text-fill-color: transparent !important; -webkit-text-stroke-color: transparent !important; fill: transparent !important; fill-opacity: 1 !important; }`,
    `${on('k f')} { -webkit-text-fill-color: #000 !important; -webkit-text-stroke-color: #000 !important; fill: #000 !important; fill-opacity: 1 !important; }`,
    `${on('w f')} { -webkit-text-fill-color: #fff !important; -webkit-text-stroke-color: #fff !important; fill: #fff !important; fill-opacity: 1 !important; }`,
    // Descendants with a colour of their own (a span set to white inside the paragraph axe named) follow too.
    `${on('t', ' *')} { color: transparent !important; -webkit-text-fill-color: transparent !important; -webkit-text-stroke-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; }`,
    `${on('k', ' *')} { color: #000 !important; -webkit-text-fill-color: #000 !important; -webkit-text-stroke-color: #000 !important; text-shadow: none !important; text-decoration-color: #000 !important; }`,
    `${on('w', ' *')} { color: #fff !important; -webkit-text-fill-color: #fff !important; -webkit-text-stroke-color: #fff !important; text-shadow: none !important; text-decoration-color: #fff !important; }`,
    `[${ATTR}~="i"] { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; }`,
    `[${ATTR}~="i"] *, [${ATTR}~="i"]::before, [${ATTR}~="i"]::after { visibility: hidden !important; }`,
    `img[${ATTR}~="i"], input[${ATTR}~="i"] { object-position: -99999px -99999px !important; }`,
    `[${ATTR}~="b"] { background-image: none !important; }`,
    `[${ATTR}~="m"] { visibility: hidden !important; }`,
  ].join('\n');
  const sheetFor = (el: Element) => {
    const root = el.getRootNode() as (Document | ShadowRoot) & Node;
    if (!('adoptedStyleSheets' in root) || sheets.has(root)) return;
    try {
      // The sheet must come from the root's own window (same-origin frames have their own).
      const doc = root.ownerDocument ?? (root as Document);
      const win = (doc.defaultView ?? window) as Window & typeof globalThis;
      const sheet = new win.CSSStyleSheet();
      sheet.replaceSync(CSS_TEXT);
      root.adoptedStyleSheets = [...root.adoptedStyleSheets, sheet];
      sheets.set(root, sheet);
    } catch {
      // A root that cannot adopt the sheet: its elements keep their look (the screenshots then show no change).
    }
  };
  if (arg.state === 'drop') {
    for (const el of store) el?.removeAttribute?.(ATTR);
    for (const [root, sheet] of sheets) {
      try {
        root.adoptedStyleSheets = root.adoptedStyleSheets.filter((s) => s !== sheet);
      } catch {
        // gone
      }
    }
    sheets.clear();
    delete w[sheetsKey];
    delete w[arg.key];
    return [];
  }
  for (const r of arg.refs) {
    const el = store[r.ref];
    if (!el || !el.isConnected) continue;
    if (arg.state === 'show') {
      if (el.hasAttribute(ATTR)) el.setAttribute(ATTR, 'x');
      continue;
    }
    sheetFor(el);
    const token = arg.state === 'text' ? 't' : arg.state === 'black' ? 'k' : arg.state === 'white' ? 'w' : '';
    el.setAttribute(ATTR, token ? (r.fill ? `${token} f` : token) : `i${r.bg ? ' b' : ''}${r.mask ? ' m' : ''}`);
  }
  // Apply the styles now (and, for 'show', return to the original colours with transitions still off).
  for (const r of arg.refs) {
    const el = store[r.ref];
    if (el?.isConnected) void getComputedStyle(el).color;
  }
  if (arg.state === 'show') {
    for (const r of arg.refs) store[r.ref]?.removeAttribute(ATTR);
  }
  // The element whose style draws the text: the element itself when it has text of its own, else the
  // parent of its first text (as `locateTexts` reads it).
  const holder = (el: Element): Element => {
    for (const n of el.childNodes) if (n.nodeType === 3 && /\S/.test(n.nodeValue ?? '')) return el;
    const tw = el.ownerDocument.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = tw.nextNode(); n; n = tw.nextNode()) if (/\S/.test(n.nodeValue ?? '') && n.parentElement) return n.parentElement;
    return el;
  };
  // The text's opacity and colours now (after 'show': as the next screenshot shows them).
  return arg.refs.map((r) => {
    const own = store[r.ref];
    if (!own?.isConnected) return null;
    const el = holder(own);
    let opacity = 1;
    for (let a: Element | null = el; a;) {
      opacity *= parseFloat(getComputedStyle(a).opacity) || 0;
      const root = a.getRootNode() as Node & { host?: Element };
      let up: Element | null = a.parentElement ?? root.host ?? null;
      if (!up) {
        try {
          up = a.ownerDocument.defaultView?.frameElement ?? null;
        } catch {
          up = null;
        }
      }
      a = up;
    }
    const st = getComputedStyle(el);
    // Text in SVG is painted by its fill (batch 18, round 3: text contrast trusts the colour it read only while this
    // matches it; reading `color` there distrusted every SVG text's fill and measured it from anti-aliased pixels).
    return { opacity: Math.round(opacity * 1000) / 1000, color: `${el instanceof SVGElement ? st.fill : st.color}|${st.webkitTextFillColor}` };
  });
}

/** An element's opacity (with its ancestors') and text colours, as `markElements` reads them. */
export type MarkedState = { opacity: number; color: string } | null;

/** A clip rectangle around boxes, with a margin, inside the viewport; null when nothing is left. */
export function clipAround(boxes: readonly CssBox[], view: { w: number; h: number }, margin = 4): CssBox | null {
  if (!boxes.length) return null;
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y, w, h] of boxes) {
    x0 = Math.min(x0, x);
    y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w);
    y1 = Math.max(y1, y + h);
  }
  x0 = Math.max(0, Math.floor(x0 - margin));
  y0 = Math.max(0, Math.floor(y0 - margin));
  x1 = Math.min(view.w, Math.ceil(x1 + margin));
  y1 = Math.min(view.h, Math.ceil(y1 + margin));
  return x1 - x0 >= 1 && y1 - y0 >= 1 ? [x0, y0, x1 - x0, y1 - y0] : null;
}

/** Boxes in CSS px (viewport) as boxes in the pixels of a screenshot clipped to `clip`. */
export function toImageBoxes(boxes: readonly CssBox[], clip: CssBox, img: { width: number; height: number }): PxBox[] {
  const sx = img.width / clip[2];
  const sy = img.height / clip[3];
  return boxes.map(([x, y, w, h]) => [(x - clip[0]) * sx, (y - clip[1]) * sy, w * sx, h * sy] as const);
}

/** Boxes overlap (or touch within `gap` px). */
export function overlaps(a: readonly CssBox[], b: readonly CssBox[], gap = 2): boolean {
  return a.some(([ax, ay, aw, ah]) => b.some(([bx, by, bw, bh]) => ax < bx + bw + gap && bx < ax + aw + gap && ay < by + bh + gap && by < ay + ah + gap));
}

/**
 * How to take a batch's screenshots fast: the run's CDP session (`ProbeContext.cdp`) and where the
 * viewport is in the document (`ViewResult.sx`, `sy`), which CDP's clip is relative to.
 */
export interface ShotVia {
  cdp?: CDPSessionLike;
  at?: { x: number; y: number };
}

/** Sessions whose browser refused `optimizeForSpeed`. */
const noFastPng = new WeakSet<CDPSessionLike>();

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * A PNG screenshot of a viewport area, decoded. With a CDP session and the scroll position (`via`) it
 * is one `Page.captureScreenshot` call (the clip in document coordinates, as Playwright sends it, PNG
 * encoded for speed, still lossless); Playwright's `page.screenshot` makes several calls into every
 * frame of the page around the same capture, each a round trip to a remote browser. Without them, or
 * when the session gives no image, it is `page.screenshot`. Both give the same pixels.
 */
export async function shoot(page: PageLike, clip: CssBox, via?: ShotVia): Promise<RgbaImage> {
  if (via?.cdp && via.at) {
    const cdp = via.cdp;
    const params = {
      format: 'png', clip: { x: via.at.x + clip[0], y: via.at.y + clip[1], width: clip[2], height: clip[3], scale: 1 },
      captureBeyondViewport: false, fromSurface: true,
    };
    const take = async (fast: boolean): Promise<unknown> => {
      try {
        return ((await cdp.send('Page.captureScreenshot', fast ? { ...params, optimizeForSpeed: true } : params)) as { data?: unknown } | undefined)?.data;
      } catch {
        return undefined;
      }
    };
    // A browser that does not know `optimizeForSpeed` (older than Chrome 117) is asked without it.
    const slow = noFastPng.has(cdp);
    let data = await take(!slow);
    if ((typeof data !== 'string' || !data) && !slow) {
      data = await take(false);
      if (typeof data === 'string' && data) noFastPng.add(cdp);
    }
    if (typeof data === 'string' && data) return decodePng(fromBase64(data));
  }
  const bytes = await page.screenshot({ type: 'png', clip: { x: clip[0], y: clip[1], width: clip[2], height: clip[3] } });
  return decodePng(bytes);
}

/** Largest clip area screenshotted at once (CSS px²); a batch never grows beyond it. */
export const MAX_CLIP_AREA = 1280 * 900;

/**
 * The elements to screenshot together: the first one (scrolled into view; it may be taller than the
 * viewport) and every other element entirely in view that does not overlap one already taken, up to
 * MAX_CLIP_AREA. `gone`: the first one when nothing of it is in view.
 */
export function pickBatch(items: readonly ViewItem[], view: { w: number; h: number }, margin = 4): { batch: ViewItem[]; clip: CssBox | null; gone?: ViewItem } {
  const batch: ViewItem[] = [];
  let clip: CssBox | null = null;
  for (const [i, it] of items.entries()) {
    if (!it.boxes.length) {
      if (i === 0) return { batch, clip, gone: it };
      continue;
    }
    if (i > 0 && it.outside > 0.01) continue;
    if (batch.some((b) => overlaps(b.boxes, it.boxes, margin))) continue;
    const next = clipAround([...batch.flatMap((b) => b.boxes), ...it.boxes], view, margin);
    if (!next) continue;
    if (i > 0 && next[2] * next[3] > MAX_CLIP_AREA) continue;
    batch.push(it);
    clip = next;
  }
  return { batch, clip };
}

export interface BatchOptions {
  mode: 'text' | 'box';
  /** Pixels kept around the boxes in each screenshot (and between elements of one batch). */
  margin: number;
  deadline: number;
  /** Time kept back from the deadline to report what was measured. */
  reserveMs: number;
  signal: AbortSignal;
  /**
   * Most batches (scroll positions measured): a fixed number, so which elements are measured never
   * depends on how fast the browser is. Elements past it are left (`BatchResult.cut` 'limit').
   */
  maxBatches?: number;
}

export interface BatchResult {
  /** Refs not measured, in order. */
  left: number[];
  /** Why some were left: the batch limit ('limit'), or the time ('time': stopped, or no room for one more batch). */
  cut?: 'limit' | 'time';
  /** Batches measured. */
  batches: number;
}

/**
 * Goes through the store's elements `refs` (in that order) a batch at a time: scrolls the first
 * pending one into view, takes every pending element in view that fits (`pickBatch`) and calls
 * `measure` with them, the clip to screenshot and the scroll position. An element with nothing in
 * view goes to `gone` with the cause. Stops after `maxBatches` batches, and before a batch that
 * would not fit the time left (as long as the longest batch so far, before the reserve), so a slow
 * browser stops in time instead of being cut off mid-batch.
 */
export async function eachBatch(
  page: PageLike,
  refs: readonly number[],
  opts: BatchOptions,
  measure: (batch: ViewItem[], clip: CssBox, at: { x: number; y: number }) => Promise<void>,
  gone: (ref: number, cause: ViewItem['cause']) => void,
): Promise<BatchResult> {
  let pending = [...refs];
  let batches = 0;
  let longest = 0;
  while (pending.length) {
    if (opts.maxBatches !== undefined && batches >= opts.maxBatches) return { left: pending, cut: 'limit', batches };
    if (opts.signal.aborted || Date.now() + longest >= opts.deadline - opts.reserveMs) return { left: pending, cut: 'time', batches };
    const t0 = Date.now();
    const view = await page.evaluate(viewElements, { key: SHOT_KEY, refs: pending, first: pending[0]!, mode: opts.mode });
    const { batch, clip, gone: first } = pickBatch(view.items, view, opts.margin);
    if (first || !batch.length || !clip) {
      const ref = first?.ref ?? pending[0]!;
      gone(ref, first?.cause ?? 'clipped');
      pending = pending.filter((r) => r !== ref);
      continue;
    }
    await measure(batch, clip, { x: view.sx, y: view.sy });
    batches++;
    longest = Math.max(longest, Date.now() - t0);
    const done = new Set(batch.map((b) => b.ref));
    pending = pending.filter((r) => !done.has(r));
  }
  return { left: pending, batches };
}
