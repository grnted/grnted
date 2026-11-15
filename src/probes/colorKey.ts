// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.1 Use of color: a colour key whose items carry only the colour. "Color is not used as the only visual
// means of conveying information, indicating an action, prompting a response, or distinguishing a visual
// element." The test fires only where the page itself says that a colour carries a meaning: a sentence that
// names colours ("Green means open. Red means closed.", "Boxes labelled in red are required") or a row of
// swatches with a word each. It then looks, next to that key, for the items that carry those colours: same-shaped
// dots, items whose text has the colour, or shaded items among plain ones. Each is judged as the complete item it
// belongs to (its list item, table row, term with its description, label with its field and hint, or the element
// with the words beside it in its block): it fails only when nothing in that item says the status in words (a word
// of the key, the page's own status words, words set off beside the coloured name, a status column), and there is
// no symbol, hover title, graphic, shape or type style of its own (failure F81 for required fields; the missing
// techniques G14 and G182). One item with a cue leaves the whole key alone.
// English keys only. Read from the page's styles at rest: nothing is moved or clicked.
// Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';

export const COLOR_KEY_LIMITS = {
  /** Keys judged per page, in page order. */
  keys: 4,
  /** A key is short: its block holds at most this many characters. */
  keyText: 300,
  /** Blocks looked at around a key: before it and after it (a heading ends the look). */
  before: 3,
  after: 8,
  /** A key that names one colour only: the blocks after it that are looked at (one before it). */
  near: 2,
  /** Elements read around one key, and text nodes read on the page for keys. */
  scope: 1500,
  nodes: 6000,
  /** A swatch (dot) is this many CSS px on each side. */
  dotMin: 5,
  dotMax: 40,
  /** Items quoted in the finding. */
  samples: 3,
} as const;

export type ColorKeyLimits = { readonly [K in keyof typeof COLOR_KEY_LIMITS]: number };

/** A colour key whose items carry only the colour, as the page reports it. */
export interface ColorKeyHit {
  /** CSS path of the first item that carries only the colour. */
  target: string;
  /** The key as the page words it (max 200); for a key of swatches, the words beside them. */
  legend: string;
  /** 'words': a sentence that names the colours; 'swatches': coloured swatches with a word each. */
  form: 'words' | 'swatches';
  /** The swatches' words (swatch keys). */
  labels: string[];
  /** Colours of the key the items carry. */
  colours: string[];
  /** Items that carry only a colour. */
  count: number;
  /** Text of up to `samples` of them. */
  samples: string[];
  /** The coloured items share one block of text: whether each has its meaning in words beside it could not be told. */
  undecided?: true;
}

/**
 * Runs in the page (self-contained). The colour keys on the page whose items carry only the colour (see the
 * file comment for the rules).
 */
export function findColorKeys(arg: { limits: ColorKeyLimits }): ColorKeyHit[] {
  const L = arg.limits;
  const NAMES = ['red', 'green', 'blue', 'yellow', 'amber', 'orange', 'purple'];
  // The hues a key's colour word accepts.
  const ACCEPTS: Record<string, string[]> = { red: ['red'], green: ['green'], blue: ['blue'], yellow: ['yellow'], amber: ['yellow', 'orange'], orange: ['orange'], purple: ['purple'] };
  const COLOR = '(red|green|blue|yellow|amber|orange|purple)';
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      const name = esc(cur.localName);
      if (!parent) { parts.unshift(name); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${name}:nth-of-type(${same.indexOf(cur) + 1})` : name);
    }
    return parts.join(' > ');
  };
  const shown = (el: Element) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  // Text only a screen reader gets (clipped to nothing) is not a visual cue.
  const unseen = (el: Element) => {
    const r = el.getBoundingClientRect();
    if (r.width <= 2 || r.height <= 2) return true;
    const st = getComputedStyle(el);
    return st.clipPath === 'inset(50%)' || /rect\(0(px)?[, ]+0(px)?[, ]+0(px)?[, ]+0(px)?\)/.test(st.clip) || Number(st.opacity) === 0;
  };
  const seenText = (el: Element): string => {
    let out = '';
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const parent = node.parentElement;
      if (!parent || !/\S/.test(node.nodeValue ?? '') || !shown(parent) || unseen(parent)) continue;
      out += `${node.nodeValue} `;
    }
    return clean(out);
  };
  /** The hue of a solid, saturated colour by name; null for greys, near-black, near-white and see-through colours. */
  const hue = (v: string): string | null => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/.exec(v);
    if (!m) return null;
    if (m[4] !== undefined && Number(m[4]) < 0.5) return null;
    const r = Number(m[1]) / 255, g = Number(m[2]) / 255, b = Number(m[3]) / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min, l = (max + min) / 2;
    if (d < 0.1 || l < 0.1 || l > 0.93) return null;
    if (d / (1 - Math.abs(2 * l - 1)) < 0.25) return null;
    const h = ((max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60 + 360) % 360;
    if (h < 18 || h >= 340) return 'red';
    if (h < 40) return 'orange';
    if (h < 68) return 'yellow';
    if (h >= 80 && h < 170) return 'green';
    if (h >= 195 && h < 250) return 'blue';
    if (h >= 262 && h < 310) return 'purple';
    return null;
  };

  // --- What a key says: the words of each colour's meaning, cut to their first letters.
  const STOP = new Set(('a an the to be is are was were and or of for in on at by with this that these those it its must should need needs will can may has have been not no as mean means '
    + 'you your we our they them their there here now still currently temporarily today so if when which who than then only also very all any each every from into out up down over under again more most some such own same too just').split(' '));
  const stems = (s: string): string[] => {
    const out: string[] = [];
    for (const word of s.toLowerCase().match(/\p{L}{3,}/gu) ?? []) {
      if (STOP.has(word) || NAMES.includes(word)) continue;
      out.push(word.length > 5 ? word.slice(0, 5) : word);
    }
    return out;
  };
  const SAYS = /^\S+((?:\s+[\p{L}-]+){0,2}?)\s+(?:means?|indicates?|shows?|marks?|denotes?|signals?|signif(?:y|ies))\s+(?:that\s+)?(.+)$/iu;
  const IS = /^\S+((?:\s+[\p{L}-]+){0,2}?)\s*(?:\s(?:is|are)\s|=|:|\s[–—-]\s)\s*(.+)$/iu;
  const SHOWN_IN = /(?:shown|marked|labelled|labeled|highlighted|shaded|displayed|printed|written|coloured|colored|flagged|outlined|listed|tinted)\s+(?:in\s+)?$/i;
  const THINGS_IN = /\p{L}+s\s+in\s+$/iu;
  const CLAUSE_START = /(?:^|[,:(]\s*|\band\s+|\bor\s+|\bwhile\s+|\bbut\s+)(?:(?:a|an|the|all|any)\s+)?$/i;
  // "Overdue invoices are shown in red": the meaning comes first.
  const ARE_SHOWN_IN = /^(.{3,60}?)\s+(?:is|are|appears?)\s+(?:shown|marked|labelled|labeled|highlighted|shaded|displayed|printed|written|coloured|colored|flagged|outlined|listed|tinted)\s+(?:in\s+)?$/i;
  /** colour word -> the stems of its meaning; null when the text is not a key. */
  const parseKey = (text: string): Map<string, string[]> | null => {
    const key = new Map<string, string[]>();
    let strong = false;
    let required = false;
    const add = (colour: string, meaning: string) => {
      key.set(colour, [...(key.get(colour) ?? []), ...stems(meaning)]);
      if (/\b(must|required?|mandatory|compulsory)\b/i.test(meaning)) required = true;
    };
    // What the clauses that matched call their things ("Green rooms are free": rooms), and the clauses that did not match yet.
    const nouns = new Set<string>();
    const noun = (words: string | undefined) => { const w = (words ?? '').trim().toLowerCase().split(/\s+/).pop(); if (w) nouns.add(w); };
    const open: { colour: string; seg: string }[] = [];
    for (const raw of text.split(/(?<=[.;!?])\s+|\s*;\s*|\n+/)) {
      const sentence = raw.replace(/[.;!?]+$/, '');
      const found = [...sentence.matchAll(new RegExp(`\\b${COLOR}\\b`, 'gi'))];
      for (let i = 0; i < found.length; i++) {
        const at = found[i]!.index ?? 0;
        const end = i + 1 < found.length ? (found[i + 1]!.index ?? sentence.length) : sentence.length;
        const lead = sentence.slice(0, at);
        const seg = sentence.slice(at, end).replace(/[,\s]+(?:(?:and|or|while|but)\s+)?(?:(?:a|an|the)\s*)?$/i, '');
        const colour = found[i]![1]!.toLowerCase();
        let m: RegExpExecArray | null;
        if ((m = SAYS.exec(seg))) { add(colour, m[2]!); noun(m[1]); strong = true; }
        else if (SHOWN_IN.test(lead) && (m = /^\S+[\s,]+(.+)$/u.exec(seg))) { add(colour, m[1]!); strong = true; }
        else if (THINGS_IN.test(lead) && (m = /^\S+\s+((?:are|is|must|need|needs|require|requires|indicate|indicates|mean|have|were|will)\b.+)$/iu.exec(seg))) { add(colour, m[1]!); strong = true; }
        else if (/^\S+$/.test(seg.trim()) && (m = ARE_SHOWN_IN.exec(lead))) { add(colour, m[1]!); strong = true; }
        else if (CLAUSE_START.test(lead) && (m = IS.exec(seg)) && m[2]!.trim().split(/\s+/).length <= 5) { add(colour, m[2]!); noun(m[1]); }
        else if (CLAUSE_START.test(lead)) open.push({ colour, seg });
      }
    }
    // A clause beside one that matched, about the same things in another colour and with any verb ("Red rooms need cleaning").
    for (const { colour, seg } of open) {
      const words = seg.trim().split(/\s+/);
      if (words.length >= 3 && words.length <= 8 && nouns.has(words[1]!.toLowerCase())) add(colour, words.slice(2).join(' '));
    }
    if (!key.size || (key.size < 2 && !strong)) return null;
    for (const s of key.values()) if (!s.length) return null;
    if (required) for (const [c, s] of key) key.set(c, [...s, 'requi', 'manda', 'compu']);
    return key;
  };

  // --- Where a key applies: the blocks beside it, up to a heading.
  const blockOf = (el: Element): Element => {
    let b = el;
    while (b.parentElement && b !== document.body && /^(inline|contents)$/.test(getComputedStyle(b).display)) b = b.parentElement;
    return b;
  };
  const groupOf = (block: Element): Element => {
    if (!/^(li|dd|dt|td|th)$/.test(block.localName)) return block;
    const list = block.closest('ul, ol, dl, table');
    return list && clean(list.textContent).length <= L.keyText ? list : block;
  };
  const HEAD = /^(h[1-6]|hr)$/;
  const scopeOf = (block: Element, single: boolean): Element[] => {
    if (block.localName === 'caption' && block.parentElement) return [block.parentElement];
    if (block.localName === 'figcaption') return [block.closest('figure') ?? block.parentElement!];
    if (block.localName === 'legend') return [block.closest('fieldset') ?? block.parentElement!];
    // A key alone in a wrapper: look around the wrapper.
    let anchor = block;
    for (let i = 0; i < 3; i++) {
      const parent = anchor.parentElement;
      if (!parent || parent === document.body || parent.localName === 'main') break;
      if ([...parent.children].some((c) => c !== anchor && shown(c) && clean(c.textContent))) break;
      anchor = parent;
    }
    // A key of one colour ("Dates shaded red need a second visit") is about what is right beside it, unless it sits inside the
    // form, list or table it explains.
    const inside = /^(form|fieldset|ul|ol|dl|table|tbody)$/.test(anchor.parentElement?.localName ?? '');
    const after = single && !inside ? L.near : L.after;
    const before = single && !inside ? 1 : L.before;
    const roots: Element[] = [];
    let n = 0;
    for (let s = anchor.nextElementSibling; s && n < after && !HEAD.test(s.localName); s = s.nextElementSibling, n++) roots.push(s);
    n = 0;
    for (let s = anchor.previousElementSibling; s && n < before && !HEAD.test(s.localName); s = s.previousElementSibling, n++) roots.push(s);
    return roots;
  };

  // --- The items that carry a colour.
  /**
   * `holder`: the complete item the coloured element belongs to (`wholeOf`); `text`: every word shown in it and
   * beside it (`wholeText`); `extra`: those words without the coloured element's own; `sig`: its shape, type style
   * and the graphics in it.
   */
  interface Item { el: Element; hue: string; how: 'dot' | 'text' | 'shade'; holder: Element; text: string; extra: string; kind: string; sig: string; title: boolean }
  const DOT_GLYPH = /^[\s●•◉⬤◆■▪▮○◯]*$/u;
  const ROW = 'li, tr, dd, dt, p, label, [role="listitem"], [role="row"]';
  const NOT_ITEM = /^(a|button|h[1-6]|input|select|textarea|option|summary|del|ins|code|pre|mark|svg|img|canvas|video|audio|iframe|script|style|caption|legend|figcaption)$/;
  const pseudo = (el: Element) => ['::before', '::after'].map((p) => { const c = getComputedStyle(el, p).content; return /^(none|normal|""|'')$/.test(c) ? '' : c; }).join('|');
  // How an item looks apart from its colours: a difference here is a cue of its own.
  const typeSig = (el: Element) => {
    const st = getComputedStyle(el);
    const border = ['Top', 'Right', 'Bottom', 'Left'].map((side) => { const s = st as unknown as Record<string, string>; return s[`border${side}Style`] === 'none' ? '' : `${s[`border${side}Style`]}${s[`border${side}Width`]}`; }).join(',');
    return `${Number(st.fontWeight) >= 600}|${st.fontStyle}|${st.textDecorationLine}|${st.textTransform}|${border}|${pseudo(el)}|${el.querySelector('img, svg, canvas') ? 'graphic' : ''}`;
  };
  // A swatch: an empty box of swatch size with a coloured fill or border, or a bullet character in a colour (in a box of any size: a table cell).
  const dotOf = (el: Element, st: CSSStyleDeclaration, r: DOMRect): string | null => {
    if (el.children.length || !DOT_GLYPH.test(el.textContent ?? '')) return null;
    const glyph = clean(el.textContent);
    if (glyph) return glyph.length <= 3 ? hue(st.color) : null;
    if (r.width < L.dotMin || r.width > L.dotMax || r.height < L.dotMin || r.height > L.dotMax) return null;
    return hue(st.backgroundColor) ?? (st.borderTopStyle !== 'none' && parseFloat(st.borderTopWidth) >= 2 ? hue(st.borderTopColor) : null);
  };
  const dotSig = (el: Element, st: CSSStyleDeclaration, r: DOMRect) => {
    const glyph = clean(el.textContent);
    return glyph ? `${glyph}|${st.fontSize}|${Number(st.fontWeight) >= 600}` : `${Math.round(r.width)}x${Math.round(r.height)}|${st.borderRadius}|${st.transform}|${st.clipPath}|${st.backgroundImage === 'none' ? '' : 'image'}|${pseudo(el)}`;
  };
  // The complete item a coloured element belongs to (review r1, finding 2: a status word beside a coloured name
  // is a cue, wherever in the item it stands): its table row, its list item, its term or description, its label;
  // else its own block, or the small group that holds it with a word or two beside it (a value with its label).
  const INLINE = /^(inline|contents|inline-block|inline-flex|inline-grid)$/;
  const wholeOf = (el: Element): Element => {
    const row = el.closest('tr, [role="row"]');
    if (row) return row;
    const item = el.closest('li, [role="listitem"], dt, dd, label');
    if (item) return item;
    let b: Element = el;
    while (b.parentElement && b.parentElement !== document.body && INLINE.test(getComputedStyle(b).display)) b = b.parentElement;
    const parent = b.parentElement;
    if (b === el && parent && parent !== document.body && parent.localName !== 'main' && parent.children.length <= 3 && clean(parent.textContent).length <= 120) return parent;
    return b;
  };
  /** The words of an item with what belongs to it outside its element: a term's descriptions, a label's field and the words beside it. */
  const wholeText = (holder: Element): string => {
    let out = seenText(holder);
    if (holder.localName === 'dt') for (let n = holder.nextElementSibling; n && n.localName === 'dd'; n = n.nextElementSibling) out += ` ${seenText(n)}`;
    if (holder.localName === 'dd') for (let n = holder.previousElementSibling; n; n = n.previousElementSibling) { out += ` ${seenText(n)}`; if (n.localName === 'dt') break; }
    if (holder.localName === 'label') {
      const control = (holder as HTMLLabelElement).control;
      if (control) out += ` ${control.getAttribute('placeholder') ?? ''}`;
      let n = holder.nextElementSibling;
      for (let i = 0; n && i < 3 && n.localName !== 'label'; n = n.nextElementSibling, i++) out += ` ${seenText(n)} ${n.getAttribute('placeholder') ?? ''}`;
    }
    return clean(out);
  };
  const short = (x: string) => { let h = 5381; for (let i = 0; i < x.length; i++) h = ((h << 5) + h + x.charCodeAt(i)) | 0; return (h >>> 0).toString(36); };
  /** The graphics an item shows (which picture, which icon), so that two different icons are two different cues. */
  const graphics = (holder: Element): string => {
    const out: string[] = [pseudo(holder)];
    let n = 0;
    for (const g of holder.querySelectorAll('*')) {
      if (++n > 40) break;
      if (g.localName === 'img') out.push(`img:${(g as HTMLImageElement).currentSrc || g.getAttribute('src') || ''}`);
      else if (g.localName === 'svg') out.push(`svg:${short(g.outerHTML.slice(0, 600))}`);
      else if (g.localName === 'canvas' || g.localName === 'picture') out.push(g.localName);
      else { const p = pseudo(g); if (p.replace(/\|/g, '')) out.push(p); }
    }
    return out.filter((x) => x.replace(/\|/g, '')).join(',');
  };
  const itemOf = (el: Element, hueName: string, how: Item['how'], ownSig: string): Item => {
    const holder = wholeOf(el);
    const text = wholeText(holder);
    const own = seenText(el);
    return {
      el, hue: hueName, how, holder, text, extra: own && text.includes(own) ? clean(text.replace(own, ' ')) : (how === 'dot' ? '' : text),
      kind: `${how === 'dot' ? 'dot' : el.localName}<${how === 'dot' ? holder.localName : el.parentElement?.localName ?? ''}`,
      sig: `${ownSig}#${graphics(holder)}`, title: el.hasAttribute('title') || holder.hasAttribute('title') || holder.querySelector('[title]') !== null,
    };
  };
  const itemsIn = (roots: Element[], block: Element, base: string): { items: Item[]; all: Element[] } => {
    const all: Element[] = [];
    for (const root of roots) {
      if (all.length >= L.scope) break;
      if (block.contains(root)) continue;
      all.push(root, ...[...root.querySelectorAll('*')].slice(0, L.scope - all.length));
    }
    const inScope = new Set(all);
    const items: Item[] = [];
    const taken = new Set<Element>();
    for (const el of all) {
      if (block.contains(el) || el.contains(block) || !shown(el)) continue;
      const st = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const dot = dotOf(el, st, r);
      if (dot) {
        const it = itemOf(el, dot, 'dot', dotSig(el, st, r));
        if (block.contains(it.holder) || it.holder.contains(block)) continue;
        // For telling a key of swatches from other dots, the swatch's own shape alone.
        items.push({ ...it, sig: dotSig(el, st, r) });
        continue;
      }
      if (NOT_ITEM.test(el.localName) || el.closest('a[href], button, svg')) continue;
      const own = clean([...el.childNodes].filter((n) => n.nodeType === 3).map((n) => n.nodeValue).join(' '));
      const textHue = own.length >= 2 && st.color !== base ? hue(st.color) : null;
      if (textHue) {
        // The whole coloured thing: the highest element here with this text colour (a row, not each of its cells).
        let top = el;
        while (top.parentElement && inScope.has(top.parentElement) && getComputedStyle(top.parentElement).color === st.color) top = top.parentElement;
        if (taken.has(top) || NOT_ITEM.test(top.localName) || top.contains(block)) continue;
        taken.add(top);
        const it = itemOf(top, textHue, 'text', typeSig(top));
        if (!it.holder.contains(block)) items.push(it);
        continue;
      }
      const shade = hue(st.backgroundColor);
      if (shade && !taken.has(el)) {
        const words = seenText(el);
        if (!words) continue;
        taken.add(el);
        const it = itemOf(el, shade, 'shade', typeSig(el));
        if (!it.holder.contains(block)) items.push(it);
      }
    }
    return { items, all };
  };
  const SYMBOL = /[✓✔✗✘✕✖×*†‡!⚠⚑▲△▼▽↑↓+−★☆☑☒✅❌⛔]/u;
  const has = (text: string, stem: string) => new RegExp(`(?<![\\p{L}])${stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'iu').test(text);

  /**
   * The items around a key that carry only its colours; null when there are none, or any item has a cue of its own;
   * `undecided` when the coloured items share one block of text and could not be told apart from its other words.
   */
  const judge = (block: Element, wanted: Map<string, string>, allStems: string[], single: boolean, swatches?: Set<string>): { bare: Item[]; colours: string[]; undecided?: true } | null => {
    const base = getComputedStyle(block).color;
    const { items, all } = itemsIn(scopeOf(block, single), block, base);
    // A key of swatches is a key for swatches of the same shape only: a list of named dots is not a key for coloured text beside it.
    for (const how of swatches ? ['dot'] as const : ['dot', 'text', 'shade'] as const) {
      const mine = items.filter((it) => it.how === how && wanted.has(it.hue) && (!swatches || swatches.has(it.sig)));
      if (!mine.length) continue;
      // Items of one kind: the commonest element-in-parent among them.
      const counts = new Map<string, number>();
      for (const it of mine) counts.set(it.kind, (counts.get(it.kind) ?? 0) + 1);
      const kind = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]![0];
      const group = mine.filter((it) => it.kind === kind);
      const colours = [...new Set(group.map((it) => wanted.get(it.hue)!))];
      // Several coloured elements in one ordinary block (not a list item, row, term or label of their own): which of
      // the block's other words belong to which of them cannot be told. Items are never rebuilt from the coloured
      // elements' own text, which dropped a status written beside each (review r2, finding 6): the key is left
      // undecided there.
      const shared = new Map<Element, number>();
      for (const it of group) shared.set(it.holder, (shared.get(it.holder) ?? 0) + 1);
      const sharedBlock = group.some((it) => (shared.get(it.holder) ?? 0) > 1 && !/^(tr|li|dt|dd|label)$/.test(it.holder.localName));
      // The plain items of the same kind beside them (a key of one colour tells its items from these).
      const peers: { text: string; sig: string }[] = [];
      if (how !== 'dot') {
        const coloured = new Set(group.map((it) => it.el));
        const holders = new Set(group.map((it) => it.holder));
        const seenHolders = new Set<Element>();
        for (const el of all) {
          if (coloured.has(el) || block.contains(el) || !shown(el) || `${el.localName}<${el.parentElement?.localName ?? ''}` !== kind) continue;
          const st = getComputedStyle(el);
          if (wanted.has(hue(how === 'text' ? st.color : st.backgroundColor) ?? '')) continue;
          const holder = wholeOf(el);
          if (holders.has(holder) || seenHolders.has(holder) || holder.contains(block)) continue;
          seenHolders.add(holder);
          const words = wholeText(holder);
          if (words) peers.push({ text: words, sig: `${typeSig(el)}#${graphics(holder)}` });
        }
      }
      if (!(colours.length >= 2 || (single && how !== 'dot' && peers.length >= 1))) continue;
      if (sharedBlock) return { bare: group, colours, undecided: true };
      const of = (it: Item) => wanted.get(it.hue)!;
      if (group.some((it) => it.title || SYMBOL.test(it.text) || NAMES.some((n) => has(it.text, n)))) return null;
      // (a) A word of the key that not every side carries says which is which, wherever in the item it stands.
      const sides = new Map<string, string[]>();
      for (const it of group) sides.set(of(it), [...(sides.get(of(it)) ?? []), it.text]);
      if (peers.length) sides.set('', peers.map((p) => p.text));
      const all2 = [...sides.values()];
      if (allStems.some((stem) => { const n = all2.filter((texts) => texts.some((t) => has(t, stem))).length; return n >= 1 && n < all2.length; })) return null;
      // (b) Any word that every item of one side carries and no item of another side does (a status in the page's own words).
      const wordsOf = (t: string) => new Set((t.toLowerCase().match(/\p{L}{3,}/gu) ?? []));
      const sideWords = all2.map((texts) => texts.map(wordsOf));
      for (let i = 0; i < sideWords.length; i++) {
        if (sideWords[i]!.length < 2) continue;
        const everywhere = [...sideWords[i]![0]!].filter((word) => sideWords[i]!.every((set) => set.has(word)));
        if (everywhere.some((word) => sideWords.some((other, j) => j !== i && other.every((set) => !set.has(word))))) return null;
      }
      // (c) Words beside the coloured element, inside its item, that differ from one side to another (outside tables,
      // where the other cells are other data): what they say may be the status.
      const beside = new Map<string, Set<string>>();
      for (const it of group) if (it.holder.localName !== 'tr') beside.set(of(it), (beside.get(of(it)) ?? new Set()).add(it.extra.toLowerCase()));
      const besides = [...beside.values()];
      if (besides.some((a, i) => [...a].some((x) => x && besides.some((b2, j) => j !== i && !b2.has(x))))) return null;
      // (d) A table column whose heading says it holds the status, with words in it for the coloured rows.
      const STATUS_HEAD = /\b(status|state|condition|availability|available|result|outcome|progress|stage)\b/i;
      for (const it of group) {
        const table = it.holder.closest('table');
        if (!table || it.holder.localName !== 'tr') continue;
        const heads = [...table.querySelectorAll('tr')].find((r) => r.querySelector('th[scope="col"], thead th') || r.parentElement?.localName === 'thead');
        const col = heads ? [...heads.children].findIndex((h) => STATUS_HEAD.test(h.textContent ?? '')) : -1;
        if (col >= 0 && /[\p{L}\p{N}]/u.test(seenText(it.holder.children[col] ?? it.holder).replace(/[●•◉⬤◆■▪▮○◯]/gu, ''))) return null;
      }
      // (e) A part set off at the end of the item ("Name — open", "Name (closed)", "Name: full") that differs from one side to another.
      const tail = (t: string) => { const parts = t.split(/\s[—–|]\s|:\s|\s\(|\s-\s/); return parts.length > 1 ? parts[parts.length - 1]!.replace(/[)\s.]+$/, '').toLowerCase() : ''; };
      const tails = new Map<string, Set<string>>();
      for (const it of group) tails.set(of(it), (tails.get(of(it)) ?? new Set()).add(tail(it.text)));
      const tailSets = [...tails.values()];
      if (tailSets.some((a, i) => [...a].some((x) => x && tailSets.some((b2, j) => j !== i && !b2.has(x))))) return null;
      // A shape, a type style or a graphic of its own for a side is a cue too.
      const looks = new Map<string, Set<string>>();
      for (const it of group) looks.set(of(it), (looks.get(of(it)) ?? new Set()).add(it.sig));
      if (peers.length) looks.set('', new Set(peers.map((p) => p.sig)));
      const sets = [...looks.values()];
      const apart = sets.some((a, i) => sets.some((b2, j) => j > i && ![...a].some((x) => b2.has(x))));
      if (apart) return null;
      return { bare: group, colours };
    }
    return null;
  };

  const hits: ColorKeyHit[] = [];
  const usedBlocks = new Set<Element>();
  const usedItems = new Set<Element>();
  const report = (block: Element, legend: string, form: ColorKeyHit['form'], labels: string[], found: { bare: Item[]; colours: string[]; undecided?: true }) => {
    if (found.bare.some((it) => usedItems.has(it.el))) return;
    usedBlocks.add(block);
    for (const it of found.bare) { usedItems.add(it.el); usedBlocks.add(blockOf(it.holder)); usedBlocks.add(groupOf(blockOf(it.holder))); }
    const cut = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
    hits.push({
      target: cssPath(found.bare[0]!.holder), legend: cut(legend, 200), form, labels, colours: found.colours, count: found.bare.length,
      samples: found.bare.slice(0, L.samples).map((it) => cut(it.text, 60)),
      ...(found.undecided ? { undecided: true as const } : {}),
    });
  };

  // 1. Keys in words.
  const WORD = new RegExp(`\\b${COLOR}\\b`, 'i');
  const blocks: Element[] = [];
  const walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
  let read = 0;
  for (let node = walker.nextNode(); node && read < L.nodes; node = walker.nextNode(), read++) {
    if (!WORD.test(node.nodeValue ?? '')) continue;
    const parent = node.parentElement;
    if (!parent || parent.closest('script, style, noscript, template, svg, a[href], button, h1, h2, h3, h4, h5, h6') || !shown(parent)) continue;
    const block = groupOf(blockOf(parent));
    if (!blocks.includes(block)) blocks.push(block);
  }
  for (const block of blocks) {
    if (hits.length >= L.keys) break;
    if (usedBlocks.has(block)) continue;
    const text = seenText(block);
    if (text.length > L.keyText) continue;
    const key = parseKey(text);
    if (!key) continue;
    const wanted = new Map<string, string>();
    for (const word of key.keys()) for (const h of ACCEPTS[word] ?? []) if (!wanted.has(h)) wanted.set(h, word);
    const found = judge(block, wanted, [...new Set([...key.values()].flat())], key.size === 1);
    if (found) report(block, text, 'words', [], found);
  }

  // 2. Keys of swatches: a block where every swatch has a word after it, each colour once.
  if (hits.length < L.keys) {
    const keys = new Map<Element, { el: Element; hue: string; label: string }[] | null>();
    let leaves = 0;
    for (const el of document.querySelectorAll('body *:empty, body span, body i, body b')) {
      if (++leaves > L.nodes) break;
      if (el.children.length || !shown(el)) continue;
      const st = getComputedStyle(el);
      const h = dotOf(el, st, el.getBoundingClientRect());
      if (!h) continue;
      const block = groupOf(blockOf(el.parentElement ?? el));
      if (keys.get(block) === null) continue;
      // The word after it: the text up to the next swatch or the end of its own item.
      let label = '';
      const end = /^(li|dd|dt|td|th)$/.test(blockOf(el.parentElement ?? el).localName) ? blockOf(el.parentElement ?? el) : block;
      for (let n: Node | null = el.nextSibling; n && end.contains(n); n = n.nextSibling) {
        if (n.nodeType === 1 && dotOf(n as Element, getComputedStyle(n as Element), (n as Element).getBoundingClientRect())) break;
        label += n.nodeType === 3 ? n.nodeValue : n.nodeType === 1 && shown(n as Element) ? seenText(n as Element) : '';
      }
      label = clean(label).replace(/^[\s:=–—-]+|[\s,;.]+$/g, '');
      if (label.length < 2 || label.length > 30) { keys.set(block, null); continue; }
      keys.set(block, [...(keys.get(block) ?? []), { el, hue: h, label }]);
    }
    const candidates = [...keys.entries()].filter((e): e is [Element, { el: Element; hue: string; label: string }[]] => e[1] !== null && e[1].length >= 2 && new Set(e[1].map((s) => s.hue)).size === e[1].length)
      .filter(([block]) => clean(block.textContent).length <= 160)
      .sort((a, b) => clean(a[0].textContent).length - clean(b[0].textContent).length);
    for (const [block, swatches] of candidates) {
      if (hits.length >= L.keys) break;
      if (usedBlocks.has(block)) continue;
      const wanted = new Map(swatches.map((s) => [s.hue, s.label]));
      const allStems = [...new Set(swatches.flatMap((s) => stems(s.label)))];
      if (swatches.some((s) => !stems(s.label).length)) continue;
      const found = judge(block, wanted, allStems, false, new Set(swatches.map((s) => dotSig(s.el, getComputedStyle(s.el), s.el.getBoundingClientRect()))));
      if (found) report(block, swatches.map((s) => s.label).join(', '), 'swatches', swatches.map((s) => s.label), found);
    }
  }
  return hits;
}

const list = (words: readonly string[]) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);

/** One failure per colour key whose items carry only the colour; a key whose items could not be told apart is not testable. */
export function colorKeyFindings(hits: readonly ColorKeyHit[]): ProbeFinding[] {
  return hits.map((hit): ProbeFinding => {
    const says = hit.form === 'swatches' ? `the page’s key gives a color to each of ${list(hit.labels.map((l) => `“${l}”`))}` : `the page says “${hit.legend}”`;
    if (hit.undecided) {
      return { criterion: '1.4.1', status: 'not_testable', target: hit.target, detail: `Whether only color tells these items apart could not be told: ${says}, and the ${hit.count} colored items there share one block of text, so the words beside each could not be matched to it` };
    }
    const items = hit.colours.length >= 2
      ? `${hit.count} ${hit.count === 1 ? 'item' : 'items'} there carry the color with no word, symbol or shape of their own that says which`
      : `${hit.count} ${hit.count === 1 ? 'item there is' : 'items there are'} told apart from the others like ${hit.count === 1 ? 'it' : 'them'} only by ${hit.count === 1 ? 'its' : 'their'} color`;
    return { criterion: '1.4.1', status: 'failed', target: hit.target, detail: `Only color tells these items apart: ${says}, and ${items}: ${hit.samples.map((s) => `“${s}”`).join(', ')}` };
  });
}
