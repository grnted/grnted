// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plain names of the built-in tests (probes): the hosted conformance report's remarks ("the reflow test") and the
// issue list's Test column. Every test in the registry has one
// (test/unit/probeLabels.test.ts). A test this list does not know (one passed in from outside the registry) is named
// after its id.

const LABELS: Readonly<Record<string, string>> = {
  headings: 'Headings',
  'page-titles': 'Page titles',
  'text-spacing': 'Text spacing',
  'resize-text': 'Resize text',
  reflow: 'Reflow',
  'text-contrast': 'Text contrast',
  'non-text-contrast': 'Non-text contrast',
  'link-color': 'Link color',
  orientation: 'Orientation',
  keyboard: 'Keyboard',
  'key-shortcuts': 'Key shortcuts',
  overlays: 'Overlays',
  'form-fields': 'Form fields',
  'hover-content': 'Content on hover',
  'keyboard-deep': 'Keyboard (deep)',
  controls: 'Controls (keyboard and mouse)',
  'route-titles': 'Titles after a page change',
  'timing-entry': 'Time limits on what you enter',
  'pointer-cancellation': 'Pointer cancellation',
  forms: 'Forms',
  'pointer-gestures': 'Pointer gestures',
  audio: 'Audio that plays by itself',
  motion: 'Moving content',
  'motion-actuation': 'Motion actuation',
  timing: 'Time limits',
  flash: 'Flashes',
  'flash-motion': 'Flashes (animations and images)',
  'timing-watch': 'Time limits (watched)',
  'media-players': 'Media players',
  'media-files': 'Videos without captions',
  'media-alternatives': 'Audio without a transcript',
  'link-purpose': 'Link purpose',
  'aria-states': 'ARIA states',
  'language-parts': 'Language of page and parts',
  names: 'Names',
  'picture-text': 'Words in pictures',
  'screen-reader': 'Screen reader',
  'screen-reader-live': 'Screen reader live',
  'forced-colors': 'Forced colors',
  'state-text-contrast': 'Text contrast after load and in opened menus',
};

/** Whether the list names the test (a built-in one); one it does not know is named after its id. */
export function hasProbeLabel(id: string): boolean {
  return Object.hasOwn(LABELS, id);
}

/** The test's plain name: from the list, else its id with dashes as spaces, capitalised, at most 40 characters. */
export function probeLabel(id: string): string {
  const known = Object.hasOwn(LABELS, id) ? LABELS[id] : undefined;
  if (known) return known;
  const plain = String(id).replace(/[^A-Za-z0-9 _-]/g, '').replace(/[-_]+/g, ' ').trim().slice(0, 40);
  return plain ? plain[0]!.toUpperCase() + plain.slice(1) : 'A test';
}
