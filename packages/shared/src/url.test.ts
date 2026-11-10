import { test } from "node:test";
import assert from "node:assert/strict";
import { canonicalizeUrl, cleanUrlForDisplay, hostOf, looksLikeUrl } from "./url.js";

test("canonicalizeUrl 让同一内容的多种写法收敛成一个", () => {
  const variants = [
    "https://www.bilibili.com/video/BV1GJ411x7h7/",
    "https://www.bilibili.com/video/BV1GJ411x7h7",
    "http://bilibili.com/video/BV1GJ411x7h7",
    "https://WWW.BILIBILI.COM/video/BV1GJ411x7h7/",
    "https://www.bilibili.com/video/BV1GJ411x7h7?spm_id_from=333.999.0.0",
    "https://www.bilibili.com/video/BV1GJ411x7h7/?vd_source=abc123",
    "https://www.bilibili.com/video/BV1GJ411x7h7#reply123",
    "  https://www.bilibili.com/video/BV1GJ411x7h7  ",
  ];
  const canon = variants.map(canonicalizeUrl);
  assert.equal(new Set(canon).size, 1, `没有收敛:\n${canon.join("\n")}`);
});

test("⚠️ 不能把有意义的参数当跟踪参数丢掉", () => {
  // B 站的 ?p=2 是多 P 视频的第 2 P —— 那是内容的一部分，不是跟踪参数。
  // 丢了它，第 1 P 和第 2 P 会哈希成同一条，第二条永远存不进去，
  // 而且报的是「已收藏过」——一个看起来完全合理的提示，掩盖了真 bug。
  const p1 = canonicalizeUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=1");
  const p2 = canonicalizeUrl("https://www.bilibili.com/video/BV1xx411c7mD?p=2");
  assert.notEqual(p1, p2, "?p= 被误当成跟踪参数丢掉了");

  // 红果的 series_id 同理
  const s1 = canonicalizeUrl("https://hongguoduanju.com/detail?series_id=7670056634244156478");
  const s2 = canonicalizeUrl("https://hongguoduanju.com/detail?series_id=7671310601976564761");
  assert.notEqual(s1, s2);
});

test("query 参数顺序不影响哈希", () => {
  assert.equal(
    canonicalizeUrl("https://e.com/a?x=1&y=2"),
    canonicalizeUrl("https://e.com/a?y=2&x=1"),
  );
});

test("非 http(s) 与坏输入返回 null", () => {
  assert.equal(canonicalizeUrl(""), null);
  assert.equal(canonicalizeUrl("   "), null);
  assert.equal(canonicalizeUrl("不是链接"), null);
  assert.equal(canonicalizeUrl("ftp://e.com/a"), null);
  assert.equal(canonicalizeUrl("javascript:alert(1)"), null);
});

test("cleanUrlForDisplay 保守：不改坏能打开的链接", () => {
  // 保留 http（不强升 https —— 有些站只有 http，改了可能打不开）
  assert.equal(cleanUrlForDisplay("http://e.com/a"), "http://e.com/a");
  // 保留跟踪参数（能少动就少动）
  assert.equal(cleanUrlForDisplay("https://e.com/a?utm_source=x"), "https://e.com/a?utm_source=x");
  // host 小写、去 fragment、去空白
  assert.equal(cleanUrlForDisplay("  https://E.COM/a#frag  "), "https://e.com/a");
});

test("hostOf 去掉 www", () => {
  assert.equal(hostOf("https://www.bilibili.com/video/x"), "bilibili.com");
  assert.equal(hostOf("https://hongguoduanju.com/detail?series_id=1"), "hongguoduanju.com");
  assert.equal(hostOf("坏输入"), null);
});

test("looksLikeUrl", () => {
  assert.equal(looksLikeUrl("https://a.com"), true);
  assert.equal(looksLikeUrl("http://a.com"), true);
  assert.equal(looksLikeUrl("  https://a.com  "), true);
  assert.equal(looksLikeUrl("随便写的一句话"), false);
  assert.equal(looksLikeUrl("ftp://a.com"), false);
  assert.equal(looksLikeUrl(""), false);
});
