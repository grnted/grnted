// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plain-English copy for every WCAG criterion a registry probe can fail (src/probes/registry.ts),
// worded for what the automated tests look for. Same voice and rules as the axe rule copy: who it
// stops and what happens to them, then the change. Changing any of it bumps COPY_VERSION.
import type { OwnerId, ProblemCopy } from '../model.js';
import { resizeTextSnippet, scrollPaddingSnippet } from './snippets.js';

const c = (title: string, who: string, fix: string, owner: OwnerId, snippet?: ProblemCopy['snippet']): ProblemCopy =>
  Object.freeze({ title, who, fix, owner, ...(snippet ? { snippet } : {}) });

export const CRITERION_COPY: Readonly<Record<string, ProblemCopy>> = Object.freeze({
  // The cross-page checks (src/consistency/): what differs between pages, so the card is never generic.
  '2.4.5': c(
    'Some pages can only be reached through the menu',
    "People who can't use the menu easily, and people who look for a page by what it is rather than where it sits, have no other way to find these pages.",
    'Add a site search, or a site map page linked from every page, so each page can be found more than one way.',
    'developer',
  ),
  '3.2.3': c(
    'The menu changes order from page to page',
    'People who use screen readers, and people with memory or attention difficulties, learn where links are and lose their way when the order changes.',
    'Keep menus, headers and footers in the same order on every page, by building them from one shared template.',
    'developer',
  ),
  '3.2.4': c(
    'The same link or button has different names on different pages',
    "People who use screen readers or voice control look for a link or button by its name, and don't find it when the name changes.",
    'Give links, buttons and icons that do the same job the same name on every page.',
    'developer',
  ),
  '3.2.6': c(
    'Help is in a different place on some pages',
    'People who need help to finish a task look for it where they found it before, and give up when it has moved.',
    'Put contact details, chat and other help in the same place, in the same order, on every page that has them.',
    'developer',
  ),
  // Names that are no names (the names probe): a file name or placeholder text as alt.
  '1.1.1': c(
    'Images are described by a file name or the word “image”',
    "People who use screen readers hear “IMG 2041 dot JPG” or just “image”, and learn nothing about what the picture shows.",
    'Write alt text that says what each picture shows or does, in a few words; give a picture that is only decoration an empty alt (alt="").',
    'content',
  ),
  // Pictures of text (the picture-text test): an SVG picture that is a block of words and nothing else.
  '1.4.5': c(
    'Notices and flyers are pictures of words',
    'People who zoom in, change colors or spacing, or use a screen reader lose the words in a picture of text: a picture cannot be restyled, and it is read out only as its alt text.',
    'Publish the words as real text on the page, and keep the picture only as an illustration.',
    'content',
  ),
  '1.2.1': c(
    'Audio or silent video has no text version',
    "People who are deaf can't hear an audio recording, and people who are blind can't see a video with no sound.",
    'Put a transcript next to each audio recording, and a text description or narration with each video that has no sound.',
    'content',
  ),
  '1.2.2': c(
    'Videos have no captions',
    'People who are deaf or hard of hearing miss everything that is said.',
    'Turn on captions in the video player or on the video host, written or reviewed by the uploader rather than generated automatically.',
    'content',
  ),
  '1.2.3': c(
    "Videos don't describe what is shown on screen",
    'People who are blind miss what appears only on screen, such as names, text and actions.',
    'Add audio description (narration of what is shown), or a full text version of the video next to it.',
    'content',
  ),
  '1.2.4': c(
    'Live video has no captions',
    "People who are deaf or hard of hearing can't follow live meetings and events.",
    "Turn on live captions for each live stream, from a captioner or the platform's live captioning.",
    'content',
  ),
  '1.2.5': c(
    'Videos have no audio description',
    'People who are blind miss what is shown on screen but never said.',
    'Publish an audio-described version, or narrate the important visual details in the video itself.',
    'content',
  ),
  // Heading structure (the headings probe): section titles shown without heading markup, empty headings, paragraphs marked up as headings.
  '1.3.1': c(
    'Some headings are missing, empty or really paragraphs',
    'People who use screen readers move through a page by its headings. A section title that only looks like a heading is not in their list, an empty heading is announced with nothing after it, and a paragraph marked up as a heading fills the list with text that names no section.',
    'Mark up each section title as a heading (h2 to h6), put the title in every heading or remove the empty one, and mark up paragraphs as paragraphs, changing how text looks with styles instead.',
    'content',
  ),
  '1.3.2': c(
    'Screen readers read the content in another order than it is shown',
    'People who use screen readers hear the content in the order of the code. When the layout moves it around, steps and sections come out of sequence for them.',
    'Put the content in the code in the order it is meant to be read, instead of reordering it with CSS (order, grid placement, reversed directions).',
    'developer',
  ),
  '1.3.4': c(
    "The page doesn't work when the screen is turned",
    "People with a tablet or phone mounted on a wheelchair or stand can't turn it, so content that only works one way up is lost to them.",
    "Let the layout adapt to both portrait and landscape, and don't hide or rotate content based on orientation.",
    'developer',
  ),
  '1.3.5': c(
    "Fields asking for personal details don't say what they ask for",
    'People with memory or motor disabilities rely on autofill for their name, email and address. Without the right autocomplete value, they must type it all out.',
    'Add the matching autocomplete value to each field that asks about the person, such as autocomplete="email" or autocomplete="tel".',
    'developer',
  ),
  '1.4.1': c(
    'Links can be told apart from text only by color',
    "People who are color blind or have low vision can't find the links in the text.",
    "Underline links in body text, or add another visual cue that doesn't rely on color.",
    'developer',
  ),
  '1.4.2': c(
    'Sound starts on its own and keeps playing',
    "People who use screen readers can't hear their reader over the sound.",
    "Don't start sound automatically. If it must play, stop it within 3 seconds or put a pause or mute button at the top of the page.",
    'developer',
  ),
  // Batch 19: the general 1.4.3 copy, for failures of several kinds (or a report from before kinds); one kind gets
  // its own (KIND_CRITERION_COPY).
  '1.4.3': c(
    'Some text is hard to read against what is behind it',
    "People with low vision can't read text that doesn't stand out from what is behind it.",
    'Change the text or background colors so text contrasts at least 4.5 to 1 with what is behind it (3 to 1 for large text): at rest, when the pointer is on it or it has keyboard focus, and over pictures.',
    'developer',
  ),
  '1.4.4': c(
    "Text doesn't get bigger when the page is zoomed",
    'People with low vision zoom the browser to 200% to read, and text sized to the window width stays small.',
    'Size text in rem with a clamp() so it grows with zoom, instead of window-width units alone.',
    'developer',
    resizeTextSnippet,
  ),
  '1.4.10': c(
    'Pages need sideways scrolling on narrow screens',
    'People who zoom in to read, and people on phones, have to scroll left and right on every line.',
    'Let content wrap at 320 pixels wide: remove fixed widths, and let wide items such as tables scroll inside their own box.',
    'developer',
  ),
  '1.4.11': c(
    'Buttons, fields and focus outlines are too faint',
    "People with low vision can't see where a field or button is, or where keyboard focus is.",
    'Make borders, icons and focus outlines contrast at least 3 to 1 with the colors next to them.',
    'developer',
  ),
  '1.4.12': c(
    'Text overlaps or is cut off when spacing is increased',
    'People with dyslexia or low vision who widen line and letter spacing lose words that overlap or are clipped.',
    'Let boxes grow with their text: avoid fixed heights and hidden overflow on elements that hold text.',
    'developer',
  ),
  '1.4.13': c(
    'Pop-up content on hover is hard to keep open or close',
    "People who zoom in or use a magnifier can't move the pointer onto a tooltip or menu without it vanishing, and people who use a keyboard can't close it.",
    'Keep content that appears on hover or focus open while the pointer is over it, and let Escape close it.',
    'developer',
  ),
  '2.1.1': c(
    "Some controls can't be used with a keyboard",
    "People who can't use a mouse, including many screen reader users, can't reach or press them.",
    'Use real links and buttons, or give custom controls tabindex="0" and handlers for the Enter and Space keys.',
    'developer',
  ),
  '2.1.2': c(
    'Keyboard focus gets stuck',
    "People who use a keyboard are trapped in part of the page and can't Tab out to the rest.",
    'Make sure Tab and Shift+Tab can always move focus out of every widget, frame and dialog.',
    'developer',
  ),
  '2.1.4': c(
    'Single-key shortcuts go off by accident',
    'People who use voice control or type slowly set off shortcuts when a spoken word or a stray key press matches a letter.',
    'Let people turn single-key shortcuts off or change them, or make them work only while the control has focus.',
    'developer',
  ),
  '2.2.1': c(
    'Pages time out or change before people are done',
    'People who read, type or move slowly lose their work or their place when a timer runs out.',
    'Let people turn off, adjust or extend each time limit, and warn them before it ends.',
    'developer',
  ),
  '2.2.2': c(
    "Moving content can't be paused",
    "People with attention or reading disabilities can't focus on the page while a slider, ticker or animation keeps moving.",
    'Add a visible pause button to anything that moves, scrolls or updates by itself for more than 5 seconds.',
    'developer',
  ),
  '2.3.1': c(
    'Content flashes in a way that can trigger seizures',
    'People with photosensitive epilepsy can have a seizure when something flashes more than three times in one second.',
    'Remove the flashing, or slow it to no more than three flashes in any one second.',
    'content',
  ),
  '2.4.1': c(
    "Keyboard users can't jump past the menu",
    'People who use a keyboard must Tab through every menu link on every page before they reach the content.',
    'Add a working "Skip to main content" link as the first thing on the page, pointing at the start of the content.',
    'developer',
  ),
  // Page titles (the page-titles and route-titles tests): a title that names no page, or another page.
  '2.4.2': c(
    "Page titles don't say which page it is",
    'People who use screen readers hear the page title first, and everyone uses it to find the right browser tab or bookmark. A title that says “Home” or “Untitled”, or names another page, sends them to the wrong place.',
    'Give every page its own title that names the page and then the site, and change the title whenever the site shows another page without loading it.',
    'content',
  ),
  '2.4.3': c(
    'Keyboard focus jumps around in a confusing order',
    "People who use a keyboard or screen reader lose their place when focus moves in an order that doesn't match the page.",
    'Put the HTML in the same order as the page reads, and remove positive tabindex values.',
    'developer',
  ),
  // Link purpose (the link-purpose probe): generic link names with nothing around them that says where they go.
  '2.4.4': c(
    "Links like “Read more” don't say where they go",
    "People who use screen readers often move through a page's links on their own. A row of “Read more” and “Click here” links tells them nothing about where each one goes.",
    'Name each link for where it goes, such as “Read more about the spring concert”, or put it in a sentence or under a heading that says what it is about.',
    'content',
  ),
  // Heading structure (the headings probe): the same main heading on nearly every page, and placeholder headings.
  '2.4.6': c(
    "Headings don't say what their page or section is about",
    "People who use screen readers jump between headings to learn where they are. A main heading that is the same on every page, often the site's name, or a heading left as template placeholder text such as “Lorem ipsum” or “Your heading here”, tells them nothing.",
    "Give each page a level-1 heading with that page's own title (show the site name as a logo or link instead), and replace placeholder headings with the section's real title.",
    'content',
  ),
  '2.4.7': c(
    'Keyboard focus is invisible on some links and buttons',
    "People who use a keyboard can't tell which link or button they are on.",
    'Show a clear focus outline on every link, button and field, for example with :focus-visible { outline: 2px solid; }, and never remove it.',
    'developer',
  ),
  '2.4.11': c(
    'Keyboard focus hides under the fixed header',
    "People who use a keyboard can't see the link or button they have moved to, because a sticky header or banner covers it.",
    "Add scroll padding equal to the header's height, so the browser scrolls focused items clear of it.",
    'developer',
    scrollPaddingSnippet,
  ),
  '2.5.1': c(
    'Some controls need a swipe or a multi-finger gesture',
    "People who use a head pointer, a mouth stick or one finger can't make swipes or pinches.",
    'Give every gesture a simple alternative, such as next and previous buttons on a carousel.',
    'developer',
  ),
  // Label in name (the names probe): a field's name for assistive technology leaves out its visible label.
  '2.5.3': c(
    "Fields are named differently from the label people see",
    "People who use speech input say the label they see on screen to reach a field. When the field's hidden name uses other words, the command is not understood.",
    "Remove the aria-label (the visible label already names the field), or start the hidden name with the visible label's exact words.",
    'developer',
  ),
  '2.5.2': c(
    'Actions start the moment a finger or mouse button goes down',
    "People with tremors or limited hand control set off actions by accident and can't slide away to cancel.",
    'Run the action when the pointer is released (the click event), not on mousedown, pointerdown or touchstart.',
    'developer',
  ),
  '2.5.4': c(
    'Shaking or tilting the device sets off actions',
    "People with a device mounted on a wheelchair, or with tremors, can't use the feature or set it off by accident.",
    'Give every motion-triggered action an on-screen button, and let people turn the motion trigger off.',
    'developer',
  ),
  '2.5.7': c(
    'Some controls only work by dragging',
    "People who can't hold a button down while moving, or who use a head pointer, can't use sliders, sortable lists or maps that need dragging.",
    'Add a click or tap alternative to every drag, such as arrow buttons or a number field next to a slider.',
    'developer',
  ),
  // Language of page (the language-parts probe): the page's text is in another language than its lang says.
  '3.1.1': c(
    "The page says it is in one language but is written in another",
    'People who use screen readers hear the whole page read with the wrong pronunciation, which can make it impossible to understand. Translation tools and braille displays are misled too.',
    'Set the lang attribute of the page (<html lang="…">) to the language the page is written in, for example lang="es" on a page in Spanish.',
    'developer',
  ),
  // Language of parts (the language-parts probe): a passage in another language with no lang of its own.
  '3.1.2': c(
    'Text in another language is not marked as that language',
    'People who use screen readers hear a passage in another language read with the wrong pronunciation, which can make it impossible to understand.',
    'Put a lang attribute with the passage\'s language on the element around it, for example <p lang="es"> for Spanish.',
    'content',
  ),
  '3.2.1': c(
    'Moving keyboard focus changes the page unexpectedly',
    'People who use a keyboard or screen reader are sent to another page, or see a pop-up open, just by tabbing onto a control.',
    'Change the page only when people press or click something, never when a control merely gets focus.',
    'developer',
  ),
  '3.2.2': c(
    'Choosing an option changes the page without warning',
    'People who use screen readers or keyboards are taken somewhere new while they are still choosing.',
    'Add a button to confirm the choice instead of acting as soon as a field or drop-down changes, or say beforehand what will happen.',
    'developer',
  ),
  '3.3.1': c(
    "Form errors aren't shown or described in text",
    "People who use screen readers or are color blind send a form and aren't told what went wrong or where.",
    'Show each error as text next to its field, mark the field with aria-invalid="true", and connect the message with aria-describedby.',
    'developer',
  ),
  '3.3.2': c(
    'Form fields have no visible label or instructions',
    "People with memory or thinking disabilities, and anyone once the placeholder text disappears, can't tell what to enter.",
    'Give each field a visible label that stays on screen while people type, instead of placeholder text.',
    'developer',
  ),
  '3.3.3': c(
    "Form errors don't say how to correct them",
    'People with thinking or learning disabilities, and people who use screen readers, are told something is wrong but not what to do.',
    'Make each error message say how to correct the entry, for example "Enter the date as month, day and year".',
    'developer',
  ),
  '3.3.4': c(
    "Important submissions can't be reviewed or undone",
    "People who make mistakes more easily, such as people with thinking or motor disabilities, can't correct an error before a payment or legal submission goes through.",
    'Let people review and confirm their answers before sending, or undo the submission afterwards.',
    'developer',
  ),
  '3.3.7': c(
    'Forms ask for the same information twice',
    'People with memory or motor disabilities must enter again what they already gave.',
    'Fill in information the person already entered in the same process, or let them pick it from a list.',
    'developer',
  ),
  '3.3.8': c(
    'Sign-in blocks pasting or password managers',
    'People with memory or thinking disabilities rely on password managers and pasting. Blocking them, or asking for a puzzle, locks them out.',
    'Allow pasting and autofill in sign-in fields, and offer a way to sign in without solving a puzzle or remembering a code.',
    'developer',
  ),
  // ARIA states and roles (the aria-states probe): a state that contradicts what the page shows, and a control made of a plain element with no role.
  '4.1.2': c(
    'Controls announce the wrong state, or are not announced as controls',
    "People who use screen readers hear that a menu is open when it is closed, or that two tabs are selected at once, so they can't tell what is on the screen. A button made of a plain element is read as text, with nothing to say it can be pressed.",
    'Keep aria-expanded, aria-pressed, aria-selected and aria-checked in step with what the page shows, let the HTML say required, disabled and checked on its own, and build controls from button and link elements (or give a custom one a role, a tab stop and key handling).',
    'developer',
  ),
  '4.1.3': c(
    "Status messages aren't announced to screen readers",
    "People who use screen readers aren't told when a form is sent, results update or an error appears.",
    'Put status messages in an element with role="status" (or role="alert" for errors) that is on the page before the message appears.',
    'developer',
  ),
});

/**
 * Copy for a criterion as one probe finds it, when that probe's failures read differently from the
 * criterion's usual problem, keyed `<probe id>:<criterion>`. The report uses it when that probe is
 * the only one that failed the criterion (src/report/problems.ts).
 */
export const PROBE_CRITERION_COPY: Readonly<Record<string, ProblemCopy>> = Object.freeze({
  // Words only a picture shows (the picture-text test): the picture draws words its alt text and the page's text leave out.
  'picture-text:1.1.1': c(
    'Pictures show words the page gives nowhere else',
    'People who use screen readers get a picture’s alt text and the text around it. Dates, places and instructions that only the picture shows never reach them.',
    'Put the picture’s words in its alt text, or as real text next to it; a picture that only repeats nearby text can keep an empty alt.',
    'content',
  ),
  'forced-colors:1.4.11': c(
    'Icons and controls disappear in Windows contrast themes',
    'People who use a contrast theme (Windows High Contrast) can\'t see some icons, checkboxes or fields: the theme turns their colors into the background\'s, so nothing of them shows.',
    'Draw icons with currentColor (fill="currentColor" or a mask with background: currentColor), give custom controls a real border, or use forced-color-adjust: none only where the colors themselves carry meaning.',
    'developer',
  ),
  'forced-colors:2.4.7': c(
    'Keyboard focus disappears in Windows contrast themes',
    'People who use a contrast theme (Windows High Contrast) and a keyboard can\'t tell which link or button they are on: the focus ring is drawn with a shadow or a color change, which the theme removes. In normal colors it shows.',
    'Keep an outline on focus and make it transparent when you draw the ring another way, for example :focus-visible { outline: 2px solid transparent; box-shadow: 0 0 0 3px #b3006b; }. Contrast themes give the outline a visible color.',
    'developer',
  ),
  'form-fields:1.3.1': c(
    'Field labels are shown but not tied to their fields',
    'People who use screen readers or voice control reach a field and hear no name for it, although its label is on the screen next to it.',
    'Tie each visible label to its field: wrap the field in the <label>, or give the label a for attribute that matches the field\'s id.',
    'developer',
  ),
  'screen-reader:1.3.1': c(
    'Screen readers miss how the page is organized',
    'People who use screen readers hear tables without the structure everyone else sees, read cell by cell with nothing to say which row or column a value belongs to, and empty headings announced with nothing after them.',
    'Mark the header row and column of each data table with th elements, and put the section title in each heading or remove the empty heading element.',
    'developer',
  ),
  'screen-reader:2.4.4': c(
    'Links with no name in the screen reader links list',
    'People who use screen readers often list a page\'s links to find one. A link with no name shows up as an empty entry, with nothing to say where it goes.',
    'Give every link text, or an aria-label when it shows only an icon.',
    'developer',
  ),
  'screen-reader:4.1.2': c(
    'Screen readers announce controls with no name',
    'People who use screen readers hear only “button” or “link”, with nothing to say what it does.',
    'Give every button, link and field a name: visible text, or an aria-label when it shows only an icon.',
    'developer',
  ),
  'overlays:1.4.10': c(
    'Floating buttons or banners cover the page on phones and when zoomed',
    "People on phones, and people who zoom in to read, can't see or tap the links and text hidden under widgets that stay on screen, such as translate buttons, chat bubbles and promotions.",
    'Keep floating widgets small and away from links and text, let people close or collapse them, and leave room at the edges so every link can be scrolled clear of them.',
    'developer',
  ),
  'overlays:2.4.11': c(
    'Keyboard focus hides under floating widgets on small screens',
    "People who use a keyboard with zoom or on a small screen can't see the link or button they have moved to, because a widget or bar that stays on screen covers it.",
    "Add scroll padding equal to the height of fixed bars, and keep floating widgets small or let people close them, so focused items always scroll clear.",
    'developer',
    scrollPaddingSnippet,
  ),
});

/**
 * Batch 19 (first-run feedback): copy for a criterion when every failure is of one kind of evidence (the finding's
 * `data.kind`), keyed `<criterion>:<kind>`. 1.4.3's kinds: text over a picture, gradient or overlapping content
 * ('backdrop'), a hover or focus state ('state'), placeholder text ('placeholder'), text shown later or in an opened
 * menu, panel or dialog ('shown'), the dark colour scheme ('dark') and text in its own colours ('plain').
 */
export const KIND_CRITERION_COPY: Readonly<Record<string, ProblemCopy>> = Object.freeze({
  '1.4.3:backdrop': c(
    'Text over images or patterned backgrounds is hard to read',
    "People with low vision can't read text that doesn't stand out from what is behind it.",
    'Put a solid or darkened backing behind the text, or change its color, so the contrast is at least 4.5 to 1.',
    'developer',
  ),
  '1.4.3:state': c(
    'Text is hard to read when the pointer is on it or it has keyboard focus',
    'People with low vision, and people who use a keyboard, lose a link or button the moment they reach it: its text and background colors become too close.',
    'Change the colors the :hover, :focus and :focus-visible styles set, so the text contrasts at least 4.5 to 1 with its background in those states too (3 to 1 for large text).',
    'developer',
  ),
  '1.4.3:placeholder': c(
    'Placeholder text in form fields is too faint',
    "People with low vision can't read the example or hint written inside an empty field.",
    'Darken the placeholder color (the ::placeholder style) so it contrasts at least 4.5 to 1 with the field, and keep the field\'s label outside it.',
    'developer',
  ),
  '1.4.3:shown': c(
    'Text in menus, panels and messages that open later is hard to read',
    "People with low vision can't read text that appears after the page loads or when a menu, panel or dialog opens.",
    'Change the colors of the menus, panels, dialogs and messages so their text contrasts at least 4.5 to 1 with their background (3 to 1 for large text).',
    'developer',
  ),
  '1.4.3:dark': c(
    'Text is hard to read in dark mode',
    "People who set their device to dark mode, many of them because bright screens hurt, get text that doesn't stand out from the dark background.",
    'Change the colors the site sets for dark mode (its prefers-color-scheme: dark styles) so text contrasts at least 4.5 to 1 with its background there too.',
    'developer',
  ),
  '1.4.3:plain': c(
    'Some text is too faint to read',
    "People with low vision can't read text whose color is too close to its background.",
    'Change the text or background color so the contrast is at least 4.5 to 1 (3 to 1 for large text).',
    'developer',
  ),
});

export const GENERIC_CRITERION_COPY: ProblemCopy = c(
  'An automated test found a barrier on these pages',
  'People who use assistive technology, or who see, hear or move differently, meet a barrier in this part of the page.',
  "Follow the test's details in the full results, then scan the site again.",
  'developer',
);
