import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRecord, normDesc, parseTimeArg } from "./history.js";
import type { HistoryItem } from "./client.js";
import type { CachedDetail } from "./cache.js";

/**
 * 这些用例盯的是**从 Python 版搬过来的协议细节**，不是函数本身好不好看。
 *
 * 为什么值得单独测：这些规则都是从真实接口实测出来的（见 09_BILI_HISTORY.md §3），
 * 而它们的表现形式全是「**看起来正常但结论是错的**」——
 * 进度 -1 当成 0 会得出「点开就关了」、is_finish 恒 0 会得出「一条都没看完」。
 * 后人顺手「简化」一下，不会有任何报错，只会安静地给出错的答案。
 */

/** 造一条历史行。默认值取一个真实存在的形状（archive + 有 bvid）。 */
function item(over: Partial<HistoryItem> = {}, h: Partial<NonNullable<HistoryItem["history"]>> = {}): HistoryItem {
  return {
    title: "标题",
    cover: "http://i0.hdslb.com/x.jpg",
    uri: "",
    view_at: 1792588812,
    duration: 100,
    progress: 50,
    is_finish: 0,
    tag_name: "日常",
    author_name: "UP",
    history: { bvid: "BV1xx411c7mD", business: "archive", oid: 123, cid: 456, dt: 3, part: "P1", ...h },
    ...over,
  };
}

test("进度 -1 是「没上报」，不是 0 秒", () => {
  const r = buildRecord(item({ progress: -1 }), null);
  assert.equal(r.progressSec, null, "-1 必须变成 null");
  assert.notEqual(r.progressSec, 0, "**绝不能**当成 0 —— 那会得出「点开就关了」的错误结论");
  assert.equal(buildRecord(item({ progress: 0 }), null).progressSec, 0, "真正的 0 要保留");
  assert.equal(buildRecord(item({ progress: undefined }), null).progressSec, null);
});

test("看完没看完靠推导（is_finish 实测恒为 0，不能用）", () => {
  // 进度 ≥ 时长 × 95%
  assert.equal(buildRecord(item({ progress: 95, duration: 100 }), null).watchedToEnd, true);
  assert.equal(buildRecord(item({ progress: 94, duration: 100 }), null).watchedToEnd, false);
  assert.equal(buildRecord(item({ progress: 100, duration: 100 }), null).watchedToEnd, true);

  // 就算接口说 is_finish=1 也不信它 —— 这个字段实测恒为 0，用它等于「一条都没看完」
  assert.equal(buildRecord(item({ is_finish: 1, progress: 10, duration: 100 }), null).watchedToEnd, false,
    "is_finish 不参与判断");

  // 直播 / 专栏没有时长（duration = 0）→ 判断为假，不是「进度 0 >= 0 所以看完了」
  assert.equal(buildRecord(item({ duration: 0, progress: 0 }), null).watchedToEnd, false);
});

test("时长取**历史接口**的，不是详情接口的", () => {
  // 详情接口的 duration 更大 —— 如果实现成「详情优先」，这里就会变成 999
  const extra = { bvid: "BV1xx411c7mD", detail_ok: true, relation_ok: true, detail_error: "", duration: 999 } as CachedDetail;
  assert.equal(buildRecord(item({ duration: 100 }), extra).durationSec, 100,
    "换来源会让边界上的 watchedToEnd 翻转 —— 移植时不该顺手改");
});

test("没有时长的类型存 null，不存 0", () => {
  assert.equal(buildRecord(item({ duration: 0 }), null).durationSec, null);
  assert.equal(buildRecord(item({ duration: 148 }), null).durationSec, 148);
});

test("平台内 ID：archive 用 BV 号，其余类型带 business 前缀", () => {
  assert.equal(buildRecord(item(), null).platformItemId, "BV1xx411c7mD");
  // 直播 / 番剧 / 专栏没有 BV 号，oid 在不同 business 之间会撞号 → 必须带前缀。
  // 候选区的去重键靠它，留空 = 每次抓取都插一遍。
  for (const b of ["live", "pgc", "article", "cheese"]) {
    const r = buildRecord(item({}, { bvid: "", business: b, oid: 777 }), null);
    assert.equal(r.platformItemId, `${b}:777`);
  }
});

test("url：uri 缺了就自己拼（专栏的 uri 是空的）", () => {
  assert.equal(buildRecord(item({ uri: "https://www.bilibili.com/video/BV1" }), null).url,
    "https://www.bilibili.com/video/BV1");
  assert.equal(buildRecord(item({ uri: "" }), null).url, "https://www.bilibili.com/video/BV1xx411c7mD");
  assert.equal(buildRecord(item({ uri: "" }, { bvid: "", business: "article", oid: 53321350 }), null).url,
    "https://www.bilibili.com/read/cv53321350");
  assert.equal(buildRecord(item({ uri: "" }, { bvid: "", business: "live", oid: 1851409470 }), null).url,
    "https://live.bilibili.com/1851409470");
});

test("封面 http → https（不然前端页面会被按混合内容拦掉）", () => {
  assert.equal(buildRecord(item({ cover: "http://i0.hdslb.com/a.jpg" }), null).coverUrl,
    "https://i0.hdslb.com/a.jpg");
  assert.equal(buildRecord(item({ cover: "https://i0.hdslb.com/a.jpg" }), null).coverUrl,
    "https://i0.hdslb.com/a.jpg");
});

test("简介里的占位横杠归一成空", () => {
  // 归一化在**读接口那一步**（enrich）做，所以缓存里存的已经是干净的。
  // buildRecord 信任输入，不再归一化一遍 —— 这里测的是那个归一的规则本身。
  for (const placeholder of ["-", "--", "—", "  -  ", ""]) {
    assert.equal(normDesc(placeholder), "", `${JSON.stringify(placeholder)} 应当变成空`);
  }
  assert.equal(normDesc("真简介"), "真简介");
  assert.equal(normDesc(" 前后有空格 "), "前后有空格", "顺手 trim");
  assert.equal(normDesc(undefined), "");

  // 缓存里是空的 → buildRecord 给 null（而不是空串），前端显示时才好判断
  const extra = { bvid: "x", detail_ok: true, relation_ok: true, detail_error: "", desc: "" } as CachedDetail;
  assert.equal(buildRecord(item(), extra).summary, null);
  const extra2 = { bvid: "x", detail_ok: true, relation_ok: true, detail_error: "", desc: "真简介" } as CachedDetail;
  assert.equal(buildRecord(item(), extra2).summary, "真简介");
});

test("设备映射：未知的 dt 原样保留，不塞成「其他」", () => {
  assert.equal(buildRecord(item({}, { dt: 1 }), null).device, "安卓");
  assert.equal(buildRecord(item({}, { dt: 3 }), null).device, "PC/Web");
  assert.equal(buildRecord(item({}, { dt: 99 }), null).device, "未知(dt=99)",
    "硬塞成「其他」的话，以后新增客户端类型就再也发现不了了");
});

test("business → content_type", () => {
  assert.equal(buildRecord(item(), null).contentType, "video");
  assert.equal(buildRecord(item({}, { bvid: "", business: "article", oid: 1 }), null).contentType, "note");
  assert.equal(buildRecord(item({}, { bvid: "", business: "live", oid: 1 }), null).contentType, "video");
});

test("富化失败不影响这条记录本身（历史行自带标题/封面）", () => {
  const extra = { bvid: "x", detail_ok: false, relation_ok: false, detail_error: "62002: 稿件不可见" } as CachedDetail;
  const r = buildRecord(item({ title: "历史里的标题" }), extra);
  assert.equal(r.title, "历史里的标题", "详情拿不到就用历史里的");
  assert.equal(r.detailError, "62002: 稿件不可见", "失败原因要留着，不然排查不了");
  assert.ok(r.coverUrl, "封面也还在");
});

test("时间参数：认这些写法", () => {
  const d = parseTimeArg("2026-10-18")!;
  const dt = new Date(d * 1000);
  assert.equal(dt.getFullYear(), 2026);
  assert.equal(dt.getMonth(), 9);
  assert.equal(dt.getDate(), 18);
  assert.equal(dt.getHours(), 0, "只给日期 = 当天 00:00（本地时区）");

  const sec = parseTimeArg("2026-10-18 09:30:00")!;
  assert.equal(new Date(sec * 1000).getHours(), 9);
  assert.equal(new Date(sec * 1000).getMinutes(), 30);

  assert.equal(parseTimeArg("1792588812"), 1792588812, "epoch 秒原样认");
  assert.equal(parseTimeArg(undefined), undefined);

  // 相对时间：7d ≈ 现在往前 7 天（允许几秒误差）
  const rel = parseTimeArg("7d")!;
  assert.ok(Math.abs(Date.now() / 1000 - rel - 7 * 86400) < 5, "7d 应当是 7 天前");
  assert.ok(Math.abs(Date.now() / 1000 - parseTimeArg("12h")! - 12 * 3600) < 5);

  assert.throws(() => parseTimeArg("昨天"), /认不出/);
});

test("B站互动：保留未操作与投币数，接口失败/字段缺失必须未知", () => {
  const detail: CachedDetail = { bvid: "BVtest", detail_ok: true, relation_ok: true, detail_error: "",
    me_liked: false, me_coined: 2, me_favorited: true };
  const r = buildRecord(item(), detail);
  assert.equal(r.biliLiked, false);
  assert.equal(r.biliCoins, 2);
  assert.equal(r.biliFavorited, true);
  assert.equal(buildRecord(item(), { ...detail, me_coined: 0 }).biliCoins, 0);
  for (const extra of [null, { ...detail, relation_ok: false },
    { ...detail, me_liked: undefined, me_coined: undefined, me_favorited: undefined }]) {
    const unknown = buildRecord(item(), extra);
    assert.equal(unknown.biliLiked, null);
    assert.equal(unknown.biliCoins, null);
    assert.equal(unknown.biliFavorited, null);
  }
});
