// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Which requests record a visit with the scanned site's analytics (src/analytics.ts): those are
// aborted on every page the scanner opens; the scripts that send them, and everything else, are not.
import { describe, expect, it } from 'vitest';
import { ANALYTICS_SERVICES, isAnalyticsAddress, isAnalyticsBeacon, quietContext } from '../../src/analytics.js';
import type { ContextLike, RouteLike } from '../../src/types.js';

describe('isAnalyticsBeacon', () => {
  it('a GA4 page view is a beacon however it is sent (sendBeacon or fetch POST, image GET), on every Google host gtag uses', () => {
    for (const [m, u] of [
      ['POST', 'https://region1.google-analytics.com/g/collect?v=2&tid=G-ABC123&en=page_view'],
      ['POST', 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123'],
      ['GET', 'https://www.google-analytics.com/g/collect?v=2&tid=G-ABC123'],
      ['GET', 'https://www.google-analytics.com/collect?v=1&tid=UA-1-1&t=pageview'],
      ['POST', 'https://region1.analytics.google.com/g/collect?v=2&tid=G-ABC123'],
      ['GET', 'https://stats.g.doubleclick.net/g/collect?v=2&tid=G-ABC123'],
      ['GET', 'https://www.googletagmanager.com/a?id=GTM-1&cv=2'],
      ['GET', 'https://www.google.com/ccm/collect?en=page_view&tid=G-ABC123'],
    ] as const) expect(isAnalyticsBeacon(m, u), `${m} ${u}`).toBe(true);
  });

  it('the scripts and files those services serve still load (the page runs as it does for a visitor)', () => {
    for (const u of [
      'https://www.googletagmanager.com/gtag/js?id=G-ABC123',
      'https://www.googletagmanager.com/gtm.js?id=GTM-1',
      'https://www.googletagmanager.com/amp.json?id=GTM-1',
      'https://www.google-analytics.com/analytics.js',
      'https://us-assets.i.posthog.com/static/array.js',
      'https://connect.facebook.net/en_US/fbevents.js',
      'https://cdn.usefathom.com/script.js',
      'https://static.hotjar.com/c/hotjar-1.js?sv=6',
      'https://www.clarity.ms/tag/abc',
      'https://bat.bing.com/bat.js',
      'https://snap.licdn.com/li.lms-analytics/insight.min.js',
      'https://analytics.tiktok.com/i18n/pixel/events.js?sdkid=X',
      'https://www.facebook.com/plugins/page.php?href=x',
      'https://t.co/abc123',
      'https://cdn.segment.com/v1/projects/KEY/settings',
      'https://cdn.segment.com/analytics.js/v1/KEY/analytics.min.js',
    ]) expect(isAnalyticsBeacon('GET', u), u).toBe(false);
  });

  it('PostHog, pixels and RUM: their events are beacons, by POST or GET', () => {
    for (const [m, u] of [
      ['POST', 'https://us.i.posthog.com/e/?ip=1'],
      ['POST', 'https://eu.i.posthog.com/i/v0/e/'],
      ['POST', 'https://us.i.posthog.com/decide/?v=3'],
      ['GET', 'https://us.i.posthog.com/flags/?v=2'],
      ['GET', 'https://www.facebook.com/tr?id=1&ev=PageView'],
      ['GET', 'https://px.ads.linkedin.com/collect/?pid=1'],
      ['GET', 'https://bat.bing.com/action/0?ti=1&evt=pageLoad'],
      ['GET', 'https://analytics.twitter.com/i/adsct?txn_id=x'],
      ['GET', 'https://t.co/i/adsct?txn_id=x'],
      ['GET', 'https://ct.pinterest.com/v3/?tid=1'],
      ['POST', 'https://tr.snapchat.com/p'],
      ['GET', 'https://track.hubspot.com/__ptq.gif?a=1'],
      ['POST', 'https://forms.hscollectedforms.net/collected-forms/submit/form'],
      ['GET', 'https://cdn.usefathom.com/?h=x&p=/&sid=ABC'],
      ['GET', 'https://bam.nr-data.net/1/key?a=1'],
      ['POST', 'https://browser-intake-datadoghq.com/api/v2/rum?ddsource=browser'],
      ['POST', 'https://o1.ingest.sentry.io/api/2/envelope/'],
      ['POST', 'https://in.hotjar.com/api/v2/client/sites/1/visit-data'],
      ['POST', 'https://k.clarity.ms/collect'],
      ['POST', 'https://plausible.io/api/event'],
      ['POST', 'https://api.segment.io/v1/t'],
      ['GET', 'https://api-js.mixpanel.com/track/?data=x'],
      ['POST', 'https://api2.amplitude.com/2/httpapi'],
      ['POST', 'https://rs.fullstory.com/rec/bundle'],
      ['GET', 'https://heapanalytics.com/h?a=1'],
      ['GET', 'https://example.sc.omtrdc.net/b/ss/rsid/1/JS-2.22.0/s1'],
    ] as const) expect(isAnalyticsBeacon(m, u), `${m} ${u}`).toBe(true);
  });

  it('first-party collection is known by its address: GA4 through a site\'s tagging server, Adobe, Matomo', () => {
    expect(isAnalyticsBeacon('POST', 'https://metrics.example.org/g/collect?v=2&tid=G-ABC123&en=page_view')).toBe(true);
    expect(isAnalyticsBeacon('GET', 'https://metrics.example.org/g/collect?tid=G-ABC123')).toBe(true);
    expect(isAnalyticsBeacon('GET', 'https://smetrics.example.org/b/ss/rsid/1/JS-2.22.0/s1')).toBe(true);
    expect(isAnalyticsBeacon('POST', 'https://stats.example.org/matomo.php?idsite=1&rec=1')).toBe(true);
    expect(isAnalyticsBeacon('GET', 'https://example.org/analytics/piwik.php?idsite=1')).toBe(true);
    // The site's own addresses that only look alike are not.
    expect(isAnalyticsBeacon('GET', 'https://example.org/g/collect')).toBe(false);
    expect(isAnalyticsBeacon('GET', 'https://example.org/collect')).toBe(false);
    expect(isAnalyticsBeacon('POST', 'https://example.org/api/event')).toBe(false);
    expect(isAnalyticsBeacon('GET', 'https://example.org/matomo.js')).toBe(false);
    expect(isAnalyticsBeacon('POST', 'https://example.org/contact')).toBe(false);
  });

  it('a navigation is never a beacon (the page under test, a frame, a window), nor is a host that only looks alike', () => {
    expect(isAnalyticsBeacon('GET', 'https://www.google-analytics.com/g/collect?v=2', true)).toBe(false);
    expect(isAnalyticsBeacon('POST', 'https://notgoogle-analytics.com/g/collect?v=2')).toBe(false);
    expect(isAnalyticsBeacon('POST', 'https://google-analytics.com.example.org/g/collect')).toBe(false);
    expect(isAnalyticsBeacon('POST', 'not a url')).toBe(false);
    expect(isAnalyticsBeacon('GET', 'data:image/gif;base64,R0lGOD')).toBe(false);
  });
});

describe('quietContext', () => {
  const route = (method: string, url: string, nav = false) => {
    const done: string[] = [];
    const r: RouteLike = {
      request: () => ({ method: () => method, url: () => url, resourceType: () => 'ping', isNavigationRequest: () => nav }),
      abort: async (code) => { done.push(`abort ${code}`); },
      continue: async () => { done.push('continue'); },
      fallback: async () => { done.push('fallback'); },
    };
    return { r, done };
  };

  it('one route on the context: beacons are aborted, everything else goes on to the next handler', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const ctx = { route: async (_p: string | RegExp, h: (r: RouteLike) => unknown) => { handler = h; } } as unknown as ContextLike;
    await quietContext(ctx);
    const beacon = route('POST', 'https://region1.google-analytics.com/g/collect?v=2&tid=G-X');
    await handler!(beacon.r);
    expect(beacon.done).toEqual(['abort blockedbyclient']);
    const script = route('GET', 'https://www.googletagmanager.com/gtag/js?id=G-X');
    await handler!(script.r);
    expect(script.done).toEqual(['fallback']);
    const page = route('GET', 'https://www.google-analytics.com/g/collect', true);
    await handler!(page.r);
    expect(page.done).toEqual(['fallback']);
  });

  it('a request it cannot read goes on unchanged (the other guards still decide it)', async () => {
    let handler: ((r: RouteLike) => unknown) | undefined;
    const ctx = { route: async (_p: string | RegExp, h: (r: RouteLike) => unknown) => { handler = h; } } as unknown as ContextLike;
    await quietContext(ctx);
    const done: string[] = [];
    await handler!({ request: () => { throw new Error('gone'); }, abort: async () => { done.push('abort'); }, continue: async () => { done.push('continue'); }, fallback: async () => { done.push('fallback'); } });
    expect(done).toEqual(['fallback']);
  });
});

describe('one analytics list for the beacon blocking and the probe guard', () => {
  // ANALYTICS_SERVICES is the only list: the scan aborts its beacons (isAnalyticsBeacon) and the probe
  // guard calls a blocked write to it background traffic (isAnalyticsAddress). A service on it is both.
  const sample = (s: (typeof ANALYTICS_SERVICES)[number]) => {
    if (s.host === '*') return s.name.startsWith('Matomo') ? 'https://stats.example.org/matomo.php?idsite=1' : s.name.startsWith('Adobe') ? 'https://metrics.example.org/b/ss/rsid/1/x' : 'https://metrics.example.org/g/collect?v=2&tid=G-ABC123';
    return `https://x.${s.host}${s.paths ? s.paths[0]!.replace(/\/$/, '/x') : '/any'}`;
  };

  it('every service: a POST to it is a beacon and an analytics address', () => {
    for (const s of ANALYTICS_SERVICES) {
      const u = sample(s);
      expect(isAnalyticsBeacon('POST', u), `${s.name} ${u}`).toBe(true);
      expect(isAnalyticsAddress(u), `${s.name} ${u}`).toBe(true);
    }
  });

  it('neither use reaches the site itself, a look-alike host or a shared host off its paths', () => {
    for (const u of ['https://e.org/api/save', 'https://evil-google-analytics.com/g/collect', 'https://google-analytics.com.evil.net/x', 'https://www.google.com/search?q=x', 'https://www.facebook.com/sharer']) {
      expect(isAnalyticsAddress(u), u).toBe(false);
      expect(isAnalyticsBeacon('POST', u), u).toBe(false);
    }
  });

});
