// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The Task 4.4 probes in real Chromium (motion, audio, timing, motion-actuation, flash, watch).
// Fixture site: test/fixtures/motion/ (planted failures and clean controls, synthetic media only).
import { chromium, type Browser } from 'playwright';
import { PROBES } from '../../src/probes/registry.js';
import { motionSite, type MotionSite } from '../helpers/motionProbes.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motionProbe } from '../../src/probes/motion.js';
import { runProbes } from '../../src/probes/runner.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike } from '../../src/types.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { startSimServer } from '../sim/server.js';
import { motionCase } from '../sim/tests/motionAudio.js';

let browser: Browser;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
const B = () => browser as unknown as BrowserLike;
const OPTS = { userAgent: 'grnted-test', full: true };

beforeAll(async () => {
  server = await startFixtureServer('motion');
  browser = await chromium.launch();
}, 30_000);

afterAll(async () => {
  await browser?.close();
  await server?.close();
});

/** Runs one probe on the given fixture pages; returns path → run. */
async function probeOn(probe: PageProbe, paths: string[]): Promise<Record<string, ProbeRun>> {
  const runs = await runProbes(B(), paths.map((p, index) => ({ url: `${server.origin}/${p}`, index })), [probe], OPTS);
  return Object.fromEntries(runs.map((r) => [new URL(r.page).pathname.slice(1), r]));
}
const statuses = (r: ProbeRun) => r.findings.map((f) => f.status);
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

it('ACT parallel-content exception applies to motion first found by a late pass', async () => {
  const sim = await startSimServer({ files: { '/': `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Departure board</title>
<style>#board{font:32px monospace;padding:1rem;animation:pulse 1s linear infinite}@keyframes pulse{from{transform:translateX(0)}to{transform:translateX(40px)}}</style></head>
<body aria-busy="true"><p>Loading…</p><script>(function(){var start=performance.now();function mount(t){if(t-start<3000){requestAnimationFrame(mount);return;}document.body.innerHTML='<div id="board">Next bus: 4 min</div>';document.body.removeAttribute('aria-busy');}requestAnimationFrame(mount);})();</script></body></html>` } });
  try {
    const [run] = await runProbes(B(), [{ url: `${sim.origin}/`, index: 0 }], [motionProbe], OPTS);
    expect(run!.status).toBe('ok');
    expect(run!.data).toMatchObject({ mounting: true, late: { late: { mounted: true } } });
    expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_applicable', detail: expect.stringContaining('all the page shows') })]);
  } finally { await sim.close(); }
}, 60_000);

// Batch 17, item 1 (it reverses this test's first ruling, "an end during the check counts as the control working"): a stop
// that the motion's own end explains is no control's. A Hide that hid the ticker right after the press is credited all
// the same (hiding it is what 2.2.2 asks of it); a Pause that does nothing is left undecided (the run started again
// ends in its check too here: the test makes every end land there).
it.each(['hide', 'broken', 'revealed-hide', 'revealed-broken', 'broken-fetch'] as const)('Sol r11, batch 17 item 1: motion/ticker/8s/%s/scroll-snap, the motion ending during its check credits only a Hide that hid it', async (control) => {
  const revealed = control.startsWith('revealed-');
  const c = motionCase('ticker', 8, control.endsWith('hide') ? 'hide' : 'broken', 'scroll-snap', 1);
  // Sol r1 S9: a Pause whose click asks the server to change a setting, pressed twice (the first press, then the press
  // on the animation run again): every request a press sets off is blocked, none reaches the server.
  if (control === 'broken-fetch') c.site.files['/'] = (c.site.files['/'] as string).replace('onclick="void 0"', `onclick="window.simPresses = (window.simPresses || 0) + 1; if (window.simPresses === 2) fetch('/prefs?motion=0');"`);
  if (revealed) {
    c.site.files['/'] = (c.site.files['/'] as string).replace(/(<button type="button"[^>]*>(?:Hide|Pause)<\/button>)/,
      '<button type="button" id="show-controls" onclick="document.getElementById(\'motion-settings\').hidden=false">Motion settings</button><div id="motion-settings" hidden>$1</div>');
  }
  const sim = await startSimServer(c.site);
  let activated = false;
  let clicks = 0;
  const checked: unknown[] = [];
  const endsDuringCheck: PageProbe = {
    ...motionProbe,
    async run(ctx) {
      const page = ctx.page;
      const mouse = page.mouse!;
      const pinned = new Proxy(page, {
        get(target, key) {
          if (key === 'mouse') return {
            move: mouse.move.bind(mouse),
            async click(x: number, y: number) {
              if (revealed && await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.id === 'show-controls', { x, y })) {
                await mouse.click(x, y);
                return;
              }
              const remaining = await page.evaluate(() => {
                const a = document.getElementById('mover')!.getAnimations().find((a) => a.playState === 'running');
                return a ? Number(a.effect!.getComputedTiming().endTime) - Number(a.currentTime) : null;
              }, undefined);
              expect(remaining).not.toBeNull();
              await mouse.click(x, y);
              activated = true;
              clicks++;
              // Keep the real click and judging look; let the finite animation's natural end
              // fall between them, including when Hide cancels it before its end time.
              await page.waitForTimeout(remaining! + 100);
            },
          };
          if (key === 'evaluate') return async (fn: (a: unknown) => unknown, arg: unknown) => {
            // Keep discovery before the finite animation's end even on a loaded machine.
            // After the click its clock runs normally through the judging look.
            if (!activated && (fn.name === 'motionInventory' || fn.name === 'stillMoving')) {
              await page.evaluate(() => { for (const a of document.getElementById('mover')!.getAnimations()) a.currentTime = 1000; }, undefined);
            }
            const result = await page.evaluate(fn, arg);
            if (fn.name === 'stillMoving' && activated) checked.push(result);
            return result;
          };
          const value = Reflect.get(target, key, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return motionProbe.run({ ...ctx, page: pinned });
    },
  };
  try {
    const [run] = await runProbes(B(), [{ url: `${sim.origin}/`, index: 0 }], [endsDuringCheck], OPTS);
    expect(activated, JSON.stringify(run)).toBe(true);
    expect(checked, JSON.stringify(run)).toContainEqual(['ended']);
    expect(run!.status).toBe('ok');
    if (control === 'broken-fetch') {
      expect(sim.requests.filter((r) => r.includes('/prefs')), 'a press sent a request').toEqual([]);
      expect(clicks, 'the Pause was pressed on the first run and on the run started again').toBeGreaterThanOrEqual(2);
    }
    const shown = revealed ? ' (shown by "Motion settings")' : '';
    // The replayed press's request was stopped by the guard: no verdict on a control that needs the server.
    if (control === 'broken-fetch') { expect(run!.findings).toEqual([expect.objectContaining({ status: 'not_testable', target: '#mover' })]); return; }
    expect(run!.findings).toEqual([control.endsWith('hide')
      // A revealed Hide may be met by the control loop itself once "Motion settings" has shown it.
      ? expect.objectContaining({ status: 'no_failures_found', target: '#mover', detail: expect.stringMatching(/the control "Hide the banner"( \(shown by "Motion settings"\))? stops it/) })
      : expect.objectContaining({ status: 'not_testable', target: '#mover', detail: expect.stringContaining(`came to its own end while the control "Pause"${shown} was checked`) })]);
  } finally { await sim.close(); }
}, 90_000);

describe('motion probe (2.2.2)', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, [
      'carousel-auto.html', 'carousel-pause.html', 'banner.html', 'banner-stop.html', 'static.html', 'gif.html', 'video.html', 'video-pause.html', 'canvas.html',
      'frame-carousel.html', 'frame-carousel-auto.html', 'carousel-server.html', 'carousel-hover.html', 'carousel-auto-navlink.html',
      'carousel-verb-scrolling-list.html', 'carousel-verb-news-ticker.html', 'carousel-verb-logo-carousel.html', 'carousel-verb-testimonials.html', 'carousel-hover-5s.html',
    ]);
  }, 180_000);

  it('fails a carousel when the page only has links named like media ("Video", "Slideshow"): navigation links are not controls', () => {
    expect(failed(runs['carousel-auto-navlink.html']!)[0]).toMatchObject({ target: '#hero', detail: expect.stringContaining('changes by itself every 3 s') });
  });

  it('fails moving content that has no working pause, stop or hide control', () => {
    for (const page of ['carousel-auto.html', 'banner.html', 'gif.html', 'video.html', 'canvas.html', 'frame-carousel-auto.html', 'carousel-hover.html']) {
      expect(runs[page]!.status, page).toBe('ok');
      expect(failed(runs[page]!), `${page}: ${JSON.stringify(runs[page]!.findings)}`).toHaveLength(1);
    }
    expect(failed(runs['carousel-auto.html']!)[0]).toMatchObject({ target: '#hero', detail: expect.stringContaining('changes by itself every 3 s') });
    expect(failed(runs['banner.html']!)[0]!.detail).toContain('CSS animation "scroll"');
    expect(failed(runs['gif.html']!)[0]!.detail).toContain('animated image (2 frames, looping forever)');
    expect(failed(runs['video.html']!)[0]!.detail).toContain('a video that plays by itself (looping, muted)');
    expect(failed(runs['canvas.html']!)[0]!.detail).toContain('canvas animation');
    expect(failed(runs['frame-carousel-auto.html']!)[0]).toMatchObject({ target: expect.stringContaining('iframe'), detail: expect.stringContaining('moving content in an embedded frame (content that changes by itself every 3 s)') });
    // Pausing on hover is not a control: the mouse is moved away before the check.
    expect(failed(runs['carousel-hover.html']!)[0]!.detail).toContain('no pause, stop or hide control was found');
  });

  it('a control named with a control verb and ordinary nouns is tried: "Pause scrolling list", "Pause news ticker", "Stop logo carousel", "Pause testimonials"', () => {
    for (const [page, name] of [['carousel-verb-scrolling-list.html', 'Pause scrolling list'], ['carousel-verb-news-ticker.html', 'Pause news ticker'], ['carousel-verb-logo-carousel.html', 'Stop logo carousel'], ['carousel-verb-testimonials.html', 'Pause testimonials']]) {
      expect(runs[page!]!.findings, page).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining(`"${name}" stops it`) })]);
    }
  });

  it('fails a slider that advances every 5 s and pauses only on hover', () => {
    expect(failed(runs['carousel-hover-5s.html']!)[0]).toMatchObject({ target: '#hero', detail: expect.stringContaining('no pause, stop or hide control was found') });
  });

  it('tries controls inside an embedded frame', () => {
    // Sol r1 S11: inside a frame a control's stop cannot be told from the motion's own end: undecided.
    expect(runs['frame-carousel.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Pause slideshow (inside the frame)" was pressed, but inside an embedded frame') })]);
  });

  it('gives no verdict when the only control needs the server', () => {
    expect(runs['carousel-server.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', target: '#hero', detail: expect.stringContaining('POST request') })]);
  });

  it('finds and verifies working controls, and reports nothing on a still page', () => {
    for (const page of ['carousel-pause.html', 'banner-stop.html', 'video-pause.html', 'static.html']) {
      expect(runs[page]!.status, page).toBe('ok');
      expect(statuses(runs[page]!), `${page}: ${JSON.stringify(runs[page]!.findings)}`).not.toContain('failed');
    }
    expect(runs['carousel-pause.html']!.findings[0]!.detail).toContain('"Pause slideshow" stops it');
    expect(runs['banner-stop.html']!.findings[0]!.detail).toContain('"Stop scrolling" stops it');
    expect(runs['video-pause.html']!.findings[0]!.detail).toContain('"Pause background video" stops it');
    expect(runs['static.html']!.findings).toEqual([{ criterion: '2.2.2', status: 'no_failures_found', detail: expect.stringContaining('nothing moved') }]);
  });
});

describe('motion probe: one item per moving region, whatever the animation\'s phase', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['banner.html', 'banner-late.html']);
  }, 120_000);

  it('folds what the screenshots see moving into the animation that moves it (the ticker and its text are one item)', () => {
    for (const page of ['banner.html', 'banner-late.html']) {
      expect(runs[page]!.status, page).toBe('ok');
      expect(runs[page]!.findings, `${page}: ${JSON.stringify(runs[page]!.findings)}`).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('CSS animation "scroll"') })]);
    }
  });
});

describe('motion probe: controls it must not click, frames, loading indicators and focus', () => {
  let site: MotionSite;
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    site = await motionSite();
    runs = await site.run([motionProbe], ['control-logout.html', 'control-unsafe.html', 'focus-pause.html', 'spinner.html', 'frame-cross.html'], { concurrency: 3 });
  }, 180_000);
  afterAll(async () => { await site?.close(); });
  const one = (page: string) => runs[page]![0]!.findings;

  it('never clicks a log out control picked by its class name (btn-close, pause-icon)', () => {
    expect(site.requests.filter((r) => r.includes('/api/session/terminate'))).toEqual([]);
    expect(one('control-logout.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('no pause, stop or hide control was found') })]);
  });

  it('gives no verdict when the only pause controls would submit a form, follow a link or run a javascript: link', () => {
    expect(one('control-unsafe.html')).toEqual([expect.objectContaining({ status: 'not_testable', target: '#hero', detail: expect.stringContaining('controls not tried because a click could act on the site') })]);
    const detail = one('control-unsafe.html')[0]!.detail;
    expect(detail).toContain('it would submit a form');
    expect(detail).toMatch(/it is a link/);
    expect(site.requests.filter((r) => /\/(preferences|player\/pause)/.test(r))).toEqual([]);
  });

  // Merge (batch 15b): the ACT lane's 'pause only while focused does not count' holds; the visual lane's precision
  // rule decides the verdict: not credited, and not failed on that alone.
  it('does not credit content that pauses only while keyboard focus is inside it and moves on when focus leaves (review r2, finding 10): not decided', () => {
    expect(one('focus-pause.html')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('it stops only while keyboard focus is inside it') })]);
  });

  it('leaves out spinners, progress bars and busy regions', () => {
    expect(one('spinner.html')).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('3 loading indicators') })]);
  });

  it('enters a cross-origin frame (the browser runs the test code there) and judges its carousel', () => {
    expect(one('frame-cross.html')).toEqual([expect.objectContaining({ status: 'failed', target: '#f', detail: expect.stringContaining('embedded frame (content that changes by itself every 3 s)') })]);
  });
});

describe('the four core motion probes together, through the registry, on a hostile page', () => {
  let site: MotionSite;
  let runs: ProbeRun[];
  beforeAll(async () => {
    site = await motionSite();
    const group = PROBES.filter((p) => ['timing', 'audio', 'motion', 'motion-actuation'].includes(p.id));
    runs = (await site.run(group, ['hostile.html']))['hostile.html']!;
  }, 120_000);
  afterAll(async () => { await site?.close(); });

  it('runs them on one page in registry order (timing last)', () => {
    expect(runs.map((r) => r.probe)).toEqual(['audio', 'motion', 'motion-actuation', 'timing']);
  });

  it('lets no POST, no action address and no second load of the page reach the server', () => {
    const seen = site.requests;
    expect(seen.filter((r) => !r.startsWith('GET ') && !r.startsWith('HEAD '))).toEqual([]);
    expect(seen.filter((r) => /logout|delete|terminate|session|preferences/i.test(r))).toEqual([]);
    // Two loads, both the runner's: the page, and timing's fresh copy (motion ran its timers early,
    // `freshAfterFiredTimers`). The page's own reload timer (run early by both) never reaches the server.
    expect(seen.filter((r) => r.startsWith('GET /hostile.html'))).toHaveLength(2);
  });

  it('gives no clean result where the guard had to stop something', () => {
    const byProbe = Object.fromEntries(runs.map((r) => [r.probe, r]));
    // The timers navigate (held/trapped) and post: failed or not_testable, never clean.
    expect(byProbe.timing!.findings.map((f) => f.status)).not.toContain('no_failures_found');
    // The mute control posts: not_testable.
    expect(byProbe.audio!.findings).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'not_testable' })]));
    // The carousel's pause-like controls: a submit button, a real link and a "Sign out" button (never
    // tried), and "Mute music" (a control verb, tried): its POST is stopped, so no clean result.
    expect(byProbe.motion!.findings).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('would have sent data to the live site') })]));
    expect(byProbe.motion!.findings.map((f) => f.status)).not.toContain('no_failures_found');
    expect(byProbe['motion-actuation']!.findings.map((f) => f.status)).not.toContain('no_failures_found');
  });
});

describe('round 2: control names, busy regions, motion the guard stopped, unreadable rechecks', () => {
  let site: MotionSite;
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    site = await motionSite();
    runs = await site.run([motionProbe], ['control-words.html', 'busy-main.html', 'motion-blocked.html'], { concurrency: 3 });
  }, 180_000);
  afterAll(async () => { await site?.close(); });
  const one = (page: string) => runs[page]![0]!.findings;

  it('clicks only short names made of control words, and no link-like button', () => {
    // "Close account", "Stop subscription", "Start free trial", "Pause membership" and the three
    // <a role=button> (javascript:, empty href, #/route) are never clicked.
    expect(site.requests.filter((r) => r.includes('/api/'))).toEqual([]);
    const f = one('control-words.html');
    expect(f).toEqual([expect.objectContaining({ status: 'not_testable', target: '#hero', detail: expect.stringContaining('controls not tried') })]);
    expect(f[0]!.detail).toContain('it is a javascript: link');
    expect(f[0]!.detail).not.toMatch(/account|subscription|trial|membership|payments|emails|sharing/);
  });

  it('does not exempt content inside an aria-busy region', () => {
    expect(one('busy-main.html')).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('CSS animation "scroll"') })]);
  });

  it('gives no clean result when the guard stopped what would have moved (a POSTed headline, an image at an action address)', () => {
    expect(one('motion-blocked.html')).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('would have sent data to the live site') })]);
  });
});

describe('round 2: motion the guard stopped, on a busy machine (each guard decision 1 s late)', () => {
  let site: MotionSite;
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    // Reproduces the clean result seen once under load: the POST the page's timer made reached the
    // guard's log only after the probe's measuring window had closed.
    site = await motionSite({ guardDelayMs: 1000 });
    runs = await site.run([motionProbe], ['motion-blocked.html', 'motion-blocked-post.html', 'gif.html', 'motion-action-gif.html'], { concurrency: 2 });
  }, 180_000);
  afterAll(async () => { await site?.close(); });

  it('still gives no clean result when the guard stopped what would have moved', () => {
    for (const page of ['motion-blocked.html', 'motion-blocked-post.html']) {
      expect(runs[page]![0]!.findings, page).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('would have sent data to the live site') })]);
    }
  });

  it('still fails an animated image that loaded with the page and has no pause control', () => {
    expect(runs['gif.html']![0]!.findings).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('animated image (2 frames, looping forever)') })]);
  });

  it('never gives a clean result for an animated image whose frames the guard keeps the test from reading', () => {
    // Failed when the screenshots catch it moving, not_testable when they do not: never clean.
    const statuses = runs['motion-action-gif.html']![0]!.findings.map((f) => f.status);
    expect(statuses.length).toBeGreaterThan(0);
    expect(statuses.every((st) => st === 'failed' || st === 'not_testable'), JSON.stringify(runs['motion-action-gif.html']![0]!.findings)).toBe(true);
  });
});

describe('round 2: an item that looks stopped when the guard stopped something in the measuring window', () => {
  let site: MotionSite;
  let run: ProbeRun;
  beforeAll(async () => {
    // The first and second looks see the canvas move; from the fifth screenshot on the screen looks
    // frozen, as when two screenshots of a looping animation happen to match.
    site = await motionSite({
      onPage: (page) => {
        let n = 0;
        let last: Buffer | undefined;
        const shot = page.screenshot.bind(page);
        page.screenshot = (async (o?: Parameters<typeof shot>[0]) => {
          if (++n > 4 && last) return last;
          last = await shot(o);
          return last;
        }) as typeof page.screenshot;
      },
    });
    run = (await site.run([motionProbe], ['canvas-post.html']))['canvas-post.html']![0]!;
  }, 120_000);
  afterAll(async () => { await site?.close(); });

  it('gives no clean result: what the guard stopped could have been what kept it moving', () => {
    expect(run.status).toBe('ok');
    expect(run.findings.map((f) => f.status), JSON.stringify(run.findings)).not.toContain('no_failures_found');
    expect(run.findings).toEqual(expect.arrayContaining([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('would have sent data to the live site') })]));
  });
});

describe('round 2: a recheck that cannot take screenshots', () => {
  let site: MotionSite;
  let run: ProbeRun;
  beforeAll(async () => {
    // Discovery screenshots work, including the looks during the recheck wait. The item's
    // clipped screenshots fail when judgment checks whether it stopped.
    site = await motionSite({
      onPage: (page) => {
        const shot = page.screenshot.bind(page);
        page.screenshot = (async (o?: Parameters<typeof shot>[0]) => { if (o?.clip) throw new Error('screenshot failed'); return shot(o); }) as typeof page.screenshot;
      },
    });
    run = (await site.run([motionProbe], ['two-items.html']))['two-items.html']![0]!;
  }, 120_000);
  afterAll(async () => { await site?.close(); });

  it('gives that item no verdict and keeps the failure already found for another', () => {
    expect(run.status).toBe('ok');
    expect(run.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'not_testable', target: '#c', detail: expect.stringContaining('screenshots failed while checking whether it stopped') }),
      expect.objectContaining({ status: 'failed', detail: expect.stringContaining('CSS animation "scroll"') }),
    ]));
  });
});

describe('round 2: timing runs last, so its early timers cannot hide media or motion', () => {
  let site: MotionSite;
  let runs: ProbeRun[];
  beforeAll(async () => {
    site = await motionSite();
    const group = PROBES.filter((p) => ['timing', 'audio', 'motion', 'motion-actuation'].includes(p.id));
    runs = (await site.run(group, ['timing-last.html']))['timing-last.html']!;
  }, 120_000);
  afterAll(async () => { await site?.close(); });

  it('audio still hears the music and motion still sees the carousel the 15-minute timer would stop', () => {
    const byProbe = Object.fromEntries(runs.map((r) => [r.probe, r]));
    expect(runs.map((r) => r.probe)).toEqual(['audio', 'motion', 'motion-actuation', 'timing']);
    expect(byProbe.audio!.findings).toEqual([expect.objectContaining({ status: 'failed', detail: expect.stringContaining('an audio player (looping)') })]);
    expect(byProbe.motion!.findings).toEqual([expect.objectContaining({ status: 'failed', target: '#hero' })]);
    // Sol r1 S1: the words alone, with no field taken away, show no limit running out.
    expect(byProbe.timing!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('Your session has expired') })]);
  });
});

// A 250 ms ticker cycling three texts (a 750 ms period; the navigator fixture decoy-ticker.html). Two
// screenshots a cycle apart show the same text: the recheck of a moving region must not take that for
// "stopped" (the 2.2.2 verdict flipped between runs on a busy machine).
describe('motion probe: a fast ticker whose screenshots land on the same text', () => {
  let nav: Awaited<ReturnType<typeof startFixtureServer>>;
  beforeAll(async () => { nav = await startFixtureServer('navigator'); }, 30_000);
  afterAll(async () => { await nav?.close(); });
  const TICKER_FAILED = [{ status: 'failed', target: '#ticker' }];
  const shown = (r: ProbeRun) => r.findings.filter((f) => f.criterion === '2.2.2').map((f) => ({ status: f.status, target: f.target }));
  const once = async (probe: PageProbe) => (await runProbes(B(), [{ url: `${nav.origin}/decoy-ticker.html`, index: 0 }], [probe], OPTS))[0]!;

  // Pinned: the ticker is found on screen (as on a busy machine, where the first DOM look misses it), and
  // every screenshot of the region (the recheck's, clipped) is taken with the same text showing, as when
  // the gap between them is a whole cycle; the ticker keeps changing in between. The pinned text is set
  // while the screenshot mutes the probe's record of changes, so it is not seen as the ticker's.
  const aliased: PageProbe = {
    ...motionProbe,
    async run(ctx) {
      const page = ctx.page;
      let firstDomLook = true;
      const screenshot = async (o?: { clip?: unknown }) => {
        if (o?.clip) await page.evaluate(() => { document.getElementById('ticker')!.textContent = 'Bus 12 runs late today'; }, undefined);
        return page.screenshot!(o as never);
      };
      const evaluate = async (fn: unknown, arg: unknown) => {
        const out = await page.evaluate(fn as (a: unknown) => unknown, arg);
        if (typeof fn === 'function' && fn.name === 'domChanges' && firstDomLook) { firstDomLook = false; return []; }
        return out;
      };
      const pinned = new Proxy(page, { get: (t, p) => (p === 'screenshot' ? screenshot : p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return motionProbe.run({ ...ctx, page: pinned as typeof page });
    },
  };

  it('RED (determinism): the recheck\'s screenshots all show the same text: still failed, never "stopped by a control tried earlier"', async () => {
    expect(shown(await once(aliased))).toEqual(TICKER_FAILED);
  }, 90_000);

  it('the same page gives the same 2.2.2 result every time', async () => {
    for (let k = 0; k < 4; k++) expect(shown(await once(motionProbe))).toEqual(TICKER_FAILED);
  }, 180_000);
});

// An item that is still when it is judged, before any control was clicked, did not stop because of one.
describe('motion probe: an item that looks still before any control was tried', () => {
  // Pinned: the first check of whether it still moves comes after the animations have run to their own
  // end (waited for, not jumped there with finish(): an animation jumped to its end did not run its
  // course) and after what the page does when they end (animationend).
  const endsFirst: PageProbe = {
    ...motionProbe,
    async run(ctx) {
      const page = ctx.page;
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function' && fn.name === 'stillMoving' && first) {
          first = false;
          await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => true), undefined);
          await page.waitForTimeout(200);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return motionProbe.run({ ...ctx, page: pinned as typeof page });
    },
  };

  const motionOf = (r: ProbeRun) => r.findings.filter((x) => x.criterion === '2.2.2');
  // A 6 s slide ran its own course of more than 5 s by itself: having stopped does not pass it (sim lab:
  // finite motion of 5.5 s and more was passed once it had ended). WCAG 2.2.2 asks for a way to stop motion
  // that lasts more than 5 s; this one lasted that long with no control shown to stop it, so it failed,
  // also when a Pause button is on the page (it cannot be checked on motion that has ended, and the
  // motion ran its 5 s without it). Never "a control tried earlier".
  it('RED (e2e): nothing was clicked: a 6 s slide that ended by itself is failed, also with a Pause button that does nothing; one that works is checked on it run again', async () => {
    const f = motionOf((await probeOn(endsFirst, ['ends-by-itself.html']))['ends-by-itself.html']!);
    expect(f.map((x) => x.status)).toEqual(['failed']);
    // Said as an item still moving with no control is (act-watch review r1, F6c: the text does not depend on when
    // the test came back to it).
    expect(f[0]!.detail).toMatch(/runs for 6 s; nothing on the page pauses, stops or hides it \(no pause, stop or hide control was found\)$/);
    // With a Pause button that does nothing (the review's case): failed. The animation is run again from
    // its start to check the button on it, and it keeps moving.
    const g = motionOf((await probeOn(endsFirst, ['ends-by-itself-noop.html']))['ends-by-itself-noop.html']!);
    expect(g.map((x) => x.status)).toEqual(['failed']);
    expect(g[0]!.detail).toMatch(/nothing on the page pauses, stops or hides it \(controls tried, without effect: "Pause"\)$/);
    // With a Pause button that works: shown to work on the animation run again, so it passes.
    const h = motionOf((await probeOn(endsFirst, ['ends-by-itself-pause.html']))['ends-by-itself-pause.html']!);
    expect(h.map((x) => x.status)).toEqual(['no_failures_found']);
    expect(h[0]!.detail).toMatch(/its controls were checked on it run again from its start\): the control "Pause" stops it$/);
    for (const x of [...f, ...g, ...h]) expect(x.detail).not.toMatch(/control tried earlier/);
  }, 180_000);

  it('RED (e2e): a 6 s slide whose animation the page removes when it ends, and a 6 s fade-out to opacity 0, are failed; a 4 s intro removed when it ends passes', async () => {
    const r = await probeOn(endsFirst, ['slide-6000-cleanup.html', 'fade-out-6000.html', 'intro-4000-cleanup.html']);
    const got = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, motionOf(v).map((x) => x.status)]));
    expect(got).toEqual({ 'slide-6000-cleanup.html': ['failed'], 'fade-out-6000.html': ['failed'], 'intro-4000-cleanup.html': ['no_failures_found'] });
  }, 180_000);

  // Pinned: the first look comes after the page's timer has stopped (window.__simDone), so the test
  // judges from what the timer did by itself.
  const timerDone: PageProbe = {
    ...motionProbe,
    async run(ctx) {
      const page = ctx.page;
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function' && fn.name === 'stillMoving' && first) {
          first = false;
          for (let i = 0; i < 100 && !(await page.evaluate(() => (window as unknown as { __simDone?: boolean }).__simDone === true, undefined)); i++) await page.waitForTimeout(100);
          await page.waitForTimeout(100);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return motionProbe.run({ ...ctx, page: pinned as typeof page });
    },
  };

  it('RED (e2e): a ticker that updates every 2 s and clears on the run of its last update at 6 s, and a 6 s chain of timeouts, are failed', async () => {
    const r = await probeOn(timerDone, ['ticker-6s-same-tick.html', 'ticker-6s-chained.html', 'carousel-stops-4500.html']);
    const got = Object.fromEntries(Object.entries(r).map(([k, v]) => [k, motionOf(v).map((x) => x.status)]));
    // The 4.5 s carousel (last change at 3 s, cleared at 4.5 s without one) still passes.
    expect(got).toEqual({ 'ticker-6s-same-tick.html': ['failed'], 'ticker-6s-chained.html': ['failed'], 'carousel-stops-4500.html': ['no_failures_found'] });
  }, 180_000);

  it('motion of 5 s or less that ended by itself still passes; 5.5 s fails', async () => {
    const r = await probeOn(endsFirst, ['slide-4500.html', 'slide-5500.html']);
    expect(motionOf(r['slide-4500.html']!).map((x) => x.status)).toEqual(['no_failures_found']);
    expect(motionOf(r['slide-5500.html']!).map((x) => x.status)).toEqual(['failed']);
  }, 180_000);

  // Pinned: every look at whether it still moves lands in the half second the blink is at opacity 0.
  const darkPhase: PageProbe = {
    ...motionProbe,
    async run(ctx) {
      const page = ctx.page;
      const evaluate = async (fn: unknown, arg: unknown) => {
        if (typeof fn === 'function' && (fn.name === 'stillMoving' || fn.name === 'motionInventory')) {
          await page.evaluate(() => { for (const a of document.getAnimations()) a.currentTime = 600 + 1000 * Math.floor(Number(a.currentTime ?? 0) / 1000); }, undefined);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const pinned = new Proxy(page, { get: (t, p) => (p === 'evaluate' ? evaluate : (Reflect.get(t, p, t) as unknown)) });
      return motionProbe.run({ ...ctx, page: pinned as typeof page });
    },
  };

  it('RED (e2e): a blink at opacity 0 by its own animation is blinking, not hidden: a Pause button that does nothing is not credited', async () => {
    const f = motionOf((await probeOn(darkPhase, ['blink-broken.html']))['blink-broken.html']!);
    expect(f.map((x) => x.status)).toEqual(['failed']);
    expect(f[0]!.detail).toMatch(/CSS animation "blink" on p starts by itself and runs with no end; nothing on the page pauses, stops or hides it \(controls tried, without effect: "Pause"\)/);
  }, 90_000);

  it('a carousel that hides the slide a timer changed between steps is still changing, not stopped', async () => {
    const f = motionOf((await probeOn(motionProbe, ['carousel-slides-hidden.html']))['carousel-slides-hidden.html']!);
    expect(f.map((x) => x.status)).toEqual(['failed']);
    expect(f[0]!.detail).toMatch(/changes by itself every 1\.5 s/);
    // The same carousel stopping by itself after 4.5 s is caught running, but looked at again once 5 s
    // have passed since its timer was set: it passes (sim lab: 3 s and 4.5 s carousels were failed).
    const g = motionOf((await probeOn(motionProbe, ['carousel-stops-4500.html']))['carousel-stops-4500.html']!);
    expect(g.map((x) => x.status)).toEqual(['no_failures_found']);
  }, 90_000);

  it('after a control was really clicked (it paused a first item), a second item that stopped with it keeps "a control tried earlier"', async () => {
    const f = motionOf((await probeOn(motionProbe, ['two-banners-one-pause.html']))['two-banners-one-pause.html']!);
    expect(f.map((x) => x.status)).toEqual(['no_failures_found', 'no_failures_found']);
    expect(f.map((x) => x.detail).join(' ')).toMatch(/the control "Pause" stops it/);
    expect(f.map((x) => x.detail).join(' ')).toMatch(/stopped or was hidden by a control tried earlier/);
  }, 90_000);
});

// 2026-11-09 benchmark review. WCAG 2.2.2 applies to content "presented in parallel with other content"; a pause
// control may sit in a panel a visible button opens; auto-updating content may instead let the user set how often it
// updates. Look-alikes: the same board next to other content fails, and a panel whose pause button does nothing fails.
describe('motion probe (2.2.2): only content, controls in a panel, update frequency', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['updating-only.html', 'updating-with-text.html', 'ticker-settings-ok.html', 'ticker-settings-broken.html', 'ticker-hidden-pause.html', 'scores-frequency.html']);
  }, 180_000);

  it('updating content that is all the page shows is not applicable; next to other content it fails', () => {
    expect(runs['updating-only.html']!.findings).toEqual([expect.objectContaining({ status: 'not_applicable' })]);
    expect(failed(runs['updating-with-text.html']!)).toEqual([expect.objectContaining({ target: '#board' })]);
  });

  it('opens a settings panel to reach its pause button; a pause button that does nothing still fails', () => {
    expect(runs['ticker-settings-ok.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('"Pause updates" (shown by "News settings") stops it') })]);
    expect(failed(runs['ticker-settings-broken.html']!)).toEqual([expect.objectContaining({ target: '#ticker', detail: expect.stringContaining('"Pause updates"') })]);
  });

  it('a pause button that is hidden and that no control shows: not testable, never failed; a control for how often it updates whose "never" setting stops it passes', () => {
    expect(runs['ticker-hidden-pause.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Pause updates"') })]);
    // Since 2026-11-10 the setting that stops the updates is tried (test/integration/motionHolds.test.ts has the
    // control with no such setting: still not testable, never failed).
    expect(runs['scores-frequency.html']!.findings).toEqual([expect.objectContaining({ status: 'no_failures_found', detail: expect.stringContaining('"Update scores every" set to "never" stops it') })]);
  });
});

// Red-team 2026-11-10 (coverage lane, three false alarms of one kind): a frequency control that sits inside its
// label. The label's text ran straight into the control's own options ("…intervalEvery 2 seconds"), so the words
// that say what the control is for were never read as words, and the updating content was failed.
describe('motion probe (2.2.2): a frequency control wrapped by its label', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['readings-frequency-wrapped.html', 'readings-units-wrapped.html']);
  }, 180_000);

  it('is read by its label\'s own words: not testable, never failed', () => {
    expect(runs['readings-frequency-wrapped.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Refresh interval"') })]);
  });

  it('look-alike: the same select inside its label that only sets the unit shown still fails', () => {
    expect(failed(runs['readings-units-wrapped.html']!)).toEqual([expect.objectContaining({ target: '#reading' })]);
  });
});

// Round-2 review (2026-11-10, finding 5; the lead's decision): a frequency control with a label ancestor is not
// testable, never failed, whatever sits between the label and the control. The reviewer's input: the label's words
// and the select together in a span inside the label.
describe('motion probe (2.2.2): a frequency control under any label ancestor', () => {
  let runs: Record<string, ProbeRun>;
  beforeAll(async () => {
    runs = await probeOn(motionProbe, ['readings-frequency-nested.html', 'readings-frequency-unread.html', 'readings-units-nested.html']);
  }, 180_000);

  it('the label\'s words and the control in a span inside the label: read, not testable, never failed', () => {
    expect(runs['readings-frequency-nested.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('"Refresh interval" may set how often it updates') })]);
  });

  it('a label with no words of its own, on a control with no other name: what it is for cannot be read, so not testable', () => {
    expect(runs['readings-frequency-unread.html']!.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('a control whose label could not be read') })]);
  });

  it('look-alike: the same nesting around a select that only sets the unit shown still fails', () => {
    expect(failed(runs['readings-units-nested.html']!)).toEqual([expect.objectContaining({ target: '#reading' })]);
  });
});

// Act-watch review r1, F6 (base code this lane now runs on every page with a script): the moving alert bar.
describe('the pause, stop or hide control the scan could not take (review r1 F6)', () => {
  const motionOf = (r: ProbeRun) => r.findings.filter((x) => x.criterion === '2.2.2');
  it('RED: "Pause service alerts" (a pause verb with a site topic) beside a moving bar is not tried, and the bar has no verdict instead of "no control was found"', async () => {
    const r = motionOf((await probeOn(motionProbe, ['alertbar-pause-service.html']))['alertbar-pause-service.html']!);
    expect(r.map((f) => f.status)).toEqual(['not_testable']);
    expect(r[0]!.detail).toContain('"Pause service alerts"');
  }, 120_000);

  it('RED: a Close or Dismiss button in the bar that hides it counts as a hide control; one that does nothing still fails', async () => {
    const runs = await probeOn(motionProbe, ['alertbar-close.html', 'alertbar-dismiss-icon.html', 'alertbar-close-noop.html']);
    for (const page of ['alertbar-close.html', 'alertbar-dismiss-icon.html']) {
      const r = motionOf(runs[page]!);
      expect(r.map((f) => f.status), page).toEqual(['no_failures_found']);
      expect(r[0]!.detail, page).toMatch(/stops it/);
    }
    const noop = motionOf(runs['alertbar-close-noop.html']!);
    expect(noop.map((f) => f.status)).toEqual(['failed']);
    expect(noop[0]!.detail).toContain('controls tried, without effect: "Close"');
  }, 180_000);

  it('RED: an animation declared endless that the script stops after 4 s (its fourth round) is looked at again once 5 s have passed: not failed', async () => {
    const r = motionOf((await probeOn(motionProbe, ['pulse-stops-4s.html']))['pulse-stops-4s.html']!);
    expect(r.filter((f) => f.status === 'failed')).toEqual([]);
  }, 120_000);
});
