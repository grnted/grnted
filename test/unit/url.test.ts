// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { isDocumentUrl, isLikelyHtml, normalizeUrl, sameSite, urlKey } from '../../src/url.js';

describe('normalizeUrl', () => {
  it('drops hash, tracking params and trailing slash, and sorts params', () => {
    expect(normalizeUrl('https://Example.org/a/b/?utm_source=x&z=1&a=2#top')).toBe('https://example.org/a/b?a=2&z=1');
  });
  it('keeps the root slash', () => {
    expect(normalizeUrl('https://example.org')).toBe('https://example.org/');
  });
  it('resolves relative URLs against a base', () => {
    expect(normalizeUrl('../x', 'https://example.org/a/b')).toBe('https://example.org/x');
  });
  it('strips credentials', () => {
    expect(normalizeUrl('https://u:p@example.org/')).toBe('https://example.org/');
  });
  it('rejects non-http schemes and junk', () => {
    expect(normalizeUrl('mailto:a@b.org')).toBeNull();
    expect(normalizeUrl('javascript:alert(1)')).toBeNull();
    expect(normalizeUrl('not a url')).toBeNull();
  });
});

describe('urlKey and sameSite', () => {
  it('treats www and scheme as the same page', () => {
    expect(urlKey('http://www.example.org/a')).toBe(urlKey('https://example.org/a'));
  });
  it('compares hosts ignoring www', () => {
    expect(sameSite('https://www.example.org/x', 'https://example.org/')).toBe(true);
    expect(sameSite('https://other.org/', 'https://example.org/')).toBe(false);
    expect(sameSite('https://sub.example.org/', 'https://example.org/')).toBe(false);
  });
});

describe('file type helpers', () => {
  it('spots documents', () => {
    expect(isDocumentUrl('https://e.org/board/packet.PDF')).toBe(true);
    expect(isDocumentUrl('https://e.org/menu.docx?v=2')).toBe(true);
    expect(isDocumentUrl('https://e.org/about')).toBe(false);
  });
  it('skips assets that are not pages', () => {
    expect(isLikelyHtml('https://e.org/logo.png')).toBe(false);
    expect(isLikelyHtml('https://e.org/feed.xml')).toBe(false);
    expect(isLikelyHtml('https://e.org/about')).toBe(true);
    expect(isLikelyHtml('https://e.org/index.html')).toBe(true);
  });
});
