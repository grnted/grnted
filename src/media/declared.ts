// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a stream or a file declares about its tracks, read without playing it (batch 18, lane media, G9 and G10):
// HLS and DASH manifests (text renditions, closed captions carried in the picture's stream, audio renditions that
// describe the video, live or recorded), caption files in the formats sites publish (WebVTT, SRT, SBV, TTML/DFXP;
// SCC is named, not decoded), and the text tracks an MP4 or WebM file declares. Neutral data for the closed AI media
// checks: nothing here decides anything. Pure; engine core: no Node-only imports.
import { parseVtt, type VttCue } from './vtt.js';

// --- Manifests ---------------------------------------------------------------------------------------------------

/** A rendition a manifest offers besides the main picture and sound. */
export interface DeclaredRendition {
  /** subtitles (a text track), captions (608/708 carried in the video stream), or audio. */
  type: 'subtitles' | 'closed-captions' | 'audio';
  name?: string;
  language?: string;
  /** HLS CHARACTERISTICS, DASH Role and Accessibility values, as written. */
  characteristics?: string[];
  /** The manifest marks it as describing the video (an audio description), by a standard value. */
  describesVideo?: true;
  /** The manifest marks it as transcribing the dialogue and sounds (captions rather than subtitles), by a standard value. */
  transcribesSpokenDialog?: true;
  default?: true;
  forced?: true;
  /** Its own playlist or file, resolved against the manifest's address. */
  uri?: string;
}

export interface DeclaredManifest {
  format: 'hls' | 'dash';
  /** A master playlist or MPD that lists renditions (HLS: variant streams). */
  master: boolean;
  /** Live (no end list, an event playlist still open, a dynamic MPD), recorded (an end list, VOD, a static MPD), or not known. */
  live?: boolean;
  renditions: DeclaredRendition[];
  /** Variant streams (HLS) or video adaptation sets (DASH). */
  variants: number;
  /** HLS: a variant that says CLOSED-CAPTIONS=NONE (no 608/708 in that stream). */
  captionsNone?: true;
}

const HLS_DESCRIBES = 'public.accessibility.describes-video';
const HLS_TRANSCRIBES = 'public.accessibility.transcribes-spoken-dialog';

/** The attributes of an HLS tag line: KEY=VALUE pairs, quoted values unquoted. */
function hlsAttrs(line: string): Record<string, string> {
  const out: Record<string, string> = {};
  const body = line.slice(line.indexOf(':') + 1);
  const re = /([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g;
  for (let m = re.exec(body); m; m = re.exec(body)) out[m[1]!] = m[3] ?? m[2]!;
  return out;
}

function resolve(uri: string | undefined, base: string): string | undefined {
  if (!uri) return undefined;
  try { return new URL(uri, base).href; } catch { return undefined; }
}

/** An HLS playlist (`#EXTM3U`), master or media; undefined when the text is not one. */
export function readHls(text: string, base: string): DeclaredManifest | undefined {
  const lines = text.slice(0, 2_000_000).split(/\r?\n/).map((l) => l.trim());
  if (lines[0] !== '#EXTM3U' && !lines.some((l) => l === '#EXTM3U')) return undefined;
  const renditions: DeclaredRendition[] = [];
  let variants = 0;
  let captionsNone = false;
  let endList = false;
  let type: string | undefined;
  let segments = 0;
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MEDIA:')) {
      const a = hlsAttrs(l);
      const t = a.TYPE === 'SUBTITLES' ? 'subtitles' : a.TYPE === 'CLOSED-CAPTIONS' ? 'closed-captions' : a.TYPE === 'AUDIO' ? 'audio' : undefined;
      if (!t || renditions.length >= 50) continue;
      const ch = a.CHARACTERISTICS ? a.CHARACTERISTICS.split(',').map((x) => x.trim()).filter(Boolean) : [];
      const uri = resolve(a.URI, base);
      renditions.push({
        type: t, ...(a.NAME ? { name: a.NAME.slice(0, 100) } : {}), ...(a.LANGUAGE ? { language: a.LANGUAGE.slice(0, 35) } : {}),
        ...(ch.length ? { characteristics: ch } : {}), ...(ch.includes(HLS_DESCRIBES) ? { describesVideo: true as const } : {}),
        ...(ch.includes(HLS_TRANSCRIBES) ? { transcribesSpokenDialog: true as const } : {}),
        ...(a.DEFAULT === 'YES' ? { default: true as const } : {}), ...(a.FORCED === 'YES' ? { forced: true as const } : {}),
        ...(uri ? { uri } : {}),
      });
    } else if (l.startsWith('#EXT-X-STREAM-INF:')) {
      variants++;
      if (hlsAttrs(l)['CLOSED-CAPTIONS'] === 'NONE') captionsNone = true;
    } else if (l === '#EXT-X-ENDLIST') endList = true;
    else if (l.startsWith('#EXT-X-PLAYLIST-TYPE:')) type = l.slice('#EXT-X-PLAYLIST-TYPE:'.length).trim();
    else if (l.startsWith('#EXTINF:')) segments++;
  }
  const master = variants > 0;
  // A media playlist tells: an end list or VOD is recorded; segments with neither is a live window. A master
  // playlist does not say (its media playlists do).
  const live = master ? undefined : endList || type === 'VOD' ? false : segments > 0 ? true : undefined;
  return { format: 'hls', master, ...(live !== undefined ? { live } : {}), renditions, variants, ...(captionsNone ? { captionsNone: true as const } : {}) };
}

/** The attributes of one XML start tag. */
function xmlAttrs(tag: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([\w:-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  for (let m = re.exec(tag); m; m = re.exec(tag)) out[m[1]!] = m[3] ?? m[4] ?? '';
  return out;
}

/** A DASH MPD; undefined when the text is not one. */
export function readDash(text: string, base: string): DeclaredManifest | undefined {
  const t = text.slice(0, 2_000_000);
  const mpd = /<MPD\b[^>]*>/i.exec(t);
  if (!mpd) return undefined;
  const live = (xmlAttrs(mpd[0]).type ?? 'static') === 'dynamic';
  const renditions: DeclaredRendition[] = [];
  let variants = 0;
  const sets = t.match(/<AdaptationSet\b[\s\S]*?<\/AdaptationSet>/gi) ?? [];
  for (const set of sets.slice(0, 100)) {
    const open = /<AdaptationSet\b[^>]*>/i.exec(set)![0];
    const a = xmlAttrs(open);
    const rep = /<Representation\b[^>]*>/i.exec(set);
    const r = rep ? xmlAttrs(rep[0]) : {};
    const mime = (a.mimeType ?? r.mimeType ?? '').toLowerCase();
    const content = (a.contentType ?? '').toLowerCase();
    const codecs = (a.codecs ?? r.codecs ?? '').toLowerCase();
    const roles = [...set.matchAll(/<(Role|Accessibility)\b[^>]*>/gi)].map((m) => xmlAttrs(m[0]));
    const values = roles.map((x) => `${x.schemeIdUri ?? ''}#${x.value ?? ''}`);
    const isText = content === 'text' || mime.startsWith('text/') || mime === 'application/ttml+xml' || /stpp|wvtt/.test(codecs) || (mime === 'application/mp4' && /stpp|wvtt/.test(codecs));
    const isAudio = content === 'audio' || mime.startsWith('audio/');
    const isVideo = content === 'video' || mime.startsWith('video/');
    const characteristics = values.length ? values : undefined;
    // Standard values: DASH Role "description" and the TV-Anytime AudioPurpose "1" (visually impaired) mark a
    // description; Role "caption" marks captions; the SCTE 608 scheme marks captions carried in the picture.
    const describes = roles.some((x) => (x.value ?? '') === 'description' || (/AudioPurposeCS/i.test(x.schemeIdUri ?? '') && x.value === '1'));
    const transcribes = roles.some((x) => (x.value ?? '') === 'caption' || (/AudioPurposeCS/i.test(x.schemeIdUri ?? '') && x.value === '2'));
    const cea = roles.some((x) => /urn:scte:dash:cc:cea-60[89]/i.test(x.schemeIdUri ?? ''));
    if (isVideo) variants++;
    if (cea && renditions.length < 50) renditions.push({ type: 'closed-captions', ...(characteristics ? { characteristics } : {}) });
    if ((isText || isAudio) && renditions.length < 50) {
      renditions.push({
        type: isText ? 'subtitles' : 'audio', ...(a.lang ? { language: a.lang.slice(0, 35) } : {}), ...(a.label ? { name: a.label.slice(0, 100) } : {}),
        ...(characteristics ? { characteristics } : {}), ...(describes ? { describesVideo: true as const } : {}), ...(transcribes ? { transcribesSpokenDialog: true as const } : {}),
        ...(() => { const u = resolve(/<BaseURL>([^<]+)<\/BaseURL>/i.exec(set)?.[1]?.trim(), base); return u ? { uri: u } : {}; })(),
      });
    }
  }
  return { format: 'dash', master: true, live, renditions, variants };
}

/** A manifest by its text: HLS or DASH, else undefined. */
export function readManifest(text: string, base: string): DeclaredManifest | undefined {
  return readHls(text, base) ?? readDash(text, base);
}

// --- Caption files -----------------------------------------------------------------------------------------------

export interface CaptionFile {
  format: 'webvtt' | 'srt' | 'sbv' | 'ttml' | 'scc' | 'unknown';
  /** Cue times and plain text (SCC holds 608 codes, which are not decoded: no cues). */
  cues: VttCue[];
  /** Browsers show only WebVTT in a track element; any other format needs a player of the page's to show it. */
  browserReadable: boolean;
}

const TIME = /(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})/;
function secs(t: string): number | undefined {
  const m = TIME.exec(t);
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]!.padEnd(3, '0')) / 1000;
}
const plain = (s: string) => s.replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\s+/g, ' ').trim();

/** TTML or DFXP clock time: hh:mm:ss.fff, hh:mm:ss:frames, or an offset (12.5s, 400ms, 3m). */
function ttmlTime(v: string | undefined): number | undefined {
  if (!v) return undefined;
  const off = /^([\d.]+)(h|m|s|ms|f|t)$/.exec(v.trim());
  if (off) {
    const n = Number(off[1]);
    return off[2] === 'h' ? n * 3600 : off[2] === 'm' ? n * 60 : off[2] === 's' ? n : off[2] === 'ms' ? n / 1000 : undefined;
  }
  const c = /^(\d+):(\d{2}):(\d{2})(?:[.:](\d+))?$/.exec(v.trim());
  if (!c) return undefined;
  const frac = c[4] ? (v.includes('.') ? Number(`0.${c[4]}`) : Number(c[4]) / 30) : 0;
  return Number(c[1]) * 3600 + Number(c[2]) * 60 + Number(c[3]) + frac;
}

/** Reads a captions or subtitles file in any of the formats sites publish; `name` (its file name) only breaks ties. */
export function readCaptionFile(text: string, name = ''): CaptionFile {
  const t = text.replace(/^﻿/, '').slice(0, 2_000_000);
  if (/^WEBVTT\b/.test(t)) return { format: 'webvtt', cues: parseVtt(t) ?? [], browserReadable: true };
  if (/^Scenarist_SCC V1\.0/.test(t) || /\.scc$/i.test(name)) return { format: 'scc', cues: [], browserReadable: false };
  if (/<tt\b[\s\S]*?xmlns/i.test(t) || /\.(ttml|dfxp|xml)$/i.test(name) && /<tt\b/i.test(t)) {
    const cues: VttCue[] = [];
    for (const m of t.matchAll(/<p\b([^>]*)>([\s\S]*?)<\/p>/gi)) {
      if (cues.length >= 5000) break;
      const a = xmlAttrs(`<p ${m[1]}>`);
      const start = ttmlTime(a.begin);
      const end = ttmlTime(a.end) ?? (start !== undefined && a.dur ? start + (ttmlTime(a.dur) ?? 0) : undefined);
      const body = plain(m[2]!.replace(/<br\s*\/?>/gi, ' '));
      if (start !== undefined && end !== undefined && body) cues.push({ start, end, text: body });
    }
    return { format: 'ttml', cues, browserReadable: false };
  }
  const blocks = t.split(/\r?\n\s*\r?\n/);
  // SRT: an optional number, then "00:00:01,000 --> 00:00:02,000", then text.
  const srt: VttCue[] = [];
  // SBV: "0:00:01.000,0:00:02.000", then text.
  const sbv: VttCue[] = [];
  for (const b of blocks) {
    const lines = b.split(/\r?\n/).filter((l) => l.trim() !== '');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i >= 0 && i <= 1) {
      const [a, z] = lines[i]!.split('-->');
      const start = secs(a ?? '');
      const end = secs(z ?? '');
      const body = plain(lines.slice(i + 1).join(' '));
      if (start !== undefined && end !== undefined && body && srt.length < 5000) srt.push({ start, end, text: body });
      continue;
    }
    const sb = /^(\d+:\d{2}:\d{2}\.\d{3}),(\d+:\d{2}:\d{2}\.\d{3})$/.exec(lines[0]?.trim() ?? '');
    if (sb) {
      const start = secs(sb[1]!);
      const end = secs(sb[2]!);
      const body = plain(lines.slice(1).join(' '));
      if (start !== undefined && end !== undefined && body && sbv.length < 5000) sbv.push({ start, end, text: body });
    }
  }
  if (srt.length >= sbv.length && srt.length) return { format: 'srt', cues: srt, browserReadable: false };
  if (sbv.length) return { format: 'sbv', cues: sbv, browserReadable: false };
  return { format: 'unknown', cues: [], browserReadable: false };
}

// --- Text tracks a file declares ----------------------------------------------------------------------------------

export interface DeclaredFileTrack {
  /** MP4 handler (vide, soun, text, sbtl, subt, clcp) or WebM track type (video, audio, subtitle). */
  kind: string;
  /** The sample entry (tx3g, wvtt, stpp, c608) or the WebM codec id (S_TEXT/WEBVTT). */
  codec: string;
  language?: string;
}

/** Big-endian reads within bounds. */
const u32 = (b: Uint8Array, o: number) => (o + 4 <= b.length ? ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]! : -1);
const fourcc = (b: Uint8Array, o: number) => (o + 4 <= b.length ? String.fromCharCode(b[o]!, b[o + 1]!, b[o + 2]!, b[o + 3]!) : '');

/** Child boxes of an MP4 box's payload. */
function boxes(b: Uint8Array, from: number, to: number): { type: string; start: number; end: number }[] {
  const out: { type: string; start: number; end: number }[] = [];
  let o = from;
  while (o + 8 <= to && out.length < 4096) {
    let size = u32(b, o);
    const type = fourcc(b, o + 4);
    let head = 8;
    if (size === 1) {
      const hi = u32(b, o + 8);
      const lo = u32(b, o + 12);
      if (hi < 0 || lo < 0) break;
      size = hi * 2 ** 32 + lo;
      head = 16;
    } else if (size === 0) size = to - o;
    if (size < head || o + size > to) break;
    out.push({ type, start: o + head, end: o + size });
    o += size;
  }
  return out;
}

function mp4Tracks(b: Uint8Array): DeclaredFileTrack[] | undefined {
  const top = boxes(b, 0, b.length);
  if (!top.some((x) => x.type === 'ftyp' || x.type === 'moov')) return undefined;
  const moov = top.find((x) => x.type === 'moov');
  if (!moov) return [];
  const out: DeclaredFileTrack[] = [];
  for (const trak of boxes(b, moov.start, moov.end).filter((x) => x.type === 'trak').slice(0, 32)) {
    const mdia = boxes(b, trak.start, trak.end).find((x) => x.type === 'mdia');
    if (!mdia) continue;
    const inner = boxes(b, mdia.start, mdia.end);
    const hdlr = inner.find((x) => x.type === 'hdlr');
    const mdhd = inner.find((x) => x.type === 'mdhd');
    const handler = hdlr ? fourcc(b, hdlr.start + 8) : '';
    let codec = '';
    const minf = inner.find((x) => x.type === 'minf');
    const stbl = minf ? boxes(b, minf.start, minf.end).find((x) => x.type === 'stbl') : undefined;
    const stsd = stbl ? boxes(b, stbl.start, stbl.end).find((x) => x.type === 'stsd') : undefined;
    if (stsd) codec = fourcc(b, stsd.start + 12);
    // mdhd's packed ISO-639-2 language (version 0: after 20 bytes; version 1: after 32).
    let language: string | undefined;
    if (mdhd) {
      const at = mdhd.start + (b[mdhd.start] === 1 ? 32 : 20);
      if (at + 2 <= mdhd.end) {
        const v = (b[at]! << 8) | b[at + 1]!;
        const l = String.fromCharCode(((v >> 10) & 31) + 0x60, ((v >> 5) & 31) + 0x60, (v & 31) + 0x60);
        if (/^[a-z]{3}$/.test(l) && l !== 'und') language = l;
      }
    }
    if (handler) out.push({ kind: handler, codec, ...(language ? { language } : {}) });
  }
  return out;
}

/** A WebM/Matroska EBML variable-length integer at `o`: its value and length, or undefined. */
function vint(b: Uint8Array, o: number, keepMarker: boolean): { value: number; len: number } | undefined {
  const first = b[o];
  if (first === undefined || first === 0) return undefined;
  let len = 1;
  while (len <= 8 && !(first & (0x80 >> (len - 1)))) len++;
  if (len > 8 || o + len > b.length) return undefined;
  let value = keepMarker ? first : first & (0xff >> len);
  for (let i = 1; i < len; i++) value = value * 256 + b[o + i]!;
  return { value, len };
}

function webmTracks(b: Uint8Array): DeclaredFileTrack[] | undefined {
  if (u32(b, 0) !== 0x1a45dfa3) return undefined;
  const out: DeclaredFileTrack[] = [];
  // Walk elements: master elements entered (Segment, Tracks, TrackEntry), others skipped.
  const MASTER = new Set([0x18538067, 0x1654ae6b, 0xae]);
  const walk = (from: number, to: number, entry: DeclaredFileTrack | null, depth: number) => {
    let o = from;
    let guard = 0;
    while (o < to && guard++ < 100_000) {
      const id = vint(b, o, true);
      if (!id) return;
      const size = vint(b, o + id.len, false);
      if (!size) return;
      const start = o + id.len + size.len;
      const unknown = size.value === 2 ** (7 * size.len) - 1;
      const end = unknown ? to : Math.min(to, start + size.value);
      if (id.value === 0xae && depth < 4) {
        const e: DeclaredFileTrack = { kind: '', codec: '' };
        walk(start, end, e, depth + 1);
        const types: Record<number, string> = { 1: 'video', 2: 'audio', 3: 'complex', 16: 'logo', 17: 'subtitle', 18: 'buttons', 32: 'control', 33: 'metadata' };
        if (out.length < 32) out.push({ kind: types[Number(e.kind)] ?? e.kind, codec: e.codec, ...(e.language ? { language: e.language } : {}) });
      } else if (MASTER.has(id.value) && depth < 4) {
        walk(start, end, entry, depth + 1);
        // The tracks come before the clusters: stop once Tracks has been read.
        if (id.value === 0x1654ae6b) return;
      } else if (entry && id.value === 0x83) {
        let v = 0;
        for (let i = start; i < end; i++) v = v * 256 + b[i]!;
        entry.kind = String(v);
      } else if (entry && id.value === 0x86) {
        entry.codec = String.fromCharCode(...b.subarray(start, Math.min(end, start + 64)));
      } else if (entry && id.value === 0x22b59c) {
        entry.language = String.fromCharCode(...b.subarray(start, Math.min(end, start + 8)));
      }
      if (unknown && !MASTER.has(id.value)) return;
      o = unknown ? start : end;
    }
  };
  walk(0, b.length, null, 0);
  return out;
}

/** The tracks an MP4 or WebM file declares (its first bytes are enough when its index is at the start); undefined for other files. */
export function declaredFileTracks(bytes: Uint8Array): DeclaredFileTrack[] | undefined {
  return mp4Tracks(bytes) ?? webmTracks(bytes);
}

/** The text tracks among them (MP4 text, subtitle and closed-caption handlers; WebM subtitle tracks). */
export function declaredTextTracks(tracks: readonly DeclaredFileTrack[]): DeclaredFileTrack[] {
  return tracks.filter((t) => ['text', 'sbtl', 'subt', 'clcp', 'subtitle'].includes(t.kind) || /^(tx3g|wvtt|stpp|c608|c708)$/.test(t.codec));
}
