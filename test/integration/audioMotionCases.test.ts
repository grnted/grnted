// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The audio (1.4.2) and motion (2.2.2) cases both reviews of fix/probe-accuracy raised, one test each,
// in real Chromium with the real probes: docs/plans/2026-11-07-audio-motion-cases.md (ids, pins, why).
// CASES_OUT=<file> also writes every case's verdict to that file (to compare engine builds).
import { writeFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { audioProbe } from '../../src/probes/audio.js';
import { motionProbe } from '../../src/probes/motion.js';
import type { PageProbe, ProbeRun } from '../../src/probes/types.js';
import type { PageLike } from '../../src/types.js';
import { motionSite, type MotionSite } from '../helpers/motionProbes.js';

type Pin = 'end' | 'done' | 'press' | 'dark';
interface Case { id: string; page: string; probe: 'audio' | 'motion'; pin?: Pin; must: 'fail' | 'pass' }

export const CASES: Case[] = [
  { id: 'A1', page: 'audio-webaudio-3000.html', probe: 'audio', must: 'pass' },
  { id: 'A2', page: 'audio-webaudio-3500.html', probe: 'audio', must: 'fail' },
  { id: 'A3', page: 'audio-webaudio-3500-noop.html', probe: 'audio', must: 'fail' },
  { id: 'A4', page: 'audio-webaudio-osc-stop.html', probe: 'audio', must: 'pass' },
  { id: 'A5', page: 'audio-webaudio-late-tone.html', probe: 'audio', pin: 'press', must: 'pass' },
  { id: 'A6', page: 'audio-webaudio-timer-stop-noop.html', probe: 'audio', must: 'fail' },
  { id: 'A7', page: 'audio-webaudio-onended-suspend-noop.html', probe: 'audio', must: 'fail' },
  { id: 'A8', page: 'audio-webaudio-automation-noop.html', probe: 'audio', must: 'fail' },
  { id: 'A9', page: 'audio-webaudio-bed-rest.html', probe: 'audio', must: 'fail' },
  { id: 'A10', page: 'audio-webaudio-stop.html', probe: 'audio', must: 'pass' },
  { id: 'A11', page: 'audio-webaudio-long-running.html', probe: 'audio', pin: 'press', must: 'fail' },
  { id: 'M1', page: 'ends-by-itself.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M2', page: 'ends-by-itself-noop.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M3', page: 'ends-by-itself-pause.html', probe: 'motion', pin: 'end', must: 'pass' },
  { id: 'M4', page: 'stop-finish.html', probe: 'motion', must: 'pass' },
  { id: 'M5', page: 'slide-6000-cleanup.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M6', page: 'fade-out-6000.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M7', page: 'intro-4000-cleanup.html', probe: 'motion', pin: 'end', must: 'pass' },
  { id: 'M8', page: 'slide-6000-remove.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M9', page: 'slide-6000-display-none.html', probe: 'motion', pin: 'end', must: 'fail' },
  { id: 'M10', page: 'slide-6000-cleanup-pause.html', probe: 'motion', pin: 'end', must: 'pass' },
  { id: 'M11', page: 'blink-broken.html', probe: 'motion', pin: 'dark', must: 'fail' },
  { id: 'M12', page: 'carousel-slides-hidden.html', probe: 'motion', must: 'fail' },
  { id: 'M13', page: 'carousel-stops-4500.html', probe: 'motion', pin: 'done', must: 'pass' },
  { id: 'M14', page: 'ticker-6s-same-tick.html', probe: 'motion', pin: 'done', must: 'fail' },
  { id: 'M15', page: 'ticker-6s-chained.html', probe: 'motion', pin: 'done', must: 'fail' },
  { id: 'M16', page: 'carousel-4500-clock.html', probe: 'motion', pin: 'done', must: 'pass' },
  { id: 'M17', page: 'skeleton-6000.html', probe: 'motion', pin: 'done', must: 'fail' },
];

/** The probe with the case's pin: a timing a slow or busy page reaches by itself, made certain. */
function pinned(c: Case): PageProbe {
  const probe = c.probe === 'audio' ? audioProbe : motionProbe;
  if (!c.pin) return probe;
  return {
    ...probe,
    async run(ctx) {
      const page = ctx.page;
      if (c.pin === 'press') {
        await page.mouse!.click(5, 5);
        await page.waitForTimeout(2300);
      }
      let first = true;
      const evaluate = async (fn: unknown, arg: unknown) => {
        const name = typeof fn === 'function' ? fn.name : '';
        if (c.pin === 'dark' && (name === 'stillMoving' || name === 'motionInventory')) {
          await page.evaluate(() => { for (const a of document.getAnimations()) a.currentTime = 600 + 1000 * Math.floor(Number(a.currentTime ?? 0) / 1000); }, undefined);
        } else if (first && c.pin === 'end' && name === 'stillMoving') {
          first = false;
          await page.evaluate(() => Promise.all(document.getAnimations().map((a) => a.finished.catch(() => null))).then(() => true), undefined);
          await page.waitForTimeout(200);
        } else if (first && c.pin === 'done' && name === 'stillMoving') {
          first = false;
          for (let i = 0; i < 100 && !(await page.evaluate(() => (window as unknown as { __simDone?: boolean }).__simDone === true, undefined)); i++) await page.waitForTimeout(100);
          await page.waitForTimeout(100);
        } else if (first && c.pin === 'press' && (name === 'soundClock' || name === 'soundSources')) {
          first = false;
          await page.waitForTimeout(200);
        }
        return page.evaluate(fn as (a: unknown) => unknown, arg);
      };
      const p = new Proxy(page, { get: (t, k) => (k === 'evaluate' ? evaluate : (Reflect.get(t, k, t) as unknown)) }) as PageLike;
      return probe.run({ ...ctx, page: p });
    },
  };
}

const verdict = (r: ProbeRun | undefined, criterion: string): string => {
  const f = (r?.findings ?? []).filter((x) => x.criterion === criterion);
  if (f.some((x) => x.status === 'failed')) return 'fail';
  if (f.some((x) => x.status === 'not_testable')) return 'not_testable';
  return 'pass';
};

let site: MotionSite;
const seen: Record<string, { must: string; got: string; detail: string }> = {};
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => {
  await site?.close();
  if (process.env.CASES_OUT) writeFileSync(process.env.CASES_OUT, JSON.stringify(seen, null, 1) + '\n');
});

describe('audio and motion: the reviewed cases', () => {
  for (const c of CASES) {
    it(`${c.id} ${c.page} (${c.pin ?? 'no pin'}): must ${c.must}`, async () => {
      const runs = await site.run([pinned(c)], [c.page], { concurrency: 1 });
      const run = runs[c.page]?.[0];
      const criterion = c.probe === 'audio' ? '1.4.2' : '2.2.2';
      const got = verdict(run, criterion);
      seen[c.id] = { must: c.must, got, detail: (run?.findings ?? []).filter((x) => x.criterion === criterion).map((x) => `${x.status}: ${x.detail ?? ''}`).join(' | ').slice(0, 400) };
      expect(got, seen[c.id]!.detail).toBe(c.must);
    }, 90_000);
  }
});
