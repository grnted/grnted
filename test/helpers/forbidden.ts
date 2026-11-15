// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// "Public what, private how" (Paul, 2026-11-03): what no customer-facing surface may say about the
// method (the HTML report, its PDF source, the homepage check, the CSV/XLSX issue list, the public
// JSON). Each entry names what it guards against; `leaks` lists every match with some context, so a
// failing test says exactly what leaked and where.

export const FORBIDDEN: readonly { what: string; re: RegExp }[] = [
  { what: 'a model name', re: /gpt-|claude-|gemini/i },
  { what: 'a prompt version', re: /@\d+/ },
  { what: 'promptVersion', re: /promptVersion/ },
  { what: 'enabledRules', re: /enabledRules/ },
  { what: 'userAgent', re: /userAgent/ },
  { what: 'the two-run confirmation', re: /two independent runs/i },
  { what: 'the formula', re: /square root/i },
  { what: 'a sample size', re: /random sample/i },
  { what: 'an axe tag id', re: /\bwcag2[0-9]?a{1,3}\b/ },
  { what: 'a probe timing', re: /"ms":/ },
  // The criteria section's old "How it was tested" column and method paragraph (Paul, 2026-11-03).
  { what: 'the method column', re: /How it was tested/ },
  { what: 'a method name in the criteria results', re: /axe-core rules \(in the score\)| test \(in the score\)|Video and audio rules|Cross-page comparison rules/ },
  { what: 'an AI review method name', re: /AI review of (image descriptions|page text|screenshots|PDFs|video and audio|forms|names across pages)/ },
  { what: 'the coverage note', re: /Coverage grows as automated checks are added|automated check being built/ },
];

/** Every forbidden match in `text`, as "what: …context…". */
export function leaks(text: string): string[] {
  const out: string[] = [];
  for (const { what, re } of FORBIDDEN) {
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`);
    for (const m of text.matchAll(g)) {
      const at = m.index ?? 0;
      out.push(`${what}: …${text.slice(Math.max(0, at - 60), at + 60).replace(/\s+/g, ' ')}…`);
    }
  }
  return out;
}
