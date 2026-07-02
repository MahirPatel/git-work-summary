import * as assert from 'assert';
import {
  MAX_CUSTOM_RANGE_DAYS,
  endOfDay,
  formatDateRangeLabel,
  getMonthlyRange,
  getPeriodWorkLabel,
  getTodayRange,
  getWeeklyRange,
  getYesterdayRange,
  rangeIncludesToday,
  resolveDateRangeInstants,
  startOfDay,
  toDateIso,
  validateCustomRange
} from '../../utils/dateRangeUtils';

function daysBetweenInclusive(startDate: string, endDate: string): number {
  const start = startOfDay(startDate) as Date;
  const end = startOfDay(endDate) as Date;
  return Math.round((end.getTime() - start.getTime()) / 86400000) + 1;
}

describe('dateRangeUtils.startOfDay / endOfDay', () => {
  it('parses a valid YYYY-MM-DD date', () => {
    const date = startOfDay('2026-07-02');
    assert.ok(date);
    assert.strictEqual(date?.getFullYear(), 2026);
    assert.strictEqual(date?.getMonth(), 6); // 0-indexed
    assert.strictEqual(date?.getDate(), 2);
    assert.strictEqual(date?.getHours(), 0);
  });

  it('endOfDay sets the time to 23:59:59.999', () => {
    const date = endOfDay('2026-07-02');
    assert.strictEqual(date?.getHours(), 23);
    assert.strictEqual(date?.getMinutes(), 59);
    assert.strictEqual(date?.getMilliseconds(), 999);
  });

  it('rejects malformed strings', () => {
    assert.strictEqual(startOfDay('not-a-date'), undefined);
    assert.strictEqual(startOfDay('2026-13-01'), undefined);
  });

  it('rejects dates that roll over (e.g. Feb 30)', () => {
    assert.strictEqual(startOfDay('2026-02-30'), undefined);
  });
});

describe('dateRangeUtils period ranges', () => {
  it('getTodayRange returns a single-day range equal to today', () => {
    const range = getTodayRange();
    assert.strictEqual(range.startDate, range.endDate);
    assert.strictEqual(range.startDate, toDateIso(new Date()));
  });

  it('getYesterdayRange returns a single day, one day before today', () => {
    const range = getYesterdayRange();
    assert.strictEqual(range.startDate, range.endDate);
    assert.strictEqual(daysBetweenInclusive(range.startDate, toDateIso(new Date())), 2);
  });

  it('getWeeklyRange spans exactly 7 days and ends today', () => {
    const range = getWeeklyRange();
    assert.strictEqual(range.endDate, toDateIso(new Date()));
    assert.strictEqual(daysBetweenInclusive(range.startDate, range.endDate), 7);
  });

  it('getMonthlyRange spans exactly 30 days and ends today', () => {
    const range = getMonthlyRange();
    assert.strictEqual(range.endDate, toDateIso(new Date()));
    assert.strictEqual(daysBetweenInclusive(range.startDate, range.endDate), 30);
  });
});

describe('dateRangeUtils.validateCustomRange', () => {
  it('accepts a simple valid past range', () => {
    const result = validateCustomRange('2026-06-01', '2026-06-10');
    assert.strictEqual(result.valid, true);
    assert.deepStrictEqual(result.range, { startDate: '2026-06-01', endDate: '2026-06-10' });
  });

  it('rejects start date after end date', () => {
    const result = validateCustomRange('2026-06-10', '2026-06-01');
    assert.strictEqual(result.valid, false);
    assert.match(result.error ?? '', /before/i);
  });

  it('rejects malformed dates', () => {
    const result = validateCustomRange('not-a-date', '2026-06-10');
    assert.strictEqual(result.valid, false);
  });

  it('rejects an end date in the future', () => {
    const tomorrow = toDateIso(new Date(Date.now() + 2 * 86400000));
    const result = validateCustomRange('2026-01-01', tomorrow);
    assert.strictEqual(result.valid, false);
    assert.match(result.error ?? '', /future/i);
  });

  it(`accepts a range of exactly ${MAX_CUSTOM_RANGE_DAYS} days`, () => {
    const result = validateCustomRange('2026-06-01', '2026-07-01');
    assert.strictEqual(daysBetweenInclusive('2026-06-01', '2026-07-01'), MAX_CUSTOM_RANGE_DAYS);
    assert.strictEqual(result.valid, true);
  });

  it(`rejects a range of ${MAX_CUSTOM_RANGE_DAYS + 1} days`, () => {
    const result = validateCustomRange('2026-05-31', '2026-07-01');
    assert.strictEqual(daysBetweenInclusive('2026-05-31', '2026-07-01'), MAX_CUSTOM_RANGE_DAYS + 1);
    assert.strictEqual(result.valid, false);
    assert.match(result.error ?? '', /maximum/i);
  });

  it('accepts a single-day range (start === end)', () => {
    const result = validateCustomRange('2026-06-15', '2026-06-15');
    assert.strictEqual(result.valid, true);
  });
});

describe('dateRangeUtils.resolveDateRangeInstants', () => {
  it('resolves since/until to start/end of the given days for a past range', () => {
    const { since, until } = resolveDateRangeInstants({ startDate: '2026-06-01', endDate: '2026-06-05' });
    assert.strictEqual(since.getDate(), 1);
    assert.strictEqual(since.getHours(), 0);
    assert.strictEqual(until.getDate(), 5);
    assert.strictEqual(until.getHours(), 23);
  });

  it('clamps "until" to now when the range ends today', () => {
    const { until } = resolveDateRangeInstants(getTodayRange());
    assert.ok(until.getTime() <= Date.now());
    assert.ok(until.getTime() > Date.now() - 5000);
  });
});

describe('dateRangeUtils.rangeIncludesToday', () => {
  it('is true for a range ending today', () => {
    assert.strictEqual(rangeIncludesToday(getTodayRange()), true);
  });

  it('is true for a range ending in the future (defensive - not normally constructed)', () => {
    const future = toDateIso(new Date(Date.now() + 5 * 86400000));
    assert.strictEqual(rangeIncludesToday({ startDate: future, endDate: future }), true);
  });

  it('is false for a purely historical range', () => {
    assert.strictEqual(rangeIncludesToday({ startDate: '2020-01-01', endDate: '2020-01-07' }), false);
  });
});

describe('dateRangeUtils.getPeriodWorkLabel', () => {
  it('maps every period to a distinct, human-readable label', () => {
    assert.strictEqual(getPeriodWorkLabel('today'), "Today's Work");
    assert.strictEqual(getPeriodWorkLabel('yesterday'), "Yesterday's Work");
    assert.strictEqual(getPeriodWorkLabel('weekly'), "This Week's Work");
    assert.strictEqual(getPeriodWorkLabel('monthly'), "This Month's Work");
    assert.strictEqual(getPeriodWorkLabel('custom'), 'Custom Range Summary');
  });
});

describe('dateRangeUtils.formatDateRangeLabel', () => {
  it('formats a single-day range as one long date, not a range', () => {
    const label = formatDateRangeLabel({ startDate: '2026-07-02', endDate: '2026-07-02' });
    assert.match(label, /2026/);
    assert.ok(!label.includes('–'), 'single-day label should not contain a range dash');
  });

  it('never uses relative words like "Today" or "Yesterday" (must stay correct if read later)', () => {
    const label = formatDateRangeLabel(getYesterdayRange());
    assert.ok(!/today|yesterday/i.test(label));
  });

  it('formats a multi-day range as start – end', () => {
    const label = formatDateRangeLabel({ startDate: '2026-06-25', endDate: '2026-07-01' });
    assert.ok(label.includes('–'));
  });
});
