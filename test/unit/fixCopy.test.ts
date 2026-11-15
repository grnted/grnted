// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report v3 stage 2: fix steps and code for every test that can produce a problem today (copy/fixes.ts).
// Coverage: each axe rule the scan runs, each criterion a registry test can fail, each gated AI check,
// the media and cross-page rules, each PDF quick check, AI document criterion and Office check. Code
// correctness: each builder on the scan's real evidence shape, and on untrusted junk.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { LEGACY_AI_GATES as AI_SCORED } from '../../src/aiLegacy.js';
import { officeProblems } from '../../src/documents/office.js';
import { PDF_FIELDS } from '../../src/documents/pdf.js';
import { PROBES } from '../../src/probes/registry.js';
import { RULE_IMPACTS } from '../../src/ruleImpacts.js';
import { CONSISTENCY_WEIGHTS, MEDIA_WEIGHTS } from '../../src/scoreCore.js';
import { codeFor, contrastRatio, cssSelector, DOCUMENT_STEP, fixedColor, fixFor, FIXES, GENERIC_FIX, type CodeFix } from '../../src/report/copy/fixes.js';
import { parseStartTag } from '../../src/report/startTag.js';

const MEDIA_SOURCE = readFileSync(new URL('../../src/media/index.ts', import.meta.url), 'utf8');
const MEDIA_PROBLEM_RULES = [...new Set([...MEDIA_SOURCE.matchAll(/level: 'problem',\s*rule: '([a-z-]+)'/g)].map((m) => m[1]!))];
const OFFICE_KEYS = [...new Set(officeProblems({ format: 'pptx', passwordToOpen: true, imagesWithoutAlt: 1, slidesWithoutTitle: 1, hasLanguage: false, hasTitle: false }).map((f) => f.key))];

/** Every fix key a problem can have today, by where it comes from. */
const PRODUCIBLE = {
  rules: Object.keys(RULE_IMPACTS).map((id) => `rule:${id}`),
  tests: [...new Set(PROBES.flatMap((p) => p.criteria.map((c) => `probe:${p.id}:${c}`)))],
  ai: Object.entries(AI_SCORED).filter(([check]) => check !== 'document').flatMap(([check, cs]) => cs!.map((c) => `ai:${check}:${c}`)),
  aiDocuments: (AI_SCORED.document ?? []).map((c) => `pdf-ai:${c}`),
  pdf: [...new Set([...Object.values(PDF_FIELDS).flat(), 'showsTitle'])].map((f) => `pdf:${f}`),
  office: OFFICE_KEYS.map((k) => `office:${k}`),
  media: [...MEDIA_PROBLEM_RULES.map((r) => `media:${r}`), ...Object.keys(MEDIA_WEIGHTS).map((c) => `media:${c}`)],
  consistency: Object.keys(CONSISTENCY_WEIGHTS).map((c) => `consistency:${c}`),
};
const ALL = Object.values(PRODUCIBLE).flat();
const DOCUMENT_KEY = /^(?:pdf|pdf-ai|office):/;
const TECHNIQUE = /^(?:G|H|C|ARIA|SCR|SVR|F|PDF)\d{1,3}$/;
const FORBIDDEN = /\b(passes|passed|compliant|compliance|certified|verified)\b/i;

describe('fix copy coverage', () => {
  it('enumerates the producible tests (a source change that adds one shows here)', () => {
    expect(PRODUCIBLE.rules).toHaveLength(68);
    // Scoring v11 (batch 15b): a missing captions track and autoplay metadata are possible problems, not rule problems.
    expect(MEDIA_PROBLEM_RULES.sort()).toEqual(['uploader-captions-missing']);
    expect(OFFICE_KEYS.sort()).toEqual(['alt', 'language', 'password', 'slideTitle', 'title']);
    expect(PRODUCIBLE.pdf.length).toBe(9);
    // 0.2.0: batch 15b's tests (page and route titles, language parts, names, ...) less two media rules and, since v11.2,
    // the AI page text review's 1.3.1 and 2.4.6. Scoring v12 (batch 16): those two count again, and the pointer
    // gestures test judges 2.1.1 for lists only dragging reorders (its own fix copy). Scoring v13 (batch 17): the media
    // lane's media-files (1.2.2, its own copy: the media rule's steps) and media-alternatives (1.2.1, the criterion's copy),
    // and the images lane's picture test (1.1.1 and 1.4.5, its own copy: no criterion copy exists for either).
    // Batch 18 (visual lane): the state-text-contrast deep test (1.4.3 for text shown later and in opened regions).
    // Batch 18 (forms lane): the forms test judges 3.3.2 too (a label that vanishes once typed into, a field required
    // only after sending).
    expect(ALL.length).toBe(206);
  });

  it.each(Object.entries(PRODUCIBLE))('every producible %s key has its own reviewed fix copy (never the generic one)', (_, keys) => {
    const missing = keys.filter((k) => fixFor(k).copy === GENERIC_FIX);
    expect(missing).toEqual([]);
  });

  it('axe rules, AI checks, media rules, documents and cross-page rules are never answered by another key\'s fallback', () => {
    for (const k of [...PRODUCIBLE.rules, ...PRODUCIBLE.ai, ...PRODUCIBLE.aiDocuments, ...PRODUCIBLE.pdf, ...PRODUCIBLE.office, ...PRODUCIBLE.consistency]) {
      expect(fixFor(k).resolved, k).toBe(k);
    }
    // Media by criterion is an explicit alias of its rule's copy.
    expect(fixFor('media:1.2.2').resolved).toBe('media:no-captions-track');
    expect(fixFor('media:1.4.2').resolved).toBe('media:autoplay-sound-no-controls');
    // A test criterion falls back to the criterion's copy only on purpose: every criterion has one.
    for (const k of PRODUCIBLE.tests) expect(fixFor(k).resolved, k).toMatch(/^(?:probe:|criterion:)/);
    // A list only dragging reorders (batch 16): the fix is a keyboard way to reorder it, not 2.1.1's "use a real button".
    expect(fixFor('probe:pointer-gestures:2.1.1').resolved).toBe('probe:pointer-gestures:2.1.1');
    // A page's own video with speech and no captions track (batch 17): the media rule's fix, not the platform step.
    expect(fixFor('probe:media-files:1.2.2').resolved).toBe('probe:media-files:1.2.2');
    expect(fixFor('probe:media-files:1.2.2').copy.steps).toEqual(fixFor('media:no-captions-track').copy.steps);
    // A third-party frame's rule uses the rule's copy.
    expect(fixFor('third-party:aria-allowed-attr').resolved).toBe('rule:aria-allowed-attr');
  });

  it('every document check has a short phrase for a step that lists several', () => {
    for (const k of [...PRODUCIBLE.pdf, ...PRODUCIBLE.aiDocuments, ...PRODUCIBLE.office]) {
      if (k === 'pdf:imageOnly') continue; // always a step of its own (text recognition comes first)
      expect(DOCUMENT_STEP[k], k).toBeDefined();
    }
  });
});

describe('fix copy rules', () => {
  it.each(Object.entries(FIXES))('%s: 2 to 4 short steps (documents: 1 or more, assembled per file), in the copy voice', (key, f) => {
    if (DOCUMENT_KEY.test(key)) expect(f.steps.length).toBeGreaterThanOrEqual(1);
    else { expect(f.steps.length, key).toBeGreaterThanOrEqual(2); expect(f.steps.length, key).toBeLessThanOrEqual(4); }
    for (const s of f.steps) {
      expect(s, key).toMatch(/^[A-Z“"]/);
      expect(s, key).toMatch(/[.)]$/);
      expect(s.length, `${key}: ${s}`).toBeLessThanOrEqual(170);
      expect(s, key).not.toMatch(FORBIDDEN);
      expect(s, key).not.toMatch(/—|\s{2,}/);
      expect(s, key).not.toMatch(/\bcolour|\bbehaviour|\bcentre\b/i); // US spelling
    }
    // A code change names the WCAG techniques it applies; steps-only copy names none.
    if (f.code) {
      expect(f.techniques?.length, key).toBeGreaterThan(0);
      for (const t of f.techniques!) expect(t, key).toMatch(TECHNIQUE);
    } else expect(f.techniques, key).toBeUndefined();
  });

  it('copy objects cannot be changed at runtime', () => {
    expect(Object.isFrozen(FIXES)).toBe(true);
    expect(Object.isFrozen(FIXES['rule:image-alt'])).toBe(true);
    expect(Object.isFrozen(FIXES['rule:image-alt']!.steps)).toBe(true);
  });
});

/** Each line of an HTML snippet is a start tag that reads cleanly, a closing tag, text or an ellipsis. */
function wellFormedHtml(lines: readonly string[]) {
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line === '…' || /^<\/[a-z]+>$/.test(line)) continue;
    if (line.startsWith('<')) {
      const tag = parseStartTag(line);
      expect(tag, line).not.toBeNull();
      // What follows the start tag: text, then its own closing tag (or the element goes on over the next lines).
      const rest = tag!.rest.trim();
      if (rest) expect(rest, line).toMatch(new RegExp(`^[^<>]*(?:</${tag!.name}>)?$`));
    }
  }
}
function wellFormedCss(lines: readonly string[]) {
  const css = lines.join('\n').replace(/\/\*[^*]*\*\//g, '');
  expect((css.match(/{/g) ?? []).length).toBe((css.match(/}/g) ?? []).length);
  for (const decl of css.match(/{([^}]*)}/g) ?? []) for (const d of decl.slice(1, -1).split(';').map((x) => x.trim()).filter(Boolean)) expect(d).toMatch(/^[a-z-]+\s*:\s*\S/);
}
function wellFormed(c: CodeFix) {
  if (c.language === 'html') { wellFormedHtml(c.before); wellFormedHtml(c.after); } else { wellFormedCss(c.before); wellFormedCss(c.after); }
}

describe('code changes are correct and built from the scan\'s evidence', () => {
  const change = (key: string, ex: Parameters<typeof codeFor>[1]) => {
    const c = codeFor(key, ex);
    expect(c, key).toBeDefined();
    wellFormed(c!);
    return c!;
  };

  it('image-alt: the element\'s own start tag, with an alt added (H37)', () => {
    const c = change('rule:image-alt', { html: '<img id="hero" src="/images/garden.png" width="480" height="240">' });
    expect(c).toMatchObject({ source: 'page', language: 'html', before: ['<img id="hero" src="/images/garden.png" width="480" height="240">'], techniques: ['H37', 'H67'] });
    expect(parseStartTag(c.after[0])!.attrs.find((a) => a.name === 'alt')?.value).toBeTruthy();
  });

  it('link-name, button-name and frame-title name the element itself; label adds a label tied to its id', () => {
    expect(change('rule:link-name', { html: '<a href="/documents" style="width:32px"></a>' }).after[0]).toBe('<a href="/documents" style="width:32px" aria-label="[where the link goes]">');
    expect(change('rule:button-name', { html: '<button type="submit"><svg aria-hidden="true"></svg></button>' }).after[0]).toBe('<button type="submit" aria-label="[what it does]">');
    expect(change('rule:frame-title', { html: '<iframe class="map" src="/map"></iframe>' }).after[0]).toBe('<iframe class="map" src="/map" title="[what the frame shows]">');
    expect(change('rule:label', { html: '<input id="q" type="search">' }).after).toEqual(['<label for="q">[field label]</label>', '<input id="q" type="search">']);
    // No usable id: the label wraps the field.
    expect(change('rule:label', { html: '<input type="text" name="q">' }).after).toEqual(['<label>[field label]', '  <input type="text" name="q">', '</label>']);
  });

  it('language: lang added to the html element; a language written as a name becomes its code; unknown values get steps only', () => {
    expect(change('rule:html-has-lang', { html: '<html class="no-js">' }).after).toEqual(['<html class="no-js" lang="[the page’s language code]">']);
    expect(change('rule:valid-lang', { html: '<p lang="spanish">Bienvenidos a la escuela.</p>' }).after).toEqual(['<p lang="es">']);
    expect(codeFor('rule:valid-lang', { html: '<p lang="xx-klingon">Q</p>' })).toBeUndefined();
    expect(change('rule:html-xml-lang-mismatch', { html: '<html lang="en" xml:lang="fr">' }).after).toEqual(['<html lang="en" xml:lang="en">']);
  });

  it('meta-viewport: user-scalable and maximum-scale removed, the rest kept (G142)', () => {
    const c = change('rule:meta-viewport', { html: '<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no">' });
    expect(c.after).toEqual(['<meta name="viewport" content="width=device-width, initial-scale=1">']);
  });

  it('target-size: inline sizes under 24 px raised to 24 px (C42); no inline size, a stylesheet rule for the selector', () => {
    const c = change('rule:target-size', { html: '<a href="/news" aria-label="News feed" style="display:inline-block;width:14px;height:14px;min-height:0;padding:0"></a>' });
    expect(c.after[0]).toBe('<a href="/news" aria-label="News feed" style="display:inline-block;width:24px;height:24px;min-height:24px;padding:0;min-width:24px">');
    expect(change('rule:target-size', { html: '<a href="/x">x</a>', target: 'a[aria-label="Photo feed"]' }).after).toEqual(['a[aria-label="Photo feed"] { display: inline-block; min-width: 24px; min-height: 24px; }']);
    expect(codeFor('rule:target-size', { html: '<a style="width:1em">x</a>', target: 'Photo (link)' })).toBeUndefined();
  });

  it('contrast: the nearest shade that meets the ratio, from the measured colors (G18, G209)', () => {
    const text = change('rule:color-contrast', { target: '#main > p:nth-child(2)', detail: 'Element has insufficient color contrast of 2.32 (foreground color: #aaaaaa, background color: #ffffff, font size: 12.0pt (16px), font weight: normal). Expected contrast ratio of 4.5:1' });
    const color = /color: (#[0-9a-f]{6})/.exec(text.after[0]!)![1]!;
    expect(contrastRatio([0xaa, 0xaa, 0xaa], [255, 255, 255])).toBeCloseTo(2.32, 2);
    const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));
    expect(contrastRatio(hex(color), [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    expect(text.before).toEqual(['#main > p:nth-child(2) { color: #aaaaaa; }']);
    const probe = change('criterion:1.4.3', { target: '#slides', detail: 'Text contrast is 2.3:1 where it sits on … (text #aaaaaa on #ffffff); 16 px text needs at least 4.5:1: “Notice 1”' });
    expect(probe.after[0]).toContain('#slides { color: #');
    const edge = change('criterion:1.4.11', { target: '#q', detail: 'A form field’s boundary has 1.5:1 contrast with the colors next to it (edge #d0d0d0 between #ffffff outside and #ffffff inside); at least 3:1 is needed' });
    const border = /border-color: (#[0-9a-f]{6})/.exec(edge.after[0]!)![1]!;
    expect(contrastRatio(hex(border), [255, 255, 255])).toBeGreaterThanOrEqual(3);
    // Light text on a dark background gets lighter, never darker.
    expect(contrastRatio(hex(fixedColor('#555555', ['#000000'], 4.5)!), [0, 0, 0])).toBeGreaterThanOrEqual(4.5);
    expect(fixedColor('#777777', ['#ffffff', '#000000'], 4.5)).toBeNull(); // no shade works against both
    expect(codeFor('rule:color-contrast', { target: '#x', detail: 'Elements must meet minimum color contrast ratio thresholds' })).toBeUndefined(); // nothing measured: steps only
  });

  it('heading level: the measured skip moved up one level from the heading before it (H42)', () => {
    const c = change('probe:heading-levels:1.3.1', { detail: 'Heading levels skip from 1 to 4: “How to reach us” (level 4) follows “Accessibility” (level 1)' });
    expect(c.before).toEqual(['<h4>How to reach us</h4>']);
    expect(c.after).toEqual(['<h2>How to reach us</h2>']);
  });

  it('media: the file\'s own address in the player; a video on a host takes captions there (no track element)', () => {
    expect(change('criterion:1.4.2', { asset: 'https://fixture.example/media/tone.wav' })).toMatchObject({ source: 'page', after: ['<audio src="/media/tone.wav" controls></audio>'] });
    expect(change('media:no-captions-track', { asset: 'https://fixture.example/media/welcome.webm' }).after).toEqual(['<video src="/media/welcome.webm" controls>', '  <track kind="captions" src="/media/welcome.vtt" srclang="[the page’s language code]" label="[captions language]">']);
    expect(codeFor('criterion:1.2.2', { asset: 'https://www.youtube.com/embed/M7lc1UVf-VE' })).toBeUndefined();
    expect(change('rule:no-autoplay-audio', { html: '<audio src="/a.mp3" autoplay loop>' }).after).toEqual(['<audio src="/a.mp3" loop controls>']);
  });

  it('tests: words from the scan\'s measurement, never invented page content', () => {
    expect(change('criterion:2.1.1', { target: '#hours-toggle', detail: '"Show office hours" (#hours-toggle) responds to the mouse (click handler) but is not focusable' }).after).toEqual(['<button type="button" id="hours-toggle">Show office hours</button>']);
    expect(change('criterion:1.3.5', { detail: 'the field asks for the person’s email address but has no autocomplete attribute; add autocomplete="email"' }).after).toEqual(['<input type="email" name="email" autocomplete="email">']);
    expect(change('probe:aria-states:4.1.2', { detail: 'The button “Allergy information” tells screen readers it is expanded, but what it opens is hidden' }).after).toEqual(['<button type="button" aria-expanded="false">Allergy information</button>']);
    expect(change('criterion:2.4.11', { data: { coverHeight: 64 }, detail: '"Contact" (a) is entirely hidden behind header.site (fixed or sticky content)' }).after).toEqual(['html { scroll-padding-top: 76px; }']);
    // Which edge a covering box sits on is unknown: no code rather than a guess.
    expect(codeFor('criterion:2.4.11', { data: { coverHeight: 270 }, detail: '"Site map" is entirely hidden behind #main > div:nth-of-type(2) (fixed or sticky content)' })).toBeUndefined();
  });

  it('never throws and never copies markup-breaking content from the page', () => {
    const junk = ['<', '<img src="x" alt="a"b">', '<img src=">', '<script>alert(1)</script>', '\u0000<a', '<a href="/x" title="<img>">', 'x'.repeat(5000)];
    for (const key of Object.keys(FIXES)) for (const html of junk) {
      const c = codeFor(key, { html, target: html, detail: html, asset: html, data: { coverHeight: html as unknown as number } });
      if (!c) continue;
      for (const line of [...c.before, ...c.after]) expect(line, key).not.toContain('<script');
    }
    expect(cssSelector('Password (password field)')).toBeNull();
    expect(cssSelector('form "Request a printed copy"')).toBeNull();
    expect(cssSelector('html > body > footer > ul > li:nth-of-type(2) > a')).toBe('html > body > footer > ul > li:nth-of-type(2) > a');
    expect(cssSelector('p:nth-child(4) > a[href$="contact"]')).toBe('p:nth-child(4) > a[href$="contact"]');
  });
});

describe('Sol review r1 (2026-11-09): the literal cases', () => {
  it('#2 the caption change keeps the video\'s own children: the track goes inside the existing video, after its sources (H95)', () => {
    const c = codeFor('rule:video-caption', { html: '<video controls><source src="/movie.webm"></video>' })!;
    expect(c.before).toEqual(['<video controls><source src="/movie.webm"></video>']);
    expect(c.after.join('')).toMatch(/^<video controls><source src="\/movie\.webm">\s*<track kind="captions" [^>]*><\/video>$/);
    // A video with a src takes the track right after its start tag, which keeps whatever follows.
    const s = codeFor('media:no-captions-track', { asset: 'https://e.org/media/welcome.webm', html: '<video src="/media/welcome.webm" controls>' })!;
    expect(s.before).toEqual(['<video src="/media/welcome.webm" controls>']);
    expect(s.after[0]).toBe('<video src="/media/welcome.webm" controls>');
    expect(s.after.join('\n')).not.toContain('</video>');
    // Sources whose end the scan did not keep: no code rather than a guess.
    expect(codeFor('rule:video-caption', { html: '<video controls><source src="/a.webm"><source src="/b.mp4">' })).toBeUndefined();
  });

  it('#3 AI alt text: the image address exactly as found, and never a truncated text without the rest next to it (G94, G92)', () => {
    const words = 'Family Science Night, Thursday, March 12, 6:00 to 7:30 PM, School Gym. Hands-on experiments and snacks for all ages. Bring a grown-up. Free entry, no tickets needed.';
    expect(words.length).toBeGreaterThan(150);
    const c = codeFor('ai:altText:1.1.1', { target: 'https://cdn.example.org/banner.png?v=3', detail: `Words in the picture: ${words}` })!;
    const all = c.after.join('\n');
    expect(all).toContain('src="https://cdn.example.org/banner.png?v=3"');
    expect(all).toContain(words); // every word, in the alt or in the text next to it
    expect(all).not.toContain('…');
    const short = codeFor('ai:altText:1.1.1', { target: 'https://cdn.example.org/banner.png', detail: 'Words in the picture: Open house May 1' })!;
    expect(short.after).toEqual(['<img src="https://cdn.example.org/banner.png" alt="Open house May 1">']);
  });

  it('#5 the language fix never declares English: the page\'s language is not known from the scan', () => {
    for (const html of ['<html>', '<html class="no-js">']) {
      const c = codeFor('rule:html-has-lang', { html });
      if (c) expect(c.after.join(' '), html).not.toMatch(/lang="en"/);
    }
    const valid = codeFor('rule:html-lang-valid', { html: '<html lang="xyz-unknown">' });
    if (valid) expect(valid.after.join(' ')).not.toMatch(/lang="en"/);
    // A language the page names in words is known from the scan: its code is safe.
    expect(codeFor('rule:html-lang-valid', { html: '<html lang="english">' })!.after).toEqual(['<html lang="en">']);
    // A language named in the page (lang="spanish") is known: its code is safe.
    expect(codeFor('rule:valid-lang', { html: '<p lang="spanish">Hola</p>' })!.after).toEqual(['<p lang="es">']);
  });

  it('#6 error prevention: reversible, or checked with correction, or review AND correct AND confirm (3.3.4)', () => {
    for (const key of ['criterion:3.3.4', 'probe:form-fields:3.3.4', 'ai:forms:3.3.4']) {
      const text = fixFor(key).copy.steps.join(' ');
      expect(text, key).not.toMatch(/correct,? or confirm|correct or confirm|review, correct or/i);
      expect(text, key).toMatch(/review[^.]*correct[^.]*confirm|check[^.]*correct[^.]*confirm/i);
      expect(text, key).toMatch(/undo|reverse/i);
    }
  });

  it('#7 timing: extend at least ten times; 5 seconds is for moving, blinking or scrolling only; reduced motion is extra, never required', () => {
    expect(fixFor('criterion:2.2.1').copy.steps.join(' ')).toMatch(/at least ten times/);
    const motion = fixFor('criterion:2.2.2').copy.steps;
    for (const s of motion) expect(s).not.toMatch(/updat[^.]*5 seconds|5 seconds[^.]*updat/i);
    expect(motion.join(' ')).toMatch(/updat/i);
    const reduced = motion.filter((s) => /reduced motion/i.test(s));
    for (const s of reduced) expect(s).toMatch(/\b(also|extra|as well)\b/i);
    expect(motion[0]).not.toMatch(/reduced motion/i);
  });

  it('#8 state example: the state the component really has, or none', () => {
    // An open <details> whose summary says aria-expanded="false" (the probe's own words): the summary needs no state attribute.
    const open = codeFor('probe:aria-states:4.1.2', { detail: 'The button “Menu” is open, but aria-expanded="false" tells screen readers it is not' });
    if (open) {
      expect(open.after.join(' ')).not.toContain('aria-expanded="false"');
      expect(open.after).toEqual(['<summary>Menu</summary>']);
    }
    expect(codeFor('probe:aria-states:4.1.2', { detail: 'The button “Allergy information” tells screen readers it is expanded, but what it opens is hidden' })!.after)
      .toEqual(['<button type="button" aria-expanded="false">Allergy information</button>']);
    expect(codeFor('probe:aria-states:4.1.2', { detail: 'The button “Hours” tells screen readers it is collapsed, but what it opens is shown' })!.after)
      .toEqual(['<button type="button" aria-expanded="true">Hours</button>']);
    expect(codeFor('probe:aria-states:4.1.2', { detail: 'The tab “Fees” is marked selected, but its panel is hidden' })).toBeUndefined();
  });

  it('#9 target size: an inline element becomes inline-block, or no code', () => {
    const c = codeFor('rule:target-size', { html: '<a href="/x" style="display:inline;width:14px;height:14px">x</a>' });
    if (c) expect(c.after[0]).toMatch(/display:inline-block/);
    // A display the change can't size (contents, none, a table part): no code.
    expect(codeFor('rule:target-size', { html: '<a href="/x" style="display:contents;width:14px">x</a>' })).toBeUndefined();
    // A span with no display set is inline by default.
    expect(codeFor('rule:target-size', { html: '<span role="button" style="width:14px;height:14px">x</span>' })!.after[0]).toMatch(/display:inline-block/);
  });

  it('#4 a PDF missing its title is told to set it AND show it (metadata title and DisplayDocTitle, PDF18)', () => {
    expect(fixFor('pdf:showsTitle').copy.steps.join(' ')).toMatch(/DisplayDocTitle|Show Document Title/);
  });
});
