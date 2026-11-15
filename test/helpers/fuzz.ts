// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
/** Seeded random generator (mulberry32): the same corpus on every run. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `count` strings, each up to `maxTokens` tokens drawn at random from `tokens` (differential tests). */
export function* corpus(tokens: readonly string[], count: number, maxTokens: number, seed: number): Generator<string> {
  const r = rng(seed);
  for (let i = 0; i < count; i++) {
    const len = Math.floor(r() * (maxTokens + 1));
    let s = '';
    for (let j = 0; j < len; j++) s += tokens[Math.floor(r() * tokens.length)];
    yield s;
  }
}
