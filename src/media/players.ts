// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The rules behind the media-players probe (Plan 4 Task 4.8): player control names, live-stream
// addresses, transcript and audio-description links, and the verdicts for 1.2.1–1.2.5 per embedded
// player, sound-only item and native video. Pure: the probe (src/probes/mediaPlayers.ts) observes,
// these functions judge. Engine core: no Node-only or AI imports.
import type { ProbeFinding } from '../types.js';
import { mediaFileType } from './detect.js';

export const MEDIA_PLAYER_CRITERIA = ['1.2.1', '1.2.2', '1.2.3', '1.2.4', '1.2.5'] as const;

// Control names ---------------------------------------------------------------------------------

export type ControlKind = 'play' | 'pause' | 'captions' | 'description' | 'other';

// Names in the languages YouTube and Vimeo ship most (en, es, fr, de, pt, it, nl, ja, zh, ko). A
// player whose interface is in another language reads as "unknown", never as "no captions".
/** Languages whose control names the rules know (the player frame's `lang`, primary subtag). */
export const KNOWN_CONTROL_LANGUAGES: readonly string[] = ['en', 'es', 'fr', 'de', 'pt', 'it', 'nl', 'ja', 'zh', 'ko'];
/** Words that make a "play…" name something other than starting this video (cast, lists, speed…). */
const NOT_PLAY = /\b(tv|cast|airplay|playlist|playlists|playback|speed|next|previous|prev|all|more|later|queue|watch on|youtube|vimeo|suite|en tv|en la tv|lista)\b|速度|列表|リスト|목록|속도/i;
const KEY_HINT = String.raw`(?:\s*[(（]\s*[a-z]\s*[)）])?`;
const PLAY = new RegExp(String.raw`^\s*(?:play|play video|play the video|start video|start playback|lire|lecture|reproducir|wiedergabe|abspielen|reproduzir|assistir|riproduci|afspelen|再生|播放|재생)${KEY_HINT}\s*$`, 'i');
const PLAY_LOOSE = /^\s*play\b/i;
const PAUSE = new RegExp(String.raw`^\s*(?:pause|pausa|pausar|pausieren|onderbreken|pauzeren|一時停止|暂停|暫停|일시\s?중지)(?:\b|${KEY_HINT}|\s|$)`, 'i');
const CAPTIONS = /\b(captions?|subtitles?|cc|closed captions?|sous-titres?|subt[ií]tulos?|untertitel|legendas?|sottotitoli|ondertiteling|ondertitels)\b|字幕|자막/i;
const DESCRIPTION = /\baudio[-\s]?descri(?:bed|ption|ptions)\b|\bdescriptive audio\b|\bdescribed version\b|audiodescri|audiodeskri/i;
const UNAVAILABLE = /unavailable|not available|\bno (?:closed )?(?:captions?|subtitles?)\b|aucun sous-titre|pas de sous-titres?|sin subt[ií]tulos|no hay subt[ií]tulos|keine untertitel|sem legendas?|nenhuma legenda|nessun sottotitol|geen ondertitel|字幕はありません|字幕なし|无字幕|沒有字幕|没有字幕|자막 없음|자막이 없|no disponible|non disponible|indisponible|nicht verf[üu]gbar|indispon[ií]vel|n[ãa]o dispon[ií]vel|non disponibil|niet beschikbaar|利用できません|不可用|사용할 수 없/i;

/** The name says the control's feature is not available ("Subtitles/closed captions unavailable"). */
export const saysUnavailable = (name: string): boolean => UNAVAILABLE.test(name);
/** A captions control by name (also when the name mentions audio description too). */
export const isCaptionsName = (name: string): boolean => CAPTIONS.test(name);

/**
 * What a player control does, from its accessible name. Only `play` is ever clicked (with the
 * captions state read, never clicked); a name that could also cast, open a list or change speed is
 * not `play`.
 */
export function controlKind(name: string): ControlKind {
  const n = name.replace(/\s+/g, ' ').trim();
  if (!n) return 'other';
  if (DESCRIPTION.test(n) && !CAPTIONS.test(n)) return 'description';
  if (CAPTIONS.test(n)) return 'captions';
  if (PAUSE.test(n)) return 'pause';
  if (!NOT_PLAY.test(n) && (PLAY.test(n) || (PLAY_LOOSE.test(n) && n.split(' ').length <= 3))) return 'play';
  return 'other';
}

// Addresses ---------------------------------------------------------------------------------------

/** A player address that only ever plays a live stream (a channel's live stream, a Vimeo event). */
export function isLivePlayerUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  const h = u.hostname.toLowerCase();
  const yt = ['youtube.com', 'youtube-nocookie.com'].some((d) => h === d || h.endsWith(`.${d}`));
  if (yt && /^\/embed\/live_stream\/?$/.test(u.pathname)) return true;
  if ((h === 'vimeo.com' || h.endsWith('.vimeo.com')) && /^\/event\/\d+(\/embed)?\/?$/.test(u.pathname)) return true;
  return false;
}

// Links next to the media -------------------------------------------------------------------------

/**
 * The page calling a player live ("Watch live", "Live stream", and for sound "Listen live", "Live audio"); a source
 * so the probe can use it in the page. It only ever leaves a result undecided (a live stream is not judged by
 * the criteria for recordings), never fails one.
 */
export const LIVE_TEXT_SOURCE = String.raw`\b(?:live ?stream(?:ing)?|(?:watch|listen|hear it|tune in) live|live now|streaming live|live (?:broadcast|coverage|audio|radio|feed))\b`;

// A link counts only when its name IS the offer ("Read the transcript", "Transcript of episode 2",
// "Watch the audio-described version"), or its file is named for it; a sentence that merely contains
// the word ("Transcription services", "Learn about audio description") does not.
const LEAD = String.raw`^(?:(?:read|view|see|show|open|download|get|watch|play|full|complete|the|a|an|this|video|audio|episode|meeting|podcast|interactive|printable)\s+)*`;
const TRANSCRIPT_NAME = new RegExp(String.raw`${LEAD}(?:transcripts?|text version|text alternative)\b`, 'i');
const DESCRIBED_NAME = new RegExp(String.raw`${LEAD}(?:audio[-\s]?described|described)\s+(?:version|video|edition)\b|^(?:version|video)\s+with\s+audio\s+descriptions?\b|${LEAD}(?:with\s+)?audio\s+descriptions?\s*(?:version)?\s*$|^audio[-\s]?described\b`, 'i');
const CAPTION_NAME = /\b(captions?|subtitles?|closed captions?)\b/i;
const CAPTION_FILE = /\.(vtt|srt|sbv|dfxp|ttml|scc|txt)$/i;

/** The file name at the end of an address, split into words ("board-meeting-transcript.pdf" → board, meeting, transcript). */
function lastSegment(href: string): { words: string[]; file: string } {
  let path = '';
  try {
    path = new URL(href, 'https://x.invalid/').pathname;
  } catch {
    path = '';
  }
  let file = path.split('/').filter(Boolean).pop() ?? '';
  try {
    file = decodeURIComponent(file);
  } catch {
    // keep it as it is
  }
  return { words: file.replace(/\.[a-z0-9]{1,5}$/i, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean), file };
}

/** What a link or button next to media offers, from its accessible name and address. */
export function linkKind(name: string, href = ''): 'transcript' | 'described' | undefined {
  const n = name.replace(/\s+/g, ' ').trim();
  if (DESCRIBED_NAME.test(n)) return 'described';
  if (TRANSCRIPT_NAME.test(n)) return 'transcript';
  const { words, file } = lastSegment(href);
  // A captions or subtitles file (WebVTT, SRT…) is the text of what is said.
  if (CAPTION_FILE.test(file) && (CAPTION_NAME.test(n) || words.some((w) => /^(captions?|subtitles?|transcripts?)$/.test(w)) || /\.(vtt|srt)$/i.test(file))) return 'transcript';
  if (words.includes('described') || words.join('-').includes('audio-description')) return 'described';
  if (words[0] === 'transcript' || words[words.length - 1] === 'transcript') return 'transcript';
  return undefined;
}

/** A transcript written out on the page: a block whose text begins "Transcript" (a heading, a summary, "Transcript: …"). */
export const isTranscriptHeading = (text: string): boolean => /^(?:full |read the |view the |video |audio )?transcript\b/i.test(text.replace(/\s+/g, ' ').trim());

/** What the page offers next to one media item (link names, max 120 characters each). */
export interface Nearby {
  transcript?: string;
  described?: string;
  /**
   * Text next to a sound-only item that the page gives as its text alternative without calling it a transcript:
   * a block that begins "Text alternative:" or "Audio description:", one the page's markup names a transcript
   * (its id or class), or text tied to the player with aria-describedby or aria-details (max 400 characters).
   */
  alternative?: string;
  /** Unlabelled text right next to a sound-only item that describes sounds (tones, bells, "no speech"): it may be the alternative. */
  sounds?: string;
  /** Words that offer a sound-only item as another way to get text that is on the page just before it ("You can also listen to this notice"). */
  forText?: string;
  /** The sound-only item sits right beside a video with no sound track: it may be that video's audio alternative. */
  besideSilentVideo?: boolean;
  /** The sound-only item sits right beside a video whose sound track could not be read (it had not loaded). */
  besideUnknownVideo?: boolean;
  /** The sound-only item sits right beside a video that has sound: it may be an audio track for that video. */
  besideVideo?: boolean;
  /** The page calls it live next to the player ("Watch live", "Live stream"). */
  liveText?: string;
  /**
   * A link right beside the item (in its own block, or among the two blocks before and after it, up to a heading)
   * that is not its own file and was not recognised as a transcript: it may lead to one (review media-v, S3).
   */
  adjacentLink?: string;
  /** The page shows a cookie or consent notice. */
  consent?: boolean;
}

// The player's state -------------------------------------------------------------------------------

export interface PlayerControl {
  name: string;
  /** Rendered (not display:none, has a box). Players fade their controls out; that still counts. */
  displayed: boolean;
  disabled: boolean;
}

/** What the probe read inside the player's frame. */
export interface PlayerState {
  url: string;
  /** Buttons of the player (never links), by accessible name. */
  controls: PlayerControl[];
  video: { count: number; playing: boolean; currentTime: number; duration: number | 'infinite' | null; muted: boolean };
  /** A visible LIVE badge. */
  liveBadge: boolean;
  /** The player's own data says live (true) or not (false); null when it gives none. */
  playerLive: boolean | null;
  /** The player's own caption list (kind 'asr' = automatic), when it exposes one. */
  tracks: { kind: string; label: string }[] | null;
  /** An empty `tracks` list is final (the player lists its captions up front), not "not loaded yet". */
  tracksFinal: boolean;
  /** An error the player shows ("Video unavailable"). */
  error: string | null;
  /** The player frame's language (`<html lang>`), '' when it gives none. */
  lang: string;
  /** A seekable timeline with a finite end (a slider whose maximum is a length): an on-demand video. */
  timeline: boolean;
}

/** One embedded player as the probe tested it. */
export interface PlayerObservation {
  url: string;
  /** The player address (evidence target). */
  target: string;
  /**
   * `tested`: the frame was read. Otherwise `reason` says why it was not: not loaded (lazy, consent,
   * error page), unreadable, hidden, out of time, or past the per-page cap.
   */
  outcome: 'tested' | 'not-loaded' | 'unreadable' | 'hidden' | 'time' | 'cap';
  reason?: string;
  /** The last state read (after play and hover). */
  state?: PlayerState;
  /** It played: its video ran, its frames changed or it showed a pause control. */
  started: boolean;
  /** The probe clicked its play control. */
  clicked: boolean;
  /** Something on the page covers the player, so it was not clicked. */
  covered: boolean;
  /** Why the probe did not judge a player it could read (rotated on the page, mute not confirmed…). */
  skipped?: string;
  /** Its sound came on (the player unmuted itself); it was paused and is not judged. */
  unmuted: boolean;
  /** Requests the guard stopped while this player was tested ("POST request to …"). */
  blocked: string[];
  /** Screenshots of the player region while it played, and how many differed. */
  frames: { taken: number; distinct: number };
  /**
   * The distinct screenshots themselves (JPEG), at most `MEDIA_PLAYER_LIMITS.frames`: evidence for the AI media
   * review only (batch 18, G12), handed over with `ctx.attach`, never in the run's data or the report.
   */
  shots?: Uint8Array[];
}

export type CaptionsState = 'available' | 'auto-only' | 'none' | 'unknown';

/**
 * Caption availability, in order of trust:
 * 1. The player's own caption list: an uploaded track means offered, automatic tracks only mean
 *    "automatic only", and an empty list means none when the player lists its captions up front.
 * 2. Its captions control: shown and enabled means offered; disabled or named "unavailable" means none.
 * 3. Once it started and shows its controls (pause), no shown captions control means none.
 * Anything else is unknown.
 */
export function captionsOf(s: PlayerState, started: boolean): { state: CaptionsState; via: string } {
  if (s.tracks?.length) {
    const uploaded = s.tracks.filter((t) => t.kind !== 'asr');
    if (uploaded.length) return { state: 'available', via: `the player lists ${uploaded.length === 1 ? 'a captions track' : `${uploaded.length} captions tracks`} ("${clip(uploaded[0]!.label || uploaded[0]!.kind || 'captions', 60)}")` };
    return { state: 'auto-only', via: 'the player lists only automatic captions' };
  }
  const ccs = s.controls.filter((c) => isCaptionsName(c.name) && c.displayed);
  const usable = ccs.find((c) => !c.disabled && !saysUnavailable(c.name));
  // A shown, enabled captions control offers captions, whatever an (empty) list said.
  if (usable) return { state: 'available', via: `its captions control "${clip(usable.name, 60)}" is enabled` };
  if (s.tracks && s.tracksFinal) return { state: 'none', via: 'the player lists no captions tracks' };
  if (ccs.length) return { state: 'none', via: `its captions control "${clip(ccs[0]!.name, 60)}" says none are available` };
  // No captions control at all counts as none only for a control bar the rules can read: in a known
  // language, with its pause control recognised. Anything else (another language, controls only in a
  // menu, a bar of unknown names) is unknown.
  const lang = s.lang.toLowerCase().split('-')[0] ?? '';
  const known = KNOWN_CONTROL_LANGUAGES.includes(lang);
  const controlsShown = s.controls.some((c) => c.displayed && controlKind(c.name) === 'pause');
  if (started && controlsShown && known) return { state: 'none', via: 'it played and showed its controls, with no captions control' };
  return { state: 'unknown', via: '' };
}

/** Live (true), on demand (false) or unknown. */
export function liveOf(o: PlayerObservation): boolean | undefined {
  if (isLivePlayerUrl(o.url)) return true;
  const s = o.state;
  if (!s) return undefined;
  if (s.playerLive === true || s.liveBadge || s.video.duration === 'infinite') return true;
  // On demand only on a positive sign: a finite length, the player's data saying so (read only once it
  // names its video), or a shown seek timeline with an end. Playing proves nothing either way (a live
  // stream plays too): without a sign, it is unknown.
  if (typeof s.video.duration === 'number' || s.playerLive === false || s.timeline) return false;
  return undefined;
}

// Verdicts ----------------------------------------------------------------------------------------

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/**
 * A quote of the page's own words, at most `n` characters: whole when it fits; else the sentences that fit
 * whole, then an ellipsis (something was cut); a first sentence longer than `n` is cut at a word. Linear.
 */
export function quoteSentences(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= n) return t;
  const room = Math.max(1, n - 1);
  let cut = 0;
  for (let i = 0; i < room; i++) {
    const c = t[i];
    if ((c === '.' || c === '!' || c === '?') && t[i + 1] === ' ') cut = i + 1;
  }
  if (cut > 0) return `${t.slice(0, cut)}…`;
  const space = t.lastIndexOf(' ', room);
  return `${(space > 0 ? t.slice(0, space) : t.slice(0, room)).replace(/[\s,;:]+$/, '')}…`;
}
const NO_AUDIO = 'the platform does not give automated tools access to the audio';
const f = (criterion: string, status: ProbeFinding['status'], target: string, detail: string): ProbeFinding => ({ criterion, status, target, detail });

/**
 * 1.2.3 and 1.2.5 for a prerecorded video: an audio-described version (`described`, already worded,
 * e.g. 'an audio-described version is linked next to it ("…")') covers both; a linked transcript
 * covers 1.2.3 only; otherwise `rest` says why neither can be decided.
 */
function describedFindings(target: string, described: string | undefined, transcript: string | undefined, rest: string): ProbeFinding[] {
  if (described) return [f('1.2.3', 'no_failures_found', target, `${described}.`), f('1.2.5', 'no_failures_found', target, `${described}.`)];
  if (transcript) {
    return [
      f('1.2.3', 'no_failures_found', target, `a transcript is linked next to it ("${quoteSentences(transcript, 80)}"), a text alternative for the video.`),
      f('1.2.5', 'not_testable', target, `a transcript does not replace audio description, and no audio-described version is linked next to it; ${rest}`),
    ];
  }
  const why = `no transcript or audio-described version is linked next to it; ${rest}`;
  return [f('1.2.3', 'not_testable', target, why), f('1.2.5', 'not_testable', target, why)];
}

const linkedDescribed = (near: Nearby) => (near.described ? `an audio-described version is linked next to it ("${quoteSentences(near.described, 80)}")` : undefined);

/** The reason a player gave no captions or live result. */
function untestedReason(o: PlayerObservation, near: Nearby): string {
  if (o.outcome !== 'tested') return `${o.reason ?? 'the player could not be tested'}${o.outcome === 'not-loaded' && near.consent ? ' (the page shows a cookie notice, which the test does not answer)' : ''}`;
  if (o.unmuted) return 'the player turned its sound on, so the test paused it and did not judge it';
  if (o.skipped) return o.skipped;
  if (o.covered) return 'something on the page covers the player (for example a cookie notice), so its controls were not used';
  if (o.state?.error) return `the player shows an error: "${clip(o.state.error, 100)}"`;
  if (!o.started) {
    const stopped = o.blocked.length ? `; it may need a request the test does not send (${clip(o.blocked[0]!, 160)}${o.blocked.length > 1 ? ` and ${o.blocked.length - 1} more` : ''})` : '';
    return `${o.clicked ? 'the player did not start when its play control was clicked' : 'the player did not start: no play control was found'}${stopped}`;
  }
  return 'the player showed no captions control or captions list the test could read';
}

/**
 * Findings for one embedded video player:
 * - 1.2.2 (prerecorded) and 1.2.4 (live): failed when the player offers no captions (or, for
 *   prerecorded video, automatic captions only); `not_testable` when it offers captions, because
 *   their accuracy cannot be tested (the platform does not give automated tools its audio), or when
 *   the player could not be read. Live decides which of the two applies; the other is not applicable.
 * - 1.2.3 and 1.2.5 (prerecorded): from an audio-described version or transcript linked next to it.
 */
export function judgePlayer(o: PlayerObservation, near: Nearby): ProbeFinding[] {
  const t = o.target;
  const out: ProbeFinding[] = [];
  const judged = o.outcome === 'tested' && !!o.state && !o.unmuted && !o.covered && !o.skipped && !o.state.error;
  const live = judged ? liveOf(o) : (isLivePlayerUrl(o.url) ? true : undefined);
  const captions = judged ? captionsOf(o.state!, o.started) : { state: 'unknown' as const, via: '' };
  // An audio-description control counts only when it is shown, enabled and not "unavailable".
  const descControl = judged ? o.state!.controls.find((c) => c.displayed && !c.disabled && !saysUnavailable(c.name) && controlKind(c.name) === 'description')?.name : undefined;
  const reason = captions.state === 'unknown' ? untestedReason(o, near) : '';

  if (live === true) {
    const why = 'a live stream';
    out.push(f('1.2.2', 'not_applicable', t, `${why}: prerecorded-media criteria do not apply.`));
    if (captions.state === 'unknown') out.push(f('1.2.4', 'not_testable', t, `a live stream whose captions could not be read: ${reason}.`));
    // Whether it has speech or other sound that needs captions was not assessed (a stream of signing, of music, or
    // with captions in its picture needs none): undecided, never a failure (review media-v, S8).
    else if (captions.state === 'none') out.push(f('1.2.4', 'not_testable', t, `this live stream offers no captions (${captions.via}), but whether it has speech or other sound that needs captions was not assessed (signing, music or captions in the picture need none), so this was not decided.`));
    else out.push(f('1.2.4', 'not_testable', t, `this live stream offers captions (${captions.via}); whether they are complete and accurate cannot be tested automatically: ${NO_AUDIO}.`));
    out.push(f('1.2.3', 'not_applicable', t, `${why}: prerecorded-media criteria do not apply.`), f('1.2.5', 'not_applicable', t, `${why}: prerecorded-media criteria do not apply.`));
    return out;
  }

  // Prerecorded, or not known to be live.
  if (captions.state === 'available') {
    out.push(f('1.2.2', 'not_testable', t, `the player offers captions (${captions.via}); whether they are complete and accurate cannot be tested automatically: ${NO_AUDIO}.`));
  } else if (captions.state === 'auto-only') {
    // Whether automatic captions were corrected, and whether the video needs captions at all, the test cannot
    // tell: never a failure (review media-v, S8).
    out.push(f('1.2.2', 'not_testable', t, `${captions.via}. Automatic captions alone are not enough unless they have been corrected, which the test cannot tell, so this was not decided.`));
  } else if (captions.state === 'none') {
    // The test did not assess its sound or picture: a video of signing, of music only, or with captions in its
    // picture needs no captions track: undecided, never a failure (review media-v, S8).
    out.push(f('1.2.2', 'not_testable', t, `the player offers no captions (${captions.via}), but whether the video has speech or other sound that needs captions was not assessed (signing, music or captions in the picture need none), so this was not decided. A video with speech needs captions: add them on the platform.`));
  } else {
    out.push(f('1.2.2', 'not_testable', t, `captions could not be checked: ${reason}.`));
  }
  // "Not live" is inferred (it played with no live sign); when the page calls it live, that is not enough.
  if (live === false && near.liveText) out.push(f('1.2.4', 'not_testable', t, `the page calls it "${clip(near.liveText, 60)}", but the player showed no live sign the test could read, so whether it is a live stream could not be told.`));
  else if (live === false) out.push(f('1.2.4', 'not_applicable', t, 'not a live stream.'));
  else out.push(f('1.2.4', 'not_testable', t, `whether it is a live stream could not be told: ${reason || 'the player gave no sign either way'}${near.liveText ? ` (the page calls it "${clip(near.liveText, 60)}")` : ''}.`));
  const described = linkedDescribed(near) ?? (descControl ? `the player has an audio description control ("${clip(descControl, 60)}")` : undefined);
  out.push(...describedFindings(t, described, near.transcript, `whether the video shows information its sound does not give cannot be judged automatically: ${NO_AUDIO}.`));
  return out;
}

/**
 * Whether a sound-only item is a recording: 'yes' when the browser read a set length for its file, or it plays
 * on a platform that hosts recordings; 'live' when the browser read no end for it (a live stream, or a recording
 * that gives no length); 'unknown' when neither could be told (the file did not load for the test, a script
 * streams it).
 */
export type Recorded = 'yes' | 'live' | 'unknown';

/**
 * 1.2.1 for a sound-only item (native audio, audio file link, podcast player). The criterion covers
 * PRERECORDED audio only (review round 1, S4). Never failed since batch 17's cut: a recording (`recorded` 'yes')
 * with no transcript found next to it is listed for a person to check (not testable), as is everything else here
 * that is not shown to have its alternative. A live stream, or
 * one that may be live, is undecided (live audio-only is 1.2.9, level AAA, which Granted does not test).
 */
export function judgeAudio(item: { target: string; what: string; recorded?: Recorded }, near: Nearby): ProbeFinding {
  if (near.transcript) return f('1.2.1', 'no_failures_found', item.target, `${item.what} with a transcript linked next to it ("${quoteSentences(near.transcript, 80)}").`);
  // WCAG 1.2.1 asks for an alternative for time-based media (G158), whatever the page calls it: for a clip
  // with no speech (an alert tone, a chime) that is a description of its sounds, not a "transcript".
  if (near.alternative) return f('1.2.1', 'no_failures_found', item.target, `${item.what} with text next to it that the page gives as its alternative ("${quoteSentences(near.alternative, 80)}").`);
  if (near.sounds) return f('1.2.1', 'not_testable', item.target, `the text next to ${item.what} may be its text alternative ("${quoteSentences(near.sounds, 80)}"): whether it gives everything the recording says cannot be told automatically.`);
  // WCAG 1.2.1 leaves out audio that is a media alternative for text and is labelled as one. Whether it says
  // no more than the text cannot be told, so it is undecided, never failed.
  if (near.forText) return f('1.2.1', 'not_testable', item.target, `${item.what} is offered as another way to get text that is on the page ("${quoteSentences(near.forText, 80)}"): an audio alternative for text needs no transcript when it says no more than the text, which cannot be told automatically.`);
  // An audio track beside a silent video is one way to give that video's alternative (G166): not content of its own.
  if (near.besideSilentVideo) return f('1.2.1', 'not_testable', item.target, `${item.what} sits right beside a video with no sound track and may be that video's audio alternative: whether it is cannot be told automatically.`);
  if (near.besideUnknownVideo) return f('1.2.1', 'not_testable', item.target, `${item.what} sits right beside a video whose sound track could not be read (the video did not load when the page was scanned): it may be that video's audio alternative, which cannot be told.`);
  // Right beside a video (nothing between them): one way to give a video an audio description or another language (G173).
  if (near.besideVideo) return f('1.2.1', 'not_testable', item.target, `${item.what} sits right beside a video and may be an audio track for that video (an audio description or another language) rather than a recording of its own, which cannot be told automatically.`);
  // Prerecorded only: a live stream needs no transcript under 1.2.1, and what may be live is not failed.
  const recorded = item.recorded ?? 'unknown';
  if (recorded === 'live') return f('1.2.1', 'not_testable', item.target, `${item.what} has no set length (the browser read no end for it: a live stream, or a recording that does not give its length), and no transcript was found next to it. 1.2.1 asks for a transcript of recordings only: whether this is one could not be told.`);
  if (near.liveText) return f('1.2.1', 'not_testable', item.target, `the page calls ${item.what} live ("${clip(near.liveText, 60)}"), and no transcript was found next to it. 1.2.1 asks for a transcript of recordings only: whether this is a recording or a live stream could not be told.`);
  // A link right beside it may lead to its transcript under a name the test does not read as one ("Read along",
  // "Episode notes (PDF)"): undecided, never failed (review media-v, S3).
  if (near.adjacentLink && recorded === 'yes') return f('1.2.1', 'not_testable', item.target, `no transcript was found next to ${item.what}, but a link right beside it ("${clip(near.adjacentLink, 60)}") may lead to one, which the test does not follow: whether it has a text alternative could not be told.`);
  if (recorded !== 'yes') return f('1.2.1', 'not_testable', item.target, `no transcript was found next to ${item.what}, but its length was not read (its file had not loaded and was not asked for, did not load for the test, or a script streams it), so whether it is a recording or a live stream could not be told. 1.2.1 asks for a transcript of recordings only.`);
  // Batch 17's cut (the lead, last-round rule, precision first): a recording with no transcript found next to it is
  // listed for a person to check (Needs review), never failed. The test looks for the word "transcript" (or the
  // alternative's labels above) in the same part of the page, and the absence of a word is no proof of absence: a
  // full transcript under another heading ("What was said") or in other words was failed, 3 of 10 blind failures
  // wrong. The finding keeps what the scan saw (the recording and why), for a person or a later AI review.
  return f('1.2.1', 'not_testable', item.target, `no transcript was found next to ${item.what} (a link or text with the word "transcript" in the same part of the page), but the page may give one under another name or in other words, which the test cannot tell: for a person to check. People who cannot hear it need a text version of everything said.`);
}

/** A native video's captions and subtitles tracks as the browser loaded them. */
export interface CaptionCues {
  /** Captions and subtitles tracks with a file. */
  tracks: number;
  /** Of them: loaded, and failed to load. */
  loaded: number;
  errors: number;
  /** Cues in the loaded tracks, together. */
  cues: number;
  /** Whether the video has a sound track ('unknown' when it had not loaded its description). */
  sound: 'none' | 'some' | 'unknown';
  /** The name of a control beside the video, or one that names it, that offers captions ('' when there is none). */
  control?: string;
  /** The key the reader gave the element (the same element has the same key in every read of the page). */
  key?: string;
  /** The address of the file the element had when its tracks were read. */
  src?: string;
  /** Text tracks the element lists, of any kind, and its track elements. */
  textTracks?: number;
  /**
   * Text tracks of kind captions or subtitles it lists, whatever they hold and however they came (a track element
   * with or without a file, a script's own track): a player may fill one when a visitor chooses it (review media-v, S2).
   */
  captionTracks?: number;
  trackElements?: number;
}

/**
 * 1.2.2 for a native video whose captions tracks hold nothing: every track loaded and none has a cue. An empty
 * track alone never proves missing captions (review round 1, ruling 8): captions that are part of the picture
 * (open captions) satisfy 1.2.2, and this test cannot see the picture. So the finding is always undecided
 * (`not_testable`), never a failure: it says what was found and what could not be told. Left alone: a video
 * with no sound track, a background video (decoration, or muted with no controls), a video with a cue in any
 * track (a script's own text track included), and a video clearly labelled as another way to get text that is
 * on the page (the exception in 1.2.2: a media alternative for text, `forText`). Tracks that did not load
 * decide nothing either.
 */
export function judgeCaptionCues(v: { target: string; decorative: boolean; muted: boolean; controls: boolean; forText?: string }, c: CaptionCues): ProbeFinding[] {
  if (!c.tracks || v.decorative || (v.muted && !v.controls) || c.sound === 'none' || c.cues > 0 || v.forText) return [];
  if (c.loaded === c.tracks) {
    // A control next to the video may load or show captions another way: the test presses nothing, so it cannot tell.
    if (c.control) return [f('1.2.2', 'not_testable', v.target, `this video's captions track has no captions in it, but a control next to the video offers captions (“${c.control}”): the test does not press it, so whether captions are available could not be told.`)];
    const sound = c.sound === 'some' ? 'the video has sound' : 'whether the video has sound could not be read';
    return [f('1.2.2', 'not_testable', v.target, `this video's captions track has no captions in it (its file loads but holds no cue), and ${sound}. Captions that are part of the picture (open captions) would still caption it, which this test cannot see: whether the video is captioned could not be told.`)];
  }
  if (c.errors > 0 && c.errors + c.loaded === c.tracks) {
    return [f('1.2.2', 'not_testable', v.target, `this video's captions file did not load when the page was scanned, so whether it has captions could not be told.`)];
  }
  return [];
}

/** A native `<video>` as the probe read it. */
export interface NativeVideo {
  target: string;
  src: string;
  tracks: { kind: string }[];
  /** Text tracks the browser lists (in-band ones included). */
  textTracks: number;
  duration: number | 'infinite' | null;
  /** A background video by its own markup (`nativeVideoDecorative`): left to the video and audio rules (1.2.1). */
  decorative: boolean;
}

/**
 * Findings for a native video: an endless one (a live stream) needs captions (1.2.4); a prerecorded one
 * gets 1.2.3/1.2.5 from a descriptions track or a linked described version or transcript, else the
 * AI media review (--ai-media) decides. Its captions track (1.2.2) is the video and audio rules' job.
 */
export function judgeNativeVideo(v: NativeVideo, near: Nearby): ProbeFinding[] {
  if (v.decorative) return [];
  const t = v.target;
  if (v.duration === 'infinite') {
    const has = v.tracks.some((x) => x.kind === 'captions' || x.kind === 'subtitles') || v.textTracks > 0;
    return [has
      ? f('1.2.4', 'not_testable', t, 'this live stream has a captions track; whether the live captions are complete and accurate cannot be tested automatically.')
      // A video with no end may be a recording whose file gives no length, and its sound was not assessed:
      // undecided, never a failure (review media-v, S8).
      : f('1.2.4', 'not_testable', t, 'this video has no set length (a live stream, or a recording whose file gives no length) and no captions track; whether it is live and has sound that needs captions was not assessed, so this was not decided.')];
  }
  const out: ProbeFinding[] = [];
  // A plain video file, or a known length, is prerecorded. A video a script streams (no file address,
  // or a stream playlist) that had not loaded could be live: 1.2.4 cannot be told for it.
  if (v.duration === null && !(v.src && mediaFileType(v.src) === 'video')) {
    out.push(f('1.2.4', 'not_testable', t, 'whether this video is a live stream could not be told: it is streamed by a script and had not loaded its length.'));
  }
  const described = linkedDescribed(near) ?? (v.tracks.some((x) => x.kind === 'descriptions') ? 'it has a descriptions track (text descriptions of what is shown)' : undefined);
  out.push(...describedFindings(t, described, near.transcript,
    'whether the video shows information its sound does not give is judged by the AI media review (--ai-media), for files within its limits.'));
  return out;
}

/** What the probe found on a page, for the not-applicable reasons. */
export interface PageMediaCounts {
  audio: number;
  players: number;
  videos: number;
}

/**
 * Every criterion gets an explicit result on the page: the findings, plus `not_applicable` with the
 * reason for each criterion nothing on the page was tested for (a criterion with no finding would
 * otherwise read as "no failures found").
 */
export function fillPage(findings: ProbeFinding[], counts: PageMediaCounts): ProbeFinding[] {
  const out = [...findings];
  const has = (c: string) => out.some((x) => x.criterion === c);
  const reasons: Record<string, string> = {
    '1.2.1': 'no sound-only player or file on this page',
    '1.2.2': counts.videos ? 'no embedded video player on this page (captions tracks of the page\'s own videos are checked by the video and audio rules)' : 'no video on this page',
    '1.2.3': 'no prerecorded video on this page',
    '1.2.4': 'no live video or audio on this page',
    '1.2.5': 'no prerecorded video on this page',
  };
  for (const c of MEDIA_PLAYER_CRITERIA) if (!has(c)) out.push({ criterion: c, status: 'not_applicable', detail: reasons[c]! });
  return out;
}
