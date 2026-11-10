import { test } from "node:test";
import assert from "node:assert/strict";
import {
  weekKeyOf,
  parseWeekKey,
  weekRange,
  shiftWeek,
  isoWeekYear,
  isoWeekNumber,
  formatWeekLabel,
  mondayOf,
} from "./week.js";

/**
 * 这些期望值**不是我想出来的** —— 是和 MySQL 的
 * `CONCAT(LEFT(YEARWEEK(d,3),4),'-W',LPAD(MOD(YEARWEEK(d,3),100),2,'0'))`
 * 逐日对拍 15000 天（1995-01-01 ~ 2036-01-25）得到的，全部一致。
 *
 * 之所以要这么较真：后端有 `items.week_key` 生成列由 MySQL 算，前端用这个文件算。
 * 两边只要差一天，就会出现「列表页说这周 5 条，点进去只有 4 条」——极难查。
 */

test("基本周键", () => {
  assert.equal(weekKeyOf("2026-10-17"), "2026-W42");
  assert.equal(weekKeyOf("2026-10-12"), "2026-W42"); // 周一
  assert.equal(weekKeyOf("2026-10-18"), "2026-W42"); // 周日，同一周
  assert.equal(weekKeyOf("2026-10-19"), "2026-W43"); // 下周一
});

test("⚠️ ISO 周的年 ≠ 日历年（跨年边界）", () => {
  // 2027-01-01 是周五，按 ISO 属于 2026 年的第 53 周
  assert.equal(isoWeekYear("2027-01-01"), 2026);
  assert.equal(weekKeyOf("2027-01-01"), "2026-W53");
  // 而日历年会说 2027 —— 用它会拼出 2027-W53 这个不存在的周
  assert.equal(new Date("2027-01-01T00:00:00Z").getUTCFullYear(), 2027);

  assert.equal(weekKeyOf("2026-12-31"), "2026-W53");
  assert.equal(weekKeyOf("2021-01-01"), "2020-W53");
  assert.equal(weekKeyOf("2020-12-31"), "2020-W53");
  // 2026-01-01 是周四，属于 2026-W01
  assert.equal(weekKeyOf("2026-01-01"), "2026-W01");
});

test("一周之始是周一", () => {
  // 2026-10-12 是周一，2026-10-11 是周日（属于上一周）
  assert.equal(weekKeyOf("2026-10-11"), "2026-W41");
  assert.equal(mondayOf("2026-10-17"), "2026-10-12");
  assert.equal(mondayOf("2026-10-12"), "2026-10-12");
  assert.equal(mondayOf("2026-10-18"), "2026-10-12");
});

test("周序号在 1..53", () => {
  const d = new Date(Date.UTC(2020, 0, 1));
  for (let i = 0; i < 4000; i++) {
    const s = d.toISOString().slice(0, 10);
    const w = isoWeekNumber(s);
    assert.ok(w >= 1 && w <= 53, `${s} 的周序号是 ${w}`);
    d.setUTCDate(d.getUTCDate() + 1);
  }
});

test("parseWeekKey 对坏输入返回 null，不抛", () => {
  assert.deepEqual(parseWeekKey("2026-W42"), { year: 2026, week: 42 });
  assert.deepEqual(parseWeekKey(" 2026-W01 "), { year: 2026, week: 1 });
  assert.equal(parseWeekKey("2026-42"), null);
  assert.equal(parseWeekKey("2026-W54"), null);
  assert.equal(parseWeekKey("2026-W00"), null);
  assert.equal(parseWeekKey(""), null);
});

test("weekRange 给周一和周日", () => {
  assert.deepEqual(weekRange("2026-W42"), { from: "2026-10-12", to: "2026-10-18" });
  assert.deepEqual(weekRange("2026-W01"), { from: "2025-12-29", to: "2026-01-04" });
  // 跨年那一周：2026-W53 落在 2026-12-28 ~ 2027-01-03
  assert.deepEqual(weekRange("2026-W53"), { from: "2026-12-28", to: "2027-01-03" });
});

test("weekRange 与 weekKeyOf 互为逆运算", () => {
  for (let i = 0; i < 500; i++) {
    const d = new Date(Date.UTC(2024, 0, 1 + i * 3));
    const s = d.toISOString().slice(0, 10);
    const key = weekKeyOf(s);
    const { from, to } = weekRange(key);
    assert.equal(weekKeyOf(from), key, `${key} 的 from 不在这一周`);
    assert.equal(weekKeyOf(to), key, `${key} 的 to 不在这一周`);
    assert.ok(from <= s && s <= to, `${s} 不在 ${key} 的区间内`);
  }
});

test("shiftWeek 前后偏移", () => {
  assert.equal(shiftWeek("2026-W42", 1), "2026-W43");
  assert.equal(shiftWeek("2026-W42", -1), "2026-W41");
  assert.equal(shiftWeek("2026-W42", 0), "2026-W42");
  // 跨年：2026-W53 的下一周是 2027-W01
  assert.equal(shiftWeek("2026-W53", 1), "2027-W01");
  assert.equal(shiftWeek("2027-W01", -1), "2026-W53");
  // 跨年：2026-W01 的上一周是 2025-W52
  assert.equal(shiftWeek("2026-W01", -1), "2025-W52");
});

test("formatWeekLabel 可读", () => {
  assert.equal(formatWeekLabel("2026-W42"), "2026 年第 42 周（10/12 ~ 10/18）");
  assert.equal(formatWeekLabel("坏输入"), "坏输入");
});
