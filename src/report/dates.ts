// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 Tyrannosaurx LLC. Granted (grnted.co): https://www.gnu.org/licenses/agpl-3.0.html
// Report dates (trust review 2026-11-05): a scan's time is stored in UTC, and its UTC day is tomorrow for
// a US reader every evening. Every date a report shows comes from here: the day in Pacific time with the zone
// named (the hosted report's <time> markup, which shows a reader their own day, is not part of the engine). Pacific per the workspace rule (date-fns-tz, America/Los_Angeles):
// a scan carries no reliable time zone of its own. Engine core: no Node-only imports.
import { formatInTimeZone } from 'date-fns-tz';

/** The zone the fixed dates are in, and its name in words. */
export const REPORT_TIME_ZONE = 'America/Los_Angeles';
export const REPORT_TIME_ZONE_NAME = 'Pacific time';
/** The zone's short name, where a line has no room for the words ("Nov 5, 2026 PT"). */
export const REPORT_TIME_ZONE_SHORT = 'PT';

/** The instant, or null when `iso` is not a full ISO 8601 date-time with a zone (or a plain date). */
export function reportInstant(iso: unknown): Date | null {
  const s = typeof iso === 'string' ? iso.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2}))?$/.test(s)) return null;
  // A plain date is a day already: noon UTC keeps it the same day in Pacific time.
  const d = new Date(s.length === 10 ? `${s}T12:00:00Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** "2026-11-05": the day in Pacific time; '' when the date can't be read. */
export function reportDay(iso: unknown): string {
  const d = reportInstant(iso);
  return d ? formatInTimeZone(d, REPORT_TIME_ZONE, 'yyyy-MM-dd') : '';
}

/** "November 5, 2026": the day in Pacific time; '' when the date can't be read. */
export function longDate(iso: unknown): string {
  const d = reportInstant(iso);
  return d ? formatInTimeZone(d, REPORT_TIME_ZONE, 'MMMM d, yyyy') : '';
}
