// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.2's proof (batch 18, the lead's ruling 12): a failure needs every link shown; what is left over says why not.
import { describe, expect, it } from 'vitest';
import { AUDIO_TRIES, SOUND_TOGGLES, unprovenReason } from '../../src/probes/audio.js';

describe('unprovenReason', () => {
  it('is null when nothing is left that could stop the sound', () => {
    expect(unprovenReason({ others: [], more: false, held: 0 })).toBeNull();
  });
  it('names the controls the test did not try, at most three, and counts the rest', () => {
    const others = [
      { name: 'Background music', why: 'a switch that may turn the sound off' },
      { name: 'svg', why: 'a control with no name, near the sound or in a bar of the page' },
      { name: 'Level', why: 'a slider near the sound or in a bar of the page' },
      { name: '♫ Music: on', why: 'its name is about sound' },
    ];
    const why = unprovenReason({ others, more: false, held: 0 })!;
    expect(why).toMatch(/^controls the test did not try may stop it: "Background music" \(a switch that may turn the sound off\), "svg" .*"Level" .* and 1 more, so whether nothing stops it could not be told$/);
  });
  it('says when more candidates are left than the test tries', () => {
    expect(unprovenReason({ others: [], more: true, held: 0 })).toContain(`than the test tries (${AUDIO_TRIES})`);
  });
  it('puts the held timers first: a timer of the page that would stop it could not run', () => {
    expect(unprovenReason({ others: [{ name: 'x', why: 'y' }], more: true, held: 2 })).toMatch(/^an earlier test was holding 2 of the page's timers/);
    expect(unprovenReason({ others: [], more: false, held: 1 })).toMatch(/^an earlier test was holding one of the page's timers/);
  });
  it('tries switches named for sound', () => {
    for (const w of ['sound', 'audio', 'music', 'mute', 'volume']) expect(SOUND_TOGGLES).toContain(w);
  });
});
