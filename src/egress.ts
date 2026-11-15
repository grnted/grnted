// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A site that refuses some of the scan's browser sessions and not others (staging 2026-11-04,
// perrydaleschool.com: HTTP 406 to some Browser Rendering egress addresses, 200 to others; within one
// session all or nothing, and stable). Two pieces live here: the status of a page load the browser
// threw on (Chromium ends a load whose answer was an error with no body with
// net::ERR_HTTP_RESPONSE_CODE_FAILURE, and Playwright then hands back no response), and what one load
// says about the session it ran in. The session pool (src/sessions.ts) uses both to retry a refused
// page in another session and to replace a session the site refuses. Engine core: no Node-only imports.
import { isRefusalStatus, isWafChallenge } from './challenge.js';
import type { GuardFrameLike, PageLike, SubresourceResponseLike } from './types.js';

/** Retries of a page the site refused, each in a session that has not refused it. */
export const REFUSED_RETRIES = 2;

/** What one load's final answer says about the session it ran in. */
export type LoadOutcome = 'ok' | 'refused' | 'other';

/** Chromium's error for a load whose answer was an HTTP error with no body (the response is not handed back). */
const CODE_FAILURE = /ERR_HTTP_RESPONSE_CODE_FAILURE/;

/** A load error that is the browser refusing to show an HTTP error answer: its status is the answer. */
export const isResponseCodeFailure = (message: string): boolean => CODE_FAILURE.test(message);

/**
 * For a load through the pace controller (src/pace.ts `PaceLoadOptions.failedStatus`): the status of a
 * load the browser threw on for an HTTP error with no body, from the page's navigation tracker.
 */
export const thrownStatus = (nav: NavigationStatus | undefined) => (err: unknown): number | undefined =>
  err instanceof Error && isResponseCodeFailure(err.message) ? nav?.status() : undefined;

const lower = (h: Record<string, string>) => Object.fromEntries(Object.entries(h).map(([k, v]) => [k.toLowerCase(), v]));

/**
 * A load's final answer as the session pool reads it: `refused` for a challenge (202, or a known WAF's
 * challenge headers) or a 4xx that is not "not there" (404, 410) or a time-out (408), the set
 * apps/worker/src/loadFailure.ts calls a refusal; `ok` for any other answer under 400; `other` else.
 */
export function loadOutcome(status: number | undefined, headers?: Record<string, string>): LoadOutcome {
  if (status === undefined) return 'other';
  if (isRefusalStatus(status)) return 'refused';
  if (status < 400) {
    let challenge = false;
    try {
      challenge = !!headers && isWafChallenge(lower(headers));
    } catch {
      challenge = false;
    }
    return challenge ? 'refused' : 'ok';
  }
  return 'other';
}

/** The status of the page's last main-frame document answer since `reset` (redirect hops replaced by the next). */
export interface NavigationStatus {
  reset(): void;
  status(): number | undefined;
}

/**
 * Listens to the page's answers for main-frame documents (each redirect hop, then the document), so a
 * load the browser threw on still has its status. Without `page.on` it knows nothing (never throws).
 */
export function trackNavigation(page: PageLike): NavigationStatus {
  let last: number | undefined;
  try {
    page.on?.('response', (r: SubresourceResponseLike) => {
      try {
        if (r.request().resourceType() !== 'document') return;
        const frame = r.frame?.() as GuardFrameLike | undefined;
        // A frame's document is not the page's (a frame with no parent is the main frame).
        if (frame && typeof frame.parentFrame === 'function' && frame.parentFrame() !== null) return;
        last = r.status();
      } catch {
        // an answer that cannot be read says nothing
      }
    });
  } catch {
    // no events: nothing is known
  }
  return {
    reset() {
      last = undefined;
    },
    status: () => last,
  };
}

const tracked = new WeakMap<object, NavigationStatus>();

/** The page's one navigation tracker (installed on first use; callers reset it before each load). */
export function navigationOf(page: PageLike): NavigationStatus {
  let t = tracked.get(page);
  if (!t) tracked.set(page, (t = trackNavigation(page)));
  return t;
}
