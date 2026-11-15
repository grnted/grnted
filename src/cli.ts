#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { quietBrowser } from './analytics.js';
import { BROWSER_ARGS } from './browserArgs.js';
import { ADAPTIVE } from './pace.js';
import { FIX_PROMPT_AUDIENCES, fixPrompt, fixPromptSuffix, type FixPromptAudience } from './report/fixPrompt.js';
import { renderPlainHtml } from './report/plain.js';
import { renderTerminal } from './report/terminal.js';
import { reconnectingBrowser } from './reconnect.js';
import { fileStore, type ReplayStats } from './replay/index.js';
import { scanSite } from './scan.js';
import type { BrowserLike, SiteReport } from './types.js';
import { normalizeUrl, withScheme } from './url.js';
import { ACCESS_GRANTED_RULE } from './report/blocked.js';
import { ENGINE_VERSION } from './version.js';
import { browserUserAgent } from './userAgent.js';

/** Words wrapped at `width` columns, each line after the first indented. */
function wrap(text: string, width: number, indent: string): string {
  const lines: string[] = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if (line && line.length + 1 + w.length > width) { lines.push(line); line = w; } else line = line ? `${line} ${w}` : w;
  }
  if (line) lines.push(line);
  return lines.map((l) => `${indent}${l}`).join('\n');
}

/**
 * Deliverables made on grnted.co, not by the CLI: `--format <x>` or `--<x>` for any of these prints
 * where they are and exits 3, before anything is scanned.
 */
const HOSTED_FORMATS: Readonly<Record<string, string>> = Object.freeze({
  pdf: 'The PDF report', acr: 'The ACR (VPAT)', vpat: 'The ACR (VPAT)', en301549: 'The EN 301 549 report', docx: 'The Word report',
  xlsx: 'The Excel issue list', csv: 'The CSV issue list', statement: 'The accessibility statement',
});
/** What `--format` prints on stdout. */
const FORMATS = ['terminal', 'json', 'html', 'fix'] as const;
type Format = (typeof FORMATS)[number];

/** The hosted deliverable an argument list asks for (`--format pdf`, `--format=acr`, `--pdf`, `--vpat=x`), if any. */
function hostedFormatAsked(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!.toLowerCase();
    const named = /^--format=(.+)$/.exec(a)?.[1] ?? (a === '--format' ? argv[i + 1]?.toLowerCase() : undefined) ?? /^--([a-z0-9]+)(?:=.*)?$/.exec(a)?.[1];
    if (named && Object.hasOwn(HOSTED_FORMATS, named)) return named;
  }
  return null;
}

const USAGE = `Usage: grnted <url> [options]
       grnted --fix-prompt <report.json> [--audience developer|content]

Scores a website's accessibility from 0 to 100 with axe-core's WCAG 2.2 Level A
and AA rules and the core automated tests, gives a result from automated tests
for every WCAG 2.2 A and AA criterion (55), and lists the site's documents and
media.

Options:
  --max N              Pages to scan, 1 to 50 (default 25)
  --concurrency N      Most pages checked at once, 1 to 16 (default 6): a scan
                       starts lower, going up while the site answers comfortably
  --json FILE          Write the full JSON report
  --html FILE          Write the HTML report: one plain, self-contained page
                       with the score, every WCAG 2.2 A and AA criterion's
                       result and every problem with its pages, elements,
                       evidence and how to fix it
  --format FORMAT      Print terminal (default), json, html or fix (the fix
                       brief for an AI assistant; --audience content for the
                       content editor's) instead of the summary
  --images DIR         Save the evidence pictures (JPEG, by evidence id) in DIR;
                       the JSON names them
  --min N              Exit 1 if the score is below N (for CI)
  --quiet              No progress output
  --full               Also run the deep automated tests (slower interaction
                       tests such as flash analysis, full keyboard traversal of
                       long pages, and form tests that fill in and submit forms
                       with the network shut, so nothing reaches the site)
  --no-probes          Skip the interaction and render tests (for debugging)
  --replay             Record once, test on the copy: load each address from the
                       site once and answer every later load (the other width,
                       each test's own page) from a copy kept in a temporary
                       folder until the scan ends. The results are the same;
                       the site gets far fewer requests
  --no-document-score  Leave the linked PDFs out of the score (scoring v7 counts
                       PDFs with problems found by the quick checks as one check;
                       the report says when they were left out)
  --version, --help

Automated tests:
  Interaction and render tests (keyboard, pointer, zoom, contrast, motion,
  timing, forms, media players) run on up to 5 pages that look like different
  templates; text contrast and heading structure run on every page that loaded.
  They only send GET and HEAD requests; addresses that look like an
  action (logout, delete, cart, checkout...) are blocked, and controls named for
  an action (log out, delete, subscribe, pay, donate...) are never pressed.
  While a test types into a form (made-up values only), every request is
  blocked, so nothing typed is ever sent. A test that would need a blocked
  request gives "could not be tested automatically on this site" with the
  reason. Results appear in the WCAG results by criterion.

AI review:
  The AI review is part of the hosted, paid Granted (grnted.co). This tool runs
  the automated checks; its report says "AI checks not run: automated-only
  score".

Video and audio:
  Every scan lists video and audio. With YOUTUBE_API_KEY set (no AI needed),
  YouTube videos (embedded or linked) also show the caption tracks YouTube lists:
  made by a person, automatic only, or none (YouTube Data API captions.list, 50
  quota units per video, at most 50 videos per scan). With VIMEO_TOKEN set (a
  Vimeo app token), Vimeo videos do too. Only the video id is sent; the key and
  token are never stored.

PDF, ACR (VPAT), EN 301 549, Word and Excel reports are made on grnted.co.

Fix it for me:
  With --html or --json, the CLI also writes two prompts beside the report,
  <name>.fix-developer.md and <name>.fix-content.md, for the site owner's own
  AI assistant: what to change for each problem (a web developer's version and
  a content editor's). Built from the report by a fixed template, with no AI
  call; text copied from the site is marked in them as data, never as
  instructions. At most 25,000 characters each, most points first.
  --fix-prompt FILE    Print a prompt from an existing JSON report and exit
  --audience WHO       With --fix-prompt or --format fix: developer (default) or
                       content

The verdict:
${wrap(ACCESS_GRANTED_RULE, 76, '  ')}

Exit codes: 0 ok · 1 below --min · 2 scan incomplete · 3 usage or runtime error,
or a format made on grnted.co`;

/**
 * Ends the CLI with an exit code without process.exit(): the output already written (a large `--format json`
 * piped into another program included) is flushed before the process ends (Sol r1 S7).
 */
class Exit extends Error {
  constructor(readonly code: number) {
    super(`exit ${code}`);
  }
}

/** A usage error: the error and where the options are (batch 19: the full help under it buried the error). */
function usage(msg: string): never {
  process.stderr.write(`grnted: ${msg}\nRun grnted --help for the options.\n`);
  throw new Exit(3);
}

async function main(): Promise<void> {
  const hosted = hostedFormatAsked(process.argv.slice(2));
  if (hosted) {
    process.stderr.write(`${HOSTED_FORMATS[hosted]} is made on grnted.co: https://grnted.co/\n`);
    throw new Exit(3);
  }
  let parsed;
  try {
    parsed = parseArgs({
      allowPositionals: true,
      options: {
        max: { type: 'string' }, concurrency: { type: 'string' }, json: { type: 'string' }, html: { type: 'string' },
        min: { type: 'string' }, quiet: { type: 'boolean' }, version: { type: 'boolean' }, help: { type: 'boolean' },
        full: { type: 'boolean' }, 'no-probes': { type: 'boolean' }, 'no-document-score': { type: 'boolean' }, replay: { type: 'boolean' },
        'fix-prompt': { type: 'string' }, audience: { type: 'string' },
        format: { type: 'string' }, images: { type: 'string' },
      },
    });
  } catch (e) {
    usage((e as Error).message);
  }
  const { values, positionals } = parsed;
  if (values.version) { process.stdout.write(`${ENGINE_VERSION}\n`); return; }
  if (values.help) { process.stdout.write(`${USAGE}\n`); return; }
  const audience = values.audience ?? 'developer';
  if (!(FIX_PROMPT_AUDIENCES as readonly string[]).includes(audience)) usage('--audience must be developer or content');
  const format = (values.format ?? 'terminal').toLowerCase() as Format;
  if (!FORMATS.includes(format)) usage(`--format must be ${FORMATS.join(', ')}`);
  if (values.audience !== undefined && values['fix-prompt'] === undefined && format !== 'fix') usage('--audience goes with --fix-prompt or --format fix');
  if (values['fix-prompt'] !== undefined) {
    const file = values['fix-prompt'];
    let report: SiteReport;
    try {
      report = JSON.parse(await readFile(file, 'utf8')) as SiteReport;
    } catch {
      usage(`Could not read a Granted report from ${file}`);
    }
    if (!report || typeof report !== 'object' || report.schemaVersion !== 2 || !Array.isArray(report.pages) || !report.meta) usage(`${file} is not a Granted JSON report (schema version 2)`);
    process.stdout.write(fixPrompt(report, { audience: audience as FixPromptAudience }));
    return;
  }
  // Batch 19: a bare domain ("example.org") is taken as https://example.org.
  const url = positionals[0] && normalizeUrl(withScheme(positionals[0]));
  if (!url) usage('give a website address, like example.org or https://example.org');
  const max = values.max ? Number(values.max) : 25;
  if (!Number.isInteger(max) || max < 1 || max > 50) usage('--max must be a whole number from 1 to 50');
  const concurrency = values.concurrency ? Number(values.concurrency) : 6;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 16) usage('--concurrency must be a whole number from 1 to 16');
  const min = values.min ? Number(values.min) : undefined;
  if (min !== undefined && (!Number.isFinite(min) || min < 0 || min > 100)) usage('--min must be from 0 to 100');

  const { chromium } = await import('playwright');
  let browser;
  try {
    browser = await chromium.launch({ args: [...BROWSER_ARGS] });
  } catch (e) {
    if (/Executable doesn't exist|browserType.launch/i.test(String(e))) {
      process.stderr.write('Chromium is not installed. Run: npx playwright install chromium\n');
      throw new Exit(3);
    }
    throw e;
  }
  // Evidence pictures (--images DIR), kept in memory and written to DIR by their evidence id once the scan
  // ends. The JSON gets their metadata only (the bytes never enter the report).
  const images = new Map<string, Uint8Array>();
  const imagesDir = values.images;
  // A browser that crashes mid-scan is replaced and the lost work redone (or the report says so).
  const launched = browser;
  const browsers = reconnectingBrowser({ browser: launched, close: () => launched.close() }, async () => {
    const b = await chromium.launch({ args: [...BROWSER_ARGS] });
    return { browser: b, close: () => b.close() };
  });
  // The scanned site's analytics never hear from the scan (src/analytics.ts): its beacons are aborted
  // on every page, its scripts still run.
  const scanBrowser = quietBrowser(browsers.browser as unknown as BrowserLike);
  // The browser's own User-Agent with Granted's token (src/userAgent.ts), for the scan.
  const userAgent = await browserUserAgent(scanBrowser);
  let report;
  try {
    const youtubeApiKey = process.env.YOUTUBE_API_KEY || undefined;
    const vimeoToken = process.env.VIMEO_TOKEN || undefined;
    report = await scanSite(url, {
      browser: scanBrowser,
      maxPages: max,
      // The ceiling the user sets; the scan starts at the hosted start (or N when lower) and goes up to it.
      concurrency,
      startConcurrency: Math.min(ADAPTIVE.start, concurrency),
      userAgent,
      ...(youtubeApiKey || vimeoToken ? { media: { ...(youtubeApiKey ? { youtubeApiKey } : {}), ...(vimeoToken ? { vimeoToken } : {}) } } : {}),
      ...(values['no-probes'] ? { probes: false as const } : {}),
      ...(values['no-document-score'] ? { documentScore: false } : {}),
      ...(values.full ? { full: true } : {}),
      // The scan's own copy of the site (src/replay): in a temporary folder, removed when the scan ends.
      ...(values.replay ? {
        replay: { store: await fileStore(await mkdtemp(join(tmpdir(), 'grnted-replay-'))) },
        onReplay: (s: ReplayStats) => {
          if (!values.quiet) process.stderr.write(`  Answered from the copy: ${s.replayed} requests (${s.replayedDocuments} pages and frames). Asked the site: ${s.sent}\n`);
        },
      } : {}),
      ...(imagesDir ? { evidence: { sink: (id: string, jpeg: Uint8Array) => { images.set(id, jpeg); } } } : {}),
      onProgress: values.quiet ? undefined : (p) => {
        if (p.phase === 'audit') process.stderr.write(`  [${p.done}/${p.total}] ${p.url}\n`);
        if (p.phase === 'discover') process.stderr.write('  Finding pages…\n');
        if (p.phase === 'documents') process.stderr.write('  Finishing the document checks…\n');
      },
    });
  } finally {
    await browsers.close();
  }
  if (values.json) await writeFile(values.json, JSON.stringify(report, null, 2));
  if (values.html) await writeFile(values.html, renderPlainHtml(report));
  if (imagesDir) {
    await mkdir(imagesDir, { recursive: true });
    for (const [id, jpeg] of images) if (/^[A-Za-z0-9_-]{1,64}$/.test(id)) await writeFile(join(imagesDir, `${id}.jpg`), jpeg);
  }
  // "Fix it for me": both prompts beside the report (named after the HTML file, else the JSON one).
  const reportBase = (values.html ?? values.json)?.replace(/\.(?:html?|json)$/i, '');
  const fixFiles: string[] = [];
  if (reportBase) {
    for (const a of FIX_PROMPT_AUDIENCES) {
      const path = `${reportBase}.${fixPromptSuffix(a)}`;
      await writeFile(path, fixPrompt(report, { audience: a }));
      fixFiles.push(path);
    }
  }
  if (format === 'json') process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else if (format === 'html') process.stdout.write(renderPlainHtml(report));
  else if (format === 'fix') process.stdout.write(fixPrompt(report, { audience: audience as FixPromptAudience }));
  else {
    process.stdout.write(renderTerminal(report, values.html));
    if (fixFiles.length) process.stdout.write(`  Fix-it prompts: ${fixFiles.join(' and ')}\n`);
    if (imagesDir) process.stdout.write(`  Evidence pictures: ${images.size} in ${imagesDir}\n`);
  }
  if (report.status === 'incomplete') throw new Exit(2);
  if (min !== undefined && (report.score ?? 0) < min) throw new Exit(1);
}

// The exit code is set, never forced: Node ends once stdout and stderr have drained.
main().catch((e) => {
  if (e instanceof Exit) {
    process.exitCode = e.code;
    return;
  }
  process.stderr.write(`grnted: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 3;
  // An unexpected error can leave a browser or a timer open, which would keep Node running: end the process,
  // but only once everything written to stdout and stderr has been handed over (writes complete in order).
  process.stdout.write('', () => process.stderr.write('', () => process.exit(3)));
});
