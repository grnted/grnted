// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A document answered with HTTP 202: a bot challenge (AWS WAF answers 202 with a script page that needs
// a POST the scanner never sends), or a site that answers 202 to everyone. It is never the page, so a
// page whose load got it did not load, for axe and the core tests alike (docs/scoring.md, v7).
// Engine core: no Node-only imports.

/** Why such a page counts as not loaded, as the report shows it. */
export const CHALLENGE_PAGE = 'the site answered with a bot challenge (HTTP 202) instead of the page';

/** A document status that is a challenge, never the page. */
export const isChallengeStatus = (status: number): boolean => status === 202;

/**
 * A start page answer that turns the scanner away (staging 2026-11-03: trademe.co.nz answers 406 to
 * every automated request): a challenge, or any 4xx but 404/410 (not there) and 408 (time).
 */
export const isRefusalStatus = (status: number): boolean =>
  isChallengeStatus(status) || (status >= 400 && status < 500 && status !== 404 && status !== 408 && status !== 410);

/**
 * A page answered by a known WAF's challenge instead of the page, whatever its status: Cloudflare's
 * `cf-mitigated: challenge`, AWS WAF's `x-amzn-waf-action: challenge|captcha`. Never the page.
 */
export const BOT_CHALLENGE = 'the site answered with a bot challenge instead of the page';

/** Response headers (lower-case names) of a known WAF challenge. */
export function isWafChallenge(headers: Record<string, string>): boolean {
  const cf = headers['cf-mitigated']?.toLowerCase() ?? '';
  const aws = headers['x-amzn-waf-action']?.toLowerCase() ?? '';
  return cf.includes('challenge') || aws === 'challenge' || aws === 'captcha';
}
