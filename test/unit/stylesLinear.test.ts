// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { onlyDeclaresFonts, stripCssComments } from '../../src/styles.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { corpus } from '../helpers/fuzz.js';

// onlyDeclaresFonts as of 82b90661, kept only as the oracle.
const oldStrip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '');
const oldOnlyFonts = (css: string) =>
  oldStrip(css).replace(/@charset\s+(?:"[^"]*"|'[^']*')\s*;/gi, '').replace(/@font-face\s*\{[^{}]*\}/gi, '').trim() === '';

const TOKENS = [
  '/*', '*/', '/', '*', '/**/', '/*/', '*/*', ' ', '\n', 'a{color:red}', '@font-face{font-family:A;src:url(a)}', '@FONT-FACE {', '}', '{',
  '@charset "utf-8";', "@charset 'x' ;", '@charset', '"', "'", ';', 'x', '@media screen{', ' ',
];

describe('stylesheet comments are stripped as before', () => {
  it('40,000 random sheets: same text without comments, same fonts-only answer', () => {
    let fontsOnly = 0;
    for (const css of corpus(TOKENS, 40_000, 16, 0xc55)) {
      expect(stripCssComments(css), JSON.stringify(css)).toBe(oldStrip(css));
      const want = oldOnlyFonts(css);
      expect(onlyDeclaresFonts(css), JSON.stringify(css)).toBe(want);
      if (want) fontsOnly++;
    }
    expect(fontsOnly).toBeGreaterThan(1000);
  });
  it('real-looking sheets', () => {
    const sheets = [
      '/*! Typekit */\n@font-face{font-family:"tk";src:url(a.woff2)}\n/* end */',
      '@charset "UTF-8";\n/* fonts */\n@font-face { font-family: X; src: url(x) }',
      '/* a */ .btn { color: red } /* b */',
      '.a{}/* unclosed',
      '',
    ];
    for (const css of sheets) expect(onlyDeclaresFonts(css), css).toBe(oldOnlyFonts(css));
  });
});

describe('hostile stylesheets cost linear time', () => {
  it('unclosed /* comments scale linearly', () => {
    expectLinear((n) => () => onlyDeclaresFonts('/* '.repeat(n)), 4000);
  });
  it('a 2,000,000-character sheet of unclosed /* is read in well under a second', () => {
    const css = '/* '.repeat(666_666);
    expect(msOnce(() => onlyDeclaresFonts(css), 1)).toBeLessThan(1000);
    expect(onlyDeclaresFonts(css)).toBe(false);
  });
});
