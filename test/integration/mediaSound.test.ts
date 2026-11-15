// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media rules on videos with and without a sound track (2026-11-09 benchmark review), in real Chromium:
// a video-only file needs no captions (1.2.2) and plays no sound (1.4.2); a video hidden when scanned, or labelled
// as the same information as the page's text (WCAG 1.2.2's media alternative for text), is listed, not failed; a
// media fragment's length is the time it plays. Look-alikes with a sound track still fail.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike, MediaItem, PageLike, SiteReport } from '../../src/types.js';
import { mediaCollector } from '../../src/collect/media.js';
import { mediaIssues } from '../../src/media/index.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const silent = { type: 'video/webm', file: 'clip.webm' };
const sound = { type: 'video/webm', file: 'clip-tone.webm' };
const ROUTES = {
  '/room-tour.webm': silent, '/banner-loop.webm': silent,
  '/story-time.webm': sound, '/hours.webm': sound, '/archive.webm': sound, '/welcome.webm': sound, '/welcome-long.webm': sound,
};

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let report: SiteReport;

beforeAll(async () => {
  server = await startFixtureServer('media', ROUTES);
  browser = await chromium.launch();
  report = await scanSite(`${server.origin}/sound.html`, { browser: browser as unknown as BrowserLike, maxPages: 1 });
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const items = (): Record<string, MediaItem> => Object.fromEntries(report.media!.map((m) => [new URL(m.url).pathname, m]));
const rules = (m: MediaItem) => m.issues.map((i) => `${i.level} ${i.criterion} ${i.rule}`);

it('R10: capture failure, missing metadata and unsupported capture leave captions uncertain; known video-only stays exempt', async () => {
  const page = await browser.newPage();
  try {
    await page.route('https://cdn.example/silent.webm', (r) => r.fulfill({ path: 'test/fixtures/media/clip.webm', contentType: 'video/webm' }));
    await page.setContent('<video controls src="https://cdn.example/silent.webm"></video>');
    await page.waitForFunction(() => document.querySelector('video')!.readyState >= 1);
    const issues = (audio: MediaItem['audio']) => mediaIssues({ kind: 'video', content: 'video', url: 'https://cdn.example/silent.webm', foundOn: [], captions: 'none', controls: true, audio });
    const read = async () => (await mediaCollector.collect(page as unknown as PageLike, { url: page.url(), viewport: 'desktop' })).elements[0]!;
    // The same video-only file, when the browser can expose its tracks.
    await page.evaluate(() => {
      const stream = document.createElement('canvas').captureStream();
      Object.defineProperty(document.querySelector('video'), 'captureStream', { configurable: true, value: () => stream });
    });
    expect(issues((await read()).audio)).toEqual([expect.objectContaining({ criterion: '1.2.1', level: 'review' })]);
    for (const mode of ['throws', 'unsupported', 'metadata'] as const) {
      await page.evaluate((m) => {
        const v = document.querySelector('video')!;
        Object.defineProperty(v, 'captureStream', { configurable: true, value: m === 'unsupported' ? undefined : () => { throw new DOMException('capture unavailable'); } });
        if (m === 'metadata') Object.defineProperty(v, 'readyState', { configurable: true, value: 0 });
      }, mode);
      expect(issues((await read()).audio), mode).toEqual([expect.objectContaining({ criterion: '1.2.2', level: 'review' })]);
    }
  } finally { await page.close(); }
});

describe('videos with and without sound (media rules)', () => {
  it('reads which files have no sound track, which video is hidden, and how long a fragment plays', () => {
    const m = items();
    expect(m['/room-tour.webm']).toMatchObject({ audio: 'none' });
    expect(m['/banner-loop.webm']).toMatchObject({ audio: 'none' });
    expect(m['/story-time.webm']!.audio).toBe('present');
    expect(m['/archive.webm']).toMatchObject({ hidden: true });
    expect(m['/hours.webm']).toMatchObject({ alternativeForText: true });
    expect(m['/story-time.webm']!.alternativeForText).toBeUndefined();
    expect(m['/welcome.webm']!.duration).toBe(2);
    expect(m['/welcome-long.webm']!.duration).toBe(11);
  });

  it('1.2.2: no captions problem for a video without sound, or one hidden or labelled as the text again; a possible problem, never a definite one, for one with sound and no track', () => {
    const m = items();
    expect(rules(m['/room-tour.webm']!)).toEqual(['review 1.2.1 silent-video']);
    // Review round 2, finding 3: its captions may be part of the picture, which the rules cannot see.
    expect(rules(m['/story-time.webm']!)).toEqual(['review 1.2.2 no-captions-track']);
    expect(rules(m['/hours.webm']!)).toEqual(['review 1.2.2 no-captions-track']);
    expect(rules(m['/archive.webm']!)).toEqual(['review 1.2.2 no-captions-track']);
  });

  it('1.4.2: no autoplay flag for 2 s of sound or a soundless file; 11 s requires verification', () => {
    const m = items();
    expect(m['/welcome.webm']!.captions).toBe('track');
    expect(rules(m['/welcome.webm']!).filter((r) => r.includes('1.4.2'))).toEqual([]);
    expect(rules(m['/banner-loop.webm']!).filter((r) => r.includes('1.4.2'))).toEqual([]);
    expect(rules(m['/welcome-long.webm']!).filter((r) => r.includes('1.4.2'))).toEqual(['review 1.4.2 autoplay-sound-no-controls']);
  });

  it('the criteria: 1.2.2 undecided for the video with sound and no captions track (review round 2, finding 3), never failed by the rules; 1.4.2 failed for the 11 s fragment only', () => {
    const c = Object.fromEntries(report.criteria!.map((x) => [x.criterion, x]));
    expect(c['1.2.2']!.status).toBe('not_testable');
    expect(c['1.2.2']!.evidence?.filter((e) => /^Problem/.test(e.detail ?? ''))).toEqual([]);
    expect(c['1.2.2']!.evidence?.filter((e) => /^Possible problem: This video has no captions track\. Unless its captions are part of the picture/.test(e.detail ?? '')).map((e) => new URL(e.target!).pathname)).toEqual(['/story-time.webm']);
    expect(c['1.4.2']!.status).toBe('failed');
  });
});
