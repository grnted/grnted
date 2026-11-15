// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the screen-reader pass reports, only where the accessibility tree proves it (WCAG):
// - 4.1.2 a control announced with no name (only its role is spoken);
// - 2.4.4 a link with no name in the links list (also 4.1.2);
// - 1.3.1 a heading with no name in the headings list (ACT ffd0e9; as the headings test files it);
// - 1.3.1 a data table (Chromium's own layout-table heuristics already set layout tables apart) with no
//   header cells (heading levels that skip are a note, never a failure: WCAG requires no order);
// - 1.3.2 reading order against the layout: of two neighbouring text blocks in the same column, the one
//   read second is shown wholly above the one read first. Conservative: positioned (fixed, absolute,
//   sticky) and empty boxes are left out, side-by-side blocks are never compared, and right-to-left
//   pages are compared top to bottom only.
// Duplicate link and heading names are listed as flags (what a links list sounds like), never as
// failures: WCAG lets a link's purpose come from its context (2.4.4) and repeats are not a 2.4.6 failure.
// Pure. Engine core: no Node-only imports.
import type { ProbeFinding } from '../../types.js';
import { CONTROL_ROLES, ROLE_WORDS } from './rules.js';
import { tableShape } from './transcript.js';
import type { SrNode, SrTree } from './tree.js';

/** Findings of one kind kept per page; the last one counts the rest. */
export const SR_PER_KIND = 5;

/** A transcript line the report marks, with why. */
export interface SrFlag {
  /** nodeRef of the line (transcript `nodeRef`). */
  ref: string;
  /** The criterion it fails, or '' for a note that is not a failure (duplicate names). */
  criterion: string;
  note: string;
}

export interface SrFindings {
  findings: ProbeFinding[];
  flags: SrFlag[];
}

const quote = (s: string, max = 80) => `“${s.length > max ? `${s.slice(0, max - 1)}…` : s}”`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const roleWord = (role: string) => ROLE_WORDS[role]?.nvda.replace(/\s*\{level\}/, '') || role;

const BLOCK_ROLES = new Set(['heading', 'paragraph', 'listitem', 'blockquote', 'generic', 'article', 'figure']);
/** Batch 19: roles of a section of its own, whose order beside another section carries no meaning (Understanding 1.3.2). */
const SECTION_ROLES = new Set(['article', 'region', 'complementary', 'navigation', 'main', 'contentinfo', 'banner', 'form', 'search']);

/** Per node: it has visible text under it (one pass; children always come after their parent). */
function textUnder(tree: SrTree): Uint8Array {
  const out = new Uint8Array(tree.nodes.length);
  for (let i = tree.nodes.length - 1; i >= 0; i--) {
    const n = tree.nodes[i]!;
    if (out[i] || (n.role === 'statictext' && /[\p{L}\p{N}]/u.test(n.name))) {
      out[i] = 1;
      if (n.parent >= 0) out[n.parent] = 1;
    }
  }
  return out;
}

function capped(kind: ProbeFinding[], more: (n: number) => string): ProbeFinding[] {
  const shown = kind.slice(0, SR_PER_KIND);
  if (kind.length > shown.length) shown[shown.length - 1] = { ...shown[shown.length - 1]!, detail: `${shown[shown.length - 1]!.detail} (${more(kind.length - shown.length)})` };
  return shown;
}

/** Findings and flags for one page's tree. */
export function screenReaderFindings(tree: SrTree): SrFindings {
  const { nodes } = tree;
  const flags: SrFlag[] = [];
  const flag = (n: SrNode, criterion: string, note: string) => { if (n.ref) flags.push({ ref: n.ref, criterion, note }); };

  // 4.1.2 / 2.4.4: controls with no name.
  const unnamed = nodes.filter((n) => CONTROL_ROLES.has(n.role) && !n.name);
  const nameless: ProbeFinding[] = [];
  const linkless: ProbeFinding[] = [];
  for (const n of unnamed) {
    const word = roleWord(n.role);
    const value = n.value ? ` (its value ${quote(n.value)} is all that follows)` : '';
    // `data.role`: the report matches a nameless control to the axe rule that failed on the same element
    // (report/problems.ts `sameElementRules`), so one defect is one problem.
    nameless.push({ criterion: '4.1.2', status: 'failed', ...(n.ref ? { target: n.ref } : {}), detail: `A ${word} has no name: screen readers announce only “${word}”${value}`, data: { role: n.role } });
    if (n.role === 'link') linkless.push({ criterion: '2.4.4', status: 'failed', ...(n.ref ? { target: n.ref } : {}), detail: 'A link has no name, so the links list shows an empty entry and nothing says where it goes', data: { role: 'link' } });
    flag(n, '4.1.2', `${word} with no name`);
  }

  // 1.3.1: empty headings (an empty entry in the structure; never 2.4.6, which is about what text says): Needs review.
  const headings = nodes.filter((n) => n.role === 'heading');
  const emptyHeadings: ProbeFinding[] = headings.filter((h) => !h.name).map((h) => {
    flag(h, '', 'empty heading (for a person to check)');
    // Batch 19 (the lead's ruling): Needs review, never a failure (ACT ffd0e9 maps to ARIA 1.2 only; axe: best practice).
    return { criterion: '1.3.1', status: 'flagged', ...(h.ref ? { target: h.ref } : {}), detail: `A level-${h.level ?? 2} heading has no name, so the headings list shows an empty entry; whether that hides structure is for a person to check` };
  });

  // Skipped heading levels (downwards by two or more), in the headings list's order: a note, never a
  // failure (WCAG requires no heading order; the headings test lists them as a recommendation).
  for (let k = 1; k < headings.length; k++) {
    const a = headings[k - 1]!;
    const b = headings[k]!;
    if ((b.level ?? 2) - (a.level ?? 2) >= 2) flag(b, '', `heading level ${b.level} after level ${a.level}`);
  }

  // 1.3.1: data tables with no header cells.
  const tables: ProbeFinding[] = [];
  for (const t of nodes.filter((n) => n.role === 'table')) {
    const { rows, cells } = tableShape(tree, t);
    const cols = cells.reduce((m, r) => Math.max(m, r.length), 0);
    if (rows.length < 2 || cols < 2) continue;
    if (cells.some((r) => r.some((c) => c.role === 'columnheader' || c.role === 'rowheader'))) continue;
    flag(t, '1.3.1', 'table with no header cells');
    tables.push({
      criterion: '1.3.1', status: 'failed', ...(t.ref ? { target: t.ref } : {}),
      detail: `A data table (${plural(rows.length, 'row')}, ${plural(cols, 'column')}) has no header cells, so screen readers read each cell with nothing to say which row or column it belongs to`,
    });
  }

  // 1.3.2: neighbouring text blocks in one column, read in the opposite order to how they are shown.
  const order: ProbeFinding[] = [];
  if (tree.layout) {
    const text = textUnder(tree);
    const ok = (n: SrNode) => BLOCK_ROLES.has(n.role) && !!n.box && n.box.w >= 2 && n.box.h >= 2 && !n.outOfFlow && text[n.i] === 1;
    // Inside a picture there is no reading order to set against the layout (batch 17): what is in an image (role
    // "img", an svg, a canvas) is one picture to a screen reader, and the parts of a drawing (the labels along a
    // chart's axis, drawn from the bottom up by every charting library; the captions of a diagram) are placed by
    // their coordinates, not by the flow of a text. A drawing's `foreignObject` holds a document of its own (HTML
    // paragraphs laid out by the flow of their text): the picture stops there, and its order is read as the page's
    // (Sol review of batch 17, S8). (Nodes come parents first.)
    const pictured = new Uint8Array(nodes.length);
    for (const n of nodes) pictured[n.i] = n.graphic || n.role === 'img' || (n.parent >= 0 && pictured[n.parent] && !n.foreign) ? 1 : 0;
    // (The blocks compared are the parent's children that are no picture: the accessibility tree leaves out the
    // wrappers of a foreignObject, so its paragraphs are children of the drawing itself.)
    const words = (n: SrNode) => {
      const stack = [n.i];
      let text = '';
      for (let guard = 0; stack.length && guard < 200 && text.length < 60; guard++) {
        const x = nodes[stack.pop()!]!;
        if (x.role === 'statictext') text += `${x.name} `;
        for (let c = x.children.length - 1; c >= 0; c--) stack.push(x.children[c]!);
      }
      return text.trim();
    };
    /** A section of its own (batch 19): an article, a landmark or region, or a block whose first content is a heading. */
    const independent = (n: SrNode): boolean => {
      if (SECTION_ROLES.has(n.role)) return true;
      for (let x: SrNode | undefined = n, d = 0; x && d < 4; d++) {
        const kids: SrNode[] = x.children.map((c) => nodes[c]!).filter((c) => c.role !== 'statictext' || c.name.trim());
        const firstKid: SrNode | undefined = kids[0];
        if (!firstKid) return false;
        if (firstKid.role === 'heading') return true;
        x = firstKid.role === 'statictext' ? undefined : firstKid;
      }
      return false;
    };
    /** A short line: at most eight words and no sentence's end (a date, a category, a kicker). */
    const shortLine = (n: SrNode): boolean => {
      const t = words(n);
      return !!t && t.split(/\s+/).length <= 8 && !/[.!?]\s*$/.test(t);
    };
    for (const parent of nodes) {
      if (parent.children.length < 2 || parent.outOfFlow) continue;
      const blocks = parent.children.map((c) => nodes[c]!).filter((c) => ok(c) && !pictured[c.i]);
      for (let k = 1; k < blocks.length; k++) {
        const a = blocks[k - 1]!.box!;
        const b = blocks[k]!.box!;
        const overlapX = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
        if (overlapX < 0.5 * Math.min(a.w, b.w)) continue;
        // The one read second sits wholly above the one read first.
        if (b.y + b.h > a.y + 1) continue;
        const first = blocks[k - 1]!;
        const second = blocks[k]!;
        // Batch 19 (precision lane): only a sequence whose order carries meaning fails (SC 1.3.2: "When the sequence ...
        // affects its meaning"). Understanding 1.3.2: "if a page contains two independent articles, the relative order of
        // the articles may not affect their meaning", "unordered lists are not" meaningful sequences, and the order of
        // the main section and a navigation section does not affect their meaning. Items of an unordered list, and
        // two sections that each start with a heading (or are articles or regions), are never compared. A heading
        // and a short line shown over it (a date, a category, a kicker) are listed for a person to check.
        if (parent.unordered || (independent(first) && independent(second))) continue;
        if ((first.role === 'heading' && shortLine(second)) || (second.role === 'heading' && shortLine(first))) {
          flag(second, '', 'shown above the heading read before it (a short line: for a person to check)');
          order.push({
            criterion: '1.3.2', status: 'flagged', ...(second.ref ? { target: second.ref } : {}),
            detail: `Screen readers read ${quote(words(first), 50)} before ${quote(words(second), 50)}, but the page shows it the other way round: a heading and the short line beside it (a date, a category); whether the order changes the meaning is for a person to check`,
          });
          break;
        }
        flag(second, '1.3.2', 'shown above the line read before it');
        order.push({
          criterion: '1.3.2', status: 'failed', ...(second.ref ? { target: second.ref } : {}),
          detail: `Screen readers read ${quote(words(first), 50)} before ${quote(words(second), 50)}, but the page shows ${quote(words(second), 50)} above it: the layout changes the order of the content`,
        });
        break;
      }
    }
  }

  // Duplicate names (flags only).
  const dupes = <T extends SrNode>(list: T[], key: (n: T) => string, note: (n: T, count: number) => string) => {
    const by = new Map<string, T[]>();
    for (const n of list) { const k = n.name.toLowerCase(); if (!k) continue; const g = by.get(k) ?? []; g.push(n); by.set(k, g); }
    for (const g of by.values()) {
      if (g.length < 2 || new Set(g.map(key)).size < 2) continue;
      for (const n of g) flag(n, '', note(n, g.length));
    }
  };
  const dest = (n: SrNode) => (n.url ?? '').replace(/#.*$/, '');
  dupes(nodes.filter((n) => n.role === 'link'), dest, (n, c) => `${c} links named ${quote(n.name, 40)} go to different places`);
  dupes(headings, (n) => String(n.i), (n, c) => `${c} headings named ${quote(n.name, 40)}`);

  const findings = [
    ...capped(nameless, (n) => `${plural(n, 'more control')} with no name on this page`),
    ...capped(linkless, (n) => `${plural(n, 'more link')} with no name on this page`),
    ...capped(emptyHeadings, (n) => `${plural(n, 'more empty heading')} on this page`),
    ...capped(tables, (n) => `${plural(n, 'more table')} like this on this page`),
    ...capped(order, (n) => `${plural(n, 'more place')} like this on this page`),
  ];
  return { findings, flags: flags.slice(0, 200) };
}
