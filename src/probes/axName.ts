// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The accessible name the browser itself computes for an element (Chromium's accessibility tree through CDP):
// aria-labelledby, aria-label, a label, the content, a title, as the accessible name computation orders them.
// A name the engine works out by itself is never proof of anything (an earlier ruling: our own name code leaked a
// new edge case every round). Engine core: no Node-only imports.
import type { ProbeContext } from './types.js';

type AxNode = { ignored?: boolean; name?: { value?: unknown } };

/**
 * The accessible name of the element the page expression evaluates to (an expression over `window`, such as
 * `window.__key[2]`), or undefined when it cannot be read: no CDP session, no such element, a node the
 * accessibility tree ignores, an answer with no name in it, or no answer within `ms`. Never throws.
 */
export async function axNameOf(ctx: ProbeContext, expression: string, ms = 1500): Promise<string | undefined> {
  const cdp = await ctx.cdp?.().catch(() => undefined);
  if (!cdp) return undefined;
  const work = (async (): Promise<string | undefined> => {
    const ev = (await cdp.send('Runtime.evaluate', { expression, returnByValue: false })) as { result?: { objectId?: string } };
    const objectId = ev?.result?.objectId;
    if (!objectId) return undefined;
    try {
      const ax = (await cdp.send('Accessibility.getPartialAXTree', { objectId, fetchRelatives: false })) as { nodes?: AxNode[] };
      const node = ax?.nodes?.[0];
      if (!node || node.ignored || !node.name) return undefined;
      const v = node.name.value;
      return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : undefined;
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => undefined), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}

type AxValue = { value?: unknown };
type AxContentNode = { ignored?: boolean; role?: AxValue; name?: AxValue; value?: AxValue; description?: AxValue; properties?: { name?: string; value?: AxValue }[] };

/** Limits of `axContentOf`: accessibility nodes read, and characters of content kept. */
export const AX_CONTENT_LIMITS = { nodes: 600, chars: 4000 } as const;

/**
 * What assistive technology is given in the subtree of the element the page expression evaluates to, as Chromium's
 * accessibility tree has it (CDP `Accessibility.queryAXTree`, every node of the subtree): the names, values and
 * descriptions of the nodes it does not ignore (text, an image's text alternative, an aria-label, the content of open
 * shadow roots and generated content all included; what is aria-hidden, inert or not rendered left out), then their
 * roles and states (focus left out: the test moves it). `text`: the content, spaces collapsed; `all`: the content and
 * the roles and states. `cut` when the subtree has more than `AX_CONTENT_LIMITS` holds. Undefined when it cannot be
 * read (no CDP session, no such element, an answer that is not a list of nodes, no answer within `ms`). Never throws.
 */
export async function axContentOf(ctx: ProbeContext, expression: string, ms = 1500): Promise<{ text: string; all: string; cut: boolean } | undefined> {
  const cdp = await ctx.cdp?.().catch(() => undefined);
  if (!cdp) return undefined;
  const str = (v: AxValue | undefined): string => (typeof v?.value === 'string' || typeof v?.value === 'number' || typeof v?.value === 'boolean' ? String(v.value) : '').replace(/\s+/g, ' ').trim();
  const work = (async (): Promise<{ text: string; all: string; cut: boolean } | undefined> => {
    const ev = (await cdp.send('Runtime.evaluate', { expression, returnByValue: false })) as { result?: { objectId?: string } };
    const objectId = ev?.result?.objectId;
    if (!objectId) return undefined;
    try {
      const ax = (await cdp.send('Accessibility.queryAXTree', { objectId })) as { nodes?: AxContentNode[] };
      if (!Array.isArray(ax?.nodes)) return undefined;
      const shown = ax.nodes.filter((n) => !n.ignored);
      let cut = shown.length > AX_CONTENT_LIMITS.nodes;
      const text: string[] = [];
      const states: string[] = [];
      for (const n of shown.slice(0, AX_CONTENT_LIMITS.nodes)) {
        for (const v of [str(n.name), str(n.value), str(n.description)]) if (v) text.push(v);
        const props = (n.properties ?? []).filter((p) => p.name && p.name !== 'focused' && p.name !== 'focusable').map((p) => `${p.name}=${str(p.value)}`);
        states.push(`${str(n.role)}${props.length ? `[${props.join(',')}]` : ''}`);
      }
      let joined = text.join(' ');
      if (joined.length > AX_CONTENT_LIMITS.chars) { cut = true; joined = joined.slice(0, AX_CONTENT_LIMITS.chars); }
      return { text: joined, all: `${joined}\n${states.join(' ')}`, cut };
    } finally {
      await cdp.send('Runtime.releaseObject', { objectId }).catch(() => {});
    }
  })();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work.catch(() => undefined), new Promise<undefined>((r) => { timer = setTimeout(() => r(undefined), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
  }
}
