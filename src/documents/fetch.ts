// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Polite document requests: per-host concurrency, a per-request time box, manually followed
// redirects (each hop checked with `allowUrl`) and capped body reads. Works with any fetch
// (Node, Cloudflare Workers, a test double). Engine core: no Node-only imports.
import type { DocumentType } from '../types.js';
import { TIME_LIMIT_REACHED } from './pdf.js';
import { classifyHeaders, dispositionFileName, pdfHeaderOffset, sniffBytes } from './detect.js';
import { isNoTimeReason, isPaceReason } from '../pace.js';

export interface RequestContext {
  fetchFn: typeof fetch;
  userAgent: string;
  /** Hosted safety: every address, including each redirect target, must pass. */
  allowUrl?: (url: string) => Promise<boolean>;
  /** Time box for one request, body included. */
  timeoutMs: number;
  /** Redirects followed before giving up. */
  maxRedirects: number;
  /** Aborts every request (the scan's document time limit). */
  signal?: AbortSignal;
}

/** FIFO limiter: at most `limit` tasks at once per key (a host name). */
export class KeyedLimiter {
  private readonly active = new Map<string, number>();
  private readonly queues = new Map<string, (() => void)[]>();
  constructor(private readonly limit: number) {}

  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const n = this.active.get(key) ?? 0;
    if (n >= this.limit) {
      await new Promise<void>((resolve) => {
        const q = this.queues.get(key) ?? [];
        q.push(resolve);
        this.queues.set(key, q);
      });
    } else {
      this.active.set(key, n + 1);
    }
    try {
      return await fn();
    } finally {
      const next = this.queues.get(key)?.shift();
      if (next) next(); // the slot passes straight to the next task
      else this.active.set(key, (this.active.get(key) ?? 1) - 1);
    }
  }
}

export function hostOf(url: string): string {
  return new URL(url).hostname.toLowerCase();
}

/** `again`: the site's pace refused it (it asked us to slow down): a later run may get it. */
type Failure = { error: string; again?: true };

class RequestFailure extends Error {}

/**
 * One request with its own time box. Redirects are followed by hand (never more than
 * `maxRedirects`), each target checked with `allowUrl`. `read` consumes the final response.
 */
async function request<T>(
  url: string,
  method: 'HEAD' | 'GET',
  headers: Record<string, string>,
  ctx: RequestContext,
  read: (res: Response) => Promise<T>,
): Promise<T | Failure> {
  if (ctx.signal?.aborted) return { error: TIME_LIMIT_REACHED };
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, ctx.timeoutMs);
  const onAbort = () => controller.abort();
  ctx.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    let current = url;
    for (let hop = 0; ; hop++) {
      if (ctx.allowUrl && !(await ctx.allowUrl(current))) throw new RequestFailure('The address is not allowed');
      const res = await ctx.fetchFn(current, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { 'user-agent': ctx.userAgent, accept: '*/*', ...headers },
      });
      const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
      if (location) {
        await discard(res);
        if (hop >= ctx.maxRedirects) throw new RequestFailure(`More than ${ctx.maxRedirects} redirects`);
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new RequestFailure('Bad redirect');
        }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') throw new RequestFailure('Bad redirect');
        next.hash = '';
        current = next.href;
        continue;
      }
      return await read(res);
    }
  } catch (err) {
    if (err instanceof RequestFailure) return { error: err.message };
    // The scan's pace: stopped (the scan is over), no time left for the wait it asks for, or the site
    // asking to slow down. None of them is the document's own answer.
    if (err instanceof Error && err.name === 'ScanStopped') return { error: TIME_LIMIT_REACHED };
    if (err instanceof Error && isPaceReason(err.message)) return isNoTimeReason(err.message) ? { error: TIME_LIMIT_REACHED } : { error: err.message, again: true };
    if (timedOut) return { error: `Timed out after ${ctx.timeoutMs < 1000 ? `${ctx.timeoutMs} ms` : `${Math.round(ctx.timeoutMs / 1000)} s`}` };
    if (ctx.signal?.aborted) return { error: TIME_LIMIT_REACHED };
    return { error: 'Could not connect' };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener('abort', onAbort);
  }
}

async function discard(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // already closed
  }
}

/** Reads at most `max` bytes of the body, then cancels the rest. */
export async function readUpTo(res: Response, max: number): Promise<{ bytes: Uint8Array }> {
  if (!res.body) return { bytes: new Uint8Array(0) };
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const part = c.subarray(0, bytes.length - at);
    bytes.set(part, at);
    at += part.length;
    if (at >= bytes.length) break;
  }
  return { bytes };
}

export type ProbeResult =
  | { kind: 'document'; type: DocumentType }
  | { kind: 'html' }
  | { kind: 'other' }
  | { kind: 'error'; error: string };

const PROBE_BYTES = 1024;

/**
 * Asks the server what an address is: `HEAD` first, then a ranged `GET` (`Range: bytes=0-1023`)
 * when HEAD is refused or unhelpful (error status, a generic binary type, or HTML when
 * `confirmHtml` is set because some servers answer HEAD with HTML), sniffing the first bytes.
 */
export async function probeUrl(url: string, ctx: RequestContext, opts: { confirmHtml?: boolean } = {}): Promise<ProbeResult> {
  const head = await request(url, 'HEAD', {}, ctx, async (res) => {
    await discard(res);
    return { status: res.status, ok: res.ok, type: res.headers.get('content-type'), disposition: res.headers.get('content-disposition') };
  });
  if ('error' in head) {
    // A HEAD that failed outright (not allowed, redirect loop, time limit) will not do better as a GET.
    if (head.error !== 'Could not connect') return { kind: 'error', error: head.error };
  } else {
    if (head.status === 404 || head.status === 410) return { kind: 'error', error: `HTTP ${head.status}` };
    if (head.ok) {
      const h = classifyHeaders(head.type, head.disposition);
      if (h.kind === 'document' || h.kind === 'other') return h;
      if (h.kind === 'html' && !opts.confirmHtml) return h;
    }
  }
  const got = await request(url, 'GET', { range: `bytes=0-${PROBE_BYTES - 1}` }, ctx, async (res) => {
    if (!res.ok) {
      await discard(res);
      return { error: `HTTP ${res.status}` } as Failure;
    }
    const { bytes } = await readUpTo(res, PROBE_BYTES);
    return sniffBytes(bytes, res.headers.get('content-type'), res.headers.get('content-disposition'));
  });
  if ('error' in got) return { kind: 'error', error: got.error };
  return got.kind === 'unknown' ? { kind: 'other' } : got;
}

/**
 * `lastModified`: the response's Last-Modified header as an ISO date, when valid. `fileName` (batch 19): the file name
 * the server gives it (Content-Disposition), so a document served from /download/<token> can be told apart.
 */
export type Download = { bytes: Uint8Array; lastModified?: string; fileName?: string } | { html: true } | Failure;

/** The file name of a Content-Disposition header, its last path part only, at most 160 characters; '' when none. */
function servedName(header: string | null): string {
  const name = dispositionFileName(header).split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return name.slice(0, 160);
}

/**
 * Downloads a PDF, stopping at `maxBytes` (a larger file is not read). The result is the bytes
 * when they start like a PDF, `{ html: true }` for a web page, or a plain-language error.
 */
export async function downloadPdf(url: string, ctx: RequestContext, maxBytes: number): Promise<Download> {
  const mb = `${Math.round(maxBytes / 1024 / 1024)} MB`;
  return request(url, 'GET', {}, ctx, async (res): Promise<Download> => {
    if (!res.ok) {
      await discard(res);
      return { error: `Could not download it (HTTP ${res.status})`, ...(res.status === 429 || res.status === 503 ? { again: true as const } : {}) };
    }
    const length = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(length) && length > maxBytes) {
      await discard(res);
      return { error: `Larger than ${mb}, not downloaded` };
    }
    const { bytes } = await readUpTo(res, maxBytes + 1);
    if (bytes.length > maxBytes) return { error: `Larger than ${mb}, download stopped` };
    if (pdfHeaderOffset(bytes) >= 0) {
      const modified = Date.parse(res.headers.get('last-modified') ?? '');
      const fileName = servedName(res.headers.get('content-disposition'));
      return { bytes, ...(Number.isFinite(modified) ? { lastModified: new Date(modified).toISOString() } : {}), ...(fileName ? { fileName } : {}) };
    }
    const sniffed = sniffBytes(bytes.subarray(0, 1024), res.headers.get('content-type'), res.headers.get('content-disposition'));
    if (sniffed.kind === 'html') return { html: true };
    return { error: 'Not a PDF file' };
  });
}

/** The first bytes of an Office file: a zip (OOXML) or an OLE compound file (a legacy binary or an encrypted file). */
const isOfficeContainer = (b: Uint8Array) =>
  (b.length >= 4 && b[0] === 0x50 && b[1] === 0x4b && (b[2] === 3 || b[2] === 5)) || (b.length >= 4 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0);

/**
 * Downloads a Word, Excel or PowerPoint file, stopping at `maxBytes` (a larger file is not read). The
 * result is the bytes when they start like an Office container, `{ html: true }` for a web page, or a
 * plain-language error. What the container holds is for the quick checks to say (`documents/office.ts`).
 */
export async function downloadOffice(url: string, ctx: RequestContext, maxBytes: number): Promise<Download> {
  const mb = `${Math.round(maxBytes / 1024 / 1024)} MB`;
  return request(url, 'GET', {}, ctx, async (res): Promise<Download> => {
    if (!res.ok) {
      await discard(res);
      return { error: `Could not download it (HTTP ${res.status})`, ...(res.status === 429 || res.status === 503 ? { again: true as const } : {}) };
    }
    const length = Number(res.headers.get('content-length') ?? NaN);
    if (Number.isFinite(length) && length > maxBytes) {
      await discard(res);
      return { error: `Larger than ${mb}, not downloaded` };
    }
    const { bytes } = await readUpTo(res, maxBytes + 1);
    if (bytes.length > maxBytes) return { error: `Larger than ${mb}, download stopped` };
    if (isOfficeContainer(bytes)) {
      const fileName = servedName(res.headers.get('content-disposition'));
      return { bytes, ...(fileName ? { fileName } : {}) };
    }
    const sniffed = sniffBytes(bytes.subarray(0, 1024), res.headers.get('content-type'), res.headers.get('content-disposition'));
    if (sniffed.kind === 'html') return { html: true };
    return { error: 'Not a Word, Excel or PowerPoint file' };
  });
}
