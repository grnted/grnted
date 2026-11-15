// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.1.1 for lists the pointer-gestures test measured reordering by dragging (keyboard-op lane, 2026-11-11;
// src/probes/pointerGestures.ts `sortKeyboardFindings`): failed only when nothing gives the keyboard a way.
import { describe, expect, it } from 'vitest';
import { sortKeyboardFindings, type GestureResult, type SortKeys } from '../../src/probes/pointerGestures.js';

const item = (path = '#drag-shelters > li:nth-of-type(1)'): GestureResult['candidate'] => ({ i: 0, kind: 'draggable', path, name: 'Cedar Bend', types: [] });
const sorted = (o: GestureResult['outcomes'][number] = { kind: 'failed', what: 'sort' }): GestureResult => ({ candidate: item(), outcomes: [o] });
const none: SortKeys = { focusable: false, around: '', nearby: [], named: [], setters: [], told: false };
const run = (r: GestureResult, k: SortKeys | null) => sortKeyboardFindings([r], new Map([[r, k]])).map((f) => [f.status, f.target ?? '']);

describe('sortKeyboardFindings', () => {
  it('fails a list reordered by dragging when no item takes focus and nothing else offers the keyboard a way', () => {
    expect(run(sorted(), none)).toEqual([['failed', '#drag-shelters > li:nth-of-type(1)']]);
    // Also when the 2.5.7 rule found a pointer way that is no keyboard way (clicking an item, then another).
    expect(run(sorted({ kind: 'ok', what: 'sort', alternative: 'a click on an item, then on another' }), none)[0]![0]).toBe('failed');
    expect(sortKeyboardFindings([sorted()], new Map([[sorted(), none]]))).toHaveLength(1);
  });

  it('look-alike: items that take focus are the keyboard tests\' to judge: nothing but not applicable here', () => {
    expect(run(sorted(), { ...none, focusable: true })).toEqual([['not_applicable', '']]);
  });

  it('a way that might be there is not testable, never failed: a control near the list, one named for moving, instructions naming a key, another control the pointer test confirmed', () => {
    expect(run(sorted(), { ...none, nearby: ['Save my order'] })[0]![0]).toBe('not_testable');
    expect(run(sorted(), { ...none, named: ['Move up'] })[0]![0]).toBe('not_testable');
    expect(run(sorted(), { ...none, told: true })[0]![0]).toBe('not_testable');
    expect(run(sorted({ kind: 'ok', what: 'sort', alternative: 'Move up (elsewhere on the page, after selecting an item)' }), none)[0]![0]).toBe('not_testable');
    // The list could not be read again.
    expect(run(sorted(), null)[0]![0]).toBe('not_testable');
  });

  it('fix round 1, F1: the 2.5.7 rule\'s own doubt (another control on the page, or controls next to the list it cannot name, may do it) leaves 2.1.1 not testable, never failed', () => {
    const e = sorted({ kind: 'unmeasured', reason: 'elsewhere', detail: 'Rank them with a form instead' });
    expect(run(e, none)).toEqual([['not_testable', '#drag-shelters > li:nth-of-type(1)']]);
    expect(sortKeyboardFindings([e], new Map([[e, none]]))[0]!.detail).toBe('Dragging this item (“Cedar Bend”) reorders its list and none of its items can take keyboard focus, but another control or link on the page (“Rank them with a form instead”) may do it, or lead to what does, and the keyboard may reach it');
    expect(run(sorted({ kind: 'unmeasured', reason: 'elsewhere' }), none)[0]![0]).toBe('not_testable');
    expect(run(sorted({ kind: 'unmeasured', reason: 'unnamed' }), none)[0]![0]).toBe('not_testable');
    // Items that take focus stay the keyboard tests' to judge, whatever the 2.5.7 rule said.
    expect(run(sorted({ kind: 'unmeasured', reason: 'elsewhere' }), { ...none, focusable: true })).toEqual([['not_applicable', '']]);
  });

  it('fix round 1, F1: a way anywhere on the page is a doubt: an element around the list that takes focus, a field that may set the order', () => {
    const clicks = sorted({ kind: 'ok', what: 'sort', alternative: 'a click on an item, then on another' });
    expect(run(clicks, { ...none, around: 'Your ranking' })[0]![0]).toBe('not_testable');
    expect(run(clicks, { ...none, setters: ['First choice'] })[0]![0]).toBe('not_testable');
    expect(run(clicks, { ...none, named: ['Rank them with a form instead'] })[0]![0]).toBe('not_testable');
    expect(sortKeyboardFindings([clicks], new Map([[clicks, { ...none, setters: ['First choice'] }]]))[0]!.detail).toContain('a field on the page (“First choice”) may set the order with the keyboard');
  });

  it('no measured reordering is not applicable: a drag that changed nothing, a refused or unreachable item, a slider or a region', () => {
    for (const o of [{ kind: 'none' }, { kind: 'unmeasured', reason: 'action' }, { kind: 'unmeasured', reason: 'covered' }, { kind: 'unmeasured', reason: 'gone' }, { kind: 'unmeasured', reason: 'stopped' }] as GestureResult['outcomes']) {
      expect(sortKeyboardFindings([sorted(o)], new Map())).toEqual([{ criterion: '2.1.1', status: 'not_applicable', detail: 'no list was measured reordering by dragging' }]);
    }
    const slider: GestureResult = { candidate: { ...item('#thumb'), kind: 'slider' }, outcomes: [{ kind: 'failed', what: 'slider' }] };
    expect(sortKeyboardFindings([slider], new Map([[slider, none]]))[0]!.status).toBe('not_applicable');
  });
});
