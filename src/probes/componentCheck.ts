// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The targeted check (review r1 of the coverage lane, 2026-11-10; lead's ruling 1+2): a failure a slow test
// measured on an element is a reason to **measure the same kind of element on the other pages that carry
// it**, never a result for them. A pattern may trigger a check; it never stands in for one.
//
// A page gets this check when a slow test did not run on it and it carries an element of a kind that failed
// that test elsewhere (src/probes/components.ts `componentChecks`). The check finds the page's own element of
// that kind and measures it alone, with the test's own measurement:
// - 2.4.7 and 1.4.11 (the focus indicator and its contrast): the element is given keyboard focus (focused,
//   Shift+Tab away, Tab back on to it) and the keyboard walk's own stop measurement runs on it (`pass`);
// - 3.2.1 (a change of context on focus): the same stop, and the walk's own confirmation that the change
//   happens again when the element is focused once more (`confirmOnFocus`);
// - 2.1.1 (answers the mouse, cannot take the keyboard): the keyboard test's own scan of the page
//   (`clickables`, no key is pressed), kept for the elements asked for.
// 4.1.2 from the screen-reader test needs no check of its own: that test is cheap, so it runs whole on the
// page (`CHECKS` in components.ts).
//
// Only a failure measured here is reported, on this page's own element (its own selector, its own evidence).
// An element that is not found, cannot take focus, is hidden, or that Tab does not come back to gives nothing:
// no failure, and no "tested, clean" either. Engine core: no Node-only imports.
import { KINDS_LIMITS, kindsOfTargets, readKinds, targetsOfKinds } from '../collect/kinds.js';
import type { ProbeFinding } from '../types.js';
import { traversalFindings } from './keyboard/findings.js';
import { clickables, keyboardProbe } from './keyboard/index.js';
import { kitByPath, kitFocusId, kitRestore, kitStop, kitTabbables, kitTopFinish, kitTopPrepare } from './keyboard/page.js';
import { KEYBOARD_LIMITS } from './keyboard/rules.js';
import { confirmOnFocus, pass, pressAndMeasure, startKit, type Stop, type Traversal } from './keyboard/traverse.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

export const CHECK = {
  /** Elements given focus and measured per page (the first kinds asked for). */
  perPage: 8,
  /** Soft budget for one page's check; what was measured by then is reported. */
  budgetMs: 12_000,
  /** Hard time box of one page's check. */
  timeoutMs: 25_000,
} as const;

/** The criteria the targeted check can measure on one element, with the keyboard test's own measurement. */
export const CHECK_CRITERIA = ['1.4.11', '2.1.1', '2.4.7', '3.2.1'] as const;

/** Where a page's check list travels: a key in the page's collected values (`ProbeContext.collected`). */
export const CHECK_KEY = 'componentCheck';

/** One element kind to measure on a page: the criteria it failed elsewhere, and a page it failed on. */
export interface CheckWanted {
  kind: string;
  criteria: string[];
  from: string;
}

function wantedOf(collected: Record<string, unknown> | undefined): CheckWanted[] {
  const v = collected?.[CHECK_KEY];
  if (!Array.isArray(v)) return [];
  return v.filter((w): w is CheckWanted => !!w && typeof w === 'object' && typeof (w as CheckWanted).kind === 'string' && Array.isArray((w as CheckWanted).criteria));
}

const stripHash = (u: string) => u.split('#')[0]!;

async function checkElements(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const wanted = wantedOf(ctx.collected);
  if (!wanted.length) return [];
  const { page } = ctx;
  if (!page.keyboard) throw new ProbeNotTestable('the browser cannot send key presses to this page');
  const criteriaOf = new Map(wanted.map((w) => [w.kind, new Set(w.criteria)]));
  // This page's own elements of those kinds, as the page was when it loaded.
  let found = await page.evaluate(targetsOfKinds, wanted.map((w) => w.kind));
  if (found === null) {
    await page.evaluate(readKinds, { ...KINDS_LIMITS, stash: true });
    found = await page.evaluate(targetsOfKinds, wanted.map((w) => w.kind));
  }
  const started = Date.now();
  const until = () => ctx.signal.aborted || Date.now() > Math.min(started + CHECK.budgetMs, ctx.deadline - 3000);
  const pageUrl = stripHash(page.url?.() ?? ctx.url);
  const out: ProbeFinding[] = [];
  const mark = ctx.guard.mark();
  await startKit(ctx);
  try {
    // 2.1.1: what answers the mouse and cannot take the keyboard, among the kinds asked for.
    if (wanted.some((w) => w.criteria.includes('2.1.1'))) {
      const failed = (await clickables(ctx)).filter((f) => f.status === 'failed' && typeof f.target === 'string');
      const kinds = failed.length ? await page.evaluate(kindsOfTargets, failed.map((f) => f.target!)) : null;
      failed.forEach((f, i) => {
        const kind = kinds?.[i];
        if (kind && criteriaOf.get(kind)?.has('2.1.1')) out.push(f);
      });
    }
    const onFocus = (found ?? []).filter((t) => [...(criteriaOf.get(t.kind) ?? [])].some((c) => c !== '2.1.1')).slice(0, CHECK.perPage);
    if (!onFocus.length || until()) return out;
    // As the walk begins: one Tab from the top, so focus moves by keyboard from here on.
    await page.evaluate(kitTopPrepare, undefined);
    await page.keyboard.press('Tab');
    await page.evaluate(kitTopFinish, undefined);
    const stops: Stop[] = [];
    const kindOf = new Map<number, string>();
    for (const t of onFocus) {
      if (until()) break;
      const id = await page.evaluate(kitByPath, t.selector);
      // Not there, or it cannot take focus (hidden on this page, disabled): nothing is measured.
      if (!id || !(await page.evaluate(kitFocusId, id))) continue;
      // Reached with the keyboard: Shift+Tab away from it, then Tab back, measured as the walk measures a stop.
      await pressAndMeasure(ctx, 'Shift+Tab', null, true);
      const walked = await pass(ctx, {
        key: 'Tab', dir: 'forward', max: 1, maxCycle: KEYBOARD_LIMITS.core.maxCycle,
        samples: { seen: new Set(), left: 1, skipped: new Set(), contrast: [...(criteriaOf.get(t.kind) ?? [])].includes('1.4.11') },
        // No pictures from a check: the stop measured may turn out not to be the element asked for.
        until, shots: { obscured: true, focus: true, covers: new Map() },
      });
      const stop = walked.stops[0];
      // Tab did not bring focus back to it (another order on this page, a frame before it): not measured.
      if (!stop || stop.id !== id) continue;
      stops.push(stop);
      kindOf.set(stop.id, t.kind);
    }
    if (!stops.length) return out;
    const confirmed = await confirmOnFocus(ctx, stops, pageUrl, false, mark);
    const walk: Traversal = {
      forward: stops, backward: [], traps: [], skips: [], layout: { hasMain: true, headings: 0 },
      tabbables: await page.evaluate(kitTabbables, 2000), partial: false, skipsUntested: 0, noFocus: false, viewportHeight: ctx.viewport.height,
    };
    for (const f of traversalFindings(walk, ['1.4.11', '2.4.7', '3.2.1'], pageUrl)) {
      if (f.status !== 'failed' || typeof f.target !== 'string') continue;
      const stop = stops.find((s) => s.path === f.target);
      const kind = stop ? kindOf.get(stop.id) : undefined;
      if (!kind || !criteriaOf.get(kind)?.has(f.criterion)) continue;
      // A change of context that could not be told from the page's own (it navigates by itself): not reported.
      if (f.criterion === '3.2.1' && confirmed !== 'done') continue;
      out.push(f);
    }
    return out;
  } finally {
    await page.evaluate(kitRestore, page.url?.() ?? ctx.url).catch(() => {});
    await page.evaluate(kitStop, undefined).catch(() => {});
  }
}

/**
 * The keyboard test's targeted check. It carries the keyboard test's id: what it measures is that test's
 * measurement, so its findings are that test's for the page (`ProbeRun.checked` says it was a check of
 * single elements, not the whole test). Never registered with the other tests (src/probes/registry.ts): the
 * scan runs it on its own runner, after every other test, as optional work (src/probes/sample.ts).
 */
export const keyboardCheckProbe: PageProbe = {
  id: keyboardProbe.id,
  criteria: [...CHECK_CRITERIA],
  kind: keyboardProbe.kind,
  tier: 'core',
  timeoutMs: CHECK.timeoutMs,
  run: checkElements,
};
