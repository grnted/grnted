// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Pure rules for recognising media: file extensions and embedded player addresses. Engine core:
// no Node-only or AI imports.
import type { MediaPlayer } from '../types.js';

export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'avi', 'wmv', 'mkv', 'mpg', 'mpeg', '3gp'] as const;
export const AUDIO_EXTENSIONS = ['mp3', 'm4a', 'wav', 'ogg', 'oga', 'aac', 'flac', 'opus', 'wma'] as const;

/** Media file extension at the end of a path (the collector gets its source to filter links in the page). */
export const MEDIA_FILE_EXT = new RegExp(`\\.(${[...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS].join('|')})$`, 'i');
const AUDIO_EXT = new RegExp(`\\.(${AUDIO_EXTENSIONS.join('|')})$`, 'i');

/** 'video' or 'audio' for an address whose path ends in a media file extension. */
export function mediaFileType(url: string): 'video' | 'audio' | undefined {
  let path: string;
  try {
    path = new URL(url).pathname;
  } catch {
    return undefined;
  }
  if (!MEDIA_FILE_EXT.test(path)) return undefined;
  return AUDIO_EXT.test(path) ? 'audio' : 'video';
}

export interface PlayerMatch {
  player: MediaPlayer;
  /** Podcast and music players play sound only. */
  content: 'video' | 'audio';
  /** YouTube or Vimeo video id, when the address has one. */
  videoId?: string;
}

const host = (h: string, ...names: string[]) => names.some((n) => h === n || h.endsWith(`.${n}`));

/** Recognises a video or audio player iframe by its address, or undefined for anything else. */
export function classifyPlayer(url: string): PlayerMatch | undefined {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return undefined;
  const h = u.hostname.toLowerCase();
  const p = u.pathname;
  if (host(h, 'youtube.com', 'youtube-nocookie.com')) {
    const m = /^\/embed\/([A-Za-z0-9_-]{6,20})\/?$/.exec(p);
    if (m) return m[1] === 'videoseries' ? { player: 'youtube', content: 'video' } : { player: 'youtube', content: 'video', videoId: m[1] };
    return /^\/embed(\/|$)/.test(p) ? { player: 'youtube', content: 'video' } : undefined;
  }
  if (h === 'player.vimeo.com') {
    const m = /^\/video\/(\d+)/.exec(p);
    return m ? { player: 'vimeo', content: 'video', videoId: m[1] } : { player: 'vimeo', content: 'video' };
  }
  // Vimeo live events embed from vimeo.com itself.
  if (host(h, 'vimeo.com') && /^\/event\/\d+\/embed\/?$/.test(p)) return { player: 'vimeo', content: 'video' };
  const video = (player: MediaPlayer): PlayerMatch => ({ player, content: 'video' });
  const audio = (player: MediaPlayer): PlayerMatch => ({ player, content: 'audio' });
  if (host(h, 'wistia.net', 'wistia.com') && /^\/embed\//.test(p)) return video('wistia');
  if (h === 'players.brightcove.net') return video('brightcove');
  if (host(h, 'kaltura.com')) return video('kaltura');
  if (host(h, 'panopto.com', 'panopto.eu') && /\/Panopto\/Pages\/(Embed|Viewer)\.aspx$/i.test(p)) return video('panopto');
  if (h === 'web.microsoftstream.com' || (host(h, 'sharepoint.com') && /\/_layouts\/15\/embed\.aspx$/i.test(p))) return video('microsoft-stream');
  if (host(h, 'facebook.com') && /^\/plugins\/video\.php$/.test(p)) return video('facebook');
  if (h === 'play.vidyard.com' || h === 'embed.vidyard.com') return video('vidyard');
  if (host(h, 'dailymotion.com') && (/^\/embed\//.test(p) || h === 'geo.dailymotion.com')) return video('dailymotion');
  if (h === 'player.twitch.tv') return video('twitch');
  if (host(h, 'loom.com') && /^\/embed\//.test(p)) return video('loom');
  if (host(h, 'boxcast.tv', 'boxcast.com')) return video('boxcast');
  if (host(h, 'swagit.com')) return video('swagit');
  if (host(h, 'granicus.com') && /mediaplayer|\/player\//i.test(p)) return video('granicus');
  if (host(h, 'iqm2.com') && /video|media|splitview/i.test(p)) return video('iqm2');
  if (h === 'open.spotify.com' && /^\/embed\//.test(p)) return audio('spotify');
  if (h === 'w.soundcloud.com' && /^\/player/.test(p)) return audio('soundcloud');
  if (host(h, 'buzzsprout.com')) return audio('buzzsprout');
  if (h === 'embed.podcasts.apple.com') return audio('apple-podcasts');
  return undefined;
}

/** A link to a video page on a platform (not a player): youtu.be/<id>, youtube.com/watch?v=<id>, /shorts/<id>, /live/<id>. */
export const VIDEO_LINK_HOSTS = /^(?:(?:www\.|m\.)?youtube\.com|youtu\.be)$/i;

/** A YouTube video page's id from a link to it, or undefined (channels, playlists, anything else). */
export function classifyVideoLink(url: string): PlayerMatch | undefined {
  if (typeof url !== 'string' || url.length > 2048) return undefined;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return undefined;
  }
  if ((u.protocol !== 'http:' && u.protocol !== 'https:') || !VIDEO_LINK_HOSTS.test(u.hostname)) return undefined;
  const id = u.hostname.toLowerCase() === 'youtu.be'
    ? /^\/([A-Za-z0-9_-]{6,20})\/?$/.exec(u.pathname)?.[1]
    : u.pathname === '/watch' ? u.searchParams.get('v') ?? undefined
      : /^\/(?:shorts|live)\/([A-Za-z0-9_-]{6,20})\/?$/.exec(u.pathname)?.[1];
  return id && /^[A-Za-z0-9_-]{6,20}$/.test(id) ? { player: 'youtube', content: 'video', videoId: id } : undefined;
}

/** Player names for the report. */
export const PLAYER_NAMES: Record<MediaPlayer, string> = {
  youtube: 'YouTube', vimeo: 'Vimeo', wistia: 'Wistia', brightcove: 'Brightcove', kaltura: 'Kaltura', panopto: 'Panopto',
  'microsoft-stream': 'Microsoft Stream', facebook: 'Facebook', vidyard: 'Vidyard', dailymotion: 'Dailymotion', twitch: 'Twitch',
  loom: 'Loom', boxcast: 'BoxCast', swagit: 'Swagit', granicus: 'Granicus', iqm2: 'IQM2', spotify: 'Spotify',
  soundcloud: 'SoundCloud', buzzsprout: 'Buzzsprout', 'apple-podcasts': 'Apple Podcasts',
};
