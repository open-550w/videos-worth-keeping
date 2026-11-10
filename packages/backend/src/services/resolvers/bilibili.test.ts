import { test } from "node:test";
import assert from "node:assert/strict";
import { bilibiliResolver } from "./bilibili.js";
import { findResolver, resolveUrl } from "./index.js";

test("B 站：网页链与 App 短链都认（需求确认会：两个都支持）", () => {
  assert.equal(bilibiliResolver.match("https://www.bilibili.com/video/BV1GJ411x7h7"), true);
  assert.equal(bilibiliResolver.match("https://bilibili.com/video/BV1GJ411x7h7/"), true);
  assert.equal(bilibiliResolver.match("https://m.bilibili.com/video/BV1GJ411x7h7"), true);
  assert.equal(bilibiliResolver.match("https://b23.tv/BV1GJ411x7h7"), true);
  // 带跟踪参数也要认
  assert.equal(
    bilibiliResolver.match("https://www.bilibili.com/video/BV1GJ411x7h7/?spm_id_from=333.999.0.0"),
    true,
  );
});

test("B 站：不认别的域名", () => {
  assert.equal(bilibiliResolver.match("https://hongguoduanju.com/detail?series_id=1"), false);
  assert.equal(bilibiliResolver.match("https://evil-bilibili.com/video/BV1GJ411x7h7"), false);
  assert.equal(bilibiliResolver.match("https://b23.tv.evil.com/x"), false);
  assert.equal(bilibiliResolver.match("随便一句话"), false);
});

test("注册表按顺序匹配，不认识的渠道返回 matched=false", async () => {
  assert.equal(findResolver("https://www.bilibili.com/video/BV1GJ411x7h7")?.code, "bilibili");
  assert.equal(findResolver("https://hongguoduanju.com/detail?series_id=1")?.code, "hongguo");
  // 知乎还没做（M5）—— 应该是「不认识」，不是「认识但抓不到」
  assert.equal(findResolver("https://www.zhihu.com/question/1/answer/2"), null);
});

test("⚠️ 坏输入不抛异常，只返回 matched=false（录入流程依赖这个性质）", async () => {
  for (const bad of ["", "   ", "不是链接", "javascript:alert(1)", "ftp://a.com/x"]) {
    const out = await resolveUrl(bad);
    assert.equal(out.matched, false, `输入 ${JSON.stringify(bad)}`);
    assert.equal(out.resolved, null);
    assert.ok(out.reason, "应该给出原因");
  }
});

test("不支持的渠道给出可读的原因，而不是抛", async () => {
  const out = await resolveUrl("https://www.zhihu.com/question/1/answer/2");
  assert.equal(out.matched, false);
  assert.equal(out.resolverCode, null);
  assert.match(out.reason ?? "", /不支持/);
});
