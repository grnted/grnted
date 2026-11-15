// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A test that presses, drags or types runs with the page's own downloads stopped (`noDownloads.ts`): a file a
// script makes and saves by clicking a link of its own sends nothing over the network, so the request guard
// cannot see it. The browser context refuses downloads as well (the runner opens every test context with
// `acceptDownloads: false`); this is the layer in the page. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import { DOWNLOAD_STOP_KEY, stopDownloads, undoDownloadStop } from './noDownloads.js';
import { ProbeNotTestable, type ProbeContext } from './types.js';

/** `run` with downloads stopped in the page for as long as it runs. A page that will not take the stop is not pressed. */
export function withoutDownloads(run: (ctx: ProbeContext) => Promise<ProbeFinding[]>): (ctx: ProbeContext) => Promise<ProbeFinding[]> {
  return async (ctx) => {
    if (!(await ctx.page.evaluate(stopDownloads, DOWNLOAD_STOP_KEY).catch(() => false))) throw new ProbeNotTestable('the test could not make sure that no click saves a file on this page');
    try {
      return await run(ctx);
    } finally {
      await ctx.page.evaluate(undoDownloadStop, DOWNLOAD_STOP_KEY).catch(() => {});
    }
  };
}
