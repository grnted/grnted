// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Tabular data shown as a table with no header relationships a screen reader can use (WCAG 1.3.1), read from
// the DOM at the desktop width by the headings test, on every page that loaded:
// - a two-column data table that marks no cell as a header although it shows its first row as one (bold cells
//   over rows that are not bold): F91, headers not associated with their data cells (wider tables with no
//   header cell are axe's `td-has-header`, which does not apply under three columns);
// - a data table made presentational (role presentation or none) although its own markup says it holds data
//   (a caption, header cells, a thead, scope or headers attributes): F92;
// - rows and columns of plain text laid out with CSS only (rows of boxes, or one CSS grid), again with a bold
//   first row over rows that are not bold, and no table markup or roles at all.
// Header cells that label no data cell are `tableHeaders.ts`; tables with header cells are axe's rules.
// A bold first row only makes a table or a grid a candidate; it is data only with proof of header relationships
// (review round 1, ruling 5): the first row's cells are short labels, there are two rows of values or more under
// them, each column's values are alike in kind, and at least one column is of a kind a label never is (times,
// dates, money, numbers, percentages, phone numbers, e-mail addresses, yes and no). Header cells the page's own
// markup declares (th) need no such column, only labels over columns alike in kind. Labels over columns of no
// one kind are undecided (`not_testable`); a bold first row of sentences (three notices over six more) is no
// header row at all. Every cell is plain text (a cell that holds blocks, pictures or form fields makes it a
// layout) and every row has the same number of cells. A bold first column (a label column) and a table with no
// bold row are never judged. Reads only. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

export const TABLES_SHOWN_LIMITS = {
  /** Tables and CSS grids read per page. */
  tables: 200,
  grids: 400,
  /** Cells read per table or grid; a larger one is not judged. */
  cells: 600,
  /** Longest text of a header cell, and of any cell. */
  headerChars: 60,
  cellChars: 160,
  /** Findings kept per page. */
  kept: 20,
} as const;

/** Findings listed per page; the last one counts the rest. */
const PER_PAGE = 5;

export interface ShownTable {
  kind: 'no-headers' | 'presentational' | 'grid';
  /** 'data': header relationships proven (a failure). 'labels': short labels over columns of no one kind (undecided). */
  proof: 'data' | 'labels';
  /** CSS path (parts joined by ' >>> ' across shadow roots). */
  target: string;
  rows: number;
  cols: number;
  /** The texts of its header row (at most 4, 40 characters each); for a presentational table with a caption, the caption. */
  headers: string[];
  caption?: string;
}

export interface ShownTablesRead {
  tables: ShownTable[];
  truncated: boolean;
}

/** Runs in the page (self-contained). */
export function readShownTables(limits: { tables: number; grids: number; cells: number; headerChars: number; cellChars: number; kept: number }): ShownTablesRead {
  const words = (t: string | null | undefined) => (t ?? '').replace(/\s+/g, ' ').trim();
  const clip = (t: string, n = 40) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = (root as ShadowRoot).host;
    return host ? `${cssPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const styleOf = (el: Element) => (el.ownerDocument.defaultView ?? window).getComputedStyle(el);
  const roleOf = (el: Element) => (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0] ?? '';
  const shownEl = (el: Element): boolean => {
    for (let a: Element | null = el; a; a = a.parentElement) if (a.getAttribute('aria-hidden') === 'true' || a.hasAttribute('inert')) return false;
    const c = el as Element & { checkVisibility?: (o: object) => boolean };
    if (typeof c.checkVisibility === 'function' && !c.checkVisibility({ visibilityProperty: true, opacityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2;
  };
  /** Weight of the text a cell shows: its first text's own element. */
  const bold = (el: Element): boolean => {
    const w = (el.ownerDocument ?? document).createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let holder: Element = el;
    for (let n = w.nextNode(); n; n = w.nextNode()) if ((n.nodeValue ?? '').trim()) { holder = n.parentElement ?? el; break; }
    const fw = styleOf(holder).fontWeight;
    const n = Number.parseInt(fw, 10);
    return (Number.isFinite(n) ? n : fw === 'bold' ? 700 : 400) >= 600;
  };
  /** A cell of plain text: nothing in it but text and inline formatting (links allowed in table cells only). */
  const BLOCKS = 'p, div, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, img, picture, svg, video, audio, iframe, input, select, textarea, button, form, section, article, figure, blockquote, pre, hr';
  const CONTROLS = 'a, button, summary, label, [role], [tabindex], [onclick]';
  const plain = (el: Element, links: boolean): boolean => (links ? !el.querySelector(BLOCKS) : !el.matches(CONTROLS) && !el.querySelector(`${BLOCKS}, ${CONTROLS}`));
  /** What kind of value a cell holds: a typed one (a label never is), 'short' text, 'long' text, or nothing. */
  const TIME = String.raw`(?:\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)|\d{1,2}:\d{2}|noon|midnight)`;
  const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
  const DAY = '(?:mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\\.?';
  const DATE1 = `(?:${DAY},?\\s+)?(?:${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?|\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTH}(?:\\s+\\d{4})?|\\d{1,2}[/.-]\\d{1,2}(?:[/.-]\\d{2,4})?|\\d{4}-\\d{2}-\\d{2}|${MONTH}\\s+\\d{4})`;
  const RE = {
    empty: /^(?:[-–—]+|n\/?a|none|tbd|tba)$/i,
    money: /^(?:[$€£¥]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|million|billion))?|\d[\d,]*(?:\.\d+)?\s?(?:usd|dollars?|euros?|cents?|[$€£¥]))(?:\s?(?:\/|per|a|each)\s?[a-z]+)?$/i,
    percent: /^[+-]?\d[\d,]*(?:\.\d+)?\s?%$/,
    time: new RegExp(`^${TIME}(?:\\s?(?:[-–—]|to|until)\\s?${TIME})?$`, 'i'),
    // One date; a day or a span of days of the week; and (batch 17) a span of dates as schedules write them:
    // "November 18–20", "Nov 3 to Nov 5", "11/18–11/20", "June 30 – July 2, 2026".
    date: new RegExp(`^${DATE1}$|^${DAY}(?:\\s?(?:[-–—]|to|and|&)\\s?${DAY})?$|^${DATE1}\\s?(?:[-–—]|to|through|thru|until)\\s?(?:${DATE1}|\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?)$`, 'i'),
    number: /^[+-]?\d[\d,]*(?:\.\d+)?$/,
    measure: /^[+-]?\d[\d,.]*\s?[a-zµ°²³"']{1,8}\.?$/i,
    phone: /^\+?[\d\s().-]{7,20}$/,
    email: /^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i,
    yesno: /^(?:yes|no|y|n|true|false|✓|✔|✗|✘|sí|si)$/i,
  };
  const kindOf = (text: string): string => {
    const t = text.trim();
    if (!t || RE.empty.test(t)) return 'empty';
    if (RE.money.test(t)) return 'money';
    if (RE.percent.test(t)) return 'percent';
    if (RE.time.test(t)) return 'time';
    if (RE.date.test(t)) return 'date';
    if (RE.number.test(t)) return 'number';
    if (RE.phone.test(t) && (t.match(/\d/g) ?? []).length >= 7) return 'phone';
    if (RE.measure.test(t)) return 'measure';
    if (RE.email.test(t)) return 'email';
    if (RE.yesno.test(t)) return 'yesno';
    return t.split(/\s+/).length <= 6 && t.length <= 60 && !/[.!?](?:\s|$)/.test(t) ? 'short' : 'long';
  };
  /**
   * A header row over rows of values (review round 1, ruling 5). The candidate: every cell of the first row
   * is short text with a letter (and bold, unless the page's own markup declares it a header: `declared`); in the
   * rows under it, at most one cell in five outside the first column is bold; every cell is plain and not too
   * long. The proof: the first row's cells are labels (four words at most, no sentence or colon in them, all
   * different, text and not values), there are two rows of values or more, and each column's values are alike in
   * kind: all of one typed kind (one in five may be a short word such as "Closed"), or all short text. 'data'
   * when at least one column is typed, or the headers are declared; 'labels' when the columns are of no one kind
   * or there is no typed column (undecided); null when the first row is no row of labels at all.
   */
  const headerRow = (rows: Element[][], links: boolean, declared = false): { heads: string[]; proof: 'data' | 'labels' } | null => {
    const first = rows[0]!;
    const heads: string[] = [];
    for (const c of first) {
      const t = words(c.textContent);
      if (!t || t.length > limits.headerChars || !/\p{L}/u.test(t) || !plain(c, links) || !(declared || bold(c))) return null;
      heads.push(t);
    }
    let body = 0;
    let boldBody = 0;
    let filled = 0;
    let all = 0;
    for (const row of rows.slice(1)) {
      row.forEach((c, i) => {
        all++;
        const t = words(c.textContent);
        if (t) filled++;
        if (i > 0 && t) { body++; if (bold(c)) boldBody++; }
      });
      for (const c of row) if (!plain(c, links) || words(c.textContent).length > limits.cellChars) return null;
    }
    if (!body || boldBody > body * 0.2 || filled < all * 0.8) return null;
    // Labels: short, no sentence and no "Urgent: …" in them, all different, and text (a value is no label).
    const labels = heads.every((h) => h.split(/\s+/).length <= 4 && h.length <= 32 && !/[.!?:;]/.test(h.replace(/[.:]$/, '')) && !/^(?:money|percent|time|phone|email|yesno|measure)$/.test(kindOf(h)));
    const distinct = new Set(heads.map((h) => h.toLowerCase())).size === heads.length;
    if (!labels || !distinct || !heads.some((h) => kindOf(h) === 'short')) return null;
    const shown = heads.slice(0, 4).map((h) => clip(h));
    if (rows.length < 3) return { heads: shown, proof: 'labels' };
    let typed = 0;
    let alike = true;
    for (let k = 0; k < first.length && alike; k++) {
      const kinds = rows.slice(1).map((r) => kindOf(words(r[k]?.textContent))).filter((x) => x !== 'empty');
      if (kinds.includes('long')) { alike = false; break; }
      const counts = new Map<string, number>();
      for (const x of kinds) counts.set(x, (counts.get(x) ?? 0) + 1);
      const best = [...counts.entries()].filter(([x]) => x !== 'short').sort((a, b) => b[1] - a[1])[0];
      if (!best) continue; // all short text: alike, and proves nothing
      const others = kinds.length - best[1];
      // One typed kind, with at most one value in five a short word ("Closed", "Free"); and not the header's own kind.
      if (best[1] >= 2 && others <= kinds.length * 0.2 && [...counts.keys()].every((x) => x === best[0] || x === 'short') && kindOf(heads[k]!) !== best[0]) typed++;
      else alike = false;
    }
    return { heads: shown, proof: alike && (typed > 0 || declared) ? 'data' : 'labels' };
  };

  const out: ShownTable[] = [];
  let truncated = false;
  const push = (t: ShownTable) => { if (out.length >= limits.kept) truncated = true; else out.push(t); };
  const GLOBAL_ARIA = ['aria-label', 'aria-labelledby', 'aria-describedby', 'aria-details', 'aria-owns', 'aria-controls', 'aria-live'];

  // Tables.
  const tables = document.querySelectorAll('table');
  for (let i = 0; i < tables.length; i++) {
    if (i >= limits.tables) { truncated = true; break; }
    const table = tables[i]!;
    if (table.querySelector('table') || table.parentElement?.closest('table') || !shownEl(table)) continue;
    const role = roleOf(table);
    const presentational = (role === 'presentation' || role === 'none') && !GLOBAL_ARIA.some((a) => table.hasAttribute(a)) && !table.hasAttribute('tabindex');
    if (role && !presentational && role !== 'table' && role !== 'grid') continue;
    const trs = Array.from(table.querySelectorAll('tr')).filter((tr) => tr.closest('table') === table && shownEl(tr));
    const rows = trs.map((tr) => Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.localName)));
    const cells = rows.reduce((n, r) => n + r.length, 0);
    if (rows.length < 2 || cells > limits.cells) continue;
    const cols = rows[0]!.length;
    const even = cols >= 2 && rows.every((r) => r.length === cols) && !table.querySelector('[colspan]:not([colspan="1"]), [rowspan]:not([rowspan="1"])');
    const caption = words(table.querySelector(':scope > caption')?.textContent);
    const marked = !!table.querySelector('th, thead, [scope], [headers], [role="columnheader"], [role="rowheader"]');
    if (presentational) {
      // A table of one column, or of headers over a single row of values, reads the same in order: nothing is lost.
      if (!even || cols < 2 || rows.length < 3) continue;
      // Its own markup declares the first row its headers (th cells): labels over columns alike in kind are data.
      // Else (a caption, or nothing) the first row must show as headers, with the proof a plain table needs.
      const declared = rows[0]!.every((c) => c.localName === 'th') && rows.slice(1).some((r) => r.some((c) => c.localName === 'td' && words(c.textContent)));
      const heads = declared ? headerRow(rows, true, true) : (caption || cols >= 3) ? headerRow(rows, true) : null;
      if (heads) push({ kind: 'presentational', proof: heads.proof, target: cssPath(table), rows: rows.length, cols, headers: heads.heads, ...(caption ? { caption: clip(caption, 80) } : {}) });
      continue;
    }
    if (marked || !even || rows.length < 3) continue;
    // A table of three columns and three rows or more with no header cell is axe's `td-has-header` (it fails it):
    // judged here are the narrower tables that rule does not apply to.
    if (cols >= 3) continue;
    const heads = headerRow(rows, true);
    if (heads) push({ kind: 'no-headers', proof: heads.proof, target: cssPath(table), rows: rows.length, cols, headers: heads.heads, ...(caption ? { caption: clip(caption, 80) } : {}) });
  }

  // Rows and columns laid out with CSS only: a box of row boxes, or one CSS grid.
  const NOT_IN = 'table, ul, ol, dl, nav, header, footer, form, select, [role="table"], [role="grid"], [role="treegrid"], [role="row"], [role="list"], [role="listbox"], [role="menu"], [role="menubar"], [role="tablist"], [role="navigation"], [aria-hidden="true"]';
  const boxes = document.querySelectorAll('div, section, article');
  const taken: Element[] = [];
  let read = 0;
  for (let i = 0; i < boxes.length && out.length < limits.kept; i++) {
    const box = boxes[i]!;
    const kids = Array.from(box.children);
    if (kids.length < 3 || kids.length > limits.cells || box.hasAttribute('role')) continue;
    if (taken.some((t) => t.contains(box))) continue;
    const display = styleOf(box).display;
    let rows: Element[][] | null = null;
    if (display === 'grid' || display === 'inline-grid') {
      // One CSS grid: its children are the cells, in rows by their position.
      if (kids.length < 6 || kids.some((k) => k.children.length > 3)) continue;
      if (++read > limits.grids) { truncated = true; break; }
      const byTop = new Map<number, Element[]>();
      for (const k of kids) {
        const r = k.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) { byTop.clear(); break; }
        const top = Math.round(r.top);
        const key = [...byTop.keys()].find((t) => Math.abs(t - top) <= 2) ?? top;
        byTop.set(key, [...(byTop.get(key) ?? []), k]);
      }
      const list = [...byTop.entries()].sort((a, b) => a[0] - b[0]).map(([, r]) => r.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left));
      if (list.length >= 3) rows = list;
    } else if (kids.every((k) => k.children.length >= 2 && k.children.length === kids[0]!.children.length && !k.hasAttribute('role'))) {
      // A box of row boxes with the same number of cells each, the cells of a row side by side.
      if (++read > limits.grids) { truncated = true; break; }
      const list = kids.map((k) => Array.from(k.children));
      const side = list.every((r) => { const a = r[0]!.getBoundingClientRect(); const b = r[1]!.getBoundingClientRect(); return a.width > 0 && Math.abs(a.top - b.top) <= 2 && b.left >= a.right - 1; });
      if (side) rows = list;
    }
    if (!rows) continue;
    const cols = rows[0]!.length;
    // Columns line up: every row has the same cells at the same left edges.
    if (!rows.every((r) => r.length === cols) || !(cols >= 3 || (cols === 2 && rows.length >= 4))) continue;
    const lefts = rows[0]!.map((c) => c.getBoundingClientRect().left);
    if (!rows.every((r) => r.every((c, k) => Math.abs(c.getBoundingClientRect().left - lefts[k]!) <= 2))) continue;
    if (box.closest(NOT_IN) || box.querySelector('[role], table, ul, ol, li') || !shownEl(box)) continue;
    const heads = headerRow(rows, false);
    if (!heads) continue;
    taken.push(box);
    push({ kind: 'grid', proof: heads.proof, target: cssPath(box), rows: rows.length, cols, headers: heads.heads });
  }
  return { tables: out, truncated };
}

const quoteAll = (list: readonly string[]) => list.map((h) => `“${h}”`).join(', ');

/** One page's findings from what `readShownTables` reported: proven data tables fail; labels over columns of no one kind are undecided. */
export function shownTableFindings(read: ShownTablesRead): ProbeFinding[] {
  const proven = read.tables.filter((t) => t.proof === 'data');
  const shown = proven.slice(0, PER_PAGE);
  const out: ProbeFinding[] = shown.map((t, i) => {
    const more = i === shown.length - 1 && proven.length > shown.length ? ` (${proven.length - shown.length} more like this on this page)` : '';
    const detail = t.kind === 'presentational'
      ? `A data table${t.caption ? ` (“${t.caption}”)` : ''} with the column headers ${quoteAll(t.headers)} is marked role="presentation", which takes its rows, columns and headers away from screen readers, so its values are read with nothing to say which column they belong to`
      : t.kind === 'no-headers'
        ? `A data table${t.caption ? ` (“${t.caption}”)` : ''} shows its first row as headers (${quoteAll(t.headers)}, in bold) but marks no cell as a header, so screen readers read its values with nothing to say which column they belong to`
        : `Rows and columns of text with a header row (${quoteAll(t.headers)}, in bold) are laid out with CSS only, with no table markup, so screen readers read the values with nothing to say which row or column they belong to`;
    return { criterion: '1.3.1', status: 'failed', target: t.target, detail: `${detail}${more}` };
  });
  const maybe = read.tables.filter((t) => t.proof === 'labels');
  maybe.slice(0, PER_PAGE).forEach((t, i, list) => {
    const more = i === list.length - 1 && maybe.length > list.length ? ` (${maybe.length - list.length} more like this on this page)` : '';
    out.push({
      criterion: '1.3.1', status: 'not_testable', target: t.target,
      detail: `rows and columns of text under a first row of short labels (${quoteAll(t.headers)}) may be a data table with no header cells, or labelled notes that need none: the values under the labels are of no one kind, so this could not be told${more}`,
    });
  });
  return out;
}
