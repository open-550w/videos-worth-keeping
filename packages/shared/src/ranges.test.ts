import { test } from "node:test";
import assert from "node:assert/strict";
import {
  clipRanges,
  isDateString,
  isValidRange,
  normalizeRanges,
  overlaps,
  weekKeysCoveredBy,
} from "./ranges.js";

/**
 * 这份测试盯的是**周视图的边界**，不是函数本身好不好看。
 *
 * 为什么较真到跨年：一条记录出现在哪几周，全靠这里算出来的周键。
 * 算错一天，表现就是「列表页说这周 3 条、点进去只有 2 条」——
 * 和 week.test.ts 里对拍 MySQL 是同一个理由。
 */

test("归一化：排序、合并重叠、丢掉坏的", () => {
  assert.deepEqual(
    normalizeRanges([
      { from: "2026-10-21", to: "2026-10-24" },
      { from: "2026-10-17", to: "2026-10-19" },
    ]),
    [
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-21", to: "2026-10-24" },
    ],
    "按开始日排序 —— 用户填的顺序不该影响存进去的样子",
  );

  assert.deepEqual(
    normalizeRanges([
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-18", to: "2026-10-24" },
    ]),
    [{ from: "2026-10-17", to: "2026-10-24" }],
    "重叠就并成一段",
  );

  assert.deepEqual(
    normalizeRanges([
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-19", to: "2026-10-20" },
    ]),
    [{ from: "2026-10-17", to: "2026-10-20" }],
    "闭区间：端点重合算重叠（10-19 被算了两遍）",
  );

  // ⚠️ 这条是刻意的：需求原话「有的可能是第一季、第二季」
  assert.deepEqual(
    normalizeRanges([
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-20", to: "2026-10-24" },
    ]),
    [
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-20", to: "2026-10-24" },
    ],
    "**相邻不合并** —— 背靠背看完两季是两件事，并掉就把这个信息抹了",
  );

  assert.deepEqual(normalizeRanges([{ from: "2026-10-19", to: "2026-10-17" }]), [], "倒着的区间丢掉");
  assert.deepEqual(normalizeRanges([{ from: "2026-02-30", to: "2026-03-01" }]), [], "不存在的日期丢掉");
  assert.deepEqual(normalizeRanges([{ from: "2026-10-17" }]), [], "缺 to 丢掉");
  assert.deepEqual(normalizeRanges([null, 1, "x", {}]), [], "垃圾输入不抛异常");
});

test("日期校验：真实存在的日期才算数", () => {
  assert.ok(isDateString("2026-10-17"));
  assert.ok(!isDateString("2026-02-30"), "2 月没有 30 号");
  assert.ok(!isDateString("2026-2-3"), "必须补零");
  assert.ok(!isDateString("2026-10-17T00:00:00Z"), "只要日期，不要时间");
  assert.ok(isValidRange({ from: "2026-10-17", to: "2026-10-17" }), "单日区间合法");
});

test("裁剪：跨周的区间，每周只显示自己那几天", () => {
  const ranges = [{ from: "2026-10-17", to: "2026-11-03" }];
  // 2026-W42 = 10-12 ~ 10-18
  assert.deepEqual(clipRanges(ranges, "2026-10-12", "2026-10-18"), [
    { from: "2026-10-17", to: "2026-10-18" },
  ]);
  // 2026-W43 = 10-19 ~ 10-25 —— 整周都在区间里
  assert.deepEqual(clipRanges(ranges, "2026-10-19", "2026-10-25"), [
    { from: "2026-10-19", to: "2026-10-25" },
  ]);
  // 2026-W44 = 10-26 ~ 11-01
  assert.deepEqual(clipRanges(ranges, "2026-10-26", "2026-11-01"), [
    { from: "2026-10-26", to: "2026-11-01" },
  ]);
  // 2026-W45 = 11-02 ~ 11-08 —— 只剩开头两天
  assert.deepEqual(clipRanges(ranges, "2026-11-02", "2026-11-08"), [
    { from: "2026-11-02", to: "2026-11-03" },
  ]);
  // 2026-W46 完全在区间外
  assert.deepEqual(clipRanges(ranges, "2026-11-09", "2026-11-15"), []);

  assert.ok(overlaps(ranges, "2026-10-17", "2026-10-18"), "区间里的某一天算命中");
  assert.ok(!overlaps(ranges, "2026-10-12", "2026-10-16"), "差一天就不算");
});

test("展开成周：需求里的那个例子", () => {
  // 「1017-1019 看了、后面又在 1021-1024 看了」
  assert.deepEqual(
    weekKeysCoveredBy([
      { from: "2026-10-17", to: "2026-10-19" },
      { from: "2026-10-21", to: "2026-10-24" },
    ]),
    ["2026-W42", "2026-W43"],
    "10-17~10-19 本身就跨了 W42/W43 两周（W42 到 10-18，W43 从 10-19 起）",
  );

  assert.deepEqual(weekKeysCoveredBy([{ from: "2026-10-17", to: "2026-10-17" }]), ["2026-W42"]);
  assert.deepEqual(weekKeysCoveredBy([]), [], "没有区间就不在任何一周");
});

test("展开成周：跨年（ISO 周的年 ≠ 日历年）", () => {
  // 2027-01-01 是周五，属于 2026-W53；2027-01-04 才是 2027-W01
  assert.deepEqual(weekKeysCoveredBy([{ from: "2026-12-28", to: "2027-01-04" }]), [
    "2026-W53",
    "2027-W01",
  ]);

  // 一整年不重不漏：每周恰好出现一次，且顺序是时间序（字典序 == 时间序）
  const keys = weekKeysCoveredBy([{ from: "2026-01-01", to: "2026-12-31" }]);
  assert.equal(keys.length, new Set(keys).size, "不该有重复的周");
  assert.equal(keys[0], "2026-W01");
  assert.equal(keys[keys.length - 1], "2026-W53");
  assert.deepEqual([...keys].sort(), keys, "返回的顺序就是字典序");
  for (let i = 1; i < keys.length; i++) {
    assert.ok(keys[i - 1] < keys[i], `${keys[i - 1]} 应该排在 ${keys[i]} 前面`);
  }
});

test("展开成周：重复周只算一次", () => {
  // 同一周里的两段（不重叠、但落在同一周）—— 聚合时必须算成 1 条，不是 2 条
  assert.deepEqual(
    weekKeysCoveredBy([
      { from: "2026-10-13", to: "2026-10-14" },
      { from: "2026-10-16", to: "2026-10-17" },
    ]),
    ["2026-W42"],
  );
});
