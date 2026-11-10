import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

/**
 * 逐视频详情的磁盘缓存。
 *
 * 为什么要缓存：富化是**每个视频两个请求**，一个窗口几百条视频就是上千次请求 ——
 * 而视频的标题/封面/标签/简介基本不变。缓存把第二次抓取从几分钟压到十几秒
 * （实测：1300 条全量，冷启动 ~4 分钟，热缓存 13 秒）。
 *
 * ⚠️ **格式刻意和 Python 那份工具兼容**（同一个 `_v` 版本号、同一套字段名），
 * 这样它已经攒下的 1000+ 条缓存可以直接拿来用（`BILI_CACHE_DIR` 指过去即可）。
 * 两边的 `_v` 必须一起改 —— 它存在的意义就是「形状变了就让老缓存作废」，
 * 否则老缓存会把过期的字段名悄悄喂给新代码。
 */

const CACHE_VERSION = 2;

export interface CachedDetail {
  _v?: number;
  bvid: string;
  detail_ok: boolean;
  relation_ok: boolean;
  detail_error: string;
  relation_error?: string;
  title?: string;
  desc?: string;
  cover?: string;
  duration?: number | null;
  pubdate?: number | null;
  pubdate_str?: string;
  tname?: string;
  tags?: string[];
  up_name?: string;
  up_mid?: number | null;
  stat_view?: number | null;
  stat_like?: number | null;
  stat_coin?: number | null;
  stat_favorite?: number | null;
  stat_reply?: number | null;
  stat_danmaku?: number | null;
  stat_share?: number | null;
  me_liked?: boolean;
  me_favorited?: boolean;
  me_coined?: number;
  me_followed_up?: boolean;
  me_disliked?: boolean;
}

export function defaultCacheDir(): string {
  return process.env.BILI_CACHE_DIR ?? path.join(process.cwd(), ".cache/bili-detail");
}

export async function readCachedDetail(
  dir: string,
  bvid: string,
): Promise<CachedDetail | null> {
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, `${bvid}.json`), "utf8"));
    return parsed?._v === CACHE_VERSION ? (parsed as CachedDetail) : null;
  } catch {
    // 读不到 / 坏了 / 版本不对 —— 都当没缓存，重新抓。缓存坏了不该让整次抓取失败。
    return null;
  }
}

/**
 * 原子写：先写临时文件再 rename。
 *
 * 不原子的话，抓取中途被 Ctrl-C 打断会留下一个**半截的 JSON**，
 * 下次读它 `JSON.parse` 抛错 —— 而那正是「缓存坏了但不报错」的经典形态。
 */
export async function writeCachedDetail(
  dir: string,
  bvid: string,
  payload: CachedDetail,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.${bvid}.tmp`);
  await writeFile(tmp, JSON.stringify({ ...payload, _v: CACHE_VERSION }), "utf8");
  await rename(tmp, path.join(dir, `${bvid}.json`));
}

/** 只有互动接口成功且字段存在，才可断言已操作或未操作。 */
export function biliInteractionsOf(detail: CachedDetail | null): import("./types.js").BiliInteractions {
  return {
    biliLiked: detail?.relation_ok && typeof detail.me_liked === "boolean" ? detail.me_liked : null,
    biliCoins: detail?.relation_ok && Number.isInteger(detail.me_coined) && detail.me_coined! >= 0 && detail.me_coined! <= 2 ? detail.me_coined! : null,
    biliFavorited: detail?.relation_ok && typeof detail.me_favorited === "boolean" ? detail.me_favorited : null,
  };
}
