// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.2: when a Web Audio sound started, when it counts as playing more than 3 s, and when a control is
// credited (docs/plans/2026-11-07-audio-motion-cases.md, A1-A11).
import { describe, expect, it } from 'vitest';
import { AUDIO_LIMIT_MS, WEB_AUDIO_TIMING, controlEffect, nextSoundClock, webAudioCounted, webAudioDeadline, type SoundClock } from '../../src/probes/audio.js';

const run = (samples: { audible: boolean; now: number; sourceStart?: number | null; warmingUp?: boolean }[]): SoundClock => {
  let c: SoundClock | undefined;
  for (const x of samples) c = nextSoundClock(c, x);
  return c!;
};

describe('when a Web Audio sound started', () => {
  it('from when its source was scheduled to start (A11: a tone already playing when the test arrives)', () => {
    expect(run([{ audible: true, now: 5000, sourceStart: 2000 }]).startAt).toBe(2000);
  });
  it('never before the last real silence heard (a source started silent and turned up later)', () => {
    expect(run([{ audible: false, now: 3000 }, { audible: true, now: 3250, sourceStart: 1000 }]).startAt).toBe(3000);
  });
  it('without a source record, from the first listen that hears it (A5: never from the context start)', () => {
    expect(run([{ audible: true, now: 1400 }]).startAt).toBe(1400);
    expect(run([{ audible: false, now: 1000 }, { audible: true, now: 1050 }]).startAt).toBe(1050);
  });
  it('a fresh analyser reading silence while it fills is not a silence', () => {
    expect(run([{ audible: false, now: 1000, warmingUp: true }, { audible: true, now: 1050, sourceStart: 200 }]).startAt).toBe(200);
  });
  it('a rest up to the quiet gap keeps the clock (A9: a bed with a 300 ms pause); a longer silence ends it', () => {
    expect(WEB_AUDIO_TIMING.quietGap).toBe(750);
    const bed = run([{ audible: true, now: 1000 }, { audible: false, now: 1250 }, { audible: false, now: 1500 }, { audible: true, now: 1750 }]);
    expect(bed.startAt).toBe(1000);
    const chime = run([{ audible: true, now: 1000 }, { audible: false, now: 1250 }, { audible: false, now: 1800 }]);
    expect(chime.startAt).toBeNull();
    expect(run([{ audible: true, now: 1000 }, { audible: false, now: 2000 }, { audible: true, now: 2100 }]).startAt).toBe(2100);
  });
});

describe('when it counts as playing more than 3 s', () => {
  it('heard 3 s and a margin after it started; a tone of exactly 3 s is not (A1)', () => {
    expect(AUDIO_LIMIT_MS).toBe(3000);
    expect(webAudioDeadline(1000)).toBe(4250);
    expect(webAudioCounted({ startAt: 1000, lastAudible: 4300, lastSilent: null })).toBe(true);
    expect(webAudioCounted({ startAt: 1000, lastAudible: 4000, lastSilent: 4260 })).toBe(false);
    expect(webAudioCounted({ startAt: null, lastAudible: 9000, lastSilent: null })).toBe(false);
  });
});

describe('whether a control stopped the sound', () => {
  it('still playing: no effect', () => {
    expect(controlEffect({ state: 'playing', clickActs: 2 })).toBe('none');
  });
  it('quiet, with a stop call made by the click itself: the control worked (A4, A10)', () => {
    expect(controlEffect({ state: 'stopped', clickActs: 1 })).toBe('worked');
    expect(controlEffect({ state: 'ended', clickActs: 1 })).toBe('worked');
  });
  it('quiet with no stop call from the click: it stopped on its own, also when the page suspended or stopped it from a timer or onended (A3, A6, A7, A8)', () => {
    expect(controlEffect({ state: 'stopped', clickActs: 0 })).toBe('ended');
    expect(controlEffect({ state: 'ended', clickActs: 0 })).toBe('ended');
  });
  it('the click could not be read: cannot be told', () => {
    expect(controlEffect({ state: 'ended', clickActs: null })).toBe('unknown');
  });
});
