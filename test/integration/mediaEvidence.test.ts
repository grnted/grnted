// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media evidence collector (batch 18, lane media, G1-G7, G9, G10) in real Chromium on
// test/fixtures/media/evidence/: every recording however it is embedded (an element with tracks, an audio player
// in a figure, a platform frame, a same-site player page in a frame, a preview, links, an object, a video in a web
// component's shadow root), its raw context (headings, caption, described-by text, a closed disclosure, a hidden
// panel, links), the feeds the page announces and the stream manifest it fetched. It reads only and judges nothing.
// Requests off the fixture server are refused (the YouTube frame loads nothing).
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_COLLECTORS } from '../../src/collect/index.js';
import { mediaEvidenceCollector, type MediaEvidence } from '../../src/collect/mediaEvidence.js';
import type { PageLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
let ev: MediaEvidence;

beforeAll(async () => {
  server = await startFixtureServer('media', {
    '/evidence/live.m3u8': { type: 'application/vnd.apple.mpegurl', file: 'evidence/live.m3u8' },
    '/evidence/podcast.xml': { type: 'application/rss+xml', file: 'evidence/podcast.xml' },
  });
  browser = await chromium.launch();
  const page: Page = await browser.newPage();
  await page.route('**/*', (r) => (r.request().url().startsWith(server.origin) ? r.continue() : r.abort()));
  const url = `${server.origin}/evidence/index.html`;
  await page.goto(url);
  // The elements' metadata (length, sound track) and the frame's page, as they are by the time a page is audited.
  await page.waitForFunction(() => (document.getElementById('v1') as HTMLVideoElement).readyState >= 1 && (document.getElementById('a1') as HTMLAudioElement).readyState >= 1);
  await page.waitForTimeout(300);
  ev = await mediaEvidenceCollector.collect(page as unknown as PageLike, { url, viewport: 'desktop' });
  await page.close();
}, 60_000);
afterAll(async () => { await browser?.close(); await server?.close(); });

const item = (pred: (i: MediaEvidence['items'][number]) => boolean) => ev.items.find(pred);

describe('the media evidence collector', () => {
  it('is not one of the collectors every scan runs: only an AI plan asks for it', () => {
    expect(DEFAULT_COLLECTORS.map((c) => c.id)).not.toContain('mediaEvidence');
  });

  it('records a native video with its track as the browser lists it, its length and its sound track', () => {
    const v = item((i) => i.technique === 'video' && i.target.includes('#v1'))!;
    expect(v).toMatchObject({ where: 'document', controls: true, sound: 'present', shown: true });
    expect(typeof v.duration).toBe('number');
    expect(v.tracks).toEqual([expect.objectContaining({ kind: 'captions', srclang: 'en', label: 'English', src: `${server.origin}/no-cues.vtt` })]);
    expect(v.context.heading).toBe('Welcome video');
    expect(v.context.headings).toEqual(['Media library', 'Welcome video']);
    expect(ev.sections[v.context.section!]!.text).toContain('The welcome message from the director.');
    expect(v.context.hidden).toEqual([{ how: 'hidden', text: 'Full text of the welcome message, in other words.' }]);
  });

  it('gives an audio player its caption, the text it is described by, the closed disclosure and the links beside it, as they are', () => {
    const a = item((i) => i.technique === 'audio' && i.target.includes('#a1'))!;
    expect(a.context.caption).toBe('Episode 12: the bond measure');
    expect(a.context.described).toBe('The board meets on November 19 at 6 pm in room 4.');
    expect(a.context.heading).toBe('Podcast');
    expect(a.context.after).toContain('What was said');
    expect(a.context.links).toEqual(expect.arrayContaining([
      expect.objectContaining({ text: 'Episode 12 notes (PDF)', file: 'document', sameSite: true }),
      expect.objectContaining({ text: 'Listen (WAV)', file: 'media', sameSite: true }),
    ]));
  });

  it('gives a recording in a CMS embed block the text of its own figure (a caption paragraph is not a figcaption)', () => {
    const own = item((i) => i.target.includes('#mov-0042'))!;
    expect(own.context.figure).toBe('MOV_0042.mp4');
    // The nearest heading above it is the block before's: the figure's own text tells them apart.
    expect(own.context.heading).toBe('Reporting an absence');
    expect(item((i) => i.target.includes('#absence'))!.context.figure).toBe('Reporting an absence It only takes a minute!');
  });

  it('names a platform frame by its address (a name only) and keeps its title; reads a same-site player page in a frame', () => {
    expect(item((i) => i.technique === 'frame' && i.platform === 'YouTube')).toMatchObject({ title: 'Fall open house tour', src: 'https://www.youtube.com/embed/abcdEFGhijk' });
    expect(item((i) => i.technique === 'frame' && i.src.endsWith('/evidence/player.html'))).toMatchObject({ title: 'Board meeting' });
    const inFrame = item((i) => i.where === 'frame')!;
    expect(inFrame).toMatchObject({ technique: 'video', frame: `${server.origin}/evidence/player.html`, controls: true });
    expect(inFrame.target).toMatch(/^iframe\[src=".*player\.html"\] >>> .*video$/);
    expect(inFrame.context.heading).toBe('Board meeting, November 12');
  });

  it('finds a video in a web component\'s shadow root, with how it is hidden from assistive technology', () => {
    expect(item((i) => i.where === 'shadow')).toMatchObject({ technique: 'video', autoplay: true, muted: true, loop: true, hiddenFromAt: 'aria-hidden', target: expect.stringContaining(' >>> ') });
  });

  it('records a click-to-load preview, links to a media file and to a platform\'s video page, and an object', () => {
    expect(item((i) => i.technique === 'preview')).toMatchObject({ src: 'https://www.youtube.com/embed/zYxWvUtSrQ0', platform: 'YouTube' });
    expect(item((i) => i.technique === 'link' && i.src.endsWith('/tone.wav'))).toMatchObject({ text: 'Listen (WAV)' });
    expect(item((i) => i.technique === 'link' && i.src.startsWith('https://youtu.be/'))).toMatchObject({ text: 'Watch the concert on YouTube', platform: 'YouTube' });
    expect(item((i) => i.technique === 'object')).toMatchObject({ src: `${server.origin}/tone.wav` });
  });

  it('lists the feeds the page announces and the stream manifest it fetched', () => {
    expect(ev.feeds).toEqual([{ href: `${server.origin}/evidence/podcast.xml`, type: 'application/rss+xml', title: 'District podcast' }]);
    expect(ev.resources).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'manifest', url: `${server.origin}/evidence/live.m3u8` })]));
    expect(ev.page).toEqual({ title: 'Media library', h1: 'Media library', lang: 'en' });
  });

  it('gives every item a ref unique on the page', () => {
    expect(new Set(ev.items.map((i) => i.ref)).size).toBe(ev.items.length);
  });
});
