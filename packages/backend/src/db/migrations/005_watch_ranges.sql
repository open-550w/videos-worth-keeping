-- 005_watch_ranges —— 「观看的日期区间」：一条记录可以在不相连的几段时间里被看 / 读
--
-- 需求（2026-10-21）原话：
--   「加新字段 观看的日期区间list，比如我在 1017-1019 看了、后面又在 1021-1024 看了；
--     有的可能是第一季、第二季…；有的只是中间忙了。然后这个按周看，就改为 by 这个新字段了。」
--
-- 为什么是**独立子表**，不是 items 上的一列 JSON：
--   ① 周视图要按「区间和某一周有交集」筛选和聚合 —— 子表能建索引，JSON 列不能
--      （5.7 连表达式索引都没有，更别说在 JSON 数组上）
--   ② 和 item_urls / item_notes 一致：一对多就是子表，一张表一个 dao
--   ③ JSON 列在 5.7 不能有默认值，每次读写都要应用层兜底，反而更啰嗦
--
-- ⚠️ 为什么不顺手删掉 items.week_key（它确实不再被周视图用了）：
--   **这次迁移只做加法。** 理由是这条库是**共享**的 —— 主 checkout 上还跑着旧代码，
--   它 SELECT 列表里有 i.week_key；删列会让它当场 500。
--   而 week_key 的含义并没有变成假的：它是「**录入周**」（collected_on 的 ISO 周），
--   仍然是个真事实（回收站、详情页都在展示 collected_on）。
--   「观看周」的真源现在是下面这张表 —— 两者是**不同的事实**，不是同一件事的两种算法。
--   ⚠️ 所以：**想按周分组时不要用 items.week_key**，用 item_watch_ranges。
--   将来真要删，单独一个迁移、挑个两边代码都切过来的时候。
--
-- 5.7 约束（见 docs/init/02_DATA_MODEL.md §0）：无 CTE / 窗口函数、
-- 日期必须合法（sql_mode 有 STRICT_TRANS_TABLES + NO_ZERO_DATE）。

CREATE TABLE IF NOT EXISTS item_watch_ranges (
  id         BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  item_id    BIGINT UNSIGNED NOT NULL,
  started_on DATE            NOT NULL COMMENT '这一段从哪天开始看',
  ended_on   DATE            NOT NULL COMMENT '看到哪天（含）；单日 = 与 started_on 相同',
  created_at DATETIME        NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 周视图取「某个条目的区间」（相关子查询 / 批量取数）都走这个索引
  KEY idx_wr_item (item_id, started_on)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- 存量数据：每条已有记录补一个**单日区间** = 它的收藏日期。
--
-- 这一步不能省。周视图的真源从 collected_on 换成区间之后，
-- 没有区间的老记录会**从周视图里整体消失** —— 而它们本来是在的。
-- 补成「单日区间」之后，老数据在新周视图下的表现和以前**逐条一致**（出现在 collected_on 那一周）。
--
-- 软删的（deleted_at IS NOT NULL）也补 —— 回收站里恢复回来时要能回到它原来那一周。
-- WHERE NOT EXISTS 让它重跑安全（DDL 不是事务性的，跑一半失败要能重来，见 migrate.ts）。
INSERT INTO item_watch_ranges (item_id, started_on, ended_on)
SELECT i.id, i.collected_on, i.collected_on
FROM items i
WHERE NOT EXISTS (
  SELECT 1 FROM item_watch_ranges r WHERE r.item_id = i.id
);
