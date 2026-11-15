// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The page's own video and audio files (batch 17, media lane), on every page, core: two tests.
// - media-files, 1.2.2 (scored since scoring v13, as a proof-only test: src/score.ts PROOF_ONLY_PROBES):
//   a video with speech and no captions. The test reads each video's captions tracks as the browser
//   loaded them, then measures the file itself: it fetches it once (a plain GET the page itself makes when
//   the video loads), reads from the file what its sound track is, decodes the first minute of it and looks
//   for speech (src/media/sound.ts), and samples frames at moments of speech from a copy of the video that
//   is never added to the page and is fed the bytes already fetched, looking for anything that could be
//   writing (src/media/picture.ts). Only when all of that holds does it play the page's own video, muted,
//   for a moment, to see whether captions come when it plays. The rules that judge are in
//   src/media/files.ts: a failure needs speech, no captions of any kind (before and after it plays) and a
//   picture with no marks in every frame; everything else is undecided, with what was measured.
// - media-alternatives, 1.2.1 (listed, not scored): a sound-only recording with no transcript or text
//   alternative next to it (the media-players test's rules, `judgeAudio`, here on every page instead of ten).
// Both read the page's own document and same-site frames that are not a known player (a self-hosted player
// page embedded by iframe). Embedded players of other sites stay with the media-players test.
//
// Bounds (review round 1, S6 and S7): nothing is downloaded or decoded without a limit set beforehand.
// - One download per measured video, read as a stream and stopped at `maxBytes`; the copy of the video the
//   frames come from reads those same bytes (it makes no request of its own).
// - Script files are read as streams and stopped at `scriptBytes` each.
// - Before any sound is decoded, the file's own header gives its sound track's rate and channels
//   (src/media/container.ts): the decoder is handed at most `cutSeconds` of sound, fewer when that would take
//   more than `maxPcmBytes` decoded, as a cut of the file made at a boundary the file itself declares. A file
//   whose header cannot be read, or that cannot be cut, is not decoded.
// - A decoder makes sound of every packet it is handed, whatever times and length the file gives, so the bytes
//   handed to it (the whole file, or the cut, counted again) have their packets counted first
//   (`MediaLayout.census`): more sound than the file's length says (by a tenth and 5 s), more than the memory
//   limit allows, or packets that cannot be counted, and nothing is decoded (undecided, never failed).
// - No frame is read of a picture larger than `maxPixels` or `maxSide` (the cut round, review media-v S4), on the
//   size the file declares before a copy of the video is made and on the size the browser reads before any frame.
// - One decode at a time on a page (S6): the browser cannot stop a decode it has started, so none is started while
//   one the test started is still running.
// - Each video is measured in a call of its own, so one that runs out of time loses nothing measured before.
// Engine core: no Node-only imports.
import { classifyPlayer } from '../media/detect.js';
import { decodeSeconds, mediaCut, mediaLayout, type DeclaredSound, type MediaCut, type MediaLayout } from '../media/container.js';
import { beforeMeasuring, judgeVideoCaptions, provenBeforePlaying, type VideoConfirm, type VideoFacts, type VideoMeasure } from '../media/files.js';
import { frameMarks } from '../media/picture.js';
import { judgeAudio, LIVE_TEXT_SOURCE } from '../media/players.js';
import { soundFeatures } from '../media/sound.js';
import type { FrameLike, ProbeFinding } from '../types.js';
import { discardUnlessAction } from './guard.js';
import { AUDIO_EXT_SRC, AUDIO_LENGTH, captionCues, nativeVideoDecorative, nearOf, pageMedia, recordedFor, type PageMedia } from './mediaPlayers.js';
import { settledStop, within } from './motionShared.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';

export const MEDIA_FILES_PROBE_ID = 'media-files';
export const MEDIA_ALTERNATIVES_PROBE_ID = 'media-alternatives';

export const MEDIA_FILES_LIMITS = {
  /** Videos and sound items read per document. */
  perKind: 50,
  /** Videos measured (sound and picture) per document; the others are undecided. */
  measured: 3,
  /** Same-site frames with video or audio in them that are read, besides the page's own document. */
  frames: 2,
  /** Same-site frames looked into for video or audio at all. */
  framesLooked: 12,
  /** Largest file fetched (bytes): the download is stopped there. */
  maxBytes: 24 * 1024 * 1024,
  /** Seconds of sound the decoder is handed at most (the first part of a longer file), and seconds analysed. */
  cutSeconds: 66,
  /**
   * Most memory the decoded sound may take, at the file's own rate and channels, 4 bytes a sample (what a
   * decoder holds before anything is mixed down). 66 s of stereo at 48 kHz is 25 MB; six channels get 29 s.
   */
  maxPcmBytes: 32 * 1024 * 1024,
  /** Fewest seconds of sound worth decoding when the memory limit shortens the cut. */
  minSeconds: 10,
  /** Frames sampled per video. */
  maxFrames: 12,
  /** Frames wider or taller than this are scaled down before they are read (px). */
  maxWidth: 1920,
  maxHeight: 1920,
  /**
   * The largest picture whose frames the test reads (review media-v, S4): 1920 x 1080 pixels in all, and no side
   * longer than 1920 px (a phone's 1080 x 1920 fits). Checked on the size the file declares before the copy of the
   * video is made, and on the size the browser reads from it (its metadata) before any frame is drawn.
   */
  maxPixels: 1920 * 1080,
  maxSide: 1920,
  /** Script files read for code that works with captions, and the most read of each (bytes). */
  scripts: 12,
  scriptBytes: 400_000,
} as const;

export const MEDIA_FILES_TIMING = {
  /** For a video's captions files to load. */
  captionFiles: 3000,
  /** Reading the page's script files. */
  scripts: 4000,
  /** Measuring one video (its download, its sound, its frames), all waits included. */
  video: 9000,
  /** Playing one video for a moment and reading its captions again. */
  confirm: 6500,
  /** The test ends this long before its time box, so it returns what it found. */
  reserve: 3000,
} as const;

/** What the page has around one video that no measuring is needed for. */
interface Surroundings {
  key: string;
  shown: boolean;
  followed: boolean;
  captionArea: string;
  labelled: boolean;
  farControl: string;
  menuControl: string;
}

/**
 * Runs in a document (self-contained): for each `<video>` (document order), its key (`pageMedia` gives the same
 * one), whether it is shown, whether a script follows its playback, an area next to it that the markup names for
 * captions and a script could fill (empty, a live region, or lying over the video) or lines of text timed
 * against it, whether the page labels it as a video version of its text (the same phrases as the media
 * collector's, src/collect/media.ts), a control anywhere in the document that offers captions (a button,
 * switch or menu item, not a link: a script may wire it to any video), and a control next to it that may open
 * a menu or has no name (captions may be inside what it opens).
 */
function videoSurroundings(arg: { perKind: number }): Surroundings[] {
  const KEY = Symbol.for('grnted.media.key');
  const ALTERNATIVE = [
    /\bvideo (?:version|alternative|form)\b/i,
    /\bsame (?:information|content|text|words)\b[^.!?]{0,80}\b(?:video|watch)/i,
    /\b(?:video|watch)\b[^.!?]{0,80}\bsame (?:information|content|text|words)\b/i,
  ];
  const section = (el: Element): Element[] => {
    const box = el.closest('figure, section, article, aside, li, td, dd, details, dialog');
    if (box) return [box];
    let node: Element = el;
    while (node.parentElement && node.parentElement !== document.body && !node.parentElement.matches('main, [role="main"]')) node = node.parentElement;
    const parts = [node];
    for (let s = node.previousElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.previousElementSibling) parts.push(s);
    for (let s = node.nextElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.nextElementSibling) parts.push(s);
    return parts;
  };
  // Controls anywhere in the document that offer captions, by their name or by what their markup calls them.
  const CC = /\b(?:captions?|captioned|captioning|subtitles?|subtitled|closed[- ]caption(?:s|ed|ing)?|cc|subt[ií]tulos|sous-titres?|untertitel|legendas?)\b/i;
  const nameOf = (el: Element) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  const marked = (el: Element) => /caption|subtitle|(?:^|[-_\s])cc(?:$|[-_\s])/i.test(`${typeof el.className === 'string' ? el.className : ''} ${el.id} ${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('data-plyr') ?? ''}`);
  const MENU = /\b(?:settings?|options?|preferences|menu|more|quality|speed|languages?|tracks?)\b|⚙|⋮|…/i;
  const offering = ([...document.querySelectorAll('button, [role="button"], input[type="button"], input[type="checkbox"], select, [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"]')] as Element[])
    .slice(0, 3000).filter((el) => !el.closest('video') && (CC.test(nameOf(el)) || marked(el)));
  return ([...document.querySelectorAll('video')] as HTMLVideoElement[]).slice(0, arg.perKind).map((v) => {
    const held = v as unknown as Record<symbol, string | undefined>;
    const key = held[KEY] ?? (held[KEY] = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    const r = v.getBoundingClientRect();
    const shown = (typeof v.checkVisibility === 'function' ? v.checkVisibility({ visibilityProperty: true }) : true) && r.width >= 1 && r.height >= 1;
    const followed = !!(v.ontimeupdate || (v as unknown as { oncuechange?: unknown }).oncuechange || v.hasAttribute('ontimeupdate') || v.hasAttribute('oncuechange'));
    let captionArea = '';
    // Where to look: the video's wrappers (up to three levels, not the page's main content itself) and the two
    // blocks right before and after the video.
    const scopes: Element[] = [];
    let node: Element = v;
    for (let up = 0; up < 3; up++) {
      const p: Element | null = node.parentElement;
      if (!p || p === document.body || p === document.documentElement || p.matches('main, [role="main"]')) break;
      scopes.push(p);
      node = p;
    }
    for (const dir of ['previousElementSibling', 'nextElementSibling'] as const) {
      let sib: Element | null = v[dir];
      for (let i = 0; sib && i < 2; i++, sib = sib[dir]) scopes.push(sib);
    }
    for (const scope of scopes) {
      if (captionArea) break;
      for (const el of [scope, ...scope.querySelectorAll('*')].slice(0, 400)) {
        if (el === v || el.contains(v) || v.contains(el)) continue;
        if (el.matches('track, source, figcaption, a, button, summary, label, select, input, [role="button"]')) continue;
        const mark = `${typeof el.className === 'string' ? el.className : ''} ${el.id}`.trim();
        if (!/caption|subtitle|(?:^|[-_\s])cues?(?:$|[-_\s])/i.test(mark)) continue;
        const er = el.getBoundingClientRect();
        const over = er.width > 0 && er.height > 0 && er.left < r.right && er.right > r.left && er.top < r.bottom && er.bottom > r.top;
        const live = el.hasAttribute('aria-live') || /^(status|log|alert)$/.test(el.getAttribute('role') ?? '');
        if (!(el.textContent ?? '').trim() || live || over) {
          captionArea = (el.id ? `#${el.id}` : `.${mark.split(/\s+/)[0]}`).slice(0, 60);
          break;
        }
      }
    }
    // Text in the video's part of the page that is timed against it (lines that carry a start time): a script may
    // show or mark them in step with the video, which works as captions.
    if (!captionArea) {
      const timed = section(v).flatMap((p) => [...p.querySelectorAll('[data-start], [data-begin], [data-time], [data-timestamp], [data-cue], [data-start-time]')].slice(0, 20)).filter((el) => !v.contains(el));
      if (timed.length >= 2) captionArea = 'lines of text with start times';
    }
    const described = (v.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => (id ? document.getElementById(id)?.textContent ?? '' : '')).join(' ');
    const texts = [described, v.getAttribute('aria-label') ?? '', v.getAttribute('title') ?? '', ...section(v).filter((p) => p !== v).map((p) => p.textContent ?? '')];
    const labelled = texts.some((t) => ALTERNATIVE.some((re) => re.test(t.replace(/\s+/g, ' '))));
    const far = offering.find((el) => !v.contains(el));
    // A control of the page's own next to the video that may open a menu (settings, options, more, a gear), or
    // one with no name at all (an icon of a player skin): captions may be offered inside what it opens.
    let menuControl = '';
    // Also the block right before and after the video's own wrapper (where a player's bar often sits), unless
    // that block is another player's.
    const wrapper = v.parentElement && scopes.includes(v.parentElement) ? v.parentElement : null;
    const beside = (wrapper ? [wrapper.previousElementSibling, wrapper.nextElementSibling] : []).filter((x): x is Element => !!x && !x.matches('video, audio, iframe') && !x.querySelector('video, audio, iframe'));
    for (const scope of [...scopes, ...beside]) {
      if (menuControl) break;
      for (const el of [scope, ...scope.querySelectorAll('button, [role="button"], summary, select, [role="menu"], [role="menubar"], [aria-haspopup]')].slice(0, 200)) {
        if (el === v || el.contains(v) || v.contains(el) || !el.matches('button, [role="button"], summary, select, [role="menu"], [role="menubar"], [aria-haspopup]')) continue;
        const name = nameOf(el);
        if (!name || MENU.test(name) || el.hasAttribute('aria-haspopup')) { menuControl = name || 'a control with no name'; break; }
      }
    }
    return { key, shown, followed, captionArea, labelled, farControl: far ? nameOf(far) || 'captions' : '', menuControl };
  });
}

/** What the page's scripts say about captions: code that works with them (what, and where), and scripts that could not be read. */
interface ScriptsRead { scripted: string; unread: number }

/**
 * Runs in a document (self-contained): code on the page that works with captions (it names a captions file,
 * makes a track element or a text track): a script may give a video captions when it plays or when something
 * is pressed. Read once a document: the page's inline scripts, then its script files, the site's own and other
 * sites' that allow reading (`files` of them, each read as a stream and stopped at `bytes`: nothing is buffered
 * past the limit). `unread` counts the script files that could not be read in full (another site that does not
 * allow it, a file that did not answer, one longer than the limit, more files than the limit): what they do is
 * unknown, never "no captions" (review round 1, S1), which is why the page's own video is played before any
 * failure is filed.
 */
async function captionScripts(arg: { files: number; bytes: number; budgetMs: number }): Promise<ScriptsRead> {
  const started = performance.now();
  const left = () => arg.budgetMs - (performance.now() - started);
  const CAPTION_CODE = /addTextTrack|createElement\(\s*["'`]track["'`]\s*\)|\.vtt\b|\.srt\b|<track[\s>]|kind\s*[:=]\s*["'`](?:captions|subtitles)["'`]|\.textTracks\b/;
  const scripts = ([...document.scripts] as HTMLScriptElement[]).slice(0, 300);
  for (const sc of scripts) {
    if (sc.src || /json|template|importmap/i.test(sc.type)) continue;
    const hit = CAPTION_CODE.exec(sc.textContent ?? '');
    if (hit) return { scripted: `“${hit[0].slice(0, 30)}” in a script on the page`, unread: 0 };
  }
  let read = 0;
  let unread = 0;
  for (const sc of scripts) {
    if (!sc.src) continue;
    if (read >= arg.files || left() < 600) { unread++; continue; }
    read++;
    let own = false;
    let path = sc.src;
    try {
      const u = new URL(sc.src, document.baseURI);
      own = u.origin === location.origin;
      path = own ? u.pathname : `${u.host}${u.pathname}`;
    } catch {
      own = false;
    }
    const stop = new AbortController();
    const timer = setTimeout(() => stop.abort(), Math.max(0, Math.min(2500, left() - 300)));
    let text = '';
    let whole = false;
    try {
      // A plain GET for a file the page itself loads; another site's file only when that site allows reading it.
      const res = await fetch(sc.src, own ? { signal: stop.signal, credentials: 'same-origin', cache: 'force-cache' } : { signal: stop.signal, mode: 'cors', credentials: 'omit', cache: 'force-cache' });
      const reader = res.ok ? res.body?.getReader() : undefined;
      if (reader) {
        const decoder = new TextDecoder();
        let size = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) { whole = true; break; }
          const room = arg.bytes - size;
          if (value.byteLength > room) {
            // The limit: what was read so far is searched, the rest is never fetched.
            text += decoder.decode(value.subarray(0, room));
            break;
          }
          text += decoder.decode(value, { stream: true });
          size += value.byteLength;
        }
        if (!whole) reader.cancel().catch(() => {});
      }
    } catch { /* a script that cannot be read is unknown, counted below */ }
    clearTimeout(timer);
    stop.abort();
    const hit = CAPTION_CODE.exec(text);
    if (hit) return { scripted: `“${hit[0].slice(0, 30)}” in ${path.slice(0, 80)}`, unread };
    if (!whole) unread++;
  }
  return { scripted: '', unread };
}

export interface MeasureArg {
  key: string;
  /** The file address the page's reads gave for this video: a video that has another by now is not measured. */
  expect: string;
  budgetMs: number;
  maxBytes: number;
  cutSeconds: number;
  maxPcmBytes: number;
  minSeconds: number;
  maxFrames: number;
  maxWidth: number;
  maxHeight: number;
  maxPixels: number;
  maxSide: number;
}
type RawMeasure = VideoMeasure & { key: string; gone?: string };

/**
 * Runs in a document (self-contained; `sound`, `marks`, `layout`, `cutFile` and `secondsFor` are `soundFeatures`,
 * `frameMarks`, `mediaLayout`, `mediaCut` and `decodeSeconds`, sent in with it): measures the one video with
 * `arg.key`. The HTTP status of captions files the browser failed to load; its file, fetched once and stopped at
 * `maxBytes`; its sound, from a cut of those bytes that holds no more than the limits allow, decoded and never
 * played; frames at moments of speech, from a copy of the video that is never added to the page and reads the
 * fetched bytes. Every wait ends at the budget, and everything it made is let go of at the end.
 */
async function measureVideo(
  arg: MeasureArg,
  sound: (samples: Float32Array) => { seconds: number; moments: number[] },
  marks: (rgba: Uint8ClampedArray, width: number, height: number) => { marked: number; cells: number },
  layout: (bytes: Uint8Array, cutSeconds: number) => MediaLayout,
  cutFile: (bytes: Uint8Array, cut: MediaCut) => Uint8Array,
  secondsFor: (audio: readonly DeclaredSound[], maxPcmBytes: number) => number,
): Promise<RawMeasure> {
  const started = performance.now();
  const left = () => arg.budgetMs - (performance.now() - started);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ms: number, done: () => boolean): Promise<boolean> => {
    const end = performance.now() + Math.max(0, Math.min(ms, left()));
    while (!done() && performance.now() < end) await pause(40);
    return done();
  };
  const http = (u: string | null | undefined) => {
    if (!u) return '';
    try {
      const abs = new URL(u, document.baseURI).href;
      return /^https?:/i.test(abs) ? abs : '';
    } catch {
      return '';
    }
  };
  const OUT_OF_TIME = 'the time for this page ran out before it was measured';
  const m: RawMeasure = { key: arg.key, src: '', sound: { state: 'unknown', why: OUT_OF_TIME }, picture: { state: 'unknown', why: OUT_OF_TIME } };
  const both = (why: string): RawMeasure => {
    m.sound = { state: 'unknown', why };
    m.picture = { state: 'unknown', why };
    return m;
  };
  // The same element the page's reads were of (its key), wherever it is in the document by now.
  const KEY = Symbol.for('grnted.media.key');
  const v = ([...document.querySelectorAll('video')] as HTMLVideoElement[]).find((el) => (el as unknown as Record<symbol, unknown>)[KEY] === arg.key);
  if (!v || !v.isConnected) return { ...m, gone: 'it was no longer on the page when the test came to measure it' };
  // The file measured is the one every browser is offered first: the element's own address, else its first
  // source. When this browser chose another one, or could not load the first, nothing is measured: another
  // source may be another recording (review round 1, S3).
  const sources = ([...v.children] as Element[]).filter((c) => c.tagName === 'SOURCE' && !!c.getAttribute('src')) as HTMLSourceElement[];
  const own = v.hasAttribute('src') ? http(v.getAttribute('src')) : '';
  const first = own || (sources[0] ? http(sources[0].getAttribute('src')) : '');
  const current = http(v.currentSrc);
  if ((current || first) !== arg.expect) return { ...m, gone: 'its file changed while the page was read' };
  if (!first) return both('it has no file address the test can fetch (a script streams it)');
  m.src = first;
  if (v.error || (v.networkState === 3 && v.readyState === 0)) return both('the browser the test runs in could not load this video, so nothing was measured');
  if (current && current !== first) return both('this browser plays another of the video\'s files than the first one it lists; the first one, which other browsers play, was not measured');
  if (!current && !own && (sources.some((s) => s.hasAttribute('media')) || (!!sources[0]?.type && !v.canPlayType(sources[0].type)))) {
    return both('the browser the test runs in may not play the first file this video lists, so nothing was measured');
  }
  if (left() < 2500) return m;
  // Captions files the browser failed to load: what the site answers for them.
  const failed = ([...v.querySelectorAll('track')] as HTMLTrackElement[])
    .filter((t) => (t.kind === 'captions' || t.kind === 'subtitles') && !!t.getAttribute('src') && t.readyState === 3).slice(0, 5);
  if (failed.length) {
    m.missing = [];
    for (const t of failed) {
      let status = 0;
      const stop = new AbortController();
      const timer = setTimeout(() => stop.abort(), Math.max(0, Math.min(2500, left() - 2000)));
      try {
        const res = await fetch(t.src, { method: 'GET', signal: stop.signal, credentials: 'same-origin' });
        status = res.status;
        res.body?.cancel().catch(() => {});
      } catch {
        status = 0;
      }
      clearTimeout(timer);
      stop.abort();
      m.missing.push(status);
    }
  }
  const timers: ReturnType<typeof setTimeout>[] = [];
  const stop = new AbortController();
  let copy: HTMLVideoElement | null = null;
  let blobUrl = '';
  try {
    // 1. The file: one download, read as it comes and stopped at the limit (review round 1, S6).
    let all: Uint8Array;
    let type = '';
    try {
      timers.push(setTimeout(() => stop.abort(), Math.max(0, Math.min(7000, left() - 1500))));
      const res = await fetch(first, { signal: stop.signal, credentials: 'same-origin' });
      if (!res.ok) throw { why: `its file answered HTTP ${res.status} to the test's own request` };
      const tooLarge = { why: `its file is larger than ${Math.round(arg.maxBytes / 1024 / 1024)} MB, more than the test fetches` };
      const length = Number(res.headers.get('content-length') ?? NaN);
      if (Number.isFinite(length) && length > arg.maxBytes) throw tooLarge;
      const reader = res.body?.getReader();
      if (!reader) throw { why: 'its file could not be read by the test' };
      let buf = new Uint8Array(Number.isFinite(length) && length > 0 ? length : 1 << 20);
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (size + value.byteLength > arg.maxBytes) throw tooLarge;
        if (size + value.byteLength > buf.length) {
          const grown = new Uint8Array(Math.min(arg.maxBytes, Math.max(buf.length * 2, size + value.byteLength)));
          grown.set(buf.subarray(0, size));
          buf = grown;
        }
        buf.set(value, size);
        size += value.byteLength;
      }
      all = buf.subarray(0, size);
      type = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
    } catch (err) {
      // The download ends here, whatever it had left.
      stop.abort();
      if (err && typeof err === 'object' && 'why' in err) return both(String((err as { why: unknown }).why));
      return both(left() < 1500 ? OUT_OF_TIME : (err as Error)?.name === 'AbortError' ? 'its file did not download in time' : 'its file could not be fetched by the test (a file on another site that does not allow it, or a request that was stopped)');
    }
    // The size of its picture, as the file declares it, before a copy of it is made (review media-v, S4): a picture
    // over the budget is not read at all, so nothing of it is decoded.
    const pre = layout(all, arg.cutSeconds);
    const tooLarge = (w: number, h: number) => w * h > arg.maxPixels || Math.max(w, h) > arg.maxSide;
    const sizeWords = (w: number, h: number) => `its picture is ${w} x ${h} pixels, more than the ${arg.maxSide} px a side and ${Math.round(arg.maxPixels / 1e5) / 10} million pixels the test reads frames of, so it was not measured`;
    if (pre.width && pre.height && tooLarge(pre.width, pre.height)) return both(sizeWords(pre.width, pre.height));
    if (pre.pictureWhy) return both(`the size of its picture cannot be trusted (${pre.pictureWhy}), so it was not measured`);
    // 2. A copy of the video, never added to the page, that reads the bytes just fetched: it makes no request
    // of its own, and the page's own element is not touched. It loads only what describes the file (its
    // metadata) until a frame is asked for.
    blobUrl = URL.createObjectURL(new Blob([all as Uint8Array<ArrayBuffer>], /^(?:video|audio)\//.test(type) ? { type } : {}));
    const made = document.createElement('video');
    copy = made;
    made.muted = true;
    made.preload = 'metadata';
    made.src = blobUrl;
    const loaded = await until(4000, () => made.readyState >= 1 || !!made.error);
    if (!loaded || made.error) return both(left() < 1500 ? OUT_OF_TIME : 'the browser the test runs in could not read the fetched file as a video');
    // The picture's size as the browser reads it (from what the codec says, which the file's own figures may not
    // match), before any frame is drawn.
    if (tooLarge(made.videoWidth, made.videoHeight)) return both(sizeWords(made.videoWidth, made.videoHeight));
    // Within the budget: the copy now reads the rest of the bytes (already in memory) at once, so no read of it is
    // left open when it is let go of (a read left open was a request the page's guard went on waiting for).
    made.preload = 'auto';
    await until(3000, () => made.readyState >= 4 || (made.buffered.length > 0 && made.buffered.end(made.buffered.length - 1) >= made.duration - 0.25));
    if (!Number.isFinite(made.duration)) return both('it has no set length (a live stream, or a file whose length could not be read)');
    // 3. Sound: what the file says its sound track is, then no more of it than the limits allow, decoded to
    // 16 kHz and mixed to mono (review round 1, S7: the bound is set before anything is decoded).
    let features: ReturnType<typeof sound> | null = null;
    try {
      const lay = pre;
      if (lay.why || lay.container === 'unknown') throw { why: `the test could not read how its file is laid out (${lay.why ?? 'not an MP4 or WebM file'}), so its sound was not decoded` };
      if (!lay.audio.length) {
        // The file declares no sound track: the browser's own reading of it must say the same.
        let none = false;
        try {
          const stream = (made as HTMLVideoElement & { captureStream?: () => MediaStream }).captureStream?.();
          if (stream) {
            none = stream.getAudioTracks().length === 0 && stream.getVideoTracks().length > 0;
            stream.getTracks().forEach((t) => t.stop());
          }
        } catch {
          none = false;
        }
        if (none) {
          m.sound = { state: 'none' };
          throw { done: true };
        }
        throw { why: 'its file declares no sound track, which the browser could not confirm' };
      }
      const memory = secondsFor(lay.audio, arg.maxPcmBytes);
      const format = lay.audio.map((a) => `${a.codec.trim() || 'unnamed'}${a.channels ? `, ${a.channels} channels at ${a.rate} Hz` : ''}`).join('; ');
      if (!memory) throw { why: `its sound track is in a format the test cannot size before decoding it (${format})` };
      const most = Math.min(arg.cutSeconds, memory);
      if (most < arg.minSeconds) throw { why: `decoding its sound track (${format}) would take more memory than the test allows itself` };
      // A decoder makes sound of every packet it is handed, whatever times and length the file gives: the packets
      // are counted first (`census`), and the file's figures must hold them (fix round 1, S7).
      const counted = (l: MediaLayout): number => {
        if (l.census === undefined) throw { why: `the test could not count the packets of its sound track (${l.censusWhy ?? 'its layout is not one the test reads'}), so it was not decoded` };
        return l.census;
      };
      const told = Math.max(made.duration, lay.seconds);
      const packets = counted(lay);
      if (packets > told * 1.1 + 5) throw { why: `its file holds packets for up to ${Math.round(packets)} s of sound, more than the ${Math.round(told * 10) / 10} s it gives as its length, so it was not decoded` };
      let input: ArrayBuffer;
      let holds = told;
      let cut = false;
      if (told <= most && packets <= memory) {
        input = all.byteOffset === 0 && all.byteLength === all.buffer.byteLength ? (all.buffer as ArrayBuffer) : (all.slice().buffer as ArrayBuffer);
      } else {
        // Longer than the test decodes: only its first stretch goes to the decoder, cut where the file's own
        // parts allow (a little before the most allowed, since a part may run past the place asked for).
        const part = layout(all, Math.max(arg.minSeconds, most - 6));
        if (!part.cut) throw { why: `it is longer (${Math.round(told)} s) than the ${most} s of sound the test decodes at once, and its file could not be cut there (${part.cutWhy ?? 'no place to cut'})` };
        if (part.cut.seconds > memory) throw { why: `it is longer (${Math.round(told)} s) than the sound the test decodes at once, and the first place its file can be cut holds more than that` };
        if (part.cut.seconds < arg.minSeconds) throw { why: `it is longer (${Math.round(told)} s) than the ${most} s of sound the test decodes at once, and its file can be cut only after ${Math.round(part.cut.seconds)} s of sound, too little to measure` };
        const bytes = cutFile(all, part.cut);
        // The cut file's own packets, counted again: what the decoder is handed must fit the limit too.
        const kept = counted(layout(bytes, arg.cutSeconds));
        if (kept > memory || kept > part.cut.seconds * 1.1 + 5) throw { why: `the cut of its file the test would decode holds packets for up to ${Math.round(kept)} s of sound, more than the ${Math.round(part.cut.seconds)} s its times give or the ${memory} s the test decodes at once, so it was not decoded` };
        input = bytes.buffer as ArrayBuffer;
        holds = part.cut.seconds;
        cut = true;
      }
      const Offline = window.OfflineAudioContext ?? (window as unknown as { webkitOfflineAudioContext?: typeof OfflineAudioContext }).webkitOfflineAudioContext;
      if (!Offline) throw { why: 'this browser cannot decode sound for the test' };
      // One decode at a time on a page (review media-v, S6). The browser cannot stop a decode it has started:
      // an OfflineAudioContext has no close(), and closing an AudioContext does not stop its decodeAudioData either
      // (measured in the scan's browser: 20 ms into a 400 s decode the context closed, the decode still resolved
      // with all 400 s, as late as one left alone). So the test never starts a decode while one it started on the
      // page is still running (the mark is cleared when the browser finishes it, even after the test stopped
      // waiting), and every decode it starts is bounded beforehand (the census, the memory limit), so it ends.
      // The mark is the page's, shared by its own document and every same-site frame it reads (review media-cut,
      // S2): it lives on the top window, which a same-site frame can reach.
      const BUSY = Symbol.for('grnted.media.decoding');
      const marks = ((): Record<symbol, boolean | undefined> => {
        try {
          if (window.top && window.top.document) return window.top as unknown as Record<symbol, boolean | undefined>;
        } catch { /* a frame of another site: its own window */ }
        return window as unknown as Record<symbol, boolean | undefined>;
      })();
      if (marks[BUSY]) throw { why: 'a decode the test started earlier on this page had not finished, so this one was not started' };
      let audio: AudioBuffer;
      try {
        marks[BUSY] = true;
        const job = new Offline(1, 16_000, 16_000).decodeAudioData(input);
        job.then(() => { marks[BUSY] = false; }, () => { marks[BUSY] = false; });
        audio = await Promise.race([
          job,
          // A decode that does not come back is not waited for past its deadline (what it was handed is bounded, so it ends).
          new Promise<never>((_, no) => { timers.push(setTimeout(() => no({ why: 'its sound took too long to decode' }), Math.max(0, Math.min(5000, left() - 500)))); }),
        ]);
      } catch (err) {
        throw err && typeof err === 'object' && 'why' in err ? err : { why: 'its sound track could not be decoded' };
      }
      m.decoded = { seconds: Math.round(audio.duration * 100) / 100, channels: audio.numberOfChannels, cut };
      // What came out must be what the file declared: otherwise the bound was set on a false figure.
      if (audio.numberOfChannels > Math.max(...lay.audio.map((a) => a.channels)) || audio.duration > holds + 5) throw { why: 'its sound track is not what its file declares, so it was not measured' };
      const n = Math.min(audio.length, 60 * 16_000);
      const mono = new Float32Array(n);
      for (let ch = 0; ch < audio.numberOfChannels; ch++) {
        const data = audio.getChannelData(ch);
        for (let i = 0; i < n; i++) mono[i] = mono[i]! + data[i]! / audio.numberOfChannels;
      }
      features = sound(mono);
      m.sound = { state: 'measured', features: features as never };
    } catch (err) {
      if (!(err && typeof err === 'object' && 'done' in err)) m.sound = { state: 'unknown', why: err && typeof err === 'object' && 'why' in err ? String((err as { why: unknown }).why) : 'its sound could not be measured' };
    }
    // 4. Picture: frames at moments of speech (only when the sound has voiced stretches to look at).
    const times = features?.moments ?? [];
    if (times.length >= 6) {
      if (!made.videoWidth || !made.videoHeight) {
        m.picture = { state: 'unknown', why: left() < 1500 ? OUT_OF_TIME : 'the video\'s picture did not load in time' };
      } else {
        const baseW = made.videoWidth;
        const baseH = made.videoHeight;
        const scale = Math.min(1, arg.maxWidth / made.videoWidth, arg.maxHeight / made.videoHeight);
        const w = Math.max(1, Math.round(made.videoWidth * scale));
        const h = Math.max(1, Math.round(made.videoHeight * scale));
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const g = canvas.getContext('2d', { willReadFrequently: true });
        const frames: { at: number; marked: number; cells: number }[] = [];
        let why = '';
        if (!g) why = 'this browser gave the test no canvas to read frames with';
        // A moment of speech past the length the browser reads for the video has no frame of its own: never read
        // as the last frame instead.
        else if (times.slice(0, arg.maxFrames).some((at) => at > made.duration + 0.5)) why = 'its sound runs past the length the browser reads for its picture';
        for (const at of times.slice(0, arg.maxFrames)) {
          if (why) break;
          if (left() < 700) { why = OUT_OF_TIME; break; }
          const t = Math.max(0, Math.min(at, made.duration - 0.05));
          let seeked = false;
          const on = () => { seeked = true; };
          made.addEventListener('seeked', on, { once: true });
          made.currentTime = t;
          await until(2500, () => seeked && made.readyState >= 2);
          made.removeEventListener('seeked', on);
          if (!seeked || made.readyState < 2 || Math.abs(made.currentTime - t) > 0.25) { why = 'a frame of the video did not load in time'; break; }
          // Every frame is the size that was checked (review media-cut, S3): a picture that changes size is not read.
          if (made.videoWidth !== baseW || made.videoHeight !== baseH) { why = 'its picture changed size while the test read it'; break; }
          try {
            g!.clearRect(0, 0, w, h);
            g!.drawImage(made, 0, 0, w, h);
            const data = g!.getImageData(0, 0, w, h).data;
            // A frame that was not drawn leaves the canvas clear: never read as a plain picture.
            if (data[3] !== 255 || data[data.length - 1] !== 255 || data[(Math.floor(h / 2) * w + Math.floor(w / 2)) * 4 + 3] !== 255) { why = 'a frame of the video could not be drawn'; break; }
            const fm = marks(data, w, h);
            frames.push({ at: Math.round(t * 100) / 100, marked: fm.marked, cells: fm.cells });
          } catch {
            why = 'the video is on another site that does not let a page read its picture';
          }
        }
        m.picture = why ? { state: 'unknown', why } : { state: 'read', frames };
      }
    } else if (features) {
      m.picture = { state: 'unknown', why: 'its sound has too few voiced stretches to sample frames at' };
    } else if (m.sound.state === 'unknown') {
      m.picture = { state: 'unknown', why: 'its sound was not measured, so no moments of speech were known' };
    }
    return m;
  } finally {
    // Whatever happened: no timer, download, copy of the video or held bytes outlives the measurement.
    for (const t of timers) clearTimeout(t);
    stop.abort();
    if (copy) {
      try {
        copy.removeAttribute('src');
        copy.load();
      } catch { /* the copy is dropped either way */ }
    }
    if (blobUrl) URL.revokeObjectURL(blobUrl);
  }
}

/** The source the measuring runs as in a document: `measureVideo` with the functions it needs sent along. */
export const measureExpression = (arg: MeasureArg): string =>
  `(${measureVideo.toString()})(${JSON.stringify(arg)}, ${soundFeatures.toString()}, ${frameMarks.toString()}, ${mediaLayout.toString()}, ${mediaCut.toString()}, ${decodeSeconds.toString()})`;

interface ConfirmArg { key: string; expect: string; moments: number[]; tracks: number; trackElements: number; textTracks: number; budgetMs: number; trackWaitMs: number }
type RawConfirm = VideoConfirm | null;

/**
 * Runs in a document (self-contained): right before a failure is filed, plays the page's own video with
 * `arg.key` (muted, from just before a moment of speech, for a little over a second) and reads its captions
 * again (review round 1, S1 and S3). Captions a script gives a video when it plays (a track element, a text
 * track, text shown next to or over the video) are there only once it plays; a script on another site, or one
 * that listens with addEventListener, shows nothing of that beforehand. The video is scrolled to first (a script
 * may wait for that too), then put back as it was: paused, at its old place, with its own sound setting.
 * 'changed' when the element, its file or its tracks are not what the page's first reads gave.
 */
async function confirmVideo(arg: ConfirmArg): Promise<RawConfirm> {
  const started = performance.now();
  const left = () => arg.budgetMs - (performance.now() - started);
  const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const until = async (ms: number, done: () => boolean): Promise<boolean> => {
    const end = performance.now() + Math.max(0, Math.min(ms, left()));
    while (!done() && performance.now() < end) await pause(40);
    return done();
  };
  const http = (u: string | null | undefined) => {
    if (!u) return '';
    try {
      const abs = new URL(u, document.baseURI).href;
      return /^https?:/i.test(abs) ? abs : '';
    } catch {
      return '';
    }
  };
  const KEY = Symbol.for('grnted.media.key');
  const v = ([...document.querySelectorAll('video')] as HTMLVideoElement[]).find((el) => (el as unknown as Record<symbol, unknown>)[KEY] === arg.key);
  if (!v || !v.isConnected) return { state: 'changed', why: 'it was no longer on the page when the test came to play it' };
  const file = () => http(v.currentSrc) || http(v.getAttribute('src')) || http(v.querySelector('source[src]')?.getAttribute('src'));
  if (file() !== arg.expect) return { state: 'changed', why: 'its file is not the one the test measured' };
  /** Its captions as they are now: track elements, text tracks of any kind, cues in captions and subtitles tracks, captions files still loading. */
  const captions = () => {
    const elements = ([...v.querySelectorAll('track')] as HTMLTrackElement[]);
    let cues = 0;
    for (const t of [...v.textTracks]) if (t.kind === 'captions' || t.kind === 'subtitles') cues += t.cues?.length ?? 0;
    const withFile = elements.filter((t) => (t.kind === 'captions' || t.kind === 'subtitles') && !!t.getAttribute('src'));
    return { elements: elements.length, withFile: withFile.length, list: v.textTracks.length, cues, loading: withFile.filter((t) => t.readyState === 1 || (t.readyState === 0 && t.track.mode !== 'disabled')).length };
  };
  try {
    v.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  } catch { /* stays where it is */ }
  await pause(250);
  const before = captions();
  // What the page's first reads gave must still be so: the same tracks, and no captions in them.
  if (Math.min(10, before.withFile) !== arg.tracks || before.elements !== arg.trackElements || before.list !== arg.textTracks) return { state: 'changed', why: 'its captions tracks are not the ones the test read at first' };
  if (before.cues > 0) return { state: 'played', seconds: 0, at: 0, added: 0, cues: before.cues, loading: 0 };
  /** Shown to a visitor: not inside something closed or hidden (a closed disclosure's content still has a box). */
  const visible = (el: Element): boolean => (typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true }) : true);
  interface Box { l: number; t: number; r: number; b: number; dl: number; dt: number; shown?: boolean }
  /**
   * The box of every element of the page that has one (the video and its wrappers left out), in the window and
   * in the document; with `shown`, also whether each is shown. Read from the boxes themselves: an overlay that
   * lets clicks through to the video, as caption overlays do, is not found by asking what is at a point.
   */
  const boxes = (shown: boolean): Map<Element, Box> => {
    const map = new Map<Element, Box>();
    const sx = window.scrollX;
    const sy = window.scrollY;
    for (const el of [...document.body.querySelectorAll('*')].slice(0, 30_000)) {
      if (el === v || el.contains(v) || v.contains(el)) continue;
      const e = el.getBoundingClientRect();
      if (!(e.width > 0 && e.height > 0)) continue;
      map.set(el, { l: e.left, t: e.top, r: e.right, b: e.bottom, dl: e.left + sx, dt: e.top + sy, ...(shown ? { shown: visible(el) } : {}) });
    }
    return map;
  };
  /** Of those, the shown ones whose box crosses the video's box by more than a pixel. */
  const overOf = (map: Map<Element, Box>): Element[] => {
    const r = v.getBoundingClientRect();
    if (!(r.width > 2 && r.height > 2)) return [];
    const found: Element[] = [];
    for (const [el, e] of map) if (e.l < r.right - 1 && e.r > r.left + 1 && e.t < r.bottom - 1 && e.b > r.top + 1 && (e.shown ?? visible(el))) found.push(el);
    return found;
  };
  // The text next to and over the video: its wrappers (up to three levels, not the page's main content), the two
  // blocks before and after it, and whatever else lies over its box.
  const scopes = (over: readonly Element[]): Element[] => {
    const list: Element[] = [];
    let node: Element = v;
    for (let up = 0; up < 3; up++) {
      const p: Element | null = node.parentElement;
      if (!p || p === document.body || p === document.documentElement || p.matches('main, [role="main"]')) break;
      list.push(p);
      node = p;
    }
    if (!list.length) {
      for (const dir of ['previousElementSibling', 'nextElementSibling'] as const) {
        let sib: Element | null = v[dir];
        for (let i = 0; sib && i < 2; i++, sib = sib[dir]) list.push(sib);
      }
    } else {
      const top = list[list.length - 1]!;
      if (top.previousElementSibling) list.push(top.previousElementSibling);
      if (top.nextElementSibling) list.push(top.nextElementSibling);
    }
    for (const el of over) if (!list.some((s) => s === el || s.contains(el))) list.push(el);
    return list;
  };
  const words = (el: Element): string => ((el as HTMLElement).innerText ?? el.textContent ?? '').replace(/\s+/g, ' ').trim();
  const textOf = (list: readonly Element[]): string => list.map(words).join(' ¶ ').slice(0, 20_000);
  // What lay over the picture before it played: anything new there, or a change to what was there, may be
  // captions the page draws itself (text, or a drawing with no text in it).
  const boxesBefore = boxes(true);
  const overBefore = overOf(boxesBefore);
  // What already lies over the picture and can draw (a canvas, a drawing, a picture or frame, an element with a
  // background, text or generated content of its own) may show captions as the video plays without any change the
  // test can see: a canvas draws with no change to the page (review media-v, S1). Undecided, never failed.
  const paints = (el: Element): boolean => {
    if (/^(?:canvas|svg|img|picture|video|iframe|object|embed)$/i.test(el.tagName) || el instanceof SVGElement) return true;
    const st = getComputedStyle(el);
    if (st.backgroundImage !== 'none') return true;
    const bg = st.backgroundColor.replace(/\s+/g, '');
    if (bg && bg !== 'transparent' && !/^rgba\([^)]*,0(?:\.0+)?\)$/.test(bg)) return true;
    if ([...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim())) return true;
    for (const at of ['::before', '::after']) { const c = getComputedStyle(el, at).content; if (c && c !== 'none' && c !== 'normal') return true; }
    return false;
  };
  const painter = overBefore.find(paints);
  if (painter) {
    const named = `${painter.tagName.toLowerCase()}${painter.id ? `#${painter.id}` : typeof painter.className === 'string' && painter.className.trim() ? `.${painter.className.trim().split(/\s+/)[0]}` : ''}`;
    return { state: 'covered', what: named.slice(0, 60) };
  }
  /**
   * Something that lies over the picture now and did not before, and is there because IT came: a new element, one
   * that was hidden, or one whose box moved or changed size. An element that stands where it stood, and is over the
   * picture only because the video's own box changed (a video takes its picture's size once it plays), is not it.
   */
  const cameOver = (now: Map<Element, Box>): boolean => overOf(now).some((el) => {
    if (overBefore.includes(el)) return false;
    const was = boxesBefore.get(el);
    const is = now.get(el)!;
    if (!was || !was.shown) return true;
    const same = (a: number, b: number) => Math.abs(a - b) <= 1;
    const size = same(was.r - was.l, is.r - is.l) && same(was.b - was.t, is.b - is.t);
    const stood = (same(was.l, is.l) && same(was.t, is.t)) || (same(was.dl, is.dl) && same(was.dt, is.dt));
    return !(size && stood);
  });
  const around = scopes(overBefore);
  const textBefore = textOf(around);
  const MARKS = ['class', 'hidden', 'aria-current', 'aria-hidden', 'aria-selected', 'data-active', 'data-current'];
  // The video's part of the page (its figure, section or article; without one, the blocks between the headings
  // round it): text there that a script marks while the video plays (a transcript that follows it) counts too.
  const part = ((): Element[] => {
    const box = v.closest('figure, section, article, aside, li, td, dd, details, dialog');
    if (box) return [box];
    let node: Element = v;
    while (node.parentElement && node.parentElement !== document.body && !node.parentElement.matches('main, [role="main"]')) node = node.parentElement;
    const list = [node];
    for (let x = node.previousElementSibling; x && !/^H[1-6]$/.test(x.tagName); x = x.previousElementSibling) list.push(x);
    for (let x = node.nextElementSibling; x && !/^H[1-6]$/.test(x.tagName); x = x.nextElementSibling) list.push(x);
    return list;
  })();
  // Text that comes and goes while it plays is seen by the changes themselves, not only by the text at the end.
  let came = '';
  const inScope = (node: Node): boolean => {
    const el = node.nodeType === 1 ? (node as Element) : node.parentElement;
    if (!el || el === v || v.contains(el) || el.contains(v) || !el.isConnected) return false;
    // The video's wrappers and neighbours as they are now: a box a script puts next to the video as it plays is
    // one of them (the lab found such a box missed when only the neighbours from before playing were read).
    if ([...around, ...scopes(overBefore)].some((s) => s === el || s.contains(el))) return true;
    const r = v.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    return er.width > 0 && er.height > 0 && er.left < r.right && er.right > r.left && er.top < r.bottom && er.bottom > r.top;
  };
  const watch = new MutationObserver((list) => {
    for (const x of list.slice(0, 200)) {
      if (came) return;
      if (x.type === 'attributes') {
        const el = x.target as Element;
        // A block around the video whose generated content (::before, ::after) may show what is said, changed as it
        // played (review media-cut, S1): nothing in the page's text changes for that.
        if (el !== v && el.contains(v) && ['::before', '::after'].some((at) => { const c = getComputedStyle(el, at).content; return !!c && c !== 'none' && c !== 'normal'; })) { came = 'the generated content of a block around the video may have changed as it played'; continue; }
        if (el === v || el.contains(v) || v.contains(el)) continue;
        // Something that lies over the picture changed as it played.
        if (overBefore.some((s) => s === el || s.contains(el))) { came = 'what lies over the video changed as it played'; continue; }
        // Text in the video's part of the page that is marked (shown, hidden, made the current line) as it plays.
        const said = (el.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (MARKS.includes(x.attributeName ?? '') && said.split(' ').length >= 3 && [...around, ...part].some((s) => s === el || s.contains(el))) came = `marked as it played: ${said.slice(0, 60)}`;
        continue;
      }
      const nodes: Node[] = x.type === 'characterData' ? [x.target] : [...x.addedNodes].slice(0, 20);
      for (const node of nodes) {
        const said = (node.textContent ?? '').replace(/\s+/g, ' ').trim();
        if (said && inScope(node)) { came = said.slice(0, 80); return; }
      }
    }
  });
  const was = { paused: v.paused, time: v.currentTime, muted: v.muted };
  let seconds = 0;
  let at = 0;
  let why = '';
  let textDuring = textBefore;
  watch.observe(document.documentElement, { subtree: true, childList: true, characterData: true, attributes: true });
  try {
    v.muted = true;
    if (was.paused) {
      // From just before a moment of speech (a caption for it would be on screen then).
      const moment = arg.moments.find((t) => t >= 0.6) ?? arg.moments[0] ?? 0;
      const from = Math.max(0, moment - 0.5);
      try {
        if (from > 0.05) v.currentTime = from;
      } catch { /* it plays from where it is */ }
      try {
        const playing = v.play();
        if (playing) {
          // Pausing it again below ends a start that has not finished: that is no error of the page's.
          let refused: unknown;
          const started = playing.then(() => undefined, (err: unknown) => { refused = err ?? new Error('refused'); });
          await Promise.race([started, pause(Math.max(0, Math.min(2500, left() - 2500)))]);
          if (refused) throw refused;
        }
      } catch (err) {
        why = `the browser did not start it (${(err as Error)?.name || 'no reason given'})`;
      }
    }
    at = v.currentTime;
    if (!why) {
      await until(3500, () => v.currentTime - at >= 1.2 || v.ended || !!v.error);
      seconds = Math.max(0, v.currentTime - at);
      if (v.error) why = 'it did not load when the test played it';
      // The text there while it is still playing (text a script shows only as long as the video plays), and
      // whatever was put over the picture.
      // Its wrappers and neighbours as they are now (a box put next to it as it plays is one), with what lay over
      // the picture before it played: never what is over it only because the video's own box grew.
      textDuring = textOf(scopes(overBefore));
      if (!came && cameOver(boxes(false))) came = 'something was put over the video as it played';
    }
  } finally {
    // Back as it was.
    try {
      if (was.paused && !v.paused) v.pause();
    } catch { /* left as it is */ }
    try {
      if (was.paused && Math.abs(v.currentTime - was.time) > 0.01) v.currentTime = was.time;
    } catch { /* left as it is */ }
    try {
      v.muted = was.muted;
    } catch { /* left as it is */ }
  }
  // What playing it set off gets a second to arrive (a captions file the script asks for first, then adds), and
  // captions files that started loading get their time to load.
  await pause(Math.max(0, Math.min(1000, left() - 1500)));
  await until(arg.trackWaitMs, () => captions().loading === 0);
  await pause(150);
  const textAfter = textOf(scopes(overBefore));
  if (!came && cameOver(boxes(false))) came = 'something was put over the video as it played';
  watch.disconnect();
  const after = captions();
  if (!v.isConnected || file() !== arg.expect) return { state: 'changed', why: 'its file changed when the test played it' };
  if (why) return { state: 'not-played', why };
  for (const now of [textDuring, textAfter]) {
    if (came || now === textBefore) continue;
    // The first place the text differs.
    let i = 0;
    while (i < now.length && now[i] === textBefore[i]) i++;
    came = (now.slice(i, i + 80).trim() || textBefore.slice(i, i + 80).trim() || 'the text there changed').slice(0, 80);
  }
  return {
    state: 'played', seconds: Math.round(seconds * 100) / 100, at: Math.round(at * 100) / 100,
    added: Math.max(0, after.elements - before.elements) + Math.max(0, after.list - before.list),
    cues: after.cues, loading: after.loading, ...(came ? { text: came } : {}),
  };
}

/** Runs in the page: the iframe element is shown (a box, not hidden). */
function frameShown(el: unknown): boolean {
  const f = el as HTMLIFrameElement;
  if (!f || typeof f.getBoundingClientRect !== 'function') return false;
  const r = f.getBoundingClientRect();
  return r.width >= 40 && r.height >= 30 && (typeof f.checkVisibility === 'function' ? f.checkVisibility({ visibilityProperty: true }) : true);
}

/** Runs in a document: scrolls the video with `key` into view; its box in the document's viewport, or null. */
function videoBox(key: string): { x: number; y: number; width: number; height: number } | null {
  const KEY = Symbol.for('grnted.media.key');
  const v = [...document.querySelectorAll('video')].find((el) => (el as unknown as Record<symbol, unknown>)[KEY] === key);
  if (!v) return null;
  v.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' as ScrollBehavior });
  const r = v.getBoundingClientRect();
  return r.width >= 1 && r.height >= 1 ? { x: r.left, y: r.top, width: r.width, height: r.height } : null;
}

/** Runs in the page: back to the top (as the runner leaves a shared page between tests). */
function toTop(): void {
  window.scrollTo(0, 0);
}

/** Runs in a document: how many videos, audio players and links to sound files it has (a frame with none is not read further). */
function mediaCount(arg: { audioExt: string }): { videos: number; audio: number } {
  const ext = new RegExp(arg.audioExt, 'i');
  let links = 0;
  for (const a of [...document.querySelectorAll('a[href]')].slice(0, 2000) as HTMLAnchorElement[]) {
    try {
      if (ext.test(new URL(a.href, document.baseURI).pathname)) links++;
    } catch { /* not an address */ }
  }
  return { videos: document.querySelectorAll('video').length, audio: document.querySelectorAll('audio').length + links };
}

/** Runs in the page: same-origin iframes (with an address) whose document has not finished loading. */
function framesLoading(): number {
  let n = 0;
  for (const f of [...document.querySelectorAll('iframe[src]')].slice(0, 20) as HTMLIFrameElement[]) {
    let same = false;
    try {
      same = new URL(f.getAttribute('src') ?? '', document.baseURI).origin === location.origin;
    } catch {
      same = false;
    }
    // A lazy frame below the screen never loads until it is scrolled to: not waited for.
    if (!same || f.loading === 'lazy') continue;
    let doc: Document | null = null;
    try {
      doc = f.contentDocument;
    } catch {
      doc = null;
    }
    if (!doc || doc.readyState !== 'complete' || doc.URL === 'about:blank') n++;
  }
  return n;
}

/**
 * `within` for the page's own document: the value, or `fallback` at `ms`; but an error is thrown on, not turned
 * into the fallback. A browser that closed under the test must reach the runner as an error, so the test is run
 * again in a new one (as for every other test), not reported as a page it could not read.
 */
async function strictly<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([p, new Promise<T>((r) => { timer = setTimeout(() => r(fallback), Math.max(0, ms)); })]);
  } finally {
    clearTimeout(timer);
    p.catch(() => {});
  }
}

/** A document the test reads: the page itself, or a frame of it. */
interface Doc {
  /** Function calls (the page for the page's own document, else the frame). */
  call: { evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> };
  /** Source calls (the document's frame), when the browser gives the page's frames. */
  frame: FrameLike | undefined;
  /** For a frame: its address, said in the findings. */
  where?: string;
}

const pathOf = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 120);
  } catch {
    return url.slice(0, 120);
  }
};

interface DocumentRead { findings: ProbeFinding[]; audio: number; videos: number; failed?: string }

/**
 * The findings for one document, and what it holds: 1.2.1 for its sound-only items (`want.audio`), 1.2.2 for
 * its videos (`want.video`). Never throws; every wait ends at `by`. Each read of a video is joined to the
 * others by the element's key, never by its place in the document (review round 1, S3).
 */
async function readDocument(ctx: ProbeContext, doc: Doc, by: number, summary: unknown[], want: { audio: boolean; video: boolean }, kept: ProbeFinding[]): Promise<DocumentRead | null> {
  const left = () => by - Date.now();
  // A frame may leave the page while it is read (that reads as not read); the page's own document may not.
  const wait: typeof within = doc.where ? within : strictly;
  const media = await wait(Math.min(5000, Math.max(0, left())), doc.call.evaluate(pageMedia, { live: LIVE_TEXT_SOURCE, audioExt: AUDIO_EXT_SRC, perKind: MEDIA_FILES_LIMITS.perKind }) as Promise<PageMedia | null>, null);
  if (!media) return null;
  const findings: ProbeFinding[] = [];
  const tag = (x: ProbeFinding): ProbeFinding => (doc.where ? { ...x, detail: `In a frame of this page (${doc.where}): ${x.detail}` } : x);
  if (want.audio && media.audio.length) {
    // 1.2.1 covers recordings only: each item's length, as the browser reads it (review round 1, S4).
    const recorded = await recordedFor(doc.call, media.audio, Math.min(AUDIO_LENGTH.waitMs, Math.max(0, left() - 2000)));
    media.audio.forEach((a, i) => findings.push(tag(judgeAudio({ ...a, recorded: recorded[i] ?? 'unknown' }, nearOf(a.near, false)))));
  }
  if (!want.video || !media.videos.length) return { findings, audio: media.audio.length, videos: media.videos.length };
  const cues = await wait(MEDIA_FILES_TIMING.captionFiles + 1500, doc.call.evaluate(captionCues, { perKind: MEDIA_FILES_LIMITS.perKind, waitMs: Math.max(0, Math.min(MEDIA_FILES_TIMING.captionFiles, left() - 1500)) }), null);
  const around = await wait(Math.min(3000, Math.max(0, left())), doc.call.evaluate(videoSurroundings, { perKind: MEDIA_FILES_LIMITS.perKind }), null);
  if (!cues || !around) {
    for (const v of media.videos) findings.push({ criterion: '1.2.2', status: 'not_testable', target: v.target, detail: `this video${doc.where ? ` (in a frame of this page, ${doc.where})` : ''} could not be read in time.` });
    return { findings, audio: media.audio.length, videos: media.videos.length };
  }
  const facts: (VideoFacts & { key: string; src: string })[] = media.videos.map((v) => {
    const key = v.key ?? '';
    const c = key ? cues.find((x) => x.key === key) : undefined;
    const a = key ? around.find((x) => x.key === key) : undefined;
    // One element, one file: every read must have found this element, with the file the first read gave.
    const mixed = !key || !c || !a ? 'it was not there in every read of the page' : (c.src ?? '') !== v.src ? 'its file changed between two reads' : '';
    const forText = nearOf(v.near, false).forText ?? (a?.labelled ? true : undefined);
    return {
      key, src: v.src,
      target: v.target, shown: a?.shown ?? false, muted: v.muted, controls: v.controls, decorative: nativeVideoDecorative(v),
      ...(forText ? { forText } : {}),
      cues: c ?? { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'unknown' },
      ...(a?.captionArea ? { captionArea: a.captionArea } : {}),
      ...(a?.followed ? { followed: true } : {}),
      ...(a?.farControl ? { farControl: a.farControl } : {}),
      ...(a?.menuControl ? { menuControl: a.menuControl } : {}),
      ...(mixed ? { mixed } : {}),
      ...(doc.where ? { frame: doc.where } : {}),
    };
  });
  // The videos whose proof holds so far are measured, the first few of them, each in a call of its own: one that
  // runs out of time takes nothing from the ones measured before it (review round 1, S7).
  const wanted = facts.filter((v) => beforeMeasuring(v) === undefined).slice(0, MEDIA_FILES_LIMITS.measured);
  let scripts: ScriptsRead | null | undefined;
  let failed: string | undefined;
  for (const v of facts) {
    if (wanted.includes(v)) {
      const why = !doc.frame ? 'the browser gave the test no way to measure it' : 'the time for this page ran out before it was measured';
      let m: RawMeasure | null = null;
      if (doc.frame && left() > 3500) {
        // Code on the page that works with captions: read once a document, before its first video is measured.
        if (scripts === undefined) scripts = await wait(MEDIA_FILES_TIMING.scripts + 1000, doc.call.evaluate(captionScripts, { files: MEDIA_FILES_LIMITS.scripts, bytes: MEDIA_FILES_LIMITS.scriptBytes, budgetMs: Math.max(0, Math.min(MEDIA_FILES_TIMING.scripts, left() - 3000)) }), null);
        if (!scripts?.scripted && left() > 3000) {
          const budgetMs = Math.min(MEDIA_FILES_TIMING.video, left() - 1500);
          const arg: MeasureArg = {
            key: v.key, expect: v.src, budgetMs, maxBytes: MEDIA_FILES_LIMITS.maxBytes, cutSeconds: MEDIA_FILES_LIMITS.cutSeconds, maxPcmBytes: MEDIA_FILES_LIMITS.maxPcmBytes,
            minSeconds: MEDIA_FILES_LIMITS.minSeconds, maxFrames: MEDIA_FILES_LIMITS.maxFrames, maxWidth: MEDIA_FILES_LIMITS.maxWidth,
            maxHeight: MEDIA_FILES_LIMITS.maxHeight, maxPixels: MEDIA_FILES_LIMITS.maxPixels, maxSide: MEDIA_FILES_LIMITS.maxSide,
          };
          m = await wait(budgetMs + 1000, doc.frame.evaluate(measureExpression(arg)) as Promise<RawMeasure | null>, null);
        }
      }
      if (m?.gone) v.mixed = m.gone;
      v.measure = m
        ? { src: m.src, sound: m.sound, picture: m.picture, ...(m.missing ? { missing: m.missing } : {}), ...(m.decoded ? { decoded: m.decoded } : {}) }
        : { src: '', sound: { state: 'unknown', why }, picture: { state: 'unknown', why } };
      if (scripts?.scripted) v.measure.scripted = scripts.scripted;
      // Every link holds: the page's own video is played for a moment, and its captions read again, before the
      // failure is filed (review round 1, S1 and S3). The page is not used by another test afterwards.
      if (provenBeforePlaying(v) && left() > 3500) {
        const s = v.measure.sound as { state: 'measured'; features: { moments: number[] } };
        const mark = ctx.guard.mark();
        const budgetMs = Math.min(MEDIA_FILES_TIMING.confirm, left() - 2000);
        const played = await wait(budgetMs + 1000, doc.call.evaluate(confirmVideo, {
          key: v.key, expect: v.src, moments: s.features.moments, tracks: v.cues.tracks, trackElements: v.cues.trackElements ?? 0, textTracks: v.cues.textTracks ?? 0,
          budgetMs, trackWaitMs: Math.min(MEDIA_FILES_TIMING.captionFiles, Math.max(0, budgetMs - 4500)),
        }), null);
        discardUnlessAction(ctx);
        const stop = await settledStop(ctx, mark);
        v.confirm = !played ? { state: 'not-played', why: 'it did not answer in time' } : played.state === 'played' && stop ? { ...played, stop } : played;
      }
      const s = v.measure.sound;
      summary.push({
        video: v.target, ...(doc.where ? { frame: doc.where } : {}), captionsTracks: v.cues.tracks, cues: v.cues.cues,
        sound: s.state === 'measured' ? { seconds: s.features.seconds, heard: s.features.audibleSeconds, voiced: s.features.voicedSeconds } : s.state,
        ...(v.measure.decoded ? { decoded: v.measure.decoded } : {}),
        frames: v.measure.picture.state === 'read' ? v.measure.picture.frames.map((x) => `${x.at}:${x.marked}`) : v.measure.picture.state,
        ...(v.confirm ? { played: v.confirm.state === 'played' ? { seconds: v.confirm.seconds, at: v.confirm.at, added: v.confirm.added, cues: v.confirm.cues } : v.confirm.state } : {}),
        ...(scripts ? { scriptsUnread: scripts.unread } : {}),
        // Batch 18 (G8, G11): the rest of what was read, as data for the AI media review (no verdict here).
        loaded: v.cues.loaded, errors: v.cues.errors, ...(v.measure.missing?.length ? { missing: v.measure.missing } : {}),
        ...(s.state === 'measured' ? { speechAt: s.features.moments.slice(0, 12).map((t) => Math.round(t * 10) / 10) } : s.state === 'unknown' ? { soundWhy: s.why.slice(0, 160) } : {}),
        ...(v.cues.control ? { control: v.cues.control } : {}), ...(v.captionArea ? { captionArea: v.captionArea.slice(0, 120) } : {}),
        ...(v.menuControl ? { menuControl: v.menuControl } : {}), ...(v.farControl ? { farControl: v.farControl } : {}),
        ...(v.followed ? { followed: true } : {}), ...(v.forText ? { forText: typeof v.forText === 'string' ? v.forText.slice(0, 160) : true } : {}),
        ...(v.measure.scripted ? { scripted: v.measure.scripted.slice(0, 160) } : {}),
      });
    }
    const judged = judgeVideoCaptions(v);
    // The link of the proof that did not hold (the undecided result's own words), for the AI media review; a video
    // left undecided before it was measured (a track, a control, a frame) gets an entry of what was read too.
    const doubt = judged.find((x) => x.status === 'not_testable');
    if (v.measure && summary.length) {
      const last = summary[summary.length - 1] as Record<string, unknown>;
      if (last.video === v.target && doubt) last.doubt = doubt.detail.slice(0, 300);
    } else if (doubt && summary.length < 12) {
      summary.push({
        video: v.target, ...(doc.where ? { frame: doc.where } : {}), measured: false, captionsTracks: v.cues.tracks, cues: v.cues.cues,
        loaded: v.cues.loaded, errors: v.cues.errors, ...(v.cues.control ? { control: v.cues.control } : {}), doubt: doubt.detail.slice(0, 300),
      });
    }
    const failure = judged.filter((x) => x.status === 'failed');
    if (failure.length) {
      if (failed === undefined) failed = v.key;
      // A failure that is shown stands even if the time box cuts the rest of the run.
      kept.push(...failure);
      ctx.keep?.(kept);
    }
    findings.push(...judged);
  }
  return { findings, audio: media.audio.length, videos: media.videos.length, ...(failed !== undefined ? { failed } : {}) };
}

async function read(ctx: ProbeContext, want: { audio: boolean; video: boolean }): Promise<ProbeFinding[]> {
  const { page } = ctx;
  const by = ctx.deadline - MEDIA_FILES_TIMING.reserve;
  const main = (page.frames?.() ?? []).find((f) => !f.parentFrame());
  const summary: unknown[] = [];
  // Failures shown so far, in the page's document and in its frames together: the runner keeps them all if the
  // time box cuts the rest of the run (review media-v, S9: each document had its own list, and the last replaced the others).
  const kept: ProbeFinding[] = [];
  const top = await readDocument(ctx, { call: page, frame: main }, by, summary, want, kept);
  if (!top) throw new ProbeNotTestable('the video and audio on the page could not be read in time');
  const findings = [...top.findings];
  // A picture of the first video failed, where it is on the page.
  if (top.failed !== undefined && ctx.evidence && by - Date.now() > 3000) {
    const box = await within(1500, page.evaluate(videoBox, top.failed), null);
    if (box) {
      await ctx.evidence({
        criterion: '1.2.2', boxes: [{ ...box, kind: 'fail', label: 'speech, no captions' }],
        alt: 'The video on the page that has speech and no captions, outlined.',
      });
    }
  }
  await within(1000, page.evaluate(toTop, undefined), undefined);
  let audio = top.audio;
  let videos = top.videos;
  // Same-site frames that are not a known player: a self-hosted player page embedded by iframe. One that is
  // still loading (a player a page mounts late) is waited for, 2.5 s at most.
  const framesBy = Math.min(Date.now() + 2500, by - 4000);
  while (Date.now() < framesBy && !ctx.signal.aborted && (await within(1000, page.evaluate(framesLoading, undefined), 0)) > 0) await page.waitForTimeout(200);
  const all = page.frames?.() ?? [];
  let origin = '';
  try {
    origin = new URL(ctx.url).origin;
  } catch {
    origin = '';
  }
  // A frame that could not be read, or that is one more than the test reads, is said so: it may hold a video or
  // a recording, and "no video on this page" would be a result the test does not have (review round 1, S8).
  const criterion = want.video ? '1.2.2' : '1.2.1';
  const what = want.video ? 'video' : 'audio';
  const unread = (url: string, why: string): void => {
    findings.push({ criterion, status: 'not_testable', target: pathOf(url), detail: `a frame of this page (${pathOf(url)}) ${why}, so ${what} in it was not tested.` });
  };
  let read = 0;
  let looked = 0;
  for (const f of all) {
    const parent = f.parentFrame();
    if (!parent || parent.parentFrame()) continue;
    const url = f.url();
    let same = false;
    try {
      same = !!origin && new URL(url).origin === origin;
    } catch {
      same = false;
    }
    if (!same || classifyPlayer(url)) continue;
    if (ctx.signal.aborted || by - Date.now() < 2500 || looked >= MEDIA_FILES_LIMITS.framesLooked) {
      unread(url, looked >= MEDIA_FILES_LIMITS.framesLooked ? `is one more than the ${MEDIA_FILES_LIMITS.framesLooked} frames the test looks into` : 'was not read before the time for this page ran out');
      continue;
    }
    looked++;
    const handle = await within(1000, f.frameElement(), null);
    if (!handle) { unread(url, 'could not be read (it was loading again, or it left the page)'); continue; }
    // Whether it is shown: an error or no answer is a frame not read, never a hidden one (review media-v, S7).
    const shown = await within(1000, page.evaluate(frameShown, handle) as Promise<boolean | null>, null);
    if (shown === null) { unread(url, 'could not be read (whether it is shown did not come back: it was loading again, or it did not answer in time)'); continue; }
    if (!shown) continue;
    const holds = await within(1500, f.evaluate(mediaCount, { audioExt: AUDIO_EXT_SRC }), null);
    if (!holds) { unread(url, 'could not be read (it was loading again, or it did not answer in time)'); continue; }
    if (!(want.video ? holds.videos : holds.audio)) continue;
    if (read >= MEDIA_FILES_LIMITS.frames || by - Date.now() < 4000) {
      unread(url, read >= MEDIA_FILES_LIMITS.frames ? `holds ${what}, and is one more than the ${MEDIA_FILES_LIMITS.frames} such frames the test reads` : `holds ${what}, and was not read before the time for this page ran out`);
      continue;
    }
    read++;
    const inside = await readDocument(ctx, { call: f, frame: f, where: pathOf(url) }, by, summary, want, kept);
    if (!inside) { unread(url, `holds ${what} and could not be read (it was loading again, or it did not answer in time)`); continue; }
    findings.push(...inside.findings);
    audio += inside.audio;
    videos += inside.videos;
  }
  // A video that was played was scrolled to: the page is left at its top, as the runner leaves it between tests.
  await within(1000, page.evaluate(toTop, undefined), undefined);
  if (summary.length) ctx.setData?.({ videos: summary.slice(0, 12) });
  if (want.audio && !findings.length) findings.push({ criterion: '1.2.1', status: 'not_applicable', detail: audio || videos ? 'no sound-only player or file on this page' : 'no video or audio file on this page' });
  if (want.video && !videos && !findings.length) findings.push({ criterion: '1.2.2', status: 'not_applicable', detail: 'no video file on this page' });
  return findings;
}

/**
 * 1.2.2 for the page's own video files (core, every page). Scored since scoring v13 as a proof-only test
 * (src/score.ts): a failure it has shown counts; its other results count for nothing.
 */
export const mediaFilesProbe: PageProbe = {
  id: MEDIA_FILES_PROBE_ID,
  criteria: ['1.2.2'],
  kind: 'render',
  tier: 'core',
  everyPage: true,
  // Reading takes milliseconds; a video measured (one download, the first minute of its sound, up to 12 frames) about
  // 1 to 4 s, 9 s at most; a video played before a failure is filed about 2 s, 6.5 s at most.
  timeoutMs: 40_000,
  onlyNavigationVoids: true,
  // A player a page mounts a moment after it loads is read once it is there.
  waitFor: { content: true },
  note: 'a video is failed for missing captions only when its sound is shown to be speech, its picture shows nothing that could be captions, and no captions come when it plays; whether captions that are there are complete and accurate is not judged by this test',
  run: (ctx) => read(ctx, { audio: false, video: true }),
};

/** 1.2.1 for the page's own sound-only players and files (core, every page; listed, not scored). */
export const mediaAlternativesProbe: PageProbe = {
  // Listed, not scored, until a scoring version is calibrated with it (docs/scoring.md).
  scored: false,
  id: MEDIA_ALTERNATIVES_PROBE_ID,
  criteria: ['1.2.1'],
  kind: 'render',
  tier: 'core',
  everyPage: true,
  timeoutMs: 15_000,
  onlyNavigationVoids: true,
  waitFor: { content: true },
  note: 'only recordings are judged (a live stream is not); whether a transcript or text alternative that is there gives everything the recording says is not judged by this test',
  run: (ctx) => read(ctx, { audio: true, video: false }),
};
