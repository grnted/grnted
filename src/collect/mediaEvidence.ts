// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media evidence collector (batch 18, lane media, atlas docs/atlas/media.md section 10.1, G1-G7, G9, G10):
// every recording on a page however it is embedded, with neutral facts and the raw text around it, for the closed
// AI media checks. It reads only: nothing is played, loaded, pressed or fetched, and it judges nothing (no word
// decides anything here; the text is given as it is). It runs only when an AI plan asks for it, so a scan without
// AI never runs it. Engine core: no Node-only or AI imports.
import { classifyPlayer, classifyVideoLink, MEDIA_FILE_EXT, PLAYER_NAMES } from '../media/detect.js';
import type { FrameLike, PageCollector, PageLike } from '../types.js';

/** Caps per page (the in-page script applies them, and `toMediaEvidence` again: page scripts are untrusted). */
export const MEDIA_EVIDENCE_LIMITS = {
  items: 40,
  /** Characters of one section's text (the item's part of the page). */
  section: 4000,
  /** Distinct section texts kept per page (items share them by index). */
  sections: 20,
  /** Text of a block right before or after an item, its caption, its described-by text. */
  near: 600,
  /** Hidden-until-opened blocks per item (a closed disclosure, a tab panel), and characters of each. */
  hidden: 3,
  hiddenText: 2000,
  /** Links and buttons per item. */
  links: 30,
  /** Tracks per media element. */
  tracks: 20,
  /** Network entries (media files, stream manifests, captions files) and feeds per page. */
  resources: 40,
  feeds: 10,
  /** Frames read: same-site ones fully, others for their media only. */
  frames: 8,
} as const;

/** A link or button in an item's part of the page, as it is (text and destination). */
export interface MediaContextLink {
  text: string;
  /** Absolute http(s) address; '' for a button. */
  href: string;
  /** The same site as the page (host and port). */
  sameSite: boolean;
  /** What the address's file looks like, by its extension only (neutral; a name decides nothing). */
  file?: 'document' | 'media' | 'captions' | 'image';
  button?: true;
}

/** Text near a recording that is not shown until something is opened, kept apart and marked. */
export interface MediaHiddenText {
  how: 'details' | 'hidden';
  text: string;
}

/** A track of a media element, as the element lists it (track elements and the browser's text tracks). */
export interface MediaEvidenceTrack {
  kind: string;
  label?: string;
  srclang?: string;
  /** Its file, when it has one (absolute http(s)). */
  src?: string;
  /** The browser's mode (disabled, hidden, showing) and load state (0 none, 1 loading, 2 loaded, 3 error). */
  mode?: string;
  readyState?: number;
  /** Cues the browser holds now (it loads a track only when it is not disabled). */
  cues?: number;
  /** A text track the browser lists that no track element gave (in the file, or added by a script). */
  inBand?: true;
}

export interface MediaEvidenceItem {
  /** Unique within the page. */
  ref: number;
  technique: 'video' | 'audio' | 'frame' | 'preview' | 'link' | 'object' | 'embed';
  /** Where it was found: the page's document, an open shadow root, or a frame of the page. */
  where: 'document' | 'shadow' | 'frame';
  /** A path to it; across shadow roots and frames the parts are joined with ' >>> '. */
  target: string;
  /** The frame's address when it is inside one. */
  frame?: string;
  tag: string;
  /** The address it plays or points at (absolute http(s)), '' when it has none (a stream a script feeds it). */
  src: string;
  /** `<source>` children (address and type). */
  sources?: { src: string; type: string; media?: string }[];
  /** Its source is a stream a script feeds it (a blob: address or a MediaSource). */
  streamed?: true;
  /** The platform an address belongs to, when it is a known one (a name only; nothing is decided by it). */
  platform?: string;
  autoplay?: true;
  muted?: true;
  loop?: true;
  controls?: true;
  preload?: string;
  /** Seconds, when the browser read its length; 'infinite' for a stream with no end. */
  duration?: number | 'infinite';
  readyState?: number;
  /** Whether it has a sound track, from the browser's capture of it: present, none, or not known. */
  sound?: 'present' | 'none';
  tracks?: MediaEvidenceTrack[];
  /** Shown when collected (a box, not hidden), and its box (CSS px, page coordinates). */
  shown: boolean;
  box?: { x: number; y: number; w: number; h: number };
  /** Hidden from assistive technology on itself or an ancestor, and how. */
  hiddenFromAt?: 'aria-hidden' | 'presentation';
  /** Its name as the markup gives it (aria-label, aria-labelledby, title), its frame's title, its poster. */
  name?: string;
  title?: string;
  poster?: string;
  /** Link text, for a link to a media file or a platform's video page. */
  text?: string;
  /** Its part of the page: see `MediaEvidenceContext`. */
  context: MediaEvidenceContext;
}

export interface MediaEvidenceContext {
  /** The nearest heading above it, and the heading path from the page's top (h1 first). */
  heading?: string;
  headings?: string[];
  /** Its figure's caption; the text its aria-describedby and aria-details point at. */
  caption?: string;
  /**
   * The text of its figure besides the recording and the figcaption (a CMS embed block holds its own heading and
   * caption line in a wrapper: WordPress's wp-element-caption paragraph is not a figcaption), as it is.
   */
  figure?: string;
  described?: string;
  /** The text of the blocks right before and right after it. */
  before?: string;
  after?: string;
  /** Index into `MediaEvidence.sections`: the text of its part of the page, in reading order. */
  section?: number;
  /** Text near it that is not shown until opened. */
  hidden?: MediaHiddenText[];
  links?: MediaContextLink[];
  /** Recordings found in the same part of the page (itself included). */
  shared: number;
}

export interface MediaEvidence {
  page: { title: string; h1: string; lang: string };
  items: MediaEvidenceItem[];
  /** Section texts, shared by the items (`context.section`), each cut at `MEDIA_EVIDENCE_LIMITS.section`. */
  sections: { text: string; cut?: true }[];
  /** Media files, stream manifests and captions files the page requested so far (Resource Timing; addresses only). */
  resources: { url: string; initiator: string; kind: 'media' | 'manifest' | 'captions' }[];
  /** Feeds the page announces or links to (RSS, Atom). */
  feeds: { href: string; type: string; title: string }[];
  /** What the caps left out. */
  cut?: { items?: number; resources?: true; frames?: number };
}

/** What one document's script returns (a frame's too). */
interface DocEvidence {
  items: Omit<MediaEvidenceItem, 'ref'>[];
  sections: { text: string; cut?: true }[];
  resources: MediaEvidence['resources'];
  feeds: MediaEvidence['feeds'];
  page: MediaEvidence['page'];
  more: number;
}

/** Runs inside the page or a frame (serialized, so self-contained). `full` false: only its media elements, no context. */
function collectDoc(arg: { mediaExt: string; limits: typeof MEDIA_EVIDENCE_LIMITS; full: boolean }): DocEvidence {
  const L = arg.limits;
  const clean = (t: string | null | undefined, max: number) => (t ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
  const http = (u: string | null | undefined): string => {
    if (!u) return '';
    try {
      const abs = new URL(u, document.baseURI).href;
      return /^https?:/i.test(abs) ? abs : '';
    } catch {
      return '';
    }
  };
  const sameSite = (u: string) => { try { return new URL(u).host === location.host; } catch { return false; } };
  const mediaExt = new RegExp(arg.mediaExt, 'i');
  const fileKind = (u: string): MediaContextLink['file'] | undefined => {
    let path = '';
    try { path = new URL(u).pathname; } catch { return undefined; }
    if (mediaExt.test(path) || /\.(m4b|weba|mka|m3u8?|pls|mpd)$/i.test(path)) return 'media';
    if (/\.(vtt|srt|sbv|ttml|dfxp|scc)$/i.test(path)) return 'captions';
    if (/\.(pdf|docx?|odt|rtf|txt|xlsx?|pptx?)$/i.test(path)) return 'document';
    if (/\.(jpe?g|png|gif|webp|avif|svg)$/i.test(path)) return 'image';
    return undefined;
  };
  const pathOf = (el: Element): string => {
    const parts: string[] = [];
    for (let e: Element | null = el; e && parts.length < 6; e = e.parentElement) {
      if (e.id) { parts.unshift(`#${CSS.escape(e.id)}`); break; }
      const p = e.parentElement;
      const same = p ? [...p.children].filter((c) => c.localName === e!.localName) : [];
      parts.unshift(same.length > 1 ? `${e.localName}:nth-of-type(${same.indexOf(e) + 1})` : e.localName);
    }
    return parts.join(' > ');
  };
  const rootPath = (el: Element): string => {
    // Across open shadow roots: host path >>> path inside.
    const out: string[] = [pathOf(el)];
    let root = el.getRootNode();
    while (root instanceof ShadowRoot && out.length < 6) {
      out.unshift(pathOf(root.host));
      root = root.host.getRootNode();
    }
    return out.join(' >>> ');
  };
  const shown = (el: Element): boolean => {
    const r = el.getBoundingClientRect();
    const visible = typeof (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility === 'function'
      ? (el as Element & { checkVisibility: (o: Record<string, boolean>) => boolean }).checkVisibility({ visibilityProperty: true }) : true;
    return visible && r.width >= 1 && r.height >= 1;
  };
  const box = (el: Element) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const nameOf = (el: Element): string => {
    const lb = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).map((id) => (id ? el.ownerDocument.getElementById(id)?.textContent ?? '' : '')).join(' ');
    return clean(el.getAttribute('aria-label'), 200) || clean(lb, 200) || clean(el.getAttribute('title'), 200);
  };
  const hiddenFromAt = (el: Element): MediaEvidenceItem['hiddenFromAt'] | undefined => {
    for (let e: Element | null = el; e; e = e.parentElement) {
      if (e.getAttribute('aria-hidden') === 'true') return 'aria-hidden';
      if (e === el && /^(presentation|none)$/.test((e.getAttribute('role') ?? '').trim())) return 'presentation';
    }
    return undefined;
  };
  const blockText = (el: Element | null | undefined, max: number) => (el ? clean((el as HTMLElement).innerText || el.textContent, max) : '');

  // --- What plays, and where it was found ---------------------------------------------------------------------
  type Found = { el: Element; where: 'document' | 'shadow' };
  const found: Found[] = [];
  const seen = new Set<Element>();
  const look = (root: Document | ShadowRoot, where: Found['where']) => {
    for (const el of root.querySelectorAll('video, audio, iframe, object, embed, a[href], lite-youtube, lite-vimeo, lite-vimeo-embed, [data-youtube-id], [data-vimeo-id], :not(iframe)[data-video-src], :not(iframe)[data-iframe-src]')) {
      if (!seen.has(el)) { seen.add(el); found.push({ el, where }); }
    }
  };
  look(document, 'document');
  const roots: ShadowRoot[] = [];
  for (const el of [...document.querySelectorAll('*')].slice(0, 20_000)) if (el.shadowRoot) roots.push(el.shadowRoot);
  for (let i = 0; i < roots.length && i < 100; i++) {
    for (const el of [...roots[i]!.querySelectorAll('*')].slice(0, 5000)) if (el.shadowRoot && roots.length < 200) roots.push(el.shadowRoot);
    look(roots[i]!, 'shadow');
  }

  const items: DocEvidence['items'] = [];
  let more = 0;
  const videoPage = (u: URL) => (/^(www\.|m\.)?youtube\.com$/i.test(u.hostname)
    ? (u.pathname === '/watch' && u.searchParams.has('v')) || /^\/(shorts|live)\/[\w-]{6,20}\/?$/.test(u.pathname)
    : /^youtu\.be$/i.test(u.hostname) && /^\/[\w-]{6,20}\/?$/.test(u.pathname));
  for (const { el, where } of found) {
    const tag = el.localName;
    let technique: MediaEvidenceItem['technique'] | null = null;
    let src = '';
    const extra: Partial<MediaEvidenceItem> = {};
    if (el instanceof HTMLMediaElement) {
      technique = tag === 'audio' ? 'audio' : 'video';
      const raw = el.currentSrc || el.getAttribute('src') || '';
      src = http(raw) || http(el.querySelector('source[src]')?.getAttribute('src'));
      if (/^blob:/i.test(raw) || (!src && (el as HTMLMediaElement & { srcObject?: unknown }).srcObject)) extra.streamed = true;
      const sources = [...el.querySelectorAll('source')].slice(0, 6).map((s) => ({ src: http(s.getAttribute('src')), type: clean(s.getAttribute('type'), 80), ...(s.getAttribute('media') ? { media: clean(s.getAttribute('media'), 80) } : {}) })).filter((s) => s.src);
      if (sources.length) extra.sources = sources;
      if (el.autoplay) extra.autoplay = true;
      if (el.muted || el.defaultMuted) extra.muted = true;
      if (el.loop) extra.loop = true;
      if (el.controls) extra.controls = true;
      if (el.preload) extra.preload = el.preload;
      if (el.duration === Infinity) extra.duration = 'infinite';
      else if (Number.isFinite(el.duration) && el.duration > 0) extra.duration = Math.round(el.duration * 10) / 10;
      extra.readyState = el.readyState;
      if (el.readyState >= 1) {
        try {
          const stream = (el as HTMLMediaElement & { captureStream?: () => MediaStream }).captureStream?.();
          if (stream) {
            const a = stream.getAudioTracks().length;
            const v = stream.getVideoTracks().length;
            stream.getTracks().forEach((t) => t.stop());
            if (a) extra.sound = 'present';
            else if (v) extra.sound = 'none';
          }
        } catch { /* not capturable (cross-origin): not known */ }
      }
      const elements = [...el.querySelectorAll('track')].slice(0, L.tracks) as HTMLTrackElement[];
      const own = new Set(elements.map((t) => t.track));
      const tracks: MediaEvidenceTrack[] = elements.map((t) => ({
        kind: t.kind, ...(t.label ? { label: clean(t.label, 100) } : {}), ...(t.srclang ? { srclang: clean(t.srclang, 35) } : {}),
        ...(http(t.getAttribute('src')) ? { src: http(t.getAttribute('src')) } : {}),
        mode: t.track.mode, readyState: t.readyState, ...(t.track.cues ? { cues: t.track.cues.length } : {}),
      }));
      for (const t of [...el.textTracks].slice(0, L.tracks)) {
        if (own.has(t)) continue;
        tracks.push({ kind: t.kind, ...(t.label ? { label: clean(t.label, 100) } : {}), ...(t.language ? { srclang: clean(t.language, 35) } : {}), mode: t.mode, ...(t.cues ? { cues: t.cues.length } : {}), inBand: true });
      }
      if (tracks.length) extra.tracks = tracks.slice(0, L.tracks);
      const poster = el instanceof HTMLVideoElement ? http(el.poster) : '';
      if (poster) extra.poster = poster;
    } else if (tag === 'iframe') {
      src = http(el.getAttribute('src')) || http(el.getAttribute('data-src') ?? el.getAttribute('data-lazy-src'));
      if (!src) continue;
      technique = 'frame';
      const title = clean(el.getAttribute('title'), 200);
      if (title) extra.title = title;
    } else if (tag === 'object' || tag === 'embed') {
      src = http(el.getAttribute(tag === 'object' ? 'data' : 'src'));
      const type = el.getAttribute('type') ?? '';
      if (!src || !(/^(audio|video)\//i.test(type) || fileKind(src) === 'media')) continue;
      technique = tag;
    } else if (tag === 'a') {
      const href = http(el.getAttribute('href'));
      if (!href) continue;
      let u: URL;
      try { u = new URL(href); } catch { continue; }
      if (!(mediaExt.test(u.pathname) || /\.(m4b|weba|mka|m3u8?|pls)$/i.test(u.pathname) || videoPage(u))) continue;
      technique = 'link';
      src = href;
      extra.text = clean((el as HTMLElement).innerText || el.textContent || el.getAttribute('aria-label'), 200);
    } else {
      // A click-to-load preview: the player exists only after a click (never made here).
      const id = el.getAttribute('videoid') ?? el.getAttribute('data-youtube-id') ?? el.getAttribute('data-vimeo-id');
      src = tag === 'lite-youtube' || el.hasAttribute('data-youtube-id') ? (id ? `https://www.youtube.com/embed/${id}` : '')
        : tag.startsWith('lite-vimeo') || el.hasAttribute('data-vimeo-id') ? (id ? `https://player.vimeo.com/video/${id}` : '')
          : http(el.getAttribute('data-video-src') ?? el.getAttribute('data-iframe-src'));
      if (!src || /\.(jpe?g|png|gif|webp|avif|svg)(\?|#|$)/i.test(src)) continue;
      technique = 'preview';
    }
    if (!technique) continue;
    if (items.length >= L.items) { more++; continue; }
    const name = nameOf(el);
    const hid = hiddenFromAt(el);
    items.push({
      technique, where, target: rootPath(el), tag, src, ...extra,
      shown: shown(el), ...(shown(el) ? { box: box(el) } : {}),
      ...(hid ? { hiddenFromAt: hid } : {}),
      ...(name ? { name } : {}),
      context: { shared: 1 },
      __el: el,
    } as Omit<MediaEvidenceItem, 'ref'> & { __el: Element });
  }

  // --- The text around each item ------------------------------------------------------------------------------
  const sections: DocEvidence['sections'] = [];
  const sectionIndex = new Map<Element, number>();
  // An item's part of the page: its closest structural container (through its figure), else the run of blocks
  // between the headings around it (the same idea as the media tests' `sectionParts`).
  const partOf = (el: Element): Element[] => {
    const host = (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el);
    const fig = host.closest('figure');
    const boxEl = (fig ?? host).closest('section, article, aside, li, td, dd, details, dialog, [role="region"], [role="article"]');
    if (boxEl) return [boxEl];
    let node: Element = fig ?? host;
    while (node.parentElement && node.parentElement !== document.body && !node.parentElement.matches('main, [role="main"]')) node = node.parentElement;
    const parts = [node];
    for (let s = node.previousElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.previousElementSibling) parts.unshift(s);
    for (let s = node.nextElementSibling; s && !/^H[1-6]$/.test(s.tagName); s = s.nextElementSibling) parts.push(s);
    return parts;
  };
  const headingsAbove = (el: Element): string[] => {
    const all = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
    const host = (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el);
    const path: { level: number; text: string }[] = [];
    for (const h of all) {
      if (!(h.compareDocumentPosition(host) & Node.DOCUMENT_POSITION_FOLLOWING)) break;
      const level = /^H[1-6]$/.test(h.tagName) ? Number(h.tagName.slice(1)) : Number(h.getAttribute('aria-level') ?? 2);
      while (path.length && path[path.length - 1]!.level >= level) path.pop();
      path.push({ level, text: clean(h.textContent, 200) });
    }
    return path.map((p) => p.text).filter(Boolean).slice(-6);
  };
  if (arg.full) {
    const parts = new Map<object, Element[]>();
    for (const it of items as (Omit<MediaEvidenceItem, 'ref'> & { __el: Element })[]) {
      const el = it.__el;
      const host = (el.getRootNode() instanceof ShadowRoot ? (el.getRootNode() as ShadowRoot).host : el);
      const part = partOf(el);
      const key = part[0]!;
      parts.set(it, part);
      if (!sectionIndex.has(key) && sections.length < L.sections) {
        const text = part.map((p) => blockText(p, L.section + 1)).filter(Boolean).join('\n');
        sectionIndex.set(key, sections.length);
        sections.push(text.length > L.section ? { text: text.slice(0, L.section), cut: true } : { text });
      }
      const ctx: MediaEvidenceContext = { shared: 1 };
      const heads = headingsAbove(el);
      if (heads.length) { ctx.headings = heads; ctx.heading = heads[heads.length - 1]; }
      const fig = host.closest('figure');
      const caption = blockText(fig?.querySelector('figcaption'), L.near);
      if (caption) ctx.caption = caption;
      if (fig) {
        // A detached copy (nothing in it loads or runs): the figure's own text without the recordings and the caption.
        const copy = fig.cloneNode(true) as Element;
        copy.querySelectorAll('video, audio, iframe, object, embed, figcaption, script, style, template, noscript').forEach((n) => n.remove());
        // Text nodes joined with spaces (a heading and the paragraph after it are separate lines, not one word).
        const pieces: string[] = [];
        const walk = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT);
        for (let n = walk.nextNode(); n; n = walk.nextNode()) pieces.push(n.nodeValue ?? '');
        const text = clean(pieces.join(' '), L.near);
        if (text) ctx.figure = text;
      }
      const ids = `${el.getAttribute('aria-describedby') ?? ''} ${el.getAttribute('aria-details') ?? ''}`.split(/\s+/).filter(Boolean);
      const described = clean(ids.map((id) => blockText(el.ownerDocument.getElementById(id), L.near)).join(' '), L.near);
      if (described) ctx.described = described;
      // The blocks right before and after it (from its figure, up through wrappers that hold only it).
      let node: Element = host.closest('figure') ?? host;
      while (node.parentElement && node.parentElement !== document.body && node.parentElement.children.length === 1) node = node.parentElement;
      const before = blockText(node.previousElementSibling, L.near);
      const after = blockText(node.nextElementSibling, L.near);
      if (before) ctx.before = before;
      if (after) ctx.after = after;
      const si = sectionIndex.get(key);
      if (si !== undefined) ctx.section = si;
      // Text in its part that is not shown until opened: a closed disclosure, a hidden panel.
      const hidden: MediaHiddenText[] = [];
      for (const p of part) {
        for (const d of [...(p.matches('details:not([open])') ? [p] : []), ...p.querySelectorAll('details:not([open])')]) {
          if (hidden.length >= L.hidden) break;
          const t = clean(d.textContent, L.hiddenText);
          if (t) hidden.push({ how: 'details', text: t });
        }
        for (const h of p.querySelectorAll('[hidden], [role="tabpanel"], [aria-hidden="false"]')) {
          if (hidden.length >= L.hidden) break;
          if (shown(h) || h.closest('details:not([open])')) continue;
          const t = clean(h.textContent, L.hiddenText);
          if (t) hidden.push({ how: 'hidden', text: t });
        }
      }
      if (hidden.length) ctx.hidden = hidden;
      // The links and buttons in its part, and in the blocks right before and after it.
      const links: MediaContextLink[] = [];
      const pool = new Set<Element>();
      for (const p of [...part, node.previousElementSibling, node.nextElementSibling]) {
        if (!p) continue;
        if (p.matches('a[href], button, [role="button"]')) pool.add(p);
        for (const a of p.querySelectorAll('a[href], button, [role="button"]')) pool.add(a);
      }
      for (const a of pool) {
        if (links.length >= L.links) break;
        if (a === el || el.contains(a)) continue;
        const text = clean((a as HTMLElement).innerText || a.textContent || a.getAttribute('aria-label') || a.getAttribute('title'), 150);
        const href = a.localName === 'a' ? http(a.getAttribute('href')) : '';
        if (!text && !href) continue;
        const file = href ? fileKind(href) : undefined;
        links.push({ text, href, sameSite: href ? sameSite(href) : true, ...(file ? { file } : {}), ...(a.localName === 'a' ? {} : { button: true }) });
      }
      if (links.length) ctx.links = links;
      it.context = ctx;
    }
    // How many recordings share each part.
    const count = new Map<Element, number>();
    for (const part of parts.values()) count.set(part[0]!, (count.get(part[0]!) ?? 0) + 1);
    for (const [it, part] of parts) (it as MediaEvidenceItem).context.shared = count.get(part[0]!) ?? 1;
  }
  for (const it of items as (Omit<MediaEvidenceItem, 'ref'> & { __el?: Element })[]) delete it.__el;

  // --- What the page requested, and the feeds it offers --------------------------------------------------------
  const resources: DocEvidence['resources'] = [];
  if (arg.full) {
    try {
      for (const e of performance.getEntriesByType('resource') as PerformanceResourceTiming[]) {
        if (resources.length >= L.resources) break;
        let path = '';
        try { path = new URL(e.name).pathname; } catch { continue; }
        const kind = /\.(m3u8|mpd)$/i.test(path) ? 'manifest' : /\.(vtt|srt|ttml|dfxp)$/i.test(path) ? 'captions'
          : (mediaExt.test(path) || /\.(m4s|ts|m4b|weba)$/i.test(path) || e.initiatorType === 'video' || e.initiatorType === 'audio') ? 'media' : null;
        if (!kind || !/^https?:/i.test(e.name)) continue;
        // One entry per file (stream segments of one rendition share a folder: kept once each, the cap holds).
        if (resources.some((r) => r.url === e.name)) continue;
        resources.push({ url: e.name.slice(0, 500), initiator: e.initiatorType, kind });
      }
    } catch { /* no Resource Timing */ }
  }
  const feeds: DocEvidence['feeds'] = [];
  if (arg.full) {
    for (const l of document.querySelectorAll('link[rel~="alternate"][type*="rss" i], link[rel~="alternate"][type*="atom" i], link[rel~="alternate"][type*="feed" i], a[type*="rss" i], a[href$=".rss" i], a[href*="/feed" i], a[href*="rss" i]')) {
      if (feeds.length >= L.feeds) break;
      const href = http(l.getAttribute('href'));
      if (!href || feeds.some((f) => f.href === href)) continue;
      feeds.push({ href, type: clean(l.getAttribute('type'), 80), title: clean(l.getAttribute('title') || (l as HTMLElement).innerText || l.textContent, 150) });
    }
  }
  const page = { title: clean(document.title, 200), h1: clean(document.querySelector('h1')?.textContent, 200), lang: clean(document.documentElement.lang, 35) };
  return { items, sections, resources, feeds, page, more };
}

/** The values a page script returned, checked and capped again (page scripts are untrusted). */
export function toMediaEvidence(main: DocEvidence, frames: { url: string; doc: DocEvidence }[], framesLeft: number): MediaEvidence {
  const L = MEDIA_EVIDENCE_LIMITS;
  const items: MediaEvidenceItem[] = [];
  const sections = main.sections.slice(0, L.sections);
  let more = main.more;
  const add = (it: Omit<MediaEvidenceItem, 'ref'>, frame?: string) => {
    if (items.length >= L.items) { more++; return; }
    const match = it.src ? classifyPlayer(it.src) ?? classifyVideoLink(it.src) : undefined;
    items.push({ ...it, ref: items.length + 1, ...(frame ? { where: 'frame', frame, target: `iframe[src="${frame.slice(0, 200)}"] >>> ${it.target}` } : {}), ...(match ? { platform: PLAYER_NAMES[match.player] } : {}) });
  };
  for (const it of main.items) add(it);
  for (const f of frames) {
    for (const it of f.doc.items) {
      // A frame's own section texts are not kept (its host iframe's context, in the page, is); the item keeps the rest.
      const { section: _s, ...context } = it.context;
      add({ ...it, context }, f.url);
    }
    more += f.doc.more;
  }
  const cut = { ...(more ? { items: more } : {}), ...(main.resources.length >= L.resources ? { resources: true as const } : {}), ...(framesLeft ? { frames: framesLeft } : {}) };
  return { page: main.page, items, sections, resources: main.resources.slice(0, L.resources), feeds: main.feeds.slice(0, L.feeds), ...(Object.keys(cut).length ? { cut } : {}) };
}

const sameOrigin = (a: string, b: string) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };

/** The frames to read: child frames of the page that are not a known platform's player (their own media is the platform's). */
async function readFrames(page: PageLike, url: string): Promise<{ frames: { url: string; doc: DocEvidence }[]; left: number }> {
  const out: { url: string; doc: DocEvidence }[] = [];
  let left = 0;
  const main = page.mainFrame?.();
  const all = (page.frames?.() ?? []).filter((f) => !(main && (f as unknown) === (main as unknown)) && f.parentFrame());
  for (const f of all as FrameLike[]) {
    const fu = f.url();
    if (!/^https?:/i.test(fu) || classifyPlayer(fu)) continue;
    if (out.length >= MEDIA_EVIDENCE_LIMITS.frames) { left++; continue; }
    // A frame of another site gives its media elements only; one of the page's own site its context too.
    const full = sameOrigin(fu, url);
    const doc = await Promise.race([
      f.evaluate(collectDoc, { mediaExt: MEDIA_FILE_EXT.source, limits: MEDIA_EVIDENCE_LIMITS, full }).catch(() => null),
      new Promise<null>((r) => setTimeout(() => r(null), 1500)),
    ]);
    if (doc && doc.items.length) out.push({ url: fu.slice(0, 500), doc });
  }
  return { frames: out, left };
}

/** Every recording on the page (desktop), for the closed AI media checks only: never runs without an AI plan. */
export const mediaEvidenceCollector: PageCollector<MediaEvidence> = {
  id: 'mediaEvidence',
  viewport: 'desktop',
  timeoutMs: 8000,
  async collect(page, ctx) {
    const main = await page.evaluate(collectDoc, { mediaExt: MEDIA_FILE_EXT.source, limits: MEDIA_EVIDENCE_LIMITS, full: true });
    const { frames, left } = await readFrames(page, ctx.url);
    return toMediaEvidence(main, frames, left);
  },
};
