// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The target plan: what an AI navigator found worth exercising on a page (carousels moved by swiping, and
// groups of fields sent without a form element), handed to the existing tests as EXTRA targets. Both tests
// run with the strict guard (nothing leaves the browser). The navigator only picks elements from a summary of the page; it never
// decides a result. Each test runs its own logic on a planned target, after its own targets, and only a
// planned target's failure (or a clean measurement where the test found nothing to test) is added to what
// the test found by itself. Engine core: no Node-only or AI imports (the AI side lives in src/ai/navigator.ts).
import type { PageLike, ProbeFinding } from '../types.js';
import { isActionName } from './pointerKit.js';

/**
 * Words that name an action on the person's account, money, messages or data (the pointer tests' list,
 * plus a few more): a planned element named or linked so is refused, whatever kind the planner gave it.
 */
const MORE_ACTIONS = /\b(cart|bag|basket|checkout|transfer|confirm|erase|vote|unsubscribe|book\s+now|reserve|send\s+money|withdraw)\b/i;
export function isActionTarget(e: Pick<NavElement, 'name' | 'text' | 'attrs'>): boolean {
  const words = [e.name, e.text, e.attrs['aria-label'], e.attrs.title, e.attrs.to].filter((x): x is string => !!x).join(' ').replace(/[-_/]+/g, ' ');
  return isActionName(words) || MORE_ACTIONS.test(words);
}


/** What a planned element is. The planner picks one per element. */
export const TARGET_KINDS = ['carousel', 'form'] as const;
export type TargetKind = (typeof TARGET_KINDS)[number];

/**
 * The tests each kind may feed (decided here, not by the planner: its suggestion is intersected with this).
 * pointer-gestures: content moved by swiping (2.5.1); forms: a group of fields and the control that sends it,
 * pressed with the fields empty (3.3.1, 3.3.3, 4.1.3). Both run with the strict guard.
 */
export const KIND_TESTS: Readonly<Record<TargetKind, readonly string[]>> = {
  carousel: ['pointer-gestures'],
  form: ['forms'],
};

/** The tests that take planned targets. */
export const PLANNED_TESTS: readonly string[] = [...new Set(Object.values(KIND_TESTS).flat())].sort();

/** One element the tests should exercise, as a selector into a fresh load of the page. */
export interface PlannedTarget {
  selector: string;
  kind: TargetKind;
  /** The tests that run on it (`KIND_TESTS[kind]`, narrowed by the planner's own choice when it gave one). */
  tests: string[];
  /** Its accessible name or text as the summary saw it (diagnostics only). */
  name?: string;
  /** For a form: the control that sends it. */
  submit?: string;
}

/** A page's plan, resolved against the summary it was made from. */
export interface TargetPlan {
  targets: PlannedTarget[];
  model: string;
  /** The cache key it was stored under (the summary's hash, the prompt, the model and its effort). */
  key: string;
  cached: boolean;
}

/** One element of the page summary the planner sees. */
export interface NavElement {
  /** Its number in the summary (what the planner answers with). */
  ref: number;
  /** A CSS selector that finds it in a fresh load of the page. */
  sel: string;
  tag: string;
  role?: string;
  name?: string;
  /** Its own visible text, when it differs from the name. */
  text?: string;
  /** Selected attributes (aria-*, type, tabindex, href kind, classes, id). */
  attrs: Record<string, string>;
  /** [x, y, width, height] in CSS px of the document, rounded to 4 px. */
  box: [number, number, number, number];
  /** Reached with the Tab key (focusable, not tabindex="-1", not disabled). */
  tab: boolean;
  /** Shows a pointer, help or grab cursor (its parent does not). */
  cursor?: string;
  /** Event types it listens to itself (click, mouseover, pointerdown, keydown, …). */
  on?: string[];
  /** The summary's nearest ancestor that is also listed. */
  in?: number;
}

export interface NavSummary {
  viewport: { width: number; height: number };
  /** The document's height (CSS px). */
  height: number;
  title: string;
  elements: NavElement[];
  /** Event types the page listens to on the document or the window (delegated handlers). */
  page: string[];
  /** More elements qualified than the cap allowed. */
  truncated: boolean;
}

/** What the navigator gets for one page. */
export interface NavigatorInput {
  url: string;
  summary: NavSummary;
  /** JPEG of the page from the top (at most `PLAN_CAPTURE.maxShotHeight` px tall); absent when it failed. */
  screenshot?: Uint8Array;
  maxTargets: number;
}

/** What the navigator answers: summary refs, each with a kind and the tests it suggests. */
export interface RawPlan {
  targets: { ref: number; kind: string; tests?: readonly string[]; submit?: number | null }[];
  model: string;
  key: string;
  cached: boolean;
}

/** Diagnostics for one page's plan (timing runs and the eval; never in the report). */
export interface PlanEvent {
  page: string;
  /**
   * 'planned': a plan came back (maybe with no target); otherwise why the page has none. 'cutoff': the plan was
   * wanted by optional tests only and their time was over before its capture, or before the navigator would
   * have been called: the navigator was not called.
   */
  outcome: 'planned' | 'late' | 'failed' | 'no-capture' | 'cutoff';
  targets: number;
  ms: number;
  cached?: boolean;
  /** The summary's size (elements). */
  elements?: number;
}

/**
 * The navigator, as the probe runner uses it (engine core: it never imports the AI side). `plan` must not
 * throw; it answers null when it has no plan (no key, time out, rate limit, error).
 */
export interface NavigatorHook {
  /** Planned targets per page, at most. */
  maxTargets: number;
  /** The navigator reads a screenshot too (the capture takes one only then). */
  screenshot?: boolean;
  /**
   * Longest wait for a page's plan, from when its tests are queued (ms). Past it, the tests run on their own
   * targets only, and a plan that comes later is not used.
   */
  budgetMs: number;
  plan(input: NavigatorInput, signal: AbortSignal): Promise<RawPlan | null>;
  /** Diagnostics: each page's plan, or why it has none. Must not throw. */
  onPlan?(e: PlanEvent): void;
}

/** Caps of the page summary and the screenshot. */
export const PLAN_CAPTURE = {
  elements: 250,
  scanned: 6000,
  text: 60,
  classes: 3,
  maxShotHeight: 3000,
  shotQuality: 60,
  /** Time boxes (ms) of the summary and of the screenshot. */
  summaryMs: 4000,
  shotMs: 6000,
} as const;

/**
 * Runs in the page (self-contained): the summary of what a person can operate or see change. Rendered
 * elements only, in document order: native controls, anything with a role, a tabindex, aria state or an
 * inline handler, elements with their own listeners (`arg.listeners`, from the listener hook), elements
 * whose cursor says they can be pressed, and elements named like widgets (menu, tab, carousel, modal, …).
 */
export function navSummary(arg: { listeners: { ref: number; types: string[] }[]; page: string[]; caps: { elements: number; scanned: number; text: number; classes: number } }): NavSummary {
  const caps = arg.caps;
  const win = window as unknown as { __grntedTarget?: (ref: number) => unknown };
  const clean = (s: string | null | undefined, n: number) => {
    const t = (s ?? '').replace(/\s+/g, ' ').trim();
    return t.length > n ? `${t.slice(0, n - 1)}…` : t;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    return parts.join(' > ');
  };
  const on = new Map<Element, Set<string>>();
  for (const l of arg.listeners) {
    const el = win.__grntedTarget?.(l.ref);
    if (!(el instanceof Element)) continue;
    const set = on.get(el) ?? new Set<string>();
    for (const t of l.types) set.add(t);
    on.set(el, set);
  }
  const NATIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, details, dialog, video, audio, iframe, form, [contenteditable]:not([contenteditable="false"])';
  const MARKED = '[role], [tabindex], [aria-expanded], [aria-haspopup], [aria-controls], [aria-describedby], [aria-selected], [aria-pressed], [onclick], [onmouseover], [data-toggle], [data-bs-toggle], [data-tooltip]';
  const WIDGET = /menu|nav|burger|toggle|dropdown|drop-down|tab|accordion|collaps|expand|disclos|carousel|slider|slide|swiper|gallery|modal|dialog|popup|pop-up|lightbox|drawer|tooltip|tip\b|popover|select|combo|picker|player|video|form|field|submit|send/i;
  const POINTER = /^(pointer|help|grab|zoom-in)$/;
  const rendered = (el: Element): DOMRect | null => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return null;
    const s = getComputedStyle(el);
    if (s.visibility === 'hidden' || s.display === 'none') return null;
    if (typeof (el as HTMLElement).checkVisibility === 'function' && !(el as HTMLElement).checkVisibility({ opacityProperty: true, visibilityProperty: true })) return null;
    return r;
  };
  const tabbable = (el: Element): boolean => {
    const h = el as HTMLElement;
    if ((h as HTMLButtonElement).disabled) return false;
    if (h.tabIndex < 0) return false;
    if (el.matches('a[href], area[href], button, input:not([type="hidden"]), select, textarea, summary, iframe, [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]')) return true;
    return el.hasAttribute('tabindex');
  };
  const nameOf = (el: Element): string => {
    const a = el.getAttribute('aria-label');
    if (a && a.trim()) return clean(a, caps.text);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      if (t.trim()) return clean(t, caps.text);
    }
    if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
      if (el.labels?.length) return clean([...el.labels].map((l) => l.textContent).join(' '), caps.text);
      return clean(el.getAttribute('placeholder') || el.getAttribute('title'), caps.text);
    }
    if (el instanceof HTMLImageElement) return clean(el.alt, caps.text);
    return clean(el.getAttribute('title'), caps.text);
  };
  const ATTRS = ['type', 'aria-expanded', 'aria-haspopup', 'aria-controls', 'aria-selected', 'aria-pressed', 'aria-modal', 'aria-describedby', 'aria-roledescription', 'aria-hidden', 'tabindex', 'disabled', 'required', 'autocomplete'];
  // Pass 1: what qualifies, in document order. Pass 2: the cap goes first to what the tests' heuristics may
  // miss (plain elements with a role, listeners, a pointer cursor, a widget-like name), then to native
  // controls (links to other pages last); the summary keeps document order.
  const found: { el: Element; r: DOMRect; rank: number; cursor: string | undefined; listens: Set<string> | undefined }[] = [];
  const all = document.body ? document.body.getElementsByTagName('*') : document.getElementsByTagName('*');
  for (let i = 0; i < all.length && i < caps.scanned; i++) {
    const el = all[i]!;
    if (/^(script|style|link|meta|noscript|template|br|wbr|source|track|path|g|defs|use|symbol)$/.test(el.localName)) continue;
    const listens = on.get(el);
    const cls = typeof el.className === 'string' ? el.className : '';
    const cursor = getComputedStyle(el).cursor;
    const ownCursor = POINTER.test(cursor) && !(el.parentElement && getComputedStyle(el.parentElement).cursor === cursor);
    const native = el.matches(NATIVE);
    const plain = el.matches(MARKED) || !!listens || ownCursor || WIDGET.test(`${el.id} ${cls}`);
    if (!native && !plain) continue;
    const r = rendered(el);
    if (!r) continue;
    const pageLink = el instanceof HTMLAnchorElement && !/^\s*(#|javascript:|$)/i.test(el.getAttribute('href') ?? '');
    found.push({ el, r, rank: plain && !native ? 0 : pageLink ? 2 : 1, cursor: ownCursor ? cursor : undefined, listens });
  }
  const chosen = new Set(found.map((f, i) => ({ f, i })).sort((a, b) => a.f.rank - b.f.rank || a.i - b.i).slice(0, caps.elements).map((x) => x.f));
  const truncated = found.length > chosen.size;
  const kept = new Map<Element, NavElement>();
  const elements: NavElement[] = [];
  for (const f of found) {
    if (!chosen.has(f)) continue;
    const { el, r, cursor, listens } = f;
    const cls = typeof el.className === 'string' ? el.className : '';
    const attrs: Record<string, string> = {};
    for (const a of ATTRS) {
      const v = el.getAttribute(a);
      if (v !== null) attrs[a] = clean(v, 40);
    }
    if (el.id) attrs.id = clean(el.id, 40);
    const classes = cls.split(/\s+/).filter(Boolean).slice(0, caps.classes).map((c) => c.slice(0, 30));
    if (classes.length) attrs.class = classes.join(' ');
    if (el instanceof HTMLAnchorElement) {
      const h = el.getAttribute('href') ?? '';
      attrs.href = /^\s*javascript:/i.test(h) ? 'javascript' : h.trim() === '' || h.trim() === '#' ? '#' : h.trim().startsWith('#') ? 'fragment' : 'page';
      if (attrs.href === 'page') { try { const u = new URL(h, location.href); attrs.to = clean(`${u.pathname}${u.search}`, 60); } catch { /* not a URL */ } }
    }
    let parent: number | undefined;
    for (let a = el.parentElement; a; a = a.parentElement) {
      const k = kept.get(a);
      if (k) { parent = k.ref; break; }
    }
    const text = clean((el as HTMLElement).innerText ?? el.textContent, caps.text);
    const name = nameOf(el);
    const round = (n: number) => Math.round(n / 4) * 4;
    const item: NavElement = {
      ref: elements.length,
      sel: cssPath(el),
      tag: el.localName,
      ...(el.getAttribute('role') ? { role: clean(el.getAttribute('role'), 30) } : {}),
      ...(name ? { name } : {}),
      ...(text && text !== name ? { text } : {}),
      attrs,
      box: [round(r.left + scrollX), round(r.top + scrollY), round(r.width), round(r.height)],
      tab: tabbable(el),
      ...(cursor ? { cursor } : {}),
      ...(listens ? { on: [...listens].sort() } : {}),
      ...(parent !== undefined ? { in: parent } : {}),
    };
    kept.set(el, item);
    elements.push(item);
  }
  return {
    viewport: { width: innerWidth, height: innerHeight },
    height: Math.round(Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0)),
    title: clean(document.title, 120),
    elements,
    page: [...new Set(arg.page)].sort(),
    truncated,
  };
}

/** Listener types the summary reports (what makes an element respond to a person). */
const SUMMARY_TYPES = new Set([
  'click', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'pointermove', 'touchmove', 'mousemove',
  'mouseover', 'mouseenter', 'mouseout', 'mouseleave', 'pointerenter', 'pointerover', 'focus', 'focusin', 'blur', 'focusout', 'keydown', 'keyup',
  'input', 'change', 'submit',
]);

async function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ms); })]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The navigator's input from a loaded page: the summary (with the listener hook's records, when the page
 * has the hook) and a screenshot from the top. Read-only. Null when the summary could not be made.
 */
export async function capturePlanInput(
  page: PageLike,
  listeners: readonly { type: string; target: { kind: string }; ref: number }[] | null,
  withShot = true,
): Promise<{ summary: NavSummary; screenshot?: Uint8Array } | null> {
  const byRef = new Map<number, Set<string>>();
  const pageTypes = new Set<string>();
  for (const l of listeners ?? []) {
    if (!SUMMARY_TYPES.has(l.type)) continue;
    if (l.target.kind !== 'element') { pageTypes.add(l.type); continue; }
    byRef.set(l.ref, (byRef.get(l.ref) ?? new Set<string>()).add(l.type));
  }
  const arg = {
    listeners: [...byRef].map(([ref, types]) => ({ ref, types: [...types] })), page: [...pageTypes],
    caps: { elements: PLAN_CAPTURE.elements, scanned: PLAN_CAPTURE.scanned, text: PLAN_CAPTURE.text, classes: PLAN_CAPTURE.classes },
  };
  const summary = await within(page.evaluate(navSummary, arg).catch(() => undefined), PLAN_CAPTURE.summaryMs);
  if (!summary || !Array.isArray(summary.elements)) return null;
  if (!withShot) return { summary };
  const width = summary.viewport.width;
  const height = Math.max(1, Math.min(summary.height || summary.viewport.height, PLAN_CAPTURE.maxShotHeight));
  const shot = await within(
    page.screenshot({ type: 'jpeg', quality: PLAN_CAPTURE.shotQuality, fullPage: true, clip: { x: 0, y: 0, width, height } }).catch(() => undefined),
    PLAN_CAPTURE.shotMs,
  );
  return { summary, ...(shot && shot.length ? { screenshot: shot } : {}) };
}

/** The element can be what the planner says it is: a carousel is a region at least 160x100, a form holds a field. */
function fits(kind: TargetKind, el: NavElement, summary: NavSummary): boolean {
  const [, , w, h] = el.box;
  if (kind === 'carousel') return w >= 160 && h >= 100 && !/^(html|body|main)$/.test(el.tag);
  if (kind === 'form') {
    const byRef = new Map(summary.elements.map((e) => [e.ref, e]));
    return summary.elements.some((f) => /^(input|select|textarea)$/.test(f.tag) && (() => {
      for (let a = f.in; a !== undefined; a = byRef.get(a)?.in) if (a === el.ref) return true;
      return false;
    })());
  }
  return false;
}

const KIND_ORDER = new Map<string, number>(TARGET_KINDS.map((k, i) => [k, i]));
const isKind = (k: string): k is TargetKind => KIND_ORDER.has(k);

/**
 * The plan's targets as selectors, checked against the summary it was made from: a ref the summary does
 * not have, an unknown kind, a test the kind may not feed or a repeated element is dropped; a form's
 * submit control must be inside it. Sorted (kind, then document order) and cut to `max`, so the same
 * answer always gives the same plan. Pure.
 */
export function resolvePlan(summary: NavSummary, raw: RawPlan, max: number): TargetPlan {
  const byRef = new Map(summary.elements.map((e) => [e.ref, e]));
  const seen = new Set<number>();
  const picked: { ref: number; t: PlannedTarget }[] = [];
  for (const r of raw.targets ?? []) {
    if (!r || typeof r.ref !== 'number' || typeof r.kind !== 'string' || !isKind(r.kind) || seen.has(r.ref)) continue;
    const el = byRef.get(r.ref);
    if (!el || !fits(r.kind, el, summary) || isActionTarget(el)) continue;
    const allowed = KIND_TESTS[r.kind];
    const asked = Array.isArray(r.tests) ? r.tests.filter((t) => allowed.includes(t)) : [];
    const tests = asked.length ? [...new Set(asked)].sort() : [...allowed];
    let submit: string | undefined;
    if (r.kind === 'form') {
      const s = typeof r.submit === 'number' ? byRef.get(r.submit) : undefined;
      // The submit control must sit inside the form's element (a sibling form's button would send another form).
      let inside = false;
      for (let a = s?.in; a !== undefined && !inside; a = byRef.get(a)?.in) inside = a === el.ref;
      if (!s || !inside || isActionTarget(s)) continue;
      submit = s.sel;
    }
    seen.add(r.ref);
    const name = el.name ?? el.text;
    picked.push({ ref: r.ref, t: { selector: el.sel, kind: r.kind, tests, ...(name ? { name } : {}), ...(submit ? { submit } : {}) } });
  }
  picked.sort((a, b) => (KIND_ORDER.get(a.t.kind)! - KIND_ORDER.get(b.t.kind)!) || a.ref - b.ref);
  return { targets: picked.slice(0, Math.max(0, Math.floor(max))).map((p) => p.t), model: raw.model, key: raw.key, cached: raw.cached };
}

/** The planned targets one test takes, in plan order. */
export function plannedFor(planned: readonly PlannedTarget[] | undefined, test: string, kinds?: readonly TargetKind[]): PlannedTarget[] {
  return (planned ?? []).filter((t) => t.tests.includes(test) && (!kinds || kinds.includes(t.kind)));
}

/**
 * A test's findings with what it measured on planned targets added, criterion by criterion. Planned
 * failures are added (one per target). Where the test found nothing to test (`not_applicable`), or could not
 * test for a reason `replaceable` accepts (no element to test, say), a criterion the planned targets were
 * measured clean on (`clean`) becomes clean; where the planned targets were tested and gave neither (`other`:
 * their own "not applicable" or "could not test", with the reason), that result takes the place of the "nothing
 * to test" remark, so the report never says there was nothing when a planned target was there. Everything else
 * the test found stands: a planned target never turns a result of the test's own targets into another one. Pure.
 */
export function mergePlanned(
  base: readonly ProbeFinding[],
  planned: { failed: readonly ProbeFinding[]; clean: readonly string[]; other?: readonly ProbeFinding[] },
  replaceable: (f: ProbeFinding) => boolean = () => false,
): ProbeFinding[] {
  const out = [...base];
  const targets = new Set(base.filter((f) => f.status === 'failed').map((f) => `${f.criterion}\n${f.target ?? ''}`));
  for (const f of planned.failed) {
    if (f.status !== 'failed' || targets.has(`${f.criterion}\n${f.target ?? ''}`)) continue;
    targets.add(`${f.criterion}\n${f.target ?? ''}`);
    out.push(f);
  }
  const failed = new Set(out.filter((f) => f.status === 'failed').map((f) => f.criterion));
  const clean = new Set(planned.clean);
  const nothing = (f: ProbeFinding) => f.status === 'not_applicable' || (f.status === 'not_testable' && replaceable(f));
  // Criteria the planned targets settled neither way, whose only result from the test's own targets is "nothing to test".
  const other = (planned.other ?? []).filter((p) => (p.status === 'not_applicable' || p.status === 'not_testable')
    && !failed.has(p.criterion) && !clean.has(p.criterion)
    && out.some((f) => f.criterion === p.criterion) && out.filter((f) => f.criterion === p.criterion).every(nothing));
  const replaced = new Set(other.map((p) => p.criterion));
  const kept = out.filter((f) => {
    if (replaced.has(f.criterion)) return false;
    if (f.status !== 'not_applicable' && f.status !== 'not_testable') return true;
    // A criterion with a failure now: the "nothing to test" result goes, as it does when a test finds one.
    if (failed.has(f.criterion) && planned.failed.some((p) => p.criterion === f.criterion)) return !(f.status === 'not_applicable' || replaceable(f));
    if (clean.has(f.criterion)) return !(f.status === 'not_applicable' || replaceable(f));
    return true;
  });
  return [...kept, ...other];
}
