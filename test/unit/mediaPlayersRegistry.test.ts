// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.8: the media-players probe is registered once, deep and on a page of its own, and declared
// only where it is the method that would otherwise be missing (1.2.3, 1.2.4, 1.2.5).
import { describe, expect, it } from 'vitest';
import { MEDIA_PLAYERS_PROBE_ID, hasMedia, mediaPlayersProbe } from '../../src/probes/mediaPlayers.js';
import { PROBES, probesFor } from '../../src/probes/registry.js';
import { readFileSync } from 'node:fs';
import { BROWSER_ARGS } from '../../src/browserArgs.js';
import { groupProbes } from '../../src/probes/runner.js';
import { CRITERIA } from '../../src/report/criteria.js';

describe('media-players in the registry and the criteria table', () => {
  it('is registered once, deep, isolated, with a time box', () => {
    expect(PROBES.filter((p) => p.id === MEDIA_PLAYERS_PROBE_ID)).toEqual([mediaPlayersProbe]);
    expect(mediaPlayersProbe).toMatchObject({ tier: 'deep', isolate: true, kind: 'interaction', criteria: ['1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5'] });
    expect(mediaPlayersProbe.timeoutMs).toBeGreaterThanOrEqual(30_000);
    expect(probesFor().includes(mediaPlayersProbe)).toBe(false);
    expect(probesFor({ full: true }).includes(mediaPlayersProbe)).toBe(true);
  });

  it('is declared in 1.2.3, 1.2.4 and 1.2.5, not in 1.2.1 and 1.2.2 (the core media rules test those)', () => {
    const declared = CRITERIA.filter((d) => d.methods.includes(`probe:${MEDIA_PLAYERS_PROBE_ID}`)).map((d) => d.criterion);
    expect(declared).toEqual(['1.2.3', '1.2.4', '1.2.5']);
  });

  it('also runs on pages where the audit saw media', () => {
    const facts = (over: object) => ({ media: { elements: [], frames: [], links: [], ...over } });
    expect(hasMedia(undefined)).toBe(false);
    expect(hasMedia(facts({}))).toBe(false);
    expect(hasMedia({ media: { error: 'timed out' } })).toBe(false);
    expect(hasMedia(facts({ frames: [{ src: 'https://maps.example.org/embed', transcriptNearby: false }] }))).toBe(false);
    expect(hasMedia(facts({ frames: [{ src: 'https://www.youtube-nocookie.com/embed/abcdefghijk', transcriptNearby: false }] }))).toBe(true);
    expect(hasMedia(facts({ links: [{ href: 'https://e.org/a.mp3', text: 'a', transcriptNearby: false }] }))).toBe(true);
    // A link to a YouTube video's page (plan C14) is listed, but is not media on the page.
    expect(hasMedia(facts({ links: [{ href: 'https://youtu.be/abcdefghijk', text: 'a', transcriptNearby: false }] }))).toBe(false);
    expect(hasMedia(facts({ elements: [{ tag: 'audio', src: '', tracks: [], autoplay: false, muted: false, controls: true, transcriptNearby: false }] }))).toBe(true);
  });

  it('mutes from before the page loads: its init script gets a page of its own; the CLI launches Chromium with --mute-audio', () => {
    expect(mediaPlayersProbe.initScript).toContain('attachShadow');
    expect(mediaPlayersProbe.initScript).toContain('AudioContext');
    expect(groupProbes([...PROBES]).find((g) => g.probes.includes(mediaPlayersProbe))!.probes).toEqual([mediaPlayersProbe]);
    expect(BROWSER_ARGS).toContain('--mute-audio');
    expect(readFileSync(new URL('../../src/cli.ts', import.meta.url), 'utf8')).toContain('chromium.launch({ args: [...BROWSER_ARGS] })');
  });
});
