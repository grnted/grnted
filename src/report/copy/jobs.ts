// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 (stage 2, 2026-11-09): the words a repair job's title and its "what changes" sentence are built
// from (src/report/jobContent.ts). Each fix is an act: an imperative verb and an object ("stop" + "the
// flashing"), the group of fixes it belongs to (so a big job can be named by its groups), and the outcome
// once it's done ("nothing flashes"). Plain words, no jargon, US spelling. Changing any of it bumps COPY_VERSION.

export type Family = 'motion' | 'keyboard' | 'focus' | 'form' | 'contrast' | 'layout' | 'pictures' | 'media' | 'links'
  | 'structure' | 'names' | 'settings' | 'touch' | 'consistency' | 'time';

export interface Act {
  verb: string;
  /** The object for one problem, and for several. */
  one: string;
  many: string;
  family: Family;
  /** The result once done, as a clause that can follow "On the Contact page, …". */
  outcome: string;
}

const a = (verb: string, one: string, many: string, family: Family, outcome: string): Act => Object.freeze({ verb, one, many, family, outcome });

/** One act per WCAG 2.2 A and AA criterion a test can fail. */
export const CRITERION_ACTS: Readonly<Record<string, Act>> = Object.freeze({
  '1.1.1': a('describe', 'the picture', 'the pictures', 'pictures', 'pictures have a text description'),
  '1.2.1': a('add', 'a text version of the recording', 'text versions of the recordings', 'media', 'recordings have a text version'),
  '1.2.2': a('caption', 'the video', 'the videos', 'media', 'videos have captions'),
  '1.2.3': a('describe', 'what the video shows', 'what the videos show', 'media', 'videos describe what is on screen'),
  '1.2.4': a('caption', 'the live stream', 'the live streams', 'media', 'live streams have captions'),
  '1.2.5': a('add', 'audio description', 'audio description', 'media', 'videos have audio description'),
  '1.3.1': a('fix', 'the page structure', 'the page structure', 'structure', 'headings, lists and tables are marked up for screen readers'),
  '1.3.2': a('fix', 'the reading order', 'the reading order', 'structure', 'content is read in the right order'),
  '1.3.3': a('reword', 'the shape-only instruction', 'shape-only instructions', 'structure', 'instructions name what to use'),
  '1.3.4': a('unlock', 'the screen orientation', 'the screen orientation', 'layout', 'pages work upright and sideways'),
  '1.3.5': a('add', 'autocomplete to personal fields', 'autocomplete to personal fields', 'form', 'browsers can fill in personal details'),
  '1.4.1': a('stop', 'relying on color alone', 'relying on color alone', 'contrast', 'nothing is shown by color alone'),
  '1.4.2': a('stop', 'the sound', 'the sound', 'motion', 'no sound plays by itself'),
  '1.4.3': a('fix', 'faint text', 'faint text', 'contrast', 'text stands out enough to read'),
  '1.4.4': a('allow', 'zoom', 'zoom', 'layout', 'text can be enlarged'),
  '1.4.5': a('replace', 'the picture of text', 'pictures of text', 'pictures', 'words are real text, not pictures'),
  '1.4.10': a('fit', 'the page to narrow screens', 'pages to narrow screens', 'layout', 'pages fit a phone screen'),
  '1.4.11': a('strengthen', 'the faint control or icon', 'faint controls and icons', 'contrast', 'fields, buttons and icons stand out'),
  '1.4.12': a('free', 'text spacing', 'text spacing', 'layout', 'text stays readable with wider spacing'),
  '1.4.13': a('fix', 'the hover pop-up', 'hover pop-ups', 'layout', 'pop-ups can be closed and stay open while read'),
  '2.1.1': a('fix', 'keyboard access', 'keyboard access', 'keyboard', 'every control works with a keyboard'),
  '2.1.2': a('free', 'the keyboard trap', 'the keyboard traps', 'keyboard', 'keyboard focus no longer gets stuck'),
  '2.1.4': a('fix', 'single-key shortcuts', 'single-key shortcuts', 'keyboard', 'shortcuts don’t go off by accident'),
  '2.2.1': a('extend', 'the time limit', 'time limits', 'time', 'people get enough time'),
  '2.2.2': a('stop', 'the moving content', 'the moving content', 'motion', 'moving and updating content can be paused'),
  '2.3.1': a('stop', 'the flashing', 'the flashing', 'motion', 'nothing flashes'),
  '2.4.1': a('add', 'a skip link', 'a skip link', 'focus', 'keyboard users can skip the menu'),
  '2.4.2': a('title', 'the page', 'the pages', 'settings', 'every page has a title'),
  '2.4.3': a('fix', 'the focus order', 'the focus order', 'focus', 'focus moves in a sensible order'),
  '2.4.4': a('rename', 'the unclear link', 'unclear links', 'links', 'every link says where it goes'),
  '2.4.5': a('add', 'a site search or site map', 'a site search or site map', 'consistency', 'pages can be found more than one way'),
  '2.4.6': a('rename', 'the heading or label', 'headings and labels', 'structure', 'headings and labels say what they are for'),
  '2.4.7': a('show', 'keyboard focus', 'keyboard focus', 'focus', 'keyboard focus is always visible'),
  '2.4.11': a('unhide', 'the focused item', 'focused items', 'focus', 'focused items aren’t hidden behind fixed boxes'),
  '2.5.1': a('simplify', 'the gesture', 'gestures', 'touch', 'gestures have a single-tap alternative'),
  '2.5.2': a('fix', 'the press-to-fire control', 'press-to-fire controls', 'touch', 'actions wait until the finger is lifted'),
  '2.5.3': a('match', 'the name to its label', 'names to their labels', 'names', 'voice control users can say what they see'),
  '2.5.4': a('add', 'a button for the motion action', 'buttons for motion actions', 'touch', 'shake and tilt actions have a button too'),
  '2.5.7': a('add', 'a tap alternative to dragging', 'tap alternatives to dragging', 'touch', 'dragging has a tap alternative'),
  '2.5.8': a('enlarge', 'the small target', 'the small targets', 'touch', 'buttons and links are big enough to tap'),
  '3.1.1': a('set', 'the page language', 'the page language', 'settings', 'screen readers use the right language'),
  '3.1.2': a('fix', 'the language code', 'the language codes', 'settings', 'other-language passages are read correctly'),
  '3.2.1': a('stop', 'the focus surprise', 'focus surprises', 'focus', 'nothing changes just because a control gets focus'),
  '3.2.2': a('stop', 'the change on input', 'changes on input', 'form', 'choices don’t change the page by themselves'),
  '3.2.3': a('keep', 'the menu in one order', 'menus in one order', 'consistency', 'the menu stays in the same order'),
  '3.2.4': a('name', 'repeated links the same way', 'repeated links the same way', 'consistency', 'repeated links keep the same names'),
  '3.2.6': a('keep', 'help in one place', 'help in one place', 'consistency', 'help stays in the same place'),
  '3.3.1': a('describe', 'form errors in words', 'form errors in words', 'form', 'form errors are described in words'),
  '3.3.2': a('label', 'the field', 'the fields', 'form', 'every field has a label'),
  '3.3.3': a('explain', 'how to fix errors', 'how to fix errors', 'form', 'error messages say how to fix them'),
  '3.3.4': a('add', 'a review step', 'review steps', 'form', 'important forms can be checked before they are sent'),
  '3.3.7': a('stop', 'asking twice', 'asking twice', 'form', 'people aren’t asked for the same thing twice'),
  '3.3.8': a('allow', 'pasting at sign-in', 'pasting at sign-in', 'form', 'password managers work at sign-in'),
  '4.1.2': a('repair', 'the custom control', 'the custom controls', 'names', 'controls tell screen readers what they are and what state they are in'),
  '4.1.3': a('announce', 'the status message', 'status messages', 'names', 'status messages are announced'),
});

/** Acts for fixes whose words differ from their criterion's (fix keys as in copy/fixes.ts). */
export const FIX_ACTS: Readonly<Record<string, Act>> = Object.freeze({
  'rule:link-in-text-block': a('underline', 'the link in text', 'links in text', 'links', 'links stand out without relying on color'),
  'probe:link-color:1.4.1': a('underline', 'the link in text', 'links in text', 'links', 'links stand out without relying on color'),
  'ai:vision:1.4.1': a('stop', 'relying on color alone', 'relying on color alone', 'contrast', 'information shown by color is shown another way too'),
  'rule:link-name': a('name', 'the link with no text', 'the links with no text', 'links', 'every link has a name'),
  'rule:button-name': a('name', 'the button', 'the buttons', 'names', 'every button has a name'),
  'rule:input-button-name': a('name', 'the button', 'the buttons', 'names', 'every button has a name'),
  'rule:frame-title': a('name', 'the embedded frame', 'the embedded frames', 'names', 'embedded frames have names'),
  'rule:meta-viewport': a('turn on', 'zoom', 'zoom', 'layout', 'people can zoom on phones'),
  'rule:td-has-header': a('fix', 'the table headers', 'the table headers', 'structure', 'table cells are tied to their headers'),
  'rule:list': a('fix', 'the list', 'the lists', 'structure', 'lists are read as lists'),
  'rule:label': a('label', 'the field', 'the fields', 'form', 'every field has a label'),
  'rule:select-name': a('label', 'the drop-down list', 'the drop-down lists', 'form', 'every drop-down list has a label'),
  'rule:scrollable-region-focusable': a('open', 'the scrolling box to keyboards', 'scrolling boxes to keyboards', 'keyboard', 'scrolling boxes work with a keyboard'),
  'rule:bypass': a('add', 'a skip link', 'a skip link', 'focus', 'keyboard users can skip the menu'),
  'probe:heading-levels:1.3.1': a('fix', 'the heading level', 'heading levels', 'structure', 'headings follow the page outline'),
  'probe:headings:1.3.1': a('fix', 'the empty heading', 'the empty headings', 'structure', 'every heading has a title'),
  'probe:aria-states:4.1.2': a('fix', 'the control state', 'control states', 'names', 'controls report their state correctly'),
  'probe:forced-colors:1.4.3': a('fix', 'text in contrast themes', 'text in contrast themes', 'contrast', 'text shows in Windows contrast themes'),
  'probe:forced-colors:1.4.11': a('fix', 'icons in contrast themes', 'icons in contrast themes', 'contrast', 'icons show in Windows contrast themes'),
  'probe:forced-colors:2.4.7': a('fix', 'focus in contrast themes', 'focus in contrast themes', 'focus', 'focus shows in Windows contrast themes'),
  'probe:overlays:1.4.10': a('shrink', 'the floating box', 'the floating boxes', 'layout', 'floating boxes don’t cover the page on phones'),
  'probe:keyboard:1.4.11': a('strengthen', 'the focus outline', 'focus outlines', 'contrast', 'focus outlines stand out'),
  'probe:keyboard-deep:1.4.11': a('strengthen', 'the focus outline', 'focus outlines', 'contrast', 'focus outlines stand out'),
  'third-party': a('fix', 'the embedded content', 'the embedded content', 'names', 'embedded content can be used with assistive technology'),
  'media:autoplay-sound-no-controls': a('stop', 'the sound', 'the sound', 'motion', 'no sound plays by itself'),
  'ai:altText:1.1.1': a('describe', 'the information in the picture', 'the information in pictures', 'pictures', 'information in pictures is in text too'),
});

/** How a group of fixes is named when a job has too many kinds to list. */
export const FAMILY_ACTS: Readonly<Record<Family, Act>> = Object.freeze({
  motion: a('stop', 'moving and flashing content', 'moving and flashing content', 'motion', 'nothing moves, flashes or plays sound without a way to stop it'),
  keyboard: a('fix', 'keyboard access', 'keyboard access', 'keyboard', 'everything works with a keyboard'),
  focus: a('fix', 'keyboard focus', 'keyboard focus', 'focus', 'keyboard focus is visible and moves in order'),
  form: a('fix', 'the form', 'the forms', 'form', 'forms can be filled in and their errors understood'),
  contrast: a('strengthen', 'faint colors', 'faint colors', 'contrast', 'text, fields and icons are easy to see'),
  layout: a('fix', 'zoom and spacing', 'zoom and spacing', 'layout', 'pages work zoomed in, with wider spacing and on phones'),
  pictures: a('describe', 'the pictures', 'the pictures', 'pictures', 'pictures have text versions'),
  media: a('add', 'captions and transcripts', 'captions and transcripts', 'media', 'videos and recordings have text versions'),
  links: a('fix', 'link text', 'link text', 'links', 'links say where they go'),
  structure: a('fix', 'the page structure', 'the page structure', 'structure', 'headings, lists and tables are marked up for screen readers'),
  names: a('repair', 'the controls', 'the controls', 'names', 'controls tell screen readers what they are'),
  settings: a('set', 'page titles and languages', 'page titles and languages', 'settings', 'pages have a title and a language'),
  touch: a('fix', 'touch controls', 'touch controls', 'touch', 'touch and mouse controls are easy to use'),
  consistency: a('keep', 'menus and help consistent', 'menus and help consistent', 'consistency', 'menus and help stay in the same place'),
  time: a('extend', 'time limits', 'time limits', 'time', 'people get enough time'),
});

/** What a document fix adds to a PDF, for "Re-export the 7 PDFs with tags, titles and a language". */
export const PDF_FEATURE: Readonly<Record<string, { with: string; outcome: string }>> = Object.freeze({
  tagged: { with: 'tags', outcome: 'headings, lists and tables are tagged' },
  hasTitle: { with: 'titles', outcome: 'each one shows its title' },
  showsTitle: { with: 'titles', outcome: 'each one shows its title' },
  hasLanguage: { with: 'a language', outcome: 'the language is set' },
  imageOnly: { with: 'real text', outcome: 'scanned pages become real text' },
  figuresWithoutAlt: { with: 'picture descriptions', outcome: 'pictures are described' },
  untitledFormFields: { with: 'named fields', outcome: 'form fields have names' },
  xfa: { with: 'an accessible form', outcome: 'the form works in any PDF reader' },
  blocksAssistiveTech: { with: 'reader access', outcome: 'screen readers are allowed to read the text' },
  ai: { with: 'corrected tags', outcome: 'the tags match the pages' },
});

/** What an Office file fix changes, for "Both files can be read with a screen reader: …". */
export const OFFICE_FEATURE: Readonly<Record<string, string>> = Object.freeze({
  password: 'they open without a password',
  alt: 'pictures are described',
  slideTitle: 'every slide has a title',
  language: 'the language is set',
  title: 'each one shows its title',
});
