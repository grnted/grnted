// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page text collector: the text-only inputs of the AI page text review (titles, headings, links,
// form instructions, sensory wording, passages in another language, fake headings and lists).
// Engine core: no Node-only or AI imports.
import type { PageCollector } from '../types.js';

/** Caps per page. The in-page script applies them, and `toPageTextData` again (page scripts are untrusted). */
export const PAGE_TEXT_LIMITS = {
  headings: 60,
  links: 80,
  controls: 40,
  sensoryCandidates: 20,
  langBlocks: 10,
  structureCandidates: 20,
} as const;

export interface PageTextData {
  /** Every item below has a `ref` unique within the page (1, 2, 3…), so a model can point at it. */
  title: { ref: number; text: string };
  /** The `lang` attribute of `<html>`, or '' when there is none. */
  lang: string;
  headings: { ref: number; level: number; text: string }[];
  /** De-duplicated by name and href. Links inside `main` are kept first when the cap applies. */
  links: { ref: number; text: string; href: string; context: string; heading?: string; newWindow: boolean }[];
  /**
   * Form fields and buttons. `hint` is visible help text linked to or next to the field. `shownLabel` is the
   * visible text just before a field with no accessible name (a label not tied to it: shown, not announced),
   * and `button` the button that shares the field's own small box (a search field and its Search button).
   */
  controls: { ref: number; type: string; label: string; placeholder: string; autocomplete: string; hint: string; required: boolean; shownLabel?: string; button?: string }[];
  /** Sentences that mention a colour, shape, position or sound. */
  sensoryCandidates: { ref: number; text: string }[];
  /** Paragraphs whose words look like a language other than the `lang` they inherit; `guess` is a rough code. */
  langBlocks: { ref: number; lang: string; guess: string; text: string }[];
  /** Text styled to look like a heading, or lines written as a list, outside heading and list markup. */
  structureCandidates: { ref: number; looksLike: 'heading' | 'list'; text: string }[];
}

/** What the in-page script returns (no refs yet). */
export interface RawPageText {
  title: string;
  lang: string;
  headings: { level: number; text: string }[];
  links: { text: string; href: string; context: string; heading?: string; newWindow: boolean }[];
  controls: { type: string; label: string; placeholder: string; autocomplete: string; hint: string; required: boolean; shownLabel?: string; button?: string }[];
  sensory: string[];
  langBlocks: { lang: string; guess: string; text: string }[];
  structure: { looksLike: 'heading' | 'list'; text: string }[];
}

/**
 * Runs inside the page, after axe. Fully self-contained (it is serialized into the browser): every
 * helper and word list lives in here.
 */
function collectPageText(): RawPageText {
  const LIMITS = { headings: 60, links: 80, controls: 40, sensory: 20, langBlocks: 10, structure: 20 };
  const clean = (s: string | null | undefined, max = 300) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  // Not shown: no box, aria-hidden, or visibility:hidden / opacity 0 on it or an ancestor (a closed menu's or panel's
  // controls, which nobody sees or uses until it opens; 2026-11-07 audit: hidden buttons read as "Unlabeled").
  const cv = (el: Element) => {
    const f = (el as Element & { checkVisibility?: (o: object) => boolean }).checkVisibility;
    return typeof f === 'function' ? f.call(el, { visibilityProperty: true, opacityProperty: true }) : getComputedStyle(el).visibility !== 'hidden';
  };
  const hidden = (el: Element) => el.getClientRects().length === 0 || el.closest('[aria-hidden="true"]') !== null || !cv(el);
  const textOf = (el: Element) => (el as HTMLElement).innerText ?? el.textContent ?? '';
  // Shown: one test for every fact handed over as "shown" (the heading a link is under, a field's shown label, a
  // link's row or sentence, a field's help text; review round 2). An element is shown when checkVisibility passes
  // (no opacity 0, no visibility hidden), nothing up its ancestors clips it away (a 1 px box with overflow hidden,
  // clip rect(0 0 0 0), clip-path inset(50%)) and aria-hidden does not remove it; a piece of text is shown when its
  // element is and its own box has a usable size (2 px or more each way) inside the page's scrollable area (not
  // parked off the page, not text-indent -9999px).
  const clippedCache = new Map<Element, boolean>();
  const clippedAway = (el: Element | null): boolean => {
    if (!el || el === document.body || el === document.documentElement) return false;
    const known = clippedCache.get(el);
    if (known !== undefined) return known;
    const st = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const tiny = (r.width < 2 || r.height < 2) && st.overflow !== 'visible';
    const clip = /^rect\(\s*0(px)?[\s,]+0(px)?[\s,]+0(px)?[\s,]+0(px)?\s*\)$/.test(st.clip) || /^inset\(\s*(50|100)%/.test(st.clipPath);
    const out = tiny || clip || clippedAway(el.parentElement);
    clippedCache.set(el, out);
    return out;
  };
  const shownEl = (el: Element) => el.getClientRects().length > 0 && cv(el) && !el.closest('[aria-hidden="true"]') && !clippedAway(el);
  const inPage = (r: DOMRect) => {
    const left = r.left + window.scrollX;
    const top = r.top + window.scrollY;
    const root = document.documentElement;
    return r.width >= 2 && r.height >= 2 && left + r.width > 0 && top + r.height > 0
      && left < Math.max(root.scrollWidth, window.innerWidth) && top < Math.max(root.scrollHeight, window.innerHeight);
  };
  const rangeOf = document.createRange();
  const shownTextNode = (t: Node): boolean => {
    const owner = t.parentElement;
    if (!t.nodeValue?.trim() || !owner || !shownEl(owner)) return false;
    rangeOf.selectNodeContents(t);
    return [...rangeOf.getClientRects()].some(inPage);
  };
  const shownBox = (el: Element) => shownEl(el) && [...el.getClientRects()].some(inPage);
  const byIds = (ids: string | null) =>
    (ids ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  const imageNames = (el: Element) =>
    [...el.querySelectorAll('img[alt], [role="img"][aria-label]')]
      .filter((i) => !i.closest('[aria-hidden="true"]'))
      .map((i) => i.getAttribute('aria-label') ?? i.getAttribute('alt') ?? '')
      .join(' ');
  /** A simplified accessible name: labelledby, aria-label, text plus image alt, then title. */
  const nameOf = (el: Element): string =>
    clean(byIds(el.getAttribute('aria-labelledby')), 200) ||
    clean(el.getAttribute('aria-label'), 200) ||
    clean(`${textOf(el)} ${imageNames(el)}`, 200) ||
    clean(el.getAttribute('title'), 200);
  /** Keeps at most `max` items, preferring those that pass `first`, in page order. */
  const capInOrder = <T>(items: T[], max: number, first: (t: T) => boolean): T[] => {
    if (items.length <= max) return items;
    const keep = new Set([...items.filter(first), ...items.filter((t) => !first(t))].slice(0, max));
    return items.filter((t) => keep.has(t));
  };

  // Headings -----------------------------------------------------------------------------------
  const headings: RawPageText['headings'] = [];
  for (const h of document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
    if (headings.length >= LIMITS.headings) break;
    if (hidden(h)) continue;
    // An h1-h6 with another role (presentation, none, tab...) is not a heading to a screen reader.
    const role = (h.getAttribute('role') ?? '').trim().toLowerCase();
    if (role && role !== 'heading') continue;
    const text = nameOf(h);
    if (!text) continue; // empty headings are axe's job
    const tagLevel = /^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : 2;
    headings.push({ level: Number(h.getAttribute('aria-level')) || tagLevel, text });
  }

  // Links --------------------------------------------------------------------------------------
  /** The sentence, list item or table cell around a link (empty when it is just the link). */
  /** The text under an element that is shown: text in elements checkVisibility says are hidden (opacity 0, visibility
   * hidden, display none) is left out, so hidden words never become a link's context (review round 1). */
  const shownText = (root: Element): string => {
    const out: string[] = [];
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let n = 0;
    for (let t = walker.nextNode(); t && n < 3000; t = walker.nextNode(), n++) {
      if (shownTextNode(t)) out.push(t.nodeValue!);
    }
    return out.join(' ');
  };
  const linkContext = (a: Element, text: string): string => {
    let block: Element | null = a.closest('li, td, th, dd, dt, p, figcaption, blockquote, caption, h1, h2, h3, h4, h5, h6') ?? a.parentElement;
    // A table cell that holds only the link: its row (the row's other cells say what it is for).
    if (block && /^(TD|TH)$/.test(block.tagName) && clean(shownText(block)) === text) block = block.closest('tr') ?? block;
    // A box that holds only the link (or only links, "PDF | DOC"): the next boxes up, while they stay small, until
    // one adds words of its own (a card's title, a row's document name).
    const ownWords = (b: Element) => clean([...b.querySelectorAll('a')].reduce((t, l) => t.replace(textOf(l), ' '), shownText(b)).replace(/[|/·•,:;-]/g, ' '));
    // Only plain boxes (div, span): a list item or paragraph that holds just its link is that link's own context.
    for (let up = 0; block && up < 3 && /^(DIV|SPAN)$/.test(block.tagName) && ownWords(block).length < 3; up++) {
      const parent: Element | null = block.parentElement;
      if (!parent || parent === document.body || (parent.textContent ?? '').length > 600) break;
      block = parent;
    }
    if (!block || (block.textContent ?? '').length > 5000) return ''; // a layout wrapper, not a sentence
    const full = clean(shownText(block), 3000);
    let out = full;
    if (full.length > 250) {
      const at = Math.max(0, full.indexOf(text));
      const before = Math.max(full.lastIndexOf('. ', at), full.lastIndexOf('! ', at), full.lastIndexOf('? ', at));
      const start = before < 0 ? 0 : before + 2;
      const after = full.slice(at + text.length).search(/[.!?](\s|$)/);
      const end = after < 0 ? full.length : at + text.length + after + 1;
      out = full.slice(start, end);
      if (out.length > 250) out = full.slice(Math.max(0, at - 120), at + text.length + 120);
    }
    return out === text ? '' : out.slice(0, 250);
  };
  const main = document.querySelector('main, [role="main"]');
  const seenLinks = new Set<string>();
  const allLinks: (Omit<RawPageText['links'][number], 'context'> & { el: Element; inMain: boolean })[] = [];
  let scanned = 0;
  for (const a of document.querySelectorAll('a[href]')) {
    if (++scanned > 3000) break;
    if (hidden(a)) continue;
    const text = nameOf(a);
    if (!text) continue; // links without a name are axe's job
    const href = (a as HTMLAnchorElement).href;
    const key = `${text.toLowerCase()}\u0000${href}`;
    if (seenLinks.has(key)) continue;
    seenLinks.add(key);
    const target = (a.getAttribute('target') ?? '').toLowerCase();
    allLinks.push({
      el: a, text, href: href.slice(0, 300),
      newWindow: target !== '' && !['_self', '_parent', '_top'].includes(target),
      inMain: main ? main.contains(a) : true,
    });
  }
  // The heading a link sits under (H80), as a fact for the model, never a pass (review round 1): the last shown heading
  // before the link inside one of its nearest ancestors (at most HEADING_SCOPE levels up), with little text between
  // them (at most HEADING_GAP characters, about a short paragraph or a short list). Never a level-1 heading (the page's own title or the site name, as in the
  // link-purpose test, src/probes/linkPurpose.ts), and an h1 in between never hides a nearer h2.
  const HEADING_SCOPE = 4;
  const HEADING_GAP = 600;
  const levelOf = (h: Element) => Number(h.getAttribute('aria-level')) || (/^H[1-6]$/.test(h.tagName) ? Number(h.tagName[1]) : 2);
  const isHeading = (h: Element) => { const r = (h.getAttribute('role') ?? '').toLowerCase(); return (/^H[1-6]$/.test(h.tagName) ? !r || r === 'heading' : r === 'heading') && shownBox(h) && shownText(h).trim() !== ''; };
  const headingBefore = (a: Element): string => {
    if (a.closest('h1, h2, h3, h4, h5, h6, [role="heading"]')) return ''; // a link inside a heading: the heading is its context
    let scope: Element | null = a.parentElement;
    for (let up = 0; scope && scope !== document.body && up < HEADING_SCOPE; up++, scope = scope.parentElement) {
      let best: Element | null = null;
      for (const h of scope.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')) {
        if (!(h.compareDocumentPosition(a) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
        if (isHeading(h) && levelOf(h) > 1) best = h;
      }
      if (!best) continue;
      const between = document.createRange();
      between.setStartAfter(best);
      between.setEndBefore(a);
      return between.toString().replace(/\s+/g, ' ').trim().length <= HEADING_GAP ? clean(nameOf(best), 150) : '';
    }
    return '';
  };
  // Context is read only for the links kept.
  const links = capInOrder(allLinks, LIMITS.links, (l) => l.inMain).map(({ el, text, href, newWindow }) => ({ text, href, context: linkContext(el, text), heading: headingBefore(el), newWindow }));

  // Form fields and buttons --------------------------------------------------------------------
  const fieldSelector = 'input:not([type="hidden"]), select, textarea';
  const allControls: (RawPageText['controls'][number] & { field: boolean; inForm: boolean })[] = [];
  scanned = 0;
  for (const el of document.querySelectorAll(`${fieldSelector}, button`)) {
    if (++scanned > 1000) break;
    if (hidden(el)) continue;
    const tag = el.tagName.toLowerCase();
    const inputType = tag === 'input' ? (el.getAttribute('type') || 'text').toLowerCase() : '';
    const isButton = tag === 'button' || ['submit', 'button', 'reset', 'image'].includes(inputType);
    const type = tag === 'input' ? inputType : tag;
    // A label that wraps the field also holds the field's own text (a select's options): leave it out.
    const own = clean(tag === 'select' || tag === 'textarea' ? textOf(el) : '', 1000);
    const withoutOwn = (t: string) => clean(own ? clean(t, 3000).replace(own, ' ') : t, 3000);
    const labels = 'labels' in el && (el as HTMLInputElement).labels ? [...(el as HTMLInputElement).labels!].map((l) => withoutOwn(textOf(l))).join(' ') : '';
    let label = clean(byIds(el.getAttribute('aria-labelledby')), 200) || clean(el.getAttribute('aria-label'), 200) || clean(labels, 200);
    if (!label && tag === 'button') label = nameOf(el);
    if (!label && isButton && tag === 'input') {
      label = inputType === 'image'
        ? clean(el.getAttribute('alt'), 200)
        : clean((el as HTMLInputElement).value, 200) || (inputType === 'submit' ? 'Submit' : inputType === 'reset' ? 'Reset' : '');
    }
    if (!label) label = clean(el.getAttribute('title'), 200);
    // Help the page shows (3.3.2 asks for shown instructions): a description no one sees is not a hint.
    const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id));
    let hint = clean(described.map((d) => (d ? shownText(d) : '')).join(' '), 200);
    if (!hint && !isButton) {
      // Visible help next to the field: the nearest small wrapper that holds only this field.
      let box = el.parentElement;
      for (let depth = 0; box && depth < 3; depth++, box = box.parentElement) {
        if (box.querySelectorAll(`${fieldSelector}, button`).length > 1) break;
        const t = withoutOwn(shownText(box)).slice(0, 400);
        if (t.length > 300) break;
        const rest = clean(label ? t.replace(label, ' ') : t, 200);
        if (rest && rest !== clean(el.getAttribute('placeholder'))) {
          hint = rest;
          break;
        }
      }
    }
    // A field with no accessible name: a visible label right against it that names it (a <label>, a <span> or a
    // text node just before the field, short, not a sentence), shown but not tied to it. A <p> or a heading is not a
    // label (review round 1). And for a search field only (type search, or its own name or placeholder says search),
    // the button sharing its small box.
    let shownLabel = '';
    let button = '';
    if (!isButton) {
      if (!label) {
        let prev: Node | null = el.previousSibling;
        while (prev && ((prev.nodeType === Node.TEXT_NODE && !prev.nodeValue?.trim()) || (prev.nodeType === Node.ELEMENT_NODE && (prev as Element).tagName === 'BR'))) prev = prev.previousSibling;
        let cand = '';
        if (prev?.nodeType === Node.TEXT_NODE) cand = shownTextNode(prev) ? clean(prev.nodeValue, 120) : '';
        else if (prev && /^(LABEL|SPAN)$/.test((prev as Element).tagName) && !(prev as Element).querySelector(fieldSelector)) cand = clean(shownText(prev as Element), 120);
        const names = cand.length >= 1 && cand.length <= 60 && cand.split(' ').length <= 8 && !/[.!?]$/.test(cand);
        if (names) shownLabel = cand;
      }
      const SEARCH = /\bsearch\b/i;
      const isSearch = type === 'search' || SEARCH.test(`${label} ${el.getAttribute('placeholder') ?? ''} ${el.getAttribute('name') ?? ''} ${el.getAttribute('title') ?? ''}`);
      for (let box = el.parentElement, depth = 0; isSearch && box && depth < 3; box = box.parentElement, depth++) {
        const fields = box.querySelectorAll(fieldSelector).length;
        const buttons = [...box.querySelectorAll('button, input[type="submit"], input[type="image"], input[type="button"]')].filter((b) => !hidden(b));
        if (fields > 1 || buttons.length > 1) break;
        if (buttons.length === 1) { button = nameOf(buttons[0]!) || clean(buttons[0]!.getAttribute('value'), 60) || clean(buttons[0]!.getAttribute('alt'), 60); break; }
      }
    }
    allControls.push({
      type, label, hint, shownLabel, button: clean(button, 60),
      placeholder: clean(el.getAttribute('placeholder'), 150),
      autocomplete: clean(el.getAttribute('autocomplete'), 60),
      required: (el as HTMLInputElement).required === true || el.getAttribute('aria-required') === 'true',
      field: !isButton,
      inForm: el.closest('form') !== null,
    });
  }
  const controls = capInOrder(allControls, LIMITS.controls, (c) => c.field || c.inForm).map(({ field: _f, inForm: _i, ...c }) => c);

  // Text blocks: leaf elements that hold running text ---------------------------------------------
  const BLOCK = 'p, li, td, th, dd, dt, blockquote, figcaption, caption, legend, label, div';
  const CONTAINER = 'p, li, td, th, dd, dt, blockquote, figcaption, div, ul, ol, dl, table, h1, h2, h3, h4, h5, h6, section, article, aside, header, footer, nav, main, form, fieldset, pre';
  const blocks: { el: Element; lines: string[]; text: string }[] = [];
  scanned = 0;
  for (const el of document.querySelectorAll(BLOCK)) {
    if (++scanned > 4000) break;
    if (el.querySelector(CONTAINER) || el.closest('pre, code, script, style, template')) continue;
    if ((el.textContent ?? '').length > 5000 || hidden(el)) continue;
    const rawText = textOf(el);
    const text = clean(rawText, 3000);
    if (text.length >= 2) blocks.push({ el, text, lines: rawText.split('\n').map((l) => clean(l, 300)).filter(Boolean) });
  }

  // Sensory wording -------------------------------------------------------------------------------
  const SENSORY = /\b(red|green|blue|yellow|orange|purple|pink|gr[ae]y|black|white|brown|colou?r(ed)?|round|circle|circular|square|triangle|triangular|star|diamond|arrow|icon|shape|on the (right|left)|to the (right|left)|(right|left)[- ]hand|above|below|top of the (page|screen)|bottom of the (page|screen)|in the corner|sidebar|beep|tone|chime|sound|hear|listen)\b/i;
  const INSTRUCTION = /\b(click|press|tap|select|choose|use|see|look|find|follow|fill|enter|type|push|listen|wait)\b/i;
  const seenSentences = new Set<string>();
  const sensoryAll: string[] = [];
  for (const b of blocks) {
    if (b.el.closest('nav')) continue;
    for (const sentence of b.text.split(/(?<=[.!?])\s+/)) {
      const s = clean(sentence, 250);
      if (s.length < 12 || !SENSORY.test(s) || seenSentences.has(s.toLowerCase())) continue;
      seenSentences.add(s.toLowerCase());
      sensoryAll.push(s);
    }
  }
  const sensory = capInOrder(sensoryAll, LIMITS.sensory, (s) => INSTRUCTION.test(s));

  // Passages in another language --------------------------------------------------------------------
  const words = (list: string) => new Set(list.split(' '));
  const STOP: [string, Set<string>][] = [
    ['en', words('the and of to is in that for with you are this be on your will have from our we it as at by can not or an if all has was')],
    ['es', words('el la los las de del y que en un una por para con es su sus se no al lo como más pero este esta usted nuestro nuestra todos son hay')],
    ['fr', words('le la les de des du et est un une en que qui pour dans avec sur pas au aux ce cette vous nous il elle sont être ou par ne votre')],
    ['de', words('der die das und ist ein eine zu den dem mit für von auf nicht sich des im sie wir es auch oder werden bei aus an wie nach ihre')],
    ['pt', words('o os as de do da dos das e que em um uma para com não por se mais na no ao é você sua seu ou como são nossa')],
    ['vi', words('và của là có được các cho trong không những một với người này để đã khi từ theo về bạn chúng tôi sẽ cũng đến năm')],
    ['tl', words('ang ng sa na mga at ay ito para ni si kung hindi may ka mo ko siya namin natin kami po ninyo')],
  ];
  const SCRIPTS: [string, RegExp][] = [
    ['zh', /\p{Script=Han}/gu], ['ja', /[\p{Script=Hiragana}\p{Script=Katakana}]/gu], ['ko', /\p{Script=Hangul}/gu],
    ['ar', /\p{Script=Arabic}/gu], ['ru', /\p{Script=Cyrillic}/gu], ['he', /\p{Script=Hebrew}/gu],
    ['el', /\p{Script=Greek}/gu], ['hi', /\p{Script=Devanagari}/gu], ['th', /\p{Script=Thai}/gu],
  ];
  const guessLanguage = (text: string): string => {
    const sample = text.slice(0, 800);
    const letters = (sample.match(/\p{L}/gu) ?? []).length;
    if (letters < 20) return '';
    const scripts = SCRIPTS.map(([code, re]) => [code, (sample.match(re) ?? []).length] as const);
    const kana = scripts.find(([c]) => c === 'ja')![1];
    const han = scripts.find(([c]) => c === 'zh')![1];
    if (kana > 0 && kana + han >= letters * 0.4) return 'ja';
    const top = scripts.filter(([c]) => c !== 'ja').sort((x, y) => y[1] - x[1])[0]!;
    if (top[1] >= letters * 0.4) return top[0];
    const tokens = sample.toLowerCase().match(/\p{L}+/gu) ?? [];
    if (tokens.length < 8) return '';
    const scores = STOP.map(([code, set]) => [code, tokens.filter((t) => set.has(t)).length] as const).sort((x, y) => y[1] - x[1]);
    const [best, second] = [scores[0]!, scores[1]!];
    if (best[1] < 3 || best[1] < tokens.length * 0.12 || best[1] < second[1] * 1.5) return '';
    return best[0];
  };
  const primary = (lang: string) => {
    const p = lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    return p === 'fil' ? 'tl' : p === 'iw' ? 'he' : p;
  };
  const langBlocks: RawPageText['langBlocks'] = [];
  const seenPassages = new Set<string>();
  for (const b of blocks) {
    if (langBlocks.length >= LIMITS.langBlocks) break;
    if (b.text.length < 60 || !b.el.matches('p, li, td, dd, blockquote, figcaption, div') || seenPassages.has(b.text)) continue;
    seenPassages.add(b.text);
    const lang = b.el.closest('[lang]')?.getAttribute('lang') ?? '';
    const declared = primary(lang);
    if (!declared) continue; // a page without lang is axe's html-has-lang
    const guess = guessLanguage(b.text);
    if (guess && guess !== declared) langBlocks.push({ lang: clean(lang, 20), guess, text: b.text.slice(0, 400) });
  }

  // Fake headings and fake lists ------------------------------------------------------------------
  const MARKER = /^([•·▪◦‣●○■□\-–—*]|\d{1,2}[.)])\s+\S/;
  const base = parseFloat(getComputedStyle(document.body).fontSize) || 16;
  const styledAsHeading = (el: Element): boolean => {
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    let bold = true;
    let large = true;
    let any = false;
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (!node.nodeValue?.trim() || !node.parentElement) continue;
      any = true;
      const style = getComputedStyle(node.parentElement);
      const weight = style.fontWeight === 'bold' ? 700 : Number(style.fontWeight);
      if (!(weight >= 600)) bold = false;
      if (!(parseFloat(style.fontSize) >= base * 1.25)) large = false;
      if (!bold && !large) return false;
    }
    return any;
  };
  const structureAll: (RawPageText['structure'][number] & { order: number })[] = [];
  let run: { last: Element; lines: string[]; order: number } | undefined;
  const endRun = () => {
    if (run && run.lines.length >= 2) structureAll.push({ looksLike: 'list', text: run.lines.join('\n').slice(0, 300), order: run.order });
    run = undefined;
  };
  blocks.forEach((b, order) => {
    if (b.el.closest('li, nav, pre, code')) return;
    const markedLines = b.lines.filter((l) => MARKER.test(l));
    if (markedLines.length >= 2 && markedLines.length >= b.lines.length - 1) {
      endRun();
      structureAll.push({ looksLike: 'list', text: b.lines.join('\n').slice(0, 300), order });
      return;
    }
    if (b.lines.length === 1 && MARKER.test(b.text) && b.el.matches('p, div')) {
      if (run && b.el.previousElementSibling === run.last) {
        run.lines.push(b.text);
        run.last = b.el;
      } else {
        endRun();
        run = { last: b.el, lines: [b.text], order };
      }
      return;
    }
    endRun();
    const next = b.el.nextElementSibling;
    if (
      b.el.matches('p, div') && b.text.length <= 80 && b.text.split(' ').length <= 12 && !/\.$/.test(b.text) &&
      // A control by its role (an accordion toggle made of a div with role=button) is not a heading candidate either: its name
      // is the names and keyboard tests' to judge (page-text@7, red-team training site 02).
      !b.el.closest('li, td, th, label, button, a, h1, h2, h3, h4, h5, h6, legend, caption, summary, dt, figcaption, [role="heading"], [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="option"], [role="switch"], [role="checkbox"], [role="radio"], [role="treeitem"]') &&
      !b.el.querySelector('a, button, input, select, textarea, img, svg') &&
      // A short styled line right above a real heading is an eyebrow or kicker over it, not a heading (review r1).
      next !== null && !next.matches('h1, h2, h3, h4, h5, h6, [role="heading"]') && clean(next.textContent).length > 0 && styledAsHeading(b.el)
    ) {
      structureAll.push({ looksLike: 'heading', text: b.text, order });
    }
  });
  endRun();
  // An h1-h6 whose role takes its heading away (presentation, none) but that still looks like a heading: a structure
  // candidate, so the model can judge it as a fake heading (review round 1), with its shown text. One that holds a
  // link too ("<h2 role=presentation><a>News</a></h2>": heard only as a link) is a candidate (review round 2); one
  // that holds a form control or a button is a control, not a title.
  let pres = 0;
  for (const h of document.querySelectorAll('h1[role], h2[role], h3[role], h4[role], h5[role], h6[role]')) {
    if (pres >= 10) break;
    if (!/^(presentation|none)$/i.test((h.getAttribute('role') ?? '').trim()) || !shownBox(h)) continue;
    const text = clean(shownText(h), 120);
    if (!text || h.querySelector('button, input, select, textarea')) continue;
    if (!styledAsHeading(h)) continue;
    pres++;
    // In page order among the blocks: after the last block that comes before it.
    let order = 0;
    blocks.forEach((b, i) => { if (b.el.compareDocumentPosition(h) & Node.DOCUMENT_POSITION_FOLLOWING) order = i + 0.5; });
    structureAll.push({ looksLike: 'heading', text, order });
  }
  const structure = structureAll.sort((x, y) => x.order - y.order).slice(0, LIMITS.structure).map(({ order: _o, ...s }) => s);

  return {
    title: clean(document.title, 200),
    lang: clean(document.documentElement.getAttribute('lang'), 20),
    headings, links, controls, sensory, langBlocks, structure,
  };
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '');
const multiline = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, max) : '';
const list = <T>(v: unknown, max: number, map: (x: Record<string, unknown>) => T | undefined): T[] =>
  (Array.isArray(v) ? v : [])
    .filter((x): x is Record<string, unknown> => typeof x === 'object' && x !== null)
    .map(map)
    .filter((x): x is T => x !== undefined)
    .slice(0, max);

/**
 * Validates, trims and caps what the page returned (a hostile page can patch built-ins the
 * in-page script uses) and numbers every item with a page-unique `ref`, starting at 1 for the title.
 */
export function toPageTextData(raw: unknown): PageTextData {
  const r = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  let ref = 0;
  const next = () => ++ref;
  const title = { ref: next(), text: str(r.title, 200) };
  const headings = list(r.headings, PAGE_TEXT_LIMITS.headings, (h) => {
    const text = str(h.text, 200);
    const level = Math.min(Math.max(Math.round(Number(h.level)) || 2, 1), 6);
    return text ? { level, text } : undefined;
  }).map((h) => ({ ref: next(), ...h }));
  const links = list(r.links, PAGE_TEXT_LIMITS.links, (l) => {
    const text = str(l.text, 200);
    const heading = str(l.heading, 150);
    return text ? { text, href: str(l.href, 300), context: str(l.context, 250), ...(heading ? { heading } : {}), newWindow: l.newWindow === true } : undefined;
  }).map((l) => ({ ref: next(), ...l }));
  const controls = list(r.controls, PAGE_TEXT_LIMITS.controls, (c) => ({
    type: str(c.type, 30) || 'text', label: str(c.label, 200), placeholder: str(c.placeholder, 150),
    autocomplete: str(c.autocomplete, 60), hint: str(c.hint, 200), required: c.required === true,
    ...(str(c.shownLabel, 120) ? { shownLabel: str(c.shownLabel, 120) } : {}), ...(str(c.button, 60) ? { button: str(c.button, 60) } : {}),
  })).map((c) => ({ ref: next(), ...c }));
  const sensoryCandidates = (Array.isArray(r.sensory) ? r.sensory : [])
    .map((s) => str(s, 250)).filter(Boolean).slice(0, PAGE_TEXT_LIMITS.sensoryCandidates)
    .map((text) => ({ ref: next(), text }));
  const langBlocks = list(r.langBlocks, PAGE_TEXT_LIMITS.langBlocks, (b) => {
    const text = str(b.text, 400);
    const guess = str(b.guess, 10);
    return text && guess ? { lang: str(b.lang, 20), guess, text } : undefined;
  }).map((b) => ({ ref: next(), ...b }));
  const structureCandidates = list(r.structure, PAGE_TEXT_LIMITS.structureCandidates, (s) => {
    const looksLike = s.looksLike === 'list' ? 'list' as const : s.looksLike === 'heading' ? 'heading' as const : undefined;
    const text = multiline(s.text, 300);
    return looksLike && text ? { looksLike, text } : undefined;
  }).map((s) => ({ ref: next(), ...s }));
  return { title, lang: str(r.lang, 20), headings, links, controls, sensoryCandidates, langBlocks, structureCandidates };
}

/** Number of items a model can comment on (the title counts when it is not empty). */
export function pageTextItemCount(d: PageTextData): number {
  return (d.title.text ? 1 : 0) + d.headings.length + d.links.length + d.controls.length +
    d.sensoryCandidates.length + d.langBlocks.length + d.structureCandidates.length;
}

/** Text-only page content for the AI page text review (desktop). Input for `pageText`. */
export const pageTextCollector: PageCollector<PageTextData> = {
  id: 'pageText',
  viewport: 'desktop',
  async collect(page) {
    return toPageTextData(await page.evaluate(collectPageText, undefined));
  },
};
