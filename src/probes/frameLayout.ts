// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The page's own embedded frames, for the layout tests (reflow 1.4.10, text spacing 1.4.12; 2026-11-10): a
// page that fits can hold a frame from the same site (a document viewer, a form) whose own content does not.
// The layout tests measured the top document only. Frames inside those frames are looked into as well; and a
// frame from this site that should be looked into and cannot be (it could not be read, there are more than the
// limit, the time ran out) is a gap the test reports as not testable, never as fine (review r1, finding 12).
// Engine core: no Node-only imports.
import type { FrameLike, PageLike } from '../types.js';

/** Frames looked inside per page, and the smallest frame that counts (CSS px). */
export const FRAME_LAYOUT = { max: 6, minWidth: 120, minHeight: 60, callMs: 4000 } as const;

export interface OwnFrame {
  frame: FrameLike;
  /** CSS path of its element in the page. */
  path: string;
  /** How the finding names it: its title or accessible name, else its address's path. */
  name: string;
}

/** Runs in the page: the frame element's path and name when it is shown and big enough, else null. */
function frameFacts(arg: { el: unknown; minWidth: number; minHeight: number }): { path: string; name: string } | null {
  const el = arg.el as Element | null;
  if (!el || !el.isConnected) return null;
  if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return null;
  const r = el.getBoundingClientRect();
  if (r.width < arg.minWidth || r.height < arg.minHeight) return null;
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const parts: string[] = [];
  for (let cur: Element | null = el; cur; cur = cur.parentElement) {
    if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
    const parent: Element | null = cur.parentElement;
    if (!parent) { parts.unshift(cur.localName); break; }
    const same = [...parent.children].filter((c) => c.localName === cur!.localName);
    parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
  }
  const name = (el.getAttribute('title') ?? el.getAttribute('aria-label') ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return { path: parts.join(' > '), name };
}

/** Runs in a frame: it holds a web page (not a PDF or a picture) with a body. */
function isHtmlDocument(): boolean {
  return document.contentType === 'text/html' && !!document.body;
}

async function within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p.catch(() => fallback), new Promise<T>((r) => { timer = setTimeout(() => r(fallback), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/** The frames to look inside, and the frames from this site that could not be looked inside (with why). */
export interface OwnFrames {
  frames: OwnFrame[];
  gaps: { path: string; why: string }[];
}

/**
 * The frames a layout test also looks inside: frames that hold a web page from the page's own origin (or one the
 * page wrote itself: about:blank, about:srcdoc), shown and at least 120×60 px, directly in the page or inside
 * such a frame (a frame inside a frame from another site is that site's), at most `FRAME_LAYOUT.max`. Frames
 * from other sites are left to their own site (as for the scored rules). A frame from this site that cannot be
 * read, and the frames beyond the limit, are `gaps`. Never throws; a browser connection without frames gives none.
 */
export async function ownFrames(page: PageLike, opts: { callMs?: number; deadline?: number } = {}): Promise<OwnFrames> {
  const out: OwnFrames = { frames: [], gaps: [] };
  // Each call, at most `callMs` (default FRAME_LAYOUT.callMs) and never past `deadline`.
  const ms = () => Math.max(100, Math.min(opts.callMs ?? FRAME_LAYOUT.callMs, (opts.deadline ?? Infinity) - Date.now()));
  let origin = '';
  try {
    origin = new URL(page.url?.() ?? '').origin;
  } catch {
    return out;
  }
  const depthOf = (f: FrameLike): number => { let d = 0; for (let p = f.parentFrame(); p; p = p.parentFrame()) d++; return d; };
  let listed: { frame: FrameLike; depth: number }[] = [];
  try {
    listed = (page.frames?.() ?? []).map((frame) => ({ frame, depth: depthOf(frame) })).filter((x) => x.depth > 0).sort((a, b) => a.depth - b.depth);
  } catch {
    return out;
  }
  const taken = new Map<FrameLike, OwnFrame>();
  let more = 0;
  for (const { frame, depth } of listed) {
    let where = '';
    try {
      const parent = frame.parentFrame()!;
      // Inside a frame that is not looked into (another site's, a hidden one): not this page's content to measure.
      const outer = depth === 1 ? null : taken.get(parent);
      if (depth > 1 && !outer) continue;
      where = outer?.path ?? '';
      const url = frame.url();
      const own = /^about:(?:blank|srcdoc)/.test(url) || (/^https?:/i.test(url) && new URL(url).origin === origin);
      if (!own) continue;
      const handle = await within(ms(), frame.frameElement(), undefined);
      if (!handle) { out.gaps.push({ path: where, why: 'its element could not be reached' }); continue; }
      const host: Pick<PageLike, 'evaluate'> = outer ? outer.frame : page;
      const facts = await within<{ path: string; name: string } | null | undefined>(ms(), host.evaluate(frameFacts, { el: handle, minWidth: FRAME_LAYOUT.minWidth, minHeight: FRAME_LAYOUT.minHeight }), undefined);
      if (facts === undefined) { out.gaps.push({ path: where, why: 'its place in the page could not be read' }); continue; }
      // Not shown, or too small to hold content: nothing to measure.
      if (!facts) continue;
      const path = outer ? `${outer.path} >>> ${facts.path}` : facts.path;
      const html = await within<boolean | undefined>(ms(), frame.evaluate(isHtmlDocument, undefined), undefined);
      if (html === undefined) { out.gaps.push({ path, why: 'its content could not be read' }); continue; }
      if (!html) continue;
      if (taken.size >= FRAME_LAYOUT.max) { more++; continue; }
      let name = facts.name;
      if (!name) { try { name = new URL(url).pathname.slice(0, 60); } catch { name = ''; } }
      const one: OwnFrame = { frame, path, name };
      taken.set(frame, one);
      out.frames.push(one);
    } catch {
      out.gaps.push({ path: where, why: 'it went away or could not be read' });
    }
  }
  if (more) out.gaps.push({ path: '', why: `the page has ${more} more ${more === 1 ? 'frame' : 'frames'} from this site than the test looks inside (${FRAME_LAYOUT.max})` });
  return out;
}

/** The not_testable finding for frames from this site that could not be looked inside (`when`: "at 320 px wide"…). Empty without gaps. */
export function frameGapFindings(criterion: string, gaps: readonly { path: string; why: string }[], when: string): { criterion: string; status: 'not_testable'; target?: string; detail: string }[] {
  if (!gaps.length) return [];
  const reasons = [...new Set(gaps.map((g) => g.why))];
  const first = gaps.find((g) => g.path)?.path;
  return [{
    criterion, status: 'not_testable', ...(first ? { target: first } : {}),
    detail: `Content in ${gaps.length === 1 ? 'an embedded frame' : `${gaps.length} embedded frames`} from this site was not measured ${when}: ${reasons.join('; ')}`,
  }];
}

/** "Inside the embedded frame “Rules for plot holders”: " (its name when it has one). */
export const frameWords = (f: Pick<OwnFrame, 'name'>): string => `Inside the embedded frame${f.name ? ` “${f.name}”` : ''}: `;
