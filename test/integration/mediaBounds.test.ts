// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media tests' bounds and their reading of sound-only items and frames (batch 17, media lane, fix round 1):
// - S6: one download per measured video, stopped at the limit; script files read as streams and stopped at theirs.
// - S7: a decode that does not come back ends at its deadline, and a video measured before it keeps its result.
// - S7, the packet census: a file whose figures say less sound than its packets hold is never decoded (a decoder
//   makes sound of every packet, whatever times the file gives); honest files of the shapes counted still are.
// - S4: 1.2.1 covers recordings only: a stream with no end, and one the page calls live, are undecided.
// - S8: a frame that holds a video and is not read is said so, never "no video on this page".
// A server of its own counts what it sends for the streamed addresses: the files are test/fixtures/media/.
import { readFile } from 'node:fs/promises';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { measureExpression, mediaAlternativesProbe, mediaFilesProbe, MEDIA_FILES_LIMITS } from '../../src/probes/mediaFiles.js';
import { runProbes } from '../../src/probes/runner.js';
import type { ProbeContext, ProbeFinding, ProbeRun } from '../../src/probes/types.js';
import type { BrowserLike, FrameLike, PageLike } from '../../src/types.js';

const DIR = fileURLToPath(new URL('../fixtures/media/', import.meta.url));
const TYPES: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.vtt': 'text/vtt', '.webm': 'video/webm', '.mp4': 'video/mp4', '.wav': 'audio/wav' };
const MB = 1024 * 1024;

/** One request for a streamed address: what was asked, and how many bytes the server had written when the client left or the body ended. */
interface Hit { path: string; range: string; sent: number; ended: boolean }
const hits: Hit[] = [];

const page = (title: string, body: string): string => `<!doctype html>\n<html lang="en">\n<head><meta charset="utf-8"><title>${title}</title><meta name="viewport" content="width=device-width, initial-scale=1"></head>\n<body>\n<main>\n<h1>${title}</h1>\n${body}\n</main>\n</body>\n</html>\n`;
const PAGES: Record<string, string> = {
  // S6: a video file that never says how long it is and goes on past the limit; the server ignores byte ranges.
  '/bounds-big.html': page('A very large notice', '<section><h2>Watch the notice</h2>\n<video id="big" controls preload="none" width="640" height="360" src="/stream/big.webm"></video>\n</section>'),
  // S6, look-alike: a file that says at once that it is too large is not downloaded at all.
  '/bounds-declared.html': page('A notice that says its size', '<section><h2>Watch the notice</h2>\n<video id="declared" controls preload="none" width="640" height="360" src="/stream/declared.webm"></video>\n</section>'),
  // S6: a script file far longer than the test reads of one (no code about captions in it).
  '/bounds-script.html': page('Notice on a page with a large script', '<section><h2>Watch the notice</h2>\n<video id="scripted" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?beside-a-large-script"></video>\n</section>\n<script src="/stream/large.js"></script>'),
  // S7: the browser's decoder does not come back for the second video (the page stands in for a decode that hangs).
  // S7, the census: the review's bound held only for what a file says of itself. Each of these says 2 s (or
  // cannot be counted) and holds far more; a captions-free spoken notice over a plain picture in all of them.
  '/bounds-lies-webm.html': page('A notice that says it is 2 s long', '<section><h2>Watch the notice</h2>\n<video id="lies" controls preload="metadata" width="640" height="360" src="/files/lies-webm-length.webm"></video>\n</section>'),
  '/bounds-lies-mp4.html': page('An MP4 notice that says it is 2 s long', '<section><h2>Watch the notice</h2>\n<video id="lies" controls preload="metadata" width="640" height="360" src="/files/lies-mp4-times.mp4"></video>\n</section>'),
  '/bounds-lies-fragments.html': page('A notice in fragments that says it is 2 s long', '<section><h2>Watch the notice</h2>\n<video id="lies" controls preload="metadata" width="640" height="360" src="/files/lies-mp4-fragments.mp4"></video>\n</section>'),
  '/bounds-lies-tail.html': page('A notice whose media ends early', '<section><h2>Watch the notice</h2>\n<video id="lies" controls preload="metadata" width="640" height="360" src="/files/lies-webm-tail.webm"></video>\n</section>'),
  '/bounds-lies-edits.html': page('A notice that plays its sound three times', '<section><h2>Watch the notice</h2>\n<video id="lies" controls preload="metadata" width="640" height="360" src="/files/lies-mp4-edits.mp4"></video>\n</section>'),
  // Look-alikes: honest files of the shapes the census reads (Vorbis in WebM, Opus in MP4, 50 s of AAC at 48 kHz in two channels).
  '/bounds-honest-vorbis.html': page('A notice in Vorbis', '<section><h2>Watch the notice</h2>\n<video id="vorbis" controls preload="metadata" width="640" height="360" src="/files/speech-plain-vorbis.webm"></video>\n</section>'),
  '/bounds-honest-opus.html': page('A notice in an MP4 with Opus', '<section><h2>Watch the notice</h2>\n<video id="opus" controls preload="metadata" width="640" height="360" src="/files/speech-plain-opus.mp4"></video>\n</section>'),
  '/bounds-honest-aac48.html': page('A longer notice', '<section><h2>Watch the notice</h2>\n<video id="aac48" controls preload="metadata" width="640" height="360" src="/files/speech-long-aac48.mp4"></video>\n</section>'),
  // The cut round (review media-v, S4): a picture over the budget (480 x 2000), and one at its edge (1080 x 1920).
  '/cut-tall.html': page('A tall notice', '<section><h2>Watch the notice</h2>\n<video id="tall" controls preload="metadata" width="240" height="1000" src="/files/speech-tall.webm"></video>\n</section>'),
  '/cut-portrait.html': page('A notice filmed on a phone', '<section><h2>Watch the notice</h2>\n<video id="portrait" controls preload="metadata" width="270" height="480" src="/files/speech-portrait.webm"></video>\n</section>'),
  // The cut round (review media-v, S6): the first decode on the page never comes back; the test starts no other.
  '/cut-hang-first.html': page('Three notices', '<section><h2>The first notice</h2>\n<video id="h1" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?hangs-first"></video>\n</section>\n<section><h2>The second notice</h2>\n<video id="h2" controls preload="metadata" width="640" height="360" src="/files/speech-plain-f.webm?after-hang"></video>\n</section>\n<section><h2>The third notice</h2>\n<video id="h3" controls preload="metadata" width="640" height="360" src="/files/speech-plain-es.webm?after-hang"></video>\n</section>\n<script>(function () { var n = 0; OfflineAudioContext.prototype.decodeAudioData = (function (real) { return function () { n += 1; return n === 1 ? new Promise(function () {}) : real.apply(this, arguments); }; })(OfflineAudioContext.prototype.decodeAudioData); })();</script>'),
  // The cut round (review media-v, S9): a failure in the page's own document, then one in a same-site frame.
  '/cut-keep.html': page('A notice and a player page', '<section><h2>Watch the notice</h2>\n<video id="main" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?keep-main"></video>\n</section>\n<section><h2>Watch it in the player</h2>\n<iframe src="/cut-keep-frame.html" title="Notice player" width="680" height="400"></iframe>\n</section>'),
  '/cut-keep-frame.html': '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notice player</title></head><body style="margin:0"><video id="inner" controls preload="metadata" width="640" height="360" src="/files/speech-plain-f.webm?keep-frame"></video></body></html>',
  '/bounds-hang.html': page('Two notices', '<section><h2>The first notice</h2>\n<video id="first" controls preload="metadata" width="640" height="360" src="/files/speech-plain.webm?decodes"></video>\n</section>\n<section><h2>The second notice</h2>\n<video id="second" controls preload="metadata" width="640" height="360" src="/files/speech-plain-f.webm?hangs"></video>\n</section>\n<script>(function () { var real = OfflineAudioContext.prototype.decodeAudioData; var n = 0; OfflineAudioContext.prototype.decodeAudioData = function () { n += 1; return n === 2 ? new Promise(function () {}) : real.apply(this, arguments); }; })();</script>'),
};

/** Writes `total` bytes: `head` first, then filler, 64 kB at a time and never faster than the client reads. */
function stream(req: IncomingMessage, res: ServerResponse, hit: Hit, head: Uint8Array, total: number, filler: Uint8Array): void {
  let open = true;
  req.on('close', () => { open = false; });
  res.on('close', () => { open = false; });
  const write = async (chunk: Uint8Array): Promise<void> => {
    if (!res.write(chunk)) {
      await new Promise<void>((r) => {
        const done = () => { res.off('drain', done); res.off('close', done); r(); };
        res.on('drain', done);
        res.on('close', done);
      });
    }
    hit.sent += chunk.length;
  };
  void (async () => {
    await write(head);
    while (open && hit.sent < total) {
      await write(filler);
      // A real server's pace: the client decides how much it takes.
      await new Promise((r) => setTimeout(r, 1));
    }
    hit.ended = hit.sent >= total;
    if (open) res.end();
  })();
}

let server: Server;
let origin = '';
let browser: Browser;
let runs: ProbeRun[] = [];
let audioRuns: ProbeRun[] = [];
let frameRuns: ProbeRun[] = [];

beforeAll(async () => {
  const clip = await readFile(join(DIR, 'files/speech-plain.webm'));
  const filler = new Uint8Array(64 * 1024).fill(0x20);
  const code = new TextEncoder().encode(`// ${'the clerk posts each notice the same day; '.repeat(1500)}\n`.slice(0, 64 * 1024 - 1) + '\n');
  server = createServer(async (req, res) => {
    const path = new URL(req.url ?? '/', 'http://x').pathname;
    const html = PAGES[path];
    if (html) { res.writeHead(200, { 'content-type': TYPES['.html']! }).end(html); return; }
    if (path.startsWith('/stream/')) {
      const hit: Hit = { path, range: String(req.headers.range ?? ''), sent: 0, ended: false };
      hits.push(hit);
      if (path === '/stream/big.webm') { res.writeHead(200, { 'content-type': 'video/webm' }); stream(req, res, hit, clip, 80 * MB, filler); return; }
      if (path === '/stream/declared.webm') { res.writeHead(200, { 'content-type': 'video/webm', 'content-length': 100 * MB }); stream(req, res, hit, clip, 100 * MB, filler); return; }
      if (path === '/stream/large.js') { res.writeHead(200, { 'content-type': 'text/javascript' }); stream(req, res, hit, code, 12 * MB, code); return; }
    }
    const file = normalize(join(DIR, path));
    if (!file.startsWith(DIR)) { res.writeHead(403).end(); return; }
    try {
      const body = await readFile(file);
      const type = TYPES[extname(file)] ?? 'application/octet-stream';
      const range = /^bytes=(\d+)-(\d*)$/.exec(String(req.headers.range ?? ''));
      if (range && /^(video|audio)\//.test(type)) {
        const start = Number(range[1]);
        const end = range[2] ? Math.min(Number(range[2]), body.length - 1) : body.length - 1;
        res.writeHead(206, { 'content-type': type, 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${body.length}`, 'content-length': end - start + 1 }).end(body.subarray(start, end + 1));
        return;
      }
      res.writeHead(200, { 'content-type': type, 'content-length': body.length, ...(/^(video|audio)\//.test(type) ? { 'accept-ranges': 'bytes' } : {}) }).end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/html' }).end('<!doctype html><title>Not found</title>');
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  browser = await chromium.launch({ args: ['--mute-audio'] });
  const at = (list: string[]) => list.map((p, index) => ({ url: `${origin}${p}`, index }));
  runs = await runProbes(browser as unknown as BrowserLike, at(Object.keys(PAGES).filter((p) => !p.startsWith('/cut-keep'))), [mediaFilesProbe], { userAgent: 'grnted-test', concurrency: 1 });
  audioRuns = await runProbes(browser as unknown as BrowserLike, at(['/audio-live.html', '/audio-adjacent.html']), [mediaAlternativesProbe], { userAgent: 'grnted-test', concurrency: 1 });
  frameRuns = await runProbes(browser as unknown as BrowserLike, at(['/files-frames.html']), [mediaFilesProbe], { userAgent: 'grnted-test', concurrency: 1 });
}, 600_000);

afterAll(async () => {
  await browser?.close();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => { if (server) server.close(() => r()); else r(); });
});

const found = (list: ProbeRun[], name: string, criterion: string): ProbeFinding[] => list.find((r) => r.page.endsWith(name))?.findings.filter((f) => f.criterion === criterion) ?? [];
const one = (status: ProbeFinding['status'], words: string) => [expect.objectContaining({ status, detail: expect.stringContaining(words) })];
const measured = (name: string): Record<string, unknown>[] => (runs.find((r) => r.page.endsWith(name))?.data as { videos?: Record<string, unknown>[] } | undefined)?.videos ?? [];

describe('fix round 1, S6: nothing is downloaded past its limit', () => {
  it('every run finished', () => {
    expect([...runs, ...audioRuns, ...frameRuns].map((r) => r.status)).toEqual([...runs, ...audioRuns, ...frameRuns].map(() => 'ok'));
  });

  it('red: a video file with no end in sight is asked for once (the copy the frames come from makes no request of its own) and the download stops at the limit', () => {
    const asked = hits.filter((h) => h.path === '/stream/big.webm');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.range).toBe('');
    expect(asked[0]!.ended).toBe(false);
    // The limit, and what a server has under way when the client leaves (the server writes 64 kB at a time).
    expect(asked[0]!.sent).toBeGreaterThan(MEDIA_FILES_LIMITS.maxBytes);
    expect(asked[0]!.sent).toBeLessThan(MEDIA_FILES_LIMITS.maxBytes + 8 * MB);
    expect(found(runs, '/bounds-big.html', '1.2.2')).toEqual(one('not_testable', 'its file is larger than 24 MB, more than the test fetches'));
  });

  it('look-alike: a file that says at once that it is too large is left alone', () => {
    const asked = hits.filter((h) => h.path === '/stream/declared.webm');
    expect(asked).toHaveLength(1);
    expect(asked[0]!.sent).toBeLessThan(4 * MB);
    expect(found(runs, '/bounds-declared.html', '1.2.2')).toEqual(one('not_testable', 'its file is larger than 24 MB, more than the test fetches'));
  });

  it('red: of a 12 MB script file the test reads its limit and no more (the page itself loads all of it; the test\'s own request is the second one)', () => {
    const asked = hits.filter((h) => h.path === '/stream/large.js');
    expect(asked).toHaveLength(2);
    expect(asked[0]!.ended).toBe(true);
    expect(asked[1]!.ended).toBe(false);
    expect(asked[1]!.sent).toBeGreaterThanOrEqual(MEDIA_FILES_LIMITS.scriptBytes);
    expect(asked[1]!.sent).toBeLessThan(MEDIA_FILES_LIMITS.scriptBytes + 4 * MB);
    // A script that was not read to its end is unknown, not "no captions": the video is played before it is failed.
    expect(measured('/bounds-script.html')[0]).toMatchObject({ scriptsUnread: 1, played: { added: 0, cues: 0 } });
    expect(found(runs, '/bounds-script.html', '1.2.2')).toEqual(one('failed', 'no captions came (no track, no cue, no text by it)'));
  });
});

describe('fix round 1, S7: a decode that does not come back takes nothing from what was measured before it', () => {
  it('red: the first video is measured and failed; the second one\'s decode never answers and ends at its deadline, undecided', () => {
    const list = found(runs, '/bounds-hang.html', '1.2.2');
    expect(list.filter((f) => f.target?.endsWith('speech-plain.webm?decodes'))).toEqual(one('failed', 'has speech and no captions'));
    expect(list.filter((f) => f.target?.endsWith('speech-plain-f.webm?hangs'))).toEqual(one('not_testable', 'its sound took too long to decode'));
  });
});

describe('fix round 1, S7: the packets are counted before anything is decoded', () => {
  const lies = (name: string) => ({ findings: found(runs, name, '1.2.2'), video: measured(name)[0] });

  it('red, the brief\'s case: a WebM whose length, index and tags say 2 s and that holds 400 s of packets is not decoded: undecided, with what was counted', () => {
    const { findings, video } = lies('/bounds-lies-webm.html');
    // The browser reads its length from its header (2 s; read further, it says 7 s, and a decoder makes all 400 s).
    expect(findings).toEqual(one('not_testable', 'its file holds packets for up to 400 s of sound, more than the 2 s it gives as its length, so it was not decoded'));
    expect(video).toBeDefined();
    expect(video!.decoded).toBeUndefined();
  });

  it('red: the same in an MP4 (its lengths, edit and every sample\'s time say 2 s) and in MP4 fragments (every fragment\'s time says 0): not decoded', () => {
    for (const name of ['/bounds-lies-mp4.html', '/bounds-lies-fragments.html']) {
      const { findings, video } = lies(name);
      expect(findings, name).toEqual(one('not_testable', 'its file holds packets for up to 400 s of sound'));
      expect(video?.decoded, name).toBeUndefined();
    }
  });

  it('red: a WebM whose media ends, by its own size, after its first part, and an MP4 whose edit list plays its sound three times, cannot be counted: not decoded', () => {
    expect(lies('/bounds-lies-tail.html').findings).toEqual(one('not_testable', 'the test could not count the packets of its sound track (its file holds more after the end of its media), so it was not decoded'));
    expect(lies('/bounds-lies-tail.html').video?.decoded).toBeUndefined();
    expect(lies('/bounds-lies-edits.html').findings).toEqual(one('not_testable', 'the test could not count the packets of its sound track (its edit list plays parts of its sound more than once), so it was not decoded'));
    expect(lies('/bounds-lies-edits.html').video?.decoded).toBeUndefined();
  });

  it('look-alike: honest files of the shapes the census reads are decoded and failed (Vorbis in WebM, Opus in MP4; 50 s of AAC at 48 kHz in two channels, cut to fit the limit)', () => {
    for (const name of ['/bounds-honest-vorbis.html', '/bounds-honest-opus.html', '/bounds-honest-aac48.html']) {
      expect(found(runs, name, '1.2.2'), name).toEqual(one('failed', 'has speech and no captions'));
      expect(measured(name)[0]?.decoded, name).toBeDefined();
    }
    // AAC at 48 kHz is sized at twice its rate (a decoder may switch SBR on): 43 s fit the limit, so the 50 s file is cut.
    expect(measured('/bounds-honest-aac48.html')[0]?.decoded).toMatchObject({ cut: true, channels: 2 });
    expect((measured('/bounds-honest-aac48.html')[0]?.decoded as { seconds: number }).seconds).toBeLessThanOrEqual(43);
  });
});

describe('the cut round (review media-v): S4 a picture budget, S6 one decode at a time', () => {
  it('red, S4: a picture larger than the test reads (480 x 2000: a side longer than 1920 px) is not measured: undecided, nothing of it decoded', () => {
    expect(found(runs, '/cut-tall.html', '1.2.2')).toEqual(one('not_testable', 'its picture is 480 x 2000 pixels, more than the 1920 px a side'));
    expect(measured('/cut-tall.html')[0]?.decoded).toBeUndefined();
  });

  it('look-alike, S4: a phone\'s portrait video at the edge of the budget (1080 x 1920) is measured and failed', () => {
    expect(found(runs, '/cut-portrait.html', '1.2.2')).toEqual(one('failed', 'has speech and no captions'));
  });

  it('red, S6: the first decode on the page never comes back; the test starts no other decode on that page: the other two videos are undecided, not decoded', () => {
    const list = found(runs, '/cut-hang-first.html', '1.2.2');
    expect(list.filter((f) => f.target?.endsWith('speech-plain.webm?hangs-first'))).toEqual(one('not_testable', 'its sound took too long to decode'));
    for (const file of ['speech-plain-f.webm?after-hang', 'speech-plain-es.webm?after-hang']) {
      expect(list.filter((f) => f.target?.endsWith(file)), file).toEqual(one('not_testable', 'a decode the test started earlier on this page had not finished, so this one was not started'));
    }
  });
});

describe('the cut round (review media-v, S3): links right beside a recording', () => {
  const audio = (file: string): ProbeFinding[] => found(audioRuns, '/audio-adjacent.html', '1.2.1').filter((f) => f.target?.endsWith(`/files/${file}`));

  it('red: a transcript link standing on its own right after the player, in the main content, is found: clean', () => {
    expect(audio('speech.wav?standalone-transcript')).toEqual(one('no_failures_found', 'with a transcript linked next to it ("Download transcript")'));
  });

  it('red: another link right after the player ("Episode notes") may lead to a transcript: undecided, never failed', () => {
    expect(audio('speech-es.wav?episode-notes')).toEqual(one('not_testable', 'a link right beside it ("Episode notes") may lead to one'));
  });

  it('look-alike: a link to the recording\'s own file is not a transcript: the recording with nothing else beside it is listed for a person to check (batch 17\'s cut: never failed)', () => {
    expect(audio('tune.wav?own-file-link')).toEqual(one('not_testable', 'no transcript was found next to this audio player'));
  });
});

describe('fix round 1, S4: 1.2.1 covers recordings only', () => {
  const audio = (file: string): ProbeFinding[] => found(audioRuns, '/audio-live.html', '1.2.1').filter((f) => f.target?.endsWith(`/files/${file}`));

  it('red: a stream with no end and no transcript is not failed: undecided', () => {
    expect(audio('live.webm')).toEqual(one('not_testable', 'has no set length (the browser read no end for it: a live stream'));
  });

  it('red: a player the page calls live is not failed either, although its file has a set length: undecided', () => {
    expect(audio('speech.wav?called-live')).toEqual(one('not_testable', 'the page calls this audio player live ("Listen live")'));
    // The same with no space in the markup between the heading before the player and the words after it (the lab found this).
    expect(audio('speech.wav?tight')).toEqual(one('not_testable', 'the page calls this audio player live ("Listen live")'));
  });

  it('red: a linked sound file that does not load for the test may be anything: undecided', () => {
    expect(audio('mayor-message.mp3')).toEqual(one('not_testable', 'whether it is a recording or a live stream could not be told'));
  });

  it('look-alike: a recording with no transcript found is listed for a person to check, never failed (batch 17\'s cut): the page\'s own player, one that had not loaded its file, and a linked file (the test asks the browser for their length)', () => {
    expect(audio('speech.wav?recording')).toEqual(one('not_testable', 'no transcript was found next to this audio player'));
    expect(audio('tune.wav?unloaded')).toEqual(one('not_testable', 'no transcript was found next to this audio player'));
    expect(audio('chime.wav')).toEqual(one('not_testable', 'no transcript was found next to the linked audio file'));
  });

  it('look-alike: with a transcript beside it, a recording and a stream are both clean', () => {
    expect(audio('speech-es.wav?with-text')).toEqual(one('no_failures_found', 'with a transcript linked next to it'));
    expect(audio('live.webm?with-text')).toEqual(one('no_failures_found', 'with a transcript linked next to it'));
  });

  it('red (the sound-only lab found it): a transcript written out under its own heading right after the player, or after the player\'s figure, is found: clean', () => {
    expect(audio('speech.wav?under-heading')).toEqual(one('no_failures_found', 'with a transcript linked next to it ("Transcript")'));
    expect(audio('speech-es.wav?figure-then-heading')).toEqual(one('no_failures_found', 'with a transcript linked next to it ("Transcript")'));
  });

  it('look-alike: text under the NEXT heading of the same level is another part of the page: the recording before it is listed for a person to check (batch 17\'s cut: never failed)', () => {
    expect(audio('tune.wav?next-part')).toEqual(one('not_testable', 'no transcript was found next to this audio player'));
  });

  it('red (batch 17\'s cut, the lead\'s blind measurement): a full transcript right after the player under a heading that does not say "transcript" is not failed', () => {
    // The words the recording says, written out under "Read by the clerk": the test finds no transcript by its word,
    // and the absence of a word is no proof of absence. Before the cut this recording was failed.
    expect(audio('speech.wav?other-words')).toEqual(one('not_testable', 'for a person to check'));
  });

  it('nothing fails: since batch 17\'s cut a missing transcript is listed for a person to check', () => {
    expect(found(audioRuns, '/audio-live.html', '1.2.1').filter((f) => f.status === 'failed')).toEqual([]);
  });
});

describe('the cut round (review media-v, S9): failures kept for the time box are those of every document', () => {
  it('a failure in the page\'s own document is still kept after a same-site frame is read (one list for the whole run; since the second check of the cut round a framed video is undecided, so the frame adds none)', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await p.goto(`${origin}/cut-keep.html`, { waitUntil: 'load' });
      await p.waitForTimeout(1500);
      const kept: ProbeFinding[][] = [];
      const ctx = {
        page: p, url: `${origin}/cut-keep.html`, pageIndex: 0, viewport: { width: 1280, height: 900 }, signal: new AbortController().signal, deadline: Date.now() + 120_000,
        guard: { events: [], mark: () => 0, since: () => [] }, keep: (list: ProbeFinding[]) => { kept.push([...list]); }, setData: () => {},
      } as unknown as ProbeContext;
      const findings = await mediaFilesProbe.run(ctx);
      const failedOnes = findings.filter((f) => f.status === 'failed').map((f) => f.target);
      expect(failedOnes).toEqual([expect.stringContaining('speech-plain.webm?keep-main')]);
      expect(findings.filter((f) => f.target?.includes('keep-frame'))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('is in a frame of this page') })]);
      expect(kept.at(-1)!.map((f) => f.target)).toEqual(failedOnes);
    } finally {
      await p.close();
    }
  }, 120_000);
});

describe('the second check of the cut round (review media-cut, S2): one decode lock for the whole page', () => {
  it('red: a decode the test started in the page\'s own document and that has not finished keeps a same-site frame from starting one; look-alike: without it, the frame decodes', async () => {
    const p = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    try {
      await p.goto(`${origin}/cut-keep.html`, { waitUntil: 'load' });
      await p.waitForTimeout(1500);
      const frame = p.frames().find((f) => f.url().endsWith('/cut-keep-frame.html'))!;
      const src = `${origin}/files/speech-plain-f.webm?keep-frame`;
      await frame.evaluate(() => { (document.querySelector('video') as unknown as Record<symbol, string>)[Symbol.for('grnted.media.key')] = 'lock-test'; });
      const arg = {
        key: 'lock-test', expect: src, budgetMs: 9000, maxBytes: MEDIA_FILES_LIMITS.maxBytes, cutSeconds: MEDIA_FILES_LIMITS.cutSeconds, maxPcmBytes: MEDIA_FILES_LIMITS.maxPcmBytes,
        minSeconds: MEDIA_FILES_LIMITS.minSeconds, maxFrames: MEDIA_FILES_LIMITS.maxFrames, maxWidth: MEDIA_FILES_LIMITS.maxWidth, maxHeight: MEDIA_FILES_LIMITS.maxHeight,
        maxPixels: MEDIA_FILES_LIMITS.maxPixels, maxSide: MEDIA_FILES_LIMITS.maxSide,
      };
      // The page's own document holds the mark (a decode the test started there is still running).
      await p.evaluate(() => { (window as unknown as Record<symbol, boolean>)[Symbol.for('grnted.media.decoding')] = true; });
      const locked = (await frame.evaluate(measureExpression(arg))) as { sound: { state: string; why?: string } };
      expect(locked.sound).toEqual({ state: 'unknown', why: 'a decode the test started earlier on this page had not finished, so this one was not started' });
      await p.evaluate(() => { (window as unknown as Record<symbol, boolean>)[Symbol.for('grnted.media.decoding')] = false; });
      const free = (await frame.evaluate(measureExpression(arg))) as { sound: { state: string } };
      expect(free.sound.state).toBe('measured');
    } finally {
      await p.close();
    }
  }, 120_000);
});

describe('fix round 1, S8: a frame that is not read is said so', () => {
  it('red: a page with three same-site frames that each hold a video: two are read (their videos undecided: a framed video is never failed), the third is reported as not tested, never left out', () => {
    const list = found(frameRuns, '/files-frames.html', '1.2.2');
    expect(list.filter((f) => f.status === 'failed')).toHaveLength(0);
    expect(list.filter((f) => f.status === 'not_testable' && f.detail?.includes('is in a frame of this page'))).toHaveLength(MEDIA_FILES_LIMITS.frames);
    expect(list.filter((f) => f.status === 'not_testable' && !f.detail?.includes('is in a frame of this page'))).toEqual([expect.objectContaining({ target: '/files-frame.html?three', detail: expect.stringContaining('holds video, and is one more than the 2 such frames the test reads, so video in it was not tested') })]);
    // The frame with no video in it gives nothing.
    expect(list).toHaveLength(MEDIA_FILES_LIMITS.frames + 1);
  });

  // The review's case, with a page and frames made here: a same-site frame that does not answer (it is loading again).
  const context = (frames: FrameLike[], calls: (fn: (arg: never) => unknown) => unknown): ProbeContext => {
    const page = {
      evaluate: async (fn: (arg: never) => unknown) => calls(fn),
      frames: () => frames,
      waitForTimeout: async () => {},
    } as unknown as PageLike;
    return {
      page, url: 'https://city.example/notices', pageIndex: 0, viewport: { width: 1280, height: 900 }, signal: new AbortController().signal, deadline: Date.now() + 30_000,
      guard: { events: [], mark: () => 0, since: () => [] },
    } as unknown as ProbeContext;
  };
  const empty = { frames: [], facades: [], audio: [], videos: [], consent: false };
  const main = { url: () => 'https://city.example/notices', parentFrame: () => null, frameElement: async () => null, evaluate: async () => undefined } as unknown as FrameLike;
  const frame = (url: string, evaluate: () => Promise<unknown>): FrameLike => ({ url: () => url, parentFrame: () => main, frameElement: async () => ({}), evaluate } as unknown as FrameLike);
  const answers = (fn: (arg: never) => unknown): unknown => (fn.name === 'pageMedia' ? empty : fn.name === 'frameShown' ? true : fn.name === 'framesLoading' ? 0 : undefined);

  it('red: a same-site frame that does not answer is "could not be read", for 1.2.2 and for 1.2.1; the page is not said to have no video', async () => {
    const gone = frame('https://city.example/player/notice?id=7', () => Promise.reject(new Error('Execution context was destroyed')));
    const video = await mediaFilesProbe.run(context([main, gone], answers));
    expect(video).toEqual([expect.objectContaining({ criterion: '1.2.2', status: 'not_testable', target: '/player/notice?id=7', detail: expect.stringContaining('could not be read (it was loading again, or it did not answer in time), so video in it was not tested') })]);
    const sound = await mediaAlternativesProbe.run(context([main, gone], answers));
    expect(sound).toEqual([expect.objectContaining({ criterion: '1.2.1', status: 'not_testable', target: '/player/notice?id=7', detail: expect.stringContaining('so audio in it was not tested') })]);
  });

  it('red (the cut round, review media-v S7): a same-site frame whose visibility could not be read is "could not be read", never "no video file on this page"', async () => {
    const quiet = frame('https://city.example/player/notice?id=9', async () => ({ videos: 1, audio: 0 }));
    const noAnswer = (fn: (arg: never) => unknown): unknown => (fn.name === 'frameShown' ? Promise.reject(new Error('Execution context was destroyed')) : answers(fn));
    expect(await mediaFilesProbe.run(context([main, quiet], noAnswer))).toEqual([expect.objectContaining({ criterion: '1.2.2', status: 'not_testable', target: '/player/notice?id=9', detail: expect.stringContaining('whether it is shown did not come back') })]);
    expect(await mediaAlternativesProbe.run(context([main, quiet], noAnswer))).toEqual([expect.objectContaining({ criterion: '1.2.1', status: 'not_testable', target: '/player/notice?id=9', detail: expect.stringContaining('so audio in it was not tested') })]);
  });

  it('look-alike: a same-site frame that answers and holds no video or audio, a frame of another site, and a known player\'s frame give nothing: "no video file on this page"', async () => {
    const plain = frame('https://city.example/widgets/hours', async () => ({ videos: 0, audio: 0 }));
    const other = frame('https://maps.example/embed?place=1', () => Promise.reject(new Error('not ours to read')));
    const player = frame('https://www.youtube.com/embed/abcdefghijk', () => Promise.reject(new Error('not ours to read')));
    expect(await mediaFilesProbe.run(context([main, plain, other, player], answers))).toEqual([expect.objectContaining({ criterion: '1.2.2', status: 'not_applicable', detail: 'no video file on this page' })]);
  });
});
