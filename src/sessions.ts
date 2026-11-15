// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Several browser sessions for one scan (`ScanOptions.sessions`). One remote browser session (Browser
// Rendering) is CPU-bound: the page audits and the core tests that share it slow each other down, and
// a scan of 25 pages at two widths runs out of its time. Each session is its own browser, so two or
// three of them do the work in parallel. Engine core: no Node-only imports.
//
// Which session a context opens in only changes WHEN the work runs, never what it finds: every
// context is fresh (its own cache, cookies and storage), each session has its own navigation gate
// (the caller gates each one, `gatedBrowser`), and every result lands at its page's index. The scan's
// politeness toward the site is unchanged too: one pace controller for the whole scan, and the same
// number of pages and tests at once as with one session.
//
// Roles: with one session everything runs in it (the very browser given, nothing wrapped). With more,
// while pages are audited the core tests keep to the last session, and the page audits (and discovery)
// open in whichever session has the fewest contexts open (ties: the first), the core tests' one
// included: the core tests never take the audits' sessions, and the audits use what the tests leave
// free (measured on a CPU-bound model: audits kept off the tests' session left it half idle). Once
// every page is audited (`pagesDone`), the core tests may use every session too. A context whose
// session fails as a closed browser opens in another session first; the session is left for good
// only when it is exhausted (its reconnecting browser has no reopen left), its navigation gate cannot
// hold windows (`GATE_UNARMED`), or it failed `MAX_STRIKES` times in a row.
//
// A site that refuses some sessions (egress: staging 2026-11-04, a school site's host answered HTTP 406
// to some Browser Rendering egress addresses and 200 to others, all or nothing within one session). The
// pool reads each load's final answer in the session it ran in (src/egress.ts `loadOutcome`). A page
// the site refused is loaded again (`refusedRetry`, at most REFUSED_RETRIES times by the caller) only in
// a session that has not refused it. A session is refused by the site when the evidence says its
// address is at fault: it has loaded no page of the site, and a page it was refused loaded in another
// session. Such a session takes no new work while another can, and the host replaces it
// (`EgressHooks.swap`: a fresh session, normally a new address) once its open contexts are done (at
// most `drainMs`), unless a load meanwhile cleared the evidence (a pace retry that got the page): then
// the swap is dropped before the host is asked. When the host allows no swap it is used only when
// nothing else is, until it loads a page. A page refused in two sessions while other pages of the site load is the site refusing
// that page: it is not tried again. When every session has refused a page, a fresh one is asked for
// (a swap) before it counts as refused. Which session ran a page still never changes what it finds:
// the retry is the same audit, and with no refusal nothing here changes where work runs.
//
// A site that refuses us everywhere (staging 2026-11-05, scan 5b4986ad: 40 of 41 pages refused within
// seconds, in every session) is not an address at fault, and no swap can help it. Once a session that
// loaded the site is refused SITE_REFUSES_STREAK different pages in a row (406, 429 or a challenge: a 401
// or 403 is a page's own access rule, and a second width of a page it just loaded is that page's), the
// site is refusing us: the host and the pace are told once (`EgressHooks.siteRefuses`, `onSiteRefuses`),
// and, until a successful load shows recovery, a refused page is retried only in a session that loads
// the site, never with a swap bought for it. After recovery, new refusals are address evidence again.
// A session that has loaded nothing and is at fault is still judged, swapped or kept out of the way
// (review r1: one blocked address beside a site that rate-limits once must still be replaced).
//
// Every wait here is bounded (`EgressHooks.waitMs`): a context that waits for a session being replaced
// fails as lost work at the bound (`SESSION_WAIT`), and a retry that waits gives up with its refusal.
import { CONTEXT_CLOSE_MS, isBrowserExhausted, isBrowserGone } from './reconnect.js';
import { isGateUnarmed, isGatedBrowser, markGated } from './navigationGate.js';
import { loadOutcome, navigationOf, type LoadOutcome } from './egress.js';
import type { BrowserLike, ContextLike, PageLike } from './types.js';

export interface SessionPool {
  /** Sessions in the pool. */
  readonly size: number;
  /** For discovery, the page audits and the evidence pass: every session. */
  readonly audit: BrowserLike;
  /** For the core tests: the last session while pages are audited, then every session. */
  readonly probe: BrowserLike;
  /** Every page is audited: from now on the core tests may use every session. */
  pagesDone(): void;
  /**
   * A page whose load the site refused: a browser to load it again in, whose contexts open only in
   * sessions that have not refused it (a fresh one from the host when every session has), or null
   * when it is not tried again (a refusal of that page, or no session left to try). `role`: whose
   * preferences the retry keeps (default the audits').
   */
  refusedRetry(url: string, role?: 'audit' | 'probe'): Promise<BrowserLike | null>;
}

/** What the host offers for sessions the site refuses (hosted: Browser Rendering sessions). */
export interface EgressHooks {
  /** Session `session` (its place among the scan's browsers) is refused by the site; `status`: the answer. */
  refused?(session: number, status: number | undefined): void;
  /**
   * Replaces session `session` with a fresh one (closing the old one). True once the new one is in
   * use; false when the host allows no swap (its cap, its budget) or none could be opened.
   */
  swap?(session: number): Promise<boolean>;
  /**
   * The site refuses even a session that loaded it: it is refusing the scan, not an address. Said once;
   * no swap is asked for while the site keeps refusing us. Must not throw.
   */
  siteRefuses?(): void;
  /** Longest a context or a retry waits for a session being replaced (default SESSION_WAIT_MS). */
  waitMs?: number;
}

export interface SessionPoolOptions {
  egress?: EgressHooks;
  /** Longest a session to be replaced waits for its open contexts to close (default DRAIN_MS). */
  drainMs?: number;
  /** The site refuses even a session that loaded it (said once): the scan's pace goes down. Must not throw. */
  onSiteRefuses?(): void;
  /**
   * Record and replay (src/replay): true for a load's answer that the scan's own copy gave. Such an
   * answer is no evidence of which sessions the site lets in. Absent (replay off): every answer counts.
   */
  copied?(answer: unknown): boolean;
}

/** Different pages refused in a row (406, 429, a challenge) on a session that loaded the site: the site refuses us. */
export const SITE_REFUSES_STREAK = 3;

/** A refusal that says the site refuses the scan (rate limit, blocked agent, challenge), not a page's own access rule. */
const refusesScan = (status: number | undefined): boolean => status === undefined || status === 406 || status === 429 || status < 400;

/** Longest a context or a retry waits for a session being replaced (EgressHooks.waitMs). */
export const SESSION_WAIT_MS = 60_000;
/** In the error of a context that waited for a session being replaced past the bound. */
export const SESSION_WAIT = 'no browser session of the scan came free in time';
/**
 * A page whose audit waited for a session past the bound: not checked. Never a lost browser (that takes
 * the scan's score) nor the site's answer (review r1).
 */
export const SESSION_WAIT_PAGE = 'Not checked: no browser session of the scan was free in time';
/** A page or context that waited for a session past the bound (its error, or SESSION_WAIT_PAGE). */
export function isSessionWait(reason: string | undefined): boolean {
  return !!reason && (reason.includes(SESSION_WAIT) || reason === SESSION_WAIT_PAGE);
}

/** Whether any of `ps` settles before `until` (the waits are never cancelled, only no longer waited for). */
async function anyBefore(ps: readonly Promise<unknown>[], until: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      ...ps.map((p) => p.then(() => true, () => true)),
      new Promise<boolean>((r) => { timer = setTimeout(() => r(false), Math.max(0, until - Date.now())); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Longest a session the site refuses waits for its open contexts before it is replaced. */
export const DRAIN_MS = 15_000;

/** Most sessions a scan uses. */
export const MAX_SESSIONS = 8;
/**
 * Closed-browser errors in a row before a session that never says it is exhausted is left (a plain
 * browser that closed). A reconnecting browser says so itself after at most two failed reopen cycles.
 */
export const MAX_STRIKES = 3;


export function sessionPool(sessions: readonly BrowserLike[], opts: SessionPoolOptions = {}): SessionPool {
  const all = sessions.slice(0, MAX_SESSIONS);
  if (!all.length) throw new Error('sessionPool needs a browser');
  const egress = opts.egress;
  // One session and nothing to swap it with: the very browser given, nothing wrapped.
  if (all.length === 1 && !egress?.swap) {
    const only = all[0]!;
    return { size: 1, audit: only, probe: only, pagesDone() {}, refusedRetry: async () => null };
  }
  const drainMs = opts.drainMs ?? DRAIN_MS;
  const waitMs = egress?.waitMs ?? SESSION_WAIT_MS;
  /** The site refuses even a session that loaded it: retries only in sessions that load it, none bought. */
  let siteRefusing = false;
  /** The host and pace hear once, even if the site recovers and later refuses us again. */
  let siteRefusesTold = false;
  /** Per session: different pages refused in a row (refusesScan) since its last load of the site. */
  const streak = new Map<string, Set<string>>();
  const open = all.map(() => 0);
  const lost = all.map(() => false);
  /**
   * Closed-browser errors in a row per session (a success clears it), counted once per round: calls
   * that were already on their way when one failed share its reopen cycle, so they fail with it and
   * count once (`struckAt`: the last call sent, in send order, when one counted).
   */
  const strikes = all.map(() => 0);
  const struckAt = all.map(() => 0);
  let sends = 0;
  let pagesDone = false;
  const everyOne = all.map((_, i) => i);
  const probeOwn = [all.length - 1];

  // ---- what the site answered, per session ----
  /** Each place's session generation: a swapped session is a new one, with no history. */
  const gen = all.map(() => 0);
  const keyOf = (i: number) => `${i}#${gen[i]}`;
  /** Sessions that loaded a page of the site. */
  const okKeys = new Set<string>();
  /** Page address → sessions that loaded it. */
  const okBy = new Map<string, Set<string>>();
  /** Page address → sessions whose last load of it was refused, with the status. */
  const refusedBy = new Map<string, Map<string, number | undefined>>();
  /** Session → pages whose last load in it was refused, with the status. */
  const refusals = new Map<string, Map<string, number | undefined>>();
  /** Sessions the host was told are refused (`EgressHooks.refused`): once each. */
  const told = new Set<string>();
  /** A place whose session is being replaced: takes no new work until the new one is in. */
  const swapping: (Promise<void> | undefined)[] = all.map(() => undefined);
  /** Refused by the site and not replaced: used only when no other session can take the work. */
  const shunned = all.map(() => false);
  const drainers: (() => void)[][] = all.map(() => []);

  const entry = <K, V>(m: Map<K, V>, k: K, make: () => V): V => {
    let v = m.get(k);
    if (v === undefined) m.set(k, (v = make()));
    return v;
  };
  /** Refused something and loaded nothing: its address may be the one refused. */
  const suspect = (k: string) => (refusals.get(k)?.size ?? 0) > 0 && !okKeys.has(k);
  /**
   * The evidence says the site refuses this session's address: it has loaded no page of the site, and
   * a page it was refused loaded in another session (review r1: one refused page on a session that
   * loads the site is that page's answer, a pace retry or a per-page rule, never the address's).
   */
  const atFault = (k: string) => {
    if (okKeys.has(k)) return false;
    const r = refusals.get(k);
    if (!r?.size) return false;
    return [...r.keys()].some((u) => [...(okBy.get(u) ?? [])].some((o) => o !== k));
  };
  /** The place a session key is in, when it is still that place's current session. */
  const slotOf = (k: string): number | undefined => {
    const i = Number(k.split('#')[0]);
    return Number.isInteger(i) && keyOf(i) === k ? i : undefined;
  };
  const tell = (i: number, k: string) => {
    if (told.has(k)) return;
    told.add(k);
    const status = refusals.get(k)?.values().next().value;
    try {
      egress?.refused?.(i, status);
    } catch {
      // a listener's bug must not stop the scan
    }
  };
  const release = (i: number) => {
    open[i]!--;
    if (open[i]! > 0) return;
    for (const done of drainers[i]!.splice(0)) done();
  };
  const drain = (i: number) => (open[i]! <= 0 ? Promise.resolve() : new Promise<void>((resolve) => {
    const timer = setTimeout(done, drainMs);
    function done() {
      clearTimeout(timer);
      resolve();
    }
    drainers[i]!.push(done);
  }));
  /**
   * Replaces the session at `i` once its open contexts are done (one swap at a time per place), if
   * `still()` holds then: a later load that cleared the evidence (a pace retry that got the page)
   * cancels a swap whose host call has not been made yet, and the place takes work again.
   */
  const startSwap = (i: number, still: () => boolean): Promise<void> => {
    const running = swapping[i];
    if (running) return running;
    const k = keyOf(i);
    const p = (async () => {
      await drain(i);
      if (keyOf(i) !== k || !still()) {
        // Told again if the evidence comes back. A place still refused and loading nothing is kept out
        // of the way meanwhile (review r1).
        told.delete(k);
        if (keyOf(i) === k && !okKeys.has(k) && (refusals.get(k)?.size ?? 0) > 0) shunned[i] = true;
        return;
      }
      let ok = false;
      try {
        ok = !!egress?.swap && (await egress.swap(i));
      } catch {
        ok = false;
      }
      if (ok) {
        gen[i]!++;
        shunned[i] = false;
        strikes[i] = 0;
      } else shunned[i] = true;
    })().finally(() => {
      swapping[i] = undefined;
    });
    swapping[i] = p;
    return p;
  };
  /** Sessions the evidence now says are refused: told to the host and replaced (or kept out of the way). */
  const judge = () => {
    for (const i of everyOne) {
      if (lost[i] || swapping[i] || shunned[i]) continue;
      const k = keyOf(i);
      if (told.has(k) || !atFault(k)) continue;
      tell(i, k);
      if (egress?.swap) void startSwap(i, () => atFault(k));
      else shunned[i] = true;
    }
  };
  const note = (k: string, url: string, outcome: LoadOutcome, status: number | undefined) => {
    if (outcome === 'ok') {
      siteRefusing = false;
      okKeys.add(k);
      entry(okBy, url, () => new Set()).add(k);
      streak.delete(k);
      refusedBy.get(url)?.delete(k);
      refusals.get(k)?.delete(url);
      // It loads the site: no longer kept out of the way.
      const i = slotOf(k);
      if (i !== undefined) shunned[i] = false;
    } else if (outcome === 'refused') {
      entry(refusedBy, url, () => new Map()).set(k, status);
      // Once the site refuses us everywhere, a refusal says nothing about the session's address (no swap can
      // help): until a successful load shows recovery, it is no evidence against the session. Earlier evidence
      // still counts (review r1). Otherwise a retry let into a fresh session just before the rule fired, refused
      // there just after, bought one more swap (the CI runner, 2026-11-09: 3 swaps for 3 places).
      if (!siteRefusing) entry(refusals, k, () => new Map()).set(url, status);
      // A streak of the site refusing a session that loads it (review r1: never a page's own 401/403, nor
      // the second width of a page this session loaded).
      if (okKeys.has(k) && refusesScan(status) && !okBy.get(url)?.has(k)) {
        const run = entry(streak, k, () => new Set<string>());
        run.add(url);
        if (!siteRefusing && run.size >= SITE_REFUSES_STREAK) refusesUs();
      }
    } else return;
    judge();
  };
  const refusesUs = () => {
    siteRefusing = true;
    if (siteRefusesTold) return;
    siteRefusesTold = true;
    for (const fn of [egress?.siteRefuses, opts.onSiteRefuses]) {
      try {
        fn?.();
      } catch {
        // a listener's bug must not stop the scan
      }
    }
  };
  const fromCopy = (answer: unknown): boolean => {
    try {
      return opts.copied?.(answer) === true;
    } catch {
      return false;
    }
  };
  /** Every load of a page opened in session `k`: its final answer is noted (the page's own goto, wrapped in place). */
  const watch = (page: PageLike, k: string) => {
    const goto = page.goto.bind(page);
    const nav = navigationOf(page);
    page.goto = async (url, o) => {
      nav.reset();
      let r: Awaited<ReturnType<PageLike['goto']>>;
      try {
        r = await goto(url, o);
      } catch (err) {
        const status = nav.status();
        if (status !== undefined) note(k, url, loadOutcome(status), status);
        throw err;
      }
      if (r) {
        let status: number | undefined;
        let headers: Record<string, string> | undefined;
        try {
          status = r.status();
          headers = r.headers();
        } catch {
          status = undefined;
        }
        // An answer from the scan's own copy of the site (src/replay) is not the site letting this
        // session in: it is no evidence either way (a copied 200 used to end "the site refuses us
        // everywhere", and refusals bought swaps again: 4 where a live scan makes 2).
        if (status !== undefined && !fromCopy(r)) note(k, url, loadOutcome(status, headers), status);
      }
      return r;
    };
  };

  /**
   * The session to open in: among the live ones that may take it (`allow`), first those not being
   * replaced and not refused by the site, then any not being replaced; among them first one not yet
   * tried for this context, then the role's own, then the least busy, then the first. 'wait' when the
   * only ones left are being replaced; undefined when none is left.
   */
  const pick = (own: readonly number[], tried: readonly number[], allow?: (i: number) => boolean): number | 'wait' | undefined => {
    const mine = pagesDone ? everyOne : own;
    const key = (i: number) => [tried[i]! > 0 ? 1 : 0, mine.includes(i) ? 0 : 1, open[i]!, i];
    const before = (x: number, y: number) => {
      const [a, b] = [key(x), key(y)];
      for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) return a[k]! < b[k]!;
      return false;
    };
    const best = (xs: number[]) => xs.reduce<number | undefined>((b, i) => (b === undefined || before(i, b) ? i : b), undefined);
    let live = everyOne.filter((i) => !lost[i] && (!allow || allow(i)));
    // A retry's sessions, when none of them is left: any live one (a load that may be refused again).
    if (!live.length && allow) live = everyOne.filter((i) => !lost[i]);
    const free = live.filter((i) => !swapping[i]);
    const ready = free.filter((i) => !shunned[i]);
    const chosen = best(ready.length ? ready : free);
    if (chosen !== undefined) return chosen;
    return live.length ? 'wait' : undefined;
  };
  const view = (own: readonly number[], allow?: (i: number) => boolean): BrowserLike => ({
    async newContext(o) {
      const tried = all.map(() => 0);
      let until: number | undefined;
      for (;;) {
        const i = pick(own, tried, allow);
        if (i === undefined) throw new Error('Target page, context or browser has been closed (every browser session of the scan was lost)');
        if (i === 'wait') {
          // Bounded (staging 5b4986ad: a swap whose launch never came back held every page for ever).
          until ??= Date.now() + waitMs;
          if (!(await anyBefore(swapping.filter((p): p is Promise<void> => !!p), until))) {
            throw new Error(`Target page, context or browser has been closed (${SESSION_WAIT})`);
          }
          continue;
        }
        tried[i]!++;
        open[i]!++;
        const sent = ++sends;
        const k = keyOf(i);
        let ctx: ContextLike;
        try {
          ctx = await all[i]!.newContext(o);
          strikes[i] = 0;
        } catch (err) {
          release(i);
          if (!isBrowserGone(err) || all.length === 1) throw err;
          // Lost for good: a reconnecting browser with no reopen left, a session whose gate cannot
          // hold its windows, or one that kept failing as closed. Until then a closed-browser error
          // only sends this context elsewhere first: the session's next call is its next reopen.
          if (sent > struckAt[i]!) {
            strikes[i]!++;
            struckAt[i] = sends;
          }
          if (isBrowserExhausted(err) || isGateUnarmed(err) || strikes[i]! >= MAX_STRIKES) lost[i] = true;
          continue;
        }
        const close = ctx.close.bind(ctx);
        const newPage = ctx.newPage.bind(ctx);
        let closed = false;
        return Object.assign(ctx, {
          async newPage() {
            const page = await newPage();
            watch(page, k);
            return page;
          },
          async close() {
            if (!closed) {
              closed = true;
              release(i);
            }
            // Bounded (review r1): a close that never answers does not hold its caller (one that fails still says so).
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              const closing = close();
              // A failure after the bound is nobody's to hear (Promise.race already subscribes; said explicitly).
              closing.catch(() => {});
              await Promise.race([closing, new Promise<void>((r) => { timer = setTimeout(r, CONTEXT_CLOSE_MS); })]);
            } finally {
              clearTimeout(timer);
            }
          },
        });
      }
    },
  });
  const gated = all.every(isGatedBrowser);
  const marked = (b: BrowserLike) => {
    // Every session gated (the scan gates each one): the views need no gate of their own.
    if (gated) markGated(b);
    return b;
  };
  const audit = marked(view(everyOne));
  const probe = marked(view(probeOwn));
  return {
    size: all.length, audit, probe,
    pagesDone() {
      pagesDone = true;
    },
    async refusedRetry(url, role = 'audit') {
      const until = Date.now() + waitMs;
      const refusers = refusedBy.get(url) ?? new Map<string, number | undefined>();
      // Refused in two sessions while other pages of the site load: the site refuses that page.
      if (refusers.size >= 2 && [...okBy.keys()].some((u) => u !== url)) return null;
      const allow = (i: number) => !refusers.has(keyOf(i)) && !suspect(keyOf(i));
      const own = role === 'probe' ? probeOwn : everyOne;
      const ready = () => everyOne.some((i) => !lost[i] && !swapping[i] && !shunned[i] && allow(i));
      // The site refuses us everywhere: only a session that loads the site may take the retry, at once,
      // with no wait and no swap bought for it; none: the page keeps its answer.
      const loads = (i: number) => allow(i) && okKeys.has(keyOf(i));
      const proven = () => (everyOne.some((i) => !lost[i] && !swapping[i] && !shunned[i] && loads(i)) ? marked(view(own, loads)) : null);
      if (siteRefusing) return proven();
      // Review r2: only a place that has loaded nothing of the site is ever swapped here (a suspect, or
      // a refuser of this page). A session that loads the site is never benched for one refused page.
      const unproven = (i: number) => {
        const k = keyOf(i);
        return !lost[i] && !shunned[i] && !swapping[i] && !okKeys.has(k) && (refusers.has(k) || suspect(k));
      };
      // Bounded without counting waits or swaps the host did not make: each swap made gives its place
      // a new session (which `allow` accepts), and each one not made leaves its place shunned or proven
      // (no longer `unproven`), so at most one swap per place, and a wait ends with its swap.
      // Every wait ends by `until` (the page then keeps its refusal: staging 5b4986ad).
      for (let made = 0; made <= all.length;) {
        if (siteRefusing) return proven();
        if (ready()) return marked(view(own, allow));
        const pending = swapping.filter((p): p is Promise<void> => !!p);
        if (pending.length) {
          if (!(await anyBefore(pending, until))) break;
          continue;
        }
        // Every session refused this page (or refuses everything so far): a fresh one, if the host allows it.
        if (!egress?.swap) break;
        const target = everyOne.find(unproven);
        if (target === undefined) break;
        const k = keyOf(target);
        tell(target, k);
        // Still refused and still loading nothing when its drain ends (else no swap: the retry finds it).
        if (!(await anyBefore([startSwap(target, () => !okKeys.has(k) && (refusals.get(k)?.size ?? 0) > 0)], until))) break;
        if (keyOf(target) !== k) made++;
      }
      // After the last wait or swap, once more: a session the retry may use.
      if (siteRefusing) return proven();
      return ready() ? marked(view(own, allow)) : null;
    },
  };
}
