// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
/*
 * Property and fuzz tests for src/probes/metaViewport.ts (clean room, 2026-11-12).
 *
 * Random content strings and page lists, checked against the invariants viewport-behaviour.md states: pair reading
 * (T1 to T12), number reading (N1 to N6), keys, duplicates and uncertainty (K1 to K4, S1 to S8, U1 to U6, X1 to X3),
 * verdict order (V1 to V6), several elements (P1 to P4) and the axe check (A1 to A8). Wherever possible the check
 * uses an independent oracle instead of re-running the module's own logic: a regular-expression transcription of the
 * pair reader, JavaScript's parseFloat for both number readers, and algebraic laws (comma concatenation, last-wins
 * composition, case, padding and permutation invariance). Coverage guards assert that every rule branch was hit.
 *
 * Seeded, so every run checks the same inputs. FUZZ_SEED picks another seed; FUZZ_SCALE multiplies the run counts.
 * Each failure message carries the input that broke the rule.
 * Run: pnpm -C packages/engine exec vitest run test/unit/metaViewport.cleanroom (ported from node:test, unchanged
 * otherwise).
 */
import { test } from 'vitest';
import assert from 'node:assert/strict';
import {
  axeFailsViewport,
  numericPrefix,
  pageZoomVerdict,
  parseViewport,
  viewportPairs,
  zoomVerdict,
} from '../../src/probes/metaViewport.js';
import type { ViewportSetting, ZoomVerdict } from '../../src/probes/metaViewport.js';

type Pair = [string, string];

const ENV = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
const SEED = Number(ENV['FUZZ_SEED'] ?? '20261112');
const SCALE = Number(ENV['FUZZ_SCALE'] ?? '1');
function runs(base: number): number {
  return Math.max(1, Math.round(base * SCALE));
}

// ---------------------------------------------------------------------------------------------------------------
// Seeded random source
// ---------------------------------------------------------------------------------------------------------------

interface Random {
  next(): number;
  int(below: number): number;
  chance(probability: number): boolean;
  pick<T>(items: readonly T[]): T;
}

function makeRandom(seed: number): Random {
  let state = seed >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let mixed = state;
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1);
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61);
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296;
  };
  const int = (below: number): number => Math.floor(next() * below);
  return {
    next,
    int,
    chance: (probability: number): boolean => next() < probability,
    pick<T>(items: readonly T[]): T {
      const item = items[int(items.length)];
      if (item === undefined) throw new Error('pick from an empty list');
      return item;
    },
  };
}

function shuffled<T>(items: readonly T[], random: Random): T[] {
  const copy = items.slice();
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const other = random.int(index + 1);
    const here = copy[index] as T;
    copy[index] = copy[other] as T;
    copy[other] = here;
  }
  return copy;
}

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary and generators
// ---------------------------------------------------------------------------------------------------------------

const BREAKS = [' ', '\t', '\n', '\r', '=', ',', '\u0000'];
const BREAK_SET = new Set(BREAKS);
/** JavaScript whitespace (String.prototype.trim), NUL excluded. */
const JS_SPACES = [' ', '\t', '\n', '\r', '\v', '\f', ' ', '﻿', ' ', '　', ' ', ' ', ' '];
const ODD = [
  ';', '\f', '\v', ' ', '﻿', ' ', '"', "'", 'İ', 'Ｎ', 'Ｏ', '５', '−', '١', '😀', '\ud83d', 'K',
  'Σ', 'ß', '_', '%', 'x', 'p',
];
const LETTERS = ['a', 'e', 'f', 'i', 'n', 'o', 's', 'y', 'E', 'I', 'N', 'O', 'S', 'Y', 'F', 'A'];
const NUMBER_CHARS = ['0', '1', '2', '5', '9', '.', '+', '-', 'e', 'E'];
const SCALE_KEYS = ['maximum-scale', 'minimum-scale', 'user-scalable'] as const;
type ScaleKey = (typeof SCALE_KEYS)[number];
const KEY_SPELLINGS: Record<ScaleKey, readonly string[]> = {
  'maximum-scale': ['maximum-scale', 'MAXIMUM-SCALE', 'Maximum-Scale', 'mAxImUm-ScAlE'],
  'minimum-scale': ['minimum-scale', 'MINIMUM-SCALE', 'Minimum-Scale'],
  'user-scalable': ['user-scalable', 'USER-SCALABLE', 'User-Scalable', 'uSeR-sCaLaBlE'],
};
const IGNORED_KEYS = [
  'width', 'height', 'initial-scale', 'viewport-fit', 'interactive-widget', 'shrink-to-fit', 'target-densitydpi',
  'minimal-ui', 'maximum_scale', 'maximum-scale;', ';user-scalable', '"width', 'Width', 'İnitial-scale', 'user', 'x',
  'maximum-scalе', // the last letter is a Cyrillic e
];
const WORDS = [
  'yes', 'no', 'YES', 'No', 'nO', 'device-width', 'device-height', 'Device-Height', 'none', 'auto', 'true', 'false',
  'on', 'off', 'fixed', 'zoom', 'inf', 'infinity', 'Infinity', 'INF', 'nan', 'NaN', '-inf', '+inf', '-nan', '+nan',
  'information', 'nano', 'İnf', 'nİ', 'ＮＯ', '"no"', "'5'", '"yes"', '++inf', '-+nan', 'e5', '-.e1', '.', '+', '-',
];
const SEPARATORS = [', ', ', ', ',', ' ', ';', '; ', ' ;', ',,', '\n', '\r\n', '\u0000', '\f', '\v', ' , ', '\t', ' = '];
const EQUALS_SPELLINGS = ['=', '=', '=', ' = ', '==', ' =', '= ', '\t=\t', ' ', '\u0000', '=\u0000', '= ,'];

function spell(key: ScaleKey, random: Random): string {
  return random.pick(KEY_SPELLINGS[key]);
}

function digits(random: Random, count: number): string {
  let out = '';
  for (let index = 0; index < count; index += 1) {
    out += random.chance(0.03) ? random.pick(['５', '١']) : String(random.int(10));
  }
  return out;
}

function randomNumberText(random: Random): string {
  const sign = random.pick(['', '', '', '', '+', '-', '-', '−', '++', '+-']);
  let body: string;
  switch (random.int(7)) {
    case 0:
      body = digits(random, 1 + random.int(3));
      break;
    case 1:
      body = `${digits(random, 1 + random.int(3))}.${digits(random, random.int(4))}`;
      break;
    case 2:
      body = `.${digits(random, 1 + random.int(4))}`;
      break;
    case 3:
      body = random.pick(['.', '', 'x']);
      break;
    case 4:
      body = digits(random, 1 + random.int(30));
      break;
    case 5:
      body = random.pick(['0', '00', '1', '2', '10', '1.995', '1.994', '1.9999999999999999', '0.105', '1.045', '0.05']);
      break;
    default:
      body = random.pick(['9'.repeat(400), '0x10', '1_000', '2.5.1', '0.1e1', '1.']);
  }
  let exponent = '';
  if (random.chance(0.3)) exponent = random.pick(['e', 'E']) + random.pick(['', '+', '-']) + digits(random, random.int(4));
  if (random.chance(0.05)) exponent = random.pick(['e999', 'e-999', 'E+308', 'e309', 'e-324', 'e-400']);
  return sign + body + exponent;
}

function randomSoup(random: Random, length: number, withBreaks: boolean): string {
  let out = '';
  for (let index = 0; index < length; index += 1) {
    const roll = random.int(10);
    if (withBreaks && roll < 3) out += random.pick(BREAKS);
    else if (roll < 5) out += random.pick(LETTERS);
    else if (roll < 8) out += random.pick(NUMBER_CHARS);
    else out += random.pick(ODD);
  }
  return out;
}

/** A value without break characters, so that it is read whole. */
function randomValue(random: Random): string {
  switch (random.int(6)) {
    case 0:
      return randomNumberText(random);
    case 1:
      return randomNumberText(random) + random.pick(['', 'px', 'x', ';', ';x', ';user-scalable', '.1', 'e', 'E+', '%', '"']);
    case 2:
      return random.pick(WORDS);
    case 3:
      return random.pick(WORDS) + random.pick(['', ';', 'x', '1', '"', 'mation']);
    case 4:
      return '';
    default:
      return randomSoup(random, 1 + random.int(8), false);
  }
}

function randomContent(random: Random): string {
  if (random.chance(0.25)) return randomSoup(random, random.int(24), true);
  const count = random.int(5);
  let out = random.chance(0.15) ? random.pick(SEPARATORS) : '';
  for (let index = 0; index < count; index += 1) {
    if (index > 0) out += random.pick(SEPARATORS);
    out += random.chance(0.75) ? spell(random.pick(SCALE_KEYS), random) : random.pick(IGNORED_KEYS);
    if (random.chance(0.92)) out += random.pick(EQUALS_SPELLINGS);
    out += randomValue(random);
  }
  if (random.chance(0.15)) out += random.pick(SEPARATORS);
  return out;
}

/** Any UTF-16 code units, lone surrogates included. */
function rawString(random: Random): string {
  const length = random.int(30);
  let out = '';
  for (let index = 0; index < length; index += 1) {
    out += String.fromCharCode(random.chance(0.6) ? random.int(128) : random.int(0x10000));
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Oracles and helpers
// ---------------------------------------------------------------------------------------------------------------

function show(value: unknown): string {
  return JSON.stringify(value);
}
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (capital) => capital.toLowerCase());
}
function upperAscii(text: string): string {
  return text.replace(/[a-z]/g, (small) => small.toUpperCase());
}
function hasOrdinary(text: string): boolean {
  for (const character of text) if (!BREAK_SET.has(character)) return true;
  return false;
}
function verdictOf(content: string): ZoomVerdict {
  return zoomVerdict(parseViewport(content));
}

/**
 * The pair reader transcribed into one sticky regular expression per round: T5 leading breaks, T6 key, T7 anything
 * up to `=` or `,`, then T8 and T9 only after an `=`. A different technique from the module's character loop.
 */
const BREAK_CLASS = ' \\t\\n\\r=,\\u0000';
const ROUND_SOURCE = `[${BREAK_CLASS}]*([^${BREAK_CLASS}]*)[^=,]*(?:=[ \\t\\n\\r=\\u0000]*([^${BREAK_CLASS}]*))?`;
function referencePairs(content: string): { pairs: Pair[]; invalidSeparator: boolean } {
  const text = lowerAscii(content);
  const round = new RegExp(ROUND_SOURCE, 'y');
  const pairs: Pair[] = [];
  while (round.lastIndex < text.length) {
    const start = round.lastIndex;
    const match = round.exec(text);
    if (match === null || round.lastIndex === start) throw new Error(`reference reader stuck on ${show(content)}`);
    pairs.push([match[1] ?? '', match[2] ?? '']);
  }
  return { pairs, invalidSeparator: text.indexOf(';') !== -1 };
}

/** N1 to N5 through parseFloat: no leading whitespace, no `Infinity` word, otherwise parseFloat's longest prefix. */
function numberOracle(text: string): number | null {
  if (/^\s/.test(text)) return null;
  if (/^[+-]?Infinity/.test(text)) return null;
  const value = parseFloat(text);
  return Number.isNaN(value) ? null : value;
}

/** A8 through parseFloat (which skips leading whitespace and reads `Infinity`). */
function axeNumberOracle(text: string): number | null {
  const value = parseFloat(text);
  return Number.isNaN(value) ? null : value;
}

function core(pairs: readonly Pair[]): Pair[] {
  const last = pairs[pairs.length - 1];
  return last !== undefined && last[0] === '' ? pairs.slice(0, pairs.length - 1) : pairs.slice();
}

function hasKey(content: string, key: string): boolean {
  return viewportPairs(content).pairs.some((pair) => pair[0] === key);
}

const SETTING_FIELDS = [
  'userZoom',
  'maxZoom',
  'minZoom',
  'invalidSeparator',
  'userScalableText',
  'maximumScaleText',
  'uncertainNote',
] as const;
type SettingField = (typeof SETTING_FIELDS)[number];

function assertSetting(actual: ViewportSetting, expected: Partial<Record<SettingField, unknown>>, label: string): void {
  for (const field of SETTING_FIELDS) {
    assert.strictEqual(actual[field], expected[field], `${field} for ${label}`);
  }
  for (const field of Object.keys(actual)) {
    assert.ok((SETTING_FIELDS as readonly string[]).includes(field), `unexpected field ${field} for ${label}`);
  }
}

function noteFor(asRead: string): string {
  return `the value “${asRead.slice(0, 40)}”`;
}

function countHit(hits: Map<string, number>, rule: string): void {
  hits.set(rule, (hits.get(rule) ?? 0) + 1);
}
function counted<T>(hits: Map<string, number>, rule: string, reading: T): T {
  countHit(hits, rule);
  return reading;
}

/** S1 to S7 as a reading of the lower-cased value, numbers through the parseFloat oracle. */
function expectScale(asRead: string, hits: Map<string, number>): { scale: number | 'auto'; uncertain: boolean } {
  if (asRead === 'yes') return counted(hits, 'S1', { scale: 1, uncertain: false });
  if (asRead === 'no') return counted(hits, 'S2', { scale: 0, uncertain: false });
  if (asRead === 'device-width' || asRead === 'device-height') return counted(hits, 'S3', { scale: 10, uncertain: false });
  if (/^[+-]?(?:inf|nan)/.test(asRead)) return counted(hits, 'S4', { scale: 'auto', uncertain: true });
  const number = numberOracle(asRead);
  if (number === null) countHit(hits, 'S5 no number');
  const value = number ?? 0;
  if (!Number.isFinite(value)) return counted(hits, 'S5 infinity', { scale: 'auto', uncertain: true });
  if (value < 0) return counted(hits, 'S6', { scale: 'auto', uncertain: false });
  countHit(hits, value < 0.1 ? 'S7 below' : value > 10 ? 'S7 above' : 'S7 inside');
  if (Object.is(value, -0)) countHit(hits, 'S7 negative zero');
  return { scale: Math.min(10, Math.max(0.1, value)), uncertain: false };
}

/** U1 to U5 as a reading of the lower-cased value, numbers through the parseFloat oracle. */
function expectZoom(asRead: string, hits: Map<string, number>): { zoom: boolean; uncertain: boolean } {
  if (asRead === 'yes' || asRead === 'device-width' || asRead === 'device-height') return counted(hits, 'U1', { zoom: true, uncertain: false });
  if (asRead === 'no') return counted(hits, 'U2', { zoom: false, uncertain: false });
  if (/^[+-]?(?:inf|nan)/.test(asRead)) return counted(hits, 'U3', { zoom: true, uncertain: true });
  const value = numberOracle(asRead) ?? 0;
  if (!Number.isFinite(value)) return counted(hits, 'U4 infinity', { zoom: true, uncertain: true });
  const zoom = value >= 1 || value <= -1;
  countHit(hits, zoom ? 'U5 zoom' : 'U5 fixed');
  return { zoom, uncertain: false };
}

function assertCoverage(hits: Map<string, number>, rules: readonly string[]): void {
  for (const rule of rules) assert.ok((hits.get(rule) ?? 0) > 0, `the generator never exercised ${rule}`);
}

// ---------------------------------------------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------------------------------------------

const RAW_RUNS = runs(20000);
test(`F0 any UTF-16 string: every entry point returns the documented types and never throws (${RAW_RUNS} runs)`, () => {
  const random = makeRandom(SEED);
  for (let run = 0; run < RAW_RUNS; run += 1) {
    const text = random.chance(0.5) ? rawString(random) : randomContent(random);
    const label = show(text);
    const read = viewportPairs(text);
    assert.ok(Array.isArray(read.pairs) && typeof read.invalidSeparator === 'boolean', label);
    const number = numericPrefix(text);
    assert.ok(number === null || typeof number === 'number', label);
    assert.ok(!Number.isNaN(number), label);
    const setting = parseViewport(text);
    assert.equal(typeof setting.userZoom, 'boolean', label);
    const verdict = zoomVerdict(setting);
    assert.ok(['allowed', 'off', 'unknown'].includes(verdict.kind), label);
    assert.equal(typeof axeFailsViewport(text), 'boolean', label);
    assert.ok(['allowed', 'off', 'unknown'].includes(pageZoomVerdict([text, rawString(random)]).kind), label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Pairs (T1 to T12)
// ---------------------------------------------------------------------------------------------------------------

const PAIR_RUNS = runs(30000);
test(`F1 pair reader equals the regular-expression transcription of T1 to T11 (${PAIR_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 1);
  for (let run = 0; run < PAIR_RUNS; run += 1) {
    const content = random.chance(0.15) ? rawString(random) : randomContent(random);
    const read = viewportPairs(content);
    assert.deepStrictEqual(Object.keys(read).sort(), ['invalidSeparator', 'pairs'], show(content));
    assert.deepStrictEqual(read, referencePairs(content), show(content));
  }
});

test(`F2 T1, T2, T11, T12: lower case, no breaks inside, empty pair only last, semicolon flag (${PAIR_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 2);
  for (let run = 0; run < PAIR_RUNS; run += 1) {
    const content = randomContent(random);
    const label = show(content);
    const { pairs, invalidSeparator } = viewportPairs(content);
    assert.strictEqual(invalidSeparator, content.includes(';'), label);
    assert.strictEqual(pairs.length === 0, content === '', label);
    pairs.forEach(([key, value], index) => {
      for (const text of [key, value]) {
        assert.ok(!/[A-Z]/.test(text), `capital in ${show(text)} of ${label}`);
        for (const character of text) assert.ok(!BREAK_SET.has(character), `break in ${show(text)} of ${label}`);
      }
      if (key === '') {
        assert.strictEqual(index, pairs.length - 1, `empty key before the end in ${label}`);
        assert.strictEqual(value, '', `empty key with a value in ${label}`);
      }
    });
    if (content !== '' && !hasOrdinary(content)) assert.deepStrictEqual(pairs, [['', '']], label);
  }
});

test(`F3 T5: a leading run of breaks never adds or changes a pair (${runs(10000)} runs)`, () => {
  const random = makeRandom(SEED + 3);
  for (let run = 0; run < runs(10000); run += 1) {
    const content = randomContent(random);
    if (content === '') continue;
    let lead = '';
    for (let count = 1 + random.int(3); count > 0; count -= 1) lead += random.pick(BREAKS);
    assert.deepStrictEqual(viewportPairs(lead + content).pairs, viewportPairs(content).pairs, show([lead, content]));
  }
});

test(`F4 T7 to T9: a comma always ends a pair, so reading a,b is reading a then b (${PAIR_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 4);
  for (let run = 0; run < PAIR_RUNS; run += 1) {
    const first = randomContent(random);
    const second = randomContent(random);
    const secondPairs = viewportPairs(second).pairs;
    const secondLast = secondPairs[secondPairs.length - 1];
    const trailing = !hasOrdinary(second) || (secondLast !== undefined && secondLast[0] === '');
    const expected = core(viewportPairs(first).pairs).concat(core(secondPairs), trailing ? [['', '']] : []);
    assert.deepStrictEqual(viewportPairs(`${first},${second}`).pairs, expected, show([first, second]));
  }
});

test(`F5 T1: ASCII case never changes the pairs (${PAIR_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 5);
  for (let run = 0; run < PAIR_RUNS; run += 1) {
    const content = randomContent(random);
    const expected = viewportPairs(content);
    assert.deepStrictEqual(viewportPairs(upperAscii(content)), expected, show(content));
    assert.deepStrictEqual(viewportPairs(lowerAscii(content)), expected, show(content));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Numbers (N1 to N6)
// ---------------------------------------------------------------------------------------------------------------

const NUMBER_RUNS = runs(30000);
test(`F6 number reader equals the parseFloat oracle (N1, N2, N3, N5) (${NUMBER_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 6);
  for (let run = 0; run < NUMBER_RUNS; run += 1) {
    let text: string;
    const roll = random.int(5);
    if (roll < 3) text = randomValue(random);
    else if (roll === 3) text = randomSoup(random, random.int(12), true);
    else text = random.pick(JS_SPACES) + randomNumberText(random);
    // strictEqual compares with Object.is: -0, Infinity and null must all match exactly.
    assert.strictEqual(numericPrefix(text), numberOracle(text), show(text));
  }
});

test(`F7 N4 and N1: text after the number is ignored; anything before it means no number (${NUMBER_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 7);
  for (let run = 0; run < NUMBER_RUNS; run += 1) {
    const text = randomNumberText(random);
    const tail = random.pick(['x', ';', ' ', 'p', ',', '"', '%', ' ', 'İ', '=', ';user-scalable']) + randomSoup(random, random.int(6), true);
    assert.strictEqual(numericPrefix(text + tail), numericPrefix(text), show([text, tail]));
    assert.strictEqual(numericPrefix(random.pick(JS_SPACES) + text), null, show(text));
  }
});

test(`F8 N2, N3: a number built from the grammar reads as its decimal conversion (${NUMBER_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 8);
  const ascii = (count: number): string => {
    let out = '';
    for (let index = 0; index < count; index += 1) out += String(random.int(10));
    return out;
  };
  for (let run = 0; run < NUMBER_RUNS; run += 1) {
    const sign = random.pick(['', '+', '-']);
    const mantissa = random.chance(0.75)
      ? ascii(1 + random.int(20)) + (random.chance(0.5) ? `.${ascii(random.int(20))}` : '')
      : `.${ascii(1 + random.int(20))}`;
    const exponent = random.chance(0.5) ? random.pick(['e', 'E']) + random.pick(['', '+', '-']) + ascii(1 + random.int(3)) : '';
    const number = sign + mantissa + exponent;
    const dangling = random.pick(['', '', 'e', 'E', 'e+', 'E-', '.', 'x']);
    const expected = Number(number);
    const read = numericPrefix(number + dangling);
    // A dangling `.` after an integer belongs to the number; after a fraction or an exponent it does not.
    assert.strictEqual(read, expected, show(number + dangling));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Setting (K1 to K4, S1 to S8, U1 to U6, X1 to X3)
// ---------------------------------------------------------------------------------------------------------------

const SETTING_RUNS = runs(30000);
test(`F9 S1 to S8, U1 to U6, X1: one pair of each key reads as the rules say (${SETTING_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 9);
  const hits = new Map<string, number>();
  for (let run = 0; run < SETTING_RUNS; run += 1) {
    const key = random.pick(SCALE_KEYS);
    const value = random.chance(0.03) ? randomSoup(random, 50 + random.int(20), false) : randomValue(random);
    const content = spell(key, random) + random.pick(['=', ' = ', '==', '\t=']) + value;
    const label = show(content);
    const asRead = lowerAscii(value);
    const setting = parseViewport(content);
    if (key === 'user-scalable') {
      const expected = expectZoom(asRead, hits);
      assertSetting(
        setting,
        {
          userZoom: expected.zoom,
          maxZoom: 'auto',
          minZoom: 'auto',
          invalidSeparator: content.includes(';'),
          userScalableText: asRead,
          uncertainNote: expected.uncertain ? noteFor(asRead) : undefined,
        },
        label,
      );
    } else {
      const expected = expectScale(asRead, hits);
      const isMaximum = key === 'maximum-scale';
      assertSetting(
        setting,
        {
          userZoom: true,
          maxZoom: isMaximum ? expected.scale : 'auto',
          minZoom: isMaximum ? 'auto' : expected.scale,
          invalidSeparator: content.includes(';'),
          maximumScaleText: isMaximum ? asRead : undefined,
          uncertainNote: expected.uncertain ? noteFor(asRead) : undefined,
        },
        label,
      );
    }
  }
  assertCoverage(hits, [
    'S1', 'S2', 'S3', 'S4', 'S5 no number', 'S5 infinity', 'S6', 'S7 below', 'S7 above', 'S7 inside', 'S7 negative zero',
    'U1', 'U2', 'U3', 'U4 infinity', 'U5 zoom', 'U5 fixed',
  ]);
});

test(`F10 K3, X2: reading "a, b" is reading a, then letting b's keys win and keeping any doubt (${SETTING_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 10);
  for (let run = 0; run < SETTING_RUNS; run += 1) {
    const first = randomContent(random);
    const second = randomContent(random);
    const label = show([first, second]);
    const a = parseViewport(first);
    const b = parseViewport(second);
    const zoomFromSecond = hasKey(second, 'user-scalable');
    const maxFromSecond = hasKey(second, 'maximum-scale');
    const minFromSecond = hasKey(second, 'minimum-scale');
    assertSetting(
      parseViewport(`${first}, ${second}`),
      {
        userZoom: zoomFromSecond ? b.userZoom : a.userZoom,
        userScalableText: zoomFromSecond ? b.userScalableText : a.userScalableText,
        maxZoom: maxFromSecond ? b.maxZoom : a.maxZoom,
        maximumScaleText: maxFromSecond ? b.maximumScaleText : a.maximumScaleText,
        minZoom: minFromSecond ? b.minZoom : a.minZoom,
        invalidSeparator: a.invalidSeparator || b.invalidSeparator,
        uncertainNote: b.uncertainNote ?? a.uncertainNote,
      },
      label,
    );
  }
});

test(`F11 K2, X3: a pair with any other key changes nothing, whatever its value (${runs(15000)} runs)`, () => {
  const random = makeRandom(SEED + 11);
  for (let run = 0; run < runs(15000); run += 1) {
    const first = randomContent(random);
    const second = randomContent(random);
    let key = random.chance(0.7) ? random.pick(IGNORED_KEYS) : randomSoup(random, 1 + random.int(10), false);
    if ((SCALE_KEYS as readonly string[]).includes(lowerAscii(key))) key = `x${key}`;
    const inserted = `${key}=${randomValue(random)}`;
    const label = show([first, inserted, second]);
    const base = parseViewport(`${first}, ${second}`);
    const withOther = parseViewport(`${first}, ${inserted}, ${second}`);
    assertSetting(
      withOther,
      {
        userZoom: base.userZoom,
        maxZoom: base.maxZoom,
        minZoom: base.minZoom,
        invalidSeparator: base.invalidSeparator || inserted.includes(';'),
        userScalableText: base.userScalableText,
        maximumScaleText: base.maximumScaleText,
        uncertainNote: base.uncertainNote,
      },
      label,
    );
  }
});

test(`F12 K3, X2: only the last pair of each key counts; the note names the last doubtful value (${SETTING_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 12);
  let withDoubt = 0;
  for (let run = 0; run < SETTING_RUNS; run += 1) {
    const list: Array<{ key: ScaleKey; text: string }> = [];
    for (let count = 1 + random.int(6); count > 0; count -= 1) {
      const key = random.pick(SCALE_KEYS);
      list.push({ key, text: `${spell(key, random)}=${randomValue(random)}` });
    }
    const lastOnly = list.filter((entry, index) => !list.slice(index + 1).some((later) => later.key === entry.key));
    const full = parseViewport(list.map((entry) => entry.text).join(', '));
    const short = parseViewport(lastOnly.map((entry) => entry.text).join(', '));
    let lastNote: string | undefined;
    for (const entry of list) lastNote = parseViewport(entry.text).uncertainNote ?? lastNote;
    if (lastNote !== undefined) withDoubt += 1;
    const label = show(list.map((entry) => entry.text));
    assertSetting(
      full,
      {
        userZoom: short.userZoom,
        maxZoom: short.maxZoom,
        minZoom: short.minZoom,
        invalidSeparator: list.some((entry) => entry.text.includes(';')),
        userScalableText: short.userScalableText,
        maximumScaleText: short.maximumScaleText,
        uncertainNote: lastNote,
      },
      label,
    );
  }
  assert.ok(withDoubt > SETTING_RUNS / 20, `too few doubtful lists (${withDoubt})`);
});

test(`F13 setting ranges: scales are auto, 0 (only for no) or within 0.1 to 10; never NaN or -0 (${SETTING_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 13);
  for (let run = 0; run < SETTING_RUNS; run += 1) {
    const content = randomContent(random);
    const setting = parseViewport(content);
    for (const scale of [setting.maxZoom, setting.minZoom]) {
      if (scale === 'auto') continue;
      assert.ok(scale === 0 || (scale >= 0.1 && scale <= 10), `scale ${scale} for ${show(content)}`);
      assert.ok(!Object.is(scale, -0), show(content));
    }
    if (setting.maxZoom === 0) assert.strictEqual(setting.maximumScaleText, 'no', show(content));
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Verdict (V1 to V6, W1 to W6)
// ---------------------------------------------------------------------------------------------------------------

const MAX_BELOW_2: Array<[string, number]> = [
  ['no', 0], ['none', 0.1], ['0', 0.1], ['0.05', 0.1], ['yes', 1], ['YES', 1], ['1', 1], ['1;x', 1], ['1.5', 1.5],
  ['1.99', 1.99], ['1.995', 1.995], ['.5', 0.5], ['', 0.1],
];
const MAX_NOT_BELOW_2: Array<[string, number | 'auto']> = [
  ['2', 2], ['2.0', 2], ['5', 5], ['5px', 5], ['device-width', 10], ['25', 10], ['1e1', 10], ['3', 3], ['-1', 'auto'],
  ['-0.5', 'auto'], ['1.9999999999999999', 2],
];
const MIN_OPTIONS: Array<[string, number | 'auto']> = [
  ['no', 0], ['yes', 1], ['0.5', 0.5], ['3', 3], ['5', 5], ['device-height', 10], ['25', 10], ['0.05', 0.1],
  ['-2', 'auto'], ['1.99', 1.99], ['2', 2], ['1', 1],
];
const ZOOM_OFF = ['no', 'NO', '0', 'false', '', '0.5', '-0.5', 'true', '"yes"', 'off', 'no;', '-0'];
const ZOOM_ON = ['yes', 'YES', '1', '-1', 'device-width', '5x', '1.0'];
const DOUBTFUL = ['inf', 'infinity', 'NaN', '-inf', '+nan', 'information', 'nano', '1e999', '-1e999', '9'.repeat(320)];
// Every separator holds a comma: after `=`, T8 passes spaces, NUL and line breaks, so an empty value followed by a
// space would take the next key as its value (that quirk is covered by F1, not here).
const PAIR_SEPARATORS = [', ', ',', ' , ', ',,', '\n,', ',\u0000', '\t,\r\n'];

const VERDICT_RUNS = runs(30000);
test(`F14 V1 to V5 decide in order; user-scalable is reported before maximum-scale in any order (${VERDICT_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 14);
  const combinations = new Set<string>();
  for (let run = 0; run < VERDICT_RUNS; run += 1) {
    const pairs: string[] = [];
    const zoom = random.chance(0.3) ? undefined : random.chance(0.5) ? random.pick(ZOOM_OFF) : random.pick(ZOOM_ON);
    if (zoom !== undefined) pairs.push(`${spell('user-scalable', random)}=${zoom}`);
    const max = random.chance(0.15) ? undefined : random.chance(0.5) ? random.pick(MAX_BELOW_2) : random.pick(MAX_NOT_BELOW_2);
    if (max !== undefined) pairs.push(`${spell('maximum-scale', random)}=${max[0]}`);
    const min = random.chance(0.3) ? undefined : random.pick(MIN_OPTIONS);
    if (min !== undefined) pairs.push(`${spell('minimum-scale', random)}=${min[0]}`);
    const ordered = shuffled(pairs, random);
    const doubt = random.chance(0.2) ? random.pick(DOUBTFUL) : undefined;
    // The doubtful pair comes first, so later pairs override its value but the doubt stays (X2).
    if (doubt !== undefined) ordered.unshift(`${spell(random.pick(SCALE_KEYS), random)}=${doubt}`);
    let content = '';
    ordered.forEach((pair, index) => {
      content += (index === 0 ? '' : random.pick(PAIR_SEPARATORS)) + pair;
    });
    const label = show(content);

    const maxScale = max === undefined ? 'auto' : max[1];
    const minScale = min === undefined ? 'auto' : min[1];
    const v1 = doubt !== undefined;
    const v2 = typeof maxScale === 'number' && typeof minScale === 'number' && minScale > maxScale;
    const v3 = zoom !== undefined && ZOOM_OFF.includes(zoom);
    const v4 = typeof maxScale === 'number' && maxScale < 2;
    combinations.add(`${v1}${v2}${v3}${v4}`);

    const verdict = verdictOf(content);
    if (v1) {
      assert.deepStrictEqual(verdict, { kind: 'unknown', why: `${noteFor(lowerAscii(doubt))} in the viewport setting may be read as a number by some browsers and as a word by others` }, label);
    } else if (v2) {
      assert.deepStrictEqual(verdict, { kind: 'unknown', why: 'the viewport setting gives a minimum-scale above its maximum-scale, which holds the page at one scale' }, label);
    } else if (v3 && zoom !== undefined) {
      const text = lowerAscii(zoom);
      assert.deepStrictEqual(verdict, { kind: 'off', property: 'user-scalable', value: text, reads: text === 'no' ? 'which turns zoom off' : 'which the browser reads as “no”' }, label);
    } else if (v4 && max !== undefined && typeof maxScale === 'number') {
      assert.strictEqual(verdict.kind, 'off', label);
      assert.strictEqual(verdict.property, 'maximum-scale', label);
      assert.strictEqual(verdict.value, lowerAscii(max[0]), label);
      const printed = /^which the browser reads as (.+), below the 2 that 200% zoom needs$/.exec(verdict.reads ?? '');
      assert.ok(printed !== null, label);
      assert.ok(Math.abs(Number(printed[1]) - maxScale) <= 0.005 + 1e-12, label);
    } else {
      assert.deepStrictEqual(verdict, { kind: 'allowed' }, label);
    }
  }
  assert.strictEqual(combinations.size, 16, `only ${combinations.size} of the 16 V1 to V4 combinations were built`);
});

test(`F15 W3, W4: the printed maximum is round(scale * 100) / 100 in shortest form, no exponent, no trailing zero (${runs(20000)} runs)`, () => {
  const random = makeRandom(SEED + 15);
  for (let run = 0; run < runs(20000); run += 1) {
    const text = String(random.int(200000) / 100000);
    const scale = Math.max(0.1, Number(text));
    const reads = verdictOf(`maximum-scale=${text}`).reads ?? '';
    const printed = /^which the browser reads as (0|[1-9][0-9]*)(\.[0-9]{1,2})?, below the 2 that 200% zoom needs$/.exec(reads);
    assert.ok(printed !== null, `${show(text)} printed ${show(reads)}`);
    const n = (printed[1] ?? '') + (printed[2] ?? '');
    assert.ok(!/\.[0-9]*0$/.test(n), `trailing zero in ${n} for ${text}`);
    assert.strictEqual(Number(n), Math.round(scale * 100) / 100, `${text} printed ${n}`);
    if (scale >= 1.995) assert.strictEqual(n, '2', `${text} printed ${n}`);
  }
});

test(`F16 V6 and the 2.4 shapes: verdict fields per kind; exactly 2 is allowed (${VERDICT_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 16);
  for (let run = 0; run < VERDICT_RUNS; run += 1) {
    const content = randomContent(random);
    const setting = parseViewport(content);
    const verdict = zoomVerdict(setting);
    const fields = Object.keys(verdict).sort();
    const label = show(content);
    if (verdict.kind === 'allowed') assert.deepStrictEqual(fields, ['kind'], label);
    if (verdict.kind === 'unknown') assert.deepStrictEqual(fields, ['kind', 'why'], label);
    if (verdict.kind === 'off') {
      assert.deepStrictEqual(fields, ['kind', 'property', 'reads', 'value'], label);
      const recorded = verdict.property === 'user-scalable' ? setting.userScalableText : setting.maximumScaleText;
      assert.strictEqual(verdict.value, recorded, label);
    }
    assert.strictEqual(verdict.kind === 'unknown' && verdict.why.startsWith('the value “'), setting.uncertainNote !== undefined, label);
    if (setting.maxZoom === 2 && setting.uncertainNote === undefined && setting.userZoom) {
      assert.notStrictEqual(verdict.kind === 'off' ? verdict.property : '', 'maximum-scale', label);
    }
  }
});

test(`F17 order of distinct keys never changes the kind; nor the verdict when at most one value is doubtful (${runs(15000)} runs)`, () => {
  const random = makeRandom(SEED + 17);
  for (let run = 0; run < runs(15000); run += 1) {
    const pairs: string[] = [];
    let doubtful = 0;
    for (const key of SCALE_KEYS) {
      if (random.chance(0.3)) continue;
      const pair = `${spell(key, random)}=${randomValue(random)}`;
      if (parseViewport(pair).uncertainNote !== undefined) doubtful += 1;
      pairs.push(pair);
    }
    for (let count = random.int(3); count > 0; count -= 1) pairs.push(`${random.pick(IGNORED_KEYS)}=${randomValue(random)}`);
    const first = verdictOf(shuffled(pairs, random).join(', '));
    const second = verdictOf(shuffled(pairs, random).join(', '));
    const label = show(pairs);
    assert.strictEqual(first.kind, second.kind, label);
    if (doubtful <= 1) assert.deepStrictEqual(first, second, label);
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Several elements (P1 to P4, W7)
// ---------------------------------------------------------------------------------------------------------------

const PAGE_POOLS: Record<ZoomVerdict['kind'], readonly string[]> = {
  allowed: ['', 'width=device-width, initial-scale=1', 'maximum-scale=5', 'user-scalable=yes', 'a', 'minimum-scale=3'],
  off: ['user-scalable=no', 'maximum-scale=1', 'user-scalable=0', 'maximum-scale=none', 'width=1, user-scalable none'],
  unknown: ['maximum-scale=infinity', 'user-scalable=nan', 'minimum-scale=3, maximum-scale=1', 'minimum-scale=1e999'],
};

const PAGE_RUNS = runs(15000);
test(`F18 P1 to P4: last verdict when every kind agrees, else unknown naming the count (${PAGE_RUNS} lists)`, () => {
  const random = makeRandom(SEED + 18);
  let agreeing = 0;
  let disagreeing = 0;
  for (let run = 0; run < PAGE_RUNS; run += 1) {
    const contents: string[] = [];
    const theme = random.pick(['allowed', 'off', 'unknown'] as const);
    for (let count = random.int(6); count > 0; count -= 1) {
      contents.push(random.chance(0.6) ? random.pick(PAGE_POOLS[theme]) : randomContent(random));
    }
    const label = show(contents);
    const verdicts = contents.map((content) => verdictOf(content));
    const result = pageZoomVerdict(contents);
    const last = verdicts[verdicts.length - 1];
    if (last === undefined) {
      assert.deepStrictEqual(result, { kind: 'allowed' }, label);
    } else if (verdicts.every((verdict) => verdict.kind === last.kind)) {
      agreeing += 1;
      assert.deepStrictEqual(result, last, label);
    } else {
      disagreeing += 1;
      assert.deepStrictEqual(
        result,
        {
          kind: 'unknown',
          why: `the page has ${contents.length} viewport settings that disagree about zoom; the browser uses the last one it processed`,
        },
        label,
      );
    }
    // P2: settings never merge, so an ignored pair added to every element changes nothing.
    assert.deepStrictEqual(pageZoomVerdict(contents.map((content) => `${content}, width=1`)), result, label);
    // One element: the page verdict is that element's verdict.
    if (contents.length === 1) assert.deepStrictEqual(result, last, label);
  }
  assert.ok(agreeing > PAGE_RUNS / 10 && disagreeing > PAGE_RUNS / 10, `agreeing ${agreeing}, disagreeing ${disagreeing}`);
});

// ---------------------------------------------------------------------------------------------------------------
// The axe check (A1 to A8)
// ---------------------------------------------------------------------------------------------------------------

/** A1 to A7 transcribed with indexOf instead of split, and parseFloat as the A8 reader. */
function referenceAxe(content: string): boolean {
  if (content.length === 0) return false;
  let userScalable: string | undefined;
  let maximum: string | number | undefined;
  for (const raw of content.split(/[,;]/)) {
    const piece = raw.trim();
    const equals = piece.indexOf('=');
    if (piece === '' || equals === -1) continue;
    const second = piece.indexOf('=', equals + 1);
    const rawKey = piece.slice(0, equals);
    const rawValue = second === -1 ? piece.slice(equals + 1) : piece.slice(equals + 1, second);
    if (rawKey === '' || rawValue === '') continue;
    const key = rawKey.toLowerCase().trim();
    const value = rawValue.toLowerCase().trim();
    if (key === 'maximum-scale') {
      if (value === 'yes') {
        maximum = 1;
        continue;
      }
      const leading = axeNumberOracle(value);
      if (leading !== null && leading < 0) continue;
      maximum = value;
    } else if (key === 'user-scalable') {
      userScalable = value;
    }
  }
  if (userScalable === 'no') return true;
  if (userScalable !== undefined && userScalable !== '') {
    const leading = axeNumberOracle(userScalable);
    if (leading !== null && leading > -1 && leading < 1) return true;
  }
  if (maximum !== undefined && maximum !== '') {
    const leading = typeof maximum === 'number' ? maximum : axeNumberOracle(maximum);
    if (leading !== null && leading < 2) return true;
  }
  return false;
}

const AXE_KEYS = ['user-scalable', 'maximum-scale', 'USER-SCALABLE', 'Maximum-Scale', 'width', 'maximum scale', 'initial-scale', ''];
/** Values the axe check turns on, so that a fair share of the random contents fail. */
const AXE_VALUES = ['no', 'NO', 'No', '0', '0.5', '-0.5', '.5', '-0', '0x', '1', '1.5', '1.99', 'yes', 'YES', '+1', '1e0', '2', '5', '-1', '-1e999', 'no=yes', '0.99'];
function randomAxeContent(random: Random): string {
  if (random.chance(0.2)) return randomContent(random);
  let out = '';
  for (let count = random.int(5); count > 0; count -= 1) {
    if (out !== '' || random.chance(0.1)) out += random.pick([',', ';', ', ', ' ; ', ',,']);
    const space = (): string => (random.chance(0.2) ? random.pick(JS_SPACES) : '');
    out += space() + random.pick(AXE_KEYS) + space();
    if (random.chance(0.9)) out += random.pick(['=', '=', ' = ', '==', '= =', `=${random.pick(JS_SPACES)}`]);
    const roll = random.int(20);
    const value = roll < 9 ? random.pick(AXE_VALUES) : roll < 18 ? randomValue(random) : random.pick(['Infinity', '-Infinity', '+Infinity', '\u0000', 'no\u0000']);
    out += space() + value + space();
    if (random.chance(0.05)) out += `=${randomValue(random)}`;
  }
  return out;
}

const AXE_RUNS = runs(30000);
test(`F19 axe check equals the transcription with parseFloat as the A8 reader (${AXE_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 19);
  let failing = 0;
  for (let run = 0; run < AXE_RUNS; run += 1) {
    const content = random.chance(0.1) ? rawString(random) : randomAxeContent(random);
    const fails = axeFailsViewport(content);
    if (fails) failing += 1;
    assert.strictEqual(fails, referenceAxe(content), show(content));
  }
  assert.ok(failing > AXE_RUNS / 10 && failing < AXE_RUNS * 0.9, `failing ${failing} of ${AXE_RUNS}`);
});

test(`F20 A2, A4: ; and , are the same cut; ASCII case and whitespace at piece edges change nothing (${AXE_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 20);
  for (let run = 0; run < AXE_RUNS; run += 1) {
    const content = randomAxeContent(random);
    const expected = axeFailsViewport(content);
    const label = show(content);
    assert.strictEqual(axeFailsViewport(content.replace(/;/g, ',')), expected, label);
    assert.strictEqual(axeFailsViewport(content.replace(/,/g, ';')), expected, label);
    assert.strictEqual(axeFailsViewport(upperAscii(content)), expected, label);
    const pad = (): string => (random.chance(0.5) ? random.pick(JS_SPACES) : '');
    const padded = pad() + content.replace(/[,;]/g, (cut) => pad() + cut + pad()) + pad();
    assert.strictEqual(axeFailsViewport(padded), expected, show([content, padded]));
  }
});

test(`F21 A5, A6: a negative maximum-scale piece is skipped anywhere; a later piece replaces an earlier one (${AXE_RUNS} runs)`, () => {
  const random = makeRandom(SEED + 21);
  for (let run = 0; run < AXE_RUNS; run += 1) {
    const content = randomAxeContent(random);
    const expected = axeFailsViewport(content);
    const negative = `maximum-scale=-${random.pick(['1', '0.5', '3', '1e999', '2.5px', '.1', '7x', 'Infinity'])}`;
    const label = show([content, negative]);
    if (!negative.endsWith('Infinity')) {
      assert.strictEqual(axeFailsViewport(`${content},${negative}`), expected, label);
      assert.strictEqual(axeFailsViewport(`${negative};${content}`), expected, label);
    }
    // A6: a final user-scalable=no always fails; a final user-scalable=yes leaves only the maximum to decide.
    assert.strictEqual(axeFailsViewport(`${content},user-scalable=no`), true, label);
    const withYes = axeFailsViewport(`${content},user-scalable=yes`);
    const withYesAndNoMaximum = axeFailsViewport(`${content},user-scalable=yes,maximum-scale=5`);
    assert.strictEqual(withYesAndNoMaximum, false, label);
    if (!expected) assert.strictEqual(withYes, false, label);
  }
});
