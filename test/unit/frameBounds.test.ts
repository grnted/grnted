// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Fix round 1 of the keyboard-op lane (review F3): every call into a frame is bounded. A same-site frame that never
// answers costs only its own coverage (2.1.1 not testable for that frame), never the keyboard walk's time; a frame on
// another site is never called into at all. Fakes: a page whose own answers come at once, a frame that never answers.
import { describe, expect, it } from 'vitest';
import { frameClickables } from '../../src/probes/keyboard/index.js';
import { bounded, FRAME_CALL_MS, FrameTimeout, settleFrames } from '../../src/probes/frameContext.js';
import type { FrameLike, PageLike } from '../../src/types.js';
import type { ProbeContext } from '../../src/probes/types.js';

const never = () => new Promise<never>(() => {});

/** A page at https://e.org with one child frame; `frameAnswers` decides what the frame answers (by function name). */
function fake(frameUrl: string, frameAnswers: (name: string) => Promise<unknown>) {
  const calls: string[] = [];
  const main = { url: () => 'https://e.org/p', parentFrame: () => null } as unknown as FrameLike;
  const frame: FrameLike = {
    url: () => frameUrl,
    parentFrame: () => main,
    frameElement: async () => ({ el: 'frame' }),
    evaluate: ((fn: unknown) => { const name = typeof fn === 'function' ? fn.name : 'script'; calls.push(`frame:${name}`); return frameAnswers(name); }) as FrameLike['evaluate'],
  };
  const page = {
    url: () => 'https://e.org/p',
    frames: () => [main, frame],
    waitForTimeout: (ms: number) => new Promise<void>((r) => setTimeout(r, ms)),
    async evaluate(fn: (a: unknown) => unknown) {
      calls.push(`page:${fn.name}`);
      if (fn.name === 'frameSlots') return [{ path: '#map-frame', src: frameUrl, kind: frameUrl.startsWith('https://e.org') ? 'own' : 'other', shown: true, ready: true, file: false, lazyAway: false }];
      if (fn.name === 'frameFacts') return { path: '#map-frame', name: 'Parcel map' };
      if (fn.name === 'controlsOutsideFrame') return { named: [], pointing: false };
      return undefined;
    },
  } as unknown as PageLike;
  const ctx = {
    page, url: 'https://e.org/p', pageIndex: 0, viewport: { width: 1280, height: 900 }, deadline: Date.now() + 45_000,
    signal: new AbortController().signal,
    guard: { events: [], mark: () => 0, since: () => [] },
    listeners: async () => [], hooks: async () => ({}),
  } as unknown as ProbeContext;
  return { ctx, calls };
}

describe('frames that never answer (keyboard-op fix round 1, F3)', () => {
  it('bounded: a call that never settles rejects with FrameTimeout after its time', async () => {
    const t = Date.now();
    await expect(bounded(50, never())).rejects.toBeInstanceOf(FrameTimeout);
    expect(Date.now() - t).toBeLessThan(1000);
    await expect(bounded(50, Promise.resolve(7))).resolves.toBe(7);
  });

  it('a same-site frame that never answers: 2.1.1 not testable for that frame alone, within a few calls\' time', async () => {
    const { ctx } = fake('https://e.org/map.html', (name) => (name === 'isHtmlDocument' ? Promise.resolve(true) : never()));
    const t = Date.now();
    const out = await frameClickables(ctx);
    expect(Date.now() - t).toBeLessThan(FRAME_CALL_MS * 3);
    expect(out.map((f) => [f.criterion, f.status, f.target])).toEqual([['2.1.1', 'not_testable', '#map-frame']]);
    expect(out[0]!.detail).toContain('its event listeners could not be read');
  }, 15_000);

  it('a frame on another site is never called into, not even to ask whether it has loaded', async () => {
    const { ctx, calls } = fake('https://maps.example.net/embed', () => never());
    const t = Date.now();
    expect(await frameClickables(ctx)).toEqual([]);
    expect(calls.filter((c) => c.startsWith('frame:'))).toEqual([]);
    expect(Date.now() - t).toBeLessThan(1000);
    expect(await settleFrames(ctx.page, 3000, { guard: ctx.guard })).toEqual([]);
  }, 15_000);
});
