// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
interface Rule {
  allow: boolean;
  /** The rule's path as written (its length decides between matching rules, RFC 9309 2.2.2). */
  pattern: string;
  /** The pattern cut at its `*`s (runs of them collapsed), and whether `$` anchors its end. */
  parts: string[];
  anchored: boolean;
}

export interface Robots {
  isAllowed(pathWithQuery: string): boolean;
  sitemaps: string[];
  /** `Crawl-delay` (seconds) from the group that applies to us; absent when not a positive number. */
  crawlDelay?: number;
}

/** A longer rule is ignored: a hostile robots.txt costs bounded time per address (linear in both). */
export const MAX_RULE_LENGTH = 2048;

/**
 * robots.txt is read up to here and the rest ignored, as Google does (500 KiB; RFC 9309 2.5 asks for at
 * least that much). The line the limit cuts through is dropped, never read half (a cut `Allow:` would
 * allow more than the site wrote).
 */
export const MAX_ROBOTS_CHARS = 500 * 1024;

/**
 * Rules kept per user-agent group; later ones are ignored. Every address checked is matched against
 * every rule of our group, so this bounds the cost of a hostile file (a few thousand checks per scan).
 */
export const MAX_ROBOTS_RULES = 5000;

/**
 * The line without its comment. Same result as `raw.replace(/#.*$/, '')`, which cut at the first `#`
 * after the line's last bare CR, U+2028 or U+2029 (`.` stops at those, `$` is the end of the line),
 * without that regex's rescan from every `#`: quadratic on a line of `#`s before a bare CR.
 */
function stripComment(raw: string): string {
  let from = 0;
  for (let i = raw.length - 1; i >= 0; i--) {
    const c = raw.charCodeAt(i);
    if (c === 13 || c === 0x2028 || c === 0x2029) {
      from = i + 1;
      break;
    }
  }
  const hash = raw.indexOf('#', from);
  return hash < 0 ? raw : raw.slice(0, hash);
}

function compile(pattern: string): Pick<Rule, 'parts' | 'anchored'> {
  const anchored = pattern.endsWith('$');
  const body = (anchored ? pattern.slice(0, -1) : pattern).replace(/\*+/g, '*');
  return { parts: body.split('*'), anchored };
}

/**
 * RFC 9309 matching without a RegExp: `*` is any run of characters, `$` ends the path, otherwise a
 * prefix match. Greedy, leftmost: each literal part is found at its first place after the one before
 * (always right for `*` wildcards), so the time is linear in the path, whatever the rule. Staging
 * 2026-11-03: a rule with ~140 `*` in a row, compiled to `.*` per star, backtracked without end and
 * spun the scan's Durable Object until it was reset.
 */
export function ruleMatches(rule: Pick<Rule, 'parts' | 'anchored'>, path: string): boolean {
  const { parts, anchored } = rule;
  const first = parts[0]!;
  if (!path.startsWith(first)) return false;
  if (parts.length === 1) return anchored ? path.length === first.length : true;
  let at = first.length;
  const last = parts.length - 1;
  for (let i = 1; i < last; i++) {
    const p = parts[i]!;
    if (!p) continue;
    const found = path.indexOf(p, at);
    if (found < 0) return false;
    at = found + p.length;
  }
  const tail = parts[last]!;
  if (!anchored) return path.indexOf(tail, at) >= 0;
  // Anchored: the last part ends the path, after everything matched before it.
  return path.length - tail.length >= at && path.endsWith(tail);
}

export function parseRobots(text: string, agentToken: string): Robots {
  const groups: { agents: string[]; rules: Rule[]; crawlDelay?: number }[] = [];
  const sitemaps: string[] = [];
  let current: { agents: string[]; rules: Rule[]; crawlDelay?: number } | null = null;
  let lastWasAgent = false;

  if (text.length > MAX_ROBOTS_CHARS) text = text.slice(0, text.lastIndexOf('\n', MAX_ROBOTS_CHARS) + 1);
  for (const raw of text.split(/\r?\n/)) {
    const line = stripComment(raw).trim();
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
      if (value.length <= MAX_RULE_LENGTH && current.rules.length < MAX_ROBOTS_RULES) current.rules.push({ allow: key === 'allow', pattern: value, ...compile(value) });
    } else if (key === 'crawl-delay' && /^\d+(\.\d+)?$/.test(value) && Number(value) > 0) {
      current.crawlDelay = Number(value);
    }
  }

  const token = agentToken.toLowerCase();
  const group =
    groups.find((g) => g.agents.some((a) => a !== '*' && token.includes(a))) ??
    groups.find((g) => g.agents.includes('*'));
  const rules = group?.rules ?? [];

  return {
    sitemaps,
    ...(group?.crawlDelay ? { crawlDelay: group.crawlDelay } : {}),
    isAllowed(pathWithQuery: string): boolean {
      let best: Rule | null = null;
      for (const rule of rules) {
        if (!ruleMatches(rule, pathWithQuery)) continue;
        if (
          !best ||
          rule.pattern.length > best.pattern.length ||
          (rule.pattern.length === best.pattern.length && rule.allow)
        ) {
          best = rule;
        }
      }
      return best ? best.allow : true;
    },
  };
}
