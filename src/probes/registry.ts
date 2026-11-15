// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The built-in probes, one line each, in the order they run on a page (Plan 4 Tasks 4.1–4.8 add them).
import { motionActuationProbe } from './actuation.js';
import { ariaStatesProbe } from './ariaStates.js';
import { audioProbe } from './audio.js';
import { controlsProbe } from './controls/index.js';
import { flashProbe } from './flash.js';
import { flashMotionProbe } from './flashMotion.js';
import { forcedColorsProbe } from './forcedColors.js';
import { formFieldsProbe, formsProbe } from './forms.js';
import { headingsProbe } from './headings.js';
import { hoverContentProbe } from './hoverContent.js';
import { keyboardDeepProbe, keyboardProbe, keyShortcutsProbe } from './keyboard/index.js';
import { languagePartsProbe } from './languageParts.js';
import { linkColorProbe } from './linkColor.js';
import { linkPurposeProbe } from './linkPurpose.js';
import { mediaAlternativesProbe, mediaFilesProbe } from './mediaFiles.js';
import { mediaPlayersProbe } from './mediaPlayers.js';
import { motionProbe } from './motion.js';
import { namesProbe } from './names.js';
import { nonTextContrastProbe } from './nonTextContrast.js';
import { orientationProbe } from './orientation.js';
import { pageTitlesProbe } from './pageTitles.js';
import { picturesProbe } from './pictures.js';
import { overlaysProbe } from './overlays.js';
import { pointerCancellationProbe } from './pointerCancellation.js';
import { pointerGesturesProbe } from './pointerGestures.js';
import { reflowProbe } from './reflow.js';
import { resizeTextProbe } from './resizeText.js';
import { routeTitlesProbe } from './routeTitles.js';
import { timingEntryProbe } from './timingEntry.js';
import { screenReaderLiveProbe, screenReaderProbe } from './screenReader/index.js';
import { textContrastProbe } from './textContrast.js';
import { textSpacingProbe } from './textSpacing.js';
import { stateTextProbe } from './stateText.js';
import { timingProbe, timingWatchProbe } from './timing.js';
import type { PageProbe } from './types.js';

// Probes with the same context options share a page (runner.groupProbes); order matters only within a page.
export const PROBES: readonly PageProbe[] = [
  headingsProbe, // 1.3.1 + 2.4.6, render, core, every page (desktop page, first: reads the DOM, leaves no change; site-wide main heading across pages)
  pageTitlesProbe, // 2.4.2, render, core, every page, not scored (desktop page: reads the title and the main heading; titles that name nothing, or another page, across the scanned pages)
  linkPurposeProbe, // 2.4.4, render, core, every page (desktop page: reads the DOM, leaves no change)
  ariaStatesProbe, // 4.1.2, render, core, every page (desktop page: reads the DOM, leaves no change)
  languagePartsProbe, // 3.1.1 + 3.1.2, render, core, every page (desktop page: reads the DOM, leaves no change; listed, not scored)
  namesProbe, // 1.1.1 + 2.5.3, render, core, every page (desktop page: reads the DOM, leaves no change; listed, not scored)
  mediaFilesProbe, // 1.2.2, render, core, every page (desktop page: reads the page's own videos; measures a video's sound and frames from a copy it never adds to the page; a proof-only test, score.ts PROOF_ONLY_PROBES)
  mediaAlternativesProbe, // 1.2.1, render, core, every page (desktop page: sound-only players and files and the text next to them; listed, not scored)
  picturesProbe, // 1.1.1 + 1.4.5, render, core, every page (desktop page: reads the words SVG pictures draw and draws the files on a canvas of its own, off the page; leaves no change; listed, not scored)
  screenReaderProbe, // 1.3.1, 1.3.2, 2.4.4, 2.4.6, 4.1.2: what a screen reader hears, from Chromium's accessibility tree (desktop page; reads only; listed, not scored)
  textSpacingProbe, // 1.4.12, render, core (desktop page; leaves no change)
  resizeTextProbe, // 1.4.4, render, core (desktop page; restores the viewport)
  reflowProbe, // 1.4.10, render, core (desktop page; restores the viewport)
  textContrastProbe, // 1.4.3, pixels, core, every page (desktop page; axe's undecided text only; restores the viewport)
  nonTextContrastProbe, // 1.4.11, pixels, core (desktop page; leaves no change)
  linkColorProbe, // 1.4.1, interaction, core (desktop page; hovers and focuses, then blurs)
  orientationProbe, // 1.3.4, render, core (phone context)
  keyboardProbe, // 4.1: 2.1.1, 2.1.2, 2.4.1, 2.4.3, 2.4.7, 2.4.11, 3.2.1 (desktop page, after the render and contrast probes: it presses keys and may reload)
  keyShortcutsProbe, // 4.1: 2.1.4
  overlaysProbe, // 1.4.10 + 2.4.11, render, core (own page: laid out at 320 px and 390 px, it scrolls the whole page and presses Tab, which can load content or open panels)
  formFieldsProbe, // 4.6: form fields, core (keep after the other core probes that share its page: it pastes into fields)
  screenReaderLiveProbe, // 3.3.1, 4.1.2, 4.1.3: live announcements (opens menus, submits forms empty; network shut, its own page after form-fields; listed, not scored)
  hoverContentProbe, // 1.4.13, interaction, deep (own page)
  forcedColorsProbe, // C13: 1.4.3, 1.4.11, 2.4.7 in forced colours (Windows contrast themes), render, deep, own page, not scored
  stateTextProbe, // batch 18 D13/D14: 1.4.3 for text shown later by a timer and in regions a control opens, interaction, deep, own page, not scored
  keyboardDeepProbe, // 4.1 (deep, --full): long pages, up to 300 Tab stops each way
  controlsProbe, // 2.1.1, 2.1.2, 2.4.3, 2.4.11, 4.1.3, interaction, deep, not scored (own page, strict guard: presses the page's own controls with the keyboard and the mouse, then judges what the press left)
  routeTitlesProbe, // 2.4.2, interaction, deep, not scored (own page: follows the page's own links and reads the title after a client-side page change)
  timingEntryProbe, // 2.2.1, interaction, deep, not scored (own page, nothing sent: types into text fields, presses plain buttons and runs the page's timers early)
  pointerCancellationProbe, // 2.5.2, interaction, deep (desktop page, last: after form-fields it gets a fresh page; strict guard; presses, then Escape if a press changed the page)
  formsProbe, // 4.6: forms, deep (isolated: it fills and submits fields)
  pointerGesturesProbe, // 2.5.1 + 2.5.7, interaction, deep (own page with a touch screen)
  // Task 4.4 (motion, timing, audio). The core four share one page with prefers-reduced-motion off.
  // timing runs last: it runs every timer of 1 s to 20 h early, which can pause media or stop a
  // carousel for good. When motion already ran timers early, timing gets the page loaded again
  // (`freshAfterFiredTimers`), since their warnings and redirects are spent.
  flashMotionProbe, // 2.3.1 without frames of the screen, deep, not scored (first on the motion page: it only reads it)
  audioProbe, // 1.4.2, core
  motionProbe, // 2.2.2, core
  motionActuationProbe, // 2.5.4, core (shaking may change the page)
  timingProbe, // 2.2.1, core (last)
  flashProbe, // 2.3.1, deep, own page
  timingWatchProbe, // 2.2.1, deep, own page (20 s of real time)
  mediaPlayersProbe, // 4.8: 1.2.1–1.2.5, deep, own page (plays embedded players muted; also on every page with media)
];

/** The registry's core probes, plus the deep ones with `full`. */
export function probesFor(opts: { full?: boolean } = {}): PageProbe[] {
  return PROBES.filter((p) => p.tier === 'core' || opts.full);
}

/**
 * The probes whose results are scored (scoring v8, docs/scoring.md): every registry probe, core and deep,
 * except those marked `scored: false` (they run and are listed). A deep probe counts only when it ran
 * (`--full`). Probes passed in from outside the registry never are.
 */
export const SCORED_PROBES: ReadonlySet<string> = new Set(PROBES.filter((p) => p.scored !== false).map((p) => p.id));
