// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The stylesheet watch: did the site refuse a stylesheet the page needs? A site that is throttling us
// can answer the page itself and refuse its CSS (HTTP 429 or 503): the page then renders unstyled (a
// mega-menu as a raw list of tiny default-font links) and would be audited, pictured and tested as if
// that were the real page. The watch reads the browser's own responses, so it knows each stylesheet's
// HTTP status and can tell a refusal (the site asking us to slow down) from a stylesheet that is really
// broken (a 404 is the page people get, and is checked as it is). Engine core: no Node-only imports.
//
// The rule (docs/scoring.md, "Pages that could not load their styles"). A stylesheet response counts
// against the page when all of these hold:
// - it is a refusal: HTTP 429 or 503, or HTTP 403 for an address that earlier in this scan answered
//   2xx with CSS (a burst-triggered firewall block), judged when the try ends;
// - it is the latest answer for that address in this try of the page load (a later 2xx clears it),
//   and it answers a request this try sent (a late answer to an earlier try's request is ignored);
// - it is for the page's own document or a frame axe scores with it (same site, about:blank,
//   srcdoc); a frame from another site, or one whose place cannot be told, is not the page;
// - losing it can change what is measured: not a sheet that only declares web fonts (its content
//   seen earlier in this scan was only @font-face rules, or it comes from a web-font service whose
//   CSS is only @font-face rules: `WEB_FONT_CSS_HOSTS`), and not a sheet whose every <link> in the
//   page is one that would not apply now (another media, disabled, alternate, preload only).
// A sheet the page links that never answered with content is assumed to matter: what it would have
// styled cannot be known.
import { isThirdPartyFrame } from './axeRun.js';
import { registrableDomain } from './domain.js';
import { stripDelimited } from './scanText.js';
import { unstyledReason, type Pace } from './pace.js';
import type { PageLike, RequestLike, SubresourceResponseLike } from './types.js';

/** A refused stylesheet the page needs. */
export interface StyleRefusal {
  url: string;
  status: number;
  /** Its Retry-After header, as sent. */
  retryAfter: string | null;
}

export interface StyleWatch {
  /** A new try of the page load starts: what earlier tries saw (and answers to their requests) no longer count. */
  reset(): void;
  /** Waits until this try's stylesheet requests have all answered (or failed), at most `maxMs`. */
  settle(maxMs?: number): Promise<void>;
  /** The refused stylesheets the page needs, in this try so far (after the in-page check). Never throws. */
  degraded(): Promise<StyleRefusal[]>;
}

/**
 * Web-font services whose stylesheets are only `@font-face` rules (Google Fonts and its drop-in
 * twin): losing one changes the typeface, not what the page's own CSS lays out.
 */
export const WEB_FONT_CSS_HOSTS: readonly string[] = ['fonts.googleapis.com', 'fonts.bunny.net'];

/** Stylesheet addresses the scan remembers (loaded with CSS, and what they held), most recent kept. */
export const MAX_REMEMBERED_STYLESHEETS = 2000;
/** The longest `settle` waits by default. */
export const STYLE_SETTLE_MS = 3000;
/** Longest the in-page link check may take (a page that does not answer: every sheet counts). */
const CHECK_MS = 3000;
/** Largest stylesheet body read to see whether it only declares fonts. */
const MAX_READ_CHARS = 2_000_000;

/** What a scan knows about stylesheet addresses: answered 2xx with CSS, and whether it only declared fonts. */
interface SheetMemory {
  /** address → only @font-face rules (or no rules at all). Insertion order = age. */
  seen: Map<string, boolean>;
  /** Bodies of 2xx CSS answers still being read, by address (any page of the scan). */
  reading: Map<string, Promise<void>>;
}
const memories = new WeakMap<Pace, SheetMemory>();
const memoryOf = (pace?: Pace): SheetMemory => {
  if (!pace) return { seen: new Map(), reading: new Map() };
  let m = memories.get(pace);
  if (!m) memories.set(pace, (m = { seen: new Map(), reading: new Map() }));
  return m;
};
function remember(m: SheetMemory, url: string, fontsOnly: boolean): void {
  m.seen.delete(url);
  m.seen.set(url, fontsOnly);
  // Oldest first out: a scan never stops learning addresses.
  while (m.seen.size > MAX_REMEMBERED_STYLESHEETS) m.seen.delete(m.seen.keys().next().value!);
}

/**
 * The CSS without its `/* … *\/` comments; an unclosed one is kept as written. The same result as
 * `css.replace(/\/\*[\s\S]*?\*\//g, '')`, whose lazy scan ran to the end of the text from every unclosed
 * `/*` (quadratic: a 2 MB sheet of `/* ` held the scan's thread).
 */
export const stripCssComments = (css: string): string => stripDelimited(css, '/*', '*/');

/** True when the CSS only declares web fonts (or holds no rules at all): no selector styles anything. */
export function onlyDeclaresFonts(css: string): boolean {
  const rest = stripCssComments(css)
    .replace(/@charset\s+(?:"[^"]*"|'[^']*')\s*;/gi, '')
    .replace(/@font-face\s*\{[^{}]*\}/gi, '');
  return rest.trim() === '';
}

const isWebFontService = (url: string) => {
  try {
    return WEB_FONT_CSS_HOSTS.includes(new URL(url).hostname.toLowerCase());
  } catch {
    return false;
  }
};

/**
 * This try's latest answer for an address: an HTTP status (`answer`), or no usable answer: the browser
 * blocked what came back (`blocked`), the request failed (`failed`), or a 2xx came back that is not CSS
 * (`notcss`). The last three have status 0.
 */
interface Answer {
  status: number;
  kind: 'answer' | 'blocked' | 'failed' | 'notcss';
  retryAfter: string | null;
  frame: WatchedFrame;
}

/**
 * The browser blocked the server's answer before the page could use it: Cross-Origin-Resource-Policy
 * (or embedder policy) on what came back. A firewall's block or challenge page does this (Cloudflare
 * sends CORP same-origin on them); a stylesheet is never served that way to the sites that use it.
 */
const BLOCKED_ANSWER = /ERR_BLOCKED_BY_RESPONSE/;
/** Failures the scan causes itself (a load it stopped, a request its own guard refused): never the site's. */
const OUR_FAILURE = /ERR_ABORTED|ERR_BLOCKED_BY_CLIENT/;

/** Frame-like: what the watch reads of a frame. */
interface WatchedFrame {
  url(): string;
  parentFrame(): WatchedFrame | null;
  evaluate?<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R>;
}

/** Runs in the frame: for each address, whether a <link> there would apply it now. */
function linkState(urls: string[]): ('applies' | 'idle' | 'unknown')[] {
  const links = [...document.querySelectorAll('link[href]')] as HTMLLinkElement[];
  return urls.map((u) => {
    const mine = links.filter((l) => l.href === u);
    if (!mine.length) return 'unknown';
    return mine.some((l) => {
      const rel = ` ${(l.getAttribute('rel') ?? '').toLowerCase()} `.replace(/\s+/g, ' ');
      if (!rel.includes(' stylesheet ') || rel.includes(' alternate ') || l.disabled) return false;
      const media = l.getAttribute('media');
      try {
        return !media || window.matchMedia(media).matches;
      } catch {
        return true;
      }
    }) ? 'applies' : 'idle';
  });
}

/**
 * Watches the page's stylesheet responses from now on (one watch per page, for its whole life).
 * Undefined when the browser cannot report responses (the page has no `on`): nothing changes then.
 * `pace` is the scan's controller: what the scan learned about stylesheet addresses is kept with it.
 * `site`: the scanned page's address (frames on its registrable domain are the page's).
 */
export function watchStyles(page: PageLike, pace?: Pace, site?: string): StyleWatch | undefined {
  if (typeof page.on !== 'function') return undefined;
  const memory = memoryOf(pace);
  let current = 0;
  /** Requests this watch saw sent, by the try that sent them. */
  const tryOf = new WeakMap<object, number>();
  /** Stylesheet requests not answered yet, and body reads not done, with their try. */
  const pending = new Map<object, number>();
  /** This try's answers, by address: the latest answer only. */
  let answers = new Map<string, Answer>();

  const main = (): WatchedFrame | undefined => {
    try {
      return (page.mainFrame?.() as WatchedFrame | undefined) ?? undefined;
    } catch {
      return undefined;
    }
  };
  /**
   * The page's own document or a frame axe merges into it: every frame from the response's up to the
   * main frame is not on another site. Unknown frames are not the page's.
   */
  const inScope = (frame: WatchedFrame | null | undefined): boolean => {
    const top = main();
    if (!top || !frame) return false;
    const sites = new Set([site ?? '', safe(() => top.url()) ?? ''].map(registrableDomain).filter(Boolean));
    for (let f: WatchedFrame | null = frame, depth = 0; f && depth < 50; depth++) {
      if (f === top) return true;
      const u = safe(() => f!.url());
      if (u === undefined || isThirdPartyFrame(u, sites) === true) return false;
      f = safe(() => f!.parentFrame()) ?? null;
    }
    return false;
  };
  const isSheet = (r: RequestLike) => safe(() => r.resourceType()) === 'stylesheet';

  try {
    page.on('request', (req: RequestLike) => {
      tryOf.set(req, current);
      if (isSheet(req)) pending.set(req, current);
    });
    page.on('requestfinished', (req: RequestLike) => { pending.delete(req); });
    page.on('requestfailed', (req: RequestLike) => {
      pending.delete(req);
      try {
        if (!isSheet(req)) return;
        const sentIn = tryOf.get(req);
        if (sentIn !== undefined && sentIn !== current) return;
        const error = safe(() => req.failure?.()?.errorText) ?? '';
        if (OUR_FAILURE.test(error)) return;
        const frame = safe(() => req.frame?.()) as WatchedFrame | undefined;
        if (!inScope(frame)) return;
        answers.set(req.url(), { status: 0, kind: BLOCKED_ANSWER.test(error) ? 'blocked' : 'failed', retryAfter: null, frame: frame! });
      } catch {
        // A request the browser could not describe: nothing to judge.
      }
    });
    page.on('response', (res: SubresourceResponseLike) => {
      try {
        const req = res.request();
        if (!isSheet(req)) return;
        const url = res.url();
        const status = res.status();
        const headers = res.headers();
        // What the scan learns about the address, whichever try or frame asked: it answered 2xx with
        // CSS (the 403 rule, from now on), and, once its body is read, whether it only declares fonts.
        const ok = status >= 200 && status < 300 && status !== 204;
        const css = /css/i.test(headers['content-type'] ?? '');
        if (ok && css) {
          if (!memory.seen.has(url)) remember(memory, url, false);
          // A sheet from this host loaded: its file backoff starts over.
          pace?.fileLoaded(url);
          if (typeof res.text === 'function') {
            const reading: Promise<void> = res.text().then(
              (css) => remember(memory, url, css.length <= MAX_READ_CHARS && onlyDeclaresFonts(css)),
              // The body could not be read (the page moved on): the address still answered with CSS.
              () => undefined,
            ).finally(() => {
              pending.delete(reading);
              if (memory.reading.get(url) === reading) memory.reading.delete(url);
            });
            pending.set(reading, tryOf.get(req) ?? current);
            memory.reading.set(url, reading);
          }
        }
        // A late answer to an earlier try's request is not this try's.
        const sentIn = tryOf.get(req);
        if (sentIn !== undefined && sentIn !== current) return;
        const frame = safe(() => res.frame?.()) as WatchedFrame | undefined;
        if (!inScope(frame)) return;
        answers.set(url, ok && !css
          ? { status: 0, kind: 'notcss', retryAfter: null, frame: frame! }
          : { status, kind: 'answer', retryAfter: headers['retry-after'] ?? null, frame: frame! });
      } catch {
        // A response the browser could not describe (the page closing): nothing to judge.
      }
    });
  } catch {
    return undefined;
  }

  return {
    reset() {
      current++;
      answers = new Map();
    },
    async settle(maxMs = STYLE_SETTLE_MS) {
      const until = Date.now() + maxMs;
      while ([...pending.values()].some((t) => t === current) && Date.now() < until) {
        await new Promise((r) => setTimeout(r, 25));
      }
    },
    async degraded() {
      // A refused address whose 2xx body another page of the scan is still reading: wait for the read
      // (bounded) so a font sheet is not taken for layout CSS for want of time. A failed read leaves it layout.
      const reads = [...answers.keys()].map((u) => memory.reading.get(u)).filter((r): r is Promise<void> => !!r);
      if (reads.length) await withTimeout(Promise.allSettled(reads), STYLE_SETTLE_MS).catch(() => undefined);
      const candidates: { url: string; status: number; retryAfter: string | null; frame: WatchedFrame }[] = [];
      for (const [url, a] of answers) {
        // A blocked answer always counts. A failed request, a non-CSS 2xx and a 403 count only for an
        // address that answered with CSS earlier in the scan: the same answer every time is what every
        // visitor gets.
        const refused = a.kind === 'blocked' || a.status === 429 || a.status === 503
          || ((a.status === 403 || a.kind === 'failed' || a.kind === 'notcss') && memory.seen.has(url));
        if (!refused) continue;
        // Fonts only: the typeface changes, nothing the page's own CSS lays out.
        if (isWebFontService(url) || memory.seen.get(url) === true) continue;
        candidates.push({ url, ...a });
      }
      if (!candidates.length) return [];
      // Per frame, whether the page would apply each sheet now (another media, disabled, alternate or
      // preload-only links do not).
      const byFrame = new Map<WatchedFrame, typeof candidates>();
      for (const c of candidates) byFrame.set(c.frame, [...(byFrame.get(c.frame) ?? []), c]);
      const out: StyleRefusal[] = [];
      for (const [frame, list] of byFrame) {
        let states: string[] = [];
        try {
          const ev = frame === main() ? page.evaluate.bind(page) : frame.evaluate?.bind(frame);
          states = ev ? await withTimeout(ev(linkState, list.map((c) => c.url)), CHECK_MS) : [];
        } catch {
          states = [];
        }
        list.forEach((c, i) => {
          if (states[i] !== 'idle') out.push({ url: c.url, status: c.status, retryAfter: c.retryAfter });
        });
      }
      return out;
    },
  };
}

/**
 * After the page's load was over (its tries done): the reason when a stylesheet the page needs was
 * refused since (a sheet still on its way is waited for, briefly). Each one is charged to its host
 * (`Pace.fileRefused`); there is no try left for the page, so it is not taken for the page.
 */
export async function refusedSince(styles: StyleWatch | undefined, pace: Pace | undefined, pageUrl: string): Promise<string | undefined> {
  if (!styles) return undefined;
  await styles.settle();
  const refused = await styles.degraded();
  if (!refused.length) return undefined;
  for (const f of refused) pace?.fileRefused(f.url, f, pageUrl);
  return unstyledReason(refused[0]!.status, 'once');
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {});
  return Promise.race([p, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timed out')), ms); })]).finally(() => clearTimeout(timer));
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}
