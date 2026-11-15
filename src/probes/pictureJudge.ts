// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the picture test decides from what it read and measured (pure; docs/scoring.md, "Pictures and the words they
// draw"). Every failure is a measurement a person can repeat: the words are the file's own text elements, each word
// shown to be drawn (its ink), and "what the page gives" is the page's own text. A pattern only chooses what is
// measured. What cannot be shown either way is left open ("not testable"), never failed and never called clean.
//
// The decisions, each only for an SVG file shown as a picture whose words were measured one by one, that is shown
// whole where it stands (its place, its size and what cuts it are worked out), with nothing over part of its words:
// - 1.4.5 (image of text): the picture is a block of text and nothing else: five words or more, in lines set one
//   under the other on a common edge or centre, on one plain ground (or a title band over a body). A logo, a
//   CAPTCHA, a picture said to be a sample of how something looks (a typeface, a signature, a screenshot, an
//   example) or a placeholder, a picture with a drawing of its own (a map, a chart, boxes or bars with words in
//   them), words scattered as labels, a line of four words or fewer, and one or two short lines that are no
//   sentence and are named word for word by the alternative (a name, a title, a logo with its motto) are never
//   failed here (the AI review's to judge).
// - 1.1.1 (information only in a picture), for a picture outside links and buttons. Words that match show that a
//   text gives a picture's words; words that do not match show less (the same thing can be said in other words,
//   with a date or a number written another way, or in another language). So:
//   - the picture's own texts (its alternative, title, description, caption) are never judged by their words: one
//     is ruled out only when it is empty, a file name, the name of a kind of picture ("Map") or a label too short
//     to give the picture's words (a third of their number or fewer). One of about their length that does not
//     match them may say them another way: left open, never failed;
//   - the page's text gives under half of the words (a line counts as given when more than half of its words
//     stand together in one text; numbers, dates and times are compared however they are written), AND more than
//     half of the words are in lines no text shares even a part of (a third of the line's words and numbers
//     anywhere on the page, a quarter next to the picture). A line some text shares that much with may be said
//     there another way: it is left out of the count, and a picture short of the count is left open;
//   - the text beside the picture is too short to give those words in other words: no block of its section of the
//     page (from the heading before it to the next heading; never text set apart from the content, as the site's
//     footer is) has four words that count and more than a third of their number. A sentence beside a picture may
//     say what it says in words this test cannot match (synonyms, another language): left open;
//   - the page's text is all there (nothing cut or left unread) and in one language, and the picture's words show
//     that language (a function word, a short word, the name of a day or a month).
//   The rules: `block` (the picture is a block of text), `hidden` (it is kept from screen readers and draws a
//   statement: a line of five words or more among eight or more; the same file is not shown elsewhere with an
//   alternative), `kind` (its alternative only names the kind of picture or is a file name, and it draws a
//   statement), `background` (a CSS background, which has no alternative, on an element with no text or name).
// Engine core: no Node-only imports.
import { contentWords, languageCounts, languageSigns, textWords } from '../textWords.js';
import type { ProbeFinding } from '../types.js';
import type { BackgroundLayout, FlatRegion, Picture, PicturesRead, SvgMeasure, SvgMeasured, SvgMeasureError } from './pictureText.js';

export const PICTURE_RULES = {
  /** Pixels an element's removal must change to count as drawn. */
  drawnInk: 12,
  /** Words a block of text has at least; fewer may be a name, a logo or a label. */
  blockWords: 5,
  /** One or two lines of at most this many words, no sentence, named word for word by the alternative: a name too. */
  nameWords: 12,
  /** Words in one text element that make it a statement (a clause, not a label). */
  statementWords: 5,
  /** Words a picture with a statement draws at least, for the hidden and kind rules. */
  statementPictureWords: 8,
  /** Lines share an edge or a centre within this share of the width (at least 6 px). */
  alignShare: 0.025,
  /** Two runs of ink on one row are one line when the gap is at most this many line heights. */
  sameLineGap: 1.5,
  /** Other drawing a block of text may have: at most this share of the words' ink, and of the picture. */
  otherToText: 0.25,
  otherShare: 0.02,
  /** Grounds with words on them: one, or two of one width set one right under the other (a title band and a body). */
  grounds: 2,
  /** The smallest line height, in CSS px as shown, at which the words are text people read. */
  legiblePx: 6,
  /** A line is given when more than this share of its words stand together; a picture when this share of its words are given. */
  lineGiven: 0.5,
  pictureGiven: 0.5,
  /** Text blocks in a row that may give one line (a term and its value, the cells of a row). */
  blockWindow: 3,
  /** The share of the shown words' glyphs that must show in the picture: under it, part of a word is covered or cut. */
  seenShare: 0.98,
  /** The share of a picture's box that its containers must leave showing. */
  showingShare: 0.98,
  /**
   * A text may give a line in other words when it shares this many of its words or numbers with it and this share
   * of them; next to the picture one word or number is enough, with a quarter of them (`nearShare`).
   */
  possibleWords: 2,
  possibleShare: 1 / 3,
  nearShare: 1 / 4,
  /** Blocks of text before and after a picture that are next to it. */
  nearBlocks: 2,
  /** An alternative with this share of the picture's words or fewer is a label: it cannot give them. */
  labelShare: 1 / 3,
  /** A failure needs more than this share of the picture's words in lines no text may give. */
  absentShare: 0.5,
  /**
   * The text beside a picture (a block of its section of the page, or the block before it and the block after it
   * together) may give its words in other words when it has at least this many words that count, and more than
   * this share of the number of the words not given (the share under which one of the picture's own texts is a
   * label: `labelShare`).
   */
  besideWords: 4,
  besideShare: 1 / 3,
} as const;

/** One text element that is drawn, as compared. */
export interface DrawnLine {
  text: string;
  /** All its words (`textWords`), and the ones that can tell a text apart (`contentWords`). */
  words: string[];
  content: string[];
}

/** What a measured file draws, worked out once per file. */
export interface Drawn {
  lines: DrawnLine[];
  /** Words of the drawn text elements, and of what is not shown (elements that draw nothing, words kept out of sight). */
  words: number;
  hiddenWords: number;
  /** Text elements of five words or more. */
  statements: number;
  /** Line boxes on the canvas, same-row runs joined: [x0, y0, x1, y1]. */
  rows: [number, number, number, number][];
  /** Two texts stand side by side on one row (columns, labels across a drawing). */
  sideBySide: boolean;
  aligned: 'left' | 'centre' | 'right' | undefined;
  /** Ink that is neither the words nor their grounds, rules and frames. */
  otherInk: number;
  textInk: number;
  /** Grounds with words on them. */
  grounds: number;
  /** A block of text and nothing else. */
  block: boolean;
  /**
   * Why a picture that reads as a block may still be a drawing (the full-tree review's S3): its words sit on two or
   * more grounds of their own, one right under another. A title band over a body cannot be told from the touching
   * segments of a stacked bar, whose sizes say how much. Undefined when nothing leaves it open.
   */
  undecided?: string;
  /** Why it is not a block (the first reason), for the record. */
  notBlock?: string;
}

const inside = (inner: readonly number[], outer: readonly number[], slack = 0) =>
  inner[0]! >= outer[0]! - slack && inner[1]! >= outer[1]! - slack && inner[2]! <= outer[2]! + slack && inner[3]! <= outer[3]! + slack;

/** Ink of the drawing that is not a ground of the words, a rule, a frame, the surround of a card or a band across the picture. */
export function otherInk(m: Pick<SvgMeasure, 'width' | 'height' | 'regions' | 'restInk' | 'textInk'>): { ink: number; grounds: FlatRegion[] } {
  const W = m.width;
  const H = m.height;
  const hair = Math.max(4, Math.round(0.012 * Math.min(W, H)));
  const frame = Math.max(6, Math.round(0.02 * Math.min(W, H)));
  // A ground holds a real share of the words' ink: a frame or an edge a few letters touch is no ground of theirs.
  const held = Math.max(24, 0.02 * m.textInk);
  const grounds = m.regions.filter((r) => r.text >= held);
  let ink = m.restInk;
  for (const r of m.regions) {
    if (r.text >= held || r.clear) continue;
    const bw = r.box[2] - r.box[0] + 1;
    const bh = r.box[3] - r.box[1] + 1;
    // A rule, or the soft edge of a ground: a hairline at least half as long as the picture. Shorter hairlines are
    // drawing (the thin bars of a chart, ticks, the sides of small boxes).
    if (Math.min(bw, bh) <= hair) {
      if (bw >= bh ? bw >= 0.5 * W : bh >= 0.5 * H) continue;
      ink += r.n;
      continue;
    }
    const holds = grounds.some((g) => inside(g.box, r.box));
    if (holds && r.n <= 2 * (bw + bh) * frame) continue; // a frame around the words
    if (holds && r.box[0] <= 1 && r.box[1] <= 1 && r.box[2] >= W - 2 && r.box[3] >= H - 2) continue; // what a card stands on
    if (r.n >= 0.9 * bw * bh && (bw >= 0.95 * W || bh >= 0.95 * H)) continue; // a band across the whole picture
    ink += r.n;
  }
  return { ink, grounds };
}

/**
 * Whether the grounds the words sit on are those of a block of text: one ground, or two of one width set one right
 * under the other (a title band over a body). Words on a ground AND on shapes drawn on that ground (a title over
 * bars with labels in them), or on shapes of different widths or apart from one another (bars of a chart, boxes,
 * buttons), are words in a drawing: the shapes say something the words alone do not.
 */
export function plainGrounds(grounds: readonly FlatRegion[], width: number, height: number): boolean {
  if (grounds.length <= 1) return true;
  if (grounds.length > PICTURE_RULES.grounds) return false;
  if (grounds.some((g) => grounds.some((o) => o !== g && inside(o.box, g.box)))) return false;
  const [a, b] = [...grounds].sort((p, q) => p.box[1] - q.box[1]) as [FlatRegion, FlatRegion];
  const tolX = Math.max(6, 0.02 * width);
  const tolY = Math.max(6, 0.02 * height);
  return Math.abs(a.box[0] - b.box[0]) <= tolX && Math.abs(a.box[2] - b.box[2]) <= tolX && Math.abs(b.box[1] - a.box[3]) <= tolY;
}

/** What a measured file draws (pure). */
export function drawnOf(m: SvgMeasure): Drawn {
  const R = PICTURE_RULES;
  const each = m.texts.every((t) => t.ink >= 0);
  const drawn = m.texts.filter((t) => t.ink >= R.drawnInk && t.text.trim());
  const lines: DrawnLine[] = drawn.map((t) => ({ text: t.text, words: textWords(t.text), content: contentWords(t.text) }));
  const words = lines.reduce((n, l) => n + l.words.length, 0);
  const hiddenWords = m.texts.reduce((n, t) => n + (t.ink >= 0 && t.ink < R.drawnInk ? textWords(t.text).length : t.unseen ?? 0), 0);
  // Rows: every run of ink, same-row runs joined when they are close (words of one line), else side by side.
  const bands = drawn.flatMap((t) => t.bands).sort((a, b) => a[1] - b[1] || a[0] - b[0]);
  const rows: [number, number, number, number][] = [];
  let sideBySide = false;
  for (const b of bands) {
    let joined = false;
    for (const r of rows) {
      const overlap = Math.min(r[3], b[3]) - Math.max(r[1], b[1]) + 1;
      const h = Math.min(r[3] - r[1], b[3] - b[1]) + 1;
      if (overlap < 0.5 * h) continue;
      const gap = Math.max(r[0], b[0]) - Math.min(r[2], b[2]);
      if (gap <= R.sameLineGap * h) {
        r[0] = Math.min(r[0], b[0]); r[1] = Math.min(r[1], b[1]); r[2] = Math.max(r[2], b[2]); r[3] = Math.max(r[3], b[3]);
        joined = true;
      } else {
        sideBySide = true;
      }
      break;
    }
    if (!joined) rows.push([b[0], b[1], b[2], b[3]]);
  }
  const tol = Math.max(6, R.alignShare * m.width);
  const spread = (f: (r: readonly number[]) => number) => (rows.length ? Math.max(...rows.map(f)) - Math.min(...rows.map(f)) : Infinity);
  const aligned = spread((r) => r[0]!) <= tol ? 'left' : spread((r) => (r[0]! + r[2]!) / 2) <= tol ? 'centre' : spread((r) => r[2]!) <= tol ? 'right' : undefined;
  const other = otherInk(m);
  const notBlock = !each ? 'more text elements than are measured one by one'
    : words < R.blockWords ? 'fewer than five words'
    : sideBySide ? 'texts side by side'
    : rows.length > 1 && !aligned ? 'lines with no common edge or centre'
    : other.ink > R.otherToText * m.textInk || other.ink > R.otherShare * m.width * m.height ? 'a drawing besides the words'
    : !plainGrounds(other.grounds, m.width, m.height) ? 'words in shapes of their own'
    : undefined;
  const block = notBlock === undefined && rows.length > 0;
  const undecided = block && other.grounds.length >= 2 ? 'its words sit on two grounds of their own, one right under the other: a title band over a body cannot be told from the segments of a stacked bar' : undefined;
  return {
    lines, words, hiddenWords, statements: lines.filter((l) => l.words.length >= R.statementWords).length, rows, sideBySide, aligned,
    otherInk: other.ink, textInk: m.textInk, grounds: other.grounds.length, block, ...(notBlock ? { notBlock } : {}), ...(undecided ? { undecided } : {}),
  };
}

/**
 * A word as compared between a picture and the page's text: its plural, past or -ing ending taken off (English, the
 * commonest endings only), so "holds" gives "hold" and "closed" gives "closes". Both sides are compared this way, so
 * the rule can only make more of a picture's words count as given. Numbers and times stay as they are.
 */
export function wordStem(w: string): string {
  if (w.length < 5 || /\d/.test(w)) return w;
  if (w.endsWith('ies')) return `${w.slice(0, -3)}y`;
  if (w.endsWith('sses')) return w.slice(0, -2);
  if (w.endsWith('ing') && w.length >= 7) return w.slice(0, -3);
  if (w.endsWith('ed') && w.length >= 6) return w.slice(0, -2);
  if (w.endsWith('es') && w.length >= 6) return w.slice(0, -2);
  if (w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') && !w.endsWith('is')) return w.slice(0, -1);
  return w;
}
const stems = (text: string) => textWords(text).map(wordStem);

const MONTHS = [
  ['january', 'jan', 'enero', 'janvier'], ['february', 'feb', 'febrero', 'février', 'fevrier'], ['march', 'mar', 'marzo', 'mars'],
  ['april', 'apr', 'abril', 'avril'], ['may', 'mayo', 'mai'], ['june', 'jun', 'junio', 'juin'], ['july', 'jul', 'julio', 'juillet'],
  ['august', 'aug', 'agosto', 'août', 'aout'], ['september', 'sep', 'sept', 'septiembre', 'septembre'], ['october', 'oct', 'octubre', 'octobre'],
  ['november', 'nov', 'noviembre', 'novembre'], ['december', 'dec', 'diciembre', 'décembre', 'decembre'],
];
const DAYS = [
  ['monday', 'mon', 'lunes', 'lundi'], ['tuesday', 'tue', 'tues', 'martes', 'mardi'], ['wednesday', 'wed', 'miércoles', 'miercoles', 'mercredi'],
  ['thursday', 'thu', 'thur', 'thurs', 'jueves', 'jeudi'], ['friday', 'fri', 'viernes', 'vendredi'], ['saturday', 'sat', 'sábado', 'sabado', 'samedi'],
  ['sunday', 'sun', 'domingo', 'dimanche'],
];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];
/** Words that name a number, a month or a day, with what they share with the same thing written another way. */
const NAMED = new Map<string, string[]>();
MONTHS.forEach((names, i) => { for (const n of names) NAMED.set(n, [`@m${i + 1}`, `#${i + 1}`]); });
DAYS.forEach((names, i) => { for (const n of names) NAMED.set(n, [`@d${i + 1}`]); });
NUMBER_WORDS.forEach((n, i) => NAMED.set(n, [`#${i}`]));
NAMED.set('noon', ['#12']);
NAMED.set('midnight', ['#12']);

/**
 * What one word shares with the same thing said another way: the word without its ending when it can tell a text
 * apart, every number in it (the digits of a date or a time, however it is written: "November 13", "11/13";
 * "3 p.m.", "15:00"), and the month, the day or the small number it names ("Fri", "Friday", "viernes"; "three", "3").
 * Empty for a word that tells nothing apart (a function word, one or two letters).
 */
function keysOfWord(w: string, content: ReadonlySet<string>): string[] {
  const out: string[] = [];
  if (content.has(w)) out.push(wordStem(w));
  for (const run of w.match(/\d+/g) ?? []) out.push(`#${Number(run)}`);
  for (const k of NAMED.get(w) ?? NAMED.get(wordStem(w)) ?? []) out.push(k);
  return out;
}

/** The words of a text that could be found again in the same thing said another way, each with its keys (`keysOfWord`). */
export function wordGroups(text: string): string[][] {
  const content = new Set(contentWords(text));
  return textWords(text).map((w) => keysOfWord(w, content)).filter((g) => g.length);
}

/** Every key of a text's words (see `keysOfWord`). */
export function wordKeys(text: string): Set<string> {
  return new Set(wordGroups(text).flat());
}

/** The page's text as compared: each block's words, where each word is, and the language it is written in. */
export interface PageWords {
  /** Per block: every word without its ending, and its `wordKeys`. */
  blocks: Set<string>[];
  /** Per block: its text, how many of its words can tell a text apart (`contentWords`), and the place of the page it stands in (0: the content). */
  texts: readonly string[];
  sizes: number[];
  regions?: readonly number[];
  /** Per block: whether it is a heading (a heading starts a section of the page). */
  heads?: readonly boolean[];
  index: Map<string, number[]>;
  /** The language most of its function words are of (undefined for a page with next to no text). */
  lang?: string;
  /** A second language has a real share of the text: a picture's words may be given there, translated. */
  mixed: boolean;
}

export function pageWordIndex(blocks: readonly string[], regions?: readonly number[], heads?: readonly boolean[]): PageWords {
  const counts: Record<string, number> = {};
  const sizes = blocks.map((b) => contentWords(b).length);
  const sets = blocks.map((b) => {
    const ws = textWords(b);
    for (const [lang, n] of Object.entries(languageCounts(ws))) counts[lang] = (counts[lang] ?? 0) + n;
    const s = new Set(ws.map(wordStem));
    for (const k of wordKeys(b)) s.add(k);
    return s;
  });
  const index = new Map<string, number[]>();
  sets.forEach((s, i) => { for (const w of s) { const at = index.get(w); if (at) at.push(i); else index.set(w, [i]); } });
  const ranked = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  return {
    blocks: sets, texts: blocks, sizes, ...(regions ? { regions } : {}), ...(heads ? { heads } : {}), index,
    ...(top && top[1] >= 3 ? { lang: top[0] } : {}),
    mixed: !!top && !!second && second[1] >= Math.max(8, 0.25 * top[1]),
  };
}

/** One line of a picture against the texts that could give it. */
export interface LineCompared {
  text: string;
  /** Its content words (the weight it has in the picture's share). */
  weight: number;
  /** More than half of its words stand together in one text. */
  given: boolean;
  /** Not given, but a text shares enough with it to say it in other words. */
  possible: boolean;
}

/**
 * Each line of a picture against `sources` (the picture's own texts: its alternative, title, description, caption)
 * and the page's text. A line is given when more than `lineGiven` of its content words stand together in one
 * source, or in up to `blockWindow` blocks of the page's text in a row. A line that is not given may still be said
 * in other words: by a text that shares at least `possibleWords` of its words or numbers (`wordGroups`) and at
 * least `possibleShare` of them in such a window, or at least one and `nearShare` of them with the texts next to
 * the picture (its own texts, and the `nearBlocks` blocks before and after it; `at` is the picture's place in
 * the page's text, -1 when unknown). Lines with no content word are left out. `beside` is the size (in words that
 * can tell a text apart) of the text beside the picture: of the longest block of its own section of the page (from
 * the heading before it to the next heading; a caption, a credit or a control's name between the picture and a
 * paragraph does not part them), or of the block right before it and the block right after it together, when that
 * is more. A heading right after the picture, with no sentence in between, may introduce its text: the section it
 * starts is read too.
 */
export function compareLines(lines: readonly DrawnLine[], sources: readonly string[], page: PageWords, at = -1, region?: number): { total: number; lines: LineCompared[]; beside: number } {
  const R = PICTURE_RULES;
  const texts = sources.filter((s) => s.trim());
  const near: Set<string>[] = texts.map((s) => wordKeys(s));
  // Each of the picture's own texts as compared: every word without its ending, and its `wordKeys`.
  const own = texts.map((s, i) => new Set([...stems(s), ...near[i]!]));
  if (at >= 0) for (let i = Math.max(0, at - R.nearBlocks); i < Math.min(page.blocks.length, at + R.nearBlocks); i++) near.push(page.blocks[i]!);
  // The text beside the picture: the blocks of its section of the page (its own texts, which stand there as
  // blocks too, are passed over), by the words in them that can tell a text apart. Back to the heading before it,
  // which starts its section; on to the next heading, and through the section that one starts when no sentence
  // stands between the picture and it (a heading right after a picture may introduce its text). A block set
  // apart from the picture (the site's footer after the last picture of the content) is not beside it, nor is
  // anything past it.
  let beside = 0;
  if (at >= 0) {
    const mine = new Set(texts.map((t) => t.replace(/\s+/g, ' ').trim()));
    const apart = (i: number) => region !== undefined && !!page.regions && page.regions[i] !== region;
    let next = 0;
    let first = true;
    for (let i = at - 1; i >= 0 && !apart(i); i--) {
      if (mine.has(page.texts[i]!)) continue;
      const size = page.sizes[i] ?? 0;
      if (first) { next += size; first = false; }
      beside = Math.max(beside, size);
      if (page.heads?.[i]) break;
    }
    first = true;
    let after = 0;
    let crossed = false;
    for (let i = at; i < page.texts.length && !apart(i); i++) {
      if (mine.has(page.texts[i]!)) continue;
      const size = page.sizes[i] ?? 0;
      if (first) { next += size; first = false; }
      if (page.heads?.[i]) {
        if (crossed || after >= R.besideWords) break;
        crossed = true;
      }
      after = Math.max(after, size);
    }
    beside = Math.max(beside, after, next);
  }
  let total = 0;
  const out: LineCompared[] = [];
  for (const line of lines) {
    const ws = line.content.map(wordStem);
    if (!ws.length) continue;
    total += ws.length;
    // More than half of the line's words (one of one, two of two or three, three of four or five…). A word is
    // found by itself or by what it names: a number, a month or a day, however the text writes it ("Fri", "11/13").
    const need = Math.floor(R.lineGiven * ws.length + 1e-9) + 1;
    const found = line.content.map((w) => [wordStem(w), ...(w.match(/\d+/g) ?? []).map((run) => `#${Number(run)}`), ...(NAMED.get(w) ?? NAMED.get(wordStem(w)) ?? [])]);
    const hits = (sets: readonly Set<string>[]) => found.filter((keys) => keys.some((k) => sets.some((s) => s.has(k)))).length;
    let given = own.some((s) => hits([s]) >= need);
    // Words and numbers the same thing said another way would share: each of the line's words counts once.
    const groups = wordGroups(line.text);
    const shared = (sets: readonly Set<string>[]) => groups.filter((g) => g.some((k) => sets.some((s) => s.has(k)))).length;
    const enough = Math.max(R.possibleWords, Math.ceil(R.possibleShare * groups.length - 1e-9));
    let possible = false;
    // Only windows around a block that has one of the line's words can give it, or say it another way.
    const starts = new Set<number>();
    for (const w of new Set([...ws, ...groups.flat()])) for (const i of page.index.get(w) ?? []) for (let k = 0; k < R.blockWindow; k++) if (i - k >= 0) starts.add(i - k);
    for (const s of starts) {
      const window = page.blocks.slice(s, s + R.blockWindow);
      if (!given && hits(window) >= need) { given = true; break; }
      if (!possible && shared(window) >= enough) possible = true;
    }
    if (!given && !possible && shared(near) >= Math.max(1, Math.ceil(R.nearShare * groups.length - 1e-9))) possible = true;
    out.push({ text: line.text, weight: ws.length, given, possible: !given && possible });
  }
  return { total, lines: out, beside };
}

/**
 * The share of a picture's words that are given as text (see `compareLines`), the lines not given, and the number
 * of content words compared.
 */
export function givenShare(lines: readonly DrawnLine[], sources: readonly string[], page: PageWords): { share: number; missing: string[]; total: number } {
  const c = compareLines(lines, sources, page);
  const given = c.lines.reduce((n, l) => n + (l.given ? l.weight : 0), 0);
  return { share: c.total ? given / c.total : 1, missing: c.lines.filter((l) => !l.given).map((l) => l.text), total: c.total };
}

/** Whole alternatives that only say what kind of picture it is (with or without "image of", an article, a number). */
const KIND_WORDS = new Set([
  'map', 'maps', 'diagram', 'chart', 'graph', 'graphic', 'figure', 'illustration', 'infographic', 'flyer', 'flier', 'poster', 'notice', 'schedule', 'flowchart',
  'table', 'drawing', 'plan', 'picture', 'image', 'img', 'photo', 'photograph', 'screenshot', 'banner', 'sign', 'slide', 'thumbnail', 'graphics', 'pic',
  // Spanish and French: the commonest.
  'mapa', 'diagrama', 'grafico', 'gráfico', 'grafica', 'gráfica', 'imagen', 'cartel', 'aviso', 'horario', 'carte', 'schéma', 'schema', 'graphique', 'affiche', 'avis', 'horaire',
]);
const FILLER = new Set(['a', 'an', 'the', 'of', 'this', 'our', 'el', 'la', 'un', 'una', 'de', 'le', 'du', 'des']);
/** Words that only say which kind of chart, plan or map it is ("floor plan", "bar chart"): no subject either. */
const KIND_QUALIFIERS = new Set(['floor', 'site', 'bar', 'pie', 'line', 'flow', 'org', 'organization', 'organisation', 'organizational', 'organisational', 'info']);
const FILE_NAME = /^[^\\/]{1,160}\.(?:jpe?g|png|gif|webp|svgz?|bmp|tiff?|avif|heic|ico)$/i;

/** 'file' for a file name, 'kind' for words that only name the kind of picture, else undefined. */
export function emptyAlternative(alt: string): 'file' | 'kind' | undefined {
  const t = alt.trim();
  if (!t) return undefined;
  if (FILE_NAME.test(t)) return 'file';
  const words = textWords(t).filter((w) => !FILLER.has(w) && !/^\d+$/.test(w));
  return words.length > 0 && words.length <= 3 && words.some((w) => KIND_WORDS.has(w)) && words.every((w) => KIND_WORDS.has(w) || KIND_QUALIFIERS.has(w)) ? 'kind' : undefined;
}

/**
 * What one of a picture's own texts can be for words it does not give: nothing ('none'), a file name, the name of
 * a kind of picture, a 'label' (too short to give `total` content words: a third of them or fewer), or a 'text' of
 * about their length, which may say them in other words or in another language.
 */
export function sourceKind(text: string, total: number): 'none' | 'file' | 'kind' | 'label' | 'text' {
  if (!text.trim()) return 'none';
  const empty = emptyAlternative(text);
  if (empty) return empty;
  return contentWords(text).length <= PICTURE_RULES.labelShare * total ? 'label' : 'text';
}

/** A letter that English does not write: one with an accent, or of another script. */
const OTHER_LETTER = /(?![a-z])\p{L}/iu;

/** Whether a picture's words are given as text, are not given by any text that could be their equivalent, or may be given in other words. */
export type WordsVerdict =
  | { state: 'given' }
  | { state: 'open'; why: string }
  | { state: 'absent'; share: number; missing: string[] };

/**
 * The verdict for one picture (see the head of this file): `own` are its own texts, each with what it is called in
 * a finding; `at` is its place in the page's text.
 *
 * Words that match show that a text gives a line. Words that do not match show less: the same thing can be said
 * in other words, with a date or a number written another way, or in another language. So:
 * - a text of the picture's own (its alternative, title, description, caption) is never judged by its words. It
 *   is ruled out only by what it is: empty, a file name or the name of a kind of picture. Any other may say the
 *   picture's words another way, at about their length or more briefly: the verdict is open (a shorter one is for a
 *   person to check);
 * - a line is counted as not given only when no text on the page shares even a part of it: a third of its words
 *   and numbers (and two of them) in any three blocks in a row, or a quarter (and one) in the text next to the
 *   picture. Numbers, dates and times count however they are written. A line some text shares that much with
 *   may be said there another way, and is left out of the count;
 * - the text beside the picture (its section of the page: from the heading before it to the next heading, and
 *   the section after that when the heading comes right after the picture; never text set apart from it, as the
 *   site's footer is) is where its words would be given in other words, so it is never judged by its words
 *   either: when one block of it, or the two next to the picture together, have four words that count or more,
 *   and more than a third as many as the words not given, the verdict is open;
 * - nothing is said across languages: the page's text must be in the picture's language, and in one language.
 *   The picture's words must show the page's language (a function word, a short word or the name of a day or a
 *   month of that language, and no more signs of another: its words, and on a page in English every word with a
 *   letter English does not write), or show no language at all and share a word, not a number, with the page.
 * A failure needs more than half of the picture's words in lines counted as not given, and no such text beside it.
 */
export function wordsVerdict(lines: readonly DrawnLine[], own: readonly { text: string; what: string }[], page: PageWords, at: number, region?: number): WordsVerdict {
  const R = PICTURE_RULES;
  const c = compareLines(lines, own.map((o) => o.text), page, at, region);
  if (c.total < 3) return { state: 'given' };
  const given = c.lines.reduce((n, l) => n + (l.given ? l.weight : 0), 0) / c.total;
  if (given >= R.pictureGiven) return { state: 'given' };
  // A text of the picture's own that does not give its words may say them another way: of about their length, in
  // other words or another language; shorter, more briefly (the full-tree review's S1: a word count can choose a
  // picture for a person to check, never show that information is missing). Only an empty text, a file name or the
  // name of a kind of picture is ruled out by what it is.
  for (const o of own) {
    const kind = sourceKind(o.text, c.total);
    if (kind === 'text') return { state: 'open', why: `its ${o.what} may give its words in other words or in another language` };
    if (kind === 'label') return { state: 'open', why: `its ${o.what} is shorter than the words it draws and may still say what they say: a person should check it` };
  }
  // The comparison is of words: it says nothing across languages.
  if (page.mixed) return { state: 'open', why: 'the page has text in more than one language, where its words may be given' };
  if (page.lang) {
    const drawn = lines.flatMap((l) => l.words);
    const signs = languageSigns(drawn);
    const ofPage = signs[page.lang] ?? 0;
    let ofAnother = Math.max(0, ...Object.entries(signs).filter(([lang]) => lang !== page.lang).map(([, n]) => n));
    // On a page in English, a word with a letter English does not write (an accent, another script) is a sign of another language.
    if (page.lang === 'en') ofAnother = Math.max(ofAnother, drawn.filter((w) => OTHER_LETTER.test(w)).length);
    // With no sign of the page's language: no sign of another either, and a word (not a number) the page has too.
    const shared = () => lines.some((l) => l.content.some((w) => !/\d/.test(w) && page.index.has(wordStem(w))));
    if (ofPage ? ofAnother > ofPage : ofAnother >= 1 || !shared()) return { state: 'open', why: 'its words could not be shown to be in the language of the page\'s text' };
  }
  const absent = c.lines.filter((l) => !l.given && !l.possible);
  const words = absent.reduce((n, l) => n + l.weight, 0);
  if (words / c.total <= R.absentShare) return { state: 'open', why: 'a text on the page shares words or numbers with it and may give its words another way' };
  // The text beside the picture (its section of the page) is where its words would be given in other words. A
  // text of more than a third of their length may do that, whatever its words: only a picture with no such text
  // beside it is failed.
  if (at < 0) return { state: 'open', why: 'its place in the page\'s text is not known, so the text beside it could not be told' };
  if (c.beside >= R.besideWords && c.beside > R.besideShare * words) return { state: 'open', why: 'the text beside it is long enough to give its words in other words or in another language' };
  return { state: 'absent', share: given, missing: absent.map((l) => l.text) };
}

/** A rectangle in CSS px. */
interface Box { x: number; y: number; w: number; h: number }

/** A computed value split at its spaces outside brackets ("calc(100% - 10px) 0px" is two parts). */
function parts(v: string): string[] {
  const out: string[] = [];
  let depth = 0, cur = '';
  for (const ch of v.trim()) {
    if (ch === '(') depth++; else if (ch === ')') depth--;
    if (/\s/.test(ch) && depth === 0) { if (cur) out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

/** A computed length, percentage or `calc(N% ± Mpx)` against `full` px; undefined for anything else. */
function resolved(v: string, full: number): number | undefined {
  const t = v.trim();
  if (t === '0') return 0;
  let m = /^(-?[\d.]+)px$/.exec(t);
  if (m) return Number(m[1]);
  m = /^(-?[\d.]+)%$/.exec(t);
  if (m) return (Number(m[1]) / 100) * full;
  m = /^calc\(\s*(-?[\d.]+)%\s*([+-])\s*([\d.]+)px\s*\)$/.exec(t);
  if (m) return (Number(m[1]) / 100) * full + (m[2] === '-' ? -1 : 1) * Number(m[3]);
  return undefined;
}

/** Where a picture's lines of words are, as shown. */
export interface Placement {
  /** 'shown': every line is inside what shows; 'none': none is; 'part': some are cut off; 'unknown': not worked out. */
  state: 'shown' | 'none' | 'part' | 'unknown';
  /** CSS px on the page per canvas px of the measure (the smaller of the two axes). */
  scale: number;
}

/**
 * The tile a background picture is painted in and the box that clips it, in the element's border box (CSS px), from
 * the computed values of its own layer; undefined when they cannot be worked out (a layer under another, a fixed
 * background, a blend mode, a filter or a mask, content of the element's own over it, a size or a place in units
 * this does not resolve, a file with no size it can use).
 */
export function backgroundTile(b: BackgroundLayout, m: Pick<SvgMeasure, 'natural' | 'intrinsic'>): { tile: Box; clip: Box } | undefined {
  if ((b.layers > 1 && b.layer !== 0) || b.attachment !== 'scroll' || b.effect || b.inner) return undefined;
  const [BW, BH] = b.box;
  const [bt, br, bb, bl] = b.border;
  const [pt, pr, pb, pl] = b.padding;
  const boxOf = (name: string): Box | undefined => (name === 'border-box' ? { x: 0, y: 0, w: BW, h: BH }
    : name === 'padding-box' ? { x: bl, y: bt, w: BW - bl - br, h: BH - bt - bb }
    : name === 'content-box' ? { x: bl + pl, y: bt + pt, w: BW - bl - br - pl - pr, h: BH - bt - bb - pt - pb } : undefined);
  const area = boxOf(b.origin);
  const clip = boxOf(b.clip);
  if (!area || !clip || !(area.w > 0) || !(area.h > 0) || !(clip.w > 0) || !(clip.h > 0)) return undefined;
  const [nw, nh] = m.natural;
  if (!(nw > 0) || !(nh > 0)) return undefined;
  let tw: number;
  let th: number;
  const size = parts(b.size);
  const fitted = (cover: boolean): [number, number] => { const s = cover ? Math.max(area.w / nw, area.h / nh) : Math.min(area.w / nw, area.h / nh); return [nw * s, nh * s]; };
  if (size[0] === 'contain' || size[0] === 'cover') {
    if (m.intrinsic === 'unknown') return undefined;
    [tw, th] = fitted(size[0] === 'cover');
  } else {
    const one = (v: string | undefined, full: number): number | 'auto' | undefined => (v === undefined || v === 'auto' ? 'auto' : resolved(v, full));
    const a = one(size[0], area.w);
    const c = one(size[1], area.h);
    if (a === undefined || c === undefined) return undefined;
    if (a === 'auto' && c === 'auto') {
      // A file with a size of its own is painted at it; one with a shape only fills the area, whole.
      if (m.intrinsic === 'size') { tw = nw; th = nh; } else if (m.intrinsic === 'ratio') [tw, th] = fitted(false); else return undefined;
    } else if (a === 'auto' || c === 'auto') {
      if (m.intrinsic === 'unknown') return undefined;
      if (a === 'auto') { th = c as number; tw = (th * nw) / nh; } else { tw = a; th = (tw * nh) / nw; }
    } else { tw = a; th = c; }
  }
  if (!(tw > 0) || !(th > 0)) return undefined;
  const at = parts(b.position);
  if (at.length !== 2) return undefined;
  const px = resolved(at[0]!, area.w - tw);
  const py = resolved(at[1]!, area.h - th);
  if (px === undefined || py === undefined) return undefined;
  let x = area.x + px;
  let y = area.y + py;
  const rep = b.repeat.trim().split(/\s+/);
  const axis = (v: string | undefined): boolean | undefined => (v === 'repeat' ? true : v === 'no-repeat' ? false : undefined);
  const rx = rep.length === 1 ? (rep[0] === 'repeat-x' ? true : rep[0] === 'repeat-y' ? false : axis(rep[0])) : axis(rep[0]);
  const ry = rep.length === 1 ? (rep[0] === 'repeat-y' ? true : rep[0] === 'repeat-x' ? false : axis(rep[0])) : axis(rep[1]);
  if (rx === undefined || ry === undefined) return undefined;
  // A repeated tile: the first one that starts inside the clip box is the one looked at.
  if (rx) x += Math.ceil((clip.x - x - 0.5) / tw) * tw;
  if (ry) y += Math.ceil((clip.y - y - 0.5) / th) * th;
  return { tile: { x, y, w: tw, h: th }, clip };
}

/**
 * The tile an `<img>` or an image button paints its file in (object-fit and object-position) inside its box;
 * undefined when it cannot be worked out.
 */
export function imageTile(p: Pick<Picture, 'width' | 'height' | 'fit' | 'fitAt'>, m: Pick<SvgMeasure, 'natural' | 'intrinsic'>): { tile: Box; clip: Box } | undefined {
  const clip: Box = { x: 0, y: 0, w: p.width, h: p.height };
  const fit = p.fit ?? 'fill';
  if (fit === 'fill') return { tile: clip, clip };
  const [nw, nh] = m.natural;
  if (!(nw > 0) || !(nh > 0) || m.intrinsic === 'unknown') return undefined;
  const contain = Math.min(clip.w / nw, clip.h / nh);
  let s: number;
  if (fit === 'contain') s = contain;
  else if (fit === 'cover') s = Math.max(clip.w / nw, clip.h / nh);
  else if (fit === 'none') { if (m.intrinsic !== 'size') return undefined; s = 1; }
  else if (fit === 'scale-down') s = m.intrinsic === 'size' ? Math.min(1, contain) : contain;
  else return undefined;
  const tw = nw * s, th = nh * s;
  const at = parts(p.fitAt ?? '50% 50%');
  if (at.length !== 2) return undefined;
  const px = resolved(at[0]!, clip.w - tw);
  const py = resolved(at[1]!, clip.h - th);
  if (px === undefined || py === undefined) return undefined;
  return { tile: { x: px + 0, y: py + 0, w: tw, h: th }, clip };
}

/**
 * Where the lines of words of a measured file are when it is painted in `tile` and clipped by `clip`: the file's
 * drawing is fitted in the tile as the browser fits it (stretched when it has no viewBox or says `none`, else whole
 * and centred, or filling and cropped with `slice`), and each line's box is tested against what shows.
 */
export function placeRows(rows: readonly (readonly number[])[], m: Pick<SvgMeasure, 'width' | 'height' | 'natural' | 'aspect' | 'view'>, tile: Box, clip: Box): Placement & { boxes: [number, number, number, number][] } {
  const [nw, nh] = m.natural;
  const W = m.width, H = m.height;
  if (!(W > 0) || !(H > 0) || !(tile.w > 0) || !(tile.h > 0)) return { state: 'unknown', scale: 0, boxes: [] };
  let sx: number, sy: number, ox = tile.x, oy = tile.y;
  const same = Math.abs((tile.w / tile.h) / (nw / nh) - 1) <= 0.02;
  if (same || /^none\b/.test(m.aspect)) {
    sx = tile.w / W; sy = tile.h / H;
  } else {
    // The drawing keeps its shape in a tile of another: only when the file's viewBox has the shape of its size.
    const [vw, vh] = m.view ?? m.natural;
    if (Math.abs((vw / vh) / (nw / nh) - 1) > 0.01) return { state: 'unknown', scale: 0, boxes: [] };
    const s = /\bslice\b/.test(m.aspect) ? Math.max(tile.w / nw, tile.h / nh) : Math.min(tile.w / nw, tile.h / nh);
    const fx = /xMin/.test(m.aspect) ? 0 : /xMax/.test(m.aspect) ? 1 : 0.5;
    const fy = /YMin/.test(m.aspect) ? 0 : /YMax/.test(m.aspect) ? 1 : 0.5;
    ox = tile.x + (tile.w - nw * s) * fx;
    oy = tile.y + (tile.h - nh * s) * fy;
    sx = (nw * s) / W; sy = (nh * s) / H;
  }
  // What shows: the tile inside the clip box.
  const v = [Math.max(tile.x, clip.x), Math.max(tile.y, clip.y), Math.min(tile.x + tile.w, clip.x + clip.w), Math.min(tile.y + tile.h, clip.y + clip.h)];
  const boxes = rows.map((r): [number, number, number, number] => [ox + r[0]! * sx, oy + r[1]! * sy, ox + (r[2]! + 1) * sx, oy + (r[3]! + 1) * sy]);
  let whole = 0, out = 0;
  for (const b of boxes) {
    if (inside(b, v, 1.5)) whole++;
    else if (b[2] <= v[0]! || b[0] >= v[2]! || b[3] <= v[1]! || b[1] >= v[3]!) out++;
  }
  const state = !boxes.length ? 'unknown' : whole === boxes.length ? 'shown' : out === boxes.length ? 'none' : 'part';
  return { state, scale: Math.min(sx, sy), boxes };
}

/** Where a picture's lines of words are as the page shows it (see `Placement`). */
export function placementOf(p: Picture, m: SvgMeasure, rows: readonly (readonly number[])[]): Placement {
  const R = PICTURE_RULES;
  // A lazy picture the browser has not loaded yet has no box: it is taken at its file's own size.
  if (p.kind !== 'background' && !(p.width > 0 && p.height > 0)) {
    const tile = { x: 0, y: 0, w: m.natural[0], h: m.natural[1] };
    const { state, scale } = placeRows(rows, m, tile, tile);
    return { state, scale };
  }
  if (p.showing < 0.02) return { state: 'none', scale: 0 };
  if (p.showing < R.showingShare) return { state: 'part', scale: 0 };
  if (p.kind !== 'background') {
    const t = imageTile(p, m);
    if (!t) return { state: 'unknown', scale: 0 };
    const { state, scale } = placeRows(rows, m, t.tile, t.clip);
    return { state, scale };
  }
  const b = p.background;
  if (!b) return { state: 'unknown', scale: 0 };
  // A transform that turns or skews the element: its lines are not where the boxes say.
  if (Math.abs(b.scale[0] - b.scale[1]) > 0.05 * Math.max(b.scale[0], b.scale[1])) return { state: 'unknown', scale: 0 };
  const t = backgroundTile(b, m);
  if (!t) return { state: 'unknown', scale: 0 };
  const placed = placeRows(rows, m, t.tile, t.clip);
  let state = placed.state;
  // A rounded corner cuts what lies in it: a line that reaches into a corner's square is not whole.
  if (state === 'shown' && b.radius > 2) {
    const r = b.radius;
    const [BW, BH] = b.box;
    const corners = [[0, 0, r, r], [BW - r, 0, BW, r], [0, BH - r, r, BH], [BW - r, BH - r, BW, BH]];
    if (placed.boxes.some((x) => corners.some((c) => x[0] < c[2]! && x[2] > c[0]! && x[1] < c[3]! && x[3] > c[1]!))) state = 'part';
  }
  return { state, scale: placed.scale * Math.min(b.scale[0], b.scale[1]) };
}

const NO_PAGE: PageWords = { blocks: [], texts: [], sizes: [], index: new Map(), mixed: false };
const quote = (s: string, max = 220) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const shownWords = (d: Drawn, max = 220) => quote(d.lines.map((l) => l.text).join(' · '), max);

type Criterion = '1.1.1' | '1.4.5';

/** One failure, with what tells it apart (its picture and rule) and what the finding says. */
export interface PictureFail { criterion: Criterion; target: string; rule: string; detail: string }

export interface PictureJudgement {
  findings: ProbeFinding[];
  /** Pictures whose words were measured (SVG files that draw words). */
  measured: number;
  /** Failures by picture, for the pictures' evidence: [criterion, target]. */
  failed: { criterion: Criterion; target: string; rule: string }[];
  /** Every failure, and what each criterion says when it has none (nothing: no failure found). */
  fails: PictureFail[];
  otherwise: Partial<Record<Criterion, ProbeFinding>>;
}

/** Findings of one kind listed per page; the last one counts the rest. */
const PER_KIND = 5;

/** Why a file was not measured, as a finding says it. */
const NOT_MEASURED: Record<SvgMeasureError, string> = {
  unread: 'the file the browser loaded for it could not be read',
  'too-large': 'its file is larger than is read',
  unsafe: 'its file declares entities or a stylesheet, which are never read',
  unsupported: 'its file moves or changes by itself, draws HTML or depends on the size it is shown at, so what the page shows cannot be measured from the file',
  heavy: 'its file embeds pictures or applies a filter, which are never decoded here',
  reloaded: 'the browser loaded its file again while it was measured, so the file measured may not be the one shown',
  'not-svg': 'its file could not be read as an SVG document',
  'not-drawn': 'its file could not be drawn to measure the words in it',
  time: 'there was no time left to measure it',
};

function findingsOf(fails: readonly PictureFail[], otherwise: Partial<Record<Criterion, ProbeFinding>>): ProbeFinding[] {
  const findings: ProbeFinding[] = [];
  for (const criterion of ['1.1.1', '1.4.5'] as const) {
    const mine = fails.filter((f) => f.criterion === criterion);
    const shown = mine.slice(0, PER_KIND);
    shown.forEach((f, i) => {
      const more = i === shown.length - 1 && mine.length > shown.length ? ` (${mine.length - shown.length} more like this on this page)` : '';
      findings.push({ criterion, status: 'failed', target: f.target, detail: `${f.detail}${more}` });
    });
    const other = otherwise[criterion];
    if (!mine.length && other) findings.push(other);
  }
  return findings;
}

/**
 * One page's findings (pure): `read` is what `readPictures` returned, `measured` the files' measures by address.
 * A criterion with nothing to judge is "not applicable"; with pictures judged and none failing it has no finding
 * (no failure found); a picture whose words could not be measured, or whose judgement stays open, makes it "not
 * testable" unless another picture fails.
 */
export function judgePictures(read: PicturesRead, measured: ReadonlyMap<string, SvgMeasured>): PictureJudgement {
  const R = PICTURE_RULES;
  const page = pageWordIndex(read.blocks, read.regions, read.heads);
  const drawnBy = new Map<string, Drawn>();
  const fails: PictureFail[] = [];
  /** Pictures whose words could not be measured: nothing is known of what they draw. */
  const unmeasured: { target: string; why: string }[] = [];
  /** Pictures measured whose judgement stays open, by criterion. */
  const open: Record<Criterion, { target: string; why: string }[]> = { '1.1.1': [], '1.4.5': [] };
  // Files shown somewhere on the page with a text alternative that reaches assistive technology: a hidden copy of
  // such a picture (a slideshow's clone of a slide) hides nothing.
  const exposed = new Set(read.pictures.filter((p) => p.kind !== 'background' && p.src && !p.hidden && !!(p.name || p.alt)).map((p) => p.src));
  let withWords = 0;
  let svgs = 0;
  /** Pictures too small to show a line of five words that can be read, whose file was not measured. */
  let small = 0;
  const beyond = new Set<string>();
  for (const p of read.pictures) {
    if (!p.svg || !p.src) continue;
    svgs++;
    const roomy = p.width === 0 || (p.width * p.height >= 4000 && Math.min(p.width, p.height) >= 12);
    const skip = (why: string) => { if (roomy) unmeasured.push({ target: p.target, why }); else small++; };
    const got = measured.get(p.src);
    if (!got) { if (roomy) beyond.add(p.src); else small++; continue; } // past the page's file limit: said below
    if (!got.measure) {
      // A file that is no SVG document and has no text element draws no words; any other file not measured may.
      if (got.error === 'not-svg' && got.hasText === false) continue;
      skip(NOT_MEASURED[got.error ?? 'unread']);
      continue;
    }
    const m = got.measure;
    if (!m.texts.length) continue; // read whole: the file has no text element
    if (m.texts.some((t) => t.ink < 0)) { skip('it has more words than are measured one by one'); continue; }
    // The file read is the one the element shows: its size, as the browser decoded it, is the file's own (or that
    // size divided by a whole density, as `srcset` has it: the same shape, one to four times smaller).
    if (p.decoded && m.intrinsic === 'size') {
      const kx = m.natural[0] / p.decoded[0];
      const ky = m.natural[1] / p.decoded[1];
      const same = Math.abs(p.decoded[0] - m.natural[0]) <= 1.5 && Math.abs(p.decoded[1] - m.natural[1]) <= 1.5;
      const denser = kx >= 1 && kx <= 4.05 && Math.abs(kx - ky) <= 0.03 * kx && Math.abs(kx - Math.round(kx * 2) / 2) <= 0.03;
      if (!same && !denser) { skip('the file read is not of the size of the picture shown'); continue; }
    }
    let d = drawnBy.get(p.src);
    if (!d) { d = drawnOf(m); drawnBy.set(p.src, d); }
    if (!d.lines.length) continue; // measured word by word: none of its words is shown
    withWords++;
    const leave = (why: string, criterion: Criterion) => { open[criterion].push({ target: p.target, why }); };
    // What stands between a failure and this picture: whether all of its words show, whole, where the page shows
    // it. A picture that fails nothing anyway is not held up by it.
    let doubt: string | undefined;
    const place = placementOf(p, m, d.rows);
    if (place.state === 'none') continue; // none of its words is in what the page shows of it
    // How much of its box is painted is not worked out (padding, a border, a legacy clip, rounded corners): where its
    // words are painted is not known (the full-tree review's S4).
    if (p.unresolved) doubt = `how much of it the page paints is not worked out (${p.unresolved})`;
    else if (place.state === 'part') doubt = 'part of it is cut off where the page shows it';
    else if (place.state === 'unknown') doubt = 'how it is laid out where the page shows it could not be worked out';
    else {
      const heights = d.rows.map((r) => (r[3] - r[1] + 1) * place.scale).sort((a, b) => a - b);
      if (!(heights.length > 0 && heights[Math.floor(heights.length / 2)]! >= R.legiblePx)) continue; // shown too small to read
    }
    if (!doubt && p.opacity < 0.5) doubt = 'it is shown faintly (its opacity with its containers\' is under a half)';
    if (!doubt && p.effect) doubt = 'an effect on it or on a container (a filter, a blend mode, a clip path or a mask) changes how it is painted';
    if (!doubt && m.seen < R.seenShare) doubt = m.seen < 0 ? 'whether all of its words show could not be measured' : 'part of its words is covered or cut off in the file';
    const what = p.kind === 'background' ? 'background picture' : p.kind === 'input' ? 'image button' : 'picture';
    const alternative = p.name || (p.alt ?? '');
    // One or two short lines that are no sentence, named word for word by the alternative: a name, a title or a
    // logo with its motto. Whether such a picture is a logo (which may be a picture of its words) is not decided.
    const nameLike = d.rows.length <= 2 && d.words <= R.nameWords && !!alternative && !d.lines.some((l) => /[.!?]["”’)\]]*$/.test(l.text.trim()))
      && givenShare(d.lines, [alternative], NO_PAGE).share >= 0.9;
    // 1.4.5: a block of text and nothing else.
    if (d.block && !p.logo && !p.captcha && !p.sample && !nameLike) {
      if (doubt || d.undecided) leave(doubt ?? d.undecided!, '1.4.5');
      else {
        fails.push({
          criterion: '1.4.5', target: p.target, rule: 'block',
          detail: `The ${what} is text and nothing else: an SVG file that draws ${d.rows.length === 1 ? 'one line' : `${d.rows.length} lines`} of words on a plain ground (“${shownWords(d)}”). As a picture, the words cannot be restyled, re-spaced or reflowed by the reader`,
        });
      }
    }
    // 1.1.1: words the page gives nowhere.
    if (p.control || p.textVersion || p.captcha || p.logo || p.sample) continue;
    const hiddenPicture = p.kind !== 'background' && (p.hidden || (p.alt === '' && !p.name));
    const statement = d.statements > 0 && d.words >= R.statementPictureWords;
    let rule: string | undefined;
    if (p.kind === 'background') {
      if (!p.ownText && !p.name && (d.block || statement)) rule = 'background';
    } else if (p.kind === 'img') {
      if (hiddenPicture) { if ((d.block || statement) && !exposed.has(p.src)) rule = 'hidden'; }
      else if (p.alt === null && !p.name) rule = undefined; // no alternative at all: the missing-alt rule's failure
      else if (d.block) rule = 'block';
      else if (statement && emptyAlternative(alternative)) rule = 'kind';
    }
    if (!rule) continue;
    // Nothing is said of words "given nowhere" when a text that could give them was not read whole.
    if (read.blocksTruncated) { leave('the page has more text than is compared with the words its pictures draw', '1.1.1'); continue; }
    if (read.framesUnread) { leave('a frame on the page could not be read (another site\'s, or nested deeper than is read), so what its text says is not known', '1.1.1'); continue; }
    if (p.cut) { leave('one of its own texts (its alternative, description or caption) is longer than is read', '1.1.1'); continue; }
    if (rule === 'hidden' && read.truncated) { leave('the page has more elements than are read: the same picture may be shown elsewhere with a text alternative', '1.1.1'); continue; }
    const own = hiddenPicture || p.kind === 'background'
      ? [{ text: p.title, what: 'title' }, { text: p.described, what: 'description' }, { text: p.caption, what: 'caption' }]
      : [{ text: alternative, what: 'text alternative' }, { text: p.title, what: 'title' }, { text: p.described, what: 'description' }, { text: p.caption, what: 'caption' }];
    const v = wordsVerdict(d.lines, own, page, p.at, p.region);
    if (v.state === 'given') continue;
    if (v.state === 'open') { leave(v.why, '1.1.1'); continue; }
    if (doubt) { leave(doubt, '1.1.1'); continue; }
    // A rule that holds only because the picture reads as a block of text is open when that is (S3).
    if (d.undecided && (rule === 'block' || !statement)) { leave(d.undecided, '1.1.1'); continue; }
    const missing = quote(v.missing.join(' · '));
    const pct = Math.round(v.share * 100);
    const kindOf = sourceKind(alternative, compareLines(d.lines, [], NO_PAGE).total);
    // (A text of its own that is no file name and no kind word leaves the verdict open, S1: only these two fail.)
    const said = kindOf === 'file' ? 'is a file name' : 'only says what kind of picture it is';
    const detail = rule === 'background'
      ? `A background picture draws words that are nowhere in the page's text (“${missing}”), and a background picture has no text alternative: the page's text gives ${pct}% of the picture's words`
      : rule === 'hidden'
        ? `The picture is kept from screen readers (${p.hidden ? 'hidden from assistive technology' : 'alt=""'}), but it draws words that are nowhere in the page's text: “${missing}” (the page's text gives ${pct}% of the picture's words)`
        : rule === 'kind'
          ? `The picture's text alternative (“${quote(alternative, 80)}”) ${said}, and the picture draws words that neither it nor the page's text gives: “${missing}”`
          : `The picture is all words (${d.words} of them), and its text alternative (“${quote(alternative, 80)}”) ${said}; the page's text gives ${pct}% of them, and nowhere: “${missing}”`;
    fails.push({ criterion: '1.1.1', target: p.target, rule, detail });
  }
  const otherwise: Partial<Record<Criterion, ProbeFinding>> = {};
  for (const criterion of ['1.1.1', '1.4.5'] as const) {
    const n = unmeasured.length;
    const left = open[criterion];
    if (n) {
      otherwise[criterion] = { criterion, status: 'not_testable', target: unmeasured[0]!.target, detail: `${n === 1 ? 'an SVG picture' : `${n} SVG pictures`} on this page could not be measured, so nothing is known of the words ${n === 1 ? 'it draws' : 'they draw'}: ${unmeasured[0]!.why}` };
    } else if (beyond.size) {
      otherwise[criterion] = { criterion, status: 'not_testable', detail: `this page has more SVG pictures than are measured (${beyond.size} ${beyond.size === 1 ? 'was' : 'were'} not)` };
    } else if (read.truncated) {
      otherwise[criterion] = { criterion, status: 'not_testable', detail: 'this page is too large to read every picture' };
    } else if (left.length) {
      otherwise[criterion] = { criterion, status: 'not_testable', target: left[0]!.target, detail: `${left.length === 1 ? 'an SVG picture that draws words' : `${left.length} SVG pictures that draw words`} could not be decided: ${left[0]!.why}` };
    } else if (!withWords) {
      otherwise[criterion] = { criterion, status: 'not_applicable', detail: svgs ? `no SVG picture on this page draws words${small ? ` (${small} too small to show a line of words ${small === 1 ? 'was' : 'were'} not measured)` : ''}` : 'no picture on this page is an SVG file' };
    }
  }
  return { findings: findingsOf(fails, otherwise), measured: withWords, failed: fails.map(({ criterion, target, rule }) => ({ criterion, target, rule })), fails, otherwise };
}

/**
 * The judgement that stands when the page was read before and after its pictures were measured: a failure only when
 * both readings give it (the same picture, criterion and rule). A failure only one of them gives means the page
 * changed meanwhile (a text alternative or a text arrived or went, a picture was replaced): that criterion is "not
 * testable" unless another failure stands. With no second reading nothing is confirmed.
 */
export function agreedJudgement(first: PictureJudgement, second: PictureJudgement | undefined): PictureJudgement {
  const key = (f: { criterion: string; target: string; rule: string }) => `${f.criterion}\n${f.target}\n${f.rule}`;
  const moved = (criterion: Criterion): ProbeFinding => ({ criterion, status: 'not_testable', detail: 'the page changed while its pictures were measured (a picture, its text alternative or the page\'s text), so what was found before could not be confirmed' });
  if (!second) {
    const otherwise = { ...first.otherwise };
    for (const c of ['1.1.1', '1.4.5'] as const) if (first.fails.some((f) => f.criterion === c)) otherwise[c] = { criterion: c, status: 'not_testable', detail: 'the page could not be read again after its pictures were measured, so what was found could not be confirmed' };
    return { findings: findingsOf([], otherwise), measured: first.measured, failed: [], fails: [], otherwise };
  }
  const before = new Set(first.fails.map(key));
  const after = new Set(second.fails.map(key));
  const fails = second.fails.filter((f) => before.has(key(f)));
  const otherwise = { ...second.otherwise };
  for (const c of ['1.1.1', '1.4.5'] as const) {
    const changed = first.fails.some((f) => f.criterion === c && !after.has(key(f))) || second.fails.some((f) => f.criterion === c && !before.has(key(f)));
    if (changed) otherwise[c] = moved(c);
  }
  return { findings: findingsOf(fails, otherwise), measured: second.measured, failed: fails.map(({ criterion, target, rule }) => ({ criterion, target, rule })), fails, otherwise };
}
