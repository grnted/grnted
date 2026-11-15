// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.1 Use of color for a state the page marks in its code (batch 18, visual lane, D10; docs/atlas/visual.md):
// the current page in a navigation (`aria-current`), the selected tab (`aria-selected`), a pressed toggle
// (`aria-pressed`). The member in the state is compared with its peers, the members of the same group not in it.
// When nothing but colour tells it apart (no underline, border, outline, shadow, weight, style, size, case, picture,
// pseudo-element shape or icon that the peers lack), the colours decide: Understanding 1.4.1 counts a difference in
// lightness of 3:1 or more as a cue of its own, so text or fill colours under 3:1 from the peers' fail. A state shown
// in no visible way at all is not this criterion's (it is not "only by colour"). Read from the page's styles at rest:
// nothing is pressed or pointed at. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

/** States judged per page, at most. */
export const COLOR_STATE_LIMITS = { states: 12, peers: 8 } as const;

/** One state member told apart from its peers by colour alone, as the page reports it. */
export interface ColourOnlyState {
  /** CSS path of the member in the state. */
  path: string;
  /** What the state is, in words: "the current page", "the selected tab", "the pressed button". */
  what: string;
  /** Its text (at most 60 characters). */
  text: string;
  /** Which colour differs: 'text', 'fill' or 'border', with both colours (#rrggbb) and their contrast. */
  by: 'text' | 'fill' | 'border';
  member: string;
  peer: string;
  ratio: number;
}

/**
 * Runs in the page (self-contained). Members in an ARIA state whose only visible difference from their peers is a
 * colour under 3:1 from the peers' (see the file comment). At most `max`.
 */
export function colourOnlyStates(arg: { max: number; peers: number }): ColourOnlyState[] {
  const out: ColourOnlyState[] = [];
  const shown = (e: Element) => {
    const r = e.getBoundingClientRect();
    const cs = getComputedStyle(e);
    return r.width > 1 && r.height > 1 && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.1;
  };
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1 && parts.length < 8; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${CSS.escape(cur.id)}`).length === 1) {
        parts.unshift(`#${CSS.escape(cur.id)}`);
        break;
      }
      const parent: Element | null = cur.parentElement;
      const same = parent ? Array.from(parent.children).filter((c) => c.localName === cur!.localName) : [];
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  // Every CSS colour the browser computes (oklch, lab, color(display-p3 …) included) read as sRGB through a 1x1 canvas;
  // a value the canvas does not take is not decided (null).
  const cvs = document.createElement('canvas');
  cvs.width = 1;
  cvs.height = 1;
  const g2 = cvs.getContext('2d', { willReadFrequently: true });
  const memo = new Map<string, [number, number, number, number] | null>();
  const rgb = (c: string): [number, number, number, number] | null => {
    if (!c || c === 'none' || /url\(|gradient\(/.test(c)) return null;
    const hit = memo.get(c);
    if (hit !== undefined) return hit;
    let v: [number, number, number, number] | null = null;
    if (g2) {
      g2.fillStyle = '#010203';
      g2.fillStyle = c;
      if (g2.fillStyle !== '#010203' || /^#010203$/i.test(c.trim())) {
        g2.clearRect(0, 0, 1, 1);
        g2.fillRect(0, 0, 1, 1);
        const d = g2.getImageData(0, 0, 1, 1).data;
        v = [d[0]!, d[1]!, d[2]!, d[3]! / 255];
      }
    }
    memo.set(c, v);
    return v;
  };
  const lum = (c: [number, number, number, number]) => {
    const f = (v: number) => {
      const s = v / 255;
      return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  };
  const ratio = (a: [number, number, number, number], b: [number, number, number, number]) => {
    const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x) as [number, number];
    return (hi + 0.05) / (lo + 0.05);
  };
  const over = (top: [number, number, number, number], back: [number, number, number, number]): [number, number, number, number] => {
    const a = top[3];
    return [top[0] * a + back[0] * (1 - a), top[1] * a + back[1] * (1 - a), top[2] * a + back[2] * (1 - a), 1];
  };
  /** The opaque colour behind an element (its own fill composited over its ancestors'), from the outermost in. */
  const fillOf = (el: Element): [number, number, number, number] => {
    const chain: Element[] = [];
    for (let e: Element | null = el; e; e = e.parentElement) chain.unshift(e);
    let c: [number, number, number, number] = [255, 255, 255, 1];
    for (const e of chain) {
      const bg = rgb(getComputedStyle(e).backgroundColor);
      if (bg && bg[3] > 0) c = over(bg, c);
    }
    return c;
  };
  const hex = (c: [number, number, number, number]) => `#${c.slice(0, 3).map((v) => Math.round(v).toString(16).padStart(2, '0')).join('')}`;
  const alpha = (c: string) => rgb(c)?.[3] ?? 0;
  const painted = (width: string, style: string, colour: string) => parseFloat(width) > 0 && style !== 'none' && style !== 'hidden' && alpha(colour) > 0.1;
  /** Everything a person sees about the element apart from its colours (a shape, a type style, a picture, an icon). */
  const shape = (el: Element): string => {
    const s = getComputedStyle(el);
    const sides = ['Top', 'Right', 'Bottom', 'Left'].map((side) => {
      const st = s as unknown as Record<string, string>;
      return painted(st[`border${side}Width`]!, st[`border${side}Style`]!, st[`border${side}Color`]!) ? `${st[`border${side}Width`]}${st[`border${side}Style`]}` : '-';
    }).join(',');
    const shadow = s.boxShadow === 'none' ? '' : s.boxShadow.split(/,(?![^(]*\))/).filter((p) => {
      const col = /(rgba?|color)\([^)]*\)/.exec(p);
      return (col ? alpha(col[0]) > 0.1 : true) && /[1-9]/.test(p.replace(/(rgba?|color)\([^)]*\)/g, ''));
    }).map((p) => p.replace(/(rgba?|color)\([^)]*\)/g, '')).join(';');
    const pseudo = ['::before', '::after'].map((p) => {
      const x = getComputedStyle(el, p);
      if (!x.content || x.content === 'none' || x.content === 'normal' || x.display === 'none') return '';
      const fill = alpha(x.backgroundColor) > 0.1 || x.backgroundImage !== 'none';
      return `${x.content}|${fill ? `${x.width}x${x.height}` : ''}|${painted(x.borderBottomWidth, x.borderBottomStyle, x.borderBottomColor)}`;
    }).join('/');
    const deco = s.textDecorationLine !== 'none' && alpha(s.textDecorationColor) > 0.1 ? s.textDecorationLine : '';
    const outline = painted(s.outlineWidth, s.outlineStyle, s.outlineColor) ? `${s.outlineWidth}${s.outlineStyle}` : '';
    const weight = Number(s.fontWeight) >= 600 ? 'bold' : 'normal';
    const icons = el.querySelectorAll('img, svg, [class*="icon" i]').length;
    const bgImage = s.backgroundImage !== 'none' ? 'img' : '';
    // Type styles and decorations inside it count as its look too (Sol r1, finding 3).
    const inner = Array.from(el.querySelectorAll('*')).slice(0, 8).map((d) => {
      const ds = getComputedStyle(d);
      return `${d.localName}:${Number(ds.fontWeight) >= 600 ? 'b' : ''}${ds.fontStyle === 'italic' ? 'i' : ''}${ds.textDecorationLine !== 'none' && alpha(ds.textDecorationColor) > 0.1 ? 'u' : ''}${ds.display === 'none' ? 'h' : ''}`;
    }).join(',');
    return [sides, shadow, pseudo, deco, outline, weight, s.fontStyle, Math.round(parseFloat(s.fontSize)), s.textTransform, s.fontVariantCaps, icons, bgImage, s.letterSpacing, inner].join('|');
  };
  const textOf = (e: Element) => ((e as HTMLElement).innerText ?? e.textContent ?? '').replace(/\s+/g, ' ').trim();
  const groupOf = (el: Element, sel: string): Element[] => {
    let box: Element | null = el.parentElement;
    for (let i = 0; box && i < 4; i++, box = box.parentElement) {
      const peers = Array.from(box.querySelectorAll(sel)).filter((p) => p !== el && !p.contains(el) && !el.contains(p));
      if (peers.length) return peers;
    }
    return [];
  };
  const STATES: { sel: string; peer: (el: Element) => string; what: string; on: (e: Element) => boolean }[] = [
    { sel: '[aria-current]:not([aria-current="false"])', what: 'the current item', on: (e) => !!e.getAttribute('aria-current') && e.getAttribute('aria-current') !== 'false',
      peer: (el) => `${el.localName}:not([aria-current]), ${el.localName}[aria-current="false"]` },
    { sel: '[role="tab"][aria-selected="true"]', what: 'the selected tab', on: (e) => e.getAttribute('aria-selected') === 'true', peer: () => '[role="tab"]:not([aria-selected="true"])' },
    { sel: '[aria-pressed="true"]', what: 'the pressed button', on: (e) => e.getAttribute('aria-pressed') === 'true', peer: () => '[aria-pressed="false"]' },
    { sel: '[role="option"][aria-selected="true"]', what: 'the selected option', on: (e) => e.getAttribute('aria-selected') === 'true', peer: () => '[role="option"]:not([aria-selected="true"])' },
  ];
  // Words that say the state (Sol r1, finding 3): a member whose text holds one its peers do not is told apart in words.
  const STATE_WORDS = /\b(current|selected|active|you are here|pressed|checked|chosen|on)\b/i;
  /** Compares a member with its peers (see the file comment); records it when colour alone tells it apart. */
  const judge = (el: Element, peers: Element[], what: string, text: string): void => {
    if (!peers.length) return;
    const mine = shape(el);
    // Any peer that looks the same as the member apart from colour: compare with that one (the plain peers).
    const plain = peers.filter((p) => shape(p) === mine);
    if (plain.length !== peers.length) return;
    const peer = plain[0]!;
    const ms = getComputedStyle(el);
    const ps = getComputedStyle(peer);
    const mf = fillOf(el);
    const pf = fillOf(peer);
    const mc = rgb(ms.color);
    const pc = rgb(ps.color);
    if (!mc || !pc) return;
    const mt = over(mc, mf);
    const pt = over(pc, pf);
    const fillDiffers = hex(mf) !== hex(pf);
    const textDiffers = hex(mt) !== hex(pt);
    // A border whose colour alone changes (the same width and style: the shape compared above) (Sol r1, F9).
    const mb = rgb(ms.borderBottomColor);
    const pb = rgb(ps.borderBottomColor);
    const bordered = painted(ms.borderBottomWidth, ms.borderBottomStyle, ms.borderBottomColor) && !!mb && !!pb;
    const mbc = bordered ? over(mb!, mf) : mf;
    const pbc = bordered ? over(pb!, pf) : pf;
    const borderDiffers = bordered && hex(mbc) !== hex(pbc);
    if (!fillDiffers && !textDiffers && !borderDiffers) return;
    // A difference in lightness of 3:1 or more is a cue of its own (Understanding 1.4.1).
    const rt = textDiffers ? ratio(mt, pt) : 1;
    const rf = fillDiffers ? ratio(mf, pf) : 1;
    const rb = borderDiffers ? ratio(mbc, pbc) : 1;
    if (rt >= 3 || rf >= 3 || rb >= 3) return;
    const by: 'text' | 'fill' | 'border' = textDiffers && rt >= rf && rt >= rb ? 'text' : fillDiffers && rf >= rb ? 'fill' : 'border';
    type C4 = [number, number, number, number];
    const pick = (t: C4, f: C4, b: C4): C4 => (by === 'text' ? t : by === 'fill' ? f : b);
    out.push({
      path: cssPath(el), what, text: text.slice(0, 60), by,
      member: hex(pick(mt, mf, mbc)), peer: hex(pick(pt, pf, pbc)), ratio: Math.round((by === 'text' ? rt : by === 'fill' ? rf : rb) * 100) / 100,
    });
  };
  for (const st of STATES) {
    for (const el of Array.from(document.querySelectorAll(st.sel))) {
      if (out.length >= arg.max) return out;
      if (!st.on(el) || !shown(el)) continue;
      // An interactive member only (a link, button, tab): the last crumb of a breadcrumb trail, plain text, is a position.
      if (!el.matches('a[href], button, [role="tab"], [role="button"], [role="link"], [role="menuitem"], [role="option"]')) continue;
      const text = textOf(el);
      if (!text || STATE_WORDS.test(text)) continue;
      judge(el, groupOf(el, st.peer(el)).filter((p) => shown(p) && textOf(p)).slice(0, arg.peers), st.what, text);
    }
  }
  // A segmented control (break-it V8): radio buttons hidden from view, each shown by its label; the checked one's label
  // against the other labels of the same group.
  for (const r of Array.from(document.querySelectorAll('input[type="radio"]:checked')) as HTMLInputElement[]) {
    if (out.length >= arg.max) break;
    const rs = getComputedStyle(r);
    const rb = r.getBoundingClientRect();
    const unseen = Number(rs.opacity) <= 0.05 || rb.width <= 2 || rb.height <= 2 || rs.clip === 'rect(0px, 0px, 0px, 0px)' || rs.appearance === 'none' && rb.width < 4;
    if (!unseen || !r.name) continue;
    const label = r.labels?.[0];
    if (!label || !shown(label)) continue;
    const text = textOf(label);
    if (!text || STATE_WORDS.test(text)) continue;
    const group = (r.form ?? document).querySelectorAll(`input[type="radio"][name="${CSS.escape(r.name)}"]`);
    const peers = Array.from(group).filter((x) => x !== r).map((x) => (x as HTMLInputElement).labels?.[0]).filter((l): l is HTMLLabelElement => !!l && shown(l) && !!textOf(l)).slice(0, arg.peers);
    judge(label, peers, 'the chosen option', text);
  }
  // Filter chips (batch 18, round 2): checkboxes hidden from view, each shown by its label; a checked one's label against
  // the unchecked labels of the same name (or the same fieldset).
  const seenGroups = new Set<string>();
  for (const c of Array.from(document.querySelectorAll('input[type="checkbox"]:checked')) as HTMLInputElement[]) {
    if (out.length >= arg.max) break;
    const cs = getComputedStyle(c);
    const cb = c.getBoundingClientRect();
    const unseen = Number(cs.opacity) <= 0.05 || cb.width <= 2 || cb.height <= 2 || cs.clip === 'rect(0px, 0px, 0px, 0px)' || cs.appearance === 'none' && cb.width < 4;
    if (!unseen) continue;
    const label = c.labels?.[0];
    // The group: a fieldset or group, the form, else the box that holds the chips (the label's parent).
    const scope = c.closest('fieldset, [role="group"]') ?? c.form ?? label?.parentElement ?? null;
    const key = c.name ? `n:${c.name}` : scope ? `s:${scope.tagName}:${Array.from(scope.parentElement?.children ?? []).indexOf(scope)}:${scope.querySelectorAll('input[type="checkbox"]').length}` : '';
    if (!key) continue;
    if (!label || !shown(label)) continue;
    const text = textOf(label);
    if (!text || STATE_WORDS.test(text)) continue;
    const members = Array.from((scope ?? document).querySelectorAll(c.name ? `input[type="checkbox"][name="${CSS.escape(c.name)}"]` : 'input[type="checkbox"]')) as HTMLInputElement[];
    const peers = members.filter((x) => !x.checked).map((x) => x.labels?.[0]).filter((l): l is HTMLLabelElement => !!l && shown(l) && !!textOf(l)).slice(0, arg.peers);
    if (!peers.length) continue;
    // One finding per group is enough to show it.
    if (seenGroups.has(key)) continue;
    seenGroups.add(key);
    judge(label, peers, 'a chosen option', text);
  }
  return out;
}

/** The 1.4.1 findings for colour-only states (one per member, at most the limit). */
export function colourStateFindings(list: readonly ColourOnlyState[]): ProbeFinding[] {
  return list.map((s) => ({
    criterion: '1.4.1', status: 'failed' as const, target: s.path,
    detail: `“${s.text}” is shown as ${s.what} only by its ${s.by === 'text' ? 'text colour' : s.by === 'fill' ? 'fill colour' : 'border colour'} (${s.member} against ${s.peer} for the others, ${s.ratio.toFixed(1)}:1): `
      + 'add a cue that is not colour (an underline, a bar, bold text, an icon), or make the colours differ by at least 3:1.',
  }));
}
