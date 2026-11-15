// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 2.2.1 precision audit (batch 17, item 8): a FAILED must show a time limit on what the visitor is doing that cannot be
// turned off, adjusted or extended. The answer by construction (what a careful auditor says of the page):
// - path "limit seen": fail when the page is seen ending the visit (it signs out or reloads, or says the session HAS
//   expired) with nothing to extend; pass when it only warns that a session will end (nothing ends), when the
//   warning's own button may extend it (one the test does not press), when it offered "Stay signed in" before
//   saying it expired, or when the words are a notice taking turns in a carousel;
// - path "timer submits": fail when a timer sends the form into this window (the page is replaced, whatever the
//   form holds); pass when it is a keep-alive or a tracking form sent into a hidden frame, a draft the page's own
//   handler keeps, or the visitor's form sent into a hidden frame while the page stays (a draft save, which the test
//   cannot tell from the end of a timed form: listed, never failed);
// - path "settings and exceptions": fail when the page reloads or signs out beside a setting about something else,
//   or when the word that looks like an exception ("bids", "assessments", "exam") is only in a menu or a section
//   heading; pass when a check box, a switch or a list of durations turns the limit off or sets it to ten times, or
//   when the page says what it is is an auction or a timed quiz (the real-time and essential exceptions);
// - path "typed text" (the timing-entry test): fail when a timer clears, locks or removes what was typed and it
//   stays so; pass when the lock lasts only while the page saves, the field is refreshed by a timer that comes
//   round again, a dialog asks "Are you still there?", the form follows the time of day ("open until 5 pm"), the
//   field answers a CAPTCHA, or the page is made inert behind something in front of it.
import { timingProbe } from '../../../src/probes/timing.js';
import { timingEntryProbe } from '../../../src/probes/timingEntry.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll'];

const SEEN_FAIL = ['expired-in-place', 'warning-then-logout', 'warning-logout-button', 'expired-dialog', 'alert-then-redirect', 'reload-self'] as const;
const SEEN_PASS = ['warning-only', 'warning-unknown-button', 'extend-then-expired', 'rotating-notice', 'warning-ok-button'] as const;
const SUBMIT_FAIL = ['submit-self', 'requestsubmit-self', 'hidden-form-self', 'nested-submit-self', 'submit-self-select'] as const;
const SUBMIT_PASS = ['keepalive-frame', 'autosave-prevented', 'draft-frame', 'tracking-frame', 'autosave-prevented-textarea'] as const;
const SETTING_FAIL = ['reload-unrelated-checkbox', 'signout-bids-menu', 'signout-exam-section'] as const;
const SETTING_PASS = ['reload-autorefresh-checkbox', 'reload-select-off', 'reload-select-adjust', 'reload-pause-button', 'auction-close', 'timed-quiz', 'keep-signed-in'] as const;
const ENTRY_FAIL = ['lock-stays', 'clear-once', 'remove-form'] as const;
const ENTRY_PASS = ['lock-briefly', 'refresh-chain', 'still-there-dialog', 'closing-time', 'captcha-refresh', 'inert-overlay', 'interval-goes-on'] as const;

export const LIMIT_PATHS: Readonly<Record<string, readonly string[]>> = {
  'limit seen': [...SEEN_FAIL, ...SEEN_PASS], 'timer submits': [...SUBMIT_FAIL, ...SUBMIT_PASS],
  'settings and exceptions': [...SETTING_FAIL, ...SETTING_PASS], 'typed text': [...ENTRY_FAIL, ...ENTRY_PASS],
};
type CoreKind = (typeof SEEN_FAIL)[number] | (typeof SEEN_PASS)[number] | (typeof SUBMIT_FAIL)[number] | (typeof SUBMIT_PASS)[number] | (typeof SETTING_FAIL)[number] | (typeof SETTING_PASS)[number];
type EntryKind = (typeof ENTRY_FAIL)[number] | (typeof ENTRY_PASS)[number];
const FAILS = new Set<string>([...SEEN_FAIL, ...SUBMIT_FAIL, ...SETTING_FAIL, ...ENTRY_FAIL]);

const CSS = 'label { display: block; margin-top: 12px; } input, textarea, select { font: inherit; min-width: 240px; } button { font: inherit; padding: 6px 12px; } [hidden] { display: none; } .dlg { position: fixed; inset: 20% 15%; background: #fff; border: 2px solid #333; padding: 1rem; } .pane { position: fixed; inset: 0; background: rgba(255,255,255,0.97); padding: 2rem; }';
const ENDED = ['Your session has expired.', 'You have been signed out due to inactivity.', 'Your session timed out.'] as const;
const WILL = ['Your session will expire in 2 minutes.', 'You will be signed out in 2 minutes due to inactivity.', 'For your security, your session ends in 2 minutes.'] as const;
const UNKNOWN = ['Stay connected', 'Resume', 'I am still here'] as const;
const NOTE_FORM = '<form id="f" action="/expired" method="get"><label for="n">Note to the clerk</label><input id="n" name="n"> <button>Save</button></form>';

interface Built { title: string; body: string; init: string[]; why: string }

function core(kind: CoreKind, d: number, rep: number): Built {
  const ms = d * 1000;
  const out = `setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000});`;
  const T = (s: string) => JSON.stringify(s);
  switch (kind) {
    case 'expired-in-place':
      return { title: 'Account overview', body: `<div id="app"><p>Your recent activity.</p>${NOTE_FORM}</div>`, init: [`setTimeout(function () { document.getElementById('app').innerHTML = '<p role="alert">' + ${T(ENDED[rep % 3]!)} + ' <a href="/expired">Sign in again</a> to continue.</p>'; }, ${ms});`], why: `the page puts "${ENDED[rep % 3]!}" in place of the form after ${d} s, with nothing to extend` };
    case 'warning-then-logout':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><p id="msg" role="status"></p>${NOTE_FORM}`, init: [`setTimeout(function () { document.getElementById('msg').textContent = ${T(WILL[rep % 3]!)}; }, ${ms}); ${out}`], why: `a warning after ${d} s, then the sign-out two minutes later, with nothing to extend` };
    case 'warning-logout-button':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><div id="warn" class="dlg" role="alertdialog" aria-labelledby="wt" hidden><p id="wt">${WILL[rep % 3]!}</p><p><button type="button" id="lo">Log out now</button></p></div>`, init: [`setTimeout(function () { document.getElementById('warn').hidden = false; }, ${ms}); ${out} document.getElementById('lo').addEventListener('click', function () { location.href = '/expired'; });`], why: 'a warning whose only button logs out, then the sign-out' };
    case 'expired-dialog':
      return { title: 'Permit application', body: `<p>Fill in the form.</p>${NOTE_FORM}<div id="gone" class="dlg" role="alertdialog" aria-labelledby="gt" hidden><p id="gt">${ENDED[(rep + 1) % 3]!}</p><p><a href="/expired">Sign in again</a></p></div>`, init: [`setTimeout(function () { document.getElementById('gone').hidden = false; }, ${ms});`], why: `a box says "${ENDED[(rep + 1) % 3]!}" after ${d} s and offers only to sign in again` };
    case 'alert-then-redirect':
      return { title: 'Account overview', body: `<p>Your recent activity.</p>${NOTE_FORM}`, init: [`setTimeout(function () { alert(${T(WILL[rep % 3]!)}); }, ${ms}); ${out}`], why: 'an alert warns, then the sign-out, with nothing to extend' };
    case 'reload-self':
      return { title: 'Arrivals at Main Station', body: '<p id="board">Route 12: 4 min. Route 24: 9 min.</p>', init: [`setInterval(function () { location.reload(); }, ${Math.max(ms, 30_000)});`], why: 'the page reloads itself on a timer with no setting (F41)' };
    case 'warning-only':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><p id="msg" role="status"></p>${NOTE_FORM}`, init: [`setTimeout(function () { document.getElementById('msg').textContent = ${T(WILL[rep % 3]!.replace('2 minutes', '5 minutes'))}; }, ${ms});`], why: 'a warning only: nothing on the page ends the visit (using the site keeps it going)' };
    case 'warning-unknown-button':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><div id="warn" class="dlg" role="alertdialog" aria-labelledby="wt" hidden><p id="wt">${WILL[rep % 3]!}</p><p><button type="button" id="stay">${UNKNOWN[rep % 3]!}</button> <button type="button" id="lo">Log out</button></p></div>`, init: [`var w, e; function arm() { clearTimeout(w); clearTimeout(e); document.getElementById('warn').hidden = true; w = setTimeout(function () { document.getElementById('warn').hidden = false; }, ${ms}); e = setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000}); } arm(); document.getElementById('stay').addEventListener('click', arm); document.getElementById('lo').addEventListener('click', function () { location.href = '/expired'; });`], why: `the warning's "${UNKNOWN[rep % 3]!}" button restarts the time (Extend)` };
    case 'extend-then-expired':
      return { title: 'Account overview', body: '<p>Your recent activity.</p><div id="warn" class="dlg" role="alertdialog" aria-labelledby="wt" hidden><p id="wt">Your session will expire in 2 minutes because you have been inactive.</p><p id="wb"><button type="button" id="stay">Stay signed in</button></p></div>', init: [`var w, e; function arm() { clearTimeout(w); clearTimeout(e); document.getElementById('warn').hidden = true; w = setTimeout(function () { document.getElementById('warn').hidden = false; }, ${ms}); e = setTimeout(function () { document.getElementById('wt').textContent = 'Your session has expired.'; document.getElementById('wb').innerHTML = '<a href="/expired">Sign in again</a>'; }, ${ms + 120_000}); } arm(); document.getElementById('stay').addEventListener('click', arm);`], why: 'a "Stay signed in" button offered before the session expires (Extend)' };
    case 'rotating-notice':
      return { title: 'Parks and recreation', body: '<div id="notices" class="notice-carousel" aria-roledescription="carousel" aria-label="Notices"><p id="slide">Pool hours change on June 1.</p></div><p><button type="button" id="stop">Pause notices</button></p>', init: [`var lines = ['Pool hours change on June 1.', ${T(['Summer session sign-up expires Friday at 5 pm.', 'Your parking permit expires in 2 minutes if not renewed online.', 'Session registration closes in two minutes at the front desk.'][rep % 3]!)}, 'Trail work closes the east loop this week.'], i = 0; var t = setInterval(function () { i = (i + 1) % lines.length; document.getElementById('slide').textContent = lines[i]; }, ${Math.min(ms, 8000)}); document.getElementById('stop').addEventListener('click', function () { clearInterval(t); });`], why: 'a notice carousel whose words read like a limit: content taking turns, no limit on the visitor' };
    case 'warning-ok-button':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><div id="warn" class="dlg" role="alertdialog" aria-labelledby="wt" hidden><p id="wt">${WILL[rep % 3]!}</p><p><button type="button" id="ok">OK</button></p></div>`, init: [`var w, e; function arm() { clearTimeout(w); clearTimeout(e); document.getElementById('warn').hidden = true; w = setTimeout(function () { document.getElementById('warn').hidden = false; }, ${ms}); e = setTimeout(function () { location.href = '/expired'; }, ${ms + 120_000}); } arm(); document.getElementById('ok').addEventListener('click', arm);`], why: 'the warning\'s OK button restarts the time (Extend)' };
    case 'submit-self':
    case 'submit-self-select': {
      const field = kind === 'submit-self' ? '<label for="what">What is the gathering for?</label><input id="what" name="what">' : '<label for="size">How many people?</label><select id="size" name="size"><option>1 to 10</option><option>11 to 50</option></select>';
      return { title: 'Shelter booking', body: `<form id="f" action="/expired" method="get">${field} <button>Book</button></form>`, init: [`setTimeout(function () { document.getElementById('f').submit(); }, ${ms});`], why: `a timer sends the visitor's form into this window after ${d} s (the page is replaced)` };
    }
    case 'requestsubmit-self':
      return { title: 'Shelter booking', body: '<form id="f" action="/expired" method="get"><label for="what">What is the gathering for?</label><input id="what" name="what"> <button>Book</button></form>', init: [`setTimeout(function () { document.getElementById('f').requestSubmit(); }, ${ms});`], why: `a timer sends the visitor's form with requestSubmit after ${d} s, and nothing stops it` };
    case 'hidden-form-self':
      return { title: 'Account overview', body: `<p>Your recent activity.</p>${NOTE_FORM}<form id="out" action="/expired" method="get" hidden><input type="hidden" name="why" value="idle"></form>`, init: [`setTimeout(function () { document.getElementById('out').submit(); }, ${ms});`], why: 'a timer posts a hidden sign-out form into this window (the page is replaced)' };
    case 'nested-submit-self':
      return { title: 'Shelter booking', body: '<form id="f" action="/expired" method="get"><label for="what">What is the gathering for?</label><input id="what" name="what"> <button>Book</button></form>', init: [`setTimeout(function () { setTimeout(function () { document.getElementById('f').submit(); }, 0); }, ${ms});`], why: 'a timer sends the form into this window from a 0 ms timer it sets' };
    case 'keepalive-frame':
      return { title: 'Permit application', body: `<p>Fill in the form below. You can take as long as you need.</p>${NOTE_FORM}<form id="ping" action="/ping" method="get" target="pinger" hidden><input type="hidden" name="k" value="1"></form><iframe name="pinger" title="" hidden></iframe>`, init: [`setInterval(function () { document.getElementById('ping').submit(); }, ${ms});`], why: 'a hidden keep-alive form sent into a hidden frame: nothing a visitor sees changes' };
    case 'tracking-frame':
      return { title: 'Library catalog', body: '<p>Search the catalog.</p><form id="t" action="/track" method="get" target="tk"><input type="hidden" name="page" value="catalog"></form><iframe name="tk" title="" hidden></iframe>', init: [`setTimeout(function () { document.getElementById('t').submit(); }, ${ms});`], why: 'a form of hidden fields sent into a hidden frame (a visit count)' };
    case 'autosave-prevented':
    case 'autosave-prevented-textarea': {
      const field = kind === 'autosave-prevented' ? '<label for="c">Your comment</label><input id="c" name="c">' : '<label for="c">Your comment</label><textarea id="c" name="c" rows="4"></textarea>';
      return { title: 'Comment on the plan', body: `<form id="f" action="/expired" method="get">${field} <button>Send comment</button></form><p id="saved" role="status"></p>`, init: [`var f = document.getElementById('f'), auto = false; f.addEventListener('submit', function (e) { if (auto) { e.preventDefault(); auto = false; document.getElementById('saved').textContent = 'Draft saved.'; } }); setInterval(function () { auto = true; f.requestSubmit(); }, ${ms});`], why: 'a draft saved by a submit the page\'s own handler keeps: nothing is sent away' };
    }
    case 'draft-frame':
      return { title: 'Comment on the plan', body: '<form id="f" action="/draft" method="get" target="saver"><label for="c">Your comment</label><textarea id="c" name="c" rows="4"></textarea> <button formtarget="_self" formaction="/expired">Send comment</button></form><iframe name="saver" title="" hidden></iframe>', init: [`setInterval(function () { document.getElementById('f').submit(); }, ${ms});`], why: 'the visitor\'s form sent into a hidden frame while the page stays: a draft save (listed, never failed)' };
    case 'reload-unrelated-checkbox':
      return { title: 'Arrivals at Main Station', body: '<p id="board">Route 12: 4 min. Route 24: 9 min.</p><p><label><input type="checkbox" id="acc"> Show only accessible stops</label></p>', init: [`setInterval(function () { location.reload(); }, ${Math.max(ms, 30_000)});`], why: 'the page reloads itself; its only check box is about something else' };
    case 'signout-bids-menu':
    case 'signout-exam-section': {
      const menu = kind === 'signout-bids-menu' ? '<nav aria-label="Portal"><h2>Open bids</h2><h2>Property assessments</h2></nav>' : '<section><h2>Exam results</h2><p>Results of the civil service exam are posted each Friday.</p></section>';
      return { title: kind === 'signout-bids-menu' ? 'Vendor portal' : 'Job applications', body: `<h2 hidden>x</h2>${menu}<p id="msg" role="status"></p>${NOTE_FORM}`, init: [`setTimeout(function () { document.getElementById('msg').textContent = ${T(WILL[rep % 3]!)}; }, ${ms}); ${out}`], why: 'a sign-out with nothing to extend; the exception-like word is only in a menu or a section heading' };
    }
    case 'reload-autorefresh-checkbox':
      return { title: 'Arrivals at Main Station', body: `<p id="board">Route 12: 4 min. Route 24: 9 min.</p><p><label><input type="checkbox" id="auto" checked> ${['Auto-refresh this page', 'Refresh automatically', 'Live updates'][rep % 3]}</label></p>`, init: [`var t = setInterval(function () { location.reload(); }, ${Math.max(ms, 30_000)}); document.getElementById('auto').addEventListener('change', function () { clearInterval(t); });`], why: 'a check box turns the reload off (Turn off)' };
    case 'reload-select-off':
    case 'reload-select-adjust': {
      const opts = kind === 'reload-select-off' ? '<option value="30" selected>30 seconds</option><option value="60">1 minute</option><option value="0">Off</option>' : '<option value="30" selected>30 seconds</option><option value="60">1 minute</option><option value="300">5 minutes</option>';
      return { title: 'Arrivals at Main Station', body: `<p id="board">Route 12: 4 min. Route 24: 9 min.</p><p><label for="every">Refresh every</label> <select id="every">${opts}</select></p>`, init: ["var t; function arm() { clearInterval(t); var s = Number(document.getElementById('every').value); if (s) t = setInterval(function () { location.reload(); }, s * 1000); } arm(); document.getElementById('every').addEventListener('change', arm);"], why: kind === 'reload-select-off' ? 'a list of refresh times with "Off" (Turn off)' : 'a list of refresh times up to ten times the default (Adjust)' };
    }
    case 'reload-pause-button':
      return { title: 'Election results', body: '<p id="board">Measure 4: 52% yes.</p><p><button type="button" id="p" aria-pressed="false">Pause live updates</button></p>', init: [`var t = setInterval(function () { location.reload(); }, ${Math.max(ms, 30_000)}); document.getElementById('p').addEventListener('click', function () { clearInterval(t); this.setAttribute('aria-pressed', 'true'); });`], why: 'a toggle button turns the reload off (Turn off)' };
    case 'auction-close':
      return { title: 'Surplus auction', body: '<h2 hidden>x</h2><p>Bidding on this lot closes at the time shown. The highest bid when it closes wins.</p><form action="/bid" method="get"><label for="b">Your bid in dollars</label><input id="b" name="bid" inputmode="numeric"> <button>Place bid</button></form>', init: [`setTimeout(function () { location.href = '/expired'; }, ${ms});`], why: 'an auction that closes for everyone at one moment (real-time exception)' };
    case 'timed-quiz':
      return { title: 'Timed quiz: water safety', body: '<p>Answer the five questions before the time runs out.</p><form action="/expired" method="get"><label for="q1">What should you do first?</label><input id="q1" name="q1"> <button>Next</button></form>', init: [`setTimeout(function () { location.href = '/expired'; }, ${ms});`], why: 'a timed quiz whose time is up (essential exception)' };
    case 'keep-signed-in':
      return { title: 'Account overview', body: `<p>Your recent activity.</p><p><label><input type="checkbox" id="keep"> Keep me signed in</label></p>${NOTE_FORM}`, init: [`var e = setTimeout(function () { location.href = '/expired'; }, ${ms}); document.getElementById('keep').addEventListener('change', function () { if (this.checked) clearTimeout(e); });`], why: 'a "Keep me signed in" check box turns the sign-out off (Turn off)' };
  }
}

function entry(kind: EntryKind, d: number, rep: number): Built {
  const ms = d * 1000;
  const field = '<label for="f">What do you need help with?</label><input type="text" id="f">';
  switch (kind) {
    case 'lock-stays':
      return { title: 'Front desk request', body: `<div id="box">${field}</div><p id="note"></p>`, init: [`setTimeout(function () { document.getElementById('f').disabled = true; }, ${ms});`], why: `the field is locked ${d} s after the load and stays locked, with nothing to extend` };
    case 'clear-once':
      return { title: 'Front desk request', body: `<div id="box">${field}</div>`, init: [`setTimeout(function () { document.getElementById('f').value = ''; }, ${ms});`], why: `what was typed is cleared ${d} s after the load, with nothing to extend` };
    case 'remove-form':
      return { title: 'Front desk request', body: `<div id="box">${field}</div><p id="note"></p>`, init: [`setTimeout(function () { document.getElementById('box').remove(); document.getElementById('note').textContent = 'This form has closed.'; }, ${ms});`], why: `the form is removed ${d} s after the load, with nothing to extend` };
    case 'lock-briefly':
      return { title: 'Front desk request', body: `<div id="box">${field}</div><p id="s" role="status"></p>`, init: [`setInterval(function () { var f = document.getElementById('f'); f.disabled = true; document.getElementById('s').textContent = 'Saving draft…'; setTimeout(function () { f.disabled = false; document.getElementById('s').textContent = 'Draft saved.'; }, 1000); }, ${ms});`], why: 'the field is locked for a second while a draft is saved, then given back' };
    case 'refresh-chain':
      return { title: 'Arrivals search', body: `<div id="box">${field}</div><p id="board">Route 12: 4 min.</p>`, init: [`(function tick() { setTimeout(function () { document.getElementById('box').innerHTML = ${JSON.stringify(field)}; tick(); }, ${ms}); })();`], why: 'a widget that re-renders itself on a timer that comes round again: no limit counted from the visit' };
    case 'still-there-dialog':
      return { title: 'Front desk request', body: `<div id="box">${field}</div><div id="ask" class="dlg" role="dialog" aria-modal="true" aria-labelledby="at" hidden><p id="at">Are you still there?</p><button type="button" id="yes">Yes, I am still here</button></div>`, init: [`setTimeout(function () { document.getElementById('f').disabled = true; document.getElementById('ask').hidden = false; }, ${ms}); document.getElementById('yes').addEventListener('click', function () { document.getElementById('ask').hidden = true; document.getElementById('f').disabled = false; });`], why: 'a "Still there?" dialog locks the field behind it while it asks; answering gives it back' };
    case 'closing-time':
      return { title: 'Chat with the library', body: `<p>${['Chat is open until 5 pm on weekdays.', 'Live chat closes at 5:00 pm today.', 'The chat desk is open 9 am to 5 pm, Monday to Friday.'][rep % 3]}</p><div id="box">${field}</div>`, init: [`setTimeout(function () { document.getElementById('f').disabled = true; }, ${ms + 1237});`], why: 'the chat closes at a time of day ("until 5 pm"): no limit counted from the visit' };
    case 'captcha-refresh':
      return { title: 'Contact the clerk', body: '<p>Send us a message.</p><label for="m">Your message</label><textarea id="m" rows="3"></textarea><p><img alt="Security code" width="120" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></p><label for="cap">Type the characters you see in the picture</label><input type="text" id="cap" name="captcha">', init: [`setInterval(function () { document.getElementById('cap').value = ''; }, ${ms});`], why: 'a CAPTCHA\'s answer cleared when its picture is replaced: no entry of the visitor\'s own' };
    case 'inert-overlay':
      return { title: 'Front desk request', body: `<div id="box">${field}</div><div id="wall" class="pane" hidden><p>Before you continue, please choose your language.</p><button type="button" id="en">English</button></div>`, init: [`setTimeout(function () { document.getElementById('box').inert = true; document.getElementById('wall').hidden = false; }, ${ms}); document.getElementById('en').addEventListener('click', function () { document.getElementById('box').inert = false; document.getElementById('wall').hidden = true; });`], why: 'a panel in front makes the form inert; choosing in it gives the form back' };
    case 'interval-goes-on':
      return { title: 'Arrivals search', body: `<div id="box">${field}</div><p id="board">Route 12: 4 min.</p>`, init: [`setInterval(function () { document.getElementById('f').value = ''; document.getElementById('board').textContent = 'Route 12: ' + (1 + Math.floor(Math.random() * 9)) + ' min.'; }, ${ms});`], why: 'a refresh that empties the search box every time it comes round, and goes on: no limit counted from the visit' };
  }
}

const CORE_DELAYS = [60, 900, 1500] as const;
const ENTRY_DELAYS = [30, 90, 600] as const;

export function limitCase(kind: CoreKind | EntryKind, hazard: Hazard, n: number, seed: number): SimCase {
  const isEntry = (Object.keys(LIMIT_PATHS) as string[]).includes('typed text') && LIMIT_PATHS['typed text']!.includes(kind);
  const d = isEntry ? ENTRY_DELAYS[n % ENTRY_DELAYS.length]! : CORE_DELAYS[n % CORE_DELAYS.length]!;
  const id = `${isEntry ? 'timing-entry-limits' : 'timing-limits'}/${kind}/${d}s/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const b = isEntry ? entry(kind as EntryKind, d, n) : core(kind as CoreKind, d, n);
  const pg = parts(b.title, `${b.body}${filler(r, 1)}`, [CSS], b.init);
  pg.routes['/expired'] = { status: 200, type: 'text/html; charset=utf-8', body: '<!doctype html><title>Signed out</title><main><h1>Signed out</h1></main>' };
  applyHazard(pg, hazard, r);
  const path = Object.entries(LIMIT_PATHS).find(([, ks]) => ks.includes(kind))![0];
  return {
    id, test: isEntry ? 'timing-entry-limits' : 'timing-limits', hazard, params: { kind, delayS: d, path },
    site: render(pg),
    expect: { '2.2.1': FAILS.has(kind) ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: b.why,
  };
}

function casesOf(kinds: readonly string[], seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  for (const kind of kinds) for (const hazard of HAZARDS) out.push(limitCase(kind as CoreKind | EntryKind, hazard, n++, seed));
  return out;
}

export const timingLimitsTest: SimTest = {
  id: 'timing-limits', criteria: ['2.2.1'], probes: () => [timingProbe], full: false, read: 'probe', readProbes: ['timing'], capMs: 90_000,
  cases: (seed) => casesOf([...SEEN_FAIL, ...SEEN_PASS, ...SUBMIT_FAIL, ...SUBMIT_PASS, ...SETTING_FAIL, ...SETTING_PASS], seed),
};

/** Each typed-text kind on each hazard at each of its three delays (enough failing and passing pages for a 95% claim). */
function entryCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  for (const kind of [...ENTRY_FAIL, ...ENTRY_PASS]) for (const hazard of HAZARDS) for (let k = 0; k < ENTRY_DELAYS.length; k++) out.push(limitCase(kind, hazard, n++ * ENTRY_DELAYS.length + k, seed));
  return out;
}

export const timingEntryLimitsTest: SimTest = {
  id: 'timing-entry-limits', criteria: ['2.2.1'], probes: () => [timingEntryProbe], full: true, read: 'probe', readProbes: ['timing-entry'], capMs: 120_000,
  cases: entryCases,
};
