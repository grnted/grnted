// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.8: the pure rules behind the media-players probe (control names, live addresses, transcript
// and audio-description links, and the verdicts per player, audio item and native video).
import { describe, expect, it } from 'vitest';
import { classifyPlayer } from '../../src/media/detect.js';
import {
  captionsOf, controlKind, fillPage, isLivePlayerUrl, judgeAudio, judgeNativeVideo, judgePlayer, linkKind, liveOf, LIVE_TEXT_SOURCE,
  type Nearby, type PlayerObservation, type PlayerState,
} from '../../src/media/players.js';
import type { ProbeFinding } from '../../src/types.js';

const state = (over: Partial<PlayerState> = {}): PlayerState => ({
  url: 'https://www.youtube.com/embed/abcdefghijk', controls: [], video: { count: 1, playing: false, currentTime: 0, duration: null, muted: true },
  liveBadge: false, playerLive: null, tracks: null, tracksFinal: false, error: null, lang: 'en', timeline: false, ...over,
});
const cc = (over: Partial<PlayerState['controls'][number]> = {}) => ({ name: 'Subtitles/closed captions (c)', displayed: true, disabled: false, ...over });
const pause = { name: 'Pause (k)', displayed: true, disabled: false };
const obs = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
  url: 'https://www.youtube.com/embed/abcdefghijk', target: 'https://www.youtube.com/embed/abcdefghijk', outcome: 'tested',
  state: state(), started: false, clicked: false, covered: false, unmuted: false, blocked: [], frames: { taken: 0, distinct: 0 }, ...over,
});
const by = (findings: ProbeFinding[], criterion: string) => findings.filter((f) => f.criterion === criterion);
const one = (findings: ProbeFinding[], criterion: string) => {
  const list = by(findings, criterion);
  if (list.length !== 1) throw new Error(`${criterion}: ${JSON.stringify(findings)}`);
  return list[0]!;
};
const WORDS = /\b(passes|passed|compliant|compliance|certified|person|manual|manually|by hand)\b/i;

describe('player control names', () => {
  it('tells play, pause, captions and audio-description controls apart', () => {
    for (const n of ['Play', 'Play (k)', 'Play video', 'play']) expect(controlKind(n), n).toBe('play');
    for (const n of ['Pause', 'Pause (k)']) expect(controlKind(n), n).toBe('pause');
    for (const n of ['Subtitles/closed captions (c)', 'CC', 'Captions', 'Subtitles', 'Turn on captions', 'CC/subtitles']) expect(controlKind(n), n).toBe('captions');
    for (const n of ['Audio description', 'Audio described version', 'Descriptive audio']) expect(controlKind(n), n).toBe('description');
  });

  it('never treats cast, playlist, speed, next or settings controls as play', () => {
    for (const n of ['Play on TV', 'Playlist', 'Playback speed', 'Play next', 'Play all', 'AirPlay', 'Settings', 'Share', 'Watch on YouTube', 'Subscribe', '']) {
      expect(controlKind(n), n).not.toBe('play');
    }
    expect(controlKind('Subscribe')).not.toBe('captions');
  });
});

describe('live addresses', () => {
  it('recognises live-stream player addresses', () => {
    expect(isLivePlayerUrl('https://www.youtube.com/embed/live_stream?channel=UC123')).toBe(true);
    expect(isLivePlayerUrl('https://www.youtube-nocookie.com/embed/live_stream?channel=UC1')).toBe(true);
    expect(isLivePlayerUrl('https://vimeo.com/event/123456/embed')).toBe(true);
    expect(isLivePlayerUrl('https://www.youtube.com/embed/abcdefghijk')).toBe(false);
    expect(isLivePlayerUrl('https://player.vimeo.com/video/123')).toBe(false);
    expect(isLivePlayerUrl('not a url')).toBe(false);
  });

  it('classifies Vimeo live events as Vimeo players', () => {
    expect(classifyPlayer('https://vimeo.com/event/123456/embed')).toMatchObject({ player: 'vimeo', content: 'video' });
    expect(classifyPlayer('https://vimeo.com/123456')).toBeUndefined();
  });
});

describe('transcript and audio-description links', () => {
  it('reads a link name or address', () => {
    expect(linkKind('Read the transcript')).toBe('transcript');
    expect(linkKind('Download', '/media/board-meeting-transcript.pdf')).toBe('transcript');
    expect(linkKind('Text version')).toBe('transcript');
    expect(linkKind('Watch the audio-described version')).toBe('described');
    expect(linkKind('Version with audio description')).toBe('described');
    expect(linkKind('Download the agenda', '/agenda.pdf')).toBeUndefined();
    expect(linkKind('Advertise with us', '/ads')).toBeUndefined();
    // "with descriptions" alone is ordinary text, not an audio-described version.
    expect(linkKind('A video with descriptions of our programs')).toBeUndefined();
    expect(linkKind('With audio description')).toBe('described');
  });
});

describe('caption availability from the player', () => {
  it('a captions control that is shown and enabled means captions are offered', () => {
    expect(captionsOf(state({ controls: [cc()] }), false)).toMatchObject({ state: 'available', via: expect.stringContaining('Subtitles/closed captions (c)') });
  });
  it('a disabled or "unavailable" captions control means none', () => {
    expect(captionsOf(state({ controls: [cc({ disabled: true })] }), true).state).toBe('none');
    expect(captionsOf(state({ controls: [cc({ name: 'Subtitles/closed captions unavailable' })] }), true).state).toBe('none');
  });
  it('a hidden captions control or none at all, once the player started and shows its controls, means none', () => {
    expect(captionsOf(state({ controls: [cc({ displayed: false }), pause] }), true).state).toBe('none');
    expect(captionsOf(state({ controls: [pause] }), true).state).toBe('none');
  });
  it('a player that did not start or shows no controls is unknown', () => {
    expect(captionsOf(state({ controls: [] }), false).state).toBe('unknown');
    expect(captionsOf(state({ controls: [] }), true).state).toBe('unknown');
    expect(captionsOf(state({ controls: [cc({ displayed: false })] }), false).state).toBe('unknown');
  });
  it('the player\'s own caption list wins: automatic-only tracks, uploaded tracks, a final empty list', () => {
    expect(captionsOf(state({ tracks: [{ kind: 'asr', label: 'English (auto-generated)' }], controls: [cc()] }), true).state).toBe('auto-only');
    expect(captionsOf(state({ tracks: [{ kind: 'asr', label: 'a' }, { kind: '', label: 'English' }] }), true).state).toBe('available');
    expect(captionsOf(state({ tracks: [], tracksFinal: true, controls: [pause] }), true).state).toBe('none');
    // An empty list that may just not be loaded yet decides nothing.
    expect(captionsOf(state({ tracks: [], tracksFinal: false, controls: [cc()] }), true).state).toBe('available');
  });
});

describe('live detection', () => {
  it('from the player data, a LIVE badge, an endless video or the address', () => {
    expect(liveOf(obs({ state: state({ playerLive: true }) }))).toBe(true);
    expect(liveOf(obs({ state: state({ liveBadge: true }) }))).toBe(true);
    expect(liveOf(obs({ state: state({ video: { count: 1, playing: true, currentTime: 2, duration: 'infinite', muted: true } }) }))).toBe(true);
    expect(liveOf(obs({ url: 'https://www.youtube.com/embed/live_stream?channel=x' }))).toBe(true);
  });
  it('not live once it played with no live sign, or when its data or length says so; unknown otherwise', () => {
    expect(liveOf(obs({ state: state({ playerLive: false }) }))).toBe(false);
    expect(liveOf(obs({ started: true, state: state({ playerLive: false }) }))).toBe(false);
    // Playing proves nothing either way (round 2): no sign, unknown.
    expect(liveOf(obs({ started: true }))).toBeUndefined();
    expect(liveOf(obs({ started: false }))).toBeUndefined();
    expect(liveOf(obs({ outcome: 'not-loaded', state: undefined }))).toBeUndefined();
  });
});

describe('judgePlayer', () => {
  const none: Nearby = {};

  it('captions offered: 1.2.2 cannot be tested for accuracy (no access to the audio); 1.2.4 not applicable', () => {
    const f = judgePlayer(obs({ started: true, clicked: true, state: state({ controls: [cc(), pause], playerLive: false }) }), none);
    expect(one(f, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('the platform does not give automated tools access to the audio') });
    expect(one(f, '1.2.2').detail).toContain('offers captions');
    expect(one(f, '1.2.4')).toMatchObject({ status: 'not_applicable' });
  });

  it('red (the cut round, review media-v S8): no captions offered, and automatic captions only, are undecided, never failed: the test did not assess the sound or the picture', () => {
    // The same observation for a video of signing with no sound, a video of music only, and a video with its captions
    // in the picture: none of them needs a captions track, and the player looks the same for all three.
    for (const kind of ['a video of signing', 'music only', 'captions in the picture']) {
      const f = judgePlayer(obs({ started: true, clicked: true, state: state({ controls: [pause] }) }), none);
      expect(one(f, '1.2.2'), kind).toMatchObject({ status: 'not_testable', target: 'https://www.youtube.com/embed/abcdefghijk', detail: expect.stringContaining('was not assessed') });
    }
    const auto = judgePlayer(obs({ started: true, state: state({ tracks: [{ kind: 'asr', label: 'English (auto-generated)' }] }) }), none);
    expect(one(auto, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('automatic') });
  });

  it('a live stream: captions decide 1.2.4; the prerecorded criteria do not apply', () => {
    const live = judgePlayer(obs({ started: true, state: state({ liveBadge: true, controls: [pause] }) }), none);
    // The cut round (review media-v, S8): no captions on a live stream whose sound was not assessed is undecided.
    expect(one(live, '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('was not assessed') });
    for (const c of ['1.2.2', '1.2.3', '1.2.5']) expect(one(live, c).status, c).toBe('not_applicable');
    const withCc = judgePlayer(obs({ started: true, state: state({ liveBadge: true, controls: [cc(), pause] }) }), none);
    expect(one(withCc, '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('access to the audio') });
  });

  it('a player with a positive on-demand sign is not live, unless the page calls it live', () => {
    const played = obs({ started: true, state: state({ controls: [cc(), pause], timeline: true }) });
    expect(one(judgePlayer(played, {}), '1.2.4').status).toBe('not_applicable');
    expect(one(judgePlayer(played, { liveText: 'Watch live' }), '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('Watch live') });
  });

  it('a player that never started: captions and live are not testable, with the stopped requests as the reason', () => {
    const f = judgePlayer(obs({ started: false, clicked: true, blocked: ['POST request to http://www.youtube.com/youtubei/v1/player'] }), none);
    expect(one(f, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('did not start') });
    expect(one(f, '1.2.2').detail).toContain('POST request to http://www.youtube.com/youtubei/v1/player');
    expect(one(f, '1.2.4').status).toBe('not_testable');
  });

  it('stopped requests do not change a result the test observed', () => {
    const f = judgePlayer(obs({ started: true, clicked: true, blocked: ['POST request to http://www.youtube.com/youtubei/v1/log_event'], state: state({ controls: [pause] }) }), none);
    expect(one(f, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('the player offers no captions') });
  });

  it('a covered, hidden, unloaded or unreadable player is not testable with its reason, never clean', () => {
    for (const [o, re] of [
      [obs({ outcome: 'not-loaded', reason: 'the player did not load', state: undefined }), /did not load/],
      [obs({ outcome: 'unreadable', reason: 'the player could not be read', state: undefined }), /could not be read/],
      [obs({ covered: true }), /covers the player/],
      [obs({ outcome: 'hidden', reason: 'the player is hidden on the page', state: undefined }), /hidden/],
      [obs({ outcome: 'time', reason: 'the time box ran out before this player was tested', state: undefined }), /time box/],
    ] as const) {
      const f = judgePlayer(o, none);
      for (const c of ['1.2.2', '1.2.4']) expect(one(f, c), c).toMatchObject({ status: 'not_testable', detail: expect.stringMatching(re) });
      for (const c of ['1.2.3', '1.2.5']) expect(one(f, c).status, c).toBe('not_testable');
      expect(f.map((x) => x.status)).not.toContain('no_failures_found');
    }
  });

  it('a player that turned its sound on is stopped and not judged', () => {
    const f = judgePlayer(obs({ started: true, unmuted: true, state: state({ controls: [cc(), pause] }) }), none);
    expect(one(f, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('sound') });
  });

  it('a player error is the reason', () => {
    const f = judgePlayer(obs({ clicked: true, state: state({ error: 'Video unavailable' }) }), none);
    expect(one(f, '1.2.2')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('Video unavailable') });
  });

  it('1.2.3 and 1.2.5: an audio-described version next to it; a transcript covers 1.2.3 only; nothing decides neither', () => {
    const tested = obs({ started: true, state: state({ controls: [cc(), pause] }) });
    const ad = judgePlayer(tested, { described: 'Audio-described version' });
    expect([one(ad, '1.2.3').status, one(ad, '1.2.5').status]).toEqual(['no_failures_found', 'no_failures_found']);
    const tr = judgePlayer(tested, { transcript: 'Read the transcript' });
    expect([one(tr, '1.2.3').status, one(tr, '1.2.5').status]).toEqual(['no_failures_found', 'not_testable']);
    expect(one(tr, '1.2.5').detail).toContain('access to the audio');
    const nothing = judgePlayer(tested, {});
    expect([one(nothing, '1.2.3').status, one(nothing, '1.2.5').status]).toEqual(['not_testable', 'not_testable']);
    // The links decide even when the player itself could not be tested.
    const unloaded = judgePlayer(obs({ outcome: 'not-loaded', reason: 'x', state: undefined }), { described: 'Described version' });
    expect([one(unloaded, '1.2.3').status, one(unloaded, '1.2.5').status]).toEqual(['no_failures_found', 'no_failures_found']);
    // An audio-description control inside the player counts too.
    const control = judgePlayer(obs({ started: true, state: state({ controls: [cc(), pause, { name: 'Audio description', displayed: true, disabled: false }] }) }), {});
    expect(one(control, '1.2.5').status).toBe('no_failures_found');
  });

  it('never words a result as passed, compliant or for a person to check', () => {
    const all = [
      judgePlayer(obs({ started: true, state: state({ controls: [cc(), pause] }) }), {}),
      judgePlayer(obs({ started: true, state: state({ controls: [pause] }) }), { transcript: 't' }),
      judgePlayer(obs({ outcome: 'not-loaded', reason: 'the player did not load', state: undefined }), {}),
      judgePlayer(obs({ started: true, state: state({ liveBadge: true, controls: [cc()] }) }), {}),
    ].flat();
    for (const f of all) expect(f.detail, f.detail).not.toMatch(WORDS);
  });
});

describe('judgeAudio (1.2.1)', () => {
  it('red (the cut round, review media-v S3): a link right beside a recording that is not read as a transcript may lead to one: undecided, never failed', () => {
    expect(judgeAudio({ target: '/a.mp3', what: 'this audio player', recorded: 'yes' }, { adjacentLink: 'Episode notes' })).toMatchObject({ criterion: '1.2.1', status: 'not_testable', detail: expect.stringContaining('a link right beside it ("Episode notes") may lead to one') });
    // A transcript found wins over the link; a recording not shown to be one stays undecided for that reason.
    expect(judgeAudio({ target: '/a.mp3', what: 'this audio player', recorded: 'yes' }, { transcript: 'Transcript', adjacentLink: 'Episode notes' }).status).toBe('no_failures_found');
    expect(judgeAudio({ target: '/a.mp3', what: 'this audio player', recorded: 'live' }, { adjacentLink: 'Episode notes' }).detail).toContain('no set length');
  });

  it('a transcript next to it gives no failure; a recording with none found is listed for a person to check, never failed (batch 17\'s cut)', () => {
    expect(judgeAudio({ target: '/a.mp3', what: 'an audio file', recorded: 'yes' }, { transcript: 'Transcript' })).toMatchObject({ criterion: '1.2.1', status: 'no_failures_found' });
    expect(judgeAudio({ target: '/a.mp3', what: 'an audio file', recorded: 'yes' }, {})).toMatchObject({ criterion: '1.2.1', status: 'not_testable', target: '/a.mp3', detail: expect.stringContaining('no transcript was found next to an audio file') });
    expect(judgeAudio({ target: '/a.mp3', what: 'an audio file', recorded: 'yes' }, {}).detail).toContain('for a person to check');
  });

  // Fix round 1, S4: 1.2.1 covers prerecorded audio only.
  it('red: a live stream with no transcript is not failed (the browser read no end for it): undecided', () => {
    const f = judgeAudio({ target: 'https://radio.example/live.mp3', what: 'this audio player', recorded: 'live' }, {});
    expect(f).toMatchObject({ criterion: '1.2.1', status: 'not_testable' });
    expect(f.detail).toContain('has no set length (the browser read no end for it: a live stream');
    expect(f.detail).toContain('recordings only');
  });

  it('red: a player the page calls live is not failed, whatever its file says: undecided, with the page\'s words', () => {
    for (const recorded of ['yes', 'unknown', undefined] as const) {
      const f = judgeAudio({ target: '/council.mp3', what: 'this audio player', ...(recorded ? { recorded } : {}) }, { liveText: 'Listen live' });
      expect(f, String(recorded)).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('the page calls this audio player live ("Listen live")') });
    }
  });

  it('red: an item whose length the test could not read may be live: undecided, never failed', () => {
    for (const item of [{ target: '/a.m3u8', what: 'this audio player', recorded: 'unknown' as const }, { target: '/a.mp3', what: 'the linked audio file ("Listen")' }]) {
      expect(judgeAudio(item, {})).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('whether it is a recording or a live stream could not be told') });
    }
  });

  it('the page\'s words for live: for video and for sound; words that only hold "live" are not it', () => {
    const live = new RegExp(LIVE_TEXT_SOURCE, 'i');
    for (const text of ['Watch live', 'Live stream of the meeting', 'Listen live from six thirty this evening.', 'Live audio from the chamber', 'Our live radio feed', 'streaming live now']) expect(live.test(text), text).toBe(true);
    for (const text of ['Lives of the councillors', 'Delivered live music lessons last year', 'A lively debate', 'Recorded on Tuesday', 'Listen to the recording']) expect(live.test(text), text).toBe(false);
  });

  it('look-alike: a live stream with a transcript beside it is as clean as a recording with one', () => {
    expect(judgeAudio({ target: '/live.mp3', what: 'this audio player', recorded: 'live' }, { transcript: 'Transcript of the broadcast', liveText: 'live now' })).toMatchObject({ status: 'no_failures_found' });
  });
});

describe('judgeNativeVideo', () => {
  const base = { target: '/v.webm', tracks: [] as { kind: string }[], textTracks: 0, duration: 12 as number | 'infinite' | null, decorative: false, src: 'https://e.org/v.webm' };
  it('red (the cut round, review media-v S8): a video with no end and no captions track is undecided for 1.2.4: it may be a recording whose file gives no length', () => {
    expect(one(judgeNativeVideo({ ...base, duration: 'infinite' }, {}), '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('a recording whose file gives no length') });
    expect(one(judgeNativeVideo({ ...base, duration: 'infinite', tracks: [{ kind: 'captions' }] }, {}), '1.2.4')).toMatchObject({ status: 'not_testable' });
  });
  it('prerecorded: a descriptions track or described version gives no failure; otherwise the AI media review decides', () => {
    const f = judgeNativeVideo({ ...base, tracks: [{ kind: 'descriptions' }] }, {});
    expect([one(f, '1.2.3').status, one(f, '1.2.5').status]).toEqual(['no_failures_found', 'no_failures_found']);
    const g = judgeNativeVideo(base, {});
    expect(one(g, '1.2.5')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('--ai-media') });
    expect(by(g, '1.2.4')).toEqual([]);
  });
  it('a video a script streams that had not loaded: 1.2.4 cannot be told; a plain file is prerecorded', () => {
    expect(one(judgeNativeVideo({ ...base, src: '', duration: null }, {}), '1.2.4')).toMatchObject({ status: 'not_testable', detail: expect.stringContaining('streamed by a script') });
    expect(one(judgeNativeVideo({ ...base, src: 'https://e.org/live/index.m3u8', duration: null }, {}), '1.2.4').status).toBe('not_testable');
    expect(by(judgeNativeVideo({ ...base, duration: null }, {}), '1.2.4')).toEqual([]);
  });

  it('a decorative background video (muted, no controls) is left to the video rules', () => {
    expect(judgeNativeVideo({ ...base, decorative: true }, {})).toEqual([]);
  });
});

describe('fillPage', () => {
  it('gives every criterion an explicit result: not applicable when nothing on the page was tested for it', () => {
    const f = fillPage([], { audio: 0, players: 0, videos: 0 });
    expect(f.map((x) => [x.criterion, x.status])).toEqual([
      ['1.2.1', 'not_applicable'], ['1.2.2', 'not_applicable'], ['1.2.3', 'not_applicable'], ['1.2.4', 'not_applicable'], ['1.2.5', 'not_applicable'],
    ]);
    const kept = fillPage([{ criterion: '1.2.2', status: 'failed', detail: 'x' }], { audio: 0, players: 1, videos: 0 });
    expect(kept.filter((x) => x.criterion === '1.2.2')).toEqual([{ criterion: '1.2.2', status: 'failed', detail: 'x' }]);
  });
});
