// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page-load pop-ups (a cookie banner, a newsletter sign-up, a news alert, a chat invite) and the tests that
// measure the page behind them: text contrast (1.4.3), non-text contrast (1.4.11) and reflow (1.4.10). The
// 2026-11-07 accuracy audit (docs/accuracy-audit-2026-11-07.md, cause 6) found those tests measuring a page
// dimmed to 20% by a pop-up's backdrop (white text read as #3c3c3c) and a pop-up's paragraph "overlapping" the
// header under it at 320 px. Engine core: no Node-only imports.
//
// The rules (lead rulings 2026-11-09, rounds 4–8; docs/scoring.md "Page-load pop-ups"). Nothing here judges how
// much of what is covered. Only the cleared page is measured; no findings come from look 1.
// 1. Qualifying boxes: every modal-like box (role dialog or alertdialog, aria-modal, an open modal <dialog>, a fixed
//    box covering a large part of the screen, a box above a full-screen backdrop), nested ones too, in open shadow
//    roots and same-origin frames too, with a control the dismissal would try or that is a modal (Escape). A frame
//    from another site that is such a box qualifies too (its content cannot be measured). A box that is the main
//    landmark, holds it, or holds most of the page's text and links is the page itself, never a pop-up.
// 2. Exactly one qualifying box, or none. Multiple boxes keep no look-1 findings and are never dismissed.
// 3. Look 1 (the page as loaded) only discovers the single qualifying box and its dismissal. No contrast or reflow
//    findings are measured or kept. Content inside the pop-up is a documented limit.
// 4. One dismissal, of the single box: `proveDismiss` (keyboard only). A qualifying box still there after it, or one
//    it revealed, means the page is still covered.
// 5. Look 2 (after a proven dismissal and no box left): the test runs as on a page with no pop-up, discovering
//    afresh; all its results stand.
// 6. Incomplete is not testable, never clean: a pop-up that cannot be closed, another one left, or a second look
//    that cannot start or finish, gives not_testable for the page.
// 7. A page with no qualifying box is measured exactly as before this module existed.
// 8. A test that tried a dismissal asks the runner for a fresh page (`discardPage`), so every other test sees the
//    page as loaded; never at an address that looks like an action, which is never loaded twice (F6): there the next
//    test reuses the page (`discardUnlessAction`, guard.ts). The keyboard and form tests never use this.
import type { ProbeFinding } from '../types.js';
import { dismissCandidates, DISMISS_NAME, proveDismiss, type DismissResult } from './dismiss.js';
import { discardUnlessAction } from './guard.js';
import { guardStopped, type GuardStop } from './layout.js';
import type { GuardLog, ProbeContext } from './types.js';

export const POPUP_LIMITS = {
  /** Share of the screen a fixed box without a dialog role (or a frame from another site) must cover to count as covering. */
  fixedShare: 0.3,
  /** Share of the screen a text-less fixed layer must cover to count as a backdrop. */
  backdropShare: 0.8,
  /** Smallest share of the screen a pop-up covers (a hidden or collapsed one is not on screen). */
  minShare: 0.01,
  /** Grid of points looked at for fixed layers on top (per side). */
  grid: 5,
  /** Elements looked at for boxes above a backdrop, at the start and at the end of each document or shadow root. */
  scan: 3000,
  /** Share of the page's text and of its links a box must hold to be the page itself. */
  pageShare: 0.5,
  /** Time a dismissal needs at least (ms): Escape and Enter tries (0.4 + 2.2 + 0.3 s each at worst), Tab presses, a margin. */
  dismissMs: 6000,
  /** Documents and open shadow roots queued and searched, including the top document. */
  roots: 60,
} as const;

/** Why a measurement with a pop-up was incomplete (rule 6), in words for the not_testable finding. */
export const INCOMPLETE = {
  multiple: 'more than one pop-up covered the page',
  stayed: 'a pop-up covered the page and could not be closed',
  unfinished: 'the second look did not finish',
} as const;

/** A modal-like box found by the classifier. */
export interface PopupBox {
  /** Its CSS path, unique in its document or shadow root; parts joined by ' >>> ' go into an open shadow root or a same-origin frame. */
  path: string;
  /** Its name or first words (at most 60 characters). */
  name: string;
  /** Why it is modal-like ('frame': a frame from another site, whose content cannot be read). */
  why: 'dialog' | 'modal' | 'fixed' | 'backdrop' | 'frame';
  /** aria-modal or an open modal <dialog>: Escape may close it with no named control. */
  modal: boolean;
  /** Provisional ancestor boxes; only fully qualified ancestors can suppress backdrop candidates. */
  parents?: string[];
}

/**
 * Runs in the page (self-contained). Finds every modal-like box that is not the page itself (nested ones too; in open
 * shadow roots and same-origin frames too), largest first. Reads only; nothing is kept on the page.
 */
export function findOverlays(arg: { limits: typeof POPUP_LIMITS; deadline?: number }): { boxes: PopupBox[]; discovery: PopupDiscovery } {
  const start = Date.now();
  const deadline = arg.deadline ?? Infinity;
  const discovery: PopupDiscovery = { roots: 1, ms: 0 };
  const timedOut = () => {
    if (Date.now() < deadline) return false;
    discovery.exhausted = 'time limit';
    return true;
  };
  const result = (boxes: PopupBox[] = []) => {
    timedOut();
    return { boxes: discovery.exhausted ? [] : boxes, discovery: { ...discovery, ms: Date.now() - start } };
  };
  const L = arg.limits;
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = innerHeight;
  const screen = Math.max(1, vw * vh);
  const frameEl = (d: Document): Element | null => {
    try { return d.defaultView?.frameElement ?? null; } catch { return null; }
  };
  const frameDoc = (el: Element): Document | null => {
    if (el.localName !== 'iframe' && el.localName !== 'frame') return null;
    try { return (el as HTMLIFrameElement).contentDocument; } catch { return null; }
  };
  const isFrame = (el: Element) => el.localName === 'iframe' || el.localName === 'frame';
  /** Its box in the top page's viewport (through same-origin frames). */
  const rectOf = (el: Element) => {
    const r = el.getBoundingClientRect();
    let x = r.left;
    let y = r.top;
    for (let d: Document = el.ownerDocument, k = 0; d !== document && k < 10; k++) {
      const fe = frameEl(d);
      if (!fe) break;
      const fr = fe.getBoundingClientRect();
      x += fr.left + fe.clientLeft;
      y += fr.top + fe.clientTop;
      d = fe.ownerDocument;
    }
    return { left: x, top: y, right: x + r.width, bottom: y + r.height };
  };
  const onScreen = (el: Element) => {
    const r = rectOf(el);
    return Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0)) / screen;
  };
  const style = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  type Vis = Element & { checkVisibility?: (o: object) => boolean };
  const painted = (el: Element) => {
    const e = el as Vis;
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    return onScreen(el) >= L.minShare;
  };
  const clean = (s: string | null | undefined, n = 60) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const textLen = (el: Element) => ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().length;
  const fixed = (el: Element) => style(el).position === 'fixed';
  /** Its parent in its document, through shadow hosts (null at the document's root). */
  const up = (el: Element): Element | null => el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
  /** `a` holds `b`: in its subtree, through open shadow roots and same-origin frames. */
  const holds = (a: Node, b: Node) => {
    for (let n: Node | null = b, k = 0; n && k < 10_000; k++) {
      if (n === a) return true;
      n = n.parentNode ?? (n as ShadowRoot).host ?? (n.nodeType === 9 ? frameEl(n as Document) : null);
    }
    return false;
  };
  /** A frame from another site (its content cannot be read) covering at least `fixedShare` of the screen, at or inside `el`. */
  const foreignFrame = (el: Element) => {
    const list = isFrame(el) ? [el] : [...el.querySelectorAll('iframe, frame')];
    return list.some((f) => !frameDoc(f) && onScreen(f) >= L.fixedShare && painted(f));
  };
  const pathIn = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el, i = 0; cur && i < 40; cur = cur.parentElement, i++) {
      if (cur.id && root.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) { parts.unshift(`#${CSS.escape(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const siblings = parent ? [...parent.children] : root.nodeType === 11 ? [...(root as ShadowRoot).children] : null;
      if (!siblings) { parts.unshift(cur.localName); break; }
      const same = siblings.filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  /** Its path from the top document: each shadow root or frame on the way is a ' >>> '. */
  const deepPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el, k = 0; cur && k < 10; k++) {
      parts.unshift(pathIn(cur));
      const root = cur.getRootNode();
      cur = root.nodeType === 11 ? (root as ShadowRoot).host : root !== document && root.nodeType === 9 ? frameEl(root as Document) : null;
    }
    return parts.join(' >>> ');
  };
  const resolve = (path: string): Element | null => {
    try {
      let root: Document | ShadowRoot = document;
      let el: Element | null = null;
      const parts = path.split(' >>> ');
      for (let k = 0; k < parts.length; k++) {
        el = root.querySelector(parts[k]!);
        if (!el || k === parts.length - 1) return el;
        const inner: Document | ShadowRoot | null = el.shadowRoot ?? frameDoc(el);
        if (!inner) return null;
        root = inner;
      }
      return el;
    } catch {
      return null;
    }
  };
  const nameOf = (el: Element): string => {
    const label = el.getAttribute('aria-label');
    if (label && label.trim()) return clean(label);
    const by = el.getAttribute('aria-labelledby');
    if (by) {
      const root = el.getRootNode() as Document | ShadowRoot;
      const t = by.split(/\s+/).map((id) => root.getElementById?.(id)?.textContent ?? '').join(' ');
      if (t.trim()) return clean(t);
    }
    const h = el.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]');
    return clean(h?.textContent || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title'));
  };
  const body = document.body;
  if (!body) return result();
  // Breadth first. The queue itself never exceeds the root cap; already queued roots are still visited.
  const roots: (Document | ShadowRoot)[] = [document];
  const seen = new Set<Document | ShadowRoot>(roots);
  for (let k = 0; k < roots.length; k++) {
    if (timedOut()) return result();
    const all = roots[k]!.querySelectorAll('*');
    for (let i = 0; i < all.length; i++) {
      if (timedOut()) return result();
      const el = all[i]!;
      const inner = el.shadowRoot ?? frameDoc(el);
      if (!inner || seen.has(inner)) continue;
      if (roots.length === L.roots) { discovery.exhausted = 'root limit'; continue; }
      roots.push(inner);
      seen.add(inner);
      discovery.roots = roots.length;
    }
  }
  if (discovery.exhausted) return result();
  const deepAll = (selector: string) => roots.flatMap((r) => [...r.querySelectorAll(selector)]);
  /** What is at a point of the top page's viewport, front to back, through open shadow roots and same-origin frames. */
  const deepStack = (x: number, y: number): Element[] => {
    const out: Element[] = [];
    const go = (root: Document | ShadowRoot, px: number, py: number, depth: number) => {
      let list: Element[] = [];
      try { list = root.elementsFromPoint(px, py); } catch { list = []; }
      for (const el of list) {
        if (root.nodeType === 11 && el.getRootNode() !== root) continue;
        if (depth < 5 && el.shadowRoot && el.shadowRoot !== root) go(el.shadowRoot, px, py, depth + 1);
        const d = frameDoc(el);
        if (depth < 5 && d) {
          const r = el.getBoundingClientRect();
          go(d, px - r.left - el.clientLeft, py - r.top - el.clientTop, depth + 1);
        }
        out.push(el);
      }
    };
    go(document, x, y, 0);
    return out;
  };
  const pageText = textLen(body);
  const pageLinks = body.querySelectorAll('a[href]').length;
  const pageOf = new Map<Element, boolean>();
  /** The page itself (an app shell, a cookie wall that is the whole page): its main landmark (being it or holding it), or most of its text and links. */
  const isPage = (el: Element) => {
    let v = pageOf.get(el);
    if (v !== undefined) return v;
    if (el === body || el === document.documentElement || el.contains(body)) v = true;
    else if (el.matches('main, [role="main"]') || el.querySelector('main, [role="main"]')) v = true;
    else v = textLen(el) >= L.pageShare * pageText && (pageLinks === 0 || el.querySelectorAll('a[href]').length >= L.pageShare * pageLinks);
    pageOf.set(el, v);
    return v;
  };
  const found = new Map<Element, { why: PopupBox['why']; modal: boolean }>();
  // Dialogs: by role, aria-modal, or an open modal <dialog>.
  for (const el of deepAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], dialog[open]')) {
    if (timedOut()) return result();
    if (!painted(el)) continue;
    let modal = el.getAttribute('aria-modal') === 'true';
    try { modal ||= el.matches(':modal'); } catch { /* old browser */ }
    found.set(el, { why: modal ? 'modal' : 'dialog', modal });
  }
  // Layers on top of the screen, over each point of a grid: every fixed box there (a fixed pop-up inside a fixed
  // full-screen shell too), and full-screen backdrops.
  const layers = new Set<Element>();
  for (let i = 0; i < L.grid; i++) {
    for (let j = 0; j < L.grid; j++) {
      if (timedOut()) return result();
      const stack = deepStack(((i + 0.5) / L.grid) * vw, ((j + 0.5) / L.grid) * vh).slice(0, 8);
      for (const top of stack) {
        for (let a: Element | null = top, k = 0; a && k < 200; a = up(a), k++) {
          if (a === a.ownerDocument.body || a === a.ownerDocument.documentElement) break;
          if (fixed(a) || (isFrame(a) && !frameDoc(a))) layers.add(a);
        }
      }
    }
  }
  const isBackdrop = (el: Element) => fixed(el) && painted(el) && onScreen(el) >= L.backdropShare && textLen(el) === 0 && !foreignFrame(el);
  const backdrops = [...layers].filter(isBackdrop);
  for (const el of layers) {
    if (timedOut()) return result();
    if (found.has(el) || !painted(el)) continue;
    if (textLen(el) > 0 && fixed(el) && onScreen(el) >= L.fixedShare) found.set(el, { why: 'fixed', modal: false });
    else if (textLen(el) === 0 && foreignFrame(el) && (fixed(el) || [...layers].some((o) => o !== el && fixed(o) && holds(o, el)))) found.set(el, { why: 'frame', modal: false });
  }
  // Over a backdrop: a positioned box (fixed or absolute) drawn above it at its own centre, however small (a
  // lightbox whose wrap is positioned absolutely over its fixed backdrop, as Magnific Popup's `fixedContentPos:
  // false` does, is one). Pop-up scripts add their boxes at the start or the end of the page: both are looked at.
  // A box inside one found already is that one's; a wrapper that is no box (a portal of no size) hides nothing.
  if (backdrops.length) {
    for (const root of roots) {
      const all = root.querySelectorAll('*');
      const n = all.length;
      for (let k = 0; k < n; k++) {
        if (timedOut()) return result();
        if (k === L.scan && n > L.scan * 2) k = n - L.scan;
        const el = all[k]!;
        if (found.has(el) || !/^(fixed|absolute)$/.test(style(el).position)) continue;
        if (backdrops.some((b) => holds(el, b) || holds(b, el)) || !painted(el)) continue;
        const foreign = textLen(el) === 0 && foreignFrame(el);
        if (textLen(el) === 0 && !foreign) continue;
        const r = rectOf(el);
        const x = Math.min(vw - 1, Math.max(0, (r.left + r.right) / 2));
        const y = Math.min(vh - 1, Math.max(0, (r.top + r.bottom) / 2));
        const stack = deepStack(x, y);
        const mine = stack.findIndex((e) => holds(el, e));
        const bd = stack.findIndex((e) => backdrops.includes(e));
        if (mine >= 0 && bd > mine) found.set(el, { why: foreign ? 'frame' : 'backdrop', modal: false });
      }
    }
  }
  // Every box that is not the page itself (a wrapper and the modal inside it both), the largest first.
  const ok = [...found.keys()].filter((el) => !isPage(el));
  ok.sort((a, b) => onScreen(b) - onScreen(a));
  const boxes: PopupBox[] = [];
  const named = new Map<Node, string>();
  for (const el of ok) {
    if (timedOut()) return result();
    const path = deepPath(el);
    // Its path must name it alone (the dismissal proof finds it by that path); one that cannot be named is never set aside.
    if (resolve(path) === el) {
      boxes.push({ path, name: nameOf(el), ...found.get(el)! });
      named.set(el, path);
    }
  }
  for (const b of boxes) {
    const el = resolve(b.path)!;
    b.parents = [];
    for (let n: Node | null = el.parentNode, k = 0; n && k < 10_000; k++) {
      if (timedOut()) return result();
      const path = named.get(n);
      if (path) b.parents.push(path);
      n = n.parentNode ?? (n as ShadowRoot).host ?? (n.nodeType === 9 ? frameEl(n as Document) : null);
    }
  }
  return result(boxes);
}

/** Discovery is bounded separately from the measurements. Exhaustion uses the ordinary probe path. */
export interface PopupDiscovery {
  roots: number;
  ms: number;
  exhausted?: 'root limit' | 'time limit';
}
export interface PopupSearch {
  boxes: PopupBox[];
  box: PopupBox | null;
  discovery?: PopupDiscovery;
}

/** Fully qualifying boxes, with a single box only when exactly one qualifies. */
export async function findPopups(ctx: Pick<ProbeContext, 'page' | 'deadline'>): Promise<PopupSearch> {
  const start = Date.now();
  try {
    const found = await ctx.page.evaluate(findOverlays, { limits: POPUP_LIMITS, deadline: ctx.deadline });
    const discovery = found.discovery;
    const exhausted = (): PopupSearch => ({ boxes: [], box: null, discovery: { roots: discovery.roots, ms: Date.now() - start, exhausted: 'time limit' } });
    if (discovery.exhausted) return { boxes: [], box: null, discovery };
    const out: PopupBox[] = [];
    for (const b of found.boxes) {
      if (Date.now() >= ctx.deadline) return exhausted();
      if (b.modal || b.why === 'frame') { out.push(b); continue; }
      const peek = await ctx.page.evaluate(dismissCandidates, { box: b.path, pattern: DISMISS_NAME.source, max: 3, noHash: true, peek: true });
      if (peek.candidates.length) out.push(b);
    }
    if (Date.now() >= ctx.deadline) return exhausted();
    // Only a fully qualified wrapper may suppress a provisional box found above a backdrop.
    const qualified = new Set(out.map((b) => b.path));
    const boxes: PopupBox[] = [];
    for (const b of out) {
      if (Date.now() >= ctx.deadline) return exhausted();
      if (b.why !== 'backdrop' || !b.parents?.some((p) => qualified.has(p))) boxes.push(b);
    }
    return { boxes, box: boxes.length === 1 ? boxes[0]! : null, discovery: { ...discovery, ms: Date.now() - start } };
  } catch {
    return { boxes: [], box: null };
  }
}

/** The single qualifying box, or null (`findPopups`). */
export async function findPagePopup(ctx: Pick<ProbeContext, 'page' | 'deadline'>): Promise<PopupBox | null> {
  return (await findPopups(ctx)).box;
}

/** Two or more boxes: keep nothing from look 1, and never try a dismissal. */
export function multiplePopups(ctx: Pick<ProbeContext, 'setData'>, found: PopupSearch, criterion: string): ProbeFinding[] {
  ctx.setData?.({ popup: { boxes: found.boxes.length, setAside: false, why: INCOMPLETE.multiple }, discovery: found.discovery });
  return incomplete(criterion, INCOMPLETE.multiple);
}

/** On discovery exhaustion, the ordinary measurements stand and explain why pop-up handling did not run. */
export function discoveryDetails(ctx: Pick<ProbeContext, 'setData'>, found: PopupSearch, findings: ProbeFinding[]): ProbeFinding[] {
  const d = found.discovery;
  if (!d?.exhausted) return findings;
  const detail = `pop-up discovery reached its ${d.exhausted} at ${d.roots} queued roots (${d.ms} ms), so the page was checked without pop-up handling`;
  // Some ordinary probes return no findings when there is nothing to measure. Preserve that behaviour too.
  if (!findings.length) ctx.setData?.({ discovery: { ...d, detail } });
  return findings.map((f) => ({ ...f, detail: `${f.detail ?? ''}; ${detail}` }));
}

/** Whether there is time for the dismissal and a second look that takes about `passMs` (else not testable). */
export function timeForAside(ctx: Pick<ProbeContext, 'deadline'>, passMs: number, reserveMs = 1500): boolean {
  return ctx.deadline - Date.now() > POPUP_LIMITS.dismissMs + Math.max(1000, passMs) + reserveMs;
}

/** What setting the single pop-up aside gave. */
export interface PopupAside {
  /** The qualifying boxes look 1 found. */
  boxes: PopupBox[];
  /** The single one, the one dismissed. */
  box: PopupBox;
  /** It was closed by a proven dismissal and no qualifying box is left: look 2 may start. */
  dismissed: boolean;
  /** The dismissal's proof (none when it was not tried). */
  proof?: DismissResult;
  /** Why look 2 did not start (rule 6), when it did not. */
  why?: string;
  /** After the dismissal, the qualifying boxes still on the page (one under it, or one it revealed). */
  left?: number;
  /** The guard log's position after the proof: look 2's window starts here. */
  mark: number;
}

/** A pop-up not set aside (no dismissal tried): look 2 does not start, for `why`. */
export function notAside(ctx: Pick<ProbeContext, 'guard'>, found: { boxes: PopupBox[]; box: PopupBox }, why: string): PopupAside {
  return { boxes: found.boxes, box: found.box, dismissed: false, why, mark: ctx.guard.mark() };
}

/**
 * Sets the single pop-up aside by one proven keyboard dismissal (rule 4), then checks that no qualifying box is left
 * (rule 6). The page is always discarded afterwards (the proof presses keys and moves focus, closed or not), unless its
 * address looks like an action: that page is never loaded again (F6), so the next test reuses it, as after the keyboard
 * walk (`discardUnlessAction`). Never throws.
 */
export async function setPopupAside(ctx: Pick<ProbeContext, 'page' | 'url' | 'guard' | 'discardPage' | 'deadline'>, found: { boxes: PopupBox[]; box: PopupBox }): Promise<PopupAside> {
  discardUnlessAction(ctx);
  const proof = await proveDismiss(ctx, found.box.path, { noHashLinks: true, escapeFirst: true, keyboardReach: true });
  const base = { boxes: found.boxes, box: found.box, proof };
  if (!proof.dismissed) return { ...base, dismissed: false, why: INCOMPLETE.stayed, mark: ctx.guard.mark() };
  const check = await findPopups(ctx);
  if (check.discovery?.exhausted) return { ...base, dismissed: false, why: INCOMPLETE.unfinished, mark: ctx.guard.mark() };
  const left = check.boxes.length;
  if (left) return { ...base, dismissed: false, why: INCOMPLETE.stayed, left, mark: ctx.guard.mark() };
  return { ...base, dismissed: true, mark: ctx.guard.mark() };
}

/** `guardStopped` for what happened in [from, to) of the log (`to` undefined: up to now), with what came before `from` as background traffic. */
export function stoppedBetween(log: GuardLog, from: number, to?: number): GuardStop | undefined {
  const all = log.since(from);
  const between = to === undefined ? all : all.slice(0, Math.max(0, all.length - log.since(to).length));
  return guardStopped(between, log.events.slice(0, from));
}

/** The run's data about the pop-up (for the report's evidence and the AI review). */
export function asideData(a: PopupAside | null | undefined, ms?: number): Record<string, unknown> | undefined {
  if (!a) return undefined;
  const why = a.left ? `another pop-up was left on the page after this one was closed` : a.proof?.why ?? a.why ?? 'not dismissed';
  return {
    popup: {
      name: a.box.name, kind: a.box.why, setAside: a.dismissed, boxes: a.boxes.length,
      ...(a.dismissed && a.proof?.by ? { by: `${a.proof.by.key} on “${a.proof.by.name}”` } : { why }),
      ...(ms !== undefined ? { ms } : {}),
    },
  };
}

/** Rule 6: no findings from look 1; an incomplete second look leaves the page not testable. */
export function incomplete(criterion: string, why: string): ProbeFinding[] {
  return [{ criterion, status: 'not_testable', detail: `${why}, so the page could not be checked` }];
}
