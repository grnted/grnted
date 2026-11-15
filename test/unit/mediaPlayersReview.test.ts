// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Task 4.8 review round 1: the rules fixes (caption list vs control, description controls, localized
// control names, unrecognised control bars, not-live evidence, transcript and described links).
import { describe, expect, it } from 'vitest';
import {
  captionsOf, controlKind, judgePlayer, linkKind, liveOf, type PlayerObservation, type PlayerState,
} from '../../src/media/players.js';
import type { ProbeFinding } from '../../src/types.js';

const state = (over: Partial<PlayerState> = {}): PlayerState => ({
  url: 'https://www.youtube.com/embed/abcdefghijk', controls: [], video: { count: 1, playing: false, currentTime: 0, duration: null, muted: true },
  liveBadge: false, playerLive: null, tracks: null, tracksFinal: false, error: null, lang: 'en', timeline: false, ...over,
});
const ctl = (name: string, over: Partial<PlayerState['controls'][number]> = {}) => ({ name, displayed: true, disabled: false, ...over });
const obs = (over: Partial<PlayerObservation> = {}): PlayerObservation => ({
  url: 'https://www.youtube.com/embed/abcdefghijk', target: 'https://www.youtube.com/embed/abcdefghijk', outcome: 'tested',
  state: state(), started: false, clicked: false, covered: false, unmuted: false, blocked: [], frames: { taken: 0, distinct: 0 }, ...over,
});
const one = (findings: ProbeFinding[], criterion: string) => {
  const list = findings.filter((f) => f.criterion === criterion);
  if (list.length !== 1) throw new Error(`${criterion}: ${JSON.stringify(findings)}`);
  return list[0]!;
};

describe('#1 caption list vs captions control', () => {
  it('an enabled, shown captions control means captions are offered even when the list is empty', () => {
    expect(captionsOf(state({ tracks: [], tracksFinal: true, controls: [ctl('Subtitles/closed captions (c)'), ctl('Pause (k)')] }), true).state).toBe('available');
  });
  it('an empty final list with no captions control still means none', () => {
    expect(captionsOf(state({ tracks: [], tracksFinal: true, controls: [ctl('Pause (k)')] }), true).state).toBe('none');
  });
});

describe('#2 audio-description controls', () => {
  const played = (controls: PlayerState['controls']) => obs({ started: true, state: state({ controls: [ctl('Subtitles/closed captions (c)'), ctl('Pause (k)'), ...controls] }) });
  it('a disabled or "unavailable" description control is ignored', () => {
    for (const c of [ctl('Audio description unavailable'), ctl('Audio description', { disabled: true }), ctl('Audio description not available')]) {
      const f = judgePlayer(played([c]), {});
      expect([one(f, '1.2.3').status, one(f, '1.2.5').status], c.name).toEqual(['not_testable', 'not_testable']);
    }
    expect(one(judgePlayer(played([ctl('Audio description')]), {}), '1.2.5').status).toBe('no_failures_found');
  });
  it('a control named for both captions and description still counts as a captions control', () => {
    expect(captionsOf(state({ controls: [ctl('Subtitles and audio description'), ctl('Pause (k)')] }), true).state).toBe('available');
  });
});

describe('#7 localized names and unrecognised control bars', () => {
  it('knows play, pause and captions in the languages the big players ship', () => {
    const play = ['Lire (k)', 'Reproducir (k)', 'Wiedergabe (k)', 'Reproduzir', 'Riproduci (k)', 'Afspelen (k)', '再生（k）', '播放', '재생(k)'];
    const pause = ['Pausa (k)', 'Pause (k)', 'Pausar', 'Onderbreken (k)', 'Pauzeren', '一時停止（k）', '暂停', '暫停', '일시중지(k)'];
    const cc = ['Sous-titres (c)', 'Subtítulos (c)', 'Untertitel (c)', 'Legendas', 'Sottotitoli (c)', 'Ondertiteling', '字幕（c）', '字幕', '자막'];
    for (const n of play) expect(controlKind(n), n).toBe('play');
    for (const n of pause) expect(controlKind(n), n).toBe('pause');
    for (const n of cc) expect(controlKind(n), n).toBe('captions');
    for (const n of ['再生速度', '播放列表', 'Lire la suite', 'Reproducir en TV']) expect(controlKind(n), n).not.toBe('play');
    expect(captionsOf(state({ lang: 'fr', controls: [ctl('Sous-titres non disponibles', { disabled: true }), ctl('Pause (k)')] }), true).state).toBe('none');
  });
  it('a bar whose language the rules do not know, or that shows no recognised control, is unknown, not "none"', () => {
    expect(captionsOf(state({ lang: 'sv', controls: [ctl('Pausa'), ctl('Undertexter')] }), true).state).toBe('unknown');
    expect(captionsOf(state({ lang: '', controls: [ctl('Pause')] }), true).state).toBe('unknown');
    expect(captionsOf(state({ lang: 'en', controls: [ctl('Volume'), ctl('Settings')] }), true).state).toBe('unknown');
    // A recognised bar in a known language with no captions control: none.
    expect(captionsOf(state({ lang: 'en-GB', controls: [ctl('Pause (k)'), ctl('Settings')] }), true).state).toBe('none');
    expect(captionsOf(state({ lang: 'de', controls: [ctl('Pause (k)')] }), true).state).toBe('none');
  });
});

describe('lead: an ordinary on-demand video is not live', () => {
  it('a finite length, the player data, or a seekable timeline without a live badge', () => {
    expect(liveOf(obs({ state: state({ video: { count: 1, playing: false, currentTime: 0, duration: 212, muted: true } }) }))).toBe(false);
    expect(liveOf(obs({ state: state({ playerLive: false }) }))).toBe(false);
    expect(liveOf(obs({ state: state({ timeline: true }) }))).toBe(false);
    expect(liveOf(obs({ state: state({ timeline: true, liveBadge: true }) }))).toBe(true);
    expect(liveOf(obs({ state: state({}) }))).toBeUndefined();
  });
  it('a player that did not start but says it is not live: 1.2.4 not applicable, captions still not testable', () => {
    const f = judgePlayer(obs({ clicked: true, state: state({ playerLive: false }) }), {});
    expect(one(f, '1.2.4')).toMatchObject({ status: 'not_applicable', detail: 'not a live stream.' });
    expect(one(f, '1.2.2').status).toBe('not_testable');
  });
});

describe('#9 transcript and described links: the phrase, not a substring', () => {
  it('reads the link name or the final path segment', () => {
    expect(linkKind('Read the transcript', '/transcripts/march.html')).toBe('transcript');
    expect(linkKind('Transcript of episode 2', '/ep2.html')).toBe('transcript');
    expect(linkKind('Download (PDF)', '/files/board-meeting-transcript.pdf')).toBe('transcript');
    expect(linkKind('Text version', '/x')).toBe('transcript');
    expect(linkKind('Download captions', '/media/talk-captions.vtt')).toBe('transcript');
    expect(linkKind('Subtitles (SRT)', '/media/talk.srt')).toBe('transcript');
    expect(linkKind('Watch the audio-described version', '/v/described.html')).toBe('described');
    expect(linkKind('Version with audio description', '/v')).toBe('described');
    expect(linkKind('Video', '/media/science-fair-audio-described.html')).toBe('described');
  });
  it('ignores unrelated copy that only contains the words', () => {
    expect(linkKind('Transcription services', '/services')).toBeUndefined();
    expect(linkKind('Learn about audio description', '/accessibility')).toBeUndefined();
    expect(linkKind('Request a transcript of your grades', '/registrar')).toBeUndefined();
    expect(linkKind('Captions policy', '/policies/captions.html')).toBeUndefined();
    expect(linkKind('Contact us', '/transcripts-office')).toBeUndefined();
  });
});

describe('review round 2', () => {
  it('#1 playing is not proof a video is on demand: no positive signal either way stays unknown', () => {
    expect(liveOf(obs({ started: true }))).toBeUndefined();
    expect(liveOf(obs({ started: true, state: state({ controls: [ctl('Pause (k)')] }) }))).toBeUndefined();
    const f = judgePlayer(obs({ started: true, clicked: true, state: state({ controls: [ctl('Pause (k)')] }) }), {});
    expect(one(f, '1.2.4')).toMatchObject({ status: 'not_testable' });
    // A positive on-demand signal still decides.
    expect(liveOf(obs({ started: true, state: state({ playerLive: false }) }))).toBe(false);
  });

  it('#3 a control whose name says there are no captions means none, even when it is enabled', () => {
    for (const name of ['No captions are available for this video', 'No captions available', 'No captions', 'Captions are not available', 'Captions unavailable',
      'Aucun sous-titre disponible', 'Sin subtítulos', 'Keine Untertitel verfügbar', 'Sem legendas', 'Nessun sottotitolo', 'Geen ondertiteling', '字幕はありません', '无字幕', '자막 없음']) {
      expect(captionsOf(state({ controls: [ctl(name), ctl('Pause (k)')] }), true).state, name).toBe('none');
    }
    expect(captionsOf(state({ controls: [ctl('Subtitles/closed captions (c)')] }), true).state).toBe('available');
  });
});
