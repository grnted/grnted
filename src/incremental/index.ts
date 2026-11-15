// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Incremental monitoring scans (Plan 7, W6; docs/monitoring.md). A monitoring scan decides per page,
// cheapest first, whether the page changed since the monitor's previous scan:
//   1. the sitemap's <lastmod> is older than the previous scan (no request), once the site's sitemap
//      proved reliable against real page bodies (`LastmodTrust`);
//   2. a conditional GET with the stored ETag / Last-Modified answers 304 (unless the site's validators
//      were caught lying: then a plain GET);
//   3. otherwise the HTML, normalised (normalize.ts), hashes the same;
// and, for 1–3, every stylesheet and script it uses (any origin, with same-site @imports) has the same
// version this scan. An unchanged page carries its previous audit forward (`unchangedSince`); anything
// else, or anything unsure, is audited in the browser. Rule (Paul): a missed change is worse than an
// extra audit. Safety nets: the homepage and the core-test template sample every scan; a changed file
// re-audits EVERY page that uses it; client-rendered pages (thin HTML, or a rendered DOM much larger
// than the HTML) and sites are always audited; the host runs a full scan every few cycles (`full`), and
// any engine, axe, scoring or normalisation version change makes the scan full. Pages that go to the
// browser anyway get no request first: their validators and hash come from the browser's own load
// (`PageAudit.document`), so a monitoring scan never loads a page more often than a one-off. Every
// request goes through the scan's politeness controller. Engine core: no Node-only imports.
import { readCapped } from '../crawl.js';
import { PACE_DEFAULTS, type Pace } from '../pace.js';
import { pageShapeOf, PROBE_SAMPLE_SIZE } from '../probes/sample.js';
import { AXE_VERSION } from '../ruleImpacts.js';
import { urlPattern } from '../sample/templates.js';
import type { PageAudit } from '../types.js';
import { ENGINE_VERSION, SCORING_VERSION } from '../version.js';
import { lastmodKey, lastmodSays, nextLastmodTrust, type LastmodTrust } from './lastmod.js';
import { assetRefs, cssImports, isThinHtml, normalizeHtml, NORMALIZE_VERSION, renderedDiffers, sha256Hex, staticCounts, type AssetRef } from './normalize.js';

export { assetIdentity, assetRefs, cssImports, isThinHtml, normalizeHtml, NORMALIZE_VERSION, renderedDiffers, sha256Hex, staticCounts, THIN_TEXT_CHARS, type AssetRef } from './normalize.js';
export { LASTMOD_PROOF_PAGES, lastmodKey, lastmodSays, nextLastmodTrust, parseLastmod, type LastmodTrust, type LastmodTrustState } from './lastmod.js';

const FETCH_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 5;
/** `@import` levels followed below a page's own stylesheets (deeper: unsure, the page is audited). */
const MAX_IMPORT_DEPTH = 8;
/** The worker's Accept-Language on every GET (r2-4: the stored hash is always made with the same headers). */
export const WORKER_ACCEPT_LANGUAGE = 'en-US,en;q=0.9';
const PAGE_ACCEPT = 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5';

/** Ends a response body nobody reads (r2-5): a 304, a refused answer, a redirect. */
function cancel(res: Response): void {
  try {
    void res.body?.cancel().catch(() => {});
  } catch {
    // already used
  }
}

/** What a monitor keeps about one page for its next scan. */
export interface PageState {
  url: string;
  etag?: string;
  lastModified?: string;
  /** SHA-256 (hex) of the normalised HTML of a real body (never assumed from a 304). */
  hash?: string;
  /** Identities of the stylesheets and scripts it names itself (`assetIdentity`); their `@import`s are found again each scan. */
  assets: string[];
  /** Its DOM-shape key (the template sample's), from its audit. */
  shape?: string;
  /** The sitemap's lastmod for it, as written. */
  lastmod?: string;
  /** Client-rendered: its HTML holds almost no text, or its rendered DOM is much larger (always audited). */
  thin?: boolean;
  /** When its audit was made (ISO): carried forward, the report says "unchanged since". */
  since: string;
}

/** A stylesheet or script as last seen: the address fetched, its version (SHA-256 of the body and its imports) and validators. */
export interface AssetState {
  url: string;
  /** SHA-256 of its body. */
  v: string;
  /** A stylesheet's same-site `@import`s, as read from its body (kept for a 304). */
  imports?: AssetRef[];
  etag?: string;
  lastModified?: string;
}

/** What made the results: a change in any one makes the next scan a full one (r1-6). */
export interface IncrementalVersions { engine: string; axe: string; scoring: string; normalize: number }

export const currentVersions = (): IncrementalVersions => ({ engine: ENGINE_VERSION, axe: AXE_VERSION, scoring: SCORING_VERSION, normalize: NORMALIZE_VERSION });

/** Whether the site's ETag / Last-Modified are used for conditional GETs (per monitor). */
export interface ValidatorTrust { trust: 'ok' | 'ignored'; why?: string }

/** A monitor's state from its previous scan (the host stores it with the audits it carries). */
export interface IncrementalPrevious {
  /** When that scan started (ISO): a lastmod older than this is unchanged. */
  startedAt: string;
  pages: PageState[];
  /** By identity. */
  assets: Record<string, AssetState>;
  lastmod: LastmodTrust;
  /** Absent: ok. */
  validators?: ValidatorTrust;
  /** Most pages answered the same HTML (a client-rendered shell): every page is audited. */
  shell?: boolean;
  /** The versions that made these results; absent (an older state) or different: the next scan is full. */
  versions?: IncrementalVersions;
}

/** How a scan decided a page: carried forward (by which layer) or audited (why). */
export type RevisionDecision =
  | 'lastmod' | 'not-modified' | 'same-html'
  | 'new' | 'full' | 'home' | 'client-rendered' | 'sample' | 'changed' | 'asset-changed' | 'no-previous-audit' | 'unsure';

/** A page's monitoring facts from this scan (on its PageAudit; the host keeps them for the next scan). */
export interface PageRevision {
  decided: RevisionDecision;
  /** Its previous audit was carried forward (no browser load). */
  carried: boolean;
  etag?: string;
  lastModified?: string;
  hash?: string;
  /** The hash was read from a real body this scan (the browser's load or a 200), not kept from before. */
  fresh?: boolean;
  /** The stylesheets and scripts it uses, imports included, with this scan's versions (`v` absent: unsure; `fresh`: the body was read). */
  assets: (AssetRef & Partial<Omit<AssetState, 'url'>> & { fresh?: boolean; imported?: boolean })[];
  lastmod?: string;
  /** For the lastmod trust: what its lastmod said, and what a real body (`htmlSaid`) or the full cycle's audit (`auditSaid`) showed. */
  lastmodSaid?: 'unchanged' | 'changed';
  htmlSaid?: 'unchanged' | 'changed';
  auditSaid?: 'unchanged' | 'changed';
  thin?: boolean;
  /** A full cycle could not read the page's body (r2-3): the sitemap's evidence is unknown. */
  bodyUnread?: boolean;
  /** When its results were made (ISO): this scan's start, or the earlier scan's for a carried page. */
  since: string;
}

/** What a scan's host passes for a monitoring scan (`ScanOptions.incremental`). */
export interface IncrementalOptions {
  /** The previous scan's state; null: the first scan (every page audited, state recorded). */
  previous: IncrementalPrevious | null;
  /** Audit every page (the host's full scan every few cycles); the state is still recorded. */
  full?: boolean;
  /** The page's previous audit (to carry forward); undefined when none is kept. */
  carried(url: string): Promise<PageAudit | undefined>;
  /** Long scans resumed in a later segment: the sitemap lastmods discovery read in the first one. */
  lastmods?: Readonly<Record<string, string>>;
  /** Discovery's sitemap lastmods (by `lastmodKey`), for a host that resumes in segments. */
  onLastmods?(lastmods: Record<string, string>): void;
}

/** Whether this monitoring scan audits every page: the host asked, there is no state, or the state is from other versions. */
export function incrementalIsFull(o: Pick<IncrementalOptions, 'previous' | 'full'>): boolean {
  if (o.full || !o.previous) return true;
  const v = o.previous.versions;
  const c = currentVersions();
  return !v || v.engine !== c.engine || v.axe !== c.axe || v.scoring !== c.scoring || v.normalize !== c.normalize;
}

/** The scan's numbers for the report, the email and the `scan_cost` log line. */
export interface IncrementalSummary {
  /** Every page was audited (the host's full scan, or the first one). */
  full: boolean;
  pages: number;
  /** Pages loaded in the browser this scan. */
  checked: number;
  /** Pages carried forward. */
  unchanged: number;
  /** Carried pages by the layer that decided. */
  skipped: { lastmod: number; notModified: number; sameHtml: number };
}

/** A page's findings as compared between two audits: status, rule outcomes, failing rules and their first elements. */
export function findingsKey(p: PageAudit): string {
  const rules = Object.entries(p.rules ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const fails = (p.violations ?? []).map((v) => [v.id, v.nodes.slice(0, 5).map((n) => JSON.stringify(n.target))] as const)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([p.status, rules, fails]);
}

/** One decision: carry this audit forward, or audit the page (with its revision so far). */
export type IncrementalDecision =
  | { kind: 'carry'; page: PageAudit }
  /** `counts`: the worker's HTML's text and element counts (for the rendered-DOM rule). */
  | { kind: 'audit'; revision: PageRevision; counts?: { text: number; elements: number } };

export interface IncrementalRunOptions {
  options: IncrementalOptions;
  /** The scan's start address (normalised). */
  site: string;
  /** This scan's start (ISO). */
  startedAt: string;
  userAgent: string;
  fetchFn?: typeof fetch;
  allowUrl?: (url: string) => Promise<boolean>;
  /** robots.txt's rule for the site: a same-site file it disallows is not fetched (unsure: its pages are audited). */
  isAllowed?: (url: string) => boolean;
  pace?: Pace;
  /** Sitemap lastmods by `lastmodKey`. */
  lastmods: Readonly<Record<string, string>>;
  /** The page list as it is now (a long scan's grows; it only ever appends). */
  list: () => readonly string[];
  /** A page done in an earlier segment (a resume), by index. */
  known: (index: number) => PageAudit | undefined;
}

export interface IncrementalRun {
  decide(index: number, url: string): Promise<IncrementalDecision>;
  /**
   * The browser audit of a page decided `audit` (or one whose decision failed: `null`): its revision
   * attached, its facts (validators, hash, files, client-rendered) read from the browser's own load
   * (`PageAudit.document`, then dropped). Never throws.
   */
  audited(index: number, page: PageAudit, d: IncrementalDecision | null): Promise<PageAudit>;
}

interface Fetched { status: number; etag?: string; lastModified?: string; body?: string; finalUrl: string }
interface FileFetched { url: string; v: string; imports: AssetRef[]; fresh: boolean; etag?: string; lastModified?: string }

const validators = (f: Pick<Fetched, 'etag' | 'lastModified'>) => ({ ...(f.etag ? { etag: f.etag } : {}), ...(f.lastModified ? { lastModified: f.lastModified } : {}) });

export function createIncrementalRun(o: IncrementalRunOptions): IncrementalRun {
  const full = incrementalIsFull(o.options);
  // The previous results were made by other versions: nothing from them is compared (r1-6).
  const versionsChanged = !!o.options.previous && incrementalIsFull({ previous: o.options.previous });
  // A state from other versions is used for nothing but the page list: everything is audited (r1-6).
  const prev = o.options.previous;
  const byUrl = new Map((prev?.pages ?? []).map((p) => [p.url, p]));
  const fileMemo = new Map<string, Promise<FileFetched | null>>();
  const comparable = prev?.versions?.normalize === NORMALIZE_VERSION;
  const fetchFn = o.fetchFn ?? fetch;
  const conditionalOk = prev?.validators?.trust !== 'ignored';

  // The core-test template sample (samplePages' rule over the previous shapes), read as a prefix of the
  // list, so a page's place in it depends only on the pages before it.
  let scanned = 0;
  const patterns = new Set<string>();
  const shapes = new Set<string>();
  const coreSample = new Set<number>();
  const scanTo = (i: number) => {
    const list = o.list();
    for (; scanned <= i && scanned < list.length; scanned++) {
      const url = list[scanned]!;
      const pattern = urlPattern(url);
      const shape = byUrl.get(url)?.shape ?? '';
      const isNew = !patterns.has(pattern) && !(shape && shapes.has(shape));
      patterns.add(pattern);
      if (shape) shapes.add(shape);
      if (isNew && coreSample.size < PROBE_SAMPLE_SIZE) coreSample.add(scanned);
    }
  };

  /**
   * One GET through the politeness controller (`page`: a page load, so the Crawl-delay applies),
   * redirects by hand (each hop through allowUrl). `done` ends its time box once the body is read. Every
   * response it does not hand back (a redirect, a refused answer) has its body cancelled (r2-5).
   */
  async function get(url: string, headers: Record<string, string>, page: boolean): Promise<{ res: Response; url: string; done: () => void } | null> {
    let current = url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      if (o.allowUrl && !(await o.allowUrl(current))) return null;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const done = () => clearTimeout(timer);
      const once = () => {
        clearTimeout(timer);
        const c = new AbortController();
        timer = setTimeout(() => c.abort(), FETCH_TIMEOUT_MS);
        return fetchFn(current, { headers, redirect: 'manual', signal: c.signal });
      };
      let res: Response | undefined;
      try {
        if (o.pace) {
          const r = await o.pace.load(current, once, (x) => ({ status: x.status, retryAfter: x.headers.get('retry-after') }), {
            page, retries: PACE_DEFAULTS.retries, discard: (x) => { cancel(x); },
          });
          if (r.refused) {
            if (r.value) cancel(r.value);
            res = undefined;
          } else res = r.value;
        } else res = await once();
      } catch {
        res = undefined;
      }
      if (!res) {
        done();
        return null;
      }
      const location = res.status >= 300 && res.status < 400 && res.status !== 304 ? res.headers.get('location') : null;
      if (!location) return { res, url: current, done };
      done();
      cancel(res);
      let next: URL;
      try {
        next = new URL(location, current);
      } catch {
        return null;
      }
      if (next.protocol !== 'http:' && next.protocol !== 'https:') return null;
      next.hash = '';
      current = next.href;
    }
    return null;
  }

  /**
   * The worker's request headers, the same on every GET of every scan (r2-4): its user agent, Accept,
   * Accept-Language, never a cookie; plus the stored validators on a conditional GET.
   */
  const headersFor = (accept: string, v?: { etag?: string | undefined; lastModified?: string | undefined }): Record<string, string> => ({
    'user-agent': o.userAgent, accept, 'accept-language': WORKER_ACCEPT_LANGUAGE,
    ...(v?.etag ? { 'if-none-match': v.etag } : {}),
    ...(v?.lastModified ? { 'if-modified-since': v.lastModified } : {}),
  });
  /** Conditional GETs only while the site's validators are trusted, and never on a full cycle (r1-1, r2-1). */
  const useValidators = conditionalOk && !full;

  /** The page's GET (conditional when `st` is given and validators are in use). Status 0: the body was cut (unsure). */
  async function fetchPage(url: string, st?: PageState): Promise<Fetched | null> {
    const got = await get(url, headersFor(PAGE_ACCEPT, st && useValidators ? st : undefined), true);
    if (!got) return null;
    const { res } = got;
    try {
      const v = validators({ etag: res.headers.get('etag') ?? undefined, lastModified: res.headers.get('last-modified') ?? undefined });
      if (res.status !== 200) {
        cancel(res);
        return { status: res.status, ...v, finalUrl: got.url };
      }
      const { text, truncated } = await readCapped(res);
      return { status: truncated ? 0 : 200, body: text, ...v, finalUrl: got.url };
    } finally {
      got.done();
    }
  }

  /**
   * One file this scan (once per identity, any origin, paced as a file load): its version is the
   * SHA-256 of its body (a 304, while validators are in use, keeps the stored one), and a stylesheet's
   * same-site `@import`s are read from the body every time it is fetched (r2-2; kept with it for a 304).
   * Null when unsure: no answer, an error, a body cut at 5 MB (r1-5), a same-site file robots.txt
   * disallows, or a 304 for a file whose body was never read.
   */
  function fileState(ref: AssetRef): Promise<FileFetched | null> {
    let p = fileMemo.get(ref.id);
    if (!p) {
      p = (async (): Promise<FileFetched | null> => {
        if (o.isAllowed && sameSite(ref.url) && o.isAllowed(ref.url) === false) return null;
        const before = prev?.assets[ref.id];
        const got = await get(ref.url, headersFor('*/*', before && useValidators ? before : undefined), false);
        if (!got) return null;
        const { res } = got;
        try {
          const etag = res.headers.get('etag') ?? undefined;
          const lastModified = res.headers.get('last-modified') ?? undefined;
          const keep = { ...(etag ? { etag } : {}), ...(lastModified ? { lastModified } : {}) };
          if (res.status === 304) {
            cancel(res);
            if (!before) return null;
            return { url: ref.url, v: before.v, imports: before.imports ?? [], fresh: false, ...validators(before), ...keep };
          }
          if (res.status < 200 || res.status >= 300) {
            cancel(res);
            return null;
          }
          const { text, truncated } = await readCapped(res);
          if (truncated) return null;
          const css = /css/i.test(res.headers.get('content-type') ?? '') || /\.css$/i.test(new URL(ref.url).pathname);
          return { url: ref.url, v: await sha256Hex(text), imports: css ? cssImports(text, ref.url, o.site) : [], fresh: true, ...keep };
        } finally {
          got.done();
        }
      })().catch(() => null);
      fileMemo.set(ref.id, p);
    }
    return p;
  }

  const sameSite = (url: string) => {
    try {
      return new URL(url).hostname.replace(/^www\./, '') === new URL(o.site).hostname.replace(/^www\./, '');
    } catch {
      return false;
    }
  };

  /**
   * The files a page uses, with every stylesheet's `@import`s followed (breadth first, at most
   * MAX_IMPORT_DEPTH levels below the page's own refs; deeper is unsure), each with this scan's version.
   * The set depends only on the files, never on which page fetched a file first (r2-2).
   */
  async function versioned(refs: readonly AssetRef[]) {
    const out = new Map<string, PageRevision['assets'][number]>();
    let unsure = false;
    let level: AssetRef[] = [...refs];
    const seen = new Set(level.map((r) => r.id));
    for (let depth = 0; level.length; depth++) {
      const next: AssetRef[] = [];
      for (const r of level) {
        const f = await fileState(r);
        if (!f) {
          unsure = true;
          out.set(r.id, { id: r.id, url: r.url, ...(depth ? { imported: true } : {}) });
          continue;
        }
        out.set(r.id, {
          id: r.id, url: r.url, v: f.v, ...(f.fresh ? { fresh: true } : {}), ...(f.imports.length ? { imports: f.imports } : {}),
          ...validators(f), ...(depth ? { imported: true } : {}),
        });
        for (const imp of f.imports) {
          if (seen.has(imp.id)) continue;
          seen.add(imp.id);
          if (depth + 1 > MAX_IMPORT_DEPTH) unsure = true;
          else next.push(imp);
        }
      }
      level = next;
    }
    const assets = [...out.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return { assets, unsure, changed: assets.filter((a) => a.v && a.v !== prev?.assets[a.id]?.v).map((a) => a.id) };
  }

  /** The page's normalised-HTML hash (from the worker's own GET), the files it uses and its HTML's size. */
  async function facts(body: string, finalUrl: string, requested: string) {
    const thin = isThinHtml(body);
    return {
      // Where a redirect ended is part of what the page is.
      hash: await sha256Hex(`${normalizeHtml(body, finalUrl)}${finalUrl !== requested ? `\nredirected to ${finalUrl}` : ''}`),
      assets: assetRefs(body, finalUrl, o.site),
      counts: staticCounts(body),
      ...(thin ? { thin: true } : {}),
    };
  }

  async function decide(index: number, url: string): Promise<IncrementalDecision> {
    const st = byUrl.get(url);
    const lastmod = o.lastmods[lastmodKey(url)];
    const lmSaid = prev ? lastmodSays(lastmod, prev.startedAt) : undefined;
    const revision = (r: Partial<PageRevision> & Pick<PageRevision, 'decided'>): PageRevision => ({
      carried: false, assets: [], since: o.startedAt, ...(lastmod ? { lastmod } : {}), ...(lmSaid ? { lastmodSaid: lmSaid } : {}), ...r,
    });
    const audit = (r: PageRevision, counts?: { text: number; elements: number }): IncrementalDecision => ({ kind: 'audit', revision: r, ...(counts ? { counts } : {}) });
    scanTo(index);
    const fromState: Partial<PageRevision> = st ? { ...validators(st), ...(st.hash ? { hash: st.hash } : {}) } : {};
    // The page's own refs; the files they import are found again from them (r2-2).
    const stateRefs: AssetRef[] = (st?.assets ?? []).map((id) => ({ id, url: prev?.assets[id]?.url ?? id }));

    /**
     * A page going to the browser anyway still gets the worker's GET first (r2-4): the stored hash always
     * comes from the worker, with the same headers every time, so the next scan compares like with like.
     * That GET is plain (the body is real evidence); on a full cycle, a page whose body could not be read
     * leaves the sitemap unproven (r2-3).
     */
    const toBrowser = async (decided: RevisionDecision): Promise<IncrementalDecision> => {
      // Plain (no validators): the page is loaded anyway, so its body is read as real evidence.
      const f = await fetchPage(url);
      if (f?.status === 200 && f.body !== undefined) {
        const { assets: refs, counts, ...x } = await facts(f.body, f.finalUrl, url);
        const v = await versioned(refs);
        const same = !!st?.hash && comparable && x.hash === st.hash;
        return audit(revision({
          decided, ...validators(f), ...x, fresh: true, assets: v.assets,
          ...(st?.hash && comparable ? { htmlSaid: same ? 'unchanged' : 'changed' } : {}),
        }), counts);
      }
      // A 304 (not on a full cycle): unchanged, the stored hash stays (no evidence either way).
      if (f?.status === 304) return audit(revision({ decided, ...fromState, ...validators(f), assets: (await versioned(stateRefs)).assets }));
      return audit(revision({ decided, ...fromState, ...(full ? { bodyUnread: true } : {}), assets: (await versioned(stateRefs)).assets }));
    };

    if (!prev || !st) return toBrowser('new');
    if (full) return toBrowser('full');
    const must: RevisionDecision | null = index === 0 ? 'home' : prev.shell || st.thin ? 'client-rendered' : coreSample.has(index) ? 'sample' : null;
    if (must) return toBrowser(must);

    // Layers 1–3: is the page's HTML the same?
    let layer: RevisionDecision;
    let html: Partial<PageRevision>;
    let refs = stateRefs;
    let counts: { text: number; elements: number } | undefined;
    if (prev.lastmod.trust === 'trusted' && lmSaid === 'unchanged') {
      layer = 'lastmod';
      html = fromState;
    } else {
      const f = await fetchPage(url, st);
      if (!f || f.status === 0) return audit(revision({ decided: 'unsure', ...fromState, assets: (await versioned(stateRefs)).assets }));
      if (f.status === 304) {
        // Not evidence about the body (r1-1): the stored hash stays, no `htmlSaid`.
        layer = 'not-modified';
        html = { ...fromState, ...validators(f) };
      } else if (f.status === 200 && f.body !== undefined) {
        const { assets: freshRefs, counts: c, ...x } = await facts(f.body, f.finalUrl, url);
        counts = c;
        const same = !!st.hash && x.hash === st.hash;
        html = { ...validators(f), ...x, fresh: true, htmlSaid: same ? 'unchanged' : 'changed' };
        refs = freshRefs;
        layer = 'same-html';
        if (!same) return audit(revision({ decided: 'changed', ...html, assets: (await versioned(refs)).assets }), counts);
      } else {
        return audit(revision({ decided: 'changed', ...fromState, ...validators(f) }));
      }
    }
    // Every file it uses now (and used last time), imports followed: versions this scan.
    const ids = new Set(refs.map((r) => r.id));
    const both = await versioned([...refs, ...stateRefs.filter((r) => !ids.has(r.id))]);
    const used = await versioned(refs);
    const rev = (decided: RevisionDecision, extra: Partial<PageRevision> = {}) => revision({ decided, ...html, assets: used.assets, ...extra });
    if (html.thin) return audit(rev('client-rendered'), counts);
    if (both.unsure) return audit(rev('unsure'), counts);
    // A changed file re-audits every page that uses it (r1-3).
    if (both.changed.length) return audit(rev('asset-changed'), counts);
    const carried = await o.options.carried(url).catch(() => undefined);
    if (!carried || carried.status !== 'ok') return audit(rev('no-previous-audit'), counts);
    const { revision: _r, unchangedSince: _u, document: _d, ...kept } = carried;
    return { kind: 'carry', page: { ...kept, url, unchangedSince: st.since, revision: rev(layer, { carried: true, since: st.since }) } };
  }

  async function audited(_index: number, page: PageAudit, d: IncrementalDecision | null): Promise<PageAudit> {
    const { revision: _r, unchangedSince: _u, document: doc, ...fresh } = page;
    const revision: PageRevision = d?.kind === 'audit' ? { ...d.revision } : { decided: 'unsure', carried: false, assets: [], since: o.startedAt };
    try {
      const st = byUrl.get(page.url);
      // Client-rendered (r1-2b): the browser's rendered DOM against the worker's HTML.
      const counts = d?.kind === 'audit' ? d.counts : undefined;
      if (counts && doc?.rendered && renderedDiffers(counts, doc.rendered)) revision.thin = true;
      // A full cycle checks the lastmod against the audit too: a page it called unchanged whose results
      // changed revokes the trust (r1-1).
      if (full && !versionsChanged && st && revision.lastmodSaid === 'unchanged') {
        const before = await o.options.carried(page.url).catch(() => undefined);
        if (before) revision.auditSaid = findingsKey(fresh as PageAudit) === findingsKey(before) ? 'unchanged' : 'changed';
      }
    } catch {
      // the facts are best effort: a page without them is audited next time
    }
    return { ...fresh, revision };
  }

  return { decide, audited };
}

/** Pages that share one normalised HTML at or above this share (and at least 3) make a client-rendered site. */
export const SHELL_SHARE = 0.5;

/**
 * The monitor's state after a scan, from every page it holds now (audited or carried, each with its
 * revision): the pages that loaded, the files they use, the sitemap's trust, the validators' trust,
 * whether the site is a client-rendered shell, and the versions that made it. Pages that did not load
 * are left out (audited next time).
 */
export function nextIncrementalState(prev: IncrementalPrevious | null, pages: readonly PageAudit[], scan: { startedAt: string; full: boolean }): IncrementalPrevious {
  const states: PageState[] = [];
  const assets: Record<string, AssetState> = {};
  const seen: PageRevision[] = [];
  const before = new Map((prev?.pages ?? []).map((p) => [p.url, p]));
  const comparable = prev?.versions?.normalize === NORMALIZE_VERSION;
  let validators: ValidatorTrust = prev?.validators ?? { trust: 'ok' };
  for (const p of pages) {
    const r = p.revision;
    if (!r) continue;
    seen.push(r);
    // Validators that lie (r1-1): a real body that differs from the stored one under the same ETag (or,
    // without one, the same Last-Modified). Conditional GETs stop for this site.
    const b = before.get(p.url);
    if (validators.trust === 'ok' && comparable && r.fresh && b?.hash && r.hash && r.hash !== b.hash
      && ((b.etag && r.etag === b.etag) || (!b.etag && b.lastModified && r.lastModified === b.lastModified))) {
      validators = { trust: 'ignored', why: 'a page changed while its ETag or Last-Modified stayed the same' };
    }
    if (p.status !== 'ok') continue;
    const shape = pageShapeOf(p);
    states.push({
      url: p.url, assets: r.assets.filter((a) => !a.imported).map((a) => a.id), since: r.since,
      ...(r.etag ? { etag: r.etag } : {}), ...(r.lastModified ? { lastModified: r.lastModified } : {}), ...(r.hash ? { hash: r.hash } : {}),
      ...(shape ? { shape } : {}), ...(r.lastmod ? { lastmod: r.lastmod } : {}), ...(r.thin ? { thin: true } : {}),
    });
    for (const a of r.assets) {
      // Files lie too (r2-1): a body read now that differs under the same ETag (or Last-Modified).
      const was = prev?.assets[a.id];
      if (validators.trust === 'ok' && a.fresh && a.v && was?.v && a.v !== was.v
        && ((was.etag && a.etag === was.etag) || (!was.etag && was.lastModified && a.lastModified === was.lastModified))) {
        validators = { trust: 'ignored', why: 'a stylesheet or script changed while its ETag or Last-Modified stayed the same' };
      }
      if (a.v && !assets[a.id]) {
        assets[a.id] = { url: a.url, v: a.v, ...(a.imports?.length ? { imports: a.imports } : {}), ...(a.etag ? { etag: a.etag } : {}), ...(a.lastModified ? { lastModified: a.lastModified } : {}) };
      }
    }
  }
  const hashes = new Map<string, number>();
  for (const s of states) if (s.hash) hashes.set(s.hash, (hashes.get(s.hash) ?? 0) + 1);
  const withHash = [...hashes.values()].reduce((a, b) => a + b, 0);
  const most = Math.max(0, ...hashes.values());
  const shell = withHash >= 3 && most >= 3 && most / withHash >= SHELL_SHARE;
  return {
    startedAt: scan.startedAt, pages: states, assets, lastmod: nextLastmodTrust(prev?.lastmod, seen),
    ...(validators.trust === 'ignored' ? { validators } : {}), ...(shell ? { shell: true } : {}), versions: currentVersions(),
  };
}

/** The scan's counts: pages re-checked in the browser, and pages carried forward by layer. */
export function incrementalSummary(pages: readonly PageAudit[], full: boolean): IncrementalSummary {
  const skipped = { lastmod: 0, notModified: 0, sameHtml: 0 };
  let unchanged = 0;
  for (const p of pages) {
    const r = p.revision;
    if (!r?.carried) continue;
    unchanged++;
    if (r.decided === 'lastmod') skipped.lastmod++;
    else if (r.decided === 'not-modified') skipped.notModified++;
    else skipped.sameHtml++;
  }
  return { full, pages: pages.length, checked: pages.length - unchanged, unchanged, skipped };
}
