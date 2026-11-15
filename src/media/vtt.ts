// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A small WebVTT reader: cue times and plain text (voice spans become "Name: text"). Used by the
// AI media check to compare captions with a transcript. Engine core: pure.

export interface VttCue {
  /** Seconds. */
  start: number;
  end: number;
  text: string;
}

const TIME = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{3})$/;

function seconds(t: string): number | undefined {
  const m = TIME.exec(t.trim());
  if (!m) return undefined;
  return Number(m[1] ?? 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', lrm: '', rlm: '' };

function cueText(lines: string[]): string {
  return lines
    .join('\n')
    .replace(/<v(?:\.[^\s>]*)?\s+([^>]*)>/g, (_, name: string) => `${name.trim()}: `)
    .replace(/<[^>]*>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
      }
      return ENTITIES[e.toLowerCase()] ?? all;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

/** The cues of a WebVTT file, in file order, or undefined when the text is not WebVTT. */
export function parseVtt(text: string): VttCue[] | undefined {
  const lines = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n').split('\n');
  if (!/^WEBVTT(?:[ \t]|$)/.test(lines[0] ?? '')) return undefined;
  const cues: VttCue[] = [];
  let i = 1;
  while (i < lines.length) {
    // One block: lines up to the next blank line.
    const block: string[] = [];
    while (i < lines.length && lines[i]!.trim() === '') i++;
    while (i < lines.length && lines[i]!.trim() !== '') block.push(lines[i++]!);
    if (!block.length) break;
    if (/^(NOTE|STYLE|REGION)(?:[ \t]|$)/.test(block[0]!)) continue;
    const at = block.findIndex((l) => l.includes('-->'));
    if (at < 0 || at > 1) continue;
    const [from, rest] = block[at]!.split('-->') as [string, string];
    const start = seconds(from);
    const end = seconds(rest.trim().split(/[ \t]+/)[0] ?? '');
    if (start === undefined || end === undefined || end < start) continue;
    const textOut = cueText(block.slice(at + 1));
    if (textOut) cues.push({ start, end, text: textOut });
  }
  return cues;
}

/** `m:ss`, or `h:mm:ss` from one hour. */
export function formatTime(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}
