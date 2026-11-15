// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A muted, looping video without controls that the author hides from assistive technology on the video
// itself is a background video: decoration (no 1.2.1 review). A video hidden only through an ancestor (an
// inactive carousel slide, a closed panel) or one that does not loop is not proof of decoration: it keeps
// the review (review round 1 of fix/deny-guard).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaCollector } from '../../src/collect/media.js';
import { mediaIssues } from '../../src/media/index.js';
import type { PageLike } from '../../src/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

async function decorative(body: string): Promise<(true | undefined)[]> {
  const page = await browser.newPage();
  try {
    await page.setContent(`<!doctype html><html lang="en"><head><title>T</title></head><body>${body}</body></html>`);
    const facts = await mediaCollector.collect(page as unknown as PageLike, { url: 'https://e.org/', viewport: 'desktop' });
    return facts.elements.map((e) => e.decorative);
  } finally {
    await page.close();
  }
}

describe('decorative background video', () => {
  it('aria-hidden (or role presentation) on a muted, looping video without controls: decoration', async () => {
    expect(await decorative('<video src="https://e.org/bg.webm" muted loop autoplay playsinline aria-hidden="true"></video>')).toEqual([true]);
    expect(await decorative('<video src="https://e.org/bg.webm" muted loop role="presentation"></video>')).toEqual([true]);
  });

  it('hidden only through an ancestor (an inactive carousel slide), or a muted video that does not loop: not proof of decoration', async () => {
    expect(await decorative('<div class="slide" aria-hidden="true"><video src="https://e.org/demo.webm" muted loop></video></div>')).toEqual([undefined]);
    expect(await decorative('<video src="https://e.org/demo.webm" muted aria-hidden="true"></video>')).toEqual([undefined]);
    expect(await decorative('<video src="https://e.org/demo.webm" muted loop controls aria-hidden="true"></video>')).toEqual([undefined]);
  });

  it('the rules: only a decorative one skips the review', () => {
    const base = { kind: 'video' as const, content: 'video' as const, url: 'https://e.org/v.webm', foundOn: ['https://e.org/'], captions: 'none' as const, muted: true, controls: false, loop: true };
    expect(mediaIssues({ ...base, decorative: true }).map((i) => i.rule)).toEqual([]);
    expect(mediaIssues(base)).toEqual([expect.objectContaining({ criterion: '1.2.2', level: 'review', rule: 'no-captions-track' })]);
    expect(mediaIssues({ ...base, audio: 'none' }).map((i) => i.rule)).toEqual(['silent-video']);
    expect(mediaIssues({ ...base, audio: 'present' }).map((i) => i.rule)).toEqual(['silent-video']);
  });
});
