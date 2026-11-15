// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import { KeyedLimiter, downloadPdf, probeUrl, type RequestContext } from '../../src/documents/fetch.js';
import { fakeFetch } from '../helpers/fakeFetch.js';

const PDF = new TextEncoder().encode('%PDF-1.7\n1 0 obj\n');
const ctxFor = (fn: typeof fetch, over: Partial<RequestContext> = {}): RequestContext =>
  ({ fetchFn: fn, userAgent: 'grnted-test', timeoutMs: 10_000, maxRedirects: 5, ...over });

describe('probeUrl', () => {
  it('trusts a HEAD that names a document type, with the scan user agent', async () => {
    const f = fakeFetch(() => new Response(null, { headers: { 'content-type': 'application/pdf' } }));
    expect(await probeUrl('https://e.org/download/a', ctxFor(f.fn))).toEqual({ kind: 'document', type: 'pdf' });
    expect(f.calls).toEqual([{ url: 'https://e.org/download/a', method: 'HEAD', headers: expect.objectContaining({ 'user-agent': 'grnted-test' }) }]);
  });

  it('falls back to a ranged GET when HEAD is refused, and sniffs the first bytes', async () => {
    const f = fakeFetch(({ method }) => (method === 'HEAD'
      ? new Response(null, { status: 405 })
      : new Response(PDF, { status: 206, headers: { 'content-type': 'application/octet-stream' } })));
    expect(await probeUrl('https://e.org/download/b', ctxFor(f.fn))).toEqual({ kind: 'document', type: 'pdf' });
    expect(f.calls.map((c) => [c.method, c.headers.range])).toEqual([['HEAD', undefined], ['GET', 'bytes=0-1023']]);
  });

  it('a generic binary type on HEAD needs the bytes; a server that ignores Range is read only 1 KB', async () => {
    let pulled = 0;
    const big = new ReadableStream<Uint8Array>({
      pull(c) {
        pulled++;
        c.enqueue(pulled === 1 ? PDF : new Uint8Array(64 * 1024));
        if (pulled > 100) c.close();
      },
    });
    const f = fakeFetch(({ method }) => (method === 'HEAD'
      ? new Response(null, { headers: { 'content-type': 'application/octet-stream' } })
      : new Response(big, { status: 200 })));
    expect(await probeUrl('https://e.org/files/c', ctxFor(f.fn))).toEqual({ kind: 'document', type: 'pdf' });
    expect(pulled).toBeLessThan(5);
  });

  it('HEAD saying HTML is believed, unless the caller asks to confirm it', async () => {
    const f = fakeFetch(({ method }) => (method === 'HEAD'
      ? new Response(null, { headers: { 'content-type': 'text/html' } })
      : new Response(PDF, { headers: { 'content-type': 'application/pdf' } })));
    expect(await probeUrl('https://e.org/x', ctxFor(f.fn))).toEqual({ kind: 'html' });
    expect(await probeUrl('https://e.org/download/x', ctxFor(f.fn), { confirmHtml: true })).toEqual({ kind: 'document', type: 'pdf' });
  });

  it('a 404 is not a document and is not retried', async () => {
    const f = fakeFetch(() => new Response(null, { status: 404 }));
    expect(await probeUrl('https://e.org/gone', ctxFor(f.fn))).toEqual({ kind: 'error', error: 'HTTP 404' });
    expect(f.calls).toHaveLength(1);
  });

  it('follows up to 5 redirects, never more', async () => {
    const chain = (n: number) => fakeFetch(({ url }) => {
      const hop = Number(new URL(url).searchParams.get('h') ?? 0);
      return hop < n
        ? new Response(null, { status: 302, headers: { location: `/r?h=${hop + 1}` } })
        : new Response(null, { headers: { 'content-type': 'application/pdf' } });
    });
    const five = chain(5);
    expect(await probeUrl('https://e.org/r', ctxFor(five.fn))).toEqual({ kind: 'document', type: 'pdf' });
    expect(five.calls).toHaveLength(6);
    const six = chain(6);
    expect(await probeUrl('https://e.org/r', ctxFor(six.fn))).toEqual({ kind: 'error', error: 'More than 5 redirects' });
    expect(six.calls).toHaveLength(6);
  });

  it('checks every redirect target with allowUrl (hosted safety)', async () => {
    const f = fakeFetch(({ url }) => (url.includes('internal')
      ? new Response(PDF, { headers: { 'content-type': 'application/pdf' } })
      : new Response(null, { status: 301, headers: { location: 'http://internal.local/secret.pdf' } })));
    const allowUrl = async (u: string) => !u.includes('internal');
    expect(await probeUrl('https://e.org/go', ctxFor(f.fn, { allowUrl }))).toEqual({ kind: 'error', error: 'The address is not allowed' });
    expect(f.calls.map((c) => c.url)).toEqual(['https://e.org/go']);
  });

  it('times out a slow server', async () => {
    const f = fakeFetch(() => new Promise<Response>(() => {}));
    expect(await probeUrl('https://e.org/slow', ctxFor(f.fn, { timeoutMs: 30 }))).toEqual({ kind: 'error', error: 'Timed out after 30 ms' });
  });
});

describe('downloadPdf', () => {
  it('returns the bytes of a PDF', async () => {
    const f = fakeFetch(() => new Response(PDF, { headers: { 'content-type': 'application/octet-stream' } }));
    const got = await downloadPdf('https://e.org/a', ctxFor(f.fn), 1000);
    expect('bytes' in got && new TextDecoder().decode(got.bytes)).toBe(new TextDecoder().decode(PDF));
  });

  it('refuses a file larger than the cap, by Content-Length or while streaming', async () => {
    const declared = fakeFetch(() => new Response(PDF, { headers: { 'content-length': '5000000' } }));
    expect(await downloadPdf('https://e.org/a', ctxFor(declared.fn), 1024 * 1024)).toEqual({ error: 'Larger than 1 MB, not downloaded' });
    const streamed = fakeFetch(() => new Response(new Uint8Array(2 * 1024 * 1024)));
    expect(await downloadPdf('https://e.org/a', ctxFor(streamed.fn), 1024 * 1024)).toEqual({ error: 'Larger than 1 MB, download stopped' });
  });

  it('tells a web page and other files apart from a PDF', async () => {
    const html = fakeFetch(() => new Response('<!doctype html><title>Sign in</title>', { headers: { 'content-type': 'text/html' } }));
    expect(await downloadPdf('https://e.org/a', ctxFor(html.fn), 1000)).toEqual({ html: true });
    const other = fakeFetch(() => new Response('GIF89a', { headers: { 'content-type': 'application/pdf' } }));
    expect(await downloadPdf('https://e.org/a', ctxFor(other.fn), 1000)).toEqual({ error: 'Not a PDF file' });
    const missing = fakeFetch(() => new Response('nope', { status: 404 }));
    expect(await downloadPdf('https://e.org/a', ctxFor(missing.fn), 1000)).toEqual({ error: 'Could not download it (HTTP 404)' });
  });
});

describe('KeyedLimiter', () => {
  it('runs at most N tasks at once per key, in order', async () => {
    const limiter = new KeyedLimiter(2);
    let active = 0;
    let peak = 0;
    const order: number[] = [];
    const task = (i: number) => limiter.run('e.org', async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      order.push(i);
      active--;
    });
    let other = 0;
    await Promise.all([...[0, 1, 2, 3, 4].map(task), limiter.run('other.org', async () => { other = active; })]);
    expect(peak).toBe(2);
    expect(order).toEqual([0, 1, 2, 3, 4]);
    expect(other).toBe(2); // another host is not held up
  });
});
