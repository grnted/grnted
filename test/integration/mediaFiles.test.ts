// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test (1.2.2, batch 17): a video is failed for missing captions only when the scan shows
// speech in its sound, no captions of any kind on the page, a picture with nothing that could be writing in
// every frame sampled while the speech is heard, and no captions when the page's own video is played.
// Fixtures: test/fixtures/media/files-*.html, written for this test, and pages made here that load a player
// script from another site (a second server: another origin); the clips (test/fixtures/media/files/) are
// built by scripts/media-fixtures.mjs: synthetic speech, tones and tunes over pictures known by construction.
// Fix round 1 (the review's S1, S2, S3, S5, S7): each finding's case is here with the look-alike beside it.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaFilesProbe, MEDIA_FILES_LIMITS } from '../../src/probes/mediaFiles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding, ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer, type FixtureRoutes } from '../helpers/fixtureServer.js';

const STATIC = [
  'files-fail.html', 'files-open.html', 'files-other.html', 'files-sound.html', 'files-page.html', 'files-script.html', 'files-direct.html', 'files-far.html',
  'files-edge.html', 'files-backwards.html', 'files-voices.html', 'files-music.html', 'files-music-2.html', 'files-long.html', 'files-sources.html', 'files-guards.html', 'files-grows.html',
];
const LINES = JSON.stringify([[0.3, 3.41, 'The council meets on the first Tuesday of each month.'], [3.71, 6.74, 'Agendas are posted three days before each meeting.'], [7.04, 10.35, 'Public comment begins at six thirty in the evening.']]).replace(/"/g, '&quot;');
const page = (title: string, body: string): string => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body>\n<main>\n<h1>${title}</h1>\n${body}\n</main>\n</body>\n</html>\n`;
const html = (body: string) => ({ type: 'text/html; charset=utf-8', body });
/** Pages whose player script comes from another site (`cdn`: the second server's origin). */
const made = (cdn: string): FixtureRoutes => ({
  // S1: the script gives the video its captions track when it first plays.
  '/made-captions-on-play.html': html(page('Notice with a hosted player', `<section><h2>Watch the notice</h2>\n<video id="on-play" data-text="/files/speech.vtt" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?on-play"></video>\n</section>\n<script src="${cdn}/cdn/captions-on-play.js"></script>`)),
  // S1: the script shows what is said as text over the video while it plays.
  '/made-words-on-play.html': html(page('Notice with words on screen', `<section><h2>Watch the notice</h2>\n<div style="position:relative;width:640px"><video id="words" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?words"></video></div>\n</section>\n<script src="${cdn}/cdn/words-on-play.js"></script>`)),
  // S1: the same from a script on the page itself, which listens with addEventListener and names nothing a search for caption code finds.
  '/made-words-inline.html': html(page('Notice with words on screen, from the page', `<section><h2>Watch the notice</h2>\n<div style="position:relative;width:640px"><video id="words-inline" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?words-inline"></video></div>\n</section>\n<script>(function () { var v = document.getElementById('words-inline'); var lines = JSON.parse(v.getAttribute('data-lines')); var box = null; v.addEventListener('timeupdate', function () { if (!box) { box = document.createElement('div'); box.style.cssText = 'position:absolute;left:0;right:0;bottom:36px;text-align:center;color:#fff;background:rgba(0,0,0,.75);font:16px sans-serif'; v.parentNode.appendChild(box); } var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; box.textContent = now ? now[2] : ''; }); })();</script>`)),
  // S1 (the media-files lab found it at the end of the round): the video straight in the page's main content, no
  // wrapper; a script on the page writes each sentence into a new box it puts right after the video as it plays.
  '/made-words-below.html': html(page('Notice with words under it', `<h2>Watch the notice</h2>\n<video id="words-below" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?words-below"></video>\n<p>The council posts each notice the same day it is decided.</p>\n<p>Agendas are posted three days before each meeting.</p>\n<script>(function () { var v = document.getElementById('words-below'); var lines = JSON.parse(v.getAttribute('data-lines')); var box = null; v.addEventListener('timeupdate', function () { if (!box) { box = document.createElement('div'); box.style.cssText = 'margin:4px 0;min-height:1.4em;color:#111;background:#fff;font:16px sans-serif'; v.parentNode.insertBefore(box, v.nextSibling); } var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; box.textContent = now ? now[2] : ''; }); })();</script>`)),
  // The cut round (review media-v, S1): a canvas the page puts over the video before it plays, drawing what is said
  // into it as it plays (addEventListener, nothing on the page changes but the canvas's pixels).
  '/cut-canvas.html': html(page('Notice with words drawn over it', `<section><h2>Watch the notice</h2>\n<div style="position:relative;width:640px;height:360px"><video id="drawn" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?canvas"></video><canvas id="overlay" width="640" height="300" style="position:absolute;left:0;top:0;pointer-events:none"></canvas></div>\n</section>\n<script>(function () { var v = document.getElementById('drawn'); var c = document.getElementById('overlay').getContext('2d'); var lines = JSON.parse(v.getAttribute('data-lines')); v.addEventListener('timeupdate', function () { c.clearRect(0, 0, 640, 300); var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; if (now) { c.font = '18px sans-serif'; c.fillStyle = '#fff'; c.fillText(now[2], 20, 280); } }); })();</script>`)),
  // The second check of the cut round (review media-cut, S1): the block around the video shows what is said in its
  // generated content (::after, from an attribute a script sets as the video plays): nothing in the page's text changes.
  '/cut-generated.html': html(page('Notice with words from its block', `<style>.notice-box{position:relative;width:640px;height:360px}.notice-box::after{content:attr(data-line);position:absolute;left:0;right:0;bottom:44px;text-align:center;color:#fff;font:18px sans-serif;pointer-events:none}</style><section><h2>Watch the notice</h2>\n<div class="notice-box" data-line=""><video id="generated" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?generated"></video></div>\n</section>\n<script>(function () { var v = document.getElementById('generated'); var box = v.parentNode; var lines = JSON.parse(v.getAttribute('data-lines')); v.addEventListener('timeupdate', function () { var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; box.setAttribute('data-line', now ? now[2] : ''); }); })();</script>`)),
  // The cut round (review media-v, S2): a player script of another site gives the video an empty captions track and
  // fills it only when a visitor chooses it in the captions menu; and a captions track element with no file.
  '/cut-script-track.html': html(page('Notice with a player\'s own captions', `<section><h2>Watch the notice</h2>\n<video id="chosen" data-lines="${LINES}" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?chosen"></video>\n</section>\n<script src="${cdn}/cdn/track-on-choose.js"></script>`)),
  '/cut-track-no-file.html': html(page('Notice with a captions track and no file', `<section><h2>Watch the notice</h2>\n<video id="nofile" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?no-file"><track kind="captions" srclang="en" label="English"></video>\n</section>`)),
  // S1: a script of another site that allows reading it (as most hosts of shared scripts do), with code about captions in it.
  '/made-hosted-script.html': html(page('Notice with a script from a shared host', `<section><h2>Watch the notice</h2>\n<video id="hosted" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?hosted-script"></video>\n</section>\n<script src="${cdn}/open/files-captions.js"></script>`)),
  // S1, look-alike: a script of another site that follows the video and does nothing about captions.
  '/made-play-count.html': html(page('Notice with a play counter', `<section><h2>Watch the notice</h2>\n<video id="counted" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?counted"></video>\n</section>\n<script src="${cdn}/cdn/play-count.js"></script>`)),
  // S3: the script gives the video its captions when it comes into view, far down the page.
  '/made-captions-in-view.html': html(page('A long page with a notice at its end', `<section style="min-height:2600px"><h2>Agenda</h2><p>The council meets on the first Tuesday of each month.</p></section>\n<section><h2>Watch the notice</h2>\n<video id="in-view" data-text="/files/speech.vtt" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?in-view"></video>\n</section>\n<script src="${cdn}/cdn/captions-in-view.js"></script>`)),
  // S3: while the test reads the page's video (open captions, no track), the page puts a second video before it
  // (speech over a plain picture, captioned by a track). Both are accessible.
  '/made-swap.html': html(page('This week\'s and last week\'s notice', `<section id="this-week"><h2>This week's notice</h2>\n<video id="open" controls preload="metadata" width="640" height="360" src="/files/speech-open-captions.webm?swap"></video>\n</section>\n<template id="last-week"><section><h2>Last week's notice</h2>\n<video id="captioned" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?swap"><track kind="captions" src="/files/speech.vtt" srclang="en" label="English" default></video>\n</section></template>\n<script>(function () { var real = HTMLMediaElement.prototype.captureStream; var done = false; HTMLMediaElement.prototype.captureStream = function () { if (!done) { done = true; var first = document.getElementById('this-week'); first.parentNode.insertBefore(document.getElementById('last-week').content.cloneNode(true), first); } return real.apply(this, arguments); }; })();</script>`)),
});
const MADE = ['cut-generated.html', 'cut-canvas.html', 'cut-script-track.html', 'cut-track-no-file.html', 'made-captions-on-play.html', 'made-words-on-play.html', 'made-words-inline.html', 'made-words-below.html', 'made-hosted-script.html', 'made-play-count.html', 'made-captions-in-view.html', 'made-swap.html'];
const PAGES = [...STATIC, ...MADE];

let browser: Browser;
let cdn: Awaited<ReturnType<typeof startFixtureServer>>;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let runs: ProbeRun[] = [];

beforeAll(async () => {
  // Two servers, two origins: the second one is "another site" to the first (it allows no reading of its files).
  cdn = await startFixtureServer('media', { '/open/files-captions.js': { type: 'text/javascript', file: 'files-captions.js', headers: { 'access-control-allow-origin': '*' } } });
  site = await startFixtureServer('media', made(cdn.origin));
  browser = await chromium.launch({ args: ['--mute-audio'] });
  runs = await runProbes(browser as unknown as BrowserLike, PAGES.map((p, index) => ({ url: `${site.origin}/${p}`, index })), [mediaFilesProbe], { userAgent: 'grnted-test', concurrency: 1 });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
  await cdn?.close();
});

const run = (name: string): ProbeRun | undefined => runs.find((r) => r.page.endsWith(`/${name}`));
const captions = (name: string): ProbeFinding[] => run(name)?.findings.filter((f) => f.criterion === '1.2.2') ?? [];
const of = (name: string, file: string): ProbeFinding[] => captions(name).filter((f) => f.target?.endsWith(`/files/${file}`));
const one = (status: ProbeFinding['status'], words: string) => [expect.objectContaining({ status, detail: expect.stringContaining(words) })];
/** What the test measured of a video (the run's data). */
const measured = (name: string, file: string): Record<string, unknown> | undefined => ((run(name)?.data as { videos?: Record<string, unknown>[] } | undefined)?.videos ?? []).find((v) => String(v.video).endsWith(`/files/${file}`));

describe('1.2.2: a video with speech and no captions, shown by measuring its sound and its picture', () => {
  it('every run finished', () => {
    expect(runs.map((r) => r.status)).toEqual(PAGES.map(() => 'ok'));
  });

  it('red: speech, no captions track, a picture with nothing that could be writing: failed, with the measurements', () => {
    const [f] = of('files-fail.html', 'speech-plain.webm');
    expect(f).toMatchObject({ status: 'failed', criterion: '1.2.2' });
    expect(f!.detail).toMatch(/has speech and no captions/);
    expect(f!.detail).toMatch(/it has no captions or subtitles track/);
    expect(f!.detail).toMatch(/nothing that could be writing in any of the \d+ frames sampled while speech is heard/);
    expect(f!.detail).toMatch(/when the test played it \(muted, [\d.]+ s from \d:\d\d, a moment of speech\) no captions came/);
    // The whole proof and the fix fit in what a finding keeps.
    expect(f!.detail).toMatch(/Add captions: a WebVTT file linked with a track element\.$/);
    expect(f!.data).toMatchObject({ captionsTracks: 0 });
    expect(Number(f!.data!.speechSeconds)).toBeGreaterThan(3);
    expect(Number(f!.data!.framesSampled)).toBeGreaterThanOrEqual(6);
    expect(Number(f!.data!.playedSeconds)).toBeGreaterThanOrEqual(0.8);
  });

  // The cut round (review media-v, S2): a captions track, whatever it holds, is never "no captions".
  it('a captions track that loads and holds no captions is undecided (a player may fill it when a visitor chooses it): never failed since scoring v13', () => {
    expect(of('files-fail.html', 'speech-plain-f.webm')).toEqual(one('not_testable', 'has a captions or subtitles track with no captions in it when the page was read'));
  });

  it('a captions file the site answers 404 for is undecided too: never failed since scoring v13', () => {
    expect(of('files-fail.html', 'speech-plain-es.webm')).toEqual(one('not_testable', 'has a captions or subtitles track with no captions in it when the page was read'));
  });

  it('a large shape moving over a flat picture is still a picture with nothing that could be writing', () => {
    expect(of('files-other.html', 'speech-moving.webm')).toEqual(one('failed', 'has speech and no captions'));
  });

  it('look-alikes that give no finding: captions in a track, a background video, a silent sound track, no sound track', () => {
    expect(of('files-fail.html', 'speech-plain.webm?captioned')).toEqual([]);
    expect(of('files-fail.html', 'speech-plain.webm?background')).toEqual([]);
    expect(of('files-sound.html', 'silent-track.webm')).toEqual([]);
    expect(of('files-page.html', 'no-sound.webm')).toEqual([]);
  });

  it('open captions (each sentence in the picture while it is spoken) are never failed: the picture shows marks', () => {
    expect(of('files-open.html', 'speech-open-captions.webm')).toEqual(one('not_testable', 'marks that may be writing'));
  });

  it('captions in the picture for a part of the speech only: undecided (the test cannot read them)', () => {
    expect(of('files-open.html', 'speech-late-captions.webm')).toEqual(one('not_testable', 'marks that may be writing'));
  });

  it('a slide with text, one burned-in line, or detailed footage: undecided, never failed', () => {
    expect(of('files-open.html', 'speech-slide.webm')).toEqual(one('not_testable', 'marks that may be writing'));
    expect(of('files-other.html', 'speech-static-caption.webm')).toEqual(one('not_testable', 'marks that may be writing'));
    expect(of('files-other.html', 'speech-footage.webm')).toEqual(one('not_testable', 'marks that may be writing'));
  });

  it('sound that is not shown to be speech (a tune, a chime) is undecided: music needs no captions', () => {
    expect(of('files-sound.html', 'tune-plain.webm')).toEqual(one('not_testable', 'could not show that the sound is speech'));
    expect(of('files-sound.html', 'chime-plain.webm')).toEqual(one('not_testable', 'could not show that the sound is speech'));
  });

  it('captions the page may give another way: a captions control, the page\'s own player, a caption area, a video version of the text, a timed transcript', () => {
    expect(of('files-page.html', 'speech-plain.webm?button')).toEqual(one('not_testable', '“Show captions”'));
    expect(of('files-page.html', 'speech-plain.webm?custom')).toEqual(one('not_testable', 'the page\'s own player'));
    expect(of('files-page.html', 'speech-plain.webm?area')).toEqual(one('not_testable', '.video-captions'));
    expect(of('files-page.html', 'speech-plain.webm?alternative')).toEqual(one('not_testable', 'another way to get text'));
    expect(of('files-page.html', 'speech-plain.webm?timed')).toEqual(one('not_testable', 'lines of text with start times'));
  });

  it('a captions control or caption area right after a video that sits straight in the main content is seen too (the lab found this)', () => {
    expect(of('files-direct.html', 'speech-plain.webm?direct')).toEqual(one('not_testable', '“Captions”'));
    expect(of('files-direct.html', 'speech-plain.webm?direct-area')).toEqual(one('not_testable', '#subtitle-line'));
  });

  it('a script of the page that works with captions (it makes a track element) may add them later: undecided', () => {
    expect(of('files-script.html', 'speech-plain.webm?scripted')).toEqual(one('not_testable', 'a script of the page works with captions'));
    expect(of('files-script.html', 'speech-plain.webm?scripted')[0]!.detail).toContain('/files-captions.js');
  });

  it('a video in a same-site frame that is not a known player is read too, and says where it is', () => {
    // The second check of the cut round (review media-cut, S1): the page around a frame may draw captions over it,
    // which the test does not read from inside the frame: a video in a frame is undecided, never failed.
    expect(of('files-page.html', 'speech-plain.webm?framed')).toEqual(one('not_testable', 'this video is in a frame of this page (/files-frame.html): the page around the frame may show captions over it'));
  });
});

describe('fix round 1, S1: captions a script gives a video when it plays are unknown until it plays', () => {
  it('red: a player script of another site adds the captions track on play (no track before): the test plays the video, the captions come, nothing is failed', () => {
    expect(of('made-captions-on-play.html', 'speech-plain.webm?on-play')).toEqual([]);
    expect(measured('made-captions-on-play.html', 'speech-plain.webm?on-play')).toMatchObject({ captionsTracks: 0, played: { cues: 3 }, scriptsUnread: 1 });
  });

  it('red: a script of another site shows what is said as text over the video while it plays (addEventListener, no track): undecided', () => {
    expect(of('made-words-on-play.html', 'speech-plain.webm?words')).toEqual(one('not_testable', 'text came or changed next to or over the video while the test played it'));
  });

  it('red: the same from a script on the page that names nothing a search for caption code finds: undecided', () => {
    expect(of('made-words-inline.html', 'speech-plain.webm?words-inline')).toEqual(one('not_testable', 'text came or changed next to or over the video while the test played it'));
  });

  it('red (the lab found it at the end of the round): the words written into a new box put right after a video that stands straight in the main content, as it plays: undecided', () => {
    expect(of('made-words-below.html', 'speech-plain.webm?words-below')).toEqual(one('not_testable', 'text came or changed next to or over the video while the test played it'));
  });

  it('red (review media-v, S1): a canvas already over the picture, drawing what is said into it as the video plays (nothing else on the page changes): undecided, never failed', () => {
    expect(of('cut-canvas.html', 'speech-plain.webm?canvas')).toEqual(one('not_testable', 'something that can draw lies over its picture (canvas#overlay)'));
  });

  it('red (review media-cut, S1): the block around the video shows what is said in its generated content as the video plays: undecided, never failed', () => {
    expect(of('cut-generated.html', 'speech-plain.webm?generated')).toEqual(one('not_testable', 'the generated content of a block around the video may have changed as it played'));
  });

  it('red (review media-v, S2): an empty captions track a player of another site fills only when a visitor chooses it, and a captions track with no file: undecided, never failed', () => {
    expect(of('cut-script-track.html', 'speech-plain.webm?chosen')).toEqual(one('not_testable', 'has a captions or subtitles track with no captions in it when the page was read'));
    expect(of('cut-track-no-file.html', 'speech-plain.webm?no-file')).toEqual(one('not_testable', 'has a captions or subtitles track with no captions in it when the page was read'));
  });

  it('a script of another site that allows reading it is read like the page\'s own: code about captions in it leaves the video undecided', () => {
    const [f, ...rest] = of('made-hosted-script.html', 'speech-plain.webm?hosted-script');
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('a script of the page works with captions') });
    expect(f!.detail).toMatch(/in 127\.0\.0\.1:\d+\/open\/files-captions\.js/);
  });

  it('look-alike: a script of another site that follows the video and does nothing about captions: still failed, after the video was played', () => {
    expect(of('made-play-count.html', 'speech-plain.webm?counted')).toEqual(one('failed', 'a moment of speech) no captions came (no track, no cue, no text by it)'));
    expect(measured('made-play-count.html', 'speech-plain.webm?counted')).toMatchObject({ played: { added: 0, cues: 0 }, scriptsUnread: 1 });
  });

  it('look-alike: a video that takes its picture\'s size once it plays (640 by 200 with its poster, 640 by 360 after), under a menu bar whose closed lists hang over it, with a badge the grown video comes to cover: nothing came over the picture, still failed', () => {
    expect(of('files-grows.html', 'speech-plain.webm?grows')).toEqual(one('failed', 'no captions came (no track, no cue, no text by it)'));
  });

  it('a captions control anywhere else on the page (a tool bar far from the video) may be wired to it: undecided', () => {
    expect(of('files-far.html', 'speech-plain.webm?far')).toEqual(one('not_testable', 'a control elsewhere on the page offers captions (“Subtitles”)'));
  });

  it('a control of the page\'s own beside the video that may open a menu (a settings button, a button with no name) may offer captions inside it: undecided', () => {
    expect(of('files-guards.html', 'speech-plain.webm?menu')).toEqual(one('not_testable', 'a control next to this video (“Settings”) may open a menu that offers captions'));
    expect(of('files-guards.html', 'speech-plain.webm?icon')).toEqual(one('not_testable', 'a control next to this video (“a control with no name”) may open a menu that offers captions'));
  });

  it('red: the words beside the video, marked line by line as they are spoken (a class the page sets from its own list of times): seen when the video is played, undecided', () => {
    expect(of('files-guards.html', 'speech-plain.webm?follows')).toEqual(one('not_testable', 'text came or changed next to or over the video while the test played it (“marked as it played: '));
  });

  it('red: something the page lays over the picture when the video plays (a canvas it draws on: no text in the page): undecided', () => {
    expect(of('files-guards.html', 'speech-plain.webm?drawn')).toEqual(one('not_testable', 'while the test played it (“something was put over the video as it played”)'));
  });
});

describe('fix round 1, S2: every part of a frame is read, at its edges and when it is scaled down', () => {
  it('red: captions in the last 14 rows of a 642 x 366 picture (below the last whole 16 px cell): marks, undecided', () => {
    expect(of('files-edge.html', 'speech-edge-captions.webm')).toEqual(one('not_testable', 'marks that may be writing'));
  });

  it('small captions in a 2560 x 1440 picture: larger than the test reads frames of since the cut round (review media-v, S4): undecided, not measured', () => {
    expect(MEDIA_FILES_LIMITS.maxPixels).toBeLessThan(2560 * 1440);
    expect(of('files-edge.html', 'speech-small-captions.webm')).toEqual(one('not_testable', 'its picture is 2560 x 1440 pixels'));
  });

  it('look-alike: a plain picture of the same odd size, with the same speech: failed', () => {
    expect(of('files-edge.html', 'speech-plain-odd.webm')).toEqual(one('failed', 'has speech and no captions'));
  });
});

describe('fix round 1, S3: one element and one file through every step', () => {
  it('red: a captioned video put before an open-captioned one while the page is read: the first is still judged by its own file (marks), and nothing is failed', () => {
    expect(of('made-swap.html', 'speech-open-captions.webm?swap')).toEqual(one('not_testable', 'marks that may be writing'));
    expect(captions('made-swap.html').filter((f) => f.status === 'failed')).toEqual([]);
  });

  it('red: a video whose first file this browser cannot play is not judged by its second one: undecided', () => {
    expect(of('files-sources.html', 'speech-plain.webm?second')).toEqual(one('not_testable', 'plays another of the video\'s files than the first one it lists'));
  });

  it('look-alike: a video whose first file plays (a second one is listed after it): failed', () => {
    expect(of('files-sources.html', 'speech-plain.webm?first')).toEqual(one('failed', 'has speech and no captions'));
  });

  it('red: captions a script of another site adds when the video comes into view: the test scrolls to it before it files anything, and files nothing', () => {
    const found = of('made-captions-in-view.html', 'speech-plain.webm?in-view');
    expect(found.filter((f) => f.status === 'failed')).toEqual([]);
    // Undecided when the captions came between the test's reads (the video changed), no finding when they were there from the first read.
    if (found.length) expect(found).toEqual(one('not_testable', 'changed while the page was read'));
  });
});

describe('fix round 1, S5: sound that is like speech and is not', () => {
  it('red: speech played backwards is not shown to be speech (it lacks the shape speech has in time): undecided', () => {
    for (const file of ['speech-reversed.webm', 'speech-reversed-f.webm', 'speech-reversed-es.webm']) {
      expect(of('files-backwards.html', file), file).toEqual(one('not_testable', 'could not show that the sound is speech'));
    }
  });

  it('a voice without words (syllables on a tune, scat, humming, one vowel) is not shown to be speech: undecided', () => {
    for (const [name, file] of [['files-voices.html', 'vocal-la.webm'], ['files-voices.html', 'vocal-scat.webm'], ['files-voices.html', 'vocal-hum.webm'], ['files-music.html', 'vocal-ah.webm']] as const) {
      expect(of(name, file), file).toEqual(one('not_testable', 'could not show that the sound is speech'));
    }
  });

  it('music the first set did not have (an arpeggio, a sliding lead between bursts of hiss, a synthesiser made to sound like talk, an organ): undecided', () => {
    for (const [name, file] of [['files-music.html', 'music-arp.webm'], ['files-music.html', 'music-lead.webm'], ['files-music-2.html', 'music-talk.webm'], ['files-music-2.html', 'music-organ.webm']] as const) {
      expect(of(name, file), file).toEqual(one('not_testable', 'could not show that the sound is speech'));
    }
  });
});

describe('fix round 1, S7: no more sound is decoded than the limits allow, whatever the file\'s length', () => {
  it('red: 36 s of speech in six channels (six channels fill the memory limit in 29 s): only a cut of the file is decoded, and the video is still decided', () => {
    const limit = Math.floor(MEDIA_FILES_LIMITS.maxPcmBytes / (48_000 * 6 * 4));
    expect(limit).toBe(29);
    const m = measured('files-long.html', 'speech-long-six.webm') as { decoded?: { seconds: number; channels: number; cut: boolean } } | undefined;
    expect(m?.decoded).toMatchObject({ channels: 6, cut: true });
    expect(m!.decoded!.seconds).toBeLessThanOrEqual(limit);
    expect(m!.decoded!.seconds).toBeGreaterThanOrEqual(MEDIA_FILES_LIMITS.minSeconds);
    expect(of('files-long.html', 'speech-long-six.webm')).toEqual(one('failed', 'has speech and no captions'));
  });

  it('70 s of speech in an MP4 file whose index is at its end: the first minute is cut out of it, decoded, and the video is decided', () => {
    const m = measured('files-long.html', 'speech-long-mp4.mp4') as { decoded?: { seconds: number; channels: number; cut: boolean } } | undefined;
    expect(m?.decoded).toMatchObject({ channels: 1, cut: true });
    expect(m!.decoded!.seconds).toBeLessThanOrEqual(MEDIA_FILES_LIMITS.cutSeconds);
    expect(m!.decoded!.seconds).toBeGreaterThanOrEqual(55);
    expect(of('files-long.html', 'speech-long-mp4.mp4')).toEqual(one('failed', 'has speech and no captions'));
  });

  it('look-alike: a short file is decoded whole', () => {
    expect(measured('files-fail.html', 'speech-plain.webm')).toMatchObject({ decoded: { channels: 1, cut: false } });
  });
});

describe('1.2.2: the whole set', () => {
  it('nothing else fails', () => {
    const failed = PAGES.flatMap((p) => captions(p).filter((f) => f.status === 'failed').map((f) => f.target!.replace(/^.*\/files\//, '')));
    expect(failed.sort()).toEqual([
      'speech-long-mp4.mp4', 'speech-long-six.webm', 'speech-moving.webm', 'speech-plain-odd.webm', 'speech-plain.webm',
      'speech-plain.webm?counted', 'speech-plain.webm?first', 'speech-plain.webm?grows',
    ]);
  });
});
