// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.2's proof in real Chromium (batch 18, the lead's ruling 12): a failure is filed only when the sound is
// measured, started by itself, lasts more than 3 s and nothing left could stop it. Look-alikes the earlier rules
// failed, and the failures that must stay, on test/fixtures/motion/audio-*.html (synthetic tones, our own files).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audioProbe } from '../../src/probes/audio.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import { motionSite, only, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => { await site?.close(); });

const PAGES = [
  'audio-switch.html', 'audio-icon.html', 'audio-oddname.html', 'audio-slider.html', 'audio-visualizer.html', 'audio-routed-silent.html',
  'audio-silent-file.html', 'audio-shadow-mute.html', 'audio-key.html', 'audio-routed.html', 'audio-autoplay.html', 'audio-webaudio.html',
  'audio-shadow-icon.html',
];

describe('audio probe: the proof of a failure (1.4.2)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => { runs = await site.run([audioProbe], PAGES, { concurrency: 4 }); }, 180_000);
  const f = (page: string) => only(runs[page]![0]!);
  const data = (page: string) => runs[page]![0]!.data as { sources?: { kind: string; others?: unknown[]; tried?: string[]; feeds?: number }[] } | undefined;

  it('tries a switch named for the sound, and credits it when the sound stops', () => {
    expect(f('audio-switch.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Background music" stops it') });
  });
  it('tries a Mute button inside a web component (and sees the autoplaying audio in its shadow root)', () => {
    expect(f('audio-shadow-mute.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Mute" stops it') });
  });
  it('never fails a sound while a control is left that could stop it', () => {
    expect(f('audio-icon.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('a control with no name, near the sound') });
    expect(f('audio-oddname.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('"♫ Music: on" (its name is about sound)') });
    expect(f('audio-slider.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('a slider near the sound') });
    expect(f('audio-key.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('the page says a key stops it') });
    expect(data('audio-icon.html')?.sources?.[0]?.others).toHaveLength(1);
    // A sound inside a web component is near what sits beside the component (the audio-proof lab's shadow cases).
    expect(f('audio-shadow-icon.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('a control with no name, near the sound') });
  });
  it('judges an element routed into Web Audio through its context, with the element\'s own controls', () => {
    expect(f('audio-visualizer.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('an audio player played through Web Audio') });
    expect(f('audio-visualizer.html').detail).toContain('its own player controls');
    expect(data('audio-visualizer.html')?.sources?.[0]?.feeds).toBe(1);
  });
  it('finds no sound when the routed element reaches no speaker', () => {
    expect(f('audio-routed-silent.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('no sound plays by itself') });
  });
  it('never assumes a playing audio element makes sound: a silent file is undecided, never failed', () => {
    expect(f('audio-silent-file.html')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('whether it has sound could not be told') });
  });
  it('still fails what is shown: a looping player, Web Audio, and a routed player with nothing to stop them', () => {
    expect(f('audio-autoplay.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing on the page pauses, stops or mutes it') });
    expect(f('audio-webaudio.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('sound made with Web Audio') });
    expect(f('audio-routed.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('an audio player played through Web Audio plays sound by itself') });
    expect(data('audio-autoplay.html')?.sources?.[0]).toMatchObject({ kind: 'media', others: [], tried: [] });
  });
});

describe('audio probe: started by a press, or ended before a control was tried', () => {
  it('a sound a click started is not judged as playing by itself', async () => {
    const pressFirst: PageProbe = {
      ...audioProbe,
      async run(ctx) { await ctx.page.mouse!.click(5, 5); await ctx.page.waitForTimeout(300); return audioProbe.run(ctx); },
    };
    const runs = await site.run([pressFirst], ['audio-click-started.html'], { concurrency: 1 });
    expect(only(runs['audio-click-started.html']![0]!)).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('it started when something on the page was pressed') });
  }, 60_000);

  // Pinned: the context is suspended just before the test comes back to it, as a tone that ends would be.
  it('a Web Audio sound that ends before any control was tried is not failed while a candidate was never clicked', async () => {
    const endsFirst: PageProbe = {
      ...audioProbe,
      async run(ctx) {
        const page = ctx.page;
        let first = true;
        const evaluate = async (fn: unknown, arg: unknown) => {
          if (typeof fn === 'function' && fn.name === 'soundState' && first) {
            first = false;
            await page.evaluate(() => (window as unknown as { ctx: AudioContext }).ctx.suspend(), undefined);
          }
          return page.evaluate(fn as (a: unknown) => unknown, arg);
        };
        const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
        return audioProbe.run({ ...ctx, page: pinned as typeof page });
      },
    };
    const runs = await site.run([endsFirst], ['audio-webaudio-mute.html'], { concurrency: 1 });
    const x = only(runs['audio-webaudio-mute.html']![0]!);
    expect(x).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('"Mute sound" (a control that may stop it, not tried before the sound ended)') });
  }, 60_000);
});
