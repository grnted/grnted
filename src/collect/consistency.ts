// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Per-page facts for the cross-page consistency rules (src/consistency/): the navigation, header
// and footer link lists in order, icon buttons there, search forms, help mechanisms, links in the
// content, site-map links and tables of contents. Desktop only, so every page is compared at the
// same width; read from the DOM (hidden links included), so a menu collapsed behind a button still
// counts. Runs on every scan; no browser interaction, no requests. Engine core: no Node-only imports.
import { HELP_CANDIDATE_PATTERN, SITEMAP_PATTERN } from '../consistency/labels.js';
import type { PageCollector } from '../types.js';

/** Where an element sits relative to the main content. Without a main landmark, header and footer decide. */
export type Place = 'before-main' | 'in-main' | 'after-main' | 'unknown';

export interface ConsistencyLink {
  /** Absolute address as the browser resolved it (normalised later by `linkKey`). */
  href: string;
  /** Simplified accessible name. */
  name: string;
  /** 'text' when the link shows words; 'graphic' when only an image or icon (a logo link). */
  as: 'text' | 'graphic';
}

export interface ConsistencyRegion {
  /** A navigation landmark, or the links of the page header or footer that are outside any navigation. */
  kind: 'nav' | 'header' | 'footer';
  /** The landmark's name (aria-label or aria-labelledby), '' when it has none. */
  label: string;
  place: Place;
  /** Not rendered at this width (display: none, a closed menu). */
  hidden: boolean;
  links: ConsistencyLink[];
  /** Buttons that show only an icon, by the icon they show (`sig`), with their names. */
  icons: { sig: string; name: string }[];
}

export interface ConsistencyHelp {
  href: string;
  name: string;
  place: Place;
  /** Set for a chat widget found by its markup rather than a link (its identity, e.g. 'widget:intercom'). */
  chat?: string;
}

export interface ConsistencySearch {
  place: Place;
  /** The search field's name ('' when it has none). */
  field: string;
  /** The submit button's name ('' when there is no button or it has no name). */
  button: string;
  buttonAs: 'text' | 'graphic' | 'none';
}

export interface ConsistencyFacts {
  /** Primary language subtag of the page ('' when not declared). */
  lang: string;
  regions: ConsistencyRegion[];
  /** Candidate help links outside the main content (and chat widgets anywhere), in page order. */
  help: ConsistencyHelp[];
  search: ConsistencySearch[];
  /** Addresses linked from the content (outside navigation, header and footer), in order. */
  contentLinks: string[];
  /** Addresses of links to a site map, site index or A–Z index. */
  sitemapLinks: string[];
  /** Addresses listed in a table of contents or index of other pages. */
  tocLinks: string[];
  /** The page marks its current step in a process (`aria-current="step"`). */
  step: boolean;
  /** A cap was reached (very large menus): the lists hold the first items only. */
  truncated: boolean;
}

/** Caps per page, so a site with thousands of menu links stays fast. */
export const CONSISTENCY_LIMITS = { regions: 24, linksPerRegion: 300, links: 3000, help: 40, search: 4, contentLinks: 500, sitemapLinks: 10, tocLinks: 300 } as const;

/**
 * Runs inside the page. Self-contained (it is serialized into the browser); the two word patterns
 * come in as arguments so the rules stay in one place (src/consistency/labels.ts).
 */
export function collectConsistency(arg: { help: string; sitemap: string; limits: typeof CONSISTENCY_LIMITS }): ConsistencyFacts {
  const LIM = arg.limits;
  const helpRe = new RegExp(arg.help, 'i');
  const sitemapRe = new RegExp(arg.sitemap, 'i');
  let truncated = false;
  const clean = (s: string | null | undefined, max = 120) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const byIds = (ids: string | null) =>
    (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);
  /** Text and image names inside an element, skipping aria-hidden parts. Bounded by `budget` nodes. */
  const parts = (el: Element) => {
    const text: string[] = [];
    const alt: string[] = [];
    let graphic = false;
    let budget = 200;
    const walk = (node: Element) => {
      for (const n of node.childNodes) {
        if (--budget < 0) return;
        if (n.nodeType === 3) {
          text.push(n.nodeValue ?? '');
          continue;
        }
        if (n.nodeType !== 1) continue;
        const e = n as Element;
        if (SKIP.has(e.tagName) || e.getAttribute('aria-hidden') === 'true') {
          if (e.tagName === 'svg' || e.tagName === 'I' || e.tagName === 'IMG') graphic = true;
          continue;
        }
        const tag = e.tagName.toLowerCase();
        if (tag === 'img' || tag === 'svg' || e.getAttribute('role') === 'img') {
          graphic = true;
          const a = e.getAttribute('aria-label') ?? e.getAttribute('alt') ?? (tag === 'svg' ? e.querySelector('title')?.textContent : '') ?? '';
          if (a.trim()) alt.push(a);
          continue;
        }
        walk(e);
      }
    };
    walk(el);
    return { text: clean(text.join(' '), 200), alt: clean(alt.join(' '), 200), graphic };
  };
  const nameOf = (el: Element, p = parts(el)) =>
    clean(byIds(el.getAttribute('aria-labelledby'))) || clean(el.getAttribute('aria-label')) ||
    clean(`${p.text} ${p.alt}`) || clean(el.getAttribute('title')) ||
    (el.tagName === 'INPUT' ? clean((el as HTMLInputElement).type === 'image' ? el.getAttribute('alt') : (el as HTMLInputElement).value) : '');
  const hiddenEl = (el: Element) => el.getClientRects().length === 0;

  const main = document.querySelector('main, [role="main"]');
  const BANNER = 'header, [role="banner"]';
  const CONTENTINFO = 'footer, [role="contentinfo"]';
  const SECTIONING = 'article, aside, main, nav, section, [role="main"], [role="article"], [role="complementary"], [role="navigation"], [role="region"]';
  /** Page-level header and footer (not the header of an article or section). */
  const pageLevel = (el: Element, role: string) => el.getAttribute('role') === role || !el.parentElement?.closest(SECTIONING);
  const place = (el: Element): 'before-main' | 'in-main' | 'after-main' | 'unknown' => {
    if (main) {
      if (main.contains(el)) return 'in-main';
      return main.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING ? 'before-main' : 'after-main';
    }
    const h = el.closest(BANNER);
    if (h && pageLevel(h, 'banner')) return 'before-main';
    const f = el.closest(CONTENTINFO);
    if (f && pageLevel(f, 'contentinfo')) return 'after-main';
    return el.closest('nav, [role="navigation"], aside, [role="complementary"]') ? 'unknown' : 'in-main';
  };

  // Every link once, in page order, with what it is.
  const here = location.href.split('#')[0];
  const all = [...document.querySelectorAll('a[href]')];
  if (all.length > LIM.links) truncated = true;
  type Info = { el: Element; href: string; name: string; as: 'text' | 'graphic' };
  const info = new Map<Element, Info>();
  for (const a of all.slice(0, LIM.links)) {
    const attr = (a.getAttribute('href') ?? '').trim();
    if (!attr || attr.startsWith('#') || /^javascript:/i.test(attr)) continue;
    const href = (a as HTMLAnchorElement).href;
    if (!href || (href.split('#')[0] === here && attr.includes('#'))) continue;
    const p = parts(a);
    info.set(a, { el: a, href, name: nameOf(a, p), as: p.text ? 'text' : 'graphic' });
  }

  /** What an icon-only button shows: its sprite, image file, icon class or the start of its drawing. */
  const iconSig = (b: Element): string => {
    const use = b.querySelector('use');
    const u = use?.getAttribute('href') ?? use?.getAttribute('xlink:href');
    if (u) return `use:${u.split('#').pop()}`;
    const img = b.tagName === 'INPUT' ? b : b.querySelector('img');
    const src = img?.getAttribute('src');
    if (src) return `img:${src.split(/[?#]/)[0]!.split('/').pop()}`;
    for (const n of [b, ...b.querySelectorAll('i, span, svg')].slice(0, 6)) {
      for (const c of n.classList) if (/(^|[-_])(icon|fa|fas|far|bi|glyph|glyphicon|ion|ti|mdi)[-_]/i.test(c)) return `class:${c}`;
    }
    const d = b.querySelector('svg path')?.getAttribute('d');
    return d ? `path:${d.replace(/\s+/g, '').slice(0, 40)}` : '';
  };

  // Regions: navigation landmarks, then page header and footer links outside any navigation.
  const NAV = 'nav, [role="navigation"]';
  const regionEls: { el: Element; kind: 'nav' | 'header' | 'footer' }[] = [];
  for (const el of document.querySelectorAll(`${NAV}, ${BANNER}, ${CONTENTINFO}`)) {
    if (el.matches(NAV)) regionEls.push({ el, kind: 'nav' });
    else if (el.matches(BANNER) && pageLevel(el, 'banner')) regionEls.push({ el, kind: 'header' });
    else if (el.matches(CONTENTINFO) && pageLevel(el, 'contentinfo')) regionEls.push({ el, kind: 'footer' });
  }
  if (regionEls.length > LIM.regions) truncated = true;
  const inRegion = new Set<Element>();
  const regions: ConsistencyRegion[] = [];
  /** The region element that owns a descendant: the closest navigation, else the header or footer itself. */
  const owner = (d: Element, kind: 'nav' | 'header' | 'footer', el: Element) => {
    const n = d.closest(NAV);
    return kind === 'nav' ? n === el : !(n && el.contains(n));
  };
  for (const { el, kind } of regionEls.slice(0, LIM.regions)) {
    const links: ConsistencyLink[] = [];
    for (const a of el.querySelectorAll('a[href]')) {
      const i = info.get(a);
      if (!i || !owner(a, kind, el)) continue;
      inRegion.add(a);
      if (links.length >= LIM.linksPerRegion) {
        truncated = true;
        continue;
      }
      links.push({ href: i.href, name: i.name, as: i.as });
    }
    const icons: ConsistencyRegion['icons'] = [];
    for (const b of el.querySelectorAll('button, [role="button"], input[type="submit"], input[type="image"], input[type="button"]')) {
      if (icons.length >= 20 || !owner(b, kind, el) || b.closest('a[href]')) continue;
      const p = parts(b);
      if (p.text || (b.tagName === 'INPUT' && (b as HTMLInputElement).type !== 'image' && (b as HTMLInputElement).value.trim())) continue;
      const sig = iconSig(b);
      if (sig) icons.push({ sig, name: nameOf(b, p) });
    }
    if (!links.length && !icons.length) continue;
    const label = clean(byIds(el.getAttribute('aria-labelledby'))) || clean(el.getAttribute('aria-label'));
    regions.push({ kind, label, place: place(el), hidden: hiddenEl(el), links, icons });
  }
  // Help mechanisms: candidate links outside the main content, plus chat widgets anywhere.
  const help: ConsistencyHelp[] = [];
  for (const i of info.values()) {
    if (help.length >= LIM.help) {
      truncated = true;
      break;
    }
    if (!/^(tel|mailto):/i.test(i.href) && !helpRe.test(i.name) && !helpRe.test(i.href)) continue;
    const p = place(i.el);
    if (p !== 'in-main') help.push({ href: i.href, name: i.name, place: p });
  }
  const WIDGETS: [string, string][] = [
    ['intercom', '#intercom-container, .intercom-lightweight-app, iframe[name^="intercom"]'],
    ['hubspot', '#hubspot-messages-iframe-container'],
    ['zendesk', 'iframe#launcher, [data-testid="launcher"], #ze-snippet'],
    ['drift', '#drift-widget, #drift-frame-controller'],
    ['tawk', '[id^="tawk"], iframe[title*="chat widget" i]'],
    ['livechat', '#chat-widget-container, #livechat-compact-container'],
    ['crisp', '.crisp-client'],
    ['salesforce', '.embeddedServiceHelpButton'],
    ['chat', 'iframe[title*="chat" i], [aria-label*="chat" i][role="button"], button[aria-label*="chat" i]'],
  ];
  for (const [id, sel] of WIDGETS) {
    const el = document.querySelector(sel);
    if (el && help.length < LIM.help) help.push({ href: '', name: clean(el.getAttribute('aria-label') ?? el.getAttribute('title')), place: place(el), chat: `widget:${id}` });
  }

  // Search forms.
  const search: ConsistencySearch[] = [];
  const SEARCH_NAMES = /^(q|s|search|query|keys|keywords?|term|searchterm|k)$/i;
  const forms = new Set<Element>();
  for (const el of document.querySelectorAll('[role="search"], form, input[type="search"]')) {
    const box = el.matches('input') ? (el.closest('form, [role="search"]') ?? el.parentElement) : el;
    if (!box || forms.has(box)) continue;
    const field = box.matches('input') ? box : box.querySelector('input[type="search"]')
      ?? [...box.querySelectorAll('input[type="text"], input:not([type])')].find((f) => SEARCH_NAMES.test(f.getAttribute('name') ?? ''))
      ?? (box.getAttribute('role') === 'search' || /search/i.test(box.getAttribute('action') ?? '') ? box.querySelector('input[type="text"], input:not([type])') : null);
    if (!field) continue;
    forms.add(box);
    if (search.length >= LIM.search) break;
    const labels = (field as HTMLInputElement).labels;
    const fieldName = clean(byIds(field.getAttribute('aria-labelledby'))) || clean(field.getAttribute('aria-label')) ||
      clean(labels ? [...labels].map((l) => l.textContent).join(' ') : '') || clean(field.getAttribute('title')) || clean(field.getAttribute('placeholder'));
    const btn = box.querySelector('button:not([type="button"]):not([type="reset"]), input[type="submit"], input[type="image"]');
    const bp = btn ? parts(btn) : undefined;
    search.push({
      place: place(box), field: fieldName, button: btn ? nameOf(btn, bp) : '',
      buttonAs: !btn ? 'none' : bp!.text || (btn.tagName === 'INPUT' && (btn as HTMLInputElement).type === 'submit') ? 'text' : 'graphic',
    });
  }

  // Content links (for "related links" and links from the start page), site-map links, tables of contents.
  const contentLinks: string[] = [];
  const sitemapLinks: string[] = [];
  for (const i of info.values()) {
    if (sitemapLinks.length < LIM.sitemapLinks && (sitemapRe.test(i.name) || /\/(site-?map|site-?index|a-?z(-index)?)(\.(html?|php|aspx?))?$/i.test(i.href.split(/[?#]/)[0]!))) {
      sitemapLinks.push(i.href);
    }
    if (inRegion.has(i.el) || place(i.el) !== 'in-main') continue;
    if (contentLinks.length >= LIM.contentLinks) {
      truncated = true;
      continue;
    }
    contentLinks.push(i.href);
  }
  const tocLinks: string[] = [];
  const tocEls = [...document.querySelectorAll('nav, [role="navigation"], [id*="toc" i], [class*="toc" i], [id*="table-of-contents" i], [class*="table-of-contents" i]')].filter((el) => {
    const label = `${el.getAttribute('aria-label') ?? ''} ${byIds(el.getAttribute('aria-labelledby'))}`;
    if (el.matches(NAV) && /\b(table of contents|contents|site index|a ?- ?z|directory)\b/i.test(label)) return true;
    return /^(toc|table-of-contents)$/i.test(el.id) || [...el.classList].some((c) => /^(toc|table-of-contents)$/i.test(c));
  }).slice(0, 5);
  for (const el of tocEls) {
    for (const a of el.querySelectorAll('a[href]')) {
      const i = info.get(a);
      if (!i) continue;
      if (tocLinks.length >= LIM.tocLinks) {
        truncated = true;
        break;
      }
      tocLinks.push(i.href);
    }
  }

  return {
    lang: (document.documentElement.getAttribute('lang') ?? '').trim().toLowerCase().split(/[-_]/)[0] ?? '',
    regions, help, search, contentLinks, sitemapLinks, tocLinks,
    step: document.querySelector('[aria-current="step"]') !== null,
    truncated,
  };
}

const isStr = (x: unknown): x is string => typeof x === 'string';
const str = (x: unknown, max = 400) => (isStr(x) ? x.slice(0, max) : '');
const arr = (x: unknown, max: number): unknown[] => (Array.isArray(x) ? x.slice(0, max) : []);
const PLACES: readonly Place[] = ['before-main', 'in-main', 'after-main', 'unknown'];
const placeOf = (x: unknown): Place => (PLACES.includes(x as Place) ? (x as Place) : 'unknown');
const obj = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null ? (x as Record<string, unknown>) : {});

/**
 * The facts in their declared shape, whatever the page returned (a page can redefine the built-ins
 * the collector uses). Unknown fields are dropped and every list is capped again.
 */
export function toConsistencyFacts(raw: unknown): ConsistencyFacts {
  const r = obj(raw);
  const L = CONSISTENCY_LIMITS;
  return {
    lang: str(r.lang, 20),
    regions: arr(r.regions, L.regions).map((x) => {
      const g = obj(x);
      const kind = g.kind === 'header' || g.kind === 'footer' ? g.kind : 'nav';
      return {
        kind, label: str(g.label, 120), place: placeOf(g.place), hidden: g.hidden === true,
        links: arr(g.links, L.linksPerRegion).map((l) => {
          const o = obj(l);
          return { href: str(o.href, 2000), name: str(o.name, 120), as: o.as === 'graphic' ? 'graphic' as const : 'text' as const };
        }).filter((l) => l.href),
        icons: arr(g.icons, 20).map((i) => ({ sig: str(obj(i).sig, 200), name: str(obj(i).name, 120) })).filter((i) => i.sig),
      };
    }),
    help: arr(r.help, L.help).map((x) => {
      const o = obj(x);
      return { href: str(o.href, 2000), name: str(o.name, 120), place: placeOf(o.place), ...(isStr(o.chat) && o.chat ? { chat: o.chat.slice(0, 60) } : {}) };
    }),
    search: arr(r.search, L.search).map((x) => {
      const o = obj(x);
      return { place: placeOf(o.place), field: str(o.field, 120), button: str(o.button, 120), buttonAs: o.buttonAs === 'text' || o.buttonAs === 'graphic' ? o.buttonAs : 'none' as const };
    }),
    contentLinks: arr(r.contentLinks, L.contentLinks).filter(isStr).map((s) => s.slice(0, 2000)),
    sitemapLinks: arr(r.sitemapLinks, L.sitemapLinks).filter(isStr).map((s) => s.slice(0, 2000)),
    tocLinks: arr(r.tocLinks, L.tocLinks).filter(isStr).map((s) => s.slice(0, 2000)),
    step: r.step === true,
    truncated: r.truncated === true,
  };
}

/** Desktop only; runs on every scan (a few DOM queries over the links already on the page). */
export const consistencyCollector: PageCollector<ConsistencyFacts> = {
  id: 'consistency',
  viewport: 'desktop',
  timeoutMs: 3000,
  collect: async (page) => toConsistencyFacts(await page.evaluate(collectConsistency, {
    help: HELP_CANDIDATE_PATTERN.source, sitemap: SITEMAP_PATTERN.source, limits: CONSISTENCY_LIMITS,
  })),
};
