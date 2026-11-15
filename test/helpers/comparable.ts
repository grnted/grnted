// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// A report as two identical scans must agree on it: everything but the clock (startedAt, finishedAt
// and every `ms`), and with the fixture servers' random ports taken out of addresses.
export function comparable(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(comparable);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.entries(v as Record<string, unknown>)
      .filter(([k]) => k !== 'startedAt' && k !== 'finishedAt' && k !== 'ms')
      .map(([k, x]) => [k, comparable(x)]));
  }
  if (typeof v === 'string') return v.replace(/(127\.0\.0\.1|localhost):\d+/g, '$1:PORT');
  return v;
}
