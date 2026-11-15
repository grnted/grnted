// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plain-English copy for the AI-reviewed image checks that count toward the score (scoring v5): one
// entry per scored criterion. Same voice and rules as the rest of the library. Changing any of it bumps
// COPY_VERSION.
import type { OwnerId, ProblemCopy } from '../model.js';

const c = (title: string, who: string, fix: string, owner: OwnerId = 'content'): ProblemCopy => Object.freeze({ title, who, fix, owner });

export const AI_COPY: Readonly<Record<'1.1.1' | '1.4.5', ProblemCopy>> = Object.freeze({
  '1.1.1': c(
    'Information shown only in a picture',
    'People who are blind or use a screen reader miss the dates, times, places and numbers that only the picture shows.',
    'Put that information in the image’s alt text, or as real text next to the picture.',
  ),
  '1.4.5': c(
    'Pictures of text',
    'People who zoom in, change colors or use a screen reader lose most of the words in a picture of text.',
    'Publish the words as real text on the page, and keep the picture only as an illustration.',
  ),
});

/**
 * Scoring v9: copy for the gated AI checks' criteria, keyed `<check>:<criterion>`, worded for what the
 * AI review confirms (a criterion's own copy is worded for the automated tests: "Embedded videos have no
 * captions" is wrong for captions that are there but wrong). A pair not listed uses the criterion's copy.
 */
export const AI_CHECK_COPY: Readonly<Record<string, ProblemCopy>> = Object.freeze({
  'pageText:2.4.2': c(
    "Page titles don't say what the page is",
    'People who use screen readers hear the title first, and everyone sees it in tabs and bookmarks. A title like “Home” or “Untitled” tells them nothing.',
    'Give each page a title that names its own topic, then the site, such as “Library hours - Riverside Library”.',
  ),
  'vision:1.4.1': c(
    'Meaning is shown by color alone',
    'People who are color-blind or have low vision miss what a color says, such as which item is selected or which message is an error.',
    'Add words, an icon or a pattern that says the same thing as the color.',
    'developer',
  ),
  'vision:1.3.2': c(
    'The order on screen and the order in the code tell different stories',
    'People who use screen readers hear the content in the code’s order, so a layout that rearranges it changes what it means for them.',
    'Put the content in the HTML in the order it is meant to be read, and lay it out with CSS.',
    'developer',
  ),
  'vision:1.1.1': c(
    'Information shown only in a background picture or icon',
    'People who are blind or use a screen reader miss what a background picture or an icon shows, because it has no text they can hear.',
    'Put that information in text on the page, or give the picture or icon a text alternative.',
  ),
  'vision:4.1.2': c(
    "Icon buttons don't say what they do",
    'People who use screen readers or voice control hear a button with no useful name, so they can’t tell what it does or say it to press it.',
    'Give each icon button a name that says what it does, such as aria-label="Search".',
    'developer',
  ),
  'pageText:2.4.4': c(
    'Link text leaves out what the link is about',
    'People who use screen readers often hear a page’s links on their own, and a name like “Notice (PDF)” or “Details” does not tell them which one they need.',
    'Name each link for its own topic, such as “Notice about the new bus routes (PDF)”.',
  ),
  'pageText:2.4.6': c(
    "Headings don't say what their section is about",
    'People who use screen readers move from heading to heading to find their way. A heading like “Section 1”, or one that names another topic, sends them to the wrong place.',
    'Reword each heading so it names what the section below it covers.',
  ),
  'pageText:3.3.2': c(
    "Form fields don't say what to enter or in what format",
    'People with memory or thinking disabilities, and anyone once the placeholder text disappears, have to guess what a field wants and in what format.',
    'Give each field a visible label, and state the format a field needs next to it, such as “Date of birth (MM/DD/YYYY)”.',
  ),
  'pageText:1.3.3': c(
    'Instructions rely on color, shape, position or sound',
    'People who are blind, color-blind or deaf can’t follow an instruction like “click the green button on the right” or “wait for the tone”.',
    'Name the thing in words as well, such as “select the green Renew button”.',
  ),
  'pageText:3.1.2': c(
    'Passages in another language are not marked',
    'People who use screen readers hear the passage read with the page’s own language rules, so the words come out garbled.',
    'Mark each passage with its language, for example <p lang="es"> for a paragraph in Spanish.',
    'developer',
  ),
  'pageText:1.3.1': c(
    "Text looks like a heading or a list but isn't marked as one",
    'People who use screen readers can’t jump to a heading or hear how many items a list has when the text is only styled to look that way.',
    'Mark headings with heading tags (h2, h3) and lists with ul or ol, then style them as you like.',
    'developer',
  ),
  'forms:3.3.4': c(
    'Payments and other commitments have no step to check or undo them',
    'People with memory or thinking disabilities, and anyone who mistypes, send a payment or a legal or financial commitment with a mistake they had no chance to catch.',
    'Add a step to review and correct the details before sending, or a way to cancel or undo the submission.',
    'developer',
  ),
  'forms:1.3.5': c(
    "Personal-detail fields don't say what they ask for to the browser",
    'People with memory or motor disabilities rely on the browser to fill in their name, address or card details, and a field with no purpose or the wrong one gets nothing or the wrong value.',
    'Give each personal-detail field the autocomplete value that matches what it asks for, such as autocomplete="bday" for a date of birth.',
    'developer',
  ),
  'forms:3.3.3': c(
    "Error messages don't say how to fix the mistake",
    'People with memory or thinking disabilities, and anyone using a screen reader, can’t correct a form when an error message only says that something is wrong.',
    'Make each error message say what is wrong and how to fix it, such as “Enter the date as MM/DD/YYYY”.',
  ),
  'consistency:3.2.4': c(
    'One link or button has different names on different pages',
    'People who use screen readers or voice control, and people with memory or thinking disabilities, don’t recognize it as the same thing when its name changes from page to page.',
    'Use one name for it on every page.',
    'developer',
  ),
  'media:1.2.1': c(
    "Captions of audio recordings don't match what is said",
    'People who are deaf read wrong names, numbers or dates, or miss part of what is said.',
    'Correct the captions or transcript so they give every word that is said.',
  ),
  'media:1.2.2': c(
    "Video captions don't match what is said",
    'People who are deaf or hard of hearing read wrong names, numbers or times, or miss part of what is said.',
    'Correct the captions so they give everything that is said, with the right names, numbers and times.',
  ),
  'media:1.2.3': c(
    'Videos show information that nobody says',
    'People who are blind miss on-screen text, such as phone numbers and dates, that the narration never gives.',
    'Say that information out loud in the video, or publish a version with audio description.',
  ),
  'focusOrder:2.4.3': c(
    'The Tab key reaches fields, steps or buttons out of order',
    'People who use a keyboard or screen reader meet a form’s fields, a process’s steps or a group’s buttons in the wrong order, so they act before they reach what comes first.',
    'Move these elements in the HTML into the order people read and use them, and position them with CSS.',
    'developer',
  ),
  'listener:1.3.2': c(
    'Screen readers read the page in an order that changes its meaning',
    'People who use screen readers hear content in an order that changes what it means, or hear text that the page does not show.',
    'Put the content in the HTML in the order it is read on screen, and remove hidden text that contradicts what is shown.',
    'developer',
  ),
  'listener:1.1.1': c(
    'Pictures whose information a screen reader never reads out',
    'People who are blind never hear what a picture shows, such as a date, a phone number or the point of a chart.',
    'Give the picture alt text that says what it shows, or put that information in text next to it.',
  ),
  'listener:1.3.1': c(
    'Headings, lists or tables that screen readers read as plain text',
    'People who use screen readers can’t jump to a heading or tell how a list or table is organized when it is read as plain text.',
    'Mark headings, lists and tables with their HTML elements, then style them as you like.',
    'developer',
  ),
  'listener:4.1.2': c(
    'Controls that screen readers announce as the wrong thing or state',
    'People who use screen readers hear a button as plain text, or a switch as off when it is on, so they can’t tell what a control does or whether it worked.',
    'Use the native HTML control (button, checkbox, link), or give the control the right role and state and keep the state up to date.',
    'developer',
  ),
  'listener:2.4.4': c(
    "Links that don't say where they go when read out",
    'People who use screen readers often list a page’s links on their own, and “Click here” or “More” tells them nothing.',
    'Reword each link so its text names where it goes, such as “Library hours” instead of “Click here”.',
  ),
  'listener:2.4.6': c(
    "Headings and labels that don't say what they are for when read out",
    'People who use screen readers move from heading to heading and field to field, and a vague heading or label sends them to the wrong place.',
    'Reword each heading and label so it names its section, or what the field asks for.',
  ),
  'listener:4.1.3': c(
    'Messages after an action that screen readers announce badly',
    'People who use screen readers hear nothing, the wrong message or a confusing one after they send a form or open a menu, so they don’t know what happened.',
    'Announce each status and error message in a live region, with words that say what happened.',
    'developer',
  ),
});
