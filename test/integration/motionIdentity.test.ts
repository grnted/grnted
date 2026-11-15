// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Sol's mechanism counterexamples, with parallel content per the batch 15b applicability ruling.
// Only the runner's clock and waits are controlled; Chromium supplies hit tests, identities and PNGs.
import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { motionProbe, type ShotIdentity } from '../../src/probes/motion.js';
import { LISTENER_HOOK_SCRIPT, readHooks } from '../../src/probes/listeners.js';
import { ACTION_NAME, ALTERNATIVES, installPointerKit, POINTER_KEY } from '../../src/probes/pointerKit.js';
import { DOCUMENT_ID_SCRIPT } from '../../src/probes/runner.js';
import type { ProbeContext } from '../../src/probes/types.js';
import type { PageLike } from '../../src/types.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); });
afterAll(async () => { await browser?.close(); });
afterEach(() => { vi.restoreAllMocks(); });

// Outside every moving region and its container, including the persistent replacement parent.
const PARALLEL_CONTENT = '<section style="position:absolute;left:800px;top:180px;width:400px"><h1>City news</h1><p>Road maintenance starts on Monday.</p></section>';

const context = (page: PageLike): ProbeContext => ({
  page, deadline: Date.now() + 25_000, ends: 25_000, signal: new AbortController().signal,
  hooks: () => page.evaluate(readHooks, undefined),
  guard: { mark: () => 0, since: () => [], settled: async () => true },
}) as unknown as ProbeContext;

// Batch 17, item 1: a stop is credited only when the motion would still be running when it is seen stopped. Focus
// cancels this ticker at 7,800 ms, but it is seen stopped at 8,100 ms, after its own end time (8,000 ms): undecided,
// never failed (it passed before; a look right after the press is a ranked idea in the motion-pointer triage).
it('Sol r12, batch 17 item 1: focus cancelling an 8 s ticker at 7,800 ms, seen at 8,100 ms after its own end time, is undecided', async () => {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<style>
      #ticker { width: 600px; height: 120px; animation: ticker 8s linear both; }
      #ticker:focus { animation: none; }
      @keyframes ticker { from { transform: translateX(0); } to { transform: translateX(240px); } }
    </style><div id="ticker" tabindex="0">Road closures this week</div>${PARALLEL_CONTENT}`);
    await page.evaluate(LISTENER_HOOK_SCRIPT);
    let now = 1000, focused = false;
    const checked: unknown[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const evaluate = page.evaluate.bind(page);
    const clocked = new Proxy(page, {
      get(target, key) {
        if (key === 'waitForTimeout') return async (ms: number) => { now += ms; };
        if (key === 'evaluate') return async (fn: (arg: unknown) => unknown, arg: unknown) => {
          if (fn.name === 'motionInventory' || fn.name === 'stillMoving') {
            // Keep discovery at 1 s, start judgment at the review's 7,800 ms, and let
            // the real focus rule cancel the animation before the 300 ms judging wait.
            const time = fn.name === 'motionInventory' ? 1000 : focused ? now : (now = 7800);
            await evaluate(({ time, focused }) => {
              Object.defineProperty(document.timeline, 'currentTime', { configurable: true, value: time });
              if (!focused) for (const a of document.getElementById('ticker')!.getAnimations()) a.currentTime = time;
            }, { time, focused });
          }
          const result = await evaluate(fn, arg);
          if (fn.name === 'focusInside') focused = result === true;
          if (fn.name === 'stillMoving') checked.push({ time: now, result });
          return result;
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PageLike;
    const findings = await motionProbe.run(context(clocked));
    expect(focused).toBe(true);
    expect(checked).toEqual([{ time: 7800, result: [true] }, { time: 8100, result: ['ended'] }]);
    expect(findings).toEqual([expect.objectContaining({
      status: 'not_testable', target: '#ticker',
      detail: expect.stringContaining('came to its own end while keyboard focus was moved inside it'),
    })]);
  } finally { await page.close(); }
}, 30_000);

async function canvasMotion(replace: boolean, deviceScaleFactor = 1, edge = false, parallel = true) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor });
  try {
    await ctx.addInitScript({ content: LISTENER_HOOK_SCRIPT });
    const page = await ctx.newPage();
    const y = edge ? 880 : 24;
    const canvas = `<canvas id="A" width="120" height="20" style="position:absolute;left:0;top:${y}px"></canvas>`;
    await page.setContent(`<style>body{margin:0}</style>${replace ? `<div id="parent" style="position:absolute;width:160px;height:160px">${canvas}</div>` : canvas}${parallel ? PARALLEL_CONTENT : ''}`);
    let now = 0, frame = 0;
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const evaluate = page.evaluate.bind(page);
    const waits: number[] = [];
    const clocked = new Proxy(page, {
      get(target, key) {
        if (key === 'waitForTimeout') return async (ms: number) => {
          waits.push(ms);
          now += ms;
          await evaluate(({ now, frame, replace }) => {
            let c = document.querySelector('canvas')!;
            if (replace && now >= 3000 && c.id === 'A') {
              const b = c.cloneNode() as HTMLCanvasElement;
              b.id = 'B';
              c.replaceWith(b);
              c = b;
            }
            const moving = !replace || (c.id === 'A' ? now < 2000 : now < 7900);
            if (moving) {
              const g = c.getContext('2d')!;
              g.fillStyle = frame % 2 ? '#111' : '#eee';
              // Only this 20 x 20 patch changes: (24,24), or the clipped bottom cell.
              g.fillRect(24, 0, 20, 20);
            }
          }, { now, frame: ++frame, replace });
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PageLike;
    return { findings: await motionProbe.run(context(clocked)), waits, now };
  } finally { await ctx.close(); }
}

describe('exact identity at the changed region centre (Sol r6 1 and 2)', () => {
  it('A moves until 2 s, B replaces it at 3 s and moves 4.9 s: the persistent 160 x 160 parent never fails', async () => {
    const r = await canvasMotion(true);
    expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r)).toEqual([]);
  }, 30_000);

  it.each([1, 2])('the 120 x 20 canvas directly under body, between old grid points, draws forever and fails (DPR %i)', async (dpr) => {
    const r = await canvasMotion(false, dpr);
    expect(r.findings, JSON.stringify(r)).toContainEqual(expect.objectContaining({ status: 'failed', target: '#A' }));
  }, 30_000);

  it('a changed region clipped at the 900 px viewport edge still uses its exact centre', async () => {
    const r = await canvasMotion(false, 1, true);
    expect(r.findings, JSON.stringify(r)).toContainEqual(expect.objectContaining({ status: 'failed', target: '#A' }));
  }, 30_000);

  it('a truly lone moving canvas is not applicable without parallel content', async () => {
    const r = await canvasMotion(false, 1, false, false);
    expect(r.findings, JSON.stringify(r)).toEqual([expect.objectContaining({
      status: 'not_applicable', detail: expect.stringContaining('all the page shows'),
    })]);
  }, 30_000);
});

// Sol r7b's controlled input: real discovery, hit tests, PNGs and judgment, with only costs and
// drawing controlled. Judgment starts after the eight-second canvas has stopped.
async function finiteCanvas(seconds: number, control = false, still?: readonly [number, number]) {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  try {
    await page.setContent(`<style>body{margin:0}</style><canvas id="finite" width="600" height="120"></canvas>${control ? '<button>Pause</button>' : ''}${PARALLEL_CONTENT}`);
    await page.evaluate(LISTENER_HOOK_SCRIPT);
    let now = 500, frame = 0;
    const shots: number[] = [], samples: { points: number; ms: number }[] = [], data: unknown[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    const evaluate = page.evaluate.bind(page);
    const clocked = new Proxy(page, {
      get(target, key) {
        if (key === 'waitForTimeout') return async (ms: number) => { now += ms; };
        if (key === 'evaluate') return async (fn: (arg: unknown) => unknown, arg: unknown) => {
          now += 2;
          const result = await evaluate(fn, arg);
          if (fn.name === 'shotIdentity') {
            const points = (result as ShotIdentity).hit.length;
            now += points * 0.03;
            samples.push({ points, ms: 2 + points * 0.03 });
          }
          return result;
        };
        if (key === 'screenshot') return async (opts: Parameters<Page['screenshot']>[0]) => {
          // The review's first judgment screenshot was at 8,278 ms. Holding judgment there
          // changes no discovery evidence and makes that literal boundary reproducible.
          if (opts?.clip) now = Math.max(now, 8278);
          shots.push(now);
          await evaluate(({ moving, frame }) => {
            if (!moving) return;
            const g = document.querySelector('canvas')!.getContext('2d')!;
            g.fillStyle = frame % 2 ? '#111' : '#eee';
            g.fillRect(0, 0, 600, 120);
          }, { moving: now < seconds * 1000 && !(still && now >= still[0] && now < still[1]), frame: ++frame });
          const bytes = await page.screenshot(opts);
          now += 100;
          return bytes;
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PageLike;
    const pctx = context(clocked);
    pctx.setData = (d) => { data.push(d); };
    return { findings: await motionProbe.run(pctx), shots, samples, data };
  } finally { await page.close(); }
}

it('Sol r10: the uncontrolled 600 x 120 canvas drawing for 8 s stays clean when judgment starts after it stops', async () => {
  const r = await finiteCanvas(8);
  expect(r.samples).toHaveLength(6);
  expect(r.samples.every((s) => s.points === 7565)).toBe(true);
  expect(r.shots[r.samples.length]).toBeGreaterThanOrEqual(8278);
  expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r)).toEqual([]);
}, 30_000);

it('a canvas that stops before the probe proves more than 5 s of motion keeps its clean outcome', async () => {
  const r = await finiteCanvas(4.5);
  expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r)).toEqual([]);
}, 30_000);

it('Sol r9: a canvas with a still interval from 2.5 to 4.5 s never fails from its two changing windows more than 5 s apart', async () => {
  const r = await finiteCanvas(8, false, [2500, 4500]);
  expect(r.findings.filter((f) => f.status === 'failed'), JSON.stringify(r)).toEqual([]);
}, 30_000);

it('keeps the existing outcome when a stopped canvas has a pause control that can no longer be checked', async () => {
  const r = await finiteCanvas(8, true);
  expect(r.findings).toContainEqual(expect.objectContaining({ status: 'no_failures_found', target: '#finite' }));
}, 30_000);

it('batches the 16 px lattice and clipped-edge centres in one evaluate per screenshot and reports each cost', async () => {
  const r = await finiteCanvas(8);
  expect(r.samples).toHaveLength(6);
  expect(r.data.at(-1)).toEqual(expect.objectContaining({
    identitySampling: Array.from({ length: r.samples.length }, () => ({ hitTests: 7565, evaluations: 1, ms: expect.closeTo(229, 0) })),
  }));
}, 30_000);

it('Sol r6 3: page time 600 ms, settleMs 0, one never-fired timer: timersSince({t: -400}) is zero', async () => {
  const page = await browser.newPage();
  try {
    await page.evaluate(() => {
      Object.defineProperty(performance, 'now', { value: () => 600 });
      Object.defineProperty(window, '__grntedHooks', { value: () => ({ timers: [{}] }) });
    });
    expect(await page.evaluate(installPointerKit, { key: POINTER_KEY, action: ACTION_NAME, alternatives: { ...ALTERNATIVES } })).toBe(true);
    const count = await page.evaluate((key) => (window as unknown as Record<string, { timersSince: (o: { t: number }) => number }>)[key]!.timersSince({ t: -400 }), POINTER_KEY);
    expect(count).toBe(0);
  } finally { await page.close(); }
});

it.each(['wait', 'state', 'stamps'] as const)('Sol r6 4: a timer from page time 21,000 ms, setAt 100, is not waited on or judged after a same-URL reload at 100 ms (before %s)', async (when) => {
  const ctx = await browser.newContext();
  try {
    await ctx.addInitScript({ content: `${DOCUMENT_ID_SCRIPT}\nObject.defineProperty(performance, 'now', { configurable: true, value: () => 100 });\n${LISTENER_HOOK_SCRIPT}` });
    const page = await ctx.newPage();
    await page.goto(`data:text/html,<div id="banner" style="width:600px;height:120px">News</div>${PARALLEL_CONTENT}`);
    await page.evaluate(() => {
      Object.defineProperty(performance, 'now', { configurable: true, value: () => 100 });
      let n = 0;
      setInterval(() => { document.getElementById('banner')!.textContent = `News ${++n}`; }, 1000);
    });
    const evaluate = page.evaluate.bind(page);
    const waits: number[] = [];
    let reloaded = false;
    const reload = async () => {
      await page.reload();
      await evaluate(() => { Object.defineProperty(performance, 'now', { value: () => 100 }); });
      reloaded = true;
    };
    const wrapped = new Proxy(page, {
      get(target, key) {
        if (key === 'waitForTimeout') return async (ms: number) => { waits.push(ms); };
        if (key === 'evaluate') return async (fn: (arg: unknown) => unknown, arg: unknown) => {
          const timerClock = fn.toString().includes('__grntedTimerChanges') && fn.toString().includes('firstAt');
          if (timerClock && !reloaded) {
            await evaluate(() => { Object.defineProperty(performance, 'now', { configurable: true, value: () => 21_000 }); });
            const r = await evaluate(fn, arg);
            if (when === 'wait') await reload();
            return r;
          }
          if (!reloaded && ((when === 'state' && fn.name === 'stillMoving')
            || (when === 'stamps' && fn.toString().includes('a.timers.map') && fn.toString().includes('lastChangeAt')))) await reload();
          return evaluate(fn, arg);
        };
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as PageLike;
    const pctx = context(wrapped);
    pctx.ends = performance.now() + 25_000;
    const result = await motionProbe.run(pctx).then(
      (findings) => ({ findings, error: null }),
      (error: unknown) => ({ findings: [], error }),
    );
    expect(reloaded).toBe(true);
    expect(waits, JSON.stringify(waits)).not.toContain(5500);
    expect(result.error).toBeNull();
    expect(result.findings).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringMatching(/page loaded another page|page changed/) })]);
  } finally { await ctx.close(); }
}, 30_000);
