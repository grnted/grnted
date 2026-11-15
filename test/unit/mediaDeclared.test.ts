// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a stream or file declares about its tracks (batch 18, lane media, G9 and G10): manifests, caption files and
// the tracks of MP4 and WebM files. Neutral data only; the readers decide nothing.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { declaredFileTracks, declaredTextTracks, readCaptionFile, readDash, readHls, readManifest } from '../../src/media/declared.js';

const BASE = 'https://district.example/video/master.m3u8';

describe('readHls', () => {
  it('lists subtitles, closed captions and a description audio rendition of a master playlist', () => {
    const m = readHls([
      '#EXTM3U',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English",LANGUAGE="en",DEFAULT=YES,URI="audio/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",NAME="English (described)",LANGUAGE="en",CHARACTERISTICS="public.accessibility.describes-video",URI="audio/en-ad.m3u8"',
      '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",NAME="English CC",LANGUAGE="en",CHARACTERISTICS="public.accessibility.transcribes-spoken-dialog,public.accessibility.describes-music-and-sound",URI="subs/en.m3u8"',
      '#EXT-X-MEDIA:TYPE=CLOSED-CAPTIONS,GROUP-ID="cc",NAME="CC1",LANGUAGE="en",INSTREAM-ID="CC1"',
      '#EXT-X-STREAM-INF:BANDWIDTH=800000,AUDIO="aud",SUBTITLES="subs",CLOSED-CAPTIONS="cc"',
      'low/index.m3u8',
    ].join('\n'), BASE)!;
    expect(m).toMatchObject({ format: 'hls', master: true, variants: 1 });
    expect(m.live).toBeUndefined();
    expect(m.renditions).toEqual([
      { type: 'audio', name: 'English', language: 'en', default: true, uri: 'https://district.example/video/audio/en.m3u8' },
      expect.objectContaining({ type: 'audio', name: 'English (described)', describesVideo: true }),
      expect.objectContaining({ type: 'subtitles', name: 'English CC', transcribesSpokenDialog: true, uri: 'https://district.example/video/subs/en.m3u8' }),
      expect.objectContaining({ type: 'closed-captions', name: 'CC1' }),
    ]);
  });
  it('says a media playlist with an end list is recorded, one without is live, and CLOSED-CAPTIONS=NONE', () => {
    expect(readHls('#EXTM3U\n#EXT-X-PLAYLIST-TYPE:VOD\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST', BASE)).toMatchObject({ master: false, live: false });
    expect(readHls('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\na.ts\n#EXTINF:6,\nb.ts', BASE)).toMatchObject({ master: false, live: true });
    expect(readHls('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1,CLOSED-CAPTIONS=NONE\nx.m3u8', BASE)).toMatchObject({ captionsNone: true });
    expect(readHls('<html></html>', BASE)).toBeUndefined();
  });
});

describe('readDash', () => {
  it('reads a dynamic MPD with a text set, 608 captions and a description audio set', () => {
    const m = readDash(`<?xml version="1.0"?><MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic"><Period>
      <AdaptationSet contentType="video" mimeType="video/mp4"><Accessibility schemeIdUri="urn:scte:dash:cc:cea-608:2015" value="CC1=eng"/><Representation id="v"/></AdaptationSet>
      <AdaptationSet contentType="audio" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="main"/><Representation id="a"/></AdaptationSet>
      <AdaptationSet contentType="audio" lang="en"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="description"/><Representation id="ad"/></AdaptationSet>
      <AdaptationSet contentType="text" mimeType="text/vtt" lang="es"><Role schemeIdUri="urn:mpeg:dash:role:2011" value="subtitle"/><Representation id="t"><BaseURL>subs/es.vtt</BaseURL></Representation></AdaptationSet>
    </Period></MPD>`, 'https://district.example/live/manifest.mpd')!;
    expect(m).toMatchObject({ format: 'dash', live: true, variants: 1 });
    expect(m.renditions.map((r) => r.type)).toEqual(['closed-captions', 'audio', 'audio', 'subtitles']);
    expect(m.renditions[2]).toMatchObject({ describesVideo: true });
    expect(m.renditions[3]).toMatchObject({ language: 'es', uri: 'https://district.example/live/subs/es.vtt' });
    expect(readManifest('<MPD type="static"></MPD>', BASE)).toMatchObject({ format: 'dash', live: false });
  });
});

describe('readCaptionFile', () => {
  it('reads WebVTT, SRT, SBV and TTML, and names SCC without decoding it', () => {
    expect(readCaptionFile('WEBVTT\n\n00:00:01.000 --> 00:00:02.500\nHello.')).toEqual({ format: 'webvtt', cues: [{ start: 1, end: 2.5, text: 'Hello.' }], browserReadable: true });
    expect(readCaptionFile('1\n00:00:01,000 --> 00:00:03,000\nThe board meets\non Monday.\n\n2\n00:00:03,500 --> 00:00:05,000\n<i>Applause</i>')).toEqual({
      format: 'srt', browserReadable: false, cues: [{ start: 1, end: 3, text: 'The board meets on Monday.' }, { start: 3.5, end: 5, text: 'Applause' }],
    });
    expect(readCaptionFile('0:00:01.000,0:00:02.000\nWelcome.\n\n0:00:02.500,0:00:04.000\nThanks.')).toMatchObject({ format: 'sbv', cues: [{ start: 1, end: 2, text: 'Welcome.' }, { start: 2.5, end: 4, text: 'Thanks.' }] });
    expect(readCaptionFile('<?xml version="1.0"?><tt xmlns="http://www.w3.org/ns/ttml"><body><div><p begin="00:00:01.000" end="00:00:02.000">Room 4<br/>at 6 pm</p><p begin="3s" dur="1.5s">Thank you</p></div></body></tt>')).toEqual({
      format: 'ttml', browserReadable: false, cues: [{ start: 1, end: 2, text: 'Room 4 at 6 pm' }, { start: 3, end: 4.5, text: 'Thank you' }],
    });
    expect(readCaptionFile('Scenarist_SCC V1.0\n\n00:00:01:00\t9420 9420')).toEqual({ format: 'scc', cues: [], browserReadable: false });
    expect(readCaptionFile('not captions')).toEqual({ format: 'unknown', cues: [], browserReadable: false });
  });
});

describe('declaredFileTracks', () => {
  const file = (p: string) => new Uint8Array(readFileSync(new URL(`../fixtures/media/${p}`, import.meta.url)));
  it('lists an MP4\'s tracks (handler and sample entry) and a WebM\'s (type and codec)', () => {
    const mp4 = declaredFileTracks(file('files/speech-plain-opus.mp4'))!;
    expect(mp4.map((t) => t.kind).sort()).toEqual(['soun', 'vide']);
    expect(mp4.find((t) => t.kind === 'soun')!.codec).toBe('Opus');
    const webm = declaredFileTracks(file('clip-tone.webm'))!;
    expect(webm.map((t) => t.kind).sort()).toEqual(['audio', 'video']);
    expect(webm.find((t) => t.kind === 'video')!.codec).toBe('V_VP8');
    expect(declaredTextTracks([...mp4, ...webm])).toEqual([]);
    expect(declaredFileTracks(new TextEncoder().encode('<html>'))).toBeUndefined();
  });
  it('picks out text tracks by handler, track type or sample entry', () => {
    expect(declaredTextTracks([{ kind: 'text', codec: 'tx3g' }, { kind: 'subtitle', codec: 'S_TEXT/WEBVTT' }, { kind: 'vide', codec: 'avc1' }, { kind: 'clcp', codec: 'c608' }]).map((t) => t.codec)).toEqual(['tx3g', 'S_TEXT/WEBVTT', 'c608']);
  });
});
