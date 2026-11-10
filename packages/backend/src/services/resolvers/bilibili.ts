import { hostOf } from "@likes/shared";
import { safeFetch, type Resolved, type Resolver } from "./types.js";

const BV_RE = /\/(BV[0-9A-Za-z]{10})/;
const SHORT_HOSTS = new Set(["b23.tv"]);

interface ViewApi {
  code: number;
  message: string;
  data?: {
    bvid: string;
    title: string;
    desc?: string;
    pic?: string;
    pubdate?: number;
    duration?: number;
    owner?: { name?: string };
  };
}

/**
 * 跟随短链拿最终 URL。
 *
 * App 分享出来的是 `b23.tv/xxxx`，网页上复制的是 `bilibili.com/video/BV…`。
 * 需求确认会：「管我用什么，解析器两个都支持吧」——
 * 所以统一走「先解析到最终 URL，再取 BV 号」，两种形态就都覆盖了。
 */
async function resolveShortLink(url: string): Promise<string | null> {
  const res = await safeFetch(url, { redirect: "follow" });
  if (!res?.ok) return null;
  return res.url || null;
}

export const bilibiliResolver: Resolver = {
  code: "bilibili",

  match(url) {
    const h = hostOf(url);
    if (!h) return false;
    return h === "bilibili.com" || h.endsWith(".bilibili.com") || SHORT_HOSTS.has(h);
  },

  async resolve(url): Promise<Resolved | null> {
    let bvid: string | null = null;
    const host = hostOf(url);

    if (host && SHORT_HOSTS.has(host)) {
      // 短链：先跟随重定向
      const finalUrl = await resolveShortLink(url);
      bvid = finalUrl ? (BV_RE.exec(finalUrl)?.[1] ?? null) : null;
      // 跳转拿不到就退回直接打接口（b23.tv/xxxx 里的 xxxx 有时就是 BV 号）
      if (!bvid) bvid = BV_RE.exec(url)?.[1] ?? null;
    } else {
      bvid = BV_RE.exec(url)?.[1] ?? null;
    }
    if (!bvid) return null;

    const res = await safeFetch(
      `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`,
    );
    if (!res?.ok) return null;

    const json = (await res.json().catch(() => null)) as ViewApi | null;
    // code 必须判：-404 之类表示视频不存在/已删，要能降级为手动填
    if (!json || json.code !== 0 || !json.data) return null;

    const d = json.data;
    // 简介字段叫 desc；很多视频里是占位符 "-"，那种等于没有
    const desc = (d.desc ?? "").trim();
    const summary = desc && desc !== "-" ? desc : undefined;

    return {
      channelCode: "bilibili",
      platformItemId: d.bvid || bvid,
      title: d.title || undefined,
      author: d.owner?.name || undefined,
      // 接口返回的是 http:// —— 存 https，免得页面混合内容告警
      coverUrl: d.pic ? d.pic.replace(/^http:\/\//, "https://") : undefined,
      summary,
      durationSec: typeof d.duration === "number" ? d.duration : undefined,
      publishedOn: d.pubdate ? new Date(d.pubdate * 1000).toISOString().slice(0, 10) : undefined,
    };
  },
};
