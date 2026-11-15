// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 4.1.2, failure F59: an element the page's own script makes a control (a click handler and a pointer cursor)
// with no role, so assistive technology is told nothing but its text. In real Chromium, through the probe
// runner (the listener hook records the handlers). Fixtures: test/fixtures/roleless/ (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { namesProbe } from '../../src/probes/names.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const findings: Record<string, ProbeFinding[]> = {};

beforeAll(async () => {
  site = await startFixtureServer('roleless');
  browser = await chromium.launch();
  const runs = await runProbes(browser as unknown as BrowserLike, ['controls.html', 'clean.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [namesProbe], { userAgent: 'grnted-test', concurrency: 2 });
  for (const r of runs) findings[new URL(r.page).pathname.slice(1)] = r.findings;
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe('4.1.2 F59: a control made of a plain element with no role', () => {
  it('fails a div, span, cell or anchor without href that answers clicks and shows a pointer cursor', () => {
    const f = findings['controls.html']!.filter((x) => x.status === 'failed');
    // Six on the page: five are listed, the last one counts the sixth.
    const all = ['#by-attribute', '#by-listener', '#close', '#day', '#focusable', '#no-href'];
    expect(f).toHaveLength(5);
    expect(f.every((x) => x.criterion === '4.1.2' && all.includes(x.target!))).toBe(true);
    expect(new Set(f.map((x) => x.target)).size).toBe(5);
    expect(f[4]!.detail).toMatch(/\(1 more like this on this page\)$/);
    expect(f.find((x) => x.target === '#by-listener')!.detail).toMatch(/^The div “Check availability” works as a control .* but has no role/);
  });

  it('look-alikes stay clean: real buttons and links, elements given a role, a card with its own link, a listener with no pointer cursor, labels, hidden elements, a long passage', () => {
    expect(findings['clean.html']!.filter((x) => x.status === 'failed')).toEqual([]);
  });
});
