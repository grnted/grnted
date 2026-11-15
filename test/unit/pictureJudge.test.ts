// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the picture test decides (src/probes/pictureJudge.ts), on hand-made reads and measures: the decisions are pure,
// so each rule and each look-alike is one small case here. The drawing itself is tested in real Chromium
// (test/integration/pictureText.test.ts). The cases marked S1 to S9 are the review's (Sol r1): each is the case it
// gave, which must not fail, beside the look-alike that still must.
import { describe, expect, it } from 'vitest';
import {
  agreedJudgement, backgroundTile, compareLines, drawnOf, emptyAlternative, givenShare, imageTile, judgePictures, otherInk, pageWordIndex, PICTURE_RULES,
  placeRows, placementOf, plainGrounds, sourceKind, wordKeys, wordStem, wordsVerdict,
} from '../../src/probes/pictureJudge.js';
import { withoutReloaded } from '../../src/probes/pictures.js';
import { languageSigns } from '../../src/textWords.js';
import type { BackgroundLayout, DrawnText, FlatRegion, Picture, PicturesRead, SvgMeasure, SvgMeasured } from '../../src/probes/pictureText.js';

const W = 640;
const H = 240;
/** A line of text on the canvas: `words` at (x, y), 16 px high, 9 px per character. */
const line = (text: string, x: number, y: number, ink = 900): DrawnText => ({ text, ink, unseen: 0, bands: [[x, y, x + text.length * 9, y + 15]] });
const ground = (text: number, box: [number, number, number, number] = [0, 0, W - 1, H - 1]): FlatRegion => ({ n: (box[2] - box[0] + 1) * (box[3] - box[1] + 1), box, text, clear: false });
const measure = (texts: DrawnText[], extra: FlatRegion[] = [], restInk = 0, over: Partial<SvgMeasure> = {}): SvgMeasure => {
  const ink = texts.reduce((n, t) => n + Math.max(0, t.ink), 0);
  return { width: W, height: H, natural: [W, H], intrinsic: 'size', aspect: '', view: [W, H], texts, textInk: ink, seen: 1, regions: [ground(ink), ...extra], restInk, ...over };
};
const NOTICE = [line('Family packet pickup', 30, 30), line('Friday, November 13 · 1–3 p.m.', 30, 70), line('Alder Draw office, room 4', 30, 110), line('Use the west garden gate.', 30, 150)];
const picture = (over: Partial<Picture> = {}): Picture => ({
  kind: 'img', target: '#pic', src: 'https://site.test/a.svg', svg: true, local: true, alt: 'A notice', name: '', title: '', hidden: false, described: '', caption: '', cut: false,
  width: W, height: H, fit: 'fill', fitAt: '50% 50%', showing: 1, opacity: 1, effect: false, loads: 1, at: 0, region: 1, control: '', logo: false, captcha: false, sample: false, textVersion: false, ...over,
});
const layout = (over: Partial<BackgroundLayout> = {}): BackgroundLayout => ({
  layers: 1, layer: 0, size: 'contain', position: '50% 50%', repeat: 'no-repeat', origin: 'padding-box', clip: 'border-box', attachment: 'scroll',
  box: [W, H], border: [0, 0, 0, 0], padding: [0, 0, 0, 0], scale: [1, 1], radius: 0, inner: false, effect: false, ...over,
});
const background = (over: Partial<Picture> = {}, bg: Partial<BackgroundLayout> = {}): Picture => picture({ kind: 'background', alt: null, ownText: '', background: layout(bg), ...over });
const ENGLISH = ['Welcome to the district.', 'Office hours are posted at each school, and the doors open with the first bell.'];
/** The page's general text (ENGLISH) stands in the site's header (place 9), set apart from the pictures (place 1). */
const placed = (blocks: readonly string[]) => blocks.map((b) => (ENGLISH.includes(b) ? 9 : 1));
const read = (pictures: Picture[], blocks: string[] = ENGLISH, regions: number[] = placed(blocks), heads?: boolean[]): PicturesRead => ({ pictures, blocks, regions, ...(heads ? { heads } : {}), blocksTruncated: false, truncated: false });
const judgedAll = (p: Picture, m: SvgMeasure | SvgMeasured, blocks?: string[]) => {
  const got: SvgMeasured = 'src' in m ? m : { src: p.src, measure: m };
  return judgePictures(read([p], blocks), new Map([[p.src, got]])).findings;
};
const judged = (p: Picture, m: SvgMeasure | SvgMeasured, blocks?: string[]) => judgedAll(p, m, blocks).map((f) => [f.criterion, f.status] as const);
const failed = (p: Picture, m: SvgMeasure, blocks?: string[]) => judged(p, m, blocks).filter(([, s]) => s === 'failed').map(([c]) => c);
const lines = (texts: string[]) => drawnOf(measure(texts.map((t, i) => line(t, 30, 30 + i * 40)))).lines;

describe('what a file draws (drawnOf)', () => {
  it('lines set one under the other on a common edge, on a plain ground, are a block of text', () => {
    const d = drawnOf(measure(NOTICE));
    expect(d.block).toBe(true);
    expect(d.aligned).toBe('left');
    expect(d.rows).toHaveLength(4);
    expect(d.words).toBe(18);
    expect(d.statements).toBe(3);
  });

  it('centred lines and right-set lines are blocks too; one long line is a block', () => {
    const centred = ['Little listeners', 'winter stories', 'Thursday, November 12 at ten'].map((t, i) => line(t, 320 - (t.length * 9) / 2, 30 + i * 40));
    expect(drawnOf(measure(centred))).toMatchObject({ block: true, aligned: 'centre' });
    const right = ['Lodge addendum', 'Return keys by nine in the morning'].map((t, i) => line(t, 600 - t.length * 9, 30 + i * 40));
    expect(drawnOf(measure(right))).toMatchObject({ block: true, aligned: 'right' });
    expect(drawnOf(measure([line('Keep your permit card visible from the street.', 20, 40)]))).toMatchObject({ block: true, rows: [[20, 40, 434, 55]] });
  });

  it('is not a block: fewer than five words, labels across a drawing, texts side by side, a drawing beside the words, words in several boxes', () => {
    expect(drawnOf(measure([line('County meeting notice', 30, 30)])).notBlock).toBe('fewer than five words');
    const scattered = [line('West entrance', 68, 71), line('Holds', 445, 146), line('Enter west door and turn right at the desk', 76, 206)];
    expect(drawnOf(measure(scattered)).notBlock).toBe('lines with no common edge or centre');
    const columns = [line('Farm gate: closed', 30, 60), line('Gravel turnout: open', 380, 60), line('Walk to the turnout now', 30, 120)];
    expect(drawnOf(measure(columns))).toMatchObject({ block: false, sideBySide: true, notBlock: 'texts side by side' });
    // A bar chart's bars: flat regions with no word on them.
    const bars: FlatRegion[] = [{ n: 6000, box: [300, 40, 420, 90], text: 0, clear: false }, { n: 9000, box: [300, 100, 480, 150], text: 0, clear: false }];
    expect(drawnOf(measure(NOTICE, bars)).notBlock).toBe('a drawing besides the words');
    // Three boxes each with its own words (a flow chart).
    const boxes: FlatRegion[] = [0, 1, 2].map((i) => ({ n: 12_000, box: [20, 20 + i * 70, 320, 70 + i * 70] as [number, number, number, number], text: 800, clear: false }));
    expect(drawnOf(measure(NOTICE.slice(0, 3), boxes)).notBlock).toBe('words in shapes of their own');
  });

  it('words of two text elements on one row, close together, are one line', () => {
    const d = drawnOf(measure([line('Friday,', 30, 30), line('November 13 at the west office', 100, 30), line('Bring the signed form', 30, 70)]));
    expect(d.sideBySide).toBe(false);
    expect(d.rows).toHaveLength(2);
    expect(d.block).toBe(true);
  });

  it('a text element that draws nothing (hidden, off the canvas, covered) never counts', () => {
    const d = drawnOf(measure([line('Lodge', 30, 30), { text: 'Meet at the north gate at nine on Saturday morning', ink: 0, unseen: 0, bands: [] }, { text: 'tiny', ink: 5, unseen: 0, bands: [[1, 1, 3, 2]] }]));
    expect(d.lines.map((l) => l.text)).toEqual(['Lodge']);
    expect(d.words).toBe(1);
    expect(d.hiddenWords).toBe(11);
    expect(d.block).toBe(false);
  });

  // S2: only the words shown to be drawn are a line's words (the measure gives the shown words and counts the rest).
  it('S2: the words of an element that are not shown are not its line; they count as hidden', () => {
    const d = drawnOf(measure([{ ...line('Open', 30, 30), unseen: 6 }]));
    expect(d.lines.map((l) => l.text)).toEqual(['Open']);
    expect(d).toMatchObject({ words: 1, hiddenWords: 6, block: false });
  });

  it('a file with more text elements than are measured one by one is never a block', () => {
    const many = Array.from({ length: 50 }, (_, i): DrawnText => ({ text: `Label ${i}`, ink: -1, unseen: 0, bands: [] }));
    expect(drawnOf(measure(many))).toMatchObject({ block: false, lines: [], notBlock: 'more text elements than are measured one by one' });
  });
});

describe('what else a picture draws (otherInk)', () => {
  const base = { width: W, height: H, restInk: 0, textInk: 3000 };
  it('grounds of the words, rules, a frame, the surround of a card and a band across the picture are no drawing', () => {
    const card = ground(3000, [18, 18, 621, 221]);
    const regions: FlatRegion[] = [
      card,
      { n: 26_000, box: [0, 0, W - 1, H - 1], text: 0, clear: false }, // what the card stands on
      { n: 3600, box: [15, 15, 624, 224], text: 0, clear: false }, // its frame
      { n: 600, box: [30, 60, 600, 61], text: 0, clear: false }, // a rule
      { n: 13 * H, box: [0, 0, 12, H - 1], text: 0, clear: false }, // a stripe down the whole side
      { n: 5000, box: [0, 0, 300, 100], text: 0, clear: true }, // nothing drawn there
    ];
    expect(otherInk({ ...base, regions }).ink).toBe(0);
  });
  it('a frame or an edge that a few letters touch is no ground of the words', () => {
    const card = ground(2950, [14, 14, 625, 225]);
    const frame: FlatRegion = { n: 3500, box: [11, 11, 628, 228], text: 9, clear: false };
    const around: FlatRegion = { n: 16_000, box: [0, 0, W - 1, H - 1], text: 41, clear: false };
    const got = otherInk({ ...base, regions: [card, frame, around] });
    expect(got.grounds).toEqual([card]);
    expect(got.ink).toBe(0);
  });
  it('short hairlines are drawing (the thin bars of a chart beside its labels), long ones are rules', () => {
    const bars: FlatRegion[] = [0, 1, 2, 3, 4].map((i) => ({ n: (120 + i * 40) * 4, box: [300, 40 + i * 36, 300 + 120 + i * 40, 43 + i * 36] as [number, number, number, number], text: 0, clear: false }));
    expect(otherInk({ ...base, regions: [ground(3000), ...bars] }).ink).toBe(bars.reduce((n, b) => n + b.n, 0));
    expect(drawnOf(measure(['Roads 80 percent', 'Parks 60 percent', 'Safety 90 percent'].map((t, i) => line(t, 30, 40 + i * 36)), bars)).block).toBe(false);
    expect(otherInk({ ...base, regions: [ground(3000), { n: 1200, box: [20, 60, 619, 61], text: 0, clear: false }] }).ink).toBe(0);
  });
  it('a shape with no word on it, a line that is not level or upright, and specks count', () => {
    const regions: FlatRegion[] = [ground(3000), { n: 2800, box: [5, 122, 426, 175], text: 0, clear: false }, { n: 400, box: [500, 20, 520, 40], text: 0, clear: false }];
    expect(otherInk({ ...base, regions }).ink).toBe(3200);
    expect(otherInk({ ...base, regions: [ground(3000)], restInk: 900 }).ink).toBe(900);
  });
});

// S4: bars or boxes with labels inside them are a drawing, not grounds of a block of text.
describe('S4: the grounds of a block of text (plainGrounds)', () => {
  const g = (box: [number, number, number, number], text = 900): FlatRegion => ({ n: (box[2] - box[0] + 1) * (box[3] - box[1] + 1), box, text, clear: false });
  it('one ground, or a title band right over a body of the same width', () => {
    expect(plainGrounds([g([0, 0, 639, 239])], W, H)).toBe(true);
    expect(plainGrounds([g([0, 0, 639, 55]), g([0, 56, 639, 239])], W, H)).toBe(true);
    expect(plainGrounds([], W, H)).toBe(true);
  });
  it('not: bars of different lengths, bars apart from one another, a title on the ground over boxes with words, three boxes', () => {
    expect(plainGrounds([g([30, 80, 549, 135]), g([30, 156, 329, 211])], W, H)).toBe(false);
    expect(plainGrounds([g([30, 40, 549, 95]), g([30, 150, 549, 205])], W, H)).toBe(false);
    expect(plainGrounds([g([0, 0, 639, 239]), g([30, 80, 549, 135])], W, H)).toBe(false);
    expect(plainGrounds([g([0, 0, 639, 79]), g([0, 80, 639, 159]), g([0, 160, 639, 239])], W, H)).toBe(false);
  });
  it('the review’s chart: a title and two bars of different lengths with their labels inside is not a block of text; the same words on one card are', () => {
    const texts = [line('Library visits this spring', 40, 30), line('Alder Draw branch: 1,300 visits', 40, 100), line('Willow Quay branch: 700', 40, 176)];
    const bars = measure(texts, [g([30, 80, 549, 135]), g([30, 156, 329, 211])]);
    expect(drawnOf(bars)).toMatchObject({ block: false, notBlock: 'words in shapes of their own' });
    expect(failed(picture({ alt: 'Visits' }), bars)).toEqual([]);
    expect(drawnOf(measure(texts)).block).toBe(true);
    // (Its 1.1.1: "Visits" is shorter than the words and may say them briefly, for a person to check: cut round, S1.)
    expect(failed(picture({ alt: 'Visits' }), measure(texts))).toEqual(['1.4.5']);
    expect(failed(picture({ alt: 'Flyer' }), measure(texts))).toEqual(['1.1.1', '1.4.5']);
  });
});

describe('what the page gives (givenShare, compareLines)', () => {
  it('a line is given when more than half of its words stand together in the alternative or in one block of text', () => {
    const ls = lines(['Closed Saturday, December 5', 'Marlow Activity House']);
    expect(givenShare(ls, ['Winter hours'], pageWordIndex(['Printed copies are available at Marlow Activity House during staffed hours.']))).toMatchObject({ share: 3 / 7, missing: ['Closed Saturday, December 5'] });
    expect(givenShare(ls, ['The desk is closed Saturday, December 5.'], pageWordIndex(['See you at Marlow Activity House.'])).share).toBe(1);
  });
  it('words spread over the page, a few in each paragraph, give nothing', () => {
    const ls = lines(['Check-in window: 7:30 a.m. to 3:30 p.m.']);
    const far = ['Our check-in desk is new.', 'x', 'y', 'z', 'The window faces east.', 'x', 'y', 'z', 'Doors open at 7:30 a.m.', 'x', 'y', 'z', 'Buses leave at 3:30 p.m.'];
    expect(givenShare(ls, [], pageWordIndex(far)).share).toBe(0);
  });
  it('a term and its value in the next block (a list of terms, the cells of a row) give the line', () => {
    const ls = lines(['Check-in window: 7:30 a.m. to 3:30 p.m.']);
    expect(givenShare(ls, [], pageWordIndex(['Check-in window', '7:30 a.m. to 3:30 p.m.'])).share).toBe(1);
  });
  it('times and numbers are compared as written out: "1–3 p.m." is "1 to 3 PM"', () => {
    expect(givenShare(lines(['Friday, November 13 · 1–3 p.m.']), ['Friday, November 13, from 1 to 3 PM'], pageWordIndex([])).share).toBe(1);
  });
  it('words are compared without their plural, past and -ing endings, so the same thing said another way is given', () => {
    const ls = lines(['Enter west door. Turn right at the desk to reach the hold shelf.']);
    expect(givenShare(ls, [], pageWordIndex(['Holds are on the shelf to the right of the desk, just inside the west entrance.'])).share).toBe(1);
    expect(['holds', 'closed', 'closes', 'turning', 'libraries', 'glass', 'bus', 'this', '2025s'].map(wordStem)).toEqual(['hold', 'clos', 'clos', 'turn', 'library', 'glass', 'bus', 'this', '2025s']);
  });
  it('a picture with no word to compare is given', () => {
    expect(givenShare(lines(['→ A']), [], pageWordIndex([]))).toMatchObject({ share: 1, total: 0 });
  });
  it('what a text shares with the same thing written another way: the numbers of a date or a time, and the names of months, days and small numbers', () => {
    const shared = (a: string, b: string) => [...wordKeys(a)].filter((k) => wordKeys(b).has(k)).sort();
    expect(shared('Friday, November 13 · 1–3 p.m.', 'Fri 11/13, 13:00 to 15:00')).toEqual(['#1', '#11', '#13', '#3', '1pm', '3pm', '@d5']);
    expect(shared('Closed Saturday, December 5', 'Cerrado el sábado 5 de diciembre')).toEqual(['#12', '#5', '5', '@d6', '@m12']);
    expect(shared('Room four opens at noon', 'Room 4 opens at 12')).toEqual(['#12', '#4', 'open', 'room']);
    expect(shared('Use the west garden gate.', 'Students reading in the school library.')).toEqual([]);
  });
  it('a line that is not given may be said in other words: a third of its words or numbers (and two) shared anywhere, or a quarter (and one) next to the picture', () => {
    const ls = lines(['Parking costs nothing on Saturdays.']);
    const page = pageWordIndex(['Welcome.', 'x', 'y', 'z', 'Free parking on Saturdays.', 'x', 'y', 'z', 'Our lot has forty spaces for parking.']);
    expect(compareLines(ls, [], page).lines).toEqual([{ text: 'Parking costs nothing on Saturdays.', weight: 4, given: false, possible: true }]);
    // One shared word far from the picture is a word of the subject, not the same thing said again.
    const far = pageWordIndex(['Welcome.', 'x', 'y', 'z', 'Our lot has forty spaces for parking.']);
    expect(compareLines(ls, [], far, 0).lines[0]).toMatchObject({ given: false, possible: false });
    // The same block right after the picture may be its caption.
    expect(compareLines(ls, [], far, 4).lines[0]).toMatchObject({ given: false, possible: true });
    // One of the picture's own texts shares a word with it.
    expect(compareLines(ls, ['Parking'], pageWordIndex([])).lines[0]).toMatchObject({ given: false, possible: true });
  });
});

describe('alternatives that say nothing of what the picture says (emptyAlternative, sourceKind)', () => {
  it('names only the kind of picture, or is a file name', () => {
    for (const alt of ['Map', 'Diagram', 'image of a map', 'Chart 2', 'The flyer', 'Mapa', 'Floor plan', 'Bar chart', 'Site plan']) expect(emptyAlternative(alt), alt).toBe('kind');
    for (const alt of ['gate-map.svg', 'export-final-v3.svg', 'IMG_2041.JPG']) expect(emptyAlternative(alt), alt).toBe('file');
  });
  it('an alternative that names what the picture is of is not judged', () => {
    for (const alt of ['Water bill', 'Winter hours schedule', 'Map of the Creekside trail', 'Trail map', '', 'The picture below shows the map of all routes', 'Floor', 'Site']) expect(emptyAlternative(alt), alt).toBeUndefined();
  });
  it('a label is too short to give a picture’s words; a text of about their length may say them another way', () => {
    expect(sourceKind('', 16)).toBe('none');
    expect(sourceKind('notice-final.svg', 16)).toBe('file');
    expect(sourceKind('Flyer', 16)).toBe('kind');
    expect(sourceKind('Winter hours schedule', 16)).toBe('label');
    expect(sourceKind('Students reading in the school library.', 16)).toBe('label');
    expect(sourceKind('Students reading quietly in the school library on a sunny afternoon', 16)).toBe('text');
    expect(sourceKind('Free parking on Saturdays.', 4)).toBe('text');
  });
});

// S1: comparing words can show that a text gives a picture's words, never that it does not.
describe('S1: whether a picture’s words are given, are not, or may be given in other words (wordsVerdict)', () => {
  const sign = lines(['Parking costs nothing on Saturdays.']);
  const notice = drawnOf(measure(NOTICE)).lines;
  /** A page's text as compared: its general text set apart (the site's header), the rest in the picture's place; `heads` marks headings. */
  const index = (blocks: string[], heads?: boolean[]) => pageWordIndex(blocks, placed(blocks), heads);
  const page = index(ENGLISH);
  const alt = (text: string) => [{ text, what: 'text alternative' }];
  /** The verdict for a picture in place 1, at `at` in the page's text. */
  const verdict = (ls: typeof notice, own: ReturnType<typeof alt>, pg = page, at = 0) => wordsVerdict(ls, own, pg, at, 1);
  const SAID = 'Households may collect their bundles before the weekend from the reception counter upstairs.';
  const BESIDE = { state: 'open', why: 'the text beside it is long enough to give its words in other words or in another language' };
  it('the review’s sign: an alternative that says the same in other words is left open, never failed', () => {
    expect(verdict(sign, alt('Free parking on Saturdays.'))).toEqual({ state: 'open', why: 'its text alternative may give its words in other words or in another language' });
    expect(failed(picture({ alt: 'Free parking on Saturdays.' }), measure([line('Parking costs nothing on Saturdays.', 30, 60)]))).toEqual(['1.4.5']);
    expect(judged(picture({ alt: 'Free parking on Saturdays.' }), measure([line('Parking costs nothing on Saturdays.', 30, 60)]))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
  });
  it('a date and a time written another way give the line; a translation is given by what it keeps, or left open', () => {
    expect(verdict(notice, alt('Packet pick-up for families on Fri 11/13 from 13:00 to 15:00 in room four of the Alder Draw office; enter by the garden gate on the west side.')).state).toBe('given');
    // A translation that keeps the date, the time and the names gives those lines; one with nothing to match is left open.
    expect(verdict(notice, alt('Recogida de paquetes para familias: viernes 13 de noviembre, de 1 a 3 de la tarde, oficina de Alder Draw, sala 4. Use la puerta oeste del jardín.')).state).toBe('given');
    expect(verdict(sign, alt('El estacionamiento no cuesta nada los fines de semana.'))).toEqual({ state: 'open', why: 'its text alternative may give its words in other words or in another language' });
  });
  it('an alternative that is empty, a file name or the name of a kind, with nothing on the page: not given; a short label may say it briefly: open (cut round, S1)', () => {
    for (const text of ['', 'notice-final.svg', 'Flyer']) {
      expect(verdict(notice, alt(text)), text).toMatchObject({ state: 'absent', share: 0 });
    }
    // Red on the lane before the cut round: a third of the words or fewer was ruled out as a label.
    for (const text of ['Winter hours schedule', 'Students reading in the school library.']) {
      expect(verdict(notice, alt(text)), text).toEqual({ state: 'open', why: 'its text alternative is shorter than the words it draws and may still say what they say: a person should check it' });
    }
  });
  it('a text on the page that shares words or numbers with the lines may say them another way: left open', () => {
    const far = index([...ENGLISH, 'Latest postings', 'x', 'y', 'z', 'Archive', 'Packets go out on Friday the 13th at the garden gate.'], [false, false, true, false, false, false, true, false]);
    expect(verdict(notice, alt(''), far, 3)).toEqual({ state: 'open', why: 'a text on the page shares words or numbers with it and may give its words another way' });
    // One word of the subject somewhere on the page is not the same thing said again.
    const subject = index([...ENGLISH, 'Latest postings', 'x', 'y', 'z', 'Archive', 'The garden club meets in spring.', 'More'], [false, false, true, false, false, false, true, false, false]);
    expect(verdict(notice, alt(''), subject, 3).state).toBe('absent');
  });
  it('a sentence in the picture’s section of the page may say its words in other words, whatever its own words: left open; a heading or a label may not', () => {
    // The review's class, next to the picture: nothing in common with the notice, and long enough to restate it.
    expect(verdict(notice, alt(''), index([...ENGLISH, SAID]), 2)).toEqual(BESIDE);
    expect(verdict(notice, alt(''), index([...ENGLISH, SAID]), 3)).toEqual(BESIDE);
    // A heading and a short label beside it are too short to say it: the picture stands alone in its section.
    expect(verdict(notice, alt(''), index(['Latest postings', 'Read more'], [true, false]), 1).state).toBe('absent');
    // Its own alternative, which stands in the page's text too, is not "the text beside it".
    expect(verdict(notice, alt('students-reading-in-the-school-library.png'), index(['Latest postings', 'students-reading-in-the-school-library.png', 'Read more'], [true, false, false]), 1).state).toBe('absent');
    // A picture whose place in the page's text is not known is left open.
    expect(verdict(notice, alt(''), page, -1)).toEqual({ state: 'open', why: 'its place in the page\'s text is not known, so the text beside it could not be told' });
  });
  it('a caption, a credit or a control’s name between the picture and the sentence does not part them (red: only the block next to the picture was read)', () => {
    // After the picture: its caption, then the paragraph. Before it: the paragraph, a carousel's name, then the picture.
    expect(verdict(notice, alt(''), index(['Latest postings', 'Photo: staff', SAID], [true, false, false]), 1)).toEqual(BESIDE);
    expect(verdict(notice, alt(''), index(['Latest postings', SAID, 'Announcements', 'More postings.', 'Next posting'], [true, false, false, false, false]), 3)).toEqual(BESIDE);
    // Several short lines between them, too.
    expect(verdict(notice, alt(''), index(['Latest postings', 'Help', 'Print', 'Share', 'Figure 2', SAID], [true, false, false, false, false, false]), 1)).toEqual(BESIDE);
  });
  it('the section of the page a picture stands in is bounded by headings; a heading right after the picture may introduce its text', () => {
    // The sentence before the heading that starts the picture's section is another section's.
    expect(verdict(notice, alt(''), index([SAID, 'Latest postings', 'Read more'], [false, true, false]), 2).state).toBe('absent');
    // The heading comes right after the picture (a label between them at most): what it introduces may be the picture's text.
    expect(verdict(notice, alt(''), index(['Latest postings', 'Text of the notice', SAID], [true, true, false]), 1)).toEqual(BESIDE);
    expect(verdict(notice, alt(''), index(['Latest postings', 'Figure 2', 'Text of the notice', SAID], [true, false, true, false]), 1)).toEqual(BESIDE);
    // The section after that one is not the picture's.
    expect(verdict(notice, alt(''), index(['Latest postings', 'Archive', 'None yet', 'Contact', SAID], [true, true, false, true, false]), 1).state).toBe('absent');
    // A sentence between the picture and the next heading: that heading starts something else, which is not read
    // (the size is of "Latest postings" and "Doors open early today." together, not of the sentence after "Archive").
    const short = lines(['Use the west garden gate.', 'Alder Draw office, room 4']);
    expect(compareLines(short, [], index(['Latest postings', 'Doors open early today.', 'Archive', SAID], [true, false, true, false]), 1, 1).beside).toBe(6);
    expect(compareLines(short, [], index(['Latest postings', 'Archive', SAID], [true, true, false]), 1, 1).beside).toBe(7);
    // A page with no headings is one section.
    expect(compareLines(short, [], index([SAID, 'x1', 'x2', 'x3', 'x4', 'Posted today']), 6, 1).beside).toBe(7);
  });
  it('text set apart from the picture is not beside it: the site’s footer after the last picture of the content, the header before the first', () => {
    const parts = ['Latest postings', SAID];
    expect(wordsVerdict(notice, alt(''), pageWordIndex(parts, [1, 2], [true, false]), 1, 1).state).toBe('absent');
    expect(wordsVerdict(notice, alt(''), pageWordIndex(parts, [1, 1], [true, false]), 1, 1)).toEqual(BESIDE);
    // Nothing past a part set apart is read either.
    expect(wordsVerdict(notice, alt(''), pageWordIndex(['Latest postings', 'Site map', SAID], [1, 2, 1], [true, false, false]), 1, 1).state).toBe('absent');
    expect(wordsVerdict(notice, alt(''), pageWordIndex([SAID, 'Search', 'Posted today'], [1, 2, 1]), 3, 1).state).toBe('absent');
  });
  it('a page in another language than the picture’s words, or in two languages, is never compared', () => {
    const spanish = pageWordIndex(['Bienvenidos al distrito.', 'Las oficinas están abiertas para todos los estudiantes y sus familias durante el año.', 'Los paquetes se entregan en la oficina con cita.']);
    expect(wordsVerdict(notice, alt(''), spanish, 0)).toEqual({ state: 'open', why: 'its words could not be shown to be in the language of the page\'s text' });
    const both = pageWordIndex([...ENGLISH, 'The buses are for all the students who have their pass with them.', 'Los autobuses son para todos los estudiantes que tienen su pase.', 'Las oficinas están abiertas para las familias durante el año, como siempre.', 'Los paquetes se entregan en la oficina con cita para todos.']);
    expect(both.mixed).toBe(true);
    expect(wordsVerdict(notice, alt(''), both, 0)).toEqual({ state: 'open', why: 'the page has text in more than one language, where its words may be given' });
    expect(page).toMatchObject({ lang: 'en', mixed: false });
  });
  it('the language of a picture’s words is told by its short words and the names of days and months too (red: such a picture was never decided)', () => {
    const unsure = { state: 'open', why: 'its words could not be shown to be in the language of the page\'s text' };
    // No function word of three letters or more, and no word the page has: "is", "at" and the names of days show English.
    expect(languageSigns(['temporary', 'stop', '126', 'is', 'on', 'alder', 'avenue', 'at', 'fern', 'lane'])).toEqual({ en: 2 });
    expect(verdict(lines(['Alder Avenue', 'Fern Lane', 'Temporary stop 126 is on Alder Avenue at Fern Lane.']), alt('')).state).toBe('absent');
    expect(verdict(lines(['No service on Thursday, November 26', 'Reduced service on Friday', 'Book rides three days ahead.']), alt('')).state).toBe('absent');
    // Nothing that tells its language, and no word the page has: left open.
    expect(verdict(lines(['Yearbook photo retakes', 'Music room, east wing', 'Signed retake slip']), alt(''))).toEqual(unsure);
    // Another language's signs only, or more of them than of the page's (a notice in Spanish with an English name in it).
    expect(verdict(lines(['Clínica gratuita el sábado y el domingo', 'Biblioteca central, sala 4', 'Traiga su tarjeta']), alt(''))).toEqual(unsure);
    expect(languageSigns(['reunión', 'el', 'martes', 'y', 'el', 'jueves', 'at', 'the', 'grange', 'hall'])).toMatchObject({ es: 5, en: 2 });
    expect(verdict(lines(['Reunión el martes y el jueves at the Grange Hall', 'Traiga su tarjeta de la biblioteca']), alt(''))).toEqual(unsure);
    // A name two languages spell alike counts for both: it does not make the picture foreign.
    expect(languageSigns(['november', '26'])).toEqual({ en: 1, de: 1 });
    expect(verdict(lines(['Parking costs nothing on Saturdays.', 'Use the garden gate']), alt('')).state).toBe('absent');
  });
  it('a picture that shows no language is compared only when it shares a word with the page: not a number, and with no letter English does not write (red: a year, or a street name in a Spanish notice, was enough)', () => {
    const unsure = { state: 'open', why: 'its words could not be shown to be in the language of the page\'s text' };
    const town = index([...ENGLISH, 'Latest postings', 'Posted', 'Archive', 'None', 'Contact', 'Alder Draw School, 2026'], [false, false, true, false, true, false, true, false]);
    // No sign of any language; the page has the place's name too: compared, and nothing gives its words.
    expect(verdict(lines(['Alder Draw yearbook retakes', 'Music room, east wing', 'Signed retake slip']), alt(''), town, 3).state).toBe('absent');
    // Only a number in common says nothing of its language.
    expect(verdict(lines(['Yearbook retakes 2026', 'Music room, east wing', 'Signed retake slip']), alt(''), town, 3)).toEqual(unsure);
    // The place's name in a notice in Spanish with no function word: its accents show it is not English.
    expect(verdict(lines(['Reunión comunitaria, Alder Draw', 'Biblioteca central', 'Entrada gratuita hoy']), alt(''), town, 3)).toEqual(unsure);
    // Another script.
    expect(verdict(lines(['Собрание жителей, Alder Draw', 'Библиотека', 'Вход свободный сегодня']), alt(''), town, 3)).toEqual(unsure);
    // An accented name in an English notice does not outweigh its English words.
    expect(verdict(lines(['Peña Boulevard is closed at the bridge', 'Use the east ramp']), alt(''), town, 3).state).toBe('absent');
  });
  it('a picture with too few words to compare is given', () => {
    expect(verdict(lines(['Open today']), alt('')).state).toBe('given');
  });
});

// S5: where a picture is painted and what shows of it is worked out, not taken from the element's box.
describe('S5: where a picture’s lines are as the page shows it', () => {
  const m = measure(NOTICE);
  const rows = drawnOf(m).rows;
  it('a background’s tile: contain, cover, its own size, a set size, percentages, the boxes it is placed in and clipped by', () => {
    expect(backgroundTile(layout({ box: [800, 220] }), m)).toEqual({ tile: { x: 106.66666666666669, y: 0, w: 586.6666666666666, h: 220 }, clip: { x: 0, y: 0, w: 800, h: 220 } });
    expect(backgroundTile(layout({ size: 'cover', box: [800, 220], position: '0% 0%' }), m)!.tile).toEqual({ x: 0, y: 0, w: 800, h: 300 });
    expect(backgroundTile(layout({ size: 'auto', position: '0% 0%' }), m)!.tile).toEqual({ x: 0, y: 0, w: 640, h: 240 });
    expect(backgroundTile(layout({ size: '16px', position: '0% 0%' }), m)!.tile).toEqual({ x: 0, y: 0, w: 16, h: 6 });
    expect(backgroundTile(layout({ size: '50% auto', position: '100% 100%', box: [800, 400] }), m)!.tile).toEqual({ x: 400, y: 250, w: 400, h: 150 });
    expect(backgroundTile(layout({ size: 'auto', position: 'calc(100% - 10px) calc(100% - 5px)', box: [700, 300] }), m)!.tile).toEqual({ x: 50, y: 55, w: 640, h: 240 });
    expect(backgroundTile(layout({ size: 'auto', position: '0px 0px', origin: 'content-box', clip: 'content-box', box: [700, 300], border: [2, 2, 2, 2], padding: [10, 10, 10, 10] }), m))
      .toEqual({ tile: { x: 12, y: 12, w: 640, h: 240 }, clip: { x: 12, y: 12, w: 676, h: 276 } });
    // A file with a shape only fills the area whole; one whose size is in units not converted is not placed.
    expect(backgroundTile(layout({ size: 'auto', box: [800, 220] }), { natural: [640, 240], intrinsic: 'ratio' })!.tile.w).toBeCloseTo(586.67, 1);
    expect(backgroundTile(layout({ size: 'auto' }), { natural: [640, 240], intrinsic: 'unknown' })).toBeUndefined();
  });
  it('a repeated tile: the first one that starts inside the clip box is the one looked at', () => {
    expect(backgroundTile(layout({ size: '320px 120px', position: '-100px 0px', repeat: 'repeat', box: [800, 240] }), m)!.tile).toEqual({ x: 220, y: 0, w: 320, h: 120 });
    expect(backgroundTile(layout({ size: '320px 120px', position: '-100px 0px', repeat: 'repeat-y', box: [800, 240] }), m)!.tile.x).toBe(-100);
  });
  it('is not worked out: a layer under another, a fixed background, an effect, content of the element’s own, units and keywords it does not resolve', () => {
    for (const over of [{ layers: 2, layer: 1 }, { attachment: 'fixed' }, { effect: true }, { inner: true }, { size: '10em auto' }, { position: 'right 10px bottom 5px' }, { repeat: 'space' }, { clip: 'text' }] as Partial<BackgroundLayout>[]) {
      expect(backgroundTile(layout(over), m), JSON.stringify(over)).toBeUndefined();
    }
    expect(backgroundTile(layout({ layers: 2, layer: 0 }), m)).toBeDefined();
  });
  it('the review’s backgrounds: one placed outside its box shows no word; one painted 16 px wide is not legible; neither fails', () => {
    const off = background({}, { size: 'auto', position: '700px 0px' });
    expect(placementOf(off, m, rows).state).toBe('none');
    expect(judged(off, m)).toEqual([]);
    const tiny = background({}, { size: '16px', position: '0% 0%' });
    expect(placementOf(tiny, m, rows)).toMatchObject({ state: 'shown', scale: 0.025 });
    expect(judged(tiny, m)).toEqual([]);
    // The same background shown whole fails as before.
    expect(failed(background(), m)).toEqual(['1.1.1', '1.4.5']);
  });
  it('part of the lines cut off, or a layout that is not worked out, is left open: "not testable"', () => {
    const half = background({}, { size: 'auto', position: '0px -100px' });
    expect(placementOf(half, m, rows).state).toBe('part');
    expect(judged(half, m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(background({}, { layers: 2, layer: 1 }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    // A rounded corner a line reaches into, a transform that turns the element, a container that cuts part of it off.
    expect(placementOf(background({}, { radius: 60 }), m, rows).state).toBe('part');
    expect(placementOf(background({}, { radius: 12 }), m, rows).state).toBe('shown');
    expect(placementOf(background({}, { scale: [1, 0.6] }), m, rows).state).toBe('unknown');
    expect(placementOf(picture({ showing: 0.6 }), m, rows).state).toBe('part');
    expect(placementOf(picture({ showing: 0 }), m, rows).state).toBe('none');
  });
  it('an image’s tile: object-fit and object-position; a file cropped by `cover` is left open, one fitted whole is judged', () => {
    expect(imageTile({ width: 640, height: 240, fit: 'fill', fitAt: '50% 50%' }, m)!.tile).toEqual({ x: 0, y: 0, w: 640, h: 240 });
    expect(imageTile({ width: 200, height: 200, fit: 'cover', fitAt: '50% 50%' }, m)!.tile).toEqual({ x: -166.66666666666669, y: 0, w: 533.3333333333334, h: 200 });
    expect(imageTile({ width: 800, height: 240, fit: 'contain', fitAt: '0% 50%' }, m)!.tile).toEqual({ x: 0, y: 0, w: 640, h: 240 });
    expect(imageTile({ width: 320, height: 120, fit: 'none', fitAt: '0% 0%' }, m)!.tile).toEqual({ x: 0, y: 0, w: 640, h: 240 });
    expect(imageTile({ width: 800, height: 400, fit: 'scale-down', fitAt: '50% 50%' }, m)!.tile).toEqual({ x: 80, y: 80, w: 640, h: 240 });
    expect(judged(picture({ width: 200, height: 200, fit: 'cover' }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(failed(picture({ width: 800, height: 240, fit: 'contain', alt: 'Flyer' }), m)).toEqual(['1.1.1', '1.4.5']);
    // A lazy picture not loaded yet is taken at its file's size.
    expect(placementOf(picture({ width: 0, height: 0 }), m, rows)).toMatchObject({ state: 'shown', scale: 1 });
  });
  it('a drawing fitted in a tile of another shape: whole and centred, stretched, or cropped by `slice`', () => {
    const tile = { x: 0, y: 0, w: 640, h: 480 };
    expect(placeRows([[0, 0, 639, 239]], m, tile, tile)).toMatchObject({ state: 'shown', scale: 1, boxes: [[0, 120, 640, 360]] });
    expect(placeRows([[0, 0, 639, 239]], { ...m, aspect: 'none' }, tile, tile)).toMatchObject({ state: 'shown', scale: 1, boxes: [[0, 0, 640, 480]] });
    expect(placeRows([[0, 0, 639, 239]], { ...m, aspect: 'xMidYMid slice' }, tile, tile).state).toBe('part');
    expect(placeRows([[0, 0, 639, 239]], { ...m, view: [100, 100] }, tile, tile).state).toBe('unknown');
  });
});

describe('one page’s findings (judgePictures)', () => {
  const m = measure(NOTICE);
  it('1.4.5: a block of text fails whatever its alternative says; 1.1.1 only when its words are given nowhere', () => {
    const complete = picture({ alt: 'Family packet pickup, Friday, November 13, 1 to 3 p.m., Alder Draw office, room 4. Use the west garden gate.' });
    expect(failed(complete, m)).toEqual(['1.4.5']);
    expect(failed(picture({ alt: 'Flyer' }), m)).toEqual(['1.1.1', '1.4.5']);
    // A short alternative that is no kind word may say it briefly: 1.1.1 is for a person to check (cut round, S1).
    expect(judged(picture({ alt: 'Students reading in the school library.' }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
    // The page's own text gives the words: the alternative need not.
    expect(failed(picture({ alt: 'Notice' }), m, [...ENGLISH, 'Family packet pickup is Friday, November 13 from 1–3 p.m.', 'Come to the Alder Draw office, room 4, and use the west garden gate.'])).toEqual(['1.4.5']);
  });

  it('1.4.5 never fails a logo, a CAPTCHA, a sample of how something looks, or a picture shown too small to read', () => {
    expect(failed(picture({ logo: true }), m)).toEqual([]);
    expect(failed(picture({ captcha: true }), m)).toEqual([]);
    expect(failed(picture({ sample: true, alt: 'Flyer' }), m)).toEqual([]);
    expect(failed(picture({ width: 96, height: 36 }), m)).toEqual([]);
  });

  it('one or two short lines that are no sentence, named word for word by the alternative, may be a name or a logo: not failed', () => {
    const motto = measure([line('Birch Valley Water District', 20, 30), line('Clean water for the valley since 1952', 20, 70)]);
    expect(failed(picture({ alt: 'Birch Valley Water District: clean water for the valley since 1952' }), motto)).toEqual([]);
    // The same two lines with a label for an alternative, a sentence, and three lines, are a picture of text.
    expect(failed(picture({ alt: 'Our crew' }), motto)).toEqual(['1.4.5']);
    expect(failed(picture({ alt: 'Flyer' }), motto)).toEqual(['1.1.1', '1.4.5']);
    const sentence = measure([line('Keep your permit card visible from the street.', 20, 40)]);
    expect(failed(picture({ alt: 'Keep your permit card visible from the street.' }), sentence)).toEqual(['1.4.5']);
    expect(failed(picture({ alt: 'Family packet pickup. Friday, November 13 · 1–3 p.m. Alder Draw office, room 4.' }), measure(NOTICE.slice(0, 3)))).toEqual(['1.4.5']);
  });

  it('1.1.1 hidden: a picture kept from screen readers that draws a statement the page gives nowhere', () => {
    const map = measure([line('WEST ENTRANCE', 68, 71), line('HOLDS', 445, 146), line('Enter west door. Turn right at the desk to reach the hold shelf.', 20, 206)], [{ n: 2800, box: [5, 122, 426, 175], text: 0, clear: false }]);
    expect(failed(picture({ alt: '' }), map)).toEqual(['1.1.1']);
    expect(failed(picture({ alt: 'Pickup map', hidden: true }), map)).toEqual(['1.1.1']);
    // The text next to it says the same: an empty alternative is right.
    expect(failed(picture({ alt: '' }), map, [...ENGLISH, 'Holds are on the shelf past the west entrance.', 'Enter by the west door and turn right at the desk to reach the hold shelf.'])).toEqual([]);
    // Labels only (no statement), and a short sign: decoration may carry a few words.
    expect(failed(picture({ alt: '' }), measure([line('RETURNS', 330, 177), line('EVENING ENTRANCE', 198, 84)], [{ n: 30_000, box: [0, 0, 499, 244], text: 0, clear: false }]))).toEqual([]);
    expect(failed(picture({ alt: '' }), measure([line('Welcome back to school, Wildcats', 100, 80)], [{ n: 30_000, box: [0, 0, 499, 244], text: 0, clear: false }]))).toEqual([]);
  });

  it('a hidden copy of a picture that is also shown with an alternative (a slideshow\'s clone) hides nothing', () => {
    const map = measure([line('WEST ENTRANCE', 68, 71), line('Enter west door. Turn right at the desk to reach the hold shelf.', 20, 206)], [{ n: 2800, box: [5, 122, 426, 175], text: 0, clear: false }]);
    const shown = picture({ target: '#slide', alt: 'Pickup map: enter by the west door and turn right at the desk to reach the hold shelf. West entrance.' });
    const clone = picture({ target: '#clone', alt: 'Pickup map: enter by the west door and turn right at the desk to reach the hold shelf. West entrance.', hidden: true });
    const got = (ps: Picture[]) => judgePictures(read(ps), new Map([[shown.src, { src: shown.src, measure: map }]])).findings.filter((f) => f.status === 'failed').map((f) => [f.criterion, f.target]);
    expect(got([shown, clone])).toEqual([]);
    expect(got([clone])).toEqual([['1.1.1', '#clone']]);
  });

  it('1.1.1 kind: an alternative that only names the kind of picture, or is a file name, on a picture that draws a statement', () => {
    const map = measure([line('North gate CLOSED', 60, 40), line('Accessible detour: east entrance to the lodge', 200, 150), line('Lodge', 520, 200)], [{ n: 40_000, box: [40, 60, 600, 220], text: 0, clear: false }]);
    expect(failed(picture({ alt: 'Map' }), map)).toEqual(['1.1.1']);
    expect(failed(picture({ alt: 'gate-map.svg' }), map)).toEqual(['1.1.1']);
    // An alternative that names the picture's subject is the AI review's to judge; a long description on the page is enough.
    expect(failed(picture({ alt: 'Map of Marlow Meadow' }), map)).toEqual([]);
    expect(failed(picture({ alt: 'Map' }), map, [...ENGLISH, 'The north gate is closed.', 'Accessible detour: use the east entrance to reach the lodge.'])).toEqual([]);
    expect(failed(picture({ alt: 'Map', textVersion: true }), map)).toEqual([]);
  });

  // S1: the text beside a picture (its section of the page) is never judged by its words.
  it('S1: a picture with a sentence in its section of the page is left open for 1.1.1, whatever the sentence says; alone under its heading, it fails', () => {
    const SAID = 'Our gymnasium floor was refinished over the summer break by volunteers.';
    const on = (blocks: string[], heads: boolean[], at: number) => judgePictures(read([picture({ alt: '', at })], blocks, undefined, heads), new Map([['https://site.test/a.svg', { src: 'https://site.test/a.svg', measure: m }]])).findings;
    const got = on(['Latest postings', SAID, 'Read more'], [true, false, false], 1);
    expect(got.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
    expect(got[0]!.detail).toBe('an SVG picture that draws words could not be decided: the text beside it is long enough to give its words in other words or in another language');
    // Its caption between the two, or the sentence before a carousel's name: still beside it.
    expect(on(['Latest postings', 'Photo: staff', SAID], [true, false, false], 1).map((f) => f.status)).toEqual(['not_testable', 'failed']);
    expect(on(['Latest postings', SAID, 'Announcements'], [true, false, false], 3).map((f) => f.status)).toEqual(['not_testable', 'failed']);
    // Alone under its heading, with the sentence under the heading before: it fails.
    expect(on([SAID, 'Latest postings', 'Read more'], [false, true, false], 2).map((f) => f.status)).toEqual(['failed', 'failed']);
  });

  it('1.1.1 is never failed for a picture inside a link or a button, or with no alt attribute at all (the missing-alt rule’s)', () => {
    expect(failed(picture({ alt: 'Flyer', control: 'only' }), m)).toEqual(['1.4.5']);
    expect(failed(picture({ alt: 'Flyer', control: 'text' }), m)).toEqual(['1.4.5']);
    expect(failed(picture({ alt: null }), m)).toEqual(['1.4.5']);
  });

  it('a background with text or a name of its own is not a background picture with no alternative', () => {
    expect(failed(background({ ownText: 'Family packet pickup' }), m)).toEqual(['1.4.5']);
    expect(failed(background({ name: 'Family packet pickup notice' }), m)).toEqual(['1.4.5']);
  });

  it('says "not applicable" with no SVG picture or none that draws words, and nothing when pictures were judged clean', () => {
    expect(judgePictures(read([picture({ svg: false, src: 'https://site.test/a.png' })]), new Map()).findings.map((f) => [f.criterion, f.status, f.detail]))
      .toEqual([['1.1.1', 'not_applicable', 'no picture on this page is an SVG file'], ['1.4.5', 'not_applicable', 'no picture on this page is an SVG file']]);
    expect(judged(picture(), measure([], [], 0, { width: 0, height: 0, natural: [24, 24] }))).toEqual([['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']]);
    const labelled = measure([line('Alder Span', 60, 40), line('Cedar Bend', 300, 90)], [{ n: 40_000, box: [40, 60, 600, 220], text: 0, clear: false }]);
    expect(judged(picture({ alt: 'Trail from Alder Span to Cedar Bend' }), labelled)).toEqual([]);
  });

  // S9: a measurement that was not finished says nothing: never "not applicable", never clean.
  it('S9: a picture whose words could not be measured is "not testable", never clean, never failed and never "not applicable"', () => {
    const src = 'https://site.test/a.svg';
    const open = [['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']];
    for (const error of ['unread', 'too-large', 'unsafe', 'unsupported', 'time'] as const) expect(judged(picture(), { src, error }), error).toEqual(open);
    expect(judged(picture(), { src, error: 'time', hasText: false })).toEqual(open);
    expect(judged(picture(), { src, error: 'not-drawn', hasText: true })).toEqual(open);
    expect(judged(picture(), { src, error: 'not-svg', hasText: true })).toEqual(open);
    // More text elements, or more words, than are measured one by one.
    expect(judged(picture(), measure(Array.from({ length: 50 }, (_, i): DrawnText => ({ text: `Label ${i}`, ink: -1, unseen: 0, bands: [] }))))).toEqual(open);
    expect(judgedAll(picture(), { src, error: 'too-large' })[0]!.detail).toBe('an SVG picture on this page could not be measured, so nothing is known of the words it draws: its file is larger than is read');
    // A file past the page's limit of files measured.
    expect(judgePictures(read([picture()]), new Map()).findings.map((f) => [f.criterion, f.status, f.detail]))
      .toEqual([['1.1.1', 'not_testable', 'this page has more SVG pictures than are measured (1 was not)'], ['1.4.5', 'not_testable', 'this page has more SVG pictures than are measured (1 was not)']]);
  });

  it('S9: what was established stays: a file read whole with no text element, one that is no SVG and has none, a picture too small to show a line of words', () => {
    const src = 'https://site.test/a.svg';
    const none = [['1.1.1', 'not_applicable'], ['1.4.5', 'not_applicable']];
    expect(judged(picture(), { src, error: 'not-svg', hasText: false })).toEqual(none);
    expect(judged(picture({ width: 24, height: 24 }), { src, error: 'unread' })).toEqual(none);
    expect(judgedAll(picture({ width: 24, height: 24 }), { src, error: 'unread' })[0]!.detail).toBe('no SVG picture on this page draws words (1 too small to show a line of words was not measured)');
    // A narrow, tall picture has room for lines of words: it is asked about.
    expect(judged(picture({ width: 90, height: 300 }), { src, error: 'unread' })).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });

  // S2, S6, S7: a picture whose words are not all shown, or whose file is not the one shown, is left open.
  it('S2: words partly covered or cut off in the file, or shown faintly, are left open; all of them showing is judged', () => {
    expect(judged(picture({ alt: 'Flyer' }), measure(NOTICE, [], 0, { seen: 0.93 }))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer' }), measure(NOTICE, [], 0, { seen: -1 }))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer', opacity: 0.3 }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer', effect: true }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer' }), measure(NOTICE, [], 0, { seen: 0.995 }))).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
  });

  it('S7: a file that is not of the size of the picture the browser decoded is not the file shown: "not testable"', () => {
    expect(judged(picture({ alt: 'Flyer', decoded: [300, 150] }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer', decoded: [640, 240] }), m)).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
    // The same file at twice the density (srcset 2x) is decoded at half its size, in the same shape.
    expect(judged(picture({ alt: 'Flyer', decoded: [320, 120] }), m)).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
    expect(judged(picture({ alt: 'Flyer', decoded: [320, 200] }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });

  // S3: nothing is said of words "given nowhere" when a text that could give them was cut or not read.
  it('S3: a page with more text than is compared, a text of the picture’s own that was cut, a page with more elements than are read: 1.1.1 is "not testable", 1.4.5 is still measured', () => {
    const map = new Map([['https://site.test/a.svg', { src: 'https://site.test/a.svg', measure: m }]]);
    const long: PicturesRead = { ...read([picture({ alt: 'Flyer' })]), blocksTruncated: true };
    expect(judgePictures(long, map).findings.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
    expect(judged(picture({ alt: 'Flyer', cut: true }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
    expect(judged(picture({ alt: 'Flyer' }), m)).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
    // A hidden picture may be shown elsewhere with an alternative, among the elements not read.
    const big: PicturesRead = { ...read([picture({ alt: '' })]), truncated: true };
    expect(judgePictures(big, map).findings.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
  });

  it('lists five of a kind and counts the rest', () => {
    const many = Array.from({ length: 7 }, (_, i) => picture({ target: `#p${i}`, alt: 'Flyer' }));
    const out = judgePictures(read(many), new Map([['https://site.test/a.svg', { src: 'https://site.test/a.svg', measure: m }]])).findings.filter((f) => f.criterion === '1.4.5');
    expect(out).toHaveLength(5);
    expect(out[4]!.detail).toContain('(2 more like this on this page)');
  });

  it('the rules are the ones the scoring document states', () => {
    expect(PICTURE_RULES).toMatchObject({
      blockWords: 5, statementWords: 5, statementPictureWords: 8, lineGiven: 0.5, pictureGiven: 0.5, nameWords: 12, grounds: 2, legiblePx: 6,
      seenShare: 0.98, showingShare: 0.98, possibleWords: 2, nearBlocks: 2, absentShare: 0.5, besideWords: 4,
    });
    expect([PICTURE_RULES.labelShare, PICTURE_RULES.besideShare, PICTURE_RULES.possibleShare, PICTURE_RULES.nearShare]).toEqual([1 / 3, 1 / 3, 1 / 3, 1 / 4]);
  });
});

// S7: a failure stands only when the page read before and after the measuring gives it both times.
describe('S7: the judgement that stands after the page was read twice (agreedJudgement)', () => {
  const m = measure(NOTICE);
  const map = new Map([['https://site.test/a.svg', { src: 'https://site.test/a.svg', measure: m }]]);
  const j = (p: Picture, blocks?: string[]) => judgePictures(read([p], blocks), map);
  const status = (x: { findings: { criterion: string; status: string }[] }) => x.findings.map((f) => [f.criterion, f.status]);
  it('the same failures both times stand', () => {
    expect(status(agreedJudgement(j(picture({ alt: 'Flyer' })), j(picture({ alt: 'Flyer' }))))).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
  });
  it('an alternative that arrived meanwhile takes the 1.1.1 failure away: "not testable", and 1.4.5 stands', () => {
    const after = j(picture({ alt: 'Family packet pickup: Friday, November 13, 1 to 3 p.m., Alder Draw office, room 4. Use the west garden gate.' }));
    const got = agreedJudgement(j(picture({ alt: 'Flyer' })), after);
    expect(status(got)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
    expect(got.findings[0]!.detail).toMatch(/^the page changed while its pictures were measured/);
    expect(got.failed).toEqual([{ criterion: '1.4.5', target: '#pic', rule: 'block' }]);
  });
  it('a picture that is gone, or a failure that appears only afterwards, is not confirmed either', () => {
    const gone = judgePictures(read([]), map);
    expect(status(agreedJudgement(j(picture({ alt: 'Flyer' })), gone))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(status(agreedJudgement(gone, j(picture({ alt: 'Flyer' }))))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });
  it('with no second reading nothing is confirmed; a clean page stays as it was read', () => {
    expect(status(agreedJudgement(j(picture({ alt: 'Flyer' })), undefined))).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    const clean = j(picture({ logo: true }));
    expect(status(agreedJudgement(clean, undefined))).toEqual([]);
    expect(status(agreedJudgement(clean, clean))).toEqual([]);
  });
});

describe('the full-tree review (cut round)', () => {
  const m = measure(NOTICE);
  it('S5: a file the browser loaded again between the two readings is not judged in either (withoutReloaded)', () => {
    const src = 'https://site.test/a.svg';
    const measured = new Map([[src, { src, measure: m }]]);
    const r = (over: Partial<Picture>) => read([picture(over)]);
    // Loaded once in both readings, or first loaded between them (a lazy picture): the measurement stands.
    expect(withoutReloaded(measured, r({ loads: 1 }), r({ loads: 1 })).get(src)).toEqual({ src, measure: m });
    expect(withoutReloaded(measured, r({ loads: 0 }), r({ loads: 1 })).get(src)).toEqual({ src, measure: m });
    // Loaded again, a record of its load gone, or shown at another decoded size: dropped.
    expect(withoutReloaded(measured, r({ loads: 1 }), r({ loads: 2 })).get(src)).toEqual({ src, error: 'reloaded' });
    expect(withoutReloaded(measured, r({ loads: 1 }), r({ loads: 0 })).get(src)).toEqual({ src, error: 'reloaded' });
    expect(withoutReloaded(measured, r({ loads: 1, decoded: [640, 240] }), r({ loads: 1, decoded: [320, 240] })).get(src)).toEqual({ src, error: 'reloaded' });
    const stands = withoutReloaded(measured, r({ alt: '' }), r({ alt: '', loads: 2 }));
    expect(judgePictures(read([picture({ alt: '' })]), stands).findings.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });
  it('S4: unresolved painting (padding, a border, a legacy clip, rounded corners) leaves both criteria open', () => {
    expect(judged(picture({ alt: 'Flyer', unresolved: 'padding or a border on it' }), m)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
    expect(judged(picture({ alt: 'Flyer' }), m)).toEqual([['1.1.1', 'failed'], ['1.4.5', 'failed']]);
  });
  it('S6: with a frame of the page unread, 1.1.1 is open; 1.4.5 is not a comparison of words and stands', () => {
    const page: PicturesRead = { ...read([picture({ alt: 'Flyer' })]), framesUnread: true };
    expect(judgePictures(page, new Map([['https://site.test/a.svg', { src: 'https://site.test/a.svg', measure: m }]])).findings.map((f) => [f.criterion, f.status])).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'failed']]);
  });
  it('S3: words on two grounds, one right under the other, read as a block but are left open', () => {
    const stacked = measure([line('Renewable sources 60 percent', 40, 60), line('Fossil fuels 40 percent', 40, 180)], [], 0, { regions: [{ n: 50_000, box: [30, 20, 459, 151], text: 400, clear: false }, { n: 36_000, box: [30, 152, 459, 239], text: 300, clear: false }] });
    expect(drawnOf(stacked)).toMatchObject({ block: true, undecided: expect.stringMatching(/stacked bar/) });
    expect(judged(picture({ alt: 'Energy mix' }), stacked)).toEqual([['1.1.1', 'not_testable'], ['1.4.5', 'not_testable']]);
  });
});
