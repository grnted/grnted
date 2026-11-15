// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { MAX_ROBOTS_CHARS, MAX_ROBOTS_RULES, MAX_RULE_LENGTH, parseRobots, ruleMatches } from '../../src/robots.js';
import { MAX_BODY_BYTES } from '../../src/crawl.js';
import { expectLinear, msOnce } from '../helpers/linear.js';
import { rng } from '../helpers/fuzz.js';

// parseRobots as of 82b90661 (before the linear comment strip and the caps), kept only as the oracle.
function oldParseRobots(text: string, agentToken: string) {
  type R = { allow: boolean; pattern: string; parts: string[]; anchored: boolean };
  const compile = (pattern: string) => {
    const anchored = pattern.endsWith('$');
    const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*+/g, '*');
    return { parts: body.split('*'), anchored };
  };
  const groups: { agents: string[]; rules: R[]; crawlDelay?: number }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: R[]; crawlDelay?: number } | null = null;
  let lastWasAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim();
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const key = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    if (key === 'sitemap') {
      if (value) sitemaps.push(value);
      continue;
    }
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (!current || !value) continue;
    if (key === 'disallow' || key === 'allow') {
      if (value.length <= MAX_RULE_LENGTH) current.rules.push({ allow: key === 'allow', pattern: value, ...compile(value) });
    } else if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) {
      current.crawlDelay = Number(value);
    }
  }
  const token = agentToken.toLowerCase();
  const group = groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ?? groups.find((g) => g.agents.includes('*'));
  const rules = group?.rules ?? [];
  return {
    sitemaps,
    ...(group?.crawlDelay ? { crawlDelay: group.crawlDelay } : {}),
    isAllowed(path: string): boolean {
      let best: R | null = null;
      for (const rule of rules) {
        if (!ruleMatches(rule, path)) continue;
        if (!best || rule.pattern.length > best.pattern.length || (rule.pattern.length === best.pattern.length && rule.allow)) best = rule;
      }
      return best ? best.allow : true;
    },
  };
}

const PATHS = ['/', '/private', '/private/ok', '/a#b', '/x.php', '/x.php?q=1', '/staff/', '/a/b/c', '/%E2%80%A8', '/é', '/#', '/*'];
const LINE_TOKENS = [
  'User-agent: *', 'User-agent: grnted', 'user-agent: GRNTED/1.0', 'User-agent: other', 'Disallow: /private', 'Allow: /private/ok',
  'Disallow: /*.php$', 'Disallow: /', 'Allow: /', 'Disallow:', 'Sitemap: https://e.org/s.xml', 'Crawl-delay: 2', 'Crawl-delay: 0.5',
  'Crawl-delay: x', '# just a comment', 'Disallow: /a # trailing', 'Disallow: /a#b', 'Disallow: /staff/\r# x', 'Allow: /a\rDisallow: /',
  'Disallow: /x # y', 'Allow: /# #z', '#\r# x', 'Disallow: /*', '  Disallow : /a/b  ', 'garbage', ':', '',
];

function* robotsFiles(count: number, seed: number): Generator<string> {
  const r = rng(seed);
  const NL = ['\n', '\r\n', '\n', '\r'];
  for (let i = 0; i < count; i++) {
    const lines: string[] = [];
    for (let k = Math.floor(r() * 15); k > 0; k--) lines.push(LINE_TOKENS[Math.floor(r() * LINE_TOKENS.length)]!);
    yield lines.map((l) => l + NL[Math.floor(r() * NL.length)]).join('');
  }
}

let blocked = 0;
function sameReading(text: string) {
  const want = oldParseRobots(text, 'grnted/1.0');
  const got = parseRobots(text, 'grnted/1.0');
  expect(got.sitemaps, JSON.stringify(text)).toEqual(want.sitemaps);
  expect(got.crawlDelay, JSON.stringify(text)).toEqual(want.crawlDelay);
  for (const p of PATHS) {
    const allowed = want.isAllowed(p);
    expect(got.isAllowed(p), `${JSON.stringify(text)} ${p}`).toBe(allowed);
    if (!allowed) blocked++;
  }
}

describe('robots.txt reads every file under the limits as before', () => {
  it('30,000 random files: same sitemaps, crawl delay and decisions', () => {
    blocked = 0;
    for (const text of robotsFiles(30_000, 0xb07)) sameReading(text);
    // The corpus reaches real decisions, not only "allowed".
    expect(blocked).toBeGreaterThan(20_000);
  });
  it('comment edge cases', () => {
    for (const line of ['Disallow: /a#b', 'Disallow: /a\r#b', 'Disallow: /a#b\rc', 'Disallow: /a#b #c', 'Disallow: /# ', '#', '\r', 'Disallow: /a b'])
      sameReading(`User-agent: *\n${line}\nAllow: /`);
  });
});

describe('robots.txt size and rule caps', () => {
  it('reads the first 500 KiB, and drops the line the limit cuts through', () => {
    const head = 'User-agent: *\nDisallow: /first\n';
    const pad = '#'.repeat(MAX_ROBOTS_CHARS - head.length - 1) + '\n';
    expect((head + pad).length).toBe(MAX_ROBOTS_CHARS);
    const r = parseRobots(head + pad + 'Disallow: /late\n', 'grnted');
    expect(r.isAllowed('/first')).toBe(false);
    expect(r.isAllowed('/late')).toBe(true);
    // A line ending exactly at the limit is whole and kept; one running past it is dropped.
    const cut = head + '#'.repeat(MAX_ROBOTS_CHARS + 1 - head.length - 17) + '\nDisallow: /edge\n';
    expect(cut.length).toBe(MAX_ROBOTS_CHARS + 1);
    expect(parseRobots(cut, 'grnted').isAllowed('/edge')).toBe(false);
    const over = parseRobots(head + '#'.repeat(MAX_ROBOTS_CHARS - head.length - 5) + '\nAllow: /firstish\n', 'grnted');
    expect(over.isAllowed('/firstish')).toBe(false);
  });
  it(`keeps ${MAX_ROBOTS_RULES} rules per group, ignoring later ones`, () => {
    const rules = Array.from({ length: MAX_ROBOTS_RULES + 1 }, (_, i) => `Disallow: /r${i}$`).join('\n');
    const r = parseRobots(`User-agent: *\n${rules}\nUser-agent: other\nDisallow: /`, 'grnted');
    expect(r.isAllowed(`/r${MAX_ROBOTS_RULES - 1}`)).toBe(false);
    expect(r.isAllowed(`/r${MAX_ROBOTS_RULES}`)).toBe(true);
  });
});

describe('hostile robots.txt costs linear time', () => {
  // The old comment strip rescanned from every '#' to the bare CR: quadratic in the line.
  it('a line of # before a bare CR or U+2028 scales linearly', () => {
    expectLinear((n) => () => parseRobots('#'.repeat(n) + '\rx', 'grnted'), 20_000);
    expectLinear((n) => () => parseRobots('#'.repeat(n) + ' x', 'grnted'), 20_000);
  });
  it('a 5 MB line of # before a bare CR parses in well under a second', () => {
    expect(msOnce(() => parseRobots('#'.repeat(MAX_BODY_BYTES - 2) + '\rx', 'grnted'), 1)).toBeLessThan(1000);
  });
  it('a 5 MB file of wildcard rules: 2,000 address checks stay well under a second', () => {
    const line = 'Disallow: /*a*b\n';
    const text = 'User-agent: *\n' + line.repeat(Math.floor(MAX_BODY_BYTES / line.length));
    const ms = msOnce(() => {
      const r = parseRobots(text, 'grnted');
      for (let i = 0; i < 2000; i++) r.isAllowed(`/section/page-${i}/aaaa`);
    }, 1);
    expect(ms).toBeLessThan(1500);
  }, 30_000);
});
