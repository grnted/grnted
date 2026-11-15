// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The elements a test's undecided or failing findings name, as its page showed them when the test was done
// (`ProbeRun.elements`): neutral evidence for an AI review that looks again at the scan's own results (the closed AI
// package's precision guard and adjudicator, and its lane checks). Data only: the element's start tag and text, its box,
// a few computed facts, the text after it, its nearest container and the controls in it. Read in the page with one
// script: no request, no event, no change to the page; capped per element and per run; bounded in time. Every string
// is untrusted page content (an AI review quotes it only inside its delimited evidence). Never in the report.
// Engine core: no Node-only imports.
import type { PageLike, ProbeElementFacts, ProbeFinding } from '../types.js';

/** Elements described per run, characters of a start tag, of text, and of the whole list (JSON). */
export const ELEMENT_FACTS_MAX = 20;
export const ELEMENT_FACTS_TAG = 300;
export const ELEMENT_FACTS_TEXT = 300;
export const ELEMENT_FACTS_RUN_CHARS = 16_000;
/** Longest the page is asked (the test's own time is not extended for it). */
export const ELEMENT_FACTS_MS = 1_500;

const STATUSES: ReadonlySet<ProbeFinding['status']> = new Set(['failed', 'not_testable', 'flagged']);

/**
 * The targets worth describing: those of failed, not-testable and flagged findings (not a page that did not load, a
 * test stopped by time or limits, or advice), that read as a CSS path (one line, no quotes of a heard name), in order,
 * each once, at most ELEMENT_FACTS_MAX.
 */
export function factTargets(findings: readonly ProbeFinding[]): string[] {
  const out: string[] = [];
  for (const f of findings) {
    if (!STATUSES.has(f.status) || f.loadFailure || f.timeLimit || f.limit || f.advice) continue;
    const t = f.target?.trim();
    if (!t || t.length > 500 || /[\n“”]/.test(t) || out.includes(t)) continue;
    out.push(t);
    if (out.length >= ELEMENT_FACTS_MAX) break;
  }
  return out;
}

/** Reads the facts of each target in the page (runs in the browser; self-contained). */
function readFacts(args: { targets: string[]; tag: number; text: number }): unknown[] {
  const clip = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n - 1)}…` : t; };
  const startTag = (el: Element, n: number) => { const h = el.outerHTML; const i = h.indexOf('>'); return clip(i >= 0 ? h.slice(0, i + 1) : h, n); };
  const textOf = (el: Element, n: number) => clip((el as HTMLElement).innerText ?? el.textContent ?? '', n);
  /** The engine's paths: CSS, with ' >>> ' into an open shadow root. */
  const find = (path: string): Element[] => {
    const parts = path.split(' >>> ');
    let scopes: (Document | ShadowRoot)[] = [document];
    let found: Element[] = [];
    for (let i = 0; i < parts.length; i++) {
      found = scopes.flatMap((s) => { try { return [...s.querySelectorAll(parts[i]!)]; } catch { return []; } });
      if (i < parts.length - 1) scopes = found.map((e) => e.shadowRoot).filter((r): r is ShadowRoot => !!r);
    }
    return found;
  };
  const CONTAINER = 'table,ul,ol,dl,form,fieldset,nav,section,article,aside,header,footer,main,details,dialog,figure,[role]';
  const CONTROL = 'a[href],button,input,select,textarea,summary,[role=button],[role=link],[role=tab],[role=checkbox],[role=switch],[tabindex]';
  return args.targets.map((target) => {
    const all = find(target);
    const el = all[0];
    if (!el) return { target, found: 0 };
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const next = el.nextElementSibling;
    const container = el.parentElement?.closest(CONTAINER) ?? null;
    const controls = container ? [...container.querySelectorAll(CONTROL)].filter((c) => c !== el).slice(0, 5) : [];
    return {
      target, found: all.length, tag: startTag(el, args.tag), text: textOf(el, args.text),
      box: [Math.round(r.left + scrollX), Math.round(r.top + scrollY), Math.round(r.width), Math.round(r.height)],
      style: {
        fontSize: cs.fontSize, fontWeight: cs.fontWeight, color: cs.color, background: cs.backgroundColor,
        ...(cs.backgroundImage && cs.backgroundImage !== 'none' ? { backgroundImage: 'yes' } : {}),
        display: cs.display, position: cs.position, visibility: cs.visibility, ...(cs.opacity !== '1' ? { opacity: cs.opacity } : {}),
      },
      ...(next ? { next: { tag: next.localName, text: textOf(next, 200) } } : {}),
      ...(container ? { container: { tag: startTag(container, 200), text: (container.textContent ?? '').replace(/\s+/g, ' ').trim().length } } : {}),
      ...(controls.length ? { controls: controls.map((c) => ({ tag: startTag(c, 160), text: textOf(c, 80) })) } : {}),
    };
  });
}

/** Keeps a list's JSON within ELEMENT_FACTS_RUN_CHARS, from the first element on. */
function capped(list: ProbeElementFacts[]): ProbeElementFacts[] {
  const out: ProbeElementFacts[] = [];
  let size = 2;
  for (const e of list) {
    const n = JSON.stringify(e).length + 1;
    if (size + n > ELEMENT_FACTS_RUN_CHARS) break;
    out.push(e);
    size += n;
  }
  return out;
}

const isFacts = (x: unknown): x is ProbeElementFacts => !!x && typeof x === 'object' && typeof (x as ProbeElementFacts).target === 'string' && typeof (x as ProbeElementFacts).found === 'number';

/**
 * The facts of the elements the findings name, read from the page as it is now; undefined when there is nothing to
 * describe, the page cannot be read, or it does not answer within ELEMENT_FACTS_MS. Never throws.
 */
export async function elementFacts(page: PageLike, findings: readonly ProbeFinding[]): Promise<ProbeElementFacts[] | undefined> {
  const targets = factTargets(findings);
  if (!targets.length || typeof page.evaluate !== 'function') return undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const read = page.evaluate(readFacts, { targets, tag: ELEMENT_FACTS_TAG, text: ELEMENT_FACTS_TEXT }) as Promise<unknown>;
    read.catch(() => {});
    const out = await Promise.race([read, new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), ELEMENT_FACTS_MS); })]);
    if (!Array.isArray(out)) return undefined;
    const list = capped(out.filter(isFacts));
    return list.length ? list : undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
