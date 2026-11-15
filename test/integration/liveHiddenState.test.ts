// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 4.1.2, batch 17 (structure lane): a toggle button whose state the page shows only to sighted people. The button
// says it is a toggle (aria-pressed) and "not pressed" before and after every press; a press puts words beside it
// ("✓ Included") and the next press takes them away; and those words are hidden from assistive technology
// (aria-hidden), so nothing a screen reader is given changes. Before, this was undecided with every other change
// "next to the button" (it may be a note); a note is text a screen reader can read. Real Chromium.
// Fixtures: test/fixtures/live-toggles/hidden-state.html and hidden-state-clean.html (written for this test).
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { screenReaderLiveProbe, toggleVerdict, type ToggleState } from '../../src/probes/screenReader/index.js';
import { shownByPress } from '../../src/probes/screenReader/live.js';
import type { ProbeFinding } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let site: Awaited<ReturnType<typeof startFixtureServer>>;
const findings: Record<string, ProbeFinding[]> = {};

beforeAll(async () => {
  site = await startFixtureServer('live-toggles');
  browser = await chromium.launch();
  const runs = await runProbes(browser as unknown as BrowserLike, ['hidden-state.html', 'hidden-state-clean.html', 'hidden-state-server.html', 'hidden-state-ax.html', 'hidden-state-load.html'].map((p, index) => ({ url: `${site.origin}/${p}`, index })), [screenReaderLiveProbe], { userAgent: 'grnted-test', concurrency: 2 });
  for (const r of runs) findings[new URL(r.page).pathname.slice(1)] = r.findings.filter((f) => f.criterion === '4.1.2');
}, 120_000);

afterAll(async () => {
  await browser?.close();
  await site?.close();
});

describe('4.1.2: a toggle whose state is shown only in text hidden from assistive technology', () => {
  it('fails the toggle that shows "✓ Included" beside it, hidden from screen readers, while it says "not pressed" throughout', () => {
    const f = findings['hidden-state.html']!.filter((x) => x.target === '#check');
    expect(f.map((x) => x.status)).toEqual(['failed']);
    expect(f[0]!.detail).toBe('Pressing the button “Include this page in my visit checklist” shows “✓ Included” next to it and pressing it again takes that away, so the page shows whether it is switched on; but that text is hidden from screen readers (aria-hidden or inert), and the button tells them “not pressed” the whole time (aria-pressed stays "false")');
  });

  it('look-alikes stay undecided, never failed: the same words in text a screen reader can read, with the state also written for screen readers, or announced in a status region', () => {
    for (const id of ['#note', '#sr', '#live']) {
      const f = findings['hidden-state.html']!.filter((x) => x.target === id);
      expect(f.map((x) => x.status), id).toEqual(['not_testable']);
      expect(f[0]!.detail, id).toContain('could not be told');
    }
  });

  it('look-alikes stay clean: a toggle that keeps its state beside the same hidden mark, a flourish a timer removes, words that say the state', () => {
    expect(findings['hidden-state-clean.html']!.filter((x) => (x.status === 'failed' || x.status === 'not_testable') && x.target !== '#blink')).toEqual([]);
  });

  it('look-alike: a press that asks the server to store the choice, and tells its state when the server answers, is undecided (the test never sends it)', () => {
    for (const id of ['#save', '#pin']) {
      const f = findings['hidden-state-server.html']!.filter((x) => x.target === id);
      expect(f.map((x) => x.status), id).toEqual(['not_testable']);
      expect(f[0]!.detail, id).toMatch(/was pressed the page asked the site for something, which the test never sends for a visitor; the button tells screen readers “not pressed” without the answer, and whether it tells its state once the site answers could not be checked$/);
    }
  });

  it('look-alike: a hidden label that blinks by itself beside a toggle is never its state (undecided at most, never failed)', () => {
    expect(findings['hidden-state-clean.html']!.filter((x) => x.target === '#blink' && x.status === 'failed')).toEqual([]);
  });

  // Sol review of batch 17, S4: what assistive technology is given is read from the accessibility tree, not from a walk
  // of text nodes. A press that tells the state through an image's text alternative, a role="img" label or text in a
  // shadow root changes what is told: undecided, never the hidden state.
  it('Sol S4 look-alikes: the state also told by an image\'s alt, a role="img" label or shadow text is undecided; the plain hidden mark beside them still fails', () => {
    for (const id of ['#alt', '#label', '#shadow']) {
      const f = findings['hidden-state-ax.html']!.filter((x) => x.target === id);
      expect(f.map((x) => x.status), id).toEqual(['not_testable']);
      expect(f[0]!.detail, id).toContain('could not be told');
    }
    expect(findings['hidden-state-ax.html']!.filter((x) => x.target === '#check').map((x) => x.status)).toEqual(['failed']);
  });

  // Sol review of batch 17, S5: a picture or a style sheet the press loads has a load event a script can write the
  // state in; the test refused it, so what the button says without it proves nothing.
  it('Sol S5 look-alikes: a press that loads a picture or a style sheet (refused by the test) whose load writes the state is undecided; the plain hidden mark beside them still fails', () => {
    for (const id of ['#img', '#css']) {
      const f = findings['hidden-state-load.html']!.filter((x) => x.target === id);
      expect(f.map((x) => x.status), id).toEqual(['not_testable']);
      expect(f[0]!.detail, id).toMatch(/was pressed the page asked the site for something, which the test never sends for a visitor/);
    }
    expect(findings['hidden-state-load.html']!.filter((x) => x.target === '#check').map((x) => x.status)).toEqual(['failed']);
  });
});

describe('toggleVerdict: the hidden state', () => {
  // (`told`: what the accessibility tree gives around the button, content and states; `toldText`: its content.)
  const s = (o: Partial<ToggleState>): ToggleState => ({ ok: true, expanded: null, pressed: 'false', other: false, name: 'Include', focused: true, panel: false, panelShown: false, panelOther: false, around: 'a', own: 'a', seen: '', told: '', toldText: '', ...o });
  it('needs words that show and go with the presses while nothing told changes', () => {
    expect(toggleVerdict('pressed', s({}), s({ around: 'b', seen: '✓ Included' }), s({}))).toBe('hidden-state');
    // What is told changes too (a note a screen reader can read): the old candidate.
    expect(toggleVerdict('pressed', s({}), s({ around: 'b', seen: '✓ Included', told: '✓ Included' }), s({}))).toBe('maybe-pressed');
    // The words stay after the second press, or nothing is seen to change: not this.
    expect(toggleVerdict('pressed', s({}), s({ around: 'b', seen: '✓ Included' }), s({ around: 'b', seen: '✓ Included' }))).toBeNull();
    expect(toggleVerdict('pressed', s({}), s({ around: 'b' }), s({}))).toBe('maybe-pressed');
    // Words that go away with the press (nothing new is shown) are no "on" state shown.
    expect(toggleVerdict('pressed', s({ seen: 'Not included' }), s({ around: 'b', seen: '' }), s({ seen: 'Not included' }))).toBe('maybe-pressed');
    // A state the button tells (aria-pressed follows), a name that changes, a state read before this field existed.
    expect(toggleVerdict('pressed', s({}), s({ pressed: 'true', around: 'b', seen: '✓ Included' }), s({}))).toBeNull();
    expect(toggleVerdict('pressed', s({}), s({ name: 'Remove', around: 'b', seen: '✓ Included' }), s({}))).toBeNull();
    // A button with a description of its own (aria-describedby) may be told from there: the old candidate.
    expect(toggleVerdict('pressed', s({ described: true }), s({ described: true, around: 'b', seen: '✓ Included' }), s({ described: true }))).toBe('maybe-pressed');
    // Words that are in the page for screen readers all the time and only become visible with the press are not hidden from them.
    expect(toggleVerdict('pressed', s({ told: '✓ Included', toldText: '✓ Included' }), s({ around: 'b', seen: '✓ Included', told: '✓ Included', toldText: '✓ Included' }), s({ told: '✓ Included', toldText: '✓ Included' }))).toBe('maybe-pressed');
    // Sol S4: what is told could not be read from the accessibility tree at one of the three reads: not concluded.
    const unread = (o: Partial<ToggleState>) => { const x = s(o); delete x.told; delete x.toldText; return x; };
    expect(toggleVerdict('pressed', s({}), unread({ around: 'b', seen: '✓ Included' }), s({}))).toBe('maybe-pressed');
    expect(toggleVerdict('pressed', unread({}), s({ around: 'b', seen: '✓ Included' }), s({}))).toBe('maybe-pressed');
    expect(toggleVerdict('pressed', s({}), s({ around: 'b', seen: '✓ Included' }), unread({}))).toBe('maybe-pressed');
    // More text around the button than the test compares: what is seen and what is told were not read to the end.
    expect(toggleVerdict('pressed', s({}), s({ around: 'b', seen: '✓ Included', cut: true }), s({}))).toBe('maybe-pressed');
    const old = (o: Partial<ToggleState>) => { const x = s(o); delete x.seen; delete x.told; return x; };
    expect(toggleVerdict('pressed', old({}), old({ around: 'b' }), old({}))).toBe('maybe-pressed');
  });
  it('the button itself switching on with focus on it is still the stale pressed state', () => {
    expect(toggleVerdict('pressed', s({}), s({ own: 'b', around: 'b', seen: '✓ Included' }), s({}))).toBe('stale-pressed');
  });
  it('shownByPress names the words a press put on the screen', () => {
    expect(shownByPress('Hours Monday to Friday', 'Hours ✓ Included Monday to Friday')).toBe('✓ Included');
    expect(shownByPress('', '')).toBe('');
    expect(shownByPress('Included', 'Included')).toBe('');
  });
});
