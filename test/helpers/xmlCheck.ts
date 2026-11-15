// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A strict XML 1.0 well-formedness check for the generated OOXML parts (no parser dependency): one
// prolog, one root, balanced and properly nested tags, quoted and unique attributes, only the five
// predefined entities or numeric references, no raw '<' or '&' in text or attribute values, and no
// character XML 1.0 forbids. Throws with the offending position; returns the element names in order.
const NAME = /^[A-Za-z_][\w.-]*(?::[A-Za-z_][\w.-]*)?$/;
const BAD_CHAR = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/;

function checkText(s: string, at: number): void {
  if (BAD_CHAR.test(s)) throw new Error(`forbidden character near ${at}`);
  if (s.includes('<')) throw new Error(`raw '<' near ${at}`);
  for (const m of s.matchAll(/&([^;]*);?/g)) {
    if (!m[0].endsWith(';') || !/^(?:amp|lt|gt|quot|apos|#\d+|#x[0-9A-Fa-f]+)$/.test(m[1]!)) throw new Error(`bad entity '${m[0]}' near ${at}`);
  }
}

export function checkWellFormed(xml: string): string[] {
  let i = 0;
  if (xml.startsWith('<?xml')) {
    const end = xml.indexOf('?>');
    if (end < 0) throw new Error('unterminated prolog');
    i = end + 2;
  }
  const stack: string[] = [];
  const names: string[] = [];
  let roots = 0;
  while (i < xml.length) {
    const lt = xml.indexOf('<', i);
    const text = xml.slice(i, lt < 0 ? xml.length : lt);
    if (!stack.length && text.trim()) throw new Error(`text outside the root near ${i}`);
    checkText(text, i);
    if (lt < 0) break;
    const gt = xml.indexOf('>', lt);
    if (gt < 0) throw new Error(`unterminated tag at ${lt}`);
    const tag = xml.slice(lt + 1, gt);
    i = gt + 1;
    if (tag.startsWith('/')) {
      const name = tag.slice(1).trim();
      if (stack.pop() !== name) throw new Error(`mismatched </${name}> at ${lt}`);
      continue;
    }
    const selfClosing = tag.endsWith('/');
    const body = selfClosing ? tag.slice(0, -1) : tag;
    const m = /^([^\s/>]+)([\s\S]*)$/.exec(body);
    if (!m || !NAME.test(m[1]!)) throw new Error(`bad tag name at ${lt}`);
    const seen = new Set<string>();
    let rest = m[2]!;
    while (rest.trim()) {
      const a = /^\s+([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(rest);
      if (!a || !NAME.test(a[1]!)) throw new Error(`bad attribute in <${m[1]}> at ${lt}`);
      if (seen.has(a[1]!)) throw new Error(`duplicate attribute ${a[1]} at ${lt}`);
      seen.add(a[1]!);
      checkText(a[3] ?? a[4] ?? '', lt);
      rest = rest.slice(a[0].length);
    }
    if (!stack.length) roots++;
    if (roots > 1) throw new Error(`second root element at ${lt}`);
    names.push(m[1]!);
    if (!selfClosing) stack.push(m[1]!);
  }
  if (stack.length) throw new Error(`unclosed <${stack[stack.length - 1]}>`);
  if (roots !== 1) throw new Error('no root element');
  return names;
}
