// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The open engine's HTML report (`grnted <url> --html FILE`, `--format html`): one plain, accessible,
// unbranded page with what a developer needs to find and fix the site's problems. The site, the date, the engine
// and scoring versions, the score, each WCAG 2.2 A and AA criterion's result, and every problem with its pages,
// the pages where it was measured (and which of those count), elements, evidence and the fix brief's "how to fix
// it" line (the same words as `fixPrompt`); every list says how many it leaves out. The AI review's flagged issues
// (not in the score) are listed with their fix, and the fix brief itself closes the page. Everything from the
// scanned site goes through esc(); links only through link() (http(s) only). No script, no external file, no picture. It
// scores 100 on Granted (test/integration/plainDogfood.test.ts). Engine core: no Node-only imports.
import type { AiFinding, CriterionResult, SiteReport } from '../types.js';
import { ENGINE_VERSION } from '../version.js';
import { fixText, isAiFlagged } from './ai.js';
import { elementSignature } from './startTag.js';
import { ACCESS_GRANTED_RULE, verdictLine } from './blocked.js';
import { buildCriteria, criteriaLine, STATUS_LABEL } from './criteria.js';
import { longDate, REPORT_TIME_ZONE_NAME } from './dates.js';
import { documentsLine } from './documents.js';
import { FIX_PROMPT_AUDIENCES, fixPrompt } from './fixPrompt.js';
import { esc, link } from './escape.js';
import { mediaLine } from './media.js';
import type { Problem } from './model.js';
import { buildProblems } from './problems.js';

/** Evidence items listed per problem at most (the JSON has every one). */
export const PLAIN_EVIDENCE_MAX = 10;
/** Pages listed per problem at most, affected and measured alike (the JSON has every one). */
export const PLAIN_PAGES_MAX = 25;
/** AI-flagged issues listed per AI check at most. */
export const PLAIN_AI_MAX = 50;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/** A link when the address is a safe http(s) URL, else the address as text. */
const urlLink = link;

/** A page address shown short: its path on the scanned site, the full address elsewhere. */
function pageLink(url: string, site: string): string {
  let text = url;
  try {
    const u = new URL(url);
    if (u.origin === new URL(site).origin) text = `${u.pathname}${u.search}` || '/';
  } catch { /* the address as it is */ }
  return urlLink(url, text);
}

function hostOf(site: string): string {
  try {
    return new URL(site).hostname;
  } catch {
    return site;
  }
}

/** Where a problem is: pages, elements, the HTML the rules saw and what the tests measured. */
function evidenceItems(report: SiteReport, p: Problem): string[] {
  const items: string[] = [];
  const site = report.site;
  const rule = p.key.startsWith('rule:') ? (report.rules ?? []).find((r) => r.id === p.key.slice(5)) : undefined;
  if (rule) {
    // Batch 19: one element of every pattern (each pattern's own example), else the rule's examples (older reports).
    const patterns = (rule.signatures ?? []).flatMap((s) => (s && s.example && typeof s.example.html === 'string' ? [{ ...s.example, pages: Number(s.pages) || 0 }] : []));
    // Examples of an element whose start tag gives no pattern are shown too.
    const known = new Set((rule.signatures ?? []).map((s) => s.sig));
    const unpatterned = patterns.length ? (rule.examples ?? []).filter((x) => !known.has(elementSignature(x.html))).map((x) => ({ ...x, pages: 0 })) : [];
    for (const e of patterns.length ? [...patterns, ...unpatterned] : (rule.examples ?? []).map((x) => ({ ...x, pages: 0 }))) {
      const repeats = e.pages >= 2 ? ` (the same element on ${plural(e.pages, 'page')})` : '';
      items.push(`${pageLink(e.page, site)}${e.target ? `, element <code>${esc(e.target)}</code>` : ''}${e.html ? `: <code>${esc(e.html)}</code>` : ''}${repeats}`);
    }
  }
  // A rule's text evidence repeats its examples ("Failing element: ..."): only the other problems list theirs. The same
  // line twice (a failure from both screen widths) is listed once.
  const seen = new Set(items);
  for (const e of [...(rule ? [] : p.textEvidence), ...(p.sameElement ?? [])]) {
    const item = `${pageLink(e.page, site)}${e.target ? `, element <code>${esc(e.target)}</code>` : ''}: ${esc(e.detail)}`;
    if (seen.has(item)) continue;
    seen.add(item);
    items.push(item);
  }
  for (const img of p.aiImages ?? []) {
    const alt = img.alt === undefined ? 'no alt attribute' : img.alt === '' ? 'empty alt (marked decorative)' : `alt <code>${esc(img.alt)}</code>`;
    items.push(`${pageLink(img.page, site)}, image ${urlLink(img.src, img.src)} (${alt}): ${esc(img.observed)}${img.essentialText ? ` Text in the picture: ${esc(img.essentialText)}` : ''}`);
  }
  // Batch 19: each document by the words people know it by (its title, its link, the file name), then its address.
  for (const d of p.documents ?? []) items.push(`${docName(d)}${urlLink(d.url)}: ${esc(d.problems.join('; '))}`);
  for (const f of p.officeFiles ?? []) items.push(`${docName(f)}${urlLink(f.url)}: ${esc(f.problems.join('; '))}`);
  return items;
}

/** "“Title”, linked as “words”, file name.pdf: " for a document row, or '' when the report kept none of them. */
function docName(d: { linkText?: string; fileName?: string; title?: string }): string {
  const parts = [
    d.title ? `PDF title “${esc(d.title)}”` : '',
    d.linkText ? `linked as “${esc(d.linkText)}”` : '',
    d.fileName ? `file <code>${esc(d.fileName)}</code>` : '',
  ].filter(Boolean);
  return parts.length ? `${parts.join(', ')}: ` : '';
}

/** Which check found a problem, from its key's family (src/report/problems.ts). */
export function sourceOf(key: string): string {
  if (key.startsWith('rule:')) return `axe-core rule <code>${esc(key.slice(5))}</code>`;
  if (key.startsWith('third-party:')) return `axe-core rule <code>${esc(key.slice(12))}</code>, inside content from another site`;
  if (key.startsWith('criterion:')) return 'Granted’s automated tests';
  if (key.startsWith('ai:')) return 'the AI review, double-checked';
  if (key.startsWith('consistency:')) return 'the comparison of the same components across pages';
  if (key.startsWith('media:')) return 'the video and audio rules';
  if (key === 'documents') return 'the PDF checks';
  if (key === 'office') return 'the Word, Excel and PowerPoint checks';
  return 'Granted’s checks';
}

/** Up to PLAIN_PAGES_MAX items, then "and N more pages". */
function listPages(items: readonly string[], total: number): string {
  const more = total - items.length;
  return `${items.join(', ')}${more > 0 ? `, and ${plural(more, 'more page')}` : ''}`;
}

function problemArticle(report: SiteReport, p: Problem, n: number): string {
  const id = `problem-${n}`;
  const criteria = p.criteria.map((c) => `${esc(c.criterion)} (Level ${esc(c.level)})`).join(', ');
  const found = sourceOf(p.key);
  const score = p.scored ? (p.pointsLost > 0 ? `In the score: fixing it adds ${plural(Math.round(p.pointsLost), 'point')}.` : 'In the score.') : 'Not in the score.';
  const where = `${plural(p.pages.length, 'page')}${p.count.unit !== 'page' ? `, ${plural(p.count.n, p.count.unit)}` : ''}${p.repeats ? `; it repeats on ${p.repeats.pages} of ${p.repeats.of} pages, so it most likely comes from one shared template` : ''}.`;
  const items = evidenceItems(report, p);
  const shown = items.slice(0, PLAIN_EVIDENCE_MAX);
  // Every affected page (up to the cap, the rest counted), whatever the evidence samples show.
  const pages = p.pages.length ? `<p><strong>Pages (${p.pages.length.toLocaleString('en-US')}):</strong> ${listPages(p.pages.slice(0, PLAIN_PAGES_MAX).map((u) => pageLink(u, report.site)), p.pages.length)}</p>` : '';
  // Where a test measured the failure, and whether that page counts in the score.
  const measured = p.measured ?? [];
  const counted = measured.filter((m) => m.scored).length;
  const shownMeasured = measured.slice(0, PLAIN_PAGES_MAX);
  const measuredHtml = measured.length
    ? `<p><strong>Measured on ${plural(measured.length, 'page')}</strong> (${counted.toLocaleString('en-US')} ${counted === 1 ? 'counts' : 'count'} in the score):</p>
<ul class="measured">${shownMeasured.map((m) => `<li>${pageLink(m.page, report.site)}: ${esc(m.method)}; ${m.scored ? 'counts in the score' : 'not in the score'}</li>`).join('')}</ul>${measured.length > shownMeasured.length ? `<p>And ${plural(measured.length - shownMeasured.length, 'more page')} in the JSON report.</p>` : ''}`
    : '';
  return `<article aria-labelledby="${id}">
<h3 id="${id}">${n}. ${esc(p.copy.title)}</h3>
<p>WCAG ${criteria || 'criteria not listed'}. Found by ${found}. ${score}</p>
<p><strong>What is wrong:</strong> ${esc(p.copy.who)}</p>
<p><strong>How to fix it:</strong> ${esc(p.copy.fix)}</p>
<p><strong>Where:</strong> ${where}</p>
${pages}${measuredHtml}${shown.length ? `<ul class="ev">${shown.map((i) => `<li>${i}</li>`).join('')}</ul>${items.length > shown.length ? `<p>And ${plural(items.length - shown.length, 'more item')} in the JSON report.</p>` : ''}` : ''}
</article>`;
}

function criteriaTable(rows: readonly CriterionResult[]): string {
  const body = rows.map((r) => `<tr><th scope="row">${esc(r.criterion)} ${esc(r.title)}</th><td>${esc(r.level)}</td><td>${esc(STATUS_LABEL[r.status] ?? r.status)}</td></tr>`).join('\n');
  return `<table>
<caption>Each WCAG 2.2 Level A and AA criterion and what the automated tests found</caption>
<thead><tr><th scope="col">Criterion</th><th scope="col">Level</th><th scope="col">Result</th></tr></thead>
<tbody>
${body}
</tbody></table>`;
}

/** The fix brief (`fixPrompt`), both audiences, as text to copy into an AI assistant. */
function fixBriefSection(report: SiteReport): string {
  const who = { developer: 'For a web developer', content: 'For a content editor' } as const;
  return `<section aria-labelledby="fix-brief">
<h2 id="fix-brief">Fix brief for an AI assistant</h2>
<p>The same problems as instructions for an AI assistant, to paste in whole.</p>
${FIX_PROMPT_AUDIENCES.map((a) => `<details><summary>${who[a]}</summary><pre>${esc(fixPrompt(report, { audience: a }))}</pre></details>`).join('\n')}
</section>`;
}

function aiItem(f: AiFinding, site: string): string {
  return `<li><strong>${esc(f.label)}</strong> (WCAG ${esc(f.criterion)}) on ${pageLink(f.page, site)}${f.target ? `, <code>${esc(f.target)}</code>` : ''}${f.issue || f.observed ? `: ${esc(f.issue || f.observed)}` : ''} <strong>How to fix it:</strong> ${esc(fixText(f))}</li>`;
}

function aiSection(report: SiteReport): string {
  const runs = (report.ai?.runs ?? []).map((run) => ({ run, flagged: run.findings.filter(isAiFlagged) })).filter((r) => r.flagged.length);
  if (!runs.length) return '';
  return `<section aria-labelledby="ai">
<h2 id="ai">AI review: flagged issues, not in the score</h2>
<p>What the AI review flagged that does not count toward the score. Its double-checked problems that count are in the findings above.</p>
${runs.map(({ run, flagged }) => `<h3>${esc(run.title)} (${plural(flagged.length, 'issue')})</h3>
<ul class="ev">${flagged.slice(0, PLAIN_AI_MAX).map((f) => aiItem(f, report.site)).join('')}</ul>${flagged.length > PLAIN_AI_MAX ? `<p>And ${plural(flagged.length - PLAIN_AI_MAX, 'more issue')} in the JSON report.</p>` : ''}`).join('\n')}
</section>`;
}

const CSS = `
:root{color-scheme:light}
body{margin:0;background:#fff;color:#1a1a1a;font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
header,main,footer{max-width:60rem;margin:0 auto;padding:0 1rem}
h1{font-size:1.75rem;line-height:1.25;margin:1.5rem 0 .5rem}
h2{font-size:1.375rem;margin:2rem 0 .5rem;border-top:1px solid #767676;padding-top:1rem}
h3{font-size:1.125rem;margin:1.5rem 0 .25rem}
a{color:#0b57d0;text-decoration:underline}
a:focus-visible{outline:3px solid #1a1a1a;outline-offset:2px}
code{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.875em;background:#f2f2f2;padding:0 .2em;overflow-wrap:anywhere;word-break:break-word}
p,li,dd,td,th{overflow-wrap:anywhere}
dl{display:grid;grid-template-columns:max-content 1fr;gap:.25rem 1rem}
dt{font-weight:600}
dd{margin:0}
table{border-collapse:collapse;width:100%}
caption{text-align:left;font-weight:600;padding:.5rem 0}
th,td{border:1px solid #767676;padding:.375rem .5rem;text-align:left;vertical-align:top}
thead th{background:#f2f2f2}
article{border-bottom:1px solid #d0d0d0;padding-bottom:.75rem}
ul.ev,ul.measured{padding-left:1.25rem}
pre{font-family:ui-monospace,Menlo,Consolas,monospace;font-size:.875rem;background:#f2f2f2;padding:.75rem;white-space:pre-wrap;overflow-wrap:anywhere}
summary{cursor:pointer;font-weight:600;padding:.25rem 0}
summary:focus-visible{outline:3px solid #1a1a1a;outline-offset:2px}
ul.ev li,ul.measured li{margin:.25rem 0}
footer{margin:2rem auto;color:#4d4d4d}
@media (max-width:30rem){dl{grid-template-columns:1fr}}
`;

/** The plain HTML report: one self-contained page (no script, no external file, no picture). */
export function renderPlainHtml(report: SiteReport): string {
  const site = String(report.site ?? '');
  const host = hostOf(site);
  const rows = report.criteria ?? buildCriteria(report);
  const problems = buildProblems(report);
  const ok = report.pages.filter((p) => p.status === 'ok').length;
  const date = longDate(report.meta?.finishedAt);
  const scored = report.status === 'scored' && typeof report.score === 'number';
  // Batch 19: the verdict with its reason on the same line, and what Access Granted means (never a bare "Access Denied").
  const line = verdictLine(report);
  const verdict = scored && line
    ? `<strong>${esc(String(report.score))} out of 100</strong>, grade ${esc(String(report.letter ?? ''))}: ${esc(line.split(' · ').slice(2).join(' · '))}`
    : '<strong>No score</strong>: the scan did not finish';
  const reasons = !scored && report.reasons?.length ? `<ul>${report.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : '';
  const scoredCount = problems.filter((p) => p.scored).length;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Accessibility report: ${esc(host)}</title>
<style>${CSS}</style>
</head>
<body>
<header>
<h1>Accessibility report: ${esc(host)}</h1>
<p>WCAG 2.2, Levels A and AA. Automated results from the Granted engine.</p>
</header>
<main>
<section aria-labelledby="summary">
<h2 id="summary">Summary</h2>
<dl>
<dt>Site</dt><dd>${urlLink(site)}</dd>
<dt>Scanned</dt><dd>${date ? `${esc(date)} (${REPORT_TIME_ZONE_NAME})` : 'Date unknown'}</dd>
<dt>Pages checked</dt><dd>${ok.toLocaleString('en-US')} of ${plural(report.pages.length, 'page')} loaded</dd>
<dt>Score</dt><dd>${verdict}</dd>
<dt>Engine</dt><dd>grnted ${esc(String(report.meta?.engine ?? ENGINE_VERSION))}, scoring ${esc(String(report.meta?.scoring ?? ''))}</dd>
</dl>
<p>${esc(ACCESS_GRANTED_RULE)}</p>${reasons}
<p>WCAG criteria (${rows.length}): ${esc(criteriaLine(rows))}.</p>
<p>${esc(documentsLine(report))}.${report.media?.length ? ` ${esc(mediaLine(report))}.` : ''}</p>
</section>
<section aria-labelledby="findings">
<h2 id="findings">Findings (${problems.length})</h2>
${problems.length ? `<p>${plural(problems.length, 'problem')}, ${scoredCount} in the score, most points first.</p>
${problems.map((p, i) => problemArticle(report, p, i + 1)).join('\n')}` : '<p>The automated tests found no problems on the pages checked.</p>'}
</section>
${aiSection(report)}
<section aria-labelledby="criteria">
<h2 id="criteria">WCAG 2.2 results by criterion</h2>
${criteriaTable(rows)}
</section>
${fixBriefSection(report)}
</main>
<footer>
<p>Made with the Granted engine, grnted ${esc(ENGINE_VERSION)}.</p>
</footer>
</body>
</html>
`;
}
