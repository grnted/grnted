// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Several browser sessions for one scan (src/sessions.ts): which session each context opens in, by
// role and by load; a lost session's work moving to another; the navigation gate kept per session.
import { describe, expect, it } from 'vitest';
import { gatedBrowser } from '../../src/navigationGate.js';
import { GATE_UNARMED } from '../../src/navigationGate.js';
import { BROWSER_EXHAUSTED } from '../../src/reconnect.js';
import { sessionPool } from '../../src/sessions.js';
import type { BrowserLike, ContextLike } from '../../src/types.js';

const VP = { viewport: { width: 1280, height: 900 } };

/**
 * A fake session: counts the contexts it opened and has open. `lose()` makes every later call fail the
 * way a reconnecting browser with no reopen left does; `fail(n, message)` fails the next n calls with
 * `message` (a reopen cycle that did not work, a hold that cannot arm).
 */
function fake(name: string) {
  let open = 0;
  let opened = 0;
  let calls = 0;
  let lost = false;
  const failing: string[] = [];
  const browser: BrowserLike = {
    async newContext() {
      calls++;
      if (lost) throw new Error(`Target page, context or browser has been closed (${BROWSER_EXHAUSTED})`);
      const f = failing.shift();
      if (f) throw new Error(f);
      open++;
      opened++;
      const ctx: ContextLike = {
        newPage: async () => { throw new Error('not used'); },
        close: async () => { open--; },
      };
      return Object.assign(ctx, { session: name });
    },
  };
  return {
    browser, open: () => open, opened: () => opened, calls: () => calls,
    lose: () => { lost = true; },
    fail: (n: number, message: string) => { for (let i = 0; i < n; i++) failing.push(message); },
  };
}

const sessionOf = (c: ContextLike) => (c as ContextLike & { session: string }).session;

describe('sessionPool', () => {
  it('with one session, every role is that very browser (nothing changes)', () => {
    const a = fake('a');
    const pool = sessionPool([a.browser]);
    expect(pool.size).toBe(1);
    expect(pool.audit).toBe(a.browser);
    expect(pool.probe).toBe(a.browser);
    pool.pagesDone();
    expect(pool.audit).toBe(a.browser);
  });

  it('with two, the core tests keep to the last session while pages are audited; the audits use both, least busy first', async () => {
    const a = fake('a');
    const b = fake('b');
    const pool = sessionPool([a.browser, b.browser]);
    const probes = await Promise.all(Array.from({ length: 3 }, () => pool.probe.newContext(VP)));
    expect(probes.map(sessionOf)).toEqual(['b', 'b', 'b']);
    // b has the tests' 3 open: the audits fill a first, then share (ties: the first session).
    const audits = [];
    for (let i = 0; i < 6; i++) audits.push(sessionOf(await pool.audit.newContext(VP)));
    expect(audits).toEqual(['a', 'a', 'a', 'a', 'b', 'a']);
    // However busy b gets, the tests never take a while pages are audited.
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('b');
  });

  it('once every page is audited, the core tests (and the evidence pass) use every session, least busy first', async () => {
    const a = fake('a');
    const b = fake('b');
    const pool = sessionPool([a.browser, b.browser]);
    const held = await Promise.all(Array.from({ length: 3 }, () => pool.probe.newContext(VP)));
    pool.pagesDone();
    // b has 3 open: the next three go to a, then they alternate (ties: the first session).
    const next = [];
    for (let i = 0; i < 5; i++) next.push(sessionOf(await pool.probe.newContext(VP)));
    expect(next).toEqual(['a', 'a', 'a', 'a', 'b']);
    expect(sessionOf(await pool.audit.newContext(VP))).toBe('a');
    expect(held.map(sessionOf)).toEqual(['b', 'b', 'b']);
  });

  it('with three, page audits spread over all three by load, the core tests keep the third', async () => {
    const [a, b, c] = [fake('a'), fake('b'), fake('c')];
    const pool = sessionPool([a.browser, b.browser, c.browser]);
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('c');
    const audits = [];
    for (let i = 0; i < 5; i++) audits.push(await pool.audit.newContext(VP));
    expect(audits.map(sessionOf)).toEqual(['a', 'b', 'a', 'b', 'c']);
    // A closed context frees its place: the next one goes where there is room.
    await audits[0]!.close();
    expect(sessionOf(await pool.audit.newContext(VP))).toBe('a');
    expect(a.open()).toBe(2);
    expect(c.opened()).toBe(2);
  });

  it('uses all eight supplied sessions, keeping the eighth for core tests until every page is audited', async () => {
    const sessions = Array.from({ length: 8 }, (_, i) => fake(`s${i}`));
    const pool = sessionPool(sessions.map((s) => s.browser));
    expect(pool.size).toBe(8);
    const probe = await pool.probe.newContext(VP);
    expect(sessionOf(probe)).toBe('s7');
    const audits: ContextLike[] = [];
    try {
      for (let i = 0; i < 8; i++) audits.push(await pool.audit.newContext(VP));
      expect(audits.map(sessionOf)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's0']);
      expect(sessions.map((s) => s.opened())).toEqual([2, 1, 1, 1, 1, 1, 1, 1]);
    } finally {
      await Promise.all([probe, ...audits].map((c) => c.close()));
    }
    pool.pagesDone();
    const probes: ContextLike[] = [];
    try {
      for (let i = 0; i < 8; i++) probes.push(await pool.probe.newContext(VP));
      expect(probes.map(sessionOf)).toEqual(['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']);
    } finally {
      await Promise.all(probes.map((c) => c.close()));
    }
    expect(sessions.map((s) => s.open())).toEqual(Array(8).fill(0));
  });

  it('caps supplied sessions at eight and never opens the ninth', async () => {
    const sessions = Array.from({ length: 9 }, (_, i) => fake(`s${i}`));
    const pool = sessionPool(sessions.map((s) => s.browser));
    expect(pool.size).toBe(8);
    const contexts: ContextLike[] = [];
    try {
      for (let i = 0; i < 16; i++) contexts.push(await pool.audit.newContext(VP));
      expect(contexts.map(sessionOf)).toEqual([...Array(2)].flatMap(() => ['s0', 's1', 's2', 's3', 's4', 's5', 's6', 's7']));
      expect(sessions[8]!.calls()).toBe(0);
    } finally {
      await Promise.all(contexts.map((c) => c.close()));
    }
  });

  it('a context closed twice frees its place once', async () => {
    const [a, b] = [fake('a'), fake('b')];
    const pool = sessionPool([a.browser, b.browser]);
    pool.pagesDone();
    const x = await pool.audit.newContext(VP);
    await x.close();
    await x.close();
    await pool.audit.newContext(VP);
    expect([a.opened(), b.opened()]).toEqual([2, 0]);
  });

  it('a session that is lost for good is left: its work opens in another session', async () => {
    const [a, b, c] = [fake('a'), fake('b'), fake('c')];
    const pool = sessionPool([a.browser, b.browser, c.browser]);
    a.lose();
    const got = [];
    for (let i = 0; i < 3; i++) got.push(sessionOf(await pool.audit.newContext(VP)));
    expect(got).toEqual(['b', 'c', 'b']);
    // The probes' own session lost too: they go to a session that is still there.
    c.lose();
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('b');
    expect(sessionOf(await pool.audit.newContext(VP))).toBe('b');
    // Every session lost: the error of a closed browser, so the work is counted lost (redone or reported).
    b.lose();
    await expect(pool.audit.newContext(VP)).rejects.toThrow(/closed/);
  });

  it('a closed-browser error from a session that can still reconnect is not the end of it: tried again once others were tried', async () => {
    const CYCLE = 'Target page, context or browser has been closed (no new browser: 429 too many sessions)';
    const [a, b] = [fake('a'), fake('b')];
    const pool = sessionPool([a.browser, b.browser]);
    // Both sessions' first replacement cycle fails (they died together): the next cycle works.
    a.fail(1, CYCLE);
    b.fail(1, CYCLE);
    expect(sessionOf(await pool.audit.newContext(VP))).toBe('a');
    expect([a.calls(), b.calls()]).toEqual([2, 1]);
    // Neither was given up: both still take work.
    expect(sessionOf(await pool.audit.newContext(VP))).toBe('b');
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('b');
  });

  it('calls already on their way when a session failed share its reopen cycle: they count as one failure, not three', async () => {
    const CYCLE = 'Target page, context or browser has been closed (no new browser: 429 too many sessions)';
    const [a, b] = [fake('a'), fake('b')];
    const pool = sessionPool([a.browser, b.browser]);
    b.fail(3, CYCLE);
    const got = await Promise.all(Array.from({ length: 3 }, () => pool.probe.newContext(VP)));
    expect(got.map(sessionOf)).toEqual(['a', 'a', 'a']);
    // b is not given up: its next reopen works.
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('b');
  });

  it('a session that keeps failing as closed without saying it is exhausted is left after 3 tries in a row (a plain browser that closed)', async () => {
    const [a, b] = [fake('a'), fake('b')];
    const pool = sessionPool([a.browser, b.browser]);
    a.fail(3, 'Target page, context or browser has been closed');
    for (let i = 0; i < 3; i++) await pool.audit.newContext(VP);
    expect(a.calls()).toBe(3);
    await pool.audit.newContext(VP);
    expect(a.calls()).toBe(3);
  });

  it('a session whose navigation gate cannot hold its windows is left at once, and its work opens in another', async () => {
    const [a, b] = [fake('a'), fake('b')];
    const pool = sessionPool([a.browser, b.browser]);
    b.fail(1, GATE_UNARMED);
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('a');
    expect(sessionOf(await pool.probe.newContext(VP))).toBe('a');
    expect(b.calls()).toBe(1);
    // No session can arm its gate: the error of lost work, so the scan redoes it or gives no score.
    a.fail(1, GATE_UNARMED);
    await expect(pool.audit.newContext(VP)).rejects.toThrow(/closed/);
  });

  it('an error that is not a lost browser is not retried elsewhere', async () => {
    const a = fake('a');
    const b: BrowserLike = { newContext: async () => { throw new Error('bad options'); } };
    const pool = sessionPool([b, a.browser]);
    await expect(pool.audit.newContext(VP)).rejects.toThrow('bad options');
    expect(a.opened()).toBe(0);
  });

  it('views over gated sessions count as gated (discovery does not gate them again, which would fail closed)', () => {
    const allow = async () => true;
    const gated = [gatedBrowser(fake('a').browser, allow), gatedBrowser(fake('b').browser, allow)];
    const pool = sessionPool(gated);
    expect(gatedBrowser(pool.audit, allow)).toBe(pool.audit);
    expect(gatedBrowser(pool.probe, allow)).toBe(pool.probe);
    // Over ungated sessions the views are not gated: gating them is the caller's to do per session.
    const plain = sessionPool([fake('c').browser, fake('d').browser]);
    expect(gatedBrowser(plain.audit, allow)).not.toBe(plain.audit);
  });
});
