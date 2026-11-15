// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// 3.3.1 Error Identification (probe `forms`, deep): a form with a required e-mail field, submitted
// empty and with a bad address. The answer by construction:
// - the page's script names the field in text next to it (and marks it aria-invalid): passes;
// - the browser's own required/type checks (constraint validation) name the field: passes;
// - only the field's border turns red, or a message that does not say which field ("Something went
//   wrong"), fails: the field in error is not identified in text;
// - the form posts to our fixture server, which answers 400 with the error named on the page or 500
//   with a generic error page. The engine sends nothing to a server by design (the request guard), and
//   the field is also \`required\` (the browser names it when it is empty), so what the server does is
//   out of the engine's reach: these cases are run and listed but not counted ('any').
import { formsProbe } from '../../../src/probes/forms.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest } from '../types.js';

const HAZARDS: readonly Hazard[] = ['none', 'sticky-header', 'cookie-banner', 'late-mount', 'font-swap', 'smooth-scroll', 'lazy-images', 'animation-in-flight', 'scroll-snap', 'none'];
export const FORM_KINDS = ['named-error', 'native-validation', 'red-border-only', 'generic-message', 'server-400-named', 'server-500-generic'] as const;
type Kind = (typeof FORM_KINDS)[number];

export function formCase(kind: Kind, rep: number, hazard: Hazard, seed: number): SimCase {
  const id = `forms/${kind}/${rep}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const server = kind.startsWith('server');
  const init: string[] = [];
  const routes: Record<string, { status: number; body: string; type: string }> = {};
  const native = kind === 'native-validation';
  const form = `<form id="f" action="/subscribe" method="post"${native || server ? '' : ' novalidate'}>
<p><label for="email">E-mail address</label><br><input id="email" name="email" type="email" autocomplete="email"${native || server ? ' required' : ''}><span id="email-err" class="err"></span></p>
<p><label for="name">Your name</label><br><input id="name" name="name" type="text" autocomplete="name"></p>
<p id="msg" role="alert"></p>
<p><button type="submit">Subscribe</button></p></form>`;
  if (!native && !server) {
    init.push(`document.getElementById('f').addEventListener('submit', function (e) { e.preventDefault(); var em = document.getElementById('email'), ok = /^[^@\\s]+@[^@\\s]+\\.[a-z]{2,}$/i.test(em.value);
  var err = document.getElementById('email-err'), msg = document.getElementById('msg');
  if (ok) { em.removeAttribute('aria-invalid'); em.style.borderColor = ''; err.textContent = ''; msg.textContent = 'Thank you, you are subscribed.'; return; }
  ${kind === 'named-error' ? "em.setAttribute('aria-invalid', 'true'); em.setAttribute('aria-describedby', 'email-err'); err.textContent = ' Enter an e-mail address like name@example.com.'; em.focus();" : ''}
  ${kind === 'red-border-only' ? "em.style.borderColor = '#d00'; em.style.borderWidth = '3px';" : ''}
  ${kind === 'generic-message' ? "msg.textContent = 'Something went wrong. Please try again.';" : ''} });`);
  }
  if (server) {
    routes['POST /subscribe'] = kind === 'server-400-named'
      ? { status: 400, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Subscribe: error</title><main><h1>Subscribe</h1><p role="alert">E-mail address: enter an address like name@example.com.</p></main></html>' }
      : { status: 500, type: 'text/html; charset=utf-8', body: '<!doctype html><html lang="en"><title>Error</title><main><h1>Something went wrong</h1></main></html>' };
  }
  const css = ['.err { color: #b00020; } input { font: 16px Arial; padding: 6px; border: 2px solid #1b1b1b; } button { font: 16px Arial; } input:focus-visible, button:focus-visible { outline: 3px solid #00376d; outline-offset: 2px; }'];
  const pg = parts('Newsletter', `<p>Get the city newsletter.</p>${form}${filler(r, 2)}`, css, init);
  Object.assign(pg.routes, routes);
  applyHazard(pg, hazard, r);
  const fails = kind === 'red-border-only' || kind === 'generic-message';
  return {
    id, test: 'forms', hazard, params: { kind },
    site: render(pg),
    expect: { '3.3.1': server ? { verdict: 'any' } : fails ? { verdict: 'fail', count: 1 } : { verdict: 'pass' } },
    why: { 'named-error': 'the script names the field in error in text', 'native-validation': 'the browser names the field (constraint validation)', 'red-border-only': 'only a red border marks the field', 'generic-message': 'a message that does not say which field', 'server-400-named': 'the server names the field (out of the engine\'s reach: it sends nothing)', 'server-500-generic': 'the server answers 500 with a generic page (out of the engine\'s reach: it sends nothing)' }[kind],
  };
}

export function formCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  // The hazard depends on the kind and the repetition only, so a case keeps its id when counts change.
  FORM_KINDS.forEach((k, ki) => {
    for (let rep = 0; rep < (k.startsWith('server') ? 6 : 27); rep++) out.push(formCase(k, rep, HAZARDS[(ki * 3 + rep) % HAZARDS.length]!, seed));
  });
  return out;
}

export const formsTest: SimTest = {
  id: 'forms', criteria: ['3.3.1'], probes: () => [formsProbe], full: true, read: 'probe', readProbes: ['forms'], capMs: 120_000, cases: formCases,
};
