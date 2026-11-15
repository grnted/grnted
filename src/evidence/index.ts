// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The evidence pass (report v2, spec §3.2): plan the images, take them, record them. Engine core:
// no Node-only imports.
import type { AiReport, BrowserLike, EvidenceBox, PageAudit, RuleSummary } from '../types.js';
import { boxesIn, captureEvidenceResults, MAX_START_BOXES, MISSED, START_MARKS_PER_PROBLEM, type CaptureOptions, type CapturedShot } from './capture.js';
import type { HomeMark } from './probePool.js';
import type { EvidenceRecorder } from './recorder.js';
import { selectEvidence } from './select.js';

export { AI_EVIDENCE_RESERVE, createEvidenceRecorder, DEFAULT_MAX_IMAGES, MAX_IMAGES_LIMIT, type EvidencePool, type EvidenceRecorder } from './recorder.js';
export { compareRules, selectEvidence, MAX_AI_IMAGES, MAX_CANDIDATES, MAX_TARGETS, type EvidenceItem, type EvidenceViewport, type SelectInput, type StartMark } from './select.js';
export { createProbeEvidencePool, POOL_PER_KEY, type HomeMark, type PoolUnit, type ProbeEvidencePool } from './probePool.js';
export { chooseTargets, type TargetCandidate } from './fit.js';
export {
  boxesIn, captureEvidence, captureEvidenceResults, pageLabel, startBoxes, BOX_TARGET_MAX, CAPTURE_DEFAULTS, CLIP_PADDING, JPEG_QUALITY, MAX_CLIP, MISSED, START_SHOT,
  type CaptureOptions, type CaptureResult, type CaptureTimeouts, type CapturedShot,
} from './capture.js';

export interface EvidencePassInput extends CaptureOptions {
  pages: readonly PageAudit[];
  rules?: readonly RuleSummary[];
  ai?: AiReport;
  /** Take the start page's overview shot. Default true. */
  start?: boolean;
  /** Slots of the pass's room to leave free (the probes' remaining share while they still run). */
  reserve?: number;
  /** Called once with the number of pictures the pass will try to take, before it takes them (only when there are some). Must not throw. */
  onPlanned?: (count: number) => void;
}

/** A rule's picture the pass could not take, and why (the report says so in its technical details). */
export interface EvidenceMiss {
  rule: string;
  page: string;
  reason: string;
}

/**
 * The axe pass's pictures, taken but not recorded yet: the probe evidence pool records them with the
 * core tests' pictures, one per problem before any problem gets a second (`ProbeEvidencePool.commit`).
 */
export interface HeldPass {
  /** The start page's overview shots, recorded first. */
  start: CapturedShot[];
  /** One picture per axe rule, in problem order. */
  rules: CapturedShot[];
  /** Planned rule pictures that could not be taken. */
  missed: EvidenceMiss[];
}

/**
 * Plans and takes the pass's images (start shots, then one per axe rule in problem order) without
 * recording them. `room`: most images to plan. Never throws: a failure only means fewer images.
 */
export async function holdEvidencePass(browser: BrowserLike, input: EvidencePassInput & { room: number }): Promise<HeldPass> {
  const held: HeldPass = { start: [], rules: [], missed: [] };
  try {
    const items = selectEvidence({ pages: input.pages, rules: input.rules, start: input.start, room: input.room }).filter((i) => i.kind !== 'ai');
    if (!items.length) return held;
    const results = await captureEvidenceResults(browser, items, input);
    items.forEach((item, i) => {
      const r = results[i];
      if (item.kind === 'start') {
        if (r?.shot) held.start.push(r.shot);
      } else if (item.kind === 'rule') {
        if (r?.shot) held.rules.push(r.shot);
        else held.missed.push({ rule: item.rule, page: item.page, reason: r?.missed ?? MISSED.failed });
      }
    });
  } catch {
    // Evidence is an extra; the report stands without it.
  }
  return held;
}

/**
 * Plans, takes and records the images (pool 'pass'), most important first, so the ids follow the
 * plan's order. Never throws: a failure only means fewer images.
 */
export async function runEvidencePass(browser: BrowserLike, recorder: EvidenceRecorder, input: EvidencePassInput): Promise<void> {
  try {
    // Scored AI images (scoring v5) may use the recorder's AI reserve, so plan with the 'ai' room.
    const room = (input.ai ? recorder.room('ai') : recorder.room('pass')) - Math.max(0, input.reserve ?? 0);
    const items = selectEvidence({ pages: input.pages, rules: input.rules, ai: input.ai, start: input.start, room });
    if (!items.length) return;
    input.onPlanned?.(items.length);
    const shots = await captureEvidenceResults(browser, items, input);
    for (const [i, s] of shots.entries()) {
      const item = items[i];
      if (s.shot) await recorder.add(s.shot.shot, s.shot.jpeg, item?.kind === 'ai' && item.scored ? 'ai' : 'pass');
    }
  } catch {
    // Evidence is an extra; the report stands without it.
  }
}

/**
 * Outlines the start page's core-test failures (`HomeMark`s from the probe evidence pool) on its
 * desktop start shot, after its axe marks: whole pixels inside the image, at most
 * `START_MARKS_PER_PROBLEM` per problem and `MAX_START_BOXES` in all. Never throws.
 */
export function addHomeMarks(recorder: EvidenceRecorder, marks: readonly HomeMark[]): void {
  try {
    const shot = recorder.shots().find((s) => 'rule' in s.for && s.for.rule === '$start' && s.viewport.width > 600);
    if (!shot || !marks.length) return;
    const size = { x: 0, y: 0, width: shot.width, height: shot.height };
    let total = shot.boxes.length;
    const add: EvidenceBox[] = [];
    for (const m of marks) {
      let n = shot.boxes.filter((b) => b.problem === m.problem).length;
      for (const r of m.rects) {
        if (total >= MAX_START_BOXES || n >= START_MARKS_PER_PROBLEM) break;
        const [b] = boxesIn([r], size);
        if (!b) continue;
        add.push({ x: b.x, y: b.y, width: b.width, height: b.height, kind: 'fail', problem: m.problem });
        total++;
        n++;
      }
    }
    if (add.length) recorder.addBoxes(shot.id, add);
  } catch {
    // Evidence is an extra.
  }
}
