// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
/*
 * Tests for src/probes/metaViewport.ts (clean room, 2026-11-12).
 *
 * Encodes every example table of docs/process/cleanroom/viewport-behaviour.md (sections 2.2 to 12) and all 79
 * listed test cases (section 11.1, cases 1 to 64, and section 11.2, cases 65 to 79), plus the readings pinned in the
 * implementer's notes (docs/process/cleanroom/NOTES.md).
 * Run: pnpm -C packages/engine exec vitest run test/unit/metaViewport.cleanroom (ported from node:test, unchanged
 * otherwise).
 *
 * The report wording below is typed from section 9 with literal curly quotes, so it cross-checks the module's
 * escaped U+201C and U+201D.
 */
import { describe, test } from 'vitest';
import assert from 'node:assert/strict';
import {
  axeFailsViewport,
  numericPrefix,
  pageZoomVerdict,
  parseViewport,
  viewportPairs,
  zoomVerdict,
} from '../../src/probes/metaViewport.js';

type Pair = [string, string];
type Verdict = ReturnType<typeof zoomVerdict>;

// ---------------------------------------------------------------------------------------------------------------
// Section 9 wording
// ---------------------------------------------------------------------------------------------------------------

const W1 = 'which turns zoom off';
const W2 = 'which the browser reads as “no”';
function W3(n: string): string {
  return `which the browser reads as ${n}, below the 2 that 200% zoom needs`;
}
function W5(shown: string): string {
  return `the value “${shown}” in the viewport setting may be read as a number by some browsers and as a word by others`;
}
const W6 = 'the viewport setting gives a minimum-scale above its maximum-scale, which holds the page at one scale';
function W7(n: number): string {
  return `the page has ${n} viewport settings that disagree about zoom; the browser uses the last one it processed`;
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

const NBSP = ' ';
const NUL = '\u0000';
const FF = '\f';
const VT = '\v';
const EMOJI_25 = '😀'.repeat(25);

const ALLOWED: Verdict = { kind: 'allowed' };
function off(property: 'user-scalable' | 'maximum-scale', value: string, reads: string): Verdict {
  return { kind: 'off', property, value, reads };
}
function unknown(why: string): Verdict {
  return { kind: 'unknown', why };
}
function verdictOf(content: string): Verdict {
  return zoomVerdict(parseViewport(content));
}
function show(value: unknown): string {
  return JSON.stringify(value);
}
/** T1 for the expectations: ASCII capitals only. */
function lowerAscii(text: string): string {
  return text.replace(/[A-Z]/g, (capital) => capital.toLowerCase());
}
/** Partial match: every expected field is deep-strict-equal (so 0 and -0 differ); extra actual fields are fine. */
function assertPartial(actual: unknown, expected: Record<string, unknown>): void {
  assert.equal(typeof actual, 'object');
  const record = actual as Record<string, unknown>;
  for (const [field, value] of Object.entries(expected)) {
    assert.deepStrictEqual(record[field], value, `field ${field} of ${show(actual)}`);
  }
}

/** The probe logic of section 2.5 (not part of the module), to run the integration cases 65 to 79. */
interface Finding {
  status: 'failed' | 'not_testable';
  detail: string;
}
function probeFindings(contents: readonly string[]): Finding[] {
  if (contents.some((content) => axeFailsViewport(content))) return [];
  const verdict = pageZoomVerdict(contents);
  if (verdict.kind === 'allowed') return [];
  if (verdict.kind === 'unknown') {
    return [{ status: 'not_testable', detail: 'Whether the page lets a phone zoom to 200% could not be told: ' + verdict.why }];
  }
  return [
    {
      status: 'failed',
      detail:
        'The page turns zoom off on phones: its viewport setting has ' +
        verdict.property +
        '=' +
        (verdict.value === '' ? '(no value)' : verdict.value) +
        ', ' +
        verdict.reads,
    },
  ];
}

// ---------------------------------------------------------------------------------------------------------------
// Section 11.1: the unit test cases 1 to 64
// ---------------------------------------------------------------------------------------------------------------

describe('section 11.1: unit test cases 1 to 64', () => {
  const pairsCases: Array<[number, string, Pair[]]> = [
    [1, 'width=device-width, initial-scale=1', [['width', 'device-width'], ['initial-scale', '1']]],
    [3, 'WIDTH = Device-Width\n\tuser-scalable = NO', [['width', 'device-width'], ['user-scalable', 'no']]],
    [4, '', []],
    [5, 'user-scalable, maximum-scale=1', [['user-scalable', ''], ['maximum-scale', '1']]],
    [6, 'user-scalable no', [['user-scalable', '']]],
    [7, 'user-scalable no, width=320', [['user-scalable', ''], ['width', '320']]],
  ];
  for (const [number, input, pairs] of pairsCases) {
    test(`#${number} Pairs ${show(input)}`, () => {
      assert.deepStrictEqual(viewportPairs(input).pairs, pairs);
    });
  }
  test('#2 Pairs "width=device-width,maximum-scale=5;user-scalable=false" (whole result)', () => {
    assert.deepStrictEqual(viewportPairs('width=device-width,maximum-scale=5;user-scalable=false'), {
      pairs: [['width', 'device-width'], ['maximum-scale', '5;user-scalable'], ['false', '']],
      invalidSeparator: true,
    });
  });

  const numberCases: Array<[number, string, number | null]> = [
    [8, '5;user-scalable', 5],
    [9, '1.0x', 1],
    [10, '.5', 0.5],
    [11, '+2', 2],
    [12, '-1', -1],
    [13, '1e1', 10],
    [14, 'none', null],
  ];
  for (const [number, input, expected] of numberCases) {
    test(`#${number} Number ${show(input)}`, () => {
      assert.strictEqual(numericPrefix(input), expected);
    });
  }

  const maximumCases: Array<[number, string, number | 'auto']> = [
    [15, 'maximum-scale=yes', 1],
    [16, 'maximum-scale=no', 0],
    [17, 'maximum-scale=none', 0.1],
    [18, 'maximum-scale=device-width', 10],
    [19, 'maximum-scale=-1', 'auto'],
    [20, 'maximum-scale=25', 10],
    [21, 'maximum-scale=0.05', 0.1],
  ];
  for (const [number, input, expected] of maximumCases) {
    test(`#${number} Setting: maximum ${show(input)}`, () => {
      assert.strictEqual(parseViewport(input).maxZoom, expected);
    });
  }

  const zoomCases: Array<[number, string, boolean]> = [
    [22, 'user-scalable=yes', true],
    [23, 'user-scalable=device-width', true],
    [24, 'user-scalable=device-height', true],
    [25, 'user-scalable=1', true],
    [26, 'user-scalable=-1', true],
    [27, 'user-scalable=5x', true],
    [28, 'user-scalable=no', false],
    [29, 'user-scalable=false', false],
    [30, 'user-scalable=0', false],
    [31, 'user-scalable=0.5', false],
    [32, 'user-scalable=-0.5', false],
    [33, 'user-scalable=', false],
  ];
  for (const [number, input, expected] of zoomCases) {
    test(`#${number} Setting: zoom allowed ${show(input)}`, () => {
      assert.strictEqual(parseViewport(input).userZoom, expected);
    });
  }

  test('#34 Setting (partial match) "width=device-width, maximum-scale=5;user-scalable=false"', () => {
    assertPartial(parseViewport('width=device-width, maximum-scale=5;user-scalable=false'), {
      userZoom: true,
      maxZoom: 5,
      invalidSeparator: true,
    });
  });

  const verdictCases: Array<[number, string, Record<string, unknown>]> = [
    [35, 'width=device-width, maximum-scale=5;user-scalable=false', { kind: 'allowed' }],
    [36, 'width=device-width, maximum-scale=5;user-scalable=no', { kind: 'allowed' }],
    [37, 'width=device-width, user-scalable=false', { kind: 'off', property: 'user-scalable', value: 'false' }],
    [38, 'user-scalable=no', { kind: 'off', property: 'user-scalable' }],
    [39, 'width=device-width; maximum-scale=none', { kind: 'off', property: 'maximum-scale', value: 'none' }],
    [40, 'maximum-scale=1', { kind: 'off' }],
    [41, 'maximum-scale=yes', { kind: 'off' }],
    [42, 'maximum-scale=1.9', { kind: 'off' }],
    [43, 'maximum-scale=1;x', { kind: 'off' }],
    [44, '', { kind: 'allowed' }],
    [45, 'width=device-width, initial-scale=1', { kind: 'allowed' }],
    [46, 'maximum-scale=2', { kind: 'allowed' }],
    [47, 'maximum-scale=device-width', { kind: 'allowed' }],
    [48, 'maximum-scale=-3', { kind: 'allowed' }],
    [49, 'user-scalable=no, user-scalable=yes', { kind: 'allowed' }],
    [50, 'maximum-scale=infinity', { kind: 'unknown' }],
    [51, 'minimum-scale=3, maximum-scale=1', { kind: 'unknown' }],
  ];
  for (const [number, input, expected] of verdictCases) {
    test(`#${number} Verdict ${show(input)}`, () => {
      assertPartial(verdictOf(input), expected);
    });
  }

  const pageCases: Array<[number, string[], string]> = [
    [52, ['user-scalable=no', 'width=device-width'], 'unknown'],
    [53, ['user-scalable=no', 'maximum-scale=1'], 'off'],
    [54, [], 'allowed'],
  ];
  for (const [number, input, kind] of pageCases) {
    test(`#${number} Page ${show(input)}`, () => {
      assertPartial(pageZoomVerdict(input), { kind });
    });
  }

  const axeCases: Array<[number, string, boolean]> = [
    [55, 'user-scalable=no', true],
    [56, 'user-scalable=0', true],
    [57, 'maximum-scale=1', true],
    [58, 'maximum-scale=yes', true],
    [59, 'width=device-width; user-scalable=no', true],
    [60, 'user-scalable=false', false],
    [61, 'maximum-scale=none', false],
    [62, 'maximum-scale=5', false],
    [63, 'width=device-width', false],
    [64, '', false],
  ];
  for (const [number, input, expected] of axeCases) {
    test(`#${number} Axe ${show(input)}`, () => {
      assert.strictEqual(axeFailsViewport(input), expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 11.2: the integration cases 65 to 79, through the probe logic of section 2.5
// ---------------------------------------------------------------------------------------------------------------

describe('section 11.2: integration cases 65 to 79 (probe logic of 2.5)', () => {
  test('#65 scalable-false', () => {
    assert.deepStrictEqual(probeFindings(['width=device-width, initial-scale=1, user-scalable=false']), [
      {
        status: 'failed',
        detail:
          'The page turns zoom off on phones: its viewport setting has user-scalable=false, which the browser reads as “no”',
      },
    ]);
  });
  test('#66 max-none', () => {
    const findings = probeFindings(['width=device-width; maximum-scale=none']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.status, 'failed');
    assert.ok(
      findings[0]?.detail.includes('maximum-scale=none, which the browser reads as 0.1, below the 2 that 200% zoom needs'),
      show(findings),
    );
  });
  test('#67 word-after-space', () => {
    const findings = probeFindings(['width=device-width, user-scalable none']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.status, 'failed');
    assert.ok(findings[0]?.detail.includes('user-scalable=(no value), which the browser reads as “no”'), show(findings));
  });
  test('#68 semicolon', () => {
    assert.deepStrictEqual(probeFindings(['width=device-width, maximum-scale=5;user-scalable=false']), []);
  });
  test('#69 odd', () => {
    const findings = probeFindings(['width=device-width, maximum-scale=infinity']);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.status, 'not_testable');
    assert.ok(findings[0]?.detail.includes('Whether the page lets a phone zoom to 200% could not be told'), show(findings));
  });
  test('#70 scalable-yes', () => {
    const findings = probeFindings(['width=device-width, initial-scale=1, user-scalable=yes']);
    assert.equal(findings.filter((finding) => finding.status === 'failed').length, 0);
    assert.equal(findings.filter((finding) => finding.status === 'not_testable').length, 0);
  });
  const silent: Array<[number, string, string[]]> = [
    [71, 'scalable-width', ['width=device-width, user-scalable=device-width']],
    [72, 'scalable-1', ['width=device-width, user-scalable=1']],
    [73, 'max-5', ['width=device-width, maximum-scale=5']],
    [74, 'max-width', ['width=device-width, maximum-scale=device-width']],
    [75, 'plain', ['width=device-width, initial-scale=1']],
    [76, 'none (no viewport element)', []],
  ];
  for (const [number, name, contents] of silent) {
    test(`#${number} ${name}`, () => {
      assert.deepStrictEqual(probeFindings(contents), []);
    });
  }
  const axeSilent: Array<[number, string, string]> = [
    [77, 'axe-no', 'width=device-width, user-scalable=no'],
    [78, 'axe-max-1', 'width=device-width, maximum-scale=1'],
    [79, 'semicolon-no', 'width=device-width, maximum-scale=5;user-scalable=no'],
  ];
  for (const [number, name, content] of axeSilent) {
    test(`#${number} ${name} (axe fails it, the probe stays silent)`, () => {
      assert.strictEqual(axeFailsViewport(content), true);
      assert.deepStrictEqual(probeFindings([content]), []);
    });
  }
  test('#79 semicolon-no: the verdict alone is allowed', () => {
    assert.deepStrictEqual(verdictOf('width=device-width, maximum-scale=5;user-scalable=no'), ALLOWED);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Section 3.2: pairs
// ---------------------------------------------------------------------------------------------------------------

describe('section 3.2: pairs examples', () => {
  const rows: Array<[string, Pair[], boolean]> = [
    ['', [], false],
    [' ', [['', '']], false],
    [',', [['', '']], false],
    ['=', [['', '']], false],
    [' , = ', [['', '']], false],
    [';', [[';', '']], true],
    ['width=device-width, initial-scale=1', [['width', 'device-width'], ['initial-scale', '1']], false],
    ['width=device-width,initial-scale=1', [['width', 'device-width'], ['initial-scale', '1']], false],
    ['width=device-width,', [['width', 'device-width'], ['', '']], false],
    ['width=device-width, ', [['width', 'device-width'], ['', '']], false],
    [', width=device-width', [['width', 'device-width']], false],
    ['width=device-width,,,user-scalable=no', [['width', 'device-width'], ['user-scalable', 'no']], false],
    ['WIDTH = Device-Width\n\tuser-scalable = NO', [['width', 'device-width'], ['user-scalable', 'no']], false],
    ['maximum-scale\t=\t1', [['maximum-scale', '1']], false],
    ['maximum-scale=1\r\nuser-scalable=no', [['maximum-scale', '1'], ['user-scalable', 'no']], false],
    ['width=device-width user-scalable=no', [['width', 'device-width'], ['user-scalable', 'no']], false],
    [
      'width=device-width,maximum-scale=5;user-scalable=false',
      [['width', 'device-width'], ['maximum-scale', '5;user-scalable'], ['false', '']],
      true,
    ],
    ['width=device-width; initial-scale=1', [['width', 'device-width;'], ['initial-scale', '1']], true],
    ['maximum-scale=5; user-scalable=no', [['maximum-scale', '5;'], ['user-scalable', 'no']], true],
    ['maximum-scale=5 ;user-scalable=no', [['maximum-scale', '5'], [';user-scalable', 'no']], true],
    [
      'width=device-width; initial-scale=1; maximum-scale=1; user-scalable=no',
      [['width', 'device-width;'], ['initial-scale', '1;'], ['maximum-scale', '1;'], ['user-scalable', 'no']],
      true,
    ],
    ['initial-scale=1;user-scalable=no', [['initial-scale', '1;user-scalable'], ['no', '']], true],
    ['a;b,c;d', [['a;b', ''], ['c;d', '']], true],
    ['user-scalable, maximum-scale=1', [['user-scalable', ''], ['maximum-scale', '1']], false],
    ['user-scalable no', [['user-scalable', '']], false],
    ['user-scalable no, width=320', [['user-scalable', ''], ['width', '320']], false],
    ['width device-width', [['width', '']], false],
    ['user-scalable foo=no', [['user-scalable', 'no']], false],
    ['user scalable=no', [['user', 'no']], false],
    ['a b c=d', [['a', 'd']], false],
    ['user-scalable=', [['user-scalable', '']], false],
    ['user-scalable=,width=1', [['user-scalable', ''], ['width', '1']], false],
    ['maximum-scale = , user-scalable=yes', [['maximum-scale', ''], ['user-scalable', 'yes']], false],
    ['user-scalable==no', [['user-scalable', 'no']], false],
    ['user-scalable = = no', [['user-scalable', 'no']], false],
    ['maximum-scale==2', [['maximum-scale', '2']], false],
    ['=user-scalable=no', [['user-scalable', 'no']], false],
    ['user-scalable=no=yes', [['user-scalable', 'no'], ['yes', '']], false],
    [`user-scalable=${NBSP}no`, [['user-scalable', `${NBSP}no`]], false],
    [`maximum-scale=${NBSP}5`, [['maximum-scale', `${NBSP}5`]], false],
    [`width=1${FF}user-scalable=no`, [['width', `1${FF}user-scalable`], ['no', '']], false],
    [`width=1${VT}user-scalable=no`, [['width', `1${VT}user-scalable`], ['no', '']], false],
    [`width=1${NUL}user-scalable=no`, [['width', '1'], ['user-scalable', 'no']], false],
    [`user-scalable=no${NUL}yes`, [['user-scalable', 'no'], ['yes', '']], false],
    ['user-scalable="no"', [['user-scalable', '"no"']], false],
    ["maximum-scale='5'", [['maximum-scale', "'5'"]], false],
    ['"width=device-width, user-scalable=no"', [['"width', 'device-width'], ['user-scalable', 'no"']], false],
    ['maximum-scale=1,5', [['maximum-scale', '1'], ['5', '']], false],
    ['MAXIMUM-SCALE=YES', [['maximum-scale', 'yes']], false],
    ['user-scalable=ＮＯ', [['user-scalable', 'ＮＯ']], false],
  ];
  for (const [input, pairs, flag] of rows) {
    test(`pairs ${show(input)}`, () => {
      assert.deepStrictEqual(viewportPairs(input), { pairs, invalidSeparator: flag });
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 4.2: numbers
// ---------------------------------------------------------------------------------------------------------------

describe('section 4.2: number examples', () => {
  const rows: Array<[string, number | null]> = [
    ['5;user-scalable', 5],
    ['1.0x', 1],
    ['.5', 0.5],
    ['+.5', 0.5],
    ['-.5', -0.5],
    ['+2', 2],
    ['-1', -1],
    ['1.', 1],
    ['007', 7],
    ['00.5', 0.5],
    ['1e1', 10],
    ['1E2', 100],
    ['1e+1', 10],
    ['1e-1', 0.1],
    ['1.5e+1', 15],
    ['0.1e1', 1],
    ['1e', 1],
    ['1e+', 1],
    ['1e-', 1],
    ['1e999', Infinity],
    ['1e999x', Infinity],
    ['-1e999', -Infinity],
    ['-1e999 ', -Infinity],
    ['1e-999', 0],
    ['1.9999999999999999', 2],
    ['0x10', 0],
    ['2.5.1', 2.5],
    ['5px', 5],
    ['1_000', 1],
    ['-0', -0],
    ['none', null],
    ['', null],
    [' 5', null],
    ['  ', null],
    ['.', null],
    ['+', null],
    ['-', null],
    ['e5', null],
    ['-.e1', null],
    ['inf', null],
    ['nan', null],
    ['−1', null],
    ['５', null],
    ['١', null],
  ];
  for (const [input, expected] of rows) {
    test(`number ${show(input)} reads ${Object.is(expected, -0) ? '-0' : String(expected)}`, () => {
      // strictEqual compares with Object.is, so 0 and -0 are told apart.
      assert.strictEqual(numericPrefix(input), expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 5.2: maximum-scale values
// ---------------------------------------------------------------------------------------------------------------

describe('section 5.2: maximum-scale values', () => {
  interface Row {
    values: string[];
    max: number | 'auto' | 'as written';
    verdict: 'allowed' | 'off' | 'unknown';
    n?: string;
  }
  const rows: Row[] = [
    { values: ['yes'], max: 1, verdict: 'off', n: '1' },
    { values: ['no'], max: 0, verdict: 'off', n: '0' },
    { values: ['device-width', 'device-height'], max: 10, verdict: 'allowed' },
    { values: ['none', 'auto', 'true', 'false', 'fixed', 'zoom'], max: 0.1, verdict: 'off', n: '0.1' },
    { values: ['"5"', "'2'", '"yes"'], max: 0.1, verdict: 'off', n: '0.1' },
    { values: [`${NBSP}5`, '５', '−1', '0x10', 'İnf', EMOJI_25], max: 0.1, verdict: 'off', n: '0.1' },
    { values: ['0', '-0', '0.05', '0.1', '1e-1', '1e-999'], max: 0.1, verdict: 'off', n: '0.1' },
    { values: ['0.5', '.5'], max: 0.5, verdict: 'off', n: '0.5' },
    { values: ['1', '1.0', '1;', '1;x'], max: 1, verdict: 'off', n: '1' },
    { values: ['1.5'], max: 1.5, verdict: 'off', n: '1.5' },
    { values: ['1.9'], max: 'as written', verdict: 'off', n: '1.9' },
    { values: ['1.99', '1.994'], max: 'as written', verdict: 'off', n: '1.99' },
    { values: ['1.995', '1.999'], max: 'as written', verdict: 'off', n: '2' },
    { values: ['1.9999999999999999'], max: 2, verdict: 'allowed' },
    { values: ['2', '2.0'], max: 2, verdict: 'allowed' },
    { values: ['2.5', '2.5.1'], max: 2.5, verdict: 'allowed' },
    { values: ['5', '5.', '5px', '5;user-scalable'], max: 5, verdict: 'allowed' },
    { values: ['+3'], max: 3, verdict: 'allowed' },
    { values: ['10', '1e1'], max: 10, verdict: 'allowed' },
    { values: ['10.5', '25', '1.5e+1'], max: 10, verdict: 'allowed' },
    { values: ['-1', '-3', '-0.5'], max: 'auto', verdict: 'allowed' },
    {
      values: ['infinity', 'inf', '-inf', '+inf', 'nan', '+nan', '-nan', 'information', 'nano'],
      max: 'auto',
      verdict: 'unknown',
    },
    { values: ['1e999', '-1e999'], max: 'auto', verdict: 'unknown' },
  ];
  for (const row of rows) {
    for (const value of row.values) {
      const content = `maximum-scale=${value}`;
      test(`maximum-scale ${show(value)}`, () => {
        const setting = parseViewport(content);
        const expectedMax = row.max === 'as written' ? Number(value) : row.max;
        assert.strictEqual(setting.maxZoom, expectedMax);
        const verdict = zoomVerdict(setting);
        if (row.verdict === 'off') assert.deepStrictEqual(verdict, off('maximum-scale', value, W3(row.n ?? '?')));
        if (row.verdict === 'allowed') assert.deepStrictEqual(verdict, ALLOWED);
        if (row.verdict === 'unknown') assert.deepStrictEqual(verdict, unknown(W5(value)));
        if (row.verdict !== 'unknown') assert.strictEqual(setting.uncertainNote, undefined);
      });
    }
  }
  for (const content of ['maximum-scale=', 'maximum-scale = , user-scalable=yes']) {
    test(`maximum-scale (empty) in ${show(content)}`, () => {
      assert.strictEqual(parseViewport(content).maxZoom, 0.1);
      assert.deepStrictEqual(verdictOf(content), off('maximum-scale', '', W3('0.1')));
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 5.3: user-scalable values
// ---------------------------------------------------------------------------------------------------------------

describe('section 5.3: user-scalable values', () => {
  interface Row {
    values: string[];
    zoom: boolean;
    verdict: 'allowed' | 'off' | 'unknown';
    reads?: string;
  }
  const rows: Row[] = [
    { values: ['yes', 'YES', 'device-width', 'device-height'], zoom: true, verdict: 'allowed' },
    { values: ['1', '1.0', '+1', '1e0', '1;', '5x', '-1', '-1.5'], zoom: true, verdict: 'allowed' },
    { values: ['no', 'No'], zoom: false, verdict: 'off', reads: W1 },
    { values: ['0', '-0', '0.5', '-0.5', '0.999', '.9', '1e-999', '0;x'], zoom: false, verdict: 'off', reads: W2 },
    { values: ['false', 'true', 'on', 'off', 'fixed', 'zoom'], zoom: false, verdict: 'off', reads: W2 },
    { values: ['"yes"', '"no"', 'no;', `${NBSP}no`, 'ＮＯ', 'nİ'], zoom: false, verdict: 'off', reads: W2 },
    { values: ['infinity', 'nan', '-inf', '1e999', '-1e999'], zoom: true, verdict: 'unknown' },
  ];
  for (const row of rows) {
    for (const value of row.values) {
      const content = `user-scalable=${value}`;
      test(`user-scalable ${show(value)}`, () => {
        const setting = parseViewport(content);
        assert.strictEqual(setting.userZoom, row.zoom);
        const verdict = zoomVerdict(setting);
        const asRead = lowerAscii(value);
        if (row.verdict === 'off') assert.deepStrictEqual(verdict, off('user-scalable', asRead, row.reads ?? '?'));
        if (row.verdict === 'allowed') assert.deepStrictEqual(verdict, ALLOWED);
        if (row.verdict === 'unknown') assert.deepStrictEqual(verdict, unknown(W5(asRead)));
      });
    }
  }
  for (const content of ['user-scalable=', 'user-scalable', 'user-scalable no', 'user-scalable, width=device-width']) {
    test(`user-scalable (empty) in ${show(content)}`, () => {
      assert.strictEqual(parseViewport(content).userZoom, false);
      assert.deepStrictEqual(verdictOf(content), off('user-scalable', '', W2));
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 5.4: uncertainty
// ---------------------------------------------------------------------------------------------------------------

describe('section 5.4: uncertainty', () => {
  test('maximum-scale=infinity, maximum-scale=5: maximum 5, but uncertain (note names infinity)', () => {
    const setting = parseViewport('maximum-scale=infinity, maximum-scale=5');
    assert.strictEqual(setting.maxZoom, 5);
    assert.deepStrictEqual(zoomVerdict(setting), unknown(W5('infinity')));
  });
  test('maximum-scale=5, maximum-scale=infinity: no limit, uncertain', () => {
    const setting = parseViewport('maximum-scale=5, maximum-scale=infinity');
    assert.strictEqual(setting.maxZoom, 'auto');
    assert.deepStrictEqual(zoomVerdict(setting), unknown(W5('infinity')));
  });
  test('maximum-scale=infinity, user-scalable=nan: note names nan', () => {
    assert.deepStrictEqual(verdictOf('maximum-scale=infinity, user-scalable=nan'), unknown(W5('nan')));
  });
  const unknownRows = [
    'maximum-scale=5, minimum-scale=infinity',
    'minimum-scale=nan, user-scalable=no',
    'user-scalable=no, maximum-scale=infinity',
    'user-scalable=nan, user-scalable=no',
  ];
  for (const content of unknownRows) {
    test(`${show(content)}: unknown (not off)`, () => {
      assertPartial(verdictOf(content), { kind: 'unknown' });
    });
  }
  for (const content of ['initial-scale=infinity', 'width=nan']) {
    test(`${show(content)}: ignored key, allowed`, () => {
      assert.deepStrictEqual(verdictOf(content), ALLOWED);
      assert.strictEqual(parseViewport(content).uncertainNote, undefined);
    });
  }
  test('maximum-scale=nan followed by 47 x: the note keeps 40 characters', () => {
    const content = `maximum-scale=nan${'x'.repeat(47)}`;
    assert.deepStrictEqual(verdictOf(content), unknown(W5(`nan${'x'.repeat(37)}`)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Section 6.2: the verdict for one content string
// ---------------------------------------------------------------------------------------------------------------

describe('section 6.2: verdict examples', () => {
  const rows: Array<[string[], Verdict]> = [
    [[''], ALLOWED],
    [['width=device-width, initial-scale=1'], ALLOWED],
    [['initial-scale=5', 'initial-scale=0.1', 'width=100', 'height=device-height'], ALLOWED],
    [
      [
        'viewport-fit=cover',
        'interactive-widget=resizes-content',
        'shrink-to-fit=no',
        'target-densitydpi=device-dpi',
        'minimal-ui',
      ],
      ALLOWED,
    ],
    [['maximum_scale=1', 'maximum-scale;=1', 'user scalable=no'], ALLOWED],
    [['minimum-scale=3'], ALLOWED],
    [['minimum-scale=3, maximum-scale=1'], unknown(W6)],
    [['maximum-scale=1, minimum-scale=3'], unknown(W6)],
    [['minimum-scale=5, maximum-scale=4'], unknown(W6)],
    [['minimum-scale=device-width, maximum-scale=5'], unknown(W6)],
    [['minimum-scale=1, maximum-scale=no'], unknown(W6)],
    [['minimum-scale=yes, maximum-scale=no'], unknown(W6)],
    [['user-scalable=no, minimum-scale=3, maximum-scale=1'], unknown(W6)],
    [['minimum-scale=2, maximum-scale=2'], ALLOWED],
    [['minimum-scale=25, maximum-scale=10'], ALLOWED],
    [['minimum-scale=1, maximum-scale=1'], off('maximum-scale', '1', W3('1'))],
    [['minimum-scale=0.5, maximum-scale=1'], off('maximum-scale', '1', W3('1'))],
    [['minimum-scale=no, maximum-scale=no'], off('maximum-scale', 'no', W3('0'))],
    [['minimum-scale=0.05, maximum-scale=0.1'], off('maximum-scale', '0.1', W3('0.1'))],
    [['minimum-scale=-1, maximum-scale=1'], off('maximum-scale', '1', W3('1'))],
    [['user-scalable=no'], off('user-scalable', 'no', W1)],
    [['user-scalable=no, maximum-scale=1'], off('user-scalable', 'no', W1)],
    [['maximum-scale=1, user-scalable=no'], off('user-scalable', 'no', W1)],
    [['initial-scale=1, maximum-scale=1, user-scalable=0'], off('user-scalable', '0', W2)],
    [['width=device-width, initial-scale=1, user-scalable=false'], off('user-scalable', 'false', W2)],
    [['width=device-width, user-scalable none'], off('user-scalable', '', W2)],
    [['"width=device-width, user-scalable=no"'], off('user-scalable', 'no"', W2)],
    [['user-scalable=no;'], off('user-scalable', 'no;', W2)],
    [[`width=1${NUL}user-scalable=no`], off('user-scalable', 'no', W1)],
    [[`width=1${FF}user-scalable=no`], ALLOWED],
    [['width=device-width; maximum-scale=none'], off('maximum-scale', 'none', W3('0.1'))],
    [['width=device-width; initial-scale=1; maximum-scale=1; user-scalable=no'], off('user-scalable', 'no', W1)],
    [['width=device-width, maximum-scale=5;user-scalable=false'], ALLOWED],
    [['width=device-width, maximum-scale=5;user-scalable=no'], ALLOWED],
    [['maximum-scale=2;user-scalable=no'], ALLOWED],
    [['maximum-scale=5 ;user-scalable=no'], ALLOWED],
    [['initial-scale=1;user-scalable=no'], ALLOWED],
    [['maximum-scale=1,5'], off('maximum-scale', '1', W3('1'))],
    [['maximum-scale==2'], ALLOWED],
    [['maximum-scale = , user-scalable=yes'], off('maximum-scale', '', W3('0.1'))],
    [['user-scalable=no, user-scalable=yes'], ALLOWED],
    [['USER-SCALABLE=no, user-scalable=yes'], ALLOWED],
    [['user-scalable=yes, user-scalable=no'], off('user-scalable', 'no', W1)],
    [['maximum-scale=1, maximum-scale=5'], ALLOWED],
    [['maximum-scale=5, maximum-scale=1'], off('maximum-scale', '1', W3('1'))],
    [['maximum-scale=1, maximum-scale=-1'], ALLOWED],
    [['maximum-scale=1, maximum-scale=none'], off('maximum-scale', 'none', W3('0.1'))],
    [['maximum-scale=infinity'], unknown(W5('infinity'))],
  ];
  for (const [contents, expected] of rows) {
    for (const content of contents) {
      test(`verdict ${show(content)}`, () => {
        assert.deepStrictEqual(verdictOf(content), expected);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 7.2: several viewport elements
// ---------------------------------------------------------------------------------------------------------------

describe('section 7.2: page examples', () => {
  const rows: Array<[string[], Verdict]> = [
    [[], ALLOWED],
    [[''], ALLOWED],
    [['a', 'b', 'c'], ALLOWED],
    [['user-scalable=no'], off('user-scalable', 'no', W1)],
    [['user-scalable=no', 'width=device-width'], unknown(W7(2))],
    [['width=device-width', 'user-scalable=no'], unknown(W7(2))],
    [['', 'user-scalable=no'], unknown(W7(2))],
    [['user-scalable=no', 'user-scalable=yes'], unknown(W7(2))],
    [['user-scalable=no', 'maximum-scale=1'], off('maximum-scale', '1', W3('1'))],
    [['maximum-scale=1', 'user-scalable=no'], off('user-scalable', 'no', W1)],
    [['maximum-scale=infinity'], unknown(W5('infinity'))],
    [['maximum-scale=infinity', 'maximum-scale=nan'], unknown(W5('nan'))],
    [['maximum-scale=infinity', 'minimum-scale=3, maximum-scale=1'], unknown(W6)],
    [['user-scalable=no', 'maximum-scale=1', 'width=1'], unknown(W7(3))],
  ];
  for (const [contents, expected] of rows) {
    test(`page ${show(contents)}`, () => {
      assert.deepStrictEqual(pageZoomVerdict(contents), expected);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 8.2: the axe check
// ---------------------------------------------------------------------------------------------------------------

describe('section 8.2: axe check examples', () => {
  const rows: Array<[string[], boolean]> = [
    [['', ' '], false],
    [['width=device-width'], false],
    [['user-scalable=no', 'user-scalable=NO', 'USER-SCALABLE=no', 'user-scalable = no'], true],
    [[`user-scalable=${NBSP}no`], true],
    [[`user-scalable=no${NUL}`], false],
    [['user-scalable=0', 'user-scalable=-0', 'user-scalable=0.5', 'user-scalable=-0.5', 'user-scalable=.5'], true],
    [['user-scalable=0.99', 'user-scalable=-0.99', 'user-scalable=0x', 'user-scalable=0.5abc'], true],
    [['user-scalable=1', 'user-scalable=-1', 'user-scalable=yes'], false],
    [['user-scalable=false', 'user-scalable=true', 'user-scalable="no"', 'user-scalable=Infinity'], false],
    [['user-scalable', 'user-scalable=', 'user-scalable no', '=no'], false],
    [['user-scalable= =no'], false],
    [['user-scalable=no=yes'], true],
    [['user-scalable=no, user-scalable=yes'], false],
    [['user-scalable=yes, user-scalable=no'], true],
    [['width=device-width; user-scalable=no'], true],
    [
      ['maximum-scale=1', 'maximum-scale=yes', 'Maximum-Scale=YES', 'maximum-scale=+1', 'maximum-scale=1e0'],
      true,
    ],
    [['maximum-scale=0', 'maximum-scale=.5', 'maximum-scale=1.99', 'maximum-scale=1.5px', 'maximum-scale=1 5'], true],
    [['maximum-scale =1', `maximum-scale=${NBSP}1`], true],
    [['maximum-scale=1;x'], true],
    [['maximum-scale=5;user-scalable=no'], true],
    [['maximum-scale=2', 'maximum-scale=5', 'maximum-scale=device-width'], false],
    [['maximum-scale=none', 'maximum-scale=no', 'maximum-scale=Infinity'], false],
    [['maximum-scale=-1'], false],
    [['maximum-scale=1, maximum-scale=-1'], true],
    [['maximum-scale=-1, maximum-scale=1'], true],
    [['maximum scale=1'], false],
  ];
  for (const [contents, expected] of rows) {
    for (const content of contents) {
      test(`axe ${show(content)} fails: ${String(expected)}`, () => {
        assert.strictEqual(axeFailsViewport(content), expected);
      });
    }
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Section 9: wording, character for character
// ---------------------------------------------------------------------------------------------------------------

describe('section 9: wording', () => {
  test('W1', () => {
    assert.strictEqual(verdictOf('user-scalable=no').reads, 'which turns zoom off');
  });
  test('W2', () => {
    assert.strictEqual(verdictOf('user-scalable=0').reads, 'which the browser reads as “no”');
  });
  const scales: Array<[string, string]> = [
    ['no', '0'],
    ['0.1', '0.1'],
    ['0.5', '0.5'],
    ['1', '1'],
    ['1.5', '1.5'],
    ['1.99', '1.99'],
    ['1.995', '2'],
  ];
  for (const [value, n] of scales) {
    test(`W3 prints ${n} for maximum-scale=${value}`, () => {
      assert.strictEqual(
        verdictOf(`maximum-scale=${value}`).reads,
        `which the browser reads as ${n}, below the 2 that 200% zoom needs`,
      );
    });
  }
  test('W4: 1.995 up to just under 2 prints as 2', () => {
    for (const value of ['1.995', '1.996', '1.999', '1.9999']) {
      assert.strictEqual(verdictOf(`maximum-scale=${value}`).reads, W3('2'));
    }
  });
  test('W5 full example', () => {
    assert.strictEqual(
      verdictOf('maximum-scale=infinity').why,
      'the value “infinity” in the viewport setting may be read as a number by some browsers and as a word by others',
    );
  });
  test('W6', () => {
    assert.strictEqual(
      verdictOf('minimum-scale=3, maximum-scale=1').why,
      'the viewport setting gives a minimum-scale above its maximum-scale, which holds the page at one scale',
    );
  });
  test('W7 with N as a plain integer', () => {
    const contents: string[] = ['user-scalable=no'];
    for (let index = 0; index < 11; index += 1) contents.push('width=1');
    assert.strictEqual(
      pageZoomVerdict(contents).why,
      'the page has 12 viewport settings that disagree about zoom; the browser uses the last one it processed',
    );
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Section 10: the example column of the differences table
// ---------------------------------------------------------------------------------------------------------------

describe('section 10: draft differences, examples', () => {
  test('D1 semicolon: maximum-scale=5;user-scalable=no is maximum 5, user-scalable never set, allowed', () => {
    const setting = parseViewport('maximum-scale=5;user-scalable=no');
    assertPartial(setting, { maxZoom: 5, userZoom: true, invalidSeparator: true });
    assert.strictEqual(setting.userScalableText, undefined);
    assert.deepStrictEqual(zoomVerdict(setting), ALLOWED);
  });
  test('D2 NUL: width=1\\0user-scalable=no is off', () => {
    assertPartial(verdictOf(`width=1${NUL}user-scalable=no`), { kind: 'off' });
  });
  test('D3 key with no value: user-scalable no, user-scalable, user-scalable= are off; maximum-scale = , is off (0.1)', () => {
    for (const content of ['user-scalable no', 'user-scalable', 'user-scalable=']) {
      assert.deepStrictEqual(verdictOf(content), off('user-scalable', '', W2));
    }
    assert.deepStrictEqual(verdictOf('maximum-scale = ,'), off('maximum-scale', '', W3('0.1')));
  });
  test('D4 empty pairs: width=device-width, has a trailing empty pair with no effect', () => {
    assert.deepStrictEqual(viewportPairs('width=device-width,').pairs, [['width', 'device-width'], ['', '']]);
    assert.deepStrictEqual(verdictOf('width=device-width,'), ALLOWED);
  });
  test('D5 end of a value: maximum-scale=1;x reads as 1 and keeps the ; in the recorded text', () => {
    const setting = parseViewport('maximum-scale=1;x');
    assert.strictEqual(setting.maxZoom, 1);
    assert.strictEqual(setting.maximumScaleText, '1;x');
    assert.deepStrictEqual(zoomVerdict(setting), off('maximum-scale', '1;x', W3('1')));
  });
  test('D6 numbers before words: maximum-scale=0x10 is 0.1 (off); maximum-scale=infinity is unknown', () => {
    assert.deepStrictEqual(verdictOf('maximum-scale=0x10'), off('maximum-scale', '0x10', W3('0.1')));
    assertPartial(verdictOf('maximum-scale=infinity'), { kind: 'unknown' });
  });
  test('D7 no for a scale: W3 prints 0; minimum-scale=0.1, maximum-scale=no is unknown (V2)', () => {
    assert.deepStrictEqual(verdictOf('maximum-scale=no'), off('maximum-scale', 'no', W3('0')));
    assert.deepStrictEqual(verdictOf('minimum-scale=0.1, maximum-scale=no'), unknown(W6));
  });
  test('D8 negative scale: maximum-scale=1, maximum-scale=-1 is allowed; the axe check fails it', () => {
    assert.deepStrictEqual(verdictOf('maximum-scale=1, maximum-scale=-1'), ALLOWED);
    assert.strictEqual(axeFailsViewport('maximum-scale=1, maximum-scale=-1'), true);
  });
  test('D9 minimum above maximum: minimum-scale=3, maximum-scale=1 is unknown', () => {
    assert.deepStrictEqual(verdictOf('minimum-scale=3, maximum-scale=1'), unknown(W6));
  });
  test('D10 minimum without maximum: minimum-scale=10 is allowed', () => {
    assert.deepStrictEqual(verdictOf('minimum-scale=10'), ALLOWED);
  });
  test('D11 and D17 several elements: user-scalable=no then width=device-width is unknown', () => {
    assert.deepStrictEqual(pageZoomVerdict(['user-scalable=no', 'width=device-width']), unknown(W7(2)));
  });
  test('D12 unknown keys: viewport-fit=cover is allowed', () => {
    assert.deepStrictEqual(verdictOf('viewport-fit=cover'), ALLOWED);
  });
  test('D13 case: USER-SCALABLE=NO is off (W1)', () => {
    assert.deepStrictEqual(verdictOf('USER-SCALABLE=NO'), off('user-scalable', 'no', W1));
  });
  test('D14 words after a space before =: user-scalable foo=no reads (user-scalable, no)', () => {
    assert.deepStrictEqual(viewportPairs('user-scalable foo=no').pairs, [['user-scalable', 'no']]);
  });
  test('D15 scale mapping: maximum-scale=25 is 10', () => {
    assert.strictEqual(parseViewport('maximum-scale=25').maxZoom, 10);
  });
  test('D16 user-scalable mapping: user-scalable=true is off', () => {
    assert.deepStrictEqual(verdictOf('user-scalable=true'), off('user-scalable', 'true', W2));
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Section 11.3: other corpora that reach the module
// ---------------------------------------------------------------------------------------------------------------

describe('section 11.3: other corpora', () => {
  const rows: Array<[string, Record<string, unknown>, boolean]> = [
    ['width=device-width, initial-scale=1', { kind: 'allowed' }, false],
    ['width=device-width,initial-scale=1', { kind: 'allowed' }, false],
    ['width=device-width, initial-scale=1, user-scalable=no', { kind: 'off' }, true],
    ['width=device-width, initial-scale=1, maximum-scale=1', { kind: 'off' }, true],
    ['width=device-width, initial-scale=1, maximum-scale=1.5', { kind: 'off' }, true],
    ['width=device-width, initial-scale=1, maximum-scale=2', { kind: 'allowed' }, false],
    ['width=device-width, initial-scale=1, maximum-scale=5', { kind: 'allowed' }, false],
    ['width=device-width, initial-scale=1, user-scalable=yes', { kind: 'allowed' }, false],
    [
      'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no',
      { kind: 'off', property: 'user-scalable' },
      true,
    ],
  ];
  for (const [content, verdict, axe] of rows) {
    test(`corpus ${show(content)}`, () => {
      assertPartial(verdictOf(content), verdict);
      assert.strictEqual(axeFailsViewport(content), axe);
      assert.deepStrictEqual(probeFindings([content]), []);
    });
  }
});

// ---------------------------------------------------------------------------------------------------------------
// Sections 2.2 to 2.4: interface shape
// ---------------------------------------------------------------------------------------------------------------

describe('sections 2.2 to 2.4: interface shape', () => {
  test('the pair reader returns exactly two own fields, pairs and invalidSeparator', () => {
    assert.deepStrictEqual(Object.keys(viewportPairs('width=1')).sort(), ['invalidSeparator', 'pairs']);
  });
  test('each pair is a two-element array of strings', () => {
    for (const pair of viewportPairs('a=b, c, =d,').pairs) {
      assert.ok(Array.isArray(pair));
      assert.equal(pair.length, 2);
      assert.equal(typeof pair[0], 'string');
      assert.equal(typeof pair[1], 'string');
    }
  });
  test('the number reader returns null, not undefined, when there is no number', () => {
    assert.strictEqual(numericPrefix('x'), null);
  });
  test('the no-limit marker on maxZoom is the string auto', () => {
    assert.strictEqual(parseViewport('').maxZoom, 'auto');
  });
  test('2.3 defaults: zoom allowed, no maximum, no minimum, no texts, not uncertain', () => {
    assert.deepStrictEqual(parseViewport(''), {
      userZoom: true,
      maxZoom: 'auto',
      minZoom: 'auto',
      invalidSeparator: false,
    });
  });
  test('2.4 shapes: allowed has only kind; off has property, value, reads; unknown has why', () => {
    assert.deepStrictEqual(Object.keys(verdictOf('')), ['kind']);
    assert.deepStrictEqual(Object.keys(verdictOf('user-scalable=no')).sort(), ['kind', 'property', 'reads', 'value']);
    assert.deepStrictEqual(Object.keys(verdictOf('maximum-scale=nan')).sort(), ['kind', 'why']);
    assert.deepStrictEqual(Object.keys(pageZoomVerdict(['a', 'user-scalable=no'])).sort(), ['kind', 'why']);
  });
  test('2.3 recorded texts: last user-scalable and maximum-scale value texts, as read', () => {
    assertPartial(parseViewport('User-Scalable=NO, maximum-scale=1, MAXIMUM-SCALE=Device-Width, user-scalable=Yes'), {
      userScalableText: 'yes',
      maximumScaleText: 'device-width',
      userZoom: true,
      maxZoom: 10,
    });
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Section 12 and the readings pinned in NOTES.md
// ---------------------------------------------------------------------------------------------------------------

describe('section 12: no length limit', () => {
  test('a content of 20000 pairs is read in full; the last pair wins', () => {
    const parts: string[] = [];
    for (let index = 0; index < 20000; index += 1) parts.push(index % 2 === 0 ? 'user-scalable=no' : 'width=1');
    parts.push('maximum-scale=1.5');
    assert.equal(viewportPairs(parts.join(', ')).pairs.length, 20001);
    assert.deepStrictEqual(verdictOf(parts.join(', ')), off('user-scalable', 'no', W1));
  });
  test('X1: an astral character can be cut in half by the 40-unit limit', () => {
    const value = `nan${'x'.repeat(36)}😀`;
    const why = verdictOf(`maximum-scale=${value}`).why ?? '';
    assert.strictEqual(why, W5(value.slice(0, 40)));
    assert.strictEqual(value.slice(0, 40).charCodeAt(39), 0xd83d);
  });
});

describe('pinned readings (each one is listed in NOTES.md)', () => {
  test('R1 axe A5: -0 is not negative, so maximum-scale=-0 is stored and fails (-0 is below 2)', () => {
    assert.strictEqual(axeFailsViewport('maximum-scale=-0'), true);
    assert.strictEqual(axeFailsViewport('maximum-scale=-0.0e5'), true);
    assert.strictEqual(axeFailsViewport('maximum-scale=5, maximum-scale=-0'), true);
  });
  test('R2 S5 and U4: any infinity from the number reader is uncertain, also a long digit run without exponent', () => {
    const digits = '9'.repeat(400);
    assert.strictEqual(numericPrefix(digits), Infinity);
    assert.deepStrictEqual(verdictOf(`maximum-scale=${digits}`), unknown(W5(digits.slice(0, 40))));
    assert.deepStrictEqual(verdictOf(`user-scalable=${digits}`), unknown(W5(digits.slice(0, 40))));
    assert.deepStrictEqual(verdictOf(`minimum-scale=-${digits}`), unknown(W5(`-${digits}`.slice(0, 40))));
  });
  test('R3 X1 and S8: an uncertain minimum-scale value is named in the note; its text is not recorded otherwise', () => {
    const setting = parseViewport('minimum-scale=nan');
    assert.strictEqual(setting.minZoom, 'auto');
    assert.deepStrictEqual(zoomVerdict(setting), unknown(W5('nan')));
    assert.deepStrictEqual(verdictOf('maximum-scale=infinity, minimum-scale=nano'), unknown(W5('nano')));
    assert.strictEqual(setting.maximumScaleText, undefined);
    assert.strictEqual(setting.userScalableText, undefined);
  });
  test('R4 W3 rounds the floating-point product: 1.045 prints 1.05 and 0.105 prints 0.11 (toFixed would print 1.04, 0.1)', () => {
    assert.strictEqual(verdictOf('maximum-scale=1.045').reads, W3('1.05'));
    assert.strictEqual(verdictOf('maximum-scale=0.105').reads, W3('0.11'));
  });
  test('R5 X1: the note shows the value as read after T1 (ASCII lower-cased)', () => {
    assert.deepStrictEqual(verdictOf('MAXIMUM-SCALE=INFINITY'), unknown(W5('infinity')));
    assert.deepStrictEqual(verdictOf('user-scalable=NaN'), unknown(W5('nan')));
    assert.deepStrictEqual(verdictOf('maximum-scale=İNF'), off('maximum-scale', 'İnf', W3('0.1')));
  });
  test('R6 T7: a NUL after a key is passed over like any character while looking for = (only = and , stop)', () => {
    assert.deepStrictEqual(viewportPairs(`a${NUL}b`).pairs, [['a', '']]);
    assert.deepStrictEqual(viewportPairs(`user-scalable${NUL}foo=no`).pairs, [['user-scalable', 'no']]);
    assert.deepStrictEqual(viewportPairs(`user-scalable${NUL}no`).pairs, [['user-scalable', '']]);
  });
  test('R7 T8: after =, NUL and line breaks are passed over like spaces', () => {
    assert.deepStrictEqual(viewportPairs(`user-scalable=${NUL}\r\n=no`).pairs, [['user-scalable', 'no']]);
  });
  test('R8 free setting fields are absent (not undefined) when the key never appears', () => {
    const setting = parseViewport('width=device-width, initial-scale=1');
    assert.deepStrictEqual(Object.keys(setting).sort(), ['invalidSeparator', 'maxZoom', 'minZoom', 'userZoom']);
  });
  test('R9 S2: maximum-scale=no is positive zero', () => {
    assert.ok(Object.is(parseViewport('maximum-scale=no').maxZoom, 0));
    assert.ok(Object.is(parseViewport('minimum-scale=no').minZoom, 0));
  });
  test('R10 S4 and U3 allow one sign only: ++inf and +-nan are ordinary words (0.1, zoom off)', () => {
    assert.deepStrictEqual(verdictOf('maximum-scale=++inf'), off('maximum-scale', '++inf', W3('0.1')));
    assert.deepStrictEqual(verdictOf('user-scalable=+-nan'), off('user-scalable', '+-nan', W2));
  });
  test('R11 A3: text after a second = is ignored in the axe check', () => {
    assert.strictEqual(axeFailsViewport('maximum-scale=1=5'), true);
    assert.strictEqual(axeFailsViewport('user-scalable=yes=no'), false);
  });
  test('R12 P3: the page result is the last verdict, complete, when kinds agree but details differ', () => {
    assert.deepStrictEqual(
      pageZoomVerdict(['user-scalable=no', 'maximum-scale=1.5', 'user-scalable=0']),
      off('user-scalable', '0', W2),
    );
  });
  test('R13 V2 needs both limits as numbers: a negative minimum is no limit, an uncertain maximum is V1', () => {
    assert.deepStrictEqual(verdictOf('minimum-scale=-5, maximum-scale=0.5'), off('maximum-scale', '0.5', W3('0.5')));
    assert.deepStrictEqual(verdictOf('minimum-scale=3, maximum-scale=nan'), unknown(W5('nan')));
    assert.deepStrictEqual(verdictOf('minimum-scale=3'), ALLOWED);
  });
});
