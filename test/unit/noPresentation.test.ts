// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The visual report is not part of the open engine (2026-11-11; Sol r1 S1): no module in src writes styled
// presentation markup, a script, a style sheet or the hosted report's class names. The engine's one HTML
// page is the plain report (src/report/plain.ts): its own small style block and two list classes, never a
// script. Read from the string literals (TypeScript's parser), so comments about a scanned page's HTML are fine.
// The repair plan's fix copy (src/report/copy/fixes.ts, open since 0.2.0: buildReport stores the plan in the JSON)
// shows developers code: its `before` and `after` lines are HTML and CSS a fix changes, printed as escaped text,
// never rendered. Those lines may hold markup; every other string in it is held to the rule, and none may be a script.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const PLAIN = 'src/report/plain.ts';
/** What only presentation code writes: a class attribute, a script or style block, the report's components, CSS. */
const MARKERS = /class\s*=|<(?:script|style|section|details|summary|button|textarea|svg|article|table|figure|time|dl|nav|header|footer)[\s>/]|@media|\{\s*display\s*:/i;
/** The plain report's own classes. */
const PLAIN_CLASSES = new Set(['ev', 'measured']);
/** Files whose code-change lines (`before: [...]`, `after: [...]`) are code shown to developers, not presentation. */
const CODE_EXAMPLES = new Set(['src/report/copy/fixes.ts']);

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (/\.(?:ts|mts|js|mjs)$/.test(name) && !name.endsWith('.d.ts')) yield p;
  }
}

/** Inside a `before: [...]` or `after: [...]` property: a line of a code change. */
function inCodeLines(n: ts.Node): boolean {
  for (let p = n.parent; p; p = p.parent) {
    if (ts.isPropertyAssignment(p) && ts.isIdentifier(p.name) && (p.name.text === 'before' || p.name.text === 'after') && ts.isArrayLiteralExpression(p.initializer)) return true;
    if (ts.isFunctionLike(p) || ts.isSourceFile(p)) return false;
  }
  return false;
}

/** The string-literal texts of a source file, each with whether it is a code-change line. */
function literals(file: string, text: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const visit = (n: ts.Node): void => {
    if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) out.push({ text: n.text, code: inCodeLines(n) });
    else if (ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push({ text: n.text, code: inCodeLines(n) });
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

/** Presentation code in engine sources: "<file>: <what>". `files`: { path relative to the package: text }. */
export function presentationHits(files: Readonly<Record<string, string>>): string[] {
  const hits: string[] = [];
  for (const [path, text] of Object.entries(files)) {
    for (const { text: lit, code } of literals(path, text)) {
      if (/<script[\s>]/i.test(lit)) hits.push(`${path}: a script`);
      if (code && CODE_EXAMPLES.has(path)) continue;
      if (path === PLAIN) {
        for (const m of lit.matchAll(/class="([^"]*)"/g)) for (const c of m[1]!.split(/\s+/).filter(Boolean)) if (!PLAIN_CLASSES.has(c)) hits.push(`${path}: class ${c}`);
        continue;
      }
      const m = MARKERS.exec(lit);
      if (m) hits.push(`${path}: ${m[0]}`);
    }
  }
  return hits;
}

describe('no visual report in the open engine', () => {
  it('no module writes presentation markup, a script or the hosted report\'s classes; the plain report keeps to its own', () => {
    const files = Object.fromEntries([...walk(join(root, 'src'))].map((f) => [relative(root, f).split('\\').join('/'), readFileSync(f, 'utf8')]));
    expect(Object.keys(files)).toContain(PLAIN);
    expect(presentationHits(files)).toEqual([]);
  });

  it('fails on planted presentation code', () => {
    expect(presentationHits({
      'src/report/a.ts': 'export const x = `<details class="fixp"><summary>Fix</summary></details>`;',
      'src/report/b.ts': "export const css = '.when-local{display:none}@media print{.x{color:red}}';",
      'src/report/c.ts': "export const s = '<script>copy()</script>';",
      [PLAIN]: 'const a = `<ul class="ev">`; const b = `<p class="card">`; const c = `<script src=x>`;',
      'src/report/d.ts': '// <section class="x"> in a comment is fine\nexport const ok = `<a href="${1}">`;',
      // The fix copy: a code change's lines may hold markup; its words, a script or the same markup elsewhere may not.
      'src/report/copy/fixes.ts': [
        "const ok = () => ({ before: ['<div>Menu</div>'], after: [`<button type=\"button\" class=\"menu\">${'Menu'}</button>`, 'a { display: inline-block; }'] });",
        "const step = 'Wrap it in <details class=\"x\">';",
        "const bad = () => ({ after: ['<script>run()</script>'] });",
      ].join('\n'),
      'src/report/e.ts': "const notFixCopy = () => ({ after: ['<button class=\"x\">'] });",
    })).toEqual(['src/report/a.ts: <details ', 'src/report/b.ts: {display:', 'src/report/c.ts: a script', 'src/report/c.ts: <script>', `${PLAIN}: class card`, `${PLAIN}: a script`,
      'src/report/copy/fixes.ts: <details ', 'src/report/copy/fixes.ts: a script', 'src/report/e.ts: <button ']);
  });
});
