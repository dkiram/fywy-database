/** Jamaica-calendar days on which automatic delinquency disconnections must not run. */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export type DisconnectionDayBlock = {
  blocked: boolean;
  reason?: string;
};

function utcDate(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month - 1, day));
}

function formatDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function easterSunday(year: number) {
  // Anonymous Gregorian computus, valid for the Gregorian calendar years used
  // by this application.
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return utcDate(year, month, day);
}

function followingMonday(date: Date) {
  const daysUntilMonday = (8 - date.getUTCDay()) % 7;
  return addDays(date, daysUntilMonday || 7);
}

function thirdMondayOfOctober(year: number) {
  const first = utcDate(year, 10, 1);
  const firstMondayOffset = (8 - first.getUTCDay()) % 7;
  return addDays(first, firstMondayOffset + 14);
}

function addHoliday(holidays: Map<string, string>, date: Date, name: string) {
  const isoDate = formatDate(date);
  const existing = holidays.get(isoDate);
  holidays.set(isoDate, existing ? `${existing}; ${name}` : name);
}

/**
 * The ten recurring nationwide holidays published by Jamaica's Ministry of
 * Labour/JIS, including the statutory substitute-day rules.
 *
 * One-off holidays appointed by Gazette cannot be predicted. They are added
 * through HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS.
 */
export function jamaicaPublicHolidays(year: number) {
  const holidays = new Map<string, string>();

  const newYearsDay = utcDate(year, 1, 1);
  addHoliday(
    holidays,
    newYearsDay.getUTCDay() === 0 ? addDays(newYearsDay, 1) : newYearsDay,
    "New Year's Day"
  );

  const easter = easterSunday(year);
  addHoliday(holidays, addDays(easter, -46), "Ash Wednesday");
  addHoliday(holidays, addDays(easter, -2), "Good Friday");
  addHoliday(holidays, addDays(easter, 1), "Easter Monday");

  const labourDay = utcDate(year, 5, 23);
  addHoliday(
    holidays,
    labourDay.getUTCDay() === 0 || labourDay.getUTCDay() === 6
      ? followingMonday(labourDay)
      : labourDay,
    "National Labour Day"
  );

  const emancipationDay = utcDate(year, 8, 1);
  addHoliday(
    holidays,
    emancipationDay.getUTCDay() === 0 ? addDays(emancipationDay, 1) : emancipationDay,
    "Emancipation Day"
  );

  const independenceDay = utcDate(year, 8, 6);
  addHoliday(
    holidays,
    independenceDay.getUTCDay() === 0 ? addDays(independenceDay, 1) : independenceDay,
    "Independence Day"
  );

  addHoliday(holidays, thirdMondayOfOctober(year), "National Heroes' Day");

  const christmasDay = utcDate(year, 12, 25);
  if (christmasDay.getUTCDay() === 0) {
    addHoliday(holidays, addDays(christmasDay, 1), "Christmas Day (observed)");
    addHoliday(holidays, addDays(christmasDay, 2), "Boxing Day (observed)");
  } else {
    addHoliday(holidays, christmasDay, "Christmas Day");
    addHoliday(holidays, utcDate(year, 12, 26), "Boxing Day");
  }

  return holidays;
}

function parseAdditionalHolidays(value: string | undefined) {
  const dates = new Set<string>();
  for (const entry of value?.split(",") ?? []) {
    const date = entry.trim();
    if (!date) continue;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!ISO_DATE.test(date) || Number.isNaN(parsed.getTime()) || formatDate(parsed) !== date) {
      return {
        dates,
        error: `Invalid additional Jamaican holiday date "${date}"; expected YYYY-MM-DD.`,
      };
    }
    dates.add(date);
  }
  return { dates };
}

/**
 * Sunday here means the midnight run immediately after Saturday night. A
 * Saturday Jamaica billing date (Friday night into Saturday) remains allowed,
 * unless that date is itself an official holiday.
 */
export function disconnectionDayBlock(
  jamaicaDate: string,
  additionalHolidayDates = process.env.HUAWEI_OLT_AUTOMATION_ADDITIONAL_HOLIDAYS
): DisconnectionDayBlock {
  if (!ISO_DATE.test(jamaicaDate)) {
    return { blocked: true, reason: "The Jamaica calendar date is invalid." };
  }
  const date = new Date(`${jamaicaDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime()) || formatDate(date) !== jamaicaDate) {
    return { blocked: true, reason: "The Jamaica calendar date is invalid." };
  }

  if (date.getUTCDay() === 0) {
    return { blocked: true, reason: "Saturday-night-into-Sunday disconnections are disabled." };
  }

  const holiday = jamaicaPublicHolidays(date.getUTCFullYear()).get(jamaicaDate);
  if (holiday) {
    return { blocked: true, reason: `${holiday} is a Jamaican public holiday.` };
  }

  const additional = parseAdditionalHolidays(additionalHolidayDates);
  if (additional.error) return { blocked: true, reason: additional.error };
  if (additional.dates.has(jamaicaDate)) {
    return {
      blocked: true,
      reason: "The date is configured as an additional gazetted Jamaican public holiday.",
    };
  }

  return { blocked: false };
}
