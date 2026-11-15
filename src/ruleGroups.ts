// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Scoring v4 (docs/scoring.md): each axe rule's user-impact group, which sets its score weight. Written
// by hand, on purpose: every rule in the rule set (RULE_IMPACTS, generated from scripts/axe-rule-set.mjs)
// must be listed here (a unit test checks it), so a rule added later is classified by a decision, not by
// a fallback. Changing a group changes scores: bump SCORING_VERSION and docs/scoring.md with it.
// Engine core: no Node-only imports.

/**
 * - `visible`: problems a person sees or meets directly on the page (contrast, small targets, missing
 *   text alternatives for images and media, moving or zoom-blocking content).
 * - `markup`: structure and ARIA markup errors that mostly reach people through assistive technology
 *   (list and table structure, invalid ARIA attributes and roles, language codes).
 * - `names`: controls, links, frames and pages without an accessible name, and the other operability
 *   rules (focus, nesting, page title and language).
 */
export type RuleGroup = 'visible' | 'markup' | 'names';

/** The weight of each group, before halving for moderate and minor axe impact. */
export const GROUP_WEIGHTS: Readonly<Record<RuleGroup, number>> = { visible: 9, markup: 3, names: 7 };

/** Group of an id that is not in the table. */
export const DEFAULT_RULE_GROUP: RuleGroup = 'names';

/**
 * Every rule in the rule set (68, axe-core 4.14.0), plus three axe best-practice rules that are not in
 * the rule set (`meta-viewport-large`, `aria-allowed-role`, `aria-dialog-name`), classified so they
 * score as decided if they are ever added.
 */
export const RULE_GROUPS: Readonly<Record<string, RuleGroup>> = {
  // visible (9)
  'area-alt': 'visible',
  'blink': 'visible',
  'color-contrast': 'visible',
  'css-orientation-lock': 'visible',
  'image-alt': 'visible',
  'input-image-alt': 'visible',
  'link-in-text-block': 'visible',
  'marquee': 'visible',
  'meta-refresh': 'visible',
  'meta-viewport': 'visible',
  'meta-viewport-large': 'visible',
  'object-alt': 'visible',
  'role-img-alt': 'visible',
  'svg-img-alt': 'visible',
  'target-size': 'visible',
  'video-caption': 'visible',
  // markup (3)
  'aria-allowed-attr': 'markup',
  'aria-allowed-role': 'markup',
  'aria-braille-equivalent': 'markup',
  'aria-conditional-attr': 'markup',
  'aria-deprecated-role': 'markup',
  'aria-hidden-body': 'markup',
  'aria-prohibited-attr': 'markup',
  'aria-required-children': 'markup',
  'aria-required-parent': 'markup',
  'aria-roles': 'markup',
  'aria-valid-attr': 'markup',
  'aria-valid-attr-value': 'markup',
  'avoid-inline-spacing': 'markup',
  'definition-list': 'markup',
  'dlitem': 'markup',
  'duplicate-id-aria': 'markup',
  'html-lang-valid': 'markup',
  'list': 'markup',
  'listitem': 'markup',
  'p-as-heading': 'markup',
  'scrollable-region-focusable': 'markup',
  'table-fake-caption': 'markup',
  'td-has-header': 'markup',
  'td-headers-attr': 'markup',
  'th-has-data-cells': 'markup',
  'valid-lang': 'markup',
  // names (7)
  'aria-command-name': 'names',
  'aria-dialog-name': 'names',
  'aria-hidden-focus': 'names',
  'aria-input-field-name': 'names',
  'aria-meter-name': 'names',
  'aria-progressbar-name': 'names',
  'aria-required-attr': 'names',
  'aria-tab-name': 'names',
  'aria-toggle-field-name': 'names',
  'aria-tooltip-name': 'names',
  'autocomplete-valid': 'names',
  'bypass': 'names',
  'button-name': 'names',
  'document-title': 'names',
  'form-field-multiple-labels': 'names',
  'frame-focusable-content': 'names',
  'frame-title': 'names',
  'frame-title-unique': 'names',
  'html-has-lang': 'names',
  'html-xml-lang-mismatch': 'names',
  'input-button-name': 'names',
  'label': 'names',
  'label-content-name-mismatch': 'names',
  'link-name': 'names',
  'nested-interactive': 'names',
  'no-autoplay-audio': 'names',
  'select-name': 'names',
  'server-side-image-map': 'names',
  'summary-name': 'names',
};

/** A rule's group; an id that is not in the table (only an own key counts) is `names`. */
export function ruleGroupOf(id: string): RuleGroup {
  return Object.prototype.hasOwnProperty.call(RULE_GROUPS, id) ? RULE_GROUPS[id]! : DEFAULT_RULE_GROUP;
}
