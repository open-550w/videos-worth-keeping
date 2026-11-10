import { looksLikeUrl } from "@likes/shared";
import { bilibiliResolver } from "./bilibili.js";
import { hongguoResolver } from "./hongguo.js";
import type { Resolved, Resolver } from "./types.js";

/**
 * 解析器注册表，**按顺序试，第一个 match 命中的负责到底**。
 *
 * 加新渠道 = 加一个文件 + 在这里注册一行。见 docs/init/06_RESOLVERS.md。
 */
export const RESOLVERS: Resolver[] = [
  bilibiliResolver,
  hongguoResolver,
  // 待办（M5）：zhihu / xhs —— 先实测可行性，别照着 B 站的样子猜
];

export function findResolver(url: string): Resolver | null {
  return RESOLVERS.find((r) => r.match(url)) ?? null;
}

export interface ResolveOutcome {
  /** 有没有识别出渠道 */
  matched: boolean;
  /** 抓到了什么（抓失败为 null） */
  resolved: Resolved | null;
  /** 命中的解析器 code（没命中为 null） */
  resolverCode: string | null;
  /** 没抓到时的原因，给前端提示用 */
  reason?: string;
}

/**
 * 解析一个 URL。**永远不抛** —— 录入流程依赖这个性质。
 *
 * 返回 `matched: false` 表示「这个 URL 我不认识」（比如知乎链接，M5 才做），
 * 前端据此降级为手动录入；`matched: true` 但 `resolved: null` 表示
 * 「认识这个渠道，但没抓到」——两种情况对用户是同一件事：手填。
 */
export async function resolveUrl(url: string): Promise<ResolveOutcome> {
  if (!looksLikeUrl(url)) {
    return { matched: false, resolved: null, resolverCode: null, reason: "不是一个 http(s) 链接" };
  }
  const resolver = findResolver(url);
  if (!resolver) {
    return { matched: false, resolved: null, resolverCode: null, reason: "暂不支持这个渠道" };
  }
  try {
    const resolved = await resolver.resolve(url);
    return {
      matched: true,
      resolved,
      resolverCode: resolver.code,
      reason: resolved ? undefined : "没抓到内容（链接失效、被限流，或平台改版了）",
    };
  } catch (err) {
    // 解析器内部已尽量收敛，这里再兜一层 —— 录入流程不能因为抓取挂掉
    console.warn(`[resolve] ${resolver.code} 抛异常:`, err);
    return {
      matched: true,
      resolved: null,
      resolverCode: resolver.code,
      reason: "抓取出错",
    };
  }
}

export type { Resolved, Resolver } from "./types.js";
