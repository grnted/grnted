// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
import type { PDFDocument, PDFPage } from 'pdf-lib';

export interface PageTagger {
  /** Wraps what `draw` paints (synchronously) in one marked-content sequence and structure element `tag`. */
  mark(tag: string, draw: () => void, attrs?: { alt?: string }): void;
  /** Wraps what `draw` paints in an /Artifact sequence: decoration that is not part of the structure. */
  artifact(draw: () => void): void;
}

export interface Tagger {
  page(page: PDFPage): PageTagger;
  finish(): void;
}

export declare function createTagger(doc: PDFDocument): Tagger;
