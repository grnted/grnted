// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Signals that name the site's platform (src/platform.ts): the generator meta tag, the addresses of
// the page's own scripts, stylesheets, icons and images, and a few fixed DOM markers. Never link
// addresses (a site that links to a vendor is not built on it) and never page text. Desktop only, the
// first pages of the scan only (the template is the same on the rest). Engine core.
import type { PageCollector } from '../types.js';

export interface PlatformFacts {
  generator: string[];
  assets: string[];
  markers: string[];
}

/** Pages (by scan order) the collector runs on. */
export const PLATFORM_PAGES = 3;

/** Runs inside the page. Must be self-contained. Bounded: 3 generators, 60 asset addresses. */
export function collectPlatformFacts(): PlatformFacts {
  const clip = (s: string | null | undefined, max: number) => (s ?? '').trim().slice(0, max);
  const generator = [...document.querySelectorAll('meta[name="generator" i]')].map((m) => clip(m.getAttribute('content'), 200)).filter(Boolean).slice(0, 3);
  const assets: string[] = [];
  const seen = new Set<string>();
  const add = (u: string | null | undefined) => {
    if (!u || assets.length >= 60) return;
    const v = clip(u, 300);
    if (!/^https?:/i.test(v) || seen.has(v)) return;
    seen.add(v);
    assets.push(v);
  };
  for (const s of document.querySelectorAll('script[src]')) add((s as HTMLScriptElement).src);
  for (const l of document.querySelectorAll('link[rel~="stylesheet"][href], link[rel~="icon"][href], link[rel="preload"][href]')) add((l as HTMLLinkElement).href);
  for (const i of [...document.querySelectorAll('img')].slice(0, 20)) add((i as HTMLImageElement).currentSrc || (i as HTMLImageElement).src);
  const has = (sel: string) => {
    try {
      return document.querySelector(sel) !== null;
    } catch {
      return false;
    }
  };
  // Astro's scoped styles (data-astro-cid-<hash>): an attribute name no selector can match by prefix, so the first
  // elements' attribute names are read (bounded).
  const astroScoped = () => {
    const els = document.querySelectorAll('body *');
    for (let i = 0; i < Math.min(els.length, 2000); i++) {
      for (const a of Array.from(els[i]!.attributes)) if (a.name.startsWith('data-astro-cid-')) return true;
    }
    return false;
  };
  const markers = [
    has('[data-drupal-selector], [data-drupal-link-system-path]') ? 'drupal' : '',
    // DOM structure only: addresses (/wp-content/, /media/system/js/) are assets, matched on the site's own host.
    has('[class*="wp-block-"], #wpadminbar') ? 'wordpress' : '',
    has('[data-squarespace-cacheversion], .sqs-block') ? 'squarespace' : '',
    has('#SITE_CONTAINER, [data-mesh-id]') ? 'wix' : '',
    has('[class*="com-content-"]') ? 'joomla' : '',
    astroScoped() ? 'astro' : '',
  ].filter(Boolean);
  return { generator, assets, markers };
}

export const platformCollector: PageCollector<PlatformFacts | null> = {
  id: 'platform',
  viewport: 'desktop',
  timeoutMs: 2000,
  collect: async (page, ctx) => ((ctx.index ?? 0) < PLATFORM_PAGES ? page.evaluate(collectPlatformFacts, undefined) : null),
};
