// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D0 and D1 (docs/atlas/visual.md): text contrast in the dark colour scheme a page defines.
// The visitor's system set to dark selects it (`prefers-color-scheme: dark`, `light-dark()`, a `color-scheme` that
// offers dark with the browser's own canvas colour). The text-contrast test switches only a page whose style sheets
// define one, judges it with axe's colour-contrast rule (its exemptions included) and the screenshot measurement, and
// names the presentation. Look-alikes keep passing: a dark scheme with enough contrast, a page with no dark scheme,
// a dark section in a light page, and the logo and disabled exemptions in the dark scheme.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import { presentationInventory } from '../../src/probes/presentations.js';
import { defaultAxeSource } from '../../src/scan.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
let axeSource: string;
beforeAll(async () => {
  browser = await chromium.launch();
  axeSource = await defaultAxeSource();
}, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (head: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Library hours</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } .card { padding: 16px; border: 1px solid #888; margin: 12px 0; }</style>${head}</head>
<body><main><h1>Library hours</h1>${body}</main></body></html>`;

async function run(html: string, probe = textContrastProbe): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [probe], { userAgent: 'grnted-test', full: true, axeSource });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D1: text contrast in the dark colour scheme', () => {
  it('fails faint text in a prefers-color-scheme dark rule, naming the scheme', async () => {
    const r = await run(page('<style>@media (prefers-color-scheme: dark) { body { background: #1e1e1e; color: #e8e8e8; } .card { background: #222; } .meta { color: #555; } }</style>',
      '<div class="card"><p>Open daily from 9 a.m.</p><p class="meta" id="meta">Holiday hours are posted a week ahead.</p></div>'));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#meta']);
    expect(failed(r)[0]!.detail).toMatch(/dark colour scheme/);
  }, 60_000);

  it('fails text whose light-dark() token is too faint in dark, and text the page left to the browser’s dark canvas', async () => {
    const r1 = await run(page('<style>:root { color-scheme: light dark; --note: light-dark(#333333, #474747); } body { background: light-dark(#ffffff, #121212); color: light-dark(#1b1b1b, #eeeeee); } .note { color: var(--note); }</style>',
      '<p class="note" id="note">Returns are due by closing time.</p>'));
    expect(failed(r1).map((f) => f.target), JSON.stringify(r1.findings)).toEqual(['#note']);
    const r2 = await run(page('<meta name="color-scheme" content="light dark"><style>body { background: Canvas; } p.hint { color: #333; }</style>',
      '<p class="hint" id="hint">Ask at the front desk for a guest pass.</p>'));
    expect(failed(r2).map((f) => f.target), JSON.stringify(r2.findings)).toContain('#hint');
  }, 90_000);

  it('look-alikes pass: a dark scheme with enough contrast, no dark scheme, a dark section in a light page, a logo and a disabled button in dark', async () => {
    const ok = await run(page('<style>@media (prefers-color-scheme: dark) { body { background: #121212; color: #e6e6e6; } .card { background: #1d1d1d; } .meta { color: #b0b0b0; } }</style>',
      '<div class="card"><p class="meta">Holiday hours are posted a week ahead.</p></div>'));
    expect(failed(ok), JSON.stringify(ok.findings)).toEqual([]);
    const none = await run(page('', '<div class="card" style="background:#10283f;color:#fff"><p>Open daily from 9 a.m.</p></div>'));
    expect(failed(none), JSON.stringify(none.findings)).toEqual([]);
    const exempt = await run(page('<style>@media (prefers-color-scheme: dark) { body { background: #121212; color: #e6e6e6; } .site-logo { color: #2a2a2a; } button { color: #333; background: #222; } }</style>',
      '<a class="site-logo" href="/">River City Library</a><p>Open daily.</p><button type="button" disabled>Renew (sign in first)</button>'));
    expect(failed(exempt), JSON.stringify(exempt.findings)).toEqual([]);
  }, 120_000);
});

const TOGGLE = `<script>
  const KEY = 'site-theme';
  const apply = (t) => { document.documentElement.setAttribute('data-theme', t); const b = document.getElementById('theme'); if (b) b.setAttribute('aria-pressed', String(t === 'dark')); };
  apply(localStorage.getItem(KEY) || 'light');
  addEventListener('DOMContentLoaded', () => document.getElementById('theme').addEventListener('click', () => {
    const t = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    localStorage.setItem(KEY, t); apply(t);
  }));
</script>`;

describe('D2: a theme a control switches', () => {
  it('fails faint text in the theme the switch selects, and puts the page back as it was', async () => {
    const r = await run(page(`<style>html[data-theme="dark"] body { background: #1c1c1c; color: #eee; } html[data-theme="dark"] .card { background: #262626; } html[data-theme="dark"] .meta { color: #5a5a5a; }</style>${TOGGLE}`,
      '<button id="theme" type="button" aria-pressed="false">Dark mode</button><div class="card"><p>Open daily.</p><p class="meta" id="meta">Holiday hours are posted a week ahead.</p></div>'));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#meta']);
    expect(failed(r)[0]!.detail).toMatch(/colour theme that "Dark mode" switches to/);
  }, 60_000);

  it('fails faint text in the theme a select picks (and sets the select back)', async () => {
    const r = await run(page('<style>html.dark body { background: #121212; color: #eee; } html.dark .muted { color: #3a3a3a; }</style><script>addEventListener("DOMContentLoaded", () => document.getElementById("t").addEventListener("change", (e) => document.documentElement.classList.toggle("dark", e.target.value === "dark")));</script>',
      '<label for="t">Theme</label> <select id="t"><option value="light">Light</option><option value="dark">Dark</option></select><p class="muted" id="muted">Holiday hours are posted one week ahead.</p><p>Open daily.</p>'));
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#muted']);
  }, 60_000);

  it('look-alikes pass: a theme that keeps contrast, a "dark" button that only restyles one widget, and a page with no theme rules', async () => {
    const ok = await run(page(`<style>html[data-theme="dark"] body { background: #1c1c1c; color: #eee; } html[data-theme="dark"] .meta { color: #bdbdbd; }</style>${TOGGLE}`,
      '<button id="theme" type="button">Dark mode</button><p class="meta">Holiday hours are posted a week ahead.</p><p>Open daily.</p>'));
    expect(failed(ok), JSON.stringify(ok.findings)).toEqual([]);
    const widget = await run(page(`<style>.map.night { background: #111; color: #444; }</style><script>addEventListener('DOMContentLoaded', () => document.getElementById('n').addEventListener('click', () => document.querySelector('.map').classList.toggle('night')));</script>`,
      '<button id="n" type="button">Night map</button><div class="map"><p>Branch locations</p></div><p>Open daily.</p><p>Closed on holidays.</p>'));
    expect(failed(widget), JSON.stringify(widget.findings)).toEqual([]);
  }, 90_000);
});

describe('D1: non-text contrast in the dark colour scheme', () => {
  it('fails a field border that is faint only in the dark scheme; keeps one that holds', async () => {
    const r = await run(page('<style>input { border: 2px solid #767676; background: #fff; color: #111; padding: 6px; } @media (prefers-color-scheme: dark) { body { background: #1b1b1b; color: #eee; } input { background: #1b1b1b; color: #eee; border-color: #333333; } }</style>',
      '<label for="card">Library card number</label> <input id="card" name="card">'), nonTextContrastProbe);
    expect(r.findings.filter((f) => f.status === 'failed').map((f) => f.target), JSON.stringify(r.findings)).toEqual(['#card']);
    expect(r.findings.find((f) => f.status === 'failed')!.detail).toMatch(/dark colour scheme/);
    const ok = await run(page('<style>input { border: 2px solid #767676; background: #fff; color: #111; padding: 6px; } @media (prefers-color-scheme: dark) { body { background: #1b1b1b; color: #eee; } input { background: #1b1b1b; color: #eee; border-color: #9a9a9a; } }</style>',
      '<label for="card">Library card number</label> <input id="card" name="card">'), nonTextContrastProbe);
    expect(ok.findings.filter((f) => f.status === 'failed'), JSON.stringify(ok.findings)).toEqual([]);
  }, 90_000);
});

describe('D0: the presentation inventory', () => {
  it('finds a dark scheme, root themes, forced-colour rules and breakpoints, and nothing on a plain page', async () => {
    const sim = await startSimServer({ files: { '/': page(`<style>
      @media (prefers-color-scheme: dark) { body { background: #000; } }
      html[data-theme="dark"] .card { background: #222; color: #eee; }
      @media (forced-colors: active) { .icon { forced-color-adjust: none; color: #fff; } }
      @media (max-width: 767px) { .card { padding: 8px; } }
      @media (min-width: 64em) { .card { padding: 24px; } }
    </style>`, '<div class="card">x</div>'), '/plain': page('', '<p>x</p>') } });
    const p = await browser.newPage();
    try {
      await p.goto(`${sim.origin}/`);
      const inv = await p.evaluate(presentationInventory, 20_000);
      expect(inv.dark).toEqual(['prefers-color-scheme: dark']);
      expect(inv.rootThemes).toEqual(['html[data-theme="dark"] .card']);
      expect(inv.forced).toEqual({ rules: 1, keep: 1 });
      expect(inv.breakpoints).toEqual([767, 1024]);
      await p.goto(`${sim.origin}/plain`);
      const plain = await p.evaluate(presentationInventory, 20_000);
      expect(plain).toMatchObject({ dark: [], rootThemes: [], forced: { rules: 0, keep: 0 }, breakpoints: [] });
    } finally {
      await p.close();
      await sim.close();
    }
  }, 60_000);
});
