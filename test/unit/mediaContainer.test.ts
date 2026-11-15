// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a media file declares before anything is decoded (src/media/container.ts; fix round 1, S7): its sound
// track's rate and channels, its length, and the cut that holds its first seconds of sound. The media-files
// test sets its decoding bound from this, so a long or many-channel recording is never decoded whole.
// Fixtures: test/fixtures/media/files/ (scripts/media-fixtures.mjs): WebM and the three MP4 layouts.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { decodeSeconds, mediaCut, mediaLayout, type MediaLayout } from '../../src/media/container.js';
import { MEDIA_FILES_LIMITS } from '../../src/probes/mediaFiles.js';

const file = (name: string): Uint8Array => new Uint8Array(readFileSync(fileURLToPath(new URL(`../fixtures/media/files/${name}`, import.meta.url))));
const MB = 1024 * 1024;

describe('the sound a file declares, read from its header', () => {
  it('WebM: codec, rate, channels, length; a picture track; no sound track', () => {
    expect(mediaLayout(file('speech-plain.webm'), 66)).toMatchObject({ container: 'webm', audio: [{ codec: 'A_OPUS', rate: 48000, channels: 1 }], video: true });
    expect(mediaLayout(file('speech-plain.webm'), 66).seconds).toBeCloseTo(10.66, 1);
    expect(mediaLayout(file('speech-long-six.webm'), 66)).toMatchObject({ container: 'webm', audio: [{ codec: 'A_OPUS', rate: 48000, channels: 6 }] });
    expect(mediaLayout(file('no-sound.webm'), 66)).toMatchObject({ container: 'webm', audio: [], video: true });
  });

  it('MP4 in three layouts: the same sound track, sized for what an AAC decoder may give (twice a low rate, two channels for one)', () => {
    for (const name of ['layout-first.mp4', 'layout-last.mp4', 'layout-fragments.mp4', 'speech-long-mp4.mp4']) {
      const lay = mediaLayout(file(name), 66);
      expect(lay, name).toMatchObject({ container: 'mp4', video: true, audio: [{ codec: 'mp4a', rate: 44100, channels: 2 }] });
      expect(lay.why, name).toBeUndefined();
    }
    expect(mediaLayout(file('layout-first.mp4'), 66).seconds).toBeCloseTo(14, 0);
  });

  it('anything else is unknown, with the reason: never a guess', () => {
    const cases: [Uint8Array, string][] = [
      [file('speech.wav'), 'not an MP4 or WebM file'],
      [new Uint8Array(8), 'too short'],
      [new TextEncoder().encode('<!doctype html><title>Not found</title><p>The file is not here.</p>'), 'not an MP4 or WebM file'],
      // An MP4 cut off before its index.
      [file('layout-last.mp4').subarray(0, 6000), 'its index (moov) is missing or cut off'],
    ];
    for (const [bytes, why] of cases) {
      const lay = mediaLayout(bytes, 66);
      expect(lay.audio, why).toEqual([]);
      expect(lay.why, why).toContain(why);
      expect(lay.cut, why).toBeUndefined();
    }
  });
});

describe('how much sound the decoder may be handed (the bound, set before anything is decoded)', () => {
  it('red, the review\'s case: a 30-minute recording in six channels at 48 kHz is never decoded whole: 29 s of it fit the limit', () => {
    const six = [{ codec: 'A_OPUS', rate: 48000, channels: 6 }];
    // Whole, it would take 30 min x 48,000 x 6 x 4 bytes = 1.9 GB before anything is mixed down.
    expect(30 * 60 * 48000 * 6 * 4).toBeGreaterThan(1900 * MB);
    const seconds = decodeSeconds(six, MEDIA_FILES_LIMITS.maxPcmBytes);
    expect(seconds).toBe(29);
    expect(seconds * 48000 * 6 * 4).toBeLessThanOrEqual(MEDIA_FILES_LIMITS.maxPcmBytes);
    expect(Math.min(MEDIA_FILES_LIMITS.cutSeconds, seconds)).toBeGreaterThanOrEqual(MEDIA_FILES_LIMITS.minSeconds);
  });

  it('look-alike: stereo at 48 kHz gets the whole cut (66 s is 25 MB); a file with no sound track, or a codec that cannot be sized, gets nothing', () => {
    const stereo = [{ codec: 'mp4a', rate: 48000, channels: 2 }];
    expect(decodeSeconds(stereo, MEDIA_FILES_LIMITS.maxPcmBytes)).toBeGreaterThanOrEqual(MEDIA_FILES_LIMITS.cutSeconds);
    expect(MEDIA_FILES_LIMITS.cutSeconds * 48000 * 2 * 4).toBeLessThanOrEqual(MEDIA_FILES_LIMITS.maxPcmBytes);
    expect(decodeSeconds([], MEDIA_FILES_LIMITS.maxPcmBytes)).toBe(0);
    expect(decodeSeconds([{ codec: 'ac-3', rate: 0, channels: 0 }], MEDIA_FILES_LIMITS.maxPcmBytes)).toBe(0);
    // The largest track decides.
    expect(decodeSeconds([...stereo, { codec: 'A_OPUS', rate: 48000, channels: 8 }], MEDIA_FILES_LIMITS.maxPcmBytes)).toBe(21);
    // 7.1 at 96 kHz leaves 10 s: the fewest the test decodes. More than that is refused.
    expect(decodeSeconds([{ codec: 'fLaC', rate: 96000, channels: 8 }], MEDIA_FILES_LIMITS.maxPcmBytes)).toBe(10);
    expect(decodeSeconds([{ codec: 'fLaC', rate: 192000, channels: 8 }], MEDIA_FILES_LIMITS.maxPcmBytes)).toBeLessThan(MEDIA_FILES_LIMITS.minSeconds);
  });
});

describe('the cut: a file that holds only the first seconds of the sound', () => {
  /** The cut of `name` at `at` seconds, and the layout of the cut file read again. */
  const cutOf = (name: string, at: number): { lay: MediaLayout; bytes: Uint8Array; again: MediaLayout } => {
    const whole = file(name);
    const lay = mediaLayout(whole, at);
    expect(lay.cut, name).toBeDefined();
    const bytes = mediaCut(whole, lay.cut!);
    return { lay, bytes, again: mediaLayout(bytes, 1e9) };
  };

  it('WebM: at the first part of the file that starts at or after the cut; the file before it is kept as it is', () => {
    const whole = file('speech-long-six.webm');
    const { lay, bytes, again } = cutOf('speech-long-six.webm', 20);
    expect(lay.cut!.seconds).toBeGreaterThanOrEqual(20);
    expect(lay.cut!.seconds).toBeLessThan(27);
    expect(lay.cut!.patch).toBeUndefined();
    expect(bytes.length).toBe(lay.cut!.end);
    expect(bytes.length).toBeLessThan(whole.length * 0.8);
    expect(Buffer.from(bytes).equals(Buffer.from(whole.subarray(0, lay.cut!.end)))).toBe(true);
    expect(again).toMatchObject({ container: 'webm', audio: [{ codec: 'A_OPUS', channels: 6 }] });
  });

  it('MP4 with its index first: the first bytes, up to the first piece of sound at or after the cut', () => {
    const whole = file('layout-first.mp4');
    const { lay, bytes, again } = cutOf('layout-first.mp4', 6);
    expect(lay.cut!.seconds).toBeGreaterThanOrEqual(6);
    expect(lay.cut!.seconds).toBeLessThan(8);
    expect(lay.cut!.patch).toBeUndefined();
    expect(lay.cut!.append).toBeUndefined();
    expect(bytes.length).toBe(lay.cut!.end);
    expect(bytes.length).toBeLessThan(whole.length);
    expect(again).toMatchObject({ container: 'mp4', audio: [{ codec: 'mp4a' }] });
  });

  it('MP4 with its index last: the sample data up to the cut, its size field changed to say so, then the index', () => {
    const whole = file('layout-last.mp4');
    const { lay, bytes, again } = cutOf('layout-last.mp4', 6);
    expect(lay.cut!.patch).toMatchObject({ bytes: 4 });
    expect(lay.cut!.append!.to).toBe(whole.length);
    expect(bytes.length).toBe(lay.cut!.end + (lay.cut!.append!.to - lay.cut!.append!.from));
    expect(bytes.length).toBeLessThan(whole.length);
    // The cut file is an MP4 whose boxes add up, with the same sound track and the same index.
    expect(again).toMatchObject({ container: 'mp4', audio: [{ codec: 'mp4a', rate: 44100, channels: 2 }] });
    expect(again.why).toBeUndefined();
    expect(Buffer.from(bytes.subarray(lay.cut!.end)).equals(Buffer.from(whole.subarray(lay.cut!.append!.from, lay.cut!.append!.to)))).toBe(true);
    // The input is untouched.
    expect(Buffer.from(whole).equals(Buffer.from(file('layout-last.mp4')))).toBe(true);
    // The same cut as the file with its index first holds: the same seconds of sound.
    expect(lay.cut!.seconds).toBeCloseTo(mediaLayout(file('layout-first.mp4'), 6).cut!.seconds, 3);
  });

  it('MP4 in fragments: before the first fragment whose sound starts at or after the cut', () => {
    const { lay, bytes } = cutOf('layout-fragments.mp4', 6);
    expect(lay.cut!.seconds).toBeGreaterThanOrEqual(6);
    expect(lay.cut!.seconds).toBeLessThan(9);
    expect(bytes.length).toBe(lay.cut!.end);
  });

  it('a file shorter than the cut has none: it is decoded whole (the probe compares its length with the limit first)', () => {
    for (const name of ['speech-plain.webm', 'layout-first.mp4', 'layout-last.mp4']) {
      const lay = mediaLayout(file(name), 66);
      expect(lay.cut, name).toBeUndefined();
      expect(lay.cutWhy, name).toBeUndefined();
    }
  });

  it('the long fixtures are cut where the probe asks (60 s of a 70 s MP4; 23 s of 36 s in six channels)', () => {
    const mp4 = mediaLayout(file('speech-long-mp4.mp4'), 60);
    expect(mp4.seconds).toBeCloseTo(70, 0);
    expect(mp4.cut!.seconds).toBeGreaterThanOrEqual(60);
    expect(mp4.cut!.seconds).toBeLessThan(62);
    expect(mp4.cut!.append).toBeDefined();
    const six = mediaLayout(file('speech-long-six.webm'), 23);
    expect(six.cut!.seconds).toBeGreaterThanOrEqual(23);
    expect(six.cut!.seconds).toBeLessThanOrEqual(decodeSeconds(six.audio, MEDIA_FILES_LIMITS.maxPcmBytes));
  });

  it('none of the three uses an outer name (their source is sent into the page as it is)', () => {
    const lay = new Function(`return (${mediaLayout.toString()})`)() as typeof mediaLayout;
    const cut = new Function(`return (${mediaCut.toString()})`)() as typeof mediaCut;
    const most = new Function(`return (${decodeSeconds.toString()})`)() as typeof decodeSeconds;
    const whole = file('layout-last.mp4');
    expect(lay(whole, 6)).toEqual(mediaLayout(whole, 6));
    expect(Buffer.from(cut(whole, lay(whole, 6).cut!)).equals(Buffer.from(mediaCut(whole, mediaLayout(whole, 6).cut!)))).toBe(true);
    expect(most([{ codec: 'A_OPUS', rate: 48000, channels: 6 }], 32 * MB)).toBe(29);
  });
});

// ---- Fix round 1, S7 hardening: the packet census --------------------------------------------------------
// A decoder makes sound of every packet it is handed, whatever times and length the file gives (measured in the
// browser the test runs in: a WebM whose length says 2 s plays as 7 s and decodes to 400 s; one whose media ends,
// by its own size, after its first part decodes to 400 s too; an MP4 with three edits decodes 40 s to 120 s). So
// the sound is counted from its packets before anything is decoded, and the probe decodes nothing it cannot count.

/** A small WebM written here: EBML elements, a sound track, and blocks whose bytes the test chooses. */
const W = {
  vint(n: number): Uint8Array {
    let l = 1;
    while (n >= 2 ** (7 * l) - 1) l++;
    const out = new Uint8Array(l);
    let v = n;
    for (let i = l - 1; i >= 0; i--) { out[i] = v % 256; v = Math.floor(v / 256); }
    out[0]! |= 0x80 >> (l - 1);
    return out;
  },
  cat(parts: Uint8Array[]): Uint8Array {
    const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0));
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  },
  id(id: number): Uint8Array { const b: number[] = []; for (let v = id; v > 0; v = Math.floor(v / 256)) b.unshift(v % 256); return new Uint8Array(b); },
  el(id: number, ...parts: Uint8Array[]): Uint8Array { const data = W.cat(parts); return W.cat([W.id(id), W.vint(data.length), data]); },
  /** An element of unknown size (as a recording that was never closed writes it). */
  open(id: number, ...parts: Uint8Array[]): Uint8Array { return W.cat([W.id(id), new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]), ...parts]); },
  uint(v: number): Uint8Array { return new Uint8Array([v]); },
  f64(v: number): Uint8Array { const b = new Uint8Array(8); new DataView(b.buffer).setFloat64(0, v); return b; },
  str(s: string): Uint8Array { return new TextEncoder().encode(s); },
  opusHead(channels: number): Uint8Array { const b = new Uint8Array(19); b.set(W.str('OpusHead')); b[8] = 1; b[9] = channels; return b; },
  /** A SimpleBlock of track 1 holding `frames` (byte arrays), laced as asked when there is more than one. */
  block(frames: Uint8Array[], lacing: 'xiph' | 'ebml' | 'fixed' | 'none' = 'none', track = 1): Uint8Array {
    const code = { none: 0, xiph: 1, fixed: 2, ebml: 3 }[lacing];
    const head = [W.vint(track), new Uint8Array([0, 0, 0x80 | (code << 1)])];
    if (lacing === 'none') return W.el(0xa3, ...head, ...frames);
    const sizes: Uint8Array[] = [new Uint8Array([frames.length - 1])];
    if (lacing === 'xiph') for (const f of frames.slice(0, -1)) { let s = f.length; const b: number[] = []; while (s >= 255) { b.push(255); s -= 255; } b.push(s); sizes.push(new Uint8Array(b)); }
    if (lacing === 'ebml') {
      sizes.push(W.vint(frames[0]!.length));
      for (let i = 1; i < frames.length - 1; i++) { const d = frames[i]!.length - frames[i - 1]!.length; sizes.push(new Uint8Array([0x80 | (d + 63)])); }
    }
    return W.el(0xa3, ...head, ...sizes, ...frames);
  },
  /** An Opus packet: its first byte (config, code, frame count) and filler. */
  opus(config: number, code = 0, count = 1, len = 40): Uint8Array {
    const b = new Uint8Array(len).fill(0x55);
    b[0] = (config << 3) | code;
    if (code === 3) b[1] = count;
    return b;
  },
  file(opts: { codec?: string; priv?: Uint8Array; channels?: number; duration?: number; clusters: Uint8Array[]; encodings?: boolean; after?: Uint8Array }): Uint8Array {
    const track = W.el(0xae, W.el(0xd7, W.uint(1)), W.el(0x83, W.uint(2)), W.el(0x86, W.str(opts.codec ?? 'A_OPUS')), ...(opts.priv ? [W.el(0x63a2, opts.priv)] : []),
      ...(opts.encodings ? [W.el(0x6d80, W.el(0x6240, W.el(0x5034, W.el(0x4254, W.uint(3)))))] : []),
      W.el(0xe1, W.el(0xb5, W.f64(48000)), W.el(0x9f, W.uint(opts.channels ?? 1))));
    const segment = W.el(0x18538067, W.el(0x1549a966, W.el(0x2ad7b1, new Uint8Array([0x0f, 0x42, 0x40])), W.el(0x4489, W.f64((opts.duration ?? 1) * 1000))), W.el(0x1654ae6b, track), ...opts.clusters);
    return W.cat([W.el(0x1a45dfa3, W.el(0x4282, W.str('webm'))), segment, opts.after ?? new Uint8Array()]);
  },
  cluster(...blocks: Uint8Array[]): Uint8Array { return W.el(0x1f43b675, W.el(0xe7, W.uint(0)), ...blocks); },
};

describe('fix round 1, S7: the census counts every packet, whatever the file says of its length', () => {
  it('honest files: the count is the length they give, within a packet (Opus in WebM and in MP4, Vorbis, AAC in the three MP4 layouts)', () => {
    const cases: [string, number][] = [
      ['speech-plain.webm', 10.66], ['speech-long-six.webm', 36.01], ['tune-plain.webm', 7.17], ['speech-plain-vorbis.webm', 10.67], ['speech-plain-opus.mp4', 10.66],
      ['layout-first.mp4', 14.05], ['layout-last.mp4', 14.05], ['layout-fragments.mp4', 14.05], ['speech-long-mp4.mp4', 70.05], ['speech-long-aac48.mp4', 50.0], ['speech-still-aac48.mp4', 50.0], ['speech-aac-fragments.mp4', 10.69],
    ];
    for (const [name, seconds] of cases) {
      const lay = mediaLayout(file(name), 66);
      expect(lay.censusWhy, name).toBeUndefined();
      expect(lay.census, name).toBeGreaterThanOrEqual(seconds - 0.05);
      expect(lay.census, name).toBeLessThan(seconds + 0.15);
    }
  });

  it('red: files whose length (and index, tags, edit, sample and fragment times) say 2 s and whose packets hold 400 s: the count is 400 s', () => {
    for (const name of ['lies-webm-length.webm', 'lies-mp4-times.mp4', 'lies-mp4-fragments.mp4']) {
      const lay = mediaLayout(file(name), 66);
      expect(lay.seconds, name).toBeLessThanOrEqual(2);
      expect(lay.census, name).toBeGreaterThan(399.9);
      expect(lay.census, name).toBeLessThan(400.2);
    }
  });

  it('red: what cannot be counted is said so, and gets no count: a WebM whose media ends before its last parts, an MP4 whose edit list plays its sound three times', () => {
    for (const [name, why] of [['lies-webm-tail.webm', 'its file holds more after the end of its media'], ['lies-mp4-edits.mp4', 'its edit list plays parts of its sound more than once']] as const) {
      const lay = mediaLayout(file(name), 66);
      expect(lay.census, name).toBeUndefined();
      expect(lay.censusWhy, name).toBe(why);
    }
  });

  it('the codec\'s own configuration sets the rate and channels: AAC at twice its core (a decoder may switch SBR on), Opus in its head\'s channels, Vorbis in its header\'s', () => {
    expect(mediaLayout(file('speech-long-aac48.mp4'), 66).audio).toEqual([{ codec: 'mp4a', rate: 96000, channels: 2 }]);
    expect(mediaLayout(file('speech-plain-vorbis.webm'), 66).audio).toEqual([{ codec: 'A_VORBIS', rate: 44100, channels: 2 }]);
    expect(mediaLayout(file('speech-plain-opus.mp4'), 66).audio).toEqual([{ codec: 'Opus', rate: 48000, channels: 1 }]);
    // Red: the container says one channel, the Opus head six (the decoder makes six).
    const six = W.file({ priv: W.opusHead(6), channels: 1, clusters: [W.cluster(W.block([W.opus(1)]))] });
    expect(mediaLayout(six, 66).audio).toEqual([{ codec: 'A_OPUS', rate: 48000, channels: 6 }]);
    // 6 channels at 48 kHz: 29 s fit the limit, not the 174 s one channel would.
    expect(decodeSeconds(mediaLayout(six, 66).audio, MEDIA_FILES_LIMITS.maxPcmBytes)).toBe(29);
  });

  it('an Opus packet counts what its own first byte says: 20 ms, 60 ms, three frames of 20 ms; laced frames each by their own first byte', () => {
    const at = (blocks: Uint8Array[]) => mediaLayout(W.file({ priv: W.opusHead(1), clusters: [W.cluster(...blocks)] }), 66).census!;
    expect(at([W.block([W.opus(1)])])).toBeCloseTo(0.02, 6);
    expect(at([W.block([W.opus(3)])])).toBeCloseTo(0.06, 6);
    expect(at([W.block([W.opus(1, 3, 3)])])).toBeCloseTo(0.06, 6);
    // Code 3 with 48 frames of 20 ms says 960 ms: a packet decodes to 120 ms at most.
    expect(at([W.block([W.opus(1, 3, 48)])])).toBeCloseTo(0.12, 6);
    const frames = [W.opus(1, 0, 1, 300), W.opus(3, 0, 1, 40), W.opus(1, 1, 1, 41)];
    expect(at([W.block(frames, 'xiph')])).toBeCloseTo(0.02 + 0.06 + 0.04, 6);
    expect(at([W.block(frames.map((f) => f.subarray(0, 40)), 'fixed')])).toBeCloseTo(0.02 + 0.06 + 0.04, 6);
    expect(at([W.block([W.opus(1, 0, 1, 40), W.opus(3, 0, 1, 42), W.opus(1, 1, 1, 41)], 'ebml')])).toBeCloseTo(0.02 + 0.06 + 0.04, 6);
    // Lacing whose sizes do not fit the block: every frame at the longest a packet decodes to.
    const broken = W.block(frames, 'xiph');
    broken[broken.length - 1 - frames.reduce((a, f) => a + f.length, 0) + 1] = 0xff;
    expect(at([broken])).toBeGreaterThanOrEqual(0.12);
    // A block of another track is not sound.
    expect(at([W.block([W.opus(1)]), W.block([W.opus(3)], 'none', 2)])).toBeCloseTo(0.02, 6);
  });

  it('red: a file whose packets hold more than its length gives is counted by its packets: 2,000 packets of 20 ms under a length of 1 s', () => {
    const blocks = Array.from({ length: 2000 }, () => W.block([W.opus(1, 0, 1, 3)]));
    const lay = mediaLayout(W.file({ priv: W.opusHead(1), duration: 1, clusters: [W.cluster(...blocks.slice(0, 1000)), W.cluster(...blocks.slice(1000))] }), 66);
    expect(lay.seconds).toBe(1);
    expect(lay.census).toBeCloseTo(40, 6);
  });

  it('what a decoder may read and this walk would not is uncountable: a part of unknown size, bytes after the media, a part that runs past its holder, sound stored compressed, MP3 or FLAC', () => {
    const one = W.cluster(W.block([W.opus(1)]));
    const why = (bytes: Uint8Array) => mediaLayout(bytes, 66).censusWhy;
    expect(why(W.file({ priv: W.opusHead(1), clusters: [W.open(0x1f43b675, W.el(0xe7, W.uint(0)), W.block([W.opus(1)]))] }))).toBe('its parts have no set size (a recording that was never closed)');
    expect(why(W.file({ priv: W.opusHead(1), clusters: [one], after: W.cluster(W.block([W.opus(1)])) }))).toBe('its file holds more after the end of its media');
    // A block that claims 126 bytes inside a part that holds 10.
    const inner = W.cat([W.el(0x1f43b675, W.el(0xe7, W.uint(0)), W.cat([new Uint8Array([0xa3, 0xfe]), new Uint8Array(10)]))]);
    expect(why(W.file({ priv: W.opusHead(1), clusters: [inner, one] }))).toBe('one of its parts runs past the part that holds it');
    expect(why(W.file({ priv: W.opusHead(1), clusters: [one], encodings: true }))).toBe('its sound is stored compressed or encrypted inside the file');
    expect(why(W.file({ codec: 'A_FLAC', clusters: [one] }))).toBe('a FLAC packet may hold any length of sound');
    expect(why(W.file({ codec: 'A_MPEG/L3', clusters: [one] }))).toBe('an MP3 packet may hold many frames of sound');
    expect(why(W.file({ codec: 'A_AAC', clusters: [one] }))).toBe('its AAC configuration could not be read');
    expect(why(W.file({ codec: 'A_VORBIS', clusters: [one] }))).toBe('its Vorbis set-up could not be read');
    // Look-alike: the same file, honest, is counted.
    expect(mediaLayout(W.file({ priv: W.opusHead(1), clusters: [one, one] }), 66).census).toBeCloseTo(0.04, 6);
  });

  it('the cut file is counted again (what the decoder is handed): an index-last MP4 cut at 60 s holds its first 60 s and the index copied after it', () => {
    const whole = file('speech-long-mp4.mp4');
    const lay = mediaLayout(whole, 60);
    const again = mediaLayout(mediaCut(whole, lay.cut!), 66);
    // The copied index lists every sample: those that now point into the copied index itself are counted too.
    expect(again.census).toBeGreaterThanOrEqual(lay.cut!.seconds);
    expect(again.census).toBeLessThan(lay.cut!.seconds * 1.1 + 5);
    const webm = file('speech-long-six.webm');
    const six = mediaLayout(webm, 20);
    expect(mediaLayout(mediaCut(webm, six.cut!), 66).census).toBeCloseTo(six.cut!.seconds, 1);
  });

  it('sound stored in long pieces (a still picture at one frame a second): the cut is made before the piece the cut falls in', () => {
    const still = file('speech-still-aac48.mp4');
    const lay = mediaLayout(still, 37);
    expect(lay.cut!.seconds).toBeLessThan(37);
    expect(lay.cut!.seconds).toBeGreaterThanOrEqual(MEDIA_FILES_LIMITS.minSeconds);
    expect(mediaLayout(mediaCut(still, lay.cut!), 66).census).toBeCloseTo(lay.cut!.seconds, 1);
    // Look-alike: the same sound with 25 frames a second is stored in short pieces and cut where asked.
    expect(mediaLayout(file('speech-long-aac48.mp4'), 37).cut!.seconds).toBeCloseTo(37, 0);
  });

  it('the census needs no outer name either (its source is sent into the page as it is)', () => {
    const lay = new Function(`return (${mediaLayout.toString()})`)() as typeof mediaLayout;
    for (const name of ['lies-webm-length.webm', 'lies-mp4-fragments.mp4', 'speech-plain-vorbis.webm', 'speech-plain-opus.mp4']) expect(lay(file(name), 66), name).toEqual(mediaLayout(file(name), 66));
  });
});

// ---- The cut round (review media-v, S4 and S5) ---------------------------------------------------------
/** The boxes of an MP4 on a path of types ('moov/trak'), each [start of its data, end]; the sound track's when `sound`. */
function mp4Box(bytes: Uint8Array, path: string, sound = false): { data: number; end: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kids = (from: number, to: number): { type: string; data: number; end: number }[] => {
    const out: { type: string; data: number; end: number }[] = [];
    for (let o = from; o + 8 <= to;) {
      const size = dv.getUint32(o) || to - o;
      out.push({ type: String.fromCharCode(...bytes.subarray(o + 4, o + 8)), data: o + 8, end: o + size });
      o += size;
    }
    return out;
  };
  let list = kids(0, bytes.length);
  let at: { data: number; end: number } | undefined;
  for (const type of path.split('/')) {
    const all = list.filter((b) => b.type === type);
    at = type === 'trak' && sound ? all.find((t) => {
      const mdia = kids(t.data, t.end).find((b) => b.type === 'mdia')!;
      const hdlr = kids(mdia.data, mdia.end).find((b) => b.type === 'hdlr')!;
      return String.fromCharCode(...bytes.subarray(hdlr.data + 8, hdlr.data + 12)) === 'soun';
    }) : all[0];
    if (!at) throw new Error(`no ${type} in ${path}`);
    list = kids(at.data, at.end);
  }
  return at!;
}

describe('the cut round, S5: one description of the sound, the one the test sizes', () => {
  it('red: an MP4 whose sound has two descriptions, or whose samples name another description than the first, cannot be counted (it is not decoded)', () => {
    const two = file('layout-first.mp4');
    const stsd = mp4Box(two, 'moov/trak/mdia/minf/stbl/stsd', true);
    new DataView(two.buffer, two.byteOffset).setUint32(stsd.data + 4, 2);
    expect(mediaLayout(two, 66)).toMatchObject({ censusWhy: 'it has more than one description of its sound' });
    expect(mediaLayout(two, 66).census).toBeUndefined();
    const other = file('layout-first.mp4');
    const stsc = mp4Box(other, 'moov/trak/mdia/minf/stbl/stsc', true);
    new DataView(other.buffer, other.byteOffset).setUint32(stsc.data + 8 + 8, 2);
    expect(mediaLayout(other, 66)).toMatchObject({ censusWhy: 'its samples may use another description of its sound than the one the test reads' });
    const frag = file('layout-fragments.mp4');
    const trex = mp4Box(frag, 'moov/mvex/trex');
    const dv = new DataView(frag.buffer, frag.byteOffset);
    // The trex of the sound track (track 2 in this file): its default description.
    const trexes = [trex];
    for (let o = trex.end; o + 8 <= mp4Box(frag, 'moov/mvex').end; o += dv.getUint32(o)) trexes.push({ data: o + 8, end: o + dv.getUint32(o) });
    for (const t of trexes) dv.setUint32(t.data + 8, 2);
    expect(mediaLayout(frag, 66)).toMatchObject({ censusWhy: 'its samples may use another description of its sound than the one the test reads' });
  });

  it('look-alike: the same files untouched are counted', () => {
    expect(mediaLayout(file('layout-first.mp4'), 66).census).toBeCloseTo(14.07, 1);
    expect(mediaLayout(file('layout-fragments.mp4'), 66).census).toBeCloseTo(14.07, 1);
  });
});

describe('the cut round, S4: the size of the picture a file declares', () => {
  it('WebM and MP4 give the size of their picture; a file with no picture track gives none', () => {
    expect(mediaLayout(file('speech-tall.webm'), 66)).toMatchObject({ width: 480, height: 2000 });
    expect(mediaLayout(file('speech-portrait.webm'), 66)).toMatchObject({ width: 1080, height: 1920 });
    expect(mediaLayout(file('speech-long-aac48.mp4'), 66)).toMatchObject({ width: 160, height: 90 });
    expect(mediaLayout(file('speech-plain-opus.mp4'), 66)).toMatchObject({ width: 640, height: 360 });
    expect(mediaLayout(file('speech.wav'), 66).width).toBeUndefined();
  });
});

// ---- The second check of the cut round (review media-cut, S3 and S4) --------------------------------------
/** The picture track's box on a path (as `mp4Box`, for the track whose handler is 'vide'). */
function videoBox(bytes: Uint8Array, path: string): { data: number; end: number } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const kids = (from: number, to: number) => {
    const out: { type: string; data: number; end: number }[] = [];
    for (let o = from; o + 8 <= to;) { const size = dv.getUint32(o) || to - o; out.push({ type: String.fromCharCode(...bytes.subarray(o + 4, o + 8)), data: o + 8, end: o + size }); o += size; }
    return out;
  };
  const moov = kids(0, bytes.length).find((b) => b.type === 'moov')!;
  const trak = kids(moov.data, moov.end).filter((b) => b.type === 'trak').find((t) => {
    const mdia = kids(t.data, t.end).find((b) => b.type === 'mdia')!;
    const hdlr = kids(mdia.data, mdia.end).find((b) => b.type === 'hdlr')!;
    return String.fromCharCode(...bytes.subarray(hdlr.data + 8, hdlr.data + 12)) === 'vide';
  })!;
  let at = trak;
  for (const type of path.split('/')) at = kids(at.data, at.end).find((b) => b.type === type)!;
  return at;
}
/** `bytes` with `extra` put at the end of the box whose data ends at `end`, and the sizes of the boxes holding it grown. */
function grow(bytes: Uint8Array, holders: { start: number }[], end: number, extra: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length + extra.length);
  out.set(bytes.subarray(0, end));
  out.set(extra, end);
  out.set(bytes.subarray(end), end + extra.length);
  const dv = new DataView(out.buffer);
  for (const h of holders) dv.setUint32(h.start, dv.getUint32(h.start) + extra.length);
  return out;
}

describe('the second check of the cut round, S3: one description of the picture, the one the test sizes', () => {
  it('red: an MP4 whose picture has two descriptions, or whose picture samples name another one: its picture size cannot be trusted (no frame is read)', () => {
    const two = file('layout-first.mp4');
    new DataView(two.buffer, two.byteOffset).setUint32(videoBox(two, 'mdia/minf/stbl/stsd').data + 4, 2);
    expect(mediaLayout(two, 66).pictureWhy).toBe('it has more than one description of its picture');
    const other = file('layout-first.mp4');
    new DataView(other.buffer, other.byteOffset).setUint32(videoBox(other, 'mdia/minf/stbl/stsc').data + 8 + 8, 2);
    expect(mediaLayout(other, 66).pictureWhy).toBe('its picture may use another description than the one the test reads');
    // In fragments: the picture track's default description is another one.
    const frag = file('layout-fragments.mp4');
    const dv = new DataView(frag.buffer, frag.byteOffset);
    const mvex = mp4Box(frag, 'moov/mvex');
    const videoId = dv.getUint32(videoBox(frag, 'tkhd').data + 12);
    for (let o = mvex.data; o + 8 <= mvex.end; o += dv.getUint32(o)) if (dv.getUint32(o + 12) === videoId) dv.setUint32(o + 16, 2);
    expect(mediaLayout(frag, 66).pictureWhy).toBe('its picture may use another description than the one the test reads');
    // The sound is still counted (its own descriptions are one).
    expect(mediaLayout(frag, 66).census).toBeCloseTo(14.07, 1);
  });

  it('look-alike: the same files untouched give a picture size the test can trust', () => {
    for (const name of ['layout-first.mp4', 'layout-fragments.mp4', 'speech-long-aac48.mp4']) expect(mediaLayout(file(name), 66).pictureWhy, name).toBeUndefined();
  });
});

describe('the second check of the cut round, S4: the metadata is read once, within bounds', () => {
  it('red: an MP4 with more sound tracks than the test counts (17), or more track defaults than it reads (4,097), is not counted', () => {
    const last = file('layout-last.mp4');
    const moov = mp4Box(last, 'moov');
    const trak = mp4Box(last, 'moov/trak', true);
    const copy = last.slice(trak.data - 8, trak.end);
    const many = new Uint8Array(copy.length * 16);
    for (let i = 0; i < 16; i++) many.set(copy, i * copy.length);
    const seventeen = grow(last, [{ start: moov.data - 8 }], moov.end, many);
    expect(mediaLayout(seventeen, 66)).toMatchObject({ censusWhy: 'it has more sound tracks than the test counts' });
    const frag = file('layout-fragments.mp4');
    const mvex = mp4Box(frag, 'moov/mvex');
    const trex = new Uint8Array(32);
    const t = new DataView(trex.buffer);
    t.setUint32(0, 32); trex.set([0x74, 0x72, 0x65, 0x78], 4); t.setUint32(12, 99); t.setUint32(16, 1);
    const extra = new Uint8Array(32 * 4097);
    for (let i = 0; i < 4097; i++) extra.set(trex, i * 32);
    const crowded = grow(frag, [{ start: mp4Box(frag, 'moov').data - 8 }, { start: mvex.data - 8 }], mvex.end, extra);
    const t0 = performance.now();
    expect(mediaLayout(crowded, 66)).toMatchObject({ censusWhy: 'it has more track defaults than the test reads' });
    expect(performance.now() - t0).toBeLessThan(500);
  });

  it('look-alike: two sound tracks are counted, the larger one\'s sound', () => {
    const last = file('layout-last.mp4');
    const moov = mp4Box(last, 'moov');
    const trak = mp4Box(last, 'moov/trak', true);
    const two = grow(last, [{ start: moov.data - 8 }], moov.end, last.slice(trak.data - 8, trak.end));
    expect(mediaLayout(two, 66).census).toBeCloseTo(14.07, 1);
  });
});
