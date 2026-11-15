// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
/*
 * Viewport meta parsing for the WCAG 1.4.4 probe. Written 2026-11-12 from out/cleanroom/viewport-behaviour.md and the W3C drafts it cites (clean room).
 *
 * Reads the content text of a viewport meta element the way the 1.4.4 (Resize text) probe needs it: does the setting
 * let a phone user zoom to 200%? Rule tags in the comments (T1, N2, S4, V3, A5, W3 and so on) are the rule names of
 * viewport-behaviour.md. Every rule is kept exactly as written there, quirks included; section 10 of that document
 * lists where this differs from the W3C drafts, and those differences are required behaviour.
 *
 * The module is pure: no imports, no I/O, no global state. It never sees the DOM; the probe hands it strings.
 */

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/** A scale limit: a number, or the string `auto` when no limit was given. */
export type ScaleLimit = number | 'auto';

/** One (key, value) pair read from the content text (section 3). Both are lower-cased by T1. */
export type ViewportPair = [key: string, value: string];

/** The pair reader's result. Exactly these two fields: the unit test compares it with deep equality. */
export interface ViewportPairs {
  pairs: ViewportPair[];
  invalidSeparator: boolean;
}

/** The setting read from one content string (sections 3 to 5). */
export interface ViewportSetting {
  /** May the user pinch-zoom? Default true. */
  userZoom: boolean;
  /** The maximum scale, or `auto` for no limit. Default `auto`. */
  maxZoom: ScaleLimit;
  /** The minimum scale, or `auto` for no limit. Default `auto`. */
  minZoom: ScaleLimit;
  /** True when the content contains a `;` anywhere (T11). */
  invalidSeparator: boolean;
  /** The value text of the last `user-scalable` pair, as read (U6). Absent when the key never appears. */
  userScalableText?: string;
  /** The value text of the last `maximum-scale` pair, as read (S8). Absent when the key never appears. */
  maximumScaleText?: string;
  /**
   * Present when some value could not be read with certainty (X1): the words "the value" and the value text in curly
   * quotes, naming the last uncertain value (X2). Absent otherwise.
   */
  uncertainNote?: string;
}

/*
 * The verdict (section 2.4). Every member names every field (the ones that do not apply as optional `undefined`), so
 * that code holding a verdict of unknown kind can still read `verdict.why` or `verdict.property` and get a string or
 * undefined, while a `kind` check narrows to the exact shape. At run time the fields that do not apply are absent.
 */

/** The setting lets the user zoom to at least 200%. */
export interface AllowedVerdict {
  kind: 'allowed';
  property?: undefined;
  value?: undefined;
  reads?: undefined;
  why?: undefined;
}

/** The setting stops zoom, or caps it below 200%. */
export interface OffVerdict {
  kind: 'off';
  /** The key that blocks. */
  property: 'user-scalable' | 'maximum-scale';
  /** That key's value text as read, possibly empty. */
  value: string;
  /** How the value is read (W1, W2 or W3). */
  reads: string;
  why?: undefined;
}

/** Cannot be decided with certainty. */
export interface UnknownVerdict {
  kind: 'unknown';
  /** Why (W5, W6 or W7). */
  why: string;
  property?: undefined;
  value?: undefined;
  reads?: undefined;
}

export type ZoomVerdict = AllowedVerdict | OffVerdict | UnknownVerdict;

// ---------------------------------------------------------------------------------------------------------------
// Report wording (section 9). Character-identical; the curly quotes are U+201C and U+201D.
// ---------------------------------------------------------------------------------------------------------------

const LEFT_QUOTE = '“';
const RIGHT_QUOTE = '”';

/** W1: `reads` for `user-scalable` with the text exactly `no`. */
const READS_TURNS_ZOOM_OFF = 'which turns zoom off';
/** W2: `reads` for any other `user-scalable` value that stops zoom. */
const READS_AS_NO = `which the browser reads as ${LEFT_QUOTE}no${RIGHT_QUOTE}`;
/** W5: follows the note text of an uncertain setting. */
const UNCERTAIN_TAIL = ' in the viewport setting may be read as a number by some browsers and as a word by others';
/** W6: the minimum is above the maximum. */
const MINIMUM_ABOVE_MAXIMUM =
  'the viewport setting gives a minimum-scale above its maximum-scale, which holds the page at one scale';

/** W3: `reads` for `maximum-scale`, with N per W3. */
function readsAsScale(maximum: number): string {
  return `which the browser reads as ${formatScale(maximum)}, below the 2 that 200% zoom needs`;
}

/** W7: several settings disagree; `count` is the number of content strings. */
function disagreeWhy(count: number): string {
  return `the page has ${String(count)} viewport settings that disagree about zoom; the browser uses the last one it processed`;
}

/**
 * W3's N: the scale times 100, rounded to the nearest whole number (halves up, as Math.round does on the
 * floating-point product), divided by 100, in the shortest decimal form. For the scales that reach W3 (0, or 0.1 up
 * to 2) String() gives no exponent and no trailing zeros.
 */
function formatScale(scale: number): string {
  return String(Math.round(scale * 100) / 100);
}

// ---------------------------------------------------------------------------------------------------------------
// Section 3: reading the content string into pairs
// ---------------------------------------------------------------------------------------------------------------

const SPACE = 0x20;
const TAB = 0x09;
const LINE_FEED = 0x0a;
const CARRIAGE_RETURN = 0x0d;
const EQUALS = 0x3d;
const COMMA = 0x2c;
const NUL = 0x00;

/** T2: exactly seven characters are breaks. Everything else (`;`, form feed, vertical tab, NBSP, quotes) is ordinary. */
function isBreak(code: number): boolean {
  return (
    code === SPACE ||
    code === TAB ||
    code === LINE_FEED ||
    code === CARRIAGE_RETURN ||
    code === EQUALS ||
    code === COMMA ||
    code === NUL
  );
}

/** T1: only the 26 ASCII capitals A to Z become lower case; no other character changes. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (capital) => String.fromCharCode(capital.charCodeAt(0) + 0x20));
}

/**
 * Reads one content string into its ordered (key, value) pairs plus the semicolon flag (rules T1 to T12).
 *
 * A pair is recorded on every round, even with an empty key or value (T10), so an all-break content gives one
 * (empty, empty) pair and a trailing break adds one at the end (T12).
 */
export function viewportPairs(content: string): ViewportPairs {
  const text = lowerAscii(content); // T1
  const end = text.length;
  const pairs: ViewportPair[] = [];
  let at = 0;

  // T3, T4: an empty string gives no pairs; otherwise repeat while the position is before the end.
  while (at < end) {
    // T5: pass over any breaks, `,` and `=` included.
    while (at < end && isBreak(text.charCodeAt(at))) at += 1;

    // T6: the key is the run of ordinary characters starting here (empty at the end).
    const keyStart = at;
    while (at < end && !isBreak(text.charCodeAt(at))) at += 1;
    const key = text.slice(keyStart, at);

    // T7: move over any characters, ordinary or not, until on `=`, on `,`, or at the end. `;` does not stop it.
    while (at < end && text.charCodeAt(at) !== EQUALS && text.charCodeAt(at) !== COMMA) at += 1;

    // T8: after `=`, pass over breaks but stop on a `,`. After `,` or at the end, do not move.
    if (at < end && text.charCodeAt(at) === EQUALS) {
      while (at < end && isBreak(text.charCodeAt(at)) && text.charCodeAt(at) !== COMMA) at += 1;
    }

    // T9: the value is the run of ordinary characters starting here (empty on a `,` or at the end).
    const valueStart = at;
    while (at < end && !isBreak(text.charCodeAt(at))) at += 1;
    const value = text.slice(valueStart, at);

    // T10: always record; continue from where the value ended.
    pairs.push([key, value]);
  }

  // T11: the flag is true when the content contains at least one `;` anywhere.
  return { pairs, invalidSeparator: text.includes(';') };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 4: reading a number at the start of a value
// ---------------------------------------------------------------------------------------------------------------

/**
 * N2: an optional single sign; digits with an optional `.` and more digits, or `.` and at least one digit; then an
 * optional exponent that is taken only when a digit follows the `e` (and its sign). ASCII digits only. Anchored at the
 * first character (N1), so a leading space or NBSP means "no number".
 */
const NUMBER_AT_START = /^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?/;

/**
 * Reads the number at the very start of `text` (rules N1 to N6), or returns `null` when there is none.
 *
 * The longest match of N2 is converted by standard decimal conversion (round to nearest), so an overflowing
 * exponent gives plus or minus infinity, an underflowing one gives zero or negative zero, and `-0` gives negative
 * zero. Everything after the number is ignored (N4). `inf`, `infinity` and `nan` are not numbers here (N5).
 */
export function numericPrefix(text: string): number | null {
  const match = NUMBER_AT_START.exec(text);
  const found = match === null ? undefined : match[0];
  if (found === undefined) return null; // N5
  return Number(found); // N3: the matched text is always a valid decimal literal for Number().
}

// ---------------------------------------------------------------------------------------------------------------
// Section 5: the keys and their values
// ---------------------------------------------------------------------------------------------------------------

/** K1: the only three keys that change the setting (after T1). */
const MAXIMUM_SCALE = 'maximum-scale';
const MINIMUM_SCALE = 'minimum-scale';
const USER_SCALABLE = 'user-scalable';

/** S4 and U3: starts with `inf` or `nan`, optionally after one `+` or `-` (on the lower-cased text). */
const INF_OR_NAN_AT_START = /^[+-]?(?:inf|nan)/;

/** S7: the clamp range for scales. */
const SMALLEST_SCALE = 0.1;
const LARGEST_SCALE = 10;

/** X1: how many UTF-16 code units of the value text the note keeps. */
const NOTE_LENGTH = 40;

interface ScaleReading {
  scale: ScaleLimit;
  uncertain: boolean;
}

interface ZoomReading {
  zoom: boolean;
  uncertain: boolean;
}

function isInfinite(number: number): boolean {
  return number === Infinity || number === -Infinity;
}

/** Rules S1 to S7: how `maximum-scale` and `minimum-scale` read a value (already lower-cased by T1). */
function readScale(value: string): ScaleReading {
  if (value === 'yes') return { scale: 1, uncertain: false }; // S1
  if (value === 'no') return { scale: 0, uncertain: false }; // S2: 0, not raised to 0.1
  if (value === 'device-width' || value === 'device-height') return { scale: LARGEST_SCALE, uncertain: false }; // S3
  if (INF_OR_NAN_AT_START.test(value)) return { scale: 'auto', uncertain: true }; // S4
  const number = numericPrefix(value) ?? 0; // S5: "no number" reads as 0
  if (isInfinite(number)) return { scale: 'auto', uncertain: true }; // S5: overflow
  if (number < 0) return { scale: 'auto', uncertain: false }; // S6: strictly negative; -0 is not
  return { scale: Math.min(LARGEST_SCALE, Math.max(SMALLEST_SCALE, number)), uncertain: false }; // S7 (-0 gives 0.1)
}

/** Rules U1 to U5: how `user-scalable` reads a value (already lower-cased by T1). */
function readUserScalable(value: string): ZoomReading {
  if (value === 'yes' || value === 'device-width' || value === 'device-height') return { zoom: true, uncertain: false }; // U1
  if (value === 'no') return { zoom: false, uncertain: false }; // U2
  if (INF_OR_NAN_AT_START.test(value)) return { zoom: true, uncertain: true }; // U3
  const number = numericPrefix(value) ?? 0; // U4: "no number" reads as 0
  if (isInfinite(number)) return { zoom: true, uncertain: true }; // U4: overflow
  return { zoom: Math.abs(number) >= 1, uncertain: false }; // U5
}

/** X1: "the value", a space, and the first 40 UTF-16 code units in curly quotes (an astral character may be cut). */
function uncertainNoteFor(value: string): string {
  return `the value ${LEFT_QUOTE}${value.slice(0, NOTE_LENGTH)}${RIGHT_QUOTE}`;
}

/**
 * Parses one content string into a setting object (sections 3 to 5).
 *
 * Pairs are applied in order and the last pair of each key wins (K3), except that uncertainty is sticky for the
 * rest of the string (X2); every other key is ignored whatever its value (K2).
 */
export function parseViewport(content: string): ViewportSetting {
  const { pairs, invalidSeparator } = viewportPairs(content);

  // K4: the defaults.
  let userZoom = true;
  let maxZoom: ScaleLimit = 'auto';
  let minZoom: ScaleLimit = 'auto';
  let userScalableText: string | undefined;
  let maximumScaleText: string | undefined;
  let uncertainNote: string | undefined;

  for (const [key, value] of pairs) {
    if (key === MAXIMUM_SCALE) {
      const reading = readScale(value);
      maxZoom = reading.scale;
      maximumScaleText = value; // S8: recorded every time, whatever the reading
      if (reading.uncertain) uncertainNote = uncertainNoteFor(value); // X1, X2
    } else if (key === MINIMUM_SCALE) {
      const reading = readScale(value);
      minZoom = reading.scale; // S8: the minimum keeps only its scale
      if (reading.uncertain) uncertainNote = uncertainNoteFor(value); // X1, X2
    } else if (key === USER_SCALABLE) {
      const reading = readUserScalable(value);
      userZoom = reading.zoom;
      userScalableText = value; // U6
      if (reading.uncertain) uncertainNote = uncertainNoteFor(value); // X1, X2
    }
    // K2: every other key, the empty key included, has no effect at all.
  }

  const setting: ViewportSetting = { userZoom, maxZoom, minZoom, invalidSeparator };
  if (userScalableText !== undefined) setting.userScalableText = userScalableText;
  if (maximumScaleText !== undefined) setting.maximumScaleText = maximumScaleText;
  if (uncertainNote !== undefined) setting.uncertainNote = uncertainNote;
  return setting;
}

// ---------------------------------------------------------------------------------------------------------------
// Section 6: the verdict for one setting
// ---------------------------------------------------------------------------------------------------------------

/** V6, after [ACT] Expectation 2: a maximum below 2 blocks; exactly 2 is allowed. */
const ZOOM_NEEDED = 2;

/** The verdict for one parsed setting (rules V1 to V5, checked in order; the first that applies decides). */
export function zoomVerdict(setting: ViewportSetting): ZoomVerdict {
  // V1: uncertain.
  if (setting.uncertainNote !== undefined) {
    return { kind: 'unknown', why: setting.uncertainNote + UNCERTAIN_TAIL };
  }

  // V2: both limits are numbers and the minimum is strictly above the maximum.
  const { minZoom, maxZoom } = setting;
  if (typeof minZoom === 'number' && typeof maxZoom === 'number' && minZoom > maxZoom) {
    return { kind: 'unknown', why: MINIMUM_ABOVE_MAXIMUM };
  }

  // V3: zoom not allowed. user-scalable is reported before maximum-scale whatever their order in the content.
  if (!setting.userZoom) {
    const value = setting.userScalableText ?? '';
    return { kind: 'off', property: USER_SCALABLE, value, reads: value === 'no' ? READS_TURNS_ZOOM_OFF : READS_AS_NO };
  }

  // V4: the maximum is a number below 2.
  if (typeof maxZoom === 'number' && maxZoom < ZOOM_NEEDED) {
    return { kind: 'off', property: MAXIMUM_SCALE, value: setting.maximumScaleText ?? '', reads: readsAsScale(maxZoom) };
  }

  // V5.
  return { kind: 'allowed' };
}

// ---------------------------------------------------------------------------------------------------------------
// Section 7: several viewport elements on one page
// ---------------------------------------------------------------------------------------------------------------

/**
 * The page verdict for the content strings of every viewport element, in document order (rules P1 to P4).
 *
 * Settings never merge. When every verdict has the same kind as the last, the last verdict is the result, complete;
 * otherwise the result is unknown (W7) with the number of content strings, empty ones included.
 */
export function pageZoomVerdict(contents: readonly string[]): ZoomVerdict {
  const verdicts = contents.map((content) => zoomVerdict(parseViewport(content))); // P2
  const last = verdicts[verdicts.length - 1];
  if (last === undefined) return { kind: 'allowed' }; // P1: an empty list
  if (verdicts.every((verdict) => verdict.kind === last.kind)) return last; // P3
  return { kind: 'unknown', why: disagreeWhy(contents.length) }; // P4
}

// ---------------------------------------------------------------------------------------------------------------
// Section 8: the axe-core `meta-viewport` check
// ---------------------------------------------------------------------------------------------------------------

/** A8: the word `Infinity`, exact capitalisation, after an optional sign. */
const SIGNED_INFINITY_AT_START = /^([+-]?)Infinity/;

/**
 * A8: the leading number for the axe check. Skips leading whitespace (as String.prototype.trimStart defines it), then
 * reads the section 4 grammar. A8 also reads the word `Infinity`; the axe check lower-cases every value first (A4), so
 * that branch can never fire from axeFailsViewport, and it is kept only so this reader matches A8 as written.
 */
function axeLeadingNumber(text: string): number | null {
  const rest = text.trimStart();
  const infinity = SIGNED_INFINITY_AT_START.exec(rest);
  if (infinity !== null) return infinity[1] === '-' ? -Infinity : Infinity;
  return numericPrefix(rest);
}

/**
 * Would the axe-core rule `meta-viewport` (axe-core 4, minimum scale 2) fail this content? (Rules A1 to A8.)
 *
 * This reads the content its own way, which is not the way of sections 3 to 6. The probe uses it so that nothing axe
 * already reports is reported twice.
 */
export function axeFailsViewport(content: string): boolean {
  if (content === '') return false; // A1

  // A6: a later piece with the same key replaces an earlier one. `maximum-scale=yes` is stored as the number 1 (A5).
  const stored = new Map<string, string | number>();

  // A2: cut at every `;` and every `,`, trim each piece (JavaScript whitespace; NUL stays), skip empty pieces.
  for (const rawPiece of content.split(/[;,]/)) {
    const piece = rawPiece.trim();
    if (piece === '') continue;

    // A3: key before the first `=`, value between the first and the second `=`. Skip when there is no `=`, or when
    // the key or the value is empty before trimming.
    const parts = piece.split('=');
    const rawKey = parts[0];
    const rawValue = parts[1];
    if (rawKey === undefined || rawValue === undefined || rawKey === '' || rawValue === '') continue;

    // A4: full Unicode lower-casing, then trim both.
    const key = rawKey.toLowerCase().trim();
    const value = rawValue.toLowerCase().trim();

    // A5: maximum-scale special cases.
    if (key === MAXIMUM_SCALE) {
      if (value === 'yes') {
        stored.set(key, 1);
        continue;
      }
      const leading = axeLeadingNumber(value);
      if (leading !== null && leading < 0) continue; // a negative value neither sets nor clears anything
    }

    stored.set(key, value); // A6
  }

  // A7: fails when any of these holds, in order.
  const userScalable = stored.get(USER_SCALABLE);
  if (userScalable === 'no') return true; // A7.1
  if (typeof userScalable === 'string' && userScalable !== '') {
    const leading = axeLeadingNumber(userScalable);
    if (leading !== null && leading > -1 && leading < 1) return true; // A7.2
  }
  const maximum = stored.get(MAXIMUM_SCALE);
  if (maximum !== undefined && maximum !== '') {
    const leading = typeof maximum === 'number' ? maximum : axeLeadingNumber(maximum);
    if (leading !== null && leading < ZOOM_NEEDED) return true; // A7.3
  }
  return false;
}
