// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Strict tests, round 4 (2026-11-07): each rule added for recall, on a page that must fail and a look-alike that
// must not (test/fixtures/strict-4/), and every input of Sol's round-1 review (fixtures named *-solN-*), each a case
// that was wrong on 3f7a1a9f. A near miss must show the check ran (`clean`), never pass on a skipped check.
// The pure rules are in test/unit/strictTests4.test.ts.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { keyboardProbe, keyShortcutsProbe } from '../../src/probes/keyboard/index.js';
import { resizeTextProbe } from '../../src/probes/resizeText.js';
import { runProbes } from '../../src/probes/runner.js';
import { screenReaderProbe } from '../../src/probes/screenReader/index.js';
import { scanSite } from '../../src/scan.js';
import type { PageProbe } from '../../src/probes/types.js';
import type { BrowserLike, ProbeFinding, ProbeRun } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;

beforeAll(async () => {
  server = await startFixtureServer('strict-4');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

async function runs(file: string, probe: PageProbe): Promise<ProbeRun[]> {
  return runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/${file}.html`, index: 0 }], [probe], { userAgent: 'grnted-test', full: true });
}
async function findings(file: string, probe: PageProbe): Promise<ProbeFinding[]> {
  const rs = await runs(file, probe);
  for (const r of rs) expect(r.status, `${file} ${r.probe}`).toBe('ok');
  const all = rs.flatMap((r) => r.findings);
  if (process.env.ST4_DEBUG) console.log(file, JSON.stringify(all.map((f) => [f.criterion, f.status, f.advice ?? '', f.target, f.detail.slice(0, 140)])));
  return all;
}
const failed = async (file: string, probe: PageProbe, criterion: string) => (await findings(file, probe)).filter((f) => f.criterion === criterion && f.status === 'failed');
/** A near miss: the check ran on the page (not skipped, not untestable, not inapplicable) and failed nothing. */
async function clean(file: string, probe: PageProbe, criterion: string): Promise<ProbeFinding[]> {
  const all = (await findings(file, probe)).filter((f) => f.criterion === criterion);
  expect(all.filter((f) => f.status === 'failed'), `${file}: failed`).toEqual([]);
  expect(all.filter((f) => f.status === 'not_testable' || f.status === 'not_applicable'), `${file}: the check ran`).toEqual([]);
  return all;
}

describe('headings: F2, F92 and placeholder text', () => {
  const advised = (all: readonly ProbeFinding[]) => all.filter((f) => f.advice).map((f) => f.detail.slice(0, 22));
  it('R2 ruling 1: section titles styled as headings (F2) are listed as recommendations, never failed', async () => {
    expect(advised(await clean('h-div-titles', headingsProbe, '1.3.1'))).toEqual(['“Parking permits” look', '“Trash and recycling” ', '“Water service” looks ']);
  }, 30_000);
  it('look-alikes pass: one title, a "Label:", a list item, a sentence; bold notes on a page with h2s', async () => {
    await clean('h-div-titles-ok', headingsProbe, '1.3.1');
    await clean('h-div-titles-h2', headingsProbe, '1.3.1');
  }, 60_000);
  it('Sol 3: bold status messages and clipped bold instructions are not section titles', async () => {
    await clean('h-sol3-status', headingsProbe, '1.3.1');
  }, 30_000);
  it('Sol 13: section titles inside an open shadow root are listed like those in the page, with the host named once (R2 14)', async () => {
    const all = await clean('h-shadow-titles', headingsProbe, '1.3.1');
    expect(all.filter((f) => f.advice).map((f) => f.target)).toEqual(['#host >>> div:nth-of-type(1)', '#host >>> div:nth-of-type(2)']);
  }, 30_000);
  it('R2 ruling 1: an h2 with role presentation shown as a heading (F92) is a recommendation, never failed', async () => {
    expect(advised(await clean('h-presentation', headingsProbe, '1.3.1'))).toEqual(['“Parking permits” look']);
  }, 30_000);
  it('look-alikes pass: role presentation undone by aria-label, a stat number, a small footnote, a calendar header with buttons', async () => {
    await clean('h-presentation-ok', headingsProbe, '1.3.1');
  }, 30_000);
  it('Sol 4: a metric ("1.2k"), a clipped instruction and a note no larger than the body copy are not F92', async () => {
    await clean('h-sol4-presentation', headingsProbe, '1.3.1');
  }, 30_000);
  it('Sol 13: template residue inside a same-origin frame fails; F92 there is listed', async () => {
    const all = await findings('h-frame', headingsProbe);
    expect(all.filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target?.includes(' >>> ')])).toEqual([['2.4.6', true]]);
    expect(all.filter((f) => f.advice && f.criterion === '1.3.1').map((f) => f.target?.includes(' >>> '))).toEqual([true]);
  }, 30_000);
  it('R2 ruling 2: "Lorem ipsum" scores only when the heading is filler and nothing else', async () => {
    expect((await failed('h-r2-lorem', headingsProbe, '2.4.6')).map((f) => f.detail)).toEqual([expect.stringMatching(/reads “Lorem ipsum dolor sit amet”/)]);
  }, 30_000);
  it('template residue fails 2.4.6; a bare word ("Heading") is a recommendation only', async () => {
    expect((await failed('h-residue', headingsProbe, '2.4.6')).map((f) => f.detail)).toEqual([expect.stringMatching(/reads “Your heading here”, placeholder text left from a template/)]);
    const bare = await clean('h-placeholder', headingsProbe, '2.4.6');
    expect(bare.filter((f) => f.advice).map((f) => f.detail)).toEqual([expect.stringMatching(/reads only “Heading”/)]);
    await clean('h-placeholder-ok', headingsProbe, '2.4.6');
  }, 60_000);
  it('Sol 1: descriptive bare words, legal headings and an artwork named Untitled never fail 2.4.6', async () => {
    const all = await clean('h-sol1-words', headingsProbe, '2.4.6');
    expect(all.filter((f) => f.advice).length).toBe(4);
  }, 30_000);
  // Batch 19, the lead's ruling: an empty heading is Needs review under 1.3.1 (flagged), never failed, never 2.4.6.
  it('the screen-reader pass files an empty heading under 1.3.1 (Needs review), never 2.4.6', async () => {
    const all = await findings('h-empty', screenReaderProbe);
    expect(all.filter((f) => f.status === 'failed').map((f) => f.criterion)).toEqual([]);
    expect(all.filter((f) => f.status === 'flagged').map((f) => f.criterion)).toEqual(['1.3.1']);
    expect(all.some((f) => f.criterion === '2.4.6')).toBe(false);
  }, 60_000);
});

describe('form fields: F111, G167, radio questions', () => {
  it('visible label text not tied to a field with no name fails 1.3.1 (F111), once per field', async () => {
    expect((await failed('f-f111', formFieldsProbe, '1.3.1')).map((f) => f.detail.slice(0, 25))).toEqual(['the text "E-mail address"', 'the text "Send me the new']);
  }, 30_000);
  it('look-alikes pass 1.3.1: a named field beside its text, a split phone number named part by part', async () => {
    await clean('f-f111-ok', formFieldsProbe, '1.3.1');
  }, 30_000);
  it('Sol 5: a field named by image alt text (aria-labelledby, a wrapping label) has a name: no F111', async () => {
    await clean('f-sol5-img-alt', formFieldsProbe, '1.3.1');
  }, 30_000);
  it('R2 ruling 3: the name is read with the field disclosed (inside closed <details>): no F111', async () => {
    await clean('f-r2-details', formFieldsProbe, '1.3.1');
  }, 30_000);
  it('R2 ruling 3: a frame\'s candidate cannot be confirmed: 1.3.1 not testable there, never clean', async () => {
    const all = (await findings('f-r2-frame', formFieldsProbe)).filter((f) => f.criterion === '1.3.1');
    expect(all.map((f) => f.status)).toEqual(['not_testable']);
    expect(all[0]!.detail).toMatch(/could not be read here/);
  }, 30_000);
  it('R2 ruling 3: the cost of reading 60 names (logged)', async () => {
    const t0 = Date.now();
    expect(await failed('f-r2-60-unnamed', formFieldsProbe, '1.3.1')).toHaveLength(60);
    const withCdp = Date.now() - t0;
    const t1 = Date.now();
    await clean('f-r2-60-named', formFieldsProbe, '1.3.1');
    const without = Date.now() - t1;
    console.log(`F111 CDP cost: 60 candidates ${withCdp} ms, the same page labelled ${without} ms`);
    expect(withCdp).toBeLessThan(10_000);
  }, 60_000);
  it('batch 18 (G167 by words, lead\'s ruling Q2, superseding R3 ruling 2): a button that names what its field takes labels it; one that shares no word with the field\'s name labels nothing, and the field fails', async () => {
    await clean('f-g167-select', formFieldsProbe, '3.3.2');
    for (const page of ['f-g167-go', 'f-r2-learn-more', 'f-r2-submit-dot']) {
      expect((await failed(page, formFieldsProbe, '3.3.2')).map((f) => f.detail), page).toEqual([expect.stringContaining('names an action, not what to enter')]);
    }
    // Precision fix (lead's ruling 2026-11-13): a button with words other than an action's ("Send message", "Close
    // dialog", "Print page", "Learn more about privacy") may name the field in words its name does not use: listed for
    // the forms AI check, never failed by the absence of a shared word.
    for (const page of ['f-sol7-reply', 'f-r2-close', 'f-r3-print', 'f-r3-close', 'f-r3-privacy', 'f-r3-foreign-form']) {
      expect(await failed(page, formFieldsProbe, '3.3.2'), page).toEqual([]);
    }
  }, 240_000);
  it('a field with no visible label and no own button next to it still fails 3.3.2', async () => {
    expect(await failed('f-sol7-distant', formFieldsProbe, '3.3.2')).toHaveLength(1);
  }, 60_000);
  it('Yes/No radio buttons with no visible question fail 3.3.2; with one, or options that say enough, they pass', async () => {
    expect((await failed('f-radios-yes-no', formFieldsProbe, '3.3.2')).map((f) => f.detail)).toEqual([expect.stringMatching(/"Yes", "No" answer a question that is not shown/)]);
    await clean('f-radios-ok', formFieldsProbe, '3.3.2');
  }, 60_000);
  it('Sol 6: a fieldset legend around an unnamed role=group asks the question', async () => {
    await clean('f-sol6-nested-group', formFieldsProbe, '3.3.2');
  }, 30_000);
  it('Sol 14: 5000 same-name radio buttons are read in time, once per group', async () => {
    const t0 = Date.now();
    // The scan keeps its first 60 fields (the rest are reported untested, as before); no false failure, and quick.
    expect(await failed('f-sol14-many-radios', formFieldsProbe, '3.3.2')).toEqual([]);
    expect(Date.now() - t0).toBeLessThan(20_000);
    // With no legend each retained radio button used to read the whole 5000-member group again (300,000 visibility reads).
    const t1 = Date.now();
    await findings('f-sol14-no-legend', formFieldsProbe);
    expect(Date.now() - t1).toBeLessThan(6_000);
  }, 60_000);
});

describe('keyboard: order inside a container, snapped focus', () => {
  it('tabindex 3, 1, 4, 2 on fields 16 px apart fails 2.4.3 (F44); 1 to 4 in order passes', async () => {
    expect(await failed('k-tabindex-shuffle', keyboardProbe, '2.4.3')).not.toEqual([]);
    await clean('k-tabindex-in-order', keyboardProbe, '2.4.3');
  }, 120_000);
  it('Sol 2: focus that follows the HTML while CSS shows another order is a recommendation, never a failure', async () => {
    for (const page of ['k-row-reverse', 'k-sol2-legal']) {
      const all = await clean(page, keyboardProbe, '2.4.3');
      expect(all.filter((f) => f.advice).map((f) => f.detail), page).toEqual([expect.stringMatching(/which CSS shows before it/)]);
    }
    await clean('k-two-columns', keyboardProbe, '2.4.3');
  }, 180_000);
  it('a field scroll snapping leaves off screen is 2.4.11, never 2.4.3', async () => {
    const all = await findings('k-snap', keyboardProbe);
    expect(all.filter((f) => f.criterion === '2.4.3' && f.status === 'failed')).toEqual([]);
    expect(all.filter((f) => f.criterion === '2.4.11' && f.status === 'failed').map((f) => f.detail)).toEqual([expect.stringMatching(/scroll snapping leaves outside the visible area/)]);
  }, 120_000);
});

describe('key shortcuts and resize text', () => {
  it('q alone focusing the search field fails 2.1.4; Ctrl+q passes', async () => {
    expect(await failed('ks-letter-q', keyShortcutsProbe, '2.1.4')).toEqual([expect.objectContaining({ target: 'key "q"' })]);
    await clean('ks-ctrl-q', keyShortcutsProbe, '2.1.4');
  }, 90_000);
  it('Sol 9: a ticker updating every 300 ms with a page-wide listener that does nothing is no shortcut', async () => {
    const all = (await findings('ks-sol9-ticker', keyShortcutsProbe)).filter((f) => f.criterion === '2.1.4');
    expect(all.filter((f) => f.status === 'failed')).toEqual([]);
  }, 90_000);
  it('Sol 10: a hidden busy node does not cost the finding its time box', async () => {
    expect(await failed('ks-sol10-hidden-busy', keyShortcutsProbe, '2.1.4')).toEqual([expect.objectContaining({ target: 'key "q"' })]);
  }, 90_000);
  it("Sol 16: an apostrophe shortcut is found", async () => {
    expect(await failed('ks-sol16-apostrophe', keyShortcutsProbe, '2.1.4')).toEqual([expect.objectContaining({ target: 'key "\'"' })]);
  }, 90_000);
  it('whole lines a 40vh box hides at 200% zoom fail 1.4.4; min-height and a closed panel pass', async () => {
    expect(await failed('r-vh-box', resizeTextProbe, '1.4.4')).not.toEqual([]);
    await clean('r-vh-min-height', resizeTextProbe, '1.4.4');
  }, 90_000);
  it('Sol 8: lines hidden in a box with its own Previous/Next buttons are never failed (not testable at most)', async () => {
    for (const page of ['r-sol8-scroll-buttons', 'r-r2-body-buttons']) {
      const all = (await findings(page, resizeTextProbe)).filter((f) => f.criterion === '1.4.4');
      expect(all.filter((f) => f.status === 'failed'), page).toEqual([]);
    }
  }, 90_000);
  it('R3 ruling 3: any control near the box (an unrelated Print button, past a paragraph, named by aria-labelledby) makes it not testable, never failed', async () => {
    for (const page of ['r-r2-print', 'r-r3-intervening', 'r-r3-labelledby']) {
      const all = (await findings(page, resizeTextProbe)).filter((f) => f.criterion === '1.4.4');
      expect(all.map((f) => f.status), page).toEqual(['not_testable']);
    }
    // No control anywhere near: the lost lines fail.
    expect(await failed('r-vh-box', resizeTextProbe, '1.4.4')).not.toEqual([]);
  }, 120_000);
});

describe('runner: the content wait', () => {
  it('Sol 11: a document a whole wait ran out on is marked in the page, so a new document is waited for again', async () => {
    const { contentShown, markBusyGaveUp } = await import('../../src/probes/ready.js');
    const page = await browser.newPage();
    try {
      await page.setContent('<main aria-busy="true">Loading</main>');
      expect(await page.evaluate(contentShown)).toBe(false);
      await page.evaluate(markBusyGaveUp);
      expect(await page.evaluate(contentShown)).toBe(true);
      await page.goto(`${server.origin}/run-sol12-replace.html`);
      expect(await page.evaluate(contentShown)).toBe(false);
      // Hidden busy nodes do not hold the wait (Sol 10); [role=main] counts like main.
      await page.setContent('<div role="main"><span hidden aria-busy="true">x</span><p>Text</p></div>');
      expect(await page.evaluate(contentShown)).toBe(true);
      await page.setContent('<div role="main"><p aria-busy="true">Loading</p><p>Text</p></div>');
      expect(await page.evaluate(contentShown)).toBe(false);
    } finally {
      await page.close();
    }
  }, 30_000);
  it('Sol 12: a document replaced while the wait runs is not tested as the page', async () => {
    const rs = await runs('run-sol12-replace', headingsProbe);
    expect(rs.flatMap((r) => r.findings).filter((f) => f.status === 'failed' || f.status === 'no_failures_found')).toEqual([]);
  }, 60_000);
});

describe("R3 ruling 1 (c'): axe p-as-heading leaves out live regions, and lists real bold-paragraph headings for review", () => {
  it("Sol's role=status \"Saved successfully\" scores 100: the rule passes", async () => {
    const r = await scanSite(`${server.origin}/axe-r3-status.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    expect(r.score).toBe(100);
  }, 60_000);
  it('the same bold paragraphs inside aria-live and inside a status shadow component pass', async () => {
    const r = await scanSite(`${server.origin}/axe-r3-live.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
  }, 60_000);
  // Batch 17 (lead's ruling d): p-as-heading is a trigger only. Outside a live region its nodes are listed for review
  // ("undecided by the rules"), never a failure; a styled paragraph fails 1.3.1 through the headings test's proofs.
  it('bold paragraphs styled as section headings outside any live region are listed for review, not failed, by axe', async () => {
    const r = await scanSite(`${server.origin}/axe-r3-bold-p.html`, { browser: browser as unknown as BrowserLike, maxPages: 1, probes: false, documents: false });
    expect(r.rules.map((x) => x.id)).not.toContain('p-as-heading');
    expect(r.needsReview.map((x) => x.id)).toContain('p-as-heading');
    expect(r.score).toBe(100);
  }, 60_000);
});
