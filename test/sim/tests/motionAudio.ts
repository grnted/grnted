// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.2 Pause, Stop, Hide (probe `motion`) and 1.4.2 Audio Control (probe `audio`). The answer by
// construction:
// - motion that starts by itself and lasts more than 5 s needs a working pause, stop or hide control
//   a keyboard can use: a CSS slide, a blink, a ticker, a script carousel and a canvas run for 3, 4.5,
//   5.5 or 8 s, or forever; the control is none, a working pause button, a working hide button, a
//   button that does nothing, or pausing on hover only (not a control a keyboard user has);
// - sound that plays by itself for more than 3 s needs a way to pause or stop it or set its volume:
//   an <audio> element, a script's Audio() and a Web Audio tone play for 2, 3, 3.5 or 6 s, or loop;
//   the control is none, the element's own controls, a working pause button or a button that does
//   nothing; muted or silent playback has no sound.
import { audioProbe } from '../../../src/probes/audio.js';
import { motionProbe } from '../../../src/probes/motion.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'scroll-snap', 'reduced-motion-ignored', 'none'];

// ---------------------------------------------------------------------------------------------
// Motion.

export const MOTION_KINDS = ['slide', 'blink', 'ticker', 'carousel', 'canvas', 'slide-reduced'] as const;
export const MOTION_DURATIONS = [3, 4.5, 5.5, 8, Infinity] as const;
export const MOTION_CONTROLS = ['none', 'pause', 'hide', 'broken', 'hover'] as const;
/**
 * Act-watch review r1, F6: a Close button in the moving box that hides it (a hide control); "Pause service alerts"
 * in the box (a pause verb with a site topic: never clicked, no verdict); an animation declared endless that the
 * page's script stops after 4 s (by the frame clock, no timer the test could run early).
 */
export const MOTION_EXTRA_CONTROLS = ['close', 'topic', 'self-stop'] as const;
type MKind = (typeof MOTION_KINDS)[number];
type MControl = (typeof MOTION_CONTROLS)[number] | (typeof MOTION_EXTRA_CONTROLS)[number];

export function motionCase(kind: MKind, seconds: number, control: MControl, hazard: Hazard, seed: number): SimCase {
  const dur = Number.isFinite(seconds) ? `${seconds}s` : 'forever';
  const id = `motion/${kind}/${dur}/${control}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const css: string[] = ['.mover-box { position: relative; width: 600px; max-width: 100%; height: 120px; overflow: hidden; background: #eef3f8; margin: 16px 0; }'];
  const init: string[] = [];
  const iter = Number.isFinite(seconds) ? 1 : 'infinite';
  // One "cycle" of each kind lasts this long; finite motion runs `seconds` in all.
  let el = '';
  switch (kind) {
    case 'slide':
    case 'slide-reduced': {
      const t = Number.isFinite(seconds) ? seconds : 4;
      el = '<div class="mover" id="mover"></div>';
      css.push(`.mover { position: absolute; top: 30px; left: 0; width: 120px; height: 60px; background: #00376d; animation: sim-move ${t}s linear ${iter} alternate both; } @keyframes sim-move { from { transform: translateX(0); } to { transform: translateX(440px); } }`);
      if (kind === 'slide-reduced') css.push('@media (prefers-reduced-motion: reduce) { .mover { animation: none; } }');
      break;
    }
    case 'blink': {
      const n = Number.isFinite(seconds) ? Math.round(seconds) : 'infinite';
      el = '<p class="mover" id="mover">Open house this Saturday</p>';
      css.push(`.mover { position: absolute; top: 40px; left: 16px; margin: 0; font: 700 24px Arial; color: #00376d; animation: sim-blink 1s steps(1, end) ${n} both; } @keyframes sim-blink { 0% { opacity: 1; } 50% { opacity: 0; } }`);
      break;
    }
    case 'ticker': {
      const t = Number.isFinite(seconds) ? seconds : 10;
      el = '<p class="mover" id="mover">Road closures: Main St, 2nd Ave and the bridge are closed for repairs this week.</p>';
      css.push(`.mover { position: absolute; top: 44px; left: 0; margin: 0; white-space: nowrap; font: 20px Arial; color: #1b1b1b; animation: sim-tick ${t}s linear ${iter} both; } @keyframes sim-tick { from { transform: translateX(600px); } to { transform: translateX(-100%); } }`);
      break;
    }
    case 'carousel': {
      // Slides change every 1.5 s; a finite carousel stops after `seconds`.
      el = `<div class="mover" id="mover">${[1, 2, 3].map((i) => `<p class="slide${i === 1 ? ' on' : ''}">Story ${i}: ${filler(r, 1, 6).replace(/<\/?p>/g, '')}</p>`).join('')}</div>`;
      css.push('.mover .slide { display: none; margin: 0; padding: 40px 16px; font: 20px Arial; } .mover .slide.on { display: block; }');
      init.push(`(function () { var i = 0, s = document.querySelectorAll('#mover .slide'), t0 = Date.now(), until = ${Number.isFinite(seconds) ? seconds * 1000 : 'Infinity'};
  window.__simTimer = setInterval(function () { if (window.__simPaused) return; if (Date.now() - t0 >= until) { clearInterval(window.__simTimer); return; } s[i].classList.remove('on'); i = (i + 1) % s.length; s[i].classList.add('on'); }, 1500); })();`);
      break;
    }
    case 'canvas':
      el = '<canvas class="mover" id="mover" width="600" height="120" role="img" aria-label="A moving wave"></canvas>';
      init.push(`(function () { var c = document.getElementById('mover'), g = c.getContext('2d'), t0 = performance.now(), until = ${Number.isFinite(seconds) ? seconds * 1000 : 'Infinity'};
  function step(t) { if (window.__simPaused) { requestAnimationFrame(step); return; } var e = t - t0; if (e > until) return; g.fillStyle = '#eef3f8'; g.fillRect(0, 0, 600, 120); g.fillStyle = '#00376d'; g.fillRect((e / 8) % 520, 30, 80, 60); requestAnimationFrame(step); }
  requestAnimationFrame(step); })();`);
      break;
  }
  let ctl = '';
  const pauseJs = "document.querySelectorAll('#mover, #mover *').forEach(function (e) { e.getAnimations().forEach(function (a) { a.pause(); }); }); window.__simPaused = true;";
  switch (control) {
    case 'pause': ctl = `<button type="button" onclick="${pauseJs}">Pause</button>`; break;
    case 'hide': ctl = `<button type="button" onclick="document.getElementById('box').hidden = true">Hide the banner</button>`; break;
    case 'broken': ctl = '<button type="button" onclick="void 0">Pause</button>'; break;
    case 'close': break;
    case 'topic': break;
    case 'self-stop': init.push(`(function () { var m = document.getElementById('mover'), t0 = performance.now();
  function step(t) { if (t - t0 > 4000) { m.style.animation = 'none'; window.__simPaused = true; return; } requestAnimationFrame(step); } requestAnimationFrame(step); })();`); break;
    case 'hover': css.push('.mover-box:hover .mover, .mover-box:hover .mover * { animation-play-state: paused; }'); init.push(`document.getElementById('box').addEventListener('mouseenter', function () { window.__simPaused = true; }); document.getElementById('box').addEventListener('mouseleave', function () { window.__simPaused = false; });`); break;
    case 'none': break;
  }
  // In the box itself: what closes or pauses it sits with it.
  const inBox = control === 'close' ? `<button type="button" class="box-ctl" onclick="document.getElementById('box').style.display = 'none'">${r() < 0.5 ? 'Close' : 'Dismiss'}</button>`
    : control === 'topic' ? `<button type="button" class="box-ctl" onclick="${pauseJs}">Pause service alerts</button>` : '';
  if (inBox) css.push('.box-ctl { position: absolute; right: 8px; top: 8px; z-index: 2; }');
  const body = `<p>News from the city.</p><div class="mover-box" id="box">${el}${inBox}</div>${ctl}${filler(r, 3)}`;
  const pg = parts('City news', body, css, init);
  applyHazard(pg, hazard, r);
  const long = seconds > 5 && control !== 'self-stop';
  const works = control === 'pause' || control === 'hide' || control === 'close';
  const fails = long && !works && control !== 'topic';
  return {
    id, test: 'motion', hazard, params: { kind, seconds: dur, control },
    site: render(pg),
    expect: { '2.2.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: control === 'self-stop' ? 'declared endless, stopped by its script after 4 s' : control === 'topic' ? `moves ${dur}; "Pause service alerts" in the box is never clicked (no verdict, never a failure)` : !long ? `moves for ${dur} (at most 5 s)` : works ? `moves ${dur} with a working ${control} control` : `moves ${dur} with ${control === 'none' ? 'no control' : control === 'hover' ? 'only a pause on hover' : 'a control that does nothing'}${kind === 'slide-reduced' ? ' (reduced motion stops it only for people who set it)' : ''}`,
  };
}

export function motionCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const k of MOTION_KINDS) for (const s of MOTION_DURATIONS) for (const c of MOTION_CONTROLS) out.push(motionCase(k, s, c, HAZARDS[i++ % HAZARDS.length]!, seed));
  // Review r1 F6: close and topic on the long ones (failing with no control), self-stop on the endless CSS ones.
  for (const k of MOTION_KINDS) for (const s of [8, Infinity]) for (const c of ['close', 'topic'] as const) out.push(motionCase(k, s, c, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const k of ['slide', 'blink', 'ticker', 'slide-reduced'] as const) out.push(motionCase(k, Infinity, 'self-stop', HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const motionTest: SimTest = {
  id: 'motion', criteria: ['2.2.2'], probes: () => [motionProbe], full: false, read: 'probe', readProbes: ['motion'], capMs: 120_000, cases: motionCases,
};

// ---------------------------------------------------------------------------------------------
// Audio.

/** A mono 16-bit PCM WAV of a sine tone (`seconds` long, quiet but audible). */
export function toneWav(seconds: number, hz = 440, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const buf = new Uint8Array(44 + n * 2);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) dv.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 8000), true);
  return buf;
}

export const AUDIO_KINDS = ['audio-element', 'script-audio', 'web-audio'] as const;
export const AUDIO_DURATIONS = [2, 3, 3.5, 6, Infinity] as const;
export const AUDIO_CONTROLS = ['none', 'native', 'pause', 'broken', 'muted'] as const;
type AKind = (typeof AUDIO_KINDS)[number];
type AControl = (typeof AUDIO_CONTROLS)[number];

export function audioCase(kind: AKind, seconds: number, control: AControl, rep: number, hazard: Hazard, seed: number): SimCase | null {
  if (kind === 'web-audio' && control === 'native') return null;
  const dur = Number.isFinite(seconds) ? `${seconds}s` : 'loop';
  const id = `audio/${kind}/${dur}/${control}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const files: Record<string, Uint8Array> = {};
  const init: string[] = [];
  let el = '';
  const loop = !Number.isFinite(seconds);
  const len = loop ? 2 : seconds;
  const muted = control === 'muted';
  if (kind !== 'web-audio') files['/tone.wav'] = toneWav(len, 300 + Math.round(r() * 300));
  if (kind === 'audio-element') {
    el = `<audio id="snd" src="/tone.wav" autoplay${loop ? ' loop' : ''}${control === 'native' ? ' controls' : ''}${muted ? ' muted' : ''}></audio>`;
  } else if (kind === 'script-audio') {
    if (control === 'native') el = '<div id="slot"></div>';
    init.push(`(function () { var a = new Audio('/tone.wav'); a.loop = ${loop}; a.muted = ${muted}; window.__simSound = a; ${control === 'native' ? "a.controls = true; document.getElementById('slot').appendChild(a);" : ''} a.play().catch(function () {}); })();`);
  } else {
    init.push(`(function () { var C = window.AudioContext || window.webkitAudioContext; var ctx = new C(); var o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = ${muted ? 0 : 0.2}; o.frequency.value = ${300 + Math.round(r() * 300)}; o.connect(g); g.connect(ctx.destination); o.start(); ${loop ? '' : `o.stop(ctx.currentTime + ${seconds});`} window.__simSound = { pause: function () { ctx.suspend(); } }; })();`);
  }
  let ctl = '';
  if (control === 'pause') ctl = `<button type="button" onclick="var s = document.getElementById('snd') || window.__simSound; s.pause();">Pause the sound</button>`;
  if (control === 'broken') ctl = '<button type="button" onclick="void 0">Pause the sound</button>';
  const pg = parts('Welcome', `<p>Welcome to the visitor centre.</p>${el}${ctl}${filler(r, 3)}`, [], init);
  Object.assign(pg.files, files);
  applyHazard(pg, hazard, r);
  const sound = !muted;
  const long = seconds > 3;
  const works = control === 'native' || control === 'pause';
  const fails = sound && long && !works;
  return {
    id, test: 'audio', hazard, params: { kind, seconds: dur, control },
    site: render(pg),
    expect: { '1.4.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: !sound ? 'plays muted (no sound)' : !long ? `plays ${dur} (at most 3 s)` : works ? `plays ${dur} with a working ${control} control` : `plays ${dur} by itself with ${control === 'none' ? 'no control' : 'a control that does nothing'}`,
  };
}

export function audioCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const rep of [0, 1, 2]) for (const k of AUDIO_KINDS) for (const s of AUDIO_DURATIONS) for (const c of AUDIO_CONTROLS) {
    const x = audioCase(k, s, c, rep, HAZARDS[i++ % HAZARDS.length]!, seed);
    if (x) out.push(x);
  }
  return out;
}

export const audioTest: SimTest = {
  id: 'audio', criteria: ['1.4.2'], probes: () => [audioProbe], full: false, read: 'probe', readProbes: ['audio'], capMs: 90_000, cases: audioCases,
};
