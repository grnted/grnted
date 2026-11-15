// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A low-priority page turn (`Pace.page({ low: true })`, perf/split-tests): the optional coverage runs'
// loads take one, so they share the scan's one page limit (splitting the tests never puts more loads on
// the site at once) and give way to every load that is not optional.
import { describe, expect, it } from 'vitest';
import { createPace } from '../../src/pace.js';

const tick = () => new Promise<void>((r) => setImmediate(r));

describe('a low-priority page turn', () => {
  it('counts against the one page limit: never more turns at once than the limit, low ones included', async () => {
    const p = createPace({ concurrency: 2 });
    const a = await p.page({ low: true });
    const b = await p.page();
    let third = false;
    const c = p.page({ low: true }).then((s) => { third = true; return s; });
    await tick();
    expect(third).toBe(false);
    expect(p.pages().active).toBe(2);
    a.release();
    (await c).release();
    b.release();
  });

  it('gives way to every turn that is not low, whatever order they asked in', async () => {
    const p = createPace({ concurrency: 1 });
    const first = await p.page();
    const order: string[] = [];
    const low1 = p.page({ low: true }).then((s) => { order.push('low1'); return s; });
    const low2 = p.page({ low: true }).then((s) => { order.push('low2'); return s; });
    const normal = p.page().then((s) => { order.push('normal'); return s; });
    await tick();
    first.release();
    (await normal).release();
    (await low1).release();
    (await low2).release();
    expect(order).toEqual(['normal', 'low1', 'low2']);
  });

  it('look-alike: turns that are not low keep their arrival order', async () => {
    const p = createPace({ concurrency: 1 });
    const first = await p.page();
    const order: string[] = [];
    const a = p.page().then((s) => { order.push('a'); return s; });
    const b = p.page().then((s) => { order.push('b'); return s; });
    await tick();
    first.release();
    (await a).release();
    (await b).release();
    expect(order).toEqual(['a', 'b']);
  });

  it('a stopped scan refuses a waiting low turn too', async () => {
    const p = createPace({ concurrency: 1 });
    await p.page();
    const waiting = p.page({ low: true });
    p.stop();
    await expect(waiting).rejects.toThrow('The scan stopped');
  });
});
