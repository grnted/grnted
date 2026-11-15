// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.3 for placeholder text, in real Chromium. A placeholder is text ("placeholder text ... is still text",
// Understanding 1.4.3; G18): shown in an empty field it needs 4.5:1 (3:1 when large) against the field. axe's
// color-contrast rule does not look at it, so faint placeholders passed. Decided from the page's own colours,
// and only where they leave no doubt: the placeholder shows, its colour is solid, and the field has an opaque
// background colour of its own with no picture. Look-alikes that must keep passing: enough contrast, large
// text at 3:1, a disabled field (inactive, exempt), a placeholder the page makes invisible on purpose (a
// floating label), a field that has a value, and a field over a picture (not decided here).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { textContrastProbe } from '../../src/probes/textContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, fields: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Report a pothole</title>
<style>body { font: 16px/1.5 sans-serif; margin: 32px; background: #fff; color: #1b1b1b; } label { display: block; margin-top: 16px; } input, textarea { font: inherit; padding: 8px; border: 1px solid #555; background: #fff; color: #1b1b1b; width: 320px; } ${css}</style></head>
<body><main><h1>Report a pothole</h1><form action="/report" method="post">${fields}</form></main></body></html>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    // No text left undecided by axe: only the placeholders are this page's business.
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0, incomplete: [] }], [textContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('text contrast (1.4.3): placeholder text', () => {
  it('fails a faint placeholder in an empty field (#b5b5b5 on white, 2.1:1), also one faded with opacity', async () => {
    const r = await run(page('#street::placeholder { color: #b5b5b5; opacity: 1; } #town::placeholder { color: #1b1b1b; opacity: .3; }',
      '<label for="street">Street</label><input id="street" name="street" placeholder="For example Mill Lane"><label for="town">Town</label><input id="town" name="town" placeholder="Town or village">'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([
      expect.objectContaining({ target: '#street', detail: 'Placeholder text contrast is 2.0:1 (text #b5b5b5 on #ffffff); 16 px text needs at least 4.5:1: “For example Mill Lane”' }),
      expect.objectContaining({ target: '#town', detail: expect.stringMatching(/^Placeholder text contrast is 1\.\d:1 \(text #[0-9a-f]{6} on #ffffff\); 16 px text needs at least 4\.5:1: “Town or village”$/) }),
    ]);
  }, 60_000);

  it('fails a placeholder that is faint only against the field\'s own grey background', async () => {
    const r = await run(page('#note { background: #e4e4e4; } #note::placeholder { color: #808080; opacity: 1; }', '<label for="note">What did you see?</label><textarea id="note" name="note" placeholder="Depth, size, which lane"></textarea>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([expect.objectContaining({ target: '#note', detail: expect.stringContaining('(text #808080 on #e4e4e4)') })]);
  }, 60_000);

  it('look-alikes pass: enough contrast, large text at 3:1, a disabled field, a placeholder made invisible on purpose, a field with a value', async () => {
    const r = await run(page(`#a::placeholder { color: #595959; opacity: 1; }
#b { font-size: 26px; } #b::placeholder { color: #8a8a8a; opacity: 1; }
#c::placeholder { color: #b5b5b5; opacity: 1; }
#d::placeholder { color: transparent; }
#e::placeholder { color: #b5b5b5; opacity: 1; }`,
      `<label for="a">Street</label><input id="a" name="a" placeholder="For example Mill Lane">
<label for="b">Town</label><input id="b" name="b" placeholder="Town or village">
<label for="c">Reference</label><input id="c" name="c" placeholder="Filled in by the office" disabled>
<label for="d">Email</label><input id="d" name="d" type="email" placeholder="you@example.org">
<label for="e">Phone</label><input id="e" name="e" type="tel" placeholder="01632 960000" value="01632 960123">`));
    expect(r.findings, JSON.stringify(r.findings)).toEqual([expect.objectContaining({ status: 'no_failures_found' })]);
  }, 60_000);

  it('look-alike: a faint placeholder in a see-through field over a picture is not decided from colours (no failure here)', async () => {
    const r = await run(page('.hero { background: linear-gradient(#123, #abc); padding: 24px; } #q { background: transparent; } #q::placeholder { color: #b5b5b5; opacity: 1; }',
      '<div class="hero"><label for="q" style="color:#fff">Search the site</label><input id="q" name="q" type="search" placeholder="Search"></div>'));
    expect(failed(r), JSON.stringify(r.findings)).toEqual([]);
  }, 60_000);
});
