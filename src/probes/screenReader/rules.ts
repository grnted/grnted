// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The announcement rules of the simulated screen reader, as data: how NVDA (browse mode) and VoiceOver
// (VO+Right) put a role, a name and states into words. Starting values from the vendors' documented
// behaviour, tuned by the real-VoiceOver calibration (FORMAT.md); the role and state words are the only
// thing that changes between the two, the reading order and the elements lists come from Chromium's
// accessibility tree. Engine core: no Node-only imports.
//
// Sources:
// - NVDA User Guide, "Browse Mode", "Elements List", "Document Formatting" (landmarks, lists, tables
//   reported on entry and exit): https://www.nvaccess.org/files/nvda/documentation/userGuide.html
// - VoiceOver User Guide for Mac, "Navigate webpages", "Use the VoiceOver rotor", "Hear the content of
//   tables": https://support.apple.com/guide/voiceover/welcome/mac
// - WAI-ARIA 1.2 and HTML-AAM (role and state mappings Chromium follows):
//   https://www.w3.org/TR/wai-aria-1.2/ and https://www.w3.org/TR/html-aam-1.0/

export type Voice = 'nvda' | 'voiceover';

/** How a role is spoken: `role` in each voice, and whether the name comes before the role words. */
export interface RoleWords {
  nvda: string;
  voiceover: string;
}

/**
 * Role words per normalized ARIA role. NVDA (browse mode) says the role first ("link About");
 * VoiceOver says the name first ("About, link"). `''` means the role is not spoken (plain text).
 */
export const ROLE_WORDS: Readonly<Record<string, RoleWords>> = {
  statictext: { nvda: '', voiceover: '' },
  heading: { nvda: 'heading level {level}', voiceover: 'heading level {level}' },
  link: { nvda: 'link', voiceover: 'link' },
  button: { nvda: 'button', voiceover: 'button' },
  // A native disclosure: Chromium's DisclosureTriangle, a details element's summary (NVDA: a button; VoiceOver: a
  // disclosure triangle), said with its collapsed or expanded state (2026-11-13: it was read as plain text).
  disclosuretriangle: { nvda: 'button', voiceover: 'disclosure triangle' },
  textbox: { nvda: 'edit', voiceover: 'edit text' },
  searchbox: { nvda: 'edit', voiceover: 'search text field' },
  checkbox: { nvda: 'check box', voiceover: 'checkbox' },
  radio: { nvda: 'radio button', voiceover: 'radio button' },
  switch: { nvda: 'switch', voiceover: 'switch' },
  combobox: { nvda: 'combo box', voiceover: 'pop-up button' },
  listbox: { nvda: 'list', voiceover: 'list box' },
  option: { nvda: '', voiceover: '' },
  slider: { nvda: 'slider', voiceover: 'slider' },
  spinbutton: { nvda: 'spin button', voiceover: 'stepper' },
  tab: { nvda: 'tab', voiceover: 'tab' },
  menuitem: { nvda: 'menu item', voiceover: 'menu item' },
  menuitemcheckbox: { nvda: 'check menu item', voiceover: 'menu item' },
  menuitemradio: { nvda: 'radio menu item', voiceover: 'menu item' },
  treeitem: { nvda: 'tree view item', voiceover: 'tree item' },
  img: { nvda: 'graphic', voiceover: 'image' },
  cell: { nvda: '', voiceover: '' },
  gridcell: { nvda: '', voiceover: '' },
  columnheader: { nvda: 'column header', voiceover: 'column header' },
  // VoiceOver (calibration 2026-11-05): a row header is read as its row ("row 2 of 4 Day Monday"), no role word.
  rowheader: { nvda: 'row header', voiceover: '' },
  separator: { nvda: 'separator', voiceover: 'separator' },
  progressbar: { nvda: 'progress bar', voiceover: 'progress indicator' },
  meter: { nvda: 'meter', voiceover: 'level indicator' },
  dialog: { nvda: 'dialog', voiceover: 'web dialog' },
  alertdialog: { nvda: 'alert', voiceover: 'web alert dialog' },
  group: { nvda: 'grouping', voiceover: 'group' },
  radiogroup: { nvda: 'grouping', voiceover: 'radio group' },
  figure: { nvda: 'figure', voiceover: 'figure' },
  article: { nvda: 'article', voiceover: 'article' },
  math: { nvda: 'math', voiceover: 'math' },
};

/** Landmarks: spoken on entry ("main landmark" / "main") and exit ("out of main landmark" / "end of main"). */
export const LANDMARK_WORDS: Readonly<Record<string, RoleWords>> = {
  banner: { nvda: 'banner landmark', voiceover: 'banner' },
  navigation: { nvda: 'navigation landmark', voiceover: 'navigation' },
  main: { nvda: 'main landmark', voiceover: 'main' },
  contentinfo: { nvda: 'content info landmark', voiceover: 'content information' },
  complementary: { nvda: 'complementary landmark', voiceover: 'complementary' },
  region: { nvda: 'region', voiceover: 'region' },
  form: { nvda: 'form landmark', voiceover: 'form' },
  search: { nvda: 'search landmark', voiceover: 'search' },
};

/**
 * Landmarks need a name to be announced as one (WAI-ARIA 1.2: region and form are landmarks only when
 * labelled; NVDA and VoiceOver skip unlabelled ones).
 */
export const LANDMARK_NEEDS_NAME: ReadonlySet<string> = new Set(['region', 'form']);

/** Containers spoken on entry with a count and on exit. `{n}` = items, `{rows}`/`{cols}` for tables. */
export const CONTAINER_WORDS = {
  list: { enter: { nvda: 'list with {n} items', voiceover: 'list, {n} items' }, exit: { nvda: 'out of list', voiceover: 'end of list' } },
  table: {
    enter: { nvda: 'table with {rows} rows and {cols} columns', voiceover: 'table, {rows} rows, {cols} columns' },
    exit: { nvda: 'out of table', voiceover: 'end of table' },
  },
  landmarkExit: { nvda: 'out of {landmark}', voiceover: 'end of {landmark}' },
} as const;

/** State words, in the order they are spoken after the role. */
export const STATE_WORDS: readonly { state: string; nvda: string; voiceover: string }[] = [
  { state: 'visited', nvda: 'visited', voiceover: 'visited' },
  { state: 'current', nvda: 'current page', voiceover: 'current page' },
  { state: 'required', nvda: 'required', voiceover: 'required' },
  { state: 'invalid', nvda: 'invalid entry', voiceover: 'invalid data' },
  { state: 'expanded', nvda: 'expanded', voiceover: 'expanded' },
  { state: 'collapsed', nvda: 'collapsed', voiceover: 'collapsed' },
  { state: 'checked', nvda: 'checked', voiceover: 'checked' },
  { state: 'unchecked', nvda: 'not checked', voiceover: 'unchecked' },
  { state: 'mixed', nvda: 'half checked', voiceover: 'mixed' },
  { state: 'pressed', nvda: 'pressed', voiceover: 'selected' },
  { state: 'selected', nvda: 'selected', voiceover: 'selected' },
  { state: 'readonly', nvda: 'read only', voiceover: 'read-only' },
  { state: 'disabled', nvda: 'unavailable', voiceover: 'dimmed' },
];

/**
 * Live announcements (WAI-ARIA 1.2 "Live Regions"; NVDA and VoiceOver speak the new text of a live
 * region that was on the page before it changed, and an alert also when it is added with its text).
 * The text is spoken as it is, with no role word.
 */
export const LIVE_WORDS = {
  nothing: { nvda: 'nothing is said', voiceover: 'nothing is said' },
} as const;

/** Roles NVDA and VoiceOver treat as controls: a missing name leaves only the role word (4.1.2). */
export const CONTROL_ROLES: ReadonlySet<string> = new Set([
  'button', 'disclosuretriangle', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'slider', 'spinbutton',
  'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem',
]);

/** Roles listed under "form controls" (NVDA's elements list "Form fields", VO's rotor "Form Controls"). */
export const FORM_CONTROL_ROLES: ReadonlySet<string> = new Set([
  'button', 'disclosuretriangle', 'textbox', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'slider', 'spinbutton',
]);

/** Roles whose own name already says their content: the reader speaks the name and skips the text inside. */
export const NAME_FROM_CONTENT_LEAVES: ReadonlySet<string> = new Set([
  'heading', 'link', 'button', 'disclosuretriangle', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'option',
  'checkbox', 'radio', 'switch', 'img', 'textbox', 'searchbox', 'combobox', 'listbox', 'slider', 'spinbutton',
  'columnheader', 'rowheader', 'cell', 'gridcell', 'progressbar', 'meter', 'separator', 'math',
]);

/** Chromium's internal roles mapped to ARIA role names (FORMAT.md). Unlisted names are lowercased. */
export const CHROMIUM_ROLE: Readonly<Record<string, string>> = {
  StaticText: 'statictext',
  image: 'img',
  RootWebArea: 'document',
  LayoutTable: 'layouttable',
  LayoutTableRow: 'layouttablerow',
  LayoutTableCell: 'layouttablecell',
  LabelText: 'labeltext',
  ListMarker: 'listmarker',
  InlineTextBox: 'inlinetextbox',
  MenuListPopup: 'menulistpopup',
  MenuListOption: 'option',
  Section: 'generic',
  Iframe: 'iframe',
  IframePresentational: 'iframe',
  Canvas: 'img',
  Video: 'group',
  Audio: 'group',
  DescriptionList: 'list',
  DescriptionListTerm: 'term',
  DescriptionListDetail: 'definition',
  SvgRoot: 'img',
  graphics_document: 'img',
  'graphics-document': 'img',
  'graphics-symbol': 'img',
  'doc-subtitle': 'heading',
};

/** Roles never spoken and whose subtree is never read in the read-through (a closed select's options). */
export const SKIP_SUBTREE: ReadonlySet<string> = new Set(['inlinetextbox', 'menulistpopup', 'listmarker']);

/** Fills `{key}` placeholders. */
export function fill(template: string, vars: Readonly<Record<string, string | number | undefined>>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? '')).replace(/\s+/g, ' ').trim();
}

/** The phrase for one item in one voice (rules above): NVDA role-first, VoiceOver name-first. */
export function speak(voice: Voice, item: { role: string; name: string; level?: number; states?: readonly string[]; value?: string; description?: string }): string {
  const words = ROLE_WORDS[item.role];
  const role = words ? fill(words[voice], { level: item.level }) : item.role === 'unknown' ? '' : item.role;
  const states = STATE_WORDS.filter((s) => item.states?.includes(s.state)).map((s) => s[voice]);
  // A link's visited state comes before the role word in both ("visited link About").
  const visited = item.role === 'link' && states[0] === 'visited' ? states.shift() : undefined;
  const roleWords = [visited, role].filter(Boolean).join(' ');
  const value = item.value && item.value !== item.name ? item.value : '';
  // Descriptions: NVDA after the states and value, VoiceOver right after the name (calibration 2026-11-05).
  if (voice === 'nvda') return [roleWords, item.name, ...states, value, item.description].filter(Boolean).join(', ');
  return [item.name, item.description, value, ...states, roleWords].filter(Boolean).join(', ');
}
