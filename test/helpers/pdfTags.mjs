// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Tagging for synthetic PDFs built with pdf-lib (dev dependency only): each tagged element is one
// marked-content sequence (BDC with an MCID ... EMC) with its own structure element under a single
// Document element, plus the ParentTree, /StructParents and MarkInfo that pdf.js needs to read the
// tags. Plain JavaScript so both the tests (`structuredPdf` in pdfs.ts) and the document eval
// golden set (eval/golden/document/make.mjs, run by plain Node) use the same code.
import { PDFBool, PDFName, PDFNumber, PDFOperator, PDFOperatorNames, PDFString } from 'pdf-lib';

/**
 * Starts the structure tree of `doc`. Call `page(p)` once per page, in page order, then `mark` for
 * each element in tag order, and `finish()` once before `doc.save()`.
 */
export function createTagger(doc) {
  const ctx = doc.context;
  const root = ctx.nextRef();
  const document = ctx.nextRef();
  const kids = [];
  const nums = [];
  let pages = 0;
  return {
    page(page) {
      const index = pages++;
      const onPage = [];
      let mcid = 0;
      page.node.set(PDFName.of('StructParents'), PDFNumber.of(index));
      nums.push(index, onPage);
      return {
        /** Wraps what `draw` paints (synchronously) in one marked-content sequence and structure element `tag`. */
        mark(tag, draw, attrs = {}) {
          const id = mcid++;
          // BDC takes a property dictionary; pdf-lib's operator argument type leaves dictionaries out.
          page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, [PDFName.of(tag), ctx.obj({ MCID: id })]));
          draw();
          page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
          const ref = ctx.nextRef();
          ctx.assign(ref, ctx.obj({
            Type: 'StructElem', S: tag, P: document, Pg: page.ref, K: id,
            ...(attrs.alt !== undefined ? { Alt: PDFString.of(attrs.alt) } : {}),
          }));
          onPage.push(ref);
          kids.push(ref);
        },
        /** Wraps what `draw` paints in an /Artifact sequence: decoration that is not part of the structure. */
        artifact(draw) {
          page.pushOperators(PDFOperator.of(PDFOperatorNames.BeginMarkedContent, [PDFName.of('Artifact')]));
          draw();
          page.pushOperators(PDFOperator.of(PDFOperatorNames.EndMarkedContent));
        },
      };
    },
    finish() {
      ctx.assign(document, ctx.obj({ Type: 'StructElem', S: 'Document', P: root, K: kids }));
      ctx.assign(root, ctx.obj({ Type: 'StructTreeRoot', K: document, ParentTree: ctx.obj({ Nums: nums }), ParentTreeNextKey: pages }));
      doc.catalog.set(PDFName.of('StructTreeRoot'), root);
      doc.catalog.set(PDFName.of('MarkInfo'), ctx.obj({ Marked: PDFBool.True }));
    },
  };
}
