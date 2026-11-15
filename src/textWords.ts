// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Words of a text, normalized for comparison (moved here from the AI alt-text review so tests that are not AI checks
// can use the same rules: the picture test compares the words an SVG picture draws with the page's text).
// Engine core: no Node-only imports, no AI imports.

// Comparing words (review r1, r2). One normalization for every use below: Unicode NFKC, lower case,
// and words split on everything that is not a letter or digit, except that times and numbers stay
// whole tokens, so "3pm" matches "3:00 PM" and a stray "7" never matches "7:00 PM":
// - a time with am/pm is one token: 3:00 PM, 3 PM, 3pm, 3 p.m. → "3pm"; 3:30 PM → "3:30pm"; in a
//   range the am/pm applies to both ends ("3:00 - 6:00 PM", "6 to 7:30 PM");
// - a 24-hour time from 13:00 (and 0:xx, 12:xx) is the same token: 15:00 → "3pm"; an earlier h:mm
//   with no am/pm stays "h:mm" (it could be morning or afternoon);
// - numbers keep their inner separators: "14-18" (also "14 – 18" and "14 to 18"), "3.50", "555-0100", "5/1";
//   thousands separators go ("1,500" → "1500").

const DASHES = /[\u2010-\u2015\u2212]/g;
const HOUR_MIN = '(\\d{1,2})(?::([0-5]\\d))?';
const MERIDIEM = '([ap])\\.?\\s?m\\.?(?![\\p{L}\\p{N}])';
const NOT_AFTER_NUMBER = '(?<![\\p{N}:.,])';
/** A time range whose am/pm comes once, at the end. */
const TIME_RANGE = new RegExp(`${NOT_AFTER_NUMBER}${HOUR_MIN}\\s*(?:-|to)\\s*${HOUR_MIN}\\s*${MERIDIEM}`, 'giu');
/** One time with am/pm. */
const TIME = new RegExp(`${NOT_AFTER_NUMBER}${HOUR_MIN}\\s*${MERIDIEM}`, 'giu');
/** A 24-hour h:mm with no am/pm. */
const CLOCK_24 = new RegExp(`${NOT_AFTER_NUMBER}([01]?\\d|2[0-3]):([0-5]\\d)(?![\\p{L}\\p{N}])`, 'gu');
/** Tokens: a canonical time, a number with inner separators, or a run of letters and digits. */
const TOKEN = /\d{1,2}(?::\d{2})?[ap]m(?![\p{L}\p{N}])|\p{N}+(?:[.:/-]\p{N}+)+(?![\p{L}\p{N}])|[\p{L}\p{N}]+/gu;

/** "3", "30", "p" → "3:30pm" (hours past 12 are afternoon; 0 is 12). */
function clock(h: string, m: string | undefined, ap: string): string {
  let n = Number(h);
  if (n > 12) n -= 12;
  if (n === 0) n = 12;
  return `${n}${m && m !== '00' ? `:${m}` : ''}${ap.toLowerCase()}m`;
}

/** Times written out as canonical tokens (see above); everything else unchanged. */
function canonicalTimes(s: string): string {
  return s
    .replace(DASHES, '-')
    .replace(TIME_RANGE, (_m, h1: string, m1: string | undefined, h2: string, m2: string | undefined, ap: string) => ` ${clock(h1, m1, ap)} ${clock(h2, m2, ap)} `)
    .replace(TIME, (_m, h: string, m: string | undefined, ap: string) => ` ${clock(h, m, ap)} `)
    .replace(CLOCK_24, (_m, h: string, m: string) => {
      const n = Number(h);
      return n >= 13 || n === 0 ? clock(h, m, n >= 12 ? 'p' : 'a') : n === 12 ? clock(h, m, 'p') : `${n}:${m}`;
    });
}

/** The words of a text, normalized for comparison. */
export function textWords(s: string): string[] {
  const t = canonicalTimes(s.normalize('NFKC'))
    .toLowerCase()
    .replace(/(\d),(?=\d{3}(?!\d))/g, '$1')
    .replace(/(\d)\s*(?:-|\bto\b)\s*(?=\d)/g, '$1-');
  return t.match(TOKEN) ?? [];
}

/**
 * The pieces of a text as written, split at spaces, except that a time (or a time range) stays one
 * piece: "6 to 7:30 PM" is one piece, so it is kept or dropped whole.
 */
export function textUnits(s: string): string[] {
  const unit = new RegExp(`${TIME_RANGE.source}|${TIME.source}|\\S+`, 'giu');
  return s.normalize('NFKC').replace(DASHES, '-').match(unit) ?? [];
}

/**
 * Function words that say nothing about which picture was read, in the common languages of US civic sites: English,
 * Spanish, French, German, Portuguese, Italian and Vietnamese (Sol r3, ruling 2: a length rule alone let "dans avec
 * pour" and "eine aber oder" agree). Readings are compared as lower-case words (NFKC), so the lists are lower case.
 */
const FUNCTION_WORDS: Record<string, readonly string[]> = {
  en: ['the', 'and', 'for', 'are', 'was', 'were', 'you', 'your', 'our', 'ours', 'their', 'they', 'them', 'this', 'that',
    'these', 'those', 'with', 'from', 'into', 'onto', 'over', 'under', 'than', 'then', 'there', 'here', 'have', 'has', 'had',
    'will', 'would', 'can', 'could', 'shall', 'should', 'may', 'might', 'must', 'not', 'but', 'any', 'all', 'some', 'each',
    'its', 'his', 'her', 'hers', 'him', 'she', 'who', 'whom', 'whose', 'which', 'what', 'when', 'where', 'why', 'how',
    'about', 'also', 'just', 'only', 'more', 'most', 'very', 'been', 'being', 'does', 'did', 'done', 'out', 'off', 'per',
    'via', 'because', 'while', 'until', 'upon', 'within', 'without', 'through', 'during', 'before', 'after', 'above',
    'below', 'between', 'both', 'either', 'neither', 'other', 'such', 'own', 'same', 'too', 'yet', 'nor', 'whether'],
  es: ['el', 'la', 'los', 'las', 'del', 'una', 'uno', 'unos', 'unas', 'con', 'por', 'para', 'como', 'pero', 'que', 'sus',
    'este', 'esta', 'estos', 'estas', 'ese', 'esa', 'esos', 'esas', 'aquel', 'aquella', 'entre', 'sobre', 'hasta', 'desde',
    'sin', 'tras', 'durante', 'mediante', 'según', 'cuando', 'donde', 'quien', 'quienes', 'cual', 'cuales', 'cuyo', 'porque',
    'pues', 'aunque', 'sino', 'también', 'más', 'muy', 'nuestro', 'nuestra', 'nuestros', 'nuestras', 'ellos', 'ellas',
    'usted', 'ustedes', 'nosotros', 'está', 'están', 'son', 'ser', 'fue', 'han', 'hay', 'sea', 'todo', 'toda', 'todos',
    'todas'],
  fr: ['les', 'des', 'une', 'dans', 'avec', 'pour', 'par', 'sur', 'sous', 'chez', 'vers', 'entre', 'sans', 'depuis',
    'pendant', 'avant', 'après', 'mais', 'donc', 'car', 'que', 'qui', 'quoi', 'dont', 'leur', 'leurs', 'notre', 'nos',
    'votre', 'vos', 'ses', 'son', 'cette', 'ces', 'cet', 'aux', 'est', 'sont', 'été', 'être', 'avoir', 'ont', 'plus',
    'aussi', 'très', 'tout', 'tous', 'toute', 'toutes', 'nous', 'vous', 'elle', 'elles', 'ils', 'lui', 'comme', 'quand',
    'alors', 'ainsi', 'parce'],
  de: ['der', 'die', 'das', 'den', 'dem', 'des', 'ein', 'eine', 'einen', 'einem', 'einer', 'eines', 'und', 'oder', 'aber',
    'mit', 'von', 'für', 'auf', 'aus', 'bei', 'nach', 'über', 'unter', 'vor', 'durch', 'gegen', 'ohne', 'zwischen', 'während',
    'wegen', 'dass', 'wenn', 'weil', 'als', 'wie', 'auch', 'noch', 'nicht', 'sich', 'sie', 'wir', 'ihr', 'ihre', 'unser',
    'unsere', 'ist', 'sind', 'war', 'waren', 'wird', 'werden', 'hat', 'haben', 'kann', 'können', 'zum', 'zur', 'vom', 'beim',
    'sehr', 'alle', 'dieser', 'diese', 'dieses'],
  pt: ['os', 'as', 'um', 'uma', 'uns', 'umas', 'dos', 'das', 'nos', 'nas', 'pelo', 'pela', 'pelos', 'pelas', 'com', 'por',
    'para', 'como', 'mas', 'que', 'seu', 'sua', 'seus', 'suas', 'este', 'esta', 'esse', 'essa', 'isso', 'isto', 'aquele',
    'entre', 'sobre', 'até', 'desde', 'sem', 'durante', 'quando', 'onde', 'quem', 'qual', 'porque', 'também', 'mais',
    'muito', 'nosso', 'nossa', 'eles', 'elas', 'você', 'vocês', 'está', 'estão', 'são', 'ser', 'foi', 'tem', 'têm', 'todo',
    'toda', 'todos', 'todas', 'não'],
  it: ['il', 'lo', 'gli', 'le', 'una', 'uno', 'del', 'dello', 'della', 'dei', 'degli', 'delle', 'nel', 'nello', 'nella',
    'nei', 'negli', 'nelle', 'sul', 'sulla', 'sui', 'sulle', 'con', 'per', 'tra', 'fra', 'che', 'chi', 'come', 'quando',
    'dove', 'perché', 'anche', 'più', 'molto', 'sono', 'essere', 'stato', 'stata', 'hanno', 'questo', 'questa', 'questi',
    'queste', 'quello', 'quella', 'nostro', 'nostra', 'loro', 'suo', 'sua', 'suoi', 'tutto', 'tutti', 'tutta', 'tutte',
    'però', 'senza', 'durante', 'verso', 'presso'],
  vi: ['của', 'và', 'các', 'những', 'được', 'trong', 'cho', 'với', 'này', 'một', 'không', 'là', 'có', 'để', 'từ', 'theo',
    'khi', 'đã', 'sẽ', 'đang', 'tại', 'về', 'như', 'nhưng', 'hoặc', 'thì', 'mà', 'nếu', 'vì', 'bởi', 'cũng', 'rất', 'nhiều',
    'đến', 'trên', 'dưới', 'sau', 'trước', 'giữa', 'nào', 'đó', 'đây', 'chúng', 'tôi', 'bạn', 'họ', 'ông', 'bà', 'các'],
};
const STOPWORDS = new Set(Object.values(FUNCTION_WORDS).flat().map((w) => w.normalize('NFKC').toLowerCase()));

/**
 * The words of a reading that can tell one picture from another: no function words (FUNCTION_WORDS, every listed
 * language), and no words of one or two letters (numbers, times and dates are kept: "6", "3pm" and "14-18").
 */
export function contentWords(s: string): string[] {
  return textWords(s).filter((w) => !STOPWORDS.has(w) && (w.length > 2 || /\d/.test(w)));
}

const LANGUAGE_WORDS: readonly [string, ReadonlySet<string>][] = Object.entries(FUNCTION_WORDS).map(([lang, words]) => [lang, new Set(words.map((w) => w.normalize('NFKC').toLowerCase()))]);

/**
 * How many of the words (as `textWords` gives them) are function words of each listed language: a rough sign of the
 * language a text is written in. A word listed for several languages counts for each.
 */
export function languageCounts(words: readonly string[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const w of words) for (const [lang, set] of LANGUAGE_WORDS) if (set.has(w)) out[lang] = (out[lang] ?? 0) + 1;
  return out;
}

/**
 * More signs of the language a few words are written in, for a text too short to hold a listed function word: the
 * one- and two-letter words that only one of the listed languages uses ("is", "at", "of"; "y"; "et"; "zu"), and the
 * names of the days and the months. A name two languages spell alike counts for both.
 */
const SIGN_WORDS: Record<string, readonly string[]> = {
  en: ['is', 'at', 'to', 'of', 'by', 'it', 'be', 'if', 'we', 'my', 'us', 'up',
    'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
    'mondays', 'tuesdays', 'wednesdays', 'thursdays', 'fridays', 'saturdays', 'sundays',
    'january', 'february', 'march', 'april', 'june', 'july', 'august', 'september', 'october', 'november', 'december'],
  es: ['y', 'ya', 'yo', 'lunes', 'martes', 'miércoles', 'miercoles', 'jueves', 'viernes', 'sábado', 'sabado', 'domingo',
    'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'],
  fr: ['et', 'au', 'je', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi', 'dimanche',
    'janvier', 'février', 'fevrier', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'aout', 'septembre', 'octobre', 'novembre', 'décembre', 'decembre'],
  de: ['zu', 'im', 'montag', 'dienstag', 'mittwoch', 'donnerstag', 'freitag', 'samstag', 'sonntag',
    'januar', 'februar', 'märz', 'april', 'juni', 'juli', 'august', 'september', 'oktober', 'november', 'dezember'],
  pt: ['em', 'ao', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado', 'sabado', 'domingo',
    'janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'],
  it: ['di', 'ed', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato', 'domenica',
    'gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
};
const SIGN_SETS: readonly [string, ReadonlySet<string>][] = Object.entries(SIGN_WORDS).map(([lang, words]) => [lang, new Set(words.map((w) => w.normalize('NFKC').toLowerCase()))]);

/** `languageCounts`, with the short words and the names of days and months that tell a language too (`SIGN_WORDS`). */
export function languageSigns(words: readonly string[]): Record<string, number> {
  const out = languageCounts(words);
  for (const w of words) for (const [lang, set] of SIGN_SETS) if (set.has(w)) out[lang] = (out[lang] ?? 0) + 1;
  return out;
}

