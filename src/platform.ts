// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Platform detection and platform-specific fix guidance (Plan 7, W3a). One shared detector for the
// report ("Built on <platform>"), the issue cards ("On <platform>: ...") and the fix-it prompts.
// Engine core: no Node-only imports.
//
// Detection reads only what the scan's collector saw on the page (src/collect/platform.ts): the
// generator meta tag, a few fixed DOM markers, and the addresses of resources the page itself loaded
// (scripts, stylesheets, icons, images). Never failing-element HTML, link addresses, page addresses or
// page text: a school that writes about, or links to, a vendor is not built on it. Asset addresses are
// matched on their host (a vendor's CDN), or on the site's own host plus a path prefix (/wp-content/).
// Generator patterns are anchored on the product name at the start. A generator decides alone (two
// that disagree are unknown). Otherwise each platform's strength is its DISTINCT matching asset
// addresses plus 2 for a DOM marker; exactly one platform at MIN_STRENGTH or more is named; anything
// else (none, two, a tie) is unknown, and the report gives the general fix.
//
// Guidance: only steps the vendor's own public help pages document, each with its source URL in a
// comment beside it (checked 2026-11-03). Where no vendor page documents the step, the line is
// "In <platform>'s editor, look for <the generic name of the setting>.": never an invented menu path.
// Joomla's docs.joomla.org refused automated fetches on 2026-11-03; its steps were read from the
// pages' indexed text. Copy: plain and confident, no hedging.
import type { SiteReport } from './types.js';

export type PlatformId =
  | 'finalsite' | 'wordpress' | 'apptegy' | 'edlio' | 'finalsite-wcm' | 'schoolmessenger' | 'drupal' | 'squarespace' | 'wix'
  | 'google-sites' | 'joomla' | 'webflow' | 'shopify' | 'civicplus' | 'granicus' | 'revize' | 'dnn' | 'sitefinity' | 'umbraco'
  | 'hubspot' | 'weebly' | 'astro';

/** What the collector saw that can name a platform (fixed-pattern matching only; nothing here is shown). */
export interface PlatformSignals {
  /** The scanned site's start address: path-prefix signs count only on its own host. */
  site?: string;
  /** `<meta name="generator">` contents. */
  generator?: readonly string[];
  /** Addresses of resources the page loaded: scripts, stylesheets, icons, images. */
  assets?: readonly string[];
  /** DOM markers the collector found (fixed names: 'drupal', 'wordpress', 'squarespace', 'wix', 'joomla', 'astro'). */
  markers?: readonly string[];
}

export interface PlatformDef {
  id: PlatformId;
  name: string;
  /** The signs in plain words ("files served from squarespace.com"). */
  sign: string;
  /** Matches an asset's host name (a vendor's own hosts; anchored on the dot boundary). */
  host?: RegExp;
  /** Matches an asset's path on the site's own host (a platform that serves files from the site). */
  path?: RegExp;
  /** Matches an asset's path on a vendor host (with `pathHost`). */
  pathHost?: { host: RegExp; path: RegExp };
  /** Matches the generator meta tag. */
  generator?: RegExp;
  /** A DOM marker the collector reports. */
  marker?: string;
}

/** `(^|.)a.b$`: the host itself or any subdomain of it. */
const hosts = (...names: string[]) => new RegExp(`(?:^|\\.)(?:${names.map((n) => n.replace(/\./g, '\\.')).join('|')})$`, 'i');

/** Fixed hosts, paths and names. */
export const PLATFORMS: readonly PlatformDef[] = [
  { id: 'finalsite', name: 'Finalsite', sign: 'files served from finalsite', host: hosts('finalsite.net', 'finalsite.com'), path: /^\/fs\/(?:resource-manager|pages|elements)\//i, generator: /^\s*finalsite\b/i },
  { id: 'finalsite-wcm', name: 'Finalsite Web Community Manager (formerly Blackboard)', sign: 'addresses with /cms/lib/ (Centricity) or schoolwires', host: hosts('schoolwires.net', 'schoolwires.com'), path: /^\/cms\/lib\d*\/[^/]+\/Centricity\//i, generator: /^\s*(?:schoolwires|(?:blackboard |finalsite )?web community manager)\b/i },
  { id: 'apptegy', name: 'Apptegy (Thrillshare)', sign: 'files served from apptegy.net', host: hosts('apptegy.net', 'apptegy.com', 'thrillshare.com'), generator: /^\s*(?:apptegy|thrillshare)\b/i },
  { id: 'edlio', name: 'Edlio', sign: 'files served from Edlio (files.edl.io)', host: hosts('edl.io', 'edlio.com', 'edliocdn.com', 'edliocloud.com'), generator: /^\s*edlio\b/i },
  { id: 'schoolmessenger', name: 'SchoolMessenger Presence', sign: 'addresses with /UserFiles/Servers/Server_ (SharpSchool)', host: hosts('sharpschool.com', 'sharpschool.net'), path: /^\/UserFiles\/Servers\/Server_\d+\//i, generator: /^\s*(?:sharpschool|schoolmessenger)\b/i },
  { id: 'wordpress', name: 'WordPress', sign: 'addresses with /wp-content/ or /wp-includes/', path: /^\/wp-(?:content|includes)\//i, generator: /^\s*wordpress/i, marker: 'wordpress' },
  { id: 'drupal', name: 'Drupal', sign: 'addresses with /sites/default/files/ or Drupal attributes', path: /^\/(?:sites\/default\/files|core\/misc)\//i, generator: /^\s*drupal/i, marker: 'drupal' },
  { id: 'joomla', name: 'Joomla', sign: 'Joomla addresses (/media/jui/, /media/system/js/)', path: /^\/media\/(?:jui|system\/js)\//i, generator: /^\s*joomla/i, marker: 'joomla' },
  { id: 'squarespace', name: 'Squarespace', sign: 'files served from squarespace.com', host: hosts('squarespace.com', 'squarespace-cdn.com'), generator: /^\s*squarespace\b/i, marker: 'squarespace' },
  { id: 'wix', name: 'Wix', sign: 'files served from wixstatic.com', host: hosts('wixstatic.com', 'parastorage.com'), generator: /^\s*wix\.com\b/i, marker: 'wix' },
  { id: 'google-sites', name: 'Google Sites', sign: 'Google Sites files (gstatic.com/_/atari/)', pathHost: { host: hosts('gstatic.com'), path: /^\/_\/atari\// }, generator: /^\s*google sites\b/i },
  { id: 'webflow', name: 'Webflow', sign: 'files served from website-files.com', host: hosts('website-files.com', 'webflow.com'), generator: /^\s*webflow\b/i },
  { id: 'shopify', name: 'Shopify', sign: 'files served from cdn.shopify.com', host: hosts('cdn.shopify.com') },
  { id: 'civicplus', name: 'CivicPlus', sign: 'files served from civicplus.com', host: hosts('civicplus.com') },
  { id: 'granicus', name: 'Granicus', sign: 'files served from granicus.com', host: hosts('granicus.com') },
  { id: 'revize', name: 'Revize', sign: 'files served from revize.com', host: hosts('revize.com') },
  { id: 'dnn', name: 'DNN (DotNetNuke)', sign: 'addresses with /Portals/ or /DesktopModules/', path: /^\/(?:Portals\/\d|DesktopModules\/)/i, generator: /^\s*(?:dotnetnuke|dnn)\b/i },
  { id: 'sitefinity', name: 'Sitefinity', sign: 'addresses with /Sitefinity/', path: /^\/Sitefinity\//i, generator: /^\s*sitefinity\b/i },
  { id: 'umbraco', name: 'Umbraco', sign: 'addresses with /umbraco/', path: /^\/umbraco\//i, generator: /^\s*umbraco\b/i },
  { id: 'hubspot', name: 'HubSpot CMS', sign: 'files served from hubspotusercontent', host: hosts('hubspotusercontent-na1.net', 'hubspotusercontent-eu1.net', 'hubspotusercontent.net', 'hs-sites.com'), generator: /^\s*hubspot\b/i },
  { id: 'weebly', name: 'Weebly', sign: 'files served from weebly.com', host: hosts('weebly.com', 'weeblystatic.com'), generator: /^\s*weebly\b/i },
  // Batch 19 (first-run feedback): Astro's documented signs only. Astro.generator is "Astro v5.x.x" (docs.astro.build API
  // reference); scoped styles put data-astro-cid-* attributes on elements (the default scopedStyleStrategy, styling
  // guide); build files go under /_astro/ (the default build.assets, configuration reference). Checked 2026-11-13.
  { id: 'astro', name: 'Astro', sign: 'Astro build files (/_astro/) or its data-astro-cid attributes', path: /^\/_astro\//, generator: /^\s*astro v?\d/i, marker: 'astro' },
];

/** A generator match counts as this many matching addresses (only for ordering `detectPlatforms`). */
const GENERATOR_WEIGHT = 5;
/** A DOM marker counts as this many distinct addresses: a sign, never a decision on its own against others. */
const MARKER_WEIGHT = 2;
/**
 * Strength a platform needs to be named when no generator decides: two distinct addresses, or a
 * marker (one stray address, such as an embedded widget's on every page, is not enough).
 */
export const MIN_STRENGTH = 2;
/** Strings read per signal kind (bounded work on any input). */
const MAX_STRINGS = 200;

export interface DetectedPlatform {
  id: PlatformId;
  name: string;
  /** The signs in plain words. */
  sign: string;
  /** How strongly the signals point to it (generator 5, marker 3, each matching address 1). */
  strength: number;
}

const strings = (v: readonly unknown[] | undefined) => (Array.isArray(v) ? v : []).slice(0, MAX_STRINGS)
  .filter((x): x is string => typeof x === 'string' && x.length > 0).map((x) => x.slice(0, 2000));

/** The site's own host without a leading "www.", or '' when there is none. */
function bareHost(u: string | undefined): string {
  try {
    return u ? new URL(u).hostname.toLowerCase().replace(/^www\./, '') : '';
  } catch {
    return '';
  }
}

/** Whether one asset address is a sign of `p`: its host, or the site's own host plus a path prefix. */
function assetMatches(p: PlatformDef, url: URL, siteHost: string): boolean {
  const host = url.hostname.toLowerCase();
  if (p.host?.test(host)) return true;
  if (p.pathHost && p.pathHost.host.test(host) && p.pathHost.path.test(url.pathname)) return true;
  return !!p.path && !!siteHost && host.replace(/^www\./, '') === siteHost && p.path.test(url.pathname);
}

interface Counted { p: PlatformDef; i: number; generator: boolean; marker: boolean; assets: number }

function count(s: PlatformSignals): Counted[] {
  const generator = strings(s.generator);
  const markers = new Set(strings(s.markers));
  const siteHost = bareHost(s.site);
  // Distinct addresses: the same widget file on several pages is one address.
  const urls = new Map<string, URL>();
  for (const a of strings(s.assets)) {
    try {
      const u = new URL(a);
      u.hash = '';
      if ((u.protocol === 'http:' || u.protocol === 'https:') && !urls.has(u.href)) urls.set(u.href, u);
    } catch {
      // not an address: no sign
    }
  }
  return PLATFORMS.map((p, i) => ({
    p, i,
    generator: !!p.generator && generator.some((g) => p.generator!.test(g)),
    marker: !!p.marker && markers.has(p.marker),
    assets: [...urls.values()].filter((u) => assetMatches(p, u, siteHost)).length,
  }));
}

const detected = (c: Counted): DetectedPlatform => ({
  id: c.p.id, name: c.p.name, sign: c.p.sign,
  strength: (c.generator ? GENERATOR_WEIGHT : 0) + (c.marker ? MARKER_WEIGHT : 0) + c.assets,
});

/** Every platform with any sign, strongest first (ties in PLATFORMS order). Diagnostic: the report uses `decidePlatform`. */
export function detectPlatforms(s: PlatformSignals): DetectedPlatform[] {
  return count(s).map((c) => ({ c, d: detected(c) })).filter((x) => x.d.strength > 0)
    .sort((a, b) => b.d.strength - a.d.strength || a.c.i - b.c.i).map((x) => x.d);
}

/**
 * The platform the report names, or null (unknown): an anchored generator decides alone (any number of
 * other assets and markers aside; two generators that disagree are unknown); otherwise exactly one
 * platform whose distinct addresses plus 2 for a marker reach MIN_STRENGTH. Two such platforms, a tie,
 * and nothing at all are unknown.
 */
export function decidePlatform(s: PlatformSignals): DetectedPlatform | null {
  const all = count(s);
  const declared = all.filter((c) => c.generator);
  if (declared.length) return declared.length === 1 ? detected(declared[0]!) : null;
  const enough = all.filter((c) => c.assets + (c.marker ? MARKER_WEIGHT : 0) >= MIN_STRENGTH);
  return enough.length === 1 ? detected(enough[0]!) : null;
}

/** The report's platform field: `decidePlatform`, or unknown. */
export function platformSummary(s: PlatformSignals): NonNullable<SiteReport['platform']> {
  const top = decidePlatform(s);
  return top ? { id: top.id, name: top.name, signs: [top.sign] } : { id: 'unknown', name: 'Unknown', signs: [] };
}

const KNOWN = new Map(PLATFORMS.map((p) => [p.id, p]));

/**
 * The site's platform for the report and the prompts: the one the scan recorded (`report.platform`).
 * Null when unknown, and for a report made before the scan recorded one (its text is never a sign).
 */
export function reportPlatform(report: SiteReport): DetectedPlatform | null {
  const recorded = report.platform;
  if (!recorded || typeof recorded !== 'object') return null;
  const def = KNOWN.get(recorded.id as PlatformId);
  return def ? { id: def.id, name: def.name, sign: def.sign, strength: GENERATOR_WEIGHT } : null;
}

// ---- guidance ----------------------------------------------------------------------------------------

/** The kinds of problem that get platform guidance. */
export type IssueType = 'alt' | 'links' | 'headings' | 'colors' | 'forms' | 'documents' | 'captions' | 'menus';
export const ISSUE_TYPES: readonly IssueType[] = ['alt', 'links', 'headings', 'colors', 'forms', 'documents', 'captions', 'menus'];

const RULE_TYPES: Readonly<Record<string, IssueType>> = {
  'image-alt': 'alt', 'role-img-alt': 'alt', 'input-image-alt': 'alt', 'area-alt': 'alt', 'object-alt': 'alt', 'svg-img-alt': 'alt', 'image-redundant-alt': 'alt',
  'link-name': 'links', 'identical-links-same-purpose': 'links',
  'heading-order': 'headings', 'empty-heading': 'headings', 'p-as-heading': 'headings', 'page-has-heading-one': 'headings',
  'color-contrast': 'colors', 'link-in-text-block': 'colors', 'color-contrast-enhanced': 'colors',
  label: 'forms', 'select-name': 'forms', 'aria-input-field-name': 'forms', 'form-field-multiple-labels': 'forms', 'autocomplete-valid': 'forms', 'label-title-only': 'forms',
  'video-caption': 'captions', 'audio-caption': 'captions',
  'aria-hidden-focus': 'menus',
};
const CRITERION_TYPES: Readonly<Record<string, IssueType>> = {
  '1.1.1': 'alt', '1.4.5': 'alt',
  '2.4.4': 'links',
  '2.4.6': 'headings', '1.3.1': 'headings',
  '1.4.3': 'colors', '1.4.11': 'colors', '1.4.1': 'colors',
  '3.3.2': 'forms', '1.3.5': 'forms', '3.3.1': 'forms',
  '1.2.1': 'captions', '1.2.2': 'captions', '1.2.3': 'captions', '1.2.4': 'captions', '1.2.5': 'captions',
  '2.4.11': 'menus', '1.4.13': 'menus', '2.1.2': 'menus',
};

/** The kind of a problem (`Problem.key`) for platform guidance; null when no guidance applies. */
export function issueTypeOf(key: string): IssueType | null {
  if (key === 'documents') return 'documents';
  const m = /^(rule|criterion|ai):(.+)$/.exec(key);
  if (!m) return null;
  return (m[1] === 'rule' ? RULE_TYPES[m[2]!] : CRITERION_TYPES[m[2]!]) ?? null;
}

/** The generic name of the setting to look for, when the vendor documents no steps. */
const LOOK_FOR: Readonly<Record<IssueType, string>> = {
  alt: 'the image’s alt text (alternative text) field',
  links: 'the link text',
  headings: 'the heading styles (Heading 2, Heading 3)',
  colors: 'the theme’s color settings',
  forms: 'each form field’s label',
  documents: 'the option to replace an uploaded file, so links keep working',
  captions: 'the video’s captions setting',
  menus: 'the menu and the alert or pop-up settings',
};

/** Steps the vendors document, by platform and kind. Each with its source. */
const DOCUMENTED: Partial<Record<PlatformId, Partial<Record<IssueType, string>>>> = {
  finalsite: {
    // https://www.finalsitesupport.com/hc/en-us/articles/34929098386957-Add-alt-text-to-images
    alt: 'in Resources, click the image to open the Quick Actions Panel and fill in “Alt Text”; for an image in a Content element, right-click it, choose “Image Properties” and fill in “Alternative text”.',
    // https://www.finalsitesupport.com/hc/en-us/articles/45452658444813-Finalsite-AudioEye-Fix-form-labels-and-link-text
    links: 'rewrite generic link text so it says where the link goes; the link’s “Title” field is no substitute.',
    // https://www.finalsitesupport.com/hc/en-us/articles/115000309212-Structuring-pages-for-accessibility-with-HTML-headings
    headings: 'in a Content element, highlight the text, open the Formatting menu (¶) and pick the heading level; an element’s title is a Heading 2 unless you pick another level beside the title field.',
    // https://www.finalsitesupport.com/hc/en-us/articles/45451786032269-Finalsite-AudioEye-Fix-a-color-contrast-flag
    colors: 'site-wide colors are set in the site theme and its CSS; text color inside a Content element is set with the toolbar’s font color option.',
    // https://www.finalsitesupport.com/hc/en-us/articles/360049915452-Form-fields
    forms: 'give each form field a “Label”; hint text and placeholder text do not name the field.',
    // https://www.finalsitesupport.com/hc/en-us/articles/360004515411-Replace-resources
    // https://www.finalsitesupport.com/hc/en-us/articles/115000279811-Making-accessible-PDFs
    documents: 'fix the PDF at its source, then in Resources select the file and use “Replace Resource” in the Quick Actions Panel, so every link keeps working.',
    // https://www.finalsitesupport.com/hc/en-us/articles/45464414613389-Finalsite-AudioEye-Fix-captions-and-transcripts
    // https://www.finalsitesupport.com/hc/en-us/articles/115003734032-Video-element
    captions: 'for a video uploaded to Finalsite, add a WebVTT (.vtt) caption file and turn on “Closed Captions” in the Video element; captions for YouTube and Vimeo videos are added on YouTube or Vimeo.',
    // https://www.finalsitesupport.com/hc/en-us/articles/4407200442637-Page-Pops-overview
    menus: 'pop-up alerts are “Page Pops”, in the Modules menu.',
  },
  wordpress: {
    // https://wordpress.org/documentation/article/image-block/
    alt: 'select the Image block and fill in “Alternative text” in the block settings, or turn on “Mark as decorative” for a purely decorative image.',
    // https://wordpress.org/documentation/article/link-editing/
    links: 'edit the link’s visible text in the block itself, so the words say where the link goes.',
    // https://wordpress.org/documentation/article/heading-block/
    headings: 'select the Heading block and choose its level (H1 to H6) from the block toolbar or the block settings.',
    // https://wordpress.org/documentation/article/styles-overview/
    colors: 'with a block theme, set the color palette in Appearance > Editor > Styles > Colors.',
    // https://wordpress.org/documentation/article/file-block/
    documents: 'select the File block and use “Replace” to upload the fixed PDF.',
    // https://wordpress.org/documentation/article/video-block/
    captions: 'in the Video block toolbar, open “Text tracks”, upload a WebVTT (.vtt) file and set its kind to Captions.',
    // https://wordpress.org/documentation/article/navigation-block/
    menus: 'the Navigation block’s settings set when the menu opens as an overlay (“Overlay visibility”), and each menu item’s text is in its Content tab.',
  },
  apptegy: {
    // https://support.apptegy.com/en/articles/11729731-using-the-homepage-gallery
    alt: 'homepage gallery images take their alt text in the “Alt Text” field of the “Add Images” pop-up.',
    // https://support.apptegy.com/en/articles/11841891-linking-documents-on-cms-pages
    links: 'for a link to a document, highlight the text, click the link icon and set the link text in the “Documents” tab.',
    // https://support.apptegy.com/en/articles/12578908-cms-content-elements
    headings: 'use the “Header” element for headings and set its level (H1 to H5) on the headline text.',
    // https://support.apptegy.com/en/articles/11841891-linking-documents-on-cms-pages
    documents: 'link documents from the link icon’s “Documents” tab, choosing the file in the “Documents” list; upload the fixed PDF and link that one.',
    // https://support.apptegy.com/en/articles/12649339-how-configure-your-site-menu
    // https://support.apptegy.com/en/articles/12435293-creating-and-publishing-the-alert-banner
    menus: 'menu item text is the “Text” field in the Site Menu; the alert banner is in CMS “Settings”, “Alert Banner” tab, where it can be edited or unpublished.',
  },
  edlio: {
    // https://help.edlio.com/apps/news/article/748419
    captions: 'videos uploaded through the Videos feature get automatic captions, which can be edited; check them against what is said.',
  },
  drupal: {
    // https://www.drupal.org/docs/core-modules-and-themes/core-modules/media-library-module/embedding-media-with-ckeditor-5
    // https://www.drupal.org/node/3442726
    alt: 'click the embedded image in the editor and set its alternative text from the balloon toolbar (Drupal 10.4 and later can mark it decorative there).',
    // https://www.drupal.org/docs/8/core/modules/contact/overview
    forms: 'contact forms are under Structure > Contact forms; give each field a clear label there.',
    // https://www.drupal.org/docs/user_guide/en/menu-link-from-content.html
    menus: 'a page’s menu link text is its “Menu link title”, under “Menu settings” when you edit the content.',
  },
  squarespace: {
    // https://support.squarespace.com/hc/en-us/articles/206542357-Adding-alt-text-to-images
    alt: 'edit the page, click the image block’s pencil icon and fill in “Image alt text” in the Content tab.',
    // https://support.squarespace.com/hc/en-us/articles/206543827-Creating-text-links
    links: 'highlight the link text and use the link icon in the text toolbar, so the words say where the link goes.',
    // https://support.squarespace.com/hc/en-us/articles/115012080887-Formatting-text
    headings: 'use the Format dropdown in the text toolbar to make headings.',
    // https://support.squarespace.com/hc/articles/205815788
    colors: 'site colors are set in the site styles (the paintbrush icon in the Pages panel), under colors.',
    // https://support.squarespace.com/hc/en-us/articles/206566737-Form-blocks
    forms: 'click the form block’s pencil icon, choose “Edit Form Fields”, select each field and give it a label.',
    // https://support.squarespace.com/hc/en-us/articles/205813928
    documents: 'upload the fixed PDF from the link editor’s “File” option and link to it.',
    // https://support.squarespace.com/hc/articles/13630857891981
    captions: 'add captions to the video on YouTube or Vimeo; the video block shows them.',
    // https://support.squarespace.com/hc/en-us/articles/205815318-Add-an-announcement-bar
    // https://support.squarespace.com/hc/en-us/articles/115008375848-Add-a-promotional-pop-up
    menus: 'the announcement bar and the promotional pop-up each have their own panel with an on and off switch (“Enable Announcement Bar”, “Display pop-up”).',
  },
  wix: {
    // https://support.wix.com/en/article/accessibility-preparing-your-images-and-galleries
    alt: 'click the image, open Settings and describe it under “What’s in the image?”.',
    // https://support.wix.com/en/article/accessibility-preparing-your-site-structure
    headings: 'select the text, choose “Edit Text”, then “SEO & Accessibility”, and set the “HTML tag”.',
    // https://support.wix.com/en/article/accessibility-preparing-your-text-and-graphics
    colors: 'the “Accessibility Wizard” in Settings scans the site and offers “Improve color contrast”.',
    // https://support.wix.com/en/article/accessibility-creating-an-accessible-wix-form
    forms: 'select the form, choose “Edit Form”, select each field and set its “Field title” in Settings, with “Show field title” on.',
    // https://support.wix.com/en/article/accessibility-making-document-files-accessible
    documents: 'fix each PDF in the program that made it (Acrobat, Word) and upload it again.',
    // https://support.wix.com/en/article/wix-video-request-adding-captions-to-your-videos-in-wix-video
    // https://support.wix.com/en/article/accessibility-making-videos-and-audio-accessible
    captions: 'Wix Video does not take captions, so caption the video with another tool (Wix suggests services such as Amara) or host it where captions are supported.',
    // https://support.wix.com/en/article/wix-editor-customizing-your-mobile-menu
    menus: 'give the mobile menu an accessible name in its Settings.',
  },
  'google-sites': {
    // https://support.google.com/sites/answer/90538
    alt: 'select the image, choose “More editing options”, then “Add alt text”.',
    // https://support.google.com/sites/answer/7529116
    links: 'use the page’s title as the link text, not “click here” or the web address.',
    // https://support.google.com/sites/answer/90538
    headings: 'in a text box, pick a heading or title style from the style menu.',
    // https://support.google.com/sites/answer/6372865
    colors: 'in the Themes panel, edit a custom theme and choose “Customize colors”.',
    // https://support.google.com/sites/answer/90569
    documents: 'documents come from Google Drive (Insert, then “Drive”); fix the file in Drive.',
    // https://support.google.com/drive/answer/1372218
    captions: 'for a video stored in Google Drive, add captions in Drive (“Manage caption tracks”); for a YouTube video, add them on YouTube.',
    // https://support.google.com/sites/answer/6372865
    // https://support.google.com/sites/answer/9826219
    menus: 'Settings has the navigation mode (“Navigation”) and the “Announcement banner”.',
  },
  joomla: {
    // https://docs.joomla.org/Help5.x:Articles:_Edit
    // https://docs.joomla.org/Adding_an_image_to_an_article/en
    alt: 'when you insert an image, fill in “Image Description (Alt Text)”, or tick “No Description” for a decorative one.',
    // https://docs.joomla.org/J4.x:Cassiopeia_Template_Customisation
    colors: 'with the Cassiopeia template, the template style sets the “Color Theme”, and custom colors go in the template’s user.css.',
    // https://docs.joomla.org/Help5.x:Media/en
    documents: 'upload the fixed PDF with the Media Manager’s “Upload” button.',
    // https://docs.joomla.org/Help5.x:Menu_Item:_URL/en
    menus: 'a menu item’s visible name is its “Menu Title”.',
  },
};

/** Platforms with guidance (documented steps or the "look for" line): the ones the plan names. */
const GUIDED: ReadonlySet<PlatformId> = new Set(['finalsite', 'wordpress', 'apptegy', 'edlio', 'finalsite-wcm', 'schoolmessenger', 'drupal', 'squarespace', 'wix', 'google-sites', 'joomla']);

/**
 * One line of platform guidance for a kind of problem: "On <platform>: <documented step>", or "In
 * <platform>’s editor, look for <setting>." when the vendor documents none. Null for a platform
 * without guidance.
 */
export function platformGuidance(id: PlatformId | string, type: IssueType): string | null {
  const def = KNOWN.get(id as PlatformId);
  if (!def || !GUIDED.has(def.id)) return null;
  const step = DOCUMENTED[def.id]?.[type];
  return step ? `On ${def.name}: ${step}` : `In ${def.name}’s editor, look for ${LOOK_FOR[type]}.`;
}

/** The guidance for a problem (`Problem.key`) on the report's platform, or null. */
export function problemGuidance(report: SiteReport, key: string, platform: DetectedPlatform | null = reportPlatform(report)): string | null {
  const type = issueTypeOf(key);
  return platform && type ? platformGuidance(platform.id, type) : null;
}
