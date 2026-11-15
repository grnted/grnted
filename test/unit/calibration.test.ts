// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v5 calibration (docs/scoring.md, "Calibration"): 43 live public-agency sites graded blind by
// four expert graders (bias-corrected), scanned with the v5 engine and the AI review on. Each site's
// failing checks and shares are rebuilt as synthetic pages, core test results (template-sample tests,
// headings on every page, overlays) and AI image checks, and run through the real scoreSite. Aggregate
// behaviour only: no per-site score is pinned.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { scoreSite, type AiCheckOutcome, type ProbeChecks } from '../../src/score.js';
import type { Impact, PageAudit, RuleOutcome } from '../../src/types.js';

interface PanelSite {
  id: string;
  panel: number;
  v3: number;
  pagesScored: number;
  /** [rule id, impact, pages failing of pagesScored] */
  axe: [string, Impact, number][];
  /** [WCAG criterion a core test failed, pages failing, pages tested for it, which test kind] */
  probes: [string, number, number, 'probe' | 'headings' | 'overlays'][];
  /** [criterion, pages with a confirmed failing image, pages with an image the AI answered for] */
  ai: [string, number, number][];
}
const fixture = JSON.parse(readFileSync(new URL('../fixtures/calibration/v5-panel.json', import.meta.url), 'utf8')) as { about: string; sites: PanelSite[] };
const sites = fixture.sites;

function v5Score(site: PanelSite): number {
  const n = site.pagesScored;
  const impacts = new Map(site.axe.map(([id, impact]) => [id, impact]));
  const pages: PageAudit[] = Array.from({ length: n }, (_, i) => ({
    url: `/p${i}`, status: 'ok', violations: [], incomplete: [], links: [],
    rules: Object.fromEntries(site.axe.map(([id, , k]): [string, RuleOutcome] => [id, i < k ? 'fail' : 'pass'])),
  }));
  // Each criterion has its own tested pages (template-sample tests vs the every-page headings test).
  const probes = new Map<string, ProbeChecks>(Array.from({ length: n }, (_, i) => [
    `/p${i}`, Object.fromEntries(site.probes.filter(([, , tested]) => i < tested).map(([c, k]) => [c, i < k ? 'fail' : 'pass'])),
  ]));
  const ai: AiCheckOutcome[] = site.ai.map(([criterion, failedPages, testedPages]) => ({ criterion, failedPages, testedPages }));
  const r = scoreSite(pages, (id) => impacts.get(id) ?? 'moderate', probes, ai);
  if (r.status !== 'scored' || r.score === null) throw new Error(`${site.id} not scored`);
  return r.score;
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const averageMiss = (scores: number[]) => mean(scores.map((s, i) => Math.abs(s - sites[i]!.panel)));
/** Ranks with ties averaged (1-based). */
function ranks(xs: number[]): number[] {
  const order = xs.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
  const out = new Array<number>(xs.length);
  for (let i = 0; i < order.length;) {
    let j = i;
    while (j + 1 < order.length && order[j + 1]![0] === order[i]![0]) j++;
    for (let k = i; k <= j; k++) out[order[k]![1]] = (i + j) / 2 + 1;
    i = j + 1;
  }
  return out;
}
function spearman(a: number[], b: number[]): number {
  const ra = ranks(a);
  const rb = ranks(b);
  const ma = mean(ra);
  const mb = mean(rb);
  let c = 0, va = 0, vb = 0;
  for (let i = 0; i < ra.length; i++) {
    c += (ra[i]! - ma) * (rb[i]! - mb);
    va += (ra[i]! - ma) ** 2;
    vb += (rb[i]! - mb) ** 2;
  }
  return c / Math.sqrt(va * vb);
}

describe('scoring v5 calibration panel', () => {
  const panel = sites.map((s) => s.panel);
  const v5 = sites.map(v5Score);
  const v3 = sites.map((s) => s.v3);

  it('is the anonymized 43-site panel, with core test kinds and AI image checks', () => {
    expect(sites).toHaveLength(43);
    for (const s of sites) {
      for (const [, k, tested, kind] of s.probes) {
        expect(k).toBeLessThanOrEqual(tested);
        expect(tested).toBeLessThanOrEqual(s.pagesScored);
        expect(['probe', 'headings', 'overlays']).toContain(kind);
      }
      for (const [c, k, tested] of s.ai) {
        expect(['1.1.1', '1.4.5']).toContain(c);
        expect(k).toBeLessThanOrEqual(tested);
      }
    }
    const kinds = new Set(sites.flatMap((s) => s.probes.map((p) => p[3])));
    expect([...kinds].sort()).toEqual(['headings', 'overlays', 'probe']);
    expect(sites.some((s) => s.ai.some(([, k]) => k > 0))).toBe(true);
    expect(fixture.about).toMatch(/Anonymized/);
    expect(JSON.stringify(fixture)).not.toMatch(/https?:|www\./);
  });

  it('v5 tracks the expert panel: average miss <= 5.5 points, rank correlation >= 0.74', () => {
    expect(averageMiss(v5)).toBeLessThanOrEqual(5.5);
    expect(spearman(v5, panel)).toBeGreaterThanOrEqual(0.74);
  });

  it('no false "Access Granted": no site scores 90 or more that the panel graded below 85', () => {
    expect(sites.filter((s, i) => v5[i]! >= 90 && s.panel < 85).map((s) => s.id)).toEqual([]);
  });

  it('v3 (recorded in the fixture) was far worse: average miss > 15 and a lower rank correlation', () => {
    expect(averageMiss(v3)).toBeGreaterThan(15);
    expect(spearman(v3, panel)).toBeLessThan(spearman(v5, panel));
  });
});
