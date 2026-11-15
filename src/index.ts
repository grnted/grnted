// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
export { AI_PAGES_LONG, CONSISTENCY_PAGES_LONG, compactLong, storableLong, LONG_NODES_PER_RULE, STAGE_PROGRESS_MAX, ScanPaused, scanSite, defaultAxeSource, isLateRetryPage, LATE_RETRY, type LateRetryOptions, type LateSession, type ScanOptions, type ScanProgress, type ScanResume } from './scan.js';
export { isWide, MAX_PAGES_LIMIT, WIDE_MIN_PAGES, wideKey, pathShape, PER_SHAPE_MAX } from './wide.js';
export { EVERY_PAGE_CAP_LONG } from './probes/sample.js';
export { ANALYTICS_SERVICES, isAnalyticsAddress, isAnalyticsBeacon, quietBrowser, quietContext, routeIsAnalyticsBeacon, type AnalyticsService } from './analytics.js';
export { gatedBrowser, gateDocuments, documentGate, gateFailure, NOT_ALLOWED, REFUSED_ADDRESS, type AllowUrl, type DocumentGateState } from './navigationGate.js';
export { discoverPages, type CrawlOptions } from './crawl.js';
export {
  findingsKey, incrementalSummary, lastmodKey, nextIncrementalState, normalizeHtml, NORMALIZE_VERSION, currentVersions, incrementalIsFull,
  type AssetState, type IncrementalVersions, type ValidatorTrust, type IncrementalOptions, type IncrementalPrevious, type IncrementalSummary, type LastmodTrust, type PageRevision, type PageState, type RevisionDecision,
} from './incremental/index.js';
export { sessionPool, DRAIN_MS, MAX_SESSIONS, type EgressHooks, type SessionPool } from './sessions.js';
export { auditPage, VIEWPORT_STEPS, type AuditOptions, type ViewportStep, type ViewportSteps } from './audit.js';
export { createPace, gotoPolitely, isPaceReason, isUnstyledReason, unstyledReason, politeFetch, retryAfterMs, ADAPTIVE, PACE_DEFAULTS, ScanStopped, type AdaptWhy, type Pace, type PaceAdapt, type PageSlot, type PaceAnswer, type PaceChange, type PaceLoadOptions, type PaceOptions, type PaceResult, type PaceSummary, type PaceTuning } from './pace.js';
export { paceNotes } from './report/pace.js';
export { createTimeBudget, type PaceTiming, type TimeBudget, type TimeBudgetRecorder } from './timeBudget.js';
export {
  createReplay, createSnapshot, fileStore, memoryStore, REPLAY_DEFAULTS, SNAPSHOT_ASSUMPTIONS,
  type Replay, type ReplayMode, type ReplayOptions, type ReplayStats, type Snapshot, type SnapshotOptions, type SnapshotStore,
} from './replay/index.js';
export { watchStyles, MAX_REMEMBERED_STYLESHEETS, type StyleRefusal, type StyleWatch } from './styles.js';
// Scan events (ScanOptions.onEvent); the event types (ScanEvent, RuleHit, WireEl, Wireframe) come from types.ts below.
export { STAGE_DETAIL_MAX, WIREFRAME_LIMITS, captureWireframe, emptyWireframe, ruleHits, sanitizeWireframe, viewportChecks, type WireTarget } from './events.js';
export { FOUND_EVENTS_MAX, foundTracker, type FoundTracker } from './found.js';
export { LIVE_SHOT_LIMITS, captureLiveShot, jpegSize, type LiveShotCapture, type LiveShotCaptureOptions } from './liveShot.js';
export { COLLECTORS, DEFAULT_COLLECTORS, imagesCollector, collectedValue, isCollectorError } from './collect/index.js';
export { pageTextCollector, toPageTextData, type PageTextData } from './collect/index.js';
export { visionCollector, type ColorOnlyLink, type IconCandidate, type OrderInversion, type VisionBlock, type VisionFacts } from './collect/index.js';
export { buildReport, scanInventory, VIEWPORTS, AXE_TAGS, AXE_ENABLED_RULES, FORM_FIELD_RULES, FRAME_RULES } from './report/build.js';
export { runAxe, axeOptions, FRAME_LIMITS, type AxeOptions, type FrameLimits } from './axeRun.js';
export { blockedLine, blockersOf, NON_INTERFERENCE_RULE } from './report/blocked.js';
export { accessBlockers, accessGranted, NON_INTERFERENCE_CRITERIA } from './criterionScore.js';
export { projectGranted } from './report/projection.js';
export { failingChecks, projectScore, reportChecks, type ReportCheck } from './report/projection.js';
export { buildProblems } from './report/problems.js';
export {
  fixPrompt, fixPromptPlan, fixPromptSuffix, FIX_PROMPT_AUDIENCES, FIX_PROMPT_MAX_CHARS,
  type FixPromptAudience, type FixPromptOptions, type FixPromptPlan,
} from './report/fixPrompt.js';
export {
  captureEvidence, createEvidenceRecorder, runEvidencePass, selectEvidence, DEFAULT_MAX_IMAGES, MAX_IMAGES_LIMIT,
  type CapturedShot, type EvidenceItem, type EvidencePassInput, type EvidenceRecorder,
} from './evidence/index.js';
export { AI_DISCLAIMER, fixText, NOT_JUDGED_VERDICTS } from './report/ai.js';
export {
  AXE_RULES, CRITERIA, MAX_EVIDENCE, PENDING_METHOD, STATUS_LABEL, buildCriteria, criteriaCounts, criteriaLine, criteriaTerminalLine,
  worstStatus, type CriterionDef, type CriterionExtra, type CriterionScope, type MethodId,
} from './report/criteria.js';
export { accessibleAlternatives, isAlternativeLink, namesAlternative } from './documents/alternatives.js';
export { renderTerminal } from './report/terminal.js';
export { renderPlainHtml, PLAIN_AI_MAX, PLAIN_EVIDENCE_MAX, PLAIN_PAGES_MAX } from './report/plain.js';
export { documentLinksCollector } from './collect/documentLinks.js';
export { classifyLink, sniffBytes, type LinkClass } from './documents/detect.js';
export {
  AI_REFETCH_DEFAULT, createDocumentInventory, mergeInventory, type AiRefetch, DOCUMENT_LIMITS, MAX_PDF_READ_STARTS, PDF_STOPPED_READ, type DocumentOptions, type DocumentStore, type InventoryResult,
  type StoredPdf, type StoredProbe,
} from './documents/index.js';
export { PdfCheckError, READ_STOPPED, readPdfChecks, TIME_LIMIT_REACHED, type PdfLimits, type PdfRead, type PdfReader } from './documents/pdf.js';
export { checkDocuments, type DocumentRunOptions, type DocumentRunResult } from './documents/run.js';
export { decodedSizeWithin, PDF_DECODED_LIMIT } from './documents/pdfGuard.js';
export { checkPdf, pdfProblems } from './documents/pdf.js';
export { checkOffice, officeFindings, officeProblems, OfficeCheckError, DEFAULT_OFFICE_LIMITS, type OfficeLimits } from './documents/office.js';
export { checkPdfDetailed, parsePdfDate, PDF_DETAIL_LIMITS } from './documents/pdf.js';
export { documentCounts, documentsLine } from './report/documents.js';
export { mediaCollector, MEDIA_LIMITS, type MediaElementFact, type MediaFacts, type MediaFrameFact, type MediaLinkFact } from './collect/media.js';
export {
  asksPlatforms, buildMediaInventory, cachedCaptions, classifyPlayer, classifyVideoLink, isCaptionsTrack, mediaFileType, mediaIssues, mediaItems, platformCaptions,
  MEDIA_FILE_EXT, PLATFORM_CAPTION_LIMITS, PLATFORM_CAPTION_TTL, PLAYER_NAMES, VIMEO_API_ORIGIN, YOUTUBE_CAPTIONS_ENDPOINT, YOUTUBE_CAPTIONS_UNITS,
  type CaptionCache, type CaptionQuota, type MediaInventoryOptions, type PlatformCaptionOptions, type PlayerMatch,
} from './media/index.js';
export { formatTime, parseVtt, type VttCue } from './media/vtt.js';
export { mediaCounts, mediaLine } from './report/media.js';
export { shapeCollector, pageShape } from './collect/shape.js';
export {
  consistencyCollector, toConsistencyFacts, CONSISTENCY_LIMITS, type ConsistencyFacts, type ConsistencyHelp, type ConsistencyLink,
  type ConsistencyRegion, type ConsistencySearch, type Place,
} from './collect/consistency.js';
export {
  analyzeConsistency, compareLabels, helpType, linkKey, movedItems, normalizeLabel, orderConflicts, processStepReason,
  CONSISTENCY_CRITERIA, CONSISTENCY_METHOD_ID, type ConsistencyAnalysis, type ConsistencyResult, type LabelPair, type OrderConflict,
} from './consistency/index.js';
export { samplePages, urlPattern, type TemplatePage } from './sample/templates.js';
export * from './probes/index.js';
export {
  scoreSite, enoughPagesLoaded, minimumPagesLoaded, pageScore, axeSiteScore, letterFor, probeChecksFrom, untestedCriteria, checksTotal, combineChecks, roundScore, FORMULA_SCALE, FORMULA_KNEE, ruleWeight, probeWeight, ruleGroupOf, IMPACT_RANK, GROUP_WEIGHTS,
  RULE_GROUPS, PROBE_CHECK_WEIGHT, PROBE_WEIGHT_OVERRIDES, DOCUMENT_CHECK_WEIGHT, documentOutcome, type AxePageResult, type DocumentOutcome, type ProbeChecks, type ProbeOutcome, type RuleGroup, type WeightedCheck,
} from './score.js';
export {
  PLATFORMS, decidePlatform, detectPlatforms, issueTypeOf, platformGuidance, platformSummary, problemGuidance, reportPlatform, type DetectedPlatform, type IssueType, type PlatformId, type PlatformSignals,
} from './platform.js';
export { checkTargetUrl, isPublicIp } from './urlSafety.js';
export { BOT_CHALLENGE, CHALLENGE_PAGE, isChallengeStatus, isWafChallenge } from './challenge.js';
export { measureStart, SITE_TIMING, SLOWED_PAGE, slowing, type SiteTiming, type StartSpeed } from './siteSpeed.js';
export { FINISH, notCheckedLine, planFinish, type FinishPlan, type FinishStage, type FinishTiming } from './finishPlan.js';
export { BROWSER_CLOSED_PAGE, BROWSER_LOST, BROWSER_LOST_PAGE, isBrowserGone, isPageLost, reconnectingBrowser, type BrowserHandle, type ReconnectingBrowser, type ReconnectOptions } from './reconnect.js';
export { hostKey, normalizeUrl, sameSite, isDocumentUrl } from './url.js';
export { isListedSuffix, registrableDomain } from './domain.js';
export { keyedBrowser, keyedFetch, type ScopedHeader } from './ownerKey.js';
export { COPY_VERSION, ENGINE_VERSION, SCORING_VERSION, DEFAULT_USER_AGENT } from './version.js';
export { UA_TOKEN, withToken, presentHeadlessAsChrome, isGrntedAgent, ownUserAgent, browserUserAgent, scanUserAgent, lastBrowserUserAgent, matchedContextOptions, userAgentMatching } from './userAgent.js';
export { AXE_VERSION } from './ruleImpacts.js';
export type * from './types.js';

export { buildJobs } from './report/jobs.js';
