// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Analytics and telemetry beacons: the requests that record a visit with the scanned site's own
// analytics. A scan is not a visitor, so on every page the scanner opens these requests are aborted
// before they leave the browser, while the scripts that send them still load and run (the page renders
// and behaves as for any visitor). Engine core: no Node-only imports.
import type { BrowserLike, ContextLike, RouteLike } from './types.js';

/**
 * A service that records visits, events, errors or replays for a site's owner.
 *
 * - `host`: the host itself or any host under it ('google-analytics.com' covers
 *   region1.google-analytics.com). `'*'` is any host: the service is known by its address alone
 *   (first-party tagging, self-hosted analytics), see `pattern`.
 * - `paths`: on a shared host (google.com, facebook.com, t.co), only these paths are the service, and
 *   every request to them records a visit.
 * - Without `paths`, every request to the host other than GET or HEAD records one (the scripts and
 *   files the service serves are GETs), and so does a GET to one of `get` (pixels, collect endpoints).
 *
 * '*' is every path (a host that only collects), '/' only the root. Any other path ending in '/'
 * matches as a prefix, and one that does not matches itself and what is under it ('/g/collect'
 * matches '/g/collect' and '/g/collect/x', not '/g/collected').
 */
export interface AnalyticsService {
  /** The service, for people reading the list. */
  name: string;
  host: string;
  paths?: readonly string[];
  get?: readonly string[];
  /** With `host` '*': the address (path and query) that records a visit. */
  pattern?: RegExp;
}

const GA_COLLECT = ['/g/collect', '/collect', '/j/collect', '/r/collect', '/mp/collect', '/batch'];

/**
 * The analytics and telemetry services whose beacons a scan never sends (`isAnalyticsBeacon`). Their
 * scripts (gtag.js, gtm.js, fbevents.js, posthog's array.js, …) are not on it: they are GETs of files.
 * The engine's probe guard calls a write to one of these hosts the page's background traffic.
 */
export const ANALYTICS_SERVICES: readonly AnalyticsService[] = Object.freeze([
  // Google Analytics (GA4 and Universal), Tag Manager's own pings, Google Ads measurement.
  { name: 'Google Analytics', host: 'google-analytics.com', get: GA_COLLECT },
  { name: 'Google Analytics', host: 'analytics.google.com', get: GA_COLLECT },
  { name: 'Google Tag Manager', host: 'googletagmanager.com', get: ['/a', '/td', ...GA_COLLECT] },
  { name: 'Google Ads (DoubleClick)', host: 'doubleclick.net', get: [...GA_COLLECT, '/pagead/viewthroughconversion/', '/activity', '/activityi'] },
  { name: 'Google measurement', host: 'google.com', paths: ['/g/collect', '/ccm/collect', '/pagead/1p-conversion/', '/pagead/1p-user-list/', '/ads/ga-audiences'] },
  // GA4 sent through a site's own tagging server (server-side Tag Manager): a GA4 hit by its address.
  { name: 'Google Analytics (first-party tagging)', host: '*', pattern: /\/g\/collect\/?\?(?:[^#]*&)?tid=G-/i },
  // PostHog, and Apptegy's PostHog ingestion host (school-district sites on the Thrillshare CMS).
  { name: 'PostHog', host: 'posthog.com', get: ['/e/', '/i/v0/e/', '/batch/', '/s/', '/decide/', '/flags/', '/capture/', '/engage/', '/track/'] },
  { name: 'PostHog (Apptegy)', host: 'i.apptegy-edge.com', paths: ['/e/', '/i/v0/e/', '/batch/', '/s/', '/decide/', '/flags/'] },
  { name: 'LaunchDarkly events', host: 'events.launchdarkly.com', get: ['*'] },
  // Segment's events are POSTs; its GETs are the library and its settings (cdn.segment.com/v1/projects/…).
  { name: 'Segment', host: 'segment.io' },
  { name: 'Segment', host: 'segment.com' },
  { name: 'Mixpanel', host: 'mixpanel.com', get: ['/track', '/engage', '/groups'] },
  { name: 'Amplitude', host: 'amplitude.com', get: ['/2/httpapi', '/batch', '/httpapi'] },
  { name: 'Hotjar', host: 'hotjar.com' },
  { name: 'Hotjar', host: 'hotjar.io' },
  { name: 'Microsoft Clarity', host: 'clarity.ms', get: ['/collect'] },
  { name: 'Plausible', host: 'plausible.io', get: ['/api/event'] },
  // Fathom counts a visit with a GET of its host's root (the script is /script.js).
  { name: 'Fathom', host: 'usefathom.com', get: ['/'] },
  { name: 'Heap', host: 'heapanalytics.com', get: ['/h', '/api/'] },
  { name: 'FullStory', host: 'fullstory.com', get: ['/rec/'] },
  // Browser monitoring and error reporting: New Relic, Datadog RUM, Sentry.
  { name: 'New Relic', host: 'nr-data.net', get: ['*'] },
  { name: 'Datadog RUM', host: 'browser-intake-datadoghq.com', get: ['*'] },
  { name: 'Datadog RUM', host: 'browser-intake-datadoghq.eu', get: ['*'] },
  { name: 'Datadog RUM', host: 'browser-intake-us3-datadoghq.com', get: ['*'] },
  { name: 'Datadog RUM', host: 'browser-intake-us5-datadoghq.com', get: ['*'] },
  { name: 'Datadog RUM', host: 'browser-intake-ap1-datadoghq.com', get: ['*'] },
  { name: 'Sentry', host: 'sentry.io', get: ['/api/'] },
  // Advertising pixels.
  { name: 'Meta pixel', host: 'facebook.com', paths: ['/tr'] },
  { name: 'LinkedIn Insight', host: 'ads.linkedin.com', get: ['*'] },
  { name: 'TikTok pixel', host: 'analytics.tiktok.com', get: ['/api/'] },
  { name: 'Microsoft UET', host: 'bat.bing.com', get: ['/action/', '/actionp/'] },
  { name: 'X (Twitter) pixel', host: 'analytics.twitter.com', get: ['/i/adsct', '/1/i/adsct'] },
  { name: 'X (Twitter) pixel', host: 't.co', paths: ['/i/adsct', '/1/i/adsct'] },
  { name: 'Pinterest tag', host: 'ct.pinterest.com', get: ['*'] },
  { name: 'Snap pixel', host: 'tr.snapchat.com', get: ['*'] },
  { name: 'Snap pixel', host: 'tr-shadow.snapchat.com', get: ['*'] },
  // HubSpot's visit tracking and its collected-forms capture (not a form's own submission).
  { name: 'HubSpot', host: 'track.hubspot.com', get: ['*'] },
  { name: 'HubSpot collected forms', host: 'forms.hscollectedforms.net', get: ['/collected-forms/'] },
  { name: 'HubSpot collected forms', host: 'forms.hubspot.com', paths: ['/collected-forms/'] },
  // Adobe Analytics (AppMeasurement), on Adobe's hosts and on a site's own tracking host.
  { name: 'Adobe Analytics', host: 'omtrdc.net', get: ['/b/ss/'] },
  { name: 'Adobe Analytics', host: '2o7.net', get: ['/b/ss/'] },
  { name: 'Adobe Analytics (first-party)', host: '*', pattern: /\/b\/ss\// },
  // Matomo (Piwik), usually self-hosted.
  { name: 'Matomo', host: '*', pattern: /\/(?:matomo|piwik)\.php(?:[?#]|$)/i },
]);

const pathMatches = (path: string, p: string): boolean =>
  p === '*' || (p === '/' ? path === '/' : p.endsWith('/') ? path.startsWith(p) : path === p || path.startsWith(`${p}/`));

/**
 * The request records a visit with an analytics or telemetry service (`ANALYTICS_SERVICES`). A
 * navigation (the page itself, a frame, a window) never is one, nor is anything that is not http(s).
 */
export function isAnalyticsBeacon(method: string, url: string, navigation = false): boolean {
  if (navigation) return false;
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  const path = u.pathname;
  const write = !/^(?:GET|HEAD)$/i.test(method);
  for (const s of ANALYTICS_SERVICES) {
    if (s.host === '*') {
      if (s.pattern?.test(`${path}${u.search}`)) return true;
      continue;
    }
    if (host !== s.host && !host.endsWith(`.${s.host}`)) continue;
    if (s.paths) {
      if (s.paths.some((p) => pathMatches(path, p))) return true;
      continue;
    }
    if (write || s.get?.some((p) => pathMatches(path, p))) return true;
  }
  return false;
}

/**
 * The address belongs to an analytics or telemetry service on `ANALYTICS_SERVICES`, whatever the method:
 * its host is a service's host or under it (at one of the service's `paths` on a shared host), or it
 * matches a first-party service's `pattern`. The probe guard calls a blocked write to one the page's
 * background traffic (`GuardEvent.cause` 'background'): the one list the scan's beacon blocking
 * (`isAnalyticsBeacon`) reads too.
 */
export function isAnalyticsAddress(url: string | undefined): boolean {
  let u: URL;
  try {
    u = new URL(url ?? '');
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  return ANALYTICS_SERVICES.some((s) => (s.host === '*'
    ? !!s.pattern?.test(`${u.pathname}${u.search}`)
    : (host === s.host || host.endsWith(`.${s.host}`)) && (!s.paths || s.paths.some((p) => pathMatches(u.pathname, p)))));
}

/** The route request's beacon verdict; a request that cannot be read is not called one. */
export function routeIsAnalyticsBeacon(route: RouteLike): boolean {
  try {
    const req = route.request();
    return isAnalyticsBeacon(req.method(), req.url(), req.isNavigationRequest?.() ?? false);
  } catch {
    return false;
  }
}

/**
 * The context's analytics beacons aborted (`isAnalyticsBeacon`): one route on the whole context, so
 * every page in it is covered, the windows it opens too. Everything else goes on to the next handler.
 * The hosted Worker does the same in its own context route (apps/worker/src/safety.ts guardBrowser).
 */
export async function quietContext(ctx: ContextLike): Promise<void> {
  await ctx.route?.('**/*', async (route) => {
    try {
      if (routeIsAnalyticsBeacon(route)) await route.abort('blockedbyclient');
      else if (route.fallback) await route.fallback();
      else await route.continue();
    } catch {
      // The page or context closed meanwhile.
    }
  });
}

/** The browser with `quietContext` on every context it opens (the CLI's local browser). */
export function quietBrowser(browser: BrowserLike): BrowserLike {
  return new Proxy(browser, {
    get(target, prop, receiver) {
      if (prop === 'newContext') {
        return async (opts: Parameters<BrowserLike['newContext']>[0]) => {
          const ctx = await target.newContext(opts);
          try {
            await quietContext(ctx);
          } catch (err) {
            await ctx.close().catch(() => {});
            throw err;
          }
          return ctx;
        };
      }
      const v = Reflect.get(target, prop, receiver) as unknown;
      return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    },
  });
}
