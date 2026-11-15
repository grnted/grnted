// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 hover, focus and placeholder checks: what they find and cannot measure is never a clean result
// (review r1 of fix/redteam-visual, finding 9), in real Chromium.
// - A style sheet served from another site, which the page's scripts may not read, is read another way (fetched
//   again when the other site allows it, else through the browser's own session), so a faint hover colour in it
//   is still found. Before, such a sheet was skipped without a word.
// - Without a browser session to hold the pointer on an element, hover states are a gap, not a pass.
// - A placeholder over a picture is a gap; a placeholder in a see-through field over a plain colour is measured.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { gapsText, stateContrast } from '../../src/probes/stateContrast.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, PageLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const doc = (head: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tide tables</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } a { color: #14506b; }</style>${head}</head>
<body><main><h1>Tide tables</h1><p>High water times for the harbour bar.</p>${body}</main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed').map((f) => f.target);

describe('hover and focus styles in a style sheet from another site', () => {
  const LINK = '<p><a id="tides" href="/tides">This week’s tides</a></p>';
  it('finds a faint hover colour in a sheet the page’s scripts may not read (no permission from the other site)', async () => {
    const other = await startSimServer({ files: { '/theme.css': '#tides:hover { color: #b9c6cc; }' } });
    try {
      const r = await run(doc(`<link rel="stylesheet" href="${other.origin}/theme.css">`, LINK));
      expect(failed(r), JSON.stringify(r.findings)).toEqual(['#tides']);
    } finally {
      await other.close();
    }
  }, 90_000);

  it('finds it in a sheet the other site lets be fetched, and in a sheet that sheet imports', async () => {
    const other = await startSimServer({ files: {}, routes: {
      '/theme.css': { body: '@import "more.css"; a { text-decoration-thickness: 2px; }', type: 'text/css', headers: { 'access-control-allow-origin': '*' } },
      '/more.css': { body: '#tides:focus { color: #b9c6cc; }', type: 'text/css', headers: { 'access-control-allow-origin': '*' } },
    } });
    try {
      const r = await run(doc(`<link rel="stylesheet" href="${other.origin}/theme.css">`, LINK));
      expect(failed(r), JSON.stringify(r.findings)).toEqual(['#tides']);
    } finally {
      await other.close();
    }
  }, 90_000);

  it('look-alike: a sheet from another site with no hover or focus rule leaves the page clean', async () => {
    const other = await startSimServer({ files: { '/theme.css': 'h1 { letter-spacing: 0.01em; }' } });
    try {
      const r = await run(doc(`<link rel="stylesheet" href="${other.origin}/theme.css">`, LINK));
      expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ status: 'no_failures_found' })]);
    } finally {
      await other.close();
    }
  }, 90_000);
});

describe('what cannot be measured is a gap, never clean', () => {
  it('hover states without a browser session to hold the pointer: a gap; focus states are still read', async () => {
    const sim = await startSimServer({ files: { '/': doc('<style>#a:hover { color: #b9c6cc; } #b:focus { color: #b9c6cc; }</style>', '<p><a id="a" href="/a">Spring tides</a> <a id="b" href="/b">Neap tides</a></p>') } });
    const page = await browser.newPage();
    try {
      await page.goto(`${sim.origin}/`);
      const out = await stateContrast({ page: page as unknown as PageLike });
      expect(out.findings.map((f) => f.target)).toEqual(['#b']);
      expect(gapsText(out.gaps)).toContain('the browser could not hold the pointer on an element for the test');
    } finally {
      await page.close();
      await sim.close();
    }
  }, 60_000);

  it('a link that changes colour on hover over a picture is not testable; the same link over a plain colour is decided', async () => {
    const PIC = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22%23234%22/%3E%3C/svg%3E')";
    const over = (bg: string) => doc(`<style>.band { padding: 16px; background: ${bg}; } .band a { color: #fff; } .band a:hover { color: #7d8f99; }</style>`, '<div class="band"><a id="go" href="/go">Harbour webcam</a></div>');
    const pic = await run(over(`#223344 ${PIC}`));
    expect(pic.findings, JSON.stringify(pic.findings)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('text changes its look on hover or focus where it sits on a picture') })]);
    const plain = await run(over('#223344'));
    expect(failed(plain), JSON.stringify(plain.findings)).toEqual(['#go']);
  }, 90_000);

  it('placeholder text: over a picture it is not testable; in a see-through field over a plain colour it is measured', async () => {
    const PIC = "url('data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2220%22 height=%2220%22%3E%3Crect width=%2220%22 height=%2220%22 fill=%22%23eee%22/%3E%3C/svg%3E')";
    const field = (bandBg: string) => doc(`<style>.band { padding: 16px; background: ${bandBg}; } input { font: inherit; padding: 8px; background: transparent; border: 1px solid #555; } input::placeholder { color: #c4c4c4; opacity: 1; }</style>`,
      '<div class="band"><label for="port">Port</label> <input id="port" name="port" placeholder="Start typing a port"></div>');
    const pic = await run(field(`#fff ${PIC}`));
    expect(pic.findings, JSON.stringify(pic.findings)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('placeholder text where it sits on a picture') })]);
    const plain = await run(field('#fff'));
    expect(plain.findings.filter((f) => f.status === 'failed'), JSON.stringify(plain.findings)).toEqual([expect.objectContaining({ target: '#port', detail: expect.stringMatching(/^Placeholder text contrast is 1\.\d:1 \(text #c4c4c4 on #ffffff\)/) })]);
  }, 90_000);
});
