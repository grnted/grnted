// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The lab's analysis per test (causes of the wrong cases, the code behind them, proposed fixes),
// written after reading the results and shown under each test on the scorecard. Line numbers are
// those of hosted/integration at 0d4239f1 for the first eleven tests, and at 237c4348 for the second
// report's (text-spacing to motion-actuation, run as the variant `base`).
const LATE_MOUNT = (what: string) => `**Late mounting (SPA hydration at 1–2 s).** ${what} The probe pages wait a fixed 1 s after \`load\`
(src/probes/runner.ts:356, \`PROBE_DEFAULTS.settleMs\` at :123) and the audit 1.5 s before axe (src/audit.ts:19 \`SETTLE_MS\`,
:401); content a script mounts later is not on the page when it is tested. *Fix:* after the fixed settle, wait for the DOM to
go quiet (no mutations for 500 ms, nothing \`aria-busy="true"\`), up to about 3 s more, in the runner's \`prepare\` and in the
audit's settle, as the overlays probe already does for its sweep (\`OVERLAY_LIMITS.quietMs\`/\`settleMaxMs\`, src/probes/overlays.ts).`;

export const SIM_NOTES: Record<string, string> = {
  flash: `### Causes and proposed fixes

1. **Exactly 3 flashes a second fails (false failures at 3 Hz, every mechanism).** WCAG fails *more than* three flashes in a
   second. A one-second window is counted half-open from each frame (src/probes/flashMath.ts:216–227) and fails at more than
   six transitions (:225, \`FLASH.maxTransitions\`). At 3 Hz seven transitions span exactly 1000 ms, so frame-time jitter
   (vsync, the screencast's 25 ms gap, video and GIF timing) puts the seventh inside the window about half the time.
   *Fix:* allow one frame of timing error: a cell fails a window only when seven transitions fit in less than
   \`1000 − 1.5 × median frame gap\` ms (or estimate the rate from the median gap between a cell's transitions and fail above
   3 Hz plus that error). 3.5 Hz (seven transitions in 857 ms) stays a clear failure.
2. **Area measured in whole 16 px cells.** Each cell is the average of its pixels (\`cellGrid\`, src/probes/motionPixels.ts:18) and counts in
   full once it has more than six transitions (src/probes/flashMath.ts:225; area = cells × cell², :230–232), however little of it
   flashes. General flashing at 24% of the field is read as
   26–28% (false failures); red flashing at 26% is read under 25% (missed), because an edge cell's blend of red and the white
   page is not "saturated red" (\`isSaturatedRed\`, :110–113). *Fix:* weight each flagged cell by its coverage, taken from the
   size of its swing against the strongest swing in the flashing region (luminance for general flashes, the linear-RGB distance
   between its two states for red ones), and compare the weighted area with 25%. Measuring at the screencast's own pixel
   (4 CSS px, \`SCREENCAST.width\` 320, src/probes/flash.ts:32) instead of 16 px cells shrinks the error further.
3. **Smooth scrolling (owned by fix/flash-smooth-scroll).** With \`scroll-behavior: smooth\` the test's own \`scrollTo\` animates
   and \`scrollToY\` returns the position before it moved (src/probes/flash.ts:75); the place is then dropped as already seen
   (:265–266), so a flasher further down is never captured (missed). On these pages the defect shows as missed flashes, not
   as the false failure on dense text, because the capture never runs while the page scrolls. On 78fd65b2 (that branch,
   the "flash @ 78fd65b2" rows) no smooth-scroll page is missed and none is falsely failed except at exactly 3 Hz (cause 1).
   **New on 78fd65b2:** pages with \`scroll-snap-type: y mandatory\` get "not testable: the page kept scrolling when the test
   moved 0 px down" (5 of 20 snap pages, flashers at the top included), which the base measured; the settle check after the
   instant scroll should treat a snap that lands still, or a scroll of 0 px, as settled.
4. ${LATE_MOUNT('A flasher mounted after the test listed its places is not captured below the fold: the places are computed once, 300 ms into the test (src/probes/flash.ts:250–251).')} Also list the places again after the top capture.

**Video at exactly 3 Hz is not counted (lead's ruling, 2026-11-07).** The eight video cases at exactly 3 Hz are expected
\`any\` (left out of precision and recall): a video's frame timing is the player's, not the page's, and the browser can
genuinely show seven changes in under 1000 ms (983–999 ms measured on \`flash/video/3hz/26pct/general/top/sticky-header\`),
so the strict WCAG reading may fail it. JS- and CSS-driven cases at exactly 3 Hz stay must-pass: the page controls
their timing, and cause 1 above still applies to them.

What the lab does not cover yet: flashes inside cross-origin frames, flashes that start on scroll or on interaction, and
very large or full-screen flashes on pages that also scroll (one place per screen).`,
  'text-contrast': `### Causes and proposed fixes

Every wrong case is a page whose text mounts 1–2 s after \`load\`: no false failure, and no miss on a settled page, at any
ratio, size, weight, font, background (solid, gradient, image, image behind) or animation in flight.

${LATE_MOUNT('axe ran before the paragraph existed, and the probe found none of axe\'s undecided text.')}`,
  'non-text-contrast': `### Causes and proposed fixes

Every wrong case is a page whose control mounts 1–2 s after \`load\` ("no form fields or icon-only controls on the page"):
no false failure, and no miss on a settled page, for borders (1 and 2 px), fills, selects, custom checkboxes or SVG icons on
white, tinted and dark pages, and disabled and browser-default controls are left out as they should be.

${LATE_MOUNT('The probe looked for controls before they existed.')}`,
  'focus-obscured': `### Causes and proposed fixes

Every wrong case is a control 99% under an opaque bar, with a 1 px strip of it showing (a sticky header, a bottom banner or
a chat bubble; at every width, phone only or desktop only; link, button, field or select): the engine calls it entirely
hidden. Every 100% case was found (desktop by the keyboard test, phone widths by the overlays test), every 0% and 50% case
and every translucent bar passed.

**A 5×5 grid of sample points cannot see a strip under 10% of the box.** "Entirely hidden" is decided from points at the
centres of a 5×5 grid over the focused box (src/probes/keyboard/page.ts:652, src/probes/overlays.ts:736) and
\`obscuredBy\` (src/probes/keyboard/rules.ts:142) fails when all of them are covered; a 1 px strip lies between the last row of
points and the edge. *Two options for the lead:* (a) keep the letter of WCAG (anything showing is not "entirely hidden") and
compute the uncovered area exactly from rectangles (the focused box inside the viewport minus the union of the opaque fixed
or sticky boxes over it, \`elementsFromPoint\` only to confirm), or add sample rows 1 px inside each edge; (b) decide that a
strip of a few pixels does not make a control visible, write that line down (for example under 2 px or under 5% of the box
visible counts as hidden) in docs/scoring.md, and the lab's expectation follows it. (a) is the literal reading; (b) is closer
to what a person sees. Either way the 99% cases then agree with the declared rule.`,
  reflow: `### Causes and proposed fixes

1. **Dismissible floating content counts like a fixed bar (policy, for the lead).** A cookie banner with an Accept button
   (96 px, 42% of the 320×256 screen) and a survey panel with a Close button (75%) fail 1.4.10; the lab declares both pass,
   since the page is usable once they are dismissed. The overlays test excuses only a box that *is* a dialog with a close
   button, and only under half the screen (src/probes/overlays.ts:631, \`OVERLAY_LIMITS.dialogShare\`); a full-width bar is the
   page's header or footer only up to a third of the height (:416, \`barHeight\`). *Fix (if the lead agrees with the lab):*
   excuse any fixed box with a keyboard-reachable control named close, accept, dismiss or similar that removes it, at any
   share (the 2.4.11 test already tabs to it); keep failing non-dismissible boxes over the share. If the lead keeps the
   current rule, the lab's expectation for these cases flips and the doc should say so (docs/scoring.md, overlays).
2. **Clipped text 8 px past the edge is missed in 2 of 3 pages at 328 px** (font swap, scroll snap); found at 340 px and up,
   and found on every justified block that scrolls sideways. The cut is judged against the wide layout (\`newlyCut\`,
   src/probes/layout.ts:588); a swap of the web font between the two layouts changes the lines. *Fix:* measure both layouts
   after the fonts are ready (\`document.fonts.ready\`) and with the same font, or judge a cut by the text's own overflow
   at the narrow width.
3. ${LATE_MOUNT('Content mounted late was missing at one width and present at the other (not testable, or the cut not seen).')}

Lab corrections made after the first run (engine right, generator wrong): a field inside a padded paragraph overflowed by
8 px where the case said it fitted, button labels sat in the middle of the cut buttons, and the lazy-images gallery itself
was 1008 px wide. Those cases were re-run.`,
  'keyboard-trap': `### Causes and proposed fixes

1. **A trap that takes focus back a moment later (60 ms) is never found** (all 15 cases). The walk records where focus is
   right after each Tab (src/probes/keys.ts:14 \`pressTab\`, then the stop is read) and looks for a cycle in that sequence
   (src/probes/keyboard/traverse.ts:355 \`findCycle\`); focus has moved on when it is read and comes back afterwards, so each
   stop looks new. *Fix:* after a Tab, wait until focus has been on the same element for about 150 ms (bounded, say 400 ms)
   before recording the stop, and treat "focus left and came back without a key" as a cycle of one.
2. ${LATE_MOUNT('"Nothing on this page takes keyboard focus": the form had not mounted.')}

Immediate refocus on blur, a Tab key handler that swallows the key and a region that wraps with no exit were all found at
0 to 55 stops in; dialogs that close on Escape or with their button, roving-tabindex toolbars and plain forms passed.`,
  audio: `### Causes and proposed fixes

1. ${LATE_MOUNT('Sound that a script starts once the page has mounted was not playing when the test looked ("0 audio or video elements and 0 Web Audio contexts checked").')} The audio test should also look again after its first listen.
2. **A Web Audio tone of exactly 3 s is failed.** Web Audio is counted when it still sounds 3.2 s after the *page loaded*
   (src/probes/audio.ts:271–278, \`AUDIO_LIMIT_MS\` :22); the test resumes contexts the autoplay policy suspended, so the tone
   starts later than the load and is still sounding then. *Fix:* time it from the first audible sample (or from the
   context's resume), and count it when it still sounds 3 s plus about 250 ms after that.

Elements, scripts' Audio() and Web Audio of 2, 3, 3.5 and 6 s and loops, with no control, native controls, a working pause
button, a button that does nothing, or muted: every other case was right.`,
  motion: `### Causes and proposed fixes

No false failure. The misses:

1. **Motion that ran more than 5 s but has ended (or paused between steps) when the test looks again is passed.** The test
   finds the item, then judges it (src/probes/motion.ts:811–825 \`judgeItem\`): when \`stillMovingAll\` (:484) says it no longer
   moves, the result is "no failures found … no longer moving when the test came back" (:809, :823). A 5.5 s animation has
   ended by then (it ran from load); a carousel that changes every 1.5 s, and a blink that changes every 0.5 s, can look
   still in a window shorter than their step (\`stillChanging\`, :502–503), also after a control that does nothing ("the
   control 'Pause' stops it"). *Fix:* (a) for an item whose own timing says it runs more than 5 s (duration × iterations,
   or a timer that repeats), do not pass it for having stopped by itself: look for a pause, stop or hide control and fail
   when there is none or none works; (b) watch for at least one step of the item (its animation's period, its timer's
   interval, plus a margin; bounded, say 6 s) before deciding that it stopped, before and after a control is pressed.
2. ${LATE_MOUNT('The moving content was not there yet ("nothing moved … 0 animations").')}

Pausing on hover only and \`prefers-reduced-motion\` (which only helps people who set it) are correctly not accepted as
controls when the test does catch the item.`,
  pointer: `### Causes and proposed fixes

No false failure (60 of 60 pages with an alternative passed). The misses:

1. **Drag-only sorting that inserts the dragged item before the drop target is not exercised** (all 12). The test drags an
   item onto one sibling, dropping at 75% of its height (src/probes/pointerKit.ts:983–1010 \`dragItem\`, from
   src/probes/pointerGestures.ts:318 \`testItem\`); a list that inserts before the target does not change when the target is
   the next item, so nothing changed and no drag was found. *Fix:* when a drop changes nothing, drop once more on the other
   side (the previous sibling, or above the target's middle); keep landing only on sibling items.
2. ${LATE_MOUNT('No gesture handlers or draggable content were found: they had not mounted.')}

Swipe-only carousels, pinch-only maps, drag-only sliders and drag-only map panning were all found; prev/next, zoom,
increase/decrease, pan and move up/down buttons were all accepted.`,
  hover: `### Causes and proposed fixes

1. **A tooltip wider than its trigger is failed as "not hoverable" (51 of 56 good tooltips: false failures).** The test
   moves the pointer in a straight line from the trigger to the middle of the content (src/probes/hoverContent.ts:397, the
   point from :292–301, centre first). Under a small trigger with a wide tooltip below it, that diagonal leaves the trigger
   and its wrapper before it reaches the tooltip, so a tooltip that stays while the pointer is over the trigger or the
   tooltip (the usual and WCAG-conforming pattern) is hidden on the way. A person moves down into it. Checked by hand with
   Playwright on the lab's page: moving straight down keeps it, the diagonal loses it. *Fix:* move first to the content point
   nearest the pointer (the trigger's centre clamped into the content's box, 2 px inside), wait, then to the centre; fail
   only if the content disappears while the pointer is on it along that shortest path. Keep a gap of more than a few pixels
   between trigger and content failing, as it does now (the lab's not-hoverable pages, a 24 px gap, were all found).
2. ${LATE_MOUNT('No triggers were found: they had not mounted.')}

Not dismissible (no Escape) and not persistent (gone after 1.2 s) were found in every combination, by script and by CSS,
and native title tooltips passed.`,
  forms: `### Causes and proposed fixes

No false failure. A field marked only by a red border and a message that does not name the field were found on every
settled page; script messages that name the field and the browser's own required/type messages passed.

1. ${LATE_MOUNT('"No form fields on this page": the form had not mounted.')}

Out of reach by design (run, listed, not counted): forms whose errors only the server reports (our fixture answers 400
with the field named, or 500 with a generic page). The forms test never sends anything to a server (the request guard and
\`sendsNothing\`, src/probes/forms.ts), so it can only judge what the page does before submitting; server-side error
identification needs either a consented test mode against a staging endpoint or the AI forms review.`,

  // ---- Second lab report (test/sim-lab-2, engine hosted/integration 237c4348, variant `base`) ----

  'text-spacing': `### Causes and proposed fixes

Strong: fixed-height boxes that clip (overflow hidden) and boxes whose text runs into the next paragraph (overflow
visible) are found at every geometry and every loss from 14 to 48 px; scrolling boxes, boxes with \`min-height\`, and boxes
with room pass; one-line buttons, labels and tabs cut by the letter spacing are found and the roomy ones pass; and every
ACT-shaped inline declaration (\`letter-spacing\`, \`word-spacing\`, \`line-height\` with \`!important\`, in em and in px,
24afc2 / 9e45ec / 78fd32) is found by axe \`avoid-inline-spacing\`.

**To re-check: the real-site audit's "0/14" for 1.4.12.** The lab does not reproduce it: every ACT-shaped failing case
is found except on late-mounting pages. The likeliest cause is how the audit read the criterion for the W3C ACT examples
(which row, which method, which result counted as found), not the engine; the audit's figure should be re-checked against
its criterion reading before it is used.

1. **axe fails an !important letter spacing on an element with no text of its own (false failures, 2 of 3).** ACT 24afc2
   applies only to "any HTML element with one or more visible text node children"; axe-core 4.14's \`avoid-inline-spacing\`
   (selector \`[style]\`, matches \`avoid-inline-spacing-matches\`) also fails a wrapper \`<div style="letter-spacing: 0.05em
   !important"><p>…</p></div>\`, whose paragraph takes the user's spacing (its own value is not important). *Fix:* axe stays
   unmodified (MPL); drop \`avoid-inline-spacing\` nodes whose element has no visible text node child when the engine
   collects axe results (src/axeRun.ts:72, where violation nodes are mapped), or re-check each node in the page.
2. ${LATE_MOUNT('An inline !important declaration in content mounted after axe and the probe ran is not seen.')}`,

  'resize-text': `### Causes and proposed fixes

The lab judges 1.4.4 at 200% browser zoom (G142: "Using a technology that has commonly-available user agents that support
zoom"; F94 for viewport units; ACT b4f0c3 for the viewport meta). Text in vw, vh and vmin, the viewport meta (no
user-scalable, maximum-scale under 2) and rows pushed off a page that cannot scroll sideways are found; horizontal
scrolling alone passes, as it should (that is 1.4.10).

1. **The "text at 200%" pass fails text in rem inside a box sized in px (false failures, 17 of 18; the lead ruled
   2026-11-07: breaking only under a doubled root font size while zooming cleanly is a PASS, G142).**
   The first pass doubles the root font size alone (src/probes/resizeText.ts:165, \`rootFontScale: 2\`) and fails anything it
   cuts off (\`largeTextPlaces\`, :34–41, used at :171). Browser zoom scales the box with the text, so these pages zoom
   cleanly in every browser; WCAG's Understanding document puts the scaling on the user agent ("The author's
   responsibility is to create Web content that does not prevent the user agent from scaling the content effectively"),
   and G142 is sufficient. Real sites do this everywhere (cards, buttons, nav bars with a px height and rem text), which is
   the likeliest cause of the real-site 20% precision. *Fix:* report root-font-only breakage as advice (listed, not
   failed), and fail 1.4.4 only on what the zoom pass finds.
2. **Text entirely hidden at 200% zoom is not counted (missed, 10 of 15 vh boxes).** The zoom pass counts only text *partly*
   cut off (\`newlyCut(…, { partialOnly: true })\`, src/probes/resizeText.ts:68). A box \`30vh\` or \`40vh\` tall with overflow
   hidden halves at 450 px, and the lines that go are entirely hidden; only the 20vh box, whose last visible line is cut in
   half, is found. *Fix:* count entirely hidden items too when the container that hides them showed them at 100% and is not a
   carousel (the carousel skip at :67 stays), and not off-canvas (positioned out of the viewport at both sizes).
3. ${LATE_MOUNT('Text sized in vw, and rows that mount late, are measured before they exist.')}

**Round 4 (strict-tests-4, 2026-11-07): fixed.** Whole lines that 200% zoom hides in a box still at least a line tall
(\`vanishedLines\`: in flow, wholly shown at 100%, wholly clipped at 200%; not carousels, clamps or positioned content) fail
like partly cut text; the test waits for late content.`,

  headings: `### Causes and proposed fixes

Source: Understanding 1.3.1 lists H42 and ARIA12 as sufficient, G141 ("Organizing a page using headings") as advisory, and
F2, F43 and F92 as failures; nothing requires a level-1 heading or forbids skipping levels (a logical outline is 2.4.10,
AAA). 2.4.6 is about headings describing their sections (ACT b49b2e). Run with the core probes declared for both criteria
(headings, screen-reader), as a scan runs them.

1. **Skipped levels fail 1.3.1 (false failures: 7 of 8 skip-level pages and 7 of 8 out-of-order pages).** \`headingFindings\`
   fails 1.3.1 for any downward skip of two or more levels (src/probes/headings.ts:254–264). *Fix:* stop failing it; report
   it as advice (or under 2.4.10, which is AAA and outside the score).
2. **A page with no level-1 heading fails 2.4.6 (false failures, 8 of 8, and the late-mounting pages below).**
   src/probes/headings.ts:227–245. A page whose sections have descriptive h2s meets 2.4.6. *Fix:* advice, not a failure.
3. **Section titles styled as headings but not marked up are missed (F2, 18 of 18 divs), and so is \`h2 role="presentation"\`
   (F92, 18 of 18).** Only axe \`p-as-heading\` looks for F2, and only for paragraphs (16 of 18 bold \`<p>\` titles found; the
   two missed are late mounts). \`readHeadings\` drops a heading with role presentation silently (\`levelOf\`, :140–149).
   *Fix:* in \`readHeadings\`, list blocks that look like the page's headings (short, bold or at least 1.2× the body size,
   followed by body text, not inside a heading, link or button) and fail 1.3.1 when the page marks none of them up; fail
   native h1–h6 with role none/presentation whose text is shown as a heading.
4. **Headings that do not describe their sections are missed (2.4.6, 54 of 54: "Heading", "Section", "Untitled", "Lorem
   ipsum").** Nothing deterministic checks heading text; the AI page-text review is not run in the lab. *Fix:* fail a
   short list of placeholder texts outright (heading, title, section, untitled, lorem ipsum, "Section 1", "Text"), and
   leave the rest to the AI review.
5. **Empty headings (not counted).** The engine fails 2.4.6 for an empty h2 (:248–253). ACT ffd0e9 maps this to WAI-ARIA,
   not WCAG; the lab does not count it (the lead's ruling, 2026-11-07).
6. ${LATE_MOUNT('"The page has no headings at all": the headings had not mounted (2 false 2.4.6 failures, 2 missed F2 titles).')}

**Round 4 (strict-tests-4, 2026-11-07): fixed.** Causes 3 and 4 and the late mounts: F92 (an h1–h6 made presentational
that still shows as a heading: letters, not smaller than the body text, no controls inside), F2 (on a page with no heading
below level 1, two or more short bold or larger lines followed by plain body text, outside headings, links, lists, tables,
forms and landmarks other than main) and template placeholder heading text for 2.4.6 ("Heading", "Section", "Untitled",
"Lorem ipsum…"). The runner's content wait now also holds for any shown \`aria-busy="true"\` part of main (once per
page). The lab now declares form-fields too (1.3.1's sources include it). The lab's 2.4.6 failures are all placeholders:
real but vague headings ("More", "Updates") stay with the AI page-text check.

**Sol round 2 (lead's ruling, strict-tests-4-sol2): F2 and F92 are AI-review cases.** The test lists them as
recommendations and never scores them; their cases (div-titles, bold-p-titles, presentation-role) are \`any\` here, out of
deterministic recall, not relabelled as passes. 2.4.6 scores only template residue and lorem ipsum filler; every
vague-titles page holds one "Lorem ipsum" heading, which is what the 2.4.6 rows measure.`,

  'form-labels': `### Causes and proposed fixes

Run with the core probes declared for these criteria (headings, aria-states, screen-reader, form-fields,
screen-reader-live). Fields named only by aria-label or title, and fields with nothing at all, fail 3.3.2; fields without
a programmatic name fail 4.1.2 (axe \`label\`); labelled fields, prompts in selects, prefilled values, hidden fields,
fieldsets, required marks and G167 search boxes pass.

1. **A visible label that is not associated with its field is not a 1.3.1 failure in the engine (missed, 52 of 52; F111).**
   F111: "Failure of Success Criteria 1.3.1, 2.5.3, and 4.1.2 due to a control with visible label text but no accessible
   name". axe \`label\` and \`select-name\` are mapped to 4.1.2 only (src/report/criteria.ts:126–129 and :148–153), and the
   form-fields probe already knows the visible text (\`nearby\`, src/probes/formsPage.ts:564). *Fix:* when a field has no
   accessible name and has visible text right before it (or after a check box), fail 1.3.1 as well (one finding per field),
   from the form-fields probe.
2. **G167 counts only in search forms (false failures, 6 of 6).** A select named by aria-label with an adjacent "Get form
   for state" button (G167 example 3) fails 3.3.2: \`labelFindings\` skips search forms only (src/probes/forms.ts:576) and
   fails any other field with no visible label (:581). *Fix:* treat a field as labelled when it has an accessible name and
   the next control in reading order is a button whose visible text names its purpose (G167's two checks: adjacent in the
   reading order, and the button has a name).
3. **Radio buttons with no visible question pass 3.3.2 (missed, 13 of 13).** "Yes" and "No" are each a visible label
   (:581), and the legend check (:583) only runs for buttons without one. *Fix:* for a radio group (or check boxes sharing a
   name), require a visible group label: a legend, an aria-labelledby group label, or visible text right before the group;
   fail when the only text is the options' own labels.
4. **Not counted (the lead's ruling, 2026-11-07): placeholder-only labels and unmarked required fields.** The engine
   fails 3.3.2 for a placeholder used as the only label (7 of 8) and for a required field with no visible mark (8 of 8,
   \`minor\`, :592–609); no WCAG failure technique names either. *Fix (ruled):* report both as recommendations, not
   failures. Also not counted: G167 without a name for 1.3.1 (4.1.2 covers the missing name), and the split phone number
   for 3.3.2 and 1.3.1.
5. ${LATE_MOUNT('The subject field mounted after the form-fields probe read the form (3 missed 3.3.2 failures, 1 missed 4.1.2).')}

**Round 4 (strict-tests-4, 2026-11-07): fixed.** Causes 1–3 and the late mounts: form-fields fails 1.3.1 for a field with
no name at all and visible text right before it (F111), accepts G167 for any field (the next control is a visible button
repeating a word of the field's name), and fails 3.3.2 once for a radio group of bare answers (Yes/No, ratings, numbers)
with no question shown; it waits for late content. Left: one 4.1.2 late mount (axe's own settle).`,

  'target-size': `### Causes and proposed fixes

axe \`target-size\` is exact on the spacing rule: every row and column of undersized buttons, icon links and restyled
check boxes whose 24 px circles intersect (s + g < 24, s from 12 to 23, gaps 0 to 4 px) is found, and every one that
clears it, every 24 px target, inline links in sentences and the browser's own check boxes and radio buttons pass.

1. **The Equivalent exception is not known (false failures, 3 of 4).** A 16 px icon toolbar (Bold, Italic, Underline) whose
   three functions are also full-size buttons on the page fails: 2.5.8 is axe-only (src/report/criteria.ts:144). *Fix:*
   after axe, drop an undersized target when another control on the page with the same accessible name (or the same
   \`aria-controls\`/\`form\` action) meets 24×24.
2. ${LATE_MOUNT('Targets mounted after axe ran are not measured (3 missed).')}

User agent controls: the browser's own unstyled check boxes and radio buttons pass under the "User agent control"
exception (the lead's ruling, 2026-11-07). axe agrees today.`,

  'focus-order': `### Causes and proposed fixes

No false failure from the rule itself; positive tabindex in the visual order, extra tabindex 0 and -1, and two-column
layouts read column by column pass.

1. **Only jumps of more than a screen are seen (missed: positive tabindex shuffles 16 and 120 px apart, 12 of 12, two of them late mounts; found at 400 and 1000 px).** The
   F44 rule needs the next stop more than a viewport height above (src/probes/keyboard/rules.ts:329) and not to the right
   (:330). Fields 3, 1, 4, 2 in a form are out of order however close they sit. *Fix:* compare the Tab sequence with the
   visual reading order inside one container (form, nav, list, fieldset): consecutive stops where at least one has a positive
   tabindex and the second is visually before the first (above by more than half a line, or on the same line and to the left
   in a left-to-right page) fail, at any distance.
2. **Visual order changed by CSS is not checked (missed: steps 1–4 shown left to right and focused 4 to 1 with
   \`row-reverse\`, 14 of 14; a Send button shown last and focused first with \`order\`, 14 of 14; one of each a late mount).** Only positive tabindex
   and the footer-before-main rule (:296) are looked at. *Fix:* the same comparison for siblings whose container uses
   \`flex-direction: *-reverse\`, \`order\`, or grid placement that differs from the DOM order (C27).
3. **A focused field snapped off screen on a mandatory scroll-snapping page is not counted for 2.4.3** (the lead's ruling,
   2026-11-07: it is a 2.4.11 matter, not focus order). On \`natural/400px/scroll-snap\` focusing a field between snap points
   lets the browser snap it off screen, and the engine reports "focus disappears from view" under 2.4.3 (\`hiddenFindings\`,
   src/probes/keyboard/findings.ts:80–101). *Fix:* report focus hidden by scrolling or snapping under 2.4.11 (or 2.4.7),
   not 2.4.3.
4. ${LATE_MOUNT('"Not applicable": the fields had not mounted.')}

**Round 4 (strict-tests-4, 2026-11-07): fixed.** Causes 1–3: in one container (form, list, menu, navigation, table…),
consecutive stops where a positive tabindex or CSS order (reversed flex, \`order\`) is the cause and the next stop is shown
before the last fail at any distance; a stop scroll snapping leaves off screen is 2.4.11 (and keeps its place in the order
check). Left: the late mounts (the keyboard test does not wait for content: a question for the lead).

**Sol rounds 1 and 2 (lead's rulings, strict-tests-4-sol1/-sol2): CSS reorder is an AI-review case.** Focus that
follows the HTML while CSS shows another order (reversed-steps, submit-first) is listed as a recommendation, never
scored; those cases are \`any\` from strict-tests-4-sol2, out of deterministic recall. Left: the late mounts (the
late-mount branch adds a keyboard second look).

**Per family (Sol round 3: the two families are reported apart; the headline rows mix populations).**

| run | F44 positive tabindex (deterministic) | CSS reorder: reversed-steps, submit-first (AI review, \`any\` from sol2) |
|---|---|---|
| strict-tests-r3 | 11 / 24 failed (shuffle only; 3 late mounts) | 0 / 28 failed |
| strict-tests-4 | 21 / 24 | 27 / 28 (then scored; ruled out in Sol round 1) |
| strict-tests-4-sol1 | 21 / 24 | 0 / 28 (a recommendation) |
| strict-tests-4-sol2 | 46 / 52 (one pattern repeated: padding, withdrawn) | 0 / 28 |
| strict-tests-4-sol3 | 45 / 52 by three mechanisms: shuffle down a form 24, shuffle along a row 14, one late control first 14 | 0 / 28 |

Every F44 miss in sol3 is a late mount (7 of 52); on settled pages the family is 45 / 45. The CSS-reorder cases are
listed as recommendations and left to the AI focus-order review.`,

  'key-shortcuts': `### Causes and proposed fixes

No false failure: Ctrl/Alt shortcuts, a type-ahead active only on focus, a "Keyboard shortcuts" switch (on, or off by
default), Escape, arrow and function keys, and a listener that only counts keys all pass.

1. **Only 16 keys are pressed (missed, 32 of 32 shortcuts on other keys).** \`SHORTCUT_KEYS\` (src/probes/keyboard/rules.ts:469)
   is \`/ ? s k j f m c t n p g h e l x\`; shortcuts on a, b, q, r, w, z, 1 and "." are never tried, and every shortcut on
   the listed keys is found. *Fix:* when a keydown/keypress handler sits on the window, document or body, press every
   printable key (a–z, 0–9 and the punctuation on a US keyboard, in batches of 4 as now, about 12 batches), or read the
   handler's source (\`Function.prototype.toString\` through the listener hook) for the keys it compares (\`e.key === 'x'\`,
   \`keyCode === 88\`) and press those first.
2. ${LATE_MOUNT('"No keyboard handlers on the page as a whole": the handler was added after the probe looked.')}

**Round 4 (strict-tests-4, 2026-11-07): fixed.** Every lower-case letter, digit and US punctuation key is pressed (six to
a batch), the test waits for late content, and a DOM change is always confirmed by a second press after a quiet window
(real sites: a carousel tick met a key press).`,

  timing: `### Causes and proposed fixes

Script redirects, reloads, meta refresh (to another page and to itself), session warnings and alerts with no way to
extend are found at every delay from 5 s to 2 h; a warning with "Stay signed in", a confirm() that extends, a redirect
after 21 h and timers that only update a clock or a tip pass.

1. **A "Turn off automatic sign-out" control is not recognised (false failures, 9 of 10).** \`limitControls\`
   (src/probes/timing.ts:121–132) asks \`kit.controls\` for names of at most four words, all from \`EXTEND_VOCAB\`
   (:124; src/probes/kit.ts:251–253), and \`FORBIDDEN\` (src/probes/kit.ts:230) rejects any name containing "sign out" or "log
   out", even when only looking (\`lookOnly\`). *Fix:* in look-only mode, accept names that pair a turn-off or extend verb
   (turn off, disable, stop, extend, keep, stay) with a time-limit noun (automatic sign-out, log-out, time-out, timer,
   session), however many words; keep \`FORBIDDEN\` for clicking.
2. **Timers started by a timer are not run (missed, 4 of 4 late-mounting pages at 60 s).** \`fireAll\` runs the timers
   pending once (src/probes/timing.ts:54, called at :235); the page's mount timer ran early, set the 60 s time limit, and that
   one was never run ("1 timer of 1 s to 20 h run early"). *Fix:* run \`fireAll\` again (up to 3 rounds) while the previous
   round started new timers of 1 s or more.`,

  orientation: `### Causes and proposed fixes

Every orientation lock is found in both directions (a full-screen "rotate your device" message by CSS or by script, a
quarter turn by CSS, the main content hidden), and every page whose content stays (columns, a small "best viewed in"
hint, navigation folded into a menu, a table shown as a list) passes.

1. **A page that mounts late looks locked to landscape (false failures, 3 of 3 such passing pages).** Portrait is read at
   once (src/probes/orientation.ts:169), landscape after a 400 ms wait (:174); content mounted in between is counted as
   hidden in portrait. *Fix:* read portrait again after landscape and use the later reading (or require both portrait
   readings to agree), on top of the quiet-DOM wait below.
2. ${LATE_MOUNT('The same pages (1 missed lock).')}`,

  'pointer-cancel': `### Causes and proposed fixes

Every down-event function is found (div buttons, spans and buttons; pointerdown and mousedown; showing, hiding, changing
text, toggling aria-pressed and navigating), and click, pointerup, press-and-hold with up reversal, a pressed look and
tracking-only handlers pass.

1. ${LATE_MOUNT('"No element on the page reacts to pressing down": the handlers were added after the probe looked (6 missed).')}`,

  'motion-actuation': `### Causes and proposed fixes

Shake and tilt functions with no button, and with a button but no way to turn the motion off (F106), are found; parallax
and listeners that do nothing pass.

1. **An off switch that is a check box is not found (false failures, 19 of 22).** \`findOff\` (src/probes/actuation.ts:143–159)
   asks \`controlsFor\` with \`MOTION_OFF_VOCAB\` (src/probes/kit.ts:389), whose candidates are buttons and links only
   (\`SEL\`, src/probes/kit.ts:245) and whose names must be made only of vocabulary words (:253): "Shake to undo" and "Tilt to
   change slides" check boxes are never candidates ("to", "undo", "change", "slides" are not in the list). *Fix:* include
   \`input[type=checkbox]\`, \`[role=switch]\` and \`[role=checkbox]\` in the off-control search, and accept a name that
   contains a motion word (shake, tilt, motion, gesture) whatever else it says; checking that the motion then does nothing
   (:154–156) already guards against a wrong control.
2. ${LATE_MOUNT('"The page does not listen for device motion": the listener was added after the probe looked (4 missed).')}`,
  'media-files': `### Causes and proposed fixes

The test fails a video only on proof (speech measured in its sound, no captions the page gives, nothing that
could be writing in any frame sampled while speech is heard, and no captions when the page's own video is
played for a moment), so its misses are by design or by timing:

1. **Writing in the picture that it cannot read (9 missed, by design).** Speech over footage, captions in the
   picture for the last sentence only, one burned-in line: marks in a frame are "not testable", because the same
   marks may be open captions. Reading them is the AI media review's (docs/redteam-triage-media.md, idea 1).
2. **A player page in a frame that the page mounts late (4 missed; the 3 passing cases of that kind are "not
   applicable").** The test read the page before the frame was there and found no video. It waits for a
   same-site frame that is in the page and still loading (\`framesLoading\`, src/probes/mediaFiles.ts), not for
   one that is not in the page yet.
3. **Undecided look-alikes (127, no error).** Open captions (also along the frame's last rows and in small
   letters in a large frame), speech played backwards, a voice without words, music, a tune, the words shown
   under the video by a script while it plays, a first file the scan's browser cannot play and a labelled video
   version of the page's text are "not testable", never failed. Captions a script adds as a track when the video
   first plays (24 cases: from the end of a bundle longer than the scan reads, from a module the page imports)
   give no finding: the test plays the video before it files anything, and the captions come.
4. **Long recordings (8 of 8 found).** 36 s in six channels and 70 s in an MP4 with its index at its end are
   measured from a cut of the file (src/media/container.ts) and failed like the short ones.`,
  'media-alternatives': `### Causes and proposed fixes

No wrong case. The test fails a sound-only item with no transcript or text alternative beside it only when it is
shown to be a recording: the browser read a set length for its file (the page's own player, or, for a player that
had not loaded and for a linked file, an audio element the test never adds to the page).

1. **Streams (12 passing cases: 8 "not testable", 4 "not applicable").** A stream with no end is "not testable"
   (it may be live; 1.2.1 covers recordings only). The 4 linked ones are "not applicable": the link's file name
   does not end in a sound file's extension, so it is not read as a sound file at all.
2. **A recording the page calls live (4 cases, a judgement, not counted): "not testable".** The first run failed
   one of them: its heading, player and the words "Listen live" had no space between them in the markup, and the
   words were read from the text run together. They are read from the text as it is laid out since
   (\`pageMedia\`, src/probes/mediaPlayers.ts).`,
};
