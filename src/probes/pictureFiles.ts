// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Picture files as the browser received them (batch 18, lane images; the lead's route for picture-text's read of SVG
// files, 2026-11-13). picture-text measures an SVG file's own words from the file the page was given. It read that
// file from the browser's resource record (CDP Page.getResourceContent), which it skips when the record has no size
// yet, and then from the page's stored copy (`fetch(..., { cache: 'only-if-cached' })`), which races the browser's
// asynchronous cache write: on one test site the read missed in 1 run of 4 and 1.1.1 went not testable. Here the
// bodies of SVG responses are taken when they arrive, into a bounded store per page keyed by address: the file the
// page was given, read once, with no request of its own. The resource record and the stored copy stay as fallbacks
// for files that arrived before the store listened (or were served from memory), and the run says which path served
// each file. Engine core: no Node-only imports.
import type { PageLike, RequestLike, SubresourceResponseLike } from '../types.js';

export const PICTURE_FILE_LIMITS = {
  /** SVG files kept per page load, and the bytes of one (a larger one is 'too-large', never read). */
  files: 40,
  bytes: 1_000_000,
  /** Bytes kept per page load in all. */
  total: 8_000_000,
} as const;

/**
 * A kept file: its text, how many responses the page was given for its address on this load, and whether every one of
 * them was the same file (so a picture shows that file, however many times it was loaded); or why it was not kept.
 */
export type KeptFile = { source: string; responses: number; identical: boolean } | { error: 'too-large' | 'unread' };

export interface PictureFileStore {
  /** The SVG file the page was given at this address on this load, once its body has arrived; undefined when none was kept. */
  get(url: string): Promise<KeptFile | undefined>;
  /** A new load of the page: what was kept is forgotten. */
  reset(): void;
}

const SVG_TYPE = /image\/svg\+xml/i;
const safe = <T>(fn: () => T): T | undefined => { try { return fn(); } catch { return undefined; } };

/**
 * Starts keeping the SVG response bodies `page` receives (image requests answered 2xx with an SVG type, not larger than
 * `limits.bytes` by their declared length, at most `limits.files` per load). The body is read when it arrives, as the
 * page received it (Playwright `response.body()`); a body over the limit once read is 'too-large'. Undefined when the
 * page cannot report responses. Never throws.
 */
export function watchPictureFiles(page: PageLike, limits: { files: number; bytes: number; total: number } = PICTURE_FILE_LIMITS): PictureFileStore | undefined {
  if (typeof page.on !== 'function') return undefined;
  let kept = new Map<string, Promise<KeptFile>>();
  let bytes = 0;
  let load = 0;
  try {
    page.on('response', (res: SubresourceResponseLike) => {
      try {
        const req: RequestLike = res.request();
        if (safe(() => req.resourceType()) !== 'image') return;
        const status = res.status();
        if (status < 200 || status >= 300 || status === 204) return;
        const headers = res.headers();
        if (!SVG_TYPE.test(headers['content-type'] ?? '')) return;
        const url = res.url();
        const before = kept.get(url);
        if (typeof res.body !== 'function' || (!before && kept.size >= limits.files)) return;
        const declared = Number(headers['content-length']);
        if (Number.isFinite(declared) && declared > limits.bytes) { kept.set(url, Promise.resolve({ error: 'too-large' })); return; }
        const mine = load;
        const body = res.body().then((b): KeptFile => {
          if (b.byteLength > limits.bytes) return { error: 'too-large' };
          if (mine !== load || bytes + b.byteLength > limits.total) return { error: 'unread' };
          bytes += b.byteLength;
          return { source: new TextDecoder('utf-8').decode(b), responses: 1, identical: true };
        }, (): KeptFile => ({ error: 'unread' }));
        // The same address answered again on this load: the latest file, and whether every answer was that same file.
        kept.set(url, before ? Promise.all([before, body]).then(([a, b]): KeptFile => ('source' in a && 'source' in b
          ? { source: b.source, responses: a.responses + 1, identical: a.identical && a.source === b.source }
          : { error: 'error' in b ? b.error : 'unread' })) : body);
      } catch {
        // A response the browser could not describe (the page closing): nothing kept.
      }
    });
  } catch {
    return undefined;
  }
  return {
    async get(url) {
      return kept.get(url);
    },
    reset() {
      load++;
      kept = new Map();
      bytes = 0;
    },
  };
}
