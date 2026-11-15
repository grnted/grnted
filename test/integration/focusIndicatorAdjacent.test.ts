// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18 precision (lead's ruling after the round-2 blind grade): the 1.4.11 focus-indicator test compared a ring with
// the pixels it covered, as if those were the colours next to it. Two cases broke that assumption on real templates:
// - a skip link that is off-screen or hidden until focused: the covered pixels are the header behind it, not its own
//   unfocused look, and the link appearing (a box of its own colours) is the change a person sees;
// - a ring that touches the element's own fill: 1.4.11 asks for contrast with the adjacent colours, and the fill is one.
// Where the test cannot prove the indicator insufficient, the ring is not measured (never failed). Look-alikes that
// still fail: a pale ring set off from the element (it touches only the page), and a pale ring around a pale button.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { keyboardProbe } from '../../src/probes/keyboard/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (css: string, before: string, body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Town services</title>
<style>*{box-sizing:border-box} body{font:16px/1.5 Arial,sans-serif;margin:0;color:#222;background:#fff}
header{background:#1d3557;color:#fff;padding:16px} header a{color:#fff} main{max-width:60rem;margin:0 auto;padding:16px}
a{color:#0b4f8a} :focus-visible{outline:3px solid #1a1a1a;outline-offset:2px} header :focus-visible{outline-color:#fff} ${css}</style></head>
<body>${before}<header><a href="/">Town of Alder</a> <a href="/services">Services</a></header><main><h1>Town services</h1><p>Find permits, parks and library hours.</p>${body}</main></body></html>`;

async function status(html: string): Promise<string> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [keyboardProbe], { userAgent: 'grnted-test', full: true });
    const f = run!.findings.filter((x) => x.criterion === '1.4.11');
    return f.some((x) => x.status === 'failed') ? 'failed' : f.some((x) => x.status === 'not_testable') ? 'not_testable' : 'no_failures_found';
  } finally {
    await sim.close();
  }
}

describe('1.4.11 focus indicators: measured against the colours next to them', () => {
  it('a skip link that appears on focus is never failed on its ring, whatever its ring colour', async () => {
    const skip = (hide: string, ring: string) => page(`.skip{position:absolute;left:8px;background:#fff;color:#1d3557;padding:8px 12px;${hide}} .skip:focus,.skip:focus-visible{${ring}}`,
      '<a class="skip" href="#main">Skip to main content</a>', '<p><a href="/permits">Apply for a permit</a></p>');
    for (const [hide, ring] of [
      ['top:-80px', 'top:8px;outline:2px solid #1d3557;outline-offset:2px'],
      ['top:8px;clip-path:inset(50%);width:1px;height:1px;overflow:hidden;white-space:nowrap', 'clip-path:none;width:auto;height:auto;outline:2px solid #24406a'],
      ['top:8px;transform:translateY(-200%)', 'transform:none;box-shadow:0 0 0 3px #2a4a74;outline:none'],
    ] as const) expect(await status(skip(hide, ring)), hide).not.toBe('failed');
  }, 180_000);

  it('a pale ring touching a dark button is not failed; set off from it, or around a pale button, it fails', async () => {
    const btn = (fill: string, text: string, ring: string) => page(`.cta{display:inline-block;background:${fill};color:${text};padding:10px 16px;text-decoration:none;border-radius:4px} .cta:focus-visible{${ring}}`,
      '', '<p><a class="cta" href="/pay">Pay property taxes online</a></p>');
    expect(await status(btn('#1d3557', '#fff', 'outline:2px solid #c0c0c0;outline-offset:0'))).not.toBe('failed');
    expect(await status(btn('#1d3557', '#fff', 'outline:none;box-shadow:0 0 0 3px #cbd5e1'))).not.toBe('failed');
    expect(await status(btn('#1d3557', '#fff', 'outline:2px solid #d0d0d0;outline-offset:5px'))).toBe('failed');
    expect(await status(btn('#f2f2f2', '#222', 'outline:2px solid #dcdcdc;outline-offset:0'))).toBe('failed');
  }, 240_000);
});
