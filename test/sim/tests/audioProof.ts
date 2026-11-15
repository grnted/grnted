// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 1.4.2's proof (batch 18, lane media, the lead's ruling 12): the audio test fails a sound only when it is measured,
// started by itself, lasts more than 3 s and nothing left could stop it. The answer by construction, across the
// ways a page makes sound and the ways it offers to stop it:
// - sound: an <audio> element, a script's Audio(), Web Audio, an element routed through Web Audio, an <audio> inside
//   a web component's shadow root; looping or 6 s long;
// - failures (sound, more than 3 s, no way to stop it): no control at all, only unrelated named controls, or a
//   "Pause the sound" button that does nothing;
// - look-alikes (WCAG passes them): a sound switch, a Mute button in a web component, a nameless icon button that
//   pauses it, a button named "♫ Music: on", a volume slider, "Press M to mute" with the key working, and sound that
//   is not there (a silent file, an element routed to no speaker). The test tries the switch and the web component's
//   button (it can show they work); the other controls it does not try, so those pages are undecided, never failed.
import { audioProbe } from '../../../src/probes/audio.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';
import { toneWav } from './motionAudio.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'none'];

export const PROOF_KINDS = ['audio-element', 'script-audio', 'web-audio', 'routed', 'shadow'] as const;
export const PROOF_CONTROLS = ['none', 'unrelated', 'broken', 'switch', 'shadow-mute', 'icon', 'odd-name', 'slider', 'key', 'silent', 'routed-silent'] as const;
type PKind = (typeof PROOF_KINDS)[number];
type PControl = (typeof PROOF_CONTROLS)[number];

/** A mono 16-bit PCM WAV of silence (`seconds` long). */
export function silenceWav(seconds: number, rate = 8000): Uint8Array {
  const n = Math.round(seconds * rate);
  const buf = new Uint8Array(44 + n * 2);
  const dv = new DataView(buf.buffer);
  const str = (o: number, s: string) => { for (let i = 0; i < s.length; i++) buf[o + i] = s.charCodeAt(i); };
  str(0, 'RIFF'); dv.setUint32(4, 36 + n * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * 2, true); dv.setUint16(32, 2, true); dv.setUint16(34, 16, true); str(36, 'data'); dv.setUint32(40, n * 2, true);
  return buf;
}

export function audioProofCase(kind: PKind, seconds: number, control: PControl, rep: number, hazard: Hazard, seed: number): SimCase | null {
  // Sound that is not there: a silent file for the media kinds, an element routed to no speaker for the routed one.
  if (control === 'silent' && (kind === 'web-audio' || kind === 'routed')) return null;
  if (control === 'routed-silent' && kind !== 'routed') return null;
  const dur = Number.isFinite(seconds) ? `${seconds}s` : 'loop';
  const id = `audio-proof/${kind}/${dur}/${control}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const loop = !Number.isFinite(seconds);
  const len = loop ? 2 : seconds;
  const file = control === 'silent' ? '/silence.wav' : '/tone.wav';
  const files: Record<string, Uint8Array> = { '/tone.wav': toneWav(len, 300 + Math.round(r() * 300)), '/silence.wav': silenceWav(len) };
  const init: string[] = [];
  // window.__simSound: pause(), resume() and setVolume(v) on whatever makes the sound.
  let el = '';
  const media = (expr: string) => `window.__simSound = { pause: function () { ${expr}.pause(); }, resume: function () { ${expr}.play(); }, setVolume: function (v) { ${expr}.volume = v; } };`;
  switch (kind) {
    case 'audio-element':
      el = `<audio id="snd" src="${file}" autoplay${loop ? ' loop' : ''}></audio>`;
      init.push(media("document.getElementById('snd')"));
      break;
    case 'script-audio':
      init.push(`(function () { var a = new Audio('${file}'); a.loop = ${loop}; window.__simA = a; a.play().catch(function () {}); })();`, media('window.__simA'));
      break;
    case 'web-audio':
      init.push(`(function () { var C = window.AudioContext || window.webkitAudioContext; var ctx = new C(); var o = ctx.createOscillator(), g = ctx.createGain(); g.gain.value = 0.2; o.frequency.value = ${300 + Math.round(r() * 300)}; o.connect(g); g.connect(ctx.destination); o.start(); ${loop ? '' : `o.stop(ctx.currentTime + ${seconds});`} window.__simSound = { pause: function () { ctx.suspend(); }, resume: function () { ctx.resume(); }, setVolume: function (v) { g.gain.value = 0.2 * v; } }; })();`);
      break;
    case 'routed':
      el = `<audio id="snd" src="${file}" autoplay${loop ? ' loop' : ''}></audio>`;
      init.push(`(function () { var a = document.getElementById('snd'); var C = window.AudioContext || window.webkitAudioContext; var ctx = new C(); var s = ctx.createMediaElementSource(a); var g = ctx.createGain(); s.connect(g); ${control === 'routed-silent' ? '' : 'g.connect(ctx.destination);'} })();`, media("document.getElementById('snd')"));
      break;
    case 'shadow':
      el = '<sim-player></sim-player>';
      init.push(`customElements.define('sim-player', class extends HTMLElement { constructor() { super(); var root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<audio src="${file}" autoplay${loop ? ' loop' : ''}></audio>'; window.__simA = root.querySelector('audio'); } });`, media('window.__simA'));
      break;
  }
  // Controls without an element of the sound's own (script audio, Web Audio) sit in the page's header, the place a
  // site-wide sound control has; the others sit next to the sound.
  const elementless = kind === 'script-audio' || kind === 'web-audio';
  let ctl = '';
  let header = '';
  switch (control) {
    case 'unrelated':
      ctl = '<form role="search" action="/search"><label for="q">Search the site</label> <input id="q" name="q"> <button>Search</button></form><button type="button" aria-expanded="false">Opening hours</button>';
      break;
    case 'broken':
      ctl = '<button type="button" onclick="void 0">Pause the sound</button>';
      break;
    case 'switch':
      ctl = '<label><input type="checkbox" role="switch" checked onchange="this.checked ? window.__simSound.resume() : window.__simSound.pause()"> Background music</label>';
      break;
    case 'shadow-mute':
      ctl = '<sim-controls></sim-controls>';
      init.push("customElements.define('sim-controls', class extends HTMLElement { constructor() { super(); var root = this.attachShadow({ mode: 'open' }); root.innerHTML = '<button type=\"button\">Mute</button>'; root.querySelector('button').addEventListener('click', function () { window.__simSound.pause(); }); } });");
      break;
    case 'icon': {
      const b = '<button type="button" class="snd" onclick="window.__simSound.pause()"><svg aria-hidden="true" width="20" height="20"><rect width="20" height="20" fill="#00376d"/></svg></button>';
      if (elementless) header = b;
      else ctl = b;
      break;
    }
    case 'odd-name':
      ctl = '<button type="button" onclick="window.__simSound.pause(); this.textContent = \'♫ Music: off\'">♫ Music: on</button>';
      break;
    case 'slider': {
      const s = '<label for="vol">Level</label> <input type="range" id="vol" min="0" max="1" step="0.1" value="1" oninput="window.__simSound.setVolume(Number(this.value))">';
      if (elementless) header = s;
      else ctl = s;
      break;
    }
    case 'key':
      ctl = '<p>Press M to mute the music.</p>';
      init.push("document.addEventListener('keydown', function (e) { if (e.key === 'm' || e.key === 'M') window.__simSound.pause(); });");
      break;
    default:
      break;
  }
  const top = header ? `<header class="sim-bar">${header}</header>` : '';
  // The player and its control share a block, as a CMS's media block does.
  const pg = parts('Welcome', `${top}<p>Welcome to the visitor centre.</p><div class="sim-media">${el}${ctl}</div>${filler(r, 3)}`, [], init);
  Object.assign(pg.files, files);
  applyHazard(pg, hazard, r);
  const sound = control !== 'silent' && control !== 'routed-silent';
  const fails = sound && (control === 'none' || control === 'unrelated' || control === 'broken');
  return {
    id, test: 'audio-proof', hazard, params: { kind, seconds: dur, control },
    site: render(pg),
    expect: { '1.4.2': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: !sound ? `${control === 'silent' ? 'plays a silent file' : 'its sound reaches no speaker'}: no sound` : fails
      ? `plays ${dur} by itself with ${control === 'none' ? 'no control' : control === 'unrelated' ? 'only unrelated controls' : 'a pause button that does nothing'}`
      : `plays ${dur} with a working ${control} control${control === 'switch' || control === 'shadow-mute' ? '' : ' (not tried: undecided, never failed)'}`,
  };
}

export function audioProofCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const rep of [0, 1]) for (const k of PROOF_KINDS) for (const s of [6, Infinity]) for (const c of PROOF_CONTROLS) {
    const x = audioProofCase(k, s, c, rep, HAZARDS[i++ % HAZARDS.length]!, seed);
    if (x) out.push(x);
  }
  return out;
}

export const audioProofTest: SimTest = {
  id: 'audio-proof', criteria: ['1.4.2'], probes: () => [audioProbe], full: false, read: 'probe', readProbes: ['audio'], capMs: 90_000, cases: audioProofCases,
};
