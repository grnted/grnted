// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.3.1: a table header cell that is the header of no data cell (2026-11-09 benchmark review). A column header
// over a column with no cells (a row cut short), or one every cell below names away with `headers`, says nothing
// about any cell: the table's structure is not what it looks like. axe leaves these undecided (th-has-data-cells
// needs review) and does not look at ARIA tables. Read by the headings probe (render, 1.3.1). Engine core: no
// Node-only imports.
import type { ProbeFinding } from '../types.js';

/** A header cell that labels no data cell. */
export interface LoneHeader {
  /** CSS path of the header cell. */
  target: string;
  /** Its text (at most 60 characters). */
  text: string;
  /** The row, column, or group the header labels. */
  axis: 'column' | 'row' | 'column group' | 'row group';
  /** ARIA row headers label every cell in their row, independent of order. */
  aria?: true;
}

export interface TableHeadersRead {
  headers: LoneHeader[];
  unread: { target?: string; reason: string }[];
}

export const TABLE_HEADER_LIMITS = { tables: 50, cells: 2000, findings: 5 } as const;

/**
 * Runs in the page (self-contained). Tables are native `<table>` elements (not role presentation or none) and ARIA
 * tables (role table, grid or treegrid on other elements; rows by role row, cells by role cell, gridcell,
 * columnheader or rowheader). The grid is built with row and column spans (HTML's table model). A header cell's
 * axis: a column header for `scope="col"` or role columnheader, a row header for `scope="row"` or role rowheader; a
 * `<th>` with no scope is a column header when its row has no data cells and a row header when its column has none
 * (HTML's "auto" state); one that is neither is left alone. Group scope applies to the remaining cells in its
 * tbody/thead/tfoot or colgroup, not just its own row or column. Its data cells: the cells on its axis (below it, or to
 * its right) without a `headers` attribute, and every cell whose `headers` names it. It is reported only when it
 * has none and its axis has no other header cells either (the label over a column of row headers, or a corner cell,
 * is not a failure), in a table with at least one data cell, when it is shown and not hidden from assistive
 * technology, with text. Tables with ARIA row spans, or beyond the reading limits, are explicitly undecided.
 */
export function readLoneHeaders(arg: { tables: number; cells: number; findings: number }): TableHeadersRead {
  type Cell = { el: Element; header: boolean; scope: string; r: number; c: number; rs: number; cs: number };
  const out: LoneHeader[] = [];
  const unread: TableHeadersRead['unread'] = [];
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const shown = (el: Element) => {
    if (el.closest('[aria-hidden="true"]')) return false;
    const r = el.getBoundingClientRect();
    const v = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true;
    return v && r.width >= 1 && r.height >= 1;
  };
  const path = (el: Element): string => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const parts: string[] = [];
    for (let e: Element | null = el; e && e !== document.documentElement; e = e.parentElement) {
      if (e.id && document.querySelectorAll(`#${CSS.escape(e.id)}`).length === 1) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const tag = e.localName;
      const same = e.parentElement ? [...e.parentElement.children].filter((x) => x.localName === tag) : [];
      parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(e) + 1})` : tag);
    }
    return parts.join(' > ');
  };
  const roleOf = (el: Element) => clean(el.getAttribute('role')).toLowerCase().split(' ')[0] ?? '';

  /** The cells of one table, placed in its grid; null when the table is not read (too big, ARIA row spans). */
  const native = (t: HTMLTableElement): Cell[] | null => {
    const cells: Cell[] = [];
    const taken = new Set<string>();
    const rows = [...t.rows].filter((r) => r.closest('table') === t);
    for (let r = 0; r < rows.length; r++) {
      let c = 0;
      for (const cell of [...rows[r]!.cells]) {
        while (taken.has(`${r},${c}`)) c++;
        const cs = Math.max(1, Math.min(1000, cell.colSpan || 1));
        const span = cell.rowSpan;
        const rs = span === 0 ? rows.length - r : Math.max(1, Math.min(rows.length - r, span || 1));
        const role = roleOf(cell);
        const header = role === 'columnheader' || role === 'rowheader' || (cell.localName === 'th' && role !== 'cell' && role !== 'gridcell');
        const scope = role === 'columnheader' ? 'col' : role === 'rowheader' ? 'row' : clean(cell.getAttribute('scope')).toLowerCase();
        cells.push({ el: cell, header, scope, r, c, rs, cs });
        if (cells.length > arg.cells) return null;
        for (let y = r; y < r + rs; y++) for (let x = c; x < c + cs; x++) taken.add(`${y},${x}`);
        c += cs;
      }
    }
    return cells;
  };
  const aria = (t: Element): Cell[] | null => {
    if (t.querySelector('[aria-rowspan]')) return null;
    const rows = [...t.querySelectorAll('[role="row"]')].filter((r) => r.closest('table, [role="table"], [role="grid"], [role="treegrid"]') === t);
    const cells: Cell[] = [];
    rows.forEach((row, r) => {
      let c = 0;
      for (const cell of row.querySelectorAll('[role="cell"], [role="gridcell"], [role="columnheader"], [role="rowheader"]')) {
        if (cell.closest('[role="row"]') !== row) continue;
        const at = Number(cell.getAttribute('aria-colindex'));
        if (Number.isInteger(at) && at > 0) c = at - 1;
        const cs = Math.max(1, Number(cell.getAttribute('aria-colspan')) || 1);
        const role = roleOf(cell);
        cells.push({ el: cell, header: role === 'columnheader' || role === 'rowheader', scope: role === 'columnheader' ? 'col' : role === 'rowheader' ? 'row' : '', r, c, rs: 1, cs });
        c += cs;
      }
    });
    return cells.length > arg.cells ? null : cells;
  };

  const tables = [...document.querySelectorAll('table, [role="table"], [role="grid"], [role="treegrid"]')]
    .filter((t) => !['presentation', 'none'].includes(roleOf(t)) && shown(t));
  if (tables.length > arg.tables) unread.push({ reason: 'The table header check could not read all tables on this page' });
  for (const t of tables.slice(0, arg.tables)) {
    if (out.length >= arg.findings) break;
    const role = roleOf(t);
    if (role === 'presentation' || role === 'none' || !shown(t)) continue;
    const isNative = t instanceof HTMLTableElement && (!role || role === 'table' || role === 'grid' || role === 'treegrid');
    const cells = isNative ? native(t as HTMLTableElement) : aria(t);
    if (!cells) {
      unread.push({ target: path(t), reason: !isNative && t.querySelector('[aria-rowspan]')
        ? 'The table header check cannot assign cells with ARIA row spans'
        : 'The table header check could not read all cells in this table' });
      continue;
    }
    if (!cells.some((x) => !x.header) && !cells.some((x) => roleOf(x.el) === 'rowheader')) continue;
    const columnGroups: { start: number; end: number }[] = [];
    let column = 0;
    for (const group of t.children) {
      if (!(group instanceof HTMLTableColElement) || group.localName !== 'colgroup') continue;
      const cols = [...group.children].filter((c): c is HTMLTableColElement => c instanceof HTMLTableColElement && c.localName === 'col');
      const width = cols.length ? cols.reduce((sum, c) => sum + c.span, 0) : group.span;
      columnGroups.push({ start: column, end: column + width });
      column += width;
    }
    const inRows = (x: Cell, r0: number, r1: number) => x.r < r1 && x.r + x.rs > r0;
    const inCols = (x: Cell, c0: number, c1: number) => x.c < c1 && x.c + x.cs > c0;
    for (const h of cells) {
      if (out.length >= arg.findings) break;
      if (!h.header || !shown(h.el) || !clean(h.el.textContent)) continue;
      const rowCells = cells.filter((x) => x !== h && inRows(x, h.r, h.r + h.rs));
      if (roleOf(h.el) === 'rowheader') {
        if (!rowCells.some((x) => !x.header)) out.push({ target: path(h.el), text: clean(h.el.textContent).slice(0, 60), axis: 'row', aria: true });
        continue;
      }
      const colCells = cells.filter((x) => x !== h && inCols(x, h.c, h.c + h.cs));
      const axis: LoneHeader['axis'] | null = h.scope === 'col' ? 'column' : h.scope === 'row' ? 'row'
        : h.scope === 'colgroup' ? 'column group' : h.scope === 'rowgroup' ? 'row group'
        : !rowCells.some((x) => !x.header) ? 'column' : !colCells.some((x) => !x.header) ? 'row' : null;
      if (!axis) continue;
      let along: Cell[];
      if (axis === 'row group' || axis === 'column group') {
        const rowGroup = h.el.closest('thead, tbody, tfoot');
        const colGroup = columnGroups.find((g) => h.c >= g.start && h.c < g.end);
        if (axis === 'row group' ? !rowGroup : !colGroup) continue;
        // HTML's header-assignment algorithm includes a group header when both its coordinates precede
        // the data cell's last slot, and both cells are anchored in the same row or column group.
        along = cells.filter((x) => x !== h && h.r < x.r + x.rs && h.c < x.c + x.cs
          && (axis === 'row group' ? x.el.closest('thead, tbody, tfoot') === rowGroup : x.c >= colGroup!.start && x.c < colGroup!.end));
      } else {
        along = axis === 'column' ? colCells.filter((x) => x.r >= h.r + h.rs) : rowCells.filter((x) => x.c >= h.c + h.cs);
      }
      // The label over a column of row headers (or a row of column headers): its axis has header cells only.
      if (along.some((x) => x.header) && !along.some((x) => !x.header)) continue;
      const id = h.el.id;
      const named = id ? cells.some((x) => !x.header && clean(x.el.getAttribute('headers')).split(' ').includes(id)) : false;
      const implicit = along.some((x) => !x.header && !x.el.hasAttribute('headers'));
      if (named || implicit) continue;
      out.push({ target: path(h.el), text: clean(h.el.textContent).slice(0, 60), axis });
    }
  }
  return { headers: out, unread };
}

/** 1.3.1 findings for the header cells that label no data cell. */
export function loneHeaderFindings(read: TableHeadersRead): ProbeFinding[] {
  return [...read.headers.map((h): ProbeFinding => ({
    criterion: '1.3.1',
    status: 'failed',
    target: h.target,
    detail: `The table ${h.axis} header “${h.text}” is the header of no data cell: no cell ${h.axis === 'column' ? 'below it in its column' : h.axis === 'row' ? (h.aria ? 'in its row' : 'to its right in its row') : `in its ${h.axis}`} is under it, and no cell names it with headers=, so the table's structure does not say what it heads`,
  })), ...read.unread.map((u): ProbeFinding => ({
    criterion: '1.3.1', status: 'not_testable', ...(u.target ? { target: u.target } : {}), detail: u.reason,
  }))];
}
