// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The evidence pass's plan (report v2, spec §3.2): which images to take, in priority order. Pure: no
// browser, no I/O. Engine core: no Node-only imports.
import { IMPACT_RANK } from '../score.js';
import type { AiReport, PageAudit, RuleSummary } from '../types.js';

/** Most failing elements boxed in one rule's image. */
export const MAX_TARGETS = 3;
/**
 * Most of a rule's failing elements looked up on the page: the capture boxes the largest group of
 * them (at most `MAX_TARGETS`) that fits one image (`chooseTargets` in fit.ts).
 */
export const MAX_CANDIDATES = 8;
/** Most thumbnails of images the AI review flagged, per scan (they count toward `maxImages`). */
export const MAX_AI_IMAGES = 6;

/** Which of the audit's widths an image is taken at: desktop 1280×900, or a phone 390×844. */
export type EvidenceViewport = 'desktop' | 'mobile';

/** Failing elements of one problem to outline on a start page shot (candidates; the capture keeps those on screen). */
export interface StartMark { problem: string; targets: string[] }

/** One image the evidence pass will try to take. */
export type EvidenceItem =
  /**
   * The start page as it first appears at one width (the whole viewport): `for: { rule: '$start' }`.
   * `marks`: the start page's failing elements at that width, by problem, to outline on it. Default: desktop, no marks.
   */
  | { kind: 'start'; page: string; viewport?: EvidenceViewport; marks?: StartMark[] }
  /**
   * A rule's failing elements on one page, by their axe targets (main frame): candidates, at most
   * `MAX_CANDIDATES`. At desktop width, or at phone width for a rule that fails only there.
   */
  | { kind: 'rule'; page: string; rule: string; help: string; targets: string[]; viewport?: EvidenceViewport }
  /**
   * An image an AI check flagged, by its address; `observed` is what the AI saw (for the alt text).
   * `scored`: a confirmed failure that counts toward the score (scoring v5): taken first, with room
   * around the image and a box on it.
   */
  | { kind: 'ai'; page: string; check: string; target: string; observed?: string; scored?: boolean };

export interface SelectInput {
  /** The audited pages, in scan order (the first is the start page). */
  pages: readonly PageAudit[];
  /** The report's axe rule summaries (any order; this sorts them in problem order). */
  rules?: readonly RuleSummary[];
  /** The AI review: its flagged alt-text findings about images get thumbnails. */
  ai?: AiReport;
  /** Take the start page's overview shot. Default true. */
  start?: boolean;
  /** Most items to return (the recorder's room for this pass). */
  room: number;
}

/** Problem order (spec §5): points lost, then impact weight, then pages affected, then elements, then id. */
export function compareRules(a: RuleSummary, b: RuleSummary): number {
  return b.pointsLost - a.pointsLost
    || IMPACT_RANK[b.impact] - IMPACT_RANK[a.impact]
    || b.pagesAffected.length - a.pagesAffected.length
    || b.elements - a.elements
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** axe joins frame and shadow-root steps with ' >>> '; the pass looks in the main document only. */
const isMainFrameTarget = (t: string) => t.length > 0 && t.length <= 1000 && !t.includes(' >>> ');

const isHttpUrl = (u: string) => {
  try {
    const p = new URL(u).protocol;
    return p === 'http:' || p === 'https:';
  } catch {
    return false;
  }
};

/** Up to MAX_CANDIDATES distinct main-frame targets of `rule` that fail at `width` on `page`. */
function targetsOn(page: PageAudit, rule: string, width: EvidenceViewport = 'desktop'): string[] {
  const out: string[] = [];
  for (const f of page.violations) {
    if (f.id !== rule) continue;
    for (const n of f.nodes) {
      if (out.length >= MAX_CANDIDATES) return out;
      if (Array.isArray(n.viewports) && n.viewports.includes(width) && isMainFrameTarget(n.target) && !out.includes(n.target)) out.push(n.target);
    }
  }
  return out;
}

/** True when `rule` fails at phone width only: no failing element of it, on any loaded page, fails at desktop width. */
function mobileOnly(pages: Iterable<PageAudit>, rule: string): boolean {
  let mobile = false;
  for (const p of pages) {
    for (const f of p.violations) {
      if (f.id !== rule) continue;
      for (const n of f.nodes) {
        const v = Array.isArray(n.viewports) ? n.viewports : [];
        if (v.includes('desktop')) return false;
        if (v.includes('mobile')) mobile = true;
      }
    }
  }
  return mobile;
}

/**
 * The images to take, most important first: the start page at desktop and at phone width (each with
 * the start page's failing elements at that width to outline), then one per axe rule in problem order
 * (on the first page where it fails in the main frame: at desktop width, or at phone width for a rule
 * that fails only there), then the AI thumbnails. Every image counts toward `room`.
 */
export function selectEvidence(input: SelectInput): EvidenceItem[] {
  const room = Math.floor(input.room);
  if (!(room > 0)) return [];
  const out: EvidenceItem[] = [];
  const ok = new Map(input.pages.filter((p) => p.status === 'ok').map((p) => [p.url, p]));
  const rules = [...(input.rules ?? [])].sort(compareRules);
  const first = input.pages[0];
  if (input.start !== false && first?.status === 'ok') {
    for (const viewport of ['desktop', 'mobile'] as const) {
      const marks = rules.map((r) => ({ problem: `rule:${r.id}`, targets: targetsOn(first, r.id, viewport) })).filter((m) => m.targets.length);
      out.push({ kind: 'start', page: first.url, viewport, marks });
    }
  }

  for (const rule of rules) {
    if (out.length >= room) return out.slice(0, room);
    const viewport: EvidenceViewport = mobileOnly(ok.values(), rule.id) ? 'mobile' : 'desktop';
    for (const url of rule.pagesAffected) {
      const page = ok.get(url);
      const targets = page ? targetsOn(page, rule.id, viewport) : [];
      if (targets.length) {
        out.push({ kind: 'rule', page: url, rule: rule.id, help: rule.help, targets, viewport });
        break;
      }
    }
  }

  // AI thumbnails: confirmed (scored) images first, the first of each scored criterion before the
  // rest, then the other flagged images, each in report order.
  const flagged = (input.ai?.runs ?? []).flatMap((run) => (Array.isArray(run.findings) ? run.findings : []))
    .filter((f) => f && f.check === 'altText' && f.flagged && ok.has(f.page) && isHttpUrl(f.target) && f.target.length <= 2000);
  const scored = flagged.filter((f) => f.scored === true);
  const firstPerCriterion = scored.filter((f, i) => scored.findIndex((g) => g.criterion === f.criterion) === i);
  const ordered = [...firstPerCriterion, ...scored, ...flagged.filter((f) => f.scored !== true)];
  const scoredKeys = new Set(scored.map((f) => `${f.page}\n${f.target}`));
  const seen = new Set<string>();
  let ai = 0;
  for (const f of ordered) {
    if (out.length >= room || ai >= MAX_AI_IMAGES) return out.slice(0, room);
    const key = `${f.page}\n${f.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const observed = typeof f.observed === 'string' ? f.observed.trim().slice(0, 500) : '';
    out.push({ kind: 'ai', page: f.page, check: f.check, target: f.target, ...(observed ? { observed } : {}), ...(scoredKeys.has(key) ? { scored: true } : {}) });
    ai++;
  }
  return out.slice(0, room);
}
