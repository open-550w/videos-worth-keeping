import type { DateRange } from "@likes/shared";

// ISO 周逻辑统一从 @likes/shared 来 —— 那份实现和 MySQL 的 YEARWEEK(x,3)
// 逐日对拍过 15000 天。前端不自己再写一遍。
//
// 后端**故意不返回** weekKey（见 packages/backend/src/services/items.service.ts）：
// 真源是 watchedRanges（观看区间），周由它派生。「周只是展示概念」这句话要成立，
// 就不能让服务端变成周的权威。
//
// 观看区间那几个函数（裁剪 / 展开成周）也在这里转发一次：
// 页面从 `../lib/format` 一处拿齐，不用记「哪个函数在 shared、哪个在本地」。
import {
  clipRanges,
  formatWeekLabel,
  isCurrentWeek,
  mondayOf,
  normalizeRanges,
  overlaps,
  parseWeekKey,
  shiftWeek,
  today,
  weekKeyOf,
  weekKeysCoveredBy,
  weekRange,
} from "@likes/shared";

export {
  weekKeyOf,
  weekRange,
  parseWeekKey,
  shiftWeek,
  formatWeekLabel,
  isCurrentWeek,
  today,
  mondayOf,
  normalizeRanges,
  clipRanges,
  overlaps,
  weekKeysCoveredBy,
};
export type { DateRange };

/** 秒 → `12:34` / `1:02:03` */
export function formatDuration(sec: number | null): string | null {
  if (sec === null || sec < 0) return null;
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n: number) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${p(m)}:${p(s)}` : `${m}:${p(s)}`;
}

/** 字节 → 人类可读 */
export function formatBytes(n: number | null): string {
  if (n === null || n <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(n) / Math.log(1024)), units.length - 1);
  const v = n / 1024 ** i;
  return `${v >= 100 || i === 0 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
}

/**
 * MySQL DATETIME 字符串（`2026-10-17 21:30:00`）→ 显示用。
 * **不要 new Date() 它** —— 那个字符串没有时区标记，会被当本地时间解析，
 * 而它本来就是本地时间。原样切字符串最安全。
 */
export function formatDateTime(s: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(s);
  if (!m) return s;
  return `${Number(m[2])}/${Number(m[3])} ${m[4]}:${m[5]}`;
}

/** `2026-10-17` → `10/17` */
export function formatDateShort(s: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(s);
  return m ? `${Number(m[1])}/${Number(m[2])}` : s;
}

/**
 * 观看区间 → `10/17~10/19、10/21~10/24`。
 *
 * 单日区间只显示一天（`10/17` 而不是 `10/17~10/17`）——
 * 「就看了这一天」和「看了两天」在用户眼里是不同的事，别用同一个形状糊过去。
 *
 * `max` 之后折叠成「等 N 段」：卡片上塞不下 12 段，但也不能假装只有 3 段。
 */
export function formatRanges(ranges: readonly DateRange[], max = 3): string {
  if (!ranges.length) return "（没记日期）";
  const shown = ranges.slice(0, max).map((r) => formatRange(r));
  const rest = ranges.length - shown.length;
  return shown.join("、") + (rest > 0 ? ` 等 ${ranges.length} 段` : "");
}

/** 单段区间 → `10/17~10/19`（单日 → `10/17`）。 */
export function formatRange(r: DateRange): string {
  const from = formatDateShort(r.from);
  return r.from === r.to ? from : `${from}~${formatDateShort(r.to)}`;
}
