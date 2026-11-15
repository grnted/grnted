// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Batch 18, visual lane, D12 (docs/atlas/visual.md): WCAG 1.4.11 for the data of an inline SVG chart. A data line,
// bars or an area under 3:1 against the plot fail when the chart's values are not given as text beside it. Look-alikes
// keep passing: data labels on the points, a table with the values in the same figure, faint gridlines under a dark
// series, markers with 3:1 on a faint line, and a decorative curve with no axis.
import { chromium, type Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runProbes } from '../../src/probes/runner.js';
import { nonTextContrastProbe } from '../../src/probes/nonTextContrast.js';
import type { BrowserLike, ProbeRun } from '../../src/types.js';
import { startSimServer } from '../sim/server.js';

let browser: Browser;
beforeAll(async () => { browser = await chromium.launch(); }, 30_000);
afterAll(async () => { await browser?.close(); });

const page = (body: string) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Budget</title>
<style>body { font: 16px/1.5 Arial, sans-serif; margin: 32px; background: #fff; color: #222; }</style></head><body><main><h1>Water use</h1>${body}</main></body></html>`;
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun'];
const axes = `<line x1="40" y1="10" x2="40" y2="170" stroke="#333"/><line x1="40" y1="170" x2="460" y2="170" stroke="#333"/>
${MONTHS.map((m, i) => `<text x="${60 + i * 75}" y="190" font-size="12" fill="#333">${m}</text>`).join('')}
${[0, 50, 100].map((v, i) => `<text x="5" y="${170 - i * 70}" font-size="12" fill="#333">${v}</text>`).join('')}`;
const LINE = '60,120 135,80 210,100 285,40 360,70 435,30';
const chart = (inner: string, extra = '') => `<figure><figcaption>Monthly water use</figcaption><svg role="img" aria-label="Monthly water use" width="480" height="200" viewBox="0 0 480 200">${axes}${inner}</svg>${extra}</figure>`;

async function run(html: string): Promise<ProbeRun> {
  const sim = await startSimServer({ files: { '/': html } });
  try {
    const [r] = await runProbes(browser as unknown as BrowserLike, [{ url: `${sim.origin}/`, index: 0 }], [nonTextContrastProbe], { userAgent: 'grnted-test', full: true });
    return r!;
  } finally {
    await sim.close();
  }
}
const failed = (r: ProbeRun) => r.findings.filter((f) => f.status === 'failed');

describe('D12: the data of a chart', () => {
  it('fails a faint data line, faint bars and a faint area, each with dark axes', async () => {
    const line = await run(page(chart(`<polyline points="${LINE}" fill="none" stroke="#d0ded8" stroke-width="2"/>`)));
    expect(failed(line).map((f) => f.detail), JSON.stringify(line.findings)).toEqual([expect.stringMatching(/data line of the chart “Monthly water use” is drawn in #d0ded8 on #ffffff \(1\.[34]:1\)/)]);
    const bars = await run(page(chart([120, 80, 100, 40, 70, 30].map((y, i) => `<rect x="${50 + i * 75}" y="${y}" width="40" height="${170 - y}" fill="#e2e8f0"/>`).join(''))));
    expect(failed(bars).map((f) => f.detail), JSON.stringify(bars.findings)).toEqual([expect.stringMatching(/bars of the chart .* are drawn in #e2e8f0/)]);
    const area = await run(page(chart(`<path d="M60 170 L60 120 L135 80 L210 100 L285 40 L360 70 L435 30 L435 170 Z" fill="#e9eff5"/>`)));
    expect(failed(area).map((f) => f.detail), JSON.stringify(area.findings)).toEqual([expect.stringMatching(/filled area/)]);
  }, 90_000);

  it('look-alikes pass: data labels on every point, a table with the values, faint gridlines under a dark line, markers on a faint line, a decorative curve', async () => {
    const labels = LINE.split(' ').map((p, i) => { const [x, y] = p.split(','); return `<text x="${Number(x) - 8}" y="${Number(y) - 8}" font-size="11" fill="#222">${[42, 61, 55, 88, 70, 93][i]}</text>`; }).join('');
    const cases = [
      chart(`<polyline points="${LINE}" fill="none" stroke="#d0ded8" stroke-width="2"/>${labels}`),
      chart(`<polyline points="${LINE}" fill="none" stroke="#d0ded8" stroke-width="2"/>`, '<table><tr><th>Month</th><th>Use</th></tr><tr><td>Jan</td><td>42</td></tr><tr><td>Feb</td><td>61</td></tr></table>'),
      chart(`${[40, 80, 120].map((y) => `<line x1="40" y1="${y}" x2="460" y2="${y}" stroke="#eeeeee"/>`).join('')}<polyline points="${LINE}" fill="none" stroke="#1f4e79" stroke-width="2"/>`),
      chart(`<polyline points="${LINE}" fill="none" stroke="#d0ded8" stroke-width="2"/>${LINE.split(' ').map((p) => { const [x, y] = p.split(','); return `<circle cx="${x}" cy="${y}" r="4" fill="#1f4e79"/>`; }).join('')}`),
      '<svg aria-hidden="true" width="600" height="120" viewBox="0 0 600 120"><path d="M0 60 C 150 0, 300 120, 600 40" fill="none" stroke="#eef2f5" stroke-width="6"/></svg>',
      // A ward map with pale regions, ward numbers and a numeric scale bar: regions, not data series.
      `<figure><svg role="img" aria-label="Ward map" width="420" height="220" viewBox="0 0 420 220"><path d="M10 10 L200 20 L190 150 L20 140 Z" fill="#eef3f7" stroke="#cfd8df"/><path d="M200 20 L400 30 L390 150 L190 150 Z" fill="#f3f7fa" stroke="#cfd8df"/><path d="M20 140 L190 150 L180 200 L30 200 Z" fill="#f0f4f0" stroke="#cfd8df"/>${[['1', 90, 80], ['2', 300, 90], ['3', 100, 175]].map(([t, x, y]) => `<text x="${x}" y="${y}">${t}</text>`).join('')}<line x1="300" y1="205" x2="400" y2="205" stroke="#333"/>${['0', '1', '2'].map((t, k) => `<text x="${300 + k * 50}" y="218" font-size="10">${t}</text>`).join('')}</svg><figcaption>Wards</figcaption></figure>`,
    ];
    for (const c of cases) {
      const r = await run(page(c));
      expect(failed(r), `${c.slice(0, 120)}: ${JSON.stringify(r.findings)}`).toEqual([]);
    }
  }, 150_000);
});
