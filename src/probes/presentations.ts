// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The presentations a page defines besides the one the tests read at rest (batch 18, visual lane, D0 to D2;
// docs/atlas/visual.md). The engine judges a page in light, default colours. A page can also define a dark colour
// scheme the visitor's system setting selects (`prefers-color-scheme: dark`, `light-dark()`, a `color-scheme` that
// offers dark with the browser's own colours), and a theme a control on the page switches (a class, an attribute or a
// `:has()` state at the root). WCAG 1.4.3 and 1.4.11 have no exception for a presentation the page itself offers, so
// text and controls are judged there too, with the same tests, thresholds and exemptions.
//
// Cheap where there is nothing: one read of the page's style sheets (`presentationInventory`, a few ms) says which
// presentations exist; a page that defines none is never switched. What the sheets cannot tell (a sheet from another
// site the page may not read) is counted, never guessed.
// Engine core: no Node-only imports.
import type { PageLike } from '../types.js';
import type { ProbeContext } from './types.js';

/** What the page's style sheets define besides the presentation at rest. */
export interface Inventory {
  /** A dark colour scheme the visitor's system setting selects: why (at most 4 short reasons). */
  dark: string[];
  /** Rules whose selector needs a class, attribute or `:has()` state of html or body that does not hold now, and set colours. */
  rootThemes: string[];
  /** Rules inside `@media (forced-colors: active)` (or the old `-ms-high-contrast`) and `forced-color-adjust: none` declarations. */
  forced: { rules: number; keep: number };
  /** Widths (CSS px) the page's width media queries name, sorted. */
  breakpoints: number[];
  /**
   * Batch 18, round 2: width ranges (CSS px, `hi` 0 for none) inside which a width media or container query paints
   * differently (colours, backgrounds, pictures, opacity, filters). `container`: the range is a container's width.
   */
  paintRanges?: { lo: number; hi: number; container?: true }[];
  /** Style sheets the page may not read (another site's, without CORS). */
  unreadable: number;
  /** Rules read. */
  rules: number;
}

/** Most rules read (a page with more is read up to here; the inventory says so through `rules`). */
export const INVENTORY_MAX_RULES = 20_000;

/**
 * Runs in the page (self-contained). Reads the document's style sheets, the sheets they import, adopted sheets and the
 * sheets of open shadow roots, and returns what presentations they define. Reads only.
 */
export function presentationInventory(maxRules: number): Inventory {
  const out: Inventory = { dark: [], rootThemes: [], forced: { rules: 0, keep: 0 }, breakpoints: [], unreadable: 0, rules: 0, paintRanges: [] };
  const PAINTISH = /(^|-)(color|background|background-image|opacity|filter|fill|stroke)(-|$)|^--/;
  const paints = (decl: CSSStyleDeclaration): boolean => {
    for (let i = 0; i < decl.length; i++) if (PAINTISH.test(decl[i]!)) return true;
    return false;
  };
  /** The width range a condition names ([lo, hi]; hi 0 for none), or null when it names no width. */
  const rangeOf = (cond: string): { lo: number; hi: number } | null => {
    let lo = 0;
    let hi = 0;
    let any = false;
    const re = /(min-width|max-width|width\s*>=?|width\s*<=?)\s*:?\s*([\d.]+)(px|em|rem)/gi;
    for (let m = re.exec(cond); m; m = re.exec(cond)) {
      const v = parseFloat(m[2]!) * (m[3]!.toLowerCase() === 'px' ? 1 : 16);
      const k = m[1]!.toLowerCase().replace(/\s+/g, '');
      any = true;
      if (k === 'min-width' || k.startsWith('width>')) lo = Math.max(lo, v);
      else hi = hi ? Math.min(hi, v) : v;
    }
    return any ? { lo, hi } : null;
  };
  let range: { lo: number; hi: number; container?: true } | null = null;
  const addRange = () => {
    if (!range || out.paintRanges!.length >= 12) return;
    const r = range;
    if (!out.paintRanges!.some((x) => x.lo === r.lo && x.hi === r.hi && !!x.container === !!r.container)) out.paintRanges!.push({ ...r });
  };
  const COLOURISH = /(^|-)(color|background|border|outline|fill|stroke|shadow)(-|$)|^--/;
  const sets = (decl: CSSStyleDeclaration): boolean => {
    for (let i = 0; i < decl.length; i++) if (COLOURISH.test(decl[i]!)) return true;
    return false;
  };
  const bps = new Set<number>();
  const addDark = (why: string) => {
    if (out.dark.length < 4 && !out.dark.includes(why)) out.dark.push(why);
  };
  const widths = (cond: string) => {
    const re = /(min-width|max-width|width)\s*(?::|[<>]=?)\s*([\d.]+)(px|em|rem)/gi;
    for (let m = re.exec(cond); m; m = re.exec(cond)) {
      const v = parseFloat(m[2]!) * (m[3]!.toLowerCase() === 'px' ? 1 : 16);
      if (v >= 200 && v <= 3000) bps.add(Math.round(v));
    }
  };
  const root = document.documentElement;
  const body = document.body;
  const ROOT_HEAD = /^\s*(html|:root|body)?((?:\.[\w-]+|\[[^\]]+\]|:has\([^)]*\)|:not\([^)]*\))+)/i;
  const dormant = (selector: string): boolean => {
    for (const part of selector.split(',')) {
      const m = ROOT_HEAD.exec(part);
      if (!m) continue;
      const head = `${m[1] ?? ''}${m[2] ?? ''}`.trim();
      // Only a state written on the root or body: html.x, :root[...], body.x, or a bare class or attribute that is
      // followed by a descendant (the theme class sits on an ancestor of what it restyles).
      const named = !!m[1];
      const rest = part.slice(m[0].length);
      if (!named && !/^\s+\S/.test(rest)) continue;
      try {
        if (root.matches(head) || (body && body.matches(head))) continue;
        // A bare class or attribute is a dormant state only when nothing on the page has it now (`.dark`, not `.menu`).
        if (!named && document.querySelector(head)) continue;
      } catch {
        continue;
      }
      return true;
    }
    return false;
  };
  const visit = (rules: CSSRuleList, inForced: boolean, inDark: boolean) => {
    for (let i = 0; i < rules.length && out.rules < maxRules; i++) {
      const r = rules[i]!;
      out.rules++;
      const media = (r as CSSMediaRule).media;
      const containerCond = !media && typeof (r as CSSConditionRule).conditionText === 'string' && /container/i.test(r.constructor?.name ?? '') ? (r as CSSConditionRule).conditionText : '';
      if ((media || containerCond) && (r as CSSMediaRule).cssRules) {
        const cond = media ? media.mediaText || '' : containerCond;
        if (media) widths(cond);
        const forced = /forced-colors\s*:\s*active|-ms-high-contrast/i.test(cond);
        const dark = /prefers-color-scheme\s*:\s*dark/i.test(cond);
        const outer = range;
        const here = rangeOf(cond);
        if (here) range = media ? here : { ...here, container: true };
        visit((r as CSSMediaRule).cssRules, inForced || forced, inDark || dark);
        range = outer;
        continue;
      }
      const imp = (r as CSSImportRule).styleSheet;
      if (imp) {
        try {
          visit(imp.cssRules, inForced, inDark);
        } catch {
          out.unreadable++;
        }
        continue;
      }
      const nested = (r as CSSGroupingRule).cssRules;
      const style = (r as CSSStyleRule).style;
      if (style) {
        const text = style.cssText;
        if (inDark && sets(style)) addDark('prefers-color-scheme: dark');
        if (/light-dark\(/i.test(text)) addDark('light-dark()');
        const scheme = style.getPropertyValue('color-scheme');
        if (scheme && /dark/i.test(scheme) && /light|normal/i.test(scheme)) addDark(`color-scheme: ${scheme.trim().slice(0, 30)}`);
        if (inForced) out.forced.rules++;
        if (range && !inDark && !inForced && paints(style)) addRange();
        if (/forced-color-adjust\s*:\s*none/i.test(text)) out.forced.keep++;
        const sel = (r as CSSStyleRule).selectorText;
        if (sel && !inDark && !inForced && out.rootThemes.length < 12 && sets(style) && dormant(sel) && !out.rootThemes.includes(sel)) out.rootThemes.push(sel.slice(0, 160));
      }
      if (nested && nested.length) visit(nested, inForced, inDark);
    }
  };
  const sheets: CSSStyleSheet[] = [];
  const seen = new Set<CSSStyleSheet>();
  const add = (list: ArrayLike<CSSStyleSheet> | undefined) => {
    if (!list) return;
    for (let i = 0; i < list.length; i++) {
      const s = list[i]!;
      if (!seen.has(s)) {
        seen.add(s);
        sheets.push(s);
      }
    }
  };
  add(document.styleSheets as unknown as ArrayLike<CSSStyleSheet>);
  add((document as Document & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets);
  // Open shadow roots, nested ones included (Sol r1, F1).
  let n = 0;
  const roots: (Document | ShadowRoot)[] = [document];
  while (roots.length && n < 20_000) {
    const r = roots.shift()!;
    const walker = document.createTreeWalker(r, NodeFilter.SHOW_ELEMENT);
    for (let e = walker.nextNode() as Element | null; e && n < 20_000; e = walker.nextNode() as Element | null, n++) {
      const sr = (e as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (sr) {
        add(sr.styleSheets as unknown as ArrayLike<CSSStyleSheet>);
        add((sr as ShadowRoot & { adoptedStyleSheets?: CSSStyleSheet[] }).adoptedStyleSheets);
        roots.push(sr);
      }
    }
  }
  for (const s of sheets) {
    if (s.disabled) continue;
    const m = s.media?.mediaText || '';
    if (/^\s*print\s*$/i.test(m)) continue;
    let rules: CSSRuleList;
    try {
      rules = s.cssRules;
    } catch {
      out.unreadable++;
      continue;
    }
    const forced = /forced-colors\s*:\s*active|-ms-high-contrast/i.test(m);
    const dark = /prefers-color-scheme\s*:\s*dark/i.test(m);
    if (m) widths(m);
    visit(rules, forced, dark);
  }
  const meta = document.querySelector('meta[name="color-scheme" i]');
  const mc = meta?.getAttribute('content') ?? '';
  if (/dark/i.test(mc) && /light|normal/i.test(mc)) addDark(`meta color-scheme: ${mc.trim().slice(0, 30)}`);
  out.breakpoints = [...bps].sort((a, b) => a - b).slice(0, 40);
  return out;
}

/** The inventory of the page as it is now; null when it could not be read. Never throws. */
export async function readInventory(ctx: Pick<ProbeContext, 'page'>): Promise<Inventory | null> {
  try {
    return await ctx.page.evaluate(presentationInventory, INVENTORY_MAX_RULES);
  } catch {
    return null;
  }
}

/** Runs in the page: whether the dark preference holds now. */
function prefersDark(): boolean {
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

/** Runs in the page: transitions and animations the switch started are finished (their end state is what people see). */
function finishMotion(): number {
  let n = 0;
  try {
    for (const a of document.getAnimations()) {
      const t = a.effect?.getComputedTiming().endTime;
      if (typeof t === 'number' && Number.isFinite(t)) {
        a.finish();
        n++;
      }
    }
  } catch {
    // an engine without getAnimations: the wait below is all there is
  }
  return n;
}

/** Settle time after switching the colour scheme (a page that animates its colour change has finished it by then). */
export const SCHEME_SETTLE_MS = 300;

/**
 * Shows the page with the visitor's system set to dark, runs `fn` and shows it as before. Null when the browser cannot
 * switch (no `emulateMedia`, or the page still reads light afterwards). A page that cannot be confirmed switched back
 * is not given to later tests (`discardPage`). `fn`'s errors propagate after the page is switched back.
 */
export async function inDarkScheme<T>(ctx: Pick<ProbeContext, 'page' | 'discardPage'>, fn: () => Promise<T>): Promise<{ value: T } | null> {
  const page: PageLike = ctx.page;
  if (!page.emulateMedia) return null;
  try {
    await page.emulateMedia({ colorScheme: 'dark' });
  } catch {
    return null;
  }
  try {
    if (!(await page.evaluate(prefersDark, undefined).catch(() => false))) return null;
    await page.waitForTimeout(SCHEME_SETTLE_MS);
    await page.evaluate(finishMotion, undefined).catch(() => 0);
    return { value: await fn() };
  } finally {
    let back = false;
    try {
      await page.emulateMedia({ colorScheme: 'light' });
      back = !(await page.evaluate(prefersDark, undefined));
      await page.waitForTimeout(SCHEME_SETTLE_MS);
      await page.evaluate(finishMotion, undefined).catch(() => 0);
    } catch {
      back = false;
    }
    if (!back) ctx.discardPage?.();
  }
}

/** Words for findings: where the failure shows. */
export const DARK_WHERE = "in the page's dark colour scheme (shown when the visitor's system is set to dark)";

// ---------------------------------------------------------------------------------------------
// D2: a theme a control on the page switches.

/** Where the theme controls found are kept on the window. */
const THEME_KEY = '__grntedTheme';

/** Theme controls tried per page, at most. */
export const THEME_TRIES = 3;

/**
 * Runs in the page (self-contained): controls that may switch the page's colour theme, in page order, at most `max`:
 * a button, link button, switch, check box or radio button that is shown and enabled, whose name, label, title or
 * pressed state speaks of a theme (dark, night, light mode, colour scheme, appearance, theme). The name only picks
 * what to try: pressing proves it (`inRootTheme`). Kept on the window by index.
 */
export function themeControls(arg: { key: string; max: number }): { ref: number; name: string }[] {
  const WORDS = /\b(dark|night)\b|\blight (mode|theme)\b|\btheme\b|\bcolou?r (mode|scheme|theme)\b|\bappearance\b|\bmode (sombre|oscuro)\b/i;
  const SEL = 'button, [role="button"], [role="switch"], input[type="checkbox"], input[type="radio"], [aria-pressed], select';
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return (r.width > 0 && r.height > 0 && cs.visibility !== 'hidden') || ((e as HTMLInputElement).labels?.length ?? 0) > 0;
  };
  const nameOf = (e: Element): string => {
    const parts = [e.getAttribute('aria-label') ?? '', e.getAttribute('title') ?? '', (e as HTMLElement).innerText ?? e.textContent ?? ''];
    const lab = e.getAttribute('aria-labelledby');
    if (lab) for (const id of lab.split(/\s+/)) parts.push(document.getElementById(id)?.textContent ?? '');
    const labels = (e as HTMLInputElement).labels;
    if (labels) for (let i = 0; i < labels.length; i++) parts.push(labels[i]!.textContent ?? '');
    const img = e.querySelector('img[alt], svg title');
    if (img) parts.push(img.getAttribute('alt') ?? img.textContent ?? '');
    return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, 80);
  };
  const out: Element[] = [];
  for (const e of Array.from(document.querySelectorAll(SEL))) {
    if (out.length >= arg.max) break;
    if ((e as HTMLButtonElement).disabled || e.getAttribute('aria-disabled') === 'true' || !shown(e)) continue;
    if (e.closest('form[action]') && (e as HTMLButtonElement).type === 'submit') continue;
    // A theme picker (select): one of its options names a dark or night theme.
    if (e.localName === 'select') {
      const opts = Array.from((e as HTMLSelectElement).options);
      if (WORDS.test(nameOf(e).replace(/\s+/g, ' ').slice(0, 0) + (((e as HTMLSelectElement).labels?.[0]?.textContent ?? '') + ' ' + (e.getAttribute('aria-label') ?? '') + ' ' + (e.getAttribute('name') ?? '') + ' ' + (e.id ?? ''))) || opts.some((o) => /\b(dark|night)\b/i.test(o.textContent ?? ''))) {
        if (opts.some((o, i) => i !== (e as HTMLSelectElement).selectedIndex && /\b(dark|night)\b/i.test(o.textContent ?? ''))) out.push(e);
      }
      continue;
    }
    if (WORDS.test(nameOf(e))) out.push(e);
  }
  (window as unknown as Record<string, Element[]>)[arg.key] = out;
  return out.map((e, ref) => ({ ref, name: nameOf(e) }));
}

/**
 * Runs in the page: presses a kept theme control (a click, as a pointer or Enter would). A select is set to its dark
 * option (its first choice, as a person picks it: the change and input events fire), and set back on the next press.
 */
export function pressTheme(arg: { key: string; ref: number }): boolean {
  const el = ((window as unknown as Record<string, Element[]>)[arg.key] ?? [])[arg.ref] as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  if (el.localName === 'select') {
    const sel = el as HTMLSelectElement & { __grntedWas?: number };
    if (sel.__grntedWas === undefined) {
      const dark = Array.from(sel.options).findIndex((o, i) => i !== sel.selectedIndex && /\b(dark|night)\b/i.test(o.textContent ?? ''));
      if (dark < 0) return false;
      sel.__grntedWas = sel.selectedIndex;
      sel.selectedIndex = dark;
    } else {
      sel.selectedIndex = sel.__grntedWas;
      delete sel.__grntedWas;
    }
    sel.dispatchEvent(new Event('input', { bubbles: true }));
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }
  el.click();
  return true;
}

/** What a theme switch changes: the root's and body's classes and attributes, and the colours of the page's text. */
export interface ThemeState { root: string; colours: string[]; storage: [string, string][]; session: [string, string][] }

/** Runs in the page (self-contained): the state a theme switch changes (up to 60 text elements' colours). */
export function themeState(): ThemeState {
  const attrs = (e: Element | null) => (e ? Array.from(e.attributes).filter((a) => a.name !== 'style' || true).map((a) => `${a.name}=${a.value}`).sort().join(' ') : '');
  const checked = Array.from(document.querySelectorAll('input[type="checkbox"], input[type="radio"]')).slice(0, 50).map((i) => ((i as HTMLInputElement).checked ? '1' : '0')).join('');
  const colours: string[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  const seen = new Set<Element>();
  for (let n = walker.nextNode(); n && colours.length < 60; n = walker.nextNode()) {
    const p = n.parentElement;
    if (!p || seen.has(p) || !(n.nodeValue ?? '').trim()) continue;
    seen.add(p);
    const cs = getComputedStyle(p);
    colours.push(`${cs.color}/${cs.backgroundColor}`);
  }
  const bodyCs = document.body ? getComputedStyle(document.body) : null;
  if (bodyCs) colours.push(`${bodyCs.color}/${bodyCs.backgroundColor}`);
  const dump = (s: Storage | null): [string, string][] => {
    const out: [string, string][] = [];
    try {
      if (!s) return out;
      for (let i = 0; i < s.length && i < 5000; i++) {
        const k = s.key(i);
        if (k !== null) out.push([k, s.getItem(k) ?? '']);
      }
    } catch {
      // storage blocked
    }
    return out.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  };
  return {
    root: `${attrs(document.documentElement)}|${attrs(document.body)}|${checked}`,
    colours,
    storage: dump(window.localStorage),
    session: dump(window.sessionStorage),
  };
}

/** Runs in the page: puts local and session storage back as `themeState` read them. */
export function restoreStorage(arg: { storage: [string, string][]; session: [string, string][] }): void {
  // Put back by difference (Sol r1, finding 10): keys the press added go, keys it changed get their value back; nothing
  // else is touched.
  const put = (s: Storage, list: [string, string][]) => {
    try {
      const was = new Map(list);
      for (let i = s.length - 1; i >= 0; i--) {
        const k = s.key(i);
        if (k !== null && !was.has(k)) s.removeItem(k);
      }
      for (const [k, v] of list) if (s.getItem(k) !== v) s.setItem(k, v);
    } catch {
      // storage blocked
    }
  };
  put(window.localStorage, arg.storage);
  put(window.sessionStorage, arg.session);
}

/** Share of text colours a theme switch must change (most of the page restyled, not one widget). */
export const THEME_MIN_SHARE = 0.4;

const changedShare = (a: readonly string[], b: readonly string[]) => {
  const n = Math.min(a.length, b.length);
  if (!n) return 0;
  let c = 0;
  for (let i = 0; i < n; i++) if (a[i] !== b[i]) c++;
  return c / n;
};

/**
 * Batch 18, D2: shows the page in a theme a control on it switches, runs `fn`, and puts the page back. Only when the
 * style sheets define a theme that a class, attribute or `:has()` state at the root selects (`Inventory.rootThemes`).
 * A candidate (`themeControls`) is pressed; it is a theme switch when the root's state changed and most of the page's
 * text colours with it, and the guard saw no navigation. Then `fn` runs; the control is pressed again (up to twice,
 * for a three-way switch) until the root state and colours are as they were, and the page's storage is put back. A
 * page that cannot be put back is not given to later tests (`discardPage`). Null when no control switches a theme.
 */
export async function inRootTheme<T>(ctx: Pick<ProbeContext, 'page' | 'guard' | 'discardPage' | 'deadline' | 'signal'>, inv: Inventory, fn: (name: string) => Promise<T>): Promise<{ value: T; name: string } | null> {
  // Batch 18, round 2: a theme a script applies (inline custom properties or color-scheme on the root) has no dormant
  // rule to find; a control named for a theme is tried whatever the style sheets hold (proof by effect as before).
  void inv;
  const page = ctx.page;
  let cands: { ref: number; name: string }[];
  try {
    cands = await page.evaluate(themeControls, { key: THEME_KEY, max: THEME_TRIES });
  } catch {
    return null;
  }
  // Whatever a press changes beyond what is put back (a widget's own paint, scripts' state), the page is not given to
  // later tests once anything was pressed (Sol r1, finding 9).
  let pressedAny = false;
  try {
  for (const c of cands) {
    if (ctx.signal.aborted || Date.now() > ctx.deadline - 6000) return null;
    const before = await page.evaluate(themeState, undefined).catch(() => null);
    if (!before) return null;
    // Storage too large to put back exactly: no press.
    if (before.storage.length >= 5000 || before.session.length >= 5000) return null;
    pressedAny = true;
    const mark = ctx.guard.mark();
    if (!(await page.evaluate(pressTheme, { key: THEME_KEY, ref: c.ref }).catch(() => false))) continue;
    await page.waitForTimeout(SCHEME_SETTLE_MS);
    await page.evaluate(finishMotion, undefined).catch(() => 0);
    const navigated = ctx.guard.since(mark).some((e) => e.kind === 'navigation');
    const after = await page.evaluate(themeState, undefined).catch(() => null);
    if (navigated || !after) {
      ctx.discardPage?.();
      return null;
    }
    const isTheme = after.root !== before.root && changedShare(before.colours, after.colours) >= THEME_MIN_SHARE;
    let value: T | undefined;
    let failed: unknown;
    if (isTheme) {
      try {
        value = await fn(c.name);
      } catch (e) {
        failed = e;
      }
    }
    // Put the page back: press again (a three-way switch may need two more), then the storage.
    let back = after.root === before.root && changedShare(before.colours, after.colours) === 0;
    for (let i = 0; i < 2 && !back; i++) {
      if (!(await page.evaluate(pressTheme, { key: THEME_KEY, ref: c.ref }).catch(() => false))) break;
      await page.waitForTimeout(SCHEME_SETTLE_MS);
      await page.evaluate(finishMotion, undefined).catch(() => 0);
      const now = await page.evaluate(themeState, undefined).catch(() => null);
      back = !!now && now.root === before.root && changedShare(before.colours, now.colours) === 0;
    }
    await page.evaluate(restoreStorage, { storage: before.storage, session: before.session }).catch(() => {});
    if (!back) ctx.discardPage?.();
    if (failed) throw failed;
    if (isTheme) return { value: value as T, name: c.name };
    if (!back) return null;
  }
  return null;
  } finally {
    if (pressedAny) ctx.discardPage?.();
  }
}

/** Words for findings: the theme a control switches. */
export const themeWhere = (name: string) => `in the page's own colour theme that "${name.slice(0, 40)}" switches to`;

/**
 * The other presentations a page defines, each shown in turn while `fn` measures it (`where` names it for the
 * findings): the dark colour scheme, then a theme a control switches. Never throws for a presentation that cannot be
 * shown; `fn`'s errors propagate.
 */
export async function eachPresentation<T>(ctx: Pick<ProbeContext, 'page' | 'guard' | 'discardPage' | 'deadline' | 'signal'> & { viewport?: { width: number; height: number } }, fn: (where: string) => Promise<T[]>): Promise<T[]> {
  const inv = await readInventory(ctx);
  if (!inv) return [];
  const out: T[] = [];
  if (inv.dark.length) {
    const r = await inDarkScheme(ctx, () => fn(DARK_WHERE));
    if (r) out.push(...r.value);
  }
  if (Date.now() < ctx.deadline - 6000) {
    const r = await inRootTheme(ctx, inv, (name) => fn(themeWhere(name)));
    if (r) out.push(...r.value);
  }
  for (const w of paintWidths(inv)) {
    if (ctx.signal.aborted || Date.now() > ctx.deadline - 6000 || !ctx.viewport) break;
    const r = await inWidth(ctx as typeof ctx & { viewport: { width: number; height: number } }, w, () => fn(widthWhere(w)));
    if (r) out.push(...r.value);
  }
  return out;
}

/** Batch 18, round 2: the most window widths looked at besides the desktop and phone ones. */
export const PAINT_WIDTHS_MAX = 2;

/**
 * The window widths inside the page's repainting width ranges (`Inventory.paintRanges`) that the desktop (1280) and
 * phone (390) looks do not see: the middle of each such range (a container's range is taken as the window's, plus
 * 160 px of page margins), at most `PAINT_WIDTHS_MAX`, the widest ranges' first. Pure.
 */
export function paintWidths(inv: Pick<Inventory, 'paintRanges'>): number[] {
  const seen = (lo: number, hi: number, w: number) => w >= lo && (hi === 0 || w <= hi);
  const out: number[] = [];
  for (const r of inv.paintRanges ?? []) {
    const lo = Math.max(r.lo, 360);
    const hi = r.hi === 0 ? 1900 : Math.min(r.hi, 1900);
    if (hi - lo < 16) continue;
    let w = Math.round((lo + hi) / 2);
    if (r.container) w = Math.min(1900, w + 160);
    // The desktop and phone looks already see this range.
    if (!r.container && (seen(r.lo, r.hi, 1280) || seen(r.lo, r.hi, 390))) continue;
    if (Math.abs(w - 1280) < 40 || Math.abs(w - 390) < 40 || out.some((x) => Math.abs(x - w) < 60)) continue;
    out.push(w);
    if (out.length >= PAINT_WIDTHS_MAX) break;
  }
  return out;
}

export const widthWhere = (w: number) => `in a window ${w} px wide (the page paints differently between its width breakpoints)`;

/**
 * Runs `fn` with the window `width` px wide (the same height), then puts the window back; a page whose window could
 * not be put back is not given to later tests. Null when the width could not be set. Never throws for that.
 */
export async function inWidth<T>(ctx: Pick<ProbeContext, 'page' | 'discardPage'> & { viewport: { width: number; height: number } }, width: number, fn: () => Promise<T>): Promise<{ value: T } | null> {
  const page = ctx.page;
  if (!page.setViewportSize) return null;
  const { width: w0, height: h0 } = ctx.viewport;
  try {
    await page.setViewportSize({ width, height: h0 });
    await page.waitForTimeout(SCHEME_SETTLE_MS);
  } catch {
    return null;
  }
  try {
    return { value: await fn() };
  } finally {
    let back = false;
    try {
      await page.setViewportSize({ width: w0, height: h0 });
      await page.waitForTimeout(SCHEME_SETTLE_MS);
      back = true;
    } catch {
      back = false;
    }
    if (!back) ctx.discardPage?.();
  }
}
