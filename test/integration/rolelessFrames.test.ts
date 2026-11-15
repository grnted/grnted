// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 4.1.2, failure F59, inside the page's own embedded frames (batch 17, structure lane): a calendar in a frame from
// the site is part of the page, and a day there that the frame's script makes a control (a click handler and a
// pointer cursor) with no role tells assistive technology nothing but its text. The names test looked at the page's
// own document only. Real Chromium, through the probe runner (the listener hook runs in every frame).
// Fixtures: test/fixtures/roleless/in-frame*.html and frame-*.html (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { frameExposure } from '../../src/probes/ariaStates.js';
import { namesProbe } from '../../src/probes/names.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike, FrameLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const findings: Record<string, ProbeFinding[]> = {};

beforeAll(async () => {
  site = await startFixtureServer('roleless');
  browser = await chromium.launch();
  const runs = await runProbes(browser as unknown as BrowserLike, ['in-frame.html', 'in-frame-clean.html', 'controls.html', 'in-frame-sandbox.html', 'in-frame-sandbox-shown.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [namesProbe], { userAgent: 'grnted-test', concurrency: 2 });
  for (const r of runs) findings[new URL(r.page).pathname.slice(1)] = r.findings.filter((f) => f.criterion === '4.1.2');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe('4.1.2 F59: a control with no role inside a frame from the page\'s own site', () => {
  it('fails the days of a calendar in a same-site frame, named through the frame', () => {
    const f = findings['in-frame.html']!.filter((x) => x.status === 'failed');
    expect(f.map((x) => x.target)).toEqual(['#calendar-frame >>> #d4', '#calendar-frame >>> #d9', '#calendar-frame >>> #d14']);
    expect(f[0]!.detail).toMatch(/^Inside the embedded frame “Event calendar”: The div “4” works as a control .* but has no role/);
    expect(findings['in-frame.html']!.filter((x) => x.status === 'not_testable')).toEqual([]);
  });

  it('look-alikes stay clean: real buttons and a div with a role in the frame; a frame too small to use; a frame not shown; frames kept from assistive technology (aria-hidden, inert) or from the pointer', () => {
    expect(findings['in-frame-clean.html']).toEqual([]);
  });

  // Sol review of batch 17, S7: whether a frame is offered is read in the documents around it, not asked of the frame.
  it('Sol S7 look-alikes: sandboxed frames (no window.frameElement inside) kept from assistive technology or the pointer around them stay clean; the same sandboxed calendar offered to everyone still fails', () => {
    expect(findings['in-frame-sandbox.html']).toEqual([]);
    const f = findings['in-frame-sandbox-shown.html']!.filter((x) => x.status === 'failed');
    expect(f.map((x) => x.target)).toEqual(['#calendar-frame >>> #d4', '#calendar-frame >>> #d9', '#calendar-frame >>> #d14']);
  });

  it('Sol S7: where the documents around a frame cannot be read, whether it is offered is not known (frameExposure)', async () => {
    const frame = (o: { parent?: FrameLike | null; element?: () => Promise<unknown>; answer?: unknown }): FrameLike => ({
      url: () => 'https://s.example/f', parentFrame: () => o.parent ?? null, frameElement: o.element ?? (async () => ({})),
      evaluate: (async () => o.answer) as FrameLike['evaluate'],
    });
    const top = (answer: unknown) => frame({ answer });
    expect(await frameExposure(frame({ parent: top(true) }), () => 200)).toBe(true);
    expect(await frameExposure(frame({ parent: top(false) }), () => 200)).toBe(false);
    // The parent's answer is unknown (null), the element cannot be reached, the parent never answers: not known.
    expect(await frameExposure(frame({ parent: top(null) }), () => 200)).toBeUndefined();
    expect(await frameExposure(frame({ parent: top(true), element: async () => { throw new Error('gone'); } }), () => 200)).toBeUndefined();
    const silent = frame({});
    silent.evaluate = (() => new Promise(() => {})) as FrameLike['evaluate'];
    expect(await frameExposure(frame({ parent: silent }), () => 100)).toBeUndefined();
    // A frame inside a frame: hidden around the outer one is hidden.
    expect(await frameExposure(frame({ parent: frame({ parent: top(false), answer: true }) }), () => 200)).toBe(false);
  });

  it('the page\'s own document is read as before', () => {
    expect(findings['controls.html']!.filter((x) => x.status === 'failed')).toHaveLength(5);
    expect(findings['controls.html']!.every((x) => !x.target?.includes(' >>> '))).toBe(true);
  });
});
