// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A time limit on what a visitor enters (src/probes/timingEntry.ts): the verdict, pure.
import { describe, expect, it } from 'vitest';
import { ENTRY_ADJUST, ENTRY_EXCEPTION, ENTRY_EXTEND, ENTRY_OFF, entryFindings, isExtendName, type EntryControl, type EntryLimit } from '../../src/probes/timingEntry.js';

const limit = (over: Partial<EntryLimit> = {}): EntryLimit => ({ start: 'press', press: 'Start', ms: 40_000, effect: 'cleared', field: 'Your message', path: '#note', ...over });
const info = { fields: 1, ran: 3, pressed: 1 };
const status = (l: EntryLimit | null, c: EntryControl[] = [], i: { fields: number; ran: number; pressed: number; incomplete?: boolean } = info) => entryFindings(l, c, i).map((f) => f.status);

describe('the verdict', () => {
  it('no field: not applicable; no limit: no failures found; a limit with nothing to turn it off, adjust or extend it: failed', () => {
    expect(status(null, [], { fields: 0, ran: 0, pressed: 0 })).toEqual(['not_applicable']);
    expect(status(null)).toEqual(['no_failures_found']);
    const f = entryFindings(limit({ start: 'load', ms: 30_000, effect: 'locked' }), [], info)[0]!;
    expect([f.status, f.target, f.detail]).toEqual(['failed', '#note', '30 s after the page loads, the page locks “Your message”; nothing on the page turns this time limit off, adjusts it or extends it']);
  });
  it('a way to turn the limit off is enough, also as a "no limit" choice in a list of durations', () => {
    expect(status(limit(), [{ name: 'No time limit', kind: 'off' }])).toEqual(['no_failures_found']);
    expect(status(limit(), [{ name: 'Time limit', kind: 'adjust', options: [40_000, 80_000], chosen: 40_000, none: true }])).toEqual(['no_failures_found']);
  });
  it('extend: 20 seconds or more to press it is enough; less fails; a countdown read tick by tick gets two ticks of slack', () => {
    const extend: EntryControl[] = [{ name: 'Extend', kind: 'extend' }];
    expect(status(limit(), extend)).toEqual(['no_failures_found']);
    expect(status(limit({ warning: { text: 'Extend', leavesMs: 20_000 } }), extend)).toEqual(['no_failures_found']);
    expect(status(limit({ warning: { text: 'Extend', leavesMs: 19_000 } }), extend)).toEqual(['failed']);
    expect(status(limit({ warning: { text: 'Extend', leavesMs: 19_000, slackMs: 2000 } }), extend)).toEqual(['no_failures_found']);
    expect(status(limit({ warning: { text: 'Extend', leavesMs: 10_000, slackMs: 2000 } }), extend)).toEqual(['failed']);
  });
  it('adjust: ten times the default is enough; nine times fails; a short warning with a wide range still passes', () => {
    const range = (max: number): EntryControl[] => [{ name: 'Time limit', kind: 'adjust', options: [40_000, max], chosen: 40_000 }];
    expect(status(limit(), range(400_000))).toEqual(['no_failures_found']);
    expect(status(limit(), range(360_000))).toEqual(['failed']);
    expect(entryFindings(limit(), range(360_000), info)[0]!.detail).toContain('to at most 6 min, 9 times the default 40 s');
    expect(status(limit({ warning: { text: 'Extend', leavesMs: 5000 } }), [{ name: 'Extend', kind: 'extend' }, ...range(400_000)])).toEqual(['no_failures_found']);
  });
});

describe('what the test cannot tell (review r1, findings 4 and 13)', () => {
  it('a sign that the limit may be real-time or essential: not testable where it would have failed, unchanged where the page offers a way', () => {
    const f = entryFindings(limit({ exception: 'Live auction' }), [], info)[0]!;
    expect(f.status).toBe('not_testable');
    expect(f.detail).toContain('the page says “Live auction”');
    expect(status(limit({ exception: 'quiz' }), [{ name: 'No time limit', kind: 'off' }])).toEqual(['no_failures_found']);
    expect(status(limit({ exception: 'quiz', warning: { text: 'Extend', leavesMs: 5000 } }), [{ name: 'Extend', kind: 'extend' }])).toEqual(['not_testable']);
  });
  it('the signs: auctions and bids, exams and tests, live events, typing speed, "timed"; ordinary words are none', () => {
    const re = new RegExp(ENTRY_EXCEPTION, 'i');
    for (const t of ['Live auction: lot 14', 'Place your bid', 'Final exam', 'Chapter quiz', 'Practice test', 'Skills assessment', 'Typing speed', 'Timed entry', 'Live event tonight', 'Real-time bidding']) expect(re.test(t), t).toBe(true);
    for (const t of ['Picnic shelter request', 'Contest rules', 'Latest news', 'Sometimes', 'Deliver to my address', 'Request an estimate']) expect(re.test(t), t).toBe(false);
  });
  it('timers that could not all be run: not testable, never "none of them took the text"; a limit found still stands', () => {
    const f = entryFindings(null, [], { ...info, incomplete: true })[0]!;
    expect([f.status, f.detail]).toEqual(['not_testable', 'the page\'s timers could not be run to the end (3 timer runs were made, and a timer here fires faster than the test can follow), so a time limit set for later could not be ruled out']);
    expect(status(limit(), [], { ...info, incomplete: true })).toEqual(['failed']);
  });
});

describe('names of controls', () => {
  it('turn off, extend and adjust by name; look-alikes are not', () => {
    for (const n of ['No time limit', 'Turn off the timer', 'Disable timeout', 'Never expire']) expect(new RegExp(ENTRY_OFF, 'i').test(n), n).toBe(true);
    for (const n of ['No limit on guests', 'Turn off notifications', 'Time zone']) expect(new RegExp(ENTRY_OFF, 'i').test(n), n).toBe(false);
    for (const n of ['Extend', 'Extend my session', 'I need more time', 'Add 5 more minutes', 'Stay signed in', 'Keep working']) expect(new RegExp(ENTRY_EXTEND, 'i').test(n), n).toBe(true);
    for (const n of ['Extended hours', 'Extension office', 'Time and place', 'Keep reading']) expect(new RegExp(ENTRY_EXTEND, 'i').test(n), n).toBe(false);
    for (const n of ['Time limit', 'Draft time out', 'Session length', 'Expires after']) expect(new RegExp(ENTRY_ADJUST, 'i').test(n), n).toBe(true);
    expect(new RegExp(ENTRY_ADJUST, 'i').test('Delivery slot')).toBe(false);
  });
  it('a button that came with a warning and only says to go on is its way to extend', () => {
    for (const n of ['Continue', 'Yes', 'Stay signed in', "I'm still here", 'More time']) expect(isExtendName(n), n).toBe(true);
    for (const n of ['Close', 'OK', 'Log out', 'Start a new request', 'Time', 'The']) expect(isExtendName(n), n).toBe(false);
  });
});
