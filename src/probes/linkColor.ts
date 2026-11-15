// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// WCAG 1.4.1 Use of color (Plan 4 Task 4.3): links in running text told apart from the text around
// them only by a colour too close to it, with no other cue when pointed at or focused. Finds the
// links with the vision collector's rules (`findColorOnlyLinks`), then hovers and focuses each one.
// Engine core: no Node-only imports.
import { findColorOnlyLinks, type FoundColorOnlyLink } from '../collect/vision.js';
import { elementKeys, roleElement, textElement } from '../aiDedupe.js';
import type { ProbeFinding } from '../types.js';
import { contrastRatio, hex, ratioText } from './pixels.js';
import { COLOR_KEY_LIMITS, colorKeyFindings, findColorKeys } from './colorKey.js';
import { cleanText, pageWords, shootElements } from './evidence.js';
import { guarded } from './textContrast.js';
import { ProbeNotTestable, type PageProbe, type ProbeContext } from './types.js';
import { COLOR_STATE_LIMITS, colourOnlyStates, colourStateFindings } from './colorState.js';
import { colourShots } from './colourEvidence.js';
import { inOwnFrames } from './ownFrameEval.js';

export const LINK_COLOR_LIMITS = {
  /** Colour-only links read per page. */
  links: 40,
  /** Of those, links under 3:1 tested on hover and focus. */
  tested: 10,
  /** Wait after hovering or focusing before reading the styles (a transition has started by then: a few frames). */
  settleMs: 60,
  reserveMs: 1000,
} as const;

/** WCAG technique G183: a link colour at least 3:1 from the text colour, plus a cue other than colour on hover and focus. */
export const LINK_TEXT_THRESHOLD = 3;

const KEY = '__grntedLinks';

/**
 * Runs in the page (self-contained). The link's look apart from colour: text decoration, borders,
 * outline, box shadow geometry, font, case, background images and sizes, transforms, for the link,
 * its first descendants and its ::before and ::after (where a shape that appears, even in a colour,
 * is a cue: an underline drawn by a pseudo-element). `prepare` scrolls it to the middle of the page
 * (the page only) and returns where to point.
 */
export function linkLook(arg: { key: string; ref: number; prepare?: boolean }): { look: string; x: number; y: number; hovered: boolean; focused: boolean } | null {
  const el = ((window as unknown as Record<string, Element[] | undefined>)[arg.key] ?? [])[arg.ref];
  if (!el || !el.isConnected) return null;
  if (arg.prepare) {
    const r0 = el.getBoundingClientRect();
    window.scrollBy({ left: 0, top: r0.top + r0.height / 2 - window.innerHeight / 2, behavior: 'instant' as ScrollBehavior });
  }
  const noColour = (v: string) => v.replace(/(rgba?|hsla?|color|oklch|oklab|lab|lch|hwb)\([^)]*\)|#[0-9a-f]{3,8}\b/gi, 'C');
  const PROPS = [
    'textDecorationLine', 'textDecorationStyle', 'textDecorationThickness', 'textUnderlineOffset',
    'borderTopStyle', 'borderRightStyle', 'borderBottomStyle', 'borderLeftStyle', 'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
    'outlineStyle', 'outlineWidth', 'boxShadow', 'fontWeight', 'fontStyle', 'fontFamily', 'fontSize', 'textTransform', 'fontVariantCaps',
    'backgroundImage', 'backgroundSize', 'backgroundPosition', 'letterSpacing', 'transform',
  ] as const;
  const PSEUDO = ['content', 'display', 'width', 'height', 'opacity', 'visibility', 'transform', 'borderBottomStyle', 'borderBottomWidth', 'backgroundImage', 'backgroundSize'] as const;
  // Batch 18, D11: whether a decoration, border or outline is painted at all (see-through or not) is a shape that appears
  // or goes, not a colour: an underline that turns from transparent to visible on hover is a cue.
  const seen = (c: string) => {
    if (!c || c === 'transparent') return 'T';
    const m = /\/\s*([\d.]+)(%?)\s*\)$/.exec(c) ?? /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)(%?)\s*\)$/.exec(c);
    const a = m ? parseFloat(m[1]!) / (m[2] ? 100 : 1) : 1;
    return a > 0.1 ? 'V' : 'T';
  };
  const SEEN = ['textDecorationColor', 'borderTopColor', 'borderRightColor', 'borderBottomColor', 'borderLeftColor', 'outlineColor'] as const;
  const read = (s: CSSStyleDeclaration, props: readonly string[]) => props.map((p) => noColour(String(s[p as keyof CSSStyleDeclaration] ?? ''))).join('|')
    + (props === PROPS ? `|${SEEN.map((p) => seen(String(s[p as keyof CSSStyleDeclaration] ?? ''))).join('')}` : '');
  const parts = [read(getComputedStyle(el), PROPS), ...[...el.querySelectorAll('*')].slice(0, 10).map((d) => read(getComputedStyle(d), PROPS))];
  for (const p of ['::before', '::after']) {
    const s = getComputedStyle(el, p);
    if (/^(none|normal)$/.test(s.content)) continue;
    // A pseudo-element with a background shows a shape (an underline bar): whether it has one counts, not its colour.
    const filled = !/^(rgba\(0, 0, 0, 0\)|transparent)$/.test(s.backgroundColor);
    parts.push(`${p}:${read(s, PSEUDO)}|${filled}`);
  }
  const r = el.getBoundingClientRect();
  const rects = [...el.getClientRects()];
  const first = rects.find((q) => q.width > 2 && q.height > 2) ?? r;
  return { look: parts.join('\n'), x: first.left + first.width / 2, y: first.top + first.height / 2, hovered: el.matches(':hover'), focused: el.matches(':focus') };
}

/** Runs in the page (self-contained): focuses or blurs the link without scrolling. */
export function focusLink(arg: { key: string; ref: number; focus: boolean }): boolean {
  const el = ((window as unknown as Record<string, Element[] | undefined>)[arg.key] ?? [])[arg.ref] as HTMLElement | undefined;
  if (!el || !el.isConnected) return false;
  if (arg.focus) el.focus({ preventScroll: true });
  else el.blur();
  return document.activeElement === el;
}

/** Runs in the page (self-contained): forgets the stored links. */
export function dropLinks(key: string): void {
  delete (window as unknown as Record<string, unknown>)[key];
}

type LinkOutcome =
  /** Cue on hover and on focus: null when that state could not be reached. */
  | { kind: 'failed'; hoverCue: boolean | null; focusCue: boolean | null }
  | { kind: 'ok' }
  | { kind: 'unmeasured'; reason: 'translucent' | 'unreachable' | 'gone' | 'time' };

const REASON_TEXT = {
  translucent: 'its color or the text color is see-through, so the colors on screen are not known',
  unreachable: 'the pointer could not reach it (covered by other content)',
  gone: 'it was no longer on the page',
  time: 'the time for this test ran out first',
} as const;

/** The colours of a found link as opaque sRGB, and their ratio; null when either is see-through. */
export function linkContrast(l: FoundColorOnlyLink): number | null {
  if (!l.linkRgba || !l.textRgba || l.linkRgba[3] < 1 || l.textRgba[3] < 1) return null;
  return contrastRatio(l.linkRgba, l.textRgba);
}

export function linkColorFindings(items: readonly { link: FoundColorOnlyLink; ratio: number | null; outcome: LinkOutcome }[], found: number): ProbeFinding[] {
  if (!found) return [{ criterion: '1.4.1', status: 'not_applicable', detail: 'no links in running text told apart only by color' }];
  const out: ProbeFinding[] = [];
  for (const { link, ratio, outcome } of items) {
    if (outcome.kind !== 'failed') continue;
    const missing = outcome.hoverCue === false && outcome.focusCue === false ? 'neither pointing at it nor focusing it adds another cue'
      : outcome.hoverCue === false ? 'pointing at it adds no other cue' : 'focusing it adds no other cue';
    out.push({
      criterion: '1.4.1', status: 'failed', target: link.text ? `link “${link.text}”` : link.href,
      elements: elementKeys(textElement(link.text), roleElement('link')),
      detail: `A link differs from the text around it only by color (${hex(link.linkRgba!)} against ${hex(link.textRgba!)}, ${ratioText(ratio!)}; at least 3:1 is needed), and ${missing}: “${link.text}” in “${link.context.slice(0, 120)}”`,
    });
  }
  const unmeasured = items.filter((it): it is typeof it & { outcome: { kind: 'unmeasured'; reason: keyof typeof REASON_TEXT } } => it.outcome.kind === 'unmeasured');
  if (unmeasured.length) {
    const counts = new Map<keyof typeof REASON_TEXT, number>();
    for (const it of unmeasured) counts.set(it.outcome.reason, (counts.get(it.outcome.reason) ?? 0) + 1);
    out.push({
      criterion: '1.4.1', status: 'not_testable', target: unmeasured[0]!.link.text ? `link “${unmeasured[0]!.link.text}”` : unmeasured[0]!.link.href,
      detail: `${unmeasured.length} of ${items.length} ${items.length === 1 ? 'link' : 'links'} told apart only by a color close to the text could not be tested: ${[...counts.entries()].map(([r, n]) => `${n} because ${REASON_TEXT[r]}`).join('; ')}`,
    });
  }
  return out;
}

/**
 * Links in running text whose only visible difference from the text around them is their colour
 * (the vision collector's rules, the whole page, up to 40), where the two colours are less than 3:1
 * apart: each (up to 10) is pointed at and then focused, and its look apart from colour compared
 * with its look before. Failed when pointing at it or focusing it adds no other cue (underline,
 * border, outline, weight, a shape drawn by a pseudo-element…). Links 3:1 or more from the text
 * colour are not failed here. A link the pointer cannot reach, or with see-through colours, is
 * reported as not_testable.
 * Also 1.4.1: a colour key on the page ("Green means open. Red means closed.") whose items carry only the
 * colour fails (`findColorKeys` in ./colorKey.ts).
 */
export const linkColorProbe: PageProbe = {
  id: 'link-color',
  // On every page that loaded (2026-11-10, red-team coverage): it shares the every-page tests' page load and takes well under a second.
  everyPage: true,
  criteria: ['1.4.1'],
  kind: 'interaction',
  tier: 'core',
  timeoutMs: 10_000,
  // Its links are what the page mounted: a page still putting its content in is waited for first (bounded,
  // `LATE_CONTENT_MS`), as for the layout tests; an empty shell has no links in running text.
  waitFor: { content: true },
  async run(ctx: ProbeContext): Promise<ProbeFinding[]> {
    const page = ctx.page;
    const mark = ctx.guard.mark();
    // A colour key whose items carry only the colour (./colorKey.ts): read from the page at rest, before any link is pointed at.
    const keyed = colorKeyFindings(await page.evaluate(findColorKeys, { limits: COLOR_KEY_LIMITS }).catch(() => []));
    // Batch 18, D10: a state the page marks in its code (current, selected, pressed) told apart by colour alone.
    const states = colourStateFindings([
      ...(await page.evaluate(colourOnlyStates, { max: COLOR_STATE_LIMITS.states, peers: COLOR_STATE_LIMITS.peers }).catch(() => [])),
      // Round 2: the same in the page's own frames.
      ...(await inOwnFrames(page, colourOnlyStates, { max: COLOR_STATE_LIMITS.states, peers: COLOR_STATE_LIMITS.peers })),
    ]);
    const keys = [...keyed, ...states];
    if (keys.length) ctx.keep?.(keys);
    const found = await page.evaluate(findColorOnlyLinks, { links: LINK_COLOR_LIMITS.links, text: 80, inView: false, key: KEY });
    try {
      const close = found.map((link) => ({ link, ratio: linkContrast(link) })).filter((x) => x.ratio === null || x.ratio < LINK_TEXT_THRESHOLD).slice(0, LINK_COLOR_LIMITS.tested);
      if (close.length && !page.mouse) throw new ProbeNotTestable('the browser cannot move the pointer, which this test needs');
      const items: { link: FoundColorOnlyLink; ratio: number | null; outcome: LinkOutcome }[] = [];
      for (const { link, ratio } of close) {
        if (ratio === null) {
          items.push({ link, ratio, outcome: { kind: 'unmeasured', reason: 'translucent' } });
          continue;
        }
        if (Date.now() > ctx.deadline - LINK_COLOR_LIMITS.reserveMs || ctx.signal.aborted) {
          items.push({ link, ratio, outcome: { kind: 'unmeasured', reason: 'time' } });
          continue;
        }
        items.push({ link, ratio, outcome: await testLink(ctx, link.ref!) });
      }
      // Pictures of the failing links (and their place on the start page), the pointer away and no focus.
      for (const it of items) {
        if (it.outcome.kind !== 'failed' || it.link.ref === undefined || it.ratio === null) continue;
        const named = it.link.text ? ` “${cleanText(it.link.text, 60)}”` : '';
        await shootElements(ctx, {
          criterion: '1.4.1', handles: [{ key: KEY, ref: it.link.ref }],
          caption: `Told apart only by color: ${ratioText(it.ratio)} against the text; 3:1 is needed`,
          alt: (title) => `${pageWords(title)}: the outlined link${named} looks like the text around it except for its color, and pointing at it or focusing it adds no other cue.`,
        });
      }
      // Pointing and focusing read styles, which a blocked request cannot change; a held navigation can.
      const links = linkColorFindings(items, found.length);
      // Pictures of charts and colour-coded marks, for the AI review only (neutral evidence; batch 18, visual AI).
      if (ctx.aiEvidence) {
        const shots = await colourShots(ctx);
        if (shots.length) ctx.attach?.({ colourShots: shots });
        await page.evaluate(() => window.scrollTo(0, 0), undefined).catch(() => {});
      }
      return guarded(ctx, mark, keys.length ? [...keys, ...links.filter((f) => f.status !== 'not_applicable')] : links, true);
    } finally {
      await page.evaluate(dropLinks, KEY).catch(() => {});
    }
  },
};

async function testLink(ctx: ProbeContext, ref: number): Promise<LinkOutcome> {
  const page = ctx.page;
  const mouse = page.mouse!;
  const wait = () => page.waitForTimeout(LINK_COLOR_LIMITS.settleMs);
  await page.evaluate(focusLink, { key: KEY, ref, focus: false });
  await mouse.move(0, 0);
  const before = await page.evaluate(linkLook, { key: KEY, ref, prepare: true });
  if (!before) return { kind: 'unmeasured', reason: 'gone' };
  await mouse.move(before.x, before.y);
  await wait();
  const hovered = await page.evaluate(linkLook, { key: KEY, ref });
  await mouse.move(0, 0);
  // Let a hover transition run back first, so it is never mistaken for a focus cue.
  for (let i = 0; i < 20; i++) {
    const now = await page.evaluate(linkLook, { key: KEY, ref });
    if (!now || now.look === before.look) break;
    await page.waitForTimeout(50);
  }
  await page.evaluate(focusLink, { key: KEY, ref, focus: true });
  await wait();
  const focused = await page.evaluate(linkLook, { key: KEY, ref });
  await page.evaluate(focusLink, { key: KEY, ref, focus: false });
  if (!hovered || !focused) return { kind: 'unmeasured', reason: 'gone' };
  // A state the test could not reach (the pointer is covered, the link cannot take focus) is not judged.
  const hoverCue = hovered.hovered ? hovered.look !== before.look : null;
  const focusCue = focused.focused ? focused.look !== before.look : null;
  if (hoverCue === false || focusCue === false) return { kind: 'failed', hoverCue, focusCue };
  if (hoverCue && focusCue) return { kind: 'ok' };
  return { kind: 'unmeasured', reason: 'unreachable' };
}
