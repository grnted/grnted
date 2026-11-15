// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The read-through as the AI listener hears it (src/ai/checks/listener.ts): every spoken line in order,
// its role, and where its element sits on the page (top in CSS px), or that it is not shown (a 1 px
// visually hidden element, or one placed off the page). Attached to the screen-reader pass's run data
// for the AI review only (`ProbeRun.data.listen`); the report's excerpt never carries it. Pure, bounded.
// Engine core: no Node-only imports.
import { FORM_CONTROL_ROLES, LANDMARK_WORDS } from './rules.js';
import type { TranscriptBody } from './transcript.js';
import type { SrTree } from './tree.js';

/** One spoken line: its words (`t`), its role (`r`), its element's top (`y`) or that it is not shown (`s`). */
export interface SrListenLine {
  t: string;
  r: string;
  /** The accessible name, when the spoken words are not just the name (its element key, src/aiDedupe.ts). */
  n?: string;
  /** Top of its element in CSS px from the top of the page (absent when the layout is unknown). */
  y?: number;
  /** 'hidden': visually hidden (1 px or smaller); 'offscreen': placed wholly outside the page. */
  s?: 'hidden' | 'offscreen';
  /**
   * Plain text that labels what line `l` (1-based) reads, a form control, a group or a landmark: its words are that
   * control's accessible name, or part of it (a label around the control, or a label for it, read once as
   * the control's name and again as text). One item, shown and heard.
   */
  l?: number;
  /** 1: a frame whose content is not in the lines (its own document; a screen reader reads it in place). */
  u?: 1;
  /**
   * 1: a table cell whose headers attribute names an id that is not a cell of its table; the line says the header
   * above it instead (the transcript keeps the position's header), which a screen reader may or may not say.
   */
  h?: 1;
}

export interface SrListenData {
  v: 1;
  lines: SrListenLine[];
  /** Read-through lines before the cut. */
  total: number;
  /** A cap stopped the read-through or the lines were cut to fit. */
  truncated: boolean;
}

/** Characters kept per line. */
const LINE_TEXT = 200;

const cut = (s: string) => (s.length > LINE_TEXT ? `${s.slice(0, LINE_TEXT - 1)}…` : s);

/** Lines around a control searched for its label's text (a label before or after it, or around it). */
const LABEL_WINDOW = 4;
/** Text roles a label's words are read as. */
const TEXT_ROLES: ReadonlySet<string> = new Set(['statictext', 'labeltext', 'generic', 'paragraph']);
/** Form controls a label names (a button names itself from its content), and groups a legend names. */
const LABELLED: ReadonlySet<string> = new Set([...FORM_CONTROL_ROLES].filter((r) => r !== 'button' && r !== 'disclosuretriangle').concat(['group', 'radiogroup']));
/**
 * Landmarks: a visible title is their label only when it is exactly the landmark's name AND comes from the element the
 * landmark's aria-labelledby names (transcript `namesLandmark`). A bold "Account" inside a menu named "Customer account
 * menu" is not its label, and stays a possible missing heading (review round 1).
 */
const LANDMARKS: ReadonlySet<string> = new Set(Object.keys(LANDMARK_WORDS));
const words = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * For each line, the 1-based line of the form control whose accessible name contains its words (the
 * nearest such control within LABEL_WINDOW lines), for plain text lines only.
 */
function labelsOf(roles: readonly string[], texts: readonly string[], names: readonly string[], titles: readonly boolean[] = []): (number | undefined)[] {
  return texts.map((t, i) => {
    if (!TEXT_ROLES.has(roles[i]!)) return undefined;
    const w = words(t);
    if (w.length < 2) return undefined;
    let best: number | undefined;
    for (let j = Math.max(0, i - LABEL_WINDOW); j <= Math.min(texts.length - 1, i + LABEL_WINDOW); j++) {
      if (j === i) continue;
      const fits = LABELLED.has(roles[j]!) ? words(names[j]!).includes(w) : LANDMARKS.has(roles[j]!) && !!titles[i] && words(names[j]!) === w;
      if (!fits) continue;
      if (best === undefined || Math.abs(j - i) < Math.abs(best - i)) best = j;
    }
    return best === undefined ? undefined : best + 1;
  });
}

/**
 * The listener's lines from a full transcript (`transcribe`) and its tree, within `maxChars` of JSON:
 * lines past the budget are cut from the end (`truncated`).
 */
export function listenData(tree: SrTree, t: TranscriptBody, maxChars: number): SrListenData {
  const boxOf = new Map<string, { x: number; y: number; w: number; h: number }>();
  if (tree.layout) for (const n of tree.nodes) if (n.ref && n.box && !boxOf.has(n.ref)) boxOf.set(n.ref, n.box);
  const lines: SrListenLine[] = [];
  const roles: string[] = [];
  const names: string[] = [];
  const titles: boolean[] = [];
  for (const u of t.readThrough) {
    // Leaving a landmark or a table is kept; leaving a list says nothing new.
    if (u.event === 'exit' && u.role === 'list') continue;
    const line: SrListenLine = { t: cut(u.text), r: u.role };
    if (u.name && u.name !== u.text) line.n = cut(u.name);
    if (u.unread) line.u = 1;
    if (u.headersUnresolved) line.h = 1;
    const b = u.nodeRef ? boxOf.get(u.nodeRef) : undefined;
    if (b) {
      if (b.w <= 1 || b.h <= 1) line.s = 'hidden';
      else if (b.x + b.w <= 0 || b.y + b.h <= 0) line.s = 'offscreen';
      else line.y = Math.round(b.y);
    }
    lines.push(line);
    roles.push(u.role);
    names.push(u.name ?? '');
    titles.push(!!u.namesLandmark);
  }
  labelsOf(roles, lines.map((l) => l.t), names, titles).forEach((l, i) => {
    if (l !== undefined) lines[i]!.l = l;
  });
  const data: SrListenData = { v: 1, lines, total: t.readThrough.length, truncated: t.truncated };
  // Fit the budget: drop lines from the end (the start of a page carries its structure and menus).
  let size = JSON.stringify(data).length;
  if (size > maxChars) {
    data.truncated = true;
    while (data.lines.length && size > maxChars) {
      const dropped = data.lines.pop()!;
      size -= JSON.stringify(dropped).length + 1;
    }
    // A label whose control was cut keeps no pointer past the end.
    for (const l of data.lines) if (l.l !== undefined && l.l > data.lines.length) delete l.l;
  }
  return data;
}
