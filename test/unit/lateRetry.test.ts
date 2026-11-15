// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The late retry's two small pieces: which pages it tries again (only those the site turned away), and
// the politeness controller's one more try for a host it gave up on (then as it was).
import { describe, expect, it } from 'vitest';
import { BOT_CHALLENGE, CHALLENGE_PAGE } from '../../src/challenge.js';
import { createPace } from '../../src/pace.js';
import { BROWSER_LOST_PAGE } from '../../src/reconnect.js';
import { isLateRetryPage } from '../../src/scan.js';
import { SESSION_WAIT_PAGE } from '../../src/sessions.js';
import type { PageAudit } from '../../src/types.js';

const failed = (reason: string, httpStatus?: number): PageAudit => ({
  url: 'https://example.org/p', status: 'failed', reason, ...(httpStatus ? { httpStatus } : {}), rules: {}, violations: [], incomplete: [], links: [],
});

describe('isLateRetryPage', () => {
  it('the site turning the scan away: 406, 429 (also after the controller gave up), a challenge, and a wait for a session the refusals took', () => {
    expect(isLateRetryPage(failed('HTTP 406', 406))).toBe(true);
    expect(isLateRetryPage(failed('The site asked us to slow down (HTTP 429) and kept refusing', 429))).toBe(true);
    expect(isLateRetryPage(failed(CHALLENGE_PAGE, 202))).toBe(true);
    expect(isLateRetryPage(failed(BOT_CHALLENGE, 200))).toBe(true);
    expect(isLateRetryPage(failed(SESSION_WAIT_PAGE))).toBe(true);
  });

  it('never a page’s own answer, a broken page, a lost browser, a time-out or a page that loaded', () => {
    for (const s of [401, 403, 404, 410, 500, 503]) expect(isLateRetryPage(failed(`HTTP ${s}`, s))).toBe(false);
    expect(isLateRetryPage(failed(BROWSER_LOST_PAGE))).toBe(false);
    expect(isLateRetryPage(failed('page.goto: Timeout 45000ms exceeded.'))).toBe(false);
    expect(isLateRetryPage({ ...failed('x'), status: 'ok' })).toBe(false);
  });
});

describe('a late-retry load: one more try for a host the controller gave up on', () => {
  /** A fake clock: each wait advances it at once. */
  const fakeClock = () => {
    let t = 1_000_000;
    return { now: () => t, sleep: async (ms: number) => { t += ms; }, random: () => 1 };
  };

  it('goes out once, with no retry, while every other load still sees the give-up', async () => {
    const p = createPace({ concurrency: 4, ...fakeClock() });
    let calls = 0;
    const refuse = async () => { calls++; return { status: 429 }; };
    for (let i = 0; i < 4; i++) await p.load(`https://example.org/p${i}`, refuse, (a) => a);
    const before = calls;
    // Given up: no request goes out.
    await p.load('https://example.org/x', refuse, (a) => a);
    expect(calls).toBe(before);
    const r = await p.load('https://example.org/x', refuse, (a) => a, { retries: 0, again: true });
    expect(calls).toBe(before + 1);
    expect(r.status).toBe(429);
    await p.load('https://example.org/y', refuse, (a) => a);
    expect(calls).toBe(before + 1);
  });

  it('a host that loads on it is no longer given up on', async () => {
    const p = createPace({ concurrency: 4, ...fakeClock() });
    let status = 429;
    let calls = 0;
    const load = async () => { calls++; return { status }; };
    for (let i = 0; i < 4; i++) await p.load(`https://example.org/p${i}`, load, (a) => a);
    status = 200;
    expect((await p.load('https://example.org/x', load, (a) => a, { retries: 0, again: true })).value?.status).toBe(200);
    const before = calls;
    expect((await p.load('https://example.org/y', load, (a) => a)).value?.status).toBe(200);
    expect(calls).toBe(before + 1);
  });
});
