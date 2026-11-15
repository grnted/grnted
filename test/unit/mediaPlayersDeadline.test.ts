// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.8 review #6: the probe keeps inside its own time box. A page whose frames never answer must
// not run the probe past its deadline: it returns the findings it already has, and not_testable for
// the players it did not finish, instead of leaving the runner to time out and drop everything.
import { describe, expect, it } from 'vitest';
import { mediaPlayersProbe } from '../../src/probes/mediaPlayers.js';
import type { GuardLog, ProbeContext } from '../../src/probes/types.js';
import type { FrameLike, PageLike } from '../../src/types.js';

const never = () => new Promise<never>(() => {});

function hungPage(players: number, frames: number): PageLike {
  const main: FrameLike = {
    url: () => 'https://e.org/', parentFrame: () => null, frameElement: never, evaluate: never as never,
  };
  // Many child frames whose element never resolves (a hung renderer).
  const children: FrameLike[] = Array.from({ length: frames }, (_, i) => ({
    url: () => `https://www.youtube.com/embed/abcdefghij${i % 10}`, parentFrame: () => main, frameElement: never, evaluate: never as never,
  }));
  const media = {
    frames: Array.from({ length: players }, (_, i) => ({ index: i, src: `https://www.youtube.com/embed/abcdefghij${i}`, dataSrc: '', title: 'Video', near: { links: [] } })),
    // A player whose file the page has loaded: a recording with a set length (1.2.1 judges recordings only).
    audio: [{ target: 'https://e.org/a.mp3', what: 'this audio player', near: { links: [] }, length: 'finite' }],
    videos: [], facades: [], consent: false,
  };
  return {
    goto: async () => null,
    async evaluate(fn: unknown) {
      const name = (fn as { name?: string }).name;
      if (name === 'stopDownloads') return true; // the test presses players: it runs only once no click can save a file
      if (name === 'pageMedia') return media;
      if (name === 'frameState') return { shown: true, src: media.frames[0]!.src, box: { x: 0, y: 0, w: 480, h: 270, vw: 1280, vh: 900 }, layout: { w: 480, h: 270 }, affine: true };
      return undefined;
    },
    addScriptTag: async () => {},
    frames: () => [main, ...children],
    waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
    screenshot: async () => new Uint8Array(),
    close: async () => {},
  } as unknown as PageLike;
}

const guard: GuardLog = { events: [], mark: () => 0, since: () => [] };

describe('media-players probe: its own time box', () => {
  it('returns before its deadline with what it found, and not_testable for unfinished players', async () => {
    const started = Date.now();
    const deadline = started + 15_000;
    const ctx: ProbeContext = {
      page: hungPage(3, 30), url: 'https://e.org/', pageIndex: 0, viewport: { width: 1280, height: 900 }, guard,
      signal: new AbortController().signal, deadline,
      listeners: async () => [], hooks: async () => ({ listeners: [], timers: [], calls: [], audio: { created: 0, running: 0 } }),
    };
    const findings = await mediaPlayersProbe.run(ctx);
    // The probe stops itself 5 s before its time box, so the runner never has to cut it off.
    expect(Date.now()).toBeLessThan(deadline - 3000);
    // The audio item found at the start is kept (listed for a person to check since batch 17's cut: a missing
    // transcript is never failed).
    expect(findings.find((f) => f.criterion === '1.2.1')).toMatchObject({ status: 'not_testable', target: 'https://e.org/a.mp3', detail: expect.stringContaining('no transcript was found next to') });
    // Every player has a 1.2.2 result, none of them clean (the frames that did not answer are reported too).
    const cc = findings.filter((f) => f.criterion === '1.2.2');
    expect(cc.length).toBeGreaterThanOrEqual(3);
    expect(cc.every((f) => f.status === 'not_testable')).toBe(true);
  }, 30_000);

  it('round 2 #2: a player frame that does not answer, or has no element, is not testable, never "no video"', async () => {
    for (const element of [never, async () => null]) {
      const main: FrameLike = { url: () => 'https://e.org/', parentFrame: () => null, frameElement: never, evaluate: never as never };
      const child: FrameLike = { url: () => 'https://www.youtube.com/embed/abcdefghijk', parentFrame: () => main, frameElement: element as never, evaluate: never as never };
      const page = {
        goto: async () => null,
        async evaluate(fn: unknown) {
          const name = (fn as { name?: string }).name;
          return name === 'pageMedia' ? { frames: [], audio: [], videos: [], facades: [], consent: false } : name === 'stopDownloads' ? true : undefined;
        },
        addScriptTag: async () => {}, frames: () => [main, child], waitForTimeout: (ms: number) => new Promise((r) => setTimeout(r, Math.min(ms, 50))),
        screenshot: async () => new Uint8Array(), close: async () => {},
      } as unknown as PageLike;
      const ctx: ProbeContext = {
        page, url: 'https://e.org/', pageIndex: 0, viewport: { width: 1280, height: 900 }, guard, signal: new AbortController().signal, deadline: Date.now() + 15_000,
        listeners: async () => [], hooks: async () => ({ listeners: [], timers: [], calls: [], audio: { created: 0, running: 0 } }),
      };
      const findings = await mediaPlayersProbe.run(ctx);
      for (const c of ['1.2.2', '1.2.4']) {
        const f = findings.filter((x) => x.criterion === c);
        expect(f.length, c).toBeGreaterThan(0);
        expect(f.every((x) => x.status === 'not_testable'), `${c}: ${JSON.stringify(f)}`).toBe(true);
      }
    }
  }, 60_000);
});

