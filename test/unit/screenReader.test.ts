// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The screen-reader pass's pure parts on hand-built CDP trees: hostile shapes Chromium itself never
// sends (a cycle in childIds, a 50,000-deep chain, missing nodes) and the report excerpt's size bound.
// The real-Chromium tests: test/integration/screenReader.test.ts.
import { describe, expect, it } from 'vitest';
import { buildTree, reportData, screenReaderFindings, screenReaderSection, speak, transcribe, type AxNode } from '../../src/probes/screenReader/index.js';
import type { ProbeRun, SrReportData } from '../../src/types.js';

const node = (nodeId: string, role: string, name: string, childIds: string[] = [], extra: Partial<AxNode> = {}): AxNode => ({
  nodeId, role: { type: 'role', value: role }, name: { type: 'computedString', value: name }, childIds, ...extra,
});

describe('frames', () => {
  it('marks a frame whose tree could not be read (no children) as unread, and reads one with children in place', () => {
    const ax = [
      node('1', 'RootWebArea', 'T', ['2', '3']),
      node('2', 'Iframe', 'Rates', [], { parentId: '1' }),
      node('3', 'Iframe', 'Hours', ['4'], { parentId: '1' }),
      node('4', 'RootWebArea', 'Hours', ['5'], { parentId: '3' }),
      node('5', 'StaticText', 'Open 9 to 5', [], { parentId: '4' }),
    ];
    const read = transcribe(buildTree(ax, null), 'nvda').readThrough;
    expect(read.find((u) => u.name === 'Rates')!.unread).toBe(true);
    expect(read.find((u) => u.name === 'Hours' && u.role === 'iframe')!.unread).toBeUndefined();
    expect(read.map((u) => u.text)).toContain('Open 9 to 5');
  });
});

describe('buildTree on hostile trees', () => {
  it('reads each node once when childIds form a cycle', () => {
    const ax = [
      node('1', 'RootWebArea', 'T', ['2']),
      node('2', 'group', 'A', ['3'], { parentId: '1' }),
      node('3', 'group', 'B', ['2', '4'], { parentId: '2' }),
      node('4', 'StaticText', 'inside', [], { parentId: '3' }),
    ];
    const tree = buildTree(ax, null);
    expect(tree.nodes.map((n) => n.name)).toEqual(['T', 'A', 'B', 'inside']);
    expect(transcribe(tree).readThrough.filter((u) => u.name === 'inside')).toHaveLength(1);
  });

  it('walks a 50,000-deep chain without recursion, within the node cap', () => {
    const ax: AxNode[] = [node('0', 'RootWebArea', 'T', ['1'])];
    for (let i = 1; i < 50_000; i++) ax.push(node(String(i), i % 2 ? 'group' : 'generic', i % 2 ? 'g' : '', [String(i + 1)], { parentId: String(i - 1) }));
    ax.push(node('50000', 'button', '', [], { parentId: '49999' }));
    const tree = buildTree(ax, null, { nodes: 20_000, snapshotNodes: 1, name: 200, callMs: 1 });
    expect(tree.nodes).toHaveLength(20_000);
    expect(tree.truncated).toBe(true);
    expect(() => transcribe(tree)).not.toThrow();
    expect(() => screenReaderFindings(tree)).not.toThrow();
  });

  it('skips ids that point nowhere, ignored nodes (their children still read) and inline text boxes', () => {
    const ax = [
      node('1', 'RootWebArea', 'T', ['2', 'missing']),
      node('2', 'none', '', ['3', '5'], { parentId: '1', ignored: true }),
      node('3', 'StaticText', 'Hello', ['4'], { parentId: '2' }),
      node('4', 'InlineTextBox', 'Hello', [], { parentId: '3' }),
      node('5', 'button', 'Go', [], { parentId: '2', properties: [{ name: 'focusable', value: { value: true } }] }),
    ];
    const t = transcribe(buildTree(ax, null));
    expect(t.readThrough.map((u) => [u.role, u.name])).toEqual([['statictext', 'Hello'], ['button', 'Go']]);
    expect(t.tabStops.map((u) => u.name)).toEqual(['Go']);
  });
});

describe('a native disclosure (details and summary)', () => {
  // Chromium's tree gives a summary the role DisclosureTriangle with an expanded property (2026-11-13, real Chromium).
  // NVDA says it as a button with its state, VoiceOver as a disclosure triangle with its state; never as plain text.
  const ax = (expanded: boolean) => [
    node('1', 'RootWebArea', 'T', ['2']),
    node('2', 'navigation', 'Main', ['3'], { parentId: '1' }),
    node('3', 'DisclosureTriangle', 'Customer Service', ['4'], { parentId: '2', properties: [{ name: 'focusable', value: { value: true } }, { name: 'expanded', value: { value: expanded } }] }),
    node('4', 'StaticText', 'Customer Service', [], { parentId: '3' }),
  ];
  it('is heard as one control with its collapsed or expanded state, in both voices', () => {
    for (const [expanded, state] of [[false, 'collapsed'], [true, 'expanded']] as const) {
      const tree = buildTree(ax(expanded), null);
      const nvda = transcribe(tree, 'nvda').readThrough.filter((u) => u.name === 'Customer Service');
      expect(nvda.map((u) => [u.role, u.states])).toEqual([['disclosuretriangle', [state]]]);
      expect(nvda[0]!.text).toBe(`button, Customer Service, ${state}`);
      expect(transcribe(tree, 'voiceover').readThrough.filter((u) => u.name === 'Customer Service')[0]!.text).toBe(`Customer Service, ${state}, disclosure triangle`);
      expect(transcribe(tree, 'nvda').tabStops.map((u) => u.name)).toEqual(['Customer Service']);
    }
  });
});

describe('the announcement rules', () => {
  it('puts the role first for NVDA and the name first for VoiceOver, with states', () => {
    const field = { role: 'textbox', name: 'Email', states: ['invalid', 'required'] };
    expect(speak('nvda', field)).toBe('edit, Email, required, invalid entry');
    expect(speak('voiceover', field)).toBe('Email, required, invalid data, edit text');
    expect(speak('nvda', { role: 'link', name: 'Home', states: ['visited'] })).toBe('visited link, Home');
  });
});

describe('the report excerpt', () => {
  it('stays under its size cap on a page of very long names, and keeps flagged lines past the first ones', () => {
    const long = 'x'.repeat(5_000);
    const ax: AxNode[] = [node('r', 'RootWebArea', 'T', Array.from({ length: 600 }, (_, i) => `n${i}`))];
    for (let i = 0; i < 600; i++) ax.push(node(`n${i}`, i === 500 ? 'button' : 'link', i === 500 ? '' : `${long}${i}`, [], { parentId: 'r', backendDOMNodeId: i + 1 }));
    const facts = new Map(Array.from({ length: 600 }, (_, i) => [i + 1, { path: () => `#n${i}`, attrs: { href: `/p${i}` } }] as const));
    const tree = buildTree(ax, facts);
    const { flags } = screenReaderFindings(tree);
    const data = reportData(transcribe(tree, 'nvda'), flags);
    expect(JSON.stringify(data).length).toBeLessThanOrEqual(20_000);
    expect(data.read.some((l) => l.flag !== undefined && l.n === 500)).toBe(true);
    expect(data.counts.read).toBe(600);
  });
});

describe('"What a screen reader hears" in the report', () => {
  const read = (n: number): SrReportData => ({
    v: 1, voice: 'nvda', truncated: false, read: [{ n: 0, text: `line ${n}` }], flags: [],
    lists: { headings: [], landmarks: [], links: [], formControls: [], tables: [] }, tab: [],
    counts: { read: 1, headings: 0, landmarks: 0, links: 0, formControls: 0, tables: 0, tab: 0 },
  });
  const run = (page: string, probe: string, failed: boolean, data: unknown): ProbeRun => ({
    probe, kind: 'render', page, criteria: ['4.1.2'], status: 'ok', ms: 1, data,
    findings: failed ? [{ criterion: '4.1.2', status: 'failed', detail: 'A button has no name' }] : [],
  });

  it('keeps the start page and the pages with findings, up to the cap, and counts the rest', () => {
    const runs = [
      run('https://e.org/', 'screen-reader', false, read(0)),
      run('https://e.org/a', 'screen-reader', false, read(1)),
      ...['b', 'c', 'd', 'e', 'f', 'g'].map((p, i) => run(`https://e.org/${p}`, 'screen-reader', true, read(i + 2))),
      run('https://e.org/b', 'screen-reader-live', false, { v: 1, voice: 'nvda', lines: [], menus: 0, forms: 0 }),
      run('https://e.org/x', 'screen-reader', true, { not: 'the shape' }),
    ];
    const s = screenReaderSection(runs, 'https://e.org/')!;
    expect(s.pages.map((p) => p.page)).toEqual(['https://e.org/', 'https://e.org/b', 'https://e.org/c', 'https://e.org/d', 'https://e.org/e']);
    expect(s.pages[1]!.live).toBeDefined();
    expect(s.morePages).toBe(2);
    expect(screenReaderSection([run('https://e.org/', 'headings', false, {})], 'https://e.org/')).toBeUndefined();
  });
});
