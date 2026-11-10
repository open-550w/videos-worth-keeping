#!/usr/bin/env node
/**
 * 抓 B 站观看历史 → 写进候选区。
 *
 *   pnpm --filter @likes/backend fetch:bili --since "2026-10-18 00:00:00" --until "2026-10-21 23:59:59"
 *   pnpm --filter @likes/backend fetch:bili --since 7d
 *   pnpm --filter @likes/backend fetch:bili --since 30d --no-save      # 只看不落库
 *
 * 参数和 `03_even_bili_watch_history_fetch/fetch.sh` 基本一一对应（见 --help）。
 *
 * ⚠️ **默认写库。** `--no-save` 是那个「可选」：抓完只打印摘要 / 写 --json，不碰数据库。
 *
 * 为什么是 CLI 而不是一个 HTTP 接口：抓一次要几十秒到几分钟、要打外部接口、
 * 限流时还要退避重试 —— 塞进 HTTP 请求里就是一个必然超时的接口。
 * 抓和挑是两件事：**抓**在这儿，**挑**在 /history 页面上。
 */
import { closePool } from "../../db/db.js";
import { knownPlatformIds, purgeAll, upsertEntries } from "../../dao/watchHistory.dao.js";
import { BiliClient } from "./client.js";
import {
  cookieHeaderOf,
  defaultCookiePath,
  loadCachedCookies,
  refreshCookiesFromChrome,
} from "./cookies.js";
import { fetchWatchHistory, formatTs, parseTimeArg } from "./history.js";

const USAGE = `
抓 B 站观看历史到候选区（然后去 /history 页面上挑）

用法：
  fetch:bili [--since <时间>] [--until <时间>] [选项]

时间（--since 默认「有史以来」，--until 默认现在）：
  2026-10-18                 某天 00:00 起
  "2026-10-18 09:30:00"      精确到秒（要引号）
  7d / 12h / 30m             相对现在
  1792588812                 epoch 秒

选项：
  --type <all|archive|live|article|pgc>   只看某类（默认 all）
  --no-save                  **不写数据库**，只抓（配合 --json 看结果）
  --refresh                  **重抓已有的**（默认只拿新的：候选区里已有的视频
                             连详情都不再拉，写库也不覆盖已有行）
  --json <路径>              额外把原始记录写成 JSON（排查 / 备份用）
  --purge                    先把候选区清空再写（想从干净状态重来）
  --refresh-cookies          重新从 Chrome 取 cookie（换账号 / 登录态过期时）
  --cookies <路径>           cookie 缓存位置（默认 .cache/bili-cookies.json）
  --no-detail                跳过逐视频元数据，快很多（1300 条约 30 秒）
  --no-cache                 忽略详情缓存
  --workers <n>              富化并发数（默认 4）
  --delay <秒>               全局最小请求间隔（默认 0.35；被限流就调大）
  --max-pages <n>            翻页安全上限（默认 2000）
  --page-size <n>            每页条数（默认 30，接口上限）
  --quiet                    安静模式
  --help
`;

function parseArgs(argv: string[]) {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const takesValue = [
      "since", "until", "type", "json", "cookies", "workers", "delay",
      "max-pages", "page-size",
    ].includes(key);
    if (takesValue) {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith("--")) throw new Error(`--${key} 需要一个值`);
      out[key] = v;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(USAGE);
    return;
  }

  const quiet = Boolean(args.quiet);
  const say = (line: string) => {
    if (!quiet) console.error(line);
  };

  const cookiePath = String(args.cookies ?? defaultCookiePath());
  let cookies = await loadCachedCookies(cookiePath);
  if (args["refresh-cookies"] || !cookies) {
    say("[*] 从 Chrome 取 cookie（CDP）…");
    cookies = await refreshCookiesFromChrome(cookiePath);
    say(`[+] ${cookies.length} 个 bilibili cookie → ${cookiePath}`);
  }

  const client = new BiliClient({
    cookieHeader: cookieHeaderOf(cookies),
    delaySec: args.delay ? Number(args.delay) : undefined,
    verbose: !quiet,
    log: say,
  });

  const since = parseTimeArg(args.since as string | undefined);
  const until = parseTimeArg(args.until as string | undefined) ?? Date.now() / 1000;
  if (since !== undefined && since > until) throw new Error("--since 比 --until 还晚");

  say(`[*] 时间窗：${since ? formatTs(since) : "(全部)"} .. ${formatTs(until)}`);

  // 默认「只拿新的」：候选区里已经有的视频不再富化、写库也不覆盖已有行。
  // `--refresh` 是显式地反过来说「我知道，重抓一遍」。
  const refresh = Boolean(args.refresh);
  const known = refresh ? undefined : await knownPlatformIds("bilibili");
  if (known?.size) say(`[*] 候选区里已有 ${known.size} 个视频，本次不重复抓详情`);

  const { records, apiCalls, account } = await fetchWatchHistory(client, {
    since,
    until,
    business: String(args.type ?? "all"),
    noDetail: Boolean(args["no-detail"]),
    noCache: Boolean(args["no-cache"]),
    workers: args.workers ? Number(args.workers) : undefined,
    delaySec: args.delay ? Number(args.delay) : undefined,
    maxPages: args["max-pages"] ? Number(args["max-pages"]) : undefined,
    pageSize: args["page-size"] ? Number(args["page-size"]) : undefined,
    skipDetailFor: known,
    onLog: say,
  });

  if (args.json) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      String(args.json),
      JSON.stringify({ account, since, until, apiCalls, records }, null, 2),
      "utf8",
    );
    say(`[+] 原始记录 → ${args.json}`);
  }

  console.log(`\n[+] ${records.length} 条观看记录，${apiCalls} 次接口调用`);

  if (args["no-save"]) {
    console.log("[*] --no-save：没有写数据库");
    return;
  }

  if (args.purge) {
    const n = await purgeAll();
    say(`[*] --purge：清掉了候选区里原有的 ${n} 行`);
  }

  const r = await upsertEntries(records, { updateExisting: refresh });
  console.log(
    `[+] 候选区：新增 ${r.inserted} 条，已存在 ${r.updated} 条（本次抓回 ${r.received} 条）`,
  );
  if (r.updated) {
    console.log(
      refresh
        ? "    （--refresh：已存在的行也重新写了一遍）"
        : "    （默认只拿新的 —— 已有的行**一个字都没动**；要重抓用 --refresh）",
    );
  }
  console.log("\n→ 去 http://localhost:5190/history 上挑要收藏的");
}

try {
  await main();
} catch (err) {
  console.error(`\n[!] ${err instanceof Error ? err.message : String(err)}`);
  process.exitCode = 1;
} finally {
  await closePool().catch(() => {});
}
