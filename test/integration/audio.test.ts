// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The 1.4.2 probe (audio, core) in real Chromium on test/fixtures/motion/audio-*.html (synthetic tones).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audioProbe } from '../../src/probes/audio.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import { motionSite, only, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => { await site?.close(); });

describe('audio probe (1.4.2)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([audioProbe], [
      'audio-autoplay.html', 'audio-controls.html', 'audio-mute.html', 'audio-short.html', 'audio-video.html', 'audio-webaudio.html',
      'audio-webaudio-stop.html', 'audio-chime.html', 'audio-script.html', 'audio-frame.html', 'audio-post.html', 'video.html', 'static.html',
      'video-silent.html', 'audio-autoplay-navlink.html', 'audio-video-fragment.html', 'audio-video-fragment-long.html', 'audio-video-quiet.html',
    ], { concurrency: 4 });
  }, 120_000);
  const f = (page: string) => only(runs[page]![0]!);

  it('fails sound that plays by itself for more than 3 s with no way to stop it', () => {
    expect(f('audio-autoplay.html')).toMatchObject({ status: 'failed', target: expect.stringContaining('audio'), detail: expect.stringContaining('an audio player (looping) plays sound by itself with no end') });
    expect(f('audio-video.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('a video (looping)') });
    expect(f('audio-webaudio.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('sound made with Web Audio') });
    expect(f('audio-script.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('audio started by a script') });
    expect(f('audio-frame.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/in the embedded frame .*audio-autoplay\.html/) });
    expect(f('audio-frame.html').target).toBeUndefined();
  });

  it('fails it when the page only has links named like media ("Video", "Audio"): navigation links are not controls', () => {
    expect(f('audio-autoplay-navlink.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing on the page pauses, stops or mutes it') });
  });

  it('accepts player controls and working mute or stop buttons', () => {
    expect(f('audio-controls.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('its own player controls') });
    expect(f('audio-mute.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Mute music" stops it') });
    expect(f('audio-webaudio-stop.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Stop sound" stops it') });
  });

  it('finds no sound on silent pages, muted video and sounds of 3 s or less', () => {
    for (const page of ['audio-short.html', 'audio-chime.html', 'video.html', 'static.html']) {
      expect(f(page), page).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
    }
  });

  // 2026-11-09 benchmark review. A capture of the element lists the file's tracks once its metadata is read (a video
  // with a sound track lists it then, before any audio is decoded: audio-video.html above, and the media collector's
  // tests). A video track and no audio track is a file without sound; a sound track is listened to while it plays.
  it('exempts confirmed video-only content and leaves a quiet audio track undecided', () => {
    expect(f('video-silent.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
    expect(f('audio-video-quiet.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('whether it has sound could not be told') });
  });

  it('times a media fragment: 2 s of sound passes, 5 s with no control fails', () => {
    expect(f('audio-video-fragment.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
    expect(f('audio-video-fragment-long.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('a video (6 s long) plays sound by itself for 5 s') });
  });

  it('gives no verdict when the only control needs the server', () => {
    expect(f('audio-post.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('POST request') });
  });
});

// Web Audio is timed from when its sound started: a context the browser held suspended starts when the
// test resumes it, well after the load (sim lab: a tone of exactly 3 s was failed, timed from the load).
describe('audio probe: Web Audio timed from when the sound started', () => {
  it('passes a tone of exactly 3 s; fails one of 3.5 s', async () => {
    const runs = await site.run([audioProbe], ['audio-webaudio-3000.html', 'audio-webaudio-3500.html'], { concurrency: 1 });
    expect(only(runs['audio-webaudio-3000.html']![0]!)).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
    expect(only(runs['audio-webaudio-3500.html']![0]!)).toMatchObject({ status: 'failed', detail: expect.stringContaining('sound made with Web Audio') });
  }, 60_000);

  // Review r1: the 3.5 s tone ends on its own while a do-nothing Pause is tried; the button was credited.
  it('a 3.5 s tone with a Pause button that does nothing: failed, the button is not credited', async () => {
    const runs = await site.run([audioProbe], ['audio-webaudio-3500-noop.html'], { concurrency: 1 });
    const f = only(runs['audio-webaudio-3500-noop.html']![0]!);
    expect(f.status).toBe('failed');
    expect(f.detail).not.toMatch(/stops it/);
  }, 60_000);

  it('a Stop button that stops the oscillator (its context keeps running) is credited', async () => {
    const runs = await site.run([audioProbe], ['audio-webaudio-osc-stop.html'], { concurrency: 1 });
    expect(only(runs['audio-webaudio-osc-stop.html']![0]!)).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Stop sound" stops it') });
  }, 60_000);

  // Review r1: a context the page started long before its tone was timed from the context's start. Pinned:
  // a press starts the page's context, and the test comes 2.3 s later, when the 2.5 s tone scheduled 2 s
  // into it is already sounding.
  it('a 2.5 s tone scheduled 2 s into a running context is timed from when it is first heard: passes', async () => {
    const late: PageProbe = {
      ...audioProbe,
      async run(ctx) {
        const page = ctx.page;
        await page.mouse!.click(5, 5);
        await page.waitForTimeout(2300);
        // And the analyser has filled before the first listen (a fresh one reads silence at first,
        // which would hide the case): that listen hears a tone already sounding.
        let first = true;
        const evaluate = async (fn: unknown, arg: unknown) => {
          if (typeof fn === 'function' && fn.name === 'soundClock' && first) { first = false; await page.waitForTimeout(200); }
          return page.evaluate(fn as (a: unknown) => unknown, arg);
        };
        const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
        return audioProbe.run({ ...ctx, page: pinned as typeof page });
      },
    };
    const runs = await site.run([late], ['audio-webaudio-late-tone.html'], { concurrency: 1 });
    expect(only(runs['audio-webaudio-late-tone.html']![0]!)).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
  }, 60_000);
});

// A sound that is quiet when the test comes back to it, before any control was clicked, did not stop
// because of one: the reason says what happened (the verdict is the probe's as before).
describe('audio probe: a sound that stops before any control was tried', () => {
  // Pinned: the looping player is paused just before the first check of whether it still plays.
  const stopsFirst: PageProbe = {
    ...audioProbe,
    async run(ctx) {
      const page = ctx.page;
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function' && fn.name === 'soundState' && first) {
          first = false;
          await page.evaluate(() => { for (const m of document.querySelectorAll('audio, video')) (m as HTMLMediaElement).pause(); }, undefined);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return audioProbe.run({ ...ctx, page: pinned as typeof page });
    },
  };

  it('RED (e2e): never "after a control tried earlier" when no control was clicked', async () => {
    const runs = await site.run([stopsFirst], ['audio-autoplay.html']);
    const f = runs['audio-autoplay.html']![0]!.findings.filter((x) => x.criterion === '1.4.2');
    expect(f.map((x) => x.status)).toEqual(['no_failures_found']);
    expect(f[0]!.detail).not.toMatch(/control tried earlier/);
    expect(f[0]!.detail).toMatch(/no longer playing when the test came back to it, before any control was tried$/);
  }, 90_000);

  it('after a control was really clicked (it stopped the first sound), a second sound it stopped too keeps "a control tried earlier"', async () => {
    const runs = await site.run([audioProbe], ['audio-two-one-stop.html']);
    const f = runs['audio-two-one-stop.html']![0]!.findings.filter((x) => x.criterion === '1.4.2');
    expect(f.map((x) => x.status)).toEqual(['no_failures_found', 'no_failures_found']);
    expect(f.map((x) => x.detail).join(' ')).toMatch(/after a control tried earlier/);
  }, 90_000);
});
