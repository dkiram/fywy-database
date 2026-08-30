import assert from "node:assert/strict";
import test from "node:test";
import {
  disconnectionDayBlock,
  jamaicaPublicHolidays,
} from "../src/huawei/jamaicaDisconnectionCalendar.js";

test("blocks Saturday night into Sunday but allows Friday night into Saturday", () => {
  assert.equal(disconnectionDayBlock("2026-08-29", "").blocked, false);
  assert.deepEqual(disconnectionDayBlock("2026-08-30", ""), {
    blocked: true,
    reason: "Saturday-night-into-Sunday disconnections are disabled.",
  });
});

test("blocks Jamaica's recurring and observed 2026 public holidays", () => {
  const expected = [
    "2026-01-01",
    "2026-02-18",
    "2026-04-03",
    "2026-04-06",
    "2026-05-25",
    "2026-08-01",
    "2026-08-06",
    "2026-10-19",
    "2026-12-25",
    "2026-12-26",
  ];
  assert.deepEqual([...jamaicaPublicHolidays(2026).keys()].sort(), expected.sort());
  for (const date of expected) assert.equal(disconnectionDayBlock(date, "").blocked, true);
});

test("applies Sunday substitute rules and Christmas/Boxing Day observance", () => {
  const holidays2022 = jamaicaPublicHolidays(2022);
  assert.equal(holidays2022.get("2022-12-26"), "Christmas Day (observed)");
  assert.equal(holidays2022.get("2022-12-27"), "Boxing Day (observed)");

  const holidays2023 = jamaicaPublicHolidays(2023);
  assert.equal(holidays2023.get("2023-01-02"), "New Year's Day");
  assert.equal(holidays2023.get("2023-08-07"), "Independence Day");
});

test("blocks configured one-off gazetted dates and fails closed on invalid configuration", () => {
  assert.equal(disconnectionDayBlock("2026-09-03", "2026-09-03").blocked, true);
  assert.match(
    disconnectionDayBlock("2026-09-04", "2026-02-30").reason ?? "",
    /Invalid additional Jamaican holiday date/
  );
});
