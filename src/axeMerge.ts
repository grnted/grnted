// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import type { AxeRuleLite, AxeRun, Finding, RuleOutcome, ThirdPartyFrame, ThirdPartyRun, Viewport } from './types.js';

type Named = { viewport: Viewport['name']; run: AxeRun };

function mergeFindings(lists: { viewport: Viewport['name']; rules: AxeRuleLite[] }[]): Finding[] {
  const byId = new Map<string, Finding>();
  // Per rule, its nodes by target: a page that returns N targets costs N lookups, not N^2/2 scans.
  const nodesOf = new Map<Finding, Map<string, Finding['nodes'][number]>>();
  for (const { viewport, rules } of lists) {
    for (const rule of rules) {
      let finding = byId.get(rule.id);
      if (!finding) {
        finding = { id: rule.id, help: rule.help, helpUrl: rule.helpUrl, nodes: [] };
        byId.set(rule.id, finding);
        nodesOf.set(finding, new Map());
      }
      const byTarget = nodesOf.get(finding)!;
      for (const node of rule.nodes) {
        const existing = byTarget.get(node.target);
        if (existing) {
          if (!existing.viewports.includes(viewport)) existing.viewports.push(viewport);
        } else {
          const added = { ...node, viewports: [viewport] };
          finding.nodes.push(added);
          byTarget.set(node.target, added);
        }
      }
    }
  }
  return [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1));
}

export function mergeViewportRuns(runs: Named[]): {
  rules: Record<string, RuleOutcome>;
  violations: Finding[];
  incomplete: Finding[];
} {
  const failed = new Set<string>();
  const passed = new Set<string>();
  const incomplete = new Set<string>();
  const seen = new Set<string>();
  for (const { run } of runs) {
    for (const r of run.violations) { failed.add(r.id); seen.add(r.id); }
    for (const id of run.passes) { passed.add(id); seen.add(id); }
    for (const r of run.incomplete) { incomplete.add(r.id); seen.add(r.id); }
    for (const id of run.inapplicable) seen.add(id);
  }
  const rules: Record<string, RuleOutcome> = {};
  for (const id of [...seen].sort()) {
    rules[id] = failed.has(id) ? 'fail' : passed.has(id) ? 'pass' : incomplete.has(id) ? 'incomplete' : 'inapplicable';
  }
  return {
    rules,
    violations: mergeFindings(runs.map(({ viewport, run }) => ({ viewport, rules: run.violations }))),
    incomplete: mergeFindings(runs.map(({ viewport, run }) => ({ viewport, rules: run.incomplete }))),
  };
}

/**
 * Failures inside frames from other sites (scoring v3), per frame address, merged across widths like
 * the page's own: in first-seen order (desktop first). Frames without failures are left out.
 */
export function mergeThirdPartyRuns(runs: { viewport: Viewport['name']; thirdParty: ThirdPartyRun[] }[]): ThirdPartyFrame[] {
  const byUrl = new Map<string, { viewport: Viewport['name']; rules: AxeRuleLite[] }[]>();
  for (const { viewport, thirdParty } of runs) {
    for (const t of thirdParty) {
      let lists = byUrl.get(t.url);
      if (!lists) byUrl.set(t.url, (lists = []));
      lists.push({ viewport, rules: t.run.violations });
    }
  }
  return [...byUrl.entries()]
    .map(([url, lists]) => ({ url, violations: mergeFindings(lists) }))
    .filter((f) => f.violations.length > 0);
}
