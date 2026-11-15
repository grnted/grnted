// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The 2.5.4 probe (motion-actuation, core) in real Chromium on test/fixtures/motion/actuation-*.html.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { motionActuationProbe } from '../../src/probes/actuation.js';
import type { ProbeRun } from '../../src/probes/types.js';
import { motionSite, only, type MotionSite } from '../helpers/motionProbes.js';

let site: MotionSite;
beforeAll(async () => { site = await motionSite(); }, 30_000);
afterAll(async () => { await site?.close(); });

describe('motion-actuation probe (2.5.4)', () => {
  let runs: Record<string, ProbeRun[]>;
  beforeAll(async () => {
    runs = await site.run([motionActuationProbe], [
      'actuation-shake.html', 'actuation-tilt-ok.html', 'actuation-tilt-nooff.html', 'actuation-parallax.html', 'actuation-idle.html', 'static.html',
      'actuation-shake-toggle.html', 'actuation-tilt-switch.html', 'actuation-toggle-unrelated.html',
      'actuation-cooldown-tips.html', 'actuation-switch-pressed.html', 'actuation-hidden-checkbox.html',
      'actuation-once.html', 'actuation-crowded.html', 'actuation-shadow-switch.html', 'actuation-late-state.html',
      'actuation-level-off.html', 'actuation-level-nooff.html',
    ], { concurrency: 3 });
  }, 180_000);
  const f = (page: string) => only(runs[page]![0]!);

  it('fails an action done by shaking with no control that does the same', () => {
    expect(f('actuation-shake.html')).toMatchObject({ status: 'failed', target: '#list', detail: expect.stringContaining('shaking the device changes the content of #list') });
    expect(f('actuation-shake.html').detail).toContain('no control next to it does the same');
  });

  it('fails an action done by tilting that cannot be turned off, even with buttons that do the same', () => {
    expect(f('actuation-tilt-nooff.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing turns the response to motion off') });
    expect(f('actuation-tilt-nooff.html').detail).toMatch(/"(Previous|Next)" does the same/);
  });

  // 2026-11-09 benchmark review: WCAG 2.5.4 needs both the control and the off switch. Buttons that step a value
  // ("Increase level") are controls that do what tilting does.
  it('finds Increase and Decrease buttons as the control that does the same; still fails without an off switch', () => {
    expect(f('actuation-level-off.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringMatching(/"(Increase|Decrease) level" does the same, and "Turn tilt off" turns the motion response off/) });
    expect(f('actuation-level-nooff.html')).toMatchObject({ status: 'failed', detail: expect.stringMatching(/"(Increase|Decrease) level" does the same, but nothing turns the response to motion off/) });
  });

  it('accepts an action with a control that does the same and a working off switch', () => {
    expect(f('actuation-tilt-ok.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Turn tilt off" turns the motion response off') });
  });

  it('accepts a check box or switch named for the motion ("Shake to undo") whose state turns the motion off', () => {
    expect(f('actuation-shake-toggle.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Shake to undo" turns the motion response off') });
    expect(f('actuation-tilt-switch.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Tilt to change slides" turns the motion response off') });
  });

  it('does not take a toggle or link that only mentions the motion as the off switch', () => {
    expect(f('actuation-toggle-unrelated.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing turns the response to motion off') });
    expect(f('actuation-toggle-unrelated.html').detail).toContain('"Show shake tips"');
  });

  it('review round 1: with a 3 s shake cooldown, "Show shake tips" (listed first) is not the off switch, "Shake to undo" is, and the tips box is put back', () => {
    const r = f('actuation-cooldown-tips.html');
    expect(r).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Shake to undo" turns the motion response off') });
    expect(r.detail).not.toContain('"Show shake tips" turns');
    const tips = site.requests.filter((q) => q.includes('tips='));
    expect(tips.length).toBeGreaterThan(0);
    expect(tips.at(-1)).toContain('tips=false');
  });

  it('review round 1: a switch that keeps its state in aria-pressed, and a visually hidden check box used through its label', () => {
    expect(f('actuation-switch-pressed.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Tilt to change slides" turns the motion response off') });
    expect(f('actuation-hidden-checkbox.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Shake to undo" turns the motion response off') });
  });

  it('review round 2: a gesture that acts only once, with no off switch, fails (not untested)', () => {
    expect(f('actuation-once.html')).toMatchObject({ status: 'failed', detail: expect.stringContaining('nothing turns the response to motion off') });
  });

  it('review round 2: "Turn shake off" is found behind three toggles that only mention shaking; a switch in an open shadow root is found', () => {
    expect.soft(f('actuation-crowded.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Turn shake off" turns the motion response off') });
    expect.soft(f('actuation-shadow-switch.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('"Shake to undo" turns the motion response off') });
  });

  it('review round 2: a switch whose state follows the click 600 ms late is put back', () => {
    const hints = site.requests.filter((q) => q.includes('hints='));
    expect(hints.length).toBeGreaterThan(0);
    expect(hints.at(-1)).toContain('hints=false');
  });

  it('does not count visual effects or listeners that change nothing; not applicable without listeners', () => {
    expect(f('actuation-parallax.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('visual effect') });
    expect(f('actuation-idle.html')).toMatchObject({ status: 'no_failures_found', detail: expect.stringContaining('changed nothing') });
    expect(f('static.html')).toMatchObject({ status: 'not_applicable' });
  });
});
