// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v2 snippets (spec §4.1): code changes built from what the scan saw. Pure, plain text (the
// renderer escapes), and robust to hostile or broken HTML from the page.
import { describe, expect, it } from 'vitest';
import { copyForCriterion, copyForRule } from '../../src/report/copy/index.js';
import { elementSignature, parseStartTag } from '../../src/report/startTag.js';
import type { Snippet, SnippetInput } from '../../src/report/model.js';

const snip = (rule: string, ex: SnippetInput): Snippet | null => copyForRule(rule).snippet?.(ex) ?? null;
const crit = (c: string, ex: SnippetInput): Snippet | null => copyForCriterion(c).snippet?.(ex) ?? null;

describe('parseStartTag', () => {
  it('reads the tag name and attributes, quotes and > inside values included', () => {
    const t = parseStartTag('<a href="/x?a=1&b=>2" aria-label=\'Go > now\' data-x=1 hidden>Read more</a>')!;
    expect(t.name).toBe('a');
    expect(t.raw).toBe('<a href="/x?a=1&b=>2" aria-label=\'Go > now\' data-x=1 hidden>');
    expect(t.attrs.map((a) => a.name)).toEqual(['href', 'aria-label', 'data-x', 'hidden']);
    expect(t.rest).toBe('Read more</a>');
  });
  it('returns null for broken or non-element input', () => {
    for (const bad of ['', 'text', '<', '<a href="x', '<a href=\'x>y', '<1a>', '</a>', '<!-- x -->', '< a>', '<a\u0000>'.slice(0, 2)]) {
      expect(parseStartTag(bad), JSON.stringify(bad)).toBeNull();
    }
  });
  it('reads only the first 300 characters, as axe keeps them', () => {
    expect(parseStartTag(`<a title="${'x'.repeat(400)}">t</a>`)).toBeNull();
    expect(parseStartTag(`<a>${'x'.repeat(100000)}`)!.rest.length).toBeLessThanOrEqual(297);
  });
  it('tolerates leading whitespace and uppercase', () => {
    expect(parseStartTag('  \n<IMG SRC="a.png">')!.name).toBe('img');
  });
});

describe('elementSignature', () => {
  it('drops ids, data-*, framework scope attributes and numeric class suffixes', () => {
    const a = elementSignature('<a id="nav-12" class="menu-link-3 btn  css-1x2y3z" data-astro-cid-abc123 data-v-7f href="/about"  astro-cid-q1w2e3>About</a>');
    const b = elementSignature('<a class="btn menu-link-9" href="/about" id="nav-40" data-index="2">About us</a>');
    expect(a).toBe(b);
    expect(a).toBe('<a class="btn menu-link" href="/about">');
  });
  it('differs for different elements, and is empty for unparseable HTML', () => {
    expect(elementSignature('<a href="/a">')).not.toBe(elementSignature('<a href="/b">'));
    expect(elementSignature('<a href="/a')).toBe('');
    expect(elementSignature('')).toBe('');
  });
  it('stays short for huge attribute values', () => {
    expect(elementSignature(`<a href="${'x'.repeat(250)}">`).length).toBeLessThanOrEqual(200);
  });
});

describe('label-content-name-mismatch snippet', () => {
  it('removes aria-label from the start tag when the element shows text', () => {
    const s = snip('label-content-name-mismatch', { html: '<a class="card" aria-label="Visit Lincoln Elementary School" href="/lincoln">Lincoln</a>' });
    expect(s).toEqual({ kind: 'change', language: 'html',
      before: ['<a class="card" aria-label="Visit Lincoln Elementary School" href="/lincoln">'],
      after: ['<a class="card" href="/lincoln">'] });
  });
  it('keeps hostile attribute values as plain text, and removes only aria-label', () => {
    const html = '<a href="javascript:alert(1)" aria-label=\'"><script>alert(1)</script>\' data-aria-label="keep" onclick="x()">Go <b>now</b></a>';
    const s = snip('label-content-name-mismatch', { html })!;
    expect(s.before).toEqual(['<a href="javascript:alert(1)" aria-label=\'"><script>alert(1)</script>\' data-aria-label="keep" onclick="x()">']);
    expect(s.after).toEqual(['<a href="javascript:alert(1)" data-aria-label="keep" onclick="x()">']);
  });
  it('handles unquoted and uppercase aria-label', () => {
    expect(snip('label-content-name-mismatch', { html: '<BUTTON ARIA-LABEL=Close>X close</BUTTON>' })!.after).toEqual(['<BUTTON>']);
  });
  it('gives nothing without visible text, without aria-label, or for broken HTML', () => {
    for (const html of [
      '<a aria-label="Home" href="/"><img src="logo.png"></a>',
      '<a aria-label="Home" href="/">   </a>',
      '<a aria-label="Home" href="/">',
      '<a aria-labelledby="x" href="/">Home</a>',
      '<a aria-label="Home" href="/>Home</a>',
      '<a aria-label="Home" href="/"><!-- Home --></a>',
      '',
      'Home',
    ]) expect(snip('label-content-name-mismatch', { html }), html).toBeNull();
    expect(snip('label-content-name-mismatch', {})).toBeNull();
  });
});

describe('criterion snippets', () => {
  it('2.4.11: scroll padding from the measured cover height', () => {
    expect(crit('2.4.11', { data: { coverHeight: 87.2 } })).toEqual({ kind: 'change', language: 'css', before: [], after: ['html { scroll-padding-top: 100px; }'] });
    expect(crit('2.4.11', { data: { coverHeight: 1 } })!.after).toEqual(['html { scroll-padding-top: 13px; }']);
    expect(crit('2.4.11', { data: { coverHeight: 400 } })!.after).toEqual(['html { scroll-padding-top: 412px; }']);
  });
  it('2.4.11: nothing without a sane measurement', () => {
    for (const data of [undefined, {}, { coverHeight: 0 }, { coverHeight: 0.5 }, { coverHeight: 401 }, { coverHeight: -5 }, { coverHeight: NaN },
      { coverHeight: Infinity }, { coverHeight: '80' }, { coverHeight: null }, { coverHeight: { valueOf: () => 80 } }]) {
      expect(crit('2.4.11', { data: data as Record<string, unknown> | undefined }), JSON.stringify(data)).toBeNull();
    }
    expect(crit('2.4.11', { data: 'oops' as unknown as Record<string, unknown> })).toBeNull();
    expect(crit('2.4.11', { data: [80] as unknown as Record<string, unknown> })).toBeNull();
  });
  it('1.4.4: an example clamp()', () => {
    expect(crit('1.4.4', {})).toEqual({ kind: 'example', language: 'css', before: ['font-size: 8vw;'], after: ['font-size: clamp(2.5rem, 1.5rem + 5vw, 7rem);'] });
  });
});

describe('example snippets', () => {
  it('html-has-lang and html-lang-valid', () => {
    for (const rule of ['html-has-lang', 'html-lang-valid']) {
      expect(snip(rule, { html: '<html class="x">' })).toEqual({ kind: 'example', language: 'html', before: [], after: ['<html lang="en">'] });
    }
  });
  it('image-alt, link-name and button-name use only the element tag name', () => {
    expect(snip('image-alt', { html: '<img src="/secret?token=abc" onerror="alert(1)">' })).toEqual(
      { kind: 'example', language: 'html', before: [], after: ['<img src="…" alt="[what the image shows]">'] });
    expect(snip('link-name', { html: '<a href="/x" class="icon"><svg></svg></a>' })!.after).toEqual(['<a href="…">[where the link goes]</a>']);
    expect(snip('button-name', { html: '<button class="x" onclick="y()"><i></i></button>' })!.after).toEqual(['<button aria-label="[what it does]">']);
  });
  it('other tags keep their own name, and hostile or missing HTML gives the usual tag', () => {
    expect(snip('link-name', { html: '<div role="link" tabindex="0"></div>' })!.after).toEqual(['<div aria-label="[where the link goes]">']);
    expect(snip('button-name', { html: '<my-btn role="button"></my-btn>' })!.after).toEqual(['<my-btn aria-label="[what it does]">']);
    expect(snip('image-alt', {})!.after).toEqual(['<img src="…" alt="[what the image shows]">']);
    expect(snip('link-name', { html: '<a"><script>alert(1)</script>' })!.after).toEqual(['<a href="…">[where the link goes]</a>']);
    expect(snip('button-name', { html: `<${'b'.repeat(500)}>` })!.after).toEqual(['<button aria-label="[what it does]">']);
  });
  it('snippet lines never carry page HTML for example kinds', () => {
    const s = snip('image-alt', { html: '<img src="x" alt=\'"><script>alert(1)</script>\'>' })!;
    expect(JSON.stringify(s)).not.toContain('script');
  });
  it('rules without a snippet builder give none', () => {
    expect(copyForRule('color-contrast').snippet).toBeUndefined();
  });
});
