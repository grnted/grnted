// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { expect, it, vi } from 'vitest';
import { runAxe } from '../../src/axeRun.js';
import type { AxeRun, FrameLike, PageLike } from '../../src/types.js';

it('Sol popup-r5 8: locating twenty 10-ms frames consumes the same 15-ms total budget', async () => {
  vi.useFakeTimers();
  let located = 0;
  const empty: AxeRun = { violations: [], incomplete: [], passes: [], inapplicable: [] };
  const top = {
    url: () => 'https://town.example/', parentFrame: () => null,
    evaluate: async (_fn: unknown, arg?: { step: string; el?: number }) => arg?.step === 'top'
      ? { frames: Array.from({ length: 20 }, (_, i) => `https://town.example/frame-${i}`) }
      : arg?.step === 'locate' ? { index: arg.el, context: {} } : { run: empty },
  } as unknown as FrameLike;
  const frames = Array.from({ length: 20 }, (_, i) => ({
    url: () => `https://town.example/frame-${i}`, parentFrame: () => top,
    frameElement: async () => { located++; await new Promise((r) => setTimeout(r, 10)); return i; },
    evaluate: async () => 'text/html',
  } as unknown as FrameLike));
  try {
    const start = Date.now();
    const pending = runAxe({ frames: () => [top, ...frames] } as PageLike, '', { maxFrames: 20, frameTimeoutMs: 5, totalMs: 15 });
    await vi.advanceTimersByTimeAsync(15);
    const settled = vi.fn();
    void pending.then(settled);
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toHaveBeenCalledOnce();
    const result = await pending;
    expect(Date.now() - start).toBeLessThanOrEqual(16);
    expect(located).toBe(2);
    expect(result.untestedFrames).toHaveLength(20);
    expect(result.untestedFrames.every((f) => /time limit/.test(f.reason))).toBe(true);
  } finally { vi.useRealTimers(); }
});
