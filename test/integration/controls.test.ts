// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The controls test in real Chromium: it presses the page's own controls with the keyboard and the mouse
// and judges what happens (2.1.1, 4.1.3, 2.4.3, 2.4.11, 2.1.2). Fixture site: test/fixtures/controls/ (a
// planted failure and its look-alikes for every rule). The fixture server logs every request, so the
// safety test can show that nothing but plain page loads reached it.
import type { IncomingMessage } from 'node:http';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { controlsProbe } from '../../src/probes/controls/index.js';
import { runProbes } from '../../src/probes/runner.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const log: { method: string; path: string; dest: string }[] = [];
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('controls', {}, {
    onRequest: (req: IncomingMessage) => { log.push({ method: req.method ?? '', path: req.url ?? '', dest: String(req.headers['sec-fetch-dest'] ?? '') }); },
  });
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

const run = async (path: string): Promise<ProbeRun> => {
  const [r] = await runProbes(B(), [{ url: `${server.origin}${path}`, index: 0 }], [controlsProbe], OPTS);
  return r!;
};
/** The run's findings for one criterion: [status, target]. */
const of = (r: ProbeRun, criterion: string) => r.findings.filter((f) => f.criterion === criterion).map((f) => [f.status, f.target ?? '']);
const detail = (r: ProbeRun, criterion: string) => r.findings.find((f) => f.criterion === criterion)?.detail ?? '';
const T = 60_000;

describe('2.1.1: a control only the pointer can use (F54)', () => {
  it('fails a control that takes focus, answers pointer-up, and does nothing on Enter or Space', async () => {
    const r = await run('/pointer-only.html');
    expect(r.status).toBe('ok');
    expect(of(r, '2.1.1')).toEqual([['failed', '#remind']]);
    expect(detail(r, '2.1.1')).toBe('“Save my reminder choice” (#remind) takes keyboard focus, but Enter and Space do nothing on it, while a mouse click changes “” to “Your reminder choice is saved for this visit.”: it cannot be used with the keyboard.'.replace('changes “” to', 'shows'));
    // Its message is in a status region that was there before: announced.
    expect(of(r, '4.1.3')).toEqual([['no_failures_found', '']]);
  }, T);

  it('look-alike: the same control with a click handler and Enter and Space wired is clean', async () => {
    const r = await run('/keyboard-ok.html');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
    expect(detail(r, '2.1.1')).toContain('1 control pressed with the keyboard');
  }, T);

  it('look-alike: a custom check box that only Space works is keyboard operable', async () => {
    const r = await run('/space-only.html');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('fails tabs chosen on pointer-up, with no arrow keys', async () => {
    const r = await run('/tabs-pointer.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#t1']]);
    expect(detail(r, '2.1.1')).toBe('The tab “Past” (#t1) can be chosen with the mouse (a click shows “Last month the board met twice.”), but not with the keyboard: neither the arrow keys nor Enter or Space reach it or choose it.');
  }, T);

  it('still fails them when each panel takes focus and is named by its tab: a panel is no other control that could do the same', async () => {
    const r = await run('/tabs-pointer-panels.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#t1']]);
    expect(detail(r, '2.1.1')).not.toContain('has the same name');
  }, T);

  it('fails tabs whose click works but that the keyboard cannot reach (out of the Tab order, no arrow keys)', async () => {
    const r = await run('/tabs-unreachable.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#t1']]);
  }, T);

  it('look-alikes: tabs with arrow keys (chosen as focus moves, or with Enter after it) are clean', async () => {
    expect(of(await run('/tabs-ok.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/tabs-manual.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('fails a native button whose action runs on pointer-up only', async () => {
    const r = await run('/native-pointerup.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#more']]);
    expect(detail(r, '2.1.1')).toContain('(its action runs on pointerup, which a key press never sends)');
  }, T);

  it('look-alike: a native button with a click handler is clean', async () => {
    expect(of(await run('/native-click.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('fails a custom control served by a click handler on the document (delegation), with no key handling', async () => {
    const r = await run('/delegated-pointer.html');
    expect(of(r, '2.1.1')).toEqual([['failed', 'html > body > main > div > div:nth-of-type(1)']]);
  }, T);

  it('look-alike: delegated click and key handlers are clean', async () => {
    expect(of(await run('/delegated-ok.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('fails an element that takes no focus and hides a notice on mouse-up', async () => {
    const r = await run('/click-only.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#dismiss']]);
    expect(detail(r, '2.1.1')).toContain('cannot take keyboard focus');
  }, T);

  it('fails a click-only tile in a column of content: a link and a button about other things nearby are no keyboard way to it', async () => {
    const r = await run('/click-column.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#table']]);
    expect(detail(r, '2.1.1')).toBe('“Seed table” (#table) answers a mouse click (it shows “Seed table chosen.”) but cannot take keyboard focus, and nothing next to it does the same, so it cannot be used with the keyboard.');
  }, T);

  it('look-alike: a click-only thumbnail in a list item with the photo\'s own link (a card) is clean', async () => {
    expect(of(await run('/click-thumb.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('look-alikes: a click-only tile next to a link with the same address; content shown by focus styles alone', async () => {
    expect(of(await run('/click-card.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/focus-within.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);
});

// Review r1, finding 6 (Understanding 2.1.1): the function has to be operable from a keyboard, by any key and
// from anywhere on the page. A control that answers the pointer only fails when the keys it names do nothing
// and no other control gives the same thing with the keyboard; where that cannot be told, it is not testable.
describe('2.1.1: other keyboard ways to what a pointer-only control does', () => {
  it('a keyboard control elsewhere on the page that does the same (same aria-controls): no failure', async () => {
    const r = await run('/equivalent-elsewhere.html');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('the other control only shows what the tile shows and hides: tried from both states, no failure', async () => {
    const r = await run('/equivalent-show-only.html');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
    const tile = (r.data as { pressed: { path: string; result: string; how?: string }[] }).pressed.find((x) => x.path === '#tile');
    expect(tile?.result).toBe('equivalent');
    expect(tile?.how).toContain('“Show the plan” (#planbtn) does the same with the keyboard');
  }, T);

  it('another control with another name that does the same with a key: no failure', async () => {
    const r = await run('/equivalent-twin.html');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
    const tile = (r.data as { pressed: { path: string; result: string; how?: string }[] }).pressed.find((x) => x.path === '#tile');
    expect(tile?.how).toContain('“Where the plots are” does the same with the keyboard');
  }, T);

  it('look-alike that still fails: another control that only changes its own state did not do the same', async () => {
    const r = await run('/twin-own-state.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#tile']]);
  }, T);

  it('a key the control names (aria-keyshortcuts, or its describing text) that works: no failure', async () => {
    const f2 = await run('/shortcut-f2.html');
    expect(of(f2, '2.1.1')).toEqual([['no_failures_found', '']]);
    expect((f2.data as { pressed: { result: string; key?: string }[] }).pressed).toMatchObject([{ result: 'keys', key: 'F2' }]);
    const text = await run('/shortcut-text.html');
    expect(of(text, '2.1.1')).toEqual([['no_failures_found', '']]);
    expect((text.data as { pressed: { result: string; key?: string }[] }).pressed).toMatchObject([{ result: 'keys', key: 'Alt+p' }]);
  }, T);

  it('look-alikes that still fail: a control with the same name that does something else; a named key that does nothing', async () => {
    const other = await run('/equivalent-other.html');
    expect(of(other, '2.1.1')).toEqual([['failed', '#tile']]);
    expect(detail(other, '2.1.1')).toContain('“Plan of the plots” (#planbtn) has the same name but does something else with the keyboard');
    const dead = await run('/shortcut-dead.html');
    expect(of(dead, '2.1.1')).toEqual([['failed', '#tile']]);
    expect(detail(dead, '2.1.1')).toContain('Enter, Space and F2 do nothing on it');
  }, T);

  it('look-alike that still fails: another control writes something else into the same line', async () => {
    const r = await run('/equivalent-same-line.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#tile']]);
  }, T);

  it('a key named beside the control that does something else: not testable, neither failed nor passed', async () => {
    const r = await run('/shortcut-other.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(r, '2.1.1')).toContain('F2, a key named for it, does something else');
  }, T);

  it('look-alikes that still fail: the word "shortcuts" in a name is no key; a named key that does nothing where the click still works', async () => {
    const word = await run('/shortcut-word.html');
    expect(of(word, '2.1.1')).toEqual([['failed', '#tile']]);
    expect(detail(word, '2.1.1')).toContain('Enter and Space do nothing on it');
    const repeat = await run('/shortcut-dead-repeat.html');
    expect(of(repeat, '2.1.1')).toEqual([['failed', '#tile']]);
    expect(detail(repeat, '2.1.1')).toContain('Enter, Space and F2 do nothing on it');
  }, T);

  it('a named key that could not be tried where the click started, or that the test never presses: not testable, never failed', async () => {
    const esc = await run('/shortcut-escape.html');
    expect(of(esc, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(esc, '2.1.1')).toContain('Escape');
    const never = await run('/shortcut-never.html');
    expect(of(never, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(never, '2.1.1')).toContain('it names Meta+K as its key, which the test does not press');
  }, T);

  // Review r2, finding 1: an alternative that was not tried may be the one that does the same.
  it('three controls with the same name, of which the test tries two: not testable, never failed', async () => {
    const r = await run('/alternatives-three.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(r, '2.1.1')).toContain('1 more control with the same name or target was not tried');
  }, T);

  // Review r2, finding 2: a key is a key in any case; a named key the test cannot read is a doubt.
  it('a key named in lower case ("Press m to toggle the map") that works: no failure; a named key the test cannot read: not testable', async () => {
    const lower = await run('/shortcut-lower.html');
    expect(of(lower, '2.1.1')).toEqual([['no_failures_found', '']]);
    expect((lower.data as { pressed: { result: string; key?: string }[] }).pressed).toMatchObject([{ result: 'keys', key: 'm' }]);
    const unread = await run('/shortcut-unread.html');
    expect(of(unread, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(unread, '2.1.1')).toContain('it names Fn+M as its key, which the test does not press');
  }, T);

  it('look-alike that still fails: a frame with the same name is no other control', async () => {
    const r = await run('/equivalent-frame.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#tile']]);
    // The frame was not pressed or compared: the finding says nothing about it.
    expect(detail(r, '2.1.1')).not.toContain('has the same name');
  }, T);

  it('a link with the same name goes to another page, which the test does not load: not testable, never failed', async () => {
    const r = await run('/equivalent-link.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#tile']]);
    expect(detail(r, '2.1.1')).toContain('could not be compared');
  }, T);
});

describe('4.1.3: a status message a press shows', () => {
  it('fails a message written into a plain element while focus stays on the button', async () => {
    const r = await run('/status-silent.html');
    expect(of(r, '4.1.3')).toEqual([['failed', '#toast']]);
    expect(detail(r, '4.1.3')).toBe('Pressing “Save this route” shows “Route 7 was saved to your list.”, but screen readers are not told: the message is not in a live region (role="status", role="alert" or aria-live), and focus stays where it was.');
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('fails a toast added as a new element, and a result count that changes in place', async () => {
    expect(of(await run('/status-toast.html'), '4.1.3')).toEqual([['failed', 'html > body > div']]);
    expect(of(await run('/status-count.html'), '4.1.3')).toEqual([['failed', '#count']]);
  }, T);

  it('look-alikes: the same message in a status region, and one that takes focus', async () => {
    const live = await run('/status-live.html');
    expect(of(live, '4.1.3')).toEqual([['no_failures_found', '']]);
    expect(detail(live, '4.1.3')).toContain('1 status message shown by the controls pressed is announced');
    expect(of(await run('/status-focus.html'), '4.1.3')).toEqual([['no_failures_found', '']]);
  }, T);

  // Review r1, finding 7 (ARIA22): what counts is that the live region is in the page before the message is put
  // into it, not that it was there before the press; and a region is live through any ancestor, also across a
  // shadow root.
  it('a status region added empty and filled a moment later is announced; one added together with its message is not', async () => {
    const late = await run('/status-late-region.html');
    expect(of(late, '4.1.3')).toEqual([['no_failures_found', '']]);
    expect(detail(late, '4.1.3')).toContain('1 status message shown by the controls pressed is announced');
    expect(of(await run('/status-with-region.html'), '4.1.3')).toEqual([['failed', '#spot']]);
  }, T);

  it('look-alikes: a new status element inside a region that was live all along; a region inside a shadow root', async () => {
    expect(of(await run('/status-nested.html'), '4.1.3')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/status-shadow.html'), '4.1.3')).toEqual([['no_failures_found', '']]);
  }, T);

  // Review r2, finding 7: what happens inside a shadow root is not seen by the test's observer.
  it('a status region made inside a shadow root in the same handler as its message: not testable, never "announced"', async () => {
    const r = await run('/status-shadow-born.html');
    expect(of(r, '4.1.3')).toEqual([['not_testable', '#spot']]);
    expect(detail(r, '4.1.3')).toContain('inside a shadow root');
  }, T);

  it('look-alikes: content a control shows and hides is not a status message, whatever its words', async () => {
    for (const p of ['/disclosure.html', '/disclosure-aria.html', '/toggle-panel.html']) {
      expect(of(await run(p), '4.1.3'), p).toEqual([['not_applicable', '']]);
    }
  }, T);
});

describe('4.1.3: the result count of a search or filter field', () => {
  it('fails a count that changes as the field is typed in, with no live region', async () => {
    const r = await run('/search-silent.html');
    expect(of(r, '4.1.3')).toEqual([['failed', '#count']]);
    expect(detail(r, '4.1.3')).toMatch(/^Typing in “Find growers” shows “(Showing \d (person|people)\.|No results for that name\.)”, but screen readers are not told/);
  }, T);

  it('fails the count a search form shows when Enter is pressed in its field (a form known only by its "Search" button)', async () => {
    const r = await run('/search-button.html');
    expect(of(r, '4.1.3')).toEqual([['failed', '#count']]);
    expect(detail(r, '4.1.3')).toContain('Typing in “Grower or plot number” shows “0 growers match your search.”');
  }, T);

  it('look-alikes: the same count in a status region; a filter that shows no count; a search that loads a results page (never sent)', async () => {
    const live = await run('/search-live.html');
    expect(of(live, '4.1.3')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/search-plain.html'), '4.1.3')).toEqual([['not_applicable', '']]);
    const start = log.length;
    const sent = await run('/search-submit.html');
    expect(sent.status).toBe('ok');
    expect(of(sent, '4.1.3')).toEqual([['not_applicable', '']]);
    expect(log.slice(start).filter((x) => x.path.startsWith('/search?'))).toEqual([]);
  }, T);
});

describe('2.4.3: what a press opens is not next in the focus order (F85)', () => {
  it('fails a panel with controls that opens at the end of the page without taking focus', async () => {
    const r = await run('/late-panel.html');
    expect(of(r, '2.4.3')).toEqual([['failed', '#filter']]);
    expect(detail(r, '2.4.3')).toBe('Pressing “Narrow the plant list” opens a panel over the page (“Filter the list”) with 2 controls in it, but keyboard focus is not moved into it and the next 3 Tab presses do not reach it (focus goes to “Books from 1900”): it is not next to its control in the focus order.');
  }, T);

  it('look-alikes: the same panel when focus is moved into it, and a panel that comes right after its button', async () => {
    expect(of(await run('/late-panel-focus.html'), '2.4.3')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/panel-next.html'), '2.4.3')).toEqual([['no_failures_found', '']]);
  }, T);
});

describe('2.4.11: focus left hidden by a press', () => {
  it('fails focus sent to a link that sits entirely behind the sticky header', async () => {
    const r = await run('/cover-focus.html');
    expect(of(r, '2.4.11')).toEqual([['failed', '#desk']]);
    expect(detail(r, '2.4.11')).toBe('Pressing “Continue to the service desk” moves keyboard focus to “Site hut hours” (#desk), which is entirely hidden behind html > body > header (fixed or sticky content); Escape does not bring it into view.');
  }, T);

  it('look-alike: the link only partly behind the header is clean (AA asks for "not entirely hidden")', async () => {
    expect(of(await run('/cover-partial.html'), '2.4.11')).toEqual([['no_failures_found', '']]);
  }, T);

  // Review r1, finding 8 (Understanding 2.4.11, note 2): content the user opened may cover the focused control
  // when the user can bring it back into view without moving focus.
  it('a panel the button opens over itself is allowed when Escape, or the same press again, takes it away; it fails when nothing does', async () => {
    expect(of(await run('/cover-help-escape.html'), '2.4.11')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/cover-help-toggle.html'), '2.4.11')).toEqual([['no_failures_found', '']]);
    const stuck = await run('/cover-help-stuck.html');
    expect(of(stuck, '2.4.11')).toEqual([['failed', '#tip']]);
    expect(detail(stuck, '2.4.11')).toBe('After “Rent tips” (#tip) is pressed, it is entirely hidden behind #tips while it still holds keyboard focus, and neither Escape nor pressing it again brings it back into view.');
  }, T);

  // Review r2, finding 5: a close control in the panel that was not tried may take it away without moving focus.
  it('a panel over the focused button with a Close control the test does not try: not testable, never failed', async () => {
    const r = await run('/cover-help-close.html');
    expect(of(r, '2.4.11')).toEqual([['not_testable', '#tip']]);
    expect(detail(r, '2.4.11')).toContain('a control to close it');
  }, T);
});

describe('2.1.2: a focus loop in what a press opened', () => {
  it('fails a dialog that cancels Escape, loops Tab between its buttons, and whose buttons do not close it', async () => {
    const r = await run('/dialog-trap.html');
    expect(of(r, '2.1.2')).toEqual([['failed', '#dlg']]);
    expect(detail(r, '2.1.2')).toContain('After “Ticket questions” is pressed: Keyboard focus is trapped in "Ticket questions" (#dlg): Tab cycles through 2 elements');
  }, T);

  it('look-alikes: the same loop when one of its buttons closes it, and a native modal dialog', async () => {
    expect(of(await run('/dialog-button-out.html'), '2.1.2')).toEqual([['no_failures_found', '']]);
    expect(of(await run('/dialog-native.html'), '2.1.2')).toEqual([['no_failures_found', '']]);
  }, T);
});

describe('a page that changes by itself is never read as a press', () => {
  it('a clock line and a rotating notice on a timer: no failure for an inert control, no status message', async () => {
    const r = await run('/noise-ticker.html');
    expect(r.status).toBe('ok');
    expect(r.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, T);

  it('a layer that shows and hides itself several times a second: nothing is read as opened', async () => {
    const r = await run('/noise-fast.html');
    expect(r.findings.filter((f) => f.status === 'failed')).toEqual([]);
  }, T);

  it('a countdown that ticks every second is not the key press\'s doing: the pointer-only control beside it still fails', async () => {
    const r = await run('/pointer-countdown.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#attach']]);
    expect(detail(r, '2.1.1')).toContain('while a mouse click shows “Field sketch added to this order.”');
    // The lead's cut (batch 17): the countdown's tick in the click's window is never the click's.
    expect(detail(r, '2.1.1')).not.toMatch(/seconds/);
    // Look-alike: the same page with the control wired for the keyboard.
    const ok = await run('/keyboard-countdown.html');
    expect(ok.findings.filter((f) => f.status === 'failed')).toEqual([]);
    expect(detail(ok, '2.1.1')).toContain('(1 answered the keyboard)');
  }, T);

  it('a click that changes nothing anyone sees beside a countdown is never failed, and never credited with its tick', async () => {
    // The lead's cut (batch 17): what a page timer wrote in the click's window is never the click's; with nothing of
    // its own left, the click is not testable (when the tick fell in the window) or did nothing (when it did not).
    const r = await run('/pointer-inert-countdown.html');
    expect(r.findings.filter((f) => f.status === 'failed')).toEqual([]);
    expect(detail(r, '2.1.1')).not.toMatch(/seconds/);
    expect(of(r, '2.1.1').map(([s]) => s)).toEqual([expect.stringMatching(/^(not_testable|no_failures_found)$/)]);
  }, T);

  it('a change a moment after the event (a short timer) on a quiet page is still the press\'s own', async () => {
    const r = await run('/pointer-delayed.html');
    expect(of(r, '2.1.1')).toEqual([['failed', '#remind']]);
  }, T);
});

describe('nothing to press, and what is never pressed', () => {
  it('a page without controls: not applicable', async () => {
    const r = await run('/plain.html');
    expect(r.findings.map((f) => [f.criterion, f.status])).toEqual([['2.1.1', 'not_applicable'], ['4.1.3', 'not_applicable'], ['2.4.3', 'not_applicable'], ['2.4.11', 'not_applicable'], ['2.1.2', 'not_applicable']]);
    expect(detail(r, '2.1.1')).toBe('no custom controls or buttons to press on this page');
  }, T);

  it('never presses a control named for an action, a link, or a submit button; nothing is sent', async () => {
    const start = log.length;
    const r = await run('/actions.html');
    expect(r.status).toBe('ok');
    expect(of(r, '2.1.1')).toEqual([['not_applicable', '']]);
    expect(detail(r, '2.1.1')).toContain('never pressed');
    expect(log.slice(start).filter((x) => x.method !== 'GET' || x.dest !== 'document')).toEqual([]);
  }, T);

  it('a press that asks the server for data: the request never leaves', async () => {
    const start = log.length;
    const r = await run('/fetches.html');
    expect(r.status).toBe('ok');
    expect(log.slice(start).filter((x) => x.path.startsWith('/api/'))).toEqual([]);
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  // Review r1, finding 2: a button can build a file in the page and click a download link it made itself, so no
  // request ever reaches the request guard. Two layers stop it: generated download clicks are cancelled in the
  // page, and the browser context of a test that presses things refuses downloads.
  it('an "Export" button that clicks a download link it made: no file is ever saved', async () => {
    // How each download the browser reported ended: 'canceled' when the browser refused it, null when a file was saved.
    const ends: (string | null)[] = [];
    let started = 0;
    const watched = {
      async newContext(o: Parameters<Browser['newContext']>[0]) {
        const c = await browser.newContext(o);
        c.on('page', (p) => p.on('download', (d) => { started++; void d.failure().then((f) => ends.push(f), () => ends.push('closed')); }));
        return c;
      },
    } as unknown as BrowserLike;
    const [r] = await runProbes(watched, [{ url: `${server.origin}/export-blob.html`, index: 0 }], [controlsProbe], OPTS);
    expect(r!.status).toBe('ok');
    // The data the test kept says both controls were pressed.
    expect(JSON.stringify(r!.data)).toContain('Export the seed list');
    expect(JSON.stringify(r!.data)).toContain('Make a sheet of the list');
    // No file was saved: the link made in the page itself never starts a download (the page's canceller), and
    // the one clicked from inside a frame, which the canceller does not see, is refused by the browser.
    expect(ends.filter((e) => e === null)).toEqual([]);
    expect(ends.length).toBe(started);
    // (Playwright ends a download its context refused with a message that names the acceptDownloads option.)
    expect(ends.filter((e) => e !== 'canceled' && e !== 'closed' && !/acceptDownloads/.test(e ?? ''))).toEqual([]);
    expect(started).toBeGreaterThan(0);
  }, T);
});

describe('inside the page\'s own frames (keyboard-op lane, 2026-11-11): a control in a same-site frame is part of the page', () => {
  it('fails a pointer-only control inside a frame from the same site, named through the frame', async () => {
    const r = await run('/frame-pointer-only.html');
    expect(r.status).toBe('ok');
    expect(of(r, '2.1.1')).toEqual([['failed', '#map-frame >>> #layer']]);
    expect(detail(r, '2.1.1')).toBe('Inside the embedded frame “Parcel map”: “Show flood zones” (#layer) takes keyboard focus, but Enter and Space do nothing on it, while a mouse click shows “Lots 12 to 18 are in the 100-year flood zone.”: it cannot be used with the keyboard.');
  }, T);

  it('look-alike: the same control with Enter and Space wired is clean', async () => {
    expect(of(await run('/frame-keyboard-ok.html'), '2.1.1')).toEqual([['no_failures_found', '']]);
  }, T);

  it('look-alike: a control outside the frame with the same name may do the same with the keyboard: not testable, never failed', async () => {
    const r = await run('/frame-outside-twin.html');
    // The page's own button is pressed and works; the frame's control is not testable.
    expect(of(r, '2.1.1')).toEqual([['no_failures_found', ''], ['not_testable', '#map-frame >>> #layer']]);
    expect(r.findings.find((f) => f.criterion === '2.1.1' && f.status === 'not_testable')?.detail).toContain('a control outside the frame has the same name');
  }, T);

  it('look-alike: a frame the page covers with its own content gets no click (no press lands on the page either), and its control is not testable (fix round 1, F4)', async () => {
    const r = await run('/frame-covered.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#map-frame >>> #layer']]);
    expect(detail(r, '2.1.1')).toBe('Inside the embedded frame “Parcel map”: “Show flood zones”: Enter and Space did nothing on it, and the page covers the frame at that point, so it was not clicked, so whether only the mouse can use it could not be told.');
  }, T);

  it('a frame the page scales: no click is made where it could land elsewhere, and its control is not testable (fix round 1, F6)', async () => {
    const r = await run('/frame-scaled.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#map-frame >>> #layer']]);
    expect(detail(r, '2.1.1')).toContain('the page scales or turns the frame');
  }, T);

  it('a frame its own control takes away mid-press: not testable for 2.1.1 and 2.1.2, never clean (fix round 1, F4)', async () => {
    const r = await run('/frame-removed.html');
    expect(r.status).toBe('ok');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#map-frame']]);
    expect(detail(r, '2.1.1')).toContain('its controls could not be pressed');
    expect(of(r, '2.1.2')).toEqual([['not_testable', '#map-frame']]);
  }, T);

  it('fails a dialog a button inside the frame opens that keeps focus with no way out (2.1.2)', async () => {
    const r = await run('/frame-trap.html');
    expect(of(r, '2.1.2')).toEqual([['failed', '#map-frame >>> #dlg']]);
    expect(detail(r, '2.1.2')).toMatch(/^Inside the embedded frame “Parcel map”: After “Look up a parcel” is pressed: Keyboard focus is trapped/);
  }, T);

  it('look-alike: the same dialog that Escape closes is clean', async () => {
    expect(of(await run('/frame-dialog-ok.html'), '2.1.2')).toEqual([['no_failures_found', '']]);
  }, T);

  it('only 2.1.1 and 2.1.2 come from a frame; what the page itself shows keeps its own results', async () => {
    const r = await run('/frame-trap.html');
    for (const c of ['2.4.3', '2.4.11', '4.1.3']) expect(r.findings.filter((f) => f.criterion === c && f.target?.includes(' >>> '))).toEqual([]);
  }, T);
});

describe('a focus loop in what a same-site frame shows by itself (keyboard-op lane, 2026-11-11)', () => {
  it('fails a frame whose controls Tab and Shift+Tab go round, with Escape kept: the keyboard walk stops at the frame, this test Tabs inside it', async () => {
    const r = await run('/frame-loop.html');
    expect(of(r, '2.1.2')).toEqual([['failed', expect.stringMatching(/^#map-frame >>> /)]]);
    expect(detail(r, '2.1.2')).toMatch(/^Inside the embedded frame “Parcel map”: Keyboard focus is trapped in .*Tab cycles through 3 elements/);
  }, T);

  it('look-alikes: the same controls Tab leaves after the last one, and a loop that Escape leaves, are clean', async () => {
    expect(of(await run('/frame-noloop.html'), '2.1.2').filter(([s]) => s !== 'no_failures_found' && s !== 'not_applicable')).toEqual([]);
    expect(of(await run('/frame-loop-escape.html'), '2.1.2').filter(([s]) => s !== 'no_failures_found' && s !== 'not_applicable')).toEqual([]);
  }, T);
});

describe('frames, from the sim lab (keyboard-op lane, 2026-11-11)', () => {
  it('look-alike: tabs in a frame and a button outside it named after one of the tabs, which shows it: not testable, never failed', async () => {
    const r = await run('/frame-tabs-outside.html');
    expect(of(r, '2.1.1').filter(([s]) => s === 'failed')).toEqual([]);
    expect(r.findings.find((f) => f.criterion === '2.1.1' && f.status === 'not_testable')?.detail).toContain('the same name as one of its widget\'s members');
  }, T);

  it('a frame the page puts in after it loaded, which the request guard does not let load: not testable, never "nothing to press"', async () => {
    const r = await run('/frame-late.html');
    expect(of(r, '2.1.1')).toEqual([['not_testable', '#map-frame']]);
    expect(detail(r, '2.1.1')).toContain('the page put it in or changed its address after it loaded, and the test does not let such a frame load');
    // Nor is a focus loop in it known: 2.1.2 is not testable too, never "nothing opened".
    expect(of(r, '2.1.2')).toEqual([['not_testable', '#map-frame']]);
  }, T);
});
