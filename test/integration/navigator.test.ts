// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The AI navigator's targets in real Chromium (src/probes/plan.ts): widgets the tests' own heuristics miss
// (test/fixtures/navigator/), each with a look-alike that must stay clean. The navigator here is a fixed
// stand-in that picks elements from the page summary by rule (no model is called), so the run is the
// runner's plumbing and the tests' own judging, end to end.
import { createServer, type IncomingMessage } from 'node:http';
import { chromium, type Browser, type BrowserContext } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCriterionStatus, worstStatus } from '../../src/probes/criteria.js';
import { formsProbe } from '../../src/probes/forms.js';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import type { NavElement, NavigatorHook, PlanEvent, RawPlan } from '../../src/probes/plan.js';
import { pointerGesturesProbe } from '../../src/probes/pointerGestures.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
/** Every request the fixture server got (method and path). */
const requests: string[] = [];

beforeAll(async () => {
  server = await startFixtureServer('navigator', {}, { onRequest: (req: IncomingMessage) => requests.push(`${req.method} ${req.url}`) });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const cls = (e: NavElement, c: string) => (e.attrs.class ?? '').split(' ').includes(c);
/**
 * What a navigator would pick on the fixtures: one rule per widget. The menu, card and promo rules are kinds
 * the tests no longer take (menus and controls for the keyboard test): code drops them, and nothing changes.
 */
const RULES: { kind: string; match: (e: NavElement) => boolean; submit?: (e: NavElement) => boolean }[] = [
  { kind: 'menu-trigger', match: (e) => cls(e, 'menu-toggle') },
  { kind: 'custom-control', match: (e) => cls(e, 'card') || cls(e, 'promo') },
  { kind: 'carousel', match: (e) => cls(e, 'carousel') },
  { kind: 'form', match: (e) => cls(e, 'contact-form'), submit: (e) => cls(e, 'send') },
];

function standIn(events: PlanEvent[], calls: { n: number }): NavigatorHook {
  return {
    maxTargets: 8,
    budgetMs: 20_000,
    onPlan: (e) => events.push(e),
    async plan(input): Promise<RawPlan> {
      calls.n++;
      const targets: RawPlan['targets'] = [];
      for (const rule of RULES) {
        for (const el of input.summary.elements.filter(rule.match)) {
          const submit = rule.submit ? input.summary.elements.find(rule.submit)?.ref ?? null : null;
          targets.push({ ref: el.ref, kind: rule.kind, submit });
        }
      }
      return { targets, model: 'stand-in', key: 'k', cached: false };
    },
  };
}

const PROBES = [keyboardProbe, hoverContentProbe, pointerGesturesProbe, formsProbe];

async function run(page: string, navigator?: NavigatorHook): Promise<ProbeRun[]> {
  return runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${page}.html`, index: 0 }], PROBES, {
    userAgent: 'grnted-test', full: true, concurrency: 4, ...(navigator ? { navigator } : {}),
  });
}

/**
 * The page's result for a criterion, as the engine rolls the runs up (`runCriterionStatus`, `worstStatus`): 'failed',
 * 'clean', 'not_applicable' or 'not_testable'. (A test that says "not applicable" beside one that checked and found
 * nothing leaves the criterion clean: since the keyboard-op lane the gestures test says 2.1.1 is not applicable where it
 * reordered no list, beside the keyboard test's clean 2.1.1.)
 */
function verdict(runs: readonly ProbeRun[], criterion: string): string {
  const statuses = runs.map((r) => runCriterionStatus(r, criterion)).filter((s): s is NonNullable<typeof s> => !!s);
  const s = statuses.length ? worstStatus(statuses) : 'no_failures_found';
  return s === 'no_failures_found' ? 'clean' : s;
}

const CASES: { page: string; criterion: string; before: string; after: string }[] = [
  { page: 'carousel-swipe', criterion: '2.5.1', before: 'not_testable', after: 'failed' },
  { page: 'carousel-buttons', criterion: '2.5.1', before: 'not_testable', after: 'clean' },
  { page: 'form-inline-bad', criterion: '3.3.1', before: 'not_applicable', after: 'failed' },
  { page: 'form-inline-ok', criterion: '3.3.1', before: 'not_applicable', after: 'clean' },
  // Fields with Search and Send: the planned Send is pressed (colour-only errors), never Search.
  { page: 'form-two-buttons', criterion: '3.3.1', before: 'not_applicable', after: 'failed' },
  // A wizard (Next, Search, Send): after the steps, still the planned Send (Grok r2), never Next or Search.
  { page: 'form-wizard', criterion: '3.3.1', before: 'not_applicable', after: 'failed' },
  // Kinds the tests no longer take (a menu div, cards): nothing changes, whatever the plan names.
  { page: 'menu-div', criterion: '2.1.1', before: 'clean', after: 'clean' },
  { page: 'menu-button', criterion: '2.1.1', before: 'clean', after: 'clean' },
  { page: 'select-native', criterion: '2.1.1', before: 'clean', after: 'clean' },
  { page: 'decoy-ticker', criterion: '2.1.1', before: 'clean', after: 'clean' },
];

describe('planned targets (real browser, stand-in navigator)', () => {
  it.each(CASES)('$page: $criterion goes from $before to $after, and nothing else changes', async (c) => {
    const events: PlanEvent[] = [];
    const calls = { n: 0 };
    const [without, withPlan] = await Promise.all([run(c.page), run(c.page, standIn(events, calls))]);
    expect(verdict(without, c.criterion)).toBe(c.before);
    expect(verdict(withPlan, c.criterion)).toBe(c.after);
    // Every other result stands; one the tests could not give before may now be answered (never a new
    // failure on a look-alike).
    const others = [...new Set(PROBES.flatMap((p) => p.criteria))].filter((x) => x !== c.criterion);
    for (const o of others) {
      const was = verdict(without, o);
      const now = verdict(withPlan, o);
      const answered = c.after === 'failed' ? [was, 'clean', 'failed'] : [was, 'clean'];
      const allowed = was === 'clean' || was === 'failed' ? [was] : was === 'not_applicable' ? [...answered, 'not_testable'] : answered;
      expect({ o, was, now, ok: allowed.includes(now) }).toEqual({ o, was, now, ok: true });
    }
    // A remark that no form was there to test never stays once a planned form was tested.
    if (c.page.startsWith('form-inline')) {
      const remarks = withPlan.filter((r) => r.probe === 'forms').flatMap((r) => r.findings.map((f) => `${f.criterion} ${f.detail}`));
      expect(remarks.filter((x) => /only search forms and fields outside forms/.test(x))).toEqual([]);
    }
    // One plan per page, asked once.
    expect(calls.n).toBe(1);
    expect(events.map((e) => e.outcome)).toEqual(['planned']);
  }, 120_000);
});

describe('planned targets never act on the site', () => {
  it('a planned form is sent with the network shut: nothing but page loads reaches the server', async () => {
    requests.length = 0;
    await run('form-inline-ok', standIn([], { n: 0 }));
    expect(requests.filter((r) => !/^GET \/(form-inline-ok\.html|favicon\.ico)/.test(r))).toEqual([]);
  }, 120_000);
});

describe('navigator bounds', () => {
  it('runs the tests on their own targets when the plan does not come within the budget', async () => {
    const events: PlanEvent[] = [];
    const slow: NavigatorHook = {
      maxTargets: 8, budgetMs: 1500, onPlan: (e) => events.push(e),
      plan: (_input, signal) => new Promise((resolve) => { signal.addEventListener('abort', () => resolve(null), { once: true }); }),
    };
    const t0 = Date.now();
    const runs = await run('form-inline-bad', slow);
    expect(verdict(runs, '3.3.1')).toBe('not_applicable');
    expect(events.map((e) => e.outcome)).toEqual(['late']);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('closes the capture\'s browser context when the budget ends during a load that hangs', async () => {
    const hang = createServer(() => { /* never answers */ });
    await new Promise<void>((r) => hang.listen(0, '127.0.0.1', () => r()));
    const port = (hang.address() as { port: number }).port;
    const closed: number[] = [];
    let first: BrowserContext | undefined;
    const t0 = Date.now();
    const counting = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const c = await browser.newContext(o);
        if (!first) { first = c; c.on('close', () => closed.push(Date.now() - t0)); }
        return c;
      },
    } as unknown as BrowserLike;
    const nav: NavigatorHook = { maxTargets: 8, budgetMs: 1500, plan: async () => null };
    try {
      await runProbes(counting, [{ url: `http://127.0.0.1:${port}/`, index: 0 }], [formsProbe], { userAgent: 'grnted-test', full: true, loadTimeoutMs: 20_000, navigator: nav });
    } finally {
      hang.closeAllConnections?.();
      hang.close();
    }
    // The capture's context (the first one) closed soon after the 1.5 s budget, not at the 20 s load time-out.
    expect(closed.length).toBe(1);
    expect(closed[0]!).toBeLessThan(6000);
  }, 120_000);

  it('runs the tests on their own targets when the navigator fails', async () => {
    const events: PlanEvent[] = [];
    const broken: NavigatorHook = { maxTargets: 8, budgetMs: 20_000, onPlan: (e) => events.push(e), plan: async () => { throw new Error('rate limited'); } };
    const runs = await run('carousel-swipe', broken);
    expect(verdict(runs, '2.5.1')).toBe('not_testable');
    expect(events.map((e) => e.outcome)).toEqual(['failed']);
  }, 120_000);
});
