// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// The registrable domain of an address (example.org for www.example.org), to tell a site's own
// content from third-party services: the timing probe's guard events and scoring v3's third-party
// frames. Worker-safe: no Node imports.
/** Multi-label public suffixes (a short list of the common ones; no dependency on the full list). */
const MULTI_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'sch.uk', 'nhs.uk', 'police.uk', 'me.uk', 'ltd.uk', 'plc.uk', 'net.uk',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'asn.au', 'id.au',
  'co.nz', 'org.nz', 'net.nz', 'govt.nz', 'ac.nz', 'school.nz', 'school.nz', 'geek.nz', 'gen.nz', 'iwi.nz',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ed.jp', 'lg.jp',
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'gouv.fr', 'gc.ca', 'gov.ie', 'co.za', 'org.za', 'gov.za', 'ac.za', 'co.in', 'gov.in', 'ac.in', 'org.in', 'net.in',
  'com.mx', 'gob.mx', 'edu.mx', 'org.mx', 'com.cn', 'gov.cn', 'edu.cn', 'org.cn', 'com.hk', 'gov.hk', 'edu.hk', 'org.hk',
  'com.sg', 'gov.sg', 'edu.sg', 'org.sg', 'co.kr', 'go.kr', 'ac.kr', 'or.kr', 'com.tw', 'gov.tw', 'edu.tw', 'org.tw',
  'com.ar', 'gob.ar', 'com.tr', 'gov.tr', 'edu.tr', 'co.il', 'gov.il', 'ac.il', 'org.il', 'com.es', 'gob.es', 'org.es',
  'co.at', 'or.at', 'gv.at', 'ac.at', 'com.pl', 'gov.pl', 'edu.pl', 'org.pl',
]);
/** Shared hosting suffixes: each customer's site is one more label (a.github.io and b.github.io are two sites). */
const TENANT_SUFFIXES = new Set([
  'github.io', 'gitlab.io', 'blogspot.com', 'vercel.app', 'netlify.app', 'pages.dev', 'workers.dev', 'herokuapp.com', 'azurewebsites.net',
  's3.amazonaws.com', 'cloudfront.net', 'firebaseapp.com', 'web.app', 'wordpress.com', 'wixsite.com', 'squarespace.com', 'weebly.com',
]);
/** US locality labels under a state (k12.or.us, lib.or.us, state.or.us…): districts and agencies register beneath them. */
const US_LOCALITY = new Set(['k12', 'cc', 'lib', 'tec', 'gen', 'state', 'dst', 'cog', 'mus', 'pvt']);

/**
 * A name that is itself a listed public or shared-hosting suffix (co.uk, github.io), or a single
 * label: nobody registers it, so it is never anyone's site. Only the short lists above: an unlisted
 * suffix is not recognised (see registrableDomain).
 */
export function isListedSuffix(name: string): boolean {
  const n = name.toLowerCase().replace(/\.$/, '');
  if (!n.includes('.')) return true;
  if (MULTI_SUFFIXES.has(n) || TENANT_SUFFIXES.has(n)) return true;
  const l = n.split('.');
  // <st>.us and <locality>.<st>.us (k12.or.us) are suffixes too.
  return (l.length === 2 && l[1] === 'us' && l[0]!.length === 2) || (l.length === 3 && l[2] === 'us' && l[1]!.length === 2 && US_LOCALITY.has(l[0]!));
}

/**
 * The registrable domain of an address, to tell the site's own requests from third-party services,
 * without a public-suffix dependency: two labels, or one more under a listed multi-label public
 * suffix (example.co.uk) or shared-hosting suffix (name.github.io). US states: a city or agency
 * under the state (salem.or.us, from www.ci.salem.or.us), or a district under a locality label
 * (amity.k12.or.us); the locality domain itself (k12.or.us) and its www are one site. An address
 * that cannot be parsed gives ''.
 */
export function registrableDomain(url: string): string {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase().replace(/\.$/, '');
  } catch {
    return '';
  }
  if (/^[\d.]+$/.test(host) || host.includes(':')) return host;
  const l = host.split('.');
  const n = l.length;
  const last = (k: number) => l.slice(-k).join('.');
  if (n <= 2) return host;
  if (l[n - 1] === 'us' && l[n - 2]!.length === 2) {
    if (US_LOCALITY.has(l[n - 3]!)) {
      // <district>.k12.<st>.us; k12.<st>.us and www.k12.<st>.us are one site.
      return n >= 4 && l[n - 4] !== 'www' ? last(4) : last(3);
    }
    return last(3);
  }
  for (const suffixes of [TENANT_SUFFIXES, MULTI_SUFFIXES]) {
    if (suffixes.has(last(3)) && n >= 4) return last(4);
    if (suffixes.has(last(2))) return last(3);
  }
  return last(2);
}

