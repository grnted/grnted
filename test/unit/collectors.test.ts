// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { fakeMark } from '../helpers/marks.js';
import { auditPage } from '../../src/audit.js';
import { collectedValue, imagesCollector, isCollectorError, uniqueCollectors } from '../../src/collect/index.js';
import type { BrowserLike, PageCollector } from '../../src/types.js';

function fakeBrowser(): BrowserLike {
  return {
    async newContext(opts: { viewport: { width: number } }) {
      return {
        async newPage() {
          let at = '';
          return {
            async goto(u: string) { at = u; return { status: () => 200, url: () => u, headers: () => ({ 'content-type': 'text/html' }) }; },
            async evaluate(fn: unknown, arg?: unknown) {
              const name = (fn as { name?: string }).name ?? '';
              if (name === 'pageFacts' || name === 'readMark') return fakeMark(name, arg, at);
              if (name === 'runAxeInPage') return { violations: [], incomplete: [], passes: ['image-alt'], inapplicable: [] };
              if (name === 'collectImages') return [{ src: 'https://e.org/a.png', alt: 'A', width: 100, height: 80 }];
              if (name === 'readWidth') return opts.viewport.width;
              return [];
            },
            async addScriptTag() {},
            async waitForTimeout() {},
            async close() {},
          };
        },
        async close() {},
      };
    },
  } as unknown as BrowserLike;
}

function readWidth(): number {
  return window.innerWidth;
}
const width: PageCollector<number> = { id: 'width', viewport: 'both', collect: (page) => page.evaluate(readWidth, undefined) };
const throws: PageCollector = { id: 'throws', viewport: 'desktop', async collect() { throw new Error('in-page script failed\nstack'); } };
const hangs: PageCollector = { id: 'hangs', viewport: 'mobile', timeoutMs: 20, collect: () => new Promise(() => {}) };

describe('page collectors', () => {
  it('runs collectors at their viewports; a throwing or hanging collector does not fail the page', async () => {
    const page = await auditPage(fakeBrowser(), 'https://e.org/', { userAgent: 'UA', axeSource: '', collectors: [imagesCollector, width, throws, hangs] });
    expect(page.status).toBe('ok');
    expect(page.collected).toEqual({
      images: [{ page: 'https://e.org/', src: 'https://e.org/a.png', alt: 'A', width: 100, height: 80 }],
      width: { desktop: 1280, mobile: 390 },
      throws: { error: 'in-page script failed' },
      hangs: { error: 'Collector timed out after 20 ms' },
    });
    expect(collectedValue(page, imagesCollector)).toHaveLength(1);
    expect(collectedValue(page, width, 'mobile')).toBe(390);
    expect(collectedValue(page, width)).toBeUndefined();
    expect(collectedValue(page, throws)).toBeUndefined();
    expect(isCollectorError(page.collected!.throws)).toBe(true);
  });
  it('passes the page index in the scan order to collectors', async () => {
    const index: PageCollector<number | undefined> = { id: 'index', viewport: 'both', collect: async (_, ctx) => ctx.index };
    expect((await auditPage(fakeBrowser(), 'https://e.org/', { userAgent: 'UA', axeSource: '', collectors: [index], index: 7 })).collected).toEqual({ index: { desktop: 7, mobile: 7 } });
    expect((await auditPage(fakeBrowser(), 'https://e.org/', { userAgent: 'UA', axeSource: '', collectors: [index] })).collected).toEqual({ index: { desktop: undefined, mobile: undefined } });
  });
  it('leaves collected out when no collectors ran, and runs each id once', async () => {
    const page = await auditPage(fakeBrowser(), 'https://e.org/', { userAgent: 'UA', axeSource: '' });
    expect(page.collected).toBeUndefined();
    expect(uniqueCollectors([imagesCollector, width, { ...imagesCollector }]).map((c) => c.id)).toEqual(['images', 'width']);
  });
});
