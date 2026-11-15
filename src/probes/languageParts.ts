// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Language of parts (WCAG 3.1.2), from the DOM at the desktop width, on every page that loaded: a passage
// in another language than the one its content is marked as (the nearest `lang` attribute), with no
// `lang` of its own (H58 not applied). Screen readers then read it with the wrong language's
// pronunciation. Reads only; it changes nothing on the page. Engine core: no Node-only imports.
//
// A pattern only ever makes a passage a candidate; a failure needs proof that the passage is running text
// in the other language (review round 1, rulings 2 and 3):
// - a candidate by words: at least 10 words, at least 4 different function words of another language that
//   make up a fifth of its words, and next to none of the declared language's own (judged only when the
//   declared language is one the test has a word list for, so Italian is never mistaken for Spanish);
// - a candidate by script: at least 20 letters, 70% of them in a script the declared language is not
//   written in;
// - running text: sentences, proven by all of: a sentence mark; ordinary capitals (not a title-case or
//   all-capitals sequence); a clause of 6 words or more (a list is short items: dish names, titles, offices);
//   and the other language's sentence words: one that a name does not have (a verb, a conjunction, a subject
//   pronoun), or two of the weaker ones ("su", "no", "se": a dish and a shop can have one). "de", "la" and "y"
//   are in every organisation's name and prove nothing; neither does length, or a second full stop.
//   For Chinese, Japanese and Korean: three different particles a name does not have and a full stop, a
//   sentence that ends in a verb ending, never a list of short items between commas or semicolons.
// WCAG 3.1.2 exempts proper names, technical terms, words of indeterminate language and words that are part
// of the surrounding language's vernacular. A short phrase (under 10 words) is never judged. A sequence of
// names (title case, capitals with no sentence word, a list of capitalised items) is left out. A candidate
// that is neither clearly names nor provably running text is undecided: `not_testable`, never failed.
// A script by itself proves nothing: a paragraph of names in Chinese characters is no passage in Chinese.
//
// Language of page (WCAG 3.1.1), from the same read: all the text that takes the page's language (the root's
// `lang`, and any part marked with the same language) is counted, names included. The page's language is
// wrong only when that text is clearly predominantly another language: 60% of its words (or letters) are in
// passages proven to be running text in one other language, and the declared language's own words are next
// to none (ACT rule ucwvc8). Then 3.1.1 fails and those passages are not also reported as unmarked parts.
// When the text only looks like another language (many of its words, no proof), 3.1.1 is undecided.
//
// Bounded before anything is allocated: nodes walked, text nodes read, characters read (per page, per text
// node and per passage) and time. A page over a bound is sampled, and the finding says what was read.
import type { ProbeFinding } from '../types.js';
import { pageWords, shootElements } from './evidence.js';
import type { PageProbe, ProbeContext } from './types.js';

export const LANGUAGE_PARTS_PROBE_ID = 'language-parts';

/** Function words by language (lower case, two letters or more). A language is judged by words only when it is here. */
export const LANGUAGE_WORDS: Readonly<Record<string, string>> = {
  en: 'the and of to is in that for with you are this be on your will have from our we it as at by can not or an if all has was were been their they there which what when who how do does did but about into more than then them these those may must should would could',
  es: 'el la los las de del que en un una unos unas por para con es su sus se no al lo como más pero este esta estos estas usted ustedes nuestro nuestra nuestros todos todas son hay está están ser fue si también ya muy sin sobre entre cuando donde porque hasta desde le les nos qué cómo puede pueden debe deben',
  fr: 'le la les de des du et est un une en que qui pour dans avec sur pas au aux ce cette ces vous nous il elle ils elles sont être ou par ne votre vos notre nos plus mais comme si tout tous toute leur leurs dont où été avoir fait peut doit se sa son ses je',
  de: 'der die das und ist ein eine einer einem einen zu den dem mit für von auf nicht sich des im sie wir es auch oder werden bei aus an wie nach ihre ihr ihren als aber nur noch wird sind hat haben kann können über unter durch wenn dass um zum zur vom',
  pt: 'os as de do da dos das que em um uma para com não por se mais na no nas nos ao aos você sua seu suas seus ou como são nossa nosso foi ser está estão também já muito sem sobre entre quando onde porque até pelo pela isso este esta',
  it: 'il lo la gli le di da in con su per tra fra che non un una uno del della dei delle degli al alla ai alle nel nella nei nelle sono come più ma anche questo questa questi si ci se ha hanno essere può devono loro',
  vi: 'và của là có được các cho trong không những một với người này để đã khi từ theo về bạn chúng tôi sẽ cũng đến năm',
  tl: 'ang ng sa na mga at ay ito para ni si kung hindi may ka mo ko siya namin natin kami po ninyo',
};

/**
 * The words of each language that a sentence has and a name does not: verbs, conjunctions, subject pronouns.
 * One of them, in a clause of a sentence's length that ends in a sentence mark, proves running text
 * (`proseByWords`). Articles, "of", "and", "for" and "in" are in every organisation's name ("Casa de la Familia
 * y Centro para los Derechos de Todos") and prove nothing. Not here: any word a dish, a shop, a song or a
 * church can have in its name (`LANGUAGE_SENTENCE_WEAK`).
 */
export const LANGUAGE_SENTENCE_WORDS: Readonly<Record<string, string>> = {
  en: 'is are was were be been has have had will would can could should must may do does did that which what when who how if but because you we they it there',
  // Not "he", "sea", "hay", "son", "van", "era", "ha", "han", "va" (English words and names too).
  es: 'que es está están estamos ser estar fue fueron hemos había será serán tiene tienen tenemos puede pueden podrá podrán podemos debe deben deberá deberán hace hacen vamos quiere quieren necesita necesitan pero porque aunque cuando donde mientras también además usted ustedes nosotros ellos ellas esto eso aquí ahora siempre nunca'
    // Batch 17: the polite commands a public notice is written in ("Llame al…", "Mantenga a los niños…", "Programe la
    // inspección…"). Each is a verb form and nothing else: no noun, adjective or name is spelled so, and none is an
    // English word. Left out on purpose: "use", "complete", "revise", "conserve", "tire" (English words), "cierre",
    // "informe", "reporte", "toque", "presente", "firme", "marque", "entre", "lea" (nouns, adjectives, a preposition, a name).
    + ' llame llamen visite visiten envíe envíen traiga traigan mantenga mantengan evite eviten utilice utilicen haga hagan consulte consulten solicite soliciten pague paguen programe programen hierva hiervan beba beban obtenga obtengan tenga tengan recuerde recuerden verifique verifiquen ponga pongan lleve lleven coloque coloquen apague apaguen desconecte desconecten limpie limpien deseche desechen guarde guarden proteja protejan permanezca permanezcan salga salgan vaya vayan venga vengan diga digan busque busquen pregunte pregunten responda respondan devuelva devuelvan recoja recojan llene llenen pida pidan espere esperen siga sigan abra abran vea vean deje dejen',
  // Not "on", "car", "font" (English words too).
  fr: 'est sont être été était avoir ont avons avez fait peut peuvent pouvez doit doivent devez faut sera seront que qui quand parce mais donc dont où il elle ils elles je aussi très déjà toujours jamais ici',
  // Not "war", "hat", "ob", "es".
  de: 'ist sind waren haben hatte kann können konnte wird werden wurde muss müssen soll sollen darf dürfen nicht sich sie wir auch aber nur noch wenn dass weil oder schon immer hier',
  pt: 'que não é são foi foram ser estar está estão têm temos pode podem deve devem há será você vocês eles elas isso isto também já quando onde porque aqui agora sempre nunca',
  // Not "era", "ha", "ma", "mai".
  it: 'che non è sono essere hanno abbiamo può possono deve devono sarà anche perché quando dove già sempre qui',
  vi: 'là có được không những đã sẽ cũng',
  // Not "may", "hindi", "ito" (English words and names too).
  tl: 'ay kung siya namin natin kami po ninyo',
};

/**
 * Sentence words a name can have too (a possessive, a negation, a reflexive, a demonstrative): "carne en su
 * jugo", "Nuestra Señora", "Chez Nous", "pas de deux". Two different ones are needed where one of
 * `LANGUAGE_SENTENCE_WORDS` is enough. Not here either: a word that is also English ("no", "son", "come").
 */
export const LANGUAGE_SENTENCE_WEAK: Readonly<Record<string, string>> = {
  en: 'not this these those your our their',
  es: 'su sus se le nos lo como si muy más este esta estos estas nuestro nuestra nuestros nuestras',
  fr: 'ne pas ce cette ces vous nous votre vos notre nos comme si leur leurs se sa ses plus',
  de: 'wie ihre ihr ihren unser unsere dieser diese dieses es',
  pt: 'se sua seu suas seus como muito este esta nossa nosso mais mas tem',
  it: 'più questo questa questi si ci se loro nostro nostra',
  vi: 'này bạn chúng tôi khi để',
  tl: '',
};

/**
 * Verb forms that count as a sentence word, by their ending (a pattern over one word, lower case only: a
 * capitalised word is a name). Spanish: the future tense ("estará", "se realizarán"), the commonest verb form
 * of a notice, which no list can hold.
 */
export const LANGUAGE_SENTENCE_FORMS: Readonly<Record<string, string>> = {
  // The future tense, and (batch 17) a polite command with its pronoun attached, which carries a written accent
  // before it ("comuníquese", "póngase", "regístrese", "manténgase"): no noun or name ends so.
  es: '^\\p{Ll}{2,}(?:ará|erá|irá|arán|erán|irán)$|^\\p{Ll}*[áéíóú]\\p{Ll}{1,5}se$',
};

/** Scripts the test recognises, with the languages written in each (primary subtags). */
export const LANGUAGE_SCRIPTS: readonly { script: string; name: string; languages: string }[] = [
  { script: 'Han', name: 'Chinese characters', languages: 'zh ja ko yue cmn' },
  { script: 'Hiragana', name: 'Japanese', languages: 'ja' },
  { script: 'Katakana', name: 'Japanese', languages: 'ja' },
  { script: 'Hangul', name: 'Korean', languages: 'ko' },
  { script: 'Arabic', name: 'Arabic script', languages: 'ar fa ur ps ku sd ug' },
  { script: 'Cyrillic', name: 'Cyrillic script', languages: 'ru uk bg sr mk be kk ky tg mn' },
  { script: 'Hebrew', name: 'Hebrew script', languages: 'he yi' },
  { script: 'Greek', name: 'Greek', languages: 'el' },
  { script: 'Devanagari', name: 'Devanagari script', languages: 'hi mr ne sa' },
  { script: 'Thai', name: 'Thai', languages: 'th' },
];

/**
 * What proves running text in a script (by the script's name in `LANGUAGE_SCRIPTS`). A script with no entry is
 * never proven: its passages are undecided.
 * - `chars` (text written with no spaces): particles a name does not have; `sentenceChars` different ones are
 *   needed. Not here: any character that is also part of ordinary names ("不动产" real estate, "就业"
 *   employment, "对外" foreign, "为民" for the people, "在线" online, "和平" peace, "会", "有", "都").
 * - `endings` (Japanese, Korean): what a sentence ends in, right before its full stop; one is needed, with
 *   `particles` different particles (Japanese: characters; Korean: the syllables that close a word).
 * - `words` and `weak` (spaced text): as `LANGUAGE_SENTENCE_WORDS` and `LANGUAGE_SENTENCE_WEAK`.
 * - `ends`: the sentence marks, one of which the passage must have. A comma or a semicolon is none.
 */
export const LANGUAGE_SCRIPT_PROOF: Readonly<Record<string, { chars?: string; endings?: string; particles?: string; words?: string; weak?: string; ends: string }>> = {
  'Chinese characters': { chars: '的了是我你您他她们們这這也吗嗎呢吧请請', ends: '。？！' },
  Japanese: {
    endings: 'です ます ました でした ません ください である だった ましょう でしょう ています ている ていた ない たい した された できる できます しない',
    particles: 'はがをにでと', ends: '。？！',
  },
  Korean: {
    endings: '니다 니까 어요 아요 해요 세요 예요 에요 한다 이다 있다 없다 된다 했다 였다 었다 았다',
    particles: '은는이가을를에의', ends: '.?!。',
  },
  'Cyrillic script': {
    words: 'не что это вы мы он она они был была были быть если но который которые уже ещё можно нужно будет когда чтобы потому также может могут що це ви ми він вона вони був була були бути якщо але який які вже ще можна треба буде коли щоб також може можуть',
    weak: 'как так же бы его её их только или есть як його її їх тільки або',
    ends: '.?!…',
  },
  'Arabic script': {
    words: 'أن إن هذا هذه التي الذي هو هي كان قد لم لن ذلك نحن يمكن يجب لكن إذا لأن عندما يرجى که را است می شود ہے ہیں تھا کہ نے',
    weak: 'لا ما حتى عند قبل بعد ثم كما تلك أنت حيث أو تا یک این آن هم خود برای اور کو یہ',
    ends: '.؟!۔',
  },
};

/** English names of the languages told by words. */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  en: 'English', es: 'Spanish', fr: 'French', de: 'German', pt: 'Portuguese', it: 'Italian', vi: 'Vietnamese', tl: 'Tagalog',
};

export const LANGUAGE_PARTS_LIMITS = {
  /** Nodes walked per page (elements and text nodes together); a larger page is sampled up to here. */
  nodes: 150_000,
  /** Text nodes read per page. */
  textNodes: 40_000,
  /**
   * Characters read per page, and judged as one passage. Lengths are checked before any text is copied. A block
   * of text longer than a passage is read to its end, in pieces of this length judged one after another.
   */
  chars: 400_000,
  passageChars: 12_000,
  /** Time the read may take in the page (ms); it stops there and reports what it read. */
  ms: 3_000,
  /** Passages judged per page. */
  passages: 3_000,
  /** Documents read per page: the page itself and its open shadow roots. One more is a page read in part. */
  roots: 50,
  /** A passage needs this many words to be judged by words. */
  minWords: 10,
  /** Different function words of the other language a passage needs. */
  minDistinct: 4,
  /** Share of the passage's words that are the other language's function words. */
  minShare: 0.2,
  /** Most of the declared language's function words a passage in another language may hold: this share of its words, or one. */
  maxOwnShare: 0.05,
  /** Letters a passage needs to be judged by script, and the share of them in the other script. */
  scriptLetters: 20,
  scriptShare: 0.7,
  /**
   * Running text by words: different sentence words needed (`LANGUAGE_SENTENCE_WORDS`), or this many different
   * weaker ones (`LANGUAGE_SENTENCE_WEAK`); by characters (text written with no spaces): different particles.
   */
  sentenceWords: 1,
  weakWords: 2,
  sentenceChars: 3,
  /** Japanese and Korean: different particles needed beside a sentence ending. */
  particles: 2,
  /** A clause of running text has at least this many words; a passage whose every item is shorter is a list. */
  clauseWords: 6,
  /** The same for text written with no spaces: letters in its longest item. */
  clauseLetters: 13,
  /** A passage this long with this many different sentence words needs no sentence mark (words). */
  longWords: 25,
  longSentenceWords: 2,
  /** Share of capitalised content words above which a passage is a sequence of names, and under which it may be prose. */
  namesShare: 0.8,
  proseShare: 0.6,
  /** Page language: words the page's own text needs to be judged, and the share of them in proven running text of one other language. */
  pageWords: 40,
  pageRunning: 0.6,
  /** The other language's function words as a share of the page's words (what makes the page a candidate), and the declared language's most. */
  pageShare: 0.15,
  pageOwnShare: 0.03,
  /** Page language by script: letters needed (the candidate share is `scriptShare`, the proof share `pageRunning`). */
  pageLetters: 60,
  /** Other-language passages kept per page. */
  kept: 200,
} as const;

/** Findings listed per page; the last one counts the rest. */
const PER_PAGE = 5;

/** A passage proven to be running text in another language than the one it is marked as. */
export interface LanguagePassage {
  /** CSS path of the passage's block (parts joined by ' >>> ' across shadow roots). */
  target: string;
  /** The `lang` value the passage inherits, as written (at most 20 characters). */
  declared: string;
  /** What it reads as: a language code told by words ('es'), or a script name ('Cyrillic script'). */
  reads: string;
  by: 'words' | 'script';
  /** Its first 120 characters. */
  text: string;
  words: number;
  /** It takes the page's language (from the root, or from a part marked with the same language). */
  page: boolean;
}

/** A candidate that is neither clearly a sequence of names nor provably running text. */
export interface UnsurePassage {
  target: string;
  declared: string;
  reads: string;
  by: 'words' | 'script';
  text: string;
}

/** All the text that takes the page's language (the root's `lang`, and parts marked with the same language), taken together. */
export interface PageLanguage {
  /** The root's `lang` as written (at most 20 characters). */
  lang: string;
  /** Its words; those that are function words of the declared language (-1: no word list); and of the other language with the most. */
  words: number;
  own: number;
  other: number;
  /** That other language's code ('' when none). */
  otherLang: string;
  /** Words in passages proven running text in one other language (the one with the most), and that language's code. */
  running: number;
  runningLang: string;
  /** Its letters; those in the script with the most that the declared language is not written in; and those in passages proven running text in that script. */
  letters: number;
  script: number;
  scriptName: string;
  scriptRunning: number;
}

export interface LanguagePartsRead {
  passages: LanguagePassage[];
  /** Candidates left undecided (at most 20 kept). */
  unsure: UnsurePassage[];
  /** Passages long enough to judge whose declared language the test can tell from others. */
  judged: number;
  /** Absent when the root element has no `lang` (or an empty one). */
  page?: PageLanguage;
  /** Passages long enough to judge whose declared language the test has no word list for (their primary subtags, at most 5). */
  unknown: string[];
  /** A bound was reached: the page was sampled (see `coverage`). */
  truncated: boolean;
  /**
   * What was read: nodes walked, text nodes read, characters read, and the documents read (the page itself and
   * its open shadow roots; `rootsCut` when the page has more shadow roots than the test reads).
   */
  coverage: { nodes: number; textNodes: number; chars: number; roots: number; rootsCut?: boolean };
}

type Limits = { [K in keyof typeof LANGUAGE_PARTS_LIMITS]: number };

/**
 * Runs in the page (self-contained). Collects the text of each block by the `lang` it inherits (text
 * inside an element with its own `lang` is a passage of that language), leaves out what is not rendered,
 * code, form controls and what is hidden from assistive technology, and judges each passage.
 */
export function readLanguageParts(arg: {
  limits: Limits;
  words: Record<string, string>;
  sentence: Record<string, string>;
  weak: Record<string, string>;
  forms: Record<string, string>;
  scripts: { script: string; name: string; languages: string }[];
  proof: Record<string, { chars?: string; endings?: string; particles?: string; words?: string; weak?: string; ends: string }>;
}): LanguagePartsRead {
  const L = arg.limits;
  const t0 = performance.now();
  const setOf = (list: string | undefined) => new Set((list ?? '').split(' ').filter(Boolean));
  const lists = Object.entries(arg.words).map(([code, list]) => ({ code, set: new Set(list.split(' ')), sentence: setOf(arg.sentence[code]), weak: setOf(arg.weak[code]), forms: arg.forms[code] ? new RegExp(arg.forms[code]!, 'u') : null }));
  const anyList = new Set(lists.flatMap((l) => [...l.set]));
  const scripts = arg.scripts.map((s) => ({ ...s, re: new RegExp(`\\p{Script=${s.script}}`, 'gu'), langs: new Set(s.languages.split(' ')) }));
  const nonLatin = new Set(scripts.flatMap((s) => [...s.langs]));
  const proofs = new Map(Object.entries(arg.proof).map(([name, p]) => [name, {
    chars: p.chars ? [...p.chars] : null, endings: p.endings ? p.endings.split(' ') : null, particles: p.particles ? [...p.particles] : null,
    words: p.words ? setOf(p.words) : null, weak: setOf(p.weak), ends: [...p.ends],
  }]));
  const primary = (lang: string) => {
    const p = lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
    return p === 'fil' ? 'tl' : p === 'iw' ? 'he' : p;
  };
  const esc = (s: string) => (typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const cssPath = (el: Element): string => {
    const root = el.getRootNode() as Document | ShadowRoot;
    const parts: string[] = [];
    for (let cur: Element | null = el; cur; cur = cur.parentElement) {
      if (cur.id && root.querySelectorAll(`#${esc(cur.id)}`).length === 1) { parts.unshift(`#${esc(cur.id)}`); break; }
      const parent: Element | null = cur.parentElement;
      if (!parent) { parts.unshift(esc(cur.localName)); break; }
      const same = [...parent.children].filter((c) => c.localName === cur!.localName);
      parts.unshift(same.length > 1 ? `${esc(cur.localName)}:nth-of-type(${same.indexOf(cur) + 1})` : esc(cur.localName));
    }
    const host = (root as ShadowRoot).host;
    return host ? `${cssPath(host)} >>> ${parts.join(' > ')}` : parts.join(' > ');
  };
  const SKIP = 'script, style, noscript, template, code, pre, kbd, samp, var, textarea, select, option, datalist, svg, math, iframe, object, [aria-hidden="true"], [inert], [contenteditable=""], [contenteditable="true"]';
  const BLOCK = 'p, li, td, th, dd, dt, blockquote, figcaption, caption, label, legend, summary, h1, h2, h3, h4, h5, h6, div, section, article, aside, main, header, footer, nav, form, fieldset, address, details, body';
  const shownCache = new WeakMap<Element, boolean>();
  const shown = (el: Element): boolean => {
    let v = shownCache.get(el);
    if (v === undefined) {
      const c = el as Element & { checkVisibility?: (o: object) => boolean };
      v = typeof c.checkVisibility === 'function' ? c.checkVisibility({ visibilityProperty: true }) : c.getClientRects().length > 0;
      shownCache.set(el, v);
    }
    return v;
  };
  /** The element whose `lang` a node inherits (through shadow roots), or null. */
  const langOwner = (el: Element): Element | null => {
    for (let a: Element | null = el; a;) {
      if (a.hasAttribute('lang')) return a;
      if (a.parentElement) a = a.parentElement;
      else {
        const root = a.getRootNode() as Node & { host?: Element };
        a = root.host ?? null;
      }
    }
    return null;
  };

  /** Text by block and by the element that gives it its language: its pieces, and their length together. */
  const byBlock = new Map<Element, Map<Element, { parts: string[]; chars: number; title?: boolean }[]>>();
  let nodes = 0;
  let textNodes = 0;
  let chars = 0;
  let truncated = false;
  // Where one item of a block ends and the next begins with no punctuation between them: text in one element
  // right after text in another (links one after another), or after a line break. Marked in the passage (`SEP`).
  const SEP = '\u001f';
  let lastParent: Element | null = null;
  let lastBlock: Element | null = null;
  let broke = false;
  const roots: (Document | ShadowRoot)[] = [document];
  let rootsRead = 0;
  let rootsCut = false;
  // Text marked as the title of a work: never a definite failure (a title is a name), whatever it reads like.
  const TITLE = 'cite, q[title], [itemprop~="name"], [itemprop~="headline"], [itemprop~="alternativeHeadline"], [property$="title"], [property$="name"], [property$="headline"]';
  walk: for (let r = 0; r < roots.length && r < L.roots; r++) {
    rootsRead = r + 1;
    const root = roots[r]!;
    const top = root === document ? document.body : root;
    if (!top) continue;
    const walker = document.createTreeWalker(top, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      // Every bound is checked on counts and lengths, before any text is copied.
      if (++nodes > L.nodes || ((nodes & 1023) === 0 && performance.now() - t0 > L.ms)) { truncated = true; break walk; }
      if (n.nodeType === 1) {
        const sr = (n as Element).shadowRoot;
        // A shadow root past the cap is not read: the page is then read in part, and says so (never a silent clean).
        if (sr) { if (roots.length < L.roots) roots.push(sr); else { truncated = true; rootsCut = true; } }
        const tag = (n as Element).localName;
        if (tag === 'br' || tag === 'hr') broke = true;
        continue;
      }
      const length = (n as Text).length;
      if (!length) continue;
      if (++textNodes > L.textNodes || chars >= L.chars) { truncated = true; break walk; }
      const parent = n.parentElement;
      if (!parent || parent.closest(SKIP) || !shown(parent)) continue;
      const owner = langOwner(parent);
      if (!owner) continue; // no language declared anywhere: the page-language rules' subject
      // The passage's block: the nearest block, but never one outside the element that gives the language.
      let block = parent.closest(BLOCK) ?? parent;
      if (owner !== block && block.contains(owner)) block = owner;
      let inner = byBlock.get(block);
      if (!inner) byBlock.set(block, (inner = new Map()));
      let pieces = inner.get(owner);
      if (!pieces) inner.set(owner, (pieces = [{ parts: [], chars: 0 }]));
      // A new item: after a line break, or in another element than the text before it (neither inside the other,
      // neither the block itself: a word set apart inside a sentence is in the block's own text on one side).
      let starts = lastBlock === block && lastParent !== null
        && (broke || (parent !== lastParent && parent !== block && lastParent !== block && !lastParent.contains(parent) && !parent.contains(lastParent)));
      // The text is read to its end (the page's character budget is the only cut), a passage's length at a time.
      for (let offset = 0; offset < length;) {
        if (chars >= L.chars) { truncated = true; break walk; }
        let entry = pieces[pieces.length - 1]!;
        if (entry.chars >= L.passageChars) pieces.push((entry = { parts: [], chars: 0 }));
        const take = Math.min(length - offset, L.chars - chars, L.passageChars - entry.chars);
        const text = offset === 0 && take === length ? (n as Text).data : (n as Text).substringData(offset, take);
        offset += take;
        chars += take;
        // Text with a letter in it, or the punctuation between two elements ("<a>…</a>, <a>…</a>").
        if (!/[\p{L}.,;:!?…。、，；：？！؟۔،]/u.test(text)) continue;
        entry.parts.push(starts ? SEP + text : text);
        entry.chars += take;
        if (!entry.title && parent.closest(TITLE)) entry.title = true;
        starts = false;
        lastParent = parent;
        lastBlock = block;
        broke = false;
      }
    }
  }

  const count = (text: string, re: RegExp): number => { let k = 0; re.lastIndex = 0; while (re.exec(text)) k++; return k; };
  const LETTER = /\p{L}/gu;
  const han = scripts.find((s) => s.script === 'Han');

  /** The words of the longest item between commas, semicolons, bullets, dashes, line breaks and sentence marks. */
  // (A comma, a semicolon or a colon inside a number or a time, "9:30" or "1,200", separates nothing.)
  const ITEM = /[,;:](?=\s|$)|[·•|،、，；：\n\u001f]|\s[–—-]\s|[.!?…。？！؟۔]+(?=\s|$|["”’»)\]])/u;
  const itemsOf = (text: string): string[] => text.split(ITEM).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x));

  /**
   * Running text in a language written with spaces (pure). `strong`: the language's sentence words; `weak`:
   * those a name can have. 'running' needs all of: a sentence mark (or `longWords` words with
   * `longSentenceWords` different sentence words), ordinary capitals, a clause of `clauseWords` words (so the
   * passage is no list of short items), and one sentence word or `weakWords` weaker ones. 'names' when it
   * has no sentence word (one weaker one at most) and is in capitals, in title case or a list of short items;
   * 'unsure' otherwise.
   */
  const proseBySets = (text: string, tokens: string[], lower: string[], strong: Set<string>, weak: Set<string>, ends: RegExp, known: (word: string) => boolean, forms: RegExp | null = null, own: Set<string> | null = null): 'running' | 'names' | 'unsure' => {
    // A sentence word counts in ordinary case only (an abbreviation in capitals, "IL" or "ES", is none), and
    // never when the declared language has the same word ("on" in a French menu on an English page).
    const cased = /\p{Lu}/u.test(text) || /\p{Ll}/u.test(text);
    const allCaps = cased && !/\p{Ll}/u.test(text);
    const strongSeen = new Set<string>();
    const weakSeen = new Set<string>();
    for (let k = 0; k < tokens.length; k++) {
      const t = tokens[k]!;
      const w = lower[k]!;
      if ((!allCaps && /\p{Lu}.*\p{Lu}/u.test(t)) || own?.has(w)) continue;
      if (strong.has(w) || forms?.test(allCaps ? w : t)) strongSeen.add(w);
      else if (weak.has(w)) weakSeen.add(w);
    }
    const strongN = strongSeen.size;
    const weakN = weakSeen.size;
    const content = tokens.filter((t) => t.length >= 2 && !known(t.toLowerCase()) && !strong.has(t.toLowerCase()) && !weak.has(t.toLowerCase()));
    const capShare = cased && content.length >= 3 ? content.filter((t) => /^\p{Lu}/u.test(t)).length / content.length : 0;
    const items = itemsOf(text);
    const longest = items.reduce((m, x) => Math.max(m, (x.match(/\p{L}+/gu) ?? []).length), 0);
    // A list: every item between its commas and full stops is shorter than a clause; or, in a sentence, the
    // items between commas each begin with a capital (titles of works written out in a line: in running text
    // the words after a comma do not).
    // (Items are told by commas alone, and by commas with the boundaries between elements: a title broken over
    // two lines, or split by an element inside it, is still one title of a comma list.)
    const capitalised = (part: string, by: RegExp): boolean => {
      const pieces = part.split(by).map((x) => x.trim()).filter((x) => /\p{L}/u.test(x));
      return pieces.length >= 2 && pieces.every((x) => /^[^\p{L}\p{N}]*[\p{Lu}\p{N}]/u.test(x));
    };
    const titles = cased && text.split(SENTENCE_END).some((part) => capitalised(part, COMMA) || capitalised(part.replace(/\u001f/g, ' '), COMMA));
    const list = longest < L.clauseWords || titles;
    // Capitals, title case or a list, and no sentence word a name does not have: a sequence of names.
    if (!strongN && weakN < L.weakWords && (allCaps || list || capShare >= L.namesShare)) return 'names';
    if (allCaps || list) return 'unsure';
    const proven = strongN >= L.sentenceWords || weakN >= L.weakWords;
    const marked = ends.test(text) || (tokens.length >= L.longWords && strongN >= L.longSentenceWords);
    if (marked && proven && capShare < L.proseShare) return 'running';
    return 'unsure';
  };
  const SENTENCE_END = /[.!?…。？！؟۔]+(?=\s|$|["”’»)\]])/u;
  const COMMA = /[,;](?=\s|$)|[·•|،、，；\u001f]|\s[–—-]\s/u;
  const ENDS = /[.!?…](?:["”’»)\]]*)(?:\s|$)|[¿¡]/u;
  const proseByWords = (text: string, tokens: string[], lower: string[], strong: Set<string>, weak: Set<string>, forms: RegExp | null, own: Set<string> | null): 'running' | 'names' | 'unsure' =>
    proseBySets(text, tokens, lower, strong, weak, ENDS, (w) => anyList.has(w), forms, own);

  /** Running text in a script: the script's own proof (`arg.proof`); 'names' when the passage has none of its marks at all. */
  const proseByScript = (text: string, name: string): 'running' | 'names' | 'unsure' => {
    // Japanese is judged as Japanese wherever kana is in the text, whichever script most of its letters are in.
    const p = proofs.get(/[\p{Script=Hiragana}\p{Script=Katakana}]/u.test(text) ? 'Japanese' : name) ?? proofs.get(name);
    if (!p) return 'unsure'; // no proof for this script: a passage in it is never proven
    const hasEnd = p.ends.some((e) => text.includes(e));
    if (p.words) {
      const tokens = text.match(/\p{L}+/gu) ?? [];
      return proseBySets(text, tokens, tokens.map((t) => t.toLowerCase()), p.words, p.weak, /[.!?…؟۔](?:["”’»)\]]*)(?:\s|$)/u, () => false);
    }
    // Text written with no spaces (or, for Korean, with particles closing its words).
    const items = itemsOf(text);
    const longest = items.reduce((m, x) => Math.max(m, count(x, LETTER)), 0);
    const list = longest < L.clauseLetters;
    if (p.endings) {
      const mark = p.ends.map((e) => (/[.?]/.test(e) ? `\\${e}` : e)).join('');
      const endings = count(text, new RegExp(`(?:${p.endings.join('|')})(?:か|ね|よ)?[${mark}]`, 'gu'));
      const spaced = /\s/.test(text.trim());
      // Korean closes a word with its particle; Japanese writes them between the words.
      const particles = spaced
        ? new Set((text.match(new RegExp(`[${p.particles!.join('')}](?=\\s|[,.?!]|$)`, 'gu')) ?? [])).size
        : p.particles!.filter((c) => text.includes(c)).length;
      if (endings >= 1 && particles >= L.particles && !list) return 'running';
      // A sentence ending, or particles with a full stop and an item of a clause's length: it may be running
      // text whose ending the test has no word for. Never passed over as names.
      return endings || (particles >= L.particles && hasEnd && !list) ? 'unsure' : 'names';
    }
    let distinct = 0;
    for (const c of p.chars ?? []) if (text.includes(c)) distinct++;
    if (distinct >= L.sentenceChars && hasEnd && !list) return 'running';
    return distinct >= L.sentenceChars || (distinct && hasEnd && !list) ? 'unsure' : 'names';
  };

  const rootEl = document.documentElement;
  const passages: LanguagePassage[] = [];
  const unsure: UnsurePassage[] = [];
  const seen = new Set<string>();
  const unknown = new Set<string>();
  let judged = 0;
  let passageCount = 0;
  // The page's own text, pooled: every passage that takes the page's language, names included.
  const rootRaw = (rootEl.getAttribute('lang') ?? '').trim();
  const rootLang = primary(rootRaw);
  const pool = { words: 0, own: 0, letters: 0, other: new Map<string, number>(), script: new Map<string, number>(), running: new Map<string, number>(), scriptRunning: new Map<string, number>() };
  const rootOwn = lists.find((l) => l.code === rootLang);
  judge: for (const [block, inner] of byBlock) {
    for (const [owner, pieces] of inner) for (const entry of pieces) {
      if (++passageCount > L.passages || ((passageCount & 63) === 0 && performance.now() - t0 > L.ms * 2)) { truncated = true; break judge; }
      const declaredRaw = (owner.getAttribute('lang') ?? '').trim();
      const declared = primary(declaredRaw);
      if (!declared) continue; // lang="": the language is declared unknown
      const text = entry.parts.join(' ').replace(/\s+/g, ' ').trim().normalize('NFC');
      const tokens = text.match(/\p{L}+(?:['’]\p{L}+)*/gu) ?? [];
      const lower = tokens.map((t) => t.toLowerCase());
      const letters = count(text, LETTER);
      const inPage = !!rootLang && declared === rootLang;
      if (inPage) {
        pool.words += tokens.length;
        pool.letters += letters;
        for (const w of lower) {
          if (w.length < 2) continue;
          if (rootOwn?.set.has(w)) pool.own++;
          for (const l of lists) if (l.code !== rootLang && l.set.has(w)) pool.other.set(l.code, (pool.other.get(l.code) ?? 0) + 1);
        }
        for (const sc of scripts) {
          if (sc.langs.has(rootLang)) continue;
          const n = count(text, sc.re);
          if (n) pool.script.set(sc.name, (pool.script.get(sc.name) ?? 0) + n);
        }
      }
      if (text.length < 20) continue;
      let reads = '';
      let by: 'words' | 'script' = 'words';
      let decidable = false;
      let prose: 'running' | 'names' | 'unsure' = 'unsure';

      // A candidate by script: most of the letters are in a script the declared language is not written in.
      if (letters >= L.scriptLetters) {
        let best: { name: string; n: number; langs: Set<string> } | undefined;
        let kana = 0;
        for (const s of scripts) {
          const n = count(text, s.re);
          if (s.script === 'Hiragana' || s.script === 'Katakana') kana += n;
          if (!best || n > best.n) best = { name: s.name, n, langs: s.langs };
        }
        const hanCount = han ? count(text, han.re) : 0;
        // Japanese is written in kana and Chinese characters together.
        const japanese = kana > 0 && kana + hanCount >= letters * L.scriptShare;
        if (japanese) { if (declared !== 'ja') { reads = 'Japanese'; by = 'script'; } decidable = true; }
        else if (best && best.n >= letters * L.scriptShare) {
          decidable = true;
          if (!best.langs.has(declared)) { reads = best.name; by = 'script'; }
        }
        if (reads) prose = proseByScript(text, reads);
      }

      // A candidate by words.
      const own = lists.find((l) => l.code === declared);
      if (!reads && tokens.length >= L.minWords && (own || nonLatin.has(declared))) {
        const latin = count(text, /\p{Script=Latin}/gu);
        // A passage in a Latin-script language inside content marked as a language written in another script.
        const latinEnough = own ? true : latin >= letters * 0.9;
        // Placeholder filler ("Lorem ipsum dolor sit amet") is no language.
        const filler = lower.includes('lorem') && lower.includes('ipsum');
        if (latinEnough && !filler) {
          decidable = true;
          const ownHits = own ? lower.filter((t) => t.length >= 2 && own.set.has(t)).length : 0;
          let best: { code: string; hits: number; distinct: number; sentence: Set<string>; weak: Set<string>; forms: RegExp | null } | undefined;
          for (const l of lists) {
            if (l.code === declared) continue;
            const hit = lower.filter((t) => t.length >= 2 && l.set.has(t));
            const distinct = new Set(hit).size;
            if (!best || hit.length > best.hits || (hit.length === best.hits && distinct > best.distinct)) best = { code: l.code, hits: hit.length, distinct, sentence: l.sentence, weak: l.weak, forms: l.forms };
          }
          if (best && best.distinct >= L.minDistinct && best.hits >= lower.length * L.minShare && ownHits <= Math.max(1, Math.floor(lower.length * L.maxOwnShare))) {
            reads = best.code;
            by = 'words';
            prose = proseByWords(text, tokens, lower, best.sentence, best.weak, best.forms, own?.set ?? null);
          }
        }
      } else if (!reads && tokens.length >= L.minWords && !own && unknown.size < 5) unknown.add(declared);

      if (decidable) judged++;
      // Text marked as the title of a work (cite, a q with a title, a name in structured data) is a name, however
      // much it reads like a sentence: undecided, never failed (review round 2, finding 4).
      if (prose === 'running' && entry.title) prose = 'unsure';
      if (!reads || prose === 'names') continue;
      const plain = text.replace(/\s*\u001f\s*/g, ' ');
      const clipped = plain.length > 120 ? `${plain.slice(0, 119)}…` : plain;
      if (prose === 'unsure') {
        if (unsure.length < 20) unsure.push({ target: cssPath(block), declared: declaredRaw.slice(0, 20), reads, by, text: clipped });
        continue;
      }
      if (inPage) {
        if (by === 'words') pool.running.set(reads, (pool.running.get(reads) ?? 0) + tokens.length);
        else pool.scriptRunning.set(reads, (pool.scriptRunning.get(reads) ?? 0) + letters);
      }
      const key = `${declared}\u0000${text.slice(0, 200)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (passages.length >= L.kept) { truncated = true; continue; }
      passages.push({ target: cssPath(block), declared: declaredRaw.slice(0, 20), reads, by, text: clipped, words: tokens.length, page: inPage });
    }
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
  const bestOther = top(pool.other);
  const bestScript = top(pool.script);
  const bestRunning = top(pool.running);
  const page: PageLanguage | undefined = rootLang ? {
    lang: rootRaw.slice(0, 20), words: pool.words, own: rootOwn || !nonLatin.has(rootLang) ? pool.own : -1,
    other: bestOther?.[1] ?? 0, otherLang: bestOther?.[0] ?? '', running: bestRunning?.[1] ?? 0, runningLang: bestRunning?.[0] ?? '',
    letters: pool.letters, script: bestScript?.[1] ?? 0, scriptName: bestScript?.[0] ?? '', scriptRunning: bestScript ? pool.scriptRunning.get(bestScript[0]) ?? 0 : 0,
  } : undefined;
  return { passages, unsure, judged, ...(page ? { page } : {}), unknown: [...unknown], truncated, coverage: { nodes: Math.min(nodes, L.nodes), textNodes: Math.min(textNodes, L.textNodes), chars, roots: rootsRead, ...(rootsCut ? { rootsCut } : {}) } };
}

/**
 * What the page's own text says of the page's language (pure): 'other' when it is clearly predominantly one
 * other language (proven running text makes up `pageRunning` of it, and the declared language's own words are
 * next to none), 'unsure' when it only looks like another language (its words or its script, with no proof),
 * undefined when the page's language stands or there is too little text to tell.
 */
export function pageReadsAs(page: PageLanguage | undefined): { verdict: 'other' | 'unsure'; as: string } | undefined {
  if (!page) return undefined;
  const L = LANGUAGE_PARTS_LIMITS;
  if (page.letters >= L.pageLetters && page.script >= page.letters * L.scriptShare && page.scriptName) {
    return { verdict: page.scriptRunning >= page.letters * L.pageRunning ? 'other' : 'unsure', as: page.scriptName };
  }
  const declared = page.lang.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  if (!(declared in LANGUAGE_WORDS) || page.words < L.pageWords || page.own < 0 || page.own > page.words * L.pageOwnShare) return undefined;
  if (page.runningLang && page.running >= page.words * L.pageRunning) return { verdict: 'other', as: LANGUAGE_NAMES[page.runningLang] ?? page.runningLang };
  if (page.otherLang && page.other >= page.words * L.pageShare) return { verdict: 'unsure', as: LANGUAGE_NAMES[page.otherLang] ?? page.otherLang };
  return undefined;
}

const languageName = (code: string): string => {
  const p = code.trim().toLowerCase().split(/[-_]/)[0] ?? '';
  return LANGUAGE_NAMES[p] ?? `“${code}”`;
};
const readsAs = (p: { reads: string; by: 'words' | 'script' }): string => (p.by === 'words' ? LANGUAGE_NAMES[p.reads] ?? p.reads : p.reads);

/** What a sampled read covered, in words for a finding. */
const coverageText = (read: LanguagePartsRead): string =>
  `the first ${read.coverage.chars.toLocaleString('en-US')} characters of its text (${read.coverage.textNodes.toLocaleString('en-US')} pieces of text, ${read.coverage.nodes.toLocaleString('en-US')} elements and pieces walked) were read; the rest was not${read.coverage.rootsCut ? ` (the page and ${read.coverage.roots - 1} of its shadow roots were read; it has more shadow roots, which were not)` : ''}`;

/** One page's findings from what `readLanguageParts` reported. */
export function languagePartFindings(read: LanguagePartsRead): ProbeFinding[] {
  // The page's own text, taken together, is clearly predominantly another language than its root declares: the
  // page's language is what is wrong (3.1.1). Its passages are then the page's language, not unmarked parts.
  // A sampled page proves nothing about the whole: its page language is undecided at most.
  const said = pageReadsAs(read.page);
  const pageAs = said?.verdict === 'other' && !read.truncated ? said.as : undefined;
  const parts = pageAs ? read.passages.filter((p) => !p.page) : read.passages;
  const out: ProbeFinding[] = [];
  if (pageAs && read.page) {
    out.push({
      criterion: '3.1.1', status: 'failed', target: 'html',
      detail: `The page's language is set to ${languageName(read.page.lang)} (lang="${read.page.lang}"), but its text reads as ${pageAs}, so screen readers pronounce the whole page as ${languageName(read.page.lang)}`,
    });
  } else if (said && read.page) {
    out.push({
      criterion: '3.1.1', status: 'not_testable', target: 'html',
      detail: `much of the text that takes the page's language (lang="${read.page.lang}") looks like ${said.as}, but it may be names or titles, or only part of the page was read: whether the page's language is right could not be told`,
    });
  }
  const shown = parts.slice(0, PER_PAGE);
  shown.forEach((p, i) => {
    const more = i === shown.length - 1 && parts.length > shown.length ? ` (${parts.length - shown.length} more like this on this page)` : '';
    out.push({
      criterion: '3.1.2', status: 'failed', target: p.target,
      detail: `A passage in ${readsAs(p)} is inside content marked as ${languageName(p.declared)} (lang="${p.declared}") and has no lang attribute of its own, so screen readers pronounce it as ${languageName(p.declared)}: “${p.text}”${more}`,
    });
  });
  // Candidates that may be names, titles or a line in capitals: undecided, one finding for the page.
  const unsure = pageAs ? [] : read.unsure;
  if (unsure.length) {
    const u = unsure[0]!;
    out.push({
      criterion: '3.1.2', status: 'not_testable', target: u.target,
      detail: `${unsure.length === 1 ? 'a passage' : `${unsure.length} passages`} inside content marked as ${languageName(u.declared)} may be in ${readsAs(u)} (“${u.text}”), or may be names, titles or other text that needs no language of its own: this could not be told`,
    });
  }
  if (read.truncated) {
    // A page read in part is clean for neither criterion: what was not read may be in another language.
    if (!out.some((f) => f.criterion === '3.1.1')) out.push({ criterion: '3.1.1', status: 'not_testable', target: 'html', detail: `this page is larger than the test reads, so whether its text is in the page's language could not be told: ${coverageText(read)}` });
    out.push({ criterion: '3.1.2', status: 'not_testable', detail: `this page is larger than the test reads: ${coverageText(read)}` });
    return out;
  }
  if (out.some((f) => f.criterion === '3.1.2') || pageAs) return out;
  if (!read.judged && read.unknown.length) {
    out.push({ criterion: '3.1.2', status: 'not_testable', detail: `the text of this page is marked as ${read.unknown.map(languageName).join(', ')}, a language this test cannot tell from others` });
  } else if (!read.judged) out.push({ criterion: '3.1.2', status: 'not_applicable', detail: 'no passage of 10 words or more on this page' });
  return out;
}

/** The first passage boxed, in the main document. */
async function languageEvidence(ctx: ProbeContext, findings: readonly ProbeFinding[]): Promise<void> {
  const first = findings.find((f) => f.criterion === '3.1.2' && f.status === 'failed' && f.target && !f.target.includes(' >>> '));
  if (!first) return;
  await shootElements(ctx, {
    criterion: '3.1.2', handles: [{ sel: first.target! }], caption: 'This passage is in another language than it is marked as',
    alt: (title) => `${pageWords(title)}: the outlined passage is in another language than the page says, with no language set on it.`,
  });
}

/**
 * Language of the page and of its parts, on every page that loaded (`everyPage`): fails 3.1.2 for each passage
 * proven to be running text in another language than the one it is marked as, and 3.1.1 when the page's own text
 * is clearly predominantly another language. Listed, not scored, until calibrated (docs/scoring.md).
 */
export const languagePartsProbe: PageProbe = {
  id: LANGUAGE_PARTS_PROBE_ID,
  criteria: ['3.1.1', '3.1.2'],
  // Reads the page's text once: an app that mounts its content late is read with it.
  waitFor: { content: true },
  kind: 'render',
  tier: 'core',
  scored: false,
  timeoutMs: 10_000,
  everyPage: true,
  note: 'it tells running text in English, Spanish, French, German, Portuguese, Italian, Vietnamese and Tagalog by its words, and in Chinese, Japanese, Korean, Arabic and Cyrillic script by its particles and sentence marks, in passages of 10 words or more; names, titles, shorter phrases and other languages are not judged',
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const read = await ctx.page.evaluate(readLanguageParts, {
      limits: { ...LANGUAGE_PARTS_LIMITS }, words: { ...LANGUAGE_WORDS }, sentence: { ...LANGUAGE_SENTENCE_WORDS }, weak: { ...LANGUAGE_SENTENCE_WEAK }, forms: { ...LANGUAGE_SENTENCE_FORMS },
      scripts: LANGUAGE_SCRIPTS.map((s) => ({ ...s })), proof: Object.fromEntries(Object.entries(LANGUAGE_SCRIPT_PROOF).map(([k, v]) => [k, { ...v }])),
    });
    const findings = languagePartFindings(read);
    await languageEvidence(ctx, findings);
    return findings;
  },
};
