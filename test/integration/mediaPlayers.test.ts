// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.8: the media-players probe in real Chromium. Fixture pages: test/fixtures/media/players/.
// Embedded players are a synthetic stand-in (test/fixtures/media/players/platform/) served by a second
// local server; Chromium maps the real player host names to it and every other name to "not found",
// so nothing reaches YouTube, Vimeo or the internet. The fake player draws on a canvas (no media
// file) and sends tracking POSTs, which the request guard must stop without spoiling the result.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaPlayersProbe } from '../../src/probes/mediaPlayers.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding, ProbeRun } from '../../src/probes/types.js';
import { scanSite } from '../../src/scan.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

const IDS = ['capsOn0001', 'noCaps0001', 'ccUnav0001', 'autoCap001', 'liveCap001', 'liveNoC001', 'live_stream', 'never00001', 'needsPost1', 'error00001', 'unmute0001', 'slowStart1', 'liveBadge1', 'nested0001',
  'lateCc0001', 'hoverCc001', 'chipLive01', 'webAudio01', 'shadowAv01', 'noData0001', 'startNoSig1', 'lateLive01'];
const ROUTES: FixtureRoutes = {
  ...Object.fromEntries(IDS.map((id) => [`/embed/${id}`, { type: 'text/html; charset=utf-8', file: 'player.html' }])),
  '/video/111111': { type: 'text/html; charset=utf-8', file: 'vimeo.html' },
  '/video/222222': { type: 'text/html; charset=utf-8', file: 'vimeo.html' },
  '/event/333333/embed': { type: 'text/html; charset=utf-8', file: 'vimeo.html' },
  '/video/444444': { type: 'text/html; charset=utf-8', file: 'vimeo.html' },
};
const PAGES = [
  'captions.html', 'nocaps.html', 'unavailable.html', 'nocookie.html', 'auto.html', 'live.html', 'live-nocaps.html', 'live-url.html',
  'never.html', 'needs-post.html', 'error.html', 'unmute.html', 'slow.html', 'lazy.html', 'lazy-never.html', 'consent.html', 'covered.html',
  'hidden.html', 'broken.html', 'vimeo.html', 'vimeo-event.html', 'many.html', 'audio.html', 'native.html', 'native-live.html', 'none.html',
  'live-badge.html', 'nested.html', 'native-stream.html',
  // Review round 1.
  'late-cc.html', 'hover-cc.html', 'chip.html', 'web-audio.html', 'shadow-av.html', 'no-data.html', 'figure.html', 'lite.html', 'shadow.html',
  'scaled.html', 'rotated.html', 'page-media.html', 'shadow-open.html',
  // Review round 2.
  'no-signal.html', 'late-live.html', 'vimeo-stub.html',
  // A transcript quoted whole (whole sentences, an ellipsis only when cut).
  'native-quote.html',
];

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let platform: Awaited<ReturnType<typeof startFixtureServer>>;
/** "METHOD host path" for every request either server received. */
const requests: string[] = [];
const runs: Record<string, ProbeRun> = {};

beforeAll(async () => {
  const log = (req: { method?: string; headers: { host?: string }; url?: string }) => { requests.push(`${req.method} ${req.headers.host} ${req.url}`); };
  site = await startFixtureServer('media/players', {}, { onRequest: log });
  platform = await startFixtureServer('media/players/platform', ROUTES, { onRequest: log });
  const port = new URL(platform.origin).port;
  const map = ['www.youtube.com', 'www.youtube-nocookie.com', 'player.vimeo.com', 'vimeo.com'].map((h) => `MAP ${h} 127.0.0.1:${port}`);
  browser = await chromium.launch({ args: [`--host-resolver-rules=${[...map, 'MAP * ~NOTFOUND', 'EXCLUDE 127.0.0.1'].join(',')}`] });
  const list = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${site.origin}/${p}`, index })), [mediaPlayersProbe],
    { userAgent: 'grnted-test', full: true, concurrency: 3 });
  for (const r of list) runs[new URL(r.page).pathname.slice(1)] = r;
  // Time per page on the fixtures, for the task notes.
  console.log(`media-players ms per page: ${list.map((r) => `${new URL(r.page).pathname.slice(1)} ${r.ms}`).join(', ')}`);
}, 300_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await platform?.close();
});

const of = (page: string, criterion: string): ProbeFinding[] => {
  const r = runs[page];
  if (!r) throw new Error(`no run for ${page}`);
  return r.findings.filter((f) => f.criterion === criterion);
};
const one = (page: string, criterion: string): ProbeFinding => {
  const list = of(page, criterion);
  if (list.length !== 1) throw new Error(`${page} ${criterion}: ${JSON.stringify(runs[page]!.findings)}`);
  return list[0]!;
};
const OFFERS = /offers captions.*access to the audio/;

describe('media-players probe: embedded players', () => {
  it('every page ran (no time-out, no crash)', () => {
    for (const p of PAGES) expect(runs[p]?.status, `${p}: ${JSON.stringify(runs[p])}`).toBe('ok');
  });

  it('captions offered: accuracy not testable (no access to the audio); a transcript covers 1.2.3 only', () => {
    expect(one('captions.html', '1.2.2')).toMatchObject({ status: 'not_testable', target: 'http://www.youtube.com/embed/capsOn0001', detail: expect.stringMatching(OFFERS) });
    expect(one('captions.html', '1.2.4').status).toBe('not_applicable');
    expect(one('captions.html', '1.2.3')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('Read the transcript') });
    expect(one('captions.html', '1.2.5').status).toBe('not_testable');
    expect(one('captions.html', '1.2.1').status).toBe('not_applicable');
  });

  it('works the same on the privacy-enhanced (nocookie) domain and after a slow start', () => {
    expect(one('nocookie.html', '1.2.2')).toMatchObject({ status: 'not_testable', target: expect.stringContaining('youtube-nocookie.com'), detail: expect.stringMatching(OFFERS) });
    expect(one('slow.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
  });

  it('a player src first assigned after load is not requested, and its captions stay not testable', async () => {
    expect(one('lazy.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('player did not load') });
    const start = requests.length;
    const [run] = await runProbes(browser as unknown as BrowserLike, [{ url: `${site.origin}/lazy.html`, index: 0 }], [mediaPlayersProbe], { userAgent: 'grnted-test', full: true });
    expect(run!.findings).toContainEqual(expect.objectContaining({ criterion: '1.2.2', status: 'not_testable', detail: expect.stringContaining('player did not load') }));
    expect(requests.slice(start).filter((r) => r.includes('/embed/'))).toEqual([]);
  }, 30_000);

  it('the cut round (review media-v, S8): a player with no captions, captions marked unavailable, or automatic captions only is undecided, never failed (its sound was not assessed)', () => {
    expect(one('nocaps.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('offers no captions') });
    expect(one('unavailable.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('unavailable') });
    expect(one('auto.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('automatic') });
    // An audio-described version linked next to the player.
    expect([one('nocaps.html', '1.2.3').status, one('nocaps.html', '1.2.5').status]).toEqual(['no_failures_found', 'no_failures_found']);
  });

  it('live streams: 1.2.4 from the player\'s captions (badge, player data or a live-stream address)', () => {
    expect(one('live.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('live stream offers captions') });
    expect(one('live-url.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('live stream offers captions') });
    // The cut round (review media-v, S8): no captions on a stream whose sound was not assessed is undecided.
    expect(one('live-nocaps.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('live stream offers no captions') });
    expect(one('vimeo-event.html', '1.2.4')).toMatchObject({ status: 'not_testable' });
    // Only a LIVE badge says so, and it is disabled (players disable it at the live edge).
    expect(one('live-badge.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('live stream offers captions') });
    for (const c of ['1.2.2', '1.2.3', '1.2.5']) expect(one('live.html', c).status, c).toBe('not_applicable');
  });

  it('Vimeo-style players: the caption list in the player\'s data decides', () => {
    const cc = of('vimeo.html', '1.2.2');
    expect(cc.map((f) => [f.target, f.status])).toEqual([['http://player.vimeo.com/video/111111', 'not_testable'], ['http://player.vimeo.com/video/222222', 'not_testable']]);
    expect(cc[1]!.detail).toContain('offers no captions');
    expect(cc[0]!.detail).toContain('English (CC)');
  });

  it('never a clean result for a player it could not observe; the reason says why', () => {
    const cases: [string, RegExp][] = [
      ['error.html', /Video unavailable/],
      ['lazy-never.html', /did not load/],
      ['consent.html', /did not load.*cookie notice/],
      ['covered.html', /covers the player/],
      ['hidden.html', /hidden/],
      ['broken.html', /did not load/],
    ];
    for (const [page, re] of cases) {
      for (const c of ['1.2.2', '1.2.4']) expect(one(page, c), `${page} ${c}`).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(re) });
    }
    // Players that never start: captions not testable; their own data or timeline says on-demand, so 1.2.4 does not apply.
    for (const [page, re] of [['never.html', /did not start/], ['needs-post.html', /did not start.*POST request/]] as const) {
      expect(one(page, '1.2.2'), page).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(re) });
      expect(one(page, '1.2.4'), page).toMatchObject({ status: 'not_applicable', detail: 'not a live stream.' });
    }
    // Round 2: a seek bar that is hidden says nothing, so with no other sign 1.2.4 stays not testable.
    expect(one('no-data.html', '1.2.4')).toMatchObject({ status: 'not_testable' });
  });

  it('review #1/#7/#8: a late or hover-only captions control, and a "Live" chip in an on-demand video', () => {
    for (const page of ['late-cc.html', 'hover-cc.html', 'chip.html']) expect(one(page, '1.2.2'), page).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
    expect(one('chip.html', '1.2.4')).toMatchObject({ status: 'not_applicable' });
  });

  it('review round 2 #1: playing proves nothing about live; a late LIVE badge is still read; a bare Vimeo config says nothing', () => {
    expect(one('no-signal.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
    expect(one('no-signal.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('whether it is a live stream could not be told') });
    expect(one('late-live.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('live stream offers captions') });
    expect(one('late-live.html', '1.2.2').status).toBe('not_applicable');
    expect(one('vimeo-stub.html', '1.2.4').status).toBe('not_testable');
    // On-demand players with a positive sign (player data, a length) still give 1.2.4 not applicable.
    for (const page of ['captions.html', 'nocaps.html', 'chip.html']) expect(one(page, '1.2.4').status, page).toBe('not_applicable');
    expect(of('vimeo.html', '1.2.4').map((f) => f.status)).toEqual(['not_applicable', 'not_applicable']);
  });

  it('review #4: click-to-load previews and players inside web components are not testable, never "no video"; previews are never clicked', () => {
    const lite = of('lite.html', '1.2.2');
    expect(lite).toHaveLength(2);
    for (const f of lite) expect(f).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('click-to-load') });
    expect(of('lite.html', '1.2.4').every((f) => f.status === 'not_testable')).toBe(true);
    expect(requests.filter((r) => r.includes('from=lite'))).toEqual([]);
    expect(one('shadow.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('web component') });
    expect(one('shadow.html', '1.2.4').status).toBe('not_testable');
    expect(one('shadow-open.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('web component') });
  });

  it('review #9: a transcript in the section, outside the figure that holds the player', () => {
    expect(one('figure.html', '1.2.3')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('Transcript') });
  });

  it('quotes a transcript on the page in whole sentences: all of a short one, a long one cut at a sentence with an ellipsis', () => {
    const [short, long] = of('native-quote.html', '1.2.3').map((x) => x.detail);
    expect(short).toBe('a transcript is linked next to it ("Transcript: Welcome to Fernwood School. The office opens at 8:00."), a text alternative for the video.');
    expect(long).toContain('("Transcript: Welcome to the tour of Fernwood School.…")');
  });

  it('review #10: a scaled player is clicked where its play control really is; a rotated one is not clicked', () => {
    expect(one('scaled.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
    expect(one('rotated.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('transformed') });
  });

  it('tests at most 4 players a page; the others are not testable, never clean', () => {
    const cc = of('many.html', '1.2.2');
    expect(cc).toHaveLength(5);
    expect(cc.slice(0, 4).every((f) => OFFERS.test(f.detail))).toBe(true);
    expect(cc[4]).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('more than 4 players') });
  });

  it('keeps the player muted even when it turns its sound on', () => {
    expect(one('unmute.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
    expect(requests.some((r) => r.endsWith('/report?muted=true'))).toBe(true);
    // A frame the player adds after load is blocked by the frozen-src safety rule.
    expect(one('nested.html', '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
    expect(requests.filter((r) => r.includes(' www.youtube.com /nested.html') || r.includes('/report-nested'))).toEqual([]);
    expect(requests.filter((r) => r.includes('muted=false'))).toEqual([]);
  });

  it('review #5: Web Audio stays suspended, a closed-shadow video starts muted, and the page\'s own media is muted', () => {
    expect(requests.some((r) => r.endsWith('/report-audio?state=suspended'))).toBe(true);
    expect(requests.filter((r) => r.includes('state=running'))).toEqual([]);
    expect(requests.some((r) => r.endsWith('/report-shadow?muted=true'))).toBe(true);
    expect(requests.some((r) => r.endsWith('/report-page?muted=true'))).toBe(true);
    for (const page of ['web-audio.html', 'shadow-av.html']) expect(one(page, '1.2.2'), page).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(OFFERS) });
  });

  it('no embedded player gives an embedded-player 1.2.2 or 1.2.4 a clean result', () => {
    for (const [page, r] of Object.entries(runs)) {
      for (const f of r.findings.filter((x) => (x.criterion === '1.2.2' || x.criterion === '1.2.4') && x.target?.includes('/embed'))) {
        expect(f.status, `${page}: ${f.detail}`).not.toBe('no_failures_found');
      }
    }
  });
});

describe('media-players probe: sound-only and native media', () => {
  it('1.2.1: a transcript next to the audio is clean; an item whose file this test did not load is not judged without one (1.2.1 covers recordings only)', () => {
    // Batch 17, fix round 1 (S4): this test asks for no media file (see "safety" below), and the page's players
    // have not loaded theirs (preload="none"), so it cannot tell a recording from a live stream: undecided. The
    // every-page media-alternatives test reads their length and fails a recording (test/integration/mediaBounds.test.ts).
    const items = of('audio.html', '1.2.1');
    expect(items.map((f) => f.status).sort()).toEqual(['no_failures_found', 'not_testable', 'not_testable']);
    expect(items.find((f) => f.status === 'no_failures_found')!.detail).toContain('Transcript of episode 2');
    expect(items.some((f) => f.status === 'not_testable' && f.target?.endsWith('/episode3.mp3') && f.detail.includes('whether it is a recording or a live stream could not be told'))).toBe(true);
  });

  it('native video: a descriptions track covers 1.2.3/1.2.5; otherwise the AI media review decides; background video is skipped', () => {
    const d = of('native.html', '1.2.5');
    expect(d.map((f) => f.status)).toEqual(['no_failures_found', 'not_testable']);
    expect(d[1]!.detail).toContain('--ai-media');
    // Its two captioned videos name captions files this fixture site does not have: read for their cues since
    // 2026-11-10 (a track with no cue gives no captions), a file that does not load decides nothing.
    expect(of('native.html', '1.2.2').map((f) => f.status)).toEqual(['not_testable', 'not_testable']);
    expect(of('native.html', '1.2.2')[0]!.detail).toContain('captions file did not load');
    expect(one('native.html', '1.2.4').status).toBe('not_applicable');
    expect(one('native-live.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no captions track') });
    // A stream a script plays that had not loaded: whether it is live cannot be told, so not "not applicable".
    expect(one('native-stream.html', '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('streamed by a script') });
  });

  it('a page without media: every criterion not applicable', () => {
    expect(runs['none.html']!.findings.map((f) => [f.criterion, f.status])).toEqual([
      ['1.2.1', 'not_applicable'], ['1.2.2', 'not_applicable'], ['1.2.3', 'not_applicable'], ['1.2.4', 'not_applicable'], ['1.2.5', 'not_applicable'],
    ]);
  });
});

describe('media-players probe: safety', () => {
  it('sent nothing but GETs, downloaded no media file, clicked nothing outside the players\' play controls', () => {
    expect(requests.filter((r) => !/^(GET|HEAD) /.test(r))).toEqual([]);
    // The fake players send tracking POSTs on load and play: the guard stopped every one.
    expect(requests.some((r) => r.includes('/youtubei/'))).toBe(false);
    // No media file was requested (the pages use preload="none"; the probe downloads no video or audio).
    expect(requests.filter((r) => /\.(webm|mp4|mp3|wav|m4a|m3u8)(\?|$)/.test(r))).toEqual([]);
    // The page's own captions files are read for their cues (GET, by the browser's own track loader), each once at
    // most a page, never a descriptions track.
    const vtt = requests.filter((r) => /\.vtt(\?|$)/.test(r));
    expect(vtt.every((r) => /^GET /.test(r) && !/desc/.test(r))).toBe(true);
    expect(vtt.length).toBeLessThanOrEqual(6);
    // Never the cookie button, never a link out of the player, never a transcript or described-version link.
    expect(requests.filter((r) => /consent-accepted|\/watch\?v=|transcript|described/.test(r))).toEqual([]);
    // The players did play (their own GET pings, which the guard lets through, show it).
    expect(requests.filter((r) => r.includes('/api/stats/watchtime')).length).toBeGreaterThanOrEqual(10);
  });
});

describe('media-players probe in a scan', () => {
  it('feeds the 1.2.x rows with --full', async () => {
    const report = await scanSite(`${site.origin}/nocaps.html`, {
      browser: browser as unknown as BrowserLike, maxPages: 1, probes: [mediaPlayersProbe], full: true,
      fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    const row = (c: string) => report.criteria!.find((r) => r.criterion === c)!;
    expect(row('1.2.2').methods.find((m) => m.id === 'media-players')).toMatchObject({ status: 'not_testable', pages: 1 });
    expect(row('1.2.4').methods.find((m) => m.id === 'media-players')).toMatchObject({ status: 'not_applicable' });
    expect(row('1.2.5').methods.find((m) => m.id === 'media-players')).toMatchObject({ status: 'no_failures_found' });
  }, 120_000);

  it('review #4: click-to-load previews are in the media inventory and keep the rows from reading "not applicable"', async () => {
    const report = await scanSite(`${site.origin}/lite.html`, {
      browser: browser as unknown as BrowserLike, maxPages: 1, probes: [mediaPlayersProbe], full: true,
      fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    expect(report.media!.map((m) => [m.kind, m.player])).toEqual([['embed', 'youtube'], ['embed', 'youtube']]);
    for (const c of ['1.2.2', '1.2.4']) expect(report.criteria!.find((r) => r.criterion === c)!.status, c).toBe('not_testable');
    // A player in an open shadow root is in the inventory too.
    const open = await scanSite(`${site.origin}/shadow-open.html`, {
      browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, fetchFn: (async () => new Response('', { status: 404 })) as typeof fetch,
    });
    expect(open.media!.map((m) => m.url)).toEqual(['http://www.youtube.com/embed/capsOn0001?from=shadow']);
  }, 120_000);
});
