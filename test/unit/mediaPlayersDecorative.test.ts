// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-player test's background-video exemption (1.2.3, 1.2.5 skipped) uses the same narrow rule as the
// video and audio inventory (collect/media.ts): aria-hidden="true" or role presentation/none on the video
// itself, muted, looping, no controls. Any other muted video without controls is judged (review round 2 of
// fix/deny-guard: it skipped every muted video without controls).
import { describe, expect, it } from 'vitest';
import { nativeVideoDecorative } from '../../src/probes/mediaPlayers.js';

const v = { muted: true, controls: false, loop: true, hiddenSelf: true };

describe('a background video, by its own markup', () => {
  it('muted, looping, no controls and hidden from assistive technology on the video itself: decoration', () => {
    expect(nativeVideoDecorative(v)).toBe(true);
  });
  it('anything less is judged as any video: not hidden on itself, not looping, with sound, or with controls', () => {
    expect(nativeVideoDecorative({ ...v, hiddenSelf: false })).toBe(false);
    expect(nativeVideoDecorative({ ...v, loop: false })).toBe(false);
    expect(nativeVideoDecorative({ ...v, muted: false })).toBe(false);
    expect(nativeVideoDecorative({ ...v, controls: true })).toBe(false);
  });
});
