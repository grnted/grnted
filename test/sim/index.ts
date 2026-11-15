// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The lab's tests, by id (`pnpm sim -- --test <id>`), in the order the scorecard lists them.
import { controlsKeyboardTest, controlsOpenedTest, controlsStatusTest } from './tests/controls.js';
import { flashTest } from './tests/flash.js';
import { focusObscuredTest } from './tests/focusObscured.js';
import { controlsFramesTest, keyboardFramesTest } from './tests/frames.js';
import { controlsFrameLoopTest } from './tests/frameLoop.js';
import { sortKeyboardTest } from './tests/sortKeyboard.js';
import { formLabelsTest } from './tests/formLabels.js';
import { headingsTest } from './tests/headings.js';
import { hoverTest, keyboardTrapTest, pointerTest } from './tests/interaction.js';
import { focusOrderTest, keyShortcutsTest } from './tests/keyboardMore.js';
import { formsTest } from './tests/forms.js';
import { formsIdentifyTest, formsStatusTest, formsSuggestTest } from './tests/formsAct.js';
import { controlsChooseTest } from './tests/controlsChoose.js';
import { mediaAlternativesTest, mediaFilesTest } from './tests/mediaFiles.js';
import { keyboardListenersTest } from './tests/listenerAlone.js';
import { timingEntryLimitsTest, timingLimitsTest } from './tests/timingLimits.js';
import { pointerCancelHoverTest } from './tests/pointerHover.js';
import { hoverNotActionTest } from './tests/hoverNotAction.js';
import { motionEndedTest } from './tests/motionEnded.js';
import { hoverEscapeTest } from './tests/hoverEscape.js';
import { formsLiveTest } from './tests/formsLive.js';
import { audioTest, motionTest } from './tests/motionAudio.js';
import { audioProofTest } from './tests/audioProof.js';
import { nonTextContrastTest } from './tests/nonTextContrast.js';
import { pictureAltTest, pictureBackgroundTest, pictureBlockTest, pictureHiddenTest, pictureKindTest } from './tests/pictureText.js';
import { pictureControlTest, pictureOwnFileTest } from './tests/pictureNames.js';
import { motionActuationTest, pointerCancelTest } from './tests/pointerMotion.js';
import { reflowTest } from './tests/reflow.js';
import { resizeTextTest } from './tests/resizeText.js';
import { targetSizeTest } from './tests/targetSize.js';
import { textContrastTest } from './tests/textContrast.js';
import { textSpacingTest } from './tests/textSpacing.js';
import { timingEntryTest } from './tests/timingEntry.js';
import { orientationTest, timingTest } from './tests/timingOrientation.js';
import { ariaDefaultsTest, forcedFocusTest, linkContextTest, skipControlTest, tableCaptionTest } from './tests/w3cPrecision.js';
import { headingDrawnTest, headingPeerTest, headingRepeatedTest, frameRolelessTest, orderPicturedTest, siteHeadingTest, tableDatesTest, titleSiteTest, toggleHiddenTest } from './tests/structure.js';
import { b18ChartTest, b18ClipSweepTest, b18ColorModesTest, b18ColourOnlyTest, b18DrawnControlsTest, b18FocusTruthTest, b18FocusWriterTest, b18LostNarrowTest, b18PseudoRingsTest, b18ScrollLinesTest, b18StateTextTest, b18WideTextTest } from './tests/b18Visual.js';
import { b18CommitTest, b18ErrorsTest, b18LabelsTest, b18StepsTest } from './tests/b18Forms.js';
import { b19KeypadTest, b19OnInputTest, b19OrderTest, b19PauseTest } from './tests/b19Precision.js';
import type { SimTest } from './types.js';

export const SIM_TESTS: readonly SimTest[] = [
  flashTest, textContrastTest, nonTextContrastTest, focusObscuredTest, reflowTest,
  keyboardTrapTest, motionTest, audioTest, hoverTest, pointerTest, formsTest,
  // Second lab report (test/sim-lab-2).
  textSpacingTest, resizeTextTest, headingsTest, formLabelsTest, targetSizeTest,
  focusOrderTest, keyShortcutsTest, timingTest, orientationTest, pointerCancelTest, motionActuationTest,
  // Accuracy round (2026-11): the controls test.
  controlsKeyboardTest, controlsStatusTest, controlsOpenedTest, timingEntryTest,
  // W3C precision lane (2026-11-11): the decision paths the W3C ACT cases showed failing what was not shown to fail.
  ariaDefaultsTest, tableCaptionTest, linkContextTest, skipControlTest, forcedFocusTest,
  // Keyboard-op lane (2026-11-11): controls inside the page's own frames.
  controlsFramesTest, keyboardFramesTest, sortKeyboardTest,
  // Its fix round 1: the controls test's focus loop inside a frame's own content.
  controlsFrameLoopTest,
  // Act and watch (2026-11-11): the forms test's filled-in attempt, unidentified errors and missing suggestions.
  formsStatusTest, formsIdentifyTest, formsSuggestTest, controlsChooseTest,
  // Structure lane (batch 17, 2026-11-12): text shown as a heading (three proofs on the page, one across the site),
  // date spans in tables shown without header cells, a toggle state hidden from assistive technology, generic titles across a site.
  headingPeerTest, headingRepeatedTest, headingDrawnTest, siteHeadingTest, tableDatesTest, toggleHiddenTest, titleSiteTest,
  // Its fix round (Sol review S7, S8, S9; the lead's ruling (c)): the names test inside frames, reading order and pictures.
  frameRolelessTest, orderPicturedTest,
  // Batch 17, media lane: a video with speech and no captions; a sound-only recording with no transcript.
  mediaFilesTest, mediaAlternativesTest,
  // Batch 17, lane images: the picture test's five decisions.
  pictureBlockTest, pictureAltTest, pictureHiddenTest, pictureKindTest, pictureBackgroundTest,
  // A click listener alone never proves a control (2026-11-12): the keyboard walk's 2.1.1 rule on charts and drawings.
  keyboardListenersTest,
  // Batch 17, item 8 (motion-pointer): the 2.2.1 precision audit: a failure shows a limit on the visitor's own task.
  timingLimitsTest, timingEntryLimitsTest,
  // Batch 17 (motion-pointer): a hover tooltip is no outcome of a press (2.5.2).
  pointerCancelHoverTest, hoverNotActionTest, motionEndedTest, hoverEscapeTest,
  // Self-updating live data is never a form's answer (batch 17): the forms test beside arrival times and rotating alerts.
  formsLiveTest,
  // Batch 18, lane media: 1.4.2's proof (the lead's ruling 12): a sound is failed only when nothing left could stop it.
  audioProofTest,
  // Batch 18, lane images: the names test's two exact 1.1.1 paths (the lead's rulings 1 and 2).
  pictureControlTest, pictureOwnFileTest,
  // Batch 18, visual lane (docs/atlas/visual.md): the new decision paths, across the atlas's variant space.
  b18FocusTruthTest, b18ColorModesTest, b18ColourOnlyTest, b18ChartTest, b18ClipSweepTest, b18LostNarrowTest, b18StateTextTest, b18DrawnControlsTest, b18WideTextTest, b18PseudoRingsTest, b18ScrollLinesTest, b18FocusWriterTest,
  // Batch 18, forms lane (docs/atlas/forms.md): the new decision paths across the atlas's variant space.
  b18StepsTest, b18LabelsTest, b18ErrorsTest, b18CommitTest,
  // Batch 19, precision lane: the look-alikes WCAG allows for the criteria that false-alarmed on unseen sites.
  b19PauseTest, b19KeypadTest, b19OrderTest, b19OnInputTest,
];

export const simTest = (id: string): SimTest | undefined => SIM_TESTS.find((t) => t.id === id);
