// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a source file imports, read with TypeScript's own parser so that every form counts: `import x from`,
// `import { x } from`, `import * as`, `import type`, a side-effect `import 'x'`, `export * from`, `export { x } from`,
// `import x = require('x')`, `require('x')` and `import('x')` with a string. Used by the boundary guards
// (selfContained.test.ts, and the hosted report's own boundary test), each with planted violations that prove
// it fails.
import { builtinModules } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import ts from 'typescript';

export interface ImportRef {
  spec: string;
  /** 'static': import/export declarations (evaluated when the module loads); 'dynamic': import() or require(). */
  kind: 'static' | 'dynamic';
}

export function importsOf(file: string, text: string): ImportRef[] {
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const out: ImportRef[] = [];
  const visit = (n: ts.Node): void => {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteralLike(n.moduleSpecifier)) out.push({ spec: n.moduleSpecifier.text, kind: 'static' });
    else if (ts.isImportEqualsDeclaration(n) && ts.isExternalModuleReference(n.moduleReference) && ts.isStringLiteralLike(n.moduleReference.expression)) out.push({ spec: n.moduleReference.expression.text, kind: 'static' });
    else if (ts.isCallExpression(n) && n.arguments.length >= 1 && ts.isStringLiteralLike(n.arguments[0]!)
      && (n.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(n.expression) && n.expression.text === 'require'))) out.push({ spec: n.arguments[0].text, kind: 'dynamic' });
    n.forEachChild(visit);
  };
  visit(sf);
  return out;
}

const BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]));
/** A Node built-in in any spelling: 'fs', 'node:fs', 'fs/promises', 'node:fs/promises'. */
export function isBuiltin(spec: string): boolean {
  return spec.startsWith('node:') || BUILTINS.has(spec) || BUILTINS.has(spec.split('/')[0]!);
}

/** The package an import names ('@scope/name' or 'name'), or null for a relative path. */
export function packageOf(spec: string): string | null {
  if (spec.startsWith('.') || spec.startsWith('/')) return null;
  return spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
}

/** A relative import's file among `files` (a .js specifier is its .ts source; a folder is its index). */
export function resolveIn(from: string, spec: string, files: ReadonlySet<string>): string | null {
  const base = resolve(dirname(from), spec);
  for (const c of [base, base.replace(/\.js$/, '.ts'), base.replace(/\.mjs$/, '.mts'), `${base}.ts`, join(base, 'index.ts')]) if (files.has(c)) return c;
  return null;
}

/**
 * Everything a module loads when it is imported, following static relative imports from `entry` through `files`
 * ({ absolute path: text }): [file, its static imports] for every reachable file.
 */
export function reachable(entry: string, files: Readonly<Record<string, string>>): Map<string, ImportRef[]> {
  const set = new Set(Object.keys(files));
  const seen = new Map<string, ImportRef[]>();
  const todo = [entry];
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f) || files[f] === undefined) continue;
    const refs = importsOf(f, files[f]!).filter((r) => r.kind === 'static');
    seen.set(f, refs);
    for (const r of refs) if (r.spec.startsWith('.')) { const t = resolveIn(f, r.spec, set); if (t) todo.push(t); }
  }
  return seen;
}
