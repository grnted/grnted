// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fixPrompt } from '../../src/report/fixPrompt.js';
import { renderPlainHtml } from '../../src/report/plain.js';
import type { SiteReport } from '../../src/types.js';
import { ENGINE_VERSION } from '../../src/version.js';
import { fixPromptReport } from '../helpers/fixPromptFixture.js';
import { startFixtureServer } from '../helpers/fixtureServer.js';
import { claimedChrome, startUaShieldSite } from '../helpers/uaShieldSite.js';

const run = promisify(execFile);
const CLI = new URL('../../dist/cli.js', import.meta.url).pathname;
let server: Awaited<ReturnType<typeof startFixtureServer>>;
// A stand-in for the OpenAI API that refuses every request (400, which the SDK does not retry):
// every AI item then reads "not reviewed", and nothing leaves this machine.
let refusing: Server;
let refusingUrl = '';
const requests: string[] = [];

beforeAll(async () => {
  await run('pnpm', ['run', 'build'], { cwd: new URL('../..', import.meta.url).pathname });
  server = await startFixtureServer();
  refusing = createServer((req, res) => {
    requests.push(`${req.method} ${req.url}`);
    res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ error: { message: 'refused in tests', type: 'invalid_request_error' } }));
  });
  await new Promise<void>((r) => refusing.listen(0, '127.0.0.1', r));
  refusingUrl = `http://127.0.0.1:${(refusing.address() as { port: number }).port}/v1`;
}, 120_000);
afterAll(async () => {
  await server?.close();
  await new Promise((r) => refusing?.close(r));
});

async function cli(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run('node', [CLI, ...args], { env: { ...process.env, OPENAI_API_KEY: '', ...env }, maxBuffer: 256 * 1024 * 1024 });
    return { code: 0, stdout, stderr };
  } catch (e) {
    const err = e as { code: number; stdout: string; stderr: string };
    return { code: err.code, stdout: err.stdout, stderr: err.stderr };
  }
}

describe('grnted CLI', () => {
  it('writes JSON, the plain HTML report, the evidence pictures and the fix prompts, and exits 1 below --min', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
    const images = join(dir, 'img');
    const r = await cli([`${server.origin}/`, '--max', '10', '--json', join(dir, 'r.json'), '--html', join(dir, 'r.html'), '--images', images, '--min', '95', '--quiet']);
    expect(r.code).toBe(1);
    const json = JSON.parse(await readFile(join(dir, 'r.json'), 'utf8')) as SiteReport;
    expect(json.schemaVersion).toBe(2);
    expect(json.criteria).toHaveLength(55);
    // --images turns on the evidence pictures: JPEG files by evidence id; the JSON keeps their metadata only.
    expect(json.evidence?.[0]).toMatchObject({ id: 'e1', for: { rule: '$start' } });
    expect(JSON.stringify(json)).not.toContain('data:image/jpeg');
    const shots = (await readdir(images)).sort();
    expect(shots).toContain('e1.jpg');
    expect(shots.length).toBe(json.evidence!.length);
    expect((await readFile(join(images, 'e1.jpg'))).subarray(0, 3)).toEqual(Buffer.from([0xff, 0xd8, 0xff]));
    expect(r.stdout).toContain(`  Evidence pictures: ${shots.length} in ${images}`);
    // --html is the open engine's plain report, the same as the library renders from the JSON.
    const html = await readFile(join(dir, 'r.html'), 'utf8');
    expect(html).toBe(renderPlainHtml(json));
    expect(html).toContain('<title>Accessibility report: 127.0.0.1</title>');
    // The visual report's files (issue list, ACR) are made on grnted.co, never by the CLI.
    for (const f of ['r.issues.csv', 'r.issues.xlsx', 'r.acr.docx']) expect(existsSync(join(dir, f)), f).toBe(false);
    expect(r.stdout).not.toContain('Conformance report');
    // Batch 19: the summary leads with the verdict line, the score first ("76/100 · Grade C · Access Denied: ...").
    expect(r.stdout).toMatch(/^\s*\d{1,3}\/100 · Grade [A-F] · Access (Granted|Denied): /);
    expect(r.stdout).toContain('WCAG 2.2 A/AA criteria (55): ');
    // "Fix it for me": both prompts beside the report, the same as the library builds from the JSON.
    for (const audience of ['developer', 'content'] as const) {
      const md = await readFile(join(dir, `r.fix-${audience}.md`), 'utf8');
      expect(md).toBe(fixPrompt(json, { audience }));
      expect(md).toContain('# Fix the accessibility problems Granted found on 127.0.0.1');
    }
    expect(r.stdout).toContain(`  Fix-it prompts: ${join(dir, 'r.fix-developer.md')} and ${join(dir, 'r.fix-content.md')}`);
  }, 120_000);

  it('--format prints json, the plain html report or the fix brief instead of the summary', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
    const scan = (format: string, name: string, extra: string[] = []) => cli([`${server.origin}/`, '--max', '2', '--no-probes', '--quiet', '--format', format, '--json', join(dir, name), ...extra]);
    const json = await scan('json', 'j.json');
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(await readFile(join(dir, 'j.json'), 'utf8')));
    const html = await scan('html', 'h.json');
    expect(html.stdout).toBe(renderPlainHtml(JSON.parse(await readFile(join(dir, 'h.json'), 'utf8')) as SiteReport));
    const fix = await scan('fix', 'f.json', ['--audience', 'content']);
    expect(fix.stdout).toBe(fixPrompt(JSON.parse(await readFile(join(dir, 'f.json'), 'utf8')) as SiteReport, { audience: 'content' }));
    expect((await cli([`${server.origin}/`, '--format', 'markdown'])).stderr).toMatch(/--format must be terminal, json, html, fix/);
  }, 120_000);

  it('a large piped --format json, html or fix output arrives whole when the CLI exits 1 or 2 (Sol r1 S7)', async () => {
    // A big start page (hundreds of failing elements, each listed in the JSON with the page's long address, so the
    // JSON is far beyond a pipe's buffer) and five more pages: answered for the exit-1 scan (scored, below --min
    // 100), refused for the exit-2 one (incomplete).
    const start = `/${'a-long-page-address-'.repeat(40)}`;
    const big = `<!doctype html><html lang="en"><head><title>Big page</title></head><body><main><h1>Big page</h1>${
      Array.from({ length: 5 }, (_, i) => `<p><a href="/p${i}">Page ${i}</a></p>`).join('')}${
      Array.from({ length: 400 }, (_, i) => `<p><img src="/i${i}.png"> <a href="/x${i}"><span></span></a> <input id="f${i}"></p>`).join('')}</main></body></html>`;
    const small = '<!doctype html><html lang="en"><head><title>A page</title></head><body><main><h1>A page</h1><p>Text.</p></main></body></html>';
    for (const [code, ok] of [[1, true], [2, false]] as const) {
      const page = { type: 'text/html; charset=utf-8', body: big };
      const site = await startFixtureServer('site', { '/': page, [start]: page }, {
        respond: (_req, path) => (/^\/p\d$/.test(path) ? (ok ? { status: 200, body: small } : { status: 500, body: 'error' }) : /^\/(x|i)\d+/.test(path) ? { status: 404, body: '' } : undefined),
      });
      try {
        const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
        for (const format of ['json', 'html', 'fix'] as const) {
          const file = join(dir, `${format}-${code}.json`);
          const r = await cli([`${site.origin}${start}`, '--max', '6', '--no-probes', '--quiet', '--min', '100', '--format', format, '--json', file]);
          expect(r.code, `${format}, exit ${code}: ${r.stderr}`).toBe(code);
          const json = JSON.parse(await readFile(file, 'utf8')) as SiteReport;
          const want = format === 'json' ? `${JSON.stringify(json, null, 2)}\n` : format === 'html' ? renderPlainHtml(json) : fixPrompt(json, { audience: 'developer' });
          expect(r.stdout.length, `${format}, exit ${code}`).toBe(want.length);
          expect(r.stdout === want, `${format}, exit ${code}`).toBe(true);
          // At least twice the largest pipe buffer (64 KiB on macOS and Linux), so most of it waits for the reader.
          if (format === 'json') expect(r.stdout.length, `the JSON of the exit-${code} scan is meant to be far beyond a pipe's buffer`).toBeGreaterThan(2 * 64 * 1024);
        }
      } finally {
        await site.close();
      }
    }
  }, 240_000);

  it('PDF, ACR (VPAT), EN 301 549, Word and Excel requests get one line pointing to grnted.co and exit 3, before any scan', async () => {
    const asks: [string[], string][] = [
      [['--format', 'pdf'], 'The PDF report'], [['--format=acr'], 'The ACR (VPAT)'], [['--vpat'], 'The ACR (VPAT)'],
      [['--format', 'en301549'], 'The EN 301 549 report'], [['--docx', 'r.docx'], 'The Word report'], [['--format', 'XLSX'], 'The Excel issue list'],
    ];
    for (const [args, what] of asks) {
      // An address nothing answers: the line comes before any scan.
      const r = await cli(['http://127.0.0.1:9/', ...args]);
      expect(r.code, args.join(' ')).toBe(3);
      expect(r.stderr).toBe(`${what} is made on grnted.co: https://grnted.co/\n`);
      expect(r.stdout).toBe('');
    }
  }, 60_000);

  it('a site behind a bot shield that refuses a User-Agent its client hints disagree with: served, with the browser\'s own + the grnted token (P1 2026-11-06)', async () => {
    const shield = await startUaShieldSite();
    try {
      const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
      const r = await cli([`${shield.origin}/`, '--max', '5', '--json', join(dir, 'r.json'), '--quiet', '--no-probes']);
      const json = JSON.parse(await readFile(join(dir, 'r.json'), 'utf8')) as SiteReport;
      const hits = shield.hits();
      expect(hits.filter((h) => h.status === 403), `refused (exit ${r.code}): ${r.stderr}`).toEqual([]);
      expect(json.pages.map((p) => p.status)).toEqual(['ok', 'ok']);
      const agents = [...new Set(hits.map((h) => h.ua))];
      expect(agents).toHaveLength(1);
      expect(agents[0]!.endsWith(` grnted/${ENGINE_VERSION} (grnted.co)`)).toBe(true);
      expect(claimedChrome(agents[0]!)?.product).toBe('HeadlessChrome');
      expect(json.meta.userAgent).toBe(agents[0]);
    } finally {
      await shield.close();
    }
  }, 120_000);

  it('--fix-prompt prints a prompt from an existing report.json, for --audience developer (default) or content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
    const report = fixPromptReport();
    const file = join(dir, 'report.json');
    await writeFile(file, JSON.stringify(report));
    const dev = await cli(['--fix-prompt', file]);
    expect(dev.code).toBe(0);
    expect(dev.stdout).toBe(fixPrompt(report, { audience: 'developer' }));
    const content = await cli(['--fix-prompt', file, '--audience', 'content']);
    expect(content.stdout).toBe(fixPrompt(report, { audience: 'content' }));
    expect((await cli(['--fix-prompt', file, '--audience', 'boss'])).code).toBe(3);
    expect((await cli(['--fix-prompt', join(dir, 'missing.json')])).stderr).toMatch(/Could not read a Granted report from/);
    await writeFile(join(dir, 'other.json'), '{"hello":1}');
    expect((await cli(['--fix-prompt', join(dir, 'other.json')])).code).toBe(3);
    expect((await cli(['--audience', 'content', 'https://e.example'])).code).toBe(3);
  }, 60_000);

  it('--help says the AI review is the hosted Granted\'s: no AI flag, model or provider; the fix brief and exit codes as before', async () => {
    const r = await cli(['--help']);
    expect(r.code).toBe(0);
    const ai = r.stdout.slice(r.stdout.indexOf('AI review:'), r.stdout.indexOf('Video and audio:'));
    expect(ai).toContain('The AI review is part of the hosted, paid Granted (grnted.co).');
    expect(ai).toContain('AI checks not run: automated-only');
    expect(r.stdout).not.toMatch(/--ai|--navigator|OPENAI|OpenAI|gpt-|Agents SDK|ai-review\.md/);
    expect(r.stdout).toContain('YOUTUBE_API_KEY');
    const fix = r.stdout.slice(r.stdout.indexOf('Fix it for me:'), r.stdout.indexOf('Exit codes:'));
    expect(fix).toContain('<name>.fix-developer.md and <name>.fix-content.md');
    expect(fix).toContain('  --fix-prompt FILE');
    expect(fix).toContain('  --audience WHO');
    expect(r.stdout).toContain('Exit codes: 0 ok · 1 below --min · 2 scan incomplete · 3 usage or runtime error');
    // Readable in an 80-column terminal.
    expect(Math.max(...r.stdout.split('\n').map((l) => l.length))).toBeLessThanOrEqual(84);
  });

  it('--help says what is scored and tested now (WCAG 2.2), and how the tests keep the site safe', async () => {
    const r = await cli(['--help']);
    const intro = r.stdout.slice(0, r.stdout.indexOf('Options:'));
    expect(intro).toMatch(/0 to 100/);
    expect(intro).toMatch(/WCAG 2\.2 Level A\s+and AA rules/);
    expect(intro).toMatch(/every WCAG 2\.2 A and AA\s+criterion/);
    expect(r.stdout).not.toContain('2.1 AA');
    expect(r.stdout).not.toMatch(/legal compliance determination/i);
    expect(r.stdout).not.toMatch(/open[- ]source|\bMIT\b|a portion of/i);
    const tests = r.stdout.slice(r.stdout.indexOf('Automated tests:'), r.stdout.indexOf('AI review (optional, never scored):'));
    expect(tests).toMatch(/GET and HEAD/);
    expect(tests).toMatch(/nothing typed\s+is ever sent/);
    expect(tests).toMatch(/never\s+pressed/);
  });

  it('--help says what the verdict means (batch 19)', async () => {
    const r = await cli(['--help']);
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('Access Granted means a score of 90 or more and no failure of a criterion that blocks it');
    expect(r.stdout.replace(/\s+/g, ' ')).toContain('not the site blocking the scanner');
  });

  it('exits 3 with usage on bad input; the AI flags are gone (the AI review is the hosted Granted\'s)', async () => {
    // Batch 19: a usage error prints the error and where the options are, never the whole help under it.
    const bad = await cli(['not-a-url']);
    expect(bad.code).toBe(3);
    expect(bad.stderr).toMatch(/^grnted: give a website address/);
    expect(bad.stderr).toMatch(/Run grnted --help for the options\./);
    expect(bad.stderr).not.toMatch(/Usage: grnted/);
    for (const flag of [['--ai'], ['--ai-checks', 'altText'], ['--ai-vision'], ['--ai-docs'], ['--navigator']]) {
      const r = await cli([`${server.origin}/`, ...flag]);
      expect(r.code, flag.join(' ')).toBe(3);
      expect(r.stderr, flag.join(' ')).toMatch(/Unknown option/);
    }
  });

  it('with an OpenAI key in the environment, a scan still asks no model and scores the automated checks only', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'grnted-'));
    const before = requests.length;
    const r = await cli([`${server.origin}/`, '--max', '10', '--json', join(dir, 'r.json'), '--quiet'], { OPENAI_API_KEY: 'test-key-not-real', OPENAI_BASE_URL: refusingUrl });
    expect(r.code).toBe(0);
    const json = JSON.parse(await readFile(join(dir, 'r.json'), 'utf8')) as SiteReport;
    expect(json.ai).toBeUndefined();
    expect(json.aiChecks).toEqual({ ran: false, issues: [], note: 'AI checks not run: automated-only score' });
    expect(requests.length).toBe(before);
  }, 120_000);
});
