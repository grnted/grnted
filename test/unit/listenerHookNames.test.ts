// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The listener hook exposes its functions on window by name; a name exposed twice replaces the first. Batch 18 lane
// media: a new __grntedHold (the timer hold's state) replaced the click canceller of that name and broke the pointer
// tests (2.5.2 "could not run"). Every exposed name is unique.
import { describe, expect, it } from 'vitest';
import { LISTENER_HOOK_SCRIPT } from '../../src/probes/listeners.js';

describe('the listener hook', () => {
  it('exposes each name once', () => {
    const names = [...LISTENER_HOOK_SCRIPT.matchAll(/expose\('(__grnted\w+)'/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThan(5);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });
});
