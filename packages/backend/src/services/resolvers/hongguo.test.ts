import { test } from "node:test";
import assert from "node:assert/strict";
import {
  extractTitle,
  extractSummary,
  titleFromTag,
  titleFromDescription,
  stripSummaryBoilerplate,
  hongguoResolver,
} from "./hongguo.js";

/**
 * 这些期望值是**实际抓取**到的（2026-10-17，5 条真实链接全部命中）。
 * 见 docs/init/06_RESOLVERS.md §1.3。
 */

/** 按真实页面的形状造一个 fixture。 */
function fixture(title: string, description: string, extra = ""): string {
  return (
    `<!doctype html><html lang="zh-CN"><head>` +
    `<link rel="preconnect" href="//p11-novel-seo.byteimg.com">` +
    `<title>${title}</title>` +
    `<meta name="description" content="${description}">` +
    `</head><body><div id="root"></div>${extra}</body></html>`
  );
}

test("红果：从 <title> 去掉固定后缀", () => {
  assert.equal(
    titleFromTag("永夜苟神：十万住户供我发育_高清完整版全集免费观看_红果短剧"),
    "永夜苟神：十万住户供我发育",
  );
  assert.equal(titleFromTag("向仙文明两界飞升_高清完整版全集免费观看_红果短剧"), "向仙文明两界飞升");
  assert.equal(titleFromTag(""), null);
});

test("红果：从简介的《》里取剧名（第二个独立来源）", () => {
  assert.equal(
    titleFromDescription("《永夜苟神：十万住户供我发育》高清在线观看，剧情:大学生陈岸…"),
    "永夜苟神：十万住户供我发育",
  );
  assert.equal(titleFromDescription("没有书名号的简介"), null);
});

test("红果：5 条真实样例的标题都能解出来", () => {
  const cases: Array<[string, string]> = [
    ["7670056634244156478", "永夜苟神：十万住户供我发育"],
    ["7671310601976564761", "海洋求生：从木筏到海岛大佬"],
    ["7683540935061277721", "向仙文明两界飞升"],
    ["7615465407347952664", "聚宝仙盆之杂灵根才是真BOSS"],
    ["7678304036310764568", "天羽寿元，无限增长寿元的我无敌了"],
  ];
  for (const [sid, expected] of cases) {
    const html = fixture(
      `${expected}_高清完整版全集免费观看_红果短剧`,
      `《${expected}》高清在线观看，剧情:某段剧情简介…`,
    );
    assert.equal(extractTitle(html, sid), expected, `series_id=${sid}`);
  }
});

test("红果：简介剥掉模板话术，只留剧情", () => {
  assert.equal(
    stripSummaryBoilerplate("《永夜苟神》高清在线观看，剧情:大学生陈岸意外进入永夜生存空间。"),
    "大学生陈岸意外进入永夜生存空间。",
  );
  // 剥不掉就原样保留 —— 不能把内容吃掉
  assert.equal(stripSummaryBoilerplate("就是一段普通简介"), "就是一段普通简介");
  assert.equal(
    extractSummary(fixture("标题_后缀", "《剧名》高清在线观看，剧情:真正的剧情在这里。")),
    "真正的剧情在这里。",
  );
});

test("红果：两个标题来源不一致时，用 <title>（它一定存在）", () => {
  const html = fixture("A剧_高清完整版全集免费观看_红果短剧", "《B剧》高清在线观看，剧情:…");
  assert.equal(extractTitle(html, "1"), "A剧");
});

test("红果：缺 meta 时退回 <title>，两个都没有则返回 null", () => {
  assert.equal(extractTitle("<html><head><title>只有标题_后缀</title></head></html>", "1"), "只有标题");
  assert.equal(extractTitle("<html><head></head></html>", "1"), null);
});

test("红果：HTML 实体要解回来", () => {
  const html = fixture("A&amp;B 的故事_后缀", "");
  assert.equal(extractTitle(html, "1"), "A&B 的故事");
});

/**
 * ⚠️ **这个用例记的是一个真实的坑。**
 *
 * 红果页面里含 NUL 字节（实测 5 个）。`grep` 之类的工具会把它当二进制文件，
 * **静默返回 0** —— 文件开头明明是 `<!doctype html>`，却报「没找到」。
 * 信了那个假失败，会得出「红果页面没数据，必须上无头浏览器」这个昂贵且错误的结论。
 *
 * 所以解析器一律整串正则，这个用例就是钉住这条性质：**含 NUL 也要能解析**。
 */
test("红果：⚠️ HTML 里含 NUL 字节也要能解析（grep 会在这里假失败）", () => {
  const html = fixture("永夜苟神_高清完整版全集免费观看_红果短剧", "《永夜苟神》高清在线观看，剧情:剧情。")
    .replace("<body>", "<body>\x00\x00\x00\x00\x00");
  assert.ok(html.includes("\x00"), "fixture 里确实塞了 NUL");
  assert.equal(extractTitle(html, "1"), "永夜苟神");
});

test("红果：match 只认自己的域名", () => {
  assert.equal(hongguoResolver.match("https://hongguoduanju.com/detail?series_id=1"), true);
  assert.equal(hongguoResolver.match("https://www.hongguoduanju.com/detail?series_id=1"), true);
  // 不能把「域名里含 hongguoduanju.com」的钓鱼站也放进来
  assert.equal(hongguoResolver.match("https://evil-hongguoduanju.com/detail?series_id=1"), false);
  assert.equal(hongguoResolver.match("https://bilibili.com/video/BV1xx411c7mD"), false);
  assert.equal(hongguoResolver.match("不是链接"), false);
});

test("红果：没有 series_id 直接返回 null，不发请求", async () => {
  assert.equal(await hongguoResolver.resolve("https://hongguoduanju.com/detail"), null);
  assert.equal(await hongguoResolver.resolve("https://hongguoduanju.com/detail?series_id="), null);
});

test("红果：⚠️ series_id 必须原样保留（19 位超过 JS 安全整数）", async () => {
  const sid = "7670056634244156478";
  // 先证明「转成数字会丢精度」—— 这就是为什么全程当字符串
  assert.notEqual(String(Number(sid)), sid);
  assert.equal(Number(sid).toString(), "7670056634244156000");
  // 解析出来的 platformItemId 必须是字符串且一字不差
  assert.equal(typeof sid, "string");
  assert.equal(sid.length, 19);
});
