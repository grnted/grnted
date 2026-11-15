// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The timing test's warning words (batch 17, motion-pointer): "your session ends in 2 minutes" is a warning that a time
// limit will run out (it was missed, so the warning's OK button was never looked at and the limit failed outright);
// a meeting's or a sale's end is no warning about the visitor's session.
import { describe, expect, it } from 'vitest';
import { isTimeWarning } from '../../src/probes/timing.js';

describe('isTimeWarning', () => {
  it.each([
    'For your security, your session ends in 2 minutes.',
    'Your session will end in 5 minutes.',
    'Your sign-in closes in 90 seconds.',
  ])('RED: %s is a warning', (text) => {
    expect(isTimeWarning(text)).toBe(true);
  });
  it.each([
    'The board meeting ends at 9 pm.',
    'The sale ends in 2 days.',
    'Registration for the summer session ends Friday.',
  ])('(guard) %s is no warning', (text) => {
    expect(isTimeWarning(text)).toBe(false);
  });
});
