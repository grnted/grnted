// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// fix/late-mount: content a page mounts 1 to 2 s after load (an app that hydrates late; the simulation lab's
// `late-mount` hazard) was the largest cause of false passes in the lab. Each test that misread it now sees it:
// hover, gestures and device motion wait for the content first (bounded); sound, motion and axe take a second
// look after their first pass (bounded), so a failure at load is still judged as it is and still stands.
//
// The late cases are the lab's own known-answer pages (test/sim/tests) with the content mounted 1.9 s after
// load (after the runner's 1 s settle, so the first look sees only the "Loading…" shell); they run exactly as
// the lab runs them (`runCase`: scanSite, one page, the test's probes only).
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import { audioProbe } from '../../src/probes/audio.js';
import { formFieldsProbe } from '../../src/probes/forms.js';
import { headingsProbe } from '../../src/probes/headings.js';
import { hoverContentProbe } from '../../src/probes/hoverContent.js';
import { LATE_CONTENT_MS, stillMounting } from '../../src/probes/mounting.js';
import { motionProbe } from '../../src/probes/motion.js';
import { reflowProbe } from '../../src/probes/reflow.js';
import { runProbes } from '../../src/probes/runner.js';
import { textSpacingProbe } from '../../src/probes/textSpacing.js';
import { timingProbe } from '../../src/probes/timing.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { runCase } from '../sim/run.js';
import { hoverCase, gestureCase, hoverTest, pointerTest } from '../sim/tests/interaction.js';
import { audioCase, audioTest, motionCase, motionTest, toneWav } from '../sim/tests/motionAudio.js';
import { actuationCase, motionActuationTest } from '../sim/tests/pointerMotion.js';
import { reflowCase, reflowTest } from '../sim/tests/reflow.js';
import { rowCase, targetSizeTest } from '../sim/tests/targetSize.js';
import { inlineCase, textSpacingTest } from '../sim/tests/textSpacing.js';
import type { SimCase, SimTest } from '../sim/types.js';

const SEED = 1;
const MOUNT_MS = 1900;

/** The lab case with its content mounted `ms` after load (the hazard's own delay is random, 1 to 2 s). */
function mountAt(c: SimCase, ms = MOUNT_MS): SimCase {
  const html = c.site.files['/'] as string;
  const re = /\}, \d+\);\n<\/script>/;
  if (c.hazard !== 'late-mount' || !re.test(html)) throw new Error(`${c.id} is not a late-mount case`);
  return { ...c, id: `${c.id}@${ms}`, site: { ...c.site, files: { ...c.site.files, '/': html.replace(re, `}, ${ms});\n</script>`) } } };
}

const verdict = async (test: SimTest, c: SimCase) => {
  const [r] = await runCase(test, c);
  return { observed: r!.observed, details: r!.details.join(' | ') };
};

/** A page whose app mounts late, with `early` already in the shell from load (outside the app). */
const shell = (o: { title: string; early?: string; late: string; css?: string; ms?: number }) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${o.title}</title>
<style>body{margin:0;font:16px/1.5 sans-serif;color:#1b1b1b;background:#fff}main{display:block;padding:0 24px}${o.css ?? ''}</style></head>
<body><main id="main"><h1>${o.title}</h1>${o.early ?? ''}<div id="app" aria-busy="true"><p>Loading…</p></div></main>
<template id="late">${o.late}</template>
<script>setTimeout(function(){var a=document.getElementById('app');a.innerHTML=document.getElementById('late').innerHTML;a.removeAttribute('aria-busy');},${o.ms ?? MOUNT_MS});</script></body></html>`;

const site = (html: string, files: Record<string, string | Uint8Array> = {}) => ({ files: { '/': html, ...files } });
const custom = (test: string, id: string, html: string, criterion: string, files: Record<string, string | Uint8Array> = {}): SimCase => ({
  id, test, params: {}, hazard: 'late-mount', site: site(html, files), expect: { [criterion]: { verdict: 'fail' } }, why: id,
});

describe('content mounted late is seen by the tests that misread it', () => {
  it('hover (1.4.13): a tooltip that Escape does not dismiss, in content mounted 1.9 s after load, fails', async () => {
    const c = mountAt(hoverCase({ how: 'script', trigger: 'button', dismiss: false, hoverable: true, persistent: true, rep: 0, hazard: 'late-mount' }, SEED));
    expect(await verdict(hoverTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('gestures (2.5.1): a swipe-only carousel mounted late fails', async () => {
    const c = mountAt(gestureCase('swipe-carousel', false, 0, 'late-mount', SEED));
    expect(await verdict({ ...pointerTest, criteria: ['2.5.1'] }, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('device motion (2.5.4): shake to undo with no other way, mounted late, fails', async () => {
    const c = mountAt(actuationCase('shake-no-control', 0, 'late-mount', SEED));
    expect(await verdict(motionActuationTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('reflow (1.4.10): text cut off at 320 px, in content mounted late, fails', async () => {
    const c = mountAt(reflowCase('clipped-text', 480, 'late-mount', SEED));
    expect(await verdict(reflowTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('target size (2.5.8, axe): 12 px icon links mounted late fail', async () => {
    const c = mountAt(rowCase('icon-link', 12, 0, 'row', 'late-mount', SEED));
    expect(await verdict(targetSizeTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('text spacing (1.4.12, axe): a line height set inline with !important, mounted late, fails', async () => {
    const c = mountAt(inlineCase('line-1.2-important', 0, 'late-mount', SEED));
    expect(await verdict(textSpacingTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);
});

describe('sound and motion take a second look; what they found at load still stands', () => {
  it('audio (1.4.2): a looping <audio> with no control, mounted late, fails (second look)', async () => {
    const c = mountAt(audioCase('audio-element', Infinity, 'none', 0, 'late-mount', SEED)!);
    expect(await verdict(audioTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('audio (1.4.2): Web Audio that plays on with no control, started when the content mounts, fails', async () => {
    const c = mountAt(audioCase('web-audio', Infinity, 'none', 0, 'late-mount', SEED)!);
    expect(await verdict(audioTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('audio (1.4.2): a 3.5 s sound from load, on a page still mounting, still fails (judged at once, never waited out)', async () => {
    const html = shell({ title: 'Welcome', early: '<audio src="/tone.wav" autoplay></audio>', late: '<p>Welcome to the visitor centre.</p>' });
    const c = custom('audio', 'audio/early-3.5s', html, '1.4.2', { '/tone.wav': toneWav(3.5) });
    expect(await verdict(audioTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('motion (2.2.2): blinking text with no control, mounted late, fails (second look)', async () => {
    const c = mountAt(motionCase('blink', Infinity, 'none', 'late-mount', SEED));
    expect(await verdict(motionTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('motion (2.2.2): a carousel with no control, mounted late, fails (second look)', async () => {
    const c = mountAt(motionCase('carousel', Infinity, 'none', 'late-mount', SEED));
    expect(await verdict(motionTest, c)).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('motion (2.2.2): a banner blinking from load (6 s, no control) on a page still mounting still fails', async () => {
    const html = shell({
      title: 'Events', early: '<p class="blink">Open house this Saturday</p>', late: '<p>Upcoming events for families.</p>',
      css: '.blink{font:700 24px Arial;color:#00376d;animation:b 1s steps(1,end) 6 both}@keyframes b{0%{opacity:1}50%{opacity:0}}',
    });
    expect(await verdict(motionTest, custom('motion', 'motion/early-blink-6s', html, '2.2.2'))).toMatchObject({ observed: 'fail' });
  }, 150_000);

  it('target size (2.5.8, axe): tiny links in the loading screen, replaced when the content mounts, do not count (axe judges the settled page)', async () => {
    const tiny = '<p class="tiny"><a href="/a">a</a><a href="/b">b</a><a href="/c">c</a></p>';
    const html = shell({ title: 'Parks', late: '<p>Parks and trails.</p>', css: '.tiny a{display:inline-block;width:12px;height:12px;font-size:10px;line-height:12px;overflow:hidden;color:#00376d}' })
      .replace('<p>Loading…</p>', `<p>Loading…</p>${tiny}`);
    const c = { ...custom('target-size', 'target-size/early-shell', html, '2.5.8'), expect: { '2.5.8': { verdict: 'pass' as const } } };
    expect(await verdict(targetSizeTest, c)).toMatchObject({ observed: 'pass' });
  }, 150_000);

  it('audio (1.4.2): a second Web Audio context is judged by its own identity, also when the list puts it first', async () => {
    // The shell's tone plays from load (no control: a failure) and stops when the content mounts; the
    // content starts its own tone, and the page's list of contexts then names the new one first.
    const html = shell({ title: 'Welcome', late: '<p>Welcome to the visitor centre.</p>', ms: 5200 }).replace('<script>', `<script>
(function(){var C=window.AudioContext;var a=new C(),o=a.createOscillator(),g=a.createGain();g.gain.value=0.2;o.connect(g);g.connect(a.destination);o.start();window.__a=a;})();
setTimeout(function(){window.__a.close();var C=window.AudioContext;var b=new C(),o=b.createOscillator(),g=b.createGain();g.gain.value=0.2;o.frequency.value=520;o.connect(g);g.connect(b.destination);o.start();
var orig=window.__grntedSound;if(orig){Object.defineProperty(window,'__grntedSound',{configurable:true,value:function(){var s=orig();return Object.assign({},s,{contexts:s.contexts.slice().reverse()});}});}},5200);
`);
    const c = custom('audio', 'audio/two-contexts', html, '1.4.2');
    const [r] = await runCase(audioTest, c);
    expect(r!.observed, r!.details.join(' | ')).toBe('fail');
    expect(r!.observedCount, r!.details.join(' | ')).toBe(2);
  }, 150_000);

  it('motion (2.2.2): a canvas that moves 4.9 s from when the content appears never fails (Sol r3 1; since r4 motion times "5 s" only by its own observations of the canvas)', async () => {
    // Mounted at 1.9 s by a 100 ms interval (never run early by the motion test), the canvas then moves 4.9 s.
    const canvas = '<canvas id="cv" width="600" height="120" role="img" aria-label="A moving wave"></canvas>';
    const html = shell({ title: 'News', late: `<p>News from the city.</p>${canvas}`, ms: 600_000 }).replace('</script>', `
(function(){var t0=performance.now();var id=setInterval(function(){if(performance.now()-t0<1900)return;clearInterval(id);var a=document.getElementById('app');a.innerHTML=document.getElementById('late').innerHTML;a.removeAttribute('aria-busy');var c=document.getElementById('cv'),g=c.getContext('2d'),q=performance.now();
function step(t){var d=t-q;if(d>4900)return;g.fillStyle='#eef3f8';g.fillRect(0,0,600,120);g.fillStyle='#00376d';g.fillRect((d/8)%520,30,80,60);requestAnimationFrame(step);}requestAnimationFrame(step);},100);})();
</script>`);
    const c = { ...custom('motion', 'motion/canvas-4.9s-late', html, '2.2.2'), expect: { '2.2.2': { verdict: 'pass' as const } } };
    expect(await verdict(motionTest, c)).toMatchObject({ observed: 'pass' });
  }, 150_000);

  it('motion (2.2.2): a hydration flicker (busy again for a moment) never times a canvas that runs 4.5 s as more than 5 s', async () => {
    // Driven by a 100 ms interval (the motion test runs timers of 1 s or more early, never shorter ones):
    // ready at 1.5 s, busy again at 1.6 s, ready for good at 4.5 s, when a canvas animation starts that runs
    // 4.5 s (at most 5 s: no failure). Timed from 1.5 s it would look like more than 5 s.
    const canvas = '<canvas id="cv" width="600" height="120" role="img" aria-label="A moving wave"></canvas>';
    const html = shell({ title: 'News', late: `<p>News from the city.</p>${canvas}`, ms: 600_000 }).replace('</script>', `
(function(){var t0=performance.now(),s1=false,s2=false;var id=setInterval(function(){var e=performance.now()-t0,a=document.getElementById('app');
if(!s1&&e>=1500){s1=true;a.innerHTML=document.getElementById('late').innerHTML;a.removeAttribute('aria-busy');}
if(!s2&&e>=1600){s2=true;a.setAttribute('aria-busy','true');}
if(e>=4500){clearInterval(id);a.removeAttribute('aria-busy');var c=document.getElementById('cv'),g=c.getContext('2d'),q=performance.now();
function step(t){var d=t-q;if(d>4500)return;g.fillStyle='#eef3f8';g.fillRect(0,0,600,120);g.fillStyle='#00376d';g.fillRect((d/8)%520,30,80,60);requestAnimationFrame(step);}requestAnimationFrame(step);}},100);})();
</script>`);
    const c = { ...custom('motion', 'motion/flicker-canvas-4.5s', html, '2.2.2'), expect: { '2.2.2': { verdict: 'pass' as const } } };
    expect(await verdict(motionTest, c)).toMatchObject({ observed: 'pass' });
  }, 150_000);
});

describe('the motion page: nothing waits in real time before the timing test (late passes run after it)', () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  // Each mounts at 2.9 s; its 2.5 s timer comes due while the content is still mounting.
  const timer = (title: string, js: string) => shell({ title, late: '<p>Your account summary.</p>', ms: 2900 }).replace('</script>', `${js}</script>`);
  const REDIRECT = timer('Account', "setTimeout(function(){location.href='/expired.html';},2500);");
  const WARNING = timer('Account', "setTimeout(function(){var p=document.createElement('p');p.setAttribute('role','alert');p.textContent='Your session has expired. Sign in again to continue.';document.getElementById('main').appendChild(p);},2500);");
  const ASYNC = timer('Account', "setTimeout(async function(){await Promise.resolve();location.href='/expired.html';},2500);");
  const NESTED = timer('Account', "setTimeout(function(){setTimeout(function(){location.href='/expired.html';},0);},2500);");
  // A late-mounted frame plays looping audio; its Mute button sends the whole page to a silent one.
  const PLAYER = '<!doctype html><html lang="en"><head><title>Player</title></head><body><audio src="/tone.wav" autoplay loop></audio><button type="button" onclick="parent.location.href=\'/silent.html\'">Mute</button></body></html>';
  const FRAMED = shell({ title: 'Radio', late: '<p>Live radio.</p><iframe src="/player.html" title="Player" width="320" height="120"></iframe>' });
  const SESSION = shell({ title: 'Sign up', late: '<h2>Newsletter</h2><form><label for="em">Email</label> <input id="em" type="email" autocomplete="email"> <button type="submit">Sign up</button></form>', ms: 1500 })
    .replace('</script>', "setTimeout(function(){document.getElementById('main').innerHTML='<h1>Your session ended</h1>';},8000);</script>");
  const EXPIRED = '<!doctype html><html lang="en"><head><title>Expired</title></head><body><main><h1>Session expired</h1></main></body></html>';
  beforeAll(async () => {
    server = await startFixtureServer('site', {
      '/redirect.html': { type: 'text/html', body: REDIRECT },
      '/warning.html': { type: 'text/html', body: WARNING },
      '/async.html': { type: 'text/html', body: ASYNC },
      '/nested.html': { type: 'text/html', body: NESTED },
      '/warning-ready.html': { type: 'text/html', body: WARNING.replace('},2900);', '},0);') },
      '/async-ready.html': { type: 'text/html', body: ASYNC.replace('},2900);', '},0);') },
      '/nested-ready.html': { type: 'text/html', body: NESTED.replace('},2900);', '},0);') },
      '/framed.html': { type: 'text/html', body: FRAMED },
      '/player.html': { type: 'text/html', body: PLAYER },
      '/tone.wav': { type: 'audio/wav', body: toneWav(2) },
      '/silent.html': { type: 'text/html', body: EXPIRED.replace('Session expired', 'Radio (sound off)') },
      '/expired.html': { type: 'text/html', body: EXPIRED },
      '/session.html': { type: 'text/html', body: SESSION },
    });
    browser = await chromium.launch();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const timingOn = async (path: string) => {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}${path}`, index: 0 }], [audioProbe, motionProbe, motionActuationProbe, timingProbe], { userAgent: 'grnted-test' });
    return runs.find((r) => r.probe === 'timing')!.findings.filter((f) => f.criterion === '2.2.1');
  };

  it('a 2.5 s redirect on a page still mounting fails 2.2.1 (the late passes run after the timing test)', async () => {
    const found = await timingOn('/redirect.html');
    expect(found.map((f) => f.status), JSON.stringify(found)).toContain('failed');
  }, 180_000);

  // Sol r2's other timer inputs: the timing test reads them on a page still mounting exactly as on the same
  // page with its content there from load (nothing waits before it any more). NOTE: hosted/integration does
  // not find these three on ANY page (the motion test runs the timer early first, and the timing test then
  // loses a warning it made, and a redirect it starts after a promise or a 0 ms timer): a timing-test gap,
  // reported to the lead, not one late mounting causes.
  for (const [what, path] of [['a 2.5 s session warning', '/warning'], ['a 2.5 s redirect after a promise', '/async'], ['a 2.5 s timer that redirects from a 0 ms timer', '/nested']] as const) {
    it(`${what}: the same 2.2.1 verdict on a page still mounting as on the page with its content from load`, async () => {
      const mounting = await timingOn(`${path}.html`);
      const ready = await timingOn(`${path}-ready.html`);
      expect(mounting.map((f) => f.status)).toEqual(ready.map((f) => f.status));
    }, 240_000);
  }

  it('a Mute in a late-mounted frame that sends the page elsewhere is never a 1.4.2 failure (not testable at most)', async () => {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/framed.html`, index: 0 }], [audioProbe], { userAgent: 'grnted-test' });
    const audio = runs.find((r) => r.probe === 'audio')!;
    expect(audio.findings.filter((f) => f.status === 'failed'), JSON.stringify(audio.findings)).toEqual([]);
  }, 180_000);

  it('form fields still sees the form after the content waits on its page, before a session timer replaces it', async () => {
    const runs = await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}/session.html`, index: 0 }], [headingsProbe, textSpacingProbe, reflowProbe, formFieldsProbe], { userAgent: 'grnted-test' });
    const ff = runs.find((r) => r.probe === formFieldsProbe.id)!;
    expect(ff.findings.some((f) => /no form fields/.test(f.detail)), JSON.stringify(ff.findings)).toBe(false);
  }, 180_000);
});

describe('every wait and second look is bounded', () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  // A canvas that keeps moving (no control): motion's own "look again 5 s after load" path runs on both pages.
  const CANVAS = '<canvas id="cv" width="600" height="120" role="img" aria-label="A moving wave"></canvas><script>(function(){var c=document.getElementById("cv"),g=c.getContext("2d"),t0=performance.now();function step(t){var e=t-t0;g.fillStyle="#eef3f8";g.fillRect(0,0,600,120);g.fillStyle="#00376d";g.fillRect((e/8)%520,30,80,60);requestAnimationFrame(step);}requestAnimationFrame(step);})();</script>';
  beforeAll(async () => {
    server = await startFixtureServer('site', {
      // Never finishes loading: the app root stays aria-busy (the canvas is in the shell, outside it).
      '/forever.html': { type: 'text/html', body: shell({ title: 'Forever', early: CANVAS, late: '<p>Never shown.</p>', ms: 600_000 }) },
      '/ready.html': { type: 'text/html', body: shell({ title: 'Ready', early: CANVAS, late: '<p>Shown.</p>', ms: 0 }) },
    });
    browser = await chromium.launch();
  }, 30_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  it('a page that never stops loading gets no second look: each test costs at most LATE_CONTENT_MS more, with the same verdict', async () => {
    const ms = async (path: string) => Object.fromEntries((await runProbes(browser as unknown as BrowserLike, [{ url: `${server.origin}${path}`, index: 0 }], [audioProbe, motionProbe, hoverContentProbe], { userAgent: 'grnted-test', full: true }))
      .map((r) => [r.probe, { ms: r.ms, status: r.status, verdicts: r.findings.map((f) => f.status).sort() }]));
    const ready = await ms('/ready.html');
    const forever = await ms('/forever.html');
    for (const id of ['audio', 'motion']) {
      expect(forever[id]!.status, id).toBe('ok');
      expect(forever[id]!.verdicts, id).toEqual(ready[id]!.verdicts);
      expect(forever[id]!.ms - ready[id]!.ms, id).toBeLessThan(LATE_CONTENT_MS + 1500);
    }
    expect(forever.motion!.verdicts).toContain('failed');
    // The hover test's wait is before its time box (the run's own ms): it ran, with a verdict.
    expect(forever['hover-content']!.status).toBe('ok');
  }, 240_000);
});

// Review r4 of fix/late-mount: motion's "more than 5 s" comes ONLY from motion's own observations: the same
// element (by identity, not by place) seen changing, and seen changing again more than 5 s later. The mount
// watch only schedules the late pass; it never feeds a duration. Every elapsed time is monotonic.
// `at()`: ms since the motion test's first pass started (the moment its kit appears in the page), -1 before.
const ANCHOR = 'var T=null;function at(){if(T===null&&window.__grntedKit)T=performance.now();return T===null?-1:performance.now()-T;}';
// Changes the whole of canvas `c` every frame (its grey level rises and falls, period 960 ms) while `on()` is true and it is in the page.
const DRAW = "function draw(c,on){var g=c.getContext('2d'),q=performance.now();function f(t){if(!c.isConnected||!on())return;var d=t-q;var v=40+Math.round(Math.abs(((d/3)%320)-160));g.fillStyle='rgb('+v+','+v+','+v+')';g.fillRect(0,0,600,120);requestAnimationFrame(f);}requestAnimationFrame(f);}";
const canvasHtml = (id: string) => `<p>News from the city.</p><canvas id="${id}" width="600" height="120" role="img" aria-label="A moving wave"></canvas>`;

describe('motion times "5 s" by its own observations of the same element (review r4)', () => {
  const pass = (c: SimCase): SimCase => ({ ...c, expect: { '2.2.2': { verdict: 'pass' as const } } });

  it('Sol r4 1: canvas A (100 to 2,000 ms) then, after the page is mounting again, a distinct canvas B in the same box moving 4.9 s from 3,000 ms: neither fails', async () => {
    // Times are from the first pass's start (Sol's input); a 10 ms interval (the motion test runs only timers of 1 s or more early).
    const html = shell({ title: 'News', late: '', ms: 600_000 }).replace('</script>', `
(function(){${ANCHOR}${DRAW}var a=document.getElementById('app'),step=0,b0=0;
var id=setInterval(function(){var e=at();if(e<0)return;
if(step===0&&e>=100){step=1;a.innerHTML=${JSON.stringify(canvasHtml('A'))};a.removeAttribute('aria-busy');draw(document.getElementById('A'),function(){return true;});}
if(step===1&&e>=2000){step=2;a.setAttribute('aria-busy','true');a.innerHTML='<p>Loading…</p>';}
if(step===2&&e>=3000){step=3;clearInterval(id);a.innerHTML=${JSON.stringify(canvasHtml('B'))};a.removeAttribute('aria-busy');b0=performance.now();draw(document.getElementById('B'),function(){return performance.now()-b0<4900;});}},10);})();
</script>`);
    const r = await verdict(motionTest, pass(custom('motion', 'motion/sol4-1-two-canvases', html, '2.2.2')));
    expect(r.observed, r.details).not.toBe('fail');
  }, 150_000);

  // Sol r4 3: an uncontrolled canvas moving from load until 7 s, the first pass 1 s after load, the body busy
  // until 1.5 s. Anchored on the first pass (the canvas stops 6 s after it starts; busy clears 0.5 s after it).
  // `extra` goes into the page's main; `end` replaces how the canvas ends (default: it stops drawing).
  const sol3 = (busy: boolean, o: { extra?: string; on?: string; end?: string } = {}) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>News</title>
<style>body{margin:0;font:16px/1.5 sans-serif;color:#1b1b1b;background:#fff}main{display:block;padding:0 24px}</style></head>
<body${busy ? ' aria-busy="true"' : ''}><main><h1>News</h1>${canvasHtml('cv')}${o.extra ?? ''}</main>
<script>(function(){${ANCHOR}${DRAW}draw(document.getElementById('cv'),function(){var e=at();return e<6000${o.on ?? ''};});
var id=setInterval(function(){var e=at();if(e>=500)document.body.removeAttribute('aria-busy');if(e>=6000){clearInterval(id);${o.end ?? ''}}},10);})();</script></body></html>`;
  it('Sol r4 3 (round 5): the same verdict with and without a busy body (a cleared signal never restarts the clock); reported', async () => {
    const busy = await verdict(motionTest, custom('motion', 'motion/sol4-3-busy', sol3(true), '2.2.2'));
    const plain = await verdict(motionTest, custom('motion', 'motion/sol4-3-plain', sol3(false), '2.2.2'));
    // Round 5 reverted "ran its course": the canvas is seen still changing at the look again (about 5.7 s in),
    // then stops by itself (6 s) before it is judged, so it passes: a known miss (docs/scoring.md).
    console.log(`[r5] round 4 Sol 3: busy ${busy.observed} | plain ${plain.observed} | ${plain.details}`);
    expect(busy.observed).toBe(plain.observed);
  }, 300_000);

  it('Sol r5 2: a 6 s canvas whose working Pause is a link the test does not click is never failed', async () => {
    const html = sol3(false, { extra: '<p><a href="#" onclick="window.__paused=1;return false">Pause</a></p>', on: '&&!window.__paused' });
    const r = await verdict(motionTest, pass(custom('motion', 'motion/sol5-2-refused-pause', html, '2.2.2')));
    expect(r.observed, r.details).not.toBe('fail');
  }, 150_000);

  it('Sol r5 6: a canvas seen changing more than 5 s apart that then removes itself: reported (a known miss when it passes)', async () => {
    const r = await verdict(motionTest, custom('motion', 'motion/sol5-6-removed', sol3(false, { end: "var c=document.getElementById('cv');if(c)c.remove();" }), '2.2.2'));
    console.log(`[r5] Sol 6 removed canvas: ${r.observed} | ${r.details}`);
    expect(['pass', 'fail']).toContain(r.observed);
  }, 150_000);

  it('Sol r5 3: a still video poster that loads in two stages (400 ms and 5,800 ms into the first pass) is never failed', async () => {
    const poster = (fill: string) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="120"><rect width="600" height="120" fill="${fill}"/></svg>`)}`;
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Video</title>
<style>body{margin:0;font:16px/1.5 sans-serif;color:#1b1b1b;background:#fff}main{display:block;padding:0 24px}video{display:block;width:600px;height:120px;background:#fff}</style></head>
<body><main><h1>Video</h1><p>Our new welcome video.</p><video id="v" width="600" height="120" preload="none" aria-label="Welcome video"></video></main>
<script>(function(){${ANCHOR}var v=document.getElementById('v'),step=0;var id=setInterval(function(){var e=at();if(e<0)return;
if(step===0&&e>=400){step=1;v.poster=${JSON.stringify(poster('#9aa6b2'))};}
if(step===1&&e>=5800){step=2;clearInterval(id);v.poster=${JSON.stringify(poster('#1d2a38'))};}},10);})();</script></body></html>`;
    const r = await verdict(motionTest, pass(custom('motion', 'motion/sol5-3-poster', html, '2.2.2')));
    expect(r.observed, r.details).not.toBe('fail');
  }, 150_000);

  it('Sol r10: the 8 s ticker with a working Hide control and scroll snapping never fails', async () => {
    const c = motionCase('ticker', 8, 'hide', 'scroll-snap', SEED);
    const r = await verdict(motionTest, c);
    expect(r.observed, r.details).toBe('pass');
  }, 150_000);

  it('Sol r5 1: canvas A replaced in the same box by canvas B between the first look\'s second and third shots, B moving 4.9 s: never failed', async () => {
    // The page counts the test's screenshots (the kit mutes its own record around each one) and swaps A for B
    // 265 ms after the second one: A changed between shots 1 and 2, B is there for shot 3 only.
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>News</title>
<style>body{margin:0;font:16px/1.5 sans-serif;color:#1b1b1b;background:#fff}main{display:block;padding:0 24px}</style></head>
<body><main><h1>News</h1><div id="slot">${canvasHtml('A')}</div></main>
<script>(function(){${DRAW}draw(document.getElementById('A'),function(){return true;});var shots=0,done=false;
var id=setInterval(function(){var k=window.__grntedKit;if(!k)return;clearInterval(id);var m=k.mute;k.mute=function(on){var r=m.apply(k,arguments);if(!on&&!done&&++shots===2){done=true;setTimeout(function(){document.getElementById('slot').innerHTML=${JSON.stringify(canvasHtml('B'))};var q=performance.now();draw(document.getElementById('B'),function(){return performance.now()-q<4900;});},265);}return r;};},5);})();</script></body></html>`;
    const r = await verdict(motionTest, pass(custom('motion', 'motion/sol5-1-replaced-mid-window', html, '2.2.2')));
    expect(r.observed, r.details).not.toBe('fail');
  }, 150_000);

  it('Sol r5 4: a timer banner that changes for 3 s and is cleared at 4.5 s is never failed when the page clock jumps 10 s after the test runs its timer early', async () => {
    const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Events</title>
<style>body{margin:0;font:16px/1.5 sans-serif;color:#1b1b1b;background:#fff}main{display:block;padding:0 24px}#bn{font:700 24px Arial;color:#00376d;padding:24px 0}</style></head>
<body><main><h1>Events</h1><p id="bn">Open house this Saturday</p></main>
<script>(function(){var t0=performance.now(),bn=document.getElementById('bn'),on=false,runs=0,jumped=false;
var realNow=Date.now,off=0;Date.now=function(){return realNow.call(Date)+off;};
var iv=setInterval(function(){runs++;if(performance.now()-t0<3000){on=!on;bn.style.color=on?'#b00020':'#00376d';bn.style.background=on?'#fff3c4':'#ffffff';}},1000);
var w=setInterval(function(){var e=performance.now()-t0;if(!jumped&&runs-Math.floor(e/1000)>=2){jumped=true;off+=10000;}if(e>=4500){clearInterval(iv);clearInterval(w);}},10);})();</script></body></html>`;
    const r = await verdict(motionTest, pass(custom('motion', 'motion/sol5-4-clock-jump', html, '2.2.2')));
    expect(r.observed, r.details).not.toBe('fail');
  }, 150_000);

  it('the 5.5 s row: a canvas moving 5.5 s from when the late content appears (r3\'s page, 5.5 s instead of 4.9 s): reported, either verdict', async () => {
    const canvas = '<canvas id="cv" width="600" height="120" role="img" aria-label="A moving wave"></canvas>';
    const html = shell({ title: 'News', late: `<p>News from the city.</p>${canvas}`, ms: 600_000 }).replace('</script>', `
(function(){var t0=performance.now();var id=setInterval(function(){if(performance.now()-t0<1900)return;clearInterval(id);var a=document.getElementById('app');a.innerHTML=document.getElementById('late').innerHTML;a.removeAttribute('aria-busy');var c=document.getElementById('cv'),g=c.getContext('2d'),q=performance.now();
function step(t){var d=t-q;if(d>5500)return;g.fillStyle='#eef3f8';g.fillRect(0,0,600,120);g.fillStyle='#00376d';g.fillRect((d/8)%520,30,80,60);requestAnimationFrame(step);}requestAnimationFrame(step);},100);})();
</script>`);
    const r = await verdict(motionTest, custom('motion', 'motion/canvas-5.5s-late', html, '2.2.2'));
    console.log(`[r4] 5.5 s canvas row: ${r.observed} | ${r.details}`);
    expect(['pass', 'fail']).toContain(r.observed);
  }, 150_000);
});

describe('a wall-clock jump is never counted as time (review r4, Sol 2)', () => {
  let browser: Browser;
  let server: Awaited<ReturnType<typeof startFixtureServer>>;
  // Mounts 2.5 s into the motion test's first pass (after its first look, before its late pass looks), then a
  // canvas changes for 4.9 s.
  const PAGE = shell({ title: 'News', late: '', ms: 600_000 }).replace('</script>', `
(function(){${ANCHOR}${DRAW}var id=setInterval(function(){if(at()<2500)return;clearInterval(id);var a=document.getElementById('app');a.innerHTML=${JSON.stringify(canvasHtml('cv'))};a.removeAttribute('aria-busy');var q=performance.now();draw(document.getElementById('cv'),function(){return performance.now()-q<4900;});},10);})();
</script>`);
  beforeAll(async () => {
    server = await startFixtureServer('site', { '/canvas.html': { type: 'text/html', body: PAGE } });
    browser = await chromium.launch();
  }, 30_000);
  afterAll(async () => {
    vi.restoreAllMocks();
    await browser?.close();
    await server?.close();
  });

  /**
   * The browser, with each page's mount looks watched: `onAnswer(answer, previous)` runs as a look's answer comes
   * back, before the watch has it (the look is still pending). The real context and page are kept (patched in
   * place): the guard tells requests apart by their page.
   */
  const watchLooks = (onAnswer: (answer: boolean, previous: boolean | undefined) => void): BrowserLike => {
    const watchPage = (page: Page) => {
      let last: boolean | undefined;
      const evaluate = page.evaluate.bind(page) as (fn: unknown, arg?: unknown) => Promise<unknown>;
      (page as unknown as { evaluate: unknown }).evaluate = async (fn: unknown, arg?: unknown) => {
        if (fn !== stillMounting) return evaluate(fn, arg);
        const r = await evaluate(fn, arg);
        onAnswer(r as boolean, last);
        last = r as boolean;
        return r;
      };
      return page;
    };
    const watchCtx = (ctx: BrowserContext) => {
      const newPage = ctx.newPage.bind(ctx);
      (ctx as unknown as { newPage: unknown }).newPage = async () => watchPage(await newPage());
      return ctx;
    };
    return new Proxy(browser, {
      get(target, k) {
        if (k === 'newContext') return async (o?: object) => watchCtx(await target.newContext(o));
        const v = Reflect.get(target, k, target) as unknown;
        return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    }) as unknown as BrowserLike;
  };

  it('Sol r4 2: a forward 10 s Date.now jump while the confirming look is pending neither certifies the hold nor fails a canvas that moves 4.9 s', async () => {
    const real = Date.now.bind(Date);
    let offset = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offset);
    let jumped = false;
    // The jump comes while the second look that sees the page mounted is pending (its answer is on its way).
    const b = watchLooks((answer, previous) => { if (answer === false && previous === false && !jumped) { jumped = true; offset += 10_000; } });
    try {
      // Time boxes long enough that the jump does not use them up (the run's deadline is wall-clock time; what is
      // tested here is the watch's hold and motion's own timing).
      const roomy = { ...motionProbe, timeoutMs: 60_000, late: { ...motionProbe.late!, timeoutMs: 60_000 } };
      const runs = await runProbes(b, [{ url: `${server.origin}/canvas.html`, index: 0 }], [roomy], { userAgent: 'grnted-test' });
      const motion = runs.find((r) => r.probe === 'motion')!;
      expect(jumped, JSON.stringify(runs)).toBe(true);
      expect(motion.data, JSON.stringify(motion.data)).toMatchObject({ late: { late: { mounted: true } } });
      expect(motion.findings.filter((f) => f.status === 'failed'), JSON.stringify(motion.findings)).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 180_000);
});
