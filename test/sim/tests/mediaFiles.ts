// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The media-files test: 1.2.2 Captions (Prerecorded) for a page's own video files (probe `media-files`).
//
// Source of truth. SC 1.2.2: "Captions are provided for all prerecorded audio content in synchronized media,
// except when the media is a media alternative for text and is clearly labeled as such." Captions are a
// "synchronized visual and/or text alternative for both speech and non-speech audio information needed to
// understand the media content": closed (a captions track, G87, H95) or open (part of the picture, G93). A
// transcript beside the video is not captions (1.2.2 has no such exception). A video with no sound, or whose
// sound gives no information (music under a picture), has nothing to caption.
//
// The answer by construction. Every clip is built by scripts/media-fixtures.mjs: its sound is synthetic speech
// (English, a second English voice, Spanish), a tune, chimes, silence or nothing, and its picture is flat,
// a large moving shape, a slide of text, footage-like detail, or flat with captions drawn in.
// - fail: speech, a picture that shows no writing, and no captions the page gives: no track at all, a
//   captions track whose file loads with no cue, a captions track whose file is missing (404), or only
//   tracks of other kinds (descriptions, chapters). In a figure, a WordPress or Drupal video block, beside a
//   transcript, or on a same-site player page in a frame.
// - fail, and beyond this test (it cannot read writing in a picture, so it says "not testable"): speech over
//   footage with no captions; open captions for the last sentence only; one burned-in line that gives a
//   fraction of what is said.
// - pass: the same videos with a captions or subtitles track that has cues, or cues a script added; open
//   captions for every sentence; a tune; a silent sound track; no sound track; a muted background video; a
//   video labelled as a video version of text that is on the page.
// - any (not counted): a slide that restates the speech, chimes (whether they carry information is a
//   judgement), a captions button or the page's own player (whether they give captions was not built), a
//   caption area, a hidden video.
//
// Fix round 1 (the review's S1, S2, S3, S5, S7) added, each by construction:
// - pass, captions that come when the video plays: a script gives the video its captions track on its first
//   play, or shows what is said as text over it while it plays. The script is one the scan cannot read
//   beforehand: the end of a bundle longer than it reads, a module the page imports, or code that names nothing
//   about captions. (An auditor presses play and sees captions.)
// - pass, sound that is like speech and is not: the same speech played backwards (no words), a voice without
//   words (syllables on a tune, scat, humming, one vowel), music the first set did not have (an arpeggio, a
//   sliding lead between bursts of hiss, a synthesiser made to sound like talk, an organ).
// - pass, captions the picture gives where a coarse reader does not look: every sentence in the last 14 rows of
//   a 642 x 366 frame; small letters in a 2560 x 1440 frame. fail: the same odd-sized frame, plain.
// - fail, long recordings: 36 s in six channels, 70 s in an MP4 with its index at its end (no captions, a plain
//   picture): the test decodes a cut of them and must still decide.
// - pass: a video whose first listed file (open captions) is of a type the scan's browser cannot play, with the
//   plain version listed second: visitors whose browser plays the first get its captions.
// - any: a captions button far from the video that the lab did not wire up.
//
// Fix round 1, S7 hardening (the packet census, src/media/container.ts) added, each by construction:
// - fail, beyond this test by construction (undecided, and never decoded): the spoken notice over a plain picture,
//   no captions, in files that say less sound than their packets hold: a WebM whose length, index and tags say 2 s
//   (400 s of packets), the same in an MP4 (every length, edit and sample time) and in MP4 fragments, a WebM whose
//   media ends by its own size after its first part, an MP4 whose edit list plays its sound three times.
// - fail: honest files of the shapes the census reads: Vorbis in WebM, Opus in MP4, AAC in MP4 fragments, 50 s of
//   AAC at 48 kHz in two channels (cut to fit the limit), the same at one frame a second (its sound stored in long
//   pieces: the cut falls back to before the piece the cut is in).
// - pass: the same honest shapes with a captions track.
//
// The media-alternatives test (1.2.1, probe `media-alternatives`): SC 1.2.1 covers PRERECORDED audio-only
// content. fail: a recording (speech, a tune, chimes) with no transcript or text alternative beside it, as the
// page's own player (loaded or not) or a linked file. pass: the same with a transcript linked or written out
// beside it; a stream with no end (live audio is not 1.2.1's). any: a recording the page calls live; a linked
// file that does not exist.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mediaAlternativesProbe, mediaFilesProbe } from '../../../src/probes/mediaFiles.js';
import { applyHazard, filler, hash, parts, render, rng } from '../page.js';
import type { Hazard, SimCase, SimTest, Verdict } from '../types.js';

const clips = new Map<string, Uint8Array>();
const clip = (name: string): Uint8Array => {
  let b = clips.get(name);
  if (!b) clips.set(name, (b = readFileSync(fileURLToPath(new URL(`../../fixtures/media/files/${name}`, import.meta.url)))));
  return b;
};
const VTT = readFileSync(fileURLToPath(new URL('../../fixtures/media/files/speech.vtt', import.meta.url)), 'utf8');
const EMPTY_VTT = 'WEBVTT\n\nNOTE The captions for this video are being prepared.\n';
const OTHER_VTT = 'WEBVTT\n\n00:00:00.000 --> 00:00:04.000\nA green title card.\n';
const SAID = 'The council meets on the first Tuesday of each month. Agendas are posted three days before each meeting. Public comment begins at six thirty in the evening.';

export const MEDIA_HAZARDS: readonly Hazard[] = ['none', 'cookie-banner', 'sticky-header', 'late-mount', 'lazy-images', 'smooth-scroll', 'font-swap', 'load-popup'];
export const MEDIA_WRAPPERS = ['plain', 'figure', 'wordpress', 'drupal', 'transcript', 'frame'] as const;
type Wrapper = (typeof MEDIA_WRAPPERS)[number];

/**
 * How the video is given captions (or not). The last four come only when the video plays: a track from the end
 * of a long bundle, a track from a module the page imports, and the words as text over the video from a script
 * on the page or from the bundle.
 */
type Captions = 'none' | 'empty' | 'gone' | 'other-kinds' | 'track' | 'subtitles' | 'script' | 'play-bundle' | 'play-module' | 'play-words' | 'play-words-bundle' | 'canvas' | 'chosen' | 'no-file';
const FAIL_CAPTIONS: readonly Captions[] = ['none', 'empty', 'gone', 'other-kinds'];
const SPEECH_PLAIN = ['speech-plain.webm', 'speech-plain-f.webm', 'speech-plain-es.webm', 'speech-moving.webm'] as const;

interface Subject {
  file: string;
  captions: Captions;
  wrapper: Wrapper;
  /** Attributes of the video element (default: the browser's controls). */
  attrs?: string;
  /** Markup right after the video, inside its block. */
  extra?: string;
  /** Markup before the video's block. */
  lead?: string;
  label?: string;
  css?: string;
  /** A file of a type no browser plays, listed before the video's own file (the open-captioned version). */
  firstFile?: string;
  /** Markup before the page's main content (a tool bar). */
  before?: string;
}

/** A script that waits for the video and gives it its captions track the first time it plays. */
const TRACK_ON_PLAY = "(function wait() { var v = document.getElementById('notice'); if (!v) { setTimeout(wait, 50); return; } v.addEventListener('play', function once() { v.removeEventListener('play', once); var t = document.createElement('track'); t.kind = 'captions'; t.srclang = 'en'; t.label = 'English'; t.default = true; t.src = '/media/captions.vtt'; v.appendChild(t); }); })();";
/** A script that waits for the video and shows what is said as text over it while it plays (no text track; it names nothing about captions). */
const WORDS_ON_PLAY = "(function wait() { var v = document.getElementById('notice'); if (!v) { setTimeout(wait, 50); return; } var lines = [[0.3, 3.41, 'The council meets on the first Tuesday of each month.'], [3.71, 6.74, 'Agendas are posted three days before each meeting.'], [7.04, 10.35, 'Public comment begins at six thirty in the evening.']]; var box = null; v.addEventListener('timeupdate', function () { if (!box) { box = document.createElement('div'); box.style.cssText = 'margin:4px 0;min-height:1.4em;color:#111;background:#fff;font:16px sans-serif'; v.parentNode.insertBefore(box, v.nextSibling); } var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; box.textContent = now ? now[2] : ''; }); })();";
/** A canvas the page puts over the video when it loads (kept over it), drawing what is said into it as the video plays. */
const CANVAS_OVER = "(function wait() { var v = document.getElementById('notice'); if (!v) { setTimeout(wait, 50); return; } var lines = [[0.3, 3.41, 'The council meets on the first Tuesday of each month.'], [3.71, 6.74, 'Agendas are posted three days before each meeting.'], [7.04, 10.35, 'Public comment begins at six thirty in the evening.']]; var c = document.createElement('canvas'); c.width = 640; c.height = 300; c.style.cssText = 'position:absolute;pointer-events:none;z-index:5'; document.body.appendChild(c); var place = function () { var r = v.getBoundingClientRect(); c.style.left = (r.left + window.scrollX) + 'px'; c.style.top = (r.top + window.scrollY) + 'px'; c.style.width = r.width + 'px'; c.style.height = Math.max(1, r.height - 60) + 'px'; }; place(); setInterval(place, 200); var g = c.getContext('2d'); v.addEventListener('timeupdate', function () { place(); g.clearRect(0, 0, 640, 300); var now = lines.filter(function (l) { return v.currentTime >= l[0] && v.currentTime < l[1]; })[0]; if (now) { g.font = '18px sans-serif'; g.fillStyle = '#fff'; g.fillText(now[2], 20, 280); } }); })();";
/** An empty captions track the page's player makes, filled only when a visitor chooses it in the captions menu. */
const TRACK_ON_CHOOSE = "(function wait() { var v = document.getElementById('notice'); if (!v) { setTimeout(wait, 50); return; } var t = v.addTextTrack('captions', 'English', 'en'); t.mode = 'disabled'; v.textTracks.addEventListener('change', function () { if (t.mode !== 'disabled' && !(t.cues && t.cues.length)) { t.addCue(new VTTCue(0.3, 3.4, 'The council meets on the first Tuesday of each month.')); t.addCue(new VTTCue(3.7, 6.7, 'Agendas are posted three days before each meeting.')); t.addCue(new VTTCue(7, 10.3, 'Public comment begins at six thirty in the evening.')); } }); })();";
/** 420,000 characters of a bundle's other code: more than the scan reads of one script file. */
const BUNDLE_HEAD = `/* ${'the clerk posts each notice the same day; '.repeat(10_000)} */\n`;

function tracks(c: Captions): string {
  if (c === 'empty') return '<track kind="captions" src="/media/empty.vtt" srclang="en" label="English" default>';
  if (c === 'gone') return '<track kind="captions" src="/media/captions-en.vtt" srclang="en" label="English" default>';
  if (c === 'other-kinds') return '<track kind="descriptions" src="/media/described.vtt" srclang="en" label="Descriptions"><track kind="chapters" src="/media/described.vtt" srclang="en">';
  if (c === 'track') return '<track kind="captions" src="/media/captions.vtt" srclang="en" label="English" default>';
  if (c === 'subtitles') return '<track kind="subtitles" src="/media/captions.vtt" srclang="en" label="English">';
  if (c === 'no-file') return '<track kind="captions" srclang="en" label="English">';
  return '';
}

function build(s: Subject, id: string, hazard: Hazard, seed: number): { site: SimCase['site'] } {
  const r = rng(hash(id) ^ seed);
  const src = `/media/${s.file}`;
  const kind = s.file.endsWith('.mp4') ? 'video/mp4' : 'video/webm';
  const label = s.label ? ` aria-label="${s.label}"` : '';
  const attrs = s.attrs ?? 'controls preload="metadata"';
  const first = s.firstFile ? `<source src="/media/${s.firstFile}" type="video/x-notice">` : '';
  const video = (inner = tracks(s.captions)) => (first
    ? `<video id="notice" ${attrs}${label} width="640" height="360">${first}<source src="${src}" type="${kind}">${inner}</video>`
    : `<video id="notice" ${attrs}${label} width="640" height="360" src="${src}">${inner}</video>`);
  let block: string;
  if (s.wrapper === 'figure') block = `<figure>${video()}<figcaption>Council notice, spring session</figcaption></figure>`;
  else if (s.wrapper === 'wordpress') block = `<div style="width:640px" class="wp-video"><video class="wp-video-shortcode" id="notice" width="640" height="360" ${attrs}${label}><source type="${kind}" src="${src}">${tracks(s.captions)}<a href="${src}">${src}</a></video></div>`;
  else if (s.wrapper === 'drupal') block = `<div class="media media--type-video media--view-mode-default"><div class="field field--name-field-media-video-file field--type-file"><video id="notice" ${attrs}${label} width="640" height="360"><source src="${src}" type="${kind}">${tracks(s.captions)}</video></div></div>`;
  else if (s.wrapper === 'transcript') block = `<section>${video()}<h3>Transcript</h3><p>${SAID}</p></section>`;
  else if (s.wrapper === 'frame') block = '<iframe src="/player.html" title="Council notice player" width="680" height="400"></iframe>';
  else block = video();
  const init: string[] = [];
  if (s.captions === 'script' && s.wrapper !== 'frame') {
    init.push("(function () { var v = document.getElementById('notice'); var t = v.addTextTrack('captions', 'English', 'en'); t.mode = 'hidden'; t.addCue(new VTTCue(0.3, 3.4, 'The council meets on the first Tuesday of each month.')); t.addCue(new VTTCue(3.7, 6.7, 'Agendas are posted three days before each meeting.')); t.addCue(new VTTCue(7, 10.3, 'Public comment begins at six thirty in the evening.')); })();");
  }
  if (s.captions === 'play-words') init.push(WORDS_ON_PLAY);
  if (s.captions === 'canvas') init.push(CANVAS_OVER);
  if (s.captions === 'chosen') init.push(TRACK_ON_CHOOSE);
  const pg = parts('Council notices', `<h2>Watch the notice</h2>${s.lead ?? ''}${block}${s.wrapper === 'frame' ? '' : (s.extra ?? '')}${filler(r, 2)}`, s.css ? [s.css] : [], init);
  if (s.captions === 'play-bundle' || s.captions === 'play-words-bundle') {
    pg.head.push('<script src="/assets/site.js" defer></script>');
    pg.files['/assets/site.js'] = `${BUNDLE_HEAD}${s.captions === 'play-bundle' ? TRACK_ON_PLAY : WORDS_ON_PLAY}\n`;
  }
  if (s.captions === 'play-module') {
    pg.head.push("<script type=\"module\">import('/assets/player.js');</script>");
    pg.files['/assets/player.js'] = `${TRACK_ON_PLAY}\nexport {};\n`;
  }
  if (s.before) pg.before.push(s.before);
  if (s.firstFile) pg.files[`/media/${s.firstFile}`] = clip(s.firstFile);
  pg.files[src] = clip(s.file);
  pg.files['/media/empty.vtt'] = EMPTY_VTT;
  pg.files['/media/captions.vtt'] = VTT;
  pg.files['/media/described.vtt'] = OTHER_VTT;
  if (s.wrapper === 'frame') {
    const script = s.captions === 'script' ? `<script>${"(function () { var v = document.getElementById('notice'); var t = v.addTextTrack('captions', 'English', 'en'); t.mode = 'hidden'; t.addCue(new VTTCue(0.3, 3.4, 'The council meets on the first Tuesday of each month.')); })();"}</script>` : '';
    pg.files['/player.html'] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Council notice player</title><style>body{margin:0}${s.css ?? ''}</style></head><body>${video()}${s.extra ?? ''}${script}</body></html>`;
  }
  applyHazard(pg, hazard, r);
  return { site: render(pg) };
}

function make(group: string, s: Subject, verdict: Verdict, why: string, n: number, seed: number): SimCase {
  const hazard = MEDIA_HAZARDS[n % MEDIA_HAZARDS.length]!;
  const id = `media-files/${group}/${s.file.replace(/\.(webm|mp4)$/, '')}/${s.captions}/${s.wrapper}/${n}/${hazard}`;
  return {
    id, test: 'media-files', hazard, params: { group, clip: s.file, captions: s.captions, wrapper: s.wrapper },
    site: build(s, id, hazard, seed).site,
    expect: { '1.2.2': verdict === 'fail' ? { verdict, count: 1 } : { verdict } },
    why,
  };
}

export function mediaFilesCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  const add = (group: string, s: Subject, verdict: Verdict, why: string) => out.push(make(group, s, verdict, why, n++, seed));
  // Fail: speech, a picture with no writing, no captions the page gives (64 cases).
  SPEECH_PLAIN.forEach((file, ci) => FAIL_CAPTIONS.forEach((captions, ki) => {
    for (let j = 0; j < 4; j++) {
      const wrapper = MEDIA_WRAPPERS[(ci * 4 + ki + j) % MEDIA_WRAPPERS.length]!;
      const what = captions === 'none' ? 'no captions track' : captions === 'empty' ? 'a captions track whose file holds no cue' : captions === 'gone' ? 'a captions track whose file is missing' : 'only descriptions and chapters tracks';
      add('no-captions', { file, captions, wrapper }, 'fail', `speech over a picture with no writing, with ${what}${wrapper === 'transcript' ? ' (a transcript beside it is not captions)' : ''}`);
    }
  }));
  // Fail, beyond this test: writing in the picture that it cannot read.
  for (const wrapper of ['plain', 'figure', 'drupal'] as const) {
    add('footage', { file: 'speech-footage.webm', captions: 'none', wrapper }, 'fail', 'speech over detailed footage with no captions anywhere');
    add('late-captions', { file: 'speech-late-captions.webm', captions: 'none', wrapper }, 'fail', 'only the last of three sentences is captioned in the picture');
    add('one-line', { file: 'speech-static-caption.webm', captions: 'none', wrapper }, 'fail', 'one burned-in line gives a fraction of what is said');
  }
  // Pass: captions in a track, a subtitles track, cues a script added.
  for (const file of SPEECH_PLAIN.slice(0, 3)) for (const wrapper of MEDIA_WRAPPERS) add('captioned', { file, captions: 'track', wrapper }, 'pass', 'the same speech with captions in a track');
  for (const wrapper of MEDIA_WRAPPERS) add('subtitles', { file: 'speech-plain.webm', captions: 'subtitles', wrapper }, 'pass', 'a subtitles track with cues in the language of the speech');
  for (const wrapper of ['plain', 'figure', 'transcript', 'frame'] as const) add('script-track', { file: 'speech-plain.webm', captions: 'script', wrapper }, 'pass', 'a script added a captions text track with cues');
  // Pass: open captions for everything said.
  for (let k = 0; k < 2; k++) for (const wrapper of MEDIA_WRAPPERS) add('open-captions', { file: 'speech-open-captions.webm', captions: 'none', wrapper }, 'pass', 'every sentence is shown in the picture while it is spoken (open captions)');
  // Pass: nothing to caption.
  for (const wrapper of MEDIA_WRAPPERS) add('tune', { file: 'tune-plain.webm', captions: 'none', wrapper }, 'pass', 'a tune with no speech: no information to caption');
  for (const wrapper of MEDIA_WRAPPERS) add('silent-track', { file: 'silent-track.webm', captions: 'none', wrapper }, 'pass', 'its sound track is silent');
  for (const wrapper of MEDIA_WRAPPERS) add('no-sound', { file: 'no-sound.webm', captions: 'none', wrapper }, 'pass', 'it has no sound track');
  for (const wrapper of ['plain', 'figure', 'drupal', 'wordpress'] as const) {
    add('background', { file: 'speech-plain.webm', captions: 'none', wrapper, attrs: 'autoplay muted loop playsinline aria-hidden="true"' }, 'pass', 'a muted, looping background video without controls: nobody can turn its sound on');
  }
  // Pass: a media alternative for text, labelled as one, with the text before it.
  for (const wrapper of MEDIA_WRAPPERS) {
    add('alternative', { file: 'speech-plain.webm', captions: 'none', wrapper: wrapper === 'frame' ? 'plain' : wrapper, lead: `<p>${SAID}</p>`, label: 'Video version of the notice above' }, 'pass', 'labelled as a video version of the text right before it, which gives the same words');
  }
  // Any: not built to an answer, or a judgement.
  for (const wrapper of ['plain', 'figure', 'drupal', 'transcript'] as const) add('slide', { file: 'speech-slide.webm', captions: 'none', wrapper }, 'any', 'a slide that restates what is said: whether that is captions is a judgement');
  for (const wrapper of ['plain', 'figure', 'drupal', 'transcript'] as const) add('chimes', { file: 'chime-plain.webm', captions: 'none', wrapper }, 'any', 'chimes: whether they carry information is a judgement');
  add('captions-button', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', extra: '<div class="bar"><button type="button">Captions</button></div>' }, 'any', 'a captions button the lab did not wire up');
  add('captions-button', { file: 'speech-plain.webm', captions: 'empty', wrapper: 'figure', extra: '<button type="button" aria-label="Turn on closed captions">CC</button>' }, 'any', 'a captions button the lab did not wire up');
  add('captions-button', { file: 'speech-plain.webm', captions: 'none', wrapper: 'frame', extra: '<button type="button" class="player-cc-button" style="width:32px;height:32px"></button>' }, 'any', 'an icon-only captions button the lab did not wire up');
  add('own-player', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', attrs: 'preload="metadata"', extra: '<div class="bar"><button type="button">Play</button></div>' }, 'any', 'the page\'s own player: what it offers was not built');
  add('own-player', { file: 'speech-plain.webm', captions: 'none', wrapper: 'drupal', attrs: 'preload="metadata"', extra: '<div class="bar"><button type="button">Play</button></div>' }, 'any', 'the page\'s own player: what it offers was not built');
  add('caption-area', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', extra: '<div class="video-captions" aria-live="polite"></div>' }, 'any', 'an empty caption area a script could fill');
  add('caption-area', { file: 'speech-plain.webm', captions: 'none', wrapper: 'figure', extra: '<div id="subtitle-line"></div>' }, 'any', 'an empty caption area a script could fill');
  add('hidden', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', css: '#notice { display: none; }' }, 'any', 'hidden when the page is read');
  add('hidden', { file: 'speech-plain.webm', captions: 'none', wrapper: 'figure', css: 'figure { visibility: hidden; }' }, 'any', 'hidden when the page is read');

  // ---- Fix round 1 -----------------------------------------------------------------------------------
  // Pass: captions that come when the video plays, from a script the scan cannot read beforehand (S1).
  const PLAY_WRAPPERS = ['plain', 'figure', 'wordpress', 'drupal'] as const;
  for (const file of SPEECH_PLAIN.slice(0, 3)) {
    for (const wrapper of PLAY_WRAPPERS) {
      add('captions-on-play', { file, captions: 'play-bundle', wrapper }, 'pass', 'a script at the end of a long bundle gives the video its captions track when it first plays');
      add('captions-on-play', { file, captions: 'play-module', wrapper }, 'pass', 'a module the page imports gives the video its captions track when it first plays');
      add('words-on-play', { file, captions: 'play-words', wrapper }, 'pass', 'a script on the page shows every sentence as text under the video while it is spoken');
      add('words-on-play', { file, captions: 'play-words-bundle', wrapper }, 'pass', 'a script at the end of a long bundle shows every sentence as text under the video while it is spoken');
    }
  }
  // Pass: sound that is like speech and is not (S5).
  for (const wrapper of MEDIA_WRAPPERS) {
    for (const file of ['speech-reversed.webm', 'speech-reversed-f.webm', 'speech-reversed-es.webm']) add('backwards', { file, captions: 'none', wrapper }, 'pass', 'the spoken notice played backwards: no words, nothing to caption as speech');
    for (const file of ['vocal-la.webm', 'vocal-scat.webm', 'vocal-hum.webm', 'vocal-ah.webm']) add('voice-no-words', { file, captions: 'none', wrapper }, 'pass', 'a voice without words (syllables on a tune, scat, humming, one vowel)');
    for (const file of ['music-arp.webm', 'music-lead.webm', 'music-talk.webm', 'music-organ.webm']) add('music-held-out', { file, captions: 'none', wrapper }, 'pass', 'music with no speech (an arpeggio, a sliding lead, a talking synthesiser, an organ)');
  }
  // Pass: captions in the picture where a coarse reader does not look; fail: the same odd frame size, plain (S2).
  for (const wrapper of MEDIA_WRAPPERS) {
    add('edge-captions', { file: 'speech-edge-captions.webm', captions: 'none', wrapper }, 'pass', 'every sentence is shown in the last 14 rows of a 642 x 366 picture while it is spoken (open captions)');
    add('small-captions', { file: 'speech-small-captions.webm', captions: 'none', wrapper }, 'pass', 'every sentence is shown in small letters in a 2560 x 1440 picture while it is spoken (open captions)');
  }
  FAIL_CAPTIONS.forEach((captions, ki) => {
    for (let j = 0; j < 3; j++) add('odd-size', { file: 'speech-plain-odd.webm', captions, wrapper: MEDIA_WRAPPERS[(ki * 2 + j) % MEDIA_WRAPPERS.length]! }, 'fail', 'speech over a plain 642 x 366 picture with no captions the page gives');
  });
  // Fail: long recordings, measured from a cut of the file (S7).
  for (const wrapper of ['plain', 'figure', 'drupal', 'frame'] as const) {
    add('long', { file: 'speech-long-six.webm', captions: 'none', wrapper }, 'fail', '36 s of speech in six channels over a plain picture, no captions');
    add('long', { file: 'speech-long-mp4.mp4', captions: 'none', wrapper }, 'fail', '70 s of speech in an MP4 file with its index at its end, a plain picture, no captions');
  }
  // Pass: the first file the video lists is the open-captioned one, of a type the scan's browser does not play (S3).
  for (const wrapper of ['plain', 'figure', 'transcript', 'frame'] as const) {
    add('first-file', { file: 'speech-plain.webm', captions: 'none', wrapper, firstFile: 'speech-open-captions.webm' }, 'pass', 'the video lists an open-captioned file first (a type the scan\'s browser does not play) and the plain one second');
  }
  // Any: a captions button far from the video that the lab did not wire up.
  add('far-control', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', before: '<div role="toolbar" aria-label="Page tools"><button type="button">Text size</button> <button type="button" aria-pressed="false">Subtitles</button></div>' }, 'any', 'a subtitles button in a tool bar far from the video, not wired up');
  // Any: a settings button beside the video (what its menu offers was not built); the words beside the video, each sentence marked while it is spoken (whether that is captions is a judgement).
  add('menu-control', { file: 'speech-plain.webm', captions: 'none', wrapper: 'plain', extra: '<div class="bar"><button type="button" aria-label="Settings">&#9881;</button></div>' }, 'any', 'a settings button beside the video, not wired up');
  add('menu-control', { file: 'speech-plain.webm', captions: 'none', wrapper: 'figure', extra: '<button type="button" class="tool" style="width:32px;height:32px"></button>' }, 'any', 'a button with no name beside the video, not wired up');
  add('far-control', { file: 'speech-plain.webm', captions: 'none', wrapper: 'drupal', before: '<div role="toolbar" aria-label="Page tools"><button type="button" class="tool tool--cc" style="width:32px;height:32px" aria-label="Closed captions"></button></div>' }, 'any', 'a captions button in a tool bar far from the video, not wired up');
  // ---- Fix round 1, S7 hardening: the packet census --------------------------------------------------
  const CENSUS_WRAPPERS = ['plain', 'figure', 'wordpress', 'drupal', 'transcript', 'frame'] as const;
  // Fail, beyond the test by construction: files that say less sound than their packets hold (never decoded).
  const LIES = [
    ['lies-webm-length.webm', 'a WebM whose length, index and tags say 2 s and whose packets hold 400 s'],
    ['lies-webm-tail.webm', 'a WebM whose media ends, by its own size, after its first part, with 400 s of sound after it'],
    ['lies-mp4-times.mp4', 'an MP4 whose lengths, edit and sample times say 2 s and whose packets hold 400 s'],
    ['lies-mp4-fragments.mp4', 'an MP4 in fragments whose length and fragment times say 2 s and whose packets hold 400 s'],
    ['lies-mp4-edits.mp4', 'an MP4 whose edit list plays its 40 s of sound three times'],
  ] as const;
  LIES.forEach(([file, what], fi) => {
    for (let j = 0; j < 12; j++) {
      add('census-lies', { file, captions: FAIL_CAPTIONS[j % FAIL_CAPTIONS.length]!, wrapper: CENSUS_WRAPPERS[(fi + j) % CENSUS_WRAPPERS.length]! }, 'fail', `speech over a plain picture with no captions, in ${what}: the test may not decode it`);
    }
  });
  // Fail: honest files of the shapes the census reads, measured and failed; pass: the same with a captions track.
  const SHAPES = [
    ['speech-plain-vorbis.webm', 'Vorbis in a WebM file'],
    ['speech-plain-opus.mp4', 'Opus in an MP4 file'],
    ['speech-aac-fragments.mp4', 'AAC at 48 kHz in two channels in MP4 fragments'],
    ['speech-long-aac48.mp4', '50 s of AAC at 48 kHz in two channels'],
    ['speech-still-aac48.mp4', '50 s of AAC at 48 kHz under a picture at one frame a second'],
  ] as const;
  SHAPES.forEach(([file, what], fi) => {
    for (let j = 0; j < 12; j++) {
      add('census-shapes', { file, captions: FAIL_CAPTIONS[j % FAIL_CAPTIONS.length]!, wrapper: CENSUS_WRAPPERS[(fi + j) % CENSUS_WRAPPERS.length]! }, 'fail', `speech over a plain picture with no captions, ${what}`);
    }
    for (const wrapper of ['plain', 'drupal', 'frame'] as const) add('census-captioned', { file, captions: 'track', wrapper }, 'pass', `the same speech, ${what}, with captions in a track`);
  });
  // ---- The cut round (review media-v) ---------------------------------------------------------------
  // Pass: captions the page gives that the test cannot see: a canvas over the picture that draws what is said as the
  // video plays (S1); an empty captions track a script fills when a visitor chooses it, and a captions track with no
  // file (S2: never "no captions"). Any: a picture over the test's budget, 480 x 2000 (S4: not measured).
  const CUT_WRAPPERS = ['plain', 'figure', 'wordpress', 'drupal', 'transcript'] as const;
  for (const file of SPEECH_PLAIN.slice(0, 3)) {
    for (const wrapper of CUT_WRAPPERS) {
      add('canvas-overlay', { file, captions: 'canvas', wrapper }, 'pass', 'a canvas over the picture draws every sentence while it is spoken (captions the page draws)');
      add('track-chosen', { file, captions: 'chosen', wrapper }, 'pass', 'the page\'s player fills its captions track when a visitor chooses it in the captions menu');
    }
  }
  for (const wrapper of CUT_WRAPPERS) add('track-no-file', { file: 'speech-plain.webm', captions: 'no-file', wrapper }, 'any', 'a captions track with no file: whether the page fills it is not built');
  for (const wrapper of ['plain', 'figure', 'drupal', 'transcript'] as const) add('tall', { file: 'speech-tall.webm', captions: 'none', wrapper }, 'any', 'a 480 x 2000 picture (over the test\'s budget): not measured');
  return out;
}

export const mediaFilesTest: SimTest = {
  id: 'media-files', criteria: ['1.2.2'], probes: () => [mediaFilesProbe], full: false, read: 'probe', readProbes: ['media-files'], capMs: 120_000, cases: mediaFilesCases,
};

// ---- media-alternatives (1.2.1) -----------------------------------------------------------------------
const sound = (name: string): Uint8Array => clip(name);
/** How the sound-only item is on the page. */
type Player = 'player' | 'unloaded' | 'link';
/** What the page gives beside it. */
type Beside = 'nothing' | 'transcript-link' | 'transcript-text' | 'text-alternative' | 'called-live';
const AUDIO_WRAPPERS = ['plain', 'figure', 'section', 'list', 'card'] as const;

function audioCase(group: string, file: string, player: Player, beside: Beside, wrapper: (typeof AUDIO_WRAPPERS)[number], verdict: Verdict, why: string, n: number, seed: number, missing = false): SimCase {
  const hazard = MEDIA_HAZARDS[n % MEDIA_HAZARDS.length]!;
  const id = `media-alternatives/${group}/${file.replace(/\.[a-z0-9]+$/, '')}/${player}/${beside}/${wrapper}/${n}/${hazard}`;
  const r = rng(hash(id) ^ seed);
  const src = `/media/${file}`;
  const item = player === 'link' ? `<p><a href="${src}">Listen to the recording</a></p>` : `<audio id="recording" controls${player === 'unloaded' ? ' preload="none"' : ''} src="${src}"></audio>`;
  const text = beside === 'transcript-link' ? '<p><a href="/transcript.html">Read the transcript</a></p>'
    : beside === 'transcript-text' ? `<h3>Transcript</h3><p>${SAID}</p>`
      : beside === 'text-alternative' ? '<p>Text alternative: two chimes, the second one lower than the first, then silence.</p>'
        : beside === 'called-live' ? '<p>Listen live from six thirty this evening.</p>' : '';
  const inner = `${item}${text}`;
  const block = wrapper === 'figure' ? `<figure>${item}<figcaption>From the council chamber</figcaption></figure>${text}`
    : wrapper === 'section' ? `<section><h3>From the council chamber</h3>${inner}</section>`
      : wrapper === 'list' ? `<ul><li>${inner}</li><li>Agendas are posted three days before each meeting.</li></ul>`
        : wrapper === 'card' ? `<div class="card" style="border:1px solid #767676;padding:12px"><p><strong>From the council chamber</strong></p>${inner}</div>` : inner;
  const pg = parts('Council recordings', `<h2>Listen</h2>${block}${filler(r, 2)}`);
  // Sound files are served as what they are (the lab's server knows pages, scripts, pictures and video by their names).
  if (!missing) pg.routes[src] = { type: file.endsWith('.wav') ? 'audio/wav' : 'audio/webm', body: sound(file), headers: { 'accept-ranges': 'none' } };
  pg.files['/transcript.html'] = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Transcript</title></head><body><h1>Transcript</h1><p>${SAID}</p></body></html>`;
  applyHazard(pg, hazard, r);
  return { id, test: 'media-alternatives', hazard, params: { group, file, player, beside, wrapper }, site: render(pg), expect: { '1.2.1': verdict === 'fail' ? { verdict, count: 1 } : { verdict } }, why };
}

export function mediaAlternativesCases(seed: number): SimCase[] {
  const out: SimCase[] = [];
  let n = 0;
  const PLAYERS: readonly Player[] = ['player', 'unloaded', 'link'];
  // Fail: a recording with nothing beside it (60 cases).
  for (const file of ['speech.wav', 'speech-es.wav', 'tune.wav', 'chime.wav']) for (const player of PLAYERS) for (const wrapper of AUDIO_WRAPPERS) {
    out.push(audioCase('recording', file, player, 'nothing', wrapper, 'fail', `a recording (${file}) with no transcript or text alternative beside it`, n++, seed));
  }
  // Pass: the same with a transcript, linked or written out (30 cases), or with text the page gives as its alternative (6).
  for (const player of PLAYERS) for (const beside of ['transcript-link', 'transcript-text'] as const) for (const wrapper of AUDIO_WRAPPERS) {
    out.push(audioCase('with-transcript', 'speech.wav', player, beside, wrapper, 'pass', 'a recording with its transcript beside it', n++, seed));
  }
  for (const player of PLAYERS) for (const wrapper of ['plain', 'section'] as const) {
    out.push(audioCase('with-text-alternative', 'chime.wav', player, 'text-alternative', wrapper, 'pass', 'chimes with a description of their sounds beside them, labelled as the text alternative', n++, seed));
  }
  // Pass: a stream with no end, nothing beside it: live audio is not 1.2.1's (15 cases).
  for (const player of PLAYERS) for (const wrapper of AUDIO_WRAPPERS) {
    out.push(audioCase('stream', 'live.webm', player, 'nothing', wrapper, 'pass', 'a stream with no end (1.2.1 covers recordings only)', n++, seed));
  }
  // Pass: a stream with a transcript (clean like a recording with one).
  for (const wrapper of AUDIO_WRAPPERS) out.push(audioCase('stream-with-transcript', 'live.webm', 'player', 'transcript-link', wrapper, 'pass', 'a stream with a transcript beside it', n++, seed));
  // Any: a recording the page calls live (a judgement); a linked file that does not exist.
  for (const wrapper of AUDIO_WRAPPERS) out.push(audioCase('called-live', 'speech.wav', 'player', 'called-live', wrapper, 'any', 'the page calls it live and its file has a set length', n++, seed));
  for (const wrapper of ['plain', 'section'] as const) out.push(audioCase('missing', 'gone.wav', 'link', 'nothing', wrapper, 'any', 'a link to a sound file that does not exist', n++, seed, true));
  return out;
}

export const mediaAlternativesTest: SimTest = {
  id: 'media-alternatives', criteria: ['1.2.1'], probes: () => [mediaAlternativesProbe], full: false, read: 'probe', readProbes: ['media-alternatives'], capMs: 60_000, cases: mediaAlternativesCases,
};
