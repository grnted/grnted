// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.3.4 Orientation (Plan 4 Task 4.2): the page on a phone in portrait and in landscape; content
// locked to one orientation is failed. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { excerpt, stoppedSince } from './layout.js';
import { ProbeNotTestable, type PageProbe } from './types.js';

export const PORTRAIT = { width: 390, height: 844 } as const;
export const LANDSCAPE = { width: 844, height: 390 } as const;

/** What the page shows in one orientation. */
export interface OrientationFacts {
  /** Characters of rendered text on the page (`innerText`, whitespace collapsed). */
  text: number;
  /** The main landmark (or the body when there is none): rendered, and its text length. */
  main: { found: boolean; visible: boolean; text: number; path: string };
  /** The largest visible element whose own text asks to rotate the device, if any. */
  rotate?: { text: string; path: string; cover: number };
  /** Rotation (degrees, -180..180) of a CSS transform on html, body, the main landmark or a direct child of body. */
  rotation: number;
  rotatedPath?: string;
  /**
   * With a rotate message: characters of text in content that is hidden beside it now, in its own part of the
   * page (`hiddenBeside`). The elements are kept in the page so the other orientation can say whether it shows them.
   */
  swapped?: number;
  /** Characters of the content the other orientation hid beside its rotate message that are shown now. */
  shownOfOther?: number;
  /** Form fields of the content the other orientation hid beside its rotate message that are shown now. */
  fieldsOfOther?: number;
  /** What the content hidden beside the message is made of (`swapped`), for telling general page content from a presentation. */
  swapKind?: SwapKind;
  /**
   * Characters of that hidden content that are shown in this same orientation on a larger screen (set by the test
   * when it looked): evidence that the content does not need the other orientation.
   */
  shownElsewhere?: number;
  /**
   * Blocks of general page content shown now in the main content: running text (a paragraph, a list item, a table
   * cell) and forms, outside the page's own regions and outside anything laid out as a picture of a thing.
   */
  general?: number;
  /** Of the general blocks the other orientation shows: how many there are, and how many are not shown now. */
  generalOfOther?: { had: number; hidden: number };
}

/** What content hidden behind a rotate message is made of. */
export interface SwapKind {
  /** Characters in blocks of running text (a paragraph, a list item, a table cell of at least 40 characters with spaces). */
  prose: number;
  /** All its characters. */
  total: number;
  /** Form fields in it. */
  fields: number;
  /**
   * It is, or holds, something laid out as a picture of a thing: an image, a canvas, a video, a figure, an element
   * with an image or application role, parts placed absolutely, or a box of a fixed size or shape.
   */
  presentation: boolean;
}

/** "Rotate your device", "turn your phone", "best viewed in landscape", "portrait mode only"… */
export const ROTATE_MESSAGE = /\b(?:rotate|turn)\s+(?:your|the)\s+(?:device|phone|screen|tablet|mobile)\b|\b(?:switch|change)\s+to\s+(?:landscape|portrait)\b|\b(?:best\s+)?viewed?\s+in\s+(?:landscape|portrait)\b|\b(?:landscape|portrait)\s+(?:mode|orientation)\s+(?:only|required|is\s+required|please)\b|\bplease\s+use\s+(?:landscape|portrait)\b|\bonly\s+(?:works|available)\s+in\s+(?:landscape|portrait)\b/i;

/** Runs in the page (self-contained): what the page shows in the current orientation. */
export function orientationFacts(pattern: string): OrientationFacts {
  const re = new RegExp(pattern, 'i');
  const body = document.body ?? document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clean = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim();
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s);
  const cssPath = (el: Element): string => {
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && document.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(cur.localName); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${cur.localName}:nth-of-type(${same.indexOf(cur) + 1})` : cur.localName);
    }
    return parts.join(' > ');
  };
  const shown = (el: Element) => {
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 1 && r.height > 1;
  };
  const textLen = (el: HTMLElement) => clean(el.innerText).length;
  const mainEl = document.querySelector('main, [role="main"]') as HTMLElement | null;
  const target = mainEl ?? (body as HTMLElement);
  const mainVisible = shown(target);
  const facts: OrientationFacts = {
    text: textLen(body as HTMLElement),
    main: { found: !!mainEl, visible: mainVisible, text: mainVisible ? textLen(target) : 0, path: cssPath(target) },
    rotation: 0,
  };
  // A visible message asking to rotate: the element whose own text matches, and how much of the screen it covers.
  let best: OrientationFacts['rotate'];
  let bestCover: Element | null = null;
  const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT);
  const tried = new Set<Element>();
  let seen = 0;
  for (let n = walker.nextNode(); n && seen < 5000; n = walker.nextNode(), seen++) {
    const p = n.parentElement;
    if (!p || tried.has(p) || /^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(p.tagName)) continue;
    tried.add(p);
    // The message can be split over inline elements: try the parent, then its parent while short.
    let block: HTMLElement | null = null;
    for (let a: Element | null = p, k = 0; a && a !== document.documentElement && k < 2; a = a.parentElement, k++) {
      const text = clean(a.textContent);
      if (text.length > 400) break;
      if (re.test(text)) { block = a as HTMLElement; break; }
    }
    if (!block || !shown(p)) continue;
    const t = clean(block.innerText) || clean(block.textContent);
    if (!re.test(t)) continue;
    // The covering box: the largest shown ancestor up to body that still holds this message as most of its text.
    let cover = block as Element;
    for (let a = block.parentElement; a && a !== body && a !== document.documentElement; a = a.parentElement) {
      if (!shown(a) || clean((a as HTMLElement).innerText).length > t.length * 2 + 40) break;
      cover = a;
    }
    const r = cover.getBoundingClientRect();
    const area = Math.max(0, Math.min(r.right, vw) - Math.max(r.left, 0)) * Math.max(0, Math.min(r.bottom, vh) - Math.max(r.top, 0));
    const share = Math.round((area / Math.max(1, vw * vh)) * 100) / 100;
    if (!best || share > best.cover) { best = { text: t.slice(0, 120), path: cssPath(cover), cover: share }; bestCover = block; }
  }
  if (best) facts.rotate = best;
  // Content the message stands in for (F100): elements hidden now beside the message's own element, in its
  // part of the page (its siblings, then its parent's and grandparent's, never the page's own regions: header,
  // footer, navigation, which collapse behind a menu button on a narrow screen). They are kept under this
  // orientation's name; the other orientation then says how much of them it shows.
  const name = window.innerWidth > window.innerHeight ? 'landscape' : 'portrait';
  const kept = ((window as unknown as { __grntedOrientation?: Record<string, Element[]> }).__grntedOrientation ??= { portrait: [], landscape: [] });
  const REGION = 'nav, header, footer, aside, dialog, [role="navigation"], [role="banner"], [role="contentinfo"], [role="menu"], [role="dialog"]';
  const FIELDS = 'input:not([type="hidden"]), select, textarea';
  const hiddenBeside = (message: Element): Element[] => {
    let child = message;
    for (let a = message.parentElement, level = 0; a && a !== body && a !== document.documentElement && level < 3; child = a, a = a.parentElement, level++) {
      // Hidden content: some text, or a form (its fields say little in words).
      const found = [...a.children].filter((sib) => sib !== child && !/^(SCRIPT|STYLE|NOSCRIPT|TEMPLATE)$/.test(sib.tagName) && !sib.matches(REGION) && !shown(sib)
        && (clean(sib.textContent).length >= 40 || sib.querySelectorAll(FIELDS).length >= 2));
      if (found.length) return found;
    }
    return [];
  };
  const hidden = bestCover ? hiddenBeside(bestCover) : [];
  kept[name] = hidden;
  if (hidden.length) {
    facts.swapped = hidden.reduce((n, el) => n + clean(el.textContent).length, 0);
    const PRESENTATION = 'img, svg, canvas, video, object, embed, iframe, figure, [role="img"], [role="application"], [role="figure"], [aria-roledescription]';
    const PROSE = 'p, li, dd, td, th, blockquote';
    const kind = { prose: 0, total: facts.swapped, fields: 0, presentation: false };
    for (const el of hidden) {
      if (el.matches(PRESENTATION) || el.querySelector(PRESENTATION)) kind.presentation = true;
      for (const d of [el, ...el.querySelectorAll('*')].slice(0, 300)) {
        const st = getComputedStyle(d);
        if (st.position === 'absolute' || st.position === 'fixed' || (st.aspectRatio && st.aspectRatio !== 'auto') || (/px$/.test(st.width) && /px$/.test(st.height) && d.children.length > 0)) kind.presentation = true;
        if (d.matches('input:not([type="hidden"]), select, textarea')) kind.fields++;
      }
      const blocks = el.matches(PROSE) ? [el] : [...el.querySelectorAll(PROSE)].filter((b) => !b.querySelector(PROSE));
      for (const b of blocks) {
        const t = clean(b.textContent);
        if (t.length >= 40 && /\s/.test(t)) kind.prose += t.length;
      }
    }
    facts.swapKind = kind;
  }
  // General page content shown now (review r2, finding 5): blocks of running text and forms in the main content,
  // outside the page's own regions and outside anything laid out as a picture of a thing (a figure, a drawing,
  // parts placed absolutely). They are kept under this orientation's name; the other orientation then says how
  // many of them it does not show. That, never an amount of text, is the evidence that what an orientation hides
  // is general content.
  const PICTURE = 'figure, svg, canvas, [role="img"], [role="application"], [role="figure"], [aria-roledescription]';
  const BLOCKS = 'p, li, dd, td, th, blockquote';
  const placed = (el: Element) => {
    for (let a: Element | null = el, k = 0; a && a !== target && k < 8; a = a.parentElement, k++) {
      const pos = getComputedStyle(a).position;
      if (pos === 'absolute' || pos === 'fixed') return true;
    }
    return false;
  };
  const general: Element[] = [];
  if (mainVisible) {
    for (const b of target.querySelectorAll(BLOCKS)) {
      if (general.length >= 200) break;
      if (b.querySelector(BLOCKS) || b.closest(REGION) || b.closest(PICTURE)) continue;
      const t = clean(b.textContent);
      if (t.length < 40 || !/\s/.test(t) || re.test(t) || !shown(b) || placed(b)) continue;
      general.push(b);
    }
    for (const form of target.querySelectorAll('form')) {
      if (!form.closest(REGION) && !form.closest(PICTURE) && [...form.querySelectorAll(FIELDS)].filter(shown).length >= 2) general.push(form);
    }
  }
  kept[`general-${name}`] = general;
  facts.general = general.length;
  const otherGeneral = kept[`general-${name === 'portrait' ? 'landscape' : 'portrait'}`] as Element[] | undefined;
  if (otherGeneral) facts.generalOfOther = { had: otherGeneral.length, hidden: otherGeneral.filter((el) => !el.isConnected || !shown(el)).length };
  const others = kept[name === 'portrait' ? 'landscape' : 'portrait'] ?? [];
  if (others.length) {
    const seen = others.filter((el) => el.isConnected && shown(el));
    facts.shownOfOther = seen.reduce((n, el) => n + clean((el as HTMLElement).innerText).length, 0);
    facts.fieldsOfOther = seen.reduce((n, el) => n + [...el.querySelectorAll(FIELDS)].filter(shown).length, 0);
  }
  // A CSS transform that turns the page by about 90 degrees.
  const candidates: Element[] = [document.documentElement, body, ...(mainEl ? [mainEl] : []), ...[...body.children].slice(0, 20)];
  for (const el of candidates) {
    const m = getComputedStyle(el).transform;
    const match = /^matrix\(([^,]+),\s*([^,]+),/.exec(m);
    if (!match) continue;
    const deg = Math.round((Math.atan2(parseFloat(match[2]!), parseFloat(match[1]!)) * 180) / Math.PI);
    if (Math.abs(deg) > Math.abs(facts.rotation)) {
      facts.rotation = deg;
      facts.rotatedPath = cssPath(el);
    }
  }
  return facts;
}

/**
 * Runs in the page (self-contained): of the content one orientation hid beside its rotate message (kept by
 * `orientationFacts` under that orientation's name), the characters that are shown now.
 */
export function keptShown(name: 'portrait' | 'landscape'): number {
  const kept = (window as unknown as { __grntedOrientation?: Record<string, Element[]> }).__grntedOrientation?.[name] ?? [];
  let n = 0;
  for (const el of kept) {
    if (!el.isConnected) continue;
    if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 1 && r.height > 1) n += ((el as HTMLElement).innerText ?? '').replace(/\s+/g, ' ').trim().length;
  }
  return n;
}

/**
 * Thresholds: text hidden in one orientation (share of the other), a rotate message covering the screen, the
 * least text (characters) a rotate message must stand in for to count whatever its size (`swapText`), and what
 * makes the content behind it general page content (`proseShare` of its own text in running text, `fields` form
 * fields). These say what is LOOKED at; whether it fails is decided by the kind of content, never by an amount
 * of text (review r2, finding 5).
 */
export const ORIENTATION_LIMITS = { minText: 200, hiddenShare: 0.3, minMainText: 100, mainHiddenShare: 0.2, cover: 0.5, swapText: 80, proseShare: 0.8, fields: 2 } as const;

/** The same orientation on a larger screen (a tablet), where the test looks for the content a phone hides behind its rotate message. */
export const LARGER = { portrait: { width: 820, height: 1180 }, landscape: { width: 1180, height: 820 } } as const;

/**
 * WCAG 1.3.4 lets content require one orientation when that orientation is essential ("a bank check, a piano
 * application, slides for a projector or television, or virtual reality content"). A rotate message that stands
 * in for PART of a page is a failure only with evidence that the part does not need the orientation:
 * - 'general': it is general page content, with nothing in it laid out as a picture of a thing: a form (at least
 *   two fields), or running text (at least 80 characters, at least 80% of it in paragraphs, list items or table
 *   cells);
 * - 'elsewhere': the same content is shown in the blocked orientation on a larger screen.
 * Without either it is not decided. How much of the page's text it holds never decides it (review r2, finding 5):
 * a check may hold most of a short page's words and still need its orientation.
 */
export function swapEvidence(f: OrientationFacts, other: OrientationFacts): 'general' | 'elsewhere' | null {
  const L = ORIENTATION_LIMITS;
  const k = f.swapKind;
  void other;
  if (k && !k.presentation && (k.fields >= L.fields || (k.prose >= L.swapText && k.prose >= L.proseShare * k.total))) return 'general';
  if ((f.shownElsewhere ?? 0) >= L.swapText) return 'elsewhere';
  return null;
}

/**
 * The content a rotate message in `f` stands in for, when it is hidden here and shown in the other orientation
 * (where the message is not): at least 80 characters of text, or a form of at least two fields. Null otherwise.
 */
export function swapOf(f: OrientationFacts, other: OrientationFacts): { text: number; fields: number } | null {
  const L = ORIENTATION_LIMITS;
  if (!f.rotate || other.rotate) return null;
  const text = (f.swapped ?? 0) >= L.swapText && (other.shownOfOther ?? 0) >= L.swapText ? other.shownOfOther! : 0;
  const fields = (f.swapKind?.fields ?? 0) >= L.fields && (other.fieldsOfOther ?? 0) >= L.fields ? other.fieldsOfOther! : 0;
  return text || fields ? { text, fields } : null;
}

/** The orientation whose rotate message stands in for content that no evidence yet shows to be general: the test then looks on a larger screen. */
export function undecidedSwap(portrait: OrientationFacts, landscape: OrientationFacts): 'portrait' | 'landscape' | null {
  const open = (f: OrientationFacts, other: OrientationFacts) => swapOf(f, other) !== null && swapEvidence(f, other) === null;
  return open(portrait, landscape) ? 'portrait' : open(landscape, portrait) ? 'landscape' : null;
}

const quarterTurn = (deg: number) => Math.abs(Math.abs(deg) - 90) <= 10;

/**
 * Compares the two orientations. In one orientation (and not the other) the page is failed when:
 * - it is turned by a quarter turn with a CSS transform (a CSS orientation lock);
 * - most of its text is hidden (less than 30% of the other orientation's, which has at least 200
 *   characters), or the main content is hidden or nearly empty (less than 20%), AND general page content is
 *   among what is hidden (blocks of running text or forms the other orientation shows: `generalOfOther`);
 *   without that the page is not testable, never failed on the amount of text alone;
 * - a message asking to rotate the device covers at least half of the screen of a page that shows general
 *   content in the other orientation;
 * - a message asking to rotate the device stands in for part of the page (F100): content beside it is hidden
 *   here (at least 80 characters) and shown in the other orientation, where the message is not, AND there is
 *   evidence that the content does not need that orientation (`swapEvidence`). Without the evidence the page is
 *   not testable for 1.3.4 (the orientation may be essential), never failed.
 * A message that covers the screen on a page with little text (an application, a game) is not decided either.
 * A rotate hint that leaves the content in place and covers less of the screen is not counted.
 */
export function orientationFindings(portrait: OrientationFacts, landscape: OrientationFacts): ProbeFinding[] {
  const L = ORIENTATION_LIMITS;
  const out: ProbeFinding[] = [];
  const check = (name: string, f: OrientationFacts, other: OrientationFacts, otherName: string) => {
    const reasons: string[] = [];
    let target: string | undefined;
    if (quarterTurn(f.rotation) && !quarterTurn(other.rotation)) {
      reasons.push(`the page is turned ${f.rotation}° with a CSS transform`);
      target = f.rotatedPath;
    }
    // What this orientation hides is general page content when blocks of running text or forms that the other
    // orientation shows are not shown here. Without that, hidden text may be content that needs its orientation:
    // it is noted (`open`) and never failed on its amount (review r2, finding 5).
    const generalHidden = (f.generalOfOther?.hidden ?? 0) > 0;
    const open: string[] = [];
    if (other.text >= L.minText && f.text < L.hiddenShare * other.text) {
      (generalHidden ? reasons : open).push(`most of its text is hidden (${f.text} characters shown, ${other.text} in ${otherName})`);
    } else if (other.main.visible && other.main.text >= L.minMainText && (!f.main.visible || f.main.text < L.mainHiddenShare * other.main.text)) {
      (generalHidden ? reasons : open).push(`its main content is ${f.main.visible ? 'nearly empty' : 'hidden'} (${f.main.text} characters shown, ${other.main.text} in ${otherName})`);
      if (generalHidden) target ??= f.main.path;
    }
    const msg = f.rotate && !other.rotate ? f.rotate : undefined;
    const size = `${name === 'portrait' ? `${PORTRAIT.width}×${PORTRAIT.height}` : `${LANDSCAPE.width}×${LANDSCAPE.height}`} px`;
    // F100: the message stands in for content that is hidden beside it here and shown in the other orientation.
    const swap = msg ? swapOf(f, other) : null;
    const swapped = swap ? (swap.text ? `${swap.text} characters` : `a form with ${swap.fields} fields`) : '';
    const evidence = swap ? swapEvidence(f, other) : null;
    const replaced = evidence ? swapped : '';
    // A message over the screen blocks general content only when the other orientation shows some (a page that is one
    // application, or one picture of a thing, may need its orientation), and when it does not stand in for one part
    // of the page that is still undecided.
    const covers = !!msg && msg.cover >= L.cover && (reasons.length > 0 || !!replaced || ((other.general ?? 0) > 0 && !swap));
    if (msg && (covers || reasons.length || replaced)) {
      reasons.push(`it shows “${excerpt(msg.text, 80)}”${msg.cover >= L.cover ? ` over ${Math.round(msg.cover * 100)}% of the screen` : ''}${
        replaced ? ` in place of content shown in ${otherName} (${replaced}${evidence === 'elsewhere' ? `; the same content is shown in ${name} on a larger screen` : ''})` : ''}`);
      target ??= msg.path;
    }
    if (!reasons.length) {
      // Content behind a rotate message with no evidence either way, a covered page with no general content, or
      // hidden text that is not shown to be general content: the orientation may be essential.
      const ESSENTIAL = '(WCAG allows an orientation that is essential, as for a bank check or a piano keyboard)';
      if (msg && (swapped || msg.cover >= L.cover)) {
        out.push({
          criterion: '1.3.4', status: 'not_testable', target: msg.path,
          detail: `On a phone in ${name} (${size}), the page shows “${excerpt(msg.text, 80)}”${swapped ? ` in place of content shown in ${otherName} (${swapped})` : ` over ${Math.round(msg.cover * 100)}% of the screen`}; `
            + `whether that content needs ${otherName} could not be told ${ESSENTIAL}`,
        });
      } else if (open.length) {
        out.push({
          criterion: '1.3.4', status: 'not_testable', ...(f.main.path ? { target: f.main.path } : {}),
          detail: `On a phone in ${name} (${size}), ${open.join('; ')}; whether what is hidden needs ${otherName} could not be told ${ESSENTIAL}`,
        });
      }
      return;
    }
    out.push({
      criterion: '1.3.4', status: 'failed', ...(target ? { target } : {}),
      detail: `On a phone in ${name} (${size}), ${reasons.join('; ')}, so the content only works in ${otherName}`,
    });
  };
  check('portrait', portrait, landscape, 'landscape');
  check('landscape', landscape, portrait, 'portrait');
  return out;
}

/**
 * How long the page settles after each turn before it is read (a script that changes the page some
 * time after the turn, up to about 1.5 s, is seen by then), and the most landscape/portrait rounds.
 */
export const ORIENTATION_SETTLE_MS = 1600;
export const ORIENTATION_ROUNDS = 3;

/**
 * Two readings of one orientation show the same page: the same amount of text (within 5%, or 20
 * characters), the main content shown or hidden alike, the same turn and the same rotate message.
 */
export function sameFacts(a: OrientationFacts, b: OrientationFacts): boolean {
  const near = (x: number, y: number) => Math.abs(x - y) <= Math.max(20, 0.05 * Math.max(x, y));
  return near(a.text, b.text) && a.main.visible === b.main.visible && near(a.main.text, b.main.text)
    && quarterTurn(a.rotation) === quarterTurn(b.rotation) && !!a.rotate === !!b.rotate;
}

/** The equal-width shapes (atlas D3): the phone's width in a landscape shape, the landscape width in a portrait shape. */
export const EQUAL_WIDTH = { landscape: { width: PORTRAIT.width, height: 300 }, portrait: { width: LANDSCAPE.width, height: 1100 } } as const;

/** Which orientation a 1.3.4 finding of `orientationFindings` is about (its detail names it first). */
const findingSide = (f: ProbeFinding): 'portrait' | 'landscape' | null => (/^On a phone in portrait/.test(f.detail) ? 'portrait' : /^On a phone in landscape/.test(f.detail) ? 'landscape' : null);

/**
 * Atlas D3 (pure): of the failures found between the phone's two shapes, those whose orientation also fails when the
 * width is held: in `narrow` (portrait = the phone's portrait reading, landscape = the same width in a landscape
 * shape) or in `wide` (portrait = the landscape width in a portrait shape, landscape = the phone's landscape reading).
 * A failure not seen at either width follows the width (a breakpoint): it becomes a clean result with that reason.
 */
export function confirmOrientation(findings: readonly ProbeFinding[], narrow: readonly ProbeFinding[] | null, wide: readonly ProbeFinding[] | null): ProbeFinding[] {
  const failedSides = (list: readonly ProbeFinding[] | null) => new Set((list ?? []).filter((f) => f.status === 'failed').map(findingSide));
  const n = failedSides(narrow);
  const w = failedSides(wide);
  return findings.map((f) => {
    if (f.status !== 'failed') return f;
    const side = findingSide(f);
    if (side && (n.has(side) || w.has(side))) return f;
    if (!narrow || !wide) {
      return { ...f, status: 'not_testable' as const, detail: `${f.detail}; the same difference could not be checked at one width (turning a phone also changes its width), so whether it follows the orientation is not known` };
    }
    return { criterion: '1.3.4', status: 'no_failures_found' as const, ...(f.target ? { target: f.target } : {}), detail: `what differs between portrait and landscape on a phone does not differ when the width stays the same (${EQUAL_WIDTH.landscape.width} px wide in both shapes, and ${EQUAL_WIDTH.portrait.width} px wide in both): it follows the screen's width, not its orientation` };
  });
}

async function confirmAtEqualWidth(
  ctx: Parameters<PageProbe['run']>[0],
  setSize: (s: { width: number; height: number }) => Promise<void>,
  read: () => Promise<OrientationFacts>,
  portrait: OrientationFacts,
  landscape: OrientationFacts,
  findings: ProbeFinding[],
): Promise<ProbeFinding[]> {
  let narrow: ProbeFinding[] | null = null;
  let wide: ProbeFinding[] | null = null;
  try {
    if (!ctx.signal.aborted && Date.now() + ORIENTATION_SETTLE_MS + 1000 < ctx.deadline) {
      await setSize({ ...EQUAL_WIDTH.landscape });
      narrow = orientationFindings(portrait, await read());
    }
    if (!ctx.signal.aborted && Date.now() + ORIENTATION_SETTLE_MS + 1000 < ctx.deadline) {
      await setSize({ ...EQUAL_WIDTH.portrait });
      wide = orientationFindings(await read(), landscape);
    }
  } catch {
    // Unread: the failure is not confirmed.
  } finally {
    await setSize({ ...ctx.viewport }).catch(() => {});
  }
  return confirmOrientation(findings, narrow, wide);
}

/**
 * Loads the page in a phone context (390×844, `isMobile`, `hasTouch`), turns it to landscape
 * (844×390: the screen orientation, `orientationchange` and the orientation media queries follow) and
 * back, and reads each orientation 1.6 s after each turn. It goes on, up to three rounds, until each
 * orientation has read the same twice in a row (every read taken at the same settle), and compares the
 * latest reading of each. A page that still reads differently when the rounds or the time run out is
 * not testable: an unsettled pair is never compared. The axe rule `css-orientation-lock` also tests
 * 1.3.4. A page that goes to another address when it is turned is not_testable; so is a clean result
 * after the request guard blocked a request.
 */
export const orientationProbe: PageProbe = {
  id: 'orientation',
  criteria: ['1.3.4'],
  // Compares portrait with landscape: never an empty shell with a mounted page (gold hazard late mount).
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  // 15 s, plus two equal-width reads (atlas D3) when a failure is found to confirm.
  timeoutMs: 19_000,
  viewport: { ...PORTRAIT },
  contextOptions: { isMobile: true, hasTouch: true },
  async run(ctx): Promise<ProbeFinding[]> {
    const page = ctx.page;
    if (!page.setViewportSize) throw new ProbeNotTestable('the browser cannot change the viewport size, which this test needs');
    const setSize = page.setViewportSize.bind(page);
    const mark = ctx.guard.mark();
    const read = async () => {
      await page.waitForTimeout(ORIENTATION_SETTLE_MS);
      return page.evaluate(orientationFacts, ROTATE_MESSAGE.source);
    };
    let portrait: OrientationFacts | undefined;
    let landscape: OrientationFacts | undefined;
    let steady = false;
    let outOfTime = false;
    try {
      for (let round = 0; round < ORIENTATION_ROUNDS; round++) {
        if (ctx.signal.aborted || Date.now() + 2 * ORIENTATION_SETTLE_MS + 1000 > ctx.deadline) { outOfTime = true; break; }
        const lastLandscape = landscape;
        const lastPortrait = portrait;
        await setSize({ ...LANDSCAPE });
        landscape = await read();
        await setSize({ ...ctx.viewport });
        portrait = await read();
        steady = !!lastLandscape && !!lastPortrait && sameFacts(lastLandscape, landscape) && sameFacts(lastPortrait, portrait);
        if (steady) break;
      }
    } finally {
      await setSize({ ...ctx.viewport });
    }
    const stopped = stoppedSince(ctx.guard, mark);
    if (stopped?.navigation) throw new ProbeNotTestable(stopped.reason);
    if (!steady || !portrait || !landscape) {
      throw new ProbeNotTestable(outOfTime
        ? 'the time for this test ran out before each orientation had been read the same twice, so the two could not be compared'
        : 'the page kept changing while it was turned between portrait and landscape, so the two could not be compared');
    }
    if (portrait.text === 0 && landscape.text === 0) {
      if (stopped) throw new ProbeNotTestable(stopped.reason);
      return [{ criterion: '1.3.4', status: 'not_applicable', detail: 'no visible text on the page in either orientation' }];
    }
    // A rotate message in place of part of the page, with nothing yet to show that the part is general content: the
    // same orientation on a larger screen (one more turn). The content showing there is the evidence.
    const open = undecidedSwap(portrait, landscape);
    if (open && !ctx.signal.aborted && Date.now() + ORIENTATION_SETTLE_MS + 1500 < ctx.deadline) {
      try {
        await setSize({ ...LARGER[open] });
        await page.waitForTimeout(ORIENTATION_SETTLE_MS);
        const shown = await page.evaluate(keptShown, open);
        (open === 'portrait' ? portrait : landscape).shownElsewhere = shown;
      } catch {
        // Without the larger screen the swap stays undecided.
      } finally {
        await setSize({ ...ctx.viewport }).catch(() => {});
      }
    }
    let findings = orientationFindings(portrait, landscape);
    // Fix round (atlas D3, Sol S10): turning a phone changes its width as well as its orientation, so a difference
    // between 390×844 and 844×390 may be a width breakpoint (content a narrow screen hides and a wide one shows, with
    // or without a rotate tip). A failure stands only when the same difference shows at one width: the phone's width
    // in a landscape shape, or the landscape width in a portrait shape. Otherwise it follows the width, not the
    // orientation: no failure. Not confirmed in the time left: not testable.
    if (findings.some((f) => f.status === 'failed')) findings = await confirmAtEqualWidth(ctx, setSize, read, portrait, landscape, findings);
    const after = stoppedSince(ctx.guard, mark);
    if (after?.navigation) throw new ProbeNotTestable(after.reason);
    if (after && !findings.some((f) => f.status === 'failed')) throw new ProbeNotTestable(after.reason);
    return findings;
  },
};
