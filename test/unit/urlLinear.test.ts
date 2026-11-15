// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { normalizeUrl } from '../../src/url.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { corpus } from '../helpers/fuzz.js';

// normalizeUrl as of 82b90661, kept only as the oracle.
const OLD_TRACKING = /^(utm_.*|fbclid|gclid|msclkid|mc_cid|mc_eid|_hsenc|_hsmi)$/i;
function oldNormalizeUrl(input: string, base?: string): string | null {
  let u: URL;
  try {
    u = new URL(input, base);
  } catch {
    return null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  u.username = '';
  u.password = '';
  for (const key of [...u.searchParams.keys()]) if (OLD_TRACKING.test(key)) u.searchParams.delete(key);
  u.searchParams.sort();
  if (u.pathname.length > 1 && u.pathname.endsWith('/')) u.pathname = u.pathname.replace(/\/+$/, '');
  return u.href;
}

const STARTS = ['https://e.org', 'http://user:pw@E.org:8080', 'HTTPS://www.e.org', 'mailto:a@e.org', 'ftp://e.org', '/rel', '', 'https://[::1]', 'https://e.org/%2F'];
const TOKENS = [
  '/', '//', 'a', 'é', '%20', '%2f', ' ', '?', '&', '=', '#', '#frag', 'utm_source=x', 'UTM_Medium=y', 'utm_=', 'fbclid=1', 'gclid', 'b=2',
  'a=1', 'a=0', 'z', '+', '%26', '&amp;', 'utm_x%0A=1', '.', '..', '\\', ';', 'mc_cid=3', 'x=%E2%80%A8',
];

describe('normalizeUrl gives the same address as before', () => {
  it('30,000 random addresses', () => {
    let kept = 0;
    let i = 0;
    for (const tail of corpus(TOKENS, 30_000, 12, 0x0e1)) {
      const input = STARTS[i++ % STARTS.length] + tail;
      const want = oldNormalizeUrl(input, 'https://e.org/base/');
      expect(normalizeUrl(input, 'https://e.org/base/'), JSON.stringify(input)).toBe(want);
      if (want) kept++;
    }
    expect(kept).toBeGreaterThan(12_000);
  });
});

describe('hostile addresses cost linear time', () => {
  it('a long run of slashes scales linearly', () => {
    expectLinear((n) => {
      const url = 'https://e.org/' + '/'.repeat(n) + 'a/';
      return () => normalizeUrl(url);
    }, 3000);
  });
  it('thousands of tracking parameters scale linearly', () => {
    expectLinear((n) => {
      const url = 'https://e.org/?' + Array.from({ length: n }, (_, i) => `utm_${i}=1`).join('&');
      return () => normalizeUrl(url);
    }, 1000);
  });
  it('a 4 MB sitemap address is normalised in well under a second', () => {
    const slashes = 'https://e.org/' + '/'.repeat(4_000_000) + 'a/';
    expect(msOnce(() => normalizeUrl(slashes), 1)).toBeLessThan(1000);
    const utm = 'https://e.org/?' + Array.from({ length: 300_000 }, (_, i) => `utm_${i}=1`).join('&');
    expect(msOnce(() => normalizeUrl(utm), 1)).toBeLessThan(1500);
  }, 30_000);
});
