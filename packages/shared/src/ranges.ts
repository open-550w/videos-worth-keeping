/**
 * 「观看的日期区间」—— **一条记录可以在不相连的几段时间里被看 / 读**。
 *
 * 为什么要有这个：以周为单位记录时，「什么时候看的」往往不是一天。
 * 一部剧可能 10/17–10/19 看了第一季、10/21–10/24 接着看第二季（中间那天只是忙）；
 * 一本书可能断断续续读了两个月。只记一个 `collected_on` 的话，
 * 这些都只能压成一天 —— 信息是在**录入那一刻**丢的，事后补不回来。
 *
 * ⚠️ 真源是**这组区间**，「周」是从它派生的展示概念：
 *    某段区间和某一周有交集 → 这条记录出现在那一周（跨几周就出现几次）。
 *    派生用的还是 week.ts 那套 ISO 周实现 —— 前后端共用同一份，
 *    所以「后端说这周 5 条、前端点进去只有 4 条」这类不一致从源头上不成立。
 *
 * 本文件里的函数全是**纯函数**：没有 I/O、不依赖时区、不抛异常。
 * 解析器降级、用户手填、导入历史数据都会喂进来脏数据，
 * 所以这里的约定是「**能修的就修，修不了的丢掉**」，而不是抛错挡住整次请求。
 */

import { shiftWeek, weekKeyOf } from "./week.js";

/** 闭区间 `[from, to]`，两端都算在内。单日区间 = `from === to`。 */
export interface DateRange {
  /** `YYYY-MM-DD` */
  from: string;
  /** `YYYY-MM-DD`，且 `>= from` */
  to: string;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 是不是一个**真实存在**的日期（挡掉 `2026-02-30` 这种 —— `new Date` 会把它滚成 3 月 2 日）。 */
export function isDateString(s: unknown): s is string {
  if (typeof s !== "string") return false;
  const m = DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** 形状与大小都对：`YYYY-MM-DD` 且 `from <= to`。 */
export function isValidRange(r: unknown): r is DateRange {
  if (typeof r !== "object" || r === null) return false;
  const { from, to } = r as Partial<DateRange>;
  return isDateString(from) && isDateString(to) && from <= to;
}

/**
 * 排序 + 合并**重叠**的区间 + 丢掉坏的。写入前一律走一遍。
 *
 * ⚠️ **只合并重叠的，不合并相邻的**（`10-19` 与 `10-20` 是两段，不是一段）。
 * 理由是需求里明说的那句「有的可能是第一季、第二季」——
 * 背靠背看完两季在用户眼里是两件事，合并掉就把这个信息抹了。
 * 重叠才是真的重复（同一段时间被记了两遍），那才该并。
 *
 * 为什么要归一化：区间集合直接决定「这条记录出现在哪几周」。
 * 不归一化的话，`[10-17~10-19, 10-18~10-24]` 和 `[10-17~10-24]` 会算出同样的周，
 * 但存进去是两个样子 —— 显示、去重、对拍全都要处理两种等价写法。
 *
 * 注意 `from <= last.to`（而不是 `<`）：闭区间，**端点重合就是重叠**。
 */
export function normalizeRanges(input: readonly unknown[]): DateRange[] {
  const valid = input
    .filter(isValidRange)
    .map((r) => ({ from: r.from, to: r.to }))
    .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));

  const out: DateRange[] = [];
  for (const r of valid) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push(r);
    }
  }
  return out;
}

/**
 * 取与 `[from, to]` 的交集，逐段裁剪。
 *
 * 周视图用它回答「这条记录在这一周里被看到的是哪几天」——
 * 一段 10-17~11-30 的区间，在 W42 那周里只该显示 10-17~10-18。
 * 日期是定长的 `YYYY-MM-DD`，字典序就是时间序，所以直接比字符串。
 */
export function clipRanges(
  ranges: readonly DateRange[],
  from: string,
  to: string,
): DateRange[] {
  const out: DateRange[] = [];
  for (const r of ranges) {
    const lo = r.from > from ? r.from : from;
    const hi = r.to < to ? r.to : to;
    if (lo <= hi) out.push({ from: lo, to: hi });
  }
  return out;
}

/** 这些区间和 `[from, to]` 有没有交集。 */
export function overlaps(ranges: readonly DateRange[], from: string, to: string): boolean {
  return ranges.some((r) => r.from <= to && r.to >= from);
}

/**
 * 单段区间的上限：约 50 年。纯粹是防呆 ——
 * 一个手滑写成 `9999-12-31` 的区间会把下面那个循环变成 40 万次迭代。
 */
const MAX_WEEKS_PER_RANGE = 2600;

/**
 * 这些区间覆盖到的所有周键，升序去重。
 *
 * 后端「按周聚合」靠它：SQL 里造不出周序列（MySQL 5.7 没有 CTE / 递归 /
 * 窗口函数），所以一次把区间取回来，在这里展开。
 *
 * ⚠️ 周键是定长的 `YYYY-Www`（周号补零到两位），所以**字典序就是时间序** ——
 * 跨年也对（`2026-W53` < `2027-W01`）。下面用 `<=` 比较是刻意的。
 */
export function weekKeysCoveredBy(ranges: readonly DateRange[]): string[] {
  const out = new Set<string>();
  for (const r of normalizeRanges(ranges)) {
    const last = weekKeyOf(r.to);
    let k = weekKeyOf(r.from);
    for (let i = 0; k <= last && i < MAX_WEEKS_PER_RANGE; i++) {
      out.add(k);
      k = shiftWeek(k, 1);
    }
  }
  return [...out].sort();
}
