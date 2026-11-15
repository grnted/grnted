// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 (stage 2, 2026-11-09): how to fix each kind of problem, for the job pages. For every test that can
// produce a problem today (each axe rule the scan runs, each criterion a registry test can fail, each gated AI
// check, the media and cross-page rules, each PDF quick check and AI document criterion, each Office check),
// 2 to 4 short numbered steps and, where a code fix is safe to show, a before/after built from the page's own
// HTML (or a measured value). Every code builder names the WCAG technique it applies (or the failure it
// removes) in `techniques`; a fix that can't be shown safely as code has steps only.
//
// Voice: plain words, imperative, one action per step, no rule ids, US spelling. Code is plain text lines:
// the renderer escapes them. Everything read from a page is untrusted: tags are read with the linear
// start-tag reader, never a DOM, and a builder returns null when it can't read the element with certainty.
// Changing any of it bumps COPY_VERSION. Engine core: no Node-only imports.
import { parseStartTag, withoutAttrs, type StartTag } from '../startTag.js';

/** What a code builder gets: the first observation of the problem that the scan recorded. All untrusted. */
export interface FixInput {
  /** The element's HTML as the scan kept it (the start of it). */
  html?: string;
  /** Where it is: a CSS selector for axe and most tests, sometimes a label ("Email (email field)"). */
  target?: string;
  /** What the test measured, in words. */
  detail?: string;
  /** Measured values (ProbeFinding.data). */
  data?: Record<string, unknown>;
  /** A media file's address, when the problem is about a player or file. */
  asset?: string;
}

/** A code change. `before` empty: an addition. `after` empty: a removal. */
export interface CodeFix {
  /** 'page': built from the page's own HTML or a measured value. 'pattern': the common pattern, with placeholders in [brackets]. */
  source: 'page' | 'pattern';
  language: 'html' | 'css';
  before: string[];
  after: string[];
  /** The WCAG techniques (or the failures removed) this change applies, e.g. ['H37']. */
  techniques: readonly string[];
}

export interface FixCopy {
  /** 2 to 4 short numbered steps; the first one stands alone as the fix in one line. */
  steps: readonly string[];
  /** Builds the code change; null when the scan's evidence can't be read safely. */
  code?: (ex: FixInput) => Omit<CodeFix, 'techniques'> | null;
  /** Techniques behind `code` (required with it). */
  techniques?: readonly string[];
}

// ---------------------------------------------------------------- helpers for the code builders

const ATTR_VALUE = /^[^"<>]*$/;
/** The start tag with `name="value"` added (or replaced), the rest as written. Null for a value that can't be written safely. */
export function withAttr(tag: StartTag, name: string, value: string): string | null {
  if (!ATTR_VALUE.test(value)) return null;
  const base = withoutAttrs(tag, (a) => a.name === name);
  const close = base.endsWith('/>') ? '/>' : '>';
  const head = base.slice(0, base.length - close.length).replace(/\s+$/, '');
  return `${head} ${name}="${value}"${close === '/>' ? ' />' : '>'}`;
}

/** A CSS selector the scan reported (axe targets and most test targets), not a label such as `Password (password field)`. */
export function cssSelector(target: string | undefined): string | null {
  const t = (target ?? '').trim();
  if (!t || t.length > 160) return null;
  const SIMPLE = /^(?:[a-zA-Z][a-zA-Z0-9-]*|\*|[#.][a-zA-Z_][\w-]*|\[[a-zA-Z-]+(?:[$^*|~]?=(?:"[^"\]]*"|'[^'\]]*'|[\w-]+))?\]|::?[a-z-]+(?:\([\w\s+-]*\))?|\s*[>+~]\s*|\s+)+$/;
  return SIMPLE.test(t) ? t : null;
}

const HEX = /#([0-9a-f]{3}|[0-9a-f]{6})\b/i;
function rgb(hex: string): [number, number, number] | null {
  const m = HEX.exec(hex);
  if (!m) return null;
  const h = m[1]!.length === 3 ? m[1]!.split('').map((c) => c + c).join('') : m[1]!;
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16)) as [number, number, number];
}
const toHex = (c: readonly number[]) => `#${c.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('')}`;
function luminance(c: readonly number[]): number {
  const [r, g, b] = c.map((v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
/** The WCAG contrast ratio of two colors. */
export function contrastRatio(a: readonly number[], b: readonly number[]): number {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p) as [number, number];
  return (x + 0.05) / (y + 0.05);
}
/**
 * The color nearest `color` (same hue, darker or lighter) whose contrast with every color in `against` is at
 * least `need` (rounded down to two decimals, as the tests read it, with a 0.1 margin). Null when no shade of
 * it reaches that against all of them (one is light, another dark).
 */
export function fixedColor(color: string, against: readonly string[], need: number): string | null {
  const c = rgb(color);
  const others = against.map(rgb);
  if (!c || !others.length || others.some((o) => !o)) return null;
  const target = need + 0.1;
  const ok = (x: readonly number[]) => others.every((o) => contrastRatio(x, o!) >= target);
  if (ok(c)) return null;
  const darker = others.every((o) => luminance(o!) >= 0.18);
  const lighter = others.every((o) => luminance(o!) < 0.18);
  if (!darker && !lighter) return null;
  for (let t = 0; t <= 1.0001; t += 0.01) {
    const x = darker ? c.map((v) => v * (1 - t)) : c.map((v) => v + (255 - v) * t);
    const rounded = rgb(toHex(x))!;
    if (ok(rounded)) return toHex(rounded);
  }
  return null;
}

/** The words a person sees in the element's kept HTML (tags and comments dropped). */
function visibleText(html: string | undefined): string {
  return (html ?? '').replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<[^>]*(>|$)/g, ' ').replace(/\s+/g, ' ').trim();
}
/** The first quoted words in a test's detail ("…" or "…"), short and safe to show as text. */
function quoted(detail: string | undefined): string {
  const m = /[“"]([^”"<>]{1,80})[”"]/.exec(detail ?? '');
  return m ? m[1]!.trim() : '';
}
const shortPath = (url: string | undefined) => { try { return new URL(url ?? '').pathname; } catch { return ''; } };
/** The element's start tag; never a script, style or template (not page content a fix is shown on). */
const tagOf = (ex: FixInput) => { const t = parseStartTag(ex.html); return t && !['script', 'style', 'template', 'noscript', 'title'].includes(t.name) ? t : null; };
/** The path of a media file on the site itself (an audio or video file, not a page or a video host). */
const mediaPath = (url: string | undefined) => { const p = shortPath(url); return /\.(?:mp3|wav|ogg|oga|m4a|aac|flac|opus|mp4|m4v|webm|ogv|mov)$/i.test(p) && ATTR_VALUE.test(p) ? p : ''; };

/** Adds an attribute to the element's own start tag, or shows the pattern when the scan kept no tag of that element. */
function addAttrTo(names: readonly string[], attr: string, value: string, example: string) {
  return (ex: FixInput): Omit<CodeFix, 'techniques'> | null => {
    const tag = tagOf(ex);
    if (tag && names.includes(tag.name)) {
      const after = withAttr(tag, attr, value);
      if (after) return { source: 'page', language: 'html', before: [tag.raw], after: [after] };
    }
    return { source: 'pattern', language: 'html', before: [], after: [example] };
  };
}
/** Where a language code goes that the scan can't know (the page's own language). */
const LANG_PLACEHOLDER = '[the page’s language code]';

const LANGS: Readonly<Record<string, string>> = {
  english: 'en', spanish: 'es', espanol: 'es', español: 'es', french: 'fr', german: 'de', chinese: 'zh', mandarin: 'zh', cantonese: 'yue',
  vietnamese: 'vi', korean: 'ko', russian: 'ru', arabic: 'ar', tagalog: 'tl', filipino: 'fil', japanese: 'ja', portuguese: 'pt', italian: 'it',
  ukrainian: 'uk', somali: 'so', hmong: 'hmn', polish: 'pl', hindi: 'hi', punjabi: 'pa', persian: 'fa', farsi: 'fa', amharic: 'am',
  haitian: 'ht', navajo: 'nv', samoan: 'sm', marshallese: 'mh', chuukese: 'chk', romanian: 'ro', swahili: 'sw', thai: 'th', khmer: 'km', lao: 'lo',
};

// ---------------------------------------------------------------- the code builders

const imgAlt = addAttrTo(['img'], 'alt', '[what the picture shows; empty for decoration]', '<img src="…" alt="[what the picture shows]">');

function labelField(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  if (!tag || !['input', 'select', 'textarea'].includes(tag.name)) {
    return { source: 'pattern', language: 'html', before: [], after: ['<label for="email">Email address</label>', '<input id="email" type="email" autocomplete="email">'] };
  }
  const id = tag.attrs.find((a) => a.name === 'id')?.value ?? '';
  if (/^[A-Za-z][\w-]{0,40}$/.test(id)) return { source: 'page', language: 'html', before: [tag.raw], after: [`<label for="${id}">[field label]</label>`, tag.raw] };
  // No usable id: the label wraps the field (an implicit label).
  return { source: 'page', language: 'html', before: [tag.raw], after: ['<label>[field label]', `  ${tag.raw}${tag.name === 'input' ? '' : ` … </${tag.name}>`}`, '</label>'] };
}

function htmlLang(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  // The scan does not know the page's language: a placeholder, never a guess (H57 needs the real one).
  if (!tag || tag.name !== 'html') return { source: 'pattern', language: 'html', before: [], after: [`<html lang="${LANG_PLACEHOLDER}">`] };
  const after = withAttr(tag, 'lang', LANG_PLACEHOLDER);
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

function partLang(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const attr = tag?.attrs.find((a) => a.name === 'lang' || a.name === 'xml:lang');
  if (!tag || !attr) return null;
  const code = LANGS[attr.value.trim().toLowerCase()];
  if (!code) return null;
  const after = withAttr(tag, attr.name, code);
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

function xmlLang(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const lang = tag?.attrs.find((a) => a.name === 'lang')?.value.trim();
  if (!tag || !lang || !/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(lang)) return null;
  const after = withAttr(tag, 'xml:lang', lang);
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

function viewport(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const content = tag?.attrs.find((a) => a.name === 'content');
  if (!tag || tag.name !== 'meta' || !content) return { source: 'pattern', language: 'html', before: [], after: ['<meta name="viewport" content="width=device-width, initial-scale=1">'] };
  const kept = content.value.split(/[,;]/).map((s) => s.trim()).filter((s) => s && !/^(user-scalable|maximum-scale|minimum-scale)\s*=/i.test(s));
  const after = withAttr(tag, 'content', kept.join(', ') || 'width=device-width, initial-scale=1');
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

/** The colors in a contrast finding: axe's failure summary, the text test's "text #x on #y" or the field test's edge. */
function contrastColors(detail: string | undefined): { color: string; against: string[]; need: number } | null {
  const d = detail ?? '';
  const axe = /foreground colou?r: (#[0-9a-f]{3,6})\b.*?background colou?r: (#[0-9a-f]{3,6})\b[\s\S]*?ratio of ([\d.]+):1/i.exec(d);
  if (axe) return { color: axe[1]!, against: [axe[2]!], need: Number(axe[3]) };
  const text = /text (#[0-9a-f]{3,6}) on (#[0-9a-f]{3,6})\b[\s\S]*?needs at least ([\d.]+):1/i.exec(d);
  if (text) return { color: text[1]!, against: [text[2]!], need: Number(text[3]) };
  const edge = /edge (#[0-9a-f]{3,6}) between (#[0-9a-f]{3,6}) outside and (#[0-9a-f]{3,6}) inside/i.exec(d);
  if (edge) return { color: edge[1]!, against: [edge[2]!, edge[3]!], need: 3 };
  return null;
}
function colorFix(property: 'color' | 'border-color') {
  return (ex: FixInput): Omit<CodeFix, 'techniques'> | null => {
    const sel = cssSelector(ex.target);
    const c = contrastColors(ex.detail);
    if (!sel || !c || !(c.need >= 3 && c.need <= 7)) return null;
    const fixed = fixedColor(c.color, c.against, c.need);
    if (!fixed) return null;
    const ratio = Math.floor(Math.min(...c.against.map((a) => contrastRatio(rgb(fixed)!, rgb(a)!))) * 100) / 100;
    return { source: 'page', language: 'css', before: [`${sel} { ${property}: ${c.color}; }`], after: [`${sel} { ${property}: ${fixed}; } /* ${ratio}:1 */`] };
  };
}

/** Inline width and height below 24 px raised to 24 px; otherwise a stylesheet rule for the element. */
/** Elements whose box is inline unless styled otherwise. */
const INLINE_BY_DEFAULT: ReadonlySet<string> = new Set(['a', 'span', 'abbr', 'b', 'i', 'em', 'strong', 'small', 'label', 'code', 'cite', 'q', 'u', 's', 'sub', 'sup', 'time', 'mark', 'kbd', 'var', 'data']);
function targetSize(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const style = tag?.attrs.find((a) => a.name === 'style');
  if (tag && style && /(?:^|;)\s*(?:min-)?(?:width|height)\s*:/i.test(style.value)) {
    const decls = style.value.split(';').map((s) => s.trim()).filter(Boolean).map((s) => { const i = s.indexOf(':'); return [s.slice(0, i).trim().toLowerCase(), s.slice(i + 1).trim()] as [string, string]; });
    const map = new Map(decls);
    for (const p of ['width', 'height', 'min-width', 'min-height']) {
      const v = map.get(p);
      const px = v === undefined ? null : /^(\d+(?:\.\d+)?)px$/.exec(v) ? Number(/^(\d+(?:\.\d+)?)px$/.exec(v)![1]) : v === '0' ? 0 : NaN;
      if (px === null) { if (p.startsWith('min-')) map.set(p, '24px'); continue; }
      if (Number.isNaN(px)) return null; // a size we can't read: the stylesheet way only
      if (px < 24) map.set(p, '24px');
    }
    // Width and height size nothing on an inline box: an inline element (by style, or by default) becomes inline-block;
    // a display the change can't size (contents, none, table parts, a list item…) gets no code.
    const declared = map.get('display');
    const display = declared?.toLowerCase().replace(/\s*!\s*important$/, '');
    // A declaration's priority stays: an inline !important a stylesheet repeats would otherwise still win.
    const priority = declared && /!\s*important$/i.test(declared) ? '!important' : '';
    if (display === undefined) { if (INLINE_BY_DEFAULT.has(tag.name)) map.set('display', 'inline-block'); }
    else if (display === 'inline') map.set('display', `inline-block${priority}`);
    else if (!/^(?:inline-block|block|flex|inline-flex|grid|inline-grid|flow-root)$/.test(display)) return null;
    const after = withAttr(tag, 'style', [...map].map(([k, v]) => `${k}:${v}`).join(';'));
    return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
  }
  const sel = cssSelector(ex.target);
  return sel ? { source: 'page', language: 'css', before: [], after: [`${sel} { display: inline-block; min-width: 24px; min-height: 24px; }`] } : null;
}

function avoidInlineSpacing(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const style = tag?.attrs.find((a) => a.name === 'style');
  if (!tag || !style || !/!\s*important/i.test(style.value)) return null;
  const fixed = style.value.split(';').map((d) => (/^\s*(letter-spacing|word-spacing|line-height)\s*:/i.test(d) ? d.replace(/\s*!\s*important/gi, '') : d)).join(';');
  if (fixed === style.value) return null;
  const after = withAttr(tag, 'style', fixed);
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

function autoplayAudio(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  if (tag && (tag.name === 'audio' || tag.name === 'video') && tag.attrs.some((a) => a.name === 'autoplay')) {
    const t = parseStartTag(withoutAttrs(tag, (a) => a.name === 'autoplay'))!;
    const after = tag.attrs.some((a) => a.name === 'controls') ? t.raw : withAttr(t, 'controls', 'controls')?.replace(' controls="controls"', ' controls');
    return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
  }
  const src = mediaPath(ex.asset);
  return { source: src ? 'page' : 'pattern', language: 'html', before: [`<audio src="${src || '…'}" autoplay loop></audio>`], after: [`<audio src="${src || '…'}" controls></audio>`] };
}

/** The track element, with the captions file next to the video's own file; language left for the author (the scan can't know it). */
const trackLine = (src: string) => `<track kind="captions" src="${captionsFile(src)}" srclang="${LANG_PLACEHOLDER}" label="[captions language]">`;
/** The captions file beside the video's file: named from its path (a query or fragment is the video's, not the file's name). */
function captionsFile(src: string): string {
  const path = src.replace(/[?#].*$/, '');
  if (!path || path.endsWith('/')) return src ? '[captions file].vtt' : 'captions.vtt';
  return `${path.replace(/\.[a-z0-9]{2,5}$/i, '')}.vtt`;
}

/**
 * Captions for a video (H95). A video with a src: the track right after its start tag (whatever follows stays).
 * A video with source elements: the track after the last source, in the whole element as the scan kept it (the
 * content model puts tracks after sources); when the scan didn't keep the element's end, no code.
 */
function captionTrack(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  if (tag?.name === 'video') {
    const own = tag.attrs.find((a) => a.name === 'src')?.value ?? '';
    if (own) return ATTR_VALUE.test(own) ? { source: 'page', language: 'html', before: [tag.raw], after: [tag.raw, `  ${trackLine(mediaPath(ex.asset) || own)}`] } : null;
    const end = tag.rest.indexOf('</video>');
    const inner = end >= 0 ? tag.rest.slice(0, end) : '';
    // Tags inside an HTML comment are not elements: blank comments out (same length, so places still match);
    // a comment that doesn't close in what the scan kept means we can't tell, so no code.
    if (/<!--(?![\s\S]*?-->)/.test(inner)) return null;
    const live = inner.replace(/<!--[\s\S]*?-->/g, (c) => ' '.repeat(c.length));
    const sources = [...live.matchAll(/<source\b[^<>]*>/gi)];
    const last = sources[sources.length - 1];
    if (end < 0 || !last || /<track\b/i.test(live)) return null;
    const src = /\ssrc=["']([^"'<>]+)["']/i.exec(last[0])?.[1] ?? '';
    const at = last.index! + last[0].length;
    const whole = `${tag.raw}${inner}</video>`;
    return { source: 'page', language: 'html', before: [whole], after: [`${tag.raw}${inner.slice(0, at)}${trackLine(src)}${inner.slice(at)}</video>`] };
  }
  const src = mediaPath(ex.asset);
  // A video on a host (YouTube, Vimeo) takes its captions there: no track element to show.
  if (!src) return ex.asset ? null : { source: 'pattern', language: 'html', before: ['<video src="…" controls>'], after: ['<video src="…" controls>', `  ${trackLine('')}`] };
  return { source: 'page', language: 'html', before: [`<video src="${src}" controls>`], after: [`<video src="${src}" controls>`, `  ${trackLine(src)}`] };
}

function transcriptLink(ex: FixInput): Omit<CodeFix, 'techniques'> {
  const src = mediaPath(ex.asset);
  const page = src ? `${src.replace(/\.[a-z0-9]{2,5}$/i, '')}-transcript.html` : '[transcript page]';
  return { source: 'pattern', language: 'html', before: [], after: [`<p><a href="${page}">Read the transcript</a></p>`] };
}

function headingLevel(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const m = /(?:levels? skip(?:s)? from|list jumps from level) (\d) to (?:level )?(\d): [“"]([^”"<>]{1,80})[”"]/i.exec(ex.detail ?? '');
  if (!m) return null;
  const from = Number(m[1]);
  const to = Number(m[2]);
  if (!(from >= 1 && from <= 5 && to > from + 1 && to <= 6)) return null;
  return { source: 'page', language: 'html', before: [`<h${to}>${m[3]}</h${to}>`], after: [`<h${from + 1}>${m[3]}</h${from + 1}>`] };
}

function paragraphHeading(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const text = visibleText(ex.html);
  if (!tag || tag.name !== 'p' || !text || text.length > 80 || /[<>]/.test(text)) return null;
  return { source: 'page', language: 'html', before: [`<p><strong>${text}</strong></p>`], after: [`<h2>${text}</h2>`] };
}

function marqueeToText(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  const text = visibleText(ex.html);
  if (!tag || !['marquee', 'blink'].includes(tag.name) || !text || text.length > 120) return null;
  return { source: 'page', language: 'html', before: [`${tag.raw}${text}</${tag.name}>`], after: [`<p>${text}</p>`] };
}

function metaRefresh(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  return tag && tag.name === 'meta' ? { source: 'page', language: 'html', before: [tag.raw], after: [] } : null;
}

function scrollRegion(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  if (!tag || tag.attrs.some((a) => a.name === 'tabindex')) return null;
  const t1 = withAttr(tag, 'tabindex', '0');
  const t2 = t1 && withAttr(parseStartTag(t1)!, 'role', 'region');
  const t3 = t2 && withAttr(parseStartTag(t2)!, 'aria-label', '[what this box holds]');
  return t3 ? { source: 'page', language: 'html', before: [tag.raw], after: [t3] } : null;
}

/** Elements that are never named controls: a builder never shows them changed. */
const NOT_CONTENT: ReadonlySet<string> = new Set(['script', 'style', 'template', 'html', 'head', 'body', 'meta', 'link', 'title', 'noscript']);
function nameOnTag(tags: readonly string[], value: string) {
  return (ex: FixInput): Omit<CodeFix, 'techniques'> | null => {
    const tag = tagOf(ex);
    if (!tag || !(tags.includes(tag.name) || tags.includes('*') && !NOT_CONTENT.has(tag.name))) return null;
    const after = withAttr(tag, 'aria-label', value);
    return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
  };
}

function inputButtonValue(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const tag = tagOf(ex);
  if (!tag || tag.name !== 'input') return { source: 'pattern', language: 'html', before: [], after: ['<input type="submit" value="[what it does]">'] };
  const after = withAttr(tag, 'value', '[what it does]');
  return after ? { source: 'page', language: 'html', before: [tag.raw], after: [after] } : null;
}

const linkUnderline = (): Omit<CodeFix, 'techniques'> => ({ source: 'pattern', language: 'css', before: [], after: ['p a, li a, td a { text-decoration: underline; }'] });

function focusVisible(): Omit<CodeFix, 'techniques'> {
  return { source: 'pattern', language: 'css', before: [], after: [':focus-visible {', '  outline: 3px solid #000;', '  box-shadow: 0 0 0 6px #fff;', '}'] };
}

function scrollPadding(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const h = typeof ex.data?.coverHeight === 'number' && Number.isFinite(ex.data.coverHeight) ? ex.data.coverHeight : null;
  if (h === null || h < 1 || h > 400) return null;
  // Which edge the covering box sits on decides the padding; when the scan doesn't say, no code.
  const cover = /hidden behind (.{1,160}?) \((?:fixed|sticky)/i.exec(ex.detail ?? '')?.[1] ?? '';
  const edge = /\b(?:header|banner|nav|masthead|top)\b/i.test(cover) ? 'top' : /\b(?:footer|bottom|cookie|chat)\b/i.test(cover) ? 'bottom' : null;
  if (!edge) return null;
  return { source: 'page', language: 'css', before: [], after: [`html { scroll-padding-${edge}: ${Math.ceil(h) + 12}px; }`] };
}

function autocomplete(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const token = /autocomplete="([a-z-]{2,40}(?: [a-z-]{2,40})?)"/.exec(ex.detail ?? '')?.[1];
  if (!token) return null;
  const type = /email/.test(token) ? 'email' : /tel/.test(token) ? 'tel' : 'text';
  return { source: 'pattern', language: 'html', before: [`<input type="${type}" name="${token.split(' ').pop()}">`], after: [`<input type="${type}" name="${token.split(' ').pop()}" autocomplete="${token}">`] };
}

function errorText(): Omit<CodeFix, 'techniques'> {
  return { source: 'pattern', language: 'html', before: ['<input id="email" type="email">'], after: ['<input id="email" type="email" aria-invalid="true" aria-describedby="email-error">', '<p id="email-error">Enter your email address, like name@example.com.</p>'] };
}

function statusMessage(ex: FixInput): Omit<CodeFix, 'techniques'> {
  const words = quoted(ex.detail).replace(/[<>]/g, '') || 'Your request was sent.';
  return { source: 'pattern', language: 'html', before: [`<p class="message">${words}</p>`], after: [`<p class="message" role="status">${words}</p>`] };
}

function passwordPaste(): Omit<CodeFix, 'techniques'> {
  return { source: 'pattern', language: 'html', before: ['<input type="password" name="password" onpaste="return false">'], after: ['<input type="password" name="password" autocomplete="current-password">'] };
}

function clickableToButton(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const name = quoted(ex.detail);
  const id = /^#([A-Za-z][\w-]{0,40})$/.exec((ex.target ?? '').trim())?.[1];
  if (!name || /[<>]/.test(name)) return null;
  // The script that handles the click stays as it is: a button also fires it on Enter and Space.
  return { source: 'pattern', language: 'html', before: [`<div${id ? ` id="${id}"` : ''}>${name}</div>`], after: [`<button type="button"${id ? ` id="${id}"` : ''}>${name}</button>`] };
}

/**
 * The state attribute the control should have, from the test's own words (ARIA5): expanded but hidden is
 * aria-expanded="false"; collapsed but shown is "true"; a details summary contradicting its own open state needs
 * no state attribute (the browser gives it). Anything else: no example.
 */
function expandedState(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const d = ex.detail ?? '';
  const name = quoted(d);
  if (!name || /[<>]/.test(name)) return null;
  const summary = /^The button [“"][^”"]*[”"] is (?:not )?open, but aria-expanded="(?:true|false)" tells screen readers/.exec(d);
  if (summary) return { source: 'pattern', language: 'html', before: [`<summary aria-expanded="${/is not open/.test(d) ? 'true' : 'false'}">${name}</summary>`], after: [`<summary>${name}</summary>`] };
  if (!/^The button /.test(d)) return null;
  const want = /tells screen readers it is expanded, but what it opens is hidden/.test(d) ? 'false' : /tells screen readers it is collapsed, but what it opens is shown/.test(d) ? 'true' : null;
  if (!want) return null;
  return { source: 'pattern', language: 'html', before: [`<button type="button" aria-expanded="${want === 'false' ? 'true' : 'false'}">${name}</button>`], after: [`<button type="button" aria-expanded="${want}">${name}</button>`] };
}

function linkText(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const words = quoted(ex.detail);
  if (!words || /[<>]/.test(words)) return null;
  return { source: 'pattern', language: 'html', before: [`<a href="…">${words}</a>`], after: ['<a href="…">[where the link goes]</a>'] };
}

const skipLink = (): Omit<CodeFix, 'techniques'> => ({ source: 'pattern', language: 'html', before: [], after: ['<a class="skip-link" href="#main">Skip to main content</a>', '…', '<main id="main">'] });

/** Alt text longer than this is put next to the picture as text instead, in full (G94: a short alternative and the rest elsewhere). */
const MAX_ALT = 150;
function aiAltText(ex: FixInput): Omit<CodeFix, 'techniques'> | null {
  const src = (ex.target ?? '').trim();
  const words = (/Words in the picture: ([\s\S]+)$/.exec(ex.detail ?? '')?.[1] ?? '').replace(/\s+/g, ' ').replace(/["<>]/g, '').trim();
  // The image address exactly as the scan found it (origin and query included).
  if (!src || !ATTR_VALUE.test(src) || src.length > 300 || !words) return null;
  if (words.length <= MAX_ALT) return { source: 'page', language: 'html', before: [], after: [`<img src="${src}" alt="${words}">`] };
  // Too long for alt text: a short name in the alt, every word next to the picture.
  return { source: 'page', language: 'html', before: [], after: ['<figure>', `  <img src="${src}" alt="[short name of the picture]">`, `  <figcaption>${words}</figcaption>`, '</figure>'] };
}

// ---------------------------------------------------------------- the library

const f = (steps: readonly string[], code?: FixCopy['code'], techniques?: readonly string[]): FixCopy =>
  Object.freeze({ steps: Object.freeze([...steps]), ...(code ? { code, techniques: Object.freeze([...(techniques ?? [])]) } : {}) });

const NAME_STEPS = (what: string, how: string) => [
  `Give each ${what} a name that says what it does: ${how}.`,
  'Use the same words people see on screen, so voice control users can say them.',
  'Check the name in the browser’s accessibility panel.',
];

export const FIXES: Readonly<Record<string, FixCopy>> = Object.freeze({
  // ---- axe rules (RULE_IMPACTS)
  'rule:area-alt': f(['Give each clickable area of the image map an alt attribute that says where it leads.', 'Or replace the image map with ordinary links next to the image.'],
    addAttrTo(['area'], 'alt', '[where this area leads]', '<area shape="rect" coords="…" href="…" alt="[where this area leads]">'), ['H24']),
  'rule:aria-allowed-attr': f(['Remove the ARIA attribute the element’s role does not support.', 'If the state matters, change the element to one whose role supports it, such as a real button for aria-pressed.']),
  'rule:aria-braille-equivalent': f(['Add an aria-label next to each aria-braillelabel, with the same meaning in full words.', 'Add an aria-roledescription next to each aria-brailleroledescription.']),
  'rule:aria-command-name': f(NAME_STEPS('custom button, link or menu item', 'visible text inside it, or an aria-label'), nameOnTag(['*'], '[what it does]'), ['ARIA6', 'ARIA14']),
  'rule:aria-conditional-attr': f(['Use the state only where the role allows it (for example aria-checked="mixed" only on a checkbox).', 'Or use the native HTML element, which manages its own state.']),
  'rule:aria-deprecated-role': f(['Replace the retired role with its current one, or with the HTML element that has that role.', 'Remove the role if the element is only for layout.']),
  'rule:aria-hidden-body': f(['Remove aria-hidden="true" from the body element.', 'If a dialog needs the page hidden behind it, hide the other content instead, and only while the dialog is open.']),
  'rule:aria-hidden-focus': f(['Take the controls inside hidden content out of the tab order while it is hidden (the inert attribute, or tabindex="-1").', 'Or remove aria-hidden from content people can reach with Tab.']),
  'rule:aria-input-field-name': f(NAME_STEPS('custom field', 'a visible label tied to it with aria-labelledby, or an aria-label'), nameOnTag(['*'], '[what to enter]'), ['ARIA14', 'ARIA16']),
  'rule:aria-meter-name': f(['Give each meter an aria-label (or aria-labelledby) that says what it measures.', 'Keep the visible label and the name the same.'], nameOnTag(['*'], '[what it measures]'), ['ARIA14']),
  'rule:aria-progressbar-name': f(['Give each progress bar an aria-label (or aria-labelledby) that says what it tracks.', 'Keep the visible label and the name the same.'], nameOnTag(['*'], '[what it tracks]'), ['ARIA14']),
  'rule:aria-prohibited-attr': f(['Remove the aria-label or aria-labelledby from elements that can’t carry a name, such as a plain div or span.', 'If the words matter, show them as text, or move the label onto a real control or a role that allows it.']),
  'rule:aria-required-attr': f(['Add the state the role needs, such as aria-checked on a checkbox role or aria-expanded on a combobox.', 'Keep it up to date from the script that changes the control.', 'Or use the native HTML element, which has the state built in.']),
  'rule:aria-required-children': f(['Put the right items inside the widget, such as role="option" inside a listbox and role="tab" inside a tablist.', 'Or replace the custom widget with the matching HTML element.']),
  'rule:aria-required-parent': f(['Put each item inside its container, such as a menuitem inside a menu or a tab inside a tablist.', 'Or remove the role from the item if it is not part of such a widget.']),
  'rule:aria-roles': f(['Fix the misspelled or made-up role value, or use the HTML element that has the role.', 'Remove the role if the element is only for layout.']),
  'rule:aria-tab-name': f(NAME_STEPS('tab', 'its visible text, or an aria-label'), nameOnTag(['*'], '[tab name]'), ['ARIA14']),
  'rule:aria-toggle-field-name': f(NAME_STEPS('checkbox, switch or radio button', 'a visible label tied to it, or an aria-label'), nameOnTag(['*'], '[what it turns on]'), ['ARIA14']),
  'rule:aria-tooltip-name': f(['Give each tooltip text inside it, or an aria-label.', 'Tie it to its control with aria-describedby.'], nameOnTag(['*'], '[tooltip text]'), ['ARIA14']),
  'rule:aria-valid-attr': f(['Fix the misspelled ARIA attribute name (for example aria-labeledby is aria-labelledby).', 'Remove ARIA attributes that do not exist.']),
  'rule:aria-valid-attr-value': f(['Give each ARIA attribute an allowed value: true or false for states, and an id that exists on the page for references.', 'Update the value from the script whenever the control changes.']),
  'rule:autocomplete-valid': f(['Change each autocomplete value to one of the standard tokens, such as name, email, tel or street-address.', 'Use autocomplete="off" only where the browser should not fill in anything.']),
  'rule:avoid-inline-spacing': f(['Remove !important from inline letter-spacing, word-spacing and line-height, so readers can widen the spacing.', 'Move the spacing into the site stylesheet.'], avoidInlineSpacing, ['C36']),
  'rule:blink': f(['Remove the blink element and show its text as normal text.', 'If it must draw attention, use a static color or an icon instead.'], marqueeToText, ['F47']),
  'rule:button-name': f(NAME_STEPS('button', 'text inside it, or an aria-label on icon-only buttons'), nameOnTag(['button'], '[what it does]'), ['ARIA6', 'ARIA14']),
  'rule:bypass': f(['Add a “Skip to main content” link as the first thing on every page, pointing to the main content.', 'Mark the main content with a main element (or a heading people can jump to).', 'Make the skip link visible when it gets keyboard focus.'], skipLink, ['G1']),
  'rule:color-contrast': f(['Change the text color or its background until the contrast is at least 4.5:1, or 3:1 for large text.', 'Change the color in the site stylesheet, so every page that uses it is fixed at once.'], colorFix('color'), ['G18', 'G145']),
  'rule:css-orientation-lock': f(['Remove the CSS that locks the layout to portrait or landscape (an orientation media query that rotates or hides the page).', 'Let the page lay itself out for whichever way the device is held.']),
  'rule:definition-list': f(['Put only dt and dd pairs (or div groups of them) directly inside each dl.', 'Move any other content out of the list.'], () => ({ source: 'pattern', language: 'html', before: [], after: ['<dl>', '  <dt>Office hours</dt>', '  <dd>8 am to 3 pm</dd>', '</dl>'] }), ['H40']),
  'rule:dlitem': f(['Put each dt and dd inside a dl element.', 'Or use paragraphs or a list if it is not a list of terms and descriptions.'], () => ({ source: 'pattern', language: 'html', before: [], after: ['<dl>', '  <dt>Office hours</dt>', '  <dd>8 am to 3 pm</dd>', '</dl>'] }), ['H40']),
  'rule:document-title': f(['Give every page a title element that says what the page is, then the site name.', 'Set it in the page template, so new pages get one too.'], () => ({ source: 'pattern', language: 'html', before: ['<head>'], after: ['<head>', '  <title>[Page name] | [Site name]</title>'] }), ['H25']),
  'rule:duplicate-id-aria': f(['Give every element an id that is unique on the page.', 'Update the aria-labelledby, aria-describedby and label for references to the new ids.']),
  'rule:form-field-multiple-labels': f(['Keep one label element per field.', 'Put extra hints in a separate element tied to the field with aria-describedby.']),
  'rule:frame-focusable-content': f(['Remove tabindex="-1" from frames that hold links, buttons or fields, so keyboard users can reach them.', 'Or take the frame out if its content is not meant to be used.']),
  'rule:frame-title': f(['Give each embedded frame a title attribute that says what it shows.', 'Set it where the embed code is pasted (map, video, form or calendar).'], addAttrTo(['iframe', 'frame'], 'title', '[what the frame shows]', '<iframe src="…" title="[what the frame shows]"></iframe>'), ['H64']),
  'rule:frame-title-unique': f(['Give each embedded frame on the page a different title that says what it shows.', 'Set it where the embed code is pasted.']),
  'rule:html-has-lang': f(['Add a lang attribute to the html element in the page template, with the page’s main language code (en for English, es for Spanish).', 'Set it once in the template so every page has it.'], htmlLang, ['H57']),
  'rule:html-lang-valid': f(['Change the html element’s lang to a real language code, such as en or es.', 'Set it once in the page template.'], (ex) => {
    // A language written as its name (lang="english") is known; otherwise a placeholder, never a guess.
    const tag = tagOf(ex);
    const value = tag?.name === 'html' ? tag.attrs.find((a) => a.name === 'lang')?.value.trim().toLowerCase() ?? '' : '';
    const code = LANGS[value];
    const after = tag?.name === 'html' ? withAttr(tag, 'lang', code ?? LANG_PLACEHOLDER) : null;
    return after ? { source: 'page', language: 'html', before: [tag!.raw], after: [after] } : { source: 'pattern', language: 'html', before: [], after: [`<html lang="${LANG_PLACEHOLDER}">`] };
  }, ['H57']),
  'rule:html-xml-lang-mismatch': f(['Make the html element’s xml:lang the same as its lang, or remove xml:lang.', 'Set both in the page template, so every page agrees.'], xmlLang, ['H57']),
  'rule:image-alt': f(['Give each picture an alt attribute that says what it shows, in a short phrase.', 'For a picture that is only decoration, use an empty alt (alt="") so screen readers skip it.', 'Write the words of any text that is part of the picture into the alt.'], imgAlt, ['H37', 'H67']),
  'rule:input-button-name': f(['Give each input button a value attribute that says what it does.', 'Use the same words people see on the button.'], inputButtonValue, ['H91']),
  'rule:input-image-alt': f(['Give each image button an alt attribute that says what the button does, not what the picture looks like.', 'Use the words on the button image, if it shows any.'], addAttrTo(['input'], 'alt', '[what the button does]', '<input type="image" src="…" alt="[what the button does]">'), ['H36']),
  'rule:label': f(['Give each field a visible label element tied to it with for and id (or wrapping it).', 'Keep the label text short and say what to enter.', 'Don’t rely on placeholder text alone: it disappears when people type.'], labelField, ['H44']),
  'rule:label-content-name-mismatch': f(['Remove the aria-label so the control is named by its visible words.', 'Or start the aria-label with exactly the words on screen.'], (ex) => {
    const tag = tagOf(ex);
    if (!tag || !tag.attrs.some((a) => a.name === 'aria-label') || !visibleText(tag.rest)) return null;
    return { source: 'page', language: 'html', before: [tag.raw], after: [withoutAttrs(tag, (a) => a.name === 'aria-label')] };
  }, ['G208']),
  'rule:link-in-text-block': f(['Underline links inside paragraphs and lists in the site stylesheet.', 'Or give them a 3:1 contrast with the text around them and an underline on hover and focus.'], linkUnderline, ['G182', 'G183']),
  'rule:link-name': f(['Give each link text that says where it goes.', 'For a link that is only an image or icon, put that text in the image’s alt or the link’s aria-label.'], nameOnTag(['a'], '[where the link goes]'), ['ARIA8', 'H30']),
  'rule:list': f(['Put only li elements directly inside each ul and ol.', 'Move other content (a div, a heading, a paragraph) into a list item or out of the list.'], () => ({ source: 'pattern', language: 'html', before: ['<ul>', '  <div>…</div>', '  <li>…</li>', '</ul>'], after: ['<p>…</p>', '<ul>', '  <li>…</li>', '</ul>'] }), ['H48']),
  'rule:listitem': f(['Put each li inside a ul or ol.', 'If the item is not part of a list, make it a paragraph.'], () => ({ source: 'pattern', language: 'html', before: ['<li>…</li>'], after: ['<ul>', '  <li>…</li>', '</ul>'] }), ['H48']),
  'rule:marquee': f(['Replace the scrolling marquee with normal text.', 'If the content must move, add a pause button next to it.'], marqueeToText, ['F16']),
  'rule:meta-refresh': f(['Remove the meta refresh that reloads or redirects the page after a delay.', 'Redirect on the server instead, or give people a link to go on when they are ready.'], metaRefresh, ['SVR1', 'F41']),
  'rule:meta-viewport': f(['Remove user-scalable=no and maximum-scale from the viewport tag in the page template.', 'Let people zoom to at least 200%.'], viewport, ['G142']),
  'rule:nested-interactive': f(['Take the link or button out of the other control, so each control stands alone.', 'If the outer element is only a container, remove its role or tabindex.']),
  'rule:no-autoplay-audio': f(['Stop audio from playing by itself: remove autoplay.', 'Show the player’s controls so people can start it when they want.'], autoplayAudio, ['G171']),
  'rule:object-alt': f(['Put a text alternative inside each object element, saying what it shows.', 'Or add an aria-label to the object.'], () => ({ source: 'pattern', language: 'html', before: [], after: ['<object data="…" type="…">[what it shows, with a link to download it]</object>'] }), ['H53']),
  'rule:p-as-heading': f(['Make text that works as a heading a real heading (h2, h3…) at the right level.', 'Style the heading in the stylesheet instead of making a paragraph bold.'], paragraphHeading, ['H42']),
  'rule:role-img-alt': f(['Give each element with role="img" an aria-label that says what the picture shows.', 'If the picture is only decoration, use role="presentation" instead.'], nameOnTag(['*'], '[what the picture shows]'), ['ARIA6']),
  'rule:scrollable-region-focusable': f(['Let keyboard users reach each scrolling box: add tabindex="0", role="region" and an aria-label.', 'Or remove the fixed height so the content does not scroll inside a box.'], scrollRegion, ['G202']),
  'rule:select-name': f(['Give each drop-down list a visible label element tied to it with for and id.', 'Keep the label short and say what to choose.'], labelField, ['H44']),
  'rule:server-side-image-map': f(['Replace the server-side image map with ordinary links (or a client-side map with an alt on each area).', 'Make sure every area can be reached and used with a keyboard.']),
  'rule:summary-name': f(['Put text inside each summary element that says what the section opens.', 'Keep the words short, such as the section’s heading.']),
  'rule:svg-img-alt': f(['Give each svg with role="img" an aria-label (or a title element inside it) that says what it shows.', 'If the graphic is only decoration, add aria-hidden="true" instead.'], nameOnTag(['svg'], '[what the picture shows]'), ['ARIA6']),
  'rule:table-fake-caption': f(['Put the table’s title in a caption element, instead of a first row that spans the table.', 'Remove the spanning first row once the caption holds its words.'], () => ({ source: 'pattern', language: 'html', before: [], after: ['<table>', '  <caption>[what the table shows]</caption>', '  …', '</table>'] }), ['H39']),
  'rule:target-size': f(['Make each button and link at least 24 by 24 pixels, or leave that much space around it.', 'Change it in the stylesheet, so every copy of the control is fixed.'], targetSize, ['C42']),
  'rule:td-has-header': f(['Mark the header row (and first column, if it labels rows) with th elements.', 'Add scope="col" to column headers and scope="row" to row headers.'], () => ({ source: 'pattern', language: 'html', before: ['<tr><td>Date</td><td>Event</td><td>Time</td></tr>'], after: ['<tr><th scope="col">Date</th><th scope="col">Event</th><th scope="col">Time</th></tr>'] }), ['H51', 'H63']),
  'rule:td-headers-attr': f(['Make each headers attribute list only ids of th cells in the same table.', 'For a simple table, remove headers and use scope on the th cells instead.']),
  'rule:th-has-data-cells': f(['Remove header cells that label nothing, or fill in the data they label.', 'If the table is only for layout, use other elements instead of a table.']),
  'rule:valid-lang': f(['Change each lang attribute to a real language code, such as es for Spanish.', 'Use the two-letter code of the language the passage is written in.'], partLang, ['H58']),
  'rule:video-caption': f(['Add a captions file to each video (a WebVTT file linked with a track element), or use a captioned copy.', 'Write or review the captions; don’t publish automatic ones unchecked.'], captionTrack, ['H95']),

  // ---- test criteria (criterion-level; probe-specific overrides below)
  'criterion:1.2.1': f(['Put a transcript next to each audio recording.', 'For a video with no sound, add a text description of what it shows.'], transcriptLink, ['G158']),
  'criterion:1.2.2': f(['Turn on captions for each video, from a captions file you wrote or checked.', 'On YouTube or Vimeo, upload the captions file instead of relying on automatic captions.'], captionTrack, ['H95']),
  'criterion:1.2.3': f(['Add audio description (narration of what is shown), or put a full text version of the video next to it.', 'Name people, on-screen text and actions that are shown but never said.']),
  'criterion:1.2.4': f(['Turn on live captions for each live stream, from a captioner or the platform’s live captioning.', 'Test the captions before the stream starts.']),
  'criterion:1.2.5': f(['Add audio description for each video: narration of names, text and actions shown but never said.', 'Or publish a version of the video that describes them in its own narration.']),
  'criterion:1.3.1': f(['Mark up headings, lists, tables and form groups with the matching HTML elements, not just styling.', 'Check the heading outline and the form labels in the page editor.']),
  'criterion:1.3.2': f(['Put the content in the code in the same order it reads on screen.', 'Avoid reordering with CSS (order, absolute positioning) where the order matters.']),
  'criterion:1.3.4': f(['Remove the code that locks the page to portrait or landscape.', 'Let the layout adapt to the way the device is held.']),
  'criterion:1.3.5': f(['Add the autocomplete attribute to fields that ask for the person’s own details (name, email, phone, address).', 'Use the standard token for each, such as autocomplete="email".'], autocomplete, ['H98']),
  'criterion:1.4.1': f(['Underline links inside running text, or add another cue than color.', 'Keep the cue on hover and focus.'], linkUnderline, ['G182']),
  'criterion:1.4.2': f(['Don’t start sound by itself: remove autoplay.', 'If it must play, stop it within 3 seconds or put a pause or mute button at the top of the page.'], autoplayAudio, ['G171', 'G170']),
  'criterion:1.4.3': f(['Change the text color or its background until the contrast is at least 4.5:1, or 3:1 for large text.', 'Change it in the site stylesheet.'], colorFix('color'), ['G18', 'G145']),
  'criterion:1.4.4': f(['Size text in rem or em, not in viewport units alone, so it grows when people zoom.', 'Remove fixed heights that cut off enlarged text.'], () => ({ source: 'pattern', language: 'css', before: ['font-size: 8vw;'], after: ['font-size: clamp(2.5rem, 1.5rem + 5vw, 7rem);'] }), ['C14']),
  'criterion:1.4.10': f(['Let content wrap at narrow widths: no fixed widths, and wide tables in a box that scrolls on its own.', 'Check each page at 320 pixels wide.']),
  'criterion:1.4.11': f(['Change field borders, icon colors and focus outlines until they have 3:1 contrast with what is next to them.', 'Change them in the site stylesheet.'], colorFix('border-color'), ['G209']),
  'criterion:1.4.12': f(['Remove fixed heights and overflow: hidden from text boxes, so text can grow when spacing is widened.', 'Let buttons and labels wrap instead of cutting text off.'], () => ({ source: 'pattern', language: 'css', before: ['.card p { height: 3em; overflow: hidden; }'], after: ['.card p { min-height: 3em; }'] }), ['C36']),
  'criterion:1.4.13': f(['Let people close pop-ups that appear on hover or focus with Escape, without moving the pointer.', 'Keep the pop-up open while the pointer is over it, until people move away.']),
  'criterion:2.1.1': f(['Use a real button or link for each control, instead of a clickable div or span.', 'If a custom control must stay, add tabindex="0", a role and Enter and Space key handlers.'], clickableToButton, ['H91', 'F54']),
  'criterion:2.1.2': f(['Remove the script that holds keyboard focus in the element, so Tab and Shift+Tab move on.', 'If a dialog keeps focus on purpose, let Escape close it and return focus to where it was.']),
  'criterion:2.1.4': f(['Let people turn single-key shortcuts off, or change them to use Ctrl, Alt or another modifier.', 'Or make them work only while the control they belong to has focus.']),
  'criterion:2.2.1': f(['Turn off the time limit, or let people set it to at least ten times the default before it starts.', 'Or warn people before it ends and let them extend it with one simple action, at least ten times.', 'Give at least 20 seconds to answer the warning.']),
  'criterion:2.2.2': f(['Give anything that moves, blinks or scrolls by itself for more than 5 seconds a visible pause, stop or hide button.', 'Give anything that updates by itself a way to pause, stop or hide it, or to choose how often it updates.', 'You can also stop the movement for people who ask for reduced motion, as well as the button, not instead of it.']),
  'criterion:2.3.1': f(['Remove the flashing, or slow it to no more than three flashes in any one second.', 'Make large flashing areas smaller, or reduce their brightness change.']),
  'criterion:2.4.1': f(['Add a “Skip to main content” link as the first thing on every page.', 'Point it at the main content and make it visible when it gets focus.'], skipLink, ['G1']),
  'criterion:2.4.3': f(['Remove positive tabindex values (tabindex="1" and up), so focus follows the page order.', 'Put the code in the same order as the page reads, so Tab moves top to bottom.']),
  'criterion:2.4.4': f(['Rewrite links like “Click here” or “Read more” to say where they go.', 'Or put the link inside a sentence or list item that says it.'], linkText, ['G91', 'H30']),
  'criterion:2.4.6': f(['Rewrite headings and labels so each says what its section or field is about.', 'Give sections and fields different names when they do different things.']),
  'criterion:2.4.7': f(['Add a visible focus outline for every link, button and field in the site stylesheet.', 'Never remove the outline (outline: none) without putting another visible style in its place.'], focusVisible, ['C45', 'C40']),
  'criterion:2.4.11': f(['Add scroll padding the height of the fixed header (or banner), so focused items scroll into view below it.', 'Or make the fixed box smaller, or let it scroll away.'], scrollPadding, ['C43']),
  'criterion:2.5.1': f(['Give every action that needs a pinch, swipe or path gesture a single-tap alternative, such as buttons.', 'Keep the gesture as well, for people who use it.']),
  'criterion:2.5.2': f(['Start actions when the pointer is released (click), not when it goes down (mousedown or pointerdown).', 'Or let people cancel by moving away before they let go.']),
  'criterion:2.5.4': f(['Give every action set off by shaking or tilting a button that does the same thing.', 'Let people turn motion actions off.']),
  'criterion:2.5.7': f(['Give each drag action a single-tap alternative, such as buttons to move a slider step by step or to reorder items.', 'Keep the drag as well, for people who use it.']),
  'criterion:3.2.1': f(['Don’t change the page, open a window or move focus when a control merely gets focus.', 'Wait for a click, Enter or a submit button.']),
  'criterion:3.2.2': f(['Don’t submit the form or change the page when a field’s value changes.', 'Add a button that applies the choice, or say beforehand what will happen.']),
  'criterion:3.3.1': f(['When a form is sent with a mistake, write the error in text next to the field.', 'Tie the message to the field with aria-describedby and mark it with aria-invalid="true".', 'Don’t show errors by color alone.'], errorText, ['ARIA21', 'G83']),
  'criterion:3.3.2': f(['Give each field a visible label, and say which fields are required and what format they need.', 'Show the format a field needs (such as MM/DD/YYYY) before people type.'], labelField, ['H44']),
  'criterion:3.3.3': f(['Say in the error message how to fix the mistake, such as the right format or an example.', 'Keep what people typed, so they only change the part that was wrong.']),
  'criterion:3.3.4': f(['Before a form with legal, money or data consequences is sent, show a review step where people can check, correct and then confirm what they entered.', 'Or make the submission reversible, so people can undo it afterwards.', 'Or check what people enter for mistakes and let them correct them before it goes through.']),
  'criterion:3.3.7': f(['Fill in information people already entered earlier in the same process, or let them pick it.', 'Don’t ask for the same details twice.']),
  'criterion:3.3.8': f(['Allow pasting and password managers in sign-in fields: remove scripts that block paste.', 'Mark the fields with autocomplete="username" and "current-password".'], passwordPaste, ['H100']),
  'criterion:4.1.2': f(['Give each custom control a name, a role and a state screen readers can read.', 'Prefer native HTML elements (button, input, select), which have them built in.']),
  'criterion:4.1.3': f(['Put status and error messages in a live region (role="status", or role="alert" for errors), so screen readers announce them.', 'Add the live region to the page before the message appears.'], statusMessage, ['ARIA22', 'ARIA19']),

  // ---- the same criteria as one test finds them (PROBE_CRITERION pairs whose fix differs)
  'probe:keyboard:1.4.11': f(['Make the focus outline stand out: 3:1 contrast with the colors next to it.', 'Use one focus style for every link, button and field in the site stylesheet.'], focusVisible, ['C40', 'G195']),
  'probe:keyboard-deep:1.4.11': f(['Make the focus outline stand out: 3:1 contrast with the colors next to it.', 'Use one focus style for every link, button and field in the site stylesheet.'], focusVisible, ['C40', 'G195']),
  'probe:forced-colors:1.4.3': f(['Let text keep the system colors in Windows contrast themes: don’t draw it with background images or forced-color-adjust: none.', 'Test the page with a Windows contrast theme on.']),
  'probe:forced-colors:1.4.11': f(['Draw icons with currentColor (or an svg fill of currentColor), so they follow the contrast theme.', 'Don’t use background images for icon-only controls.'], () => ({ source: 'pattern', language: 'css', before: ['.icon { fill: #555; }'], after: ['.icon { fill: currentColor; }'] }), ['G207']),
  'probe:forced-colors:2.4.7': f(['Draw the focus indicator with outline, which Windows contrast themes keep, not with box-shadow alone.', 'Test it with a Windows contrast theme on.'], focusVisible, ['C40', 'C45']),
  'probe:overlays:1.4.10': f(['On narrow screens and when zoomed, shrink floating boxes (chat, cookie banners) to a small button, or let them scroll with the page.', 'Make sure nothing fixed covers more than a small part of the screen at 320 pixels wide.']),
  'probe:overlays:2.4.11': f(['Keep fixed boxes (chat, banners) from covering focused items: make the box smaller on narrow screens, or let it scroll away.', 'Or add scroll padding the height of the box, so focused items scroll clear of it.']),
  'probe:form-fields:1.3.1': f(['Tie each field’s visible label to it (label for and id), and group related fields in a fieldset with a legend.', 'Use the label element rather than text placed next to the field.'], labelField, ['H44', 'H71']),
  'probe:form-fields:3.3.2': f(['Give each field a visible label, and say which fields are required.', 'Show the format a field needs before people type.'], labelField, ['H44']),
  'probe:form-fields:3.3.4': f(['Before the form is sent, show a review step where people can check, correct and then confirm what they entered.', 'Or make the submission reversible, so people can undo it afterwards.', 'Or check what people enter for mistakes and let them correct them before it goes through.']),
  'probe:screen-reader:1.3.1': f(['Mark up headings, lists and tables with the matching HTML, so screen readers announce them.', 'Remove heading markup from text that isn’t a heading.']),
  'probe:screen-reader:1.3.2': f(['Put the content in the code in the order it reads on screen.', 'Avoid reordering with CSS (order, absolute positioning) where the order matters.']),
  'probe:screen-reader:2.4.4': f(['Give links words that say where they go, so they make sense in a list of links.', 'Or put the link inside a sentence or list item that says it.'], linkText, ['G91']),
  'probe:screen-reader:4.1.2': f(['Give each control a name screen readers can read: visible text, a label, or an aria-label.', 'Use native HTML elements where you can.']),
  'probe:aria-states:4.1.2': f(['Keep each control’s state attribute (aria-expanded, aria-pressed, aria-checked) in step with what is on screen.', 'Update it from the same script that opens, closes or toggles the control.'], expandedState, ['ARIA5']),
  'probe:headings:1.3.1': f(['Put the section title in every heading, or remove the empty heading.', 'Mark up paragraphs as paragraphs and change how text looks with styles instead.']),
  'probe:heading-levels:1.3.1': f(['Put this heading at the level that matches its place in the outline (one below the section it belongs to).', 'Change its look with styles, not by picking another heading level.'], headingLevel, ['H42', 'G141']),
  'probe:headings:2.4.6': f(['Rewrite headings so each says what its section is about.', 'Give sections with different content different headings.']),
  'probe:screen-reader-live:3.3.1': f(['When a form is sent with a mistake, write the error in text and announce it.', 'Tie each message to its field with aria-describedby.'], errorText, ['ARIA21', 'G83']),
  'probe:screen-reader-live:4.1.2': f(['Give each control that changes the page a name and a state screen readers can read.', 'Prefer native HTML elements (button, input, select), which have them built in.']),
  'probe:flash-motion:2.3.1': f(['Remove the flashing, or slow it to no more than three flashes in any one second.', 'Make large flashing areas smaller, or reduce their brightness change.']),
  'probe:media-players:1.2.1': f(['Put a transcript next to each audio player.', 'For a video with no sound, add a text description of what it shows.'], transcriptLink, ['G158']),
  // Batch 17: a page's own video with speech and no captions track (the media-files test): the media rule's fix, not the platform step.
  'probe:media-files:1.2.2': f(['Write or get a captions file (WebVTT) for the video.', 'Link it with a track element (kind "captions"), or replace the video with a captioned copy.'], captionTrack, ['H95']),

  // ---- batch 15b's tests (listed, not scored), joined with Report v3 in 0.2.0
  'probe:page-titles:2.4.2': f(['Give each page its own title that says what the page is, then the site name.', 'Set it in the page template from the page’s main heading, so no two pages share a title.']),
  'probe:route-titles:2.4.2': f(['When the site shows a new view without loading a page, change the page title to name that view.', 'Set it in the same code that changes the address and the main heading.']),
  'probe:language-parts:3.1.1': f(['Set the html element’s lang to the language the page is written in, such as es for a page in Spanish.', 'Set it in the page template, and give each language version of a page its own lang.']),
  'probe:language-parts:3.1.2': f(['Mark each passage in another language with a lang attribute on its element, such as lang="es".', 'Use the two-letter code of the passage’s language.']),
  'probe:names:1.1.1': f(['Replace alt text that is a file name or a placeholder (such as “image” or “IMG_0412.jpg”) with words that say what the picture shows.', 'For a picture that is only decoration, use an empty alt (alt="") so screen readers skip it.']),
  // Batch 17: the picture test (SVG pictures' own words; flagged for review in batch 17). No criterion copy exists for these two.
  'probe:picture-text:1.1.1': f(['Put the words the picture shows into its alt text, or publish them as real text next to it.', 'Give a notice or an instruction that is only a picture real alt text, not an empty alt or a word such as “Map”.']),
  'probe:picture-text:1.4.5': f(['Publish the words in the picture as real text on the page.', 'Keep the picture only as an illustration, with a short alt.']),
  'probe:names:2.5.3': f(['Start each control’s accessible name (its aria-label or label) with the words shown on it.', 'Or remove the aria-label, so the words on screen name the control.']),

  // ---- batch 16's tests
  'probe:pointer-gestures:2.1.1': f(['Let people put the list in order with the keyboard: give each item a Move up and a Move down button.', 'Or let each item take focus and move with the arrow keys, and announce its new place in a live region.', 'Keep the drag as well, for people who use it.']),

  // ---- cross-page rules
  'consistency:2.4.5': f(['Add a site search, or a site map page linked from every page.', 'Make sure every page is reachable from it, not only from the menu.']),
  'consistency:3.2.3': f(['Build the menu, header and footer from one shared template, so links stay in the same order on every page.', 'Add new links in the same place on every page.']),
  'consistency:3.2.4': f(['Give links, buttons and icons that do the same job the same name on every page.', 'Keep icons and their text labels the same too.']),
  'consistency:3.2.6': f(['Put contact details, chat and other help in the same place and order on every page that has them.', 'Use one shared header or footer for them.']),

  // ---- media rules
  'media:autoplay-sound-no-controls': f(['Don’t start the audio by itself: remove autoplay and loop.', 'Show the player’s controls, so people choose when to play it.'], autoplayAudio, ['G171']),
  'media:no-captions-track': f(['Write or get a captions file (WebVTT) for the video.', 'Link it with a track element (kind "captions"), or replace the video with a captioned copy.'], captionTrack, ['H95']),
  'media:uploader-captions-missing': f(['Upload a captions file you wrote or checked to the video on its host (YouTube, Vimeo).', 'Don’t rely on automatic captions: check them before you publish.']),

  // ---- gated AI checks (their own wording where the fix differs from the test's)
  'ai:altText:1.1.1': f(['Write the picture’s key information into its alt text, or put it as text next to the picture.', 'Keep alt text short; put long details, every one of them, in the text next to it.'], aiAltText, ['H37', 'G94', 'G92']),
  'ai:altText:1.4.5': f(['Publish the words in the picture as real text on the page.', 'Keep the picture only as an illustration, with a short alt.']),
  'ai:vision:1.4.1': f(['Add a second cue to anything shown by color alone: text, an icon, a pattern or an underline.', 'Keep the color as well, for people who use it.']),
  'ai:vision:1.3.2': f(['Put the content in the code in the order it reads on screen.', 'Avoid reordering with CSS (order, absolute positioning) where the order matters.']),
  'ai:vision:1.1.1': f(['Describe each picture that carries information in its alt text, or in the text next to it.', 'Use an empty alt only for pictures that are pure decoration.'], imgAlt, ['H37']),
  'ai:vision:4.1.2': f(['Give each control that looks like a button or field a real role and a name: use the native HTML element.', 'If a custom control must stay, give it a role, a name and keyboard support.']),
  'ai:forms:3.3.4': f(['Before the form is sent, show a review step where people can check, correct and then confirm what they entered.', 'Or make the submission reversible, so people can undo it afterwards.', 'Or check what people enter for mistakes and let them correct them before it goes through.']),
  'ai:forms:1.3.5': f(['Add the autocomplete attribute to fields that ask for the person’s own details, with the standard token (name, email, tel).', 'Use the field type that matches too, such as type="email".'], autocomplete, ['H98']),
  'ai:forms:3.3.3': f(['Say in each error message how to fix the mistake, such as the right format or an example.', 'Keep what people typed, so they only change the part that was wrong.']),
  'ai:pageText:2.4.2': f(['Rewrite the page title so it says what this page is, then the site name.', 'Set it in the page template, so every page gets its own title.'], () => ({ source: 'pattern', language: 'html', before: ['<title>Home</title>'], after: ['<title>[What this page is] | [Site name]</title>'] }), ['H25', 'G88']),
  'ai:pageText:2.4.4': f(['Rewrite the link so its words (or its sentence) say where it goes.', 'Or put the link inside a sentence or list item that says it.'], linkText, ['G91']),
  'ai:pageText:2.4.6': f(['Rewrite the heading or label so it says what the section or field is about.', 'Give sections and fields that do different things different names.']),
  'ai:pageText:3.3.2': f(['Add instructions next to the field: what to enter, and the format if one is needed.', 'Mark which fields are required, in words, not only with color.']),
  'ai:pageText:1.3.3': f(['Rewrite instructions that rely on shape, position, size or sound (“the round button on the right”) to name the thing.', 'Keep the visual cue as well, for people who use it.']),
  'ai:pageText:3.1.2': f(['Mark the passage in another language with a lang attribute on its element, such as lang="es".', 'Use the two-letter code of the passage’s language.']),
  'ai:pageText:1.3.1': f(['Mark up the text that looks like a heading, list or table with the matching HTML.', 'Use the editor’s heading and list styles, not bold or bullets typed by hand.']),
  'ai:consistency:3.2.4': f(['Give links and buttons that do the same job the same name on every page.', 'Keep icons and their text labels the same too.']),
  'ai:media:1.2.1': f(['Put a transcript next to the recording, or a text description next to a silent video.', 'Link the transcript right next to the player.'], transcriptLink, ['G158']),
  'ai:media:1.2.2': f(['Turn on captions you wrote or checked for the video.', 'Upload the captions file to the video host if it is embedded.']),
  'ai:media:1.2.3': f(['Add audio description, or a full text version of the video next to it.', 'Name people, on-screen text and actions that are shown but never said.']),
  'ai:focusOrder:2.4.3': f(['Put the code in the order the page reads, and remove positive tabindex values, so Tab moves in a sensible order.', 'Put dialogs and menus in the code right after the control that opens them.']),
  'ai:listener:1.3.2': f(['Put the content in the code in the order it reads on screen.', 'Avoid reordering with CSS (order, absolute positioning) where the order matters.']),
  'ai:listener:1.1.1': f(['Give the picture or icon a text alternative that says what it shows or does.', 'Use an empty alt only for pictures that are pure decoration.'], imgAlt, ['H37']),
  'ai:listener:1.3.1': f(['Mark up headings, lists and tables with the matching HTML, so screen readers announce them.', 'Remove heading markup from text that isn’t a heading.']),
  'ai:listener:4.1.2': f(['Give the control a name and role screen readers can read: use the native HTML element, or add a label.', 'Check the name in the browser’s accessibility panel.']),
  'ai:listener:2.4.4': f(['Give the link words that say where it goes.', 'Or put the link inside a sentence or list item that says it.'], linkText, ['G91']),
  'ai:listener:2.4.6': f(['Rewrite the heading or label so it says what the section or field is about.', 'Give sections and fields that do different things different names.']),
  'ai:listener:4.1.3': f(['Put the message in a live region (role="status") so screen readers announce it.', 'Add the live region to the page before the message appears.'], statusMessage, ['ARIA22']),

  // ---- documents: one entry per PDF quick check and per AI document criterion, and per Office check
  'pdf:tagged': f(['Turn on tags when exporting (in Word: Save as PDF, Options, “Document structure tags for accessibility”).', 'Use real headings, lists and table header rows in the source file first.']),
  'pdf:hasTitle': f(['Set a title in the source file’s properties (File, Info, Title).']),
  'pdf:showsTitle': f(['Set the PDF to show its title in the reader’s title bar, not the file name (in Acrobat: Document Properties, Initial View, Show Document Title; DisplayDocTitle).']),
  'pdf:hasLanguage': f(['Set the document language in the source file before exporting (in Word: Review, Language).']),
  'pdf:imageOnly': f(['Run text recognition (OCR) on the scanned pages, correct the text it finds, then tag the result.', 'Better: publish the original file the scan was made from.']),
  'pdf:figuresWithoutAlt': f(['Write alt text for each picture in the source file (right-click the picture, Edit Alt Text) before exporting.']),
  'pdf:untitledFormFields': f(['Give every form field a name (tooltip) that matches its visible label.']),
  'pdf:xfa': f(['Replace the XFA form with a web form, or a tagged PDF form made in Acrobat.']),
  'pdf:blocksAssistiveTech': f(['Turn off the security setting that stops screen readers from reading the text (allow content copying for accessibility).']),
  'pdf-ai:1.1.1': f(['Describe each picture that carries information in its alt text, in the source file.']),
  'pdf-ai:1.3.1': f(['Fix the tags so headings, lists and tables match what the page shows.']),
  'pdf-ai:1.3.2': f(['Fix the tag order so the PDF reads in the order the page shows, column by column.']),
  'pdf-ai:1.4.5': f(['Put the words that are only in pictures into the document as real text.']),
  'pdf-ai:3.3.2': f(['Add a visible label or instructions to each form field.']),
  'office:password': f(['Remove the password that is needed to open the file, or publish the content as a web page.']),
  'office:alt': f(['Write alt text for each picture (right-click, Edit Alt Text), or mark it as decorative.']),
  'office:slideTitle': f(['Give every slide a title, in the slide’s title placeholder.']),
  'office:language': f(['Set the document language (Review, Language).']),
  'office:title': f(['Set a title in the file’s properties (File, Info, Title).']),
});

/**
 * The document fixes as short phrases, for a step that lists several: work in the source file ("use real
 * headings…") and settings ("Set a title…, the document language…").
 */
export const DOCUMENT_STEP: Readonly<Record<string, { group: 'source' | 'settings'; text: string }>> = Object.freeze({
  'pdf:tagged': { group: 'source', text: 'use real headings, lists and table header rows' },
  'pdf:figuresWithoutAlt': { group: 'source', text: 'write alt text for each picture' },
  'pdf:untitledFormFields': { group: 'source', text: 'give every form field a name that matches its label' },
  'pdf:xfa': { group: 'source', text: 'replace the XFA form with a web form or a tagged PDF form' },
  'pdf-ai:1.1.1': { group: 'source', text: 'describe each picture that carries information' },
  'pdf-ai:1.3.1': { group: 'source', text: 'fix the tags so they match what the pages show' },
  'pdf-ai:1.3.2': { group: 'source', text: 'fix the tag order so it matches the reading order' },
  'pdf-ai:1.4.5': { group: 'source', text: 'put words that are only in pictures into real text' },
  'pdf-ai:3.3.2': { group: 'source', text: 'label each form field' },
  'office:alt': { group: 'source', text: 'write alt text for each picture' },
  'office:slideTitle': { group: 'source', text: 'give every slide a title' },
  'pdf:hasTitle': { group: 'settings', text: 'a title in the file’s properties' },
  'pdf:hasLanguage': { group: 'settings', text: 'the document language' },
  'pdf:showsTitle': { group: 'settings', text: 'the PDF to show its title instead of the file name' },
  'pdf:blocksAssistiveTech': { group: 'settings', text: 'security that lets screen readers read the text' },
  'office:title': { group: 'settings', text: 'a title in the file’s properties' },
  'office:language': { group: 'settings', text: 'the document language' },
  'office:password': { group: 'settings', text: 'no password to open it' },
});

/** Fix keys that use another key's copy on purpose (the same fix, found another way). */
export const FIX_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  'media:1.2.2': 'media:no-captions-track',
  'media:1.4.2': 'media:autoplay-sound-no-controls',
  'probe:audio:1.4.2': 'criterion:1.4.2',
  'probe:flash:2.3.1': 'criterion:2.3.1',
  'probe:timing-watch:2.2.1': 'criterion:2.2.1',
  'probe:keyboard-deep:2.1.2': 'criterion:2.1.2',
  'probe:keyboard-deep:2.4.3': 'criterion:2.4.3',
  'probe:keyboard-deep:2.4.7': 'criterion:2.4.7',
  'probe:keyboard-deep:2.4.11': 'criterion:2.4.11',
  'probe:keyboard-deep:3.2.1': 'criterion:3.2.1',
  'probe:forms:4.1.3': 'criterion:4.1.3',
  'probe:screen-reader-live:4.1.3': 'criterion:4.1.3',
});

/** Generic steps for a test the library doesn't know (a newer axe rule): never shown for a producible one (coverage test). */
export const GENERIC_FIX: FixCopy = f(['Fix the element the scan found, following the problem’s description.', 'Ask your web developer or CMS vendor if the element is part of a theme or plugin.']);

const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

/**
 * The copy for a fix key, with fallbacks: `probe:<probe>:<criterion>` falls back to `criterion:<criterion>`;
 * `third-party:<id>` to `rule:<id>`; `ai:<check>:<criterion>` to `criterion:<criterion>`; anything else to
 * GENERIC_FIX. `resolved` says which entry answered (the coverage test).
 */
export function fixFor(key: string): { copy: FixCopy; resolved: string } {
  const alias = own(FIX_ALIASES, key) ? FIX_ALIASES[key]! : key;
  if (own(FIXES, alias)) return { copy: FIXES[alias]!, resolved: alias };
  const probe = /^probe:[\w-]+:(\d\.\d\.\d+)$/.exec(alias);
  if (probe && own(FIXES, `criterion:${probe[1]}`)) return { copy: FIXES[`criterion:${probe[1]}`]!, resolved: `criterion:${probe[1]}` };
  const ai = /^ai:\w+:(\d\.\d\.\d+)$/.exec(alias);
  if (ai && own(FIXES, `criterion:${ai[1]}`)) return { copy: FIXES[`criterion:${ai[1]}`]!, resolved: `criterion:${ai[1]}` };
  if (alias.startsWith('third-party:') && own(FIXES, `rule:${alias.slice(12)}`)) return { copy: FIXES[`rule:${alias.slice(12)}`]!, resolved: `rule:${alias.slice(12)}` };
  return { copy: GENERIC_FIX, resolved: 'generic' };
}

/** The code change for a fix key from the scan's evidence; undefined when there is none (never throws on page content). */
export function codeFor(key: string, ex: FixInput): CodeFix | undefined {
  const { copy } = fixFor(key);
  if (!copy.code) return undefined;
  try {
    const out = copy.code(ex);
    return out ? { ...out, techniques: copy.techniques ?? [] } : undefined;
  } catch {
    return undefined;
  }
}
