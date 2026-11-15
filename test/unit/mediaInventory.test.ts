// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import { describe, expect, it } from 'vitest';
import type { MediaElementFact, MediaFacts } from '../../src/collect/media.js';
import { classifyPlayer, mediaFileType } from '../../src/media/detect.js';
import { isCaptionsTrack, mediaIssues, mediaItems } from '../../src/media/index.js';
import { formatTime, parseVtt } from '../../src/media/vtt.js';
import type { MediaItem, PageAudit } from '../../src/types.js';

const el = (over: Partial<MediaElementFact> = {}): MediaElementFact => ({
  tag: 'video', audio: 'present', src: 'https://e.org/v.mp4', tracks: [], autoplay: false, muted: false, controls: true, loop: false, transcriptNearby: false, ...over,
});
const page = (url: string, facts: Partial<MediaFacts>, over: Partial<PageAudit> = {}): PageAudit => ({
  url, status: 'ok', rules: {}, violations: [], incomplete: [], links: [],
  collected: { media: { elements: [], frames: [], links: [], ...facts } }, ...over,
});
const rules = (items: MediaItem[]) => items.map((i) => [i.kind, i.url, i.captions, i.issues.map((x) => `${x.level} ${x.criterion} ${x.rule}`)]);

it('describes the unchecked YouTube embed without attributing it to provider terms', () => {
  const item = mediaItems([page('https://fixture.example/video', { frames: [{ src: 'https://www.youtube.com/embed/M7lc1UVf-VE', title: 'YouTube video: welcome to the library', transcriptNearby: false }] })])[0]!;
  const message = item.issues.find((i) => i.rule === 'check-captions-manually')!.message;
  expect(message).toContain("Embedded players are not downloaded, so their captions and audio description weren't checked.");
  expect(message).not.toMatch(/terms of service/i);
});

describe('media detection', () => {
  it('recognises player iframes by address, with YouTube and Vimeo video ids', () => {
    expect(classifyPlayer('https://www.youtube.com/embed/aBcDeFgHiJ0?si=x')).toEqual({ player: 'youtube', content: 'video', videoId: 'aBcDeFgHiJ0' });
    expect(classifyPlayer('https://www.youtube-nocookie.com/embed/aBcDeFgHiJ0')).toEqual({ player: 'youtube', content: 'video', videoId: 'aBcDeFgHiJ0' });
    expect(classifyPlayer('https://www.youtube.com/embed/videoseries?list=PL1')).toEqual({ player: 'youtube', content: 'video' });
    expect(classifyPlayer('https://www.youtube.com/watch?v=aBcDeFgHiJ0')).toBeUndefined();
    expect(classifyPlayer('https://player.vimeo.com/video/76979871?h=1')).toEqual({ player: 'vimeo', content: 'video', videoId: '76979871' });
    const players = [
      'https://fast.wistia.net/embed/iframe/abc', 'https://players.brightcove.net/1/default_default/index.html?videoId=2',
      'https://cdnapisec.kaltura.com/p/1/sp/100/embedIframeJs/uiconf_id/2', 'https://x.hosted.panopto.com/Panopto/Pages/Embed.aspx?id=1',
      'https://web.microsoftstream.com/embed/video/1', 'https://www.facebook.com/plugins/video.php?href=x', 'https://play.vidyard.com/abc',
      'https://www.dailymotion.com/embed/video/x1', 'https://player.twitch.tv/?video=1', 'https://www.loom.com/embed/abc',
      'https://boxcast.tv/view-embed/abc', 'https://district.new.swagit.com/videos/1/embed', 'https://district.granicus.com/MediaPlayer.php?clip_id=1',
      'https://district.iqm2.com/Citizens/SplitView.aspx?Mode=Video',
    ];
    expect(players.map((u) => classifyPlayer(u)?.player)).toEqual([
      'wistia', 'brightcove', 'kaltura', 'panopto', 'microsoft-stream', 'facebook', 'vidyard', 'dailymotion', 'twitch', 'loom', 'boxcast', 'swagit', 'granicus', 'iqm2',
    ]);
    const podcasts = ['https://open.spotify.com/embed/episode/1', 'https://w.soundcloud.com/player/?url=x', 'https://www.buzzsprout.com/1/2', 'https://embed.podcasts.apple.com/us/podcast/x/id1'];
    expect(podcasts.map((u) => classifyPlayer(u))).toEqual(podcasts.map(() => expect.objectContaining({ content: 'audio' })));
    for (const u of ['https://www.google.com/maps/embed?pb=1', 'https://docs.google.com/forms/d/e/1/viewform', 'https://district.granicus.com/AgendaViewer.php', 'javascript:alert(1)', 'not a url']) {
      expect(classifyPlayer(u)).toBeUndefined();
    }
  });

  it('tells video files from audio files by extension', () => {
    expect(mediaFileType('https://e.org/a/b.MP4?x=1')).toBe('video');
    expect(mediaFileType('https://e.org/b.webm')).toBe('video');
    expect(mediaFileType('https://e.org/c.mp3')).toBe('audio');
    expect(mediaFileType('https://e.org/c.m4a')).toBe('audio');
    expect(mediaFileType('https://e.org/c.mp3.html')).toBeUndefined();
    expect(mediaFileType('nope')).toBeUndefined();
  });
});

describe('media rules', () => {
  const item = (over: Partial<MediaItem>): Omit<MediaItem, 'issues'> => ({ kind: 'video', content: 'video', audio: 'present', url: 'u', foundOn: [], captions: 'none', ...over });
  const ids = (over: Partial<MediaItem>) => mediaIssues(item(over)).map((i) => `${i.level} ${i.criterion} ${i.rule}`);

  it('review round 2, finding 3: a native video with no captions track is a possible 1.2.2 problem, never a definite one (its captions may be part of the picture)', () => {
    // `<video controls src="open-captioned.mp4">`: no track, sound present or not known.
    expect(ids({ captions: 'none', controls: true })).toEqual(['review 1.2.2 no-captions-track']);
    expect(ids({ captions: 'none', controls: true, autoplay: false, muted: false })).toEqual(['review 1.2.2 no-captions-track']);
    expect(mediaIssues(item({ captions: 'none', controls: true }))[0]!.message).toContain('part of the picture');
    expect(ids({ captions: 'track', controls: true })).toEqual([]);
    expect(isCaptionsTrack({ kind: 'subtitles', src: 'x.vtt' })).toBe(true);
    expect(isCaptionsTrack({ kind: 'captions' })).toBe(false);
    expect(isCaptionsTrack({ kind: 'descriptions', src: 'x.vtt' })).toBe(false);
  });

  it('unknown audio requires review for captions and autoplay, rather than a definite failure', () => {
    expect(ids({ audio: undefined, controls: true })).toEqual(['review 1.2.2 no-captions-track']);
    expect(ids({ audio: undefined, autoplay: true, controls: false })).toEqual(['review 1.4.2 autoplay-sound-no-controls', 'review 1.2.2 no-captions-track']);
  });

  it('a muted video without controls needs no captions, only a check that it is decoration (1.2.1)', () => {
    expect(ids({ captions: 'none', muted: true, controls: false, autoplay: true })).toEqual(['review 1.2.1 silent-video']);
  });

  it('a muted background video without controls that the page hides from assistive technology is decoration: nothing to report (gold harness hazard)', () => {
    expect(ids({ captions: 'none', muted: true, controls: false, decorative: true })).toEqual([]);
    // Hidden but with sound, or with controls: judged as any video.
    expect(ids({ captions: 'none', muted: false, controls: false, decorative: true })).toEqual(['review 1.2.2 no-captions-track']);
    expect(ids({ captions: 'none', muted: true, controls: true, decorative: true })).toEqual(['review 1.2.2 no-captions-track']);
  });

  it('autoplay metadata requires verification, unless muted or at most 3 seconds long', () => {
    expect(ids({ captions: 'track', autoplay: true, muted: false, controls: false })).toEqual(['review 1.4.2 autoplay-sound-no-controls']);
    expect(ids({ captions: 'track', autoplay: true, muted: false, controls: false, duration: 3 })).toEqual([]);
    expect(ids({ captions: 'track', autoplay: true, muted: false, controls: true })).toEqual([]);
    expect(ids({ kind: 'audio', content: 'audio', captions: 'transcript-nearby', transcriptNearby: true, autoplay: true, controls: false })).toEqual(['review 1.4.2 autoplay-sound-no-controls']);
  });

  it('a short sound that loops still requires autoplay verification', () => {
    expect(ids({ kind: 'audio', content: 'audio', captions: 'transcript-nearby', transcriptNearby: true, autoplay: true, controls: false, duration: 1, loop: true })).toEqual(['review 1.4.2 autoplay-sound-no-controls']);
    expect(ids({ kind: 'audio', content: 'audio', captions: 'transcript-nearby', transcriptNearby: true, autoplay: true, controls: false, duration: 1, loop: false })).toEqual([]);
  });

  it('sound-only media without a transcript nearby needs review (1.2.1)', () => {
    expect(ids({ kind: 'audio', content: 'audio', captions: 'no-transcript', transcriptNearby: false, controls: true })).toEqual(['review 1.2.1 no-transcript-nearby']);
    expect(ids({ kind: 'link', content: 'audio', captions: 'no-transcript' })).toEqual(['review 1.2.1 no-transcript-nearby']);
    expect(ids({ kind: 'embed', content: 'audio', player: 'spotify', captions: 'transcript-nearby', transcriptNearby: true })).toEqual([]);
  });

  it('embedded and linked video captions cannot be tested automatically; a report made before C14 keeps its YouTube problem', () => {
    expect(ids({ kind: 'embed', player: 'vimeo', captions: 'check-manually' })).toEqual(['review 1.2.2 check-captions-manually']);
    expect(ids({ kind: 'link', captions: 'check-manually' })).toEqual(['review 1.2.2 check-captions-manually']);
    expect(ids({ kind: 'embed', player: 'youtube', captions: 'check-manually', uploaderCaptions: false })).toEqual(['problem 1.2.2 uploader-captions-missing']);
    const yes = mediaIssues(item({ kind: 'embed', player: 'youtube', captions: 'check-manually', uploaderCaptions: true }));
    expect(yes).toEqual([expect.objectContaining({ level: 'review', message: 'The uploader added captions on YouTube. Their accuracy cannot be tested automatically: the platform does not give automated tools its audio.' })]);
  });

  it('never says media passes or is compliant', () => {
    const all = [
      ...mediaIssues(item({ captions: 'none' })), ...mediaIssues(item({ autoplay: true, controls: false })),
      ...mediaIssues(item({ kind: 'embed', captions: 'check-manually', uploaderCaptions: false })), ...mediaIssues(item({ kind: 'link', content: 'audio', captions: 'no-transcript' })),
    ];
    expect(all.map((i) => i.message).join(' ')).not.toMatch(/\b(pass|passes|compliant|verified|certified)\b/i);
  });
});

describe('mediaItems', () => {
  it('lists elements, players and media links in page order, once per set of facts, with the pages they are on', () => {
    const a = page('https://e.org/', {
      elements: [
        el({ src: 'https://e.org/v.mp4', tracks: [{ kind: 'captions', srclang: 'en', src: 'https://e.org/v.vtt' }], duration: 61.5, poster: 'https://e.org/p.jpg', name: 'Welcome' }),
        el({ tag: 'audio', src: 'https://e.org/a.mp3', transcriptNearby: true }),
        el({ src: '', autoplay: true, muted: true, controls: false }),
      ],
      frames: [
        { src: 'https://www.youtube.com/embed/aBcDeFgHiJ0', title: 'Board meeting', transcriptNearby: false },
        { src: 'https://www.google.com/maps/embed?pb=1', title: 'Map', transcriptNearby: false },
        { src: 'https://open.spotify.com/embed/episode/1', transcriptNearby: true },
      ],
      links: [{ href: 'https://e.org/m.mp3', text: 'Minutes (MP3)', transcriptNearby: false }, { href: 'https://e.org/page', text: 'Not media', transcriptNearby: false }],
    });
    const b = page('https://e.org/b', {
      elements: [el({ src: 'https://e.org/v.mp4', tracks: [] }), el({ src: '', autoplay: true, muted: true, controls: false })],
      frames: [{ src: 'https://www.youtube.com/embed/aBcDeFgHiJ0', transcriptNearby: false }],
    });
    const failed = page('https://e.org/c', { elements: [el({ src: 'https://e.org/x.mp4' })] }, { status: 'failed' });
    const broken = { ...page('https://e.org/d', {}), collected: { media: { error: 'Collector timed out' } } };
    const items = mediaItems([a, b, failed, broken]);
    expect(rules(items)).toEqual([
      ['video', 'https://e.org/v.mp4', 'track', []],
      ['audio', 'https://e.org/a.mp3', 'transcript-nearby', []],
      ['video', '', 'none', ['review 1.2.1 silent-video']],
      ['embed', 'https://www.youtube.com/embed/aBcDeFgHiJ0', 'check-manually', ['review 1.2.2 check-captions-manually']],
      ['embed', 'https://open.spotify.com/embed/episode/1', 'transcript-nearby', []],
      ['link', 'https://e.org/m.mp3', 'no-transcript', ['review 1.2.1 no-transcript-nearby']],
      // The same file on page b has no captions track there: judged on its own facts, never merged into page a's.
      ['video', 'https://e.org/v.mp4', 'none', ['review 1.2.2 no-captions-track']],
      ['video', '', 'none', ['review 1.2.1 silent-video']],
    ]);
    expect(items[0]).toMatchObject({ foundOn: ['https://e.org/'], duration: 61.5, poster: 'https://e.org/p.jpg', name: 'Welcome' });
    expect(items[6]).toMatchObject({ foundOn: ['https://e.org/b'] });
    expect(items[3]).toMatchObject({ player: 'youtube', videoId: 'aBcDeFgHiJ0', name: 'Board meeting', foundOn: ['https://e.org/', 'https://e.org/b'] });
    // A stream with no address is listed per page, never merged.
    expect(items[2]!.foundOn).toEqual(['https://e.org/']);
    expect(items[7]!.foundOn).toEqual(['https://e.org/b']);
  });

  it('keeps at most 20 pages per item', () => {
    const pages = Array.from({ length: 25 }, (_, i) => page(`https://e.org/${i}`, { elements: [el()] }));
    expect(mediaItems(pages)[0]!.foundOn).toHaveLength(20);
  });
});

describe('WebVTT', () => {
  it('reads cue times and text, turning voice spans into speaker names and dropping markup', () => {
    const vtt = '﻿WEBVTT - Lesson\r\nKind: captions\r\n\r\nNOTE a note\r\nwith --> an arrow\r\n\r\nSTYLE\r\n::cue { color: red }\r\n\r\n1\r\n00:00:01.000 --> 00:00:04.500 align:start\r\n<v Ms. Lee>Welcome, <i>everyone</i> &amp; friends.\r\n\r\n00:05.250 --> 00:07.000\r\n<c.loud>Second</c> line\r\nwraps <00:00:06.000>here &lt;3 &#233;\r\n\r\n01:00:00.000 --> 01:00:02.000\r\n\r\nbad --> cue\r\ntext\r\n';
    expect(parseVtt(vtt)).toEqual([
      { start: 1, end: 4.5, text: 'Ms. Lee: Welcome, everyone & friends.' },
      { start: 5.25, end: 7, text: 'Second line wraps here <3 é' },
    ]);
  });

  it('rejects files that are not WebVTT (such as SRT)', () => {
    expect(parseVtt('1\n00:00:01,000 --> 00:00:02,000\nHello\n')).toBeUndefined();
    expect(parseVtt('')).toBeUndefined();
    expect(parseVtt('WEBVTT\n')).toEqual([]);
  });

  it('formats times as m:ss or h:mm:ss', () => {
    expect([formatTime(0), formatTime(5.9), formatTime(65), formatTime(600), formatTime(3725), formatTime(-1)]).toEqual(['0:00', '0:05', '1:05', '10:00', '1:02:05', '0:00']);
  });
});
