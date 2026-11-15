// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The sound measurements behind the media-files test (src/media/sound.ts): speech is "found" only when every
// sign of speech holds. Fixtures: test/fixtures/media/files/*.wav (scripts/media-fixtures.mjs: synthetic speech
// in English and Spanish, a plucked tune over a bass note with noise bursts, two chimes) and signals made here.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { soundFeatures, soundSilent, speechFound, speechMissing, SOUND_RATE, SPEECH_SIGNS } from '../../src/media/sound.js';

/** The samples of a 16 kHz mono 16-bit WAV file. */
function wav(name: string): Float32Array {
  const b = readFileSync(fileURLToPath(new URL(`../fixtures/media/files/${name}`, import.meta.url)));
  const at = b.indexOf('data', 12, 'latin1') + 8;
  const n = Math.floor((b.length - at) / 2);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = b.readInt16LE(at + i * 2) / 32768;
  return out;
}

const make = (seconds: number, at: (t: number, i: number) => number): Float32Array => {
  const out = new Float32Array(Math.round(seconds * SOUND_RATE));
  for (let i = 0; i < out.length; i++) out[i] = at(i / SOUND_RATE, i);
  return out;
};
/** A small repeatable noise source. */
const noise = (() => {
  let s = 12345;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x40000000 - 1;
  };
})();

describe('speech found only when every sign of speech holds', () => {
  it('synthetic speech in English and in Spanish is found', () => {
    for (const name of ['speech.wav', 'speech-es.wav']) {
      const f = soundFeatures(wav(name));
      expect(speechMissing(f), name).toEqual([]);
      expect(speechFound(f)).toBe(true);
      expect(soundSilent(f)).toBe(false);
      expect(f.voicedSeconds).toBeGreaterThan(2);
      // Moments of speech to sample frames at: inside the sound, in order, at most 12.
      expect(f.moments.length).toBeGreaterThanOrEqual(6);
      expect(f.moments.length).toBeLessThanOrEqual(12);
      expect([...f.moments].sort((a, b) => a - b)).toEqual(f.moments);
      expect(Math.max(...f.moments)).toBeLessThan(f.seconds);
    }
  });

  it('look-alikes that are sound and not speech: a tune, chimes', () => {
    for (const name of ['tune.wav', 'chime.wav']) {
      const f = soundFeatures(wav(name));
      expect(soundSilent(f), name).toBe(false);
      expect(speechFound(f), name).toBe(false);
      expect(speechMissing(f).length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it('look-alikes made here: a steady tone, a tone with vibrato at a talker\'s pace, hiss, a siren, clicks on a beat', () => {
    const cases: Record<string, Float32Array> = {
      tone: make(5, (t) => 0.4 * Math.sin(2 * Math.PI * 220 * t)),
      // A voice-range tone switched on and off four times a second, its pitch wobbling: syllable-paced, but no hiss and no vowels.
      wobble: make(6, (t) => (Math.sin(2 * Math.PI * 4 * t) > 0 ? 0.4 * Math.sin(2 * Math.PI * (180 + 12 * Math.sin(2 * Math.PI * 5 * t)) * t) : 0)),
      hiss: make(5, () => 0.2 * noise()),
      siren: make(6, (t) => 0.4 * Math.sin(2 * Math.PI * (300 + 150 * Math.sin(2 * Math.PI * 0.5 * t)) * t)),
      beat: make(6, (t) => (t % 0.5 < 0.05 ? 0.5 * noise() : 0.2 * Math.sin(2 * Math.PI * 110 * t))),
    };
    for (const [name, samples] of Object.entries(cases)) {
      const f = soundFeatures(samples);
      expect(speechFound(f), `${name}: ${JSON.stringify(speechMissing(f))}`).toBe(false);
      expect(soundSilent(f), name).toBe(false);
    }
  });

  // Fix round 1, S5: the shape speech has in time.
  it('red: speech played backwards is not speech: it meets the first fifteen signs and none of the four that the direction of time decides', () => {
    for (const name of ['speech.wav', 'speech-es.wav']) {
      const forward = soundFeatures(wav(name));
      const backward = soundFeatures(wav(name).reverse());
      expect(speechMissing(backward).sort(), name).toEqual(['diesAway', 'earlyWeight', 'phrasesFall', 'stretchesFall']);
      expect(speechFound(backward), name).toBe(false);
      // The same sound turned round gives the same measurements with the other sign.
      expect(backward.fadeDb, name).toBeLessThan(0);
      expect(forward.fadeDb, name).toBeGreaterThan(SPEECH_SIGNS.diesAway!.min!);
      expect(backward.weightAt, name).toBeGreaterThan(0.5);
      expect(forward.weightAt, name).toBeLessThan(SPEECH_SIGNS.earlyWeight!.max!);
      expect(backward.stretchFall, name).toBeLessThan(0);
      expect(backward.phraseFall, name).toBeLessThan(0);
      expect(forward.phrases, name).toBeGreaterThanOrEqual(1);
    }
  });

  it('look-alike: the same speech played forwards meets all nineteen signs', () => {
    expect(Object.keys(SPEECH_SIGNS)).toHaveLength(19);
    for (const name of ['speech.wav', 'speech-es.wav']) expect(speechMissing(soundFeatures(wav(name))), name).toEqual([]);
  });

  it('a voice without words made here (one vowel on a tune, a hum that swells) is not speech', () => {
    const TUNE = [196, 220, 247, 262, 247, 220, 196, 175, 196, 220];
    const cases: Record<string, Float32Array> = {
      // "Ah" on ten notes: a buzz at the note's pitch through two fixed resonances, each note held.
      vowel: make(6, (t) => { const f = TUNE[Math.floor(t / 0.6) % TUNE.length]!; const env = Math.min(1, (t % 0.6) / 0.05) * Math.min(1, (0.6 - (t % 0.6)) / 0.08); let s = 0; for (let k = 1; k <= 12; k++) s += Math.sin(2 * Math.PI * f * k * t) / (1 + Math.abs(f * k - 730) / 200 + Math.abs(f * k - 1090) / 400); return 0.25 * env * s; }),
      // A hum: one low pitch that swells and fades once a second.
      hum: make(6, (t) => 0.3 * Math.sin(Math.PI * (t % 1)) * (Math.sin(2 * Math.PI * 140 * t) + 0.3 * Math.sin(2 * Math.PI * 280 * t))),
    };
    for (const [name, samples] of Object.entries(cases)) {
      const f = soundFeatures(samples);
      expect(speechFound(f), `${name}: ${JSON.stringify(speechMissing(f))}`).toBe(false);
      expect(speechMissing(f).length, name).toBeGreaterThanOrEqual(3);
    }
  });

  it('silence and near-silence are silent, never speech', () => {
    const quiet = soundFeatures(make(4, () => 0.0005 * noise()));
    expect(soundSilent(soundFeatures(new Float32Array(4 * SOUND_RATE)))).toBe(true);
    expect(soundSilent(quiet)).toBe(true);
    expect(speechFound(quiet)).toBe(false);
    expect(soundFeatures(new Float32Array(10))).toMatchObject({ audibleSeconds: 0, moments: [] });
  });

  it('speech too short to judge is not found (two seconds of sound that can be heard are needed)', () => {
    const f = soundFeatures(wav('speech.wav').slice(Math.round(0.3 * SOUND_RATE), Math.round(1.6 * SOUND_RATE)));
    expect(speechMissing(f)).toContain('heard');
  });

  it('only the first 60 seconds are measured', () => {
    const s = wav('speech.wav');
    const long = new Float32Array(70 * SOUND_RATE);
    for (let i = 0; i < long.length; i++) long[i] = s[i % s.length]!;
    expect(soundFeatures(long).seconds).toBe(60);
  });

  it('every sign names a measurement and at least one bound', () => {
    const f = soundFeatures(wav('speech.wav'));
    for (const [id, s] of Object.entries(SPEECH_SIGNS)) {
      expect(typeof f[s.of], id).toBe('number');
      expect(s.min !== undefined || s.max !== undefined, id).toBe(true);
    }
  });

  it('soundFeatures uses no outer names (its source is sent into the page as it is)', () => {
    const again = new Function(`return (${soundFeatures.toString()})`)() as typeof soundFeatures;
    expect(again(wav('chime.wav'))).toEqual(soundFeatures(wav('chime.wav')));
  });
});
