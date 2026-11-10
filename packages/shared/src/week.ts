/**
 * ISO 8601 周工具 —— **前后端共用同一份实现**。
 *
 * 为什么必须共用：后端有 `items.week_key` 生成列（由 MySQL 的 YEARWEEK 算），
 * 前端要能算出同样的周键、以及某个周键对应的日期区间。两边算法一旦有细微差别，
 * 「点进某一周看到的条目和列表页的数量对不上」——而且极难查。
 *
 * ⚠️ 这个文件里最要命的一条：**ISO 周的「年」不等于日历年**。
 *    2027-01-01 是周五，按 ISO 属于 2026 年的第 53 周（2026-W53），
 *    而 `getFullYear()` 会给出 2027 —— 拼出 `2027-W53` 这个不存在的周，
 *    还会安静地把本该相邻的两条记录分到相隔一年。
 *    所以下面一律用 `isoWeekYear()`，不用 `getFullYear()`。
 *
 * 与 MySQL 的对应关系：`YEARWEEK(date, 3)` 的 mode 3 = 周一为一周之始、
 * 第 1 周是含当年第一个周四的那周 —— 和这里的实现一致。
 * 已用 1995–2035 的日期逐日对拍验证过（见 week.test.ts）。
 */

/** 把 `YYYY-MM-DD` 或 Date 归一成 UTC 零点的 Date，避开本地时区。 */
function toUtcDate(input: string | Date): Date {
  if (input instanceof Date) {
    return new Date(Date.UTC(input.getUTCFullYear(), input.getUTCMonth(), input.getUTCDate()));
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(input.trim());
  if (!m) throw new Error(`无法解析日期: ${input}`);
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

export function toDateString(input: string | Date): string {
  return toUtcDate(input).toISOString().slice(0, 10);
}

/** ISO 周所属的年（可能不等于日历年）。 */
export function isoWeekYear(input: string | Date): number {
  const t = toUtcDate(input);
  const dayNum = t.getUTCDay() || 7; // 周一=1 … 周日=7
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // 移到本周的周四
  return t.getUTCFullYear();
}

/** ISO 周序号 1–53。 */
export function isoWeekNumber(input: string | Date): number {
  const t = toUtcDate(input);
  const dayNum = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - dayNum); // 移到本周的周四
  const yearStart = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return Math.ceil(((t.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
}

/** 周键，如 `2026-W42`。 */
export function weekKeyOf(input: string | Date): string {
  const y = isoWeekYear(input);
  const w = isoWeekNumber(input);
  return `${y}-W${String(w).padStart(2, "0")}`;
}

/** 解析周键。形状不对返回 null（不要抛 —— 它来自 URL，用户可能手改）。 */
export function parseWeekKey(key: string): { year: number; week: number } | null {
  const m = /^(\d{4})-W(\d{2})$/.exec(key.trim());
  if (!m) return null;
  const year = Number(m[1]);
  const week = Number(m[2]);
  if (week < 1 || week > 53) return null;
  return { year, week };
}

/** ISO 周 1 的周一（含当年第一个周四的那周的周一）。 */
function isoWeek1Monday(year: number): Date {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const dayNum = jan4.getUTCDay() || 7;
  const monday = new Date(jan4);
  monday.setUTCDate(jan4.getUTCDate() - (dayNum - 1));
  return monday;
}

/** 周键 → 该周的周一与周日（都是 `YYYY-MM-DD`）。 */
export function weekRange(key: string): { from: string; to: string } {
  const parsed = parseWeekKey(key);
  if (!parsed) throw new Error(`周键形状不对: ${key}`);
  const monday = isoWeek1Monday(parsed.year);
  monday.setUTCDate(monday.getUTCDate() + (parsed.week - 1) * 7);
  const sunday = new Date(monday);
  sunday.setUTCDate(monday.getUTCDate() + 6);
  return { from: monday.toISOString().slice(0, 10), to: sunday.toISOString().slice(0, 10) };
}

/** 日期 → 它所属那周的周一。 */
export function mondayOf(input: string | Date): string {
  return weekRange(weekKeyOf(input)).from;
}

/** 周键前后偏移 n 周。用于「上一周 / 下一周」。 */
export function shiftWeek(key: string, n: number): string {
  const { from } = weekRange(key);
  const d = toUtcDate(from);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return weekKeyOf(d);
}

/** `2026-W42` → `2026 年第 42 周（10-12 ~ 10-18）` */
export function formatWeekLabel(key: string): string {
  const parsed = parseWeekKey(key);
  if (!parsed) return key;
  const { from, to } = weekRange(key);
  const md = (s: string) => s.slice(5).replace("-", "/");
  return `${parsed.year} 年第 ${parsed.week} 周（${md(from)} ~ ${md(to)}）`;
}

/** 这一周是否就是当前所在周。 */
export function isCurrentWeek(key: string): boolean {
  return weekKeyOf(new Date()) === key;
}

/** 今天的 `YYYY-MM-DD`（本地时区 —— 用户眼里的「今天」）。 */
export function today(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
