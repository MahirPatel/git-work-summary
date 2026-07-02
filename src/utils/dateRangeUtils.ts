import { DateRange, SummaryPeriod } from '../models/types';

/** Widest span allowed for a custom date range, per the product spec ("max 1 month window"). */
export const MAX_CUSTOM_RANGE_DAYS = 31;

/** Formats a Date as a local YYYY-MM-DD string (not UTC - avoids off-by-one-day bugs near midnight). */
export function toDateIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Parses a strict YYYY-MM-DD string into a local Date at midnight, rejecting invalid/rolled-over dates (e.g. Feb 30). */
function parseDateIso(dateStr: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr.trim());
  if (!match) {
    return undefined;
  }
  const [, yearStr, monthStr, dayStr] = match;
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    return undefined;
  }
  return date;
}

export function startOfDay(dateStr: string): Date | undefined {
  const date = parseDateIso(dateStr);
  if (!date) {
    return undefined;
  }
  date.setHours(0, 0, 0, 0);
  return date;
}

export function endOfDay(dateStr: string): Date | undefined {
  const date = parseDateIso(dateStr);
  if (!date) {
    return undefined;
  }
  date.setHours(23, 59, 59, 999);
  return date;
}

function addDays(date: Date, days: number): Date {
  const copy = new Date(date);
  copy.setDate(copy.getDate() + days);
  return copy;
}

export function getTodayRange(): DateRange {
  const today = toDateIso(new Date());
  return { startDate: today, endDate: today };
}

export function getYesterdayRange(): DateRange {
  const yesterday = toDateIso(addDays(new Date(), -1));
  return { startDate: yesterday, endDate: yesterday };
}

/** Rolling 7-day window ending today (not the calendar week), so it's always fully populated regardless of weekday. */
export function getWeeklyRange(): DateRange {
  const end = new Date();
  return { startDate: toDateIso(addDays(end, -6)), endDate: toDateIso(end) };
}

/** Rolling 30-day window ending today (not the calendar month), for the same reason as the weekly range. */
export function getMonthlyRange(): DateRange {
  const end = new Date();
  return { startDate: toDateIso(addDays(end, -29)), endDate: toDateIso(end) };
}

export function getRangeForPeriod(period: 'today' | 'yesterday' | 'weekly' | 'monthly'): DateRange {
  switch (period) {
    case 'today':
      return getTodayRange();
    case 'yesterday':
      return getYesterdayRange();
    case 'weekly':
      return getWeeklyRange();
    case 'monthly':
      return getMonthlyRange();
  }
}

export interface DateRangeValidation {
  valid: boolean;
  error?: string;
  range?: DateRange;
}

/** Validates a user-supplied custom range: parseable dates, start <= end, end not in the future, span within the cap. */
export function validateCustomRange(startDateStr: string, endDateStr: string): DateRangeValidation {
  const start = startOfDay(startDateStr);
  const end = startOfDay(endDateStr);
  if (!start || !end) {
    return { valid: false, error: 'Please enter valid dates in YYYY-MM-DD format.' };
  }
  if (start.getTime() > end.getTime()) {
    return { valid: false, error: 'Start date must be on or before the end date.' };
  }
  const todayStart = startOfDay(toDateIso(new Date())) as Date;
  if (end.getTime() > todayStart.getTime()) {
    return { valid: false, error: 'End date cannot be in the future.' };
  }
  const spanDays = Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
  if (spanDays > MAX_CUSTOM_RANGE_DAYS) {
    return {
      valid: false,
      error: `That range is ${spanDays} days — the maximum is ${MAX_CUSTOM_RANGE_DAYS} days.`
    };
  }
  return { valid: true, range: { startDate: startDateStr, endDate: endDateStr } };
}

/**
 * Resolves a DateRange into concrete instants for `git --since/--until` and
 * file-mtime comparisons. The end instant is clamped to "now" so a range
 * ending today means "up to this moment", not a future timestamp later today.
 */
export function resolveDateRangeInstants(range: DateRange): { since: Date; until: Date } {
  const since = startOfDay(range.startDate) ?? new Date(0);
  const rawUntil = endOfDay(range.endDate) ?? new Date();
  const now = new Date();
  const until = rawUntil.getTime() > now.getTime() ? now : rawUntil;
  return { since, until };
}

/** True if this range extends through today, meaning current staged/unstaged/untracked state is relevant to it. */
export function rangeIncludesToday(range: DateRange): boolean {
  return range.endDate >= toDateIso(new Date());
}

/** "Today's Work", "Yesterday's Work", "This Week's Work", etc. - a category label, not a date claim. */
export function getPeriodWorkLabel(period: SummaryPeriod): string {
  switch (period) {
    case 'today':
      return "Today's Work";
    case 'yesterday':
      return "Yesterday's Work";
    case 'weekly':
      return "This Week's Work";
    case 'monthly':
      return "This Month's Work";
    case 'custom':
      return 'Custom Range Summary';
  }
}

/**
 * Absolute date/range label for display, e.g. "Wednesday, July 1, 2026" or
 * "Jun 25 – Jul 1". Deliberately never uses relative words like "Today" or
 * "Yesterday", so a summary exported today and read next week still makes
 * sense.
 */
export function formatDateRangeLabel(range: DateRange): string {
  if (range.startDate === range.endDate) {
    return formatLong(range.startDate);
  }
  return `${formatShort(range.startDate)} – ${formatShort(range.endDate)}`;
}

function formatLong(dateStr: string): string {
  const date = startOfDay(dateStr);
  if (!date) {
    return dateStr;
  }
  return date.toLocaleDateString(undefined, { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

function formatShort(dateStr: string): string {
  const date = startOfDay(dateStr);
  if (!date) {
    return dateStr;
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}
