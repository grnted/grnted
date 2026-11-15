// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Video and audio on a page: native <video>/<audio> elements, player iframes and links to media
// files. Feeds the media inventory (`src/media/`) on every scan and the AI media check. Engine core.
import { MEDIA_FILE_EXT } from '../media/detect.js';
import type { MediaTrack, PageCollector } from '../types.js';

/** A native `<video>` or `<audio>` element. */
export interface MediaElementFact {
  tag: 'video' | 'audio';
  /** The playing (or first) source, absolute; '' when it has no http(s) address (a stream or none). */
  src: string;
  tracks: MediaTrack[];
  autoplay: boolean;
  muted: boolean;
  controls: boolean;
  loop: boolean;
  /**
   * Seconds it plays, when the browser had loaded the media's metadata: the file's length, or the part a media
   * fragment in its address selects (`clip.webm#t=8,10` plays 2 s, then pauses).
   */
  duration?: number;
  /** Video track presence, only when confirmed. Absent means unknown. See `MediaItem.audio`. */
  audio?: 'none' | 'present';
  /** Not shown when collected. See `MediaItem.hidden`. */
  hidden?: true;
  /** Video: labelled by nearby text as the same information as the page's text. See `MediaItem.alternativeForText`. */
  alternativeForText?: true;
  poster?: string;
  name?: string;
  /** The word "transcript" (in any common spelling) is in the same section of the page. */
  transcriptNearby: boolean;
  /**
   * A background video by its markup: aria-hidden="true" (or role presentation/none) on the video itself,
   * muted, looping and without controls. An ancestor's aria-hidden (a carousel slide) does not count.
   */
  decorative?: true;
}

/** An `<iframe>` with an http(s) address (the inventory keeps the ones that are media players). */
export interface MediaFrameFact {
  src: string;
  title?: string;
  transcriptNearby: boolean;
  /**
   * How it is on the page when not as a plain iframe: a click-to-load preview that inserts the player
   * only when clicked (`lite-youtube`, a `data-src` placeholder), or an iframe inside an open shadow root.
   */
  via?: 'facade' | 'shadow';
}

/** A link to a video or audio file (by file extension), or to a YouTube video's page (youtu.be, watch, shorts, live). */
export interface MediaLinkFact {
  href: string;
  text: string;
  transcriptNearby: boolean;
}

export interface MediaFacts {
  elements: MediaElementFact[];
  frames: MediaFrameFact[];
  links: MediaLinkFact[];
}

/** Items kept per page, for each of elements, frames and links. */
export const MEDIA_LIMITS = { perKind: 50, name: 150, text: 150 } as const;

/** Runs inside the page (serialized, so self-contained). */
function collectMedia(arg: { mediaExt: string; perKind: number; name: number; text: number }): MediaFacts {
  const clean = (s: string | null | undefined, max: number) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const http = (u: string | null | undefined) => (u && /^https?:/i.test(u) ? u : '');
  const absolute = (u: string | null) => {
    if (!u) return '';
    try {
      return http(new URL(u, document.baseURI).href);
    } catch {
      return '';
    }
  };
  const TRANSCRIPT = /transcri|transkri/i;
  // The section the element is in: its closest structural container, or else the run of blocks
  // between the headings around it.
  const sectionParts = (el: Element): Element[] => {
    const box = el.closest('figure, section, article, aside, li, td, dd, details, dialog');
    if (box) return [box];
    let node: Element = el;
    while (node.parentElement && node.parentElement !== document.body && !node.parentElement.matches('main, [role="main"]')) node = node.parentElement;
    const parts = [node];
    for (let s = node.previousElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.previousElementSibling) parts.push(s);
    for (let s = node.nextElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.nextElementSibling) parts.push(s);
    return parts;
  };
  const transcriptNearby = (el: Element): boolean => {
    const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => id && document.getElementById(id)?.textContent).join(' ');
    if (TRANSCRIPT.test(described)) return true;
    return sectionParts(el).some((p) => TRANSCRIPT.test(p.textContent ?? '')
      || [...p.querySelectorAll('a[href]')].some((a) => TRANSCRIPT.test(a.getAttribute('href') ?? '')));
  };
  // A media alternative for text, labelled as such in the same section: "a video version of this page", "the same
  // information as the text above, in video form", "watch the same content as a video".
  const ALTERNATIVE = [
    /\bvideo (?:version|alternative|form)\b/i,
    /\bsame (?:information|content|text|words)\b[^.!?]{0,80}\b(?:video|watch)/i,
    /\b(?:video|watch)\b[^.!?]{0,80}\bsame (?:information|content|text|words)\b/i,
  ];
  const alternativeNearby = (el: Element): boolean => {
    const described = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).map((id) => id && document.getElementById(id)?.textContent).join(' ');
    const texts = [described, el.getAttribute('aria-label') ?? '', el.getAttribute('title') ?? '', ...sectionParts(el).filter((p) => p !== el).map((p) => p.textContent ?? '')];
    return texts.some((t) => ALTERNATIVE.some((re) => re.test(t.replace(/\s+/g, ' '))));
  };
  /** Seconds a media fragment (`#t=start,end`, npt seconds or hh:mm:ss) selects, or null when the address has none. */
  const fragment = (src: string, duration: number): number | null => {
    const m = /#(?:.*&)?t=(?:npt:)?([\d:.]*)(?:,([\d:.]+))?/.exec(src);
    if (!m || (!m[1] && !m[2])) return null;
    const secs = (t: string | undefined, fallback: number) => {
      if (!t) return fallback;
      const parts = t.split(':').map(Number);
      if (parts.some((n) => !Number.isFinite(n))) return NaN;
      return parts.reduce((a, n) => a * 60 + n, 0);
    };
    const start = Math.min(secs(m[1], 0), duration);
    const end = Math.min(secs(m[2], duration), duration);
    return Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : null;
  };
  /** Track presence is known only from loaded metadata, decoded audio, or a captured track list. */
  const audioTracks = (el: HTMLMediaElement): 'none' | 'present' | undefined => {
    if (el.readyState < 1) return undefined;
    const decoded = Number((el as HTMLMediaElement & { webkitAudioDecodedByteCount?: number }).webkitAudioDecodedByteCount ?? 0);
    if (decoded > 0) return 'present';
    try {
      const stream = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream?.();
      if (!stream) return undefined;
      const audio = stream.getAudioTracks().length;
      const video = stream.getVideoTracks().length;
      stream.getTracks().forEach((t) => t.stop());
      return audio ? 'present' : video ? 'none' : undefined;
    } catch {
      return undefined;
    }
  };
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const visible = typeof el.checkVisibility === 'function' ? el.checkVisibility({ visibilityProperty: true }) : true;
    return visible && r.width >= 1 && r.height >= 1;
  };
  const nameOf = (el: Element): string => {
    const labelledBy = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => id && document.getElementById(id)?.textContent).join(' ');
    return clean(el.getAttribute('aria-label'), arg.name) || clean(labelledBy, arg.name) || clean(el.getAttribute('title'), arg.name)
      || clean(el.closest('figure')?.querySelector('figcaption')?.textContent, arg.name);
  };

  const elements: MediaElementFact[] = [];
  for (const el of [...document.querySelectorAll('video, audio')] as HTMLMediaElement[]) {
    if (elements.length >= arg.perKind) break;
    const source = el.querySelector('source[src]') as HTMLSourceElement | null;
    const src = http(el.currentSrc) || http(el.src) || http(source?.src);
    const tracks: MediaTrack[] = ([...el.querySelectorAll('track')] as HTMLTrackElement[]).slice(0, 20).map((t) => {
      const track: MediaTrack = { kind: t.kind };
      if (t.srclang) track.srclang = clean(t.srclang, 35);
      if (t.label) track.label = clean(t.label, 100);
      if (http(t.src)) track.src = t.src;
      return track;
    });
    const fact: MediaElementFact = {
      tag: el.tagName === 'AUDIO' ? 'audio' : 'video',
      src,
      tracks,
      autoplay: el.autoplay,
      muted: el.muted || el.defaultMuted,
      controls: el.controls,
      loop: el.loop,
      transcriptNearby: transcriptNearby(el),
    };
    if (Number.isFinite(el.duration) && el.duration > 0) {
      const plays = fragment(el.currentSrc || src, el.duration) ?? el.duration;
      fact.duration = Math.round(plays * 10) / 10;
    }
    if (fact.tag === 'video') {
      const audio = audioTracks(el);
      if (audio) fact.audio = audio;
    }
    if (fact.tag === 'video' && !shown(el)) fact.hidden = true;
    if (fact.tag === 'video' && alternativeNearby(el)) fact.alternativeForText = true;
    const poster = el instanceof HTMLVideoElement ? http(el.poster) : '';
    if (poster) fact.poster = poster;
    const name = nameOf(el);
    if (name) fact.name = name;
    // A background video: hidden from assistive technology on the video itself, muted, looping, no controls.
    // Hidden only through an ancestor (an inactive carousel slide) is not proof of decoration.
    if ((el.getAttribute('aria-hidden') === 'true' || /^(presentation|none)$/.test((el.getAttribute('role') ?? '').trim())) && fact.muted && fact.loop && !fact.controls) fact.decorative = true;
    elements.push(fact);
  }

  const frames: MediaFrameFact[] = [];
  const addFrame = (f: Element, src: string, via?: MediaFrameFact['via']) => {
    if (!src || frames.length >= arg.perKind) return;
    const fact: MediaFrameFact = { src, transcriptNearby: transcriptNearby(f), ...(via ? { via } : {}) };
    const title = clean(f.getAttribute('title'), arg.name) || nameOf(f) || clean(f.getAttribute('playlabel'), arg.name);
    if (title) fact.title = title;
    frames.push(fact);
  };
  for (const f of [...document.querySelectorAll('iframe')] as HTMLIFrameElement[]) {
    addFrame(f, http(f.src) || absolute(f.getAttribute('data-src') ?? f.getAttribute('data-lazy-src')));
  }
  // Click-to-load previews: the player's iframe exists only after a click (never made here).
  for (const el of [...document.querySelectorAll('lite-youtube, lite-vimeo, lite-vimeo-embed, [data-youtube-id], [data-vimeo-id], :not(iframe)[data-src], :not(iframe)[data-embed], :not(iframe)[data-video-src], :not(iframe)[data-iframe-src]')].slice(0, 200)) {
    const tag = el.tagName.toLowerCase();
    const id = el.getAttribute('videoid') ?? el.getAttribute('data-youtube-id') ?? el.getAttribute('data-vimeo-id');
    const src = tag === 'lite-youtube' || el.hasAttribute('data-youtube-id') ? (id ? `https://www.youtube.com/embed/${id}` : '')
      : tag.startsWith('lite-vimeo') || el.hasAttribute('data-vimeo-id') ? (id ? `https://player.vimeo.com/video/${id}` : '')
        : absolute(el.getAttribute('data-src') ?? el.getAttribute('data-embed') ?? el.getAttribute('data-video-src') ?? el.getAttribute('data-iframe-src'));
    // Lazy images and backgrounds use data-src too: only addresses that are not image files.
    if (/^(img|source|script|link|video|audio|track|picture)$/.test(tag) || /\.(jpe?g|png|gif|webp|avif|svg)(\?|#|$)/i.test(src)) continue;
    addFrame(el, src, 'facade');
  }
  // Iframes inside open shadow roots (web components); closed roots cannot be seen from here.
  const roots: ShadowRoot[] = [];
  for (const el of [...document.querySelectorAll('*')].slice(0, 20_000)) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (let i = 0; i < roots.length && i < 200; i++) {
    for (const el of [...roots[i]!.querySelectorAll('*')].slice(0, 5000)) {
      if (el.shadowRoot) roots.push(el.shadowRoot);
      if (el.tagName === 'IFRAME') addFrame(el, http((el as HTMLIFrameElement).src), 'shadow');
    }
  }

  const ext = new RegExp(arg.mediaExt, 'i');
  // A YouTube video's own page (the inventory reads its id): youtu.be/<id>, /watch?v=<id>, /shorts/<id>, /live/<id>.
  const videoPage = (u: URL) => (/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)
    ? (u.pathname === '/watch' && u.searchParams.has('v')) || /^\/(shorts|live)\/[\w-]{6,20}\/?$/.test(u.pathname)
    : /^youtu\.be$/i.test(u.hostname) && /^\/[\w-]{6,20}\/?$/.test(u.pathname));
  const links: MediaLinkFact[] = [];
  const seen = new Set<string>();
  for (const a of [...document.querySelectorAll('a[href]')] as HTMLAnchorElement[]) {
    if (links.length >= arg.perKind) break;
    const href = http(a.href);
    if (!href || seen.has(href)) continue;
    let u: URL;
    try {
      u = new URL(href);
    } catch {
      continue;
    }
    if (!ext.test(u.pathname) && !videoPage(u)) continue;
    seen.add(href);
    links.push({ href, text: clean(a.innerText || a.textContent || a.getAttribute('aria-label'), arg.text), transcriptNearby: transcriptNearby(a) });
  }
  return { elements, frames, links };
}

/** Video and audio on the page (desktop). Runs on every scan; cheap (no network, no waiting). */
export const mediaCollector: PageCollector<MediaFacts> = {
  id: 'media',
  viewport: 'desktop',
  collect: (page) => page.evaluate(collectMedia, { mediaExt: MEDIA_FILE_EXT.source, ...MEDIA_LIMITS }),
};
