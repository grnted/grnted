// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Keyboard and focus probes (Plan 4 Task 4.1):
// - `keyboard` (core): 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 3.2.1 on the first 60 Tab stops and
//   the last 40 (Shift+Tab), 25 focus indicators measured, and 1.4.11 for those drawn as a ring;
// - `keyboard-deep` (deep, `--full`): the same traversal rules on long pages, up to 300 stops each way
//   and 100 focus indicators; not applicable when the core test already covered every stop;
// - `key-shortcuts` (core): 2.1.4.
// Rules and thresholds: ./rules.ts. Engine core: no Node-only imports.
import type { ProbeFinding } from '../../types.js';
import { pageWords, shootElements } from '../evidence.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from '../types.js';
import { contentShown, LATE_CONTENT_MS, waitForContent } from '../ready.js';
import { clickableFindings, isListedClickable, MAX_LISTED_CLICKABLES, traversalFindings } from './findings.js';
import { focusOrderData } from './orderData.js';
import { kitClickables, kitStop, kitTabbables, type ClickableGroup } from './page.js';
import { bounded, callMs, controlsOutsideFrame, FRAME_CALL_MS, frameProbeContext, settleFrames } from '../frameContext.js';
import { frameGapFindings, frameWords, ownFrames } from '../frameLayout.js';
import { KEYBOARD_LIMITS, label } from './rules.js';
import { fullLogFindings, navigationRace, startKit, takeFocusShots, traverse, type Limits } from './traverse.js';

export { keyShortcutsProbe } from './shortcuts.js';

/** Listener types that make an element respond to the mouse. */
const CLICK_TYPES = new Set(['click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup']);

function needKeyboard(ctx: ProbeContext): void {
  if (!ctx.page.keyboard) throw new ProbeNotTestable('the browser cannot send key presses to this page');
}

/** The longest wait for the page's own frames to finish loading before they are looked into. */
const FRAME_SETTLE_MS = 3000;
/**
 * The frame pass's whole budget, settling included (fix round 1, F3), and the time it always leaves the walk: a
 * page's frames never cost the walk more, and a frame that does not answer costs only its own coverage.
 */
export const FRAME_PASS = { ms: 8000, walkMs: 30_000 } as const;

/** The recorded click and pointer listeners of the context's document, by element ref. */
async function clickRefs(ctx: ProbeContext): Promise<{ ref: number; types: string[] }[]> {
  const byRef = new Map<number, string[]>();
  // Handlers written on elements in open shadow roots too (fix round 2, S7), for this rule only (round 4, S4).
  for (const l of await ctx.listeners({ shadowInline: true })) {
    // Elements inside shadow roots too: the ref resolves to the inner element, which is tested.
    if (l.target.kind !== 'element' || !CLICK_TYPES.has(l.type)) continue;
    byRef.set(l.ref, [...(byRef.get(l.ref) ?? []), l.type]);
  }
  return [...byRef.entries()].map(([ref, types]) => ({ ref, types }));
}

/** 2.1.1 from the recorded listeners and pointer cursors (before any key is pressed). */
export async function clickables(ctx: ProbeContext): Promise<ProbeFinding[]> {
  let refs: { ref: number; types: string[] }[];
  try {
    refs = await clickRefs(ctx);
  } catch (err) {
    const reason = err instanceof Error && err.name === 'ProbeNotTestable' ? err.message : 'the event listeners on this page could not be read';
    return [{ criterion: '2.1.1', status: 'not_testable', detail: reason }];
  }
  return clickableFindings(await ctx.page.evaluate(kitClickables, { refs, max: 20 }));
}

/**
 * The same 2.1.1 rule inside the page's own embedded frames (same origin, shown and big enough: `ownFrames`;
 * keyboard-op lane, 2026-11-11): a calendar or a map in a frame from the site is part of the page, and an element
 * there that answers the mouse and cannot get focus is as unusable from the keyboard as one in the page itself.
 * Its finding names the element through the frame (`<frame> >>> <element>`). An element whose name a control
 * outside the frame also has, or in a frame that a control outside it points at, is not failed: that control
 * may do the same, and nothing here presses it. A frame that should have been looked into and could not be
 * leaves 2.1.1 not testable (as the layout tests do); a frame that cannot hold a control a person can use is no
 * gap (`settleFrames`). Every call into a frame is bounded and the pass has a budget of its own (`FRAME_PASS`): a
 * frame that does not answer is a gap for 2.1.1 alone, never the walk's time. Never throws.
 */
export async function frameClickables(ctx: ProbeContext, walkMs: number = FRAME_PASS.walkMs, listedSoFar = 0): Promise<ProbeFinding[]> {
  // No child frame: no browser round trip.
  try { if ((ctx.page.frames?.() ?? []).length <= 1) return []; } catch { return []; }
  // Every call into a frame or about one is bounded, and the whole pass ends by `end`, leaving the walk `walkMs`
  // (fix round 1, F3).
  const end = Math.min(Date.now() + FRAME_PASS.ms, ctx.deadline - walkMs);
  const gaps: { path: string; why: string }[] = [];
  const out: ProbeFinding[] = [];
  let listed = listedSoFar;
  // A frame still loading shows nothing yet: wait for it, briefly (one that never loads is a gap; one that cannot hold a
  // control, or holds a document file, is nothing to look into).
  const unloaded = await settleFrames(ctx.page, Math.min(FRAME_SETTLE_MS, Math.max(0, end - Date.now())), { guard: ctx.guard, deadline: end, scroll: true });
  gaps.push(...unloaded);
  const own = await ownFrames(ctx.page, { callMs: FRAME_CALL_MS, deadline: end }).catch(() => ({ frames: [], gaps: [] }));
  gaps.push(...own.gaps);
  for (const f of own.frames) {
    if (Date.now() >= end - 300) { gaps.push({ path: f.path, why: 'the time for looking into frames ran out' }); continue; }
    const fctx = frameProbeContext({ ...ctx, deadline: end }, f);
    let groups: ClickableGroup[];
    try {
      await startKit(fctx);
      try {
        groups = await fctx.page.evaluate(kitClickables, { refs: await clickRefs(fctx), max: 20 });
      } finally {
        await fctx.page.evaluate(kitStop, undefined).catch(() => {});
      }
    } catch {
      gaps.push({ path: f.path, why: 'its event listeners could not be read' });
      continue;
    }
    if (!groups.length) continue;
    const handle = await bounded(callMs(end), f.frame.frameElement()).catch(() => null);
    const outside = handle ? await bounded(callMs(end), ctx.page.evaluate(controlsOutsideFrame, { el: handle, names: groups.map((g) => g.name ?? '') })).catch(() => null) : null;
    if (!outside) { gaps.push({ path: f.path, why: 'the controls outside it could not be read' }); continue; }
    const words = frameWords({ name: f.name });
    groups.forEach((g, i) => {
      const why = outside.pointing ? 'a control outside the frame points at it' : outside.named[i] ? 'a control outside the frame has the same name' : '';
      // The final disposition first (round 4, S5): a candidate, or a group that would fail but is noted as undecided
      // because a control outside the frame may do the same. Every undecided note counts toward the cap over the page
      // and all its frames together (`listedSoFar`: the page's own); a failure that stands is never capped.
      if (g.listed || why) {
        if (listed >= MAX_LISTED_CLICKABLES) return;
        listed++;
      }
      const target = `${f.path} >>> ${g.path}`;
      if (why) {
        out.push({ criterion: '2.1.1', status: 'not_testable', target, detail: `${words}${label(g.name, g.path)} responds to the mouse but cannot get keyboard focus; ${why}, which may do the same with the keyboard, and this test does not press it.` });
        return;
      }
      for (const x of clickableFindings([g])) out.push({ ...x, target, detail: `${words}${x.detail}` });
    });
  }
  return [...out, ...frameGapFindings('2.1.1', gaps, 'for elements that answer only the mouse')];
}

/** 2.1.1 from the listeners of the page and of its own frames, with the candidates capped over both together. */
export async function allClickables(ctx: ProbeContext, walkMs?: number): Promise<ProbeFinding[]> {
  const page = await clickables(ctx);
  return [...page, ...(await frameClickables(ctx, walkMs, page.filter(isListedClickable).length))];
}

/**
 * Report evidence for 2.4.3 when a positive tabindex sends focus back up the page: the element with
 * the tabindex, boxed (and marked on the start page's first screen). Never throws.
 */
async function orderEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[]): Promise<void> {
  const f = findings.find((x) => x.criterion === '2.4.3' && x.status === 'failed' && /tabindex="/.test(x.detail) && !!x.target && !x.target.includes(' >>> '));
  if (!f) return;
  const tab = /tabindex="(-?\d+)"/.exec(f.detail)?.[1];
  await shootElements(ctx, {
    criterion: '2.4.3', handles: [{ sel: f.target! }],
    caption: `tabindex="${tab ?? '1'}" moves focus out of reading order`,
    alt: (title) => `${pageWords(title)}: the outlined element has a positive tabindex, so the Tab key jumps to it out of the order the page is read in.`,
  });
}

async function runKeyboard(ctx: ProbeContext, probe: PageProbe, limits: Limits, core: boolean): Promise<ProbeFinding[]> {
  const mark = ctx.guard.mark();
  return keyboard(ctx, probe, limits, core).catch((err) => navigationRace(ctx, mark, err));
}

/** Time the second walk of a late page needs at least (a short page's walk). */
const LATE_WALK_RESERVE_MS = 8000;

async function keyboard(ctx: ProbeContext, probe: PageProbe, limits: Limits, core: boolean): Promise<ProbeFinding[]> {
  needKeyboard(ctx);
  const pageUrl = ctx.page.url?.() ?? ctx.url;
  await startKit(ctx);
  try {
    if (!core) {
      const n = await ctx.page.evaluate(kitTabbables, KEYBOARD_LIMITS.core.forward + 1);
      if (n <= KEYBOARD_LIMITS.core.forward) {
        return probe.criteria.map((criterion) => ({
          criterion, status: 'not_applicable',
          detail: `the core keyboard test already covers every focus stop on this page (${n})`,
        }));
      }
    }
    // A page that is still putting its content in when the walk starts (an app shell that says "Loading…")
    // has nothing to focus yet: the walk would end at once with "nothing takes keyboard focus".
    const shownAtStart = core ? await ctx.page.evaluate(contentShown, undefined).catch(() => true) : true;
    const options = { skipLinks: probe.criteria.includes('2.4.1'), focusContrast: probe.criteria.includes('1.4.11') };
    let findings = core ? await allClickables(ctx) : [];
    let t = await traverse(ctx, limits, options);
    if (shownAtStart === false && !t.forward.length && !t.backward.length && !t.cutReason && !t.partial) {
      // Once its content is shown (at most LATE_CONTENT_MS), the page is walked again; a page that never
      // shows any keeps the first result.
      const left = ctx.deadline - Date.now() - LATE_WALK_RESERVE_MS;
      if (left > 0 && (await waitForContent(ctx.page, Math.min(LATE_CONTENT_MS, left), 2000, ctx.signal)) === 'shown') {
        findings = await allClickables(ctx, LATE_WALK_RESERVE_MS);
        t = await traverse(ctx, limits, options);
      }
    }
    findings.push(...traversalFindings(t, probe.criteria, pageUrl));
    await orderEvidence(ctx, findings);
    // Measured covering elements (2.4.11), as evidence for the AI review.
    const covers = new Map<string, number>();
    for (const s of [...t.forward, ...t.backward]) if (s.obscuredBy && s.coverHeight !== undefined && !covers.has(s.obscuredBy)) covers.set(s.obscuredBy, s.coverHeight);
    // The Tab order followed, as evidence for the AI focus-order review (2.4.3); it changes no finding.
    const order = focusOrderData(t);
    const data = {
      ...(covers.size ? { focusObscured: [...covers].map(([cover, coverHeight]) => ({ cover: cover.slice(0, 200), coverHeight })) } : {}),
      ...(order.stops.length ? { focusOrder: order } : {}),
    };
    if (Object.keys(data).length) ctx.setData?.(data);
    // The measured stops' pictures, unfocused and focused, for the AI review only (never in the run or the report).
    const shots = takeFocusShots(ctx);
    if (shots.length) ctx.attach?.({ focusShots: shots });
    // A full guard log proves nothing: every criterion without a failure is not testable.
    findings.push(...fullLogFindings(ctx, probe.criteria, findings));
    return findings;
  } finally {
    await ctx.page.evaluate(kitStop, undefined).catch(() => {});
  }
}

export const keyboardProbe: PageProbe = {
  id: 'keyboard',
  criteria: ['1.4.11', '2.1.1', '2.1.2', '2.4.1', '2.4.3', '2.4.7', '2.4.11', '3.2.1'],
  kind: 'interaction',
  tier: 'core',
  // 25 s until 2026-11-07: every stop now waits until focus has stayed put 100 ms (Grok round 2), up to 100 stops
  // (60 Tab, 40 Shift+Tab), so a remote browser's walk (150 ms a call: about 0.45 s a stop) needs up to 45 s.
  timeoutMs: 45_000,
  run(ctx) {
    return runKeyboard(ctx, keyboardProbe, { ...KEYBOARD_LIMITS.core, full: KEYBOARD_LIMITS.deep }, true);
  },
};

export const keyboardDeepProbe: PageProbe = {
  // Scoring v8: listed, not scored until a gold-standard mutation verifies it (docs/scoring.md).
  scored: false,
  id: 'keyboard-deep',
  criteria: ['1.4.11', '2.1.2', '2.4.3', '2.4.7', '2.4.11', '3.2.1'],
  kind: 'interaction',
  tier: 'deep',
  timeoutMs: 120_000,
  run(ctx) {
    return runKeyboard(ctx, keyboardDeepProbe, KEYBOARD_LIMITS.deep, false);
  },
};
