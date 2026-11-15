// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.1 Timing Adjustable (probe `timing` and axe `meta-refresh`) and 1.3.4 Orientation (probe
// `orientation` and axe `css-orientation-lock`), read from the criteria table.
//
// Source of truth. SC 2.2.1: "For each time limit that is set by the content, at least one of the
// following is true: Turn off …; Adjust …; Extend: The user is warned before time expires and given at
// least 20 seconds to extend the time limit with a simple action (for example, 'press the space bar'),
// and the user is allowed to extend the time limit at least ten times; Real-time exception …; Essential
// exception …; 20 hour exception: The time limit is longer than 20 hours." Failures F40 (meta redirect
// with a time limit), F41 (meta refresh to reload the page), F58 (redirecting after a time-out).
// SC 1.3.4: "Content does not restrict its view and operation to a single display orientation, such as
// portrait or landscape, unless a specific display orientation is essential." Failures F97 (locking the
// orientation to landscape or portrait view) and F100 (showing a message asking to reorient the device).
//
// 2.2.1, by construction (a delay D of 5 s to 2 h, or 21 h), on the shared motion page (the motion test runs
// the timers of 5 s early before the timing test):
// - fails: a script sends the page to /expired after D (also after a promise, or from a 0 ms timer the
//   D timer sets), reloads it after D, or warns "Your session will expire in 2 minutes" after D with no
//   control and logs out two minutes later; an alert() with that warning; a meta refresh to another page
//   or the same page after D s (D < 72 000);
// - passes: the same warning with a "Stay signed in" button that restarts both timers (Extend); a
//   confirm() "Your session is about to expire. Stay signed in?" that restarts them on OK (Extend); a page-wide "Turn off automatic sign-out" button
//   (Turn off); a redirect after 21 h (20-hour exception); timers that only update a clock or rotate a
//   tip, change a tip after a promise, or move to a section of the page from a 0 ms timer (no time limit).
// 1.3.4, by construction (a phone, 390×844 and 844×390):
// - fails: in one orientation (portrait or landscape) the main content is hidden and a full-screen "Please
//   rotate your device" message shown (F100, by CSS media query or by a script on resize); the page is
//   turned a quarter turn by CSS in that orientation (F97; axe css-orientation-lock); the main content is
//   hidden with no message;
// - passes: the layout changes but the content stays (one or two columns); a small "Best viewed in
//   landscape" hint above content that stays; navigation folded into a menu button in one orientation;
//   a table in landscape and the same data as cards in portrait.
import { motionActuationProbe } from '../../../src/probes/actuation.js';
import { audioProbe } from '../../../src/probes/audio.js';
import { motionProbe } from '../../../src/probes/motion.js';
import { orientationProbe } from '../../../src/probes/orientation.js';
import { timingProbe } from '../../../src/probes/timing.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'reduced-motion-honored'];
const PAGE_404 = '<!doctype html><html lang="en"><title>Signed out</title><main><h1>Signed out</h1></main></html>';

// ---------------------------------------------------------------------------------------------
// 2.2.1 Timing.

export const TIMING_DELAYS_S = [5, 60, 900, 7200] as const;
export const TIMING_FAIL = ['redirect', 'reload', 'warning-no-control', 'alert-warning', 'meta-redirect', 'meta-reload', 'async-redirect', 'nested-redirect'] as const;
export const TIMING_PASS = ['warning-extend', 'confirm-extend', 'turn-off', 'over-20h', 'clock', 'tips', 'async-tip', 'nested-hash'] as const;
/** Added after the others (their cases come last, so the earlier cases keep their ids). */
export const TIMING_FAIL_2 = ['expired-warning'] as const;
// 'event-countdown' (act-watch review r1, F7c): a countdown to an event, rewritten by a timer: no time limit.
export const TIMING_PASS_2 = ['notice', 'event-countdown'] as const;
type TimingKind = (typeof TIMING_FAIL)[number] | (typeof TIMING_PASS)[number] | (typeof TIMING_FAIL_2)[number] | (typeof TIMING_PASS_2)[number];

export function timingCase(kind: TimingKind, delayS: number, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `timing/${kind}/${delayS}s/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const ms = delayS * 1000;
  const init: string[] = [];
  const head: string[] = [];
  let html = '<p id="msg" role="status"></p>';
  const logout = `window.__out = setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000});`;
  switch (kind) {
    case 'redirect': init.push(`setTimeout(function () { location.href = '/expired'; }, ${ms});`); break;
    case 'reload': init.push(`setTimeout(function () { location.reload(); }, ${ms});`); break;
    case 'async-redirect': init.push(`setTimeout(async function () { await Promise.resolve(); location.href = '/expired'; }, ${ms});`); break;
    case 'nested-redirect': init.push(`setTimeout(function () { setTimeout(function () { location.href = '/expired'; }, 0); }, ${ms});`); break;
    case 'warning-no-control':
      init.push(`${logout} setTimeout(function () { document.getElementById('msg').textContent = 'Your session will expire in 2 minutes.'; }, ${ms});`);
      break;
    case 'expired-warning':
      init.push(`setTimeout(function () { var p = document.createElement('p'); p.setAttribute('role', 'alert'); p.textContent = 'Your session has expired. Sign in again to continue.'; document.getElementById('main').appendChild(p); }, ${ms});`);
      break;
    case 'event-countdown':
      html = `<p>${['The summer festival opens Saturday at noon.', 'Registration for fall classes opens soon.', 'The new library opens next month.'][rep % 3]} ${['Time remaining', 'Time left', 'Countdown, time remaining'][rep % 3]}: <span id="cd">3 days 04:10:00</span></p>`;
      init.push(`(function () { var n = 360000; setInterval(function () { n -= 1; document.getElementById('cd').textContent = Math.floor(n / 86400) + ' days ' + String(Math.floor(n / 3600) % 24).padStart(2, '0') + ':' + String(Math.floor(n / 60) % 60).padStart(2, '0') + ':' + String(n % 60).padStart(2, '0'); }, ${Math.min(ms, 1000)}); })();`);
      break;
    case 'notice':
      init.push(`setTimeout(function () { var p = document.createElement('p'); p.setAttribute('role', 'status'); p.textContent = 'New: the library is open until 8 pm on Thursdays.'; document.getElementById('main').appendChild(p); }, ${ms});`);
      break;
    case 'alert-warning':
      init.push(`${logout} setTimeout(function () { alert('Your session will expire in 2 minutes.'); }, ${ms});`);
      break;
    case 'meta-redirect': head.push(`<meta http-equiv="refresh" content="${delayS};url=/expired">`); break;
    case 'meta-reload': head.push(`<meta http-equiv="refresh" content="${delayS}">`); break;
    case 'warning-extend':
      html = '<div id="warn" hidden role="alertdialog" aria-labelledby="wt"><p id="wt">Your session will expire in 2 minutes.</p><button type="button" id="stay">Stay signed in</button></div>';
      init.push(`function arm() { clearTimeout(window.__warn); clearTimeout(window.__out); document.getElementById('warn').hidden = true;
  window.__warn = setTimeout(function () { document.getElementById('warn').hidden = false; }, ${ms});
  window.__out = setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000}); }
arm(); document.getElementById('stay').addEventListener('click', arm);`);
      break;
    case 'confirm-extend':
      init.push(`function arm() { clearTimeout(window.__out); window.__out = setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000});
  setTimeout(function () { if (confirm('Your session is about to expire. Stay signed in?')) arm(); }, ${ms}); }
arm();`);
      break;
    case 'turn-off':
      html = '<p><button type="button" id="off">Turn off automatic sign-out</button></p><p id="msg" role="status"></p>';
      init.push(`window.__out = setTimeout(function () { location.href = '/expired'; }, ${ms});
document.getElementById('off').addEventListener('click', function () { clearTimeout(window.__out); document.getElementById('msg').textContent = 'Automatic sign-out is off.'; });`);
      break;
    case 'over-20h': init.push(`setTimeout(function () { location.href = '/expired'; }, ${21 * 3600 * 1000});`); break;
    case 'clock':
      html = '<p>Local time: <span id="clock">12:00</span></p>';
      init.push(`setTimeout(function tick() { var d = new Date(); document.getElementById('clock').textContent = d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0'); setTimeout(tick, ${ms}); }, ${ms});`);
      break;
    case 'async-tip':
      html = '<p>Tip: <span id="tip">Pay your water bill online.</span></p>';
      init.push(`setTimeout(async function () { await Promise.resolve(); document.getElementById('tip').textContent = 'Library cards are free.'; }, ${ms});`);
      break;
    case 'nested-hash':
      html = '<p><a href="#hours">Opening hours</a></p><h2 id="hours">Hours</h2><p>Monday to Friday, 9 am to 6 pm.</p>';
      init.push(`setTimeout(function () { setTimeout(function () { location.hash = 'hours'; }, 0); }, ${ms});`);
      break;
    case 'tips':
      html = '<p>Tip: <span id="tip">Pay your water bill online.</span></p>';
      init.push(`var tips = ['Pay your water bill online.', 'Library cards are free.', 'Parks open at dawn.']; var ti = 0; setInterval(function () { ti = (ti + 1) % tips.length; document.getElementById('tip').textContent = tips[ti]; }, ${ms});`);
      break;
  }
  const pg = parts('Your account', `<p>Your account details.</p>${html}${filler(r, 2)}`, ['button { font: 16px Arial; } button:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; }'], init);
  pg.head.push(...head);
  pg.routes['/expired'] = { status: 200, type: 'text/html; charset=utf-8', body: PAGE_404 };
  applyHazard(pg, hazard, r);
  const fails = (TIMING_FAIL as readonly string[]).includes(kind) || (TIMING_FAIL_2 as readonly string[]).includes(kind);
  const WHY: Record<TimingKind, string> = {
    redirect: `a script leaves the page after ${delayS} s (F58)`, reload: `a script reloads the page after ${delayS} s`,
    'async-redirect': `a timer leaves the page after ${delayS} s, after a promise (F58)`, 'nested-redirect': `a timer leaves the page after ${delayS} s, from a 0 ms timer it sets (F58)`,
    'warning-no-control': `a session warning after ${delayS} s with no way to extend, then sign-out`, 'alert-warning': `an alert warns of the session ending after ${delayS} s, with no way to extend`,
    'meta-redirect': `meta refresh to another page after ${delayS} s (F40)`, 'meta-reload': `meta refresh reloads the page after ${delayS} s (F41)`,
    'warning-extend': 'a warning with a "Stay signed in" button that restarts the time (Extend)', 'confirm-extend': 'a confirm dialog that extends the session on OK (Extend)',
    'turn-off': 'a page-wide button turns automatic sign-out off (Turn off)', 'over-20h': 'a redirect after 21 hours (20-hour exception)',
    clock: 'a timer that updates a clock (no time limit)', tips: 'a timer that rotates a tip (no time limit)',
    'expired-warning': `a "Your session has expired" warning after ${delayS} s, with no way to extend`, notice: 'a timer that adds a notice (no time limit)',
    'async-tip': 'a timer that changes a tip after a promise (no time limit)', 'event-countdown': 'a timer that counts down to an event ("time remaining"): no time limit on the visitor', 'nested-hash': 'a timer that moves to a section of the page from a 0 ms timer (no time limit)',
  };
  return { id, test: 'timing', hazard, params: { kind, delayS }, site: render(pg), expect: { '2.2.1': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } }, why: WHY[kind] };
}

export function timingCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of TIMING_FAIL) for (const d of TIMING_DELAYS_S) for (let rep = 0; rep < 3; rep++) {
    if (rep === 2 && (d === 7200 || d === 900)) continue;
    out.push(timingCase(kind, d, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  for (const kind of TIMING_PASS) for (const d of TIMING_DELAYS_S) for (let rep = 0; rep < 3; rep++) {
    if (kind === 'over-20h' && (d !== 5 || rep === 2)) continue;
    if (rep === 2 && d >= 900) continue;
    out.push(timingCase(kind, d, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  }
  for (let rep = 2; rep < 8; rep++) out.push(timingCase('over-20h', 5, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const kind of [...TIMING_FAIL_2, ...TIMING_PASS_2]) for (const d of TIMING_DELAYS_S) for (let rep = 0; rep < (d === 5 ? 4 : 2); rep++) out.push(timingCase(kind, d, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const timingTest: SimTest = {
  // The motion page, as the registry runs it (timing last): the motion test runs timers of 1 to 20 s early
  // first, so the 5 s cases test what the timing test reads from those earlier runs.
  id: 'timing', criteria: ['2.2.1'], probes: () => [audioProbe, motionProbe, motionActuationProbe, timingProbe], full: false, read: 'criterion', capMs: 90_000, cases: timingCases,
};

// ---------------------------------------------------------------------------------------------
// 1.3.4 Orientation.

export const ORIENT_FAIL = ['css-rotate-message', 'js-rotate-message', 'css-quarter-turn', 'hidden-no-message'] as const;
export const ORIENT_PASS = ['columns', 'small-hint', 'nav-menu', 'table-or-cards', 'plain'] as const;
type OrientKind = (typeof ORIENT_FAIL)[number] | (typeof ORIENT_PASS)[number];

export function orientationCase(kind: OrientKind, locked: 'portrait' | 'landscape', rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `orientation/${kind}/${locked}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  // `locked`: the orientation the content works in; the other one is blocked.
  const other = locked === 'portrait' ? 'landscape' : 'portrait';
  const css: string[] = ['.rot { display: none; }'];
  const init: string[] = [];
  const before: string[] = [];
  let top = '';
  switch (kind) {
    case 'css-rotate-message':
      before.push(`<div class="rot" role="alert"><p>Please rotate your device to ${locked} to use this site.</p></div>`);
      css.push(`@media (orientation: ${other}) { main { display: none; } .rot { display: flex; position: fixed; inset: 0; align-items: center; justify-content: center; background: #1b1b1b; color: #fff; font: 20px Arial; padding: 24px; } .rot p { color: #fff; } }`);
      break;
    case 'js-rotate-message':
      before.push(`<div class="rot" id="rot" role="alert"><p>Please rotate your device to ${locked} to use this site.</p></div>`);
      css.push('.rot.on { display: flex; position: fixed; inset: 0; align-items: center; justify-content: center; background: #1b1b1b; color: #fff; font: 20px Arial; padding: 24px; } .rot p { color: #fff; } main.off { display: none; }');
      init.push(`function o() { var bad = ${other === 'landscape' ? 'innerWidth > innerHeight' : 'innerHeight > innerWidth'}; document.getElementById('rot').classList.toggle('on', bad); document.getElementById('main').classList.toggle('off', bad); } o(); addEventListener('resize', o);`);
      break;
    case 'css-quarter-turn':
      css.push(`@media (orientation: ${other}) { html { transform: rotate(90deg); transform-origin: top left; width: 100vh; height: 100vw; overflow-x: hidden; position: absolute; top: 0; left: 100%; } }`);
      break;
    case 'hidden-no-message':
      css.push(`@media (orientation: ${other}) { main { display: none; } }`);
      break;
    case 'columns':
      css.push('@media (orientation: landscape) { .cols { columns: 2; } }');
      break;
    case 'small-hint':
      top = `<p class="hint">Best viewed in ${locked}.</p>`;
      css.push(`.hint { display: none; font: 14px Arial; } @media (orientation: ${other}) { .hint { display: block; } }`);
      break;
    case 'nav-menu':
      before.push('<nav aria-label="Site"><button type="button" class="menu" aria-expanded="false">Menu</button><ul class="nav"><li><a href="#a">Parks</a></li><li><a href="#b">Streets</a></li><li><a href="#c">Water</a></li></ul></nav>');
      css.push(`.menu { display: none; } @media (orientation: ${other}) { .nav { display: none; } .menu { display: inline-block; font: 16px Arial; } } .nav a { color: #00376d; }`);
      break;
    case 'table-or-cards': {
      const rows = [['Parks', '912k'], ['Streets', '1.4m'], ['Water', '2.1m']];
      top = `<table class="tb"><caption>Budget</caption><tr><th scope="col">Service</th><th scope="col">Budget</th></tr>${rows.map(([a, b]) => `<tr><td>${a}</td><td>${b}</td></tr>`).join('')}</table><ul class="cards">${rows.map(([a, b]) => `<li>${a}: ${b}</li>`).join('')}</ul>`;
      css.push(`.cards { display: none; } @media (orientation: ${other}) { .tb { display: none; } .cards { display: block; } } td, th { border: 1px solid #555; padding: 4px; }`);
      break;
    }
    case 'plain':
      break;
  }
  const pg = parts('City news', `${top}<div class="cols">${filler(r, 4, 30)}</div>`, css, init);
  pg.before.push(...before);
  applyHazard(pg, hazard, r);
  const fails = (ORIENT_FAIL as readonly string[]).includes(kind);
  const WHY: Record<OrientKind, string> = {
    'css-rotate-message': `in ${other} the content is hidden behind "Please rotate your device" (F100, CSS)`,
    'js-rotate-message': `in ${other} a script hides the content behind "Please rotate your device" (F100)`,
    'css-quarter-turn': `in ${other} the page is turned 90° by CSS (F97)`, 'hidden-no-message': `in ${other} the main content is hidden`,
    columns: 'one or two columns, same content', 'small-hint': `a small "Best viewed in ${locked}" hint; the content stays`,
    'nav-menu': 'navigation folds into a menu button; the content stays', 'table-or-cards': 'a table or the same data as a list', plain: 'nothing changes',
  };
  return { id, test: 'orientation', hazard, params: { kind, works: locked }, site: render(pg), expect: { '1.3.4': fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } }, why: WHY[kind] };
}

export function orientationCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let i = 0;
  for (const kind of ORIENT_FAIL) for (const o of ['portrait', 'landscape'] as const) for (let rep = 0; rep < 7; rep++) out.push(orientationCase(kind, o, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  for (const kind of ORIENT_PASS) for (const o of ['portrait', 'landscape'] as const) for (let rep = 0; rep < 6; rep++) out.push(orientationCase(kind, o, rep, HAZARDS[i++ % HAZARDS.length]!, seed));
  return out;
}

export const orientationTest: SimTest = {
  id: 'orientation', criteria: ['1.3.4'], probes: () => [orientationProbe], full: false, read: 'criterion', capMs: 90_000, cases: orientationCases,
};
