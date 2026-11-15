// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Evidence images taken by probes at the moment of failure (report v2, docs/specs/
// 2026-10-31-report-v2-design.md §3.3): the runner's `ProbeContext.evidence`, clip and box
// validation, and in-page helpers the probes use to find and scroll to what they box.
// Engine core: no Node-only imports.
import type { ProbeEvidencePool, PoolTicket } from '../evidence/probePool.js';
import type { EvidenceRecorder } from '../evidence/recorder.js';
import type { EvidenceBox, EvidenceShot, PageLike, ProbeFinding, ProbeRun } from '../types.js';
import type { ProbeContext, ProbeEvidenceShot } from './types.js';

export const PROBE_EVIDENCE_LIMITS = {
  /** Successful `ctx.evidence` calls per run (at most `PER_CRITERION_CALLS` per criterion). */
  calls: 4,
  quality: 72,
  /** Largest image, in CSS px (spec §3.1). */
  maxWidth: 1280,
  maxHeight: 900,
  boxes: 8,
  label: 24,
  alt: 300,
  caption: 200,
  group: 40,
  groupLabel: 60,
  /** A capture must be able to start this long before the time box ends. */
  marginMs: 200,
} as const;

export interface Rect { x: number; y: number; width: number; height: number }

const BOX_KINDS = new Set<EvidenceBox['kind']>(['fail', 'ghost', 'expected']);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const round1 = (v: number) => Math.round(v * 10) / 10;

/**
 * Text from a probe (or a page) for alt text, captions and labels: control, line-separator and
 * bidirectional-override characters become spaces, white space collapses, and it is clipped to `max`.
 */
export function cleanText(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  const t = v.replace(/[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/**
 * A clip in CSS px of the viewport, rounded outwards to whole pixels and clamped inside the viewport
 * and the image size limits; null when it is not four finite numbers or nothing of it is left.
 */
export function validClip(clip: unknown, view: { width: number; height: number }): Rect | null {
  if (!clip || typeof clip !== 'object' || Array.isArray(clip)) return null;
  const c = clip as Record<string, unknown>;
  if (!finite(c.x) || !finite(c.y) || !finite(c.width) || !finite(c.height) || c.width <= 0 || c.height <= 0) return null;
  const x0 = Math.max(0, Math.floor(c.x));
  const y0 = Math.max(0, Math.floor(c.y));
  const x1 = Math.min(view.width, Math.ceil(c.x + c.width), x0 + PROBE_EVIDENCE_LIMITS.maxWidth);
  const y1 = Math.min(view.height, Math.ceil(c.y + c.height), y0 + PROBE_EVIDENCE_LIMITS.maxHeight);
  if (x1 - x0 < 1 || y1 - y0 < 1) return null;
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/** The crop around a probe image's boxes (CSS px): padding on every side, and the smallest crop. */
export const PROBE_CROP = { pad: 48, minWidth: 640, minHeight: 240 } as const;

/**
 * A clip around `boxes` (viewport CSS px) so they show large in the report: their union inside the
 * viewport, with `PROBE_CROP.pad` on every side, at least 640×240, at most the viewport and 1280×900,
 * centred on the union and moved inside the viewport. `width` asks for that width instead of the
 * 640 px minimum (two images of a pair line up), never narrower than the union with its padding. Whole pixels. Null when no box is a
 * finite rectangle with some of it inside the viewport.
 */
export function cropAround(boxes: readonly Rect[], view: { width: number; height: number }, opts: { width?: number } = {}): Rect | null {
  if (!finite(view.width) || !finite(view.height) || view.width < 1 || view.height < 1) return null;
  const in_ = boxes.filter((b) => b && [b.x, b.y, b.width, b.height].every(finite) && b.width > 0 && b.height > 0
    && b.x < view.width && b.x + b.width > 0 && b.y < view.height && b.y + b.height > 0);
  if (!in_.length) return null;
  const x0 = Math.max(0, Math.min(...in_.map((b) => b.x)));
  const y0 = Math.max(0, Math.min(...in_.map((b) => b.y)));
  const x1 = Math.min(view.width, Math.max(...in_.map((b) => b.x + b.width)));
  const y1 = Math.min(view.height, Math.max(...in_.map((b) => b.y + b.height)));
  const maxW = Math.floor(Math.min(view.width, PROBE_EVIDENCE_LIMITS.maxWidth));
  const maxH = Math.floor(Math.min(view.height, PROBE_EVIDENCE_LIMITS.maxHeight));
  const pad = 2 * PROBE_CROP.pad;
  // A given width replaces the 640 px minimum (the second image of a pair matches the first).
  const asked = finite(opts.width) && opts.width >= 1 ? opts.width : PROBE_CROP.minWidth;
  const w = Math.min(maxW, Math.ceil(Math.max(asked, x1 - x0 + pad)));
  const h = Math.min(maxH, Math.ceil(Math.max(PROBE_CROP.minHeight, y1 - y0 + pad)));
  const x = Math.max(0, Math.min(Math.floor(view.width - w), Math.round((x0 + x1) / 2 - w / 2)));
  const y = Math.max(0, Math.min(Math.floor(view.height - h), Math.round((y0 + y1) / 2 - h / 2)));
  return { x, y, width: w, height: h };
}

/** 2.4.11's crop: how far it reaches left and right of the hidden element (CSS px). */
export const HIDDEN_CROP_SIDE = 300;

/**
 * The crop for a focused element hidden under another (2.4.11): the element's box ± 300 px wide, from
 * the top of the covering element (or the element, when higher) to the bottom of either, with
 * `PROBE_CROP.pad` below, at least `PROBE_CROP.minHeight` tall. Not the full-width union with a
 * full-width header, so the pair reads at phone width. Whole pixels, inside the viewport and the
 * 1280×900 limit. Null when either is not a finite rectangle or the element is off screen.
 */
export function cropAroundHidden(box: Rect, cover: Rect, view: { width: number; height: number }): Rect | null {
  const ok = (b: Rect) => b && [b.x, b.y, b.width, b.height].every(finite) && b.width > 0 && b.height > 0;
  if (!ok(box) || !ok(cover) || !finite(view.width) || !finite(view.height) || view.width < 1 || view.height < 1) return null;
  if (box.x >= view.width || box.x + box.width <= 0 || box.y >= view.height || box.y + box.height <= 0) return null;
  const maxW = Math.floor(Math.min(view.width, PROBE_EVIDENCE_LIMITS.maxWidth));
  const maxH = Math.floor(Math.min(view.height, PROBE_EVIDENCE_LIMITS.maxHeight));
  const left = Math.max(0, Math.floor(box.x - HIDDEN_CROP_SIDE));
  const right = Math.min(maxW, Math.ceil(box.x + box.width + HIDDEN_CROP_SIDE));
  const w = Math.min(maxW, right - left);
  const x = Math.max(0, Math.min(maxW - w, left));
  const top = Math.max(0, Math.floor(Math.min(box.y, cover.y)));
  const bottom = Math.min(view.height, Math.ceil(Math.max(box.y + box.height, cover.y + cover.height) + PROBE_CROP.pad));
  const h = Math.min(maxH, Math.max(PROBE_CROP.minHeight, bottom - top));
  const y = Math.max(0, Math.min(Math.floor(view.height - h), top));
  if (w < 1 || h < 1) return null;
  return { x, y, width: w, height: h };
}

/**
 * Callout boxes clamped inside an image of `size` (CSS px). `shift` moves them first (a clip that
 * clamping moved). Malformed boxes, unknown kinds and boxes with nothing inside the image are
 * dropped; at most `PROBE_EVIDENCE_LIMITS.boxes`; labels are cleaned and clipped to 24 characters.
 */
export function validBoxes(boxes: unknown, size: { width: number; height: number }, shift: { x: number; y: number } = { x: 0, y: 0 }): EvidenceBox[] {
  if (!Array.isArray(boxes)) return [];
  const out: EvidenceBox[] = [];
  for (const b of boxes as unknown[]) {
    if (out.length >= PROBE_EVIDENCE_LIMITS.boxes) break;
    if (!b || typeof b !== 'object') continue;
    const r = b as Record<string, unknown>;
    if (!BOX_KINDS.has(r.kind as EvidenceBox['kind'])) continue;
    if (!finite(r.x) || !finite(r.y) || !finite(r.width) || !finite(r.height) || r.width <= 0 || r.height <= 0) continue;
    const x0 = Math.max(0, r.x + shift.x);
    const y0 = Math.max(0, r.y + shift.y);
    const x1 = Math.min(size.width, r.x + shift.x + r.width);
    const y1 = Math.min(size.height, r.y + shift.y + r.height);
    if (x1 - x0 < 1 || y1 - y0 < 1) continue;
    const label = cleanText(r.label, PROBE_EVIDENCE_LIMITS.label);
    out.push({ x: round1(x0), y: round1(y0), width: round1(x1 - x0), height: round1(y1 - y0), kind: r.kind as EvidenceBox['kind'], ...(label ? { label } : {}) });
  }
  return out;
}

/** Width and height in pixels from a JPEG's frame header; null when the bytes are not a JPEG. */
export function jpegSize(bytes: Uint8Array): { width: number; height: number } | null {
  if (!(bytes instanceof Uint8Array) || bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 3 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) { i++; continue; }
    if (marker === 0xd9 || marker === 0xda) return null;
    const len = (bytes[i + 2]! << 8) | bytes[i + 3]!;
    if (len < 2) return null;
    // Start of frame (SOF0–SOF15, not DHT, JPG or DAC).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (i + 8 >= bytes.length) return null;
      const height = (bytes[i + 5]! << 8) | bytes[i + 6]!;
      const width = (bytes[i + 7]! << 8) | bytes[i + 8]!;
      return width > 0 && height > 0 ? { width, height } : null;
    }
    i += 2 + len;
  }
  return null;
}

/** Most keys in `ProbeFinding.data`. */
export const FINDING_DATA_KEYS = 5;

/**
 * `ProbeFinding.data` as kept: a plain object with at most 5 keys whose values are finite numbers or
 * strings (max 200 characters); anything else is dropped. Undefined when nothing is left.
 */
export function cleanFindingData(data: unknown): Record<string, number | string> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return undefined;
  const out: Record<string, number | string> = {};
  let n = 0;
  for (const [k, v] of Object.entries(data as Record<string, unknown>)) {
    if (n >= FINDING_DATA_KEYS) break;
    if (k.length > 40 || k === '__proto__') continue;
    if (finite(v)) out[k] = v;
    else if (typeof v === 'string') out[k] = cleanText(v, 200);
    else continue;
    n++;
  }
  return n ? out : undefined;
}

/** Resolves with the promise's value, or null when `until` (epoch ms) passes first or it rejects. */
export function before<T>(p: Promise<T>, until: number): Promise<T | null> {
  const left = until - Date.now();
  if (left <= 0) return Promise.resolve(null);
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p.catch(() => null),
    new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), left); }),
  ]).finally(() => clearTimeout(timer));
}

export interface RunEvidenceOptions {
  page: PageLike;
  /** `scored: false`: a listed test, whose pictures are shared out apart from the scored tests' (`PoolUnit.listed`). */
  probe: { id: string; criteria: readonly string[]; scored?: boolean };
  target: { url: string; index: number };
  /** The probe's viewport (clips are clamped to it). */
  viewport: { width: number; height: number };
  deviceScaleFactor?: number;
  /** Epoch ms when the run's time box ends. */
  deadline: number;
  signal: AbortSignal;
  recorder: EvidenceRecorder;
  /** Where the run's pictures wait until the probes end (`src/evidence/probePool.ts`). */
  pool: ProbeEvidencePool;
  /** The start page at the desktop width: the run may record start page marks (`evidenceHome`). */
  home?: boolean;
}

export interface RunEvidence {
  /** `ProbeContext.evidence`. Never throws. */
  evidence(shot: ProbeEvidenceShot): Promise<boolean>;
  /** `ProbeContext.evidenceWanted`. */
  wanted(criterion: string, variant?: string): boolean;
  /** `ProbeContext.evidenceHome` (only when `home`). */
  home(criterion: string, rects: unknown, when?: (f: ProbeFinding) => boolean): void;
  /**
   * The run's failed findings that name their element (`target`, a CSS path) on the start page at the
   * desktop width (only when `home`): measured where they sit on the first screen and kept as start
   * page marks, for the criteria the probe marked nothing for itself (report v2, "Homepage, as
   * checked": keyboard focus, hover content and other deep-test failures). Bounded
   * (`HOME_FAILURE_LIMITS`); an element not found or off the first screen gets no mark. Never throws.
   */
  markFailures(findings: readonly ProbeFinding[]): Promise<void>;
  /** The run's outcome is decided: later calls resolve false, and captures still under way are not kept. */
  seal(): void;
  /**
   * Hands the buffered pictures to the pool, in capture order: only for a run that ended `ok`, and
   * only pictures of criteria the run failed (or with a `when` test, decided when the probes end).
   * Returns how many pictures (a pair counts once) were handed over.
   */
  flush(run: ProbeRun): Promise<number>;
}

/** The pool variant a listed (unscored) test's pictures take their slots under (`ProbeEvidencePool.take`). */
export const LISTED_VARIANT = 'listed';

/** Most pictures of one criterion per run (a pair counts as two). */
export const PER_CRITERION_CALLS = 2;

/** `RunEvidence.markFailures`: criteria per run, elements per criterion, and the time it may take. */
export const HOME_FAILURE_LIMITS = { criteria: 6, perCriterion: 3, targetLength: 2000, ms: 1500 } as const;

interface Unit { criterion: string; ticket: PoolTicket; shots: { meta: Omit<EvidenceShot, 'id'>; bytes: Uint8Array }[]; when?: (f: ProbeFinding) => boolean }

/** One run's evidence: takes the JPEG at once, keeps it with the run until the run's outcome is known. */
export function createRunEvidence(o: RunEvidenceOptions): RunEvidence {
  const L = PROBE_EVIDENCE_LIMITS;
  const dsf = finite(o.deviceScaleFactor) && o.deviceScaleFactor > 0 ? o.deviceScaleFactor : 1;
  /** Pictures by unit: a group key, or one per ungrouped shot. */
  const units = new Map<string, Unit>();
  // A listed (unscored) test takes its pool slots apart from the scored tests' (see PoolUnit.listed).
  const listed = o.probe.scored === false;
  const slotVariant = (variant?: string) => (listed ? (variant ? `${LISTED_VARIANT}:${variant}` : LISTED_VARIANT) : variant);
  const homes: { criterion: string; rects: Rect[]; when?: (f: ProbeFinding) => boolean }[] = [];
  const perCriterion = new Map<string, number>();
  let used = 0;
  let inflight = 0;
  let seq = 0;
  let sealed = false;
  const open = () => !sealed && !o.signal.aborted;
  const roomFor = (criterion: string) => used + inflight < L.calls && (perCriterion.get(criterion) ?? 0) < PER_CRITERION_CALLS
    && Date.now() < o.deadline - L.marginMs && o.recorder.room('probe') > 0;

  async function capture(shot: ProbeEvidenceShot): Promise<boolean> {
    if (!open() || !shot || typeof shot !== 'object' || typeof shot.criterion !== 'string' || !o.probe.criteria.includes(shot.criterion)) return false;
    const criterion = shot.criterion;
    if (!roomFor(criterion)) return false;
    const alt = cleanText(shot.alt, L.alt);
    if (!alt) return false;
    const caption = cleanText(shot.caption, L.caption);
    const bare = shot.bare === true;
    // A bare picture (no box) must say what it shows.
    if (bare && (!caption || (Array.isArray(shot.boxes) && shot.boxes.length))) return false;
    let clip: Rect | null = null;
    if (shot.clip !== undefined) {
      clip = validClip(shot.clip, o.viewport);
      if (!clip) return false;
    }
    const group = cleanText(shot.group, L.group);
    const key = group ? `g\n${criterion}\n${group}` : `s\n${seq++}`;
    const existing = units.get(key);
    let ticket = existing?.ticket;
    let fresh = false;
    if (!ticket) {
      const variant = typeof shot.variant === 'string' ? shot.variant.slice(0, 40) : undefined;
      const t = o.pool.take(criterion, slotVariant(variant));
      if (!t) return false;
      ticket = t;
      fresh = true;
    }
    inflight++;
    perCriterion.set(criterion, (perCriterion.get(criterion) ?? 0) + 1);
    let kept = false;
    try {
      const bytes = await before(o.page.screenshot({ type: 'jpeg', quality: L.quality, ...(clip ? { clip } : {}) }), o.deadline - L.marginMs);
      if (!bytes || !open()) return false;
      const px = jpegSize(bytes);
      if (!px) return false;
      const size = { width: Math.round(px.width / dsf), height: Math.round(px.height / dsf) };
      if (size.width < 1 || size.height < 1 || size.width > L.maxWidth || size.height > L.maxHeight) return false;
      // Boxes are relative to the clip the probe asked for; clamping may have moved its corner.
      const shift = clip ? { x: (shot.clip!.x as number) - clip.x, y: (shot.clip!.y as number) - clip.y } : { x: 0, y: 0 };
      const boxes = bare ? [] : validBoxes(shot.boxes, size, shift);
      if (!bare && !boxes.length) return false;
      const groupLabel = cleanText(shot.groupLabel, L.groupLabel);
      const target = cleanText(shot.target, 200);
      // A viewport shot shows the whole viewport as it is now (a probe may have resized it).
      const view = clip ? o.viewport : size;
      const meta: Omit<EvidenceShot, 'id'> = {
        page: o.target.url, viewport: { width: view.width, height: view.height, deviceScaleFactor: dsf }, width: size.width, height: size.height,
        boxes, alt, ...(caption ? { caption } : {}), for: { criterion, probe: o.probe.id, ...(target ? { target } : {}) },
        ...(group ? { group: `${o.probe.id}:${o.target.index}:${group}` } : {}), ...(groupLabel ? { groupLabel } : {}),
      };
      const unit = existing ?? { criterion, ticket, shots: [], ...(typeof shot.when === 'function' ? { when: shot.when } : {}) };
      unit.shots.push({ meta, bytes });
      units.set(key, unit);
      used++;
      kept = true;
      return true;
    } finally {
      inflight--;
      if (!kept) {
        perCriterion.set(criterion, Math.max(0, (perCriterion.get(criterion) ?? 1) - 1));
        if (fresh && !units.has(key)) ticket.release();
      }
    }
  }

  return {
    async evidence(shot) {
      try {
        return await capture(shot);
      } catch {
        return false;
      }
    },
    wanted(criterion, variant) {
      try {
        return open() && typeof criterion === 'string' && o.probe.criteria.includes(criterion) && roomFor(criterion) && o.pool.wants(criterion, slotVariant(variant));
      } catch {
        return false;
      }
    },
    home(criterion, rects, when) {
      if (!o.home || !open() || typeof criterion !== 'string' || !o.probe.criteria.includes(criterion) || !Array.isArray(rects)) return;
      const view = { x: 0, y: 0, width: o.viewport.width, height: o.viewport.height };
      const ok = (rects as unknown[]).flatMap((r) => {
        if (!r || typeof r !== 'object') return [];
        const { x, y, width, height } = r as Record<string, unknown>;
        if (![x, y, width, height].every(finite) || (width as number) < 1 || (height as number) < 1) return [];
        const b = { x: x as number, y: y as number, width: width as number, height: height as number };
        // Some of it on the first screen.
        if (b.x >= view.width || b.y >= view.height || b.x + b.width <= 0 || b.y + b.height <= 0) return [];
        return [b];
      });
      if (ok.length) homes.push({ criterion, rects: ok.slice(0, 3), ...(typeof when === 'function' ? { when } : {}) });
    },
    async markFailures(findings) {
      try {
        if (!o.home || !open() || !Array.isArray(findings)) return;
        const L = HOME_FAILURE_LIMITS;
        const marked = new Set(homes.map((h) => h.criterion));
        const want = new Map<string, string[]>();
        for (const f of findings) {
          if (!f || f.status !== 'failed' || typeof f.target !== 'string' || !f.target.trim() || f.target.length > L.targetLength) continue;
          if (!o.probe.criteria.includes(f.criterion) || marked.has(f.criterion)) continue;
          const list = want.get(f.criterion) ?? [];
          if (!want.has(f.criterion) && want.size >= L.criteria) continue;
          if (list.length < L.perCriterion && !list.includes(f.target)) list.push(f.target);
          want.set(f.criterion, list);
        }
        if (!want.size) return;
        const criteria = [...want.keys()];
        const handles = criteria.flatMap((c) => want.get(c)!.map((sel) => ({ sel })));
        const r = await before(o.page.evaluate(elementRects, { handles, align: 'none', home: true }), Math.min(o.deadline, Date.now() + L.ms));
        if (!r || !Array.isArray(r.home) || !open()) return;
        let i = 0;
        for (const c of criteria) {
          const rects = r.home.slice(i, i + want.get(c)!.length).filter((b): b is Rect => !!b);
          i += want.get(c)!.length;
          if (rects.length) this.home(c, rects);
        }
      } catch {
        // Evidence never fails a run.
      }
    },
    seal() {
      sealed = true;
    },
    async flush(run) {
      sealed = true;
      const list = [...units.values()];
      units.clear();
      if (run.status !== 'ok') {
        for (const u of list) u.ticket.release();
        return 0;
      }
      const failed = new Set(run.findings.filter((f) => f.status === 'failed').map((f) => f.criterion));
      let n = 0;
      for (const u of list) {
        // A picture whose failure is decided across pages waits for the final runs; others need a failure now.
        if (!u.when && !failed.has(u.criterion)) {
          u.ticket.release();
          continue;
        }
        try {
          if (o.pool.offer({ criterion: u.criterion, page: o.target.url, index: o.target.index, probe: o.probe.id, shots: u.shots, ...(u.when ? { when: u.when } : {}), ...(listed ? { listed } : {}) }, u.ticket)) n++;
        } catch {
          // The pool never throws; evidence never fails a run.
        }
      }
      for (const h of homes.splice(0)) {
        try {
          o.pool.home({ criterion: h.criterion, page: o.target.url, probe: o.probe.id, rects: h.rects, ...(h.when ? { when: h.when } : {}) });
        } catch {
          // as above
        }
      }
      return n;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// In-page helpers (self-contained) for the render probes' captures.

/** A tracked layout item (`textLayout`'s `window.__grntedLayout`) or one of its elements. */
export type LayoutTarget = { item: number } | { el: number };

export interface TargetRects {
  /** The window's scroll position before (to put it back with `scrollWindow`). */
  sx: number;
  sy: number;
  /** Per target, its box in viewport CSS px after scrolling; null when it is gone or has no size. */
  boxes: (Rect | null)[];
  /** Per target, its text (a text node's, max 60 characters; '' for an element). */
  texts: string[];
  /** The document's title (max 80 characters). */
  title: string;
}

/**
 * Runs in the page (self-contained). Scrolls the window (only the window, instantly) so the first
 * target is in view, its top 8 px below the top edge ('top') or its middle at the viewport's middle
 * ('center'), then returns every target's box. A text node's box is that of its text.
 */
export function layoutTargets(arg: { targets: LayoutTarget[]; align: 'top' | 'center' }): TargetRects {
  const st = (window as unknown as { __grntedLayout?: { items: Node[]; els: Element[] } }).__grntedLayout;
  const sx = window.scrollX;
  const sy = window.scrollY;
  const rectOf = (t: LayoutTarget): DOMRect | null => {
    if (!st) return null;
    const node = 'item' in t ? st.items[t.item] : st.els[t.el];
    if (!node || !node.isConnected) return null;
    if (node.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(node);
      return range.getBoundingClientRect();
    }
    return (node as Element).getBoundingClientRect();
  };
  const first = arg.targets[0] ? rectOf(arg.targets[0]) : null;
  if (first && first.width > 0 && first.height > 0) {
    const vh = document.documentElement.clientHeight || innerHeight;
    const top = arg.align === 'center' ? first.top + first.height / 2 - vh / 2 : first.top - 8;
    window.scrollTo({ left: sx, top: sy + top, behavior: 'instant' as ScrollBehavior });
  }
  const boxes = arg.targets.map((t) => {
    const r = rectOf(t);
    return r && r.width > 0 && r.height > 0 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  });
  const texts = arg.targets.map((t) => {
    const node = st && 'item' in t ? st.items[t.item] : undefined;
    return node && node.nodeType === 3 ? String(node.nodeValue || '').replace(/\s+/g, ' ').trim().slice(0, 60) : '';
  });
  const title = String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { sx, sy, boxes, texts, title };
}

/** Runs in the page (self-contained): puts the window's scroll position back. */
export function scrollWindow(arg: { x: number; y: number }): void {
  window.scrollTo({ left: arg.x, top: arg.y, behavior: 'instant' as ScrollBehavior });
}

/** Enough of the time box left for a capture that takes about `ms`. */
export const timeFor = (ctx: { deadline: number; signal: AbortSignal }, ms: number) => !ctx.signal.aborted && ctx.deadline - Date.now() > ms;

/** "the page “Title”", or "the page" without a title, for alt text. */
export function pageWords(title: string): string {
  const t = cleanText(title, 60);
  return t ? `The page “${t}”` : 'The page';
}

// ---------------------------------------------------------------------------------------------
// Core-test pictures: one element (or a few) boxed at the moment of failure, and the start page's marks.

/**
 * How a probe points at an element for a picture: a CSS path (parts joined by ' >>> ' into open
 * shadow roots; main document only), an element in a probe's in-page store (`window[key][ref]`), or a
 * node `textLayout` tracks.
 */
export type ElementHandle = { sel: string } | { key: string; ref: number } | { layout: LayoutTarget };

export interface ElementRects {
  /** The window's scroll position before (to put it back). */
  sx: number;
  sy: number;
  /** Per handle, its box in viewport CSS px after scrolling; null when it is not found or has no size. */
  boxes: (Rect | null)[];
  /**
   * Per handle, its box on the page's first screen (document CSS px at scroll 0), measured before
   * scrolling; null when it is not on the first screen or that cannot be known (inside a fixed or
   * sticky box while the page is scrolled). Only with `home`.
   */
  home: (Rect | null)[];
  /** The visible viewport (CSS px). */
  vw: number;
  vh: number;
  title: string;
}

/**
 * Runs in the page (self-contained). Finds each handle's element (or text node), optionally measures
 * where it sits on the first screen (`home`), then scrolls the window (only the window, instantly) so
 * the first one found is in view ('center': its middle at the viewport's middle; 'top': 8 px below the
 * top edge; 'none': no scrolling) and returns every box.
 */
export async function elementRects(arg: { handles: ElementHandle[]; align: 'none' | 'top' | 'center'; home: boolean }): Promise<ElementRects> {
  const sx = window.scrollX;
  const sy = window.scrollY;
  const find = (h: ElementHandle): Element | Node | null => {
    try {
      if ('sel' in h) {
        if (typeof h.sel !== 'string' || h.sel.length > 2000) return null;
        let root: Document | ShadowRoot = document;
        let el: Element | null = null;
        for (const part of h.sel.split(' >>> ')) {
          el = root.querySelector(part);
          if (!el) return null;
          if (el.shadowRoot) root = el.shadowRoot;
        }
        return el;
      }
      if ('key' in h) {
        const list = (window as unknown as Record<string, unknown>)[h.key];
        const node = Array.isArray(list) ? (list[h.ref] as Node | undefined) : undefined;
        return node && node.isConnected ? node : null;
      }
      const st = (window as unknown as { __grntedLayout?: { items: Node[]; els: Element[] } }).__grntedLayout;
      const node = st ? ('item' in h.layout ? st.items[h.layout.item] : st.els[h.layout.el]) : undefined;
      return node && node.isConnected ? node : null;
    } catch {
      return null;
    }
  };
  const rectOf = (n: Element | Node | null): DOMRect | null => {
    if (!n) return null;
    let r: DOMRect;
    if (n.nodeType === 3) {
      const range = document.createRange();
      range.selectNodeContents(n);
      r = range.getBoundingClientRect();
    } else r = (n as Element).getBoundingClientRect();
    return r.width >= 1 && r.height >= 1 ? r : null;
  };
  const pinned = (n: Node): boolean => {
    let el: Element | null = n.nodeType === 1 ? (n as Element) : n.parentElement;
    for (let i = 0; el && i < 60; i++) {
      const p = getComputedStyle(el).position;
      if (p === 'fixed' || p === 'sticky') return true;
      el = el.parentElement ?? ((el.getRootNode() as ShadowRoot).host ?? null);
    }
    return false;
  };
  const nodes = arg.handles.map(find);
  const vw = Math.min(window.innerWidth, document.documentElement.clientWidth || window.innerWidth);
  const vh = Math.min(window.innerHeight, document.documentElement.clientHeight || window.innerHeight);
  const home = arg.handles.map((_, i) => {
    if (!arg.home) return null;
    const n = nodes[i];
    const r = n ? rectOf(n) : null;
    if (!n || !r) return null;
    const fixed = pinned(n);
    if (fixed && (sx !== 0 || sy !== 0)) return null;
    const x = r.left + (fixed ? 0 : sx);
    const y = r.top + (fixed ? 0 : sy);
    if (x >= vw || y >= vh || x + r.width <= 0 || y + r.height <= 0) return null;
    return { x, y, width: r.width, height: r.height };
  });
  const first = nodes.map(rectOf).find((r) => r);
  if (first && arg.align !== 'none') {
    const top = arg.align === 'center' ? first.top + first.height / 2 - vh / 2 : first.top - 8;
    window.scrollTo({ left: sx, top: Math.max(0, sy + top), behavior: 'instant' as ScrollBehavior });
    // Sticky headers and lazy layout settle on the next frames (at most 150 ms).
    await new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 150); });
  }
  const boxes = nodes.map((n) => {
    const r = rectOf(n);
    return r ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
  });
  const title = String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  return { sx, sy, boxes, home, vw, vh, title };
}

/** The page's first screen at the desktop width is what "Homepage, as checked" shows. */
const homeWanted = (ctx: Pick<ProbeContext, 'evidenceHome'>) => typeof ctx.evidenceHome === 'function';

export interface ElementShot {
  criterion: string;
  /** The elements to box (the first one is scrolled into view); at most 3 are boxed. */
  handles: ElementHandle[];
  /** Alt text from the page's title (see `pageWords`). */
  alt: (title: string) => string;
  caption?: string;
  variant?: string;
  when?: (f: ProbeFinding) => boolean;
  /** The failed finding's target: the element the picture boxes (`ProbeEvidenceShot.target`). */
  target?: string;
  /** Default 'center'. 'none': the element is already where the picture should show it (the probe scrolled there). */
  align?: 'none' | 'top' | 'center';
  /** Record the start page marks only (no picture), e.g. for a failure already pictured elsewhere. */
  homeOnly?: boolean;
}

/**
 * Pictures a failing element now (report v2 core-test evidence): asks whether a picture is still
 * wanted, finds the element, records where it sits on the start page's first screen (when this is the
 * start page at the desktop width), scrolls it into view, crops around it (`cropAround`) and boxes it
 * with no label, so the report draws the problem's number on it. Puts the scroll position back.
 * Never throws; resolves true when a picture was taken.
 */
export async function shootElements(ctx: ProbeContext, o: ElementShot): Promise<boolean> {
  const wantShot = !o.homeOnly && !!ctx.evidence && (ctx.evidenceWanted?.(o.criterion, o.variant) ?? false);
  const wantHome = homeWanted(ctx);
  if ((!wantShot && !wantHome) || !o.handles.length || !timeFor(ctx, 2500)) return false;
  let back: { x: number; y: number } | undefined;
  try {
    const r = await before(ctx.page.evaluate(elementRects, { handles: o.handles.slice(0, 3), align: wantShot ? o.align ?? 'center' : 'none', home: wantHome }), ctx.deadline - 1500);
    if (!r) return false;
    if (wantShot && (o.align ?? 'center') !== 'none') back = { x: r.sx, y: r.sy };
    if (wantHome) ctx.evidenceHome!(o.criterion, r.home.filter((b): b is Rect => b !== null), o.when);
    if (!wantShot) return false;
    const view = { width: Math.min(r.vw, ctx.viewport.width), height: Math.min(r.vh, ctx.viewport.height) };
    const found = r.boxes.filter((b): b is Rect => b !== null);
    const clip = cropAround(found, view);
    if (!clip) return false;
    return await ctx.evidence!({
      criterion: o.criterion, clip,
      boxes: found.map((b) => ({ x: b.x - clip.x, y: b.y - clip.y, width: b.width, height: b.height, kind: 'fail' as const })),
      alt: o.alt(r.title), ...(o.caption ? { caption: o.caption } : {}), ...(o.variant ? { variant: o.variant } : {}), ...(o.when ? { when: o.when } : {}),
      ...(o.target ? { target: o.target } : {}),
    });
  } catch {
    return false;
  } finally {
    if (back) await ctx.page.evaluate(scrollWindow, back).catch(() => {});
  }
}

/** Runs in the page (self-contained): scrolls to the top and returns the old position and the title. */
async function topOfPage(): Promise<{ sx: number; sy: number; title: string }> {
  const sx = window.scrollX;
  const sy = window.scrollY;
  window.scrollTo({ left: 0, top: 0, behavior: 'instant' as ScrollBehavior });
  await new Promise<void>((r) => { requestAnimationFrame(() => requestAnimationFrame(() => r())); setTimeout(r, 150); });
  return { sx, sy, title: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 80) };
}

/** The page's first screen with no box (a failure no element shows, such as a page with no main heading). Never throws. */
export async function shootFirstScreen(ctx: ProbeContext, o: { criterion: string; alt: (title: string) => string; caption: string; variant?: string }): Promise<boolean> {
  if (!ctx.evidence || !(ctx.evidenceWanted?.(o.criterion, o.variant) ?? false) || !timeFor(ctx, 2500)) return false;
  let back: { x: number; y: number } | undefined;
  try {
    const t = await before(ctx.page.evaluate(topOfPage, undefined), ctx.deadline - 1500);
    if (!t) return false;
    back = { x: t.sx, y: t.sy };
    return await ctx.evidence({ criterion: o.criterion, boxes: [], bare: true, alt: o.alt(t.title), caption: o.caption, ...(o.variant ? { variant: o.variant } : {}) });
  } catch {
    return false;
  } finally {
    if (back) await ctx.page.evaluate(scrollWindow, back).catch(() => {});
  }
}
