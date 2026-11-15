// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 2.4.2 Page Titled on sites that change pages without loading them (single-page apps): where the app
// gives each view a title of its own, a view has to get its title when a visitor comes to it through the
// site's links too. A page loaded by its address has the title its HTML or its first render gives it, so a
// scan that loads every page never sees the title a visitor gets after following the site's own links.
// This deep test follows up to three of the page's own links with a real click and reads the title:
// - a link that loads a new page (the guard holds the load, the page stays) ends the test: not applicable;
// - a link that changes the address and the content with no page load is a client-side page change. The
//   test waits until the title, the main heading and the address have not changed for a full second, then
//   goes back (history) and waits the same way;
// - failed only when the app demonstrably sets a title per view (the title changed when the link's view
//   came in) and, back on the view the test started on (another main heading), the title is still the one
//   of the view it left. An app that keeps one title across its views is not failed: its name may describe
//   every one of them (Understanding 2.4.2), and whether it does is not judged here (not testable).
// Strict guard: nothing the page asks for while links are followed is sent (a link's handler may save a
// draft before it changes the view), no download starts, and a view that asked the server for something
// cannot be judged (not testable). A view that never settles in time is not judged either.
// Never followed: links to another site, to files, to addresses that look like an action, and links that
// open a new window. Deep: one page load of its own; at most three links, each at most 9 s (1.5 s for the
// address to change, 3 s to settle, the same on the way back), inside a 30 s time box.
// Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { isActionUrl } from './guard.js';
import { DOWNLOAD_STOP_KEY, stopDownloads, undoDownloadStop } from './noDownloads.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

export const ROUTE_TITLES_PROBE_ID = 'route-titles';
export const ROUTE_LIMITS = {
  /** Links followed per page. */
  links: 3,
  /** Longest wait for a click to load a page or change the address, and for the way back. */
  waitMs: 1500,
  pollMs: 100,
  /** A view has settled when its title, main heading and address have not changed for this long. */
  quietMs: 1000,
  /** Longest wait for that; a view that is still changing then is not judged. */
  settleMaxMs: 3000,
  reserveMs: 2500,
} as const;

/** Requests that only draw something: refusing one changes no title and no heading. */
const DRAWN_ONLY: ReadonlySet<string> = new Set(['image', 'media', 'font']);

export interface RouteLink { i: number; name: string; href: string }
export interface RouteState { url: string; path: string; title: string; h1: string; text: string }
const KEY = '__grntedRoute';

/**
 * Runs in the page (self-contained): the page's own links to follow. Same site, another path, a plain
 * link (no download, no new window), in view, and under a click handler (on it, an ancestor, the document
 * or the window): without one the browser loads the page itself. One link per address, navigation first.
 */
export function routeLinks(arg: { key: string; refs: number[]; delegated: boolean; max: number }): RouteLink[] {
  const W = window as unknown as Record<string, unknown> & { __grntedTarget?: (ref: number) => unknown };
  const handled = new Set<Element>();
  for (const r of arg.refs) {
    const el = typeof W.__grntedTarget === 'function' ? W.__grntedTarget(r) : null;
    if (el instanceof Element) handled.add(el);
  }
  const underHandler = (a: Element): boolean => {
    if (arg.delegated) return true;
    for (let e: Element | null = a; e; e = e.parentElement) if (handled.has(e)) return true;
    return false;
  };
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  const here = location.pathname.replace(/\/(index\.html?)?$/, '') || '/';
  const found: { el: HTMLAnchorElement; nav: boolean }[] = [];
  const seen = new Set<string>();
  const all = document.querySelectorAll('a[href]');
  for (let k = 0; k < all.length && k < 1500; k++) {
    const a = all[k] as HTMLAnchorElement;
    if (a.origin !== location.origin || !/^https?:$/.test(a.protocol)) continue;
    if (a.hasAttribute('download') || (a.target && a.target !== '_self') || /\bexternal\b/i.test(a.rel)) continue;
    const path = a.pathname.replace(/\/(index\.html?)?$/, '') || '/';
    if (path === here || seen.has(path) || /\.[a-z0-9]{2,5}$/i.test(a.pathname.replace(/\.html?$/i, ''))) continue;
    const e = a as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof e.checkVisibility === 'function' && !e.checkVisibility({ visibilityProperty: true, opacityProperty: true })) continue;
    const r = a.getBoundingClientRect();
    if (r.width < 4 || r.height < 4 || !underHandler(a)) continue;
    seen.add(path);
    found.push({ el: a, nav: !!a.closest('nav, [role="navigation"], header') });
  }
  found.sort((x, y) => Number(y.nav) - Number(x.nav));
  const kept = found.slice(0, arg.max).map((f) => f.el);
  Object.defineProperty(W, arg.key, { value: kept, configurable: true, enumerable: false, writable: true });
  return kept.map((el, i) => ({ i, name: clean(el.getAttribute('aria-label') || el.innerText || el.textContent || el.querySelector('img[alt]')?.getAttribute('alt')), href: el.href }));
}

/** Runs in the page (self-contained): a point on a kept link the pointer reaches, after scrolling it into view. */
export function routePoint(arg: { key: string; i: number }): { x: number; y: number } | null {
  const el = ((window as unknown as Record<string, Element[] | undefined>)[arg.key] ?? [])[arg.i];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  for (const [fx, fy] of [[0.5, 0.5], [0.25, 0.5], [0.75, 0.5]] as const) {
    const x = Math.round(r.left + r.width * fx);
    const y = Math.round(r.top + r.height * fy);
    if (x < 1 || y < 1 || x > innerWidth - 2 || y > innerHeight - 2) continue;
    const hit = document.elementFromPoint(x, y);
    if (hit && (hit === el || el.contains(hit))) return { x, y };
  }
  return null;
}

/** Runs in the page (self-contained): where the page is and what it shows (address, title, main heading, the start of its main text). */
export function routeState(): RouteState {
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  let h1 = '';
  const hs = document.querySelectorAll('h1, [role="heading"][aria-level="1"]');
  for (let i = 0; i < hs.length && i < 20 && !h1; i++) {
    const e = hs[i] as HTMLElement & { checkVisibility?: (o: Record<string, boolean>) => boolean };
    if (typeof e.checkVisibility !== 'function' || e.checkVisibility({ visibilityProperty: true })) h1 = clean(e.innerText || e.textContent, 200);
  }
  const main = (document.querySelector('main, [role="main"]') ?? document.body) as HTMLElement | null;
  return {
    url: location.href.split('#')[0]!, path: location.pathname.replace(/\/(index\.html?)?$/, '') || '/',
    title: clean(document.title, 300), h1, text: clean(main?.innerText ?? '', 400),
  };
}

/** One client-side page change and the way back. */
export interface Hop {
  link: string;
  /** The view the link showed (its path), its title and main heading once it had settled. */
  to: string;
  title: string;
  h1: string;
  /** The title after going back to the view the test started on, once settled (undefined: it could not go back, or the view did not settle). */
  back?: string;
  /** The page asked the server for something on the way (the test sends nothing): what it shows may not be what a visitor gets. */
  blocked?: boolean;
  /** The view (or the way back) was still changing when the wait ran out. */
  unsettled?: boolean;
}

const quote = (s: string, n = 80) => `“${s.length > n ? `${s.slice(0, n - 1)}…` : s}”`;

/** The verdict from the page changes followed (pure). `start`: the view the test started on, settled (null: it never settled). */
export function routeFindings(start: { title: string; h1: string } | null, hops: readonly Hop[], loads: boolean): ProbeFinding[] {
  const one = (status: ProbeFinding['status'], detail: string): ProbeFinding[] => [{ criterion: '2.4.2', status, ...(status === 'failed' ? { target: 'title' } : {}), detail }];
  if (!start) return one('not_testable', 'the page was still changing its title or main heading when the wait ran out, so the title a visitor gets after a page change could not be read');
  if (!hops.length) {
    return one('not_applicable', loads
      ? 'the links followed on this page load a new page, which has the title it loads with'
      : 'no link on this page changes the page without loading it');
  }
  const judged = hops.filter((h) => !h.blocked && !h.unsettled);
  // The app sets a title per view (it did when this link's view came in), and back on the view the test
  // started on, which has another main heading, the title is still that view's.
  const stale = judged.find((h) => h.title !== start.title && !!h.h1 && !!start.h1 && h.h1 !== start.h1 && h.back !== undefined && h.back === h.title);
  if (stale) {
    return one('failed', `The site changes pages without loading them and gives them titles of their own, but this page's title does not come back with it: after following ${quote(stale.link, 50)} (${stale.to}) and going back, the title is still ${quote(stale.title)}; loaded by its address, this page's title is ${quote(start.title)}.`);
  }
  if (hops.some((h) => h.blocked)) return one('not_testable', 'following a link here made the page ask its server for something; the test sends nothing while it presses links, so the view and the title a visitor would get could not be read');
  if (hops.some((h) => h.unsettled)) return one('not_testable', 'after a link was followed the page was still changing its title or main heading when the wait ran out, so the title could not be judged');
  if (judged.some((h) => h.back === undefined)) return one('not_testable', 'the test followed a link to another page of the site without a page load and could not come back to this one, so the title visitors get here could not be read');
  // The title changed with the view and is this page's own again after going back.
  if (judged.some((h) => h.title !== start.title && h.back === start.title)) {
    const n = judged.length;
    return one('no_failures_found', `the title changes with the page on ${n === 1 ? 'the client-side page change' : `the ${n} client-side page changes`} followed, and is this page's own again after going back`);
  }
  // One title for every view followed: an application's name may describe all of them. Not judged.
  return one('not_testable', `the site shows other pages without loading them and keeps one title (${quote(start.title, 60)}) across the ${judged.length === 1 ? 'view' : `${judged.length} views`} followed; whether that one title describes each of them is a judgement this test does not make`);
}

/** Follows the page's own links and reads the title after each client-side page change (see the top of this file). */
export async function runRouteTitles(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  if (!page.mouse) throw new ProbeNotTestable('the browser cannot move the pointer, which this test needs');
  const listeners = await ctx.listeners();
  const refs = listeners.filter((l) => l.type === 'click' && l.target.kind === 'element').map((l) => l.ref);
  const delegated = listeners.some((l) => l.type === 'click' && l.target.kind !== 'element');
  if (!refs.length && !delegated) return routeFindings({ title: '', h1: '' }, [], true);
  const links = (await page.evaluate(routeLinks, { key: KEY, refs, delegated, max: ROUTE_LIMITS.links + 2 })).filter((l) => !isActionUrl(l.href)).slice(0, ROUTE_LIMITS.links);
  if (!links.length) return routeFindings({ title: '', h1: '' }, [], false);
  // No click may save a file (the listeners were read above).
  if (!(await page.evaluate(stopDownloads, DOWNLOAD_STOP_KEY).catch(() => false))) throw new ProbeNotTestable('the test could not make sure that no click saves a file on this page');
  const late = () => ctx.signal.aborted || Date.now() > ctx.deadline - ROUTE_LIMITS.reserveMs;
  const wait = (ms: number) => page.waitForTimeout(ms);
  /**
   * The view once its title, main heading and address have not changed for `quietMs` (null: still changing
   * after `settleMaxMs`, or the time box is nearly over). One quiet look proves nothing: a router may put the
   * heading back at once and the title a moment later.
   */
  const settled = async (): Promise<RouteState | null> => {
    const t0 = Date.now();
    let last = await page.evaluate(routeState, undefined);
    let since = Date.now();
    for (;;) {
      if (Date.now() - since >= ROUTE_LIMITS.quietMs) return last;
      if (Date.now() - t0 >= ROUTE_LIMITS.settleMaxMs + ROUTE_LIMITS.quietMs || late()) return null;
      await wait(ROUTE_LIMITS.pollMs);
      const now = await page.evaluate(routeState, undefined);
      if (now.title !== last.title || now.h1 !== last.h1 || now.url !== last.url) since = Date.now();
      last = now;
    }
  };
  /**
   * The page asked for something the strict guard stopped that the view it shows may depend on: data or
   * code (a fetch, a script, a document). A picture, a font or a media file is refused like every other
   * request, but it only draws: the view's title and main heading are what a visitor would get without it.
   */
  const asked = (mark: number) => ctx.guard.since(mark).some((e) => e.kind === 'blocked' && e.cause !== 'background' && !DRAWN_ONLY.has(e.resourceType ?? ''));
  const hops: Hop[] = [];
  let loads = false;
  let start: RouteState | null = null;
  try {
    start = await settled();
    if (!start) return routeFindings(null, [], false);
    for (const link of links) {
      if (late()) break;
      const at = await page.evaluate(routePoint, { key: KEY, i: link.i });
      if (!at) continue;
      const mark = ctx.guard.mark();
      await page.mouse.move(at.x, at.y);
      await page.mouse.down();
      await page.mouse.up();
      let moved = false;
      for (let t = 0; t < ROUTE_LIMITS.waitMs && !moved; t += ROUTE_LIMITS.pollMs) {
        await wait(ROUTE_LIMITS.pollMs);
        // A page load (held): this site loads its pages, and each has the title it loads with.
        if (ctx.guard.since(mark).some((e) => e.kind === 'navigation' || e.kind === 'popup')) { loads = true; break; }
        moved = (await page.evaluate(routeState, undefined)).path !== start.path;
      }
      if (loads) break;
      if (!moved) continue;
      const there = await settled();
      const hop: Hop = { link: link.name || link.href, to: there?.path ?? '', title: there?.title ?? '', h1: there?.h1 ?? '', ...(there ? {} : { unsettled: true }) };
      // The same content under another address (a sort order, a tab): not another page.
      const same = !!there && there.h1 === start.h1 && there.text === start.text;
      await page.evaluate(() => history.back(), undefined).catch(() => {});
      let home = false;
      for (let t = 0; t < ROUTE_LIMITS.waitMs && !home; t += ROUTE_LIMITS.pollMs) {
        await wait(ROUTE_LIMITS.pollMs);
        home = (await page.evaluate(routeState, undefined)).path === start.path;
      }
      if (same) continue;
      if (home) {
        const again = await settled();
        // Back on the view it started on (its heading is its own again): the title a visitor now has.
        if (!again) hop.unsettled = true;
        else if (again.h1 === start.h1) hop.back = again.title;
      }
      if (asked(mark)) hop.blocked = true;
      hops.push(hop);
      // Could not come back, could not be judged, or a view that brought its own title: enough.
      if (hop.back === undefined || hop.blocked || hop.unsettled || hop.title !== start.title) break;
    }
  } finally {
    await page.mouse.move(-1, -1).catch(() => {});
    await page.evaluate((key: string) => { delete (window as unknown as Record<string, unknown>)[key]; }, KEY).catch(() => {});
    await page.evaluate(undoDownloadStop, DOWNLOAD_STOP_KEY).catch(() => {});
  }
  ctx.setData?.({ v: 1, start: { path: start.path, title: start.title }, hops });
  return routeFindings(start, hops, loads);
}

/**
 * The title after a client-side page change (2.4.2), deep: follows up to three of the page's own links.
 * Listed, not scored, until the gold standard verifies it (docs/scoring.md).
 */
export const routeTitlesProbe: PageProbe = {
  id: ROUTE_TITLES_PROBE_ID,
  criteria: ['2.4.2'],
  // An app that mounts its views late is followed with them.
  waitFor: { content: true },
  kind: 'interaction',
  tier: 'deep',
  scored: false,
  timeoutMs: 30_000,
  // It changes what the page shows (and comes back): a page of its own.
  isolate: true,
  // Strict guard: a link's click handler can do anything (save a draft, log a choice); nothing it asks for is sent.
  sendsNothing: true,
  run: runRouteTitles,
};
