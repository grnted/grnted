// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { MEDIA_WEIGHTS } from '../../src/criterionScore.js';
import { roundScore } from '../../src/scoreCore.js';
import { describe, expect, it } from 'vitest';
import { mediaIssues } from '../../src/media/index.js';
import { buildReport } from '../../src/report/build.js';
import type { MediaItem, PageAudit } from '../../src/types.js';

const hostile = '<script>alert(1)</script>';
const pages: PageAudit[] = [{ url: 'https://e.org/', status: 'ok', rules: { 'image-alt': 'pass' }, violations: [], incomplete: [], links: [] }];
const withIssues = (m: Omit<MediaItem, 'issues'>): MediaItem => ({ ...m, issues: mediaIssues(m) });
const media: MediaItem[] = [
  withIssues({ kind: 'video', content: 'video', url: `https://e.org/v.mp4?q=${encodeURIComponent(hostile)}`, foundOn: ['https://e.org/', 'https://e.org/b', 'https://e.org/c'],
    name: `Welcome ${hostile}`, tracks: [{ kind: 'captions', srclang: 'en', label: `English ${hostile}`, src: 'https://e.org/v.vtt' }], autoplay: false, muted: false, controls: true, duration: 75, captions: 'track' }),
  withIssues({ kind: 'video', content: 'video', audio: 'present', url: 'https://e.org/intro.mp4', foundOn: ['https://e.org/'], tracks: [], autoplay: true, muted: false, controls: false, captions: 'none' }),
  withIssues({ kind: 'video', content: 'video', url: '', foundOn: ['https://e.org/'], tracks: [], autoplay: true, muted: true, controls: false, captions: 'none' }),
  withIssues({ kind: 'audio', content: 'audio', url: 'https://e.org/a.mp3', foundOn: ['https://e.org/'], controls: true, transcriptNearby: true, captions: 'transcript-nearby' }),
  withIssues({ kind: 'embed', content: 'video', url: 'https://www.youtube.com/embed/aBcDeFgHiJ0', foundOn: ['https://e.org/'], player: 'youtube', videoId: 'aBcDeFgHiJ0', uploaderCaptions: false, captions: 'check-manually' }),
  withIssues({ kind: 'embed', content: 'video', url: 'https://player.vimeo.com/video/1', foundOn: ['https://e.org/'], player: 'vimeo', captions: 'check-manually' }),
  withIssues({ kind: 'link', content: 'audio', url: 'javascript:alert(1)', foundOn: [], name: hostile, transcriptNearby: false, captions: 'no-transcript' }),
];
const report = buildReport({
  site: 'https://e.org/', pages, documents: [], documentChecks: [], media, skipped: [],
  startedAt: '2026-10-31T00:00:00.000Z', finishedAt: '2026-10-31T00:01:00.000Z', userAgent: 'UA',
  probeRuns: [{ probe: 'audio', kind: 'interaction', page: 'https://e.org/', criteria: ['1.4.2'], status: 'ok', ms: 1,
    findings: [{ criterion: '1.4.2', status: 'failed', detail: 'Automatic sound continued beyond three seconds and no control stopped it.' }] }],
});

it('R4: autoplay metadata cannot overrule an unresolved quiet-video test; confirmed sound still fails', () => {
  const clip = withIssues({ kind: 'video', content: 'video', audio: 'present', url: 'https://e.org/delayed.webm', foundOn: ['https://e.org/'],
    autoplay: true, muted: false, controls: false, duration: 30, captions: 'track' });
  const make = (status: 'not_testable' | 'failed' | 'no_failures_found') => buildReport({
    site: 'https://e.org/', pages, documents: [], media: [clip], skipped: [], startedAt: '', finishedAt: '', userAgent: 'UA',
    probeRuns: [{ probe: 'audio', kind: 'interaction', page: 'https://e.org/', criteria: ['1.4.2'], status: 'ok', ms: 1,
      findings: [{ criterion: '1.4.2', status, detail: status === 'not_testable' ? 'The playing video has an audio track, but only silence was heard during observation.' : status === 'failed' ? 'Automatic sound continued beyond three seconds and no control stopped it.' : 'The page control stopped the automatic sound.' }] }],
  });
  const unknown = make('not_testable');
  expect(unknown.criteria!.find((c) => c.criterion === '1.4.2')!.status).toBe('not_testable');
  expect(unknown.score).toBe(100);
  const confirmed = make('failed');
  expect(confirmed.criteria!.find((c) => c.criterion === '1.4.2')!.status).toBe('failed');
  expect(confirmed.score).toBeLessThan(100);
  const controlled = make('no_failures_found');
  expect(controlled.criteria!.find((c) => c.criterion === '1.4.2')!.status).toBe('no_failures_found');
  expect(controlled.score).toBe(100);
});

describe('media in the report', () => {

  it('keeps media in the report; since scoring v8 its problems (1.2.2 captions, 1.4.2 sound) count toward the score', () => {
    expect(report.media).toBe(media);
    // Both problems are on the one loaded page with media: 1.2.2 and 1.4.2 at share 1.
    expect(report.score).toBe(roundScore(100 - 18 * Math.log1p((MEDIA_WEIGHTS['1.2.2']! + MEDIA_WEIGHTS['1.4.2']!) / 10)));
    expect(report.score).toBeLessThan(100);
    expect(buildReport({ ...report, probeRuns: report.probes?.runs, pages, documents: [], skipped: [], startedAt: '', finishedAt: '', userAgent: '' }).score).toBe(report.score);
  });
});
