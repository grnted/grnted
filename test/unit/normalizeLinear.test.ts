// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { assetRefs, cssImports, isThinHtml, normalizeHtml, staticCounts } from '../../src/incremental/normalize.js';
import * as old from '../helpers/oracle/normalize82b9.js';
import { MAX_BODY_BYTES } from '../../src/crawl.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { corpus } from '../helpers/fuzz.js';

const PAGE = 'https://e.org/a/b';
const SITE = 'https://e.org/';
const fns = {
  normalizeHtml: [(h: string) => normalizeHtml(h, PAGE), (h: string) => old.normalizeHtml(h, PAGE)],
  isThinHtml: [isThinHtml, old.isThinHtml],
  staticCounts: [staticCounts, old.staticCounts],
  assetRefs: [(h: string) => assetRefs(h, PAGE, SITE), (h: string) => old.assetRefs(h, PAGE, SITE)],
} as const;

const HTML_TOKENS = [
  '<!--', '-->', '<!-->', '<!-- c -->', '<script>', '</script>', '<SCRIPT type=x>', '</Script>', '<scripts>', '<script', '<style>', '</style>',
  '</STYLE>', '<noscript>', '</noscript>', '<template>', '</template>', '<svg>', '</svg>', '<svg', '<body>', '<BODY class=a>', '</body>',
  '</BODY>', '<bodyx>', '<body', '<input type=hidden name=csrf value=abc>', '<input type="hidden" name="_token" value="x">', '<input',
  '<meta name="csrf-token" content="zz">', '<meta property="session" content=1>', '<meta', '<a href="/x?utm_source=a&amp;b=1#h">',
  '<img srcset="a.png?v=1 1x, b.png 2x">', '<link rel=stylesheet href="/s.css?v=3">', '<link rel="preload" as="script" href=/a.js>',
  '<script src="/m.js?ts=1">', '<base href="/sub/">', '<time datetime="2026-01-02T03:04:05Z">', '2026-01-02T03:04', ' nonce="abc"',
  ' data-time=123', 'text', ' ', '\n', '<', '>', '&amp;', '&nbsp;', '<a', '<div>', '</div>', 'Some visible text that people read here. ',
];
const CSS_TOKENS = [
  '/*', '*/', '/**/', '@import "a.css";', '@import url(b.css);', '@import url( "c.css" );', "@IMPORT 'd.css';", '@import url(https://other.org/x.css);',
  '@import url(//e.org/y.css)', ' ', 'a{}', '"', "'", ')', '@import', 'url(',
];
const REAL = [
  `<!doctype html><html><head><meta name="csrf-token" content="abc"><link rel="stylesheet" href="/css/site.css?v=12">
   <script src="/js/app.js?ts=99" nonce="n1"></script><!-- build 2026-11-05T10:00:00Z --></head>
   <body class="home"><h1>Welcome</h1><p>Visible text that stays the same between scans, long enough to count.</p>
   <form><input type="hidden" name="authenticity_token" value="q"><input name="q"></form>
   <img src="/a.png?utm_source=x" srcset="/a.png?v=2 1x, /a@2x.png 2x"><svg><text>icon</text></svg>
   <time datetime="2026-11-05T10:00">Nov 5</time><noscript>Turn on JS</noscript></body></html>`,
  '<html><body><div id="app"></div><script>window.x=1</script></body></html>',
  '',
];

describe('monitoring normalisation reads every page as before', () => {
  it('real-looking pages', () => {
    for (const h of REAL) for (const [name, [now, was]] of Object.entries(fns)) expect(now(h), `${name} ${h}`).toEqual(was(h));
  });
  it('30,000 random pages: same normalised HTML, thin answer, counts and asset refs', () => {
    for (const h of corpus(HTML_TOKENS, 30_000, 20, 0xa11)) {
      for (const [name, [now, was]] of Object.entries(fns)) expect(now(h), `${name} ${JSON.stringify(h)}`).toEqual(was(h));
    }
  });
  it('20,000 random stylesheets: same @import targets', () => {
    let found = 0;
    for (const css of corpus(CSS_TOKENS, 20_000, 12, 0xc55)) {
      const want = old.cssImports(css, 'https://e.org/css/a.css', SITE);
      expect(cssImports(css, 'https://e.org/css/a.css', SITE), JSON.stringify(css)).toEqual(want);
      found += want.length;
    }
    expect(found).toBeGreaterThan(5000);
  });
});

const HOSTILE = ['<!--', '<script', '<script>', '<style>', '<svg>', '<noscript>', '<a', '<input', '<meta', '<', '<body', '<body>', '<link', '<a 2026-01-01T00:00'];

describe('hostile pages cost linear time', () => {
  // The old lazy and open-ended regexes rescanned from every unclosed opener: 16x per 4x here.
  for (const shape of HOSTILE) {
    it(`${JSON.stringify(shape)} repeated scales linearly in every pass`, () => {
      for (const [name, [now]] of Object.entries(fns)) {
        void name;
        expectLinear((n) => {
          const h = shape.repeat(n);
          return () => now(h);
        }, 3000);
      }
    });
  }
  it('unclosed CSS comments scale linearly in cssImports', () => {
    expectLinear((n) => {
      const css = '/* '.repeat(n);
      return () => cssImports(css, 'https://e.org/a.css', SITE);
    }, 3000);
  });
  it('5 MiB hostile pages are read in well under a second per pass', () => {
    for (const shape of HOSTILE) {
      const h = shape.repeat(Math.floor(MAX_BODY_BYTES / shape.length));
      for (const [name, [now]] of Object.entries(fns)) expect(msOnce(() => now(h), 1), `${name} ${shape}`).toBeLessThan(1500);
    }
    const css = '/* '.repeat(MAX_BODY_BYTES / 3);
    expect(msOnce(() => cssImports(css, 'https://e.org/a.css', SITE), 1)).toBeLessThan(1000);
  }, 120_000);
});
