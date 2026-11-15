// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.2.2: a captions track that loads but holds no cue gives no captions (the same as no track at all), read
// by the media-players test from the browser's own text track. Fixture: test/fixtures/media/empty-captions.html
// (written for this test; the clips are the repository's own synthetic ones).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaPlayersProbe } from '../../src/probes/mediaPlayers.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

const sound = { type: 'video/webm', file: 'clip-tone.webm' };
const silent = { type: 'video/webm', file: 'clip.webm' };
const ROUTES = { '/october.webm': sound, '/september.webm': sound, '/august.webm': sound, '/site-walk.webm': silent, '/loop.webm': sound, '/november.webm': sound, '/december.webm': sound, '/january.webm': sound, '/notice.webm': sound };

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let findings: ProbeFinding[] = [];

beforeAll(async () => {
  site = await startFixtureServer('media', ROUTES);
  browser = await chromium.launch();
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${site.origin}/empty-captions.html`, index: 0 }], [mediaPlayersProbe], { userAgent: 'grnted-test', full: true, concurrency: 1 });
  findings = runs[0]!.findings.filter((f) => f.criterion === '1.2.2');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const of = (file: string) => findings.filter((f) => f.target?.endsWith(`/${file}`));

describe('1.2.2: a captions track with no captions in it', () => {
  // Review round 1, ruling 8: an empty track alone never proves missing captions. Captions that are part of the
  // picture (open captions) satisfy 1.2.2, and this test cannot see the picture: it says so, and never fails.
  it('a video with sound whose captions file loads with no cue is undecided, never failed: its captions may be part of the picture', () => {
    expect(of('october.webm')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('part of the picture') })]);
    expect(findings.filter((f) => f.status === 'failed')).toEqual([]);
  });

  it('a video whose sound track could not be read (it did not load) is undecided too', () => {
    expect(of('gone.webm')).toEqual([expect.objectContaining({ status: 'not_testable' })]);
  });

  it('a video clearly labelled as another way to get text that is on the page is left out (the exception in 1.2.2)', () => {
    expect(of('notice.webm')).toEqual([]);
  });

  it('look-alikes: a track with cues, a video with no sound track, a background video', () => {
    expect(of('september.webm')).toEqual([]);
    expect(of('site-walk.webm')).toEqual([]);
    expect(of('loop.webm')).toEqual([]);
  });

  it('an empty track beside a control that offers captions is undecided: the control may load them (the test presses nothing)', () => {
    // A button right after the player's block, and a control elsewhere on the page that names the player.
    expect(of('november.webm')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('“Turn on captions”') })]);
    expect(of('december.webm')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('“Subtitles for the December meeting”') })]);
    // A control that has nothing to do with captions ("Download the video") is not named in October's finding.
    expect(of('october.webm')[0]!.detail).not.toContain('Download');
  });

  it('captions a script adds as a text track of its own count as captions', () => {
    expect(of('january.webm')).toEqual([]);
  });

  it('a captions file that does not load is undecided, never clean', () => {
    expect(of('august.webm')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('did not load') })]);
  });
});
