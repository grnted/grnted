// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.3.1 Three Flashes or Below Threshold (probe `flash`, deep). The answer by construction:
// - a rectangle alternates between two states at f Hz (f flashes a second: 2f opposing changes);
// - general: black and white (a 100% luminance change, the darker state below 0.80);
//   red: saturated red (#f00) and the grey of the same luminance (#7f7f7f), so only the red-flash rule
//   can catch it (no luminance change), more than 0.2 apart in u'v';
// - its area is a share of the 10° field, which WCAG approximates as 341×256 px on 1024×768 and the
//   engine scales to the viewport (426.7×300 px at 1280×900; docs/scoring.md): the rectangle is 240 px
//   tall and as wide as the share needs, so it lies inside one field;
// - it fails exactly when f > 3 (more than three flashes in a second) and the share is above 25%.
// Mechanisms: a CSS animation, a script that restyles it, a canvas, an animated GIF, a video. GIF and
// video frame times are whole units (centiseconds, 1/30 s), so their real rate is computed from them.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { flashProbe } from '../../../src/probes/flash.js';
import { encodeGif } from '../../helpers/gifEncode.js';
import { applyHazard, filler, hash, parts, render, rng, solidPng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

export const FLASH_FREQS = [2.5, 3, 3.5, 4, 8] as const;
export const FLASH_AREAS = [20, 24, 26, 40] as const;
export const FLASH_MECHS = ['css', 'js', 'canvas', 'gif', 'video'] as const;
type Mech = (typeof FLASH_MECHS)[number];
type Kind = 'general' | 'red';

const VIEW = { width: 1280, height: 900 };
const FIELD = { w: (341 / 1024) * VIEW.width, h: (256 / 768) * VIEW.height };
const RECT_H = 240;

const COLORS: Record<Kind, [string, string, [number, number, number], [number, number, number]]> = {
  general: ['#000000', '#ffffff', [0, 0, 0], [255, 255, 255]],
  red: ['#ff0000', '#7f7f7f', [255, 0, 0], [127, 127, 127]],
};

/** The rate a mechanism really shows for an asked rate (GIF delays in centiseconds, video at 30 fps). */
export function realisedHz(mech: Mech, f: number): number {
  if (mech === 'gif') return 100 / (2 * Math.round(100 / (2 * f)));
  return f;
}

/** The hazards a flash case is crossed with, in turn. */
const HAZARDS: readonly Hazard[] = ['none', 'smooth-scroll', 'scroll-snap', 'lazy-images', 'late-mount', 'font-swap', 'cookie-banner', 'sticky-header', 'reduced-motion-honored', 'reduced-motion-ignored', 'animation-in-flight'];

// ---------------------------------------------------------------------------------------------
// Video: PNG frames piped into ffmpeg (SIM_FFMPEG or the one on PATH), VP9 WebM, 30 fps, 2 s loop. The
// ffmpeg Playwright ships has no PNG decoder, so it is not used; without ffmpeg the video cases are left out.

function findFfmpeg(): string | null {
  if (process.env.SIM_FFMPEG) return process.env.SIM_FFMPEG;
  for (const bin of ['/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg', '/usr/bin/ffmpeg']) if (existsSync(bin)) return bin;
  const which = spawnSync('which', ['ffmpeg'], { encoding: 'utf8' });
  return which.status === 0 && which.stdout.trim() ? which.stdout.trim() : null;
}

const videoCache = new Map<string, Uint8Array | null>();
/** A 2 s VP9 loop of a w×h rectangle alternating between two colours at f Hz (30 fps), or null without ffmpeg. */
export function flashVideo(f: number, kind: Kind, w: number, h: number): Uint8Array | null {
  const key = `${f}-${kind}-${w}x${h}`;
  if (videoCache.has(key)) return videoCache.get(key)!;
  const dir = join(tmpdir(), 'grnted-sim-video');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${key}.webm`);
  if (existsSync(file)) {
    const b = new Uint8Array(readFileSync(file));
    videoCache.set(key, b);
    return b;
  }
  const ff = findFfmpeg();
  if (!ff) { videoCache.set(key, null); return null; }
  const [, , a, b] = COLORS[kind];
  const pa = solidPng(w, h, a);
  const pb = solidPng(w, h, b);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < 60; i++) frames.push(Math.floor((i * 2 * f) / 30) % 2 ? pb : pa);
  const input = Buffer.concat(frames);
  const res = spawnSync(ff, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', '30', '-c:v', 'png', '-i', '-',
    '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', '30', '-deadline', 'realtime', '-pix_fmt', 'yuv420p', '-f', 'webm', file], { input, maxBuffer: 1 << 26 });
  const out = res.status === 0 && existsSync(file) ? new Uint8Array(readFileSync(file)) : null;
  videoCache.set(key, out);
  return out;
}

// ---------------------------------------------------------------------------------------------

export interface FlashParams {
  mech: Mech;
  freq: number;
  area: number;
  kind: Kind;
  place: 'top' | 'below';
  hazard: Hazard;
  /** Dense heavy text on the page (what smooth scrolling films racing past). */
  dense?: boolean;
  /** A slow, legal mover further down (makes the test scroll on a page with no flash below). */
  mover?: boolean;
}

export function flashCase(p: FlashParams, seed: number): SimCase | null {
  const id = `flash/${p.mech}/${p.freq}hz/${p.area}pct/${p.kind}/${p.place}/${p.hazard}${p.dense ? '/dense' : ''}${p.mover ? '/mover' : ''}`;
  const r = rng(hash(id) ^ seed);
  const w = Math.round(((p.area / 100) * FIELD.w * FIELD.h / RECT_H) * 100) / 100;
  const [ca, cb] = COLORS[p.kind];
  const f = realisedHz(p.mech, p.freq);
  const half = 1000 / (2 * f);
  const css: string[] = [];
  const init: string[] = [];
  const files: Record<string, Uint8Array> = {};
  const x = Math.round(24 + r() * 600);
  let el: string;
  const style = `width:${w}px;height:${RECT_H}px;margin-left:${x}px`;
  switch (p.mech) {
    case 'css':
      el = `<div id="flasher" class="flasher" role="img" aria-label="Test pattern" style="${style}"></div>`;
      css.push(`.flasher { background: ${ca}; animation: sim-flash ${(2 * half) / 1000}s steps(1, end) infinite; } @keyframes sim-flash { 0% { background: ${ca}; } 50% { background: ${cb}; } }`);
      break;
    case 'js':
      // The colour comes from the class only (an inline background would win over it and nothing would change).
      el = `<div id="flasher" class="a" role="img" aria-label="Test pattern" style="${style}"></div>`;
      init.push(`(function () { var el = document.getElementById('flasher'), on = -1, t0 = performance.now();
  setInterval(function () { var s = Math.floor((performance.now() - t0) / ${half}) % 2; if (s !== on) { on = s; el.className = s ? 'b' : 'a'; } }, 4); })();`);
      css.push(`#flasher.a { background: ${ca}; } #flasher.b { background: ${cb}; }`);
      break;
    case 'canvas':
      el = `<canvas id="flasher" role="img" aria-label="Test pattern" width="${Math.ceil(w)}" height="${RECT_H}" style="display:block;${style}"></canvas>`;
      init.push(`(function () { var c = document.getElementById('flasher'), g = c.getContext('2d'), t0 = performance.now();
  function step(t) { g.fillStyle = Math.floor((t - t0) / ${half}) % 2 ? '${cb}' : '${ca}'; g.fillRect(0, 0, c.width, c.height); requestAnimationFrame(step); }
  requestAnimationFrame(step); })();`);
      break;
    case 'gif': {
      const gw = Math.round(w);
      const [, , a, b] = COLORS[p.kind];
      const delayCs = Math.round(100 / (2 * p.freq));
      files['/flash.gif'] = encodeGif(gw, RECT_H, [a, b], [
        { pixels: new Uint8Array(gw * RECT_H).fill(0), delayCs },
        { pixels: new Uint8Array(gw * RECT_H).fill(1), delayCs },
      ]);
      el = `<img id="flasher" src="/flash.gif" alt="Test pattern" width="${gw}" height="${RECT_H}" style="display:block;margin-left:${x}px">`;
      break;
    }
    case 'video': {
      const vw = Math.round(w / 2) * 2;
      const v = flashVideo(p.freq, p.kind, vw, RECT_H);
      if (!v) return null;
      files['/flash.webm'] = v;
      el = `<video id="flasher" src="/flash.webm" autoplay muted loop playsinline width="${vw}" height="${RECT_H}" style="display:block;margin-left:${x}px"></video>`;
      break;
    }
  }
  const text = p.dense ? filler(r, 40, 60) : filler(r, p.place === 'below' ? 14 : 3);
  if (p.dense) css.push('main p { font: 900 22px/30px sans-serif; color: #000; }');
  const mover = p.mover ? '<div class="mover" aria-hidden="true"></div>' : '';
  if (p.mover) css.push('.mover { width: 160px; height: 40px; background: #1a4fa0; animation: sim-slide 4s linear infinite alternate; } @keyframes sim-slide { from { transform: translateX(0); } to { transform: translateX(400px); } }');
  const body = p.place === 'top'
    ? `<p>Our new sign.</p>\n${el}\n${text}${filler(r, 12)}${mover}`
    : `${text}\n${el}\n${filler(r, 8)}${mover}`;
  const pg = parts('Flashing sign', body, css, init);
  Object.assign(pg.files, files);
  const hz = applyHazard(pg, p.hazard, r);
  const fails = f > 3 && p.area > 25;
  // A video at exactly 3 Hz is not counted (the lead's ruling, 2026-11-07): the player's frame timing is
  // outside the page's control, and the browser can genuinely display 7 changes in under 1000 ms
  // (measured 983–999 ms on flash/video/3hz/26pct/general/top/sticky-header), so the strict WCAG
  // reading may fail it. JS- and CSS-driven exactly-3 Hz cases stay must-pass (the page controls
  // their timing).
  const videoAt3 = p.mech === 'video' && f === 3;
  return {
    id, test: 'flash', hazard: p.hazard,
    params: { mech: p.mech, freq: p.freq, realisedHz: Math.round(f * 1000) / 1000, area: p.area, kind: p.kind, place: p.place, ...(p.dense ? { dense: true } : {}), ...(p.mover ? { mover: true } : {}), ...(hz.mountMs ? { mountMs: hz.mountMs } : {}) },
    site: render(pg),
    expect: { '2.3.1': videoAt3 ? { verdict: 'any' } : fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: fails ? `${f.toFixed(2)} flashes a second (> 3) over ${p.area}% of a 10° field (> 25%)` : `${f.toFixed(2)} a second over ${p.area}% of the field: ${f > 3 ? '' : 'at most three flashes a second'}${f > 3 ? `area ${p.area}% is at most 25%` : ''}`,
  };
}

/**
 * Every mechanism × rate × area × kind (200), the place alternating and the hazards in turn, plus the
 * smooth-scrolling set: pages with no flash (or a legal one) that make the test scroll, with dense text
 * (the known false failure) and normal text, and real flashers far below on smooth-scrolling pages.
 */
export function flashCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const mech of FLASH_MECHS) {
    for (const freq of FLASH_FREQS) {
      for (const area of FLASH_AREAS) {
        for (const kind of ['general', 'red'] as const) {
          const place = (i >> 1) % 2 ? 'below' : 'top';
          const c = flashCase({ mech, freq, area, kind, place, hazard: HAZARDS[i % HAZARDS.length]! }, seed);
          i++;
          if (c) out.push(c);
        }
      }
    }
  }
  // Smooth scrolling (the test scrolls to moving content further down).
  for (const dense of [true, false]) {
    for (const mech of ['css', 'js'] as const) {
      for (const [freq, area] of [[2.5, 40], [3, 26], [8, 20], [4, 40], [8, 26]] as const) {
        const c = flashCase({ mech, freq, area, kind: 'general', place: 'below', hazard: 'smooth-scroll', dense, mover: true }, seed);
        if (c) out.push(c);
      }
    }
  }
  return out;
}

export const flashTest: SimTest = {
  id: 'flash',
  criteria: ['2.3.1'],
  probes: () => [flashProbe],
  full: true,
  read: 'probe',
  readProbes: ['flash'],
  capMs: 120_000,
  maxConcurrency: 1,
  cases: flashCases,
  knownIssue: 'Smooth scrolling animates the test\'s own scroll; fix/flash-smooth-scroll (another builder) owns it. On this base it shows as missed flashers below the fold on smooth-scrolling pages; the "flash @ 78fd65b2" rows are that branch.',
};
