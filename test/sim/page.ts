// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Building a case's page: a seeded random source, the page's parts, and the harness hazards real sites
// have (smooth scrolling, scroll snapping, lazy images, late mounting, a web font that swaps in, a cookie
// banner, a sticky header, prefers-reduced-motion honoured or not, an animation still running when the
// test looks). A hazard never changes the answer unless the generator says so: the generator places
// its subject where the hazard cannot reach it, or writes the hazard's effect into the expectation.
import { readFileSync } from 'node:fs';
import type { Hazard, SimRoute, SimSite } from './types.js';

/** mulberry32: a small seeded PRNG (deterministic across runs and machines). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A stable 32-bit hash of a string (seeds per case from the case id). */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

export const pick = <T>(r: () => number, xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!;
export const between = (r: () => number, lo: number, hi: number) => lo + (hi - lo) * r();

export interface PageParts {
  title: string;
  lang?: string;
  css: string[];
  /** The page has no level-1 heading of its own (headings cases); else the title is shown as one. */
  noH1?: boolean;
  /** The meta viewport's content (resize-text cases); default 'width=device-width, initial-scale=1'. */
  viewport?: string;
  /** The page's content (inside <main>, after the hazards' own header). */
  body: string;
  /** Scripts that set up the subject (run once its content is in the page, also when it mounts late). */
  init: string[];
  /** Extra markup outside <main> (banners, headers), before it. */
  before: string[];
  after: string[];
  head: string[];
  files: Record<string, string | Uint8Array>;
  routes: Record<string, SimRoute>;
}

export const parts = (title: string, body: string, css: string[] = [], init: string[] = []): PageParts => ({
  title, css, body, init, before: [], after: [], head: [], files: {}, routes: {},
});

const WORDS = 'agenda budget council meeting notice parks planning permit street transit water zoning library housing community commission minutes advisory'.split(' ');

/** Plain paragraphs of seeded text (dark on white, well above every contrast threshold). */
export function filler(r: () => number, paragraphs: number, words = 40): string {
  let out = '';
  for (let p = 0; p < paragraphs; p++) out += `<p>${Array.from({ length: words }, () => pick(r, WORDS)).join(' ')}.</p>\n`;
  return out;
}

let fontCache: Uint8Array | null = null;
/** A real web font from the engine's own assets (Archivo, OFL). */
export function webFont(): Uint8Array {
  fontCache ??= new Uint8Array(readFileSync(new URL('../../assets/fonts/archivo-latin.woff2', import.meta.url)));
  return fontCache;
}

/** 1×1-ish solid PNG (no compression library: a stored deflate block). */
export function solidPng(w: number, h: number, rgb: [number, number, number]): Uint8Array {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b: Uint8Array) => {
    let c = 0xffffffff;
    for (const x of b) c = crcTable[(c ^ x) & 255]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const chunk = (type: string, data: number[]) => {
    const t = [...type].map((c) => c.charCodeAt(0));
    const body = new Uint8Array([...t, ...data]);
    return [...u32(data.length), ...body, ...u32(crc(body))];
  };
  const raw: number[] = [];
  for (let y = 0; y < h; y++) { raw.push(0); for (let x = 0; x < w; x++) raw.push(...rgb); }
  // zlib: stored blocks of at most 65535 bytes, adler32 at the end.
  const z: number[] = [0x78, 0x01];
  for (let i = 0; i < raw.length; i += 65535) {
    const blk = raw.slice(i, i + 65535);
    const last = i + 65535 >= raw.length ? 1 : 0;
    z.push(last, blk.length & 255, blk.length >> 8, ~blk.length & 255, (~blk.length >> 8) & 255, ...blk);
  }
  let a = 1, b = 0;
  for (const x of raw) { a = (a + x) % 65521; b = (b + a) % 65521; }
  z.push(...u32(((b << 16) | a) >>> 0));
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...chunk('IHDR', [...u32(w), ...u32(h), 8, 2, 0, 0, 0]), ...chunk('IDAT', z), ...chunk('IEND', [])]);
}

/** What a hazard adds, and the knobs a generator reads to keep its subject clear of it. */
export interface HazardInfo {
  /** Viewport pixels a fixed bar covers at the top and bottom (subjects stay out of them). */
  topBar: number;
  bottomBar: number;
  /** The subject mounts this long after load (late-mount), else 0. */
  mountMs: number;
}

/**
 * Applies a hazard to the page. Generators call it last (it may wrap the content). Every hazard's own
 * content passes every check: dark text on white or white on dark, focusable things visible.
 */
export function applyHazard(p: PageParts, h: Hazard, r: () => number): HazardInfo {
  const info: HazardInfo = { topBar: 0, bottomBar: 0, mountMs: 0 };
  switch (h) {
    case 'none':
    case 'reduced-motion-ignored':
      break;
    case 'smooth-scroll':
      p.css.push('html, body { scroll-behavior: smooth; }');
      break;
    case 'scroll-snap':
      p.css.push('html { scroll-snap-type: y mandatory; } main > section, main > p, main > div { scroll-snap-align: start; }');
      break;
    case 'lazy-images': {
      p.files['/img/photo.png'] = solidPng(64, 40, [90, 110, 130]);
      p.routes['/img/photo.png'] = { body: p.files['/img/photo.png'], type: 'image/png', delayMs: 700 };
      p.after.push(`<section class="gallery" aria-label="Photos">${[1, 2, 3].map((i) => `<img src="/img/photo.png?${i}" loading="lazy" width="320" height="200" alt="Photo ${i} of the park">`).join('')}</section>`);
      p.css.push('.gallery { display: flex; flex-wrap: wrap; gap: 16px; padding: 16px; margin-top: 1200px; } .gallery img { display: block; max-width: 100%; height: auto; }');
      break;
    }
    case 'late-mount': {
      info.mountMs = Math.round(between(r, 1000, 2000));
      const content = p.body;
      const init = p.init;
      p.body = '<div id="sim-app" aria-busy="true"><p>Loading…</p></div>';
      p.init = [`setTimeout(function () {
  var app = document.getElementById('sim-app');
  app.innerHTML = document.getElementById('sim-late').innerHTML;
  app.removeAttribute('aria-busy');
  ${init.map((s) => `(function () { ${s} })();`).join('\n  ')}
}, ${info.mountMs});`];
      p.after.push(`<template id="sim-late">${content}</template>`);
      break;
    }
    case 'font-swap': {
      const font = webFont();
      p.routes['/fonts/sim.woff2'] = { body: font, type: 'font/woff2', delayMs: 1500 };
      p.css.unshift("@font-face { font-family: 'SimSans'; src: url('/fonts/sim.woff2') format('woff2'); font-display: swap; } body { font-family: 'SimSans', Georgia, serif; }");
      break;
    }
    case 'cookie-banner':
      info.bottomBar = 96;
      p.before.push(`<div class="sim-cookies" role="region" aria-label="Cookie notice"><p>We use cookies to run this site.</p><button type="button" onclick="this.parentNode.remove()">Accept</button></div>`);
      p.css.push('.sim-cookies { position: fixed; left: 0; right: 0; bottom: 0; height: 96px; box-sizing: border-box; padding: 16px 24px; display: flex; gap: 24px; align-items: center; background: #1b1b1b; color: #fff; z-index: 50; font: 16px/1.4 sans-serif; } .sim-cookies p { margin: 0; color: #fff; } .sim-cookies button { font: inherit; padding: 8px 16px; background: #fff; color: #000; border: 2px solid #fff; } .sim-cookies button:focus-visible { outline: 3px solid #ffbf47; outline-offset: 2px; }');
      p.css.push('body { padding-bottom: 96px; }');
      break;
    case 'load-popup':
      // A news alert opened on load (the shape the 2026-11-07 audit found: Magnific Popup with fixedContentPos
      // false): a fixed dark backdrop at 80% and an absolutely positioned wrap above it holding the alert, closed
      // by its own button. People close it, then read the page: the page behind it decides the verdict.
      p.after.push(`<div class="sim-pop-bg"></div><div class="sim-pop"><div class="sim-pop-box"><p class="sim-pop-title">Special meeting location</p><p>Tonight's work session moves to the district office.</p><button type="button" class="sim-pop-close" title="Close" onclick="document.querySelector('.sim-pop').remove();document.querySelector('.sim-pop-bg').remove();document.documentElement.classList.remove('sim-pop-open')">×</button></div></div>`);
      p.css.push('.sim-pop-bg { position: fixed; inset: 0; background: #0b0b0b; opacity: 0.8; z-index: 1042; } .sim-pop { position: absolute; top: 0; left: 0; right: 0; z-index: 1043; padding: 64px 16px; } .sim-pop-box { position: relative; max-width: 420px; margin: 0 auto; background: #fff; color: #1b1b1b; padding: 12px 48px 12px 16px; font: 16px/1.4 sans-serif; } .sim-pop-box p { margin: 0 0 6px; color: #1b1b1b; } .sim-pop-title { font-weight: 700; } .sim-pop-close { position: absolute; right: 4px; top: 4px; width: 40px; height: 40px; border: 2px solid #1b1b1b; background: #fff; color: #1b1b1b; font: 24px/1 sans-serif; } .sim-pop-close:focus-visible { outline: 3px solid #1b1b1b; outline-offset: 2px; } html.sim-pop-open { overflow: hidden; }');
      p.init.push("document.documentElement.classList.add('sim-pop-open');");
      break;
    case 'sticky-header':
      info.topBar = 64;
      p.before.push(`<header class="sim-header"><a href="#main">City of Example</a></header>`);
      p.css.push('.sim-header { position: fixed; top: 0; left: 0; right: 0; height: 64px; box-sizing: border-box; padding: 18px 24px; background: #fff; border-bottom: 1px solid #767676; z-index: 40; font: 18px/1.5 sans-serif; } .sim-header a { color: #00376d; } .sim-header a:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; } body { padding-top: 64px; } html { scroll-padding-top: 72px; }');
      break;
    case 'reduced-motion-honored':
      p.css.push('@media (prefers-reduced-motion: reduce) { *, *::before, *::after { animation: none !important; transition: none !important; } }');
      p.init.unshift("window.__simReduced = matchMedia('(prefers-reduced-motion: reduce)').matches;");
      break;
    case 'animation-in-flight':
      // A hero strip sliding in for 2.5 s from load (a common entrance animation; no flashing, no text).
      p.before.push('<div class="sim-hero" aria-hidden="true"></div>');
      p.css.push('.sim-hero { height: 24px; width: 40%; background: #2b5797; animation: sim-in 2.5s ease-out both; } @keyframes sim-in { from { transform: translateX(-100%); opacity: 0; } to { transform: none; opacity: 1; } }');
      break;
  }
  return info;
}

/** The page's HTML and the site to serve. */
export function render(p: PageParts): SimSite {
  const html = `<!doctype html>
<html lang="${p.lang ?? 'en'}">
<head><meta charset="utf-8"><meta name="viewport" content="${p.viewport ?? 'width=device-width, initial-scale=1'}"><title>${p.title}</title>
${p.head.join('\n')}
<style>
body { margin: 0; font: 16px/1.5 sans-serif; color: #1b1b1b; background: #fff; }
main { display: block; padding: 0 24px; }
h1 { margin: 16px 0; font-size: 28px; }
${p.css.join('\n')}
</style></head>
<body>
${p.before.join('\n')}
<main id="main">
${p.noH1 ? '' : `<h1>${p.title}</h1>\n`}${p.body}
</main>
${p.after.join('\n')}
${p.init.length ? `<script>\n${p.init.join('\n')}\n</script>` : ''}
</body>
</html>`;
  return { files: { ...p.files, '/': html }, routes: p.routes };
}
