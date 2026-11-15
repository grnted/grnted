// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The deep media test quotes the page's transcript (and an audio-described version's link) whole: whole
// sentences under the length cap, an ellipsis only when something was cut, never a sentence broken off.
import { describe, expect, it } from 'vitest';
import { judgeNativeVideo, quoteSentences } from '../../src/media/players.js';

const video = { target: 'https://e.org/v.webm', src: 'https://e.org/v.webm', tracks: [{ kind: 'captions' }], textTracks: 1, duration: 12, decorative: false };
const detail = (transcript: string) => judgeNativeVideo(video, { transcript }).find((x) => x.criterion === '1.2.3')!.detail;

describe('quoting a transcript', () => {
  it('quotes a short one whole, with no ellipsis', () => {
    expect(detail('Transcript: Welcome to Fernwood School. The office opens at 8:00.'))
      .toBe('a transcript is linked next to it ("Transcript: Welcome to Fernwood School. The office opens at 8:00."), a text alternative for the video.');
  });

  it('cuts a long one at a sentence boundary under the cap, with an ellipsis because something was cut', () => {
    const t = 'Transcript: Welcome to Fernwood School. The office opens at 8:00 every school day. Families can call the front desk with questions.';
    // The first two sentences take 82 characters: only the first fits under 80.
    expect(quoteSentences(t, 80)).toBe('Transcript: Welcome to Fernwood School.…');
    expect(quoteSentences(t, 90)).toBe('Transcript: Welcome to Fernwood School. The office opens at 8:00 every school day.…');
    expect(detail(t)).toContain('("Transcript: Welcome to Fernwood School.…")');
  });

  it('a first sentence longer than the cap is cut at a word, never mid-word', () => {
    const q = quoteSentences(`Transcript: ${'welcome '.repeat(20)}end.`, 40);
    expect(q.length).toBeLessThanOrEqual(40);
    expect(q).toMatch(/ welcome…$|^Transcript: (welcome ?)+…$/);
    expect(q).not.toMatch(/welco…|welcom…/);
  });

  it('is linear on hostile input', () => {
    const t0 = Date.now();
    expect(quoteSentences('a. '.repeat(200_000), 80).length).toBeLessThanOrEqual(80);
    expect(quoteSentences('x'.repeat(500_000), 80).length).toBeLessThanOrEqual(80);
    expect(Date.now() - t0).toBeLessThan(1000);
  });
});
