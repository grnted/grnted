// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The words a finding gives for a box that could not be dismissed (src/probes/dismiss.ts). The helper
// itself runs in Chromium: test/integration/dismiss.test.ts.
import { describe, expect, it } from 'vitest';
import { DISMISS_NAME, whyNot } from '../../src/probes/dismiss.js';

describe('whyNot', () => {
  const t = (outcome: Parameters<typeof whyNot>[0][number]['outcome'], key?: 'Enter' | 'Space') => ({ name: 'Close', path: '#x', outcome, ...(key ? { key } : {}) });
  it('names the last decisive try', () => {
    expect(whyNot([])).toBe('nothing in it that closes it can be reached with the keyboard');
    expect(whyNot([t('no-focus')])).toBe('its “Close” control does not take keyboard focus');
    expect(whyNot([t('not-closed', 'Enter'), t('not-closed', 'Space')])).toBe('pressing Enter or Space on its “Close” control does not close it');
    expect(whyNot([t('came-back', 'Enter')])).toBe('it comes back right after it is closed');
    expect(whyNot([t('guard', 'Enter')])).toMatch(/sends a request or loads a page/);
    expect(whyNot([t('address', 'Enter')])).toMatch(/changes the page's address/);
  });
  it('picks controls by name only to decide what to try', () => {
    for (const n of ['Close', 'Accept all', 'Got it', 'No thanks', '×', 'Dismiss']) expect(DISMISS_NAME.test(n), n).toBe(true);
    for (const n of ['Learn more', 'Settings', 'Read the policy']) expect(DISMISS_NAME.test(n), n).toBe(false);
  });
});
