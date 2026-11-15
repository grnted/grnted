// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.2.1 for sound-only media: a text alternative next to the player is not always called a "transcript".
// WCAG 1.2.1 asks for "an alternative for time-based media" (G158); for a clip with no speech that is a
// description of its sounds. Fixture: test/fixtures/media/audio-text/ (synthetic, written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mediaAlternativesProbe } from '../../src/probes/mediaFiles.js';
import { mediaPlayersProbe } from '../../src/probes/mediaPlayers.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
let findings: ProbeFinding[] = [];
/** The deep media-players test's results for the same page (it asks for no media file). */
let deep: ProbeFinding[] = [];

beforeAll(async () => {
  // Each player's file is a real recording (a set length): 1.2.1 judges recordings only (batch 17, fix round 1, S4).
  const RECORDINGS = ['statement.mp3', 'about-only.mp3', 'after-text.mp3', 'beside-sound.mp3', 'beside-unknown.mp3', 'beside.mp3', 'caption-only.mp3', 'described.wav', 'fortext.mp3', 'hidden-said.mp3', 'hidden-text.mp3',
    'in-details.mp3', 'invite-only.mp3', 'labelled.wav', 'named.mp3', 'nothing.mp3', 'said.mp3', 'sounds.wav', 'tied.mp3'];
  site = await startFixtureServer('media/audio-text', {
    '/fold.webm': { type: 'video/webm', file: '../clip.webm' }, '/choir.webm': { type: 'video/webm', file: '../clip-tone.webm' },
    ...Object.fromEntries(RECORDINGS.map((name) => [`/${name}`, { type: 'audio/wav', file: '../files/chime.wav' }])),
  });
  browser = await chromium.launch();
  // The same rules run in two tests: the every-page media-alternatives test, which asks the browser for each
  // file's length (1.2.1 covers recordings only: batch 17, fix round 1, S4), and the deep media-players test,
  // which asks for no media file. The page's players have not loaded theirs (preload="none").
  const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${site.origin}/index.html`, index: 0 }], [mediaAlternativesProbe], { userAgent: 'grnted-test', concurrency: 1 });
  findings = runs[0]!.findings.filter((f) => f.criterion === '1.2.1');
  const deepRuns = await runProbes(browser as unknown as BrowserLike, [{ url: `${site.origin}/index.html`, index: 0 }], [mediaPlayersProbe], { userAgent: 'grnted-test', full: true, concurrency: 1 });
  deep = deepRuns[0]!.findings.filter((f) => f.criterion === '1.2.1');
}, 180_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

const of = (file: string): ProbeFinding => {
  const f = findings.filter((x) => x.target?.endsWith(`/${file}`));
  if (f.length !== 1) throw new Error(`${file}: ${JSON.stringify(findings)}`);
  return f[0]!;
};

describe('1.2.1: a sound clip with its text alternative next to it (G158)', () => {
  it('text labelled as the alternative ("Text alternative:", "Audio description:") is one', () => {
    expect(of('labelled.wav')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('Text alternative: one long low blast') });
    expect(of('described.wav')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('Audio description: a brass bell') });
  });

  it('a block the page itself names a transcript, and text tied to the player with aria-describedby, are one', () => {
    expect(of('named.mp3').status).toBe('no_failures_found');
    expect(of('tied.mp3').status).toBe('no_failures_found');
  });

  it('unlabelled text that describes the sounds is undecided, never a failure', () => {
    expect(of('sounds.wav')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('may be its text alternative') });
  });

  it('look-alikes are not given an alternative (listed for a person to check since batch 17\'s cut, never failed): a caption that only names the clip, and a player with nothing next to it', () => {
    expect(of('caption-only.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
    expect(of('nothing.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
  });

  it('text the page says is what the recording says is an alternative', () => {
    expect(of('said.mp3')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('This recording says the following') });
  });

  it('audio offered as another way to get text that is on the page (a media alternative for text) is never failed', () => {
    expect(of('fortext.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('another way to get text that is on the page') });
    expect(of('statement.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('another way to get text that is on the page') });
  });

  it('an audio player right beside a video with no sound track may be that video\'s audio alternative: undecided', () => {
    expect(of('beside.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('beside a video with no sound') });
    // A video that did not load: whether it has sound cannot be read, so the audio beside it is not failed either.
    expect(of('beside-unknown.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('whose sound track could not be read') });
    // Beside a video that has sound, it may be an audio track for that video (an audio description, another language).
    expect(of('beside-sound.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('may be an audio track for that video') });
  });

  it('text nobody can see is no alternative: hidden words of the recording, and hidden text the audio is said to stand in for, are not taken as one (listed for a person to check)', () => {
    expect(of('hidden-text.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
    expect(of('hidden-said.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
    // Inside the browser's own disclosure there is a way to show it.
    expect(of('in-details.mp3').status).toBe('no_failures_found');
  });

  it('look-alikes are not given an alternative (listed for a person to check): a line about the recording with none of its words, an invitation with no text, a player not right beside the video', () => {
    expect(of('about-only.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
    expect(of('invite-only.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
    expect(of('after-text.mp3')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('no transcript was found next to') });
  });
  it('the deep media-players test agrees wherever it decides, and never fails an item whose length it did not read (it asks for no media file)', () => {
    const byTarget = new Map(findings.map((f) => [f.target, f.status]));
    expect(deep.length).toBe(findings.length);
    for (const f of deep) {
      const core = byTarget.get(f.target);
      // The same status wherever both decide; since batch 17's cut neither test fails a missing transcript.
      expect(f.status === core || (core === 'failed' && f.status === 'not_testable' && f.detail.includes('its length was not read')), `${f.target}: ${f.status} / ${core}`).toBe(true);
    }
    expect(deep.filter((f) => f.status === 'failed')).toEqual([]);
  });
});
