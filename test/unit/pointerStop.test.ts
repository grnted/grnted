// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// What the request guard stopped during a pointer test that ends it (`pointerStop`): the gesture test
// sets aside a blocked file the page only shows (test-everything A3); nothing else changes.
import { describe, expect, it } from 'vitest';
import { pointerStop } from '../../src/probes/pointerKit.js';
import type { GuardEvent } from '../../src/probes/types.js';

const blocked = (method: string, url: string, resourceType: string, extra: Partial<GuardEvent> = {}): GuardEvent =>
  ({ kind: 'blocked', method, url, resourceType, reason: method === 'GET' ? 'data' : 'method', at: 0, ...extra });
const DOING = 'during the gesture or drag';
const none = new Set<string>();

describe('pointerStop', () => {
  it('the gesture test: a blocked stylesheet, font, image or media file from a public font or static-file server or an analytics host, with no query, does not stop it', () => {
    for (const type of ['stylesheet', 'font', 'image', 'media']) {
      expect(pointerStop([blocked('GET', 'https://www.gstatic.com/recaptcha/releases/x/styles__ltr.css', type)], none, DOING, { shownFiles: true })).toBeUndefined();
      expect(pointerStop([blocked('GET', 'https://fonts.gstatic.com/s/roboto/v30/a.woff2', type)], none, DOING, { shownFiles: true })).toBeUndefined();
    }
  });

  it('the gesture test: the same file from the page\'s own site, another host, or with a query still stops it (round 2 review #3)', () => {
    for (const url of ['https://e.org/api/session/end', 'https://e.org/api/logout.png', 'https://e.org/pixel?down=1', 'https://cdn.e.org/a.css', 'https://fonts.gstatic.com/s/a.woff2?u=1', 'https://203.0.113.10/a.png']) {
      expect(pointerStop([blocked('GET', url, 'image')], none, DOING, { shownFiles: true })).toBeTruthy();
    }
  });

  it('the gesture test: a fetch, a script, a frame, a write or a navigation still stops it', () => {
    for (const e of [blocked('GET', 'https://e.org/api/labels', 'fetch'), blocked('GET', 'https://e.org/app.js', 'script'), blocked('GET', 'https://e.org/frame', 'document'), blocked('POST', 'https://e.org/a.css', 'stylesheet', { cause: 'own' })]) {
      expect(pointerStop([e], none, DOING, { shownFiles: true })).toBeTruthy();
    }
    expect(pointerStop([{ kind: 'navigation', url: 'https://e.org/x', at: 0 }], none, DOING, { shownFiles: true })).toMatch(/another address/);
  });

  it('without shownFiles (pointer cancellation), a blocked image still stops the test', () => {
    expect(pointerStop([blocked('GET', 'https://e.org/a.png', 'image')], none, 'when it was pressed or released')).toMatch(/^the page made a request when it was pressed or released \(image request/);
  });
});
