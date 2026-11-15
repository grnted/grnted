// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
export type TargetCheck = { ok: true; url: URL } | { ok: false; reason: string };

const BLOCKED_SUFFIX = /(^|\.)(localhost|local|internal|lan|home|arpa|test|invalid|corp|intranet)$/i;

/** Syntactic gate for a URL the hosted service is asked to scan. DNS checks are layered on top. */
export function checkTargetUrl(input: string): TargetCheck {
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return { ok: false, reason: 'That is not a valid web address.' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: 'Only http and https addresses can be scanned.' };
  }
  if (url.username || url.password) return { ok: false, reason: 'Addresses with credentials are not allowed.' };
  if (url.port) return { ok: false, reason: 'Only standard ports (80 and 443) can be scanned.' };
  const host = url.hostname;
  // Any ':' means an IPv6 literal (bracketed by the URL parser, IPv4-mapped or not): never a name.
  if (parseV4(host) || host.startsWith('[') || host.includes(':')) {
    return { ok: false, reason: 'Enter a domain name, not an IP address.' };
  }
  if (!host.includes('.') || BLOCKED_SUFFIX.test(host)) {
    return { ok: false, reason: 'That address is not a public website.' };
  }
  return { ok: true, url };
}

/** True only for globally routable unicast addresses. Anything unparseable is not public. */
export function isPublicIp(ip: string): boolean {
  const v4 = parseV4(ip);
  if (v4) return v4Public(v4);
  const v6 = parseV6(ip);
  if (v6) return v6Public(v6);
  return false;
}

function parseV4(s: string): number[] | null {
  const parts = s.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    nums.push(n);
  }
  return nums;
}

function v4Public([a = 0, b = 0, c = 0]: number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false; // CGNAT
  if (a === 169 && b === 254) return false; // link-local, cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false; // multicast, reserved, broadcast
  return true;
}

function parseV6(input: string): number[] | null {
  let s = input.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  const lastColon = s.lastIndexOf(':');
  const tail = s.slice(lastColon + 1);
  if (tail.includes('.')) {
    const v4 = parseV4(tail);
    if (!v4) return null;
    const hi = (((v4[0] ?? 0) << 8) | (v4[1] ?? 0)).toString(16);
    const lo = (((v4[2] ?? 0) << 8) | (v4[3] ?? 0)).toString(16);
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups: string[];
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 1) return null;
    groups = [...head, ...Array<string>(fill).fill('0'), ...rest];
  } else {
    groups = head;
  }
  if (groups.length !== 8 || groups.some((g) => !/^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function v6Public(h: number[]): boolean {
  const [h0 = 0, h1 = 0, h2 = 0, h3 = 0, h4 = 0, h5 = 0, h6 = 0, h7 = 0] = h;
  const embeddedV4 = [h6 >> 8, h6 & 0xff, h7 >> 8, h7 & 0xff];
  if (h0 === 0 && h1 === 0 && h2 === 0 && h3 === 0 && h4 === 0) {
    if (h5 === 0xffff) return v4Public(embeddedV4); // IPv4-mapped
    return false; // ::, ::1, deprecated IPv4-compatible
  }
  if (h0 === 0x64 && h1 === 0xff9b && h2 === 0 && h3 === 0 && h4 === 0 && h5 === 0) return v4Public(embeddedV4); // NAT64
  if ((h0 & 0xfe00) === 0xfc00) return false; // unique local
  if ((h0 & 0xffc0) === 0xfe80) return false; // link-local
  if ((h0 & 0xff00) === 0xff00) return false; // multicast
  if (h0 === 0x2001 && h1 === 0x0db8) return false; // documentation
  if (h0 === 0x0100 && h1 === 0 && h2 === 0 && h3 === 0) return false; // discard
  return true;
}
