// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a media file says about itself before anything is decoded: its container (MP4 or WebM), the sound
// tracks it declares (codec, sample rate, channels), its length, and where its first seconds of sound end in
// the file. The media-files probe reads this from the bytes it fetched (bounded) so it can tell, BEFORE it asks
// the browser to decode anything, how much memory the decoded sound will take, and hand the decoder only the
// first stretch of a long file (review round 1, S7: no decode without a bound). Pure byte reading: no decoding,
// no AI. Anything this cannot read is "unknown", which the probe never decodes. Engine core: no imports.
//
// Two figures are never taken on the file's word alone (fix round 1, second builder): the rate and channels are
// read from the codec's own configuration where the decoder reads them (an Opus head, a Vorbis identification
// header, an AAC configuration, in WebM as in MP4), and the length of the sound is counted from the sound's own
// packets (`census`): a decoder makes sound of every packet it is handed, whatever times the file gives them, so
// a file whose times or length say less than its packets hold is caught before anything is decoded.

/** One sound track as the file declares it. */
export interface DeclaredSound {
  /** The codec's name in the file ("mp4a", "Opus", "A_OPUS", "A_VORBIS", ...). */
  codec: string;
  /**
   * The most the decoder can produce for it, per second: samples per second and channels, the larger of what the
   * container says and what the codec's own configuration says. For AAC the figures allow for the extensions a
   * decoder switches on by itself (twice the rate at 24 kHz or less, two channels for one); 0 when the codec is not
   * one this reads.
   */
  rate: number;
  channels: number;
}

/** How to make a file that holds only the first seconds of sound: the first `end` bytes, one size field changed, and a block copied after them. */
export interface MediaCut {
  /** Bytes kept from the start of the file. */
  end: number;
  /** A size field to rewrite (big-endian, 4 or 8 bytes) so the file's sample data ends at `end`. */
  patch?: { at: number; bytes: 4 | 8; value: number };
  /** The file's index, copied after the kept bytes when it sits at the end of the file. */
  append?: { from: number; to: number };
  /** Seconds of sound the kept bytes hold, at most, by the times the file gives (the probe counts the cut file's packets again: `MediaLayout.census`). */
  seconds: number;
}

export interface MediaLayout {
  container: 'mp4' | 'webm' | 'unknown';
  /** The sound tracks it declares (empty: none). */
  audio: DeclaredSound[];
  /** It declares a picture track. */
  video: boolean;
  /**
   * The largest picture it declares (pixels; undefined when it gives none): WebM PixelWidth and PixelHeight, MP4
   * a picture track's own size and its sample description's. The probe reads no frame of a picture larger than
   * its budget (review media-v, S4); the browser's own reading of the picture size is checked again before any frame.
   */
  width?: number;
  height?: number;
  /**
   * Why the picture's size cannot be trusted (review media-cut, S3): more than one description of the picture, or
   * samples or fragments that name another than the first. The probe then reads no frame of it.
   */
  pictureWhy?: string;
  /** The length it declares (seconds; 0 when it gives none). */
  seconds: number;
  /** The cut that holds the first `cutSeconds` of sound, when the file's sound runs longer than that. */
  cut?: MediaCut;
  /** Why no cut could be made although the sound may run longer. */
  cutWhy?: string;
  /** Why the layout could not be read at all (then nothing else here is to be trusted). */
  why?: string;
  /**
   * The most seconds of sound a decoder can make of these bytes, counted from their packets, whatever times or
   * length the file gives: for each sound track, every packet the bytes hold at the longest its codec decodes one
   * packet to (Opus: what the packet's own first byte says, 120 ms at most, and 120 ms for each packet in MP4
   * fragments; AAC: 1,024 samples of its core; Vorbis: half its long block), the largest track's. Undefined, with
   * `censusWhy`, when the packets cannot all be counted (a part of unknown size, bytes after the media, a walk
   * that does not reach the end of the file, an edit list that plays parts again, sound stored compressed) or the
   * codec's packets cannot be sized (MP3, FLAC, any other): the probe then decodes nothing.
   */
  census?: number;
  censusWhy?: string;
}

/**
 * The layout of a media file (`bytes`: the whole file), and the cut that holds its first `cutSeconds` of
 * sound. Self-contained (no outer names): the media-files probe sends this function's source into the page.
 */
export function mediaLayout(bytes: Uint8Array, cutSeconds: number): MediaLayout {
  const n = bytes.length;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u8 = (o: number): number => (o >= 0 && o < n ? bytes[o]! : 0);
  const u16 = (o: number): number => (o >= 0 && o + 2 <= n ? dv.getUint16(o) : 0);
  const u32 = (o: number): number => (o >= 0 && o + 4 <= n ? dv.getUint32(o) : 0);
  const u64 = (o: number): number => u32(o) * 4294967296 + u32(o + 4);
  const text = (o: number, len: number): string => {
    let s = '';
    for (let i = 0; i < len && o + i < n; i++) s += String.fromCharCode(bytes[o + i]!);
    return s;
  };
  const out: MediaLayout = { container: 'unknown', audio: [], video: false, seconds: 0 };
  const fail = (why: string): MediaLayout => ({ container: out.container, audio: [], video: out.video, seconds: out.seconds, why });
  if (n < 16) return fail('the file is too short to be a video');
  /**
   * An AAC configuration (AudioSpecificConfig, `len` bytes at `p`) as an AAC decoder reads it: the rate of its core
   * (a packet is 1,024 samples of it, or 960), and the most rate and channels the decoder may give. The rate is at
   * least twice the core's, whatever the configuration names: a decoder switches SBR on by itself when it finds
   * it in the sound, and with SBR on it makes 2,048 samples of every packet (at an SBR rate the configuration
   * names, which may be anything above the core's); counted at twice the core's rate, a packet's 1,024 / core
   * seconds are those 2,048 samples. Two channels for one (PS); the channels of a program configuration are
   * counted. Null for a kind of AAC whose packets are not 1,024 samples of the core (low delay, USAC, ...) or a
   * configuration that cannot be read.
   */
  const aacConfig = (p: number, len: number, entryRate: number, entryChannels: number): { core: number; rate: number; channels: number } | null => {
    if (len < 2 || p < 0 || p + len > n) return null;
    let bit = p * 8;
    const stop = (p + len) * 8;
    const bits = (count: number): number => {
      let v = 0;
      for (let i = 0; i < count; i++, bit++) v = v * 2 + ((u8(bit >> 3) >> (7 - (bit & 7))) & 1);
      return v;
    };
    const RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
    const freq = (): number => { const i = bits(4); return i === 15 ? bits(24) : RATES[i] ?? 0; };
    const objectType = (): number => { const t = bits(5); return t === 31 ? 32 + bits(6) : t; };
    const aot = objectType();
    const core = freq();
    const config = bits(4);
    let named = 0;
    let base = aot;
    if (aot === 5 || aot === 29) { named = freq(); base = objectType(); }
    // Main, LC and LTP, with SBR or PS on top: packets of 1,024 (or 960) samples of the core.
    if (![1, 2, 4].includes(base) || ![1, 2, 4, 5, 29].includes(aot)) return null;
    let ch = config >= 1 && config <= 6 ? config : config === 7 ? 8 : 0;
    if (config === 0) {
      // Its own program configuration, after the GASpecificConfig: the channels its elements carry.
      bits(1);
      if (bits(1)) bits(14);
      bits(1);
      bits(10);
      const groups = bits(4) + bits(4) + bits(4);
      const lfe = bits(2);
      bits(7);
      if (bits(1)) bits(4);
      if (bits(1)) bits(4);
      if (bits(1)) bits(3);
      for (let i = 0; i < groups; i++) { ch += bits(1) ? 2 : 1; bits(4); }
      ch += lfe;
    }
    if (!(core > 0) || !(ch > 0) || bit > stop) return null;
    return { core, rate: Math.max(named, entryRate, 2 * core), channels: Math.max(2, ch, entryChannels) };
  };
  /**
   * The longest an Opus packet (its first bytes at `p`, `len` bytes) decodes to, in samples at 48 kHz: what its
   * first byte says (the frame's length and how many frames), 120 ms at most; 120 ms when it cannot be read.
   */
  const opusSamples = (p: number, len: number): number => {
    if (len < 1) return 5760;
    const toc = u8(p);
    const config = toc >> 3;
    const frame = config < 12 ? [480, 960, 1920, 2880][config & 3]! : config < 16 ? [480, 960][config & 1]! : [120, 240, 480, 960][config & 3]!;
    const code = toc & 3;
    const count = code === 0 ? 1 : code < 3 ? 2 : len < 2 ? 48 : Math.max(1, u8(p + 1) & 0x3f);
    return Math.min(5760, frame * count);
  };

  // ---- WebM / Matroska -------------------------------------------------------------------------------
  if (u32(0) === 0x1a45dfa3) {
    out.container = 'webm';
    /** An element id at `o` (its marker bits kept), and its length in bytes; length 0 when it is not one. */
    const idAt = (o: number): { id: number; len: number } => {
      const b = u8(o);
      const len = b & 0x80 ? 1 : b & 0x40 ? 2 : b & 0x20 ? 3 : b & 0x10 ? 4 : 0;
      if (!len || o + len > n) return { id: 0, len: 0 };
      let id = 0;
      for (let i = 0; i < len; i++) id = id * 256 + bytes[o + i]!;
      return { id, len };
    };
    /** A size at `o`: its value (-1: unknown size) and its length in bytes; length 0 when it is not one. */
    const sizeAt = (o: number): { size: number; len: number } => {
      const b = u8(o);
      let len = 0;
      for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) { len = i + 1; break; }
      if (!len || o + len > n) return { size: 0, len: 0 };
      let size = b & (0xff >> len);
      let ones = size === (0xff >> len);
      for (let i = 1; i < len; i++) { const c = bytes[o + i]!; size = size * 256 + c; if (c !== 0xff) ones = false; }
      return { size: ones ? -1 : size, len };
    };
    const uint = (o: number, len: number): number => {
      let v = 0;
      for (let i = 0; i < len && i < 8; i++) v = v * 256 + u8(o + i);
      return v;
    };
    const float = (o: number, len: number): number => (len === 4 && o + 4 <= n ? dv.getFloat32(o) : len === 8 && o + 8 <= n ? dv.getFloat64(o) : 0);
    /** The children of an element whose data is [from, to): id, where its data starts and ends, where it starts. */
    const children = (from: number, to: number, each: (id: number, data: number, end: number, start: number, unknown: boolean) => boolean | void): void => {
      let o = from;
      for (let guard = 0; o < to && guard < 200_000; guard++) {
        const id = idAt(o);
        if (!id.len) return;
        const size = sizeAt(o + id.len);
        if (!size.len) return;
        const data = o + id.len + size.len;
        const unknown = size.size < 0;
        const end = unknown ? to : Math.min(to, data + size.size);
        if (each(id.id, data, end, o, unknown) === false || unknown) return;
        o = data + size.size;
      }
    };
    /**
     * The identification header of a Vorbis track (the first of the three headers its CodecPrivate holds, laced):
     * its rate, channels and long block. Null when it cannot be read.
     */
    const vorbisHead = (p: number, end: number): { rate: number; channels: number; block: number } | null => {
      if (p < 0 || end - p < 3 || u8(p) !== 2) return null;
      let q = p + 1;
      let first = 0;
      let b = 0;
      do { b = u8(q++); first += b; } while (b === 255 && q < end);
      do { b = u8(q++); } while (b === 255 && q < end);
      if (first < 30 || q + first > end || u8(q) !== 1 || text(q + 1, 6) !== 'vorbis') return null;
      const channels = u8(q + 11);
      const rate = u8(q + 12) + u8(q + 13) * 256 + u8(q + 14) * 65536 + u8(q + 15) * 16777216;
      const short = 1 << (u8(q + 28) & 15);
      const long = 1 << (u8(q + 28) >> 4);
      if (!channels || !(rate > 0) || short < 64 || long < short || long > 8192) return null;
      return { rate, channels, block: long };
    };
    const head = idAt(0);
    const headSize = sizeAt(head.len);
    if (!headSize.len || headSize.size < 0) return fail('its header could not be read');
    const seg = head.len + headSize.len + headSize.size;
    const segId = idAt(seg);
    if (segId.id !== 0x18538067) return fail('its header is not followed by the media');
    const segSize = sizeAt(seg + segId.len);
    if (!segSize.len) return fail('its media could not be read');
    const segData = seg + segId.len + segSize.len;
    const segEnd = segSize.size < 0 ? n : Math.min(n, segData + segSize.size);
    let scale = 1_000_000; // nanoseconds per timecode unit
    let duration = 0;
    const clusters: { start: number; time: number }[] = [];
    let openEnded = '';
    /** Each sound track: its number, and the longest one of its packets (`len` bytes at `p`) decodes to, in seconds; or why its packets cannot be sized. */
    const counted: { number: number; packet?: (p: number, len: number) => number; why?: string }[] = [];
    children(segData, segEnd, (id, data, end, start, unknown) => {
      if (id === 0x1549a966) { // Info
        children(data, end, (cid, cdata, cend) => {
          if (cid === 0x2ad7b1) scale = uint(cdata, cend - cdata) || scale;
          else if (cid === 0x4489) duration = float(cdata, cend - cdata);
        });
      } else if (id === 0x1654ae6b) { // Tracks
        children(data, end, (tid, tdata, tend) => {
          if (tid !== 0xae) return;
          let type = 0;
          let number = -1;
          let codec = '';
          let rate = 8000;
          let outRate = 0;
          let channels = 1;
          let priv = -1;
          let privEnd = -1;
          let encoded = false;
          let pixels = [0, 0];
          children(tdata, tend, (eid, edata, eend) => {
            if (eid === 0x83) type = uint(edata, eend - edata);
            else if (eid === 0xd7) number = uint(edata, eend - edata);
            else if (eid === 0x86) codec = text(edata, Math.min(32, eend - edata)).replace(/\0+$/, '');
            else if (eid === 0x63a2) { priv = edata; privEnd = eend; }
            else if (eid === 0x6d80) encoded = true;
            else if (eid === 0xe0) {
              children(edata, eend, (vid, vdata, vend) => {
                if (vid === 0xb0 || vid === 0x54b0) pixels = [Math.max(pixels[0]!, uint(vdata, vend - vdata)), pixels[1]!];
                else if (vid === 0xba || vid === 0x54ba) pixels = [pixels[0]!, Math.max(pixels[1]!, uint(vdata, vend - vdata))];
              });
            } else if (eid === 0xe1) {
              children(edata, eend, (aid, adata, aend) => {
                if (aid === 0xb5) rate = float(adata, aend - adata) || rate;
                else if (aid === 0x78b5) outRate = float(adata, aend - adata);
                else if (aid === 0x9f) channels = uint(adata, aend - adata) || channels;
              });
            }
          });
          if (type === 1) {
            out.video = true;
            if (pixels[0]! > 0) out.width = Math.max(out.width ?? 0, pixels[0]!);
            if (pixels[1]! > 0) out.height = Math.max(out.height ?? 0, pixels[1]!);
          }
          if (type !== 2) return;
          const declared = Math.round(Math.max(rate, outRate));
          const sound: DeclaredSound = { codec, rate: 0, channels: 0 };
          const track: (typeof counted)[number] = { number };
          if (codec === 'A_OPUS') {
            // Opus decodes at 48 kHz, in the channels of its own head (the container's figure may say fewer).
            const opusHead = priv >= 0 && privEnd - priv >= 19 && text(priv, 8) === 'OpusHead' ? u8(priv + 9) : 0;
            sound.rate = 48000;
            sound.channels = Math.max(opusHead || 2, channels);
            track.packet = (p, len) => opusSamples(p, len) / 48000;
          } else if (codec === 'A_VORBIS') {
            const vorbis = vorbisHead(priv, privEnd);
            sound.rate = Math.max(vorbis?.rate ?? 0, declared);
            sound.channels = Math.max(vorbis?.channels ?? 0, channels);
            if (vorbis) { const most = vorbis.block / 2 / vorbis.rate; track.packet = () => most; } else track.why = 'its Vorbis set-up could not be read';
          } else if (codec.indexOf('A_AAC') === 0) {
            const aac = priv >= 0 ? aacConfig(priv, privEnd - priv, declared, channels) : null;
            if (aac) {
              sound.rate = aac.rate;
              sound.channels = aac.channels;
              const most = 1024 / aac.core;
              track.packet = () => most;
            } else {
              sound.rate = 2 * declared;
              sound.channels = Math.max(2, channels);
              track.why = 'its AAC configuration could not be read';
            }
          } else if (codec === 'A_FLAC' || codec === 'A_MPEG/L3') {
            sound.rate = declared;
            sound.channels = channels;
            track.why = codec === 'A_FLAC' ? 'a FLAC packet may hold any length of sound' : 'an MP3 packet may hold many frames of sound';
          } else track.why = `its sound's codec (${codec || 'unnamed'}) is not one the test reads`;
          if (encoded) track.why = 'its sound is stored compressed or encrypted inside the file';
          if (number < 0) track.why = 'one of its sound tracks has no number';
          out.audio.push(sound);
          counted.push(track);
        });
      } else if (id === 0x1f43b675) { // Cluster
        if (unknown) { openEnded = 'its parts have no set size (a recording that was never closed)'; return false; }
        let time = -1;
        children(data, end, (cid, cdata, cend) => {
          if (cid === 0xe7) { time = uint(cdata, cend - cdata); return false; }
          return undefined;
        });
        if (time < 0) { openEnded = 'one of its parts gives no time'; return false; }
        clusters.push({ start, time: (time * scale) / 1e9 });
      }
      return undefined;
    });
    out.seconds = duration > 0 ? (duration * scale) / 1e9 : 0;
    if (!out.audio.length && !out.video) return fail('it declares no tracks');
    const first = clusters.find((c) => c.time >= cutSeconds);
    const last = clusters.length ? clusters[clusters.length - 1]!.time : 0;
    if (first && first.start > segData) out.cut = { end: first.start, seconds: first.time };
    else if (openEnded) out.cutWhy = openEnded;
    else if (!clusters.length) out.cutWhy = 'its parts could not be read';
    // Its sound may run past the last part's start by that part's own length: with no later part to cut at, the
    // declared length says whether a cut was needed (the probe compares).
    else if (last >= cutSeconds) out.cutWhy = 'it has no part that starts at the cut';

    // The census: every packet of every sound track, in a walk of the media that must read it to its end (a
    // decoder that meets what it cannot read searches on for more parts; this walk does not, so it refuses).
    if (!out.audio.length) return out;
    const unsized = counted.find((t) => t.why);
    if (unsized) { out.censusWhy = unsized.why; return out; }
    if (segSize.size >= 0 && segData + segSize.size < n) { out.censusWhy = 'its file holds more after the end of its media'; return out; }
    const seconds = new Map<number, number>(counted.map((t) => [t.number, 0]));
    let packets = 0;
    let why = '';
    /** The elements in [from, to), each whole; the last may run past `to` only at the end of the file. */
    const walk = (from: number, to: number, each: (id: number, data: number, end: number) => boolean): boolean => {
      let o = from;
      while (o < to) {
        const id = idAt(o);
        const size = id.len ? sizeAt(o + id.len) : { size: 0, len: 0 };
        if (!id.len || !size.len) { why = 'part of its media could not be read'; return false; }
        if (size.size < 0) { why = 'its parts have no set size (a recording that was never closed)'; return false; }
        const data = o + id.len + size.len;
        const end = data + size.size;
        if (end > to && to < n) { why = 'one of its parts runs past the part that holds it'; return false; }
        if (!each(id.id, data, Math.min(end, to))) return false;
        o = end;
      }
      return true;
    };
    /** One block (a SimpleBlock or a BlockGroup's Block, [p, end)): its frames, each a packet the decoder is handed. */
    const block = (p: number, end: number): boolean => {
      if (++packets > 4_000_000) { why = 'it holds more packets than the test counts'; return false; }
      const num = sizeAt(p);
      if (!num.len || num.size < 0) { why = 'one of its packets names no track'; return false; }
      const track = counted.find((t) => t.number === num.size);
      if (!track) return true;
      let q = p + num.len + 3;
      if (q > end) return true;
      const lacing = (u8(p + num.len + 2) >> 1) & 3;
      let add = 0;
      if (!lacing) add = track.packet!(q, end - q);
      else {
        // Several frames in the block (laced): each is a packet.
        const count = u8(q++) + 1;
        const sizes: number[] = [];
        let ok = true;
        if (lacing === 1) {
          for (let i = 0; i < count - 1; i++) {
            let s = 0;
            let b = 0;
            do { b = u8(q++); s += b; } while (b === 255 && q < end);
            sizes.push(s);
          }
        } else if (lacing === 3) {
          const f = sizeAt(q);
          if (!f.len || f.size < 0) ok = false;
          else {
            q += f.len;
            let s = f.size;
            sizes.push(s);
            for (let i = 1; i < count - 1 && ok; i++) {
              const d = sizeAt(q);
              if (!d.len || d.size < 0) { ok = false; break; }
              q += d.len;
              s += d.size - (2 ** (7 * d.len - 1) - 1);
              sizes.push(s);
            }
          }
        } else {
          const each = (end - q) / count;
          if (!Number.isInteger(each)) ok = false;
          else for (let i = 0; i < count - 1; i++) sizes.push(each);
        }
        const used = sizes.reduce((a, b) => a + b, 0);
        if (!ok || q > end || used > end - q || sizes.some((s) => s < 0)) {
          // Frames whose bounds cannot be read: each at the longest a packet of the codec decodes to.
          add = count * track.packet!(q, 0);
        } else {
          let at = q;
          for (const s of sizes) { add += track.packet!(at, s); at += s; }
          add += track.packet!(at, end - at);
        }
      }
      seconds.set(track.number, seconds.get(track.number)! + add);
      return true;
    };
    const read = walk(segData, segEnd, (id, data, end) => id !== 0x1f43b675 || walk(data, end, (cid, cdata, cend) => (
      cid === 0xa3 ? block(cdata, cend) : cid === 0xa0 ? walk(cdata, cend, (gid, gdata, gend) => gid !== 0xa1 || block(gdata, gend)) : true
    )));
    if (read) out.census = Math.max(...seconds.values());
    else out.censusWhy = why;
    return out;
  }

  // ---- MP4 / QuickTime -------------------------------------------------------------------------------
  interface Box { type: string; start: number; data: number; end: number }
  const boxes = (from: number, to: number): Box[] => {
    const list: Box[] = [];
    let o = from;
    for (let guard = 0; o + 8 <= to && guard < 200_000; guard++) {
      let size = u32(o);
      let head = 8;
      if (size === 1) { if (o + 16 > to) break; size = u64(o + 8); head = 16; } else if (size === 0) size = to - o;
      if (size < head || o + size > to) break;
      list.push({ type: text(o + 4, 4), start: o, data: o + head, end: o + size });
      o += size;
    }
    return list;
  };
  const kind = text(4, 4);
  if (!/^(ftyp|styp|moov|mdat|free|skip|wide|pnot)$/.test(kind)) return fail('it is not an MP4 or WebM file');
  out.container = 'mp4';
  const tops = boxes(0, n);
  const moov = tops.find((b) => b.type === 'moov');
  if (!moov) return fail('its index (moov) is missing or cut off');
  const inMoov = boxes(moov.data, moov.end);
  const child = (list: Box[], type: string): Box | undefined => list.find((b) => b.type === type);
  /** timescale and duration of an mvhd or mdhd box. */
  const header = (b: Box | undefined): { scale: number; length: number } => {
    if (!b) return { scale: 0, length: 0 };
    return u8(b.data) === 1 ? { scale: u32(b.data + 20), length: u64(b.data + 24) } : { scale: u32(b.data + 12), length: u32(b.data + 16) };
  };
  const movie = header(child(inMoov, 'mvhd'));
  out.seconds = movie.scale ? movie.length / movie.scale : 0;
  const mvex = child(inMoov, 'mvex');
  const fragmented = !!mvex || tops.some((b) => b.type === 'moof');
  interface Track {
    id: number; scale: number; stts?: Box; stsc?: Box; stco?: Box; co64?: Box; stsz?: Box;
    /** Edits that play part of the sound (an edit list's entries that are not empty). */
    edits: number;
    /** Descriptions of the sound its stsd box holds (the census reads only the first: review media-v, S5). */
    descriptions: number;
    /** The longest one of its packets (`len` bytes at `p`) decodes to, in seconds; or why its packets cannot be sized. */
    packet?: (p: number, len: number) => number;
    /** The same for a packet whose bytes are not read (in fragments): the longest any of its packets decodes to. */
    most?: number;
    why?: string;
  }
  const sound: Track[] = [];
  const pictureIds: number[] = [];
  for (const trak of inMoov.filter((b) => b.type === 'trak')) {
    const inTrak = boxes(trak.data, trak.end);
    const tkhd = child(inTrak, 'tkhd');
    const mdia = child(inTrak, 'mdia');
    if (!mdia) continue;
    const inMdia = boxes(mdia.data, mdia.end);
    const hdlr = child(inMdia, 'hdlr');
    const handler = hdlr ? text(hdlr.data + 8, 4) : '';
    if (handler === 'vide') {
      out.video = true;
      // Its size: the track's own (16.16 fixed point) and its first sample description's (a visual entry).
      const sizes: number[][] = [];
      if (tkhd) { const at = tkhd.data + (u8(tkhd.data) === 1 ? 88 : 76); sizes.push([u32(at) >>> 16, u32(at + 4) >>> 16]); }
      const vminf = child(inMdia, 'minf');
      const vstbl = vminf ? child(boxes(vminf.data, vminf.end), 'stbl') : undefined;
      const vstsd = vstbl ? child(boxes(vstbl.data, vstbl.end), 'stsd') : undefined;
      if (vstsd && u32(vstsd.data + 4) >= 1) sizes.push([u16(vstsd.data + 8 + 32), u16(vstsd.data + 8 + 34)]);
      // One description of the picture, the one sized here: another may be of any size (review media-cut, S3).
      if (vstsd && u32(vstsd.data + 4) !== 1) out.pictureWhy = 'it has more than one description of its picture';
      const vstsc = vstbl ? child(boxes(vstbl.data, vstbl.end), 'stsc') : undefined;
      if (vstsc) {
        const runs = Math.min(u32(vstsc.data + 4), Math.floor((vstsc.end - vstsc.data - 8) / 12));
        for (let r = 0; r < runs; r++) if (u32(vstsc.data + 8 + r * 12 + 8) !== 1) { out.pictureWhy = 'its picture may use another description than the one the test reads'; break; }
      }
      if (tkhd) pictureIds.push(u8(tkhd.data) === 1 ? u32(tkhd.data + 20) : u32(tkhd.data + 12));
      for (const [w, h] of sizes) {
        if (w! > 0) out.width = Math.max(out.width ?? 0, w!);
        if (h! > 0) out.height = Math.max(out.height ?? 0, h!);
      }
    }
    if (handler !== 'soun') continue;
    const media = header(child(inMdia, 'mdhd'));
    if (media.scale && media.length / media.scale > out.seconds) out.seconds = media.length / media.scale;
    const minf = child(inMdia, 'minf');
    const stbl = minf ? child(boxes(minf.data, minf.end), 'stbl') : undefined;
    const inStbl = stbl ? boxes(stbl.data, stbl.end) : [];
    const stsd = child(inStbl, 'stsd');
    const declared: DeclaredSound = { codec: '', rate: 0, channels: 0 };
    const track: Track = {
      id: tkhd ? (u8(tkhd.data) === 1 ? u32(tkhd.data + 20) : u32(tkhd.data + 12)) : 0, scale: media.scale,
      stts: child(inStbl, 'stts'), stsc: child(inStbl, 'stsc'), stco: child(inStbl, 'stco'), co64: child(inStbl, 'co64'), stsz: child(inStbl, 'stsz'), edits: 0,
      descriptions: stsd ? u32(stsd.data + 4) : 0,
    };
    // Its edit list: each entry that is not empty plays a stretch of the sound (a decoder may play one twice).
    const edts = child(inTrak, 'edts');
    const elst = edts ? child(boxes(edts.data, edts.end), 'elst') : undefined;
    if (elst) {
      const wide = u8(elst.data) === 1;
      const entries = Math.min(u32(elst.data + 4), Math.floor((elst.end - elst.data - 8) / (wide ? 20 : 12)));
      for (let i = 0; i < entries; i++) {
        const at = elst.data + 8 + i * (wide ? 20 : 12) + (wide ? 8 : 4);
        if (!(u32(at) === 0xffffffff && (!wide || u32(at + 4) === 0xffffffff))) track.edits++;
      }
    }
    if (stsd && u32(stsd.data + 4) >= 1) {
      const e = stsd.data + 8;
      const eEnd = Math.min(stsd.end, e + u32(e));
      declared.codec = text(e + 4, 4);
      const version = u16(e + 16);
      let channels = u16(e + 24);
      let rate = u16(e + 32);
      let kids = e + 36;
      if (version === 1) kids = e + 52;
      else if (version === 2) { rate = Math.round(e + 48 <= n ? dv.getFloat64(e + 40) : 0); channels = u32(e + 48); kids = e + Math.max(72, u32(e + 36)); }
      const inEntry = boxes(kids, eEnd);
      track.why = `its sound's codec (${declared.codec.trim() || 'unnamed'}) is not one the test reads`;
      if (declared.codec === 'mp4a') {
        // The decoder follows the codec's own configuration (esds), not the entry's fields.
        track.why = 'its AAC configuration could not be read';
        const wave = child(inEntry, 'wave');
        const esds = child(inEntry, 'esds') ?? (wave ? child(boxes(wave.data, wave.end), 'esds') : undefined);
        if (esds) {
          let p = esds.data + 4;
          const tag = (): { tag: number; len: number } => {
            const t = u8(p++);
            let len = 0;
            for (let i = 0; i < 4; i++) { const c = u8(p++); len = (len << 7) | (c & 0x7f); if (!(c & 0x80)) break; }
            return { tag: t, len };
          };
          let t = tag();
          if (t.tag === 0x03) {
            const flags = u8(p + 2);
            p += 3;
            if (flags & 0x80) p += 2;
            if (flags & 0x40) p += 1 + u8(p);
            if (flags & 0x20) p += 2;
            t = tag();
          }
          if (t.tag === 0x04) {
            const object = u8(p);
            p += 13;
            // MPEG audio (MP3 and its kin) in an MP4: at most two channels at the rate the entry gives.
            if (object === 0x69 || object === 0x6b) {
              declared.rate = rate;
              declared.channels = Math.max(2, channels);
              track.why = 'an MP3 packet may hold many frames of sound';
            } else if (object === 0x40 || (object >= 0x66 && object <= 0x68)) {
              t = tag();
              const aac = t.tag === 0x05 ? aacConfig(p, t.len, rate, channels) : null;
              if (aac) {
                declared.rate = aac.rate;
                declared.channels = aac.channels;
                const most = 1024 / aac.core;
                track.packet = () => most;
                track.most = most;
                track.why = undefined;
              }
            }
          }
        }
      } else if (declared.codec === 'Opus') {
        const dops = child(inEntry, 'dOps');
        declared.rate = 48000;
        declared.channels = Math.max(channels, dops ? u8(dops.data + 1) : 2);
        track.packet = (p, len) => opusSamples(p, len) / 48000;
        track.most = 0.12;
        track.why = undefined;
      } else if (declared.codec === 'fLaC') {
        const dfla = child(inEntry, 'dfLa');
        const p = dfla ? dfla.data + 8 : 0;
        declared.rate = dfla ? Math.max(rate, (u8(p + 10) << 12) | (u8(p + 11) << 4) | (u8(p + 12) >> 4)) : rate;
        declared.channels = dfla ? Math.max(channels, ((u8(p + 12) >> 1) & 7) + 1) : channels;
        track.why = 'a FLAC packet may hold any length of sound';
      } else if (declared.codec === '.mp3' || declared.codec === 'mp3 ') {
        declared.rate = rate;
        declared.channels = Math.max(2, channels);
        track.why = 'an MP3 packet may hold many frames of sound';
      }
    } else track.why = 'its sound track does not say what it is';
    out.audio.push(declared);
    sound.push(track);
  }
  if (!out.audio.length) return out;

  // The census: every packet of every sound track a decoder can be handed from these bytes. In the index, every
  // sample that starts inside the bytes (an Opus sample by its own first byte); in fragments, every entry of
  // every run of samples, at the longest a packet of the codec decodes to. The file's top-level boxes must cover
  // it to its end: a decoder reads fragments wherever they are, and this does not look past a box it cannot read.
  const census = ((): number | string => {
    const tiled: Box[] = [];
    let o = 0;
    while (o + 8 <= n) {
      let size = u32(o);
      let head = 8;
      if (size === 1) { size = u64(o + 8); head = 16; } else if (size === 0) size = n - o;
      if (size < head) return 'part of its file could not be read';
      tiled.push({ type: text(o + 4, 4), start: o, data: o + head, end: Math.min(n, o + size) });
      o += size;
    }
    if (o < n) return 'part of its file could not be read';
    // Read once for every track (review media-cut, S4: no track reads them again): each track's default description
    // (trex), and each track's fragments (the description they name, the entries of their runs of samples).
    if (sound.length > 16) return 'it has more sound tracks than the test counts';
    const defaults = new Map<number, number>();
    if (mvex) {
      const kids = boxes(mvex.data, mvex.end);
      if (kids.length > 4096) return 'it has more track defaults than the test reads';
      for (const b of kids) if (b.type === 'trex') defaults.set(u32(b.data + 4), u32(b.data + 8));
    }
    const fragments = new Map<number, { entries: number; other: boolean }>();
    let trafs = 0;
    for (const moof of tiled) {
      if (moof.type !== 'moof') continue;
      for (const traf of boxes(moof.data, moof.end)) {
        if (traf.type !== 'traf') continue;
        if (++trafs > 200_000) return 'it has more fragments than the test counts';
        const inTraf = boxes(traf.data, traf.end);
        const tfhd = child(inTraf, 'tfhd');
        if (!tfhd) continue;
        const id = u32(tfhd.data + 4);
        const tf = u32(tfhd.data) & 0xffffff;
        const f = fragments.get(id) ?? { entries: 0, other: false };
        if (tf & 0x02 && u32(tfhd.data + 8 + (tf & 0x01 ? 8 : 0)) !== 1) f.other = true;
        for (const trun of inTraf) if (trun.type === 'trun') f.entries += u32(trun.data + 4);
        fragments.set(id, f);
      }
    }
    for (const id of pictureIds) {
      if ((defaults.get(id) ?? 1) !== 1 || fragments.get(id)?.other) out.pictureWhy = 'its picture may use another description than the one the test reads';
    }
    let most = 0;
    let packets = 0;
    for (const t of sound) {
      if (t.why) return t.why;
      if (t.edits > 1) return 'its edit list plays parts of its sound more than once';
      // One description of the sound, the one sized above: samples or fragments that name another one could be of
      // another codec configuration (more channels, another rate), so they are not counted (review media-v, S5).
      const OTHER = 'its samples may use another description of its sound than the one the test reads';
      if (t.descriptions !== 1) return 'it has more than one description of its sound';
      if ((defaults.get(t.id) ?? 1) !== 1) return OTHER;
      let seconds = 0;
      const offsets = t.co64 ?? t.stco;
      if (offsets && t.stsc && t.stsz) {
        const wide = !!t.co64;
        const chunks = u32(offsets.data + 4);
        const runs = u32(t.stsc.data + 4);
        const fixed = u32(t.stsz.data + 4);
        const sized = u32(t.stsz.data + 8);
        if (offsets.data + 8 + chunks * (wide ? 8 : 4) > offsets.end || t.stsc.data + 8 + runs * 12 > t.stsc.end || (!fixed && t.stsz.data + 12 + sized * 4 > t.stsz.end)) return 'its index of the sound could not be read';
        for (let r = 0; r < runs; r++) {
          const firstChunk = u32(t.stsc.data + 8 + r * 12);
          if (u32(t.stsc.data + 8 + r * 12 + 8) !== 1) return OTHER;
          if (r === 0 ? firstChunk !== 1 : firstChunk <= u32(t.stsc.data + 8 + (r - 1) * 12)) return 'its index of the sound is out of order';
        }
        let run = 0;
        let s = 0;
        for (let c = 0; c < chunks && s < sized; c++) {
          while (run + 1 < runs && u32(t.stsc.data + 8 + (run + 1) * 12) <= c + 1) run++;
          const per = runs ? u32(t.stsc.data + 8 + run * 12 + 4) : 0;
          let at = wide ? u64(offsets.data + 8 + c * 8) : u32(offsets.data + 8 + c * 4);
          // A decoder takes no more samples than the sizes give.
          for (let k = 0; k < per && s < sized; k++, s++) {
            if (++packets > 4_000_000) return 'it holds more packets than the test counts';
            const size = fixed || u32(t.stsz.data + 12 + s * 4);
            if (at < n) seconds += t.packet!(at, Math.min(size, n - at));
            at += size;
          }
        }
      } else if (offsets || t.stsc || t.stsz) return 'its index of the sound is incomplete';
      const frag = fragments.get(t.id);
      if (frag) {
        if (frag.other) return OTHER;
        packets += frag.entries;
        if (packets > 4_000_000) return 'it holds more packets than the test counts';
        seconds += frag.entries * t.most!;
      }
      if (seconds > most) most = seconds;
    }
    return most;
  })();
  if (typeof census === 'number') out.census = census;
  else out.censusWhy = census;

  // The cut: where the sound's first `cutSeconds` end in the file.
  if (fragmented) {
    // Fragments: the first one whose sound starts at or after the cut.
    let end = -1;
    let at = 0;
    let timed = false;
    for (const moof of tops) {
      if (moof.type !== 'moof' || moof.start < moov.end) continue;
      for (const traf of boxes(moof.data, moof.end)) {
        if (traf.type !== 'traf') continue;
        const inTraf = boxes(traf.data, traf.end);
        const tfhd = child(inTraf, 'tfhd');
        const tfdt = child(inTraf, 'tfdt');
        const track = sound.find((s) => tfhd && s.id === u32(tfhd.data + 4));
        if (!track || !tfdt || !track.scale) continue;
        timed = true;
        const time = (u8(tfdt.data) === 1 ? u64(tfdt.data + 4) : u32(tfdt.data + 4)) / track.scale;
        if (time >= cutSeconds && end < 0) { end = moof.start; at = time; }
      }
      if (end >= 0) break;
    }
    if (end >= 0) out.cut = { end, seconds: at };
    else if (!timed) out.cutWhy = 'its fragments give no times for the sound';
    else out.cutWhy = 'it has no fragment that starts at the cut';
    return out;
  }
  let end = Infinity;
  const within: { track: Track; chunkAt: number[]; chunkTime: number[]; total: number }[] = [];
  for (const track of sound) {
    const offsets = track.co64 ?? track.stco;
    if (!track.stts || !track.stsc || !offsets || !track.scale) { out.cutWhy = 'its index of the sound is incomplete'; return out; }
    const wide = !!track.co64;
    const chunks = u32(offsets.data + 4);
    const runs = u32(track.stsc.data + 4);
    const spans = u32(track.stts.data + 4);
    if (chunks > 400_000 || runs > 400_000 || spans > 400_000 || offsets.data + 8 + chunks * (wide ? 8 : 4) > offsets.end) { out.cutWhy = 'its index of the sound could not be read'; return out; }
    const chunkAt: number[] = [];
    const chunkTime: number[] = [];
    let time = 0; // in the track's own units
    let span = 0; // which stts entry
    let spanLeft = spans ? u32(track.stts.data + 8) : 0;
    let run = 0;
    for (let c = 0; c < chunks; c++) {
      while (run + 1 < runs && u32(track.stsc.data + 8 + (run + 1) * 12) <= c + 1) run++;
      let samples = runs ? u32(track.stsc.data + 8 + run * 12 + 4) : 0;
      chunkAt.push(wide ? u64(offsets.data + 8 + c * 8) : u32(offsets.data + 8 + c * 4));
      chunkTime.push(time / track.scale);
      while (samples > 0 && span < spans) {
        const take = Math.min(samples, spanLeft);
        time += take * u32(track.stts.data + 8 + span * 8 + 4);
        samples -= take;
        spanLeft -= take;
        if (!spanLeft) { span++; spanLeft = span < spans ? u32(track.stts.data + 8 + span * 8) : 0; }
      }
    }
    within.push({ track, chunkAt, chunkTime, total: time / track.scale });
    const k = chunkTime.findIndex((t) => t >= cutSeconds);
    if (k >= 0 && chunkAt[k]! < end) end = chunkAt[k]!;
  }
  if (end === Infinity) {
    // No track's sound reaches the cut: nothing to cut (the probe checks the length the browser reads too).
    if (within.some((w) => w.total > cutSeconds + 2)) out.cutWhy = 'its index of the sound gives no place to cut';
    return out;
  }
  // What the kept bytes hold: every chunk of sound that starts before the cut's end, wherever its time is.
  const holdsAt = (cutEnd: number): number => {
    let most = 0;
    for (const w of within) {
      let seconds = 0;
      for (let c = 0; c < w.chunkAt.length; c++) {
        if (w.chunkAt[c]! >= cutEnd) continue;
        const next = c + 1 < w.chunkTime.length ? w.chunkTime[c + 1]! : w.total;
        seconds += next - w.chunkTime[c]!;
      }
      if (seconds > most) most = seconds;
    }
    return most;
  };
  let holds = holdsAt(end);
  if (holds > cutSeconds + 2) {
    // A chunk runs across the cut (sound stored in long pieces, as a still picture over a recording often is):
    // the cut is made before that chunk instead, and holds less (the probe asks for enough to measure).
    let before = Infinity;
    for (const w of within) {
      const k = w.chunkTime.findIndex((t) => t >= cutSeconds);
      const j = (k < 0 ? w.chunkTime.length : k) - 1;
      if (j >= 0 && w.chunkAt[j]! < before) before = w.chunkAt[j]!;
    }
    const kept = before === Infinity ? Infinity : holdsAt(before);
    if (!(kept <= cutSeconds + 2)) { out.cutWhy = 'its sound is not stored in the order it plays'; return out; }
    end = before;
    holds = kept;
  }
  if (moov.end <= end) {
    out.cut = { end, seconds: holds };
    return out;
  }
  // The index sits after the sample data: keep the data up to the cut, say so in the data's size field, and
  // copy the index after it (its offsets are from the start of the file, which has not moved).
  const mdat = tops.find((b) => b.type === 'mdat' && b.data <= end && end <= b.end && b.start < moov.start);
  if (!mdat || moov.start < end) { out.cutWhy = 'its sample data and its index are laid out in a way the test does not cut'; return out; }
  out.cut = {
    end, seconds: holds,
    patch: mdat.data - mdat.start === 16 ? { at: mdat.start + 8, bytes: 8, value: end - mdat.start } : { at: mdat.start, bytes: 4, value: end - mdat.start },
    append: { from: moov.start, to: moov.end },
  };
  return out;
}

/** The file a cut describes (`mediaLayout`): a new array, the input untouched. Self-contained, as `mediaLayout` is. */
export function mediaCut(bytes: Uint8Array, cut: MediaCut): Uint8Array {
  const extra = cut.append ? Math.max(0, cut.append.to - cut.append.from) : 0;
  const end = Math.max(0, Math.min(cut.end, bytes.length));
  const out = new Uint8Array(end + extra);
  out.set(bytes.subarray(0, end));
  if (cut.patch && cut.patch.at + cut.patch.bytes <= end) {
    const dv = new DataView(out.buffer);
    if (cut.patch.bytes === 8) { dv.setUint32(cut.patch.at, Math.floor(cut.patch.value / 4294967296)); dv.setUint32(cut.patch.at + 4, cut.patch.value >>> 0); }
    else dv.setUint32(cut.patch.at, cut.patch.value >>> 0);
  }
  if (cut.append && extra) out.set(bytes.subarray(cut.append.from, cut.append.to), end);
  return out;
}

/**
 * How many seconds of a file's sound fit in `maxPcmBytes` once decoded (4 bytes a sample, at the file's own rate
 * and channels: what a decoder holds before anything is mixed down), for the largest sound track it declares.
 * 0 when the file declares no sound track, or one whose size cannot be told (a codec this does not read).
 * Self-contained, as `mediaLayout` is.
 */
export function decodeSeconds(audio: readonly DeclaredSound[], maxPcmBytes: number): number {
  if (!audio.length || audio.some((a) => !(a.rate > 0) || !(a.channels > 0))) return 0;
  const perSecond = Math.max(...audio.map((a) => a.rate * a.channels * 4));
  return Math.max(0, Math.floor(maxPcmBytes / perSecond));
}
