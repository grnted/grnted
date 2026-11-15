// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The accessibility tree a screen reader reads, from Chromium over CDP: `Accessibility.getFullAXTree`
// (the tree Chrome exposes to NVDA, JAWS and VoiceOver) joined with `DOMSnapshot.captureSnapshot`
// (element paths and layout boxes, by backend node id). Two CDP calls per page, each time-boxed; the
// tree is walked without recursion, with a node cap and a visited set (so a cyclic aria-owns or a
// 50,000-node page cannot hang or blow the stack). Engine core: no Node-only imports.
import type { CDPSessionLike } from '../../types.js';
import { CHROMIUM_ROLE, LANDMARK_WORDS, SKIP_SUBTREE } from './rules.js';

const LANDMARK_ROLES: ReadonlySet<string> = new Set(Object.keys(LANDMARK_WORDS));

export const SR_TREE_LIMITS = {
  /**
   * Elements in the page beyond which the tree is not read at all (checked in the page first): CDP sends
   * the whole tree and snapshot in one message each, and on the hosted checker that message must fit in
   * the Worker's memory.
   */
  elements: 8_000,
  /** Accessibility nodes kept (in reading order); a larger page is read up to here and marked truncated. */
  nodes: 20_000,
  /** DOM snapshot nodes beyond which element paths and boxes are left out (the tree is still read). */
  snapshotNodes: 150_000,
  /** Accessible names longer than this are cut (characters). */
  name: 200,
  /** Each CDP call's time limit (ms), also bounded by the probe's deadline. */
  callMs: 8_000,
} as const;

export type SrLimits = { elements?: number; nodes: number; snapshotNodes: number; name: number; callMs: number };

export interface Box { x: number; y: number; w: number; h: number }

/** One node of the tree as the simulated reader sees it (ignored nodes and inline text boxes left out). */
export interface SrNode {
  /** Index in `SrTree.nodes` (reading order: depth-first, document order). */
  i: number;
  /** Normalized ARIA role (rules.ts `CHROMIUM_ROLE`): 'statictext', 'img', 'layouttable', … */
  role: string;
  /** Accessible name, whitespace collapsed ('' when none). */
  name: string;
  /** Value of a field or the selected option of a select. */
  value?: string;
  /** Accessible description (aria-describedby, title), spoken after the name. */
  description?: string;
  level?: number;
  /** FORMAT.md state vocabulary, sorted. */
  states: string[];
  /** Index of the parent kept node, -1 for the root. */
  parent: number;
  children: number[];
  /** Chromium says it can take focus (also tabindex="-1"). */
  focusable: boolean;
  /** The element's tabindex attribute, when it has one. */
  tabindex?: number;
  /** aria-live politeness of the node itself ('polite', 'assertive'), from role or attribute. */
  live?: string;
  /** CSS path (FORMAT.md `nodeRef`); absent when the snapshot was skipped or the node has no element. */
  ref?: string;
  /** Layout box in CSS px, document coordinates. */
  box?: Box;
  /** The element's computed `position` is fixed, absolute or sticky. */
  outOfFlow?: boolean;
  /** The element is part of a drawing (an `svg` element or inside one): placed by its coordinates, not by the flow of the text. */
  graphic?: boolean;
  /**
   * The element is inside a drawing's `foreignObject` (with no svg of its own between): HTML laid out by the flow of its
   * text, a document of its own, so nothing of the drawing around it makes it a picture (Sol review of batch 17, S8).
   */
  foreign?: boolean;
  /** Link target (links only). */
  url?: string;
  /**
   * The element's id (table cells and headers; for text, the id of the element the text is in), and, for cells,
   * the ids its `headers` attribute names (HTML table model).
   */
  domId?: string;
  headers?: string[];
  /** Landmarks: the ids their `aria-labelledby` names (a visible title that names the landmark). */
  labelledBy?: string[];
  /** Lists (batch 19): the element is an unordered list (`ul`, `menu`): Understanding 1.3.2, "unordered lists are not" meaningful sequences. */
  unordered?: true;
  /** Text: the ids of the element it is in and of that element's next two ancestors. */
  ownerIds?: string[];
}

export interface SrTree {
  nodes: SrNode[];
  /** A cap stopped the read (nodes, snapshot, or a time limit on the snapshot). */
  truncated: boolean;
  /** The page's document direction is right-to-left. */
  rtl: boolean;
  /** Element paths and boxes are present. */
  layout: boolean;
}

// ---------------------------------------------------------------------------------------------
// CDP shapes (the parts used).

export interface AxValue { type?: string; value?: unknown }
export interface AxProperty { name: string; value?: AxValue }
export interface AxNode {
  nodeId: string;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: AxProperty[];
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
}

export interface DomSnapshot {
  documents: {
    nodes: {
      parentIndex?: number[];
      nodeType?: number[];
      nodeName?: number[];
      backendNodeId?: number[];
      attributes?: number[][];
      shadowRootType?: { index: number[]; value: number[] };
    };
    layout: { nodeIndex: number[]; bounds: number[][]; styles?: number[][] };
  }[];
  strings: string[];
}

/** Element facts from the snapshot, by backend node id. */
export interface ElementFacts { path(): string; box?: Box; attrs: Record<string, string>; /** The element's tag name (lower case; elements only). */ tag?: string; outOfFlow?: boolean; /** An `svg` element, or inside one (not inside its `foreignObject`). */ graphic?: boolean; /** Inside a drawing's `foreignObject`, with no svg of its own between: a document of its own, read in its order. */ foreign?: boolean; /** Text nodes: the ids of their element and its next two ancestors (those that have one). */ ownerIds?: string[] }

const clean = (s: unknown, max: number): string => {
  const t = typeof s === 'string' ? s.replace(/[​-‍﻿]/g, '').replace(/\s+/g, ' ').trim() : '';
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

const prop = (n: AxNode, name: string): unknown => n.properties?.find((p) => p.name === name)?.value?.value;

/** FORMAT.md states from Chromium's properties (and the element's own aria-current). */
export function statesOf(n: AxNode, role: string, attrs: Record<string, string> = {}): string[] {
  const s = new Set<string>();
  const on = (v: unknown) => v === true || v === 'true';
  if (on(prop(n, 'required'))) s.add('required');
  const invalid = prop(n, 'invalid');
  if (invalid !== undefined && invalid !== 'false' && invalid !== false) s.add('invalid');
  const expanded = prop(n, 'expanded');
  // A select's popup is always "collapsed" in Chromium; NVDA and VO only say it for disclosure controls.
  if (expanded !== undefined && role !== 'combobox') s.add(on(expanded) ? 'expanded' : 'collapsed');
  else if (expanded !== undefined && attrs['aria-expanded'] !== undefined) s.add(on(expanded) ? 'expanded' : 'collapsed');
  const checked = prop(n, 'checked');
  if (checked !== undefined) s.add(checked === 'mixed' ? 'mixed' : on(checked) ? 'checked' : 'unchecked');
  const pressed = prop(n, 'pressed');
  if (on(pressed)) s.add('pressed');
  if (on(prop(n, 'selected')) && /^(tab|option|treeitem|gridcell|row)$/.test(role)) s.add('selected');
  if (on(prop(n, 'readonly')) && /^(textbox|searchbox|combobox|spinbutton|grid)$/.test(role)) s.add('readonly');
  if (on(prop(n, 'disabled'))) s.add('disabled');
  if (on(prop(n, 'visited'))) s.add('visited');
  const current = attrs['aria-current'];
  if (current !== undefined && current !== 'false' && current !== '') s.add('current');
  return [...s].sort();
}

/** Chromium's role for a node, normalized (rules.ts). */
export function roleOf(n: AxNode): string {
  const r = typeof n.role?.value === 'string' ? n.role.value : 'unknown';
  return CHROMIUM_ROLE[r] ?? r.toLowerCase();
}

const LIVE_ROLES: Readonly<Record<string, string>> = { status: 'polite', log: 'polite', alert: 'assertive', timer: 'off', marquee: 'off' };

/**
 * The kept nodes in reading order (depth-first from the root, following `childIds`, which already
 * include aria-owns re-parenting). Ignored nodes are transparent (their children are read), inline
 * text boxes and a closed select's popup are dropped. Pure; never recurses; each node is visited once.
 */
export function buildTree(ax: readonly AxNode[], facts: ReadonlyMap<number, ElementFacts> | null, limits: SrLimits = SR_TREE_LIMITS, rtl = false): SrTree {
  const byId = new Map<string, AxNode>();
  for (const n of ax) if (n && typeof n.nodeId === 'string' && !byId.has(n.nodeId)) byId.set(n.nodeId, n);
  const root = ax.find((n) => n && !n.parentId && byId.get(n.nodeId) === n) ?? ax[0];
  const nodes: SrNode[] = [];
  let truncated = false;
  if (!root) return { nodes, truncated, rtl, layout: !!facts };
  const seen = new Set<string>();
  // Stack of [ax id, parent kept index].
  const stack: [string, number][] = [[root.nodeId, -1]];
  while (stack.length) {
    const [id, parent] = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const n = byId.get(id);
    if (!n) continue;
    const role = roleOf(n);
    if (SKIP_SUBTREE.has(role)) continue;
    let here = parent;
    if (!n.ignored) {
      if (nodes.length >= limits.nodes) { truncated = true; break; }
      const f = n.backendDOMNodeId !== undefined ? facts?.get(n.backendDOMNodeId) : undefined;
      const attrs = f?.attrs ?? {};
      const node: SrNode = {
        i: nodes.length, role, name: clean(n.name?.value, limits.name), states: statesOf(n, role, attrs), parent, children: [],
        focusable: prop(n, 'focusable') === true,
      };
      const level = Number(prop(n, 'level'));
      if (role === 'heading' && Number.isFinite(level) && level > 0) node.level = level;
      const value = clean(n.value?.value, limits.name);
      if (value) node.value = value;
      const description = clean(n.description?.value, limits.name);
      if (description && description !== node.name) node.description = description;
      const ti = attrs.tabindex !== undefined ? Number.parseInt(attrs.tabindex, 10) : NaN;
      if (Number.isFinite(ti)) node.tabindex = ti;
      const live = prop(n, 'live');
      const liveValue = typeof live === 'string' && live !== 'off' ? live : LIVE_ROLES[role];
      if (liveValue && liveValue !== 'off') node.live = liveValue;
      if (f) {
        node.ref = f.path();
        if (f.box) node.box = f.box;
        if (f.outOfFlow) node.outOfFlow = true;
        if (f.graphic) node.graphic = true;
        if (f.foreign) node.foreign = true;
      }
      if (role === 'statictext' && f?.ownerIds?.length) node.ownerIds = f.ownerIds;
      if (role === 'list' && (f?.tag === 'ul' || f?.tag === 'menu')) node.unordered = true;
      const named = (attrs['aria-labelledby'] ?? '').split(/\s+/).filter(Boolean).slice(0, 10);
      if (named.length && LANDMARK_ROLES.has(role)) node.labelledBy = named;
      if (/^(cell|gridcell|columnheader|rowheader)$/.test(role)) {
        if (attrs.id) node.domId = attrs.id;
        const headers = (attrs.headers ?? '').split(/\s+/).filter(Boolean).slice(0, 20);
        if (headers.length) node.headers = headers;
      }
      if (role === 'link') {
        const url = prop(n, 'url') ?? attrs.href;
        if (typeof url === 'string' && url) node.url = url.slice(0, 300);
      }
      if (parent >= 0) nodes[parent]!.children.push(node.i);
      nodes.push(node);
      here = node.i;
    }
    const kids = n.childIds ?? [];
    for (let k = kids.length - 1; k >= 0; k--) {
      const kid = kids[k]!;
      if (!seen.has(kid)) stack.push([kid, here]);
    }
  }
  return { nodes, truncated, rtl, layout: !!facts };
}

/**
 * Element paths, boxes and attributes from a DOM snapshot, keyed by backend node id: the main
 * document only, CSS paths in the engine's usual form (a unique id, else `tag:nth-of-type(n)` steps;
 * ' >>> ' into shadow roots). Null when the snapshot is larger than `maxNodes`. Pure.
 */
export function snapshotFacts(snap: DomSnapshot, maxNodes: number): Map<number, ElementFacts> | null {
  const doc = snap.documents?.[0];
  if (!doc) return null;
  const s = snap.strings ?? [];
  const parents = doc.nodes.parentIndex ?? [];
  const n = parents.length;
  if (n > maxNodes) return null;
  const types = doc.nodes.nodeType ?? [];
  const names = doc.nodes.nodeName ?? [];
  const ids = doc.nodes.backendNodeId ?? [];
  const attrsRaw = doc.nodes.attributes ?? [];
  const shadow = new Set(doc.nodes.shadowRootType?.index ?? []);
  const tag = (i: number) => (s[names[i] ?? -1] ?? '').toLowerCase();
  const attrs = (i: number): Record<string, string> => {
    const a = attrsRaw[i] ?? [];
    const out: Record<string, string> = {};
    for (let k = 0; k + 1 < a.length; k += 2) out[s[a[k]!] ?? ''] = s[a[k + 1]!] ?? '';
    return out;
  };
  // Children per node (elements only), and ids per tree scope for the unique-id shortcut.
  const kids: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) { const p = parents[i] ?? -1; if (p >= 0 && p < n && types[i] === 1) kids[p]!.push(i); }
  const scopeOf = new Int32Array(n).fill(-1);
  for (let i = 0; i < n; i++) {
    const p = parents[i] ?? -1;
    // Parents come before children in a snapshot; guard anyway.
    scopeOf[i] = types[i] === 11 && shadow.has(i) ? i : p >= 0 && p < i ? scopeOf[p]! : -1;
  }
  const idCount = new Map<string, number>();
  const attrCache = new Map<number, Record<string, string>>();
  const attrsOf = (i: number) => { let a = attrCache.get(i); if (!a) { a = attrs(i); attrCache.set(i, a); } return a; };
  for (let i = 0; i < n; i++) {
    if (types[i] !== 1) continue;
    const id = attrsOf(i).id;
    if (id) idCount.set(`${scopeOf[i]}|${id}`, (idCount.get(`${scopeOf[i]}|${id}`) ?? 0) + 1);
  }
  const esc = (x: string) => x.replace(/[^\w-]/g, (c) => `\\${c}`).replace(/^(\d)/, '\\3$1 ');
  const pathCache = new Map<number, string>();
  const pathOf = (i: number): string => {
    const cached = pathCache.get(i);
    if (cached !== undefined) return cached;
    const parts: string[] = [];
    let cur = i;
    let host = -1;
    for (let guard = 0; cur >= 0 && guard < 2000; guard++) {
      if (types[cur] === 11) { host = parents[cur] ?? -1; break; }
      if (types[cur] !== 1) { cur = parents[cur] ?? -1; continue; }
      const id = attrsOf(cur).id;
      if (id && idCount.get(`${scopeOf[cur]}|${id}`) === 1) { parts.unshift(`#${esc(id)}`); break; }
      const p = parents[cur] ?? -1;
      const t = tag(cur);
      if (p < 0 || types[p] !== 1) { parts.unshift(esc(t)); if (p >= 0 && types[p] === 11) host = parents[p] ?? -1; break; }
      const same = kids[p]!.filter((k) => tag(k) === t);
      parts.unshift(same.length > 1 ? `${esc(t)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(t));
      cur = p;
    }
    const own = parts.join(' > ');
    const out = host >= 0 ? `${pathOf(host)} >>> ${own}` : own;
    pathCache.set(i, out);
    return out;
  };
  // Part of a drawing: an svg element, or inside one (parents come before children in a snapshot). A drawing stops at
  // its `foreignObject`: what that holds is a document of its own (HTML paragraphs, lists, forms laid out by the flow
  // of their text), exposed as such, and its reading order is the page's (Sol review of batch 17, S8). `foreign`: in
  // such a document, with no svg of its own between (a picture inside it is a picture again).
  const drawn = new Uint8Array(n);
  const foreign = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const p = parents[i] ?? -1;
    const up = p >= 0 && p < i;
    const own = types[i] === 1 && tag(i) === 'svg';
    const boundary = up && types[p] === 1 && tag(p) === 'foreignobject' && drawn[p] === 1;
    drawn[i] = own || (up && drawn[p] && !boundary) ? 1 : 0;
    foreign[i] = !own && up && (boundary || (foreign[p] === 1 && !drawn[i])) ? 1 : 0;
  }
  const boxes = new Map<number, { box: Box; outOfFlow: boolean }>();
  const li = doc.layout?.nodeIndex ?? [];
  const posIdx = 0;
  for (let k = 0; k < li.length; k++) {
    const b = doc.layout.bounds[k];
    const i = li[k]!;
    if (!b || boxes.has(i)) continue;
    const pos = s[doc.layout.styles?.[k]?.[posIdx] ?? -1] ?? '';
    boxes.set(i, { box: { x: b[0] ?? 0, y: b[1] ?? 0, w: b[2] ?? 0, h: b[3] ?? 0 }, outOfFlow: pos === 'fixed' || pos === 'absolute' || pos === 'sticky' });
  }
  const out = new Map<number, ElementFacts>();
  const none: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    const id = ids[i];
    if (id === undefined) continue;
    if (types[i] === 3) {
      // A text node: its element's path (screen readers read text as part of its element).
      const p = parents[i] ?? -1;
      if (p >= 0 && types[p] === 1) {
        out.set(id, {
          path: () => pathOf(p), attrs: none, ...(drawn[p] ? { graphic: true } : {}), ...(foreign[p] ? { foreign: true } : {}),
          get ownerIds() {
            const found: string[] = [];
            for (let e = p, k = 0; e >= 0 && k < 3 && types[e] === 1; e = parents[e] ?? -1, k++) { const v = attrsOf(e).id; if (v) found.push(v); }
            return found;
          },
        });
      }
      continue;
    }
    if (types[i] !== 1) continue;
    const b = boxes.get(i);
    // Attributes and paths are built on demand (most elements never need one).
    out.set(id, { path: () => pathOf(i), get attrs() { return attrsOf(i); }, get tag() { return tag(i); }, ...(b ? { box: b.box, outOfFlow: b.outOfFlow } : {}), ...(drawn[i] ? { graphic: true } : {}), ...(foreign[i] ? { foreign: true } : {}) });
  }
  return out;
}

/** Races a promise against a time limit; resolves `undefined` on time-out (the call is abandoned). */
export function within<T>(p: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), Math.max(0, ms)); });
  return Promise.race([p.catch(() => undefined), limit]).finally(() => clearTimeout(timer));
}

/** Same-site frames read into the page's tree: how many, and how deep. */
export const FRAME_LIMITS = { frames: 5, depth: 2 } as const;

interface FrameTreeNode { frame?: { id?: string; securityOrigin?: string; url?: string }; childFrames?: FrameTreeNode[] }

/** The page's AX nodes with the trees of its same-site frames grafted under their <iframe> nodes (ids prefixed). */
async function withFrames(cdp: CDPSessionLike, main: AxNode[], left: () => number): Promise<AxNode[]> {
  if (left() <= 0) return main;
  const tree = (await within(cdp.send('Page.getFrameTree', {}), left())) as { frameTree?: FrameTreeNode } | undefined;
  const frames: { id: string; depth: number }[] = [];
  // Same origin as the page only: a frame from another site (an embedded player, map or form) is another site's
  // content, judged by axe as third-party content (scoring v8), never by the listener as the page's own.
  const origin = tree?.frameTree?.frame?.securityOrigin;
  const queue: { n: FrameTreeNode; depth: number }[] = (tree?.frameTree?.childFrames ?? []).map((n) => ({ n, depth: 1 }));
  while (queue.length && frames.length < FRAME_LIMITS.frames) {
    const { n, depth } = queue.shift()!;
    // A srcdoc or about:blank frame inherits its parent's origin (CDP reports it as its own opaque one).
    const inherits = /^about:(srcdoc|blank)$/.test(n.frame?.url ?? '');
    if (!inherits && n.frame?.securityOrigin !== origin) continue;
    if (n.frame?.id) frames.push({ id: n.frame.id, depth });
    if (depth < FRAME_LIMITS.depth) for (const c of n.childFrames ?? []) queue.push({ n: c, depth: depth + 1 });
  }
  if (!frames.length) return main;
  const all = [...main];
  const byBackend = new Map<number, AxNode>();
  for (const n of all) if (n.backendDOMNodeId !== undefined && !byBackend.has(n.backendDOMNodeId)) byBackend.set(n.backendDOMNodeId, n);
  let k = 0;
  for (const f of frames) {
    if (left() <= 0) break;
    const sub = (await within(cdp.send('Accessibility.getFullAXTree', { frameId: f.id }), left())) as { nodes?: AxNode[] } | undefined;
    if (!sub?.nodes?.length) continue;
    const owner = (await within(cdp.send('DOM.getFrameOwner', { frameId: f.id }), left())) as { backendNodeId?: number } | undefined;
    const iframe = owner?.backendNodeId !== undefined ? byBackend.get(owner.backendNodeId) : undefined;
    if (!iframe) continue;
    const pre = `f${k++}:`;
    const ids = new Set(sub.nodes.map((n) => n.nodeId));
    const root = sub.nodes.find((n) => !n.parentId || !ids.has(n.parentId));
    if (!root) continue;
    for (const n of sub.nodes) {
      const copy: AxNode = { ...n, nodeId: pre + n.nodeId, ...(n.childIds ? { childIds: n.childIds.map((c) => pre + c) } : {}) };
      if (n === root) copy.parentId = iframe.nodeId;
      else if (n.parentId) copy.parentId = pre + n.parentId;
      all.push(copy);
      if (copy.backendDOMNodeId !== undefined && !byBackend.has(copy.backendDOMNodeId)) byBackend.set(copy.backendDOMNodeId, copy);
    }
    iframe.childIds = [...(iframe.childIds ?? []), pre + root.nodeId];
  }
  return all;
}

/**
 * Reads the main frame's accessibility tree and DOM snapshot over CDP, each call time-boxed (and never
 * past `deadline`). Null when the tree could not be read in time. Leaves Chromium's accessibility mode
 * off again afterwards (best effort, bounded).
 */
export async function readTree(cdp: CDPSessionLike, deadline: number, limits: SrLimits = SR_TREE_LIMITS): Promise<SrTree | null> {
  const left = () => Math.min(limits.callMs, deadline - Date.now() - 200);
  try {
    if (left() <= 0) return null;
    const axRes = (await within(cdp.send('Accessibility.getFullAXTree', {}), left())) as { nodes?: AxNode[] } | undefined;
    if (!axRes?.nodes) return null;
    // Frames of the page's own origin are documents of their own: Chromium's tree of the page stops at the <iframe>.
    // A screen reader reads them in place, so their trees are read too (at most FRAME_LIMITS.frames, each time-boxed)
    // and put under their <iframe>. A frame from another origin is not read: its <iframe> stays without children and
    // the transcript marks it unread.
    const nodes = await withFrames(cdp, axRes.nodes, left);
    let facts: Map<number, ElementFacts> | null = null;
    let rtl = false;
    if (left() > 0) {
      const snap = (await within(cdp.send('DOMSnapshot.captureSnapshot', { computedStyles: ['position', 'direction'] }), left())) as DomSnapshot | undefined;
      if (snap) {
        facts = snapshotFacts(snap, limits.snapshotNodes);
        const doc = snap.documents?.[0];
        // The root element's direction (2nd computed style of the first laid-out element).
        const dir = doc?.layout?.styles?.[0]?.[1];
        rtl = dir !== undefined && snap.strings?.[dir] === 'rtl';
      }
    }
    return buildTree(nodes, facts, limits, rtl);
  } finally {
    await within(cdp.send('Accessibility.disable', {}), 1_000);
  }
}
