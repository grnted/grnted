// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a screen reader says on a page, from the accessibility tree (tree.ts) and the announcement rules
// (rules.ts): the read-through (NVDA browse mode down arrow, VoiceOver VO+Right), the elements lists /
// rotor (headings, landmarks, links, form controls, tables) and the Tab stops, in the transcript format
// agreed with the real-VoiceOver calibration (FORMAT.md). Pure, bounded, no recursion. Engine core.
import {
  CONTAINER_WORDS, CONTROL_ROLES, FORM_CONTROL_ROLES, LANDMARK_NEEDS_NAME, LANDMARK_WORDS, NAME_FROM_CONTENT_LEAVES, fill, speak,
  type Voice,
} from './rules.js';
import type { SrNode, SrTree } from './tree.js';

export const TRANSCRIPT_FORMAT = 'grnted-sr-transcript/1';

export interface Utterance {
  text: string;
  role: string;
  name: string;
  nodeRef?: string;
  level?: number;
  states?: string[];
  landmark?: string;
  event?: 'enter' | 'exit' | 'item';
  /**
   * A frame whose content is not in this tree (Chromium's tree for a page holds its own frame only; a screen
   * reader reads the frame's content in place). The transcript cannot say what is in it.
   */
  unread?: true;
  /** A cell whose `headers` attribute names an id that is not a cell of its table: read with the header above it. */
  headersUnresolved?: true;
  /**
   * Text that is exactly the name of the landmark it is in, from an element that landmark's aria-labelledby names
   * (a visible title naming a menu): heard as the landmark's name and again as text.
   */
  namesLandmark?: true;
}

export interface TranscriptLists {
  headings: Utterance[];
  landmarks: Utterance[];
  links: Utterance[];
  formControls: Utterance[];
  tables: Utterance[];
}

/** The page-independent part of a FORMAT.md file (the caller adds source, page, url, capturedAt, viewport). */
export interface TranscriptBody {
  readThrough: Utterance[];
  lists: TranscriptLists;
  tabStops: Utterance[];
  truncated: boolean;
}

export interface TranscriptCaps {
  /** Read-through lines kept. */
  readThrough: number;
  /** Items kept per elements list. */
  list: number;
  /** Tab stops kept. */
  tabStops: number;
}

/** Full transcripts (calibration). The probe keeps a smaller excerpt in the report (`REPORT_CAPS`). */
export const FULL_CAPS: TranscriptCaps = { readThrough: 5_000, list: 1_000, tabStops: 1_000 };

const TABLE_ROLES = new Set(['table', 'grid', 'treegrid']);
const ROW_ROLES = new Set(['row']);
const CELL_ROLES = new Set(['cell', 'gridcell', 'columnheader', 'rowheader']);
/** Named containers announced on entry and exit (NVDA "grouping", VoiceOver "group"). */
const NAMED_GROUPS = new Set(['group', 'radiogroup', 'dialog', 'alertdialog', 'figure']);
/** Announced on entry even with no name (NVDA and VoiceOver say "article"; calibration 2026-11-05). */
const ENTERED = new Set(['article']);
/** Roles read inside a link or button (a > h2). */
const HEADING_ROLES: ReadonlySet<string> = new Set(['heading']);

export const isLandmark = (n: Pick<SrNode, 'role' | 'name'>): boolean => !!LANDMARK_WORDS[n.role] && (!LANDMARK_NEEDS_NAME.has(n.role) || !!n.name);

/** Rows of a table (through row groups) and their cells, in order. */
export function tableShape(tree: SrTree, table: SrNode): { rows: SrNode[]; cells: SrNode[][] } {
  const rows: SrNode[] = [];
  const stack = [...table.children].reverse();
  let guard = 0;
  while (stack.length && guard++ < 50_000) {
    const n = tree.nodes[stack.pop()!]!;
    if (ROW_ROLES.has(n.role)) rows.push(n);
    else if (!TABLE_ROLES.has(n.role)) for (let k = n.children.length - 1; k >= 0; k--) stack.push(n.children[k]!);
  }
  return { rows, cells: rows.map((r) => r.children.map((c) => tree.nodes[c]!).filter((c) => CELL_ROLES.has(c.role))) };
}

/** Only plain text under the node (so reading its name says all of it). */
function onlyText(tree: SrTree, n: SrNode): boolean {
  const stack = [...n.children];
  let guard = 0;
  while (stack.length && guard++ < 2_000) {
    const k = tree.nodes[stack.pop()!]!;
    if (k.role !== 'statictext' && k.role !== 'generic' && k.role !== 'paragraph' && k.role !== 'labeltext') return false;
    stack.push(...k.children);
  }
  return true;
}

/** The transcript of a tree in one voice, within the caps. */
export function transcribe(tree: SrTree, voice: Voice = 'voiceover', caps: TranscriptCaps = FULL_CAPS): TranscriptBody {
  const { nodes } = tree;
  let truncated = tree.truncated;
  const readThrough: Utterance[] = [];
  const say = (u: Utterance) => {
    if (readThrough.length >= caps.readThrough) { truncated = true; return false; }
    readThrough.push(u);
    return true;
  };
  const base = (n: SrNode, landmark: string | undefined): Utterance => {
    const u: Utterance = { text: '', role: n.role, name: n.name };
    if (n.ref) u.nodeRef = n.ref;
    if (n.level !== undefined) u.level = n.level;
    if (n.states.length) u.states = [...n.states];
    if (landmark) u.landmark = landmark;
    return u;
  };
  const item = (n: SrNode, landmark: string | undefined, name = n.name): Utterance => {
    const u = base(n, landmark);
    u.name = name;
    u.text = speak(voice, { role: n.role, name, ...(n.level !== undefined ? { level: n.level } : {}), states: n.states, ...(n.value ? { value: n.value } : {}), ...(n.description ? { description: n.description } : {}) });
    return u;
  };
  // Column headers per cell, for data cells read inside a table.
  const headerOf = new Map<number, string>();
  const unresolvedHeaders = new Set<number>();
  const squash = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  /** The plain text under a node (its static text, in order), bounded. */
  const plainText = (n: SrNode): string => {
    const out: string[] = [];
    const st = [...n.children].reverse();
    let guard = 0;
    while (st.length && guard++ < 2_000) {
      const k = nodes[st.pop()!]!;
      if (k.role === 'statictext') { if (k.name) out.push(k.name); continue; }
      for (let j = k.children.length - 1; j >= 0; j--) st.push(k.children[j]!);
    }
    return out.join(' ');
  };
  const tableWords = (t: SrNode) => {
    const { rows, cells } = tableShape(tree, t);
    const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
    const header = cells.find((r) => r.some((c) => c.role === 'columnheader'));
    if (header) {
      for (const r of cells) {
        if (r === header) continue;
        r.forEach((c, k) => { const h = header[k]; if (h && h.name && c.role !== 'columnheader') headerOf.set(c.i, h.name); });
      }
    }
    // A cell with a headers attribute is read with the cells it names, in its order (HTML table model;
    // NVDA and VoiceOver follow it), not with the header above it: tables with sections (a "Concession"
    // header row under "Adult") say the right section.
    // Only when every id it names is another cell of the table (a wrong or partial value is not trusted: the cell
    // keeps the header above it, and the line says the headers did not resolve).
    const byId = new Map<string, SrNode>();
    for (const r of cells) for (const c of r) if (c.domId && !byId.has(c.domId)) byId.set(c.domId, c);
    for (const r of cells) {
      for (const c of r) {
        if (!c.headers?.length) continue;
        const named = c.headers.map((id) => byId.get(id));
        if (named.some((h) => !h || h === c)) { unresolvedHeaders.add(c.i); continue; }
        const names = (named as SrNode[]).filter((h) => !!h.name).map((h) => h.name);
        if (names.length) headerOf.set(c.i, names.join(', '));
      }
    }
    return { rows: rows.length, cols };
  };

  /**
   * A heading with a link or control inside (h2 > a), or a link or button with a heading inside (a > h2), is
   * read as both: NVDA says "heading level 2, link, Apply or file" and "link, heading level 2, Utility Billing,
   * Pay your bill"; VoiceOver the same words name-first. The words inside, in order (the inner item spoken
   * with its role, plain text as it is); undefined when the node has no such item inside (read by its name).
   */
  const innerWords = (n: SrNode, depth = 0): string | undefined => {
    const wanted = n.role === 'heading' ? CONTROL_ROLES : n.role === 'link' || n.role === 'button' || n.role === 'disclosuretriangle' ? HEADING_ROLES : undefined;
    if (!wanted) return undefined;
    // A heading named by aria-label or aria-labelledby (its name is not its content) is said by that name.
    if (n.role === 'heading' && squash(n.name) !== squash(plainText(n))) return undefined;
    const parts: string[] = [];
    let found = false;
    const st = [...n.children].reverse();
    let guard = 0;
    while (st.length && guard++ < 2_000) {
      const k = nodes[st.pop()!]!;
      if (wanted.has(k.role)) {
        found = true;
        // One level deep (a heading in a link in a heading is read by its name): bounded, no deep recursion.
        const words = depth === 0 ? innerWords(k, 1) : undefined;
        parts.push(speak(voice, { role: k.role, name: words ?? k.name, ...(k.level !== undefined ? { level: k.level } : {}), states: k.states }));
        continue;
      }
      if (k.role === 'statictext') { if (k.name) parts.push(k.name); continue; }
      if (k.role === 'img' && k.name) { parts.push(speak(voice, { role: 'img', name: k.name })); continue; }
      for (let j = k.children.length - 1; j >= 0; j--) st.push(k.children[j]!);
    }
    return found ? parts.join(', ') : undefined;
  };

  /** Text that is exactly its landmark's name and comes from an element that landmark's aria-labelledby names. */
  const titlesLandmark = (n: SrNode): boolean => {
    if (!n.ownerIds?.length) return false;
    for (let a = n.parent, k = 0; a >= 0 && k < 60; a = nodes[a]!.parent, k++) {
      const l = nodes[a]!;
      if (!isLandmark(l)) continue;
      return !!l.labelledBy?.some((id) => n.ownerIds!.includes(id)) && squash(l.name) === squash(n.name);
    }
    return false;
  };

  // Depth-first walk with an explicit stack: 'open' visits a node, 'close' speaks its exit line.
  type Step = { node: number; close?: Utterance; landmark: string | undefined };
  const root = nodes[0];
  const stack: Step[] = root ? [{ node: 0, landmark: undefined }] : [];
  while (stack.length) {
    const step = stack.pop()!;
    if (step.close) { if (!say(step.close)) break; continue; }
    const n = nodes[step.node]!;
    let landmark = step.landmark;
    let close: Utterance | undefined;
    let leaf = false;
    if (isLandmark(n)) {
      const w = LANDMARK_WORDS[n.role]![voice];
      if (!say({ ...base(n, landmark), states: undefined, text: voice === 'nvda' ? [w, n.name].filter(Boolean).join(', ') : [n.name, w].filter(Boolean).join(', '), event: 'enter' })) break;
      close = { ...base(n, landmark), states: undefined, text: fill(CONTAINER_WORDS.landmarkExit[voice], { landmark: w }), event: 'exit' };
      landmark = n.role;
    } else if (n.role === 'list') {
      const count = n.children.filter((c) => nodes[c]!.role === 'listitem').length;
      if (!say({ ...base(n, landmark), text: fill(CONTAINER_WORDS.list.enter[voice], { n: count }), event: 'enter' })) break;
      close = { ...base(n, landmark), text: CONTAINER_WORDS.list.exit[voice], event: 'exit' };
    } else if (TABLE_ROLES.has(n.role)) {
      const { rows, cols } = tableWords(n);
      const words = fill(CONTAINER_WORDS.table.enter[voice], { rows, cols });
      if (!say({ ...base(n, landmark), text: n.name ? (voice === 'nvda' ? `${words}, ${n.name}` : `${n.name}, ${words}`) : words, event: 'enter' })) break;
      close = { ...base(n, landmark), text: CONTAINER_WORDS.table.exit[voice], event: 'exit' };
    } else if (n.role === 'caption') {
      // A table's caption is its name, said when the table is entered, not read again as text.
      leaf = true;
    } else if (ENTERED.has(n.role) || (NAMED_GROUPS.has(n.role) && n.name)) {
      if (!say({ ...item(n, landmark), event: 'enter' })) break;
    } else if (n.role === 'statictext') {
      if (n.name) {
        const u = item(n, landmark);
        if (titlesLandmark(n)) u.namesLandmark = true;
        if (!say(u)) break;
      }
      leaf = true;
    } else if (CELL_ROLES.has(n.role) && !onlyText(tree, n)) {
      // A cell with links or controls in it: its content is read item by item.
      leaf = false;
    } else if (NAME_FROM_CONTENT_LEAVES.has(n.role) || n.role === 'iframe') {
      const header = headerOf.get(n.i);
      const inner = innerWords(n);
      const u = item(n, landmark);
      if (inner !== undefined) u.text = speak(voice, { role: n.role, name: inner, ...(n.level !== undefined ? { level: n.level } : {}), states: n.states, ...(n.description ? { description: n.description } : {}) });
      if (header && n.name) u.text = `${header}, ${u.text}`;
      if (unresolvedHeaders.has(n.i)) u.headersUnresolved = true;
      // A frame from another site is not in this tree (its own process): the transcript cannot say what it holds.
      // A same-site frame's tree was read in under it (tree.ts withFrames): it is read in place, after its name.
      if (n.role === 'iframe' && !n.children.length) u.unread = true;
      if (!say(u)) break;
      leaf = !(n.role === 'iframe' && n.children.length);
    }
    if (close) stack.push({ node: n.i, close, landmark: step.landmark });
    if (!leaf) for (let k = n.children.length - 1; k >= 0; k--) stack.push({ node: n.children[k]!, landmark });
  }

  // Elements lists and Tab stops: every node, in reading order, with its innermost landmark.
  const lists: TranscriptLists = { headings: [], landmarks: [], links: [], formControls: [], tables: [] };
  const tabbable: { n: SrNode; landmark: string | undefined }[] = [];
  const landmarkOf: (string | undefined)[] = new Array(nodes.length);
  const push = (list: Utterance[], u: Utterance) => { if (list.length < caps.list) list.push(u); else truncated = true; };
  for (const n of nodes) {
    const parent = n.parent >= 0 ? nodes[n.parent]! : undefined;
    const outer = parent ? (isLandmark(parent) ? parent.role : landmarkOf[parent.i]) : undefined;
    landmarkOf[n.i] = outer;
    if (n.role === 'heading') push(lists.headings, item(n, outer));
    else if (n.role === 'link') push(lists.links, item(n, outer));
    if (isLandmark(n)) {
      const w = LANDMARK_WORDS[n.role]![voice];
      push(lists.landmarks, { ...base(n, outer), states: undefined, text: voice === 'nvda' ? [w, n.name].filter(Boolean).join(', ') : [n.name, w].filter(Boolean).join(', ') });
    }
    if (FORM_CONTROL_ROLES.has(n.role)) push(lists.formControls, item(n, outer));
    if (TABLE_ROLES.has(n.role)) {
      const { rows, cells } = tableShape(tree, n);
      const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
      push(lists.tables, { ...base(n, outer), text: [n.name, fill(CONTAINER_WORDS.table.enter[voice], { rows: rows.length, cols })].filter(Boolean).join(', ') });
    }
    if (n.focusable && n.role !== 'document' && !n.states.includes('disabled') && (n.tabindex === undefined || n.tabindex >= 0)) tabbable.push({ n, landmark: outer });
  }
  // Sequential focus order (HTML): positive tabindex first, ascending, then the rest in tree order.
  const ordered = [
    ...tabbable.filter((t) => (t.n.tabindex ?? 0) > 0).sort((a, b) => a.n.tabindex! - b.n.tabindex! || a.n.i - b.n.i),
    ...tabbable.filter((t) => (t.n.tabindex ?? 0) <= 0),
  ];
  const tabStops = ordered.slice(0, caps.tabStops).map((t) => item(t.n, t.landmark));
  if (ordered.length > caps.tabStops) truncated = true;
  return { readThrough, lists, tabStops, truncated };
}

/** Roles a screen reader treats as a control (re-exported for findings). */
export { CONTROL_ROLES };
