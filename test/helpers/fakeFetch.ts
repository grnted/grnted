// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A fetch double for the document tests: scripted responses, every request recorded, abort honoured.

export type Handler = (req: { url: string; method: string; headers: Record<string, string> }) => Response | Promise<Response>;

/** A fetch double that records every request. */
export function fakeFetch(handler: Handler) {
  const calls: { url: string; method: string; headers: Record<string, string> }[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const req = { url: String(input), method: init?.method ?? 'GET', headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])) };
    calls.push(req);
    if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return await new Promise<Response>((resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      Promise.resolve(handler(req)).then(resolve, reject);
    });
  }) as typeof fetch;
  return { fn, calls };
}
