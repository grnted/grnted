// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The controls test's decisions (src/probes/controls/rules.ts): pure functions, no browser.
import { describe, expect, it } from 'vitest';
import type { ControlCandidate, Effect, Message } from '../../src/probes/controls/page.js';
import {
  clickDid, controlsFindings, DISCLOSURE_NAME, effectWords, changeOwner, keyDid, operationFinding, STATUS_TEXT, unannounced,
  type ControlResult, sameEffect, shortcutKeys, shortcutPlan,
} from '../../src/probes/controls/rules.js';
import type { GuardEvent } from '../../src/probes/types.js';

const effect = (e: Partial<Effect> = {}): Effect => ({ changed: false, shown: 0, hidden: 0, values: 0, direct: false, timeouts: 0, intervals: 0, ...e });
const cand = (c: Partial<ControlCandidate> = {}): ControlCandidate => ({ i: 0, path: '#x', name: 'Save', tag: 'div', kind: 'custom', tabbable: true, focusable: true, types: ['pointerup'], pointerOnly: true, ...c });
const ev = (e: Partial<GuardEvent>): GuardEvent => ({ kind: 'blocked', at: 1, ...e });
const message = (m: Partial<Message> = {}): Message => ({ id: 0, path: '#m', text: 'Saved.', live: false, focus: false, appeared: false, status: true, ofOpened: false, ...m });
const result = (r: Partial<ControlResult> = {}): ControlResult => ({ candidate: cand(), operation: { kind: 'none' }, looked: false, status: [], announced: 0, after: [], openedControls: false, focusJudged: false, trapJudged: false, ...r });

describe('what a press did', () => {
  it('a key press counts for anything at all: a change, a request the guard stopped, a navigation', () => {
    expect(keyDid(effect(), [])).toBeNull();
    expect(keyDid(effect({ changed: true, shown: 1, text: 'Hours' }), [])).toEqual({ what: 'shows “Hours”', page: true });
    expect(keyDid(effect(), [ev({ kind: 'blocked', reason: 'data', url: 'https://a.example/api' })])).toEqual({ what: 'starts a request', page: false });
    expect(keyDid(effect(), [ev({ kind: 'navigation', url: 'https://a.example/next' })])).toEqual({ what: 'goes to https://a.example/next', url: 'https://a.example/next', page: false });
    expect(keyDid(effect({ changed: true, focus: { path: '#h', name: 'Next step' } }), [])).toEqual({ what: 'moves keyboard focus to “Next step”', page: true });
  });

  it('a click counts only for something a person would notice: never a blocked request alone, never focus that only moved', () => {
    expect(clickDid(effect(), [ev({ kind: 'blocked', reason: 'data', url: 'https://a.example/poll' })])).toBeNull();
    expect(clickDid(effect({ changed: true, focus: { path: '#h', name: 'Next step' } }), [])).toBeNull();
    expect(clickDid(effect(), [ev({ kind: 'blocked', cause: 'background', url: 'https://stats.example/c' })])).toBeNull();
    expect(clickDid(effect({ changed: true, own: 'its state changes' }), [])).toEqual({ what: 'its state changes', page: true });
    expect(clickDid(effect({ changed: true, hidden: 2 }), [])).toEqual({ what: 'hides 2 pieces of content', page: true });
    expect(clickDid(effect(), [ev({ kind: 'navigation', url: 'https://a.example/p' })])).toEqual({ what: 'goes to https://a.example/p', url: 'https://a.example/p', page: false });
    expect(clickDid(effect(), [ev({ kind: 'dialog', dialog: 'confirm' })])).toEqual({ what: 'opens a browser confirm dialog', page: false });
  });

  it('says what changed in words', () => {
    expect(effectWords(effect({ textChange: { from: '12 stops', to: '3 stops' } }))).toBe('changes “12 stops” to “3 stops”');
    expect(effectWords(effect({ textChange: { from: '', to: 'Saved.' } }))).toBe('shows “Saved.”');
    expect(effectWords(effect({ values: 1 }))).toBe('changes the value of a form field');
    expect(effectWords(effect({ url: 'https://a.example/#map' }))).toBe('changes the address to https://a.example/#map');
  });
});

describe('whose change it is', () => {
  it('the press\'s own events made it: the press did it, whatever else the page does', () => {
    expect(changeOwner(effect({ direct: true, timeouts: 2, intervals: 1 }))).toBe('press');
  });
  it('a one-off timer ran in the same moment: unknown', () => {
    expect(changeOwner(effect({ timeouts: 1 }))).toBe('unknown');
  });
  it('anything else is settled by watching the page and comparing again', () => {
    expect(changeOwner(effect())).toBe('watch');
    expect(changeOwner(effect({ intervals: 2 }))).toBe('watch');
  });
});

describe('2.1.1 findings', () => {
  it('only a click that did something while no key did is a failure', () => {
    const did = { what: 'shows “Hours”', page: true };
    expect(operationFinding(cand(), { kind: 'keys', key: 'Enter', did })).toBeNull();
    expect(operationFinding(cand(), { kind: 'none' })).toBeNull();
    expect(operationFinding(cand(), { kind: 'equivalent', did, how: 'a link with the same address' })).toBeNull();
    expect(operationFinding(cand(), { kind: 'unmeasured', reason: 'covered' })).toBeNull();
    expect(operationFinding(cand(), { kind: 'pointer-only', did })).toEqual({
      criterion: '2.1.1', status: 'failed', target: '#x',
      detail: '“Save” (#x) takes keyboard focus, but Enter and Space do nothing on it, while a mouse click shows “Hours”: it cannot be used with the keyboard.',
    });
  });

  // The lead's cut (batch 17, 2026-11-13): what the page's own timers wrote in the click's window is never the click's.
  it('a click whose window only the page\'s own timers wrote in is not testable, never failed, and still counts as pressed', () => {
    expect(operationFinding(cand(), { kind: 'self' })).toEqual({
      criterion: '2.1.1', status: 'not_testable', target: '#x',
      detail: 'What a mouse click on “Save” (#x) does could not be told: the page changed by itself during the click; the change can\'t be credited to the click.',
    });
    const f = controlsFindings([result({ operation: { kind: 'self' } })], { more: 0, refused: 0, skipped: 0 }).filter((x) => x.criterion === '2.1.1');
    expect(f.map((x) => x.status)).toEqual(['not_testable']);
    // Beside a real failure on the page, the failure stands alone.
    const both = controlsFindings([result({ operation: { kind: 'self' } }), result({ candidate: cand({ path: '#y' }), operation: { kind: 'pointer-only', did: { what: 'shows “Hours”', page: true } } })], { more: 0, refused: 0, skipped: 0 }).filter((x) => x.criterion === '2.1.1');
    expect(both.map((x) => [x.status, x.target])).toEqual([['failed', '#y']]);
  });
});

// Review r1, finding 6 (Understanding 2.1.1: any key, and any other way to the same function, will do).
describe('2.1.1: the keys a control names for itself', () => {
  const keys = (aria = '', access = '', ...texts: string[]) => shortcutKeys({ aria, access, texts });

  it('reads aria-keyshortcuts as the keys to press', () => {
    expect(keys('F2')).toEqual(['F2']);
    expect(keys('Control+M Alt+Shift+K')).toEqual(['Control+m', 'Alt+Shift+k']);
    expect(keys('Control++')).toEqual(['Control++']);
    expect(keys('Shift+ArrowDown')).toEqual(['Shift+ArrowDown']);
  });

  it('an accesskey is tried with the modifiers browsers use for it', () => {
    expect(keys('', 'p')).toEqual(['Alt+p', 'Control+Alt+p']);
    expect(keys('', 'plan')).toEqual([]);
  });

  it('reads the keys an instruction names, and nothing from ordinary words', () => {
    expect(keys('', '', 'Press F2 to show or hide the plan.')).toEqual(['F2']);
    expect(keys('', '', 'Press Alt+P to show or hide the plan.')).toEqual(['Alt+p']);
    expect(keys('', '', 'Show the plan (Ctrl-M)')).toEqual(['Control+m']);
    expect(keys('', '', 'Press M to show the plan')).toEqual(['m']);
    expect(keys('', '', 'Keyboard shortcut: g')).toEqual(['g']);
    expect(keys('', '', 'Use the arrow keys to move the plan')).toEqual(['ArrowRight', 'ArrowDown']);
    expect(keys('', '', 'Press “?” for help')).toEqual(['?']);
    expect(keys('', '', 'Shortcut is G')).toEqual(['g']);
    expect(keys('', '', 'Shortcut key G')).toEqual(['g']);
    expect(keys('', '', 'Show the plan. Shortcut (G)')).toEqual(['g']);
    // Ordinary words name no key.
    expect(keys('', '', 'Press a button to see the plan', 'Alt-text for the plan', 'Shift-click to pick several', 'The control panel for plot F21', 'Type a name')).toEqual([]);
    // Nor does the word "shortcuts" itself, a word after it, or a type of something.
    expect(keys('', '', 'Save my plot shortcuts', 'Shortcuts I use most', 'Keyboard shortcuts a to z', 'The soil here is Type A.', 'Hotkeys')).toEqual([]);
  });

  // Review r2, finding 2.
  it('reads a key whatever its case, and names a key it cannot read so the control is not failed without it', () => {
    expect(keys('', '', 'Press m to toggle the map')).toEqual(['m']);
    expect(keys('', '', 'press f2 to show the plan')).toEqual(['F2']);
    expect(keys('', '', 'PRESS M TO TOGGLE THE MAP')).toEqual(['m']);
    expect(keys('', '', 'hit the m key')).toEqual(['m']);
    // "a key" is no key.
    expect(shortcutPlan({ aria: '', access: '', texts: ['Press a key to go on', 'Press any key', 'press the button to go on'] })).toEqual({ press: [], never: [], more: 0 });
    // Named, but not a key the test can read or press.
    expect(shortcutPlan({ aria: '', access: '', texts: ['Press Fn+M to toggle the map'] })).toEqual({ press: [], never: ['Fn+M'], more: 0 });
    expect(shortcutPlan({ aria: '', access: '', texts: ['Press the star key to show the plan'] })).toEqual({ press: [], never: ['star'], more: 0 });
  });

  it('never presses a key that is tried anyway or only moves focus; Escape is a key like any other', () => {
    expect(keys('Enter Space Tab Shift+Tab')).toEqual([]);
    expect(shortcutPlan({ aria: 'Enter Space Tab Shift+Tab', access: '', texts: [] })).toEqual({ press: [], never: [], more: 0 });
    expect(keys('Escape')).toEqual(['Escape']);
    expect(keys('', '', 'Close the note (Esc)')).toEqual(['Escape']);
    expect(keys('', '', 'Press Enter to open, or press Escape to close')).toEqual(['Escape']);
    // The word in a sentence is no key.
    expect(keys('', '', 'The fire escape plan is by the gate')).toEqual([]);
  });

  it('keys the browser takes for itself are never pressed, and are named so the control is not failed without them', () => {
    expect(shortcutPlan({ aria: 'Meta+K Control+W Control+R Alt+F4 F5', access: '', texts: [] })).toEqual({ press: [], never: ['Meta+K', 'Control+W', 'Control+R', 'Alt+F4'], more: 0 });
    expect(shortcutPlan({ aria: 'F2', access: '', texts: ['Save the list (Cmd+S)'] })).toEqual({ press: ['F2'], never: ['Meta+s'], more: 0 });
    // A declared key the test does not know is not one it can say does nothing.
    expect(shortcutPlan({ aria: 'MediaPlayPause', access: '', texts: [] })).toEqual({ press: [], never: ['MediaPlayPause'], more: 0 });
  });

  it('keeps at most four keys, and each once; the ones left over are counted', () => {
    expect(keys('F2 F3 F4 F6 F7 F8')).toEqual(['F2', 'F3', 'F4', 'F6']);
    expect(shortcutPlan({ aria: 'F2 F3 F4 F6 F7 F8', access: '', texts: [] }).more).toBe(2);
    expect(keys('F2', '', 'Press F2 to show the plan (F2)')).toEqual(['F2']);
  });
});

describe('2.1.1: whether another control did what the click did', () => {
  const page = (e: Partial<Effect>) => ({ did: { what: 'x', page: true }, effect: effect({ changed: true, ...e }) });

  it('the same when it shows, hides and changes at least what the click did', () => {
    expect(sameEffect(page({ where: ['+#plan'] }), page({ where: ['+#plan'] }))).toBe('same');
    expect(sameEffect(page({ where: ['+#plan'] }), page({ where: ['+#plan', '~#label'] }))).toBe('same');
  });

  it('different when it does something else, the opposite, or nothing', () => {
    expect(sameEffect(page({ where: ['+#plan'] }), page({ where: ['~#note'] }))).toBe('different');
    // The same place, other words: something else.
    expect(sameEffect(page({ where: ['~#line=Plots # to # run along the hedge.'] }), page({ where: ['~#line=Watering is on Tuesdays.'] }))).toBe('different');
    expect(sameEffect(page({ where: ['+#plan'] }), page({ where: ['-#plan'] }))).toBe('different');
    expect(sameEffect(page({ where: ['+#plan', '-#list'] }), page({ where: ['+#plan'] }))).toBe('different');
    expect(sameEffect(page({ where: ['+#plan'] }), { did: { what: 'goes to /plan', url: 'https://a.test/plan', page: false }, effect: null })).toBe('different');
  });

  it('a click that goes to an address: the same address, with or without its fragment', () => {
    const go = (url: string) => ({ did: { what: `goes to ${url}`, url, page: false }, effect: null });
    expect(sameEffect(go('https://a.test/plan'), go('https://a.test/plan'))).toBe('same');
    expect(sameEffect(go('https://a.test/plan#top'), go('https://a.test/plan'))).toBe('same');
    expect(sameEffect(go('https://a.test/plan'), go('https://a.test/plots'))).toBe('different');
    expect(sameEffect(go('https://a.test/plan'), page({ where: ['+#plan'] }))).toBe('different');
  });

  it('a click that only changes the control\'s own state: the same when the other press changes it the same way', () => {
    expect(sameEffect(page({ own: 'its state changes' }), page({ own: 'its state changes' }))).toBe('same');
    expect(sameEffect(page({ own: 'its state changes' }), page({ where: ['+#plan'] }))).toBe('different');
  });

  it('unknown when the click left nothing on the page to compare (a new window, a browser dialog)', () => {
    expect(sameEffect({ did: { what: 'opens a new window', page: false }, effect: null }, page({ where: ['+#plan'] }))).toBe('unknown');
  });
});

describe('2.1.1: what is said when the other keyboard ways were tried', () => {
  const did = { what: 'shows “Plots 1 to 14”', page: true };

  it('not testable, never failed, when another way could not be tried or compared', () => {
    const f = operationFinding(cand({ name: 'Plan', path: '#tile' }), { kind: 'unsure', did, reason: 'a link, “Plan” (#planlink), has the same name and goes to another place, which the test does not follow, so the two could not be compared' });
    expect(f).toMatchObject({ criterion: '2.1.1', status: 'not_testable', target: '#tile' });
    expect(f?.detail).toBe('“Plan” (#tile) answers a mouse click (it shows “Plots 1 to 14”), and Enter and Space do nothing on it. Whether the keyboard reaches the same thing another way could not be told: a link, “Plan” (#planlink), has the same name and goes to another place, which the test does not follow, so the two could not be compared.');
  });

  it('a failure names the keys of its own that did nothing and the other controls that do not do the same', () => {
    const f = operationFinding(cand({ name: 'Plan', path: '#tile' }), { kind: 'pointer-only', did, keys: ['F2'], others: ['“Plan” (#b) has the same name but does nothing with the keyboard'] });
    expect(f?.status).toBe('failed');
    expect(f?.detail).toBe('“Plan” (#tile) takes keyboard focus, but Enter, Space and F2 do nothing on it, while a mouse click shows “Plots 1 to 14”: it cannot be used with the keyboard. “Plan” (#b) has the same name but does nothing with the keyboard.');
    expect(operationFinding(cand({ name: 'Plan', path: '#tile', focusable: false, tabbable: false, kind: 'clickable' }), { kind: 'pointer-only', did, keys: ['F2'] })?.detail)
      .toBe('“Plan” (#tile) answers a mouse click (it shows “Plots 1 to 14”) but cannot take keyboard focus, and nothing next to it does the same (F2, which it names as its key, does nothing), so it cannot be used with the keyboard.');
  });

  it('a page: failures first; without one, the controls that could not be judged make the result not testable', () => {
    const unsure = result({ candidate: cand({ path: '#a' }), operation: { kind: 'unsure', did, reason: 'r' } });
    const failed = result({ candidate: cand({ path: '#b' }), operation: { kind: 'pointer-only', did } });
    const fine = result({ candidate: cand({ path: '#c' }), operation: { kind: 'keys', key: 'Enter', did } });
    const info = { more: 0, refused: 0, skipped: 0 };
    const of = (rs: ControlResult[]) => controlsFindings(rs, info).filter((f) => f.criterion === '2.1.1').map((f) => [f.status, f.target ?? '']);
    expect(of([unsure, fine])).toEqual([['not_testable', '#a']]);
    expect(of([unsure, failed, fine])).toEqual([['failed', '#b']]);
    expect(of([fine])).toEqual([['no_failures_found', '']]);
  });
});

describe('4.1.3: which texts are status messages', () => {
  const status = new RegExp(STATUS_TEXT, 'i');
  it('reads the result of an action, a count of results, progress and errors as status', () => {
    for (const t of ['Route 7 was saved to your list.', 'Bed number copied.', 'Showing 3 stops.', '1 matching parcel: 12 Mill Road', 'No results', '12 results for "permit"',
      'Loading arrivals…', 'Your request has been sent.', 'The index is ready for pickup.', 'Something went wrong. Try again.', 'Email is required', 'Thank you for your feedback', 'Seed table selected', 'Selected November 16: appointments available at 9 a.m.']) {
      expect(status.test(t), t).toBe(true);
    }
  });
  it('does not read ordinary content as status', () => {
    for (const t of ['The office is open weekdays from 8 to 5.', 'Seats 40, near the east lot.', 'Site wardens list serve four-year terms.', 'Mill Road, Tuesday', 'Fee: 25 dollars']) {
      expect(status.test(t), t).toBe(false);
    }
  });
  it('names of controls that show and hide content', () => {
    const d = new RegExp(DISCLOSURE_NAME, 'i');
    for (const n of ['Show details', 'Read more', 'What happens after I apply', 'Menu', 'How do I pay?', 'View all fees']) expect(d.test(n), n).toBe(true);
    for (const n of ['Save this route', 'Copy stop number', 'Refresh arrivals', 'Check availability', 'Apply year', 'Only stops near me']) expect(d.test(n), n).toBe(false);
  });
  it('unannounced: a status that is in no live region, takes no focus, is not part of what opened and did not go away again', () => {
    expect(unannounced(message(), false)).toBe(true);
    expect(unannounced(message({ live: true }), false)).toBe(false);
    expect(unannounced(message({ focus: true }), false)).toBe(false);
    expect(unannounced(message({ ofOpened: true }), false)).toBe(false);
    expect(unannounced(message({ status: false }), false)).toBe(false);
    // A text that came into view and went away on the next press was a panel the control toggles.
    expect(unannounced(message({ appeared: true }), true)).toBe(false);
    expect(unannounced(message({ appeared: true }), false)).toBe(true);
    // A text that changed in place is judged as it is.
    expect(unannounced(message({ appeared: false }), true)).toBe(true);
  });
});

describe('the page\'s findings', () => {
  it('no controls: every criterion not applicable', () => {
    expect(controlsFindings([], { more: 0, refused: 0, skipped: 0 }).map((f) => [f.criterion, f.status])).toEqual([
      ['2.1.1', 'not_applicable'], ['4.1.3', 'not_applicable'], ['2.4.3', 'not_applicable'], ['2.4.11', 'not_applicable'], ['2.1.2', 'not_applicable'],
    ]);
  });
  it('controls not pressed are named in the notes and never make a result not testable', () => {
    const did = { what: 'shows “Hours”', page: true };
    const out = controlsFindings([result({ operation: { kind: 'keys', key: 'Enter', did }, looked: true })], { more: 3, refused: 1, skipped: 2, skippedWhy: 'the time for this test ran out' });
    expect(out.every((f) => f.status !== 'not_testable')).toBe(true);
    expect(out[0]).toEqual({
      criterion: '2.1.1', status: 'no_failures_found',
      detail: '1 control pressed with the keyboard and, where the keys did nothing, the mouse (1 answered the keyboard); 3 more controls not pressed (the test presses 8 per page, one of each kind first); 2 controls not pressed (the time for this test ran out); 1 control never pressed (a link, a form field, a submit button, or named for an action on the site)',
    });
  });
  it('a failure stands whatever else was pressed; rules with something to judge and no failure are clean', () => {
    const did = { what: 'shows “Hours”', page: true };
    const out = controlsFindings([
      result({ operation: { kind: 'pointer-only', did }, looked: true, status: [message()] }),
      result({ candidate: cand({ i: 1, path: '#y', name: 'Help' }), operation: { kind: 'keys', key: 'Enter', did }, looked: true, openedControls: true, focusJudged: true, trapJudged: true }),
    ], { more: 0, refused: 0, skipped: 0 });
    expect(out.map((f) => [f.criterion, f.status, f.target ?? ''])).toEqual([
      ['2.1.1', 'failed', '#x'], ['4.1.3', 'failed', '#m'], ['2.4.3', 'no_failures_found', ''], ['2.4.11', 'no_failures_found', ''], ['2.1.2', 'no_failures_found', ''],
    ]);
  });
});
