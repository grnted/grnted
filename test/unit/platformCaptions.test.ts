// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plan C14: the caption tracks YouTube and Vimeo list for a site's videos. Fake fetch only: no real
// platform is ever called, and the key in these tests is not a real one.
import { describe, expect, it } from 'vitest';
import type { MediaFacts } from '../../src/collect/media.js';
import { scoreReportV8 } from '../../src/criterionScore.js';
import { classifyVideoLink } from '../../src/media/detect.js';
import { buildMediaInventory, mediaIssues, mediaItems } from '../../src/media/index.js';
import {
  cachedCaptions, platformCaptions, PLATFORM_CAPTION_LIMITS, PLATFORM_CAPTION_TTL, vimeoStatus, youtubeStatus,
  type CaptionCache, type PlatformVideo,
} from '../../src/media/platformCaptions.js';
import type { MediaItem, PageAudit, PlatformCaptions, SiteReport } from '../../src/types.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const KEY = 'test-key-not-real';
const yt = (videoId: string): PlatformVideo => ({ player: 'youtube', videoId });
const tracks = (...kinds: [string, string][]) => Response.json({ items: kinds.map(([trackKind, language]) => ({ snippet: { trackKind, language } })) });
const googleError = (status: number, reason: string) => Response.json({ error: { code: status, errors: [{ reason }] } }, { status });
const noSleep = async () => {};
const page = (url: string, facts: Partial<MediaFacts>): PageAudit => ({
  url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [],
  collected: { media: { elements: [], frames: [], links: [], ...facts } },
});
const memoryCache = () => {
  const m = new Map<string, { value: unknown; ttl: number }>();
  const cache: CaptionCache = {
    async get(k) { return m.get(k)?.value; },
    async put(k, value, ttl) { m.set(k, { value, ttl }); },
  };
  return { cache, m };
};

describe('reading the platform answer', () => {
  it('YouTube: a track made by a person is captions; only automatic is auto-only; none or forced only is none', () => {
    expect(youtubeStatus({ items: [{ snippet: { trackKind: 'asr', language: 'en' } }, { snippet: { trackKind: 'standard', language: 'es' } }] })).toEqual({ status: 'captions', languages: ['es'] });
    expect(youtubeStatus({ items: [{ snippet: { trackKind: 'standard', language: 'en' } }, { snippet: { trackKind: 'forced', language: 'en' } }] })).toEqual({ status: 'captions', languages: ['en'] });
    expect(youtubeStatus({ items: [{ snippet: { trackKind: 'ASR', language: 'en' } }] })).toEqual({ status: 'auto-only', languages: ['en'] });
    expect(youtubeStatus({ items: [] })).toEqual({ status: 'none' });
    expect(youtubeStatus({ items: [{ snippet: { trackKind: 'forced', language: 'fr' } }] })).toEqual({ status: 'none' });
    for (const bad of [null, 'x', {}, { items: 'no' }]) expect(youtubeStatus(bad)).toBeUndefined();
  });

  it('Vimeo: active captions or subtitles count; "-x-autogen" tracks are automatic; inactive and chapters do not', () => {
    expect(vimeoStatus({ data: [{ type: 'captions', language: 'en', active: true }] })).toEqual({ status: 'captions', languages: ['en'] });
    expect(vimeoStatus({ data: [{ type: 'subtitles', language: 'en-x-autogen', active: true }] })).toEqual({ status: 'auto-only', languages: ['en'] });
    expect(vimeoStatus({ data: [{ type: 'captions', language: 'en', active: false }, { type: 'chapters', language: 'en', active: true }] })).toEqual({ status: 'none' });
    expect(vimeoStatus({ nope: 1 })).toBeUndefined();
  });

  it('reads hostile answers in bounded, linear time and keeps at most 10 languages', () => {
    const items = Array.from({ length: 100_000 }, (_, i) => ({ snippet: { trackKind: 'standard', language: `l${i}`.repeat(50) } }));
    const t = performance.now();
    const s = youtubeStatus({ items })!;
    expect(performance.now() - t).toBeLessThan(500);
    expect(s.languages).toHaveLength(10);
    expect(s.languages!.every((l) => l.length <= 35)).toBe(true);
  });

  it('a cached value is used only when it is well formed', () => {
    expect(cachedCaptions({ status: 'none' })).toEqual({ status: 'none' });
    expect(cachedCaptions({ status: 'unchecked', reason: 'not-found' })).toEqual({ status: 'unchecked', reason: 'not-found' });
    for (const bad of [undefined, null, 'none', { status: 'maybe' }, { status: 'unchecked', reason: 'daily-limit' }]) expect(cachedCaptions(bad)).toBeUndefined();
  });
});

describe('asking YouTube (captions.list)', () => {
  it('asks once per video id, with only the id and the key, and maps every answer', async () => {
    const f = fakeFetch((req) => {
      const id = new URL(req.url).searchParams.get('videoId');
      if (id === 'human000001') return tracks(['standard', 'en'], ['asr', 'en']);
      if (id === 'robot000001') return tracks(['asr', 'en']);
      if (id === 'silent00001') return tracks();
      if (id === 'gone0000001') return googleError(404, 'videoNotFound');
      return googleError(403, 'forbidden');
    });
    const got = await platformCaptions(
      [yt('human000001'), yt('robot000001'), yt('human000001'), yt('silent00001'), yt('gone0000001'), yt('locked00001'), yt('bad id!')],
      { youtubeApiKey: KEY, fetchFn: f.fn, userAgent: 'UA' },
    );
    expect(Object.fromEntries(got)).toEqual({
      'youtube:human000001': { status: 'captions', languages: ['en'] },
      'youtube:robot000001': { status: 'auto-only', languages: ['en'] },
      'youtube:silent00001': { status: 'none' },
      'youtube:gone0000001': { status: 'unchecked', reason: 'not-found' },
      'youtube:locked00001': { status: 'unchecked', reason: 'api-error', httpStatus: 403 },
    });
    expect(f.calls).toHaveLength(5);
    const u = new URL(f.calls[0]!.url);
    expect([u.origin + u.pathname, [...u.searchParams.keys()].sort()]).toEqual(['https://www.googleapis.com/youtube/v3/captions', ['key', 'part', 'videoId']]);
    expect(u.searchParams.get('part')).toBe('snippet');
    // Nothing about the customer or the scan: no referer, cookie or site address, only our user agent.
    expect(Object.keys(f.calls[0]!.headers).sort()).toEqual(['accept', 'user-agent']);
  });

  it('retries 429 and 5xx (Retry-After honoured, capped), then says it could not check', async () => {
    let n = 0;
    const waits: number[] = [];
    const f = fakeFetch(() => (++n === 1 ? new Response('busy', { status: 429, headers: { 'retry-after': '3' } }) : n === 2 ? new Response('down', { status: 503 }) : tracks(['standard', 'en'])));
    const got = await platformCaptions([yt('retry000001')], { youtubeApiKey: KEY, fetchFn: f.fn, sleep: async (ms) => { waits.push(ms); } });
    expect(got.get('youtube:retry000001')).toEqual({ status: 'captions', languages: ['en'] });
    expect(waits).toEqual([3000, 1000]);
    const always = fakeFetch(() => new Response('down', { status: 500, headers: { 'retry-after': '3600' } }));
    const waited: number[] = [];
    const gave = await platformCaptions([yt('down0000001')], { youtubeApiKey: KEY, fetchFn: always.fn, sleep: async (ms) => { waited.push(ms); } });
    expect(always.calls).toHaveLength(1 + PLATFORM_CAPTION_LIMITS.retries);
    expect(waited.every((w) => w <= PLATFORM_CAPTION_LIMITS.maxRetryWaitMs)).toBe(true);
    expect(gave.get('youtube:down0000001')).toEqual({ status: 'unchecked', reason: 'api-error', httpStatus: 500 });
    const offline = fakeFetch(() => { throw new TypeError('offline'); });
    expect((await platformCaptions([yt('off00000001')], { youtubeApiKey: KEY, fetchFn: offline.fn, sleep: noSleep })).get('youtube:off00000001')).toEqual({ status: 'unchecked', reason: 'api-error' });
  });

  it('an answer that is too big or not JSON is an API error, never a status', async () => {
    const huge = fakeFetch(() => new Response(`{"items":[${'{"snippet":{"trackKind":"standard"}},'.repeat(20_000)}{}]}`));
    const html = fakeFetch(() => new Response('<html>'));
    for (const f of [huge, html]) expect((await platformCaptions([yt('big00000001')], { youtubeApiKey: KEY, fetchFn: f.fn })).get('youtube:big00000001')).toEqual({ status: 'unchecked', reason: 'api-error', httpStatus: 200 });
  });

  it('a call that never answers is cut at its time box; the whole lookup never runs past `by`', async () => {
    const hang = fakeFetch(() => new Promise<Response>(() => {}));
    const t = Date.now();
    const got = await platformCaptions([yt('hang0000001'), yt('hang0000002')], { youtubeApiKey: KEY, fetchFn: hang.fn, by: Date.now() + 150, sleep: noSleep });
    expect(Date.now() - t).toBeLessThan(2_000);
    expect([...got.values()]).toEqual([{ status: 'unchecked', reason: 'time-limit' }, { status: 'unchecked', reason: 'time-limit' }]);
  });

  it('caps the calls per scan and the videos considered; the rest say why', async () => {
    const f = fakeFetch(() => tracks(['standard', 'en']));
    const ids = Array.from({ length: 8 }, (_, i) => yt(`vid${String(i).padStart(8, '0')}`));
    const got = await platformCaptions(ids, { youtubeApiKey: KEY, fetchFn: f.fn, limits: { lookups: 3, videos: 6 } });
    expect(f.calls).toHaveLength(3);
    expect([...got.values()].map((s) => s.reason ?? s.status)).toEqual(['captions', 'captions', 'captions', 'scan-limit', 'scan-limit', 'scan-limit', 'scan-limit', 'scan-limit']);
    expect(PLATFORM_CAPTION_LIMITS.lookups).toBe(50);
  });

  it('the daily quota guard: spent before a call, or YouTube says quotaExceeded, means "daily limit" and no more calls', async () => {
    const spent = fakeFetch(() => tracks());
    let taken = 0;
    const got = await platformCaptions([yt('aaaaaaaaaa1'), yt('aaaaaaaaaa2')], {
      youtubeApiKey: KEY, fetchFn: spent.fn, quota: { take: async (units) => { taken += units; return taken <= 50; } },
    });
    expect([...got.values()].map((s) => s.reason ?? s.status).sort()).toEqual(['daily-limit', 'none']);
    expect(spent.calls).toHaveLength(1);
    let exhausted = 0;
    const google = fakeFetch(() => googleError(403, 'quotaExceeded'));
    const said = await platformCaptions([yt('bbbbbbbbbb1'), yt('bbbbbbbbbb2'), yt('bbbbbbbbbb3')], {
      youtubeApiKey: KEY, fetchFn: google.fn, limits: { concurrency: 1 }, quota: { take: async () => true, exhausted: async () => { exhausted++; } },
    });
    expect([...said.values()]).toEqual(Array(3).fill({ status: 'unchecked', reason: 'daily-limit' }));
    expect(google.calls).toHaveLength(1);
    expect(exhausted).toBe(1);
    const broken = await platformCaptions([yt('ccccccccccc')], { youtubeApiKey: KEY, fetchFn: spent.fn, quota: { take: async () => { throw new Error('down'); } } });
    expect(broken.get('youtube:ccccccccccc')).toEqual({ status: 'unchecked', reason: 'api-error' });
  });

  it('caches answers (7 days with captions, 1 day otherwise), never errors or the key; a rescan spends nothing', async () => {
    const { cache, m } = memoryCache();
    const f = fakeFetch((req) => (new URL(req.url).searchParams.get('videoId') === 'cap00000001' ? tracks(['standard', 'en']) : new URL(req.url).searchParams.get('videoId') === 'err00000001' ? new Response('x', { status: 400 }) : tracks()));
    const videos = [yt('cap00000001'), yt('non00000001'), yt('err00000001')];
    await platformCaptions(videos, { youtubeApiKey: KEY, fetchFn: f.fn, cache });
    expect([...m].map(([k, v]) => [k, v.ttl])).toEqual(expect.arrayContaining([
      ['captions@1:youtube:cap00000001', PLATFORM_CAPTION_TTL.captions], ['captions@1:youtube:non00000001', PLATFORM_CAPTION_TTL.other],
    ]));
    expect(m.size).toBe(2);
    expect(PLATFORM_CAPTION_TTL.captions).toBe(7 * 24 * 3600);
    expect(JSON.stringify([...m])).not.toContain(KEY);
    const again = await platformCaptions(videos.slice(0, 2), { youtubeApiKey: KEY, fetchFn: f.fn, cache, quota: { take: async () => { throw new Error('never asked'); } } });
    expect(f.calls).toHaveLength(3);
    expect([...again.values()].map((s) => s.status)).toEqual(['captions', 'none']);
  });

  it('the free check reads stored answers only; a cache that is down is a miss', async () => {
    const { cache } = memoryCache();
    await cache.put('captions@1:youtube:cap00000001', { status: 'captions', languages: ['en'] }, 60);
    const f = fakeFetch(() => tracks());
    const got = await platformCaptions([yt('cap00000001'), yt('new00000001')], { youtubeApiKey: KEY, fetchFn: f.fn, cache, lookups: false });
    expect(Object.fromEntries(got)).toEqual({ 'youtube:cap00000001': { status: 'captions', languages: ['en'] }, 'youtube:new00000001': { status: 'unchecked', reason: 'free-check' } });
    expect(f.calls).toHaveLength(0);
    const down: CaptionCache = { get: async () => { throw new Error('down'); }, put: async () => { throw new Error('down'); } };
    expect((await platformCaptions([yt('x0000000001')], { youtubeApiKey: KEY, fetchFn: f.fn, cache: down })).get('youtube:x0000000001')).toEqual({ status: 'none' });
  });

  it('asks nothing when the API address is refused, and nothing for a platform without a key or token', async () => {
    const f = fakeFetch(() => tracks());
    const refused = await platformCaptions([yt('aaaaaaaaaaa')], { youtubeApiKey: KEY, fetchFn: f.fn, allowUrl: async () => false });
    expect(refused.get('youtube:aaaaaaaaaaa')).toEqual({ status: 'unchecked', reason: 'api-error' });
    const vimeo = await platformCaptions([{ player: 'vimeo', videoId: '76979871' }], { youtubeApiKey: KEY, fetchFn: f.fn });
    expect(vimeo.get('vimeo:76979871')).toEqual({ status: 'unchecked', reason: 'no-token' });
    expect(f.calls).toHaveLength(0);
  });
});

describe('asking Vimeo (texttracks), ready for a token', () => {
  it('sends the token as a bearer to /videos/{id}/texttracks and maps the tracks; 404 is not found', async () => {
    const f = fakeFetch((req) => (req.url.endsWith('/videos/1/texttracks') ? Response.json({ data: [{ type: 'captions', language: 'en', active: true }] }) : new Response('{}', { status: 404 })));
    const got = await platformCaptions([{ player: 'vimeo', videoId: '1' }, { player: 'vimeo', videoId: '2' }], { vimeoToken: 'tok-not-real', fetchFn: f.fn });
    expect(Object.fromEntries(got)).toEqual({ 'vimeo:1': { status: 'captions', languages: ['en'] }, 'vimeo:2': { status: 'unchecked', reason: 'not-found' } });
    expect(f.calls[0]).toMatchObject({ url: 'https://api.vimeo.com/videos/1/texttracks', headers: { authorization: 'bearer tok-not-real', accept: 'application/vnd.vimeo.*+json;version=3.4' } });
  });
});

describe('the inventory and the report', () => {
  const report = (media: MediaItem[], pages = ['https://e.org/', 'https://e.org/b']): SiteReport => ({
    site: 'https://e.org/', scannedAt: '2026-11-05T00:00:00.000Z', score: 100, scoringVersion: 8,
    pages: pages.map((url) => ({ url, status: 'ok' })), rules: [], media,
    meta: { pageList: pages },
  } as unknown as SiteReport);

  it('finds YouTube links (youtu.be, watch, shorts, live) as linked videos, and nothing else', () => {
    expect(['https://youtu.be/aBcDeFgHiJ0', 'https://www.youtube.com/watch?v=aBcDeFgHiJ0&t=3', 'https://m.youtube.com/shorts/aBcDeFgHiJ0', 'https://youtube.com/live/aBcDeFgHiJ0'].map((u) => classifyVideoLink(u)?.videoId))
      .toEqual(Array(4).fill('aBcDeFgHiJ0'));
    for (const u of ['https://www.youtube.com/@district', 'https://www.youtube.com/playlist?list=PL1', 'https://www.youtube.com/watch?v=bad id', 'https://evil.com/watch?v=aBcDeFgHiJ0', 'https://youtu.be.evil.com/aBcDeFgHiJ0', 'x', `https://youtu.be/${'a'.repeat(5000)}`]) {
      expect(classifyVideoLink(u), u).toBeUndefined();
    }
  });

  it('one row per video id: embeds with other parameters merge, a link to it is its own row, one lookup', async () => {
    const pages = [
      page('https://e.org/', {
        frames: [{ src: 'https://www.youtube.com/embed/aBcDeFgHiJ0?rel=0', title: 'Board meeting', transcriptNearby: false }],
        links: [{ href: 'https://youtu.be/aBcDeFgHiJ0', text: 'Watch on YouTube', transcriptNearby: false }],
      }),
      page('https://e.org/b', { frames: [{ src: 'https://www.youtube-nocookie.com/embed/aBcDeFgHiJ0', transcriptNearby: false }] }),
    ];
    expect(mediaItems(pages).map((m) => [m.kind, m.url, m.foundOn])).toEqual([
      ['embed', 'https://www.youtube.com/embed/aBcDeFgHiJ0?rel=0', ['https://e.org/', 'https://e.org/b']],
      ['link', 'https://youtu.be/aBcDeFgHiJ0', ['https://e.org/']],
    ]);
    const f = fakeFetch(() => tracks(['asr', 'en']));
    const items = await buildMediaInventory(pages, { youtubeApiKey: KEY, fetchFn: f.fn });
    expect(f.calls).toHaveLength(1);
    expect(items.map((m) => [m.platformCaptions?.status, m.issues.map((i) => `${i.level} ${i.criterion} ${i.rule}`)])).toEqual([
      ['auto-only', ['review 1.2.2 platform-auto-captions-only']],
      ['auto-only', ['review 1.2.2 platform-auto-captions-only']],
    ]);
    expect(JSON.stringify(items)).not.toContain(KEY);
  });

  it('the findings: none is a possible problem with the fix, auto-only is flagged, captions is clean; never scored', () => {
    const item = (platformCaptions: PlatformCaptions, player: 'youtube' | 'vimeo' = 'youtube') => ({ kind: 'embed' as const, content: 'video' as const, url: 'u', foundOn: ['https://e.org/'], player, videoId: '1', captions: 'check-manually' as const, platformCaptions });
    const none = mediaIssues(item({ status: 'none' }));
    expect(none).toEqual([{ criterion: '1.2.2', level: 'review', rule: 'platform-no-captions', message: 'YouTube has no captions for this video. Upload a caption file in YouTube Studio; auto-generated captions are often wrong on names and terms.' }]);
    expect(mediaIssues(item({ status: 'auto-only' }))[0]).toMatchObject({ level: 'review', rule: 'platform-auto-captions-only' });
    expect(mediaIssues(item({ status: 'captions', languages: ['en'] }))).toEqual([]);
    expect(mediaIssues(item({ status: 'unchecked', reason: 'daily-limit' }))[0]!.message).toContain("We couldn't check this video's captions on YouTube: the day's limit of YouTube checks was reached.");
    expect(mediaIssues(item({ status: 'unchecked', reason: 'no-token' }, 'vimeo'))[0]!.message).toContain('Vimeo checks are not set up');
    const words = ['none', 'auto-only', 'unchecked'].flatMap((s) => mediaIssues(item({ status: s as 'none', reason: 'not-found' })).map((i) => i.message)).join(' ');
    expect(words).not.toMatch(/fair use|need to|compliant|\bpass(es)?\b/i);
    const scored = (media: MediaItem[]) => scoreReportV8(report(media))!.score;
    const listed = (p: PlatformCaptions) => [{ ...item(p), issues: mediaIssues(item(p)) } as MediaItem];
    expect(scored(listed({ status: 'none' }))).toBe(100);
    expect(scored(listed({ status: 'auto-only' }))).toBe(100);
  });

  it('a linked video never widens the share of a failing video on the page (no score moves)', () => {
    const native: MediaItem = { kind: 'video', content: 'video', url: 'https://e.org/v.mp4', foundOn: ['https://e.org/'], captions: 'none', controls: true, issues: [{ criterion: '1.2.2', level: 'problem', rule: 'no-captions-track', message: 'x' }] };
    const link: MediaItem = { kind: 'link', content: 'video', url: 'https://youtu.be/aBcDeFgHiJ0', foundOn: ['https://e.org/b'], player: 'youtube', videoId: 'aBcDeFgHiJ0', captions: 'check-manually', issues: [] };
    expect(scoreReportV8(report([native, link]))!.score).toBe(scoreReportV8(report([native]))!.score);
  });
});
