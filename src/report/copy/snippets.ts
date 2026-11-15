// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Code changes shown under "How to fix it" (spec §4.1). Pure functions of what the scan saw
// (`SnippetInput`, all untrusted). They return plain text lines; the renderer escapes them.
// 'change' snippets are built from the page's own HTML or a measured value; 'example' snippets are a
// common pattern and never copy page content beyond a validated tag name.
import { parseStartTag, withoutAttrs } from '../startTag.js';
import type { Snippet, SnippetInput } from '../model.js';

/** A tag name safe to show: letters, digits and hyphens, at most 30 characters. */
function safeTagName(html: string | undefined, fallback: string): string {
  const name = parseStartTag(html)?.name ?? '';
  return /^[a-z][a-z0-9-]{0,29}$/.test(name) ? name : fallback;
}

/** Text a person sees inside the element (tags and comments dropped), from what axe kept. */
function visibleText(rest: string): string {
  return rest.replace(/<!--[\s\S]*?(-->|$)/g, '').replace(/<[^>]*(>|$)/g, '').trim();
}

/** label-content-name-mismatch: the start tag without its aria-label, when the element shows text. */
export function labelInNameSnippet(ex: SnippetInput): Snippet | null {
  const tag = parseStartTag(ex.html);
  if (!tag || !tag.attrs.some((a) => a.name === 'aria-label')) return null;
  if (!visibleText(tag.rest)) return null;
  return { kind: 'change', language: 'html', before: [tag.raw], after: [withoutAttrs(tag, (a) => a.name === 'aria-label')] };
}

/** The probe's measured number, only when it is a plain finite number. */
function measured(data: unknown, key: string): number | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const v = (data as Record<string, unknown>)[key];
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** 2.4.11: scroll padding the height of the covering header plus 12 px. */
export function scrollPaddingSnippet(ex: SnippetInput): Snippet | null {
  const h = measured(ex.data, 'coverHeight');
  if (h === null || h < 1 || h > 400) return null;
  return { kind: 'change', language: 'css', before: [], after: [`html { scroll-padding-top: ${Math.ceil(h) + 12}px; }`] };
}

/** 1.4.4: text sized to the window alone doesn't grow with zoom; a clamp() with rem does. */
export function resizeTextSnippet(): Snippet {
  return { kind: 'example', language: 'css', before: ['font-size: 8vw;'], after: ['font-size: clamp(2.5rem, 1.5rem + 5vw, 7rem);'] };
}

/** html-has-lang / html-lang-valid. */
export function langSnippet(): Snippet {
  return { kind: 'example', language: 'html', before: [], after: ['<html lang="en">'] };
}

export function imageAltSnippet(ex: SnippetInput): Snippet {
  const tag = safeTagName(ex.html, 'img');
  return { kind: 'example', language: 'html', before: [],
    after: [tag === 'img' ? '<img src="…" alt="[what the image shows]">' : `<${tag} aria-label="[what the image shows]">`] };
}

export function linkNameSnippet(ex: SnippetInput): Snippet {
  const tag = safeTagName(ex.html, 'a');
  return { kind: 'example', language: 'html', before: [],
    after: [tag === 'a' ? '<a href="…">[where the link goes]</a>' : `<${tag} aria-label="[where the link goes]">`] };
}

export function buttonNameSnippet(ex: SnippetInput): Snippet {
  return { kind: 'example', language: 'html', before: [], after: [`<${safeTagName(ex.html, 'button')} aria-label="[what it does]">`] };
}
