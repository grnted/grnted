// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The rules behind the media-files probe (batch 17, media lane): 1.2.2 for a page's own video files, decided
// from what the probe measured. A video is failed for missing captions only when every link of the proof
// holds: its sound track holds speech (`speechFound`, measured from the decoded sound), nothing on the page
// gives captions for it (no captions or subtitles track with a cue, no text track a script added, no captions
// control or caption area next to it, the browser's own controls and no player of the page's), and its
// picture shows nothing that could be text in any frame sampled while the speech is heard (`framePlain`), so
// the captions are not part of the picture either. Then, right before the failure is filed, the page's own
// video is played, muted, at a moment of speech, and its captions are read again (`VideoConfirm`; review round
// 1, S1 and S3): captions a script adds when the video plays, text that appears next to or over it, or a video
// that is no longer the one measured all leave it undecided. Anything else is undecided too (`not_testable`,
// with what was measured) or left to the video and audio rules: sound that is not shown to be speech, a picture
// with marks the test cannot read, a file it could not fetch, a video the page labels as another way to get its
// text. Pure: the probe (src/probes/mediaFiles.ts) observes, these functions judge. Engine core: no Node-only imports.
import type { ProbeFinding } from '../types.js';
import type { CaptionCues } from './players.js';
import { soundSilent, speechFound, speechMissing, SPEECH_SIGNS, type SoundFeatures } from './sound.js';

/** Frames with nothing that could be text that the proof needs at least (all of the frames sampled). */
export const PLAIN_FRAMES_MIN = 6;
/** Seconds the page's own video must have played, at least, for "no captions came when it played" to count. */
export const PLAYED_SECONDS_MIN = 0.8;

/** What the probe measured of one video file. */
export interface VideoMeasure {
  /** The address measured (the file the browser chose). */
  src: string;
  /** Its sound: measured, no sound track at all, or not measured (with the reason, worded for a finding). */
  sound: { state: 'measured'; features: SoundFeatures } | { state: 'none' } | { state: 'unknown'; why: string };
  /**
   * Its picture: for each frame sampled (seconds into the video), how many cells hold small marks; or why no
   * frame could be read.
   */
  picture: { state: 'read'; frames: { at: number; marked: number; cells: number }[] } | { state: 'unknown'; why: string };
  /** The HTTP status of each captions file the browser failed to load (0: no answer). */
  missing?: number[];
  /** Code on the page that works with captions (what it mentions, and where): a script may add captions later. */
  scripted?: string;
  /** What the decoder was handed and gave back: seconds and channels of sound, and whether the file was cut for it. */
  decoded?: { seconds: number; channels: number; cut: boolean };
}

/**
 * What happened when the test played the page's own video (muted, for a moment, at a moment of speech) and read
 * its captions again, right before filing a failure.
 */
export type VideoConfirm =
  | {
    state: 'played';
    /** Seconds it played, and where in the video it started. */
    seconds: number;
    at: number;
    /** Text tracks and track elements the video has now, beyond what it had when the page was read. */
    added: number;
    /** Cues in its captions and subtitles tracks now, and captions tracks still loading. */
    cues: number;
    loading: number;
    /**
     * What came or changed next to or over the video while it played: text (its first 80 characters), text in its
     * part of the page that was marked, or something put over the picture.
     */
    text?: string;
    /** What the request guard stopped while it played (a request that may have been for captions). */
    stop?: string;
  }
  /** It could not be played, or did not move. */
  | { state: 'not-played'; why: string }
  /** Something that can draw already lies over its picture (named): captions it shows would not be seen (review media-v, S1). */
  | { state: 'covered'; what: string }
  /** The element, its file or its captions are not what was read and measured. */
  | { state: 'changed'; why: string };

/** One `<video>` as the probe read it. */
export interface VideoFacts {
  /** Its address, or "video N on the page". */
  target: string;
  /** Shown when the page was read. */
  shown: boolean;
  muted: boolean;
  /** It has the browser's own controls. */
  controls: boolean;
  /** A background video by its own markup (`nativeVideoDecorative`). */
  decorative: boolean;
  /** Words that offer it as another way to get text that is on the page, or true when the page labels it so. */
  forText?: string | true;
  /** Its captions tracks as the browser loaded them, and a captions control next to it. */
  cues: CaptionCues;
  /** An area next to the video that a script could show captions in: one its markup names for captions, or lines of text with start times. */
  captionArea?: string;
  /** A script follows its playback (a `timeupdate` or `cuechange` handler on the video itself). */
  followed?: boolean;
  /** A control anywhere else in its document that offers captions (its name): it may switch them on for this video. */
  farControl?: string;
  /** A control next to it that may open a menu (settings, options, more) or has no name: captions may be inside what it opens. */
  menuControl?: string;
  /** The frame it is in, when not in the page's own document. */
  frame?: string;
  /** Why the page's reads of this video do not belong together (the element or its file changed between them). */
  mixed?: string;
  measure?: VideoMeasure;
  confirm?: VideoConfirm;
}

const f = (status: ProbeFinding['status'], target: string, detail: string, data?: ProbeFinding['data']): ProbeFinding => ({ criterion: '1.2.2', status, target, detail, ...(data ? { data } : {}) });

/** "0:07" for seconds. */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const secs = (n: number): string => `${Math.round(n * 10) / 10} s`;

/** What the page gives for captions, in the finding's words: no track at all, or tracks that hold none. */
function noCaptionsWords(v: VideoFacts, missing: readonly number[]): string {
  const c = v.cues;
  if (!c.tracks) return 'it has no captions or subtitles track';
  if (missing.length) {
    const status = [...new Set(missing)].map((s) => `HTTP ${s}`).join(', ');
    return c.tracks === 1 ? `its captions file does not exist (${status})` : `its ${c.tracks} captions files hold no captions or do not exist (${status})`;
  }
  return c.tracks === 1 ? 'its captions track loads and holds no captions' : `its ${c.tracks} captions tracks load and hold no captions`;
}

/**
 * The links of the proof that need no measuring, in order: undefined when they all hold (the video is then
 * measured), else the result as it stands: no finding for a video that is captioned by a track, is a background
 * video or has no sound track (the video and audio rules list those), or the undecided result with its reason.
 */
export function beforeMeasuring(v: VideoFacts): ProbeFinding[] | undefined {
  const t = v.target;
  const c = v.cues;
  const where = v.frame ? ` (in a frame of this page, ${v.frame})` : '';
  // Decoration, or a video nobody can turn the sound of on (the element's own markup): nothing to decide here.
  if (v.decorative || (v.muted && !v.controls)) return [];
  // What was read of it must be of one element and one file (review round 1, S3).
  if (v.mixed) return [f('not_testable', t, `this video${where} changed while the page was read (${v.mixed}), so what the test read of it does not belong together and nothing was decided.`)];
  // Captions in a track: nothing to decide here.
  if (c.cues > 0) return [];
  // No sound track (read from the page's own element): nothing to caption.
  if (c.sound === 'none') return [];
  // A captions or subtitles track, whatever it holds and however it came (a track element with or without a file,
  // a script's own track): a player may fill it when a visitor chooses it in the browser's captions menu, and its
  // file may be one that loads empty or not at all for the test. Never "no captions" (review media-v, S2).
  const captionTracks = Math.max(c.captionTracks ?? 0, c.tracks);
  if (captionTracks > 0) return [f('not_testable', t, `this video${where} has ${captionTracks === 1 ? 'a captions or subtitles track' : `${captionTracks} captions or subtitles tracks`} with no captions in ${captionTracks === 1 ? 'it' : 'them'} when the page was read (a file that loads empty or not at all, or a track a player fills only when a visitor chooses it): whether the video has captions could not be told.`)];
  // A video in a frame: the page around the frame may draw captions over it, which the test cannot see from inside
  // the frame. Undecided, never failed (review media-cut, S1).
  if (v.frame) return [f('not_testable', t, `this video is in a frame of this page (${v.frame}): the page around the frame may show captions over it, which the test does not read from inside the frame, so whether it has captions could not be told.`)];
  if (!v.shown) return [f('not_testable', t, `this video${where} was hidden when the page was read, so it was not measured.`)];
  if (v.forText) {
    return [f('not_testable', t, `this video${where} is offered as another way to get text that is on the page${typeof v.forText === 'string' ? ` (“${v.forText}”)` : ''}: it needs no captions when it says no more than that text, which the test cannot tell.`)];
  }
  if (c.control) return [f('not_testable', t, `a control next to this video${where} offers captions (“${c.control}”): the test does not press it, so whether captions are available could not be told.`)];
  if (v.captionArea) return [f('not_testable', t, `the page has an area next to this video${where} that a script may show captions in (${v.captionArea}), which the test cannot tell.`)];
  if (v.followed) return [f('not_testable', t, `a script of the page follows this video${where} as it plays and may show captions of its own, which the test cannot tell.`)];
  if (!v.controls) return [f('not_testable', t, `this video${where} is played by the page's own player, not the browser's controls: captions that player may offer could not be told.`)];
  if (v.menuControl) return [f('not_testable', t, `a control next to this video${where} (“${v.menuControl}”) may open a menu that offers captions: the test does not press it, so whether captions are available could not be told.`)];
  if (v.farControl) return [f('not_testable', t, `a control elsewhere on the page offers captions (“${v.farControl}”): the test does not press it, so whether it switches on captions for this video${where} could not be told.`)];
  // Tracks still loading: undecided. (Tracks that failed to load are looked up: a missing file is no captions.)
  if (c.tracks && c.loaded + c.errors !== c.tracks) return [f('not_testable', t, `this video's${where} captions file had not loaded when the page was read, so whether it has captions could not be told.`)];
  return undefined;
}

/**
 * The links of the proof that measuring decides, after `beforeMeasuring`: undefined when they all hold (speech,
 * no captions on the page, a picture with nothing that could be writing in every frame), else the result as it
 * stands: no finding (no sound track, a silent one) or the undecided result with what was measured.
 */
export function measuredLinks(v: VideoFacts): ProbeFinding[] | undefined {
  const t = v.target;
  const c = v.cues;
  const where = v.frame ? ` (in a frame of this page, ${v.frame})` : '';
  if (v.measure?.sound.state === 'none') return [];
  const missing = v.measure?.missing ?? [];
  const gone = missing.length > 0 && missing.every((s) => s === 404 || s === 410);
  if (c.errors > 0 && !(gone && missing.length === c.errors)) {
    return [f('not_testable', t, `this video's${where} captions file did not load when the page was read${missing.length ? ` (${[...new Set(missing)].map((s) => (s ? `HTTP ${s}` : 'no answer')).join(', ')})` : ''}, so whether it has captions could not be told.`)];
  }
  const m = v.measure;
  if (!m) return [f('not_testable', t, `this video${where} was not measured: the page has more videos than the test measures.`)];
  if (m.sound.state === 'none') return [];
  if (m.scripted) return [f('not_testable', t, `a script of the page works with captions (${m.scripted}): it may give this video${where} captions when it plays or when a control is pressed, which the test cannot tell.`)];
  const found = `no captions the test could find (${noCaptionsWords(v, gone ? missing : [])})`;
  if (m.sound.state === 'unknown') return [f('not_testable', t, `this video${where} has ${found}, and its sound could not be measured (${m.sound.why}): whether it has speech that needs captions could not be told.`)];
  const s = m.sound.features;
  if (soundSilent(s)) return [];
  if (!speechFound(s)) {
    const lacks = speechMissing(s).slice(0, 3).map((id) => SPEECH_SIGNS[id]!.what).join('; ');
    return [f('not_testable', t, `this video${where} has sound (${secs(s.audibleSeconds)} that can be heard in the first ${secs(s.seconds)}) and ${found}, but the test could not show that the sound is speech (it lacks: ${lacks}). Music and other sound without information need no captions, so this was not decided.`)];
  }
  if (m.picture.state === 'unknown') return [f('not_testable', t, `this video${where} has speech and ${found}, but its picture could not be read (${m.picture.why}): captions that are part of the picture (open captions) could not be ruled out.`)];
  const frames = m.picture.frames;
  const marked = frames.filter((x) => x.marked > 0 || x.cells === 0);
  if (marked.length) {
    return [f('not_testable', t, `this video${where} has speech and ${found}, but its picture shows marks that may be writing in ${marked.length} of the ${frames.length} frames sampled while speech is heard (for example at ${clock(marked[0]!.at)}). The test cannot read them, so captions that are part of the picture (open captions) could not be ruled out.`)];
  }
  if (frames.length < PLAIN_FRAMES_MIN) {
    return [f('not_testable', t, `this video${where} has speech and ${found}, but only ${frames.length} of its frames could be sampled while speech is heard: too few to rule out captions that are part of the picture.`)];
  }
  return undefined;
}

/**
 * True when every link that needs no playing holds: the probe then plays the page's own video for a moment and
 * reads its captions again (`VideoConfirm`), which `judgeVideoCaptions` needs before it files a failure.
 */
export const provenBeforePlaying = (v: VideoFacts): boolean => beforeMeasuring(v) === undefined && measuredLinks(v) === undefined;

/**
 * 1.2.2 for one native video: the links that need no measuring (`beforeMeasuring`), the measured ones
 * (`measuredLinks`), then what playing it showed (`VideoFacts.confirm`). The first link that does not hold gives
 * the undecided result and its reason; all of them give the failure.
 */
export function judgeVideoCaptions(v: VideoFacts): ProbeFinding[] {
  const early = beforeMeasuring(v) ?? measuredLinks(v);
  if (early) return early;
  const t = v.target;
  const c = v.cues;
  const where = v.frame ? ` (in a frame of this page, ${v.frame})` : '';
  const m = v.measure!;
  const s = (m.sound as { state: 'measured'; features: SoundFeatures }).features;
  const frames = (m.picture as { state: 'read'; frames: { at: number; marked: number; cells: number }[] }).frames;
  const missing = m.missing ?? [];
  const none = noCaptionsWords(v, missing.length > 0 && missing.every((x) => x === 404 || x === 410) ? missing : []);
  const proof = `this video${where} has speech and no captions the test could find when the page was read (${none}), and its picture shows nothing that could be writing in the frames sampled while speech is heard`;
  // Captions a script gives the video when it plays cannot be seen until it plays: without that step, undecided.
  const p = v.confirm;
  if (!p) return [f('not_testable', t, `${proof}, but the test did not get to play it to see whether captions appear when it plays, so this was not decided.`)];
  if (p.state === 'changed') return [f('not_testable', t, `this video${where} changed while the page was read (${p.why}): what the test measured may not be what is there now, so nothing was decided.`)];
  if (p.state === 'covered') return [f('not_testable', t, `${proof}, but something that can draw lies over its picture (${p.what}): captions it may show there as the video plays would not be seen by the test, so this was not decided.`)];
  if (p.state === 'not-played') return [f('not_testable', t, `${proof}, but the test could not play it (${p.why}) to see whether captions appear when it plays, so this was not decided.`)];
  if (p.stop) return [f('not_testable', t, `${proof}, but when the test played it, ${p.stop}: captions the page may load that way could not be told.`)];
  // Captions that came when it played are captions (whether they are complete is not this test's to judge).
  if (p.cues > 0) return [];
  if (p.added > 0 || p.loading > 0) return [f('not_testable', t, `${proof}, but a text track was added to it when the test played it and held no captions when the test read it: whether it gives captions could not be told.`)];
  if (p.text) return [f('not_testable', t, `${proof}, but text came or changed next to or over the video while the test played it (“${p.text}”): the page may show captions of its own there, which the test cannot tell.`)];
  if (!(p.seconds >= PLAYED_SECONDS_MIN)) return [f('not_testable', t, `${proof}, but it played for only ${secs(p.seconds)} when the test started it: too short to see whether captions appear when it plays.`)];
  const first = Math.min(...frames.map((x) => x.at));
  const last = Math.max(...frames.map((x) => x.at));
  // Within the 500 characters a finding's detail keeps (src/probes/runner.ts): every link of the proof, then the fix.
  return [f('failed', t,
    `this video${where} has speech and no captions. Its sound holds speech (${secs(s.voicedSeconds)} of voiced speech in the first ${secs(s.seconds)}, measured); ${none}; when the test played it (muted, ${secs(p.seconds)} from ${clock(p.at)}, a moment of speech) no captions came (no track, no cue, no text by it); and its picture shows nothing that could be writing in any of the ${frames.length} frames sampled while speech is heard (${clock(first)} to ${clock(last)}). Add captions: a WebVTT file linked with a track element.`,
    { speechSeconds: s.voicedSeconds, soundSeconds: s.seconds, framesSampled: frames.length, captionsTracks: c.tracks, playedSeconds: Math.round(p.seconds * 10) / 10 },
  )];
}
