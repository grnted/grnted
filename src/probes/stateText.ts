// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 for text the page shows after it loads (batch 18, visual lane, D13 and D14; docs/atlas/visual.md). axe
// reads the page once, about 1.5 s after load. Text a timer shows a few seconds later, and text in a region a control
// opens (a drop-down or mega menu, an accordion panel, a pop-over, a menu a single-page app puts at the end of the
// page) is never read. This test reads both, with axe's own colour-contrast rule (its exemptions included):
// - later text: the page's one-shot timers of 1 to 15 s are recorded from the start (an init script); the test waits
//   until the last of them has run (at most 15 s after load), then axe runs again; a failure on an element that was
//   not failing before is text shown later;
// - opened regions: up to `OPENERS` controls that say they open something (aria-expanded="false", a closed summary,
//   popovertarget) are pressed one at a time; the guard holds any navigation (then the test stops); axe runs again
//   and a failure on text that was not shown before the press is a failure of the opened region. Each is closed
//   again (Escape, else the same press); a page that cannot be put back is loaded again for the next one.
// Its own page (it presses controls and waits). Deep, listed: like the other deep tests, not scored. Failures name
// the state. What was not looked at (more controls than the limit) is a note, never "not testable" (lead's ruling,
// 2026-11-12). Engine core: no Node-only imports.
import type { AxeRun, ProbeFinding } from '../types.js';
import { runAxe, type AxeOptions } from '../axeRun.js';
import { mergeViewportRuns } from '../axeMerge.js';
import { CONTRAST_RULES } from './textContrast.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

/** Controls pressed per page, at most. */
export const OPENERS = 4;
/** Longest timer (ms after it was set) that is waited for. */
export const LATE_TIMER_MAX_MS = 15_000;
/** The second look at the page comes this long after the first at the earliest (ms). */
export const LATE_MIN_MS = 6000;
/** Failures reported per page. */
const MAX_FAILURES = 6;

/** Records the page's one-shot timers of 1 to 15 s (when each will run), in every frame, before the page's scripts. */
export const LATE_TEXT_INIT_SCRIPT = `(() => {
  try {
    if (window.__grntedLateTimers) return;
    const due = [];
    Object.defineProperty(window, '__grntedLateTimers', { value: () => due, configurable: true });
    const orig = window.setTimeout;
    window.setTimeout = function (fn, ms, ...rest) {
      try {
        const d = Number(ms) || 0;
        if (d >= 900 && d <= ${LATE_TIMER_MAX_MS} && due.length < 200) due.push(performance.now() + d);
      } catch (e) {}
      return orig.call(this, fn, ms, ...rest);
    };
  } catch (e) {}
})();`;

/** Runs in the page: when (ms from now) the last recorded timer runs; 0 when none is pending. */
function lateTimersLeft(max: number): number {
  const f = (window as unknown as { __grntedLateTimers?: () => number[] }).__grntedLateTimers;
  if (!f) return -1;
  const now = performance.now();
  const left = f().filter((t) => t > now && t - now <= max).map((t) => t - now);
  return left.length ? Math.max(...left) : 0;
}

/** Runs in the page (self-contained): the controls that open something, kept on the window; their names. */
function openers(arg: { key: string; max: number }): { ref: number; name: string }[] {
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 0 && r.height > 0 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1;
  };
  const sel = 'button[aria-expanded="false"], [role="button"][aria-expanded="false"], a[aria-expanded="false"], details:not([open]) > summary, [popovertarget]';
  const out: Element[] = [];
  const seenTargets = new Set<string>();
  for (const e of Array.from(document.querySelectorAll(sel))) {
    if (out.length >= arg.max) break;
    if (!shown(e) || (e as HTMLButtonElement).disabled) continue;
    if ((e as HTMLButtonElement).type === 'submit' && e.closest('form')) continue;
    if (e.localName === 'a' && /^\s*(https?:|\/[^#])/i.test(e.getAttribute('href') ?? '')) continue;
    const target = e.getAttribute('aria-controls') ?? e.getAttribute('popovertarget') ?? '';
    if (target && seenTargets.has(target)) continue;
    if (target) seenTargets.add(target);
    out.push(e);
  }
  (window as unknown as Record<string, Element[]>)[arg.key] = out;
  const name = (e: Element) => (e.getAttribute('aria-label') || (e as HTMLElement).innerText || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return out.map((e, ref) => ({ ref, name: name(e) }));
}

/** Runs in the page: presses a kept opener (a click). */
function pressOpener(arg: { key: string; ref: number }): boolean {
  const el = ((window as unknown as Record<string, Element[]>)[arg.key] ?? [])[arg.ref] as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  el.click();
  return true;
}

/** Runs in the page: whether a kept opener is open now (its aria-expanded, or its details element). */
function openerOpen(arg: { key: string; ref: number }): boolean | null {
  const el = ((window as unknown as Record<string, Element[]>)[arg.key] ?? [])[arg.ref];
  if (!el || !el.isConnected) return null;
  if (el.localName === 'summary') return !!el.parentElement && (el.parentElement as HTMLDetailsElement).open;
  const x = el.getAttribute('aria-expanded');
  return x === null ? null : x === 'true';
}

const OPENER_KEY = '__grntedOpeners';

type Ctx = ProbeContext;

async function contrastRun(ctx: Ctx): Promise<AxeRun> {
  const options: AxeOptions = { runOnly: { type: 'rule', values: [...CONTRAST_RULES] }, rules: {}, resultTypes: ['violations', 'incomplete'] };
  return (await runAxe(ctx.page, ctx.axeSource!, { maxFrames: 10, frameTimeoutMs: 4000, totalMs: 6000 }, { site: ctx.url, options })).run;
}

/** The failing targets of a run, with axe's summary. */
function failing(run: AxeRun): Map<string, string> {
  const merged = mergeViewportRuns([{ viewport: 'desktop', run }]);
  const out = new Map<string, string>();
  for (const v of merged.violations) {
    if (!(CONTRAST_RULES as readonly string[]).includes(v.id)) continue;
    for (const n of v.nodes) out.set(n.target, (n.failureSummary ?? '').replace(/^Fix any of the following:\s*/i, '').replace(/\s+/g, ' ').trim().slice(0, 220));
  }
  return out;
}

/** An element a :hover rule changes (kept in the page by index). */
export interface HoverSpot { i: number; name: string }

const HOVER_KEY = '__grntedHoverSpots';

/**
 * Runs in the page (self-contained). Elements that a style rule with :hover recolours or reveals something for (the
 * part of the selector before :hover), one per rule, shown, at most `max`: kept in the page for `placeHoverSpot`.
 * Style sheets of the document (unreadable ones skipped). Batch 18, round 2.
 */
export function hoverSpots(arg: { max: number }): HoverSpot[] {
  const found: Element[] = [];
  const walk = (rules: CSSRuleList | undefined, depth: number): void => {
    if (!rules || depth > 4 || found.length >= arg.max) return;
    for (const r of Array.from(rules)) {
      if (found.length >= arg.max) return;
      if (r instanceof CSSStyleRule && r.selectorText.includes(':hover') && /color|background|opacity|display|visibility/i.test(r.style.cssText)) {
        for (const part of r.selectorText.split(',')) {
          const at = part.indexOf(':hover');
          if (at < 0) continue;
          const base = part.slice(0, at).trim();
          if (!base || /[>+~]$/.test(base)) continue;
          let el: Element | null = null;
          try {
            el = Array.from(document.querySelectorAll(base)).find((e) => {
              const b = e.getBoundingClientRect();
              return b.width >= 4 && b.height >= 4 && getComputedStyle(e).visibility !== 'hidden';
            }) ?? null;
          } catch { el = null; }
          if (el && !found.includes(el) && el !== document.body && el !== document.documentElement) { found.push(el); break; }
        }
      }
      walk((r as CSSGroupingRule).cssRules, depth + 1);
    }
  };
  for (const sh of Array.from(document.styleSheets)) {
    let rules: CSSRuleList | undefined;
    try { rules = sh.cssRules; } catch { rules = undefined; }
    walk(rules, 0);
  }
  (window as unknown as Record<string, Element[]>)[HOVER_KEY] = found;
  return found.map((e, i) => ({ i, name: ((e as HTMLElement).innerText || e.getAttribute('aria-label') || e.localName).replace(/\s+/g, ' ').trim().slice(0, 40) }));
}

/** Runs in the page: scrolls a kept element into view and gives the point to put the pointer on. */
export function placeHoverSpot(i: number): { x: number; y: number } | null {
  const el = ((window as unknown as Record<string, Element[] | undefined>)[HOVER_KEY] ?? [])[i];
  if (!el || !el.isConnected) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  const b = el.getBoundingClientRect();
  if (b.width < 2 || b.height < 2) return null;
  return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
}

/** Runs in the page: forgets the kept elements. */
export function dropHoverSpots(): void {
  delete (window as unknown as Record<string, unknown>)[HOVER_KEY];
}

/** The plain (top-document) targets axe could not decide in a run. */
function undecided(run: AxeRun): string[] {
  const out: string[] = [];
  for (const v of run.incomplete ?? []) {
    if (!(CONTRAST_RULES as readonly string[]).includes(v.id)) continue;
    for (const n of v.nodes) {
      const t: unknown = n.target;
      if (typeof t === 'string' && t.trim() && !t.includes(' >>> ')) out.push(t.trim());
    }
  }
  return out.slice(0, 20);
}

/**
 * Runs in the page (self-contained). Batch 18, round 2: text axe could not decide inside a region the page opened
 * (a modal dialog's text sits over the page and its backdrop, which axe reads as overlap) decided from the styles when
 * they leave no doubt: the text's colour against the solid fills of its ancestors up to an opened dialog (whose own
 * fill is what the text sits on), none with a picture, gradient, filter, blend or partial opacity. Returns the failing
 * ones with a summary; anything else is left undecided.
 */
export function styleDecided(targets: string[]): [string, string][] {
  const cvs = document.createElement('canvas');
  cvs.width = 1;
  cvs.height = 1;
  const g = cvs.getContext('2d', { willReadFrequently: true });
  const rgb = (c: string): number[] | null => {
    if (!g || !c || /url\(|gradient\(/.test(c)) return null;
    g.fillStyle = '#010203';
    g.fillStyle = c;
    if (g.fillStyle === '#010203' && !/^#010203$/i.test(c.trim())) return null;
    g.clearRect(0, 0, 1, 1);
    g.fillRect(0, 0, 1, 1);
    const d = g.getImageData(0, 0, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!, d[3]! / 255];
  };
  const lum = (c: number[]) => {
    const f = (v: number) => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]!) + 0.7152 * f(c[1]!) + 0.0722 * f(c[2]!);
  };
  const over = (t: number[], b: number[]) => [0, 1, 2].map((i) => t[i]! * t[3]! + b[i]! * (1 - t[3]!)).concat(1);
  const hex = (c: number[]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const out: [string, string][] = [];
  for (const sel of targets) {
    let el: Element | null = null;
    try { el = document.querySelector(sel); } catch { el = null; }
    if (!el || !el.closest('dialog[open], [popover]:popover-open')) continue;
    const cs = getComputedStyle(el);
    const fg = rgb(cs.color);
    if (!fg) continue;
    const chain: Element[] = [];
    let clean = true;
    for (let a: Element | null = el; a; a = a.parentElement) {
      const as = getComputedStyle(a);
      if (as.backgroundImage !== 'none' || (as.filter && as.filter !== 'none') || as.mixBlendMode !== 'normal' || Number(as.opacity) < 1) { clean = false; break; }
      chain.unshift(a);
      if (a.matches('dialog[open], [popover]:popover-open')) break;
    }
    if (!clean) continue;
    let back = [255, 255, 255, 1];
    for (const a of chain) {
      const bg = rgb(getComputedStyle(a).backgroundColor);
      if (bg && bg[3]! > 0) back = over(bg, back);
    }
    const shown = over(fg, back);
    const [hi, lo] = [lum(shown), lum(back)].sort((x, y) => y - x) as [number, number];
    const ratio = (hi + 0.05) / (lo + 0.05);
    const size = parseFloat(cs.fontSize) || 16;
    const large = size >= 24 || (size >= 18.66 && (Number(cs.fontWeight) || 400) >= 700);
    const need = large ? 3 : 4.5;
    if (ratio < need) out.push([sel, `Element has insufficient color contrast of ${ratio.toFixed(2)} (foreground color: ${hex(shown)}, background color: ${hex(back)}, font size: ${size}px). Expected contrast ratio of ${need}:1`]);
  }
  return out;
}

export const stateTextProbe: PageProbe = {
  id: 'state-text-contrast',
  criteria: ['1.4.3'],
  kind: 'interaction',
  tier: 'deep',
  // Listed, not scored (like the other deep tests) until a gold-standard mutation verifies it.
  scored: false,
  isolate: true,
  initScript: LATE_TEXT_INIT_SCRIPT,
  // A page that puts its content in late sets its timers then: it is waited for first (bounded), as for the other tests.
  waitFor: { content: true },
  timeoutMs: 45_000,
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    if (!ctx.axeSource) throw new ProbeNotTestable('axe is not available to this test');
    const page = ctx.page;
    const out: ProbeFinding[] = [];
    const notes: string[] = [];
    const rest = failing(await contrastRun(ctx));
    // D13: text shown later. The page's one-shot timers are followed (a timer that sets another is followed too, three
    // rounds at most), and the second look is never earlier than LATE_MIN_MS after the first: text revealed by an
    // animation frame loop or a CSS animation delay of a few seconds is shown by then. Bounded by LATE_TIMER_MAX_MS.
    const t0 = Date.now();
    let left = await page.evaluate(lateTimersLeft, LATE_TIMER_MAX_MS).catch(() => -1);
    const waited = left;
    for (let round = 0; round < 3 && left > 0 && Date.now() - t0 + left <= LATE_TIMER_MAX_MS && Date.now() + left + 8000 < ctx.deadline; round++) {
      await page.waitForTimeout(Math.ceil(left) + 400);
      left = await page.evaluate(lateTimersLeft, LATE_TIMER_MAX_MS).catch(() => -1);
    }
    if (left > 0) notes.push('the page still had timers pending when the test looked again, so text they show later was not read');
    const rest_ms = LATE_MIN_MS - (Date.now() - t0);
    if (rest_ms > 0 && Date.now() + rest_ms + 8000 < ctx.deadline) await page.waitForTimeout(rest_ms);
    if (Date.now() + 6000 < ctx.deadline) {
      const later = failing(await contrastRun(ctx));
      for (const [target, why] of later) {
        if (rest.has(target) || out.length >= MAX_FAILURES) continue;
        rest.set(target, why);
        out.push({ criterion: '1.4.3', status: 'failed', target, data: { kind: 'shown' }, detail: `Text the page shows a few seconds after it loads has too little contrast: ${why}` });
      }
    }
    // D14: regions a control opens.
    const list = await page.evaluate(openers, { key: OPENER_KEY, max: OPENERS + 1 }).catch(() => [] as { ref: number; name: string }[]);
    if (list.length > OPENERS) notes.push(`more than ${OPENERS} controls open something on this page; the first ${OPENERS} were opened`);
    for (const o of list.slice(0, OPENERS)) {
      if (ctx.signal.aborted || Date.now() > ctx.deadline - 9000) {
        notes.push('the time for this test ran out before every control was opened');
        break;
      }
      const mark = ctx.guard.mark();
      if (!(await page.evaluate(pressOpener, { key: OPENER_KEY, ref: o.ref }).catch(() => false))) continue;
      await page.waitForTimeout(400);
      if (ctx.guard.since(mark).some((e) => e.kind === 'navigation')) {
        notes.push(`pressing "${o.name}" tried to load another page, so the test stopped there`);
        break;
      }
      const opened = failing(await contrastRun(ctx));
      for (const [target, why] of opened) {
        if (rest.has(target) || out.length >= MAX_FAILURES) continue;
        rest.set(target, why);
        out.push({ criterion: '1.4.3', status: 'failed', target, data: { kind: 'shown' }, detail: `Text shown when "${o.name}" is opened has too little contrast: ${why}` });
      }
      // Close it again: Escape, else the same press.
      await page.keyboard?.press('Escape').catch(() => {});
      await page.waitForTimeout(200);
      if ((await page.evaluate(openerOpen, { key: OPENER_KEY, ref: o.ref }).catch(() => null)) === true) {
        await page.evaluate(pressOpener, { key: OPENER_KEY, ref: o.ref }).catch(() => false);
        await page.waitForTimeout(300);
      }
      if ((await page.evaluate(openerOpen, { key: OPENER_KEY, ref: o.ref }).catch(() => null)) === true) {
        notes.push(`"${o.name}" could not be closed again, so the controls after it were not opened`);
        break;
      }
    }
    // Native dialogs the page holds closed (break-it V16): their content is shown when a script opens them.
    const dialogs = await page.evaluate(() => Array.from(document.querySelectorAll('dialog')).filter((d) => !d.open).length, undefined).catch(() => 0);
    for (let k = 0; k < Math.min(dialogs, 2) && Date.now() < ctx.deadline - 8000; k++) {
      const opened = await page.evaluate((i) => {
        const d = Array.from(document.querySelectorAll('dialog')).filter((x) => !x.open)[0];
        if (!d) return '';
        try { d.showModal(); } catch { try { d.show(); } catch { return ''; } }
        d.setAttribute('data-grnted-opened', String(i));
        return (d.getAttribute('aria-label') || d.querySelector('h1, h2, h3')?.textContent || 'a dialog').replace(/\s+/g, ' ').trim().slice(0, 40);
      }, k).catch(() => '');
      if (!opened) break;
      await page.waitForTimeout(250);
      const run = await contrastRun(ctx);
      const shown = failing(run);
      // Text axe could not decide in the opened dialog (it reads the backdrop as overlap): from the styles (round 2).
      for (const [t, why] of await page.evaluate(styleDecided, undecided(run)).catch(() => [] as [string, string][])) if (!shown.has(t)) shown.set(t, why);
      for (const [target, why] of shown) {
        if (rest.has(target) || out.length >= MAX_FAILURES) continue;
        rest.set(target, why);
        out.push({ criterion: '1.4.3', status: 'failed', target, data: { kind: 'shown' }, detail: `Text in the dialog “${opened}”, shown when the page opens it, has too little contrast: ${why}` });
      }
      await page.evaluate((i) => { const d = document.querySelector(`dialog[data-grnted-opened="${i}"]`) as HTMLDialogElement | null; d?.close(); d?.removeAttribute('data-grnted-opened'); }, k).catch(() => {});
    }
    // Pointer-over states (batch 18, round 2): elements a :hover rule recolours or reveals content for, pointed at one by
    // one (at most four); text failing only while pointed at is reported. The pointer never presses.
    if (page.mouse && Date.now() < ctx.deadline - 8000) {
      const spots = await page.evaluate(hoverSpots, { max: 4 }).catch(() => [] as HoverSpot[]);
      for (const spot of spots) {
        if (ctx.signal.aborted || Date.now() > ctx.deadline - 6000 || out.length >= MAX_FAILURES) break;
        const at = await page.evaluate(placeHoverSpot, spot.i).catch(() => null);
        if (!at) continue;
        await page.mouse.move(at.x, at.y);
        await page.waitForTimeout(300);
        const run = await contrastRun(ctx);
        const shown = failing(run);
        for (const [t, why] of await page.evaluate(styleDecided, undecided(run)).catch(() => [] as [string, string][])) if (!shown.has(t)) shown.set(t, why);
        for (const [target, why] of shown) {
          if (rest.has(target) || out.length >= MAX_FAILURES) continue;
          rest.set(target, why);
          out.push({ criterion: '1.4.3', status: 'failed', target, data: { kind: 'state' }, detail: `Text shown while the pointer is over “${spot.name}” has too little contrast: ${why}` });
        }
        await page.mouse.move(0, 0);
        await page.waitForTimeout(200);
      }
      await page.evaluate(dropHoverSpots, undefined).catch(() => {});
    }
    if (out.length) return out;
    void waited;
    return [{ criterion: '1.4.3', status: 'no_failures_found', detail: ['the text shown later and in opened regions has enough contrast where axe could decide it', ...notes].join('; ') }];
  },
};
