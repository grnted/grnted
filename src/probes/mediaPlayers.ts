// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Media completion (Plan 4 Task 4.8): 1.2.1–1.2.5 for every player on the page. Deep, on a page of
// its own. Embedded players (YouTube, Vimeo and the other recognised video players) are played muted
// in the browser and never downloaded: the probe clicks only the player's own play control (a
// button, never a link), verified to be what is under the pointer, keeps every media element muted
// and Web Audio suspended in every frame from before the page's own scripts run, reads the captions
// control and the player's own caption list and live state, samples a few screenshots of the player
// while it plays, and reads what the page links next to it (transcript, audio-described version).
// Sound-only items need a transcript next to them (1.2.1); native videos get live (1.2.4) and
// description (1.2.3/1.2.5) checks. The request guard stays on: the player's own tracking requests it
// stops are expected and change no result the probe observed, and a player it could not observe is
// `not_testable`, never clean. Engine core: no Node-only imports.
import { collectedValue } from '../collect/index.js';
import { mediaCollector } from '../collect/media.js';
import { AUDIO_EXTENSIONS, classifyPlayer, mediaFileType, PLAYER_NAMES, type PlayerMatch } from '../media/detect.js';
import {
  captionsOf, controlKind, fillPage, isTranscriptHeading, judgeAudio, judgeCaptionCues, judgeNativeVideo, judgePlayer, linkKind, liveOf, LIVE_TEXT_SOURCE, MEDIA_PLAYER_CRITERIA,
  type CaptionCues, type NativeVideo, type Nearby, type PlayerObservation, type PlayerState, type Recorded,
} from '../media/players.js';
import type { FrameLike, PageAudit, PageLike, ProbeFinding } from '../types.js';
import { blockedReason } from './guard.js';
import { within } from './motionShared.js';
import { ProbeNotTestable, type GuardEvent, type PageProbe, type ProbeContext } from './types.js';
import { withoutDownloads } from './pressSafely.js';

export const MEDIA_PLAYERS_PROBE_ID = 'media-players';

/** Players tested per page; the rest are `not_testable`. Items read per kind on the page. */
export const MEDIA_PLAYER_LIMITS = { players: 4, perKind: 50, frames: 3 } as const;

/** Waits (ms). */
export const MEDIA_PLAYER_TIMING = {
  /** For a lazy player to get its address once scrolled into view. */
  lazy: 3000,
  /** For the player's frame to finish loading. */
  load: 6000,
  /** For a video's captions files to load, when the test reads their cues. */
  captionFiles: 3000,
  /** For the player to start after its play control was clicked. */
  start: 5000,
  /** After it started (and again with the pointer over it), for its captions control or list to show. */
  settle: 1500,
  /** Between screenshots of the player. */
  frameGap: 400,
  /** Time a player needs at least; a player reached with less left is `not_testable`. */
  perPlayer: 6000,
  /** Most time one player may take (every wait stops at this, or at the probe's own end). */
  playerMax: 15_000,
  /** The probe ends this long before its time box, so it returns what it found instead of being cut off. */
  reserve: 5000,
} as const;

// In every frame, before the page's scripts (the probe's init script) -------------------------------

/**
 * Runs in every frame of the probe's page before its own scripts (self-contained; also installable
 * later, which it then reports by returning false):
 * - every media element stays muted: the `muted` setter always sets true, the `volume` setter mutes
 *   too, `play()` mutes first, and `play`, `playing`, `volumechange` and `loadedmetadata` re-mute,
 *   in the document and in every shadow root (`attachShadow` is wrapped, so closed roots are seen);
 * - Web Audio stays silent: every AudioContext is suspended when made, and `resume()` does nothing.
 * Returns true when it ran before the page's scripts.
 */
function muteHook(): boolean {
  type Mute = { early: boolean; roots: ShadowRoot[]; contexts: BaseAudioContext[] };
  const w = window as unknown as Record<string, unknown> & { __grntedMute?: Mute };
  if (w.__grntedMute) return w.__grntedMute.early;
  const state: Mute = { early: document.readyState === 'loading', roots: [], contexts: [] };
  w.__grntedMute = state;
  const P = HTMLMediaElement.prototype;
  const md = Object.getOwnPropertyDescriptor(P, 'muted');
  const vd = Object.getOwnPropertyDescriptor(P, 'volume');
  if (!md?.get || !md.set) return false;
  const get = md.get;
  const set = md.set;
  Object.defineProperty(P, 'muted', { configurable: true, enumerable: md.enumerable ?? true, get() { return get.call(this); }, set() { set.call(this, true); } });
  if (vd?.get && vd.set) {
    const vget = vd.get;
    const vset = vd.set;
    Object.defineProperty(P, 'volume', { configurable: true, enumerable: vd.enumerable ?? true, get() { return vget.call(this); }, set(v: number) { vset.call(this, v); set.call(this, true); } });
  }
  const play = P.play;
  P.play = function playMuted(this: HTMLMediaElement) {
    try { set.call(this, true); } catch { /* keep */ }
    return play.call(this);
  };
  const hush = (e: Event) => {
    const t = e.target;
    if (t instanceof HTMLMediaElement && !get.call(t)) set.call(t, true);
  };
  const watch = (root: Document | ShadowRoot) => {
    for (const type of ['play', 'playing', 'volumechange', 'loadedmetadata']) root.addEventListener(type, hush, true);
  };
  watch(document);
  const attach = Element.prototype.attachShadow;
  Element.prototype.attachShadow = function attachShadow(this: Element, init: ShadowRootInit) {
    const root = attach.call(this, init);
    state.roots.push(root);
    watch(root);
    return root;
  };
  for (const name of ['AudioContext', 'webkitAudioContext']) {
    const AC = w[name] as (new (...a: unknown[]) => AudioContext) | undefined;
    if (typeof AC !== 'function') continue;
    AC.prototype.resume = function resume() { return Promise.resolve(); };
    const Wrapped = function AudioContext(...a: unknown[]) {
      const c = new AC(...a);
      state.contexts.push(c);
      c.suspend().catch(() => {});
      return c;
    } as unknown as typeof AC;
    Wrapped.prototype = AC.prototype;
    Object.setPrototypeOf(Wrapped, AC);
    w[name] = Wrapped;
  }
  for (const m of document.querySelectorAll('video, audio')) set.call(m, true);
  return state.early;
}

/** The mute hook as the probe's init script (the runner adds it before the page loads). */
const MUTE_SCRIPT = `(${muteHook.toString()})();`;

/** Runs in a frame: media playing with sound, or Web Audio running, anywhere in it (shadow roots too); stops them. */
function stopSound(): number {
  const m = (window as unknown as { __grntedMute?: { roots: ShadowRoot[]; contexts: BaseAudioContext[] } }).__grntedMute;
  let n = 0;
  for (const root of [document, ...(m?.roots ?? [])] as (Document | ShadowRoot)[]) {
    for (const el of root.querySelectorAll('video, audio') as NodeListOf<HTMLMediaElement>) {
      if (!el.paused && !el.muted && el.volume > 0) {
        n++;
        el.pause();
      }
    }
  }
  for (const c of m?.contexts ?? []) {
    if (c.state === 'running') {
      n++;
      (c as AudioContext).suspend?.().catch(() => {});
    }
  }
  return n;
}

// In the page ---------------------------------------------------------------------------------------

interface RawLink { name: string; href: string }
export interface RawNear {
  links: RawLink[]; heading?: string; liveText?: string;
  /** Text next to the item that the page gives as its text alternative (labelled, named a transcript, or tied to it). */
  alternative?: string;
  /** Unlabelled text right next to the item that describes sounds: it may be the alternative. */
  sounds?: string;
  /** Words next to the item (or its own name) that offer it as another way to get text that is on the page. */
  forText?: string;
  /** It sits right beside a video that has no sound track. */
  besideSilentVideo?: boolean;
  /** It sits right beside a video whose sound track could not be read (the video had not loaded). */
  besideUnknownVideo?: boolean;
  /** It sits right beside a video that has sound. */
  besideVideo?: boolean;
  /** The first link right beside it (its own block, or the two blocks before and after it, up to a heading) that is not its own file. */
  adjacent?: string;
}
interface RawFrame { index: number; src: string; dataSrc: string; title: string; near: RawNear }
interface RawFacade { src: string; what: string; near: RawNear }
/** What the browser read of a sound file's length: a set length, a stream with no end, or nothing (it had not loaded). */
export type MediaLength = 'finite' | 'infinite' | 'unknown';
export interface RawAudio { target: string; what: string; near: RawNear; length?: MediaLength }
/** `key`: the key the reader gives the element (a property under the symbol `grnted.media.key`), the same in every read of the page. */
export interface RawVideo extends Omit<NativeVideo, 'decorative'> { muted: boolean; controls: boolean; loop: boolean; hiddenSelf: boolean; near: RawNear; key?: string }
export interface PageMedia { frames: RawFrame[]; facades: RawFacade[]; audio: RawAudio[]; videos: RawVideo[]; consent: boolean }

/** Runs in the page (self-contained): the media on it and what the page offers next to each item. */
export function pageMedia(arg: { live: string; audioExt: string; perKind: number }): PageMedia {
  const L = new RegExp(arg.live, 'i');
  const clean = (s: string | null | undefined, n = 120) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const http = (u: string | null | undefined) => {
    if (!u) return '';
    try {
      const abs = new URL(u, document.baseURI).href;
      return /^https?:/i.test(abs) ? abs : '';
    } catch {
      return '';
    }
  };
  // Where to look: out from the media through its figure to its section (or article, list item…);
  // without one, the run of blocks between the headings around it.
  const sectionParts = (el: Element): Element[] => {
    const figure = el.closest('figure');
    const box = (figure ?? el).closest('section, article, aside, li, td, dd, details, dialog');
    if (box) return [box];
    if (figure) {
      // A figure on its own: the figure and the blocks between the headings around it.
      el = figure;
    }
    let node: Element = el;
    while (node.parentElement && node.parentElement !== document.body && !node.parentElement.matches('main, [role="main"]')) node = node.parentElement;
    const parts = [node];
    const level = (h: Element): number => Number(h.tagName.slice(1));
    // The heading this run of blocks stands under: the nearest one before it.
    let above = 0;
    for (let s = node.previousElementSibling; s; s = s.previousElementSibling) {
      if (/^H[1-6]$/.test(s.tagName)) { above = level(s); break; }
      parts.push(s);
    }
    // After it: up to the next heading. A heading below the part's own (a sub-heading of the same part: under an
    // h2, an h3 "Transcript" and the text after it) belongs to the part; so does a heading right after the item
    // that names a transcript or text version, with the blocks under it (batch 17, fix round 1: the sound-only lab
    // found a transcript written out under its own heading after the player failed as "no transcript").
    let named = false;
    for (let s = node.nextElementSibling; s; s = s.nextElementSibling) {
      if (/^H[1-6]$/.test(s.tagName)) {
        const sub = above >= 2 && level(s) > above;
        const names = !named && /^(?:full |read the |view the |video |audio )?(?:transcript|text (?:alternative|version))\b/i.test(clean(s.textContent, 60));
        if (!sub && !names) break;
        if (names) named = true;
      }
      parts.push(s);
    }
    return parts;
  };
  const nameOf = (el: Element) => clean(el.getAttribute('aria-label') || (el as HTMLElement).innerText || el.textContent || el.getAttribute('title'));
  const wordCount = (t: string | null | undefined) => ((t ?? '').match(/[\p{L}\p{N}]+/gu) ?? []).length;
  /** A block that says in its first words that it is the text alternative. */
  const ALT_LABEL = /^(?:text (?:alternative|version|equivalent|description)|audio description|sound description|description of (?:the |this )?(?:audio|sound|recording|clip)|what (?:you(?:'ll| will)? hear|is heard))\b/i;
  /** Words for sounds that are not speech (a clip of tones, bells or music is described, not transcribed). */
  const SOUNDS = /\b(?:no (?:speech|spoken words?|narration|dialogue)|nobody speaks|no one speaks|tones?|chimes?|beeps?|bells?|buzz(?:er|ers|ing)?|sirens?|horns?|whistles?|clang(?:s|ing)?|instrumental|music(?: only)? plays?|sounds? of)\b/i;
  /** A lead-in that gives the recording's words as text: "This recording says the following: …". */
  const SAID = /\b(?:audio|recording|sound ?clip|clip|podcast|episode|voice ?mail|announcement|speech|interview)\b[^:]{0,80}\b(?:contains?|says?|said|reads?|states?|follow(?:s|ing)?|words|in full)\b[^:]{0,40}:/i;
  /** Words that offer the audio or video as another way to get text that is on the page (WCAG 1.2.1 and 1.2.2: a media alternative for text). */
  const FOR_TEXT = /\b(?:also (?:listen|hear|watch)|(?:listen to|watch) (?:this|the) (?:article|page|text|story|post|statement|notice|letter|speech)|hear (?:this|the)(?: above)? (?:article|page|text|story|statement|notice|speech)|(?:audio|video|sign(?:ed)? language) version of (?:this|the)|media alternative (?:for|to) (?:this |the )?text|read (?:aloud|out loud)|(?:as|in) (?:an? )?(?:mp3|audio|video)(?: file| format)?)\b/i;
  /** Text people can read: shown on the page, or inside the browser's own disclosure (a details element), which shows it on request. */
  const readable = (b: Element): boolean => (b.getClientRects().length > 0 && getComputedStyle(b).visibility !== 'hidden') || !!b.closest('details');
  const near = (el: Element): RawNear => {
    const out: RawNear = { links: [] };
    const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => (id ? document.getElementById(id) : null)).filter((x): x is HTMLElement => !!x);
    for (const p of [...sectionParts(el), ...described]) {
      // A part that is itself a link (a transcript link standing on its own after the player) is read too (review media-v, S3).
      for (const a of [...(p.matches('a[href], button, [role="button"]') ? [p] : []), ...p.querySelectorAll('a[href], button, [role="button"]')].slice(0, 100)) {
        if (out.links.length >= 60) break;
        out.links.push({ name: nameOf(a), href: a.getAttribute('href') ? http(a.getAttribute('href')) : '' });
      }
      if (!out.heading) {
        const blocks = [p, ...p.querySelectorAll('h2, h3, h4, h5, h6, p, summary, dt, strong, b, div')].slice(0, 300);
        const hit = blocks.find((b) => /^(full |read the |view the |video |audio )?transcript\b/i.test(clean(b.textContent, 60)));
        // Kept whole up to 400 characters: the finding quotes it in whole sentences (quoteSentences).
        if (hit) out.heading = clean(hit.textContent, 400);
      }
      if (!out.liveText) {
        // The text as it is laid out (a heading and the paragraph after it are two lines, not one run of letters).
        const m = L.exec(clean((p as HTMLElement).innerText || p.textContent, 4000));
        if (m) out.liveText = m[0];
      }
      if (!out.alternative) {
        // Text the page gives as the item's alternative (WCAG 1.2.1, G158): a block that says so in its first
        // words, or one the page's own markup names a transcript (its id or a class).
        const blocks = [...p.querySelectorAll('p, div, figcaption, blockquote, dd, li, section, article, details')].slice(0, 300);
        const said = blocks.find((b) => !b.contains(el) && readable(b) && ALT_LABEL.test(clean(b.textContent, 60)) && wordCount(b.textContent) >= 4);
        const named = said ? undefined : blocks.find((b) => !b.contains(el) && readable(b) && !b.closest('a[href], button') && /transcript/i.test(`${b.id} ${typeof b.className === 'string' ? b.className : ''}`) && wordCount(b.textContent) >= 4);
        const hit = said ?? named;
        if (hit) out.alternative = clean(hit.textContent, 400);
      }
    }
    // A link right beside the item that is not its own file: it may lead to a transcript under a name the test
    // does not read as one (review media-v, S3). Its own block (when that is not the page's main content or a
    // section), and the two blocks before and after it, up to a heading.
    {
      let node: Element = el;
      while (node.parentElement && node.parentElement !== document.body && node.parentElement.children.length === 1) node = node.parentElement;
      const box = node.parentElement && !node.parentElement.matches('body, main, [role="main"], section, article') ? node.parentElement : null;
      const blocks: Element[] = box ? [box] : [];
      for (const dir of ['previousElementSibling', 'nextElementSibling'] as const) {
        let sib: Element | null = node[dir];
        for (let i = 0; sib && i < 2 && !/^H[1-6]$/.test(sib.tagName); i++, sib = sib[dir]) blocks.push(sib);
      }
      const own = (href: string) => /\.(?:mp3|m4a|m4b|wav|ogg|oga|opus|aac|flac|weba|webm|mp4|m4v|mov)(?:[?#]|$)/i.test(href);
      for (const b of blocks) {
        const hit = [...(b.matches('a[href]') ? [b] : []), ...b.querySelectorAll('a[href]')].find((a) => !el.contains(a) && !own(a.getAttribute('href') ?? '') && !/^javascript:/i.test(a.getAttribute('href') ?? ''));
        if (hit) { out.adjacent = nameOf(hit) || clean(hit.getAttribute('href'), 120); break; }
      }
    }
    // Text tied to the item itself (aria-describedby, aria-details).
    if (!out.alternative) {
      const tied = [...described, ...(el.getAttribute('aria-details') ?? '').split(/\s+/).map((id) => (id ? document.getElementById(id) : null)).filter((x): x is HTMLElement => !!x)]
        .find((t) => readable(t) && wordCount(t.textContent) >= 4);
      if (tied) out.alternative = clean(tied.textContent, 400);
    }
    // Right next to the item (its neighbouring blocks, or its figure's caption): unlabelled text about sounds.
    if (!out.alternative) {
      let node: Element = el;
      while (node.parentElement && node.parentElement !== document.body && node.parentElement.children.length === 1) node = node.parentElement;
      const around: Element[] = [];
      for (let s = node.previousElementSibling, i = 0; s && i < 2; s = s.previousElementSibling, i++) around.push(s);
      for (let s = node.nextElementSibling, i = 0; s && i < 2; s = s.nextElementSibling, i++) around.push(s);
      const caption = el.closest('figure')?.querySelector('figcaption');
      if (caption) around.push(caption);
      const plain = (b: Element) => !/^(H[1-6]|AUDIO|VIDEO|IFRAME|SCRIPT|STYLE)$/.test(b.tagName) && !b.querySelector('audio, video, iframe') && readable(b);
      // The page says what the recording says: a lead-in that names the recording, a colon, then its words.
      const said = around.find((b) => {
        if (!plain(b)) return false;
        const text = clean(b.textContent, 4000);
        const colon = text.indexOf(':');
        return colon > 0 && colon <= 160 && SAID.test(text.slice(0, colon + 1)) && wordCount(text.slice(colon + 1)) >= 15;
      });
      if (said) out.alternative = clean(said.textContent, 400);
      const hit = said ? undefined : around.find((b) => plain(b) && wordCount(b.textContent) >= 4 && (b.textContent ?? '').length <= 800 && SOUNDS.test(b.textContent ?? ''));
      if (hit) out.sounds = clean(hit.textContent, 400);
      // A media alternative for text: its own name or a short line next to it offers it as another way to get
      // text, and that text (30 words or more of running text) is on the page just before it.
      if (!out.alternative) {
        const own = nameOf(el);
        const label = FOR_TEXT.test(own) ? own : around.map((b) => (plain(b) && (b.textContent ?? '').length <= 300 ? clean(b.textContent, 300) : '')).find((t) => t && FOR_TEXT.test(t));
        if (label) {
          let before = 0;
          for (let s2 = node.previousElementSibling, i = 0; s2 && i < 4; s2 = s2.previousElementSibling, i++) if (plain(s2)) before = Math.max(before, wordCount(s2.textContent));
          if (before >= 30) out.forText = clean(label, 200);
        }
      }
    }
    return out;
  };
  /** Whether a video has a sound track, from its loaded description: 'none', 'some', or 'unknown' when it has not loaded. */
  const videoSound = (v: HTMLVideoElement): 'none' | 'some' | 'unknown' => {
    if (v.readyState < 1) return 'unknown';
    try {
      const stream = (v as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream?.();
      if (!stream) return 'unknown';
      const audio = stream.getAudioTracks().length;
      const video = stream.getVideoTracks().length;
      stream.getTracks().forEach((t) => t.stop());
      return audio > 0 ? 'some' : video > 0 ? 'none' : 'unknown';
    } catch {
      return 'unknown';
    }
  };
  /** The item sits right beside (the block before or after it) a video: that video's sound, or undefined when there is none. */
  const besideVideo = (el: Element): 'none' | 'some' | 'unknown' | undefined => {
    let node: Element = el;
    while (node.parentElement && node.parentElement !== document.body && node.parentElement.children.length === 1) node = node.parentElement;
    let found: 'none' | 'some' | 'unknown' | undefined;
    for (const s of [node.previousElementSibling, node.nextElementSibling]) {
      if (!s) continue;
      const v = s.matches('video') ? s : s.querySelectorAll('video').length === 1 && wordCount(s.textContent) < 4 ? s.querySelector('video') : null;
      if (!v) continue;
      const sound = videoSound(v as HTMLVideoElement);
      if (sound === 'none') return 'none';
      found = found === 'unknown' ? found : sound;
    }
    return found;
  };

  const frames: RawFrame[] = [];
  [...document.querySelectorAll('iframe')].forEach((f, index) => {
    if (frames.length >= arg.perKind) return;
    const dataSrc = http(f.getAttribute('data-src') ?? f.getAttribute('data-lazy-src') ?? f.getAttribute('data-cookieblock-src') ?? f.getAttribute('data-src-cmplz'));
    const src = http(f.getAttribute('src'));
    if (!src && !dataSrc) return;
    frames.push({ index, src, dataSrc, title: clean(f.getAttribute('title')), near: near(f) });
  });

  // Click-to-load previews: a placeholder that inserts the player only when clicked (never clicked here).
  const facades: RawFacade[] = [];
  for (const el of [...document.querySelectorAll('lite-youtube, lite-vimeo, lite-vimeo-embed, [data-youtube-id], [data-vimeo-id], :not(iframe)[data-src], :not(iframe)[data-embed], :not(iframe)[data-video-src], :not(iframe)[data-iframe-src]')].slice(0, 200)) {
    if (facades.length >= arg.perKind) break;
    const tag = el.tagName.toLowerCase();
    if (/^(img|source|script|link|video|audio|track|picture)$/.test(tag)) continue;
    const id = el.getAttribute('videoid') ?? el.getAttribute('data-youtube-id') ?? el.getAttribute('data-vimeo-id');
    const src = tag === 'lite-youtube' || el.hasAttribute('data-youtube-id') ? (id ? `https://www.youtube.com/embed/${id}` : 'https://www.youtube.com/embed/')
      : tag.startsWith('lite-vimeo') || el.hasAttribute('data-vimeo-id') ? (id ? `https://player.vimeo.com/video/${id}` : 'https://player.vimeo.com/video/')
        : http(el.getAttribute('data-src') ?? el.getAttribute('data-embed') ?? el.getAttribute('data-video-src') ?? el.getAttribute('data-iframe-src'));
    if (src && !/\.(jpe?g|png|gif|webp|avif|svg)(\?|#|$)/i.test(src)) facades.push({ src, what: tag.startsWith('lite-') ? `a <${tag}> preview` : 'a preview image', near: near(el) });
  }

  const audio: RawAudio[] = [];
  [...document.querySelectorAll('audio')].forEach((a, i) => {
    if (audio.length >= arg.perKind) return;
    // No controls and not playing by itself: a sound a script plays (a chime), not content to listen to.
    if (!a.controls && !a.autoplay) return;
    const src = http(a.currentSrc || a.getAttribute('src') || a.querySelector('source[src]')?.getAttribute('src'));
    const n = near(a);
    const beside = besideVideo(a);
    if (beside === 'none') n.besideSilentVideo = true;
    else if (beside === 'unknown') n.besideUnknownVideo = true;
    else if (beside === 'some') n.besideVideo = true;
    // Its length as the browser read it: a set length is a recording, no end is a live stream (1.2.1 covers recordings only).
    const length = a.readyState >= 1 ? (a.duration === Infinity ? 'infinite' : Number.isFinite(a.duration) && a.duration > 0 ? 'finite' : 'unknown') : 'unknown';
    audio.push({ target: src || `audio player ${i + 1} on the page`, what: 'this audio player', near: n, length });
  });
  const ext = new RegExp(arg.audioExt, 'i');
  const seen = new Set<string>();
  for (const a of [...document.querySelectorAll('a[href]')] as HTMLAnchorElement[]) {
    if (audio.length >= arg.perKind) break;
    const href = http(a.href);
    let path = '';
    try {
      path = href ? new URL(href).pathname : '';
    } catch {
      path = '';
    }
    if (!href || seen.has(href) || !ext.test(path)) continue;
    seen.add(href);
    audio.push({ target: href, what: `the linked audio file ("${clean(a.innerText || a.textContent, 60)}")`, near: near(a), length: 'unknown' });
  }

  const videos: RawVideo[] = [];
  // Each video element gets a key it keeps (a property under a symbol every read of this page shares), so a later
  // read finds the same element again, whatever the page inserted or moved in between (review round 1, S3).
  const KEY = Symbol.for('grnted.media.key');
  [...document.querySelectorAll('video')].forEach((v, i) => {
    if (videos.length >= arg.perKind) return;
    const src = http(v.currentSrc || v.getAttribute('src') || v.querySelector('source[src]')?.getAttribute('src'));
    const d = v.duration;
    const held = v as unknown as Record<symbol, string | undefined>;
    const key = held[KEY] ?? (held[KEY] = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    videos.push({
      key,
      target: src || `video ${i + 1} on the page`,
      src,
      tracks: [...v.querySelectorAll('track')].slice(0, 20).map((t) => ({ kind: (t as HTMLTrackElement).kind })),
      textTracks: v.textTracks?.length ?? 0,
      duration: d === Infinity ? 'infinite' : Number.isFinite(d) && d > 0 ? Math.round(d) : null,
      muted: v.muted || v.defaultMuted,
      controls: v.controls,
      loop: v.loop,
      hiddenSelf: v.getAttribute('aria-hidden') === 'true' || /^(presentation|none)$/.test((v.getAttribute('role') ?? '').trim()),
      near: near(v),
    });
  });

  const visible = (el: Element) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none';
  };
  const notices = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]')].slice(0, 50);
  const consent = notices.some((n) => visible(n) && /cookie|consent/i.test(clean(n.textContent, 2000)));
  return { frames, facades, audio, videos, consent };
}

/**
 * Runs in the page (self-contained): for each `<video>` (document order), its captions and subtitles tracks
 * with a file, how many of them the browser loaded or failed to load, the cues they hold, and whether the
 * video has a sound track. A track that was never switched on is loaded by setting it to "hidden" (nothing is
 * shown) and put back afterwards.
 */
export async function captionCues(arg: { perKind: number; waitMs: number }): Promise<CaptionCues[]> {
  // The same key as `pageMedia` gives a video (the same element, whatever its place in the document is by now).
  const KEY = Symbol.for('grnted.media.key');
  const videos = [...document.querySelectorAll('video')].slice(0, arg.perKind);
  const jobs: { track: HTMLTrackElement; was: TextTrackMode }[][] = videos.map((v) => ([...v.querySelectorAll('track')] as HTMLTrackElement[])
    .filter((t) => (t.kind === 'captions' || t.kind === 'subtitles') && !!t.getAttribute('src')).slice(0, 10)
    .map((t) => {
      const was = t.track.mode;
      if (was === 'disabled') { try { t.track.mode = 'hidden'; } catch { /* left as it is */ } }
      return { track: t, was };
    }));
  const pending = () => jobs.some((list) => list.some((j) => j.track.readyState !== 2 && j.track.readyState !== 3));
  const until = performance.now() + arg.waitMs;
  while (pending() && performance.now() < until) await new Promise((r) => setTimeout(r, 50));
  // A control that offers captions for this video: one that names the video by its id, or one in the blocks
  // around it (up to three levels up, and the block right before and after each). Its name is returned.
  const CC = /\b(?:captions?|captioned|captioning|subtitles?|subtitled|closed[- ]caption(?:s|ed|ing)?|cc|subt[ií]tulos|sous-titres?|untertitel|legendas?)\b/i;
  const CONTROLS = 'button, [role="button"], a[href], summary, label, select, input[type="button"], input[type="submit"], [role="switch"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"]';
  const nameOf = (el: Element) => (el.getAttribute('aria-label') || el.textContent || el.getAttribute('title') || el.getAttribute('value') || '').replace(/\s+/g, ' ').trim().slice(0, 80);
  // A control with no words that the page's own markup names for captions (an icon button of a player skin:
  // its class, id, title or the element it controls) offers captions too; its name is then "captions".
  const marked = (el: Element) => /caption|subtitle|(?:^|[-_\s])cc(?:$|[-_\s])/i.test(`${typeof el.className === 'string' ? el.className : ''} ${el.id} ${el.getAttribute('aria-controls') ?? ''} ${el.getAttribute('data-plyr') ?? ''}`);
  const offers = (el: Element, v: Element) => !v.contains(el) && (CC.test(nameOf(el)) || marked(el));
  const within = (root: Element, v: Element): string => {
    if (root.matches(CONTROLS) && offers(root, v)) return nameOf(root) || 'captions';
    for (const el of root.querySelectorAll(CONTROLS)) if (offers(el, v)) return nameOf(el) || 'captions';
    return '';
  };
  const captionsControl = (v: Element): string => {
    if (v.id) {
      for (const el of document.querySelectorAll(CONTROLS)) {
        if (offers(el, v) && [...el.attributes].some((a) => a.name !== 'id' && a.value.split(/[\s#,]+/).includes(v.id))) return nameOf(el) || 'captions';
      }
    }
    // The two blocks right before and right after the video itself, also when it sits directly in the page's main content.
    for (const dir of ['previousElementSibling', 'nextElementSibling'] as const) {
      let sib: Element | null = v[dir];
      for (let i = 0; sib && i < 2; i++, sib = sib[dir]) {
        const found = within(sib, v);
        if (found) return found;
      }
    }
    let node: Element = v;
    for (let up = 0; up < 3; up++) {
      const p: Element | null = node.parentElement;
      if (!p || p === document.body || p === document.documentElement || p.matches('main, [role="main"]')) break;
      const found = within(p, v) || (p.previousElementSibling ? within(p.previousElementSibling, v) : '') || (p.nextElementSibling ? within(p.nextElementSibling, v) : '');
      if (found) return found;
      node = p;
    }
    return '';
  };
  return videos.map((v, i) => {
    const list = jobs[i]!;
    let loaded = 0;
    let errors = 0;
    let cues = 0;
    for (const j of list) {
      if (j.track.readyState === 2) { loaded++; cues += j.track.track.cues?.length ?? 0; }
      else if (j.track.readyState === 3) errors++;
      if (j.was === 'disabled') { try { j.track.track.mode = 'disabled'; } catch { /* left as it is */ } }
    }
    // Captions a script added as a text track of its own (no track element) are captions too.
    const own = new Set(list.map((j) => j.track.track));
    for (const t of [...v.textTracks]) {
      if (!own.has(t) && (t.kind === 'captions' || t.kind === 'subtitles') && ![...v.querySelectorAll('track')].some((e) => (e as HTMLTrackElement).track === t)) cues += t.cues?.length ?? 0;
    }
    let sound: CaptionCues['sound'] = 'unknown';
    if (v.readyState >= 1) {
      try {
        const stream = (v as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream?.();
        if (stream) {
          sound = stream.getAudioTracks().length === 0 && stream.getVideoTracks().length > 0 ? 'none' : stream.getAudioTracks().length > 0 ? 'some' : 'unknown';
          stream.getTracks().forEach((t) => t.stop());
        }
      } catch {
        sound = 'unknown';
      }
    }
    const held = v as unknown as Record<symbol, string | undefined>;
    const key = held[KEY] ?? (held[KEY] = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`);
    let src = '';
    try {
      src = new URL(v.currentSrc || v.getAttribute('src') || v.querySelector('source[src]')?.getAttribute('src') || '', document.baseURI).href;
    } catch {
      src = '';
    }
    return { tracks: list.length, loaded, errors, cues, sound, control: !cues ? captionsControl(v) : '', key, src: /^https?:/i.test(src) ? src : '', textTracks: v.textTracks.length, trackElements: v.querySelectorAll('track').length, captionTracks: [...v.textTracks].filter((t) => t.kind === 'captions' || t.kind === 'subtitles').length };
  });
}

interface FramePos {
  shown: boolean;
  src: string;
  /** The player's content area on screen (after any CSS scaling), in viewport pixels. */
  box: { x: number; y: number; w: number; h: number; vw: number; vh: number };
  /** Screen pixels per frame pixel. */
  scale: { x: number; y: number };
  /** Only translated or scaled on the page (no rotation or skew), so frame points map to the screen. */
  affine: boolean;
}

/** Runs in the page: scrolls the iframe into view; where its content is on screen, its address and whether it is shown. */
function frameState(arg: { index: number; scroll: boolean }): FramePos | null {
  const f = document.querySelectorAll('iframe')[arg.index] as HTMLIFrameElement | undefined;
  if (!f) return null;
  if (arg.scroll) f.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = f.getBoundingClientRect();
  const s = getComputedStyle(f);
  const sx = f.offsetWidth > 0 ? r.width / f.offsetWidth : 1;
  const sy = f.offsetHeight > 0 ? r.height / f.offsetHeight : 1;
  const pl = parseFloat(s.paddingLeft) || 0;
  const pt = parseFloat(s.paddingTop) || 0;
  const box = {
    x: r.left + (f.clientLeft + pl) * sx, y: r.top + (f.clientTop + pt) * sy,
    w: (f.clientWidth - pl - (parseFloat(s.paddingRight) || 0)) * sx, h: (f.clientHeight - pt - (parseFloat(s.paddingBottom) || 0)) * sy,
    vw: innerWidth, vh: innerHeight,
  };
  let shown = r.width >= 40 && r.height >= 30 && s.visibility !== 'hidden' && f.getClientRects().length > 0 && Number(s.opacity) > 0;
  let affine = true;
  for (let el: Element | null = f; el; el = el.parentElement) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') shown = false;
    const t = cs.transform;
    if (t && t !== 'none') {
      const m = /^matrix\(([^)]+)\)$/.exec(t);
      const v = m ? m[1]!.split(',').map(Number) : null;
      if (!v || Math.abs(v[1]!) > 1e-6 || Math.abs(v[2]!) > 1e-6) affine = false;
    }
    const rot = (cs as unknown as { rotate?: string }).rotate;
    if (rot && rot !== 'none' && !/^0(deg)?$/.test(rot)) affine = false;
  }
  let src = '';
  try {
    src = f.getAttribute('src') ? new URL(f.getAttribute('src')!, document.baseURI).href : '';
  } catch {
    src = '';
  }
  return { shown, src, box, scale: { x: sx, y: sy }, affine };
}

/** Runs in the page: the iframe is what is under this point (nothing covers it there). */
function topHit(arg: { index: number; x: number; y: number }): boolean {
  const f = document.querySelectorAll('iframe')[arg.index];
  return !!f && document.elementFromPoint(arg.x, arg.y) === f;
}

/** Runs in the page: position of an iframe element (a frame handle) among the page's light-DOM iframes (-1: not there). */
function iframeIndex(el: unknown): number {
  return [...document.querySelectorAll('iframe')].indexOf(el as HTMLIFrameElement);
}

/** Runs in a player frame (self-contained): the player's controls, video, live state, caption list, language and error. */
function readPlayer(arg: { max: number }): PlayerState & { boxes: { x: number; y: number; w: number; h: number }[] } {
  const clean = (s: string | null | undefined, n = 100) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const displayed = (el: Element) => el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="button"]')]
    .filter((el) => !el.closest('a[href]') && el.tagName !== 'A')
    .slice(0, arg.max) as HTMLElement[];
  const controls = buttons.map((el) => ({
    name: clean(el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('data-title-no-tooltip') || (el as HTMLInputElement).value || el.textContent),
    displayed: displayed(el),
    disabled: (el as HTMLButtonElement).disabled === true || el.getAttribute('aria-disabled') === 'true',
  }));
  const boxes = buttons.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  });
  const vids = [...document.querySelectorAll('video')] as HTMLVideoElement[];
  const main = vids.sort((a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight)[0];
  const d = main?.duration;
  const video = {
    count: vids.length,
    playing: !!main && !main.paused && main.currentTime > 0,
    currentTime: main ? Math.round(main.currentTime * 10) / 10 : 0,
    duration: d === Infinity ? 'infinite' as const : d !== undefined && Number.isFinite(d) && d > 0 ? Math.round(d) : null,
    muted: main ? main.muted || main.volume === 0 : true,
  };
  // A LIVE badge only by the players' own markers, never by any text that says "Live". A disabled badge
  // counts: players disable it at the live edge.
  const liveBadge = [...document.querySelectorAll('.ytp-live-badge, [class*="live-badge" i], [class*="live_badge" i], [data-live]')].slice(0, 20)
    .some((el) => displayed(el) && !/^(false|0|no)$/i.test(el.getAttribute('data-live') ?? ''));
  // A seek timeline with a finite end (not a volume slider): an on-demand video.
  // Shown only: a seek bar hidden until the player starts says nothing yet.
  const timeline = [...document.querySelectorAll('[role="slider"]')].slice(0, 20).some((el) => {
    if (!displayed(el)) return false;
    const max = Number(el.getAttribute('aria-valuemax'));
    const label = `${el.getAttribute('aria-label') ?? ''} ${el.getAttribute('class') ?? ''}`;
    return Number.isFinite(max) && max > 0 && /seek|progress|timeline|scrub|position/i.test(label) && !/volume/i.test(label);
  });
  let playerLive: boolean | null = null;
  let tracks: { kind: string; label: string }[] | null = null;
  let tracksFinal = false;
  const any = window as unknown as Record<string, unknown>;
  try {
    const mp = document.getElementById('movie_player') as unknown as { getVideoData?: () => { isLive?: unknown; video_id?: unknown }; getOption?: (a: string, b: string) => unknown } | null;
    const data = mp?.getVideoData?.();
    // Only data that names its video (before that, a player's data can hold defaults).
    if (typeof data?.isLive === 'boolean' && typeof data.video_id === 'string' && data.video_id) playerLive = data.isLive;
    const list = mp?.getOption?.('captions', 'tracklist');
    if (Array.isArray(list) && list.length) {
      tracks = list.map((t: { kind?: unknown; displayName?: unknown; languageName?: unknown; languageCode?: unknown }) => ({
        kind: String(t?.kind ?? ''), label: clean(String(t?.displayName ?? t?.languageName ?? t?.languageCode ?? ''), 60),
      }));
    }
  } catch { /* the player's API is optional */ }
  try {
    const r = any.ytInitialPlayerResponse as { videoDetails?: { isLive?: unknown; videoId?: unknown }; captions?: { playerCaptionsTracklistRenderer?: { captionTracks?: { kind?: unknown; name?: { simpleText?: unknown } }[] } } } | undefined;
    if (r && typeof r === 'object') {
      if (typeof r.videoDetails?.isLive === 'boolean' && playerLive === null) playerLive = r.videoDetails.isLive;
      // Only a list the player actually returned counts; no `captions` object says nothing either way.
      const ct = r.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (!tracks && Array.isArray(ct)) {
        tracks = ct.map((t) => ({ kind: String(t?.kind ?? ''), label: clean(String(t?.name?.simpleText ?? ''), 60) }));
        tracksFinal = true;
      }
    }
  } catch { /* optional */ }
  try {
    const c = any.playerConfig as { request?: { text_tracks?: unknown }; video?: { live_event?: { status?: unknown } | null } } | undefined;
    if (c && typeof c === 'object' && c.request) {
      const tt = c.request.text_tracks;
      if (Array.isArray(tt)) {
        tracks = tt.map((t: { kind?: unknown; label?: unknown; lang?: unknown }) => {
          const label = clean(String(t?.label ?? t?.lang ?? ''), 60);
          return { kind: /auto-?generated|automatic/i.test(label) ? 'asr' : String(t?.kind ?? 'captions'), label };
        });
        tracksFinal = true;
      }
      // A live event says live (or not, once ended); a length says on demand. A bare config says nothing.
      const v = c.video as { live_event?: { status?: unknown } | null; duration?: unknown } | undefined;
      if (v && typeof v === 'object') {
        if (v.live_event && typeof v.live_event === 'object') playerLive = v.live_event.status !== 'ended';
        else if (typeof v.duration === 'number' && v.duration > 0) playerLive = false;
      }
    }
  } catch { /* optional */ }
  let error: string | null = null;
  const errEl = [...document.querySelectorAll('.ytp-error, [class*="player-error" i], [role="alert"]')].find((el) => displayed(el) && clean(el.textContent));
  if (errEl) error = clean(errEl.textContent, 120);
  else {
    const m = /video unavailable|this video is (private|unavailable)|playback (error|id)|an error occurred|video (not found|has been removed)/i.exec(clean(document.body?.innerText, 3000));
    if (m) error = m[0];
  }
  return { url: location.href, controls, boxes, video, liveBadge, playerLive, tracks, tracksFinal, error, lang: clean(document.documentElement.lang, 20), timeline };
}

/** Runs in a player frame: the control at `index` is what is under the given point (or its own centre); returns that point. */
function controlAt(arg: { index: number; max: number; x?: number; y?: number }): { x: number; y: number; name: string } | null {
  const buttons = [...document.querySelectorAll('button, [role="button"], input[type="button"]')]
    .filter((el) => !el.closest('a[href]') && el.tagName !== 'A')
    .slice(0, arg.max) as HTMLElement[];
  const el = buttons[arg.index];
  if (!el) return null;
  const r = el.getBoundingClientRect();
  const x = arg.x ?? r.left + r.width / 2;
  const y = arg.y ?? r.top + r.height / 2;
  const hit = document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) return null;
  if (hit.closest('a[href]')) return null;
  const name = (el.getAttribute('aria-label') || el.getAttribute('title') || (el as HTMLInputElement).value || el.textContent || '').replace(/\s+/g, ' ').trim();
  return { x, y, name };
}

/**
 * Runs in a document (self-contained): the length of each sound file, as the browser reads it from the file's
 * start. Each address is given to an audio element that is never added to the page (muted, loading its
 * description only: a plain GET the page's own player makes when someone presses play; nothing is played), all
 * of them at once, until each has answered or `waitMs` is over. Every element is let go of at the end, so a
 * stream with no end stops loading.
 */
export async function audioLengths(arg: { urls: string[]; waitMs: number }): Promise<MediaLength[]> {
  const players = arg.urls.map((url) => {
    const a = document.createElement('audio');
    a.muted = true;
    a.preload = 'metadata';
    try {
      a.src = url;
    } catch { /* an address the browser refuses: unknown */ }
    return a;
  });
  const until = performance.now() + Math.max(0, arg.waitMs);
  try {
    while (players.some((a) => a.readyState < 1 && !a.error) && performance.now() < until) await new Promise((r) => setTimeout(r, 40));
    return players.map((a) => (a.readyState >= 1 ? (a.duration === Infinity ? 'infinite' : Number.isFinite(a.duration) && a.duration > 0 ? 'finite' : 'unknown') : 'unknown'));
  } finally {
    for (const a of players) {
      try {
        a.removeAttribute('src');
        a.load();
      } catch { /* dropped either way */ }
    }
  }
}

// In the probe ---------------------------------------------------------------------------------------

/** Sound files whose length the test asks the browser for, a document, and how long it waits for them. */
export const AUDIO_LENGTH = { files: 24, waitMs: 3000 } as const;

/**
 * Whether each sound-only item is a recording (`Recorded`): from the length the page's own player had read,
 * else from the browser's reading of the file's start (`audioLengths`: the first `AUDIO_LENGTH.files` files with
 * an address; the others, and files that do not answer in time, are unknown). With `waitMs` 0 no file is asked
 * for. Never throws.
 */
export async function recordedFor(doc: { evaluate<R, A>(fn: (arg: A) => R | Promise<R>, arg: A): Promise<R> }, audio: readonly RawAudio[], waitMs: number): Promise<Recorded[]> {
  const of = (l: MediaLength | undefined): Recorded => (l === 'finite' ? 'yes' : l === 'infinite' ? 'live' : 'unknown');
  const out = audio.map((a) => of(a.length));
  const ask = audio.map((a, i) => ({ i, url: a.target })).filter((x) => out[x.i] === 'unknown' && /^https?:/i.test(x.url)).slice(0, AUDIO_LENGTH.files);
  if (!ask.length || waitMs < 300) return out;
  const lengths = await within(waitMs + 1500, doc.evaluate(audioLengths, { urls: ask.map((x) => x.url), waitMs }), null);
  ask.forEach((x, k) => { out[x.i] = of(lengths?.[k]); });
  return out;
}

export const AUDIO_EXT_SRC = `\\.(${AUDIO_EXTENSIONS.join('|')})$`;
const MAX_CONTROLS = 80;

const hash = (b: Uint8Array) => {
  let h = 2166136261;
  for (let i = 0; i < b.length; i += 7) h = Math.imul(h ^ b[i]!, 16777619);
  return `${b.length}:${h >>> 0}`;
};

/** What the page offers next to an item, from the links and text the page read gave. */
export function nearOf(n: RawNear, consent: boolean): Nearby {
  const out: Nearby = {};
  for (const l of n.links ?? []) {
    const kind = linkKind(l.name, l.href);
    if (kind === 'described' && !out.described) out.described = l.name || l.href;
    if (kind === 'transcript' && !out.transcript) out.transcript = l.name || l.href;
  }
  if (!out.transcript && n.heading && isTranscriptHeading(n.heading)) out.transcript = n.heading;
  if (n.alternative) out.alternative = n.alternative;
  if (n.sounds) out.sounds = n.sounds;
  if (n.forText) out.forText = n.forText;
  if (n.besideSilentVideo) out.besideSilentVideo = true;
  if (n.besideUnknownVideo) out.besideUnknownVideo = true;
  if (n.besideVideo) out.besideVideo = true;
  if (n.liveText) out.liveText = n.liveText;
  if (n.adjacent && !out.transcript) out.adjacentLink = n.adjacent;
  if (consent) out.consent = true;
  return out;
}

/**
 * "POST request to …" for requests the guard stopped, for the reason a player did not start: writes to
 * another site included (the player's own service), since this only explains a result, never clears one.
 */
function stopped(events: readonly GuardEvent[]): string[] {
  return events.filter((e) => e.kind === 'blocked').map((e) => blockedReason(e).replace(/^the test would have sent data to the live site \((.*)\), so it was stopped$/, '$1')).slice(0, 5);
}

/** A clock that ends every wait at `until` (a player's deadline, or the probe's own end). */
class Clock {
  constructor(readonly page: PageLike, readonly until: number, readonly signal: AbortSignal) {}
  get left(): number {
    return this.until - Date.now();
  }
  get over(): boolean {
    return this.left <= 0 || this.signal.aborted;
  }
  /** The promise's value, or `fallback` at `ms` or at the deadline, whichever comes first. */
  within<T>(ms: number, p: Promise<T>, fallback: T): Promise<T> {
    p.catch(() => {});
    const wait = Math.min(ms, this.left);
    return wait <= 0 ? Promise.resolve(fallback) : within(wait, p, fallback);
  }
  sleep(ms: number): Promise<void> {
    const wait = Math.min(ms, this.left);
    return wait > 0 ? this.page.waitForTimeout(wait) : Promise.resolve();
  }
}

/** The player's frame object for the iframe at `index` (direct children of the page only). */
async function frameFor(page: PageLike, index: number, clock: Clock): Promise<FrameLike | null> {
  for (const f of page.frames?.() ?? []) {
    if (clock.over) return null;
    const parent = f.parentFrame();
    if (!parent || parent.parentFrame()) continue;
    const handle = await clock.within(1000, f.frameElement(), null);
    if (!handle) continue;
    const i = await clock.within(1000, page.evaluate(iframeIndex, handle), -1);
    if (i === index) return f;
  }
  return null;
}

/** Frames inside the player's frame (any depth). */
function under(page: PageLike, frame: FrameLike): FrameLike[] {
  return (page.frames?.() ?? []).filter((f) => {
    for (let p = f.parentFrame(); p; p = p.parentFrame()) if (p === frame) return true;
    return false;
  });
}

/**
 * The mute hook ran early in each frame (before its scripts). Returns false when a frame lacks it or
 * got it late, or could not be asked before the deadline: its sound cannot be vouched for.
 */
async function mutedEarly(frames: readonly FrameLike[], clock: Clock): Promise<boolean> {
  for (const f of frames) {
    if (clock.over) return false;
    if (!(await clock.within(1500, f.evaluate(muteHook, undefined), false))) return false;
  }
  return true;
}

/** Stops any sound in the page's frames; 'sound' when something was sounding, 'unknown' when not every frame answered in time. */
async function silence(page: PageLike, clock: Clock): Promise<'quiet' | 'sound' | 'unknown'> {
  let sounding = 0;
  for (const f of page.frames?.() ?? []) {
    if (clock.over) return 'unknown';
    const n = await clock.within(1500, f.evaluate(stopSound, undefined), -1);
    if (n < 0) return 'unknown';
    sounding += n;
  }
  return sounding > 0 ? 'sound' : 'quiet';
}

const blank = (url: string): PlayerObservation => ({ url, target: url, outcome: 'tested', started: false, clicked: false, covered: false, unmuted: false, blocked: [], frames: { taken: 0, distinct: 0 } });

/** Plays one embedded video player muted and reads it, all within `clock`. Never throws. */
async function testPlayer(ctx: ProbeContext, raw: RawFrame, match: PlayerMatch, clock: Clock): Promise<PlayerObservation> {
  const { page } = ctx;
  const url = raw.src || raw.dataSrc;
  const base = blank(url);
  const fail = (outcome: PlayerObservation['outcome'], reason: string, target = url): PlayerObservation => ({ ...base, target, outcome, reason });
  const mark = ctx.guard.mark();
  const name = PLAYER_NAMES[match.player];
  const timeUp = `the time for this player ran out before it was tested`;
  const by = (ms: number) => Math.min(Date.now() + ms, clock.until);
  try {
    const pos0 = await clock.within(2000, page.evaluate(frameState, { index: raw.index, scroll: true }), null);
    if (!pos0) return fail('unreadable', 'the player\'s frame left the page before it was tested');
    let pos = pos0;
    // A lazy player gets its address once it scrolls into view.
    const until = by(MEDIA_PLAYER_TIMING.lazy);
    while (!pos.src && Date.now() < until && !clock.over) {
      await clock.sleep(200);
      pos = (await clock.within(1000, page.evaluate(frameState, { index: raw.index, scroll: false }), null)) ?? pos;
    }
    if (!pos.src) {
      return fail('not-loaded', `the ${name} player did not load when it was scrolled into view: its address is only in a data attribute, so it waits for something the test does not do, such as accepting cookies or clicking a preview`);
    }
    if (!pos.shown) return fail('hidden', `the ${name} player is hidden on the page (for example in a closed tab or menu)`);
    const target = pos.src;
    // Its frame, loaded.
    let frame: FrameLike | null = null;
    const loadBy = by(MEDIA_PLAYER_TIMING.load);
    while (Date.now() < loadBy && !clock.over) {
      frame ??= await frameFor(page, raw.index, clock);
      if (frame) {
        const u = frame.url();
        if (u.startsWith('chrome-error:')) return fail('not-loaded', `the ${name} player's address did not load`, target);
        if (u && u !== 'about:blank' && (await clock.within(1000, frame.evaluate(() => document.readyState, undefined), '')) === 'complete') break;
      }
      await clock.sleep(200);
    }
    if (clock.over) return fail('time', timeUp, target);
    if (!frame || frame.url() === 'about:blank') return fail('not-loaded', `the ${name} player did not load in ${MEDIA_PLAYER_TIMING.load / 1000} s`, target);
    // Its sound must be off before anything plays: the mute hook ran before its scripts, in it and in its frames.
    if (!(await mutedEarly([frame, ...under(page, frame)], clock))) {
      return { ...fail('unreadable', `the test could not make sure the ${name} player stays muted (its mute hook did not run before the player loaded), so it did not play it`, target) };
    }
    const read = () => clock.within(2000, frame!.evaluate(readPlayer, { max: MAX_CONTROLS }), null);
    let state = await read();
    if (!state) return fail(clock.over ? 'time' : 'unreadable', clock.over ? timeUp : `the ${name} player's frame could not be read`, target);
    pos = (await clock.within(1000, page.evaluate(frameState, { index: raw.index, scroll: false }), null)) ?? pos;
    const box = pos.box;
    const covered = !(await clock.within(1000, page.evaluate(topHit, { index: raw.index, x: box.x + box.w / 2, y: box.y + box.h / 2 }), false));
    const obs: PlayerObservation = { ...base, target, covered, state };
    if (covered) return { ...obs, blocked: stopped(ctx.guard.events.slice(mark)) };
    if (!pos.affine) return { ...obs, skipped: `the ${name} player is rotated or skewed on the page (transformed), so the test did not click it`, blocked: stopped(ctx.guard.events.slice(mark)) };

    // Its own play control: a shown, enabled button named "Play", under the pointer where it is clicked.
    const play = state.controls.findIndex((c, i) => c.displayed && !c.disabled && controlKind(c.name) === 'play' && state!.boxes[i]!.w > 0);
    if (play >= 0 && page.mouse) {
      const centre = await clock.within(2000, frame.evaluate(controlAt, { index: play, max: MAX_CONTROLS }), null);
      if (centre && controlKind(centre.name) === 'play') {
        // Map the control's centre to the screen through the iframe's scale, as the page is laid out now.
        const now = (await clock.within(1000, page.evaluate(frameState, { index: raw.index, scroll: false }), null)) ?? pos;
        const x = now.box.x + centre.x * now.scale.x;
        const y = now.box.y + centre.y * now.scale.y;
        const inView = x > 0 && y > 0 && x < now.box.vw && y < now.box.vh;
        // The point that will be clicked, mapped back into the frame, must still be that control.
        const back = { x: (x - now.box.x) / now.scale.x, y: (y - now.box.y) / now.scale.y };
        const still = now.affine && inView && (await clock.within(1000, page.evaluate(topHit, { index: raw.index, x, y }), false))
          && (await clock.within(1000, frame.evaluate(controlAt, { index: play, max: MAX_CONTROLS, ...back }), null))?.name === centre.name;
        if (still && !clock.over) {
          await clock.within(2000, page.mouse.click(x, y), undefined);
          obs.clicked = true;
        }
      }
    }
    // Live signals seen in any read are kept: a badge that shows for a moment, or data that arrives late.
    const live = { badge: state.liveBadge, data: state.playerLive === true, endless: state.video.duration === 'infinite' };
    const note = (s: PlayerState) => {
      live.badge ||= s.liveBadge;
      live.data ||= s.playerLive === true;
      live.endless ||= s.video.duration === 'infinite';
    };
    const withLive = (s: PlayerState): PlayerState => ({
      ...s, liveBadge: s.liveBadge || live.badge, playerLive: live.data ? true : s.playerLive,
      video: live.endless ? { ...s.video, duration: 'infinite' } : s.video,
    });
    /** Whether liveness is decided (a live sign, or a positive on-demand sign) for the reads so far. */
    const liveKnown = (s: PlayerState) => liveOf({ ...obs, state: withLive(s) }) !== undefined;
    // Wait for it to start, then for its captions and its live or on-demand sign (within the settle window).
    const startBy = by(MEDIA_PLAYER_TIMING.start);
    let startedAt = 0;
    while (!clock.over) {
      const s = await read();
      if (s) {
        note(s);
        state = s;
      }
      const running = !!s && (s.video.playing || s.controls.some((c) => c.displayed && controlKind(c.name) === 'pause'));
      if (running && !startedAt) startedAt = Date.now();
      if (s?.error) break;
      if (startedAt && ((captionsOf(state, true).state !== 'unknown' && liveKnown(state)) || Date.now() - startedAt > MEDIA_PLAYER_TIMING.settle)) break;
      if (!startedAt && Date.now() > startBy) break;
      await clock.sleep(250);
    }
    obs.started = !!startedAt;
    if (obs.started) {
      // A few frames of the player while it plays (they show it really plays).
      const seen = new Set<string>();
      const clip = { x: Math.max(0, box.x), y: Math.max(0, box.y), width: Math.max(1, Math.min(box.w, box.vw - Math.max(0, box.x))), height: Math.max(1, Math.min(box.h, box.vh - Math.max(0, box.y))) };
      for (let i = 0; i < MEDIA_PLAYER_LIMITS.frames && !clock.over; i++) {
        const shot = await clock.within(2000, page.screenshot({ type: 'jpeg', quality: 40, clip }), null);
        if (shot) {
          obs.frames.taken++;
          const h = hash(shot);
          if (!seen.has(h)) (obs.shots ??= []).push(shot);
          seen.add(h);
        }
        if (i < MEDIA_PLAYER_LIMITS.frames - 1) await clock.sleep(MEDIA_PLAYER_TIMING.frameGap);
      }
      obs.frames.distinct = seen.size;
      // Players fade or hide their controls; with the pointer over the player, read them again for a
      // while until the captions are known to be offered (a "none" seen so far may just be hidden).
      if (page.mouse && !clock.over) {
        await clock.within(1000, page.mouse.move(box.x + box.w / 2, box.y + box.h * 0.75), undefined);
        const hoverBy = by(MEDIA_PLAYER_TIMING.settle);
        while (!clock.over) {
          await clock.sleep(250);
          const s = await read();
          if (s) {
            note(s);
            state = s;
          }
          const c = captionsOf(state, true).state;
          if (((c === 'available' || c === 'auto-only') && liveKnown(state)) || Date.now() > hoverBy) break;
        }
        await clock.within(1000, page.mouse.move(0, 0), undefined);
      }
    }
    // Never with sound: anything sounding in the page now is stopped, and the player is not judged;
    // a page whose frames did not all answer in time cannot be vouched for either.
    const sound = await silence(page, clock);
    if (sound === 'sound') obs.unmuted = true;
    else if (sound === 'unknown') obs.skipped = 'the test could not confirm in time that nothing on the page played sound, so it did not judge the player';
    return { ...obs, state: withLive(state), blocked: stopped(ctx.guard.events.slice(mark)) };
  } catch (err) {
    const msg = err instanceof Error ? (err.message.split('\n')[0] ?? '') : String(err);
    return fail('unreadable', `the ${name} player could not be tested: ${msg.slice(0, 120)}`);
  }
}

/** True when the audit saw video or audio on the page (the probe then also runs outside the template sample). */
export function hasMedia(collected: PageAudit['collected']): boolean {
  const facts = collected ? collectedValue({ url: '', status: 'ok', rules: {}, violations: [], incomplete: [], links: [], collected } as PageAudit, mediaCollector) : undefined;
  if (!facts) return false;
  // A link to a YouTube video's page (listed in the media table since plan C14) is not media on the page.
  return facts.elements.length > 0 || facts.links.some((l) => mediaFileType(l.href) !== undefined) || facts.frames.some((f) => classifyPlayer(f.src) !== undefined);
}

interface UnplacedPlayer {
  url: string;
  match: PlayerMatch;
  /** In a shadow root; or its frame did not answer (or has no element); or the time ran out before it was checked. */
  why: 'shadow' | 'unanswered' | 'time';
}

/**
 * Player frames the page has that the probe cannot place in the page's light DOM: inside a web
 * component's shadow root, or frames that did not answer in time. Fails closed: a player frame not
 * checked is reported, never dropped (it would otherwise read as "no video").
 */
async function shadowPlayers(page: PageLike, clock: Clock): Promise<UnplacedPlayer[]> {
  const out: UnplacedPlayer[] = [];
  for (const f of page.frames?.() ?? []) {
    const parent = f.parentFrame();
    if (!parent || parent.parentFrame()) continue;
    const match = classifyPlayer(f.url());
    if (!match) continue;
    if (clock.over) {
      out.push({ url: f.url(), match, why: 'time' });
      continue;
    }
    const handle = await clock.within(1000, f.frameElement(), null);
    const i = handle ? await clock.within(1000, page.evaluate(iframeIndex, handle), -2) : -2;
    if (i === -1) out.push({ url: f.url(), match, why: 'shadow' });
    else if (i < 0) out.push({ url: f.url(), match, why: 'unanswered' });
  }
  return out;
}

/**
 * A background video by its own markup, the same rule as the video and audio inventory
 * (`MediaElementFact.decorative`): hidden from assistive technology on the video itself (aria-hidden="true",
 * or role presentation/none), muted, looping and without controls. Any other video is judged (1.2.3, 1.2.5).
 */
export function nativeVideoDecorative(v: { muted: boolean; controls: boolean; loop: boolean; hiddenSelf: boolean }): boolean {
  return v.hiddenSelf && v.muted && v.loop && !v.controls;
}

async function run(ctx: ProbeContext): Promise<ProbeFinding[]> {
  const { page } = ctx;
  // The probe's own end, well inside the runner's time box: it returns what it found by then.
  const end = new Clock(page, ctx.deadline - MEDIA_PLAYER_TIMING.reserve, ctx.signal);
  const media = await end.within(5000, page.evaluate(pageMedia, { live: LIVE_TEXT_SOURCE, audioExt: AUDIO_EXT_SRC, perKind: MEDIA_PLAYER_LIMITS.perKind }), null);
  if (!media) throw new ProbeNotTestable('the video and audio on the page could not be read in time');
  const findings: ProbeFinding[] = [];
  const players: { raw: RawFrame; match: PlayerMatch }[] = [];
  for (const raw of media.frames) {
    const match = classifyPlayer(raw.src || raw.dataSrc);
    if (!match) continue;
    // A podcast or music platform's player plays recordings the platform hosts.
    if (match.content === 'audio') findings.push(judgeAudio({ target: raw.src || raw.dataSrc, what: `this ${PLAYER_NAMES[match.player]} player`, recorded: 'yes' }, nearOf(raw.near, false)));
    else players.push({ raw, match });
  }
  // 1.2.1 covers recordings only (review round 1, S4): each sound-only item's length as the page's own player had
  // read it. This test asks for no media file itself (the every-page media-alternatives test does, for players
  // that had not loaded and for linked files), so an item with no length read here is undecided here.
  const recorded = await recordedFor(page, media.audio, 0);
  media.audio.forEach((a, i) => findings.push(judgeAudio({ ...a, recorded: recorded[i] ?? 'unknown' }, nearOf(a.near, false))));
  for (const v of media.videos) findings.push(...judgeNativeVideo({ ...v, decorative: nativeVideoDecorative(v) }, nearOf(v.near, false)));
  // A captions track with no cue in it gives no captions (1.2.2): read from the browser's own text tracks.
  if (media.videos.some((v) => v.tracks.some((t) => t.kind === 'captions' || t.kind === 'subtitles'))) {
    const cues = await end.within(MEDIA_PLAYER_TIMING.captionFiles + 1000, page.evaluate(captionCues, { perKind: MEDIA_PLAYER_LIMITS.perKind, waitMs: MEDIA_PLAYER_TIMING.captionFiles }), null);
    media.videos.forEach((v) => {
      // The same element in both reads (its key), never the same place in the document (review round 1, S3).
      const c = cues?.find((x) => !!x.key && x.key === v.key);
      const forText = nearOf(v.near, false).forText;
      if (c) findings.push(...judgeCaptionCues({ target: v.target, decorative: nativeVideoDecorative(v), muted: v.muted, controls: v.controls, ...(forText ? { forText } : {}) }, c));
    });
  }
  // Click-to-load previews are never clicked: their players are not tested (links next to them still count).
  let previews = 0;
  for (const fc of media.facades) {
    const match = classifyPlayer(fc.src);
    if (!match) continue;
    previews++;
    const near = nearOf(fc.near, media.consent);
    if (match.content === 'audio') {
      findings.push(judgeAudio({ target: fc.src, what: `this ${PLAYER_NAMES[match.player]} preview`, recorded: 'yes' }, near));
      continue;
    }
    findings.push(...judgePlayer({ ...blank(fc.src), outcome: 'not-loaded', reason: `a click-to-load ${PLAYER_NAMES[match.player]} preview (${fc.what}): its player loads only when someone clicks it, which the test does not do` }, near));
  }
  // Players inside web components (shadow DOM): seen as frames, but not reachable on the page to scroll, check or click.
  const hidden = await shadowPlayers(page, new Clock(page, Math.min(Date.now() + 3000, end.until), ctx.signal));
  for (const h of hidden) {
    const name = PLAYER_NAMES[h.match.player];
    const what = h.why === 'shadow' ? `a ${name} player inside a web component (shadow DOM)` : `a ${name} player frame`;
    const reason = h.why === 'shadow' ? `${what} was not tested: the test cannot reach it on the page`
      : h.why === 'unanswered' ? `${what} did not answer when the test looked for it on the page, so it was not tested`
        : `${what} was not tested: the time ran out before it was checked`;
    if (h.match.content === 'audio') findings.push({ criterion: '1.2.1', status: 'not_testable', target: h.url, detail: `${reason}.` });
    else findings.push(...judgePlayer({ ...blank(h.url), outcome: h.why === 'time' ? 'time' : 'unreadable', reason }, {}));
  }

  const summary: {
    url: string; outcome: string; started: boolean; clicked: boolean; frames: { taken: number; distinct: number }; captions: string; live: boolean | null;
    // Batch 18 (G12): what the player itself showed, as data for the AI media review (no verdict here).
    controls?: { name: string; displayed: boolean; disabled: boolean }[]; tracks?: { kind: string; label: string }[]; lang?: string;
    liveBadge?: boolean; timeline?: boolean; duration?: number | 'infinite' | null; error?: string; reason?: string;
  }[] = [];
  const shots: { url: string; shots: Uint8Array[] }[] = [];
  for (const [i, p] of players.entries()) {
    const url = p.raw.src || p.raw.dataSrc;
    let o: PlayerObservation;
    if (i >= MEDIA_PLAYER_LIMITS.players) {
      o = { ...blank(url), outcome: 'cap', reason: `more than ${MEDIA_PLAYER_LIMITS.players} players on this page; the others were not tested` };
    } else if (end.left < MEDIA_PLAYER_TIMING.perPlayer || ctx.signal.aborted) {
      o = { ...blank(url), outcome: 'time', reason: 'the time box ran out before this player was tested' };
    } else {
      o = await testPlayer(ctx, p.raw, p.match, new Clock(page, Math.min(Date.now() + MEDIA_PLAYER_TIMING.playerMax, end.until), ctx.signal));
    }
    findings.push(...judgePlayer(o, nearOf(p.raw.near, media.consent)));
    const st = o.state;
    summary.push({
      url: o.target, outcome: o.outcome, started: o.started, clicked: o.clicked, frames: o.frames,
      captions: st ? captionsOf(st, o.started).state : 'unknown', live: st ? (st.playerLive ?? null) : null,
      ...(st ? {
        controls: st.controls.slice(0, 16).map((c) => ({ name: c.name.slice(0, 80), displayed: c.displayed, disabled: c.disabled })),
        ...(st.tracks ? { tracks: st.tracks.slice(0, 10).map((t) => ({ kind: t.kind, label: t.label.slice(0, 80) })) } : {}),
        ...(st.lang ? { lang: st.lang } : {}), liveBadge: st.liveBadge, timeline: st.timeline, duration: st.video.duration,
        ...(st.error ? { error: st.error.slice(0, 160) } : {}),
      } : {}),
      ...(o.reason ? { reason: o.reason.slice(0, 160) } : {}),
    });
    if (o.shots?.length) shots.push({ url: o.target, shots: o.shots });
  }
  ctx.setData?.({ players: summary });
  if (shots.length) ctx.attach?.({ players: shots });
  return fillPage(findings, { audio: media.audio.length, players: players.length + previews + hidden.length, videos: media.videos.length });
}

/** 1.2.1–1.2.5 for every player on the page (deep, own page). */
export const mediaPlayersProbe: PageProbe = {
  // Scoring v8: listed, not scored until a gold-standard mutation verifies it (docs/scoring.md).
  scored: false,
  id: MEDIA_PLAYERS_PROBE_ID,
  criteria: [...MEDIA_PLAYER_CRITERIA],
  kind: 'interaction',
  tier: 'deep',
  // Up to 4 players at about 1–15 s each; the probe itself stops 5 s before this and returns its findings.
  timeoutMs: 45_000,
  isolate: true,
  initScript: MUTE_SCRIPT,
  note: 'embedded players are played muted in the browser and never downloaded; the accuracy of captions inside them cannot be tested, because the platform does not give automated tools access to the audio',
  alsoOn: hasMedia,
  // It clicks play on embedded players: nothing it clicks may save a file (`withoutDownloads`).
  run: withoutDownloads(run),
};
