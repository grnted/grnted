// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { MAX_RULE_LENGTH, parseRobots } from '../../src/robots.js';

const TXT = `
# comment
User-agent: *
Disallow: /private
Allow: /private/ok
Disallow: /*.php$

User-agent: badbot
Disallow: /

Sitemap: https://example.org/sitemap.xml
Sitemap: https://example.org/news-sitemap.xml
`;

describe('parseRobots', () => {
  const robots = parseRobots(TXT, 'grnted');
  it('applies the * group to us', () => {
    expect(robots.isAllowed('/')).toBe(true);
    expect(robots.isAllowed('/private/thing')).toBe(false);
  });
  it('longest match wins, and allow wins ties', () => {
    expect(robots.isAllowed('/private/ok/page')).toBe(true);
  });
  it('supports * and $', () => {
    expect(robots.isAllowed('/index.php')).toBe(false);
    expect(robots.isAllowed('/index.php?x=1')).toBe(true);
  });
  it('uses a group naming our agent over *', () => {
    const r = parseRobots('User-agent: grnted\nDisallow: /a\n\nUser-agent: *\nDisallow: /', 'grnted');
    expect(r.isAllowed('/b')).toBe(true);
    expect(r.isAllowed('/a')).toBe(false);
  });
  it('lists sitemaps', () => {
    expect(robots.sitemaps).toEqual(['https://example.org/sitemap.xml', 'https://example.org/news-sitemap.xml']);
  });
  it('allows everything for an empty or missing file', () => {
    expect(parseRobots('', 'grnted').isAllowed('/anything')).toBe(true);
  });
  it('treats an empty Disallow as allow-all', () => {
    expect(parseRobots('User-agent: *\nDisallow:', 'grnted').isAllowed('/x')).toBe(true);
  });
});

// Staging 2026-11-03 (trademe.co.nz): a 345 KB robots.txt with `Disallow: /a/****…k97.cc` (about 140 `*`
// in a row). Compiled to a RegExp (`.*` per star) it backtracks without end on any /a/… address: the
// scan's Durable Object spun until the platform reset it. Matching is linear in the path, whatever the rule.
describe('robots.txt wildcards never backtrack', () => {
  it('the trademe rule (140 stars) on many /a/… addresses: the right answer, in well under 50 ms', () => {
    const r = parseRobots(`User-agent: *\nDisallow: /a/${'*'.repeat(140)}k97.cc\nDisallow: /a/${'*'.repeat(8)}k97.cc$`, 'grnted');
    const paths = ['/a/', '/a/property/residential/sale/auckland/listing/4812', `/a/${'x'.repeat(2000)}`, '/a/marketplace/x?y=1', '/b/k97.cc'];
    const t = performance.now();
    for (let i = 0; i < 20; i++) for (const p of paths) expect(r.isAllowed(p), p).toBe(true);
    expect(r.isAllowed('/a/k97.cc')).toBe(false);
    expect(r.isAllowed('/a/x/y/zk97.cc')).toBe(false);
    expect(r.isAllowed('/a/x/y/zk97.cc?more')).toBe(false); // the unanchored rule
    expect(performance.now() - t).toBeLessThan(50);
  });

  it('RFC 9309 examples: * at the start, middle and end, and $', () => {
    const fish = parseRobots('User-agent: *\nDisallow: /fish*', 'grnted');
    for (const p of ['/fish', '/fish.html', '/fish/salmon.html', '/fishheads', '/fishheads/yummy.html', '/fish.php?id=anything']) expect(fish.isAllowed(p), p).toBe(false);
    for (const p of ['/Fish.asp', '/catfish', '/?id=fish', '/desert/fish']) expect(fish.isAllowed(p), p).toBe(true);
    const php = parseRobots('User-agent: *\nDisallow: /*.php$', 'grnted');
    for (const p of ['/filename.php', '/folder/filename.php']) expect(php.isAllowed(p), p).toBe(false);
    for (const p of ['/filename.php?parameters', '/filename.php/', '/filename.php5', '/windows.PHP']) expect(php.isAllowed(p), p).toBe(true);
    const mid = parseRobots('User-agent: *\nDisallow: /fish*.php', 'grnted');
    for (const p of ['/fish.php', '/fishheads/catfish.php?parameters']) expect(mid.isAllowed(p), p).toBe(false);
    expect(mid.isAllowed('/Fish.PHP')).toBe(true);
    const lead = parseRobots('User-agent: *\nDisallow: *private', 'grnted');
    expect(lead.isAllowed('/a/private/b')).toBe(false);
    expect(lead.isAllowed('/a/public')).toBe(true);
    // A path that is exactly the rule's anchored end.
    expect(parseRobots('User-agent: *\nDisallow: /exact$', 'grnted').isAllowed('/exact')).toBe(false);
    expect(parseRobots('User-agent: *\nDisallow: /exact$', 'grnted').isAllowed('/exactly')).toBe(true);
  });

  it('a rule longer than 2 KB is ignored (bounded cost per address)', () => {
    const r = parseRobots(`User-agent: *\nDisallow: /${'x'.repeat(MAX_RULE_LENGTH)}\nDisallow: /short`, 'grnted');
    expect(r.isAllowed(`/${'x'.repeat(MAX_RULE_LENGTH)}`)).toBe(true);
    expect(r.isAllowed('/short/1')).toBe(false);
  });

  it('still means what RFC 9309 says: * is any run of characters, $ ends the path, the longest rule wins', () => {
    const r = parseRobots('User-agent: *\nDisallow: /*.pdf$\nDisallow: /search/*/page\nAllow: /search/*/page/1$\nDisallow: /p*q*r', 'grnted');
    expect(r.isAllowed('/docs/a.pdf')).toBe(false);
    expect(r.isAllowed('/docs/a.pdf?x=1')).toBe(true);
    expect(r.isAllowed('/search/shoes/page/2')).toBe(false);
    expect(r.isAllowed('/search/shoes/page/1')).toBe(true);
    expect(r.isAllowed('/search/shoes/page/10')).toBe(false);
    expect(r.isAllowed('/pxxqyyrzz')).toBe(false);
    expect(r.isAllowed('/pxxryyqzz')).toBe(true);
    expect(r.isAllowed('/a.b')).toBe(true);
    expect(parseRobots('User-agent: *\nDisallow: /a.b', 'grnted').isAllowed('/axb')).toBe(true);
  });
});
