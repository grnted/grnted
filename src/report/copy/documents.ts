// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Plain-English copy for the documents problem: checked PDFs that are untagged, untitled, have no
// language set, or are scanned images, and (scoring v10) those with a problem the AI document review
// confirmed; and the Office problem (Word, Excel and PowerPoint files the quick checks found problems in).
// Changing it bumps COPY_VERSION.
import type { ProblemCopy } from '../model.js';

export const DOCUMENTS_COPY: ProblemCopy = Object.freeze({
  title: "Some PDFs can't be read well with a screen reader",
  who: 'People who use screen readers hear untagged PDFs as jumbled text, and scanned pages as nothing at all. Without a title and language they hear a file name, in the wrong voice; with wrong tags they hear headings, figures and form fields that do not match the page.',
  fix: 'Export each PDF from its source file as a tagged PDF with a title and language set, check its headings, reading order, figure descriptions and field names, and run text recognition (OCR) on scanned ones. Or publish the content as a web page instead.',
  owner: 'documents',
});

export const OFFICE_COPY: ProblemCopy = Object.freeze({
  title: 'Some Office files are hard to use with a screen reader',
  who: 'People who use screen readers hear a picture with no alt text as nothing, a table without a header row as loose cells and a slide without a title as unnamed. Without a title and language they hear a file name, in the wrong voice.',
  fix: 'Run Check Accessibility (on the Review tab) in each file, fix what it lists, set a title and language, and publish the file again. Or publish the content as a web page instead.',
  owner: 'documents',
});
