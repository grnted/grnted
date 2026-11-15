// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Probe evidence held until the probes are done (report v2): every picture a probe takes at the
// moment of failure waits here, with the run it came from, and only the pictures of failures the
// final runs still report reach the recorder. Then the pool shares the room fairly: one picture per
// failing criterion (most pages first) before any criterion gets a second, so one test that fails on
// every page never crowds the others out. With the axe pass's pictures held too, the start page's
// shots go first and every problem, axe rule or core test, gets its first picture before any gets a
// second. The start page's failing elements a probe measured at the
// desktop width ("Homepage, as checked") come out here too. Engine core: no Node-only imports.
import { compareCriteria } from '../probes/criteria.js';
import type { EvidenceShot, ProbeFinding, ProbeRun } from '../types.js';
import type { EvidenceRecorder } from './recorder.js';

/** A picture taken but not recorded yet (the axe pass's, `HeldPass` in ./index.ts). */
interface HeldShot { shot: Omit<EvidenceShot, 'id'>; jpeg: Uint8Array }

/** Pictures (a pair counts as one) held per criterion and variant: captures stop once a criterion has these. */
export const POOL_PER_KEY = 2;
/** Most pictures held at once, and their bytes (the scan keeps them in memory until the probes end). */
export const POOL_MAX_UNITS = 48;
export const POOL_MAX_BYTES = 16 * 1024 * 1024;
/** The start page's failing elements per problem outlined on its desktop picture. */
export const HOME_PER_PROBLEM = 3;

interface Rect { x: number; y: number; width: number; height: number }

/** One picture (or a pair), from one run, for one criterion. */
export interface PoolUnit {
  criterion: string;
  page: string;
  /** The page's position in the scan order. */
  index: number;
  probe: string;
  shots: { meta: Omit<EvidenceShot, 'id'>; bytes: Uint8Array }[];
  /** Kept only when the final run has a failed finding for the criterion that passes this test (default: any). */
  when?: (f: ProbeFinding) => boolean;
  /**
   * From a test that is listed, not scored: its failures of a criterion a scored test also fails are a
   * problem of their own (`criterion:<n>/listed`), so its pictures are shared out apart from the scored tests'.
   */
  listed?: boolean;
}

/** Whose problem a picture shows: the criterion, or the criterion's listed problem. */
const problemOf = (u: PoolUnit) => (u.listed ? `${u.criterion}\nlisted` : u.criterion);

/** A demand slot: taken before a capture, given back when the picture is not kept. */
export interface PoolTicket { release(): void; readonly key: string }

/** Start page elements (CSS px of the first screen at the desktop width) outlined for one problem. */
export interface HomeMark { problem: string; rects: Rect[] }

export interface ProbeEvidencePool {
  /**
   * A slot for one more picture of `criterion` (`variant` keeps kinds of failure apart, e.g. the
   * cross-page heading rule), or null when it already has `POOL_PER_KEY` (held or being taken) or the
   * pool is full. Release it when the picture is not kept.
   */
  take(criterion: string, variant?: string): PoolTicket | null;
  /** True when `take` would give a slot now. */
  wants(criterion: string, variant?: string): boolean;
  /** Criteria with a picture held or being taken now (what the axe pass leaves room for). */
  criteria(): number;
  /** Holds a taken picture until `commit`. The ticket stays taken. Returns false (and releases) when over the byte cap. */
  offer(unit: PoolUnit, ticket: PoolTicket): boolean;
  /** Start page elements a probe measured for a failure (kept only if the final run fails `criterion`). */
  home(mark: { criterion: string; page: string; probe: string; rects: Rect[]; when?: (f: ProbeFinding) => boolean }): void;
  /**
   * Records the pictures the final runs still fail, fairly (see the file comment), and returns the
   * start page's marks. `startPage`: the start page's address (index 0). `pass`: the axe pass's
   * pictures, held until now (start shots, then one per rule in problem order). Never throws.
   */
  commit(runs: readonly ProbeRun[], recorder: EvidenceRecorder, startPage?: string, pass?: { start: readonly HeldShot[]; rules: readonly HeldShot[] }): Promise<HomeMark[]>;
}

const keyOf = (criterion: string, variant?: string) => `${criterion}\n${variant ?? ''}`;

export function createProbeEvidencePool(): ProbeEvidencePool {
  const taken = new Map<string, number>();
  const units: { unit: PoolUnit; seq: number; bytes: number }[] = [];
  const homes: { criterion: string; page: string; probe: string; rects: Rect[]; when?: (f: ProbeFinding) => boolean }[] = [];
  let seq = 0;
  let bytes = 0;
  let inUse = 0;
  let committed = false;
  const wants = (criterion: string, variant?: string) =>
    !committed && (taken.get(keyOf(criterion, variant)) ?? 0) < POOL_PER_KEY && inUse < POOL_MAX_UNITS && bytes < POOL_MAX_BYTES;
  return {
    wants,
    criteria() {
      const out = new Set<string>();
      for (const [key, n] of taken) if (n > 0) out.add(key.split('\n')[0]!);
      return out.size;
    },
    take(criterion, variant) {
      if (!wants(criterion, variant)) return null;
      const key = keyOf(criterion, variant);
      taken.set(key, (taken.get(key) ?? 0) + 1);
      inUse++;
      let done = false;
      return {
        key,
        release() {
          if (done) return;
          done = true;
          taken.set(key, Math.max(0, (taken.get(key) ?? 1) - 1));
          inUse = Math.max(0, inUse - 1);
        },
      };
    },
    offer(unit, ticket) {
      const size = unit.shots.reduce((t, s) => t + s.bytes.length, 0);
      if (committed || !unit.shots.length || bytes + size > POOL_MAX_BYTES) {
        ticket.release();
        return false;
      }
      bytes += size;
      units.push({ unit, seq: seq++, bytes: size });
      return true;
    },
    home(mark) {
      if (committed || !mark.rects.length) return;
      homes.push({ ...mark, rects: mark.rects.slice(0, HOME_PER_PROBLEM) });
    },
    async commit(runs, recorder, startPage, pass) {
      if (committed) return [];
      committed = true;
      try {
        const runOf = new Map<string, ProbeRun>();
        for (const r of runs) if (r.status === 'ok') runOf.set(`${r.probe}\n${r.page}`, r);
        const failing = (criterion: string, page: string, probe: string, when?: (f: ProbeFinding) => boolean) => {
          const run = runOf.get(`${probe}\n${page}`);
          return !!run?.findings.some((f) => {
            if (f.criterion !== criterion || f.status !== 'failed') return false;
            try {
              return when ? when(f) === true : true;
            } catch {
              return false;
            }
          });
        };
        // Pages each criterion fails on (all probes): the criteria that fail most widely come first.
        const spread = new Map<string, Set<string>>();
        for (const r of runs) {
          if (r.status !== 'ok') continue;
          for (const f of r.findings) if (f.status === 'failed') spread.set(f.criterion, (spread.get(f.criterion) ?? new Set()).add(r.page));
        }
        const kept = units.filter((u) => failing(u.unit.criterion, u.unit.page, u.unit.probe, u.unit.when))
          .sort((a, b) => a.unit.index - b.unit.index || a.seq - b.seq);
        // By problem: a criterion's scored tests' pictures, and apart from them its listed tests' ones.
        const byCriterion = new Map<string, PoolUnit[]>();
        for (const { unit } of kept) byCriterion.set(problemOf(unit), [...(byCriterion.get(problemOf(unit)) ?? []), unit]);
        const crit = (k: string) => k.split('\n')[0]!;
        const order = [...byCriterion.keys()].sort((a, b) => (spread.get(crit(b))?.size ?? 0) - (spread.get(crit(a))?.size ?? 0) || compareCriteria(crit(a), crit(b)) || (a < b ? -1 : a > b ? 1 : 0));
        const add = async (u: PoolUnit, spill: boolean) => {
          // A pair goes in whole or not at all.
          if (u.shots.length > (spill ? recorder.room('pass') : recorder.room('probe'))) return;
          for (const s of u.shots) await recorder.add(s.meta, s.bytes, recorder.room('probe') > 0 ? 'probe' : 'pass');
        };
        // The axe pass's pictures: the start page's first, then each rule's first picture in turn with
        // each criterion's, so neither kind of problem crowds the other out when the room runs short.
        for (const s of pass?.start ?? []) await recorder.add(s.shot, s.jpeg, 'pass');
        const rules = [...(pass?.rules ?? [])];
        const addRule = async (s: HeldShot | undefined) => {
          if (s && recorder.room('pass') > 0) await recorder.add(s.shot, s.jpeg, 'pass');
        };
        // The scored problems' pictures first; the listed (unscored) tests' only in the room they leave,
        // as their problems come after the scored ones in the report.
        const scoredOrder = order.filter((k) => !k.endsWith('\nlisted'));
        const listedOrder = order.filter((k) => k.endsWith('\nlisted'));
        // Round 1: the first picture of every problem: criteria in the probes' share and then in any room left.
        for (let i = 0; i < Math.max(scoredOrder.length, rules.length); i++) {
          await addRule(rules[i]);
          const c = scoredOrder[i];
          if (c !== undefined) await add(byCriterion.get(c)![0]!, true);
        }
        for (const c of listedOrder) await add(byCriterion.get(c)![0]!, true);
        // Round 2: second pictures (at most POOL_PER_KEY per criterion, whatever the kinds), in the probes' share only.
        for (let round = 1; round < POOL_PER_KEY; round++) {
          for (const c of [...scoredOrder, ...listedOrder]) {
            const u = byCriterion.get(c)![round];
            if (u) await add(u, false);
          }
        }
        if (startPage === undefined) return [];
        const marks = new Map<string, Rect[]>();
        for (const h of homes) {
          if (h.page !== startPage || !failing(h.criterion, h.page, h.probe, h.when)) continue;
          const problem = `criterion:${h.criterion}`;
          const list = marks.get(problem) ?? [];
          for (const r of h.rects) if (list.length < HOME_PER_PROBLEM) list.push(r);
          marks.set(problem, list);
        }
        return [...marks.entries()].map(([problem, rects]) => ({ problem, rects }));
      } catch {
        // Evidence never fails a scan.
        return [];
      } finally {
        units.length = 0;
        homes.length = 0;
        bytes = 0;
      }
    },
  };
}
