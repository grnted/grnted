// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 19, first-run correctness: a bare domain ("example.org") is a site address; https:// is assumed.
import { describe, expect, it } from 'vitest';
import { normalizeUrl, withScheme } from '../../src/url.js';

describe('withScheme', () => {
  it('puts https:// in front of a bare domain, with or without a path, port or query', () => {
    expect(withScheme('example.org')).toBe('https://example.org');
    expect(withScheme('www.example.k12.or.us/news')).toBe('https://www.example.k12.or.us/news');
    expect(withScheme('  example.org?x=1 ')).toBe('https://example.org?x=1');
    expect(withScheme('localhost:8080/a')).toBe('https://localhost:8080/a');
    expect(normalizeUrl(withScheme('example.org'))).toBe('https://example.org/');
  });
  it('leaves an address with a scheme, and anything that is no host name, as it was', () => {
    expect(withScheme('http://example.org/')).toBe('http://example.org/');
    expect(withScheme('https://example.org')).toBe('https://example.org');
    expect(withScheme('not-a-url')).toBe('not-a-url');
    expect(withScheme('report.json')).toBe('report.json');
    expect(normalizeUrl(withScheme('not-a-url'))).toBeNull();
  });
});
