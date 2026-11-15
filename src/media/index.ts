// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The video and audio inventory: every media item on the scanned pages, with rules-based findings
// (no AI). Embedded players are not downloaded. With a YouTube Data API key (or a
// Vimeo token), YouTube and Vimeo videos also say what caption tracks the platform lists for them
// (plan C14; unscored evidence for 1.2.2). Engine core: no Node-only or AI imports.
import { collectedValue } from '../collect/index.js';
import { mediaCollector, type MediaElementFact } from '../collect/media.js';
import type { MediaCaptions, MediaIssue, MediaItem, PageAudit, PlatformCaptions, PlatformUncheckedReason } from '../types.js';
import { classifyPlayer, classifyVideoLink, mediaFileType, PLAYER_NAMES } from './detect.js';
import { lookupable, platformCaptions, platformVideoKey, PLATFORM_CAPTION_LIMITS, type CaptionCache, type CaptionQuota } from './platformCaptions.js';

const MAX_FOUND_ON = 20;
/** Autoplaying sound shorter than this is allowed by WCAG 1.4.2. */
const AUTOPLAY_SECONDS = 3;

/** True when a track gives captions: kind captions or subtitles (the default), with a file. */
export function isCaptionsTrack(t: { kind: string; src?: string }): boolean {
  return (t.kind === 'captions' || t.kind === 'subtitles') && !!t.src;
}

function captionsOf(item: Omit<MediaItem, 'captions' | 'issues'>): MediaCaptions {
  if (item.content === 'audio') return item.transcriptNearby ? 'transcript-nearby' : 'no-transcript';
  if (item.kind === 'video') return item.tracks?.some(isCaptionsTrack) ? 'track' : 'none';
  return 'check-manually';
}

/** The rules-based findings for one item, problems first. */
export function mediaIssues(item: Omit<MediaItem, 'issues'>): MediaIssue[] {
  const issues: MediaIssue[] = [];
  const native = item.kind === 'video' || item.kind === 'audio';
  // A short sound that loops plays for as long as the page is open: only a non-looping one of 3 s or less is exempt.
  // A video with no sound track plays no sound (`audio: 'none'`).
  // Metadata triggers the audio probe; it cannot establish audible playback or rule out a working page control.
  if (native && item.autoplay && !item.muted && !item.controls && item.audio !== 'none' && !(!item.loop && item.duration !== undefined && item.duration <= AUTOPLAY_SECONDS)) {
    issues.push({
      criterion: '1.4.2', level: 'review', rule: 'autoplay-sound-no-controls',
      message: 'It is set to play automatically without built-in controls. If it plays sound for more than three seconds, provide a working way to pause, stop or mute it, or control its volume.',
    });
  }
  if (item.kind === 'video' && item.captions === 'none') {
    // A muted video without controls that the page hides from assistive technology is decoration (a
    // background video): no sound to caption, and no information the page claims it shows.
    if (item.muted && !item.controls && item.decorative) {
      // nothing to report
    } else if (item.audio === 'none') {
      // No sound track: nothing to caption (1.2.2 needs captions for the audio content). What it shows is
      // video-only content, which 1.2.1 asks to describe in text unless it is decoration.
      issues.push({
        criterion: '1.2.1', level: 'review', rule: 'silent-video',
        message: 'This video has no sound track, so it needs no captions. If it shows information and is not just decoration, describe that information in text on the page.',
      });
    } else if (item.audio !== 'present') {
      issues.push({
        criterion: '1.2.2', level: 'review', rule: 'no-captions-track',
        message: 'This video has no captions track, but whether it contains audio could not be established. If it has audio, provide captions; video-only content needs a text alternative when it conveys information.',
      });
    } else if (item.muted && !item.controls) {
      issues.push({
        criterion: '1.2.1', level: 'review', rule: 'silent-video',
        message: 'This video plays without sound and has no controls, so it needs no captions. If it shows information and is not just decoration, describe that information in text on the page.',
      });
    } else if (item.hidden) {
      // Not shown when scanned: nobody could play it then. It may be shown later (a tab, a dialog), so it is listed.
      issues.push({
        criterion: '1.2.2', level: 'review', rule: 'no-captions-track',
        message: 'This video was hidden when the page was scanned and has no captions track. If the page shows it, add captions as a WebVTT file linked with a track element (kind "captions").',
      });
    } else if (item.alternativeForText) {
      // WCAG 1.2.2 exempts a media alternative for text that is clearly labelled as one.
      issues.push({
        criterion: '1.2.2', level: 'review', rule: 'no-captions-track',
        message: 'This video has no captions track, and the page says it gives the same information as its text. That needs no captions if it says nothing the text does not; otherwise add captions.',
      });
    } else {
      // A possible problem, never a definite one (review round 2, finding 3; the lead's ruling of 2026-11-10): the
      // rules cannot see captions that are part of the picture (open captions), which satisfy 1.2.2, and do not
      // always know whether the video has sound.
      issues.push({
        criterion: '1.2.2', level: 'review', rule: 'no-captions-track',
        message: 'This video has no captions track. Unless its captions are part of the picture (open captions), add captions as a WebVTT file linked with a track element (kind "captions"), or replace it with a captioned copy.',
      });
    }
  }
  if (item.content === 'audio' && !item.transcriptNearby) {
    issues.push({
      criterion: '1.2.1', level: 'review', rule: 'no-transcript-nearby',
      message: 'No transcript was found in the same part of the page as this audio (the scan looks only there). People who are deaf or hard of hearing need a text version of everything said: link a transcript next to it.',
    });
  }
  if (item.content === 'video' && (item.kind === 'embed' || item.kind === 'link')) {
    const platform = item.platformCaptions;
    const name = item.player ? PLAYER_NAMES[item.player] ?? 'the platform' : 'the platform';
    const upload = item.player === 'youtube' ? 'Upload a caption file in YouTube Studio' : `Upload a caption file to the video on ${name}`;
    const autoWrong = 'auto-generated captions are often wrong on names and terms.';
    if (platform?.status === 'none') {
      // Unscored until the gold standard proves it (plan C14): listed as a possible problem.
      issues.push({ criterion: '1.2.2', level: 'review', rule: 'platform-no-captions', message: `${name} has no captions for this video. ${upload}; ${autoWrong}` });
    } else if (platform?.status === 'auto-only') {
      issues.push({ criterion: '1.2.2', level: 'review', rule: 'platform-auto-captions-only', message: `This video has only ${name}'s automatic captions. Check them, or ${upload.charAt(0).toLowerCase()}${upload.slice(1)}; ${autoWrong}` });
    } else if (platform?.status === 'unchecked') {
      issues.push({ criterion: '1.2.2', level: 'review', rule: 'check-captions-manually', message: `We couldn't check this video's captions on ${name}: ${uncheckedReason(platform, name)}. ${platform.reason === 'not-found' ? 'Make the video public or unlisted, or fix its address, so visitors can watch it with captions.' : `Check that it has captions on ${name}; ${autoWrong}`}` });
    } else if (platform?.status === 'captions') {
      // The platform lists captions made by a person: nothing to report (their accuracy is not judged).
    } else if (item.uploaderCaptions === false) {
      // A report made before plan C14 (the CLI's old videos.list lookup), re-read as it was made.
      issues.push({
        criterion: '1.2.2', level: 'problem', rule: 'uploader-captions-missing',
        message: 'The uploader added no captions on YouTube, so it has only automatic captions or none. Automatic captions alone are not enough unless someone has checked them for accuracy: upload captions or correct the automatic ones in YouTube Studio.',
      });
    } else {
      issues.push({
        criterion: '1.2.2', level: 'review', rule: 'check-captions-manually',
        message: item.uploaderCaptions === true
          ? 'The uploader added captions on YouTube. Their accuracy cannot be tested automatically: the platform does not give automated tools its audio.'
          : item.kind === 'embed'
            ? "Embedded players are not downloaded, so their captions and audio description weren't checked. Automatic captions alone are not enough unless they have been corrected."
            : item.player
              ? `This links to a video on ${name}, which the scan does not download, so its captions cannot be tested automatically. Automatic captions alone are not enough unless they have been corrected.`
              : 'This links to a video file, which the scan does not download, so its captions cannot be tested automatically. It needs accurate captions, built in or as a separate captions file.',
      });
    }
  }
  return issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'problem' ? -1 : 1));
}

/** Why a video's captions could not be read from its platform, in plain words. */
export function uncheckedReason(p: PlatformCaptions, name: string): string {
  const reasons: Record<PlatformUncheckedReason, string> = {
    'not-found': `${name} has no public video at this address (it is private, removed or the address is wrong)`,
    'api-error': p.httpStatus ? `${name} answered with an error (HTTP ${p.httpStatus})` : `${name} could not be reached`,
    'daily-limit': `the day's limit of ${name} checks was reached`,
    'scan-limit': `one scan checks at most ${PLATFORM_CAPTION_LIMITS.lookups} videos`,
    'time-limit': 'the scan ran out of time',
    'no-token': `${name} checks are not set up`,
    'free-check': 'the free check reads only answers stored from earlier scans',
  };
  return reasons[p.reason ?? 'api-error'] ?? reasons['api-error'];
}

function finish(item: Omit<MediaItem, 'captions' | 'issues'>): MediaItem {
  const withCaptions = { ...item, captions: captionsOf(item) };
  return { ...withCaptions, issues: mediaIssues(withCaptions) };
}

function fromElement(e: MediaElementFact, page: string): Omit<MediaItem, 'captions' | 'issues'> {
  return {
    kind: e.tag,
    content: e.tag,
    url: e.src,
    foundOn: [page],
    ...(e.name ? { name: e.name } : {}),
    tracks: e.tracks,
    autoplay: e.autoplay,
    muted: e.muted,
    controls: e.controls,
    ...(e.duration !== undefined ? { duration: e.duration } : {}),
    ...(e.loop ? { loop: true } : {}),
    ...(e.audio ? { audio: e.audio } : {}),
    ...(e.hidden ? { hidden: true as const } : {}),
    ...(e.alternativeForText ? { alternativeForText: true as const } : {}),
    ...(e.poster ? { poster: e.poster } : {}),
    ...(e.tag === 'audio' ? { transcriptNearby: e.transcriptNearby } : {}),
    ...(e.decorative ? { decorative: true as const } : {}),
  };
}

/**
 * The facts of an item the rules read (everything but where it was found and its label: name and
 * poster), keys sorted: two pages' copies merge only when these are equal.
 */
function factsKey(item: Omit<MediaItem, 'captions' | 'issues'>): string {
  const { foundOn: _foundOn, name: _name, poster: _poster, ...all } = item;
  // A YouTube or Vimeo video is one item whatever its address's parameters (the first address is shown).
  const { url: _url, ...byId } = all;
  const facts = item.videoId && item.player ? byId : all;
  const sorted = (v: unknown): unknown => (Array.isArray(v) ? v.map(sorted)
    : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, sorted(x)]))
    : v);
  return JSON.stringify(sorted(facts));
}

/**
 * Media items from the audited pages, with the rules applied. Each page's element is judged on its
 * own facts (autoplay, muted, controls, loop, tracks, transcript nearby...): copies merge into one
 * item, listing every page, only when all their facts are the same. So one file that autoplays
 * without controls on one page and has controls on another is two items, and the result does not
 * depend on the order the pages were scanned in.
 */
export function mediaItems(pages: readonly PageAudit[]): MediaItem[] {
  const byKey = new Map<string, Omit<MediaItem, 'captions' | 'issues'>>();
  const add = (where: string, page: string, make: () => Omit<MediaItem, 'captions' | 'issues'>) => {
    const made = make();
    const key = `${where}\n${factsKey(made)}`;
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, made);
    else if (!existing.foundOn.includes(page) && existing.foundOn.length < MAX_FOUND_ON) existing.foundOn.push(page);
  };
  for (const page of pages) {
    if (page.status !== 'ok') continue;
    const facts = collectedValue(page, mediaCollector);
    if (!facts) continue;
    facts.elements.forEach((e, i) => add(e.src ? `${e.tag}\n${e.src}` : `${e.tag}\n${page.url}\n${i}`, page.url, () => fromElement(e, page.url)));
    for (const f of facts.frames) {
      const match = classifyPlayer(f.src);
      if (!match) continue;
      // One row per YouTube or Vimeo video, whatever its player address's parameters (plan C14).
      add(match.videoId ? `embed\n${match.player}\n${match.videoId}` : `embed\n${f.src}`, page.url, () => ({
        kind: 'embed', content: match.content, url: f.src, foundOn: [page.url], player: match.player,
        ...(match.videoId ? { videoId: match.videoId } : {}),
        ...(f.title ? { name: f.title } : {}),
        ...(match.content === 'audio' ? { transcriptNearby: f.transcriptNearby } : {}),
      }));
    }
    for (const l of facts.links) {
      const content = mediaFileType(l.href);
      const video = content ? undefined : classifyVideoLink(l.href);
      if (video?.videoId) {
        // A link to a YouTube video's page: listed as linked, not embedded.
        add(`link\n${video.player}\n${video.videoId}`, page.url, () => ({
          kind: 'link', content: 'video', url: l.href, foundOn: [page.url], player: video.player, videoId: video.videoId,
          ...(l.text ? { name: l.text } : {}),
        }));
        continue;
      }
      if (!content) continue;
      add(`link\n${l.href}`, page.url, () => ({
        kind: 'link', content, url: l.href, foundOn: [page.url],
        ...(l.text ? { name: l.text } : {}),
        ...(content === 'audio' ? { transcriptNearby: l.transcriptNearby } : {}),
      }));
    }
  }
  return [...byKey.values()].map(finish);
}

export interface MediaInventoryOptions {
  /** YouTube Data API key: `captions.list` per video (50 quota units each). Never stored or reported. */
  youtubeApiKey?: string;
  /** Vimeo API token (an unauthenticated app token reads public videos). Never stored or reported. */
  vimeoToken?: string;
  /** Answers kept between scans (7 days for captioned videos, 1 day otherwise). */
  cache?: CaptionCache;
  /** The day's YouTube quota, shared by every scan. */
  quota?: CaptionQuota;
  /** false: stored answers only, no API call (the free homepage check). */
  lookups?: boolean;
  fetchFn?: typeof fetch;
  userAgent?: string;
  allowUrl?: (url: string) => Promise<boolean>;
  /** Stop asking by then (epoch ms). */
  by?: number;
}

/** True when the inventory will ask the platforms (or read stored answers) about captions. */
export function asksPlatforms(opts: MediaInventoryOptions): boolean {
  return !!(opts.youtubeApiKey || opts.vimeoToken || opts.cache);
}

/** The media inventory for a scan. Never throws. */
export async function buildMediaInventory(pages: readonly PageAudit[], opts: MediaInventoryOptions = {}): Promise<MediaItem[]> {
  const items = mediaItems(pages);
  const videos = items.flatMap((i) => (lookupable(i) ? [{ player: i.player, videoId: i.videoId }] : []));
  if (!asksPlatforms(opts) || !videos.length) return items;
  const answers = await platformCaptions(videos, opts);
  return items.map((item) => {
    const answer = lookupable(item) ? answers.get(platformVideoKey(item)) : undefined;
    if (!answer) return item;
    const { captions: _c, issues: _i, ...rest } = item;
    return finish({ ...rest, platformCaptions: answer });
  });
}

export { classifyPlayer, classifyVideoLink, mediaFileType, MEDIA_FILE_EXT, PLAYER_NAMES, type PlayerMatch } from './detect.js';
export {
  cachedCaptions, lookupable, platformCaptions, platformVideoKey, vimeoStatus, youtubeStatus,
  PLATFORM_CAPTION_LIMITS, PLATFORM_CAPTION_TTL, VIMEO_API_ORIGIN, YOUTUBE_CAPTIONS_ENDPOINT, YOUTUBE_CAPTIONS_UNITS,
  type CaptionCache, type CaptionQuota, type PlatformCaptionOptions, type PlatformVideo,
} from './platformCaptions.js';
