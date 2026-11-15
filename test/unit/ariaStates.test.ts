// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The ARIA state conflicts test's rules (4.1.2) on what the page reader reports. The reader itself
// runs in Chromium: test/integration/ariaStates.test.ts.
import { describe, expect, it } from 'vitest';
import { ARIA_STATES_PROBE_ID, ariaStateFindings, ariaStatesProbe, type AriaConflict } from '../../src/probes/ariaStates.js';
import { PROBES, SCORED_PROBES } from '../../src/probes/registry.js';

const c = (kind: AriaConflict['kind'], extra: Partial<AriaConflict> = {}): AriaConflict => ({ kind, name: 'Menu', role: 'button', target: `#${kind}`, ...extra });

describe('ariaStateFindings', () => {
  it('finds nothing with no conflicts', () => {
    expect(ariaStateFindings({ conflicts: [], truncated: false })).toEqual([]);
  });

  it('says plainly what each conflict is', () => {
    const f = ariaStateFindings({
      conflicts: [
        c('expanded-hidden'),
        c('collapsed-shown'),
        c('multiple-selected', { role: 'tab', count: 2, name: '' }),
        c('selected-panel-hidden', { role: 'tab', name: 'Fees' }),
        c('native-mismatch', { role: 'textbox', name: 'Email', attribute: 'aria-required', value: 'false', native: 'required' }),
      ],
      truncated: false,
    });
    expect(f.map((x) => [x.criterion, x.status, x.target])).toEqual([
      ['4.1.2', 'failed', '#expanded-hidden'], ['4.1.2', 'failed', '#collapsed-shown'], ['4.1.2', 'failed', '#multiple-selected'],
      ['4.1.2', 'failed', '#selected-panel-hidden'], ['4.1.2', 'failed', '#native-mismatch'],
    ]);
    expect(f.map((x) => x.detail)).toEqual([
      'The button “Menu” tells screen readers it is expanded, but what it opens is hidden',
      'The button “Menu” tells screen readers it is collapsed, but what it opens is shown',
      '2 tabs in one tab list are marked selected, so screen readers cannot tell which one is current',
      'The tab “Fees” is marked selected, but its panel is hidden',
      'The textbox “Email” is required, but aria-required="false" tells screen readers it is not',
    ]);
  });

  it('lists at most five per page and counts the rest', () => {
    const f = ariaStateFindings({ conflicts: Array.from({ length: 7 }, (_, i) => c('expanded-hidden', { target: `#m${i}` })), truncated: false });
    expect(f).toHaveLength(5);
    expect(f[4]!.detail).toMatch(/2 more/);
  });
});

describe('the aria-states probe', () => {
  it('is a core test on every page, for 4.1.2 only, registered once', () => {
    expect(ariaStatesProbe).toMatchObject({ id: ARIA_STATES_PROBE_ID, criteria: ['4.1.2'], tier: 'core', everyPage: true, kind: 'render' });
    expect(PROBES.filter((p) => p.id === ARIA_STATES_PROBE_ID)).toHaveLength(1);
  });

  it('runs on every scan and is scored since v8: the gold standard verified it (docs/scoring.md)', () => {
    expect(SCORED_PROBES.has(ARIA_STATES_PROBE_ID)).toBe(true);
  });
});
