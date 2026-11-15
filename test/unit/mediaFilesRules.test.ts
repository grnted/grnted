// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The rules of the media-files test (src/media/files.ts): every link of the proof must hold for a failure;
// the first one that does not gives the undecided result with its reason, or no finding at all.
import { describe, expect, it } from 'vitest';
import { beforeMeasuring, clock, judgeVideoCaptions, measuredLinks, PLAIN_FRAMES_MIN, PLAYED_SECONDS_MIN, provenBeforePlaying, type VideoConfirm, type VideoFacts, type VideoMeasure } from '../../src/media/files.js';
import type { SoundFeatures } from '../../src/media/sound.js';

/** Measurements of clear speech (every sign of speech holds). */
const SPEECH: SoundFeatures = {
  seconds: 10.6, peakDb: -8, audibleSeconds: 9.1, voicedSeconds: 6.4, voicedShare: 0.7, runs: 30, runRate: 3.3, runMedianMs: 160, runP90Ms: 420,
  pitchHz: 110, pitchSpread: 4.2, pitchGlide: 0.12, heldShare: 0.05, hissShare: 0.12, onsetSpread: 0.55, beatFit: 0.4, vowelSpread: 8, attackShare: 0.3, stepMedian: 1.1,
  fadeDb: 4.6, weightAt: 0.41, stretchFall: 0.8, phraseFall: 2, phrases: 3,
  moments: [0.4, 0.9, 1.6, 2.3, 2.8, 4.4, 5.1, 5.7, 6.1, 7.3, 8.2, 9.6],
};
/** The page's own video played for a moment, and nothing came. */
const PLAYED: VideoConfirm = { state: 'played', seconds: 1.24, at: 0.4, added: 0, cues: 0, loading: 0 };
const TUNE: SoundFeatures = { ...SPEECH, pitchGlide: 0.01, heldShare: 0.7, hissShare: 0, attackShare: 0.9 };
const SILENT: SoundFeatures = { ...SPEECH, peakDb: -90, audibleSeconds: 0, voicedSeconds: 0, moments: [] };
const plain = (n = 12) => SPEECH.moments.slice(0, n).map((at) => ({ at, marked: 0, cells: 880 }));
const measure = (over: Partial<VideoMeasure> = {}): VideoMeasure => ({ src: 'https://city.example/media/notice.mp4', sound: { state: 'measured', features: SPEECH }, picture: { state: 'read', frames: plain() }, ...over });
const video = (over: Partial<VideoFacts> = {}): VideoFacts => ({
  target: 'https://city.example/media/notice.mp4', shown: true, muted: false, controls: true, decorative: false,
  cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'some' }, measure: measure(), confirm: PLAYED, ...over,
});
const statuses = (v: VideoFacts) => judgeVideoCaptions(v).map((f) => f.status);

describe('1.2.2 for a native video: a failure needs every link of the proof', () => {
  it('speech, no captions of any kind, a plain picture in every frame: failed, with what was measured', () => {
    const [f, ...rest] = judgeVideoCaptions(video());
    expect(rest).toEqual([]);
    expect(f).toMatchObject({ criterion: '1.2.2', status: 'failed', target: 'https://city.example/media/notice.mp4', data: { speechSeconds: 6.4, soundSeconds: 10.6, framesSampled: 12, captionsTracks: 0, playedSeconds: 1.2 } });
    expect(f!.detail).toContain('6.4 s of voiced speech in the first 10.6 s');
    expect(f!.detail).toContain('any of the 12 frames sampled while speech is heard (0:00 to 0:09)');
    expect(f!.detail).toContain('when the test played it (muted, 1.2 s from 0:00, a moment of speech) no captions came');
  });

  it('red (the cut round, review media-v S2): any captions or subtitles track, whatever it holds and however it came, is never "no captions": an empty track, a file that answers 404, a track with no file, a script\'s own empty track', () => {
    const tracks = 'with no captions in it when the page was read';
    expect(judgeVideoCaptions(video({ cues: { tracks: 1, loaded: 1, errors: 0, cues: 0, sound: 'some' } }))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(tracks) })]);
    expect(judgeVideoCaptions(video({ cues: { tracks: 1, loaded: 0, errors: 1, cues: 0, sound: 'some' }, measure: measure({ missing: [404] }) }))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(tracks) })]);
    // A track element with no file, or a script's own track: no track with a file, one captions text track.
    expect(judgeVideoCaptions(video({ cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'some', captionTracks: 1 } }))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(tracks) })]);
    expect(judgeVideoCaptions(video({ cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'some', captionTracks: 2 } }))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('2 captions or subtitles tracks') })]);
    // Look-alike: tracks of other kinds only (descriptions, chapters) are not captions: the video is measured.
    expect(beforeMeasuring(video({ cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'some', captionTracks: 0, textTracks: 2, trackElements: 2 } }))).toBeUndefined();
  });

  it('no finding: captions in a track, a background video, a muted video without controls, no sound track, a silent sound track', () => {
    expect(judgeVideoCaptions(video({ cues: { tracks: 1, loaded: 1, errors: 0, cues: 3, sound: 'some' } }))).toEqual([]);
    expect(judgeVideoCaptions(video({ decorative: true }))).toEqual([]);
    expect(judgeVideoCaptions(video({ muted: true, controls: false }))).toEqual([]);
    expect(judgeVideoCaptions(video({ cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'none' } }))).toEqual([]);
    expect(judgeVideoCaptions(video({ measure: measure({ sound: { state: 'none' } }) }))).toEqual([]);
    expect(judgeVideoCaptions(video({ measure: measure({ sound: { state: 'measured', features: SILENT } }) }))).toEqual([]);
  });

  it('undecided before any measuring: hidden, another way to get text, a captions control, a caption area, a script that follows it, the page\'s own player, a track still loading', () => {
    const cases: [Partial<VideoFacts>, string][] = [
      [{ shown: false }, 'hidden when the page was read'],
      [{ forText: 'Video version of the notice above' }, '“Video version of the notice above”'],
      [{ forText: true }, 'another way to get text'],
      [{ cues: { tracks: 0, loaded: 0, errors: 0, cues: 0, sound: 'some', control: 'Captions' } }, '“Captions”'],
      [{ captionArea: '.player-captions' }, '.player-captions'],
      [{ followed: true }, 'follows this video'],
      [{ controls: false }, 'the page\'s own player'],
      [{ farControl: 'Subtitles' }, 'a control elsewhere on the page offers captions (“Subtitles”)'],
      [{ menuControl: 'Settings' }, 'a control next to this video (“Settings”) may open a menu that offers captions'],
      [{ cues: { tracks: 2, loaded: 1, errors: 0, cues: 0, sound: 'some' } }, '2 captions or subtitles tracks with no captions in them'],
      // Fix round 1, S3: what the page's reads gave must be of one element and one file.
      [{ mixed: 'its file changed between two reads' }, 'changed while the page was read (its file changed between two reads)'],
    ];
    for (const [over, words] of cases) {
      const v = video(over);
      expect(beforeMeasuring(v), words).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(words) })]);
      expect(judgeVideoCaptions(v)).toEqual(beforeMeasuring(v));
    }
    expect(beforeMeasuring(video())).toBeUndefined();
  });

  it('undecided after measuring, each with its reason', () => {
    const cases: [Partial<VideoFacts>, string][] = [
      [{ measure: undefined }, 'more videos than the test measures'],
      [{ measure: measure({ scripted: '“.vtt” in /assets/site.js' }) }, 'a script of the page works with captions (“.vtt” in /assets/site.js)'],
      [{ measure: measure({ sound: { state: 'unknown', why: 'its file is larger than 24 MB, more than the test fetches' } }) }, 'larger than 24 MB'],
      [{ measure: measure({ sound: { state: 'measured', features: TUNE } }) }, 'could not show that the sound is speech'],
      [{ measure: measure({ picture: { state: 'unknown', why: 'the video is on another site that does not let a page read its picture' } }) }, 'its picture could not be read'],
      [{ measure: measure({ picture: { state: 'read', frames: [...plain(11), { at: 9.6, marked: 4, cells: 880 }] } }) }, 'in 1 of the 12 frames sampled while speech is heard (for example at 0:09)'],
      [{ measure: measure({ picture: { state: 'read', frames: [...plain(11), { at: 9.6, marked: 0, cells: 0 }] } }) }, 'marks that may be writing'],
      [{ measure: measure({ picture: { state: 'read', frames: plain(PLAIN_FRAMES_MIN - 1) } }) }, 'too few to rule out'],
    ];
    for (const [over, words] of cases) {
      expect(judgeVideoCaptions(video(over)), words).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(words) })]);
    }
  });

  it('a background video whose file changes while the page is read (a rotating hero video) gives no finding, as before; a captioned one that changed is undecided', () => {
    expect(judgeVideoCaptions(video({ decorative: true, mixed: 'its file changed between two reads' }))).toEqual([]);
    expect(judgeVideoCaptions(video({ muted: true, controls: false, mixed: 'its file changed between two reads' }))).toEqual([]);
    expect(statuses(video({ cues: { tracks: 1, loaded: 1, errors: 0, cues: 3, sound: 'some' }, mixed: 'it was not there in every read of the page' }))).toEqual(['not_testable']);
  });

  it('one sign of speech short is not speech: never failed', () => {
    for (const over of [{ hissShare: 0.01 }, { pitchGlide: 0.02 }, { vowelSpread: 3 }, { attackShare: 0.8 }, { audibleSeconds: 1.2 }, { beatFit: 0.95 }, { fadeDb: -4.6 }, { weightAt: 0.59 }, { stretchFall: -0.8 }, { phraseFall: -2 }, { phraseFall: 0, phrases: 0 }] as Partial<SoundFeatures>[]) {
      expect(statuses(video({ measure: measure({ sound: { state: 'measured', features: { ...SPEECH, ...over } } }) })), JSON.stringify(over)).toEqual(['not_testable']);
    }
  });

  // Fix round 1, S1 and S3: the failure is filed only after the page's own video was played and its captions read again.
  it('red: every measured link holds but the video was not played: undecided, never failed', () => {
    const v = video({ confirm: undefined });
    expect(provenBeforePlaying(v)).toBe(true);
    expect(measuredLinks(v)).toBeUndefined();
    expect(judgeVideoCaptions(v)).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('did not get to play it to see whether captions appear when it plays') })]);
  });

  it('red: what playing it showed decides: captions that came are captions; a track with none, text by the video, a stopped request, a video that changed or did not play are undecided', () => {
    expect(judgeVideoCaptions(video({ confirm: { ...PLAYED, added: 1, cues: 3 } }))).toEqual([]);
    const cases: [VideoConfirm, string][] = [
      [{ ...PLAYED, added: 1 }, 'a text track was added to it when the test played it'],
      [{ ...PLAYED, loading: 1 }, 'a text track was added to it when the test played it'],
      [{ ...PLAYED, text: 'The council meets on the first Tuesday' }, 'text came or changed next to or over the video while the test played it (“The council meets on the first Tuesday”)'],
      [{ ...PLAYED, stop: 'the test would have sent data to the live site (POST https://city.example/api/play), so it was stopped' }, 'when the test played it, the test would have sent data to the live site'],
      [{ ...PLAYED, seconds: PLAYED_SECONDS_MIN - 0.3 }, 'it played for only 0.5 s'],
      [{ state: 'not-played', why: 'the browser did not start it (NotAllowedError)' }, 'the test could not play it (the browser did not start it (NotAllowedError))'],
      [{ state: 'changed', why: 'its captions tracks are not the ones the test read at first' }, 'changed while the page was read (its captions tracks are not the ones the test read at first)'],
    ];
    for (const [confirm, words] of cases) {
      expect(judgeVideoCaptions(video({ confirm })), words).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining(words) })]);
    }
  });

  it('look-alike: a video that is undecided before it is played is never played for (playing decides only a failure)', () => {
    for (const over of [{ controls: false }, { measure: measure({ picture: { state: 'read', frames: [...plain(11), { at: 9.6, marked: 4, cells: 880 }] } }) }, { measure: measure({ sound: { state: 'measured', features: TUNE } }) }] as Partial<VideoFacts>[]) {
      expect(provenBeforePlaying(video(over))).toBe(false);
    }
  });

  it('red (the second check of the cut round, review media-cut S1): a video in a frame is undecided, never failed, and says where it is', () => {
    expect(judgeVideoCaptions(video({ frame: '/media/player/' }))).toEqual([expect.objectContaining({ status: 'not_testable', detail: expect.stringContaining('this video is in a frame of this page (/media/player/): the page around the frame may show captions over it') })]);
    // Look-alike: what needs no deciding stays so in a frame too (captions in a track, no sound track).
    expect(judgeVideoCaptions(video({ frame: '/media/player/', cues: { tracks: 1, loaded: 1, errors: 0, cues: 3, sound: 'some' } }))).toEqual([]);
  });

  it('times read as minutes and seconds', () => {
    expect([clock(0.4), clock(9.6), clock(75), clock(-1)]).toEqual(['0:00', '0:09', '1:15', '0:00']);
  });
});
