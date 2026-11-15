// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The live scan view names each built-in test (`ScanEvent` stage, src/probes/labels.ts): every test in the registry has
// a plain name of its own, never its id with dashes turned into spaces (batch 15b: the semantics lane's `names` and
// `language-parts` tests had none).
import { describe, expect, it } from 'vitest';
import { hasProbeLabel, probeLabel } from '../../src/probes/labels.js';
import { PROBES } from '../../src/probes/registry.js';

describe('probe labels', () => {
  it('every registered test has a plain name of its own', () => {
    expect(PROBES.map((p) => p.id).filter((id) => !hasProbeLabel(id))).toEqual([]);
  });

  it('names the names and language-parts tests', () => {
    expect(probeLabel('names')).toBe('Names');
    expect(probeLabel('language-parts')).toBe('Language of page and parts');
  });

  it('a test the list does not know is named after its id', () => {
    expect(hasProbeLabel('my-own-test')).toBe(false);
    expect(probeLabel('my-own-test')).toBe('My own test');
  });
});
