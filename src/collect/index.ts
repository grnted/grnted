// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Page collectors: in-page data gathered during the audit. Engine core: no Node-only or AI imports.
import type { CDPSessionLike, CollectorError, PageAudit, PageCollector, PageLike, Viewport } from '../types.js';
import { consistencyCollector } from './consistency.js';
import { documentLinksCollector } from './documentLinks.js';
import { imagesCollector } from './images.js';
import { mediaCollector } from './media.js';
import { mediaEvidenceCollector } from './mediaEvidence.js';
import { pageTextCollector } from './pageText.js';
import { picturesCollector } from './pictures.js';
import { platformCollector } from './platform.js';
import { shapeCollector } from './shape.js';
import { visionCollector } from './vision.js';

export { imagesCollector } from './images.js';
export { picturesCollector, collectPictures, browserNamesOf, cropPlan, PICTURES_LIMITS, type PictureFact, type PicturesFacts, type PictureSource, type PictureTechnique, type ImageDocumentLink } from './pictures.js';
export { shapeCollector, pageShape } from './shape.js';
export { pageTextCollector, pageTextItemCount, toPageTextData, PAGE_TEXT_LIMITS, type PageTextData, type RawPageText } from './pageText.js';
export { visionCollector, VISION_LIMITS, VISION_SCREENSHOT_PAGES, type ColorOnlyLink, type IconCandidate, type OrderInversion, type VisionBlock, type VisionFacts } from './vision.js';
export { documentLinksCollector } from './documentLinks.js';
export { platformCollector, collectPlatformFacts, PLATFORM_PAGES, type PlatformFacts } from './platform.js';
export {
  consistencyCollector, collectConsistency, toConsistencyFacts, CONSISTENCY_LIMITS,
  type ConsistencyFacts, type ConsistencyHelp, type ConsistencyLink, type ConsistencyRegion, type ConsistencySearch, type Place,
} from './consistency.js';
export { mediaCollector, MEDIA_LIMITS, type MediaElementFact, type MediaFacts, type MediaFrameFact, type MediaLinkFact } from './media.js';
export {
  mediaEvidenceCollector, toMediaEvidence, MEDIA_EVIDENCE_LIMITS,
  type MediaContextLink, type MediaEvidence, type MediaEvidenceContext, type MediaEvidenceItem, type MediaEvidenceTrack, type MediaHiddenText,
} from './mediaEvidence.js';

/** Built-in collectors by id. A check asks for the ones it needs through `AiScanPlan.collectors`. */
export const COLLECTORS = {
  images: imagesCollector,
  pictures: picturesCollector,
  pageText: pageTextCollector,
  vision: visionCollector,
  documentLinks: documentLinksCollector,
  media: mediaCollector,
  // Batch 18, lane media: every recording with its context, for the closed AI media checks (AI plans only).
  mediaEvidence: mediaEvidenceCollector,
  shape: shapeCollector,
  consistency: consistencyCollector,
  platform: platformCollector,
} satisfies Record<string, PageCollector>;

/**
 * Collectors that run on every scan, even without AI. `documentLinks` feeds the document inventory,
 * `media` the video and audio inventory and `consistency` the cross-page rules (2.4.5, 3.2.3,
 * 3.2.4, 3.2.6), `platform` the "Built on" line and the platform guidance (first pages only).
 */
export const DEFAULT_COLLECTORS: readonly PageCollector[] = [documentLinksCollector, mediaCollector, consistencyCollector, platformCollector];

const DEFAULT_TIMEOUT_MS = 3000;

export function isCollectorError(value: unknown): value is CollectorError {
  return typeof value === 'object' && value !== null && 'error' in value && Object.keys(value).length === 1;
}

/** One entry per id, first one wins, so the same collector asked for twice runs once. */
export function uniqueCollectors(list: readonly PageCollector[]): PageCollector[] {
  const seen = new Set<string>();
  return list.filter((c) => !seen.has(c.id) && seen.add(c.id));
}

export function runsAt(c: PageCollector, viewport: Viewport['name']): boolean {
  return c.viewport === 'both' || c.viewport === viewport;
}

/** Runs one collector with a time box; never throws. */
export async function runCollector(
  c: PageCollector,
  page: PageLike,
  ctx: { url: string; viewport: Viewport['name']; index?: number; cdp?: () => Promise<CDPSessionLike> },
): Promise<unknown> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ms = c.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  try {
    return await Promise.race([
      c.collect(page, ctx),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Collector timed out after ${ms} ms`)), ms); }),
    ]);
  } catch (err) {
    return { error: err instanceof Error ? err.message.split('\n')[0]!.slice(0, 200) : 'Collector failed' } satisfies CollectorError;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The value a collector left on a page, or undefined when it did not run or failed. For a
 * collector with `viewport: 'both'`, pass the viewport you want.
 */
export function collectedValue<T>(page: PageAudit, c: PageCollector<T>, viewport?: Viewport['name']): T | undefined {
  let v = page.collected?.[c.id];
  if (c.viewport === 'both') {
    if (!viewport || typeof v !== 'object' || v === null) return undefined;
    v = (v as Partial<Record<Viewport['name'], unknown>>)[viewport];
  }
  return v === undefined || isCollectorError(v) ? undefined : (v as T);
}
