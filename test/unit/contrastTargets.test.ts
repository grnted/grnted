// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The fade re-run (audit.ts): a fading text's color-contrast failure is checked again once it is opaque. Its
// targets are the failures' top-document selectors; until 2026-11-08 a target string was read as an array, so only
// one-character selectors ("p") were re-run and a fading "#text" kept its false failure (Sol, late-mount r3).
import { describe, expect, it } from 'vitest';
import { contrastTargets } from '../../src/audit.js';

const run = (ids: [string, string[]][]) => ({
  violations: ids.map(([id, targets]) => ({ id, impact: 'serious', help: id, helpUrl: '', nodes: targets.map((target) => ({ target, html: '<p>x</p>' })) })),
}) as unknown as Parameters<typeof contrastTargets>[0];

describe('contrastTargets: which contrast failures the fade re-run checks', () => {
  it('takes every plain selector of a color-contrast failure, "#text" and "p" alike', () => {
    expect(contrastTargets(run([['color-contrast', ['#text', 'p', 'main > .hero h2']]]))).toEqual(['#text', 'p', 'main > .hero h2']);
  });
  it('leaves out frame and shadow targets (" >>> "), other rules, blanks and duplicates', () => {
    expect(contrastTargets(run([['color-contrast', ['#frame >>> #bad', '#host >>> .t', '', '#a', '#a']], ['image-alt', ['#img']]]))).toEqual(['#a']);
  });
});
