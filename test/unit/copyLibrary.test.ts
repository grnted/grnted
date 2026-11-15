// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The report v2 copy library (spec §4): one reviewed entry per axe rule, per probe criterion and for
// documents, in the product's voice and under the product copy rules (test/unit/productCopy.test.ts).
import { describe, expect, it } from 'vitest';
import { AI_CHECK_COPY, AI_COPY, COPY_PROBE_CRITERIA, COPY_RULE_IDS, COPY_CRITERIA, DOCUMENTS_COPY, copyForAiCheck, copyForCriterion, copyForProbeCriterion, copyForRule, GENERIC_CRITERION_COPY, GENERIC_RULE_COPY } from '../../src/report/copy/index.js';
import { PROBES } from '../../src/probes/registry.js';
import { RULE_IMPACTS } from '../../src/ruleImpacts.js';
import { COPY_VERSION } from '../../src/version.js';
import { LEGACY_AI_GATES } from '../../src/aiLegacy.js';
import type { ProblemCopy } from '../../src/report/model.js';

const PROBE_CRITERIA = [...new Set(PROBES.flatMap((p) => p.criteria))].sort();
const RULES = Object.keys(RULE_IMPACTS);
const all: [string, ProblemCopy][] = [
  ...RULES.map((id) => [`rule:${id}`, copyForRule(id)] as [string, ProblemCopy]),
  ...PROBE_CRITERIA.map((c) => [`criterion:${c}`, copyForCriterion(c)] as [string, ProblemCopy]),
  ...COPY_PROBE_CRITERIA.map((k) => [`probe:${k}`, copyForProbeCriterion(k.split(':')[0]!, k.split(':')[1]!)] as [string, ProblemCopy]),
  ['documents', DOCUMENTS_COPY],
  ...Object.entries(AI_COPY).map(([c, copy]) => [`ai:${c}`, copy] as [string, ProblemCopy]),
  ...Object.entries(AI_CHECK_COPY).map(([k, copy]) => [`ai:${k}`, copy] as [string, ProblemCopy]),
  ['generic rule', GENERIC_RULE_COPY],
  ['generic criterion', GENERIC_CRITERION_COPY],
];
/** Sentences in a field: ends of sentences are ". ", "! ", "? " or the end. */
const sentences = (s: string) => s.trim().split(/(?<=[.!?])\s+(?=[A-Z"“])/).filter(Boolean);
const FORBIDDEN = /\b(passes|passed|compliant|compliance|certified|verified)\b/i;
const TASK = /\b(a person|someone|you) (should|must|will) (check|confirm|review)\b|\bby hand\b|manual(ly)? check|check manually/i;

describe('copy library', () => {
  it('has a version', () => {
    expect(COPY_VERSION).toMatch(/^\d+$/);
  });

  // The gated checks of scoring v13 (src/aiLegacy.ts); the closed AI package checks its own gate table against this library.
  it('words every criterion of every gated AI check for what the AI review confirms (never a test\'s title: two cards would read the same)', () => {
    for (const [check, criteria] of Object.entries(LEGACY_AI_GATES)) {
      if (check === 'altText') continue; // its own library (AI_COPY)
      // The PDF review's confirmed problems are listed on the documents problem (DOCUMENTS_COPY, scoring v10), never a card of their own.
      if (check === 'document') continue;
      for (const c of criteria!) {
        const copy = copyForAiCheck(check, c);
        // Never the generic "an automated test found a barrier" copy, and never a test's wording of another failure.
        expect(copy, `${check}:${c}`).not.toBe(GENERIC_CRITERION_COPY);
        expect(copy, `${check}:${c}`).not.toBe(copyForCriterion(c));
      }
    }
    // A pair with no copy of its own (the PDF review, listed on the documents problem) falls back to the criterion's.
    expect(copyForAiCheck('document', '1.3.1')).toBe(copyForCriterion('1.3.1'));
  });

  it('covers every axe rule that runs and nothing else', () => {
    expect([...COPY_RULE_IDS].sort()).toEqual([...RULES].sort());
    for (const id of RULES) expect(copyForRule(id), id).not.toBe(GENERIC_RULE_COPY);
  });

  it('covers every criterion a registry probe can fail', () => {
    for (const c of PROBE_CRITERIA) {
      expect(COPY_CRITERIA, c).toContain(c);
      expect(copyForCriterion(c), c).not.toBe(GENERIC_CRITERION_COPY);
    }
  });

  it('has its own copy for some probes (the floating-box test), and falls back to the criterion copy for other probes', () => {
    expect(copyForProbeCriterion('overlays', '1.4.10').title).toBe('Floating buttons or banners cover the page on phones and when zoomed');
    expect(copyForProbeCriterion('reflow', '1.4.10')).toBe(copyForCriterion('1.4.10'));
    expect(copyForProbeCriterion('__proto__', 'x')).toBe(GENERIC_CRITERION_COPY);
    for (const k of COPY_PROBE_CRITERIA) expect(PROBES.some((p) => p.id === k.split(':')[0] && p.criteria.includes(k.split(':')[1]!)), k).toBe(true);
  });

  it('falls back to safe generic copy for unknown rules and criteria', () => {
    for (const id of ['made-up-rule', '', '__proto__', 'constructor', 'toString', '<script>']) expect(copyForRule(id)).toBe(GENERIC_RULE_COPY);
    for (const c of ['9.9.9', '', '__proto__', 'hasOwnProperty']) expect(copyForCriterion(c)).toBe(GENERIC_CRITERION_COPY);
  });

  it.each(all)('%s follows the copy rules', (key, copy) => {
    expect(copy.title.length, key).toBeGreaterThan(0);
    expect(copy.title.length, `${key}: ${copy.title}`).toBeLessThanOrEqual(70);
    // No rule ids (hyphenated ids; one-word ids like "label" are plain words) and no criterion numbers.
    for (const id of RULES.filter((r) => r.includes('-'))) expect(copy.title.toLowerCase(), key).not.toContain(id);
    expect(copy.title, key).not.toMatch(/\d\.\d/);
    expect(copy.title, key).not.toMatch(/[.!]$/);
    expect(copy.title, key).not.toMatch(/WCAG|SC |axe|ARIA role|violation/i);
    for (const field of ['who', 'fix'] as const) {
      const n = sentences(copy[field]).length;
      expect(n, `${key}.${field}: ${copy[field]}`).toBeGreaterThanOrEqual(1);
      expect(n, `${key}.${field}: ${copy[field]}`).toBeLessThanOrEqual(2);
      expect(copy[field], key).toMatch(/[.!?]["”)]?$/);
    }
    expect(copy.who, key).toMatch(/^People|^Anyone|^Everyone/);
    for (const text of [copy.title, copy.who, copy.fix]) {
      expect(text, key).not.toMatch(FORBIDDEN);
      expect(text, key).not.toMatch(TASK);
      expect(text, key).not.toMatch(/\s{2,}|—/);
    }
    expect(['developer', 'content', 'documents'], key).toContain(copy.owner);
  });

  it('titles are unique, so two problems never read the same', () => {
    const titles = all.map(([, c]) => c.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it('owners follow who usually makes the change', () => {
    expect(copyForRule('image-alt').owner).toBe('content');
    expect(copyForRule('link-name').owner).toBe('content');
    expect(copyForRule('label-content-name-mismatch').owner).toBe('developer');
    expect(copyForRule('color-contrast').owner).toBe('developer');
    expect(copyForCriterion('2.4.11').owner).toBe('developer');
    expect(DOCUMENTS_COPY.owner).toBe('documents');
  });

  it('keeps the reviewed example wording for label-in-name', () => {
    const c = copyForRule('label-content-name-mismatch');
    expect(c.title).toBe("Link names don't match the words on screen");
    expect(c.who).toBe("People who use voice control. They say the words they see, and the link doesn't answer because its hidden name is different.");
    expect(c.fix).toBe('Remove the aria-label so the link is named by its visible text, or start the label with exactly the words on screen.');
  });

  it('copy objects cannot be changed at runtime', () => {
    expect(Object.isFrozen(copyForRule('image-alt'))).toBe(true);
    expect(Object.isFrozen(DOCUMENTS_COPY)).toBe(true);
    expect(Object.isFrozen(GENERIC_RULE_COPY)).toBe(true);
  });
});
