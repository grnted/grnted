// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Probes (Plan 4): automated interaction and render tests on the template sample, in a fresh,
// guarded browser context. Engine core: no Node-only or AI imports.
export { PROBES, SCORED_PROBES, probesFor } from './registry.js';
export { motionActuationProbe } from './actuation.js';
export { audioProbe } from './audio.js';
export { flashProbe } from './flash.js';
export { flashMotionProbe, flashPrecedence } from './flashMotion.js';
export { motionProbe } from './motion.js';
export { timingProbe, timingWatchProbe } from './timing.js';
export {
  createProbeRunner, groupProbes, probeData, runProbes, CANCELLED, DEFAULT_PROBE_VIEWPORT, LEFT_BY_ITSELF, MAX_PROBE_SLOTS, NO_GUARD, STOPPED_AFTER, UNSETTLED_AFTER, PROBE_DATA_MAX_CHARS, PROBE_DEFAULTS, TIME_LEFT,
  type OptionalSkip, type ProbeGroup, type ProbeGroupTiming, type ProbeRunner, type ProbeRunnerOptions, type ProbeTarget,
} from './runner.js';
export { picturesProbe, PICTURES_PROBE_ID } from './pictures.js';
export { judgePictures, drawnOf, givenShare, PICTURE_RULES } from './pictureJudge.js';
export { measureSvgPictures, readPictures, PICTURE_LIMITS } from './pictureText.js';
export { blockedReason, decideRequest, guardStop, installGuard, isActionUrl, sameDocument, type Guard, type GuardDecision, type GuardPhase, type GuardRequest } from './guard.js';
export { LISTENER_HOOK_SCRIPT, LISTENER_TYPES, MIN_TIMER_MS, listenerHookScript, newPopupNonce, popupReportPrefix, readHooks, readListeners } from './listeners.js';
export { compareCriteria, probeCriteriaResults, worstStatus, PROBE_EVIDENCE_CAP, STATUS_RANK } from './criteria.js';
export { pageShapeOf, templateProbes, PROBE_SAMPLE_SIZE, type TemplateProbes } from './sample.js';
export {
  capturePlanInput, mergePlanned, navSummary, plannedFor, resolvePlan, KIND_TESTS, PLAN_CAPTURE, PLANNED_TESTS, TARGET_KINDS,
  type NavElement, type NavigatorHook, type NavigatorInput, type NavSummary, type PlanEvent, type PlannedTarget, type RawPlan, type TargetKind, type TargetPlan,
} from './plan.js';
// Render probes (Task 4.2).
export { textSpacingProbe } from './textSpacing.js';
export { resizeTextProbe, ZOOM_MIN_RATIO } from './resizeText.js';
export { reflowProbe, REFLOW_VIEWPORT, REFLOW_VERTICAL_VIEWPORT } from './reflow.js';
export { orientationProbe, ROTATE_MESSAGE, ORIENTATION_LIMITS } from './orientation.js';
export { hoverContentProbe, HOVER_LIMITS, HOVER_TIMING } from './hoverContent.js';
export { OVERLAP, TEXT_SPACING_CSS, type LayoutItem, type LayoutState, type LayoutView } from './layout.js';
// Contrast probes (Task 4.3).
export { textContrastProbe, CONTRAST_RULES, TEXT_CONTRAST_LIMITS } from './textContrast.js';
export { nonTextContrastProbe, NON_TEXT_LIMITS } from './nonTextContrast.js';
export { linkColorProbe, LINK_COLOR_LIMITS, LINK_TEXT_THRESHOLD } from './linkColor.js';
export {
  boundaryContrast, changeContrast, contrastRatio, decodePng, isLargeText, relativeLuminance, textContrast, textThreshold, NON_TEXT_THRESHOLD,
  type BoundaryVerdict, type ChangeVerdict, type Rgb, type Rgba, type RgbaImage, type TextShots, type TextVerdict,
} from './pixels.js';
export {
  FORM_FIELDS_CRITERIA, FORM_FIELDS_PROBE_ID, FORMS_CAPS, FORMS_CRITERIA, FORMS_MAX_FRAMES, FORMS_PROBE_ID, PASTE_TEXT, SERVER_ONLY, TEST_MARK, authFindings, fieldTarget,
  fitEvidence, formFacts, formFieldsProbe, formSig, formTarget, formsProbe, invalidValue, isGenericError, isOtpField, isSensitiveField, judgeAttempt, judgeOnInput, labelFindings,
  preventionFindings, purposeFindings, redundantFindings, sentData, syntheticValue, validationSkip,
  type AttemptJudgment, type FormAttemptEvidence, type FormErrorEvidence, type FormEvidence, type FormFieldEvidence, type FormsInteractionData,
  type FormsProbeData,
} from './forms.js';
export {
  INPUT_PURPOSES, PURPOSE_WORDS, acceptedTokens, judgeAutocomplete, matchInputPurpose, nameWords, normalizeLabel, parseAutocomplete,
  type AutocompleteValue, type AutocompleteVerdict, type FieldText, type InputPurpose, type PurposeMatch,
} from './inputPurpose.js';
export type { CollectResult, CollectedMessage, ObserveResult, ScannedField, ScannedForm, ScannedPage } from './formsPage.js';
export {
  ProbeNotTestable, runAttachment,
  type GuardEvent, type GuardEventKind, type GuardLog, type ListenerTarget, type PageProbe, type ProbeContext,
  type PendingTimer, type ProbeContextOptions, type RecordedCall, type RecordedHooks, type RecordedListener, type RecordedTimer,
} from './types.js';
