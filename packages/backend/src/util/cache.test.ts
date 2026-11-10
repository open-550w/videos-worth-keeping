import { test } from "node:test";
import assert from "node:assert/strict";
import { cached, invalidateAll, cacheStats, cacheKey } from "./cache.js";

/** 每次用例前把缓存清空，并重置环境变量到默认。 */
function reset() {
  invalidateAll();
  delete process.env.CACHE_ENABLED;
  delete process.env.CACHE_TTL_MS;
  delete process.env.CACHE_MAX_ENTRIES;
}

/** 记一次调用，用来数 load() 真的跑了几次。 */
function counter<T>(value: T) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    load: async () => {
      calls++;
      return value;
    },
  };
}

test("默认开启：第二次不再调 load", async () => {
  reset();
  const c = counter({ v: 1 });
  const a = await cached("k1", c.load);
  const b = await cached("k1", c.load);
  assert.deepEqual(a, { v: 1 });
  assert.deepEqual(b, { v: 1 });
  assert.equal(c.calls, 1, "load 应该只跑一次");
});

test("不同 key 不互相干扰", async () => {
  reset();
  const c1 = counter("a");
  const c2 = counter("b");
  assert.equal(await cached("x", c1.load), "a");
  assert.equal(await cached("y", c2.load), "b");
  assert.equal(await cached("x", c1.load), "a");
  assert.equal(c1.calls, 1);
  assert.equal(c2.calls, 1);
});

test("⚠️ CACHE_ENABLED=0 时完全透传：不缓存、不计数", async () => {
  reset();
  process.env.CACHE_ENABLED = "0";
  const c = counter("v");

  const before = cacheStats();
  assert.equal(await cached("k", c.load), "v");
  assert.equal(await cached("k", c.load), "v");
  assert.equal(await cached("k", c.load), "v");

  assert.equal(c.calls, 3, "关掉缓存后每次都要真的去取");
  const after = cacheStats();
  assert.equal(after.enabled, false);
  assert.equal(after.entries, 0, "关掉时不该往 Map 里存东西");
  // 关键：关掉时不计数。否则命中率统计会被稀释成没法看
  assert.equal(after.hits, before.hits, "关掉时不该记命中");
  assert.equal(after.misses, before.misses, "关掉时不该记未命中");
});

test("CACHE_ENABLED 只认 \"0\" 是关，其他都算开", async () => {
  reset();
  for (const v of ["1", "true", "yes", ""]) {
    reset();
    process.env.CACHE_ENABLED = v;
    assert.equal(cacheStats().enabled, true, `CACHE_ENABLED=${JSON.stringify(v)} 应该算开`);
  }
  reset();
  process.env.CACHE_ENABLED = "0";
  assert.equal(cacheStats().enabled, false);
});

test("TTL 到期后重新取", async () => {
  reset();
  const c = counter("v");
  // TTL 给 0：expires = now，下一次读必然过期
  process.env.CACHE_TTL_MS = "0";
  await cached("k", c.load);
  await cached("k", c.load);
  assert.equal(c.calls, 2, "TTL=0 应该每次都重新取");
});

test("invalidateAll 清空缓存（写操作走的就是这条路）", async () => {
  reset();
  const c = counter("v");
  await cached("k", c.load);
  assert.equal(c.calls, 1);

  invalidateAll();
  assert.equal(cacheStats().entries, 0);

  await cached("k", c.load);
  assert.equal(c.calls, 2, "清空后应该重新取");
});

test("超过 CACHE_MAX_ENTRIES 时整体清空，不无限涨", async () => {
  reset();
  process.env.CACHE_MAX_ENTRIES = "3";
  for (let i = 0; i < 10; i++) {
    await cached(`k${i}`, async () => i);
  }
  assert.ok(cacheStats().entries <= 3, `entries 应该被压住，实际 ${cacheStats().entries}`);
});

test("load 抛异常时不写缓存（否则会把失败永久钉住）", async () => {
  reset();
  let calls = 0;
  const boom = async () => {
    calls++;
    throw new Error("boom");
  };
  await assert.rejects(() => cached("bad", boom));
  assert.equal(cacheStats().entries, 0, "失败不该留下缓存条目");
  await assert.rejects(() => cached("bad", boom));
  assert.equal(calls, 2, "失败后下次应该重试，而不是命中一个空值");
});

test("stats 暴露当前生效的配置 —— 不然没法确认 env 改没改对", () => {
  reset();
  process.env.CACHE_TTL_MS = "12345";
  process.env.CACHE_MAX_ENTRIES = "77";
  const s = cacheStats();
  assert.equal(s.ttlMs, 12345);
  assert.equal(s.maxEntries, 77);
  assert.equal(s.enabled, true);
});

test("cacheKey 对参数顺序不敏感，且能区分不同参数", () => {
  assert.equal(cacheKey({ a: 1, b: 2 }), cacheKey({ b: 2, a: 1 }));
  assert.notEqual(cacheKey({ a: 1 }), cacheKey({ a: 2 }));
  assert.notEqual(cacheKey({ a: 1 }), cacheKey({ a: 1, b: undefined }));
  // undefined / null 要编成同一个东西，否则同一份数据会有两个 key
  assert.equal(cacheKey({ a: undefined }), cacheKey({ a: null }));
  // 数组要能区分
  assert.notEqual(cacheKey({ tagIds: [1, 2] }), cacheKey({ tagIds: [2, 1] }));
});
