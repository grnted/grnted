// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The screen-reader pass: what NVDA and VoiceOver users hear on a page, simulated over Chromium's real
// accessibility tree (CDP), the same tree Chrome gives screen readers. It changes nothing on the page; on the
// first pages of the scan it pauses the page's script in the debugger for the moment it reads the tree and takes
// the AI listener's screenshot (both from the same frozen page, so text that moves by itself cannot differ between
// them), then lets the script run on. Reports what the tree proves (findings.ts) and keeps a bounded excerpt of
// the transcript for the report (`ProbeRun.data`, `SrReportData`). Listed, not scored, until the gold suite
// supports scoring it (docs/scoring.md). Engine core: no Node-only imports.
import type { ProbeFinding, ProbeRun, ScreenReaderPage, ScreenReaderSection, SrLine, SrLiveData, SrReportData } from '../../types.js';

export type { LiveLine, ScreenReaderPage, ScreenReaderSection, SrLine, SrLiveData, SrReportData } from '../../types.js';
import type { CDPSessionLike } from '../../types.js';
import { VISION_SCREENSHOT_PAGES, visionFactsVia, type VisionFacts } from '../../collect/vision.js';
import { PROBE_DATA_MAX_CHARS, ProbeNotTestable, type PageProbe, type ProbeContext } from '../types.js';
import { listenData, type SrListenData } from './listen.js';
import { screenReaderFindings, type SrFlag } from './findings.js';
import type { Voice } from './rules.js';
import { transcribe, type TranscriptBody, type Utterance } from './transcript.js';
import { readTree, within, SR_TREE_LIMITS } from './tree.js';
import { SCREEN_READER_LIVE_PROBE_ID } from './live.js';

export { listenData, type SrListenData, type SrListenLine } from './listen.js';
export { screenReaderFindings, SR_PER_KIND, type SrFindings, type SrFlag } from './findings.js';
export { CONTROL_ROLES, LANDMARK_WORDS, ROLE_WORDS, STATE_WORDS, speak, type Voice } from './rules.js';
export { FULL_CAPS, TRANSCRIPT_FORMAT, transcribe, type TranscriptBody, type TranscriptCaps, type TranscriptLists, type Utterance } from './transcript.js';
export { buildTree, readTree, snapshotFacts, SR_TREE_LIMITS, type AxNode, type DomSnapshot, type SrNode, type SrTree } from './tree.js';

export const SCREEN_READER_PROBE_ID = 'screen-reader';
export const SCREEN_READER_CRITERIA = ['1.3.1', '1.3.2', '2.4.4', '4.1.2'] as const;

/** The voice the report's excerpt is written in (NVDA, the most used screen reader on Windows). */
export const REPORT_VOICE: Voice = 'nvda';

/** The report's excerpt per page: read-through lines (plus every flagged line), list items, Tab stops. */
export const REPORT_CAPS = { readThrough: 40, list: 15, tabStops: 15, flags: 20, flaggedLines: 20 } as const;

/** Largest excerpt kept per page (characters of JSON), under the runner's data cap. */
export const REPORT_DATA_MAX_CHARS = 20_000;

const MAX_TEXT = 160;
const cut = (s: string) => (s.length > MAX_TEXT ? `${s.slice(0, MAX_TEXT - 1)}…` : s);

/** The report excerpt from a full transcript and its flags, bounded to `REPORT_DATA_MAX_CHARS`. Pure. */
export function reportData(t: TranscriptBody, flags: readonly SrFlag[], voice: Voice = REPORT_VOICE): SrReportData {
  const keptFlags = flags.slice(0, REPORT_CAPS.flags);
  const flagOf = new Map<string, number>();
  keptFlags.forEach((f, k) => { if (!flagOf.has(f.ref)) flagOf.set(f.ref, k); });
  const line = (u: Utterance, n: number): SrLine => {
    const f = u.nodeRef !== undefined && u.event !== 'exit' ? flagOf.get(u.nodeRef) : undefined;
    return { n, text: cut(u.text), ...(f !== undefined ? { flag: f } : {}) };
  };
  const all = t.readThrough.map(line);
  const head = all.slice(0, REPORT_CAPS.readThrough);
  const flagged = all.slice(REPORT_CAPS.readThrough).filter((l) => l.flag !== undefined).slice(0, REPORT_CAPS.flaggedLines);
  const list = (us: Utterance[], cap: number = REPORT_CAPS.list) => us.slice(0, cap).map((u) => cut(u.text));
  const data: SrReportData = {
    v: 1, voice, read: [...head, ...flagged],
    lists: {
      headings: list(t.lists.headings), landmarks: list(t.lists.landmarks), links: list(t.lists.links),
      formControls: list(t.lists.formControls), tables: list(t.lists.tables),
    },
    tab: list(t.tabStops, REPORT_CAPS.tabStops),
    flags: keptFlags.map((f) => ({ criterion: f.criterion, note: cut(f.note) })),
    counts: {
      read: t.readThrough.length, headings: t.lists.headings.length, landmarks: t.lists.landmarks.length, links: t.lists.links.length,
      formControls: t.lists.formControls.length, tables: t.lists.tables.length, tab: t.tabStops.length,
    },
    truncated: t.truncated,
  };
  // Hostile pages (very long names everywhere): halve the excerpt until it fits.
  while (JSON.stringify(data).length > REPORT_DATA_MAX_CHARS && (data.read.length > 1 || data.tab.length > 1)) {
    data.read = data.read.slice(0, Math.max(1, Math.floor(data.read.length / 2)));
    data.tab = data.tab.slice(0, Math.max(1, Math.floor(data.tab.length / 2)));
    for (const k of Object.keys(data.lists) as (keyof SrReportData['lists'])[]) data.lists[k] = data.lists[k].slice(0, Math.max(1, Math.floor(data.lists[k].length / 2)));
    data.truncated = true;
  }
  return data;
}

/** The screen-reader run's data: the report's excerpt, plus the AI listener's read-through (never in the report). */
export type SrProbeData = SrReportData & { listen?: SrListenData };

/** The longest the pass waits for the page's script to stop in the debugger before it reads without stopping it. */
export const PAUSE_WAIT_MS = 500;

/** Pages (scan order) where the pass also takes the AI listener's screenshot: the pages the listener can sample. */
export const SR_SHOT_PAGES = VISION_SCREENSHOT_PAGES;

/**
 * The tree, and on the first `SR_SHOT_PAGES` pages the listener's vision facts (screenshot, blocks, icons), read
 * at one moment: the page's script is paused in the debugger (CDP keeps answering), both are read, and the script
 * resumes, whatever happens. A page that does not stop within `PAUSE_WAIT_MS` is read without pausing.
 */
async function readFrozen(cdp: CDPSessionLike, ctx: ProbeContext, left: () => number): Promise<{ tree: Awaited<ReturnType<typeof readTree>>; facts?: VisionFacts }> {
  const shoot = ctx.pageIndex < SR_SHOT_PAGES;
  if (!shoot) return { tree: await readTree(cdp, ctx.deadline, SR_TREE_LIMITS) };
  // The screenshot shows the top of the page (as the vision check's does): scroll there before freezing.
  await ctx.page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior }), undefined).catch(() => undefined);
  let paused = false;
  let enabled = false;
  try {
    const stopped = new Promise<void>((resolve) => { cdp.on('Debugger.paused', () => { paused = true; resolve(); }); });
    enabled = (await within(cdp.send('Debugger.enable', {}).then(() => true), Math.min(2_000, left()))) === true;
    if (enabled) {
      await within(cdp.send('Debugger.pause', {}), Math.min(2_000, left()));
      await within(stopped, Math.min(PAUSE_WAIT_MS, left()));
      // Not stopped: turn the debugger off, which drops the pending pause (or the first evaluate below would stop).
      if (!paused) {
        await within(cdp.send('Debugger.disable', {}), 1_000);
        enabled = false;
      }
    }
    const facts = await visionFactsVia(cdp, Math.min(5_000, left()));
    const tree = await readTree(cdp, ctx.deadline, SR_TREE_LIMITS);
    return { tree, ...(facts?.screenshot?.length ? { facts } : {}) };
  } finally {
    if (paused) await within(cdp.send('Debugger.resume', {}), 1_000);
    if (enabled) await within(cdp.send('Debugger.disable', {}), 1_000);
  }
}

/** The screen-reader pass on one page. */
export async function runScreenReader(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const left = () => ctx.deadline - Date.now() - 200;
  const elements = await ctx.page.evaluate(() => document.getElementsByTagName('*').length, undefined).catch(() => -1);
  if (elements > SR_TREE_LIMITS.elements) {
    return SCREEN_READER_CRITERIA.map((c) => ({ criterion: c, status: 'not_testable' as const, detail: `this page is too large for the screen-reader test (${elements} elements)` }));
  }
  const cdp = ctx.cdp && left() > 0 ? await within(ctx.cdp(), Math.min(5_000, left())) : undefined;
  if (!cdp) throw new ProbeNotTestable('the browser gave no access to its accessibility tree on this page');
  const { tree, facts } = await readFrozen(cdp, ctx, left);
  // The listener's screenshot and page facts, taken with the tree (src/ai/checks/listener.ts reads them).
  if (facts) ctx.attach?.(facts);
  if (!tree || !tree.nodes.length) throw new ProbeNotTestable('the accessibility tree could not be read in time on this page');
  const { findings, flags } = screenReaderFindings(tree);
  const full = transcribe(tree, REPORT_VOICE, { readThrough: 2_000, list: 200, tabStops: 200 });
  const excerpt = reportData(full, flags);
  // The AI listener's read-through rides along in the room the run's data has left (src/ai/checks/listener.ts).
  const listen = listenData(tree, full, PROBE_DATA_MAX_CHARS - JSON.stringify(excerpt).length - 200);
  ctx.setData?.({ ...excerpt, listen } satisfies SrProbeData);
  const failed = new Set(findings.filter((f) => f.status === 'failed').map((f) => f.criterion));
  if (!tree.layout && !failed.has('1.3.2')) findings.push({ criterion: '1.3.2', status: 'not_testable', detail: 'the page layout could not be read with its accessibility tree' });
  if (tree.truncated) {
    for (const c of SCREEN_READER_CRITERIA) {
      if (!failed.has(c) && !findings.some((f) => f.criterion === c)) findings.push({ criterion: c, status: 'not_testable', detail: 'this page is too large to read in full' });
    }
  }
  return findings;
}

/** The screen-reader pass (core, every sampled page; listed, not scored, until calibrated). */
export const screenReaderProbe: PageProbe = {
  id: SCREEN_READER_PROBE_ID,
  criteria: [...SCREEN_READER_CRITERIA],
  kind: 'render',
  tier: 'core',
  scored: false,
  timeoutMs: 15_000,
  onlyNavigationVoids: true,
  run: runScreenReader,
};

export { findDisclosures, findToggles, formLines, runScreenReaderLive, screenReaderLiveProbe, toggleState, toggleVerdict, LIVE_LIMITS, SCREEN_READER_LIVE_CRITERIA, SCREEN_READER_LIVE_PROBE_ID, type Toggle, type ToggleState } from './live.js';

/** Pages in "What a screen reader hears": the start page and pages with findings, in scan order. */
export const SR_REPORT_PAGES = 5;

const isRead = (d: unknown): d is SrReportData => !!d && typeof d === 'object' && (d as SrReportData).v === 1 && Array.isArray((d as SrReportData).read) && !!(d as SrReportData).lists;
const isLive = (d: unknown): d is SrLiveData => !!d && typeof d === 'object' && (d as SrLiveData).v === 1 && Array.isArray((d as SrLiveData).lines);

/**
 * The report's "What a screen reader hears" from the two passes' runs (with their `data`, before the
 * scan drops it): the start page, then pages where either pass failed something, up to
 * `SR_REPORT_PAGES` (`aiFlagged`: pages the AI listener flagged, which count as pages with findings).
 * Undefined when neither pass ran. Pure.
 */
export function screenReaderSection(runs: readonly ProbeRun[], startUrl: string, cap: number = SR_REPORT_PAGES, aiFlagged: ReadonlySet<string> = new Set()): ScreenReaderSection | undefined {
  const mine = runs.filter((r) => r.probe === SCREEN_READER_PROBE_ID || r.probe === SCREEN_READER_LIVE_PROBE_ID);
  if (!mine.length) return undefined;
  const byPage = new Map<string, ScreenReaderPage>();
  for (const r of mine) {
    const p = byPage.get(r.page) ?? { page: r.page, failed: [] };
    if (r.probe === SCREEN_READER_PROBE_ID && isRead(r.data)) {
      // The listener's lines are for the AI review only: the report keeps the excerpt.
      const { listen: _listen, ...read } = r.data as SrProbeData;
      p.read = read;
    }
    if (r.probe === SCREEN_READER_LIVE_PROBE_ID && isLive(r.data)) p.live = r.data;
    for (const f of r.findings) if (f.status === 'failed') p.failed.push({ criterion: f.criterion, detail: f.detail.slice(0, 300) });
    byPage.set(r.page, p);
  }
  const all = [...byPage.values()].filter((p) => p.read || p.live);
  const start = all.find((p) => p.page === startUrl);
  // A page the AI listener flagged is a page with findings too (its findings are shown with it).
  const withFindings = all.filter((p) => p !== start && (p.failed.length || aiFlagged.has(p.page)));
  const pages = [...(start ? [start] : []), ...withFindings].slice(0, cap);
  return { voice: REPORT_VOICE, pages, morePages: Math.max(0, withFindings.length - (pages.length - (start ? 1 : 0))) };
}

/** The pages the AI listener flagged (src/ai/checks/listener.ts), for `screenReaderSection`'s `aiFlagged`. */
export function listenerFlaggedPages(ai: { runs: readonly { check: string; findings: readonly { flagged: boolean; page: string }[] }[] } | undefined): Set<string> {
  return new Set((ai?.runs ?? []).filter((r) => r.check === 'listener').flatMap((r) => r.findings.filter((f) => f.flagged).map((f) => f.page)));
}
