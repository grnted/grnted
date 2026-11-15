// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The `<meta name="viewport">` reader (src/probes/metaViewport.ts) against the behaviour it must keep
// (docs/process/cleanroom/viewport-behaviour.md): separators, numeric prefixes and keyword values. WCAG 1.4.4: the zoom
// test must read the setting as the browser does, never as a comma-and-semicolon split.
import { describe, expect, it } from 'vitest';
import { axeFailsViewport, numericPrefix, pageZoomVerdict, parseViewport, viewportPairs, zoomVerdict } from '../../src/probes/metaViewport.js';

const kind = (content: string) => zoomVerdict(parseViewport(content)).kind;

describe('viewport content: Chromium’s separators', () => {
  it('splits on space, tab, newline, "=" and ","; a ";" is not a separator and stays in the value', () => {
    expect(viewportPairs('width=device-width, initial-scale=1').pairs).toEqual([['width', 'device-width'], ['initial-scale', '1']]);
    expect(viewportPairs('width=device-width,maximum-scale=5;user-scalable=false')).toEqual({ pairs: [['width', 'device-width'], ['maximum-scale', '5;user-scalable'], ['false', '']], invalidSeparator: true });
    expect(viewportPairs('WIDTH = Device-Width\n\tuser-scalable = NO').pairs).toEqual([['width', 'device-width'], ['user-scalable', 'no']]);
    expect(viewportPairs('').pairs).toEqual([]);
  });

  it('reads a key without a value as an empty value; the search for "=" stops at a "," but runs over words after a space', () => {
    expect(viewportPairs('user-scalable, maximum-scale=1').pairs).toEqual([['user-scalable', ''], ['maximum-scale', '1']]);
    // "no" is passed over while looking for the "=": user-scalable gets an empty value, which reads as 0 (zoom off).
    expect(viewportPairs('user-scalable no').pairs).toEqual([['user-scalable', '']]);
    expect(viewportPairs('user-scalable no, width=320').pairs).toEqual([['user-scalable', ''], ['width', '320']]);
  });
});

describe('viewport content: numbers and keywords', () => {
  it('takes the numeric prefix of a value', () => {
    expect([numericPrefix('5;user-scalable'), numericPrefix('1.0x'), numericPrefix('.5'), numericPrefix('+2'), numericPrefix('-1'), numericPrefix('1e1'), numericPrefix('none')]).toEqual([5, 1, 0.5, 2, -1, 10, null]);
  });

  it('maximum-scale: yes is 1, no and unknown words are 0.1 or less, device-width is 10, a negative number is auto, numbers clamp to 0.1 to 10', () => {
    expect(parseViewport('maximum-scale=yes').maxZoom).toBe(1);
    expect(parseViewport('maximum-scale=no').maxZoom).toBe(0);
    expect(parseViewport('maximum-scale=none').maxZoom).toBe(0.1);
    expect(parseViewport('maximum-scale=device-width').maxZoom).toBe(10);
    expect(parseViewport('maximum-scale=-1').maxZoom).toBe('auto');
    expect(parseViewport('maximum-scale=25').maxZoom).toBe(10);
    expect(parseViewport('maximum-scale=0.05').maxZoom).toBe(0.1);
  });

  it('user-scalable: yes and device-width allow zoom; no, unknown words and numbers under 1 in size do not', () => {
    expect(['yes', 'device-width', 'device-height', '1', '-1', '5x'].map((v) => parseViewport(`user-scalable=${v}`).userZoom)).toEqual([true, true, true, true, true, true]);
    expect(['no', 'false', '0', '0.5', '-0.5', ''].map((v) => parseViewport(`user-scalable=${v}`).userZoom)).toEqual([false, false, false, false, false, false]);
  });
});

describe('zoom verdict (WCAG 1.4.4)', () => {
  it('allows zoom for "maximum-scale=5;user-scalable=false": the browser reads maximum-scale 5 and never sets user-scalable', () => {
    expect(parseViewport('width=device-width, maximum-scale=5;user-scalable=false')).toMatchObject({ userZoom: true, maxZoom: 5, invalidSeparator: true });
    expect(kind('width=device-width, maximum-scale=5;user-scalable=false')).toBe('allowed');
    expect(kind('width=device-width, maximum-scale=5;user-scalable=no')).toBe('allowed');
  });

  it('turns zoom off for user-scalable=false or no, and for a maximum-scale under 2 however it is written', () => {
    expect(zoomVerdict(parseViewport('width=device-width, user-scalable=false'))).toMatchObject({ kind: 'off', property: 'user-scalable', value: 'false' });
    expect(zoomVerdict(parseViewport('user-scalable=no'))).toMatchObject({ kind: 'off', property: 'user-scalable' });
    expect(zoomVerdict(parseViewport('width=device-width; maximum-scale=none'))).toMatchObject({ kind: 'off', property: 'maximum-scale', value: 'none' });
    expect(['maximum-scale=1', 'maximum-scale=yes', 'maximum-scale=1.9', 'maximum-scale=1;x'].map(kind)).toEqual(['off', 'off', 'off', 'off']);
  });

  it('allows zoom with no setting, a maximum-scale of 2 or more, a negative maximum-scale (ignored) and the last of two user-scalable values', () => {
    expect(['', 'width=device-width, initial-scale=1', 'maximum-scale=2', 'maximum-scale=device-width', 'maximum-scale=-3', 'user-scalable=no, user-scalable=yes'].map(kind)).toEqual(['allowed', 'allowed', 'allowed', 'allowed', 'allowed', 'allowed']);
  });

  it('does not decide what it cannot be sure of: a value like "infinity", a minimum above the maximum, and viewport settings that disagree', () => {
    expect(kind('maximum-scale=infinity')).toBe('unknown');
    expect(kind('minimum-scale=3, maximum-scale=1')).toBe('unknown');
    expect(pageZoomVerdict(['user-scalable=no', 'width=device-width']).kind).toBe('unknown');
    expect(pageZoomVerdict(['user-scalable=no', 'maximum-scale=1']).kind).toBe('off');
    expect(pageZoomVerdict([]).kind).toBe('allowed');
  });
});

describe('the axe rule meta-viewport, mirrored so nothing is reported twice', () => {
  it('fails user-scalable=no, a small user-scalable number and a maximum-scale under 2; not words it does not read', () => {
    expect(['user-scalable=no', 'user-scalable=0', 'maximum-scale=1', 'maximum-scale=yes', 'width=device-width; user-scalable=no'].map(axeFailsViewport)).toEqual([true, true, true, true, true]);
    expect(['user-scalable=false', 'maximum-scale=none', 'maximum-scale=5', 'width=device-width', ''].map(axeFailsViewport)).toEqual([false, false, false, false, false]);
  });
});
