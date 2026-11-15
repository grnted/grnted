// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Live screenshots for the live scan view (ScanOptions.liveShots): one first-screen JPEG per loaded
// width, taken right after the width's wireframe, small enough to stream. Observation only: nothing
// here changes what the scan measures, and every failure (time box, a failed screenshot, a page that
// will not scroll to the top, a JPEG over the cap) only means no shot. Engine core: no Node-only imports.
import type { CDPSessionLike, ContextLike, PageLike } from './types.js';
import { cdpSession } from './reconnect.js';

export const LIVE_SHOT_LIMITS = {
  /** Image width in px: the desktop viewport (1280 CSS px) is scaled down to 960 (0.75×); the phone (390) stays 1×. */
  width: { desktop: 960, mobile: 390 },
  quality: 60,
  /** A JPEG over `maxBytes` is taken once more at this quality, then dropped. */
  retryQuality: 35,
  maxBytes: 250_000,
  /** The whole capture: scroll to the top, measure, screenshot (and the one retry). */
  timeoutMs: 4000,
  /** The sink's write, before the width's viewport-done goes out without the shot. */
  sinkTimeoutMs: 5000,
  /** Largest CSS viewport pictured (sanity bound on what the page reports). */
  maxCss: 4096,
} as const;

/** A taken shot: the JPEG and its size in image px. */
export interface LiveShotCapture {
  jpeg: Uint8Array;
  w: number;
  h: number;
}

class Timeout extends Error {}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => undefined); // a late rejection after the time box must not go unhandled
  return Promise.race([
    p,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Timeout()), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Runs in the page: scrolls to the top at once (smooth scrolling ignored), then reports the client
 * width, the viewport height and where the page actually is. Untrusted; checked by the caller.
 */
export function liveShotInPage(): { w: number; h: number; x: number; y: number } {
  try {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' as ScrollBehavior });
  } catch {
    window.scrollTo(0, 0);
  }
  return { w: document.documentElement.clientWidth, h: window.innerHeight, x: window.scrollX, y: window.scrollY };
}

/** Width and height from a JPEG's frame header (SOF0–SOF15 bar DHT/JPG/DAC), or null when it isn't a JPEG. */
export function jpegSize(b: Uint8Array): { w: number; h: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1]!;
    if (m === 0xff) { i++; continue; }
    if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; }
    if (m === 0xd9 || m === 0xda) return null;
    const len = (b[i + 2]! << 8) | b[i + 3]!;
    if (len < 2) return null;
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      const h = (b[i + 5]! << 8) | b[i + 6]!;
      const w = (b[i + 7]! << 8) | b[i + 8]!;
      return w > 0 && h > 0 ? { w, h } : null;
    }
    i += 2 + len;
  }
  return null;
}

function fromBase64(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export interface LiveShotCaptureOptions {
  timeoutMs?: number;
  /** Lower than LIVE_SHOT_LIMITS.maxBytes only (tests). */
  maxBytes?: number;
}

/**
 * The first screen of `page` as the visitor sees it on arrival: the page is scrolled to the top, then
 * the viewport (CSS px [0, client width) × [0, viewport height)) is taken as a JPEG at
 * `LIVE_SHOT_LIMITS.width[viewport]` px wide. With a CDP session (`context.newCDPSession`) Chromium
 * scales the picture itself; without one it is taken at CSS size. Null on any failure or timeout.
 *
 * Mapping (the live view relies on it): a wireframe box at CSS (x, y, w, h) of the same width is at
 * (x, y, w, h) × (shot.w / wireframe.W) in the image; the image covers CSS y < shot.h × W / shot.w.
 */
export async function captureLiveShot(
  page: PageLike,
  context: ContextLike | undefined,
  viewport: 'desktop' | 'mobile',
  opts: LiveShotCaptureOptions = {},
): Promise<LiveShotCapture | null> {
  const L = LIVE_SHOT_LIMITS;
  const maxBytes = Math.min(L.maxBytes, opts.maxBytes ?? L.maxBytes);
  let cdp: CDPSessionLike | undefined;
  let abandoned = false;
  const job = (async (): Promise<LiveShotCapture | null> => {
    const raw = (await page.evaluate(liveShotInPage, undefined)) as unknown;
    if (!raw || typeof raw !== 'object') return null;
    const { w, h, x, y } = raw as Record<string, unknown>;
    if (![w, h, x, y].every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    // A page that stays scrolled (or lies about it): the wireframe's boxes would not line up.
    if (Math.abs(x as number) > 1 || Math.abs(y as number) > 1) return null;
    const cssW = Math.round(w as number);
    const cssH = Math.round(h as number);
    if (cssW < 1 || cssH < 1 || cssW > L.maxCss || cssH > L.maxCss) return null;
    const scale = Math.min(1, L.width[viewport] / cssW);
    const clip = { x: 0, y: 0, width: cssW, height: cssH };
    if (context?.newCDPSession) {
      try {
        cdp = await cdpSession(context, page);
      } catch {
        cdp = undefined;
      }
      if (abandoned) return null;
    }
    const take = async (quality: number): Promise<Uint8Array> => {
      if (cdp) {
        const r = (await cdp.send('Page.captureScreenshot', {
          format: 'jpeg', quality, clip: { ...clip, scale }, captureBeyondViewport: false, fromSurface: true,
        })) as { data?: unknown } | undefined;
        if (typeof r?.data !== 'string') throw new Error('No screenshot');
        return fromBase64(r.data);
      }
      return page.screenshot({ type: 'jpeg', quality, clip });
    };
    let jpeg = await take(L.quality);
    if (jpeg.byteLength > maxBytes && !abandoned) jpeg = await take(L.retryQuality);
    if (jpeg.byteLength > maxBytes) return null;
    const size = jpegSize(jpeg);
    if (!size) return null;
    return { jpeg, w: size.w, h: size.h };
  })();
  try {
    return await withTimeout(job, opts.timeoutMs ?? L.timeoutMs);
  } catch {
    return null;
  } finally {
    abandoned = true;
    // The session is let go in the background once the work behind it is done (never awaited here).
    void job.catch(() => null).finally(() => { void cdp?.detach?.().catch(() => undefined); });
  }
}
