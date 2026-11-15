// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.10 Reflow and 1.4.12 Text Spacing inside the page's own embedded frames, in real Chromium.
// A page that fits at 320 px can hold a frame (a document viewer, a form) from the same site whose own
// content does not: ordinary prose in a fixed 760 px sheet needs scrolling in two directions inside the
// frame (1.4.10; a frame is no exception for the prose in it), and a fixed-height notice in the frame
// loses text with the WCAG spacing (1.4.12, F104). The tests looked at the top document only.
// Look-alikes that must keep passing: a frame whose content fits, and a frame whose wide content is a data
// table in its own scrolling region (the two-dimensional exception).
// Review r1, finding 12: a frame inside such a frame is looked into too; a page whose only content is a frame
// is still measured; and frames from this site that are not looked into (more than the limit) leave the page
// not testable, never clean.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reflowProbe } from '../../src/probes/reflow.js';
import { runProbes } from '../../src/probes/runner.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const outer = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Allotment rules</title>
<style>body { font: 16px/1.5 sans-serif; margin: 16px; } iframe { width: 100%; height: 420px; border: 1px solid #555; }</style></head>
<body><main><h1>Allotment rules</h1><p>The rules for plot holders are in the document below.</p>
<iframe id="rules" src="/embed.html" title="Rules for plot holders"></iframe>
<p>Ask at the site hut for a printed copy.</p></main></body></html>`;
const inner = (css: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rules for plot holders</title>
<style>body { font: 16px/1.5 sans-serif; margin: 12px; } ${css}</style></head><body>${body}</body></html>`;
const PROSE = '<p>Keep paths clear and compost only plant waste. Water butts are filled on Mondays, and hoses are for the shared troughs only.</p><p>Bonfires are allowed in November on still days. Please tell the site steward before you light one.</p>';

async function run(probe: PageProbe, frame: string, extra: Record<string, string> = {}): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': outer, '/embed.html': frame, ...extra } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('reflow (1.4.10): inside the page\'s own frames', () => {
  it('fails prose in a fixed 760 px sheet inside a same-site frame', async () => {
    const r = await run(reflowProbe, inner('.sheet { width: 760px; }', `<div class="sheet" id="sheet">${PROSE}</div>`));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      target: '#rules >>> #sheet', detail: expect.stringMatching(/^Inside the embedded frame “Rules for plot holders”: At 320 px wide, a 760 px wide container does not fit and its text needs scrolling sideways/),
    })]);
  }, 60_000);

  it('look-alikes pass: a frame whose prose fits, and a frame whose wide content is a data table in its own scrolling region', async () => {
    const fits = await run(reflowProbe, inner('', PROSE));
    expect(fits.findings, JSON.stringify(fits.findings)).toEqual([]);
    const table = await run(reflowProbe, inner('.scroll { overflow-x: auto; } table { border-collapse: collapse; min-width: 700px; } td, th { border: 1px solid #555; padding: 6px 14px; white-space: nowrap; }',
      `${PROSE}<div class="scroll" tabindex="0" role="region" aria-label="Plot fees"><table><caption>Plot fees</caption><tr><th scope="col">Plot size</th><th scope="col">Yearly rent</th><th scope="col">Water charge</th><th scope="col">Key deposit</th><th scope="col">Concession</th></tr><tr><td>Half plot</td><td>£38</td><td>£12</td><td>£10</td><td>£19</td></tr><tr><td>Full plot</td><td>£70</td><td>£20</td><td>£10</td><td>£35</td></tr></table></div>`));
    expect(table.findings, JSON.stringify(table.findings)).toEqual([]);
  }, 90_000);
});

describe('text spacing (1.4.12): inside the page\'s own frames', () => {
  it('fails a fixed-height notice inside a same-site frame that cuts its text off with the WCAG spacing', async () => {
    const r = await run(textSpacingProbe, inner('.note { width: 300px; height: 56px; overflow: hidden; border: 1px solid #555; padding: 4px 8px; } .note p { margin: 0; }',
      '<div class="note" id="note"><p>Collect your gate key from the site hut before the last Saturday of the month.</p></div>' + PROSE));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([expect.objectContaining({
      target: expect.stringMatching(/^#rules >>> #note/), detail: expect.stringMatching(/^Inside the embedded frame “Rules for plot holders”: With the WCAG text spacing applied .* text is cut off by its container/),
    })]);
  }, 60_000);

  it('look-alike: the same notice with room for the spacing passes', async () => {
    const r = await run(textSpacingProbe, inner('.note { width: 300px; min-height: 56px; border: 1px solid #555; padding: 4px 8px; } .note p { margin: 0; }',
      '<div class="note" id="note"><p>Collect your gate key from the site hut before the last Saturday of the month.</p></div>' + PROSE));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);
});

describe('layout tests: frames inside frames, frame-only pages and frames beyond the limit', () => {
  const SHEET = inner('.sheet { width: 760px; }', `<div class="sheet" id="sheet">${PROSE}</div>`);
  const holder = inner('iframe { width: 100%; height: 320px; border: 0; }', '<iframe id="inner" src="/deep.html" title="Rules, page two"></iframe>');

  it('reflow: finds prose that does not fit in a frame inside a same-site frame', async () => {
    const r = await run(reflowProbe, holder, { '/deep.html': SHEET });
    expect(failed(r), JSON.stringify(r.findings)).toEqual([expect.objectContaining({ target: '#rules >>> #inner >>> #sheet', detail: expect.stringContaining('Inside the embedded frame “Rules, page two”: At 320 px wide') })]);
  }, 60_000);

  it('text spacing: finds cut-off text in a frame inside a same-site frame', async () => {
    const note = inner('.note { width: 300px; height: 56px; overflow: hidden; border: 1px solid #555; padding: 4px 8px; } .note p { margin: 0; }',
      '<div class="note" id="note"><p>Collect your gate key from the site hut before the last Saturday of the month.</p></div>' + PROSE);
    const r = await run(textSpacingProbe, holder, { '/deep.html': note });
    expect(failed(r).map((f) => f.target), JSON.stringify(r.findings)).toEqual([expect.stringMatching(/^#rules >>> #inner >>> #note/)]);
  }, 60_000);

  it('a page whose only content is a frame is still measured: never "no visible text on the page"', async () => {
    const only = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Rules</title><style>body { margin: 0; } iframe { width: 100%; height: 600px; border: 0; }</style></head><body><iframe id="rules" src="/embed.html" title="Rules for plot holders"></iframe></body></html>`;
    const sim = await startSimServer({ files: { '/': only, '/embed.html': SHEET } });
    try {
      const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [reflowProbe, textSpacingProbe], { userAgent: 'grnted-test', full: true });
      const reflow = runs.find((r) => r.probe === 'reflow')!;
      expect(failed(reflow), JSON.stringify(reflow.findings)).toEqual([expect.objectContaining({ target: '#rules >>> #sheet' })]);
      const spacing = runs.find((r) => r.probe === 'text-spacing')!;
      expect(spacing.findings, JSON.stringify(spacing.findings)).toEqual([]);
    } finally {
      await sim.close();
    }
  }, 60_000);

  it('more same-site frames than the test looks inside leave the page not testable; six are all looked into', async () => {
    const many = (n: number) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Allotment rules</title><style>iframe { width: 100%; height: 160px; border: 1px solid #555; }</style></head>
<body><main><h1>Allotment rules</h1>${Array.from({ length: n }, (_, i) => `<iframe id="f${i + 1}" src="/embed.html" title="Rules, part ${i + 1}"></iframe>`).join('')}</main></body></html>`;
    const scan = async (n: number) => {
      const sim = await startSimServer({ files: { '/': many(n), '/embed.html': inner('', PROSE) } });
      try {
        const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [reflowProbe], { userAgent: 'grnted-test', full: true });
        return r!;
      } finally {
        await sim.close();
      }
    };
    const over = await scan(8);
    expect(over.findings, JSON.stringify(over.findings)).toEqual([expect.objectContaining({ criterion: '1.4.10', status: 'not_testable', detail: expect.stringContaining('the page has 2 more frames from this site than the test looks inside (6)') })]);
    const within = await scan(6);
    expect(within.findings, JSON.stringify(within.findings)).toEqual([]);
  }, 120_000);
});
