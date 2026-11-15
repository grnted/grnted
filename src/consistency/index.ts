// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Cross-page consistency (WCAG 2.4.5 Multiple ways, 3.2.3 Consistent navigation, 3.2.4 Consistent
// identification, 3.2.6 Consistent help): compares the facts the `consistency` collector gathered
// on every scanned page, after the scan. Deterministic rules only; label pairs the rules cannot
// decide go to the `consistency` AI check (`ambiguous`). No browser work, no requests. Engine core.
import { collectedValue } from '../collect/index.js';
import { consistencyCollector, type ConsistencyFacts, type ConsistencyRegion, type Place } from '../collect/consistency.js';
import type { CriterionEvidence, CriterionMethodResult, CriterionStatus, PageAudit } from '../types.js';
import { normalizeUrl, sameSite, isLikelyHtml, isDocumentUrl, urlKey } from '../url.js';
import { compareLabels, helpType, isSitemapLink, linkKey, processStepReason, shortUrl, type HelpType } from './labels.js';
import { hasOrderConflict, movedItems, orderConflicts, type OrderConflict } from './order.js';

export { compareLabels, helpType, isSitemapLink, labelTokens, linkKey, normalizeLabel, processStepReason, shortUrl } from './labels.js';
export { hasOrderConflict, movedItems, orderConflicts, type OrderConflict } from './order.js';

/** The method id in the criteria table (`site:consistency` declares it). */
export const CONSISTENCY_METHOD_ID = 'consistency';
export const CONSISTENCY_CRITERIA = ['2.4.5', '3.2.3', '3.2.4', '3.2.6'] as const;

/** Two names for the same component on two pages that the rules cannot judge (the AI does). */
export interface LabelPair {
  what: 'link' | 'icon button' | 'search button' | 'search field';
  /** Where the link goes (as found on page B); '' for buttons and fields. */
  destination: string;
  /** Plain description of where the component is, e.g. 'navigation "Main"' (on page B). */
  where: string;
  /**
   * Where it is on page A, when the rules matched it to an area with another name (a site menu and a section's own
   * menu that share links): the AI review is shown both, so it can tell two components from one.
   */
  whereA?: string;
  pageA: string;
  labelA: string;
  pageB: string;
  labelB: string;
}

export interface ConsistencyResult {
  criterion: (typeof CONSISTENCY_CRITERIA)[number];
  method: CriterionMethodResult;
  evidence: CriterionEvidence[];
}

export interface ConsistencyAnalysis {
  results: ConsistencyResult[];
  /** Label pairs for the AI, in page order, each pair once. */
  ambiguous: LabelPair[];
}

// Preparing pages ---------------------------------------------------------------------------------

interface Region {
  kind: ConsistencyRegion['kind'];
  label: string;
  hidden: boolean;
  /** Component keys (`<link key>|<text or graphic>`) in page order, duplicates kept. */
  seq: string[];
  /** The components (links, and icon buttons as `icon:<sig>`), for matching blocks across pages. */
  keys: Set<string>;
  /** Names seen for each component. */
  names: Map<string, string[]>;
  /** First address seen for each component. */
  hrefs: Map<string, string>;
  icons: Map<string, string[]>;
}

interface Page {
  url: string;
  index: number;
  lang: string;
  facts: ConsistencyFacts;
  regions: Region[];
}

function prepRegion(r: ConsistencyRegion, base: string): Region {
  const out: Region = { kind: r.kind, label: r.label, hidden: r.hidden, seq: [], keys: new Set(), names: new Map(), hrefs: new Map(), icons: new Map() };
  for (const l of r.links) {
    const k = linkKey(l.href, base);
    if (!k) continue;
    const c = `${k}|${l.as}`;
    out.seq.push(c);
    out.keys.add(c);
    if (!out.hrefs.has(c)) out.hrefs.set(c, l.href);
    const names = out.names.get(c) ?? [];
    if (l.name && !names.includes(l.name)) names.push(l.name);
    out.names.set(c, names);
  }
  for (const i of r.icons) {
    out.keys.add(`icon:${i.sig}`);
    const names = out.icons.get(i.sig) ?? [];
    if (i.name && !names.includes(i.name)) names.push(i.name);
    out.icons.set(i.sig, names);
  }
  return out;
}

const regionName = (r: Pick<Region, 'kind' | 'label'>) =>
  r.kind === 'nav' ? (r.label ? `navigation "${r.label}"` : 'navigation') : r.kind === 'header' ? 'page header links' : 'page footer links';

/**
 * Shared components when two regions are the same repeated block, else 0. Same kind; names that do
 * not contradict each other ("Main" and "Mobile" do); at least two shared items, and at least half
 * of the larger block (half of the smaller one when both carry the same name, so a menu with its
 * current section expanded still matches). A small sidebar block that happens to share two links
 * with the main menu is a different block, not a reordered menu.
 */
function overlap(a: Region, b: Region): number {
  if (a.kind !== b.kind) return 0;
  const named = a.label !== '' && b.label !== '';
  if (named && compareLabels([a.label], [b.label]) === 'different') return 0;
  let shared = 0;
  for (const k of a.keys) if (b.keys.has(k)) shared++;
  const of = named ? Math.min(a.keys.size, b.keys.size) : Math.max(a.keys.size, b.keys.size);
  return shared >= 2 && shared >= 0.5 * of ? shared : 0;
}

/**
 * The region on page `p` that `r` repeats, if any: among the matching regions, the one in the most
 * similar order (a page may carry a desktop menu and a hidden mobile copy), then the most shared
 * items, the same name, the same visibility.
 */
function counterpart(r: Region, p: Page): Region | undefined {
  const candidates = p.regions.map((t) => ({ t, shared: overlap(r, t) })).filter((c) => c.shared > 0);
  if (!candidates.length) return undefined;
  const scored = candidates.map((c) => ({ ...c, conflicts: Number(hasOrderConflict(c.t.seq, r.seq)) }));
  scored.sort((x, y) => x.conflicts - y.conflicts || y.shared - x.shared
    || Number(y.t.label === r.label) - Number(x.t.label === r.label) || Number(y.t.hidden === r.hidden) - Number(x.t.hidden === r.hidden));
  return scored[0]!.t;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const quote = (s: string) => `"${s.length > 60 ? `${s.slice(0, 59)}…` : s}"`;
const sameLanguage = (a: Page, b: Page) => !a.lang || !b.lang || a.lang === b.lang;

/** Loaded pages with consistency facts, in scan order, plus counts of the ones left out. */
function preparePages(pages: readonly PageAudit[]): { ready: Page[]; failed: number; noFacts: number } {
  const ready: Page[] = [];
  let failed = 0;
  let noFacts = 0;
  pages.forEach((p, index) => {
    if (p.status !== 'ok') {
      failed++;
      return;
    }
    const facts = collectedValue(p, consistencyCollector);
    if (!facts) {
      noFacts++;
      return;
    }
    ready.push({ url: p.url, index, lang: facts.lang, facts, regions: facts.regions.map((r) => prepRegion(r, p.url)) });
  });
  return { ready, failed, noFacts };
}

/** "; 2 pages did not load" etc., for method notes. */
function leftOut(failed: number, noFacts: number): string {
  return `${failed ? `; ${plural(failed, 'page')} did not load` : ''}${noFacts ? `; the facts of ${plural(noFacts, 'page')} could not be read` : ''}`;
}

function result(criterion: ConsistencyResult['criterion'], status: CriterionStatus, pages: number, note: string, evidence: CriterionEvidence[] = []): ConsistencyResult {
  return { criterion, method: { id: CONSISTENCY_METHOD_ID, kind: 'rules', status, pages, note }, evidence };
}

// Naming the odd one out ------------------------------------------------------------------------------

/** Two items that disagree (`a` is the earlier one in scan order). */
interface Edge<N> {
  a: N;
  b: N;
}

/**
 * Which items to name when pages disagree: repeatedly the item that disagrees with the most others
 * (ties: the later page), so the odd page out is named, not every page that agrees with the rest.
 * Each comes with the earliest item it disagrees with and how many it disagrees with, in scan order.
 */
export function blame<N>(edges: readonly Edge<N>[], order: (n: N) => number): { node: N; against: N; count: number }[] {
  let left = [...edges];
  const out: { node: N; against: N; count: number }[] = [];
  while (left.length) {
    const degree = new Map<N, number>();
    for (const e of left) for (const n of [e.a, e.b]) degree.set(n, (degree.get(n) ?? 0) + 1);
    const node = [...degree.entries()].sort((x, y) => y[1] - x[1] || order(y[0]) - order(x[0]))[0]![0];
    const others = left.filter((e) => e.a === node || e.b === node).map((e) => (e.a === node ? e.b : e.a)).sort((x, y) => order(x) - order(y));
    out.push({ node, against: others[0]!, count: others.length });
    left = left.filter((e) => e.a !== node && e.b !== node);
  }
  return out.sort((x, y) => order(x.node) - order(y.node));
}

const andMore = (count: number) => (count > 1 ? ` It also differs from ${plural(count - 1, 'other page')}.` : '');

// 3.2.3 and 3.2.4: repeated navigation -------------------------------------------------------------

interface Pairing {
  q: Page;
  r: Region;
  p: Page;
  t: Region;
}

/**
 * Every repeated block on a page with its counterpart on each earlier page, in scan order. Every
 * pair of pages is compared, so two pages that differ from each other but each agree with the start
 * page (which lacks the items they disagree on) are still caught.
 */
function pairings(ready: readonly Page[]): Pairing[] {
  const out: Pairing[] = [];
  ready.forEach((q, i) => {
    for (const r of q.regions) {
      for (const p of ready.slice(0, i)) {
        const t = counterpart(r, p);
        if (t) out.push({ q, r, p, t });
      }
    }
  });
  return out;
}

const nameIn = (r: Region, c: string) => r.names.get(c)?.[0] ?? shortUrl(r.hrefs.get(c) ?? c.split('|')[0]!);

/** "In the navigation, "News" comes before "About" on this page, but after it on /x." */
function orderDetail(conflicts: readonly OrderConflict[], here: readonly string[], name: (k: string) => string, there: string, prefix = ''): string {
  const moved = movedItems(conflicts, here);
  const m = moved[0]!;
  const c = conflicts.find((x) => x.first === m || x.second === m)!;
  const partner = c.first === m ? c.second : c.first;
  // `c.first` is before `c.second` on the other page and after it here.
  const hereBefore = c.second === m;
  return `${prefix}${quote(name(m))} comes ${hereBefore ? 'before' : 'after'} ${quote(name(partner))} on this page, but ${hereBefore ? 'after' : 'before'} it on ${shortUrl(there)}${moved.length > 1 ? ` (${plural(moved.length, 'item')} out of order)` : ''}.`;
}

function navigationOrder(ready: readonly Page[], pairs: readonly Pairing[], note: string): ConsistencyResult {
  if (!pairs.length) return result('3.2.3', 'not_applicable', 0, `no navigation is repeated across the ${plural(ready.length, 'compared page')}${note}`);
  const pageOf = new Map<Region, Page>();
  for (const pg of ready) for (const r of pg.regions) pageOf.set(r, pg);
  const order = (r: Region) => pageOf.get(r)!.index * 1000 + pageOf.get(r)!.regions.indexOf(r);
  const edges = pairs.filter(({ r, t }) => hasOrderConflict(t.seq, r.seq)).map(({ r, t }) => ({ a: t, b: r }));
  const evidence: CriterionEvidence[] = blame(edges, order).map(({ node, against, count }) => ({
    page: pageOf.get(node)!.url,
    target: regionName(node),
    detail: `${orderDetail(orderConflicts(against.seq, node.seq), node.seq, (k) => nameIn(node, k), pageOf.get(against)!.url, `In the ${regionName(node)}, `)}${andMore(count)}`,
  }));
  const failing = new Set(evidence.map((e) => e.page)).size;
  const repeatedPages = new Set(pairs.flatMap(({ q, p }) => [q.url, p.url])).size;
  const blocks = `${plural(repeatedPages, 'page')} with repeated navigation compared${note}`;
  if (failing) return result('3.2.3', 'failed', failing, blocks, evidence);
  return result('3.2.3', 'no_failures_found', repeatedPages, blocks);
}

interface SiteSearch {
  page: Page;
  field: string;
  button: string;
}

/** The site's search form on a page: one outside the main content (or any, on the start page). */
function siteSearch(page: Page, isStart: boolean): SiteSearch | undefined {
  const s = page.facts.search.find((x) => x.place !== 'in-main') ?? (isStart ? page.facts.search[0] : undefined);
  return s ? { page, field: s.field, button: s.button } : undefined;
}

/** One component as seen on one page. */
interface Seen {
  page: Page;
  what: LabelPair['what'];
  where: string;
  destination: string;
  names: readonly string[];
}

function identification(ready: readonly Page[], pairs: readonly Pairing[], start: Page | undefined, note: string): { result: ConsistencyResult; ambiguous: LabelPair[] } {
  // Edges per component (`what` + identity), split into names the rules fail and names for the AI.
  const groups = new Map<string, { clear: Edge<Seen>[]; unsure: Edge<Seen>[] }>();
  const seen = new Map<string, Seen>();
  const compared = new Set<string>();
  const pagesCompared = new Set<string>();
  let otherLanguage = 0;
  const at = (page: Page, slot: string, make: () => Seen) => {
    const k = `${page.index}\n${slot}`;
    let x = seen.get(k);
    if (!x) seen.set(k, (x = make()));
    return x;
  };
  const judge = (component: string, there: Seen, here: Seen, forceAi: boolean) => {
    compared.add(component);
    pagesCompared.add(here.page.url).add(there.page.url);
    const verdict = compareLabels(here.names, there.names);
    if (verdict === 'same' || verdict === 'unnamed') return;
    const g = groups.get(component) ?? { clear: [], unsure: [] };
    groups.set(component, g);
    (verdict === 'ambiguous' || forceAi ? g.unsure : g.clear).push({ a: there, b: here });
  };

  pairs.forEach(({ q, r, p, t }) => {
    if (!sameLanguage(q, p)) {
      otherLanguage++;
      return;
    }
    const shared = [...r.hrefs.keys()].filter((c) => t.hrefs.has(c));
    const sharedIcons = [...r.icons.keys()].filter((s) => t.icons.has(s));
    // A block where most names differ was translated or redesigned, not mislabelled: the AI judges it.
    const differing = shared.filter((c) => {
      const v = compareLabels(r.names.get(c) ?? [], t.names.get(c) ?? []);
      return v === 'different' || v === 'ambiguous';
    }).length;
    const relabelled = shared.length >= 3 && differing / shared.length > 0.5;
    const ri = q.regions.indexOf(r);
    const ti = p.regions.indexOf(t);
    for (const c of shared) {
      const make = (pg: Page, g: Region) => () => ({ page: pg, what: 'link' as const, where: regionName(g), destination: g.hrefs.get(c) ?? '', names: g.names.get(c) ?? [] });
      judge(`link\n${c}`, at(p, `${ti}\n${c}`, make(p, t)), at(q, `${ri}\n${c}`, make(q, r)), relabelled);
    }
    for (const sig of sharedIcons) {
      const make = (pg: Page, g: Region) => () => ({ page: pg, what: 'icon button' as const, where: regionName(g), destination: '', names: g.icons.get(sig) ?? [] });
      judge(`icon\n${sig}`, at(p, `${ti}\nicon:${sig}`, make(p, t)), at(q, `${ri}\nicon:${sig}`, make(q, r)), relabelled);
    }
  });
  // The site search form: every pair of pages in the same language.
  const searches = ready.map((pg) => siteSearch(pg, pg === start)).filter((x): x is SiteSearch => x !== undefined);
  searches.forEach((s, i) => {
    for (const ref of searches.slice(0, i)) {
      if (!sameLanguage(s.page, ref.page)) {
        otherLanguage++;
        continue;
      }
      for (const what of ['search button', 'search field'] as const) {
        const make = (x: SiteSearch) => () => ({ page: x.page, what, where: 'search form', destination: '', names: [what === 'search button' ? x.button : x.field].filter(Boolean) });
        judge(what, at(ref.page, what, make(ref)), at(s.page, what, make(s)), false);
      }
    }
  });

  if (!compared.size) {
    const why = otherLanguage
      ? `the pages that repeat navigation or search are in different languages, so their names were not compared${note}`
      : `no navigation or search form is repeated across the ${plural(ready.length, 'compared page')}${note}`;
    return { result: result('3.2.4', 'not_applicable', 0, why), ambiguous: [] };
  }
  const order = (x: Seen) => x.page.index;
  const evidence: CriterionEvidence[] = [];
  const ambiguous = new Map<string, LabelPair>();
  for (const [component, g] of groups) {
    const named = new Set<Seen>();
    for (const { node, against, count } of blame(g.clear, order)) {
      named.add(node);
      const thing = node.what === 'link' ? `The link to ${shortUrl(node.destination)}` : node.what === 'icon button' ? 'An icon button' : `The ${node.what}`;
      evidence.push({
        page: node.page.url,
        target: `${node.what === 'link' ? `Link to ${shortUrl(node.destination)}` : `${node.what[0]!.toUpperCase()}${node.what.slice(1)}`} (${node.where})`,
        detail: `${thing} in the ${node.where} is named ${quote(node.names[0]!)} on this page and ${quote(against.names[0]!)} on ${shortUrl(against.page.url)}.${andMore(count)}`,
      });
    }
    for (const { node, against } of blame(g.unsure.filter((e) => !named.has(e.a) && !named.has(e.b)), order)) {
      const key = JSON.stringify([component, [node.names[0], against.names[0]].sort()]);
      if (!ambiguous.has(key)) {
        ambiguous.set(key, {
          what: node.what, destination: node.destination, where: node.where,
          ...(against.where !== node.where ? { whereA: against.where } : {}),
          pageA: against.page.url, labelA: against.names[0]!, pageB: node.page.url, labelB: node.names[0]!,
        });
      }
    }
  }
  const byPage = (a: { page: string }, b: { page: string }) => pageOrder(ready, a.page) - pageOrder(ready, b.page);
  evidence.sort(byPage);
  const pending = ambiguous.size ? `; ${plural(ambiguous.size, 'pair')} of similar but different names left to the AI review` : '';
  const failingPages = new Set(evidence.map((e) => e.page)).size;
  const base = `names of ${plural(compared.size, 'repeated component')} compared across ${plural(pagesCompared.size, 'page')}${pending}${note}`;
  const res = failingPages
    ? result('3.2.4', 'failed', failingPages, base, evidence)
    : result('3.2.4', 'no_failures_found', pagesCompared.size, base);
  return { result: res, ambiguous: [...ambiguous.values()].sort((x, y) => pageOrder(ready, x.pageB) - pageOrder(ready, y.pageB)) };
}

const pageOrder = (ready: readonly Page[], url: string) => ready.findIndex((p) => p.url === url);

// 3.2.6: help mechanisms ----------------------------------------------------------------------------

interface HelpSeq {
  page: Page;
  seq: string[];
  names: Map<string, string>;
  places: Map<string, Set<Place>>;
}

const HELP_WORD: Record<HelpType, string> = { phone: 'phone number', email: 'email address', contact: 'contact link', help: 'help link', chat: 'chat' };

function helpOf(page: Page): HelpSeq {
  const out: HelpSeq = { page, seq: [], names: new Map(), places: new Map() };
  for (const h of page.facts.help) {
    if (h.place === 'in-main' && !h.chat) continue;
    const type = h.chat ? 'chat' : helpType(h.href, h.name);
    if (!type) continue;
    const key = h.chat ?? `${type}:${linkKey(h.href, page.url) ?? h.href}`;
    out.seq.push(key);
    if (!out.names.has(key)) out.names.set(key, h.name || (h.chat ? 'chat' : shortUrl(h.href)) || HELP_WORD[type]);
    const places = out.places.get(key) ?? new Set<Place>();
    places.add(h.place);
    out.places.set(key, places);
  }
  return out;
}

const PLACE_WORDS: Partial<Record<Place, string>> = { 'before-main': 'before the main content', 'after-main': 'after the main content' };

/** A help mechanism both pages have, shown before the main content on one and after it on the other. */
function movedHelp(a: HelpSeq, b: HelpSeq): { key: string; here: Place; there: Place } | undefined {
  for (const k of b.seq) {
    const here = [...(b.places.get(k) ?? [])].filter((x) => PLACE_WORDS[x]);
    const there = [...(a.places.get(k) ?? [])].filter((x) => PLACE_WORDS[x]);
    if (here.length && there.length && !here.some((x) => there.includes(x))) return { key: k, here: here[0]!, there: there[0]! };
  }
  return undefined;
}

function consistentHelp(ready: readonly Page[], note: string): ConsistencyResult {
  const seqs = ready.map(helpOf);
  const repeated = new Set<string>();
  const orderEdges: Edge<HelpSeq>[] = [];
  const placeEdges: Edge<HelpSeq>[] = [];
  seqs.forEach((h, i) => {
    for (const ref of seqs.slice(0, i)) {
      if (!ref.seq.some((k) => h.places.has(k))) continue;
      repeated.add(h.page.url).add(ref.page.url);
      if (hasOrderConflict(ref.seq, h.seq)) orderEdges.push({ a: ref, b: h });
      if (movedHelp(ref, h)) placeEdges.push({ a: ref, b: h });
    }
  });
  if (!repeated.size) {
    return result('3.2.6', 'not_applicable', 0, `no help mechanism (contact details, a contact or help page link, a chat) is repeated across the ${plural(ready.length, 'compared page')}${note}`);
  }
  const order = (h: HelpSeq) => h.page.index;
  const evidence: CriterionEvidence[] = [
    ...blame(orderEdges, order).map(({ node, against, count }) => ({
      page: node.page.url, target: 'Help mechanisms',
      detail: `${orderDetail(orderConflicts(against.seq, node.seq), node.seq, (k) => node.names.get(k)!, against.page.url)}${andMore(count)}`,
    })),
    ...blame(placeEdges, order).map(({ node, against, count }) => {
      const m = movedHelp(against, node)!;
      return {
        page: node.page.url, target: 'Help mechanisms',
        detail: `${quote(node.names.get(m.key)!)} is ${PLACE_WORDS[m.here]} on this page, but ${PLACE_WORDS[m.there]} on ${shortUrl(against.page.url)}.${andMore(count)}`,
      };
    }),
  ].sort((a, b) => pageOrder(ready, a.page) - pageOrder(ready, b.page));
  const failing = new Set(evidence.map((e) => e.page)).size;
  const base = `${plural(repeated.size, 'page')} with repeated help mechanisms compared${note}`;
  if (failing) return result('3.2.6', 'failed', failing, base, evidence);
  return result('3.2.6', 'no_failures_found', repeated.size, base);
}

// 2.4.5: multiple ways -----------------------------------------------------------------------------

/** A control or link that opens the site search. */
const SEARCH_NAME = /^\s*(search|site search|search (this|the) (site|website)|buscar|recherche|rechercher|suche)\b/i;

type Way = 'navigation' | 'start page' | 'links from other pages' | 'table of contents';

function multipleWays(pages: readonly PageAudit[], ready: readonly Page[], start: Page | undefined, site: string, note: string): ConsistencyResult {
  const keyOf = (href: string, base: string) => {
    const k = linkKey(href, base);
    return k && !k.startsWith('tel:') && !k.startsWith('mailto:') ? k : undefined;
  };
  // Site-wide ways: a search form (or a search button or link in a repeated area, for search that
  // opens on demand), or a site map / index link.
  const search = ready.some((p) => siteSearch(p, p === start) || p.facts.regions.some((r) =>
    r.icons.some((i) => SEARCH_NAME.test(i.name)) || r.links.some((l) => SEARCH_NAME.test(l.name) || /\/search(\.\w+)?$/i.test(l.href.split(/[?#]/)[0]!))));
  const sitemap = ready.some((p) => p.facts.sitemapLinks.length > 0);
  const siteWays = [...(search ? ['search'] : []), ...(sitemap ? ['site map or index'] : [])];
  // Ways to each page, from the links on the scanned pages.
  const ways = new Map<string, Set<Way>>();
  const add = (k: string | undefined, w: Way) => {
    if (!k) return;
    const s = ways.get(k) ?? new Set<Way>();
    s.add(w);
    ways.set(k, s);
  };
  for (const p of ready) {
    for (const r of p.facts.regions) for (const l of r.links) add(keyOf(l.href, p.url), 'navigation');
    for (const href of p.facts.contentLinks) {
      const k = keyOf(href, p.url);
      if (k && k !== keyOf(p.url, p.url)) add(k, p === start ? 'start page' : 'links from other pages');
    }
    for (const href of p.facts.tocLinks) add(keyOf(href, p.url), 'table of contents');
  }
  const startKey = start ? keyOf(start.url, start.url) : keyOf(site, site);
  const failing: CriterionEvidence[] = [];
  let checked = 0;
  let exempt = 0;
  let unknown = 0;
  for (const p of ready) {
    const k = keyOf(p.url, p.url);
    if (!k || k === startKey) continue;
    if (processStepReason(p.url, p.facts.step)) {
      exempt++;
      continue;
    }
    const found = ways.get(k) ?? new Set<Way>();
    if (!found.size) {
      // Linked only from pages the scan did not load: how it is reached cannot be told.
      unknown++;
      continue;
    }
    checked++;
    if (siteWays.length) continue; // the site-wide way plus at least one link
    if (found.size >= 2) continue;
    failing.push({
      page: p.url, target: 'Ways to reach this page',
      detail: `Found only through ${[...found][0]} on the scanned pages; the site has no search form, site map or index.`,
    });
  }
  const extras = `${exempt ? `; ${plural(exempt, 'page')} in a process (search results, steps, confirmations) not counted` : ''}${unknown ? `; ${plural(unknown, 'page')} not linked from any scanned page, so not counted` : ''}${note}`;
  const siteNote = siteWays.length ? `site-wide: ${siteWays.join(', ')}` : 'no search form, site map or index found';
  if (failing.length) return result('2.4.5', 'failed', failing.length, `${siteNote}; ${plural(checked, 'page')} checked${extras}`, failing);
  if (checked) return result('2.4.5', 'no_failures_found', checked, `${siteNote}; ${plural(checked, 'page')} checked${extras}`);
  // Nothing to judge: a one-page site, or only pages the rules cannot place.
  const startLinks = (pages.find((p) => p.url === start?.url)?.links ?? [])
    .map((h) => normalizeUrl(h, start?.url))
    .filter((h): h is string => !!h && sameSite(h, site) && isLikelyHtml(h) && !isDocumentUrl(h) && urlKey(h) !== startKey);
  if (start && ready.length === 1 && !startLinks.length) {
    return result('2.4.5', 'not_applicable', 0, `the start page links to no other page on the site${note}`);
  }
  return result('2.4.5', 'not_testable', 0, `no scanned page besides the start page could be checked${extras}`);
}

// Entry point ---------------------------------------------------------------------------------------

/**
 * The cross-page results for 2.4.5, 3.2.3, 3.2.4 and 3.2.6, and the label pairs for the AI. Pages
 * are compared in scan order: each page against the earliest page that repeats the same block, so
 * results do not depend on timing. `site` is the start page.
 */
export function analyzeConsistency(pages: readonly PageAudit[], site: string): ConsistencyAnalysis {
  const { ready, failed, noFacts } = preparePages(pages);
  const startKey = linkKey(site);
  const start = ready.find((p) => linkKey(p.url) === startKey) ?? (ready[0]?.index === 0 ? ready[0] : undefined);
  const note = leftOut(failed, noFacts);
  if (ready.length < 2) {
    const failedNote = failed ? `; ${plural(failed, 'page')} did not load` : '';
    const why = ready.length === 1 ? `only one page could be compared${note}`
      : noFacts ? `the facts for comparing pages could not be read on the loaded pages${failedNote}`
      : `no page loaded${failedNote}`;
    const one = (c: ConsistencyResult['criterion']) => result(c, 'not_testable', 0, why);
    return { results: [ready.length ? multipleWays(pages, ready, start, site, note) : one('2.4.5'), one('3.2.3'), one('3.2.4'), one('3.2.6')], ambiguous: [] };
  }
  const pairs = pairings(ready);
  const ident = identification(ready, pairs, start, note);
  return {
    results: [multipleWays(pages, ready, start, site, note), navigationOrder(ready, pairs, note), ident.result, consistentHelp(ready, note)],
    ambiguous: ident.ambiguous,
  };
}
