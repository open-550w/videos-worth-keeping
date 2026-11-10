import { test } from "node:test";
import assert from "node:assert/strict";
import { verdictOf } from "./probe.service.js";

/**
 * 判定的核心取舍：**「被拦住」不等于「死了」**。
 *
 * 很多站点对 HEAD 请求返回 403/405，对 GET 却正常；限流会返回 429。
 * 把这些当死链会制造**大量假警报**，而假警报比没有警报更糟 ——
 * 你会开始忽略它，于是真的死链也一起被忽略。
 */
test("2xx / 3xx 是活着", () => {
  assert.equal(verdictOf(200), "ok");
  assert.equal(verdictOf(204), "ok");
  assert.equal(verdictOf(301), "ok");
  assert.equal(verdictOf(302), "ok");
});

test("404 / 410 才算死链", () => {
  assert.equal(verdictOf(404), "dead");
  assert.equal(verdictOf(410), "dead");
});

test("⚠️ 403 / 405 / 429 是「被拦住」，不是「死了」", () => {
  // HEAD 被拒、限流、需要登录 —— 这些都可能是暂时或方法问题
  assert.equal(verdictOf(403), "blocked");
  assert.equal(verdictOf(405), "blocked");
  assert.equal(verdictOf(429), "blocked");
  assert.equal(verdictOf(401), "blocked");
  // 关键：它们不该被判成 dead，否则会淹掉真警报
  assert.notEqual(verdictOf(403), "dead");
  assert.notEqual(verdictOf(405), "dead");
});

test("5xx 是服务端问题（可能是暂时的）", () => {
  assert.equal(verdictOf(500), "server_error");
  assert.equal(verdictOf(502), "server_error");
  assert.equal(verdictOf(503), "server_error");
});

test("网络层失败（没有状态码）", () => {
  assert.equal(verdictOf(null), "network_error");
});

test("没有状态码落在「未分类」—— 每个分支都有归宿", () => {
  const seen = new Set(
    [200, 301, 401, 403, 404, 405, 410, 429, 500, 502, null].map((s) => verdictOf(s)),
  );
  assert.deepEqual(
    [...seen].sort(),
    ["blocked", "dead", "network_error", "ok", "server_error"],
  );
});
