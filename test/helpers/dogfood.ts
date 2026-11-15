// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// How Granted's own dogfood tests scan a page of ours (the report, the prompts, the comparison view).
// `documents: false` (Paul, 2026-11-03): the report links the scanned site's PDFs and Office files,
// and those are the customer's documents, not part of the page under test, so the dogfood scan does
// not check them: the report is never charged for a customer site's untagged PDFs. This is a test
// setting only; a real scan checks the documents a page links as before.
export const DOGFOOD_SCAN = { maxPages: 1, documents: false } as const;
