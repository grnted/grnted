// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// For fake pages: the audit marks the document it measured and reads its facts (src/landing.ts
// `markDocument`, `markedStill`, `bindLanding`), and landing validation reads its navigation facts. A fake
// page's document never changes: it keeps every mark it is given, and its facts are those of a plain HTML
// page at `url` that answered 200. Answers `pageFacts` and `readMark` by the function's name; undefined for
// anything else.
const marks = new Map<string, unknown>();

export function fakeMark(fnName: string, arg: unknown, url: string): unknown {
  if (fnName === 'pageFacts') {
    const a = arg as { name: string; token: string } | undefined;
    if (a) marks.set(a.name, a.token);
    const at = url.startsWith('http') ? url : `https://example.org${url}`;
    return { href: at, navUrl: at, status: 200, contentType: 'text/html', marked: !!a };
  }
  if (fnName === 'readMark') return marks.get(arg as string);
  return undefined;
}
