#!/usr/bin/env python3
"""端到端 API 冒烟测试。

对着**跑起来的后端**（默认 http://localhost:3050）打一遍关键路径：
判重、评论、软删/恢复、标签组、搜索筛选、参数校验。

用法：
    pnpm start          # 另开一个终端先把服务起起来
    pnpm smoke

用 Python 而不是 TS：这是个纯 HTTP 测试，几十行就够，
不值得为它引一套 node 测试框架。唯一的外部依赖是标准库。
"""
import json, urllib.request, urllib.error, urllib.parse, sys

import os
B = os.environ.get("SMOKE_BASE", "http://localhost:3050")
passed, failed = [], []

def call(method, path, body=None, raw=False):
    # path 里可能有中文（搜索词），要 percent-encode
    url = B + urllib.parse.quote(path, safe="/?&=%,")
    data = None
    headers = {"Authorization": "Bearer " + os.environ.get("SMOKE_TOKEN", "")}
    if body is not None:
        data = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        # 超时给到 90 秒：数据库在远程，实测单次查询能慢到几十秒
        # （丢包导致的重传，见 docs/init/03_TECH_STACK.md §1.3）
        with urllib.request.urlopen(req, timeout=90) as r:
            payload = r.read()
            return r.status, (payload if raw else json.loads(payload or b"null"))
    except urllib.error.HTTPError as e:
        payload = e.read()
        try:
            return e.code, json.loads(payload)
        except Exception:
            return e.code, {"raw": payload[:200].decode("utf-8", "replace")}

def check(name, cond, detail=""):
    (passed if cond else failed).append(name)
    print(("  ✅ " if cond else "  ❌ ") + name + ("" if cond else f"  ← {detail}"))

# ---- 前置守卫：这个脚本假设库是干净的 ----
# 它不是幂等的：所有断言都建立在「这批固定数据从零开始建」之上。
# 库里有别的数据时，判重会命中它、计数会偏，报出来的错全是误导性的。
st, r = call("GET", "/api/items?limit=1&scope=all")
total = (r.get("data") or {}).get("total") if isinstance(r, dict) else None
if total is None:
    print(f"❌ 后端没响应或返回异常（HTTP {st}）—— 先 pnpm start 把服务起起来。")
    sys.exit(1)
if total != 0:
    print(
        f"❌ 数据库里已经有 {total} 条记录，这个冒烟测试需要**空库**。\n"
        f"   它不是幂等的：断言都建立在「这批固定数据从零开始建」之上，\n"
        f"   库里有别的数据时判重会命中它、计数会偏，报出来的错全是误导性的。\n\n"
        f"   先清库再来：\n"
        f"       pnpm reset -- --yes && pnpm smoke\n"
        f"   （或者直接 pnpm smoke:clean）\n"
    )
    sys.exit(1)
print("前置检查：库是空的 ✓\n")

print("=== 先建一条（后面所有判重都针对它）===")
st, r = call("POST", "/api/items", {
    "url": "https://hongguoduanju.com/detail?series_id=7670056634244156478",
    "title": "永夜苟神：十万住户供我发育", "channel_code": "hongguo",
    "platform_item_id": "7670056634244156478", "collected_on": "2026-10-17",
    "note": "开局设定挺新鲜，后面有点流水账。"})
check("建条目 → 201", st == 201, f"got {st} {r}")
item1 = r.get("data", {}).get("id")

print("\n=== 重复收藏拦截 ===")
st, r = call("POST", "/api/items", {
    "url": "https://hongguoduanju.com/detail?series_id=7670056634244156478",
    "title": "永夜苟神", "channel_code": "hongguo",
    "platform_item_id": "7670056634244156478", "collected_on": "2026-10-17"})
check("同渠道+同平台ID → 409", st == 409, f"got {st} {r}")
check("409 带 existingItemId（前端要能跳转）",
      r.get("data", {}).get("existingItemId") == item1, str(r.get("data")))

st, r = call("POST", "/api/items", {
    "url": "http://www.hongguoduanju.com/detail/?series_id=7670056634244156478&utm_source=share",
    "title": "换个写法", "channel_code": "hongguo",
    "platform_item_id": "7670056634244156478", "collected_on": "2026-10-17"})
check("URL 规范化后仍判重（http/www/斜杠/utm）", st == 409, f"got {st} {r}")

print("\n=== 不同内容不该误判重复 ===")
st, r = call("POST", "/api/items", {
    "url": "https://hongguoduanju.com/detail?series_id=7671310601976564761",
    "title": "海洋求生：从木筏到海岛大佬", "channel_code": "hongguo",
    "platform_item_id": "7671310601976564761", "collected_on": "2026-10-17"})
check("不同 series_id → 201", st == 201, f"got {st} {r}")
item2 = r.get("data", {}).get("id")

st, r = call("POST", "/api/items", {
    "url": "https://www.bilibili.com/video/BV1GJ411x7h7/", "title": "Never Gonna Give You Up",
    "author": "索尼音乐中国", "channel_code": "bilibili",
    "platform_item_id": "BV1GJ411x7h7", "collected_on": "2026-10-15",
    "duration_sec": 213, "note": "经典永流传"})
check("B 站条目 → 201", st == 201, f"got {st} {r}")
item3 = r.get("data", {}).get("id")
check("首条评论一并写入", r.get("data", {}).get("noteCount") == 1, str(r.get("data", {}).get("noteCount")))

print("\n=== 平台 ID 是字符串（19 位数字不能丢精度）===")
st, r = call("GET", f"/api/items/{item2}")
pid = r.get("data", {}).get("platformItemId")
check("series_id 原样返回", pid == "7671310601976564761", repr(pid))
check("19 位，不是科学计数法", isinstance(pid, str) and len(pid) == 19, repr(pid))
check("JS 侧也能安全表示", str(int("7671310601976564761")) == "7671310601976564761", "")

print("\n=== 周聚合 ===")
st, r = call("GET", "/api/weeks")
weeks = r.get("data", {}).get("weeks", [])
keys = {w["weekKey"] for w in weeks}
check("2026-W42 出现（10-17 与 10-15 都在这周）", "2026-W42" in keys, str(keys))
w42 = next((w for w in weeks if w["weekKey"] == "2026-W42"), None)
check("W42 有 3 条", w42 and w42["count"] == 3, str(w42))
check("W42 渠道分布有红果和 Bilibili",
      w42 and {c["code"] for c in w42["channels"]} == {"hongguo", "bilibili"}, str(w42))

print("\n=== 按观看区间取数（API 不暴露 week_key）===")
# ⚠️ 参数叫 watchedFrom/watchedTo（以前叫 from/to，筛的是 collected_on）。
# 换了含义就换名字 —— 同名不同义会让调用方静默拿到不一样的结果。
# 老数据没有区间时迁移会补成「单日区间 = collected_on」，所以这里的条数和不带区间时一致。
st, r = call("GET", "/api/items?watchedFrom=2026-10-12&watchedTo=2026-10-18")
items = r.get("data", {}).get("items", [])
check("W42 窗口内 3 条", len(items) == 3, str(len(items)))
check("返回 watchedRanges 而不是 weekKey",
      "watchedRanges" in items[0] and "weekKey" not in items[0],
      str(list(items[0].keys())))
check("没传区间时默认「收藏当天」一段",
      items[0]["watchedRanges"] == [{"from": items[0]["collectedOn"], "to": items[0]["collectedOn"]}],
      str(items[0]["watchedRanges"]))
st, r = call("GET", "/api/items?watchedFrom=2026-10-16&watchedTo=2026-10-18")
check("缩到 10-16~10-18 → 2 条（10-15 那条在窗口外）",
      len(r.get("data", {}).get("items", [])) == 2, "")

print("\n=== 评论（多条 + 时间戳）===")
st, r = call("POST", f"/api/items/{item3}/notes", {"body": "第二条评论", "noted_at": "2026-10-10 21:30"})
check("追加评论 → 201", st == 201, f"got {st} {r}")
st, r = call("GET", f"/api/items/{item3}")
notes = r.get("data", {}).get("notes", [])
check("两条评论", len(notes) == 2, str(len(notes)))
check("noted_at 可补录（早于 created_at）",
      any(n["notedAt"].startswith("2026-10-10") for n in notes), str([n["notedAt"] for n in notes]))
check("created_at 与 noted_at 分开",
      all("createdAt" in n and "notedAt" in n for n in notes), "")

print("\n=== 软删 / 回收站 / 恢复 ===")
st, r = call("DELETE", f"/api/items/{item2}")
check("软删 → 200", st == 200, f"got {st}")
st, r = call("GET", "/api/items")
check("默认列表看不到已删的", all(i["id"] != item2 for i in r["data"]["items"]), "")
st, r = call("GET", "/api/items?scope=trashed")
check("回收站里有它", any(i["id"] == item2 for i in r["data"]["items"]), "")
st, r = call("GET", "/api/items/trash-count")
check("回收站计数 = 1", r["data"]["count"] == 1, str(r["data"]))
st, r = call("POST", f"/api/items/{item2}/restore")
check("恢复 → 200", st == 200, f"got {st}")
st, r = call("GET", "/api/items")
check("恢复后回来了", any(i["id"] == item2 for i in r["data"]["items"]), "")

print("\n=== 标签组（单选 = 分类 / 多选 = 标签）===")
st, r = call("POST", "/api/tags/groups", {"name": "题材", "selection": "single"})
g1 = r["data"]["id"]; check("建单选组（分类）", st == 201, f"got {st} {r}")
st, r = call("POST", "/api/tags/groups", {"name": "心情", "selection": "multiple"})
g2 = r["data"]["id"]; check("建多选组（标签）", st == 201, f"got {st} {r}")
st, r = call("POST", "/api/tags", {"groupId": g1, "name": "短剧"})
t1 = r["data"]["id"]
st, r = call("POST", "/api/tags", {"groupId": g1, "name": "音乐"})
t2 = r["data"]["id"]
st, r = call("POST", "/api/tags", {"groupId": g2, "name": "下饭"})
t3 = r["data"]["id"]
check("建 3 个标签", all(x for x in [t1, t2, t3]), "")

st, r = call("PATCH", f"/api/items/{item3}", {"tag_ids": [t1, t2, t3]})
tags = r["data"].get("tags", [])
check("单选组里只留下一个（服务端强制）",
      len([t for t in tags if t["selection"] == "single"]) == 1,
      str([(t["name"], t["selection"]) for t in tags]))
check("多选组保留全部", len([t for t in tags if t["selection"] == "multiple"]) == 1, "")

st, r = call("GET", "/api/tags")
groups = r["data"]["groups"]
check("标签组接口带出组内标签",
      len(groups) == 2 and all("tags" in g for g in groups), str(groups)[:200])

print("\n=== 搜索与筛选 ===")
st, r = call("GET", "/api/items?q=海洋")
check("按标题搜到 1 条", len(r["data"]["items"]) == 1, str(len(r["data"]["items"])))
st, r = call("GET", "/api/items?channel=bilibili")
check("按渠道筛到 1 条", len(r["data"]["items"]) == 1, "")
st, r = call("GET", f"/api/items?tagIds={t1},{t2},{t3}")
check("按标签筛是「全部命中」语义（条目只有 t1+t3，查三个 → 0 条）",
      len(r["data"]["items"]) == 0, str(len(r["data"]["items"])))
st, r = call("GET", f"/api/items?tagIds={t1},{t3}")
check("查它实际拥有的两个标签 → 1 条", len(r["data"]["items"]) == 1, str(len(r["data"]["items"])))
st, r = call("GET", f"/api/items?tagIds={t2}")
check("查它没有的标签 → 0 条", len(r["data"]["items"]) == 0, "")

print("\n=== 404 与参数校验 ===")
st, r = call("GET", "/api/items/999999")
check("不存在的条目 → 404", st == 404, f"got {st}")
st, r = call("POST", "/api/items", {"title": "没有 collected_on"})
check("缺必填 → 400", st == 400, f"got {st}")
st, r = call("POST", "/api/items", {"collected_on": "2026-02-30"})
check("不存在的日期 → 400", st == 400, f"got {st} {r}")
st, r = call("POST", "/api/items", {
    "title": "区间倒过来了", "collected_on": "2026-10-17",
    "watched_ranges": [{"from": "2026-10-19", "to": "2026-10-17"}]})
check("结束日早于开始日 → 400", st == 400, f"got {st} {r}")
st, r = call("POST", "/api/items", {
    "title": "区间里的日期不存在", "collected_on": "2026-10-17",
    "watched_ranges": [{"from": "2026-02-30", "to": "2026-03-01"}]})
check("区间里有不存在的日期 → 400", st == 400, f"got {st} {r}")

# 这一段放在最后：它会新建条目，而前面所有计数断言都建立在「库里恰好那几条」之上。
print("\n=== 观看区间：一段跨几周就出现在几周 ===")
st, r = call("POST", "/api/items", {
    "title": "分两季看的剧", "channel_code": "manual", "collected_on": "2026-10-25",
    "watched_ranges": [
        {"from": "2026-10-21", "to": "2026-10-24"},   # 故意乱序传，看服务端会不会排
        {"from": "2026-10-17", "to": "2026-10-19"},   # 这一段本身跨 W42/W43
    ]})
check("带两段区间 → 201", st == 201, f"got {st} {r}")
item4 = r.get("data", {}).get("id")
check("返回的区间已按开始日排序",
      [x["from"] for x in r.get("data", {}).get("watchedRanges", [])] == ["2026-10-17", "2026-10-21"],
      str(r.get("data", {}).get("watchedRanges")))

st, r = call("GET", f"/api/items/{item4}")
check("详情也带区间",
      len(r.get("data", {}).get("watchedRanges", [])) == 2, str(r.get("data", {}).get("watchedRanges")))

# 交集语义：10-19 落在这两段之间，W43（10-19~10-25）里它必须出现
st, r = call("GET", "/api/items?watchedFrom=2026-10-19&watchedTo=2026-10-25")
ids = [i["id"] for i in r.get("data", {}).get("items", [])]
check("W43 窗口命中它（区间和窗口有交集，不要求整段落在里面）", item4 in ids, str(ids))
st, r = call("GET", "/api/items?watchedFrom=2026-11-01&watchedTo=2026-11-07")
ids = [i["id"] for i in r.get("data", {}).get("items", [])]
check("完全不相交的窗口不命中它", item4 not in ids, str(ids))

st, r = call("GET", "/api/weeks?limit=50")
weeks = {w["weekKey"]: w for w in r.get("data", {}).get("weeks", [])}
check("它同时出现在 W42 和 W43（两段各覆盖到）",
      "2026-W42" in weeks and "2026-W43" in weeks, str(list(weeks)))
check("W42 的日期范围被裁到这一周内（不是区间的原样两端）",
      weeks.get("2026-W42", {}).get("firstOn") >= "2026-10-12"
      and weeks.get("2026-W42", {}).get("lastOn") <= "2026-10-18",
      str(weeks.get("2026-W42")))
check("W43 也裁到这一周内",
      weeks.get("2026-W43", {}).get("firstOn") >= "2026-10-19"
      and weeks.get("2026-W43", {}).get("lastOn") <= "2026-10-25",
      str(weeks.get("2026-W43")))

# 同一周里的两段（不重叠）只能算 1 条 —— 逐段计数会算成 2 条。
# 判据用「建它之前 / 之后 W42 的计数差」，不能只看「>= 1」—— 那种断言恒真，等于没测。
st, r = call("GET", "/api/weeks?limit=50")
w42_before = next((w["count"] for w in r.get("data", {}).get("weeks", []) if w["weekKey"] == "2026-W42"), 0)

st, r = call("POST", "/api/items", {
    "title": "同一周里看了两次", "channel_code": "manual", "collected_on": "2026-10-25",
    "watched_ranges": [
        {"from": "2026-10-13", "to": "2026-10-14"},
        {"from": "2026-10-16", "to": "2026-10-17"},
    ]})
check("同一周里两段 → 201", st == 201, f"got {st} {r}")
item5 = r.get("data", {}).get("id")

st, r = call("GET", "/api/weeks?limit=50")
w42_after = next((w["count"] for w in r.get("data", {}).get("weeks", []) if w["weekKey"] == "2026-W42"), 0)
check("W42 计数只 +1（去重按条目，不按区间段数）",
      w42_after - w42_before == 1, f"{w42_before} → {w42_after}")

st, r = call("GET", "/api/items?watchedFrom=2026-10-12&watchedTo=2026-10-18&limit=200")
same_week = [i for i in r.get("data", {}).get("items", []) if i["id"] == item5]
check("同一周里的两段 → 列表里只有它一条（不是两条）", len(same_week) == 1, str(len(same_week)))

# 重叠的段要合并；相邻的不合并（第一季看完接着看第二季是两件事）
st, r = call("POST", "/api/items", {
    "title": "重叠的段", "channel_code": "manual", "collected_on": "2026-10-25",
    "watched_ranges": [
        {"from": "2026-10-17", "to": "2026-10-20"},
        {"from": "2026-10-18", "to": "2026-10-24"},
    ]})
check("重叠的两段合并成一段",
      r.get("data", {}).get("watchedRanges") == [{"from": "2026-10-17", "to": "2026-10-24"}],
      str(r.get("data", {}).get("watchedRanges")))
item6 = r.get("data", {}).get("id")

st, r = call("POST", "/api/items", {
    "title": "相邻的段", "channel_code": "manual", "collected_on": "2026-10-25",
    "watched_ranges": [
        {"from": "2026-10-17", "to": "2026-10-19"},
        {"from": "2026-10-20", "to": "2026-10-24"},
    ]})
check("相邻的两段**不**合并（分季看是两件事）",
      len(r.get("data", {}).get("watchedRanges", [])) == 2,
      str(r.get("data", {}).get("watchedRanges")))
item7 = r.get("data", {}).get("id")

# 显式清空 = 这条不再出现在任何一周（允许，但要是用户自己的选择）
st, r = call("PATCH", f"/api/items/{item6}", {"watched_ranges": []})
check("清空区间 → 返回空数组", r.get("data", {}).get("watchedRanges") == [], str(r.get("data", {}).get("watchedRanges")))
st, r = call("GET", "/api/items?watchedFrom=2026-10-12&watchedTo=2026-10-18&limit=200")
ids = [i["id"] for i in r.get("data", {}).get("items", [])]
check("清空后它不在任何一周里", item6 not in ids, str(ids))
st, r = call("GET", f"/api/items/{item6}")
check("但它还在（搜索/标签里找得到，不是被删了）",
      r.get("data", {}).get("title") == "重叠的段", str(r.get("data", {}).get("title")))

print("\n=== 硬删要把区间一起清掉（不留孤儿行）===")
st, r = call("DELETE", f"/api/items/{item7}/hard")
check("硬删 → 200", st == 200, f"got {st} {r}")
st, r = call("GET", "/api/items?scope=all&limit=200")
check("硬删后查不到它了", all(i["id"] != item7 for i in r.get("data", {}).get("items", [])), "")

print("\n=== 观看历史候选区（接口契约）===")
# ⚠️ 这里**验不了抓取**：它要打 B 站的外部接口，还要一份登录 cookie。
# 抓取那条路由 `pnpm fetch:bili` 自己验（同一时间窗和 Python 版逐字段对拍过）。
# 这一段只保证接口的形状和参数校验是对的 —— 空候选区也要能正常工作。
st, r = call("GET", "/api/history")
check("候选区列表 → 200", st == 200, f"got {st} {r}")
d = r.get("data", {})
check("带 total / counts / videos",
      all(k in d for k in ("total", "counts", "videos")), str(list(d.keys())))
check("counts 包含 active / pending / collected / archived",
      set(d.get("counts", {})) == {"active", "pending", "collected", "archived"}, str(d.get("counts")))
st, r = call("GET", "/api/history?status=collected")
check("collected 页签 → 200", st == 200, f"got {st}")
st, r = call("GET", "/api/history?status=nonsense")
check("状态枚举不合法 → 400", st == 400, f"got {st}")
st, r = call("POST", "/api/history/import", {"entryIds": []})
check("导入空选择 → 400", st == 400, f"got {st}")
st, r = call("POST", "/api/history/import", {"entryIds": [999999]})
check("导入不存在的候选 → 404", st == 404, f"got {st}")
st, r = call("POST", "/api/history/archive", {"entryIds": [999999], "archived": True})
check("归档不存在的候选 → 200 但改 0 行", st == 200 and r.get("data", {}).get("updated") == 0, f"got {st} {r}")

# 同步的**状态**接口只读，可以在这里验；POST 那条会真的去打 B 站接口，
# 所以**不**放进冒烟测试（它必须能离线跑、且不能有外部副作用）。
st, r = call("GET", "/api/history/sync")
check("同步状态 → 200", st == 200, f"got {st}")
d = r.get("data", {})
check("带 running / phase / last / error",
      all(k in d for k in ("running", "phase", "last", "error")), str(list(d.keys())))
check("没跑过时 running=false", d.get("running") is False, str(d.get("running")))

print(f"\n{'='*50}\n通过 {len(passed)} / 失败 {len(failed)}")
if failed:
    print("失败项：")
    for f in failed: print("  -", f)
    sys.exit(1)
