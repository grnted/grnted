// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 4.1.2 for a toggle's state while the page is used (the live announcement test), in real Chromium: a pressed
// state that goes stale, a collapsed state that goes stale, and a disclosure that never says whether it is open.
// Fixtures: test/fixtures/live-toggles/ (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { screenReaderLiveProbe, toggleVerdict, type ToggleState } from '../../src/probes/screenReader/index.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const findings: Record<string, ProbeFinding[]> = {};

beforeAll(async () => {
  site = await startFixtureServer('live-toggles');
  browser = await chromium.launch();
  const runs = await runProbes(browser as unknown as BrowserLike, ['stale.html', 'nostate.html', 'clean.html', 'clean2.html', 'many.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [screenReaderLiveProbe], { userAgent: 'grnted-test', concurrency: 2 });
  for (const r of runs) findings[new URL(r.page).pathname.slice(1)] = r.findings.filter((f) => f.criterion === '4.1.2');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe('4.1.2: a toggle whose state the page does not keep', () => {
  it('fails a toggle button that switches on and off while aria-pressed stays "false"', () => {
    const f = findings['stale.html']!.find((x) => x.target === '#save');
    expect(f).toMatchObject({ status: 'failed', detail: expect.stringContaining('tells screen readers “not pressed” the whole time') });
    expect(f!.detail).toContain('the button itself changes how it looks');
  });

  it('fails a collapsed button that shows the block after it and still says collapsed, with or without aria-controls, also a type="button" in a form', () => {
    for (const id of ['#more', '#help']) {
      expect(findings['stale.html']!.find((x) => x.target === id), id).toMatchObject({ status: 'failed', detail: expect.stringContaining('still tells screen readers it is collapsed') });
    }
  });

  it('fails a button that shows and hides a block and never says whether it is open', () => {
    const f = findings['nostate.html']!.filter((x) => x.status === 'failed');
    expect(f.map((x) => x.target).sort()).toEqual(['#dates', '#gear']);
    expect(f[0]!.detail).toContain('never tells screen readers whether it is open');
  });

  it('presses one toggle of each make first, the main content\'s before the menu\'s, so a menu of six openers does not use up every press', () => {
    expect(findings['many.html']!.filter((x) => x.status === 'failed').map((x) => x.target)).toEqual(['#late']);
  });

  it('look-alikes stay clean: toggles that keep their state, a name that says the state, a one-way reveal', () => {
    expect(findings['clean.html']!.filter((x) => x.status === 'failed')).toEqual([]);
  });

  it('look-alikes stay clean: a dialog, a panel that takes focus, a status message, a submit button', () => {
    expect(findings['clean2.html']!.filter((x) => x.status === 'failed')).toEqual([]);
  });
});

describe('toggleVerdict', () => {
  const s = (o: Partial<ToggleState>): ToggleState => ({ ok: true, expanded: null, pressed: null, other: false, name: 'Dates', focused: true, panel: true, panelShown: false, panelOther: false, around: 'a', own: 'a', ...o });
  it('needs the round trip: shown, then hidden again, for a button with no state', () => {
    expect(toggleVerdict('bare', s({}), s({ panelShown: true }), s({}))).toBe('no-state');
    expect(toggleVerdict('bare', s({}), s({ panelShown: true }), s({ panelShown: true }))).toBeNull();
    expect(toggleVerdict('bare', s({}), s({ panelShown: true }), null)).toBeNull();
    // A state that appears with the press, a name that changes, focus that moves away, a dialog: not this failure.
    expect(toggleVerdict('bare', s({}), s({ panelShown: true, expanded: 'true' }), s({ expanded: 'false' }))).toBeNull();
    expect(toggleVerdict('bare', s({}), s({ panelShown: true, name: 'Hide dates' }), s({}))).toBeNull();
    expect(toggleVerdict('bare', s({}), s({ panelShown: true, focused: false }), s({}))).toBeNull();
    expect(toggleVerdict('bare', s({ panelOther: true }), s({ panelShown: true, panelOther: true }), s({ panelOther: true }))).toBeNull();
  });
  it('a name that changes with the press says the state, and a name the browser did not give proves nothing', () => {
    // "Mute" / "Unmute": the button pattern's other way to say the state.
    expect(toggleVerdict('bare', s({ name: 'Mute' }), s({ name: 'Unmute', panelShown: true }), s({ name: 'Mute' }))).toBeNull();
    expect(toggleVerdict('pressed', s({ pressed: 'false', name: 'Mute' }), s({ pressed: 'false', name: 'Unmute', around: 'b' }), s({ pressed: 'false', name: 'Mute' }))).toBeNull();
    expect(toggleVerdict('expanded', s({ expanded: 'false', name: 'Show details' }), s({ expanded: 'false', name: 'Hide details', panelShown: true }), null)).toBeNull();
    // No name from the accessibility tree: not judged.
    expect(toggleVerdict('bare', s({ name: undefined }), s({ name: undefined, panelShown: true }), s({ name: undefined }))).toBeNull();
    expect(toggleVerdict('expanded', s({ expanded: 'false', name: undefined }), s({ expanded: 'false', name: undefined, panelShown: true }), null)).toBeNull();
    // An empty name read both times is a name that stays the same.
    expect(toggleVerdict('bare', s({ name: '' }), s({ name: '', panelShown: true }), s({ name: '' }))).toBe('no-state');
  });
  it('a pressed toggle fails only when the button itself looks switched on and back off while it says "false"', () => {
    const off = s({ pressed: 'false' });
    // Its own look changes with the first press and changes back with the second: it shows a state it does not tell.
    expect(toggleVerdict('pressed', off, s({ pressed: 'false', own: 'b', around: 'b' }), off)).toBe('stale-pressed');
    expect(toggleVerdict('pressed', off, s({ pressed: 'true', own: 'b', around: 'b' }), off)).toBeNull();
    expect(toggleVerdict('pressed', off, s({ pressed: 'false', own: 'b', around: 'b' }), s({ pressed: 'false', own: 'c', around: 'c' }))).toBeNull();
    expect(toggleVerdict('pressed', off, off, null)).toBeNull();
    // The button's look changed because focus left it (the press moved focus to a note) and came back: no state of its own.
    expect(toggleVerdict('pressed', off, s({ pressed: 'false', own: 'b', around: 'b', focused: false }), off)).toBe('maybe-pressed');
    // Only what is next to it changes (a note, a counter, a message that it could not be switched on): the
    // button may be right to say "not pressed". A candidate, never a failure.
    expect(toggleVerdict('pressed', off, s({ pressed: 'false', around: 'b' }), off)).toBe('maybe-pressed');
    expect(toggleVerdict('pressed', off, s({ pressed: 'false', around: 'b' }), s({ pressed: 'false', around: 'c' }))).toBeNull();
  });
  it('a note that shows next to a toggle button that stays off is not a stale state: undecided, never failed', () => {
    const f = findings['stale.html']!.filter((x) => x.target === '#later');
    expect(f.map((x) => x.status)).toEqual(['not_testable']);
    expect(f[0]!.detail).toContain('could not be told');
  });
});
