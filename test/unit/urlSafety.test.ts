// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { checkTargetUrl, isPublicIp } from '../../src/urlSafety.js';

describe('checkTargetUrl', () => {
  it.each([
    'https://example.org/',
    'http://www.district.k12.or.us/schools',
    'https://city.gov/a?b=c',
  ])('accepts %s', (url) => {
    expect(checkTargetUrl(url).ok).toBe(true);
  });

  it.each([
    ['ftp://example.org/', 'scheme'],
    ['file:///etc/passwd', 'scheme'],
    ['https://user:pw@example.org/', 'credentials'],
    ['https://example.org:8443/', 'port'],
    ['http://127.0.0.1/', 'IP'],
    ['http://2130706433/', 'IP'], // decimal form of 127.0.0.1; the URL parser canonicalizes it
    ['http://0x7f.1/', 'IP'],
    ['http://127.1/', 'IP'],
    ['http://[::1]/', 'IP'],
    ['http://[::ffff:10.0.0.1]/', 'IP'],
    ['http://[::ffff:169.254.169.254]/latest/meta-data', 'IP'], // IPv4-mapped literal: any ':' in the host
    ['http://[64:ff9b::a9fe:a9fe]/', 'IP'],
    ['http://localhost/', 'host'],
    ['http://intranet/', 'host'],
    ['http://printer.local/', 'host'],
    ['http://db.internal/', 'host'],
    ['http://nas.lan/', 'host'],
    ['http://foo.localhost/', 'host'],
    ['not a url', 'parse'],
  ])('rejects %s (%s)', (url) => {
    expect(checkTargetUrl(url).ok).toBe(false);
  });
});

describe('isPublicIp', () => {
  it.each(['8.8.8.8', '1.1.1.1', '151.101.1.69', '2606:4700:4700::1111', '2001:4860:4860::8888'])(
    'public: %s',
    (ip) => expect(isPublicIp(ip)).toBe(true),
  );
  it.each([
    '0.0.0.0', '10.1.2.3', '100.64.0.1', '127.0.0.1', '169.254.169.254', '172.16.0.1', '172.31.255.255',
    '192.168.1.1', '192.0.2.5', '198.18.0.1', '198.51.100.7', '203.0.113.9', '224.0.0.1', '255.255.255.255',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'ff02::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:7f00:1', '64:ff9b::a00:1', '100::1', '::10.0.0.1',
    'garbage', '999.1.1.1',
  ])('not public: %s', (ip) => expect(isPublicIp(ip)).toBe(false));
});
