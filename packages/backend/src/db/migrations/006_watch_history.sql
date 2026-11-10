-- 006_watch_history —— B 站观看历史抓回来之后的**候选区**
--
-- 需求（2026-10-21）：
--   「把 fetch.sh 的能力集合进来；结果可选直接保存到数据库（默认是保存进去的）；
--     后续设计 web 页面，方便选取其中一些添加到收藏。」
--
-- ⚠️ 为什么是「候选区」，不是直接写进 items：
--   抓回来的东西是「**我可能想收藏**的」，不是「我收藏的」。一条历史里大量是随手点开的
--   —— 实测 1315 条里进度≥95% 的只有 22 条。直接进 items 会把收藏册冲成一份观看流水，
--   而**「收藏」这个动作本身就是筛选**，它得由人来做。
--
--   所以分两步：抓取落到这张表（默认落，`--no-save` 可以不落），
--   人在 /history 上勾选，再由 services/history.service.ts 写进 items。
--
-- ⚠️ 为什么渠道中立（channel_code + business 两列，而不是叫 bili_*）：
--   仓库的既定立场是「渠道是数据不是枚举」（01_REQUIREMENTS.md §2.2），
--   知乎 / 小红书 / 微信读书都在计划里。多这两列的成本是 0，改名却是破坏性的。
--
-- 5.7 约束（见 02_DATA_MODEL.md §0）：JSON 列不能有默认值；
-- DATETIME 必须合法（sql_mode 有 STRICT_TRANS_TABLES + NO_ZERO_DATE）。

CREATE TABLE IF NOT EXISTS watch_history_entries (
  id               BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  channel_code     VARCHAR(32)  NOT NULL DEFAULT 'bilibili',
  business         VARCHAR(16)  NOT NULL DEFAULT 'archive'
                   COMMENT 'archive 视频 | live 直播 | pgc 番剧 | article 专栏 | cheese 课堂',
  -- 平台内的稳定 ID。B 站：archive 用 BV 号；其余类型没有 BV 号，用 `<business>:<oid>`
  -- （直播房间号 / 番剧 ep / 专栏 cv 号）。**必须非空** —— 下面的唯一键靠它去重，
  -- 而 MySQL 的唯一索引允许多个 NULL，留空就等于「同一条历史每次抓都插一遍」。
  platform_item_id VARCHAR(128) NOT NULL,
  -- 这次观看发生的时刻。存本地时间的 DATETIME（和 item_notes.noted_at 同一种），
  -- 不是 DATE —— 一天里看几十条，只到天的话同一条视频看两次就分不开了。
  watched_at       DATETIME     NOT NULL,
  url              VARCHAR(2048) NOT NULL DEFAULT '',
  title            VARCHAR(512) NOT NULL DEFAULT '',
  author           VARCHAR(255) NULL COMMENT 'UP 主 / 作者',
  cover_url        VARCHAR(1024) NULL,
  duration_sec     INT          NULL,
  summary          TEXT         NULL COMMENT '简介；B 站大量为空，那是内容本身如此',
  -- 播放位置（秒）。**NULL = 这个客户端没上报，不是 0** —— 约 30% 的记录是这样，
  -- 当成 0 会得出「点开就关了」的错误结论。
  progress_sec     INT          NULL,
  -- 看完了没：进度 ≥ 时长 × 95%，**抓取时算好存下来**。
  -- 为什么不留给页面自己算：这是挑选时最主要的信号（实测 1315 条里只有 22 条看完），
  -- 页面要按它排序 / 筛选；而且「95%」这条规则只该有一份。
  -- ⚠️ B 站自带的 is_finish 字段**实测恒为 0**，已经不能用了，这个值是推导出来的。
  watched_to_end   TINYINT(1)   NOT NULL DEFAULT 0,
  device           VARCHAR(32)  NULL COMMENT '安卓 / iPhone / PC/Web / TV…',
  -- UP 主自己挂的标签，逗号分隔。**仅供挑选时参考，不会写进 items** ——
  -- 那是别人的标签体系，和本站「我自己的标签组」不是一回事（见 02_DATA_MODEL.md §7）。
  tags             VARCHAR(512) NULL,
  published_on     DATE         NULL,
  content_type     VARCHAR(16)  NOT NULL DEFAULT 'video'
                   COMMENT '导入 items 时的内容类型；article → note，其余 → video',
  -- ⚠️ 这里**没有** imported_item_id / imported_at 之类的状态列，是刻意的。
  --
  -- 「这条候选有没有被收藏」是**派生**的：看 items 里有没有 (channel_code, platform_item_id)
  -- 这一行。存一份状态列的话，两处就会漂移 —— 用户把导入的条目删掉之后，
  -- 候选区会永远显示「已导入」，而它其实已经不在收藏里了。这种「不报错的错」最难查。
  --
  -- 副作用是好的：「已收藏」这个页签的含义变成了「这些内容现在在我的收藏里」，
  -- 比「我曾经点过导入」有用得多 —— 手动收藏的视频也会正确地出现在那里。
  --
  -- 所以状态只有两档，都是算出来的：
  --   · 待选   = items 里没有它 且 没被我归档
  --   · 已收藏 = items 里有它（`items.uk_items_platform` 那个唯一键保证最多一条）
  --   · 已归档 = archived_at IS NOT NULL（**只有这个是存下来的**，因为它是我的决定，
  --              没有别的地方能推出来）
  archived_at      DATETIME     NULL COMMENT '我把它归档了（确定不要）。不是删掉，留痕、可恢复',
  fetched_at       DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  -- 去重键：同一渠道、同一条内容、同一个观看时刻 = 同一次观看。
  -- 抓取窗口重叠是常态（今天抓 7 天、明天再抓 7 天），没有它候选区会被灌满重复行。
  -- 写入用 INSERT ... ON DUPLICATE KEY UPDATE，重复抓取是幂等的。
  UNIQUE KEY uk_whe_event (channel_code, platform_item_id, watched_at),
  KEY idx_whe_archived (archived_at),
  KEY idx_whe_watched  (watched_at),
  -- 筛选面板要按 UP 主列出选项（GROUP BY author）—— 有索引才能走 loose index scan，
  -- 不用把整表读一遍再排序
  KEY idx_whe_author   (author)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
