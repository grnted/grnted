// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What a media file's sound track holds, measured from its decoded samples: how much of it can be heard, and
// whether it holds speech. Pure arithmetic on 16 kHz mono samples (the media-files probe decodes them in the
// page and runs `soundFeatures` there): no AI, no model, nothing read from a file name or the page. The speech
// verdict (`speechFound`) is strict on purpose: it says "speech" only when every sign of speech is there
// together (a voice's pitch, moving in small steps; short voiced stretches at a talker's pace, uneven like talk
// and not on a beat, swelling rather than struck; hissing consonants between them; vowels that differ; and the
// shape speech has in time: stretches that die away, pitch that comes down through a stretch and through a
// phrase, which the same sound played backwards does not have). Music, tones, chimes, noise, a voice without
// words and anything it is unsure of are "no speech found", which decides nothing: a video is never failed for
// sound this cannot show to be speech. Engine core: no imports.

/** Samples per second of the input. */
export const SOUND_RATE = 16000;
/** Most sound analysed (seconds): the first part of a longer file. */
export const SOUND_MAX_SECONDS = 60;

/** What was measured. Times in seconds, levels in dB relative to full scale. */
export interface SoundFeatures {
  /** Seconds analysed. */
  seconds: number;
  /** The loudest 10 ms frame. */
  peakDb: number;
  /** Seconds that can be heard (frames within 40 dB of the loudest and above -55 dB). */
  audibleSeconds: number;
  /** Seconds of voiced sound (a steady pitch between 70 and 400 Hz). */
  voicedSeconds: number;
  /** Voiced share of what can be heard. */
  voicedShare: number;
  /** Voiced stretches (syllable-like), and how many start per audible second. */
  runs: number;
  runRate: number;
  /** The middle and the 90th-percentile length of a voiced stretch (ms). */
  runMedianMs: number;
  runP90Ms: number;
  /** The middle pitch of the voiced frames (Hz), and the spread between its 10th and 90th percentiles (semitones). */
  pitchHz: number;
  pitchSpread: number;
  /** How much the pitch moves inside a voiced stretch: the middle absolute change per 10 ms (semitones). */
  pitchGlide: number;
  /** Share of voiced stretches whose pitch ends within a quarter of a semitone of where it began (a held note). */
  heldShare: number;
  /** Share of audible frames that are unvoiced hiss (most energy above 3 kHz): consonants such as s, f, sh, t. */
  hissShare: number;
  /** How unevenly voiced stretches start: the spread of the gaps between starts over their mean. */
  onsetSpread: number;
  /** How well the starts of voiced stretches fit a steady beat, 0 (not at all) to 1 (exactly). */
  beatFit: number;
  /** How much the voiced frames differ in where their energy sits (dB across five bands): different vowels. */
  vowelSpread: number;
  /** Share of voiced stretches (60 ms or longer) that are loudest in their first quarter: struck or plucked notes. */
  attackShare: number;
  /** The middle pitch step (semitones) from the end of one voiced stretch to the start of the next, a quarter second apart or less. */
  stepMedian: number;
  /**
   * How much louder voiced stretches (60 ms or longer) are in their first half than in their second (dB, the
   * middle one): a spoken syllable is driven at its start and dies away. Played backwards the same sound gives
   * the same number with the other sign.
   */
  fadeDb: number;
  /** Where the energy of those stretches sits, from 0 (their start) to 1 (their end), the middle one. */
  weightAt: number;
  /** How far the pitch comes down inside a voiced stretch, from its first third to its last (semitones, the middle one). */
  stretchFall: number;
  /**
   * How far the pitch comes down through a phrase (four voiced stretches or more with no quarter-second gap), from
   * its first half to its second (semitones, the middle one); 0 when the sound has no such phrase.
   */
  phraseFall: number;
  /** Phrases `phraseFall` is measured on. */
  phrases: number;
  /** Moments (seconds) inside voiced stretches, spread over the sound, at most 12: where a caption would be on screen. */
  moments: number[];
}

/**
 * The measurements of a sound track's first 60 s (16 kHz mono samples between -1 and 1). Self-contained (no
 * outer names): the media-files probe sends this function's source into the page.
 */
export function soundFeatures(samples: Float32Array): SoundFeatures {
  const RATE = 16000;
  const HOP = 160; // 10 ms
  const WIN = 512; // 32 ms
  // Lags searched for a voice's pitch: 400 Hz down to 70 Hz.
  const LAG_MIN = Math.floor(RATE / 400);
  const LAG_MAX = Math.ceil(RATE / 70);
  const percentile = (sorted: readonly number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(p * (sorted.length - 1))))]! : 0);
  const semitones = (a: number, b: number): number => 12 * Math.log2(a / b);
  const round = (n: number, d = 3) => Math.round(n * 10 ** d) / 10 ** d;
  /** In-place radix-2 FFT of `n` (a power of two) complex values. */
  const fft = (re: Float32Array, im: Float32Array, n: number): void => {
    for (let i = 1, j = 0; i < n; i++) {
      let bit = n >> 1;
      for (; j & bit; bit >>= 1) j ^= bit;
      j ^= bit;
      if (i < j) {
        const tr = re[i]!; re[i] = re[j]!; re[j] = tr;
        const ti = im[i]!; im[i] = im[j]!; im[j] = ti;
      }
    }
    for (let len = 2; len <= n; len <<= 1) {
      const ang = (-2 * Math.PI) / len;
      const wr = Math.cos(ang);
      const wi = Math.sin(ang);
      for (let i = 0; i < n; i += len) {
        let cr = 1;
        let ci = 0;
        for (let k = 0; k < len / 2; k++) {
          const a = i + k;
          const b = a + len / 2;
          const xr = re[b]! * cr - im[b]! * ci;
          const xi = re[b]! * ci + im[b]! * cr;
          re[b] = re[a]! - xr; im[b] = im[a]! - xi;
          re[a] = re[a]! + xr; im[a] = im[a]! + xi;
          const nr = cr * wr - ci * wi;
          ci = cr * wi + ci * wr;
          cr = nr;
        }
      }
    }
  };

  const total = Math.min(samples.length, 60 * RATE);
  const frames = total >= WIN ? Math.floor((total - WIN) / HOP) + 1 : 0;
  const empty: SoundFeatures = {
    seconds: round(total / RATE, 2), peakDb: -120, audibleSeconds: 0, voicedSeconds: 0, voicedShare: 0, runs: 0, runRate: 0, runMedianMs: 0, runP90Ms: 0,
    pitchHz: 0, pitchSpread: 0, pitchGlide: 0, heldShare: 0, hissShare: 0, onsetSpread: 0, beatFit: 0, vowelSpread: 0, attackShare: 0, stepMedian: 0,
    fadeDb: 0, weightAt: 0.5, stretchFall: 0, phraseFall: 0, phrases: 0, moments: [],
  };
  if (!frames) return empty;
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (WIN - 1));
  const db = new Float32Array(frames);
  const pitch = new Float32Array(frames); // Hz, 0 = unvoiced
  const hiss = new Uint8Array(frames);
  const bands = new Float32Array(frames * 5);
  const re = new Float32Array(WIN);
  const im = new Float32Array(WIN);
  const corr = new Float32Array(LAG_MAX + 2);
  // Band edges in FFT bins (31.25 Hz each): 200-500, 500-1000, 1000-2000, 2000-3000, 3000-4000 Hz.
  const EDGE = [6, 16, 32, 64, 96, 128];
  const HIGH = 96; // 3 kHz
  let peak = -120;
  for (let f = 0; f < frames; f++) {
    const at = f * HOP;
    let sum = 0;
    for (let i = 0; i < WIN; i++) sum += samples[at + i]! * samples[at + i]!;
    const level = sum > 0 ? 10 * Math.log10(sum / WIN) : -120;
    db[f] = level;
    if (level > peak) peak = level;
  }
  const floor = Math.max(peak - 40, -55);
  let audible = 0;
  for (let f = 0; f < frames; f++) {
    if (db[f]! < floor) continue;
    audible++;
    const at = f * HOP;
    // Pitch: the normalised autocorrelation's best lag between 70 and 400 Hz; the shortest lag nearly as good wins
    // (so a voice is not read an octave low).
    let best = 0;
    let bestLag = 0;
    const span = WIN - LAG_MAX;
    let e0 = 0;
    for (let i = 0; i < span; i++) e0 += samples[at + i]! * samples[at + i]!;
    for (let lag = LAG_MIN; lag <= LAG_MAX; lag++) {
      let c = 0;
      let e1 = 0;
      for (let i = 0; i < span; i++) {
        const b = samples[at + i + lag]!;
        c += samples[at + i]! * b;
        e1 += b * b;
      }
      const r = e0 > 0 && e1 > 0 ? c / Math.sqrt(e0 * e1) : 0;
      corr[lag] = r;
      if (r > best) { best = r; bestLag = lag; }
    }
    if (best >= 0.62) {
      for (let lag = LAG_MIN + 1; lag < bestLag; lag++) {
        if (corr[lag]! >= 0.92 * best && corr[lag]! >= corr[lag - 1]! && corr[lag]! >= corr[lag + 1]!) { bestLag = lag; break; }
      }
      // Parabolic refinement of the lag.
      const a = bestLag > LAG_MIN ? corr[bestLag - 1]! : 0;
      const b = corr[bestLag]!;
      const c = bestLag < LAG_MAX ? corr[bestLag + 1]! : 0;
      const d = a - 2 * b + c;
      const shift = d < 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / d)) : 0;
      pitch[f] = RATE / (bestLag + shift);
    }
    // Spectrum: where the energy sits.
    for (let i = 0; i < WIN; i++) { re[i] = samples[at + i]! * hann[i]!; im[i] = 0; }
    fft(re, im, WIN);
    let all = 0;
    let high = 0;
    for (let k = 2; k < WIN / 2; k++) {
      const p = re[k]! * re[k]! + im[k]! * im[k]!;
      all += p;
      if (k >= HIGH) high += p;
    }
    for (let b = 0; b < 5; b++) {
      let p = 0;
      for (let k = EDGE[b]!; k < EDGE[b + 1]!; k++) p += re[k]! * re[k]! + im[k]! * im[k]!;
      bands[f * 5 + b] = 10 * Math.log10(p / Math.max(all, 1e-12) + 1e-6);
    }
    if (!pitch[f] && all > 0 && high / all > 0.5) hiss[f] = 1;
  }
  // Voiced stretches: runs of voiced frames (a one-frame dropout is bridged), 30 ms or longer.
  const runs: { start: number; end: number }[] = [];
  for (let f = 0; f < frames; f++) {
    if (!pitch[f]) continue;
    let end = f;
    while (end + 1 < frames && (pitch[end + 1]! > 0 || (end + 2 < frames && pitch[end + 2]! > 0))) end++;
    if (end - f + 1 >= 3) runs.push({ start: f, end });
    f = end;
  }
  let voiced = 0;
  let hissing = 0;
  const pitches: number[] = [];
  const glides: number[] = [];
  const lengths: number[] = [];
  const steps: number[] = [];
  let held = 0;
  let attacks = 0;
  let long = 0;
  let lastEnd = -1000;
  let lastPitch = 0;
  // The shape in time (what the same sound played backwards turns round): per stretch, how much louder its first
  // half is, where its energy sits, how far its pitch comes down; per stretch, its middle pitch, for the phrases.
  const fades: number[] = [];
  const weights: number[] = [];
  const falls: number[] = [];
  const runPitch: number[] = [];
  const middle = (list: number[]): number => percentile([...list].sort((a, b) => a - b), 0.5);
  for (const r of runs) {
    const n = r.end - r.start + 1;
    lengths.push(n * 10);
    if (n >= 6) {
      long++;
      let top = r.start;
      let head = 0;
      let headN = 0;
      let tail = 0;
      let tailN = 0;
      let power = 0;
      let moment = 0;
      for (let f = r.start; f <= r.end; f++) {
        if (db[f]! > db[top]!) top = f;
        if (f - r.start < n / 2) { head += db[f]!; headN++; } else { tail += db[f]!; tailN++; }
        const p = 10 ** (db[f]! / 10);
        power += p;
        moment += p * (f - r.start);
      }
      if (top - r.start < n / 4) attacks++;
      if (headN && tailN) fades.push(head / headN - tail / tailN);
      if (power > 0) weights.push(moment / power / (n - 1));
    }
    let first = 0;
    let last = 0;
    let prev = 0;
    const own: number[] = [];
    for (let f = r.start; f <= r.end; f++) {
      const p = pitch[f]!;
      if (!p) continue;
      voiced++;
      pitches.push(p);
      own.push(p);
      if (!first) first = p;
      // An octave jump between frames is a tracking slip, not a glide.
      if (prev) { const step = Math.abs(semitones(p, prev)); if (step < 6) glides.push(step); }
      prev = p;
      last = p;
    }
    runPitch.push(own.length ? middle(own) : 0);
    if (n >= 6 && own.length >= 6) {
      const third = Math.max(2, Math.floor(own.length / 3));
      falls.push(semitones(middle(own.slice(0, third)), middle(own.slice(-third))));
    }
    if (first && last && Math.abs(semitones(last, first)) < 0.25 && n >= 8) held++;
    if (first && lastPitch && r.start - lastEnd <= 25) steps.push(Math.abs(semitones(first, lastPitch)));
    lastEnd = r.end;
    lastPitch = last;
  }
  for (let f = 0; f < frames; f++) if (hiss[f]) hissing++;
  pitches.sort((a, b) => a - b);
  glides.sort((a, b) => a - b);
  lengths.sort((a, b) => a - b);
  steps.sort((a, b) => a - b);
  // Starts of voiced stretches: how uneven, and how well they sit on a steady beat (a period of 80 to 700 ms).
  const starts = runs.map((r) => r.start * 10);
  const gaps: number[] = [];
  for (let i = 1; i < starts.length; i++) gaps.push(starts[i]! - starts[i - 1]!);
  let onsetSpread = 0;
  let beatFit = 0;
  if (gaps.length >= 4) {
    const mean = gaps.reduce((a, g) => a + g, 0) / gaps.length;
    onsetSpread = Math.sqrt(gaps.reduce((a, g) => a + (g - mean) * (g - mean), 0) / gaps.length) / mean;
    for (let period = 80; period <= 700; period += 5) {
      let cs = 0;
      let sn = 0;
      for (const s of starts) { const ph = (2 * Math.PI * s) / period; cs += Math.cos(ph); sn += Math.sin(ph); }
      const fit = Math.sqrt(cs * cs + sn * sn) / starts.length;
      if (fit > beatFit) beatFit = fit;
    }
  }
  // Vowel variety: per band, the spread (standard deviation, dB) of its share over the voiced frames; the mean of the five.
  let vowelSpread = 0;
  if (voiced >= 10) {
    for (let b = 0; b < 5; b++) {
      let s = 0;
      let s2 = 0;
      let n = 0;
      for (let f = 0; f < frames; f++) {
        if (!pitch[f]) continue;
        const v = bands[f * 5 + b]!;
        s += v; s2 += v * v; n++;
      }
      const mean = s / n;
      vowelSpread += Math.sqrt(Math.max(0, s2 / n - mean * mean));
    }
    vowelSpread /= 5;
  }
  // Phrases: four voiced stretches or more with no gap of a quarter second between them. Through a phrase a
  // talker's pitch comes down: the middle pitch of its second half of stretches against its first half.
  const drops: number[] = [];
  for (let i = 0; i < runs.length;) {
    let j = i;
    while (j + 1 < runs.length && runs[j + 1]!.start - runs[j]!.end <= 25) j++;
    if (j - i + 1 >= 4) {
      const half = Math.floor((j - i + 1) / 2);
      const head = middle(runPitch.slice(i, i + half).filter((p) => p > 0));
      const tail = middle(runPitch.slice(j + 1 - half, j + 1).filter((p) => p > 0));
      if (head > 0 && tail > 0) drops.push(semitones(head, tail));
    }
    i = j + 1;
  }
  // Moments inside voiced stretches, spread over the sound: the middles of up to 12 stretches, evenly picked.
  const mids = runs.filter((r) => r.end - r.start + 1 >= 6).map((r) => round(((r.start + r.end) / 2) * 0.01 + 0.016, 2));
  const moments: number[] = [];
  const want = Math.min(12, mids.length);
  for (let i = 0; i < want; i++) moments.push(mids[Math.min(mids.length - 1, Math.floor(((i + 0.5) * mids.length) / want))]!);
  const audibleSeconds = audible / 100;
  return {
    seconds: round(total / RATE, 2),
    peakDb: round(peak, 1),
    audibleSeconds: round(audibleSeconds, 2),
    voicedSeconds: round(voiced / 100, 2),
    voicedShare: audible ? round(voiced / audible) : 0,
    runs: runs.length,
    runRate: audibleSeconds > 0 ? round(runs.length / audibleSeconds, 2) : 0,
    runMedianMs: percentile(lengths, 0.5),
    runP90Ms: percentile(lengths, 0.9),
    pitchHz: round(percentile(pitches, 0.5), 1),
    pitchSpread: pitches.length ? round(semitones(percentile(pitches, 0.9), percentile(pitches, 0.1)), 2) : 0,
    pitchGlide: round(percentile(glides, 0.5)),
    heldShare: runs.length ? round(held / runs.length) : 0,
    hissShare: audible ? round(hissing / audible) : 0,
    onsetSpread: round(onsetSpread),
    beatFit: round(beatFit),
    vowelSpread: round(vowelSpread, 2),
    attackShare: long ? round(attacks / long) : 0,
    stepMedian: round(percentile(steps, 0.5), 2),
    fadeDb: fades.length ? round(middle(fades), 2) : 0,
    weightAt: weights.length ? round(middle(weights)) : 0.5,
    stretchFall: falls.length ? round(middle(falls), 2) : 0,
    phraseFall: drops.length ? round(middle(drops), 2) : 0,
    phrases: drops.length,
    moments: [...new Set(moments)],
  };
}

/** Sound quieter than this at its loudest (dB relative to full scale) cannot be heard at a normal volume. */
export const SILENT_PEAK_DB = -50;

/** True when nothing in the sound can be heard: digital silence, or a level far below any speech or signal. */
export const soundSilent = (f: SoundFeatures): boolean => f.peakDb < SILENT_PEAK_DB || f.audibleSeconds < 0.05;

/**
 * The signs of speech, each a range every one of which must hold (`speechFound`). The first fifteen were set
 * from measurements of 168 recordings of synthetic speech in some 40 voices and 10 languages (154 found) against
 * 1,107 recordings of music (instrument loops alone and mixed in twos to fours, tones, chimes, noise): none of
 * the music met them all. The last four (review round 1, S5) are the shape speech has in time, which the same
 * sound played backwards does not have: a recording of speech played backwards met the first fifteen as often
 * as speech did. They were set and checked on 2,153 recordings of synthetic speech (two synthesisers, some 190
 * voices, 40 languages), each also played backwards: of 1,591 backwards recordings that met the first fifteen
 * signs, none meets these four as well; of 1,517 forwards ones, 926 do (docs/redteam-triage-media.md has the
 * numbers, and scripts/media-heldout.mjs builds the recordings again). Outside any range the sound is not shown
 * to be speech.
 */
export const SPEECH_SIGNS: Readonly<Record<string, { of: keyof SoundFeatures; min?: number; max?: number; what: string }>> = {
  heard: { of: 'audibleSeconds', min: 2, what: 'two seconds or more that can be heard' },
  voiced: { of: 'voicedShare', min: 0.45, max: 0.92, what: 'voiced for about half to nine tenths of that time' },
  pace: { of: 'runRate', min: 1.2, max: 6.2, what: 'voiced stretches at a talker\'s pace' },
  length: { of: 'runMedianMs', min: 60, max: 850, what: 'voiced stretches of syllable length' },
  noLongNotes: { of: 'runP90Ms', max: 1250, what: 'no long held notes' },
  pitch: { of: 'pitchHz', min: 75, max: 320, what: 'a voice\'s pitch' },
  range: { of: 'pitchSpread', min: 2.2, max: 10, what: 'a talker\'s pitch range' },
  glide: { of: 'pitchGlide', min: 0.085, max: 0.6, what: 'pitch that keeps moving' },
  notHeld: { of: 'heldShare', max: 0.32, what: 'few stretches on one held pitch' },
  hiss: { of: 'hissShare', min: 0.03, max: 0.26, what: 'hissing consonants between the voiced stretches' },
  uneven: { of: 'onsetSpread', min: 0.3, what: 'uneven timing' },
  offBeat: { of: 'beatFit', max: 0.87, what: 'no steady beat' },
  vowels: { of: 'vowelSpread', min: 5.5, what: 'vowels that differ' },
  swelling: { of: 'attackShare', max: 0.62, what: 'stretches that swell rather than start loudest' },
  steps: { of: 'stepMedian', max: 4.5, what: 'small pitch steps from one stretch to the next' },
  diesAway: { of: 'fadeDb', min: 1, what: 'voiced stretches that are louder at their start than at their end' },
  earlyWeight: { of: 'weightAt', max: 0.49, what: 'voiced stretches whose energy sits in their first half' },
  stretchesFall: { of: 'stretchFall', min: 0.1, what: 'pitch that comes down inside a voiced stretch' },
  phrasesFall: { of: 'phraseFall', min: 0.2, what: 'pitch that comes down through a phrase' },
};

/** The signs of speech the sound lacks (empty: it is speech). */
export function speechMissing(f: SoundFeatures): string[] {
  return Object.entries(SPEECH_SIGNS).filter(([, s]) => {
    const v = f[s.of] as number;
    return !Number.isFinite(v) || (s.min !== undefined && v < s.min) || (s.max !== undefined && v > s.max);
  }).map(([id]) => id);
}

/** True only when every sign of speech holds. */
export const speechFound = (f: SoundFeatures): boolean => speechMissing(f).length === 0;
