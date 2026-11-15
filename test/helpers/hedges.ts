// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Paul, 2026-11-05: "we either trust our product or we don't. Quit it with the disclaimers." No customer
// surface (a page, the report, the PDF, an email, the downloads) says what Granted isn't, hedges what it
// knows, or apologises. The legal substance lives in the Terms and the Privacy notice only, which are the
// one place these words may appear. Shared by the engine's, the site's and the emails' copy tests.

/** Each entry: what it guards against, and the words. Apostrophes match both ’ and '. */
export const BANNED_HEDGES: readonly { what: string; re: RegExp }[] = [
  { what: 'a legal disclaimer', re: /not a legal|legal (ruling|determination|finding)|legal compliance|legal advice/i },
  { what: 'a certificate disclaimer', re: /not a certificat|isn[’']t a certificat|or a certificate/i },
  { what: 'automated tests can’t find everything', re: /can[’']?t find (everything|all|every)|cannot find (everything|all|every)|won[’']t find every|not all of them|no automated tool/i },
  { what: 'a conformance disclaimer', re: /not a conformance claim|results may vary|for guidance only/i },
  { what: 'a hedge', re: /\bmay not\b|we can[’']?t guarantee|we cannot guarantee|\bwe think\b|a starting point/i },
  { what: 'an apology', re: /\bsorry\b|\bunfortunately\b|small team/i },
];

/** Every banned match in `text`, as "what: …context…" (empty when the copy is clean). */
export function hedgeHits(text: string): string[] {
  const out: string[] = [];
  for (const { what, re } of BANNED_HEDGES) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const at = m.index ?? 0;
      out.push(`${what}: …${text.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}…`);
    }
  }
  return out;
}
